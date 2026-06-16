/**
 * 诊断：检查 uni.$u.http 的实际响应格式
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const AUTH_FILE = path.join(__dirname, '.venue-auth.json');
const VENUE_HOME = 'https://cgzx.scu.edu.cn/venue/';

(async () => {
  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const httpOrigin = auth.origins.find(o => o.origin === 'http://cgzx.scu.edu.cn');
  const token = httpOrigin?.localStorage?.find(l => l.name === 'accessToken')?.value;
  const refreshToken = httpOrigin?.localStorage?.find(l => l.name === 'refreshToken')?.value;
  const userInfo = httpOrigin?.localStorage?.find(l => l.name === 'userInfo')?.value;

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const page = await context.newPage();

  await page.goto(VENUE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // 注入 token
  await page.evaluate(({ token, refreshToken, userInfo }) => {
    try {
      uni.setStorageSync('accessToken', token);
      uni.setStorageSync('refreshToken', refreshToken);
      if (userInfo) uni.setStorageSync('userInfo', userInfo);
    } catch(e) {}
  }, { token, refreshToken, userInfo });

  // 等待 uni 就绪
  for (let i = 0; i < 10; i++) {
    const ready = await page.evaluate(() => {
      try { return typeof uni !== 'undefined' && !!uni.$u?.http; }
      catch(e) { return false; }
    }).catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // 检查 uni.$u.http 的配置
  console.log('📌 诊断 uni.$u.http 配置...');
  const diag = await page.evaluate(() => {
    try {
      const http = uni.$u.http;
      return {
        hasBaseUrl: !!http.defaults?.baseURL,
        baseUrl: http.defaults?.baseURL || '',
        hasInterceptors: !!http.interceptors,
        methods: Object.keys(http).filter(k => typeof http[k] === 'function').join(', '),
      };
    } catch(e) { return { error: e.message }; }
  });
  console.log(`  baseURL: ${diag.baseUrl || '无'}`);
  console.log(`  方法: ${diag.methods}\n`);

  // 测试：直接用完整 URL 调用
  console.log('📌 测试1: 直接用完整路径');
  const r1 = await page.evaluate(async () => {
    try {
      const res = await uni.$u.http.get('/app-api/member/user/get');
      // 打印完整响应结构
      const keys = Object.keys(res);
      return {
        keys: keys.join(', '),
        code: res.code,
        dataCode: res.data?.code,
        dataMsg: res.data?.msg,
        dataStr: JSON.stringify(res).substring(0, 500),
      };
    } catch(e) { return { error: e.message }; }
  });
  console.log(`  response keys: ${r1.keys}`);
  console.log(`  res.code: ${r1.code}, res.data?.code: ${r1.dataCode}`);
  console.log(`  res.data?.msg: ${r1.dataMsg}`);
  if (r1.dataStr) console.log(`  完整响应: ${r1.dataStr}`);
  console.log('');

  // 成功响应格式的诊断
  console.log('📌 测试2: 场馆列表');
  const r2 = await page.evaluate(async () => {
    try {
      const res = await uni.$u.http.get('/app-api/venue/venue/list');
      const keys = Object.keys(res);
      return {
        keys: keys.join(', '),
        code: res.code,
        dataCode: res.data?.code,
        dataMsg: res.data?.msg,
        hasData: !!res.data?.data,
        count: Array.isArray(res.data?.data) ? res.data.data.length : (Array.isArray(res.data) ? res.data.length : -1),
        sample: res.data?.data ? JSON.stringify(res.data.data[0]).substring(0, 300) :
                (Array.isArray(res.data) ? JSON.stringify(res.data[0]).substring(0, 300) : ''),
      };
    } catch(e) { return { error: e.message }; }
  });
  console.log(`  response keys: ${r2.keys}`);
  console.log(`  res.code: ${r2.code}, res.data?.code: ${r2.dataCode}`);
  console.log(`  count: ${r2.count}`);
  if (r2.sample) console.log(`  sample: ${r2.sample}`);
  console.log('');

  // 可预约时间段
  console.log('📌 测试3: 可预约时间段 (3号场,38)');
  const r3 = await page.evaluate(async () => {
    try {
      const res = await uni.$u.http.get('/app-api/venue/field/get-bookable-times/38');
      const keys = Object.keys(res);
      return {
        keys: keys.join(', '),
        code: res.code,
        dataCode: res.data?.code,
        dataMsg: res.data?.msg,
        slots: res.data?.data ? JSON.stringify(res.data.data).substring(0, 2000) :
               (Array.isArray(res.data) ? JSON.stringify(res.data).substring(0, 2000) : '无'),
        slotKeys: res.data?.data?.[0] ? Object.keys(res.data.data[0]).join(', ') :
                  (Array.isArray(res.data) && res.data[0] ? Object.keys(res.data[0]).join(', ') : ''),
      };
    } catch(e) { return { error: e.message }; }
  });
  console.log(`  response keys: ${r3.keys}`);
  console.log(`  res.data?.code: ${r3.dataCode}, res.data?.msg: ${r3.dataMsg}`);
  console.log(`  slot keys: ${r3.slotKeys}`);
  console.log(`  slots: ${r3.slots}`);
  console.log('');

  // 下单参数格式
  console.log('📌 测试4: 订单列表（看已有订单结构）');
  const r4 = await page.evaluate(async () => {
    try {
      const res = await uni.$u.http.get('/app-api/venue/booking/orders/page?current=1&size=3');
      console.log('订单原始响应:', JSON.stringify(res));
      const keys = Object.keys(res);
      return {
        keys: keys.join(', '),
        code: res.code,
        dataCode: res.data?.code,
        orders: res.data?.data?.list ? JSON.stringify(res.data.data.list[0]).substring(0, 1000) :
                (res.data?.list ? JSON.stringify(res.data.list[0]).substring(0, 1000) : '无'),
      };
    } catch(e) { return { error: e.message }; }
  });
  console.log(`  response keys: ${r4.keys}`);
  console.log(`  order sample: ${r4.orders || '无'}`);

  console.log('\n✅ 诊断完成');
  console.log('浏览器保持打开');
})();
