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
      CREATE TABLE IF NOT EXISTS prontuario_registros (
        atendimento_id BIGINT PRIMARY KEY,
        medico_id BIGINT,
        conteudo TEXT NOT NULL DEFAULT '',
        cliente_revisao BIGINT NOT NULL DEFAULT 0,
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE prontuario_registros
        ADD COLUMN IF NOT EXISTS cliente_revisao BIGINT NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS prontuario_eventos (
        id BIGSERIAL PRIMARY KEY,
        atendimento_id BIGINT NOT NULL,
        medico_id BIGINT,
        tipo TEXT NOT NULL,
        titulo TEXT,
        conteudo TEXT,
        origem_id TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_prontuario_eventos_atendimento_data
        ON prontuario_eventos (atendimento_id, criado_em DESC);

      CREATE UNIQUE INDEX IF NOT EXISTS ux_prontuario_evento_origem
        ON prontuario_eventos (atendimento_id, tipo, origem_id)
        WHERE origem_id IS NOT NULL AND origem_id <> '';
    `).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function bearer(req) {
  return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

async function authMedico(req, res, next) {
  try {
    const decoded = jwt.verify(bearer(req), process.env.JWT_SECRET || '');
    if (!decoded?.id || decoded?.tipo === 'paciente') {
      return res.status(401).json({ ok: false, error: 'Sessão inválida' });
    }
    const { rows } = await pool.query(
      'SELECT id,nome,nome_exibicao,email,crm,ativo FROM medicos WHERE id=$1 LIMIT 1',
      [Number(decoded.id)],
    );
    const medico = rows[0];
    if (!medico || medico.ativo === false) {
      return res.status(401).json({ ok: false, error: 'Sessão inválida' });
    }
    req.medico = medico;
    next();
  } catch {
    return res.status(401).json({ ok: false, error: 'Sessão expirada' });
  }
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

function validCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(cpf[i]) * (length + 1 - i);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanDate(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : '';
}

function isAdmin(medico) {
  return String(medico?.email || '').trim().toLowerCase() === ADMIN_EMAIL;
}

async function atendimentoAtualAutorizado(atendimentoId, medico) {
  const { rows } = await pool.query(`
    SELECT f.*
      FROM fila_atendimentos f
     WHERE f.id=$1
     LIMIT 1`, [Number(atendimentoId)]);
  const at = rows[0] || null;
  if (!at) return null;
  if (isAdmin(medico)) return at;
  if (Number(at.medico_id || 0) === Number(medico.id)) return at;
  return null;
}

function identitySignals(current, candidate) {
  const phone = normalizePhone(current.tel);
  const cpf = normalizeCpf(current.cpf);
  const name = normalizeName(current.nome);
  const dob = cleanDate(current.data_nascimento);

  const cPhone = normalizePhone(candidate.tel);
  const cCpf = normalizeCpf(candidate.cpf);
  const cName = normalizeName(candidate.nome);
  const cDob = cleanDate(candidate.data_nascimento);

  const phoneMatch = phone.length >= 10 && phone === cPhone;
  const cpfMatch = validCpf(cpf) && validCpf(cCpf) && cpf === cCpf;
  const nameMatch = name.length >= 5 && cName.length >= 5 && name === cName;
  const dobMatch = !!dob && !!cDob && dob === cDob;

  const thirdParty = !!current.atendimento_para_terceiro || !!candidate.atendimento_para_terceiro;
  // O cadastro legado pode reaproveitar nome/CPF pelo telefone. Para terceiro,
  // telefone e CPF também podem pertencer ao pagador, então só nome+nascimento vincula.
  const strong = thirdParty
    ? (nameMatch && dobMatch)
    : (cpfMatch || (nameMatch && dobMatch));

  const score = (cpfMatch ? 4 : 0) + (nameMatch ? 2 : 0) + (dobMatch ? 2 : 0) + (phoneMatch ? 1 : 0);
  return { phoneMatch, cpfMatch, nameMatch, dobMatch, strong, score, thirdPartyRule: thirdParty };
}

function resumoTriagem(row) {
  const parts = [];
  if (row.queixa) parts.push(String(row.queixa).trim());
  if (row.solicita) parts.push(`Solicita: ${String(row.solicita).trim()}`);
  return parts.filter(Boolean).join(' · ').slice(0, 700);
}

function install(app) {
  if (app.locals.__medicoPacienteLongitudinalInstalled) return;
  app.locals.__medicoPacienteLongitudinalInstalled = true;

  app.post('/api/medico/prontuario/espelho', express.json({ limit: '1mb' }), authMedico, async (req, res) => {
    try {
      await ensureSchema();
      const filaId = Number(req.body?.filaId);
      const prontuario = String(req.body?.prontuario ?? '').slice(0, 250000);
      const clientRevision = Number(req.body?.clientRevision);
      if (!filaId) return res.status(400).json({ ok: false, error: 'Atendimento inválido' });
      if (!Number.isSafeInteger(clientRevision) || clientRevision <= 0) {
        return res.status(400).json({ ok: false, error: 'Revisão do prontuário inválida' });
      }
      const at = await atendimentoAtualAutorizado(filaId, req.medico);
      if (!at) return res.status(403).json({ ok: false, error: 'Atendimento não autorizado' });

      const result = await pool.query(`
        INSERT INTO prontuario_registros (atendimento_id, medico_id, conteudo, cliente_revisao, atualizado_em)
        VALUES ($1,$2,$3,$4,NOW())
        ON CONFLICT (atendimento_id)
        DO UPDATE SET medico_id=EXCLUDED.medico_id, conteudo=EXCLUDED.conteudo,
                      cliente_revisao=EXCLUDED.cliente_revisao, atualizado_em=NOW()
          WHERE prontuario_registros.cliente_revisao <= EXCLUDED.cliente_revisao
        RETURNING cliente_revisao`,
      [filaId, req.medico.id, prontuario, clientRevision]);
      return res.json({ ok: true, aplicado: result.rowCount > 0, revisao: clientRevision });
    } catch (error) {
      console.error('[PRONTUARIO-ESPELHO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível espelhar o prontuário' });
    }
  });

  app.post('/api/medico/prontuario/evento', express.json({ limit: '1mb' }), authMedico, async (req, res) => {
    try {
      await ensureSchema();
      const filaId = Number(req.body?.filaId);
      const tipo = String(req.body?.tipo || '').trim().slice(0, 60);
      const titulo = String(req.body?.titulo || '').trim().slice(0, 300);
      const conteudo = String(req.body?.conteudo || '').trim().slice(0, 100000);
      const origemId = String(req.body?.origemId || '').trim().slice(0, 240) || null;
      const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
      if (!filaId || !tipo) return res.status(400).json({ ok: false, error: 'Evento inválido' });
      const at = await atendimentoAtualAutorizado(filaId, req.medico);
      if (!at) return res.status(403).json({ ok: false, error: 'Atendimento não autorizado' });

      const { rows } = await pool.query(`
        INSERT INTO prontuario_eventos
          (atendimento_id, medico_id, tipo, titulo, conteudo, origem_id, metadata, criado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT (atendimento_id, tipo, origem_id)
          WHERE origem_id IS NOT NULL AND origem_id <> ''
        DO NOTHING
        RETURNING id,criado_em`,
      [filaId, req.medico.id, tipo, titulo, conteudo, origemId, JSON.stringify(metadata)]);
      if (rows[0]) return res.json({ ok: true, evento: rows[0], reutilizado: false });
      const existing = origemId ? await pool.query(
        `SELECT id,criado_em FROM prontuario_eventos
          WHERE atendimento_id=$1 AND tipo=$2 AND origem_id=$3 LIMIT 1`,
        [filaId, tipo, origemId],
      ) : { rows: [] };
      return res.json({ ok: true, evento: existing.rows[0] || null, reutilizado: !!existing.rows[0] });
    } catch (error) {
      console.error('[PRONTUARIO-EVENTO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível registrar o evento' });
    }
  });

  app.get('/api/medico/paciente-contexto/:atendimentoId', authMedico, async (req, res) => {
    try {
      await ensureSchema();
      const atendimentoId = Number(req.params.atendimentoId);
      if (!atendimentoId) return res.status(400).json({ ok: false, error: 'Atendimento inválido' });

      const current = await atendimentoAtualAutorizado(atendimentoId, req.medico);
      if (!current) return res.status(403).json({ ok: false, error: 'Atendimento não autorizado' });

      const phone = normalizePhone(current.tel);
      const cpf = normalizeCpf(current.cpf);
      const dob = cleanDate(current.data_nascimento);

      const { rows: candidates } = await pool.query(`
        SELECT id,nome,tel,cpf,data_nascimento,tipo,status,queixa,solicita,triagem,prontuario,
               medico_id,medico_nome,documentos_emitidos,criado_em,assumido_em,encerrado_em,
               atendimento_para_terceiro,pagador_nome,pagador_cpf
          FROM fila_atendimentos
         WHERE id <> $1
           AND (encerrado_em IS NOT NULL OR LOWER(COALESCE(status,''))='encerrado')
           AND criado_em >= NOW() - INTERVAL '10 years'
           AND (
             ($2 <> '' AND RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11) = $2)
             OR ($3 <> '' AND regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $3)
             OR ($4 <> '' AND (
               LEFT(COALESCE(data_nascimento::text,''),10) = $4
               OR CASE
                    WHEN COALESCE(data_nascimento::text,'') ~ '^\\d{2}/\\d{2}/\\d{4}$'
                    THEN SUBSTRING(data_nascimento::text,7,4)||'-'||SUBSTRING(data_nascimento::text,4,2)||'-'||SUBSTRING(data_nascimento::text,1,2)
                    ELSE ''
                  END = $4
             ))
           )
         ORDER BY COALESCE(encerrado_em,assumido_em,criado_em) DESC
         LIMIT 120`,
        [atendimentoId, phone, cpf, dob],
      );

      const history = [];
      let samePhoneUnlinked = 0;
      for (const row of candidates) {
        const signals = identitySignals(current, row);
        if (signals.strong) {
          history.push({
            id: row.id, tipo: row.tipo, status: row.status, prontuario: row.prontuario,
            medico_id: row.medico_id, medico_nome: row.medico_nome,
            documentos_emitidos: row.documentos_emitidos, criado_em: row.criado_em,
            assumido_em: row.assumido_em, encerrado_em: row.encerrado_em,
            identidade: signals, resumo: resumoTriagem(row),
          });
        } else if (signals.phoneMatch) {
          samePhoneUnlinked += 1;
        }
      }
      history.sort((a, b) => {
        const da = new Date(a.encerrado_em || a.assumido_em || a.criado_em || 0).getTime();
        const db = new Date(b.encerrado_em || b.assumido_em || b.criado_em || 0).getTime();
        return db - da;
      });

      const historyIds = history.map((row) => Number(row.id)).filter(Boolean);
      let documents = [];
      let events = [];
      let mirrors = [];
      if (historyIds.length) {
        const docsResult = await pool.query(`
          SELECT m.id,m.atendimento_id,m.arquivo_url,m.arquivo_tipo,m.arquivo_nome,m.criado_em
            FROM mensagens m
           WHERE m.atendimento_id = ANY($1::bigint[])
             AND m.arquivo_url IS NOT NULL
             AND LOWER(COALESCE(m.arquivo_tipo,''))='pdf'
           ORDER BY m.criado_em DESC`, [historyIds]);
        documents = docsResult.rows;

        const evResult = await pool.query(`
          SELECT id,atendimento_id,medico_id,tipo,titulo,conteudo,origem_id,metadata,criado_em
            FROM prontuario_eventos
           WHERE atendimento_id = ANY($1::bigint[])
           ORDER BY criado_em DESC`, [historyIds]);
        events = evResult.rows;

        const mirrorResult = await pool.query(`
          SELECT atendimento_id,medico_id,conteudo,cliente_revisao,atualizado_em
            FROM prontuario_registros
           WHERE atendimento_id = ANY($1::bigint[])`, [historyIds]);
        mirrors = mirrorResult.rows;
      }

      const currentMirror = await pool.query(
        'SELECT conteudo,cliente_revisao,atualizado_em FROM prontuario_registros WHERE atendimento_id=$1 LIMIT 1',
        [atendimentoId],
      );
      const currentEvents = await pool.query(`
        SELECT id,tipo,titulo,conteudo,origem_id,metadata,criado_em
          FROM prontuario_eventos
         WHERE atendimento_id=$1
         ORDER BY criado_em DESC`, [atendimentoId]);

      return res.json({
        ok: true,
        paciente: {
          atendimento_id: current.id,
          nome: current.nome || '',
          cpf: current.cpf || '',
          tel: current.tel || '',
          tel_documentos: current.tel_documentos || '',
          data_nascimento: current.data_nascimento || '',
          atendimento_para_terceiro: !!current.atendimento_para_terceiro,
          pagador_nome: current.pagador_nome || '',
          pagador_cpf: current.pagador_cpf || '',
          triagem: current.triagem || '',
          queixa: current.queixa || '',
          solicita: current.solicita || '',
          alergias: current.alergias || '',
          cronicas: current.cronicas || '',
          medicacoes: current.medicacoes || '',
          idade: current.idade || '',
          sexo: current.sexo || '',
        },
        historico: history.slice(0, 40),
        documentos: documents,
        eventos: events,
        prontuarios_espelho: mirrors,
        atual: {
          prontuario_espelho: currentMirror.rows[0] || null,
          eventos: currentEvents.rows,
        },
        telefone_compartilhado_nao_vinculado: samePhoneUnlinked,
      });
    } catch (error) {
      console.error('[PACIENTE-CONTEXTO-MEDICO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar o histórico do paciente' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  install(this);
  return result;
};

export { cleanDate, identitySignals, validCpf };
