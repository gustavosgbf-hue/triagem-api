import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MP_TOKEN   = process.env.MP_ACCESS_TOKEN;

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY não definida"); process.exit(1); }
if (!MP_TOKEN)   { console.error("MP_ACCESS_TOKEN não definida"); process.exit(1); }

// ── OPENAI ───────────────────────────────────────────────
async function callOpenAI({ system, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: String(system ?? "") },
        ...(messages || [])
          .filter(m => m?.role !== "system")
          .map(m => ({ role: m.role, content: String(m.content ?? "") }))
      ]
    })
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
        "Authorization": `Bearer ${MP_TOKEN}`,
        "X-Idempotency-Key": idempotency
      },
      body: JSON.stringify({
        transaction_amount: 49.90,
        description: "Consulta Médica Online – Pronto Atendimento Online",
        payment_method_id: "pix",
        payer: {
          email: email || "paciente@prontoatendimento.com",
          first_name: (nome || "Paciente").split(" ")[0],
          last_name: (nome || "Paciente").split(" ").slice(1).join(" ") || "Online"
        }
      })
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
      qr_code_base64: data.point_of_interaction?.transaction_data?.qr_code_base64
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Erro interno" });
  }
});

// ── MERCADO PAGO — CHECAR STATUS ─────────────────────────
app.get("/api/payment/:id", async (req, res) => {
  try {
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${req.params.id}`, {
      headers: { "Authorization": `Bearer ${MP_TOKEN}` }
    });
    const data = await mpRes.json();
    return res.json({ ok: true, status: data.status });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro ao consultar pagamento" });
  }
});


// ── NOTIFICAR MÉDICOS (email via Resend) ────────────────
app.post("/api/notify", async (req, res) => {
  try {
    const { nome, tel, triagem } = req.body || {};
    const RESEND_KEY = process.env.RESEND_API_KEY;

    // Formata número como link do WhatsApp
    const telLimpo = (tel || '').replace(/\D/g, '');
    const waLink = telLimpo ? `https://wa.me/55${telLimpo}` : '—';

    // Destinatários — adicione os emails dos médicos aqui
    const destinatarios = [
      'gustavosgbf@gmail.com',
      process.env.EMAIL_MEDICO_2 || ''
    ].filter(Boolean);

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:20px 28px">
          <h2 style="margin:0;color:#051208;font-size:18px">🏥 Nova triagem — ConsultaJá24h</h2>
        </div>
        <div style="padding:28px">
          <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:120px">Paciente</td><td style="padding:8px 0;font-weight:600">${nome || '—'}</td></tr>
            <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0"><a href="${waLink}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">📱 Chamar no WhatsApp</a></td></tr>
          </table>
          <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:18px">
            <p style="margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4)">Triagem completa</p>
            <p style="margin:0;font-size:14px;line-height:1.9;color:rgba(255,255,255,.8)">${
  (triagem || '—')
    .split(/,\s*(?=[A-ZÀÁÂÃÉÊÍÓÔÕÚÇ])/)
    .map(item => {
      const [key, ...val] = item.split(':');
      return val.length
        ? `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
            <span style="color:rgba(255,255,255,.4);font-size:12px;min-width:180px;flex-shrink:0">${key.trim()}</span>
            <span style="color:#fff;font-weight:500">${val.join(':').trim()}</span>
           </div>`
        : `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);color:#fff">${item.trim()}</div>`;
    })
    .join('')
}</p>
          </div>
          <p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,.3)">Enviado automaticamente pelo sistema ConsultaJá24h</p>
        </div>
      </div>
    `;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${RESEND_KEY}`
      },
      body: JSON.stringify({
        from: "ConsultaJá24h <onboarding@resend.dev>",
        to: destinatarios,
        subject: `🏥 Nova triagem — ${nome || 'Paciente'}`,
        html
      })
    });

    const resendData = await resendRes.json();
    if (!resendRes.ok) {
      console.error("Resend error:", resendData);
      return res.status(500).json({ ok: false });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("Notify error:", e);
    return res.status(500).json({ ok: false });
  }
});

// ── HEALTH ───────────────────────────────────────────────
app.get("/", (req, res) => res.send("API rodando"));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
