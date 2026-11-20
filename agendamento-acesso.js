// agendamento-acesso.js
// Helpers de controle de acesso para os endpoints PÚBLICOS de agendamento
// (psicologia e especialistas). Módulo puro, testável com `node --test`.
//
// Motivação: /api/{psicologia,especialistas}/agendamento/:id/status é chamado
// sem login pelo checkout (polling). Como o id é sequencial, qualquer pessoa
// conseguia enumerar agendamentos e ler horário, valor e o pagbank_order_id
// (que permitia forjar o webhook). Agora:
//   - sem prova de posse  → resposta mínima (só o necessário ao polling);
//   - com token de acesso (emitido no /criar) ou JWT do paciente dono → completa,
//     mas nunca com identificadores do gateway.

export const TIPO_TOKEN_ACESSO_AGENDAMENTO = 'agendamento_acesso';
export const MODULOS_AGENDAMENTO = new Set(['psicologia', 'especialistas']);

/** Converte id de rota para inteiro positivo (ou null). */
export function parseIdAgendamento(valor) {
  const s = String(valor ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number(s);
  return n > 0 && n <= 2147483647 ? n : null;
}

export function payloadTokenAcesso(modulo, id) {
  return { tipo: TIPO_TOKEN_ACESSO_AGENDAMENTO, modulo, ag: Number(id) };
}

/** Valida o payload já decodificado/verificado de um token de acesso. */
export function tokenAcessoValido(decoded, modulo, id) {
  return !!decoded
    && decoded.tipo === TIPO_TOKEN_ACESSO_AGENDAMENTO
    && decoded.modulo === modulo
    && Number(decoded.ag) === Number(id);
}

/** Extrai o token de acesso de header/query (sem aceitar valores absurdos). */
export function extrairTokenAcesso(req) {
  const bruto = req?.headers?.['x-agendamento-token'] ?? req?.query?.token ?? req?.query?.acesso ?? '';
  const t = String(Array.isArray(bruto) ? bruto[0] : bruto).trim();
  return t && t.length <= 2048 ? t : '';
}

/**
 * Monta a resposta do polling de status.
 * Campos mínimos (sempre): id, pagamento_status, status e o nome do profissional
 * (consumidos pelos frontends atuais). `formulario_url` (psicologia) é dado
 * público do perfil e só é devolvido após confirmação.
 */
export function serializarStatusAgendamento(modulo, ag, { autorizado = false } = {}) {
  if (!ag) return null;
  const confirmado = ag.pagamento_status === 'confirmado';
  const base = {
    id: ag.id,
    pagamento_status: ag.pagamento_status,
    status: ag.status,
  };
  if (modulo === 'psicologia') {
    base.psicologo_nome = ag.psicologo_nome;
    if (confirmado && ag.formulario_url) base.formulario_url = ag.formulario_url;
  } else {
    base.especialista_nome = ag.especialista_nome;
    base.especialidade = ag.especialidade;
  }
  if (!autorizado) return base;
  const completo = {
    ...base,
    valor_cobrado: ag.valor_cobrado,
    horario_agendado: ag.horario_agendado,
  };
  if (modulo === 'psicologia') {
    completo.tipo_consulta = ag.tipo_consulta;
    completo.formulario_url = ag.formulario_url ?? null;
  }
  return completo;
}

/** Agendamento está em estado que ainda aceita cobrança? */
export function agendamentoAceitaCobranca(ag) {
  if (!ag) return { ok: false, status: 404, error: 'Agendamento não encontrado' };
  if (ag.pagamento_status === 'confirmado') return { ok: false, status: 409, error: 'Este agendamento já foi pago' };
  if (String(ag.status || '').startsWith('cancel')) {
    return { ok: false, status: 409, error: 'Este agendamento foi cancelado. Escolha um novo horário.' };
  }
  const valor = parseFloat(ag.valor_cobrado);
  if (!Number.isFinite(valor) || valor <= 0) {
    return { ok: false, status: 400, error: 'Valor do agendamento inválido. Contate o suporte.' };
  }
  return { ok: true, valorCentavos: Math.round(valor * 100) };
}

/** Extrai o id do agendamento de um reference_id/custom_id gerado por nós. */
export function idDeReferencia(referencia, prefixo) {
  const m = new RegExp(`^${prefixo}-(\\d{1,10})-\\d+$`).exec(String(referencia || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Normaliza o retorno de GET /v1/notification/:token (Efí Cobranças).
 * Formato documentado: [{ id, type:'charge', status:{current, previous},
 * identifiers:{charge_id}, created_at }] — histórico em ordem cronológica.
 * Também aceita o formato "plano" legado ({ charge_id, status:'paid' }).
 * Retorna os charge_ids cujo status MAIS RECENTE é 'paid'.
 */
export function extrairCobrancasPagasEfi(data) {
  const lista = Array.isArray(data) ? data : [];
  const ultimoStatus = new Map();
  for (const item of lista) {
    if (!item || typeof item !== 'object') continue;
    if (item.type && item.type !== 'charge') continue;
    const status = item.status && typeof item.status === 'object' ? item.status.current : item.status;
    let chargeId = item.identifiers?.charge_id ?? item.charge_id;
    if ((chargeId === undefined || chargeId === null) && !item.identifiers) chargeId = item.id;
    if (chargeId === undefined || chargeId === null || chargeId === '') continue;
    ultimoStatus.set(String(chargeId), String(status || ''));
  }
  return [...ultimoStatus].filter(([, st]) => st === 'paid').map(([id]) => id);
}
