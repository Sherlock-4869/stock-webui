'use strict';

// 新浪财经兜底数据源。
// 东方财富 push2 会对共享出口 IP 按响应体量限流（大响应直接断连），板块清单、
// 板块成分和资金排行因此经常不可用。新浪这套接口响应小且稳定，用来在东方财富
// 失败时兜底，字段统一转换成东方财富的形状，前端无需感知来源差异。

const SINA_BOARD_NODES = {
  industry:{ url:'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php', varName:'S_Finance_bankuai_sinaindustry' },
  concept:{ url:'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=class', varName:'S_Finance_bankuai_class' },
  region:{ url:'https://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=area', varName:'S_Finance_bankuai_area' },
};

// 实测：fenlei=1 为概念板块，fenlei=2 为行业板块，fenlei=3 返回的是指数成分而非板块。
const SINA_FLOW_CATEGORIES = { concept:'1', industry:'2' };

function sinaNodeList(text, varName) {
  const match = String(text || '').match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
  if (!match) throw new Error('Unexpected Sina board payload');
  const raw = JSON.parse(match[1]);
  return Object.values(raw).map(line => String(line || '').split(','));
}

// 新浪板块行格式：节点,名称,家数,均价,涨跌额,涨跌幅,成交量,成交额,领涨股,涨跌幅,价,涨跌额,领涨股名称
function normalizedSinaBoard(fields) {
  const [node, name, count, avgPrice, change, pct, volume, amount, leaderSymbol, leaderPct, , , leaderName] = fields;
  return {
    code:String(node || ''), name:String(name || ''),
    price:boardNumber(avgPrice), pct:boardNumber(pct), change:boardNumber(change),
    turnover:null, marketCap:null, mainNetInflow:null,
    upCount:null, downCount:null,
    total:boardNumber(count),
    leader:{ name:String(leaderName || ''), code:String(leaderSymbol || '').replace(/^(sh|sz)/, ''), symbol:/^s[hz]\d{6}$/.test(String(leaderSymbol)) ? String(leaderSymbol) : '', pct:boardNumber(leaderPct) },
    amount:boardNumber(amount), volume:boardNumber(volume),
  };
}

function boardNumber(value) {
  if (value == null || value === '' || value === '-') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sinaBoardList(text, varName, { type, label }) {
  const rows = sinaNodeList(text, varName).map(normalizedSinaBoard).filter(item => item.code && item.name);
  if (!rows.length) throw new Error('Empty Sina board list');
  return { type, label, data:rows, total:rows.length, source:'sina', truncated:false, fetchedAt:Date.now() };
}

// 新浪个股/成分行 -> 东方财富板块成分股形状
function normalizedSinaStock(row) {
  const symbol = String(row?.symbol || '');
  return {
    code:String(row?.code || ''), symbol, name:String(row?.name || ''),
    price:boardNumber(row?.trade), pct:boardNumber(row?.changepercent), change:boardNumber(row?.pricechange),
    volume:boardNumber(row?.volume), amount:boardNumber(row?.amount),
    turnover:boardNumber(row?.turnoverratio), marketCap:boardNumber(row?.mktcap),
    floatMarketCap:boardNumber(row?.nmc), pb:boardNumber(row?.pb),
    mainNetInflow:null, industry:'',
  };
}

function sinaBoardStocks(rows, { code }) {
  const stocks = (Array.isArray(rows) ? rows : []).map(normalizedSinaStock).filter(item => item.code && item.name);
  if (!stocks.length) throw new Error('Empty Sina board constituents');
  return { code, total:stocks.length, stocks, source:'sina', truncated:false, fetchedAt:Date.now() };
}

// 新浪板块资金行 -> 东方财富资金排行形状（金额单位：元）
function sinaFlowRanking(rows, { scope, type, market, period, direction }) {
  const data = (Array.isArray(rows) ? rows : []).map(row => ({
    code:String(row?.category || row?.symbol || ''),
    symbol:/^s[hz]\d{6}$/.test(String(row?.symbol || '')) ? String(row.symbol) : '',
    name:String(row?.name || ''),
    price:boardNumber(row?.avg_price ?? row?.trade),
    pct:boardNumber(row?.avg_changeratio ?? row?.changeratio) != null
      ? boardNumber(row?.avg_changeratio ?? row?.changeratio) * 100 : null,
    amount:boardNumber(row?.inamount), turnover:boardNumber(row?.turnover),
    marketCap:null, floatMarketCap:null, industry:'',
    mainNet:boardNumber(row?.netamount), mainNetInflow:boardNumber(row?.netamount),
    mainRatio:boardNumber(row?.ratioamount) != null ? boardNumber(row?.ratioamount) * 100 : null,
    superLargeNet:null, superLargeRatio:null, largeNet:null, largeRatio:null,
    mediumNet:null, mediumRatio:null, smallNet:null, smallRatio:null,
  })).filter(item => item.code && item.name);
  if (!data.length) throw new Error('Empty Sina flow ranking');
  const ordered = direction === 'out' ? data.slice().sort((left, right) => left.mainNet - right.mainNet) : data;
  return {
    scope, type:scope === 'board' ? type : undefined, market:scope === 'stock' ? market : undefined,
    period, direction, data:ordered, total:ordered.length, source:'sina', fetchedAt:Date.now(),
  };
}

module.exports = {
  SINA_BOARD_NODES,
  SINA_FLOW_CATEGORIES,
  sinaBoardList,
  sinaBoardStocks,
  sinaFlowRanking,
};