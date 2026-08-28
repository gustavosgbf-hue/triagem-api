import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ADMIN_EMAIL = 'gustavosgbf@gmail.com';
const TOKEN_HEADER = 'x-atendimento-token';
const OFFICIAL_ORIGINS = new Set([
  'https://consultaja24h.com.br',
  'https://www.consultaja24h.com.br',
  'https://painel.consultaja24h.com.br',
]);

let schemaReady;

function ttlDays() {
  const configured = Number(process.env.ATENDIMENTO_CAPABILITY_TTL_DAYS || 30);
  if (!Number.isFinite(configured)) return 30;
  return Math.max(1, Math.min(180, Math.trunc(configured)));
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS atendimento_capabilities (
        id BIGSERIAL PRIMARY KEY,
        atendimento_id BIGINT NOT NULL,
        token_hash CHAR(64) NOT NULL,
        contexto TEXT NOT NULL DEFAULT 'web',
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expira_em TIMESTAMPTZ NOT NULL,
        ultimo_uso_em TIMESTAMPTZ,
        revogado_em TIMESTAMPTZ
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_atendimento_capabilities_hash
        ON atendimento_capabilities (token_hash);

      CREATE INDEX IF NOT EXISTS idx_atendimento_capabilities_atendimento
        ON atendimento_capabilities (atendimento_id, expira_em DESC)
        WHERE revogado_em IS NULL;
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function hashToken(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function attendanceToken(req) {
  return String(req.headers[TOKEN_HEADER] || '').trim();
}

function positiveId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

async function issueCapability(atendimentoId, contexto = 'web') {
  const id = positiveId(atendimentoId);
  if (!id) throw new Error('atendimento_invalido');
  await ensureSchema();

  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const days = ttlDays();

  await pool.query(
    `INSERT INTO atendimento_capabilities
      (atendimento_id, token_hash, contexto, criado_em, expira_em)
     VALUES ($1,$2,$3,NOW(),NOW() + ($4::text || ' days')::interval)`,
    [id, tokenHash, String(contexto || 'web').slice(0, 40), days],
  );

  return token;
}

async function validateCapability(atendimentoId, token) {
  const id = positiveId(atendimentoId);
  const raw = String(token || '').trim();
  if (!id || raw.length < 32 || raw.length > 200) return false;
  await ensureSchema();
  const tokenHash = hashToken(raw);
  const { rows } = await pool.query(
    `UPDATE atendimento_capabilities
        SET ultimo_uso_em=NOW()
      WHERE atendimento_id=$1
        AND token_hash=$2
        AND revogado_em IS NULL
        AND expira_em > NOW()
      RETURNING id`,
    [id, tokenHash],
  );
  return !!rows[0];
}

async function doctorAuthorized(atendimentoId, req) {
  const token = bearer(req);
  if (!token) return false;

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || '');
  } catch {
    return false;
  }
  if (!decoded?.id || decoded?.tipo === 'paciente' || decoded?.tipo === 'psicologo') return false;

  const medicoId = positiveId(decoded.id);
  if (!medicoId) return false;

  const { rows } = await pool.query(
    `SELECT f.medico_id, LOWER(TRIM(COALESCE(m.email,''))) AS medico_email
       FROM fila_atendimentos f
       LEFT JOIN medicos m ON m.id=$2
      WHERE f.id=$1
      LIMIT 1`,
    [positiveId(atendimentoId), medicoId],
  );
  const row = rows[0];
  if (!row) return false;
  if (row.medico_email === ADMIN_EMAIL) return true;
  return Number(row.medico_id || 0) === medicoId;
}

function deny(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(401).json({ ok: false, error: 'Acesso não autorizado' });
}

async function authorizeAttendance(req, res, atendimentoId) {
  const id = positiveId(atendimentoId);
  if (!id) return false;
  if (await doctorAuthorized(id, req)) return true;
  return validateCapability(id, attendanceToken(req));
}

async function attendanceIdByOrder(orderId) {
  const value = String(orderId || '').trim().slice(0, 160);
  if (!value) return 0;
  const { rows } = await pool.query(
    `SELECT id FROM fila_atendimentos
      WHERE pagbank_order_id=$1 OR efi_charge_id=$1
      ORDER BY criado_em DESC
      LIMIT 1`,
    [value],
  );
  return positiveId(rows[0]?.id);
}

function withJsonBody(handler) {
  return [express.json({ limit: '1mb' }), handler];
}

function responseWithCapability(req, res, next) {
  const originalJson = res.json.bind(res);
  let emitted = false;

  res.json = function capabilityJson(payload) {
    if (emitted) return originalJson(payload);
    emitted = true;

    const finish = async () => {
      try {
        const atendimentoId = positiveId(payload?.atendimentoId || payload?.atendimento?.id);
        if (!atendimentoId || payload?.ok === false) return originalJson(payload);

        const incoming = attendanceToken(req);
        let token = '';
        if (incoming && await validateCapability(atendimentoId, incoming)) token = incoming;
        else token = await issueCapability(atendimentoId, 'web-notify');

        const nextPayload = { ...payload, atendimentoToken: token };
        if (typeof nextPayload.linkRetorno === 'string' && nextPayload.linkRetorno) {
          const base = nextPayload.linkRetorno.split('#')[0];
          nextPayload.linkRetorno = `${base}#cap=${encodeURIComponent(token)}`;
        }
        res.set('Cache-Control', 'no-store');
        return originalJson(nextPayload);
      } catch (error) {
        console.error('[ATENDIMENTO-CAPABILITY] Falha ao emitir capability:', error.message);
        return originalJson(payload);
      }
    };

    finish();
    return res;
  };

  next();
}

function guardBodyId(field = 'atendimentoId') {
  return async (req, res, next) => {
    try {
      const id = positiveId(req.body?.[field]);
      if (!id) return deny(res);
      if (!await authorizeAttendance(req, res, id)) return deny(res);
      req.atendimentoCapabilityId = id;
      return next();
    } catch (error) {
      console.error('[ATENDIMENTO-CAPABILITY] Falha de autorização:', error.message);
      return deny(res);
    }
  };
}

function guardParamId(param = 'id') {
  return async (req, res, next) => {
    try {
      const id = positiveId(req.params?.[param]);
      if (!id || !await authorizeAttendance(req, res, id)) return deny(res);
      req.atendimentoCapabilityId = id;
      return next();
    } catch (error) {
      console.error('[ATENDIMENTO-CAPABILITY] Falha de autorização:', error.message);
      return deny(res);
    }
  };
}

async function guardOrder(req, res, next) {
  try {
    const orderId = req.params?.orderId || req.body?.orderId || req.body?.chargeId || '';
    const id = positiveId(req.body?.atendimentoId) || await attendanceIdByOrder(orderId);
    if (!id || !await authorizeAttendance(req, res, id)) return deny(res);
    req.atendimentoCapabilityId = id;
    return next();
  } catch (error) {
    console.error('[ATENDIMENTO-CAPABILITY] Falha de autorização por order:', error.message);
    return deny(res);
  }
}

async function guardCpfUpdate(req, res, next) {
  try {
    const id = positiveId(req.body?.atendimentoId) || await attendanceIdByOrder(req.body?.orderId);
    if (!id || !await authorizeAttendance(req, res, id)) return deny(res);
    req.atendimentoCapabilityId = id;
    return next();
  } catch (error) {
    console.error('[ATENDIMENTO-CAPABILITY] Falha no CPF update:', error.message);
    return deny(res);
  }
}

async function notifyGate(req, res, next) {
  try {
    const id = positiveId(req.body?.atendimentoId);
    if (id && !await authorizeAttendance(req, res, id)) return deny(res);
    return responseWithCapability(req, res, next);
  } catch (error) {
    console.error('[ATENDIMENTO-CAPABILITY] Falha no notify:', error.message);
    return deny(res);
  }
}

function installCapability(app) {
  if (app.locals.__atendimentoCapabilityInstalled) return;
  app.locals.__atendimentoCapabilityInstalled = true;

  // Complementa CORS sem responder ao OPTIONS aqui. O middleware CORS existente
  // continua sendo a fonte de verdade; apenas garante que o header próprio não
  // seja descartado quando a origem é oficial.
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && OFFICIAL_ORIGINS.has(origin)) {
      const requested = String(req.get('access-control-request-headers') || '');
      if (requested && requested.toLowerCase().includes(TOKEN_HEADER)) {
        res.set('Access-Control-Allow-Headers', requested);
      }
    }
    next();
  });

  // /api/notify é a porta de criação/retomada. Sem atendimentoId cria/retoma por
  // identidade e recebe uma nova capability; com atendimentoId exige posse.
  app.post('/api/notify', ...withJsonBody(notifyGate));

  // Leitura sensível por ID previsível.
  app.get('/api/atendimento/status/:id', guardParamId('id'));
  app.get('/api/chat/:atendimentoId', guardParamId('atendimentoId'));
  app.get('/api/pagamento/elegibilidade/:atendimentoId', guardParamId('atendimentoId'));

  // Pagamento por order também é protegido porque o order pode aparecer no
  // storage do navegador e não substitui autorização explícita do atendimento.
  app.get('/api/pagbank/order/:orderId', guardOrder);

  // Mutações do fluxo do paciente.
  app.post('/api/chat/enviar', ...withJsonBody(guardBodyId('atendimentoId')));
  app.post('/api/atendimento/atualizar-triagem', ...withJsonBody(guardBodyId('atendimentoId')));
  app.post('/api/atendimento/atualizar-modalidade', ...withJsonBody(guardBodyId('atendimentoId')));
  app.post('/api/atendimento/vincular-order', ...withJsonBody(guardBodyId('atendimentoId')));
  app.post('/api/atendimento/atualizar-cpf', ...withJsonBody(guardCpfUpdate));
  app.post('/api/atendimento/:id/fallback-especialista', express.json({ limit: '1mb' }), guardParamId('id'));

  // Criação/consulta de cobrança vinculada a um atendimento existente.
  app.post('/api/pagbank/order', ...withJsonBody(guardBodyId('atendimentoId')));
}

const originalInit = express.application.init;
express.application.init = function patchedCapabilityInit(...args) {
  const result = originalInit.apply(this, args);
  installCapability(this);
  return result;
};

export {
  TOKEN_HEADER,
  hashToken,
  issueCapability,
  validateCapability,
  authorizeAttendance,
};
