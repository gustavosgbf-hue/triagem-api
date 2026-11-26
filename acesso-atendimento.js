// Acesso do paciente ao atendimento (chat, status detalhado, documentos).
//
// Credenciais aceitas, nesta ordem:
//   1. chave do atendimento (cabeçalho X-Atendimento-Chave), emitida na criação;
//   2. login do paciente (JWT tipo paciente) que seja dono do atendimento;
//   3. médico ativo vinculado ao atendimento, ou administrador.
// Atendimentos criados antes da virada (CORTE_LEGADO) e ainda em andamento
// recebem uma chave no primeiro acesso, uma única vez, até FIM_LEGADO.
// Não há chave de ambiente que reabra o acesso anônimo.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { classificarToken } from "./auth-tokens.js";

export const CORTE_LEGADO = new Date("2026-11-26T08:00:00Z");
export const FIM_LEGADO = new Date("2026-11-28T08:00:00Z");
const STATUS_LEGADO = new Set(["pagamento_pendente", "triagem", "aguardando", "assumido", "aguardando_aprovacao"]);
const MAX_CHAVES = 8;
const ADMIN_EMAIL = "gustavosgbf@gmail.com";

export const CABECALHO_CHAVE = "x-atendimento-chave";
export const CABECALHO_CHAVE_NOVA = "X-Atendimento-Chave-Nova";
export const CABECALHO_ID = "X-Atendimento-Id";

export function gerarChave() {
  return crypto.randomBytes(32).toString("base64url");
}
export function hashChave(chave) {
  return crypto.createHash("sha256").update(String(chave || "")).digest("hex");
}
function ipResumo(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  return ip ? crypto.createHash("sha256").update("cj-ip:" + ip).digest("hex").slice(0, 12) : "-";
}

export function registrarNegado(req, rota, atendimentoId, motivo) {
  // Sem dados clínicos, sem token, sem chave.
  console.warn("[ACESSO-NEGADO]", JSON.stringify({
    rota, atendimento: Number(atendimentoId) || null, motivo, ip: ipResumo(req),
  }));
}

export function exporChave(res, atendimentoId, chave) {
  res.set(CABECALHO_CHAVE_NOVA, chave);
  res.set(CABECALHO_ID, String(atendimentoId));
  const atual = String(res.get("Access-Control-Expose-Headers") || "");
  const extra = `${CABECALHO_CHAVE_NOVA}, ${CABECALHO_ID}`;
  res.set("Access-Control-Expose-Headers", atual ? `${atual}, ${extra}` : extra);
}

export function criarAcessoAtendimento({ pool, segredo = process.env.JWT_SECRET, agora = () => new Date() }) {
  let schema;
  function garantirSchema() {
    if (!schema) {
      schema = pool.query(
        "ALTER TABLE fila_atendimentos ADD COLUMN IF NOT EXISTS acesso_hashes text[] NOT NULL DEFAULT '{}'"
      ).catch((e) => { schema = null; throw e; });
    }
    return schema;
  }

  async function emitirChave(atendimentoId) {
    await garantirSchema();
    const chave = gerarChave();
    const { rowCount } = await pool.query(
      `UPDATE fila_atendimentos
          SET acesso_hashes = (array_append(COALESCE(acesso_hashes,'{}'), $2))[GREATEST(1, COALESCE(cardinality(acesso_hashes),0) + 2 - $3):]
        WHERE id=$1`,
      [Number(atendimentoId), hashChave(chave), MAX_CHAVES]
    );
    return rowCount ? chave : null;
  }

  async function reivindicarLegado(atendimentoId) {
    await garantirSchema();
    const chave = gerarChave();
    const { rowCount } = await pool.query(
      `UPDATE fila_atendimentos SET acesso_hashes = ARRAY[$2]::text[]
        WHERE id=$1
          AND COALESCE(cardinality(acesso_hashes),0) = 0
          AND criado_em < $3
          AND status = ANY($4::text[])`,
      [Number(atendimentoId), hashChave(chave), CORTE_LEGADO.toISOString().replace("Z", ""), [...STATUS_LEGADO]]
    );
    return rowCount ? chave : null;
  }

  async function pacienteDono(pacienteId, atendimentoId) {
    const { rows } = await pool.query(
      `SELECT f.id
         FROM fila_atendimentos f
         JOIN pacientes p ON p.id=$2
        WHERE f.id=$1
          AND (
            f.conta_paciente_id = p.id
            OR (f.conta_paciente_id IS NULL
                AND length(regexp_replace(COALESCE(p.cpf,''),'\\D','','g')) = 11
                AND length(regexp_replace(COALESCE(p.tel,''),'\\D','','g')) >= 10
                AND (regexp_replace(COALESCE(f.cpf,''),'\\D','','g') = regexp_replace(p.cpf,'\\D','','g')
                     OR regexp_replace(COALESCE(f.pagador_cpf,''),'\\D','','g') = regexp_replace(p.cpf,'\\D','','g'))
                AND RIGHT(regexp_replace(COALESCE(f.tel,''),'\\D','','g'), 11) = RIGHT(regexp_replace(p.tel,'\\D','','g'), 11))
          )
        LIMIT 1`,
      [Number(atendimentoId), Number(pacienteId)]
    );
    return rows.length > 0;
  }

  async function medicoAtivo(decoded) {
    const { rows } = await pool.query(
      "SELECT LOWER(TRIM(COALESCE(email,''))) AS email, ativo FROM medicos WHERE id=$1 LIMIT 1",
      [Number(decoded.id)]
    );
    return !!rows[0] && rows[0].ativo === true && rows[0].email === String(decoded.email || "").trim().toLowerCase();
  }

  // Retorna { ok, papel, chaveNova?, motivo? }.
  async function avaliar(req, atendimentoId, { legado = true } = {}) {
    await garantirSchema();
    const id = Number(atendimentoId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, motivo: "id_invalido" };
    const { rows } = await pool.query(
      "SELECT id, status, medico_id, acesso_hashes, criado_em FROM fila_atendimentos WHERE id=$1",
      [id]
    );
    const at = rows[0];
    if (!at) return { ok: false, motivo: "inexistente", inexistente: true };

    const chave = String(req.headers[CABECALHO_CHAVE] || "").trim();
    if (chave && Array.isArray(at.acesso_hashes) && at.acesso_hashes.includes(hashChave(chave))) {
      return { ok: true, papel: "chave" };
    }

    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    if (bearer) {
      let decoded = null;
      try { decoded = jwt.verify(bearer, segredo); } catch { decoded = null; }
      const tipo = classificarToken(decoded);
      if (tipo === "medico" && (await medicoAtivo(decoded))) {
        const admin = String(decoded.email || "").trim().toLowerCase() === ADMIN_EMAIL;
        const vinculado = at.medico_id != null && String(at.medico_id) === String(decoded.id);
        const adminSemMedico = String(at.medico_id) === "0" && admin;
        if (admin || vinculado || adminSemMedico || at.status === "aguardando") return { ok: true, papel: "medico" };
      }
      if (tipo === "paciente" && (await pacienteDono(decoded.id, id))) return { ok: true, papel: "paciente" };
    }

    if (legado && agora() < FIM_LEGADO) {
      const nova = await reivindicarLegado(id);
      if (nova) return { ok: true, papel: "legado", chaveNova: nova };
    }
    return { ok: false, motivo: chave ? "chave_invalida" : (bearer ? "token_sem_vinculo" : "sem_credencial") };
  }

  return { garantirSchema, emitirChave, avaliar };
}

// ── Documentos: links assinados no lugar das URLs públicas do R2 ─────────────
const PREFIXOS_PROTEGIDOS = ["chat/", "chat-esp/", "consultas/", "renovacao/"];

export function chaveObjetoProtegido(url, basePublica) {
  const base = String(basePublica || "").replace(/\/$/, "");
  if (!base || typeof url !== "string" || !url.startsWith(base + "/")) return null;
  const chave = decodeURIComponent(url.slice(base.length + 1).split(/[?#]/)[0]);
  if (chave.includes("..")) return null;
  return PREFIXOS_PROTEGIDOS.some((p) => chave.startsWith(p)) ? chave : null;
}

export function linkAssinado(chaveObjeto, { segredo = process.env.JWT_SECRET, apiBase = process.env.API_URL || "https://triagem-api.onrender.com", validade = "24h" } = {}) {
  const t = jwt.sign({ tipo: "arquivo", k: chaveObjeto }, segredo, { expiresIn: validade });
  return `${String(apiBase).replace(/\/$/, "")}/api/arquivo?t=${encodeURIComponent(t)}`;
}

export function protegerUrls(valor, basePublica, opts, profundidade = 0) {
  if (profundidade > 12 || valor == null) return valor;
  if (typeof valor === "string") {
    const k = chaveObjetoProtegido(valor, basePublica);
    return k ? linkAssinado(k, opts) : valor;
  }
  if (Array.isArray(valor)) return valor.map((v) => protegerUrls(v, basePublica, opts, profundidade + 1));
  if (typeof valor === "object" && !(valor instanceof Date) && !Buffer.isBuffer(valor)) {
    const out = {};
    for (const [k, v] of Object.entries(valor)) out[k] = protegerUrls(v, basePublica, opts, profundidade + 1);
    return out;
  }
  return valor;
}

export function lerLinkAssinado(t, segredo = process.env.JWT_SECRET) {
  try {
    const d = jwt.verify(String(t || ""), segredo);
    if (d?.tipo !== "arquivo" || typeof d.k !== "string") return null;
    if (!PREFIXOS_PROTEGIDOS.some((p) => d.k.startsWith(p)) || d.k.includes("..")) return null;
    return d.k;
  } catch { return null; }
}
