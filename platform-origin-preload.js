import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const schemaReady = pool.query(`
  ALTER TABLE fila_atendimentos
    ADD COLUMN IF NOT EXISTS origem_plataforma TEXT;
  CREATE INDEX IF NOT EXISTS idx_fila_origem_plataforma
    ON fila_atendimentos(origem_plataforma);
`).catch((err) => {
  console.warn('[ORIGEM-PLATAFORMA] Falha ao garantir schema:', err.message);
});

function normalizarOrigem(req) {
  const header = String(req.get?.('x-consultaja-platform') || '').trim().toLowerCase();
  const bodyOrigem = String(req.body?.origem || '').trim().toLowerCase();
  const valor = header || bodyOrigem;

  if (valor.includes('android')) return 'android';
  if (valor.includes('ios') || valor.includes('iphone') || valor.includes('ipad')) return 'ios';
  if (valor.includes('app')) return 'app_desconhecido';
  return 'web';
}

function rotaDeCriacao(req) {
  if (String(req.method || '').toUpperCase() !== 'POST') return false;
  return req.path === '/api/notify' || req.path === '/api/paciente/beta/iniciar';
}

const originalJson = express.response.json;
express.response.json = function platformOriginJson(payload) {
  try {
    const req = this.req;
    if (req && rotaDeCriacao(req)) {
      const atendimentoId = Number(payload?.atendimentoId || payload?.atendimento_id || 0);
      if (Number.isFinite(atendimentoId) && atendimentoId > 0) {
        const origem = normalizarOrigem(req);
        schemaReady
          .then(() => pool.query(
            `UPDATE fila_atendimentos
                SET origem_plataforma = COALESCE(origem_plataforma, $2)
              WHERE id = $1`,
            [atendimentoId, origem],
          ))
          .then(() => console.log('[ORIGEM-PLATAFORMA]', { atendimentoId, origem }))
          .catch((err) => console.warn('[ORIGEM-PLATAFORMA] Falha ao salvar:', err.message));
      }
    }
  } catch (err) {
    console.warn('[ORIGEM-PLATAFORMA] Falha no interceptor:', err.message);
  }
  return originalJson.call(this, payload);
};
