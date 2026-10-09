import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, bonusFor, MAX_SCORE } from '../../src/game.js';

const rounds = (n) => Array.from({ length: n }, (_, i) => ({ id: 'r' + i, correctKey: 'k' }));

test('five correct picks score 600 with streak bonuses', () => {
  const g = createGame(rounds(5));
  for (let i = 0; i < 5; i++) {
    assert.equal(g.pick('k'), true);
    assert.equal(g.next(), true);
  }
  const s = g.state();
  assert.equal(s.score, MAX_SCORE);
  assert.deepEqual(s.pattern, ['🟩', '🟩', '🟩', '🟩', '🟩']);
  assert.equal(s.done, true);
});

test('all wrong scores zero', () => {
  const g = createGame(rounds(5));
  for (let i = 0; i < 5; i++) { g.pick('x'); g.next(); }
  assert.equal(g.state().score, 0);
  assert.deepEqual(g.state().pattern, ['🟥', '🟥', '🟥', '🟥', '🟥']);
});

test('streak resets after a miss', () => {
  const g = createGame(rounds(5));
  g.pick('k'); g.next();   // +100
  g.pick('x'); g.next();   // streak reset
  g.pick('k'); g.next();   // +100
  g.pick('k'); g.next();   // +110
  g.pick('k'); g.next();   // +120
  assert.equal(g.state().score, 430);
});

test('bonus schedule matches spec', () => {
  assert.equal(bonusFor(1), 0);
  assert.equal(bonusFor(2), 10);
  assert.equal(bonusFor(3), 20);
  assert.equal(bonusFor(4), 30);
  assert.equal(bonusFor(5), 40);
});

test('no double pick, no premature next, no pick after reveal', () => {
  const g = createGame(rounds(2));
  assert.equal(g.next(), false);
  assert.equal(g.pick('k'), true);
  assert.equal(g.pick('k'), false);
  assert.equal(g.pick('k'), false);
  assert.equal(g.next(), true);
  assert.equal(g.state().phase, 'round');
});

test('restore mid-reveal from saved picks', () => {
  const g = createGame(rounds(3), { picks: ['k', 'x', null], idx: 1 });
  const s = g.state();
  assert.equal(s.idx, 1);
  assert.equal(s.phase, 'reveal');
  assert.equal(s.score, 100);
});

test('restore of a finished game lands on results', () => {
  const g = createGame(rounds(2), { picks: ['k', 'k'], idx: 1, done: true });
  const s = g.state();
  assert.equal(s.done, true);
  assert.equal(s.score, 210);
});

test('empty rounds degrade gracefully', () => {
  const g = createGame([]);
  assert.equal(g.state().phase, 'result');
});

test('empty rounds with an initial snapshot stay safe', () => {
  const g = createGame([], { picks: [], idx: 0, done: true });
  const s = g.state();
  assert.equal(s.phase, 'result');
  assert.equal(s.idx, 0);
  assert.equal(s.score, 0);
});
