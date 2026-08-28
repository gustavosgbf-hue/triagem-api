import express from 'express';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ADMIN_EMAIL = 'gustavosgbf@gmail.com';

function bearer(req){ return String(req.headers.authorization || '').replace(/^Bearer\s+/i,'').trim(); }
function digits(v){ return String(v || '').replace(/\D/g,''); }
function phone(v){ let n=digits(v); if(n.startsWith('55')&&n.length>=12)n=n.slice(2); return n.slice(-11); }
function cpf(v){ return digits(v).slice(0,11); }
function name(v){ return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z\s]/g,' ').replace(/\s+/g,' ').trim(); }
function date(v){ if(!v)return ''; const s=String(v).trim(); const m=s.match(/(\d{4}-\d{2}-\d{2})/); return m?m[1]:''; }
function isAdmin(m){ return String(m?.email||'').trim().toLowerCase()===ADMIN_EMAIL; }

async function authMedico(req,res,next){
  try{
    const d=jwt.verify(bearer(req),process.env.JWT_SECRET||'');
    if(!d?.id||d?.tipo==='paciente') return res.status(401).json({ok:false,error:'Sessão inválida'});
    const {rows}=await pool.query('SELECT id,nome,nome_exibicao,email,crm,ativo FROM medicos WHERE id=$1 LIMIT 1',[Number(d.id)]);
    if(!rows[0]||rows[0].ativo===false) return res.status(401).json({ok:false,error:'Sessão inválida'});
    req.medico=rows[0]; next();
  }catch{ return res.status(401).json({ok:false,error:'Sessão expirada'}); }
}

function signals(current,candidate){
  const pm=phone(current.tel).length>=10 && phone(current.tel)===phone(candidate.tel);
  const cm=cpf(current.cpf).length===11 && cpf(current.cpf)===cpf(candidate.cpf);
  const nm=name(current.nome).length>=5 && name(current.nome)===name(candidate.nome);
  const dm=!!date(current.data_nascimento) && date(current.data_nascimento)===date(candidate.data_nascimento);
  const third=!!current.atendimento_para_terceiro || !!candidate.atendimento_para_terceiro;

  // Em atendimento para terceiro, telefone e CPF podem pertencer ao pagador.
  // Por isso nenhum deles vincula histórico sem nome ou nascimento do paciente.
  const strong = third
    ? ((nm && (dm || pm || cm)) || (dm && pm))
    : ((cm && (nm || dm || pm)) || (pm && nm) || (pm && dm) || (nm && dm));

  return {phoneMatch:pm,cpfMatch:cm,nameMatch:nm,dobMatch:dm,strong,score:(cm?4:0)+(nm?2:0)+(dm?2:0)+(pm?1:0),thirdPartyRule:third};
}

async function currentAllowed(id,medico){
  const {rows}=await pool.query('SELECT * FROM fila_atendimentos WHERE id=$1 LIMIT 1',[id]);
  const at=rows[0];
  if(!at)return null;
  if(isAdmin(medico)||Number(at.medico_id||0)===Number(medico.id))return at;
  return null;
}

function resumo(row){
  const a=[]; if(row.queixa)a.push(String(row.queixa).trim()); if(row.solicita)a.push('Solicita: '+String(row.solicita).trim());
  return a.join(' · ').slice(0,700);
}

function install(app){
  if(app.locals.__medicoPacienteContextoSafeInstalled)return;
  app.locals.__medicoPacienteContextoSafeInstalled=true;

  app.get('/api/medico/paciente-contexto/:atendimentoId',authMedico,async(req,res)=>{
    try{
      const id=Number(req.params.atendimentoId);
      if(!id)return res.status(400).json({ok:false,error:'Atendimento inválido'});
      const current=await currentAllowed(id,req.medico);
      if(!current)return res.status(403).json({ok:false,error:'Atendimento não autorizado'});

      const p=phone(current.tel), c=cpf(current.cpf), d=date(current.data_nascimento);
      const {rows:candidates}=await pool.query(`
        SELECT id,nome,tel,cpf,data_nascimento,tipo,status,queixa,solicita,triagem,prontuario,
               medico_id,medico_nome,documentos_emitidos,criado_em,assumido_em,encerrado_em,
               atendimento_para_terceiro,pagador_nome,pagador_cpf
          FROM fila_atendimentos
         WHERE id<>$1 AND COALESCE(LOWER(status),'')<>'cancelado'
           AND criado_em>=NOW()-INTERVAL '10 years'
           AND (($2<>'' AND RIGHT(regexp_replace(COALESCE(tel,''),'\\D','','g'),11)=$2)
             OR ($3<>'' AND regexp_replace(COALESCE(cpf,''),'\\D','','g')=$3)
             OR ($4<>'' AND LEFT(COALESCE(data_nascimento::text,''),10)=$4))
         ORDER BY COALESCE(encerrado_em,assumido_em,criado_em) DESC LIMIT 120`,[id,p,c,d]);

      const historico=[]; let samePhoneUnlinked=0;
      for(const row of candidates){
        const s=signals(current,row);
        if(s.strong)historico.push({...row,identidade:s,resumo:resumo(row)});
        else if(s.phoneMatch)samePhoneUnlinked++;
      }
      const ids=historico.map(r=>Number(r.id)).filter(Boolean);
      let documentos=[],eventos=[],espelhos=[];
      if(ids.length){
        const dr=await pool.query(`SELECT id,atendimento_id,arquivo_url,arquivo_tipo,arquivo_nome,criado_em FROM mensagens WHERE atendimento_id=ANY($1::bigint[]) AND arquivo_url IS NOT NULL AND LOWER(COALESCE(arquivo_tipo,''))='pdf' ORDER BY criado_em DESC`,[ids]); documentos=dr.rows;
        try{ const er=await pool.query(`SELECT id,atendimento_id,medico_id,tipo,titulo,conteudo,origem_id,metadata,criado_em FROM prontuario_eventos WHERE atendimento_id=ANY($1::bigint[]) ORDER BY criado_em DESC`,[ids]); eventos=er.rows; }catch{}
        try{ const mr=await pool.query(`SELECT atendimento_id,medico_id,conteudo,atualizado_em FROM prontuario_registros WHERE atendimento_id=ANY($1::bigint[])`,[ids]); espelhos=mr.rows; }catch{}
      }
      let atualEspelho=null, atualEventos=[];
      try{ const r=await pool.query('SELECT conteudo,atualizado_em FROM prontuario_registros WHERE atendimento_id=$1 LIMIT 1',[id]); atualEspelho=r.rows[0]||null; }catch{}
      try{ const r=await pool.query('SELECT id,tipo,titulo,conteudo,origem_id,metadata,criado_em FROM prontuario_eventos WHERE atendimento_id=$1 ORDER BY criado_em DESC',[id]); atualEventos=r.rows; }catch{}

      return res.json({ok:true,paciente:{
        atendimento_id:current.id,nome:current.nome||'',cpf:current.cpf||'',tel:current.tel||'',tel_documentos:current.tel_documentos||'',data_nascimento:current.data_nascimento||'',
        atendimento_para_terceiro:!!current.atendimento_para_terceiro,pagador_nome:current.pagador_nome||'',pagador_cpf:current.pagador_cpf||'',triagem:current.triagem||'',queixa:current.queixa||'',solicita:current.solicita||'',alergias:current.alergias||'',cronicas:current.cronicas||'',medicacoes:current.medicacoes||'',idade:current.idade||'',sexo:current.sexo||''
      },historico:historico.slice(0,40),documentos,eventos,prontuarios_espelho:espelhos,atual:{prontuario_espelho:atualEspelho,eventos:atualEventos},telefone_compartilhado_nao_vinculado:samePhoneUnlinked});
    }catch(error){ console.error('[PACIENTE-CONTEXTO-SAFE]',error); return res.status(500).json({ok:false,error:'Não foi possível carregar o histórico do paciente'}); }
  });
}

const originalInit=express.application.init;
express.application.init=function patchedInit(...args){ const result=originalInit.apply(this,args); install(this); return result; };
