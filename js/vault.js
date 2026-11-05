// IcebergView — сейф у телефоні: IndexedDB + шифрування AES-GCM ключем із PIN (PBKDF2).
// Без PIN дані прочитати не можна; PIN ніде не зберігається.

const DB = 'iceberg';
const STORE = 'kv';
const ITER = 310000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = u8 => btoa(String.fromCharCode(...u8));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); res(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { d.close(); rej(t.error); };
  });
}

export const raw = {
  get: k => tx('readonly', s => s.get(k)),
  set: (k, v) => tx('readwrite', s => s.put(v, k)),
  del: k => tx('readwrite', s => s.delete(k)),
  clear: () => tx('readwrite', s => s.clear()),
};

export async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function open(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(dec.decode(pt));
}

/** Сейф після розблокування: читає/пише зашифровані записи. */
export class Vault {
  constructor(key) { this.key = key; }

  static async exists() { return !!(await raw.get('meta')); }

  static async create(pin) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(pin, salt);
    await raw.set('meta', { salt: b64(salt), check: await seal(key, 'iceberg-ok'), v: 1 });
    return new Vault(key);
  }

  /** Повертає Vault або null, якщо PIN неправильний. */
  static async unlock(pin) {
    const meta = await raw.get('meta');
    if (!meta) return null;
    const key = await deriveKey(pin, unb64(meta.salt));
    try {
      if ((await open(key, meta.check)) !== 'iceberg-ok') return null;
    } catch { return null; }
    return new Vault(key);
  }

  async get(name) {
    const box = await raw.get('s:' + name);
    return box ? open(this.key, box) : null;
  }

  async set(name, value) { await raw.set('s:' + name, await seal(this.key, value)); }
  async del(name) { await raw.del('s:' + name); }

  /** Новий PIN: перешифрувати всі записи. */
  async changePin(newPin) {
    const names = ['token', 'cache', 'plan', 'prefs'];
    const data = {};
    for (const n of names) data[n] = await this.get(n);
    const v = await Vault.create(newPin);
    for (const n of names) if (data[n] != null) await v.set(n, data[n]);
    this.key = v.key;
  }

  static async wipe() { await raw.clear(); }
}

// Захист від підбору PIN: після кожної помилки — дедалі довша пауза (зберігається між запусками).
export async function pinDelay() {
  const f = (await raw.get('fails')) || { n: 0, at: 0 };
  const wait = f.n < 3 ? 0 : Math.min(3600, 15 * 2 ** (f.n - 3));
  return Math.max(0, Math.ceil(f.at / 1000 + wait - Date.now() / 1000));
}
export async function pinFailed() {
  const f = (await raw.get('fails')) || { n: 0, at: 0 };
  await raw.set('fails', { n: f.n + 1, at: Date.now() });
}
export async function pinOk() { await raw.del('fails'); }
