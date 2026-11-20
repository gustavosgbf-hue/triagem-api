// Regressão: /api/medico/esqueci-senha NÃO pode sobrescrever a senha do médico.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  registrarRotasRecuperacaoMedico, registrarRotasRecuperacaoEspecialista, migracoesResetSenha,
  MIGRACOES_RESET_MEDICO, MSG_GENERICA_ESQUECI, PERFIL_RESET_MEDICO, criarRevogadorSessoes,
  RESET_MAX_TENTATIVAS_TOKEN, registrarRotasRecuperacaoSenha,
} from '../especialista-senha-reset.js';

// Banco falso da tabela "medicos": registra a tabela de cada query.
function criarBanco(contas) {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (/\bespecialistas\b/.test(sql)) throw new Error('query tocou especialistas: ' + sql);
      const agora = Date.now();
      if (/SET senha_reset_hash = \$2/.test(sql)) {
        const [email, hash, mins, cooldown] = params;
        const c = contas.filter(x => x.email.toLowerCase() === email && x.ativo).sort((a, b) => a.id - b.id)[0];
        if (!c) return { rows: [] };
        if (c.solicitado && c.solicitado > agora - cooldown * 1000) return { rows: [] };
        Object.assign(c, { reset_hash: hash, expira: agora + mins * 60000, solicitado: agora, tentativas: 0 });
        return { rows: [{ id: c.id, nome: c.nome, nome_exibicao: c.nome, email: c.email }] };
      }
      if (/senha_reset_tentativas = senha_reset_tentativas \+ 1/.test(sql)) {
        const [hash, max] = params;
        const c = contas.find(x => x.reset_hash === hash && x.expira > agora);
        if (!c) return { rows: [] };
        c.tentativas += 1;
        if (c.tentativas >= max) c.reset_hash = null;
        return { rows: [{ esgotado: c.reset_hash === null }] };
      }
      if (/SET senha_hash = \$2/.test(sql)) {
        const [hash, novo] = params;
        const c = contas.find(x => x.reset_hash === hash && x.expira > agora && x.ativo);
        if (!c) return { rows: [] };
        Object.assign(c, { senha: novo, reset_hash: null, expira: null, alterada: new Date(agora) });
        return { rows: [{ id: c.id, senha_alterada_em: c.alterada }] };
      }
      if (/SET senha_reset_hash = NULL/.test(sql)) {
        const c = contas.find(x => x.id === params[0]); if (c) c.reset_hash = null;
        return { rows: [] };
      }
      throw new Error('query inesperada: ' + sql);
    },
  };
  return { pool, queries };
}

function montar(contas, extra = {}) {
  const rotas = {};
  const app = {
    post: (p, _rl, h) => { rotas['POST ' + p] = h; },
    get: (p, h) => { rotas['GET ' + p] = h; },
  };
  const emails = [];
  const redefinidos = [];
  const banco = criarBanco(contas);
  registrarRotasRecuperacaoMedico(app, {
    pool: banco.pool,
    hashSenha: async s => 'hash:' + s,
    enviarEmail: async m => { emails.push(m); },
    onSenhaRedefinida: x => redefinidos.push(x),
    log: { log() {}, error() {} },
    apiBaseUrl: 'https://api.exemplo',
    ...extra,
  });
  const chamar = async (chave, req) => {
    const out = { status: 200, body: null, headers: {} };
    const res = {
      set(h) { Object.assign(out.headers, typeof h === 'string' ? { [h]: arguments[1] } : h); return this; },
      status(x) { out.status = x; return this; },
      json(x) { out.body = x; return this; },
      type() { return this; },
      send(x) { out.body = x; return this; },
    };
    await rotas[chave]({ ip: '1.1.1.1', body: {}, query: {}, headers: {}, ...req }, res);
    return out;
  };
  return { rotas, emails, redefinidos, banco, chamar };
}

const tokenDoEmail = (m) => /#token=([A-Za-z0-9_-]{43})/.exec(m.html)[1];
const medico = () => ({ id: 7, nome: 'Dr. Teste', email: 'dr@ex.com', ativo: true, senha: 'hash:antiga' });

test('médico: rotas registradas nos caminhos do painel médico', () => {
  const { rotas } = montar([]);
  assert.deepEqual(Object.keys(rotas).sort(), [
    'GET /medico/redefinir-senha', 'POST /api/medico/esqueci-senha', 'POST /api/medico/redefinir-senha',
  ]);
});

test('médico esqueci-senha: resposta genérica idêntica e senha NÃO é alterada', async () => {
  const contas = [medico()];
  const { chamar, emails, banco } = montar(contas);
  const r1 = await chamar('POST /api/medico/esqueci-senha', { body: { email: 'DR@ex.com' } });
  const r2 = await chamar('POST /api/medico/esqueci-senha', { body: { email: 'ninguem@ex.com' } });
  const r3 = await chamar('POST /api/medico/esqueci-senha', { body: {} });
  for (const r of [r1, r2, r3]) { assert.equal(r.status, 200); assert.deepEqual(r.body, MSG_GENERICA_ESQUECI); }
  assert.equal(contas[0].senha, 'hash:antiga');
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'dr@ex.com');
  assert.ok(emails[0].html.includes('https://api.exemplo/medico/redefinir-senha#token='));
  assert.ok(emails[0].html.includes('Painel Médico'));
  // Nenhum SQL de esqueci-senha toca senha_hash; todos visam a tabela medicos.
  for (const q of banco.queries) {
    assert.ok(!/senha_hash/.test(q.sql), q.sql);
    assert.match(q.sql, /\bmedicos\b/);
  }
  // Só o hash do token vai ao banco.
  const token = tokenDoEmail(emails[0]);
  assert.ok(!banco.queries.some(q => q.params.includes(token)));
});

test('médico bloqueado não recebe link e o token gravado é descartado', async () => {
  const contas = [medico()];
  const { chamar, emails } = montar(contas, { medicoBloqueado: () => true });
  await chamar('POST /api/medico/esqueci-senha', { body: { email: 'dr@ex.com' } });
  assert.equal(emails.length, 0);
  assert.equal(contas[0].reset_hash, null);
});

test('médico redefinir-senha: uso único, sinaliza revogação de sessões', async () => {
  const contas = [medico()];
  const { chamar, emails, redefinidos } = montar(contas);
  await chamar('POST /api/medico/esqueci-senha', { body: { email: 'dr@ex.com' } });
  const token = tokenDoEmail(emails[0]);
  const ok = await chamar('POST /api/medico/redefinir-senha', { body: { token, novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.deepEqual(ok.body, { ok: true });
  assert.equal(contas[0].senha, 'hash:novaSenha1');
  assert.equal(redefinidos.length, 1);
  assert.equal(redefinidos[0].id, 7);
  const de_novo = await chamar('POST /api/medico/redefinir-senha', { body: { token, novaSenha: 'outraSenha2', confirmarSenha: 'outraSenha2' } });
  assert.equal(de_novo.status, 400);
  assert.equal(de_novo.body.tokenInvalido, true);
  assert.equal(contas[0].senha, 'hash:novaSenha1');
});

test('médico redefinir-senha: tentativas inválidas esgotam o token', async () => {
  const contas = [medico()];
  const { chamar, emails } = montar(contas);
  await chamar('POST /api/medico/esqueci-senha', { body: { email: 'dr@ex.com' } });
  const token = tokenDoEmail(emails[0]);
  for (let i = 0; i < RESET_MAX_TENTATIVAS_TOKEN; i++) {
    await chamar('POST /api/medico/redefinir-senha', { body: { token, novaSenha: 'a', confirmarSenha: 'b' } });
  }
  const r = await chamar('POST /api/medico/redefinir-senha', { body: { token, novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.equal(r.body.tokenInvalido, true);
  assert.equal(contas[0].senha, 'hash:antiga');
});

test('página do médico chama a API do médico', async () => {
  const { chamar } = montar([]);
  const r = await chamar('GET /medico/redefinir-senha', {});
  assert.ok(r.body.includes('"/api/medico/redefinir-senha"'));
  assert.ok(!r.body.includes('/api/especialista/'));
  assert.equal(r.headers['Cache-Control'], 'no-store');
});

test('migrações: tabela em whitelist, medicos ganha colunas de reset', () => {
  assert.ok(MIGRACOES_RESET_MEDICO.every(sql => /\bmedicos\b/.test(sql)));
  assert.ok(MIGRACOES_RESET_MEDICO.some(sql => /senha_alterada_em/.test(sql)));
  assert.throws(() => migracoesResetSenha('medicos; DROP TABLE x'));
  assert.throws(() => registrarRotasRecuperacaoSenha({ post() {}, get() {} }, {
    pool: {}, hashSenha() {}, enviarEmail() {}, perfil: { ...PERFIL_RESET_MEDICO, tabela: 'pacientes' },
  }));
});

test('especialista continua nos caminhos e tabela originais', () => {
  const rotas = [];
  registrarRotasRecuperacaoEspecialista({ post: p => rotas.push(p), get: p => rotas.push(p) }, {
    pool: {}, hashSenha() {}, enviarEmail() {},
  });
  assert.deepEqual(rotas.sort(), ['/api/especialista/esqueci-senha', '/api/especialista/redefinir-senha', '/especialista/redefinir-senha']);
});

test('revogador de sessões: JWT anterior à redefinição é recusado', () => {
  let agora = Date.parse('2026-11-20T12:00:00Z');
  const r = criarRevogadorSessoes({ agora: () => agora });
  r.registrar(7, new Date('2026-11-20T12:00:10Z'));
  assert.equal(r.revogado(7, Date.parse('2026-11-20T11:00:00Z') / 1000), true);
  assert.equal(r.revogado('7', Date.parse('2026-11-20T11:00:00Z') / 1000), true);
  assert.equal(r.revogado(7, Date.parse('2026-11-20T12:01:00Z') / 1000), false);
  assert.equal(r.revogado(8, Date.parse('2026-11-20T11:00:00Z') / 1000), false);
  // Registro mais antigo não retrocede o corte.
  r.registrar(7, new Date('2026-11-20T10:00:00Z'));
  assert.equal(r.revogado(7, Date.parse('2026-11-20T11:00:00Z') / 1000), true);
  r.registrar(9, 'lixo');
  assert.equal(r.tamanho, 1);
  agora += 10 * 3600 * 1000;
  r.limpar(9 * 3600 * 1000);
  assert.equal(r.tamanho, 0);
});

test('server.js: esqueci-senha do médico não gera senha temporária nem grava senha_hash', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  assert.ok(!/app\.post\(\s*["']\/api\/medico\/esqueci-senha/.test(src), 'handler legado ainda registrado');
  assert.ok(!/tempSenha/.test(src));
  assert.ok(!/UPDATE medicos SET senha_hash=\$1, precisa_trocar_senha=true/.test(src));
  assert.match(src, /registrarRotasRecuperacaoMedico\(app,/);
  // As três verificações de JWT de médico consultam o revogador.
  assert.equal((src.match(/revogacoesSessaoMedico\.revogado\(/g) || []).length, 3);
});
