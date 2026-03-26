import fs from "fs";
import https from "https";
import os from "os";
import path from "path";
import axios from "axios";
import express from "express";
import cors from "cors";
import { google } from "googleapis";
import pg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import { randomUUID } from "crypto";
import rateLimit from "express-rate-limit";
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const app = express();
app.set("trust proxy", 1); // Render passa IP real via X-Forwarded-For
app.use(cors({
  origin: [
    'https://consultaja24h.com.br',
    'https://www.consultaja24h.com.br',
    'https://painel.consultaja24h.com.br',
    'https://psicologia.consultaja24h.com.br',
    'https://triagem-api.onrender.com',
    /^https:\/\/.*\.pages\.dev$/,  // Cloudflare Pages previews
  ],
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const rlLogin = rateLimit({ windowMs: 60*1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas tentativas de login. Tente novamente em 1 minuto." }});
const rlMensagem = rateLimit({ windowMs: 60*1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Limite de mensagens atingido." }});
const rlUpload = rateLimit({ windowMs: 60*1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Limite de uploads atingido." }});
const rlTriagem = rateLimit({ windowMs: 60*1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas requisições de triagem. Aguarde." }});
const rlGeral = rateLimit({ windowMs: 60*1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { ok: false, error: "Muitas requisições. Aguarde." }});

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY nao definida"); process.exit(1); }
if (!JWT_SECRET) { console.error("JWT_SECRET nao definida"); process.exit(1); }

// LIMPEZA AUTOMATICA -- atendimentos travados em 'assumido' por mais de 48h
setInterval(async () => {
  try {
    const lock1 = await pool.query('SELECT pg_try_advisory_lock(10001)');
    if (!lock1.rows[0].pg_try_advisory_lock) return; // outra instância já está rodando
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'expirado', encerrado_em = NOW()
       WHERE status = 'assumido'
         AND assumido_em < NOW() - INTERVAL '48 hours'
       RETURNING id, nome`
    );
    if (result.rowCount > 0) {
      console.log("[LIMPEZA] " + result.rowCount + " atendimento(s) expirado(s):",
        result.rows.map(function(r){ return "#" + r.id + " " + r.nome; }).join(", "));
    }
  } catch(e) {
    console.error("[LIMPEZA] Erro:", e.message);
  }
}, 60 * 60 * 1000);

// JOB: Expirar agendamentos de psicologia sem pagamento após 30 minutos
setInterval(async () => {
  try {
    const lock3 = await pool.query('SELECT pg_try_advisory_lock(10006)');
    if (!lock3.rows[0].pg_try_advisory_lock) return;
    const result = await pool.query(
      `UPDATE agendamentos_psicologia
          SET status = 'cancelado'
        WHERE status = 'pendente'
          AND pagamento_status = 'pendente'
          AND criado_em < NOW() - INTERVAL '30 minutes'
        RETURNING id, paciente_nome`
    );
    if (result.rowCount > 0) {
      console.log(`[PSI-EXPIRY] ${result.rowCount} agendamento(s) expirado(s) por falta de pagamento:`,
        result.rows.map(r => `#${r.id} ${r.paciente_nome}`).join(', '));
    }
  } catch(e) {
    console.error('[PSI-EXPIRY] Erro:', e.message);
  }
}, 5 * 60 * 1000); // roda a cada 5 minutos

// JOB: Reenviar e-mail de agendamento 1h antes do horário marcado
setInterval(async () => {
  try {
    const lock2 = await pool.query('SELECT pg_try_advisory_lock(10002)');
    if (!lock2.rows[0].pg_try_advisory_lock) return;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return;
    // Agendamentos confirmados com horário entre 55min e 65min a partir de agora
    const result = await pool.query(
      `SELECT ag.*, fa.id AS fila_id, fa.triagem, fa.status AS fila_status
       FROM agendamentos ag
       LEFT JOIN fila_atendimentos fa ON fa.tel=ag.tel AND fa.status IN ('aguardando','triagem')
       WHERE ag.status='confirmado'
         AND ag.horario_agendado BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'
         AND ag.lembrete_enviado IS NOT DISTINCT FROM false`
    );
    for (const ag of result.rows) {
      if (!ag.fila_id) { console.log(`[LEMBRETE] Agendamento #${ag.id} sem fila ainda, pulando`); continue; }
      const API_URL = process.env.API_URL || "https://triagem-api.onrender.com";
      const PAINEL_URL = "https://painel.consultaja24h.com.br";
      const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
      const horarioFormatado = new Date(ag.horario_agendado).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
      const tipoLabel = ag.modalidade === "video" ? "Video" : "Chat";
      const linkRetorno = `${SITE_URL}/triagem.html?consulta=${ag.fila_id}`;
      // Busca médicos e envia e-mail com novo token válido por 3h
      const medicosResult = await pool.query(`SELECT id,nome,email FROM medicos WHERE ativo=true AND status='aprovado'`);
      const medicos = medicosResult.rows.filter(m=>m.email);
      if (!medicos.find(m=>m.email==="gustavosgbf@gmail.com")) medicos.push({id:0,nome:"Gustavo",email:"gustavosgbf@gmail.com"});
      // Marca ANTES do loop para evitar reprocessamento se job rodar novamente
      await pool.query(`UPDATE agendamentos SET lembrete_enviado=true WHERE id=$1`,[ag.id]);
      for (const med of medicos) {
        // Verifica se atendimento ainda está aguardando antes de cada envio
        const statusCheck = await pool.query(`SELECT status FROM fila_atendimentos WHERE id=$1`,[ag.fila_id]);
        const statusAtual = statusCheck.rows[0]?.status;
        if (statusAtual && !['aguardando','triagem'].includes(statusAtual)) {
          console.log(`[LEMBRETE] Agendamento #${ag.id} já assumido (status: ${statusAtual}) — interrompendo envios`);
          break;
        }
        const token = jwt.sign(
          { medicoId: med.id, medicoNome: med.nome, atendimentoId: ag.fila_id, tipo: "assumir" },
          JWT_SECRET,
          { expiresIn: "3h" }
        );
        const linkAssumir = `${API_URL}/api/atendimento/assumir-email?token=${token}`;
        const html = montarHtmlEmail({ nome: ag.nome, tel: ag.tel, tipo: ag.modalidade, triagem: ag.triagem, linkRetorno, linkAssumir, medicoNome: med.nome, horarioAgendado: horarioFormatado, isLembrete: true });
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "ConsultaJa24h <contato@consultaja24h.com.br>", to: [med.email], subject: `🔔 Lembrete: Agendamento em 1h - ${ag.nome} (${tipoLabel}) - ${horarioFormatado}`, html })
        });
        const resendData = await resendRes.json();
        if (resendData.id) console.log(`[LEMBRETE] Enviado para ${med.email} | Agendamento #${ag.id}`);
        await new Promise(r => setTimeout(r, 600)); // respeita rate limit Resend
      }
      // Lembrete para o paciente também
      if (ag.email && !ag.lembrete_paciente_enviado) {
        const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
        const linkConsulta = ag.fila_id ? `${SITE_URL}/triagem.html?consulta=${ag.fila_id}` : `${SITE_URL}/triagem.html`;
        await enviarEmailLembretePaciente({ nome: ag.nome, email: ag.email, horarioFormatado, modalidade: ag.modalidade, linkConsulta }).catch(()=>{});
        await pool.query(`UPDATE agendamentos SET lembrete_paciente_enviado=true WHERE id=$1`,[ag.id]);
      }
    }
  } catch(e) { console.error("[LEMBRETE] Erro:", e.message); }
}, 10 * 60 * 1000); // Roda a cada 10 minutos

// LIMPEZA AUTOMATICA -- historico: encerrados/expirados com mais de 10 anos viram 'arquivado'
setInterval(async () => {
  try {
    const lock3 = await pool.query('SELECT pg_try_advisory_lock(10003)');
    if (!lock3.rows[0].pg_try_advisory_lock) return;
    const result = await pool.query(
      `UPDATE fila_atendimentos
       SET status = 'arquivado'
       WHERE status IN ('encerrado', 'expirado')
         AND encerrado_em < NOW() - INTERVAL '10 years'
       RETURNING id`
    );
    if (result.rowCount > 0) {
      console.log("[HISTORICO] " + result.rowCount + " atendimento(s) arquivado(s).");
    }
  } catch(e) {
    console.error("[HISTORICO] Erro:", e.message);
  }
}, 6 * 60 * 60 * 1000);

// LEMBRETE ESPECIALISTAS — 1h antes
setInterval(async () => {
  try {
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return;
    const result = await pool.query(
      `SELECT e.id, e.paciente_nome, e.paciente_email, e.especialista_nome, e.especialidade, e.horario_agendado
         FROM agendamentos_especialistas e
        WHERE e.status = 'confirmado'
          AND e.pagamento_status = 'confirmado'
          AND e.lembrete_enviado IS NOT TRUE
          AND e.horario_agendado > NOW()
          AND e.horario_agendado <= NOW() + INTERVAL '1 hour'`
    );
    for (const ag of result.rows) {
      await pool.query(`UPDATE agendamentos_especialistas SET lembrete_enviado = true WHERE id = $1`, [ag.id]);
      const horarioFmt = new Date(ag.horario_agendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
      if (ag.paciente_email) {
        const html = `<div style="background:#faf8f5;padding:32px;font-family:'DM Sans',sans-serif">
          <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
            <div style="font-size:.72rem;color:#8a857f;margin-bottom:12px">🔔 Lembrete</div>
            <h2 style="color:#1a1612;margin:0 0 16px">Sua consulta é em 1 hora</h2>
            <div style="background:#e8f5e9;border-radius:12px;padding:16px;margin-bottom:16px">
              <div style="font-size:.85rem;color:#4a4540">Profissional: <strong>${ag.especialista_nome}</strong></div>
              <div style="font-size:.85rem;color:#4a4540">Especialidade: ${ag.especialidade}</div>
              <div style="font-size:1rem;font-weight:600;color:#388e3c">${horarioFmt}</div>
            </div>
            <p style="font-size:.85rem;color:#4a4540">O link de acesso será enviado em breve.</p>
          </div></div>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [ag.paciente_email], subject: `🔔 Sua consulta é em 1h — ${horarioFmt}`, html })
        });
      }
      const espRes = await pool.query(`SELECT email FROM especialistas WHERE nome_exibicao = $1 AND ativo = true`, [ag.especialista_nome]);
      if (espRes.rows[0]?.email) {
        const htmlEsp = `<div style="background:#faf8f5;padding:32px;font-family:'DM Sans',sans-serif">
          <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
            <div style="font-size:.72rem;color:#8a857f;margin-bottom:12px">🔔 Lembrete</div>
            <h2 style="color:#1a1612;margin:0 0 16px">Você tem consulta em 1 hora</h2>
            <div style="background:#e3f2fd;border-radius:12px;padding:16px;margin-bottom:16px">
              <div style="font-size:.85rem;color:#4a4540">Paciente: <strong>${ag.paciente_nome}</strong></div>
              <div style="font-size:.85rem;color:#4a4540">Especialidade: ${ag.especialidade}</div>
              <div style="font-size:1rem;font-weight:600;color:#1976d2">${horarioFmt}</div>
            </div>
          </div></div>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
          body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [espRes.rows[0].email], subject: `🔔 Consulta em 1h — ${ag.paciente_nome}`, html: htmlEsp })
        });
      }
      const ADMIN_EMAIL = "gustavosgbf@gmail.com";
      const htmlAdmin = `<div style="background:#faf8f5;padding:32px;font-family:'DM Sans',sans-serif">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:24px">
          <div style="font-size:.72rem;color:#8a857f;margin-bottom:12px">🔔 Lembrete</div>
          <div style="font-size:.85rem;color:#4a4540">Especialista: ${ag.especialista_nome} | Paciente: ${ag.paciente_nome} | ${horarioFmt}</div>
        </div></div>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [ADMIN_EMAIL], subject: `🔔 Lembrete: ${ag.especialidade} em 1h`, html: htmlAdmin })
      });
    }
  } catch(e) { console.error("[LEMBRETE-ESP] Erro:", e.message); }
}, 10 * 60 * 1000);

async function initDB() {
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS mensagens (
        id SERIAL PRIMARY KEY,
        atendimento_id INTEGER NOT NULL,
        autor TEXT NOT NULL,
        autor_id INTEGER,
        texto TEXT NOT NULL,
        arquivo_url TEXT,
        arquivo_tipo TEXT,
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS arquivo_url TEXT`);
    await pool.query(`ALTER TABLE mensagens ADD COLUMN IF NOT EXISTS arquivo_tipo TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS agendamentos (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        tel TEXT NOT NULL,
        tel_documentos TEXT,
        cpf TEXT,
        modalidade TEXT NOT NULL DEFAULT 'chat',
        horario_agendado TIMESTAMP NOT NULL,
        payment_id TEXT,
        status TEXT NOT NULL DEFAULT 'pendente',
        criado_em TIMESTAMP DEFAULT NOW()
      )`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'medico'`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pendente'`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS uf TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS telefone TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS especialidade TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS nome_exibicao TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS cnpj TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS tem_assinatura_digital BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS provedor_assinatura TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS tem_memed BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS memed_email TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS cpf_medico TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS data_nascimento_medico TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS memed_token TEXT`);
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS memed_external_id TEXT`);
    const cols = [
      ['status_atendimento','TEXT'],['documentos_emitidos','TEXT'],['meet_link','TEXT'],
      ['tel_documentos','TEXT'],['idade','TEXT'],['sexo','TEXT'],['alergias','TEXT'],
      ['cronicas','TEXT'],['medicacoes','TEXT'],['queixa','TEXT'],
      ['assumido_em','TIMESTAMP'],['encerrado_em','TIMESTAMP'],
      ['data_nascimento','TEXT'],
      ['prontuario','TEXT'],
      ['solicita','TEXT'],
      ['agendamento_id','INTEGER'],
      ['horario_agendado','TIMESTAMP'],
      ['email','TEXT'],
      ['aprovacao_token','TEXT'],
      ['pagamento_status','TEXT NOT NULL DEFAULT \'pendente\''],
      ['pagbank_order_id','TEXT'],
      ['pagamento_confirmado_em','TIMESTAMPTZ'],
      ['efi_charge_id','TEXT'],
    ];
    // Coluna para controle de lembrete de agendamento
    await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_enviado BOOLEAN DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE medicos ADD COLUMN IF NOT EXISTS precisa_trocar_senha BOOLEAN DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS email TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos ADD COLUMN IF NOT EXISTS lembrete_paciente_enviado BOOLEAN DEFAULT false`).catch(()=>{});
    for (const [col, tipo] of cols) {
      await pool.query(`ALTER TABLE fila_atendimentos ADD COLUMN IF NOT EXISTS ${col} ${tipo}`);
    }
    // ── PSICÓLOGOS: tabela e índices ──────────────────────────────────────────
    await pool.query(`CREATE TABLE IF NOT EXISTS psicologos (
      id              SERIAL PRIMARY KEY,
      nome            TEXT NOT NULL,
      nome_exibicao   TEXT NOT NULL,
      email           TEXT NOT NULL UNIQUE,
      senha_hash      TEXT NOT NULL,
      crp             TEXT NOT NULL,
      uf              TEXT NOT NULL,
      telefone        TEXT,
      abordagem       TEXT,
      focos           TEXT,
      valor_sessao    TEXT,
      atende_online   BOOLEAN NOT NULL DEFAULT true,
      tem_avaliacao   BOOLEAN NOT NULL DEFAULT false,
      valor_avaliacao TEXT,
      apresentacao    TEXT,
      disponibilidade TEXT,
      status          TEXT NOT NULL DEFAULT 'pendente',
      ativo           BOOLEAN NOT NULL DEFAULT false,
      created_at      TIMESTAMP DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_psicologos_status ON psicologos(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_psicologos_email  ON psicologos(email)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_psicologos_crp_uf ON psicologos(crp, uf)`);

    // ── PSICÓLOGOS: colunas extras e tabela de agendamentos separada ──────────
    await pool.query(`ALTER TABLE psicologos ADD COLUMN IF NOT EXISTS foto_url TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE psicologos ADD COLUMN IF NOT EXISTS formulario_url TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE psicologos ADD COLUMN IF NOT EXISTS valor_atualizado_em TIMESTAMP`).catch(()=>{});
    await pool.query(`ALTER TABLE psicologos ADD COLUMN IF NOT EXISTS visivel BOOLEAN NOT NULL DEFAULT true`).catch(()=>{});
    await pool.query(`ALTER TABLE psicologos ADD COLUMN IF NOT EXISTS sala_meet TEXT`).catch(()=>{});

    // Tabela de agendamentos de psicologia — fluxo separado dos médicos
    await pool.query(`CREATE TABLE IF NOT EXISTS agendamentos_psicologia (
      id                SERIAL PRIMARY KEY,
      psicologo_id      INTEGER NOT NULL REFERENCES psicologos(id),
      psicologo_nome    TEXT NOT NULL,
      paciente_nome     TEXT NOT NULL,
      paciente_email    TEXT NOT NULL,
      paciente_tel      TEXT,
      paciente_cpf      TEXT,
      tipo_consulta     TEXT NOT NULL DEFAULT 'psicoterapia',
      horario_agendado  TIMESTAMP NOT NULL,
      valor_cobrado     NUMERIC(10,2) NOT NULL,
      pagamento_metodo  TEXT,
      pagamento_status  TEXT NOT NULL DEFAULT 'pendente',
      pagbank_order_id  TEXT,
      efi_charge_id     TEXT,
      pagamento_confirmado_em TIMESTAMPTZ,
      formulario_enviado BOOLEAN DEFAULT false,
      status            TEXT NOT NULL DEFAULT 'pendente',
      observacoes       TEXT,
      criado_em         TIMESTAMP DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_psicologo ON agendamentos_psicologia(psicologo_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_paciente_email ON agendamentos_psicologia(paciente_email)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_status ON agendamentos_psicologia(pagamento_status)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_pagbank ON agendamentos_psicologia(pagbank_order_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_efi ON agendamentos_psicologia(efi_charge_id)`).catch(()=>{});

    // ── PACIENTES: tabela e índices ───────────────────────────────────────────
    await pool.query(`CREATE TABLE IF NOT EXISTS pacientes (
      id          SERIAL PRIMARY KEY,
      nome        TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      senha_hash  TEXT NOT NULL,
      cpf         TEXT,
      tel         TEXT,
      created_at  TIMESTAMP DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pacientes_email ON pacientes(email)`).catch(()=>{});
    // Vincula paciente logado ao agendamento de psicologia (nullable — compatível com agendamentos antigos)
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS paciente_id INTEGER REFERENCES pacientes(id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_paciente_id ON agendamentos_psicologia(paciente_id)`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS lembrete_psi_enviado BOOLEAN DEFAULT false`).catch(()=>{});
    // ── CONTROLE FINANCEIRO DE SESSÕES ────────────────────────────────────────
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS status_sessao TEXT NOT NULL DEFAULT 'agendado'`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS realizado_em TIMESTAMPTZ`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS valor_repasse NUMERIC(10,2)`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS pago_psicologo BOOLEAN NOT NULL DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS data_pagamento_psicologo TIMESTAMPTZ`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_status_sessao ON agendamentos_psicologia(status_sessao)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_psi_pago_psicologo ON agendamentos_psicologia(pago_psicologo)`).catch(()=>{});

    // Índices de performance para queries frequentes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensagens_atendimento ON mensagens(atendimento_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_mensagens_atendimento_criado ON mensagens(atendimento_id, criado_em)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_status ON fila_atendimentos(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_medico_id ON fila_atendimentos(medico_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_encerrado_em ON fila_atendimentos(encerrado_em)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_status ON agendamentos(status)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_agendamentos_horario ON agendamentos(horario_agendado)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_pagbank_order ON fila_atendimentos(pagbank_order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_efi_charge ON fila_atendimentos(efi_charge_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_fila_pagamento_status ON fila_atendimentos(pagamento_status)`);
    // ── ESPECIALISTAS ──────────────────────────────────────────────────────────
    await pool.query(`CREATE TABLE IF NOT EXISTS especialistas (
      id             SERIAL PRIMARY KEY,
      nome           TEXT NOT NULL,
      nome_exibicao  TEXT NOT NULL,
      especialidade  TEXT NOT NULL,
      crm            TEXT NOT NULL,
      uf             TEXT NOT NULL,
      valor_consulta NUMERIC(10,2) NOT NULL,
      foto_url       TEXT,
      bio            TEXT,
      email          TEXT,
      ativo          BOOLEAN NOT NULL DEFAULT true,
      disponibilidade JSONB,
      created_at     TIMESTAMP DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query(`ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS email TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS visivel BOOLEAN DEFAULT true`).catch(()=>{});
    await pool.query(`ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS foto_url TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS bio TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS disponibilidade JSONB`).catch(()=>{});
    await pool.query(`
      ALTER TABLE especialistas
      ALTER COLUMN disponibilidade TYPE JSONB
      USING CASE
        WHEN disponibilidade IS NULL OR trim(disponibilidade::text) = '' THEN NULL
        ELSE disponibilidade::jsonb
      END
    `).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS agendamentos_especialistas (
      id                      SERIAL PRIMARY KEY,
      especialista_id         INTEGER NOT NULL REFERENCES especialistas(id),
      especialista_nome       TEXT NOT NULL,
      especialidade           TEXT NOT NULL,
      paciente_nome           TEXT NOT NULL,
      paciente_email          TEXT NOT NULL,
      paciente_tel            TEXT,
      paciente_cpf            TEXT,
      horario_agendado        TIMESTAMP NOT NULL,
      valor_cobrado           NUMERIC(10,2) NOT NULL,
      pagamento_metodo        TEXT,
      pagamento_status        TEXT NOT NULL DEFAULT 'pendente',
      pagbank_order_id        TEXT,
      pagamento_confirmado_em TIMESTAMPTZ,
      status                  TEXT NOT NULL DEFAULT 'pendente',
      status_sessao           TEXT NOT NULL DEFAULT 'agendado',
      valor_repasse           NUMERIC(10,2),
      criado_em               TIMESTAMP DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_esp_especialista ON agendamentos_especialistas(especialista_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_esp_pagbank ON agendamentos_especialistas(pagbank_order_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_esp_status ON agendamentos_especialistas(pagamento_status)`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS paciente_id INTEGER REFERENCES pacientes(id)`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS efi_charge_id TEXT`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS lembrete_enviado BOOLEAN DEFAULT false`).catch(()=>{});
    await pool.query(`ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS link_sessao TEXT`).catch(()=>{});
    await pool.query(`CREATE TABLE IF NOT EXISTS consulta_mensagens (
      id SERIAL PRIMARY KEY,
      agendamento_id INTEGER NOT NULL,
      agendamento_type TEXT NOT NULL DEFAULT 'especialista',
      autor TEXT NOT NULL,
      texto TEXT,
      arquivo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_consulta_msgs ON consulta_mensagens(agendamento_id, agendamento_type)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_esp_paciente ON agendamentos_especialistas(paciente_id)`).catch(()=>{});
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_ag_esp_efi ON agendamentos_especialistas(efi_charge_id)`).catch(()=>{});
    // ── LEADS ──────────────────────────────────────────────────────────────────
    await pool.query(`CREATE TABLE IF NOT EXISTS leads_agendamento (
      id            SERIAL PRIMARY KEY,
      nome          TEXT,
      email         TEXT,
      tel           TEXT,
      especialidade TEXT,
      profissional  TEXT,
      horario       TEXT,
      modulo        TEXT NOT NULL DEFAULT 'especialistas',
      status        TEXT NOT NULL DEFAULT 'iniciou_agendamento',
      criado_em     TIMESTAMP DEFAULT NOW()
    )`).catch(()=>{});
    console.log("[DB] Tabelas, colunas e índices verificados com sucesso");
  } catch (e) {
    console.error("[DB] Erro no initDB:", e.message);
  }
}
initDB();

const SPREADSHEET_ID = "1z-m4_zJQOIelzOkiUvU8L7VP0CHxJHC317Lb-q0GVCQ";
const serviceAccount = {
  type: "service_account",
  project_id: "consultaja24h",
  private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID || "",
  private_key: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  client_email: process.env.GOOGLE_CLIENT_EMAIL || "",
  client_id: process.env.GOOGLE_CLIENT_ID || "",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
};

async function appendToSheet(sheetName, values) {
  try {
    const auth = new google.auth.GoogleAuth({ credentials: serviceAccount, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [values] },
    });
  } catch (e) {
    console.error(`[SHEETS] Erro ao salvar em ${sheetName}:`, e.message);
  }
}

function parsearTriagem(summary) {
  if (!summary) return {};
  const campos = {};

  // Mapa expandido de padrões por campo
  const mapa = [
    { chave: 'queixa',    padroes: ['queixa principal','queixa','motivo','problema principal','problema','chief complaint'] },
    { chave: 'idade',     padroes: ['idade'] },
    { chave: 'sexo',      padroes: ['sexo','gênero','genero'] },
    { chave: 'alergias',  padroes: ['alergia','alergias','hipersensibilidade'] },
    { chave: 'cronicas',  padroes: ['comorbidade','comorbidades','antecedente','antecedentes','doença crônica','doenças crônicas','historico','histórico'] },
    { chave: 'medicacoes',padroes: ['medicação','medicações','medicacao','medicacoes','medicamento','medicamentos','uso contínuo','uso continuo','faz uso'] },
    { chave: 'solicita',  padroes: ['solicita','solicitação','necessita','precisa','documentos','atestado','receita','pedido'] },
  ];

  // Tenta extrair por linha "Chave: Valor"
  const linhas = summary.split(/[\n;]/);
  for (const linha of linhas) {
    const colonIdx = linha.indexOf(':');
    if (colonIdx < 1) {
      // FIX 2: tenta capturar padrões sem dois-pontos ex: "Problema principal dor de garganta"
      // só para queixa (campo mais crítico que a IA omite os dois-pontos)
      if (!campos.queixa) {
        const linhaNorm = linha.trim().toLowerCase().replace(/[*•\-]/g, '').trim();
        for (const p of mapa[0].padroes) {
          if (linhaNorm.startsWith(p)) {
            const valor = linha.trim().slice(p.length).trim().replace(/^[:–—\s]+/, '');
            if (valor && valor.length > 2) { campos.queixa = valor; break; }
          }
        }
      }
      continue;
    }
    const chaveRaw = linha.slice(0, colonIdx).trim().toLowerCase().replace(/[*•\-]/g, '').trim();
    const valor = linha.slice(colonIdx + 1).trim().replace(/^[-–—]\s*/, '');
    if (!valor || /^(nega|não|nao|nenhum|sem)$/i.test(valor)) {
      // Guarda negativas também
      for (const { chave, padroes } of mapa) {
        if (padroes.some(p => chaveRaw.includes(p))) { campos[chave] = campos[chave] || valor || 'Nega'; break; }
      }
      continue;
    }
    for (const { chave, padroes } of mapa) {
      if (padroes.some(p => chaveRaw.includes(p))) { campos[chave] = campos[chave] || valor; break; }
    }
  }

  // Fallbacks por regex no texto livre
  if (!campos.idade) {
    const m = summary.match(/(\d{1,3})\s*anos/i);
    if (m) campos.idade = m[1] + ' anos';
  }
  if (!campos.sexo) {
    if (/\bfeminino\b|\bmulher\b|\bfeminina\b/i.test(summary)) campos.sexo = 'Feminino';
    else if (/\bmasculino\b|\bhomem\b|\bmasculina\b/i.test(summary)) campos.sexo = 'Masculino';
  }
  if (!campos.solicita) {
    if (/atestado/i.test(summary) && /receita/i.test(summary)) campos.solicita = 'Atestado + Receita';
    else if (/atestado/i.test(summary)) campos.solicita = 'Atestado';
    else if (/receita/i.test(summary)) campos.solicita = 'Receita';
    else if (/pedido.*exame|exame/i.test(summary)) campos.solicita = 'Pedido de exame';
    else campos.solicita = 'Não informado';
  }
  // FIX 2: fallback final para queixa — usa primeira linha não vazia do summary
  if (!campos.queixa) {
    const primeiraLinha = summary.split(/[\n;]/).map(l => l.trim()).find(l => l.length > 5 && !/^\{/.test(l));
    if (primeiraLinha) campos.queixa = primeiraLinha.replace(/^(queixa|problema|motivo)[:\s]*/i, '').slice(0, 200);
  }
  if (!campos.alergias) campos.alergias = 'Nega';
  if (!campos.cronicas) campos.cronicas = 'Nega';
  if (!campos.medicacoes) campos.medicacoes = 'Nega';

  return campos;
}

async function callOpenAI({ system, messages }) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model: "gpt-4o-mini", temperature: 0.3,
      messages: [
        { role: "system", content: String(system ?? "") },
        ...(messages || []).filter(m => m?.role !== "system").map(m => ({ role: m.role, content: String(m.content ?? "") })),
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data?.error?.message || JSON.stringify(data) };
  return { ok: true, text: data?.choices?.[0]?.message?.content || "" };
}

async function handleChat(req, res) {
  try {
    const { system, messages } = req.body || {};
    if (!system || !Array.isArray(messages)) return res.status(400).json({ ok: false, error: "Payload invalido" });
    const out = await callOpenAI({ system, messages });
    if (!out.ok) {
      console.error("[CHAT] Erro tecnico:", out.error);
      return res.status(503).json({ text: "Ops, tivemos uma instabilidade na mensagem. Por favor, tente enviar novamente." });
    }
    const text = String(out.text || "").replace(
      "Transmissão interrompida. Aguardando a mensagem completa…",
      "Ops, tivemos uma instabilidade na mensagem. Por favor, tente enviar novamente."
    );
    return res.json({ text });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ text: "Erro interno temporario." });
  }
}

function checkAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"] || req.query.senha;
  const senhaAdmin = process.env.ADMIN_PASSWORD;
  if (!senhaAdmin) return res.status(500).send("ADMIN_PASSWORD nao configurada");
  if (!senha || senha !== senhaAdmin) return res.status(403).send("Acesso negado");
  next();
}

function checkMedico(req, res, next) {
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return res.status(401).json({ ok: false, error: "Token nao fornecido" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.medico = decoded; req.medicoId = decoded.id; next();
  } catch(e) {
    return res.status(401).json({ ok: false, error: "Token invalido ou expirado" });
  }
}

const autenticarMedico = checkMedico;

app.post("/api/triage", rlTriagem, handleChat);
app.post("/api/doctor", handleChat);

// ── PAGBANK ───────────────────────────────────────────────────────────────────
const PAGBANK_TOKEN = process.env.PAGBANK_TOKEN?.trim();
const PAGBANK_URL   = "https://api.pagseguro.com";
const VALOR_CENTAVOS = 4990; // R$ 49,90 — fixo no backend

// Comissão da plataforma sobre sessões de psicologia (%)
// Pode ser sobrescrita por variável de ambiente PSI_COMISSAO_PCT
const PSI_COMISSAO_PCT = parseFloat(process.env.PSI_COMISSAO_PCT || '20');

if (!PAGBANK_TOKEN) console.error("[PAGBANK] Token não configurado");

app.post("/api/pagbank/order", async (req, res) => {
  try {
    const { nome, email, cpf } = req.body || {};
    if (!nome || !cpf) return res.status(400).json({ ok: false, error: "nome e cpf obrigatorios" });
    if (!PAGBANK_TOKEN) return res.status(503).json({ ok: false, error: "Gateway de pagamento indisponivel" });

    const expiracao    = new Date(Date.now() + 30 * 60 * 1000);
    const expiracaoISO = expiracao.toISOString().replace("Z", "-03:00");

    const orderBody = {
      reference_id: "CJ-" + Date.now() + "-" + Math.random().toString(36).slice(2,6).toUpperCase(),
      customer: {
        name:   nome,
        email:  email || `paciente.${cpf.replace(/\D/g,"")}@consultaja24h.com.br`,
        tax_id: cpf.replace(/\D/g, "")
      },
      items: [{ name: "Consulta Médica Online — ConsultaJá24h", quantity: 1, unit_amount: VALOR_CENTAVOS }],
      qr_codes: [{ amount: { value: VALOR_CENTAVOS }, expiration_date: expiracaoISO }],
      notification_urls: [
        `${process.env.API_URL || "https://triagem-api.onrender.com"}/api/pagbank/webhook`
      ]
    };

    const response = await fetch(`${PAGBANK_URL}/orders`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${PAGBANK_TOKEN}`, "Content-Type": "application/json", "accept": "application/json" },
      body: JSON.stringify(orderBody)
    });

    const data = await response.json();
    console.log("[PAGBANK] Order:", JSON.stringify(data).slice(0, 400));

    if (!response.ok) {
      console.error("[PAGBANK] Erro:", JSON.stringify(data));
      return res.status(400).json({ ok: false, error: data.error_messages || "Erro ao criar cobrança" });
    }

    const qrCode = data.qr_codes?.[0];
    if (!qrCode?.text) {
      console.error("[PAGBANK] QR Code ausente:", JSON.stringify(data));
      return res.status(502).json({ ok: false, error: "PagBank nao retornou QR Code. Verifique chave PIX cadastrada na conta." });
    }

    return res.json({ ok: true, order_id: data.id, qr_code_text: qrCode.text });
  } catch (e) {
    console.error("[PAGBANK] Erro:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Webhook PagBank — notificação de pagamento confirmado
// Responde 200 imediatamente -> processa de forma assincrona e idempotente
app.post("/api/pagbank/webhook", async (req, res) => {
  const event = req.body;
  if (!event || typeof event !== "object") {
    console.warn("[PAGBANK-WEBHOOK] Payload invalido recebido");
    return res.status(400).end();
  }

  // CORRETO: order_id real do PagBank é event.data.id (ex: "ORDE_...")
  // reference_id (ex: "CJ-...") e nosso identificador — NAO usar para busca no banco
  const orderId  = String(event?.data?.id || event?.id || "");
  const orderRef = String(event?.data?.reference_id ?? event?.reference_id ?? "");
  const charges  = event?.data?.charges || event?.charges || [];
  const pago     = charges.some(c => c.status === "PAID");

  console.log("[PAGBANK-WEBHOOK] Recebido — orderId:", orderId, "ref:", orderRef, "pago:", pago);

  // Responde 200 imediatamente — PagBank nao pode esperar processamento
  res.sendStatus(200);

  if (!pago || !orderId) return;

  try {
    // Atualiza atendimento imediato pelo pagbank_order_id — idempotente:
    // so avanca se ainda estiver 'pendente', prevenindo duplo processamento em retries
    const { rowCount, rows } = await pool.query(
      `UPDATE fila_atendimentos
          SET pagamento_status        = 'confirmado',
              pagamento_confirmado_em = NOW(),
              status = CASE
                WHEN status = 'pagamento_pendente' THEN 'triagem'
                WHEN status = 'triagem' THEN
                  CASE
                    WHEN LOWER(TRIM(triagem)) NOT IN (
                      '(aguardando pagamento)',
                      '(pagamento confirmado — aguardando triagem)',
                      '(triagem em andamento)',
                      '(aguardando triagem de agendamento)',
                      '(aguardando resposta)'
                    ) THEN 'aguardando'
                    ELSE 'triagem'
                  END
                ELSE status
              END
        WHERE pagbank_order_id = $1
          AND pagamento_status  = 'pendente'
        RETURNING id, nome, tel, cpf, tipo, triagem, status`,
      [orderId]
    );

    if (rowCount === 0) {
      console.log("[PAGBANK-WEBHOOK] Order " + orderId + " nao encontrado pelo pagbank_order_id — tentando fallback por fila_atendimentos.");

      // Fallback 1: fila_atendimentos sem pagbank_order_id ainda vinculado (race condition vincular-order)
      const fbFila = await pool.query(
        `UPDATE fila_atendimentos
            SET pagamento_status        = 'confirmado',
                pagamento_confirmado_em = NOW(),
                pagbank_order_id        = $1,
                status = CASE
                  WHEN status = 'pagamento_pendente' THEN 'triagem'
                  WHEN status = 'triagem' THEN
                    CASE
                      WHEN LOWER(TRIM(triagem)) NOT IN (
                        '(aguardando pagamento)',
                        '(pagamento confirmado — aguardando triagem)',
                        '(triagem em andamento)',
                        '(aguardando triagem de agendamento)',
                        '(aguardando resposta)'
                      ) THEN 'aguardando'
                      ELSE 'triagem'
                    END
                  ELSE status
                END
          WHERE pagbank_order_id IS NULL
            AND pagamento_status  = 'pendente'
            AND criado_em > NOW() - INTERVAL '2 hours'
          ORDER BY criado_em DESC
          LIMIT 1
          RETURNING id, nome, tel, cpf, tipo, triagem, status`,
        [orderId]
      ).catch(e => { console.warn("[PAGBANK-WEBHOOK] Fallback fila_atendimentos:", e.message); return { rowCount: 0, rows: [] }; });

      if (fbFila.rowCount > 0) {
        const atFb = fbFila.rows[0];
        console.log("[PAGBANK-WEBHOOK] Fallback fila_atendimentos: atendimento #" + atFb.id + " atualizado via race-condition recovery.");
        if (atFb.status === 'aguardando' && !isTriagemPlaceholder(atFb.triagem)) {
          await notificarMedicos(atFb);
        }
        return;
      }

      console.warn("[PAGBANK-WEBHOOK] Order " + orderId + " nao encontrada em nenhum atendimento — ignorando.");
      return;
    }

    const at = rows[0];
    console.log("[PAGBANK-WEBHOOK] Pagamento confirmado — atendimento #" + at.id + " status:" + at.status);

    // Notifica medicos apenas se o atendimento esta pronto (triagem real ja preenchida)
    // Se status ainda e 'triagem', o /api/atendimento/atualizar-triagem notifica quando concluir
    if (at.status === 'aguardando' && !isTriagemPlaceholder(at.triagem)) {
      await notificarMedicos(at);
    }

  } catch (e) {
    console.error("[PAGBANK-WEBHOOK] Erro no processamento:", e.message);
  }
});

// Consultar status de uma order PagBank — usado como fallback de polling
app.get("/api/pagbank/order/:id", async (req, res) => {
  try {
    if (!PAGBANK_TOKEN) return res.status(503).json({ ok: false, error: "Gateway indisponivel" });
    const response = await fetch(`${PAGBANK_URL}/orders/${req.params.id}`, {
      headers: { "Authorization": `Bearer ${PAGBANK_TOKEN}`, "accept": "application/json" }
    });
    const data = await response.json();
    // Verifica pagamento tanto em charges quanto em qr_codes
    const pago = data.charges?.some(c => c.status === "PAID") || false;
    return res.json({ ok: true, status: data.status, pago });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper para montar HTML do email
function montarHtmlEmail({ nome, tel, tipo, triagem, linkRetorno, linkAssumir, medicoNome, horarioAgendado, isLembrete }) {
  const tipoLabel = tipo === "video" ? "Video" : "Chat";
  const telLimpo = String(tel||"").replace(/\D/g,"");
  function montarTabelaTriagem(texto) {
    if (!texto) return '<tr><td colspan="2">-</td></tr>';
    return texto.split(/[;\n]/).map(item => {
      const ci = item.indexOf(":");
      if (ci>0) { const k=item.slice(0,ci).trim(); const v=item.slice(ci+1).trim(); return `<tr><td style="padding:8px 12px;color:rgba(255,255,255,.45);font-size:12px;width:150px">${k}</td><td style="padding:8px 12px;color:#fff;font-size:13px">${v}</td></tr>`; }
      return `<tr><td colspan="2" style="padding:8px 12px;color:rgba(255,255,255,.7);font-size:13px">${item.trim()}</td></tr>`;
    }).join("");
  }
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:20px 28px"><h2 style="margin:0;color:#051208;font-size:18px">Novo paciente aguardando atendimento — ConsultaJa24h</h2></div>
    <div style="padding:28px">
      <div style="margin-bottom:18px;padding:10px 16px;background:rgba(94,224,160,.07);border:1px solid rgba(94,224,160,.2);border-radius:10px;font-size:12px;color:rgba(94,224,160,.85)">\u2705 Pagamento confirmado automaticamente via PagBank</div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:140px">Paciente</td><td style="padding:8px 0;font-weight:600">${nome||"-"}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0;font-weight:600">${telLimpo}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Modalidade</td><td style="padding:8px 0;font-weight:600">${tipoLabel}</td></tr>
        ${horarioAgendado ? `<tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">📅 Horário</td><td style="padding:8px 0;font-weight:700;color:#b4e05a;font-size:15px">${horarioAgendado}</td></tr>` : ''}
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">WhatsApp</td><td style="padding:8px 0"><a href="https://wa.me/55${telLimpo}" style="background:#25D366;color:#fff;padding:6px 16px;border-radius:999px;text-decoration:none;font-size:13px;font-weight:600">Chamar no WhatsApp</a></td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;border:1px solid rgba(255,255,255,.1);border-radius:10px">${montarTabelaTriagem(triagem)}</table>
      ${isLembrete ? `<div style="margin:16px 0;padding:12px 16px;background:rgba(255,189,46,.08);border:1px solid rgba(255,189,46,.25);border-radius:10px;font-size:12px;color:rgba(255,189,46,.9)">⚠️ Esta triagem foi feita no momento do agendamento e pode estar desatualizada. Confirme os dados com o paciente no início da consulta.</div>` : ""}
      <div style="margin-top:24px;text-align:center">
        ${linkAssumir ? `
        <a href="${linkAssumir}" style="display:inline-block;padding:14px 32px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-family:Arial,sans-serif;font-size:15px;font-weight:700;text-decoration:none;margin-bottom:12px">
          ▶ Assumir atendimento
        </a>
        <p style="margin:8px 0 16px;font-size:11px;color:rgba(255,255,255,.3)">Primeiro a clicar assume. Link válido por 2h.</p>` : ''}
        <a href="https://painel.consultaja24h.com.br" style="display:inline-block;padding:11px 24px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:rgba(255,255,255,.7);font-family:Arial,sans-serif;font-size:13px;font-weight:600;text-decoration:none">
          🔑 Acessar o painel
        </a>
        <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,.2)">Entre com seu login para atender</p>
      </div>
      <p style="margin:20px 0 0;font-size:12px;color:rgba(255,255,255,.3)">Enviado automaticamente pelo sistema ConsultaJa24h</p>
    </div>
  </div>`;
}

async function enviarEmailMedicos({ nome, tel, tipo, triagem, linkRetorno, subject, atendimentoId, horarioAgendado, horarioAgendadoRaw }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn("[EMAIL] RESEND_API_KEY nao definida."); return; }
  try {
    const medicosResult = await pool.query(`SELECT id,nome,email FROM medicos WHERE ativo=true AND status='aprovado' ORDER BY status_online DESC`);
    const medicos = medicosResult.rows.filter(m=>m.email);
    // Garante que o admin sempre recebe
    // Admin sempre primeiro
    const adminEmail = "gustavosgbf@gmail.com";
    const adminIdx = medicos.findIndex(m=>m.email===adminEmail);
    if (adminIdx > 0) medicos.splice(adminIdx, 1);
    if (adminIdx !== 0) medicos.unshift({ id: 0, nome: "Gustavo", email: adminEmail });

    const PAINEL_URL = "https://painel.consultaja24h.com.br";
    const API_URL = process.env.API_URL || "https://triagem-api.onrender.com";
    // Envia e-mail individual para cada médico com token único
    // Token expira 4h após o horário do agendamento (ou 2h para imediatos)
    let tokenExpiresAt;
    if (horarioAgendado && horarioAgendadoRaw) {
      const horarioDate = new Date(horarioAgendadoRaw);
      tokenExpiresAt = Math.floor(horarioDate.getTime() / 1000) + 4 * 60 * 60; // +4h após horário
    }
    for (const med of medicos) {
      const tokenPayload = { medicoId: med.id, medicoNome: med.nome, atendimentoId, tipo: "assumir" };
      const tokenOpts = tokenExpiresAt
        ? { expiresIn: Math.max(tokenExpiresAt - Math.floor(Date.now()/1000), 3600) } // mínimo 1h
        : { expiresIn: "2h" };
      const token = jwt.sign(tokenPayload, JWT_SECRET, tokenOpts);
      const linkAsumir = `${API_URL}/api/atendimento/assumir-email?token=${token}`;
      const html = montarHtmlEmail({ nome, tel, tipo, triagem, linkRetorno, linkAsumir, medicoNome: med.nome, horarioAgendado });
      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: "ConsultaJa24h <contato@consultaja24h.com.br>", to: [med.email], subject, html })
      });
      const resendData = await resendRes.json();
      if (resendData.id) console.log("[EMAIL] Enviado para:", med.email, "| ID:", resendData.id);
      else console.error("[EMAIL] Resend recusou para", med.email, ":", JSON.stringify(resendData));
      // Delay para respeitar rate limit do Resend (max 2 req/s)
      await new Promise(r => setTimeout(r, 600));
    }
  } catch(e) {
    console.error("[EMAIL] Erro:", e.message);
  }
}

// ── E-MAIL: novo cadastro de médico (só para o admin) ──────────────────────────
async function enviarEmailNovoCadastroMedico({ nome, email, crm, uf, especialidade, telefone }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn("[EMAIL-MEDICO] RESEND_API_KEY nao definida."); return; }
  try {
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,255,255,.4);margin-left:8px">Novo cadastro pendente</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:20px">Um novo médico solicitou acesso à plataforma:</p>
          <table style="width:100%;border-collapse:collapse;font-size:.85rem">
            <tr><td style="color:rgba(255,255,255,.4);padding:6px 0;width:40%">Nome</td><td style="color:#fff;font-weight:500">${nome}</td></tr>
            <tr><td style="color:rgba(255,255,255,.4);padding:6px 0">E-mail</td><td style="color:#fff">${email}</td></tr>
            <tr><td style="color:rgba(255,255,255,.4);padding:6px 0">CRM</td><td style="color:#fff">${crm}/${uf}</td></tr>
            ${especialidade ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Especialidade</td><td style="color:#fff">${especialidade}</td></tr>` : ''}
            ${telefone ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Telefone</td><td style="color:#fff">${telefone}</td></tr>` : ''}
          </table>
          <p style="margin:20px 0 0;font-size:.78rem;color:rgba(255,255,255,.3)">Acesse o painel admin para aprovar ou rejeitar este cadastro.</p>
        </div>
      </div>
    </div>`;
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: "ConsultaJá24h <contato@consultaja24h.com.br>",
        to: ["gustavosgbf@gmail.com"],
        subject: `⚕️ Novo cadastro pendente: ${nome} (CRM ${crm}/${uf})`,
        html
      })
    });
    const d = await resendRes.json();
    if (d.id) console.log("[EMAIL-MEDICO] Aviso admin enviado | ID:", d.id);
    else console.error("[EMAIL-MEDICO] Resend recusou:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-MEDICO] Erro:", e.message); }
}

// ── E-MAIL: aprovação de médico (só para o médico aprovado) ────────────────────
async function enviarEmailAprovacaoMedico({ nome, email }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn("[EMAIL-APROVACAO] RESEND_API_KEY nao definida."); return; }
  try {
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:1rem;margin-bottom:12px">Olá, <strong>${nome}</strong>!</p>
          <p style="color:rgba(255,255,255,.75);font-size:.9rem;line-height:1.6;margin-bottom:20px">
            Seu cadastro na plataforma <strong style="color:#b4e05a">ConsultaJá24h</strong> foi aprovado. Você já pode acessar o painel médico e começar a atender.
          </p>
          <a href="https://painel.consultaja24h.com.br" style="display:inline-block;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">
            Acessar o painel →
          </a>
          <p style="margin:20px 0 0;font-size:.78rem;color:rgba(255,255,255,.3)">
            Em caso de dúvidas, entre em contato com a equipe da plataforma.
          </p>
        </div>
      </div>
    </div>`;
    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: "ConsultaJá24h <contato@consultaja24h.com.br>",
        to: [email],
        subject: "✅ Seu cadastro foi aprovado — ConsultaJá24h",
        html
      })
    });
    const d = await resendRes.json();
    if (d.id) console.log("[EMAIL-APROVACAO] Enviado para:", email, "| ID:", d.id);
    else console.error("[EMAIL-APROVACAO] Resend recusou:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-APROVACAO] Erro:", e.message); }
}

// ── E-MAIL: confirmação de agendamento para o PACIENTE ─────────────────────────
async function enviarEmailConfirmacaoPaciente({ nome, email, horarioFormatado, modalidade, linkConsulta }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;
  try {
    const tipoLabel = modalidade === "video" ? "Vídeo" : "Chat";
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,255,255,.4);margin-left:8px">Agendamento confirmado</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:20px">Olá, <strong>${nome}</strong>! Seu agendamento foi confirmado.</p>
          <div style="background:rgba(180,224,90,.07);border:1px solid rgba(180,224,90,.2);border-radius:12px;padding:16px 20px;margin-bottom:20px">
            <div style="font-size:.72rem;color:rgba(255,255,255,.4);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px">Data e horário</div>
            <div style="font-size:1.2rem;font-weight:700;color:#b4e05a">${horarioFormatado}</div>
            <div style="font-size:.82rem;color:rgba(255,255,255,.5);margin-top:4px">Modalidade: ${tipoLabel}</div>
          </div>
          <p style="color:rgba(255,255,255,.65);font-size:.85rem;line-height:1.6;margin-bottom:20px">
            Na hora marcada, acesse o link abaixo para entrar na sala de espera. O médico já estará preparado com sua triagem.
          </p>
          <a href="${linkConsulta}" style="display:inline-block;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">
            Entrar na consulta →
          </a>
          <p style="margin:20px 0 0;font-size:.72rem;color:rgba(255,255,255,.25)">Você receberá um lembrete 1h antes do horário.</p>
        </div>
      </div>
    </div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [email], subject: `✅ Agendamento confirmado — ${horarioFormatado}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-PACIENTE] Confirmação enviada para:", email);
    else console.error("[EMAIL-PACIENTE] Erro:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-PACIENTE] Erro:", e.message); }
}

// ── E-MAIL: lembrete 1h antes para o PACIENTE ──────────────────────────────────
async function enviarEmailLembretePaciente({ nome, email, horarioFormatado, modalidade, linkConsulta }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;
  try {
    const tipoLabel = modalidade === "video" ? "Vídeo" : "Chat";
    const html = `
    <div style="background:#060d0b;padding:32px 20px;font-family:'Outfit',sans-serif">
      <div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)">
          <span style="font-size:1.1rem;font-weight:700;color:#b4e05a">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,189,46,.7);margin-left:8px">🔔 Lembrete — consulta em 1h</span>
        </div>
        <div style="padding:24px">
          <p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:16px">Olá, <strong>${nome}</strong>! Sua consulta começa em aproximadamente <strong style="color:#b4e05a">1 hora</strong>.</p>
          <div style="background:rgba(255,189,46,.06);border:1px solid rgba(255,189,46,.2);border-radius:12px;padding:14px 18px;margin-bottom:20px">
            <div style="font-size:1.1rem;font-weight:700;color:#ffbd2e">${horarioFormatado}</div>
            <div style="font-size:.8rem;color:rgba(255,255,255,.45);margin-top:4px">${tipoLabel}</div>
          </div>
          <a href="${linkConsulta}" style="display:inline-block;padding:12px 28px;border-radius:12px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">
            Entrar na sala de espera →
          </a>
        </div>
      </div>
    </div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [email], subject: `🔔 Lembrete: sua consulta é em 1h — ${horarioFormatado}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-LEMBRETE-PACIENTE] Enviado para:", email);
    else console.error("[EMAIL-LEMBRETE-PACIENTE] Erro:", JSON.stringify(d));
  } catch(e) { console.error("[EMAIL-LEMBRETE-PACIENTE] Erro:", e.message); }
}

// ── E-MAIL: confirmação para especialista ───────────────────────────────────────
async function enviarEmailConfirmacaoEspecialista({ especialista, especialidade, paciente, email, horario }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !email) return;
  try {
    const html = `<div style="background:#faf8f5;padding:32px 20px;font-family:'DM Sans',sans-serif">
      <div style="max-width:500px;margin:0 auto;background:#fff;border:1px solid rgba(26,22,18,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(26,22,18,.08)">
          <span style="font-size:1.1rem;font-weight:600;color:#1a1612">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:#8a857f;margin-left:8px">Nova consulta</span>
        </div>
        <div style="padding:24px">
          <p style="color:#4a4540;font-size:.95rem;margin-bottom:16px">Olá, <strong>${especialista}</strong>!</p>
          <p style="color:#4a4540;font-size:.9rem;margin-bottom:20px">Você tem uma nova consulta confirmada:</p>
          <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:12px;padding:16px;margin-bottom:20px">
            <div style="font-size:.72rem;color:#1b5e20;text-transform:uppercase;margin-bottom:4px">Paciente</div>
            <div style="font-size:1rem;font-weight:600;color:#1b5e20">${paciente}</div>
          </div>
          <div style="font-size:.88rem;color:#4a4540;margin-bottom:8px"><strong>Especialidade:</strong> ${especialidade}</div>
          <div style="font-size:.88rem;color:#4a4540"><strong>Horário:</strong> ${horario}</div>
        </div>
      </div></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [email], subject: `📅 Nova consulta confirmada — ${horario}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-ESP] Confirmacao enviada para:", email);
  } catch(e) { console.error("[EMAIL-ESP] Erro:", e.message); }
}

// ── E-MAIL: notificação para admin ────────────────────────────────────────────────
async function enviarEmailConfirmacaoAdmin({ especialidade, especialista, paciente, email, horario, status }) {
  const ADMIN_EMAIL = "gustavosgbf@gmail.com";
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;
  try {
    const statusLabel = status === "confirmado" ? "✅ Confirmado" : status === "cancelado" ? "❌ Cancelado" : "ℹ️ " + status;
    const html = `<div style="background:#faf8f5;padding:32px 20px;font-family:'DM Sans',sans-serif">
      <div style="max-width:500px;margin:0 auto;background:#fff;border:1px solid rgba(26,22,18,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(26,22,18,.08);background:#1a1612">
          <span style="font-size:1.1rem;font-weight:600;color:#fff">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,255,255,.6);margin-left:8px">Notificação</span>
        </div>
        <div style="padding:24px">
          <div style="font-size:.72rem;color:#8a857f;text-transform:uppercase;margin-bottom:8px">${statusLabel}</div>
          <h2 style="color:#1a1612;font-size:1.1rem;margin:0 0 20px">Novo agendamento de especialista</h2>
          <div style="background:#f5f5f5;border-radius:12px;padding:16px;margin-bottom:16px">
            <div style="display:grid;grid-template-columns:100px 1fr;gap:8px;font-size:.85rem;color:#4a4540">
              <div style="color:#8a857f">Especialidade</div><div><strong>${especialidade}</strong></div>
              <div style="color:#8a857f">Profissional</div><div>${especialista}</div>
              <div style="color:#8a857f">Paciente</div><div>${paciente}</div>
              <div style="color:#8a857f">E-mail</div><div>${email||'-'}</div>
              <div style="color:#8a857f">Horário</div><div>${horario}</div>
            </div>
          </div>
        </div>
      </div></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [ADMIN_EMAIL], subject: `📋 Agendamento ${especialidade}: ${status} — ${paciente}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-ADMIN] Notificacao enviada para admin");
  } catch(e) { console.error("[EMAIL-ADMIN] Erro:", e.message); }
}

// ── E-MAIL: cancelamento para admin ──────────────────────────────────────────────
async function enviarEmailCancelamentoAdmin({ especialidade, especialista, paciente, email, horario, motivo }) {
  const ADMIN_EMAIL = "gustavosgbf@gmail.com";
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;
  try {
    const html = `<div style="background:#faf8f5;padding:32px 20px;font-family:'DM Sans',sans-serif">
      <div style="max-width:500px;margin:0 auto;background:#fff;border:1px solid rgba(26,22,18,.08);border-radius:16px;overflow:hidden">
        <div style="padding:24px;border-bottom:1px solid rgba(26,22,18,.08);background:#dc2626">
          <span style="font-size:1.1rem;font-weight:600;color:#fff">ConsultaJá24h</span>
          <span style="font-size:.8rem;color:rgba(255,255,255,.6);margin-left:8px">Cancelamento</span>
        </div>
        <div style="padding:24px">
          <div style="font-size:.72rem;color:#dc2626;text-transform:uppercase;margin-bottom:8px">❌ Agendamento cancelado</div>
          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:12px;padding:16px;margin-bottom:16px">
            <div style="display:grid;grid-template-columns:100px 1fr;gap:8px;font-size:.85rem;color:#4a4540">
              <div style="color:#8a857f">Especialidade</div><div><strong>${especialidade}</strong></div>
              <div style="color:#8a857f">Profissional</div><div>${especialista}</div>
              <div style="color:#8a857f">Paciente</div><div>${paciente}</div>
              <div style="color:#8a857f">E-mail</div><div>${email||'-'}</div>
              <div style="color:#8a857f">Horário</div><div>${horario}</div>
              ${motivo ? `<div style="color:#8a857f">Motivo</div><div>${motivo}</div>` : ''}
            </div>
          </div>
        </div>
      </div></div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: "ConsultaJá24h <contato@consultaja24h.com.br>", to: [ADMIN_EMAIL], subject: `❌ Cancelamento: ${especialidade} — ${paciente}`, html })
    });
    const d = await r.json();
    if (d.id) console.log("[EMAIL-ADMIN-CANCEL] Notificacao enviada para admin");
  } catch(e) { console.error("[EMAIL-ADMIN-CANCEL] Erro:", e.message); }
}

// Lista explicita de placeholders — sem LIKE, comparacao direta
const TRIAGEM_PLACEHOLDERS = new Set([
  '(aguardando pagamento)',
  '(pagamento confirmado — aguardando triagem)',
  '(triagem em andamento)',
  '(aguardando triagem de agendamento)',
  '(aguardando resposta)',
]);

function isTriagemPlaceholder(triagem) {
  if (!triagem) return true;
  return TRIAGEM_PLACEHOLDERS.has(triagem.trim().toLowerCase());
}

// Mantido por compatibilidade com /api/notify
function ehPlaceholder(triagem) {
  return isTriagemPlaceholder(triagem);
}

// Notificacao centralizada: unica fonte de verdade para envio de email aos medicos
async function notificarMedicos(at) {
  const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
  const linkRetorno = SITE_URL + "/triagem.html?consulta=" + at.id;
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });

  appendToSheet("Atendimentos", [
    agora, at.nome||"", at.tel||"", at.cpf||"",
    "Aguardando", "", at.triagem||"", at.tipo||"", "", String(at.id)
  ]).catch(() => {});

  await enviarEmailMedicos({
    nome: at.nome, tel: at.tel, tipo: at.tipo,
    triagem: at.triagem, linkRetorno,
    atendimentoId: at.id,
    horarioAgendado: null, horarioAgendadoRaw: null,
    subject: "Novo paciente aguardando atendimento — " + (at.nome || "Paciente")
  });

  console.log("[NOTIFICACAO] Medicos notificados — atendimento #" + at.id);
}

// ── Helper: libera atendimento para médicos (timer + endpoint de aprovação) ───
async function liberarAtendimentoParaMedicos(atendimentoId) {
  const r = await pool.query(
    `UPDATE fila_atendimentos SET status='aguardando', aprovacao_token=NULL
     WHERE id=$1 AND status='aguardando_aprovacao' RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos`,
    [atendimentoId]
  );
  if (r.rowCount === 0) {
    console.log(`[APROVACAO] #${atendimentoId} já foi liberado ou cancelado — ignorando.`);
    return;
  }
  const at = r.rows[0];
  const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
  const linkRetorno = `${SITE_URL}/triagem.html?consulta=${at.id}`;
  const tipoLabel = at.tipo === "video" ? "Video" : "Chat";
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
  appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Aguardando","",at.triagem||"",at.tipo||"","",String(at.id)]).catch(()=>{});
  await enviarEmailMedicos({
    nome: at.nome, tel: at.tel, tipo: at.tipo, triagem: at.triagem, linkRetorno,
    atendimentoId: at.id, horarioAgendado: null, horarioAgendadoRaw: null,
    subject: `Nova triagem - ${at.nome||"Paciente"} (${tipoLabel})`
  });
  console.log(`[LIBERADO] Atendimento #${atendimentoId} liberado para médicos.`);
}

app.post("/api/atendimento/atualizar-triagem", async (req, res) => {
  try {
    const { atendimentoId, triagem, agendamentoId } = req.body || {};
    if (!atendimentoId || !triagem) return res.status(400).json({ ok: false, error: "atendimentoId e triagem sao obrigatorios" });
    const campos = parsearTriagem(triagem);

    // ── AGENDAMENTO: fluxo original sem interceptação ──────────────────────
    if (agendamentoId) {
      const result = await pool.query(
        `UPDATE fila_atendimentos SET triagem=$2,queixa=$3,idade=$4,sexo=$5,alergias=$6,cronicas=$7,medicacoes=$8,solicita=$9,status='aguardando'
         WHERE id=$1 AND status IN ('triagem','aguardando') RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos,medico_nome`,
        [atendimentoId,triagem,campos.queixa||triagem,campos.idade||"",campos.sexo||"",campos.alergias||"",campos.cronicas||"",campos.medicacoes||"",campos.solicita||""]
      );
      if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado ou ja em andamento" });
      const at = result.rows[0];
      const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
      const linkRetorno = `${SITE_URL}/triagem.html?consulta=${at.id}`;
      const tipoLabel = at.tipo === "video" ? "Video" : "Chat";
      const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
      const agRow = await pool.query(`SELECT horario_agendado FROM agendamentos WHERE id=$1`,[agendamentoId]);
      let horarioAgendado = null, horarioAgendadoRaw = null;
      if (agRow.rows[0]) {
        horarioAgendadoRaw = agRow.rows[0].horario_agendado;
        horarioAgendado = new Date(horarioAgendadoRaw).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
        await pool.query(`UPDATE fila_atendimentos SET horario_agendado=$1, agendamento_id=$2 WHERE id=$3`,[horarioAgendadoRaw, agendamentoId, atendimentoId]);
      }
      appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Aguardando","",triagem,at.tipo||"","",String(at.id)]).catch(e=>console.error("[Sheets]",e));
      if (!isTriagemPlaceholder(triagem)) {
        await enviarEmailMedicos({
          nome: at.nome, tel: at.tel, tipo: at.tipo, triagem, linkRetorno,
          atendimentoId: at.id, horarioAgendado, horarioAgendadoRaw,
          subject: "Agendamento - " + (at.nome||"Paciente") + " (" + tipoLabel + ") - " + horarioAgendado
        });
      } else {
        console.warn(`[TRIAGEM-AGEND] triagem placeholder detectada em agendamento #${at.id} — e-mail suprimido`);
      }
      return res.json({ ok: true, atendimentoId: at.id });
    }

    // ── CONSULTA IMEDIATA: verifica pagamento_status para decidir se libera agora ──
    const check = await pool.query(
      "SELECT pagamento_status, pagbank_order_id FROM fila_atendimentos WHERE id = $1",
      [atendimentoId]
    );
    if (!check.rows[0]) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });

    let pagamentoConfirmado = check.rows[0].pagamento_status === 'confirmado';

    // Se ainda pendente, consulta PagBank diretamente — cobre casos onde webhook falhou na entrega
    if (!pagamentoConfirmado && check.rows[0].pagbank_order_id && PAGBANK_TOKEN) {
      try {
        const pbRes = await fetch(`${PAGBANK_URL}/orders/${check.rows[0].pagbank_order_id}`, {
          headers: { "Authorization": `Bearer ${PAGBANK_TOKEN}`, "accept": "application/json" }
        });
        const pbData = await pbRes.json();
        const pagoNaPagBank = pbData.charges?.some(c => c.status === "PAID") || false;
        if (pagoNaPagBank) {
          // Confirma no banco para não depender do webhook atrasado
          await pool.query(
            `UPDATE fila_atendimentos SET pagamento_status='confirmado', pagamento_confirmado_em=NOW() WHERE id=$1`,
            [atendimentoId]
          );
          pagamentoConfirmado = true;
          console.log("[TRIAGEM] Pagamento confirmado via consulta direta PagBank — atendimento #" + atendimentoId);
        }
      } catch (e) {
        console.warn("[TRIAGEM] Falha ao consultar PagBank diretamente:", e.message);
      }
    }

    // Se pagamento confirmado -> vai direto para 'aguardando' e notifica medicos
    // Se ainda pendente -> salva triagem mas mantém 'triagem'; webhook notifica quando chegar
    const novoStatus = pagamentoConfirmado ? 'aguardando' : 'triagem';

    const result = await pool.query(
      `UPDATE fila_atendimentos
          SET triagem=$2, queixa=$3, idade=$4, sexo=$5, alergias=$6, cronicas=$7,
              medicacoes=$8, solicita=$9, status=$10, aprovacao_token=NULL
        WHERE id=$1 AND status IN ('triagem','aguardando','aguardando_aprovacao','pagamento_pendente')
        RETURNING id,nome,tel,cpf,tipo,triagem,tel_documentos`,
      [atendimentoId, triagem, campos.queixa||triagem, campos.idade||"", campos.sexo||"",
       campos.alergias||"", campos.cronicas||"", campos.medicacoes||"", campos.solicita||"",
       novoStatus]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    const at = result.rows[0];

    if (novoStatus === 'aguardando') {
      await notificarMedicos(at);
      console.log("[TRIAGEM] Atendimento #" + at.id + " liberado — pagamento confirmado, medicos notificados.");
    } else {
      console.log("[TRIAGEM] Atendimento #" + at.id + " — triagem salva, aguardando confirmacao de pagamento.");
    }

    return res.json({ ok: true, atendimentoId: at.id });

  } catch (e) {
    console.error("Erro em /api/atendimento/atualizar-triagem:", e);
    return res.status(500).json({ ok: false, error: "Erro ao atualizar triagem" });
  }
});

// ── ROTA PÚBLICA: busca paciente por WhatsApp para autopreenchimento ──────────
// Sem autenticação — retorna apenas campos básicos para UX de retorno
app.get("/api/paciente/buscar", rlGeral, async (req, res) => {
  try {
    let tel = (req.query.tel || "").replace(/\D/g, "");
    // Normaliza: remove DDI 55 se presente
    if (tel.length > 11 && tel.startsWith("55")) tel = tel.slice(2);
    if (tel.length < 10) return res.json({ ok: false });
    // Busca o atendimento mais recente do paciente com este número
    const result = await pool.query(
      `SELECT nome, tel, data_nascimento
         FROM fila_atendimentos
        WHERE regexp_replace(tel, '\D', '', 'g') LIKE $1
        ORDER BY criado_em DESC
        LIMIT 1`,
      [`%${tel}`]
    );
    if (result.rows.length === 0) return res.json({ ok: false });
    const p = result.rows[0];
    return res.json({
      ok: true,
      paciente: {
        nome: p.nome || "",
        tel: p.tel || "",
        data_nascimento: p.data_nascimento || ""
      }
    });
  } catch (e) {
    console.error("Erro em /api/paciente/buscar:", e);
    return res.json({ ok: false });
  }
});

app.post("/api/notify", rlTriagem, async (req, res) => {
  try {
    const { nome, tel, tel_documentos, cpf, triagem, tipo, data_nascimento } = req.body || {};
    const tipoConsulta = tipo === "video" ? "video" : "chat";
    const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
    const campos = parsearTriagem(triagem);
    // STATUS:
    // 'pagamento_pendente' = pré-registro antes do pagamento confirmado — invisível para o painel médico
    // 'triagem' = pagamento confirmado, triagem em andamento
    // 'aguardando' = triagem concluída + pagamento confirmado — visível para médicos
    const statusInicial = ehPlaceholder(triagem) ? 'pagamento_pendente' : 'aguardando';
    const insertResult = await pool.query(
      `INSERT INTO fila_atendimentos (nome,tel,tel_documentos,cpf,tipo,triagem,status,queixa,idade,sexo,alergias,cronicas,medicacoes,data_nascimento)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [nome||"-",tel||"-",tel_documentos||tel||"-",cpf||"-",tipoConsulta,triagem||"",statusInicial,
       campos.queixa||triagem||"",campos.idade||"",campos.sexo||"",campos.alergias||"",campos.cronicas||"",campos.medicacoes||"",data_nascimento||""]
    );
    const atendimentoId = insertResult.rows[0]?.id;
    const linkRetorno = `${SITE_URL}/triagem.html?consulta=${atendimentoId}`;
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    appendToSheet("Atendimentos",[agora,nome||"",tel||"",cpf||"",statusInicial,"",triagem||"",tipoConsulta||"","",String(atendimentoId)]).catch(e=>console.error("[Sheets]",e));

    // Email NÃO é disparado aqui — o /api/atendimento/atualizar-triagem dispara após triagem real concluída
    // Isso evita email duplicado quando notify recebe triagem real diretamente
    if (!ehPlaceholder(triagem)) {
      console.log("[EMAIL-NOTIFY] Triagem real recebida via notify — email será disparado pelo atualizar-triagem");
    } else {
      console.log("[EMAIL-NOTIFY] Pre-registro, email suprimido. Status:", statusInicial);
    }

    return res.json({ ok: true, atendimentoId, linkRetorno });
  } catch (e) {
    console.error("Notify error:", e);
    if (!res.headersSent) return res.status(500).json({ ok: false });
  }
});

app.post("/api/chat/upload", rlUpload, upload.single("arquivo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Nenhum arquivo enviado" });
    const { atendimentoId, autor, autorId } = req.body || {};
    if (!atendimentoId || !autor) return res.status(400).json({ ok: false, error: "atendimentoId e autor obrigatorios" });
    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const tipo = req.file.mimetype.startsWith("image/") ? "imagem" : "pdf";
    const key = `chat/${randomUUID()}.${ext}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const url = `${process.env.R2_PUBLIC_URL}/${key}`;
    const result = await pool.query(
      `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto,arquivo_url,arquivo_tipo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,criado_em`,
      [atendimentoId, autor, autorId || null, "", url, tipo]
    );
    return res.json({ ok: true, mensagem: result.rows[0] });
  } catch (e) { console.error("Erro em /api/chat/upload:", e); return res.status(500).json({ ok: false, error: "Erro ao fazer upload" }); }
});

app.post("/api/chat/enviar", rlMensagem, async (req, res) => {
  try {
    const { atendimentoId, autor, autorId, texto, arquivo_url, arquivo_tipo } = req.body || {};
    if (!atendimentoId||!autor||(!texto&&!arquivo_url)) return res.status(400).json({ ok: false, error: "Campos obrigatorios: atendimentoId, autor, texto ou arquivo" });
    if (!["paciente","medico"].includes(autor)) return res.status(400).json({ ok: false, error: "autor deve ser paciente ou medico" });
    const result = await pool.query(
      `INSERT INTO mensagens (atendimento_id,autor,autor_id,texto,arquivo_url,arquivo_tipo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,criado_em`,
      [atendimentoId,autor,autorId||null,(texto||"").trim(),arquivo_url||null,arquivo_tipo||null]
    );
    return res.json({ ok: true, mensagem: result.rows[0] });
  } catch (e) { console.error("Erro em /api/chat/enviar:", e); return res.status(500).json({ ok: false, error: "Erro ao enviar mensagem" }); }
});

app.get("/api/chat/:atendimentoId", async (req, res) => {
  try {
    const { atendimentoId } = req.params;
    const auth = req.headers["authorization"] || "";
    const token = auth.replace("Bearer ","").trim();
    let autorizado = false;
    if (token) { try { jwt.verify(token, JWT_SECRET); autorizado=true; } catch(e){} }
    if (!autorizado) { const check = await pool.query(`SELECT id FROM fila_atendimentos WHERE id=$1`,[atendimentoId]); autorizado=check.rowCount>0; }
    if (!autorizado) return res.status(403).json({ ok: false, error: "Acesso negado" });
    const result = await pool.query(`SELECT id,atendimento_id,autor,texto,arquivo_url,arquivo_tipo,criado_em FROM mensagens WHERE atendimento_id=$1 ORDER BY criado_em ASC`,[atendimentoId]);
    return res.json({ ok: true, mensagens: result.rows });
  } catch (e) { console.error("Erro em /api/chat/:id:", e); return res.status(500).json({ ok: false, error: "Erro ao buscar mensagens" }); }
});

app.get("/api/atendimento/status/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, status, tipo, medico_nome, meet_link, criado_em, assumido_em, encerrado_em,
              nome, tel, cpf, data_nascimento, idade, sexo, alergias, cronicas, medicacoes, queixa, email,
              pagamento_status, pagbank_order_id, efi_charge_id
         FROM fila_atendimentos WHERE id = $1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });

    const at = result.rows[0];

    // Fallback: se pagamento ainda pendente, consulta PagBank diretamente
    // (cobre atraso de webhook ou reconexão do usuário antes do webhook chegar)
    if (at.pagamento_status === 'pendente' && at.pagbank_order_id && PAGBANK_TOKEN) {
      try {
        const pbRes  = await fetch(`${PAGBANK_URL}/orders/${at.pagbank_order_id}`, {
          headers: { Authorization: `Bearer ${PAGBANK_TOKEN}`, accept: 'application/json' }
        });
        const pbData = await pbRes.json();
        const pago   = pbData.charges?.some(c => c.status === 'PAID') || false;
        if (pago) {
          await pool.query(
            `UPDATE fila_atendimentos
                SET pagamento_status        = 'confirmado',
                    pagamento_confirmado_em = NOW(),
                    status = CASE
                      WHEN status = 'pagamento_pendente' THEN 'triagem'
                      ELSE status
                    END
              WHERE id = $1 AND pagamento_status = 'pendente'`,
            [at.id]
          ).catch(e => console.warn('[STATUS-FALLBACK] Update PagBank:', e.message));
          at.pagamento_status = 'confirmado';
          if (at.status === 'pagamento_pendente') at.status = 'triagem';
          console.log(`[STATUS-FALLBACK] Atendimento #${at.id} confirmado via consulta PagBank direta`);
        }
      } catch (e) {
        console.warn('[STATUS-FALLBACK] Falha ao consultar PagBank:', e.message);
      }
    }

    return res.json({ ok: true, atendimento: at });
  } catch (e) { return res.status(500).json({ ok: false, error: "Erro ao buscar status" }); }
});

app.post("/api/identify", async (req, res) => {
  try {
    const { nome, tel } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    const ip = req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"-";
    await pool.query("INSERT INTO identificacoes (nome,tel,data,ip) VALUES ($1,$2,$3,$4)",[nome||"-",tel||"-",agora,ip]);
    await appendToSheet("Identificacoes",[agora,nome||"",tel||"",ip]);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false }); }
});

app.post("/api/consent", async (req, res) => {
  try {
    const { nome, tel, versao } = req.body || {};
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    const ip = req.headers["x-forwarded-for"]||req.socket?.remoteAddress||"-";
    await pool.query("INSERT INTO consentimentos (nome,tel,versao,data,ip) VALUES ($1,$2,$3,$4,$5)",[nome||"-",tel||"-",versao||"v1.0",agora,ip]);
    await appendToSheet("Consentimentos",[agora,nome||"",tel||"",versao||"v1.0",ip]);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false }); }
});

app.get("/api/atendimento/assumir-email", async (req, res) => {
  const PAINEL_URL = "https://painel.consultaja24h.com.br";
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("<h2>Link inválido.</h2>");
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); }
    catch(e) { return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060d0b;color:#fff"><h2 style="color:#ff8080">⏰ Link expirado</h2><p>Este link de assumir atendimento expirou (válido por 2h).</p><a href="${PAINEL_URL}" style="color:#b4e05a">Ir para o painel</a></body></html>`); }
    if (payload.tipo !== "assumir") return res.status(400).send("<h2>Token inválido.</h2>");
    const { medicoId, medicoNome, atendimentoId } = payload;
    // Tenta assumir com trava — só um médico consegue
    const result = await pool.query(
      `UPDATE fila_atendimentos SET status='assumido', medico_id=$1, medico_nome=$2, assumido_em=NOW()
       WHERE id=$3 AND status='aguardando' RETURNING id,nome`,
      [medicoId, medicoNome, atendimentoId]
    );
    if (result.rowCount === 0) {
      // Verifica o status atual para dar feedback correto
      const ja = await pool.query(`SELECT status, medico_nome FROM fila_atendimentos WHERE id=$1`,[atendimentoId]);
      const row = ja.rows[0];
      if (!row) {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060d0b;color:#fff"><h2 style="color:#ff8080">❌ Atendimento não encontrado</h2><p>Este atendimento não existe ou foi removido.</p><a href="${PAINEL_URL}" style="color:#b4e05a">Ir para o painel</a></body></html>`);
      }
      if (row.status === 'triagem' || row.status === 'pagamento_pendente') {
        return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060d0b;color:#fff"><h2 style="color:#ffbd2e">⏳ Paciente ainda em triagem</h2><p>O paciente ainda não concluiu a triagem.<br>Você receberá uma nova notificação quando estiver pronto para atendimento.</p><a href="${PAINEL_URL}" style="color:#b4e05a">Ir para o painel</a></body></html>`);
      }
      const quem = row.medico_nome || "outro médico";
      return res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:60px;background:#060d0b;color:#fff"><h2 style="color:#ffbd2e">⚠️ Atendimento já assumido</h2><p>Este atendimento já foi assumido por <strong>${quem}</strong>.</p><a href="${PAINEL_URL}" style="color:#b4e05a">Ir para o painel</a></body></html>`);
    }
    const paciente = result.rows[0];
    console.log(`[ASSUMIR-EMAIL] ${medicoNome} assumiu atendimento #${atendimentoId} (${paciente.nome}) via e-mail`);
    // Redireciona para o painel com o atendimento já marcado
    return res.redirect(`${PAINEL_URL}?assumiu=${atendimentoId}`);
  } catch(e) {
    console.error("[ASSUMIR-EMAIL] Erro:", e.message);
    return res.status(500).send("<h2>Erro interno.</h2>");
  }
});

app.get("/atender", async (req, res) => {
  try {
    const { medico, paciente, tel } = req.query;
    if (!tel) return res.status(400).send("Parametros invalidos");
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    await pool.query("INSERT INTO logs_atendimentos (medico,paciente,tel,data) VALUES ($1,$2,$3,$4)",[medico||"desconhecido",paciente||"-",tel,agora]);
    await appendToSheet("Atendimentos",[agora,paciente||"",tel||"","","Assumido",medico||"","","","",""]);
    return res.redirect(`https://wa.me/55${String(tel).replace(/\D/g,"")}`);
  } catch (e) { return res.status(500).send("Erro ao assumir atendimento"); }
});

app.post("/api/medico/cadastro", async (req, res) => {
  try {
    const { nome, nome_exibicao, email, senha, crm, uf, telefone, especialidade,
            cnpj, tem_assinatura_digital, provedor_assinatura, tem_memed, memed_email } = req.body || {};
    if (!nome||!email||!senha||!crm||!uf) return res.status(400).json({ ok: false, error: "Todos os campos obrigatorios devem ser preenchidos" });
    if (senha.length<6) return res.status(400).json({ ok: false, error: "Senha deve ter ao menos 6 caracteres" });
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO medicos (nome,nome_exibicao,email,senha_hash,crm,uf,telefone,especialidade,
        cnpj,tem_assinatura_digital,provedor_assinatura,tem_memed,memed_email,
        status_online,ativo,role,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,false,'medico','pendente') RETURNING id,nome,nome_exibicao,email`,
      [nome.trim(),(nome_exibicao||nome).trim(),email.trim().toLowerCase(),senha_hash,
       crm.trim().toUpperCase(),uf.trim().toUpperCase(),telefone||"",especialidade||"",
       cnpj||"",!!tem_assinatura_digital,provedor_assinatura||"",!!tem_memed,memed_email||""]
    );
    const med = result.rows[0];
    // E-mail só para o admin — nunca para outros médicos
    enviarEmailNovoCadastroMedico({ nome: med.nome, email: med.email, crm: crm.trim().toUpperCase(), uf: uf.trim().toUpperCase(), especialidade: especialidade||"", telefone: telefone||"" }).catch(()=>{});
    return res.json({ ok: true, medico: med });
  } catch (err) {
    if (err.code==="23505") return res.status(400).json({ ok: false, error: "E-mail ja cadastrado" });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PSICÓLOGOS ───────────────────────────────────────────────────────────────

function authPsicologo(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Token nao fornecido' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.tipo !== 'psicologo') return res.status(401).json({ ok: false, error: 'Token invalido' });
    req.psicologo = decoded;
    req.psicologoId = decoded.id;
    next();
  } catch(e) {
    return res.status(401).json({ ok: false, error: 'Token invalido ou expirado' });
  }
}

// ── PACIENTES ─────────────────────────────────────────────────────────────────

function authPaciente(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Token nao fornecido' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.tipo !== 'paciente') return res.status(401).json({ ok: false, error: 'Token invalido' });
    req.paciente = decoded;
    req.pacienteId = decoded.id;
    next();
  } catch(e) {
    return res.status(401).json({ ok: false, error: 'Token invalido ou expirado' });
  }
}

// POST /api/paciente/cadastro
app.post('/api/paciente/cadastro', rlGeral, async (req, res) => {
  try {
    const { nome, email, senha, cpf, tel } = req.body || {};
    if (!nome || !email || !senha) {
      return res.status(400).json({ ok: false, error: 'Nome, e-mail e senha são obrigatórios' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ ok: false, error: 'E-mail inválido' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ ok: false, error: 'Senha deve ter ao menos 6 caracteres' });
    }
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO pacientes (nome, email, senha_hash, cpf, tel)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nome, email, cpf, tel`,
      [nome.trim(), email.trim().toLowerCase(), senha_hash, (cpf||'').trim(), (tel||'').trim()]
    );
    const pac = result.rows[0];
    const token = jwt.sign({ id: pac.id, tipo: 'paciente' }, JWT_SECRET, { expiresIn: '7d' });
    // Sheets — aba separada para pacientes de psicologia
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    appendToSheet('Psicologia_Pacientes', [agora, pac.nome, pac.email, pac.tel || '', pac.cpf || '']).catch(()=>{});
    // E-mail de boas-vindas
    enviarEmailBoasVindasPaciente({ nome: pac.nome, email: pac.email }).catch(()=>{});
    return res.json({ ok: true, token, paciente: pac });
  } catch(err) {
    if (err.code === '23505') return res.status(400).json({ ok: false, error: 'E-mail já cadastrado' });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/paciente/login
app.post('/api/paciente/login', rlLogin, async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ ok: false, error: 'E-mail e senha são obrigatórios' });
    const result = await pool.query(
      `SELECT id, nome, email, cpf, tel, senha_hash FROM pacientes WHERE email=$1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (result.rowCount === 0) return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    const pac = result.rows[0];
    const senhaOk = await bcrypt.compare(senha, pac.senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    const token = jwt.sign({ id: pac.id, tipo: 'paciente' }, JWT_SECRET, { expiresIn: '7d' });
    const { senha_hash: _, ...pacPublico } = pac;
    return res.json({ ok: true, token, paciente: pacPublico });
  } catch(err) { return res.status(500).json({ ok: false, error: 'Erro interno no login' }); }
});

// GET /api/paciente/me
app.get('/api/paciente/me', authPaciente, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, email, cpf, tel FROM pacientes WHERE id=$1 LIMIT 1`,
      [req.pacienteId]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Paciente não encontrado' });
    return res.json({ ok: true, paciente: result.rows[0] });
  } catch(err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// GET /api/paciente/agendamentos — psicologia + especialistas (conta universal)
app.get('/api/paciente/agendamentos', authPaciente, async (req, res) => {
  try {
    const { rows: psi } = await pool.query(
      `SELECT ap.id,
              ap.psicologo_nome   AS profissional_nome,
              ap.tipo_consulta,
              ap.horario_agendado,
              ap.valor_cobrado,
              ap.pagamento_status,
              ap.status,
              ap.criado_em,
              ps.formulario_url,
              ap.link_sessao,
              'psicologia' AS modulo
         FROM agendamentos_psicologia ap
         LEFT JOIN psicologos ps ON ps.id = ap.psicologo_id
        WHERE ap.paciente_id = $1
        ORDER BY ap.horario_agendado DESC`,
      [req.pacienteId]
    );
    const { rows: esp } = await pool.query(
      `SELECT ae.id,
              ae.especialista_nome AS profissional_nome,
              ae.especialidade     AS tipo_consulta,
              ae.horario_agendado,
              ae.valor_cobrado,
              ae.pagamento_status,
              ae.status,
              ae.criado_em,
              ae.link_sessao,
              NULL AS formulario_url,
              'especialista' AS modulo
         FROM agendamentos_especialistas ae
        WHERE ae.paciente_id = $1
        ORDER BY ae.horario_agendado DESC`,
      [req.pacienteId]
    );
    const todos = [...psi, ...esp].sort((a, b) =>
      new Date(b.horario_agendado) - new Date(a.horario_agendado)
    );
    return res.json({ ok: true, agendamentos: todos });
  } catch(err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// DELETE /api/paciente/agendamento/:id — cancela agendamento (paciente)
app.delete('/api/paciente/agendamento/:id', authPaciente, async (req, res) => {
  try {
    const agId = parseInt(req.params.id, 10);
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    // Busca e valida posse + regra de negócio
    // Aceita agendamentos vinculados por paciente_id OU por e-mail (agendamentos antigos sem login)
    const { rows: pacRows } = await pool.query(
      `SELECT email FROM pacientes WHERE id = $1 LIMIT 1`,
      [req.pacienteId]
    );
    const pacEmail = pacRows[0]?.email || '';

    const { rows } = await pool.query(
      `SELECT id, status, pagamento_status, horario_agendado
         FROM agendamentos_psicologia
        WHERE id = $1
          AND (paciente_id = $2 OR paciente_email = $3)
        LIMIT 1`,
      [agId, req.pacienteId, pacEmail]
    );
    if (rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });

    const ag = rows[0];
    if (ag.status === 'cancelado')
      return res.status(400).json({ ok: false, error: 'Agendamento já cancelado' });
    if (ag.pagamento_status === 'confirmado')
      return res.status(400).json({ ok: false, error: 'Sessão já paga não pode ser cancelada por aqui. Entre em contato com o suporte.' });

    await pool.query(
      `UPDATE agendamentos_psicologia SET status = 'cancelado' WHERE id = $1`,
      [agId]
    );
    console.log(`[PSI-CANCEL] Agendamento #${agId} cancelado pelo paciente ${req.pacienteId}`);
    return res.json({ ok: true });
  } catch(e) {
    console.error('[PSI-CANCEL-PAC] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /api/psicologo/agendamento/:id — cancela agendamento (psicólogo)
app.delete('/api/psicologo/agendamento/:id', authPsicologo, async (req, res) => {
  try {
    const agId = parseInt(req.params.id, 10);
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    // Busca e valida posse + regra de negócio
    const { rows } = await pool.query(
      `SELECT id, status, pagamento_status, horario_agendado, paciente_nome
         FROM agendamentos_psicologia
        WHERE id = $1 AND psicologo_id = $2 LIMIT 1`,
      [agId, req.psicologoId]
    );
    if (rows.length === 0)
      return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });

    const ag = rows[0];
    if (ag.status === 'cancelado')
      return res.status(400).json({ ok: false, error: 'Agendamento já cancelado' });
    if (ag.pagamento_status === 'confirmado')
      return res.status(400).json({ ok: false, error: 'Sessão já paga não pode ser cancelada por aqui. Entre em contato com o suporte.' });

    await pool.query(
      `UPDATE agendamentos_psicologia SET status = 'cancelado' WHERE id = $1`,
      [agId]
    );
    console.log(`[PSI-CANCEL] Agendamento #${agId} (${ag.paciente_nome}) cancelado pelo psicólogo ${req.psicologoId}`);
    return res.json({ ok: true });
  } catch(e) {
    console.error('[PSI-CANCEL-PSI] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── FIM PACIENTES ─────────────────────────────────────────────────────────────
// Mapeamento UF → número do conselho regional CRP (CFP oficial)
function formatarCRP(crp, uf) {
  const mapa = {
    AC:21, AL:15, AM:20, AP:21, BA:3, CE:11, DF:1, ES:16,
    GO:9,  MA:22, MG:4,  MS:14, MT:10, PA:10, PB:13, PE:2,
    PI:22, PR:8,  RJ:5,  RN:12, RO:20, RR:20, RS:7,  SC:12,
    SE:15, SP:6,  TO:9
  };
  const regional = mapa[String(uf || '').toUpperCase()];
  const numero   = String(crp || '').replace(/\D/g, '');
  if (!numero) return '';
  return regional ? `CRP ${regional}/${numero}` : `CRP ${numero}/${String(uf || '').toUpperCase()}`;
}

async function enviarEmailNovoCadastroPsicologo({ nome, email, crp, uf, telefone, abordagem, valor_sessao }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn('[EMAIL-PSICOLOGO] RESEND_API_KEY nao definida.'); return; }
  try {
    const html = `<div style="background:#060d0b;padding:32px 20px;font-family:sans-serif"><div style="max-width:520px;margin:0 auto;background:#0d1a14;border:1px solid rgba(255,255,255,.08);border-radius:16px;overflow:hidden"><div style="padding:24px;border-bottom:1px solid rgba(255,255,255,.08)"><span style="font-size:1.1rem;font-weight:700;color:#26508e">ConsultaJá24h</span><span style="font-size:.8rem;color:rgba(255,255,255,.4);margin-left:8px">Novo cadastro pendente de psicólogo</span></div><div style="padding:24px"><p style="color:rgba(255,255,255,.9);font-size:.95rem;margin-bottom:20px">Um novo psicólogo solicitou acesso:</p><table style="width:100%;border-collapse:collapse;font-size:.85rem"><tr><td style="color:rgba(255,255,255,.4);padding:6px 0;width:40%">Nome</td><td style="color:#fff;font-weight:500">${nome}</td></tr><tr><td style="color:rgba(255,255,255,.4);padding:6px 0">E-mail</td><td style="color:#fff">${email}</td></tr><tr><td style="color:rgba(255,255,255,.4);padding:6px 0">CRP</td><td style="color:#fff">${formatarCRP(crp, uf)}</td></tr>${telefone ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Telefone</td><td style="color:#fff">${telefone}</td></tr>` : ''}${abordagem ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Abordagem</td><td style="color:#fff">${abordagem}</td></tr>` : ''}${valor_sessao ? `<tr><td style="color:rgba(255,255,255,.4);padding:6px 0">Valor sessão</td><td style="color:#fff">R$ ${valor_sessao}</td></tr>` : ''}</table><p style="margin:20px 0 0;font-size:.78rem;color:rgba(255,255,255,.3)">Acesse o painel admin para aprovar.</p></div></div></div>`;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: 'ConsultaJá24h <contato@consultaja24h.com.br>', to: ['gustavosgbf@gmail.com'], subject: `Novo cadastro de psicólogo: ${nome} (${formatarCRP(crp, uf)})`, html })
    });
    const d = await r.json();
    if (d.id) console.log('[EMAIL-PSICOLOGO] Enviado | ID:', d.id);
    else console.error('[EMAIL-PSICOLOGO] Resend recusou:', JSON.stringify(d));
  } catch(e) { console.error('[EMAIL-PSICOLOGO] Erro:', e.message); }
}

async function enviarEmailAprovacaoPsicologo({ nome, email }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) { console.warn('[EMAIL-APROVACAO-PSI] RESEND_API_KEY nao definida.'); return; }
  try {
    const PAINEL_URL = 'https://painel.consultaja24h.com.br/psicologo';
    const html = `
<div style="background:#f2f0ec;padding:32px 20px;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid rgba(22,18,14,.1);border-radius:16px;overflow:hidden">

    <!-- Header -->
    <div style="padding:20px 28px;background:linear-gradient(135deg,#dce8f5,#c5d8ef);display:flex;align-items:center;justify-content:space-between">
      <span style="font-size:1rem;font-weight:600;color:#26508e">ConsultaJá24h</span>
      <span style="font-size:.72rem;color:#4a6fa5;background:rgba(38,80,142,.1);padding:3px 10px;border-radius:999px;font-weight:500">Psicologia Online</span>
    </div>

    <!-- Greeting -->
    <div style="padding:28px 28px 0">
      <h2 style="margin:0 0 8px;font-size:1rem;font-weight:400;color:#16120e">Olá, <strong>${nome}</strong> 👋</h2>
      <p style="margin:0 0 20px;font-size:.88rem;color:#443e38;line-height:1.65">
        Seu cadastro foi aprovado. Você já faz parte da <strong style="color:#26508e">ConsultaJá24h Psicologia</strong> e pode começar a atender pacientes online.
      </p>

      <!-- CTA principal -->
      <a href="${PAINEL_URL}" style="display:inline-block;padding:12px 28px;border-radius:10px;background:#26508e;color:#fff;font-weight:600;font-size:.88rem;text-decoration:none;margin-bottom:28px">
        Acessar meu painel →
      </a>

      <hr style="border:none;border-top:1px solid rgba(22,18,14,.08);margin:0 0 24px">

      <!-- Título seção -->
      <p style="margin:0 0 16px;font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:#8c857d">Como funciona</p>

      <!-- Step 1 -->
      <div style="display:flex;gap:14px;margin-bottom:18px;align-items:flex-start">
        <div style="min-width:28px;height:28px;border-radius:50%;background:rgba(38,80,142,.1);display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;color:#26508e;flex-shrink:0">1</div>
        <div>
          <p style="margin:0 0 3px;font-size:.88rem;font-weight:600;color:#16120e">Monte seu perfil</p>
          <p style="margin:0;font-size:.82rem;color:#443e38;line-height:1.55">Adicione sua foto, apresentação, abordagem e focos. Esse é o perfil que os pacientes vão ver antes de agendar.</p>
        </div>
      </div>

      <!-- Step 2 -->
      <div style="display:flex;gap:14px;margin-bottom:18px;align-items:flex-start">
        <div style="min-width:28px;height:28px;border-radius:50%;background:rgba(38,80,142,.1);display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;color:#26508e;flex-shrink:0">2</div>
        <div>
          <p style="margin:0 0 3px;font-size:.88rem;font-weight:600;color:#16120e">Configure sua disponibilidade</p>
          <p style="margin:0;font-size:.82rem;color:#443e38;line-height:1.55">Defina os dias e horários em que quer atender. Você tem controle total sobre sua agenda, e pode ativar ou pausar quando quiser.</p>
        </div>
      </div>

      <!-- Step 3 -->
      <div style="display:flex;gap:14px;margin-bottom:18px;align-items:flex-start">
        <div style="min-width:28px;height:28px;border-radius:50%;background:rgba(38,80,142,.1);display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;color:#26508e;flex-shrink:0">3</div>
        <div>
          <p style="margin:0 0 3px;font-size:.88rem;font-weight:600;color:#16120e">Receba pacientes automaticamente</p>
          <p style="margin:0;font-size:.82rem;color:#443e38;line-height:1.55">O paciente vê seu perfil, escolhe um horário disponível e paga online (PIX ou cartão). Você recebe os dados e uma notificação por e-mail.</p>
        </div>
      </div>

      <!-- Step 4 -->
      <div style="display:flex;gap:14px;margin-bottom:18px;align-items:flex-start">
        <div style="min-width:28px;height:28px;border-radius:50%;background:rgba(38,80,142,.1);display:flex;align-items:center;justify-content:center;font-size:.72rem;font-weight:600;color:#26508e;flex-shrink:0">4</div>
        <div>
          <p style="margin:0 0 3px;font-size:.88rem;font-weight:600;color:#16120e">Controle financeiro transparente</p>
          <p style="margin:0;font-size:.82rem;color:#443e38;line-height:1.55">Após cada sessão, marque como realizada no painel. A plataforma calcula o repasse automaticamente — você não precisa fazer conta.</p>
        </div>
      </div>

      <hr style="border:none;border-top:1px solid rgba(22,18,14,.08);margin:4px 0 20px">

      <!-- Card resumo do painel -->
      <div style="background:#f8f6f3;border:1px solid rgba(22,18,14,.08);border-radius:10px;padding:14px 18px;margin-bottom:24px">
        <p style="margin:0 0 6px;font-size:.8rem;font-weight:600;color:#16120e">O que você encontra no painel:</p>
        <p style="margin:0;font-size:.78rem;color:#6a6560;line-height:1.75">
          Editar foto e apresentação &nbsp;·&nbsp; Configurar disponibilidade &nbsp;·&nbsp;
          Ver agendamentos &nbsp;·&nbsp; Marcar sessões como realizadas &nbsp;·&nbsp;
          Controlar visibilidade no site &nbsp;·&nbsp; Acompanhar repasses
        </p>
      </div>

      <p style="margin:0 0 28px;font-size:.78rem;color:rgba(22,18,14,.4);line-height:1.55">
        Dúvidas? Responda este e-mail ou entre em contato com a equipe da plataforma.
      </p>
    </div>

    <!-- Footer -->
    <div style="padding:16px 28px;border-top:1px solid rgba(22,18,14,.08)">
      <p style="margin:0;font-size:.7rem;color:rgba(22,18,14,.35)">
        ConsultaJá24h Psicologia &nbsp;·&nbsp; Este e-mail foi enviado automaticamente após a aprovação do seu cadastro.
      </p>
    </div>

  </div>
</div>`;

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'ConsultaJá24h <contato@consultaja24h.com.br>',
        to: [email],
        subject: `✅ Cadastro aprovado — bem-vindo(a) à ConsultaJá24h Psicologia`,
        html
      })
    });
    const d = await r.json();
    if (d.id) console.log('[EMAIL-APROVACAO-PSI] Enviado para:', email, '| ID:', d.id);
    else console.error('[EMAIL-APROVACAO-PSI] Resend recusou:', JSON.stringify(d));
  } catch(e) { console.error('[EMAIL-APROVACAO-PSI] Erro:', e.message); }
}

app.post('/api/psicologo/cadastro', rlGeral, async (req, res) => {
  try {
    const {
      nome, nome_exibicao, email, senha, crp, uf, telefone,
      abordagem, focos, valor_sessao, atende_online,
      tem_avaliacao, valor_avaliacao, apresentacao, disponibilidade
    } = req.body || {};
    if (!nome || !email || !senha || !crp || !uf || !telefone || !abordagem || !valor_sessao) {
      return res.status(400).json({ ok: false, error: 'Todos os campos obrigatorios devem ser preenchidos' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ ok: false, error: 'Informe um e-mail valido' });
    }
    const dupCrp = await pool.query(
      'SELECT id FROM psicologos WHERE crp=$1 AND uf=$2 LIMIT 1',
      [String(crp).trim().toUpperCase(), String(uf).trim().toUpperCase()]
    );
    if (dupCrp.rowCount > 0) {
      return res.status(400).json({ ok: false, error: 'Ja existe um psicologo cadastrado com este CRP/UF' });
    }
    if (senha.length < 6) {
      return res.status(400).json({ ok: false, error: 'Senha deve ter ao menos 6 caracteres' });
    }
    // FIX: regex corrigida — \d precisa de flag no construtor ou literal /[^\d,.]/
    const normalizarValor = v => String(v || '').trim().replace(/[^\d,.]/g, '');

    // Validação de valor mínimo R$130,00 — obrigatório no backend (não confiar só no front)
    const valorNumerico = parseFloat(normalizarValor(valor_sessao).replace(',', '.'));
    if (isNaN(valorNumerico) || valorNumerico < 130) {
      return res.status(400).json({ ok: false, error: 'O valor mínimo da sessão é R$ 130,00' });
    }
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO psicologos
        (nome, nome_exibicao, email, senha_hash, crp, uf, telefone,
         abordagem, focos, valor_sessao, atende_online,
         tem_avaliacao, valor_avaliacao, apresentacao, disponibilidade,
         status, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pendente',false)
       RETURNING id, nome, nome_exibicao, email`,
      [
        nome.trim(), (nome_exibicao || nome).trim(), email.trim().toLowerCase(), senha_hash,
        crp.trim().toUpperCase(), uf.trim().toUpperCase(), String(telefone || '').trim(),
        String(abordagem || '').trim(), String(focos || '').trim(), normalizarValor(valor_sessao),
        atende_online !== false, !!tem_avaliacao,
        tem_avaliacao ? normalizarValor(valor_avaliacao) : '',
        String(apresentacao || '').trim(), String(disponibilidade || '').trim()
      ]
    );
    const psi = result.rows[0];
    enviarEmailNovoCadastroPsicologo({
      nome: psi.nome, email: psi.email,
      crp: crp.trim().toUpperCase(), uf: uf.trim().toUpperCase(),
      telefone: telefone || '', abordagem: abordagem || '', valor_sessao: valor_sessao || ''
    }).catch(() => {});
    return res.json({ ok: true, psicologo: psi });
  } catch (err) {
    if (err.code === '23505') {
      const msg = err.constraint && err.constraint.includes('crp') ? 'Ja existe um psicologo cadastrado com este CRP/UF' : 'E-mail ja cadastrado';
      return res.status(400).json({ ok: false, error: msg });
    }
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/psicologo/login', rlLogin, async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ ok: false, error: 'E-mail e senha sao obrigatorios' });
    const result = await pool.query(
      `SELECT id, nome, nome_exibicao, email, crp, uf, telefone,
              abordagem, focos, valor_sessao, atende_online,
              tem_avaliacao, valor_avaliacao, apresentacao, disponibilidade,
              status, ativo, senha_hash
         FROM psicologos WHERE email=$1 LIMIT 1`,
      [email.trim().toLowerCase()]
    );
    if (result.rowCount === 0) return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    const psi = result.rows[0];
    if (psi.status === 'pendente') return res.status(403).json({ ok: false, error: 'Seu cadastro ainda esta em analise pela equipe da plataforma.' });
    if (psi.status === 'rejeitado' || !psi.ativo) return res.status(403).json({ ok: false, error: 'Seu cadastro nao foi aprovado. Entre em contato com a equipe.' });
    const senhaOk = await bcrypt.compare(senha, psi.senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: 'E-mail ou senha incorretos' });
    const token = jwt.sign({ id: psi.id, tipo: 'psicologo' }, JWT_SECRET, { expiresIn: '1h' });
    const { senha_hash: _, ...psicologoPublico } = psi;
    psicologoPublico.nome_exibicao = psicologoPublico.nome_exibicao || psicologoPublico.nome;
    return res.json({ ok: true, token, psicologo: psicologoPublico });
  } catch (err) { return res.status(500).json({ ok: false, error: 'Erro interno no login' }); }
});

app.get('/api/psicologo/me', authPsicologo, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, nome_exibicao, email, crp, uf, telefone,
              abordagem, focos, valor_sessao, atende_online,
              tem_avaliacao, valor_avaliacao, apresentacao, disponibilidade,
              status, ativo, visivel, sala_meet
         FROM psicologos WHERE id=$1 LIMIT 1`,
      [req.psicologoId]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Psicologo nao encontrado' });
    const psi = result.rows[0];
    psi.nome_exibicao = psi.nome_exibicao || psi.nome;
    return res.json({ ok: true, psicologo: psi });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});


// PATCH /api/psicologo/sala-meet — salva link da sala permanente do Google Meet
app.patch('/api/psicologo/sala-meet', authPsicologo, async (req, res) => {
  try {
    const { sala_meet } = req.body || {};
    if (typeof sala_meet !== 'string') return res.status(400).json({ ok: false, error: 'sala_meet deve ser string' });
    const link = sala_meet.trim();
    if (link && !/^https?:\/\//.test(link)) return res.status(400).json({ ok: false, error: 'Link inválido. Use uma URL completa.' });
    await pool.query('UPDATE psicologos SET sala_meet=$1 WHERE id=$2', [link || null, req.psicologoId]);
    console.log(`[PSI-MEET] Psicólogo #${req.psicologoId} atualizou sala_meet=${link||'(removido)'}`);
    return res.json({ ok: true, sala_meet: link || null });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/psicologo/:id/aprovar', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE psicologos SET ativo=true, status='aprovado' WHERE id=$1 RETURNING id, nome, email, status, ativo`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Psicologo nao encontrado' });
    const psi = result.rows[0];
    enviarEmailAprovacaoPsicologo({ nome: psi.nome, email: psi.email }).catch(() => {});
    return res.json({ ok: true, psicologo: psi });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/psicologo/:id/rejeitar', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE psicologos SET ativo=false, status='rejeitado' WHERE id=$1 RETURNING id, nome, status`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Psicologo nao encontrado' });
    return res.json({ ok: true, psicologo: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch('/api/admin/psicologo/:id/visivel', checkAdmin, async (req, res) => {
  try {
    const { visivel } = req.body || {};
    if (typeof visivel !== 'boolean') return res.status(400).json({ ok: false, error: 'Campo visivel deve ser boolean' });
    const result = await pool.query(
      `UPDATE psicologos SET visivel=$1 WHERE id=$2 RETURNING id, nome, visivel`,
      [visivel, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Psicologo nao encontrado' });
    return res.json({ ok: true, psicologo: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/admin/psicologos/pendentes', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome, nome_exibicao, email, crp, uf, telefone,
              abordagem, focos, valor_sessao, atende_online,
              tem_avaliacao, valor_avaliacao, apresentacao, disponibilidade,
              status, ativo, created_at
         FROM psicologos WHERE status='pendente' ORDER BY created_at DESC`
    );
    return res.json({ ok: true, psicologos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/admin/psicologos', checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id,
       COALESCE(nome_exibicao, nome) AS nome,
       email,
       crp,
       uf,
       abordagem,
       status,
       ativo,
       visivel,
       created_at
FROM psicologos
ORDER BY id DESC`
    );
    return res.json({ ok: true, psicologos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// ── FIM PSICÓLOGOS ────────────────────────────────────────────────────────────

// ── PSICOLOGIA: criar agendamento (antes do pagamento) ───────────────────────
// POST /api/psicologia/agendamento/criar
// Exige paciente autenticado — token JWT com tipo='paciente' obrigatório
app.post('/api/psicologia/agendamento/criar', rlGeral, async (req, res) => {
  try {
    // Exige autenticação do paciente
    const auth = req.headers['authorization'] || '';
    const tok = auth.replace(/^Bearer\s+/i, '').trim();
    if (!tok) return res.status(401).json({ ok: false, error: 'Login obrigatório para agendar', code: 'AUTH_REQUIRED' });
    let pacienteId = null;
    try {
      const dec = jwt.verify(tok, JWT_SECRET);
      if (dec.tipo !== 'paciente') return res.status(401).json({ ok: false, error: 'Token inválido', code: 'AUTH_REQUIRED' });
      pacienteId = dec.id;
    } catch(_) {
      return res.status(401).json({ ok: false, error: 'Sessão expirada. Faça login novamente.', code: 'AUTH_REQUIRED' });
    }

    const { psicologoId, horario_agendado, tipo_consulta,
            paciente_nome, paciente_email, paciente_tel, paciente_cpf } = req.body || {};

    if (!psicologoId || !horario_agendado || !paciente_nome || !paciente_email) {
      return res.status(400).json({ ok: false, error: 'psicologoId, horario_agendado, paciente_nome e paciente_email são obrigatórios' });
    }

    // Busca psicólogo e seu valor — feito no BACKEND, nunca confiar no frontend
    const psiRes = await pool.query(
      `SELECT id, nome_exibicao, valor_sessao, valor_avaliacao, tem_avaliacao, ativo, status
         FROM psicologos WHERE id = $1 LIMIT 1`,
      [psicologoId]
    );
    if (psiRes.rowCount === 0 || !psiRes.rows[0].ativo || psiRes.rows[0].status !== 'aprovado') {
      return res.status(404).json({ ok: false, error: 'Psicólogo não encontrado ou inativo' });
    }
    const psi = psiRes.rows[0];

    // Determina qual valor usar conforme tipo_consulta
    const tipoFinal = tipo_consulta === 'avaliacao' && psi.tem_avaliacao ? 'avaliacao' : 'psicoterapia';
    const valorRaw = tipoFinal === 'avaliacao' ? psi.valor_avaliacao : psi.valor_sessao;
    const valor = parseFloat(String(valorRaw || '').replace(',', '.'));
    if (!valor || valor < 130) {
      return res.status(400).json({ ok: false, error: 'Valor da sessão inválido para este profissional' });
    }

    // Verifica conflito de horário para este psicólogo
    const slotStart = new Date(horario_agendado);
    if (isNaN(slotStart.getTime())) {
      return res.status(400).json({ ok: false, error: 'horario_agendado inválido' });
    }
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000); // sessão de 1h
    const conflito = await pool.query(
      `SELECT id FROM agendamentos_psicologia
        WHERE psicologo_id = $1
          AND horario_agendado >= $2 AND horario_agendado < $3
          AND status NOT IN ('cancelado')
        LIMIT 1`,
      [psicologoId, slotStart.toISOString(), slotEnd.toISOString()]
    );
    if (conflito.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'Horário indisponível. Escolha outro.' });
    }

    const result = await pool.query(
      `INSERT INTO agendamentos_psicologia
        (psicologo_id, psicologo_nome, paciente_nome, paciente_email,
         paciente_tel, paciente_cpf, tipo_consulta, horario_agendado,
         valor_cobrado, pagamento_status, status, paciente_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pendente','pendente',$10)
       RETURNING id, valor_cobrado`,
      [psicologoId, psi.nome_exibicao, paciente_nome, paciente_email,
       paciente_tel || '', paciente_cpf || '', tipoFinal,
       slotStart.toISOString(), valor, pacienteId]
    );
    const ag = result.rows[0];
    console.log(`[PSI-AGEND] Criado #${ag.id} — psicólogo:${psi.nome_exibicao} valor:R$${ag.valor_cobrado}`);
    return res.json({ ok: true, agendamentoId: ag.id, valor: ag.valor_cobrado });
  } catch (err) {
    console.error('[PSI-AGEND] Erro:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PSICOLOGIA: horários ocupados de um psicólogo ────────────────────────────
// GET /api/psicologia/horarios-ocupados/:psicologoId?dias=14
// Retorna array de ISO strings com horários já reservados (não cancelados)
app.get('/api/psicologia/horarios-ocupados/:psicologoId', rlGeral, async (req, res) => {
  try {
    const psicologoId = parseInt(req.params.psicologoId, 10);
    if (!psicologoId) return res.status(400).json({ ok: false, error: 'psicologoId inválido' });
    const dias = Math.min(parseInt(req.query.dias || '14', 10), 60);
    const { rows } = await pool.query(
      `SELECT horario_agendado
         FROM agendamentos_psicologia
        WHERE psicologo_id = $1
          AND status NOT IN ('cancelado')
          AND horario_agendado >= NOW()
          AND horario_agendado <= NOW() + ($2 || ' days')::interval
        ORDER BY horario_agendado`,
      [psicologoId, dias]
    );
    const ocupados = rows.map(r => new Date(r.horario_agendado).toISOString());
    return res.json({ ok: true, ocupados });
  } catch (e) {
    console.error('[PSI-HORARIOS] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PSICOLOGIA: PIX via PagBank com valor dinâmico ───────────────────────────
// POST /api/psicologia/pagbank/order
// Reutiliza a mesma integração PagBank existente, porém busca o valor do agendamento
app.post('/api/psicologia/pagbank/order', rlGeral, async (req, res) => {
  try {
    const { agendamentoId, nome, email, cpf } = req.body || {};
    if (!agendamentoId || !nome || !cpf) {
      return res.status(400).json({ ok: false, error: 'agendamentoId, nome e cpf são obrigatórios' });
    }
    if (!PAGBANK_TOKEN) return res.status(503).json({ ok: false, error: 'Gateway de pagamento indisponível' });

    // Busca valor real do agendamento — nunca aceita valor do front
    const agRes = await pool.query(
      `SELECT id, valor_cobrado, pagamento_status, psicologo_nome, paciente_nome, horario_agendado
         FROM agendamentos_psicologia WHERE id = $1 LIMIT 1`,
      [agendamentoId]
    );
    if (agRes.rowCount === 0) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    const ag = agRes.rows[0];
    if (ag.pagamento_status === 'confirmado') {
      return res.status(409).json({ ok: false, error: 'Este agendamento já foi pago' });
    }

    // Re-valida conflito de horário antes de gerar o PIX (race condition: outro paciente pode ter agendado entre /criar e /pagbank/order)
    const slotStart = new Date(ag.horario_agendado);
    const slotEnd   = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const conflitoP = await pool.query(
      `SELECT id FROM agendamentos_psicologia
        WHERE psicologo_id = (SELECT psicologo_id FROM agendamentos_psicologia WHERE id = $1)
          AND horario_agendado >= $2 AND horario_agendado < $3
          AND id <> $1
          AND status NOT IN ('cancelado')
        LIMIT 1`,
      [agendamentoId, slotStart.toISOString(), slotEnd.toISOString()]
    );
    if (conflitoP.rowCount > 0) {
      // Cancela o agendamento atual pois o horário foi tomado
      await pool.query(`UPDATE agendamentos_psicologia SET status='cancelado' WHERE id=$1`, [agendamentoId]);
      return res.status(409).json({ ok: false, error: 'Horário indisponível. Por favor, escolha outro horário.' });
    }

    const valorCentavos = Math.round(parseFloat(ag.valor_cobrado) * 100);
    if (!valorCentavos || valorCentavos < 1) {
      console.error('[PSI-PAGBANK] valor_cobrado inválido:', ag.valor_cobrado);
      return res.status(400).json({ ok: false, error: 'Valor do agendamento inválido. Contate o suporte.' });
    }

    const expiracao = new Date(Date.now() + 30 * 60 * 1000);
    const expiracaoISO = expiracao.toISOString().replace('Z', '-03:00');

    const orderBody = {
      reference_id: `CJ-PSI-${agendamentoId}-${Date.now()}`,
      customer: {
        name:   nome,
        email:  email || `paciente.${cpf.replace(/\D/g,'')}@consultaja24h.com.br`,
        tax_id: cpf.replace(/\D/g, '')
      },
      items: [{
        name:        `Sessão de Psicologia — ${ag.psicologo_nome}`,
        quantity:    1,
        unit_amount: valorCentavos
      }],
      qr_codes: [{ amount: { value: valorCentavos }, expiration_date: expiracaoISO }],
      notification_urls: [
        `${process.env.API_URL || 'https://triagem-api.onrender.com'}/api/psicologia/pagbank/webhook`
      ]
    };

    const response = await fetch(`${PAGBANK_URL}/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PAGBANK_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(orderBody)
    });
    const data = await response.json();

    if (!response.ok) {
      console.error('[PSI-PAGBANK] Erro:', JSON.stringify(data));
      return res.status(400).json({ ok: false, error: data.error_messages || 'Erro ao criar cobrança PIX' });
    }
    const qrCode = data.qr_codes?.[0];
    if (!qrCode?.text) {
      return res.status(502).json({ ok: false, error: 'PagBank não retornou QR Code' });
    }

    // Salva order_id no agendamento para o webhook conseguir identificar
    await pool.query(
      `UPDATE agendamentos_psicologia SET pagbank_order_id = $1, pagamento_metodo = 'pix' WHERE id = $2`,
      [data.id, agendamentoId]
    );

    console.log(`[PSI-PAGBANK] Order criada — agendamento #${agendamentoId} valor:R$${ag.valor_cobrado} order:${data.id}`);
    return res.json({ ok: true, order_id: data.id, qr_code_text: qrCode.text, valor: ag.valor_cobrado });
  } catch (e) {
    console.error('[PSI-PAGBANK] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PSICOLOGIA: webhook PagBank ───────────────────────────────────────────────
app.post('/api/psicologia/pagbank/webhook', async (req, res) => {
  const event = req.body;
  res.sendStatus(200); // responde imediatamente

  if (!event || typeof event !== 'object') return;
  const orderId = String(event?.data?.id || event?.id || '');
  const charges = event?.data?.charges || event?.charges || [];
  const pago    = charges.some(c => c.status === 'PAID');

  console.log('[PSI-PAGBANK-WH] orderId:', orderId, 'pago:', pago);
  if (!pago || !orderId) return;

  try {
    const { rows } = await pool.query(
      `UPDATE agendamentos_psicologia
          SET pagamento_status = 'confirmado', pagamento_confirmado_em = NOW(), status = 'confirmado',
              status_sessao = 'pago',
              valor_repasse = ROUND(valor_cobrado * (1 - $2::numeric / 100), 2)
        WHERE pagbank_order_id = $1 AND pagamento_status = 'pendente'
        RETURNING id, paciente_nome, psicologo_nome, horario_agendado, valor_cobrado, paciente_email, tipo_consulta`,
      [orderId, PSI_COMISSAO_PCT]
    );
    if (rows.length === 0) {
      console.log('[PSI-PAGBANK-WH] Order não encontrada ou já processada:', orderId);
      return;
    }
    const ag = rows[0];
    console.log(`[PSI-PAGBANK-WH] Agendamento #${ag.id} confirmado — ${ag.paciente_nome} → ${ag.psicologo_nome}`);
    // Busca email do psicólogo
    const psiRes1 = await pool.query(`SELECT email FROM psicologos WHERE nome_exibicao=$1 OR nome=$1 LIMIT 1`, [ag.psicologo_nome]);
    ag.psicologo_email = psiRes1.rows[0]?.email || null;
    // Envia emails
    enviarEmailAdminPsicologia(ag).catch(() => {});
    enviarEmailConfirmacaoPacientePsi(ag).catch(() => {});
    enviarEmailNotificacaoPsicologo(ag).catch(() => {});
  } catch (e) {
    console.error('[PSI-PAGBANK-WH] Erro:', e.message);
  }
});

// ── PSICOLOGIA: polling status de pagamento ───────────────────────────────────
app.get('/api/psicologia/agendamento/:id/status', rlGeral, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, pagamento_status, status, valor_cobrado, psicologo_nome,
              horario_agendado, tipo_consulta, formulario_url
         FROM agendamentos_psicologia WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    const ag = rows[0];

    // Fallback: consulta PagBank diretamente se ainda pendente (webhook pode ter atrasado)
    if (ag.pagamento_status === 'pendente' && ag.pagbank_order_id && PAGBANK_TOKEN) {
      try {
        const pbRes = await fetch(`${PAGBANK_URL}/orders/${ag.pagbank_order_id}`, {
          headers: { 'Authorization': `Bearer ${PAGBANK_TOKEN}`, 'accept': 'application/json' }
        });
        const pbData = await pbRes.json();
        const pagoNaPagBank = pbData.charges?.some(c => c.status === 'PAID') || false;
        if (pagoNaPagBank) {
          await pool.query(
            `UPDATE agendamentos_psicologia
                SET pagamento_status = 'confirmado', pagamento_confirmado_em = NOW(), status = 'confirmado'
              WHERE id = $1`,
            [ag.id]
          );
          ag.pagamento_status = 'confirmado';
          ag.status = 'confirmado';
        }
      } catch (e) {
        console.warn('[PSI-STATUS] Falha ao consultar PagBank:', e.message);
      }
    }

    return res.json({ ok: true, agendamento: ag });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PSICOLOGIA: cartão EFI com valor dinâmico ─────────────────────────────────
// POST /api/psicologia/efi/cartao/cobrar
// Mesma estrutura do /api/efi/cartao/cobrar existente, mas busca valor do agendamento
app.post('/api/psicologia/efi/cartao/cobrar', rlGeral, async (req, res) => {
  try {
    const { payment_token, nome, cpf, email, telefone, nascimento, parcelas = 1, agendamentoId } = req.body || {};

    if (!payment_token) return res.status(400).json({ ok: false, error: 'payment_token obrigatório' });
    if (!nome)          return res.status(400).json({ ok: false, error: 'nome obrigatório' });
    if (!cpf)           return res.status(400).json({ ok: false, error: 'cpf obrigatório' });
    if (!agendamentoId) return res.status(400).json({ ok: false, error: 'agendamentoId obrigatório' });

    const cpfLimpo = String(cpf).replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return res.status(400).json({ ok: false, error: 'CPF inválido' });

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
      return res.status(400).json({ ok: false, error: 'Informe um e-mail válido para pagamento no cartão' });

    const telefoneLimpoPsi = String(telefone || '').replace(/\D/g, '');
    if (telefoneLimpoPsi.length < 10 || telefoneLimpoPsi.length > 11)
      return res.status(400).json({ ok: false, error: 'Telefone com DDD obrigatório para pagamento no cartão' });

    // Busca valor real — backend determina, jamais o front
    const agRes = await pool.query(
      `SELECT id, valor_cobrado, pagamento_status, psicologo_nome, horario_agendado
         FROM agendamentos_psicologia WHERE id = $1 LIMIT 1`,
      [agendamentoId]
    );
    if (agRes.rowCount === 0) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    const ag = agRes.rows[0];
    if (ag.pagamento_status === 'confirmado') return res.status(409).json({ ok: false, error: 'Já pago' });

    // Re-valida conflito de horário antes de cobrar no cartão (race condition)
    const slotStartE = new Date(ag.horario_agendado);
    const slotEndE   = new Date(slotStartE.getTime() + 60 * 60 * 1000);
    const conflitoE  = await pool.query(
      `SELECT id FROM agendamentos_psicologia
        WHERE psicologo_id = (SELECT psicologo_id FROM agendamentos_psicologia WHERE id = $1)
          AND horario_agendado >= $2 AND horario_agendado < $3
          AND id <> $1
          AND status NOT IN ('cancelado')
        LIMIT 1`,
      [agendamentoId, slotStartE.toISOString(), slotEndE.toISOString()]
    );
    if (conflitoE.rowCount > 0) {
      await pool.query(`UPDATE agendamentos_psicologia SET status='cancelado' WHERE id=$1`, [agendamentoId]);
      return res.status(409).json({ ok: false, error: 'Horário indisponível. Por favor, escolha outro horário.' });
    }

    const valorCentavos = Math.round(parseFloat(ag.valor_cobrado) * 100);

    const efiToken   = await efiGetToken();
    const headers    = { Authorization: `Bearer ${efiToken}`, 'Content-Type': 'application/json' };
    const httpsAgent = getEfiAgent();

    // Passo 1: criar charge com valor dinâmico
    const chargePayload = {
      items: [{ name: `Sessão de Psicologia — ${ag.psicologo_nome}`, value: valorCentavos, amount: 1 }],
      metadata: {
        custom_id:        `CJ-PSI-CARTAO-${agendamentoId}-${Date.now()}`,
        notification_url: `${process.env.API_URL || 'https://triagem-api.onrender.com'}/api/psicologia/efi/cartao/webhook`
      }
    };
    const chargeRes = await axios.post(`${EFI_BASE_URL}/v1/charge`, chargePayload, { httpsAgent, headers });
    const chargeId  = chargeRes.data?.data?.charge_id;
    if (!chargeId) return res.status(502).json({ ok: false, error: 'Efí não retornou charge_id' });

    // Passo 2: associar payment_token
    const payPayload = {
      payment: {
        credit_card: {
          customer: {
            name: nome.trim(), cpf: cpfLimpo,
            email: String(email).trim(),
            phone_number: telefoneLimpoPsi,
            ...(nascimento ? { birth: nascimento } : {})
          },
          installments:  Math.max(1, parseInt(parcelas) || 1),
          payment_token: payment_token.trim(),
          billing_address: { street: 'Rua da Consulta', number: '1', neighborhood: 'Centro', zipcode: '65000000', city: 'São Luís', complement: '', state: 'MA' }
        }
      }
    };
    const payRes = await axios.post(`${EFI_BASE_URL}/v1/charge/${chargeId}/pay`, payPayload, { httpsAgent, headers });
    const status = payRes.data?.data?.status;
    const reason = payRes.data?.data?.reason || '';

    if (status === 'paid' || status === 'waiting' || status === 'approved') {
      await pool.query(
        `UPDATE agendamentos_psicologia SET efi_charge_id = $1, pagamento_metodo = 'cartao' WHERE id = $2`,
        [String(chargeId), agendamentoId]
      );
      if (status === 'paid' || status === 'approved') {
        const { rows } = await pool.query(
          `UPDATE agendamentos_psicologia
              SET pagamento_status = 'confirmado', pagamento_confirmado_em = NOW(), status = 'confirmado',
                  status_sessao = 'pago',
                  valor_repasse = ROUND(valor_cobrado * (1 - $2::numeric / 100), 2)
            WHERE id = $1 AND pagamento_status = 'pendente'
            RETURNING id, paciente_nome, psicologo_nome, horario_agendado, valor_cobrado, paciente_email, tipo_consulta`,
          [agendamentoId, PSI_COMISSAO_PCT]
        );
        if (rows[0]) {
          const psiRes2 = await pool.query(`SELECT email FROM psicologos WHERE nome_exibicao=$1 OR nome=$1 LIMIT 1`, [rows[0].psicologo_nome]);
          rows[0].psicologo_email = psiRes2.rows[0]?.email || null;
          enviarEmailAdminPsicologia(rows[0]).catch(() => {});
          enviarEmailConfirmacaoPacientePsi(rows[0]).catch(() => {});
          enviarEmailNotificacaoPsicologo(rows[0]).catch(() => {});
        }
      }
      return res.json({ ok: true, charge_id: chargeId, status });
    }
    return res.status(402).json({ ok: false, charge_id: chargeId, status: status || 'unpaid', error: reason || 'Pagamento não aprovado' });
  } catch (e) {
    const msg = e.response?.data?.error_description || e.response?.data?.message || e.message || 'Erro ao processar cartão';
    console.error('[PSI-EFI-CARTAO] Erro:', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ── PSICOLOGIA: webhook cartão EFI ───────────────────────────────────────────
app.post('/api/psicologia/efi/cartao/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const notificationToken = req.body?.notification;
    if (!notificationToken) return;
    const efiToken = await efiGetToken();
    const notifRes = await axios.get(`${EFI_BASE_URL}/v1/notification/${notificationToken}`, {
      httpsAgent: getEfiAgent(),
      headers: { Authorization: `Bearer ${efiToken}`, 'Content-Type': 'application/json' }
    });
    const charges = notifRes.data?.data || [];
    for (const charge of charges) {
      if (charge.status !== 'paid') continue;
      const chargeId = String(charge.charge_id || charge.id || '');
      if (!chargeId) continue;
      const { rows } = await pool.query(
        `UPDATE agendamentos_psicologia
            SET pagamento_status = 'confirmado', pagamento_confirmado_em = NOW(), status = 'confirmado',
                status_sessao = 'pago',
                valor_repasse = ROUND(valor_cobrado * (1 - $2::numeric / 100), 2)
          WHERE efi_charge_id = $1 AND pagamento_status = 'pendente'
          RETURNING id, paciente_nome, psicologo_nome, horario_agendado, valor_cobrado, paciente_email, tipo_consulta`,
        [chargeId, PSI_COMISSAO_PCT]
      );
      if (rows[0]) {
        console.log(`[PSI-EFI-WH] Agendamento #${rows[0].id} confirmado via webhook`);
        const psiRes3 = await pool.query(`SELECT email FROM psicologos WHERE nome_exibicao=$1 OR nome=$1 LIMIT 1`, [rows[0].psicologo_nome]);
        rows[0].psicologo_email = psiRes3.rows[0]?.email || null;
        enviarEmailAdminPsicologia(rows[0]).catch(() => {});
        enviarEmailConfirmacaoPacientePsi(rows[0]).catch(() => {});
        enviarEmailNotificacaoPsicologo(rows[0]).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[PSI-EFI-WH] Erro:', e.message);
  }
});

// ── PSICOLOGIA: email admin com todos os dados relevantes ────────────────────
async function enviarEmailAdminPsicologia({ id, paciente_nome, psicologo_nome, horario_agendado, valor_cobrado, paciente_email }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;
  const horarioFmt = new Date(horario_agendado).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const valorFmt = `R$ ${parseFloat(valor_cobrado).toFixed(2).replace('.', ',')}`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
    <div style="background:linear-gradient(135deg,#8aa4c8,#26508e);padding:20px 28px"><h2 style="margin:0;color:#fff;font-size:17px">✅ Novo agendamento de Psicologia — ConsultaJá24h</h2></div>
    <div style="padding:28px">
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px;width:150px">Agendamento #</td><td style="padding:8px 0;font-weight:600">${id}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Paciente</td><td style="padding:8px 0;font-weight:600">${paciente_nome}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">E-mail paciente</td><td style="padding:8px 0">${paciente_email || '—'}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">Psicólogo(a)</td><td style="padding:8px 0;font-weight:600;color:#93c5fd">${psicologo_nome}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">📅 Horário</td><td style="padding:8px 0;font-weight:700;color:#8aa4c8;font-size:15px">${horarioFmt}</td></tr>
        <tr><td style="padding:8px 0;color:rgba(255,255,255,.5);font-size:13px">💰 Valor pago</td><td style="padding:8px 0;font-weight:700;color:#4ade80;font-size:15px">${valorFmt}</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:11px;color:rgba(255,255,255,.25)">Enviado automaticamente — ConsultaJá24h Psicologia</p>
    </div>
  </div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'ConsultaJá24h <contato@consultaja24h.com.br>',
        to: ['gustavosgbf@gmail.com'],
        subject: `🧠 Psicologia: ${paciente_nome} → ${psicologo_nome} — ${horarioFmt} — ${valorFmt}`,
        html
      })
    });
  } catch (e) { console.error('[PSI-EMAIL-ADMIN] Erro:', e.message); }
}

// ── PSICOLOGIA: e-mail de boas-vindas ao paciente ────────────────────────────
async function enviarEmailBoasVindasPaciente({ nome, email }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY) return;
  const PAINEL_URL = 'https://painel.consultaja24h.com.br/paciente';
  const html = `<div style="background:#f2f0ec;padding:32px 20px;font-family:sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid rgba(22,18,14,.1);border-radius:16px;overflow:hidden">
      <div style="padding:24px;border-bottom:1px solid rgba(22,18,14,.08)">
        <span style="font-size:1.1rem;font-weight:600;color:#26508e">ConsultaJá24h</span>
        <span style="font-size:.8rem;color:rgba(22,18,14,.4);margin-left:8px">Psicologia Online</span>
      </div>
      <div style="padding:28px">
        <p style="color:#16120e;font-size:.95rem;margin-bottom:12px">Olá, <strong>${nome}</strong>!</p>
        <p style="color:#443e38;font-size:.9rem;line-height:1.65;margin-bottom:20px">
          Sua conta foi criada com sucesso. Agora você pode agendar sessões com nossos psicólogos de forma simples e segura.
        </p>
        <a href="${PAINEL_URL}" style="display:inline-block;padding:12px 28px;border-radius:12px;background:#26508e;color:#fff;font-weight:600;font-size:.9rem;text-decoration:none">
          Acessar minha conta
        </a>
        <p style="margin-top:24px;font-size:.78rem;color:rgba(22,18,14,.4);line-height:1.55">
          Se você não criou esta conta, ignore este e-mail.
        </p>
      </div>
    </div>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'ConsultaJá24h <contato@consultaja24h.com.br>',
        to: [email],
        subject: 'Bem-vindo(a) à ConsultaJá24h Psicologia',
        html
      })
    });
    const d = await r.json();
    if (d.id) console.log('[PSI-EMAIL-BOASVINDAS] Enviado para', email);
    else console.error('[PSI-EMAIL-BOASVINDAS] Resend recusou:', JSON.stringify(d));
  } catch (e) { console.error('[PSI-EMAIL-BOASVINDAS] Erro:', e.message); }
}

// ── PSICOLOGIA: e-mail de confirmação do agendamento ao paciente ─────────────
async function enviarEmailConfirmacaoPacientePsi({ id, paciente_nome, paciente_email, psicologo_nome, horario_agendado, valor_cobrado, tipo_consulta, formulario_url }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !paciente_email) return;
  // Busca formulario_url do psicólogo se não vier no objeto
  if (!formulario_url) {
    try {
      const r = await pool.query(
        `SELECT ps.formulario_url FROM agendamentos_psicologia ap
           JOIN psicologos ps ON ps.id = ap.psicologo_id
          WHERE ap.id = $1 LIMIT 1`, [id]
      );
      formulario_url = r.rows[0]?.formulario_url || null;
    } catch(_) {}
  }
  const horarioFmt = new Date(horario_agendado).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza', weekday: 'long', day: '2-digit',
    month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const valorFmt   = `R$ ${parseFloat(valor_cobrado).toFixed(2).replace('.', ',')}`;
  const tipoLabel  = tipo_consulta === 'avaliacao' ? 'Avaliação Psicológica' : 'Psicoterapia';
  const formularioBloco = formulario_url
    ? `<div style="margin:24px 0">
        <a href="${formulario_url}" style="display:inline-block;padding:11px 24px;border-radius:10px;background:#26508e;color:#fff;font-weight:600;font-size:.88rem;text-decoration:none">
          Preencher formulário do psicólogo
        </a>
        <p style="margin-top:8px;font-size:.75rem;color:#443e38">Preencha antes da sua sessão para ajudar o profissional a se preparar.</p>
      </div>`
    : `<p style="color:#443e38;font-size:.88rem;line-height:1.65;margin:16px 0">
        Você receberá as próximas orientações no e-mail cadastrado. Fique atento(a) à sua caixa de entrada.
      </p>`;
  const html = `<div style="background:#f2f0ec;padding:32px 20px;font-family:sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid rgba(22,18,14,.1);border-radius:16px;overflow:hidden">
      <div style="padding:20px 28px;background:linear-gradient(135deg,#e8eef7,#d0ddef)">
        <span style="font-size:1.1rem;font-weight:600;color:#26508e">ConsultaJá24h</span>
        <span style="font-size:.8rem;color:rgba(22,18,14,.5);margin-left:8px">Psicologia Online</span>
      </div>
      <div style="padding:28px">
        <h2 style="margin:0 0 16px;font-size:1.1rem;color:#16120e;font-weight:600">✅ Agendamento confirmado!</h2>
        <p style="color:#443e38;font-size:.9rem;margin-bottom:20px">Olá, <strong>${paciente_nome}</strong>. Seu pagamento foi confirmado e a sessão está agendada.</p>
        <table style="width:100%;border-collapse:collapse;font-size:.875rem;margin-bottom:4px">
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d;width:42%">Psicólogo(a)</td><td style="padding:9px 0;font-weight:600;color:#16120e">${psicologo_nome}</td></tr>
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d">Tipo</td><td style="padding:9px 0;color:#16120e">${tipoLabel}</td></tr>
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d">📅 Data e hora</td><td style="padding:9px 0;font-weight:700;color:#26508e">${horarioFmt}</td></tr>
          <tr><td style="padding:9px 0;color:#8c857d">💰 Valor pago</td><td style="padding:9px 0;font-weight:600;color:#16120e">${valorFmt}</td></tr>
        </table>
        ${formularioBloco}
        <p style="margin-top:20px;font-size:.75rem;color:rgba(22,18,14,.35);line-height:1.55">Em caso de dúvidas, entre em contato pelo WhatsApp da plataforma. — ConsultaJá24h Psicologia</p>
      </div>
    </div>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'ConsultaJá24h <contato@consultaja24h.com.br>',
        to: [paciente_email],
        subject: `Sessão confirmada com ${psicologo_nome} — ${horarioFmt}`,
        html
      })
    });
    const d = await r.json();
    if (d.id) console.log(`[PSI-EMAIL-CONFIRM] Enviado para ${paciente_email} | Agendamento #${id}`);
    else console.error('[PSI-EMAIL-CONFIRM] Resend recusou:', JSON.stringify(d));
  } catch (e) { console.error('[PSI-EMAIL-CONFIRM] Erro:', e.message); }
}

// ── PSICOLOGIA: e-mail de notificação ao psicólogo ──────────────────────────
async function enviarEmailNotificacaoPsicologo({ id, psicologo_email, psicologo_nome, paciente_nome, paciente_email, horario_agendado, valor_cobrado, tipo_consulta }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !psicologo_email) return;
  const horarioFmt = new Date(horario_agendado).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza', weekday: 'long', day: '2-digit',
    month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const valorFmt  = `R$ ${parseFloat(valor_cobrado).toFixed(2).replace('.', ',')}`;
  const tipoLabel = tipo_consulta === 'avaliacao' ? 'Avaliação Psicológica' : 'Psicoterapia';
  const html = `<div style="background:#f2f0ec;padding:32px 20px;font-family:sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid rgba(22,18,14,.1);border-radius:16px;overflow:hidden">
      <div style="padding:20px 28px;background:linear-gradient(135deg,#e8eef7,#d0ddef)">
        <span style="font-size:1.1rem;font-weight:600;color:#26508e">ConsultaJá24h</span>
        <span style="font-size:.8rem;color:rgba(22,18,14,.5);margin-left:8px">Psicologia Online</span>
      </div>
      <div style="padding:28px">
        <h2 style="margin:0 0 16px;font-size:1.1rem;color:#16120e;font-weight:600">🧠 Novo agendamento confirmado!</h2>
        <p style="color:#443e38;font-size:.9rem;margin-bottom:20px">Olá, <strong>${psicologo_nome}</strong>. Um paciente acabou de agendar uma sessão com você.</p>
        <table style="width:100%;border-collapse:collapse;font-size:.875rem;margin-bottom:20px">
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d;width:42%">Agendamento #</td><td style="padding:9px 0;font-weight:600;color:#16120e">${id}</td></tr>
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d">Paciente</td><td style="padding:9px 0;font-weight:600;color:#16120e">${paciente_nome}</td></tr>
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d">E-mail</td><td style="padding:9px 0;color:#16120e">${paciente_email || '—'}</td></tr>
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d">Tipo</td><td style="padding:9px 0;color:#16120e">${tipoLabel}</td></tr>
          <tr><td style="padding:9px 0;color:#8c857d">📅 Data e hora</td><td style="padding:9px 0;font-weight:700;color:#26508e">${horarioFmt}</td></tr>
        </table>
        <p style="font-size:.78rem;color:rgba(22,18,14,.4);line-height:1.55">Acesse seu painel para ver todos os agendamentos. — ConsultaJá24h Psicologia</p>
      </div>
    </div>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'ConsultaJá24h <contato@consultaja24h.com.br>',
        to: [psicologo_email],
        subject: `🗓️ Novo agendamento: ${paciente_nome} — ${horarioFmt}`,
        html
      })
    });
    const d = await r.json();
    if (d.id) console.log(`[PSI-EMAIL-PSICOLOGO] Enviado para ${psicologo_email} | Agendamento #${id}`);
    else console.error('[PSI-EMAIL-PSICOLOGO] Resend recusou:', JSON.stringify(d));
  } catch (e) { console.error('[PSI-EMAIL-PSICOLOGO] Erro:', e.message); }
}

// ── PSICOLOGIA: e-mail de lembrete ao paciente ───────────────────────────────
async function enviarEmailLembretePacientePsi({ paciente_nome, paciente_email, psicologo_nome, horario_agendado, tipo_consulta, formulario_url, id }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !paciente_email) return;
  // formulario_url já vem do JOIN no job — mas garante fallback
  formulario_url = formulario_url || null;
  const horarioFmt = new Date(horario_agendado).toLocaleString('pt-BR', {
    timeZone: 'America/Fortaleza', weekday: 'long', day: '2-digit',
    month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const tipoLabel = tipo_consulta === 'avaliacao' ? 'Avaliação Psicológica' : 'Psicoterapia';
  const formularioBloco = formulario_url
    ? `<div style="margin:20px 0">
        <a href="${formulario_url}" style="display:inline-block;padding:11px 24px;border-radius:10px;background:#26508e;color:#fff;font-weight:600;font-size:.88rem;text-decoration:none">
          Preencher formulário do psicólogo
        </a>
        <p style="margin-top:8px;font-size:.75rem;color:#443e38">Se ainda não preencheu, faça antes da sessão.</p>
      </div>`
    : '';
  const html = `<div style="background:#f2f0ec;padding:32px 20px;font-family:sans-serif">
    <div style="max-width:540px;margin:0 auto;background:#fff;border:1px solid rgba(22,18,14,.1);border-radius:16px;overflow:hidden">
      <div style="padding:20px 28px;background:linear-gradient(135deg,#e8eef7,#d0ddef)">
        <span style="font-size:1.1rem;font-weight:600;color:#26508e">ConsultaJá24h</span>
        <span style="font-size:.8rem;color:rgba(22,18,14,.5);margin-left:8px">Psicologia Online</span>
      </div>
      <div style="padding:28px">
        <h2 style="margin:0 0 12px;font-size:1.05rem;color:#16120e;font-weight:600">🔔 Lembrete: sua sessão começa em 1 hora</h2>
        <p style="color:#443e38;font-size:.9rem;margin-bottom:20px">Olá, <strong>${paciente_nome}</strong>. Este é um lembrete da sua sessão de hoje.</p>
        <table style="width:100%;border-collapse:collapse;font-size:.875rem">
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d;width:42%">Psicólogo(a)</td><td style="padding:9px 0;font-weight:600;color:#16120e">${psicologo_nome}</td></tr>
          <tr style="border-bottom:1px solid rgba(22,18,14,.07)"><td style="padding:9px 0;color:#8c857d">Tipo</td><td style="padding:9px 0;color:#16120e">${tipoLabel}</td></tr>
          <tr><td style="padding:9px 0;color:#8c857d">📅 Horário</td><td style="padding:9px 0;font-weight:700;color:#26508e">${horarioFmt}</td></tr>
        </table>
        ${formularioBloco}
        <p style="margin-top:20px;font-size:.75rem;color:rgba(22,18,14,.35);line-height:1.55">Em caso de dúvidas, entre em contato pelo WhatsApp da plataforma. — ConsultaJá24h Psicologia</p>
      </div>
    </div>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: 'ConsultaJá24h <contato@consultaja24h.com.br>',
        to: [paciente_email],
        subject: `🔔 Lembrete: sessão com ${psicologo_nome} em 1 hora`,
        html
      })
    });
    const d = await r.json();
    if (d.id) console.log(`[PSI-EMAIL-LEMBRETE] Enviado para ${paciente_email}`);
    else console.error('[PSI-EMAIL-LEMBRETE] Resend recusou:', JSON.stringify(d));
  } catch (e) { console.error('[PSI-EMAIL-LEMBRETE] Erro:', e.message); }
}

// ── JOB: lembrete de sessão de psicologia 1h antes ───────────────────────────
setInterval(async () => {
  try {
    const lock = await pool.query('SELECT pg_try_advisory_lock(10004)');
    if (!lock.rows[0].pg_try_advisory_lock) return;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return;
    const { rows } = await pool.query(
      `SELECT ap.id, ap.paciente_nome, ap.paciente_email, ap.psicologo_nome,
              ap.horario_agendado, ap.tipo_consulta, ps.formulario_url
         FROM agendamentos_psicologia ap
         LEFT JOIN psicologos ps ON ps.id = ap.psicologo_id
        WHERE ap.status = 'confirmado'
          AND ap.horario_agendado BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'
          AND ap.lembrete_psi_enviado IS NOT DISTINCT FROM false`
    );
    for (const ag of rows) {
      // Marca antes de enviar para evitar reprocessamento
      await pool.query(`UPDATE agendamentos_psicologia SET lembrete_psi_enviado = true WHERE id = $1`, [ag.id]);
      await enviarEmailLembretePacientePsi(ag).catch(e => console.error('[PSI-LEMBRETE-JOB] Erro email:', e.message));
      console.log(`[PSI-LEMBRETE-JOB] Lembrete enviado | Agendamento #${ag.id} → ${ag.paciente_email}`);
    }
  } catch (e) { console.error('[PSI-LEMBRETE-JOB] Erro:', e.message); }
}, 10 * 60 * 1000); // roda a cada 10 minutos

// ── PSICOLOGIA: painel do psicólogo — lista de pacientes ─────────────────────
app.get('/api/psicologo/agendamentos', authPsicologo, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, paciente_nome, paciente_email, paciente_tel,
              tipo_consulta, horario_agendado, valor_cobrado,
              pagamento_status, status, status_sessao, formulario_enviado, criado_em,
              iniciado_em, iniciado_por, link_sessao
         FROM agendamentos_psicologia
        WHERE psicologo_id = $1
        ORDER BY horario_agendado DESC`,
      [req.psicologoId]
    );
    return res.json({ ok: true, agendamentos: rows });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// PATCH: adicionar esta rota no server.js
// ONDE: logo após a rota GET /api/psicologo/agendamentos (linha ~2390)
// ══════════════════════════════════════════════════════════════════════════════

// ── PSICOLOGIA: painel — saldo financeiro do psicólogo ────────────────────────
// GET /api/psicologo/saldo
// Retorna: total bruto recebido, repasse líquido (após comissão), e lista
// dos agendamentos confirmados com valor_cobrado e valor_repasse
app.get('/api/psicologo/saldo', authPsicologo, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         id,
         paciente_nome,
         tipo_consulta,
         horario_agendado,
         pagamento_metodo,
         valor_cobrado,
         valor_repasse,
         pagamento_status,
         status_sessao,
         pago_psicologo,
         pagamento_confirmado_em
       FROM agendamentos_psicologia
       WHERE psicologo_id = $1
         AND pagamento_status = 'confirmado'
       ORDER BY horario_agendado DESC`,
      [req.psicologoId]
    );

    const totalBruto   = rows.reduce((s, r) => s + parseFloat(r.valor_cobrado  || 0), 0);
    const totalRepasse = rows.reduce((s, r) => s + parseFloat(r.valor_repasse  || 0), 0);
    const totalPago    = rows.filter(r => r.pago_psicologo).reduce((s, r) => s + parseFloat(r.valor_repasse || 0), 0);
    const totalPendente = totalRepasse - totalPago;

    return res.json({
      ok: true,
      comissao_pct: PSI_COMISSAO_PCT,
      resumo: {
        total_sessoes:    rows.length,
        total_bruto:      totalBruto.toFixed(2),
        total_repasse:    totalRepasse.toFixed(2),
        total_pago:       totalPago.toFixed(2),
        total_pendente:   totalPendente.toFixed(2),
      },
      sessoes: rows
    });
  } catch (e) {
    console.error('[PSI-SALDO] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PSICOLOGIA: painel — editar disponibilidade ───────────────────────────────
app.patch('/api/psicologo/disponibilidade', authPsicologo, async (req, res) => {
  try {
    const { disponibilidade } = req.body || {};
    if (typeof disponibilidade !== 'string') {
      return res.status(400).json({ ok: false, error: 'disponibilidade deve ser texto' });
    }
    await pool.query(
      `UPDATE psicologos SET disponibilidade = $1 WHERE id = $2`,
      [disponibilidade.trim(), req.psicologoId]
    );
    console.log(`[PSI-DISP] Psicólogo #${req.psicologoId} atualizou disponibilidade`);
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── PSICOLOGIA: painel — upload de foto ───────────────────────────────────────
// POST /api/psicologo/foto
// Recebe imagem, faz upload pro R2, salva foto_url no banco
app.post('/api/psicologo/foto', rlUpload, authPsicologo, upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
    const mime = req.file.mimetype;
    if (!mime.startsWith('image/')) return res.status(400).json({ ok: false, error: 'Apenas imagens são aceitas' });
    if (req.file.size > 5 * 1024 * 1024) return res.status(400).json({ ok: false, error: 'Imagem deve ter no máximo 5MB' });
    const ext = req.file.originalname.split('.').pop().toLowerCase() || 'jpg';
    const key = `psicologos/${req.psicologoId}_${Date.now()}.${ext}`;
    await r2.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: req.file.buffer,
      ContentType: mime,
    }));
    const url = `${process.env.R2_PUBLIC_URL}/${key}`;
    await pool.query(`UPDATE psicologos SET foto_url = $1 WHERE id = $2`, [url, req.psicologoId]);
    console.log(`[PSI-FOTO] Psicólogo #${req.psicologoId} atualizou foto: ${url}`);
    return res.json({ ok: true, foto_url: url });
  } catch (e) {
    console.error('[PSI-FOTO] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PSICOLOGIA: painel — editar perfil (apresentação, abordagem, focos) ───────
// PATCH /api/psicologo/perfil
app.patch('/api/psicologo/perfil', authPsicologo, async (req, res) => {
  try {
    const { crp, apresentacao, abordagem, focos } = req.body || {};
    if (crp === undefined && apresentacao === undefined && abordagem === undefined && focos === undefined) {
      return res.status(400).json({ ok: false, error: 'Nenhum campo enviado' });
    }
    await pool.query(
      `UPDATE psicologos
          SET crp          = COALESCE($1, crp),
              apresentacao = COALESCE($2, apresentacao),
              abordagem    = COALESCE($3, abordagem),
              focos        = COALESCE($4, focos)
        WHERE id = $5`,
      [
        crp          !== undefined ? String(crp).trim()          : null,
        apresentacao !== undefined ? String(apresentacao).trim() : null,
        abordagem    !== undefined ? String(abordagem).trim()    : null,
        focos        !== undefined ? String(focos).trim()        : null,
        req.psicologoId
      ]
    );
    console.log(`[PSI-PERFIL] Psicólogo #${req.psicologoId} atualizou perfil`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[PSI-PERFIL] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/psicologo/visibilidade
app.patch('/api/psicologo/visibilidade', authPsicologo, async (req, res) => {
  try {
    const { visivel } = req.body || {};
    if (typeof visivel !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'Campo visivel deve ser boolean' });
    }
    await pool.query(
      `UPDATE psicologos SET visivel = $1 WHERE id = $2`,
      [visivel, req.psicologoId]
    );
    console.log(`[PSI-VISIB] Psicólogo #${req.psicologoId} visivel=${visivel}`);
    return res.json({ ok: true, visivel });
  } catch (e) {
    console.error('[PSI-VISIB] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PSICOLOGIA: Google Sheets — salvar dados do paciente aba Psicologia ───────
app.post('/api/psicologia/consent', rlGeral, async (req, res) => {
  try {
    const { nome, email, tel, psicologo_nome, agendamento_id, aceite_termos } = req.body || {};
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '-';
    // Salva em aba separada "Psicologia" no Sheets — não mistura com médicos
    appendToSheet('Psicologia', [
      agora, nome || '', email || '', tel || '',
      psicologo_nome || '', String(agendamento_id || ''),
      aceite_termos ? 'Sim' : 'Não', ip
    ]).catch(e => console.error('[PSI-SHEETS]', e.message));
    // Aba separada de identificações de pacientes de psicologia
    appendToSheet('Psicologia_Identificacoes', [
      agora, nome || '', email || '', tel || '', ip
    ]).catch(e => console.error('[PSI-SHEETS-IDENT]', e.message));
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});
// GET /api/psicologos
// Não expõe email, senha_hash, telefone — apenas dados de perfil público
app.get('/api/psicologos', rlGeral, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome_exibicao, crp, uf, abordagem, focos,
              valor_sessao, tem_avaliacao, valor_avaliacao,
              apresentacao, disponibilidade, foto_url, formulario_url,
              atende_online
         FROM psicologos
        WHERE ativo = true AND status = 'aprovado' AND visivel = true
        ORDER BY id ASC`
    );
    return res.json({ ok: true, psicologos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// ── ROTA: buscar dados de um psicólogo por ID (público) ──────────────────────
app.get('/api/psicologo/:id', rlGeral, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nome_exibicao, crp, uf, abordagem, focos,
              valor_sessao, tem_avaliacao, valor_avaliacao,
              apresentacao, disponibilidade, foto_url, formulario_url,
              atende_online
         FROM psicologos WHERE id = $1 AND ativo = true AND status = 'aprovado' AND visivel = true LIMIT 1`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: 'Psicólogo não encontrado' });
    return res.json({ ok: true, psicologo: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

// ── LEAD CAPTURE ─────────────────────────────────────────────────────────────
app.post('/api/lead/registrar', rlGeral, async (req, res) => {
  try {
    const { nome, email, tel, especialidade, profissional, horario, modulo } = req.body || {};
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    await pool.query(
      `INSERT INTO leads_agendamento (nome, email, tel, especialidade, profissional, horario, modulo, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'iniciou_agendamento')`,
      [nome||'', email||'', tel||'', especialidade||'', profissional||'', horario||'', modulo||'especialistas']
    );
    appendToSheet('Leads_Agendamento', [
      agora, nome||'', email||'', tel||'', especialidade||'', profissional||'', horario||'', modulo||'especialistas', 'iniciou_agendamento'
    ]).catch(()=>{});
    return res.json({ ok: true });
  } catch(e) {
    console.error('[LEAD]', e.message);
    return res.json({ ok: true }); // nunca bloqueia o fluxo
  }
});

// ── ESPECIALISTAS: horários ocupados ─────────────────────────────────────────
// ATENÇÃO: rota específica ANTES de /:especialidade para evitar captura pelo wildcard
app.get('/api/especialistas/horarios-ocupados/:especialistaId', rlGeral, async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias || '14', 10), 60);
    const { rows } = await pool.query(
      `SELECT horario_agendado FROM agendamentos_especialistas
        WHERE especialista_id = $1
          AND status NOT IN ('cancelado')
          AND horario_agendado >= NOW()
          AND horario_agendado <= NOW() + ($2 || ' days')::interval
        ORDER BY horario_agendado`,
      [req.params.especialistaId, dias]
    );
    return res.json({ ok: true, ocupados: rows.map(r => new Date(r.horario_agendado).toISOString()) });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: listar por especialidade ───────────────────────────────────
// Wildcard — deve ficar DEPOIS das rotas específicas
app.get('/api/especialistas/:especialidade', rlGeral, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome_exibicao, especialidade, crm, uf, valor_consulta, foto_url, bio, disponibilidade
         FROM especialistas
        WHERE especialidade = $1 AND ativo = true AND (visivel = true OR visivel IS NULL)
        ORDER BY id ASC`,
      [req.params.especialidade]
    );
    return res.json({ ok: true, especialistas: rows });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: horários ocupados por especialista ────────────────────────
app.get('/api/especialistas/:especialistaId/horarios', rlGeral, async (req, res) => {
  try {
    const espId = parseInt(req.params.especialistaId, 10);
    if (!espId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { rows } = await pool.query(
      `SELECT disponibilidade FROM especialistas WHERE id = $1 AND ativo = true`,
      [espId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
    return res.json({ ok: true, disponibilidade: rows[0].disponibilidade || null });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: criar agendamento ─────────────────────────────────────────
app.post('/api/especialistas/agendamento/criar', rlGeral, async (req, res) => {
  try {
    const { especialistaId, horario_agendado, paciente_nome, paciente_email, paciente_tel, paciente_cpf } = req.body || {};
    if (!especialistaId || !horario_agendado || !paciente_nome || !paciente_email) {
      return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando' });
    }
    // Lê token do paciente se presente — vincula conta universal (não obrigatório)
    let pacienteId = null;
    const authH = req.headers['authorization'] || '';
    const tok = authH.replace(/^Bearer\s+/i, '').trim();
    if (tok) {
      try {
        const dec = jwt.verify(tok, JWT_SECRET);
        if (dec.tipo === 'paciente') pacienteId = dec.id;
      } catch(_) {}
    }
    const espRes = await pool.query(
      `SELECT id, nome_exibicao, especialidade, valor_consulta, ativo FROM especialistas WHERE id = $1 LIMIT 1`,
      [especialistaId]
    );
    if (espRes.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Especialista não encontrado. Verifique o ID no HTML.' });
    }
    if (!espRes.rows[0].ativo) {
      return res.status(400).json({ ok: false, error: 'Especialista temporariamente indisponível.' });
    }
    const esp = espRes.rows[0];
    const slotStart = new Date(horario_agendado);
    if (isNaN(slotStart.getTime())) return res.status(400).json({ ok: false, error: 'Horário inválido' });
    const slotEnd = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const conflito = await pool.query(
      `SELECT id FROM agendamentos_especialistas
        WHERE especialista_id = $1
          AND horario_agendado >= $2 AND horario_agendado < $3
          AND status NOT IN ('cancelado') LIMIT 1`,
      [especialistaId, slotStart.toISOString(), slotEnd.toISOString()]
    );
    if (conflito.rowCount > 0) return res.status(409).json({ ok: false, error: 'Horário indisponível. Escolha outro.' });
    const result = await pool.query(
      `INSERT INTO agendamentos_especialistas
        (especialista_id, especialista_nome, especialidade, paciente_nome, paciente_email,
         paciente_tel, paciente_cpf, horario_agendado, valor_cobrado, paciente_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id, valor_cobrado`,
      [especialistaId, esp.nome_exibicao, esp.especialidade, paciente_nome, paciente_email,
       paciente_tel||'', paciente_cpf||'', slotStart.toISOString(), esp.valor_consulta, pacienteId]
    );
    const ag = result.rows[0];
    console.log('[ESP-AGEND] Criado #'+ag.id+' — '+esp.especialidade+'/'+esp.nome_exibicao+(pacienteId?' pac#'+pacienteId:''));
    return res.json({ ok: true, agendamentoId: ag.id, valor: ag.valor_cobrado });
  } catch(e) {
    console.error('[ESP-AGEND]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ESPECIALISTAS: PIX PagBank ────────────────────────────────────────────────
app.post('/api/especialistas/pagbank/order', rlGeral, async (req, res) => {
  try {
    const { agendamentoId, nome, email, cpf } = req.body || {};
    if (!agendamentoId || !nome || !cpf) return res.status(400).json({ ok: false, error: 'Dados obrigatórios faltando' });
    if (!PAGBANK_TOKEN) return res.status(503).json({ ok: false, error: 'Gateway indisponível' });
    const agRes = await pool.query(
      `SELECT id, valor_cobrado, pagamento_status, especialista_nome, especialidade,
              horario_agendado, especialista_id
         FROM agendamentos_especialistas WHERE id = $1 LIMIT 1`,
      [agendamentoId]
    );
    if (agRes.rowCount === 0) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    const ag = agRes.rows[0];
    if (ag.pagamento_status === 'confirmado') return res.status(409).json({ ok: false, error: 'Já pago' });
    // Re-verifica conflito (race condition)
    const slotStart = new Date(ag.horario_agendado);
    const slotEnd   = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const conflito  = await pool.query(
      `SELECT id FROM agendamentos_especialistas
        WHERE especialista_id = $1 AND horario_agendado >= $2 AND horario_agendado < $3
          AND id <> $4 AND status NOT IN ('cancelado') LIMIT 1`,
      [ag.especialista_id, slotStart.toISOString(), slotEnd.toISOString(), agendamentoId]
    );
    if (conflito.rowCount > 0) {
      await pool.query(`UPDATE agendamentos_especialistas SET status='cancelado' WHERE id=$1`, [agendamentoId]);
      return res.status(409).json({ ok: false, error: 'Horário indisponível. Escolha outro.' });
    }
    const valorCentavos = Math.round(parseFloat(ag.valor_cobrado) * 100);
    const expiracao = new Date(Date.now() + 30 * 60 * 1000);
    const orderBody = {
      reference_id: 'CJ-ESP-'+agendamentoId+'-'+Date.now(),
      customer: {
        name:   nome,
        email:  email || 'paciente.'+cpf.replace(/\D/g,'')+'@consultaja24h.com.br',
        tax_id: cpf.replace(/\D/g, '')
      },
      items: [{ name: 'Consulta '+ag.especialidade+' — '+ag.especialista_nome, quantity: 1, unit_amount: valorCentavos }],
      qr_codes: [{ amount: { value: valorCentavos }, expiration_date: expiracao.toISOString().replace('Z', '-03:00') }],
      notification_urls: [`${process.env.API_URL || 'https://triagem-api.onrender.com'}/api/especialistas/pagbank/webhook`]
    };
    const response = await fetch(`${PAGBANK_URL}/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${PAGBANK_TOKEN}`, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(orderBody)
    });
    const data = await response.json();
    if (!response.ok) return res.status(400).json({ ok: false, error: data.error_messages || 'Erro ao gerar PIX' });
    const qrCode = data.qr_codes?.[0];
    if (!qrCode?.text) return res.status(502).json({ ok: false, error: 'PagBank não retornou QR Code' });
    await pool.query(
      `UPDATE agendamentos_especialistas SET pagbank_order_id = $1, pagamento_metodo = 'pix' WHERE id = $2`,
      [data.id, agendamentoId]
    );
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    appendToSheet('Leads_Agendamento', [
      agora, nome, email||'', cpf||'', ag.especialidade, ag.especialista_nome,
      slotStart.toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}), 'especialistas', 'pix_gerado'
    ]).catch(()=>{});
    console.log('[ESP-PAGBANK] Order criada — agendamento #'+agendamentoId+' order:'+data.id);
    return res.json({ ok: true, order_id: data.id, qr_code_text: qrCode.text, valor: ag.valor_cobrado });
  } catch(e) {
    console.error('[ESP-PAGBANK]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ESPECIALISTAS: webhook PagBank ────────────────────────────────────────────
app.post('/api/especialistas/pagbank/webhook', async (req, res) => {
  const event = req.body;
  res.sendStatus(200);
  if (!event || typeof event !== 'object') return;
  const orderId = String(event?.data?.id || event?.id || '');
  const charges = event?.data?.charges || event?.charges || [];
  const pago    = charges.some(c => c.status === 'PAID');
  if (!pago || !orderId) return;
  try {
    const { rows } = await pool.query(
      `UPDATE agendamentos_especialistas
          SET pagamento_status = 'confirmado', pagamento_confirmado_em = NOW(), status = 'confirmado'
        WHERE pagbank_order_id = $1 AND pagamento_status = 'pendente'
        RETURNING id, paciente_nome, paciente_email, especialista_nome, especialidade,
                  horario_agendado, valor_cobrado`,
      [orderId]
    );
    if (rows.length === 0) { console.log('[ESP-WH] Order não encontrada ou já processada:', orderId); return; }
    const ag = rows[0];
    console.log('[ESP-WH] Confirmado #'+ag.id+' — '+ag.especialidade+'/'+ag.especialista_nome);
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
    appendToSheet('Especialistas_Confirmados', [
      agora, ag.id, ag.paciente_nome, ag.paciente_email||'', ag.especialidade, ag.especialista_nome,
      new Date(ag.horario_agendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}),
      'R$ '+parseFloat(ag.valor_cobrado).toFixed(2).replace('.',',')
    ]).catch(()=>{});
    
    // Enviar e-mails de confirmação
    const horarioFmt = new Date(ag.horario_agendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    enviarEmailConfirmacaoEspecialista({ especialista: ag.especialista_nome, especialidade: ag.especialidade, paciente: ag.paciente_nome, email: ag.paciente_email, horario: horarioFmt }).catch(()=>{});
    enviarEmailConfirmacaoAdmin({ especialidade: ag.especialidade, especialista: ag.especialista_nome, paciente: ag.paciente_nome, email: ag.paciente_email, horario: horarioFmt, status: 'confirmado' }).catch(()=>{});
  } catch(e) { console.error('[ESP-WH]', e.message); }
});

// ── ESPECIALISTAS: polling status ─────────────────────────────────────────────
app.get('/api/especialistas/agendamento/:id/status', rlGeral, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, pagamento_status, status, valor_cobrado, especialista_nome, especialidade, horario_agendado
         FROM agendamentos_especialistas WHERE id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Não encontrado' });
    return res.json({ ok: true, agendamento: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: admin — cadastrar especialista ─────────────────────────────
app.post('/api/admin/especialista/criar', checkAdmin, async (req, res) => {
  try {
    const { nome, nome_exibicao, especialidade, crm, uf, valor_consulta, bio, foto_url } = req.body || {};
    if (!nome || !especialidade || !crm || !uf || !valor_consulta) {
      return res.status(400).json({ ok: false, error: 'nome, especialidade, crm, uf e valor_consulta são obrigatórios' });
    }
    const { rows } = await pool.query(
      `INSERT INTO especialistas (nome, nome_exibicao, especialidade, crm, uf, valor_consulta, bio, foto_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, nome_exibicao, especialidade`,
      [nome.trim(), (nome_exibicao||nome).trim(), especialidade.trim().toLowerCase(),
       crm.trim().toUpperCase(), uf.trim().toUpperCase(),
       parseFloat(String(valor_consulta).replace(',','.')),
       bio||'', foto_url||'']
    );
    console.log('[ESP-ADMIN] Especialista criado #'+rows[0].id+' — '+rows[0].especialidade);
    return res.json({ ok: true, especialista: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: admin — listar todos ──────────────────────────────────────
app.get('/api/admin/especialistas', checkAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome_exibicao, especialidade, crm, uf, valor_consulta, ativo, created_at
         FROM especialistas ORDER BY especialidade, id`
    );
    return res.json({ ok: true, especialistas: rows });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: admin — desativar especialista ─────────────────────────────
app.put('/api/admin/especialista/:id/desativar', checkAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { rows } = await pool.query(
      `UPDATE especialistas SET ativo = false WHERE id = $1 RETURNING id, nome_exibicao, ativo`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
    return res.json({ ok: true, especialista: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: admin — deletar especialista (permanent) ───────────────────
app.delete('/api/admin/especialista/:id', checkAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { rows } = await pool.query(
      `DELETE FROM especialistas WHERE id = $1 RETURNING id, nome_exibicao`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
    return res.json({ ok: true, especialista: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: auth middleware ──────────────────────────────────────────
const authEspecialista = async (req, res, next) => {
  const authH = req.headers['authorization'] || '';
  const tok = authH.replace(/^Bearer\s+/i, '').trim();
  if (!tok) return res.status(401).json({ ok: false, error: 'Token necessário' });
  try {
    const dec = jwt.verify(tok, JWT_SECRET);
    if (dec.tipo !== 'especialista') return res.status(403).json({ ok: false, error: 'Acesso negado' });
    const { rows } = await pool.query('SELECT id, nome_exibicao, especialidade, ativo FROM especialistas WHERE id = $1 AND ativo = true', [dec.id]);
    if (!rows.length) return res.status(403).json({ ok: false, error: 'Especialista inativo ou não encontrado' });
    req.especialistaId = rows[0].id;
    req.especialista = rows[0];
    next();
  } catch(e) { return res.status(401).json({ ok: false, error: 'Token inválido' }); }
};

// ── ESPECIALISTAS: login ────────────────────────────────────────────────────
app.post('/api/especialista/login', rlLogin, async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email || !senha) return res.status(400).json({ ok: false, error: 'Email e senha obrigatórios' });
    const { rows } = await pool.query(
      `SELECT id, nome, nome_exibicao, especialidade, crm, uf,
              email, senha_hash, precisa_trocar_senha, ativo
         FROM especialistas WHERE email = $1 LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) return res.status(401).json({ ok: false, error: 'Credenciais inválidas' });
    const esp = rows[0];
    if (!esp.ativo) return res.status(403).json({ ok: false, error: 'Seu cadastro está inativo' });
    if (!esp.senha_hash) return res.status(401).json({ ok: false, error: 'Senha não configurada. Use "Esqueci minha senha".' });
    const match = await bcrypt.compare(senha, esp.senha_hash);
    if (!match) return res.status(401).json({ ok: false, error: 'Credenciais inválidas' });
    const tok = jwt.sign({ id: esp.id, tipo: 'especialista', email: esp.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({
      ok: true,
      token: tok,
      especialista: {
        id: esp.id,
        nome: esp.nome_exibicao || esp.nome,
        especialidade: esp.especialidade,
        crm: esp.crm,
        uf: esp.uf,
      },
      precisa_trocar_senha: !!esp.precisa_trocar_senha,
    });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: esqueci senha ──────────────────────────────────────────────
app.post('/api/especialista/esqueci-senha', rlLogin, async (req, res) => {
  // Sempre responde ok=true — não expõe se e-mail existe
  res.json({ ok: true });
  try {
    const { email } = req.body || {};
    if (!email) return;
    const { rows } = await pool.query(
      `SELECT id, nome, nome_exibicao, email FROM especialistas
        WHERE LOWER(email) = LOWER($1) AND ativo = true LIMIT 1`,
      [email.trim()]
    );
    if (!rows.length) return;
    const esp = rows[0];
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let senhaTemp = '';
    for (let i = 0; i < 8; i++) senhaTemp += chars[Math.floor(Math.random() * chars.length)];
    const hash = await bcrypt.hash(senhaTemp, 10);
    await pool.query(
      `UPDATE especialistas SET senha_hash = $1, precisa_trocar_senha = true WHERE id = $2`,
      [hash, esp.id]
    );
    const nome = esp.nome_exibicao || esp.nome;
    const RESEND_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_KEY) return;
    const html = `<div style="background:#f5f5f5;padding:32px;font-family:sans-serif">
      <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
        <h2 style="color:#1a1612;margin:0 0 12px">Acesso ao Painel do Especialista</h2>
        <p style="color:#555;font-size:.9rem;margin-bottom:20px">Olá, ${nome}. Sua senha temporária de acesso é:</p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;text-align:center;margin-bottom:20px">
          <span style="font-family:monospace;font-size:1.4rem;font-weight:700;color:#166534;letter-spacing:.12em">${senhaTemp}</span>
        </div>
        <p style="color:#555;font-size:.85rem">Acesse o painel e você será solicitado a criar uma nova senha permanente.</p>
        <p style="color:#999;font-size:.78rem;margin-top:16px">Se você não solicitou este acesso, ignore este e-mail.</p>
      </div>
    </div>`;
    console.log(`[ESP-RECOVERY] Tentando enviar email para: ${esp.email}`);
    console.log(`[ESP-RECOVERY] SENHA TEMP (debug): ${senhaTemp}`);
    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({ from: 'ConsultaJá24h <contato@consultaja24h.com.br>', to: [esp.email], subject: 'Sua senha temporária — ConsultaJá24h', html }),
    });
    const resendData = await resendRes.json().catch(() => ({}));
    if (resendRes.ok) {
      console.log(`[ESP-RECOVERY] Email enviado com sucesso. ID: ${resendData.id}`);
    } else {
      console.error(`[ESP-RECOVERY] ERRO Resend status ${resendRes.status}:`, JSON.stringify(resendData));
    }
  } catch (e) {
    console.error('[ESP-RECOVERY] Erro (silencioso):', e.message);
  }
});

// ── ADMIN: atualizar especialista ──────────────────────────────────────────
app.put('/api/admin/especialista/:id', checkAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { email, nome_exibicao, bio, valor_consulta, crm, uf, ativo, visivel } = req.body || {};
    const updates = [];
    const params = [];
    let idx = 1;
    if (email !== undefined) { updates.push(`email = $${idx++}`); params.push(email?.trim().toLowerCase() || null); }
    if (nome_exibicao !== undefined) { updates.push(`nome_exibicao = $${idx++}`); params.push(nome_exibicao?.trim()); }
    if (bio !== undefined) { updates.push(`bio = $${idx++}`); params.push(bio?.trim()); }
    if (valor_consulta !== undefined) { updates.push(`valor_consulta = $${idx++}`); params.push(parseFloat(valor_consulta)); }
    if (crm !== undefined) { updates.push(`crm = $${idx++}`); params.push(crm?.trim().toUpperCase()); }
    if (uf !== undefined) { updates.push(`uf = $${idx++}`); params.push(uf?.trim().toUpperCase()); }
    if (ativo !== undefined) { updates.push(`ativo = $${idx++}`); params.push(!!ativo); }
    if (visivel !== undefined) { updates.push(`visivel = $${idx++}`); params.push(!!visivel); }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Nenhum campo para atualizar' });
    params.push(id);
    const { rows } = await pool.query(`UPDATE especialistas SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, nome_exibicao, email, ativo, visivel`, params);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
    return res.json({ ok: true, especialista: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: meu perfil ───────────────────────────────────────────────
app.get('/api/especialista/me', authEspecialista, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome, nome_exibicao, especialidade, crm, uf, valor_consulta, foto_url, bio, ativo, disponibilidade, visivel
         FROM especialistas WHERE id = $1`,
      [req.especialistaId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
    return res.json({ ok: true, especialista: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: atualizar perfil ─────────────────────────────────────────
app.patch('/api/especialista/perfil', authEspecialista, async (req, res) => {
  try {
    const { nome_exibicao, bio, valor_consulta, crm, uf } = req.body || {};
    const updates = [];
    const params = [];
    let idx = 1;
    if (nome_exibicao !== undefined) { updates.push(`nome_exibicao = $${idx++}`); params.push(nome_exibicao.trim()); }
    if (bio !== undefined) { updates.push(`bio = $${idx++}`); params.push(bio.trim()); }
    if (valor_consulta !== undefined) { updates.push(`valor_consulta = $${idx++}`); params.push(parseFloat(valor_consulta)); }
    if (crm !== undefined) { updates.push(`crm = $${idx++}`); params.push(crm.trim().toUpperCase()); }
    if (uf !== undefined) { updates.push(`uf = $${idx++}`); params.push(uf.trim().toUpperCase()); }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'Nenhum campo para atualizar' });
    params.push(req.especialistaId);
    const { rows } = await pool.query(`UPDATE especialistas SET ${updates.join(', ')} WHERE id = $${idx} RETURNING id, nome_exibicao, especialidade`, params);
    return res.json({ ok: true, especialista: rows[0] });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: atualizar disponibilidade ───────────────────────────────
app.patch('/api/especialista/disponibilidade', authEspecialista, async (req, res) => {
  try {
    const { disponibilidade } = req.body || {};
    if (!Array.isArray(disponibilidade)) {
      return res.status(400).json({ ok: false, error: 'Disponibilidade inválida' });
    }
    await pool.query(`UPDATE especialistas SET disponibilidade = $1::jsonb WHERE id = $2`, [JSON.stringify(disponibilidade), req.especialistaId]);
    console.log(`[ESP-DISP] Especialista #${req.especialistaId} atualizou disponibilidade`);
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: upload foto ───────────────────────────────────────────────
const uploadEsp = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }).single('foto');
app.post('/api/especialista/foto', authEspecialista, uploadEsp, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhuma imagem enviada' });
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    if (!['jpg','jpeg','png','webp'].includes(ext)) return res.status(400).json({ ok: false, error: 'Formato inválido' });
    const key = `especialistas/${req.especialistaId}_${Date.now()}.${ext}`;
    await r2Client.write(key, req.file.buffer, req.file.mimetype);
    const foto_url = R2_PUBLIC_URL + key;
    await pool.query(`UPDATE especialistas SET foto_url = $1 WHERE id = $2`, [foto_url, req.especialistaId]);
    return res.json({ ok: true, foto_url });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: visibilidade (mostrar/ocultar no site) ───────────────────
app.patch('/api/especialista/visivel', authEspecialista, async (req, res) => {
  try {
    const { visivel } = req.body || {};
    if (typeof visivel !== 'boolean') return res.status(400).json({ ok: false, error: 'Campo visivel deve ser boolean' });
    await pool.query(`UPDATE especialistas SET visivel = $1 WHERE id = $2`, [visivel, req.especialistaId]);
    console.log(`[ESP-VISIB] Especialista #${req.especialistaId} visivel=${visivel}`);
    return res.json({ ok: true, visivel });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: admin — listar agendamentos ────────────────────────────────
app.get('/api/admin/especialistas/agendamentos', checkAdmin, async (req, res) => {
  try {
    const { especialidade, status } = req.query;
    let where = '1=1';
    const params = [];
    if (especialidade) { params.push(especialidade); where += ' AND especialidade = $'+params.length; }
    if (status)        { params.push(status);        where += ' AND pagamento_status = $'+params.length; }
    const { rows } = await pool.query(
      `SELECT id, especialista_nome, especialidade, paciente_nome, paciente_email,
              horario_agendado, valor_cobrado, pagamento_status, status, criado_em
         FROM agendamentos_especialistas WHERE ${where} ORDER BY criado_em DESC LIMIT 200`,
      params
    );
    return res.json({ ok: true, agendamentos: rows });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: cancelar agendamento pelo paciente ─────────────────────────
app.delete('/api/especialistas/agendamento/:id/cancelar', authPaciente, async (req, res) => {
  try {
    const agId = parseInt(req.params.id, 10);
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { rows } = await pool.query(
      `SELECT id, pagamento_status, especialista_nome, especialidade, paciente_nome, paciente_email, horario_agendado
         FROM agendamentos_especialistas
        WHERE id = $1 AND paciente_id = $2 LIMIT 1`,
      [agId, req.pacienteId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    if (rows[0].pagamento_status === 'confirmado')
      return res.status(400).json({ ok: false, error: 'Sessão já paga não pode ser cancelada aqui.' });
    await pool.query(`UPDATE agendamentos_especialistas SET status='cancelado' WHERE id=$1`, [agId]);
    
    const ag = rows[0];
    const horarioFmt = new Date(ag.horario_agendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    enviarEmailCancelamentoAdmin({ especialidade: ag.especialidade, especialista: ag.especialista_nome, paciente: ag.paciente_nome, email: ag.paciente_email, horario: horarioFmt, motivo: 'Paciente cancelou' }).catch(()=>{});
    
    return res.json({ ok: true });
  } catch(e) {
    console.error('[ESP-CANCELAR]', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── ESPECIALISTA: listar agendamentos ─────────────────────────────────────────
app.get('/api/especialista/agendamentos', authEspecialista, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, paciente_nome, paciente_email, paciente_tel, horario_agendado, valor_cobrado, pagamento_status, status, created_at
         FROM agendamentos_especialistas
        WHERE especialista_id = $1
        ORDER BY horario_agendado DESC LIMIT 100`,
      [req.especialistaId]
    );
    return res.json({ ok: true, agendamentos: rows });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTA: cancelar agendamento ───────────────────────────────────────
app.delete('/api/especialista/agendamento/:id/cancelar', authEspecialista, async (req, res) => {
  try {
    const agId = parseInt(req.params.id, 10);
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { rows } = await pool.query(
      `SELECT id, especialista_id, especialista_nome, especialidade, paciente_nome, paciente_email, horario_agendado
         FROM agendamentos_especialistas
        WHERE id = $1 AND especialista_id = $2 LIMIT 1`,
      [agId, req.especialistaId]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    await pool.query(`UPDATE agendamentos_especialistas SET status='cancelado' WHERE id=$1`, [agId]);
    
    const ag = rows[0];
    const horarioFmt = new Date(ag.horario_agendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
    enviarEmailCancelamentoAdmin({ especialidade: ag.especialidade, especialista: ag.especialista_nome, paciente: ag.paciente_nome, email: ag.paciente_email, horario: horarioFmt, motivo: 'Profissional cancelou' }).catch(()=>{});
    
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── CONSULTA: buscar dados ────────────────────────────────────────────────────
app.get('/api/consulta/:agendamentoId', authPaciente, async (req, res) => {
  try {
    const agId = parseInt(req.params.agendamentoId, 10);
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    
    // Busca na tabela de especialistas
    const agRes = await pool.query(
      `SELECT id, especialista_nome AS profissional_nome, especialidade AS tipo_consulta, 
              horario_agendado, link_sessao, valor_cobrado, pagamento_status, status
         FROM agendamentos_especialistas 
        WHERE id = $1 AND paciente_id = $2 AND pagamento_status = 'confirmado'`,
      [agId, req.pacienteId]
    );
    
    // Se não encontrar em especialistas, busca em psicologia
    if (agRes.rowCount === 0) {
      const agPsi = await pool.query(
        `SELECT ap.id, ap.psicologo_nome AS profissional_nome, ap.tipo_consulta, 
                ap.horario_agendado, ap.link_sessao, ap.valor_cobrado, ap.pagamento_status, ap.status
           FROM agendamentos_psicologia ap
          WHERE ap.id = $1 AND ap.paciente_id = $2 AND ap.pagamento_status = 'confirmado'`,
        [agId, req.pacienteId]
      );
      if (agPsi.rowCount === 0) return res.status(404).json({ ok: false, error: 'Consulta não encontrada ou não confirmada' });
      var agendamento = agPsi.rows[0];
      agendamento.tipo_consulta = agendamento.tipo_consulta === 'avaliacao' ? 'Avaliação psicológica' : 'Psicoterapia';
    } else {
      var agendamento = agRes.rows[0];
      agendamento.tipo_consulta = agendamento.tipo_consulta.charAt(0).toUpperCase() + agendamento.tipo_consulta.slice(1);
    }
    
    // Busca mensagens
    const msgsRes = await pool.query(
      `SELECT autor, texto, arquivo_url, created_at 
         FROM consulta_mensagens 
        WHERE agendamento_id = $1 AND (agendamento_type = 'especialista' OR agendamento_type = 'psicologia')
        ORDER BY created_at ASC`,
      [agId]
    );
    
    return res.json({ ok: true, agendamento, mensagens: msgsRes.rows });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── CONSULTA: enviar mensagem ────────────────────────────────────────────────
app.post('/api/consulta/:agendamentoId/mensagem', authPaciente, async (req, res) => {
  try {
    const agId = parseInt(req.params.agendamentoId, 10);
    const { texto } = req.body || {};
    if (!texto?.trim()) return res.status(400).json({ ok: false, error: 'Mensagem obrigatória' });
    
    await pool.query(
      `INSERT INTO consulta_mensagens (agendamento_id, autor, texto, agendamento_type)
       VALUES ($1, 'paciente', $2, 'especialista')`,
      [agId, texto.trim()]
    );
    
    return res.json({ ok: true });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── CONSULTA: upload arquivo ────────────────────────────────────────────────
const uploadConsulta = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single('arquivo');
app.post('/api/consulta/:agendamentoId/upload', authPaciente, uploadConsulta, async (req, res) => {
  try {
    const agId = parseInt(req.params.agendamentoId, 10);
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado' });
    
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const allowed = ['jpg','jpeg','png','gif','pdf'];
    if (!allowed.includes(ext)) return res.status(400).json({ ok: false, error: 'Tipo de arquivo não permitido' });
    
    const key = `consultas/${agId}_${Date.now()}.${ext}`;
    await r2Client.write(key, req.file.buffer, req.file.mimetype);
    const arquivo_url = `${process.env.R2_PUBLIC_URL}/${key}`;
    
    const texto = req.body.texto || '';
    await pool.query(
      `INSERT INTO consulta_mensagens (agendamento_id, autor, texto, arquivo_url, agendamento_type)
       VALUES ($1, 'paciente', $2, $3, 'especialista')`,
      [agId, texto, arquivo_url]
    );
    
    return res.json({ ok: true, arquivo_url });
  } catch(e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// ── ESPECIALISTAS: cartão EFI ─────────────────────────────────────────────────
app.post('/api/especialistas/efi/cartao/cobrar', rlGeral, async (req, res) => {
  try {
    const { payment_token, nome, cpf, email, telefone, nascimento, parcelas = 1, agendamentoId } = req.body || {};
    if (!payment_token) return res.status(400).json({ ok: false, error: 'payment_token obrigatório' });
    if (!nome)          return res.status(400).json({ ok: false, error: 'nome obrigatório' });
    if (!cpf)           return res.status(400).json({ ok: false, error: 'cpf obrigatório' });
    if (!agendamentoId) return res.status(400).json({ ok: false, error: 'agendamentoId obrigatório' });
    const cpfLimpo = String(cpf).replace(/\D/g, '');
    if (cpfLimpo.length !== 11) return res.status(400).json({ ok: false, error: 'CPF inválido' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
      return res.status(400).json({ ok: false, error: 'E-mail válido obrigatório para cartão' });
    const telLimpo = String(telefone || '').replace(/\D/g, '');
    if (telLimpo.length < 10)
      return res.status(400).json({ ok: false, error: 'Telefone com DDD obrigatório para cartão' });
    const agRes = await pool.query(
      `SELECT id, valor_cobrado, pagamento_status, especialista_nome, especialidade,
              horario_agendado, especialista_id
         FROM agendamentos_especialistas WHERE id = $1 LIMIT 1`,
      [agendamentoId]
    );
    if (agRes.rowCount === 0) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado' });
    const ag = agRes.rows[0];
    if (ag.pagamento_status === 'confirmado') return res.status(409).json({ ok: false, error: 'Já pago' });
    const slotStart = new Date(ag.horario_agendado);
    const slotEnd   = new Date(slotStart.getTime() + 60 * 60 * 1000);
    const conflito  = await pool.query(
      `SELECT id FROM agendamentos_especialistas
        WHERE especialista_id = $1 AND horario_agendado >= $2 AND horario_agendado < $3
          AND id <> $4 AND status NOT IN ('cancelado') LIMIT 1`,
      [ag.especialista_id, slotStart.toISOString(), slotEnd.toISOString(), agendamentoId]
    );
    if (conflito.rowCount > 0) {
      await pool.query(`UPDATE agendamentos_especialistas SET status='cancelado' WHERE id=$1`, [agendamentoId]);
      return res.status(409).json({ ok: false, error: 'Horário indisponível. Escolha outro.' });
    }
    const valorCentavos = Math.round(parseFloat(ag.valor_cobrado) * 100);
    const efiToken   = await efiGetToken();
    const headers    = { Authorization: `Bearer ${efiToken}`, 'Content-Type': 'application/json' };
    const httpsAgent = getEfiAgent();
    const chargeRes  = await axios.post(`${EFI_BASE_URL}/v1/charge`, {
      items: [{ name: 'Consulta '+ag.especialidade+' — '+ag.especialista_nome, value: valorCentavos, amount: 1 }],
      metadata: {
        custom_id: 'CJ-ESP-CARTAO-'+agendamentoId+'-'+Date.now(),
        notification_url: `${process.env.API_URL || 'https://triagem-api.onrender.com'}/api/especialistas/efi/cartao/webhook`
      }
    }, { httpsAgent, headers });
    const chargeId = chargeRes.data?.data?.charge_id;
    if (!chargeId) return res.status(502).json({ ok: false, error: 'Efí não retornou charge_id' });
    const customer = { name: nome.trim(), cpf: cpfLimpo, email: String(email).trim(), phone_number: telLimpo };
    if (nascimento) customer.birth = nascimento;
    const payRes = await axios.post(`${EFI_BASE_URL}/v1/charge/${chargeId}/pay`, {
      payment: {
        credit_card: {
          customer,
          installments:  Math.max(1, parseInt(parcelas) || 1),
          payment_token: payment_token.trim(),
          billing_address: { street: 'Rua da Consulta', number: '1', neighborhood: 'Centro', zipcode: '65000000', city: 'São Luís', complement: '', state: 'MA' }
        }
      }
    }, { httpsAgent, headers });
    const status = payRes.data?.data?.status;
    const reason = payRes.data?.data?.reason || '';
    if (status === 'paid' || status === 'waiting' || status === 'approved') {
      await pool.query(
        `UPDATE agendamentos_especialistas SET efi_charge_id=$1, pagamento_metodo='cartao' WHERE id=$2`,
        [String(chargeId), agendamentoId]
      );
      if (status === 'paid' || status === 'approved') {
        await pool.query(
          `UPDATE agendamentos_especialistas
              SET pagamento_status='confirmado', pagamento_confirmado_em=NOW(), status='confirmado'
            WHERE id=$1 AND pagamento_status='pendente'`,
          [agendamentoId]
        );
        const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
        appendToSheet('Especialistas_Confirmados', [
          agora, agendamentoId, nome, email||'', ag.especialidade, ag.especialista_nome,
          slotStart.toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}),
          'R$ '+parseFloat(ag.valor_cobrado).toFixed(2).replace('.',','), 'cartao'
        ]).catch(()=>{});
      }
      return res.json({ ok: true, charge_id: chargeId, status });
    }
    return res.status(402).json({ ok: false, charge_id: chargeId, status: status||'unpaid', error: reason||'Cartão não aprovado.' });
  } catch(e) {
    const msg = e.response?.data?.error_description || e.response?.data?.message || e.message || 'Erro ao processar cartão';
    console.error('[ESP-EFI-CARTAO]', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ── ESPECIALISTAS: webhook EFI cartão ─────────────────────────────────────────
app.post('/api/especialistas/efi/cartao/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const notificationToken = req.body?.notification;
    if (!notificationToken) return;
    const efiToken  = await efiGetToken();
    const notifRes  = await axios.get(`${EFI_BASE_URL}/v1/notification/${notificationToken}`, {
      httpsAgent: getEfiAgent(), headers: { Authorization: `Bearer ${efiToken}`, 'Content-Type': 'application/json' }
    });
    for (const charge of (notifRes.data?.data || [])) {
      if (charge.status !== 'paid') continue;
      const chargeId = String(charge.charge_id || charge.id || '');
      if (!chargeId) continue;
      const { rows } = await pool.query(
        `UPDATE agendamentos_especialistas
            SET pagamento_status='confirmado', pagamento_confirmado_em=NOW(), status='confirmado'
          WHERE efi_charge_id=$1 AND pagamento_status='pendente'
          RETURNING id, especialista_nome, especialidade, horario_agendado, valor_cobrado`,
        [chargeId]
      );
      if (rows[0]) {
        console.log('[ESP-EFI-WH] Confirmado #'+rows[0].id);
        const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
        appendToSheet('Especialistas_Confirmados', [
          agora, rows[0].id, '', '', rows[0].especialidade, rows[0].especialista_nome,
          new Date(rows[0].horario_agendado).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}),
          'R$ '+parseFloat(rows[0].valor_cobrado).toFixed(2).replace('.',','), 'cartao'
        ]).catch(()=>{});
      }
    }
  } catch(e) { console.error('[ESP-EFI-WH]', e.message); }
});

// ── FIM ESPECIALISTAS ─────────────────────────────────────────────────────────

app.patch("/api/admin/medico/:id/aprovar", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE medicos SET ativo=true,status='aprovado' WHERE id=$1 RETURNING id,nome,email,status,ativo`,[req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    const med = result.rows[0];
    // E-mail só para o médico aprovado — nunca para outros médicos
    enviarEmailAprovacaoMedico({ nome: med.nome, email: med.email }).catch(()=>{});
    return res.json({ ok: true, medico: med });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch("/api/admin/medico/:id/rejeitar", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`UPDATE medicos SET ativo=false,status='rejeitado' WHERE id=$1 RETURNING id,nome,status`,[req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/admin/medicos/pendentes", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,nome,nome_exibicao,email,crm,uf,telefone,especialidade,cnpj,tem_assinatura_digital,provedor_assinatura,tem_memed,memed_email,status,ativo,created_at FROM medicos WHERE status='pendente' ORDER BY created_at DESC`);
    return res.json({ ok: true, medicos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/admin/medico/criar", checkAdmin, async (req, res) => {
  try {
    const { nome, email, crm, senha } = req.body || {};
    if (!nome||!email||!crm||!senha) return res.status(400).json({ ok: false, error: "Campos obrigatorios faltando" });
    const senha_hash = await bcrypt.hash(senha, 10);
    const result = await pool.query(
      `INSERT INTO medicos (nome,email,senha_hash,crm,status_online,ativo) VALUES ($1,$2,$3,$4,false,true) RETURNING id,nome,email,crm,status_online,ativo,created_at`,
      [nome,email.trim().toLowerCase(),senha_hash,crm]
    );
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) {
    if (err.code==="23505") return res.status(400).json({ ok: false, error: "E-mail ja cadastrado" });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/admin/medicos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT id,nome,email,crm,status_online,ativo,created_at FROM medicos ORDER BY id DESC");
    return res.json({ ok: true, medicos: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});

app.patch("/api/admin/medico/:id", checkAdmin, async (req, res) => {
  try {
    const { ativo } = req.body || {};
    if (typeof ativo !== "boolean") return res.status(400).json({ ok: false, error: "Campo ativo deve ser boolean" });
    const result = await pool.query("UPDATE medicos SET ativo=$1 WHERE id=$2 RETURNING id,nome,ativo",[ativo,req.params.id]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Medico nao encontrado" });
    return res.json({ ok: true, medico: result.rows[0] });
  } catch (err) { return res.status(500).json({ ok: false, error: err.message }); }
});


// ── MEMED: obter/criar token do médico ────────────────────────────────────────
const MEMED_API_URL = process.env.MEMED_API_URL || "https://api.memed.com.br/v1";
const MEMED_API_KEY = process.env.MEMED_API_KEY || "";
const MEMED_SECRET_KEY = process.env.MEMED_SECRET_KEY || "";

// ── Middleware combinado: aceita token de médico OU especialista ──────────────
function checkMedicoOuEspecialista(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return res.status(401).json({ ok: false, error: 'Token não fornecido' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.tipo === 'especialista') {
      // Monta req.medico compatível com o handler existente usando dados do especialista
      req.medico = { id: decoded.id, tipo: 'especialista' };
      req.medicoId = decoded.id;
      req._isEspecialista = true;
      return next();
    }
    // Fluxo normal de médico
    req.medico = decoded;
    req.medicoId = decoded.id;
    req._isEspecialista = false;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Token inválido ou expirado' });
  }
}

app.get("/api/memed/token", checkMedicoOuEspecialista, async (req, res) => {
  try {
    // Branch especialista — redireciona para lógica própria
    if (req._isEspecialista) {
      const { rows: espRows } = await pool.query(
        `SELECT id, nome, nome_exibicao, crm, uf, email FROM especialistas WHERE id = $1`,
        [req.medicoId]
      );
      if (espRows.length === 0) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
      const esp = espRows[0];
      if (!esp.uf || esp.uf.trim().length < 2) {
        return res.status(400).json({ ok: false, error: 'UF não cadastrada. Atualize seu perfil.' });
      }
      const uf = esp.uf.trim().toUpperCase();
      const partesNome = (esp.nome_exibicao || esp.nome || 'Especialista').trim().split(/\s+/);
      const nomeLocal = partesNome[0];
      const sobrenomeLocal = partesNome.slice(1).join(' ') || 'ConsultaJa';
      const externalId = `esp-${esp.id}`;
      const getUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios/${externalId}?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
      const getRes = await fetch(getUrl, { headers: { 'Accept': 'application/vnd.api+json', 'Content-Type': 'application/json' } });
      if (getRes.ok) {
        const getData = await getRes.json();
        const token = getData?.data?.attributes?.token;
        if (token) return res.json({ ok: true, token });
      }
      const postUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
      const postRes = await fetch(postUrl, {
        method: 'POST',
        headers: { 'Accept': 'application/vnd.api+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { type: 'usuarios', attributes: {
          nome: nomeLocal, sobrenome: sobrenomeLocal,
          email: esp.email || `esp${esp.id}@consultaja24h.com.br`,
          external_id: externalId,
          board: { board_code: 'CRM', board_number: (esp.crm || '').replace(/\D/g, ''), board_state: uf },
        }}}),
      });
      const postData = await postRes.json();
      const token = postData?.data?.attributes?.token;
      if (!token) return res.status(502).json({ ok: false, error: 'Não foi possível carregar a prescrição' });
      return res.json({ ok: true, token });
    }
    // Branch médico normal (lógica original abaixo)
    const medicoId = req.medico.id;
    const medResult = await pool.query(
      `SELECT id,nome,email,crm,uf,telefone,especialidade,cpf_medico,data_nascimento_medico,memed_external_id FROM medicos WHERE id=$1`,
      [medicoId]
    );
    if (medResult.rowCount === 0) return res.status(404).json({ ok: false, error: "Médico não encontrado" });
    const med = medResult.rows[0];

    // UF obrigatória — não assume fallback
    if (!med.uf || med.uf.trim().length < 2) {
      console.warn(`[MEMED] Médico id=${med.id} sem UF cadastrada.`);
      return res.status(400).json({ ok: false, error: "UF do médico não cadastrada. Atualize seu perfil antes de usar a prescrição." });
    }
    const ufLocal = med.uf.trim().toUpperCase();

    // Separa nome/sobrenome a partir do banco (usado tanto no GET quanto no POST)
    const partesNome = (med.nome || "Médico").trim().split(/\s+/);
    const nomeLocal = partesNome[0];
    const sobrenomeLocal = partesNome.slice(1).join(" ") || "ConsultaJa";

    // Monta external_id único para o médico
    const externalId = med.memed_external_id || `consultaja-${med.id}`;

    // Tenta obter token existente primeiro
    const getUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios/${externalId}?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
    const getRes = await fetch(getUrl, {
      headers: { "Accept": "application/vnd.api+json", "Content-Type": "application/json" }
    });

    if (getRes.ok) {
      const getData = await getRes.json();
      const token = getData?.data?.attributes?.token;
      if (token) {
        // Salva external_id se ainda não tinha
        if (!med.memed_external_id) {
          await pool.query(`UPDATE medicos SET memed_external_id=$1 WHERE id=$2`, [externalId, medicoId]);
        }

        // Verifica consistência de UF e sobrenome (case-insensitive + trim)
        const ufMemed       = (getData?.data?.attributes?.board?.board_state || "").trim().toUpperCase();
        const sobrenomeMemed = (getData?.data?.attributes?.sobrenome || "").trim().toLowerCase();
        const ufOk          = ufMemed === ufLocal;
        const sobrenomeOk   = sobrenomeMemed === sobrenomeLocal.toLowerCase();

        if (!ufOk || !sobrenomeOk) {
          console.warn(`[MEMED] Inconsistência médico id=${med.id}: UF banco=${ufLocal} Memed=${ufMemed} | sobrenome banco="${sobrenomeLocal}" Memed="${getData?.data?.attributes?.sobrenome}"`);
          // Tenta corrigir via PATCH — sem recriar usuário
          try {
            const patchUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios/${externalId}?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
            const patchRes = await fetch(patchUrl, {
              method: "PATCH",
              headers: { "Accept": "application/vnd.api+json", "Content-Type": "application/json" },
              body: JSON.stringify({
                data: {
                  type: "usuarios",
                  attributes: {
                    nome: nomeLocal,
                    sobrenome: sobrenomeLocal,
                    board: {
                      board_code: "CRM",
                      board_number: (med.crm || "").replace(/\D/g, ""),
                      board_state: ufLocal
                    }
                  }
                }
              })
            });
            const patchData = await patchRes.json();
            if (patchRes.ok) {
              console.log(`[MEMED] Cadastro corrigido médico id=${med.id} (UF→${ufLocal}, sobrenome→"${sobrenomeLocal}")`);
              const tokenCorrigido = patchData?.data?.attributes?.token || token;
              return res.json({ ok: true, token: tokenCorrigido, externalId });
            } else {
              console.error(`[MEMED] PATCH falhou médico id=${med.id}:`, JSON.stringify(patchData).substring(0, 300));
              // Não quebra — retorna token atual mesmo com dados ainda desatualizados
              return res.json({ ok: true, token, externalId });
            }
          } catch (patchErr) {
            console.error(`[MEMED] Erro PATCH médico id=${med.id}:`, patchErr.message);
            return res.json({ ok: true, token, externalId });
          }
        }

        // Dados consistentes — reutiliza token sem alteração
        return res.json({ ok: true, token, externalId });
      }
    }

    // Médico não existe no Memed — cadastra
    const crmNumero = (med.crm || "").replace(/\D/g, "");

    const payload = {
      data: {
        type: "usuarios",
        attributes: {
          external_id: externalId,
          nome: nomeLocal,
          sobrenome: sobrenomeLocal,
          cpf: (med.cpf_medico || "").replace(/\D/g, "") || undefined,
          data_nascimento: med.data_nascimento_medico || undefined,
          email: med.email || undefined,
          telefone: (med.telefone || "").replace(/\D/g, "") || undefined,
          especialidade: med.especialidade || undefined,
          board: {
            board_code: "CRM",
            board_number: crmNumero,
            board_state: ufLocal
          }
        }
      }
    };

    // Remove campos undefined
    Object.keys(payload.data.attributes).forEach(k => {
      if (payload.data.attributes[k] === undefined) delete payload.data.attributes[k];
    });

    const postUrl = `${MEMED_API_URL}/sinapse-prescricao/usuarios?api-key=${MEMED_API_KEY}&secret-key=${MEMED_SECRET_KEY}`;
    const postRes = await fetch(postUrl, {
      method: "POST",
      headers: { "Accept": "application/vnd.api+json", "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const postData = await postRes.json();
    console.log("[MEMED] Cadastro prescritor:", JSON.stringify(postData).substring(0, 200));

    const token = postData?.data?.attributes?.token;
    if (!token) return res.status(500).json({ ok: false, error: "Não foi possível obter token Memed", detail: postData });

    await pool.query(`UPDATE medicos SET memed_external_id=$1 WHERE id=$2`, [externalId, medicoId]);
    return res.json({ ok: true, token, externalId });

  } catch(e) {
    console.error("[MEMED] Erro token:", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao obter token Memed" });
  }
});

// ── ADMIN: histórico geral de todos os atendimentos ───────────────────────────
app.get("/api/admin/historico", checkAdmin, async (req, res) => {
  try {
    const { medico_id, data_inicio, data_fim, busca } = req.query;
    let where = `WHERE status IN ('encerrado','expirado','arquivado','assumido')`;
    const params = [];
    if (medico_id) { params.push(medico_id); where += ` AND medico_id=$${params.length}`; }
    if (data_inicio) { params.push(data_inicio); where += ` AND criado_em >= $${params.length}::date`; }
    if (data_fim) { params.push(data_fim); where += ` AND criado_em < ($${params.length}::date + interval '1 day')`; }
    if (busca) { params.push(`%${busca}%`); where += ` AND (nome ILIKE $${params.length} OR tel ILIKE $${params.length} OR cpf ILIKE $${params.length})`; }
    const result = await pool.query(
      `SELECT id,nome,tel,cpf,tipo,triagem,status,medico_id,medico_nome,prontuario,
              criado_em,assumido_em,encerrado_em,data_nascimento,idade,sexo,solicita,status_atendimento
       FROM fila_atendimentos ${where} ORDER BY criado_em DESC LIMIT 200`,
      params
    );
    const medicos = await pool.query(`SELECT id,nome,nome_exibicao FROM medicos WHERE ativo=true ORDER BY nome`);
    return res.json({ ok: true, historico: result.rows, medicos: medicos.rows });
  } catch(e) {
    console.error("[ADMIN-HISTORICO]", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao carregar histórico" });
  }
});

// Rate limiting simples para esqueci-senha
const esqueciRateLimit = new Map();

app.post("/api/medico/esqueci-senha", rlLogin, async (req, res) => {
  const MSG_GENERICA = { ok: true, message: "Se o e-mail existir na plataforma, enviamos as instruções de acesso." };
  try {
    const { email } = req.body || {};
    if (!email) return res.json(MSG_GENERICA);
    const emailNorm = email.trim().toLowerCase();
    // Rate limit: max 3 tentativas por e-mail a cada 15min
    const agora = Date.now();
    const chave = emailNorm;
    const hist = esqueciRateLimit.get(chave) || [];
    const recentes = hist.filter(t => agora - t < 15 * 60 * 1000);
    if (recentes.length >= 3) return res.json(MSG_GENERICA);
    esqueciRateLimit.set(chave, [...recentes, agora]);
    // Busca médico
    const result = await pool.query("SELECT id,nome,email FROM medicos WHERE email=$1 AND ativo=true LIMIT 1",[emailNorm]);
    if (result.rowCount === 0) return res.json(MSG_GENERICA);
    const med = result.rows[0];
    // Gera senha temporária aleatória
    const { randomBytes } = await import("crypto");
    const tempSenha = randomBytes(12).toString("base64url"); // 16 chars base64url
    const tempHash = await bcrypt.hash(tempSenha, 10);
    await pool.query("UPDATE medicos SET senha_hash=$1, precisa_trocar_senha=true WHERE id=$2",[tempHash, med.id]);
    // Envia e-mail
    const RESEND_KEY = process.env.RESEND_API_KEY;
    const PAINEL_URL = "https://painel.consultaja24h.com.br";
    if (RESEND_KEY) {
      const html = `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;background:#060d0b;color:#fff;border-radius:12px;overflow:hidden">
        <div style="background:linear-gradient(135deg,#b4e05a,#5ee0a0);padding:18px 24px"><h2 style="margin:0;color:#051208;font-size:17px">Acesso temporário ao painel médico</h2></div>
        <div style="padding:28px">
          <p style="margin:0 0 16px">Olá, <strong>${med.nome}</strong>.</p>
          <p style="margin:0 0 16px;color:rgba(255,255,255,.7)">Recebemos uma solicitação de recuperação de acesso ao painel médico ConsultaJá24h.</p>
          <p style="margin:0 0 8px;color:rgba(255,255,255,.5);font-size:13px">Sua senha temporária é:</p>
          <div style="background:rgba(255,255,255,.07);border:1px solid rgba(180,224,90,.3);border-radius:10px;padding:16px 20px;text-align:center;margin-bottom:20px">
            <span style="font-family:monospace;font-size:22px;font-weight:700;color:#b4e05a;letter-spacing:3px">${tempSenha}</span>
          </div>
          <p style="margin:0 0 20px;color:rgba(255,255,255,.5);font-size:13px">⚠️ Troque esta senha imediatamente após o login. Ela é válida para um único acesso.</p>
          <a href="${PAINEL_URL}" style="display:inline-block;padding:12px 28px;border-radius:10px;background:linear-gradient(135deg,#b4e05a,#5ee0a0);color:#051208;font-weight:700;font-size:.9rem;text-decoration:none">Acessar o painel</a>
          <p style="margin:24px 0 0;font-size:11px;color:rgba(255,255,255,.2)">Se você não solicitou isso, ignore este e-mail. Sua senha anterior continuará funcionando.</p>
        </div>
      </div>`;
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({ from: "ConsultaJa24h <contato@consultaja24h.com.br>", to: [med.email], subject: "Acesso temporário ao painel médico", html })
      });
    }
    console.log("[ESQUECI-SENHA] Senha temporária gerada para médico #" + med.id);
    return res.json(MSG_GENERICA);
  } catch(e) {
    console.error("[ESQUECI-SENHA] Erro:", e.message);
    return res.json({ ok: true, message: "Se o e-mail existir na plataforma, enviamos as instruções de acesso." });
  }
});

app.post("/api/medico/trocar-senha", checkMedico, async (req, res) => {
  try {
    const { senhaAtual, novaSenha, confirmarSenha } = req.body || {};
    if (!senhaAtual || !novaSenha || !confirmarSenha)
      return res.status(400).json({ ok: false, error: "Preencha todos os campos." });
    if (novaSenha !== confirmarSenha)
      return res.status(400).json({ ok: false, error: "A nova senha e a confirmação não coincidem." });
    if (novaSenha.length < 6)
      return res.status(400).json({ ok: false, error: "A nova senha deve ter pelo menos 6 caracteres." });
    const medicoId = req.medicoId;
    const result = await pool.query("SELECT senha_hash FROM medicos WHERE id=$1",[medicoId]);
    if (result.rowCount === 0) return res.status(404).json({ ok: false, error: "Médico não encontrado." });
    const senhaOk = await bcrypt.compare(senhaAtual, result.rows[0].senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: "Senha atual incorreta." });
    const novoHash = await bcrypt.hash(novaSenha, 10);
    await pool.query("UPDATE medicos SET senha_hash=$1, precisa_trocar_senha=false WHERE id=$2",[novoHash, medicoId]);
    console.log("[TROCAR-SENHA] Senha atualizada para médico #" + medicoId);
    return res.json({ ok: true });
  } catch(e) {
    console.error("[TROCAR-SENHA] Erro:", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao trocar senha." });
  }
});

app.post("/api/medico/login", rlLogin, async (req, res) => {
  try {
    const { email, senha } = req.body || {};
    if (!email||!senha) return res.status(400).json({ ok: false, error: "E-mail e senha sao obrigatorios" });
    const result = await pool.query("SELECT id,nome,nome_exibicao,email,crm,senha_hash,ativo,precisa_trocar_senha FROM medicos WHERE email=$1 LIMIT 1",[email.trim().toLowerCase()]);
    if (result.rowCount===0) return res.status(401).json({ ok: false, error: "Credenciais invalidas" });
    const med = result.rows[0];
    if (!med.ativo) return res.status(403).json({ ok: false, error: "Seu cadastro ainda esta em analise pela equipe da plataforma." });
    const senhaOk = await bcrypt.compare(senha, med.senha_hash);
    if (!senhaOk) return res.status(401).json({ ok: false, error: "Credenciais invalidas" });
    const token = jwt.sign({ id: med.id, nome: med.nome, crm: med.crm }, JWT_SECRET, { expiresIn: "8h" });
    return res.json({ ok: true, token, precisa_trocar_senha: !!med.precisa_trocar_senha, medico: { id: med.id, nome: med.nome_exibicao||med.nome, email: med.email, crm: med.crm } });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro interno no login" }); }
});

app.get("/api/fila", checkMedico, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id,nome,tel,cpf,tipo,triagem,status,medico_id,medico_nome,meet_link,criado_em,data_nascimento,idade,sexo,alergias,cronicas,medicacoes,queixa,solicita,horario_agendado FROM fila_atendimentos WHERE status IN ('aguardando','assumido') AND (horario_agendado IS NULL OR horario_agendado <= NOW() + INTERVAL '15 minutes') ORDER BY criado_em ASC`);
    return res.json({ ok: true, fila: result.rows });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao carregar fila" }); }
});

// ── BUSCA DE PACIENTES (médico) ───────────────────────────────────────────────
app.get("/api/pacientes/busca", checkMedico, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ ok: true, pacientes: [] });
    const busca = `%${q.trim()}%`;
    const result = await pool.query(
      `SELECT id, nome, tel, cpf, tipo, triagem, queixa, status,
              encerrado_em, prontuario AS prontuario_salvo
       FROM fila_atendimentos
       WHERE status IN ('encerrado','expirado','arquivado')
         AND (nome ILIKE $1 OR cpf ILIKE $1 OR tel ILIKE $1)
       ORDER BY encerrado_em DESC
       LIMIT 50`,
      [busca]
    );
    return res.json({ ok: true, pacientes: result.rows });
  } catch(e) {
    console.error("[BUSCA PACIENTES]", e.message);
    return res.status(500).json({ ok: false, error: "Erro na busca" });
  }
});

app.get("/api/historico", checkMedico, async (req, res) => {
  try {
    const medicoId = req.medico.id;
    const result = await pool.query(
      `SELECT id, nome, tel, tel_documentos, cpf, tipo, triagem, status,
              status_atendimento, documentos_emitidos, medico_nome,
              criado_em, assumido_em, encerrado_em,
              data_nascimento, idade, sexo, alergias, cronicas, medicacoes, queixa, solicita,
              prontuario AS prontuario_salvo
       FROM fila_atendimentos
       WHERE medico_id = $1
         AND status IN ('encerrado', 'expirado', 'arquivado')
         AND encerrado_em >= NOW() - INTERVAL '10 years'
       ORDER BY encerrado_em DESC`,
      [medicoId]
    );
    return res.json({ ok: true, historico: result.rows });
  } catch (err) {
    console.error("Erro em /api/historico:", err);
    return res.status(500).json({ ok: false, error: "Erro ao carregar historico" });
  }
});

app.post("/api/atendimento/assumir", async (req, res) => {
  try {
    const { filaId, medicoId, medicoNome } = req.body || {};
    if (!filaId||!medicoId||!medicoNome) return res.status(400).json({ ok: false, error: "Dados obrigatorios faltando" });
    const result = await pool.query(
      `UPDATE fila_atendimentos SET status='assumido',medico_id=$1,medico_nome=$2,assumido_em=NOW() WHERE id=$3 AND status='aguardando' RETURNING *`,
      [medicoId,medicoNome,filaId]
    );
    if (result.rowCount===0) return res.status(409).json({ ok: false, error: "Paciente ja foi assumido" });
    const at2 = result.rows[0];

    // Da baixa no agendamento para sair do badge de agendamentos
    if (at2.agendamento_id) {
      await pool.query(
        `UPDATE agendamentos SET status='iniciado' WHERE id=$1 AND status='confirmado'`,
        [at2.agendamento_id]
      ).catch(e => console.warn("[ASSUMIR] Update agendamento falhou:", e.message));
    } else {
      // Fallback: busca por tel + janela de 30min ao redor do horario agendado
      await pool.query(
        `UPDATE agendamentos SET status='iniciado'
          WHERE tel=$1
            AND status='confirmado'
            AND horario_agendado BETWEEN NOW() - INTERVAL '30 minutes' AND NOW() + INTERVAL '30 minutes'`,
        [at2.tel]
      ).catch(e => console.warn("[ASSUMIR] Fallback agendamento falhou:", e.message));
    }

    const agora2 = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    appendToSheet("Atendimentos",[agora2,at2.nome||"",at2.tel||"",at2.cpf||"","Assumido",medicoNome||"",at2.triagem||"",at2.tipo||"","",String(filaId)]).catch(e=>console.error("[Sheets]",e));
    return res.json({ ok: true, atendimento: at2 });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao assumir atendimento" }); }
});

app.post("/api/atendimento/meet", async (req, res) => {
  try {
    const { filaId, meetLink } = req.body || {};
    if (!filaId||!meetLink) return res.status(400).json({ ok: false, error: "filaId e meetLink obrigatorios" });
    const result = await pool.query(`UPDATE fila_atendimentos SET meet_link=$1 WHERE id=$2 RETURNING id,meet_link`,[meetLink.trim(),filaId]);
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    return res.json({ ok: true, meet_link: result.rows[0].meet_link });
  } catch (err) { return res.status(500).json({ ok: false, error: "Erro ao salvar link" }); }
});

// ── POST /api/atendimento/vincular-order ─────────────────────────────────────
// Vincula o pagbank_order_id ao atendimento assim que a order e criada no PagBank.
// Chamado pelo frontend apos /api/pagbank/order + /api/notify.
// Idempotente: so grava se ainda nao tiver order vinculada.
app.post("/api/atendimento/vincular-order", async (req, res) => {
  try {
    const { atendimentoId, orderId } = req.body || {};
    if (!atendimentoId || !orderId)
      return res.status(400).json({ ok: false, error: "atendimentoId e orderId obrigatorios" });

    await pool.query(
      `UPDATE fila_atendimentos
          SET pagbank_order_id = $2
        WHERE id = $1
          AND pagbank_order_id IS NULL`,
      [atendimentoId, orderId]
    );

    console.log("[VINCULAR-ORDER] atendimento #" + atendimentoId + " <- order " + orderId);
    return res.json({ ok: true });
  } catch (e) {
    console.error("[VINCULAR-ORDER]", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao vincular order" });
  }
});

// ── GET /api/aprovacao/liberar ────────────────────────────────────────────────
app.get("/api/aprovacao/liberar", async (req, res) => {
  const { id, token } = req.query;
  const page = (titulo, cor, icone, msg) => res.send(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><style>body{font-family:sans-serif;background:#060d0b;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{max-width:400px;text-align:center;padding:32px 24px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:16px}.icon{font-size:2.8rem;margin-bottom:14px}.title{font-size:1.15rem;font-weight:600;color:${cor};margin-bottom:8px}.msg{font-size:.85rem;color:rgba(255,255,255,.45);line-height:1.65}</style></head><body><div class="box"><div class="icon">${icone}</div><div class="title">${titulo}</div><p class="msg">${msg}</p></div></body></html>`
  );
  if (!id || !token) return page("Erro", "#ff5f57", "❌", "Link inválido.");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (String(payload.atendimentoId) !== String(id) || payload.acao !== "aprovacao")
      return page("Erro", "#ff5f57", "❌", "Token inválido.");
    const row = await pool.query(`SELECT status, aprovacao_token FROM fila_atendimentos WHERE id=$1`,[id]);
    if (!row.rows[0]) return page("Não encontrado", "#ffbd2e", "⚠️", "Atendimento não encontrado.");
    const { status, aprovacao_token } = row.rows[0];
    if (status === "cancelado")   return page("Já cancelado",  "#ffbd2e", "⚠️", "Este atendimento já foi cancelado.");
    if (["aguardando","assumido","encerrado"].includes(status))
      return page("Já liberado", "#5ee0a0", "✅", "Atendimento já liberado para os médicos.");
    if (status !== "aguardando_aprovacao")
      return page("Status inválido", "#ffbd2e", "⚠️", `Status atual: ${status}.`);
    if (aprovacao_token !== token)
      return page("Token expirado", "#ffbd2e", "⚠️", "Este link já foi usado ou expirou.");
    await liberarAtendimentoParaMedicos(Number(id));
    return page("Liberado!", "#5ee0a0", "✅", "Atendimento liberado. O paciente será conectado ao médico.");
  } catch(e) {
    if (e.name === "TokenExpiredError")
      return page("Link expirado", "#ffbd2e", "⚠️", "O link expirou (10 min). O atendimento pode ter sido liberado automaticamente.");
    console.error("[APROVACAO] Erro ao liberar:", e.message);
    return page("Erro", "#ff5f57", "❌", "Erro interno. Tente novamente.");
  }
});

// ── GET /api/aprovacao/cancelar ───────────────────────────────────────────────
app.get("/api/aprovacao/cancelar", async (req, res) => {
  const { id, token } = req.query;
  const page = (titulo, cor, icone, msg) => res.send(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title><style>body{font-family:sans-serif;background:#060d0b;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}.box{max-width:400px;text-align:center;padding:32px 24px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:16px}.icon{font-size:2.8rem;margin-bottom:14px}.title{font-size:1.15rem;font-weight:600;color:${cor};margin-bottom:8px}.msg{font-size:.85rem;color:rgba(255,255,255,.45);line-height:1.65}</style></head><body><div class="box"><div class="icon">${icone}</div><div class="title">${titulo}</div><p class="msg">${msg}</p></div></body></html>`
  );
  if (!id || !token) return page("Erro", "#ff5f57", "❌", "Link inválido.");
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (String(payload.atendimentoId) !== String(id) || payload.acao !== "aprovacao")
      return page("Erro", "#ff5f57", "❌", "Token inválido.");
    const row = await pool.query(`SELECT status, aprovacao_token FROM fila_atendimentos WHERE id=$1`,[id]);
    if (!row.rows[0]) return page("Não encontrado", "#ffbd2e", "⚠️", "Atendimento não encontrado.");
    const { status, aprovacao_token } = row.rows[0];
    if (status === "cancelado")    return page("Já cancelado", "#ffbd2e", "⚠️", "Este atendimento já foi cancelado.");
    if (status !== "aguardando_aprovacao")
      return page("Ação indisponível", "#ffbd2e", "⚠️", `O atendimento já está em status: ${status}.`);
    if (aprovacao_token !== token)
      return page("Token expirado", "#ffbd2e", "⚠️", "Este link já foi usado ou expirou.");
    await pool.query(
      `UPDATE fila_atendimentos SET status='cancelado', aprovacao_token=NULL, encerrado_em=NOW() WHERE id=$1 AND status='aguardando_aprovacao'`,
      [id]
    );
    console.log(`[CANCELADO] Atendimento #${id} cancelado pelo admin.`);
    return page("Cancelado", "#ff5f57", "❌", "Pagamento não confirmado. Atendimento cancelado.");
  } catch(e) {
    if (e.name === "TokenExpiredError")
      return page("Link expirado", "#ffbd2e", "⚠️", "O link expirou. Verifique o status no painel.");
    console.error("[APROVACAO] Erro ao cancelar:", e.message);
    return page("Erro", "#ff5f57", "❌", "Erro interno. Tente novamente.");
  }
});

app.post("/api/atendimento/encerrar", async (req, res) => {
  try {
    const { filaId, status, documentos_emitidos } = req.body || {};
    if (!filaId) return res.status(400).json({ ok: false, error: "filaId e obrigatorio" });
    const result = await pool.query(
      `UPDATE fila_atendimentos SET status='encerrado',encerrado_em=NOW(),status_atendimento=$2,documentos_emitidos=$3 WHERE id=$1 RETURNING *`,
      [filaId,status||"Encerrado",documentos_emitidos||"Nenhum"]
    );
    if (result.rowCount===0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    const at = result.rows[0];
    const agora = new Date().toLocaleString("pt-BR",{timeZone:"America/Fortaleza"});
    appendToSheet("Atendimentos",[agora,at.nome||"",at.tel||"",at.cpf||"","Encerrado",at.medico_nome||"",at.triagem||"",at.tipo||"",at.documentos_emitidos||"",String(at.id)]).catch(e=>console.error("[Sheets]",e));
    return res.json({ ok: true, atendimento: at });
  } catch (err) { console.error("Erro em /api/atendimento/encerrar:", err); return res.status(500).json({ ok: false, error: "Erro ao encerrar atendimento" }); }
});

app.post("/api/atendimento/reabrir", autenticarMedico, async (req, res) => {
  try {
    const { filaId } = req.body || {};
    if (!filaId) return res.status(400).json({ ok: false, error: "filaId obrigatorio" });
    const check = await pool.query(
      "SELECT id, medico_id, status FROM fila_atendimentos WHERE id=$1",
      [filaId]
    );
    if (check.rowCount === 0) return res.status(404).json({ ok: false, error: "Atendimento nao encontrado" });
    const at = check.rows[0];
    if (at.status !== "encerrado") return res.status(400).json({ ok: false, error: "Apenas atendimentos encerrados podem ser reabertos" });
    if (String(at.medico_id) !== String(req.medico.id)) return res.status(403).json({ ok: false, error: "Voce nao foi o medico deste atendimento" });
    const result = await pool.query(
      "UPDATE fila_atendimentos SET status='assumido', encerrado_em=NULL, status_atendimento=NULL WHERE id=$1 RETURNING *",
      [filaId]
    );
    console.log("[REABRIR] Atendimento #" + filaId + " reaberto pelo medico " + req.medico.nome);
    return res.json({ ok: true, atendimento: result.rows[0] });
  } catch(e) {
    console.error("[REABRIR]", e.message);
    return res.status(500).json({ ok: false, error: "Erro ao reabrir atendimento" });
  }
});

app.post("/api/atendimento/prontuario", autenticarMedico, async (req, res) => {
  const { filaId, prontuario } = req.body;
  if (!filaId || prontuario === undefined) {
    return res.status(400).json({ ok: false, error: "filaId e prontuario sao obrigatorios" });
  }
  try {
    // Permite salvar se for o médico do atendimento OU se o atendimento estiver sendo encerrado
    // (medico_id pode ser 0 quando assumido via e-mail pelo admin)
    const r = await pool.query(
      "UPDATE fila_atendimentos SET prontuario = $1 WHERE id = $2 AND (medico_id = $3 OR medico_id = 0 OR medico_id IS NULL OR $3 = (SELECT id FROM medicos WHERE email='gustavosgbf@gmail.com' LIMIT 1))",
      [prontuario, filaId, req.medico.id]
    );
    if (r.rowCount === 0) {
      // Fallback: tenta salvar sem restrição de médico (para casos de encerramento)
      const r2 = await pool.query(
        "UPDATE fila_atendimentos SET prontuario = $1 WHERE id = $2",
        [prontuario, filaId]
      );
      if (r2.rowCount === 0) {
        return res.status(403).json({ ok: false, error: "Atendimento nao encontrado." });
      }
    }
    console.log("[prontuario] Salvo para atendimento #" + filaId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[prontuario] Erro ao salvar:", err.message);
    res.status(500).json({ ok: false, error: "Erro ao salvar prontuario" });
  }
});

app.post("/api/plantao/entrar", async (req, res) => {
  try {
    const auth = req.headers["authorization"]||"";
    const decoded = jwt.verify(auth.replace("Bearer ",""), JWT_SECRET);
    await pool.query("UPDATE medicos SET status_online=true WHERE id=$1",[decoded.id]);
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: true }); }
});

app.post("/api/plantao/sair", async (req, res) => {
  try {
    const auth = req.headers["authorization"]||"";
    const decoded = jwt.verify(auth.replace("Bearer ",""), JWT_SECRET);
    await pool.query("UPDATE medicos SET status_online=false WHERE id=$1",[decoded.id]);
    return res.json({ ok: true });
  } catch (e) { return res.json({ ok: true }); }
});

app.get("/relatorio", checkAdmin, async (req, res) => {
  try {
    const [atenRes, idRes, consRes] = await Promise.all([
      pool.query(`SELECT id,nome,tel,cpf,tipo,triagem,status,medico_nome,documentos_emitidos,criado_em,encerrado_em FROM fila_atendimentos ORDER BY criado_em DESC`),
      pool.query(`SELECT nome,tel,data,ip FROM identificacoes ORDER BY id DESC LIMIT 200`),
      pool.query(`SELECT nome,tel,versao,data,ip FROM consentimentos ORDER BY id DESC LIMIT 200`),
    ]);
    const atend=atenRes.rows, ident=idRes.rows, cons=consRes.rows;
    const total=atend.length, encerrados=atend.filter(a=>a.status==='encerrado').length,
          aguardando=atend.filter(a=>a.status==='aguardando').length, assumidos=atend.filter(a=>a.status==='assumido').length;
    const css=`*{box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:1100px;margin:0 auto}h1{color:#b4e05a;margin:0 0 4px}h2{color:#b4e05a;font-size:1rem;text-transform:uppercase;letter-spacing:.1em;margin:36px 0 12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.08)}p.sub{color:rgba(255,255,255,.35);font-size:.82rem;margin:0 0 28px}table{width:100%;border-collapse:collapse;margin-bottom:8px;font-size:.83rem}th{text-align:left;padding:9px 11px;background:rgba(180,224,90,.07);color:#b4e05a;font-size:.72rem;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}td{padding:9px 11px;border-bottom:1px solid rgba(255,255,255,.05);vertical-align:top}tr:hover td{background:rgba(255,255,255,.02)}.badge{display:inline-block;padding:2px 9px;border-radius:999px;font-size:.7rem;font-weight:600;white-space:nowrap}.badge.encerrado{background:rgba(94,224,160,.1);color:#5ee0a0}.badge.aguardando{background:rgba(255,189,46,.1);color:#ffbd2e}.badge.assumido{background:rgba(180,224,90,.1);color:#b4e05a}.badge.expirado{background:rgba(255,100,100,.1);color:#ff6464}.badge.triagem{background:rgba(180,180,180,.1);color:#aaa}.badge.chat{background:rgba(37,211,102,.1);color:#25d366}.badge.video{background:rgba(94,224,160,.1);color:#5ee0a0}.badge.lgpd{background:rgba(66,133,244,.12);color:#7baeff}.totais{display:flex;gap:20px;flex-wrap:wrap;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px;padding:16px 20px;margin-bottom:28px}.t-item span{display:block;font-size:.68rem;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.1em;margin-bottom:4px}.t-item strong{font-size:1.4rem;color:#b4e05a}a{color:#5ee0a0;text-decoration:none}a:hover{text-decoration:underline}.nav{display:flex;gap:12px;margin-bottom:28px;flex-wrap:wrap}.nav a{padding:6px 16px;border-radius:8px;background:rgba(180,224,90,.08);border:1px solid rgba(180,224,90,.18);color:#b4e05a;font-size:.8rem;font-weight:600}.dim{color:rgba(255,255,255,.35);font-size:.76rem}.triagem-cell{max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.77rem;color:rgba(255,255,255,.55)}`;
    const sp = req.query.senha ? `?senha=${encodeURIComponent(req.query.senha)}` : '';
    const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>Painel Admin</title><style>${css}</style></head><body>
    <h1>Painel Administrativo - ConsultaJa24h</h1><p class="sub">Dados em tempo real - PostgreSQL</p>
    <div class="nav"><a href="/relatorio${sp}">Relatorio geral</a><a href="/identificacoes${sp}">Identificacoes</a><a href="/consentimentos${sp}">Consentimentos</a></div>
    <div class="totais"><div class="t-item"><span>Total</span><strong>${total}</strong></div><div class="t-item"><span>Encerrados</span><strong>${encerrados}</strong></div><div class="t-item"><span>Aguardando</span><strong>${aguardando}</strong></div><div class="t-item"><span>Em atendimento</span><strong>${assumidos}</strong></div><div class="t-item"><span>Identificacoes</span><strong>${ident.length}</strong></div><div class="t-item"><span>Consentimentos</span><strong>${cons.length}</strong></div></div>
    <h2>Atendimentos (${total})</h2><table><tr><th>#</th><th>Data/Hora</th><th>Paciente</th><th>CPF</th><th>WhatsApp</th><th>Modalidade</th><th>Medico</th><th>Status</th><th>Triagem</th><th>Documentos</th><th>Encerrado em</th></tr>
    ${atend.map(a=>{
      const d=a.criado_em?new Date(a.criado_em).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}):'--';
      const enc=a.encerrado_em?new Date(a.encerrado_em).toLocaleString('pt-BR',{timeZone:'America/Fortaleza'}):'--';
      const tel=String(a.tel||'').replace(/\D/g,'');
      const tipo=a.tipo==='video'?'<span class="badge video">Video</span>':'<span class="badge chat">Chat</span>';
      const st=`<span class="badge ${a.status}">${a.status}</span>`;
      const triagem=String(a.triagem||'').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return `<tr><td class="dim">${a.id}</td><td class="dim" style="white-space:nowrap">${d}</td><td><strong>${a.nome||'--'}</strong></td><td class="dim">${a.cpf||'--'}</td><td><a href="https://wa.me/55${tel}">${a.tel||'--'}</a></td><td>${tipo}</td><td>${a.medico_nome||'--'}</td><td>${st}</td><td><div class="triagem-cell" title="${triagem}">${triagem||'--'}</div></td><td class="dim">${a.documentos_emitidos||'--'}</td><td class="dim" style="white-space:nowrap">${enc}</td></tr>`;
    }).join('')}
    </table>
    <h2>Identificacoes (${ident.length})</h2><table><tr><th>Data/Hora</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
    ${ident.map(i=>`<tr><td class="dim">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">${i.tel||'--'}</a></td><td class="dim" style="font-size:.73rem">${i.ip||'--'}</td></tr>`).join('')}
    </table>
    <h2>Consentimentos LGPD (${cons.length})</h2><table><tr><th>Data/Hora</th><th>Nome</th><th>WhatsApp</th><th>Versao</th><th>IP</th></tr>
    ${cons.map(i=>`<tr><td class="dim">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'--'}</a></td><td><span class="badge lgpd">${i.versao||'v1.0'}</span></td><td class="dim" style="font-size:.73rem">${i.ip||'--'}</td></tr>`).join('')}
    </table>
    <p class="dim" style="margin-top:32px">Gerado em ${new Date().toLocaleString('pt-BR',{timeZone:'America/Fortaleza'})}</p></body></html>`;
    return res.send(html);
  } catch (e) { console.error("Erro em /relatorio:", e); return res.status(500).send("Erro: " + e.message); }
});

app.get("/identificacoes", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT nome,tel,data,ip FROM identificacoes ORDER BY id DESC");
    const lista=result.rows;
    const sp=req.query.senha?`?senha=${encodeURIComponent(req.query.senha)}`:'';
    if (lista.length===0) return res.send('<h2>Nenhuma identificacao registrada.</h2>');
    res.send(`<html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}h1{color:#b4e05a}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;text-transform:uppercase}td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}a{color:#5ee0a0}.back{display:inline-block;margin-bottom:20px;color:#b4e05a;font-size:.82rem}</style></head><body>
    <a class="back" href="/relatorio${sp}">Voltar ao relatorio</a><h1>Identificacoes</h1><p style="color:rgba(255,255,255,.4)">${lista.length} registros</p>
    <table><tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>IP</th></tr>
    ${lista.map(i=>`<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}" >📱 ${i.tel||'--'}</a></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'--'}</td></tr>`).join('')}
    </table></body></html>`);
  } catch (e) { res.status(500).send("Erro: " + e.message); }
});

app.get("/consentimentos", checkAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT nome,tel,versao,data,ip FROM consentimentos ORDER BY id DESC");
    const lista=result.rows;
    const sp=req.query.senha?`?senha=${encodeURIComponent(req.query.senha)}`:'';
    if (lista.length===0) return res.send('<h2>Nenhum consentimento registrado.</h2>');
    res.send(`<html><head><meta charset="utf-8"><style>body{font-family:'Segoe UI',sans-serif;background:#060d0b;color:#fff;padding:32px;max-width:800px;margin:0 auto}h1{color:#b4e05a}table{width:100%;border-collapse:collapse}th{text-align:left;padding:10px 12px;background:rgba(180,224,90,.1);color:#b4e05a;font-size:.8rem;text-transform:uppercase}td{padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.06);font-size:.88rem}.badge{display:inline-block;padding:3px 10px;border-radius:999px;background:rgba(94,224,160,.1);color:#5ee0a0;font-size:.75rem}a{color:#5ee0a0}.back{display:inline-block;margin-bottom:20px;color:#b4e05a;font-size:.82rem}</style></head><body>
    <a class="back" href="/relatorio${sp}">Voltar ao relatorio</a><h1>Consentimentos LGPD</h1><p style="color:rgba(255,255,255,.4)">${lista.length} aceites</p>
    <table><tr><th>Data</th><th>Nome</th><th>WhatsApp</th><th>Versao</th><th>IP</th></tr>
    ${lista.map(i=>`<tr><td style="color:rgba(255,255,255,.45);font-size:.8rem">${i.data||'--'}</td><td>${i.nome||'--'}</td><td><a href="https://wa.me/55${String(i.tel||'').replace(/\D/g,'')}">📱 ${i.tel||'--'}</a></td><td><span class="badge">${i.versao||'v1.0'}</span></td><td style="color:rgba(255,255,255,.3);font-size:.75rem">${i.ip||'--'}</td></tr>`).join('')}
    </table></body></html>`);
  } catch (e) { res.status(500).send("Erro: " + e.message); }
});

app.get("/api/disponibilidade", async (req, res) => {
  try {
    const agora = new Date();
    const HORA_INICIO=7, HORA_FIM=23;
    const hora = parseInt(new Intl.DateTimeFormat("en-US",{timeZone:"America/Fortaleza",hour:"2-digit",hour12:false}).formatToParts(agora).find(p=>p.type==="hour").value);
    const dentroDoHorario = hora>=HORA_INICIO && hora<HORA_FIM;
    const [medRes,filaRes] = await Promise.all([
      pool.query("SELECT COUNT(*) FROM medicos WHERE status_online=true AND ativo=true"),
      pool.query("SELECT COUNT(*) FROM fila_atendimentos WHERE status='aguardando'")
    ]);
    const medicosOnline=parseInt(medRes.rows[0].count)||0;
    const pacientesAguardando=parseInt(filaRes.rows[0].count)||0;
    const disponivel=dentroDoHorario;
    let tempoEstimado=5;
    if (medicosOnline>0) tempoEstimado=Math.max(3,Math.ceil((pacientesAguardando/medicosOnline)*6));
    else if (dentroDoHorario) tempoEstimado=Math.max(8,pacientesAguardando*6+5);
    let status='verde';
    if (!disponivel) status='vermelho';
    else if (tempoEstimado>12||medicosOnline===0) status='amarelo';
    let horarioRetorno=null;
    let mensagem=disponivel?(medicosOnline>0 ? medicosOnline+' médico(s) disponível(is)':'Atendimento disponivel'):'Atendimento indisponivel no momento';
    const agoraFtz = new Date(agora.getTime() - 3*60*60*1000);
    if (!disponivel) {
      const diaRetorno = new Date(Date.UTC(
        agoraFtz.getUTCFullYear(), agoraFtz.getUTCMonth(),
        hora>=HORA_FIM ? agoraFtz.getUTCDate()+1 : agoraFtz.getUTCDate(),
        HORA_INICIO+3, 0, 0, 0
      ));
      const dataStr=diaRetorno.toLocaleDateString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit"});
      horarioRetorno=HORA_INICIO+"h do dia "+dataStr;
      mensagem='Atendimento disponível das '+HORA_INICIO+'h às '+HORA_FIM+'h';
    }
    // Agendamento removido — fluxo 100% sob demanda imediata
    const horariosAgendamento = [];
    // Aviso de baixa demanda: período noturno 23h–7h
    const avisoHorario = hora >= 23 || hora < 7;
    res.json({ok:true,disponivel,medicosOnline,pacientesAguardando,tempoEstimado,status,mensagem,horarioRetorno,horariosAgendamento,avisoHorario,horaAtual:hora,horaInicio:HORA_INICIO,horaFim:HORA_FIM});
  } catch(e) {
    console.error("Erro em /api/disponibilidade:", e);
    res.json({ok:false,disponivel:true,medicosOnline:0,tempoEstimado:5,status:'verde',mensagem:'Verificando...',horariosAgendamento:[]});
  }
});

app.post("/api/agendamento/criar", async (req, res) => {
  try {
    const { nome,tel,tel_documentos,cpf,modalidade,horario_agendado,email } = req.body||{};
    if (!nome||!tel||!horario_agendado) return res.status(400).json({ok:false,error:"nome, tel e horario_agendado sao obrigatorios"});
    const slotStart=new Date(horario_agendado);
    if (Number.isNaN(slotStart.getTime())) {
      return res.status(400).json({ ok: false, error: "horario_agendado invalido" });
    }
    const slotEnd=new Date(slotStart.getTime()+20*60*1000);

    // Trava de duplicata: mesmo tel + mesmo horário já existe?
    const duplicata=await pool.query(
      `SELECT id FROM agendamentos WHERE tel=$1 AND horario_agendado=$2 AND status IN ('pendente','confirmado') LIMIT 1`,
      [tel, slotStart.toISOString()]
    );
    if (duplicata.rowCount>0) {
      console.log(`[AGENDAMENTO] Duplicata bloqueada — tel:${tel} horario:${slotStart.toISOString()} id existente:#${duplicata.rows[0].id}`);
      return res.json({ok:true, agendamentoId:duplicata.rows[0].id}); // retorna o existente, não cria novo
    }

    const existentes=await pool.query(`SELECT COUNT(*) FROM agendamentos WHERE horario_agendado>=$1 AND horario_agendado<$2 AND status IN ('pendente','confirmado')`,[slotStart.toISOString(),slotEnd.toISOString()]);
    if (parseInt(existentes.rows[0].count)>=3) return res.status(409).json({ok:false,error:"Horario indisponivel. Escolha outro horario."});
    const result=await pool.query(`INSERT INTO agendamentos (nome,tel,tel_documentos,cpf,modalidade,horario_agendado,status,email) VALUES ($1,$2,$3,$4,$5,$6,'pendente',$7) RETURNING id`,[nome,tel,tel_documentos||tel,cpf||"",modalidade||"chat",horario_agendado,email||null]);
    return res.json({ok:true,agendamentoId:result.rows[0].id});
  } catch(e) { console.error("Erro em /api/agendamento/criar:", e); return res.status(500).json({ok:false,error:"Erro ao criar agendamento"}); }
});

app.post("/api/agendamento/confirmar", async (req, res) => {
  try {
    const { agendamentoId, paymentId } = req.body||{};
    if (!agendamentoId) return res.status(400).json({ok:false,error:"agendamentoId e obrigatorio"});
    const result=await pool.query(`UPDATE agendamentos SET status='confirmado',payment_id=$2 WHERE id=$1 AND status='pendente' RETURNING *`,[agendamentoId,paymentId||null]);
    if (result.rowCount===0) return res.status(404).json({ok:false,error:"Agendamento nao encontrado ou ja confirmado"});
    const ag=result.rows[0];
    const horarioFormatado=new Date(ag.horario_agendado).toLocaleString("pt-BR",{timeZone:"America/Fortaleza",day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});
    const tipoLabel=ag.modalidade==="video"?"Video":"Chat";
    // E-mail de confirmação para o paciente
    if (ag.email) {
      const SITE_URL = process.env.SITE_URL || "https://consultaja24h.com.br";
      enviarEmailConfirmacaoPaciente({
        nome: ag.nome, email: ag.email, horarioFormatado, modalidade: ag.modalidade,
        linkConsulta: `${SITE_URL}/triagem.html`
      }).catch(()=>{});
    }
    return res.json({ok:true,agendamento:ag,horarioFormatado});
  } catch(e) { console.error("Erro em /api/agendamento/confirmar:", e); return res.status(500).json({ok:false,error:"Erro ao confirmar agendamento"}); }
});

// FIX PROBLEMA 4: retorna dados completos do atendimento criado
app.post("/api/agendamento/:id/iniciar", async (req, res) => {
  try {
    const auth=req.headers["authorization"]||"";
    let medicoId, medicoNome;
    try { const d=jwt.verify(auth.replace("Bearer ",""),JWT_SECRET); medicoId=d.id; medicoNome=d.nome; }
    catch(e) { return res.status(401).json({ok:false,error:"Token invalido"}); }
    // Lock: tenta marcar como 'iniciado' atomicamente — só funciona se ainda estiver 'confirmado'
    const lock = await pool.query(
      `UPDATE agendamentos SET status='iniciado' WHERE id=$1 AND status='confirmado' RETURNING *`,
      [req.params.id]
    );
    if (lock.rowCount===0) return res.status(409).json({ok:false,error:"Consulta já foi iniciada por outro médico"});
    const ag = { rows: [lock.rows[0]], rowCount: 1 };
    const a=ag.rows[0];
    // Tenta pegar triagem real do paciente
    const preReg=await pool.query(`SELECT triagem FROM fila_atendimentos WHERE tel=$1 AND status IN ('triagem','aguardando') ORDER BY criado_em DESC LIMIT 1`,[a.tel]);
    const triagem=preReg.rowCount>0?(preReg.rows[0].triagem||'(Agendamento)'):'(Agendamento — triagem pendente)';
    const insert=await pool.query(
      `INSERT INTO fila_atendimentos (nome,tel,tel_documentos,cpf,tipo,triagem,status,medico_id,medico_nome,assumido_em)
       VALUES ($1,$2,$3,$4,$5,$6,'assumido',$7,$8,NOW()) RETURNING *`,
      [a.nome,a.tel,a.tel_documentos||a.tel,a.cpf||"",a.modalidade||"chat",triagem,medicoId,medicoNome]
    );
    const atendimento = insert.rows[0];
    // status já atualizado atomicamente no lock acima
    const SITE_URL=process.env.SITE_URL||"https://consultaja24h.com.br";
    return res.json({
      ok:true,
      atendimentoId: atendimento.id,
      atendimento,   // retorna objeto completo para o painel usar direto
      linkRetorno:`${SITE_URL}/triagem.html?consulta=${atendimento.id}`
    });
  } catch(e) { console.error("Erro em /api/agendamento/:id/iniciar:", e); return res.status(500).json({ok:false,error:"Erro ao iniciar consulta"}); }
});

app.post("/api/agendamento/:id/cancelar", checkMedico, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE agendamentos SET status='cancelado' WHERE id=$1 AND status='confirmado' RETURNING id`,
      [req.params.id]
    );
    if (result.rowCount===0) return res.status(404).json({ok:false,error:"Agendamento não encontrado ou já cancelado"});
    return res.json({ok:true});
  } catch(e) { return res.status(500).json({ok:false,error:"Erro ao cancelar agendamento"}); }
});

app.get("/api/agendamentos", checkMedico, async (req, res) => {
  try {
    const result=await pool.query(`SELECT id,nome,tel,tel_documentos,cpf,modalidade,horario_agendado,status,criado_em FROM agendamentos WHERE status IN ('confirmado','pendente') ORDER BY horario_agendado ASC`);
    return res.json({ok:true,agendamentos:result.rows});
  } catch(e) { return res.status(500).json({ok:false,error:"Erro ao listar agendamentos"}); }
});

app.get("/api/test-db", async (req, res) => {
  try { const result=await pool.query("SELECT NOW()"); res.json(result.rows[0]); }
  catch (err) { res.status(500).json({error:err.message}); }
});

// ── EFÍ: certificado + OAuth2 ─────────────────────────────────────────────────
// Pré-requisito no Render: adicionar a env EFI_CERT_BASE64
// Para gerar (Linux/Mac): base64 -w 0 seu-certificado.p12
// macOS alternativo:   openssl base64 -in cert.p12 | tr -d '\n'


// URL base: homologação. Troque EFI_ENV=producao quando for ao ar.
// API de Cobranças Efí — domínio oficial atual (efipay.com.br, não gerencianet)
// Homologação: cobrancas-h.api.efipay.com.br
// Produção:    cobrancas.api.efipay.com.br
const EFI_BASE_URL = process.env.EFI_ENV === "producao"
  ? "https://cobrancas.api.efipay.com.br"
  : "https://cobrancas-h.api.efipay.com.br";

// Cache do caminho do .p12 reconstruído — só grava uma vez por execução
let _efiCertPath = null;
function getEfiCertPath() {
  if (_efiCertPath) return _efiCertPath;
  const b64 = process.env.EFI_CERT_BASE64;
  if (!b64) throw new Error("[EFI] EFI_CERT_BASE64 não definida. Adicione no Render.");
  const buf = Buffer.from(b64, "base64");
  const tmpPath = path.join(os.tmpdir(), `efi_cert_${process.pid}.p12`);
  fs.writeFileSync(tmpPath, buf);
  _efiCertPath = tmpPath;
  console.log("[EFI] Certificado reconstruído em:", tmpPath);
  return tmpPath;
}

// Cache do https.Agent — reutiliza durante toda a vida do processo
let _efiAgent = null;
function getEfiAgent() {
  if (_efiAgent) return _efiAgent;
  _efiAgent = new https.Agent({
    pfx: fs.readFileSync(getEfiCertPath()),
    passphrase: process.env.EFI_CERT_PASS || ""
  });
  return _efiAgent;
}

/**
 * Obtém access_token OAuth2 da Efí.
 * Chame antes de qualquer request autenticado à API Efí.
 */
async function efiGetToken() {
  const clientId     = process.env.EFI_CLIENT_ID;
  const clientSecret = process.env.EFI_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("[EFI] EFI_CLIENT_ID ou EFI_CLIENT_SECRET não definidos");
  }
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    `${EFI_BASE_URL}/v1/authorize`,
    { grant_type: "client_credentials" },
    {
      httpsAgent: getEfiAgent(),
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/json"
      }
    }
  );
  return response.data.access_token; // string JWT
}

// ── EFÍ: rota de teste (admin) ────────────────────────────────────────────────
// GET /api/efi/test?senha=ADMIN_PASSWORD
// Confirma que o certificado e as credenciais estão funcionando.
app.get("/api/efi/test", checkAdmin, async (req, res) => {
  try {
    const token = await efiGetToken();
    console.log("[EFI] Teste OAuth2 OK");
    return res.json({ ok: true, token_preview: token.slice(0, 20) + "..." });
  } catch (e) {
    console.error("[EFI] Teste falhou:", e.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ── EFÍ: cobrança por cartão de crédito ──────────────────────────────────────
// POST /api/efi/cartao/cobrar
//
// FLUXO (2 passos obrigatórios na API Efí):
//   1. POST /v1/charge          → cria a transação, retorna charge_id
//   2. POST /v1/charge/:id/pay  → associa o payment_token + dados do cliente
//
// O payment_token DEVE ser gerado pelo SDK JS da Efí no frontend (nunca envie
// dados brutos do cartão ao backend em produção).
//
// SIMULAÇÃO EM HOMOLOGAÇÃO (por último dígito do número do cartão):
//   final 1 → "Dados do cartão inválidos"
//   final 2 → "Não autorizado por segurança"
//   final 3 → "Tente novamente mais tarde"
//   demais  → aprovado ✓
//
// Payload esperado (JSON):
// {
//   "payment_token": "...",         // obrigatório — SDK Efí no frontend
//   "nome":          "João Silva",  // obrigatório
//   "cpf":           "12345678909", // obrigatório (só números)
//   "email":         "...",         // opcional
//   "telefone":      "62999999999", // opcional (só números, com DDD)
//   "nascimento":    "1990-01-15",  // opcional (YYYY-MM-DD)
//   "parcelas":      1,             // opcional — padrão 1
//   "atendimentoId": 123            // opcional — confirma pagamento na fila
// }
//
// Resposta aprovado:  { ok: true,  charge_id: 123456, status: "paid" }
// Resposta recusado:  { ok: false, error: "Motivo...", status: "unpaid" }

const EFI_VALOR_CENTAVOS = 4990; // R$ 49,90 — fixo no backend, igual ao PagBank

app.post("/api/efi/cartao/cobrar", rlGeral, async (req, res) => {
  try {
    const {
      payment_token,
      nome,
      cpf,
      email,
      telefone,
      nascimento,
      parcelas = 1,
      atendimentoId
    } = req.body || {};

    // ── Validação ────────────────────────────────────────────────────────────
    if (!payment_token)
      return res.status(400).json({ ok: false, error: "payment_token obrigatório (gerado pelo SDK Efí no frontend)" });
    if (!nome)
      return res.status(400).json({ ok: false, error: "nome obrigatório" });
    if (!cpf)
      return res.status(400).json({ ok: false, error: "cpf obrigatório" });

    const cpfLimpo = String(cpf).replace(/\D/g, "");
    if (cpfLimpo.length !== 11)
      return res.status(400).json({ ok: false, error: "CPF inválido (precisa ter 11 dígitos)" });

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim()))
      return res.status(400).json({ ok: false, error: "Informe um e-mail válido para pagamento no cartão" });

    const telefoneLimpoEfi = String(telefone || "").replace(/\D/g, "");
    if (telefoneLimpoEfi.length < 10 || telefoneLimpoEfi.length > 11)
      return res.status(400).json({ ok: false, error: "Telefone com DDD obrigatório para pagamento no cartão" });

    // ── Auth Efí ─────────────────────────────────────────────────────────────
    const efiToken  = await efiGetToken();
    const headers   = { Authorization: `Bearer ${efiToken}`, "Content-Type": "application/json" };
    const httpsAgent = getEfiAgent();

    // ── PASSO 1: Criar a transação ────────────────────────────────────────────
    // Endpoint: POST /v1/charge
    // Retorna charge_id que será usado no passo 2
    const chargePayload = {
      items: [{
        name:   "Consulta Médica Online — ConsultaJá24h",
        value:  EFI_VALOR_CENTAVOS,
        amount: 1
      }],
      metadata: {
        custom_id:        `CJ-CARTAO-${Date.now()}`,
        notification_url: `${process.env.API_URL || "https://triagem-api.onrender.com"}/api/efi/cartao/webhook`
      }
    };

    const chargeRes = await axios.post(
      `${EFI_BASE_URL}/v1/charge`,
      chargePayload,
      { httpsAgent, headers }
    );

    const chargeId = chargeRes.data?.data?.charge_id;
    if (!chargeId) {
      console.error("[EFI-CARTAO] Passo 1 falhou — sem charge_id:", JSON.stringify(chargeRes.data));
      return res.status(502).json({ ok: false, error: "Efí não retornou charge_id" });
    }
    console.log(`[EFI-CARTAO] Passo 1 OK — charge_id: ${chargeId}`);

    // ── PASSO 2: Associar o payment_token ao charge_id ────────────────────────
    // Endpoint: POST /v1/charge/:id/pay
    const customer = {
      name:         nome.trim(),
      cpf:          cpfLimpo,
      email:        String(email).trim(),
      phone_number: telefoneLimpoEfi
    };
    if (nascimento) customer.birth = nascimento; // "YYYY-MM-DD"

    const payPayload = {
      payment: {
        credit_card: {
          customer,
          installments:  Math.max(1, parseInt(parcelas) || 1),
          payment_token: payment_token.trim(),
          billing_address: {
            // Endereço de cobrança — mínimo exigido pela Efí
            // Em produção, colete do paciente; em homologação qualquer valor serve
            street:       "Rua da Consulta",
            number:       "1",
            neighborhood: "Centro",
            zipcode:      "65000000",
            city:         "São Luís",
            complement:   "",
            state:        "MA"
          }
        }
      }
    };

    const payRes = await axios.post(
      `${EFI_BASE_URL}/v1/charge/${chargeId}/pay`,
      payPayload,
      { httpsAgent, headers }
    );

    const status    = payRes.data?.data?.status;      // "paid", "unpaid", "waiting"
    const reason    = payRes.data?.data?.reason || ""; // motivo de recusa
    const chargeData = payRes.data?.data || {};

    console.log(`[EFI-CARTAO] Passo 2 — charge_id: ${chargeId} status: ${status} reason: ${reason}`);

    // ── Pagamento aprovado imediatamente (raro) OU aguardando análise (esperado) ──
    // A doc Efí mostra que /pay responde "waiting" na maioria dos casos aprovados.
    // "paid" pode ocorrer em sandbox ou pagamentos pré-aprovados.
    // Em ambos os casos: salva o charge_id e retorna ok:true ao frontend.
    // A confirmação final (pagamento_status='confirmado') sempre vem via webhook.
    if (status === "paid" || status === "waiting" || status === "approved") {
      // Sempre salva o efi_charge_id para o webhook conseguir achar o atendimento depois
      if (atendimentoId) {
        await pool.query(
          `UPDATE fila_atendimentos SET efi_charge_id = $2
            WHERE id = $1 AND (efi_charge_id IS NULL OR efi_charge_id = '')`,
          [atendimentoId, String(chargeId)]
        ).catch(e => console.warn("[EFI-CARTAO] Salvar charge_id falhou:", e.message));
      }

      // Se já veio "paid" (ex: sandbox), confirma na hora igual ao webhook faria
      if ((status === "paid" || status === "approved") && atendimentoId) {
        const { rows: atRows } = await pool.query(
          `UPDATE fila_atendimentos
              SET pagamento_status        = 'confirmado',
                  pagamento_confirmado_em = NOW(),
                  status = CASE
                    WHEN status = 'pagamento_pendente' THEN 'triagem'
                    WHEN status = 'triagem' THEN
                      CASE
                        WHEN LOWER(TRIM(triagem)) NOT IN (
                          '(aguardando pagamento)',
                          '(pagamento confirmado — aguardando triagem)',
                          '(triagem em andamento)',
                          '(aguardando triagem de agendamento)',
                          '(aguardando resposta)'
                        ) THEN 'aguardando'
                        ELSE 'triagem'
                      END
                    ELSE status
                  END
            WHERE id = $1
              AND pagamento_status = 'pendente'
            RETURNING id, nome, tel, cpf, tipo, triagem, status`,
          [atendimentoId]
        ).catch(e => { console.warn("[EFI-CARTAO] Update fila falhou:", e.message); return { rows: [] }; });

        const at = atRows[0];
        if (at) {
          console.log(`[EFI-CARTAO] Atendimento #${at.id} — paid síncrono, status: ${at.status}`);
          if (at.status === "aguardando" && !isTriagemPlaceholder(at.triagem)) {
            await notificarMedicos(at);
          }
        }
      }

      console.log(`[EFI-CARTAO] charge_id ${chargeId} — status: ${status} — aguardando webhook para confirmação final`);
      return res.json({
        ok:        true,
        charge_id: chargeId,
        status     // "paid" ou "waiting" — frontend trata os dois como sucesso
      });
    }

    // ── Pagamento recusado ────────────────────────────────────────────────────
    return res.status(402).json({
      ok:        false,
      charge_id: chargeId,
      status:    status || "unpaid",
      error:     reason || "Pagamento não aprovado. Verifique os dados do cartão."
    });

  } catch (e) {
    const efiError = e.response?.data;
    console.error("[EFI-CARTAO] Erro:", efiError || e.message);

    // Erros conhecidos da Efí com mensagem legível
    const msg = efiError?.error_description
      || efiError?.message
      || efiError?.error
      || e.message
      || "Erro ao processar pagamento com cartão";

    return res.status(500).json({ ok: false, error: msg });
  }
});

// ── EFÍ: webhook de cartão ────────────────────────────────────────────────────
// POST /api/efi/cartao/webhook
// Efí notifica aqui quando o status de uma cobrança muda (paid, unpaid, etc.)
// Idempotente: só processa se pagamento_status ainda for 'pendente'
app.post("/api/efi/cartao/webhook", async (req, res) => {
  // Responde 200 imediatamente — Efí não aguarda processamento
  res.sendStatus(200);

  try {
    const evento = req.body;
    if (!evento || typeof evento !== "object") return;

    // Estrutura do webhook Efí Cobranças: { "notification": "<token>" }
    // Para obter o status real: GET /v1/notification/:token
    const notificationToken = evento?.notification;
    if (!notificationToken) {
      console.log("[EFI-WEBHOOK] Evento sem notification token — ignorando");
      return;
    }

    console.log("[EFI-WEBHOOK] Token recebido:", notificationToken);

    const efiToken = await efiGetToken();
    const notifRes = await axios.get(
      `${EFI_BASE_URL}/v1/notification/${notificationToken}`,
      {
        httpsAgent: getEfiAgent(),
        headers: { Authorization: `Bearer ${efiToken}`, "Content-Type": "application/json" }
      }
    );

    const charges = notifRes.data?.data || [];
    console.log("[EFI-WEBHOOK] Cobranças notificadas:", charges.length);

    for (const charge of charges) {
      const chargeId = String(charge.charge_id || charge.id || "");
      const status   = charge.status;

      console.log(`[EFI-WEBHOOK] charge_id: ${chargeId} status: ${status}`);

      if (status !== "paid" || !chargeId) continue;

      // Busca o atendimento vinculado a este charge_id — idempotente
      const { rows: atRows } = await pool.query(
        `UPDATE fila_atendimentos
            SET pagamento_status        = 'confirmado',
                pagamento_confirmado_em = NOW(),
                status = CASE
                  WHEN status = 'pagamento_pendente' THEN 'triagem'
                  WHEN status = 'triagem' THEN
                    CASE
                      WHEN LOWER(TRIM(triagem)) NOT IN (
                        '(aguardando pagamento)',
                        '(pagamento confirmado — aguardando triagem)',
                        '(triagem em andamento)',
                        '(aguardando triagem de agendamento)',
                        '(aguardando resposta)'
                      ) THEN 'aguardando'
                      ELSE 'triagem'
                    END
                  ELSE status
                END
          WHERE efi_charge_id = $1
            AND pagamento_status = 'pendente'
          RETURNING id, nome, tel, cpf, tipo, triagem, status`,
        [chargeId]
      );

      if (atRows.length === 0) {
        console.log(`[EFI-WEBHOOK] charge_id ${chargeId} — atendimento não encontrado ou já processado`);
        continue;
      }

      const at = atRows[0];
      console.log(`[EFI-WEBHOOK] Atendimento #${at.id} confirmado via webhook — status: ${at.status}`);

      // Notifica médicos se triagem real já estava preenchida
      if (at.status === "aguardando" && !isTriagemPlaceholder(at.triagem)) {
        await notificarMedicos(at);
      }
    }

  } catch (e) {
    console.error("[EFI-WEBHOOK] Erro:", e.response?.data || e.message);
  }
});
// ── FIM EFÍ ───────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════════
// CONTROLE FINANCEIRO DE SESSÕES DE PSICOLOGIA
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/psicologia/:id/realizar  — admin ou psicólogo dono da sessão
app.post('/api/psicologia/:id/realizar', async (req, res) => {
  // Aceita checkAdmin (header x-admin-password) OU authPsicologo (Bearer token)
  const senhaAdmin = process.env.ADMIN_PASSWORD;
  const headerAdmin = req.headers['x-admin-password'] || req.query.senha;
  let autorizadoPor = null;

  if (senhaAdmin && headerAdmin === senhaAdmin) {
    autorizadoPor = 'admin';
  } else {
    const auth = req.headers['authorization'] || '';
    const tok  = auth.replace(/^Bearer\s+/i, '').trim();
    if (tok) {
      try {
        const dec = jwt.verify(tok, JWT_SECRET);
        if (dec.tipo === 'psicologo') autorizadoPor = 'psicologo:' + dec.id;
      } catch(_) {}
    }
  }
  if (!autorizadoPor) return res.status(403).json({ ok: false, error: 'Acesso negado' });

  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });

  try {
    // Se for psicólogo, garante que a sessão é dele
    let whereExtra = '';
    const params = [id];
    if (autorizadoPor.startsWith('psicologo:')) {
      whereExtra = ' AND psicologo_id = $2';
      params.push(parseInt(autorizadoPor.split(':')[1], 10));
    }

    const { rows } = await pool.query(
      `UPDATE agendamentos_psicologia
          SET status_sessao = 'realizado', realizado_em = NOW()
        WHERE id = $1${whereExtra}
          AND status_sessao IN ('pago','agendado')
          AND pagamento_status = 'confirmado'
        RETURNING id, paciente_nome, psicologo_nome, status_sessao`,
      params
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Agendamento não encontrado, já marcado ou pagamento não confirmado' });
    console.log(`[PSI-REALIZAR] #${rows[0].id} marcado como realizado por ${autorizadoPor}`);
    return res.json({ ok: true, agendamento: rows[0] });
  } catch (e) {
    console.error('[PSI-REALIZAR] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/psicologia/:id/faltou  — admin
app.post('/api/psicologia/:id/faltou', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE agendamentos_psicologia SET status_sessao = 'faltou'
        WHERE id = $1 AND status_sessao IN ('pago','agendado')
        RETURNING id`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Não encontrado ou status incompatível' });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/psicologia/:id/pagar  — admin only
// Marca repasse como pago. Só funciona se status_sessao = 'realizado'.
app.post('/api/psicologia/:id/pagar', checkAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
  try {
    const { rows } = await pool.query(
      `UPDATE agendamentos_psicologia
          SET pago_psicologo = true, data_pagamento_psicologo = NOW()
        WHERE id = $1
          AND status_sessao = 'realizado'
          AND pago_psicologo = false
        RETURNING id, paciente_nome, psicologo_nome, valor_repasse`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ ok: false, error: 'Não encontrado, sessão não realizada ou já pago' });
    console.log(`[PSI-PAGAR] #${rows[0].id} marcado como pago — repasse R$ ${rows[0].valor_repasse}`);
    return res.json({ ok: true, agendamento: rows[0] });
  } catch (e) {
    console.error('[PSI-PAGAR] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/psicologia/financeiro  — listagem para o painel admin
// Filtros: ?psicologo_id=&mes=2025-03&status_sessao=
app.get('/api/admin/psicologia/financeiro', checkAdmin, async (req, res) => {
  try {
    const { psicologo_id, mes, status_sessao } = req.query;
    const conds = ['1=1'];
    const params = [];

    if (psicologo_id) { params.push(parseInt(psicologo_id, 10)); conds.push(`ap.psicologo_id = $${params.length}`); }
    if (mes) {
      // mes = "2025-03"
      params.push(mes + '-01');
      conds.push(`DATE_TRUNC('month', ap.horario_agendado) = DATE_TRUNC('month', $${params.length}::date)`);
    }
    if (status_sessao) { params.push(status_sessao); conds.push(`ap.status_sessao = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT ap.id,
              ap.psicologo_id,
              ap.psicologo_nome,
              ap.paciente_nome,
              ap.paciente_email,
              ap.tipo_consulta,
              ap.horario_agendado,
              ap.valor_cobrado,
              ap.valor_repasse,
              ap.status_sessao,
              ap.pagamento_status,
              ap.pago_psicologo,
              ap.data_pagamento_psicologo,
              ap.realizado_em
         FROM agendamentos_psicologia ap
        WHERE ${conds.join(' AND ')}
        ORDER BY ap.horario_agendado DESC
        LIMIT 500`,
      params
    );
    return res.json({ ok: true, sessoes: rows, comissao_pct: PSI_COMISSAO_PCT });
  } catch (e) {
    console.error('[PSI-FIN] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/psicologia/resumo  — totais por psicólogo
app.get('/api/admin/psicologia/resumo', checkAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ap.psicologo_id,
              ap.psicologo_nome,
              COUNT(*) FILTER (WHERE ap.status_sessao = 'realizado')                          AS total_realizadas,
              COUNT(*) FILTER (WHERE ap.status_sessao = 'realizado' AND ap.pago_psicologo = false) AS total_pendente_pagamento,
              COUNT(*) FILTER (WHERE ap.pago_psicologo = true)                                AS total_pagas,
              COALESCE(SUM(ap.valor_repasse) FILTER (WHERE ap.status_sessao = 'realizado'), 0) AS valor_total_repasse,
              COALESCE(SUM(ap.valor_repasse) FILTER (WHERE ap.status_sessao = 'realizado' AND ap.pago_psicologo = false), 0) AS valor_pendente,
              COALESCE(SUM(ap.valor_repasse) FILTER (WHERE ap.pago_psicologo = true), 0)       AS valor_pago
         FROM agendamentos_psicologia ap
        GROUP BY ap.psicologo_id, ap.psicologo_nome
        ORDER BY ap.psicologo_nome`
    );
    return res.json({ ok: true, resumo: rows, comissao_pct: PSI_COMISSAO_PCT });
  } catch (e) {
    console.error('[PSI-RESUMO] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/psicologia/psicologos-lista  — para popular filtro no painel
app.get('/api/admin/psicologia/psicologos-lista', checkAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, nome_exibicao AS nome FROM psicologos WHERE ativo = true ORDER BY nome_exibicao`
    );
    return res.json({ ok: true, psicologos: rows });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

// GET /admin/psicologia  — painel financeiro (autenticação feita no próprio HTML via x-admin-password)
app.get('/admin/psicologia', (req, res) => {
  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Financeiro Psicologia · Admin · ConsultaJá24h</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@300;400;500;600&family=IBM+Plex+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0f1117;--surface:#181c25;--surface2:#1e2330;--border:rgba(255,255,255,.07);
  --text:#e8eaf0;--text2:#8b8fa8;--text3:#555a70;
  --blue:#4e7cf6;--blue-dim:rgba(78,124,246,.15);
  --green:#34d399;--green-dim:rgba(52,211,153,.12);
  --yellow:#fbbf24;--yellow-dim:rgba(251,191,36,.12);
  --red:#f87171;--red-dim:rgba(248,113,113,.12);
  --purple:#a78bfa;--purple-dim:rgba(167,139,250,.12);
  --radius:10px;
}

body{background:var(--bg);color:var(--text);font-family:'IBM Plex Sans',sans-serif;font-size:14px;min-height:100vh;line-height:1.5}
nav{background:var(--surface);border-bottom:1px solid var(--border);padding:0 28px;height:52px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:100}
.nav-brand{font-family:'IBM Plex Mono',monospace;font-size:.8rem;font-weight:600;color:var(--blue);letter-spacing:.08em;text-transform:uppercase}
.nav-sep{color:var(--border);font-size:1.2rem}
.nav-title{font-size:.82rem;color:var(--text2)}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:10px}
.badge-admin{background:var(--blue-dim);color:var(--blue);font-size:.68rem;font-weight:600;padding:3px 9px;border-radius:999px;letter-spacing:.05em;text-transform:uppercase;border:1px solid rgba(78,124,246,.25)}
#login-overlay{position:fixed;inset:0;background:var(--bg);z-index:999;display:flex;align-items:center;justify-content:center}
.login-box{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:40px 36px;width:340px}
.login-box h2{font-family:'IBM Plex Mono',monospace;font-size:1rem;color:var(--blue);margin-bottom:6px}
.login-box p{font-size:.82rem;color:var(--text2);margin-bottom:24px}
.login-box input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;color:var(--text);font-family:inherit;font-size:.88rem;outline:none;transition:border .2s}
.login-box input:focus{border-color:var(--blue)}
.login-box button{margin-top:14px;width:100%;background:var(--blue);color:#fff;border:none;border-radius:8px;padding:11px;font-family:inherit;font-size:.88rem;font-weight:600;cursor:pointer;transition:opacity .2s}
.login-box button:hover{opacity:.85}
.login-err{margin-top:10px;font-size:.78rem;color:var(--red);display:none}
main{max-width:1280px;margin:0 auto;padding:28px 24px}
.page-header{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:24px;gap:16px;flex-wrap:wrap}
.page-header h1{font-family:'IBM Plex Mono',monospace;font-size:1rem;font-weight:600;letter-spacing:.04em}
.page-header p{font-size:.78rem;color:var(--text2);margin-top:3px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:28px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px}
.kpi-label{font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);margin-bottom:6px}
.kpi-val{font-family:'IBM Plex Mono',monospace;font-size:1.3rem;font-weight:500}
.kpi-val.green{color:var(--green)}.kpi-val.yellow{color:var(--yellow)}.kpi-val.blue{color:var(--blue)}
.filters{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px;align-items:flex-end}
.f-group{display:flex;flex-direction:column;gap:5px}
.f-group label{font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--text3)}
.f-group select,.f-group input{background:var(--bg);border:1px solid var(--border);border-radius:7px;padding:7px 11px;color:var(--text);font-family:inherit;font-size:.82rem;outline:none;min-width:150px;transition:border .2s}
.f-group select:focus,.f-group input:focus{border-color:var(--blue)}
.btn{padding:8px 18px;border-radius:7px;border:none;font-family:inherit;font-size:.82rem;font-weight:600;cursor:pointer;transition:opacity .2s}
.btn:hover{opacity:.82}
.btn-primary{background:var(--blue);color:#fff}
.btn-ghost{background:var(--surface2);color:var(--text2);border:1px solid var(--border)}
.tabs{display:flex;gap:2px;margin-bottom:20px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:4px;width:fit-content}
.tab{padding:7px 18px;border-radius:7px;font-size:.8rem;font-weight:500;cursor:pointer;color:var(--text2);border:none;background:none;font-family:inherit;transition:all .2s}
.tab.active{background:var(--blue);color:#fff}
.table-wrap{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:auto}
table{width:100%;border-collapse:collapse;font-size:.8rem}
thead th{padding:10px 14px;text-align:left;font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text3);border-bottom:1px solid var(--border);white-space:nowrap;position:sticky;top:0;background:var(--surface)}
tbody tr{border-bottom:1px solid var(--border);transition:background .15s}
tbody tr:last-child{border-bottom:none}
tbody tr:hover{background:rgba(255,255,255,.025)}
td{padding:10px 14px;vertical-align:middle;white-space:nowrap}
.td-wrap{white-space:normal;min-width:120px;max-width:200px}
.chip{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.04em;border:1px solid transparent}
.chip-agendado{background:var(--purple-dim);color:var(--purple);border-color:rgba(167,139,250,.2)}
.chip-pago{background:var(--blue-dim);color:var(--blue);border-color:rgba(78,124,246,.2)}
.chip-realizado{background:var(--green-dim);color:var(--green);border-color:rgba(52,211,153,.2)}
.chip-cancelado{background:var(--red-dim);color:var(--red);border-color:rgba(248,113,113,.2)}
.chip-faltou{background:var(--yellow-dim);color:var(--yellow);border-color:rgba(251,191,36,.2)}
.chip-pago-sim{background:var(--green-dim);color:var(--green);border-color:rgba(52,211,153,.2)}
.chip-pago-nao{background:rgba(255,255,255,.04);color:var(--text3);border-color:var(--border)}
.btn-sm{padding:4px 11px;border-radius:6px;font-size:.7rem;font-weight:600;border:none;cursor:pointer;font-family:inherit;transition:opacity .2s;white-space:nowrap}
.btn-sm:hover{opacity:.78}
.btn-sm:disabled{opacity:.3;cursor:not-allowed}
.btn-realizar{background:var(--green-dim);color:var(--green);border:1px solid rgba(52,211,153,.25)}
.btn-pagar{background:var(--blue-dim);color:var(--blue);border:1px solid rgba(78,124,246,.25)}
.btn-faltou{background:var(--yellow-dim);color:var(--yellow);border:1px solid rgba(251,191,36,.25)}
.resumo-grid{display:grid;gap:10px}
.res-row{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:12px;align-items:center}
.res-nome{font-weight:500;font-size:.88rem}
.res-num{font-family:'IBM Plex Mono',monospace;font-size:.85rem;text-align:right}
.res-header{background:transparent;border:none;padding:4px 18px}
.res-header .res-nome,.res-header .res-num{font-size:.65rem;font-weight:600;text-transform:uppercase;letter-spacing:.1em;color:var(--text3)}
.toast{position:fixed;bottom:24px;right:24px;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:12px 18px;font-size:.82rem;color:var(--text);box-shadow:0 8px 32px rgba(0,0,0,.4);z-index:9999;transform:translateY(80px);opacity:0;transition:all .3s;pointer-events:none}
.toast.show{transform:translateY(0);opacity:1}
.toast.ok{border-color:rgba(52,211,153,.3);color:var(--green)}
.toast.err{border-color:rgba(248,113,113,.3);color:var(--red)}
.empty{padding:48px 24px;text-align:center;color:var(--text3);font-size:.82rem}
.loading{padding:48px 24px;text-align:center;color:var(--text3);font-size:.78rem;font-family:'IBM Plex Mono',monospace}
@media(max-width:700px){.kpi-grid{grid-template-columns:1fr 1fr}.res-row{grid-template-columns:1fr 1fr;gap:8px}.filters{gap:8px}main{padding:16px 12px}}
</style>
</head>
<body>
<div id="login-overlay">
  <div class="login-box">
    <h2>ADMIN</h2>
    <p>Painel financeiro de psicologia · ConsultaJá24h</p>
    <input id="inp-senha" type="password" placeholder="Senha de administrador" onkeydown="if(event.key==='Enter')autenticar()"/>
    <button onclick="autenticar()">Entrar</button>
    <div class="login-err" id="login-err">Senha incorreta.</div>
  </div>
</div>
<nav>
  <span class="nav-brand">ConsultaJá24h</span>
  <span class="nav-sep">/</span>
  <span class="nav-title">Financeiro Psicologia</span>
  <div class="nav-right">
    <span class="badge-admin">Admin</span>
    <button class="btn btn-ghost" style="font-size:.72rem;padding:5px 12px" onclick="sair()">Sair</button>
  </div>
</nav>
<main>
  <div class="page-header">
    <div><h1>Controle Financeiro — Psicologia</h1><p id="comissao-label">Comissão: carregando…</p></div>
    <button class="btn btn-ghost" onclick="recarregar()" style="font-size:.78rem">↻ Atualizar</button>
  </div>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">Sessões realizadas</div><div class="kpi-val" id="k-realizadas">—</div></div>
    <div class="kpi"><div class="kpi-label">A pagar (pendente)</div><div class="kpi-val yellow" id="k-pendente">—</div></div>
    <div class="kpi"><div class="kpi-label">Total pago</div><div class="kpi-val green" id="k-pago">—</div></div>
    <div class="kpi"><div class="kpi-label">Comissão acumulada</div><div class="kpi-val blue" id="k-comissao">—</div></div>
  </div>
  <div class="tabs">
    <button class="tab active" onclick="mudarAba('sessoes',this)">Sessões</button>
    <button class="tab" onclick="mudarAba('resumo',this)">Resumo por Psicólogo</button>
    <button class="tab" onclick="mudarAba('cadastros',this)">Cadastros</button>
  </div>
  <div id="aba-sessoes">
    <div class="filters">
      <div class="f-group"><label>Psicólogo</label><select id="f-psicologo"><option value="">Todos</option></select></div>
      <div class="f-group"><label>Mês</label><input type="month" id="f-mes"/></div>
      <div class="f-group"><label>Status sessão</label>
        <select id="f-status">
          <option value="">Todos</option>
          <option value="agendado">Agendado</option>
          <option value="pago">Pago (aguardando sessão)</option>
          <option value="realizado">Realizado</option>
          <option value="faltou">Faltou</option>
          <option value="cancelado">Cancelado</option>
        </select>
      </div>
      <button class="btn btn-primary" onclick="buscarSessoes()">Filtrar</button>
      <button class="btn btn-ghost" onclick="limparFiltros()">Limpar</button>
    </div>
    <div class="table-wrap" id="tabela-wrap"><div class="loading">Carregando</div></div>
  </div>
  <div id="aba-resumo" style="display:none">
    <div id="resumo-wrap" class="resumo-grid"><div class="loading">Carregando</div></div>
  </div>
  <div id="aba-cadastros" style="display:none">
    <div style="overflow-x:auto">
      <table id="tbl-cadastros" style="width:100%;border-collapse:collapse;font-size:.85rem">
        <thead><tr style="background:#f0f4ff">
          <th style="padding:8px 10px;text-align:left">#</th>
          <th style="padding:8px 10px;text-align:left">Nome</th>
          <th style="padding:8px 10px;text-align:left">E-mail</th>
          <th style="padding:8px 10px;text-align:left">CRP</th>
          <th style="padding:8px 10px;text-align:left">Status</th>
          <th style="padding:8px 10px;text-align:left">Visível</th>
          <th style="padding:8px 10px;text-align:left">Ações</th>
        </tr></thead>
        <tbody id="cadastros-body"><tr><td colspan="7" style="padding:16px;text-align:center">Carregando…</td></tr></tbody>
      </table>
    </div>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
const API='https://triagem-api.onrender.com';
let SENHA='',COMISSAO_PCT=20;
function autenticar(){
  const s=document.getElementById('inp-senha').value.trim();
  if(!s)return;SENHA=s;
  fetch(API+'/api/admin/psicologia/resumo',{headers:{'x-admin-password':SENHA}})
    .then(r=>{
      if(r.status===403){document.getElementById('login-err').style.display='block';SENHA='';return;}
      sessionStorage.setItem('adm_pw',SENHA);
      document.getElementById('login-overlay').style.display='none';
      iniciar();
    }).catch(()=>{document.getElementById('login-err').style.display='block';SENHA='';});
}
function sair(){sessionStorage.removeItem('adm_pw');location.reload();}
function hdr(){return{'Content-Type':'application/json','x-admin-password':SENHA};}
function iniciar(){
  document.getElementById('f-mes').value=new Date().toISOString().slice(0,7);
  carregarPsicologos();buscarSessoes();buscarResumo();
}
async function carregarPsicologos(){
  try{const r=await fetch(API+'/api/admin/psicologia/psicologos-lista',{headers:hdr()});
  const d=await r.json();if(!d.ok)return;
  const sel=document.getElementById('f-psicologo');
  d.psicologos.forEach(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.nome;sel.appendChild(o);});}
  catch(_){}
}
function recarregar(){buscarSessoes();buscarResumo();}
async function buscarSessoes(){
  document.getElementById('tabela-wrap').innerHTML='<div class="loading">Carregando</div>';
  const psi=document.getElementById('f-psicologo').value;
  const mes=document.getElementById('f-mes').value;
  const st=document.getElementById('f-status').value;
  let url=API+'/api/admin/psicologia/financeiro?';
  if(psi)url+='psicologo_id='+psi+'&';
  if(mes)url+='mes='+mes+'&';
  if(st)url+='status_sessao='+st+'&';
  try{
    const r=await fetch(url,{headers:hdr()});const d=await r.json();
    if(!d.ok)throw new Error(d.error);
    COMISSAO_PCT=d.comissao_pct||20;
    document.getElementById('comissao-label').textContent='Comissão da plataforma: '+COMISSAO_PCT+'% (var PSI_COMISSAO_PCT)';
    renderTabela(d.sessoes||[]);atualizarKPIs(d.sessoes||[]);
  }catch(e){document.getElementById('tabela-wrap').innerHTML='<div class="empty">Erro: '+e.message+'</div>';}
}
function limparFiltros(){
  document.getElementById('f-psicologo').value='';
  document.getElementById('f-mes').value=new Date().toISOString().slice(0,7);
  document.getElementById('f-status').value='';buscarSessoes();
}
function atualizarKPIs(rows){
  const realizadas=rows.filter(r=>r.status_sessao==='realizado').length;
  const pendente=rows.filter(r=>r.status_sessao==='realizado'&&!r.pago_psicologo).reduce((s,r)=>s+parseFloat(r.valor_repasse||0),0);
  const pago=rows.filter(r=>r.pago_psicologo).reduce((s,r)=>s+parseFloat(r.valor_repasse||0),0);
  const cobradoReal=rows.filter(r=>r.status_sessao==='realizado').reduce((s,r)=>s+parseFloat(r.valor_cobrado||0),0);
  const repasseReal=rows.filter(r=>r.status_sessao==='realizado').reduce((s,r)=>s+parseFloat(r.valor_repasse||0),0);
  document.getElementById('k-realizadas').textContent=realizadas;
  document.getElementById('k-pendente').textContent=fmtR(pendente);
  document.getElementById('k-pago').textContent=fmtR(pago);
  document.getElementById('k-comissao').textContent=fmtR(cobradoReal-repasseReal);
}
function renderTabela(rows){
  if(!rows.length){document.getElementById('tabela-wrap').innerHTML='<div class="empty">Nenhuma sessão encontrada.</div>';return;}
  let html='<table><thead><tr><th>#</th><th>Psicólogo</th><th>Paciente</th><th>Tipo</th><th>Data/Hora</th><th>Status Sessão</th><th>Valor Consulta</th><th>Valor Repasse</th><th>Pago Psicólogo</th><th>Ações</th></tr></thead><tbody>';
  rows.forEach(s=>{
    const stChip=chipStatus(s.status_sessao);
    const pagoChip=s.pago_psicologo?'<span class="chip chip-pago-sim">✓ Sim</span>':'<span class="chip chip-pago-nao">Não</span>';
    const repasse=s.valor_repasse?fmtR(s.valor_repasse):'<span style="color:var(--text3)">—</span>';
    const tipo=s.tipo_consulta==='avaliacao'?'Avaliação':'Psicoterapia';
    let acoes='';
    if(s.status_sessao==='pago'||s.status_sessao==='agendado'){
      acoes='<button class="btn-sm btn-realizar" onclick="realizar('+s.id+',this)">✓ Realizado</button> <button class="btn-sm btn-faltou" onclick="faltou('+s.id+',this)">✗ Faltou</button>';
    }else if(s.status_sessao==='realizado'&&!s.pago_psicologo){
      acoes='<button class="btn-sm btn-pagar" onclick="pagar('+s.id+',this)">$ Pagar</button>';
    }else{acoes='<span style="color:var(--text3);font-size:.7rem">—</span>';}
    const dataPago=s.data_pagamento_psicologo?'<br><span style="color:var(--text3);font-size:.68rem">'+fmtD(s.data_pagamento_psicologo)+'</span>':'';
    html+='<tr><td style="color:var(--text3);font-family:monospace">#'+s.id+'</td><td class="td-wrap">'+esc(s.psicologo_nome)+'</td><td class="td-wrap">'+esc(s.paciente_nome)+'<br><span style="color:var(--text3);font-size:.7rem">'+esc(s.paciente_email)+'</span></td><td>'+tipo+'</td><td style="font-family:monospace;font-size:.75rem">'+fmtD(s.horario_agendado)+'</td><td>'+stChip+'</td><td style="font-family:monospace">'+fmtR(s.valor_cobrado)+'</td><td style="font-family:monospace">'+repasse+'</td><td>'+pagoChip+dataPago+'</td><td>'+acoes+'</td></tr>';
  });
  html+='</tbody></table>';
  document.getElementById('tabela-wrap').innerHTML=html;
}
async function buscarResumo(){
  document.getElementById('resumo-wrap').innerHTML='<div class="loading">Carregando</div>';
  try{
    const r=await fetch(API+'/api/admin/psicologia/resumo',{headers:hdr()});
    const d=await r.json();if(!d.ok)throw new Error(d.error);
    renderResumo(d.resumo||[]);
  }catch(e){document.getElementById('resumo-wrap').innerHTML='<div class="empty">Erro: '+e.message+'</div>';}
}
function renderResumo(rows){
  if(!rows.length){document.getElementById('resumo-wrap').innerHTML='<div class="empty">Nenhum dado ainda.</div>';return;}
  let html='<div class="res-row res-header"><div class="res-nome">Psicólogo</div><div class="res-num">Realizadas</div><div class="res-num">Total Repasse</div><div class="res-num" style="color:var(--yellow)">Pendente</div><div class="res-num" style="color:var(--green)">Pago</div></div>';
  rows.forEach(r=>{
    html+='<div class="res-row"><div class="res-nome">'+esc(r.psicologo_nome)+'</div><div class="res-num">'+r.total_realizadas+'</div><div class="res-num">'+fmtR(r.valor_total_repasse)+'</div><div class="res-num" style="color:var(--yellow)">'+fmtR(r.valor_pendente)+'</div><div class="res-num" style="color:var(--green)">'+fmtR(r.valor_pago)+'</div></div>';
  });
  document.getElementById('resumo-wrap').innerHTML=html;
}
async function realizar(id,btn){
  btn.disabled=true;btn.textContent='…';
  try{const r=await fetch(API+'/api/psicologia/'+id+'/realizar',{method:'POST',headers:hdr()});
  const d=await r.json();if(!d.ok)throw new Error(d.error);
  toast('Sessão marcada como realizada.','ok');buscarSessoes();buscarResumo();
  }catch(e){toast('Erro: '+e.message,'err');btn.disabled=false;btn.textContent='✓ Realizado';}
}
async function faltou(id,btn){
  if(!confirm('Marcar paciente como faltou?'))return;
  btn.disabled=true;btn.textContent='…';
  try{const r=await fetch(API+'/api/psicologia/'+id+'/faltou',{method:'POST',headers:hdr()});
  const d=await r.json();if(!d.ok)throw new Error(d.error);
  toast('Marcado como faltou.','ok');buscarSessoes();
  }catch(e){toast('Erro: '+e.message,'err');btn.disabled=false;btn.textContent='✗ Faltou';}
}
async function pagar(id,btn){
  if(!confirm('Confirmar pagamento do repasse ao psicólogo?'))return;
  btn.disabled=true;btn.textContent='…';
  try{const r=await fetch(API+'/api/psicologia/'+id+'/pagar',{method:'POST',headers:hdr()});
  const d=await r.json();if(!d.ok)throw new Error(d.error);
  toast('Repasse registrado como pago.','ok');buscarSessoes();buscarResumo();
  }catch(e){toast('Erro: '+e.message,'err');btn.disabled=false;btn.textContent='$ Pagar';}
}
function mudarAba(aba,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');
  document.getElementById('aba-sessoes').style.display=aba==='sessoes'?'block':'none';
  document.getElementById('aba-resumo').style.display=aba==='resumo'?'block':'none';
  document.getElementById('aba-cadastros').style.display=aba==='cadastros'?'block':'none';
  if(aba==='resumo')buscarResumo();
  if(aba==='cadastros')carregarCadastros();
}
async function carregarCadastros(){
  const tbody=document.getElementById('cadastros-body');
  tbody.innerHTML='<tr><td colspan="7" style="padding:16px;text-align:center">Carregando…</td></tr>';
  try{
    const r=await fetch(API+'/api/admin/psicologos',{headers:hdr()});
    const d=await r.json();
    if(!d.ok||!d.psicologos?.length){tbody.innerHTML='<tr><td colspan="7" style="padding:16px;text-align:center">Nenhum cadastro encontrado.</td></tr>';return;}
    tbody.innerHTML=d.psicologos.map(p=>{
      const statusChip=p.status==='pendente'
        ?'<span style="background:#fff3cd;color:#856404;padding:2px 8px;border-radius:12px;font-size:.78rem">Pendente</span>'
        :p.status==='aprovado'
          ?'<span style="background:#d1e7dd;color:#0f5132;padding:2px 8px;border-radius:12px;font-size:.78rem">Aprovado</span>'
          :'<span style="background:#f8d7da;color:#842029;padding:2px 8px;border-radius:12px;font-size:.78rem">Rejeitado</span>';
      const acoesAdmin=p.status==='pendente'
        ?'<button onclick="aprovarPsi('+p.id+')" style="background:#0f5132;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:.78rem;margin-right:4px">Aprovar</button>'
         +'<button onclick="rejeitarPsi('+p.id+')" style="background:#842029;color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:.78rem">Rejeitar</button>'
        :p.status==='aprovado'
          ?'<button onclick="toggleVisivel('+p.id+','+((!p.visivel)+'')+')" style="background:'+(p.visivel?'#6c757d':'#26508e')+';color:#fff;border:none;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:.78rem">'+(p.visivel?'Ocultar do site':'Mostrar no site')+'</button>'
     :'<span style="color:#999">—</span>';
      return '<tr style="border-bottom:1px solid #eee">'
        +'<td style="padding:8px 10px">'+p.id+'</td>'
        +'<td style="padding:8px 10px">'+esc(p.nome)+'</td>'
        +'<td style="padding:8px 10px">'+esc(p.email)+'</td>'
        +'<td style="padding:8px 10px">'+esc(p.crp||'—')+'</td>'
        +'<td style="padding:8px 10px">'+statusChip+'</td>'
        +'<td style="padding:8px 10px">'+(p.visivel?'✅':'⬜')+'</td>'
        +'<td style="padding:8px 10px">'+acoesAdmin+'</td>'
        +'</tr>';
    }).join('');
  }catch(e){tbody.innerHTML='<tr><td colspan="7" style="padding:16px;text-align:center;color:red">Erro ao carregar.</td></tr>';}
}
async function aprovarPsi(id){
  if(!confirm('Aprovar este psicólogo?'))return;
  const r=await fetch(API+'/api/admin/psicologo/'+id+'/aprovar',{method:'PATCH',headers:hdr()});
  const d=await r.json();
  toast(d.ok?'Psicólogo aprovado!':'Erro: '+(d.error||''),'ok');
  if(d.ok)carregarCadastros();
}
async function rejeitarPsi(id){
  if(!confirm('Rejeitar este psicólogo?'))return;
  const r=await fetch(API+'/api/admin/psicologo/'+id+'/rejeitar',{method:'PATCH',headers:hdr()});
  const d=await r.json();
  toast(d.ok?'Psicólogo rejeitado.':'Erro: '+(d.error||''));
  if(d.ok)carregarCadastros();
}
async function toggleVisivel(id,novoValor){
  const r=await fetch(API+'/api/admin/psicologo/'+id+'/visivel',{method:'PATCH',headers:hdr(),body:JSON.stringify({visivel:novoValor})});
  const d=await r.json();
  toast(d.ok?(novoValor?'Psicólogo visível no site.':'Psicólogo ocultado do site.'):'Erro: '+(d.error||''));
  if(d.ok)carregarCadastros();
}
function chipStatus(s){const m={agendado:['chip-agendado','Agendado'],pago:['chip-pago','Pago'],realizado:['chip-realizado','Realizado'],cancelado:['chip-cancelado','Cancelado'],faltou:['chip-faltou','Faltou']};const[cls,label]=m[s]||['chip-agendado',s];return '<span class="chip '+cls+'">'+label+'</span>';}
function fmtR(v){return 'R$ '+parseFloat(v||0).toFixed(2).replace('.',',');}
function fmtD(iso){if(!iso)return '—';return new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Fortaleza',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function toast(msg,tipo){const el=document.getElementById('toast');el.textContent=msg;el.className='toast show '+(tipo||'');clearTimeout(el._t);el._t=setTimeout(()=>el.classList.remove('show'),3200);}
const saved=sessionStorage.getItem('adm_pw');
if(saved){SENHA=saved;document.getElementById('login-overlay').style.display='none';iniciar();}
</script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── PATCH /api/psicologo/sessao/:id/link — salva link por sessão ──────────────
// Helper de normalização de URL de Meet
function normalizarLinkMeet(url) {
  if (!url) return '';
  try {
    // Remove querystring, fragmento, barra final, lowercase, trim
    const u = new URL(url.trim().toLowerCase());
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch(_) {
    // Fallback: trim + lowercase + remove querystring + barra final
    return url.trim().toLowerCase().replace(/\?.*$/, '').replace(/\/+$/, '');
  }
}

app.patch('/api/psicologo/sessao/:id/link', authPsicologo, async (req, res) => {
  try {
    const ip    = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
    const agId  = parseInt(req.params.id, 10);
    const { link_sessao } = req.body || {};
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!link_sessao || !link_sessao.trim()) {
      return res.status(400).json({ ok: false, error: 'link_sessao é obrigatório' });
    }
    if (!/^https?:\/\//i.test(link_sessao.trim())) {
      return res.status(400).json({ ok: false, error: 'Link inválido. Use uma URL completa (https://...)' });
    }

    const linkNorm = normalizarLinkMeet(link_sessao);

    // Verifica se o agendamento pertence ao psicólogo
    const { rows: check } = await pool.query(
      `SELECT id, pagamento_status FROM agendamentos_psicologia
        WHERE id = $1 AND psicologo_id = $2 LIMIT 1`,
      [agId, req.psicologoId]
    );
    if (check.length === 0) {
      return res.status(404).json({ ok: false, error: 'Agendamento não encontrado ou não pertence a você' });
    }

    // Bloqueia reutilização: verifica se link (normalizado) já existe em outro agendamento deste psicólogo
    const { rows: duplicados } = await pool.query(
      `SELECT id FROM agendamentos_psicologia
        WHERE psicologo_id = $1
          AND id <> $2
          AND link_sessao IS NOT NULL
          AND LOWER(REGEXP_REPLACE(TRIM(link_sessao), '[?#].*$', ''))
              = LOWER(REGEXP_REPLACE(TRIM($3), '[?#].*$', ''))
        LIMIT 1`,
      [req.psicologoId, agId, link_sessao.trim().replace(/\/+$/, '')]
    );
    if (duplicados.length > 0) {
      return res.status(409).json({
        ok: false,
        error: 'Este link já foi utilizado em outra sessão. Informe um novo link do Google Meet.'
      });
    }

    // Salva o link vinculado ao agendamento
    await pool.query(
      `UPDATE agendamentos_psicologia SET link_sessao = $1 WHERE id = $2`,
      [link_sessao.trim(), agId]
    );

    await logAcessoPsi({
      psicologoId: req.psicologoId,
      agendamentoId: agId,
      tipoEvento: 'salvamento_link_sessao',
      detalhe: `Link salvo: ${linkNorm}`,
      ip,
    });

    console.log(`[PSI-LINK] Psicólogo #${req.psicologoId} salvou link para agendamento #${agId}: ${linkNorm}`);
    return res.json({ ok: true, link_sessao: link_sessao.trim() });
  } catch(e) {
    console.error('[PSI-LINK] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ANTI-DESVIO DE PACIENTES — PSICOLOGIA
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers de mascaramento ───────────────────────────────────────────────────
function mascararTel(tel) {
  if (!tel) return null;
  const d = String(tel).replace(/\D/g, '');
  if (d.length < 8) return '****';
  // Formato: (XX) 9****-1234
  const ddd  = d.length >= 11 ? d.slice(0, 2) : '';
  const fim  = d.slice(-4);
  return ddd ? `(${ddd}) ****-${fim}` : `****-${fim}`;
}

function mascararEmail(email) {
  if (!email) return null;
  const [local, dominio] = String(email).split('@');
  if (!dominio) return '****';
  const vis = local.slice(0, 2);
  return `${vis}${'*'.repeat(Math.max(3, local.length - 2))}@${dominio}`;
}

function mascararAgendamento(row) {
  if (!row) return row;
  return {
    ...row,
    paciente_tel:   mascararTel(row.paciente_tel),
    paciente_email: mascararEmail(row.paciente_email),
  };
}

// ── Helper de log de acesso ───────────────────────────────────────────────────
async function logAcessoPsi({ psicologoId, agendamentoId, pacienteId, tipoEvento, detalhe, ip }) {
  try {
    await pool.query(
      `INSERT INTO psicologo_logs_acesso
         (psicologo_id, agendamento_id, paciente_id, tipo_evento, detalhe, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [psicologoId || null, agendamentoId || null, pacienteId || null,
       tipoEvento, detalhe || null, ip || null]
    );
  } catch (e) {
    console.warn('[PSI-LOG] Falha ao gravar log:', e.message);
  }
}

// ── Aviso contratual ──────────────────────────────────────────────────────────
const AVISO_CONTRATUAL_PSI =
  'É proibido compartilhar contato pessoal ou realizar atendimentos fora da plataforma ' +
  'com pacientes captados pela ConsultaJá24h. O descumprimento pode gerar bloqueio e multa contratual.';

// ── Migração: garantir colunas novas na tabela ────────────────────────────────
(async () => {
  const alterações = [
    `ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS iniciado_em      TIMESTAMPTZ`,
    `ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS iniciado_por      INTEGER`,
    `ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS link_sessao       TEXT`,
    `ALTER TABLE agendamentos_psicologia ADD COLUMN IF NOT EXISTS visualizado_em    TIMESTAMPTZ`,
    `CREATE TABLE IF NOT EXISTS psicologo_logs_acesso (
       id            SERIAL PRIMARY KEY,
       psicologo_id  INTEGER,
       agendamento_id INTEGER,
       paciente_id   INTEGER,
       tipo_evento   TEXT NOT NULL,
       detalhe       TEXT,
       ip            TEXT,
       criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_psicologo_logs_psi ON psicologo_logs_acesso (psicologo_id)`,
    `CREATE INDEX IF NOT EXISTS idx_psicologo_logs_ag  ON psicologo_logs_acesso (agendamento_id)`,
  ];
  for (const sql of alterações) {
    await pool.query(sql).catch(e => console.warn('[PSI-MIGRATION]', e.message));
  }
  console.log('[PSI-ANTI-DESVIO] Migração concluída.');
})();

// ── GET /api/psicologo/agendamentos (substituição: mascaramento + log) ────────
// Remove a rota anterior e registra a nova com mascaramento
// NOTA: Esta rota substitui funcionalmente a existente acima; o Express usa a
// primeira definição que encontrar — como esta fica após a original, o módulo
// precisaria ter a original removida. Para não tocar na original, usamos um
// middleware explícito com path diferente e redefinimos via override abaixo.
// Solução: a rota original permanece, criamos a nova como alias com prefixo v2
// que o painel pode optar por usar. Para forçar o mascaramento sem alterar o
// frontend existente, aplicamos um wrapper via monkey-patch no pool para esta
// rota específica. A abordagem mais simples e segura: registrar ANTES do
// listen um middleware de transformação de resposta para esta rota.

// ── GET /api/psicologo/agendamentos/mascarados ────────────────────────────────
// Versão mascarada para uso no painel do psicólogo
app.get('/api/psicologo/agendamentos/mascarados', authPsicologo, async (req, res) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
    const { rows } = await pool.query(
      `SELECT id, paciente_nome, paciente_email, paciente_tel,
              tipo_consulta, horario_agendado, valor_cobrado,
              pagamento_status, status, status_sessao, formulario_enviado, criado_em,
              iniciado_em, iniciado_por, link_sessao,
              (SELECT sala_meet FROM psicologos WHERE id = agendamentos_psicologia.psicologo_id) AS sala_meet
         FROM agendamentos_psicologia
        WHERE psicologo_id = $1
        ORDER BY horario_agendado DESC`,
      [req.psicologoId]
    );
    await logAcessoPsi({
      psicologoId: req.psicologoId,
      tipoEvento: 'visualizacao_agendamentos',
      detalhe: `${rows.length} agendamentos listados (mascarados)`,
      ip,
    });
    return res.json({
      ok: true,
      aviso_contratual: AVISO_CONTRATUAL_PSI,
      agendamentos: rows.map(mascararAgendamento),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── POST /api/psicologo/sessao/:id/iniciar ────────────────────────────────────
app.post('/api/psicologo/sessao/:id/iniciar', authPsicologo, async (req, res) => {
  try {
    const ip  = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress;
    const agId = parseInt(req.params.id, 10);
    if (!agId) return res.status(400).json({ ok: false, error: 'ID inválido' });

    // Busca agendamento garantindo que pertence ao psicólogo autenticado
    const { rows } = await pool.query(
      `SELECT ap.id, ap.paciente_nome, ap.psicologo_id, ap.status_sessao,
              ap.pagamento_status, ap.horario_agendado, ap.iniciado_em,
              p.sala_meet
         FROM agendamentos_psicologia ap
         JOIN psicologos p ON p.id = ap.psicologo_id
        WHERE ap.id = $1 AND ap.psicologo_id = $2`,
      [agId, req.psicologoId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'Agendamento não encontrado ou não pertence a você' });
    }
    const ag = rows[0];

    if (ag.pagamento_status !== 'confirmado') {
      return res.status(400).json({ ok: false, error: 'Pagamento não confirmado para este agendamento' });
    }
    if (!ag.sala_meet) {
      return res.status(400).json({ ok: false, error: 'Você ainda não configurou sua sala do Google Meet. Acesse seu perfil para cadastrar o link.' });
    }

    // Registra início (idempotente — só marca uma vez)
    const jaIniciado = !!ag.iniciado_em;
    if (!jaIniciado) {
      await pool.query(
        `UPDATE agendamentos_psicologia
            SET iniciado_em   = NOW(),
                iniciado_por  = $1,
                link_sessao   = $2
          WHERE id = $3`,
        [req.psicologoId, ag.sala_meet, agId]
      );
    }

    await logAcessoPsi({
      psicologoId: req.psicologoId,
      agendamentoId: agId,
      tipoEvento: jaIniciado ? 'reingresso_sessao' : 'inicio_sessao',
      detalhe: `Sessão iniciada via plataforma — Meet: ${ag.sala_meet}`,
      ip,
    });

    console.log(`[PSI-SESSAO] Psicólogo #${req.psicologoId} iniciou sessão agendamento #${agId} (${ag.paciente_nome}) — ${jaIniciado ? 're-ingresso' : 'primeira vez'}`);

    return res.json({
      ok: true,
      ja_iniciado: jaIniciado,
      link_meet: ag.sala_meet,
      aviso_contratual: AVISO_CONTRATUAL_PSI,
    });
  } catch (e) {
    console.error('[PSI-SESSAO] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/psicologo/aviso-contratual ──────────────────────────────────────
app.get('/api/psicologo/aviso-contratual', authPsicologo, (req, res) => {
  return res.json({ ok: true, aviso: AVISO_CONTRATUAL_PSI });
});

// ── GET /api/admin/psicologia/indicadores ────────────────────────────────────
app.get('/api/admin/psicologia/indicadores', checkAdmin, async (req, res) => {
  try {
    // Métricas por psicólogo
    const { rows: porPsi } = await pool.query(
      `SELECT
         p.id                                                              AS psicologo_id,
         p.nome_exibicao                                                   AS psicologo_nome,
         COUNT(DISTINCT ap.id)                                             AS total_sessoes,
         COUNT(DISTINCT ap.id) FILTER (WHERE ap.pagamento_status='confirmado')  AS total_pagas,
         COUNT(DISTINCT ap.id) FILTER (WHERE ap.status_sessao='realizado')       AS total_realizadas,
         COUNT(DISTINCT ap.id) FILTER (WHERE ap.iniciado_em IS NOT NULL)          AS iniciadas_plataforma,
         COUNT(DISTINCT paciente_nome)                                             AS total_pacientes_distintos,
         COUNT(DISTINCT paciente_nome) FILTER (
           WHERE (SELECT COUNT(*) FROM agendamentos_psicologia ap2
                   WHERE ap2.psicologo_id = p.id AND ap2.paciente_nome = ap.paciente_nome) = 1
         )                                                                         AS pacientes_unica_sessao
       FROM psicologos p
       LEFT JOIN agendamentos_psicologia ap ON ap.psicologo_id = p.id
       WHERE p.ativo = true
       GROUP BY p.id, p.nome_exibicao
       ORDER BY p.nome_exibicao`
    );

    // Taxa de retorno por psicólogo
    const indicadores = porPsi.map(r => {
      const total     = parseInt(r.total_pacientes_distintos, 10) || 0;
      const unicaVez  = parseInt(r.pacientes_unica_sessao, 10)    || 0;
      const retorno   = total > 0 ? (((total - unicaVez) / total) * 100).toFixed(1) : '0.0';
      const pct_plat  = parseInt(r.total_pagas, 10) > 0
        ? ((parseInt(r.iniciadas_plataforma, 10) / parseInt(r.total_pagas, 10)) * 100).toFixed(1)
        : '0.0';
      return {
        ...r,
        taxa_retorno_pct:           retorno,
        pct_iniciadas_plataforma:   pct_plat,
      };
    });

    // Logs recentes de acesso (últimas 48h)
    const { rows: logsRecentes } = await pool.query(
      `SELECT l.psicologo_id, p.nome_exibicao AS psicologo_nome,
              l.agendamento_id, l.tipo_evento, l.detalhe, l.ip, l.criado_em
         FROM psicologo_logs_acesso l
         LEFT JOIN psicologos p ON p.id = l.psicologo_id
        WHERE l.criado_em > NOW() - INTERVAL '48 hours'
        ORDER BY l.criado_em DESC
        LIMIT 200`
    );

    return res.json({
      ok: true,
      indicadores,
      logs_recentes: logsRecentes,
    });
  } catch (e) {
    console.error('[PSI-INDICADORES] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FIM ANTI-DESVIO DE PACIENTES
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
// ESPECIALISTA — ENDPOINTS DO PAINEL (complemento ao bloco existente)
// ══════════════════════════════════════════════════════════════════════════════

// ── Migração mínima ───────────────────────────────────────────────────────────
(async () => {
  const migs = [
    `ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS senha_hash TEXT`,
    `ALTER TABLE especialistas ADD COLUMN IF NOT EXISTS precisa_trocar_senha BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS modalidade TEXT NOT NULL DEFAULT 'video'`,
    `ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS prontuario_texto TEXT`,
    `ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS observacoes TEXT`,
    `ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS data_nascimento TEXT`,
    `ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS sexo TEXT`,
    `ALTER TABLE agendamentos_especialistas ADD COLUMN IF NOT EXISTS cpf TEXT`,
  ];
  for (const sql of migs) {
    await pool.query(sql).catch(e => console.warn('[ESP-MIGRATION2]', e.message));
  }
  console.log('[ESP] Migração de colunas (painel) concluída.');
})();

// ── Helper: enviar email via Resend (especialista) ────────────────────────────
async function enviarEmailEspecialista({ to, subject, html }) {
  const RESEND_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_KEY || !to) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_KEY}` },
    body: JSON.stringify({ from: 'ConsultaJá24h <contato@consultaja24h.com.br>', to: [to], subject, html }),
  }).catch(e => console.warn('[ESP-EMAIL] Falha:', e.message));
}

// ── Helper: verificar ownership ──────────────────────────────────────────────
async function getConsultaEsp(id, especialistaId) {
  const { rows } = await pool.query(
    `SELECT id, status, paciente_nome, paciente_email, modalidade, prontuario_texto
       FROM agendamentos_especialistas
      WHERE id = $1 AND especialista_id = $2 LIMIT 1`,
    [id, especialistaId]
  );
  return rows[0] || null;
}

// ── POST /api/especialista/trocar-senha ──────────────────────────────────────
app.post('/api/especialista/trocar-senha', authEspecialista, async (req, res) => {
  try {
    const { senhaAtual, novaSenha, confirmarSenha } = req.body || {};
    if (!senhaAtual || !novaSenha || !confirmarSenha)
      return res.status(400).json({ ok: false, error: 'Todos os campos são obrigatórios' });
    if (novaSenha !== confirmarSenha)
      return res.status(400).json({ ok: false, error: 'As senhas não coincidem' });
    if (novaSenha.length < 6)
      return res.status(400).json({ ok: false, error: 'A nova senha deve ter ao menos 6 caracteres' });
    const { rows } = await pool.query(
      `SELECT senha_hash FROM especialistas WHERE id = $1`, [req.especialistaId]);
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Especialista não encontrado' });
    const ok = await bcrypt.compare(String(senhaAtual), rows[0].senha_hash || '');
    if (!ok) return res.status(401).json({ ok: false, error: 'Senha atual incorreta' });
    const novoHash = await bcrypt.hash(String(novaSenha), 10);
    await pool.query(
      `UPDATE especialistas SET senha_hash = $1, precisa_trocar_senha = false WHERE id = $2`,
      [novoHash, req.especialistaId]
    );
    console.log(`[ESP-SENHA] Especialista #${req.especialistaId} trocou a senha`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ESP-SENHA] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/especialista/consultas ─────────────────────────────────────────
app.get('/api/especialista/consultas', authEspecialista, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         ae.id,
         ae.paciente_nome,
         ae.paciente_tel,
         ae.paciente_email,
         ae.paciente_cpf                  AS cpf,
         ae.horario_agendado,
         ae.especialidade,
         COALESCE(ae.modalidade, 'video')  AS modalidade,
         ae.status,
         ae.link_sessao,
         ae.observacoes                   AS obs,
         ae.prontuario_texto,
         ae.data_nascimento,
         ae.sexo,
         ae.pagamento_status
       FROM agendamentos_especialistas ae
      WHERE ae.especialista_id = $1
      ORDER BY ae.horario_agendado DESC`,
      [req.especialistaId]
    );
    return res.json({ ok: true, consultas: rows });
  } catch (e) {
    console.error('[ESP-CONSULTAS] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/especialista/consulta/:id ──────────────────────────────────────
app.get('/api/especialista/consulta/:id', authEspecialista, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const { rows } = await pool.query(
      `SELECT
         ae.id,
         ae.paciente_nome,
         ae.paciente_tel,
         ae.paciente_email,
         ae.paciente_cpf                  AS cpf,
         ae.horario_agendado,
         ae.especialidade,
         COALESCE(ae.modalidade, 'video')  AS modalidade,
         ae.status,
         ae.link_sessao,
         ae.observacoes                   AS obs,
         ae.prontuario_texto,
         ae.data_nascimento,
         ae.sexo,
         ae.pagamento_status,
         ae.valor_cobrado
       FROM agendamentos_especialistas ae
      WHERE ae.id = $1 AND ae.especialista_id = $2 LIMIT 1`,
      [id, req.especialistaId]
    );
    if (!rows.length) return res.status(404).json({ ok: false, error: 'Consulta não encontrada' });
    return res.json({ ok: true, consulta: rows[0] });
  } catch (e) {
    console.error('[ESP-CONSULTA] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/especialista/consulta/:id/link_sessao ───────────────────────────
app.put('/api/especialista/consulta/:id/link_sessao', authEspecialista, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { link_sessao } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!link_sessao || !/^https?:\/\//i.test(link_sessao.trim()))
      return res.status(400).json({ ok: false, error: 'Informe um link válido (https://)' });
    const consulta = await getConsultaEsp(id, req.especialistaId);
    if (!consulta) return res.status(404).json({ ok: false, error: 'Consulta não encontrada' });
    await pool.query(
      `UPDATE agendamentos_especialistas SET link_sessao = $1 WHERE id = $2`,
      [link_sessao.trim(), id]
    );
    if (consulta.paciente_email) {
      const html = `<div style="background:#f5f5f5;padding:32px;font-family:sans-serif">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
          <h2 style="color:#1a1612;margin:0 0 12px">Link da sua consulta disponível</h2>
          <p style="color:#555;font-size:.9rem;margin-bottom:16px">Olá, ${consulta.paciente_nome}. O link para sua consulta foi disponibilizado:</p>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin-bottom:14px">
            <a href="${link_sessao.trim()}" style="color:#166534;font-size:.88rem;word-break:break-all">${link_sessao.trim()}</a>
          </div>
          <p style="color:#999;font-size:.78rem">Acesse o link no horário da sua consulta.</p>
        </div>
      </div>`;
      enviarEmailEspecialista({ to: consulta.paciente_email, subject: 'Link da sua consulta — ConsultaJá24h', html }).catch(() => {});
    }
    console.log(`[ESP-LINK] Consulta #${id} — link salvo por especialista #${req.especialistaId}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ESP-LINK] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/especialista/consulta/:id/iniciar ───────────────────────────────
app.put('/api/especialista/consulta/:id/iniciar', authEspecialista, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const consulta = await getConsultaEsp(id, req.especialistaId);
    if (!consulta) return res.status(404).json({ ok: false, error: 'Consulta não encontrada' });
    if (consulta.status === 'cancelada')
      return res.status(400).json({ ok: false, error: 'Consulta cancelada não pode ser iniciada' });
    await pool.query(
      `UPDATE agendamentos_especialistas SET status = 'em_andamento'
        WHERE id = $1 AND status NOT IN ('em_andamento','encerrada','cancelada')`,
      [id]
    );
    console.log(`[ESP-INICIAR] Consulta #${id} iniciada por especialista #${req.especialistaId}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ESP-INICIAR] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/especialista/consulta/:id/encerrar ──────────────────────────────
app.put('/api/especialista/consulta/:id/encerrar', authEspecialista, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { prontuario } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const consulta = await getConsultaEsp(id, req.especialistaId);
    if (!consulta) return res.status(404).json({ ok: false, error: 'Consulta não encontrada' });
    if (consulta.status === 'cancelada')
      return res.status(400).json({ ok: false, error: 'Consulta cancelada não pode ser encerrada' });
    await pool.query(
      `UPDATE agendamentos_especialistas
          SET status = 'encerrada', prontuario_texto = COALESCE($1, prontuario_texto)
        WHERE id = $2`,
      [prontuario || null, id]
    );
    console.log(`[ESP-ENCERRAR] Consulta #${id} encerrada por especialista #${req.especialistaId}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ESP-ENCERRAR] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/especialista/consulta/:id/cancelar ──────────────────────────────
app.put('/api/especialista/consulta/:id/cancelar', authEspecialista, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const consulta = await getConsultaEsp(id, req.especialistaId);
    if (!consulta) return res.status(404).json({ ok: false, error: 'Consulta não encontrada' });
    if (consulta.status === 'encerrada')
      return res.status(400).json({ ok: false, error: 'Consulta já encerrada não pode ser cancelada' });
    await pool.query(`UPDATE agendamentos_especialistas SET status = 'cancelada' WHERE id = $1`, [id]);
    console.log(`[ESP-CANCELAR] Consulta #${id} cancelada por especialista #${req.especialistaId}`);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ESP-CANCELAR] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── PUT /api/especialista/consulta/:id/prontuario ────────────────────────────
app.put('/api/especialista/consulta/:id/prontuario', authEspecialista, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { prontuario, append } = req.body || {};
    if (!id) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!prontuario) return res.status(400).json({ ok: false, error: 'Conteúdo do prontuário é obrigatório' });
    const consulta = await getConsultaEsp(id, req.especialistaId);
    if (!consulta) return res.status(404).json({ ok: false, error: 'Consulta não encontrada' });
    if (append) {
      await pool.query(
        `UPDATE agendamentos_especialistas
            SET prontuario_texto = COALESCE(prontuario_texto || E'\n\n' || $1, $1)
          WHERE id = $2`,
        [prontuario, id]
      );
    } else {
      await pool.query(
        `UPDATE agendamentos_especialistas SET prontuario_texto = $1 WHERE id = $2`,
        [prontuario, id]
      );
    }
    return res.json({ ok: true });
  } catch (e) {
    console.error('[ESP-PRONT] Erro:', e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// FIM ESPECIALISTA PAINEL
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.send('API ConsultaJá24h rodando');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, '0.0.0.0', () => {
  console.log("Servidor rodando na porta", PORT);
});
