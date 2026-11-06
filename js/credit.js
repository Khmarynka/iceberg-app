// IcebergView — порадник «як дешевше взяти гроші». Чиста логіка, без мережі.
// Тарифи — за паспортом споживчого кредиту monobank (листопад 2026); користувач може їх змінити в «Ще».
// Суми — у копійках.

import { monthlyRate } from './plan.js';

export const DEFAULT_TARIFFS = {
  cashPerDay: 0.003,       // Кредит готівкою: % на день від суми (30 грн/день з 10 000)
  cashMinDays: 1,          // мінімум днів відсотків — НЕ підтверджено; на екрані mono «строк сплати процентів від 2 до 30 днів». Змінюється в «Ще»
  instPerMonth: 0.019,     // Розстрочка на картку: разова комісія = % × кількість місяців, береться одразу за весь строк
  instMinMonths: 3,
  instMaxMonths: 24,
  partsMaxMonths: 24,      // Покупка частинами у партнерів: 0%
};

const annualFromPeriod = (cost, principal, days) => (principal > 0 && days > 0 ? (cost / principal) * (365 / days) : 0);

/**
 * amount — скільки потрібно; days — на скільки днів (коли зможеш повернути);
 * partner — покупка в магазині, де є «Покупка частинами» (0%).
 */
export function compareOptions(amount, days, { partner = false, tariffs = DEFAULT_TARIFFS } = {}) {
  const t = { ...DEFAULT_TARIFFS, ...tariffs };
  const opts = [];

  // 1) Кредит готівкою — платиш лише за дні користування
  const cashDays = Math.max(days, t.cashMinDays);
  const cashCost = Math.round(amount * t.cashPerDay * cashDays);
  opts.push({
    id: 'cash', name: 'Кредит готівкою', cost: cashCost, total: amount + cashCost,
    annualSimple: t.cashPerDay * 365, perDay: Math.round(amount * t.cashPerDay),
    how: `≈${(t.cashPerDay * 100).toFixed(1).replace('.', ',')}% на день, рахується по днях. Повернув раніше — заплатив менше.`,
    note: days < t.cashMinDays ? `Мінімум ${t.cashMinDays} дні відсотків.` : null,
    schedule: `усе разом через ${cashDays} дн. (або відсотки кожні 2–30 днів, тіло — коли зручно)`,
  });

  // 2) Розстрочка на картку — комісія за весь строк одразу, щомісячні рівні платежі
  const months = Math.min(t.instMaxMonths, Math.max(t.instMinMonths, Math.ceil(days / 30)));
  const instCost = Math.round(amount * t.instPerMonth * months);
  const pay = Math.round((amount + instCost) / months);
  const r = monthlyRate(amount, months, pay);
  opts.push({
    id: 'inst', name: `Розстрочка на картку, ${months} міс.`, cost: instCost, total: amount + instCost, months, payment: pay,
    annualEffective: (1 + r) ** 12 - 1,
    how: `${(t.instPerMonth * 100).toFixed(1).replace('.', ',')}% × ${months} міс. = ${(t.instPerMonth * months * 100).toFixed(1).replace('.', ',')}% від суми, одразу за весь строк.`,
    note: Math.ceil(days / 30) < t.instMinMonths
      ? `Мінімум ${t.instMinMonths} місяці: навіть якщо повернеш через ${days} дн., комісія все одно ${(t.instPerMonth * t.instMinMonths * 100).toFixed(1).replace('.', ',')}%.`
      : 'Дострокове погашення комісію не зменшує.',
    schedule: `${months} платежі по ≈${Math.round(pay / 100).toLocaleString('uk-UA')} грн щомісяця`,
  });

  // 3) Покупка частинами — лише в магазинах-партнерах
  if (partner) {
    const pm = Math.min(t.partsMaxMonths, Math.max(2, Math.ceil(days / 30)));
    opts.push({
      id: 'parts', name: `Покупка частинами, ${pm} міс.`, cost: 0, total: amount, months: pm, payment: Math.round(amount / pm),
      how: '0% — комісію платить продавець.', note: 'Лише в магазинах, де є «Покупка частинами». Без збільшення строку.',
      schedule: `${pm} платежі по ≈${Math.round(amount / pm / 100).toLocaleString('uk-UA')} грн`,
    });
  }

  for (const o of opts) o.annualForPeriod = annualFromPeriod(o.cost, amount, Math.max(days, 1));
  opts.sort((a, b) => a.cost - b.cost);
  const best = opts[0];
  return { options: opts, best, breakEvenDays: breakEvenDays(t), days, amount };
}

/** До скількох днів кредит готівкою дешевший за мінімальну розстрочку (3 міс.). */
export function breakEvenDays(t = DEFAULT_TARIFFS) {
  return Math.floor((t.instPerMonth * t.instMinMonths) / t.cashPerDay + 1e-9);
}
