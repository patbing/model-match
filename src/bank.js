export const BANK_URL = 'data/bank.v1.json';
export const MODEL_COUNT = 4;

export async function loadBank(url = BANK_URL) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`bank fetch failed: ${res.status}`);
  const bank = await res.json();
  const shapeOk = bank && bank.schemaVersion === 1 &&
    Array.isArray(bank.models) && bank.models.length === MODEL_COUNT &&
    Array.isArray(bank.prompts) && bank.prompts.length >= 1 &&
    bank.prompts.every((p) => Array.isArray(p.answers) && p.answers.length === MODEL_COUNT);
  if (!shapeOk) throw new Error('bank shape invalid');
  return bank;
}

export function modelMap(bank) {
  const m = new Map();
  for (const x of bank.models) m.set(x.key, x);
  return m;
}

export function bankLabel(bank) {
  const m = /v(\d+)\s*$/.exec(String(bank.bankVersion || ''));
  return m ? `Bank v${m[1]}` : 'Bank';
}
