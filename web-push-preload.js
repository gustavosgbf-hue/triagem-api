import './patient-retention-preload.js';
import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://consultaja24h.com.br').replace(/\/$/, '');
const PANEL_URL = String(process.env.PUBLIC_PANEL_URL || 'https://painel.consultaja24h.com.br').replace(/\/$/, '');
const VAPID_PUBLIC_KEY = String(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:consultaja24@gmail.com').trim();
const AFTER_MINUTES = Math.max(10, Number(process.env.PAYMENT_RECOVERY_WEB_PUSH_MINUTES || 25));
const LOOKBACK_HOURS = Math.min(48, Math.max(4, Number(process.env.PAYMENT_RECOVERY_LOOKBACK_HOURS || 24)));
const WORKER_MS = Math.max(30000, Number(process.env.PAYMENT_RECOVERY_WORKER_MS || 60000));
const CHAT_WORKER_MS = Math.max(8000, Number(process.env.CHAT_WEB_PUSH_WORKER_MS || 12000));

let schemaReady = false;
let workerBusy = false;
let chatWorkerBusy = false;

function paymentRecoveryEnabled() {
  return /^(1|true|yes|sim|on)$/i.test(String(process.env.PAYMENT_RECOVERY_ENABLED || '').trim())
    && !!VAPID_PUBLIC_KEY && !!VAPID_PRIVATE_KEY;
}

function chatPushEnabled() {
  return !!VAPID_PUBLIC_KEY && !!VAPID_PRIVATE_KEY;
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

    CREATE TABLE IF NOT EXISTS web_push_chat_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      papel TEXT NOT NULL CHECK (papel IN ('paciente','medico')),
      atendimento_id BIGINT,
      medico_id BIGINT,
      telefone TEXT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_web_push_chat_paciente
      ON web_push_chat_subscriptions(atendimento_id) WHERE ativo=TRUE AND papel='paciente';
    CREATE INDEX IF NOT EXISTS idx_web_push_chat_medico
      ON web_push_chat_subscriptions(medico_id) WHERE ativo=TRUE AND papel='medico';
    ALTER TABLE web_push_chat_subscriptions
      ADD COLUMN IF NOT EXISTS medico_avisar_mensagens BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE web_push_chat_subscriptions
      ADD COLUMN IF NOT EXISTS medico_avisar_fila BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS web_push_medico_fila_entregas (
      atendimento_id BIGINT NOT NULL,
      subscription_id BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'tentativa',
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (atendimento_id,subscription_id)
    );

    ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS web_push_paciente_em TIMESTAMPTZ;
    ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS web_push_medico_em TIMESTAMPTZ;
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
    SELECT id,pagamento_status,status,pagbank_order_id,pagbank_qr_text,efi_charge_id,medico_id,medico_nome,nome
      FROM fila_atendimentos
     WHERE id=$1
       AND RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'),11)=$2
     LIMIT 1
  `, [Number(atendimentoId), phone]);
  return rows[0] || null;
}

function decodeMedico(req) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '');
    // O JWT do painel médico contém email+crm e não possui tipo.
    // Impede usar tokens de paciente, psicólogo, especialista ou links de assumir.
    if (!decoded?.id || decoded?.tipo || !decoded?.email || !Object.prototype.hasOwnProperty.call(decoded, 'crm')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function subscriptionParts(subscription) {
  return {
    endpoint: String(subscription?.endpoint || '').trim(),
    p256dh: String(subscription?.keys?.p256dh || '').trim(),
    auth: String(subscription?.keys?.auth || '').trim(),
  };
}

async function saveChatSubscription({ papel, atendimentoId = null, medicoId = null, telefone = null, subscription }) {
  const { endpoint, p256dh, auth } = subscriptionParts(subscription);
  if (!endpoint || !p256dh || !auth) throw new Error('subscription_invalida');
  await pool.query(`
    INSERT INTO web_push_chat_subscriptions(papel,atendimento_id,medico_id,telefone,endpoint,p256dh,auth,ativo,atualizado_em)
    VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,NOW())
    ON CONFLICT(endpoint) DO UPDATE SET
      papel=EXCLUDED.papel,
      atendimento_id=EXCLUDED.atendimento_id,
      medico_id=EXCLUDED.medico_id,
      telefone=EXCLUDED.telefone,
      p256dh=EXCLUDED.p256dh,
      auth=EXCLUDED.auth,
      ativo=TRUE,
      atualizado_em=NOW()
  `, [papel, atendimentoId, medicoId, telefone, endpoint, p256dh, auth]);
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
      const { endpoint, p256dh, auth } = subscriptionParts(subscription);
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

  // Preferências por dispositivo, nunca globalmente entre médicos. Somente o titular do JWT.
  app.post('/api/web-push/medico/preferencias', express.json({ limit: '32kb' }), async (req, res) => {
    const medico = decodeMedico(req);
    if (!medico) return res.status(401).json({ ok: false, error: 'Sessão inválida' });
    if (!chatPushEnabled()) return res.status(503).json({ ok: false, error: 'Notificações indisponíveis' });
    const mensagens = req.body?.mensagens, fila = req.body?.fila;
    if (typeof mensagens !== 'boolean' || typeof fila !== 'boolean')
      return res.status(400).json({ ok: false, error: 'Preferências inválidas' });
    const subscription = req.body?.subscription || {};
    const { endpoint, p256dh, auth } = subscriptionParts(subscription);
    if (!endpoint.startsWith('https://') || endpoint.length > 2048 || !p256dh || !auth)
      return res.status(400).json({ ok: false, error: 'Dispositivo inválido' });
    try {
      await ensureSchema();
      const ativo = await pool.query('SELECT id FROM medicos WHERE id=$1 AND ativo=TRUE AND lower(email)=lower($2) LIMIT 1',
        [Number(medico.id), String(medico.email)]);
      if (!ativo.rowCount) return res.status(403).json({ ok: false, error: 'Médico não autorizado' });
      // Vínculo e preferências atômicos, sem janela de permissões antigas.
      await pool.query(`
        INSERT INTO web_push_chat_subscriptions
          (papel,atendimento_id,medico_id,telefone,endpoint,p256dh,auth,ativo,
           medico_avisar_mensagens,medico_avisar_fila,atualizado_em)
        VALUES('medico',NULL,$1,NULL,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT(endpoint) DO UPDATE SET
          papel='medico', atendimento_id=NULL, medico_id=EXCLUDED.medico_id,
          telefone=NULL, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth,
          ativo=EXCLUDED.ativo,
          medico_avisar_mensagens=EXCLUDED.medico_avisar_mensagens,
          medico_avisar_fila=EXCLUDED.medico_avisar_fila,
          criado_em=CASE WHEN web_push_chat_subscriptions.medico_id IS DISTINCT FROM EXCLUDED.medico_id
                     THEN NOW() ELSE web_push_chat_subscriptions.criado_em END,
          atualizado_em=NOW()`,
        [Number(medico.id), endpoint, p256dh, auth, mensagens || fila, mensagens, fila]);
      return res.json({ ok: true, mensagens, fila, ativo: mensagens || fila });
    } catch(e) {
      console.warn('[MEDICO-WEB-PUSH-CONFIG]', e?.message || e);
      return res.status(500).json({ ok: false, error: 'Não foi possível salvar suas preferências.' });
    }
  });

  app.post('/api/web-push/medico/estado', express.json({ limit: '8kb' }), async (req, res) => {
    const medico = decodeMedico(req);
    if (!medico) return res.status(401).json({ ok: false, error: 'Sessão inválida' });
    const endpoint = String(req.body?.endpoint || '').trim();
    if (!endpoint || endpoint.length > 2048)
      return res.json({ ok: true, ativo: false, mensagens: false, fila: false });
    try {
      await ensureSchema();
      const ativo = await pool.query('SELECT id FROM medicos WHERE id=$1 AND ativo=TRUE AND lower(email)=lower($2) LIMIT 1',
        [Number(medico.id), String(medico.email)]);
      if (!ativo.rowCount) return res.status(403).json({ ok: false, error: 'Médico não autorizado' });
      const { rows } = await pool.query(`SELECT ativo,medico_avisar_mensagens,medico_avisar_fila
        FROM web_push_chat_subscriptions WHERE endpoint=$1 AND medico_id=$2 AND papel='medico' LIMIT 1`,
        [endpoint, Number(medico.id)]);
      const r = rows[0];
      return res.json({ ok: true, ativo: !!r?.ativo,
        mensagens: !!(r?.ativo && r?.medico_avisar_mensagens),
        fila: !!(r?.ativo && r?.medico_avisar_fila) });
    } catch(e) {
      return res.status(500).json({ ok: false, error: 'Estado indisponível.' });
    }
  });

  app.post('/api/web-push/chat-subscribe', express.json({ limit: '32kb' }), async (req, res) => {
    try {
      if (!chatPushEnabled()) return res.status(503).json({ ok: false, error: 'Notificações indisponíveis' });
      await ensureSchema();
      const papel = String(req.body?.papel || '').trim().toLowerCase();
      const subscription = req.body?.subscription || {};
      if (papel === 'paciente') {
        const atendimentoId = Number(req.body?.atendimentoId);
        const telefone = normalizePhone(req.body?.telefone);
        const atendimento = await validarAtendimentoTelefone(atendimentoId, telefone);
        if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado' });
        await saveChatSubscription({ papel, atendimentoId, telefone, subscription });
        return res.json({ ok: true });
      }
      if (papel === 'medico') {
        const decoded = decodeMedico(req);
        if (!decoded) return res.status(401).json({ ok: false, error: 'Sessão inválida' });
        await saveChatSubscription({ papel, medicoId: Number(decoded.id), subscription });
        return res.json({ ok: true });
      }
      return res.status(400).json({ ok: false, error: 'Papel inválido' });
    } catch (error) {
      console.warn('[WEB-PUSH-CHAT-SUBSCRIBE]', error?.message || error);
      return res.status(500).json({ ok: false, error: 'Não foi possível ativar notificações.' });
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

async function sendSubscription(row, payload, ttl = 3600) {
  const subscription = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), { TTL: ttl, urgency: 'high' });
    return true;
  } catch (error) {
    const statusCode = Number(error?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) {
      const table = row.chat_subscription_id ? 'web_push_chat_subscriptions' : 'web_push_subscriptions';
      const id = row.chat_subscription_id || row.subscription_id;
      await pool.query(`UPDATE ${table} SET ativo=FALSE,atualizado_em=NOW() WHERE id=$1`, [id]).catch(() => {});
    }
    return false;
  }
}

async function sendOne(row) {
  const url = `${SITE_URL}/consulta/?retomar_pagamento=${encodeURIComponent(row.atendimento_id)}&src=webpush`;
  const payload = {
    title: 'Seu atendimento ainda pode ser retomado',
    body: 'O pagamento não foi concluído. Toque para voltar ao pagamento.',
    url,
    atendimentoId: Number(row.atendimento_id),
  };
  const ok = await sendSubscription(row, payload, 3600);
  if (ok) await record(row, 'enviado', 'ok');
  else await record(row, 'erro', 'webpush_send_failed');
}

async function runWorker() {
  if (!paymentRecoveryEnabled() || workerBusy) return;
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

async function processarMensagensParaPacienteWeb() {
  const { rows } = await pool.query(`
    SELECT m.id AS mensagem_id,m.atendimento_id,m.arquivo_tipo,
           s.id AS chat_subscription_id,s.endpoint,s.p256dh,s.auth
      FROM mensagens m
      JOIN web_push_chat_subscriptions s
        ON s.atendimento_id=m.atendimento_id AND s.papel='paciente' AND s.ativo=TRUE
     WHERE m.autor='medico'
       AND m.web_push_paciente_em IS NULL
       AND m.criado_em >= NOW() - INTERVAL '24 hours'
     ORDER BY m.id ASC
     LIMIT 60
  `);
  const sent = new Set();
  for (const row of rows) {
    const ok = await sendSubscription(row, {
      title: 'Nova mensagem no atendimento',
      body: String(row.arquivo_tipo || '').toLowerCase() === 'pdf'
        ? 'Seu médico enviou um documento. Toque para abrir o atendimento.'
        : 'Você recebeu uma nova mensagem do médico.',
      url: `${SITE_URL}/atendimento/?consulta=${encodeURIComponent(row.atendimento_id)}&src=push`,
      kind: 'chat', atendimentoId: Number(row.atendimento_id),
    });
    if (ok) sent.add(Number(row.mensagem_id));
  }
  for (const id of sent) {
    await pool.query('UPDATE mensagens SET web_push_paciente_em=NOW() WHERE id=$1 AND web_push_paciente_em IS NULL', [id]).catch(() => {});
  }
}

async function processarMensagensParaMedicoWeb() {
  const { rows } = await pool.query(`
    SELECT m.id AS mensagem_id,m.atendimento_id,f.nome,
           s.id AS chat_subscription_id,s.endpoint,s.p256dh,s.auth
      FROM mensagens m
      JOIN fila_atendimentos f ON f.id=m.atendimento_id
      JOIN web_push_chat_subscriptions s
        ON s.medico_id=f.medico_id AND s.papel='medico' AND s.ativo=TRUE AND s.medico_avisar_mensagens=TRUE
      JOIN medicos dr ON dr.id=s.medico_id AND dr.ativo=TRUE
     WHERE m.autor='paciente'
       AND f.medico_id IS NOT NULL
       AND m.web_push_medico_em IS NULL
       AND m.criado_em >= NOW() - INTERVAL '24 hours'
     ORDER BY m.id ASC
     LIMIT 60
  `);
  const sent = new Set();
  for (const row of rows) {
    const primeiroNome = String(row.nome || 'Paciente').trim().split(/\s+/)[0] || 'Paciente';
    const ok = await sendSubscription(row, {
      title: 'Nova mensagem do paciente',
      body: `${primeiroNome} enviou uma nova mensagem no atendimento.`,
      url: `${PANEL_URL}/?src=push&atendimento=${encodeURIComponent(row.atendimento_id)}`,
      kind: 'chat-medico', atendimentoId: Number(row.atendimento_id),
    });
    if (ok) sent.add(Number(row.mensagem_id));
  }
  for (const id of sent) {
    await pool.query('UPDATE mensagens SET web_push_medico_em=NOW() WHERE id=$1 AND web_push_medico_em IS NULL', [id]).catch(() => {});
  }
}

// Paciente novo: sem conteúdo clínico nem nome no bloqueio de tela, sem replay
// de atendimentos anteriores ao cadastro deste dispositivo.
async function processarFilaParaMedicoWeb() {
  const { rows } = await pool.query(`
    SELECT f.id AS atendimento_id,
           s.id AS chat_subscription_id,s.endpoint,s.p256dh,s.auth
      FROM fila_atendimentos f
      JOIN web_push_chat_subscriptions s
        ON s.papel='medico' AND s.ativo=TRUE AND s.medico_avisar_fila=TRUE
       AND s.criado_em <= COALESCE(f.pagamento_confirmado_em,f.criado_em)
      JOIN medicos dr ON dr.id=s.medico_id AND dr.ativo=TRUE
      LEFT JOIN web_push_medico_fila_entregas e
        ON e.atendimento_id=f.id AND e.subscription_id=s.id
     WHERE f.status='aguardando'
       AND f.pagamento_status IN ('confirmado','isento_admin')
       AND f.tipo NOT LIKE 'renovacao%'
       AND COALESCE(f.categoria_atendimento,'clinico') <> 'especialista_imediato'
       AND (f.prioridade_medico_id IS NULL OR f.prioridade_medico_id=s.medico_id
            OR f.prioridade_ate <= NOW())
       AND LOWER(TRIM(COALESCE(f.triagem,''))) NOT LIKE '(aguardando pagamento)%'
       AND LOWER(TRIM(COALESCE(f.triagem,''))) NOT LIKE '(pagamento confirmado%'
       AND LOWER(TRIM(COALESCE(f.triagem,''))) NOT LIKE '(triagem em andamento)%'
       AND LOWER(TRIM(COALESCE(f.triagem,''))) NOT LIKE '(aguardando triagem%'
       AND f.criado_em >= NOW() - INTERVAL '2 hours'
       AND e.atendimento_id IS NULL
     ORDER BY f.criado_em ASC
     LIMIT 80
  `);
  for (const row of rows) {
    // Claim idempotente antes do envio: vários workers não podem notificar duplicado.
    const claim = await pool.query(`INSERT INTO web_push_medico_fila_entregas(atendimento_id,subscription_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING atendimento_id`,
      [row.atendimento_id,row.chat_subscription_id]);
    if (!claim.rowCount) continue;
    const ok = await sendSubscription(row, {
      title: 'Novo paciente na fila',
      body: 'Há um atendimento pronto para ser assumido. Toque para abrir a fila.',
      url: PANEL_URL + '/?src=push&fila=1',
      kind: 'fila-medico', atendimentoId: Number(row.atendimento_id),
    }, 600);
    await pool.query(`UPDATE web_push_medico_fila_entregas SET status=$1
      WHERE atendimento_id=$2 AND subscription_id=$3`,
      [ok?'enviado':'falhou',row.atendimento_id,row.chat_subscription_id]).catch(()=>{});
  }
}

async function runChatWorker() {
  if (!chatPushEnabled() || chatWorkerBusy) return;
  chatWorkerBusy = true;
  try {
    await ensureSchema();
    await processarMensagensParaPacienteWeb();
    await processarMensagensParaMedicoWeb();
    await processarFilaParaMedicoWeb();
  } catch (error) {
    console.warn('[WEB-PUSH-CHAT]', error?.message || error);
  } finally {
    chatWorkerBusy = false;
  }
}

await ensureSchema();
console.log(`[WEB-PUSH-RECOVERY] ${paymentRecoveryEnabled() ? 'habilitado' : 'desabilitado'}; atraso=${AFTER_MINUTES}m`);
console.log(`[WEB-PUSH-CHAT] ${chatPushEnabled() ? 'habilitado' : 'desabilitado'}; intervalo=${CHAT_WORKER_MS}ms`);
setInterval(runWorker, WORKER_MS).unref?.();
setInterval(runChatWorker, CHAT_WORKER_MS).unref?.();

const originalInit = express.application.init;
express.application.init = function patchedWebPushRecoveryInit(...args) {
  const result = originalInit.apply(this, args);
  installRoutes(this);
  return result;
};
