export function normalizarCpf(valor) {
  return String(valor || "").replace(/\D/g, "");
}

export function normalizarDataIso(valor) {
  const texto = String(valor || "").trim();
  if (!texto) return "";
  const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const iso = br ? `${br[3]}-${br[2]}-${br[1]}` : texto;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";

  const [ano, mes, dia] = iso.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    data.getUTCFullYear() !== ano ||
    data.getUTCMonth() !== mes - 1 ||
    data.getUTCDate() !== dia ||
    data > new Date()
  ) return "";
  return iso;
}

export function formatarDataMemed(valor) {
  const iso = normalizarDataIso(valor);
  if (!iso) return "";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

export function normalizarTermo(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ALIASES_ALERGIA = new Map([
  ["novalgina", "dipirona"],
  ["dipirona sodica", "dipirona"],
  ["dipirona monoidratada", "dipirona"],
  ["dipirona mono hidratada", "dipirona"],
]);

export function extrairTermosAlergia(textoOriginal) {
  const original = String(textoOriginal || "").trim();
  const normalizado = normalizarTermo(original);
  if (
    !normalizado ||
    /^(nega|negada|negadas|nao|nenhuma|nenhum|sem alergia|nao informado|nao informada)$/.test(normalizado) ||
    /^nega alergia/.test(normalizado) ||
    /^nao (tem|possui|relata) alergia/.test(normalizado)
  ) return [];

  const semPrefixo = original
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:alergias|alergia|alergico|alergica)\b(?:\s+(?:a|ao|aos|as))?\s*:?\s*/gi, "")
    .replace(/[.;]/g, ",");

  const termos = semPrefixo
    .split(/\s*(?:,|\/|\be\b)\s*/i)
    .map(normalizarTermo)
    .filter(termo => termo && termo.length >= 3)
    .map(termo => ALIASES_ALERGIA.get(termo) || termo);

  return [...new Set(termos)].slice(0, 12);
}

export function encontrarIngredienteExato(termo, ingredientes = []) {
  const alvo = normalizarTermo(termo);
  if (!alvo) return null;

  for (const ingrediente of ingredientes) {
    const attributes = ingrediente?.attributes || {};
    const nomes = [
      attributes.name,
      attributes.slug,
      ...(String(attributes.related || "").split(","))
    ].map(normalizarTermo).filter(Boolean);
    if (nomes.includes(alvo)) {
      const id = Number(ingrediente?.id);
      return Number.isInteger(id) && id > 0 ? id : null;
    }
  }
  return null;
}

export function validarDadosPrescritor(medico = {}) {
  const cpf = normalizarCpf(medico.cpf_medico);
  const dataNascimento = formatarDataMemed(medico.data_nascimento_medico);
  const crm = String(medico.crm || "").replace(/\D/g, "");
  const uf = String(medico.uf || "").trim().toUpperCase();
  const faltantes = [];

  if (crm.length < 3) faltantes.push("CRM");
  if (!/^[A-Z]{2}$/.test(uf)) faltantes.push("UF do CRM");
  if (cpf.length !== 11) faltantes.push("CPF");
  if (!dataNascimento) faltantes.push("data de nascimento");

  return { cpf, dataNascimento, crm, uf, faltantes };
}

export function codigoErroMemed(data = {}) {
  const erro = Array.isArray(data?.errors) ? data.errors[0] : null;
  return String(
    erro?.code ||
    erro?.title ||
    data?.code ||
    data?.error ||
    ""
  ).trim().toLowerCase();
}

export function mensagemErroMemed(data = {}, status = 0) {
  const codigo = codigoErroMemed(data);
  if (codigo.includes("not_approved")) {
    return "Cadastro do prescritor não aprovado pela Memed. Confira CRM/UF, CPF e data de nascimento com os dados do CFM.";
  }
  if (status === 401 || status === 403) {
    return "A integração com a Memed recusou a autenticação. Contate o suporte da plataforma.";
  }
  return "A Memed não validou os dados do prescritor. Confira CRM/UF, CPF e data de nascimento.";
}
