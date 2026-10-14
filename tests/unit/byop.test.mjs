// BYOP connect tests (Sol BYOP 2026-10-14 — the ten minimum cases).
// Storage / randomness / hashing / time / network are injected fakes;
// SHA-256 itself comes from node:crypto (deterministic, zero network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  BYOP_CLIENT_ID,
  BYOP_REDIRECT_URI,
  BYOP_AUTHORIZE_URL,
  BYOP_TOKEN_URL,
  BYOP_TXN_ITEM,
  BYOP_TXN_MAX_AGE_MS,
  BYOP_DEVELOPER_EARNINGS_ENABLED,
  base64UrlEncode,
  buildAuthUrl,
  beginTransaction,
  parseCallback,
  claimCallbackTransaction,
  exchangeCode,
  createTokenRecord,
  tokenExpired,
  tokenUsable,
  clearTransaction,
} from '../../src/byop.js';
import {
  FRESH_KEY_ITEM,
  FRESH_COST_NOTICE_KO,
  FRESH_COST_NOTICE_EN,
  FRESH_EARNINGS_NOTICE_KO,
  FRESH_EARNINGS_NOTICE_EN,
  buildCostNotice,
  createKeyStore,
} from '../../src/fresh.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const T = 1_750_000_000_000;
const now = () => T;

function memStore({ throws = null } = {}) {
  const mem = new Map();
  const seen = [];
  return {
    getItem: (k) => {
      if (throws === 'get') throw new Error('blocked');
      return mem.has(k) ? mem.get(k) : null;
    },
    setItem: (k, v) => {
      if (throws === 'set') throw new Error('blocked');
      seen.push(k);
      mem.set(k, String(v));
    },
    removeItem: (k) => {
      if (throws === 'remove') throw new Error('blocked');
      seen.push(k);
      mem.delete(k);
    },
    keysUsed: () => [...new Set(seen)],
    raw: (k) => (mem.has(k) ? mem.get(k) : null),
  };
}

// Deterministic filler: sequential bytes from `start`.
function seqFill(start = 1) {
  let c = start;
  return (arr) => {
    for (let i = 0; i < arr.length; i++) arr[i] = (c + i) & 0xff;
    c += arr.length;
    return true;
  };
}

const sha256 = (data) => webcrypto.subtle.digest('SHA-256', data);

function readTxn(store) {
  return JSON.parse(store.raw(BYOP_TXN_ITEM));
}

// Case 1: authorization URL — endpoints, exact redirect, parameters,
// S256 challenge, independent state.
test('1: auth URL carries exact endpoints, redirect, params, S256, fresh state', async () => {
  const store = memStore();
  const begun = await beginTransaction({
    storage: store, randomFill: seqFill(7), digest: sha256, now,
  });
  assert.equal(begun.ok, true);
  const u = new URL(begun.url);
  assert.equal(u.origin + u.pathname, BYOP_AUTHORIZE_URL);
  assert.equal(u.origin + u.pathname, 'https://enter.pollinations.ai/authorize');
  const q = u.searchParams;
  assert.equal(q.get('client_id'), BYOP_CLIENT_ID);
  assert.equal(q.get('client_id'), 'pk_ZCFUxLAPhcBc3eDI');
  assert.equal(q.get('redirect_uri'), BYOP_REDIRECT_URI);
  assert.equal(q.get('redirect_uri'), 'https://patbing.github.io/model-match/');
  assert.equal(q.get('response_type'), 'code');
  assert.equal(q.get('scope'), 'usage');
  assert.equal(q.get('models'), 'text');
  assert.equal(q.get('budget'), '5');
  assert.equal(q.get('expiry'), '7');
  assert.equal(q.get('code_challenge_method'), 'S256');
  assert.equal(q.get('state'), begun.state);

  // Challenge is the real S256 of the stored verifier; state is independent.
  const txn = readTxn(store);
  assert.equal(txn.state, begun.state);
  assert.equal(txn.verifier.length, 43); // 32 bytes -> base64url
  assert.equal(txn.state.length, 22); // 16 bytes -> base64url
  assert.notEqual(txn.state, txn.verifier);
  const expectChallenge = base64UrlEncode(
    new Uint8Array(await webcrypto.subtle.digest('SHA-256',
      new TextEncoder().encode(txn.verifier))));
  assert.equal(q.get('code_challenge'), expectChallenge);
  assert.deepEqual(store.keysUsed(), [BYOP_TXN_ITEM]);
});

test('1b: verifier and state are independent across transactions', async () => {
  const a = await beginTransaction({ storage: memStore(), now });
  const b = await beginTransaction({ storage: memStore(), now });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.state, b.state);
  assert.notEqual(new URL(a.url).searchParams.get('code_challenge'),
    new URL(b.url).searchParams.get('code_challenge'));
});

// Case 2: successful callback — exact exchange body, vault storage only,
// URL-clean single use, single exchange.
test('2: success callback exchanges once with the exact body, then is spent', async () => {
  const store = memStore();
  const begun = await beginTransaction({
    storage: store, randomFill: seqFill(21), digest: sha256, now,
  });
  const txn = readTxn(store);
  const seen = [];
  const fetchImpl = async (url, opts) => {
    seen.push({ url, opts });
    // The transaction must already be consumed before the exchange runs.
    assert.equal(store.raw(BYOP_TXN_ITEM), null);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'sk_test_token', expires_in: 3600 }),
    };
  };
  const params = parseCallback(`?code=AUTHCODE&state=${encodeURIComponent(begun.state)}`);
  const claim = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(claim.ok, true);
  assert.equal(claim.code, 'AUTHCODE');
  assert.equal(claim.verifier, txn.verifier);
  assert.equal(store.raw(BYOP_TXN_ITEM), null); // deleted BEFORE exchange

  const ex = await exchangeCode({
    code: claim.code, verifier: claim.verifier, fetchImpl, now,
  });
  assert.equal(ex.ok, true);
  assert.equal(ex.token, 'sk_test_token');
  assert.equal(ex.expiresAt, T + 3600 * 1000);
  assert.equal(seen.length, 1);

  const { url, opts } = seen[0];
  assert.equal(url, BYOP_TOKEN_URL);
  assert.equal(opts.method, 'POST');
  assert.deepEqual(opts.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
  const body = new URLSearchParams(opts.body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'AUTHCODE');
  assert.equal(body.get('redirect_uri'), BYOP_REDIRECT_URI);
  assert.equal(body.get('client_id'), BYOP_CLIENT_ID);
  assert.equal(body.get('code_verifier'), txn.verifier);
  assert.equal(body.has('client_secret'), false);
  assert.ok(!opts.body.includes('client_secret'));

  // The token lands only in the Fresh vault's single item.
  const vault = memStore();
  const ks = createKeyStore(vault);
  ks.save(ex.token);
  assert.equal(ks.load(), 'sk_test_token');
  assert.deepEqual(vault.keysUsed(), [FRESH_KEY_ITEM]);

  // Replay: same callback can never exchange again.
  const again = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(again.ok, false);
  assert.equal(again.kind, 'no-txn');
  assert.equal(seen.length, 1);
});

// Case 3: missing/mismatched/stale state and duplicates — no exchange.
test('3: bad, stale, and duplicate callbacks never reach the network', async () => {
  async function setup(ageMs = 0, mutate = null) {
    const store = memStore();
    const begun = await beginTransaction({
      storage: store, randomFill: seqFill(33), digest: sha256, now,
    });
    let raw = store.raw(BYOP_TXN_ITEM);
    if (ageMs !== 0 || mutate) {
      const txn = JSON.parse(raw);
      txn.createdAt = T - ageMs;
      if (mutate) mutate(txn);
      store.setItem(BYOP_TXN_ITEM, JSON.stringify(txn));
    }
    return { store, state: begun.state };
  }
  const calls = [];
  const fetchImpl = async () => { calls.push(1); throw new Error('must not be called'); };

  // Mismatched state.
  {
    const { store } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback('?code=C&state=wrong'), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'mismatch']);
    assert.equal(store.raw(BYOP_TXN_ITEM), null);
  }
  // Missing state / missing code.
  {
    const { store } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback('?code=C'), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'mismatch']);
  }
  {
    const { store, state } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback(`?state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'missing']);
  }
  // Stale transaction (past max age) and clock-skewed future transaction.
  {
    const { store, state } = await setup(BYOP_TXN_MAX_AGE_MS + 1000);
    const r = claimCallbackTransaction({
      params: parseCallback(`?code=C&state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'stale']);
  }
  {
    const { store, state } = await setup(-60_000);
    const r = claimCallbackTransaction({
      params: parseCallback(`?code=C&state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'stale']);
  }
  // Duplicate parameters.
  {
    const { store, state } = await setup();
    const r = claimCallbackTransaction({
      params: parseCallback(`?code=A&code=B&state=${state}`), storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'duplicate']);
  }
  assert.equal(calls.length, 0);
});

// Case 4: replay, duplicate initialization, reload during exchange.
test('4: reload or second init during exchange cannot double-exchange', async () => {
  const store = memStore();
  const begun = await beginTransaction({
    storage: store, randomFill: seqFill(44), digest: sha256, now,
  });
  const params = parseCallback(`?code=C&state=${begun.state}`);
  const first = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(first.ok, true);

  let release;
  const gate = new Promise((r) => { release = r; });
  let exchanges = 0;
  const fetchImpl = async () => {
    exchanges += 1;
    await gate;
    return { ok: true, status: 200, json: async () => ({ access_token: 'sk_x' }) };
  };
  const pending = exchangeCode({
    code: first.code, verifier: first.verifier, fetchImpl, now,
  });
  // Reload / duplicate init while the exchange is in flight.
  const dup = claimCallbackTransaction({ params, storage: store, now });
  assert.equal(dup.ok, false);
  release();
  const done = await pending;
  assert.equal(done.ok, true);
  assert.equal(exchanges, 1);
});

// Case 5: consent denial and exchange/network/malformed failures.
test('5: denial and exchange failures clean up and stay recoverable', async () => {
  // Consent denied by the user at the provider.
  {
    const store = memStore();
    const begun = await beginTransaction({
      storage: store, randomFill: seqFill(55), digest: sha256, now,
    });
    const r = claimCallbackTransaction({
      params: parseCallback(`?error=access_denied&state=${begun.state}`),
      storage: store, now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'denied']);
    assert.equal(store.raw(BYOP_TXN_ITEM), null);
  }
  // No transaction at all (plain reload with leftover params).
  {
    const r = claimCallbackTransaction({
      params: parseCallback('?code=C&state=S'), storage: memStore(), now,
    });
    assert.deepEqual([r.ok, r.kind], [false, 'no-txn']);
  }
  // Exchange failure modes — the consumed code is never replayed.
  const badFetch = async () => { throw new TypeError('down'); };
  assert.deepEqual(
    (await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: badFetch, now })).reason,
    'network');
  const refused = async () => ({ ok: false, status: 400, json: async () => ({}) });
  {
    const r = await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: refused, now });
    assert.deepEqual([r.ok, r.reason, r.status], [false, 'exchange-failed', 400]);
  }
  const empty = async () => ({ ok: true, status: 200, json: async () => ({}) });
  assert.equal(
    (await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: empty, now })).reason,
    'malformed');
  const broken = async () => ({
    ok: true, status: 200, json: async () => { throw new Error('bad json'); },
  });
  assert.equal(
    (await exchangeCode({ code: 'C', verifier: 'V', fetchImpl: broken, now })).reason,
    'malformed');
  let calls = 0;
  const counting = async () => { calls += 1; throw new Error('unreachable'); };
  assert.equal(
    (await exchangeCode({ code: '', verifier: 'V', fetchImpl: counting, now })).reason,
    'missing');
  assert.equal(
    (await exchangeCode({ code: 'C', verifier: '', fetchImpl: counting, now })).reason,
    'missing');
  assert.equal(calls, 0);
});

// Case 6: token lifetime — expiry boundary, unknown expiry, empty token.
test('6: token lifetime helpers gate start without a retry loop', () => {
  const rec = createTokenRecord({ token: 'sk_x', expiresInSec: 3600, now });
  assert.equal(rec.expiresAt, T + 3600 * 1000);
  assert.equal(tokenUsable(rec, () => T), true);
  assert.equal(tokenExpired(rec, () => T + 3599 * 1000), false);
  assert.equal(tokenExpired(rec, () => T + 3600 * 1000), true); // boundary counts as expired
  assert.equal(tokenUsable(rec, () => T + 3600 * 1000), false);

  const unknown = createTokenRecord({ token: 'sk_x', expiresInSec: null, now });
  assert.equal(unknown.expiresAt, null);
  assert.equal(tokenUsable(unknown, () => T + 10 ** 12), true);
  const zero = createTokenRecord({ token: 'sk_x', expiresInSec: 0, now });
  assert.equal(zero.expiresAt, null);

  assert.equal(tokenUsable({ token: '', expiresAt: null }, now), false);
  assert.equal(tokenUsable(null, now), false);
});

// Case 8: storage exceptions — blocked redirect, memory token fallback after.
test('8: storage failure blocks connect; memory vault still works after', async () => {
  // setItem throws: no URL may be used for navigation.
  const bad = await beginTransaction({
    storage: memStore({ throws: 'set' }), randomFill: seqFill(1), digest: sha256, now,
  });
  assert.deepEqual([bad.ok, bad.reason], [false, 'storage']);
  assert.equal(bad.url, undefined);

  // No storage at all (blocked tab storage).
  const none = await beginTransaction({
    storage: null, randomFill: seqFill(1), digest: sha256, now,
  });
  assert.deepEqual([none.ok, none.reason], [false, 'storage']);

  // Readback mismatch (write did not stick).
  const flaky = memStore();
  const origGet = flaky.getItem;
  flaky.getItem = () => 'garbage';
  const mismatch = await beginTransaction({
    storage: flaky, randomFill: seqFill(1), digest: sha256, now,
  });
  assert.deepEqual([mismatch.ok, mismatch.reason], [false, 'storage']);
  void origGet;

  // Randomness / hashing failures never produce a half-transaction.
  const noRand = await beginTransaction({
    storage: memStore(), randomFill: () => false, digest: sha256, now,
  });
  assert.deepEqual([noRand.ok, noRand.reason], [false, 'random']);
  const noHash = await beginTransaction({
    storage: memStore(), randomFill: seqFill(1), digest: async () => null, now,
  });
  assert.deepEqual([noHash.ok, noHash.reason], [false, 'crypto']);

  // Claim against unreadable storage fails closed.
  const claimBad = claimCallbackTransaction({
    params: parseCallback('?code=C&state=S'),
    storage: memStore({ throws: 'get' }), now,
  });
  assert.deepEqual([claimBad.ok, claimBad.kind], [false, 'storage']);

  // Memory-only token fallback after a (hypothetical) exchange still works.
  const ks = createKeyStore(null);
  assert.equal(ks.storeMode(), 'memory');
  ks.save('sk_mem');
  assert.equal(ks.load(), 'sk_mem');
  ks.clear();
  assert.equal(ks.load(), null);
});

// Case 9: disconnect and leakage — cleared credentials, no secret sinks.
test('9: disconnect clears; no secrets in storage, URLs, logs, or telemetry', async () => {
  const store = memStore();
  await beginTransaction({ storage: store, randomFill: seqFill(9), digest: sha256, now });
  assert.notEqual(store.raw(BYOP_TXN_ITEM), null);
  clearTransaction(store);
  assert.equal(store.raw(BYOP_TXN_ITEM), null);
  clearTransaction(store); // idempotent
  clearTransaction(null); // never throws
  clearTransaction(memStore({ throws: 'remove' })); // never throws

  // The vault holds the token under its single item only.
  const vault = memStore();
  const ks = createKeyStore(vault);
  ks.save('sk_disconnect_me');
  assert.deepEqual(vault.keysUsed(), [FRESH_KEY_ITEM]);
  ks.clear();
  assert.equal(ks.load(), null);

  // No localStorage anywhere in the Fresh/BYOP path; no client secret text.
  for (const n of ['byop.js', 'fresh.js', 'main.js', 'view.js']) {
    const src = readFileSync(join(root, 'src', n), 'utf8');
    assert.ok(!src.includes('localStorage'), `${n} must never touch localStorage`);
    assert.ok(!src.includes('client_secret'), `${n} must never carry a client secret`);
  }
  assert.ok(!readFileSync(join(root, 'src', 'byop.js'), 'utf8').includes('console.'),
    'byop.js must not log');
  assert.ok(!readFileSync(join(root, 'src', 'main.js'), 'utf8').includes('console.'),
    'main.js must not log secrets');

  // The auth URL carries challenge+state but no token/secret material.
  const begun = await beginTransaction({
    storage: memStore(), randomFill: seqFill(11), digest: sha256, now,
  });
  assert.ok(!/token|secret|sk_/i.test(begun.url));

  // The callback-loading path leaks no Referer to the third-party badge.
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('referrerpolicy="no-referrer"'),
    'third-party badge must not receive the callback URL as Referer');
});

// Case 10: earnings enabled/disabled — correct cost notice in both cases.
test('10: cost notice discloses budget, duration, rounds; earnings only when on', () => {
  assert.equal(BYOP_DEVELOPER_EARNINGS_ENABLED, false); // never silently enabled
  const off = buildCostNotice(false);
  assert.equal(off.ko, FRESH_COST_NOTICE_KO);
  assert.equal(off.en, FRESH_COST_NOTICE_EN);
  for (const text of [off.ko, off.en]) {
    assert.ok(!text.includes('25%'), 'earnings-off notice must not mention 25%');
  }
  const on = buildCostNotice(true);
  assert.ok(on.ko.includes('25%'));
  assert.ok(on.en.includes('25%'));
  assert.ok(on.ko.includes(FRESH_COST_NOTICE_KO));
  assert.ok(on.en.includes(FRESH_COST_NOTICE_EN));
  assert.ok(on.ko.includes(FRESH_EARNINGS_NOTICE_KO));
  assert.ok(on.en.includes(FRESH_EARNINGS_NOTICE_EN));
  // Base disclosure content (both languages).
  for (const text of [off.ko, off.en]) {
    assert.ok(text.includes('5'), 'budget disclosed');
    assert.ok(text.includes('7'), 'duration disclosed');
    assert.ok(/4회|4 requests/.test(text), 'per-round requests disclosed');
  }
});

// parseCallback edge behavior.
test('parseCallback: presence, denial, duplicates, error description', () => {
  assert.equal(parseCallback('').present, false);
  assert.equal(parseCallback('?foo=1').present, false);
  const ok = parseCallback('?code=C&state=S');
  assert.deepEqual([ok.present, ok.code, ok.state, ok.error, ok.duplicated],
    [true, 'C', 'S', null, false]);
  const denied = parseCallback('?error=access_denied&error_description=nope&state=S');
  assert.deepEqual([denied.present, denied.error, denied.errorDescription],
    [true, 'access_denied', 'nope']);
  assert.equal(parseCallback('?state=A&state=B').duplicated, true);
});
