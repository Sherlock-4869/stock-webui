'use strict';

const DEFAULT_FRESH_MS = 60 * 1000;
const DEFAULT_FALLBACK_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 250;
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

function createFundFlowHistoryLoader({
  fetchData,
  source = 'eastmoney-daykline',
  loadPersisted = async () => null,
  savePersisted = async () => {},
  now = () => Date.now(),
  wait = delay => new Promise(resolve => setTimeout(resolve, delay)),
  freshMs = DEFAULT_FRESH_MS,
  fallbackMs = DEFAULT_FALLBACK_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  attempts = DEFAULT_ATTEMPTS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  onPersistenceError = () => {},
} = {}) {
  if (typeof fetchData !== 'function') throw new TypeError('fetchData is required');
  const cache = new Map();
  const pending = new Map();
  const hydrating = new Map();
  const acceptedSource = String(source);
  const attemptCount = Math.max(1, Math.floor(Number(attempts) || 1));

  function validRows(data) {
    return Array.isArray(data) && data.length && data.every(item => item?.date && Number.isFinite(Number(item.mainNet)));
  }

  function store(symbol, data, fetchedAt = now()) {
    cache.delete(symbol);
    cache.set(symbol, { data:data.map(item => ({ ...item })), fetchedAt });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return cache.get(symbol);
  }

  function result(item, { stale = false } = {}) {
    return {
      data:item.data.map(point => ({ ...point })),
      meta:{ source:acceptedSource, cached:true, stale, fetchedAt:item.fetchedAt },
    };
  }

  function hydrate(symbol) {
    if (hydrating.has(symbol)) return hydrating.get(symbol);
    const task = (async () => {
      try {
        const saved = await loadPersisted(symbol);
        if (saved?.source !== acceptedSource || !validRows(saved.data)) return null;
        const fetchedAt = new Date(saved.fetchedAt || 0).getTime();
        if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return null;
        return store(symbol, saved.data, fetchedAt);
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
          const data = await fetchData(symbol);
          if (!validRows(data)) throw new Error('Fund flow history is empty');
          const item = store(symbol, data);
          try {
            await savePersisted(symbol, { data:item.data, source:acceptedSource, fetchedAt:new Date(item.fetchedAt) });
          } catch (error) {
            onPersistenceError(error, symbol, 'save');
          }
          return { data:item.data.map(point => ({ ...point })), meta:{ source:acceptedSource, cached:false, stale:false, fetchedAt:item.fetchedAt } };
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
    let item = cache.get(symbol);
    if (!item) item = await hydrate(symbol);
    const age = item ? now() - item.fetchedAt : Infinity;
    if (item && age >= 0 && age < freshMs) return result(item);
    try {
      return await refresh(symbol);
    } catch (error) {
      if (item && age >= 0 && age <= fallbackMs) return result(item, { stale:true });
      throw error;
    }
  }

  return { load, cache, pending, hydrating };
}

module.exports = {
  createAsyncTaskQueue,
  createFundFlowHistoryLoader,
  parseFundFlowHistoryPayload,
  DEFAULT_FRESH_MS,
  DEFAULT_FALLBACK_MS,
};
