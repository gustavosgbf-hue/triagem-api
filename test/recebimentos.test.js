import test from "node:test";
import assert from "node:assert/strict";
import { extrairRecebidoPagBank, extrairRecebidoStripe } from "../recebimentos.js";

test("PagBank: soma cobranças pagas", () => {
  assert.deepEqual(extrairRecebidoPagBank({ charges: [{ status: "PAID", amount: { value: 5990, summary: { paid: 5990 } } }, { status: "DECLINED", amount: { value: 5990 } }] }), { valorRecebidoCentavos: 5990, taxaCentavos: null });
  assert.equal(extrairRecebidoPagBank({ charges: [] }), null);
});

test("Stripe: valor e tarifa reais", () => {
  assert.deepEqual(extrairRecebidoStripe({ status: "succeeded", amount_received: 4990, latest_charge: { balance_transaction: { fee: 238 } } }), { valorRecebidoCentavos: 4990, taxaCentavos: 238 });
  assert.equal(extrairRecebidoStripe({ status: "requires_payment_method", amount: 4990 }), null);
});
