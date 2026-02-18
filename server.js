import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;

// Função que chama a Anthropic
async function callAnthropic({ system, messages, model, max_tokens = 1000 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens,
      system,
      messages
    })
  });

  const data = await res.json();

  if (!res.ok) {
    return { ok: false, error: data };
  }

  return {
    ok: true,
    text: data.content?.[0]?.text || ""
  };
}

// Endpoint da triagem
app.post("/api/triage", async (req, res) => {
  const { system, messages } = req.body || {};

  const out = await callAnthropic({
    model: "claude-sonnet-4-20250514",
    system,
    messages
  });

  if (!out.ok) {
    return res.status(500).json(out);
  }

  res.json(out);
});

// Endpoint do médico
app.post("/api/doctor", async (req, res) => {
  const { system, messages } = req.body || {};

  const out = await callAnthropic({
    model: "claude-sonnet-4-20250514",
    system,
    messages
  });

  if (!out.ok) {
    return res.status(500).json(out);
  }

  res.json(out);
});

// Teste simples
app.get("/", (req, res) => {
  res.send("API rodando");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando");
});
