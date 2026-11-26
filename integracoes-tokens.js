// Tokens de integração (scripts das plataformas). Só o hash SHA-256 fica no banco;
// o token aparece uma única vez, para o admin, no painel. Gerar um novo revoga o anterior do mesmo escopo.
import { createHash, randomBytes, timingSafeEqual } from "crypto";

export const ESCOPOS = Object.freeze(["google_ads_script", "microsoft_ads_script", "meta_ads_script"]);
const hash = t => createHash("sha256").update(String(t)).digest("hex");

export function gerarToken() {
  return "cj24_" + randomBytes(32).toString("base64url");
}

export function iguaisSeguro(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export function criarTokensIntegracao({ pool }) {
  let pronto = false;
  const cache = new Map(); // escopo -> { hash, ate }
  async function garantir() {
    if (pronto) return;
    await pool.query(`CREATE TABLE IF NOT EXISTS integracao_tokens (
      id BIGSERIAL PRIMARY KEY, escopo TEXT NOT NULL, token_hash TEXT NOT NULL, sufixo TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), revogado_em TIMESTAMPTZ, ultimo_uso_em TIMESTAMPTZ)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS integracao_tokens_ativo ON integracao_tokens (escopo) WHERE revogado_em IS NULL`);
    pronto = true;
  }
  async function emitir(escopo) {
    if (!ESCOPOS.includes(escopo)) throw new Error("escopo_invalido");
    await garantir();
    const token = gerarToken();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE integracao_tokens SET revogado_em=NOW() WHERE escopo=$1 AND revogado_em IS NULL`, [escopo]);
      await client.query(`INSERT INTO integracao_tokens (escopo, token_hash, sufixo) VALUES ($1,$2,$3)`, [escopo, hash(token), token.slice(-4)]);
      await client.query("COMMIT");
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); throw e; } finally { client.release(); }
    cache.delete(escopo);
    return token;
  }
  async function validar(token, escopo) {
    if (!token || !ESCOPOS.includes(escopo)) return false;
    await garantir();
    let c = cache.get(escopo);
    if (!c || c.ate < Date.now()) {
      const { rows } = await pool.query(`SELECT token_hash FROM integracao_tokens WHERE escopo=$1 AND revogado_em IS NULL`, [escopo]);
      c = { hash: rows[0]?.token_hash || "", ate: Date.now() + 60_000 };
      cache.set(escopo, c);
    }
    const ok = !!c.hash && iguaisSeguro(hash(token), c.hash);
    if (ok) pool.query(`UPDATE integracao_tokens SET ultimo_uso_em=NOW() WHERE escopo=$1 AND revogado_em IS NULL`, [escopo]).catch(() => {});
    return ok;
  }
  async function situacao() {
    await garantir();
    const { rows } = await pool.query(`SELECT escopo, sufixo, criado_em, ultimo_uso_em FROM integracao_tokens WHERE revogado_em IS NULL`);
    return Object.fromEntries(ESCOPOS.map(e => [e, rows.find(r => r.escopo === e) || null]));
  }
  return { emitir, validar, situacao, garantir };
}
