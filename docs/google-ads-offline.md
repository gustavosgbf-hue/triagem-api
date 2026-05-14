# Google Ads offline conversions

O backend ja salva `gclid`, `gbraid` e `wbraid` no atendimento. Quando o pagamento vira confirmado, ele tenta enviar uma conversao offline para o Google Ads pela API `uploadClickConversions`.

## O que criar no Google Ads

Crie uma acao de conversao do tipo importacao de cliques/offline, nao uma tag de site. Ela deve representar a compra real, por exemplo:

`Compra confirmada - backend`

Use categoria `Compra`, valor `R$ 49,90` e contagem conforme sua estrategia de conversao.

## Variaveis de ambiente no Render

Obrigatorias:

```txt
GOOGLE_ADS_CUSTOMER_ID=1519420678
GOOGLE_ADS_CONVERSION_ACTION_ID=ID_DA_ACAO_OFFLINE
GOOGLE_ADS_DEVELOPER_TOKEN=...
GOOGLE_ADS_CLIENT_ID=...
GOOGLE_ADS_CLIENT_SECRET=...
GOOGLE_ADS_REFRESH_TOKEN=...
```

Opcionais:

```txt
GOOGLE_ADS_LOGIN_CUSTOMER_ID=ID_DO_MCC_SE_TIVER
GOOGLE_ADS_API_VERSION=v22
GOOGLE_ADS_CONVERSION_VALUE=49.90
GOOGLE_ADS_CONVERSION_CURRENCY=BRL
GOOGLE_ADS_VALIDATE_ONLY=true
GOOGLE_ADS_SEND_USER_DATA=false
```

Use `GOOGLE_ADS_VALIDATE_ONLY=true` primeiro para testar sem gravar conversoes. Depois mude para `false` ou remova a variavel.

## Logs esperados

Quando o pagamento for aprovado:

```txt
GOOGLE_ADS_OFFLINE_CONVERSION_CANDIDATE
GOOGLE_ADS_OFFLINE_UPLOAD_START
GOOGLE_ADS_OFFLINE_UPLOAD_OK
```

Se faltar credencial:

```txt
GOOGLE_ADS_OFFLINE_NOT_CONFIGURED
```

Se o atendimento nao tiver `gclid`, `gbraid` ou `wbraid`:

```txt
GOOGLE_ADS_OFFLINE_SKIP_NO_MATCH_DATA
```

## Retry manual

Depois de configurar as variaveis, da para reenviar compras recentes confirmadas:

```bash
curl -X POST "https://triagem-api.onrender.com/api/admin/google-ads/offline/retry?senha=SENHA_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"limit":25}'
```

Para forcar reenvio de conversoes ja marcadas como enviadas:

```bash
curl -X POST "https://triagem-api.onrender.com/api/admin/google-ads/offline/retry?senha=SENHA_ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"limit":25,"force":true}'
```
