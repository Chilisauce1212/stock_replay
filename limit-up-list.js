'use strict';

// 全市场每日涨停名单和涨停原因：reports/全市场涨停原因.json，按月分组 { '2026-10': [{ date, code, name, reason, boards }] }。
// 2023-12 ~ 2026-10 的历史用问财按月区间问句加翻页获取（每月 1 次额度）；之后用同花顺涨停池接口逐日补齐
// （不用登录、不限次数，但只能查到大约一年内的日期）。stock-pick.js、yijiner-cases.js 共用。
const fs = require('fs');
const path = require('path');

const LIMIT_UP_FILE = path.join(__dirname, 'reports', '全市场涨停原因.json');
const POOL_URL = 'https://data.10jqka.com.cn/dataapi/limit_up/limit_up_pool';

function nextDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function previousDay(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

// 同花顺涨停池：查一个交易日的全部涨停股，非交易日返回空列表。
async function fetchPool(date) {
  const rows = [];
  for (let page = 1; page <= 20; page++) {
    const url = new URL(POOL_URL);
    url.search = new URLSearchParams({
      page: String(page), limit: '200', field: '199112,10,9001,330323,330324,330325,9002,330329,133971,133970,1968584,3475914,9003,9004',
      filter: 'HS,GEM2STAR', order_field: '330324', order_type: '0', date: date.replaceAll('-', ''),
    }).toString();
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.10jqka.com.cn/datacenterph/limitup/limtupInfo.html' },
      signal: AbortSignal.timeout(20_000),
    });
    const payload = await response.json();
    if (payload.status_code !== 0) throw new Error(`${date} 涨停池接口: ${payload.status_msg}`);
    for (const item of payload.data?.info || []) {
      rows.push({ date, code: String(item.code), name: String(item.name || ''), reason: String(item.reason_type || '').trim(), boards: String(item.high_days || '') });
    }
    if (page * 200 >= Number(payload.data?.page?.total || 0)) break;
  }
  return rows;
}

function readLimitUpMonths() {
  return fs.existsSync(LIMIT_UP_FILE) ? JSON.parse(fs.readFileSync(LIMIT_UP_FILE, 'utf8')) : {};
}

// 从已有数据的最后一天之后补到 endDate（YYYY-MM-DD，不晚于今天；北京时间 15:00 前不取当天），返回全部数据。
async function updateLimitUpList(endDate) {
  const months = readLimitUpMonths();
  const last = Object.values(months).flat().map(item => item.date).sort().at(-1);
  if (!last) throw new Error(`${path.relative(__dirname, LIMIT_UP_FILE)} 不存在或为空`);
  const now = new Date(Date.now() + 8 * 3600_000);
  const todayText = now.toISOString().slice(0, 10);
  const stop = endDate < todayText ? endDate : (now.getUTCHours() >= 15 ? todayText : previousDay(todayText));
  let added = 0;
  for (let day = nextDay(last); day <= stop; day = nextDay(day)) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    const rows = await fetchPool(day);
    if (!rows.length) continue; // 节假日
    const month = day.slice(0, 7);
    months[month] = (months[month] || []).filter(item => item.date !== day).concat(rows);
    added++;
    console.log(`涨停名单补到 ${day}：${rows.length} 只`);
  }
  if (added) {
    const temporary = `${LIMIT_UP_FILE}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(months)}\n`, 'utf8');
    fs.renameSync(temporary, LIMIT_UP_FILE);
  }
  return months;
}

// 某只股票某天是否收盘封死涨停（问财「涨停」为是、同花顺涨停池口径；收盘在涨停价但没封死的不算）。
// 先查本地全市场涨停名单；名单里没有的日期查涨停池接口（约一年内可查，Render 上没有本地名单时靠它）。
// 查不到（接口失败或日期太早）返回 null，由调用方决定怎么处理。
function createSealedChecker() {
  const known = new Map();
  for (const item of Object.values(readLimitUpMonths()).flat()) {
    if (!known.has(item.date)) known.set(item.date, new Set());
    known.get(item.date).add(item.code);
  }
  const pending = new Map();
  return async (code, date) => {
    if (!known.has(date)) {
      if (!pending.has(date)) {
        pending.set(date, fetchPool(date)
          .then(rows => { if (rows.length) known.set(date, new Set(rows.map(row => row.code))); })
          .catch(() => {})
          .finally(() => pending.delete(date)));
      }
      await pending.get(date);
      if (!known.has(date)) return null;
    }
    return known.get(date).has(String(code));
  };
}

module.exports = { LIMIT_UP_FILE, fetchPool, readLimitUpMonths, updateLimitUpList, createSealedChecker };
