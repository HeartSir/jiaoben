/**
 * 🏸 最终测试 - 打开新浏览器，你登录，我测API
 * 只在首页操作，不用带qrId的预约链接
 */

const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  console.log('📡 打开场馆首页...');
  await page.goto('https://cgzx.scu.edu.cn/venue/', {
    waitUntil: 'domcontentloaded', timeout: 20000
  }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('📍', page.url());

  // 等待登录
  const checkLogin = async () => {
    try {
      const t = await page.evaluate(() => {
        try { return uni.getStorageSync('accessToken') || ''; }
        catch(e) { return ''; }
      });
      return t;
    } catch(e) { return ''; }
  };

  let token = await checkLogin();
  if (!token) {
    console.log('\n🔑 请在浏览器中扫码登录（不用进预约页，首页登录就行）');
    console.log('⏳ 等待登录...');

    while (!token) {
      await new Promise(r => setTimeout(r, 2000));
      token = await checkLogin();
    }
    console.log('✅ 登录成功！\n');
  } else {
    console.log('✅ 检测到已有登录态\n');
  }

  // 测试API - 现在uni.$u.http应该已经加载
  // 如果uni还没加载好，导航到有uni的页面
  let uniReady = await page.evaluate(() => {
    try { return typeof uni !== 'undefined' && !!uni.$u?.http; }
    catch(e) { return false; }
  }).catch(() => false);

  if (!uniReady) {
    console.log('📡 加载uni-app环境...');
    // 导航到子页面确保uni加载
    await page.goto('https://cgzx.scu.edu.cn/venue/pages/my/my', {
      waitUntil: 'domcontentloaded', timeout: 10000
    }).catch(() => {});
    await page.waitForTimeout(3000);
  }

  console.log('========== 开始测试 API ==========\n');

  // API 1-3: 基础信息
  const apis = [
    ['用户信息', '/app-api/member/user/get'],
    ['场馆列表', '/app-api/venue/venue/list'],
    ['预订配置', '/app-api/venue/booking-config/getConfig'],
    ['校园列表', '/app-api/venue/venue/get-campus-list'],
  ];

  for (const [name, path] of apis) {
    const r = await page.evaluate(async (p) => {
      try {
        const res = await uni.$u.http.get(p);
        return { code: res.code, msg: res.msg, data: res.data ? JSON.stringify(res.data).substring(0, 300) : 'null' };
      } catch(e) { return { error: e.message }; }
    }, path);
    console.log(`[${name}]`);
    console.log(`  code: ${r.code}, msg: ${r.msg || ''}`);
    if (r.data && r.data !== 'null') console.log(`  data: ${r.data}`);
    console.log('');
  }

  // API 4: 可预约时间段 (所有场地)
  console.log('📌 各场地可预约时间:');
  const fields = [['1号场',36],['2号场',37],['3号场',38],['4号场',39],['5号场',40],
                  ['6号场',41],['7号场',42],['8号场',43],['9号场',44],['10号场',45]];
  for (const [name, id] of fields) {
    const r = await page.evaluate(async (fid) => {
      try {
        const res = await uni.$u.http.get(`/app-api/venue/field/get-bookable-times/${fid}`);
        if (res.code === 200 && res.data && res.data.length > 0) {
          const slots = res.data.map(s => `${s.startTime}-${s.endTime}(可约:${s.bookable})`).join(', ');
          return { code: res.code, slots };
        }
        return { code: res.code, msg: res.msg, data: res.data ? '有数据' : 'null' };
      } catch(e) { return { error: e.message }; }
    }, id);
    if (r.slots) {
      console.log(`  ${name}: ✅ ${r.slots}`);
    } else {
      console.log(`  ${name}: ${r.code} ${r.msg || ''} ${r.data || ''}`);
    }
  }

  console.log('\n✅ 测试完成！浏览器保持打开');
})();
