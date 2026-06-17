/**
 * 最终测试 - 在页面加载前注入 token
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

  console.log(`🔑 Token: ${token?.substring(0,20)}...`);

  const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  });

  // 关键：在页面加载任何 JS 前注入 token
  await context.addInitScript((t, rt, ui) => {
    try {
      // 在 localStorage 可用时立即写入
      Object.defineProperty(window, 'localStorage', {
        get() { return localStorage; }
      });
      // 注意: addInitScript 会在页面加载前执行，但 localStorage 可能还不可用
      // 用 MutationObserver 等待 uni 就绪
      const waitAndSet = () => {
        try {
          window.localStorage.setItem('accessToken', t);
          window.localStorage.setItem('refreshToken', rt);
          if (ui) window.localStorage.setItem('userInfo', ui);
        } catch(e) { setTimeout(waitAndSet, 100); }
      };
      waitAndSet();
    } catch(e) {}
  }, token, refreshToken, userInfo);

  const page = await context.newPage();

  // 拦截所有API响应打印
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/app-api/') && !url.includes('refresh-token')) {
      try {
        const json = await resp.json();
        const shortPath = url.split('/app-api')[1].split('?')[0];
        if (json.code === 200 || json.code === 0) {
          console.log(`  ✅ ${shortPath}`);
        } else {
          console.log(`  ⚠️ ${shortPath} → code:${json.code} msg:${(json.msg||'').substring(0,30)}`);
        }
      } catch(e) {
        // 响应可能是加密的，uni.$u.http 才能解密
      }
    }
  });

  console.log('📡 打开场馆首页...');
  await page.goto(VENUE_HOME, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  // 注入到 https 域
  await page.evaluate(({ t, rt, ui }) => {
    try {
      uni.setStorageSync('accessToken', t);
      uni.setStorageSync('refreshToken', rt);
      if (ui) uni.setStorageSync('userInfo', JSON.parse(ui));
    } catch(e) { console.error('注入失败:', e); }
  }, { t: token, rt: refreshToken, ui: userInfo });

  // 等待 uni 就绪
  let uniReady = false;
  for (let i = 0; i < 15; i++) {
    uniReady = await page.evaluate(() => {
      try { return typeof uni !== 'undefined' && !!uni.$u?.http; }
      catch(e) { return false; }
    }).catch(() => false);
    if (uniReady) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  const liveToken = await page.evaluate(() => {
    try { return uni.getStorageSync('accessToken') || ''; }
    catch(e) { return ''; }
  });
  console.log(`📍 Token: ${liveToken ? '✅' : '❌'}`);
  console.log(`📍 uni.$u: ${uniReady ? '✅' : '❌'}`);

  if (!liveToken || !uniReady) {
    console.log('⚠️ 环境未就绪，请在浏览器中扫码登录...');
    while (!liveToken) {
      await new Promise(r => setTimeout(r, 3000));
      const t = await page.evaluate(() => {
        try { return uni.getStorageSync('accessToken') || ''; }
        catch(e) { return ''; }
      });
      if (t) {
        liveToken = t;
        console.log('✅ 登录成功！');
      }
    }
  }

  console.log('\n========== API 测试 ==========\n');

  // 测试所有API
  const testAPI = async (name, method, path, body) => {
    const r = await page.evaluate(async ({ method, path, body }) => {
      try {
        const http = uni.$u.http;
        let res;
        if (method === 'GET') {
          res = await http.get(path);
        } else {
          res = await http.post(path, body || {});
        }
        return {
          code: res?.code,
          msg: res?.msg?.substring(0, 50),
          hasData: res?.data !== undefined && res?.data !== null,
          dataStr: res?.data ? JSON.stringify(res.data).substring(0, 800) : null,
          allKeys: Object.keys(res).join(','),
        };
      } catch(e) {
        return { error: e.message, stack: e.stack?.substring(0, 200) };
      }
    }, { method, path, body });
    console.log(`[${name}]`);
    if (r.error) {
      console.log(`  ❌ ${r.error}`);
    } else {
      console.log(`  code:${r.code} msg:${r.msg || ''} keys:${r.allKeys}`);
      if (r.dataStr) console.log(`  data: ${r.dataStr.substring(0, 400)}`);
    }
    console.log('');
    return r;
  };

  // 1. 基础信息
  await testAPI('用户信息', 'GET', '/app-api/member/user/get');
  await testAPI('场馆列表', 'GET', '/app-api/venue/venue/list');
  await testAPI('预订配置', 'GET', '/app-api/venue/booking-config/getConfig');

  // 2. 可预约时间段
  console.log('--- 可预约时间段 ---');
  for (const [name, id] of [['1号场',36], ['3号场',38], ['7号场',42]]) {
    const r = await testAPI(name, 'GET', `/app-api/venue/field/get-bookable-times/${id}`);
  }

  // 3. 订单列表
  await testAPI('订单列表', 'GET', '/app-api/venue/booking/orders/page?current=1&size=3');

  // 4. 场地详情
  await testAPI('场地列表by场馆', 'GET', '/app-api/venue/field/list-by-venue/1');

  console.log('\n========== 完成 ==========');
  console.log('浏览器保持打开');
})();
