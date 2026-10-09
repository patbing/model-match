// Pure game state machine. No DOM.

export const MAX_SCORE = 600;

export function bonusFor(streak) {
  return streak >= 2 ? (streak - 1) * 10 : 0;
}

export function createGame(rounds, initial = null) {
  const n = rounds.length;
  const picks = new Array(n).fill(null);
  const results = new Array(n).fill(null);
  let idx = 0;
  let phase = n > 0 ? 'round' : 'result';

  if (initial && Array.isArray(initial.picks)) {
    for (let i = 0; i < n; i++) {
      const key = initial.picks[i];
      if (typeof key === 'string' && rounds[i]) {
        picks[i] = key;
        results[i] = key === rounds[i].correctKey;
      }
    }
    idx = n > 0 ? Math.min(Math.max(0, initial.idx | 0), n - 1) : 0;
    phase = n === 0 ? 'result' : (picks[idx] === null ? 'round' : 'reveal');
    if (initial.done === true && n > 0) { phase = 'result'; idx = n - 1; }
  }

  function totals() {
    let score = 0;
    let streak = 0;
    const pattern = [];
    for (let i = 0; i < n; i++) {
      if (results[i] === true) {
        streak += 1;
        score += 100 + bonusFor(streak);
        pattern.push('🟩');
      } else if (results[i] === false) {
        streak = 0;
        pattern.push('🟥');
      } else {
        pattern.push('⬜');
      }
    }
    return { score, streak, pattern };
  }

  return {
    get size() { return n; },
    state() {
      const t = totals();
      return {
        idx, phase,
        picks: picks.slice(),
        results: results.slice(),
        score: t.score,
        pattern: t.pattern,
        done: phase === 'result',
      };
    },
    current() { return rounds[idx] || null; },
    pick(key) {
      if (phase !== 'round' || picks[idx] !== null || !rounds[idx]) return false;
      picks[idx] = key;
      results[idx] = key === rounds[idx].correctKey;
      phase = 'reveal';
      return true;
    },
    next() {
      if (phase !== 'reveal') return false;
      if (idx + 1 >= n) phase = 'result';
      else { idx += 1; phase = 'round'; }
      return true;
    },
  };
}
