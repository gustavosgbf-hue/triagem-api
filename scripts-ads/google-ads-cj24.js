/**
 * ConsultaJá24h · Google Ads (gasto + CJ24 Autopilot)
 *
 * O que faz a cada execução:
 *  1. Envia ao backend o gasto diário, o estado das campanhas, palavras-chave, horários
 *     e o vínculo clique→palavra-chave (click_view), para o Financeiro e o Autopilot.
 *  2. Recebe do backend as ações aprovadas. Só executa se AS TRÊS travas estiverem abertas:
 *     MODO_LOCAL = 'execucao' aqui, modo 'execucao' no painel e a ação aprovada por você.
 *     Fora disso tudo é registrado como simulação.
 *
 * Ações possíveis (e mais nenhuma): orçamento diário, CPA desejado, pausar/reativar
 * palavra-chave JÁ existente. Nunca cria/remove nada, não altera correspondência,
 * anúncios, URLs, segmentação ou lances manuais.
 *
 * Instalação: Ferramentas > Ações em massa > Scripts > + > colar > Autorizar > Frequência: a cada hora.
 */
var ENDPOINT = 'https://triagem-api.onrender.com/api/autopilot/google';
var TOKEN = '__TOKEN__';

// ── Travas locais (só você altera, dentro do Google Ads) ─────────────────────
var MODO_LOCAL = 'simulacao';               // 'simulacao' | 'execucao'
var CAMPANHAS_PERMITIDAS = ['23588664889']; // únicas campanhas que o Autopilot pode tocar
var ORCAMENTO_MIN = 100;                    // R$/dia
var ORCAMENTO_MAX = 1500;                   // R$/dia: teto absoluto, independente do backend
var MAX_PASSO_ORCAMENTO = 0.25;             // variação máxima por ação (25%)
var TCPA_MIN = 25, TCPA_MAX = 90;           // R$
var MAX_PASSO_TCPA = 0.20;                  // 20%
var MAX_ACOES_POR_EXECUCAO = 4;
var MAX_PALAVRAS_POR_EXECUCAO = 3;
var DIAS_GASTO = 7, DIAS_HORAS = 28, DIAS_CLIQUES = 3;
var DESDE_HISTORICO = '2026-03-01';

function main() {
  var conta = AdsApp.currentAccount();
  var tz = conta.getTimeZone();
  var cid = conta.getCustomerId().replace(/-/g, '');
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var hoje = new Date();
  var dia = function (n) { return fmt(new Date(hoje.getTime() - n * 86400000)); };
  var preview = AdsApp.getExecutionInfo().isPreview();

  var snapshot = {
    versao: 1, conta_id: cid, gerado_em: new Date().toISOString(), tz: tz,
    modo_local: MODO_LOCAL, preview: preview,
    travas: { campanhas: CAMPANHAS_PERMITIDAS, orcamento_min: ORCAMENTO_MIN, orcamento_max: ORCAMENTO_MAX,
      passo_orcamento: MAX_PASSO_ORCAMENTO, tcpa_min: TCPA_MIN, tcpa_max: TCPA_MAX, passo_tcpa: MAX_PASSO_TCPA },
    gasto: coletarGasto(dia(DIAS_GASTO - 1), dia(0), cid),
    campanhas: coletarCampanhas(dia(13), dia(0)),
    mudancas: coletarMudancas(dia(29)),
    horas: coletar('SELECT segments.date, segments.hour, campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM campaign ' +
      "WHERE segments.date BETWEEN '" + dia(DIAS_HORAS) + "' AND '" + dia(0) + "' AND metrics.impressions > 0", function (r) {
        return { dia: r.segments.date, hora: r.segments.hour, campanha_id: String(r.campaign.id), custo: micros(r.metrics.costMicros),
          cliques: num(r.metrics.clicks), impressoes: num(r.metrics.impressions), conversoes: num(r.metrics.conversions) };
      }),
    palavras: coletarPalavras(dia(29), dia(0)),
    cliques: coletarCliques(dia, DIAS_CLIQUES)
  };

  var resp = enviar('/sync', snapshot);
  var acoes = (resp && resp.acoes) || [];
  var modoServidor = resp && resp.modo;
  var resultados = [];
  var executadas = 0, palavras = 0;
  for (var i = 0; i < acoes.length; i++) {
    var a = acoes[i];
    var r = { id: a.id, tipo: a.tipo };
    try {
      var erro = validar(a, snapshot);
      if (erro) { r.status = 'recusada_local'; r.motivo = erro; }
      else if (preview || MODO_LOCAL !== 'execucao' || modoServidor !== 'execucao' || a.aprovada !== true) {
        r.status = 'simulada';
        r.motivo = preview ? 'preview' : (MODO_LOCAL !== 'execucao' ? 'trava_local' : (modoServidor !== 'execucao' ? 'modo_painel' : 'sem_aprovacao'));
      } else if (executadas >= MAX_ACOES_POR_EXECUCAO || (a.tipo === 'palavra_status' && palavras >= MAX_PALAVRAS_POR_EXECUCAO)) {
        r.status = 'adiada'; r.motivo = 'limite_por_execucao';
      } else {
        var res = AdsApp.mutate(operacao(a, cid));
        if (res.isSuccessful()) { r.status = 'aplicada'; executadas++; if (a.tipo === 'palavra_status') palavras++; }
        else { r.status = 'falhou'; r.motivo = String(res.getErrorMessages ? res.getErrorMessages() : 'erro'); }
      }
    } catch (e) { r.status = 'falhou'; r.motivo = String(e && e.message || e).slice(0, 300); }
    resultados.push(r);
  }
  if (resultados.length) enviar('/resultado', { resultados: resultados, preview: preview });
  Logger.log('Snapshot enviado. Ações recebidas: ' + acoes.length + '. Resultados: ' + JSON.stringify(resultados));
}

// ── Coleta ───────────────────────────────────────────────────────────────────
function coletar(query, mapa) {
  var out = [], it = AdsApp.search(query);
  while (it.hasNext()) out.push(mapa(it.next()));
  return out;
}
function num(v) { return Number(v || 0); }
function micros(v) { return Number(v || 0) / 1000000; }

function coletarGasto(de, ate, cid) {
  return coletar('SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value ' +
    "FROM campaign WHERE segments.date BETWEEN '" + de + "' AND '" + ate + "'", function (r) {
      return { dia: r.segments.date, conta_id: cid, campanha_id: String(r.campaign.id), campanha_nome: r.campaign.name,
        custo: micros(r.metrics.costMicros), impressoes: num(r.metrics.impressions), cliques: num(r.metrics.clicks),
        conversoes: num(r.metrics.conversions), valor_conversoes: num(r.metrics.conversionsValue) };
    });
}

function coletarCampanhas(de, ate) {
  var base = coletar('SELECT campaign.id, campaign.name, campaign.status, campaign.primary_status, campaign.bidding_strategy_type, ' +
    'campaign.maximize_conversions.target_cpa_micros, campaign.target_cpa.target_cpa_micros, campaign_budget.resource_name, ' +
    "campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.status != 'REMOVED'", function (r) {
      var mc = r.campaign.maximizeConversions || {}, tc = r.campaign.targetCpa || {};
      return { id: String(r.campaign.id), nome: r.campaign.name, status: r.campaign.status, status_primario: r.campaign.primaryStatus,
        estrategia: r.campaign.biddingStrategyType, tcpa: micros(mc.targetCpaMicros || tc.targetCpaMicros) || null,
        orcamento_recurso: r.campaignBudget.resourceName, orcamento: micros(r.campaignBudget.amountMicros),
        orcamento_compartilhado: !!r.campaignBudget.explicitlyShared };
    });
  var m = {};
  coletar('SELECT campaign.id, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, ' +
    'metrics.search_top_impression_share, metrics.search_absolute_top_impression_share, metrics.cost_micros, metrics.conversions ' +
    "FROM campaign WHERE segments.date BETWEEN '" + de + "' AND '" + ate + "' AND campaign.status != 'REMOVED'", function (r) {
      m[String(r.campaign.id)] = { parcela: num(r.metrics.searchImpressionShare), perdida_orcamento: num(r.metrics.searchBudgetLostImpressionShare),
        perdida_classificacao: num(r.metrics.searchRankLostImpressionShare), topo: num(r.metrics.searchTopImpressionShare),
        topo_absoluto: num(r.metrics.searchAbsoluteTopImpressionShare), custo: micros(r.metrics.costMicros), conversoes: num(r.metrics.conversions) };
    });
  base.forEach(function (c) { c.leilao_14d = m[c.id] || null; });
  return base;
}

function coletarPalavras(de, ate) {
  var campos = 'ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.keyword.text, ' +
    'ad_group_criterion.keyword.match_type, ad_group.id, campaign.id, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions ';
  var filtro = "WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED' ";
  var mapa = {};
  var add = function (chave) { return function (r) {
    var k = r.adGroupCriterion.resourceName;
    var p = mapa[k] || (mapa[k] = { recurso: k, id: String(r.adGroupCriterion.criterionId), ad_group_id: String(r.adGroup.id),
      campanha_id: String(r.campaign.id), texto: r.adGroupCriterion.keyword.text, correspondencia: r.adGroupCriterion.keyword.matchType,
      status: r.adGroupCriterion.status });
    p[chave] = { custo: micros(r.metrics.costMicros), cliques: num(r.metrics.clicks), impressoes: num(r.metrics.impressions), conversoes: num(r.metrics.conversions) };
    return p;
  }; };
  coletar('SELECT ' + campos + 'FROM keyword_view ' + filtro + "AND segments.date BETWEEN '" + de + "' AND '" + ate + "'", add('m30'));
  coletar('SELECT ' + campos + 'FROM keyword_view ' + filtro + "AND segments.date BETWEEN '" + DESDE_HISTORICO + "' AND '" + ate + "'", add('historico'));
  coletar('SELECT ad_group_criterion.resource_name, ad_group_criterion.criterion_id, ad_group_criterion.status, ad_group_criterion.keyword.text, ' +
    'ad_group_criterion.keyword.match_type, ad_group.id, campaign.id FROM ad_group_criterion ' +
    "WHERE ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.negative = FALSE AND ad_group_criterion.status != 'REMOVED' AND campaign.status != 'REMOVED'", function (r) {
      var k = r.adGroupCriterion.resourceName;
      if (!mapa[k]) mapa[k] = { recurso: k, id: String(r.adGroupCriterion.criterionId), ad_group_id: String(r.adGroup.id), campanha_id: String(r.campaign.id),
        texto: r.adGroupCriterion.keyword.text, correspondencia: r.adGroupCriterion.keyword.matchType, status: r.adGroupCriterion.status };
      return null;
    });
  return Object.keys(mapa).map(function (k) { return mapa[k]; });
}

// Histórico de alterações (30 dias) em campanha e orçamento: o Autopilot respeita o ciclo de aprendizado
// também quando a mudança foi feita manualmente por você.
function coletarMudancas(desde) {
  return coletar('SELECT change_event.change_date_time, change_event.change_resource_type, change_event.changed_fields, ' +
    "change_event.client_type, campaign.id FROM change_event WHERE change_event.change_date_time >= '" + desde + "' " +
    "AND change_event.change_resource_type IN ('CAMPAIGN', 'CAMPAIGN_BUDGET', 'AD_GROUP_CRITERION') " +
    'ORDER BY change_event.change_date_time DESC LIMIT 500', function (r) {
      return { quando: r.changeEvent.changeDateTime, recurso: r.changeEvent.changeResourceType,
        campos: String(r.changeEvent.changedFields || ''), origem: r.changeEvent.clientType, campanha_id: r.campaign ? String(r.campaign.id) : null };
    });
}

// click_view aceita um dia por consulta. Liga o gclid do pagamento à palavra-chave.
function coletarCliques(dia, dias) {
  var out = [];
  for (var i = 0; i < dias; i++) {
    var d = dia(i);
    coletar('SELECT click_view.gclid, click_view.keyword, segments.date, campaign.id, ad_group.id FROM click_view ' +
      "WHERE segments.date = '" + d + "'", function (r) {
        if (r.clickView && r.clickView.gclid) out.push({ gclid: r.clickView.gclid, palavra_recurso: r.clickView.keyword || null,
          dia: r.segments.date, campanha_id: String(r.campaign.id), ad_group_id: String(r.adGroup.id) });
        return null;
      });
  }
  return out;
}

// ── Execução protegida ───────────────────────────────────────────────────────
function permitida(campanhaId) { return CAMPANHAS_PERMITIDAS.indexOf(String(campanhaId)) >= 0; }
function passoOk(de, para, max) { return de > 0 && Math.abs(para / de - 1) <= max + 1e-9; }

function validar(a, snap) {
  if (!a || !a.id) return 'acao_invalida';
  if (a.tipo === 'orcamento') {
    var c = snap.campanhas.filter(function (x) { return x.id === String(a.campanha_id); })[0];
    if (!c || !permitida(c.id)) return 'campanha_nao_permitida';
    if (c.orcamento_compartilhado) return 'orcamento_compartilhado';
    if (c.orcamento_recurso !== a.recurso) return 'recurso_divergente';
    if (Math.abs(c.orcamento - a.de) > 0.01) return 'valor_atual_mudou';
    if (!(a.para >= ORCAMENTO_MIN && a.para <= ORCAMENTO_MAX)) return 'fora_dos_limites';
    if (!passoOk(a.de, a.para, MAX_PASSO_ORCAMENTO)) return 'passo_maior_que_limite';
    return null;
  }
  if (a.tipo === 'tcpa') {
    var t = snap.campanhas.filter(function (x) { return x.id === String(a.campanha_id); })[0];
    if (!t || !permitida(t.id)) return 'campanha_nao_permitida';
    if (['MAXIMIZE_CONVERSIONS', 'TARGET_CPA'].indexOf(t.estrategia) < 0) return 'estrategia_nao_suportada';
    if (!t.tcpa || Math.abs(t.tcpa - a.de) > 0.01) return 'valor_atual_mudou';
    if (!(a.para >= TCPA_MIN && a.para <= TCPA_MAX)) return 'fora_dos_limites';
    if (!passoOk(a.de, a.para, MAX_PASSO_TCPA)) return 'passo_maior_que_limite';
    return null;
  }
  if (a.tipo === 'palavra_status') {
    var p = snap.palavras.filter(function (x) { return x.recurso === a.recurso; })[0];
    if (!p) return 'palavra_inexistente';
    if (!permitida(p.campanha_id)) return 'campanha_nao_permitida';
    if (['ENABLED', 'PAUSED'].indexOf(a.para) < 0) return 'status_invalido';
    if (p.status !== a.de) return 'valor_atual_mudou';
    return null;
  }
  return 'tipo_nao_permitido';
}

function operacao(a, cid) {
  if (a.tipo === 'orcamento') return { campaignBudgetOperation: { update: { resourceName: a.recurso, amountMicros: Math.round(a.para * 100) * 10000 }, updateMask: 'amount_micros' } };
  if (a.tipo === 'tcpa') {
    var rn = 'customers/' + cid + '/campaigns/' + a.campanha_id;
    var micros = Math.round(a.para * 100) * 10000;
    return a.estrategia === 'TARGET_CPA'
      ? { campaignOperation: { update: { resourceName: rn, targetCpa: { targetCpaMicros: micros } }, updateMask: 'target_cpa.target_cpa_micros' } }
      : { campaignOperation: { update: { resourceName: rn, maximizeConversions: { targetCpaMicros: micros } }, updateMask: 'maximize_conversions.target_cpa_micros' } };
  }
  if (a.tipo === 'palavra_status') return { adGroupCriterionOperation: { update: { resourceName: a.recurso, status: a.para }, updateMask: 'status' } };
  throw new Error('tipo_nao_permitido');
}

function enviar(caminho, corpo) {
  var resp = UrlFetchApp.fetch(ENDPOINT + caminho, {
    method: 'post', contentType: 'application/json', headers: { 'x-ingest-token': TOKEN },
    payload: JSON.stringify(corpo), muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('Backend recusou ' + caminho + ': ' + resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 200));
  return JSON.parse(resp.getContentText());
}
