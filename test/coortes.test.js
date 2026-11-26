import test from "node:test";
import assert from "node:assert/strict";
import { montarCoortes, valorFuturoPorNovo } from "../coortes.js";

const ADMIN = "a@x.com";
const p = (id, ident, data, extra = {}) => ({ id, identidade: ident, pagamento_confirmado_em: data, tipo: "chat", pagamento_status: "confirmado",
  status_atendimento: "✅ Atendido", categoria_atendimento: "clinico", valor_cobrado_centavos: 4990, encerrado_em: data,
  pagamento_metodo: "pix", pagbank_order_id: "o", medico_email: ADMIN, ...extra });

test("coorte: retorno em 30/60/90 sem dupla contagem de novo clique pago", () => {
  const rows = [
    p(1, "A", "2026-08-05T12:00:00Z", { ads_gclid: "g1" }),
    p(2, "A", "2026-08-20T12:00:00Z"),                           // retorno orgânico em 15 dias
    p(3, "A", "2026-09-25T12:00:00Z", { ads_gclid: "g2" }),      // novo clique pago: crédito do clique, não da coorte
    p(4, "B", "2026-08-10T12:00:00Z"),
    p(5, "B", "2026-10-20T12:00:00Z", { ads_gclid: "g9", clique_reutilizado: true }) // clique antigo: conta como retorno
  ];
  const c = montarCoortes({ pagamentos: rows, adminEmail: ADMIN, hoje: new Date("2026-11-26T12:00:00Z"), taxas: { taxa: () => null, impostoPontosBase: null } });
  const g = c.find(x => x.mes === "2026-08" && x.canal === "google_ads");
  const o = c.find(x => x.mes === "2026-08" && x.canal === "outros");
  assert.equal(g.pacientes, 1); assert.equal(g.voltaram_30, 1); assert.equal(g.pagamentos_90, 1); assert.equal(g.readquiridos_90, 1);
  assert.equal(o.voltaram_30, 0); assert.equal(o.voltaram_90, 1);
  assert.equal(g.madura_60, true); assert.equal(g.madura_90, false);
});

test("valor futuro exige coortes maduras e amostra mínima", () => {
  assert.equal(valorFuturoPorNovo([{ canal: "google_ads", mes: "2026-08", pacientes: 10, madura_90: true, margem_90: 1000 }]), null);
  const v = valorFuturoPorNovo([{ canal: "google_ads", mes: "2026-07", pacientes: 50, madura_90: true, margem_90: 50000 }]);
  assert.equal(v.centavos, 1000); assert.equal(v.janela, 90);
});
