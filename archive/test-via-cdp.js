/**
 * 通过 CDP 连接到已运行的 Edge
 * 借用你已有的登录态
 */

const { chromium } = require('playwright');

(async () => {
  try {
    console.log('🔗 连接到正在运行的 Edge...');
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');

    // 获取默认上下文（包含所有cookie/登录态）
    const defaultContext = browser.contexts()[0];
    if (!defaultContext) {
      console.log('❌ 没有默认上下文');
      return;
    }

    // 查看已有页面
    const existingPages = defaultContext.pages();
    console.log(`📄 已有 ${existingPages.length} 个标签页:`);
    for (let i = 0; i < existingPages.length; i++) {
      const url = existingPages[i].url();
      console.log(`   [${i}] ${url.substring(0, 100)}`);
    }

    // 检查是否有川大场馆页面已打开
    let venuePage = existingPages.find(p => p.url().includes('cgzx.scu.edu.cn/venue'));
    if (!venuePage) {
      // 打开新标签页
      venuePage = await defaultContext.newPage();
      console.log('\n📡 打开场馆页面...');
      await venuePage.goto('https://cgzx.scu.edu.cn/venue/', {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {});
      await venuePage.waitForTimeout(3000);
    }

    console.log('📍', venuePage.url());

    // 检查 uni-app 是否加载
    const uniLoaded = await venuePage.evaluate(() => {
      return typeof uni !== 'undefined' && uni.$u && typeof uni.$u.http !== 'undefined';
    }).catch(() => false);

    if (!uniLoaded) {
      console.log('⚠️ uni-app 未加载，导航到预约页面...');
      await venuePage.goto('https://cgzx.scu.edu.cn/venue/subPackage/venue/venue_reservation?params=%5B%7B%22id%22%3A36%2C%22venueId%22%3A1%2C%22name%22%3A%221%E5%8F%B7%E5%9C%BA%22%7D%5D&qrId=C00035000007', {
        waitUntil: 'domcontentloaded', timeout: 20000
      }).catch(() => {});
      await venuePage.waitForTimeout(5000);
    }

    // 检查登录状态
    const token = await venuePage.evaluate(() => {
      try { return uni.getStorageSync('accessToken') || 'NOT_FOUND'; }
      catch(e) { return 'ERROR: ' + e.message; }
    }).catch(e => 'ERROR: ' + e.message);
    console.log('🔑 accessToken:', token.substring(0, 30) + '...');

    // 如果没登录，轮询等扫码
    if (token === 'NOT_FOUND' || token.startsWith('ERROR')) {
      console.log('⚠️ 未登录，请在 Edge 中手动打开场馆页面并登录');
      console.log('⏳ 登录后会自动继续...');

      let loggedIn = false;
      while (!loggedIn) {
        await new Promise(r => setTimeout(r, 3000));
        const t = await venuePage.evaluate(() => {
          try { return uni.getStorageSync('accessToken') || ''; }
          catch(e) { return ''; }
        }).catch(() => '');
        if (t) {
          loggedIn = true;
          console.log('✅ 登录成功！');
        }
      }
    }

    // ==== 测试全部 API ====
    console.log('\n========== 测试全部 API ==========\n');

    const apis = [
      ['用户信息', '/app-api/member/user/get'],
      ['场馆列表', '/app-api/venue/venue/list'],
      ['预订配置', '/app-api/venue/booking-config/getConfig'],
      ['校园列表', '/app-api/venue/venue/get-campus-list'],
      ['1号场(36)可预约', '/app-api/venue/field/get-bookable-times/36'],
      ['2号场(37)可预约', '/app-api/venue/field/get-bookable-times/37'],
      ['3号场(38)可预约', '/app-api/venue/field/get-bookable-times/38'],
      ['4号场(39)可预约', '/app-api/venue/field/get-bookable-times/39'],
      ['5号场(40)可预约', '/app-api/venue/field/get-bookable-times/40'],
    ];

    for (const [name, apiPath] of apis) {
      const result = await venuePage.evaluate(async (path) => {
        try {
          const res = await uni.$u.http.get(path);
          return {
            code: res.code,
            msg: res.msg,
            data: res.data ? JSON.stringify(res.data).substring(0, 400) : null
          };
        } catch(e) {
          return { error: e.message };
        }
      }, apiPath);
      console.log(`[${name}]`);
      console.log(`  code: ${result.code || result.error}, msg: ${result.msg || ''}`);
      if (result.data) console.log(`  data: ${result.data}`);
      console.log('');
    }

    console.log('========== 测试完毕 ==========');
    console.log('\n🖥️ Edge 保持打开，你可以继续使用');

  } catch(err) {
    console.error('❌ 连接失败:', err.message);
  }
})();
