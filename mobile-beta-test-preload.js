import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BETA_TEST_PHONE = '98991344646';
const ADMIN_MEDICO_EMAIL = 'gustavosgbf@gmail.com';

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

async function pacienteBeta(pacienteId) {
  const { rows } = await pool.query(
    `SELECT id,nome,email,cpf,tel
       FROM pacientes
      WHERE id=$1
      LIMIT 1`,
    [pacienteId],
  );
  const paciente = rows[0] || null;
  if (!paciente) return null;
  return normalizePhone(paciente.tel) === BETA_TEST_PHONE ? paciente : null;
}

async function pacienteBetaPorDados(phone, cpf) {
  const tel = normalizePhone(phone);
  const cpfLimpo = normalizeCpf(cpf);
  if (tel !== BETA_TEST_PHONE || cpfLimpo.length !== 11) return null;
  const { rows } = await pool.query(
    `SELECT id,nome,email,cpf,tel
       FROM pacientes p
      WHERE RIGHT(regexp_replace(COALESCE(p.tel,''), '\\D', '', 'g'), 11)=$1
        AND regexp_replace(COALESCE(p.cpf,''), '\\D', '', 'g')=$2
      ORDER BY id DESC
      LIMIT 1`,
    [tel, cpfLimpo],
  );
  return rows[0] || null;
}

async function medicoAdmin() {
  const { rows } = await pool.query(
    `SELECT id,nome,nome_exibicao,email
       FROM medicos m
      WHERE LOWER(TRIM(m.email))=$1
        AND COALESCE(to_jsonb(m)->>'ativo','true') <> 'false'
      ORDER BY id ASC
      LIMIT 1`,
    [ADMIN_MEDICO_EMAIL],
  );
  return rows[0] || null;
}

async function atendimentoBetaAtivo(phone) {
  const { rows } = await pool.query(
    `SELECT *
       FROM fila_atendimentos f
      WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''), '\\D', '', 'g'), 11)=$1
        AND COALESCE(to_jsonb(f)->>'pagamento_metodo','')='beta_test'
        AND COALESCE(to_jsonb(f)->>'status','') NOT IN ('encerrado','finalizado','concluido','concluído','cancelado','expirado','arquivado')
        AND NULLIF(to_jsonb(f)->>'encerrado_em','') IS NULL
        AND NULLIF(to_jsonb(f)->>'finalizado_em','') IS NULL
      ORDER BY NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz DESC NULLS LAST
      LIMIT 1`,
    [phone],
  );
  return rows[0] || null;
}

async function atendimentoBetaPorId(atendimentoId) {
  const id = Number(atendimentoId);
  if (!id) return null;
  const { rows } = await pool.query(
    `SELECT id,tel,pagamento_metodo
       FROM fila_atendimentos
      WHERE id=$1
      LIMIT 1`,
    [id],
  );
  const row = rows[0] || null;
  if (!row) return null;
  if (String(row.pagamento_metodo || '') !== 'beta_test') return null;
  if (normalizePhone(row.tel) !== BETA_TEST_PHONE) return null;
  return row;
}

async function criarOuReutilizarBeta({ paciente, nome, cpf, email, dataNascimento, paraTerceiro }) {
  const admin = await medicoAdmin();
  if (!admin) throw new Error('Administrador médico indisponível para o teste');

  const phone = normalizePhone(paciente.tel);
  const existente = await atendimentoBetaAtivo(phone);
  if (existente) {
    return { atendimentoId: Number(existente.id), reutilizado: true };
  }

  const nomeFinal = String(nome || paciente.nome || 'Paciente beta').trim().slice(0, 180);
  const cpfFinal = normalizeCpf(cpf || paciente.cpf);
  const emailFinal = String(email || paciente.email || '').trim().slice(0, 240);
  const dataNascimentoFinal = String(dataNascimento || '').trim().slice(0, 20);
  if (cpfFinal.length !== 11) throw new Error('CPF inválido para o teste');

  const { rows } = await pool.query(
    `INSERT INTO fila_atendimentos
       (nome,tel,tel_documentos,cpf,email,data_nascimento,tipo,triagem,queixa,
        status,pagamento_status,pagamento_metodo,atendimento_para_terceiro,
        prioridade_medico_id,prioridade_ate,prioridade_geral_notificada_em,criado_em)
     VALUES
       ($1,$2,$2,$3,$4,$5,'chat','(triagem em andamento)','(teste beta do app)',
        'triagem','isento_admin','beta_test',$6,$7,NOW() + INTERVAL '100 years',NULL,NOW())
     RETURNING id`,
    [nomeFinal, phone, cpfFinal, emailFinal, dataNascimentoFinal, !!paraTerceiro, admin.id],
  );

  return { atendimentoId: Number(rows[0].id), reutilizado: false };
}

function installBetaTestRoutes(app) {
  if (app.locals.__mobileBetaTestInstalled) return;
  app.locals.__mobileBetaTestInstalled = true;

  app.use('/api/notify', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const phone = normalizePhone(req.body?.tel);
      if (phone !== BETA_TEST_PHONE) return next();

      const paciente = await pacienteBetaPorDados(phone, req.body?.cpf);
      if (!paciente) return next();

      const beta = await criarOuReutilizarBeta({
        paciente,
        nome: req.body?.nome,
        cpf: req.body?.cpf,
        email: req.body?.email,
        dataNascimento: req.body?.data_nascimento,
        paraTerceiro: req.body?.atendimento_para_terceiro,
      });

      console.log(`[MOBILE-BETA] Atendimento #${beta.atendimentoId} criado/reutilizado sem cobrança`);
      return res.json({
        ok: true,
        beta: true,
        reutilizado: beta.reutilizado,
        atendimentoId: beta.atendimentoId,
        pagamentoConfirmado: true,
        tipo: 'chat',
      });
    } catch (error) {
      console.error('[MOBILE-BETA-NOTIFY]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível iniciar o teste beta.' });
    }
  });

  // Se a compilação atual continuar a função de pagamento por alguns milissegundos
  // após receber pagamentoConfirmado=true, bloqueamos qualquer chamada real aos provedores.
  app.use('/api/pagbank/order', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const beta = await atendimentoBetaPorId(req.body?.atendimentoId);
      if (!beta) return next();
      return res.json({
        ok: true,
        order_id: `BETA-${beta.id}`,
        qr_code_text: `TESTE-BETA-${beta.id}-SEM-COBRANCA`,
        valor: 0,
      });
    } catch (error) {
      console.error('[MOBILE-BETA-PAGBANK]', error);
      return res.status(500).json({ ok: false, error: 'Falha ao proteger o pagamento beta.' });
    }
  });

  app.use('/api/efi/cartao/cobrar', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const beta = await atendimentoBetaPorId(req.body?.atendimentoId);
      if (!beta) return next();
      return res.json({ ok: true, status: 'paid', charge_id: `BETA-${beta.id}` });
    } catch (error) {
      console.error('[MOBILE-BETA-EFI]', error);
      return res.status(500).json({ ok: false, error: 'Falha ao proteger o pagamento beta.' });
    }
  });

  app.post('/api/paciente/beta/iniciar', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteBeta(req.pacienteId);
      if (!paciente) return res.status(403).json({ ok: false, beta: false, error: 'Conta sem acesso ao modo beta' });

      const beta = await criarOuReutilizarBeta({
        paciente,
        nome: req.body?.nome,
        cpf: req.body?.cpf,
        email: req.body?.email,
        dataNascimento: req.body?.dataNascimento,
        paraTerceiro: req.body?.atendimentoParaTerceiro,
      });

      return res.json({
        ok: true,
        beta: true,
        reutilizado: beta.reutilizado,
        atendimentoId: beta.atendimentoId,
        pagamentoConfirmado: true,
      });
    } catch (error) {
      console.error('[MOBILE-BETA-INICIAR]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível iniciar o teste beta.' });
    }
  });

  app.use('/api/atendimento/atualizar-triagem', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const atendimentoId = Number(req.body?.atendimentoId);
      if (!atendimentoId) return next();

      const row = await atendimentoBetaPorId(atendimentoId);
      if (!row) return next();

      const admin = await medicoAdmin();
      if (!admin) return res.status(409).json({ ok: false, error: 'Administrador médico indisponível para o teste' });

      const triagem = String(req.body?.triagem || '').trim().slice(0, 12000);
      const nome = String(req.body?.nome || '').trim().slice(0, 180);
      const tel = normalizePhone(req.body?.tel || row.tel);
      const cpf = normalizeCpf(req.body?.cpf || '');
      const email = String(req.body?.email || '').trim().slice(0, 240);
      const dataNascimento = String(req.body?.data_nascimento || '').trim().slice(0, 20);

      await pool.query(
        `UPDATE fila_atendimentos
            SET triagem=CASE WHEN $2<>'' THEN $2 ELSE triagem END,
                queixa=CASE WHEN $2<>'' THEN $2 ELSE queixa END,
                nome=CASE WHEN $3<>'' THEN $3 ELSE nome END,
                tel=CASE WHEN $4<>'' THEN $4 ELSE tel END,
                tel_documentos=CASE WHEN $4<>'' THEN $4 ELSE tel_documentos END,
                cpf=CASE WHEN $5<>'' THEN $5 ELSE cpf END,
                email=CASE WHEN $6<>'' THEN $6 ELSE email END,
                data_nascimento=CASE WHEN $7<>'' THEN $7 ELSE data_nascimento END,
                status='aguardando',
                pagamento_status='isento_admin',
                pagamento_metodo='beta_test',
                prioridade_medico_id=$8,
                prioridade_ate=NOW() + INTERVAL '100 years',
                prioridade_geral_notificada_em=NULL
          WHERE id=$1`,
        [atendimentoId, triagem, nome, tel, cpf, email, dataNascimento, admin.id],
      );

      console.log(`[MOBILE-BETA] Atendimento #${atendimentoId} liberado somente para o admin ${admin.id}`);
      return res.json({ ok: true, beta: true, atendimentoId });
    } catch (error) {
      console.error('[MOBILE-BETA-TRIAGEM]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível concluir a triagem beta.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installBetaTestRoutes(this);
  return result;
};
