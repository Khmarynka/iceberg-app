// IcebergView — застосунок. Усе працює в телефоні: токен і дані зашифровані PIN-кодом,
// запити йдуть прямо до monobank. Серверів-посередників немає.
import { Vault, pinDelay, pinFailed, pinOk } from './vault.js';
import * as mono from './mono.js';
import * as P from './plan.js';
import { prepareImage, scanImage, ScanError } from './scan.js';
import { compareOptions, DEFAULT_TARIFFS, breakEvenDays } from './credit.js';
import {
  money, monthStartUnix, kyivDate, MONTHS, MONTHS_GEN, category, totals, ownMoney,
  cardName, CURRENCY, allOps, statementAccounts,
} from './logic.js';

export const VERSION = '0.3.0';
const CACHE_FRESH_MS = 60 * 60 * 1000;   // дані вважаються свіжими 60 хв
const AUTOLOCK_MS = 5 * 60 * 1000;       // блокування після 5 хв у фоні

const app = document.getElementById('app');
const S = { vault: null, token: null, cache: null, prefs: { notMine: [], kinds: {} }, plan: P.emptyPlan(), cal: null, day: null, edit: null, aikey: null, queue: [], tab: 'overview', filter: 'all', open: null, status: null, busy: false };

// ---------------------------------------------------------------- DOM без innerHTML (захист від XSS)
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}
const mount = (...nodes) => app.replaceChildren(...nodes);

// ---------------------------------------------------------------- старт і блокування
async function start() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  (await Vault.exists()) ? viewUnlock() : viewCreatePin();
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (S.vault && hiddenAt && Date.now() - hiddenAt > AUTOLOCK_MS) lock();
});

function lock() {
  Object.assign(S, { advisor: null, vault: null, token: null, cache: null, prefs: { notMine: [], kinds: {} }, plan: P.emptyPlan(), cal: null, day: null, edit: null, aikey: null, queue: [], open: null, status: null, tab: 'overview', filter: 'all' });
  viewUnlock();
}

function brand() {
  return h('div', { class: 'brand' },
    h('img', { class: 'hero-img', src: 'icons/hero-480.jpg', alt: '', width: '240', height: '240' }),
    h('div', { class: 'brand-name' }, 'IcebergView'),
    h('div', { class: 'brand-tag' }, 'Дивись глибше'));
}

function pinInput(id, label) {
  return h('label', { for: id }, label,
    h('input', { id, type: 'password', inputmode: 'numeric', autocomplete: 'off', pattern: '[0-9]*', maxlength: '12' }));
}

function viewCreatePin() {
  const err = h('p', { class: 'err', role: 'alert' });
  const go = async (e) => {
    e.preventDefault();
    const a = document.getElementById('pin1').value, b = document.getElementById('pin2').value;
    if (!/^\d{6,12}$/.test(a)) return (err.textContent = 'PIN — від 6 до 12 цифр.');
    if (a !== b) return (err.textContent = 'PIN-коди не збігаються.');
    btn.disabled = true; err.textContent = '';
    S.vault = await Vault.create(a);
    viewToken();
  };
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Створити PIN');
  mount(h('form', { class: 'wrap center', onsubmit: go },
    brand(),
    h('p', { class: 'muted' }, 'Холодний погляд на твої гроші. Дані живуть лише в цьому телефоні.'),
    h('div', { class: 'note' }, h('b', {}, 'Придумай PIN '), '(6–12 цифр). Ним шифруються токен банку й дані. ',
      'Його ніде не збережено: якщо забудеш — доведеться стерти все й підключити банк заново.'),
    h('div', { class: 'pinpad' }, pinInput('pin1', 'Новий PIN'), pinInput('pin2', 'Ще раз')),
    err, btn));
  document.getElementById('pin1').focus();
}

async function viewUnlock() {
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Відкрити');
  const go = async (e) => {
    e.preventDefault();
    const wait = await pinDelay();
    if (wait > 0) return (err.textContent = `Забагато спроб. Зачекай ${wait} с.`);
    btn.disabled = true; err.textContent = 'Перевіряю…';
    const v = await Vault.unlock(document.getElementById('pin').value);
    btn.disabled = false;
    if (!v) { await pinFailed(); err.textContent = 'Неправильний PIN.'; document.getElementById('pin').value = ''; return; }
    await pinOk();
    S.vault = v;
    S.token = await v.get('token');
    S.cache = await v.get('cache');
    S.prefs = Object.assign({ notMine: [], kinds: {} }, await v.get('prefs'));
    S.plan = Object.assign(P.emptyPlan(), await v.get('plan'));
    S.aikey = await v.get('aikey');
    S.token ? afterUnlock() : viewToken();
  };
  mount(h('form', { class: 'wrap center', onsubmit: go },
    brand(),
    pinInput('pin', 'PIN-код'), err, btn,
    h('button', { class: 'btn ghost small', type: 'button', onclick: viewWipe }, 'Забув PIN')));
  document.getElementById('pin').focus();
}

function viewWipe() {
  mount(h('div', { class: 'wrap center' },
    h('h1', {}, 'Стерти все?'),
    h('p', {}, 'Без PIN дані не розшифрувати. Можна стерти їх із телефона й почати заново: створити новий PIN і знову вставити токен monobank.'),
    h('button', { class: 'btn danger', onclick: async () => { await Vault.wipe(); location.reload(); } }, 'Так, стерти все з цього телефона'),
    h('button', { class: 'btn ghost', onclick: () => (S.vault ? render() : viewUnlock()) }, 'Скасувати')));
}

// ---------------------------------------------------------------- підключення monobank
function viewToken() {
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'Підключити');
  const go = async (e) => {
    e.preventDefault();
    const t = document.getElementById('tok').value.trim();
    if (t.length < 20) return (err.textContent = 'Схоже, токен скопійовано не повністю.');
    btn.disabled = true; err.textContent = 'Перевіряю токен у monobank…';
    try {
      const info = await mono.clientInfo(t);
      await S.vault.set('token', t);
      S.token = t;
      S.cache = { info, infoAt: Date.now(), byAcc: {}, monthStart: 0, fetchedAt: 0 };
      await S.vault.set('cache', S.cache);
      S.tab = 'overview';
      afterUnlock();
    } catch (x) {
      btn.disabled = false;
      err.textContent = x instanceof mono.MonoError ? x.message : 'Не вдалося перевірити токен.';
    }
  };
  mount(h('form', { class: 'wrap center', onsubmit: go },
    h('h1', {}, 'Підключи monobank'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Відкрий ', h('a', { href: 'https://api.monobank.ua/', target: '_blank', rel: 'noopener noreferrer' }, 'api.monobank.ua'), ' на комп’ютері або в іншому браузері.'),
      h('li', {}, 'Відскануй QR-код застосунком mono — зʼявиться токен.'),
      h('li', {}, 'Скопіюй токен і встав сюди.')),
    h('div', { class: 'note' }, 'Токен дає ', h('b', {}, 'лише читання'), ' рахунків і виписки — переказати гроші ним неможливо. ',
      'Він шифрується твоїм PIN і зберігається тільки в цьому телефоні.'),
    h('label', { for: 'tok' }, 'Токен monobank',
      h('input', { id: 'tok', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })),
    err, btn,
    h('button', { class: 'btn ghost small', type: 'button', onclick: lock }, 'Заблокувати')));
}

// ---------------------------------------------------------------- дані
function needsRefresh() {
  const c = S.cache;
  if (!c || !c.fetchedAt) return true;
  if (Date.now() - c.fetchedAt > CACHE_FRESH_MS) return true;
  if (!c.byAcc) return true;                                   // старий формат (лише одна картка)
  const want = statementAccounts(c.info || {}, S.prefs.notMine).map(a => a.id).sort().join();
  if (want !== Object.keys(c.byAcc).sort().join()) return true;
  return c.monthStart !== monthStartUnix(Date.now());
}

function afterUnlock() {
  render();
  if (needsRefresh()) refresh();
}

function setStatus(text, bad = false) { S.status = text ? { text, bad } : null; renderStatus(); }

async function refresh() {
  if (S.busy) return;
  S.busy = true;
  let step = '';
  const onWait = (sec) => setStatus(sec > 0
    ? `${step}monobank дозволяє 1 запит на хвилину — чекаю ${sec} с…`
    : `${step}беру дані з monobank…`);
  try {
    setStatus('Беру дані з monobank…');
    const info = await mono.clientInfo(S.token, onWait);
    const accs = statementAccounts(info, S.prefs.notMine);
    const now = Date.now();
    const from = monthStartUnix(now);
    const old = S.cache && S.cache.monthStart === from && S.cache.byAcc ? S.cache.byAcc : {};
    // одразу показуємо нові баланси, а виписки довантажуємо по одній
    S.cache = { info, infoAt: now, byAcc: {}, monthStart: from, fetchedAt: now, pending: accs.map(a => a.id) };
    for (const a of accs) if (old[a.id]) S.cache.byAcc[a.id] = old[a.id];
    render();
    for (let i = 0; i < accs.length; i++) {
      const a = accs[i];
      step = accs.length > 1 ? `Рахунок ${i + 1} з ${accs.length} (${cardName(a)}): ` : '';
      S.cache.byAcc[a.id] = await mono.statement(S.token, a.id, from, Math.floor(Date.now() / 1000), onWait);
      S.cache.pending = accs.slice(i + 1).map(x => x.id);
      if (S.vault) await S.vault.set('cache', S.cache);
      render();
    }
    delete S.cache.pending;
    S.cache.fetchedAt = Date.now();
    if (S.vault) await S.vault.set('cache', S.cache);
    setStatus(null);
  } catch (x) {
    setStatus(x instanceof mono.MonoError ? x.message : 'Щось пішло не так. Спробуй ще раз.', true);
  } finally {
    S.busy = false;
    if (S.vault) render();
  }
}

// ---------------------------------------------------------------- головний каркас
const TABS = [['overview', '⌂', 'Огляд'], ['plan', '▦', 'План'], ['ops', '⇅', 'Операції'], ['accounts', '▤', 'Рахунки'], ['settings', '⚙︎', 'Ще']];
let statusSlot = null;

function renderStatus() {
  if (!statusSlot) return;
  statusSlot.replaceChildren(S.status
    ? h('div', { class: 'status' + (S.status.bad ? ' bad' : ''), role: 'status' }, h('span', { class: 'dot' }), h('span', {}, S.status.text))
    : '');
}

function render() {
  statusSlot = h('div', {});
  const body = S.edit ? viewEdit() : S.advisor ? viewAdvisor() : { overview: viewOverview, plan: viewPlan, ops: viewOps, accounts: viewAccounts, settings: viewSettings }[S.tab]();
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Розділи' },
    TABS.map(([id, icon, name]) => h('button', {
      type: 'button', 'aria-current': S.tab === id ? 'page' : null,
      onclick: () => { S.tab = id; S.open = null; S.edit = null; S.advisor = null; render(); window.scrollTo(0, 0); },
    }, h('span', { 'aria-hidden': 'true' }, icon), name)));
  mount(h('div', { class: 'wrap' }, statusSlot, body), tabs);
  renderStatus();
}

function header(title) {
  const c = S.cache;
  let sub = 'ще немає даних';
  if (c && c.fetchedAt) {
    const d = kyivDate(Math.floor(c.fetchedAt / 1000));
    sub = `дані на ${d.day} ${MONTHS_GEN[d.month - 1]}, ${d.hm}`;
  }
  return h('div', { class: 'top' },
    h('div', {}, h('h1', {}, title), h('p', { class: 'sub' }, sub)),
    h('button', { class: 'btn ghost small', type: 'button', disabled: S.busy, onclick: refresh }, '↻ Оновити'));
}

function monthOps() {
  const c = S.cache;
  return c && c.byAcc ? allOps(c.byAcc, c.info || {}, S.prefs.kinds || {}) : [];
}

// ---------------------------------------------------------------- Огляд
function bar(parts, scale) {
  return h('div', { class: 'bar' }, parts.filter(p => p[0] > 0).map(([v, cls]) =>
    h('i', { class: cls, style: { width: `${Math.max(1.5, (100 * v) / scale)}%` } })));
}

function viewOverview() {
  const c = S.cache;
  const now = kyivDate(Math.floor(Date.now() / 1000));
  const title = MONTHS[now.month - 1][0].toUpperCase() + MONTHS[now.month - 1].slice(1);
  if (!c || !c.info) return h('div', { class: 'kv' }, header(title), h('p', { class: 'muted' }, 'Дані ще завантажуються.'));
  const t = totals(monthOps());
  const m = ownMoney(c.info, S.prefs.notMine);
  const scale = Math.max(t.income, t.out, 1);

  const have = h('section', { class: 'card' },
    h('h2', {}, 'Що в мене є зараз'),
    h('div', {}, h('div', { class: 'big num' }, money(m.own, 980, { kop: true })), h('p', { class: 'muted small' }, 'своїх грошей на твоїх гривневих картках (без кредитного ліміту)')),
    h('div', { class: 'kv' },
      m.limit ? h('div', { class: 'row' }, h('span', {}, 'Борг кредитки'),
        h('span', { class: 'num ' + (m.debt ? 'c-out' : 'c-in') }, m.debt ? `${money(m.debt, 980, { kop: true })} з ${money(m.limit)}` : 'немає')) : null,
      m.jars ? h('div', { class: 'row' }, h('span', {}, 'У банках (накопичення)'), h('span', { class: 'num' }, money(m.jars, 980, { kop: true }))) : null,
      m.others ? h('div', { class: 'row muted' }, h('span', {}, 'На картках, позначених «не мої»'), h('span', { class: 'num' }, money(m.others, 980, { kop: true }))) : null),
    h('p', { class: 'muted small' }, 'Чужу картку (напр., дитячу) познач у «Рахунках» — тоді вона не рахуватиметься.'));

  const flow = h('section', { class: 'card' },
    h('h2', {}, `Рух грошей з 1 ${MONTHS_GEN[now.month - 1]}`),
    h('div', { class: 'flow' },
      h('div', {}, h('div', { class: 'lbl' }, h('span', {}, '⬇ Прийшло'), h('b', { class: 'num c-in' }, money(t.income))),
        bar([[t.income, 'in']], scale)),
      h('div', {}, h('div', { class: 'lbl' }, h('span', {}, '⬆ Пішло'), h('b', { class: 'num c-out' }, money(t.out))),
        bar([[t.credit, 'oblig'], [t.spend, 'spend'], [t.fee + t.interest, 'fee']], scale))),
    h('div', { class: 'legend' },
      h('span', { class: 'in' }, 'прихід'),
      h('span', { class: 'oblig' }, `погашення ${money(t.credit)}`),
      h('span', { class: 'spend' }, `покупки ${money(t.spend)}`),
      t.fee ? h('span', { class: 'fee' }, `штрафи банку ${money(t.fee)}`) : null,
      t.refund ? h('span', { class: 'own' }, `повернення ${money(t.refund)} (вже відняті з покупок)`) : null,
      t.interest ? h('span', { class: 'fee' }, `відсотки за кредит ${money(t.interest, 980, { kop: true })}`) : null),
    t.borrowed ? h('p', { class: 'muted small' }, `Взято в борг ${money(t.borrowed)}${t.repaid ? `, повернуто ${money(t.repaid)}` : ''} — це не дохід і не витрата; рахую лише відсотки.`) : null,
    h('div', { class: 'net ' + (t.net >= 0 ? 'pos' : 'neg') },
      h('span', {}, t.net >= 0 ? 'Прийшло більше, ніж пішло' : 'Пішло більше, ніж прийшло'),
      h('span', { class: 'num' }, money(t.net, 980, { sign: true }))),
    (t.ownIn + t.ownOut) ? h('p', { class: 'muted small' },
      `Перекази між своїми картками й банками (${money(t.ownIn + t.ownOut)}) не рахую ні в прихід, ні у витрати.`) : null,
    t.fee ? h('p', { class: 'small c-fee' }, `⚠ Банк зняв штрафи чи комісії: ${money(t.fee)}. Деталі — в «Операціях».`) : null);

  const cats = Object.entries(t.byCat).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(t.credit, ...cats.map(x => x[1]), 1);
  const where = h('section', { class: 'card' },
    h('h2', {}, 'Куди пішли гроші'),
    (!cats.length && !t.credit && !t.fee) ? h('p', { class: 'muted' }, 'Витрат цього місяця ще не було.') :
      h('div', { class: 'cats' },
        t.credit ? catRow('Погашення кредитки й розстрочок', t.credit, catMax, 'oblig') : null,
        cats.slice(0, 8).map(([n, v]) => catRow(n, v, catMax, 'spend')),
        t.fee ? catRow('Штрафи й комісії банку', t.fee, catMax, 'fee') : null));

  const free = freeCard();

  return h('div', { class: 'kv' }, header(title), free, have, flow, where,
    h('p', { class: 'muted small' }, (() => {
      const names = statementAccounts(c.info, S.prefs.notMine).map(cardName).join(', ');
      return `Рух — за всіма твоїми гривневими рахунками: ${names}. Перекази між ними не рахуються.`;
    })()));
}

function catRow(name, v, max, cls) {
  return h('div', { class: 'cat' },
    h('div', { class: 'lbl' }, h('span', {}, name), h('span', { class: 'num' }, money(v))),
    bar([[v, cls]], max));
}

// ---------------------------------------------------------------- Операції
const KIND = {
  income: ['↓', 'Прихід'], spend: ['↑', 'Покупка'], credit: ['🔒', 'Обовʼязкове: погашення'],
  fee: ['!', 'Штраф чи комісія банку'], own: ['⇄', 'Між своїми рахунками'],
  refund: ['↩', 'Повернення від магазину (зменшує витрати)'],
  borrow: ['₴', 'Взято в борг (кредит) — не дохід'],
  repay: ['✓', 'Повернення кредиту'],
};
const FILTERS = [['all', 'Усі'], ['income', 'Прихід'], ['spend', 'Покупки'], ['credit', 'Обовʼязкові'], ['fee', 'Штрафи'], ['own', 'Свої перекази'], ['refund', 'Повернення'], ['borrow', 'Кредити']];

function viewOps() {
  const ops = monthOps();
  const shown = S.filter === 'all' ? ops : ops.filter(o => o.kind === S.filter || (S.filter === 'borrow' && o.kind === 'repay'));
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Фільтр' },
    FILTERS.map(([id, name]) => {
      const n = id === 'all' ? ops.length : ops.filter(o => o.kind === id || (id === 'borrow' && o.kind === 'repay')).length;
      return n || id === 'all' ? h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(S.filter === id),
        onclick: () => { S.filter = id; S.open = null; render(); },
      }, `${name} ${n}`) : null;
    }));
  const sum = shown.reduce((s, o) => s + o.amount, 0);
  const groups = [];
  let cur = null;
  for (const o of shown) {
    const d = kyivDate(o.time);
    const key = `${d.day} ${MONTHS_GEN[d.month - 1]}`;
    if (!cur || cur.key !== key) groups.push(cur = { key, ops: [] });
    cur.ops.push(o);
  }
  const now = kyivDate(Math.floor(Date.now() / 1000));
  return h('div', { class: 'kv' },
    header('Операції'),
    chips,
    S.filter !== 'all' && shown.length ? h('div', { class: 'row card flat' }, h('span', {}, `Разом (${shown.length})`),
      h('b', { class: 'num' }, money(sum, 980, { sign: true }))) : null,
    !shown.length ? h('p', { class: 'muted' }, `З 1 ${MONTHS_GEN[now.month - 1]} таких операцій немає.`) : null,
    groups.map(g => [h('div', { class: 'day' }, g.key), h('div', { class: 'ops' }, g.ops.map(opRow))]),
    h('p', { class: 'muted small' }, 'Торкнись операції, щоб побачити деталі.'));
}

function kindFixer(o) {
  const choices = o.amount > 0
    ? [['income', 'Дохід'], ['borrow', 'Кредит (борг)'], ['own', 'Мій переказ'], ['refund', 'Повернення від магазину']]
    : [['spend', 'Покупка'], ['credit', 'Обовʼязкове погашення'], ['own', 'Мій переказ'], ['fee', 'Штраф/комісія']];
  const set = async (kind) => {
    S.prefs.kinds = S.prefs.kinds || {};
    if (kind) S.prefs.kinds[o.id] = kind; else delete S.prefs.kinds[o.id];
    await S.vault.set('prefs', S.prefs);
    render();
  };
  return h('div', { class: 'fix' },
    h('small', {}, o.manual ? 'Тип вказано вручну. Змінити:' : 'Неправильно визначено? Це насправді:'),
    h('div', { class: 'chips' },
      choices.filter(([k]) => k !== o.kind).map(([k, n]) => h('button', { class: 'chip', type: 'button', onclick: (e) => { e.stopPropagation(); set(k); } }, n)),
      o.manual ? h('button', { class: 'chip', type: 'button', onclick: (e) => { e.stopPropagation(); set(null); } }, '↺ Як визначив застосунок') : null));
}

function loanRate(o) {
  const perDay = o.interest / o.principal / o.days;
  return `${(perDay * 100).toFixed(2).replace('.', ',')}% на день, ≈${Math.round(perDay * 365 * 100)}% річних`;
}

function accName(id) {
  const a = ((S.cache && S.cache.info && S.cache.info.accounts) || []).find(x => x.id === id);
  return a ? cardName(a) : '';
}

function opRow(o) {
  const [icon, kindName] = KIND[o.kind];
  const sub = o.kind === 'spend' ? category(o.mcc)
    : o.kind === 'repay' ? `повернення кредиту, відсотки ${money(o.interest, 980, { kop: true })}` : kindName;
  const d = kyivDate(o.time);
  const open = S.open === o.id;
  const row = h('button', {
    class: `op k-${o.kind}`, type: 'button', 'aria-expanded': String(open),
    onclick: () => { S.open = open ? null : o.id; render(); },
  },
  h('span', { class: 'ic', 'aria-hidden': 'true' }, icon),
  h('span', { class: 't' }, h('b', {}, o.desc || '—'), h('small', {}, [d.hm, sub, accName(o.acc)].filter(Boolean).join(' · '))),
  h('span', { class: 'a num' }, money(o.amount, 980, { sign: true })));
  if (!open) return row;
  return [row, h('div', { class: 'more' },
    h('span', {}, `Тип: ${kindName}`),
    o.acc ? h('span', {}, `Рахунок: ${accName(o.acc)}`) : null,
    o.kind === 'spend' ? h('span', {}, `Категорія: ${category(o.mcc)} (MCC ${o.mcc})`) : null,
    o.kind === 'repay' ? h('span', {}, `Тіло кредиту ${money(o.principal)} — не витрата. Відсотки ${money(o.interest, 980, { kop: true })} за ${o.days} дн. ≈ ${loanRate(o)}`) : null,
    o.kind === 'borrow' ? h('span', {}, o.repaidBy ? 'Кредит уже повернуто — див. операцію повернення.' : 'Ще не бачу повернення цього кредиту у виписці.') : null,
    o.balance != null ? h('span', {}, `Баланс після: ${money(o.balance)}`) : null,
    o.cashback ? h('span', {}, `Кешбек: ${money(o.cashback)}`) : null,
    kindFixer(o))];
}

// ---------------------------------------------------------------- Рахунки
function viewAccounts() {
  const info = (S.cache && S.cache.info) || {};
  const full = [], empty = [];
  for (const a of info.accounts || []) {
    const cur = a.currencyCode, bal = +a.balance || 0, lim = +a.creditLimit || 0;
    const name = `${cardName(a)} · ${CURRENCY[cur] || cur}`;
    if (!bal && !lim) { empty.push(name); continue; }
    const mine = !S.prefs.notMine.includes(a.id);
    const lines = [];
    const k = { kop: true };
    if (lim) {
      const diff = bal - lim;
      lines.push(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Кредитний ліміт'), h('span', { class: 'num' }, money(lim, cur, k))));
      lines.push(diff >= 0
        ? h('div', { class: 'row' }, h('span', {}, 'Своїх грошей'), h('b', { class: 'num c-in' }, money(diff, cur, k)))
        : h('div', { class: 'row' }, h('span', {}, 'Борг за кредиткою'), h('b', { class: 'num c-out' }, money(-diff, cur, k))));
      lines.push(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Можна витратити разом із лімітом'), h('span', { class: 'num' }, money(bal, cur, k))));
    } else {
      lines.push(h('div', { class: 'row' }, h('span', {}, 'Баланс'), h('b', { class: 'num' }, money(bal, cur, k))));
    }
    if (cur === 980) {
      lines.push(h('button', {
        class: 'btn ghost small', type: 'button', 'aria-pressed': String(!mine),
        onclick: async () => {
          const set = new Set(S.prefs.notMine);
          mine ? set.add(a.id) : set.delete(a.id);
          S.prefs.notMine = [...set];
          await S.vault.set('prefs', S.prefs);
          render();
          if (needsRefresh()) refresh();   // набір рахунків змінився — довантажити виписки
        },
      }, mine ? 'Це не моя картка (напр., дитяча)' : '↩ Рахувати як мою'));
    }
    full.push(h('div', { class: 'acc' + (mine ? '' : ' notmine') },
      h('div', { class: 'row' }, h('b', {}, name), mine ? null : h('span', { class: 'small muted' }, 'не рахується')), lines));
  }
  const jarsFull = [], jarsEmpty = [];
  for (const j of info.jars || []) {
    const cur = j.currencyCode, bal = +j.balance || 0, goal = +j.goal || 0;
    if (!bal) { jarsEmpty.push(`${j.title}${goal ? ` · ціль ${money(goal, cur)}` : ''}`); continue; }
    jarsFull.push(h('div', { class: 'acc' },
      h('div', { class: 'row' }, h('b', {}, j.title), h('span', { class: 'num' }, money(bal, cur, { kop: true }))),
      goal ? [h('div', { class: 'prog' }, h('i', { style: { width: `${Math.min(100, (100 * bal) / goal)}%` } })),
        h('p', { class: 'muted small' }, `${Math.round((100 * bal) / goal)}% з ${money(goal, cur)}`)] : null));
  }
  return h('div', { class: 'kv' },
    header('Рахунки'),
    h('section', { class: 'card' }, h('h2', {}, 'Картки'), full.length ? full : h('p', { class: 'muted' }, 'Немає карток з грошима.')),
    jarsFull.length ? h('section', { class: 'card' }, h('h2', {}, 'Банки'), jarsFull) : null,
    (empty.length || jarsEmpty.length) ? h('section', { class: 'card flat' },
      h('details', {}, h('summary', {}, `Порожні: ${empty.length + jarsEmpty.length}`),
        h('div', { class: 'kv small' }, empty.map(e => h('span', {}, 'Картка ' + e)), jarsEmpty.map(e => h('span', {}, 'Банка ' + e))))) : null);
}

// ---------------------------------------------------------------- Налаштування
function viewSettings() {
  const msg = h('p', { class: 'err', role: 'alert' });
  const changePin = async (e) => {
    e.preventDefault();
    const a = document.getElementById('np1').value, b = document.getElementById('np2').value;
    if (!/^\d{6,12}$/.test(a)) return (msg.textContent = 'PIN — від 6 до 12 цифр.');
    if (a !== b) return (msg.textContent = 'PIN-коди не збігаються.');
    await S.vault.changePin(a);
    msg.textContent = '✅ PIN змінено.';
    document.getElementById('np1').value = document.getElementById('np2').value = '';
  };
  return h('div', { class: 'kv' },
    h('h1', {}, 'Налаштування'),
    h('section', { class: 'card' },
      h('h2', {}, 'Приватність'),
      h('p', { class: 'small' }, 'Токен monobank і всі дані зберігаються ', h('b', {}, 'лише в цьому телефоні'),
        ' і зашифровані твоїм PIN (AES-256). Запити йдуть прямо в monobank — без наших серверів. ',
        'Після 5 хвилин у фоні застосунок блокується.'),
      h('p', { class: 'small muted' }, 'Якщо видалиш іконку або очистиш дані Safari — дані зникнуть, і банк треба буде підключити знову.')),
    h('form', { class: 'card', onsubmit: changePin },
      h('h2', {}, 'Змінити PIN'), pinInput('np1', 'Новий PIN'), pinInput('np2', 'Ще раз'), msg,
      h('button', { class: 'btn ghost', type: 'submit' }, 'Змінити PIN')),
    aiCard(),
    tariffsCard(),
    h('section', { class: 'card' },
      h('h2', {}, 'monobank'),
      h('button', { class: 'btn ghost', type: 'button', onclick: viewToken }, 'Замінити токен'),
      h('p', { class: 'small muted' }, 'Відкликати токен можна на api.monobank.ua — тоді застосунок втратить доступ до банку.')),
    h('section', { class: 'card' },
      h('button', { class: 'btn ghost', type: 'button', onclick: lock }, 'Заблокувати зараз'),
      h('button', { class: 'btn danger', type: 'button', onclick: viewWipe }, 'Стерти все з цього телефона')),
    h('p', { class: 'muted small' }, `IcebergView ${VERSION}`));
}

function aiCard() {
  const msg = h('p', { class: 'err', role: 'alert' });
  if (S.aikey) {
    return h('section', { class: 'card' },
      h('h2', {}, 'Розпізнавання скрінів (Claude API)'),
      h('p', { class: 'small' }, '✅ Ключ збережено (зашифровано PIN). Кнопка «📷 Зі скріну» — у «Плані».'),
      h('p', { class: 'small muted' }, 'Скрін на час розпізнавання передається в Anthropic, у телефоні не зберігається. ',
        'Ключ можна відкликати на console.anthropic.com.'),
      h('button', { class: 'btn ghost', type: 'button', onclick: async () => { await S.vault.del('aikey'); S.aikey = null; render(); } },
        'Вимкнути й видалити ключ'));
  }
  const save = async (e) => {
    e.preventDefault();
    const k = document.getElementById('aik').value.trim();
    if (!/^sk-ant-[\w-]{20,}$/.test(k)) return (msg.textContent = 'Це не схоже на ключ Claude API (має починатися з sk-ant-).');
    await S.vault.set('aikey', k);
    S.aikey = k;
    document.getElementById('aik').value = '';
    render();
  };
  return h('form', { class: 'card', onsubmit: save },
    h('h2', {}, 'Розпізнавання скрінів (Claude API)'),
    h('p', { class: 'small muted' }, 'Вимкнено. Щоб додавати розстрочки зі скрінів, встав ключ із console.anthropic.com. ',
      'Він зашифрується PIN і зберігатиметься лише в цьому телефоні. Скрін на час розпізнавання передається в Anthropic.'),
    h('label', { for: 'aik' }, 'Ключ Claude API',
      h('input', { id: 'aik', type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' })),
    msg, h('button', { class: 'btn', type: 'submit' }, 'Зберегти ключ'));
}

// ---------------------------------------------------------------- скрін → чернетки
async function onScanFile(file) {
  if (!file) return;
  if (!S.aikey) { S.tab = 'settings'; S.edit = null; render(); return; }
  setStatus('Готую скрін…');
  try {
    const b64 = await prepareImage(file);
    setStatus('Розпізнаю скрін (≈10–20 с)…');
    const t = todayK();
    let drafts = await scanImage(S.aikey, b64, dateStr(t.y, t.m, t.d));
    setStatus(null);
    if (!drafts.length) { setStatus('На скріні не знайшов розстрочок чи платежів. Спробуй інший скрін або «+ Додати» вручну.', true); return; }
    drafts = drafts.map(d => {
      if (!d.count && d.debt && d.payment) d.count = Math.ceil(d.debt / d.payment);   // залишок / платіж
      return d;
    });
    S.queue = drafts.slice(1);
    S.edit = { kind: 'obligations', item: null, draft: drafts[0], n: 1, of: drafts.length };
    render(); window.scrollTo(0, 0);
  } catch (x) {
    setStatus(x instanceof ScanError ? x.message : 'Не вдалося розпізнати скрін. Спробуй ще раз або введи вручну.', true);
  }
}

function nextDraft() {
  const d = S.queue.shift();
  if (d) { S.edit = { kind: 'obligations', item: null, draft: d, n: S.edit.n + 1, of: S.edit.of }; }
  else { S.edit = null; S.tab = 'plan'; }
  render(); window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- План: вільно, календар, зобовʼязання
function todayK() {
  const d = kyivDate(Math.floor(Date.now() / 1000));
  return { y: d.year, m: d.month, d: d.day };
}
const hasPlan = () => (S.plan.obligations.length + S.plan.incomes.length) > 0;
const savePlan = async () => { if (S.vault) await S.vault.set('plan', S.plan); };
const dateStr = (y, m, d) => `${y}-${P.pad(m)}-${P.pad(d)}`;
const nameMonth = (m) => MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1);

function summaryNow() {
  const own = S.cache && S.cache.info ? ownMoney(S.cache.info, S.prefs.notMine).own : 0;
  return P.monthSummary(S.plan, monthOps(), own, todayK());
}

const VERDICT = {
  green: ['ok', 'Є запас. Планові витрати — можна.'],
  yellow: ['warn', 'Обережно: без великих необовʼязкових покупок.'],
  red: ['bad', 'Не вистачає на обовʼязкове. Жодних необдуманих витрат.'],
};

function freeCard() {
  if (!hasPlan()) {
    return h('section', { class: 'card hero' },
      h('h2', {}, 'Вільно до кінця місяця'),
      h('p', {}, 'Щоб я порахував, скільки грошей вільно, додай у «План» очікувані доходи й обовʼязкові платежі.'),
      h('button', { class: 'btn', type: 'button', onclick: () => { S.tab = 'plan'; render(); } }, 'Відкрити План'));
  }
  const s = summaryNow();
  const own = S.cache && S.cache.info ? ownMoney(S.cache.info, S.prefs.notMine).own : 0;
  const [cls, text] = VERDICT[s.color];
  return h('section', { class: `card hero v-${cls}` },
    h('h2', {}, 'Вільно до кінця місяця'),
    h('div', { class: 'big num' }, money(s.free, 980, { kop: false })),
    s.free > 0 ? h('p', { class: 'muted small' }, `≈ ${money(s.perDay)} на день, ${s.daysLeft} дн. до кінця місяця`) : null,
    h('p', { class: 'verdict' }, text),
    h('div', { class: 'kv small eq' },
      h('div', { class: 'row' }, h('span', {}, 'Своїх грошей зараз'), h('span', { class: 'num' }, money(own))),
      h('div', { class: 'row c-in' }, h('span', {}, '+ ще прийде'), h('span', { class: 'num' }, money(s.toCome))),
      h('div', { class: 'row c-oblig' }, h('span', {}, '− ще сплатити обовʼязкове'), h('span', { class: 'num' }, money(s.toPay))),
      h('div', { class: 'row total' }, h('span', {}, '= вільно'), h('b', { class: 'num' }, money(s.free)))),
    s.gap ? h('p', { class: 'alert' }, `⚠ Касовий розрив ${s.gap.day}-го: не вистачить ≈${money(s.gap.short)}, бо платіж раніше, ніж надходження.`) : null,
    s.late.length ? h('p', { class: 'alert' }, `⚠ Не бачу сплати: ${s.late.map(e => e.item.name).join(', ')}. Якщо сплачено — познач у «Плані».`) : null,
    h('div', { class: 'btns left' },
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { S.tab = 'plan'; render(); } }, 'Календар платежів →'),
      advisorButton()));
}

function viewPlan() {
  const t = todayK();
  if (!S.cal) S.cal = { y: t.y, m: t.m };
  const { y, m } = S.cal;
  const isCur = y === t.y && m === t.m;
  const ops = isCur ? monthOps() : [];
  const ev = P.monthEvents(S.plan, y, m).map(e => ({ ...e, st: P.status(e, S.plan, ops, dateStr(t.y, t.m, t.d)) }));
  if (!isCur) for (const e of ev) if (dateStr(y, m, e.d) > dateStr(t.y, t.m, t.d)) e.st = { state: 'plan' };

  const go = (k) => { const n = P.addMonths(y, m, k); S.cal = { y: n.y, m: n.m }; S.day = null; render(); };
  const minMonth = P.addMonths(t.y, t.m, -2), maxMonth = P.addMonths(t.y, t.m, 12);
  const canPrev = y * 12 + m > minMonth.y * 12 + minMonth.m, canNext = y * 12 + m < maxMonth.y * 12 + maxMonth.m;

  // сітка: з понеділка
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const lead = (first + 6) % 7, nd = P.daysIn(y, m);
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cell empty' }));
  for (let d = 1; d <= nd; d++) {
    const dayEv = ev.filter(e => e.d === d);
    const marks = dayEv.map(e => h('i', { class: `dot ${e.type === 'in' ? 'in' : 'out'} ${e.st.state}` }));
    cells.push(h('button', {
      type: 'button',
      class: ['cell', dayEv.length ? 'has' : '', isCur && d === t.d ? 'today' : '', S.day === d ? 'sel' : ''].join(' '),
      'aria-label': `${d} ${MONTHS_GEN[m - 1]}${dayEv.length ? `, подій: ${dayEv.length}` : ''}`,
      onclick: () => { S.day = S.day === d ? null : d; render(); },
    }, h('span', { class: 'n' }, d), h('span', { class: 'dots' }, marks)));
  }
  const outs = ev.filter(e => e.type === 'out'), ins = ev.filter(e => e.type === 'in');
  const sum = (l) => l.reduce((a, e) => a + e.amount, 0);
  const paidOut = sum(outs.filter(e => e.st.state === 'done'));

  const cal = h('section', { class: 'card' },
    h('div', { class: 'calhead' },
      h('button', { class: 'nav', type: 'button', disabled: !canPrev, onclick: () => go(-1), 'aria-label': 'Попередній місяць' }, '‹'),
      h('b', {}, `${nameMonth(m)} ${y}`),
      h('button', { class: 'nav', type: 'button', disabled: !canNext, onclick: () => go(1), 'aria-label': 'Наступний місяць' }, '›')),
    h('div', { class: 'grid wd' }, ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'].map(x => h('span', {}, x))),
    h('div', { class: 'grid' }, cells),
    h('div', { class: 'legend' }, h('span', { class: 'oblig' }, 'платіж'), h('span', { class: 'in' }, 'дохід'),
      h('span', { class: 'own' }, 'виконано'), h('span', { class: 'fee' }, 'не бачу сплати')),
    h('div', { class: 'monthsum' },
      h('div', {}, h('small', {}, 'Платежі за місяць'), h('b', { class: 'num c-oblig' }, money(sum(outs))),
        h('small', { class: 'muted' }, `сплачено ${money(paidOut)} · ще ${money(sum(outs) - paidOut)}`)),
      h('div', {}, h('small', {}, 'Доходи за планом'), h('b', { class: 'num c-in' }, money(sum(ins))),
        h('small', { class: 'muted' }, `надійшло ${money(sum(ins.filter(e => e.st.state === 'done')))}`))));

  const shown = S.day ? ev.filter(e => e.d === S.day) : ev;
  const list = h('section', { class: 'card' },
    h('h2', {}, S.day ? `${S.day} ${MONTHS_GEN[m - 1]}` : `Усе за ${MONTHS[m - 1]}`),
    shown.length ? h('div', { class: 'evlist' }, shown.map(e => eventRow(e, isCur || dateStr(y, m, e.d) <= dateStr(t.y, t.m, t.d))))
      : h('p', { class: 'muted small' }, S.day ? 'Цього дня нічого.' : 'У цьому місяці нічого не заплановано.'));

  const fc = P.forecast(S.plan, t, 6);
  const fmax = Math.max(1, ...fc.map(f => Math.max(f.out, f.inc)));
  const forecast = h('section', { class: 'card' },
    h('h2', {}, 'Прогноз обовʼязкових платежів'),
    h('div', { class: 'cats' }, fc.map(f => h('div', { class: 'cat' },
      h('div', { class: 'lbl' }, h('span', {}, `${nameMonth(f.m)}${f.y !== t.y ? ' ' + f.y : ''}`), h('span', { class: 'num' }, money(f.out))),
      h('div', { class: 'bar' }, f.out ? h('i', { class: 'oblig', style: { width: `${Math.max(1.5, 100 * f.out / fmax)}%` } }) : null),
      f.ending.length ? h('small', { class: 'muted' }, `останній платіж: ${f.ending.join(', ')}`) : null))),
    fc.some(f => f.inc) ? h('p', { class: 'muted small' }, `Доходи за планом: ≈${money(fc[0].inc)} на місяць.`) : null);

  return h('div', { class: 'kv' },
    h('div', { class: 'top' }, h('div', {}, h('h1', {}, 'План'), h('p', { class: 'sub' }, 'календар платежів і доходів')), advisorButton()),
    cal, list,
    itemsCard('Зобовʼязання', 'obligations', 'Розстрочки, кредити, комуналка, підписки…'),
    itemsCard('Очікувані доходи', 'incomes', 'Зарплати, надходження з інших банків…'),
    forecast);
}

function eventRow(e, canMark) {
  const icon = { done: '✓', late: '!', plan: e.type === 'in' ? '↓' : '🔒' }[e.st.state];
  const how = e.st.state === 'done' ? (e.st.how === 'bank' ? 'видно у виписці monobank' : 'позначено вручну')
    : e.st.state === 'late' ? 'дата минула, сплати не бачу' : (e.type === 'in' ? 'очікую' : 'до сплати');
  const manual = e.st.state !== 'done' || e.st.how === 'manual';
  return h('div', { class: `ev t-${e.type} s-${e.st.state}` },
    h('span', { class: 'ic', 'aria-hidden': 'true' }, icon),
    h('span', { class: 't' }, h('b', {}, e.item.name),
      h('small', {}, [`${e.d} ${MONTHS_GEN[e.m - 1]}`, e.item.bank, e.item.count ? `платіж ${e.k + 1} з ${e.item.count}` : null, how].filter(Boolean).join(' · '))),
    h('span', { class: 'a num' }, (e.type === 'in' ? '+' : '−') + money(e.amount)),
    canMark && manual ? h('button', {
      class: 'mark', type: 'button',
      onclick: async () => {
        if (S.plan.marks[e.key]) delete S.plan.marks[e.key]; else S.plan.marks[e.key] = true;
        await savePlan(); render();
      },
    }, e.st.state === 'done' ? 'Скасувати' : (e.type === 'in' ? 'Надійшло' : 'Сплачено')) : null);
}

function scanButton() {
  const input = h('input', { type: 'file', accept: 'image/*', class: 'visually-hidden', id: 'scanfile',
    onchange: (e) => { const f = e.target.files[0]; e.target.value = ''; onScanFile(f); } });
  return h('label', { class: 'btn small ghost filebtn', for: 'scanfile', title: S.aikey ? 'Розпізнати скрін' : 'Спершу додай ключ у «Ще»' },
    '📷 Зі скріну', input);
}

function itemsCard(title, kind, hint) {
  const t = todayK(), ops = monthOps();
  const items = S.plan[kind];
  return h('section', { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, title),
      h('div', { class: 'btns' },
        kind === 'obligations' ? scanButton() : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => { S.edit = { kind, item: null }; render(); window.scrollTo(0, 0); } }, '+ Додати'))),
    !items.length ? h('p', { class: 'muted small' }, hint) : null,
    items.map(it => {
      const amount = kind === 'obligations' ? it.payment : it.amount;
      const rem = kind === 'obligations' ? P.remaining(it, S.plan, ops, t) : null;
      const cost = kind === 'obligations' && it.price && it.total ? P.costOf(it.price, it.total, it.payment) : null;
      const next = nextDate(it, t);
      return h('button', { class: 'item', type: 'button', onclick: () => { S.edit = { kind, item: it }; render(); window.scrollTo(0, 0); } },
        h('span', { class: 't' }, h('b', {}, it.name),
          h('small', {}, [it.bank, next ? `наступний ${next}` : 'завершено', rem ? `лишилось ${rem.left} · ${money(rem.sum)}` : (it.count == null ? 'щомісяця' : null)].filter(Boolean).join(' · ')),
          cost ? h('small', { class: `chip-${cost.color}` }, `${cost.color === 'green' ? '🟢' : cost.color === 'red' ? '🔴' : '🟡'} реальна ставка ${P.pct(cost.annual)} · переплата ${money(cost.overpay)}`) : null),
        h('span', { class: 'a num ' + (kind === 'obligations' ? 'c-oblig' : 'c-in') }, money(amount)));
    }));
}

function nextDate(it, t) {
  for (let k = 0; k < 600; k++) {
    if (it.count != null && k >= it.count) return null;
    const d = P.occurrenceDate(it.first, k);
    if (dateStr(d.y, d.m, d.d) >= dateStr(t.y, t.m, t.d)) return `${d.d} ${MONTHS_GEN[d.m - 1]}`;
  }
  return null;
}

// ---------------------------------------------------------------- форма
function viewEdit() {
  const { kind, item, draft } = S.edit;
  const ob = kind === 'obligations';
  const it = item || draft || {};
  const err = h('p', { class: 'err', role: 'alert' });
  const field = (id, label, attrs = {}, hint) => h('label', { for: id }, label,
    h('input', { id, autocomplete: 'off', ...attrs }), hint ? h('small', { class: 'muted' }, hint) : null);
  const moneyVal = v => (v ? String(v / 100).replace('.', ',') : '');
  const t = todayK();
  const regular = ob ? it.count == null && !!item : true;

  const save = async (e) => {
    e.preventDefault();
    const v = id => (document.getElementById(id)?.value || '').trim();
    const name = v('f-name');
    const amount = P.parseMoney(v('f-amount'));
    const first = v('f-first');
    const isReg = ob ? document.getElementById('f-reg').checked : true;
    const left = isReg ? null : parseInt(v('f-left'), 10);
    if (!name) return (err.textContent = 'Вкажи назву.');
    if (!amount) return (err.textContent = 'Вкажи суму, наприклад 1250 або 1250,50.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first)) return (err.textContent = 'Вкажи дату.');
    if (!isReg && !(left >= 1 && left <= 600)) return (err.textContent = 'Скільки платежів лишилось — від 1 до 600.');
    const rec = {
      id: it.id || P.newId(), name, bank: v('f-bank'), first, count: isReg ? null : left, match: v('f-match'),
    };
    if (ob) {
      rec.payment = amount;
      const price = P.parseMoney(v('f-price')), total = parseInt(v('f-total'), 10);
      if (price) rec.price = price;
      if (total >= 1) rec.total = total;
    } else rec.amount = amount;
    const list = S.plan[kind];
    const i = list.findIndex(x => x.id === rec.id);
    if (i >= 0) list[i] = rec; else list.push(rec);
    await savePlan();
    if (draft) return nextDraft();
    S.edit = null; S.tab = 'plan'; render();
  };
  const del = async () => {
    if (!delBtn.dataset.sure) { delBtn.dataset.sure = '1'; delBtn.textContent = 'Точно видалити? Натисни ще раз'; return; }
    S.plan[kind] = S.plan[kind].filter(x => x.id !== it.id);
    for (const k of Object.keys(S.plan.marks)) if (k.startsWith(it.id + ':')) delete S.plan.marks[k];
    await savePlan(); S.edit = null; render();
  };
  const delBtn = h('button', { class: 'btn danger', type: 'button', onclick: del }, 'Видалити');
  const regBox = ob ? h('label', { class: 'check' },
    h('input', { id: 'f-reg', type: 'checkbox', checked: regular && !!item ? true : null,
      onchange: (e) => { leftWrap.hidden = e.target.checked; costWrap.hidden = e.target.checked; } }),
    h('span', {}, 'Регулярний без кінця (комуналка, підписка, звʼязок)')) : null;
  const leftWrap = field('f-left', 'Скільки платежів лишилось (разом із найближчим)',
    { type: 'text', inputmode: 'numeric', value: it.count ?? '' }, 'Наприклад, «лишилось 4 з 10» → 4');
  const costWrap = h('div', { class: 'kv' },
    h('p', { class: 'small muted' }, 'Для розрахунку вигідності (необовʼязково):'),
    field('f-price', 'Ціна покупки або сума кредиту, грн', { type: 'text', inputmode: 'decimal', value: moneyVal(it.price) }),
    field('f-total', 'Усього платежів за договором', { type: 'text', inputmode: 'numeric', value: it.total ?? '' }));
  if (ob && regular && item) { leftWrap.hidden = true; costWrap.hidden = true; }

  return h('form', { class: 'kv', onsubmit: save },
    h('div', { class: 'top' }, h('h1', {}, item ? 'Змінити' : draft ? `Перевір дані зі скріну${S.edit.of > 1 ? ` (${S.edit.n} з ${S.edit.of})` : ''}` : (ob ? 'Нове зобовʼязання' : 'Новий дохід')),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { if (draft) return nextDraft(); S.edit = null; render(); } }, draft ? 'Пропустити' : 'Скасувати')),
    draft ? h('div', { class: 'note' }, h('b', {}, 'Розпізнано ШІ — перевір кожне поле. '),
      'Порожнє — на скріні не знайшлося, допиши сам.', draft.note ? h('div', {}, `На скріні про ставку: «${draft.note}»`) : null) : null,
    h('section', { class: 'card' },
      field('f-name', 'Назва', { type: 'text', value: it.name || '', placeholder: ob ? 'Розстрочка Comfy, комуналка…' : 'Зарплата Philips…' }),
      field('f-bank', 'Банк або звідки', { type: 'text', value: it.bank || '', list: 'banks', placeholder: 'monobank, ПУМБ, Raiffeisen…' }),
      h('datalist', { id: 'banks' }, ['monobank', 'ПУМБ', 'Raiffeisen', 'ПриватБанк', 'Ощадбанк', 'Готівка'].map(b => h('option', { value: b }))),
      field('f-amount', ob ? 'Платіж на місяць, грн' : 'Сума, грн', { type: 'text', inputmode: 'decimal', value: moneyVal(ob ? it.payment : it.amount) }),
      field('f-first', ob ? 'Дата найближчого платежу' : 'Дата найближчого надходження',
        { type: 'date', value: it.first || dateStr(t.y, t.m, t.d) }, 'Далі — щомісяця того ж числа'),
      regBox, ob ? leftWrap : null),
    ob ? h('section', { class: 'card' }, costWrap) : null,
    h('section', { class: 'card' },
      field('f-match', 'Слово для автопошуку у виписці monobank (необовʼязково)', { type: 'text', value: it.match || '',
        placeholder: ob ? 'частинами, Comfy, Погашення…' : 'Філіпс, ДДМУ…' },
      'Якщо у виписці буде операція з цим словом і схожою сумою (±10%) — позначу ✓ сам.')),
    err,
    h('button', { class: 'btn', type: 'submit' }, 'Зберегти'),
    item ? delBtn : null);
}


// ---------------------------------------------------------------- Порадник: як дешевше взяти гроші
function advisorButton() {
  return h('button', { class: 'btn ghost small', type: 'button', onclick: () => { S.advisor = S.advisor || { amount: '', days: 30, partner: false, goal: '' }; render(); window.scrollTo(0, 0); } }, '💡 Як дешевше взяти гроші');
}
const tariffs = () => ({ ...DEFAULT_TARIFFS, ...(S.prefs.tariffs || {}) });

function viewAdvisor() {
  const A = S.advisor;
  const amount = P.parseMoney(A.amount);
  const read = () => {
    A.amount = document.getElementById('a-amt').value;
    A.goal = document.getElementById('a-goal').value;
    A.partner = document.getElementById('a-partner').checked;
    const d = parseInt(document.getElementById('a-days').value, 10);
    if (d > 0) A.days = Math.min(730, d);
  };
  const calc = (e) => { e && e.preventDefault(); read(); render(); };
  const presets = [[7, 'тиждень'], [14, '2 тижні'], [30, 'місяць'], [90, '3 міс.'], [180, 'півроку'], [365, 'рік']];

  const form = h('form', { class: 'card', onsubmit: calc },
    h('label', { for: 'a-amt' }, 'Скільки потрібно, грн', h('input', { id: 'a-amt', type: 'text', inputmode: 'decimal', value: A.amount, placeholder: '10 000' })),
    h('label', { for: 'a-days' }, 'Коли зможеш повернути (днів)', h('input', { id: 'a-days', type: 'text', inputmode: 'numeric', value: String(A.days) })),
    h('div', { class: 'chips' }, presets.map(([d, n]) => h('button', {
      class: 'chip', type: 'button', 'aria-pressed': String(A.days === d),
      onclick: () => { read(); A.days = d; render(); },
    }, n))),
    h('label', { for: 'a-goal' }, 'На що (необовʼязково)', h('input', { id: 'a-goal', type: 'text', value: A.goal, placeholder: 'ремонт авто, техніка, до зарплати…' })),
    h('label', { class: 'check' }, h('input', { id: 'a-partner', type: 'checkbox', checked: A.partner ? true : null }),
      h('span', {}, 'Купую в магазині, де є «Покупка частинами»')),
    h('button', { class: 'btn', type: 'submit' }, 'Порахувати'));

  const out = [];
  if (amount) {
    const r = compareOptions(amount, A.days, { partner: A.partner, tariffs: tariffs() });
    const free = hasPlan() ? summaryNow().free : null;
    if (free != null && free >= amount) {
      out.push(h('section', { class: 'card hero v-ok' }, h('h2', {}, 'Можна без кредиту'),
        h('p', {}, `За планом у тебе вільно ${money(free)} до кінця місяця — це більше за ${money(amount)}. Кредит не потрібен, якщо це не зачепить обовʼязкові платежі.`)));
    }
    out.push(h('section', { class: 'card' },
      h('h2', {}, `${money(amount)} на ${A.days} дн.${A.goal ? ` · ${A.goal}` : ''}`),
      r.options.map((o, i) => h('div', { class: 'opt' + (i === 0 ? ' best' : '') },
        h('div', { class: 'row' }, h('b', {}, (i === 0 ? '✅ ' : '') + o.name), h('b', { class: 'num ' + (o.cost ? 'c-out' : 'c-in') }, o.cost ? `переплата ${money(o.cost)}` : 'без переплати')),
        h('small', {}, o.how),
        h('small', {}, `Віддаси разом ${money(o.total)} · ${o.schedule}`),
        (o.annualEffective ?? o.annualSimple) ? h('small', { class: 'muted' }, o.annualEffective != null
          ? `реальна ставка ≈${Math.round(o.annualEffective * 100)}% річних (з урахуванням щомісячних платежів)`
          : `≈${Math.round(o.annualSimple * 100)}% річних`) : null,
        o.note ? h('small', { class: 'c-fee' }, o.note) : null,
        free != null && o.payment ? h('small', { class: o.payment > Math.max(free, 0) ? 'c-out' : 'muted' },
          `Щомісячний платіж ${money(o.payment)} — ${free > 0 ? `${Math.round(100 * o.payment / free)}% від вільних цього місяця` : 'а вільних грошей цього місяця немає'}`) : null)),
      h('p', { class: 'small' }, `Правило: до ≈${r.breakEvenDays} днів дешевше кредит готівкою (платиш по днях), довше — розстрочка (комісія одразу за ${tariffs().instMinMonths}+ міс.). У магазині-партнері — Покупка частинами, 0%.`),
      h('p', { class: 'muted small' }, 'Тарифи — за паспортом кредиту monobank, змінити: «Ще → Тарифи». Це розрахунок, а не порада: рішення — за тобою.')));
  }
  return h('div', { class: 'kv' },
    h('div', { class: 'top' }, h('h1', {}, 'Як дешевше взяти гроші'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: () => { S.advisor = null; render(); } }, 'Закрити')),
    form, out);
}

function tariffsCard() {
  const t = tariffs();
  const msg = h('p', { class: 'err', role: 'alert' });
  const pct = v => String(+(v * 100).toFixed(3)).replace('.', ',');
  const save = async (e) => {
    e.preventDefault();
    const n = id => parseFloat(document.getElementById(id).value.replace(',', '.'));
    const cash = n('t-cash') / 100, inst = n('t-inst') / 100, min = Math.round(n('t-min')), cmin = Math.round(n('t-cmin'));
    if (!(cash > 0 && cash < 0.05 && inst > 0 && inst < 0.1 && min >= 1 && min <= 24 && cmin >= 1 && cmin <= 30)) return (msg.textContent = 'Перевір числа.');
    S.prefs.tariffs = { cashPerDay: cash, cashMinDays: cmin, instPerMonth: inst, instMinMonths: min };
    await S.vault.set('prefs', S.prefs);
    msg.textContent = '✅ Збережено.';
  };
  const reset = async () => { delete S.prefs.tariffs; await S.vault.set('prefs', S.prefs); render(); };
  const f = (id, label, v) => h('label', { for: id }, label, h('input', { id, type: 'text', inputmode: 'decimal', value: v }));
  return h('form', { class: 'card', onsubmit: save },
    h('h2', {}, 'Тарифи для порадника (monobank)'),
    f('t-cash', 'Кредит готівкою: % на день', pct(t.cashPerDay)),
    f('t-cmin', 'Кредит готівкою: мінімум днів відсотків (уточни в договорі)', String(t.cashMinDays)),
    f('t-inst', 'Розстрочка на картку: % комісії за кожен місяць', pct(t.instPerMonth)),
    f('t-min', 'Розстрочка: мінімум місяців', String(t.instMinMonths)),
    h('p', { class: 'small muted' }, 'За замовчуванням — з паспорта споживчого кредиту monobank (листопад 2026). Якщо банк змінить умови — виправ тут.'),
    msg,
    h('div', { class: 'btns left' }, h('button', { class: 'btn small', type: 'submit' }, 'Зберегти'),
      S.prefs.tariffs ? h('button', { class: 'btn ghost small', type: 'button', onclick: reset }, 'Як у банку за замовчуванням') : null));
}

start().catch(() => mount(h('div', { class: 'wrap center' }, h('p', { class: 'err' }, 'Не вдалося запустити. Онови сторінку.'))));
