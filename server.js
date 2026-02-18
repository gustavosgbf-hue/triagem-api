import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

// ===== MIDDLEWARE =====
app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

// ===== VALIDAÇÃO DA CHAVE =====
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY não definida.");
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ===== HEALTH CHECK =====
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// ===== FUNÇÃO GENÉRICA DE CHAT =====
async function runChat(system, messages) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: system },
      ...messages,
    ],
    temperature: 0.4,
  });

  return response.choices[0]?.message?.content || "";
}

// ===== TRIAGE =====
app.post("/api/triage", async (req, res) => {
  try {
    const { system, messages } = req.body;

    if (!system || !messages) {
      return res.status(400).json({ error: "Payload inválido" });
    }

    const reply = await runChat(system, messages);

    res.json({ text: reply });

  } catch (error) {
    console.error("Erro /api/triage:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Erro interno",
    });
  }
});

// ===== DOCTOR =====
app.post("/api/doctor", async (req, res) => {
  try {
    const { system, messages } = req.body;

    if (!system || !messages) {
      return res.status(400).json({ error: "Payload inválido" });
    }

    const reply = await runChat(system, messages);

    res.json({ text: reply });

  } catch (error) {
    console.error("Erro /api/doctor:", error);
    res.status(500).json({
      ok: false,
      error: error.message || "Erro interno",
    });
  }
});

// ===== START SERVER =====
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 Server rodando na porta ${PORT}`);
});
