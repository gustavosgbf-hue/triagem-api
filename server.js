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

// ── HEALTH ───────────────────────────────────────────────
app.get("/", (req, res) => res.send("API rodando"));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
