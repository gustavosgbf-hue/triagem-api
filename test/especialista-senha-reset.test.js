import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gerarTokenReset, hashTokenReset, formatoTokenValido, normalizarEmail, validarNovaSenha,
  criarLimitadorJanela, tokenSessaoRevogado, registrarRotasRecuperacaoEspecialista,
  MSG_GENERICA_ESQUECI, htmlPaginaRedefinir, RESET_MAX_TENTATIVAS_TOKEN,
} from '../especialista-senha-reset.js';

// Banco falso: uma tabela "especialistas" em memória que entende só as queries do módulo.
function criarBanco(contas) {
  const queries = [];
  const pool = {
    async query(sql, params = []) {
      queries.push({ sql, params });
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
        Object.assign(c, { senha: novo, reset_hash: null, expira: null, alterada: agora });
        return { rows: [{ id: c.id }] };
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
  const banco = criarBanco(contas);
  registrarRotasRecuperacaoEspecialista(app, {
    pool: banco.pool,
    hashSenha: async s => 'hash:' + s,
    enviarEmail: async m => { emails.push(m); },
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
  return { rotas, emails, banco, chamar };
}

const tokenDoEmail = (m) => /#token=([A-Za-z0-9_-]{43})/.exec(m.html)[1];

test('token: 32 bytes base64url, hash sha256 e formato estrito', () => {
  const t = gerarTokenReset();
  assert.ok(formatoTokenValido(t));
  assert.notEqual(gerarTokenReset(), t);
  assert.match(hashTokenReset(t), /^[0-9a-f]{64}$/);
  assert.equal(formatoTokenValido('abc'), false);
  assert.equal(formatoTokenValido(t + '!'), false);
  assert.equal(formatoTokenValido({}), false);
});

test('normalização de e-mail e validação de senha', () => {
  assert.equal(normalizarEmail('  Dra@Ex.COM '), 'dra@ex.com');
  assert.equal(normalizarEmail('sem-arroba'), '');
  assert.equal(normalizarEmail(['a@b.c']), '');
  assert.equal(validarNovaSenha('12345678', '12345678').ok, true);
  assert.equal(validarNovaSenha('1234567', '1234567').ok, false);
  assert.equal(validarNovaSenha('12345678', '12345679').ok, false);
  assert.equal(validarNovaSenha('x'.repeat(129), 'x'.repeat(129)).ok, false);
});

test('limitador por janela', () => {
  let t = 0;
  const l = criarLimitadorJanela({ max: 2, janelaMs: 1000, agora: () => t });
  assert.ok(l.permitir('a')); assert.ok(l.permitir('a')); assert.equal(l.permitir('a'), false);
  assert.ok(l.permitir('b'));
  t = 1500; assert.ok(l.permitir('a'));
});

test('sessão emitida antes da redefinição é revogada', () => {
  const alterada = new Date('2026-11-20T12:00:10Z');
  assert.equal(tokenSessaoRevogado(Date.parse('2026-11-20T11:00:00Z') / 1000, alterada), true);
  assert.equal(tokenSessaoRevogado(Date.parse('2026-11-20T12:00:09Z') / 1000, alterada), false); // tolerância
  assert.equal(tokenSessaoRevogado(Date.parse('2026-11-20T12:05:00Z') / 1000, alterada), false);
  assert.equal(tokenSessaoRevogado(123, null), false);
});

test('esqueci-senha: resposta idêntica com ou sem conta e NÃO altera a senha', async () => {
  const contas = [{ id: 7, email: 'dra@ex.com', nome: 'Dra', ativo: true, senha: 'antiga' }];
  const { chamar, emails } = montar(contas);
  const r1 = await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'DRA@ex.com' } });
  const r2 = await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'ninguem@ex.com' } });
  const r3 = await chamar('POST /api/especialista/esqueci-senha', { body: {} });
  for (const r of [r1, r2, r3]) { assert.equal(r.status, 200); assert.deepEqual(r.body, MSG_GENERICA_ESQUECI); }
  assert.equal(contas[0].senha, 'antiga');
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, 'dra@ex.com');
  const token = tokenDoEmail(emails[0]);
  assert.equal(contas[0].reset_hash, hashTokenReset(token)); // banco guarda só o hash
  assert.ok(!JSON.stringify(contas).includes(token));
  assert.ok(emails[0].html.startsWith('<div') && emails[0].html.includes('https://api.exemplo/especialista/redefinir-senha#token='));
});

test('esqueci-senha: cooldown por conta e limite por e-mail', async () => {
  const contas = [{ id: 7, email: 'dra@ex.com', nome: 'Dra', ativo: true, senha: 'antiga' }];
  const { chamar, emails } = montar(contas);
  for (let i = 0; i < 6; i++) await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'dra@ex.com' } });
  assert.equal(emails.length, 1);
});

test('esqueci-senha: conta inativa não recebe link', async () => {
  const contas = [{ id: 2, email: 'x@ex.com', nome: 'X', ativo: false, senha: 'antiga' }];
  const { chamar, emails } = montar(contas);
  await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'x@ex.com' } });
  assert.equal(emails.length, 0);
});

test('redefinir-senha: token de uso único troca a senha uma vez só', async () => {
  const contas = [{ id: 7, email: 'dra@ex.com', nome: 'Dra', ativo: true, senha: 'antiga' }];
  const { chamar, emails } = montar(contas);
  await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'dra@ex.com' } });
  const token = tokenDoEmail(emails[0]);
  const ok = await chamar('POST /api/especialista/redefinir-senha', { body: { token, novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.equal(ok.status, 200); assert.equal(ok.body.ok, true);
  assert.equal(contas[0].senha, 'hash:novaSenha1');
  assert.ok(contas[0].alterada);
  const de_novo = await chamar('POST /api/especialista/redefinir-senha', { body: { token, novaSenha: 'outraSenha2', confirmarSenha: 'outraSenha2' } });
  assert.equal(de_novo.status, 400); assert.equal(de_novo.body.tokenInvalido, true);
  assert.equal(contas[0].senha, 'hash:novaSenha1');
});

test('redefinir-senha: token expirado, inventado ou malformado é recusado', async () => {
  const contas = [{ id: 7, email: 'dra@ex.com', nome: 'Dra', ativo: true, senha: 'antiga' }];
  const { chamar, emails } = montar(contas);
  await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'dra@ex.com' } });
  const token = tokenDoEmail(emails[0]);
  contas[0].expira = Date.now() - 1;
  const exp = await chamar('POST /api/especialista/redefinir-senha', { body: { token, novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.equal(exp.status, 400);
  const inv = await chamar('POST /api/especialista/redefinir-senha', { body: { token: gerarTokenReset(), novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.equal(inv.status, 400);
  const mal = await chamar('POST /api/especialista/redefinir-senha', { body: { token: { $ne: null }, novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.equal(mal.status, 400);
  assert.equal(contas[0].senha, 'antiga');
});

test('redefinir-senha: erros repetidos com token real o invalidam', async () => {
  const contas = [{ id: 7, email: 'dra@ex.com', nome: 'Dra', ativo: true, senha: 'antiga' }];
  const { chamar, emails } = montar(contas, { limitadorRedefinir: { permitir: () => true } });
  await chamar('POST /api/especialista/esqueci-senha', { body: { email: 'dra@ex.com' } });
  const token = tokenDoEmail(emails[0]);
  for (let i = 0; i < RESET_MAX_TENTATIVAS_TOKEN; i++) {
    await chamar('POST /api/especialista/redefinir-senha', { body: { token, novaSenha: 'curta', confirmarSenha: 'curta' } });
  }
  const r = await chamar('POST /api/especialista/redefinir-senha', { body: { token, novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  assert.equal(r.status, 400); assert.equal(r.body.tokenInvalido, true);
  assert.equal(contas[0].senha, 'antiga');
});

test('redefinir-senha: limite de tentativas por IP', async () => {
  const { chamar } = montar([]);
  let ultimo;
  for (let i = 0; i < 11; i++) {
    ultimo = await chamar('POST /api/especialista/redefinir-senha', { body: { token: gerarTokenReset(), novaSenha: 'novaSenha1', confirmarSenha: 'novaSenha1' } });
  }
  assert.equal(ultimo.status, 429);
});

test('página de redefinição: token só no fragmento, CSP e sem recursos externos', async () => {
  const { chamar } = montar([]);
  const r = await chamar('GET /especialista/redefinir-senha', {});
  assert.match(r.headers['Content-Security-Policy'], /default-src 'none'/);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.ok(!/<script[^>]+src=|<link[^>]+href=/i.test(r.body));
  assert.ok(r.body.includes('location.hash'));
  const html = htmlPaginaRedefinir({ painelUrl: '"><script>x</script>' });
  assert.ok(!html.includes('"><script>x</script>'));
});
