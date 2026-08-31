import express from 'express';
import pg from 'pg';
import webpush from 'web-push';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://consultaja24h.com.br').replace(/\/$/, '');
const VAPID_PUBLIC_KEY = String(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:consultaja24@gmail.com').trim();
const AFTER_MINUTES = Math.max(10, Number(process.env.PAYMENT_RECOVERY_WEB_PUSH_MINUTES || 25));
const LOOKBACK_HOURS = Math.min(48, Math.max(4, Number(process.env.PAYMENT_RECOVERY_LOOKBACK_HOURS || 24)));
const WORKER_MS = Math.max(30000, Number(process.env.PAYMENT_RECOVERY_WORKER_MS || 60000));

let schemaReady = false;
let workerBusy = false;

function enabled() {
  return /^(1|true|yes|sim|on)$/i.test(String(process.env.PAYMENT_RECOVERY_ENABLED || '').trim())
    && !!VAPID_PUBLIC_KEY && !!VAPID_PRIVATE_KEY;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let n = digits(value);
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  return n.slice(-11);
}

async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      atendimento_id BIGINT NOT NULL,
      telefone TEXT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_atendimento
      ON web_push_subscriptions(atendimento_id) WHERE ativo=TRUE;

    CREATE TABLE IF NOT EXISTS web_push_recuperacao_eventos (
      id BIGSERIAL PRIMARY KEY,
      atendimento_id BIGINT NOT NULL,
      subscription_id BIGINT NOT NULL,
      status TEXT NOT NULL,
      detalhe TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(atendimento_id, subscription_id)
    );
  `);
  schemaReady = true;
}

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function validarAtendimentoTelefone(atendimentoId, telefone) {
  const phone = normalizePhone(telefone);
  if (!atendimentoId || phone.length < 10) return null;
  const { rows } = await pool.query(`
    SELECT id,pagamento_status,status,pagbank_order_id,pagbank_qr_text,efi_charge_id
      FROM fila_atendimentos
     WHERE id=$1
       AND RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'),11)=$2
     LIMIT 1
  `, [Number(atendimentoId), phone]);
  return rows[0] || null;
}

function installRoutes(app) {
  if (app.locals.__webPushRecoveryInstalled) return;
  app.locals.__webPushRecoveryInstalled = true;

  app.get('/api/web-push/public-key', (_req, res) => {
    res.json({ ok: !!VAPID_PUBLIC_KEY, publicKey: VAPID_PUBLIC_KEY || '' });
  });

  app.post('/api/web-push/subscribe', express.json({ limit: '32kb' }), async (req, res) => {
    try {
      await ensureSchema();
      const atendimentoId = Number(req.body?.atendimentoId);
      const telefone = normalizePhone(req.body?.telefone);
      const subscription = req.body?.subscription || {};
      const endpoint = String(subscription?.endpoint || '').trim();
      const p256dh = String(subscription?.keys?.p256dh || '').trim();
      const auth = String(subscription?.keys?.auth || '').trim();
      if (!atendimentoId || telefone.length < 10 || !endpoint || !p256dh || !auth) {
        return res.status(400).json({ ok: false, error: 'Dados de notificação inválidos' });
      }
      const atendimento = await validarAtendimentoTelefone(atendimentoId, telefone);
      if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado' });
      const altaIntencao = !!(
        String(atendimento.pagbank_order_id || '').trim()
        || String(atendimento.pagbank_qr_text || '').trim()
        || String(atendimento.efi_charge_id || '').trim()
      );
      if (!altaIntencao || atendimento.pagamento_status === 'confirmado') {
        return res.status(409).json({ ok: false, error: 'Atendimento não elegível para lembrete' });
      }
      await pool.query(`
        INSERT INTO web_push_subscriptions(atendimento_id,telefone,endpoint,p256dh,auth,ativo,atualizado_em)
        VALUES($1,$2,$3,$4,$5,TRUE,NOW())
        ON CONFLICT(endpoint) DO UPDATE SET
          atendimento_id=EXCLUDED.atendimento_id,
          telefone=EXCLUDED.telefone,
          p256dh=EXCLUDED.p256dh,
          auth=EXCLUDED.auth,
          ativo=TRUE,
          atualizado_em=NOW()
      `, [atendimentoId, telefone, endpoint, p256dh, auth]);
      return res.json({ ok: true });
    } catch (error) {
      console.error('[WEB-PUSH-SUBSCRIBE]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível ativar o lembrete.' });
    }
  });
}

function identityMatchSql(alias = 'x') {
  return `(
    (regexp_replace(COALESCE(${alias}.cpf,''), '\\D', '', 'g') <> ''
      AND regexp_replace(COALESCE(${alias}.cpf,''), '\\D', '', 'g') = regexp_replace(COALESCE(f.cpf,''), '\\D', '', 'g'))
    OR
    (RIGHT(regexp_replace(COALESCE(${alias}.tel,''), '\\D', '', 'g'),11) = RIGHT(regexp_replace(COALESCE(f.tel,''), '\\D', '', 'g'),11)
      AND lower(trim(COALESCE(${alias}.nome,''))) = lower(trim(COALESCE(f.nome,''))))
  )`;
}

async function candidates() {
  const { rows } = await pool.query(`
    SELECT f.id AS atendimento_id,s.id AS subscription_id,s.endpoint,s.p256dh,s.auth
      FROM fila_atendimentos f
      JOIN web_push_subscriptions s ON s.atendimento_id=f.id AND s.ativo=TRUE
     WHERE f.pagamento_status='pendente'
       AND COALESCE(f.status,'') NOT IN ('cancelado','expirado','arquivado')
       AND f.criado_em >= NOW() - ($1::text || ' hours')::interval
       AND f.criado_em <= NOW() - ($2::text || ' minutes')::interval
       AND (
         NULLIF(btrim(COALESCE(f.pagbank_order_id,'')), '') IS NOT NULL
         OR NULLIF(btrim(COALESCE(f.pagbank_qr_text,'')), '') IS NOT NULL
         OR NULLIF(btrim(COALESCE(f.efi_charge_id,'')), '') IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM web_push_recuperacao_eventos e
          WHERE e.atendimento_id=f.id AND e.subscription_id=s.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM fila_atendimentos x
          WHERE x.id<>f.id
            AND x.pagamento_status='confirmado'
            AND COALESCE(x.pagamento_confirmado_em, x.criado_em AT TIME ZONE 'UTC') > (f.criado_em AT TIME ZONE 'UTC')
            AND ${identityMatchSql('x')}
       )
     ORDER BY f.criado_em ASC
     LIMIT 30
  `, [LOOKBACK_HOURS, AFTER_MINUTES]);
  return rows;
}

async function record(row, status, detalhe = null) {
  await pool.query(`
    INSERT INTO web_push_recuperacao_eventos(atendimento_id,subscription_id,status,detalhe)
    VALUES($1,$2,$3,$4)
    ON CONFLICT(atendimento_id,subscription_id) DO NOTHING
  `, [row.atendimento_id, row.subscription_id, status, detalhe ? String(detalhe).slice(0, 500) : null]);
}

async function sendOne(row) {
  const subscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  const url = `${SITE_URL}/consulta/?retomar_pagamento=${encodeURIComponent(row.atendimento_id)}&src=webpush`;
  const payload = JSON.stringify({
    title: 'Seu atendimento ainda pode ser retomado',
    body: 'O pagamento não foi concluído. Toque para voltar ao pagamento.',
    url,
    atendimentoId: Number(row.atendimento_id),
  });
  try {
    await webpush.sendNotification(subscription, payload, { TTL: 3600, urgency: 'high' });
    await record(row, 'enviado', 'ok');
  } catch (error) {
    const statusCode = Number(error?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      await pool.query('UPDATE web_push_subscriptions SET ativo=FALSE,atualizado_em=NOW() WHERE id=$1', [row.subscription_id]).catch(() => {});
      await record(row, 'ignorado', `subscription_${statusCode}`);
      return;
    }
    await record(row, 'erro', error?.message || `webpush_${statusCode || 'erro'}`);
  }
}

async function runWorker() {
  if (!enabled() || workerBusy) return;
  workerBusy = true;
  try {
    await ensureSchema();
    const rows = await candidates();
    for (const row of rows) await sendOne(row);
  } catch (error) {
    console.warn('[WEB-PUSH-RECOVERY]', error?.message || error);
  } finally {
    workerBusy = false;
  }
}

await ensureSchema();
console.log(`[WEB-PUSH-RECOVERY] ${enabled() ? 'habilitado' : 'desabilitado'}; atraso=${AFTER_MINUTES}m`);
setInterval(runWorker, WORKER_MS).unref?.();

const originalInit = express.application.init;
express.application.init = function patchedWebPushRecoveryInit(...args) {
  const result = originalInit.apply(this, args);
  installRoutes(this);
  return result;
};
