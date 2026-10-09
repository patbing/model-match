import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAnswer } from '../../src/view.js';

test('formatAnswer escapes angled brackets', () => {
  const out = formatAnswer('<script>alert(1)</script>');
  assert.ok(!out.includes('<script'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('bold conversion cannot smuggle tags', () => {
  const out = formatAnswer('**<img src=x onerror=alert(1)>**');
  assert.ok(!/<img/i.test(out));
  assert.ok(out.includes('<strong>'));
  assert.ok(out.includes('&lt;img'));
});

test('plain text and newlines survive', () => {
  assert.equal(formatAnswer('line1\nline2'), 'line1<br>line2');
  assert.equal(formatAnswer('plain'), 'plain');
});
