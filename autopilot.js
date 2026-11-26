// CJ24 Autopilot: gestor de mídia orientado a margem real.
// Ponte: Google Ads Script (scripts-ads/google-ads-cj24.js) envia snapshot -> backend planeja -> devolve
// somente ações APROVADAS. Execução exige três travas: script em 'execucao', painel em 'execucao', aprovação.
// Ações permitidas: orçamento diário, CPA desejado, status de palavra-chave existente. Nada mais.
import { apurarPeriodo } from "./financeiro-marketing.js";
import { calcularMargemConsulta } from "./margem-consulta.js";
import { calcularCoortes, valorFuturoPorNovo } from "./coortes.js";

export const TIPOS_PERMITIDOS = Object.freeze(["orcamento", "tcpa", "palavra_status"]);
const FUSO = "America/Fortaleza";
const diaIso = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: FUSO });
const menosDias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") - n * 86400000).toISOString().slice(0, 10);
const r2 = v => Math.round(v * 100) / 100;

export const CONFIG_PADRAO = Object.freeze({
  modo: "simulacao",              // simulacao | execucao (execução ainda exige aprovação por ação)
  janela_dias: 14,
  min_pagamentos_janela: 20,
  passo_orcamento: 0.10,          // configurável no painel (1% a 15%)
  orcamento_habitual: 350,        // R$/dia
  orcamento_teto: 450,            // faixa que pode ser proposta mediante evidência
  orcamento_excepcional: 500,     // só como proposta "excepcional"; acima disso nunca
  orcamento_piso: 100,
  congelar_orcamento: true,       // manter R$ 350 enquanto avalia melhorias recentes
  congelar_tcpa: true,            // manter CPA R$ 46
  congelamento_motivo: "Avaliando efeito das mudanças de 18/11 (orçamento), 20/11 (CPA), 25/11 (horários) e da landing.",
  testes_planejados: [{ id: "tcpa_42", tipo: "tcpa", para: 42, nota: "Retorno isolado ao CPA de R$ 42" }],
  intervalo_isolamento_dias: 7,   // entre mudanças de orçamento e de CPA (nunca juntas)
  limiar_reducao: 0.5,            // só propõe reduzir se o valor do pagamento adicional < 50% do custo dele
  min_novos_aumento: 0.35,        // aumento exige que >= 35% dos pagamentos do Google sejam pacientes novos
  participacao_prevista: null,    // fração das imediatas atendidas por você; null = usa a realizada
  tcpa_min: 25,
  tcpa_max: 90,
  intervalo_orcamento_dias: 3,
  intervalo_tcpa_dias: 14,
  min_conversoes_tcpa: 30,
  passo_tcpa: 0.10,
  folga_retorno: 0.10,            // exige valor por pagamento 10% acima do custo marginal para subir
  espera_max_min: 20,             // fila: p75 de espera acima disso bloqueia aumento
  protecao_cliques_2h: 15,        // cliques nas últimas 2 h sem nenhum pagamento confirmado
  palavra_pausa_multiplo: 3       // gasto >= 3x valor por pagamento sem pagamento real em 30 dias
});

// Elasticidade: pagamentos = a * gasto^b (log-log, dias com gasto). Custo marginal = gasto / (b * pagamentos).
export function ajustarElasticidade(pontos) {
  const ps = pontos.filter(p => p.gasto > 0 && p.pagamentos > 0);
  if (ps.length < 14) return null;
  const xs = ps.map(p => Math.log(p.gasto)), ys = ps.map(p => Math.log(p.pagamentos));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den <= 0) return null;
  const b = Math.min(1, Math.max(0.05, num / den));
  return { b: r2(b), a: Math.exp(my - b * mx), n: ps.length };
}

function decisao(tipo, extra) { return { tipo, requer_aprovacao: true, ...extra }; }

/**
 * Motor de planejamento (puro). Recebe métricas já apuradas e devolve propostas com justificativa.
 */
export function planejar({ snapshot, economia, capacidade, historico = [], config = CONFIG_PADRAO, agora = new Date() }) {
  const cfg = { ...CONFIG_PADRAO, ...config };
  const propostas = [], insights = [], alertas = [];
  const permitidas = new Set((snapshot?.travas?.campanhas || []).map(String));
  const tv = snapshot?.travas || {};
  // Vale o mais restritivo entre o painel (autorização) e o script (trava técnica).
  const lim = {
    orcMax: Math.min(Number(cfg.orcamento_excepcional) || 500, 500, Number(tv.orcamento_max) || Infinity),
    orcMax_tecnico: Math.min(500, Number(tv.orcamento_max) || Infinity),
    orcMin: Math.max(Number(cfg.orcamento_piso) || 0, Number(tv.orcamento_min) || 0),
    passoOrc: Math.min(Number(cfg.passo_orcamento) || 0.1, Number(tv.passo_orcamento) || 0.15),
    tcpaMin: Math.max(Number(cfg.tcpa_min) || 0, Number(tv.tcpa_min) || 0),
    tcpaMax: Math.min(Number(cfg.tcpa_max) || Infinity, Number(tv.tcpa_max) || Infinity),
    passoTcpa: Math.min(Number(cfg.passo_tcpa) || 0.1, Number(tv.passo_tcpa) || 0.15)
  };
  const campanhas = (snapshot?.campanhas || []).filter(c => permitidas.has(String(c.id)) && c.status === "ENABLED");
  // Última mudança: decisões aplicadas pelo Autopilot OU alterações registradas no Google Ads (inclusive manuais).
  const mudancas = snapshot?.mudancas || [];
  const ultima = (tipo, alvo) => {
    const datas = historico.filter(h => h.tipo === tipo && h.alvo === alvo && h.status === "aplicada").map(h => new Date(h.aplicada_em || h.criado_em));
    for (const m of mudancas) {
      if (String(m.campanha_id) !== String(alvo)) continue;
      const campos = String(m.campos || "").toLowerCase();
      if (tipo === "tcpa" && m.recurso === "CAMPAIGN" && campos.includes("target_cpa")) datas.push(new Date(String(m.quando).replace(" ", "T") + "-03:00"));
      if (tipo === "orcamento" && m.recurso === "CAMPAIGN_BUDGET" && campos.includes("amount")) datas.push(new Date(String(m.quando).replace(" ", "T") + "-03:00"));
    }
    return datas.filter(d => !isNaN(d)).sort((a, b) => b - a)[0];
  };
  const diasDesde = d => d ? (agora - d) / 86400000 : Infinity;

  // 1) Proteção de pagamentos: cliques recentes sem nenhum pagamento confirmado.
  if (economia.cliques_2h >= cfg.protecao_cliques_2h && economia.pagamentos_2h === 0 && economia.pendentes_2h >= 3) {
    alertas.push({ codigo: "pagamentos_parados", mensagem: `${economia.cliques_2h} cliques e ${economia.pendentes_2h} cobranças pendentes nas últimas 2 h, nenhuma confirmada.` });
    for (const c of campanhas) {
      if (c.orcamento_compartilhado) continue;
      const para = Math.max(lim.orcMin, r2(c.orcamento * (1 - lim.passoOrc)));
      if (para < c.orcamento) propostas.push(decisao("orcamento", {
        alvo: c.id, campanha_id: c.id, recurso: c.orcamento_recurso, de: c.orcamento, para, prioridade: "protecao",
        justificativa: "Proteção: pagamentos não estão sendo confirmados enquanto o anúncio segue recebendo cliques. Reduz exposição até a causa ser verificada.",
        dados: { cliques_2h: economia.cliques_2h, pendentes_2h: economia.pendentes_2h }
      }));
    }
    return { propostas, insights, alertas };
  }

  const g = economia.google;
  if (!g || g.pagamentos < cfg.min_pagamentos_janela) {
    insights.push({ codigo: "amostra_pequena", mensagem: `Só ${g?.pagamentos || 0} pagamentos com clique novo do Google em ${cfg.janela_dias} dias; sem proposta de orçamento ou CPA.` });
    return { propostas, insights, alertas };
  }

  // Valor de um pagamento do Google = margem imediata (pela participação prevista de quem atende) + valor futuro do novo.
  const mix = economia.mix || null;
  const margemPrevista = (share) => {
    if (!mix) return g.margem_media;
    const imediata = share * mix.margem_gustavo + (1 - share) * mix.margem_equipe;
    return mix.share_renovacao * mix.margem_renovacao + (1 - mix.share_renovacao) * imediata;
  };
  const shareReal = mix ? mix.share_gustavo : null;
  const shareUsado = cfg.participacao_prevista ?? shareReal;
  const margemPag = mix ? margemPrevista(shareUsado) : g.margem_media;
  const valorPagamento = margemPag + (g.novos / g.pagamentos) * (economia.ltv_margem_novo || 0);
  const cpaMedio = g.gasto / g.pagamentos;
  const elast = economia.elasticidade;
  const cpaMarginal = elast ? cpaMedio / elast.b : null;
  const cenarios = mix ? [shareReal, 0.5, 0.8].filter((v, i, a) => v !== null && a.indexOf(v) === i).map(sh => ({
    participacao: r2(sh), valor_por_pagamento: r2((margemPrevista(sh) + (g.novos / g.pagamentos) * (economia.ltv_margem_novo || 0)) / 100) })) : [];
  insights.push({ codigo: "economia_google", mensagem: "Base da decisão",
    dados: { janela_dias: cfg.janela_dias, pagamentos: g.pagamentos, novos: g.novos, margem_media: r2(g.margem_media / 100),
      participacao_realizada: shareReal !== null ? r2(shareReal) : null, participacao_usada: shareUsado !== null ? r2(shareUsado) : null,
      ltv_margem_novo: r2((economia.ltv_margem_novo || 0) / 100), ltv_fonte: economia.ltv_fonte || null,
      valor_por_pagamento: r2(valorPagamento / 100), cpa_medio: r2(cpaMedio / 100), cpa_marginal: cpaMarginal && r2(cpaMarginal / 100),
      elasticidade: elast, cenarios } });

  const fator = economia.cpa_plataforma > 0 ? cpaMedio / (economia.cpa_plataforma * 100) : 1;
  const capacidadeOk = !(capacidade?.espera_p75_min > cfg.espera_max_min);
  if (!capacidadeOk) insights.push({ codigo: "capacidade", mensagem: `Espera p75 de ${Math.round(capacidade.espera_p75_min)} min: aumento de verba bloqueado até a fila normalizar.` });

  // Isolamento: nunca orçamento e CPA juntos; uma mudança por vez, com intervalo entre elas.
  const abertas = economia.abertas || [];
  const algumaAberta = tipo => abertas.some(a => a.tipo === tipo);
  const ultimaQualquer = (alvo) => [ultima("orcamento", alvo), ultima("tcpa", alvo)].filter(Boolean).sort((a, b) => b - a)[0];
  let mudouNesteCiclo = false;

  // 2) Orçamento.
  for (const c of campanhas) {
    if (c.orcamento_compartilhado || !cpaMarginal) continue;
    if (cfg.congelar_orcamento) { insights.push({ codigo: "congelado", mensagem: `Orçamento mantido em R$ ${c.orcamento} por decisão sua. ${cfg.congelamento_motivo || ""}`.trim() }); continue; }
    if (algumaAberta("tcpa") || diasDesde(ultimaQualquer(c.id)) < cfg.intervalo_isolamento_dias) {
      insights.push({ codigo: "isolamento", mensagem: `Houve mudança de orçamento ou CPA há menos de ${cfg.intervalo_isolamento_dias} dias (ou há proposta de CPA aberta); orçamento aguarda para não misturar efeitos.` }); continue;
    }
    const perdaOrc = c.leilao_14d?.perdida_orcamento || 0;
    const fracNovos = g.novos / g.pagamentos;
    const evidencia = valorPagamento >= cpaMarginal * (1 + cfg.folga_retorno) && perdaOrc > 0.10 && fracNovos >= cfg.min_novos_aumento && capacidadeOk;
    if (evidencia) {
      const forte = valorPagamento >= cpaMarginal * 1.25 && perdaOrc > 0.20;
      const teto = forte ? Math.min(cfg.orcamento_excepcional, 500) : cfg.orcamento_teto;
      const para = Math.min(teto, lim.orcMax_tecnico, r2(c.orcamento * (1 + lim.passoOrc)));
      if (para > c.orcamento) {
        propostas.push(decisao("orcamento", { alvo: c.id, campanha_id: c.id, recurso: c.orcamento_recurso, de: c.orcamento, para,
          prioridade: para > cfg.orcamento_teto ? "excepcional" : null,
          justificativa: `Cada pagamento adicional custa cerca de R$ ${r2(cpaMarginal / 100)} e vale R$ ${r2(valorPagamento / 100)}; ${Math.round(fracNovos * 100)}% dos pagamentos são de pacientes novos e a campanha perde ${Math.round(perdaOrc * 100)}% das impressões por orçamento.${para > cfg.orcamento_teto ? " Acima de R$ " + cfg.orcamento_teto + ": faixa excepcional." : ""}`,
          dados: { cpa_marginal: cpaMarginal, valor_pagamento: valorPagamento, perdida_orcamento: perdaOrc, novos: fracNovos } }));
        mudouNesteCiclo = true;
      } else insights.push({ codigo: "teto_orcamento", mensagem: `Há evidência para aumentar, mas o orçamento já está no teto da faixa (R$ ${teto}).` });
    } else if (cpaMarginal && valorPagamento < cpaMarginal * cfg.limiar_reducao && c.orcamento > cfg.orcamento_habitual) {
      // Redução só volta ao habitual; abaixo do habitual só por decisão sua.
      const para = Math.max(cfg.orcamento_habitual, r2(c.orcamento * (1 - lim.passoOrc)));
      propostas.push(decisao("orcamento", { alvo: c.id, campanha_id: c.id, recurso: c.orcamento_recurso, de: c.orcamento, para,
        justificativa: `Acima do habitual o pagamento adicional custa R$ ${r2(cpaMarginal / 100)} e vale R$ ${r2(valorPagamento / 100)}: volta em direção a R$ ${cfg.orcamento_habitual}.`,
        dados: { cpa_marginal: cpaMarginal, valor_pagamento: valorPagamento } }));
      mudouNesteCiclo = true;
    } else {
      insights.push({ codigo: "orcamento_sem_evidencia", mensagem: perdaOrc <= 0.10
        ? `Só ${Math.round(perdaOrc * 100)}% das impressões são perdidas por orçamento: mais verba não compraria mais leilões, só lances mais caros.`
        : `Sem evidência suficiente para aumentar (valor por pagamento R$ ${r2(valorPagamento / 100)} x custo do pagamento adicional R$ ${r2(cpaMarginal / 100)}).` });
    }
  }

  // 3) CPA desejado: um passo por vez, isolado, respeitando o ciclo de aprendizado. Inclui testes planejados por você.
  for (const c of campanhas) {
    if (mudouNesteCiclo) break;
    if (!c.tcpa || !["MAXIMIZE_CONVERSIONS", "TARGET_CPA"].includes(c.estrategia)) continue;
    if (cfg.congelar_tcpa) {
      const t = (cfg.testes_planejados || []).find(x => x.tipo === "tcpa");
      insights.push({ codigo: "congelado", mensagem: `CPA desejado mantido em R$ ${c.tcpa}.${t ? " Próximo teste planejado: " + t.nota + " (R$ " + t.para + "), quando você descongelar." : ""}` });
      continue;
    }
    const dias = diasDesde(ultima("tcpa", c.id));
    const convs = c.leilao_14d?.conversoes ?? 0;
    if (algumaAberta("orcamento") || diasDesde(ultimaQualquer(c.id)) < cfg.intervalo_isolamento_dias || dias < cfg.intervalo_tcpa_dias || convs < cfg.min_conversoes_tcpa) {
      insights.push({ codigo: "tcpa_aguardando", mensagem: `CPA desejado: aguardando ${cfg.intervalo_tcpa_dias} dias e ${cfg.min_conversoes_tcpa} conversões desde a última mudança, sem outra mudança em curso.` });
      continue;
    }
    const teste = (cfg.testes_planejados || []).find(x => x.tipo === "tcpa" && Math.abs(x.para - c.tcpa) >= 0.5);
    if (teste) {
      const para = Math.min(lim.tcpaMax, Math.max(lim.tcpaMin, Number(teste.para)));
      propostas.push(decisao("tcpa", { alvo: c.id, campanha_id: c.id, estrategia: c.estrategia, de: c.tcpa, para, prioridade: "teste",
        justificativa: `Teste planejado por você: ${teste.nota}. Mudança isolada, avaliada após ${cfg.intervalo_tcpa_dias} dias.`, dados: { teste: teste.id } }));
      continue;
    }
    const alvoReal = valorPagamento / (1 + cfg.folga_retorno);
    const alvoPlataforma = alvoReal / 100 / (fator || 1);
    let para = c.tcpa;
    if (alvoPlataforma > c.tcpa * 1.05) para = r2(Math.min(c.tcpa * (1 + lim.passoTcpa), alvoPlataforma));
    else if (alvoPlataforma < c.tcpa * 0.95) para = r2(Math.max(c.tcpa * (1 - lim.passoTcpa), alvoPlataforma));
    para = Math.min(lim.tcpaMax, Math.max(lim.tcpaMin, para));
    if (Math.abs(para - c.tcpa) >= 0.5) propostas.push(decisao("tcpa", { alvo: c.id, campanha_id: c.id, estrategia: c.estrategia, de: c.tcpa, para,
      justificativa: `Valor por pagamento de R$ ${r2(valorPagamento / 100)} comporta CPA real de até R$ ${r2(alvoReal / 100)}; no critério da plataforma ~R$ ${r2(alvoPlataforma)}. Passo limitado a ${Math.round(lim.passoTcpa * 100)}%.`,
      dados: { fator_plataforma: fator, alvo_real: alvoReal } }));
  }

  // 4) Palavras-chave existentes: pausa por prejuízo comprovado; reativação só como sugestão de reteste.
  const porPalavra = economia.palavras || {};
  for (const p of snapshot.palavras || []) {
    if (!permitidas.has(String(p.campanha_id))) continue;
    const real = porPalavra[p.recurso] || { pagamentos: 0, margem: 0 };
    const custo30 = (p.m30?.custo || 0) * 100;
    if (p.status === "ENABLED" && custo30 >= cfg.palavra_pausa_multiplo * valorPagamento && real.pagamentos === 0 && (p.m30?.conversoes || 0) === 0) {
      propostas.push(decisao("palavra_status", { alvo: p.recurso, recurso: p.recurso, campanha_id: p.campanha_id, de: "ENABLED", para: "PAUSED",
        justificativa: `"${p.texto}" (${p.correspondencia}) gastou R$ ${r2(custo30 / 100)} em 30 dias sem nenhum pagamento real nem conversão.`,
        dados: { custo_30d: custo30, texto: p.texto, correspondencia: p.correspondencia } }));
    }
    if (p.status === "PAUSED" && (p.historico?.conversoes || 0) >= 2) {
      const cpaHist = p.historico.custo / p.historico.conversoes;
      if (cpaHist * 100 * fator < valorPagamento * 0.8) propostas.push(decisao("palavra_status", { alvo: p.recurso, recurso: p.recurso, campanha_id: p.campanha_id,
        de: "PAUSED", para: "ENABLED", prioridade: "reteste",
        justificativa: `Candidata a reteste: "${p.texto}" (${p.correspondencia}) teve CPA histórico de R$ ${r2(cpaHist)} com ${p.historico.conversoes} conversões. Amostra pequena: não é resultado garantido.`,
        dados: { cpa_historico: cpaHist, conversoes: p.historico.conversoes, texto: p.texto } }));
    }
  }

  // 5) Insights: horários e leilão (sem ação automática; o Autopilot não altera programação de anúncios).
  if (economia.horas?.length) {
    const ord = [...economia.horas].filter(h => h.gasto > 0).sort((a, b) => (b.resultado / b.gasto) - (a.resultado / a.gasto));
    insights.push({ codigo: "horarios", mensagem: "Retorno por faixa horária (28 dias)", dados: { melhores: ord.slice(0, 4), piores: ord.slice(-4) } });
  }
  for (const c of campanhas) {
    const l = c.leilao_14d;
    if (!l) continue;
    insights.push({ codigo: "leilao", mensagem: `Parcela de impressões ${Math.round(l.parcela * 100)}%: perdida por orçamento ${Math.round(l.perdida_orcamento * 100)}%, por classificação ${Math.round(l.perdida_classificacao * 100)}%.`,
      dados: { campanha_id: c.id, ...l } });
  }
  return { propostas, insights, alertas };
}

// ── Banco e rotas ────────────────────────────────────────────────────────────
const SQL = [
  `CREATE TABLE IF NOT EXISTS autopilot_config (id INT PRIMARY KEY DEFAULT 1, config JSONB NOT NULL, atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), CHECK (id=1))`,
  `CREATE TABLE IF NOT EXISTS autopilot_snapshots (id BIGSERIAL PRIMARY KEY, recebido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), plataforma TEXT NOT NULL, dados JSONB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS autopilot_cliques (gclid TEXT PRIMARY KEY, palavra_recurso TEXT, campanha_id TEXT, ad_group_id TEXT, dia DATE)`,
  `CREATE TABLE IF NOT EXISTS autopilot_decisoes (
     id BIGSERIAL PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     plataforma TEXT NOT NULL, tipo TEXT NOT NULL, alvo TEXT NOT NULL, de JSONB, para JSONB, prioridade TEXT,
     justificativa TEXT, dados JSONB, acao JSONB NOT NULL,
     status TEXT NOT NULL DEFAULT 'proposta', aprovada_em TIMESTAMPTZ, aprovada_por TEXT,
     enviada_em TIMESTAMPTZ, aplicada_em TIMESTAMPTZ, resultado JSONB, avaliacao JSONB)`,
  `CREATE INDEX IF NOT EXISTS autopilot_decisoes_status ON autopilot_decisoes (status, plataforma)`,
  `CREATE TABLE IF NOT EXISTS autopilot_marcos (id BIGSERIAL PRIMARY KEY, dia DATE NOT NULL, descricao TEXT NOT NULL, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  `CREATE TABLE IF NOT EXISTS autopilot_eventos (id BIGSERIAL PRIMARY KEY, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), tipo TEXT NOT NULL, dados JSONB)`
];

export function registrarRotasAutopilot(app, { pool, checkAdmin, tokens, adminEmail, financeiro, log = console }) {
  let pronto = false;
  async function garantir() { if (pronto) return; for (const q of SQL) await pool.query(q); pronto = true; }
  async function lerConfig() {
    await garantir();
    const { rows } = await pool.query(`SELECT config FROM autopilot_config WHERE id=1`);
    return { ...CONFIG_PADRAO, ...(rows[0]?.config || {}) };
  }
  const evento = (tipo, dados) => pool.query(`INSERT INTO autopilot_eventos (tipo, dados) VALUES ($1,$2)`, [tipo, JSON.stringify(dados || {})]).catch(() => {});

  async function apurarEconomia(snapshot, cfg) {
    const hoje = diaIso(), ate = menosDias(hoje, 1), de = menosDias(ate, cfg.janela_dias - 1);
    const fin = await apurarPeriodo(pool, de, ate, adminEmail, { incluirLinhas: true });
    const g = fin.canais.find(c => c.canal === "google_ads");
    // Retorno dos novos (margem futura): coorte de 60 a 30 dias atrás, receita posterior x margem média.
    // Valor futuro do paciente novo: coortes maduras do Google (margem de retornos SEM novo clique pago, sem dupla contagem).
    let ltv = 0, ltvFonte = null;
    try {
      const vf = valorFuturoPorNovo(await calcularCoortes(pool, adminEmail));
      if (vf) { ltv = vf.centavos; ltvFonte = `coortes ${vf.meses.join(", ")} em ${vf.janela} dias (${vf.pacientes} pacientes)`; }
    } catch (e) { log.warn?.("[AUTOPILOT] coortes", e.message); }
    // Mix de quem atende os pagamentos do Google (clique novo): renovação (sempre você), imediatas suas ou da equipe.
    const mix = { n_renov: 0, m_renov: 0, n_g: 0, m_g: 0, n_eq: 0, m_eq: 0 };
    for (const l of fin.linhas) {
      if (!(l.ads_gclid || l.ads_gbraid || l.ads_wbraid) || l.clique_reutilizado) continue;
      const medico = l.medico_email ? { email: l.medico_email, nome: l.medico_nome_cad, nome_exibicao: l.medico_nome_exibicao } : null;
      const m = calcularMargemConsulta({ at: l, medico, adminEmail, estimarAntesDaRegra: true });
      const v = m.margemCentavos ?? m.contribuicaoCentavos; if (v === null || v === undefined) continue;
      if (String(l.tipo || "").startsWith("renovacao")) { mix.n_renov++; mix.m_renov += v; }
      else if (String(l.medico_email || "").toLowerCase() === String(adminEmail).toLowerCase()) { mix.n_g++; mix.m_g += v; }
      else if (medico) { mix.n_eq++; mix.m_eq += v; }
    }
    const nImed = mix.n_g + mix.n_eq, nTot = nImed + mix.n_renov;
    const mixFinal = nTot >= 10 && mix.n_g > 0 && mix.n_eq > 0 ? {
      share_renovacao: mix.n_renov / nTot, margem_renovacao: mix.n_renov ? mix.m_renov / mix.n_renov : 0,
      share_gustavo: mix.n_g / nImed, margem_gustavo: mix.m_g / mix.n_g, margem_equipe: mix.m_eq / mix.n_eq
    } : null;
    const abertas = (await pool.query(`SELECT tipo FROM autopilot_decisoes WHERE status IN ('proposta','aprovada') AND plataforma='google_ads'`)).rows;
    // Elasticidade com 60 dias de gasto x pagamentos com clique novo.
    const hist = await apurarPeriodo(pool, menosDias(hoje, 60), ate, adminEmail, { incluirLinhas: true });
    const porDia = {};
    for (const d of hist.diario) porDia[d.dia] = { gasto: d.gasto_por_canal?.google_ads || 0, pagamentos: 0 };
    for (const l of hist.linhas) if ((l.ads_gclid || l.ads_gbraid || l.ads_wbraid) && !l.clique_reutilizado && porDia[l.dia]) porDia[l.dia].pagamentos++;
    const elasticidade = ajustarElasticidade(Object.values(porDia));
    // Pagamentos reais por palavra-chave (gclid -> click_view).
    const palavras = {};
    const { rows: mapa } = await pool.query(
      `SELECT c.palavra_recurso, f.id FROM autopilot_cliques c JOIN fila_atendimentos f ON f.ads_gclid = c.gclid
        WHERE f.pagamento_status='confirmado' AND f.pagamento_confirmado_em > NOW() - INTERVAL '30 days' AND c.palavra_recurso IS NOT NULL`);
    for (const m of mapa) { const p = palavras[m.palavra_recurso] ||= { pagamentos: 0 }; p.pagamentos++; }
    // Proteção: últimas 2 h.
    const { rows: [p2] } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE pagamento_status='confirmado' AND pagamento_confirmado_em > NOW() - INTERVAL '2 hours')::int pagos,
              COUNT(*) FILTER (WHERE pagamento_status='pendente' AND criado_em > NOW() - INTERVAL '2 hours' AND (pagbank_order_id IS NOT NULL OR stripe_checkout_session_id IS NOT NULL))::int pendentes
         FROM fila_atendimentos WHERE criado_em > NOW() - INTERVAL '3 hours' OR pagamento_confirmado_em > NOW() - INTERVAL '3 hours'`);
    const agoraH = Date.now();
    const cliques2h = (snapshot.horas || []).filter(h => {
      const t = Date.parse(`${h.dia}T${String(h.hora).padStart(2, "0")}:00:00-03:00`);
      return agoraH - t < 2 * 3600000 + 3600000;
    }).reduce((s, h) => s + h.cliques, 0);
    // Horas: gasto (script) x resultado das vendas com clique novo.
    const horas = {};
    for (const h of snapshot.horas || []) { const k = h.hora; (horas[k] ||= { hora: k, gasto: 0, margem: 0, pagamentos: 0 }).gasto += Math.round(h.custo * 100); }
    const { rows: ph } = await pool.query(
      `SELECT EXTRACT(HOUR FROM (pagamento_confirmado_em::timestamptz AT TIME ZONE '${FUSO}'))::int hora, COUNT(*)::int n
         FROM fila_atendimentos WHERE pagamento_status='confirmado' AND pagamento_confirmado_em > NOW() - INTERVAL '28 days'
          AND COALESCE(NULLIF(ads_gclid,''),NULLIF(ads_gbraid,''),NULLIF(ads_wbraid,'')) IS NOT NULL GROUP BY 1`);
    const mm = g?.margem_media || 0;
    for (const x of ph) { const k = x.hora; (horas[k] ||= { hora: k, gasto: 0, margem: 0, pagamentos: 0 }); horas[k].pagamentos = x.n; horas[k].margem = Math.round(x.n * mm); }
    const listaHoras = Object.values(horas).map(h => ({ ...h, resultado: h.margem - h.gasto }));
    const camp = (snapshot.campanhas || []).find(c => (snapshot.travas?.campanhas || []).includes(c.id));
    return {
      google: g ? { pagamentos: g.pagamentos, novos: g.novos, gasto: g.gasto, margem: g.margem, margem_media: g.margem_media || 0 } : null,
      ltv_margem_novo: Math.round(ltv), ltv_fonte: ltvFonte, mix: mixFinal, abertas, elasticidade, palavras, horas: listaHoras,
      pagamentos_2h: p2?.pagos || 0, pendentes_2h: p2?.pendentes || 0, cliques_2h: cliques2h,
      cpa_plataforma: camp?.leilao_14d?.conversoes ? camp.leilao_14d.custo / camp.leilao_14d.conversoes : 0,
      janela: { de, ate }
    };
  }

  async function capacidade() {
    const { rows: [c] } = await pool.query(
      `SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (assumido_em::timestamptz - pagamento_confirmado_em::timestamptz))/60) p75
         FROM fila_atendimentos WHERE pagamento_status='confirmado' AND assumido_em IS NOT NULL
          AND pagamento_confirmado_em > NOW() - INTERVAL '3 days' AND COALESCE(tipo,'') NOT LIKE 'renovacao%'`);
    return { espera_p75_min: c?.p75 === null || c?.p75 === undefined ? null : Number(c.p75) };
  }

  async function registrarPropostas(propostas) {
    const abertas = (await pool.query(`SELECT id, tipo, alvo FROM autopilot_decisoes WHERE status IN ('proposta','aprovada') AND plataforma='google_ads'`)).rows;
    const vistos = new Set();
    for (const p of propostas) {
      if (!TIPOS_PERMITIDOS.includes(p.tipo)) continue;
      const k = p.tipo + "|" + p.alvo; vistos.add(k);
      const acao = { tipo: p.tipo, recurso: p.recurso || null, campanha_id: p.campanha_id || null, estrategia: p.estrategia || null, de: p.de, para: p.para };
      const existente = abertas.find(a => a.tipo === p.tipo && a.alvo === p.alvo);
      if (existente) {
        await pool.query(`UPDATE autopilot_decisoes SET atualizado_em=NOW(), de=$2, para=$3, justificativa=$4, dados=$5, acao=$6, prioridade=$7,
                            status=CASE WHEN acao->>'para' = $6::jsonb->>'para' THEN status ELSE 'proposta' END,
                            aprovada_em=CASE WHEN acao->>'para' = $6::jsonb->>'para' THEN aprovada_em ELSE NULL END
                          WHERE id=$1`,
          [existente.id, JSON.stringify(p.de), JSON.stringify(p.para), p.justificativa, JSON.stringify(p.dados || {}), JSON.stringify(acao), p.prioridade || null]);
      } else {
        await pool.query(`INSERT INTO autopilot_decisoes (plataforma, tipo, alvo, de, para, prioridade, justificativa, dados, acao) VALUES ('google_ads',$1,$2,$3,$4,$5,$6,$7,$8)`,
          [p.tipo, p.alvo, JSON.stringify(p.de), JSON.stringify(p.para), p.prioridade || null, p.justificativa, JSON.stringify(p.dados || {}), JSON.stringify(acao)]);
      }
    }
    // Propostas que deixaram de fazer sentido expiram (aprovadas também, pois o contexto mudou).
    for (const a of abertas) if (!vistos.has(a.tipo + "|" + a.alvo)) {
      await pool.query(`UPDATE autopilot_decisoes SET status='expirada', atualizado_em=NOW() WHERE id=$1`, [a.id]);
    }
  }

  // ── Ponte do script ──
  app.post("/api/autopilot/google/sync", async (req, res) => {
    try {
      if (!(await tokens.validar(req.get("x-ingest-token"), "google_ads_script"))) return res.status(403).json({ ok: false, error: "nao_autorizado" });
      await garantir();
      const s = req.body || {};
      if (s.versao !== 1 || !Array.isArray(s.campanhas)) return res.status(400).json({ ok: false, error: "snapshot_invalido" });
      // Gasto diário para o Financeiro.
      if (Array.isArray(s.gasto) && financeiro?.gravarGastos) {
        const { normalizarLinhaImportada } = await import("./financeiro-marketing.js");
        await financeiro.garantir();
        await financeiro.gravarGastos(s.gasto.slice(0, 5000).map(l => normalizarLinhaImportada({ ...l, canal: "google_ads" }, "google_ads_script")).filter(Boolean));
      }
      for (const c of (s.cliques || []).slice(0, 20000)) {
        await pool.query(`INSERT INTO autopilot_cliques (gclid, palavra_recurso, campanha_id, ad_group_id, dia) VALUES ($1,$2,$3,$4,$5)
                          ON CONFLICT (gclid) DO UPDATE SET palavra_recurso=COALESCE(EXCLUDED.palavra_recurso, autopilot_cliques.palavra_recurso)`,
          [String(c.gclid).slice(0, 220), c.palavra_recurso || null, c.campanha_id || null, c.ad_group_id || null, c.dia || null]);
      }
      const { cliques, gasto, ...resumo } = s;
      await pool.query(`INSERT INTO autopilot_snapshots (plataforma, dados) VALUES ('google_ads',$1)`, [JSON.stringify(resumo)]);
      await pool.query(`DELETE FROM autopilot_snapshots WHERE recebido_em < NOW() - INTERVAL '30 days'`);

      let cfg = await lerConfig();
      // Janela de conversão por clique da ação de compra principal (usada na validade do gclid).
      const compra = (s.conversoes || []).filter(c => c.principal && c.categoria === "PURCHASE" && c.janela_clique_dias > 0);
      const janela = compra.length ? Math.max(...compra.map(c => c.janela_clique_dias)) : null;
      if (janela && janela !== cfg.janela_clique_dias && !s.preview) {
        cfg = { ...cfg, janela_clique_dias: janela };
        await pool.query(`INSERT INTO autopilot_config (id, config) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET config=autopilot_config.config || $1, atualizado_em=NOW()`,
          [JSON.stringify({ janela_clique_dias: janela })]);
      }
      const [economia, cap, hist] = await Promise.all([
        apurarEconomia(s, cfg), capacidade(),
        pool.query(`SELECT tipo, alvo, status, criado_em, aplicada_em FROM autopilot_decisoes WHERE status='aplicada' AND aplicada_em > NOW() - INTERVAL '60 days'`)
      ]);
      const plano = planejar({ snapshot: s, economia, capacidade: cap, historico: hist.rows, config: cfg });
      // Visualização do Google Ads: só leitura. Não registra, não expira e não envia nada.
      if (s.preview) {
        await evento("sync_preview", { propostas: plano.propostas.length, alertas: plano.alertas });
        return res.json({ ok: true, modo: "simulacao", preview: true, acoes: [], plano: { propostas: plano.propostas.map(p => ({ tipo: p.tipo, alvo: p.alvo, de: p.de, para: p.para })) } });
      }
      await registrarPropostas(plano.propostas);
      await evento("sync", { modo_local: s.modo_local, preview: !!s.preview, propostas: plano.propostas.length, alertas: plano.alertas, insights: plano.insights, economia: { ...economia, palavras: undefined } });

      // Só ações aprovadas saem, e só com as três travas abertas. Nada é marcado aqui: o estado
      // muda apenas quando o script reporta que aplicou de fato.
      const execucao = cfg.modo === "execucao" && s.modo_local === "execucao" && !s.preview;
      const aprovadas = execucao
        ? (await pool.query(`SELECT id, acao FROM autopilot_decisoes WHERE status='aprovada' AND plataforma='google_ads' ORDER BY aprovada_em LIMIT 10`)).rows
        : [];
      return res.json({ ok: true, modo: cfg.modo, acoes: aprovadas.map(a => ({ id: String(a.id), ...a.acao, aprovada: true })) });
    } catch (e) {
      log.error?.("[AUTOPILOT SYNC]", e.message);
      return res.status(500).json({ ok: false, error: "falha_sync" });
    }
  });

  app.post("/api/autopilot/google/resultado", async (req, res) => {
    try {
      if (!(await tokens.validar(req.get("x-ingest-token"), "google_ads_script"))) return res.status(403).json({ ok: false, error: "nao_autorizado" });
      await garantir();
      const cfgAtual = await lerConfig();
      if (req.body?.preview || cfgAtual.modo !== "execucao") {
        await evento("resultado_ignorado", { motivo: req.body?.preview ? "preview" : "modo_simulacao" });
        return res.json({ ok: true, ignorado: true });
      }
      for (const r of (req.body?.resultados || []).slice(0, 20)) {
        const id = parseInt(r.id, 10); if (!id) continue;
        if (!["aplicada", "falhou", "recusada_local"].includes(r.status)) continue;
        const status = r.status;
        await pool.query(`UPDATE autopilot_decisoes SET resultado=$2, atualizado_em=NOW(),
                            status=CASE WHEN $3 IN ('aplicada','falhou','recusada_local') THEN $3 ELSE status END,
                            aplicada_em=CASE WHEN $3='aplicada' THEN NOW() ELSE aplicada_em END
                          WHERE id=$1 AND status='aprovada'`, [id, JSON.stringify(r), status]);
      }
      await evento("resultado", req.body || {});
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: "falha_resultado" }); }
  });

  // ── Painel ──
  app.get("/api/admin/autopilot", checkAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const cfg = await lerConfig();
      const [dec, ev, snap, tok] = await Promise.all([
        pool.query(`SELECT id, criado_em, atualizado_em, tipo, alvo, de, para, prioridade, justificativa, dados, status, aprovada_em, aplicada_em, resultado
                      FROM autopilot_decisoes ORDER BY CASE WHEN status IN ('proposta','aprovada') THEN 0 ELSE 1 END, atualizado_em DESC LIMIT 60`),
        pool.query(`SELECT criado_em, dados FROM autopilot_eventos WHERE tipo='sync' ORDER BY id DESC LIMIT 1`),
        pool.query(`SELECT recebido_em, dados->'campanhas' campanhas, dados->>'modo_local' modo_local FROM autopilot_snapshots ORDER BY id DESC LIMIT 1`),
        tokens.situacao()
      ]);
      return res.json({ ok: true, config: cfg, decisoes: dec.rows, ultimo_sync: ev.rows[0] || null, snapshot: snap.rows[0] || null, integracoes: tok });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  // Indicadores diários: leilão (Google, via script) x pagamentos reais, com marcos de alterações.
  app.get("/api/admin/autopilot/indicadores", checkAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      await garantir();
      const dias = Math.min(60, Math.max(7, parseInt(req.query.dias || "30", 10) || 30));
      const { rows: [snap] } = await pool.query(`SELECT recebido_em, dados FROM autopilot_snapshots WHERE plataforma='google_ads' ORDER BY id DESC LIMIT 1`);
      const d = snap?.dados || {};
      const campanhas = new Set((d.travas?.campanhas || []).map(String));
      const porDia = {};
      const garantirDia = k => (porDia[k] ||= { dia: k, impressoes: 0, cliques: 0, custo: 0, conversoes_plataforma: 0, parcela: null, perdida_classificacao: null, perdida_orcamento: null, pagamentos: 0, pagamentos_google: 0, novos: 0, recorrentes: 0 });
      for (const l of d.leilao_diario || []) {
        if (campanhas.size && !campanhas.has(String(l.campanha_id))) continue;
        const x = garantirDia(l.dia);
        x.impressoes += l.impressoes; x.cliques += l.cliques; x.custo += l.custo; x.conversoes_plataforma += l.conversoes;
        x.parcela = l.parcela; x.perdida_classificacao = l.perdida_classificacao; x.perdida_orcamento = l.perdida_orcamento;
      }
      const { rows: pags } = await pool.query(
        `SELECT to_char((pagamento_confirmado_em::timestamptz AT TIME ZONE '${FUSO}'),'YYYY-MM-DD') dia,
                COUNT(*)::int pagamentos,
                COUNT(*) FILTER (WHERE COALESCE(NULLIF(ads_gclid,''),NULLIF(ads_gbraid,''),NULLIF(ads_wbraid,'')) IS NOT NULL)::int google,
                COUNT(*) FILTER (WHERE customer_type='new' OR cliente_novo IS TRUE)::int novos
           FROM fila_atendimentos WHERE pagamento_status='confirmado'
            AND pagamento_confirmado_em > NOW() - ($1::int * INTERVAL '1 day') GROUP BY 1`, [dias]);
      for (const p of pags) { const x = garantirDia(p.dia); x.pagamentos = p.pagamentos; x.pagamentos_google = p.google; x.novos = p.novos; x.recorrentes = p.pagamentos - p.novos; }
      const hoje = diaIso();
      const lista = Object.values(porDia).filter(x => x.dia >= menosDias(hoje, dias - 1)).sort((a, b) => a.dia.localeCompare(b.dia))
        .map(x => ({ ...x, cpc: x.cliques ? r2(x.custo / x.cliques) : null, cpa_real: x.pagamentos_google ? r2(x.custo / x.pagamentos_google) : null,
          // Conversões e parcela de impressões do Google consolidam com atraso: últimos 3 dias são parciais.
          parcial: x.dia > menosDias(hoje, 3) }));
      const tipoMudanca = m => {
        const c = String(m.campos || "").toLowerCase();
        if (m.recurso === "CAMPAIGN_BUDGET") return "Orçamento";
        if (m.recurso === "CAMPAIGN" && c.includes("target_cpa")) return "CPA desejado";
        if (m.recurso === "CAMPAIGN_CRITERION" || c.includes("ad_schedule")) return "Programação/segmentação";
        if (m.recurso === "AD_GROUP_CRITERION") return "Palavras-chave";
        return "Campanha";
      };
      const marcosGoogle = (d.mudancas || []).filter(m => !m.campanha_id || !campanhas.size || campanhas.has(String(m.campanha_id)))
        .map(m => ({ dia: String(m.quando).slice(0, 10), quando: m.quando, tipo: tipoMudanca(m), origem: m.origem, fonte: "google_ads" }));
      const { rows: manuais } = await pool.query(`SELECT to_char(dia,'YYYY-MM-DD') dia, descricao FROM autopilot_marcos ORDER BY dia`);
      return res.json({ ok: true, atualizado_em: snap?.recebido_em || null, dias: lista,
        marcos: [...marcosGoogle, ...manuais.map(m => ({ dia: m.dia, tipo: m.descricao, fonte: "manual" }))].sort((a, b) => String(a.dia).localeCompare(String(b.dia))),
        observacao: "Parcela de impressões e conversões do Google consolidam com até 3 dias de atraso. Pagamentos reais são do nosso banco, sem atraso." });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/admin/autopilot/marcos", checkAdmin, async (req, res) => {
    try {
      await garantir();
      const dia = String(req.body?.dia || ""), descricao = String(req.body?.descricao || "").trim().slice(0, 160);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !descricao) return res.status(400).json({ ok: false, error: "parametros" });
      await pool.query(`INSERT INTO autopilot_marcos (dia, descricao) VALUES ($1,$2)`, [dia, descricao]);
      return res.json({ ok: true });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get("/api/admin/financeiro/coortes", checkAdmin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const coortes = await calcularCoortes(pool, adminEmail, { meses: Math.min(12, Math.max(3, parseInt(req.query.meses || "9", 10) || 9)) });
      return res.json({ ok: true, coortes, valor_futuro_google: valorFuturoPorNovo(coortes),
        nota: "Margem de retornos posteriores à primeira compra. Pagamentos que chegaram por novo clique pago ficam em 'readquiridos' e não entram no valor da coorte." });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/admin/autopilot/decisao/:id", checkAdmin, async (req, res) => {
    try {
      await garantir();
      const id = parseInt(req.params.id, 10), acao = String(req.body?.acao || "");
      if (!id || !["aprovar", "rejeitar"].includes(acao)) return res.status(400).json({ ok: false, error: "parametros" });
      const { rowCount } = await pool.query(
        `UPDATE autopilot_decisoes SET status=$2, aprovada_em=CASE WHEN $2='aprovada' THEN NOW() ELSE NULL END, aprovada_por=$3, atualizado_em=NOW()
          WHERE id=$1 AND status IN ('proposta','aprovada')`, [id, acao === "aprovar" ? "aprovada" : "rejeitada", req.adminMedico?.email || "admin"]);
      await evento("decisao_" + acao, { id });
      return res.json({ ok: rowCount > 0 });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/admin/autopilot/limites", checkAdmin, async (req, res) => {
    try {
      await garantir();
      const b = req.body || {};
      const atual = await lerConfig();
      const num = (v, min, max, padrao) => { if (v === undefined || v === null || v === "") return padrao; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : NaN; };
      const novo = {
        passo_orcamento: num(b.passo_orcamento, 0.01, 0.15, atual.passo_orcamento),
        passo_tcpa: num(b.passo_tcpa, 0.01, 0.15, atual.passo_tcpa),
        orcamento_habitual: num(b.orcamento_habitual, 100, 500, atual.orcamento_habitual),
        orcamento_teto: num(b.orcamento_teto, 100, 500, atual.orcamento_teto),
        orcamento_excepcional: num(b.orcamento_excepcional, 100, 500, atual.orcamento_excepcional),
        orcamento_piso: num(b.orcamento_piso, 50, 500, atual.orcamento_piso),
        tcpa_min: num(b.tcpa_min, 10, 200, atual.tcpa_min),
        tcpa_max: num(b.tcpa_max, 10, 200, atual.tcpa_max),
        participacao_prevista: b.participacao_prevista === null || b.participacao_prevista === "" ? null : num(b.participacao_prevista, 0, 1, atual.participacao_prevista)
      };
      if (Object.values(novo).some(v => Number.isNaN(v))) return res.status(400).json({ ok: false, error: "valores_fora_da_faixa" });
      if (novo.orcamento_piso > novo.orcamento_habitual || novo.orcamento_habitual > novo.orcamento_teto || novo.orcamento_teto > novo.orcamento_excepcional || novo.tcpa_min > novo.tcpa_max)
        return res.status(400).json({ ok: false, error: "ordem_invalida" });
      if (typeof b.congelar_orcamento === "boolean") novo.congelar_orcamento = b.congelar_orcamento;
      if (typeof b.congelar_tcpa === "boolean") novo.congelar_tcpa = b.congelar_tcpa;
      const cfg = { ...atual, ...novo };
      await pool.query(`INSERT INTO autopilot_config (id, config) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET config=$1, atualizado_em=NOW()`, [JSON.stringify(cfg)]);
      await evento("limites", { ...novo, por: req.adminMedico?.email || "admin" });
      return res.json({ ok: true, config: cfg });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post("/api/admin/autopilot/modo", checkAdmin, async (req, res) => {
    try {
      await garantir();
      const modo = String(req.body?.modo || "");
      if (!["simulacao", "execucao"].includes(modo)) return res.status(400).json({ ok: false, error: "modo_invalido" });
      if (modo === "execucao" && req.body?.confirmacao !== "EXECUTAR") return res.status(400).json({ ok: false, error: "confirmacao_obrigatoria" });
      const cfg = { ...(await lerConfig()), modo };
      await pool.query(`INSERT INTO autopilot_config (id, config) VALUES (1,$1) ON CONFLICT (id) DO UPDATE SET config=$1, atualizado_em=NOW()`, [JSON.stringify(cfg)]);
      await evento("modo", { modo, por: req.adminMedico?.email || "admin" });
      return res.json({ ok: true, modo });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  });

  return { garantir };
}
