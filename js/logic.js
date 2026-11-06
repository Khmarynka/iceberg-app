// IcebergView — чиста логіка без браузера: гроші, дати (Київ), класифікація операцій, підсумки.
// Перенесено з Telegram-бота (mono_view.py), щоб правила були однакові.

export const KYIV = 'Europe/Kyiv';

export const CURRENCY = { 980: 'грн', 840: '$', 978: '€' };

export function money(minor, currency = 980, { sign = false, kop = false } = {}) {
  const abs = Math.abs(Math.round(minor));
  let s = (kop ? Math.floor(abs / 100) : Math.round(abs / 100)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0');
  if (kop) s += ',' + String(abs % 100).padStart(2, '0');
  const pre = minor < 0 ? '−' : (sign && minor > 0 ? '+' : '');
  return `${pre}${s} ${CURRENCY[currency] ?? ''}`.trim();
}

// ---- дати в київському часі

function kyivParts(ms) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: KYIV, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/** Unix-секунди початку місяця (00:00 за Києвом). back=1 — попередній місяць. */
export function monthStartUnix(nowMs, back = 0) {
  const p = kyivParts(nowMs);
  let y = p.y, m = p.m - back;
  while (m <= 0) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  const guess = Date.UTC(y, m - 1, 1, 0, 0, 0);
  const g = kyivParts(guess);
  const offset = Date.UTC(g.y, g.m - 1, g.d, g.h, g.min, g.s) - guess;  // скільки Київ попереду UTC
  return Math.floor((guess - offset) / 1000);
}

export function kyivDate(unix) {
  const p = kyivParts(unix * 1000);
  return { day: p.d, month: p.m, year: p.y, hm: `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}` };
}

export const MONTHS = ['січень', 'лютий', 'березень', 'квітень', 'травень', 'червень', 'липень',
  'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'];
export const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня',
  'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

// ---- категорії за MCC

const MCC_GROUPS = [
  ['Продукти', [5411, 5412, 5422, 5441, 5451, 5462, 5499, 5300, 5921]],
  ['Кафе й ресторани', [5812, 5813, 5814]],
  ['Пальне й авто', [5541, 5542, 5983, 5531, 5533, 7538, 7542, 7523]],
  ['Аптеки й медицина', [5912, 8011, 8021, 8043, 8062, 8071, 8099]],
  ['Транспорт і таксі', [4111, 4121, 4131, 4789, 4112]],
  ['Звʼязок і підписки', [4814, 4899, 4816, 5815, 5816, 5817, 5818]],
  ['Комунальні', [4900]],
  ['Одяг і магазини', [5311, 5310, 5331, 5399, 5651, 5655, 5661, 5691, 5699, 5948]],
  ['Техніка', [5732, 5734, 5722, 5045]],
  ['Дім і ремонт', [5200, 5211, 5251, 5261, 5712, 5719]],
  ['Перекази й готівка', [4829, 6010, 6011, 6012, 6538, 6540]],
];

export function category(mcc) {
  for (const [name, codes] of MCC_GROUPS) if (codes.includes(+mcc)) return name;
  return 'Інше';
}

// ---- класифікація
// income — надходження від інших; own — між своїми рахунками й банками (не рахується);
// credit — погашення кредитки/розстрочок (обовʼязкове); fee — штрафи банку; spend — покупки.

const FEE_WORDS = ['перевищення', 'комісі', 'штраф', 'пеня', 'відсотки за', 'плата за обслуговування'];
const CREDIT_WORDS = ['погашення', 'частин', 'розстроч', 'кредит', 'instalment', 'installment'];
const OWN_RE = /^(з|на|із)\s+(чорн|біл|залізн|платинов|жовт|фоп|єпідтрим|банк|гривнев|доларов|євро)|між своїми|власн\S* рахун|поповнення банки|з банки|на банку/;

export function ownMarkers(info) {
  const ibans = new Set((info.accounts || []).map(a => a.iban).filter(Boolean));
  const jars = (info.jars || []).map(j => (j.title || '').toLowerCase()).filter(Boolean);
  // імʼя й прізвище власника: переказ «від/на себе» — свій (потрібні ОБИДВА слова, щоб не плутати з родичами)
  const name = (info.name || '').toLowerCase().split(/\s+/).filter(w => w.length >= 3);
  return { ibans, jars, name };
}

// Перекази й готівка: такі MCC у надходженнях — справжній прихід; інші MCC у плюсі — повернення від магазину.
const TRANSFER_MCC = new Set([0, 4829, 6010, 6011, 6012, 6536, 6537, 6538, 6540]);
const REFUND_WORDS = ['повернення', 'скасування', 'відміна', 'refund', 'cancel', 'reversal'];
// Видача кредиту на картку: це борг, а не дохід.
const BORROW_WORDS = ['кредит готівкою', 'видача кредиту', 'видача позики', 'позика', 'кредитні кошти', 'кредит на картку',
  'зарахування кредиту', 'кредит від', 'cash loan', 'loan'];

export function classify(item, markers) {
  const desc = (item.description || '').toLowerCase().trim();
  const amt = +item.amount || 0;
  if (item.counterIban && markers.ibans.has(item.counterIban)) return 'own';
  if (OWN_RE.test(desc) || markers.jars.some(j => j && desc.includes(j))) return 'own';
  if (markers.name && markers.name.length >= 2 && markers.name.every(w => desc.includes(w))) return 'own';
  if (amt > 0) {
    if (BORROW_WORDS.some(w => desc.includes(w))) return 'borrow';
    if (REFUND_WORDS.some(w => desc.includes(w)) || !TRANSFER_MCC.has(+item.mcc || 0)) return 'refund';
    return 'income';
  }
  if (FEE_WORDS.some(w => desc.includes(w))) return 'fee';
  if (CREDIT_WORDS.some(w => desc.includes(w))) return 'credit';
  return 'spend';
}

export function toOps(items, info, acc = null) {
  const mk = ownMarkers(info);
  return items
    .map(i => ({
      id: (acc ? acc + ':' : '') + i.id, time: +i.time || 0, amount: +i.amount || 0,
      desc: (i.description || '').trim(), mcc: +i.mcc || 0, acc,
      kind: classify(i, mk), balance: i.balance, cashback: i.cashbackAmount || 0,
    }))
    .sort((a, b) => b.time - a.time);
}

/** Операції з усіх рахунків: byAcc = { accountId: [items] }. */
/** overrides — { opId: kind }: що користувач вказав вручну (має пріоритет над автоматикою). */
export function allOps(byAcc, info, overrides = {}) {
  const ops = Object.entries(byAcc || {})
    .flatMap(([acc, items]) => toOps(items || [], info, acc))
    .sort((a, b) => b.time - a.time);
  for (const o of ops) if (overrides[o.id]) { o.kind = overrides[o.id]; o.manual = true; }
  pairOwnTransfers(ops);
  pairLoans(ops);
  return ops;
}

/**
 * Кредит: видача (borrow) і пізніше погашення (credit) суми ≥ видачі і ≤ видачі +50% протягом 62 днів →
 * погашення стає «repay»: тіло боргу не витрата, різниця — відсотки (interest).
 */
export function pairLoans(ops, maxDays = 62) {
  const used = new Set();
  const byTime = [...ops].sort((a, b) => a.time - b.time);
  for (const b of byTime) {
    if (b.kind !== 'borrow') continue;
    const r = byTime.find(o => !used.has(o.id) && o.kind === 'credit' && o.time > b.time &&
      o.time - b.time <= maxDays * 86400 && -o.amount >= b.amount && -o.amount <= b.amount * 1.5);
    if (r) {
      used.add(r.id);
      r.kind = 'repay';
      r.principal = b.amount;
      r.interest = -r.amount - b.amount;
      r.days = Math.max(1, Math.round((r.time - b.time) / 86400));
      b.repaidBy = r.id;
    }
  }
  return ops;
}

/** Переказ між своїми рахунками: мінус на одному і такий самий плюс на іншому протягом 10 хв → обидва «свої». */
export function pairOwnTransfers(ops, windowSec = 600) {
  const used = new Set();
  for (const out of ops) {
    if (out.amount >= 0 || out.kind === 'own' || out.manual || used.has(out.id)) continue;
    const match = ops.find(o => !used.has(o.id) && !o.manual && o.acc && out.acc && o.acc !== out.acc &&
      o.amount === -out.amount && Math.abs(o.time - out.time) <= windowSec);
    if (match) {
      out.kind = 'own'; match.kind = 'own';
      used.add(out.id); used.add(match.id);
    }
  }
  return ops;
}

/** Гривневі рахунки, з яких беремо виписку: усі, крім «не моїх»; основна картка — першою. */
export function statementAccounts(info, notMine = []) {
  const main = mainAccount(info, notMine);
  const uah = (info.accounts || []).filter(a => a.currencyCode === 980 && !notMine.includes(a.id));
  return main ? [main, ...uah.filter(a => a.id !== main.id)] : uah;
}

export function totals(ops) {
  const t = { income: 0, spend: 0, credit: 0, fee: 0, ownIn: 0, ownOut: 0, refund: 0, borrowed: 0, repaid: 0, interest: 0, byCat: {} };
  for (const o of ops) {
    const a = o.amount;
    if (o.kind === 'income') t.income += a;
    else if (o.kind === 'own') { if (a > 0) t.ownIn += a; else t.ownOut -= a; }
    else if (o.kind === 'credit') t.credit -= a;
    else if (o.kind === 'borrow') t.borrowed += a;
    else if (o.kind === 'repay') { t.repaid += o.principal; t.interest += o.interest; }
    else if (o.kind === 'fee') t.fee -= a;
    else if (o.kind === 'spend' || o.kind === 'refund') {
      // повернення від магазину зменшує витрати своєї категорії, а не збільшує прихід
      if (o.kind === 'refund') t.refund += a;
      t.spend -= a;
      const c = category(o.mcc);
      t.byCat[c] = (t.byCat[c] || 0) - a;
    }
  }
  t.spend = Math.max(0, t.spend);
  for (const c of Object.keys(t.byCat)) if (t.byCat[c] <= 0) delete t.byCat[c];
  t.out = t.spend + t.credit + t.fee + t.interest;
  t.net = t.income - t.out;
  return t;
}

/** Свої гроші на гривневих картках, борг за кредиткою, ліміт, у банках — копійки.
 *  notMine — id карток, які не рахуються (напр., дитяча картка). */
export function ownMoney(info, notMine = []) {
  let own = 0, debt = 0, limit = 0, jars = 0, others = 0;
  for (const a of info.accounts || []) {
    if (a.currencyCode !== 980) continue;
    if (notMine.includes(a.id)) { others += Math.max(0, (+a.balance || 0) - (+a.creditLimit || 0)); continue; }
    const bal = +a.balance || 0, lim = +a.creditLimit || 0;
    limit += lim;
    const diff = bal - lim;
    if (diff >= 0) own += diff; else debt -= diff;
  }
  for (const j of info.jars || []) if (j.currencyCode === 980) jars += +j.balance || 0;
  return { own, debt, limit, jars, others };
}

/** Основна гривнева картка: без «не моїх», спершу чорна з кредитним лімітом, потім будь-яка чорна, потім інша. */
export function mainAccount(info, notMine = []) {
  const uah = (info.accounts || []).filter(a => a.currencyCode === 980 && !notMine.includes(a.id));
  return uah.find(a => a.type === 'black' && +a.creditLimit > 0) || uah.find(a => a.type === 'black') || uah[0] || null;
}

const KIND_NAMES = { black: 'Чорна', white: 'Біла', platinum: 'Платинова', iron: 'Залізна', fop: 'ФОП',
  yellow: 'Жовта', eAid: 'єПідтримка', madeInUkraine: 'Зроблено в Україні' };

export function cardName(a) {
  const pan = ((a.maskedPan || [''])[0] || '').slice(-4);
  return `${KIND_NAMES[a.type] || 'Картка'}${pan ? ' •' + pan : ''}`;
}
