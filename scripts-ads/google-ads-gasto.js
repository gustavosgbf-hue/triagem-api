// ConsultaJá24h · envio do gasto diário do Google Ads para o painel financeiro.
// Somente leitura na conta: não altera campanhas, anúncios, palavras-chave nem lances.
// Instalação: Google Ads > Ferramentas > Ações em massa > Scripts > + > colar > Autorizar > Programar "A cada hora".
var ENDPOINT = 'https://triagem-api.onrender.com/api/financeiro/gasto/ingest';
var TOKEN = '__TOKEN__';
var DIAS = 7; // reenvia a última semana para pegar ajustes de custo e conversões atrasadas

function main() {
  var conta = AdsApp.currentAccount();
  var tz = conta.getTimeZone();
  var fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); };
  var fim = new Date();
  var ini = new Date(fim.getTime() - (DIAS - 1) * 86400000);
  var query = 'SELECT segments.date, campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, ' +
    'metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign ' +
    "WHERE segments.date BETWEEN '" + fmt(ini) + "' AND '" + fmt(fim) + "'";
  var rows = AdsApp.search(query);
  var contaId = conta.getCustomerId().replace(/-/g, '');
  var linhas = [];
  while (rows.hasNext()) {
    var r = rows.next();
    linhas.push({
      dia: r.segments.date,
      conta_id: contaId,
      campanha_id: String(r.campaign.id),
      campanha_nome: r.campaign.name,
      custo: Number(r.metrics.costMicros || 0) / 1000000,
      impressoes: Number(r.metrics.impressions || 0),
      cliques: Number(r.metrics.clicks || 0),
      conversoes: Number(r.metrics.conversions || 0),
      valor_conversoes: Number(r.metrics.conversionsValue || 0)
    });
  }
  var resp = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-token': TOKEN },
    payload: JSON.stringify({ canal: 'google_ads', linhas: linhas }),
    muteHttpExceptions: true
  });
  Logger.log(linhas.length + ' linhas enviadas. Resposta ' + resp.getResponseCode() + ': ' + resp.getContentText());
  if (resp.getResponseCode() !== 200) throw new Error('Envio recusado: ' + resp.getResponseCode());
}
