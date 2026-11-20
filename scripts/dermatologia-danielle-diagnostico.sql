-- ─────────────────────────────────────────────────────────────────────────────
-- Dermatologia — Dra. Danielle Lourdes: diagnóstico + proposta mínima
-- NÃO EXECUTADO AUTOMATICAMENTE. Rodar manualmente, com revisão humana.
--
-- Contexto (código):
--   * GET /api/especialistas/dermatologia lista quem tem
--       LOWER(especialidade)='dermatologia' AND ativo AND (visivel OR visivel IS NULL)
--   * Horários vêm SOMENTE de especialistas.disponibilidade (JSONB, lista de
--     instantes ISO-8601 em UTC). O backend filtra passado, > 90 dias e ocupados.
--   * O seed original (scripts/seed-danielle-lourdes.sql) só tinha horários de
--     23/05/2026 a 18/06/2026 — todos no passado hoje. Sem novos horários
--     informados pela médica, o card aparece com "Consultar disponibilidade".
--   * NUNCA inventar horários: só preencher com a agenda confirmada pela médica.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Cadastro (somente leitura)
SELECT id, nome_exibicao, especialidade, ativo, visivel, valor_consulta,
       (senha_hash IS NOT NULL) AS tem_senha,
       jsonb_typeof(disponibilidade) AS tipo_disp,
       CASE WHEN jsonb_typeof(disponibilidade) = 'array'
            THEN jsonb_array_length(disponibilidade) END AS qtd_itens
  FROM especialistas
 WHERE LOWER(email) = LOWER('danilurdess@hotmail.com')
    OR LOWER(especialidade) = 'dermatologia'
 ORDER BY id;

-- 2) Horários FUTUROS cadastrados (até 90 dias) — se vier 0, não há o que publicar
SELECT e.id, COUNT(*) AS horarios_futuros_90d, MIN(t.ts) AS primeiro, MAX(t.ts) AS ultimo
  FROM especialistas e
  CROSS JOIN LATERAL jsonb_array_elements_text(
       CASE WHEN jsonb_typeof(e.disponibilidade) = 'array' THEN e.disponibilidade ELSE '[]'::jsonb END
  ) AS x(v)
  CROSS JOIN LATERAL (
       SELECT CASE WHEN x.v ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}' THEN x.v::timestamptz END AS ts
  ) AS t
 WHERE LOWER(e.especialidade) = 'dermatologia'
   AND t.ts > NOW()
   AND t.ts <= NOW() + INTERVAL '90 days'
 GROUP BY e.id;

-- 3) Situação atual (20/11/2026): cadastro JÁ ATIVO no banco, agenda antiga
--    (todos os horários do seed estão no passado). NÃO é preciso ativar nada.
--    Resultado esperado no site: card visível com "Consultar disponibilidade"
--    e /api/especialistas/slots/:id devolvendo slots = [] (nenhum horário inventado).

-- 3a) Agendamentos existentes (somente leitura, sem dados pessoais)
SELECT a.id, a.horario_agendado, a.pagamento_status, a.status
  FROM agendamentos_especialistas a
  JOIN especialistas e ON e.id = a.especialista_id
 WHERE LOWER(e.especialidade) = 'dermatologia'
   AND a.horario_agendado > NOW() - INTERVAL '30 days'
 ORDER BY a.horario_agendado;

-- 4) Agenda nova — SOMENTE com grade CONFIRMADA PELA MÉDICA (dias/horários).
--    Proposta: gerar instantes a partir da grade confirmada para as próximas
--    semanas (máx. 90 dias), em horário de Fortaleza, convertendo para UTC.
--    Preencher os placeholders e rodar em transação; conferir antes do COMMIT.
--    Atenção: ESP_DURACAO_MIN (padrão 60) define o bloqueio de conflito; se a
--    consulta dela for de 30 min, ajustar a variável de ambiente antes de
--    publicar horários de 30 em 30 min (senão um horário ocupa o seguinte).
--
-- BEGIN;
-- WITH grade(dow, hora) AS (
--   VALUES  -- dow: 0=domingo … 6=sábado; hora local de Fortaleza
--     (<DOW_CONFIRMADO>, TIME '<HH:MM_CONFIRMADO>')
--  -- , (<DOW>, TIME '<HH:MM>')
-- ),
-- dias AS (
--   SELECT d::date AS dia
--     FROM generate_series((NOW() AT TIME ZONE 'America/Fortaleza')::date + 1,
--                          (NOW() AT TIME ZONE 'America/Fortaleza')::date + <SEMANAS_CONFIRMADAS> * 7,
--                          INTERVAL '1 day') AS d
-- ),
-- instantes AS (
--   SELECT ((dias.dia + grade.hora) AT TIME ZONE 'America/Fortaleza') AS ts
--     FROM dias JOIN grade ON EXTRACT(DOW FROM dias.dia) = grade.dow
--    WHERE (dias.dia + grade.hora) AT TIME ZONE 'America/Fortaleza' <= NOW() + INTERVAL '90 days'
-- )
-- UPDATE especialistas
--    SET disponibilidade = (
--      SELECT COALESCE(jsonb_agg(to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS".000Z"') ORDER BY ts), '[]'::jsonb)
--        FROM instantes)
--  WHERE id = <ID_DA_DRA_DANIELLE>
--    AND LOWER(especialidade) = 'dermatologia'
--  RETURNING id, jsonb_array_length(disponibilidade) AS qtd;
-- -- Conferir 1 linha e a quantidade; depois COMMIT (ou ROLLBACK).
-- COMMIT;
--
-- Alternativa sem SQL: a própria médica cadastra pelo painel do especialista
-- (PATCH /api/especialista/disponibilidade) ou o admin via
-- PATCH /api/admin/especialista/:id/disponibilidade (valida tamanho).
