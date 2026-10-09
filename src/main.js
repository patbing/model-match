import { loadBank, modelMap, bankLabel } from './bank.js';
import { buildRounds, utcDateStr } from './daily.js';
import { createGame, bonusFor } from './game.js';
import { createStorage } from './storage.js';
import { buildShareText, shareText } from './share.js';
import {
  renderStart, renderRound, renderReveal, renderResult, renderError,
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

function randomSeed() {
  return Math.floor(Math.random() * 0x7fffffff);
}

function storeFor(mode) {
  return mode === 'daily' ? storeDaily : storePractice;
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
  hideHud(hudRefs);
  renderStart(app, {
    continueAvailable: Boolean(savedPractice),
    onDaily: () => startGame({ mode: 'daily', date: utcDateStr() }),
    onPractice: () => startGame({ mode: 'practice', practiceSeed: randomSeed() }),
    onContinue: () => {
      const snap = savedPractice;
      savedPractice = null;
      if (snap) restoreFrom(snap);
    },
  });
}

function startGame(nextSession) {
  session = nextSession;
  if (nextSession.mode === 'practice') savedPractice = null;
  const rounds = buildRounds(bank, session);
  game = createGame(rounds);
  selected = null;
  persist();
  render();
}

function restoreFrom(saved) {
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
  const s = game.state();
  storeFor(session.mode).save({
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
  updateHud(hudRefs, state, game.size);

  if (state.phase === 'result') {
    const modeLabel = session.mode === 'daily' ? "Today's challenge" : 'Practice';
    const dateLabel = session.mode === 'daily' ? session.date : 'random rounds';
    renderResult(app, {
      state,
      modeLabel,
      dateLabel,
      bankLabelText: bankLabel(bank),
      message: resultMessage(state.score),
      shareBtn: () => {
        const text = buildShareText({
          dateLabel: session.mode === 'daily' ? session.date : 'practice',
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
      onNext: () => { game.next(); persist(); render(); },
    });
    return;
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
}

boot();
