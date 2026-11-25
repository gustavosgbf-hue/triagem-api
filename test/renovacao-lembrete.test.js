import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizarDiasLembrete,
  normalizarEmail,
  primeiroNome,
  quandoLembrar,
  dentroDaJanela,
  tokenSaida,
  verificarTokenSaida,
  codificarEmail,
  decodificarEmail,
  montarEmailLembrete,
} from "../renovacao-lembrete.js";

test("aceita só 30, 60 e 90 dias", () => {
  assert.equal(normalizarDiasLembrete("30"), 30);
  assert.equal(normalizarDiasLembrete(60), 60);
  assert.equal(normalizarDiasLembrete("90"), 90);
  for (const v of ["", null, undefined, "0", "45", "abc", 7]) assert.equal(normalizarDiasLembrete(v), null);
});

test("normaliza e-mail e rejeita inválidos", () => {
  assert.equal(normalizarEmail("  Fulano@Email.COM "), "fulano@email.com");
  assert.equal(normalizarEmail("sem-arroba"), null);
  assert.equal(normalizarEmail(""), null);
});

test("primeiro nome capitalizado", () => {
  assert.equal(primeiroNome("MARIA da silva"), "Maria");
  assert.equal(primeiroNome(""), "");
});

test("lembra 5 dias antes do prazo escolhido", () => {
  const base = new Date("2026-11-01T12:00:00Z");
  assert.equal(quandoLembrar(base, 30).toISOString(), "2026-11-26T12:00:00.000Z");
  assert.equal(quandoLembrar(base, 45), null);
});

test("janela de envio: não antes, não muito depois", () => {
  const base = new Date("2026-11-01T12:00:00Z");
  assert.equal(dentroDaJanela(base, 30, new Date("2026-11-25T12:00:00Z")), false);
  assert.equal(dentroDaJanela(base, 30, new Date("2026-11-26T12:00:00Z")), true);
  assert.equal(dentroDaJanela(base, 30, new Date("2026-12-10T12:00:00Z")), true);
  assert.equal(dentroDaJanela(base, 30, new Date("2026-12-11T12:00:00Z")), false);
});

test("token de descadastro confere só com o mesmo e-mail e segredo", () => {
  const t = tokenSaida("a@b.com", "s3gredo");
  assert.ok(t && t.length === 32);
  assert.equal(verificarTokenSaida("A@B.com", t, "s3gredo"), true);
  assert.equal(verificarTokenSaida("c@b.com", t, "s3gredo"), false);
  assert.equal(verificarTokenSaida("a@b.com", t, "outro"), false);
  assert.equal(verificarTokenSaida("a@b.com", "curto", "s3gredo"), false);
  assert.equal(tokenSaida("a@b.com", ""), null);
});

test("e-mail codificado volta igual", () => {
  assert.equal(decodificarEmail(codificarEmail("x.y+z@dominio.com.br")), "x.y+z@dominio.com.br");
  assert.equal(decodificarEmail("@@@"), null);
});

test("mensagem não traz dado clínico e escapa o nome", () => {
  const m = montarEmailLembrete({ nome: "<b>ana</b> souza", linkRenovar: "https://x/r", linkSair: "https://x/s" });
  assert.match(m.subject, /receita/);
  assert.ok(!m.html.includes("<b>ana"));
  assert.ok(m.html.includes("https://x/s"));
  assert.ok(m.text.includes("https://x/r"));
  assert.ok(!/—/.test(m.html + m.text));
});
