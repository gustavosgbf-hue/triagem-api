// Lembrete por e-mail para renovar a receita (opt-in do paciente).
//
// Liga com RENOVACAO_LEMBRETE_ATIVO:
//   - vazio/0  → desligado (padrão). A rota de descadastro continua no ar.
//   - "dry"    → só registra no log quem receberia, sem enviar e sem gravar.
//   - "1"      → envia de verdade.
// Cada renovação recebe no máximo um lembrete (trava por INSERT ... ON CONFLICT).

import express from "express";
import pg from "pg";
import {
  LEMBRETE_ANTECEDENCIA_DIAS,
  LEMBRETE_JANELA_MAX_DIAS,
  normalizarDiasLembrete,
  normalizarEmail,
  dentroDaJanela,
  tokenSaida,
  codificarEmail,
  decodificarEmail,
  verificarTokenSaida,
  montarEmailLembrete,
} from "./renovacao-lembrete.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const SITE_URL = String(process.env.PUBLIC_SITE_URL || "https://consultaja24h.com.br").replace(/\/$/, "");
const API_URL = String(process.env.API_URL || "https://triagem-api.onrender.com").replace(/\/$/, "");
const RESEND_FROM = process.env.RESEND_DEFAULT_FROM || "ConsultaJá24h <contato@consultaja24h.com.br>";
const CHECK_MS = Math.max(15 * 60 * 1000, Number(process.env.RENOVACAO_LEMBRETE_CHECK_MS || 60 * 60 * 1000));
const LOTE = Math.min(50, Math.max(1, Number(process.env.RENOVACAO_LEMBRETE_LOTE || 30)));

function modo() {
  const v = String(process.env.RENOVACAO_LEMBRETE_ATIVO || "").trim().toLowerCase();
  if (v === "dry") return "dry";
  if (/^(1|true|yes|sim|on)$/.test(v)) return "on";
  return "off";
}
function segredo() {
  return String(process.env.RENOVACAO_LEMBRETE_SECRET || process.env.JWT_SECRET || "").trim();
}

let schemaPromise;
function ensureSchema() {
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS renovacao_lembretes_envios (
        atendimento_id INTEGER PRIMARY KEY,
        email TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'enviando',
        erro TEXT,
        resend_id TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        enviado_em TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_renov_lembrete_envios_email ON renovacao_lembretes_envios(email, criado_em);
      CREATE TABLE IF NOT EXISTS renovacao_lembretes_optout (
        email TEXT PRIMARY KEY,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((e) => { schemaPromise = null; throw e; });
  }
  return schemaPromise;
}

async function candidatos() {
  const { rows } = await pool.query(`
    SELECT f.id, f.nome, f.email, f.pagamento_confirmado_em,
           f.questionario->>'lembrete_renovacao_dias' AS dias
      FROM fila_atendimentos f
     WHERE f.tipo LIKE 'renovacao%'
       AND f.pagamento_status = 'confirmado'
       AND f.pagamento_confirmado_em IS NOT NULL
       AND f.questionario->>'lembrete_renovacao_dias' IN ('30','60','90')
       AND f.pagamento_confirmado_em <= NOW() - (((f.questionario->>'lembrete_renovacao_dias')::int - $1) || ' days')::interval
       AND f.pagamento_confirmado_em >  NOW() - (((f.questionario->>'lembrete_renovacao_dias')::int + $2) || ' days')::interval
       AND COALESCE(f.reembolso_status, '') = ''
       AND COALESCE(f.reembolso_valor_centavos, 0) = 0
       AND COALESCE(f.email, '') LIKE '%@%'
       AND NOT EXISTS (SELECT 1 FROM renovacao_lembretes_envios e WHERE e.atendimento_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM renovacao_lembretes_optout o WHERE o.email = LOWER(TRIM(f.email)))
       AND NOT EXISTS (
         SELECT 1 FROM renovacao_lembretes_envios e2
          WHERE e2.email = LOWER(TRIM(f.email)) AND e2.criado_em > NOW() - INTERVAL '20 days')
       AND NOT EXISTS (
         SELECT 1 FROM fila_atendimentos g
          WHERE g.id <> f.id
            AND g.tipo LIKE 'renovacao%'
            AND g.pagamento_confirmado_em > f.pagamento_confirmado_em
            AND regexp_replace(COALESCE(g.cpf, ''), '\\D', '', 'g') = regexp_replace(COALESCE(f.cpf, ''), '\\D', '', 'g')
            AND regexp_replace(COALESCE(f.cpf, ''), '\\D', '', 'g') <> '')
     ORDER BY f.pagamento_confirmado_em
     LIMIT $3
  `, [LEMBRETE_ANTECEDENCIA_DIAS, LEMBRETE_JANELA_MAX_DIAS, LOTE]);
  return rows.filter((r) => normalizarEmail(r.email) && normalizarDiasLembrete(r.dias) && dentroDaJanela(r.pagamento_confirmado_em, r.dias));
}

function linkRenovar() {
  return `${SITE_URL}/renovacao-de-receita/?utm_source=lembrete&utm_medium=email&utm_campaign=renovacao_lembrete`;
}
function linkSair(email) {
  return `${API_URL}/api/renovacao/lembrete/sair?e=${codificarEmail(email)}&t=${tokenSaida(email, segredo())}`;
}

async function enviarUm(row) {
  const email = normalizarEmail(row.email);
  const claim = await pool.query(
    `INSERT INTO renovacao_lembretes_envios (atendimento_id, email) VALUES ($1, $2)
     ON CONFLICT (atendimento_id) DO NOTHING RETURNING atendimento_id`,
    [row.id, email]
  );
  if (!claim.rowCount) return;
  const sair = linkSair(email);
  const { subject, text, html } = montarEmailLembrete({ nome: row.nome, linkRenovar: linkRenovar(), linkSair: sair });
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: RESEND_FROM, to: email, subject, html, text,
        headers: { "List-Unsubscribe": `<${sair}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        tags: [{ name: "tipo", value: "renovacao_lembrete" }],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.id) {
      await pool.query(`UPDATE renovacao_lembretes_envios SET status='enviado', enviado_em=NOW(), resend_id=$2 WHERE atendimento_id=$1`, [row.id, data.id]);
      console.log("[RENOV-LEMBRETE] enviado", { atendimento: row.id });
    } else {
      await pool.query(`UPDATE renovacao_lembretes_envios SET status='erro', erro=$2 WHERE atendimento_id=$1`, [row.id, JSON.stringify(data).slice(0, 500)]);
      console.warn("[RENOV-LEMBRETE] recusado", { atendimento: row.id, status: res.status });
    }
  } catch (e) {
    await pool.query(`UPDATE renovacao_lembretes_envios SET status='erro', erro=$2 WHERE atendimento_id=$1`, [row.id, String(e?.message || e).slice(0, 500)]).catch(() => {});
    console.warn("[RENOV-LEMBRETE] falha", { atendimento: row.id, erro: e?.message });
  }
}

let busy = false;
async function rodar() {
  const m = modo();
  if (m === "off" || busy) return;
  if (m === "on" && (!process.env.RESEND_API_KEY || !segredo())) return;
  busy = true;
  try {
    await ensureSchema();
    const lista = await candidatos();
    if (m === "dry") {
      if (lista.length) console.log("[RENOV-LEMBRETE][dry] receberiam lembrete:", lista.map((r) => r.id).join(","));
      return;
    }
    const vistos = new Set();
    for (const row of lista) {
      const email = normalizarEmail(row.email);
      if (vistos.has(email)) continue;
      vistos.add(email);
      await enviarUm(row);
    }
  } catch (e) {
    console.warn("[RENOV-LEMBRETE] worker", e?.message || e);
  } finally {
    busy = false;
  }
}

function paginaSaida(ok) {
  const msg = ok
    ? "Pronto. Você não vai mais receber lembretes de renovação."
    : "Link inválido ou expirado.";
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ConsultaJá24h</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f8f5;color:#123b29;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="max-width:420px;padding:24px;text-align:center"><p style="font-size:16px;line-height:1.5">${msg}</p>
<p><a href="${SITE_URL}" style="color:#1f6b45">Voltar ao site</a></p></div></body></html>`;
}

async function sair(req, res) {
  const email = decodificarEmail(req.query?.e);
  const ok = !!email && verificarTokenSaida(email, req.query?.t, segredo());
  if (ok) {
    try {
      await ensureSchema();
      await pool.query(`INSERT INTO renovacao_lembretes_optout (email) VALUES ($1) ON CONFLICT (email) DO NOTHING`, [email]);
    } catch (e) {
      console.warn("[RENOV-LEMBRETE] optout", e?.message || e);
      return res.status(500).type("html").send(paginaSaida(false));
    }
  }
  return res.status(ok ? 200 : 400).type("html").send(paginaSaida(ok));
}

function instalar(app) {
  if (app.locals.__renovacaoLembreteInstalled) return;
  app.locals.__renovacaoLembreteInstalled = true;
  app.get("/api/renovacao/lembrete/sair", sair);
  app.post("/api/renovacao/lembrete/sair", sair); // one-click (RFC 8058)
}

let iniciado = false;
function iniciarWorker() {
  if (iniciado) return;
  iniciado = true;
  setTimeout(rodar, 90 * 1000).unref?.();
  setInterval(rodar, CHECK_MS).unref?.();
}

const originalInit = express.application.init;
express.application.init = function patchedRenovacaoLembreteInit(...args) {
  const result = originalInit.apply(this, args);
  instalar(this);
  iniciarWorker();
  return result;
};
