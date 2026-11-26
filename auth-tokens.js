// Classificação central dos tokens JWT emitidos pela plataforma.
//
// Todos os tokens são assinados com o mesmo JWT_SECRET, então a assinatura
// válida NÃO diz quem é o portador. Cada rota precisa conferir o tipo.
//
// Formatos emitidos hoje:
//   médico        { id, nome, email, crm }            (sem "tipo", legado do login do painel)
//   paciente      { id, tipo: 'paciente' }
//   psicólogo     { id, tipo: 'psicologo' }
//   especialista  { id, tipo: 'especialista', email }
//   link e-mail   { medicoId, atendimentoId, tipo: 'assumir' }
//   agendamento   { tipo: <acesso>, modulo, ag }
//   guest         { email, tipo: 'criar_senha_guest' }
//
// Um token de médico só é reconhecido quando tem exatamente o formato do
// login do painel (ou, no futuro, tipo 'medico' explícito). Qualquer outro
// "tipo" é recusado nas rotas profissionais.

function idInteiroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

export function classificarToken(decoded) {
  if (!decoded || typeof decoded !== "object") return null;
  const tipo = typeof decoded.tipo === "string" ? decoded.tipo.trim() : decoded.tipo;

  if (tipo === "paciente") return idInteiroPositivo(decoded.id) ? "paciente" : null;
  if (tipo === "psicologo") return idInteiroPositivo(decoded.id) ? "psicologo" : null;
  if (tipo === "especialista") return idInteiroPositivo(decoded.id) ? "especialista" : null;
  if (tipo === "medico") {
    return idInteiroPositivo(decoded.id) && typeof decoded.email === "string" && decoded.email.trim()
      ? "medico"
      : null;
  }
  if (tipo !== undefined && tipo !== null && tipo !== "") return "outro";

  // Formato legado do login médico: sem "tipo", com id, e-mail e a chave crm.
  if (
    idInteiroPositivo(decoded.id) &&
    typeof decoded.email === "string" && decoded.email.trim() &&
    Object.prototype.hasOwnProperty.call(decoded, "crm")
  ) {
    return "medico";
  }
  return null;
}

export function ehTokenMedico(decoded) {
  return classificarToken(decoded) === "medico";
}

export function ehTokenPrescritor(decoded) {
  const c = classificarToken(decoded);
  return c === "medico" || c === "especialista";
}

export function ehTokenPaciente(decoded) {
  return classificarToken(decoded) === "paciente";
}

// Cache curto da situação do médico no banco, para não consultar a cada
// requisição. Fecha em caso de dúvida (médico inexistente, inativo ou com
// e-mail diferente do token).
export function criarVerificadorMedicoAtivo(pool, { ttlMs = 30000 } = {}) {
  const cache = new Map();
  return async function medicoAtivo(decoded) {
    const id = Number(decoded?.id);
    const email = String(decoded?.email || "").trim().toLowerCase();
    if (!idInteiroPositivo(id) || !email) return false;
    const chave = `${id}|${email}`;
    const agora = Date.now();
    const hit = cache.get(chave);
    if (hit && hit.expira > agora) return hit.ok;
    const { rows } = await pool.query(
      "SELECT LOWER(TRIM(COALESCE(email,''))) AS email, ativo FROM medicos WHERE id=$1 LIMIT 1",
      [id]
    );
    const row = rows[0];
    const ok = !!row && row.ativo === true && row.email === email;
    cache.set(chave, { ok, expira: agora + ttlMs });
    if (cache.size > 2000) cache.clear();
    return ok;
  };
}
