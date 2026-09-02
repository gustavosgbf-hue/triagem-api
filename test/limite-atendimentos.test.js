import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the production rule without starting the server or connecting to a DB.
const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('const LIMITE_ATENDIMENTOS_JANELA_DIAS =');
const end = source.indexOf('async function buscarAtendimentoPagoAtivoPorIdentidade', start);
assert.ok(start >= 0 && end > start);

function rule(count, manual = null) {
  const calls = [];
  const context = vm.createContext({
    pool: {
      async query(sql, params) {
        calls.push({ sql, params: Array.from(params) });
        if (sql.includes('paciente_bloqueios')) return { rows: manual ? [manual] : [] };
        return { rows: [{ quantidade: count, liberado_em: '2026-09-07T12:00:00Z' }] };
      },
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return { context, calls };
}

for (const previous of [0, 1, 2]) {
  test(`allows consultation ${previous + 1} with ${previous} previous payments`, async () => {
    const { context, calls } = rule(previous);
    assert.equal(await context.buscarLimiteAtendimentos(100), null);
    assert.deepEqual(calls[1].params, [100, 5]);
    assert.match(calls[1].sql, /pagamento_status = 'confirmado'/);
  });
}

for (const previous of [3, 4]) {
  test(`blocks with ${previous} previous payments and reports limit three`, async () => {
    const { context } = rule(previous);
    const result = await context.buscarLimiteAtendimentos(100);
    assert.equal(result.quantidade, previous);
    assert.equal(result.limite, 3);
    assert.equal(result.janela_dias, 5);
    let status, body;
    context.responderLimiteAtendimentos({
      status(value) { status = value; return this; },
      json(value) { body = value; return value; },
    }, result);
    assert.equal(status, 429);
    assert.equal(body.code, 'limite_atendimentos_recentes');
    assert.equal(body.limite, 3);
    assert.match(body.error, new RegExp(`${previous} atendimentos nos ultimos 5 dias`.replace('ultimos', '\u00faltimos')));
  });
}

test('preserves manual blocks regardless of payment count', async () => {
  const { context, calls } = rule(0, { permanente: true, bloqueado_ate: '2099-01-01', motivo: 'Manual block' });
  const result = await context.buscarLimiteAtendimentos(100);
  assert.equal(result.manual, true);
  assert.equal(result.permanente, true);
  assert.equal(calls.length, 1);
});
