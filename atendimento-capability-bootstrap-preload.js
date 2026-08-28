import express from 'express';
import rateLimit from 'express-rate-limit';
import pg from 'pg';
import { issueCapability } from './atendimento-capability-preload.js';
import { normalizeCpf, normalizePhone } from './patient-identity-security.js';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Não foi possível validar esta sessão.' },
});

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(cpf[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(cpf[9]) && calc(10) === Number(cpf[10]);
}

function deny(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(401).json({ ok: false, error: 'Não foi possível validar esta sessão.' });
}

async function capabilityTableExists() {
  const { rows } = await pool.query("SELECT to_regclass('public.atendimento_capabilities') AS reg");
  return !!rows[0]?.reg;
}

async function alreadyHasCapability(atendimentoId) {
  if (!await capabilityTableExists()) return false;
  const { rows } = await pool.query(
    `SELECT 1
       FROM atendimento_capabilities
      WHERE atendimento_id=$1
        AND revogado_em IS NULL
        AND expira_em > NOW()
      LIMIT 1`,
    [atendimentoId],
  );
  return !!rows[0];
}

function install(app) {
  if (app.locals.__atendimentoCapabilityBootstrapInstalled) return;
  app.locals.__atendimentoCapabilityBootstrapInstalled = true;

  app.post('/api/atendimento/capability/bootstrap', limiter, express.json({ limit: '32kb' }), async (req, res) => {
    try {
      const atendimentoId = Number(req.body?.atendimentoId);
      const cpf = normalizeCpf(req.body?.cpf);
      const phone = normalizePhone(req.body?.tel);
      const name = normalizeName(req.body?.nome);

      if (!Number.isSafeInteger(atendimentoId) || atendimentoId <= 0) return deny(res);
      if (!validCpf(cpf) || phone.length < 10 || name.length < 5) return deny(res);

      // Bootstrap existe somente para sessões criadas antes da capability. Se já
      // há uma capability válida, não emitimos outra com dados de identidade.
      if (await alreadyHasCapability(atendimentoId)) return deny(res);

      const { rows } = await pool.query(
        `SELECT id,nome,tel,cpf,atendimento_para_terceiro,status,criado_em
           FROM fila_atendimentos
          WHERE id=$1
            AND criado_em >= NOW() - INTERVAL '72 hours'
            AND status IN ('pagamento_pendente','triagem','aguardando','assumido','aguardando_aprovacao')
          LIMIT 1`,
        [atendimentoId],
      );
      const at = rows[0];
      if (!at || at.atendimento_para_terceiro) return deny(res);

      const sameCpf = validCpf(at.cpf) && normalizeCpf(at.cpf) === cpf;
      const samePhone = normalizePhone(at.tel) === phone;
      const sameName = normalizeName(at.nome) === name;
      if (!sameCpf || !samePhone || !sameName) return deny(res);

      const token = await issueCapability(atendimentoId, 'legacy-bootstrap');
      res.set('Cache-Control', 'no-store');
      return res.json({ ok: true, atendimentoId, atendimentoToken: token });
    } catch (error) {
      console.error('[ATENDIMENTO-CAPABILITY-BOOTSTRAP]', error?.message || error);
      return deny(res);
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedCapabilityBootstrapInit(...args) {
  const result = originalInit.apply(this, args);
  install(this);
  return result;
};
