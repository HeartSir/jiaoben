/**
 * server.js - Render 部署入口
 *
 * 提供 HTTP API 触发抢场，配合外部 cron 使用
 * 同时可选定时自执行（8:28 AM）
 */

const express = require('express');
const { main, BookingEngine } = require('./book.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 健康检查 - Render 需要
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    nextBook: '每天 8:28 自动执行',
  });
});

// 手动触发抢场
app.post('/book', async (req, res) => {
  console.log(`\n========== 🏸 手动触发抢场 ${new Date().toLocaleTimeString()} ==========`);

  // 捕获所有日志输出到 response
  let logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
    origLog.apply(console, args);
  };

  try {
    await main();
    res.json({ success: true, logs: logs.slice(-20) });
  } catch(e) {
    res.json({ success: false, error: e.message, logs: logs.slice(-20) });
  } finally {
    console.log = origLog;
  }
});

// 健康检查端点
app.get('/health', (req, res) => res.send('OK'));

// 检查登录态
app.get('/auth-check', async (req, res) => {
  try {
    const engine = new BookingEngine();
    const ok = await engine.start();
    if (ok) {
      const token = await engine.getLiveToken();
      res.json({ loggedIn: true, tokenPrefix: token.substring(0, 10) + '...' });
    } else {
      res.json({ loggedIn: false });
    }
    await engine.close();
  } catch(e) {
    res.json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏸 抢场服务器运行在端口 ${PORT}`);
  console.log(`📅 下次执行: 每天 8:28 (北京时间)`);

  // 定时执行 - 每天8:28
  const checkTime = () => {
    const now = new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const s = now.getSeconds();

    if (h === 8 && m === 28 && s === 0) {
      console.log('⏰ 定时触发: 开始抢场!');
      main().catch(e => console.error('抢场失败:', e.message));
    }
  };

  // 每分钟检查一次
  setInterval(checkTime, 1000);
  console.log('⏰ 定时器已启动 (每秒检查)');
});
