require('dotenv').config();

const axios = require('axios');

const renderUrl = (process.env.RENDER_URL || 'https://stock-replay.onrender.com').replace(/\/$/, '');
const intervalMs = Number(process.env.RENDER_KEEPALIVE_INTERVAL_MS || 10 * 60 * 1000);

if (!Number.isFinite(intervalMs) || intervalMs < 10_000) {
  throw new Error('RENDER_KEEPALIVE_INTERVAL_MS 必须是不小于 10000 的毫秒数');
}

let requestInProgress = false;

async function pingRender() {
  if (requestInProgress) return;
  requestInProgress = true;
  const startedAt = Date.now();
  try {
    const response = await axios.get(`${renderUrl}/?keepalive=${Date.now()}`, {
      timeout: 60_000,
      validateStatus: () => true,
    });
    console.log(`[${new Date().toISOString()}] Render 响应 ${response.status}，耗时 ${Date.now() - startedAt}ms`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Render 请求失败: ${error.message}`);
  } finally {
    requestInProgress = false;
  }
}

console.log(`Render 保活已启动: ${renderUrl}`);
console.log(`请求间隔: ${Math.round(intervalMs / 1000)} 秒，按 Ctrl+C 停止`);
pingRender();
const timer = setInterval(pingRender, intervalMs);

globalThis.process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('\nRender 保活已停止');
  process.exit(0);
});
