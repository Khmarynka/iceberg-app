import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrenceDate, occurrenceIn, monthEvents, matchOp, status, monthSummary, forecast, remaining,
  costOf, monthlyRate, pct, parseMoney } from '../js/plan.js';

const plan = {
  obligations: [
    { id: 'comfy', name: 'Comfy телефон', bank: 'mono', payment: 125000, first: '2026-11-12', count: 4, match: 'частинами' },
    { id: 'pumb', name: 'ПУМБ ноутбук', bank: 'ПУМБ', payment: 180000, first: '2026-10-31', count: 6, price: 990000, total: 6 },
    { id: 'kom', name: 'Комуналка', payment: 320000, first: '2026-11-20', count: null },
  ],
  incomes: [
    { id: 'ph', name: 'Philips', amount: 3000000, first: '2026-11-05', count: null, match: 'філіпс' },
    { id: 'dd', name: 'ДДМУ', amount: 1450000, first: '2026-11-15', count: null },
  ],
  marks: {},
};
const today = { y: 2026, m: 11, d: 6 };

test('dates: 31st becomes 30th/28th; count limits schedule', () => {
  assert.deepEqual(occurrenceDate('2026-10-31', 1), { y: 2026, m: 11, d: 30 });
  assert.deepEqual(occurrenceDate('2026-10-31', 4), { y: 2027, m: 2, d: 28 });
  assert.ok(occurrenceIn(plan.obligations[0], 2027, 2));                   // 4 платежі: лист, груд, січ, лют
  assert.equal(occurrenceIn(plan.obligations[0], 2027, 3), null);          // березня вже немає
  assert.equal(occurrenceIn(plan.obligations[0], 2026, 10), null);         // до першого — нічого
});

test('month events sorted, incomes first on same day', () => {
  const ev = monthEvents(plan, 2026, 11);
  assert.deepEqual(ev.map(e => `${e.d}${e.type}`), ['5in', '12out', '15in', '20out', '30out']);
});

test('auto match from monobank by word and amount', () => {
  const ops = [{ amount: 3000000, desc: 'ТОВ Філіпс Юкрейн' }, { amount: -125000, desc: 'Покупка частинами: Comfy' }];
  const ev = monthEvents(plan, 2026, 11);
  assert.ok(matchOp(ev.find(e => e.item.id === 'ph'), ops));
  assert.ok(matchOp(ev.find(e => e.item.id === 'comfy'), ops));
  assert.equal(matchOp(ev.find(e => e.item.id === 'comfy'), [{ amount: -50000, desc: 'Покупка частинами' }]), null); // інша сума
  assert.equal(status(ev.find(e => e.item.id === 'dd'), plan, ops, '2026-11-06').state, 'plan');
  assert.equal(status(ev.find(e => e.item.id === 'ph'), plan, ops, '2026-11-06').how, 'bank');
  const p2 = { ...plan, marks: { 'kom:2026-11': true } };
  assert.equal(status(ev.find(e => e.item.id === 'kom'), p2, [], '2026-11-06').how, 'manual');
});

test('month summary: to pay, to come, free, per day, cash gap', () => {
  const ops = [{ amount: 3000000, desc: 'ТОВ Філіпс Юкрейн' }];       // зарплата вже прийшла
  const s = monthSummary(plan, ops, 500000, today);                    // своїх 5 000 грн
  assert.equal(s.toPay, 125000 + 320000 + 180000);
  assert.equal(s.toCome, 1450000);
  assert.equal(s.free, 500000 + 1450000 - 625000);
  assert.equal(s.daysLeft, 25);
  assert.equal(s.perDay, Math.floor(s.free / 25));
  assert.equal(s.gap, null);
  assert.equal(s.color, 'green');
  // мало грошей до ДДМУ: 12-го Comfy 1 250 при 1 000 на руках — розрив
  const s2 = monthSummary(plan, ops, 100000, today);
  assert.deepEqual(s2.gap, { day: 12, short: 25000 });
  assert.equal(s2.color, 'yellow');
  const s3 = monthSummary({ ...plan, incomes: [] }, [], 0, today);
  assert.equal(s3.color, 'red');
});

test('late: past unpaid obligation is charged today, still counted', () => {
  const s = monthSummary(plan, [], 0, { y: 2026, m: 11, d: 25 });
  assert.equal(s.late.length, 2);                                       // Comfy 12-го і комуналка 20-го
  assert.equal(s.gap.day, 25);
});

test('forecast decreases when installments end', () => {
  const f = forecast(plan, today, 6);
  assert.equal(f[0].out, 125000 + 180000 + 320000);
  assert.deepEqual(f[3].ending, ['Comfy телефон']);                    // останній платіж — лютий
  assert.ok(f[4].out < f[3].out);                                       // з березня платежі менші
});

test('remaining payments', () => {
  const r = remaining(plan.obligations[0], plan, [], today);
  assert.deepEqual(r, { left: 4, sum: 500000 });
  const r2 = remaining(plan.obligations[0], plan, [{ amount: -125000, desc: 'Покупка частинами' }], today);
  assert.equal(r2.left, 3);
  assert.equal(remaining(plan.obligations[2], plan, [], today), null);
});

test('cost: same maths as the bot', () => {
  assert.equal(monthlyRate(1000000, 12, 50000), 0);
  const c = costOf(1000000, 12, 112300);                                // 10 000 → 12 × 1 123
  assert.equal(c.overpay, 347600);
  assert.ok(c.annual > 0.5 && c.annual < 0.8);
  assert.equal(c.color, 'red');
  assert.equal(costOf(990000, 6, 165000).color, 'green');               // 0%
  assert.equal(pct(0.6351), '63,5%');
  assert.equal(costOf(0, 6, 100), null);
});

test('money input', () => {
  assert.equal(parseMoney('1 250'), 125000);
  assert.equal(parseMoney('1250,50'), 125050);
  assert.equal(parseMoney('15 тис'), 1500000);
  assert.equal(parseMoney('10к'), 1000000);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney(''), null);
});
