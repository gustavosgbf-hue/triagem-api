import express from 'express';
import pg from 'pg';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const OTP_TTL_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 6;
const OTP_MAX_SENDS_10_MIN = 4;
const APP_REVIEW_PHONE = '98991344646';
const APP_REVIEW_CODE = '246810';
const JSON_BODY = express.json({ limit: '32kb' });

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

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase().slice(0, 254);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!local || !domain) return '';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, Math.min(8, local.length - visible.length)))}@${domain}`;
}

function hashOtp(code, challengeId) {
  return createHash('sha256').update(`${challengeId}:${code}:${process.env.JWT_SECRET || ''}`).digest('hex');
}

function safeHashEquals(a, b) {
  try {
    const aa = Buffer.from(String(a || ''), 'hex');
    const bb = Buffer.from(String(b || ''), 'hex');
    return aa.length === bb.length && aa.length > 0 && timingSafeEqual(aa, bb);
  } catch {
    return false;
  }
}

async function ensureOtpTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paciente_otp_desafios (
      id UUID PRIMARY KEY,
      telefone TEXT NOT NULL,
      email TEXT NOT NULL,
      cpf TEXT,
      nome TEXT,
      codigo_hash TEXT NOT NULL,
      expira_em TIMESTAMPTZ NOT NULL,
      tentativas INTEGER NOT NULL DEFAULT 0,
      consumido_em TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_paciente_otp_tel ON paciente_otp_desafios(telefone, criado_em DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_paciente_otp_expira ON paciente_otp_desafios(expira_em)`);
}

let tableReady;
function otpTableReady() {
  if (!tableReady) tableReady = ensureOtpTable().catch((error) => {
    tableReady = null;
    throw error;
  });
  return tableReady;
}

async function cleanupExpiredChallenges() {
  await pool.query(`DELETE FROM paciente_otp_desafios WHERE expira_em < NOW() - INTERVAL '1 day'`).catch(() => {});
}

async function assertSendRate(phone) {
  await otpTableReady();
  const result = await pool.query(
    `SELECT COUNT(*)::int AS total
       FROM paciente_otp_desafios
      WHERE telefone=$1
        AND criado_em > NOW() - INTERVAL '10 minutes'`,
    [phone],
  );
  if (Number(result.rows[0]?.total || 0) >= OTP_MAX_SENDS_10_MIN) {
    const error = new Error('Muitos códigos solicitados. Aguarde alguns minutos e tente novamente.');
    error.statusCode = 429;
    throw error;
  }
}

async function findPatientByPhone(phone) {
  const result = await pool.query(
    `SELECT id, nome, email, cpf, tel
       FROM pacientes
      WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11) = $1
      ORDER BY id DESC
      LIMIT 1`,
    [phone],
  );
  return result.rows[0] || null;
}

async function findHistoryIdentity(phone) {
  const result = await pool.query(
    `SELECT
       NULLIF(TRIM(COALESCE(to_jsonb(f)->>'nome','')), '') AS nome,
       NULLIF(regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g'), '') AS cpf
       FROM fila_atendimentos f
      WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $1
      ORDER BY COALESCE(NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz, NOW()) DESC
      LIMIT 1`,
    [phone],
  );
  return result.rows[0] || null;
}

async function historyHasCpf(phone, cpf) {
  if (!cpf) return false;
  const result = await pool.query(
    `SELECT 1
       FROM fila_atendimentos f
      WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $1
        AND (
          regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $2
          OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $2
        )
      LIMIT 1`,
    [phone, cpf],
  );
  return result.rowCount > 0;
}

async function phoneHasHistory(phone) {
  const result = await pool.query(
    `SELECT 1
       FROM fila_atendimentos f
      WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $1
      LIMIT 1`,
    [phone],
  );
  return result.rowCount > 0;
}

async function sendOtpEmail(email, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY não configurada');

  const from = process.env.RESEND_DEFAULT_FROM || 'ConsultaJá24h <contato@consultaja24h.com.br>';
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `${code} é seu código de acesso | ConsultaJá24h`,
      text: `Seu código de acesso à ConsultaJá24h é ${code}. Ele expira em ${OTP_TTL_MINUTES} minutos. Se você não solicitou este acesso, ignore este e-mail.`,
      html: `<div style="font-family:Arial,sans-serif;background:#07100f;padding:32px 18px;color:#14201d"><div style="max-width:520px;margin:auto;background:#fff;border-radius:18px;padding:28px"><div style="font-size:14px;font-weight:700;color:#16c783;margin-bottom:12px">ConsultaJá24h</div><h1 style="font-size:22px;margin:0 0 10px">Seu código de acesso</h1><div style="font-size:34px;font-weight:800;letter-spacing:8px;margin:22px 0;color:#07100f">${code}</div><p style="color:#4b5563;line-height:1.5">Digite este código no app. Ele expira em ${OTP_TTL_MINUTES} minutos.</p><p style="color:#8a97a6;font-size:12px;margin-top:24px">Se você não solicitou este acesso, ignore este e-mail.</p></div></div>`,
      tags: [{ name: 'tipo', value: 'otp_paciente' }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.id) {
    throw new Error(data?.message || data?.error || `Falha ao enviar e-mail (${response.status})`);
  }
}

async function createChallenge({ phone, email, cpf = '', name = '' }) {
  await otpTableReady();
  await assertSendRate(phone);
  cleanupExpiredChallenges();

  const id = randomUUID();
  const isAppReview = normalizePhone(phone) === APP_REVIEW_PHONE;
  const code = isAppReview
    ? APP_REVIEW_CODE
    : String(randomInt(0, 1_000_000)).padStart(6, '0');
  const codeHash = hashOtp(code, id);

  await pool.query(
    `INSERT INTO paciente_otp_desafios
      (id, telefone, email, cpf, nome, codigo_hash, expira_em)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() + ($7 || ' minutes')::interval)`,
    [id, phone, email, cpf || null, name || null, codeHash, String(OTP_TTL_MINUTES)],
  );

  if (isAppReview) {
    console.log('[PACIENTE-OTP] App Review challenge criado com código fixo para a conta dedicada.');
    return id;
  }

  try {
    await sendOtpEmail(email, code);
  } catch (error) {
    await pool.query(`DELETE FROM paciente_otp_desafios WHERE id=$1`, [id]).catch(() => {});
    throw error;
  }

  return id;
}

async function ensurePatient({ phone, email, cpf, name }) {
  let patient = await findPatientByPhone(phone);
  if (patient) return patient;

  const byEmail = await pool.query(
    `SELECT id, nome, email, cpf, tel FROM pacientes WHERE LOWER(email)=LOWER($1) LIMIT 1`,
    [email],
  );
  if (byEmail.rows[0]) {
    patient = byEmail.rows[0];
    await pool.query(
      `UPDATE pacientes
          SET tel = COALESCE(NULLIF(tel,''), $2),
              cpf = COALESCE(NULLIF(cpf,''), NULLIF($3,'')),
              nome = CASE WHEN NULLIF(TRIM(nome),'') IS NULL THEN $4 ELSE nome END
        WHERE id=$1`,
      [patient.id, phone, cpf || '', name || 'Paciente'],
    );
    const refreshed = await pool.query(`SELECT id,nome,email,cpf,tel FROM pacientes WHERE id=$1`, [patient.id]);
    return refreshed.rows[0];
  }

  const randomPassword = randomUUID() + randomUUID();
  const passwordHash = await bcrypt.hash(randomPassword, 10);
  const inserted = await pool.query(
    `INSERT INTO pacientes (nome,email,senha_hash,cpf,tel)
     VALUES ($1,$2,$3,NULLIF($4,''),$5)
     RETURNING id,nome,email,cpf,tel`,
    [name || 'Paciente', email, passwordHash, cpf || '', phone],
  );
  return inserted.rows[0];
}

function installMobileOtpRoutes(app) {
  if (app.locals.__mobileOtpInstalled) return;
  app.locals.__mobileOtpInstalled = true;

  app.post('/api/paciente/otp/solicitar', JSON_BODY, async (req, res) => {
    try {
      const phone = normalizePhone(req.body?.telefone);
      const suppliedEmail = normalizeEmail(req.body?.email);
      const suppliedCpf = normalizeCpf(req.body?.cpf);

      if (phone.length < 10) return res.status(400).json({ ok: false, error: 'Celular inválido' });

      const patient = await findPatientByPhone(phone);
      if (patient?.email) {
        const challengeId = await createChallenge({
          phone,
          email: normalizeEmail(patient.email),
          cpf: normalizeCpf(patient.cpf),
          name: patient.nome || '',
        });
        return res.json({ ok: true, challenge_id: challengeId, email_mascarado: maskEmail(patient.email) });
      }

      const hasHistory = await phoneHasHistory(phone);
      if (!suppliedEmail || !suppliedCpf) {
        return res.json({ ok: true, precisa_dados: true, precisa_cpf: hasHistory });
      }
      if (!validEmail(suppliedEmail)) return res.status(400).json({ ok: false, error: 'E-mail inválido' });
      if (suppliedCpf.length !== 11) return res.status(400).json({ ok: false, error: 'CPF inválido' });

      if (hasHistory && !(await historyHasCpf(phone, suppliedCpf))) {
        return res.status(403).json({ ok: false, error: 'O CPF não confere com os dados dos atendimentos vinculados a este celular.' });
      }

      const history = await findHistoryIdentity(phone);
      const challengeId = await createChallenge({
        phone,
        email: suppliedEmail,
        cpf: suppliedCpf,
        name: history?.nome || '',
      });
      return res.json({ ok: true, challenge_id: challengeId, email_mascarado: maskEmail(suppliedEmail) });
    } catch (error) {
      console.error('[PACIENTE-OTP] solicitar:', error);
      const status = Number(error?.statusCode) || 500;
      return res.status(status).json({
        ok: false,
        error: status === 429 ? error.message : 'Não foi possível enviar o código agora. Tente novamente.',
      });
    }
  });

  app.post('/api/paciente/otp/verificar', JSON_BODY, async (req, res) => {
    try {
      await otpTableReady();
      const challengeId = String(req.body?.challenge_id || '').trim();
      const code = digits(req.body?.codigo).slice(0, 6);
      if (!challengeId || code.length !== 6) {
        return res.status(400).json({ ok: false, error: 'Código inválido' });
      }

      const result = await pool.query(
        `SELECT * FROM paciente_otp_desafios WHERE id=$1 LIMIT 1`,
        [challengeId],
      );
      const challenge = result.rows[0];
      if (!challenge || challenge.consumido_em || new Date(challenge.expira_em).getTime() < Date.now()) {
        return res.status(401).json({ ok: false, error: 'Código expirado. Solicite um novo.' });
      }
      if (Number(challenge.tentativas || 0) >= OTP_MAX_ATTEMPTS) {
        return res.status(429).json({ ok: false, error: 'Muitas tentativas. Solicite um novo código.' });
      }

      const received = hashOtp(code, challengeId);
      if (!safeHashEquals(challenge.codigo_hash, received)) {
        await pool.query(`UPDATE paciente_otp_desafios SET tentativas=tentativas+1 WHERE id=$1`, [challengeId]);
        return res.status(401).json({ ok: false, error: 'Código incorreto' });
      }

      const patient = await ensurePatient({
        phone: challenge.telefone,
        email: challenge.email,
        cpf: normalizeCpf(challenge.cpf),
        name: challenge.nome || 'Paciente',
      });

      await pool.query(`UPDATE paciente_otp_desafios SET consumido_em=NOW() WHERE id=$1`, [challengeId]);

      const secret = process.env.JWT_SECRET;
      if (!secret) throw new Error('JWT_SECRET não configurada');
      const token = jwt.sign({ id: patient.id, tipo: 'paciente' }, secret, { expiresIn: '30d' });
      return res.json({ ok: true, token, paciente: patient });
    } catch (error) {
      console.error('[PACIENTE-OTP] verificar:', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível validar o código agora. Tente novamente.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installMobileOtpRoutes(this);
  return result;
};
