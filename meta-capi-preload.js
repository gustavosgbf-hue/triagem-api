import express from "express";

const META_GRAPH_API_VERSION = process.env.META_GRAPH_API_VERSION || "v23.0";

function texto(value, max = 700) {
  return String(value || "").trim().slice(0, max);
}

function origemPermitida(req) {
  const origin = texto(req.get("origin"), 300).toLowerCase();
  if (!origin) return true;
  return origin === "https://consultaja24h.com.br" || origin === "https://www.consultaja24h.com.br";
}

function adicionarRotaMetaCapi(app) {
  if (app.__metaCapiRouteInstalled) return;
  app.__metaCapiRouteInstalled = true;

  app.post("/api/tracking/meta-capi-purchase", async (req, res) => {
    if (!origemPermitida(req)) {
      return res.status(403).json({ ok: false, error: "Origem não permitida." });
    }

    const token = texto(process.env.META_CAPI_TOKEN, 2000);
    const pixelId = texto(process.env.META_PIXEL_ID, 80);
    if (!token || !pixelId) {
      return res.status(503).json({ ok: false, error: "Meta CAPI não configurada." });
    }

    const body = req.body || {};
    const atendimentoId = texto(body.atendimentoId || body.consultaId, 80);
    const eventId = texto(body.eventId, 180);
    const value = Number(body.value);
    const currency = texto(body.currency || "BRL", 8).toUpperCase();

    if (!/^\d+$/.test(atendimentoId) || eventId !== `purchase_${atendimentoId}`) {
      return res.status(400).json({ ok: false, error: "Identificação de evento inválida." });
    }
    if (!Number.isFinite(value) || value <= 0 || value > 500 || currency !== "BRL") {
      return res.status(400).json({ ok: false, error: "Valor de compra inválido." });
    }

    const userData = {
      client_ip_address: texto(req.ip, 120),
      client_user_agent: texto(body.userAgent || req.get("user-agent"), 500),
    };
    const fbc = texto(body.fbc, 300);
    const fbp = texto(body.fbp, 300);
    if (fbc) userData.fbc = fbc;
    if (fbp) userData.fbp = fbp;

    const sourceUrl = texto(body.eventSourceUrl, 900) || "https://consultaja24h.com.br/confirmado";
    const eventTime = Math.floor(Date.now() / 1000);
    const payload = {
      data: [{
        event_name: "Purchase",
        event_time: eventTime,
        event_id: eventId,
        action_source: "website",
        event_source_url: sourceUrl,
        user_data: userData,
        custom_data: {
          currency: "BRL",
          value: Number(value.toFixed(2)),
        },
      }],
    };

    const testEventCode = texto(process.env.META_TEST_EVENT_CODE, 120);
    if (testEventCode) payload.test_event_code = testEventCode;

    try {
      const url = `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;
      const metaRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await metaRes.json().catch(() => ({}));

      if (!metaRes.ok) {
        console.warn("[META-CAPI] Purchase rejeitado", {
          atendimentoId,
          status: metaRes.status,
          error: texto(data?.error?.message || JSON.stringify(data), 500),
        });
        return res.status(502).json({ ok: false, error: "Meta recusou o evento." });
      }

      console.log("[META-CAPI] Purchase enviado", {
        atendimentoId,
        eventId,
        eventsReceived: data?.events_received ?? null,
        hasFbc: !!fbc,
        hasFbp: !!fbp,
      });
      return res.json({ ok: true, events_received: data?.events_received ?? null });
    } catch (err) {
      console.warn("[META-CAPI] Falha ao enviar Purchase", {
        atendimentoId,
        error: texto(err?.message, 500),
      });
      return res.status(502).json({ ok: false, error: "Falha ao enviar evento." });
    }
  });
}

const originalListen = express.application.listen;
if (!express.application.__metaCapiListenPatched) {
  express.application.__metaCapiListenPatched = true;
  express.application.listen = function patchedListen(...args) {
    adicionarRotaMetaCapi(this);
    return originalListen.apply(this, args);
  };
}
