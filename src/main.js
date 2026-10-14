import { loadBank, modelMap, bankLabel } from './bank.js';
import { buildRounds, utcDateStr } from './daily.js';
import { createGame, bonusFor } from './game.js';
import { createStorage } from './storage.js';
import { buildShareText, shareText } from './share.js';
import {
  createFreshSource, createKeyStore, canStartFresh, buildCostNotice,
  FRESH_EARNINGS_NOTICE_EN, FRESH_EARNINGS_NOTICE_KO,
} from './fresh.js';
import {
  BYOP_DEVELOPER_EARNINGS_ENABLED,
  beginTransaction, parseCallback, claimCallbackTransaction,
  exchangeCode, clearTransaction, defaultByopStore,
  tokenUsable,
} from './byop.js';
import {
  renderStart, renderRound, renderReveal, renderResult, renderError,
  renderFreshSetup, renderFreshLoading, renderFreshError, appendFreshUsage,
  updateHud, hideHud, setShareStatus,
} from './view.js';

const app = document.getElementById('app');
const hudRefs = {
  hud: document.getElementById('hud'),
  dots: document.getElementById('dots'),
  score: document.getElementById('score'),
};
const APP_URL = location.origin + location.pathname;
const PRACTICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let bank = null;
let models = null;
let storeDaily = null;
let storePractice = null;
let session = null;        // { mode, date, practiceSeed }
let game = null;
let selected = null;
let savedPractice = null;  // resumable practice snapshot offered on the start screen
let freshCtx = null;       // { source, keyStore, key, tokenMeta, aborter } — live Fresh game only
let byopCallbackSettled = false; // single-shot OAuth callback guard (replay/dup-init safe)

function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function storeFor(mode) {
  if (mode === 'daily') return storeDaily;
  if (mode === 'practice') return storePractice;
  return null; // fresh: never persisted
}

// Abort any in-flight Fresh requests and drop in-memory key references.
// Called on Exit and on mode switch. The stored connection (sessionStorage
// vault) is KEPT — only Disconnect, expiry, or auth rejection clears it.
// Late arrivals are ignored via the source generation counter + the aborter
// identity check.
function cleanupFresh() {
  if (!freshCtx) return;
  try { if (freshCtx.aborter) freshCtx.aborter.abort(); } catch (_) { /* ignore */ }
  try { if (freshCtx.source) freshCtx.source.abort(); } catch (_) { /* ignore */ }
  freshCtx.key = null;
  freshCtx.tokenMeta = null;
  freshCtx = null;
}

// Drop stored credentials: the vault token plus any pending OAuth
// transaction. Used by Disconnect, auth rejection, and expiry. Never throws.
function clearFreshCredentials(keyStore) {
  try { if (keyStore) keyStore.clear(); } catch (_) { /* ignore */ }
  try { clearTransaction(defaultByopStore()); } catch (_) { /* ignore */ }
}

// Capture OAuth callback parameters and scrub them from the URL
// IMMEDIATELY (also on denial / malformed callbacks), before any further
// work. Returns the parsed params, or null when this is a plain load.
// Never logs the URL, code, verifier, or token.
function captureByopCallback() {
  let search = '';
  try {
    search = location.search || '';
  } catch (_) {
    return null;
  }
  const params = parseCallback(search);
  if (!params.present) return null;
  try {
    history.replaceState(null, '', location.pathname + (location.hash || ''));
  } catch (_) { /* URL stays, params are still single-use via the txn */ }
  return params;
}

function byopRecoverableMessage(kind) {
  switch (kind) {
    case 'denied':
      return 'Pollinations connection was not approved. Nothing was started — you can try connecting again.';
    case 'mismatch':
      return 'The connection reply did not match this tab. Nothing was started — try connecting again.';
    case 'stale':
      return 'The connection reply arrived too late. Nothing was started — try connecting again.';
    case 'duplicate':
      return 'The connection reply was malformed. Nothing was started — try connecting again.';
    case 'no-txn':
      return 'The connection data is gone (already used or the tab reloaded). Try connecting again.';
    case 'storage':
      return 'Tab storage is unavailable, so the connection cannot be verified. Daily and Practice still work.';
    default:
      return 'The Pollinations connection did not complete. Nothing was started — try connecting again.';
  }
}

// Same-page OAuth callback: capture → validate → consume → exchange →
// start, exactly once. Consent-denied / malformed / stale callbacks show a
// recoverable message with a connect-again action and never start Fresh.
async function finishByopCallback(params) {
  if (byopCallbackSettled) return;
  byopCallbackSettled = true;
  hideHud(hudRefs);
  const claim = claimCallbackTransaction({ params, storage: defaultByopStore(), now: Date.now });
  if (!claim.ok) {
    showFreshSetup(byopRecoverableMessage(claim.kind));
    return;
  }
  // The transaction is already consumed (deleted before exchange), so a
  // reload or replay during the exchange below cannot re-exchange the code.
  {
    const cost = buildCostNotice(BYOP_DEVELOPER_EARNINGS_ENABLED);
    renderFreshSetup(app, {
      notice: 'Completing the Pollinations connection…',
      connected: false,
      storageBlocked: false,
      earningsEnabled: BYOP_DEVELOPER_EARNINGS_ENABLED,
      costKo: cost.ko,
      costEn: cost.en,
      earningsKo: FRESH_EARNINGS_NOTICE_KO,
      earningsEn: FRESH_EARNINGS_NOTICE_EN,
      onConnect: () => {},
      onStart: () => {},
      onDisconnect: () => {},
      onCancel: () => {},
      busy: true,
    });
  }
  let ex = null;
  try {
    ex = await exchangeCode({
      code: claim.code,
      verifier: claim.verifier,
      fetchImpl: (...a) => fetch(...a),
      now: Date.now,
    });
  } catch (_) {
    ex = { ok: false, reason: 'network' };
  }
  if (!ex || !ex.ok) {
    // Exchange failed: the code is single-use and already consumed, so a
    // new connection (not a replay) is required.
    showFreshSetup('Pollinations could not finish the connection. Nothing was started — try Connect again.');
    return;
  }
  const keyStore = createKeyStore();
  keyStore.save(ex.token); // session vault, memory fallback after exchange is fine
  startFresh(keyStore, { token: ex.token, expiresAt: ex.expiresAt, obtainedAt: ex.obtainedAt });
}

// Begin the OAuth connect: stage a short-lived PKCE transaction, then leave
// in the SAME tab (no opener). Storage failure stops safely here — an
// in-memory verifier cannot survive the redirect.
async function connectFresh() {
  let begun = null;
  try {
    begun = await beginTransaction({ storage: defaultByopStore(), now: Date.now });
  } catch (_) {
    begun = { ok: false, reason: 'error' };
  }
  if (!begun || !begun.ok) {
    showFreshSetup(begun && begun.reason === 'storage'
      ? 'This browser blocks tab storage, so the Pollinations redirect cannot return safely. Connection is unavailable here — Daily and Practice still work.'
      : 'The connection could not start. Try again — Daily and Practice still work.');
    return;
  }
  try {
    location.assign(begun.url);
  } catch (_) {
    try { clearTransaction(defaultByopStore()); } catch (_) { /* ignore */ }
    showFreshSetup('The connection could not start. Try again — Daily and Practice still work.');
  }
}

function disconnectFresh() {
  if (freshCtx && freshCtx.keyStore) clearFreshCredentials(freshCtx.keyStore);
  else clearFreshCredentials(createKeyStore());
  cleanupFresh();
  showFreshSetup('Disconnected from Pollinations. The key and connection data were removed from this tab.');
}

async function boot() {
  const cbParams = captureByopCallback(); // parse + scrub the URL first
  try {
    bank = await loadBank();
    models = modelMap(bank);
  } catch (_) {
    renderError(app, 'Could not load the question bank. Check your connection and reload.', boot);
    return;
  }
  storeDaily = createStorage(undefined, 'model-match:daily:v1');
  storePractice = createStorage(undefined, 'model-match:practice:v1');

  // Read the practice snapshot on every boot path so a resumable game is
  // offered even when today's daily resumes automatically first.
  savedPractice = loadFreshPractice();

  // Same-page OAuth callback takes precedence over every resume path.
  if (cbParams) {
    await finishByopCallback(cbParams);
    return;
  }

  // Today's daily resumes automatically (Wordle-style).
  const daily = storeDaily.load();
  if (daily && daily.bankVersion === bank.bankVersion && !daily.done && daily.date === utcDateStr()) {
    restoreFrom(daily);
    return;
  }
  storeDaily.clear();

  showStart();
}

function loadFreshPractice() {
  const practice = storePractice.load();
  const fresh = practice && practice.bankVersion === bank.bankVersion && !practice.done &&
    (Date.now() - Number(practice.savedAt || 0)) < PRACTICE_MAX_AGE_MS;
  if (fresh) return practice;
  if (practice) storePractice.clear();
  return null;
}

function showStart() {
  cleanupFresh();
  session = null;
  game = null;
  hideHud(hudRefs);
  renderStart(app, {
    continueAvailable: Boolean(savedPractice),
    onDaily: () => startGame({ mode: 'daily', date: utcDateStr() }),
    onPractice: () => startGame({ mode: 'practice', practiceSeed: randomSeed() }),
    onFresh: () => showFreshSetup(''),
    onContinue: () => {
      const snap = savedPractice;
      savedPractice = null;
      if (snap) restoreFrom(snap);
    },
  });
}

function startGame(nextSession) {
  cleanupFresh();
  session = nextSession;
  if (nextSession.mode === 'practice') savedPractice = null;
  const rounds = buildRounds(bank, session);
  game = createGame(rounds);
  selected = null;
  persist();
  render();
}

function restoreFrom(saved) {
  cleanupFresh();
  session = { mode: saved.mode, date: saved.date, practiceSeed: saved.practiceSeed };
  // Only restoring the practice game itself consumes the resumable snapshot.
  if (saved.mode === 'practice') savedPractice = null;
  const rounds = buildRounds(bank, session);
  game = createGame(rounds, { picks: saved.picks, idx: saved.idx, done: saved.done });
  selected = null;
  render();
}

function persist() {
  if (!game || !session) return;
  const store = storeFor(session.mode);
  if (!store) return; // fresh: never persisted
  const s = game.state();
  store.save({
    bankVersion: bank.bankVersion,
    mode: session.mode,
    date: session.date,
    practiceSeed: session.practiceSeed,
    picks: s.picks,
    idx: s.idx,
    done: s.done,
    savedAt: Date.now(),
  });
}

function freshModelName(key) {
  const m = models && models.get ? models.get(key) : null;
  return (m && m.displayName) || String(key);
}

function showFreshSetup(notice) {
  cleanupFresh();
  session = null;
  game = null;
  hideHud(hudRefs);
  const keyStore = createKeyStore();
  const connected = canStartFresh({ token: keyStore.load() });
  const cost = buildCostNotice(BYOP_DEVELOPER_EARNINGS_ENABLED);
  renderFreshSetup(app, {
    notice,
    connected,
    storageBlocked: !defaultByopStore(),
    earningsEnabled: BYOP_DEVELOPER_EARNINGS_ENABLED,
    costKo: cost.ko,
    costEn: cost.en,
    earningsKo: FRESH_EARNINGS_NOTICE_KO,
    earningsEn: FRESH_EARNINGS_NOTICE_EN,
    onConnect: connectFresh,
    onStart: () => startFreshFromStore(createKeyStore()),
    onDisconnect: disconnectFresh,
    onCancel: showStart,
  });
}

// Start from the stored connection. Expired tokens are cleared and never
// used — renewal is a fresh Connect (there are no refresh tokens).
function startFreshFromStore(keyStore) {
  const token = keyStore.load();
  if (!canStartFresh({ token })) {
    clearFreshCredentials(keyStore);
    showFreshSetup('The connection is gone. Reconnect with Pollinations to play Fresh.');
    return;
  }
  startFresh(keyStore, { token, expiresAt: null, obtainedAt: Date.now() });
}

function startFresh(keyStore, tokenMeta) {
  if (!tokenUsable(tokenMeta, Date.now)) {
    clearFreshCredentials(keyStore);
    showFreshSetup('The Pollinations connection expired. Reconnect with Pollinations to play Fresh.');
    return;
  }
  const key = tokenMeta.token;
  let source;
  try {
    source = createFreshSource({ bank, seed: randomSeed(), fetchImpl: (...a) => fetch(...a) });
  } catch (err) {
    showFreshSetup('Fresh could not start with this bank. Daily and Practice still work.');
    return;
  }
  session = { mode: 'fresh' };
  game = createGame(source.getShells());
  selected = null;
  freshCtx = { source, keyStore, key, tokenMeta, aborter: null };
  fetchFreshRound(0);
}

function exitFresh() {
  cleanupFresh();
  showStart();
}

// Fetch round i on demand (4 live requests), then atomically commit before
// the round becomes playable. Guessing stays locked on the loading screen
// until then. Retries re-enter here and refetch only missing models —
// successes are cached inside the source and never regenerated.
async function fetchFreshRound(i) {
  if (!freshCtx || !session || session.mode !== 'fresh') return;
  const ctx = freshCtx;
  const aborter = new AbortController();
  ctx.aborter = aborter;
  updateHud(hudRefs, game.state(), game.size);
  renderFreshLoading(app, {
    idx: i,
    total: game.size,
    usage: ctx.source.getUsage(),
    onExit: exitFresh,
  });
  let res;
  try {
    res = await ctx.source.getRound({ roundIndex: i, key: ctx.key, signal: aborter.signal });
  } catch (_) {
    res = { ok: false, kind: 'retryable', failedKeys: [], succeededKeys: [] };
  }
  if (freshCtx !== ctx || ctx.aborter !== aborter) return; // stale: exited or superseded
  if (!session || session.mode !== 'fresh') return;
  if (res.ok) {
    render();
    return;
  }
  if (res.kind === 'auth') {
    // Rejected credentials: cancel everything, delete the connection, never
    // auto-retry. The setup screen is the Reconnect prompt.
    const ks = ctx.keyStore;
    cleanupFresh();
    clearFreshCredentials(ks);
    showFreshSetup('Pollinations rejected the connection (unauthorized). It has been removed — Reconnect with Pollinations to try again. No score was recorded.');
    return;
  }
  if (res.kind === 'budget' || res.kind === 'forbidden') {
    // Terminal spending/permission failure: stop new requests (the source
    // latches), in-flight requests were aborted, useful results stay in the
    // usage count. No retry is offered — exiting discards the unplayed round.
    const failedNames = (res.failedKeys || []).map(freshModelName);
    const title = res.kind === 'budget' ? 'Budget reached — stopped' : 'Not allowed — stopped';
    const message = res.kind === 'budget'
      ? 'Pollinations reported a spending/budget failure (402). No new requests will be sent. Check your budget or top up, then reconnect — requests already sent may still be billed.'
      : 'Pollinations refused this request (403' +
        (res.detail ? ': ' + res.detail : '') +
        '). This can mean a permissions or model restriction, not just an empty budget. No new requests will be sent — requests already sent may still be billed.';
    updateHud(hudRefs, game.state(), game.size);
    renderFreshError(app, {
      title,
      message,
      failedNames,
      usage: ctx.source.getUsage(),
      terminal: true,
      onDisconnect: disconnectFresh,
      onExit: exitFresh,
    });
    return;
  }
  if (res.kind === 'aborted') return; // exit path already handled
  if (res.kind === 'no-key') {
    cleanupFresh();
    showFreshSetup('The connection is gone. Reconnect with Pollinations to play Fresh.');
    return;
  }
  const failedNames = (res.failedKeys || []).map(freshModelName);
  const title = res.kind === 'rate' ? 'Rate limited — paused' : 'Generation failed — paused';
  const message = res.kind === 'rate'
    ? 'The API rate-limited this round. Nothing was scored. You can retry the missing answers or exit Fresh.'
    : 'Some answers could not be generated (timeout, network, or server error). Nothing was scored. You can retry the missing answers or exit Fresh.';
  updateHud(hudRefs, game.state(), game.size);
  renderFreshError(app, {
    title,
    message,
    failedNames,
    usage: ctx.source.getUsage(),
    retryAfter: res.retryAfter,
    onRetry: () => fetchFreshRound(i),
    onExit: exitFresh,
  });
}

function gainedAt(state) {
  let gained = 0;
  let streak = 0;
  for (let i = 0; i <= state.idx; i++) {
    if (state.results[i] === true) {
      streak += 1;
      gained = 100 + bonusFor(streak);
    } else {
      streak = 0;
    }
  }
  return gained;
}

function resultMessage(score) {
  if (score >= 600) return 'Perfect — you speak fluent model.';
  if (score >= 500) return 'Model whisperer.';
  if (score >= 350) return 'Sharp eye for style.';
  if (score >= 200) return 'Getting warm.';
  return 'The models fooled you this time.';
}

function render() {
  const state = game.state();
  const isFresh = session && session.mode === 'fresh';
  updateHud(hudRefs, state, game.size);

  if (state.phase === 'result') {
    const modeLabel = session.mode === 'daily' ? "Today's challenge" : (isFresh ? 'Fresh — live' : 'Practice');
    const dateLabel = session.mode === 'daily' ? session.date : (isFresh ? 'fresh' : 'random rounds');
    renderResult(app, {
      state,
      modeLabel,
      dateLabel,
      bankLabelText: bankLabel(bank),
      message: resultMessage(state.score),
      shareBtn: () => {
        const text = buildShareText({
          dateLabel: session.mode === 'daily' ? session.date : (isFresh ? 'fresh' : 'practice'),
          bankLabel: bankLabel(bank),
          pattern: state.pattern.join(''),
          score: state.score,
          modeLabel,
          url: APP_URL,
        });
        shareText(text).then((res) => {
          const msg = {
            shared: 'Shared!',
            copied: 'Copied to clipboard.',
            cancelled: '',
            failed: 'Could not share automatically — copy it manually:\n' + text,
          }[res] || '';
          setShareStatus(msg);
        });
      },
      onPractice: () => startGame({ mode: 'practice', practiceSeed: randomSeed() }),
      onHome: showStart,
    });
    if (isFresh && freshCtx) appendFreshUsage(app, freshCtx.source.getUsage());
    return;
  }

  if (state.phase === 'reveal') {
    renderReveal(app, {
      round: game.current(),
      models,
      chosenKey: state.picks[state.idx],
      correct: state.results[state.idx] === true,
      gained: gainedAt(state),
      isLast: state.idx + 1 >= game.size,
      idx: state.idx,
      total: game.size,
      onNext: () => {
        game.next();
        persist();
        if (isFresh) {
          // Next round is not playable until its 4 live answers commit.
          if (freshCtx && freshCtx.source.isCommitted(game.state().idx)) render();
          else fetchFreshRound(game.state().idx);
        } else {
          render();
        }
      },
    });
    if (isFresh && freshCtx) appendFreshUsage(app, freshCtx.source.getUsage());
    return;
  }

  if (isFresh) {
    // A round is playable only after atomic commit of all 4 answers.
    if (!freshCtx || !freshCtx.source.isCommitted(state.idx)) {
      fetchFreshRound(state.idx);
      return;
    }
  }

  renderRound(app, {
    round: game.current(),
    idx: state.idx,
    total: game.size,
    models,
    selected,
    onSelect: (key) => { selected = key; },
    onConfirm: () => {
      if (!selected) return;
      game.pick(selected);
      selected = null;
      persist();
      render();
    },
  });
  if (isFresh && freshCtx) appendFreshUsage(app, freshCtx.source.getUsage());
}

boot();
