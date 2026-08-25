import pg from 'pg';

const { Pool } = pg;
const originalQuery = Pool.prototype.query;

function patchSql(sql) {
  if (typeof sql !== 'string') return sql;
  let next = sql;

  // Fila dos médicos não-admin: remove qualquer atendimento beta da consulta.
  if (
    next.includes('FROM fila_atendimentos') &&
    next.includes('prioridade_medico_id=$3') &&
    next.includes("WHERE status IN ('aguardando','assumido')")
  ) {
    next = next.replace(
      "WHERE status IN ('aguardando','assumido')",
      "WHERE COALESCE(pagamento_metodo,'') <> 'beta_test' AND status IN ('aguardando','assumido')",
    );
  }

  // Quando o admin assume um atendimento normal, a rotina pode liberar/notificar a equipe.
  // Beta nunca deve entrar nessa rotina geral.
  if (
    next.includes('UPDATE fila_atendimentos') &&
    next.includes("status IN ('assumido','encerrado')") &&
    next.includes('prioridade_medico_id=$1') &&
    next.includes('prioridade_geral_notificada_em IS NULL')
  ) {
    next = next.replace(
      "WHERE status IN ('assumido','encerrado')",
      "WHERE COALESCE(pagamento_metodo,'') <> 'beta_test' AND status IN ('assumido','encerrado')",
    );
  }

  // A rotina que libera prioridades vencidas também não deve tocar no beta.
  if (
    next.includes('UPDATE fila_atendimentos') &&
    next.includes("WHERE status='aguardando'") &&
    next.includes("pagamento_status IN ('confirmado','isento_admin')") &&
    next.includes('prioridade_ate <= NOW()') &&
    next.includes('prioridade_geral_notificada_em IS NULL')
  ) {
    next = next.replace(
      "WHERE status='aguardando'",
      "WHERE COALESCE(pagamento_metodo,'') <> 'beta_test' AND status='aguardando'",
    );
  }

  return next;
}

Pool.prototype.query = function betaAdminOnlyQuery(config, values, callback) {
  if (typeof config === 'string') {
    return originalQuery.call(this, patchSql(config), values, callback);
  }
  if (config && typeof config === 'object' && typeof config.text === 'string') {
    return originalQuery.call(this, { ...config, text: patchSql(config.text) }, values, callback);
  }
  return originalQuery.call(this, config, values, callback);
};

console.log('[MOBILE-BETA] Protecao admin-only ativa para fila e notificacoes.');
