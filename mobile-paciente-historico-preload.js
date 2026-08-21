import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let n = digits(value);
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  return n.slice(-11);
}

function normalizeCpf(value) {
  return digits(value).slice(0, 11);
}

function authPaciente(req, res, next) {
  try {
    const raw = String(req.headers.authorization || '');
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ ok: false, error: 'Token não fornecido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '');
    if (decoded?.tipo !== 'paciente' || !decoded?.id) {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }
    req.pacienteId = Number(decoded.id);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
}

async function pacienteAtual(id) {
  const result = await pool.query(
    `SELECT id, nome, email, cpf, tel FROM pacientes WHERE id=$1 LIMIT 1`,
    [id],
  );
  return result.rows[0] || null;
}

function installPatientHistoryRoutes(app) {
  if (app.locals.__patientHistoryInstalled) return;
  app.locals.__patientHistoryInstalled = true;

  app.get('/api/paciente/historico', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });

      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10) return res.json({ ok: true, atendimentos: [] });

      const result = await pool.query(
        `SELECT
           (to_jsonb(f)->>'id')::int AS id,
           NULLIF(TRIM(COALESCE(to_jsonb(f)->>'medico_nome','')), '') AS profissional_nome,
           NULLIF(TRIM(COALESCE(to_jsonb(f)->>'tipo','')), '') AS tipo,
           NULLIF(TRIM(COALESCE(to_jsonb(f)->>'status','')), '') AS status,
           NULLIF(TRIM(COALESCE(to_jsonb(f)->>'triagem','')), '') AS resumo,
           COALESCE(
             NULLIF(to_jsonb(f)->>'finalizado_em','')::timestamptz,
             NULLIF(to_jsonb(f)->>'assumido_em','')::timestamptz,
             NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz,
             NOW()
           ) AS data_atendimento
         FROM fila_atendimentos f
        WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $1
          AND (
            $2 = '' OR
            regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $2
          )
          AND COALESCE(to_jsonb(f)->>'status','') NOT IN ('cancelado','expirado')
        ORDER BY data_atendimento DESC
        LIMIT 50`,
        [phone, cpf],
      );

      const atendimentos = result.rows.map((row) => ({
        id: row.id,
        profissional_nome: row.profissional_nome || 'Profissional da ConsultaJá24h',
        tipo: row.tipo || 'consulta',
        status: row.status || 'concluído',
        resumo: row.resumo || '',
        data_atendimento: row.data_atendimento,
      }));

      return res.json({ ok: true, atendimentos });
    } catch (error) {
      console.error('[PACIENTE-HISTORICO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar o histórico agora.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installPatientHistoryRoutes(this);
  return result;
};
