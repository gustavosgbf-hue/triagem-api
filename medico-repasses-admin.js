// Gestão de repasses de consultas. Nenhuma transferência bancária é executada.
// Escopo: consulta e registro administrativo manual de quinzena encerrada.
import { GANHOS_INICIO_ISO, GANHOS_INICIO_DATA, SQL_GANHOS_MEDICO,
  montarResumoGanhos, classificarFaixaMedico, valorPorAtendimentoCentavos,
  classificarAtendimentoGanhos, quinzenaDe, dataIsoNoFuso } from './medico-ganhos.js';

const RE_Q = /^(20\d{2})-(0[1-9]|1[0-2])-Q([12])$/;
const GESTOR = 'gustavosgbf@gmail.com';
const toISO = d => d.toISOString().slice(0,10);
const ultimoDia = (a,m) => new Date(Date.UTC(a,m,0)).getUTCDate();
function competencia(id) {
  const m=RE_Q.exec(String(id||''));
  if(!m) return null;
  const a=Number(m[1]),mes=Number(m[2]),sem=Number(m[3]);
  const inicio=`${m[1]}-${m[2]}-${sem===1?'01':'16'}`;
  const fim=`${m[1]}-${m[2]}-${sem===1?'15':String(ultimoDia(a,mes)).padStart(2,'0')}`;
  return {id,inicio,fim};
}
// Feriados nacionais federais fixos. Os móveis e feriados locais precisam de
// calendário financeiro validado: datas exibidas como estimativas, nunca garantia.
function feriadoFixo(d) {
  return ['01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25'].includes(d.slice(5));
}
export function proximoDiaUtilEstimado(fim) {
  const d=new Date(fim+'T12:00:00Z');
  for(let n=0;n<12;n++) {
    d.setUTCDate(d.getUTCDate()+1);
    const iso=toISO(d), dia=d.getUTCDay();
    if(dia!==0&&dia!==6&&!feriadoFixo(iso))
      return {data:iso,provisorio:true,observacao:'Sujeito à conferência de feriados móveis e locais'};
  }
  return {data:null,provisorio:true};
}
async function garantirTabela(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS medico_repasses_registros (
    id BIGSERIAL PRIMARY KEY,
    medico_id INTEGER NOT NULL,
    periodo TEXT NOT NULL,
    valor_centavos INTEGER NOT NULL CHECK (valor_centavos>0),
    atendimentos INTEGER NOT NULL CHECK (atendimentos>0),
    pago_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    registrado_por INTEGER NOT NULL,
    observacao TEXT,
    CONSTRAINT repasse_unico_medico_periodo UNIQUE(medico_id,periodo)
  )`);
}
async function autenticarAdmin(req,res,pool) {
  const token=req.medico||{};
  if(token.tipo||!Number.isInteger(Number(token.id))||!token.email||token.email.toLowerCase()!==GESTOR) {
    res.status(403).json({ok:false,error:'Acesso restrito'}); return false;
  }
  const {rows}=await pool.query('SELECT email,ativo FROM medicos WHERE id=$1',[token.id]);
  if(rows[0]?.email?.toLowerCase()!==GESTOR||rows[0]?.ativo!==true) {
    res.status(403).json({ok:false,error:'Acesso restrito'}); return false;
  }
  return true;
}
async function calcularPeriodo(pool,periodo,adminEmail) {
  const medicos=(await pool.query('SELECT id,nome,nome_exibicao,email FROM medicos WHERE ativo=true ORDER BY nome')).rows;
  const q=`SELECT f.medico_id, to_char((f.encerrado_em::timestamptz AT TIME ZONE 'America/Fortaleza'),'YYYY-MM-DD') dia,
    f.tipo,f.pagamento_status,f.status_atendimento,f.categoria_atendimento,f.especialidade_solicitada,
    f.valor_cobrado_centavos,f.reembolso_status,f.reembolso_valor_centavos
    FROM fila_atendimentos f WHERE f.status='encerrado' AND f.encerrado_em IS NOT NULL
    AND f.encerrado_em::timestamptz >= $1::timestamptz
    AND f.tipo NOT LIKE 'renovacao%'`;
  const rows=(await pool.query(q,[GANHOS_INICIO_ISO])).rows;
  const comp=competencia(periodo);
  return medicos.filter(m=>m.email?.toLowerCase()!==GESTOR).map(m=>{
    const validos=rows.filter(r=>r.medico_id===m.id && competencia(quinzenaDe(r.dia).id)?.id===periodo && classificarAtendimentoGanhos(r).elegivel);
    return {medico_id:m.id,nome:m.nome_exibicao||m.nome,atendimentos:validos.length,valor_centavos:validos.length*valorPorAtendimentoCentavos(classificarFaixaMedico(m,adminEmail))};
  }).filter(m=>m.atendimentos>0);
}
export function registrarRotasRepasses(app,{pool,checkMedico,adminEmail=GESTOR}) {
  app.get('/api/admin/medicos/repasses',checkMedico,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      if(!await autenticarAdmin(req,res,pool)) return;
      const id=String(req.query.periodo||quinzenaDe(dataIsoNoFuso()).id),comp=competencia(id);
      if(!comp||comp.inicio<GANHOS_INICIO_DATA) return res.status(400).json({ok:false,error:'Período inválido'});
      await garantirTabela(pool);
      const valores=await calcularPeriodo(pool,id,adminEmail);
      const pagos=(await pool.query('SELECT medico_id,valor_centavos,atendimentos,pago_em FROM medico_repasses_registros WHERE periodo=$1',[id])).rows;
      const pagoMap=new Map(pagos.map(p=>[Number(p.medico_id),p]));
      const fechamentoConcluido=dataIsoNoFuso()>comp.fim;
      return res.json({ok:true,periodo:id,inicio:comp.inicio,fim:comp.fim,fechado:fechamentoConcluido,
        previsao:proximoDiaUtilEstimado(comp.fim),medicos:valores.map(v=>{
          const pago=pagoMap.get(v.medico_id);
          return {...v,registrado_pago:!!pago,pago_em:pago?.pago_em||null,
            divergencia:!!pago&&(Number(pago.valor_centavos)!==v.valor_centavos||Number(pago.atendimentos)!==v.atendimentos),
            valor_registrado_centavos:pago?Number(pago.valor_centavos):null};
        })});
    }catch(e){console.error('[REPASSES ADMIN]',e.message);res.status(500).json({ok:false,error:'Não foi possível consultar os repasses'});}
  });
  app.post('/api/admin/medicos/repasses/confirmar',checkMedico,async(req,res)=>{
    res.set('Cache-Control','no-store');
    try {
      if(!await autenticarAdmin(req,res,pool)) return;
      const comp=competencia(req.body?.periodo),medicoId=Number(req.body?.medico_id);
      if(!comp||comp.inicio<GANHOS_INICIO_DATA||!Number.isSafeInteger(medicoId)||medicoId<=0)
        return res.status(400).json({ok:false,error:'Dados inválidos'});
      if(dataIsoNoFuso()<=comp.fim) return res.status(409).json({ok:false,error:'A quinzena ainda não foi encerrada'});
      await garantirTabela(pool);
      const conn=await pool.connect();
      try{
        await conn.query('BEGIN');
        // Serializa lançamentos concorrentes para mesmo médico + período.
        await conn.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`repasse:${comp.id}:${medicoId}`]);
        const existente=(await conn.query('SELECT * FROM medico_repasses_registros WHERE medico_id=$1 AND periodo=$2',[medicoId,comp.id])).rows[0];
        if(existente){await conn.query('COMMIT');return res.json({ok:true,ja_registrado:true,valor_centavos:existente.valor_centavos});}
        const valores=await calcularPeriodo(conn,comp.id,adminEmail);
        const v=valores.find(a=>a.medico_id===medicoId);
        if(!v||v.valor_centavos<=0) {await conn.query('ROLLBACK');return res.status(409).json({ok:false,error:'Nenhum valor elegível'});}
        if(Number(req.body?.valor_confirmado_centavos)!==v.valor_centavos){
          await conn.query('ROLLBACK');return res.status(409).json({ok:false,error:'O valor mudou. Atualize a lista antes de registrar.'});
        }
        await conn.query('INSERT INTO medico_repasses_registros (medico_id,periodo,valor_centavos,atendimentos,registrado_por) VALUES($1,$2,$3,$4,$5)',
          [medicoId,comp.id,v.valor_centavos,v.atendimentos,req.medico.id]);
        await conn.query('COMMIT');return res.json({ok:true,registrado_pago:true,valor_centavos:v.valor_centavos});
      }catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e;}finally{conn.release();}
    }catch(e){console.error('[REPASSES REGISTRO]',e.message);res.status(500).json({ok:false,error:'Não foi possível registrar o repasse'});}
  });
}
