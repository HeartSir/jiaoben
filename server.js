/**
 * server.js - Render 部署入口（极简版，无需浏览器）
 *
 * 因为 Render 免费实例无法流畅运行 Playwright (0.1 CPU+冷启动),
 * 改为：本机跑 Playwright → 通过 HTTP 把 token 推过来 → Render 做中转调度
 *
 * 实际上：book.js 在本机通过 Windows 任务计划程序每天 8:28 执行。
 *
 * 这个服务只是用来做健康检查和触发远端通知。
 */

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    message: '本机通过 Windows 任务计划程序运行 book.js',
  });
});

app.get('/health', (req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏸 状态服务运行在端口 ${PORT}`);
  console.log(`⚠️ 实际抢场由本机 Task Scheduler 执行`);
});
