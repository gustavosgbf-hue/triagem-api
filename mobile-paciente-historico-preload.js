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

function etapaDoAtendimento(row) {
  const status = String(row?.status || '').toLowerCase();
  const pagamento = String(row?.pagamento_status || '').toLowerCase();
  if (pagamento !== 'confirmado') return 'pagamento';
  if (status === 'triagem' || status === 'pagamento_pendente') return 'triagem';
  if (status === 'assumido' || row?.medico_id) return 'chat';
  return 'fila';
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

  app.get('/api/paciente/atendimento-em-andamento', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });

      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10 || cpf.length !== 11) {
        return res.json({ ok: true, atendimento: null });
      }

      const result = await pool.query(
        `SELECT
           f.id,
           f.nome,
           f.cpf,
           f.tel,
           f.email,
           f.data_nascimento,
           f.tipo,
           f.status,
           f.pagamento_status,
           f.pagamento_metodo,
           f.pagamento_confirmado_em,
           f.pagbank_order_id,
           f.pagbank_qr_text,
           f.pagbank_qr_expira_em,
           f.efi_charge_id,
           f.triagem,
           f.queixa,
           f.atendimento_para_terceiro,
           f.pagador_cpf,
           f.medico_id,
           f.medico_nome,
           f.criado_em
         FROM fila_atendimentos f
        WHERE COALESCE(f.status,'') NOT IN ('encerrado','finalizado','cancelado','expirado','arquivado')
          AND (
            regexp_replace(COALESCE(f.cpf,''), '\\D', '', 'g') = $1
            OR regexp_replace(COALESCE(f.pagador_cpf,''), '\\D', '', 'g') = $1
          )
          AND RIGHT(regexp_replace(COALESCE(f.tel,''), '\\D', '', 'g'), 11) = $2
        ORDER BY f.criado_em DESC
        LIMIT 1`,
        [cpf, phone],
      );

      const row = result.rows[0];
      if (!row) return res.json({ ok: true, atendimento: null });

      return res.json({
        ok: true,
        atendimento: {
          ...row,
          etapa: etapaDoAtendimento(row),
        },
      });
    } catch (error) {
      console.error('[PACIENTE-EM-ANDAMENTO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível recuperar o atendimento em andamento.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installPatientHistoryRoutes(this);
  return result;
};
