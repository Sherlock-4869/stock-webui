'use strict';

const FLOW_PERIODS = {
  today: {
    label:'今日', sortField:'f62', main:'f62', mainRatio:'f184',
    superLarge:'f66', superLargeRatio:'f69', large:'f72', largeRatio:'f75',
    medium:'f78', mediumRatio:'f81', small:'f84', smallRatio:'f87',
  },
  '3d': {
    label:'3日', sortField:'f267', main:'f267', mainRatio:'f268',
    superLarge:'f269', superLargeRatio:'f270', large:'f271', largeRatio:'f272',
    medium:'f273', mediumRatio:'f274', small:'f275', smallRatio:'f276',
  },
  '5d': {
    label:'5日', sortField:'f164', main:'f164', mainRatio:'f165',
    superLarge:'f166', superLargeRatio:'f167', large:'f168', largeRatio:'f169',
    medium:'f170', mediumRatio:'f171', small:'f172', smallRatio:'f173',
  },
  '10d': {
    label:'10日', sortField:'f174', main:'f174', mainRatio:'f175',
    superLarge:'f176', superLargeRatio:'f177', large:'f178', largeRatio:'f179',
    medium:'f180', mediumRatio:'f181', small:'f182', smallRatio:'f183',
  },
};

const FLOW_RANKING_FIELDS = [...new Set([
  'f2','f3','f6','f8','f12','f13','f14','f20','f21','f100','f124',
  ...Object.values(FLOW_PERIODS).flatMap(period => [
    period.main, period.mainRatio, period.superLarge, period.superLargeRatio,
    period.large, period.largeRatio, period.medium, period.mediumRatio,
    period.small, period.smallRatio,
  ]),
])].join(',');

function flowRankingFields(period = 'today') {
  const definition = FLOW_PERIODS[period] || FLOW_PERIODS.today;
  return [...new Set([
    'f2','f3','f6','f8','f12','f13','f14','f20','f21','f100','f124',
    definition.main, definition.mainRatio, definition.superLarge, definition.superLargeRatio,
    definition.large, definition.largeRatio, definition.medium, definition.mediumRatio,
    definition.small, definition.smallRatio,
  ])].join(',');
}

function numberOrNull(value) {
  if (value === '' || value == null || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function flowValues(row, period = 'today') {
  const definition = FLOW_PERIODS[period] || FLOW_PERIODS.today;
  return {
    mainNet:numberOrNull(row?.[definition.main]),
    mainRatio:numberOrNull(row?.[definition.mainRatio]),
    superLargeNet:numberOrNull(row?.[definition.superLarge]),
    superLargeRatio:numberOrNull(row?.[definition.superLargeRatio]),
    largeNet:numberOrNull(row?.[definition.large]),
    largeRatio:numberOrNull(row?.[definition.largeRatio]),
    mediumNet:numberOrNull(row?.[definition.medium]),
    mediumRatio:numberOrNull(row?.[definition.mediumRatio]),
    smallNet:numberOrNull(row?.[definition.small]),
    smallRatio:numberOrNull(row?.[definition.smallRatio]),
  };
}

function normalizeFlowRankingRow(row, { period = 'today', scope = 'stock' } = {}) {
  const code = String(row?.f12 || '');
  const market = Number(row?.f13);
  const symbol = scope === 'stock' && /^\d{6}$/.test(code) && (market === 0 || market === 1)
    ? `${market === 1 ? 'sh' : 'sz'}${code}` : '';
  return {
    code,
    symbol,
    name:String(row?.f14 || ''),
    price:numberOrNull(row?.f2),
    pct:numberOrNull(row?.f3),
    amount:numberOrNull(row?.f6),
    turnover:numberOrNull(row?.f8),
    marketCap:numberOrNull(row?.f20),
    floatMarketCap:numberOrNull(row?.f21),
    industry:String(row?.f100 || ''),
    updatedAt:numberOrNull(row?.f124),
    ...flowValues(row, period),
  };
}

function parseIntradayFlowPayload(payload) {
  if (Number(payload?.rc) !== 0) throw new Error(`Fund flow upstream returned rc=${payload?.rc ?? 'unknown'}`);
  const data = (payload?.data?.klines || []).map(line => {
    const fields = String(line).split(',');
    return {
      time:fields[0], mainNet:numberOrNull(fields[1]), smallNet:numberOrNull(fields[2]),
      mediumNet:numberOrNull(fields[3]), largeNet:numberOrNull(fields[4]), superLargeNet:numberOrNull(fields[5]),
    };
  }).filter(item => item.time && Number.isFinite(item.mainNet));
  if (!data.length) throw new Error('Intraday fund flow is empty');
  return {
    code:String(payload.data?.code || ''),
    name:String(payload.data?.name || ''),
    tradePeriods:payload.data?.tradePeriods || null,
    data,
  };
}

function mergeFlowSeries(series, key) {
  const rows = new Map();
  for (const list of series) {
    for (const item of Array.isArray(list) ? list : []) {
      const pointKey = item?.[key];
      if (!pointKey) continue;
      const current = rows.get(pointKey) || { [key]:pointKey };
      for (const field of ['mainNet','smallNet','mediumNet','largeNet','superLargeNet']) {
        const value = numberOrNull(item[field]);
        if (value != null) current[field] = (current[field] || 0) + value;
      }
      rows.set(pointKey, current);
    }
  }
  return [...rows.values()].sort((left, right) => String(left[key]).localeCompare(String(right[key])));
}

function consecutiveFlowDays(rows) {
  const values = (Array.isArray(rows) ? rows : [])
    .filter(row => row?.date && Number.isFinite(Number(row.mainNet)))
    .sort((left, right) => String(left.date).localeCompare(String(right.date)));
  if (!values.length) return { direction:'flat', days:0, amount:0 };
  const latest = Number(values[values.length - 1].mainNet);
  const direction = latest > 0 ? 'in' : latest < 0 ? 'out' : 'flat';
  if (direction === 'flat') return { direction, days:0, amount:0 };
  let days = 0;
  let amount = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = Number(values[index].mainNet);
    if ((direction === 'in' && value <= 0) || (direction === 'out' && value >= 0)) break;
    days += 1;
    amount += value;
  }
  return { direction, days, amount };
}

module.exports = {
  FLOW_PERIODS,
  FLOW_RANKING_FIELDS,
  consecutiveFlowDays,
  flowRankingFields,
  flowValues,
  mergeFlowSeries,
  normalizeFlowRankingRow,
  parseIntradayFlowPayload,
};
