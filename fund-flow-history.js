'use strict';

const DEFAULT_FRESH_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_MAX_ENTRIES = 500;

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFundFlowHistoryPayload(payload) {
  if (payload?.rc != null && Number(payload.rc) !== 0) {
    throw new Error(`Fund flow upstream returned rc=${payload.rc}`);
  }
  const data = (payload?.data?.klines || []).map(line => {
    const fields = String(line).split(',');
    return {
      date:fields[0],
      mainNet:numberOrNull(fields[1]),
      smallNet:numberOrNull(fields[2]),
      mediumNet:numberOrNull(fields[3]),
      largeNet:numberOrNull(fields[4]),
      superLargeNet:numberOrNull(fields[5]),
      mainRatio:numberOrNull(fields[6]),
      smallRatio:numberOrNull(fields[7]),
      mediumRatio:numberOrNull(fields[8]),
      largeRatio:numberOrNull(fields[9]),
      superLargeRatio:numberOrNull(fields[10]),
      close:numberOrNull(fields[11]),
      pct:numberOrNull(fields[12]),
    };
  }).filter(item => item.date && Number.isFinite(item.mainNet));
  if (!data.length) throw new Error('Fund flow history is empty');
  return data;
}

function createFundFlowHistoryLoader({
  fetchPayload,
  now = () => Date.now(),
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  freshMs = DEFAULT_FRESH_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  attempts = DEFAULT_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  onBackgroundError = () => {},
} = {}) {
  if (typeof fetchPayload !== 'function') throw new TypeError('fetchPayload is required');
  const cache = new Map();
  const pending = new Map();
  const attemptCount = Math.max(1, Math.floor(attempts));

  function store(symbol, data) {
    cache.delete(symbol);
    cache.set(symbol, { fetchedAt:now(), data });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  function refresh(symbol) {
    if (pending.has(symbol)) return pending.get(symbol);
    const task = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        try {
          const data = parseFundFlowHistoryPayload(await fetchPayload(symbol));
          store(symbol, data);
          return data;
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attemptCount) await wait(retryDelayMs * (attempt + 1));
        }
      }
      throw lastError || new Error('Fund flow history is unavailable');
    })();
    pending.set(symbol, task);
    task.finally(() => pending.delete(symbol)).catch(() => {});
    return task;
  }

  async function load(symbol) {
    const cached = cache.get(symbol);
    if (cached && now() - cached.fetchedAt < freshMs) return cached.data;
    if (cached?.data?.length) {
      refresh(symbol).catch(error => onBackgroundError(error, symbol));
      return cached.data;
    }
    return refresh(symbol);
  }

  return { load, cache, pending };
}

module.exports = {
  createFundFlowHistoryLoader,
  parseFundFlowHistoryPayload,
  DEFAULT_FRESH_MS,
};
