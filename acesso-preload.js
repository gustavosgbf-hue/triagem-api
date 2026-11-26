// Carregado antes dos demais preloads (ver package.json).
//  - Emite a chave de acesso quando um atendimento é criado em /api/notify.
//  - Troca URLs públicas de arquivos sensíveis por links assinados nas respostas JSON.
//  - Serve /api/arquivo, que valida o link assinado e redireciona para uma URL temporária do R2.
import express from "express";
import pg from "pg";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  criarAcessoAtendimento, exporChave, protegerUrls, lerLinkAssinado,
} from "./acesso-atendimento.js";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
export const acesso = criarAcessoAtendimento({ pool });
acesso.garantirSchema().catch((e) => console.warn("[ACESSO] Schema:", e.message));

const BASE_PUBLICA = () => String(process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");

let r2 = null;
function clienteR2() {
  if (!r2 && process.env.R2_ACCOUNT_ID) {
    r2 = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
  }
  return r2;
}

function criacaoDeAtendimento(req) {
  return String(req?.method || "").toUpperCase() === "POST"
    && req.path === "/api/notify"
    && !req.body?.atendimentoId;
}

const jsonOriginal = express.response.json;
express.response.json = function acessoJson(payload) {
  const res = this;
  const req = res.req;
  let corpo = payload;
  try {
    const base = BASE_PUBLICA();
    if (base && corpo && typeof corpo === "object" && req?.path !== "/api/arquivo") {
      corpo = protegerUrls(corpo, base);
    }
  } catch (e) {
    console.warn("[ACESSO] Falha ao proteger URLs:", e.message);
    corpo = payload;
  }
  const id = Number(corpo?.atendimentoId || 0);
  if (req && criacaoDeAtendimento(req) && corpo?.ok !== false && id > 0 && !res.headersSent) {
    acesso.emitirChave(id)
      .then((chave) => { if (chave && !res.headersSent) exporChave(res, id, chave); })
      .catch((e) => console.warn("[ACESSO] Emissão de chave falhou:", e.message))
      .finally(() => { if (!res.headersSent) jsonOriginal.call(res, corpo); });
    return res;
  }
  return jsonOriginal.call(res, corpo);
};

function instalar(app) {
  if (app.locals.__acessoInstalado) return;
  app.locals.__acessoInstalado = true;
  app.get("/api/arquivo", async (req, res) => {
    res.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer");
    const chave = lerLinkAssinado(req.query.t);
    if (!chave) return res.status(403).send("Link expirado ou inválido. Abra o documento novamente pelo atendimento.");
    const cliente = clienteR2();
    if (!cliente || !process.env.R2_BUCKET_NAME) return res.status(503).send("Arquivo indisponível no momento.");
    try {
      const url = await getSignedUrl(cliente, new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: chave }), { expiresIn: 300 });
      return res.redirect(302, url);
    } catch (e) {
      console.warn("[ARQUIVO] Falha ao assinar:", e.message);
      return res.status(503).send("Arquivo indisponível no momento.");
    }
  });
}

const initOriginal = express.application.init;
express.application.init = function acessoInit(...args) {
  const r = initOriginal.apply(this, args);
  instalar(this);
  return r;
};
