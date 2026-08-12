'use strict';

// The daily curve is stable once a trading day has closed.  Keep it fresh often
// enough to pick up Eastmoney corrections, but do not make every chart opening
// another upstream request.  Today's value is supplied separately by the
// realtime Eastmoney endpoint and is therefore not delayed by this cache.
const DEFAULT_FRESH_MS = 15 * 60 * 1000;
const DEFAULT_FALLBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_COOLDOWN_MS = 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 750;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_MAX_ENTRIES = 500;

function createAsyncTaskQueue({ concurrency = 4, maxQueued = 120 } = {}) {
  const maxActive = Math.max(1, Math.floor(Number(concurrency) || 1));
  const maxWaiting = Math.max(0, Math.floor(Number(maxQueued) || 0));
  const queue = [];
  let active = 0;

  function drain() {
    while (active < maxActive && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function run(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('queue task must be a function'));
    if (queue.length >= maxWaiting && active >= maxActive) return Promise.reject(new Error('Request queue is full'));
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  }

  return { run, info:() => ({ active, queued:queue.length, concurrency:maxActive, maxQueued:maxWaiting }) };
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseFundFlowHistoryPayload(payload) {
  if (Number(payload?.rc) !== 0) throw new Error(`Fund flow upstream returned rc=${payload?.rc ?? 'unknown'}`);
  const data = (payload?.data?.klines || []).map(line => {
    const fields = String(line).split(',');
    return {
      date:fields[0], mainNet:numberOrNull(fields[1]), smallNet:numberOrNull(fields[2]), mediumNet:numberOrNull(fields[3]),
      largeNet:numberOrNull(fields[4]), superLargeNet:numberOrNull(fields[5]), mainRatio:numberOrNull(fields[6]),
      smallRatio:numberOrNull(fields[7]), mediumRatio:numberOrNull(fields[8]), largeRatio:numberOrNull(fields[9]),
      superLargeRatio:numberOrNull(fields[10]), close:numberOrNull(fields[11]), pct:numberOrNull(fields[12]),
    };
  }).filter(item => item.date && Number.isFinite(item.mainNet))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
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
  fetchData,
  source = 'eastmoney-daykline',
  acceptedSources = [source],
  loadPersisted = async () => null,
  savePersisted = async () => {},
  now = () => Date.now(),
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  freshMs = DEFAULT_FRESH_MS,
  fallbackMs = DEFAULT_FALLBACK_MS,
  refreshCooldownMs = DEFAULT_REFRESH_COOLDOWN_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  attempts = DEFAULT_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  onPersistenceError = () => {},
} = {}) {
  if (typeof fetchData !== 'function') throw new TypeError('fetchData is required');
  const cache = new Map();
  const pending = new Map();
  const hydrating = new Map();
  const refreshCooldowns = new Map();
  const refreshErrors = new Map();
  const acceptedSource = String(source);
  const allowedSources = new Set((Array.isArray(acceptedSources) ? acceptedSources : [acceptedSources])
    .map(item => String(item)));
  allowedSources.add(acceptedSource);
  const attemptCount = Math.max(1, Math.floor(Number(attempts) || 1));

  function validRows(data) {
    return Array.isArray(data) && data.length && data.every(item => item?.date && Number.isFinite(Number(item.mainNet)));
  }

  function store(symbol, data, sourceName = acceptedSource, fetchedAt = now()) {
    cache.delete(symbol);
    cache.set(symbol, { data:data.map(item => ({ ...item })), source:sourceName, fetchedAt });
    while (cache.size > maxEntries) {
      const oldestSymbol = cache.keys().next().value;
      cache.delete(oldestSymbol);
      refreshCooldowns.delete(oldestSymbol);
      refreshErrors.delete(oldestSymbol);
    }
    return cache.get(symbol);
  }

  function capRefreshState(entries) {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function result(item, { stale = false } = {}) {
    return {
      data:item.data.map(point => ({ ...point })),
      meta:{ source:item.source, cached:true, stale, fetchedAt:item.fetchedAt },
    };
  }

  function hydrate(symbol) {
    if (hydrating.has(symbol)) return hydrating.get(symbol);
    const task = (async () => {
      try {
        const saved = await loadPersisted(symbol);
        if (!allowedSources.has(String(saved?.source)) || !validRows(saved.data)) return null;
        const fetchedAt = new Date(saved.fetchedAt || 0).getTime();
        if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
        return store(symbol, saved.data, String(saved.source), fetchedAt);
      } catch (error) {
        onPersistenceError(error, symbol, 'load');
        return null;
      }
    })();
    hydrating.set(symbol, task);
    task.finally(() => hydrating.delete(symbol)).catch(() => {});
    return task;
  }

  function refresh(symbol, { force = false } = {}) {
    if (pending.has(symbol)) return pending.get(symbol);
    if (!force && (refreshCooldowns.get(symbol) || 0) > now()) return null;
    refreshCooldowns.set(symbol, now() + Math.max(0, Number(refreshCooldownMs) || 0));
    capRefreshState(refreshCooldowns);
    const task = (async () => {
      let lastError;
      for (let attempt = 0; attempt < attemptCount; attempt += 1) {
        try {
          const fetched = await fetchData(symbol);
          const data = Array.isArray(fetched?.data) ? fetched.data : fetched;
          const sourceName = String(fetched?.source || acceptedSource);
          if (!allowedSources.has(sourceName)) throw new Error(`Fund flow source is not allowed: ${sourceName}`);
          if (!validRows(data)) throw new Error('Fund flow history is empty');
          const item = store(symbol, data, sourceName);
          refreshErrors.delete(symbol);
          try {
            await savePersisted(symbol, { data:item.data, source:item.source, fetchedAt:new Date(item.fetchedAt) });
          } catch (error) {
            onPersistenceError(error, symbol, 'save');
          }
          return { data:item.data.map(point => ({ ...point })), meta:{ source:item.source, cached:false, stale:false, fetchedAt:item.fetchedAt } };
        } catch (error) {
          lastError = error;
          if (attempt + 1 < attemptCount) await wait(retryDelayMs * (attempt + 1));
        }
      }
      const error = lastError || new Error('Fund flow history is unavailable');
      refreshErrors.set(symbol, error);
      capRefreshState(refreshErrors);
      throw error;
    })();
    pending.set(symbol, task);
    task.finally(() => pending.delete(symbol)).catch(() => {});
    return task;
  }

  async function load(symbol, { force = false } = {}) {
    let item = cache.get(symbol);
    if (!item) item = await hydrate(symbol);
    const age = item ? now() - item.fetchedAt : Infinity;
    if (!force && item && age >= 0 && age < freshMs) return result(item);
    // Serve a valid, same-source curve immediately while a single background
    // request refreshes it.  This avoids a slow or intermittent upstream
    // request making the chart look unavailable, while the metadata still
    // tells the browser that the curve is cached.
    if (!force && item && age >= 0 && age <= fallbackMs) {
      const task = refresh(symbol);
      if (task) task.catch(() => {});
      return result(item, { stale:true });
    }
    try {
      const task = refresh(symbol, { force });
      if (!task) throw refreshErrors.get(symbol) || new Error('Fund flow history refresh is cooling down');
      return await task;
    } catch (error) {
      if (item && age >= 0 && age <= fallbackMs) return result(item, { stale:true });
      throw error;
    }
  }

  return { load, cache, pending, hydrating, refreshCooldowns };
}

module.exports = {
  createAsyncTaskQueue,
  createFundFlowHistoryLoader,
  mergeFundFlowHistory,
  parseFundFlowHistoryPayload,
  DEFAULT_FRESH_MS,
  DEFAULT_FALLBACK_MS,
  DEFAULT_REFRESH_COOLDOWN_MS,
};
