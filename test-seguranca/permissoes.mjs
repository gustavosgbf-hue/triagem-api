// Testes de permissão com dados fictícios contra servidores locais.
import jwt from 'jsonwebtoken';
const S = 'segredo-de-teste-ficticio';
const t = (p, exp = '1h') => jwt.sign(p, S, { expiresIn: exp });
const TK = {
  semToken: null,
  paciente7: t({ id: 7, tipo: 'paciente' }),
  paciente1: t({ id: 1, tipo: 'paciente' }),
  psicologo1: t({ id: 1, tipo: 'psicologo' }),
  especialista7: t({ id: 7, tipo: 'especialista', email: 'esp@exemplo.invalid' }),
  linkAssumir: t({ medicoId: 7, atendimentoId: 101, tipo: 'assumir' }),
  medicoInativo9: t({ id: 9, nome: 'x', email: 'inativo@exemplo.invalid', crm: '00009-XX' }),
  medico7: t({ id: 7, nome: 'Dra. Teste Fictícia', email: 'medica.teste@exemplo.invalid', crm: '00007-XX' }),
  medico8: t({ id: 8, nome: 'Dr. Outro Fictício', email: 'outro.medico@exemplo.invalid', crm: '00008-XX' }),
  admin1: t({ id: 1, nome: 'Admin', email: 'gustavosgbf@gmail.com', crm: '00001-XX' }),
};
const casos = [
  ['GET', '/api/fila', null, ['semToken', 'paciente7', 'psicologo1', 'especialista7', 'linkAssumir', 'medicoInativo9', 'medico7']],
  ['GET', '/api/pacientes/busca?q=Fic', null, ['paciente7', 'medico7']],
  ['GET', '/api/historico', null, ['paciente7', 'medico7']],
  ['GET', '/api/medico/ganhos', null, ['paciente7', 'medico7']],
  ['GET', '/api/renovacoes/fila', null, ['paciente1', 'admin1']],
  ['POST', '/api/plantao/entrar', {}, ['paciente7', 'medico7']],
  ['GET', '/api/memed/token', null, ['paciente7', 'psicologo1']],
  ['GET', '/api/admin/avaliacoes-medicos', null, ['paciente1', 'psicologo1', 'admin1']],
  ['POST', '/api/chat/enviar', { atendimentoId: 102, autor: 'medico', texto: 'teste fictício' }, ['paciente7', 'psicologo1', 'medico8', 'medico7']],
  ['POST', '/api/atendimento/meet', { filaId: 102, meetLink: 'https://meet.google.com/aaa-bbbb-ccc' }, ['semToken', 'paciente7', 'medico8', 'medico7']],
  ['POST', '/api/atendimento/encerrar', { filaId: 103, status: 'teste' }, ['semToken', 'paciente7', 'medico7', 'medico8']],
  ['POST', '/api/atendimento/assumir', { filaId: 101 }, ['paciente7', 'especialista7', 'medico7']],
];
const base = process.argv[2];
const out = [];
for (const [m, path, body, quem] of casos) {
  for (const q of quem) {
    const h = { 'Content-Type': 'application/json', Origin: 'https://painel.consultaja24h.com.br' };
    if (TK[q]) h.Authorization = 'Bearer ' + TK[q];
    const r = await fetch(base + path, { method: m, headers: h, body: body ? JSON.stringify(body) : undefined });
    let txt = await r.text();
    let resumo = '';
    try { const j = JSON.parse(txt); resumo = j.ok === false ? (j.error || '') : (Array.isArray(j.fila) ? `fila=${j.fila.length}` : (j.atendimento ? 'atendimento' : Object.keys(j).slice(0, 4).join(','))); } catch { resumo = txt.slice(0, 40); }
    out.push(`${m} ${path.split('?')[0].padEnd(30)} ${q.padEnd(15)} ${r.status} ${resumo.slice(0, 60)}`);
  }
}
console.log(out.join('\n'));
