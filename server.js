import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY não definida");
  process.exit(1);
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

async function chamarClaude(system, messages) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 800,
      system: system,
      messages: messages
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data.content?.[0]?.text || "";
}

app.post("/api/triage", async (req, res) => {
  try {
    const { system, messages } = req.body;

    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Payload inválido" });
    }

    const reply = await chamarClaude(system, messages);

    res.json({ text: reply });

  } catch (error) {
    console.error("Erro triage:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/doctor", async (req, res) => {
  try {
    const { system, messages } = req.body;

    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Payload inválido" });
    }

    const reply = await chamarClaude(system, messages);

    res.json({ text: reply });

  } catch (error) {
    console.error("Erro doctor:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
