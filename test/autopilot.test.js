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

const livre = { congelar_orcamento: false, congelar_tcpa: false, testes_planejados: [] };
const bom = () => econ({ elasticidade: { b: 0.9 }, google: { pagamentos: 90, novos: 40, gasto: 180000, margem_media: 2700 } });

test("padrão: orçamento e CPA congelados (350/46), só insights", () => {
  const r = planejar({ snapshot: snap(), economia: econ(), capacidade: { espera_p75_min: 5 }, agora });
  assert.equal(r.propostas.filter(p => p.tipo === "orcamento" || p.tipo === "tcpa").length, 0);
  assert.ok(r.insights.some(i => i.codigo === "congelado" && /R\$ 42/.test(i.mensagem)));
});

test("não reduz abaixo do habitual mesmo com custo marginal alto", () => {
  const r = planejar({ snapshot: snap(), economia: econ(), capacidade: { espera_p75_min: 5 }, config: livre, agora });
  assert.equal(r.propostas.filter(p => p.tipo === "orcamento").length, 0);
  const acima = planejar({ snapshot: snap({ campanhas: [campanha({ orcamento: 450 })] }), economia: econ(), capacidade: {}, config: livre, agora });
  assert.equal(acima.propostas.find(p => p.tipo === "orcamento").para, 405);
});

test("aumenta com evidência até a faixa de 450 e uma mudança por ciclo", () => {
  const r = planejar({ snapshot: snap(), economia: bom(), capacidade: { espera_p75_min: 5 }, config: livre, agora });
  const o = r.propostas.filter(p => p.tipo === "orcamento");
  assert.equal(o.length, 1); assert.equal(o[0].para, 385);
  assert.equal(r.propostas.filter(p => p.tipo === "tcpa").length, 0, "CPA não muda no mesmo ciclo");
  const bloq = planejar({ snapshot: snap(), economia: bom(), capacidade: { espera_p75_min: 45 }, config: livre, agora });
  assert.equal(bloq.propostas.filter(p => p.tipo === "orcamento").length, 0);
});

test("sem perda por orçamento não aumenta (não paga mais caro pelos mesmos)", () => {
  const s = snap({ campanhas: [campanha({ leilao_14d: { parcela: 0.08, perdida_orcamento: 0.0124, perdida_classificacao: 0.9, custo: 4600, conversoes: 100 } })] });
  const r = planejar({ snapshot: s, economia: bom(), capacidade: {}, config: livre, agora });
  assert.equal(r.propostas.filter(p => p.tipo === "orcamento").length, 0);
  assert.ok(r.insights.some(i => i.codigo === "orcamento_sem_evidencia"));
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

test("faixa excepcional até 500, nunca acima", () => {
  const s = snap({ campanhas: [campanha({ orcamento: 450, leilao_14d: { parcela: 0.03, perdida_orcamento: 0.5, perdida_classificacao: 0.3, custo: 4600, conversoes: 100 } })] });
  const r = planejar({ snapshot: s, economia: bom(), capacidade: {}, config: livre, agora });
  const o = r.propostas.find(p => p.tipo === "orcamento");
  assert.equal(o.para, 495); assert.equal(o.prioridade, "excepcional");
  const s2 = snap({ travas: { ...travas, orcamento_max: 1500 }, campanhas: [campanha({ orcamento: 495, leilao_14d: { parcela: 0.03, perdida_orcamento: 0.5, perdida_classificacao: 0.3, custo: 4600, conversoes: 100 } })] });
  const r2 = planejar({ snapshot: s2, economia: bom(), capacidade: {}, config: { ...livre, orcamento_excepcional: 900 }, agora });
  assert.equal(r2.propostas.find(p => p.tipo === "orcamento").para, 500);
});

test("teste planejado de CPA 42 só quando descongelado e isolado", () => {
  const cfg = { congelar_orcamento: true, congelar_tcpa: false };
  const r = planejar({ snapshot: snap(), economia: econ(), capacidade: {}, config: cfg, agora });
  const t = r.propostas.find(p => p.tipo === "tcpa");
  assert.equal(t.para, 42); assert.equal(t.prioridade, "teste");
  const aberto = planejar({ snapshot: snap(), economia: econ({ abertas: [{ tipo: "orcamento" }] }), capacidade: {}, config: cfg, agora });
  assert.equal(aberto.propostas.filter(p => p.tipo === "tcpa").length, 0);
});

test("participação prevista muda o valor do pagamento", () => {
  const mix = { share_renovacao: 0.1, margem_renovacao: 5600, share_gustavo: 0.2, margem_gustavo: 4500, margem_equipe: 1300 };
  const r = planejar({ snapshot: snap(), economia: econ({ mix }), capacidade: {}, config: { participacao_prevista: 0.8 }, agora });
  const d = r.insights.find(i => i.codigo === "economia_google").dados;
  assert.equal(d.participacao_usada, 0.8);
  assert.ok(d.cenarios.length >= 2);
  assert.ok(d.valor_por_pagamento > 40);
});
