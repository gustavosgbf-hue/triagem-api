import express from "express";
import cors from "cors";
import { google } from "googleapis";
import pg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MP_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY não definida"); process.exit(1); }
if (!MP_TOKEN) { console.error("MP_ACCESS_TOKEN não definida"); process.exit(1); }

// ── INIT BANCO — cria tabelas e colunas se não existirem ────────────
async function initDB() {
  try {
    // Tabela de mensagens de chat
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensagens (
        id SERIAL PRIMARY KEY,
        atendimento_id INTEGER NOT NULL,
        autor TEXT NOT NULL,
        autor_id INTEGER,
        texto TEXT NOT NULL,
        criado_em TIMESTAMP DEFAULT NOW()
      )
    `);

    // Tabela de agendamentos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agendamentos (
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
      )
    `);

    // Colunas extras em fila_atendimentos
    const cols = [
      ['status_atendimento', 'TEXT'],
      ['documentos_emitidos', 'TEXT'],
      ['meet_link', 'TEXT'],
      ['tel_documentos', 'TEXT'],
      ['idade', 'TEXT'],
      ['sexo', 'TEXT'],
      ['alergias', 'TEXT'],
      ['cronicas', 'TEXT'],
      ['medicacoes', 'TEXT'],
      ['queixa', 'TEXT'],
      ['assumido_em', 'TIMESTAMP'],
      ['encerrado_em', 'TIMESTAMP'],
    ];
    for (const [col, tipo] of cols) {
      await pool.query(`ALTER TABLE fila_atendimentos ADD COLUMN IF NOT EXISTS ${col} ${tipo}`);
    }

    console.log("[DB] Tabelas e colunas verificadas com sucesso");
  } catch (e) {
    console.error("[DB] Erro no initDB:", e.message);
  }
}
initDB();

// ── GOOGLE SHEETS ─────────────────────────────────────────────────
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
    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
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

// ── OPENAI ───────────────────────────────────────────────
// Parser de triagem estruturada (extrai campos do resumo da IA)
function parsearTriagem(summary) {
  if (!summary) return {};
  const campos = {};
  const mapa = [
    { chave: 'queixa',     padroes: ['queixa','queixa principal','queixa:','problema'] },
    { chave: 'idade',      padroes: ['idade','anos'] },
    { chave: 'sexo',       padroes: ['sexo','gênero','genero'] },
    { chave: 'alergias',   padroes: ['alergia','alergias'] },
    { chave: 'cronicas',   padroes: ['comorbidade','comorbidades','doenças crônicas','doencas cronicas','histórico','historico'] },
    { chave: 'medicacoes', padroes: ['medicação','medicacoes','medicamentos','remédios'] },
  ];
  // Tenta extrair de linhas no formato "Campo: valor"
  const linhas = summary.split(/[;\n]/);
  for (const linha of linhas) {
    const colonIdx = linha.indexOf(':');
    if (colonIdx < 1) continue;
    const chaveRaw = linha.slice(0, colonIdx).trim().toLowerCase();
    const valor = linha.slice(colonIdx + 1).trim();
    if (!valor || valor === '—' || valor === '-') continue;
    for (const { chave, padroes } of mapa) {
      if (padroes.some(p => chaveRaw.includes(p))) {
        campos[chave] = campos[chave] || valor;
        break;
      }
    }
  }
  // Fallback: tenta extrair idade com regex
  if (!campos.idade) {
    const m = summary.match(/(\d{1,3})\s*anos/i);
    if (m) campos.idade = m[1] + ' anos';
  }
  if (!campos.sexo) {
    if (/feminino|mulher|\bF\b/i.test(summary)) campos.sexo = 'Feminino';
    else if (/masculino|homem|\bM\b/i.test(summary)) campos.sexo = 'Masculino';
  }
  return campos;
}
async function callOpenAI({ system, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: String(system ?? "") },
        ...(messages || [])
          .filter((m) => m?.role !== "system")
          .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
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
    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: "Payload inválido" });
    }
    const out = await callOpenAI({ system, messages });
    if (!out.ok) {
      return res.status(503).json({ text: "Sistema temporariamente indisponível. Tente novamente em instantes." });
    }
    return res.json({ text: out.text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Erro interno temporário." });
  }
}

// ── ADMIN — PROTEÇÃO ──────────────────────────────
function checkAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"] || req.query.senha;
  const senhaAdmin = process.env.ADMIN_PASSWORD;
  if (!senhaAdmin) return res.status(500).send("ADMIN_PASSWORD não configurada");
  if (!senha || senha !== senhaAdmin) return res.status(403).send("Acesso negado");
  next();
}

// ── ROTAS ABERTAS ────────────────────────────────────────
app.post("/api/triage", handleChat);
app.post("/api/doctor", handleChat);

// ── MERCADO PAGO — GERAR PIX ─────────────────────────────
app.post("/api/payment", async (req, res) => {
  try {
    const { email, nome } = req.body || {};
    const idempotency = `consult-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${MP_TOKEN}`,
        "X-Idempotency-Key": idempotency,
      },
      body: JSON.stringify({
        transaction_amount: 49.9,
        description: "Consulta Médica Online – Pronto Atendimento Online",
        payment_method_id: "pix",
        payer: {
          email: email || "paciente@prontoatendimento.com",
          first_name: (nome || "Paciente").split(" ")[0],
          last_name: (nome || "Paciente").split(" ").slice(1).join(" ") || "Online",
        },
      }),
    });

    const data = await mpRes.json();
    if (!mpRes.ok) {
      console.error("MP error:", data);
      return res.status(500).json({ ok: false, error: data.message || "Erro ao gerar pagamento" });
    }

    return res.json({
      ok: true,
      payment_id: data.id,
      status: data.status,
      qr_code: data.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64,
    });
  } catch (e) {
    console.error("Erro em /api/payment:", e);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

// ── MERCADO PAGO — CHECAR STATUS ─────────────────────────
app.get("/api/payment/:id", async (req, res) => {
  try {
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${req.params.id}`, {
      headers: { Authorization: `Bearer ${MP_TOKEN}` },
    });
    const data = await mpRes.json();
    if (!mpRes.ok) {
      return res.status(500).json({ ok: false, error: data.message || "Erro ao consultar pagamento" });
    }
    return res.json({ ok: true, status: data.status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao consultar pagamento" });
  }
});

/// ── ATUALIZAR TRIAGEM (após IA coletar dados) ─────────────────────────
app.post("/api/atendimento/atualizar-triagem", async (req, res) => {
  try {
    const { atendimentoId, triagem } = req.body || {};
    if (!atendimentoId || !triagem) return res.status(400).json({ ok: false, error: "atendimentoId e triagem são obrigatórios" });
    const campos = parsearTriagem(triagem);
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET triagem = $2, queixa = $3, idade = $4, sexo = $5,
           alergias = $6, cronicas = $7, medicacoes = $8
       WHERE id = $1
       RETURNING id, nome, tel, cpf, tipo, triagem, medico_nome`,
      [
        atendimentoId, triagem,
        campos.queixa || triagem,
        campos.idade || "",
        campos.sexo || "",
        campos.alergias || "",
        campos.cronicas || "",
        campos.medicacoes || "",
      ]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento não encontrado" });
    const at = result.rows[0];
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    appendToSheet("Atendimentos", [
      agora, at.nome || "", at.tel || "", at.cpf || "",
      "Triagem Completa", at.medico_nome || "", triagem, at.tipo || "", "", String(at.id),
    ]).catch(e => console.error("[Sheets] Erro ao salvar triagem completa:", e));
    return res.json({ ok: true, atendimentoId: at.id });
  } catch (e) {
    console.error("Erro em /api/atendimento/atualizar-triagem:", e);
    return res.status(500).json({ ok: false, error: "Erro ao atualizar triagem" });
  }
});

/ ── NOTIFICAR MÉDICOS ────────────────────────────────────
app.post("/api/notify", async (req, res) => {
  try {
    const { nome, tel, tel_documentos, cpf, triagem, tipo } = req.body || {};
    const tipoConsulta = tipo === "video" ? "video" : "chat";
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const telLimpo = (tel || "").replace(/\D/g, "");
    const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://triagem-api.onrender.com";
    const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
    const tipoLabel = tipoConsulta === "video" ? "🎥 Vídeo" : "💬 Chat";

    // Parseia campos estruturados da triagem
    const campos = parsearTriagem(triagem);

    // ── 1. CRIAR ATENDIMENTO NO BANCO PRIMEIRO (para ter o ID) ──
    const insertResult = await pool.query(
      `INSERT INTO fila_atendimentos (nome, tel, tel_documentos, cpf, tipo, triagem, status, queixa, idade, sexo, alergias, cronicas, medicacoes)
       VALUES ($1, $2, $3, $4, $5, $6, 'aguardando', $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        nome || "—",
        tel || "—",
        tel_documentos || tel || "—",
        cpf || "—",
        tipoConsulta,
        triagem || "",
        campos.queixa || triagem || "",
        campos.idade || "",
        campos.sexo || "",
        campos.alergias || "",
        campos.cronicas || "",
        campos.medicacoes || "",
      ]
    );

    const atendimentoId = insertResult.rows[0]?.id;
    const linkRetorno = `${SITE_URL}/triagem.html?consulta=${atendimentoId}`;

    // Responde imediatamente ao frontend para não bloquear o paciente
    res.json({ ok: true, atendimentoId, linkRetorno });

    // ── 2. EMAIL + SHEETS (em background, não bloqueia a resposta) ──
    function linkMedico(nomeMedico) {
      return `${BASE_URL}/atender?medico=${encodeURIComponent(nomeMedico)}&paciente=${encodeURIComponent(nome || "")}&tel=${encodeURIComponent(telLimpo)}`;
    }

    function montarTabelaTriagem(texto) {
      if (!texto) return '<tr><td colspan="2" style="padding:8px 12px;color:rgba(255,255,255,.5)">—</td></tr>';
      return texto.split(/[,;]\s*(?=[A-ZÀÁÂÃÉÊÍÓÔÕÚÇ])/i).map((item) => {
        const colonIdx = item.indexOf(":");
        if (colonIdx > 0) {
          const key = item.slice(0, colonIdx).trim();
          const val = item.slice(colonIdx + 1).trim();
          return `<tr>
            <td style="padding:9px 14px;color:rgba(255,255,255,.45);font-size:12px;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top;width:160px">${key}</td>
            <td style="padding:9px 14px;color:#fff;font-weight:500;font-size:13px;border-bottom:1px solid rgba(255,255,255,.06)">${val}</td>
          </tr>`;
        }
        return `<tr><td colspan="2" style="padding:9px 14px;color:rgba(255,255,255,.7);font-size:13px;border-bottom:1px solid rgba(255,255,255,.06)">${item.trim()}</td></tr>`;
      }).join("");
    }

    const destinatarios = ["gustavosgbf@gmail.com", process.env.EMAIL_MEDICO_2 || ""].filter(Boolean);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:20px 28px">
          <h2 style="margin:0;color:#051208;font-size:18px">🏥 Nova triagem — ConsultaJá24h</h2>
        </div>
        <div style="padding:28px">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:140px">Paciente</td><td style="padding:8px 0;font-weight:600">${nome || "—"}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">CPF</td><td style="padding:8px 0;font-weight:600">${cpf || "—"}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0;font-weight:600">${telLimpo}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Tel. Documentos</td><td style="padding:8px 0;font-weight:600">${tel_documentos || telLimpo}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Modalidade</td><td style="padding:8px 0;font-weight:600">${tipoLabel}</td></tr>
            <tr>
              <td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Atender</td>
              <td style="padding:8px 0">
                <a href="${linkMedico("Dr. Gustavo")}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">📱 Chamar no WhatsApp</a>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Link consulta</td>
              <td style="padding:8px 0;font-size:12px"><a href="${linkRetorno}" style="color:#5ee0a0;word-break:break-all">${linkRetorno}</a></td>
            </tr>
          </table>

          <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;overflow:hidden">
            <div style="padding:12px 14px;background:rgba(180,224,90,.08);border-bottom:1px solid rgba(255,255,255,.08)">
              <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4)">Triagem completa</p>
            </div>
            <table style="width:100%;border-collapse:collapse">${montarTabelaTriagem(triagem)}</table>
          </div>

          <p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,.3)">Enviado automaticamente pelo sistema ConsultaJá24h</p>
        </div>
      </div>`;

    // Envios em paralelo, sem await bloqueante
    Promise.all([
      RESEND_KEY ? fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "ConsultaJá24h <onboarding@resend.dev>",
          to: destinatarios,
          subject: `🏥 Nova triagem — ${nome || "Paciente"} (${tipoLabel})`,
          html,
        }),
      }).then(r => r.json()).then(d => { if (!d.id) console.error("Resend error:", d); }).catch(e => console.error("Resend:", e)) : Promise.resolve(),
      appendToSheet("Atendimentos", [
        new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }),
        nome || "", tel || "", cpf || "", "Aguardando", "", triagem || "", tipoConsulta,
      ]).catch(e => console.error("Sheets:", e)),
    ]);

  } catch (e) {
    console.error("Notify error:", e);
    // Se ainda não respondeu, responde com erro
    if (!res.headersSent) return res.status(500).json({ ok: false });
  }
});

// ── CHAT INTERNO — ENVIAR MENSAGEM ───────────────────────
app.post("/api/chat/enviar", async (req, res) => {
  try {
    const { atendimentoId, autor, autorId, texto } = req.body || {};
    if (!atendimentoId || !autor || !texto) {
      return res.status(400).json({ ok: false, error: "Campos obrigatórios: atendimentoId, autor, texto" });
    }
    if (!["paciente", "medico"].includes(autor)) {
      return res.status(400).json({ ok: false, error: "autor deve ser 'paciente' ou 'medico'" });
    }
    const result = await pool.query(
      `INSERT INTO mensagens (atendimento_id, autor, autor_id, texto)
       VALUES ($1, $2, $3, $4)
       RETURNING id, atendimento_id, autor, texto, criado_em`,
      [atendimentoId, autor, autorId || null, texto.trim()]
    );
    return res.json({ ok: true, mensagem: result.rows[0] });
  } catch (e) {
    console.error("Erro em /api/chat/enviar:", e);
    return res.status(500).json({ ok: false, error: "Erro ao enviar mensagem" });
  }
});

// ── CHAT INTERNO — BUSCAR HISTÓRICO ─────────────────────
app.get("/api/chat/:atendimentoId", async (req, res) => {
  try {
    const { atendimentoId } = req.params;
    const result = await pool.query(
      `SELECT id, atendimento_id, autor, texto, criado_em
       FROM mensagens
       WHERE atendimento_id = $1
       ORDER BY criado_em ASC`,
      [atendimentoId]
    );
    return res.json({ ok: true, mensagens: result.rows });
  } catch (e) {
    console.error("Erro em /api/chat/:id:", e);
    return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" });
  }
});

// ── STATUS DO ATENDIMENTO (paciente verifica se foi assumido/encerrado) ──
app.get("/api/atendimento/status/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, status, tipo, nome, tel, cpf, tel_documentos, medico_nome, meet_link,
              queixa, idade, sexo, alergias, cronicas, medicacoes, triagem,
              criado_em, assumido_em, encerrado_em
       FROM fila_atendimentos
       WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento não encontrado" });
    return res.json({ ok: true, atendimento: result.rows[0] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao buscar status" });
  }
});

// ── IDENTIFICAÇÃO ────────────────────────────────────────
app.post("/api/identify", async (req, res) => {
  try {
    const { nome, tel } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—";
    await pool.query("INSERT INTO identificacoes (nome, tel, data, ip) VALUES ($1,$2,$3,$4)", [nome || "—", tel || "—", agora, ip]);
    await appendToSheet("Identificacoes", [agora, nome || "", tel || "", ip]);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// ── CONSENTIMENTO ────────────────────────────────────────
app.post("/api/consent", async (req, res) => {
  try {
    const { nome, tel, versao } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—";
    await pool.query("INSERT INTO consentimentos (nome, tel, versao, data, ip) VALUES ($1,$2,$3,$4,$5)", [nome || "—", tel || "—", versao || "v1.0", agora, ip]);
    await appendToSheet("Consentimentos", [agora, nome || "", tel || "", versao || "v1.0", ip]);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// ── ATENDER (redirect antigo) ─────────────────────────────
app.get("/atender", async (req, res) => {
  try {
    const { medico, paciente, tel } = req.query;
    if (!tel) return res.status(400).send("Parâmetros inválidos");
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    await pool.query("INSERT INTO logs_atendimentos (medico, paciente, tel, data) VALUES ($1,$2,$3,$4)", [medico || "desconhecido", paciente || "—", tel, agora]);
    await appendToSheet("Atendimentos", [agora, paciente || "", tel || "", "", "Assumido", medico || "", ""]);
    const telLimpo = String(tel).replace(/\D/g, "");
    return res.redirect(`https://wa.me/55${telLimpo}`);
  } catch (e) {
    return res.status(500).send("Erro ao assumir atendimento");
  }
});

// ── ADMIN — MÉDICOS ───────────────────────────────────────
app.post("/api/admin/medico/criar", checkAdmin, async (req, res) => {
  try {
    const { nome, email, crm, senha } = req.body || {};
    if (!nome || !email || !crm || !senha) return res.status(400).json({ ok: false, error: "Campos obrigatórios faltando" });
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO medicos (nome, email, senha_hash, crm, status_online, ativo)
       VALUES ($1, $2, $3, $4, false, true)
       RETURNING id, nome, email, crm, status_online, ativo, created_at`,
      [nome, email.trim().toLowerCase(), senha_hash, crm]
    );
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ ok: false, error: "E-mail já cadastrado" });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/medicos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, nome, email, crm, status_online, ativo, created_at FROM medicos ORDER BY id DESC");
    return res.json({ ok: true, medicos: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/admin/medico/:id", checkAdmin, async (req, res) => {
  try {
    const { ativo } = req.body || {};
    if (typeof ativo !== "boolean") return res.status(400).json({ ok: false, error: "Campo 'ativo' deve ser boolean" });
    const result = await pool.query("UPDATE medicos SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo", [ativo, req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Médico não encontrado" });
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── LOGIN MÉDICO ──────────────────────────────────────────
app.post("/api/medico/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ ok: false, error: "E-mail e senha são obrigatórios" });
    const result = await pool.query("SELECT id, nome, email, crm, senha_hash, ativo FROM medicos WHERE email = $1 LIMIT 1", [email.trim().toLowerCase()]);
    if (result.rowCount === 0) return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    const med = result.rows[0];
    if (!med.ativo) return res.status(403).json({ ok: false, error: "Médico inativo" });
    const senhaOk = await bcrypt.compare(senha, med.senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: "Credenciais inválidas" });
    const token = jwt.sign(
      { id: med.id, nome: med.nome, crm: med.crm },
      process.env.JWT_SECRET || "fallback_secret",
      { expiresIn: "8h" }
    );
    return res.json({ ok: true, token, medico: { id: med.id, nome: med.nome, email: med.email, crm: med.crm } });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Erro interno no login" });
  }
});

// ── FILA ──────────────────────────────────────────────────
app.get("/api/fila", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, tel, cpf, tipo, triagem, status, medico_id, medico_nome, meet_link, criado_em
       FROM fila_atendimentos
       WHERE status IN ('aguardando', 'assumido')
       ORDER BY criado_em ASC`
    );
    return res.json({ ok: true, fila: result.rows });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Erro ao carregar fila" });
  }
});

// ── ASSUMIR ───────────────────────────────────────────────
app.post("/api/atendimento/assumir", async (req, res) => {
  try {
    const { filaId, medicoId, medicoNome } = req.body || {};
    if (!filaId || !medicoId || !medicoNome) return res.status(400).json({ ok: false, error: "Dados obrigatórios faltando" });
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'assumido', medico_id = $1, medico_nome = $2, assumido_em = NOW()
       WHERE id = $3 AND status = 'aguardando'
       RETURNING *`,
      [medicoId, medicoNome, filaId]
    );
    if (result.rowCount === 0) return res.status(409).json({ ok: false, error: "Paciente já foi assumido" });
    const at2 = result.rows[0];
    const agora2 = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    appendToSheet("Atendimentos", [
      agora2, at2.nome || "", at2.tel || "", at2.cpf || "",
      "Assumido", medicoNome || "", at2.triagem || "", at2.tipo || "", "", String(filaId),
    ]).catch(e => console.error("[Sheets] Erro ao salvar assumir:", e));
    return res.json({ ok: true, atendimento: at2 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Erro ao assumir atendimento" });
  }
});

// ── SALVAR LINK DO MEET ───────────────────────────────────
app.post("/api/atendimento/meet", async (req, res) => {
  try {
    const { filaId, meetLink } = req.body || {};
    if (!filaId || !meetLink) return res.status(400).json({ ok: false, error: "filaId e meetLink obrigatórios" });
    const result = await pool.query(
      `UPDATE fila_atendimentos SET meet_link = $1 WHERE id = $2 RETURNING id, meet_link`,
      [meetLink.trim(), filaId]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento não encontrado" });
    return res.json({ ok: true, meet_link: result.rows[0].meet_link });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Erro ao salvar link" });
  }
});

// ── ENCERRAR ──────────────────────────────────────────────
app.post("/api/atendimento/encerrar", async (req, res) => {
  try {
    const { filaId, status, documentos_emitidos } = req.body || {};
    if (!filaId) return res.status(400).json({ ok: false, error: "filaId é obrigatório" });
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'encerrado',
           encerrado_em = NOW(),
           status_atendimento = $2,
           documentos_emitidos = $3
       WHERE id = $1
       RETURNING *`,
      [filaId, status || "Encerrado", documentos_emitidos || "Nenhum"]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento não encontrado" });
    const at = result.rows[0];
    // Registra encerramento no Sheets
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    appendToSheet("Atendimentos", [
      agora,
      at.nome || "",
      at.tel || "",
      at.cpf || "",
      "Encerrado",
      at.medico_nome || "",
      at.triagem || "",
      at.tipo || "",
      at.documentos_emitidos || "",
      String(at.id),
    ]).catch(e => console.error("[Sheets] Erro ao salvar encerramento:", e));
    return res.json({ ok: true, atendimento: at });
  } catch (err) {
    console.error("Erro em /api/atendimento/encerrar:", err);
    return res.status(500).json({ ok: false, error: "Erro ao encerrar atendimento" });
  }
});

// ── PLANTÃO ───────────────────────────────────────────────
app.post("/api/plantao/entrar", async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    const token = auth.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    await pool.query("UPDATE medicos SET status_online = true WHERE id = $1", [decoded.id]);
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true });
  }
});

app.post("/api/plantao/sair", async (req, res) => {
  try {
    const auth = req.headers["authorization"] || "";
    const token = auth.replace("Bearer ", "");
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    await pool.query("UPDATE medicos SET status_online = false WHERE id = $1", [decoded.id]);
    return res.json({ ok: true });
  } catch (e) {
    return res.json({ ok: true });
  }
});

// ── RELATÓRIO ADMIN ───────────────────────────────────────
app.get("/relatorio", checkAdmin, async (req, res) => {
  try {
    const [atenRes, idRes, consRes] = await Promise.all([
      pool.query(`SELECT id, nome, tel, cpf, tipo, triagem, status, medico_nome, documentos_emitidos, criado_em, encerrado_em FROM fila_atendimentos ORDER BY criado_em DESC`),
      pool.query(`SELECT nome, tel, data, ip FROM identificacoes ORDER BY id DESC LIMIT 200`),
      pool.query(`SELECT nome, tel, versao, data, ip FROM consentimentos ORDER BY id DESC LIMIT 200`),
    ]);
    const atend = atenRes.rows;
    const ident = idRes.rows;
    const cons  = consRes.rows;

    const total = atend.length;
    const encerrados = atend.filter(a => a.status === 'encerrado').length;
    const aguardando = atend.filter(a => a.status === 'aguardando').length;
    const assumidos  = atend.filter(a => a.status === 'assumido').length;

    const css = `
      *{box-sizing:border-box}
      body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:1100px;margin:0 auto}
      h1{color:#b4e05a;margin:0 0 4px}
      h2{color:#b4e05a;font-size:1rem;text-transform:uppercase;letter-spacing:.1em;margin:36px 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}
      p.sub{color:rgba(255,255,255,.35);font-size:.82rem;margin:0 0 28px}
      table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:.83rem}
      th{text-align:left;padding:9px 11px;background:rgba(180,224,90,.07);color:#b4e05a;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}
      td{padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}
      tr:hover td{background:rgba(255,255,255,.02)}
      .badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}
      .badge.encerrado{background:rgba(94,224,160,.1);color:#5ee0a0}
      .badge.aguardando{background:rgba(255,189,46,.1);color:#ffbd2e}
      .badge.assumido{background:rgba(180,224,90,.1);color:#b4e05a}
      .badge.chat{background:rgba(37,211,102,.1);color:#25d366}
      .badge.video{background:rgba(94,224,160,.1);color:#5ee0a0}
      .badge.lgpd{background:rgba(66,133,244,.12);color:#7baeff}
      .totais{display:flex;gap:20px;flex-wrap:wrap;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:16px 20px;margin-bottom:28px}
      .t-item span{display:block;font-size:.68rem;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
      .t-item strong{font-size:1.4rem;color:#b4e05a}
      a{color:#5ee0a0;text-decoration:none}
      a:hover{text-decoration:underline}
      .nav{display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap}
      .nav a{padding:6px 16px;border-radius:8px;background:rgba(180,224,90,.08);border:1px solid rgba(180,224,90,.18);color:#b4e05a;font-size:.8rem;font-weight:600}
      .nav a:hover{background:rgba(180,224,90,.15);text-decoration:none}
      .dim{color:rgba(255,255,255,.35);font-size:.76rem}
      .triagem-cell{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.77rem;color:rgba(255,255,255,.55)}
    `;

    const senhaParam = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : '';

    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">
      <title>Painel Admin — ConsultaJá24h</title>
      <style>${css}</style>
    </head><body>
    <h1>📊 Painel Administrativo — ConsultaJá24h</h1>
    <p class="sub">Dados em tempo real · PostgreSQL</p>

    <div class="nav">
      <a href="/relatorio${senhaParam}">📊 Relatório geral</a>
      <a href="/identificacoes${senhaParam}">📋 Identificações</a>
      <a href="/consentimentos${senhaParam}">✅ Consentimentos</a>
    </div>

    <div class="totais">
      <div class="t-item"><span>Total atendimentos</span><strong>${total}</strong></div>
      <div class="t-item"><span>Encerrados</span><strong>${encerrados}</strong></div>
      <div class="t-item"><span>Aguardando</span><strong>${aguardando}</strong></div>
      <div class="t-item"><span>Em atendimento</span><strong>${assumidos}</strong></div>
      <div class="t-item"><span>Identificações</span><strong>${ident.length}</strong></div>
      <div class="t-item"><span>Consentimentos</span><strong>${cons.length}</strong></div>
    </div>

    <h2>🏥 Atendimentos (${total})</h2>
    <table>
      <tr><th>#</th><th>Data/Hora</th><th>Paciente</th><th>CPF</th><th>WhatsApp</th><th>Modalidade</th><th>Médico</th><th>Status</th><th>Triagem</th><th>Documentos</th><th>Encerrado em</th></tr>
      ${atend.map(a => {
        const data = a.criado_em ? new Date(a.criado_em).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}) : '—';
        const enc  = a.encerrado_em ? new Date(a.encerrado_em).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}) : '—';
        const tel  = String(a.tel||'').replace(/\D/g,'');
        const tipo = a.tipo === 'video' ? '<span class="badge video">🎥 Vídeo</span>' : '<span class="badge chat">💬 Chat</span>';
        const st   = `<span class="badge ${a.status}">${a.status}</span>`;
        const triagem = String(a.triagem||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return `<tr>
          <td class="dim">${a.id}</td>
          <td class="dim" style="white-space:nowrap">${data}</td>
          <td><strong>${a.nome||'—'}</strong></td>
          <td class="dim">${a.cpf||'—'}</td>
          <td><a href="https://wa.me/55${tel}">📱 ${a.tel||'—'}</a></td>
          <td>${tipo}</td>
          <td>${a.medico_nome||'—'}</td>
          <td>${st}</td>
          <td><div class="triagem-cell" title="${triagem}">${triagem||'—'}</div></td>
          <td class="dim">${a.documentos_emitidos||'—'}</td>
          <td class="dim" style="white-space:nowrap">${enc}</td>
        </tr>`;
      }).join('')}
    </table>

    <h2>📋 Identificações (${ident.length})</h2>
    <table>
      <tr><th>Data/Hora</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
      ${ident.map(i => `<tr>
        <td class="dim">${i.data||'—'}</td>
        <td>${i.nome||'—'}</td>
        <td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'—'}</a></td>
        <td class="dim" style="font-size:.73rem">${i.ip||'—'}</td>
      </tr>`).join('')}
    </table>

    <h2>✅ Consentimentos LGPD (${cons.length})</h2>
    <table>
      <tr><th>Data/Hora</th><th>Nome</th><th>WhatsApp</th><th>Versão</th><th>IP</th></tr>
      ${cons.map(i => `<tr>
        <td class="dim">${i.data||'—'}</td>
        <td>${i.nome||'—'}</td>
        <td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'—'}</a></td>
        <td><span class="badge lgpd">${i.versao||'v1.0'}</span></td>
        <td class="dim" style="font-size:.73rem">${i.ip||'—'}</td>
      </tr>`).join('')}
    </table>

    <p class="dim" style="margin-top:32px">Gerado em ${new Date().toLocaleString('pt-BR',{timeZone:'America/Fortaleza'})}</p>
    </body></html>`;

    return res.send(html);
  } catch (e) {
    console.error("Erro em /relatorio:", e);
    return res.status(500).send("Erro ao carregar relatório: " + e.message);
  }
});

// ── IDENTIFICAÇÕES (página própria) ──────────────────────────────────
app.get("/identificacoes", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT nome, tel, data, ip FROM identificacoes ORDER BY id DESC");
    const lista = result.rows;
    const senhaParam = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : '';
    if (lista.length === 0) return res.send('<h2 style="font-family:sans-serif;padding:20px">Nenhuma identificação registrada.</h2>');
    const html = `<html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}h1{color:#b4e05a}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;text-transform:uppercase}td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}a{color:#5ee0a0}.back{display:inline-block;margin-bottom:20px;color:#b4e05a;font-size:.82rem}</style></head><body>
    <a class="back" href="/relatorio${senhaParam}">← Voltar ao relatório</a>
    <h1>📋 Identificações</h1><p style="color:rgba(255,255,255,.4)">${lista.length} registros</p>
    <table><tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
    ${lista.map(i => `<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'—'}</td><td>${i.nome||'—'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'—'}</a></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'—'}</td></tr>`).join('')}
    </table></body></html>`;
    res.send(html);
  } catch (e) { res.status(500).send("Erro: " + e.message); }
});

// ── CONSENTIMENTOS (página própria) ──────────────────────────────────
app.get("/consentimentos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT nome, tel, versao, data, ip FROM consentimentos ORDER BY id DESC");
    const lista = result.rows;
    const senhaParam = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : '';
    if (lista.length === 0) return res.send('<h2 style="font-family:sans-serif;padding:20px">Nenhum consentimento registrado.</h2>');
    const html = `<html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}h1{color:#b4e05a}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;text-transform:uppercase}td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}.badge{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(94,224,160,.1);color:#5ee0a0;font-size:.75rem}a{color:#5ee0a0}.back{display:inline-block;margin-bottom:20px;color:#b4e05a;font-size:.82rem}</style></head><body>
    <a class="back" href="/relatorio${senhaParam}">← Voltar ao relatório</a>
    <h1>✅ Consentimentos LGPD</h1><p style="color:rgba(255,255,255,.4)">${lista.length} aceites</p>
    <table><tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>Versão</th><th>IP</th></tr>
    ${lista.map(i => `<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'—'}</td><td>${i.nome||'—'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'—'}</a></td><td><span class="badge">${i.versao||'v1.0'}</span></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'—'}</td></tr>`).join('')}
    </table></body></html>`;
    res.send(html);
  } catch (e) { res.status(500).send("Erro: " + e.message); }
});


// ── DISPONIBILIDADE (público) ─────────────────────────────
app.get("/api/disponibilidade", async (req, res) => {
  try {
    // Horário de Brasília
    const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Fortaleza" }));
    const hora = agora.getHours();
    const HORA_INICIO = 8;
    const HORA_FIM = 23;
    const dentroDoHorario = hora >= HORA_INICIO && hora < HORA_FIM;

    const [medRes, filaRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM medicos WHERE status_online = true AND ativo = true"),
      pool.query("SELECT COUNT(*) FROM fila_atendimentos WHERE status = 'aguardando'")
    ]);
    const medicosOnline = parseInt(medRes.rows[0].count) || 0;
    const pacientesAguardando = parseInt(filaRes.rows[0].count) || 0;

    // Disponível = dentro do horário E (médico online OU dentro do horário operacional)
    // Permite entrar na fila mesmo sem médico online (se dentro do horário)
    const disponivel = dentroDoHorario;

    let tempoEstimado = 5;
    if (medicosOnline > 0) {
      tempoEstimado = Math.max(3, Math.ceil((pacientesAguardando / medicosOnline) * 6));
    } else if (dentroDoHorario) {
      tempoEstimado = Math.max(8, pacientesAguardando * 6 + 5);
    }

    let status = 'verde';
    if (!disponivel) status = 'vermelho';
    else if (tempoEstimado > 12 || medicosOnline === 0) status = 'amarelo';

    // Calcula horário de retorno se fora do expediente
    let horarioRetorno = null;
    let mensagem = disponivel
      ? (medicosOnline > 0 ? `${medicosOnline} médico(s) disponível(is)` : 'Atendimento disponível')
      : 'Atendimento indisponível no momento';

    if (!disponivel) {
      const retorno = new Date(agora);
      if (hora >= HORA_FIM) {
        retorno.setDate(retorno.getDate() + 1);
        retorno.setHours(HORA_INICIO, 0, 0, 0);
      } else {
        retorno.setHours(HORA_INICIO, 0, 0, 0);
      }
      horarioRetorno = retorno.toLocaleString("pt-BR", {
        timeZone: "America/Fortaleza",
        hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit"
      });
      mensagem = `Atendimento disponível das ${HORA_INICIO}h às ${HORA_FIM}h`;
    }

    // Gera horários disponíveis para agendamento (próximas 24h, intervalos de 20min)
    const horariosAgendamento = [];
    if (!disponivel) {
      const base = new Date(agora);
      // Começa a partir do próximo início de expediente
      if (hora >= HORA_FIM) {
        base.setDate(base.getDate() + 1);
        base.setHours(HORA_INICIO, 0, 0, 0);
      } else {
        base.setHours(HORA_INICIO, 0, 0, 0);
      }
      // Gera 12 horários em intervalos de 20 min a partir das 08h
      const minutos = [0, 20, 40];
      let count = 0;
      for (let h = HORA_INICIO; h < HORA_FIM && count < 16; h++) {
        for (const m of minutos) {
          if (count >= 16) break;
          const slot = new Date(base);
          slot.setHours(h, m, 0, 0);
          const label = slot.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Fortaleza" });
          const iso = slot.toISOString();
          horariosAgendamento.push({ label, iso });
          count++;
        }
      }
    }

    res.json({
      ok: true,
      disponivel,
      medicosOnline,
      pacientesAguardando,
      tempoEstimado,
      status,
      mensagem,
      horarioRetorno,
      horariosAgendamento,
      horaAtual: hora,
      horaInicio: HORA_INICIO,
      horaFim: HORA_FIM
    });
  } catch(e) {
    console.error("Erro em /api/disponibilidade:", e);
    res.json({ ok: false, disponivel: true, medicosOnline: 0, tempoEstimado: 5, status: 'verde', mensagem: 'Verificando...', horariosAgendamento: [] });
  }
});

// ── AGENDAMENTO — CRIAR (pré-pagamento) ──────────────────
app.post("/api/agendamento/criar", async (req, res) => {
  try {
    const { nome, tel, tel_documentos, cpf, modalidade, horario_agendado } = req.body || {};
    if (!nome || !tel || !horario_agendado) {
      return res.status(400).json({ ok: false, error: "nome, tel e horario_agendado são obrigatórios" });
    }
    // Verifica se horário já não está lotado (máximo 3 por slot de 20min)
    const slotStart = new Date(horario_agendado);
    const slotEnd = new Date(slotStart.getTime() + 20 * 60 * 1000);
    const existentes = await pool.query(
      `SELECT COUNT(*) FROM agendamentos WHERE horario_agendado >= $1 AND horario_agendado < $2 AND status IN ('pendente','confirmado')`,
      [slotStart.toISOString(), slotEnd.toISOString()]
    );
    if (parseInt(existentes.rows[0].count) >= 3) {
      return res.status(409).json({ ok: false, error: "Horário indisponível. Escolha outro horário." });
    }
    const result = await pool.query(
      `INSERT INTO agendamentos (nome, tel, tel_documentos, cpf, modalidade, horario_agendado, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pendente')
       RETURNING id`,
      [nome, tel, tel_documentos || tel, cpf || "", modalidade || "chat", horario_agendado]
    );
    const agendamentoId = result.rows[0].id;
    return res.json({ ok: true, agendamentoId });
  } catch(e) {
    console.error("Erro em /api/agendamento/criar:", e);
    return res.status(500).json({ ok: false, error: "Erro ao criar agendamento" });
  }
});

// ── AGENDAMENTO — CONFIRMAR (pós-pagamento) ──────────────
app.post("/api/agendamento/confirmar", async (req, res) => {
  try {
    const { agendamentoId, paymentId } = req.body || {};
    if (!agendamentoId) return res.status(400).json({ ok: false, error: "agendamentoId é obrigatório" });
    const result = await pool.query(
      `UPDATE agendamentos SET status = 'confirmado', payment_id = $2 WHERE id = $1 AND status = 'pendente' RETURNING *`,
      [agendamentoId, paymentId || null]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Agendamento não encontrado ou já confirmado" });
    const ag = result.rows[0];

    // Envia email de confirmação de agendamento
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const destinatarios = ["gustavosgbf@gmail.com", process.env.EMAIL_MEDICO_2 || ""].filter(Boolean);
    const horarioFormatado = new Date(ag.horario_agendado).toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });
    const tipoLabel = ag.modalidade === "video" ? "🎥 Vídeo" : "💬 Chat";

    const htmlAg = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#4285f4,#34a853);padding:20px 28px">
          <h2 style="margin:0;color:#fff;font-size:18px">📅 Novo AGENDAMENTO — ${horarioFormatado}</h2>
        </div>
        <div style="padding:28px">
          <p style="color:rgba(255,200,100,.9);font-size:14px;margin-bottom:20px;background:rgba(255,200,0,.06);border:1px solid rgba(255,200,0,.2);padding:12px 16px;border-radius:8px">
            ⚠️ Este é um agendamento confirmado — o paciente aguarda atendimento no horário marcado.
          </p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:140px">Paciente</td><td style="padding:8px 0;font-weight:600">${ag.nome}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">CPF</td><td style="padding:8px 0;font-weight:600">${ag.cpf || "—"}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0;font-weight:600">${ag.tel}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Tel. Documentos</td><td style="padding:8px 0;font-weight:600">${ag.tel_documentos || ag.tel}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Modalidade</td><td style="padding:8px 0;font-weight:600">${tipoLabel}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Horário</td><td style="padding:8px 0;font-weight:700;font-size:16px;color:#b4e05a">${horarioFormatado}</td></tr>
          </table>
        </div>
      </div>`;

    if (RESEND_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: "ConsultaJá24h <onboarding@resend.dev>",
          to: destinatarios,
          subject: `📅 Novo AGENDAMENTO — ${horarioFormatado} (${tipoLabel})`,
          html: htmlAg,
        }),
      }).catch(e => console.error("Resend agendamento error:", e));
    }

    return res.json({ ok: true, agendamento: ag, horarioFormatado });
  } catch(e) {
    console.error("Erro em /api/agendamento/confirmar:", e);
    return res.status(500).json({ ok: false, error: "Erro ao confirmar agendamento" });
  }
});

// ── AGENDAMENTOS — LISTAR (admin/médico) ──────────────────
app.get("/api/agendamentos", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, tel, tel_documentos, cpf, modalidade, horario_agendado, status, criado_em
       FROM agendamentos
       WHERE status = 'confirmado'
       ORDER BY horario_agendado ASC`
    );
    return res.json({ ok: true, agendamentos: result.rows });
  } catch(e) {
    return res.status(500).json({ ok: false, error: "Erro ao listar agendamentos" });
  }
});

app.get("/api/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
