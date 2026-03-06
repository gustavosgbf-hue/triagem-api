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

// ── ADMIN — PROTEÇÃO SEGURA ──────────────────────────────
function checkAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"];
  const senhaAdmin = process.env.ADMIN_PASSWORD;

  if (!senhaAdmin) {
    return res.status(500).send("ADMIN_PASSWORD não configurada");
  }

  if (!senha || senha !== senhaAdmin) {
    return res.status(403).send("Acesso negado");
  }

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
      return res.status(500).json({
        ok: false,
        error: data.message || "Erro ao gerar pagamento",
      });
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
    const mpRes = await fetch(
      `https://api.mercadopago.com/v1/payments/${req.params.id}`,
      {
        headers: { Authorization: `Bearer ${MP_TOKEN}` },
      }
    );

    const data = await mpRes.json();

    if (!mpRes.ok) {
      console.error("MP status error:", data);
      return res.status(500).json({
        ok: false,
        error: data.message || "Erro ao consultar pagamento",
      });
    }

    return res.json({ ok: true, status: data.status });
  } catch (e) {
    console.error("Erro em /api/payment/:id", e);
    return res.status(500).json({
      ok: false,
      error: "Erro ao consultar pagamento",
    });
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
                )}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">📱 Chamar no WhatsApp</a>
                <div style="margin-top:6px;font-size:12px;color:rgba(255,255,255,.45)">${telLimpo}</div>
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
      </div>`;

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

    await pool.query(
      `INSERT INTO fila_atendimentos (nome, tel, cpf, tipo, triagem, status)
       VALUES ($1, $2, $3, $4, $5, 'aguardando')`,
      [nome || "—", tel || "—", cpf || "—", "whatsapp", triagem || ""]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("Notify error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ── IDENTIFICAÇÃO ────────────────────────────────────────
app.post("/api/identify", async (req, res) => {
  try {
    const { nome, tel } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
    });
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—";

    await pool.query(
      "INSERT INTO identificacoes (nome, tel, data, ip) VALUES ($1,$2,$3,$4)",
      [nome || "—", tel || "—", agora, ip]
    );

    await appendToSheet("Identificacoes", [agora, nome || "", tel || "", ip]);
    console.log(`[IDENTIFY] ${nome} | ${tel}`);

    return res.json({ ok: true });
  } catch (e) {
    console.error("Identify error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ── CONSENTIMENTO ────────────────────────────────────────
app.post("/api/consent", async (req, res) => {
  try {
    const { nome, tel, versao } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
    });
    const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "—";

    await pool.query(
      "INSERT INTO consentimentos (nome, tel, versao, data, ip) VALUES ($1,$2,$3,$4,$5)",
      [nome || "—", tel || "—", versao || "v1.0", agora, ip]
    );

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
    console.error("Consent error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ── ATENDER (redireciona médico para WhatsApp) ───────────
app.get("/atender", async (req, res) => {
  try {
    const { medico, paciente, tel } = req.query;

    if (!tel) {
      return res.status(400).send("Parâmetros inválidos");
    }

    const agora = new Date().toLocaleString("pt-BR", {
      timeZone: "America/Fortaleza",
    });

    await pool.query(
      "INSERT INTO logs_atendimentos (medico, paciente, tel, data) VALUES ($1,$2,$3,$4)",
      [medico || "desconhecido", paciente || "—", tel, agora]
    );

    await appendToSheet("Atendimentos", [
      agora,
      paciente || "",
      tel || "",
      "",
      "Assumido",
      medico || "",
      "",
    ]);

    console.log(
      `[ATENDIMENTO] Médico: ${medico} | Paciente: ${paciente} | Tel: ${tel}`
    );

    const telLimpo = String(tel).replace(/\D/g, "");
    return res.redirect(`https://wa.me/55${telLimpo}`);
  } catch (e) {
    console.error("Erro em /atender:", e);
    return res.status(500).send("Erro ao assumir atendimento");
  }
});

// ── ADMIN — CADASTRAR MÉDICO ─────────────────────────────
app.post("/api/admin/medico/criar", checkAdmin, async (req, res) => {
  try {
    const { nome, email, crm, senha } = req.body || {};

    if (!nome || !email || !crm || !senha) {
      return res.status(400).json({
        ok: false,
        error: "Campos obrigatórios faltando",
      });
    }

    const senha_hash = await bcrypt.hash(senha, 10);

    const result = await pool.query(
      `INSERT INTO medicos (nome, email, senha_hash, crm, status_online, ativo)
       VALUES ($1, $2, $3, $4, false, true)
       RETURNING id, nome, email, crm, status_online, ativo, created_at`,
      [nome, email.trim().toLowerCase(), senha_hash, crm]
    );

    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    console.error("Erro ao criar médico:", err);

    if (err.code === "23505") {
      return res.status(400).json({
        ok: false,
        error: "E-mail já cadastrado",
      });
    }

    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ADMIN — LISTAR MÉDICOS ───────────────────────────────
app.get("/api/admin/medicos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, nome, email, crm, status_online, ativo, created_at FROM medicos ORDER BY id DESC"
    );

    return res.json({ ok: true, medicos: result.rows });
  } catch (err) {
    console.error("Erro ao listar médicos:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── ADMIN — ATIVAR/DESATIVAR MÉDICO ──────────────────────
app.patch("/api/admin/medico/:id", checkAdmin, async (req, res) => {
  try {
    const { ativo } = req.body || {};

    if (typeof ativo !== "boolean") {
      return res.status(400).json({
        ok: false,
        error: "Campo 'ativo' deve ser boolean",
      });
    }

    const result = await pool.query(
      "UPDATE medicos SET ativo = $1 WHERE id = $2 RETURNING id, nome, ativo",
      [ativo, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Médico não encontrado",
      });
    }

    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    console.error("Erro ao atualizar médico:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── RELATÓRIOS ADMIN (lendo do PostgreSQL) ───────────────
app.get("/relatorio", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT medico, paciente, tel, data FROM logs_atendimentos ORDER BY id DESC"
    );
    const lista = result.rows;

    if (lista.length === 0) {
      return res.send(
        '<h2 style="font-family:sans-serif;padding:20px">Nenhum atendimento registrado ainda.</h2>'
      );
    }

    const porData = {};
    lista.forEach((a) => {
      const dia = String(a.data).split(",")[0];
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
      .total{background:rgba(255,255,255,.04);border-radius:12px;padding:16px 20px;margin-bottom:28px;display:flex;gap:32px;flex-wrap:wrap}
      .total-item span{display:block;font-size:.72rem;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
      .total-item strong{font-size:1.6rem;color:#b4e05a}
      a{color:#5ee0a0}
    </style>
    </head><body>
    <h1>📊 Relatório de Atendimentos</h1>
    <p style="color:rgba(255,255,255,.4);font-size:.85rem;margin-bottom:24px">ConsultaJá24h · PostgreSQL</p>
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
        html += `<h2>${dia} — ${ats.length} atendimento${ats.length > 1 ? "s" : ""}</h2>
        <table><tr><th>Horário</th><th>Médico</th><th>Paciente</th><th>WhatsApp</th></tr>`;

        ats.forEach((a) => {
          const hora = String(a.data).split(",")[1] || "";
          html += `<tr>
            <td>${hora.trim()}</td>
            <td><span class="badge">${a.medico}</span></td>
            <td>${a.paciente}</td>
            <td><a href="https://wa.me/55${String(a.tel || "").replace(/\D/g, "")}">📱 ${a.tel}</a></td>
          </tr>`;
        });

        html += "</table>";
      });

    html += "</body></html>";
    res.send(html);
  } catch (e) {
    console.error("Erro em /relatorio:", e);
    res.status(500).send("Erro ao carregar relatório");
  }
});

app.get("/identificacoes", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT nome, tel, data, ip FROM identificacoes ORDER BY id DESC"
    );
    const lista = result.rows;

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
        .map(
          (i) => `<tr>
        <td>${i.data}</td>
        <td>${i.nome}</td>
        <td><a href="https://wa.me/55${String(i.tel || "").replace(/\D/g, "")}">📱 ${i.tel}</a></td>
        <td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip}</td>
      </tr>`
        )
        .join("")}
    </table>
    </body></html>`;

    res.send(html);
  } catch (e) {
    console.error("Erro em /identificacoes:", e);
    res.status(500).send("Erro ao carregar identificações");
  }
});

app.get("/consentimentos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT nome, tel, versao, data, ip FROM consentimentos ORDER BY id DESC"
    );
    const lista = result.rows;

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
        .map(
          (i) => `<tr>
        <td>${i.data}</td>
        <td>${i.nome}</td>
        <td><a href="https://wa.me/55${String(i.tel || "").replace(/\D/g, "")}">📱 ${i.tel}</a></td>
        <td><span class="badge">${i.versao}</span></td>
        <td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip}</td>
      </tr>`
        )
        .join("")}
    </table>
    </body></html>`;

    res.send(html);
  } catch (e) {
    console.error("Erro em /consentimentos:", e);
    res.status(500).send("Erro ao carregar consentimentos");
  }
});

app.get("/admin-relatorio", async (req, res) => {
  const { senha } = req.query;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).send("ADMIN_PASSWORD não configurada");
  }

  if (!senha || senha !== process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Acesso negado");
  }

  try {
    const result = await pool.query(
      "SELECT medico, paciente, tel, data FROM logs_atendimentos ORDER BY id DESC"
    );
    const lista = result.rows;

    if (lista.length === 0) {
      return res.send(
        '<h2 style="font-family:sans-serif;padding:20px">Nenhum atendimento registrado ainda.</h2>'
      );
    }

    const porData = {};
    lista.forEach((a) => {
      const dia = String(a.data).split(",")[0];
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
      .total{background:rgba(255,255,255,.04);border-radius:12px;padding:16px 20px;margin-bottom:28px;display:flex;gap:32px;flex-wrap:wrap}
      .total-item span{display:block;font-size:.72rem;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}
      .total-item strong{font-size:1.6rem;color:#b4e05a}
      a{color:#5ee0a0}
    </style>
    </head><body>
    <h1>📊 Relatório de Atendimentos</h1>
    <p style="color:rgba(255,255,255,.4);font-size:.85rem;margin-bottom:24px">ConsultaJá24h · PostgreSQL</p>
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
        html += `<h2>${dia} — ${ats.length} atendimento${ats.length > 1 ? "s" : ""}</h2>
        <table><tr><th>Horário</th><th>Médico</th><th>Paciente</th><th>WhatsApp</th></tr>`;

        ats.forEach((a) => {
          const hora = String(a.data).split(",")[1] || "";
          html += `<tr>
            <td>${hora.trim()}</td>
            <td><span class="badge">${a.medico}</span></td>
            <td>${a.paciente}</td>
            <td><a href="https://wa.me/55${String(a.tel || "").replace(/\D/g, "")}">📱 ${a.tel}</a></td>
          </tr>`;
        });

        html += "</table>";
      });

    html += "</body></html>";
    return res.send(html);
  } catch (e) {
    console.error("Erro em /admin-relatorio:", e);
    return res.status(500).send("Erro ao carregar relatório");
  }
});

app.get("/admin-identificacoes", async (req, res) => {
  const { senha } = req.query;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).send("ADMIN_PASSWORD não configurada");
  }

  if (!senha || senha !== process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Acesso negado");
  }

  try {
    const result = await pool.query(
      "SELECT nome, tel, data, ip FROM identificacoes ORDER BY id DESC"
    );
    const lista = result.rows;

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
        .map(
          (i) => `<tr>
        <td>${i.data}</td>
        <td>${i.nome}</td>
        <td><a href="https://wa.me/55${String(i.tel || "").replace(/\D/g, "")}">📱 ${i.tel}</a></td>
        <td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip}</td>
      </tr>`
        )
        .join("")}
    </table>
    </body></html>`;

    return res.send(html);
  } catch (e) {
    console.error("Erro em /admin-identificacoes:", e);
    return res.status(500).send("Erro ao carregar identificações");
  }
});

app.get("/admin-consentimentos", async (req, res) => {
  const { senha } = req.query;

  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).send("ADMIN_PASSWORD não configurada");
  }

  if (!senha || senha !== process.env.ADMIN_PASSWORD) {
    return res.status(403).send("Acesso negado");
  }

  try {
    const result = await pool.query(
      "SELECT nome, tel, versao, data, ip FROM consentimentos ORDER BY id DESC"
    );
    const lista = result.rows;

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
        .map(
          (i) => `<tr>
        <td>${i.data}</td>
        <td>${i.nome}</td>
        <td><a href="https://wa.me/55${String(i.tel || "").replace(/\D/g, "")}">📱 ${i.tel}</a></td>
        <td><span class="badge">${i.versao}</span></td>
        <td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip}</td>
      </tr>`
        )
        .join("")}
    </table>
    </body></html>`;

    return res.send(html);
  } catch (e) {
    console.error("Erro em /admin-consentimentos:", e);
    return res.status(500).send("Erro ao carregar consentimentos");
  }
});

app.post("/api/medico/login", async (req, res) => {
  try {
    const { email, senha } = req.body || {};

    if (!email || !senha) {
      return res.status(400).json({
        ok: false,
        error: "E-mail e senha são obrigatórios",
      });
    }

    const result = await pool.query(
      "SELECT id, nome, email, crm, senha_hash, ativo FROM medicos WHERE email = $1 LIMIT 1",
      [email.trim().toLowerCase()]
    );

    if (result.rowCount === 0) {
      return res.status(401).json({
        ok: false,
        error: "Credenciais inválidas",
      });
    }

    const medico = result.rows[0];

    if (!medico.ativo) {
      return res.status(403).json({
        ok: false,
        error: "Médico inativo",
      });
    }

    const senhaOk = await bcrypt.compare(senha, medico.senha_hash);

    if (!senhaOk) {
      return res.status(401).json({
        ok: false,
        error: "Credenciais inválidas",
      });
    }

const token = jwt.sign(
  { id: medico.id, nome: medico.nome, crm: medico.crm },
  process.env.JWT_SECRET || "fallback_secret",
  { expiresIn: "8h" }
);

return res.json({
  ok: true,
  token,
  medico: {
    id: medico.id,
    nome: medico.nome,
    email: medico.email,
    crm: medico.crm,
  },
});
```

**3. No Render**, adiciona a variável:
```
JWT_SECRET = cj24h_jwt_2026_xK9pQ
  } catch (err) {
    console.error("Erro em /api/medico/login:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro interno no login",
    });
  }
});

app.get("/api/fila", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, tel, cpf, tipo, triagem, status, medico_id, medico_nome, criado_em
       FROM fila_atendimentos
       WHERE status = 'aguardando'
       ORDER BY criado_em ASC`
    );

    return res.json({ ok: true, fila: result.rows });
  } catch (err) {
    console.error("Erro em /api/fila:", err);
    return res.status(500).json({ ok: false, error: "Erro ao carregar fila" });
  }
});

app.post("/api/atendimento/assumir", async (req, res) => {
  try {
    const { filaId, medicoId, medicoNome } = req.body || {};

    if (!filaId || !medicoId || !medicoNome) {
      return res.status(400).json({
        ok: false,
        error: "Dados obrigatórios faltando",
      });
    }

    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'assumido',
           medico_id = $1,
           medico_nome = $2,
           assumido_em = NOW()
       WHERE id = $3
         AND status = 'aguardando'
       RETURNING *`,
      [medicoId, medicoNome, filaId]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({
        ok: false,
        error: "Paciente já foi assumido",
      });
    }

    return res.json({ ok: true, atendimento: result.rows[0] });
  } catch (err) {
    console.error("Erro em /api/atendimento/assumir:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao assumir atendimento",
    });
  }
});

app.post("/api/atendimento/encerrar", async (req, res) => {
  try {
    const { filaId } = req.body || {};

    if (!filaId) {
      return res.status(400).json({
        ok: false,
        error: "filaId é obrigatório",
      });
    }

    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'encerrado',
           encerrado_em = NOW()
       WHERE id = $1
       RETURNING *`,
      [filaId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        ok: false,
        error: "Atendimento não encontrado",
      });
    }

    return res.json({ ok: true, atendimento: result.rows[0] });
  } catch (err) {
    console.error("Erro em /api/atendimento/encerrar:", err);
    return res.status(500).json({
      ok: false,
      error: "Erro ao encerrar atendimento",
    });
  }
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
