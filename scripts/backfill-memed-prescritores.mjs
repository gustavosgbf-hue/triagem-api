import fs from "node:fs/promises";
import pg from "pg";
import {
  codigoErroMemed,
  normalizarDataIso,
  validarDadosPrescritor,
} from "../memed-utils.js";

const { Pool } = pg;
const args = process.argv.slice(2);
const fileIndex = args.indexOf("--file");
const databaseOnly = args.includes("--database-only");
const inputText = fileIndex >= 0
  ? await fs.readFile(args[fileIndex + 1], "utf8")
  : process.env.MEMED_REGULATORY_BACKFILL_JSON;

if (!inputText) {
  throw new Error("Informe --file <json> ou MEMED_REGULATORY_BACKFILL_JSON.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não configurada.");

const registros = JSON.parse(inputText);
if (!Array.isArray(registros) || !registros.length) {
  throw new Error("O backfill deve receber uma lista JSON não vazia.");
}

const MEMED_API_URL = process.env.MEMED_API_URL || "https://api.memed.com.br/v1";
const MEMED_API_KEY = process.env.MEMED_API_KEY || "";
const MEMED_SECRET_KEY = process.env.MEMED_SECRET_KEY || "";
if (!databaseOnly && (!MEMED_API_KEY || !MEMED_SECRET_KEY)) {
  throw new Error("MEMED_API_KEY e MEMED_SECRET_KEY são obrigatórias para sincronizar.");
}

function nomeComparavel(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(dr|dra|doutor|doutora)\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const ignorados = new Set([
  nomeComparavel("João Vitor Estanislau Reis"),
  nomeComparavel("Gabriel Angelo"),
]);

function montarPayload(row, registro, externalId) {
  const med = {
    ...row,
    cpf_medico: registro.cpf,
    data_nascimento_medico: registro.data_nascimento,
  };
  const dados = validarDadosPrescritor(med);
  if (dados.faltantes.length) {
    throw new Error(`Dados incompletos para ${registro.nome}: ${dados.faltantes.join(", ")}`);
  }
  const partes = String(row.nome_exibicao || row.nome).trim().split(/\s+/);
  return {
    data: {
      type: "usuarios",
      attributes: {
        external_id: externalId,
        nome: partes[0],
        sobrenome: partes.slice(1).join(" ") || "ConsultaJa",
        email: row.email,
        cpf: dados.cpf,
        data_nascimento: dados.dataNascimento,
        board: {
          board_code: "CRM",
          board_number: dados.crm,
          board_state: dados.uf,
        },
      },
    },
  };
}

async function memedRequest(path, method = "GET", payload) {
  const url = `${MEMED_API_URL}${path}${path.includes("?") ? "&" : "?"}api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
  const response = await fetch(url, {
    method,
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function sincronizarMemed(row, registro, externalId) {
  const payload = montarPayload(row, registro, externalId);
  const existente = await memedRequest(`/sinapse-prescricao/usuarios/${externalId}`);
  const { external_id: _externalId, email: _email, ...attributesAtualizaveis } = payload.data.attributes;
  const resultado = existente.ok
    ? await memedRequest(`/sinapse-prescricao/usuarios/${externalId}`, "PATCH", {
        data: { type: "usuarios", attributes: attributesAtualizaveis },
      })
    : existente.status === 404
      ? await memedRequest("/sinapse-prescricao/usuarios", "POST", payload)
      : existente;

  if (!resultado.ok) {
    throw new Error(`Memed recusou ${externalId}: status=${resultado.status} code=${codigoErroMemed(resultado.data) || "unknown"}`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  const medicos = (await pool.query(
    `SELECT id,nome,nome_exibicao,email,crm,uf,memed_external_id FROM medicos`
  )).rows;
  const especialistas = (await pool.query(
    `SELECT id,nome,nome_exibicao,email,crm,uf FROM especialistas`
  )).rows;

  for (const registro of registros) {
    const nome = nomeComparavel(registro.nome);
    if (!nome || ignorados.has(nome)) continue;
    const cpf = String(registro.cpf || "").replace(/\D/g, "");
    const dataNascimento = normalizarDataIso(registro.data_nascimento);
    if (cpf.length !== 11 || !dataNascimento) {
      throw new Error(`CPF ou data inválida para ${registro.nome || "registro sem nome"}.`);
    }

    const email = String(registro.email || "").trim().toLowerCase();
    const localizar = rows => {
      if (email) {
        const porEmail = rows.filter(row => String(row.email || "").toLowerCase() === email);
        if (porEmail.length) return porEmail;
      }
      const nomesCadastrados = row => [row.nome, row.nome_exibicao]
        .map(nomeComparavel)
        .filter(Boolean);
      const exatos = rows.filter(row => nomesCadastrados(row).includes(nome));
      if (exatos.length) return exatos;
      const tokens = nome.split(" ").filter(Boolean);
      const parciais = rows.filter(row => nomesCadastrados(row).some(nomeCadastrado => {
        const tokensCadastrados = new Set(nomeCadastrado.split(" "));
        return tokens.every(token => tokensCadastrados.has(token));
      }));
      if (parciais.length > 1) throw new Error(`Nome ambíguo: ${registro.nome}. Informe o e-mail.`);
      return parciais;
    };
    const alvos = [
      ...localizar(medicos).map(row => ({ tabela: "medicos", row })),
      ...localizar(especialistas).map(row => ({ tabela: "especialistas", row })),
    ];
    if (!alvos.length) throw new Error(`Prescritor não encontrado: ${registro.nome}`);

    for (const alvo of alvos) {
      await pool.query(
        `UPDATE ${alvo.tabela}
            SET cpf_medico=$1, data_nascimento_medico=$2
          WHERE id=$3`,
        [cpf, dataNascimento, alvo.row.id]
      );
      const medicoCanonico = alvo.tabela === "especialistas"
        ? medicos.find(medico => (
            email &&
            String(medico.email || "").trim().toLowerCase() === email
          ))
        : null;
      const externalId = alvo.tabela === "medicos"
        ? alvo.row.memed_external_id || `consultaja-${alvo.row.id}`
        : medicoCanonico?.memed_external_id || (medicoCanonico ? `consultaja-${medicoCanonico.id}` : `esp-${alvo.row.id}`);
      if (!databaseOnly) await sincronizarMemed(alvo.row, { ...registro, cpf, data_nascimento: dataNascimento }, externalId);
      if (alvo.tabela === "medicos" && !alvo.row.memed_external_id) {
        await pool.query(`UPDATE medicos SET memed_external_id=$1 WHERE id=$2`, [externalId, alvo.row.id]);
      }
      console.log(`[MEMED-BACKFILL] ${alvo.tabela} id=${alvo.row.id}: atualizado`);
    }
  }
} finally {
  await pool.end();
}
