// IcebergView — розпізнавання скріну (розстрочка, кредит, графік платежів) через Claude API.
// Запит іде прямо з телефона в Anthropic з ключем користувача. Скрін ніде не зберігається.

const API = 'https://api.anthropic.com/v1/messages';
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5'];   // якщо першої моделі немає — пробуємо другу
const MAX_SIDE = 1600;

export class ScanError extends Error {}

/** Зменшує фото до 1600 px по довшій стороні і стискає в JPEG (дешевше й швидше). */
export async function prepareImage(file) {
  if (!file || !/^image\//.test(file.type)) throw new ScanError('Це не зображення. Вибери скрін.');
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  const url = c.toDataURL('image/jpeg', 0.85);
  return url.slice(url.indexOf(',') + 1);
}

const PROMPT = (today) => `Це скріншот із банківського застосунку (Україна): розстрочка, кредит, «оплата частинами», графік платежів або регулярний платіж.
Сьогодні ${today}. Витягни ВСІ зобовʼязання, які видно на екрані. Не вигадуй: чого не видно — став null.

Відповідай ЛИШЕ JSON без пояснень, у такій формі:
{"items":[{
 "name": "коротка назва покупки чи кредиту (магазин/товар), до 40 символів",
 "bank": "назва банку, якщо видно (monobank, ПУМБ, Raiffeisen, ПриватБанк…) або null",
 "payment": число — щомісячний платіж у гривнях,
 "next_date": "YYYY-MM-DD — дата найближчого платежу (якщо видно лише день — у найближчому майбутньому місяці)" або null,
 "payments_left": ціле — скільки платежів лишилось РАЗОМ із найближчим, або null,
 "payments_total": ціле — усього платежів за договором, або null,
 "price": число — ціна покупки чи сума кредиту в гривнях, або null,
 "remaining_debt": число — залишок боргу в гривнях, або null,
 "rate_note": "ставка, комісія чи РРПС, якщо написано на екрані" або null
}]}
Якщо написано «3 з 10 сплачено» — payments_left = 7, payments_total = 10.
Якщо на екрані немає зобовʼязань — {"items":[]}.`;

export async function scanImage(key, b64, todayStr, fetchImpl = fetch) {
  let lastErr;
  for (const model of MODELS) {
    let r;
    try {
      r = await fetchImpl(API, {
        method: 'POST',
        referrerPolicy: 'no-referrer',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model, max_tokens: 1200,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
            { type: 'text', text: PROMPT(todayStr) },
          ] }],
        }),
      });
    } catch {
      throw new ScanError('Немає звʼязку з Anthropic. Перевір інтернет.');
    }
    if (r.status === 401) throw new ScanError('Ключ Claude API не приймається. Перевір його в «Ще → Розпізнавання скрінів».');
    if (r.status === 402 || r.status === 403) throw new ScanError('Anthropic відмовив: можливо, закінчився баланс або ліміт робочого простору.');
    if (r.status === 429) throw new ScanError('Забагато запитів до Anthropic. Спробуй за хвилину.');
    if (r.status === 404 || r.status === 400) {             // моделі може не бути — пробуємо наступну
      lastErr = new ScanError(`Anthropic відповів помилкою (код ${r.status}).`);
      continue;
    }
    if (!r.ok) throw new ScanError(`Anthropic відповів помилкою (код ${r.status}). Спробуй пізніше.`);
    const data = await r.json();
    const text = (data.content || []).map(c => c.text || '').join('');
    return parseItems(text);
  }
  throw lastErr || new ScanError('Не вдалося розпізнати.');
}

const num = v => (v == null || v === '' ? null : Number(String(v).replace(/[\s ]/g, '').replace(',', '.')));
const okNum = v => Number.isFinite(v) && v > 0 && v < 1e11;

/** Розбір відповіді моделі в чернетки записів (суми — копійки). Нічого не довіряємо наосліп. */
export function parseItems(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new ScanError('Не вдалося прочитати відповідь. Спробуй інший скрін або введи вручну.');
  let obj;
  try { obj = JSON.parse(m[0]); } catch { throw new ScanError('Не вдалося прочитати відповідь. Спробуй інший скрін або введи вручну.'); }
  const items = Array.isArray(obj.items) ? obj.items : [];
  return items.slice(0, 10).map(x => {
    const pay = num(x.payment), price = num(x.price), left = Math.round(num(x.payments_left)), total = Math.round(num(x.payments_total));
    const date = typeof x.next_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.next_date) ? x.next_date : null;
    return {
      name: String(x.name || '').slice(0, 60).trim() || 'Зі скріну',
      bank: x.bank ? String(x.bank).slice(0, 30) : '',
      payment: okNum(pay) ? Math.round(pay * 100) : null,
      first: date,
      count: left >= 1 && left <= 600 ? left : null,
      total: total >= 1 && total <= 600 ? total : null,
      price: okNum(price) ? Math.round(price * 100) : null,
      note: x.rate_note ? String(x.rate_note).slice(0, 120) : '',
      debt: okNum(num(x.remaining_debt)) ? Math.round(num(x.remaining_debt) * 100) : null,
    };
  }).filter(d => d.payment || d.price || d.debt);
}
