// Tolerant localStorage wrapper. Corrupt, foreign, or unavailable storage reads as null.

function defaultBacking() {
  try {
    return (typeof localStorage !== 'undefined') ? localStorage : null;
  } catch (_) {
    return null; // e.g. SecurityError when storage access is blocked
  }
}

export function createStorage(backing = undefined,
                             key = 'model-match:state:v1') {
  const store = backing === undefined ? defaultBacking() : backing;

  function save(state) {
    try { if (store) store.setItem(key, JSON.stringify(state)); } catch (_) { /* ignore */ }
  }
  function load() {
    try {
      const raw = store && store.getItem(key);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || typeof s !== 'object') return null;
      if (typeof s.bankVersion !== 'string' || !Array.isArray(s.picks)) return null;
      if (s.mode !== 'daily' && s.mode !== 'practice') return null;
      if (s.mode === 'daily' && typeof s.date !== 'string') return null;
      return s;
    } catch (_) {
      return null;
    }
  }
  function clear() {
    try { if (store) store.removeItem(key); } catch (_) { /* ignore */ }
  }
  return { save, load, clear };
}
