const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN',
  });
  const page = await context.newPage();

  // 监听所有API请求，打印出来
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('/app-api/') && resp.status() === 200) {
      try {
        const json = await resp.json();
        if (json.code === 200) {
          console.log(`✅ [${resp.status()}] ${url.split('?')[0].split('/app-api')[1]}`);
        }
      } catch(e) {}
    }
  });

  // 打开首页等登录
  console.log('📡 打开场馆首页...');
  await page.goto('https://cgzx.scu.edu.cn/venue/', {
    waitUntil: 'domcontentloaded', timeout: 20000
  }).catch(() => {});

  console.log('📍', page.url());
  console.log('\n🔑 请在打开的浏览器中登录（扫码/密码均可）');
  console.log('⏳ 登录后页面会跳转，我检测到后自动开始测试...\n');

  // 轮询检测是否登录成功
  let loggedIn = false;
  while (!loggedIn) {
    await new Promise(r => setTimeout(r, 2000));
    const hasToken = await page.evaluate(() => {
      try { return !!uni.getStorageSync('accessToken'); }
      catch(e) { return false; }
    }).catch(() => false);
    if (hasToken) {
      loggedIn = true;
      console.log('✅ 检测到登录成功！\n');
    }
  }

  // 保存登录态
  await context.storageState({ path: '.venue-auth.json' });

  // 导航到预约页面（加载完整的预约JS）
  console.log('📡 加载预约页面...');
  const venueUrl = 'https://cgzx.scu.edu.cn/venue/subPackage/venue/venue_reservation?params=%5B%7B%22id%22%3A36%2C%22venueId%22%3A1%2C%22name%22%3A%221%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%5D&qrId=C00035000007';
  await page.goto(venueUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('📍', page.url());

  // ==== 测试全部API ====
  console.log('\n========== 测试全部 API ==========\n');

  // 1. 用户信息
  console.log('📌 1. 用户信息 (member/user/get)');
  const userInfo = await page.evaluate(async () => {
    const res = await uni.$u.http.get('/app-api/member/user/get');
    return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 300) };
  });
  console.log('   ', JSON.stringify(userInfo), '\n');

  // 2. 场馆列表
  console.log('📌 2. 场馆列表 (venue/venue/list)');
  const venues = await page.evaluate(async () => {
    const res = await uni.$u.http.get('/app-api/venue/venue/list');
    return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 500) };
  });
  console.log('   ', JSON.stringify(venues), '\n');

  // 3. 预订配置
  console.log('📌 3. 预订配置 (booking-config/getConfig)');
  const config = await page.evaluate(async () => {
    const res = await uni.$u.http.get('/app-api/venue/booking-config/getConfig');
    return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 500) };
  });
  console.log('   ', JSON.stringify(config), '\n');

  // 4. 各场地的可预约时间
  console.log('📌 4. 各场地可预约时间');
  for (const [name, id] of [['1号场',36],['2号场',37],['3号场',38],['4号场',39],['5号场',40]]) {
    const result = await page.evaluate(async (fieldId) => {
      const res = await uni.$u.http.get(`/app-api/venue/field/get-bookable-times/${fieldId}`);
      return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 300) };
    }, id);
    console.log(`   ${name}(id=${id}):`, JSON.stringify(result).substring(0, 200));
  }
  console.log('');

  // 5. 校园列表
  console.log('📌 5. 校园列表 (venue/get-campus-list)');
  const campus = await page.evaluate(async () => {
    const res = await uni.$u.http.get('/app-api/venue/venue/get-campus-list');
    return { code: res.code, msg: res.msg };
  });
  console.log('   ', JSON.stringify(campus), '\n');

  // 6. 获取门票/场馆信息
  console.log('📌 6. 场馆详情 (gym-info/get)');
  const gymInfo = await page.evaluate(async () => {
    const res = await uni.$u.http.get('/app-api/venue/gym-info/get');
    return { code: res.code, msg: res.msg, data: JSON.stringify(res.data).substring(0, 300) };
  });
  console.log('   ', JSON.stringify(gymInfo), '\n');

  console.log('========== 测试完毕 ==========');
  console.log('\n🖥️ 浏览器保持打开，你可以查看结果');
  console.log('💾 登录态已保存到 .venue-auth.json');
})();
