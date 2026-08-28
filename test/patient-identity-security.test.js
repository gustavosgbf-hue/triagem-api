import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canResumePaidAttendance,
  createPublicPatientLookupHandler,
  normalizePhone,
  publicPatientLookupResponse,
} from '../patient-identity-security.js';

test('consulta pública por telefone nunca retorna PII sem prova adicional', () => {
  const response = publicPatientLookupResponse(true);
  assert.deepEqual(response, {
    ok: true,
    cadastroEncontrado: true,
    requerVerificacao: true,
  });
  for (const field of ['paciente', 'nome', 'cpf', 'data_nascimento', 'email', 'tel']) {
    assert.equal(Object.hasOwn(response, field), false);
  }
});

test('telefone desconhecido também usa contrato sem PII', () => {
  assert.deepEqual(publicPatientLookupResponse(false), {
    ok: true,
    cadastroEncontrado: false,
  });
});

test('normaliza DDI sem aceitar telefone como prova de identidade', () => {
  assert.equal(normalizePhone('+55 (98) 99134-4646'), '98991344646');
  assert.equal(canResumePaidAttendance({ cpf: '', atendimentoParaTerceiro: false }), false);
});

test('retomada paga exige CPF e é proibida para atendimento de terceiro', () => {
  assert.equal(canResumePaidAttendance({ cpf: '529.982.247-25', atendimentoParaTerceiro: false }), true);
  assert.equal(canResumePaidAttendance({ cpf: '529.982.247-25', atendimentoParaTerceiro: true }), false);
});

test('GET /api/paciente/buscar sem prova adicional não expõe a linha encontrada', async () => {
  const handler = createPublicPatientLookupHandler(async () => ({
    rowCount: 1,
    rows: [{ nome: 'Segredo', cpf: '52998224725', data_nascimento: '1990-01-01', email: 'segredo@example.com' }],
  }));
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
  };
  await handler({ query: { tel: '98999990000' } }, res);
  assert.equal(statusCode, 200);
  assert.deepEqual(payload, {
    ok: true,
    cadastroEncontrado: true,
    requerVerificacao: true,
  });
  assert.equal(JSON.stringify(payload).includes('Segredo'), false);
  assert.equal(JSON.stringify(payload).includes('52998224725'), false);
});
