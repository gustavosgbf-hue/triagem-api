from pathlib import Path

p = Path('server.js')
s = p.read_text()

pool_anchor = '''const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});
'''
if pool_anchor not in s:
    raise SystemExit('pool anchor not found')
pool_replacement = pool_anchor + r'''
// Attribution schema is intentionally additive/backward-compatible.
// It gives us immutable first-touch, mutable last-touch and conversion-touch
// without changing the legacy ads_* fields consumed by existing reports.
const adsAttributionSchemaReady = pool.query(`
  ALTER TABLE fila_atendimentos
    ADD COLUMN IF NOT EXISTS ads_fbclid TEXT,
    ADD COLUMN IF NOT EXISTS ads_first_touch JSONB,
    ADD COLUMN IF NOT EXISTS ads_last_touch JSONB,
    ADD COLUMN IF NOT EXISTS ads_conversion_touch JSONB;

  CREATE TABLE IF NOT EXISTS marketing_touchpoints (
    id BIGSERIAL PRIMARY KEY,
    atendimento_id BIGINT NOT NULL,
    event_key TEXT NOT NULL UNIQUE,
    stage TEXT NOT NULL DEFAULT 'touch',
    gclid TEXT,
    gbraid TEXT,
    wbraid TEXT,
    fbclid TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_term TEXT,
    utm_content TEXT,
    landing_url TEXT,
    referrer TEXT,
    checkout_session_id TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_marketing_touchpoints_atendimento
    ON marketing_touchpoints (atendimento_id, captured_at);
`).catch(e => {
  console.warn('[ADS-ATTR-SCHEMA] Falha ao garantir schema:', e.message);
});
'''
s = s.replace(pool_anchor, pool_replacement, 1)

route_start = s.index('app.post("/api/tracking/confirmado-view", rlGeral, (req, res) => {')
route_end = s.index('function limitarTexto(valor, max = 500) {', route_start)
new_route = r'''app.post("/api/tracking/confirmado-view", rlGeral, (req, res) => {
  const body = req.body || {};
  const gclid = String(body.gclid || "");
  const gbraid = String(body.gbraid || "");
  const wbraid = String(body.wbraid || "");
  const fbclid = String(body.fbclid || "");
  const consultaId = parseInt(body.consultaId, 10) || null;
  if (consultaId) {
    const ads = normalizarAdsAttribution({
      gclid,
      gbraid,
      wbraid,
      fbclid,
      utm_source: body.utm_source,
      utm_medium: body.utm_medium,
      utm_campaign: body.utm_campaign,
      utm_term: body.utm_term,
      utm_content: body.utm_content,
      // Never use /confirmado as the original landing. Prefer the immutable touch captured at entry.
      landing_url: body.firstLandingUrl,
      referrer: body.firstReferrer,
      first_touch_at: body.firstTouchAt,
      first_landing_url: body.firstLandingUrl,
      first_referrer: body.firstReferrer,
      last_touch_at: body.lastTouchAt,
      last_landing_url: body.lastLandingUrl,
      last_referrer: body.lastReferrer,
      checkout_session_id: body.checkoutSessionId,
      attribution_stage: "conversion"
    }, req);
    salvarAdsAttribution(consultaId, ads, req).catch(() => {});
    pool.query(
      `UPDATE fila_atendimentos
          SET confirmado_pageview_em = COALESCE(confirmado_pageview_em, NOW()),
              confirmado_has_ads_id = COALESCE(confirmado_has_ads_id, false) OR $2,
              confirmado_href = COALESCE(NULLIF($3,''), confirmado_href)
        WHERE id = $1`,
      [consultaId, !!(gclid || gbraid || wbraid), limitarTexto(body.href, 700)]
    ).catch(e => console.warn("[CONFIRMADO-PAGEVIEW] Falha ao salvar:", e.message));
  }
  console.log("CONFIRMADO_PAGEVIEW", {
    consultaId: String(body.consultaId || ""),
    tipo: String(body.tipo || ""),
    paymentMethod: String(body.paymentMethod || ""),
    hasGclid: !!gclid,
    hasGbraid: !!gbraid,
    hasWbraid: !!wbraid,
    hasFbclid: !!fbclid,
    gclidTail: gclid ? gclid.slice(-10) : "",
    gbraidTail: gbraid ? gbraid.slice(-10) : "",
    wbraidTail: wbraid ? wbraid.slice(-10) : "",
    href: String(body.href || "").slice(0, 300),
    referrer: String(body.referrer || "").slice(0, 300),
    ip: req.ip,
    ua: String(req.get("user-agent") || "").slice(0, 160)
  });
  res.json({ ok: true });
});

'''
s = s[:route_start] + new_route + s[route_end:]

norm_start = s.index('function normalizarAdsAttribution(input = {}, req) {')
norm_end = s.index('function envBool(name, fallback = false) {', norm_start)
new_norm = r'''function normalizarAdsAttribution(input = {}, req) {
  const src = input && typeof input === "object" ? input : {};
  const gclid = limitarTexto(src.gclid, 220);
  const gbraid = limitarTexto(src.gbraid, 220);
  const wbraid = limitarTexto(src.wbraid, 220);
  const fbclid = limitarTexto(src.fbclid, 300);
  const utm = {};
  ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach(k => {
    const v = limitarTexto(src[k], 220);
    if (v) utm[k] = v;
  });
  const landingUrl = limitarTexto(src.landing_url || src.landingUrl, 700);
  const referrer = limitarTexto(src.referrer, 700);
  const checkoutSessionId = limitarTexto(src.checkout_session_id || src.checkoutSessionId, 120);
  const userAgent = limitarTexto(src.user_agent || src.userAgent || req?.get?.("user-agent"), 300);
  const stage = limitarTexto(src.attribution_stage || src.stage || "touch", 40) || "touch";

  const firstTouch = {
    captured_at: limitarTexto(src.first_touch_at || src.firstTouchAt, 60),
    landing_url: limitarTexto(src.first_landing_url || src.firstLandingUrl || landingUrl, 700),
    referrer: limitarTexto(src.first_referrer || src.firstReferrer || referrer, 700)
  };
  const lastTouch = {
    captured_at: limitarTexto(src.last_touch_at || src.lastTouchAt, 60),
    landing_url: limitarTexto(src.last_landing_url || src.lastLandingUrl || landingUrl, 700),
    referrer: limitarTexto(src.last_referrer || src.lastReferrer || referrer, 700),
    gclid,
    gbraid,
    wbraid,
    fbclid,
    ...utm
  };
  Object.keys(firstTouch).forEach(k => { if (!firstTouch[k]) delete firstTouch[k]; });
  Object.keys(lastTouch).forEach(k => { if (!lastTouch[k]) delete lastTouch[k]; });

  const hasAny = !!(
    gclid || gbraid || wbraid || fbclid || Object.keys(utm).length || landingUrl || referrer ||
    checkoutSessionId || Object.keys(firstTouch).length || Object.keys(lastTouch).length
  );
  return {
    gclid, gbraid, wbraid, fbclid, utm, landingUrl, referrer,
    checkoutSessionId, userAgent, firstTouch, lastTouch, stage, hasAny
  };
}

async function salvarAdsAttribution(atendimentoId, attribution, req) {
  const id = parseInt(atendimentoId, 10);
  if (!id) return;
  const ads = attribution?.hasAny ? attribution : normalizarAdsAttribution(attribution || {}, req);
  if (!ads.hasAny) return;
  await adsAttributionSchemaReady;

  const firstJson = JSON.stringify(ads.firstTouch || {});
  const lastJson = JSON.stringify(ads.lastTouch || {});
  const conversionJson = ads.stage === "conversion" ? lastJson : "{}";
  await pool.query(
    `UPDATE fila_atendimentos
        SET ads_gclid = COALESCE(NULLIF($2,''), ads_gclid),
            ads_gbraid = COALESCE(NULLIF($3,''), ads_gbraid),
            ads_wbraid = COALESCE(NULLIF($4,''), ads_wbraid),
            ads_fbclid = COALESCE(NULLIF($5,''), ads_fbclid),
            ads_utm = CASE WHEN $6::jsonb <> '{}'::jsonb THEN COALESCE(ads_utm, '{}'::jsonb) || $6::jsonb ELSE ads_utm END,
            ads_landing_url = COALESCE(ads_landing_url, NULLIF($7,'')),
            ads_referrer = COALESCE(ads_referrer, NULLIF($8,'')),
            ads_checkout_session_id = COALESCE(NULLIF($9,''), ads_checkout_session_id),
            ads_user_agent = COALESCE(NULLIF($10,''), ads_user_agent),
            ads_first_touch = CASE WHEN $11::jsonb <> '{}'::jsonb THEN COALESCE(ads_first_touch, $11::jsonb) ELSE ads_first_touch END,
            ads_last_touch = CASE WHEN $12::jsonb <> '{}'::jsonb THEN $12::jsonb ELSE ads_last_touch END,
            ads_conversion_touch = CASE WHEN $13::jsonb <> '{}'::jsonb THEN $13::jsonb ELSE ads_conversion_touch END,
            ads_capturado_em = COALESCE(ads_capturado_em, NOW())
      WHERE id = $1`,
    [
      id,
      ads.gclid,
      ads.gbraid,
      ads.wbraid,
      ads.fbclid,
      JSON.stringify(ads.utm || {}),
      ads.landingUrl,
      ads.referrer,
      ads.checkoutSessionId,
      ads.userAgent,
      firstJson,
      lastJson,
      conversionJson
    ]
  ).catch(e => console.warn("[ADS-ATTR] Falha ao salvar attribution:", e.message));

  // Append-only audit trail. Repeated identical writes deduplicate by event_key.
  const fingerprint = sha256Hex(JSON.stringify({
    id,
    stage: ads.stage,
    gclid: ads.gclid,
    gbraid: ads.gbraid,
    wbraid: ads.wbraid,
    fbclid: ads.fbclid,
    utm: ads.utm,
    landingUrl: ads.landingUrl,
    referrer: ads.referrer,
    checkoutSessionId: ads.checkoutSessionId,
    lastTouch: ads.lastTouch
  }));
  await pool.query(
    `INSERT INTO marketing_touchpoints (
       atendimento_id, event_key, stage, gclid, gbraid, wbraid, fbclid,
       utm_source, utm_medium, utm_campaign, utm_term, utm_content,
       landing_url, referrer, checkout_session_id, captured_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
       COALESCE(NULLIF($16,'')::timestamptz, NOW())
     ) ON CONFLICT (event_key) DO NOTHING`,
    [
      id, fingerprint, ads.stage, ads.gclid, ads.gbraid, ads.wbraid, ads.fbclid,
      ads.utm?.utm_source || "", ads.utm?.utm_medium || "", ads.utm?.utm_campaign || "",
      ads.utm?.utm_term || "", ads.utm?.utm_content || "", ads.landingUrl, ads.referrer,
      ads.checkoutSessionId, ads.lastTouch?.captured_at || ads.firstTouch?.captured_at || ""
    ]
  ).catch(e => console.warn("[ADS-TOUCHPOINT] Falha ao registrar touchpoint:", e.message));
}

'''
s = s[:norm_start] + new_norm + s[norm_end:]

# Add a modern Data Manager API sender as the preferred server-side backup when configured.
insert_anchor = 'async function enviarConversaoOfflineGoogleAds(at, metodo, origem, externalId, opts = {}) {'
idx = s.index(insert_anchor)
data_manager = r'''let googleDataManagerTokenCache = { token: "", expiresAt: 0 };

function googleDataManagerConfig() {
  const customerId = normalizarGoogleAdsCustomerId(process.env.GOOGLE_DATA_MANAGER_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID);
  const conversionActionId = limitarTexto(process.env.GOOGLE_DATA_MANAGER_CONVERSION_ACTION_ID || process.env.GOOGLE_ADS_CONVERSION_ACTION_ID, 80);
  const clientId = process.env.GOOGLE_DATA_MANAGER_CLIENT_ID || process.env.GOOGLE_ADS_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_DATA_MANAGER_CLIENT_SECRET || process.env.GOOGLE_ADS_CLIENT_SECRET || "";
  const refreshToken = process.env.GOOGLE_DATA_MANAGER_REFRESH_TOKEN || "";
  const enabled = envBool("GOOGLE_DATA_MANAGER_ENABLED", false);
  const missing = [];
  if (!customerId) missing.push("GOOGLE_DATA_MANAGER_CUSTOMER_ID");
  if (!conversionActionId) missing.push("GOOGLE_DATA_MANAGER_CONVERSION_ACTION_ID");
  if (!clientId) missing.push("GOOGLE_DATA_MANAGER_CLIENT_ID");
  if (!clientSecret) missing.push("GOOGLE_DATA_MANAGER_CLIENT_SECRET");
  if (!refreshToken) missing.push("GOOGLE_DATA_MANAGER_REFRESH_TOKEN");
  return {
    enabled,
    configured: enabled && missing.length === 0,
    missing,
    customerId,
    conversionActionId,
    clientId,
    clientSecret,
    refreshToken,
    validateOnly: envBool("GOOGLE_DATA_MANAGER_VALIDATE_ONLY", true)
  };
}

async function obterGoogleDataManagerAccessToken(cfg) {
  const now = Date.now();
  if (googleDataManagerTokenCache.token && googleDataManagerTokenCache.expiresAt > now + 60000) {
    return googleDataManagerTokenCache.token;
  }
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: cfg.refreshToken,
    grant_type: "refresh_token"
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error("oauth_data_manager_" + (data.error_description || data.error || res.status));
  googleDataManagerTokenCache = {
    token: data.access_token,
    expiresAt: now + Math.max(60, Number(data.expires_in || 3600) - 30) * 1000
  };
  return data.access_token;
}

async function enviarConversaoDataManagerGoogleAds(at, valor, currency, opts = {}) {
  const cfg = googleDataManagerConfig();
  if (!cfg.enabled) return { ok: false, skipped: "disabled" };
  if (!cfg.configured) return { ok: false, skipped: "unconfigured", missing: cfg.missing };

  const adIdentifiers = {};
  if (at.ads_gclid) adIdentifiers.gclid = String(at.ads_gclid);
  else if (at.ads_wbraid) adIdentifiers.wbraid = String(at.ads_wbraid);
  else if (at.ads_gbraid) adIdentifiers.gbraid = String(at.ads_gbraid);
  if (!Object.keys(adIdentifiers).length) return { ok: false, skipped: "no_click_id" };

  const token = await obterGoogleDataManagerAccessToken(cfg);
  const event = {
    adIdentifiers,
    conversionValue: Number(valor) || 49.90,
    currency: limitarTexto(currency || "BRL", 3).toUpperCase(),
    eventTimestamp: new Date(at.pagamento_confirmado_em || Date.now()).toISOString(),
    transactionId: `CJ24H-${at.id}`,
    eventSource: "WEB"
  };
  const body = {
    destinations: [{
      operatingAccount: { product: "GOOGLE_ADS", accountId: cfg.customerId },
      productDestinationId: cfg.conversionActionId
    }],
    events: [event],
    validateOnly: opts.validateOnly ?? cfg.validateOnly
  };
  const res = await fetch("https://datamanager.googleapis.com/v1/events:ingest", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
  if (!res.ok) return { ok: false, error: data.error?.message || text || `HTTP ${res.status}`, response: data };
  return { ok: true, requestId: data.requestId || "", validated: !!body.validateOnly, response: data };
}

'''
s = s[:idx] + data_manager + s[idx:]

# Prefer Data Manager as a duplicate-safe server-side backup when explicitly enabled.
needle = '''  const click = selecionarGoogleAdsClickIds(at);
  const userIdentifiers = cfg.sendUserData ? montarGoogleAdsUserIdentifiers(at) : [];
'''
pos = s.index(needle, s.index(insert_anchor))
replacement = '''  const click = selecionarGoogleAdsClickIds(at);
  const userIdentifiers = cfg.sendUserData ? montarGoogleAdsUserIdentifiers(at) : [];

  // Since 15 Jun 2026 Google directs new offline/enhanced-conversion uploads to Data Manager API.
  // Keep the legacy uploader as fallback for accounts that still have allowlisted access.
  const dmCfg = googleDataManagerConfig();
  if (dmCfg.enabled) {
    try {
      const dm = await enviarConversaoDataManagerGoogleAds(at, cfg.value, cfg.currency, { validateOnly: dmCfg.validateOnly });
      if (dm.ok && !dm.validated) {
        await marcarGoogleAdsOffline(at.id, "sent", { jobId: dm.requestId, orderId: `CJ24H-${at.id}`, error: "" });
        console.log("GOOGLE_DATA_MANAGER_CONVERSION_OK", { consultaId: String(at.id), requestId: dm.requestId || "" });
        return { ok: true, status: "sent", provider: "data_manager", response: dm.response };
      }
      if (dm.ok && dm.validated) {
        await marcarGoogleAdsOffline(at.id, "validated", { jobId: dm.requestId, orderId: `CJ24H-${at.id}`, error: "" });
        return { ok: true, status: "validated", provider: "data_manager", response: dm.response };
      }
      if (!dm.skipped) console.warn("GOOGLE_DATA_MANAGER_CONVERSION_FAILED", { consultaId: String(at.id), error: String(dm.error || "").slice(0, 500) });
    } catch (e) {
      console.warn("GOOGLE_DATA_MANAGER_CONVERSION_FAILED", { consultaId: String(at.id), error: String(e.message || e).slice(0, 500) });
    }
  }
'''
s = s[:pos] + s[pos:].replace(needle, replacement, 1)

p.write_text(s)

# Guardrails
out = p.read_text()
assert 'ads_fbclid' in out
assert 'ads_first_touch' in out and 'ads_conversion_touch' in out
assert 'marketing_touchpoints' in out
assert 'body.utm_source' in out and 'body.fbclid' in out
assert 'datamanager.googleapis.com/v1/events:ingest' in out
assert 'uploadClickConversions' in out  # legacy fallback retained
print('backend ads attribution patch applied')
