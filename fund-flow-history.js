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

function mergeFundFlowHistory(history, current, limit = 120) {
  const rows = (Array.isArray(history) ? history : [])
    .filter(item => item?.date && Number.isFinite(Number(item.mainNet)))
    .map(item => ({ ...item }));
  if (current?.date && Number.isFinite(Number(current.mainNet))) {
    const index = rows.findIndex(item => item.date === current.date);
    if (index >= 0) rows[index] = { ...rows[index], ...current };
    else rows.push({ ...current });
  }
  return rows
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(-Math.max(1, Number(limit) || 120));
}

function createFundFlowHistoryLoader({
  fetchPayload,
  loadPersisted = async () => null,
  savePersisted = async () => {},
  now = () => Date.now(),
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  freshMs = DEFAULT_FRESH_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  attempts = DEFAULT_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  onBackgroundError = () => {},
  onPersistenceError = () => {},
} = {}) {
  if (typeof fetchPayload !== 'function') throw new TypeError('fetchPayload is required');
  const cache = new Map();
  const pending = new Map();
  const hydrating = new Map();
  const attemptCount = Math.max(1, Math.floor(attempts));

  function store(symbol, data, { fetchedAt = now(), source = 'upstream', persisted = false } = {}) {
    cache.delete(symbol);
    cache.set(symbol, { fetchedAt, data, source, persisted });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  function hydrate(symbol) {
    if (hydrating.has(symbol)) return hydrating.get(symbol);
    const task = (async () => {
      try {
        const saved = await loadPersisted(symbol);
        const data = Array.isArray(saved?.data)
          ? saved.data.filter(item => item?.date && Number.isFinite(Number(item.mainNet)))
          : [];
        if (!data.length) return null;
        const fetchedAt = new Date(saved.fetchedAt || 0).getTime();
        store(symbol, data.map(item => ({ ...item, mainNet:Number(item.mainNet) })), {
          fetchedAt:Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0,
          source:saved.source || 'persistent-cache',
          persisted:true,
        });
        return cache.get(symbol);
      } catch (error) {
        onPersistenceError(error, symbol, 'load');
        return null;
      }
    })();
    hydrating.set(symbol, task);
    task.finally(() => hydrating.delete(symbol)).catch(() => {});
    return task;
  }

  function refresh(symbol) {
    if (pending.has(symbol)) return pending.get(symbol);
    const task = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        try {
          const result = await fetchPayload(symbol);
          const payload = result?.payload || result;
          const source = result?.source || 'upstream';
          const data = parseFundFlowHistoryPayload(payload);
          store(symbol, data, { source });
          try {
            await savePersisted(symbol, { data, source, fetchedAt:new Date(now()) });
          } catch (error) {
            onPersistenceError(error, symbol, 'save');
          }
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
    let cached = cache.get(symbol);
    if (!cached) {
      await hydrate(symbol);
      cached = cache.get(symbol);
    }
    if (cached && now() - cached.fetchedAt < freshMs) return cached.data;
    if (cached?.data?.length) {
      refresh(symbol).catch(error => onBackgroundError(error, symbol));
      return cached.data;
    }
    return refresh(symbol);
  }

  function info(symbol) {
    const item = cache.get(symbol);
    return item ? {
      fetchedAt:item.fetchedAt,
      source:item.source,
      persisted:item.persisted,
      stale:now() - item.fetchedAt >= freshMs,
    } : null;
  }

  return { load, info, cache, pending, hydrating };
}

module.exports = {
  createFundFlowHistoryLoader,
  mergeFundFlowHistory,
  parseFundFlowHistoryPayload,
  DEFAULT_FRESH_MS,
};
