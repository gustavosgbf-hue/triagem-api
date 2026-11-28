/**
 * ConsultaJá24h — Caçador de Conversões, v1 (somente leitura).
 * Uso: DATABASE_URL=... node scripts/conversion-hunter.mjs
 * Não envia mensagens, não altera pagamentos nem expõe dados pessoais.
 */
import pg from 'pg';

const HOURS = Math.max(1, Math.min(168, Number.parseInt(process.env.CONVERSION_HUNTER_HOURS || '24', 10) || 24));
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
  max: 1,
  connectionTimeoutMillis: 6000,
  idleTimeoutMillis: 1000,
});

function number(value) { return Number(value || 0); }
function pct(numerator, denominator) {
  return denominator ? Math.round(10000 * numerator / denominator) / 100 : null;
}
function alertas(f, r) {
  const result = [];
  if (f.com_pagamento_iniciado >= 10 && f.taxa_confirmacao_pct !== null && f.taxa_confirmacao_pct < 40)
    result.push({ nivel: 'alerta', codigo: 'CONFIRMACAO_BAIXA', descricao: 'Menos de 40% das tentativas com cobrança iniciada confirmaram pagamento. Investigar antes de concluir falha.' });
  if (f.pendentes_com_cobranca >= 5 && f.pendentes_mais_30min >= 5)
    result.push({ nivel: 'atencao', codigo: 'PENDENCIAS_ANTIGAS', descricao: 'Há pelo menos cinco pagamentos pendentes há mais de 30 minutos.' });
  if (r.email_erro > 0)
    result.push({ nivel: 'atencao', codigo: 'FALHAS_EMAIL', descricao: 'Existem registros de falha no envio de recuperação por e-mail.' });
  return result;
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL ausente. Execute em ambiente com acesso autorizado ao banco.');
  const client = await pool.connect();
  try {
    // READ ONLY restringe alterações mesmo em caso de modificação acidental do script.
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '8000ms'");
    const { rows: [raw] } = await client.query(`
      SELECT
        COUNT(*)::int AS atendimentos_criados,
        COUNT(*) FILTER (WHERE pagamento_status='confirmado')::int AS confirmados,
        COUNT(*) FILTER (WHERE pagamento_status='pendente')::int AS pendentes,
        COUNT(*) FILTER (WHERE
          NULLIF(BTRIM(COALESCE(pagbank_order_id,'')),'') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(efi_charge_id::text,'')),'') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(stripe_checkout_session_id,'')),'') IS NOT NULL
        )::int AS com_pagamento_iniciado,
        COUNT(*) FILTER (WHERE pagamento_status='confirmado' AND (
          NULLIF(BTRIM(COALESCE(pagbank_order_id,'')),'') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(efi_charge_id::text,'')),'') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(stripe_checkout_session_id,'')),'') IS NOT NULL
        ))::int AS confirmados_com_cobranca,
        COUNT(*) FILTER (WHERE pagamento_status='pendente' AND (
          NULLIF(BTRIM(COALESCE(pagbank_order_id,'')),'') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(efi_charge_id::text,'')),'') IS NOT NULL
          OR NULLIF(BTRIM(COALESCE(stripe_checkout_session_id,'')),'') IS NOT NULL
        ))::int AS pendentes_com_cobranca,
        COUNT(*) FILTER (WHERE pagamento_status='pendente'
          AND criado_em < NOW() - INTERVAL '30 minutes'
          AND (NULLIF(BTRIM(COALESCE(pagbank_order_id,'')),'') IS NOT NULL
               OR NULLIF(BTRIM(COALESCE(efi_charge_id::text,'')),'') IS NOT NULL
               OR NULLIF(BTRIM(COALESCE(stripe_checkout_session_id,'')),'') IS NOT NULL))::int AS pendentes_mais_30min
      FROM fila_atendimentos
      WHERE tipo IN ('chat','video','renovacao_digital')
        AND criado_em >= NOW() - ($1::integer * INTERVAL '1 hour')
    `, [HOURS]);
    const { rows: [{ has_events, has_accesses }] } = await client.query(
      "SELECT to_regclass('public.pagamento_recuperacao_eventos') IS NOT NULL AS has_events, to_regclass('public.pagamento_recuperacao_acessos') IS NOT NULL AS has_accesses"
    );
    const { rows: [rec] } = has_events ? await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE e.canal='push' AND e.status='enviado')::int AS push_enviado,
        COUNT(*) FILTER (WHERE e.canal='email' AND e.status='enviado')::int AS email_enviado,
        COUNT(*) FILTER (WHERE e.canal='email' AND e.status='erro')::int AS email_erro,
        COUNT(*) FILTER (WHERE e.canal='email' AND e.status='ignorado')::int AS email_ignorado
      FROM pagamento_recuperacao_eventos e
      WHERE e.criado_em >= NOW() - ($1::integer * INTERVAL '1 hour')
    `, [HOURS]) : { rows: [{ push_enviado: 0, email_enviado: 0, email_erro: 0, email_ignorado: 0 }] };
    const { rows: [access] } = has_accesses ? await client.query(`
      SELECT
        COUNT(*) FILTER (WHERE evento='aberto')::int AS links_abertos,
        COUNT(*) FILTER (WHERE evento='checkout_reaberto')::int AS checkouts_reabertos
      FROM pagamento_recuperacao_acessos
      WHERE criado_em >= NOW() - ($1::integer * INTERVAL '1 hour')
    `, [HOURS]) : { rows: [{ links_abertos: 0, checkouts_reabertos: 0 }] };
    await client.query('COMMIT');
    const f = Object.fromEntries(Object.entries(raw).map(([k,v]) => [k,number(v)]));
    f.taxa_confirmacao_pct = pct(f.confirmados_com_cobranca,f.com_pagamento_iniciado);
    const r = Object.fromEntries(Object.entries({ ...rec, ...access }).map(([k,v]) => [k,number(v)]));
    console.log(JSON.stringify({
      agente: 'cacador_conversoes',
      periodo_horas: HOURS,
      gerado_em: new Date().toISOString(),
      funil_aproximado: f,
      recuperacao: r,
      alertas: alertas(f,r),
      observacoes: [
        'Dados agregados: nenhum nome, telefone, CPF, e-mail ou informação clínica.',
        'Não representa funil de visitantes: conta apenas atendimentos criados na fila.',
        'Pagamento iniciado é inferido pela existência de identificador de cobrança; não equivale a checkout visualizado.',
        'Não atribui vendas recuperadas nem receita incremental sem análise por coorte e pagamento confirmado.',
        'Período inclui cobranças ainda recentes; compare janelas maduras antes de classificar queda.'
      ]
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
main().catch(error => {
  console.error('[CONVERSION-HUNTER] Falha:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
