import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const code=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const start=code.indexOf('// Disparador administrativo de push do aplicativo.');
const end=code.indexOf('// Importação programada de conversões offline',start);
const section=code.slice(start,end);
test('endpoints usam autenticação de administrador',()=>{
  for(const method of ['get','post'])assert.match(section,new RegExp('app\\.'+method+'\\(\'/api/admin/push/[^\']+\', checkAdmin'));
});
test('recusa envio promocional para tokens sem opt-in',()=>{
  assert.match(section,/JOIN paciente_push_marketing m ON m.paciente_id=t.paciente_id AND m.autorizado=TRUE/);
  assert.match(section,/publico!=='marketing_autorizado'/);
});
test('campanha tem proteção contra duplicação e registro',()=>{
  assert.match(section,/id UUID PRIMARY KEY/);
  assert.match(section,/ON CONFLICT\(id\) DO NOTHING RETURNING id/);
  assert.match(section,/status='concluida'/);
});
test('Expo limita lotes a cem e rejeições são contabilizadas',()=>{
  assert.match(section,/i\+=100/);
  assert.match(section,/tickets\[j\]/);
  assert.match(section,/falhas\+\+/);
});
