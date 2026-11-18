# Notificações Web Push para médicos — v1 (não publicado)

## Resumo
Aproveita o serviço existente `web-push-preload.js`, a biblioteca `web-push` e as chaves VAPID já previstas no servidor. Nenhum conteúdo de mensagens clínicas é incluído no push. É preciso publicar o backend **antes** do frontend.

## Endpoints novos (ambos exigem token JWT de médico do painel)
- `POST /api/web-push/medico/preferencias`: `{subscription:{endpoint,keys:{p256dh,auth}},mensagens:boolean}`. Uma preferência por dispositivo; mensagens false desativa a entrega por esse endpoint, sem alterar outros aparelhos.
- `POST /api/web-push/medico/estado`: `{endpoint}`, retorna `ativo`, `fila` e `mensagens`.

O endpoint antigo `GET /api/web-push/public-key` permanece. A tabela pré-existente `web_push_chat_subscriptions` recebe duas colunas booleanas opt-in, inicialmente false. Não há envio de push para entrada de pacientes na fila: esse aviso continua por e-mail.

## Lógica de entrega
- Nova mensagem: somente autor paciente, consulta associada ao médico, dispositivo ativo e com `medico_avisar_mensagens`; texto não é lido nem transmitido no payload. A rotina existente marca mensagens já despachadas.
- A chegada de paciente novo continua sendo avisada pelo e-mail já existente. Não existe notificação Web Push de fila.
- O worker roda em cadência de `CHAT_WEB_PUSH_WORKER_MS` (padrão: 12 segundos), logo não é garantia de alerta em tempo real ou de entrega caso dispositivo/sistema silencie notificações.
- Desabilitado em caso de desativação da conta médica.
- Sem dados clínicos ou mensagens integrais na notificação; nome abreviado apenas no aviso de chat.

## Dependências de produção
- `DATABASE_URL`, `JWT_SECRET`, `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT`; variáveis já usadas pela infraestrutura de Web Push.
- Configuração de CORS para a origem `https://painel.consultaja24h.com.br`.
- Publicar o backend antes do frontend. Não executar testes com pacientes reais sem opt-in explícito.

## Validações
- `node --check web-push-preload.js`
- `node --test scripts/test-medico-webpush-v1.mjs`
- Teste real com médico de teste + dois dispositivos, incluindo push em segundo plano, Android Chrome e iPhone instalado na Tela de Início.
- Exige validação dos envios VAPID e escrita no banco após deploy: testes estáticos e de demo não demonstram entrega real.
