import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GANHOS_INICIO_ISO,
  SQL_GANHOS_MEDICO,
  classificarAtendimentoGanhos,
  classificarFaixaMedico,
  dataIsoNoFuso,
  montarResumoGanhos,
  percentualCentavosHalfUp,
  quinzenaDe,
  registrarRotaGanhosMedico,
  valorPorAtendimentoCentavos,
} from '../medico-ganhos.js';

const ADMIN = 'admin@example.test';
const ok = (dia, extra = {}) => ({
  dia, tipo: 'chat', pagamento_status: 'confirmado', status_atendimento: '✅ Atendido',
  categoria_atendimento: 'clinico', especialidade_solicitada: null,
  valor_cobrado_centavos: 4990, reembolso_status: null, reembolso_valor_centavos: 0, ...extra,
});

test('valores por atendimento em centavos inteiros com half-up', () => {
  assert.equal(percentualCentavosHalfUp(4990, 55), 2745); // 2744,5 → 2745
  assert.equal(valorPorAtendimentoCentavos('reduzida'), 2745);
  assert.equal(valorPorAtendimentoCentavos('padrao'), 3493);
  assert.equal(valorPorAtendimentoCentavos('admin'), 4990);
  assert.equal(percentualCentavosHalfUp(1, 50), 1);
  assert.equal(percentualCentavosHalfUp(1, 49), 0);
});

test('classificação de faixa por nome/e-mail', () => {
  assert.equal(classificarFaixaMedico({ nome: 'Kívia Souza' }, ADMIN), 'reduzida');
  assert.equal(classificarFaixaMedico({ nome: 'Dra. Victória Lima' }, ADMIN), 'reduzida');
  assert.equal(classificarFaixaMedico({ nome: 'X', nome_exibicao: 'Dra. Victoria' }, ADMIN), 'reduzida');
  assert.equal(classificarFaixaMedico({ nome: 'Gabriel Bomfim' }, ADMIN), 'reduzida');
  assert.equal(classificarFaixaMedico({ nome: 'Gabriel Santos' }, ADMIN), 'padrao');
  assert.equal(classificarFaixaMedico({ nome: 'Gabriela Coutinho Amorim Carneiro', nome_exibicao: 'Dra. Gabriela Coutinho A. Carneiro' }, ADMIN), 'reduzida');
  assert.equal(classificarFaixaMedico({ nome: 'Dra. Gabriela Coutinho' }, ADMIN), 'reduzida');
  assert.equal(classificarFaixaMedico({ nome: 'Gabriela Lima' }, ADMIN), 'padrao');
  assert.equal(classificarFaixaMedico({ nome: 'Ana', email: ' Admin@Example.test ' }, ADMIN), 'admin');
  assert.equal(classificarFaixaMedico({ nome: 'Ana' }, ADMIN), 'padrao');
});

test('somente atendimentos efetivamente atendidos, pagos e na regra contam', () => {
  const casos = [
    [ok('2026-11-16'), true, null],
    [ok('x', { status_atendimento: '🔇 Sem resposta do paciente' }), false, 'sem_resposta'],
    [ok('x', { status_atendimento: '❌ Cancelado' }), false, 'cancelado'],
    [ok('x', { status_atendimento: 'Encerrado pelo painel' }), false, 'status_nao_confirmado'],
    [ok('x', { status_atendimento: 'Encerrado' }), false, 'status_nao_confirmado'],
    [ok('x', { status_atendimento: 'Não atendido' }), false, 'status_nao_confirmado'],
    [ok('x', { pagamento_status: 'isento_admin' }), false, 'isento_sem_regra'],
    [ok('x', { pagamento_status: 'pendente' }), false, 'pagamento_nao_confirmado'],
    [ok('x', { reembolso_valor_centavos: 4990 }), false, 'estorno'],
    [ok('x', { reembolso_status: 'manual_pendente' }), false, 'estorno'],
    [ok('x', { tipo: 'renovacao_digital' }), false, 'renovacao'],
    [ok('x', { categoria_atendimento: 'especialista_imediato' }), false, 'especialidade_sem_regra'],
    [ok('x', { especialidade_solicitada: 'dermatologia' }), false, 'especialidade_sem_regra'],
    [ok('x', { valor_cobrado_centavos: 3990 }), false, 'valor_cobrado_sem_regra'],
  ];
  for (const [at, elegivel, motivo] of casos) {
    assert.deepEqual(classificarAtendimentoGanhos(at), { elegivel, motivo }, JSON.stringify(at));
  }
});

test('quinzenas', () => {
  assert.deepEqual(quinzenaDe('2026-11-15'), { id: '2026-11-Q1', inicio: '2026-11-01', fim: '2026-11-15' });
  assert.deepEqual(quinzenaDe('2026-11-16'), { id: '2026-11-Q2', inicio: '2026-11-16', fim: '2026-11-30' });
  assert.deepEqual(quinzenaDe('2028-02-20'), { id: '2028-02-Q2', inicio: '2028-02-16', fim: '2028-02-29' });
});

test('fuso America/Fortaleza na virada do dia', () => {
  assert.equal(dataIsoNoFuso(new Date('2026-11-17T02:59:59Z')), '2026-11-16');
  assert.equal(dataIsoNoFuso(new Date('2026-11-17T03:00:00Z')), '2026-11-17');
  assert.equal(GANHOS_INICIO_ISO, '2026-11-16T00:00:00-03:00');
});

test('resumo agregado: totais, dia, quinzena e sem dados sensíveis', () => {
  const rows = [
    ok('2026-11-15'), // antes da vigência: ignorado
    ok('2026-11-16'), ok('2026-11-16'), ok('2026-11-17'),
    ok('2026-12-01'),
    ok('2026-11-17', { status_atendimento: '🔇 Sem resposta do paciente' }),
  ];
  const r = montarResumoGanhos({
    medico: { nome: 'Kivia Teste', email: 'k@example.test' }, rows, hojeIso: '2026-11-17',
    adminEmail: ADMIN, agora: new Date('2026-11-17T12:00:00Z'),
  });
  assert.equal(r.natureza, 'estimativa');
  assert.equal(r.valor_por_atendimento_centavos, 2745);
  assert.deepEqual(r.total, { atendimentos: 4, valor_centavos: 4 * 2745, situacao: 'pendente_estimado' });
  assert.deepEqual(r.hoje, { data: '2026-11-17', atendimentos: 1, valor_centavos: 2745 });
  assert.deepEqual(r.por_dia.map((d) => d.data), ['2026-12-01', '2026-11-17', '2026-11-16']);
  assert.deepEqual(r.quinzenas.map((q) => [q.id, q.atendimentos, q.data_pagamento, q.data_pagamento_status]),
    [['2026-12-Q1', 1, '2026-12-16', 'previsao_provisoria'], ['2026-11-Q2', 3, '2026-12-01', 'previsao_provisoria']]);
  assert.equal(r.quinzenas.reduce((s, q) => s + q.valor_centavos, 0), r.total.valor_centavos);
  assert.equal(r.por_dia.reduce((s, d) => s + d.valor_centavos, 0), r.total.valor_centavos);
  assert.deepEqual(r.nao_contabilizados, { total: 1, motivos: { sem_resposta: 1 } });
  assert.deepEqual(r.pagamento, { regra_definida: true, criterio: 'primeiro_dia_util_apos_fechamento', data_prevista: null, status: 'previsao_provisoria' });
  const json = JSON.stringify(r);
  assert.doesNotMatch(json, /%|percent|faixa|reduzida|padrao|medico_id|kivia|example\.test/i);
  for (const v of [r.total.valor_centavos, r.hoje.valor_centavos, ...r.por_dia.map((d) => d.valor_centavos)]) {
    assert.ok(Number.isInteger(v));
  }
});

test('SQL não seleciona PII e filtra pelo médico do token', () => {
  assert.doesNotMatch(SQL_GANHOS_MEDICO, /\b(nome|tel|cpf|email|triagem|queixa|f\.id)\b/);
  assert.match(SQL_GANHOS_MEDICO, /f\.medico_id = \$1/);
  assert.match(SQL_GANHOS_MEDICO, /f\.status = 'encerrado'/);
  assert.match(SQL_GANHOS_MEDICO, /NOT LIKE 'renovacao%'/);
});

function rota(token, medicoRow) {
  let handler;
  const calls = [];
  const app = { get: (path, _mw, h) => { assert.equal(path, '/api/medico/ganhos'); handler = h; } };
  const pool = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('FROM medicos')) return { rows: medicoRow ? [medicoRow] : [] };
      return { rows: [ok('2026-11-16')] };
    },
  };
  registrarRotaGanhosMedico(app, { pool, checkMedico: () => {}, adminEmail: ADMIN });
  const res = { statusCode: 200, set() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  return { run: () => handler({ medico: token, query: { medico_id: 999 } }, res).then(() => res), calls };
}

test('rota usa id do JWT, ignora query e rejeita tokens não médicos', async () => {
  const m = { nome: 'Fulano', email: 'f@example.test' };
  const okRun = rota({ id: 7, email: 'F@example.test' }, m);
  const res = await okRun.run();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total.valor_centavos, 3493);
  assert.deepEqual(okRun.calls[1].params, [7, GANHOS_INICIO_ISO]);

  for (const tok of [{ id: 7, tipo: 'paciente' }, { id: 7 }, { medicoId: 7, tipo: 'assumir' }]) {
    assert.equal((await rota(tok, m).run()).statusCode, 403);
  }
  assert.equal((await rota({ id: 7, email: 'outro@example.test' }, m).run()).statusCode, 403);
  assert.equal((await rota({ id: 7, email: 'f@example.test' }, null).run()).statusCode, 403);
});
