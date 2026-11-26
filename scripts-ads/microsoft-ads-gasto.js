// ConsultaJá24h · envio do gasto diário do Microsoft Ads para o painel financeiro.
// Somente leitura na conta: não altera campanhas, anúncios, palavras-chave nem lances.
// Instalação: Microsoft Advertising > Ferramentas > Scripts > Criar script > colar > Autorizar > Frequência "A cada hora".
var ENDPOINT = 'https://triagem-api.onrender.com/api/financeiro/gasto/ingest';
var TOKEN = '__TOKEN__';
var DIAS = 7;

function main() {
  var contaId = String(AdsApp.currentAccount().getAccountId());
  var linhas = [];
  for (var i = DIAS - 1; i >= 0; i--) {
    var d = new Date(Date.now() - i * 86400000 - 3 * 3600000); // dia em UTC-3
    var data = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    var iso = data.year + '-' + ('0' + data.month).slice(-2) + '-' + ('0' + data.day).slice(-2);
    var campanhas = AdsApp.campaigns().forDateRange(data, data).get();
    while (campanhas.hasNext()) {
      var c = campanhas.next();
      var s = c.getStats();
      if (!s.getImpressions() && !s.getCost()) continue;
      linhas.push({
        dia: iso,
        conta_id: contaId,
        campanha_id: String(c.getId()),
        campanha_nome: c.getName(),
        custo: Number(s.getCost() || 0),
        impressoes: Number(s.getImpressions() || 0),
        cliques: Number(s.getClicks() || 0),
        conversoes: Number(s.getConversions() || 0)
      });
    }
  }
  var resp = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-ingest-token': TOKEN },
    payload: JSON.stringify({ canal: 'microsoft_ads', linhas: linhas }),
    muteHttpExceptions: true
  });
  Logger.log(linhas.length + ' linhas enviadas. Resposta ' + resp.getResponseCode() + ': ' + resp.getContentText());
  if (resp.getResponseCode() !== 200) throw new Error('Envio recusado: ' + resp.getResponseCode());
}
