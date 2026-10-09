// Deterministic round selection. Same (mode, date/seed, bankVersion) => same game.

export function utcDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rnd) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function seedString({ mode, date, practiceSeed, bankVersion }) {
  return mode === 'daily'
    ? `daily|${date}|${bankVersion}`
    : `practice|${practiceSeed}|${bankVersion}`;
}

const WANT = [['easy', 2], ['medium', 2], ['hard', 1]];

export function buildRounds(bank, params) {
  const rnd = mulberry32(hashSeed(seedString({ ...params, bankVersion: bank.bankVersion })));
  const by = { easy: [], medium: [], hard: [] };
  for (const p of bank.prompts) (by[p.difficulty] || by.medium).push(p);

  const chosen = [];
  const used = new Set();
  for (const [diff, want] of WANT) {
    const pool = shuffle(by[diff], rnd).filter((p) => !used.has(p.id));
    for (let i = 0; i < want && i < pool.length; i++) {
      chosen.push(pool[i]);
      used.add(pool[i].id);
    }
  }
  if (chosen.length < 5) {
    const rest = shuffle(bank.prompts.filter((p) => !used.has(p.id)), rnd);
    while (chosen.length < 5 && rest.length) {
      const p = rest.pop();
      chosen.push(p);
      used.add(p.id);
    }
  }

  const modelKeys = bank.models.map((m) => m.key);
  const base = shuffle(modelKeys, rnd);
  const extra = modelKeys[Math.floor(rnd() * modelKeys.length)];
  const targets = shuffle([...base, extra], rnd).slice(0, chosen.length);

  return chosen.map((p, i) => {
    const target = targets[i] || p.answers[0].modelKey;
    const shown = p.answers.find((a) => a.modelKey === target) || p.answers[0];
    return {
      promptId: p.id,
      promptText: p.text,
      category: p.category,
      difficulty: p.difficulty,
      shownAnswerId: shown.id,
      shownText: shown.text,
      correctKey: shown.modelKey,
      answers: p.answers,
      options: shuffle(modelKeys, rnd),
    };
  });
}
