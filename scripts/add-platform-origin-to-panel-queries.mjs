import fs from 'node:fs';

const path = 'server.js';
let s = fs.readFileSync(path, 'utf8');

const replacements = [
  [
    '`SELECT id, nome, tel, tel_documentos, cpf, tipo, triagem, status,\n              status_atendimento, documentos_emitidos, medico_nome,',
    '`SELECT id, origem_plataforma, nome, tel, tel_documentos, cpf, tipo, triagem, status,\n              status_atendimento, documentos_emitidos, medico_nome,'
  ],
  [
    '`SELECT id,nome,tel,tel_documentos,cpf,email,tipo,triagem,queixa,status,pagamento_status,',
    '`SELECT id,origem_plataforma,nome,tel,tel_documentos,cpf,email,tipo,triagem,queixa,status,pagamento_status,'
  ],
  [
    '`SELECT id,nome,tel,cpf,email,tipo,status,pagamento_status,triagem,queixa,',
    '`SELECT id,origem_plataforma,nome,tel,cpf,email,tipo,status,pagamento_status,triagem,queixa,'
  ],
];

let changed = 0;
for (const [from, to] of replacements) {
  if (s.includes(to)) continue;
  if (!s.includes(from)) {
    throw new Error(`Expected query marker not found: ${from.slice(0, 90)}`);
  }
  s = s.replace(from, to);
  changed++;
}

fs.writeFileSync(path, s);
console.log(`[platform-origin-panel] ${changed} query marker(s) updated`);
