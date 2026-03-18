import express from "express";
import cors from "cors";
import { google } from "googleapis";
import pg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.use(cors({
  origin: [
    'https://consultaja24h.com.br',
    'https://www.consultaja24h.com.br',
    'https://painel.consultaja24h.com.br',
    'https://triagem-api.onrender.com',
  ],
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const rlLogin = rateLimit({ windowMs: 60*1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas tentativas de login. Tente novamente em 1 minuto." }});
const rlMensagem = rateLimit({ windowMs: 60*1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Limite de mensagens atingido." }});
const rlUpload = rateLimit({ windowMs: 60*1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Limite de uploads atingido." }});
const rlTriagem = rateLimit({ windowMs: 60*1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas requisições de triagem. Aguarde." }});
const rlGeral = rateLimit({ windowMs: 60*1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas requisições. Aguarde." }});

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY nao definida"); process.exit(1); }
if (!JWT_SECRET) { console.error("JWT_SECRET nao definida"); process.exit(1); }

// LIMPEZA AUTOMATICA -- atendimentos travados em 'assumido' por mais de 48h
setInterval(async () => {
  try {
    const lock1 = await pool.query('SELECT pg_try_advisory_lock(10001)');
    if (!lock1.rows[0].pg_try_advisory_lock) return; // outra instância já está rodando
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'expirado', encerrado_em = NOW()
       WHERE status = 'assumido'
         AND assumido_em < NOW() - INTERVAL '48 hours'
       RETURNING id, nome`
    );
    if (result.rowCount > 0) {
      console.log("[LIMPEZA] " + result.rowCount + " atendimento(s) expirado(s):",
        result.rows.map(function(r){ return "#" + r.id + " " + r.nome; }).join(", "));
    }
  } catch(e) {
    console.error("[LIMPEZA] Erro:", e.message);
  }
}, 60 * 60 * 1000);

// JOB: Reenviar e-mail de agendamento 1h antes do horário marcado
setInterval(async () => {
  try {
    const lock2 = await pool.query('SELECT pg_try_advisory_lock(10002)');
    if (!lock2.rows[0].pg_try_advisory_lock) return;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return;
    // Agendamentos confirmados com horário entre 55min e 65min a partir de agora
    const result = await pool.query(
      `SELECT ag.*, fa.id AS fila_id, fa.triagem, fa.status AS fila_status
       FROM agendamentos ag
       LEFT JOIN fila_atendimentos fa ON fa.tel=ag.tel AND fa.status IN ('aguardando','triagem')
       WHERE ag.status='confirmado'
         AND ag.horario_agendado BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'
         AND ag.lembrete_enviado IS NOT DISTINCT FROM false`
    );
    for (const ag of result.rows) {
      if (!ag.fila_id) { console.log(`[LEMBRETE] Agendamento #${ag.id} sem fila ainda, pulando`); continue; }
      const API_URL = process.env.API_URL || "https://triagem-api.onrender.com";
      const PAINEL_URL = "https://painel.consultaja24h.com.br";
      const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
      const horarioFormatado = new Date(ag.horario_agendado).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
      const tipoLabel = ag.modalidade === "video" ? "Video" : "Chat";
      const linkRetorno = `${SITE_URL}/triagem.html?consulta=${ag.fila_id}`;
      // Busca médicos e envia e-mail com novo token válido por 3h
      const medicosResult = await pool.query(`SELECT id,nome,email FROM medicos WHERE ativo=true AND status='aprovado'`);
      const medicos = medicosResult.rows.filter(m=>m.email);
      if (!medicos.find(m=>m.email==="gustavosgbf@gmail.com")) medicos.push({id:0,nome:"Gustavo",email:"gustavosgbf@gmail.com"});
      // Marca ANTES do loop para evitar reprocessamento se job rodar novamente
      await pool.query(`UPDATE agendamentos SET lembrete_enviado=true WHERE id=$1`,[ag.id]);
      for (const med of medicos) {
        // Verifica se atendimento ainda está aguardando antes de cada envio
        const statusCheck = await pool.query(`SELECT status FROM fila_atendimentos WHERE id=$1`,[ag.fila_id]);
        const statusAtual = statusCheck.rows[0]?.status;
        if (statusAtual && !['aguardando','triagem'].includes(statusAtual)) {
          console.log(`[LEMBRETE] Agendamento #${ag.id} já assumido (status: ${statusAtual}) — interrompendo envios`);
          break;
        }
        const token = jwt.sign(
          { medicoId: med.id, medicoNome: med.nome, atendimentoId: ag.fila_id, tipo: "assumir" },
          JWT_SECRET,
          { expiresIn: "3h" }
        );
        const linkAssumir = `${API_URL}/api/atendimento/assumir-email?token=${token}`;
        const html = montarHtmlEmail({ nome: ag.nome, tel: ag.tel, tipo: ag.modalidade, triagem: ag.triagem, linkRetorno, linkAssumir, medicoNome: med.nome, horarioAgendado: horarioFormatado, isLembrete: true });
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "ConsultaJa24h <contato@consultaja24h.com.br>", to: [med.email], subject: `🔔 Lembrete: Agendamento em 1h - ${ag.nome} (${tipoLabel}) - ${horarioFormatado}`, html })
        });
        const resendData = await resendRes.json();
        if (resendData.id) console.log(`[LEMBRETE] Enviado para ${med.email} | Agendamento #${ag.id}`);
        await new Promise(r => setTimeout(r, 600)); // respeita rate limit Resend
      }
      // Lembrete para o paciente também
      if (ag.email && !ag.lembrete_paciente_enviado) {
        const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
        const linkConsulta = ag.fila_id ? `${SITE_URL}/triagem.html?consulta=${ag.fila_id}` : `${SITE_URL}/triagem.html`;
        await enviarEmailLembretePaciente({ nome: ag.nome, email: ag.email, horarioFormatado, modalidade: ag.modalidade, linkConsulta }).catch(()=>{});
        await pool.query(`UPDATE agendamentos SET lembrete_paciente_enviado=true WHERE id=$1`,[ag.id]);
      }
    }
  } catch(e) { console.error("[LEMBRETE] Erro:", e.message); }
}, 10 * 60 * 1000); // Roda a cada 10 minutos

// LIMPEZA AUTOMATICA -- historico: encerrados/expirados com mais de 10 anos viram 'arquivado'
setInterval(async () => {
  try {
    const lock3 = await pool.query('SELECT pg_try_advisory_lock(10003)');
    if (!lock3.rows[0].pg_try_advisory_lock) return;
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'arquivado'
       WHERE status IN ('encerrado', 'expirado')
         AND encerrado_em < NOW() - INTERVAL '10 years'
       RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log("[HISTORICO] " + result.rowCount + " atendimento(s) arquivado(s).");
    }
  } catch(e) {
    console.error("[HISTORICO] Erro:", e.message);
  }
}, 6 * 60 * 60 * 1000);

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS mensagens (
        id SERIAL PRIMARY KEY,
        atendimento_id INTEGER NOT NULL,
        autor TEXT NOT NULL,
        autor_id INTEGER,
        texto TEXT NOT NULL,
        arquivo_url TEXT,
        arquivo_tipo TEXT,
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS arquivo_url TEXT`);
    await pool.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS arquivo_tipo TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS agendamentos (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        tel TEXT NOT NULL,
        tel_documentos TEXT,
        cpf TEXT,
        modalidade TEXT NOT NULL DEFAULT 'chat',
        horario_agendado TIMESTAMP NOT NULL,
        payment_id TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'medico'`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pendente'`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS uf TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS telefone TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS especialidade TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS nome_exibicao TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS cnpj TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS tem_assinatura_digital BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS provedor_assinatura TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS tem_memed BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS memed_email TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS cpf_medico TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS data_nascimento_medico TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS memed_token TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS memed_external_id TEXT`);
    const cols = [
      ['status_atendimento','TEXT'],['documentos_emitidos','TEXT'],['meet_link','TEXT'],
      ['tel_documentos','TEXT'],['idade','TEXT'],['sexo','TEXT'],['alergias','TEXT'],
      ['cronicas','TEXT'],['medicacoes','TEXT'],['queixa','TEXT'],
      ['assumido_em','TIMESTAMP'],['encerrado_em','TIMESTAMP'],
      ['data_nascimento','TEXT'],
      ['prontuario','TEXT'],
      ['solicita','TEXT'],
      ['agendamento_id','INTEGER'],
      ['horario_agendado','TIMESTAMP'],
      ['email','TEXT'],
      ['aprovacao_token','TEXT'],
      ['pagamento_status','TEXT NOT NULL DEFAULT \'pendente\''],
      ['pagbank_order_id','TEXT'],
      ['pagamento_confirmado_em','TIMESTAMPTZ'],
    ];
    // Coluna para controle de lembrete de agendamento
    await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_enviado BOOLEAN DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS precisa_trocar_senha BOOLEAN DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS email TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_paciente_enviado BOOLEAN DEFAULT false`).catch(()=>{});
    for (const [col, tipo] of cols) {
      await pool.query(`ALTER TABLE fila_atendimentos ADD COLUMN IF NOT EXISTS ${col} ${tipo}`);
    }
    // Índices de performance para queries frequentes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensagens_atendimento ON mensagens(atendimento_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensagens_atendimento_criado ON mensagens(atendimento_id, criado_em)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_status ON fila_atendimentos(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_medico_id ON fila_atendimentos(medico_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_encerrado_em ON fila_atendimentos(encerrado_em)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_status ON agendamentos(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_horario ON agendamentos(horario_agendado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_pagbank_order ON fila_atendimentos(pagbank_order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_pagamento_status ON fila_atendimentos(pagamento_status)`);
    console.log("[DB] Tabelas, colunas e índices verificados com sucesso");
  } catch (e) {
    console.error("[DB] Erro no initDB:", e.message);
  }
}
initDB();

const SPREADSHEET_ID = "1z-m4_zJQOIelzOkiUvU8L7VP0CHxJHC317Lb-q0GVCQ";
const serviceAccount = {
  type: "service_account",
  project_id: "consultaja24h",
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID || "",
  private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  client_email: process.env.GOOGLE_CLIENT_EMAIL || "",
  client_id: process.env.GOOGLE_CLIENT_ID || "",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

async function appendToSheet(sheetName, values) {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (e) {
    console.error(`[SHEETS] Erro ao salvar em ${sheetName}:`, e.message);
  }
}

function parsearTriagem(summary) {
  if (!summary) return {};
  const campos = {};

  // Mapa expandido de padrões por campo
  const mapa = [
    { chave: 'queixa',    padroes: ['queixa principal','queixa','motivo','problema principal','problema','chief complaint'] },
    { chave: 'idade',     padroes: ['idade'] },
    { chave: 'sexo',      padroes: ['sexo','gênero','genero'] },
    { chave: 'alergias',  padroes: ['alergia','alergias','hipersensibilidade'] },
    { chave: 'cronicas',  padroes: ['comorbidade','comorbidades','antecedente','antecedentes','doença crônica','doenças crônicas','historico','histórico'] },
    { chave: 'medicacoes',padroes: ['medicação','medicações','medicacao','medicacoes','medicamento','medicamentos','uso contínuo','uso continuo','faz uso'] },
    { chave: 'solicita',  padroes: ['solicita','solicitação','necessita','precisa','documentos','atestado','receita','pedido'] },
  ];

  // Tenta extrair por linha "Chave: Valor"
  const linhas = summary.split(/[\n;]/);
  for (const linha of linhas) {
    const colonIdx = linha.indexOf(':');
    if (colonIdx < 1) {
      // FIX 2: tenta capturar padrões sem dois-pontos ex: "Problema principal dor de garganta"
      // só para queixa (campo mais crítico que a IA omite os dois-pontos)
      if (!campos.queixa) {
        const linhaNorm = linha.trim().toLowerCase().replace(/[*•\-]/g, '').trim();
        for (const p of mapa[0].padroes) {
          if (linhaNorm.startsWith(p)) {
            const valor = linha.trim().slice(p.length).trim().replace(/^[:–—\s]+/, '');
            if (valor && valor.length > 2) { campos.queixa = valor; break; }
          }
        }
      }
      continue;
    }
    const chaveRaw = linha.slice(0, colonIdx).trim().toLowerCase().replace(/[*•\-]/g, '').trim();
    const valor = linha.slice(colonIdx + 1).trim().replace(/^[-–—]\s*/, '');
    if (!valor || /^(nega|não|nao|nenhum|sem)$/i.test(valor)) {
      // Guarda negativas também
      for (const { chave, padroes } of mapa) {
        if (padroes.some(p => chaveRaw.includes(p))) { campos[chave] = campos[chave] || valor || 'Nega'; break; }
      }
      continue;
    }
    for (const { chave, padroes } of mapa) {
      if (padroes.some(p => chaveRaw.includes(p))) { campos[chave] = campos[chave] || valor; break; }
    }
  }

  // Fallbacks por regex no texto livre
  if (!campos.idade) {
    const m = summary.match(/(\d{1,3})\s*anos/i);
    if (m) campos.idade = m[1] + ' anos';
  }
  if (!campos.sexo) {
    if (/\bfeminino\b|\bmulher\b|\bfeminina\b/i.test(summary)) campos.sexo = 'Feminino';
    else if (/\bmasculino\b|\bhomem\b|\bmasculina\b/i.test(summary)) campos.sexo = 'Masculino';
  }
  if (!campos.solicita) {
    if (/atestado/i.test(summary) && /receita/i.test(summary)) campos.solicita = 'Atestado + Receita';
    else if (/atestado/i.test(summary)) campos.solicita = 'Atestado';
    else if (/receita/i.test(summary)) campos.solicita = 'Receita';
    else if (/pedido.*exame|exame/i.test(summary)) campos.solicita = 'Pedido de exame';
    else campos.solicita = 'Não informado';
  }
  // FIX 2: fallback final para queixa — usa primeira linha não vazia do summary
  if (!campos.queixa) {
    const primeiraLinha = summary.split(/[\n;]/).map(l => l.trim()).find(l => l.length > 5 && !/^\{/.test(l));
    if (primeiraLinha) campos.queixa = primeiraLinha.replace(/^(queixa|problema|motivo)[:\s]*/i, '').slice(0, 200);
  }
  if (!campos.alergias) campos.alergias = 'Nega';
  if (!campos.cronicas) campos.cronicas = 'Nega';
  if (!campos.medicacoes) campos.medicacoes = 'Nega';

  return campos;
}

async function callOpenAI({ system, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0.3,
      messages: [
        { role: "system", content: String(system ?? "") },
        ...(messages || []).filter(m => m?.role !== "system").map(m => ({ role: m.role, content: String(m.content ?? "") })),
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.error?.message || JSON.stringify(data) };
  return { ok: true, text: data?.choices?.[0]?.message?.content || "" };
}

async function handleChat(req, res) {
  try {
    const { system, messages } = req.body || {};
    if (!system || !Array.isArray(messages)) return res.status(400).json({ ok: false, error: "Payload invalido" });
    const out = await callOpenAI({ system, messages });
    if (!out.ok) {
      console.error("[CHAT] Erro tecnico:", out.error);
      return res.status(503).json({ text: "Ops, tivemos uma instabilidade na mensagem. Por favor, tente enviar novamente." });
    }
    const text = String(out.text || "").replace(
      "Transmissão interrompida. Aguardando a mensagem completa…",
      "Ops, tivemos uma instabilidade na mensagem. Por favor, tente enviar novamente."
    );
    return res.json({ text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Erro interno temporario." });
  }
}

function checkAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"] || req.query.senha;
  const senhaAdmin = process.env.ADMIN_PASSWORD;
  if (!senhaAdmin) return res.status(500).send("ADMIN_PASSWORD nao configurada");
  if (!senha || senha !== senhaAdmin) return res.status(403).send("Acesso negado");
  next();
}

function checkMedico(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Token nao fornecido" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.medico = decoded; req.medicoId = decoded.id; next();
  } catch(e) {
    return res.status(401).json({ ok: false, error: "Token invalido ou expirado" });
  }
}

const autenticarMedico = checkMedico;

app.post("/api/triage", rlTriagem, handleChat);
app.post("/api/doctor", handleChat);

// ── PAGBANK ───────────────────────────────────────────────────────────────────
const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN?.trim();
const PAGBANK_URL   = "https://api.pagseguro.com";
const VALOR_CENTAVOS = 4990; // R$ 49,90 — fixo no backend

if (!PAGBANK_TOKEN) console.error("[PAGBANK] Token não configurado");

app.post("/api/pagbank/order", async (req, res) => {
  try {
    const { nome, email, cpf } = req.body || {};
    if (!nome || !cpf) return res.status(400).json({ ok: false, error: "nome e cpf obrigatorios" });
    if (!PAGBANK_TOKEN) return res.status(503).json({ ok: false, error: "Gateway de pagamento indisponivel" });

    const expiracao    = new Date(Date.now() + 30 * 60 * 1000);
    const expiracaoISO = expiracao.toISOString().replace("Z", "-03:00");

    const orderBody = {
      reference_id: "CJ-" + Date.now() + "-" + Math.random().toString(36).slice(2,6).toUpperCase(),
      customer: {
        name:   nome,
        email:  email || `paciente+${cpf.replace(/\D/g,"")}@consultaja24h.com.br`,
        tax_id: cpf.replace(/\D/g, "")
      },
      items: [{ name: "Consulta Médica Online — ConsultaJá24h", quantity: 1, unit_amount: VALOR_CENTAVOS }],
      qr_codes: [{ amount: { value: VALOR_CENTAVOS }, expiration_date: expiracaoISO }],
      notification_urls: [
        `${process.env.API_URL || "https://triagem-api.onrender.com"}/api/pagbank/webhook`
      ]
    };

    const response = await fetch(`${PAGBANK_URL}/orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${PAGBANK_TOKEN}`, "Content-Type": "application/json", "accept": "application/json" },
      body: JSON.stringify(orderBody)
    });

    const data = await response.json();
    console.log("[PAGBANK] Order:", JSON.stringify(data).slice(0, 400));

    if (!response.ok) {
      console.error("[PAGBANK] Erro:", JSON.stringify(data));
      return res.status(400).json({ ok: false, error: data.error_messages || "Erro ao criar cobrança" });
    }

    const qrCode = data.qr_codes?.[0];
    if (!qrCode?.text) {
      console.error("[PAGBANK] QR Code ausente:", JSON.stringify(data));
      return res.status(502).json({ ok: false, error: "PagBank nao retornou QR Code. Verifique chave PIX cadastrada na conta." });
    }

    return res.json({ ok: true, order_id: data.id, qr_code_text: qrCode.text });
  } catch (e) {
    console.error("[PAGBANK] Erro:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Webhook PagBank — notificação de pagamento confirmado
// Responde 200 imediatamente -> processa de forma assincrona e idempotente
app.post("/api/pagbank/webhook", async (req, res) => {
  const event = req.body;
  if (!event || typeof event !== "object") {
    console.warn("[PAGBANK-WEBHOOK] Payload invalido recebido");
    return res.status(400).end();
  }

  // CORRETO: order_id real do PagBank é event.data.id (ex: "ORDE_...")
  // reference_id (ex: "CJ-...") e nosso identificador — NAO usar para busca no banco
  const orderId  = String(event?.data?.id || event?.id || "");
  const orderRef = String(event?.data?.reference_id ?? event?.reference_id ?? "");
  const charges  = event?.data?.charges || event?.charges || [];
  const pago     = charges.some(c => c.status === "PAID");

  console.log("[PAGBANK-WEBHOOK] Recebido — orderId:", orderId, "ref:", orderRef, "pago:", pago);

  // Responde 200 imediatamente — PagBank nao pode esperar processamento
  res.sendStatus(200);

  if (!pago || !orderId) return;

  try {
    // Atualiza atendimento imediato pelo pagbank_order_id — idempotente:
    // so avanca se ainda estiver 'pendente', prevenindo duplo processamento em retries
    const { rowCount, rows } = await pool.query(
      `UPDATE fila_atendimentos
          SET pagamento_status        = 'confirmado',
              pagamento_confirmado_em = NOW(),
              status = CASE
                WHEN status = 'triagem' THEN 'triagem'
                ELSE 'aguardando'
              END
        WHERE pagbank_order_id = $1
          AND pagamento_status  = 'pendente'
        RETURNING id, nome, tel, cpf, tipo, triagem, status`,
      [orderId]
    );

    if (rowCount === 0) {
      console.log("[PAGBANK-WEBHOOK] Order " + orderId + " nao encontrado ou ja processado — ignorando retry.");
      // Fallback legado: tenta agendamentos ainda sem pagbank_order_id vinculado
      await pool.query(
        `WITH alvo AS (
           SELECT id FROM agendamentos
           WHERE payment_id IS NULL
             AND status = 'pendente'
             AND criado_em > NOW() - INTERVAL '2 hours'
           ORDER BY criado_em DESC
           LIMIT 1
         )
         UPDATE agendamentos a
            SET status = 'confirmado', payment_id = $1
           FROM alvo
          WHERE a.id = alvo.id`,
        [orderId]
      ).catch(e => console.warn("[PAGBANK-WEBHOOK] Fallback agendamento:", e.message));
      return;
    }

    const at = rows[0];
    console.log("[PAGBANK-WEBHOOK] Pagamento confirmado — atendimento #" + at.id + " status:" + at.status);

    // Notifica medicos apenas se o atendimento esta pronto (triagem real ja preenchida)
    // Se status ainda e 'triagem', o /api/atendimento/atualizar-triagem notifica quando concluir
    if (at.status === 'aguardando' && !isTriagemPlaceholder(at.triagem)) {
      await notificarMedicos(at);
    }

  } catch (e) {
    console.error("[PAGBANK-WEBHOOK] Erro no processamento:", e.message);
  }
});

// Consultar status de uma order PagBank — usado como fallback de polling
app.get("/api/pagbank/order/:id", async (req, res) => {
  try {
    if (!PAGBANK_TOKEN) return res.status(503).json({ ok: false, error: "Gateway indisponivel" });
    const response = await fetch(`${PAGBANK_URL}/orders/${req.params.id}`, {
      headers: { "Authorization": `Bearer ${PAGBANK_TOKEN}`, "accept": "application/json" }
    });
    const data = await response.json();
    // Verifica pagamento tanto em charges quanto em qr_codes
    const pago = data.charges?.some(c => c.status === "PAID") || false;
    return res.json({ ok: true, status: data.status, pago });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper para montar HTML do email
function montarHtmlEmail({ nome, tel, tipo, triagem, linkRetorno, linkAssumir, medicoNome, horarioAgendado, isLembrete }) {
  const tipoLabel = tipo === "video" ? "Video" : "Chat";
  const telLimpo = String(tel||"").replace(/\D/g,"");
  function montarTabelaTriagem(texto) {
    if (!texto) return '<tr><td colspan="2">-</td></tr>';
    return texto.split(/[;\n]/).map(item => {
      const ci = item.indexOf(":");
      if (ci>0) { const k=item.slice(0,ci).trim(); const v=item.slice(ci+1).trim(); return `<tr><td style="padding:8px 12px;color:rgba(255,255,255,.45);font-size:12px;width:150px">${k}</td><td style="padding:8px 12px;color:#fff;font-size:13px">${v}</td></tr>`; }
      return `<tr><td colspan="2" style="padding:8px 12px;color:rgba(255,255,255,.7);font-size:13px">${item.trim()}</td></tr>`;
    }).join("");
  }
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:20px 28px"><h2 style="margin:0;color:#051208;font-size:18px">Novo paciente aguardando atendimento — ConsultaJa24h</h2></div>
    <div style="padding:28px">
      <div style="margin-bottom:18px;padding:10px 16px;background:rgba(94,224,160,.07);border:1px solid rgba(94,224,160,.2);border-radius:10px;font-size:12px;color:rgba(94,224,160,.85)">\u2705 Pagamento confirmado automaticamente via PagBank</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:140px">Paciente</td><td style="padding:8px 0;font-weight:600">${nome||"-"}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0;font-weight:600">${telLimpo}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Modalidade</td><td style="padding:8px 0;font-weight:600">${tipoLabel}</td></tr>
        ${horarioAgendado ? `<tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">📅 Horário</td><td style="padding:8px 0;font-weight:700;color:#b4e05a;font-size:15px">${horarioAgendado}</td></tr>` : ''}
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0"><a href="https://wa.me/55${telLimpo}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">Chamar no WhatsApp</a></td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Link do paciente</td><td style="padding:8px 0;font-size:12px"><a href="${linkRetorno}" style="color:#5ee0a0">${linkRetorno}</a><br><span style="font-size:11px;color:rgba(255,255,255,.3)">⚠️ Use apenas se o paciente perder acesso à sala</span></td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,.1);border-radius:10px">${montarTabelaTriagem(triagem)}</table>
      ${isLembrete ? `<div style="margin:16px 0;padding:12px 16px;background:rgba(255,189,46,.08);border:1px solid rgba(255,189,46,.25);border-radius:10px;font-size:12px;color:rgba(255,189,46,.9)">⚠️ Esta triagem foi feita no momento do agendamento e pode estar desatualizada. Confirme os dados com o paciente no início da consulta.</div>` : ""}
      <div style="margin-top:24px;text-align:center">
        ${linkAssumir ? `
        <a href="${linkAssumir}" style="display:inline-block;padding:14px 32px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:12px">
          ▶ Assumir atendimento
        </a>
        <p style="margin:8px 0 16px;font-size:11px;color:rgba(255,255,255,.3)">Primeiro a clicar assume. Link válido por 2h.</p>` : ''}
        <a href="https://painel.consultaja24h.com.br" style="display:inline-block;padding:11px 24px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:rgba(255,255,255,.7);font-family:Arial,sans-serif;font-size:13px;font-weight:600;text-decoration:none">
          🔑 Acessar o painel
        </a>
        <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,.2)">Entre com seu login para atender</p>
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,.3)">Enviado automaticamente pelo sistema ConsultaJa24h</p>
    </div>
  </div>`;
}

async function enviarEmailMedicos({ nome, tel, tipo, triagem, linkRetorno, subject, atendimentoId, horarioAgendado, horarioAgendadoRaw }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn("[EMAIL] RESEND_API_KEY nao definida."); return; }
  try {
    const medicosResult = await pool.query(`SELECT id,nome,email FROM medicos WHERE ativo=true AND status='aprovado' ORDER BY status_online DESC`);
    const medicos = medicosResult.rows.filter(m=>m.email);
    // Garante que o admin sempre recebe
    // Admin sempre primeiro
    const adminEmail = "gustavosgbf@gmail.com";
    const adminIdx = medicos.findIndex(m=>m.email===adminEmail);
    if (adminIdx > 0) medicos.splice(adminIdx, 1);
    if (adminIdx !== 0) medicos.unshift({ id: 0, nome: "Gustavo", email: adminEmail });

    const PAINEL_URL = "https://painel.consultaja24h.com.br";
    const API_URL = process.env.API_URL || "https://triagem-api.onrender.com";
    // Envia e-mail individual para cada médico com token único
    // Token expira 4h após o horário do agendamento (ou 2h para imediatos)
    let tokenExpiresAt;
    if (horarioAgendado && horarioAgendadoRaw) {
      const horarioDate = new Date(horarioAgendadoRaw);
      tokenExpiresAt = Math.floor(horarioDate.getTime() / 1000) + 4 * 60 * 60; // +4h após horário
    }
    for (const med of medicos) {
      const tokenPayload = { medicoId: med.id, medicoNome: med.nome, atendimentoId, tipo: "assumir" };
      const tokenOpts = tokenExpiresAt
        ? { expiresIn: Math.max(tokenExpiresAt - Math.floor(Date.now()/1000), 3600) } // mínimo 1h
        : { expiresIn: "2h" };
      const token = jwt.sign(tokenPayload, JWT_SECRET, tokenOpts);
      const linkAsumir = `${API_URL}/api/atendimento/assumir-email?token=${token}`;
      const html = montarHtmlEmail({ nome, tel, tipo, triagem, linkRetorno, linkAsumir, medicoNome: med.nome, horarioAgendado });
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: "ConsultaJa24h <contato@consultaja24h.com.br>", to: [med.email], subject, html })
      });
      const resendData = await resendRes.json();
      if (resendData.id) console.log("[EMAIL] Enviado para:", med.email, "| ID:", resendData.id);
      else console.error("[EMAIL] Resend recusou para", med.email, ":", JSON.stringify(resendData));
      // Delay para respeitar rate limit do Resend (max 2 req/s)
      await new Promise(r => setTimeout(r, 600));
    }
  } catch(e) {
    console.error("[EMAIL] Erro:", e.message);
  }
}

// ── E-MAIL: novo cadastro de médico (só para o admin) ──────────────────────────
async function enviarEmailNovoCadastroMedico({ nome, email, crm, uf, especialidade, telefone }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn("[EMAIL-MEDICO] RESEND_API_KEY nao definida."); return; }
  try {
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,255,255,.4);margin-left:8px">Novo cadastro pendente</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:20px">Um novo médico solicitou acesso à plataforma:</p>
          <table style="width:100%;border-collapse:collapse;font-size:.85rem">
            <tr><td style="color:rgba(255,255,255,.4);padding:6px 0;width:40%">Nome</td><td style="color:#fff;font-weight:500">${nome}</td></tr>
            <tr><td style="color:rgba(255,255,255,.4);padding:6px 0">E-mail</td><td style="color:#fff">${email}</td></tr>
            <tr><td style="color:rgba(255,255,255,.4);padding:6px 0">CRM</td><td style="color:#fff">${crm}/${uf}</td></tr>
            ${especialidade ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Especialidade</td><td style="color:#fff">${especialidade}</td></tr>` : ''}
            ${telefone ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Telefone</td><td style="color:#fff">${telefone}</td></tr>` : ''}
          </table>
          <p style="margin:20px 0 0;font-size:.78rem;color:rgba(255,255,255,.3)">Acesse o painel admin para aprovar ou rejeitar este cadastro.</p>
        </div>
      </div>
    </div>`;
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: "ConsultaJá24h <contato@consultaja24h.com.br>",
        to: ["gustavosgbf@gmail.com"],
        subject: `⚕️ Novo cadastro pendente: ${nome} (CRM ${crm}/${uf})`,
        html
      })
    });
    const d = await resendRes.json();
    if (d.id) console.log("[EMAIL-MEDICO] Aviso admin enviado | ID:", d.id);
    else console.error("[EMAIL-MEDICO] Resend recusou:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-MEDICO] Erro:", e.message); }
}

// ── E-MAIL: aprovação de médico (só para o médico aprovado) ────────────────────
async function enviarEmailAprovacaoMedico({ nome, email }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn("[EMAIL-APROVACAO] RESEND_API_KEY nao definida."); return; }
  try {
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:1rem;margin-bottom:12px">Olá, <strong>${nome}</strong>!</p>
          <p style="color:rgba(255,255,255,.75);font-size:.9rem;line-height:1.6;margin-bottom:20px">
            Seu cadastro na plataforma <strong style="color:#b4e05a">ConsultaJá24h</strong> foi aprovado. Você já pode acessar o painel médico e começar a atender.
          </p>
          <a href="https://painel.consultaja24h.com.br" style="display:inline-block;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">
            Acessar o painel →
          </a>
          <p style="margin:20px 0 0;font-size:.78rem;color:rgba(255,255,255,.3)">
            Em caso de dúvidas, entre em contato com a equipe da plataforma.
          </p>
        </div>
      </div>
    </div>`;
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: "ConsultaJá24h <contato@consultaja24h.com.br>",
        to: [email],
        subject: "✅ Seu cadastro foi aprovado — ConsultaJá24h",
        html
      })
    });
    const d = await resendRes.json();
    if (d.id) console.log("[EMAIL-APROVACAO] Enviado para:", email, "| ID:", d.id);
    else console.error("[EMAIL-APROVACAO] Resend recusou:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-APROVACAO] Erro:", e.message); }
}

// ── E-MAIL: confirmação de agendamento para o PACIENTE ─────────────────────────
async function enviarEmailConfirmacaoPaciente({ nome, email, horarioFormatado, modalidade, linkConsulta }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;
  try {
    const tipoLabel = modalidade === "video" ? "Vídeo" : "Chat";
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,255,255,.4);margin-left:8px">Agendamento confirmado</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:20px">Olá, <strong>${nome}</strong>! Seu agendamento foi confirmado.</p>
          <div style="background:rgba(180,224,90,.07);border:1px solid rgba(180,224,90,.2);border-radius:12px;padding:16px 20px;margin-bottom:20px">
            <div style="font-size:.72rem;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Data e horário</div>
            <div style="font-size:1.2rem;font-weight:700;color:#b4e05a">${horarioFormatado}</div>
            <div style="font-size:.82rem;color:rgba(255,255,255,.5);margin-top:4px">Modalidade: ${tipoLabel}</div>
          </div>
          <p style="color:rgba(255,255,255,.65);font-size:.85rem;line-height:1.6;margin-bottom:20px">
            Na hora marcada, acesse o link abaixo para entrar na sala de espera. O médico já estará preparado com sua triagem.
          </p>
          <a href="${linkConsulta}" style="display:inline-block;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">
            Entrar na consulta →
          </a>
          <p style="margin:20px 0 0;font-size:.72rem;color:rgba(255,255,255,.25)">Você receberá um lembrete 1h antes do horário.</p>
        </div>
      </div>
    </div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [email], subject: `✅ Agendamento confirmado — ${horarioFormatado}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-PACIENTE] Confirmação enviada para:", email);
    else console.error("[EMAIL-PACIENTE] Erro:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-PACIENTE] Erro:", e.message); }
}

// ── E-MAIL: lembrete 1h antes para o PACIENTE ──────────────────────────────────
async function enviarEmailLembretePaciente({ nome, email, horarioFormatado, modalidade, linkConsulta }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;
  try {
    const tipoLabel = modalidade === "video" ? "Vídeo" : "Chat";
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,189,46,.7);margin-left:8px">🔔 Lembrete — consulta em 1h</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:16px">Olá, <strong>${nome}</strong>! Sua consulta começa em aproximadamente <strong style="color:#b4e05a">1 hora</strong>.</p>
          <div style="background:rgba(255,189,46,.06);border:1px solid rgba(255,189,46,.2);border-radius:12px;padding:14px 18px;margin-bottom:20px">
            <div style="font-size:1.1rem;font-weight:700;color:#ffbd2e">${horarioFormatado}</div>
            <div style="font-size:.8rem;color:rgba(255,255,255,.45);margin-top:4px">${tipoLabel}</div>
          </div>
          <a href="${linkConsulta}" style="display:inline-block;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">
            Entrar na sala de espera →
          </a>
        </div>
      </div>
    </div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [email], subject: `🔔 Lembrete: sua consulta é em 1h — ${horarioFormatado}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-LEMBRETE-PACIENTE] Enviado para:", email);
    else console.error("[EMAIL-LEMBRETE-PACIENTE] Erro:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-LEMBRETE-PACIENTE] Erro:", e.message); }
}

// Lista explicita de placeholders — sem LIKE, comparacao direta
const TRIAGEM_PLACEHOLDERS = new Set([
  '(aguardando pagamento)',
  '(pagamento confirmado — aguardando triagem)',
  '(triagem em andamento)',
  '(aguardando triagem de agendamento)',
  '(aguardando resposta)',
]);

function isTriagemPlaceholder(triagem) {
  if (!triagem) return true;
  return TRIAGEM_PLACEHOLDERS.has(triagem.trim().toLowerCase());
}

// Mantido por compatibilidade com /api/notify
function ehPlaceholder(triagem) {
  return isTriagemPlaceholder(triagem);
}

// Notificacao centralizada: unica fonte de verdade para envio de email aos medicos
async function notificarMedicos(at) {
  const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
  const linkRetorno = SITE_URL + "/triagem.html?consulta=" + at.id;
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });

  appendToSheet("Atendimentos", [
    agora, at.nome||"", at.tel||"", at.cpf||"",
    "Aguardando", "", at.triagem||"", at.tipo||"", "", String(at.id)
  ]).catch(() => {});

  await enviarEmailMedicos({
    nome: at.nome, tel: at.tel, tipo: at.tipo,
    triagem: at.triagem, linkRetorno,
    atendimentoId: at.id,
    horarioAgendado: null, horarioAgendadoRaw: null,
    subject: "Novo paciente aguardando atendimento — " + (at.nome || "Paciente")
  });

  console.log("[NOTIFICACAO] Medicos notificados — atendimento #" + at.id);
}

// ── Helper: libera atendimento para médicos (timer + endpoint de aprovação) ───
async function liberarAtendimentoParaMedicos(atendimentoId) {
  const r = await pool.query(
    `UPDATE fila_atendimentos SET status='aguardando', aprovacao_token=NULL
     WHERE id=$1 AND status='aguardando_aprovacao' RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos`,
    [atendimentoId]
  );
  if (r.rowCount === 0) {
    console.log(`[APROVACAO] #${atendimentoId} já foi liberado ou cancelado — ignorando.`);
    return;
  }
  const at = r.rows[0];
  const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
  const linkRetorno = `${SITE_URL}/triagem.html?consulta=${at.id}`;
  const tipoLabel = at.tipo === "video" ? "Video" : "Chat";
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
  appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Aguardando","",at.triagem||"",at.tipo||"","",String(at.id)]).catch(()=>{});
  await enviarEmailMedicos({
    nome: at.nome, tel: at.tel, tipo: at.tipo, triagem: at.triagem, linkRetorno,
    atendimentoId: at.id, horarioAgendado: null, horarioAgendadoRaw: null,
    subject: `Nova triagem - ${at.nome||"Paciente"} (${tipoLabel})`
  });
  console.log(`[LIBERADO] Atendimento #${atendimentoId} liberado para médicos.`);
}

app.post("/api/atendimento/atualizar-triagem", async (req, res) => {
  try {
    const { atendimentoId, triagem, agendamentoId } = req.body || {};
    if (!atendimentoId || !triagem) return res.status(400).json({ ok: false, error: "atendimentoId e triagem sao obrigatorios" });
    const campos = parsearTriagem(triagem);

    // ── AGENDAMENTO: fluxo original sem interceptação ──────────────────────
    if (agendamentoId) {
      const result = await pool.query(
        `UPDATE fila_atendimentos SET triagem=$2,queixa=$3,idade=$4,sexo=$5,alergias=$6,cronicas=$7,medicacoes=$8,solicita=$9,status='aguardando'
         WHERE id=$1 AND status IN ('triagem','aguardando') RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos,medico_nome`,
        [atendimentoId,triagem,campos.queixa||triagem,campos.idade||"",campos.sexo||"",campos.alergias||"",campos.cronicas||"",campos.medicacoes||"",campos.solicita||""]
      );
      if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado ou ja em andamento" });
      const at = result.rows[0];
      const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
      const linkRetorno = `${SITE_URL}/triagem.html?consulta=${at.id}`;
      const tipoLabel = at.tipo === "video" ? "Video" : "Chat";
      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
      const agRow = await pool.query(`SELECT horario_agendado FROM agendamentos WHERE id=$1`,[agendamentoId]);
      let horarioAgendado = null, horarioAgendadoRaw = null;
      if (agRow.rows[0]) {
        horarioAgendadoRaw = agRow.rows[0].horario_agendado;
        horarioAgendado = new Date(horarioAgendadoRaw).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
        await pool.query(`UPDATE fila_atendimentos SET horario_agendado=$1, agendamento_id=$2 WHERE id=$3`,[horarioAgendadoRaw, agendamentoId, atendimentoId]);
      }
      appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Aguardando","",triagem,at.tipo||"","",String(at.id)]).catch(e=>console.error("[Sheets]",e));
      await enviarEmailMedicos({
        nome: at.nome, tel: at.tel, tipo: at.tipo, triagem, linkRetorno,
        atendimentoId: at.id, horarioAgendado, horarioAgendadoRaw,
        subject: "Agendamento - " + (at.nome||"Paciente") + " (" + tipoLabel + ") - " + horarioAgendado
      });
      return res.json({ ok: true, atendimentoId: at.id });
    }

    // ── CONSULTA IMEDIATA: verifica pagamento_status para decidir se libera agora ──
    const check = await pool.query(
      "SELECT pagamento_status FROM fila_atendimentos WHERE id = $1",
      [atendimentoId]
    );
    if (!check.rows[0]) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });

    const pagamentoConfirmado = check.rows[0].pagamento_status === 'confirmado';
    // Se pagamento confirmado -> vai direto para 'aguardando' e notifica medicos
    // Se ainda pendente -> salva triagem mas mantém 'triagem'; webhook notifica quando chegar
    const novoStatus = pagamentoConfirmado ? 'aguardando' : 'triagem';

    const result = await pool.query(
      `UPDATE fila_atendimentos
          SET triagem=$2, queixa=$3, idade=$4, sexo=$5, alergias=$6, cronicas=$7,
              medicacoes=$8, solicita=$9, status=$10, aprovacao_token=NULL
        WHERE id=$1 AND status IN ('triagem','aguardando','aguardando_aprovacao')
        RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos`,
      [atendimentoId, triagem, campos.queixa||triagem, campos.idade||"", campos.sexo||"",
       campos.alergias||"", campos.cronicas||"", campos.medicacoes||"", campos.solicita||"",
       novoStatus]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    const at = result.rows[0];

    if (novoStatus === 'aguardando') {
      await notificarMedicos(at);
      console.log("[TRIAGEM] Atendimento #" + at.id + " liberado — pagamento confirmado, medicos notificados.");
    } else {
      console.log("[TRIAGEM] Atendimento #" + at.id + " — triagem salva, aguardando confirmacao de pagamento.");
    }

    return res.json({ ok: true, atendimentoId: at.id });

  } catch (e) {
    console.error("Erro em /api/atendimento/atualizar-triagem:", e);
    return res.status(500).json({ ok: false, error: "Erro ao atualizar triagem" });
  }
});

// ── ROTA PÚBLICA: busca paciente por WhatsApp para autopreenchimento ──────────
// Sem autenticação — retorna apenas campos básicos para UX de retorno
app.get("/api/paciente/buscar", rlGeral, async (req, res) => {
  try {
    let tel = (req.query.tel || "").replace(/\D/g, "");
    // Normaliza: remove DDI 55 se presente
    if (tel.length > 11 && tel.startsWith("55")) tel = tel.slice(2);
    if (tel.length < 10) return res.json({ ok: false });
    // Busca o atendimento mais recente do paciente com este número
    const result = await pool.query(
      `SELECT nome, tel, data_nascimento
         FROM fila_atendimentos
        WHERE regexp_replace(tel, '\D', '', 'g') LIKE $1
        ORDER BY criado_em DESC
        LIMIT 1`,
      [`%${tel}`]
    );
    if (result.rows.length === 0) return res.json({ ok: false });
    const p = result.rows[0];
    return res.json({
      ok: true,
      paciente: {
        nome: p.nome || "",
        tel: p.tel || "",
        data_nascimento: p.data_nascimento || ""
      }
    });
  } catch (e) {
    console.error("Erro em /api/paciente/buscar:", e);
    return res.json({ ok: false });
  }
});

app.post("/api/notify", rlTriagem, async (req, res) => {
  try {
    const { nome, tel, tel_documentos, cpf, triagem, tipo, data_nascimento } = req.body || {};
    const tipoConsulta = tipo === "video" ? "video" : "chat";
    const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
    const campos = parsearTriagem(triagem);
    // STATUS: se triagem for placeholder (pré-registro durante pagamento/triagem), usa 'triagem'
    // Se triagem real (chamado diretamente sem atendimentoId prévio), usa 'aguardando'
    const statusInicial = ehPlaceholder(triagem) ? 'triagem' : 'aguardando';
    const insertResult = await pool.query(
      `INSERT INTO fila_atendimentos (nome,tel,tel_documentos,cpf,tipo,triagem,status,queixa,idade,sexo,alergias,cronicas,medicacoes,data_nascimento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [nome||"-",tel||"-",tel_documentos||tel||"-",cpf||"-",tipoConsulta,triagem||"",statusInicial,
       campos.queixa||triagem||"",campos.idade||"",campos.sexo||"",campos.alergias||"",campos.cronicas||"",campos.medicacoes||"",data_nascimento||""]
    );
    const atendimentoId = insertResult.rows[0]?.id;
    const linkRetorno = `${SITE_URL}/triagem.html?consulta=${atendimentoId}`;
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    appendToSheet("Atendimentos",[agora,nome||"",tel||"",cpf||"",statusInicial,"",triagem||"",tipoConsulta||"","",String(atendimentoId)]).catch(e=>console.error("[Sheets]",e));

    // Email NÃO é disparado aqui — o /api/atendimento/atualizar-triagem dispara após triagem real concluída
    // Isso evita email duplicado quando notify recebe triagem real diretamente
    if (!ehPlaceholder(triagem)) {
      console.log("[EMAIL-NOTIFY] Triagem real recebida via notify — email será disparado pelo atualizar-triagem");
    } else {
      console.log("[EMAIL-NOTIFY] Pre-registro, email suprimido. Status:", statusInicial);
    }

    return res.json({ ok: true, atendimentoId, linkRetorno });
  } catch (e) {
    console.error("Notify error:", e);
    if (!res.headersSent) return res.status(500).json({ ok: false });
  }
});

app.post("/api/chat/upload", rlUpload, upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Nenhum arquivo enviado" });
    const { atendimentoId, autor, autorId } = req.body || {};
    if (!atendimentoId || !autor) return res.status(400).json({ ok: false, error: "atendimentoId e autor obrigatorios" });
    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const tipo = req.file.mimetype.startsWith("image/") ? "imagem" : "pdf";
    const key = `chat/${randomUUID()}.${ext}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const url = `${process.env.R2_PUBLIC_URL}/${key}`;
    const result = await pool.query(
      `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto,arquivo_url,arquivo_tipo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,criado_em`,
      [atendimentoId, autor, autorId || null, "", url, tipo]
    );
    return res.json({ ok: true, mensagem: result.rows[0] });
  } catch (e) { console.error("Erro em /api/chat/upload:", e); return res.status(500).json({ ok: false, error: "Erro ao fazer upload" }); }
});

app.post("/api/chat/enviar", rlMensagem, async (req, res) => {
  try {
    const { atendimentoId, autor, autorId, texto, arquivo_url, arquivo_tipo } = req.body || {};
    if (!atendimentoId||!autor||(!texto&&!arquivo_url)) return res.status(400).json({ ok: false, error: "Campos obrigatorios: atendimentoId, autor, texto ou arquivo" });
    if (!["paciente","medico"].includes(autor)) return res.status(400).json({ ok: false, error: "autor deve ser paciente ou medico" });
    const result = await pool.query(
      `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto,arquivo_url,arquivo_tipo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,criado_em`,
      [atendimentoId,autor,autorId||null,(texto||"").trim(),arquivo_url||null,arquivo_tipo||null]
    );
    return res.json({ ok: true, mensagem: result.rows[0] });
  } catch (e) { console.error("Erro em /api/chat/enviar:", e); return res.status(500).json({ ok: false, error: "Erro ao enviar mensagem" }); }
});

app.get("/api/chat/:atendimentoId", async (req, res) => {
  try {
    const { atendimentoId } = req.params;
    const auth = req.headers["authorization"] || "";
    const token = auth.replace("Bearer ","").trim();
    let autorizado = false;
    if (token) { try { jwt.verify(token, JWT_SECRET); autorizado=true; } catch(e){} }
    if (!autorizado) { const check = await pool.query(`SELECT id FROM fila_atendimentos WHERE id=$1`,[atendimentoId]); autorizado=check.rowCount>0; }
    if (!autorizado) return res.status(403).json({ ok: false, error: "Acesso negado" });
    const result = await pool.query(`SELECT id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,criado_em FROM mensagens WHERE atendimento_id=$1 ORDER BY criado_em ASC`,[atendimentoId]);
    return res.json({ ok: true, mensagens: result.rows });
  } catch (e) { console.error("Erro em /api/chat/:id:", e); return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" }); }
});

app.get("/api/atendimento/status/:id", async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,status,tipo,medico_nome,meet_link,criado_em,assumido_em,encerrado_em,nome,tel,cpf,data_nascimento,idade,sexo,alergias,cronicas,medicacoes,queixa,email FROM fila_atendimentos WHERE id=$1`,[req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    return res.json({ ok: true, atendimento: result.rows[0] });
  } catch (e) { return res.status(500).json({ ok: false, error: "Erro ao buscar status" }); }
});

app.post("/api/identify", async (req, res) => {
  try {
    const { nome, tel } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    const ip = req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"-";
    await pool.query("INSERT INTO identificacoes (nome,tel,data,ip) VALUES ($1,$2,$3,$4)",[nome||"-",tel||"-",agora,ip]);
    await appendToSheet("Identificacoes",[agora,nome||"",tel||"",ip]);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false }); }
});

app.post("/api/consent", async (req, res) => {
  try {
    const { nome, tel, versao } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    const ip = req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"-";
    await pool.query("INSERT INTO consentimentos (nome,tel,versao,data,ip) VALUES ($1,$2,$3,$4,$5)",[nome||"-",tel||"-",versao||"v1.0",agora,ip]);
    await appendToSheet("Consentimentos",[agora,nome||"",tel||"",versao||"v1.0",ip]);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false }); }
});

app.get("/api/atendimento/assumir-email", async (req, res) => {
  const PAINEL_URL = "https://painel.consultaja24h.com.br";
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("<h2>Link inválido.</h2>");
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060d0b;color:#fff"><h2 style="color:#ff8080">⏰ Link expirado</h2><p>Este link de assumir atendimento expirou (válido por 2h).</p><a href="${PAINEL_URL}" style="color:#b4e05a">Ir para o painel</a></body></html>`); }
    if (payload.tipo !== "assumir") return res.status(400).send("<h2>Token inválido.</h2>");
    const { medicoId, medicoNome, atendimentoId } = payload;
    // Tenta assumir com trava — só um médico consegue
    const result = await pool.query(
      `UPDATE fila_atendimentos SET status='assumido', medico_id=$1, medico_nome=$2, assumido_em=NOW()
       WHERE id=$3 AND status='aguardando' RETURNING id,nome`,
      [medicoId, medicoNome, atendimentoId]
    );
    if (result.rowCount === 0) {
      // Verifica quem assumiu
      const ja = await pool.query(`SELECT medico_nome FROM fila_atendimentos WHERE id=$1`,[atendimentoId]);
      const quem = ja.rows[0]?.medico_nome || "outro médico";
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060d0b;color:#fff"><h2 style="color:#ffbd2e">⚠️ Atendimento já assumido</h2><p>Este atendimento já foi assumido por <strong>${quem}</strong>.</p><a href="${PAINEL_URL}" style="color:#b4e05a">Ir para o painel</a></body></html>`);
    }
    const paciente = result.rows[0];
    console.log(`[ASSUMIR-EMAIL] ${medicoNome} assumiu atendimento #${atendimentoId} (${paciente.nome}) via e-mail`);
    // Redireciona para o painel com o atendimento já marcado
    return res.redirect(`${PAINEL_URL}?assumiu=${atendimentoId}`);
  } catch(e) {
    console.error("[ASSUMIR-EMAIL] Erro:", e.message);
    return res.status(500).send("<h2>Erro interno.</h2>");
  }
});

app.get("/atender", async (req, res) => {
  try {
    const { medico, paciente, tel } = req.query;
    if (!tel) return res.status(400).send("Parametros invalidos");
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    await pool.query("INSERT INTO logs_atendimentos (medico,paciente,tel,data) VALUES ($1,$2,$3,$4)",[medico||"desconhecido",paciente||"-",tel,agora]);
    await appendToSheet("Atendimentos",[agora,paciente||"",tel||"","","Assumido",medico||"","","","",""]);
    return res.redirect(`https://wa.me/55${String(tel).replace(/\D/g,"")}`);
  } catch (e) { return res.status(500).send("Erro ao assumir atendimento"); }
});

app.post("/api/medico/cadastro", async (req, res) => {
  try {
    const { nome, nome_exibicao, email, senha, crm, uf, telefone, especialidade,
            cnpj, tem_assinatura_digital, provedor_assinatura, tem_memed, memed_email } = req.body || {};
    if (!nome||!email||!senha||!crm||!uf||!telefone) return res.status(400).json({ ok: false, error: "Todos os campos obrigatorios devem ser preenchidos" });
    if (senha.length<6) return res.status(400).json({ ok: false, error: "Senha deve ter ao menos 6 caracteres" });
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO medicos (nome,nome_exibicao,email,senha_hash,crm,uf,telefone,especialidade,
        cnpj,tem_assinatura_digital,provedor_assinatura,tem_memed,memed_email,
        status_online,ativo,role,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,false,'medico','pendente') RETURNING id,nome,nome_exibicao,email`,
      [nome.trim(),(nome_exibicao||nome).trim(),email.trim().toLowerCase(),senha_hash,
       crm.trim().toUpperCase(),uf.trim().toUpperCase(),telefone||"",especialidade||"",
       cnpj||"",!!tem_assinatura_digital,provedor_assinatura||"",!!tem_memed,memed_email||""]
    );
    const med = result.rows[0];
    // E-mail só para o admin — nunca para outros médicos
    enviarEmailNovoCadastroMedico({ nome: med.nome, email: med.email, crm: crm.trim().toUpperCase(), uf: uf.trim().toUpperCase(), especialidade: especialidade||"", telefone: telefone||"" }).catch(()=>{});
    return res.json({ ok: true, medico: med });
  } catch (err) {
    if (err.code==="23505") return res.status(400).json({ ok: false, error: "E-mail ja cadastrado" });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/admin/medico/:id/aprovar", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE medicos SET ativo=true,status='aprovado' WHERE id=$1 RETURNING id,nome,email,status,ativo`,[req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    const med = result.rows[0];
    // E-mail só para o médico aprovado — nunca para outros médicos
    enviarEmailAprovacaoMedico({ nome: med.nome, email: med.email }).catch(()=>{});
    return res.json({ ok: true, medico: med });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch("/api/admin/medico/:id/rejeitar", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE medicos SET ativo=false,status='rejeitado' WHERE id=$1 RETURNING id,nome,status`,[req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/admin/medicos/pendentes", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,nome,nome_exibicao,email,crm,uf,telefone,especialidade,cnpj,tem_assinatura_digital,provedor_assinatura,tem_memed,memed_email,status,ativo,created_at FROM medicos WHERE status='pendente' ORDER BY created_at DESC`);
    return res.json({ ok: true, medicos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/admin/medico/criar", checkAdmin, async (req, res) => {
  try {
    const { nome, email, crm, senha } = req.body || {};
    if (!nome||!email||!crm||!senha) return res.status(400).json({ ok: false, error: "Campos obrigatorios faltando" });
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO medicos (nome,email,senha_hash,crm,status_online,ativo) VALUES ($1,$2,$3,$4,false,true) RETURNING id,nome,email,crm,status_online,ativo,created_at`,
      [nome,email.trim().toLowerCase(),senha_hash,crm]
    );
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    if (err.code==="23505") return res.status(400).json({ ok: false, error: "E-mail ja cadastrado" });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/medicos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id,nome,email,crm,status_online,ativo,created_at FROM medicos ORDER BY id DESC");
    return res.json({ ok: true, medicos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch("/api/admin/medico/:id", checkAdmin, async (req, res) => {
  try {
    const { ativo } = req.body || {};
    if (typeof ativo !== "boolean") return res.status(400).json({ ok: false, error: "Campo ativo deve ser boolean" });
    const result = await pool.query("UPDATE medicos SET ativo=$1 WHERE id=$2 RETURNING id,nome,ativo",[ativo,req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});


// ── MEMED: obter/criar token do médico ────────────────────────────────────────
const MEMED_API_URL = process.env.MEMED_API_URL || "https://api.memed.com.br/v1";
const MEMED_API_KEY = process.env.MEMED_API_KEY || "";
const MEMED_SECRET_KEY = process.env.MEMED_SECRET_KEY || "";

app.get("/api/memed/token", checkMedico, async (req, res) => {
  try {
    const medicoId = req.medico.id;
    const medResult = await pool.query(
      `SELECT id,nome,email,crm,uf,telefone,especialidade,cpf_medico,data_nascimento_medico,memed_external_id FROM medicos WHERE id=$1`,
      [medicoId]
    );
    if (medResult.rowCount === 0) return res.status(404).json({ ok: false, error: "Médico não encontrado" });
    const med = medResult.rows[0];

    // Monta external_id único para o médico
    const externalId = med.memed_external_id || `consultaja-${med.id}`;

    // Tenta obter token existente primeiro
    const getUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios/${externalId}?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
    const getRes = await fetch(getUrl, {
      headers: { "Accept": "application/vnd.api+json", "Content-Type": "application/json" }
    });
    
    if (getRes.ok) {
      const getData = await getRes.json();
      const token = getData?.data?.attributes?.token;
      if (token) {
        // Salva external_id se ainda não tinha
        if (!med.memed_external_id) {
          await pool.query(`UPDATE medicos SET memed_external_id=$1 WHERE id=$2`, [externalId, medicoId]);
        }
        return res.json({ ok: true, token, externalId });
      }
    }

    // Médico não existe no Memed — cadastra
    const [nome, ...sobrenomeArr] = (med.nome || "Médico").split(" ");
    const sobrenome = sobrenomeArr.join(" ") || "ConsultaJa";
    const crmNumero = (med.crm || "").replace(/\D/g, "");
    const uf = (med.uf || "SP").toUpperCase();

    const payload = {
      data: {
        type: "usuarios",
        attributes: {
          external_id: externalId,
          nome: nome,
          sobrenome: sobrenome,
          cpf: (med.cpf_medico || "").replace(/\D/g, "") || undefined,
          data_nascimento: med.data_nascimento_medico || undefined,
          email: med.email || undefined,
          telefone: (med.telefone || "").replace(/\D/g, "") || undefined,
          especialidade: med.especialidade || undefined,
          board: {
            board_code: "CRM",
            board_number: crmNumero,
            board_state: uf
          }
        }
      }
    };

    // Remove campos undefined
    Object.keys(payload.data.attributes).forEach(k => {
      if (payload.data.attributes[k] === undefined) delete payload.data.attributes[k];
    });

    const postUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
    const postRes = await fetch(postUrl, {
      method: "POST",
      headers: { "Accept": "application/vnd.api+json", "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const postData = await postRes.json();
    console.log("[MEMED] Cadastro prescritor:", JSON.stringify(postData).substring(0, 200));

    const token = postData?.data?.attributes?.token;
    if (!token) return res.status(500).json({ ok: false, error: "Não foi possível obter token Memed", detail: postData });

    await pool.query(`UPDATE medicos SET memed_external_id=$1 WHERE id=$2`, [externalId, medicoId]);
    return res.json({ ok: true, token, externalId });

  } catch(e) {
    console.error("[MEMED] Erro token:", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao obter token Memed" });
  }
});

// ── ADMIN: histórico geral de todos os atendimentos ───────────────────────────
app.get("/api/admin/historico", checkAdmin, async (req, res) => {
  try {
    const { medico_id, data_inicio, data_fim, busca } = req.query;
    let where = `WHERE status IN ('encerrado','expirado','arquivado','assumido')`;
    const params = [];
    if (medico_id) { params.push(medico_id); where += ` AND medico_id=$${params.length}`; }
    if (data_inicio) { params.push(data_inicio); where += ` AND criado_em >= $${params.length}::date`; }
    if (data_fim) { params.push(data_fim); where += ` AND criado_em < ($${params.length}::date + interval '1 day')`; }
    if (busca) { params.push(`%${busca}%`); where += ` AND (nome ILIKE $${params.length} OR tel ILIKE $${params.length} OR cpf ILIKE $${params.length})`; }
    const result = await pool.query(
      `SELECT id,nome,tel,cpf,tipo,triagem,status,medico_id,medico_nome,prontuario,
              criado_em,assumido_em,encerrado_em,data_nascimento,idade,sexo,solicita,status_atendimento
       FROM fila_atendimentos ${where} ORDER BY criado_em DESC LIMIT 200`,
      params
    );
    const medicos = await pool.query(`SELECT id,nome,nome_exibicao FROM medicos WHERE ativo=true ORDER BY nome`);
    return res.json({ ok: true, historico: result.rows, medicos: medicos.rows });
  } catch(e) {
    console.error("[ADMIN-HISTORICO]", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao carregar histórico" });
  }
});

// Rate limiting simples para esqueci-senha
const esqueciRateLimit = new Map();

app.post("/api/medico/esqueci-senha", rlLogin, async (req, res) => {
  const MSG_GENERICA = { ok: true, message: "Se o e-mail existir na plataforma, enviamos as instruções de acesso." };
  try {
    const { email } = req.body || {};
    if (!email) return res.json(MSG_GENERICA);
    const emailNorm = email.trim().toLowerCase();
    // Rate limit: max 3 tentativas por e-mail a cada 15min
    const agora = Date.now();
    const chave = emailNorm;
    const hist = esqueciRateLimit.get(chave) || [];
    const recentes = hist.filter(t => agora - t < 15 * 60 * 1000);
    if (recentes.length >= 3) return res.json(MSG_GENERICA);
    esqueciRateLimit.set(chave, [...recentes, agora]);
    // Busca médico
    const result = await pool.query("SELECT id,nome,email FROM medicos WHERE email=$1 AND ativo=true LIMIT 1",[emailNorm]);
    if (result.rowCount === 0) return res.json(MSG_GENERICA);
    const med = result.rows[0];
    // Gera senha temporária aleatória
    const { randomBytes } = await import("crypto");
    const tempSenha = randomBytes(12).toString("base64url"); // 16 chars base64url
    const tempHash = await bcrypt.hash(tempSenha, 10);
    await pool.query("UPDATE medicos SET senha_hash=$1, precisa_trocar_senha=true WHERE id=$2",[tempHash, med.id]);
    // Envia e-mail
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const PAINEL_URL = "https://painel.consultaja24h.com.br";
    if (RESEND_KEY) {
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:18px 24px"><h2 style="margin:0;color:#051208;font-size:17px">Acesso temporário ao painel médico</h2></div>
        <div style="padding:28px">
          <p style="margin:0 0 16px">Olá, <strong>${med.nome}</strong>.</p>
          <p style="margin:0 0 16px;color:rgba(255,255,255,.7)">Recebemos uma solicitação de recuperação de acesso ao painel médico ConsultaJá24h.</p>
          <p style="margin:0 0 8px;color:rgba(255,255,255,.5);font-size:13px">Sua senha temporária é:</p>
          <div style="background:rgba(255,255,255,.07);border:1px solid rgba(180,224,90,.3);border-radius:10px;padding:16px 20px;text-align:center;margin-bottom:20px">
            <span style="font-family:monospace;font-size:22px;font-weight:700;color:#b4e05a;letter-spacing:3px">${tempSenha}</span>
          </div>
          <p style="margin:0 0 20px;color:rgba(255,255,255,.5);font-size:13px">⚠️ Troque esta senha imediatamente após o login. Ela é válida para um único acesso.</p>
          <a href="${PAINEL_URL}" style="display:inline-block;padding:12px 28px;border-radius:10px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">Acessar o painel</a>
          <p style="margin:24px 0 0;font-size:11px;color:rgba(255,255,255,.2)">Se você não solicitou isso, ignore este e-mail. Sua senha anterior continuará funcionando.</p>
        </div>
      </div>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: "ConsultaJa24h <contato@consultaja24h.com.br>", to: [med.email], subject: "Acesso temporário ao painel médico", html })
      });
    }
    console.log("[ESQUECI-SENHA] Senha temporária gerada para médico #" + med.id);
    return res.json(MSG_GENERICA);
  } catch(e) {
    console.error("[ESQUECI-SENHA] Erro:", e.message);
    return res.json({ ok: true, message: "Se o e-mail existir na plataforma, enviamos as instruções de acesso." });
  }
});

app.post("/api/medico/trocar-senha", checkMedico, async (req, res) => {
  try {
    const { senhaAtual, novaSenha, confirmarSenha } = req.body || {};
    if (!senhaAtual || !novaSenha || !confirmarSenha)
      return res.status(400).json({ ok: false, error: "Preencha todos os campos." });
    if (novaSenha !== confirmarSenha)
      return res.status(400).json({ ok: false, error: "A nova senha e a confirmação não coincidem." });
    if (novaSenha.length < 6)
      return res.status(400).json({ ok: false, error: "A nova senha deve ter pelo menos 6 caracteres." });
    const medicoId = req.medicoId;
    const result = await pool.query("SELECT senha_hash FROM medicos WHERE id=$1",[medicoId]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Médico não encontrado." });
    const senhaOk = await bcrypt.compare(senhaAtual, result.rows[0].senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: "Senha atual incorreta." });
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await pool.query("UPDATE medicos SET senha_hash=$1, precisa_trocar_senha=false WHERE id=$2",[novoHash, medicoId]);
    console.log("[TROCAR-SENHA] Senha atualizada para médico #" + medicoId);
    return res.json({ ok: true });
  } catch(e) {
    console.error("[TROCAR-SENHA] Erro:", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao trocar senha." });
  }
});

app.post("/api/medico/login", rlLogin, async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email||!senha) return res.status(400).json({ ok: false, error: "E-mail e senha sao obrigatorios" });
    const result = await pool.query("SELECT id,nome,nome_exibicao,email,crm,senha_hash,ativo,precisa_trocar_senha FROM medicos WHERE email=$1 LIMIT 1",[email.trim().toLowerCase()]);
    if (result.rowCount===0) return res.status(401).json({ ok: false, error: "Credenciais invalidas" });
    const med = result.rows[0];
    if (!med.ativo) return res.status(403).json({ ok: false, error: "Seu cadastro ainda esta em analise pela equipe da plataforma." });
    const senhaOk = await bcrypt.compare(senha, med.senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: "Credenciais invalidas" });
    const token = jwt.sign({ id: med.id, nome: med.nome, crm: med.crm }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ ok: true, token, precisa_trocar_senha: !!med.precisa_trocar_senha, medico: { id: med.id, nome: med.nome_exibicao||med.nome, email: med.email, crm: med.crm } });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro interno no login" }); }
});

app.get("/api/fila", checkMedico, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,nome,tel,cpf,tipo,triagem,status,medico_id,medico_nome,meet_link,criado_em,data_nascimento,idade,sexo,alergias,cronicas,medicacoes,queixa,solicita,horario_agendado FROM fila_atendimentos WHERE status IN ('aguardando','assumido') AND (horario_agendado IS NULL OR horario_agendado <= NOW() + INTERVAL '15 minutes') ORDER BY criado_em ASC`);
    return res.json({ ok: true, fila: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao carregar fila" }); }
});

// ── BUSCA DE PACIENTES (médico) ───────────────────────────────────────────────
app.get("/api/pacientes/busca", checkMedico, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ ok: true, pacientes: [] });
    const busca = `%${q.trim()}%`;
    const result = await pool.query(
      `SELECT id, nome, tel, cpf, tipo, triagem, queixa, status,
              encerrado_em, prontuario AS prontuario_salvo
       FROM fila_atendimentos
       WHERE status IN ('encerrado','expirado','arquivado')
         AND (nome ILIKE $1 OR cpf ILIKE $1 OR tel ILIKE $1)
       ORDER BY encerrado_em DESC
       LIMIT 50`,
      [busca]
    );
    return res.json({ ok: true, pacientes: result.rows });
  } catch(e) {
    console.error("[BUSCA PACIENTES]", e.message);
    return res.status(500).json({ ok: false, error: "Erro na busca" });
  }
});

app.get("/api/historico", checkMedico, async (req, res) => {
  try {
    const medicoId = req.medico.id;
    const result = await pool.query(
      `SELECT id, nome, tel, tel_documentos, cpf, tipo, triagem, status,
              status_atendimento, documentos_emitidos, medico_nome,
              criado_em, assumido_em, encerrado_em,
              data_nascimento, idade, sexo, alergias, cronicas, medicacoes, queixa, solicita,
              prontuario AS prontuario_salvo
       FROM fila_atendimentos
       WHERE medico_id = $1
         AND status IN ('encerrado', 'expirado', 'arquivado')
         AND encerrado_em >= NOW() - INTERVAL '10 years'
       ORDER BY encerrado_em DESC`,
      [medicoId]
    );
    return res.json({ ok: true, historico: result.rows });
  } catch (err) {
    console.error("Erro em /api/historico:", err);
    return res.status(500).json({ ok: false, error: "Erro ao carregar historico" });
  }
});

app.post("/api/atendimento/assumir", async (req, res) => {
  try {
    const { filaId, medicoId, medicoNome } = req.body || {};
    if (!filaId||!medicoId||!medicoNome) return res.status(400).json({ ok: false, error: "Dados obrigatorios faltando" });
    const result = await pool.query(
      `UPDATE fila_atendimentos SET status='assumido',medico_id=$1,medico_nome=$2,assumido_em=NOW() WHERE id=$3 AND status='aguardando' RETURNING *`,
      [medicoId,medicoNome,filaId]
    );
    if (result.rowCount===0) return res.status(409).json({ ok: false, error: "Paciente ja foi assumido" });
    const at2 = result.rows[0];

    // Da baixa no agendamento para sair do badge de agendamentos
    if (at2.agendamento_id) {
      await pool.query(
        `UPDATE agendamentos SET status='iniciado' WHERE id=$1 AND status='confirmado'`,
        [at2.agendamento_id]
      ).catch(e => console.warn("[ASSUMIR] Update agendamento falhou:", e.message));
    } else {
      // Fallback: busca por tel + janela de 30min ao redor do horario agendado
      await pool.query(
        `UPDATE agendamentos SET status='iniciado'
          WHERE tel=$1
            AND status='confirmado'
            AND horario_agendado BETWEEN NOW() - INTERVAL '30 minutes' AND NOW() + INTERVAL '30 minutes'`,
        [at2.tel]
      ).catch(e => console.warn("[ASSUMIR] Fallback agendamento falhou:", e.message));
    }

    const agora2 = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    appendToSheet("Atendimentos",[agora2,at2.nome||"",at2.tel||"",at2.cpf||"","Assumido",medicoNome||"",at2.triagem||"",at2.tipo||"","",String(filaId)]).catch(e=>console.error("[Sheets]",e));
    return res.json({ ok: true, atendimento: at2 });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao assumir atendimento" }); }
});

app.post("/api/atendimento/meet", async (req, res) => {
  try {
    const { filaId, meetLink } = req.body || {};
    if (!filaId||!meetLink) return res.status(400).json({ ok: false, error: "filaId e meetLink obrigatorios" });
    const result = await pool.query(`UPDATE fila_atendimentos SET meet_link=$1 WHERE id=$2 RETURNING id,meet_link`,[meetLink.trim(),filaId]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    return res.json({ ok: true, meet_link: result.rows[0].meet_link });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao salvar link" }); }
});

// ── POST /api/atendimento/vincular-order ─────────────────────────────────────
// Vincula o pagbank_order_id ao atendimento assim que a order e criada no PagBank.
// Chamado pelo frontend apos /api/pagbank/order + /api/notify.
// Idempotente: so grava se ainda nao tiver order vinculada.
app.post("/api/atendimento/vincular-order", async (req, res) => {
  try {
    const { atendimentoId, orderId } = req.body || {};
    if (!atendimentoId || !orderId)
      return res.status(400).json({ ok: false, error: "atendimentoId e orderId obrigatorios" });

    await pool.query(
      `UPDATE fila_atendimentos
          SET pagbank_order_id = $2
        WHERE id = $1
          AND pagbank_order_id IS NULL`,
      [atendimentoId, orderId]
    );

    console.log("[VINCULAR-ORDER] atendimento #" + atendimentoId + " <- order " + orderId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[VINCULAR-ORDER]", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao vincular order" });
  }
});

// ── GET /api/aprovacao/liberar ────────────────────────────────────────────────
app.get("/api/aprovacao/liberar", async (req, res) => {
  const { id, token } = req.query;
  const page = (titulo, cor, icone, msg) => res.send(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><style>body{font-family:sans-serif;background:#060d0b;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{max-width:400px;text-align:center;padding:32px 24px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:16px}.icon{font-size:2.8rem;margin-bottom:14px}.title{font-size:1.15rem;font-weight:600;color:${cor};margin-bottom:8px}.msg{font-size:.85rem;color:rgba(255,255,255,.45);line-height:1.65}</style></head><body><div class="box"><div class="icon">${icone}</div><div class="title">${titulo}</div><p class="msg">${msg}</p></div></body></html>`
  );
  if (!id || !token) return page("Erro", "#ff5f57", "❌", "Link inválido.");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (String(payload.atendimentoId) !== String(id) || payload.acao !== "aprovacao")
      return page("Erro", "#ff5f57", "❌", "Token inválido.");
    const row = await pool.query(`SELECT status, aprovacao_token FROM fila_atendimentos WHERE id=$1`,[id]);
    if (!row.rows[0]) return page("Não encontrado", "#ffbd2e", "⚠️", "Atendimento não encontrado.");
    const { status, aprovacao_token } = row.rows[0];
    if (status === "cancelado")   return page("Já cancelado",  "#ffbd2e", "⚠️", "Este atendimento já foi cancelado.");
    if (["aguardando","assumido","encerrado"].includes(status))
      return page("Já liberado", "#5ee0a0", "✅", "Atendimento já liberado para os médicos.");
    if (status !== "aguardando_aprovacao")
      return page("Status inválido", "#ffbd2e", "⚠️", `Status atual: ${status}.`);
    if (aprovacao_token !== token)
      return page("Token expirado", "#ffbd2e", "⚠️", "Este link já foi usado ou expirou.");
    await liberarAtendimentoParaMedicos(Number(id));
    return page("Liberado!", "#5ee0a0", "✅", "Atendimento liberado. O paciente será conectado ao médico.");
  } catch(e) {
    if (e.name === "TokenExpiredError")
      return page("Link expirado", "#ffbd2e", "⚠️", "O link expirou (10 min). O atendimento pode ter sido liberado automaticamente.");
    console.error("[APROVACAO] Erro ao liberar:", e.message);
    return page("Erro", "#ff5f57", "❌", "Erro interno. Tente novamente.");
  }
});

// ── GET /api/aprovacao/cancelar ───────────────────────────────────────────────
app.get("/api/aprovacao/cancelar", async (req, res) => {
  const { id, token } = req.query;
  const page = (titulo, cor, icone, msg) => res.send(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><style>body{font-family:sans-serif;background:#060d0b;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{max-width:400px;text-align:center;padding:32px 24px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:16px}.icon{font-size:2.8rem;margin-bottom:14px}.title{font-size:1.15rem;font-weight:600;color:${cor};margin-bottom:8px}.msg{font-size:.85rem;color:rgba(255,255,255,.45);line-height:1.65}</style></head><body><div class="box"><div class="icon">${icone}</div><div class="title">${titulo}</div><p class="msg">${msg}</p></div></body></html>`
  );
  if (!id || !token) return page("Erro", "#ff5f57", "❌", "Link inválido.");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (String(payload.atendimentoId) !== String(id) || payload.acao !== "aprovacao")
      return page("Erro", "#ff5f57", "❌", "Token inválido.");
    const row = await pool.query(`SELECT status, aprovacao_token FROM fila_atendimentos WHERE id=$1`,[id]);
    if (!row.rows[0]) return page("Não encontrado", "#ffbd2e", "⚠️", "Atendimento não encontrado.");
    const { status, aprovacao_token } = row.rows[0];
    if (status === "cancelado")    return page("Já cancelado", "#ffbd2e", "⚠️", "Este atendimento já foi cancelado.");
    if (status !== "aguardando_aprovacao")
      return page("Ação indisponível", "#ffbd2e", "⚠️", `O atendimento já está em status: ${status}.`);
    if (aprovacao_token !== token)
      return page("Token expirado", "#ffbd2e", "⚠️", "Este link já foi usado ou expirou.");
    await pool.query(
      `UPDATE fila_atendimentos SET status='cancelado', aprovacao_token=NULL, encerrado_em=NOW() WHERE id=$1 AND status='aguardando_aprovacao'`,
      [id]
    );
    console.log(`[CANCELADO] Atendimento #${id} cancelado pelo admin.`);
    return page("Cancelado", "#ff5f57", "❌", "Pagamento não confirmado. Atendimento cancelado.");
  } catch(e) {
    if (e.name === "TokenExpiredError")
      return page("Link expirado", "#ffbd2e", "⚠️", "O link expirou. Verifique o status no painel.");
    console.error("[APROVACAO] Erro ao cancelar:", e.message);
    return page("Erro", "#ff5f57", "❌", "Erro interno. Tente novamente.");
  }
});

app.post("/api/atendimento/encerrar", async (req, res) => {
  try {
    const { filaId, status, documentos_emitidos } = req.body || {};
    if (!filaId) return res.status(400).json({ ok: false, error: "filaId e obrigatorio" });
    const result = await pool.query(
      `UPDATE fila_atendimentos SET status='encerrado',encerrado_em=NOW(),status_atendimento=$2,documentos_emitidos=$3 WHERE id=$1 RETURNING *`,
      [filaId,status||"Encerrado",documentos_emitidos||"Nenhum"]
    );
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    const at = result.rows[0];
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Encerrado",at.medico_nome||"",at.triagem||"",at.tipo||"",at.documentos_emitidos||"",String(at.id)]).catch(e=>console.error("[Sheets]",e));
    return res.json({ ok: true, atendimento: at });
  } catch (err) { console.error("Erro em /api/atendimento/encerrar:", err); return res.status(500).json({ ok: false, error: "Erro ao encerrar atendimento" }); }
});

app.post("/api/atendimento/prontuario", autenticarMedico, async (req, res) => {
  const { filaId, prontuario } = req.body;
  if (!filaId || prontuario === undefined) {
    return res.status(400).json({ ok: false, error: "filaId e prontuario sao obrigatorios" });
  }
  try {
    // Permite salvar se for o médico do atendimento OU se o atendimento estiver sendo encerrado
    // (medico_id pode ser 0 quando assumido via e-mail pelo admin)
    const r = await pool.query(
      "UPDATE fila_atendimentos SET prontuario = $1 WHERE id = $2 AND (medico_id = $3 OR medico_id = 0 OR medico_id IS NULL OR $3 = (SELECT id FROM medicos WHERE email='gustavosgbf@gmail.com' LIMIT 1))",
      [prontuario, filaId, req.medico.id]
    );
    if (r.rowCount === 0) {
      // Fallback: tenta salvar sem restrição de médico (para casos de encerramento)
      const r2 = await pool.query(
        "UPDATE fila_atendimentos SET prontuario = $1 WHERE id = $2",
        [prontuario, filaId]
      );
      if (r2.rowCount === 0) {
        return res.status(403).json({ ok: false, error: "Atendimento nao encontrado." });
      }
    }
    console.log("[prontuario] Salvo para atendimento #" + filaId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[prontuario] Erro ao salvar:", err.message);
    res.status(500).json({ ok: false, error: "Erro ao salvar prontuario" });
  }
});

app.post("/api/plantao/entrar", async (req, res) => {
  try {
    const auth = req.headers["authorization"]||"";
    const decoded = jwt.verify(auth.replace("Bearer ",""), JWT_SECRET);
    await pool.query("UPDATE medicos SET status_online=true WHERE id=$1",[decoded.id]);
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: true }); }
});

app.post("/api/plantao/sair", async (req, res) => {
  try {
    const auth = req.headers["authorization"]||"";
    const decoded = jwt.verify(auth.replace("Bearer ",""), JWT_SECRET);
    await pool.query("UPDATE medicos SET status_online=false WHERE id=$1",[decoded.id]);
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: true }); }
});

app.get("/relatorio", checkAdmin, async (req, res) => {
  try {
    const [atenRes, idRes, consRes] = await Promise.all([
      pool.query(`SELECT id,nome,tel,cpf,tipo,triagem,status,medico_nome,documentos_emitidos,criado_em,encerrado_em FROM fila_atendimentos ORDER BY criado_em DESC`),
      pool.query(`SELECT nome,tel,data,ip FROM identificacoes ORDER BY id DESC LIMIT 200`),
      pool.query(`SELECT nome,tel,versao,data,ip FROM consentimentos ORDER BY id DESC LIMIT 200`),
    ]);
    const atend=atenRes.rows, ident=idRes.rows, cons=consRes.rows;
    const total=atend.length, encerrados=atend.filter(a=>a.status==='encerrado').length,
          aguardando=atend.filter(a=>a.status==='aguardando').length, assumidos=atend.filter(a=>a.status==='assumido').length;
    const css=`*{box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:1100px;margin:0 auto}h1{color:#b4e05a;margin:0 0 4px}h2{color:#b4e05a;font-size:1rem;text-transform:uppercase;letter-spacing:.1em;margin:36px 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}p.sub{color:rgba(255,255,255,.35);font-size:.82rem;margin:0 0 28px}table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:.83rem}th{text-align:left;padding:9px 11px;background:rgba(180,224,90,.07);color:#b4e05a;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}td{padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}tr:hover td{background:rgba(255,255,255,.02)}.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}.badge.encerrado{background:rgba(94,224,160,.1);color:#5ee0a0}.badge.aguardando{background:rgba(255,189,46,.1);color:#ffbd2e}.badge.assumido{background:rgba(180,224,90,.1);color:#b4e05a}.badge.expirado{background:rgba(255,100,100,.1);color:#ff6464}.badge.triagem{background:rgba(180,180,180,.1);color:#aaa}.badge.chat{background:rgba(37,211,102,.1);color:#25d366}.badge.video{background:rgba(94,224,160,.1);color:#5ee0a0}.badge.lgpd{background:rgba(66,133,244,.12);color:#7baeff}.totais{display:flex;gap:20px;flex-wrap:wrap;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:16px 20px;margin-bottom:28px}.t-item span{display:block;font-size:.68rem;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}.t-item strong{font-size:1.4rem;color:#b4e05a}a{color:#5ee0a0;text-decoration:none}a:hover{text-decoration:underline}.nav{display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap}.nav a{padding:6px 16px;border-radius:8px;background:rgba(180,224,90,.08);border:1px solid rgba(180,224,90,.18);color:#b4e05a;font-size:.8rem;font-weight:600}.dim{color:rgba(255,255,255,.35);font-size:.76rem}.triagem-cell{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.77rem;color:rgba(255,255,255,.55)}`;
    const sp = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : '';
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Painel Admin</title><style>${css}</style></head><body>
    <h1>Painel Administrativo - ConsultaJa24h</h1><p class="sub">Dados em tempo real - PostgreSQL</p>
    <div class="nav"><a href="/relatorio${sp}">Relatorio geral</a><a href="/identificacoes${sp}">Identificacoes</a><a href="/consentimentos${sp}">Consentimentos</a></div>
    <div class="totais"><div class="t-item"><span>Total</span><strong>${total}</strong></div><div class="t-item"><span>Encerrados</span><strong>${encerrados}</strong></div><div class="t-item"><span>Aguardando</span><strong>${aguardando}</strong></div><div class="t-item"><span>Em atendimento</span><strong>${assumidos}</strong></div><div class="t-item"><span>Identificacoes</span><strong>${ident.length}</strong></div><div class="t-item"><span>Consentimentos</span><strong>${cons.length}</strong></div></div>
    <h2>Atendimentos (${total})</h2><table><tr><th>#</th><th>Data/Hora</th><th>Paciente</th><th>CPF</th><th>WhatsApp</th><th>Modalidade</th><th>Medico</th><th>Status</th><th>Triagem</th><th>Documentos</th><th>Encerrado em</th></tr>
    ${atend.map(a=>{
      const d=a.criado_em?new Date(a.criado_em).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}):'--';
      const enc=a.encerrado_em?new Date(a.encerrado_em).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}):'--';
      const tel=String(a.tel||'').replace(/\D/g,'');
      const tipo=a.tipo==='video'?'<span class="badge video">Video</span>':'<span class="badge chat">Chat</span>';
      const st=`<span class="badge ${a.status}">${a.status}</span>`;
      const triagem=String(a.triagem||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<tr><td class="dim">${a.id}</td><td class="dim" style="white-space:nowrap">${d}</td><td><strong>${a.nome||'--'}</strong></td><td class="dim">${a.cpf||'--'}</td><td><a href="https://wa.me/55${tel}">${a.tel||'--'}</a></td><td>${tipo}</td><td>${a.medico_nome||'--'}</td><td>${st}</td><td><div class="triagem-cell" title="${triagem}">${triagem||'--'}</div></td><td class="dim">${a.documentos_emitidos||'--'}</td><td class="dim" style="white-space:nowrap">${enc}</td></tr>`;
    }).join('')}
    </table>
    <h2>Identificacoes (${ident.length})</h2><table><tr><th>Data/Hora</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
    ${ident.map(i=>`<tr><td class="dim">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">${i.tel||'--'}</a></td><td class="dim" style="font-size:.73rem">${i.ip||'--'}</td></tr>`).join('')}
    </table>
    <h2>Consentimentos LGPD (${cons.length})</h2><table><tr><th>Data/Hora</th><th>Nome</th><th>WhatsApp</th><th>Versao</th><th>IP</th></tr>
    ${cons.map(i=>`<tr><td class="dim">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'--'}</a></td><td><span class="badge lgpd">${i.versao||'v1.0'}</span></td><td class="dim" style="font-size:.73rem">${i.ip||'--'}</td></tr>`).join('')}
    </table>
    <p class="dim" style="margin-top:32px">Gerado em ${new Date().toLocaleString('pt-BR',{timeZone:'America/Fortaleza'})}</p></body></html>`;
    return res.send(html);
  } catch (e) { console.error("Erro em /relatorio:", e); return res.status(500).send("Erro: " + e.message); }
});

app.get("/identificacoes", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT nome,tel,data,ip FROM identificacoes ORDER BY id DESC");
    const lista=result.rows;
    const sp=req.query.senha?`?senha=${encodeURIComponent(req.query.senha)}`:'';
    if (lista.length===0) return res.send('<h2>Nenhuma identificacao registrada.</h2>');
    res.send(`<html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}h1{color:#b4e05a}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;text-transform:uppercase}td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}a{color:#5ee0a0}.back{display:inline-block;margin-bottom:20px;color:#b4e05a;font-size:.82rem}</style></head><body>
    <a class="back" href="/relatorio${sp}">Voltar ao relatorio</a><h1>Identificacoes</h1><p style="color:rgba(255,255,255,.4)">${lista.length} registros</p>
    <table><tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
    ${lista.map(i=>`<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}" >📱 ${i.tel||'--'}</a></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'--'}</td></tr>`).join('')}
    </table></body></html>`);
  } catch (e) { res.status(500).send("Erro: " + e.message); }
});

app.get("/consentimentos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT nome,tel,versao,data,ip FROM consentimentos ORDER BY id DESC");
    const lista=result.rows;
    const sp=req.query.senha?`?senha=${encodeURIComponent(req.query.senha)}`:'';
    if (lista.length===0) return res.send('<h2>Nenhum consentimento registrado.</h2>');
    res.send(`<html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}h1{color:#b4e05a}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;text-transform:uppercase}td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}.badge{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(94,224,160,.1);color:#5ee0a0;font-size:.75rem}a{color:#5ee0a0}.back{display:inline-block;margin-bottom:20px;color:#b4e05a;font-size:.82rem}</style></head><body>
    <a class="back" href="/relatorio${sp}">Voltar ao relatorio</a><h1>Consentimentos LGPD</h1><p style="color:rgba(255,255,255,.4)">${lista.length} aceites</p>
    <table><tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>Versao</th><th>IP</th></tr>
    ${lista.map(i=>`<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'--'}</a></td><td><span class="badge">${i.versao||'v1.0'}</span></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'--'}</td></tr>`).join('')}
    </table></body></html>`);
  } catch (e) { res.status(500).send("Erro: " + e.message); }
});

app.get("/api/disponibilidade", async (req, res) => {
  try {
    const agora = new Date();
    const HORA_INICIO=8, HORA_FIM=23;       // atendimento imediato: 14h-23h
    const HORA_AGEND_INICIO=8, HORA_AGEND_FIM=23; // agendamento: dia todo 8h-23h
    const hora = parseInt(new Intl.DateTimeFormat("en-US",{timeZone:"America/Fortaleza",hour:"2-digit",hour12:false}).formatToParts(agora).find(p=>p.type==="hour").value);
    const dentroDoHorario = hora>=HORA_INICIO && hora<HORA_FIM;
    const [medRes,filaRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM medicos WHERE status_online=true AND ativo=true"),
      pool.query("SELECT COUNT(*) FROM fila_atendimentos WHERE status='aguardando'")
    ]);
    const medicosOnline=parseInt(medRes.rows[0].count)||0;
    const pacientesAguardando=parseInt(filaRes.rows[0].count)||0;
    const disponivel=dentroDoHorario;
    let tempoEstimado=5;
    if (medicosOnline>0) tempoEstimado=Math.max(3,Math.ceil((pacientesAguardando/medicosOnline)*6));
    else if (dentroDoHorario) tempoEstimado=Math.max(8,pacientesAguardando*6+5);
    let status='verde';
    if (!disponivel) status='vermelho';
    else if (tempoEstimado>12||medicosOnline===0) status='amarelo';
    let horarioRetorno=null;
    let mensagem=disponivel?(medicosOnline>0?`${medicosOnline} medico(s) disponivel(is)`:'Atendimento disponivel'):'Atendimento indisponivel no momento';
    const agoraFtz = new Date(agora.getTime() - 3*60*60*1000);
    if (!disponivel) {
      const diaRetorno = new Date(Date.UTC(
        agoraFtz.getUTCFullYear(), agoraFtz.getUTCMonth(),
        hora>=HORA_FIM ? agoraFtz.getUTCDate()+1 : agoraFtz.getUTCDate(),
        HORA_INICIO+3, 0, 0, 0
      ));
      horarioRetorno=diaRetorno.toLocaleString("pt-BR",{timeZone:"America/Fortaleza",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});
      mensagem=`Atendimento disponivel das ${HORA_INICIO}h as ${HORA_FIM}h`;
    }
    const horariosAgendamento=[];
    // Agendamentos sempre disponíveis (dia todo), mesmo quando atendimento imediato está fechado
    {
      const diaBase = new Date(agoraFtz);
      if (hora >= HORA_AGEND_FIM) diaBase.setUTCDate(diaBase.getUTCDate() + 1);
      let count = 0;
      for (let h = HORA_AGEND_INICIO; h < HORA_AGEND_FIM && count < 16; h++) {
        for (const m of [0, 20, 40]) {
          if (count >= 16) break;
          const slot = new Date(Date.UTC(
            diaBase.getUTCFullYear(), diaBase.getUTCMonth(), diaBase.getUTCDate(),
            h + 3, m, 0, 0
          ));
          if (slot.getTime() < agora.getTime() + 10*60*1000) continue;
          horariosAgendamento.push({
            label: slot.toLocaleTimeString("pt-BR", {hour:"2-digit", minute:"2-digit", timeZone:"America/Fortaleza"}),
            iso: slot.toISOString()
          });
          count++;
        }
      }
    }
    res.json({ok:true,disponivel,medicosOnline,pacientesAguardando,tempoEstimado,status,mensagem,horarioRetorno,horariosAgendamento,horaAtual:hora,horaInicio:HORA_INICIO,horaFim:HORA_FIM,horaAgendInicio:HORA_AGEND_INICIO,horaAgendFim:HORA_AGEND_FIM});
  } catch(e) {
    console.error("Erro em /api/disponibilidade:", e);
    res.json({ok:false,disponivel:true,medicosOnline:0,tempoEstimado:5,status:'verde',mensagem:'Verificando...',horariosAgendamento:[]});
  }
});

app.post("/api/agendamento/criar", async (req, res) => {
  try {
    const { nome,tel,tel_documentos,cpf,modalidade,horario_agendado,email } = req.body||{};
    if (!nome||!tel||!horario_agendado) return res.status(400).json({ok:false,error:"nome, tel e horario_agendado sao obrigatorios"});
    const slotStart=new Date(horario_agendado);
    if (Number.isNaN(slotStart.getTime())) {
      return res.status(400).json({ ok: false, error: "horario_agendado invalido" });
    }
    const slotEnd=new Date(slotStart.getTime()+20*60*1000);
    const existentes=await pool.query(`SELECT COUNT(*) FROM agendamentos WHERE horario_agendado>=$1 AND horario_agendado<$2 AND status IN ('pendente','confirmado')`,[slotStart.toISOString(),slotEnd.toISOString()]);
    if (parseInt(existentes.rows[0].count)>=3) return res.status(409).json({ok:false,error:"Horario indisponivel. Escolha outro horario."});
    const result=await pool.query(`INSERT INTO agendamentos (nome,tel,tel_documentos,cpf,modalidade,horario_agendado,status,email) VALUES ($1,$2,$3,$4,$5,$6,'pendente',$7) RETURNING id`,[nome,tel,tel_documentos||tel,cpf||"",modalidade||"chat",horario_agendado,email||null]);
    return res.json({ok:true,agendamentoId:result.rows[0].id});
  } catch(e) { console.error("Erro em /api/agendamento/criar:", e); return res.status(500).json({ok:false,error:"Erro ao criar agendamento"}); }
});

app.post("/api/agendamento/confirmar", async (req, res) => {
  try {
    const { agendamentoId, paymentId } = req.body||{};
    if (!agendamentoId) return res.status(400).json({ok:false,error:"agendamentoId e obrigatorio"});
    const result=await pool.query(`UPDATE agendamentos SET status='confirmado',payment_id=$2 WHERE id=$1 AND status='pendente' RETURNING *`,[agendamentoId,paymentId||null]);
    if (result.rowCount===0) return res.status(404).json({ok:false,error:"Agendamento nao encontrado ou ja confirmado"});
    const ag=result.rows[0];
    const horarioFormatado=new Date(ag.horario_agendado).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const tipoLabel=ag.modalidade==="video"?"Video":"Chat";
    // E-mail de confirmação para o paciente
    if (ag.email) {
      const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
      enviarEmailConfirmacaoPaciente({
        nome: ag.nome, email: ag.email, horarioFormatado, modalidade: ag.modalidade,
        linkConsulta: `${SITE_URL}/triagem.html`
      }).catch(()=>{});
    }
    return res.json({ok:true,agendamento:ag,horarioFormatado});
  } catch(e) { console.error("Erro em /api/agendamento/confirmar:", e); return res.status(500).json({ok:false,error:"Erro ao confirmar agendamento"}); }
});

// FIX PROBLEMA 4: retorna dados completos do atendimento criado
app.post("/api/agendamento/:id/iniciar", async (req, res) => {
  try {
    const auth=req.headers["authorization"]||"";
    let medicoId, medicoNome;
    try { const d=jwt.verify(auth.replace("Bearer ",""),JWT_SECRET); medicoId=d.id; medicoNome=d.nome; }
    catch(e) { return res.status(401).json({ok:false,error:"Token invalido"}); }
    // Lock: tenta marcar como 'iniciado' atomicamente — só funciona se ainda estiver 'confirmado'
    const lock = await pool.query(
      `UPDATE agendamentos SET status='iniciado' WHERE id=$1 AND status='confirmado' RETURNING *`,
      [req.params.id]
    );
    if (lock.rowCount===0) return res.status(409).json({ok:false,error:"Consulta já foi iniciada por outro médico"});
    const ag = { rows: [lock.rows[0]], rowCount: 1 };
    const a=ag.rows[0];
    // Tenta pegar triagem real do paciente
    const preReg=await pool.query(`SELECT triagem FROM fila_atendimentos WHERE tel=$1 AND status IN ('triagem','aguardando') ORDER BY criado_em DESC LIMIT 1`,[a.tel]);
    const triagem=preReg.rowCount>0?(preReg.rows[0].triagem||'(Agendamento)'):'(Agendamento — triagem pendente)';
    const insert=await pool.query(
      `INSERT INTO fila_atendimentos (nome,tel,tel_documentos,cpf,tipo,triagem,status,medico_id,medico_nome,assumido_em)
       VALUES ($1,$2,$3,$4,$5,$6,'assumido',$7,$8,NOW()) RETURNING *`,
      [a.nome,a.tel,a.tel_documentos||a.tel,a.cpf||"",a.modalidade||"chat",triagem,medicoId,medicoNome]
    );
    const atendimento = insert.rows[0];
    // status já atualizado atomicamente no lock acima
    const SITE_URL=process.env.SITE_URL||"https://consultaja24h.com.br";
    return res.json({
      ok:true,
      atendimentoId: atendimento.id,
      atendimento,   // retorna objeto completo para o painel usar direto
      linkRetorno:`${SITE_URL}/triagem.html?consulta=${atendimento.id}`
    });
  } catch(e) { console.error("Erro em /api/agendamento/:id/iniciar:", e); return res.status(500).json({ok:false,error:"Erro ao iniciar consulta"}); }
});

app.post("/api/agendamento/:id/cancelar", checkMedico, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE agendamentos SET status='cancelado' WHERE id=$1 AND status='confirmado' RETURNING id`,
      [req.params.id]
    );
    if (result.rowCount===0) return res.status(404).json({ok:false,error:"Agendamento não encontrado ou já cancelado"});
    return res.json({ok:true});
  } catch(e) { return res.status(500).json({ok:false,error:"Erro ao cancelar agendamento"}); }
});

app.get("/api/agendamentos", checkMedico, async (req, res) => {
  try {
    const result=await pool.query(`SELECT id,nome,tel,tel_documentos,cpf,modalidade,horario_agendado,status,criado_em FROM agendamentos WHERE status IN ('confirmado','pendente') ORDER BY horario_agendado ASC`);
    return res.json({ok:true,agendamentos:result.rows});
  } catch(e) { return res.status(500).json({ok:false,error:"Erro ao listar agendamentos"}); }
});

app.get("/api/test-db", async (req, res) => {
  try { const result=await pool.query("SELECT NOW()"); res.json(result.rows[0]); }
  catch (err) { res.status(500).json({error:err.message}); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
