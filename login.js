/**
 * login.js - 扫码登录，保存 token
 * 运行：node login.js
 *
 * 打开浏览器 → 扫码登录 → 保存 token → 关闭
 * 之后 book.js 会自动使用保存的 token
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

(async () => {
  console.log('🚀 打开浏览器进行扫码登录...');
  console.log('📡 打开 https://cgzx.scu.edu.cn/venue/ ...\n');

  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();

  await page.goto('https://cgzx.scu.edu.cn/venue/', {
    waitUntil: 'domcontentloaded', timeout: 30000
  }).catch(() => {});

  console.log('🔑 请在浏览器中扫码登录（川大统一身份认证）');
  console.log('⏳ 等待登录...\n');

  let token = '';
  while (!token) {
    await new Promise(r => setTimeout(r, 2000));
    token = await page.evaluate(() => {
      try { return uni.getStorageSync('accessToken') || ''; }
      catch(e) { return ''; }
    }).catch(() => '');
  }

  // 获取完整的 localStorage
  const storage = await page.evaluate(() => {
    try {
      return {
        accessToken: uni.getStorageSync('accessToken'),
        refreshToken: uni.getStorageSync('refreshToken'),
        userInfo: uni.getStorageSync('userInfo'),
      };
    } catch(e) { return {}; }
  });

  // 保存到 auth 文件
  const authData = {
    cookies: [],
    origins: [{
      origin: 'https://cgzx.scu.edu.cn',
      localStorage: [
        { name: 'accessToken', value: storage.accessToken },
        { name: 'refreshToken', value: storage.refreshToken || '' },
        { name: 'userInfo', value: typeof storage.userInfo === 'object' ? JSON.stringify(storage.userInfo) : (storage.userInfo || '') },
      ]
    }, {
      origin: 'http://cgzx.scu.edu.cn',
      localStorage: [
        { name: 'accessToken', value: storage.accessToken },
        { name: 'refreshToken', value: storage.refreshToken || '' },
        { name: 'userInfo', value: typeof storage.userInfo === 'object' ? JSON.stringify(storage.userInfo) : (storage.userInfo || '') },
      ]
    }]
  };

  fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2));
  console.log(`\n✅ 登录成功！Token: ${storage.accessToken?.substring(0,20)}...`);
  console.log('💾 登录态已保存到 .venue-auth.json');
  console.log('📝 之后运行 node book.js 即可自动抢场');

  await browser.close();
})();
