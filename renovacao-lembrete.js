// Lembrete de renovação de receita (lógica pura, sem banco nem rede).
//
// O paciente escolhe, no formulário de renovação, se quer ser lembrado
// (questionario.lembrete_renovacao_dias = 30, 60 ou 90). O e-mail sai alguns
// dias antes do prazo escolhido. A mensagem nunca cita medicamento,
// diagnóstico ou dado clínico.

import crypto from "node:crypto";

export const LEMBRETE_DIAS_VALIDOS = Object.freeze([30, 60, 90]);
export const LEMBRETE_ANTECEDENCIA_DIAS = 5;
// Depois desta janela o lembrete perdeu o sentido e não é mais enviado.
export const LEMBRETE_JANELA_MAX_DIAS = 10;

export function normalizarDiasLembrete(valor) {
  const n = Number.parseInt(String(valor ?? "").trim(), 10);
  return LEMBRETE_DIAS_VALIDOS.includes(n) ? n : null;
}

export function normalizarEmail(valor) {
  const e = String(valor || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function primeiroNome(nome) {
  const p = String(nome || "").trim().split(/\s+/)[0] || "";
  if (!p) return "";
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
}

// Momento em que o lembrete passa a poder ser enviado.
export function quandoLembrar(pagamentoConfirmadoEm, dias) {
  const d = normalizarDiasLembrete(dias);
  const base = new Date(pagamentoConfirmadoEm);
  if (!d || !Number.isFinite(base.getTime())) return null;
  return new Date(base.getTime() + (d - LEMBRETE_ANTECEDENCIA_DIAS) * 86400000);
}

export function dentroDaJanela(pagamentoConfirmadoEm, dias, agora = new Date()) {
  const inicio = quandoLembrar(pagamentoConfirmadoEm, dias);
  if (!inicio) return false;
  const fim = new Date(inicio.getTime() + (LEMBRETE_ANTECEDENCIA_DIAS + LEMBRETE_JANELA_MAX_DIAS) * 86400000);
  const t = new Date(agora).getTime();
  return t >= inicio.getTime() && t < fim.getTime();
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function tokenSaida(email, segredo) {
  const e = normalizarEmail(email);
  if (!e || !segredo) return null;
  return b64url(crypto.createHmac("sha256", String(segredo)).update(`renovacao-lembrete:${e}`).digest()).slice(0, 32);
}

export function codificarEmail(email) {
  const e = normalizarEmail(email);
  return e ? b64url(e) : null;
}

export function decodificarEmail(valor) {
  try {
    const s = String(valor || "").replace(/-/g, "+").replace(/_/g, "/");
    return normalizarEmail(Buffer.from(s, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function verificarTokenSaida(email, token, segredo) {
  const esperado = tokenSaida(email, segredo);
  const recebido = String(token || "");
  if (!esperado || esperado.length !== recebido.length) return false;
  return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(recebido));
}

function escaparHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function montarEmailLembrete({ nome, linkRenovar, linkSair }) {
  const pn = primeiroNome(nome);
  const saudacao = pn ? `Olá, ${pn}.` : "Olá.";
  const subject = "Sua receita pode estar perto de acabar";
  const text = [
    saudacao,
    "",
    "Você pediu para ser lembrado(a) da renovação da sua receita.",
    "Se o seu tratamento continua, já dá para solicitar a próxima renovação. Um médico avalia o pedido e a receita digital chega no seu e-mail.",
    "",
    `Renovar minha receita: ${linkRenovar}`,
    "",
    "Se não precisar agora, é só ignorar este e-mail.",
    `Não quero mais lembretes: ${linkSair}`,
    "",
    "ConsultaJá24h, JG Fonseca Serviços Médicos LTDA, CNPJ 55.789.896/0001-21",
  ].join("\n");
  const html = `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f6f8f5;font-family:Arial,Helvetica,sans-serif;color:#123b29">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<p style="font-size:16px;margin:0 0 14px">${escaparHtml(saudacao)}</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 12px">Você pediu para ser lembrado(a) da renovação da sua receita.</p>
<p style="font-size:15px;line-height:1.55;margin:0 0 22px">Se o seu tratamento continua, já dá para solicitar a próxima renovação. Um médico avalia o pedido e a receita digital chega no seu e-mail.</p>
<p style="margin:0 0 24px"><a href="${escaparHtml(linkRenovar)}" style="display:inline-block;background:#1f6b45;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:13px 22px;border-radius:10px">Renovar minha receita</a></p>
<p style="font-size:13px;line-height:1.5;color:#55705f;margin:0 0 6px">Se não precisar agora, é só ignorar este e-mail.</p>
<p style="font-size:12px;line-height:1.5;color:#7a8f80;margin:22px 0 0">ConsultaJá24h, JG Fonseca Serviços Médicos LTDA, CNPJ 55.789.896/0001-21<br><a href="${escaparHtml(linkSair)}" style="color:#7a8f80">Não quero mais lembretes</a></p>
</div></body></html>`;
  return { subject, text, html };
}
