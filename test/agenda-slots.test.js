import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENDA_MAX_SLOTS_POR_REQUISICAO,
  dataLocal,
  filtrarSlotsExplicitos,
  formatarSlot,
  gerarSlotsSemanais,
  horarioPertenceSemanal,
  limitarSlots,
  parseDisponibilidadeSemanal,
  removerOcupados,
  resolverJanela,
  validarHorarioReserva,
  validarTamanhoDisponibilidade,
  zonedParaUtc,
} from "../agenda-slots.js";

// 2026-11-20 (sexta) 10:00 em Fortaleza = 13:00Z
const AGORA = new Date("2026-11-20T13:00:00.000Z");

test("converte horário de Fortaleza para UTC (UTC-3)", () => {
  const d = zonedParaUtc({ ano: 2026, mes: 11, dia: 20, hora: 9, minuto: 30 });
  assert.equal(d.toISOString(), "2026-11-20T12:30:00.000Z");
  assert.equal(dataLocal(new Date("2026-11-21T02:00:00.000Z")), "2026-11-20");
});

test("janela padrão começa hoje, limita a 14 dias e respeita horizonte de 90", () => {
  const j = resolverJanela({ agora: AGORA });
  assert.equal(j.ok, true);
  assert.equal(j.inicio, "2026-11-20");
  assert.equal(j.dias, 7);
  assert.equal(j.proximoInicio, "2026-11-27");

  const j2 = resolverJanela({ agora: AGORA, dias: 999 });
  assert.equal(j2.dias, 14);

  const passado = resolverJanela({ agora: AGORA, inicio: "2020-01-01" });
  assert.equal(passado.inicio, "2026-11-20");

  const fora = resolverJanela({ agora: AGORA, inicio: "2027-06-01" });
  assert.equal(fora.ok, false);

  const invalido = resolverJanela({ agora: AGORA, inicio: "2026-02-31" });
  assert.equal(invalido.ok, false);

  // Última janela: termina no horizonte e não oferece próxima página
  const ultima = resolverJanela({ agora: AGORA, inicio: "2027-02-15", dias: 14 });
  assert.equal(ultima.ok, true);
  assert.equal(ultima.proximoInicio, null);
  assert.ok(ultima.fimUtc.getTime() <= AGORA.getTime() + 90 * 86400000);
});

test("percorrer todas as janelas cobre no máximo 90 dias", () => {
  let inicio;
  let paginas = 0;
  let ultimoFim = null;
  for (;;) {
    const j = resolverJanela({ agora: AGORA, inicio, dias: 14 });
    assert.equal(j.ok, true);
    paginas++;
    ultimoFim = j.fimUtc;
    if (!j.proximoInicio) break;
    inicio = j.proximoInicio;
    assert.ok(paginas < 20);
  }
  assert.ok(paginas >= 7 && paginas <= 8);
  assert.equal(ultimoFim.getTime(), AGORA.getTime() + 90 * 86400000);
});

test("disponibilidade semanal: ignora texto livre e formatos inválidos", () => {
  assert.equal(parseDisponibilidadeSemanal("Seg a sex à tarde"), null);
  assert.equal(parseDisponibilidadeSemanal(null), null);
  assert.equal(parseDisponibilidadeSemanal({}), null);
  const s = parseDisponibilidadeSemanal('{"1":["14:00","9:00","xx"],"9":["10:00"],"5":"10:00"}');
  assert.deepEqual(s, { 1: ["09:00", "14:00"] });
});

test("gera slots no fuso de Fortaleza, sem horários passados", () => {
  const semanal = parseDisponibilidadeSemanal({ 5: ["09:00", "11:00"], 1: ["14:00"] });
  const j = resolverJanela({ agora: AGORA, dias: 7 });
  const slots = gerarSlotsSemanais(semanal, j, { agora: AGORA }).map((d) => d.toISOString());
  // Sexta 20/11 09:00 já passou (agora 10:00); 11:00 fica.
  assert.deepEqual(slots, [
    "2026-11-20T14:00:00.000Z", // sex 11:00
    "2026-11-23T17:00:00.000Z", // seg 14:00
  ]);
  assert.equal(horarioPertenceSemanal(new Date("2026-11-23T17:00:00.000Z"), semanal), true);
  assert.equal(horarioPertenceSemanal(new Date("2026-11-23T18:00:00.000Z"), semanal), false);
});

test("slots explícitos: filtra passado, janela e duplicados", () => {
  const j = resolverJanela({ agora: AGORA, dias: 7 });
  const lista = [
    "2026-05-23T12:00:00.000Z", // passado
    "2026-11-21T12:00:00.000Z",
    { iso: "2026-11-21T12:00:00.000Z" }, // duplicado
    "2026-12-30T12:00:00.000Z", // fora da janela
    "lixo",
  ];
  const out = filtrarSlotsExplicitos(lista, j, { agora: AGORA }).map((d) => d.toISOString());
  assert.deepEqual(out, ["2026-11-21T12:00:00.000Z"]);
});

test("remove slots que se sobrepõem a reservas (nos dois sentidos)", () => {
  const slots = ["12:00", "12:30", "13:00", "13:30", "14:00"].map(
    (h) => new Date(`2026-11-21T${h}:00.000Z`)
  );
  const livres = removerOcupados(slots, ["2026-11-21T13:00:00.000Z"], 60).map((d) => d.toISOString());
  assert.deepEqual(livres, ["2026-11-21T12:00:00.000Z", "2026-11-21T14:00:00.000Z"]);
});

test("limite rígido de slots por requisição", () => {
  const muitos = Array.from({ length: 500 }, (_, i) => new Date(AGORA.getTime() + (i + 1) * 60000));
  const r = limitarSlots(muitos, 10000);
  assert.equal(r.slots.length, AGENDA_MAX_SLOTS_POR_REQUISICAO);
  assert.equal(r.truncado, true);
  assert.equal(limitarSlots(muitos, 5).slots.length, 5);
});

test("validação do horário no momento da reserva", () => {
  assert.equal(validarHorarioReserva(new Date("2026-11-20T12:00:00.000Z"), { agora: AGORA }).ok, false);
  assert.equal(validarHorarioReserva(new Date("2027-03-01T12:00:00.000Z"), { agora: AGORA }).ok, false);
  assert.equal(validarHorarioReserva(new Date("2026-11-21T12:00:30.000Z"), { agora: AGORA }).ok, false);
  assert.equal(validarHorarioReserva(new Date("invalid"), { agora: AGORA }).ok, false);
  assert.equal(validarHorarioReserva(new Date("2026-11-21T12:00:00.000Z"), { agora: AGORA }).ok, true);
});

test("formata slot com data/hora locais", () => {
  assert.deepEqual(formatarSlot(new Date("2026-11-21T02:30:00.000Z")), {
    iso: "2026-11-21T02:30:00.000Z",
    data: "2026-11-20",
    hora: "23:30",
    dia_semana: "sex",
  });
});

test("rejeita disponibilidade gigante", () => {
  assert.equal(validarTamanhoDisponibilidade(new Array(2001).fill("x")).ok, false);
  assert.equal(validarTamanhoDisponibilidade(["2026-11-21T12:00:00.000Z"]).ok, true);
  assert.equal(validarTamanhoDisponibilidade("x".repeat(20001)).ok, false);
});

test("paginação por dia não corta um dia ao meio", async () => {
  const { paginarSlotsPorDia } = await import("../agenda-slots.js");
  const dia1 = ["12:00", "13:00", "14:00"].map((h) => new Date(`2026-11-21T${h}:00.000Z`));
  const dia2 = ["12:00", "13:00", "14:00"].map((h) => new Date(`2026-11-22T${h}:00.000Z`));
  const r = paginarSlotsPorDia([...dia1, ...dia2], { limite: 4, proximoInicioJanela: "2026-11-27" });
  assert.equal(r.truncado, true);
  assert.equal(r.slots.length, 3);
  assert.equal(r.proximoInicio, "2026-11-22");
  const ok = paginarSlotsPorDia(dia1, { limite: 10, proximoInicioJanela: "2026-11-27" });
  assert.equal(ok.truncado, false);
  assert.equal(ok.proximoInicio, "2026-11-27");
  const umDia = paginarSlotsPorDia(dia1, { limite: 2 });
  assert.equal(umDia.slots.length, 2);
  assert.equal(umDia.proximoInicio, "2026-11-22");
});
