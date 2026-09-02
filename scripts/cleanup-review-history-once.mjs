import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const REVIEW_PHONE = '98991344646';
const KEEP_ATTENDANCE_ID = 3432;
const CLEANUP_THROUGH_ID = 3624;

function phoneExpr(alias = 'f') {
  return `RIGHT(regexp_replace(COALESCE(${alias}.tel,''), '\\D', '', 'g'), 11)`;
}

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const idsResult = await client.query(
    `SELECT id
       FROM fila_atendimentos f
      WHERE ${phoneExpr('f')}=$1
        AND id <= $2
        AND id <> $3`,
    [REVIEW_PHONE, CLEANUP_THROUGH_ID, KEEP_ATTENDANCE_ID],
  );
  const ids = idsResult.rows.map((row) => Number(row.id)).filter(Boolean);

  if (ids.length) {
    for (const table of [
      'app_review_chat_mensagens',
      'avaliacoes_medicos',
      'mensagens',
      'pagamento_recuperacao_eventos',
      'web_push_recuperacao_eventos',
      'web_push_subscriptions',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE atendimento_id = ANY($1::bigint[])`, [ids]);
    }
    await client.query(`DELETE FROM fila_atendimentos WHERE id = ANY($1::bigint[])`, [ids]);
  }

  await client.query(
    `UPDATE fila_atendimentos
        SET nome='App Review Patient'
      WHERE id=$1`,
    [KEEP_ATTENDANCE_ID],
  );
  await client.query(
    `UPDATE pacientes
        SET nome='App Review Patient'
      WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11)=$1`,
    [REVIEW_PHONE],
  );

  await client.query('COMMIT');
  console.log(`[REVIEW-CLEANUP] removidos ${ids.length} atendimentos antigos; preservado #${KEEP_ATTENDANCE_ID}.`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('[REVIEW-CLEANUP] falha:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
