import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function digits(value) { return String(value || '').replace(/\D/g, ''); }
function normalizePhone(value) {
  let n = digits(value);
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  return n.slice(-11);
}
function normalizeCpf(value) { return digits(value).slice(0, 11); }

function authPaciente(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '');
    if (decoded?.tipo !== 'paciente' || !decoded?.id) return res.status(401).json({ ok: false, error: 'Token inválido' });
    req.pacienteId = Number(decoded.id);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
}

async function atendimentoDoPaciente(pacienteId, atendimentoId) {
  const pacienteResult = await pool.query('SELECT cpf,tel FROM pacientes WHERE id=$1 LIMIT 1', [pacienteId]);
  const paciente = pacienteResult.rows[0];
  if (!paciente) return null;
  const cpf = normalizeCpf(paciente.cpf);
  const phone = normalizePhone(paciente.tel);
  const result = await pool.query(
    `SELECT f.* FROM fila_atendimentos f
      WHERE f.id=$1
        AND (regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g')=$2
          OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g')=$2)
        AND RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'),11)=$3
      LIMIT 1`,
    [atendimentoId, cpf, phone],
  );
  return result.rows[0] || null;
}

function nomeSeguro(nome, fallback) {
  const limpo = String(nome || '').trim().replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 120);
  return limpo || fallback;
}

function extensao(nome, mime) {
  const original = String(nome || '');
  const match = original.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (match) return match[1].toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (String(mime).startsWith('audio/')) return 'm4a';
  if (String(mime).startsWith('image/')) return 'jpg';
  return 'bin';
}

function tipoArquivo(mime) {
  const value = String(mime || '').toLowerCase();
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('image/')) return 'imagem';
  if (value === 'application/pdf') return 'pdf';
  return 'arquivo';
}

function mimePermitido(mime) {
  const value = String(mime || '').toLowerCase();
  return value === 'application/pdf' || value.startsWith('image/') || value.startsWith('audio/');
}

function installPatientChatUpload(app) {
  if (app.locals.__patientChatUploadInstalled) return;
  app.locals.__patientChatUploadInstalled = true;

  app.post('/api/paciente/atendimento/:id/upload-v2', authPaciente, upload.single('arquivo'), async (req, res) => {
    try {
      const atendimentoId = Number(req.params.id);
      if (!atendimentoId || !req.file) return res.status(400).json({ ok: false, error: 'Arquivo não informado.' });
      if (!mimePermitido(req.file.mimetype)) return res.status(400).json({ ok: false, error: 'Tipo de arquivo não permitido.' });

      const atendimento = await atendimentoDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado.' });
      if (String(atendimento.status || '').toLowerCase() !== 'assumido' || !atendimento.medico_id) {
        return res.status(409).json({ ok: false, error: 'Este atendimento não está disponível para novos anexos.' });
      }

      await pool.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS reply_to_id BIGINT`);
      const replyToId = req.body?.reply_to_id ? Number(req.body.reply_to_id) : null;
      if (replyToId) {
        const alvo = await pool.query('SELECT id FROM mensagens WHERE id=$1 AND atendimento_id=$2 LIMIT 1', [replyToId, atendimentoId]);
        if (!alvo.rowCount) return res.status(400).json({ ok: false, error: 'Mensagem respondida não encontrada.' });
      }

      const tipo = tipoArquivo(req.file.mimetype);
      const ext = extensao(req.file.originalname, req.file.mimetype);
      const fallback = tipo === 'audio' ? `Audio_${Date.now()}.${ext}` : `Anexo_${Date.now()}.${ext}`;
      const arquivoNome = nomeSeguro(req.file.originalname, fallback);
      const key = `chat/paciente/${atendimentoId}/${Date.now()}-${randomUUID()}.${ext}`;

      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || 'application/octet-stream',
        ContentDisposition: `inline; filename="${arquivoNome.replace(/"/g, '')}"`,
      }));

      const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (!publicBase) throw new Error('R2_PUBLIC_URL não configurada');
      const arquivoUrl = `${publicBase}/${key}`;

      const result = await pool.query(
        `INSERT INTO mensagens
          (atendimento_id, autor, autor_id, texto, arquivo_url, arquivo_tipo, arquivo_nome, reply_to_id)
         VALUES ($1, 'paciente', $2, '', $3, $4, $5, $6)
         RETURNING id, atendimento_id, autor, texto, arquivo_url, arquivo_tipo, arquivo_nome, criado_em, reply_to_id`,
        [atendimentoId, req.pacienteId, arquivoUrl, tipo, arquivoNome, replyToId],
      );
      return res.json({ ok: true, mensagem: result.rows[0] });
    } catch (error) {
      console.error('[CHAT-UPLOAD-V2]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível enviar o anexo.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedPatientChatUploadInit(...args) {
  const result = originalInit.apply(this, args);
  installPatientChatUpload(this);
  return result;
};
