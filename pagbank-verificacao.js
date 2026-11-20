// pagbank-verificacao.js
// Helpers puros para webhooks de pagamento (PagBank / PIX). Testáveis com node --test.
//
// Regra: o corpo de webhook do PagBank NÃO é autenticado. Só se confirma pagamento
// a partir do pedido lido na API do PagBank (GET /orders/:id) com o nosso token.

const STATUS_PAGO = new Set(['PAID', 'COMPLETED']);

/** Id de pedido no formato aceito antes de ir à API (evita path injection no fetch). */
export function orderIdPagBankValido(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

/** Pedido está pago? (status do pedido, charges ou pagamentos de QR). */
export function pagbankOrderPago(data) {
  const status = String(data?.status || '').toUpperCase();
  if (STATUS_PAGO.has(status)) return true;
  const charges = Array.isArray(data?.charges) ? data.charges : [];
  if (charges.some(c => STATUS_PAGO.has(String(c?.status || '').toUpperCase()))) return true;
  const qrCodes = Array.isArray(data?.qr_codes) ? data.qr_codes : [];
  return qrCodes.some(qr => {
    if (STATUS_PAGO.has(String(qr?.status || '').toUpperCase())) return true;
    const payments = Array.isArray(qr?.payments) ? qr.payments : [];
    return payments.some(p => STATUS_PAGO.has(String(p?.status || '').toUpperCase()));
  });
}

/** Resumo do pedido devolvido pela API (nunca a partir do corpo do webhook). */
export function resumirPedidoPagBank(d, idConsultado) {
  if (!d || typeof d !== 'object') return null;
  const charges = Array.isArray(d.charges) ? d.charges : [];
  const pagos = charges.filter(c => c && String(c.status || '').toUpperCase() === 'PAID');
  return {
    id: String(d.id || idConsultado || ''),
    pago: pagbankOrderPago(d),
    referenceId: String(d.reference_id || ''),
    valorPagoCentavos: pagos.reduce((s, c) => s + (Number(c.amount?.value) || 0), 0),
  };
}

/**
 * Id do atendimento (fila_atendimentos) a partir do reference_id gerado por nós:
 *   "CJ-<id>-<ALEATORIO>" (checkout) e "CJ-WA-<id>-<timestamp>" (WhatsApp).
 * Não confunde com CJ-PSI-/CJ-ESP-/RENOV- e ignora o caso sem atendimento
 * ("CJ-<Date.now()>-…", 13 dígitos).
 */
export function idFilaDeReferenciaPagBank(referencia) {
  const m = /^CJ-(?:WA-)?(\d{1,10})-[A-Za-z0-9]{1,20}$/.exec(String(referencia || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= 2147483647 ? n : null;
}

/**
 * Data de expiração do QR PIX no fuso de Fortaleza (UTC-3).
 * Bug antigo: `toISOString().replace('Z','-03:00')` rotulava o instante UTC como
 * -03:00 → o QR valia ~3h30 em vez de 30 min.
 */
export function expiracaoPixFortaleza(minutos = 30, agoraMs = Date.now()) {
  const alvo = agoraMs + minutos * 60 * 1000;
  return new Date(alvo - 3 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '-03:00');
}

/** Token de notificação da Efí (vem no corpo do webhook; só serve para consultar a API). */
export function tokenNotificacaoEfiValido(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(t);
}

/**
 * Evita martelar a API do PagBank com o mesmo order_id (webhook repetido ou forjado em massa).
 * Retorna true se a consulta pode seguir.
 */
export function criarDeduplicadorPedidos({ janelaMs = 20000, max = 2000, agora = () => Date.now() } = {}) {
  const vistos = new Map();
  return function podeConsultar(id) {
    const t = agora();
    const ultimo = vistos.get(id);
    if (ultimo !== undefined && t - ultimo < janelaMs) return false;
    vistos.set(id, t);
    if (vistos.size > max) {
      for (const [k, v] of vistos) if (t - v >= janelaMs) vistos.delete(k);
      if (vistos.size > max) vistos.clear();
    }
    return true;
  };
}
