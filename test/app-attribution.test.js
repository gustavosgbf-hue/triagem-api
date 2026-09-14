import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = source.indexOf('function limitarTexto');
const end = source.indexOf('async function salvarAdsAttribution', start);
assert.ok(start >= 0 && end > start);

const context = vm.createContext({ Date, JSON, Number, String, Object, Array, RegExp });
vm.runInContext(source.slice(start, end), context);

test('normalizes Android install attribution without personal data', () => {
  const attribution = context.normalizarAdsAttribution({
    install_id: 'install_12345678',
    attribution_id: 'cja_12345678',
    gclid: 'google-click-id',
    gbraid: 'google-braid-id',
    wbraid: 'web-braid-id',
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'search_app',
    nome: 'must-not-be-copied',
    cpf: 'must-not-be-copied',
  });

  assert.equal(attribution.installId, 'install_12345678');
  assert.equal(attribution.attributionId, 'cja_12345678');
  assert.equal(attribution.gclid, 'google-click-id');
  assert.equal(attribution.gbraid, 'google-braid-id');
  assert.equal(attribution.wbraid, 'web-braid-id');
  assert.deepEqual(JSON.parse(JSON.stringify(attribution.utm)), {
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'search_app',
  });
  assert.equal('nome' in attribution, false);
  assert.equal('cpf' in attribution, false);
  assert.equal(attribution.hasAny, true);
});

test('rejects malformed tracking identifiers and timestamps', () => {
  assert.equal(context.trackingId('../invalid'), '');
  assert.equal(context.trackingId('short'), '');
  assert.equal(context.trackingId('valid-id_123'), 'valid-id_123');
  assert.equal(context.trackingEpochSeconds('not-a-number'), 0);
  assert.equal(context.trackingEpochSeconds('1726228800'), 1726228800);
  assert.equal(context.trackingIsoDate('not-a-date'), null);
  assert.equal(context.trackingIsoDate('2026-09-14T12:00:00.000Z'), '2026-09-14T12:00:00.000Z');
});

test('accepts JSON beacon payloads and rejects arrays', () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.trackingBody('{"attribution_id":"cja_12345678"}'))),
    { attribution_id: 'cja_12345678' },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(context.trackingBody('[]'))), {});
  assert.deepEqual(JSON.parse(JSON.stringify(context.trackingBody(null))), {});
});

test('tracking endpoints and first-touch protections are present', () => {
  assert.match(source, /\/api\/tracking\/play-click/);
  assert.match(source, /\/api\/tracking\/app-install/);
  assert.match(source, /ON CONFLICT \(install_id\) DO UPDATE SET/);
  assert.match(source, /COALESCE\(app_attributions\.gclid,EXCLUDED\.gclid\)/);
  assert.match(source, /event_name.*attendance_started/s);
});
