import express from "express";
import cors from "cors";
import fs from "fs";
import { google } from "googleapis";
import pg from "pg";

const { existsSync, readFileSync, writeFileSync } = fs;
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

if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY não definida");
  process.exit(1);
}
if (!MP_TOKEN) {
  console.error("MP_ACCESS_TOKEN não definida");
  process.exit(1);
}

// ── GOOGLE SHEETS ─────────────────────────────────────────────────
const SPREADSHEET_ID = "1z-m4_zJQOIelzOkiUvU8L7VP0CHxJHC317Lb-q0GVCQ";

// MANTENHA AQUI O SEU serviceAccount EXATAMENTE COMO JÁ ESTÁ NO SEU ARQUIVO
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
  if (!res.ok) {
    return {
      ok: false,
      error: data?.error?.message || JSON.stringify(data),
    };
  }

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
      return res.status(503).json({
        text: "Sistema temporariamente indisponível. Tente novamente em instantes.",
      });
    }

    return res.json({ text: out.text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Erro interno temporário." });
  }
}

app.post("/api/triage", handleChat);
app.post("/api/doctor", handleChat);

// ── MERCADO PAGO — GERAR PIX ─────────────────────────────
app.post("/api/payment", async (req, res) => {
  try {
    const { email, nome } = req.body || {};
    const idempotency = `consult-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;

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
          last_name:
            (nome || "Paciente").split(" ").slice(1).join(" ") || "Online",
        },
      }),
    });

    const data = await mpRes.json();

    if (!mpRes.ok) {
      console.error("MP error:", data);
      return res
        .status(500)
        .json({ ok: false, error: data.message || "Erro ao gerar pagamento" });
    }

    return res.json({
      ok: true,
      payment_id: data.id,
      status: data.status,
      qr_code: data.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

// ── MERCADO PAGO — CHECAR STATUS ─────────────────────────
app.get("/api/payment/:id", async (req, res) => {
  try {
    const mpRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${req.params.id}`,
      {
        headers: { Authorization: `Bearer ${MP_TOKEN}` },
      }
    );
    const data = await mpRes.json();
    return res.json({ ok: true, status: data.status });
  } catch (e) {
    return res
      .status(500)
      .json({ ok: false, error: "Erro ao consultar pagamento" });
  }
});

// ── NOTIFICAR MÉDICOS ────────────────────────────────────
app.post("/api/notify", async (req, res) => {
  try {
    const { nome, tel, cpf, triagem } = req.body || {};
    const RESEND_KEY = process.env.RESEND_API_KEY;

    const telLimpo = (tel || "").replace(/\D/g, "");
    const BASE_URL =
      process.env.RENDER_EXTERNAL_URL || "https://triagem-api.onrender.com";

    function linkMedico(nomeMedico) {
      return `${BASE_URL}/atender?medico=${encodeURIComponent(
        nomeMedico
      )}&paciente=${encodeURIComponent(nome || "")}&tel=${encodeURIComponent(
        telLimpo
      )}`;
    }

    function montarTabelaTriagem(texto) {
      if (!texto) {
        return '<tr><td colspan="2" style="padding:8px 12px;color:rgba(255,255,255,.5)">—</td></tr>';
      }

      return texto
        .split(/[,;]\s*(?=[A-ZÀÁÂÃÉÊÍÓÔÕÚÇ])/i)
        .map((item) => {
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
        })
        .join("");
    }

    const destinatarios = [
      "gustavosgbf@gmail.com",
      process.env.EMAIL_MEDICO_2 || "",
    ].filter(Boolean);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:20px 28px">
          <h2 style="margin:0;color:#051208;font-size:18px">🏥 Nova triagem — ConsultaJá24h</h2>
        </div>
        <div style="padding:28px">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <tr>
              <td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:120px">Paciente</td>
              <td style="padding:8px 0;font-weight:600">${nome || "—"}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">CPF</td>
              <td style="padding:8px 0;font-weight:600">${cpf || "—"}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td>
              <td style="padding:8px 0">
                <a href="${linkMedico(
                  "Dr. Gustavo"
                )}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">📱 Chamar no WhatsApp</a><div style="margin-top:6px;font-size:12px;color:rgba(255,255,255,.45)">${telLimpo}</div>
              </td>
            </tr>
          </table>

          <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;overflow:hidden">
            <div style="padding:12px 14px;background:rgba(180,224,90,.08);border-bottom:1px solid rgba(255,255,255,.08)">
              <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4)">Triagem completa</p>
            </div>
            <table style="width:100%;border-collapse:collapse">
              ${montarTabelaTriagem(triagem)}
            </table>
          </div>

          <p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,.3)">Enviado automaticamente pelo sistema ConsultaJá24h</p>
        </div>
      </div>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: "ConsultaJá24h <onboarding@resend.dev>",
        to: destinatarios,
        subject: `🏥 Nova triagem — ${nome || "Paciente"}`,
        html,
      }),
    });

    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      console.error("Resend error:", resendData);
    }

    await appendToSheet("Atendimentos", [
      new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }),
      nome || "",
      tel || "",
      cpf || "",
      "Aguardando",
      "",
      triagem || "",
    ]);

    return res.json({ ok: true });
  } catch (e) {
    console.error("Notify error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ── IDENTIFICAÇÃO E CONSENTIMENTO LGPD ──────────────────
function lerJSON(arquivo) {
  try {
    if (existsSync(arquivo)) return JSON.parse(readFileSync(arquivo, "utf8"));
  } catch (e) {}
  return [];
}

function salvarJSON(arquivo, lista) {
  writeFileSync(arquivo, JSON.stringify(lista, null, 2));
}

app.post("/api/identify", async (req, res) => {
  try {
    const { nome, tel } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
    });
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—";

    const lista = lerJSON("./identificacoes.json");
    lista.push({ nome: nome || "—", tel: tel || "—", data: agora, ip });
    salvarJSON("./identificacoes.json", lista);

    await appendToSheet("Identificacoes", [agora, nome || "", tel || "", ip]);
    console.log(`[IDENTIFY] ${nome} | ${tel}`);

    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

app.post("/api/consent", async (req, res) => {
  try {
    const { nome, tel, versao } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
    });
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—";

    const lista = lerJSON("./consentimentos.json");
    lista.push({
      nome: nome || "—",
      tel: tel || "—",
      versao: versao || "v1.0",
      data: agora,
      ip,
    });
    salvarJSON("./consentimentos.json", lista);

    await appendToSheet("Consentimentos", [
      agora,
      nome || "",
      tel || "",
      versao || "v1.0",
      ip,
    ]);

    console.log(`[CONSENT] ${nome} | ${tel} | ${versao}`);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

// ── RASTREAMENTO DE ATENDIMENTOS ────────────────────────
const ARQUIVO = "./atendimentos.json";

function carregarAtendimentos() {
  try {
    if (fs.existsSync(ARQUIVO)) return JSON.parse(fs.readFileSync(ARQUIVO, "utf8"));
  } catch (e) {}
  return [];
}

function salvarAtendimento(medico, paciente, tel) {
  const lista = carregarAtendimentos();
  lista.push({
    medico,
    paciente,
    tel,
    data: new Date().toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
    }),
  });
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
}

app.get("/atender", async (req, res) => {
  const { medico, paciente, tel } = req.query;
  if (!tel) return res.status(400).send("Parâmetros inválidos");

  salvarAtendimento(medico || "desconhecido", paciente || "—", tel);

  await appendToSheet("Atendimentos", [
    new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" }),
    paciente || "",
    tel || "",
    "",
    "Assumido",
    medico || "",
    "",
  ]);

  console.log(`[ATENDIMENTO] Médico: ${medico} | Paciente: ${paciente} | Tel: ${tel}`);

  const telLimpo = tel.replace(/\D/g, "");
  res.redirect(`https://wa.me/55${telLimpo}`);
});

// ── RELATÓRIOS ───────────────────────────────────────────
app.get("/relatorio", (req, res) => {
  const lista = carregarAtendimentos();

  if (lista.length === 0) {
    return res.send(
      '<h2 style="font-family:sans-serif;padding:20px">Nenhum atendimento registrado ainda.</h2>'
    );
  }

  const porData = {};
  lista.forEach((a) => {
    const dia = a.data.split(",")[0];
    if (!porData[dia]) porData[dia] = [];
    porData[dia].push(a);
  });

  const porMedico = {};
  lista.forEach((a) => {
    porMedico[a.medico] = (porMedico[a.medico] || 0) + 1;
  });

  let html = `
  <html><head><meta charset="utf-8">
  <style>
    body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}
    h1{color:#b4e05a;margin-bottom:4px}
    h2{color:#5ee0a0;margin:28px 0 12px;font-size:1rem;text-transform:uppercase;letter-spacing:.1em}
    table{width:100%;border-collapse:collapse;margin-bottom:24px}
    th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
    td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}
    .badge{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(94,224,160,.1);color:#5ee0a0;font-size:.75rem}
    .total{background:rgba(255,255,255,.04);border-radius:12px;padding:16px 20px;margin-bottom:28px;display:flex;gap:32px}
    .total-item span{display:block;font-size:.72rem;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
    .total-item strong{font-size:1.6rem;color:#b4e05a}
    a{color:#5ee0a0}
  </style>
  </head><body>
  <h1>📊 Relatório de Atendimentos</h1>
  <p style="color:rgba(255,255,255,.4);font-size:.85rem;margin-bottom:24px">ConsultaJá24h · atualizado em tempo real</p>
  <div class="total">
    <div class="total-item"><span>Total</span><strong>${lista.length}</strong></div>
    ${Object.entries(porMedico)
      .map(
        ([m, n]) =>
          `<div class="total-item"><span>${m}</span><strong>${n}</strong></div>`
      )
      .join("")}
  </div>`;

  Object.entries(porData)
    .reverse()
    .forEach(([dia, ats]) => {
      html += `<h2>${dia} — ${ats.length} atendimento${
        ats.length > 1 ? "s" : ""
      }</h2>
      <table><tr><th>Horário</th><th>Médico</th><th>Paciente</th><th>WhatsApp</th></tr>`;
      ats.forEach((a) => {
        const hora = a.data.split(",")[1] || "";
        html += `<tr>
          <td>${hora.trim()}</td>
          <td><span class="badge">${a.medico}</span></td>
          <td>${a.paciente}</td>
          <td><a href="https://wa.me/55${a.tel.replace(/\D/g, "")}">📱 ${a.tel}</a></td>
        </tr>`;
      });
      html += "</table>";
    });

  html += "</body></html>";
  res.send(html);
});

app.get("/identificacoes", (req, res) => {
  const lista = lerJSON("./identificacoes.json");

  if (lista.length === 0) {
    return res.send(
      '<h2 style="font-family:sans-serif;padding:20px">Nenhuma identificação registrada ainda.</h2>'
    );
  }

  const html = `
  <html><head><meta charset="utf-8">
  <style>
    body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}
    h1{color:#b4e05a;margin-bottom:4px}
    p{color:rgba(255,255,255,.4);font-size:.85rem;margin-bottom:24px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
    td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}
    a{color:#5ee0a0}
  </style>
  </head><body>
  <h1>📋 Identificações registradas</h1>
  <p>${lista.length} registro${lista.length > 1 ? "s" : ""} · antes do aceite dos termos</p>
  <table>
    <tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
    ${lista
      .slice()
      .reverse()
      .map(
        (i) => `<tr>
      <td>${i.data}</td>
      <td>${i.nome}</td>
      <td><a href="https://wa.me/55${(i.tel || "").replace(/\D/g, "")}">📱 ${i.tel}</a></td>
      <td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip}</td>
    </tr>`
      )
      .join("")}
  </table>
  </body></html>`;

  res.send(html);
});

app.get("/consentimentos", (req, res) => {
  const lista = lerJSON("./consentimentos.json");

  if (lista.length === 0) {
    return res.send(
      '<h2 style="font-family:sans-serif;padding:20px">Nenhum consentimento registrado ainda.</h2>'
    );
  }

  const html = `
  <html><head><meta charset="utf-8">
  <style>
    body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}
    h1{color:#b4e05a;margin-bottom:4px}
    p{color:rgba(255,255,255,.4);font-size:.85rem;margin-bottom:24px}
    table{width:100%;border-collapse:collapse}
    th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase}
    td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}
    .badge{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(94,224,160,.1);color:#5ee0a0;font-size:.75rem}
    a{color:#5ee0a0}
  </style>
  </head><body>
  <h1>✅ Consentimentos LGPD</h1>
  <p>${lista.length} aceite${lista.length > 1 ? "s" : ""} registrados com identidade vinculada</p>
  <table>
    <tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>Versão</th><th>IP</th></tr>
    ${lista
      .slice()
      .reverse()
      .map(
        (i) => `<tr>
      <td>${i.data}</td>
      <td>${i.nome}</td>
      <td><a href="https://wa.me/55${(i.tel || "").replace(/\D/g, "")}">📱 ${i.tel}</a></td>
      <td><span class="badge">${i.versao}</span></td>
      <td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip}</td>
    </tr>`
      )
      .join("")}
  </table>
  </body></html>`;

  res.send(html);
});

// ── HEALTH ───────────────────────────────────────────────
app.get("/", (req, res) => res.send("API rodando"));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/api/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Erro DB:", err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));