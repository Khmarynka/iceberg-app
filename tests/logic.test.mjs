// node --test tests/  — логіка на назвах з реального скріншота власника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { money, monthStartUnix, kyivDate, classify, ownMarkers, toOps, totals, ownMoney, mainAccount, cardName, category } from '../js/logic.js';

const INFO = {
  accounts: [
    { id: 'black', iban: 'UA11BLACK', currencyCode: 980, type: 'black', balance: 1250000, creditLimit: 2000000, maskedPan: ['5375****1234'] },
    { id: 'white', iban: 'UA22WHITE', currencyCode: 980, type: 'white', balance: 30000, creditLimit: 0, maskedPan: ['5375****5678'] },
    { id: 'usd', iban: 'UA33USD', currencyCode: 840, type: 'black', balance: 0, creditLimit: 0, maskedPan: ['5375****9999'] },
  ],
  jars: [
    { title: 'Диференциал', currencyCode: 980, balance: 0, goal: 4500000 },
    { title: 'Резина Зима', currencyCode: 980, balance: 500000, goal: 2000000 },
  ],
};
const it = (n, amount, description, mcc = 0, extra = {}) => ({ id: String(n), time: 1793500000 + n * 3600, amount, description, mcc, ...extra });
const ITEMS = [
  it(1, 674700, 'Зарплата ТОВ Філіпс', 4829),
  it(2, -106600, 'Погашення наступного платежу'),
  it(3, -161400, 'Повне погашення'),
  it(4, -500, 'За перевищення кредитного ліміту'),
  it(5, -45000, 'OBSIDIAN', 5817),
  it(6, -41500, 'Вина Світу', 5921),
  it(7, -99000, 'АТБ', 5411),
  it(8, -200000, 'На білу картку', 4829),
  it(9, 200000, 'З чорної картки', 4829),
  it(10, -100000, 'Поповнення «Резина Зима»', 4829),
  it(11, -150000, 'Олена К.', 4829, { counterIban: 'UA99OTHER' }),
  it(12, -50000, 'Переказ', 4829, { counterIban: 'UA22WHITE' }),
];

test('money', () => {
  assert.equal(money(-123456), '−1 235 грн');
  assert.equal(money(15000, 840), '150 $');
  assert.equal(money(70700, 980, { sign: true }), '+707 грн');
});

test('month start in Kyiv time (winter and summer offsets)', () => {
  // 5 листопада 2026, 12:24 Київ = 10:24 UTC; початок місяця = 31.10 22:00 UTC
  assert.equal(monthStartUnix(Date.UTC(2026, 10, 5, 10, 24)), Date.UTC(2026, 9, 31, 22, 0) / 1000);
  // липень (UTC+3): 1 липня 00:00 Київ = 30.06 21:00 UTC
  assert.equal(monthStartUnix(Date.UTC(2026, 6, 15)), Date.UTC(2026, 5, 30, 21, 0) / 1000);
  // через рік назад: січень → листопад попереднього року
  assert.equal(monthStartUnix(Date.UTC(2026, 0, 10), 2), Date.UTC(2025, 9, 31, 22, 0) / 1000);
  const d = kyivDate(Date.UTC(2026, 10, 5, 10, 24) / 1000);
  assert.deepEqual([d.day, d.month, d.hm], [5, 11, '12:24']);
});

test('classification from real names', () => {
  const k = Object.fromEntries(toOps(ITEMS, INFO).map(o => [o.desc, o.kind]));
  assert.equal(k['Зарплата ТОВ Філіпс'], 'income');
  assert.equal(k['Погашення наступного платежу'], 'credit');
  assert.equal(k['Повне погашення'], 'credit');
  assert.equal(k['За перевищення кредитного ліміту'], 'fee');
  assert.equal(k['OBSIDIAN'], 'spend');
  assert.equal(k['На білу картку'], 'own');
  assert.equal(k['З чорної картки'], 'own');
  assert.equal(k['Поповнення «Резина Зима»'], 'own');
  assert.equal(k['Переказ'], 'own');
  assert.equal(k['Олена К.'], 'spend');
});

test('totals exclude own transfers', () => {
  const t = totals(toOps(ITEMS, INFO));
  assert.equal(t.income, 674700);
  assert.equal(t.credit, 268000);
  assert.equal(t.fee, 500);
  assert.equal(t.spend, 45000 + 41500 + 99000 + 150000);
  assert.equal(t.ownOut, 350000);
  assert.equal(t.ownIn, 200000);
  assert.equal(t.net, 674700 - (268000 + 500 + 335500));
  assert.equal(t.byCat['Продукти'], 99000 + 41500);
});

test('own money, debt, jars, main card, names', () => {
  assert.deepEqual(ownMoney(INFO), { own: 30000, debt: 750000, limit: 2000000, jars: 500000, others: 0 });
  assert.equal(mainAccount(INFO).id, 'black');
  assert.equal(cardName(INFO.accounts[0]), 'Чорна •1234');
  assert.equal(category(9999), 'Інше');
});

test('ops sorted newest first', () => {
  const ops = toOps(ITEMS, INFO);
  assert.ok(ops[0].time > ops.at(-1).time);
});

test('kopecks and excluded (child) card', () => {
  assert.equal(money(1129, 980, { kop: true }), '11,29 грн');
  assert.equal(money(-123456, 980, { kop: true }), '−1 234,56 грн');
  const info = { accounts: [
    { id: 'black', currencyCode: 980, balance: 1129, creditLimit: 2000000 },
    { id: 'kid', currencyCode: 980, balance: 3163, creditLimit: 0 },
  ], jars: [] };
  assert.equal(ownMoney(info).own, 3163);                    // без позначки — дитяча рахується
  const m = ownMoney(info, ['kid']);
  assert.equal(m.own, 0);
  assert.equal(m.others, 3163);
  assert.equal(m.debt, 2000000 - 1129);
});

test('main card skips child card even if listed first', () => {
  const info = { accounts: [
    { id: 'kid', currencyCode: 980, type: 'black', balance: 3163, creditLimit: 0 },
    { id: 'mine', currencyCode: 980, type: 'black', balance: 1129, creditLimit: 2000000 },
  ] };
  assert.equal(mainAccount(info).id, 'mine');            // чорна з лімітом — пріоритет
  assert.equal(mainAccount(info, ['mine']).id, 'kid');
  assert.equal(mainAccount({ accounts: [info.accounts[0]] }, ['kid']), null);
});
