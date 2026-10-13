// Fresh mode: runtime Pollinations API round source. No DOM, no keys on disk.
//
// API-CONTRACT NOTE (code-derived, NOT live-verified):
//   The endpoint, auth header, request body shape, system prompt, max_tokens,
//   and the four model IDs below are copied from this repo's own build-time
//   generator (tools/generate-bank.py) and bank_manifest.json / data/bank.v1.json.
//   A real-key browser smoke test (CORS, actual model IDs, routing/fallback,
//   billing) is still required and is explicitly out of scope here — this
//   module only ever runs against injected mock fetch in tests.

import { buildRounds } from './daily.js';

export const FRESH_ENDPOINT = 'https://gen.pollinations.ai/v1/chat/completions';
export const FRESH_KEY_ITEM = 'model-match:fresh-key:v1';
export const FRESH_SYSTEM_PROMPT =
  'You are an AI assistant. Answer directly. Never mention any AI model or company names.';
export const FRESH_MAX_TOKENS = 1500;
export const FRESH_TIMEOUT_MS = 60000;
export const FRESH_ROUND_COUNT = 5;

// Cost notice. The Korean text is quoted verbatim from the approved design
// (Sol B.4) and must stay directly above the Start button; the English
// version is a translation for the English UI.
export const FRESH_COST_NOTICE_KO =
  'Fresh는 입력한 키로 Pollinations API를 직접 호출합니다. API 사용료는 플레이어 부담이며, 계정·모델 정책에 따라 발생할 수 있습니다. 기본 요청은 라운드당 4회, 5라운드 총 20회입니다. 실패·재시도·취소된 요청도 비용이 발생할 수 있습니다. Daily와 Practice는 키 없이 사용할 수 있습니다.';
export const FRESH_COST_NOTICE_EN =
  'Fresh calls the Pollinations API directly with the key you enter. API usage is billed to you under your account and model policy. A full game makes 4 requests per round, 20 for 5 rounds. Failed, retried, and cancelled requests may still cost you. Daily and Practice never need a key.';

function defaultSessionStore() {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch (_) {
    return null; // storage access blocked
  }
}

// Single-item sessionStorage key vault. Falls back to process memory when
// sessionStorage is unavailable/blocked (caller is told via storeMode()).
// The key is NEVER written anywhere except FRESH_KEY_ITEM.
export function createKeyStore(backing = undefined) {
  const store = backing === undefined ? defaultSessionStore() : backing;
  let mem = null;
  let useMem = store === null || store === undefined;

  function save(key) {
    if (typeof key !== 'string' || key.length === 0) {
      clear();
      return;
    }
    if (useMem) {
      mem = key;
      return;
    }
    try {
      store.setItem(FRESH_KEY_ITEM, key);
    } catch (_) {
      useMem = true; // e.g. quota / SecurityError mid-session
      mem = key;
    }
  }
  function load() {
    if (useMem) return mem;
    try {
      const v = store.getItem(FRESH_KEY_ITEM);
      return typeof v === 'string' && v.length > 0 ? v : null;
    } catch (_) {
      return mem;
    }
  }
  function clear() {
    mem = null;
    try {
      if (store) store.removeItem(FRESH_KEY_ITEM);
    } catch (_) { /* ignore */ }
  }
  function storeMode() {
    return useMem ? 'memory' : 'session';
  }
  return { save, load, clear, storeMode };
}

// Start gate: explicit consent checkbox + non-empty key. No local key
// validation is attempted — auth success is never faked locally.
export function canStartFresh({ key, consent }) {
  return typeof key === 'string' && key.length > 0 && consent === true;
}

export function isAllowedFreshUrl(url) {
  return url === FRESH_ENDPOINT;
}

// Build one chat-completion request. The key travels ONLY in the
// Authorization header of the allowlisted HTTPS endpoint — never in the
// URL, never in the body, never in logs.
export function buildFreshRequest({ modelId, promptText, key, signal, systemPrompt }) {
  return {
    url: FRESH_ENDPOINT,
    options: {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemPrompt || FRESH_SYSTEM_PROMPT },
          { role: 'user', content: promptText },
        ],
        max_tokens: FRESH_MAX_TOKENS,
      }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      signal,
    },
  };
}

// Normalize one model response into game answer text.
// Empty content, unparseable shape, or a server-echoed model id that does
// not match the requested model all count as a per-model failure.
export function extractFreshText(payload, expectedModelId) {
  const text =
    payload &&
    payload.choices &&
    payload.choices[0] &&
    payload.choices[0].message &&
    payload.choices[0].message.content;
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const echoed = payload.model;
  if (typeof echoed === 'string' && echoed.length > 0 && echoed !== expectedModelId) {
    return { ok: false, reason: 'model-mismatch' };
  }
  return { ok: true, text: text.trim() };
}

export function errorKindForStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  return 'retryable';
}

function retryAfterOf(res) {
  try {
    const v = res && res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('retry-after')
      : null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (_) {
    return null;
  }
}

// One model, one attempt. NEVER retries internally — retry is an explicit
// user action at the round level (failed models only). Returned objects
// never contain the key.
export async function fetchOneModel({
  fetchImpl,
  modelId,
  modelKey,
  promptText,
  key,
  signal,
  timeoutMs = FRESH_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  systemPrompt,
}) {
  if (typeof key !== 'string' || key.length === 0) {
    return { modelKey, modelId, ok: false, kind: 'no-key' };
  }
  const { url, options } = buildFreshRequest({ modelId, promptText, key, signal, systemPrompt });
  if (!isAllowedFreshUrl(url)) {
    return { modelKey, modelId, ok: false, kind: 'misdirect' };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    try { ctrl.abort(signal && signal.reason !== undefined ? signal.reason : undefined); } catch (_) { /* ignore */ }
  };
  if (signal) {
    if (signal.aborted) {
      return { modelKey, modelId, ok: false, kind: 'aborted' };
    }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeoutFn(() => {
    timedOut = true;
    try { ctrl.abort(new Error('fresh-timeout')); } catch (_) { /* ignore */ }
  }, timeoutMs);
  let onCtrlAbort = null;
  const abortFired = new Promise((_, reject) => {
    onCtrlAbort = () => {
      const e = new Error('fresh-aborted');
      e.name = 'AbortError';
      reject(e);
    };
    ctrl.signal.addEventListener('abort', onCtrlAbort, { once: true });
  });
  // Silences unhandled-rejection noise when the fetch itself wins the race.
  abortFired.catch(() => {});
  try {
    // Race (not bare await): a hung fetch that ignores its signal must
    // still lose to our timeout / batch / caller abort.
    const res = await Promise.race([fetchImpl(url, { ...options, signal: ctrl.signal }), abortFired]);
    if (signal && signal.aborted) return { modelKey, modelId, ok: false, kind: 'aborted' };
    if (ctrl.signal.aborted) {
      return { modelKey, modelId, ok: false, kind: timedOut ? 'timeout' : 'aborted' };
    }
    const status = res ? res.status : 0;
    if (status === 401 || status === 403) return { modelKey, modelId, ok: false, kind: 'auth', status };
    if (status === 429) {
      return { modelKey, modelId, ok: false, kind: 'rate', status, retryAfter: retryAfterOf(res) };
    }
    if (!res || !res.ok) return { modelKey, modelId, ok: false, kind: 'retryable', status };
    let payload = null;
    try {
      payload = await res.json();
    } catch (_) {
      return { modelKey, modelId, ok: false, kind: 'retryable', status };
    }
    const parsed = extractFreshText(payload, modelId);
    if (!parsed.ok) return { modelKey, modelId, ok: false, kind: 'invalid', reason: parsed.reason, status };
    return { modelKey, modelId, ok: true, text: parsed.text, usage: payload.usage };
  } catch (err) {
    if (signal && signal.aborted) return { modelKey, modelId, ok: false, kind: 'aborted' };
    if (timedOut) return { modelKey, modelId, ok: false, kind: 'timeout' };
    if (ctrl.signal.aborted) return { modelKey, modelId, ok: false, kind: 'aborted' };
    if (err && err.name === 'TimeoutError') return { modelKey, modelId, ok: false, kind: 'timeout' };
    return { modelKey, modelId, ok: false, kind: 'network' };
  } finally {
    try { clearTimeoutFn(timer); } catch (_) { /* ignore */ }
    if (signal) {
      try { signal.removeEventListener('abort', onParentAbort); } catch (_) { /* ignore */ }
    }
    if (onCtrlAbort) {
      try { ctrl.signal.removeEventListener('abort', onCtrlAbort); } catch (_) { /* ignore */ }
    }
  }
}

// Round source for Fresh mode. Prompts are reused from the static bank
// (same 2-easy/2-medium/1-hard practice composition, seeded); ONLY the
// answers are generated live, on demand, one round at a time.
// Atomic commit: a round object is published only after all 4 model texts
// are valid. The source never stores the API key — it is passed per call.
export function createFreshSource({
  bank,
  seed,
  fetchImpl,
  timeoutMs = FRESH_TIMEOUT_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  systemPrompt,
}) {
  if (!bank || !Array.isArray(bank.models) || bank.models.length === 0) {
    throw new Error('fresh source needs bank.models');
  }
  const apiModels = bank.models.map((m) => {
    if (!m || typeof m.key !== 'string' || typeof m.apiModelId !== 'string' || !m.apiModelId) {
      throw new Error('fresh source needs bank.models[].apiModelId');
    }
    return { key: m.key, apiModelId: m.apiModelId };
  });
  const plan = buildRounds(bank, { mode: 'practice', practiceSeed: seed });
  // The shells ARE the playable rounds (game.js holds these references).
  // answers/shownText stay empty until atomic commit fills them in place,
  // and the UI gates every round on isCommitted().
  const rounds = plan.slice(0, FRESH_ROUND_COUNT).map((p) => ({
    promptId: p.promptId,
    promptText: p.promptText,
    category: p.category,
    difficulty: p.difficulty,
    shownAnswerId: '',
    shownText: '',
    correctKey: p.correctKey,
    answers: [],
    options: p.options.slice(),
  }));
  const texts = rounds.map(() => new Map());
  const committed = rounds.map(() => false);
  const usage = { requests: 0, succeeded: 0, failed: 0 };
  let gen = 0; // bumped by abort(); late results from older gens are stale
  let authFailed = false; // latched on 401/403: no further requests, no auto retry

  function getShells() {
    return rounds;
  }

  function commit(i) {
    const r = rounds[i];
    const bag = texts[i];
    r.answers = apiModels.map((m) => ({
      id: `fresh-${r.promptId}-${m.key}`,
      modelKey: m.key,
      text: bag.get(m.key),
    }));
    r.shownAnswerId = `fresh-${r.promptId}-${r.correctKey}`;
    r.shownText = bag.get(r.correctKey);
    committed[i] = true;
    return r;
  }

  async function getRound({ roundIndex, key, signal }) {
    if (authFailed) return { ok: false, kind: 'auth', blocked: true };
    if (!Number.isInteger(roundIndex) || roundIndex < 0 || roundIndex >= rounds.length) {
      return { ok: false, kind: 'bad-index' };
    }
    if (committed[roundIndex]) return { ok: true, round: rounds[roundIndex], fromCache: true };
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, kind: 'no-key' };
    }
    if (signal && signal.aborted) return { ok: false, kind: 'aborted' };
    const myGen = gen;
    const r = rounds[roundIndex];
    const bag = texts[roundIndex];
    const pending = apiModels.filter((m) => !bag.has(m.key));
    if (pending.length === 0) {
      return { ok: true, round: commit(roundIndex) };
    }

    // One shared batch signal: a 401 cancels stragglers immediately, and a
    // caller abort cancels everything. Late arrivals are stale, never committed.
    const batch = new AbortController();
    const onParentAbort = () => {
      try { batch.abort(); } catch (_) { /* ignore */ }
    };
    if (signal) signal.addEventListener('abort', onParentAbort, { once: true });
    try {
      const results = await Promise.all(pending.map((m) => {
        usage.requests += 1;
        return fetchOneModel({
          fetchImpl,
          modelId: m.apiModelId,
          modelKey: m.key,
          promptText: r.promptText,
          key,
          signal: batch.signal,
          timeoutMs,
          setTimeoutFn,
          clearTimeoutFn,
          systemPrompt,
        }).then((res) => {
          if (res.kind === 'auth' && !batch.signal.aborted) {
            try { batch.abort(); } catch (_) { /* ignore */ }
          }
          if (res.ok) usage.succeeded += 1;
          else usage.failed += 1;
          return res;
        });
      }));
      if (gen !== myGen) return { ok: false, kind: 'aborted', stale: true };
      if (signal && signal.aborted) return { ok: false, kind: 'aborted' };
      for (const res of results) {
        if (res.ok) bag.set(res.modelKey, res.text);
      }
      const failed = results.filter((x) => !x.ok);
      if (failed.some((x) => x.kind === 'auth')) {
        authFailed = true; // no auto retry, no further requests
        return {
          ok: false,
          kind: 'auth',
          failedKeys: failed.map((x) => x.modelKey),
          succeededKeys: results.filter((x) => x.ok).map((x) => x.modelKey),
        };
      }
      if (failed.length === 0 && apiModels.every((m) => bag.has(m.key))) {
        return { ok: true, round: commit(roundIndex) };
      }
      const rate = failed.find((x) => x.kind === 'rate');
      return {
        ok: false,
        kind: rate ? 'rate' : 'retryable',
        failedKeys: failed.map((x) => x.modelKey),
        succeededKeys: results.filter((x) => x.ok).map((x) => x.modelKey),
        retryAfter: rate ? rate.retryAfter : null,
        detailKinds: failed.map((x) => x.kind),
      };
    } finally {
      if (signal) {
        try { signal.removeEventListener('abort', onParentAbort); } catch (_) { /* ignore */ }
      }
    }
  }

  function abort() {
    gen += 1; // stale-guard only; explicit retries on the same source still work
  }

  function getUsage() {
    return { ...usage };
  }

  function isCommitted(i) {
    return committed[i] === true;
  }

  return {
    get size() { return rounds.length; },
    getRound,
    abort,
    getUsage,
    getShells,
    isCommitted,
  };
}
