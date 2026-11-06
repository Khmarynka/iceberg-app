import test from 'node:test';
import assert from 'node:assert/strict';
import { parseItems, scanImage, ScanError } from '../js/scan.js';

test('parse model answer: amounts to kopecks, junk filtered, text around JSON ok', () => {
  const t = 'Ось результат:\n```json\n{"items":[{"name":"iPhone 15 Comfy","bank":"ПУМБ","payment":"2 499,50","next_date":"2026-11-12","payments_left":7,"payments_total":10,"price":24995,"remaining_debt":null,"rate_note":"0%, комісія 1,9%/міс"},{"name":"","payment":null,"price":null}]}\n```';
  const r = parseItems(t);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], { name: 'iPhone 15 Comfy', bank: 'ПУМБ', payment: 249950, first: '2026-11-12', count: 7, total: 10,
    price: 2499500, note: '0%, комісія 1,9%/міс', debt: null });
});

test('bad values are dropped, not trusted', () => {
  const r = parseItems('{"items":[{"name":"X","payment":-5,"next_date":"12.11.2026","payments_left":9999,"price":"abc","remaining_debt":5000}]}');
  assert.deepEqual([r[0].payment, r[0].first, r[0].count, r[0].price, r[0].debt], [null, null, null, null, 500000]);
  assert.deepEqual(parseItems('{"items":[]}'), []);
  assert.throws(() => parseItems('не знаю'), ScanError);
});

test('request: key + browser header, falls back to second model on 404, maps errors', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push(JSON.parse(opts.body).model);
    assert.equal(opts.headers['x-api-key'], 'sk-ant-test');
    assert.equal(opts.headers['anthropic-dangerous-direct-browser-access'], 'true');
    if (calls.length === 1) return { status: 404, ok: false };
    return { status: 200, ok: true, json: async () => ({ content: [{ type: 'text', text: '{"items":[{"name":"A","payment":100}]}' }] }) };
  };
  const r = await scanImage('sk-ant-test', 'AAAA', '2026-11-06', fake);
  assert.equal(calls.length, 2);
  assert.equal(r[0].payment, 10000);
  await assert.rejects(scanImage('k', 'A', 'x', async () => ({ status: 401, ok: false })), /Ключ/);
  await assert.rejects(scanImage('k', 'A', 'x', async () => ({ status: 403, ok: false })), /баланс/);
});
