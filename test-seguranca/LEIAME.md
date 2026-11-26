# Teste de permissões (dados fictícios)

Sobe o backend apontando para um Postgres local com `schema-ficticio.sql`
(apenas pacientes, médicos e atendimentos inventados) e roda tentativas de
acesso com tokens de cada perfil.

1. Postgres local com SSL na porta 55432 e banco `sectest_local`
   carregado com `schema-ficticio.sql`.
2. `DATABASE_URL=... JWT_SECRET=segredo-de-teste-ficticio OPENAI_API_KEY=x node --import ... server.js`
3. `node test-seguranca/permissoes.mjs http://localhost:PORTA`

Resultado esperado: só os tokens de médico ativo e vinculado passam nas
rotas médicas; paciente, psicólogo, especialista e links recebem 401/403.
Nunca rode contra produção.
