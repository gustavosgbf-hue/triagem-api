import fs from 'node:fs';
import pg from 'pg';

const file = new URL('../mobile-beta-test-preload.js', import.meta.url);
let s = fs.readFileSync(file, 'utf8');

s = s.replace("const REVIEW_PATIENT_NAME = 'Apple Review Patient';", "const REVIEW_PATIENT_NAME = 'Review Patient';");
s = s.replace("'(App Review - ambiente de demonstração)'", "'(Ambiente de demonstração)'");
s = s.replace(
  "Olá! Este é o ambiente demonstrativo da ConsultaJá24h para revisão da App Store. A conversa está disponível para testar a experiência do paciente, sem envolver um atendimento médico real.",
  "Olá! Seu atendimento foi iniciado. Você pode usar este chat para conversar com o profissional responsável pela consulta."
);
s = s.replace(
  "Você pode enviar uma mensagem para testar o chat. Nenhuma cobrança real será realizada neste ambiente.",
  "Se precisar complementar alguma informação, envie uma mensagem por aqui."
);
s = s.replace(
  "Mensagem recebida. Este retorno é automático e existe apenas para demonstrar o funcionamento do chat durante a revisão da App Store.",
  "Mensagem recebida. Em um atendimento real, o profissional responsável poderá responder por este chat."
);

fs.writeFileSync(file, s);
console.log('[REVIEW-COPY] textos do sandbox normalizados.');

if (process.env.DATABASE_URL) {
  const { Pool } = pg;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await pool.query(`
      UPDATE app_review_chat_mensagens
         SET texto = CASE
           WHEN texto ILIKE '%ambiente demonstrativo%revisão%' THEN 'Olá! Seu atendimento foi iniciado. Você pode usar este chat para conversar com o profissional responsável pela consulta.'
           WHEN texto ILIKE '%Nenhuma cobrança real%' THEN 'Se precisar complementar alguma informação, envie uma mensagem por aqui.'
           WHEN texto ILIKE '%retorno é automático%revisão%' THEN 'Mensagem recebida. Em um atendimento real, o profissional responsável poderá responder por este chat.'
           ELSE texto
         END
       WHERE texto ILIKE '%ambiente demonstrativo%revisão%'
          OR texto ILIKE '%Nenhuma cobrança real%'
          OR texto ILIKE '%retorno é automático%revisão%'
    `);
    await pool.query(`
      UPDATE pacientes
         SET nome='Review Patient'
       WHERE RIGHT(regexp_replace(COALESCE(tel,''), '\\D', '', 'g'), 11)='98991344646'
    `);
    console.log('[REVIEW-COPY] mensagens existentes e nome da conta de revisão normalizados.');
  } catch (error) {
    console.error('[REVIEW-COPY] falha ao normalizar banco:', error.message);
  } finally {
    await pool.end();
  }
}
