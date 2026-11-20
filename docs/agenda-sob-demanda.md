# Agenda sob demanda — psicologia e especialistas

Fuso oficial: **America/Fortaleza (UTC-3)**. Horizonte: **90 dias**. Nada é materializado no banco.

## Novos endpoints (aditivos — os antigos continuam iguais)

```
GET /api/psicologia/slots/:psicologoId?inicio=AAAA-MM-DD&dias=7&limite=120
GET /api/especialistas/slots/:especialistaId?inicio=AAAA-MM-DD&dias=7&limite=120
```

- `dias`: padrão 7, máximo 14 (janela). `limite`: máximo rígido 120 slots por resposta.
- Remove horários passados e os que se sobrepõem a reservas ativas
  (pagas ou criadas há < 35 min; duração 60 min — `ESP_DURACAO_MIN` para especialistas).
- Paginação: repita a chamada com `inicio = proximo_inicio` até vir `null`.
  Se `truncado=true`, a resposta traz só dias completos e `proximo_inicio` aponta o dia omitido.
- Custo por requisição: 1 query do profissional + 1 query de reservas na janela.

Resposta:
```json
{ "ok": true, "timezone": "America/Fortaleza", "horizonte_dias": 90, "duracao_min": 60,
  "inicio": "2026-11-20", "fim": "2026-11-26", "dias": 7, "limite": 120,
  "truncado": false, "proximo_inicio": "2026-11-27",
  "slots": [{ "iso": "2026-11-21T12:00:00.000Z", "data": "2026-11-21", "hora": "09:00", "dia_semana": "sab" }] }
```

Psicologia usa a grade semanal `{"0":["09:00"],...}` (0=domingo) em horário de Fortaleza;
texto livre → `disponibilidade_estruturada:false` e nenhum slot (nunca inventa horários).

## Reserva

- `POST .../agendamento/criar*` valida horário futuro e ≤ 90 dias e revalida conflito
  **dentro de transação com `pg_advisory_xact_lock` por profissional** antes do INSERT.
- Psicologia: horário fora da grade semanal só gera log; `PSI_EXIGIR_SLOT_DISPONIBILIDADE=1` passa a recusar
  (o frontend atual gera horários no fuso do navegador — habilitar só após migrar para `/slots`).
- A resposta agora inclui `acessoToken` (aditivo).

## Status (polling) e privacidade

`GET .../agendamento/:id/status` sem prova de posse devolve apenas
`id, pagamento_status, status` + nome do profissional (e `formulario_url` de psicologia após pagamento).
Com `?token=<acessoToken>` / header `X-Agendamento-Token`, ou JWT do paciente dono,
devolve também horário, valor e tipo. Identificadores do gateway nunca são devolvidos.

## Especialidades "em breve"

`AGENDA_ESPECIALIDADES_EM_BREVE` (padrão `geriatria`): não lista, não gera slots e recusa reserva.

## Frontend (20/11/2026)

O checkout de Psicologia (`/psicologo-online` e `/psicologo-online/agendamentos`) passou a usar
`/api/psicologia/slots` em janelas de 14 dias (navegação até 90 dias, cache por janela, máx. 12
requisições por abertura do modal, ≥ 700 ms entre chamadas). Depois que esse frontend estiver no ar,
`PSI_EXIGIR_SLOT_DISPONIBILIDADE=1` pode ser habilitado.

## Recuperação de senha do especialista

`POST /api/especialista/esqueci-senha {email}` → sempre `{ok:true, message}` (não revela a conta).
Gera token aleatório (32 bytes), grava só o SHA-256 com validade de 60 min e envia
`<API_URL>/especialista/redefinir-senha#token=…` apenas ao e-mail da conta. **A senha atual não muda.**
Limites: rate limit de login por IP, 3 pedidos/15 min por e-mail, 1 e-mail a cada 2 min por conta.

`POST /api/especialista/redefinir-senha {token, novaSenha, confirmarSenha}` consome o token
(UPDATE atômico → uso único), exige senha de 8–128 caracteres, invalida o token após 5 erros e
limita 10 tentativas/15 min por IP. Sessões (JWT) emitidas antes da redefinição deixam de valer.
A página `GET /especialista/redefinir-senha` é servida pelo backend (sem dependências externas,
CSP restritiva), então o painel atual continua compatível sem alteração.

## Webhooks de pagamento

- `/api/pagbank/webhook` e `/api/renovacao/pagbank/webhook`: só confirmam após `GET /orders/:id`
  na API do PagBank. O fallback "atendimento pendente mais recente das últimas 2 h" foi substituído
  pelo `reference_id` do próprio pedido (`CJ-<id>-…` / `CJ-WA-<id>-…`).
- Webhooks Efí (principal e renovação) usam o mesmo parser documentado da psicologia/especialistas.
- Expiração do PIX (fila e WhatsApp) corrigida para 30 min reais.
- Trava de cobrança de cartão (psi/esp) agora também no banco (`cartao_lock_ate`, 180 s), válida
  entre instâncias.
