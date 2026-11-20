-- ─────────────────────────────────────────────────────────────────────────────
-- Dr. Paulo Almeida — preço da consulta para R$ 250,00
-- NÃO EXECUTADO AUTOMATICAMENTE. Rodar manualmente, com revisão humana:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/paulo-almeida-preco-250.sql
--
-- Escopo: SOMENTE o cadastro ATIVO id 10. O cadastro INATIVO id 2 não é tocado
-- (o WHERE fixa id = 10 e a verificação final aborta se o id 2 mudar).
-- Idempotente: rodar de novo não altera nada (valor já 250 → 0 linhas).
-- Agendamentos já criados mantêm o valor_cobrado da época (a cobrança usa
-- agendamentos_especialistas.valor_cobrado); só novas reservas usam R$ 250.
-- Obs.: o UPDATE automático de boot (350 → 230) foi removido do server.js.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1) Diagnóstico (somente leitura)
SELECT id, nome_exibicao, especialidade, ativo, visivel, valor_consulta
  FROM especialistas
 WHERE id IN (2, 10)
    OR LOWER(COALESCE(nome_exibicao, nome, '')) LIKE '%paulo%almeida%'
 ORDER BY id;

-- 2) Ajuste atômico com travas de segurança
BEGIN;

CREATE TEMP TABLE _paulo_id2_antes ON COMMIT DROP AS
  SELECT id, valor_consulta, ativo, visivel FROM especialistas WHERE id = 2;

DO $$
DECLARE
  n INTEGER;
  alvo RECORD;
BEGIN
  SELECT id, ativo, nome_exibicao, nome, valor_consulta INTO alvo
    FROM especialistas WHERE id = 10 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Especialista id 10 não encontrado — nada alterado.';
  END IF;
  IF alvo.ativo IS NOT TRUE THEN
    RAISE EXCEPTION 'Especialista id 10 não está ativo — nada alterado.';
  END IF;
  IF LOWER(COALESCE(alvo.nome_exibicao, alvo.nome, '')) NOT LIKE '%paulo%almeida%' THEN
    RAISE EXCEPTION 'id 10 não corresponde ao Dr. Paulo Almeida — nada alterado.';
  END IF;

  UPDATE especialistas
     SET valor_consulta = 250
   WHERE id = 10
     AND ativo = true
     AND valor_consulta IS DISTINCT FROM 250;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 1 THEN
    RAISE EXCEPTION 'Mais de uma linha afetada (%) — abortado.', n;
  END IF;
  RAISE NOTICE 'Dr. Paulo Almeida (id 10): % linha(s) atualizada(s) para R$ 250 (antes: %).', n, alvo.valor_consulta;
END $$;

-- Garante que o cadastro inativo id 2 ficou intacto.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM especialistas e JOIN _paulo_id2_antes a ON a.id = e.id
     WHERE e.valor_consulta IS DISTINCT FROM a.valor_consulta
        OR e.ativo IS DISTINCT FROM a.ativo
        OR e.visivel IS DISTINCT FROM a.visivel
  ) THEN
    RAISE EXCEPTION 'Cadastro id 2 foi alterado — abortado.';
  END IF;
END $$;

COMMIT;

-- 3) Conferência
SELECT id, nome_exibicao, ativo, valor_consulta FROM especialistas WHERE id IN (2, 10) ORDER BY id;
