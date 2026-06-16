const { chromium } = require('playwright');
const fs = require('fs');
const authFile = require('path').join(__dirname, '.venue-auth.json');

(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'msedge', args: ['--no-sandbox'] });

  const context = fs.existsSync(authFile)
    ? await browser.newContext({ storageState: authFile, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    : await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });

  const page = await context.newPage();

  // 先打开场馆页面加载 JS
  console.log('📡 打开预约页面...');
  await page.goto('https://cgzx.scu.edu.cn/venue/subPackage/venue/venue_reservation?params=%5B%7B%22id%22%3A36%2C%22venueId%22%3A1%2C%22name%22%3A%221%E5%8F%B7%E5%9C%BA%22%7D%5D&qrId=C00035000007', {
    waitUntil: 'domcontentloaded', timeout: 20000
  }).catch(e => console.log('⚠️', e.message));

  await page.waitForTimeout(3000);
  console.log('📍 URL:', page.url());

  // 检测是否未登录
  const needLogin = page.url().includes('login') || page.url().includes('auth');
  console.log(needLogin ? '🔴 未登录' : '✅ 已登录');

  if (needLogin) {
    console.log('🔑 请在浏览器中手动登录...');
    // 如果跳转了，导航到首页等登录
    await page.goto('https://cgzx.scu.edu.cn/venue/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    console.log('⏳ 等待你扫码登录...');
    await page.waitForTimeout(90000);

    // 保存登录态
    await context.storageState({ path: authFile });
    console.log('💾 已保存');

    // 重新导航到预约页
    await page.goto('https://cgzx.scu.edu.cn/venue/subPackage/venue/venue_reservation?params=%5B%7B%22id%22%3A36%2C%22venueId%22%3A1%2C%22name%22%3A%221%E5%8F%B7%E5%9C%BA%22%7D%5D&qrId=C00035000007', {
      waitUntil: 'domcontentloaded', timeout: 20000
    }).catch(() => {});
    await page.waitForTimeout(2000);
  }

  // 测试 API
  console.log('\n📡 测试 API...\n');

  const apis = [
    ['场馆列表', 'GET', '/app-api/venue/venue/list'],
    ['校园列表', 'GET', '/app-api/venue/venue/get-campus-list'],
    ['预订配置', 'GET', '/app-api/venue/booking-config/getConfig'],
    ['1号场可预约时间', 'GET', '/app-api/venue/field/get-bookable-times/36'],
  ];

  for (const [name, method, path] of apis) {
    const result = await page.evaluate(async ({ path }) => {
      try {
        const res = await uni.$u.http.get(path);
        return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 300) };
      } catch(e) {
        return { error: e.message };
      }
    }, { path });

    console.log(`[${name}]`);
    console.log(`  ${JSON.stringify(result)}`);
    console.log('');
  }

  await browser.close();
})();
