// daily-review 盈亏计算：按逐笔成交（通达信）模拟涨停买入后的卖出点。
const { Worker, healthyHosts } = require('./tdx_tick');

const TICK_CACHE_LIMIT = 60;
const MAX_STREAK_DAYS = 15;
const tickCache = new Map();

// 只连接探测可用的通达信服务器，并复用同一个连接（盈亏任务由服务端串行执行）
let sharedWorkerPromise = null;
async function getWorker() {
  if (!sharedWorkerPromise) {
    sharedWorkerPromise = healthyHosts()
      .then(hosts => new Worker(hosts, 0, 0.05))
      .catch(error => {
        sharedWorkerPromise = null;
        throw error;
      });
  }
  return sharedWorkerPromise;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const TOL = 0.005;

function limitRatio(code, name = '') {
  if (/ST/i.test(name)) return 0.05;
  if (/^(300|301|688)/.test(code)) return 0.2;
  if (/^[489]/.test(code)) return 0.3;
  return 0.1;
}

async function fetchTrades(code, date, worker) {
  const key = `${code}|${date}`;
  if (tickCache.has(key)) return tickCache.get(key);
  const rows = await (worker || await getWorker()).run(code, parseInt(date.replace(/-/g, ''), 10));
  if (!rows.length) throw new Error(`${date} 没有逐笔成交数据`);
  const csvRows = rows.map(r => ({ date, ...r }));
  if (tickCache.size >= TICK_CACHE_LIMIT) tickCache.delete(tickCache.keys().next().value);
  tickCache.set(key, csvRows);
  return csvRows;
}

// 只保留真实成交（集合竞价撮合的 09:25 成交量 > 0 也在内）
async function loadDay(code, date, worker) {
  const rows = await fetchTrades(code, date, worker);
  const trades = rows.filter(r => r.vol > 0 && r.time <= '15:00');
  if (!trades.length) throw new Error(`${date} 没有有效成交`);
  const auction = trades.find(r => r.time === '09:25');
  const amount = trades.reduce((sum, r) => sum + r.price * r.vol, 0);
  return {
    date,
    trades,
    open: (auction || trades[0]).price,
    close: trades[trades.length - 1].price,
    amount,
  };
}

function halfAmountTrade(day) {
  let acc = 0;
  for (const t of day.trades) {
    acc += t.price * t.vol;
    if (acc >= day.amount / 2) return t;
  }
  return day.trades[day.trades.length - 1];
}

/**
 * 以信号日涨停价为成本计算卖出点。
 * tradingDates: 升序交易日列表，需包含信号日及其前一日。
 */
async function calcReviewPnl({ code, name, date, tradingDates, worker }) {
  // date 为首板日，买入发生在其后一个交易日，成本为该日涨停价
  const signalIdx = tradingDates.indexOf(date);
  if (signalIdx < 0) throw new Error('找不到首板日');
  const idx = signalIdx + 1;
  if (idx + 1 >= tradingDates.length) throw new Error('没有后续交易日');
  const buyDate = tradingDates[idx];

  const ratio = limitRatio(code, name);
  const limitOf = (prevClose) => round2(prevClose * (1 + ratio));
  const days = {};
  const getDay = async (d) => (days[d] = days[d] || await loadDay(code, d, worker));

  const prev = await getDay(tradingDates[idx - 1]);
  const signal = await getDay(buyDate);
  const cost = limitOf(prev.close);
  const signalLimitUp = signal.close >= cost - TOL;

  let sell;
  let nextDate = tradingDates[idx + 1];
  let next = await getDay(nextDate);

  if (!signalLimitUp) {
    sell = { date: nextDate, tick: next.trades.find(t => t.time === '09:25') || next.trades[0], price: next.open, reason: '当天未收涨停，次日集合竞价价卖出' };
  } else if (next.open < cost - TOL) {
    const hit = next.trades.find(t => t.price >= cost - TOL);
    sell = hit
      ? { date: nextDate, tick: hit, price: cost, reason: '次日低开后回到成本线，按成本卖出' }
      : { date: nextDate, tick: next.trades[next.trades.length - 1], price: next.close, reason: '次日低开未回成本线，按收盘价卖出' };
  } else {
    let prevClose = signal.close;
    for (let k = idx + 1; k < tradingDates.length && k <= idx + MAX_STREAK_DAYS; k++) {
      const day = await getDay(tradingDates[k]);
      const closedLimitUp = day.close >= limitOf(prevClose) - TOL;
      if (!closedLimitUp) {
        if (k === idx + 1) {
          const half = halfAmountTrade(day);
          sell = { date: day.date, tick: half, price: half.price, reason: '次日高开且未收涨停，按成交额过半时的价格卖出' };
        } else {
          sell = { date: day.date, tick: day.trades[day.trades.length - 1], price: day.close, reason: '连板后断板，按断板日收盘价卖出' };
        }
        break;
      }
      prevClose = day.close;
      sell = { date: day.date, tick: day.trades[day.trades.length - 1], price: day.close, reason: '截至最新数据仍未断板，按最新收盘价计' };
    }
  }

  const pnlPct = round2((sell.price - cost) / cost * 100);
  return {
    buyDate,
    buyPrice: cost,
    sell,
    pnlPct,
    days: Object.values(days)
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ date: d.date, open: d.open, close: d.close, amount: Math.round(d.amount * 100) })),
  };
}

// 盈亏规则变更时递增，已缓存且版本不同的结果会被视为过期并重算
const RULES_VERSION = 1;

module.exports = { calcReviewPnl, RULES_VERSION };
