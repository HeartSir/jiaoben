/**
 * 用你的真实 Edge 配置启动浏览器
 * 这样自动携带所有登录态
 */

const { chromium } = require('playwright');
const path = require('path');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const USER_DATA_DIR = 'C:/Users/Heart.Sir/AppData/Local/Microsoft/Edge/User Data';

(async () => {
  console.log('🚀 启动你的 Edge（复用登录态）...');

  const context = await chromium.launchPersistentContext(
    USER_DATA_DIR,
    {
      channel: 'msedge',
      headless: false,
      args: [
        '--profile-directory=Default',
        '--no-sandbox',
      ],
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    }
  );

  // 新建标签页
  const page = await context.newPage();

  console.log('📡 打开场馆页面...');
  await page.goto('https://cgzx.scu.edu.cn/venue/', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(e => console.log('⚠️', e.message));

  await page.waitForTimeout(4000);
  console.log('📍', page.url());

  // 查看是否已登录
  const token = await page.evaluate(() => {
    try { return uni.getStorageSync('accessToken') || 'NO_TOKEN'; }
    catch(e) { return 'UNI_NOT_READY'; }
  }).catch(() => 'UNI_NOT_READY');

  console.log('🔑 Token:', token === 'NO_TOKEN' ? '未登录' : token.substring(0, 30) + '...');

  if (token === 'NO_TOKEN' || token === 'UNI_NOT_READY') {
    console.log('\n⚠️ 未登录或 uni-app 未加载');
    console.log('请扫码登录，登录后输入 "ok" 继续测试');
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
  }

  // 测试所有API
  console.log('\n========== 测试 API ==========\n');

  const apis = [
    ['用户信息', 'GET', '/app-api/member/user/get'],
    ['场馆列表', 'GET', '/app-api/venue/venue/list'],
    ['校园列表', 'GET', '/app-api/venue/venue/get-campus-list'],
    ['预订配置', 'GET', '/app-api/venue/booking-config/getConfig'],
    ['1号场(36)', 'GET', '/app-api/venue/field/get-bookable-times/36'],
    ['2号场(37)', 'GET', '/app-api/venue/field/get-bookable-times/37'],
    ['3号场(38)', 'GET', '/app-api/venue/field/get-bookable-times/38'],
    ['4号场(39)', 'GET', '/app-api/venue/field/get-bookable-times/39'],
    ['5号场(40)', 'GET', '/app-api/venue/field/get-bookable-times/40'],
  ];

  for (const [name, method, apiPath] of apis) {
    const result = await page.evaluate(async (path) => {
      try {
        const res = await uni.$u.http.get(path);
        const dataStr = res.data ? JSON.stringify(res.data).substring(0, 500) : 'null';
        return { code: res.code, msg: res.msg, data: dataStr };
      } catch(e) {
        return { error: e.message, stack: e.stack?.substring(0, 200) };
      }
    }, apiPath);

    console.log(`[${name}]`);
    console.log(`  code: ${result.code || '❌' + (result.error || '')}`);
    if (result.msg) console.log(`  msg: ${result.msg}`);
    if (result.data && result.data !== 'null') console.log(`  data: ${result.data}`);
    console.log('');
  }

  console.log('✅ 测试完成，浏览器保持打开');
})();
