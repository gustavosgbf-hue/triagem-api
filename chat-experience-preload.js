import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

let schemaPromise;
function ensureChatSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS reply_to_id BIGINT;
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS lido_paciente_em TIMESTAMPTZ;
      ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS lido_medico_em TIMESTAMPTZ;
      CREATE INDEX IF NOT EXISTS idx_mensagens_reply_to_id ON mensagens(reply_to_id);
    `).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
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

function authPaciente(req, res, next) {
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return res.status(401).json({ ok: false, error: 'Token não fornecido' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || '');
    if (decoded?.tipo !== 'paciente' || !decoded?.id) {
      return res.status(401).json({ ok: false, error: 'Token inválido' });
    }
    req.pacienteId = Number(decoded.id);
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
}

async function pacienteAtual(id) {
  const { rows } = await pool.query(
    'SELECT id, nome, email, cpf, tel FROM pacientes WHERE id=$1 LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function atendimentoDoPaciente(pacienteId, atendimentoId) {
  const paciente = await pacienteAtual(pacienteId);
  if (!paciente) return null;
  const cpf = normalizeCpf(paciente.cpf);
  const phone = normalizePhone(paciente.tel);
  if (cpf.length !== 11 || phone.length < 10) return null;

  const { rows } = await pool.query(
    `SELECT f.*
       FROM fila_atendimentos f
      WHERE f.id=$1
        AND (
          regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''), '\\D', '', 'g') = $2
          OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''), '\\D', '', 'g') = $2
        )
        AND RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11) = $3
      LIMIT 1`,
    [atendimentoId, cpf, phone],
  );
  return rows[0] || null;
}

function installChatExperience(app) {
  if (app.locals.__chatExperienceInstalled) return;
  app.locals.__chatExperienceInstalled = true;

  // Mantém o endpoint legado do painel, mas devolve também os metadados de
  // resposta/visualização. Como este preload é registrado antes do server.js,
  // esta rota atende o painel sem exigir mudanças no contrato existente.
  app.get('/api/chat/:atendimentoId', async (req, res, next) => {
    try {
      await ensureChatSchema();
      const atendimentoId = Number(req.params.atendimentoId);
      if (!atendimentoId) return next();

      const raw = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
      let decoded = null;
      if (raw) {
        try { decoded = jwt.verify(raw, process.env.JWT_SECRET || ''); } catch {}
      }

      let autorizado = !!decoded;
      if (!autorizado) {
        const check = await pool.query('SELECT id FROM fila_atendimentos WHERE id=$1', [atendimentoId]);
        autorizado = check.rowCount > 0;
      }
      if (!autorizado) return res.status(403).json({ ok: false, error: 'Acesso negado' });

      if (decoded?.id && decoded?.tipo !== 'paciente') {
        await pool.query(
          `UPDATE mensagens
              SET lido_medico_em = COALESCE(lido_medico_em, NOW())
            WHERE atendimento_id=$1 AND autor='paciente'`,
          [atendimentoId],
        );
      }

      const { rows } = await pool.query(
        `SELECT id, atendimento_id, autor, texto, arquivo_url, arquivo_tipo, arquivo_nome,
                criado_em, reply_to_id, lido_paciente_em, lido_medico_em
           FROM mensagens
          WHERE atendimento_id=$1
          ORDER BY criado_em ASC, id ASC`,
        [atendimentoId],
      );
      return res.json({ ok: true, mensagens: rows });
    } catch (error) {
      console.error('[CHAT-LEGACY-V2]', error);
      return next();
    }
  });

  app.get('/api/paciente/atendimento/:id/chat-v2', authPaciente, async (req, res) => {
    try {
      await ensureChatSchema();
      const atendimentoId = Number(req.params.id);
      if (!atendimentoId) return res.status(400).json({ ok: false, error: 'Atendimento inválido' });
      const atendimento = await atendimentoDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado' });

      await pool.query(
        `UPDATE mensagens
            SET lido_paciente_em = COALESCE(lido_paciente_em, NOW())
          WHERE atendimento_id=$1 AND autor='medico'`,
        [atendimentoId],
      );

      const { rows } = await pool.query(
        `SELECT id, atendimento_id, autor, texto, arquivo_url, arquivo_tipo, arquivo_nome,
                criado_em, reply_to_id, lido_paciente_em, lido_medico_em
           FROM mensagens
          WHERE atendimento_id=$1
          ORDER BY criado_em ASC, id ASC`,
        [atendimentoId],
      );

      return res.json({
        ok: true,
        atendimento: {
          id: atendimento.id,
          status: atendimento.status,
          medico_nome: atendimento.medico_nome || null,
        },
        mensagens: rows,
      });
    } catch (error) {
      console.error('[CHAT-V2-GET]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar a conversa.' });
    }
  });

  app.post('/api/paciente/atendimento/:id/chat-v2', express.json({ limit: '1mb' }), authPaciente, async (req, res) => {
    try {
      await ensureChatSchema();
      const atendimentoId = Number(req.params.id);
      const texto = String(req.body?.texto || '').trim().slice(0, 3000);
      const replyToId = req.body?.reply_to_id ? Number(req.body.reply_to_id) : null;
      if (!atendimentoId || !texto) return res.status(400).json({ ok: false, error: 'Mensagem vazia' });

      const atendimento = await atendimentoDoPaciente(req.pacienteId, atendimentoId);
      if (!atendimento) return res.status(404).json({ ok: false, error: 'Atendimento não encontrado' });
      if (String(atendimento.status || '').toLowerCase() !== 'assumido' || !atendimento.medico_id) {
        return res.status(409).json({ ok: false, error: 'Este atendimento não está mais disponível para novas mensagens.' });
      }

      if (replyToId) {
        const alvo = await pool.query(
          'SELECT id FROM mensagens WHERE id=$1 AND atendimento_id=$2 LIMIT 1',
          [replyToId, atendimentoId],
        );
        if (!alvo.rowCount) return res.status(400).json({ ok: false, error: 'Mensagem respondida não encontrada.' });
      }

      const { rows } = await pool.query(
        `INSERT INTO mensagens
          (atendimento_id, autor, autor_id, texto, arquivo_url, arquivo_tipo, reply_to_id)
         VALUES ($1, 'paciente', $2, $3, NULL, NULL, $4)
         RETURNING id, atendimento_id, autor, texto, arquivo_url, arquivo_tipo, arquivo_nome,
                   criado_em, reply_to_id, lido_paciente_em, lido_medico_em`,
        [atendimentoId, req.pacienteId, texto, replyToId],
      );
      return res.json({ ok: true, mensagem: rows[0] });
    } catch (error) {
      console.error('[CHAT-V2-SEND]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível enviar a mensagem.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedChatExperienceInit(...args) {
  const result = originalInit.apply(this, args);
  installChatExperience(this);
  return result;
};
