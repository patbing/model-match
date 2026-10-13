import { loadBank, modelMap, bankLabel } from './bank.js';
import { buildRounds, utcDateStr } from './daily.js';
import { createGame, bonusFor } from './game.js';
import { createStorage } from './storage.js';
import { buildShareText, shareText } from './share.js';
import {
  createFreshSource, createKeyStore, canStartFresh,
  FRESH_COST_NOTICE_EN, FRESH_COST_NOTICE_KO,
} from './fresh.js';
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
let freshCtx = null;       // { source, keyStore, key, aborter } — live Fresh game only

function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function storeFor(mode) {
  if (mode === 'daily') return storeDaily;
  if (mode === 'practice') return storePractice;
  return null; // fresh: never persisted
}

// Abort any in-flight Fresh requests and drop every key reference.
// Called on Exit, on mode switch, and on 401. Late arrivals are ignored
// via the source generation counter + the aborter identity check.
function cleanupFresh() {
  if (!freshCtx) return;
  try { if (freshCtx.aborter) freshCtx.aborter.abort(); } catch (_) { /* ignore */ }
  try { if (freshCtx.source) freshCtx.source.abort(); } catch (_) { /* ignore */ }
  try { if (freshCtx.keyStore) freshCtx.keyStore.clear(); } catch (_) { /* ignore */ }
  freshCtx.key = null;
  freshCtx = null;
}

async function boot() {
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
  renderFreshSetup(app, {
    notice,
    setupError: notice,
    storeMode: keyStore.storeMode(),
    costKo: FRESH_COST_NOTICE_KO,
    costEn: FRESH_COST_NOTICE_EN,
    onStart: ({ key, consent }) => {
      if (!canStartFresh({ key, consent })) {
        showFreshSetup('Enter your API key and tick the cost consent checkbox to start.');
        return;
      }
      keyStore.save(key);
      startFresh(keyStore);
    },
    onCancel: showStart,
    onDeleteKey: () => keyStore.clear(),
  });
}

function startFresh(keyStore) {
  const key = keyStore.load();
  if (!key) {
    showFreshSetup('The key could not be read back. Type it again to start.');
    return;
  }
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
  freshCtx = { source, keyStore, key, aborter: null };
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
    // 401/403: cancel everything, delete the key, never auto-retry.
    cleanupFresh();
    showFreshSetup('That key was rejected by the API (unauthorized). It has been deleted — check the key and try again. No score was recorded.');
    return;
  }
  if (res.kind === 'aborted') return; // exit path already handled
  if (res.kind === 'no-key') {
    cleanupFresh();
    showFreshSetup('The key is gone. Type it again to start Fresh.');
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
