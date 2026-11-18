#!/usr/bin/env node
'use strict';

// 问财登录（只能在有界面的电脑上跑）：打开普通 Chrome（专用配置目录，调试端口默认 9223，不碰 9222），
// 停在问财页面，你登录后自动把登录状态（cookie）导出到 reports/wencai-state.json。
// 已经是登录状态就直接导出。服务器上的 headless 查询（first-board-reason.js / free-float.js）读这个文件；
// 导出后把它拷到服务器的同一路径（或服务器上用 WENCAI_STATE_FILE 指定）。文件里是登录凭证，不要提交、不要外传。
// 登录约 3 个月过期，查询时剩 14 天起会打 !!! 提醒，届时重跑本脚本。
//
// 用法: npm run wencai-login
for (const name of ['NO_PROXY', 'no_proxy']) {
  process.env[name] = [process.env[name], '127.0.0.1', 'localhost'].filter(Boolean).join(',');
}
process.env.WENCAI_DEBUG_PORT = process.env.WENCAI_DEBUG_PORT || '9223';
if (process.env.WENCAI_DEBUG_PORT === '9222') throw new Error('9222 是别的程序在用的 Chrome，换一个端口');

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { DEBUG_URL, STATE_FILE, loginExpiry, ensureChrome } = require('./first-board-reason');

const HOME = 'https://www.iwencai.com/unifiedwap/home/index';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function main() {
  await ensureChrome();
  const browser = await chromium.connectOverCDP(DEBUG_URL, { timeout: 30000 });
  const context = browser.contexts()[0];
  try {
    let state = await context.storageState();
    if (!(loginExpiry(state) > Date.now())) {
      const page = await context.newPage();
      await page.goto(HOME, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.bringToFront().catch(() => {});
      console.log(`请在打开的 Chrome 窗口里登录问财（${HOME}，点左下角「登录」），最多等 10 分钟…`);
      const deadline = Date.now() + 10 * 60e3;
      while (!(loginExpiry(state) > Date.now())) {
        if (Date.now() > deadline) throw new Error('10 分钟内没有检测到登录');
        await sleep(2000);
        state = await context.storageState();
      }
    }
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
    const expiry = loginExpiry(state);
    const expiryText = Number.isFinite(expiry) ? new Date(expiry + 8 * 3600e3).toISOString().slice(0, 10) : '会话结束';
    console.log(`已导出登录状态 → ${STATE_FILE}（登录有效期到 ${expiryText}）`);
    console.log('部署到服务器：把这个文件拷到服务器项目的 reports/ 下（scp 等），不要提交到 git');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(error => {
  console.error(`问财登录失败: ${error.message}`);
  process.exit(1);
});
