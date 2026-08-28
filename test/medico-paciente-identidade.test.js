import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanDate, identitySignals, validCpf } from '../medico-paciente-longitudinal-preload.js';

test('normaliza datas ISO e brasileiras', () => {
  assert.equal(cleanDate('1998-10-16T00:00:00.000Z'), '1998-10-16');
  assert.equal(cleanDate('16/10/1998'), '1998-10-16');
  assert.equal(cleanDate('data desconhecida'), '');
});

test('telefone e nome não vinculam histórico sem outro identificador forte', () => {
  const result = identitySignals(
    { nome: 'Maria da Silva', tel: '(98) 99999-0000' },
    { nome: 'Maria da Silva', tel: '98999990000' },
  );
  assert.equal(result.phoneMatch, true);
  assert.equal(result.nameMatch, true);
  assert.equal(result.strong, false);
});

test('CPF válido vincula paciente comum mesmo com telefone novo', () => {
  const result = identitySignals(
    { nome: 'Maria da Silva', cpf: '529.982.247-25', tel: '98999990000' },
    { nome: 'Maria S Silva', cpf: '52998224725', tel: '98988880000' },
  );
  assert.equal(result.cpfMatch, true);
  assert.equal(result.strong, true);
});

test('CPF inválido não é usado como identidade', () => {
  assert.equal(validCpf('123.456.789-01'), false);
  const result = identitySignals(
    { nome: 'Maria da Silva', cpf: '123.456.789-01' },
    { nome: 'Outra Pessoa', cpf: '12345678901' },
  );
  assert.equal(result.strong, false);
});

test('atendimento para terceiro exige nome e nascimento', () => {
  const payerOnly = identitySignals(
    { nome: 'Paciente Novo', cpf: '12345678901', tel: '98999990000', atendimento_para_terceiro: true },
    { nome: 'Outro Paciente', cpf: '12345678901', tel: '98999990000' },
  );
  assert.equal(payerOnly.strong, false);

  const patientMatch = identitySignals(
    { nome: 'Paciente Novo', data_nascimento: '05/04/2010', atendimento_para_terceiro: true },
    { nome: 'Paciente Novo', data_nascimento: '2010-04-05' },
  );
  assert.equal(patientMatch.strong, true);
});
