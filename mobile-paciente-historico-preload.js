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

async function atendimentoDoPaciente(pacienteId, atendimentoId) {
  const paciente = await pacienteAtual(pacienteId);
  if (!paciente) return null;
  const cpf = normalizeCpf(paciente.cpf);
  const phone = normalizePhone(paciente.tel);
  if (cpf.length !== 11 || phone.length < 10) return null;

  const result = await pool.query(
    `SELECT f.*
       FROM fila_atendimentos f
      WHERE f.id=$1
        AND (
          regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $2
          OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $2
        )
        AND RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $3
      LIMIT 1`,
    [atendimentoId, cpf, phone],
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
             NULLIF(to_jsonb(f)->>'encerrado_em','')::timestamptz,
             NULLIF(to_jsonb(f)->>'assumido_em','')::timestamptz,
             NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz,
             NOW()
           ) AS data_atendimento
         FROM fila_atendimentos f
        WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $1
          AND (
            $2 = '' OR
            regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $2 OR
            regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $2
          )
          AND COALESCE(to_jsonb(f)->>'status','') NOT IN ('cancelado','expirado')
        ORDER BY data_atendimento DESC
        LIMIT 50`,
        [phone, cpf],
      );

      const atendimentos = result.rows.map((row) => ({
        id: row.id,
        profissional_nome: row.profissional_nome || 'Profissional da ConsultaJá24h',
        medico_nome: row.profissional_nome || null,
        tipo: row.tipo || 'consulta',
        status: row.status || 'concluído',
        resumo: row.resumo || '',
        triagem: row.resumo || '',
        data_atendimento: row.data_atendimento,
        criado_em: row.data_atendimento,
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
           (to_jsonb(f)->>'id')::int AS id,
           NULLIF(to_jsonb(f)->>'nome','') AS nome,
           NULLIF(to_jsonb(f)->>'cpf','') AS cpf,
           NULLIF(to_jsonb(f)->>'tel','') AS tel,
           NULLIF(to_jsonb(f)->>'email','') AS email,
           NULLIF(to_jsonb(f)->>'data_nascimento','') AS data_nascimento,
           NULLIF(to_jsonb(f)->>'tipo','') AS tipo,
           NULLIF(to_jsonb(f)->>'status','') AS status,
           NULLIF(to_jsonb(f)->>'pagamento_status','') AS pagamento_status,
           NULLIF(to_jsonb(f)->>'pagamento_metodo','') AS pagamento_metodo,
           NULLIF(to_jsonb(f)->>'pagamento_confirmado_em','')::timestamptz AS pagamento_confirmado_em,
           NULLIF(to_jsonb(f)->>'pagbank_order_id','') AS pagbank_order_id,
           NULLIF(to_jsonb(f)->>'pagbank_qr_text','') AS pagbank_qr_text,
           NULLIF(to_jsonb(f)->>'pagbank_qr_expira_em','')::timestamptz AS pagbank_qr_expira_em,
           NULLIF(to_jsonb(f)->>'efi_charge_id','') AS efi_charge_id,
           NULLIF(to_jsonb(f)->>'triagem','') AS triagem,
           NULLIF(to_jsonb(f)->>'queixa','') AS queixa,
           COALESCE((to_jsonb(f)->>'atendimento_para_terceiro')::boolean, false) AS atendimento_para_terceiro,
           NULLIF(to_jsonb(f)->>'pagador_cpf','') AS pagador_cpf,
           NULLIF(to_jsonb(f)->>'medico_id','')::int AS medico_id,
           NULLIF(to_jsonb(f)->>'medico_nome','') AS medico_nome,
           NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz AS criado_em
         FROM fila_atendimentos f
        WHERE COALESCE(to_jsonb(f)->>'status','') NOT IN ('encerrado','finalizado','cancelado','expirado','arquivado')
          AND (
            regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $1
            OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $1
          )
          AND RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $2
        ORDER BY NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz DESC NULLS LAST
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

  app.get('/api/paciente/atendimento/:id/chat', authPaciente, async (req, res) => {
    try {
      const atendimentoId = Number(req.params.id);
      if (!atendimentoId) return res.status(400).json({ ok: false, error: 'Atendimento inválido' });
      const atendimento = await atendimentoDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado' });

      const result = await pool.query(
        `SELECT id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,arquivo_nome,criado_em
           FROM mensagens
          WHERE atendimento_id=$1
          ORDER BY criado_em ASC, id ASC`,
        [atendimentoId],
      );
      return res.json({
        ok: true,
        atendimento: {
          id: atendimento.id,
          status: atendimento.status,
          medico_nome: atendimento.medico_nome || null,
          etapa: etapaDoAtendimento(atendimento),
        },
        mensagens: result.rows,
      });
    } catch (error) {
      console.error('[PACIENTE-CHAT-GET]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar as mensagens.' });
    }
  });

  app.post('/api/paciente/atendimento/:id/chat', authPaciente, async (req, res) => {
    try {
      const atendimentoId = Number(req.params.id);
      const texto = String(req.body?.texto || '').trim().slice(0, 3000);
      if (!atendimentoId || !texto) return res.status(400).json({ ok: false, error: 'Mensagem vazia' });

      const atendimento = await atendimentoDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado' });
      if (String(atendimento.status || '').toLowerCase() !== 'assumido' || !atendimento.medico_id) {
        return res.status(409).json({ ok: false, error: 'O chat será liberado quando um médico assumir o atendimento.' });
      }

      const result = await pool.query(
        `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto,arquivo_url,arquivo_tipo)
         VALUES ($1,'paciente',$2,$3,NULL,NULL)
         RETURNING id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,arquivo_nome,criado_em`,
        [atendimentoId, req.pacienteId, texto],
      );
      return res.json({ ok: true, mensagem: result.rows[0] });
    } catch (error) {
      console.error('[PACIENTE-CHAT-SEND]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível enviar a mensagem.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installPatientHistoryRoutes(this);
  return result;
};
