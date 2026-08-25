import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const JSON_BODY = express.json({ limit: '32kb' });

function authPaciente(req, res, next) {
  try {
    const raw = String(req.headers.authorization || '');
    const token = raw.replace(/^Bearer\s+/i, '').trim();
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

function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function normalizeBirthDate(value) {
  const text = String(value || '').trim();
  let year;
  let month;
  let day;

  const br = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (br) {
    day = Number(br[1]);
    month = Number(br[2]);
    year = Number(br[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    return '';
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getTime() > Date.now()
  ) return '';

  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

let profileReadyPromise;
function ensureProfileSchema() {
  if (!profileReadyPromise) {
    profileReadyPromise = pool.query(`ALTER TABLE pacientes ADD COLUMN IF NOT EXISTS data_nascimento TEXT`)
      .catch((error) => {
        profileReadyPromise = null;
        throw error;
      });
  }
  return profileReadyPromise;
}

let deletionReadyPromise;
function ensureDeletionSchema() {
  if (!deletionReadyPromise) {
    deletionReadyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS patient_account_deletion_requests (
        id BIGSERIAL PRIMARY KEY,
        patient_id BIGINT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).catch((error) => {
      deletionReadyPromise = null;
      throw error;
    });
  }
  return deletionReadyPromise;
}

async function getPatient(id) {
  await ensureProfileSchema();
  const result = await pool.query(
    `SELECT id, nome, email, cpf, tel, data_nascimento FROM pacientes WHERE id=$1 LIMIT 1`,
    [id],
  );
  return result.rows[0] || null;
}

function installPatientProfileRoutes(app) {
  if (app.locals.__patientProfileInstalled) return;
  app.locals.__patientProfileInstalled = true;

  app.get('/api/paciente/me', authPaciente, async (req, res) => {
    try {
      const paciente = await getPatient(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });
      return res.json({ ok: true, paciente });
    } catch (error) {
      console.error('[PACIENTE-PERFIL-GET]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar seu perfil agora.' });
    }
  });

  app.post('/api/paciente/perfil-completar', JSON_BODY, authPaciente, async (req, res) => {
    try {
      await ensureProfileSchema();
      const nome = normalizeName(req.body?.nome);
      const dataNascimento = normalizeBirthDate(req.body?.data_nascimento);

      if (nome.split(/\s+/).filter(Boolean).length < 2) {
        return res.status(400).json({ ok: false, error: 'Informe o nome completo do paciente.' });
      }
      if (!dataNascimento) {
        return res.status(400).json({ ok: false, error: 'Informe uma data de nascimento válida.' });
      }

      const result = await pool.query(
        `UPDATE pacientes
            SET nome=$2,
                data_nascimento=$3
          WHERE id=$1
          RETURNING id, nome, email, cpf, tel, data_nascimento`,
        [req.pacienteId, nome, dataNascimento],
      );
      const paciente = result.rows[0];
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });

      return res.json({ ok: true, paciente });
    } catch (error) {
      console.error('[PACIENTE-PERFIL-POST]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível salvar os dados do paciente agora.' });
    }
  });

  app.post('/api/paciente/exclusao-conta', JSON_BODY, authPaciente, async (req, res) => {
    try {
      await ensureDeletionSchema();
      const paciente = await getPatient(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });

      const result = await pool.query(
        `INSERT INTO patient_account_deletion_requests (patient_id, status, requested_at, updated_at)
         VALUES ($1, 'pending', NOW(), NOW())
         ON CONFLICT (patient_id)
         DO UPDATE SET status='pending', requested_at=NOW(), updated_at=NOW()
         RETURNING id, status, requested_at`,
        [req.pacienteId],
      );

      console.log('[PACIENTE-EXCLUSAO-CONTA]', {
        patient_id: req.pacienteId,
        request_id: result.rows[0]?.id,
      });

      return res.json({
        ok: true,
        solicitacao: result.rows[0],
        message: 'Solicitação de exclusão registrada. Dados médicos sujeitos a obrigação legal de guarda poderão ser preservados pelo prazo aplicável.',
      });
    } catch (error) {
      console.error('[PACIENTE-EXCLUSAO-CONTA]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível registrar a solicitação de exclusão agora.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installPatientProfileRoutes(this);
  return result;
};
