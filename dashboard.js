/**
 * 🏸 dashboard.js - 抢场可视化控制面板服务器
 *
 * 服务器部署：
 *   1. node setup.js          # 首次：下载 Chromium
 *   2. node dashboard.js      # 启动服务
 *
 * 访问：http://localhost:3456
 *       http://<你的IP>:3456  （局域网/公网）
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const os = require('os');

// ⚠️ 全局错误处理：防止未捕获异常导致进程退出
process.on('unhandledRejection', (reason) => {
  console.error(`[FATAL] 未捕获的 Promise 拒绝: ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  console.error(`[FATAL] 未捕获的异常: ${err.message}`);
});
const { main, loadConfig, saveConfig, setStatusCallback, getLogs, getResult, scanAvailableSlots, quickBookSlot, stopEngine } = require('./book.js');

const app = express();
const PORT = parseInt(process.env.PORT || '3456', 10);

// 📌 路径模式
const BASE_DIR = (process.pkg ? path.dirname(process.execPath) : __dirname);

// 📌 持久数据目录
// Render 免费版不支持磁盘挂载，用 /tmp/venue-data（重启丢失）
// Render 付费版/Windows 开发环境用 BASE_DIR
const DATA_DIR = process.env.RENDER_DATA_DIR || (process.platform === 'linux' ? '/tmp/venue-data' : BASE_DIR);
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_FILE = path.join(DATA_DIR, '.venue-auth.json');

// 跟踪真实登录态：null=未知, true=有效, false=过期
let _authValid = null;

// 检测 token 是否有效（解码 JWT 看过期时间）
function checkTokenValid() {
  if (!fs.existsSync(AUTH_FILE)) return false;
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    for (const originUrl of ['https://cgzx.scu.edu.cn', 'http://cgzx.scu.edu.cn']) {
      const o = auth.origins?.find(x => x.origin === originUrl);
      const token = o?.localStorage?.find(l => l.name === 'accessToken')?.value;
      if (!token) continue;
      // JWT: header.payload.signature
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        if (payload.exp) {
          return payload.exp * 1000 > Date.now();
        }
      }
      return true; // 非空且不是 JWT 格式也算有效
    }
  } catch(e) {}
  return false;
}

function refreshAuthState() {
  _authValid = checkTokenValid();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== API ==========

// 获取配置
app.get('/api/config', (req, res) => {
  const cfg = loadConfig();
  if (cfg) return res.json({ success: true, config: cfg });
  res.json({ success: false, error: '未找到配置' });
});

// 保存配置
app.post('/api/config', (req, res) => {
  try {
    saveConfig(req.body);
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// 获取日志
app.get('/api/logs', (req, res) => {
  res.json({ logs: getLogs() });
});

// 获取状态摘要
app.get('/api/status', (req, res) => {
  const cfg = loadConfig();
  refreshAuthState();
  const wishes = (cfg?.wishes || []).filter(w => w.enabled !== false);
  res.json({
    hasAuth: _authValid === true,
    wishes: wishes.length,
    fallback: cfg?.fallbackEnabled !== false,
    loginInProgress,
    targetTime: `${String(cfg?.targetHour ?? 8).padStart(2,'0')}:${String(cfg?.targetMinute ?? 30).padStart(2,'0')}`,
    logs: getLogs().slice(-5),
  });
});

// ========== SSE 实时推送 ==========
const sseClients = [];

setStatusCallback((entry) => {
  sseClients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch(e) {}
  });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 发送已有日志
  getLogs().forEach(entry => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// ========== 扫码登录 ==========
let loginInProgress = false;

function loginLog(msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { time, msg, ts: Date.now() };
  console.log(`[${time}] ${msg}`);
  sseClients.forEach(res => {
    try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch(e) {}
  });
}

// POST /api/login - 弹出可见浏览器窗口扫码登录
app.post('/api/login', async (req, res) => {
  if (loginInProgress) return res.json({ success: false, error: '登录已在运行中' });
  loginInProgress = true;
  res.json({ success: true, message: '正在打开浏览器...' });
  doLogin().finally(() => { loginInProgress = false; });
});

async function doLogin() {
  let browser = null;
  try {
    // 检测无头服务器环境（Linux 上无 DISPLAY）
    if (process.platform === 'linux' && !process.env.DISPLAY) {
      loginLog('❌ 当前服务器没有桌面环境，无法打开浏览器扫码');
      loginLog('💡 请使用「粘贴 Token」功能手动设置登录态');
      return;
    }

    loginLog('🚀 打开浏览器进行扫码登录...');
    loginLog('📡 打开 https://cgzx.scu.edu.cn/venue/ ...');

    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: false,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage();

    await page.goto('https://cgzx.scu.edu.cn/venue/', {
      waitUntil: 'domcontentloaded', timeout: 30000
    }).catch(() => loginLog('⚠️ 页面加载超时（可能是校外访问限制）'));

    loginLog('🔑 请在弹出的浏览器窗口中扫码登录（川大统一身份认证）');
    loginLog('⏳ 等待扫码...（5分钟超时）');

    // 等待 token，最多 5 分钟
    let token = '';
    const startTime = Date.now();
    while (!token) {
      if (Date.now() - startTime > 300000) {
        loginLog('❌ 登录超时（5分钟），请重试');
        if (browser) await browser.close();
        return;
      }
      await new Promise(r => setTimeout(r, 2000));
      token = await page.evaluate(() => {
        try { return uni.getStorageSync('accessToken') || ''; }
        catch(e) { return ''; }
      }).catch(() => '');
    }

    // 获取完整的存储数据
    const storage = await page.evaluate(() => {
      try {
        return {
          accessToken: uni.getStorageSync('accessToken'),
          refreshToken: uni.getStorageSync('refreshToken'),
          userInfo: uni.getStorageSync('userInfo'),
        };
      } catch(e) { return {}; }
    });

    // 保存到 auth 文件
    const authData = {
      cookies: [],
      origins: [
        {
          origin: 'https://cgzx.scu.edu.cn',
          localStorage: [
            { name: 'accessToken', value: storage.accessToken },
            { name: 'refreshToken', value: storage.refreshToken || '' },
            { name: 'userInfo', value: typeof storage.userInfo === 'object' ? JSON.stringify(storage.userInfo) : (storage.userInfo || '') },
          ]
        },
        {
          origin: 'http://cgzx.scu.edu.cn',
          localStorage: [
            { name: 'accessToken', value: storage.accessToken },
            { name: 'refreshToken', value: storage.refreshToken || '' },
            { name: 'userInfo', value: typeof storage.userInfo === 'object' ? JSON.stringify(storage.userInfo) : (storage.userInfo || '') },
          ]
        }
      ]
    };

    try { fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true }); } catch(e) {}
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
    loginLog(`✅ 登录成功！Token: ${storage.accessToken?.substring(0, 20)}...`);
    loginLog('💾 登录态已保存');
    _authValid = true;

    // 通知前端刷新状态
    sseClients.forEach(res => {
      try { res.write(`data: ${JSON.stringify({ time: '', msg: '__LOGIN_SUCCESS__', type: 'login-success' })}\n\n`); } catch(e) {}
    });

    if (browser) await browser.close();
  } catch (e) {
    loginLog(`❌ 登录出错: ${e.message}`);
    if (browser) try { await browser.close(); } catch(_) {}
  }
}

// ========== 推送结果到 Render ==========
const RENDER_URL = 'https://venue-booking-vvcw.onrender.com/api/report';

function pushToRender(result) {
  return new Promise((resolve) => {
    const data = JSON.stringify({
      success: result.success || false,
      message: result.success ? '🎉 成功抢到场地！' : (result.error || '😢 未抢到'),
      detail: result.detail || '',
    });
    const url = new URL(RENDER_URL);
    const req = https.request({
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => { resolve(); });
    req.on('error', () => { resolve(); }); // 推失败不影响主流程
    req.write(data);
    req.end();
  });
}

// ========== 触发抢场 ==========
let bookingRunning = false;

app.post('/api/book', async (req, res) => {
  if (bookingRunning) return res.json({ success: false, error: '抢场正在运行中' });
  bookingRunning = true;
  res.json({ success: true, message: '抢场已触发' });

  try {
    // testNow=true → 跳过等待时间，立即执行
    await main({ skipWait: req.body?.testNow === true });
    const result = getResult();
    if (result) pushToRender(result);
  } catch(e) {
    console.error('抢场出错:', e.message);
  } finally {
    bookingRunning = false;
  }
});

// ========== 扫描可用时段 ==========
app.get('/api/scan', async (req, res) => {
  console.log('[API] 扫描可用时段');
  try {
    const result = await scanAvailableSlots();
    // 把最新日志推送给 SSE 面板
    getLogs().slice(-3).forEach(e => {
      sseClients.forEach(c => { try { c.write(`data: ${JSON.stringify(e)}\n\n`); } catch(_) {} });
    });
    res.json(result);
  } catch(e) {
    console.error('扫描失败:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ========== 获取场馆场地列表 ==========
app.get('/api/fields', async (req, res) => {
  const { discoverVenueFields, getFieldsForVenue } = require('./book.js');
  const cfg = loadConfig();
  const venueId = cfg?.venueId || 1;
  console.log(`[API] 获取场馆 #${venueId} 场地列表`);
  try {
    const fields = await discoverVenueFields(venueId);
    res.json({ success: fields.length > 0, fields, venueId });
  } catch(e) {
    console.error('获取场地失败:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ========== 一键预约 ==========
app.post('/api/book-now', async (req, res) => {
  const { fieldId, fieldName, startTime, endTime } = req.body;
  if (!fieldId || !startTime) return res.json({ success: false, error: '缺少参数' });
  console.log(`[API] 一键预约 ${fieldName} ${startTime}`);
  try {
    const result = await quickBookSlot(fieldId, fieldName || '场地', startTime, endTime);
    res.json(result);
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== 定时调度 ==========
async function schedulerLoop() {
  while (true) {
    try {
      const cfg = loadConfig();
      if (!cfg) { await sleep(10000); continue; }

      const now = new Date();
      const target = new Date();
      target.setHours(cfg.targetHour ?? 8, cfg.targetMinute ?? 30, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);

      const preWakeMs = cfg.preWakeMs ?? 120000;
      const wakeTime = target.getTime() - preWakeMs;

      if (now.getTime() < wakeTime) {
        // 还没到预启动时间，睡一会儿再检查
        await sleep(Math.min(30000, wakeTime - now.getTime()));
        continue;
      }

      // 预启动时间到了，如果还没在跑就触发
      if (!bookingRunning) {
        console.log('⏰ 调度器触发自动抢场');
        bookingRunning = true;
        try {
          await main();
          const result = getResult();
          if (result) pushToRender(result);
        } catch(e) {
          console.error('❌ 自动抢场失败:', e.message);
        } finally {
          bookingRunning = false;
        }
      }

      // 抢完了，睡到明天再检查
      const tomorrow = new Date(target.getTime() + 86400000);
      const tillTomorrow = Math.min(3600000, tomorrow - Date.now());
      await sleep(tillTomorrow);

    } catch(e) {
      console.error('调度器错误:', e.message);
      await sleep(30000);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ========== 可选密码保护 ==========
const AUTH_PASSWORD = process.env.DASHBOARD_PASSWORD || (() => {
  // 同时尝试持久存储和部署包内置的 config.json
  for (const f of [CONFIG_FILE, path.join(BASE_DIR, 'config.json')]) {
    try {
      const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (cfg.serverPassword) return cfg.serverPassword;
    } catch(e) {}
  }
  return '';
})();

if (AUTH_PASSWORD) {
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-auth-token'];
    if (token === AUTH_PASSWORD) return next();
    // 允许 /api/config 读取 + /api/status + /api/stream 不做鉴权（前端需要）
    if (req.path === '/config' && req.method === 'GET') return next();
    if (req.path === '/status') return next();
    if (req.path === '/stream') return next();
    res.status(401).json({ success: false, error: '需要密码验证' });
  });
  console.log(`  🔒 面板密码保护已启用（config.json 中 serverPassword 字段）`);
}

// ========== 粘贴 Token（服务器无头环境登录） ==========
app.post('/api/set-token', async (req, res) => {
  const { token, refreshToken } = req.body;
  if (!token) return res.json({ success: false, error: '缺少 token' });
  try {
    const authData = {
      cookies: [],
      origins: [
        { origin: 'https://cgzx.scu.edu.cn', localStorage: [
          { name: 'accessToken', value: token },
          { name: 'refreshToken', value: refreshToken || '' },
        ]},
        { origin: 'http://cgzx.scu.edu.cn', localStorage: [
          { name: 'accessToken', value: token },
          { name: 'refreshToken', value: refreshToken || '' },
        ]},
      ],
    };
    try { fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true }); } catch(e) {}
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
    refreshAuthState();
    console.log('[API] Token 已通过面板设置');
    res.json({ success: true, message: 'Token 已保存' });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== 关闭引擎 ==========
app.post('/api/stop-engine', async (req, res) => {
  try {
    await stopEngine();
    res.json({ success: true });
  } catch(e) {
    res.json({ success: false, error: e.message });
  }
});

// ========== 健康检查 & 防休眠 ==========
app.get('/health', (req, res) => res.send('OK'));

function startSelfWakeup(myPort) {
  setInterval(() => {
    http.get(`http://localhost:${myPort}/health`, r => r.resume()).on('error', () => {});
  }, 4 * 60 * 1000);
}

// ========== 启动 ==========
async function warmupPanelEngine() {
  if (process.platform === 'linux') {
    console.log('  ⚡ Linux 环境：使用直接 API 模式（跳过 Chromium）');
    return;
  }
  // 后台预启动面板引擎，让扫码/扫描功能开箱即用
  try {
    const { ensurePanelEngine } = require('./book.js');
    console.log('  ⚡ 后台预热面板引擎...');
    const ok = await ensurePanelEngine();
    console.log(`  ${ok ? '✅' : '❌'} 面板引擎${ok ? '就绪' : '启动失败（需扫码）'}`);
  } catch(e) {
    // 预启动失败不影响主功能
  }
}

app.listen(PORT, '0.0.0.0', () => {
  refreshAuthState();

  // 获取本机局域网 IP
  let lanIP = '未知';
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          lanIP = iface.address;
          break;
        }
      }
    }
  } catch(e) {}

  try {
    const cfg = loadConfig();
    const th = String(cfg?.targetHour ?? 8).padStart(2, '0');
    const tm = String(cfg?.targetMinute ?? 30).padStart(2, '0');

    console.log(`\n  🏸 川大场馆抢订系统 — 控制面板`);
    console.log(`  ═══════════════════════════════`);
    console.log(`  📍 本机:   http://localhost:${PORT}`);
    console.log(`  📡 网络:   http://${lanIP}:${PORT}`);
    console.log(`  ⏰ 抢场:   每天 ${th}:${tm} 自动执行`);
    console.log(`  🎯 登录态: ${_authValid ? '✅ 有效' : '❌ 已过期'}`);
    if (process.platform === 'linux') console.log(`  ⚡ 模式:   直接 API（跳过 Chromium）`);
    console.log(`  ───────────────────────────────`);
    console.log(`  💡 手机访问: 同一网络下打开 http://${lanIP}:${PORT}`);
    console.log(`  💡 全球访问: 需要公网 IP 或 frp/ngrok 隧道`);
    if (!process.pkg) console.log(`  💡 按 Ctrl+C 停止\n`);
  } catch(e) {
    console.log(`\n  🏸 川大场馆抢订系统 — 控制面板`);
    console.log(`  📍 http://localhost:${PORT}\n`);
  }

  // 启动调度器
  schedulerLoop();

  // 后台预热面板引擎（扫码/扫描功能开箱即用）
  setTimeout(warmupPanelEngine, 1000);

  // 自我唤醒（防止 Render 免费版休眠）
  startSelfWakeup(PORT);
});
