import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 4,
  idleTimeoutMillis: 30000,
});

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

async function pacienteAtual(id) {
  const { rows } = await pool.query(
    'SELECT id,nome,email,cpf,tel FROM pacientes WHERE id=$1 LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

function etapaDoAtendimento(row) {
  const status = String(row?.status || '').toLowerCase();
  const pagamento = String(row?.pagamento_status || '').toLowerCase();
  const pagamentoLiberado = pagamento === 'confirmado' || pagamento === 'isento_admin';
  if (!pagamentoLiberado) return 'pagamento';
  if (status === 'triagem' || status === 'pagamento_pendente') return 'triagem';
  if (status === 'assumido' || row?.medico_id) return 'chat';
  return 'fila';
}

function installFastPatientRoutes(app) {
  if (app.locals.__fastPatientRoutesInstalled) return;
  app.locals.__fastPatientRoutesInstalled = true;

  app.get('/api/paciente/atendimento-em-andamento', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });

      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10 || cpf.length !== 11) return res.json({ ok: true, atendimento: null });

      const { rows } = await pool.query(
        `SELECT id,nome,cpf,tel,email,data_nascimento,tipo,status,pagamento_status,pagamento_metodo,
                pagamento_confirmado_em,pagbank_order_id,pagbank_qr_text,pagbank_qr_expira_em,
                efi_charge_id,triagem,queixa,atendimento_para_terceiro,pagador_cpf,
                medico_id,medico_nome,criado_em
           FROM fila_atendimentos
          WHERE COALESCE(tipo,'') NOT LIKE 'renovacao_%'
            AND COALESCE(LOWER(status),'') NOT IN ('encerrado','finalizado','finalizada','concluido','concluído','cancelado','expirado','arquivado')
            AND encerrado_em IS NULL
            AND (regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $1
              OR regexp_replace(COALESCE(pagador_cpf,''), '\\D', '', 'g') = $1)
            AND RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11) = $2
          ORDER BY criado_em DESC NULLS LAST
          LIMIT 1`,
        [cpf, phone],
      );

      const row = rows[0];
      return res.json({ ok: true, atendimento: row ? { ...row, etapa: etapaDoAtendimento(row) } : null });
    } catch (error) {
      console.error('[PACIENTE-FAST-ACTIVE]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível recuperar o atendimento em andamento.' });
    }
  });

  app.get('/api/paciente/historico', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });
      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10) return res.json({ ok: true, atendimentos: [] });

      const { rows } = await pool.query(
        `SELECT id,
                NULLIF(TRIM(COALESCE(medico_nome,'')), '') AS profissional_nome,
                NULLIF(TRIM(COALESCE(tipo,'')), '') AS tipo,
                NULLIF(TRIM(COALESCE(status,'')), '') AS status,
                NULLIF(TRIM(COALESCE(triagem,'')), '') AS resumo,
                COALESCE(encerrado_em, assumido_em, criado_em, NOW()) AS data_atendimento
           FROM fila_atendimentos
          WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11) = $1
            AND ($2 = '' OR regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $2
                         OR regexp_replace(COALESCE(pagador_cpf,''), '\\D', '', 'g') = $2)
            AND COALESCE(status,'') NOT IN ('cancelado','expirado')
          ORDER BY data_atendimento DESC
          LIMIT 50`,
        [phone, cpf],
      );

      return res.json({
        ok: true,
        atendimentos: rows.map((row) => ({
          id: row.id,
          profissional_nome: row.profissional_nome || 'Profissional da ConsultaJá24h',
          medico_nome: row.profissional_nome || null,
          tipo: row.tipo || 'consulta',
          status: row.status || 'concluído',
          resumo: row.resumo || '',
          triagem: row.resumo || '',
          data_atendimento: row.data_atendimento,
          criado_em: row.data_atendimento,
        })),
      });
    } catch (error) {
      console.error('[PACIENTE-FAST-HISTORICO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar o histórico agora.' });
    }
  });

  app.get('/api/paciente/documentos', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });
      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10) return res.json({ ok: true, documentos: [] });

      const { rows } = await pool.query(
        `SELECT m.id,m.atendimento_id,m.arquivo_url,m.arquivo_tipo,m.arquivo_nome,m.criado_em,
                NULLIF(TRIM(COALESCE(f.medico_nome,'')), '') AS profissional_nome,
                COALESCE(f.encerrado_em, f.assumido_em, f.criado_em, m.criado_em) AS data_atendimento
           FROM mensagens m
           JOIN fila_atendimentos f ON f.id = m.atendimento_id
          WHERE m.arquivo_url IS NOT NULL
            AND LOWER(COALESCE(m.arquivo_tipo,'')) = 'pdf'
            AND RIGHT(regexp_replace(COALESCE(f.tel,''), '\\D', '', 'g'), 11) = $1
            AND ($2 = '' OR regexp_replace(COALESCE(f.cpf,''), '\\D', '', 'g') = $2
                         OR regexp_replace(COALESCE(f.pagador_cpf,''), '\\D', '', 'g') = $2)
            AND COALESCE(f.status,'') NOT IN ('cancelado','expirado')
          ORDER BY m.criado_em DESC, m.id DESC
          LIMIT 100`,
        [phone, cpf],
      );

      return res.json({
        ok: true,
        documentos: rows.map((row) => ({
          id: row.id,
          atendimento_id: row.atendimento_id,
          arquivo_url: row.arquivo_url,
          arquivo_tipo: row.arquivo_tipo || 'pdf',
          arquivo_nome: row.arquivo_nome || 'Documento médico.pdf',
          profissional_nome: row.profissional_nome || 'Profissional da ConsultaJá24h',
          medico_nome: row.profissional_nome || null,
          criado_em: row.criado_em,
          data_atendimento: row.data_atendimento,
        })),
      });
    } catch (error) {
      console.error('[PACIENTE-FAST-DOCUMENTOS]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar seus documentos agora.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedFastPatientInit(...args) {
  const result = originalInit.apply(this, args);
  installFastPatientRoutes(this);
  return result;
};
