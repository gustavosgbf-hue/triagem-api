import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const SITE_URL = String(process.env.PUBLIC_SITE_URL || 'https://consultaja24h.com.br').replace(/\/$/, '');
const VAPID_PUBLIC_KEY = String(process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '').trim();
const VAPID_PRIVATE_KEY = String(process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '').trim();
const VAPID_SUBJECT = String(process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:consultaja24@gmail.com').trim();
const CHECK_MS = Math.max(60 * 60 * 1000, Number(process.env.PATIENT_RETENTION_PUSH_CHECK_MS || 6 * 60 * 60 * 1000));
const AFTER_DAYS = Math.max(21, Number(process.env.PATIENT_RETENTION_PUSH_AFTER_DAYS || 30));
const REPEAT_DAYS = Math.max(21, Number(process.env.PATIENT_RETENTION_PUSH_REPEAT_DAYS || 30));
let schemaPromise;
let workerStarted = false;
let workerBusy = false;

function enabled(){ return !!VAPID_PUBLIC_KEY && !!VAPID_PRIVATE_KEY; }
function normalizePhone(value){ let n=String(value||'').replace(/\D/g,''); if(n.startsWith('55')&&n.length>=12)n=n.slice(2); return n.slice(-11); }
function normalizeCpf(value){ return String(value||'').replace(/\D/g,'').slice(0,11); }
function ensureSchema(){
  if(!schemaPromise) schemaPromise = pool.query(`
    CREATE TABLE IF NOT EXISTS paciente_retencao_push (
      id BIGSERIAL PRIMARY KEY,
      paciente_id BIGINT NOT NULL,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      opt_in BOOLEAN NOT NULL DEFAULT TRUE,
      ultimo_envio_em TIMESTAMPTZ,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_paciente_retencao_push_paciente ON paciente_retencao_push(paciente_id) WHERE opt_in=TRUE;
  `).catch(e=>{schemaPromise=null;throw e});
  return schemaPromise;
}
function authPaciente(req,res,next){
  try{const raw=String(req.headers.authorization||'');const token=raw.replace(/^Bearer\s+/i,'').trim();const d=jwt.verify(token,process.env.JWT_SECRET||'');if(d?.tipo!=='paciente'||!d?.id)return res.status(401).json({ok:false,error:'Sessão inválida'});req.pacienteId=Number(d.id);next()}catch{return res.status(401).json({ok:false,error:'Sessão expirada'})}
}
function subscriptionParts(s){return {endpoint:String(s?.endpoint||'').trim(),p256dh:String(s?.keys?.p256dh||'').trim(),auth:String(s?.keys?.auth||'').trim()}}
async function installRoutes(app){
  if(app.locals.__patientRetentionInstalled)return;app.locals.__patientRetentionInstalled=true;
  app.post('/api/paciente/retencao-push',express.json({limit:'32kb'}),authPaciente,async(req,res)=>{
    try{
      await ensureSchema();const optIn=!!req.body?.opt_in;
      if(!optIn){await pool.query('UPDATE paciente_retencao_push SET opt_in=FALSE,atualizado_em=NOW() WHERE paciente_id=$1',[req.pacienteId]);return res.json({ok:true,opt_in:false})}
      if(!enabled())return res.status(503).json({ok:false,error:'Notificações indisponíveis'});
      const {endpoint,p256dh,auth}=subscriptionParts(req.body?.subscription||{});if(!endpoint||!p256dh||!auth)return res.status(400).json({ok:false,error:'Assinatura de notificação inválida'});
      await pool.query(`INSERT INTO paciente_retencao_push(paciente_id,endpoint,p256dh,auth,opt_in,atualizado_em)
        VALUES($1,$2,$3,$4,TRUE,NOW()) ON CONFLICT(endpoint) DO UPDATE SET paciente_id=EXCLUDED.paciente_id,p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,opt_in=TRUE,atualizado_em=NOW()`,[req.pacienteId,endpoint,p256dh,auth]);
      return res.json({ok:true,opt_in:true});
    }catch(e){console.warn('[PATIENT-RETENTION-SUBSCRIBE]',e?.message||e);return res.status(500).json({ok:false,error:'Não foi possível salvar sua preferência agora.'})}
  });
}
async function candidateRows(){
  const {rows}=await pool.query(`
    SELECT s.id,s.paciente_id,s.endpoint,s.p256dh,s.auth,s.ultimo_envio_em,p.tel,p.cpf,
      (SELECT MAX(COALESCE(NULLIF(to_jsonb(f)->>'encerrado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'finalizado_em','')::timestamptz,NULLIF(to_jsonb(f)->>'criado_em','')::timestamptz))
         FROM fila_atendimentos f
        WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(f)->>'tel',''),'\\D','','g'),11)=RIGHT(regexp_replace(COALESCE(p.tel,''),'\\D','','g'),11)
          AND (regexp_replace(COALESCE(to_jsonb(f)->>'cpf',''),'\\D','','g')=regexp_replace(COALESCE(p.cpf,''),'\\D','','g') OR regexp_replace(COALESCE(to_jsonb(f)->>'pagador_cpf',''),'\\D','','g')=regexp_replace(COALESCE(p.cpf,''),'\\D','','g'))
          AND COALESCE(LOWER(to_jsonb(f)->>'status'),'') NOT IN ('cancelado','expirado')) AS ultimo_atendimento
      FROM paciente_retencao_push s JOIN pacientes p ON p.id=s.paciente_id
     WHERE s.opt_in=TRUE
       AND (s.ultimo_envio_em IS NULL OR s.ultimo_envio_em < NOW() - ($2 || ' days')::interval)
       AND NOT EXISTS (
         SELECT 1 FROM fila_atendimentos a
          WHERE RIGHT(regexp_replace(COALESCE(to_jsonb(a)->>'tel',''),'\\D','','g'),11)=RIGHT(regexp_replace(COALESCE(p.tel,''),'\\D','','g'),11)
            AND COALESCE(LOWER(to_jsonb(a)->>'status'),'') NOT IN ('encerrado','finalizado','finalizada','concluido','concluído','cancelado','expirado','arquivado')
            AND NULLIF(to_jsonb(a)->>'encerrado_em','') IS NULL)
     LIMIT 60
  `,[AFTER_DAYS,REPEAT_DAYS]);
  return rows.filter(r=>r.ultimo_atendimento && new Date(r.ultimo_atendimento).getTime() <= Date.now()-AFTER_DAYS*86400000);
}
async function sendOne(row){
  const subscription={endpoint:row.endpoint,keys:{p256dh:row.p256dh,auth:row.auth}};
  const payload=JSON.stringify({title:'ConsultaJá24h',body:'Seu acesso continua disponível. Quando precisar, inicie um novo atendimento em poucos toques.',url:`${SITE_URL}/conta/?src=lembrete`,tag:'cj24h-retencao'});
  try{await webpush.sendNotification(subscription,payload,{TTL:86400,urgency:'normal'});await pool.query('UPDATE paciente_retencao_push SET ultimo_envio_em=NOW(),atualizado_em=NOW() WHERE id=$1',[row.id])}
  catch(e){const sc=Number(e?.statusCode||0);if(sc===404||sc===410)await pool.query('UPDATE paciente_retencao_push SET opt_in=FALSE,atualizado_em=NOW() WHERE id=$1',[row.id]).catch(()=>{});console.warn('[PATIENT-RETENTION-PUSH]',e?.message||e)}
}
async function runWorker(){if(!enabled()||workerBusy)return;workerBusy=true;try{await ensureSchema();webpush.setVapidDetails(VAPID_SUBJECT,VAPID_PUBLIC_KEY,VAPID_PRIVATE_KEY);for(const row of await candidateRows())await sendOne(row)}catch(e){console.warn('[PATIENT-RETENTION-WORKER]',e?.message||e)}finally{workerBusy=false}}
function startWorker(){if(workerStarted)return;workerStarted=true;setTimeout(runWorker,45000);setInterval(runWorker,CHECK_MS)}
const originalInit=express.application.init;
express.application.init=function patchedPatientRetentionInit(...args){const result=originalInit.apply(this,args);installRoutes(this);startWorker();return result};
