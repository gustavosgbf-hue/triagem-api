// Dados 100% fictícios: segredo, ids, e-mails e CRMs inventados.
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  classificarToken, ehTokenMedico, ehTokenPrescritor, ehTokenPaciente, criarVerificadorMedicoAtivo,
} from "../auth-tokens.js";

const SEGREDO = "segredo-de-teste-ficticio";
const assinar = (p) => jwt.verify(jwt.sign(p, SEGREDO), SEGREDO);

const MEDICO = assinar({ id: 7, nome: "Dra. Teste", email: "medica.teste@exemplo.invalid", crm: "00000-XX" });
const MEDICO_CRM_NULO = assinar({ id: 8, nome: "Dr. Sem CRM", email: "sem.crm@exemplo.invalid", crm: null });
const PACIENTE = assinar({ id: 7, tipo: "paciente" });
const PSICOLOGO = assinar({ id: 7, tipo: "psicologo" });
const ESPECIALISTA = assinar({ id: 7, tipo: "especialista", email: "esp@exemplo.invalid" });
const LINK_ASSUMIR = assinar({ medicoId: 7, atendimentoId: 99, tipo: "assumir" });
const GUEST = assinar({ email: "guest@exemplo.invalid", tipo: "criar_senha_guest" });
const AGENDAMENTO = assinar({ tipo: "acesso_agendamento", modulo: "psicologia", ag: 3 });

test("token do login médico é reconhecido como médico", () => {
  assert.equal(classificarToken(MEDICO), "medico");
  assert.equal(classificarToken(MEDICO_CRM_NULO), "medico");
  assert.ok(ehTokenMedico(MEDICO));
  assert.ok(ehTokenPrescritor(MEDICO));
});

test("token de paciente é classificado como paciente", () => {
  assert.equal(classificarToken(PACIENTE), "paciente");
  assert.equal(ehTokenMedico(PACIENTE), false);
  assert.equal(ehTokenPrescritor(PACIENTE), false);
  assert.ok(ehTokenPaciente(PACIENTE));
});

test("outros perfis não são classificados como médico", () => {
  for (const t of [PSICOLOGO, LINK_ASSUMIR, GUEST, AGENDAMENTO]) {
    assert.equal(ehTokenMedico(t), false);
    assert.equal(ehTokenPrescritor(t), false);
    assert.equal(ehTokenPaciente(t), false);
  }
});

test("especialista só passa nas rotas de prescritor", () => {
  assert.equal(classificarToken(ESPECIALISTA), "especialista");
  assert.equal(ehTokenMedico(ESPECIALISTA), false);
  assert.ok(ehTokenPrescritor(ESPECIALISTA));
});

test("formatos incompletos são recusados", () => {
  assert.equal(classificarToken(null), null);
  assert.equal(classificarToken({ id: 7 }), null);
  assert.equal(classificarToken({ id: 7, email: "x@exemplo.invalid" }), null);
  assert.equal(classificarToken({ id: "abc", email: "x@exemplo.invalid", crm: "1" }), null);
  assert.equal(classificarToken({ id: 7, tipo: "paciente_x" }), "outro");
  assert.equal(classificarToken({ id: 7, tipo: "medico" }), null);
});

function poolFalso(linhas) {
  let consultas = 0;
  return {
    get consultas() { return consultas; },
    async query(_sql, [id]) { consultas++; return { rows: linhas[id] ? [linhas[id]] : [] }; },
  };
}

test("verificador de médico ativo confere existência, ativo e e-mail, com cache", async () => {
  const pool = poolFalso({
    7: { email: "medica.teste@exemplo.invalid", ativo: true },
    9: { email: "inativo@exemplo.invalid", ativo: false },
  });
  const ativo = criarVerificadorMedicoAtivo(pool, { ttlMs: 60000 });
  assert.equal(await ativo(MEDICO), true);
  assert.equal(await ativo(MEDICO), true);
  assert.equal(pool.consultas, 1, "segunda chamada usa cache");
  assert.equal(await ativo({ id: 9, email: "inativo@exemplo.invalid" }), false);
  assert.equal(await ativo({ id: 7, email: "outro@exemplo.invalid" }), false, "e-mail divergente");
  assert.equal(await ativo({ id: 404, email: "nao.existe@exemplo.invalid" }), false);
  assert.equal(await ativo(PACIENTE), false, "token sem e-mail");
});
