import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
let schemaReady = false;
let workerBusy = false;

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

function isExpoPushToken(value) {
  return /^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(String(value || '').trim());
}

async function ensureSchema() {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS paciente_push_tokens (
      id BIGSERIAL PRIMARY KEY,
      paciente_id BIGINT NOT NULL,
      expo_push_token TEXT NOT NULL UNIQUE,
      plataforma TEXT,
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_paciente_push_tokens_paciente
      ON paciente_push_tokens(paciente_id) WHERE ativo = TRUE;

    CREATE TABLE IF NOT EXISTS paciente_push_marketing (
      paciente_id BIGINT PRIMARY KEY,
      autorizado BOOLEAN NOT NULL,
      versao TEXT NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS push_marketing_entregas (
      campanha TEXT NOT NULL,
      token_id BIGINT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(campanha,token_id)
    );
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS push_assumido_paciente_em TIMESTAMPTZ;
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS renovacao_receita_pronta_em TIMESTAMPTZ;
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS renovacao_receita_url TEXT;
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS renovacao_receita_nome TEXT;
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS renovacao_push_pronta_em TIMESTAMPTZ;
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS renovacao_enviada_em TIMESTAMPTZ;
    ALTER TABLE fila_atendimentos
      ADD COLUMN IF NOT EXISTS renovacao_rastreio TEXT;

    ALTER TABLE mensagens
      ADD COLUMN IF NOT EXISTS push_paciente_em TIMESTAMPTZ;
  `);

  // Não dispara notificações retroativas na primeira ativação do recurso.
  await pool.query(`
    UPDATE mensagens
       SET push_paciente_em = NOW()
     WHERE autor = 'medico'
       AND push_paciente_em IS NULL;
  `);

  await pool.query(`
    UPDATE fila_atendimentos
       SET push_assumido_paciente_em = NOW()
     WHERE status = 'assumido'
       AND assumido_em IS NOT NULL
       AND push_assumido_paciente_em IS NULL;
  `);

  await pool.query(`
    WITH docs AS (
      SELECT DISTINCT ON (m.atendimento_id)
             m.atendimento_id,
             m.arquivo_url,
             COALESCE(NULLIF(m.arquivo_nome,''), 'Receita médica.pdf') AS arquivo_nome,
             m.criado_em
        FROM mensagens m
        JOIN fila_atendimentos f ON f.id = m.atendimento_id
       WHERE f.tipo LIKE 'renovacao_%'
         AND m.autor = 'medico'
         AND LOWER(COALESCE(m.arquivo_tipo,'')) = 'pdf'
         AND m.arquivo_url IS NOT NULL
       ORDER BY m.atendimento_id, m.criado_em DESC, m.id DESC
    )
    UPDATE fila_atendimentos f
       SET renovacao_receita_pronta_em = COALESCE(f.renovacao_receita_pronta_em, docs.criado_em),
           renovacao_receita_url = COALESCE(f.renovacao_receita_url, docs.arquivo_url),
           renovacao_receita_nome = COALESCE(f.renovacao_receita_nome, docs.arquivo_nome),
           renovacao_push_pronta_em = COALESCE(f.renovacao_push_pronta_em, NOW())
      FROM docs
     WHERE f.id = docs.atendimento_id
       AND f.tipo LIKE 'renovacao_%';
  `);

  schemaReady = true;
  console.log('[PUSH] Schema e backfill inicial prontos.');
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
    'SELECT id,nome,email,cpf,tel FROM pacientes WHERE id=$1 LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function pacienteIdDoAtendimento(atendimento) {
  if (atendimento?.conta_paciente_id) {
    const { rows } = await pool.query('SELECT id FROM pacientes WHERE id=$1 LIMIT 1', [atendimento.conta_paciente_id]);
    return rows[0]?.id ? Number(rows[0].id) : null;
  }
  const phone = normalizePhone(atendimento?.tel);
  const cpf = normalizeCpf(atendimento?.cpf);
  const pagadorCpf = normalizeCpf(atendimento?.pagador_cpf);
  if (phone.length < 10 || (!cpf && !pagadorCpf)) return null;

  const { rows } = await pool.query(
    `SELECT id
       FROM pacientes
      WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11) = $1
        AND (
          ($2 <> '' AND regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $2)
          OR ($3 <> '' AND regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $3)
        )
      ORDER BY CASE
        WHEN $3 <> '' AND regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $3 THEN 0
        ELSE 1
      END, id DESC
      LIMIT 1`,
    [phone, cpf, pagadorCpf],
  );
  return rows[0]?.id ? Number(rows[0].id) : null;
}

async function tokensDoPaciente(pacienteId) {
  const { rows } = await pool.query(
    `SELECT id, expo_push_token
       FROM paciente_push_tokens
      WHERE paciente_id=$1 AND ativo=TRUE
      ORDER BY atualizado_em DESC`,
    [pacienteId],
  );
  return rows;
}

async function enviarPushPaciente(pacienteId, { title, body, data }) {
  const tokens = await tokensDoPaciente(pacienteId);
  if (!tokens.length) return { sent: 0, noTokens: true };

  const mensagens = tokens.map((row) => ({
    to: row.expo_push_token,
    sound: 'default',
    title,
    body,
    data: data || {},
    priority: 'high',
  }));

  const response = await fetch(EXPO_PUSH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(mensagens),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.warn('[PUSH] Expo recusou envio:', response.status, JSON.stringify(payload).slice(0, 400));
    return { sent: 0, error: true };
  }

  const tickets = Array.isArray(payload?.data) ? payload.data : [];
  let sent = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const ticket = tickets[i];
    if (ticket?.status === 'ok') {
      sent += 1;
      continue;
    }
    if (ticket?.details?.error === 'DeviceNotRegistered') {
      await pool.query('UPDATE paciente_push_tokens SET ativo=FALSE, atualizado_em=NOW() WHERE id=$1', [tokens[i].id]).catch(() => {});
    }
  }
  return { sent };
}

async function detectarReceitasRenovacao() {
  await pool.query(`
    WITH docs AS (
      SELECT DISTINCT ON (m.atendimento_id)
             m.atendimento_id,
             m.arquivo_url,
             COALESCE(NULLIF(m.arquivo_nome,''), 'Receita médica.pdf') AS arquivo_nome,
             m.criado_em
        FROM mensagens m
        JOIN fila_atendimentos f ON f.id = m.atendimento_id
       WHERE f.tipo LIKE 'renovacao_%'
         AND f.renovacao_receita_pronta_em IS NULL
         AND m.autor = 'medico'
         AND LOWER(COALESCE(m.arquivo_tipo,'')) = 'pdf'
         AND m.arquivo_url IS NOT NULL
       ORDER BY m.atendimento_id, m.criado_em DESC, m.id DESC
    )
    UPDATE fila_atendimentos f
       SET renovacao_receita_pronta_em = docs.criado_em,
           renovacao_receita_url = docs.arquivo_url,
           renovacao_receita_nome = docs.arquivo_nome
      FROM docs
     WHERE f.id = docs.atendimento_id;
  `);
}

async function processarAtendimentosAssumidos() {
  const { rows } = await pool.query(`
    SELECT id,nome,tel,cpf,pagador_cpf,conta_paciente_id,medico_nome,assumido_em
      FROM fila_atendimentos
     WHERE status='assumido'
       AND assumido_em IS NOT NULL
       AND push_assumido_paciente_em IS NULL
       AND tipo NOT LIKE 'renovacao_%'
       AND assumido_em >= NOW() - INTERVAL '24 hours'
     ORDER BY assumido_em ASC
     LIMIT 20
  `);

  for (const row of rows) {
    const pacienteId = await pacienteIdDoAtendimento(row);
    if (!pacienteId) continue;
    const nomeMedico = String(row.medico_nome || '').trim();
    const result = await enviarPushPaciente(pacienteId, {
      title: 'Atendimento iniciado',
      body: nomeMedico ? `${nomeMedico} iniciou seu atendimento.` : 'Um médico iniciou seu atendimento.',
      data: { kind: 'chat', atendimentoId: Number(row.id) },
    });
    if (result.sent > 0) {
      await pool.query('UPDATE fila_atendimentos SET push_assumido_paciente_em=NOW() WHERE id=$1 AND push_assumido_paciente_em IS NULL', [row.id]);
    }
  }
}

async function processarMensagensMedico() {
  const { rows } = await pool.query(`
    SELECT m.id AS mensagem_id,m.atendimento_id,m.arquivo_tipo,
           f.nome,f.tel,f.cpf,f.pagador_cpf,f.conta_paciente_id
      FROM mensagens m
      JOIN fila_atendimentos f ON f.id=m.atendimento_id
     WHERE m.autor='medico'
       AND m.push_paciente_em IS NULL
       AND f.tipo NOT LIKE 'renovacao_%'
       AND m.criado_em >= NOW() - INTERVAL '24 hours'
     ORDER BY m.id ASC
     LIMIT 30
  `);

  for (const row of rows) {
    const pacienteId = await pacienteIdDoAtendimento(row);
    if (!pacienteId) continue;
    const result = await enviarPushPaciente(pacienteId, {
      title: 'Nova mensagem no atendimento',
      body: String(row.arquivo_tipo || '').toLowerCase() === 'pdf'
        ? 'O médico enviou um documento para você.'
        : 'Você recebeu uma nova mensagem do médico.',
      data: { kind: 'chat', atendimentoId: Number(row.atendimento_id) },
    });
    if (result.sent > 0) {
      await pool.query('UPDATE mensagens SET push_paciente_em=NOW() WHERE id=$1 AND push_paciente_em IS NULL', [row.mensagem_id]);
    }
  }
}

async function processarReceitasProntas() {
  const { rows } = await pool.query(`
    SELECT id,nome,tel,cpf,pagador_cpf,tipo,
           renovacao_receita_url,renovacao_receita_nome,renovacao_receita_pronta_em
      FROM fila_atendimentos
     WHERE tipo LIKE 'renovacao_%'
       AND renovacao_receita_pronta_em IS NOT NULL
       AND renovacao_receita_url IS NOT NULL
       AND renovacao_push_pronta_em IS NULL
     ORDER BY renovacao_receita_pronta_em ASC
     LIMIT 20
  `);

  for (const row of rows) {
    const pacienteId = await pacienteIdDoAtendimento(row);
    if (!pacienteId) continue;
    const result = await enviarPushPaciente(pacienteId, {
      title: 'Sua receita está pronta',
      body: row.tipo === 'renovacao_fisica'
        ? 'A receita foi emitida. Acompanhe o envio pelo app.'
        : 'A receita digital já está disponível no app.',
      data: {
        kind: 'renovacao',
        atendimentoId: Number(row.id),
        documentoUrl: row.renovacao_receita_url,
      },
    });
    if (result.sent > 0) {
      await pool.query('UPDATE fila_atendimentos SET renovacao_push_pronta_em=NOW() WHERE id=$1 AND renovacao_push_pronta_em IS NULL', [row.id]);
    }
  }
}

async function runWorker() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await ensureSchema();
    await detectarReceitasRenovacao();
    await processarAtendimentosAssumidos();
    await processarMensagensMedico();
    await processarReceitasProntas();
  } catch (error) {
    console.warn('[PUSH-WORKER]', error?.message || error);
  } finally {
    workerBusy = false;
  }
}

function mapRenovacao(row) {
  const tipo = String(row.tipo || 'renovacao_digital');
  let etapa = 'analise';
  if (String(row.pagamento_status || '').toLowerCase() !== 'confirmado') etapa = 'pagamento';
  else if (row.renovacao_enviada_em) etapa = 'enviada';
  else if (row.renovacao_receita_url) etapa = 'pronta';
  return {
    id: Number(row.id),
    tipo,
    etapa,
    status: row.status || null,
    pagamento_status: row.pagamento_status || null,
    criado_em: row.criado_em || null,
    medicamento: row.medicacoes || row.triagem || '',
    receita_pronta_em: row.renovacao_receita_pronta_em || null,
    receita_url: row.renovacao_receita_url || null,
    receita_nome: row.renovacao_receita_nome || 'Receita médica.pdf',
    enviada_em: row.renovacao_enviada_em || null,
    rastreio: row.renovacao_rastreio || null,
  };
}

function installRoutes(app) {
  if (app.locals.__mobilePushInstalled) return;
  app.locals.__mobilePushInstalled = true;

  app.get('/api/paciente/push-marketing', authPaciente, async (req,res) => {
    try {
      await ensureSchema();
      const {rows} = await pool.query('SELECT autorizado FROM paciente_push_marketing WHERE paciente_id=$1',[req.pacienteId]);
      res.json({ok:true, autorizado:rows[0]?.autorizado ?? null});
    } catch { res.status(500).json({ok:false,error:'Não foi possível carregar a preferência.'}); }
  });
  app.post('/api/paciente/push-marketing', express.json({limit:'4kb'}), authPaciente, async (req,res) => {
    if (typeof req.body?.autorizado !== 'boolean') return res.status(400).json({ok:false});
    try {
      await ensureSchema();
      await pool.query(`INSERT INTO paciente_push_marketing(paciente_id,autorizado,versao)
        VALUES($1,$2,'v1') ON CONFLICT(paciente_id) DO UPDATE SET autorizado=EXCLUDED.autorizado,versao=EXCLUDED.versao,atualizado_em=NOW()`,[req.pacienteId,req.body.autorizado]);
      res.json({ok:true,autorizado:req.body.autorizado});
    } catch { res.status(500).json({ok:false,error:'Não foi possível salvar a preferência.'}); }
  });

  app.post('/api/paciente/push-token', express.json({ limit: '32kb' }), authPaciente, async (req, res) => {
    try {
      await ensureSchema();
      const expoPushToken = String(req.body?.expo_push_token || '').trim();
      const plataforma = String(req.body?.plataforma || '').trim().slice(0, 30) || null;
      if (!isExpoPushToken(expoPushToken)) {
        return res.status(400).json({ ok: false, error: 'Push token inválido' });
      }
      await pool.query(
        `INSERT INTO paciente_push_tokens (paciente_id,expo_push_token,plataforma,ativo,atualizado_em)
         VALUES ($1,$2,$3,TRUE,NOW())
         ON CONFLICT (expo_push_token)
         DO UPDATE SET paciente_id=EXCLUDED.paciente_id,plataforma=EXCLUDED.plataforma,ativo=TRUE,atualizado_em=NOW()`,
        [req.pacienteId, expoPushToken, plataforma],
      );
      return res.json({ ok: true });
    } catch (error) {
      console.error('[PUSH-TOKEN]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível ativar as notificações.' });
    }
  });

  app.get('/api/paciente/renovacoes', authPaciente, async (req, res) => {
    try {
      await ensureSchema();
      await detectarReceitasRenovacao();
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });
      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      if (phone.length < 10 || cpf.length !== 11) return res.json({ ok: true, renovacoes: [] });

      const { rows } = await pool.query(
        `SELECT id,tipo,status,pagamento_status,criado_em,medicacoes,triagem,
                renovacao_receita_pronta_em,renovacao_receita_url,renovacao_receita_nome,
                renovacao_enviada_em,renovacao_rastreio
           FROM fila_atendimentos f
          WHERE f.tipo LIKE 'renovacao_%'
            AND RIGHT(regexp_replace(COALESCE(f.tel,''), '\\D', '', 'g'), 11) = $1
            AND (
              regexp_replace(COALESCE(f.cpf,''), '\\D', '', 'g') = $2
              OR regexp_replace(COALESCE(f.pagador_cpf,''), '\\D', '', 'g') = $2
            )
            AND COALESCE(f.status,'') NOT IN ('cancelado','expirado')
          ORDER BY f.criado_em DESC
          LIMIT 30`,
        [phone, cpf],
      );
      return res.json({ ok: true, renovacoes: rows.map(mapRenovacao) });
    } catch (error) {
      console.error('[PACIENTE-RENOVACOES]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar suas renovações.' });
    }
  });

  app.get('/api/paciente/renovacao/:id', authPaciente, async (req, res) => {
    try {
      await ensureSchema();
      await detectarReceitasRenovacao();
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ ok: false, error: 'Renovação inválida' });
      const paciente = await pacienteAtual(req.pacienteId);
      if (!paciente) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });
      const phone = normalizePhone(paciente.tel);
      const cpf = normalizeCpf(paciente.cpf);
      const { rows } = await pool.query(
        `SELECT id,tipo,status,pagamento_status,criado_em,medicacoes,triagem,
                renovacao_receita_pronta_em,renovacao_receita_url,renovacao_receita_nome,
                renovacao_enviada_em,renovacao_rastreio
           FROM fila_atendimentos f
          WHERE f.id=$1
            AND f.tipo LIKE 'renovacao_%'
            AND RIGHT(regexp_replace(COALESCE(f.tel,''), '\\D', '', 'g'), 11) = $2
            AND (
              regexp_replace(COALESCE(f.cpf,''), '\\D', '', 'g') = $3
              OR regexp_replace(COALESCE(f.pagador_cpf,''), '\\D', '', 'g') = $3
            )
          LIMIT 1`,
        [id, phone, cpf],
      );
      if (!rows[0]) return res.status(404).json({ ok: false, error: 'Renovação não encontrada' });
      return res.json({ ok: true, renovacao: mapRenovacao(rows[0]) });
    } catch (error) {
      console.error('[PACIENTE-RENOVACAO]', error);
      return res.status(500).json({ ok: false, error: 'Não foi possível carregar a renovação.' });
    }
  });
}

async function ensureSchemaAtStartup() {
  const retryableCodes = new Set(['40P01', '55P03', '57P01', '57P03', '53300']);
  let lastError = null;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      await ensureSchema();
      return true;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const retryable =
        retryableCodes.has(error?.code) ||
        /deadlock|shutting down|terminating connection|ECONNREFUSED|ECONNRESET|timeout/i.test(message);

      if (!retryable) {
        console.error('[PUSH] Falha não transitória ao preparar schema:', error);
        return false;
      }

      if (attempt < 4) {
        const delayMs = attempt * 1500;
        console.warn(`[PUSH] Banco temporariamente indisponível/deadlock; nova tentativa em ${delayMs}ms (tentativa ${attempt}/4).`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error('[PUSH] Schema não ficou pronto no startup; servidor seguirá ativo e tentará novamente em background.', lastError);
  return false;
}

const schemaStarted = await ensureSchemaAtStartup();
if (!schemaStarted) {
  const retryTimer = setInterval(async () => {
    if (schemaReady) {
      clearInterval(retryTimer);
      return;
    }
    try {
      await ensureSchema();
      if (schemaReady) {
        console.log('[PUSH] Schema recuperado em background.');
        clearInterval(retryTimer);
      }
    } catch (error) {
      console.warn('[PUSH] Nova tentativa de schema em background falhou:', error?.code || error?.message || error);
    }
  }, 15000);
  retryTimer.unref?.();
}

setInterval(runWorker, 3500).unref?.();

// Campanha única; nunca enviar sem opt-in explícito, nem fora da janela.
let marketingBusy = false;
async function campanhaPosFeriado() {
  const now = Date.now();
  if (marketingBusy || now < Date.parse('2026-11-16T11:00:00Z') || now >= Date.parse('2026-11-16T11:10:00Z')) return;
  marketingBusy = true;
  try {
    await ensureSchema();
    const campanha = 'pos-feriado-2026-11-16';
    const {rows} = await pool.query(`SELECT t.id,t.expo_push_token FROM paciente_push_tokens t
      JOIN paciente_push_marketing m ON m.paciente_id=t.paciente_id AND m.autorizado=TRUE
      WHERE t.ativo=TRUE AND NOT EXISTS (SELECT 1 FROM push_marketing_entregas e WHERE e.campanha=$1 AND e.token_id=t.id)`,[campanha]);
    for (const row of rows) {
      const claim = await pool.query(`INSERT INTO push_marketing_entregas(campanha,token_id)
        SELECT $1,t.id FROM paciente_push_tokens t JOIN paciente_push_marketing m ON m.paciente_id=t.paciente_id
        WHERE t.id=$2 AND t.ativo=TRUE AND m.autorizado=TRUE ON CONFLICT DO NOTHING RETURNING token_id`,[campanha,row.id]);
      if (!claim.rowCount) continue;
      try {
        const response = await fetch(EXPO_PUSH_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([{to:row.expo_push_token,title:'O feriado acabou, mas o cuidado continua! 💚',body:'Precisa renovar uma receita ou de avaliação médica para atestado? Consulte-se online, sem sair de casa.',data:{kind:'marketing'},sound:'default'}])});
        const payload = await response.json();
        const ticket = payload?.data?.[0];
        if (ticket?.details?.error === 'DeviceNotRegistered') await pool.query('UPDATE paciente_push_tokens SET ativo=FALSE WHERE id=$1',[row.id]);
        console.log('[PUSH-MARKETING]',campanha,ticket?.status || response.status);
      } catch { console.warn('[PUSH-MARKETING] Falha no envio; sem reenvio automático para evitar duplicação.'); }
    }
  } catch(error) { console.warn('[PUSH-MARKETING]',error?.message); }
  finally { marketingBusy=false; }
}
setInterval(campanhaPosFeriado, 15000).unref?.();

// Campanha aprovada pelo administrador em 18/11/2026, destinada SOMENTE
// a usuários com consentimento promocional explícito e token ativo no app.
// Cada dispositivo recebe no máximo uma tentativa, inclusive com múltiplas réplicas.
let consultaMarketingBusy = false;
async function campanhaConsultaApp1811() {
  const now = Date.now();
  if (consultaMarketingBusy ||
      now < Date.parse('2026-11-18T13:00:00Z') ||
      now >= Date.parse('2026-11-19T03:00:00Z')) return;
  consultaMarketingBusy = true;
  const campanha = 'convite-consulta-app-2026-11-18';
  try {
    await ensureSchema();
    const { rows } = await pool.query(`
      SELECT t.id,t.expo_push_token FROM paciente_push_tokens t
      JOIN paciente_push_marketing m
        ON m.paciente_id=t.paciente_id AND m.autorizado=TRUE
      WHERE t.ativo=TRUE
        AND NOT EXISTS(SELECT 1 FROM push_marketing_entregas e
                       WHERE e.campanha=$1 AND e.token_id=t.id)
      ORDER BY t.id LIMIT 500`,[campanha]);
    let enviados=0, falhas=0;
    for (const row of rows) {
      const claim = await pool.query(`
        INSERT INTO push_marketing_entregas(campanha,token_id)
        SELECT $1,t.id FROM paciente_push_tokens t
        JOIN paciente_push_marketing m
          ON m.paciente_id=t.paciente_id AND m.autorizado=TRUE
        WHERE t.id=$2 AND t.ativo=TRUE
        ON CONFLICT DO NOTHING RETURNING token_id`,[campanha,row.id]);
      if (!claim.rowCount) continue;
      try {
        const response = await fetch(EXPO_PUSH_URL,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify([{
            to:row.expo_push_token,
            title:'🩺 Precisa falar com um médico?',
            body:'Consulta médica online por R$ 49,90, sem sair de casa. Consulte-se agora!',
            data:{kind:'marketing',destination:'consulta',campaign:campanha},
            sound:'default',
            priority:'high'
          }])
        });
        const json=await response.json().catch(()=>({}));
        const ticket=json?.data?.[0];
        if (response.ok && ticket?.status==='ok') enviados++;
        else {
          falhas++;
          if(ticket?.details?.error==='DeviceNotRegistered') {
            await pool.query('UPDATE paciente_push_tokens SET ativo=FALSE,atualizado_em=NOW() WHERE id=$1',[row.id]);
          }
          console.warn('[PUSH-APP-CONSULTA]',campanha,'falha',ticket?.details?.error||response.status);
        }
      } catch(e) {
        falhas++;
        console.warn('[PUSH-APP-CONSULTA]',campanha,'envio_falhou',e?.message);
      }
    }
    if (rows.length) console.log('[PUSH-APP-CONSULTA]',campanha,
      'aceitos_expo=',enviados,'falhas=',falhas,'elegiveis=',rows.length);
  } catch(e) {
    console.warn('[PUSH-APP-CONSULTA]',campanha,'erro',e?.message);
  } finally { consultaMarketingBusy=false; }
}
setInterval(campanhaConsultaApp1811, 15000).unref?.();


const originalInit = express.application.init;
express.application.init = function patchedMobilePushInit(...args) {
  const result = originalInit.apply(this, args);
  installRoutes(this);
  return result;
};
