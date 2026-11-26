import test from "node:test";
import assert from "node:assert/strict";
import { avaliarReserva } from "../modo-proprietario.js";

const at = { id: 1, tipo: "chat", categoria_atendimento: "clinico" };
const admin = { id: 9, status_online: true };
const ativo = { ativo: true, ate: "2099-01-01T00:00:00Z", minutos_reserva: 3 };

test("reserva só com modo ativo, no plantão e sem sobrecarga", () => {
  assert.deepEqual(avaliarReserva({ modo: ativo, admin, emAtendimento: 0, reservadosAbertos: 0, at }), { reservar: true, minutos: 3 });
  assert.equal(avaliarReserva({ modo: { ativo: false }, admin, emAtendimento: 0, reservadosAbertos: 0, at }).reservar, false);
  assert.equal(avaliarReserva({ modo: ativo, admin: { ...admin, status_online: false }, emAtendimento: 0, reservadosAbertos: 0, at }).motivo, "fora_do_plantao");
  assert.equal(avaliarReserva({ modo: ativo, admin, emAtendimento: 3, reservadosAbertos: 0, at }).motivo, "atendimentos_em_curso");
  assert.equal(avaliarReserva({ modo: ativo, admin, emAtendimento: 0, reservadosAbertos: 2, at }).motivo, "reservas_acumuladas");
  assert.equal(avaliarReserva({ modo: { ...ativo, ate: "2020-01-01T00:00:00Z" }, admin, emAtendimento: 0, reservadosAbertos: 0, at }).motivo, "prazo_encerrado");
});

test("não reserva especialidade, agendado nem renovação; reserva no máximo 5 min", () => {
  for (const x of [{ ...at, especialidade_solicitada: "pediatria" }, { ...at, horario_agendado: "x" }, { ...at, tipo: "renovacao_digital" }])
    assert.equal(avaliarReserva({ modo: ativo, admin, emAtendimento: 0, reservadosAbertos: 0, at: x }).reservar, false);
  assert.equal(avaliarReserva({ modo: { ...ativo, minutos_reserva: 30 }, admin, emAtendimento: 0, reservadosAbertos: 0, at }).minutos, 5);
});
