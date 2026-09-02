import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const REVIEW_PHONE = '98991344646';

function normalizePhone(value) {
  let n = String(value || '').replace(/\D/g, '');
  if (n.startsWith('55') && n.length >= 12) n = n.slice(2);
  return n.slice(-11);
}

async function normalizePendingReviewTriage() {
  try {
    await pool.query(`
      UPDATE fila_atendimentos
         SET status='triagem'
       WHERE pagamento_metodo='beta_test'
         AND pagamento_status='confirmado'
         AND status='aguardando'
         AND RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11)=$1
         AND (triagem IS NULL OR triagem='' OR triagem ILIKE '%aguardando pagamento%')
    `, [REVIEW_PHONE]);
  } catch (error) {
    console.error('[APP-REVIEW-TRIAGE-FIX-STARTUP]', error);
  }
}

normalizePendingReviewTriage();

function installReviewTriageFix(app) {
  if (app.locals.__reviewTriageFixInstalled) return;
  app.locals.__reviewTriageFixInstalled = true;

  app.get('/api/atendimento/status/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!id) return next();

      const { rows } = await pool.query(`SELECT * FROM fila_atendimentos WHERE id=$1 LIMIT 1`, [id]);
      const row = rows[0] || null;
      if (!row || row.pagamento_metodo !== 'beta_test' || normalizePhone(row.tel) !== REVIEW_PHONE) return next();

      const triagemPendente = !String(row.triagem || '').trim() || /aguardando pagamento/i.test(String(row.triagem || ''));
      if (row.pagamento_status === 'confirmado' && row.status === 'aguardando' && triagemPendente) {
        await pool.query(`UPDATE fila_atendimentos SET status='triagem' WHERE id=$1`, [id]);
        row.status = 'triagem';
      }

      return res.json({
        ok: true,
        atendimento: {
          id: row.id,
          pagamento_status: row.pagamento_status,
          status: row.status,
          medico_id: row.medico_id,
          medico_nome: row.medico_nome,
          tipo: row.tipo || 'chat',
          encerrado_em: row.encerrado_em || null,
        },
        fila: { posicao: 0, total: 0 },
        beta: true,
      });
    } catch (error) {
      console.error('[APP-REVIEW-TRIAGE-FIX-STATUS]', error);
      return next();
    }
  });
}

const originalInit = express.application.init;
express.application.init = function patchedInit(...args) {
  const result = originalInit.apply(this, args);
  installReviewTriageFix(this);
  return result;
};
