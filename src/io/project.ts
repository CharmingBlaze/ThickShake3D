// Native project format (.tshake): a versioned JSON copy of the model.
import { emptyModel, type Model } from '../core/types';

const FORMAT = 'thickshake';
const VERSION = 1;

export function serializeProject(m: Model, extra?: Record<string, unknown>): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, model: m, ...extra });
}

/** What an autosave knows about the project it came from. */
export interface AutosaveInfo { savedAt: number; fileName: string; filePath: string | null }

/** The project details an autosave carries, if it has them. */
export function autosaveInfo(text: string): AutosaveInfo | null {
  try { const a = JSON.parse(text)?.autosave; return a && typeof a.savedAt === 'number' ? a : null; } catch { return null; }
}

export function parseProject(text: string): Model {
  let doc: any;
  try { doc = JSON.parse(text); } catch { throw new Error('This project file is corrupted (not valid JSON).'); }
  if (doc?.format !== FORMAT || !doc.model) throw new Error('This is not a ThickShake project.');
  if (doc.version > VERSION) throw new Error(`This project was saved by a newer ThickShake (format ${doc.version}).`);
  return { ...emptyModel(), ...doc.model };
}
