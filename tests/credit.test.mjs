import test from 'node:test';
import assert from 'node:assert/strict';
import { compareOptions, breakEvenDays } from '../js/credit.js';

test('owner screenshots: 10 000 for 2 days via cash = 60 грн', () => {
  const r = compareOptions(1000000, 2);
  const cash = r.options.find(o => o.id === 'cash');
  assert.equal(cash.cost, 6000);
  assert.equal(r.best.id, 'cash');
});

test('owner screenshot: 121 413 installment 3 months = 6 920,54 commission, 42 777,85 payment', () => {
  const r = compareOptions(12141300, 90);
  const inst = r.options.find(o => o.id === 'inst');
  assert.equal(inst.cost, 692054);
  assert.equal(inst.payment, 4277785);
  assert.ok(Math.abs(inst.annualEffective - 0.397) < 0.01);
});

test('break-even: cash cheaper up to 19 days, installment cheaper after', () => {
  assert.equal(breakEvenDays(), 19);
  assert.equal(compareOptions(1000000, 14).best.id, 'cash');      // 420 vs 570
  assert.equal(compareOptions(1000000, 25).best.id, 'inst');      // 750 vs 570
  assert.equal(compareOptions(1000000, 365).best.id, 'inst');
});

test('installment minimum 3 months even for a week; partner store = 0%', () => {
  const inst = compareOptions(1000000, 7).options.find(o => o.id === 'inst');
  assert.equal(inst.months, 3);
  assert.equal(inst.cost, 57000);
  const p = compareOptions(1000000, 120, { partner: true });
  assert.equal(p.best.id, 'parts');
  assert.equal(p.best.cost, 0);
});

test('custom tariffs override defaults', () => {
  const r = compareOptions(1000000, 30, { tariffs: { cashPerDay: 0.001 } });
  assert.equal(r.options.find(o => o.id === 'cash').cost, 30000);
});
