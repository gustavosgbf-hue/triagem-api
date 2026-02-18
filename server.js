import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY não definida");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/health", (req, res) => res.json({ ok: true }));

async function runChat(system, messages) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: system }, ...messages],
    temperature: 0.4
  });
  return completion.choices[0]?.message?.content || "";
}

app.post("/api/triage", async (req, res) => {
  try {
    const { system, messages } = req.body;
    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: "Payload inválido" });
    }
    const reply = await runChat(system, messages);
    res.json({ text: reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Erro interno" });
  }
});

app.post("/api/doctor", async (req, res) => {
  try {
    const { system, messages } = req.body;
    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({ ok: false, error: "Payload inválido" });
    }
    const reply = await runChat(system, messages);
    res.json({ text: reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Erro interno" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
import admin from "firebase-admin";

// (se você ainda não colocou no server.js)
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || "{}");
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

app.post("/api/consultas", async (req, res) => {
  try {
    const { patientName, summary, triageMessages, doctorMessages, status } = req.body;

    if (!summary) return res.status(400).json({ ok: false, error: "summary obrigatório" });

    const doc = await db.collection("consultas").add({
      patientName: patientName || "Sem nome",
      summary,
      triageMessages: triageMessages || [],
      doctorMessages: doctorMessages || [],
      status: status || "triagem_concluida",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ ok: true, id: doc.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});
