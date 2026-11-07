// File access: native dialogs in the desktop app, browser fallbacks otherwise.

export interface OpenedFile { path: string | null; name: string; data: ArrayBuffer }
export interface Filter { name: string; extensions: string[] }

interface NativeApi {
  openFile(o: { filters: Filter[] }): Promise<OpenedFile | null>;
  readFile(p: string): Promise<OpenedFile | null>;
  saveFile(o: { path?: string | null; defaultName?: string; filters?: Filter[]; data: Uint8Array; extras?: { name: string; data: Uint8Array }[] }): Promise<{ path: string; name: string } | null>;
  setTitle(t: string): Promise<void>;
  confirmClose(): Promise<void>;
  onRequestClose(fn: () => void): void;
  autosaveWrite(t: string): Promise<void>;
  autosaveRead(): Promise<string | null>;
  autosaveClear(): Promise<void>;
  toggleDevtools(): Promise<void>;
  toggleFullscreen(): Promise<void>;
}

export const native: NativeApi | null = (window as any).native ?? null;

export function openFile(filters: Filter[]): Promise<OpenedFile | null> {
  if (native) return native.openFile({ filters });
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters.flatMap((f) => f.extensions.map((e) => (e === '*' ? '*' : `.${e}`))).join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      resolve({ path: null, name: f.name, data: await f.arrayBuffer() });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function saveFile(o: { path?: string | null; defaultName: string; filters: Filter[]; data: Uint8Array; extras?: { name: string; data: Uint8Array }[] }): Promise<{ path: string | null; name: string } | null> {
  if (native) return native.saveFile(o);
  const dl = (name: string, data: Uint8Array) => {
    const url = URL.createObjectURL(new Blob([data as BlobPart]));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  dl(o.defaultName, o.data);
  for (const e of o.extras ?? []) dl(e.name, e.data);
  return { path: null, name: o.defaultName };
}

// ---------- browser storage ----------
// IndexedDB holds far more than localStorage, so projects with textures fit. Every call is best effort: storage can
// be off, full or cleared, and the app carries on without it.
let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('thickshake', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbp = null; rej(r.error); };
  });
}
function req<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((res, rej) => {
    const r = fn(d.transaction('kv', mode).objectStore('kv'));
    r.onsuccess = () => res(r.result as T);
    r.onerror = () => rej(r.error);
  })).catch(() => undefined);
}
export const kv = {
  get: <T>(key: string) => req<T>('readonly', (s) => s.get(key)),
  set: (key: string, value: unknown) => req('readwrite', (s) => s.put(value, key)).then(() => undefined),
  del: (key: string) => req('readwrite', (s) => s.delete(key)).then(() => undefined),
};

const AUTOSAVE_KEY = 'thickshake.autosave';
export const autosave = {
  async write(text: string) {
    if (native) return native.autosaveWrite(text);
    await kv.set('autosave', text);
  },
  async read(): Promise<string | null> {
    if (native) return native.autosaveRead();
    const text = await kv.get<string>('autosave');
    if (text) return text;
    // Older versions kept it here.
    try { return localStorage.getItem(AUTOSAVE_KEY); } catch { return null; }
  },
  async clear() {
    if (native) return native.autosaveClear();
    await kv.del('autosave');
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
  },
};

// ---------- recent files ----------
/**
 * A project opened or saved lately. In the desktop app it's found again by its path; in a browser, which can't reopen
 * files by path, its contents are kept in browser storage instead, for the last few.
 */
export interface RecentEntry { path: string | null; name: string; at: number; stored?: boolean }

const RECENT_KEY = 'thickshake.recent';
const KEEP_IN_BROWSER = 6;

export function recentFiles(): RecentEntry[] {
  try {
    const raw: unknown[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    // Older versions kept bare paths.
    return raw.map((x) => (typeof x === 'string' ? { path: x, name: x.split(/[\\/]/).pop() ?? x, at: 0 } : x as RecentEntry)).filter((x) => x && x.name);
  } catch { return []; }
}

const sameEntry = (a: RecentEntry, path: string | null, name: string) => (path ? a.path === path : !a.path && a.name === name);

/** Note a project as recent. Without a path (in a browser), `text` is kept so it can be opened again. */
export async function pushRecent(path: string | null, name: string, text?: string) {
  const entry: RecentEntry = { path, name, at: Date.now(), ...(path ? {} : { stored: !!text }) };
  if (!path && !text) return;
  const list = [entry, ...recentFiles().filter((x) => !sameEntry(x, path, name))];
  // Keep the newest few stored projects; forget the contents of the rest.
  let stored = 0;
  const keep: RecentEntry[] = [];
  for (const x of list) {
    if (x.path) { keep.push(x); continue; }
    if (++stored <= KEEP_IN_BROWSER) keep.push(x); else void kv.del(`recent:${x.name}`);
  }
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(keep.slice(0, 12))); } catch { /* ignore */ }
  if (!path && text) await kv.set(`recent:${name}`, text);
}

/** A recent project's contents: read from its path, or from browser storage. */
export async function openRecent(e: RecentEntry): Promise<OpenedFile | null> {
  if (e.path && native) return native.readFile(e.path);
  const text = await kv.get<string>(`recent:${e.name}`);
  return text ? { path: null, name: e.name, data: new TextEncoder().encode(text).buffer as ArrayBuffer } : null;
}

export function clearRecent() {
  for (const x of recentFiles()) if (!x.path) void kv.del(`recent:${x.name}`);
  try { localStorage.removeItem(RECENT_KEY); } catch { /* ignore */ }
}
