import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const ADMIN_EMAIL = 'gustavosgbf@gmail.com';
let schemaReady;

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS avaliacoes_medicos (
        id BIGSERIAL PRIMARY KEY,
        atendimento_id BIGINT NOT NULL UNIQUE,
        medico_id BIGINT NOT NULL,
        paciente_id BIGINT,
        estrelas SMALLINT NOT NULL CHECK (estrelas BETWEEN 1 AND 5),
        comentario TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_avaliacoes_medicos_medico_data
        ON avaliacoes_medicos (medico_id, criado_em DESC);
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhone(value) {
  let n = digits(value);
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  return n.slice(-11);
}

function normalizeCpf(value) {
  return digits(value).slice(0, 11);
}

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function authPaciente(req, res, next) {
  try {
    const decoded = jwt.verify(bearer(req), process.env.JWT_SECRET || '');
    if (decoded?.tipo !== 'paciente' || !decoded?.id) return res.status(401).json({ ok: false, error: 'Sessão inválida' });
    req.pacienteId = Number(decoded.id);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
}

async function authAdmin(req, res, next) {
  try {
    const decoded = jwt.verify(bearer(req), process.env.JWT_SECRET || '');
    if (!decoded?.id || decoded?.tipo === 'paciente') return res.status(401).json({ ok: false, error: 'Sessão inválida' });
    const { rows } = await pool.query('SELECT id,email FROM medicos WHERE id=$1 LIMIT 1', [Number(decoded.id)]);
    const medico = rows[0];
    if (!medico || String(medico.email || '').trim().toLowerCase() !== ADMIN_EMAIL) {
      return res.status(403).json({ ok: false, error: 'Acesso restrito ao administrador' });
    }
    req.adminId = Number(medico.id);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
}

async function pacienteAtual(id) {
  const { rows } = await pool.query('SELECT id,cpf,tel FROM pacientes WHERE id=$1 LIMIT 1', [id]);
  return rows[0] || null;
}

async function atendimentoAvaliavelDoPaciente(pacienteId, atendimentoId) {
  const paciente = await pacienteAtual(pacienteId);
  if (!paciente) return null;
  const cpf = normalizeCpf(paciente.cpf);
  const phone = normalizePhone(paciente.tel);
  if (cpf.length !== 11 || phone.length < 10) return null;

  const { rows } = await pool.query(`
    SELECT f.*
      FROM fila_atendimentos f
     WHERE f.id=$1
       AND NULLIF(to_jsonb(f)->>'medico_id','') IS NOT NULL
       AND COALESCE(LOWER(to_jsonb(f)->>'status'),'') IN ('encerrado','finalizado','finalizada','concluido','concluído','arquivado')
       AND COALESCE(to_jsonb(f)->>'tipo','') NOT LIKE 'renovacao_%'
       AND (
         regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $2
         OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $2
       )
       AND RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $3
     LIMIT 1`, [atendimentoId, cpf, phone]);
  return rows[0] || null;
}

function parseDate(value, end = false) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  return `${text}T${end ? '23:59:59.999' : '00:00:00.000'}-03:00`;
}

function install(app) {
  if (app.locals.__avaliacoesMedicosInstalled) return;
  app.locals.__avaliacoesMedicosInstalled = true;

  app.get('/api/paciente/atendimento/:id/avaliacao', authPaciente, async (req, res) => {
    try {
      await ensureSchema();
      const atendimentoId = Number(req.params.id);
      const atendimento = await atendimentoAvaliavelDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.json({ ok: true, avaliavel: false, avaliacao: null });
      const { rows } = await pool.query(
        'SELECT estrelas,comentario,criado_em,atualizado_em FROM avaliacoes_medicos WHERE atendimento_id=$1 LIMIT 1',
        [atendimentoId],
      );
      return res.json({
        ok: true,
        avaliavel: true,
        medico: { id: Number(atendimento.medico_id), nome: atendimento.medico_nome || 'Médico' },
        avaliacao: rows[0] || null,
      });
    } catch (error) {
      console.error('[AVALIACAO-PACIENTE-GET]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar a avaliação.' });
    }
  });

  app.post('/api/paciente/atendimento/:id/avaliacao', express.json({ limit: '32kb' }), authPaciente, async (req, res) => {
    try {
      await ensureSchema();
      const atendimentoId = Number(req.params.id);
      const estrelas = Number(req.body?.estrelas);
      const comentario = String(req.body?.comentario || '').trim().slice(0, 600) || null;
      if (!Number.isInteger(estrelas) || estrelas < 1 || estrelas > 5) {
        return res.status(400).json({ ok: false, error: 'Escolha de 1 a 5 estrelas.' });
      }
      const atendimento = await atendimentoAvaliavelDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.status(403).json({ ok: false, error: 'Este atendimento não pode ser avaliado.' });

      const { rows } = await pool.query(`
        INSERT INTO avaliacoes_medicos (atendimento_id,medico_id,paciente_id,estrelas,comentario)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (atendimento_id) DO UPDATE
          SET estrelas=EXCLUDED.estrelas,
              comentario=EXCLUDED.comentario,
              atualizado_em=NOW()
        RETURNING estrelas,comentario,criado_em,atualizado_em`,
        [atendimentoId, Number(atendimento.medico_id), req.pacienteId, estrelas, comentario],
      );
      return res.json({ ok: true, avaliacao: rows[0] });
    } catch (error) {
      console.error('[AVALIACAO-PACIENTE-POST]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível salvar sua avaliação.' });
    }
  });

  app.get('/api/admin/avaliacoes-medicos', authAdmin, async (req, res) => {
    try {
      await ensureSchema();
      const inicio = parseDate(req.query.inicio);
      const fim = parseDate(req.query.fim, true);
      const medicoId = Number(req.query.medico_id || 0) || null;
      const params = [inicio, fim, medicoId];

      const medicosQuery = await pool.query(`
        SELECT id,nome,email,crm
          FROM medicos
         WHERE COALESCE(LOWER(to_jsonb(medicos)->>'ativo'),'true') <> 'false'
         ORDER BY nome ASC`);

      const resumoQuery = await pool.query(`
        WITH consultas AS (
          SELECT
            NULLIF(to_jsonb(f)->>'medico_id','')::bigint AS medico_id,
            COUNT(*)::int AS consultas
          FROM fila_atendimentos f
          WHERE NULLIF(to_jsonb(f)->>'medico_id','') IS NOT NULL
            AND COALESCE(to_jsonb(f)->>'tipo','') NOT LIKE 'renovacao_%'
            AND COALESCE(LOWER(to_jsonb(f)->>'status'),'') IN ('encerrado','finalizado','finalizada','concluido','concluído','arquivado')
            AND ($1::timestamptz IS NULL OR COALESCE(NULLIF(to_jsonb(f)->>'encerrado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'finalizado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz) >= $1)
            AND ($2::timestamptz IS NULL OR COALESCE(NULLIF(to_jsonb(f)->>'encerrado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'finalizado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz) <= $2)
            AND ($3::bigint IS NULL OR NULLIF(to_jsonb(f)->>'medico_id','')::bigint=$3)
          GROUP BY 1
        ), notas AS (
          SELECT medico_id,
                 COUNT(*)::int AS avaliacoes,
                 ROUND(AVG(estrelas)::numeric,2) AS media,
                 COUNT(*) FILTER (WHERE estrelas=1)::int AS estrela_1,
                 COUNT(*) FILTER (WHERE estrelas=2)::int AS estrela_2,
                 COUNT(*) FILTER (WHERE estrelas=3)::int AS estrela_3,
                 COUNT(*) FILTER (WHERE estrelas=4)::int AS estrela_4,
                 COUNT(*) FILTER (WHERE estrelas=5)::int AS estrela_5
            FROM avaliacoes_medicos
           WHERE ($1::timestamptz IS NULL OR criado_em >= $1)
             AND ($2::timestamptz IS NULL OR criado_em <= $2)
             AND ($3::bigint IS NULL OR medico_id=$3)
           GROUP BY medico_id
        )
        SELECT m.id,m.nome,m.email,m.crm,
               COALESCE(c.consultas,0)::int AS consultas,
               COALESCE(n.avaliacoes,0)::int AS avaliacoes,
               n.media,
               CASE WHEN COALESCE(c.consultas,0)>0 THEN ROUND((COALESCE(n.avaliacoes,0)::numeric/c.consultas::numeric)*100,1) ELSE 0 END AS taxa_resposta,
               COALESCE(n.estrela_1,0)::int AS estrela_1,
               COALESCE(n.estrela_2,0)::int AS estrela_2,
               COALESCE(n.estrela_3,0)::int AS estrela_3,
               COALESCE(n.estrela_4,0)::int AS estrela_4,
               COALESCE(n.estrela_5,0)::int AS estrela_5
          FROM medicos m
          LEFT JOIN consultas c ON c.medico_id=m.id
          LEFT JOIN notas n ON n.medico_id=m.id
         WHERE COALESCE(LOWER(to_jsonb(m)->>'ativo'),'true') <> 'false'
           AND ($3::bigint IS NULL OR m.id=$3)
         ORDER BY COALESCE(n.media,0) DESC, m.nome ASC`, params);

      const detalhesQuery = await pool.query(`
        SELECT a.id,a.atendimento_id,a.medico_id,m.nome AS medico_nome,
               f.nome AS paciente_nome,a.estrelas,a.comentario,a.criado_em,a.atualizado_em,
               COALESCE(NULLIF(to_jsonb(f)->>'encerrado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'finalizado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz) AS atendimento_em
          FROM avaliacoes_medicos a
          JOIN medicos m ON m.id=a.medico_id
          JOIN fila_atendimentos f ON f.id=a.atendimento_id
         WHERE ($1::timestamptz IS NULL OR a.criado_em >= $1)
           AND ($2::timestamptz IS NULL OR a.criado_em <= $2)
           AND ($3::bigint IS NULL OR a.medico_id=$3)
         ORDER BY a.criado_em DESC
         LIMIT 1000`, params);

      return res.json({
        ok: true,
        medicos: medicosQuery.rows,
        resumo: resumoQuery.rows,
        avaliacoes: detalhesQuery.rows,
      });
    } catch (error) {
      console.error('[AVALIACOES-ADMIN]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar as avaliações.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedAvaliacaoInit(...args) {
  const result = originalInit.apply(this, args);
  install(this);
  return result;
};
