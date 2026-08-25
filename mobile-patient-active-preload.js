import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BETA_TEST_PHONE = '98991344646';

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

function etapaDoAtendimento(row) {
  const status = String(row?.status || '').toLowerCase();
  const pagamento = String(row?.pagamento_status || '').toLowerCase();
  const pagamentoLiberado = pagamento === 'confirmado' || pagamento === 'isento_admin';
  if (!pagamentoLiberado) return 'pagamento';
  if (status === 'triagem' || status === 'pagamento_pendente') return 'triagem';
  if (status === 'assumido' || row?.medico_id) return 'chat';
  return 'fila';
}

function installActivePatientRoute(app) {
  if (app.locals.__patientActiveWithoutRenewalsInstalled) return;
  app.locals.__patientActiveWithoutRenewalsInstalled = true;

  app.get('/api/paciente/atendimento-em-andamento', authPaciente, async (req, res) => {
    try {
      const patientResult = await pool.query(
        'SELECT id,nome,email,cpf,tel FROM pacientes WHERE id=$1 LIMIT 1',
        [req.pacienteId],
      );
      const paciente = patientResult.rows[0];
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });

      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10 || cpf.length !== 11) {
        return res.json({ ok: true, atendimento: null });
      }

      const isBeta = phone === BETA_TEST_PHONE;
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
        WHERE COALESCE(to_jsonb(f)->>'tipo','') NOT LIKE 'renovacao_%'
          AND COALESCE(LOWER(to_jsonb(f)->>'status'),'') NOT IN ('encerrado','finalizado','finalizada','concluido','concluído','cancelado','expirado','arquivado')
          AND NULLIF(to_jsonb(f)->>'encerrado_em','') IS NULL
          AND NULLIF(to_jsonb(f)->>'finalizado_em','') IS NULL
          AND ($3::boolean = false OR COALESCE(to_jsonb(f)->>'pagamento_metodo','') = 'beta_test')
          AND (
            regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $1
            OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $1
          )
          AND RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $2
        ORDER BY NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz DESC NULLS LAST
        LIMIT 1`,
        [cpf, phone, isBeta],
      );

      const row = result.rows[0];
      if (!row) return res.json({ ok: true, atendimento: null });
      return res.json({ ok: true, atendimento: { ...row, etapa: etapaDoAtendimento(row) } });
    } catch (error) {
      console.error('[PACIENTE-EM-ANDAMENTO-SEM-RENOVACAO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível recuperar o atendimento em andamento.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedActivePatientInit(...args) {
  const result = originalInit.apply(this, args);
  installActivePatientRoute(this);
  return result;
};
