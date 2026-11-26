import test from "node:test";
import assert from "node:assert/strict";
import { classificarCanal, agregarFinanceiro, compararPeriodos, validarPeriodo, periodoAnterior, lerSeedGoogle, normalizarLinhaImportada, criarColetores } from "../financeiro-marketing.js";
import { lerTaxasMargem } from "../margem-consulta.js";

const ADMIN = "admin@x.com";
const taxas = lerTaxasMargem({ MARGEM_TAXA_PAGBANK_PIX_PERCENTUAL: "1", MARGEM_IMPOSTO_PERCENTUAL: "6" });
const pag = (o) => ({
  dia: "2026-11-20", tipo: "chat", status: "encerrado", pagamento_status: "confirmado", status_atendimento: "✅ Atendido",
  categoria_atendimento: "clinico", valor_cobrado_centavos: 4990, reembolso_valor_centavos: 0,
  encerrado_em: "2026-11-20T15:00:00Z", pagamento_metodo: "pix", pagbank_order_id: "o", customer_type: "new",
  medico_email: ADMIN, ...o
});

test("canal por último clique", () => {
  assert.equal(classificarCanal({ ads_gclid: "abc" }), "google_ads");
  assert.equal(classificarCanal({ ads_last_touch: { landing_url: "https://x/?msclkid=1" } }), "microsoft_ads");
  assert.equal(classificarCanal({ ads_utm: { utm_source: "facebook", utm_medium: "paid_social" } }), "meta_ads");
  assert.equal(classificarCanal({ ads_last_touch: '{"landing_url":"https://x/?fbclid=1"}' }), "organico");
  assert.equal(classificarCanal({ origem_plataforma: "ios" }), "app");
  assert.equal(classificarCanal({ ads_utm: { utm_source: "chatgpt.com" } }), "referencia");
  assert.equal(classificarCanal({ ads_utm: { utm_source: "(not set)" } }), "organico");
});

test("agregação: CAC, custo por pagamento, margem e resultado", () => {
  const r = agregarFinanceiro({
    adminEmail: ADMIN, taxas,
    pagamentos: [
      pag({ ads_gclid: "a", identidade: "p1" }),
      pag({ ads_gclid: "b", identidade: "p2", customer_type: "returning", medico_email: "m@x.com", medico_nome_cad: "Fulano" }),
      pag({ origem_plataforma: "android", identidade: "p3" })
    ],
    gastos: [{ canal: "google_ads", dia: "2026-11-20", custo_centavos: 6000, impressoes: 100, cliques: 10 }],
    retornos: new Map([["p1", { pagamentos: 2, bruto: 9980 }]])
  });
  const g = r.canais.find(c => c.canal === "google_ads");
  assert.equal(g.pagamentos, 2);
  assert.equal(g.novos, 1);
  assert.equal(g.cac_novo, 6000);
  assert.equal(g.custo_por_pagamento, 3000);
  // admin: 4990-50-299 ; padrão: 4990-3493-50-299
  assert.equal(g.margem, (4990 - 50 - 299) + (4990 - 3493 - 50 - 299));
  assert.equal(g.resultado, g.margem - 6000);
  assert.equal(g.novos_que_voltaram, 1);
  assert.equal(g.receita_retorno, 9980);
  assert.equal(r.total.pagamentos, 3);
  assert.equal(r.cac_novo_combinado, 3000);
  assert.equal(r.diario[0].gasto, 6000);
});

test("consulta sem regra de repasse fica pendente, não entra na margem", () => {
  const r = agregarFinanceiro({ adminEmail: ADMIN, taxas, pagamentos: [pag({ medico_email: null })] });
  assert.equal(r.total.margem_pendente, 1);
  assert.equal(r.total.margem, 0);
  assert.equal(r.pendencias.medico_nao_identificado, 1);
});

test("retorno incremental entre períodos", () => {
  const atual = { total: { gasto: 20000, margem: 30000, pagamentos: 20, novos: 10 }, canais: [{ canal: "google_ads", pago: true, gasto: 20000, margem: 30000, pagamentos: 20, novos: 10 }] };
  const ant = { total: { gasto: 10000, margem: 22000, pagamentos: 14, novos: 6 }, canais: [{ canal: "google_ads", pago: true, gasto: 10000, margem: 22000, pagamentos: 14, novos: 6 }] };
  const c = compararPeriodos(atual, ant);
  assert.equal(c.total.margem_por_real_adicional, 0.8);
  assert.equal(c.total.custo_por_novo_adicional, 2500);
  assert.equal(c.total.delta_resultado, -2000);
});

test("período e seed", () => {
  assert.equal(validarPeriodo("2026-11-01", "2026-11-30").dias, 30);
  assert.equal(validarPeriodo("2026-11-30", "2026-11-01").ok, false);
  assert.deepEqual(periodoAnterior("2026-11-16", 10), { de: "2026-11-06", ate: "2026-11-15" });
  const seed = lerSeedGoogle();
  assert.ok(seed.length > 200);
  assert.equal(seed.at(-1).dia, "2026-11-25");
  assert.equal(seed.at(-1).custo_centavos, 41581);
});

test("importação manual valida canal e valores", () => {
  assert.equal(normalizarLinhaImportada({ canal: "tiktok", dia: "2026-11-01", custo: 10 }), null);
  assert.equal(normalizarLinhaImportada({ canal: "microsoft_ads", dia: "01/11/2026", custo: 10 }), null);
  assert.equal(normalizarLinhaImportada({ canal: "microsoft_ads", dia: "2026-11-01", custo: 12.34 }).custo_centavos, 1234);
});

test("coletor Google converte micros e Meta pagina", async () => {
  const col = criarColetores({
    env: { GOOGLE_ADS_DEVELOPER_TOKEN: "t", GOOGLE_ADS_REFRESH_TOKEN: "r", GOOGLE_ADS_CUSTOMER_ID: "1", META_ADS_ACCESS_TOKEN: "x", META_ADS_ACCOUNT_ID: "act_9" },
    consultarGoogleAds: async () => [{ segments: { date: "2026-11-25" }, campaign: { id: "5", name: "C" }, metrics: { costMicros: "415811800", clicks: "71", impressions: "906" } }],
    fetchFn: async (url) => ({ ok: true, json: async () => url.includes("after") ? { data: [] } : { data: [{ campaign_id: "1", date_start: "2026-11-25", spend: "10.50" }], paging: { next: "https://graph/after" } } })
  });
  const g = await col.google_ads.coletar("2026-11-25", "2026-11-25");
  assert.equal(g[0].custo_centavos, 41581);
  const m = await col.meta_ads.coletar("2026-11-25", "2026-11-25");
  assert.equal(m.length, 1);
  assert.equal(m[0].custo_centavos, 1050);
  assert.equal(col.microsoft_ads.configurado(), false);
});
