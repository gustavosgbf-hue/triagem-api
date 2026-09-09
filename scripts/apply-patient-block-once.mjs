import pg from 'pg';

const cpf = String(process.env.PATIENT_BLOCK_ONCE_CPF || '').replace(/\D/g, '');
if (!cpf) process.exit(0);

const nome = String(process.env.PATIENT_BLOCK_ONCE_NAME || '').trim() || null;
const motivo = String(process.env.PATIENT_BLOCK_ONCE_REASON || 'Bloqueio administrativo permanente').trim().slice(0, 300);

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const existente = await client.query(
    `SELECT id
       FROM paciente_bloqueios
      WHERE regexp_replace(COALESCE(cpf,''), '\\D', '', 'g') = $1
        AND bloqueado_ate > NOW()
      ORDER BY criado_em DESC
      LIMIT 1`,
    [cpf],
  );

  if (existente.rowCount) {
    console.log(`[PATIENT-BLOCK] CPF já possui bloqueio ativo (#${existente.rows[0].id}).`);
    await client.query('COMMIT');
    process.exit(0);
  }

  const inserted = await client.query(
    `INSERT INTO paciente_bloqueios
      (paciente_nome, cpf, motivo, permanente, bloqueado_ate)
     VALUES ($1, $2, $3, true, TIMESTAMPTZ '2099-12-31 23:59:59+00')
     RETURNING id`,
    [nome, cpf, motivo],
  );

  await client.query('COMMIT');
  console.log(`[PATIENT-BLOCK] bloqueio permanente aplicado (#${inserted.rows[0].id}).`);
} catch (error) {
  await client.query('ROLLBACK');
  console.error('[PATIENT-BLOCK] falha:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
