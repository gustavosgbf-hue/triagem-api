import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://consultaja24h.com.br').replace(/\/$/, '');
const API_URL = String(process.env.API_URL || 'https://triagem-api.onrender.com').replace(/\/$/, '');
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
    CREATE TABLE IF NOT EXISTS pagamento_recuperacao_optout (email_hash TEXT PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW());
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

function htmlEscape(v) { return String(v || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function emailHash(email) { return crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex'); }
function unsubscribeToken(email) {
  const payload = `${emailHash(email)}.${Math.floor(Date.now()/1000)+90*86400}`;
  const sig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function validateUnsubscribeToken(token) {
  if (!process.env.JWT_SECRET) return null;
  const [hash, exp, sig, extra] = String(token || '').split('.');
  if (extra || !/^[a-f0-9]{64}$/.test(hash || '') || !/^\d{10,11}$/.test(exp || '') || Number(exp)<Date.now()/1000 || !/^[a-f0-9]{64}$/.test(sig || '')) return null;
  const expected=crypto.createHmac('sha256',process.env.JWT_SECRET).update(`${hash}.${exp}`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected,'hex'), Buffer.from(sig,'hex')) ? hash : null;
}
const originalRecoveryInit = express.application.init;
express.application.init = function (...args) {
  const result = originalRecoveryInit.apply(this,args);
  this.get('/api/payment-recovery/unsubscribe', (req,res) => {
    if (!validateUnsubscribeToken(req.query.token)) return res.status(400).send('Este link expirou ou não é válido.');
    res.set('Cache-Control','no-store').type('html').send(`<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><body style="background:#07100f;color:#fff;font:16px Arial;padding:12vh 20px;text-align:center"><h2>Consulta<span style="color:#16c783">Já</span>24h</h2><p>Deseja deixar de receber lembretes de pagamentos não concluídos?</p><form method="POST" action="/api/payment-recovery/unsubscribe?token=${encodeURIComponent(req.query.token)}"><button style="background:#16c783;border:0;border-radius:12px;padding:15px 24px;font-weight:bold">Cancelar estes lembretes</button></form></body></html>`);
  });
  this.post('/api/payment-recovery/unsubscribe', async (req,res) => {
    const hash=validateUnsubscribeToken(req.query.token);
    if (!hash) return res.status(400).send('Link inválido ou expirado.');
    try { await pool.query('INSERT INTO pagamento_recuperacao_optout(email_hash) VALUES($1) ON CONFLICT DO NOTHING',[hash]); return res.type('html').send('<html lang="pt-BR"><body style="font:16px Arial;padding:60px;text-align:center"><h2>Inscrição cancelada</h2><p>Você não receberá novos lembretes de pagamento da ConsultaJá24h neste e-mail.</p></body></html>'); }
    catch(e) { return res.status(503).send('Não foi possível concluir agora. Tente novamente.'); }
  });
  return result;
};
function emailContent(firstName, unsubscribeUrl) {
  const greeting=firstName ? `Olá, ${htmlEscape(firstName)}!` : 'Olá!';
  const url=`${SITE_URL}/consulta/`;
  const subject='Sua consulta pode continuar de onde parou';
  const html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#07100f;font-family:Arial,sans-serif;color:#14201d"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07100f"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:18px;overflow:hidden"><tr><td align="center" style="background:#0b211a;padding:32px 24px"><span style="font:bold italic 29px Georgia,serif;color:#f4f3e9">Consulta</span><span style="font:bold italic 29px Georgia,serif;color:#78f25f">Já</span><span style="font:14px Arial;color:#a0ada7">24h</span><p style="color:#b5c9be;font-size:12px;margin:12px 0 0">Atendimento médico online, no seu tempo.</p></td></tr><tr><td style="padding:34px 30px"><p style="color:#65736d;margin:0 0 16px;font-size:15px">${greeting}</p><h1 style="color:#14201d;font-size:26px;line-height:1.25;margin:0 0 20px">Sua consulta pode continuar de onde parou.</h1><p style="color:#4b5563;font-size:15px;line-height:1.7">Você iniciou um atendimento na ConsultaJá24h, mas o pagamento ainda não foi confirmado.</p><p style="color:#4b5563;font-size:15px;line-height:1.7;margin-bottom:28px">Se ainda precisar de atendimento, estamos à disposição para ajudar.</p><table role="presentation" width="100%"><tr><td align="center" bgcolor="#16c783" style="border-radius:12px"><a href="${url}" style="display:block;padding:17px;color:#07100f;text-decoration:none;font:bold 16px Arial">Continuar minha consulta</a></td></tr></table><p style="color:#718077;font-size:12px;text-align:center">Se possível, volte pelo mesmo dispositivo.</p><p style="border-top:1px solid #e8ede9;padding-top:20px;margin-top:25px;color:#66736e;font-size:13px">Precisa de ajuda? <a href="mailto:contato@consultaja24h.com.br" style="color:#0b8f61">Fale com o suporte</a>.</p></td></tr><tr><td style="background:#f7fbf8;text-align:center;padding:24px 22px"><p style="color:#314439;font-size:13px;font-weight:bold">ConsultaJá24h</p><p style="color:#8a97a6;font-size:11px;line-height:1.5">Este lembrete não contém informações clínicas. Se você já pagou, desconsidere.</p><a href="${unsubscribeUrl}" style="font:12px Arial;color:#678177;text-decoration:underline">Não quero receber estes lembretes</a></td></tr></table><p style="color:#8ca19a;font-size:11px;text-align:center">ConsultaJá24h · São Luís, MA · Brasil</p></td></tr></table></body></html>`;
  const text=`${firstName ? `Olá, ${firstName}!` : 'Olá!'}\n\nSua consulta pode continuar de onde parou. Você iniciou um atendimento na ConsultaJá24h, mas o pagamento ainda não foi confirmado.\n\nContinuar: ${url}\nSuporte: contato@consultaja24h.com.br\nCancelar lembretes: ${unsubscribeUrl}`;
  return {subject, html, text};
}
async function sendResend(to, firstName='') {
  const apiKey=String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) return {sent:false,reason:'resend_nao_configurado'};
  if (!process.env.JWT_SECRET) return {sent:false,reason:'chave_descadastro_nao_configurada'};
  const unsubscribeUrl=`${API_URL}/api/payment-recovery/unsubscribe?token=${unsubscribeToken(to)}`;
  const content=emailContent(firstName, unsubscribeUrl);
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify({from:RESEND_FROM,to:[to],...content,headers:{'List-Unsubscribe':`<${unsubscribeUrl}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'},tags:[{name:'tipo',value:'pagamento_recuperacao'}]})});
  const payload=await response.json().catch(()=>({}));
  return response.ok && payload?.id ? {sent:true,reason:'enviado'} : {sent:false,reason:`resend_${response.status}:${JSON.stringify(payload).slice(0,180)}`};
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
    const optout=await pool.query('SELECT 1 FROM pagamento_recuperacao_optout WHERE email_hash=$1',[emailHash(email)]);
    if(optout.rowCount){await record(row.id,'email','ignorado','descadastrado');continue;}
    const firstName=(email===validEmail(row.email) && String(row.nome||'').trim().split(/\s+/).length>=2) ? String(row.nome).trim().split(/\s+/)[0] : '';
    const result = await sendResend(email,firstName).catch((e) => ({ sent: false, reason: e?.message || 'erro_email' }));
    if (!result.sent && ['resend_nao_configurado','chave_descadastro_nao_configurada'].includes(result.reason)) {
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
