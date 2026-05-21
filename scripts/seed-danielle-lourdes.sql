-- ─────────────────────────────────────────────────────────────────────────────
-- Seed: Dra. Danielle Lourdes — Dermatologia (telemedicina)
-- Executar UMA VEZ contra o banco do Render (DATABASE_URL)
--
-- Como executar:
--   psql "$DATABASE_URL" -f scripts/seed-danielle-lourdes.sql
--
-- Após o card aparecer na landing, atualizar a foto:
--   UPDATE especialistas
--      SET foto_url = 'https://URL_DA_FOTO_NO_R2'
--    WHERE email = 'danilurdess@hotmail.com';
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM especialistas WHERE email = 'danilurdess@hotmail.com') THEN
    RAISE NOTICE 'Especialista já cadastrada — nenhuma alteração feita.';
  ELSE

    INSERT INTO especialistas (
      nome,
      nome_exibicao,
      especialidade,
      crm,
      rqe,
      uf,
      valor_consulta,
      email,
      bio,
      foto_url,
      ativo,
      visivel,
      disponibilidade
    ) VALUES (
      'Danielle Lourdes',
      'Dra. Danielle Lourdes',
      'dermatologia',
      '271705',
      NULL,
      'SP',
      150.00,
      'danilurdess@hotmail.com',
      'Sou médica, formada pela Faculdade IMEPAC, em Minas Gerais, com CRM-SP 271705. Atualmente, sou pós-graduanda em Dermatologia pela Associação Pele Saudável, em São Paulo, e curso fellow em Cosmiatria pela Faculdade Boggio.

Atuo com um olhar individualizado e humanizado, acompanhando pacientes desde a infância até a vida adulta, oferecendo desde orientações e cuidados básicos com a pele até o diagnóstico e tratamento de doenças dermatológicas e manifestações cutâneas associadas a doenças sistêmicas.

Meu objetivo é unir conhecimento científico, atualização constante e cuidado atento para promover saúde, autoestima e bem-estar através da dermatologia.',
      '',
      true,
      true,
      -- Disponibilidade: Terça e Quinta 18h–20h (BRT) | Sábado 9h–11h30 (BRT)
      -- Próximas 4 semanas a partir de 2026-05-21 — renovar mensalmente
      '[
        "2026-05-23T12:00:00.000Z",
        "2026-05-23T12:30:00.000Z",
        "2026-05-23T13:00:00.000Z",
        "2026-05-23T13:30:00.000Z",
        "2026-05-23T14:00:00.000Z",
        "2026-05-23T14:30:00.000Z",
        "2026-05-26T21:00:00.000Z",
        "2026-05-26T21:30:00.000Z",
        "2026-05-26T22:00:00.000Z",
        "2026-05-26T22:30:00.000Z",
        "2026-05-26T23:00:00.000Z",
        "2026-05-28T21:00:00.000Z",
        "2026-05-28T21:30:00.000Z",
        "2026-05-28T22:00:00.000Z",
        "2026-05-28T22:30:00.000Z",
        "2026-05-28T23:00:00.000Z",
        "2026-05-30T12:00:00.000Z",
        "2026-05-30T12:30:00.000Z",
        "2026-05-30T13:00:00.000Z",
        "2026-05-30T13:30:00.000Z",
        "2026-05-30T14:00:00.000Z",
        "2026-05-30T14:30:00.000Z",
        "2026-06-02T21:00:00.000Z",
        "2026-06-02T21:30:00.000Z",
        "2026-06-02T22:00:00.000Z",
        "2026-06-02T22:30:00.000Z",
        "2026-06-02T23:00:00.000Z",
        "2026-06-04T21:00:00.000Z",
        "2026-06-04T21:30:00.000Z",
        "2026-06-04T22:00:00.000Z",
        "2026-06-04T22:30:00.000Z",
        "2026-06-04T23:00:00.000Z",
        "2026-06-06T12:00:00.000Z",
        "2026-06-06T12:30:00.000Z",
        "2026-06-06T13:00:00.000Z",
        "2026-06-06T13:30:00.000Z",
        "2026-06-06T14:00:00.000Z",
        "2026-06-06T14:30:00.000Z",
        "2026-06-09T21:00:00.000Z",
        "2026-06-09T21:30:00.000Z",
        "2026-06-09T22:00:00.000Z",
        "2026-06-09T22:30:00.000Z",
        "2026-06-09T23:00:00.000Z",
        "2026-06-11T21:00:00.000Z",
        "2026-06-11T21:30:00.000Z",
        "2026-06-11T22:00:00.000Z",
        "2026-06-11T22:30:00.000Z",
        "2026-06-11T23:00:00.000Z",
        "2026-06-13T12:00:00.000Z",
        "2026-06-13T12:30:00.000Z",
        "2026-06-13T13:00:00.000Z",
        "2026-06-13T13:30:00.000Z",
        "2026-06-13T14:00:00.000Z",
        "2026-06-13T14:30:00.000Z",
        "2026-06-16T21:00:00.000Z",
        "2026-06-16T21:30:00.000Z",
        "2026-06-16T22:00:00.000Z",
        "2026-06-16T22:30:00.000Z",
        "2026-06-16T23:00:00.000Z",
        "2026-06-18T21:00:00.000Z",
        "2026-06-18T21:30:00.000Z",
        "2026-06-18T22:00:00.000Z",
        "2026-06-18T22:30:00.000Z",
        "2026-06-18T23:00:00.000Z"
      ]'::jsonb
    );

    RAISE NOTICE 'Dra. Danielle Lourdes cadastrada com sucesso (64 slots — Ter/Qui 18h-20h | Sáb 9h-11h30 BRT).';
    RAISE NOTICE 'Lembrete: atualizar foto_url após upload no R2.';
  END IF;
END $$;
