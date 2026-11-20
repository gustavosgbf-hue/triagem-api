import test from "node:test";
import assert from "node:assert/strict";
import {
  agendamentoAceitaCobranca,
  extrairTokenAcesso,
  idDeReferencia,
  parseIdAgendamento,
  payloadTokenAcesso,
  serializarStatusAgendamento,
  tokenAcessoValido,
} from "../agendamento-acesso.js";

const AG_PSI = {
  id: 7, pagamento_status: "pendente", status: "pendente", valor_cobrado: "150.00",
  psicologo_nome: "Psi X", horario_agendado: "2026-11-21T12:00:00.000Z", tipo_consulta: "psicoterapia",
  formulario_url: "https://forms/x", pagbank_order_id: "ORDE_123", paciente_id: 3,
};

test("ids de rota só aceitam inteiros positivos", () => {
  assert.equal(parseIdAgendamento("12"), 12);
  assert.equal(parseIdAgendamento("0"), null);
  assert.equal(parseIdAgendamento("1 OR 1=1"), null);
  assert.equal(parseIdAgendamento("99999999999"), null);
});

test("status público não expõe dados do gateway nem detalhes sem prova de posse", () => {
  const pub = serializarStatusAgendamento("psicologia", AG_PSI);
  assert.deepEqual(Object.keys(pub).sort(), ["id", "pagamento_status", "psicologo_nome", "status"]);
  const conf = serializarStatusAgendamento("psicologia", { ...AG_PSI, pagamento_status: "confirmado" });
  assert.equal(conf.formulario_url, "https://forms/x");
  assert.equal(conf.horario_agendado, undefined);
  const full = serializarStatusAgendamento("psicologia", AG_PSI, { autorizado: true });
  assert.equal(full.horario_agendado, AG_PSI.horario_agendado);
  assert.equal(full.pagbank_order_id, undefined);
  assert.equal(full.paciente_id, undefined);
  const esp = serializarStatusAgendamento("especialistas", { id: 1, pagamento_status: "confirmado", status: "confirmado", especialista_nome: "Dra", especialidade: "dermatologia", pagbank_order_id: "x" });
  assert.equal(esp.especialista_nome, "Dra");
  assert.equal(esp.pagbank_order_id, undefined);
});

test("token de acesso é vinculado ao módulo e ao id", () => {
  const p = payloadTokenAcesso("psicologia", 7);
  assert.equal(tokenAcessoValido(p, "psicologia", 7), true);
  assert.equal(tokenAcessoValido(p, "psicologia", 8), false);
  assert.equal(tokenAcessoValido(p, "especialistas", 7), false);
  assert.equal(tokenAcessoValido({ tipo: "paciente", id: 7 }, "psicologia", 7), false);
  assert.equal(extrairTokenAcesso({ headers: { "x-agendamento-token": " abc " }, query: {} }), "abc");
  assert.equal(extrairTokenAcesso({ headers: {}, query: { token: "t" } }), "t");
  assert.equal(extrairTokenAcesso({ headers: {}, query: {} }), "");
});

test("cobrança bloqueada para agendamento pago, cancelado ou sem valor", () => {
  assert.equal(agendamentoAceitaCobranca(null).status, 404);
  assert.equal(agendamentoAceitaCobranca({ ...AG_PSI, pagamento_status: "confirmado" }).status, 409);
  assert.equal(agendamentoAceitaCobranca({ ...AG_PSI, status: "cancelado" }).status, 409);
  assert.equal(agendamentoAceitaCobranca({ ...AG_PSI, status: "cancelada" }).status, 409);
  assert.equal(agendamentoAceitaCobranca({ ...AG_PSI, valor_cobrado: "abc" }).status, 400);
  assert.deepEqual(agendamentoAceitaCobranca(AG_PSI), { ok: true, valorCentavos: 15000 });
});

test("extrai id do reference_id gerado pelo backend", () => {
  assert.equal(idDeReferencia("CJ-PSI-42-1732000000000", "CJ-PSI"), 42);
  assert.equal(idDeReferencia("CJ-ESP-9-1", "CJ-ESP"), 9);
  assert.equal(idDeReferencia("CJ-PSI-CARTAO-42-1", "CJ-PSI"), null);
  assert.equal(idDeReferencia("XX-PSI-42-1", "CJ-PSI"), null);
});

test("interpreta notificações Efí (formato documentado e legado)", async () => {
  const { extrairCobrancasPagasEfi } = await import("../agendamento-acesso.js");
  const documentado = [
    { id: 1, type: "charge", status: { current: "new", previous: null }, identifiers: { charge_id: 555 } },
    { id: 2, type: "charge", status: { current: "waiting", previous: "new" }, identifiers: { charge_id: 555 } },
    { id: 3, type: "charge", status: { current: "paid", previous: "waiting" }, identifiers: { charge_id: 555 } },
    { id: 4, type: "charge", status: { current: "paid", previous: "waiting" }, identifiers: { charge_id: 777 } },
    { id: 5, type: "charge", status: { current: "refunded", previous: "paid" }, identifiers: { charge_id: 777 } },
    { id: 6, type: "subscription", status: { current: "paid" }, identifiers: { subscription_id: 1 } },
  ];
  assert.deepEqual(extrairCobrancasPagasEfi(documentado), ["555"]);
  assert.deepEqual(extrairCobrancasPagasEfi([{ charge_id: 9, status: "paid" }, { id: 10, status: "paid" }]), ["9", "10"]);
  assert.deepEqual(extrairCobrancasPagasEfi(null), []);
});
