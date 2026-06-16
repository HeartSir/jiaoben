/**
 * server.js - Render 部署入口
 *
 * 提供 HTTP API：
 *   GET  /             状态
 *   GET  /health       健康检查
 *   POST /setup-auth   上传登录态
 *   POST /book         触发抢场
 *   GET  /auth-check   检查登录态
 */

const express = require('express');
const { main, BookingEngine } = require('./book.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

app.use(express.json({ limit: '1mb' }));

// 首页
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    hasAuth: fs.existsSync(AUTH_FILE),
  });
});

// 健康检查
app.get('/health', (req, res) => res.send('OK'));

// 上传登录态
app.post('/setup-auth', async (req, res) => {
  try {
    if (!req.body || !req.body.origins) {
      return res.json({ success: false, error: '格式错误，需要 origins 字段' });
    }
    fs.writeFileSync(AUTH_FILE, JSON.stringify(req.body, null, 2));
    console.log('✅ 登录态已保存');
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// 触发抢场
app.post('/book', async (req, res) => {
  console.log(`\n========== 🏸 触发抢场 ${new Date().toLocaleTimeString()} ==========`);

  if (!fs.existsSync(AUTH_FILE)) {
    return res.json({ success: false, error: '未配置登录态，请先 POST /setup-auth' });
  }

  // 捕获日志
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => { logs.push('[LOG] ' + args.join(' ')); origLog.apply(console, args); };
  console.error = (...args) => { logs.push('[ERR] ' + args.join(' ')); origErr.apply(console, args); };

  try {
    await main();
    res.json({ success: true, logs: logs.slice(-30) });
  } catch(e) {
    res.json({ success: false, error: e.message, logs: logs.slice(-30) });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

// 检查登录态
app.get('/auth-check', async (req, res) => {
  try {
    const engine = new BookingEngine();
    const ok = await engine.start();
    if (ok) {
      const token = await engine.getLiveToken();
      await engine.close();
      res.json({ loggedIn: true, tokenPrefix: token?.substring(0, 20) + '...' });
    } else {
      await engine.close();
      res.json({ loggedIn: false });
    }
  } catch(e) {
    res.json({ loggedIn: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏸 抢场服务器运行在端口 ${PORT}`);
  console.log(`📡 https://venue-booking-vvcw.onrender.com`);
  console.log(`⏰ 配置 cron-job.org 每天 8:28 POST /book`);
});
