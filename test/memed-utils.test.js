import test from "node:test";
import assert from "node:assert/strict";
import {
  encontrarIngredienteExato,
  extrairTermosAlergia,
  formatarDataMemed,
  mensagemErroMemed,
  normalizarDataIso,
  validarDadosPrescritor,
} from "../memed-utils.js";

test("normaliza datas internas e formata a data exigida pela Memed", () => {
  assert.equal(normalizarDataIso("16/10/1998"), "1998-10-16");
  assert.equal(normalizarDataIso("1998-10-16"), "1998-10-16");
  assert.equal(formatarDataMemed("1998-10-16"), "16/10/1998");
  assert.equal(formatarDataMemed("31/02/2020"), "");
});

test("valida os quatro dados regulatórios obrigatórios", () => {
  const valido = validarDadosPrescritor({
    crm: "14325-MA",
    uf: "ma",
    cpf_medico: "031.823.423-80",
    data_nascimento_medico: "27/08/1998",
  });
  assert.deepEqual(valido.faltantes, []);
  assert.equal(valido.dataNascimento, "27/08/1998");

  const incompleto = validarDadosPrescritor({ crm: "", uf: "", cpf_medico: "", data_nascimento_medico: "" });
  assert.deepEqual(incompleto.faltantes, ["CRM", "UF do CRM", "CPF", "data de nascimento"]);
});

test("extrai alergias livres sem alterar o relato original", () => {
  assert.deepEqual(extrairTermosAlergia("alergia a dipirona e amoxicilina"), ["dipirona", "amoxicilina"]);
  assert.deepEqual(extrairTermosAlergia("Alergias: dipirona, amoxicilina"), ["dipirona", "amoxicilina"]);
  assert.deepEqual(extrairTermosAlergia("Novalgina"), ["dipirona"]);
  assert.deepEqual(extrairTermosAlergia("Nega alergias"), []);
  assert.deepEqual(extrairTermosAlergia("Não possui alergia"), []);
});

test("aceita somente princípio ativo com nome exato", () => {
  const ingredientes = [{
    id: 622,
    attributes: {
      name: "Dipirona",
      slug: "dipirona",
      related: "Dipirona magnésica, Dipirona sódica",
    },
  }];
  assert.equal(encontrarIngredienteExato("dipirona", ingredientes), 622);
  assert.equal(encontrarIngredienteExato("dipirona sódica", ingredientes), 622);
  assert.equal(encontrarIngredienteExato("dip", ingredientes), null);
});

test("traduz not_approved sem expor o payload da Memed", () => {
  const mensagem = mensagemErroMemed({ errors: [{ code: "not_approved", detail: "dado sensível" }] }, 422);
  assert.match(mensagem, /não aprovado pela Memed/i);
  assert.doesNotMatch(mensagem, /dado sensível/i);
});
