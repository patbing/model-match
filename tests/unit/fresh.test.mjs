// Fresh mode tests (Sol B.5 — the ten minimum cases + contract extras).
// fetch / storage / timer are injected; no network is ever touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRounds } from '../../src/daily.js';
import { createGame, MAX_SCORE } from '../../src/game.js';
import { buildShareText } from '../../src/share.js';
import { formatAnswer } from '../../src/view.js';
import {
  FRESH_ENDPOINT,
  FRESH_KEY_ITEM,
  createKeyStore,
  canStartFresh,
  isAllowedFreshUrl,
  buildFreshRequest,
  extractFreshText,
  errorKindForStatus,
  fetchOneModel,
  createFreshSource,
} from '../../src/fresh.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bank = JSON.parse(readFileSync(join(root, 'data', 'bank.v1.json'), 'utf8'));
const allKeys = bank.models.map((m) => m.key);
const apiIds = bank.models.map((m) => m.apiModelId);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function memSession() {
  const mem = new Map();
  const seen = [];
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { seen.push(k); mem.set(k, String(v)); },
    removeItem: (k) => { seen.push(k); mem.delete(k); },
    keysUsed: () => seen.slice(),
  };
}

// Resolves one canned answer per requested model id.
function okFetch({ perModelDelay = {}, calls = [] } = {}) {
  return async (url, opts) => {
    calls.push({ url, opts, signal: opts && opts.signal });
    const body = JSON.parse(opts.body);
    const wait = perModelDelay[body.model] || 0;
    if (wait) await sleep(wait);
    if (opts && opts.signal && opts.signal.aborted) {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        model: body.model,
        choices: [{ message: { content: `live answer from ${body.model}` } }],
      }),
    };
  };
}

function statusFetch(status, { calls = [], retryAfter = null } = {}) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: false,
      status,
      headers: { get: (h) => (String(h).toLowerCase() === 'retry-after' ? retryAfter : null) },
      json: async () => ({}),
    };
  };
}

function mkSource(fetchImpl, seed = 42, extra = {}) {
  return createFreshSource({ bank, seed, fetchImpl, timeoutMs: 500, ...extra });
}

// B.5-1: four successes normalize to the game round schema and commit once.
test('B.5-1: four live answers normalize to the round schema and commit exactly once', async () => {
  const calls = [];
  const src = mkSource(okFetch({ calls }));
  const res = await src.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(res.ok, true);
  const r = res.round;
  assert.ok(typeof r.promptId === 'string' && r.promptId.length > 0);
  assert.ok(typeof r.promptText === 'string' && r.promptText.length > 0);
  assert.ok(allKeys.includes(r.correctKey));
  assert.deepEqual(r.answers.map((a) => a.modelKey).sort(), [...allKeys].sort());
  for (const a of r.answers) {
    assert.ok(typeof a.text === 'string' && a.text.length > 0);
    assert.ok(a.text.includes(bank.models.find((m) => m.key === a.modelKey).apiModelId));
  }
  assert.equal(r.shownText, r.answers.find((a) => a.modelKey === r.correctKey).text);
  assert.deepEqual([...r.options].sort(), [...allKeys].sort());
  assert.equal(calls.length, 4);
  assert.equal(src.isCommitted(0), true);

  // Second read is a cache hit: zero new requests, same object.
  const again = await src.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(again.ok, true);
  assert.equal(again.fromCache, true);
  assert.equal(again.round, r);
  assert.equal(calls.length, 4);

  // The committed round is playable by the existing game engine.
  const g = createGame([r]);
  assert.equal(g.pick(r.correctKey), true);
  assert.equal(g.state().score, 100);
});

// B.5-2: arrival order never affects the answer-model mapping.
test('B.5-2: out-of-order arrivals keep the answer-model mapping', async () => {
  const delays = {};
  bank.models.forEach((m, i) => { delays[m.apiModelId] = (bank.models.length - 1 - i) * 15; });
  const src = mkSource(okFetch({ perModelDelay: delays }), 7);
  const res = await src.getRound({ roundIndex: 2, key: 'K', signal: null });
  assert.equal(res.ok, true);
  for (const a of res.round.answers) {
    const id = bank.models.find((m) => m.key === a.modelKey).apiModelId;
    assert.ok(a.text.includes(id), `answer for ${a.modelKey} must carry its own model text`);
  }
});

// B.5-3: key allowlist / header / single-item storage / no share leak.
test('B.5-3: key travels only in the allowlisted header; storage uses one item', () => {
  assert.equal(isAllowedFreshUrl(FRESH_ENDPOINT), true);
  assert.equal(isAllowedFreshUrl('https://evil.example/x'), false);
  assert.equal(isAllowedFreshUrl(FRESH_ENDPOINT + '?k=1'), false);

  const { url, options } = buildFreshRequest({
    modelId: apiIds[0], promptText: 'hi', key: 'SECRET', signal: null,
  });
  assert.equal(url, FRESH_ENDPOINT);
  assert.equal(options.headers.Authorization, 'Bearer SECRET');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.equal(options.redirect, 'error');
  assert.ok(!url.includes('SECRET'));
  assert.ok(!options.body.includes('SECRET'));
  assert.ok(!options.body.includes('Authorization'));

  const backing = memSession();
  const ks = createKeyStore(backing);
  ks.save('SECRET');
  assert.equal(ks.load(), 'SECRET');
  ks.clear();
  assert.equal(ks.load(), null);
  assert.deepEqual(backing.keysUsed().filter((k, i, a) => a.indexOf(k) === i), [FRESH_KEY_ITEM]);

  const share = buildShareText({
    dateLabel: 'fresh', bankLabel: 'Bank v1', pattern: '🟩',
    score: 100, modeLabel: 'Fresh — live', url: 'https://example.com',
  });
  assert.ok(!share.includes('SECRET'));
  assert.ok(!share.includes('Bearer'));
});

// B.5-3b: no persistent store is touched; blocked storage falls back to memory.
test('B.5-3b: persistent storage is never touched', () => {
  assert.equal(globalThis.localStorage, undefined);
  const ks = createKeyStore(); // no sessionStorage in node -> memory fallback
  assert.equal(ks.storeMode(), 'memory');
  ks.save('SECRET');
  assert.equal(ks.load(), 'SECRET');
  ks.clear();
  assert.equal(ks.load(), null);
  assert.equal(globalThis.localStorage, undefined);
});

// B.5-4: 401 deletes the key path and issues no further requests.
test('B.5-4: 401 latches auth failure; key deleted; no further requests', async () => {
  const calls = [];
  const src = mkSource(statusFetch(401, { calls }));
  const backing = memSession();
  const ks = createKeyStore(backing);
  ks.save('BADKEY');

  const res = await src.getRound({ roundIndex: 0, key: ks.load(), signal: null });
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'auth');
  assert.equal(src.isCommitted(0), false);

  // Main-thread contract on auth: delete the key, cancel everything.
  ks.clear();
  assert.equal(ks.load(), null);

  const n = calls.length;
  assert.ok(n > 0 && n <= 4);
  const blocked = await src.getRound({ roundIndex: 0, key: 'OTHER', signal: null });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, 'auth');
  assert.equal(blocked.blocked, true);
  assert.equal(calls.length, n, 'latched auth must not issue further requests');

  // Without a key nothing is fetched at all (fresh source, no latch).
  const callsKey = [];
  const noKeySrc = createFreshSource({ bank, seed: 44, fetchImpl: okFetch({ calls: callsKey }), timeoutMs: 500 });
  const noKey = await noKeySrc.getRound({ roundIndex: 1, key: null, signal: null });
  assert.equal(noKey.kind, 'no-key');
  assert.equal(callsKey.length, 0);
});

// B.5-4b: a 401 cancels its slower siblings via abort.
test('B.5-4b: one 401 aborts slower sibling requests', async () => {
  const seen = [];
  const impl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push({ model: body.model, signal: opts.signal });
    if (body.model === apiIds[0]) {
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
    await sleep(40);
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ model: body.model, choices: [{ message: { content: 'late' } }] }),
    };
  };
  const src = mkSource(impl, 11);
  const res = await src.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(res.kind, 'auth');
  assert.equal(seen.length, 4);
  // The three in-flight siblings are aborted. (The finished 401 request's
  // own controller is already cleaned up — cancelling it is meaningless.)
  const slow = seen.filter((s) => s.model !== apiIds[0]);
  assert.equal(slow.length, 3);
  assert.ok(slow.every((s) => s.signal && s.signal.aborted === true), 'all sibling signals aborted');
  assert.equal(src.isCommitted(0), false);
});

// B.5-5: 429 / timeout / network never auto-retry and leave the round ungraded.
test('B.5-5: 429, timeout, and network failures do not retry and stay ungraded', async () => {
  const c429 = [];
  const s429 = mkSource(statusFetch(429, { calls: c429, retryAfter: '7' }), 21);
  const r429 = await s429.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(r429.kind, 'rate');
  assert.equal(r429.retryAfter, 7);
  assert.equal(s429.isCommitted(0), false);
  assert.equal(c429.length, 4);
  await sleep(30);
  assert.equal(c429.length, 4, 'no background retry after 429');

  const cTo = [];
  const never = async (url, opts) => { cTo.push({ url, opts }); return new Promise(() => {}); };
  const sTo = mkSource(never, 22, { timeoutMs: 20 });
  const rTo = await sTo.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(rTo.kind, 'retryable');
  assert.deepEqual(rTo.detailKinds, ['timeout', 'timeout', 'timeout', 'timeout']);
  assert.equal(sTo.isCommitted(0), false);
  assert.equal(cTo.length, 4);
  await sleep(40);
  assert.equal(cTo.length, 4, 'no background retry after timeout');

  const cNet = [];
  const flaky = async (url, opts) => {
    cNet.push({ url, opts });
    const e = new TypeError('fetch failed');
    throw e;
  };
  const sNet = mkSource(flaky, 23);
  const rNet = await sNet.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(rNet.kind, 'retryable');
  assert.deepEqual(rNet.detailKinds, ['network', 'network', 'network', 'network']);
  assert.equal(sNet.isCommitted(0), false);
});

// B.5-6: partial failure keeps successes; retry fetches only the missing models.
test('B.5-6: partial failure retries only the failed models; usage counts retries', async () => {
  let failId = apiIds[2];
  const calls = [];
  const impl = async (url, opts) => {
    calls.push(JSON.parse(opts.body).model);
    const body = JSON.parse(opts.body);
    if (body.model === failId) {
      return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({}) };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ model: body.model, choices: [{ message: { content: `live ${body.model}` } }] }),
    };
  };
  const src = mkSource(impl, 31);
  const first = await src.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(first.ok, false);
  assert.equal(first.kind, 'retryable');
  assert.deepEqual(first.failedKeys, [allKeys[2]]);
  assert.deepEqual(first.succeededKeys.sort(), [allKeys[0], allKeys[1], allKeys[3]].sort());
  assert.equal(src.isCommitted(0), false);
  assert.equal(calls.length, 4);

  failId = null; // server recovers; explicit user retry fetches only the gap
  const before = calls.length;
  const second = await src.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(second.ok, true);
  assert.equal(calls.length, before + 1);
  assert.equal(calls[calls.length - 1], apiIds[2]);

  const u = src.getUsage();
  assert.deepEqual(u, { requests: 5, succeeded: 4, failed: 1 });
});

// B.5-7: exit / mode switch aborts and stale arrivals are never committed.
test('B.5-7: abort makes late arrivals stale and uncommitted', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const gated = async (url, opts) => {
    await gate;
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ model: 'x', choices: [{ message: { content: 'too late' } }] }),
    };
  };
  const src = mkSource(gated, 41);
  const pending = src.getRound({ roundIndex: 0, key: 'K', signal: null });
  src.abort(); // user exits / switches mode while requests fly
  release();
  const res = await pending;
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'aborted');
  assert.equal(res.stale, true);
  assert.equal(src.isCommitted(0), false);

  // A pre-aborted signal issues zero requests.
  const calls = [];
  const src2 = mkSource(okFetch({ calls }), 42);
  const ctrl = new AbortController();
  ctrl.abort();
  const res2 = await src2.getRound({ roundIndex: 0, key: 'K', signal: ctrl.signal });
  assert.equal(res2.kind, 'aborted');
  assert.equal(calls.length, 0);
  assert.equal(src2.isCommitted(0), false);
});

// B.5-8: API HTML is never executable at render time.
test('B.5-8: hostile API text is escaped by the renderer', async () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>**bold**\nline2';
  const impl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ model: body.model, choices: [{ message: { content: evil } }] }),
    };
  };
  const src = mkSource(impl, 51);
  const res = await src.getRound({ roundIndex: 0, key: 'K', signal: null });
  assert.equal(res.ok, true);
  const html = formatAnswer(res.round.shownText);
  assert.ok(!html.includes('<script'));
  assert.ok(!/<img/i.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
  // The real guarantee: after removing the two tags the renderer itself
  // emits (<strong>, <br>), no angle bracket survives — hostile markup is
  // inert text even if its words (e.g. "onerror") remain readable.
  const stripped = html.replace(/<\/?strong>/g, '').replace(/<br>/g, '');
  assert.ok(!stripped.includes('<'));
  assert.ok(!stripped.includes('>'));
  assert.ok(html.includes('<strong>bold</strong>'), 'honest markdown still works');
});

// B.5-9: Daily/Practice/share/game regressions still hold.
test('B.5-9: daily determinism, 5-round scoring, and share shape are unchanged', () => {
  const a = buildRounds(bank, { mode: 'daily', date: '2026-10-09' });
  const b = buildRounds(bank, { mode: 'daily', date: '2026-10-09' });
  assert.deepEqual(a, b);

  const g = createGame(buildRounds(bank, { mode: 'practice', practiceSeed: 123 }));
  for (let i = 0; i < 5; i++) {
    g.pick(g.current().correctKey);
    g.next();
  }
  assert.equal(g.state().score, MAX_SCORE);

  const freshShare = buildShareText({
    dateLabel: 'fresh', bankLabel: 'Bank v1', pattern: '🟩🟩🟩🟩🟩',
    score: 600, modeLabel: 'Fresh — live', url: 'https://example.com/fresh',
  });
  const dailyShare = buildShareText({
    dateLabel: '2026-10-09', bankLabel: 'Bank v1', pattern: '🟩🟩🟩🟩🟩',
    score: 600, modeLabel: "Today's challenge", url: 'https://example.com/',
  });
  assert.ok(freshShare.includes('Fresh'));
  assert.ok(!dailyShare.includes('Fresh'));
  assert.ok(!freshShare.includes('Bearer'));
});

// B.5-10: Daily/Practice modules never touch the generation API.
test('B.5-10: static modules contain no gen-API or fresh references', () => {
  const names = ['bank.js', 'daily.js', 'game.js', 'share.js', 'storage.js'];
  for (const n of names) {
    const src = readFileSync(join(root, 'src', n), 'utf8');
    assert.ok(!src.includes('gen.pollinations.ai'), `${n} must not reference the gen API`);
    assert.ok(!/fresh/i.test(src), `${n} must not reference fresh mode`);
  }
  const bankSrc = readFileSync(join(root, 'src', 'bank.js'), 'utf8');
  assert.ok(bankSrc.includes('data/bank'), 'bank.js fetches only the static bank file');
});

// Extras: start gate, response validation, status mapping, plan shape, full-game cost.
test('start gate needs a key plus explicit consent', () => {
  assert.equal(canStartFresh({ key: '', consent: true }), false);
  assert.equal(canStartFresh({ key: 'K', consent: false }), false);
  assert.equal(canStartFresh({ key: 'K', consent: true }), true);
  assert.equal(canStartFresh({ key: null, consent: true }), false);
});

test('extractFreshText rejects empty payloads; echo is advisory-only (live contract)', () => {
  assert.deepEqual(extractFreshText({ model: 'a', choices: [{ message: { content: 'hi' } }] }, 'a'),
    { ok: true, text: 'hi' });
  assert.deepEqual(extractFreshText({ choices: [{ message: { content: 'hi' } }] }, 'a'),
    { ok: true, text: 'hi' });
  assert.equal(extractFreshText({ model: 'a', choices: [{ message: { content: '  ' } }] }, 'a').ok, false);
  assert.equal(extractFreshText({ model: 'a', choices: [] }, 'a').ok, false);
  assert.equal(extractFreshText(null, 'a').ok, false);
});

test('extractFreshText accepts all live versioned echoes (2026-10-14 실측)', () => {
  // Request alias -> live echo. None equal the alias; all must be accepted.
  const pairs = [
    ['openai/gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17'],
    ['anthropic/claude-sonnet-5.5', 'global.anthropic.claude-sonnet-5-5'],
    ['google/gemini-3.8-flash', 'gemini-3.8-flash'],
    ['z-ai/glm-5.3-flash', 'accounts/fireworks/models/glm-5p3-flash'],
  ];
  for (const [req, echo] of pairs) {
    const r = extractFreshText(
      { model: echo, choices: [{ message: { content: 'hi' } }] }, req);
    assert.deepEqual(r, { ok: true, text: 'hi' }, `${req} <- ${echo}`);
  }
});

test('errorKindForStatus maps auth/rate/other', () => {
  assert.equal(errorKindForStatus(401), 'auth');
  assert.equal(errorKindForStatus(403), 'auth');
  assert.equal(errorKindForStatus(429), 'rate');
  assert.equal(errorKindForStatus(500), 'retryable');
  assert.equal(errorKindForStatus(0), 'retryable');
});

test('fresh plan is seeded: same seed, same prompts and full model coverage', () => {
  const s1 = mkSource(okFetch(), 99);
  const s2 = mkSource(okFetch(), 99);
  assert.deepEqual(
    s1.getShells().map((r) => [r.promptId, r.correctKey]),
    s2.getShells().map((r) => [r.promptId, r.correctKey]),
  );
  assert.equal(s1.size, 5);
  const counts = {};
  for (const r of s1.getShells()) counts[r.correctKey] = (counts[r.correctKey] || 0) + 1;
  assert.deepEqual(Object.keys(counts).sort(), [...allKeys].sort());
});

test('a full fresh game costs exactly 20 requests when nothing fails', async () => {
  const src = mkSource(okFetch(), 5);
  for (let i = 0; i < src.size; i++) {
    const res = await src.getRound({ roundIndex: i, key: 'K', signal: null });
    assert.equal(res.ok, true);
  }
  assert.deepEqual(src.getUsage(), { requests: 20, succeeded: 20, failed: 0 });
});

test('fetchOneModel never retries and never leaks the key', async () => {
  const calls = [];
  const bad = async () => { calls.push(1); throw new TypeError('down'); };
  const r = await fetchOneModel({
    fetchImpl: bad, modelId: apiIds[0], modelKey: allKeys[0],
    promptText: 'p', key: 'SECRET', signal: null, timeoutMs: 200,
  });
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.ok(!JSON.stringify(r).includes('SECRET'));
});
