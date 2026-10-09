import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShareText } from '../../src/share.js';

test('share text carries pattern, score, mode and url', () => {
  const text = buildShareText({
    dateLabel: '2026-10-09',
    bankLabel: 'Bank v1',
    pattern: '🟩🟥🟩',
    score: 300,
    modeLabel: 'Daily challenge',
    url: 'https://example.com/x',
  });
  assert.ok(text.includes('Model Match 2026-10-09'));
  assert.ok(text.includes('🟩🟥🟩'));
  assert.ok(text.includes('300/600'));
  assert.ok(text.includes('https://example.com/x'));
});

test('share text does not leak model keys or answers', () => {
  const text = buildShareText({
    dateLabel: 'd',
    bankLabel: 'Bank v1',
    pattern: '🟩',
    score: 100,
    modeLabel: 'Practice',
    url: 'u',
  });
  for (const k of ['m1', 'm2', 'm3', 'm4', 'correctKey', 'answer']) {
    assert.ok(!text.includes(k), `share text should not contain ${k}`);
  }
});
