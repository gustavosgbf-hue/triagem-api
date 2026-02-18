import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
  console.error("GEMINI_API_KEY não definida");
  process.exit(1);
}

app.get("/health", (req, res) => res.json({ ok: true }));

function toGeminiContents(messages) {
  // Gemini alterna "user" e "model". Vamos mapear:
  // user -> user
  // assistant -> model
  return (messages || []).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content ?? "") }]
  }));
}

async function callGemini({ system, messages }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

  const body = {
    system_instruction: { parts: [{ text: String(system ?? "") }] },
    contents: toGeminiContents(messages)
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    // deixa o erro legível pro seu front
    const msg =
      data?.error?.message ||
      data?.message ||
      JSON.stringify(data);
    return { ok: false, error: msg };
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.map(p => p?.text).filter(Boolean).join("") ||
    "";

  return { ok: true, text };
}

async function handleChat(req, res) {
  try {
    const { system, messages } = req.body || {};

    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: "Payload inválido" });
    }

    // segurança: remove qualquer role system que venha do front
    const filtered = messages.filter((m) => m?.role !== "system");

    const out = await callGemini({ system, messages: filtered });
    if (!out.ok) return res.status(500).json({ ok: false, error: out.error });

    // mantém compatível com teu front (ele lê data.text)
    return res.json({ text: out.text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || "Erro interno" });
  }
}

app.post("/api/triage", handleChat);
app.post("/api/doctor", handleChat);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
