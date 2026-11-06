// Native project format (.tshake): a versioned JSON copy of the model.
import { emptyModel, type Model } from '../core/types';

const FORMAT = 'thickshake';
const VERSION = 1;

export function serializeProject(m: Model): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, model: m });
}

export function parseProject(text: string): Model {
  let doc: any;
  try { doc = JSON.parse(text); } catch { throw new Error('This project file is corrupted (not valid JSON).'); }
  if (doc?.format !== FORMAT || !doc.model) throw new Error('This is not a ThickShake project.');
  if (doc.version > VERSION) throw new Error(`This project was saved by a newer ThickShake (format ${doc.version}).`);
  return { ...emptyModel(), ...doc.model };
}
