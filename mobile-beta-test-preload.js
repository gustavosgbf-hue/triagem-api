import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const BETA_TEST_PHONE = '98991344646';
const REVIEW_PATIENT_NAME = 'Apple Review Patient';
const REVIEW_PROFESSIONAL_NAME = 'Equipe de demonstração';
const JSON_BODY = express.json({ limit: '32kb' });

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

function etapaBeta(row) {
  const pagamento = String(row?.pagamento_status || '').toLowerCase();
  const status = String(row?.status || '').toLowerCase();
  if (pagamento !== 'confirmado' && pagamento !== 'isento_admin') return 'pagamento';
  if (status === 'assumido') return 'chat';
  if (status === 'aguardando') return 'fila';
  return 'triagem';
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

async function ensureReviewChatTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_review_chat_mensagens (
      id BIGSERIAL PRIMARY KEY,
      atendimento_id BIGINT NOT NULL,
      autor TEXT NOT NULL CHECK (autor IN ('paciente','medico')),
      texto TEXT NOT NULL DEFAULT '',
      reply_to_id BIGINT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_app_review_chat_atendimento ON app_review_chat_mensagens(atendimento_id,id)`);
}

async function pacienteBeta(pacienteId) {
  const { rows } = await pool.query(
    `SELECT id,nome,email,cpf,tel FROM pacientes WHERE id=$1 LIMIT 1`,
    [pacienteId],
  );
  const paciente = rows[0] || null;
  if (!paciente || normalizePhone(paciente.tel) !== BETA_TEST_PHONE) return null;
  if (String(paciente.nome || '') !== REVIEW_PATIENT_NAME) {
    await pool.query(`UPDATE pacientes SET nome=$2 WHERE id=$1`, [paciente.id, REVIEW_PATIENT_NAME]);
    paciente.nome = REVIEW_PATIENT_NAME;
  }
  return paciente;
}

async function pacienteBetaPorTelefone(phone) {
  const tel = normalizePhone(phone);
  if (tel !== BETA_TEST_PHONE) return null;
  const { rows } = await pool.query(
    `SELECT id,nome,email,cpf,tel
       FROM pacientes
      WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11)=$1
      ORDER BY id DESC LIMIT 1`,
    [tel],
  );
  const paciente = rows[0] || null;
  if (paciente && String(paciente.nome || '') !== REVIEW_PATIENT_NAME) {
    await pool.query(`UPDATE pacientes SET nome=$2 WHERE id=$1`, [paciente.id, REVIEW_PATIENT_NAME]);
    paciente.nome = REVIEW_PATIENT_NAME;
  }
  return paciente;
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
    `SELECT * FROM fila_atendimentos WHERE id=$1 LIMIT 1`,
    [id],
  );
  const row = rows[0] || null;
  if (!row) return null;
  if (String(row.pagamento_metodo || '') !== 'beta_test') return null;
  if (normalizePhone(row.tel) !== BETA_TEST_PHONE) return null;
  return row;
}

async function confirmarPagamentoBeta(atendimentoId, metodo, referencia) {
  const { rows } = await pool.query(
    `UPDATE fila_atendimentos
        SET pagamento_status='confirmado',
            pagamento_metodo='beta_test',
            pagamento_confirmado_em=COALESCE(pagamento_confirmado_em,NOW()),
            status=CASE WHEN status IN ('pagamento_pendente','aguardando_pagamento') THEN 'triagem' ELSE status END,
            pagbank_order_id=CASE WHEN $2='pix' THEN $3 ELSE pagbank_order_id END,
            efi_charge_id=CASE WHEN $2='cartao' THEN $3 ELSE efi_charge_id END
      WHERE id=$1 AND pagamento_metodo='beta_test'
      RETURNING *`,
    [Number(atendimentoId), metodo, String(referencia || '')],
  );
  return rows[0] || null;
}

async function criarOuReutilizarBeta({ paciente, nome, cpf, email, dataNascimento, paraTerceiro }) {
  const phone = normalizePhone(paciente.tel);
  const existente = await atendimentoBetaAtivo(phone);
  if (existente) return { atendimentoId: Number(existente.id), reutilizado: true };

  const nomeFinal = String(nome || REVIEW_PATIENT_NAME).trim().slice(0, 180) || REVIEW_PATIENT_NAME;
  const cpfFinal = normalizeCpf(cpf || paciente.cpf);
  const emailFinal = String(email || paciente.email || '').trim().slice(0, 240);
  const dataNascimentoFinal = String(dataNascimento || '').trim().slice(0, 20);
  if (cpfFinal.length !== 11) throw new Error('CPF inválido para o teste');

  const { rows } = await pool.query(
    `INSERT INTO fila_atendimentos
       (nome,tel,tel_documentos,cpf,email,data_nascimento,tipo,triagem,queixa,
        status,pagamento_status,pagamento_metodo,atendimento_para_terceiro,
        prioridade_medico_id,prioridade_ate,prioridade_geral_notificada_em,medico_id,medico_nome,criado_em)
     VALUES
       ($1,$2,$2,$3,$4,$5,'chat','(aguardando pagamento)','(App Review - ambiente de demonstração)',
        'pagamento_pendente','pendente','beta_test',$6,
        NULL,NULL,NULL,NULL,NULL,NOW())
     RETURNING id`,
    [nomeFinal, phone, cpfFinal, emailFinal, dataNascimentoFinal, !!paraTerceiro],
  );
  return { atendimentoId: Number(rows[0].id), reutilizado: false };
}

async function prepararChatDemonstracao(atendimentoId) {
  await ensureReviewChatTable();
  const existente = await pool.query(
    `SELECT 1 FROM app_review_chat_mensagens WHERE atendimento_id=$1 LIMIT 1`,
    [atendimentoId],
  );
  if (!existente.rowCount) {
    await pool.query(
      `INSERT INTO app_review_chat_mensagens (atendimento_id,autor,texto,criado_em)
       VALUES
       ($1,'medico','Olá! Este é o ambiente demonstrativo da ConsultaJá24h para revisão da App Store. A conversa está disponível para testar a experiência do paciente, sem envolver um atendimento médico real.',NOW()),
       ($1,'medico','Você pode enviar uma mensagem para testar o chat. Nenhuma cobrança real será realizada neste ambiente.',NOW() + INTERVAL '1 second')`,
      [atendimentoId],
    );
  }
}

async function liberarChatDemonstracao(atendimentoId, triagem, nome, tel, cpf, email, dataNascimento) {
  const { rows } = await pool.query(
    `UPDATE fila_atendimentos
        SET triagem=CASE WHEN $2<>'' THEN $2 ELSE triagem END,
            queixa=CASE WHEN $2<>'' THEN $2 ELSE queixa END,
            nome=CASE WHEN $3<>'' THEN $3 ELSE nome END,
            tel=CASE WHEN $4<>'' THEN $4 ELSE tel END,
            tel_documentos=CASE WHEN $4<>'' THEN $4 ELSE tel_documentos END,
            cpf=CASE WHEN $5<>'' THEN $5 ELSE cpf END,
            email=CASE WHEN $6<>'' THEN $6 ELSE email END,
            data_nascimento=CASE WHEN $7<>'' THEN $7 ELSE data_nascimento END,
            status='assumido',
            pagamento_status='confirmado',
            pagamento_metodo='beta_test',
            medico_id=NULL,
            medico_nome=$8,
            prioridade_medico_id=NULL,
            prioridade_ate=NULL,
            prioridade_geral_notificada_em=NOW()
      WHERE id=$1 AND pagamento_metodo='beta_test'
      RETURNING *`,
    [atendimentoId, triagem, nome, tel, cpf, email, dataNascimento, REVIEW_PROFESSIONAL_NAME],
  );
  await prepararChatDemonstracao(atendimentoId);
  return rows[0] || null;
}

function formatReviewMessage(row) {
  return {
    id: Number(row.id),
    atendimento_id: Number(row.atendimento_id),
    autor: row.autor,
    texto: row.texto || '',
    arquivo_url: null,
    arquivo_tipo: null,
    arquivo_nome: null,
    criado_em: row.criado_em,
    reply_to_id: row.reply_to_id ? Number(row.reply_to_id) : null,
    lido_paciente_em: row.autor === 'medico' ? new Date().toISOString() : null,
    lido_medico_em: row.autor === 'paciente' ? new Date().toISOString() : null,
  };
}

function installBetaTestRoutes(app) {
  if (app.locals.__mobileBetaTestInstalled) return;
  app.locals.__mobileBetaTestInstalled = true;

  app.get('/api/mobile-beta-health', (_req, res) => {
    return res.json({ ok: true, betaModule: true, version: 'app-review-sandbox-v6' });
  });

  app.get('/api/paciente/atendimento-em-andamento', authPaciente, async (req, res, next) => {
    try {
      const paciente = await pacienteBeta(req.pacienteId);
      if (!paciente) return next();
      const ativo = await atendimentoBetaAtivo(normalizePhone(paciente.tel));
      if (!ativo) return res.json({ ok: true, atendimento: null });
      return res.json({ ok: true, atendimento: { ...ativo, etapa: etapaBeta(ativo) } });
    } catch (error) {
      console.error('[APP-REVIEW-EM-ANDAMENTO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível recuperar o atendimento demonstrativo.' });
    }
  });

  app.use('/api/notify', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const phone = normalizePhone(req.body?.tel);
      if (phone !== BETA_TEST_PHONE) return next();
      const paciente = await pacienteBetaPorTelefone(phone);
      if (!paciente) return res.status(409).json({ ok: false, error: 'Conta de revisão não encontrada.' });
      const beta = await criarOuReutilizarBeta({
        paciente,
        nome: req.body?.nome,
        cpf: req.body?.cpf || paciente.cpf,
        email: req.body?.email,
        dataNascimento: req.body?.data_nascimento,
        paraTerceiro: req.body?.atendimento_para_terceiro,
      });
      console.log(`[APP-REVIEW] Atendimento #${beta.atendimentoId} preparado para pagamento demonstrativo`);
      return res.json({ ok: true, beta: true, reutilizado: beta.reutilizado, atendimentoId: beta.atendimentoId, pagamentoConfirmado: false, tipo: 'chat' });
    } catch (error) {
      console.error('[APP-REVIEW-NOTIFY]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível iniciar o ambiente de revisão.' });
    }
  });

  app.use('/api/pagbank/order', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const beta = await atendimentoBetaPorId(req.body?.atendimentoId);
      if (!beta) return next();
      const orderId = `BETA-${beta.id}`;
      const qr = `00020126580014BR.GOV.BCB.PIX0136APP-REVIEW-${beta.id}520400005303986540549.905802BR5913CONSULTAJA24H6009SAO LUIS62070503***6304ABCD`;
      await pool.query(
        `UPDATE fila_atendimentos SET pagbank_order_id=$2,pagbank_qr_text=$3 WHERE id=$1`,
        [beta.id, orderId, qr],
      );
      return res.json({ ok: true, order_id: orderId, qr_code_text: qr, valor: 49.9, beta: true });
    } catch (error) {
      console.error('[APP-REVIEW-PIX]', error);
      return res.status(500).json({ ok: false, error: 'Falha ao gerar o PIX demonstrativo.' });
    }
  });

  app.use('/api/atendimento/vincular-order', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const beta = await atendimentoBetaPorId(req.body?.atendimentoId);
      if (!beta) return next();
      await pool.query(`UPDATE fila_atendimentos SET pagbank_order_id=$2 WHERE id=$1`, [beta.id, String(req.body?.orderId || `BETA-${beta.id}`)]);
      return res.json({ ok: true, beta: true });
    } catch (error) {
      console.error('[APP-REVIEW-VINCULAR-PIX]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível vincular o PIX demonstrativo.' });
    }
  });

  app.get('/api/pagbank/order/:orderId', async (req, res, next) => {
    try {
      const orderId = String(req.params.orderId || '');
      const match = /^BETA-(\d+)$/.exec(orderId);
      if (!match) return next();
      const beta = await atendimentoBetaPorId(Number(match[1]));
      if (!beta) return next();
      await confirmarPagamentoBeta(beta.id, 'pix', orderId);
      return res.json({ ok: true, pago: true, status: 'PAID', beta: true });
    } catch (error) {
      console.error('[APP-REVIEW-PIX-STATUS]', error);
      return res.status(500).json({ ok: false, error: 'Falha ao confirmar o PIX demonstrativo.' });
    }
  });

  app.use('/api/efi/cartao/cobrar', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const beta = await atendimentoBetaPorId(req.body?.atendimentoId);
      if (!beta) return next();
      const chargeId = `BETA-CARD-${beta.id}`;
      await confirmarPagamentoBeta(beta.id, 'cartao', chargeId);
      return res.json({ ok: true, status: 'paid', charge_id: chargeId, beta: true });
    } catch (error) {
      console.error('[APP-REVIEW-CARTAO]', error);
      return res.status(500).json({ ok: false, error: 'Falha ao simular o cartão de revisão.' });
    }
  });

  // Compatibilidade com builds antigas: ainda cria o atendimento, mas não pula pagamento.
  app.post('/api/paciente/beta/iniciar', authPaciente, async (req, res) => {
    try {
      const paciente = await pacienteBeta(req.pacienteId);
      if (!paciente) return res.status(403).json({ ok: false, beta: false, error: 'Conta sem acesso ao modo de revisão' });
      const beta = await criarOuReutilizarBeta({
        paciente,
        nome: req.body?.nome,
        cpf: req.body?.cpf || paciente.cpf,
        email: req.body?.email,
        dataNascimento: req.body?.dataNascimento,
        paraTerceiro: req.body?.atendimentoParaTerceiro,
      });
      return res.json({ ok: true, beta: true, reutilizado: beta.reutilizado, atendimentoId: beta.atendimentoId, pagamentoConfirmado: false });
    } catch (error) {
      console.error('[APP-REVIEW-INICIAR]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível iniciar o modo de revisão.' });
    }
  });

  app.use('/api/atendimento/atualizar-triagem', async (req, res, next) => {
    if (req.method !== 'POST') return next();
    try {
      const atendimentoId = Number(req.body?.atendimentoId);
      if (!atendimentoId) return next();
      const row = await atendimentoBetaPorId(atendimentoId);
      if (!row) return next();
      const triagem = String(req.body?.triagem || '').trim().slice(0, 12000);
      const nome = String(req.body?.nome || REVIEW_PATIENT_NAME).trim().slice(0, 180);
      const tel = normalizePhone(req.body?.tel || row.tel);
      const cpf = normalizeCpf(req.body?.cpf || row.cpf || '');
      const email = String(req.body?.email || row.email || '').trim().slice(0, 240);
      const dataNascimento = String(req.body?.data_nascimento || row.data_nascimento || '').trim().slice(0, 20);
      await liberarChatDemonstracao(atendimentoId, triagem, nome, tel, cpf, email, dataNascimento);
      console.log(`[APP-REVIEW] Atendimento #${atendimentoId} entrou no chat demonstrativo isolado`);
      return res.json({ ok: true, beta: true, atendimentoId });
    } catch (error) {
      console.error('[APP-REVIEW-TRIAGEM]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível concluir a triagem demonstrativa.' });
    }
  });

  app.get('/api/paciente/atendimento/:id/chat-v2', authPaciente, async (req, res, next) => {
    try {
      const paciente = await pacienteBeta(req.pacienteId);
      if (!paciente) return next();
      const atendimento = await atendimentoBetaPorId(req.params.id);
      if (!atendimento) return next();
      await prepararChatDemonstracao(atendimento.id);
      const { rows } = await pool.query(
        `SELECT id,atendimento_id,autor,texto,reply_to_id,criado_em
           FROM app_review_chat_mensagens WHERE atendimento_id=$1 ORDER BY id ASC`,
        [atendimento.id],
      );
      return res.json({
        ok: true,
        atendimento: { id: atendimento.id, status: 'assumido', medico_nome: REVIEW_PROFESSIONAL_NAME },
        mensagens: rows.map(formatReviewMessage),
      });
    } catch (error) {
      console.error('[APP-REVIEW-CHAT-GET]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar o chat de demonstração.' });
    }
  });

  app.post('/api/paciente/atendimento/:id/chat-v2', authPaciente, JSON_BODY, async (req, res, next) => {
    try {
      const paciente = await pacienteBeta(req.pacienteId);
      if (!paciente) return next();
      const atendimento = await atendimentoBetaPorId(req.params.id);
      if (!atendimento) return next();
      await ensureReviewChatTable();
      const texto = String(req.body?.texto || '').trim().slice(0, 4000);
      if (!texto) return res.status(400).json({ ok: false, error: 'Mensagem vazia' });
      const replyToId = Number(req.body?.reply_to_id) || null;
      const { rows } = await pool.query(
        `INSERT INTO app_review_chat_mensagens (atendimento_id,autor,texto,reply_to_id)
         VALUES ($1,'paciente',$2,$3) RETURNING *`,
        [atendimento.id, texto, replyToId],
      );
      const mensagem = formatReviewMessage(rows[0]);
      setTimeout(async () => {
        try {
          await pool.query(
            `INSERT INTO app_review_chat_mensagens (atendimento_id,autor,texto)
             VALUES ($1,'medico','Mensagem recebida. Este retorno é automático e existe apenas para demonstrar o funcionamento do chat durante a revisão da App Store.')`,
            [atendimento.id],
          );
        } catch {}
      }, 900);
      return res.json({ ok: true, mensagem });
    } catch (error) {
      console.error('[APP-REVIEW-CHAT-POST]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível enviar a mensagem de demonstração.' });
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installBetaTestRoutes(this);
  return result;
};
