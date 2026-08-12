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

function parseSinaFundFlowHistoryPayload(rows) {
  // 新浪该接口的资金金额单位是万元；应用内资金图统一以元显示。
  const yuan = value => {
    const number = numberOrNull(value);
    return number == null ? null : number * 10000;
  };
  const data = (Array.isArray(rows) ? rows : []).map(row => {
    const superLargeNet = yuan(row?.r0_net);
    const largeNet = yuan(row?.r1_net);
    const mediumNet = yuan(row?.r2_net);
    const smallNet = yuan(row?.r3_net);
    const mainNet = Number.isFinite(superLargeNet) && Number.isFinite(largeNet)
      ? superLargeNet + largeNet
      : yuan(row?.netamount);
    const totalAmount = ['r0', 'r1', 'r2', 'r3']
      .map(key => numberOrNull(row?.[key]))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    const ratio = value => Number.isFinite(value) && totalAmount > 0 ? value / (totalAmount * 10000) * 100 : null;
    const changeRatio = numberOrNull(row?.changeratio);
    return {
      date:row?.opendate,
      mainNet,
      smallNet,
      mediumNet,
      largeNet,
      superLargeNet,
      mainRatio:ratio(mainNet),
      smallRatio:ratio(smallNet),
      mediumRatio:ratio(mediumNet),
      largeRatio:ratio(largeNet),
      superLargeRatio:ratio(superLargeNet),
      close:numberOrNull(row?.trade),
      pct:changeRatio == null ? null : changeRatio * 100,
    };
  }).filter(item => item.date && Number.isFinite(item.mainNet))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!data.length) throw new Error('Sina fund flow history is empty');
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
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return cache.get(symbol);
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

  function refresh(symbol) {
    if (pending.has(symbol)) return pending.get(symbol);
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
      throw lastError || new Error('Fund flow history is unavailable');
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
  mergeFundFlowHistory,
  parseFundFlowHistoryPayload,
  parseSinaFundFlowHistoryPayload,
  DEFAULT_FRESH_MS,
  DEFAULT_FALLBACK_MS,
};
