'use strict';

const QUOTE_SYMBOL_PATTERN = /^(?:(?:sh|sz)\d{6}|hk\d{5}|us[A-Z0-9._-]{1,24})$/i;

function normalizeQuoteSymbols(value, { maxSymbols = 100 } = {}) {
  const input = String(value || '').split(',').map(symbol => symbol.trim()).filter(Boolean);
  if (!input.length || input.length > maxSymbols) return null;
  const symbols = [...new Set(input)];
  if (!symbols.length || symbols.some(symbol => !QUOTE_SYMBOL_PATTERN.test(symbol))) return null;
  return symbols;
}

function parseQuoteLines(value) {
  const lines = new Map();
  for (const rawLine of String(value || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^v_([A-Za-z0-9._-]+)="([^"]*)";?$/);
    if (!match || !QUOTE_SYMBOL_PATTERN.test(match[1]) || !match[2]) continue;
    lines.set(match[1], `v_${match[1]}="${match[2]}";`);
  }
  return lines;
}

function createQuoteSnapshotCache({ maxEntries = 500, maxAgeMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();

  function prune(timestamp = now()) {
    for (const [symbol, entry] of entries) {
      if (timestamp - entry.fetchedAt > maxAgeMs) entries.delete(symbol);
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function store(text, fetchedAt = now()) {
    const parsed = parseQuoteLines(text);
    for (const [symbol, line] of parsed) {
      entries.delete(symbol);
      entries.set(symbol, { line, fetchedAt });
    }
    prune(fetchedAt);
    return parsed;
  }

  function compose(symbols, { liveLines = new Map(), timestamp = now() } = {}) {
    prune(timestamp);
    const lines = [];
    const stale = [];
    const missing = [];
    for (const symbol of symbols) {
      if (liveLines.has(symbol)) {
        lines.push(liveLines.get(symbol));
        continue;
      }
      const cached = entries.get(symbol);
      if (cached && timestamp - cached.fetchedAt <= maxAgeMs) {
        lines.push(cached.line);
        stale.push(symbol);
      } else {
        missing.push(symbol);
      }
    }
    return { text:lines.join('\n'), stale, missing };
  }

  return { compose, store, size:() => entries.size };
}

module.exports = {
  QUOTE_SYMBOL_PATTERN,
  createQuoteSnapshotCache,
  normalizeQuoteSymbols,
  parseQuoteLines,
};
