# Auditoria de identidade do paciente

## Contrato corrigido

- `GET /api/paciente/buscar?tel=...` informa somente `cadastroEncontrado` e
  `requerVerificacao`. Nome, telefone, CPF, nascimento e e-mail não são lidos
  pela consulta nem devolvidos ao cliente.
- A retomada automática de atendimento pago exige CPF e não roda para
  `atendimento_para_terceiro` nem reutiliza registros anteriores de terceiro.
- `POST /api/atendimento/atualizar-cpf` não aceita mais `pacienteId` ou telefone
  como fallback. Esses identificadores podiam atingir outra pessoa que usa o
  mesmo contato.
- Paciente, pagador e contato continuam em campos distintos no payload de
  `/api/notify`.

## Consumidores revisados

Os cinco consumidores encontrados foram adaptados ao contrato sem PII:

- `teleconsulta24h/index.html`
- `teleconsulta24h/consulta/index.html`
- `teleconsulta24h/atendimento/index.html`
- `teleconsulta24h/triagem/index.html`
- `teleconsulta24h/triagem.html`

As telas modernas mantêm a mensagem de cadastro anterior e coletam nome, CPF e
nascimento no passo pós-pagamento. As telas legadas mostram os campos de nome e
nascimento antes de continuar. Nenhuma delas preenche dados clínicos pelo
telefone.

## Rotas autenticadas

As rotas de conta, histórico, documentos e chat `v2` sob `/api/paciente/*`
usam `authPaciente`. As rotas longitudinais e Memed usadas pelo painel exigem
autenticação médica e verificam médico responsável ou administrador.

`POST /api/atendimento/meet` e `POST /api/atendimento/encerrar` foram corrigidas
para exigir autenticação médica e vínculo com o atendimento (ou administrador).

## Bloqueios restantes antes de merge/produção

O fluxo web legado ainda usa o ID numérico do atendimento como credencial. Uma
correção segura precisa emitir um token opaco por atendimento e enviá-lo em
todas as chamadas do paciente. Até essa migração coordenada, permanecem
inseguros:

- `GET /api/atendimento/status/:id`: devolve PII e dados de pagamento sem token.
- `GET /api/chat/:atendimentoId`: devolve o histórico quando o ID existe, mesmo
  sem autenticação; o preload carregado em produção preserva esse comportamento.
- `POST /api/notify` com `atendimentoId`: atualiza identidade e triagem sem provar
  posse do atendimento.
- `POST /api/atendimento/atualizar-triagem` e
  `POST /api/atendimento/atualizar-modalidade`: alteram o atendimento pelo ID.
- `POST /api/atendimento/:id/fallback-especialista`: toma decisão financeira pelo
  ID.
- `POST /api/atendimento/vincular-order` e
  `GET /api/pagamento/elegibilidade/:atendimentoId`: confiam no ID fornecido.
- `POST /api/atendimento/atualizar-cpf` ainda precisa do token do fluxo para que
  até o caminho por `atendimentoId` fique protegido; `orderId` é menos previsível,
  mas não substitui autorização explícita.

O token deve ser criado junto ao pré-registro, guardado no navegador e incluído
no link de retorno e nas requisições do fluxo. O backend deve armazenar somente
o hash (ou usar JWT curto e específico), validar o vínculo com o ID e manter
webhooks de pagamento separados da autorização do navegador.
