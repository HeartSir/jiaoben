/**
 * 🏸 dashboard.js - 抢场可视化控制面板服务器
 *
 * 启动：node dashboard.js
 * 访问：http://localhost:3456
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { main, loadConfig, saveConfig, setStatusCallback, getLogs, getResult } = require('./book.js');

const app = express();
const PORT = 3456;
const CONFIG_FILE = path.join(__dirname, 'config.json');

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
  const hasAuth = fs.existsSync(path.join(__dirname, '.venue-auth.json'));
  const wishes = (cfg?.wishes || []).filter(w => w.enabled !== false);
  res.json({
    hasAuth,
    wishes: wishes.length,
    fallback: cfg?.fallbackEnabled !== false,
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
    await main();
    const result = getResult();
    if (result) pushToRender(result);
  } catch(e) {
    console.error('抢场出错:', e.message);
  } finally {
    bookingRunning = false;
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

// ========== 启动 ==========
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🏸 抢场控制面板`);
  console.log(`  ───────────────────`);
  console.log(`  📍 http://localhost:${PORT}`);
  console.log(`  ⏰ 每天 8:30 自动抢场（面板管理，日志持久）`);
  console.log(`  🎯 按 Ctrl+C 停止\n`);

  // 启动调度器
  schedulerLoop();
});
