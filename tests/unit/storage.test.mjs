import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorage } from '../../src/storage.js';

function memBacking() {
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

test('round-trip save/load', () => {
  const s = createStorage(memBacking(), 'k');
  assert.equal(s.load(), null);
  s.save({ bankVersion: 'v1', mode: 'practice', picks: [null, 'm1'], idx: 1 });
  const out = s.load();
  assert.equal(out.bankVersion, 'v1');
  assert.deepEqual(out.picks, [null, 'm1']);
});

test('mode-less or invalid-mode snapshots read as null', () => {
  const backing = memBacking();
  const s = createStorage(backing, 'k');
  backing.setItem('k', JSON.stringify({ bankVersion: 'v1', picks: [] }));
  assert.equal(s.load(), null);
  backing.setItem('k', JSON.stringify({ bankVersion: 'v1', picks: [], mode: 'weird' }));
  assert.equal(s.load(), null);
  backing.setItem('k', JSON.stringify({ bankVersion: 'v1', picks: [], mode: 'daily' }));
  assert.equal(s.load(), null);
});

test('corrupt or foreign data reads as null', () => {
  const backing = memBacking();
  const s = createStorage(backing, 'k');
  backing.setItem('k', '{broken json');
  assert.equal(s.load(), null);
  backing.setItem('k', JSON.stringify({ nothing: true }));
  assert.equal(s.load(), null);
  backing.setItem('k', JSON.stringify({ bankVersion: 'v1', picks: 'not-an-array' }));
  assert.equal(s.load(), null);
});

test('clear removes the key', () => {
  const backing = memBacking();
  const s = createStorage(backing, 'k');
  s.save({ bankVersion: 'v1', picks: [] });
  s.clear();
  assert.equal(s.load(), null);
});

test('no backing store does not throw', () => {
  const s = createStorage(null, 'k');
  s.save({ bankVersion: 'v1', picks: [] });
  assert.equal(s.load(), null);
  s.clear();
});

test('a throwing localStorage getter still yields a working storage', () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: storage blocked'); },
  });
  try {
    const s = createStorage();
    s.save({ bankVersion: 'v1', picks: [] });
    assert.equal(s.load(), null);
    s.clear();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'localStorage', desc);
    else delete globalThis.localStorage;
  }
});
