'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createQuoteSnapshotCache,
  normalizeQuoteSymbols,
  parseQuoteLines,
} = require('../quote-feed');

test('quote requests accept supported markets, dedupe symbols and enforce a hard cap', () => {
  assert.deepEqual(normalizeQuoteSymbols('sh600519,sz000001,sh600519,hk00700,usBRK.B'), [
    'sh600519', 'sz000001', 'hk00700', 'usBRK.B',
  ]);
  assert.equal(normalizeQuoteSymbols('fund000001'), null);
  assert.equal(normalizeQuoteSymbols('sh600519,bad<script>'), null);
  assert.equal(normalizeQuoteSymbols(Array.from({ length:101 }, (_, index) => `usT${index}`).join(',')), null);
});

test('quote parser keeps only well-formed supported quote assignments', () => {
  const rows = parseQuoteLines([
    'v_sh600519="1~贵州茅台~600519~1500";',
    'v_usAAPL="200~Apple~AAPL~230";',
    'v_fund000001="not supported";',
    'globalThis.pwned=true;',
  ].join('\n'));
  assert.deepEqual([...rows.keys()], ['sh600519', 'usAAPL']);
});

test('quote cache merges live rows with recent fallback and expires stale snapshots', () => {
  let timestamp = 1000;
  const cache = createQuoteSnapshotCache({ maxAgeMs:5000, now:() => timestamp });
  cache.store('v_sh600519="old";\nv_sz000001="bank";');

  timestamp = 2000;
  const live = parseQuoteLines('v_sh600519="fresh";');
  const merged = cache.compose(['sh600519', 'sz000001', 'hk00700'], { liveLines:live });
  assert.match(merged.text, /v_sh600519="fresh"/);
  assert.match(merged.text, /v_sz000001="bank"/);
  assert.deepEqual(merged.stale, ['sz000001']);
  assert.deepEqual(merged.missing, ['hk00700']);

  timestamp = 7001;
  const expired = cache.compose(['sz000001']);
  assert.equal(expired.text, '');
  assert.deepEqual(expired.missing, ['sz000001']);
});
