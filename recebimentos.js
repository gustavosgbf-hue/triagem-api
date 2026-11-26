// Conferência do valor efetivamente recebido em cada gateway (e da tarifa, quando o gateway informa).
// Grava em fila_atendimentos: valor_recebido_centavos, taxa_gateway_real_centavos, recebido_fonte, recebido_conferido_em.

// PagBank: soma das cobranças pagas (amount.summary.paid, senão amount.value). Não informa tarifa.
export function extrairRecebidoPagBank(order) {
  const charges = Array.isArray(order?.charges) ? order.charges : [];
  let pago = 0, achou = false;
  for (const c of charges) {
    const st = String(c?.status || "").toUpperCase();
    if (!["PAID", "AUTHORIZED"].includes(st)) continue;
    const s = c?.amount?.summary;
    const v = Number(s?.paid ?? c?.amount?.value);
    if (Number.isFinite(v)) { pago += Math.round(v); achou = true; }
  }
  return achou ? { valorRecebidoCentavos: pago, taxaCentavos: null } : null;
}

// Stripe: PaymentIntent com latest_charge.balance_transaction expandido traz valor e tarifa reais.
export function extrairRecebidoStripe(pi) {
  if (!pi || pi.status !== "succeeded") return null;
  const valor = Number(pi.amount_received ?? pi.amount);
  if (!Number.isFinite(valor)) return null;
  const bt = pi?.latest_charge?.balance_transaction;
  const taxa = bt && typeof bt === "object" && Number.isFinite(Number(bt.fee)) ? Math.round(Number(bt.fee)) : null;
  return { valorRecebidoCentavos: Math.round(valor), taxaCentavos: taxa };
}

export const SQL_COLUNAS_RECEBIMENTO = [
  ["valor_recebido_centavos", "INTEGER"],
  ["taxa_gateway_real_centavos", "INTEGER"],
  ["recebido_fonte", "TEXT"],
  ["recebido_conferido_em", "TIMESTAMPTZ"]
];

export function criarConferenciaRecebimentos({ pool, buscarPedidoPagBank, buscarPaymentIntentStripe, log = console }) {
  let pronto = false, rodando = false;
  async function garantir() {
    if (pronto) return;
    for (const [c, t] of SQL_COLUNAS_RECEBIMENTO) await pool.query(`ALTER TABLE fila_atendimentos ADD COLUMN IF NOT EXISTS ${c} ${t}`);
    pronto = true;
  }
  async function conferir({ limite = 40, dias = 60 } = {}) {
    if (rodando) return { ok: false, motivo: "em_andamento" };
    rodando = true;
    try {
      await garantir();
      const { rows } = await pool.query(
        `SELECT id, pagbank_order_id, stripe_payment_intent_id, pagamento_metodo
           FROM fila_atendimentos
          WHERE pagamento_status='confirmado' AND recebido_conferido_em IS NULL
            AND pagamento_confirmado_em > NOW() - ($1::int * INTERVAL '1 day')
            AND (pagbank_order_id IS NOT NULL OR stripe_payment_intent_id IS NOT NULL)
          ORDER BY pagamento_confirmado_em DESC LIMIT $2`, [dias, limite]);
      let ok = 0, falhas = 0;
      for (const r of rows) {
        try {
          let res = null, fonte = null;
          const cartaoStripe = r.stripe_payment_intent_id && (r.pagamento_metodo === "cartao" || !r.pagbank_order_id);
          if (cartaoStripe && buscarPaymentIntentStripe) {
            res = extrairRecebidoStripe(await buscarPaymentIntentStripe(r.stripe_payment_intent_id)); fonte = "stripe";
          }
          if (!res && r.pagbank_order_id && buscarPedidoPagBank) {
            res = extrairRecebidoPagBank(await buscarPedidoPagBank(r.pagbank_order_id)); fonte = "pagbank";
          }
          if (!res) { falhas++; continue; }
          await pool.query(
            `UPDATE fila_atendimentos SET valor_recebido_centavos=$2, taxa_gateway_real_centavos=$3,
                    recebido_fonte=$4, recebido_conferido_em=NOW() WHERE id=$1`,
            [r.id, res.valorRecebidoCentavos, res.taxaCentavos, fonte]);
          ok++;
        } catch (e) {
          falhas++;
          log.warn?.("[RECEBIMENTO]", r.id, String(e.message || e).slice(0, 200));
        }
      }
      return { ok: true, conferidos: ok, falhas, candidatos: rows.length };
    } finally { rodando = false; }
  }
  return { conferir, garantir };
}
