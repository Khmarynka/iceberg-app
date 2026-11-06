// IcebergView — план: зобовʼязання (розстрочки, кредити, регулярні платежі) і очікувані доходи.
// Чиста логіка без браузера. Суми — у копійках, дати — 'YYYY-MM-DD' (київський календар).
//
// Модель: кожен запис має першу дату (найближчий платіж на момент внесення) і кількість платежів
// (для регулярних — без кінця). Розклад з них виводиться, а не зберігається, тож нічого не «зсувається».
// Позначка «сплачено/надійшло» за місяць — або вручну (marks), або автоматично з виписки monobank.

// ---------------------------------------------------------------- дати

export const pad = n => String(n).padStart(2, '0');
export const ym = (y, m) => `${y}-${pad(m)}`;
export const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

export function addMonths(y, m, k) {
  const t = y * 12 + (m - 1) + k;
  return { y: Math.floor(t / 12), m: (t % 12) + 1 };
}

/** Дата платежу №k (0 — перший) з урахуванням коротких місяців: 31-ше → 30/28. */
export function occurrenceDate(first, k) {
  const f = parseDate(first);
  const { y, m } = addMonths(f.y, f.m, k);
  return { y, m, d: Math.min(f.d, daysIn(y, m)) };
}

const monthsBetween = (a, b) => (b.y * 12 + b.m) - (a.y * 12 + a.m);

/** Усі платежі запису в даному місяці (0 або 1). */
export function occurrenceIn(item, y, m) {
  const f = parseDate(item.first);
  const k = monthsBetween(f, { y, m });
  if (k < 0) return null;
  if (item.count != null && k >= item.count) return null;
  const d = occurrenceDate(item.first, k);
  return { ...d, k, key: `${item.id}:${ym(y, m)}`, item };
}

export function monthEvents(plan, y, m) {
  const ev = [];
  for (const o of plan.obligations || []) {
    const e = occurrenceIn(o, y, m);
    if (e) ev.push({ ...e, type: 'out', amount: o.payment });
  }
  for (const i of plan.incomes || []) {
    const e = occurrenceIn(i, y, m);
    if (e) ev.push({ ...e, type: 'in', amount: i.amount });
  }
  return ev.sort((a, b) => a.d - b.d || (a.type === 'in' ? -1 : 1));
}

// ---------------------------------------------------------------- автопошук у виписці

const norm = s => (s || '').toLowerCase().replace(/[«»"'’ʼ]/g, '').trim();

/** Чи є у виписці цього місяця операція, що закриває подію (за словом і сумою ±10%). */
export function matchOp(event, ops) {
  const word = norm(event.item.match);
  if (!word) return null;
  const want = event.amount;
  return ops.find(o => {
    if (event.type === 'out' ? o.amount >= 0 : o.amount <= 0) return false;
    if (!norm(o.desc).includes(word)) return false;
    const a = Math.abs(o.amount);
    return !want || Math.abs(a - want) <= want * 0.10;
  }) || null;
}

/** Статус події: done (вручну чи з виписки), late (дата минула), plan (попереду). */
export function status(event, plan, ops, todayStr) {
  if ((plan.marks || {})[event.key]) return { state: 'done', how: 'manual' };
  const op = matchOp(event, ops);
  if (op) return { state: 'done', how: 'bank', op };
  const date = `${event.y}-${pad(event.m)}-${pad(event.d)}`;
  return { state: date < todayStr ? 'late' : 'plan' };
}

// ---------------------------------------------------------------- місяць: скільки ще і чи вистачить

/**
 * own — своїх грошей зараз (копійки), ops — операції поточного місяця з виписки,
 * today — {y,m,d}. Повертає підсумки місяця, «вільно» і перший касовий розрив.
 */
export function monthSummary(plan, ops, own, today) {
  const todayStr = `${today.y}-${pad(today.m)}-${pad(today.d)}`;
  const ev = monthEvents(plan, today.y, today.m).map(e => ({ ...e, st: status(e, plan, ops, todayStr) }));
  const sum = (list) => list.reduce((s, e) => s + e.amount, 0);
  const outs = ev.filter(e => e.type === 'out'), ins = ev.filter(e => e.type === 'in');
  const outLeft = outs.filter(e => e.st.state !== 'done');
  const inLeft = ins.filter(e => e.st.state !== 'done' && e.d >= today.d);   // минулі неотримані не рахуємо як «ще прийде»
  const toPay = sum(outLeft), toCome = sum(inLeft);
  const free = own + toCome - toPay;
  const daysLeft = daysIn(today.y, today.m) - today.d + 1;

  // касовий розрив: йдемо по днях — прострочене списуємо сьогодні
  let bal = own, gap = null;
  const byDay = new Map();
  for (const e of [...outLeft, ...inLeft]) {
    const day = Math.max(e.d, today.d);
    byDay.set(day, (byDay.get(day) || 0) + (e.type === 'in' ? e.amount : -e.amount));
  }
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    // у межах дня спершу надходження, потім списання — оптимістично, але чесно для «того ж дня»
    bal += byDay.get(day);
    if (bal < 0 && !gap) gap = { day, short: -bal };
  }

  const plannedIncome = sum(ins);
  let color = 'green';
  if (free < 0) color = 'red';
  else if (free < Math.max(plannedIncome * 0.10, 100000) || gap) color = 'yellow';

  return {
    events: ev, toPay, toCome, free, daysLeft, perDay: free > 0 ? Math.floor(free / daysLeft) : 0,
    paid: sum(outs) - toPay, outTotal: sum(outs), inTotal: plannedIncome, inDone: sum(ins.filter(e => e.st.state === 'done')),
    late: outs.filter(e => e.st.state === 'late'), gap, color,
  };
}

/** Прогноз обовʼязкових платежів і доходів на N місяців уперед (з поточного). */
export function forecast(plan, today, n = 6) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const { y, m } = addMonths(today.y, today.m, k);
    const ev = monthEvents(plan, y, m);
    out.push({
      y, m,
      out: ev.filter(e => e.type === 'out').reduce((s, e) => s + e.amount, 0),
      inc: ev.filter(e => e.type === 'in').reduce((s, e) => s + e.amount, 0),
      ending: (plan.obligations || []).filter(o => o.count != null && occurrenceIn(o, y, m)?.k === o.count - 1).map(o => o.name),
    });
  }
  return out;
}

/** Що лишилось сплатити за записом: кількість і сума (від поточного місяця включно, без сплачених). */
export function remaining(item, plan, ops, today) {
  if (item.count == null) return null;
  let n = 0;
  const todayStr = `${today.y}-${pad(today.m)}-${pad(today.d)}`;
  for (let k = 0; k < item.count; k++) {
    const d = occurrenceDate(item.first, k);
    if (monthsBetween({ y: today.y, m: today.m }, d) < 0) continue;     // минулі місяці — вважаємо сплаченими
    const e = occurrenceIn(item, d.y, d.m);
    if (d.y === today.y && d.m === today.m && status({ ...e, type: 'out', amount: item.payment }, plan, ops, todayStr).state === 'done') continue;
    n++;
  }
  return { left: n, sum: n * item.payment };
}

// ---------------------------------------------------------------- вигідність (та сама математика, що в боті)

export function monthlyRate(principal, n, payment) {
  const total = n * payment;
  if (total <= principal * (1 + 1e-9)) return 0;
  const pv = r => payment * (1 - (1 + r) ** -n) / r;
  let lo = 1e-12, hi = 1;
  while (pv(hi) > principal && hi < 1e6) hi *= 2;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pv(mid) > principal) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** price — ціна/сума кредиту, n — усього платежів за договором, payment — платіж (копійки). */
export function costOf(price, n, payment) {
  if (!price || !n || !payment) return null;
  const total = n * payment;
  const overpay = Math.max(0, total - price);
  const share = overpay / price;
  const r = monthlyRate(price, n, payment);
  const annual = (1 + r) ** 12 - 1;
  let color = 'yellow', why = 'помірна переплата';
  if (total < price * 0.98) { color = 'yellow'; why = 'сума платежів менша за ціну — перевір числа'; }
  else if (share <= 0.01) { color = 'green'; why = 'переплати майже немає'; }
  else if (annual >= 0.30) { color = 'red'; why = 'висока реальна ставка'; }
  return { total, overpay, share, annual, color, why };
}

export function pct(x) {
  if (x >= 10) return `${Math.round(x * 100).toLocaleString('uk-UA')}%`;
  return `${(x * 100).toFixed(1).replace('.', ',')}%`;
}

// ---------------------------------------------------------------- ввід

/** '10 000', '1123,50', '10к', '15 тис' → копійки або null. */
export function parseMoney(text) {
  let t = String(text ?? '').trim().toLowerCase().replace(/грн|₴/g, '').replace(/[\s ]/g, '');
  let mult = 1;
  const m = t.match(/(к|k|тис\.?|тисяч[аі]?)$/);
  if (m) { mult = 1000; t = t.slice(0, m.index); }
  t = t.replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const v = Math.round(parseFloat(t) * mult * 100);
  return v > 0 && v < 1e13 ? v : null;
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export const emptyPlan = () => ({ obligations: [], incomes: [], marks: {} });
