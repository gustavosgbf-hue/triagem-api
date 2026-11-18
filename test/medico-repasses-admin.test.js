import test from 'node:test';
import assert from 'node:assert/strict';
import {preverDiaUtilRepasse} from '../medico-ganhos.js';
import {registrarRotasRepasses} from '../medico-repasses-admin.js';

test('fechamento no ultimo dia de novembro: 1 dezembro dia util',()=>{
 assert.equal(preverDiaUtilRepasse('2026-11-30').data,'2026-12-01');
});
test('fechamento no domingo/feriado passa para dia util seguinte',()=>{
 assert.equal(preverDiaUtilRepasse('2026-11-15').data,'2026-11-16');
 assert.equal(preverDiaUtilRepasse('2026-12-31').data,'2027-01-04');
});
test('carnaval de 2027 nao conta como dia bancario',()=>{
 assert.equal(preverDiaUtilRepasse('2026-02-15').data,'2026-02-19');
});
test('acesso admin nao aceita token de usuario medico comum',async()=>{
 const rotas={};
 const app={get:(path,_auth,handler)=>{rotas['GET '+path]=handler;},
   post:(path,_auth,handler)=>{rotas['POST '+path]=handler;}};
 const pool={query:async()=>{throw Error('Nenhuma leitura deveria ocorrer')},connect:async()=>{throw Error('Nenhuma escrita deveria ocorrer')}};
 registrarRotasRepasses(app,{pool,checkMedico:()=>{},adminEmail:'gustavosgbf@gmail.com'});
 for(const [method,path] of [['GET','/api/admin/medicos/repasses'],['POST','/api/admin/medicos/repasses/confirmar']]){
  const out={status:null,body:null};
  const res={set:()=>{},status(x){out.status=x;return this},json(x){out.body=x;return this}};
  await rotas[method+' '+path]({medico:{id:99,email:'outro@email.com'},query:{},body:{}},res);
  assert.equal(out.status,403);
  assert.equal(out.body.ok,false);
 }
});
