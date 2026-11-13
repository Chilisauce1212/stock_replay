#!/usr/bin/env node
'use strict';

// 可转债名单（2026-11-13 用户要求：每日复盘里「当时有可转债就只能空仓」）。
// 从东方财富数据中心 RPT_BOND_CB_LIST 取全部可转债（含已摘牌的），按正股代码整理成
//   { updatedAt, bonds: { 正股代码: [{ c: 转债代码, n: 转债简称, l: 上市日, d: 摘牌日（没摘牌为空） }] } }
// 写 reports/可转债.json；--upload 同时写 R2 convertible-bonds/可转债.json。复盘页按信号日判断：上市日 ≤ 信号日且（没摘牌或摘牌日 > 信号日）。
// 每次全量重取（约 1100 只、3 次请求），每日更新会跑。
//
// 用法: node convertible-bonds.js [--upload]
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');

const OUT_FILE = path.join(__dirname, 'reports', '可转债.json');
const R2_KEY = 'convertible-bonds/可转债.json';
const API = 'https://datacenter-web.eastmoney.com/api/data/v1/get';
const COLUMNS = 'SECURITY_CODE,SECURITY_NAME_ABBR,CONVERT_STOCK_CODE,LISTING_DATE,DELIST_DATE';

async function fetchPage(page) {
  const url = new URL(API);
  url.search = new URLSearchParams({ reportName: 'RPT_BOND_CB_LIST', columns: COLUMNS, pageSize: '500', pageNumber: String(page), sortColumns: 'PUBLIC_START_DATE', sortTypes: '-1' });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const payload = await response.json();
      if (!payload.success || !payload.result?.data) throw new Error(payload.message || `HTTP ${response.status}`);
      return payload.result;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function main() {
  const upload = process.argv.includes('--upload');
  const rows = [];
  for (let page = 1; ; page++) {
    const result = await fetchPage(page);
    rows.push(...result.data);
    if (page >= result.pages) break;
  }
  const day = value => (value ? String(value).slice(0, 10) : '');
  const bonds = {};
  for (const row of rows) {
    if (!row.CONVERT_STOCK_CODE || !row.LISTING_DATE) continue; // 还没上市的不算
    (bonds[row.CONVERT_STOCK_CODE] ||= []).push({ c: row.SECURITY_CODE, n: row.SECURITY_NAME_ABBR, l: day(row.LISTING_DATE), d: day(row.DELIST_DATE) });
  }
  for (const list of Object.values(bonds)) list.sort((left, right) => left.l.localeCompare(right.l));
  if (Object.keys(bonds).length < 300) throw new Error(`只取到 ${Object.keys(bonds).length} 只正股的可转债，不像全量，不写入`);
  const data = { updatedAt: new Date().toISOString(), bonds };
  fs.writeFileSync(OUT_FILE, `${JSON.stringify(data)}\n`, 'utf8');
  const listed = Object.values(bonds).flat();
  console.log(`可转债 ${listed.length} 只（未摘牌 ${listed.filter(item => !item.d).length} 只），正股 ${Object.keys(bonds).length} 只 → ${path.relative(__dirname, OUT_FILE)}`);
  if (upload) {
    const { writeJson } = require('./r2-storage');
    await writeJson(R2_KEY, data);
    console.log(`已更新 R2 ${R2_KEY}`);
  }
}

main().catch(error => {
  console.error(`获取可转债名单失败: ${error.message}`);
  process.exit(1);
});
