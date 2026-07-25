# Integração Memed

## Prescritores

O endpoint `GET /api/memed/token`, em `server.js`, localiza o médico ou
especialista autenticado e sincroniza o prescritor existente antes de devolver o
token. Criação e atualização enviam os mesmos campos obrigatórios:

- CRM (`board_number`);
- UF do CRM (`board_state`);
- CPF, somente dígitos;
- data de nascimento em `DD/MM/AAAA`.

As datas permanecem armazenadas no banco em `AAAA-MM-DD`. A conversão ocorre
somente no payload da Memed. Respostas `not_approved` ou dados regulatórios
ausentes impedem a abertura da prescrição e retornam uma mensagem operacional,
sem registrar CPF ou nascimento nos logs.

## Paciente e alergias

O painel consulta `GET /api/atendimento/:id/memed-context`, autenticado e
restrito ao médico vinculado. Para especialistas, usa
`GET /api/especialista/consulta/:id/memed-context`.

Esses endpoints:

1. formatam o nascimento do paciente como `DD/MM/AAAA`;
2. preservam o texto original de alergias no banco;
3. resolvem termos exatos pelo endpoint oficial de princípios ativos da Memed;
4. devolvem somente IDs confirmados para o comando `setAllergy`.

O painel aguarda `setPaciente` e `setAllergy` antes de abrir a prescrição. Termos
livres sem correspondência exata não são convertidos por aproximação; o médico
recebe um aviso para conferir o relato original.

## Backfill regulatório

O script é idempotente e não contém CPFs no repositório:

```bash
npm run memed:backfill -- --file /caminho/privado/prescritores.json
```

Formato do arquivo:

```json
[
  {
    "nome": "Nome completo no cadastro",
    "email": "opcional@exemplo.com",
    "cpf": "00000000000",
    "data_nascimento": "DD/MM/AAAA"
  }
]
```

Também é possível fornecer a lista em `MEMED_REGULATORY_BACKFILL_JSON`. O script
usa `DATABASE_URL`, `MEMED_API_URL`, `MEMED_API_KEY` e `MEMED_SECRET_KEY`.
Para atualizar somente o banco, sem chamar a Memed, acrescente
`--database-only`.

João Vitor Estanislau Reis e Gabriel Angelo são ignorados explicitamente pelo
script nesta etapa.
