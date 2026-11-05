// IcebergView — запити до monobank прямо з телефона (без серверів-посередників).
// Ліміт банку: 1 запит на 60 с, до 31 доби + 1 год за запит, до 500 операцій у відповіді.

const API = 'https://api.monobank.ua';
const GAP_MS = (globalThis.__ICE_TEST_GAP ?? 61) * 1000;
let lastCall = 0;

export class MonoError extends Error {}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** onWait(секунд) — щоб показати відлік, поки банк не дозволяє наступний запит. */
async function get(token, path, onWait) {
  const wait = lastCall + GAP_MS - Date.now();
  if (wait > 0) {
    for (let left = Math.ceil(wait / 1000); left > 0; left--) {
      onWait?.(left);
      await sleep(Math.min(1000, wait));
    }
  }
  onWait?.(0);
  let r;
  try {
    r = await fetch(API + path, { headers: { 'X-Token': token }, cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    lastCall = Date.now();
    throw new MonoError('Немає звʼязку з monobank. Перевір інтернет і спробуй ще раз.');
  }
  lastCall = Date.now();
  if (r.status === 200) return r.json();
  if (r.status === 401 || r.status === 403) throw new MonoError('monobank не приймає токен. Можливо, його відкликано — створи новий на api.monobank.ua.');
  if (r.status === 429) throw new MonoError('monobank просить зачекати хвилину між запитами. Спробуй трохи пізніше.');
  throw new MonoError(`monobank відповів помилкою (код ${r.status}). Спробуй пізніше.`);
}

export const clientInfo = (token, onWait) => get(token, '/personal/client-info', onWait);

export async function statement(token, account, from, to, onWait) {
  let end = to;
  const all = [];
  for (let page = 0; page < 4; page++) {
    const items = await get(token, `/personal/statement/${account}/${from}/${end}`, onWait) || [];
    all.push(...items);
    if (items.length < 500) break;
    end = Math.min(...items.map(i => i.time)) - 1;
  }
  const seen = new Set();
  return all.filter(i => (seen.has(i.id) ? false : seen.add(i.id)));
}
