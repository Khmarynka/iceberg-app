// IcebergView — застосунок. Усе працює в телефоні: токен і дані зашифровані PIN-кодом,
// запити йдуть прямо до monobank. Серверів-посередників немає.
import { Vault, pinDelay, pinFailed, pinOk } from './vault.js';
import * as mono from './mono.js';
import {
  money, monthStartUnix, kyivDate, MONTHS, MONTHS_GEN, category, toOps, totals, ownMoney,
  mainAccount, cardName, CURRENCY,
} from './logic.js';

export const VERSION = '0.1.0';
const CACHE_FRESH_MS = 60 * 60 * 1000;   // дані вважаються свіжими 60 хв
const AUTOLOCK_MS = 5 * 60 * 1000;       // блокування після 5 хв у фоні

const app = document.getElementById('app');
const S = { vault: null, token: null, cache: null, tab: 'overview', filter: 'all', open: null, status: null, busy: false };

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
  Object.assign(S, { vault: null, token: null, cache: null, open: null, status: null });
  viewUnlock();
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
    h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
    h('h1', {}, 'IcebergView'),
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
    S.token ? afterUnlock() : viewToken();
  };
  mount(h('form', { class: 'wrap center', onsubmit: go },
    h('img', { class: 'logo', src: 'icons/icon-192.png', alt: '' }),
    h('h1', {}, 'IcebergView'),
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
      S.cache = { info, infoAt: Date.now(), items: [], monthStart: 0, fetchedAt: 0 };
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
  const onWait = (s) => setStatus(s > 0 ? `monobank дозволяє 1 запит на хвилину — чекаю ${s} с…` : 'Беру дані з monobank…');
  try {
    setStatus('Беру дані з monobank…');
    const info = await mono.clientInfo(S.token, onWait);
    const acc = mainAccount(info);
    const now = Date.now();
    const from = monthStartUnix(now);
    const items = acc ? await mono.statement(S.token, acc.id, from, Math.floor(now / 1000), onWait) : [];
    S.cache = { info, infoAt: now, items, monthStart: from, fetchedAt: now, account: acc && acc.id };
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
const TABS = [['overview', '⌂', 'Огляд'], ['ops', '⇅', 'Операції'], ['accounts', '▤', 'Рахунки'], ['settings', '⚙︎', 'Налаштування']];
let statusSlot = null;

function renderStatus() {
  if (!statusSlot) return;
  statusSlot.replaceChildren(S.status
    ? h('div', { class: 'status' + (S.status.bad ? ' bad' : ''), role: 'status' }, h('span', { class: 'dot' }), h('span', {}, S.status.text))
    : '');
}

function render() {
  statusSlot = h('div', {});
  const body = { overview: viewOverview, ops: viewOps, accounts: viewAccounts, settings: viewSettings }[S.tab]();
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Розділи' },
    TABS.map(([id, icon, name]) => h('button', {
      type: 'button', 'aria-current': S.tab === id ? 'page' : null,
      onclick: () => { S.tab = id; S.open = null; render(); window.scrollTo(0, 0); },
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
  return c && c.items ? toOps(c.items, c.info || {}) : [];
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
  const m = ownMoney(c.info);
  const scale = Math.max(t.income, t.out, 1);

  const have = h('section', { class: 'card' },
    h('h2', {}, 'Що в мене є зараз'),
    h('div', {}, h('div', { class: 'big num' }, money(m.own)), h('p', { class: 'muted small' }, 'своїх грошей на гривневих картках')),
    h('div', { class: 'kv' },
      m.limit ? h('div', { class: 'row' }, h('span', {}, 'Борг за кредиткою'),
        h('span', { class: 'num ' + (m.debt ? 'c-out' : 'c-in') }, m.debt ? `${money(m.debt)} з ${money(m.limit)}` : 'немає')) : null,
      m.jars ? h('div', { class: 'row' }, h('span', {}, 'У банках (накопичення)'), h('span', { class: 'num' }, money(m.jars))) : null));

  const flow = h('section', { class: 'card' },
    h('h2', {}, `Рух грошей з 1 ${MONTHS_GEN[now.month - 1]}`),
    h('div', { class: 'flow' },
      h('div', {}, h('div', { class: 'lbl' }, h('span', {}, '⬇ Прийшло'), h('b', { class: 'num c-in' }, money(t.income))),
        bar([[t.income, 'in']], scale)),
      h('div', {}, h('div', { class: 'lbl' }, h('span', {}, '⬆ Пішло'), h('b', { class: 'num c-out' }, money(t.out))),
        bar([[t.credit, 'oblig'], [t.spend, 'spend'], [t.fee, 'fee']], scale))),
    h('div', { class: 'legend' },
      h('span', { class: 'in' }, 'прихід'),
      h('span', { class: 'oblig' }, `погашення ${money(t.credit)}`),
      h('span', { class: 'spend' }, `покупки ${money(t.spend)}`),
      t.fee ? h('span', { class: 'fee' }, `штрафи банку ${money(t.fee)}`) : null),
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

  const soon = h('section', { class: 'card flat' },
    h('h2', {}, 'Далі: вільно до кінця місяця'),
    h('p', { class: 'small muted' },
      'Наступним кроком додаси очікувані доходи (зарплати, інші банки) і обовʼязкові платежі (розстрочки, комуналка). ',
      'Тоді тут буде головне: скільки ще прийде, скільки ще треба сплатити і скільки вільно.'));

  return h('div', { class: 'kv' }, header(title), have, flow, where, soon,
    h('p', { class: 'muted small' }, 'Рух — за основною гривневою карткою monobank.'));
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
};
const FILTERS = [['all', 'Усі'], ['income', 'Прихід'], ['spend', 'Покупки'], ['credit', 'Обовʼязкові'], ['fee', 'Штрафи'], ['own', 'Свої перекази']];

function viewOps() {
  const ops = monthOps();
  const shown = S.filter === 'all' ? ops : ops.filter(o => o.kind === S.filter);
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Фільтр' },
    FILTERS.map(([id, name]) => {
      const n = id === 'all' ? ops.length : ops.filter(o => o.kind === id).length;
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

function opRow(o) {
  const [icon, kindName] = KIND[o.kind];
  const sub = o.kind === 'spend' ? category(o.mcc) : kindName;
  const d = kyivDate(o.time);
  const open = S.open === o.id;
  const row = h('button', {
    class: `op k-${o.kind}`, type: 'button', 'aria-expanded': String(open),
    onclick: () => { S.open = open ? null : o.id; render(); },
  },
  h('span', { class: 'ic', 'aria-hidden': 'true' }, icon),
  h('span', { class: 't' }, h('b', {}, o.desc || '—'), h('small', {}, `${d.hm} · ${sub}`)),
  h('span', { class: 'a num' }, money(o.amount, 980, { sign: true })));
  if (!open) return row;
  return [row, h('div', { class: 'more' },
    h('span', {}, `Тип: ${kindName}`),
    o.kind === 'spend' ? h('span', {}, `Категорія: ${category(o.mcc)} (MCC ${o.mcc})`) : null,
    o.balance != null ? h('span', {}, `Баланс після: ${money(o.balance)}`) : null,
    o.cashback ? h('span', {}, `Кешбек: ${money(o.cashback)}`) : null)];
}

// ---------------------------------------------------------------- Рахунки
function viewAccounts() {
  const info = (S.cache && S.cache.info) || {};
  const full = [], empty = [];
  for (const a of info.accounts || []) {
    const cur = a.currencyCode, bal = +a.balance || 0, lim = +a.creditLimit || 0;
    const name = `${cardName(a)} · ${CURRENCY[cur] || cur}`;
    if (!bal && !lim) { empty.push(name); continue; }
    const lines = [];
    if (lim) {
      const diff = bal - lim;
      lines.push(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Кредитний ліміт'), h('span', { class: 'num' }, money(lim, cur))));
      lines.push(diff >= 0
        ? h('div', { class: 'row' }, h('span', {}, 'Своїх грошей'), h('b', { class: 'num c-in' }, money(diff, cur)))
        : h('div', { class: 'row' }, h('span', {}, 'Борг за кредиткою'), h('b', { class: 'num c-out' }, money(-diff, cur))));
      lines.push(h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Можна витратити разом із лімітом'), h('span', { class: 'num' }, money(bal, cur))));
    } else {
      lines.push(h('div', { class: 'row' }, h('span', {}, 'Баланс'), h('b', { class: 'num' }, money(bal, cur))));
    }
    full.push(h('div', { class: 'acc' }, h('b', {}, name), lines));
  }
  const jarsFull = [], jarsEmpty = [];
  for (const j of info.jars || []) {
    const cur = j.currencyCode, bal = +j.balance || 0, goal = +j.goal || 0;
    if (!bal) { jarsEmpty.push(`${j.title}${goal ? ` · ціль ${money(goal, cur)}` : ''}`); continue; }
    jarsFull.push(h('div', { class: 'acc' },
      h('div', { class: 'row' }, h('b', {}, j.title), h('span', { class: 'num' }, money(bal, cur))),
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
    h('section', { class: 'card' },
      h('h2', {}, 'monobank'),
      h('button', { class: 'btn ghost', type: 'button', onclick: viewToken }, 'Замінити токен'),
      h('p', { class: 'small muted' }, 'Відкликати токен можна на api.monobank.ua — тоді застосунок втратить доступ до банку.')),
    h('section', { class: 'card' },
      h('button', { class: 'btn ghost', type: 'button', onclick: lock }, 'Заблокувати зараз'),
      h('button', { class: 'btn danger', type: 'button', onclick: viewWipe }, 'Стерти все з цього телефона')),
    h('p', { class: 'muted small' }, `IcebergView ${VERSION}`));
}

start().catch(() => mount(h('div', { class: 'wrap center' }, h('p', { class: 'err' }, 'Не вдалося запустити. Онови сторінку.'))));
