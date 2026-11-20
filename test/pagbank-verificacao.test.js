import test from 'node:test';
import assert from 'node:assert/strict';
import {
  orderIdPagBankValido, pagbankOrderPago, resumirPedidoPagBank, idFilaDeReferenciaPagBank,
  expiracaoPixFortaleza, tokenNotificacaoEfiValido, criarDeduplicadorPedidos,
} from '../pagbank-verificacao.js';

test('order id: aceita formato PagBank e recusa path injection', () => {
  assert.ok(orderIdPagBankValido('ORDE_1234ABCD-5678'));
  for (const v of ['', '../charges', 'ORDE_1/../x', 'a?b=1', 'x'.repeat(81), 123, null]) {
    assert.equal(orderIdPagBankValido(v), false, String(v));
  }
});

test('pedido pago: status do pedido, charge ou pagamento do QR', () => {
  assert.ok(pagbankOrderPago({ status: 'PAID' }));
  assert.ok(pagbankOrderPago({ charges: [{ status: 'paid' }] }));
  assert.ok(pagbankOrderPago({ qr_codes: [{ payments: [{ status: 'PAID' }] }] }));
  assert.equal(pagbankOrderPago({ charges: [{ status: 'WAITING' }] }), false);
  assert.equal(pagbankOrderPago(null), false);
});

test('resumo do pedido usa dados da API e soma o valor pago', () => {
  const r = resumirPedidoPagBank({
    id: 'ORDE_1', reference_id: 'CJ-PSI-10-1700000000000',
    charges: [{ status: 'PAID', amount: { value: 25000 } }, { status: 'DECLINED', amount: { value: 999 } }],
  }, 'ORDE_1');
  assert.deepEqual(r, { id: 'ORDE_1', pago: true, referenceId: 'CJ-PSI-10-1700000000000', valorPagoCentavos: 25000 });
  assert.equal(resumirPedidoPagBank(null, 'x'), null);
});

test('reference_id da fila: checkout e WhatsApp; ignora PSI/ESP/RENOV e ids sem atendimento', () => {
  assert.equal(idFilaDeReferenciaPagBank('CJ-4521-AB3Z'), 4521);
  assert.equal(idFilaDeReferenciaPagBank('CJ-WA-99-1700000000000'), 99);
  assert.equal(idFilaDeReferenciaPagBank('CJ-PSI-10-1700000000000'), null);
  assert.equal(idFilaDeReferenciaPagBank('CJ-ESP-10-1700000000000'), null);
  assert.equal(idFilaDeReferenciaPagBank('RENOV-10-1700000000000'), null);
  assert.equal(idFilaDeReferenciaPagBank('CJ-1700000000000-AB3Z'), null); // Date.now(): sem atendimento
  assert.equal(idFilaDeReferenciaPagBank('CJ-0-AB'), null);
  assert.equal(idFilaDeReferenciaPagBank(undefined), null);
});

test('expiração do PIX: 30 min reais, rotulada em -03:00', () => {
  const agora = Date.parse('2026-11-20T18:00:00.000Z'); // 15:00 em Fortaleza
  const iso = expiracaoPixFortaleza(30, agora);
  assert.equal(iso, '2026-11-20T15:30:00-03:00');
  assert.equal(Date.parse(iso) - agora, 30 * 60 * 1000);
});

test('token de notificação Efí', () => {
  assert.ok(tokenNotificacaoEfiValido('abc-123_X'));
  assert.equal(tokenNotificacaoEfiValido('../oauth/token'), false);
  assert.equal(tokenNotificacaoEfiValido({}), false);
});

test('deduplicador de consultas ao gateway', () => {
  let t = 0;
  const pode = criarDeduplicadorPedidos({ janelaMs: 5000, agora: () => t });
  assert.ok(pode('A')); assert.equal(pode('A'), false); assert.ok(pode('B'));
  t = 5001; assert.ok(pode('A'));
});
