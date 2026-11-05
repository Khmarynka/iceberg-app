// IcebergView — чиста логіка без браузера: гроші, дати (Київ), класифікація операцій, підсумки.
// Перенесено з Telegram-бота (mono_view.py), щоб правила були однакові.

export const KYIV = 'Europe/Kyiv';

export const CURRENCY = { 980: 'грн', 840: '$', 978: '€' };

export function money(minor, currency = 980, { sign = false } = {}) {
  const v = Math.abs(minor) / 100;
  const s = Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
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
  return { ibans, jars };
}

export function classify(item, markers) {
  const desc = (item.description || '').toLowerCase().trim();
  const amt = +item.amount || 0;
  if (item.counterIban && markers.ibans.has(item.counterIban)) return 'own';
  if (OWN_RE.test(desc) || markers.jars.some(j => j && desc.includes(j))) return 'own';
  if (amt > 0) return 'income';
  if (FEE_WORDS.some(w => desc.includes(w))) return 'fee';
  if (CREDIT_WORDS.some(w => desc.includes(w))) return 'credit';
  return 'spend';
}

export function toOps(items, info) {
  const mk = ownMarkers(info);
  return items
    .map(i => ({
      id: i.id, time: +i.time || 0, amount: +i.amount || 0,
      desc: (i.description || '').trim(), mcc: +i.mcc || 0,
      kind: classify(i, mk), balance: i.balance, cashback: i.cashbackAmount || 0,
    }))
    .sort((a, b) => b.time - a.time);
}

export function totals(ops) {
  const t = { income: 0, spend: 0, credit: 0, fee: 0, ownIn: 0, ownOut: 0, byCat: {} };
  for (const o of ops) {
    const a = o.amount;
    if (o.kind === 'income') t.income += a;
    else if (o.kind === 'own') { if (a > 0) t.ownIn += a; else t.ownOut -= a; }
    else if (o.kind === 'credit') t.credit -= a;
    else if (o.kind === 'fee') t.fee -= a;
    else if (o.kind === 'spend') {
      t.spend -= a;
      const c = category(o.mcc);
      t.byCat[c] = (t.byCat[c] || 0) - a;
    }
  }
  t.out = t.spend + t.credit + t.fee;
  t.net = t.income - t.out;
  return t;
}

/** Свої гроші на гривневих картках, борг за кредиткою, ліміт, у банках — копійки. */
export function ownMoney(info) {
  let own = 0, debt = 0, limit = 0, jars = 0;
  for (const a of info.accounts || []) {
    if (a.currencyCode !== 980) continue;
    const bal = +a.balance || 0, lim = +a.creditLimit || 0;
    limit += lim;
    const diff = bal - lim;
    if (diff >= 0) own += diff; else debt -= diff;
  }
  for (const j of info.jars || []) if (j.currencyCode === 980) jars += +j.balance || 0;
  return { own, debt, limit, jars };
}

export function mainAccount(info) {
  const uah = (info.accounts || []).filter(a => a.currencyCode === 980);
  return uah.find(a => a.type === 'black') || uah[0] || null;
}

const KIND_NAMES = { black: 'Чорна', white: 'Біла', platinum: 'Платинова', iron: 'Залізна', fop: 'ФОП',
  yellow: 'Жовта', eAid: 'єПідтримка', madeInUkraine: 'Зроблено в Україні' };

export function cardName(a) {
  const pan = ((a.maskedPan || [''])[0] || '').slice(-4);
  return `${KIND_NAMES[a.type] || 'Картка'}${pan ? ' •' + pan : ''}`;
}
