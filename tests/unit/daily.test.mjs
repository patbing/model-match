import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildRounds, utcDateStr, hashSeed, mulberry32, shuffle } from '../../src/daily.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bank = JSON.parse(readFileSync(join(root, 'data', 'bank.v1.json'), 'utf8'));
const allKeys = bank.models.map((m) => m.key);

test('same seed params produce identical rounds', () => {
  const a = buildRounds(bank, { mode: 'daily', date: '2026-10-09' });
  const b = buildRounds(bank, { mode: 'daily', date: '2026-10-09' });
  assert.deepEqual(a, b);
});

test('different dates produce different rounds', () => {
  const a = buildRounds(bank, { mode: 'daily', date: '2026-10-09' });
  const b = buildRounds(bank, { mode: 'daily', date: '2026-10-10' });
  assert.notDeepEqual(a.map((r) => r.promptId), b.map((r) => r.promptId));
});

test('composition is 2 easy / 2 medium / 1 hard when the bank allows', () => {
  const rounds = buildRounds(bank, { mode: 'practice', practiceSeed: 42 });
  assert.equal(rounds.length, 5);
  const c = { easy: 0, medium: 0, hard: 0 };
  for (const r of rounds) c[r.difficulty] += 1;
  assert.equal(c.easy, 2);
  assert.equal(c.medium, 2);
  assert.equal(c.hard, 1);
});

test('options contain every model once and the correct key is present', () => {
  const rounds = buildRounds(bank, { mode: 'practice', practiceSeed: 7 });
  for (const r of rounds) {
    assert.deepEqual([...r.options].sort(), [...allKeys].sort());
    assert.ok(allKeys.includes(r.correctKey));
    assert.ok(r.answers.some((a) => a.modelKey === r.correctKey));
    assert.ok(r.answers.some((a) => a.id === r.shownAnswerId));
  }
});

test('correct-answer models cover all four with exactly one repeat', () => {
  const rounds = buildRounds(bank, { mode: 'daily', date: '2026-10-09' });
  const counts = {};
  for (const r of rounds) counts[r.correctKey] = (counts[r.correctKey] || 0) + 1;
  assert.equal(Object.keys(counts).length, allKeys.length);
  const vals = Object.values(counts);
  assert.equal(Math.max(...vals), 2);
  assert.equal(Math.min(...vals), 1);
  assert.equal(vals.reduce((a, b) => a + b, 0), 5);
});

test('prng + helpers are deterministic and pure', () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  assert.equal(a(), b());
  assert.equal(a(), b());
  assert.equal(hashSeed('x'), hashSeed('x'));
  const src = [1, 2, 3, 4];
  const s1 = shuffle(src, mulberry32(9));
  const s2 = shuffle(src, mulberry32(9));
  assert.deepEqual(s1, s2);
  assert.deepEqual(src, [1, 2, 3, 4]);
});

test('utcDateStr formats as YYYY-MM-DD', () => {
  assert.match(utcDateStr(new Date('2026-10-09T23:59:59Z')), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(utcDateStr(new Date('2026-10-09T23:59:59Z')), '2026-10-09');
});

test('practice mode is deterministic for the same seed', () => {
  const a = buildRounds(bank, { mode: 'practice', practiceSeed: 123 });
  const b = buildRounds(bank, { mode: 'practice', practiceSeed: 123 });
  assert.deepEqual(a, b);
});

test('falls back gracefully when difficulty buckets are scarce', () => {
  const tiny = {
    bankVersion: 'tiny',
    models: bank.models,
    prompts: [0, 1, 2, 3, 4].map((i) => ({
      id: 't' + i,
      category: 'explanation',
      difficulty: 'hard',
      text: 'Tiny prompt ' + i,
      answers: bank.models.map((m) => ({
        id: 't' + i + '-' + m.key,
        modelKey: m.key,
        text: 'Answer ' + i + ' from ' + m.key,
      })),
    })),
  };
  const rounds = buildRounds(tiny, { mode: 'practice', practiceSeed: 5 });
  assert.equal(rounds.length, 5);
  assert.ok(rounds.every((r) => r.options.length === 4));
});
