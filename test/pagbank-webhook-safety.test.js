import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const handler = server.slice(
  server.indexOf('app.post("/api/pagbank/webhook", async (req, res) => {'),
  server.indexOf('\nfunction pagbankOrderPago(data)')
);

test('webhook never confirms a payment on unverified notification data', () => {
  assert.match(handler, /fetch\(`\$\{PAGBANK_URL\}\/orders\/\$\{encodeURIComponent\(orderId\)\}`/);
  assert.match(handler, /if \(!pagbankOrderPago\(verifiedOrder\)\) return res\.sendStatus\(200\)/);
  assert.match(handler, /if \(!pbRes\.ok\)/);
});

test('missing order association uses verified reference ID, not newest pending patient', () => {
  assert.match(handler, /verifiedOrder\.reference_id/);
  assert.match(handler, /WHERE id = \$1 AND pagbank_order_id IS NULL AND pagamento_status = 'pendente'/);
  assert.doesNotMatch(handler, /ORDER BY criado_em DESC/);
  assert.doesNotMatch(handler, /LIMIT 1[\s\S]*?UPDATE fila_atendimentos/);
});

test('webhook acknowledges after database reconciliation, not before', () => {
  const update = handler.indexOf('UPDATE fila_atendimentos');
  const ackAfter = handler.indexOf('return res.sendStatus(200);', update);
  assert.ok(update > 0 && ackAfter > update);
});

test('Pix creation validates payer CPF on the server', () => {
  const route = server.slice(server.indexOf('app.post("/api/pagbank/order"'), server.indexOf('app.post("/api/pagbank/webhook"'));
  assert.match(route, /julieValidarCPF\(String\(cpf\)\)/);
  assert.match(route, /code: "CPF_INVALIDO"/);
});
