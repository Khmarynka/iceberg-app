// node --test tests/  — логіка на назвах з реального скріншота власника.
import test from 'node:test';
import assert from 'node:assert/strict';
import { allOps, statementAccounts, money, monthStartUnix, kyivDate, classify, ownMarkers, toOps, totals, ownMoney, mainAccount, cardName, category } from '../js/logic.js';

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

test('all own accounts: FOP income -> white card -> repayment; own transfers excluded', () => {
  const info = { accounts: [
    { id: 'fop', iban: 'UA00FOP', currencyCode: 980, type: 'fop', balance: 0, creditLimit: 0 },
    { id: 'white', iban: 'UA22WHITE', currencyCode: 980, type: 'white', balance: 500000, creditLimit: 0 },
    { id: 'black', iban: 'UA11BLACK', currencyCode: 980, type: 'black', balance: 1129, creditLimit: 15000000 },
    { id: 'kid', iban: 'UA44KID', currencyCode: 980, type: 'black', balance: 3163, creditLimit: 0 },
  ], jars: [] };
  assert.deepEqual(statementAccounts(info, ['kid']).map(a => a.id), ['black', 'fop', 'white']);
  const byAcc = {
    fop: [it(1, 3000000, 'ТОВ Філіпс Юкрейн', 4829, { counterIban: 'UA77PHILIPS' }),
          it(2, -3000000, 'На білу картку', 4829, { counterIban: 'UA22WHITE' })],
    white: [it(3, 3000000, 'З рахунку ФОП', 4829, { counterIban: 'UA00FOP' }),
            it(4, -2500000, 'Погашення наступного платежу', 0)],
    black: [],
  };
  const ops = allOps(byAcc, info);
  assert.equal(ops.length, 4);
  assert.ok(new Set(ops.map(o => o.id)).size === 4);          // id унікальні між рахунками
  const t = totals(ops);
  assert.equal(t.income, 3000000);                            // зарплата — один раз, не двічі
  assert.equal(t.credit, 2500000);
  assert.equal(t.ownIn + t.ownOut, 6000000);                  // ФОП→біла видно, але не рахується
  assert.equal(ops.find(o => o.desc === 'ТОВ Філіпс Юкрейн').acc, 'fop');
});

test('owner case 6 Nov: FOP income 49k, odd transfer text, 14k merchant refund → income 49k only', () => {
  const info = { name: 'Сербіненко Євгеній', accounts: [
    { id: 'fop', iban: 'UA00FOP', currencyCode: 980, type: 'fop', balance: 0, creditLimit: 0 },
    { id: 'white', iban: 'UA22WHITE', currencyCode: 980, type: 'white', balance: 0, creditLimit: 0 },
    { id: 'black', iban: 'UA11BLACK', currencyCode: 980, type: 'black', balance: 1129, creditLimit: 15000000 },
  ], jars: [] };
  const T = 1793900000;
  const byAcc = {
    fop: [
      { id: 'a', time: T, amount: 4900000, description: 'Оплата за договором ТОВ «Філіпс Юкрейн»', mcc: 0 },
      { id: 'b', time: T + 300, amount: -4900000, description: 'Переказ на картку', mcc: 4829 },      // без IBAN і без «білу»
    ],
    white: [
      { id: 'c', time: T + 301, amount: 4900000, description: 'Поповнення', mcc: 4829 },             // пара до b
      { id: 'd', time: T + 900, amount: -3000000, description: 'Погашення наступного платежу', mcc: 0 },
      { id: 'e', time: T + 1200, amount: 2000000, description: 'Сербіненко Євгеній', mcc: 4829 },     // сам собі з іншого банку
    ],
    black: [
      { id: 'f', time: T - 86400, amount: -1600000, description: 'Rozetka', mcc: 5732 },
      { id: 'g', time: T + 600, amount: 1400000, description: 'Rozetka', mcc: 5732 },                // повернення від магазину
    ],
  };
  const ops = allOps(byAcc, info);
  const k = Object.fromEntries(ops.map(o => [o.id.split(':')[1], o.kind]));
  assert.deepEqual(k, { a: 'income', b: 'own', c: 'own', d: 'credit', e: 'own', f: 'spend', g: 'refund' });
  const t = totals(ops);
  assert.equal(t.income, 4900000);                 // а не 49k + 49k + 14k + 20k
  assert.equal(t.refund, 1400000);
  assert.equal(t.spend, 200000);                   // 16 000 − 14 000
  assert.equal(t.byCat['Техніка'], 200000);
});

test('relative with same surname is not "own"', () => {
  const info = { name: 'Сербіненко Євгеній', accounts: [], jars: [] };
  const ops = allOps({ x: [{ id: '1', time: 1, amount: 50000, description: 'Сербіненко Олександр', mcc: 4829 }] }, info);
  assert.equal(ops[0].kind, 'income');
});

test('owner case: cash loan 10 000 → vaccination, Claude Max → repay 10 060 = 60 interest', () => {
  const info = { name: 'Сербіненко Євгеній', accounts: [
    { id: 'white', iban: 'UA22WHITE', currencyCode: 980, type: 'white', balance: 0, creditLimit: 0 },
  ], jars: [] };
  const T = 1793700000;
  const ops = allOps({ white: [
    { id: '1', time: T, amount: 1000000, description: 'Кредит готівкою', mcc: 0 },
    { id: '2', time: T + 3600, amount: -431500, description: 'Медичний центр Добробут', mcc: 8062 },
    { id: '3', time: T + 7200, amount: -497000, description: 'CLAUDE.AI SUBSCRIPTION', mcc: 5817 },
    { id: '4', time: T + 2 * 86400, amount: -1006000, description: 'Погашення кредиту готівкою', mcc: 0 },
  ] }, info);
  const k = Object.fromEntries(ops.map(o => [o.id.split(':')[1], o.kind]));
  assert.deepEqual(k, { 1: 'borrow', 2: 'spend', 3: 'spend', 4: 'repay' });
  const r = ops.find(o => o.kind === 'repay');
  assert.deepEqual([r.principal, r.interest, r.days], [1000000, 6000, 2]);
  const t = totals(ops);
  assert.equal(t.income, 0);                   // кредит — не дохід
  assert.equal(t.credit, 0);                   // тіло кредиту — не витрата
  assert.equal(t.interest, 6000);              // 60 грн відсотків
  assert.equal(t.out, 431500 + 497000 + 6000);
  assert.equal(t.borrowed, 1000000);
});

test('loan not yet repaid stays as borrow; unrelated repayment stays credit', () => {
  const ops = allOps({ w: [
    { id: 'a', time: 100, amount: 500000, description: 'Кредит готівкою', mcc: 0 },
    { id: 'b', time: 200, amount: -106600, description: 'Погашення наступного платежу', mcc: 0 },
  ] }, { accounts: [], jars: [] });
  assert.deepEqual(ops.map(o => o.kind).sort(), ['borrow', 'credit']);
});

test('manual override wins and feeds loan pairing', () => {
  const ops = allOps({ w: [
    { id: 'a', time: 100, amount: 1000000, description: 'Зарахування коштів', mcc: 0 },   // невідомий опис видачі
    { id: 'b', time: 200000, amount: -1006000, description: 'Погашення', mcc: 0 },
  ] }, { accounts: [], jars: [] }, { 'w:a': 'borrow' });
  const k = Object.fromEntries(ops.map(o => [o.id, o.kind]));
  assert.deepEqual(k, { 'w:a': 'borrow', 'w:b': 'repay' });
  assert.equal(totals(ops).interest, 6000);
});

test('installment payout to card is debt; interest-only payment is a cost', () => {
  const ops = allOps({ w: [
    { id: 'a', time: 100, amount: 2000000, description: 'Розстрочка на картку', mcc: 0 },
    { id: 'b', time: 200, amount: -9000, description: 'Сплата відсотків за кредитом готівкою', mcc: 0 },
  ] }, { accounts: [], jars: [] });
  const k = Object.fromEntries(ops.map(o => [o.id, o.kind]));
  assert.deepEqual(k, { 'w:a': 'borrow', 'w:b': 'fee' });
  assert.equal(totals(ops).income, 0);
});
