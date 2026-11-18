import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const file=fs.readFileSync(new URL('../mobile-push-preload.js',import.meta.url),'utf8');
const from=file.indexOf('async function campanhaConsultaApp1811()');
const to=file.indexOf('setInterval(campanhaConsultaApp1811',from);
const code=file.slice(from,to);
test('a campanha nunca envia sem consentimento promocional do titular',()=>{
 assert.match(code,/JOIN paciente_push_marketing m\s+ON m\.paciente_id=t\.paciente_id AND m\.autorizado=TRUE/);
 assert.match(code,/JOIN paciente_push_marketing m\s+ON m\.paciente_id=t\.paciente_id AND m\.autorizado=TRUE/g);
 assert.match(code,/WHERE t\.id=\$2 AND t\.ativo=TRUE/);
});
test('campanha única possui idempotência e janela delimitada',()=>{
 assert.match(code,/convite-consulta-app-2026-11-18/);
 assert.match(code,/NOT EXISTS\(SELECT 1 FROM push_marketing_entregas/);
 assert.match(code,/ON CONFLICT DO NOTHING RETURNING token_id/);
 assert.match(code,/2026-11-19T03:00:00Z/);
});
test('texto explícito de convite e deep-link do app',()=>{
 assert.match(code,/Precisa falar com um médico/);
 assert.match(code,/R\$ 49,90/);
 assert.match(code,/destination:'consulta'/);
});
