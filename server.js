app.post("/api/triage", async (req, res) => {
  const { system, messages } = req.body || {};
  const filtered = (messages || []).filter(m => m.role !== 'system');
  const out = await callAnthropic({
    model: "claude-sonnet-4-20250514",
    system,
    messages: filtered
  });
  if (!out.ok) return res.status(500).json(out);
  res.json(out);
});

app.post("/api/doctor", async (req, res) => {
  const { system, messages } = req.body || {};
  const filtered = (messages || []).filter(m => m.role !== 'system');
  const out = await callAnthropic({
    model: "claude-sonnet-4-20250514",
    system,
    messages: filtered
  });
  if (!out.ok) return res.status(500).json(out);
  res.json(out);
});
