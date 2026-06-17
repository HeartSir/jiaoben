/**
 * 连接到正在运行的 Edge 浏览器
 * 这样可以直接用你已经登录好的会话
 */

const { chromium } = require('playwright');

// 1. 先用调试端口启动 Edge
const { execSync } = require('child_process');
const path = require('path');

const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const userDataDir = 'C:/Users/Heart.Sir/AppData/Local/Microsoft/Edge/User Data';

// 杀掉可能的旧Edge
try { execSync('taskkill /f /im msedge.exe 2>nul', { stdio: 'ignore' }); } catch(e) {}

console.log('🚀 启动 Edge (调试端口: 9222)...');
execSync(`"${edgePath}" --remote-debugging-port=9222 --user-data-dir="${userDataDir}" --no-first-run`, {
  stdio: 'ignore',
  detached: true,
});

// 等待启动
await new Promise(r => setTimeout(r, 3000));

// 2. 连接到 Edge
console.log('🔗 连接到 Edge...');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const defaultContext = browser.contexts()[0];
const pages = defaultContext.pages();

console.log(`📄 已打开 ${pages.length} 个标签页`);
for (let i = 0; i < pages.length; i++) {
  console.log(`   [${i}] ${pages[i].url().substring(0, 80)}`);
}

// 3. 打开新标签页到场馆
const page = await defaultContext.newPage();
console.log('\n📡 打开场馆页面...');
await page.goto('https://cgzx.scu.edu.cn/venue/', {
  waitUntil: 'domcontentloaded', timeout: 20000
}).catch(() => {});
await page.waitForTimeout(3000);
console.log('📍', page.url());

// 4. 测试API
const hasToken = await page.evaluate(() => {
  try { return !!uni.getStorageSync('accessToken'); }
  catch(e) { return false; }
}).catch(() => false);
console.log('🔑 有 token:', hasToken);

if (hasToken) {
  console.log('\n📡 测试 API...\n');
  const apis = [
    ['用户信息', '/app-api/member/user/get'],
    ['场馆列表', '/app-api/venue/venue/list'],
    ['预订配置', '/app-api/venue/booking-config/getConfig'],
    ['校园列表', '/app-api/venue/venue/get-campus-list'],
    ['1号场可预约', '/app-api/venue/field/get-bookable-times/36'],
    ['2号场可预约', '/app-api/venue/field/get-bookable-times/37'],
    ['3号场可预约', '/app-api/venue/field/get-bookable-times/38'],
  ];
  for (const [name, path] of apis) {
    const result = await page.evaluate(async (p) => {
      try {
        const res = await uni.$u.http.get(p);
        return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 200) };
      } catch(e) { return { error: e.message }; }
    }, path);
    console.log(`[${name}]`, JSON.stringify(result).substring(0, 150));
  }
} else {
  console.log('⚠️ 未登录，请在打开的 Edge 中扫码登录');
  console.log('⏳ 等待你扫码...');
  // 轮询直到登录成功
  let token = false;
  while (!token) {
    await new Promise(r => setTimeout(r, 3000));
    token = await page.evaluate(() => {
      try { return !!uni.getStorageSync('accessToken'); }
      catch(e) { return false; }
    }).catch(() => false);
  }
  console.log('✅ 登录成功，开始测试...\n');
  // ... 测API
}

console.log('\n✅ 完成，浏览器保持打开');
