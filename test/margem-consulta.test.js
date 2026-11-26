import test from "node:test";
import assert from "node:assert/strict";
import { calcularMargemConsulta, lerTaxasMargem, identificarGateway, validarAcaoMargem, transactionIdMargem } from "../margem-consulta.js";
import { valorPorAtendimentoCentavos } from "../medico-ganhos.js";

const ADMIN = "admin@exemplo.com";
const base = {
  id: 10, tipo: "chat", pagamento_status: "confirmado", status_atendimento: "✅ Atendido",
  categoria_atendimento: "clinico", especialidade_solicitada: "", valor_cobrado_centavos: 4990,
  reembolso_valor_centavos: 0, reembolso_status: null, encerrado_em: "2026-11-20T12:00:00Z",
  pagamento_metodo: "pix", pagbank_order_id: "ORDE_1"
};
const semTaxas = lerTaxasMargem({});
const comTaxas = lerTaxasMargem({
  MARGEM_TAXA_PAGBANK_PIX_PERCENTUAL: "0,99",
  MARGEM_TAXA_STRIPE_CARTAO_PERCENTUAL: "3.99", MARGEM_TAXA_STRIPE_CARTAO_FIXA_CENTAVOS: "39",
  MARGEM_IMPOSTO_PERCENTUAL: "6"
});

test("admin: empresa fica com 100% antes de taxas", () => {
  const r = calcularMargemConsulta({ at: base, medico: { email: ADMIN, nome: "Gestor" }, adminEmail: ADMIN, taxas: semTaxas });
  assert.equal(r.repasseCentavos, 0);
  assert.equal(r.contribuicaoCentavos, 4990);
  assert.equal(r.completo, false);
  assert.deepEqual(r.pendencias, ["taxa_nao_configurada:pagbank_pix", "imposto_nao_configurado"]);
});

test("repasse usa a faixa real do backend (padrão e reduzida)", () => {
  const padrao = calcularMargemConsulta({ at: base, medico: { email: "a@x.com", nome: "Fulano Silva" }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(padrao.repasseCentavos, valorPorAtendimentoCentavos("padrao"));
  const reduzida = calcularMargemConsulta({ at: base, medico: { email: "k@x.com", nome: "Kivia Souza" }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(reduzida.repasseCentavos, valorPorAtendimentoCentavos("reduzida"));
  assert.ok(reduzida.margemCentavos > padrao.margemCentavos);
});

test("taxas e imposto completos", () => {
  const r = calcularMargemConsulta({ at: base, medico: { email: ADMIN }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(r.taxaGatewayCentavos, 49); // 0,99% de 4990 = 49,4
  assert.equal(r.impostoCentavos, 299);    // 6% de 4990 = 299,4
  assert.equal(r.margemCentavos, 4990 - 49 - 299);
  assert.equal(r.completo, true);
});

test("estorno integral: sem repasse, taxa do gateway permanece", () => {
  const at = { ...base, reembolso_valor_centavos: 4990, reembolso_status: "concluido" };
  const r = calcularMargemConsulta({ at, medico: { email: "a@x.com", nome: "Fulano" }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(r.repasseCentavos, 0);
  assert.equal(r.liquidoCentavos, 0);
  assert.equal(r.margemCentavos, -49);
});

test("sem regra vigente ou sem médico: margem fica nula e incompleta", () => {
  const antigo = calcularMargemConsulta({ at: { ...base, encerrado_em: "2026-11-10T12:00:00Z" }, medico: { email: "a@x.com", nome: "X" }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(antigo.margemCentavos, null);
  assert.ok(antigo.pendencias.includes("repasse_antes_da_regra_vigente"));
  const semMedico = calcularMargemConsulta({ at: base, medico: null, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(semMedico.margemCentavos, null);
  const promo = calcularMargemConsulta({ at: { ...base, valor_cobrado_centavos: 2990 }, medico: { email: "a@x.com", nome: "X" }, adminEmail: ADMIN, taxas: comTaxas });
  assert.ok(promo.pendencias.includes("repasse_sem_regra:valor_cobrado_sem_regra"));
});

test("cartão Stripe com taxa fixa", () => {
  const at = { ...base, pagamento_metodo: "cartao", stripe_payment_intent_id: "pi_1", pagbank_order_id: null };
  assert.deepEqual(identificarGateway(at), { gateway: "stripe", metodo: "cartao" });
  const r = calcularMargemConsulta({ at, medico: { email: ADMIN }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(r.taxaGatewayCentavos, 199 + 39);
});

test("ação de margem nunca pode ser a de compra", () => {
  assert.equal(validarAcaoMargem("7507030772", ["7507030772", "123"]).ok, false);
  assert.equal(validarAcaoMargem("", []).ok, false);
  assert.equal(validarAcaoMargem("999", ["7507030772"]).ok, true);
  assert.equal(transactionIdMargem(55), "m-55");
});

test("antes de 16/11: estimativa só quando pedida, sinalizada", () => {
  const at = { ...base, encerrado_em: "2026-11-10T12:00:00Z" };
  const r = calcularMargemConsulta({ at, medico: { email: "a@x.com", nome: "Fulano" }, adminEmail: ADMIN, taxas: comTaxas, estimarAntesDaRegra: true });
  assert.equal(r.repasseCentavos, valorPorAtendimentoCentavos("padrao"));
  assert.ok(r.pendencias.includes("repasse_estimado_regra_atual"));
  const aberta = calcularMargemConsulta({ at: { ...base, encerrado_em: null }, medico: { email: "a@x.com", nome: "X" }, adminEmail: ADMIN, taxas: comTaxas, estimarAntesDaRegra: true });
  assert.equal(aberta.margemCentavos, null);
  assert.ok(aberta.pendencias.includes("consulta_nao_encerrada"));
});

test("valor recebido e taxa real do gateway prevalecem; frete é custo", () => {
  const at = { ...base, tipo: "renovacao_fisica", valor_cobrado_centavos: 4990, valor_recebido_centavos: 8590, taxa_gateway_real_centavos: 380, frete_valor: "16.70" };
  const r = calcularMargemConsulta({ at, medico: { email: ADMIN }, adminEmail: ADMIN, taxas: comTaxas });
  assert.equal(r.brutoCentavos, 8590);
  assert.equal(r.taxaGatewayCentavos, 380);
  assert.equal(r.custoEnvioCentavos, 1670);
  assert.equal(r.repasseCentavos, 0);
  assert.equal(r.margemCentavos, 8590 - 1670 - 380 - 515);
});
