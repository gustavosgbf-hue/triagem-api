// Visão financeira de aquisição (somente administrador).
// Cruza gasto diário de mídia (por canal) com pagamentos, margem real por
// consulta (margem-consulta.js), pacientes novos/recorrentes e estornos.
// Atribuição: último clique registrado no pagamento (gclid/msclkid/UTM).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";
import { calcularMargemConsulta, lerTaxasMargem } from "./margem-consulta.js";

export const CANAIS_PAGOS = ["google_ads", "microsoft_ads", "meta_ads"];
export const ROTULO_CANAL = {
  google_ads: "Google Ads", microsoft_ads: "Microsoft Ads", meta_ads: "Meta Ads",
  app: "Aplicativo", referencia: "Indicação e IA", organico: "Orgânico e direto"
};
const FUSO = "America/Fortaleza";
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(v) {
  if (!v) return {};
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return {}; }
}
function minusc(v) { return String(v || "").trim().toLowerCase(); }

// Canal do pagamento pelo último toque registrado. Função pura.
export function classificarCanal(at) {
  if (at?.ads_gclid || at?.ads_gbraid || at?.ads_wbraid) return "google_ads";
  const toque = { ...json(at?.ads_first_touch), ...json(at?.ads_utm), ...json(at?.ads_last_touch) };
  const landing = String(toque.landing_url || at?.ads_landing_url || "");
  const fonte = minusc(toque.utm_source);
  const meio = minusc(toque.utm_medium);
  const pago = /^(cpc|ppc|paid|paid_social|paidsocial|ads?|cpm)$/.test(meio);
  if (/[?&]msclkid=/i.test(landing) || toque.msclkid || ((fonte === "bing" || fonte === "microsoft") && pago)) return "microsoft_ads";
  if ((["facebook", "fb", "instagram", "ig", "meta"].includes(fonte) && pago) || /[?&]fbclid=/i.test(landing) && pago) return "meta_ads";
  if (/[?&](gclid|gbraid|wbraid)=/i.test(landing) || (fonte === "google" && pago)) return "google_ads";
  const origem = minusc(at?.origem_plataforma);
  if (["ios", "android", "app_desconhecido"].includes(origem) || origem.startsWith("app")) return "app";
  if (fonte && fonte !== "(not set)" && !/consultaja24h/.test(fonte)) return "referencia";
  return "organico";
}

export function validarPeriodo(de, ate, hoje) {
  if (!DIA_RE.test(String(de || "")) || !DIA_RE.test(String(ate || ""))) return { ok: false, erro: "periodo_invalido" };
  if (de > ate) return { ok: false, erro: "periodo_invertido" };
  const dias = Math.round((Date.parse(ate + "T00:00:00Z") - Date.parse(de + "T00:00:00Z")) / 86400000) + 1;
  if (dias > 370) return { ok: false, erro: "periodo_longo" };
  if (hoje && de > hoje) return { ok: false, erro: "periodo_futuro" };
  return { ok: true, dias };
}

export function periodoAnterior(de, dias) {
  const fim = new Date(Date.parse(de + "T00:00:00Z") - 86400000);
  const ini = new Date(fim.getTime() - (dias - 1) * 86400000);
  return { de: ini.toISOString().slice(0, 10), ate: fim.toISOString().slice(0, 10) };
}

function vazio() {
  return { gasto: 0, impressoes: 0, cliques: 0, pagamentos: 0, novos: 0, recorrentes: 0, bruto: 0, estornos: 0,
    repasse: 0, taxas: 0, impostos: 0, margem: 0, margem_apurada: 0, margem_pendente: 0, novos_que_voltaram: 0,
    receita_retorno: 0 };
}
const div = (a, b) => (b > 0 ? a / b : null);

function indicadores(c) {
  // Resultado = margem apurada − mídia. Consultas sem margem apurada ficam fora e são contadas em margem_pendente.
  return {
    ...c,
    cac_novo: div(c.gasto, c.novos),
    custo_por_pagamento: div(c.gasto, c.pagamentos),
    margem_media: div(c.margem, c.margem_apurada),
    resultado: c.margem - c.gasto,
    retorno_sobre_midia: c.gasto > 0 ? (c.margem - c.gasto) / c.gasto : null,
    taxa_recorrencia: div(c.recorrentes, c.pagamentos),
    retorno_novos: div(c.novos_que_voltaram, c.novos)
  };
}

/**
 * Agrega o período. Função pura (sem banco), testável.
 * pagamentos: linhas com dia (YYYY-MM-DD), customer_type, identidade, medico_*, campos de fila_atendimentos.
 * retornos: Map identidade -> { pagamentos, bruto } de pagamentos POSTERIORES ao primeiro do período (até hoje).
 * gastos: [{ canal, dia, custo_centavos, impressoes, cliques }]
 */
export function agregarFinanceiro({ pagamentos = [], gastos = [], retornos = new Map(), adminEmail, taxas = lerTaxasMargem() }) {
  const canais = {};
  const total = vazio();
  const diario = {};
  const pendencias = {};
  const garantir = k => (canais[k] ??= vazio());
  const dia = d => (diario[d] ??= { dia: d, gasto: 0, gasto_por_canal: {}, pagamentos: 0, novos: 0, bruto: 0, margem: 0 });

  for (const g of gastos) {
    const c = garantir(g.canal);
    const custo = Math.round(Number(g.custo_centavos) || 0);
    c.gasto += custo; c.impressoes += Number(g.impressoes) || 0; c.cliques += Number(g.cliques) || 0;
    total.gasto += custo; total.impressoes += Number(g.impressoes) || 0; total.cliques += Number(g.cliques) || 0;
    const d = dia(g.dia); d.gasto += custo; d.gasto_por_canal[g.canal] = (d.gasto_por_canal[g.canal] || 0) + custo;
  }

  const novosContados = new Set();
  for (const p of pagamentos) {
    const canal = classificarCanal(p);
    const medico = p.medico_email ? { email: p.medico_email, nome: p.medico_nome_cad, nome_exibicao: p.medico_nome_exibicao } : null;
    const m = calcularMargemConsulta({ at: p, medico, adminEmail, taxas, estimarAntesDaRegra: true });
    const tipo = p.customer_type === "new" || p.cliente_novo === true ? "new" : "returning";
    const alvo = [garantir(canal), total];
    const d = dia(p.dia);
    for (const c of alvo) {
      c.pagamentos++; c.bruto += m.brutoCentavos; c.estornos += m.reembolsoCentavos;
      if (tipo === "new") c.novos++; else c.recorrentes++;
      if (m.margemCentavos === null) c.margem_pendente++;
      else {
        c.margem_apurada++; c.margem += m.margemCentavos; c.repasse += m.repasseCentavos;
        c.taxas += m.taxaGatewayCentavos || 0; c.impostos += m.impostoCentavos || 0;
      }
    }
    d.pagamentos++; d.bruto += m.brutoCentavos; if (tipo === "new") d.novos++;
    if (m.margemCentavos !== null) d.margem += m.margemCentavos;
    for (const pend of m.pendencias) {
      const chave = pend.startsWith("repasse_sem_regra") ? "repasse_sem_regra" : pend;
      pendencias[chave] = (pendencias[chave] || 0) + 1;
    }
    if (tipo === "new" && p.identidade && !novosContados.has(p.identidade)) {
      novosContados.add(p.identidade);
      const r = retornos.get(p.identidade);
      if (r && r.pagamentos > 0) {
        for (const c of alvo) { c.novos_que_voltaram++; c.receita_retorno += r.bruto; }
      }
    }
  }

  const porCanal = Object.entries(canais)
    .map(([canal, c]) => ({ canal, rotulo: ROTULO_CANAL[canal] || canal, pago: CANAIS_PAGOS.includes(canal), ...indicadores(c) }))
    .sort((a, b) => (b.gasto - a.gasto) || (b.pagamentos - a.pagamentos));
  return {
    total: indicadores(total),
    cac_novo_combinado: div(total.gasto, total.novos),
    canais: porCanal,
    diario: Object.values(diario).sort((a, b) => a.dia.localeCompare(b.dia)),
    pendencias
  };
}

// Retorno incremental: quanto de margem a mais (ou a menos) cada real a mais de mídia trouxe.
export function compararPeriodos(atual, anterior) {
  const linha = (a, b) => {
    const dGasto = (a?.gasto || 0) - (b?.gasto || 0);
    const dMargem = (a?.margem || 0) - (b?.margem || 0);
    const dPag = (a?.pagamentos || 0) - (b?.pagamentos || 0);
    const dNovos = (a?.novos || 0) - (b?.novos || 0);
    return {
      delta_gasto: dGasto, delta_margem: dMargem, delta_pagamentos: dPag, delta_novos: dNovos,
      delta_resultado: dMargem - dGasto,
      margem_por_real_adicional: dGasto !== 0 ? dMargem / dGasto : null,
      custo_por_novo_adicional: dNovos > 0 && dGasto > 0 ? dGasto / dNovos : null
    };
  };
  const ant = new Map(anterior.canais.map(c => [c.canal, c]));
  return {
    total: linha(atual.total, anterior.total),
    canais: atual.canais.filter(c => c.pago || ant.get(c.canal)?.pago).map(c => ({ canal: c.canal, ...linha(c, ant.get(c.canal)) }))
  };
}

// -------- Coletores de gasto diário --------
export function lerSeedGoogle(arquivo) {
  const p = arquivo || path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "google-ads-gasto-seed.csv");
  if (!fs.existsSync(p)) return [];
  const [cab, ...linhas] = fs.readFileSync(p, "utf8").trim().split(/\r?\n/);
  const cols = cab.split(",");
  return linhas.map(l => {
    const v = Object.fromEntries(l.split(",").map((x, i) => [cols[i], x]));
    return {
      canal: "google_ads", conta_id: "1519420678", campanha_id: v.campanha_id, campanha_nome: null, dia: v.dia,
      custo_centavos: Math.round(Number(v.custo) * 100), impressoes: Number(v.impressoes) || 0, cliques: Number(v.cliques) || 0,
      conversoes_plataforma: Number(v.conversoes) || 0, valor_conversoes_centavos: Math.round(Number(v.valor_conversoes) * 100) || 0,
      fonte: "seed_supermetrics"
    };
  });
}

export function criarColetores({ consultarGoogleAds, env = process.env, fetchFn = globalThis.fetch }) {
  return {
    google_ads: {
      configurado: () => !!(env.GOOGLE_ADS_DEVELOPER_TOKEN && env.GOOGLE_ADS_REFRESH_TOKEN && env.GOOGLE_ADS_CUSTOMER_ID),
      faltando: () => ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_ID"].filter(k => !env[k]),
      async coletar(de, ate) {
        const rows = await consultarGoogleAds(
          `SELECT segments.date, customer.id, campaign.id, campaign.name, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${de}' AND '${ate}'`);
        return rows.map(r => ({
          canal: "google_ads", conta_id: String(r?.customer?.id || env.GOOGLE_ADS_CUSTOMER_ID || ""),
          campanha_id: String(r?.campaign?.id || ""), campanha_nome: r?.campaign?.name || null, dia: r?.segments?.date,
          custo_centavos: Math.round(Number(r?.metrics?.costMicros || 0) / 10000),
          impressoes: Number(r?.metrics?.impressions || 0), cliques: Number(r?.metrics?.clicks || 0),
          conversoes_plataforma: Number(r?.metrics?.conversions || 0),
          valor_conversoes_centavos: Math.round(Number(r?.metrics?.conversionsValue || 0) * 100),
          fonte: "google_ads_api"
        })).filter(r => DIA_RE.test(r.dia || ""));
      }
    },
    meta_ads: {
      configurado: () => !!(env.META_ADS_ACCESS_TOKEN && env.META_ADS_ACCOUNT_ID),
      faltando: () => ["META_ADS_ACCESS_TOKEN", "META_ADS_ACCOUNT_ID"].filter(k => !env[k]),
      async coletar(de, ate) {
        const conta = String(env.META_ADS_ACCOUNT_ID).replace(/^act_/, "");
        const versao = env.META_ADS_API_VERSION || "v21.0";
        const params = new URLSearchParams({
          level: "campaign", time_increment: "1", limit: "500",
          fields: "campaign_id,campaign_name,spend,impressions,clicks",
          time_range: JSON.stringify({ since: de, until: ate }), access_token: env.META_ADS_ACCESS_TOKEN
        });
        let url = `https://graph.facebook.com/${versao}/act_${conta}/insights?${params}`;
        const out = [];
        for (let i = 0; url && i < 20; i++) {
          const res = await fetchFn(url);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error("meta_ads_" + (data?.error?.message || res.status));
          for (const r of data.data || []) out.push({
            canal: "meta_ads", conta_id: conta, campanha_id: String(r.campaign_id || ""), campanha_nome: r.campaign_name || null,
            dia: r.date_start, custo_centavos: Math.round(Number(r.spend || 0) * 100),
            impressoes: Number(r.impressions || 0), cliques: Number(r.clicks || 0), conversoes_plataforma: 0,
            valor_conversoes_centavos: 0, fonte: "meta_graph_api"
          });
          url = data?.paging?.next || "";
        }
        return out;
      }
    },
    // Microsoft Advertising: a API de relatórios exige app registrado e token OAuth próprio.
    // Até lá, o gasto entra pela importação administrativa (POST /api/admin/financeiro/gasto/importar).
    microsoft_ads: {
      configurado: () => false,
      faltando: () => ["MICROSOFT_ADS_DEVELOPER_TOKEN", "MICROSOFT_ADS_REFRESH_TOKEN", "MICROSOFT_ADS_ACCOUNT_ID"],
      async coletar() { return []; }
    }
  };
}

export function tokenIngestValido(recebido, esperado) {
  const a = Buffer.from(String(recebido || "")), b = Buffer.from(String(esperado || ""));
  return b.length >= 24 && a.length === b.length && timingSafeEqual(a, b);
}

export function normalizarLinhaImportada(l, fonte = "importacao_manual") {
  const canal = String(l?.canal || "");
  if (!CANAIS_PAGOS.includes(canal)) return null;
  if (!DIA_RE.test(String(l?.dia || ""))) return null;
  const custo = Math.round(Number(l?.custo_centavos ?? Number(l?.custo) * 100));
  if (!Number.isFinite(custo) || custo < 0) return null;
  return {
    canal, conta_id: String(l.conta_id || "manual").slice(0, 40), campanha_id: String(l.campanha_id || "total").slice(0, 40),
    campanha_nome: l.campanha_nome ? String(l.campanha_nome).slice(0, 200) : null, dia: l.dia, custo_centavos: custo,
    impressoes: Math.max(0, Math.round(Number(l.impressoes) || 0)), cliques: Math.max(0, Math.round(Number(l.cliques) || 0)),
    conversoes_plataforma: Number(l.conversoes_plataforma ?? l.conversoes) || 0,
    valor_conversoes_centavos: Math.max(0, Math.round(Number(l.valor_conversoes ?? 0) * 100) || 0), fonte
  };
}

// -------- Banco e rotas --------
const SQL_TABELA = `CREATE TABLE IF NOT EXISTS marketing_gasto_diario (
  canal TEXT NOT NULL, conta_id TEXT NOT NULL, campanha_id TEXT NOT NULL, dia DATE NOT NULL,
  campanha_nome TEXT, custo_centavos BIGINT NOT NULL DEFAULT 0, impressoes BIGINT NOT NULL DEFAULT 0,
  cliques BIGINT NOT NULL DEFAULT 0, conversoes_plataforma NUMERIC NOT NULL DEFAULT 0,
  valor_conversoes_centavos BIGINT NOT NULL DEFAULT 0, fonte TEXT NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (canal, conta_id, campanha_id, dia))`;

async function gravarGastos(pool, linhas, { sobrescreverApi = true } = {}) {
  let n = 0;
  for (const l of linhas) {
    // Dado de API/script da plataforma prevalece; seed e importação manual não o sobrescrevem.
    await pool.query(
      `INSERT INTO marketing_gasto_diario (canal,conta_id,campanha_id,dia,campanha_nome,custo_centavos,impressoes,cliques,conversoes_plataforma,valor_conversoes_centavos,fonte,atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (canal,conta_id,campanha_id,dia) DO UPDATE SET campanha_nome=COALESCE(EXCLUDED.campanha_nome,marketing_gasto_diario.campanha_nome),
         custo_centavos=EXCLUDED.custo_centavos, impressoes=EXCLUDED.impressoes, cliques=EXCLUDED.cliques,
         conversoes_plataforma=EXCLUDED.conversoes_plataforma, valor_conversoes_centavos=EXCLUDED.valor_conversoes_centavos,
         fonte=EXCLUDED.fonte, atualizado_em=NOW()
       WHERE ($12::boolean AND (EXCLUDED.fonte LIKE '%\\_api' OR EXCLUDED.fonte LIKE '%\\_script'))
          OR NOT (marketing_gasto_diario.fonte LIKE '%\\_api' OR marketing_gasto_diario.fonte LIKE '%\\_script')`,
      [l.canal, l.conta_id, l.campanha_id, l.dia, l.campanha_nome, l.custo_centavos, l.impressoes, l.cliques,
       l.conversoes_plataforma, l.valor_conversoes_centavos, l.fonte, sobrescreverApi]);
    n++;
  }
  return n;
}

const SQL_PAGAMENTOS = `
  SELECT f.id, f.pagamento_confirmado_em, to_char((f.pagamento_confirmado_em::timestamptz AT TIME ZONE '${FUSO}'),'YYYY-MM-DD') AS dia,
         f.tipo, f.status, f.pagamento_status, f.status_atendimento, f.categoria_atendimento, f.especialidade_solicitada,
         f.valor_cobrado_centavos, f.reembolso_valor_centavos, f.reembolso_status, f.encerrado_em, f.pagamento_metodo,
         f.pagbank_order_id, f.stripe_payment_intent_id, f.stripe_checkout_session_id, f.efi_charge_id,
         f.customer_type, f.cliente_novo, f.origem_plataforma, f.ads_gclid, f.ads_gbraid, f.ads_wbraid,
         f.ads_utm, f.ads_first_touch, f.ads_last_touch, f.ads_landing_url,
         m.email AS medico_email, m.nome AS medico_nome_cad, m.nome_exibicao AS medico_nome_exibicao,
         COALESCE(NULLIF(regexp_replace(COALESCE(f.cpf,''),'\\D','','g'),''), NULLIF(LOWER(TRIM(f.email)),''),
                  NULLIF(regexp_replace(COALESCE(f.tel,''),'\\D','','g'),'')) AS identidade
    FROM fila_atendimentos f LEFT JOIN medicos m ON m.id = f.medico_id
   WHERE f.pagamento_status = 'confirmado' AND f.pagamento_confirmado_em IS NOT NULL
     AND (f.pagamento_confirmado_em::timestamptz AT TIME ZONE '${FUSO}')::date BETWEEN $1::date AND $2::date`;

// Pagamentos posteriores (até hoje) dos pacientes novos do período, para recorrência.
const SQL_RETORNOS = `
  WITH ids AS (SELECT * FROM unnest($1::text[], $2::timestamptz[]) AS t(identidade, primeiro))
  SELECT x.identidade, COUNT(*)::int AS pagamentos, SUM(x.valor_cobrado_centavos - COALESCE(x.reembolso_valor_centavos,0))::bigint AS bruto
    FROM (
      SELECT COALESCE(NULLIF(regexp_replace(COALESCE(f.cpf,''),'\\D','','g'),''), NULLIF(LOWER(TRIM(f.email)),''),
                      NULLIF(regexp_replace(COALESCE(f.tel,''),'\\D','','g'),'')) AS identidade,
             f.valor_cobrado_centavos, f.reembolso_valor_centavos, f.pagamento_confirmado_em
        FROM fila_atendimentos f
       WHERE f.pagamento_status='confirmado'
    ) x JOIN ids USING (identidade)
   WHERE x.pagamento_confirmado_em::timestamptz > ids.primeiro + INTERVAL '1 second'
   GROUP BY 1`;

export function registrarRotasFinanceiro(app, { pool, checkAdmin, adminEmail, consultarGoogleAds, log = console }) {
  const coletores = criarColetores({ consultarGoogleAds });
  let pronto = false;
  async function garantir() {
    if (pronto) return;
    await pool.query(SQL_TABELA);
    const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM marketing_gasto_diario WHERE canal='google_ads'`);
    if (!rows[0].n) await gravarGastos(pool, lerSeedGoogle(), { sobrescreverApi: false });
    pronto = true;
  }
  const estado = {};
  async function sincronizar(dias = 7) {
    await garantir();
    const ate = new Date().toLocaleDateString("en-CA", { timeZone: FUSO });
    const de = new Date(Date.now() - (dias - 1) * 86400000).toLocaleDateString("en-CA", { timeZone: FUSO });
    for (const [canal, c] of Object.entries(coletores)) {
      if (!c.configurado()) { estado[canal] = { ok: false, configurado: false, faltando: c.faltando() }; continue; }
      try {
        const linhas = await c.coletar(de, ate);
        await gravarGastos(pool, linhas);
        estado[canal] = { ok: true, configurado: true, linhas: linhas.length, em: new Date().toISOString(), de, ate };
      } catch (e) {
        estado[canal] = { ok: false, configurado: true, erro: String(e.message || e).slice(0, 300), em: new Date().toISOString() };
        log.warn?.("[FINANCEIRO] coleta falhou", canal, estado[canal].erro);
      }
    }
    return estado;
  }
  setTimeout(() => sincronizar(35).catch(() => {}), 180_000).unref?.();
  setInterval(() => sincronizar(7).catch(() => {}), 3 * 60 * 60_000).unref?.();

  async function apurar(de, ate) {
    const [pag, gas] = await Promise.all([
      pool.query(SQL_PAGAMENTOS, [de, ate]),
      pool.query(`SELECT canal, to_char(dia,'YYYY-MM-DD') dia, SUM(custo_centavos)::bigint custo_centavos,
                         SUM(impressoes)::bigint impressoes, SUM(cliques)::bigint cliques
                    FROM marketing_gasto_diario WHERE dia BETWEEN $1::date AND $2::date GROUP BY 1,2`, [de, ate])
    ]);
    const primeiro = new Map();
    for (const p of pag.rows) {
      if (!(p.customer_type === "new" || p.cliente_novo === true) || !p.identidade) continue;
      const t = new Date(p.pagamento_confirmado_em);
      if (!primeiro.has(p.identidade) || t < primeiro.get(p.identidade)) primeiro.set(p.identidade, t);
    }
    const retornos = new Map();
    if (primeiro.size) {
      const ids = [...primeiro.keys()];
      const r = await pool.query(SQL_RETORNOS, [ids, ids.map(i => primeiro.get(i).toISOString())]);
      for (const x of r.rows) retornos.set(x.identidade, { pagamentos: x.pagamentos, bruto: Number(x.bruto) || 0 });
    }
    return agregarFinanceiro({ pagamentos: pag.rows, gastos: gas.rows, retornos, adminEmail });
  }

  app.get("/api/admin/financeiro", checkAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await garantir();
      const hoje = new Date().toLocaleDateString("en-CA", { timeZone: FUSO });
      const de = String(req.query.de || ""), ate = String(req.query.ate || "");
      const v = validarPeriodo(de, ate, hoje);
      if (!v.ok) return res.status(400).json({ ok: false, error: v.erro });
      const ant = periodoAnterior(de, v.dias);
      const [atual, anterior, cobertura] = await Promise.all([
        apurar(de, ate), apurar(ant.de, ant.ate),
        pool.query(`SELECT canal, MIN(dia)::text primeiro, MAX(dia)::text ultimo, MAX(atualizado_em) atualizado_em,
                           array_agg(DISTINCT fonte) fontes FROM marketing_gasto_diario GROUP BY 1`)
      ]);
      return res.json({
        ok: true, de, ate, dias: v.dias, anterior: { ...ant, total: anterior.total },
        ...atual, incremental: compararPeriodos(atual, anterior),
        fontes_gasto: cobertura.rows, coleta: estado,
        atribuicao: "Último clique registrado no pagamento. Pagamentos sem identificador de clique entram como orgânico ou direto."
      });
    } catch (e) {
      log.error?.("[FINANCEIRO]", e.message);
      return res.status(500).json({ ok: false, error: "Não foi possível montar o financeiro" });
    }
  });

  app.post("/api/admin/financeiro/gasto/sincronizar", checkAdmin, async (req, res) => {
    try {
      const dias = Math.min(90, Math.max(1, parseInt(req.body?.dias || req.query.dias || "7", 10) || 7));
      return res.json({ ok: true, coleta: await sincronizar(dias) });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // Importação manual (ex.: relatório diário do Microsoft Ads) enquanto não há API conectada.
  app.post("/api/admin/financeiro/gasto/importar", checkAdmin, async (req, res) => {
    try {
      await garantir();
      const entrada = Array.isArray(req.body?.linhas) ? req.body.linhas.slice(0, 5000) : [];
      const linhas = entrada.map(normalizarLinhaImportada);
      const validas = linhas.filter(Boolean);
      const gravadas = await gravarGastos(pool, validas, { sobrescreverApi: false });
      return res.json({ ok: true, recebidas: entrada.length, gravadas, rejeitadas: linhas.length - validas.length });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // Envio automático pelos scripts das plataformas (Google Ads Scripts / Microsoft Advertising Scripts).
  // Autenticação por token próprio, sem sessão de usuário.
  app.post("/api/financeiro/gasto/ingest", async (req, res) => {
    try {
      if (!tokenIngestValido(req.get("x-ingest-token"), process.env.FINANCEIRO_INGEST_TOKEN)) {
        return res.status(403).json({ ok: false, error: "nao_autorizado" });
      }
      await garantir();
      const canal = String(req.body?.canal || "");
      if (!["google_ads", "microsoft_ads", "meta_ads"].includes(canal)) return res.status(400).json({ ok: false, error: "canal_invalido" });
      const entrada = Array.isArray(req.body?.linhas) ? req.body.linhas.slice(0, 5000) : [];
      const linhas = entrada.map(l => normalizarLinhaImportada({ ...l, canal }, `${canal}_script`)).filter(Boolean);
      const gravadas = await gravarGastos(pool, linhas);
      estado[canal] = { ok: true, configurado: true, via: "script", linhas: gravadas, em: new Date().toISOString() };
      return res.json({ ok: true, recebidas: entrada.length, gravadas });
    } catch (e) {
      log.error?.("[FINANCEIRO INGEST]", e.message);
      return res.status(500).json({ ok: false, error: "falha_ingestao" });
    }
  });

  return { sincronizar };
}
