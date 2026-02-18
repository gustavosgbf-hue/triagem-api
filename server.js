import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.OPENAI_API_KEY;

if (!API_KEY) {
  console.error("OPENAI_API_KEY não definida");
  process.exit(1);
}

app.get("/health", (req, res) => res.json({ ok: true }));

async function callOpenAI({ system, messages }) {
  const url = "https://api.openai.com/v1/chat/completions";

  const body = {
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      { role: "system", content: String(system ?? "") },
      ...(messages || []).map(m => ({
        role: m.role,
        content: String(m.content ?? "")
      }))
    ]
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`
    },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    const msg =
      data?.error?.message ||
      data?.message ||
      JSON.stringify(data);
    return { ok: false, error: msg };
  }

  const text =
    data?.choices?.[0]?.message?.content || "";

  return { ok: true, text };
}

async function handleChat(req, res) {
  try {
    const { system, messages } = req.body || {};

    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: "Payload inválido" });
    }

    // remove qualquer role system que venha do frontend
    const filtered = messages.filter(m => m?.role !== "system");

    const out = await callOpenAI({ system, messages: filtered });

    if (!out.ok) {
      return res.status(503).json({
        text: "Sistema temporariamente indisponível. Tente novamente ou inicie consulta via WhatsApp."
      });
    }

    return res.json({ text: out.text });

  } catch (e) {
    console.error(e);
    return res.status(500).json({
      text: "Erro interno temporário."
    });
  }
}

app.post("/api/triage", handleChat);
app.post("/api/doctor", handleChat);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
