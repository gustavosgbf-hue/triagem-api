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

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const ASAAS_TOKEN = process.env.ASAAS_TOKEN;

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY nao definida"); process.exit(1); }
if (!ASAAS_TOKEN) { console.error("ASAAS_TOKEN nao definida"); process.exit(1); }

// LIMPEZA AUTOMATICA -- atendimentos travados em 'assumido' por mais de 48h
setInterval(async () => {
  try {
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

// LIMPEZA AUTOMATICA -- historico: encerrados/expirados com mais de 7 dias viram 'arquivado'
setInterval(async () => {
  try {
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'arquivado'
       WHERE status IN ('encerrado', 'expirado')
         AND encerrado_em < NOW() - INTERVAL '7 days'
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
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
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
    const cols = [
      ['status_atendimento','TEXT'],['documentos_emitidos','TEXT'],['meet_link','TEXT'],
      ['tel_documentos','TEXT'],['idade','TEXT'],['sexo','TEXT'],['alergias','TEXT'],
      ['cronicas','TEXT'],['medicacoes','TEXT'],['queixa','TEXT'],
      ['assumido_em','TIMESTAMP'],['encerrado_em','TIMESTAMP'],
      ['data_nascimento','TEXT'],
      ['prontuario','TEXT'],  // ── PATCH 1: coluna para autosave do prontuário
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
  const mapa = [
    { chave: 'queixa', padroes: ['queixa','queixa principal','problema'] },
    { chave: 'idade', padroes: ['idade','anos'] },
    { chave: 'sexo', padroes: ['sexo','genero'] },
    { chave: 'alergias', padroes: ['alergia','alergias'] },
    { chave: 'cronicas', padroes: ['comorbidade','comorbidades','historico'] },
    { chave: 'medicacoes', padroes: ['medicacao','medicacoes','medicamentos'] },
  ];
  const linhas = summary.split(/[;\n]/);
  for (const linha of linhas) {
    const colonIdx = linha.indexOf(':');
    if (colonIdx < 1) continue;
    const chaveRaw = linha.slice(0, colonIdx).trim().toLowerCase();
    const valor = linha.slice(colonIdx + 1).trim();
    if (!valor || valor === '-') continue;
    for (const { chave, padroes } of mapa) {
      if (padroes.some(p => chaveRaw.includes(p))) { campos[chave] = campos[chave] || valor; break; }
    }
  }
  if (!campos.idade) { const m = summary.match(/(\d{1,3})\s*anos/i); if (m) campos.idade = m[1] + ' anos'; }
  if (!campos.sexo) {
    if (/feminino|mulher/i.test(summary)) campos.sexo = 'Feminino';
    else if (/masculino|homem/i.test(summary)) campos.sexo = 'Masculino';
  }
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
    if (!out.ok) return res.status(503).json({ text: "Sistema temporariamente indisponivel. Tente novamente em instantes." });
    return res.json({ text: out.text });
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
  const token = auth.replace("Bearer ", "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Token nao fornecido" });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret");
    req.medico = decoded; next();
  } catch(e) {
    return res.status(401).json({ ok: false, error: "Token invalido ou expirado" });
  }
}

// alias para checkMedico usado na rota de prontuário
const autenticarMedico = checkMedico;

app.post("/api/triage", handleChat);
app.post("/api/doctor", handleChat);

app.post("/api/payment", async (req, res) => {
  try {
    const { nome } = req.body || {};
    const asaasRes = await fetch("https://api.asaas.com/v3/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "access_token": ASAAS_TOKEN
      },
      body: JSON.stringify({
        customer: await getOrCreateAsaasCustomer(nome),
        billingType: "PIX",
        value: 49.90,
        dueDate: new Date(Date.now() + 30 * 60 * 1000).toISOString().split("T")[0],
        description: "Consulta Medica Online - ConsultaJa24h",
      }),
    });
    const data = await asaasRes.json();
    if (!asaasRes.ok) { console.error("Asaas error:", data); return res.status(500).json({ ok: false, error: data.errors?.[0]?.description || "Erro ao gerar pagamento" }); }

    // Buscar QR code PIX
    const pixRes = await fetch(`https://api.asaas.com/v3/payments/${data.id}/pixQrCode`, {
      headers: { "access_token": ASAAS_TOKEN }
    });
    const pixData = await pixRes.json();

    return res.json({
      ok: true,
      payment_id: data.id,
      status: data.status,
      qr_code: pixData.payload,
      qr_code_base64: pixData.encodedImage
    });
  } catch (e) { console.error("Erro em /api/payment:", e); return res.status(500).json({ ok: false, error: "Erro interno" }); }
});

async function getOrCreateAsaasCustomer(nome) {
  try {
    const nome_limpo = (nome || "Paciente").trim();
    // Criar cliente temporário
    const res = await fetch("https://api.asaas.com/v3/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json", "access_token": ASAAS_TOKEN },
      body: JSON.stringify({ name: nome_limpo })
    });
    const data = await res.json();
    return data.id;
  } catch(e) {
    console.error("[Asaas] Erro ao criar customer:", e.message);
    throw e;
  }
}

app.get("/api/payment/:id", async (req, res) => {
  try {
    const asaasRes = await fetch(`https://api.asaas.com/v3/payments/${req.params.id}`, {
      headers: { "access_token": ASAAS_TOKEN }
    });
    const data = await asaasRes.json();
    if (!asaasRes.ok) return res.status(500).json({ ok: false, error: data.errors?.[0]?.description || "Erro ao consultar pagamento" });
    // Mapear status Asaas -> padrão interno
    // CONFIRMED/RECEIVED = aprovado, PENDING = pendente
    const statusMap = { CONFIRMED: "approved", RECEIVED: "approved", PENDING: "pending", OVERDUE: "cancelled", REFUNDED: "refunded" };
    return res.json({ ok: true, status: statusMap[data.status] || data.status.toLowerCase() });
  } catch (e) { return res.status(500).json({ ok: false, error: "Erro ao consultar pagamento" }); }
});

app.post("/api/atendimento/atualizar-triagem", async (req, res) => {
  try {
    const { atendimentoId, triagem } = req.body || {};
    if (!atendimentoId || !triagem) return res.status(400).json({ ok: false, error: "atendimentoId e triagem sao obrigatorios" });
    const campos = parsearTriagem(triagem);
    const result = await pool.query(
      `UPDATE fila_atendimentos SET triagem=$2,queixa=$3,idade=$4,sexo=$5,alergias=$6,cronicas=$7,medicacoes=$8,status='aguardando'
       WHERE id=$1 AND status='triagem' RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos,medico_nome`,
      [atendimentoId,triagem,campos.queixa||triagem,campos.idade||"",campos.sexo||"",campos.alergias||"",campos.cronicas||"",campos.medicacoes||""]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado ou ja em andamento" });
    const at = result.rows[0];
    const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
    appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Aguardando","",triagem,at.tipo||"","",String(at.id)]).catch(e=>console.error("[Sheets]",e));

    const RESEND_KEY = process.env.RESEND_API_KEY;
    const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
    const tipoLabel = at.tipo === "video" ? "Video" : "Chat";
    const linkRetorno = `${SITE_URL}/triagem.html?consulta=${at.id}`;
    const telLimpo = String(at.tel||"").replace(/\D/g,"");
    const medicosResult = await pool.query(`SELECT email FROM medicos WHERE ativo=true AND status='aprovado' ORDER BY status_online DESC`);
    const destinatarios = medicosResult.rows.map(m=>m.email).filter(Boolean);
    if (!destinatarios.includes("gustavosgbf@gmail.com")) destinatarios.push("gustavosgbf@gmail.com");

    function montarTabelaTriagem(texto) {
      if (!texto) return '<tr><td colspan="2">-</td></tr>';
      return texto.split(/[;\n]/).map(item => {
        const ci = item.indexOf(":");
        if (ci>0) { const k=item.slice(0,ci).trim(); const v=item.slice(ci+1).trim(); return `<tr><td style="padding:8px 12px;color:rgba(255,255,255,.45);font-size:12px;width:150px">${k}</td><td style="padding:8px 12px;color:#fff;font-size:13px">${v}</td></tr>`; }
        return `<tr><td colspan="2" style="padding:8px 12px;color:rgba(255,255,255,.7);font-size:13px">${item.trim()}</td></tr>`;
      }).join("");
    }

    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden"><div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:20px 28px"><h2 style="margin:0;color:#051208;font-size:18px">Nova triagem - ConsultaJa24h</h2></div><div style="padding:28px"><table style="width:100%;border-collapse:collapse;margin-bottom:24px"><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:140px">Paciente</td><td style="padding:8px 0;font-weight:600">${at.nome||"-"}</td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0;font-weight:600">${telLimpo}</td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Modalidade</td><td style="padding:8px 0;font-weight:600">${tipoLabel}</td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0"><a href="https://wa.me/55${telLimpo}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">Chamar no WhatsApp</a></td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Link consulta</td><td style="padding:8px 0;font-size:12px"><a href="${linkRetorno}" style="color:#5ee0a0">${linkRetorno}</a></td></tr></table><table style="width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,.1);border-radius:10px">${montarTabelaTriagem(triagem)}</table><p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,.3)">Enviado automaticamente pelo sistema ConsultaJa24h</p></div></div>`;

    if (RESEND_KEY) {
      try {
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "ConsultaJa24h <onboarding@resend.dev>", to: destinatarios, subject: `Nova triagem - ${at.nome||"Paciente"} (${tipoLabel})`, html })
        });
        const resendData = await resendRes.json();
        if (resendData.id) {
          console.log("[EMAIL] Enviado com sucesso para:", destinatarios.join(", "), "| ID:", resendData.id);
        } else {
          console.error("[EMAIL] Resend recusou:", JSON.stringify(resendData));
        }
      } catch(e) {
        console.error("[EMAIL] Erro ao chamar Resend:", e.message);
      }
    } else {
      console.warn("[EMAIL] RESEND_API_KEY nao definida, email nao enviado.");
    }

    return res.json({ ok: true, atendimentoId: at.id });
  } catch (e) {
    console.error("Erro em /api/atendimento/atualizar-triagem:", e);
    return res.status(500).json({ ok: false, error: "Erro ao atualizar triagem" });
  }
});

app.post("/api/notify", async (req, res) => {
  try {
    const { nome, tel, tel_documentos, cpf, triagem, tipo, data_nascimento } = req.body || {};
    const tipoConsulta = tipo === "video" ? "video" : "chat";
    const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
    const campos = parsearTriagem(triagem);
    const insertResult = await pool.query(
      `INSERT INTO fila_atendimentos (nome,tel,tel_documentos,cpf,tipo,triagem,status,queixa,idade,sexo,alergias,cronicas,medicacoes,data_nascimento)
       VALUES ($1,$2,$3,$4,$5,$6,'triagem',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [nome||"-",tel||"-",tel_documentos||tel||"-",cpf||"-",tipoConsulta,triagem||"",
       campos.queixa||triagem||"",campos.idade||"",campos.sexo||"",campos.alergias||"",campos.cronicas||"",campos.medicacoes||"",data_nascimento||""]
    );
    const atendimentoId = insertResult.rows[0]?.id;
    return res.json({ ok: true, atendimentoId, linkRetorno: `${SITE_URL}/triagem.html?consulta=${atendimentoId}` });
  } catch (e) {
    console.error("Notify error:", e);
    if (!res.headersSent) return res.status(500).json({ ok: false });
  }
});

app.post("/api/chat/enviar", async (req, res) => {
  try {
    const { atendimentoId, autor, autorId, texto } = req.body || {};
    if (!atendimentoId||!autor||!texto) return res.status(400).json({ ok: false, error: "Campos obrigatorios: atendimentoId, autor, texto" });
    if (!["paciente","medico"].includes(autor)) return res.status(400).json({ ok: false, error: "autor deve ser paciente ou medico" });
    const result = await pool.query(
      `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto) VALUES ($1,$2,$3,$4) RETURNING id,atendimento_id,autor,texto,criado_em`,
      [atendimentoId,autor,autorId||null,texto.trim()]
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
    if (token) { try { jwt.verify(token, process.env.JWT_SECRET||"fallback_secret"); autorizado=true; } catch(e){} }
    if (!autorizado) { const check = await pool.query(`SELECT id FROM fila_atendimentos WHERE id=$1`,[atendimentoId]); autorizado=check.rowCount>0; }
    if (!autorizado) return res.status(403).json({ ok: false, error: "Acesso negado" });
    const result = await pool.query(`SELECT id,atendimento_id,autor,texto,criado_em FROM mensagens WHERE atendimento_id=$1 ORDER BY criado_em ASC`,[atendimentoId]);
    return res.json({ ok: true, mensagens: result.rows });
  } catch (e) { console.error("Erro em /api/chat/:id:", e); return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" }); }
});

app.get("/api/atendimento/status/:id", async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,status,tipo,medico_nome,meet_link,criado_em,assumido_em,encerrado_em,nome,tel,cpf,data_nascimento,idade,sexo,alergias,cronicas,medicacoes,queixa FROM fila_atendimentos WHERE id=$1`,[req.params.id]);
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
    const { nome, nome_exibicao, email, senha, crm, uf, telefone, especialidade } = req.body || {};
    if (!nome||!email||!senha||!crm||!uf||!telefone) return res.status(400).json({ ok: false, error: "Todos os campos obrigatorios devem ser preenchidos" });
    if (senha.length<6) return res.status(400).json({ ok: false, error: "Senha deve ter ao menos 6 caracteres" });
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO medicos (nome,nome_exibicao,email,senha_hash,crm,uf,telefone,especialidade,status_online,ativo,role,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,false,false,'medico','pendente') RETURNING id,nome,nome_exibicao,email`,
      [nome.trim(),(nome_exibicao||nome).trim(),email.trim().toLowerCase(),senha_hash,crm.trim().toUpperCase(),uf.trim().toUpperCase(),telefone||"",especialidade||""]
    );
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    if (err.code==="23505") return res.status(400).json({ ok: false, error: "E-mail ja cadastrado" });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.patch("/api/admin/medico/:id/aprovar", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE medicos SET ativo=true,status='aprovado' WHERE id=$1 RETURNING id,nome,email,status,ativo`,[req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    return res.json({ ok: true, medico: result.rows[0] });
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
    const result = await pool.query(`SELECT id,nome,email,crm,uf,telefone,especialidade,status,ativo,created_at FROM medicos WHERE status='pendente' ORDER BY created_at DESC`);
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

app.post("/api/medico/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email||!senha) return res.status(400).json({ ok: false, error: "E-mail e senha sao obrigatorios" });
    const result = await pool.query("SELECT id,nome,nome_exibicao,email,crm,senha_hash,ativo FROM medicos WHERE email=$1 LIMIT 1",[email.trim().toLowerCase()]);
    if (result.rowCount===0) return res.status(401).json({ ok: false, error: "Credenciais invalidas" });
    const med = result.rows[0];
    if (!med.ativo) return res.status(403).json({ ok: false, error: "Seu cadastro ainda esta em analise pela equipe da plataforma." });
    const senhaOk = await bcrypt.compare(senha, med.senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: "Credenciais invalidas" });
    const token = jwt.sign({ id: med.id, nome: med.nome, crm: med.crm }, process.env.JWT_SECRET||"fallback_secret", { expiresIn: "8h" });
    return res.json({ ok: true, token, medico: { id: med.id, nome: med.nome_exibicao||med.nome, email: med.email, crm: med.crm } });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro interno no login" }); }
});

app.get("/api/fila", checkMedico, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,nome,tel,cpf,tipo,triagem,status,medico_id,medico_nome,meet_link,criado_em,data_nascimento,idade,sexo,alergias,cronicas,medicacoes,queixa,solicita FROM fila_atendimentos WHERE status IN ('aguardando','assumido') ORDER BY criado_em ASC`);
    return res.json({ ok: true, fila: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao carregar fila" }); }
});

// ── PATCH 2: GET /api/historico — inclui prontuario_salvo e status 'arquivado' ──
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
         AND encerrado_em >= NOW() - INTERVAL '7 days'
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

// ── PATCH 3: POST /api/atendimento/prontuario (NOVA ROTA) ───────────────────
// Salva prontuário com validação de autoria — autosave + gerar manual
app.post("/api/atendimento/prontuario", autenticarMedico, async (req, res) => {
  const { filaId, prontuario } = req.body;
  if (!filaId || prontuario === undefined) {
    return res.status(400).json({ ok: false, error: "filaId e prontuario sao obrigatorios" });
  }
  try {
    const r = await pool.query(
      "UPDATE fila_atendimentos SET prontuario = $1 WHERE id = $2 AND medico_id = $3",
      [prontuario, filaId, req.medico.id]
    );
    if (r.rowCount === 0) {
      return res.status(403).json({ ok: false, error: "Atendimento nao encontrado ou sem permissao." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[prontuario] Erro ao salvar:", err.message);
    res.status(500).json({ ok: false, error: "Erro ao salvar prontuario" });
  }
});

app.post("/api/plantao/entrar", async (req, res) => {
  try {
    const auth = req.headers["authorization"]||"";
    const decoded = jwt.verify(auth.replace("Bearer ",""), process.env.JWT_SECRET||"fallback_secret");
    await pool.query("UPDATE medicos SET status_online=true WHERE id=$1",[decoded.id]);
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: true }); }
});

app.post("/api/plantao/sair", async (req, res) => {
  try {
    const auth = req.headers["authorization"]||"";
    const decoded = jwt.verify(auth.replace("Bearer ",""), process.env.JWT_SECRET||"fallback_secret");
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
    ${lista.map(i=>`<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'--'}</a></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'--'}</td></tr>`).join('')}
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
    const agora = new Date(new Date().toLocaleString("en-US",{timeZone:"America/Fortaleza"}));
    const hora = agora.getHours();
    const HORA_INICIO=8, HORA_FIM=23;
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
    if (!disponivel) {
      const retorno=new Date(agora);
      if (hora>=HORA_FIM) { retorno.setDate(retorno.getDate()+1); retorno.setHours(HORA_INICIO,0,0,0); }
      else retorno.setHours(HORA_INICIO,0,0,0);
      horarioRetorno=retorno.toLocaleString("pt-BR",{timeZone:"America/Fortaleza",hour:"2-digit",minute:"2-digit",day:"2-digit",month:"2-digit"});
      mensagem=`Atendimento disponivel das ${HORA_INICIO}h as ${HORA_FIM}h`;
    }
    const horariosAgendamento=[];
    if (!disponivel) {
      const base=new Date(agora);
      if (hora>=HORA_FIM) { base.setDate(base.getDate()+1); base.setHours(HORA_INICIO,0,0,0); }
      else base.setHours(HORA_INICIO,0,0,0);
      let count=0;
      for (let h=HORA_INICIO;h<HORA_FIM&&count<16;h++) {
        for (const m of [0,20,40]) {
          if (count>=16) break;
          const slot=new Date(base); slot.setHours(h,m,0,0);
          horariosAgendamento.push({label:slot.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit",timeZone:"America/Fortaleza"}),iso:slot.toISOString()});
          count++;
        }
      }
    }
    res.json({ok:true,disponivel,medicosOnline,pacientesAguardando,tempoEstimado,status,mensagem,horarioRetorno,horariosAgendamento,horaAtual:hora,horaInicio:HORA_INICIO,horaFim:HORA_FIM});
  } catch(e) {
    console.error("Erro em /api/disponibilidade:", e);
    res.json({ok:false,disponivel:true,medicosOnline:0,tempoEstimado:5,status:'verde',mensagem:'Verificando...',horariosAgendamento:[]});
  }
});

app.post("/api/agendamento/criar", async (req, res) => {
  try {
    const { nome,tel,tel_documentos,cpf,modalidade,horario_agendado } = req.body||{};
    if (!nome||!tel||!horario_agendado) return res.status(400).json({ok:false,error:"nome, tel e horario_agendado sao obrigatorios"});
    const slotStart=new Date(horario_agendado);
    const slotEnd=new Date(slotStart.getTime()+20*60*1000);
    const existentes=await pool.query(`SELECT COUNT(*) FROM agendamentos WHERE horario_agendado>=$1 AND horario_agendado<$2 AND status IN ('pendente','confirmado')`,[slotStart.toISOString(),slotEnd.toISOString()]);
    if (parseInt(existentes.rows[0].count)>=3) return res.status(409).json({ok:false,error:"Horario indisponivel. Escolha outro horario."});
    const result=await pool.query(`INSERT INTO agendamentos (nome,tel,tel_documentos,cpf,modalidade,horario_agendado,status) VALUES ($1,$2,$3,$4,$5,$6,'pendente') RETURNING id`,[nome,tel,tel_documentos||tel,cpf||"",modalidade||"chat",horario_agendado]);
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
    const RESEND_KEY=process.env.RESEND_API_KEY;
    const medicosResult=await pool.query(`SELECT email FROM medicos WHERE ativo=true AND status='aprovado' ORDER BY status_online DESC`);
    const destinatarios=medicosResult.rows.map(m=>m.email).filter(Boolean);
    if (!destinatarios.includes("gustavosgbf@gmail.com")) destinatarios.push("gustavosgbf@gmail.com");
    const horarioFormatado=new Date(ag.horario_agendado).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const tipoLabel=ag.modalidade==="video"?"Video":"Chat";
    const htmlAg=`<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden"><div style="background:linear-gradient(135deg,#4285f4,#34a853);padding:20px 28px"><h2 style="margin:0;color:#fff;font-size:18px">Novo AGENDAMENTO - ${horarioFormatado}</h2></div><div style="padding:28px"><p style="color:rgba(255,200,100,.9);font-size:14px;margin-bottom:20px;background:rgba(255,200,0,.06);border:1px solid rgba(255,200,0,.2);padding:12px 16px;border-radius:8px">Agendamento confirmado - paciente aguarda no horario marcado.</p><table style="width:100%;border-collapse:collapse"><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:140px">Paciente</td><td style="padding:8px 0;font-weight:600">${ag.nome}</td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0;font-weight:600">${ag.tel}</td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Modalidade</td><td style="padding:8px 0;font-weight:600">${tipoLabel}</td></tr><tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Horario</td><td style="padding:8px 0;font-weight:700;font-size:16px;color:#b4e05a">${horarioFormatado}</td></tr></table></div></div>`;
    if (RESEND_KEY) {
      try {
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "ConsultaJa24h <onboarding@resend.dev>", to: destinatarios, subject: `Novo AGENDAMENTO - ${horarioFormatado} (${tipoLabel})`, html: htmlAg })
        });
        const resendData = await resendRes.json();
        if (resendData.id) {
          console.log("[EMAIL-AGENDAMENTO] Enviado para:", destinatarios.join(", "), "| ID:", resendData.id);
        } else {
          console.error("[EMAIL-AGENDAMENTO] Resend recusou:", JSON.stringify(resendData));
        }
      } catch(e) {
        console.error("[EMAIL-AGENDAMENTO] Erro ao chamar Resend:", e.message);
      }
    }
    return res.json({ok:true,agendamento:ag,horarioFormatado});
  } catch(e) { console.error("Erro em /api/agendamento/confirmar:", e); return res.status(500).json({ok:false,error:"Erro ao confirmar agendamento"}); }
});

app.post("/api/agendamento/:id/iniciar", async (req, res) => {
  try {
    const auth=req.headers["authorization"]||"";
    let medicoId, medicoNome;
    try { const d=jwt.verify(auth.replace("Bearer ",""),process.env.JWT_SECRET||"fallback_secret"); medicoId=d.id; medicoNome=d.nome; }
    catch(e) { return res.status(401).json({ok:false,error:"Token invalido"}); }
    const ag=await pool.query(`SELECT * FROM agendamentos WHERE id=$1 AND status='confirmado'`,[req.params.id]);
    if (ag.rowCount===0) return res.status(404).json({ok:false,error:"Agendamento nao encontrado"});
    const a=ag.rows[0];
    const insert=await pool.query(`INSERT INTO fila_atendimentos (nome,tel,tel_documentos,cpf,tipo,triagem,status,medico_id,medico_nome,assumido_em) VALUES ($1,$2,$3,$4,$5,$6,'assumido',$7,$8,NOW()) RETURNING id`,
      [a.nome,a.tel,a.tel_documentos||a.tel,a.cpf||"",a.modalidade||"chat","(Agendamento antecipado)",medicoId,medicoNome]);
    const atendimentoId=insert.rows[0].id;
    await pool.query(`UPDATE agendamentos SET status='iniciado' WHERE id=$1`,[req.params.id]);
    const SITE_URL=process.env.SITE_URL||"https://consultaja24h.com.br";
    return res.json({ok:true,atendimentoId,linkRetorno:`${SITE_URL}/triagem.html?consulta=${atendimentoId}`});
  } catch(e) { console.error("Erro em /api/agendamento/:id/iniciar:", e); return res.status(500).json({ok:false,error:"Erro ao iniciar consulta"}); }
});

app.get("/api/agendamentos", checkMedico, async (req, res) => {
  try {
    const result=await pool.query(`SELECT id,nome,tel,tel_documentos,cpf,modalidade,horario_agendado,status,criado_em FROM agendamentos WHERE status='confirmado' ORDER BY horario_agendado ASC`);
    return res.json({ok:true,agendamentos:result.rows});
  } catch(e) { return res.status(500).json({ok:false,error:"Erro ao listar agendamentos"}); }
});

app.get("/api/test-db", async (req, res) => {
  try { const result=await pool.query("SELECT NOW()"); res.json(result.rows[0]); }
  catch (err) { res.status(500).json({error:err.message}); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
