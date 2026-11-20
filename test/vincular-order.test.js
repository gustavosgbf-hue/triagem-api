// Regressão: /api/atendimento/vincular-order não pode vincular order arbitrária.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { avaliarVinculoOrderPagBank, valorPedidoPagBankCentavos } from '../pagbank-verificacao.js';

const pedido = (extra = {}) => ({
  id: 'ORDE_ABC123',
  reference_id: 'CJ-4521-AB3Z',
  items: [{ name: 'Consulta', quantity: 1, unit_amount: 4990 }],
  qr_codes: [{ amount: { value: 4990 } }],
  ...extra,
});
const base = (extra = {}) => ({ atendimentoId: 4521, orderId: 'ORDE_ABC123', pedido: pedido(), valorEsperadoCentavos: 4990, ...extra });

test('valor do pedido: QR codes, depois itens; nulo quando indeterminado', () => {
  assert.equal(valorPedidoPagBankCentavos(pedido()), 4990);
  assert.equal(valorPedidoPagBankCentavos({ items: [{ unit_amount: 1000, quantity: 3 }] }), 3000);
  assert.equal(valorPedidoPagBankCentavos({ qr_codes: [{ amount: { value: 'x' } }] }), null);
  assert.equal(valorPedidoPagBankCentavos({ items: [{ unit_amount: -5, quantity: 1 }] }), null);
  assert.equal(valorPedidoPagBankCentavos({}), null);
  assert.equal(valorPedidoPagBankCentavos(null), null);
});

test('vínculo aceito só com referência deste atendimento e valor esperado', () => {
  assert.deepEqual(avaliarVinculoOrderPagBank(base()), { ok: true });
  assert.deepEqual(avaliarVinculoOrderPagBank(base({ pedido: pedido({ reference_id: 'CJ-WA-4521-1700000000000' }) })), { ok: true });
});

test('vínculo recusado: order de outro atendimento (ataque principal)', () => {
  const r = avaliarVinculoOrderPagBank(base({ pedido: pedido({ reference_id: 'CJ-999-ZZZZ' }) }));
  assert.deepEqual(r, { ok: false, motivo: 'referencia_divergente' });
});

test('vínculo recusado: referências que não são da fila', () => {
  for (const ref of ['CJ-PSI-4521-1700000000000', 'CJ-ESP-4521-1', 'RENOV-4521-1', 'CJ-1700000000000-ABCD', '', undefined]) {
    assert.equal(avaliarVinculoOrderPagBank(base({ pedido: pedido({ reference_id: ref }) })).motivo, 'referencia_divergente', String(ref));
  }
});

test('vínculo recusado: valor diferente do esperado ou desconhecido', () => {
  assert.equal(avaliarVinculoOrderPagBank(base({ pedido: pedido({ qr_codes: [{ amount: { value: 100 } }] }) })).motivo, 'valor_divergente');
  assert.equal(avaliarVinculoOrderPagBank(base({ pedido: pedido({ qr_codes: [], items: [] }) })).motivo, 'valor_divergente');
  assert.equal(avaliarVinculoOrderPagBank(base({ valorEsperadoCentavos: undefined })).motivo, 'valor_esperado_desconhecido');
  assert.equal(avaliarVinculoOrderPagBank(base({ valorEsperadoCentavos: 0 })).motivo, 'valor_esperado_desconhecido');
});

test('vínculo recusado: pedido ausente, id divergente ou entradas inválidas', () => {
  assert.equal(avaliarVinculoOrderPagBank(base({ pedido: null })).motivo, 'pedido_nao_encontrado');
  assert.equal(avaliarVinculoOrderPagBank(base({ pedido: pedido({ id: 'ORDE_OUTRA' }) })).motivo, 'pedido_divergente');
  assert.equal(avaliarVinculoOrderPagBank(base({ orderId: '../charges' })).motivo, 'order_invalida');
  assert.equal(avaliarVinculoOrderPagBank(base({ atendimentoId: 'abc' })).motivo, 'atendimento_invalido');
  assert.equal(avaliarVinculoOrderPagBank(base({ atendimentoId: -1 })).motivo, 'atendimento_invalido');
});

test('server.js: vincular-order verifica no PagBank antes de gravar', () => {
  const src = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const ini = src.indexOf('app.post("/api/atendimento/vincular-order"');
  assert.ok(ini > 0);
  const fim = src.indexOf('\napp.', ini + 10);
  const handler = src.slice(ini, fim);
  const iVerif = handler.indexOf('avaliarVinculoOrderPagBank(');
  const iUpdate = handler.indexOf('UPDATE fila_atendimentos');
  assert.ok(iVerif > 0 && iUpdate > iVerif, 'UPDATE precisa vir depois da verificação');
  assert.match(handler, /consultarPedidoPagBankBruto\(orderId\)/);
  assert.match(handler, /pagbank_order_id IS NULL/);
  assert.match(handler, /pagamento_status = 'pendente'/);
  assert.match(handler, /orderIdPagBankValido\(orderId\)/);
});

test('preload beta: não grava orderId vindo do corpo', () => {
  const src = readFileSync(new URL('../mobile-beta-test-preload.js', import.meta.url), 'utf8');
  const ini = src.indexOf("app.use('/api/atendimento/vincular-order'");
  const trecho = src.slice(ini, src.indexOf('app.get(', ini));
  assert.ok(!/req\.body\?\.orderId/.test(trecho));
});
