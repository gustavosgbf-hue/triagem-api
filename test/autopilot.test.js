import test from "node:test";
import assert from "node:assert/strict";
import { planejar, ajustarElasticidade, CONFIG_PADRAO } from "../autopilot.js";
import { gerarToken, iguaisSeguro } from "../integracoes-tokens.js";

const travas = { campanhas: ["1"], orcamento_min: 100, orcamento_max: 1500, passo_orcamento: 0.25, tcpa_min: 25, tcpa_max: 90, passo_tcpa: 0.2 };
const campanha = (o = {}) => ({ id: "1", status: "ENABLED", estrategia: "MAXIMIZE_CONVERSIONS", tcpa: 46, orcamento: 350,
  orcamento_recurso: "customers/9/campaignBudgets/7", orcamento_compartilhado: false,
  leilao_14d: { parcela: 0.03, perdida_orcamento: 0.6, perdida_classificacao: 0.3, custo: 4600, conversoes: 100 }, ...o });
const econ = (o = {}) => ({ google: { pagamentos: 90, novos: 40, gasto: 315000, margem_media: 2700 }, ltv_margem_novo: 1500,
  elasticidade: { b: 0.5 }, cliques_2h: 5, pagamentos_2h: 2, pendentes_2h: 0, palavras: {}, horas: [], cpa_plataforma: 46, ...o });
const snap = (o = {}) => ({ travas, campanhas: [campanha()], palavras: [], mudancas: [], ...o });
const agora = new Date("2026-11-26T12:00:00Z");

test("elasticidade log-log", () => {
  const pts = Array.from({ length: 20 }, (_, i) => { const g = 20000 + i * 1500; return { gasto: g, pagamentos: Math.round(0.02 * Math.sqrt(g) * 10) }; });
  const e = ajustarElasticidade(pts);
  assert.ok(e.b > 0.4 && e.b < 0.6, String(e.b));
  assert.equal(ajustarElasticidade(pts.slice(0, 5)), null);
});

test("reduz orçamento quando custo marginal supera o valor do pagamento", () => {
  // cpa médio 3500, b=0.5 -> marginal 7000 > valor ~2700+1500*0.44
  const r = planejar({ snapshot: snap(), economia: econ(), capacidade: { espera_p75_min: 5 }, agora });
  const o = r.propostas.find(p => p.tipo === "orcamento");
  assert.equal(o.para, 315);
  assert.equal(o.requer_aprovacao, true);
});

test("aumenta quando há retorno, perda por orçamento e capacidade", () => {
  const r = planejar({ snapshot: snap(), economia: econ({ elasticidade: { b: 0.9 }, google: { pagamentos: 90, novos: 40, gasto: 180000, margem_media: 2700 } }), capacidade: { espera_p75_min: 5 }, agora });
  const o = r.propostas.find(p => p.tipo === "orcamento");
  assert.equal(o.para, 385);
  const bloq = planejar({ snapshot: snap(), economia: econ({ elasticidade: { b: 0.9 }, google: { pagamentos: 90, novos: 40, gasto: 180000, margem_media: 2700 } }), capacidade: { espera_p75_min: 45 }, agora });
  assert.equal(bloq.propostas.filter(p => p.tipo === "orcamento").length, 0);
});

test("respeita intervalo após mudança manual registrada no Google Ads", () => {
  const s = snap({ mudancas: [{ quando: "2026-11-25 10:00:00", recurso: "CAMPAIGN_BUDGET", campos: "amount_micros", campanha_id: "1" },
    { quando: "2026-11-20 10:00:00", recurso: "CAMPAIGN", campos: "maximize_conversions.target_cpa_micros", campanha_id: "1" }] });
  const r = planejar({ snapshot: s, economia: econ(), capacidade: { espera_p75_min: 5 }, agora });
  assert.equal(r.propostas.filter(p => p.tipo === "orcamento" || p.tipo === "tcpa").length, 0);
});

test("proteção de pagamentos tem prioridade e só reduz", () => {
  const r = planejar({ snapshot: snap(), economia: econ({ cliques_2h: 30, pagamentos_2h: 0, pendentes_2h: 6 }), capacidade: {}, agora });
  assert.equal(r.alertas[0].codigo, "pagamentos_parados");
  assert.equal(r.propostas.length, 1);
  assert.ok(r.propostas[0].para < 350);
});

test("palavras: pausa por prejuízo e reteste só como proposta", () => {
  const s = snap({ palavras: [
    { recurso: "k/1", campanha_id: "1", texto: "x", correspondencia: "BROAD", status: "ENABLED", m30: { custo: 200, conversoes: 0 } },
    { recurso: "k/2", campanha_id: "1", texto: "atestado medico online", correspondencia: "PHRASE", status: "PAUSED", historico: { custo: 88.29, conversoes: 3 } },
    { recurso: "k/3", campanha_id: "99", texto: "fora", correspondencia: "BROAD", status: "ENABLED", m30: { custo: 900, conversoes: 0 } }
  ] });
  const r = planejar({ snapshot: s, economia: econ(), capacidade: {}, agora });
  const ps = r.propostas.filter(p => p.tipo === "palavra_status");
  assert.deepEqual(ps.map(p => [p.alvo, p.para]), [["k/1", "PAUSED"], ["k/2", "ENABLED"]]);
  assert.equal(ps[1].prioridade, "reteste");
});

test("amostra pequena não propõe orçamento", () => {
  const r = planejar({ snapshot: snap(), economia: econ({ google: { pagamentos: 5, novos: 2, gasto: 20000, margem_media: 2700 } }), capacidade: {}, agora });
  assert.equal(r.propostas.length, 0);
  assert.equal(CONFIG_PADRAO.modo, "simulacao");
});

test("tokens", () => {
  const t = gerarToken();
  assert.ok(t.startsWith("cj24_") && t.length > 40);
  assert.equal(iguaisSeguro(t, t), true);
  assert.equal(iguaisSeguro(t, gerarToken()), false);
});

test("teto do painel limita mesmo com trava técnica maior", () => {
  const e = econ({ elasticidade: { b: 0.9 }, google: { pagamentos: 90, novos: 40, gasto: 180000, margem_media: 2700 } });
  const r = planejar({ snapshot: snap({ campanhas: [campanha({ orcamento: 400 })] }), economia: e, capacidade: {}, config: { orcamento_teto: 400 }, agora });
  assert.equal(r.propostas.filter(p => p.tipo === "orcamento").length, 0);
  assert.ok(r.insights.some(i => i.codigo === "teto_orcamento"));
  const r2 = planejar({ snapshot: snap(), economia: e, capacidade: {}, config: { passo_orcamento: 0.15, orcamento_teto: 2000 }, agora });
  assert.equal(r2.propostas.find(p => p.tipo === "orcamento").para, 402.5);
});
