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

-- 3) Proposta mínima — SOMENTE se a consulta 1 mostrar ativo=false/visivel=false
--    E a médica tiver confirmado que deve aparecer no site. Ajuste o id.
-- BEGIN;
-- UPDATE especialistas
--    SET ativo = true, visivel = true
--  WHERE id = <ID_DA_DRA_DANIELLE>
--    AND LOWER(especialidade) = 'dermatologia';
-- -- Conferir 1 linha afetada antes do COMMIT.
-- COMMIT;

-- 4) Agenda — SOMENTE com horários confirmados pela médica (UTC; Fortaleza = UTC-3).
--    Ex.: 18:00 em Fortaleza = 21:00Z. Preferível usar o painel do especialista
--    ou PATCH /api/admin/especialista/:id/disponibilidade (valida tamanho).
-- UPDATE especialistas
--    SET disponibilidade = '[ "<ISO_UTC_CONFIRMADO_1>", "<ISO_UTC_CONFIRMADO_2>" ]'::jsonb
--  WHERE id = <ID_DA_DRA_DANIELLE>;
