app.post("/api/notify", async (req, res) => {
  try {
    const { nome, tel, triagem } = req.body || {};
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return res.status(500).json({ ok: false, error: "RESEND_API_KEY ausente" });

    const telLimpo = String(tel || "").replace(/\D/g, "");
    const BASE_URL = process.env.RENDER_EXTERNAL_URL || "https://triagem-api.onrender.com";

    // Hoje: só você recebe
    const toEmail = "gustavosgbf@gmail.com";

    // Hoje: como você é o único médico, o nome pode ser fixo (ou vir de ENV se quiser)
    const medicoNome = process.env.MEDICO_NOME || "Dr. Gustavo";

    // ✅ agora existe e funciona (link rastreado)
    const waLink = `${BASE_URL}/atender?medico=${encodeURIComponent(medicoNome)}&paciente=${encodeURIComponent(nome || "—")}&tel=${encodeURIComponent(telLimpo)}`;

    const triagemHtml = String(triagem || "—")
      .split(/,\s*(?=[A-ZÀÁÂÃÉÊÍÓÔÕÚÇ])/)
      .map(item => {
        const [key, ...val] = item.split(":");
        return val.length
          ? `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06)">
               <span style="color:rgba(255,255,255,.4);font-size:12px;min-width:180px;flex-shrink:0">${key.trim()}</span>
               <span style="color:#fff;font-weight:500">${val.join(":").trim()}</span>
             </div>`
          : `<div style="padding:6px 0;border-bottom:1px solid rgba(255,255,255,.06);color:#fff">${item.trim()}</div>`;
      })
      .join("");

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
              <td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td>
              <td style="padding:8px 0">
                <a href="${waLink}" style="background:#25D366;color:#fff;padding:8px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:700;display:inline-block">
                  📱 Chamar no WhatsApp
                </a>
              </td>
            </tr>
          </table>

          <div style="background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:18px">
            <p style="margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:rgba(255,255,255,.4)">Triagem completa</p>
            ${triagemHtml}
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
        to: [toEmail],
        subject: `🏥 Nova triagem — ${nome || "Paciente"}`,
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
