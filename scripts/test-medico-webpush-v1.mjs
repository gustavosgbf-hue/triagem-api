/* Garantias estáticas do módulo existente de web push. Não acessa banco e não envia push. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
const src=fs.readFileSync(new URL('../web-push-preload.js',import.meta.url),'utf8');
test('JWT diferencia médico de paciente e especialista',()=>{
 assert.match(src,/decoded\?\.tipo \|\| !decoded\?\.email/);
 assert.match(src,/hasOwnProperty\.call\(decoded, 'crm'\)/);
 assert.match(src,/FROM medicos WHERE id=\$1 AND ativo=TRUE AND lower\(email\)=lower\(\$2\)/);
});
test('preferências médicas persistem atomica e individualmente',()=>{
 assert.match(src,/post\('\/api\/web-push\/medico\/preferencias'/);
 assert.match(src,/post\('\/api\/web-push\/medico\/estado'/);
 assert.match(src,/ON CONFLICT\(endpoint\) DO UPDATE SET[\s\S]*?medico_avisar_mensagens=EXCLUDED/);
 assert.match(src,/WHERE endpoint=\$1 AND medico_id=\$2 AND papel='medico'/);
});
test('não inscreve sem consentimento por padrão',()=>{
 assert.match(src,/medico_avisar_mensagens BOOLEAN NOT NULL DEFAULT FALSE/);
 assert.match(src,/medico_avisar_fila BOOLEAN NOT NULL DEFAULT FALSE/);
 assert.match(src,/s\.ativo=TRUE AND s\.medico_avisar_mensagens=TRUE/);
 assert.match(src,/s\.ativo=TRUE AND s\.medico_avisar_fila=TRUE/);
});
test('novos pacientes: só elegíveis e uma entrega por assinatura',()=>{
 assert.match(src,/PRIMARY KEY \(atendimento_id,subscription_id\)/);
 assert.match(src,/INSERT INTO web_push_medico_fila_entregas/);
 assert.match(src,/ON CONFLICT DO NOTHING RETURNING atendimento_id/);
 assert.match(src,/f\.status='aguardando'/);
 assert.match(src,/f\.pagamento_status IN \('confirmado','isento_admin'\)/);
 assert.match(src,/COALESCE\(f\.categoria_atendimento,'clinico'\) <> 'especialista_imediato'/);
});
test('pushs médicos não incluem texto de triagem ou mensagem clínica',()=>{
 const begin=src.indexOf('async function processarMensagensParaMedicoWeb');
 const end=src.indexOf('async function runChatWorker',begin);
 const portion=src.slice(begin,end);
 assert.doesNotMatch(portion,/m\.texto\b|f\.triagem\s+AS|m\.arquivo_url\b/);
 assert.match(portion,/Nova mensagem do paciente/);
 assert.match(portion,/Novo paciente na fila/);
 assert.match(portion,/JOIN medicos dr ON dr.id=s.medico_id AND dr.ativo=TRUE/);
});
