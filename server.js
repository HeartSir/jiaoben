/**
 * server.js - Render 部署入口
 *
 * 提供 HTTP API：
 *   GET  /          状态
 *   GET  /health    健康检查
 *   POST /setup-auth   上传登录态
 *   POST /book      触发抢场
 *   GET  /auth-check   检查登录态
 *
 * 配合外部 cron (cron-job.org) 每天 8:28 触发
 */

const express = require('express');
const { main, BookingEngine } = require('./book.js');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

// JSON body parser
app.use(express.json({ limit: '1mb' }));

// 日志捕获辅助
function captureLogs(fn) {
  return async (req, res) => {
    let logs = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => { logs.push('[LOG] ' + args.join(' ')); origLog.apply(console, args); };
    console.error = (...args) => { logs.push('[ERR] ' + args.join(' ')); origErr.apply(console, args); };
    try {
      const result = await fn(req, res, logs);
      if (!res.headersSent) res.json(result);
    } catch(e) {
      if (!res.headersSent) res.json({ success: false, error: e.message, logs: logs.slice(-30) });
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  };
}

// 首页
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    hasAuth: fs.existsSync(AUTH_FILE),
    endpoints: ['GET /', 'GET /health', 'POST /setup-auth', 'POST /book', 'GET /auth-check'],
  });
});

// 健康检查
app.get('/health', (req, res) => res.send('OK'));

// 📤 上传登录态（首次部署后执行一次）
app.post('/setup-auth', captureLogs(async (req, res) => {
  const authData = req.body;
  if (!authData || !authData.origins) {
    return { success: false, error: '无效的登录态格式，需要包含 origins 字段' };
  }

  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
  console.log('✅ 登录态已保存到服务器');

  // 验证 token 是否有效
  try {
    const engine = new BookingEngine();
    const ok = await engine.start();
    if (ok) {
      const token = await engine.getLiveToken();
      console.log(`🔑 Token 有效: ${token?.substring(0,20)}...`);
      await engine.close();
      return { success: true, tokenValid: true, tokenPrefix: token?.substring(0,20) };
    } else {
      await engine.close();
      return { success: true, tokenValid: false, warning: '引擎启动失败，可能需要重新登录' };
    }
  } catch(e) {
    return { success: true, tokenValid: false, error: e.message };
  }
}));

// 🏸 手动触发抢场
app.post('/book', captureLogs(async (req, res) => {
  console.log(`\n========== 🏸 触发抢场 ${new Date().toLocaleTimeString()} ==========`);

  if (!fs.existsSync(AUTH_FILE)) {
    return { success: false, error: '未配置登录态，请先 POST /setup-auth', logs: logs.slice(-10) };
  }

  await main();
  return { success: true, message: '抢场执行完成', logs: logs.slice(-30) };
}));

// 检查登录态
app.get('/auth-check', captureLogs(async (req, res) => {
  const engine = new BookingEngine();
  const ok = await engine.start();
  if (ok) {
    const token = await engine.getLiveToken();
    await engine.close();
    return { loggedIn: true, tokenPrefix: token?.substring(0, 20) + '...' };
  } else {
    await engine.close();
    return { loggedIn: false };
  }
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏸 抢场服务器运行在端口 ${PORT}`);
  console.log(`📡 URL: https://venue-booking-vvcw.onrender.com`);
  console.log('');
  console.log(`📋 首次部署后执行：`);
  console.log(`   curl -X POST https://venue-booking-vvcw.onrender.com/setup-auth \\`);
  console.log(`     -H \"Content-Type: application/json\" \\`);
  console.log(`     -d @.venue-auth.json`);
  console.log('');
  console.log(`⏰ 在 cron-job.org 设置每天 8:28 触发 POST /book`);
});
