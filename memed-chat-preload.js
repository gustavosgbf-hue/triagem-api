import express from 'express';
import cors from 'cors';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const MEMED_API_URL = process.env.MEMED_API_URL || 'https://api.memed.com.br/v1';
const MEMED_API_KEY = process.env.MEMED_API_KEY || '';
const MEMED_SECRET_KEY = process.env.MEMED_SECRET_KEY || '';
const panelCors = cors({
  origin: [
    'https://painel.consultaja24h.com.br',
    'https://consultaja24h.com.br',
    'https://www.consultaja24h.com.br',
    /^https:\/\/.*\.pages\.dev$/,
  ],
  credentials: true,
});

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function authMedico(req, res, next) {
  try {
    const raw = String(req.headers.authorization || '');
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ ok: false, error: 'Token não fornecido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '');
    if (!decoded?.id || decoded?.tipo === 'paciente') {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }
    req.medicoId = Number(decoded.id);
    req.tipoProfissional = decoded.tipo === 'especialista' ? 'especialista' : 'medico';
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
}

function encontrarUrl(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^https:\/\//i.test(text)) return text;
    const match = text.match(/https:\/\/[^\s"']+/i);
    return match ? match[0] : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = encontrarUrl(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value === 'object') {
    const preferred = ['url', 'document_url', 'documentUrl', 'link', 'href'];
    for (const key of preferred) {
      if (key in value) {
        const found = encontrarUrl(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const item of Object.values(value)) {
      const found = encontrarUrl(item, depth + 1);
      if (found) return found;
    }
  }
  return '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function tokenMemedMedico(medicoId) {
  const { rows } = await pool.query(
    `SELECT id, memed_external_id
       FROM medicos
      WHERE id=$1
        AND COALESCE(to_jsonb(medicos)->>'ativo','true') <> 'false'
      LIMIT 1`,
    [medicoId],
  );
  const medico = rows[0];
  if (!medico) throw new Error('Médico não encontrado ou inativo');
  if (!MEMED_API_KEY || !MEMED_SECRET_KEY) throw new Error('Integração Memed não configurada');

  const externalId = medico.memed_external_id || `consultaja-${medico.id}`;
  const url = `${MEMED_API_URL}/sinapse-prescricao/usuarios/${encodeURIComponent(externalId)}?api-key=${encodeURIComponent(MEMED_API_KEY)}&secret-key=${encodeURIComponent(MEMED_SECRET_KEY)}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/json' },
  });
  const data = await response.json().catch(() => ({}));
  const token = data?.data?.attributes?.token;
  if (!response.ok || !token) throw new Error('Não foi possível obter o token da Memed');
  return token;
}

async function urlPdfMemed(prescriptionId, token) {
  // A Memed pode disparar prescricaoImpressa antes do PDF final estar disponível.
  // Mantemos a busca por até ~37s; o painel ainda possui retries externos.
  const waits = [0, 2000, 5000, 10000, 20000];
  let lastStatus = 0;
  for (const wait of waits) {
    if (wait) await sleep(wait);
    const url = `${MEMED_API_URL}/prescricoes/${encodeURIComponent(String(prescriptionId))}/url-document/full?token=${encodeURIComponent(token)}`;
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.api+json', 'Content-Type': 'application/json' },
    });
    lastStatus = response.status;
    const raw = await response.text().catch(() => '');
    let data = raw;
    try { data = JSON.parse(raw); } catch {}
    const pdfUrl = encontrarUrl(data);
    if (response.ok && pdfUrl) return pdfUrl;
    if (response.status >= 400 && response.status < 500 && response.status !== 404 && response.status !== 409 && response.status !== 425) break;
  }
  throw new Error(`PDF da Memed ainda não disponível (${lastStatus || 'sem resposta'})`);
}

async function baixarPdf(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Falha ao baixar PDF da Memed (${response.status})`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('PDF da Memed vazio');
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('pdf') && buffer.subarray(0, 4).toString() !== '%PDF') {
    throw new Error('Documento retornado pela Memed não é PDF');
  }
  return buffer;
}

function nomeDocumentoMedico() {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Fortaleza',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date()).reduce((acc, parte) => {
    acc[parte.type] = parte.value;
    return acc;
  }, {});
  return `Documento_Medico_${partes.day}-${partes.month}-${partes.year}_${partes.hour}-${partes.minute}-${partes.second}.pdf`;
}

function installMemedChatRoutes(app) {
  if (app.locals.__memedChatInstalled) return;
  app.locals.__memedChatInstalled = true;

  app.options('/api/memed/prescricao-chat', panelCors);
  app.post('/api/memed/prescricao-chat', panelCors, express.json({ limit: '64kb' }), authMedico, async (req, res) => {
    try {
      if (req.tipoProfissional !== 'medico') {
        return res.status(409).json({ ok: false, error: 'Envio automático disponível inicialmente no painel médico.' });
      }

      const atendimentoId = Number(req.body?.atendimentoId);
      const prescriptionId = String(req.body?.prescriptionId || '').trim().slice(0, 120);
      if (!atendimentoId || !prescriptionId) {
        return res.status(400).json({ ok: false, error: 'Atendimento e prescrição são obrigatórios.' });
      }

      const { rows: atendimentoRows } = await pool.query(
        `SELECT id, medico_id
           FROM fila_atendimentos
          WHERE id=$1
          LIMIT 1`,
        [atendimentoId],
      );
      const atendimento = atendimentoRows[0];
      if (!atendimento || Number(atendimento.medico_id) !== Number(req.medicoId)) {
        return res.status(403).json({ ok: false, error: 'Este atendimento não pertence ao médico autenticado.' });
      }

      const safePrescriptionId = prescriptionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
      if (!safePrescriptionId) return res.status(400).json({ ok: false, error: 'Identificador de prescrição inválido.' });

      const { rows: existingRows } = await pool.query(
        `SELECT id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,arquivo_nome,criado_em
           FROM mensagens
          WHERE atendimento_id=$1
            AND autor='medico'
            AND arquivo_tipo='pdf'
            AND arquivo_url LIKE '%/chat/memed/%'
            AND arquivo_url LIKE $2
          ORDER BY id DESC
          LIMIT 1`,
        [atendimentoId, `%/${safePrescriptionId}-%`],
      );
      if (existingRows[0]) {
        return res.json({ ok: true, reutilizado: true, mensagem: existingRows[0] });
      }

      const arquivoNome = nomeDocumentoMedico();
      const token = await tokenMemedMedico(req.medicoId);
      const remotePdfUrl = await urlPdfMemed(safePrescriptionId, token);
      const pdf = await baixarPdf(remotePdfUrl);

      const key = `chat/memed/${atendimentoId}/${safePrescriptionId}-${randomUUID()}.pdf`;
      await r2.send(new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: pdf,
        ContentType: 'application/pdf',
        ContentDisposition: `inline; filename="${arquivoNome}"`,
      }));
      const publicBase = String(process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
      if (!publicBase) throw new Error('R2_PUBLIC_URL não configurada');
      const arquivoUrl = `${publicBase}/${key}`;

      const { rows } = await pool.query(
        `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto,arquivo_url,arquivo_tipo,arquivo_nome)
         VALUES ($1,'medico',$2,'',$3,'pdf',$4)
         RETURNING id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,arquivo_nome,criado_em`,
        [atendimentoId, req.medicoId, arquivoUrl, arquivoNome],
      );

      console.log(`[MEMED-CHAT] Documento ${safePrescriptionId} enviado ao atendimento #${atendimentoId}`);
      return res.json({ ok: true, reutilizado: false, mensagem: rows[0] });
    } catch (error) {
      console.error('[MEMED-CHAT]', error?.message || error);
      return res.status(502).json({ ok: false, error: error?.message || 'Não foi possível enviar o documento ao chat.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installMemedChatRoutes(this);
  return result;
};
