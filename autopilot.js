// CJ24 Autopilot: gestor de mídia orientado a margem real.
// Ponte: Google Ads Script (scripts-ads/google-ads-cj24.js) envia snapshot -> backend planeja -> devolve
// somente ações APROVADAS. Execução exige três travas: script em 'execucao', painel em 'execucao', aprovação.
// Ações permitidas: orçamento diário, CPA desejado, status de palavra-chave existente. Nada mais.
import { apurarPeriodo } from "./financeiro-marketing.js";

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
  orcamento_teto: 400,            // R$/dia: autorização de investimento (o R$ 1.500 do script é só trava técnica)
  orcamento_piso: 100,
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
    orcMax: Math.min(Number(cfg.orcamento_teto) || 0, Number(tv.orcamento_max) || Infinity),
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

  // Valor econômico de um pagamento vindo do Google = margem imediata + retorno esperado dos novos.
  const valorPagamento = g.margem_media + (g.novos / g.pagamentos) * (economia.ltv_margem_novo || 0);
  const cpaMedio = g.gasto / g.pagamentos;
  const elast = economia.elasticidade;
  const cpaMarginal = elast ? cpaMedio / elast.b : null;
  insights.push({ codigo: "economia_google", mensagem: "Base da decisão",
    dados: { janela_dias: cfg.janela_dias, pagamentos: g.pagamentos, novos: g.novos, margem_media: r2(g.margem_media / 100),
      ltv_margem_novo: r2((economia.ltv_margem_novo || 0) / 100), valor_por_pagamento: r2(valorPagamento / 100),
      cpa_medio: r2(cpaMedio / 100), cpa_marginal: cpaMarginal && r2(cpaMarginal / 100), elasticidade: elast } });

  // Relação entre o CPA real (pagamentos com clique novo) e o CPA que a plataforma reporta.
  const fator = economia.cpa_plataforma > 0 ? cpaMedio / (economia.cpa_plataforma * 100) : 1;
  const capacidadeOk = !(capacidade?.espera_p75_min > cfg.espera_max_min);
  if (!capacidadeOk) insights.push({ codigo: "capacidade", mensagem: `Espera p75 de ${Math.round(capacidade.espera_p75_min)} min: aumento de verba bloqueado até a fila normalizar.` });

  // 2) Orçamento.
  for (const c of campanhas) {
    if (c.orcamento_compartilhado || !cpaMarginal) continue;
    const perdaOrc = c.leilao_14d?.perdida_orcamento || 0;
    const recente = diasDesde(ultima("orcamento", c.id)) < cfg.intervalo_orcamento_dias;
    if (recente) { insights.push({ codigo: "orcamento_aguardando", mensagem: `Orçamento alterado há menos de ${cfg.intervalo_orcamento_dias} dias; aguardando efeito.` }); continue; }
    if (valorPagamento > cpaMarginal * (1 + cfg.folga_retorno) && perdaOrc > 0.10 && capacidadeOk) {
      const para = Math.min(lim.orcMax, r2(c.orcamento * (1 + lim.passoOrc)));
      if (para <= c.orcamento) insights.push({ codigo: "teto_orcamento", mensagem: `Haveria espaço para aumentar, mas o orçamento já está no teto autorizado (R$ ${lim.orcMax}). Ajuste em Limites se quiser.` });
      if (para > c.orcamento) propostas.push(decisao("orcamento", { alvo: c.id, campanha_id: c.id, recurso: c.orcamento_recurso, de: c.orcamento, para,
        justificativa: `Cada pagamento adicional custa cerca de R$ ${r2(cpaMarginal / 100)} e vale R$ ${r2(valorPagamento / 100)} de margem (incluindo retorno esperado). A campanha perde ${Math.round(perdaOrc * 100)}% das impressões por orçamento.`,
        dados: { cpa_marginal: cpaMarginal, valor_pagamento: valorPagamento, perdida_orcamento: perdaOrc } }));
    } else if (valorPagamento < cpaMarginal * (1 - cfg.folga_retorno)) {
      const para = Math.max(lim.orcMin, r2(c.orcamento * (1 - lim.passoOrc)));
      if (para < c.orcamento) propostas.push(decisao("orcamento", { alvo: c.id, campanha_id: c.id, recurso: c.orcamento_recurso, de: c.orcamento, para,
        justificativa: `O último real investido traz menos margem do que custa: pagamento adicional custa cerca de R$ ${r2(cpaMarginal / 100)} e vale R$ ${r2(valorPagamento / 100)}.`,
        dados: { cpa_marginal: cpaMarginal, valor_pagamento: valorPagamento } }));
    }
  }

  // 3) CPA desejado: respeita ciclo de aprendizado (intervalo e volume mínimo de conversões).
  for (const c of campanhas) {
    if (!c.tcpa || !["MAXIMIZE_CONVERSIONS", "TARGET_CPA"].includes(c.estrategia)) continue;
    const dias = diasDesde(ultima("tcpa", c.id));
    const convs = c.leilao_14d?.conversoes ?? 0; // conversões da plataforma nos últimos 14 dias
    if (dias < cfg.intervalo_tcpa_dias || convs < cfg.min_conversoes_tcpa) {
      insights.push({ codigo: "tcpa_aguardando", mensagem: `CPA desejado: aguardando ${cfg.intervalo_tcpa_dias} dias e ${cfg.min_conversoes_tcpa} conversões desde a última mudança.` });
      continue;
    }
    // CPA que a plataforma "enxerga" é sobre as conversões dela; mantém a relação CPA real / CPA plataforma.
    const alvoReal = valorPagamento / (1 + cfg.folga_retorno);
    const alvoPlataforma = alvoReal / 100 / (fator || 1);
    let para = c.tcpa;
    if (alvoPlataforma > c.tcpa * 1.05) para = r2(Math.min(c.tcpa * (1 + lim.passoTcpa), alvoPlataforma));
    else if (alvoPlataforma < c.tcpa * 0.95) para = r2(Math.max(c.tcpa * (1 - lim.passoTcpa), alvoPlataforma));
    para = Math.min(lim.tcpaMax, Math.max(lim.tcpaMin, para));
    if (Math.abs(para - c.tcpa) >= 0.5) propostas.push(decisao("tcpa", { alvo: c.id, campanha_id: c.id, estrategia: c.estrategia, de: c.tcpa, para,
      justificativa: `Valor por pagamento de R$ ${r2(valorPagamento / 100)} comporta CPA real de até R$ ${r2(alvoReal / 100)}; no critério da plataforma isso equivale a ~R$ ${r2(alvoPlataforma)}. Passo limitado a ${Math.round(lim.passoTcpa * 100)}%.`,
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
    const coorte = await apurarPeriodo(pool, menosDias(hoje, 60), menosDias(hoje, 30), adminEmail);
    const cg = coorte.canais.find(c => c.canal === "google_ads");
    const margemSobreReceita = fin.total.bruto > 0 ? fin.total.margem / Math.max(1, fin.total.bruto - fin.total.estornos) : 0.5;
    const ltv = cg && cg.novos > 0 ? (cg.receita_retorno / cg.novos) * margemSobreReceita : 0;
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
      ltv_margem_novo: Math.round(ltv), elasticidade, palavras, horas: listaHoras,
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
      const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
      const novo = {
        passo_orcamento: num(b.passo_orcamento, 0.01, 0.15), passo_tcpa: num(b.passo_tcpa, 0.01, 0.15),
        orcamento_teto: num(b.orcamento_teto, 100, 1500), orcamento_piso: num(b.orcamento_piso, 50, 1500),
        tcpa_min: num(b.tcpa_min, 10, 200), tcpa_max: num(b.tcpa_max, 10, 200)
      };
      if (Object.values(novo).some(v => v === null)) return res.status(400).json({ ok: false, error: "valores_fora_da_faixa" });
      if (novo.orcamento_piso > novo.orcamento_teto || novo.tcpa_min > novo.tcpa_max) return res.status(400).json({ ok: false, error: "minimo_maior_que_maximo" });
      const cfg = { ...(await lerConfig()), ...novo };
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
