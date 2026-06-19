/**
 * 🏸 远程结果查看器 - 部署在 Render
 *
 * 你的本地抢场面板执行完毕后，会自动把结果推送到这里。
 * 你出门在外用手机访问这个 URL 就能看到抢没抢到。
 *
 * 部署：推送到 GitHub，Render 自动部署
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'booking-result.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 首页 - 显示最近一次抢场结果
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🏸 抢场结果</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background: #f0f2f5;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 20px;
  }
  .card {
    background: #fff;
    border-radius: 16px;
    padding: 40px;
    box-shadow: 0 4px 20px rgba(0,0,0,.1);
    text-align: center;
    max-width: 420px;
    width: 100%;
  }
  .icon { font-size: 64px; margin-bottom: 16px; }
  .title { font-size: 24px; font-weight: 700; margin-bottom: 8px; }
  .detail { font-size: 14px; color: #888; margin-bottom: 24px; line-height: 1.8; }
  .time { font-size: 12px; color: #aaa; }
  .loading { color: #e65100; }
  .success { color: #2e7d32; }
  .fail { color: #c62828; }
  .badge {
    display: inline-block; padding: 4px 16px; border-radius: 20px;
    font-size: 13px; font-weight: 600; margin-bottom: 16px;
  }
  .badge-success { background: #e8f5e9; color: #2e7d32; }
  .badge-fail { background: #fbe9e7; color: #c62828; }
  .badge-waiting { background: #fff3e0; color: #e65100; }
</style>
</head>
<body>
<div class="card">
  <div id="content">加载中...</div>
</div>
<script>
fetch('/api/result')
  .then(r => r.json())
  .then(d => {
    if (!d.hasResult) {
      document.getElementById('content').innerHTML = \`
        <div class="icon">⏳</div>
        <div class="title waiting">等待抢场结果</div>
        <div class="detail">今天 8:30 本地抢场完成后<br>结果会自动同步到这里</div>
        <div class="time">\${d.lastUpdate || ''}</div>
      \`;
      return;
    }
    const ok = d.success;
    document.getElementById('content').innerHTML = \`
      <div class="icon">\${ok ? '🎉' : '😢'}</div>
      <div class="badge \${ok ? 'badge-success' : 'badge-fail'}">\${ok ? '✅ 抢场成功' : '❌ 未抢到'}</div>
      <div class="title \${ok ? 'success' : 'fail'}">\${d.message || (ok ? '场地已锁定！' : '明天再来')}</div>
      <div class="detail">
        \${d.detail || ''}<br>
        <span style="font-size:12px;color:#aaa;">\${d.time || ''}</span>
      </div>
      <div class="time">\${d.lastUpdate ? '更新于 ' + d.lastUpdate : ''}</div>
    \`;
  });
</script>
</body>
</html>`);
});

// API - 获取结果
app.get('/api/result', (req, res) => {
  if (!fs.existsSync(DATA_FILE)) {
    return res.json({ hasResult: false, lastUpdate: '暂无数据' });
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  res.json({ hasResult: true, ...data });
});

// API - 接收结果推送（由你的本地面板调用）
app.post('/api/report', (req, res) => {
  const { success, message, detail } = req.body;
  const entry = {
    success,
    message: message || (success ? '🎉 抢场成功' : '😢 未抢到'),
    detail: detail || '',
    time: new Date().toLocaleString('zh-CN'),
    lastUpdate: new Date().toLocaleString('zh-CN'),
  };
  fs.writeFileSync(DATA_FILE, JSON.stringify(entry, null, 2));
  console.log('📥 收到抢场结果:', entry.message);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.send('OK'));

// ========== Console 自动抓取中转 ==========
// 学校网页 HTTPS → Render HTTPS（正规证书）→ 阿里云 HTTP（无混合内容限制）
const RELAY_TARGET = 'http://8.137.123.69:3456';

app.post('/api/auto-token-relay', (req, res) => {
  const http = require('http');
  const qs = require('querystring');
  const postData = qs.stringify(req.body || {});

  const opts = {
    hostname: '8.137.123.69', port: 3456, path: '/api/auto-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    timeout: 10000,
  };

  const proxyReq = http.request(opts, (proxyRes) => {
    let data = '';
    proxyRes.on('data', (c) => data += c);
    proxyRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({ ok: false, error: '中转解析失败' }); }
    });
  });
  proxyReq.on('error', (e) => res.json({ ok: false, error: '中转连接失败: ' + e.message }));
  proxyReq.on('timeout', () => { proxyReq.destroy(); res.json({ ok: false, error: '中转超时' }); });
  proxyReq.write(postData);
  proxyReq.end();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏸 远程结果查看器运行在端口 ${PORT}`);
  console.log(`📡 等待本地面板推送结果...`);
});
