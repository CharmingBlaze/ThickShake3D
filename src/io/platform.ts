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

const AUTOSAVE_KEY = 'thickshake.autosave';
export const autosave = {
  async write(text: string) {
    if (native) return native.autosaveWrite(text);
    try { localStorage.setItem(AUTOSAVE_KEY, text); } catch { /* over quota: autosave is best effort in the browser */ }
  },
  async read(): Promise<string | null> {
    if (native) return native.autosaveRead();
    try { return localStorage.getItem(AUTOSAVE_KEY); } catch { return null; }
  },
  async clear() {
    if (native) return native.autosaveClear();
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch { /* ignore */ }
  },
};

const RECENT_KEY = 'thickshake.recent';
export function recentFiles(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { return []; }
}
export function pushRecent(path: string | null) {
  if (!path) return;
  const list = [path, ...recentFiles().filter((p) => p !== path)].slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}
