// Dados fictícios.
import test from "node:test";
import assert from "node:assert/strict";
import {
  gerarChave, hashChave, chaveObjetoProtegido, protegerUrls, linkAssinado, lerLinkAssinado,
} from "../acesso-atendimento.js";

const SEG = "segredo-de-teste-ficticio";
const BASE = "https://arquivos.exemplo.invalid";

test("chave é aleatória e o hash é estável", () => {
  const a = gerarChave(), b = gerarChave();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
  assert.equal(hashChave(a), hashChave(a));
  assert.notEqual(hashChave(a), hashChave(b));
});

test("só prefixos sensíveis são protegidos", () => {
  assert.equal(chaveObjetoProtegido(`${BASE}/chat/memed/1/x.pdf`, BASE), "chat/memed/1/x.pdf");
  assert.equal(chaveObjetoProtegido(`${BASE}/renovacao/9/receita-a.pdf`, BASE), "renovacao/9/receita-a.pdf");
  assert.equal(chaveObjetoProtegido(`${BASE}/consultas/3_1.png`, BASE), "consultas/3_1.png");
  assert.equal(chaveObjetoProtegido(`${BASE}/especialistas/foto.jpg`, BASE), null);
  assert.equal(chaveObjetoProtegido(`https://outro.invalid/chat/x.pdf`, BASE), null);
  assert.equal(chaveObjetoProtegido(`${BASE}/chat/../segredo`, BASE), null);
});

test("URLs sensíveis viram link assinado em qualquer profundidade", () => {
  const corpo = { ok: true, mensagens: [{ id: 1, arquivo_url: `${BASE}/chat/a.pdf` }, { foto: `${BASE}/especialistas/f.jpg` }] };
  const out = protegerUrls(corpo, BASE, { segredo: SEG, apiBase: "https://api.exemplo.invalid" });
  assert.match(out.mensagens[0].arquivo_url, /^https:\/\/api\.exemplo\.invalid\/api\/arquivo\?t=/);
  assert.equal(out.mensagens[1].foto, `${BASE}/especialistas/f.jpg`);
  assert.equal(corpo.mensagens[0].arquivo_url, `${BASE}/chat/a.pdf`, "não altera o original");
});

test("link assinado só abre o objeto para o qual foi gerado", () => {
  const link = linkAssinado("chat/a.pdf", { segredo: SEG, apiBase: "https://api.exemplo.invalid" });
  const t = decodeURIComponent(link.split("t=")[1]);
  assert.equal(lerLinkAssinado(t, SEG), "chat/a.pdf");
  assert.equal(lerLinkAssinado(t, "outro-segredo"), null);
  assert.equal(lerLinkAssinado("lixo", SEG), null);
});
