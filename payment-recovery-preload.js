import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://consultaja24h.com.br').replace(/\/$/, '');
const RESEND_FROM = process.env.RESEND_DEFAULT_FROM || 'ConsultaJá24h <contato@consultaja24h.com.br>';
const PUSH_AFTER_MINUTES = Math.max(10, Number(process.env.PAYMENT_RECOVERY_PUSH_MINUTES || 25));
const EMAIL_AFTER_MINUTES = Math.max(PUSH_AFTER_MINUTES + 15, Number(process.env.PAYMENT_RECOVERY_EMAIL_MINUTES || 120));
const LOOKBACK_HOURS = Math.min(48, Math.max(4, Number(process.env.PAYMENT_RECOVERY_LOOKBACK_HOURS || 24)));
const WORKER_MS = Math.max(30000, Number(process.env.PAYMENT_RECOVERY_WORKER_MS || 60000));

let schemaReady = false;
let workerBusy = false;
let activatedAt = null;

function enabled() {
  return /^(1|true|yes|sim|on)$/i.test(String(process.env.PAYMENT_RECOVERY_ENABLED || '').trim());
}

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

function validEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pagamento_recuperacao_config (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      ativado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO pagamento_recuperacao_config (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    CREATE TABLE IF NOT EXISTS pagamento_recuperacao_eventos (
      id BIGSERIAL PRIMARY KEY,
      atendimento_id BIGINT NOT NULL,
      canal TEXT NOT NULL CHECK (canal IN ('push','email')),
      status TEXT NOT NULL,
      detalhe TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (atendimento_id, canal)
    );
    CREATE INDEX IF NOT EXISTS idx_pagamento_recuperacao_eventos_atendimento
      ON pagamento_recuperacao_eventos(atendimento_id);
  `);
  const { rows } = await pool.query('SELECT ativado_em FROM pagamento_recuperacao_config WHERE id=1');
  activatedAt = rows[0]?.ativado_em || new Date();
  schemaReady = true;
  console.log('[PAYMENT-RECOVERY] Schema pronto; ativação:', activatedAt);
}

function identityMatchSql(alias = 'x') {
  return `(
    (regexp_replace(COALESCE(${alias}.cpf,''), '\\D', '', 'g') <> ''
      AND regexp_replace(COALESCE(${alias}.cpf,''), '\\D', '', 'g') = regexp_replace(COALESCE(f.cpf,''), '\\D', '', 'g'))
    OR
    (RIGHT(regexp_replace(COALESCE(${alias}.tel,''), '\\D', '', 'g'), 11) = RIGHT(regexp_replace(COALESCE(f.tel,''), '\\D', '', 'g'), 11)
      AND lower(trim(COALESCE(${alias}.nome,''))) = lower(trim(COALESCE(f.nome,''))))
  )`;
}

async function candidates(minutes, canal) {
  const { rows } = await pool.query(`
    SELECT f.id,f.nome,f.tel,f.cpf,f.pagador_cpf,f.email,f.pagador_email,
           f.criado_em,f.pagbank_order_id,f.pagbank_qr_text,f.efi_charge_id
      FROM fila_atendimentos f
     WHERE f.pagamento_status = 'pendente'
       AND COALESCE(f.status,'') NOT IN ('cancelado','expirado','arquivado')
       AND f.criado_em >= $1::timestamptz
       AND f.criado_em >= NOW() - ($2::text || ' hours')::interval
       AND f.criado_em <= NOW() - ($3::text || ' minutes')::interval
       AND (
         NULLIF(btrim(COALESCE(f.pagbank_order_id,'')), '') IS NOT NULL
         OR NULLIF(btrim(COALESCE(f.pagbank_qr_text,'')), '') IS NOT NULL
         OR NULLIF(btrim(COALESCE(f.efi_charge_id,'')), '') IS NOT NULL
       )
       AND NOT EXISTS (
         SELECT 1 FROM pagamento_recuperacao_eventos e
          WHERE e.atendimento_id=f.id AND e.canal=$4
       )
       AND NOT EXISTS (
         SELECT 1
           FROM fila_atendimentos x
          WHERE x.id <> f.id
            AND x.pagamento_status='confirmado'
            AND COALESCE(x.pagamento_confirmado_em, x.criado_em AT TIME ZONE 'UTC') > (f.criado_em AT TIME ZONE 'UTC')
            AND ${identityMatchSql('x')}
       )
     ORDER BY f.criado_em ASC
     LIMIT 30
  `, [activatedAt, LOOKBACK_HOURS, minutes, canal]);
  return rows;
}

async function record(atendimentoId, canal, status, detalhe = null) {
  await pool.query(`
    INSERT INTO pagamento_recuperacao_eventos (atendimento_id,canal,status,detalhe)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (atendimento_id,canal) DO NOTHING
  `, [atendimentoId, canal, status, detalhe ? String(detalhe).slice(0, 500) : null]);
}

async function patientIdForAttendance(row) {
  const phone = normalizePhone(row.tel);
  const cpf = normalizeCpf(row.cpf);
  const payerCpf = normalizeCpf(row.pagador_cpf);
  if (phone.length < 10 || (!cpf && !payerCpf)) return null;
  const { rows } = await pool.query(`
    SELECT id
      FROM pacientes
     WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11)=$1
       AND (
         ($2<>'' AND regexp_replace(COALESCE(cpf,''), '\\D', '', 'g')=$2)
         OR ($3<>'' AND regexp_replace(COALESCE(cpf,''), '\\D', '', 'g')=$3)
       )
     ORDER BY id DESC
     LIMIT 1
  `, [phone, cpf, payerCpf]);
  return rows[0]?.id ? Number(rows[0].id) : null;
}

async function sendExpoPush(patientId, atendimentoId) {
  const { rows: tokens } = await pool.query(`
    SELECT id,expo_push_token FROM paciente_push_tokens
     WHERE paciente_id=$1 AND ativo=TRUE
     ORDER BY atualizado_em DESC
  `, [patientId]);
  if (!tokens.length) return { sent: 0, reason: 'sem_token' };

  const messages = tokens.map((t) => ({
    to: t.expo_push_token,
    sound: 'default',
    title: 'Pagamento não concluído',
    body: 'Seu atendimento pode ser retomado. Toque para continuar com segurança.',
    data: { kind: 'payment_recovery', atendimentoId: Number(atendimentoId), url: `${SITE_URL}/consulta/` },
    priority: 'high',
  }));
  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(messages),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return { sent: 0, reason: `expo_${response.status}` };

  const tickets = Array.isArray(payload?.data) ? payload.data : [];
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const ticket = tickets[i];
    if (ticket?.status === 'ok') sent += 1;
    if (ticket?.details?.error === 'DeviceNotRegistered') {
      await pool.query('UPDATE paciente_push_tokens SET ativo=FALSE, atualizado_em=NOW() WHERE id=$1', [tokens[i].id]).catch(() => {});
    }
  }
  return { sent, reason: sent ? 'enviado' : 'expo_sem_ticket_ok' };
}

function emailHtml() {
  return `<!doctype html><html><body style="margin:0;background:#07100f;font-family:Arial,sans-serif;color:#14201d"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07100f;padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;overflow:hidden"><tr><td style="padding:28px"><div style="font-size:22px;font-weight:700;margin-bottom:18px">Consulta<span style="color:#16c783">Já</span><span style="color:#6b7280">24h</span></div><h1 style="font-size:20px;margin:0 0 12px">Seu atendimento ainda pode ser retomado</h1><p style="font-size:15px;line-height:1.6;color:#4b5563;margin:0 0 22px">Seu pagamento não foi concluído. Você pode voltar ao atendimento e escolher novamente a forma de pagamento.</p><a href="${SITE_URL}/consulta/" style="display:inline-block;background:#16c783;color:#07100f;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">Retomar pagamento</a><p style="font-size:12px;line-height:1.5;color:#8a97a6;margin:24px 0 0">Por segurança, esta mensagem não contém informações clínicas. Se você já concluiu o pagamento, desconsidere.</p></td></tr></table></td></tr></table></body></html>`;
}

async function sendResend(to) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return { sent: false, reason: 'resend_nao_configurado' };
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: 'Seu atendimento ainda pode ser retomado',
      html: emailHtml(),
      text: `Seu pagamento não foi concluído. Retome com segurança em ${SITE_URL}/consulta/. Se você já concluiu o pagamento, desconsidere.`,
      tags: [{ name: 'tipo', value: 'pagamento_recuperacao' }],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  return response.ok && payload?.id
    ? { sent: true, reason: 'enviado' }
    : { sent: false, reason: `resend_${response.status}:${JSON.stringify(payload).slice(0, 180)}` };
}

async function processPush() {
  const rows = await candidates(PUSH_AFTER_MINUTES, 'push');
  for (const row of rows) {
    const patientId = await patientIdForAttendance(row);
    if (!patientId) {
      await record(row.id, 'push', 'ignorado', 'paciente_sem_conta_compativel');
      continue;
    }
    const result = await sendExpoPush(patientId, row.id).catch((e) => ({ sent: 0, reason: e?.message || 'erro_push' }));
    await record(row.id, 'push', result.sent > 0 ? 'enviado' : 'ignorado', result.reason);
  }
}

async function processEmail() {
  const rows = await candidates(EMAIL_AFTER_MINUTES, 'email');
  for (const row of rows) {
    const email = validEmail(row.pagador_email) || validEmail(row.email);
    if (!email) {
      await record(row.id, 'email', 'ignorado', 'sem_email_valido');
      continue;
    }
    const result = await sendResend(email).catch((e) => ({ sent: false, reason: e?.message || 'erro_email' }));
    if (!result.sent && result.reason === 'resend_nao_configurado') {
      continue;
    }
    await record(row.id, 'email', result.sent ? 'enviado' : 'erro', result.reason);
  }
}

async function runWorker() {
  if (!enabled() || workerBusy) return;
  workerBusy = true;
  try {
    await ensureSchema();
    await processPush();
    await processEmail();
  } catch (error) {
    console.warn('[PAYMENT-RECOVERY]', error?.message || error);
  } finally {
    workerBusy = false;
  }
}

await ensureSchema();
console.log(`[PAYMENT-RECOVERY] ${enabled() ? 'habilitado' : 'desabilitado'}; push=${PUSH_AFTER_MINUTES}m email=${EMAIL_AFTER_MINUTES}m`);
setInterval(runWorker, WORKER_MS).unref?.();
