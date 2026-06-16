/**
 * 🏸 book.js - 川大场馆自动抢订 (无头浏览器 + API版)
 *
 * 原理：
 *   Playwright 无头 Chromium → 加载 uni-app 页面获得加解密环境
 *   → 注入 accessToken → 通过 page.evaluate 调 uni.$u.http
 *   → uni.$u.http 自动处理 SM2/SM4 加解密
 *
 * 参数格式（从源码逆向）：
 *   createOrder({
 *     bookings: [{ venueId, fieldId, startTime, endTime, bookingDate }],
 *     userId, venueId, couponId: ''
 *   })
 *
 * 部署：
 *   本地 cron / Windows 任务计划 / Render cron
 *   依赖：npm install playwright
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ================= 配置 =================
const CONFIG = {
  // 目标抢场时间 (24小时制)
  targetHour: 8,
  targetMinute: 30,
  targetSecond: 0,
  preWakeMs: 120000,          // 提前2分钟启动浏览器

  // userId (从已保存的登录态获取)
  userId: null,  // 自动读取

  // 望江体育馆二楼羽毛球场
  venueId: 1,

  // 第一志愿
  primaryWishes: [
    { fieldId: 38, name: "3号场", time: "21:00", timeEnd: "22:00" },
    { fieldId: 39, name: "4号场", time: "21:00", timeEnd: "22:00" },
    { fieldId: 37, name: "2号场", time: "21:00", timeEnd: "22:00" },
  ],

  // 扫荡
  fallbackWishes: [
    { fieldId: 38, name: "3号场" },
    { fieldId: 39, name: "4号场" },
    { fieldId: 42, name: "7号场" },
    { fieldId: 43, name: "8号场" },
    { fieldId: 37, name: "2号场" },
    { fieldId: 40, name: "5号场" },
    { fieldId: 41, name: "6号场" },
    { fieldId: 44, name: "9号场" },
  ],
  fallbackTimes: ["21:00","18:00","16:00","19:00","15:00","20:00","14:00","17:00"],

  // 持久化
  authFile: path.join(__dirname, '.venue-auth.json'),
};

// ================= 日志 =================
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ================= 引擎 =================
class BookingEngine {
  constructor() {
    this.browser = null;
    this.page = null;
    this.auth = null;
  }

  loadAuth() {
    if (!fs.existsSync(CONFIG.authFile)) return false;
    this.auth = JSON.parse(fs.readFileSync(CONFIG.authFile, 'utf8'));
    return true;
  }

  saveAuth() {
    fs.writeFileSync(CONFIG.authFile, JSON.stringify(this.auth, null, 2));
  }

  getToken() {
    const origin = this.auth?.origins?.find(o =>
      ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn'].includes(o.origin)
    );
    return origin?.localStorage?.find(l => l.name === 'accessToken')?.value || null;
  }

  getRefreshToken() {
    const origin = this.auth?.origins?.find(o =>
      ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn'].includes(o.origin)
    );
    return origin?.localStorage?.find(l => l.name === 'refreshToken')?.value || null;
  }

  setAuthToken(token, refreshToken) {
    for (const originUrl of ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn']) {
      let origin = this.auth?.origins?.find(o => o.origin === originUrl);
      if (!origin) {
        if (!this.auth?.origins) this.auth.origins = [];
        origin = { origin: originUrl, localStorage: [] };
        this.auth.origins.push(origin);
      }
      let item = origin.localStorage.find(l => l.name === 'accessToken');
      if (item) item.value = token;
      else origin.localStorage.push({ name: 'accessToken', value: token });

      if (refreshToken) {
        let rt = origin.localStorage.find(l => l.name === 'refreshToken');
        if (rt) rt.value = refreshToken;
        else origin.localStorage.push({ name: 'refreshToken', value: refreshToken });
      }
    }
    this.saveAuth();
  }

  getLiveToken() {
    return this.page.evaluate(() => {
      try { return uni.getStorageSync('accessToken') || ''; }
      catch(e) { return ''; }
    });
  }

  async getUserId() {
    // 从 auth 文件读取
    const origin = this.auth?.origins?.find(o =>
      ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn'].includes(o.origin)
    );
    const userInfoRaw = origin?.localStorage?.find(l => l.name === 'userInfo')?.value;
    if (userInfoRaw) {
      // userInfo 可能是 JSON 字符串，也可能是已解析的对象
      const info = typeof userInfoRaw === 'string' ? (() => { try { return JSON.parse(userInfoRaw); } catch(e) { return null; } })() : userInfoRaw;
      if (info) {
        if (info.data?.userId) return info.data?.userId;
        if (info.userId) return info.userId;
      }
    }
    return null;
  }

  async start() {
    if (!this.loadAuth()) {
      log('❌ 未找到 .venue-auth.json，请先扫码登录');
      return false;
    }

    CONFIG.userId = await this.getUserId();
    log(`👤 用户ID: ${CONFIG.userId}`);

    // 启动无头浏览器
    log('🚀 启动无头浏览器...');

    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
    };

    // 在 Linux (Render) 上自动查找已安装的 chromium
    const cacheDir = '/opt/render/.cache/ms-playwright';
    if (fs.existsSync(cacheDir)) {
      const dirs = fs.readdirSync(cacheDir).sort().reverse();
      // 优先用完整版 chromium（非 headless-shell）
      const full = dirs.find(d => d.startsWith('chromium-') && !d.includes('headless'));
      if (full) {
        const p = path.join(cacheDir, full, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) {
          launchOpts.executablePath = p;
          log(`📂 使用 chromium: ${full}`);
        }
      }
    }

    // 如果环境变量指定了路径也用它
    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    try {
      this.browser = await chromium.launch(launchOpts);
    } catch (err) {
      const msg = err.message || '';
      // 如果找不到浏览器，自动安装
      if (msg.includes('Executable') && msg.includes('exist')) {
        log('⚠️ 浏览器未找到，正在安装...');
        const { execSync } = require('child_process');
        execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 120000 });
        this.browser = await chromium.launch(launchOpts);
      } else {
        throw err;
      }
    }

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
    });
    this.page = await context.newPage();

    // 加载 uni-app 环境
    log('📡 加载 uni-app 环境...');
    await this.page.goto('https://cgzx.scu.edu.cn/venue/', {
      waitUntil: 'domcontentloaded', timeout: 30000
    }).catch(e => log(`⚠️ ${e.message}`));
    await sleep(3000);

    // 注入 token
    await this.injectToken();

    // 等 uni.$u.http 就绪
    for (let i = 0; i < 10; i++) {
      const ready = await this.page.evaluate(() => {
        try { return typeof uni !== 'undefined' && !!uni.$u?.http; }
        catch(e) { return false; }
      });
      if (ready) break;
      await sleep(2000);
    }

    // 刷新 token 如果过期
    await this.ensureTokenValid();

    const t = await this.getLiveToken();
    log(`🔑 Token: ${t ? '✅' : '❌'}`);
    return !!t;
  }

  async injectToken(token, refreshToken) {
    const t = token || this.getToken();
    const rt = refreshToken || this.getRefreshToken();
    if (!t) return;
    await this.page.evaluate(({t, rt}) => {
      try {
        uni.setStorageSync('accessToken', t);
        if (rt) uni.setStorageSync('refreshToken', rt);
      } catch(e) {}
    }, {t, rt});
  }

  async ensureTokenValid() {
    const valid = await this.page.evaluate(async () => {
      try {
        const res = await uni.$u.http.get('/app-api/member/user/get');
        return res.code === 0;
      } catch(e) { return false; }
    });
    if (valid) { log('✅ Token 有效'); return true; }

    log('🔄 Token 过期，刷新...');
    const refreshToken = this.getRefreshToken();
    if (!refreshToken) { log('❌ 无 refreshToken'); return false; }

    const result = await this.page.evaluate(async (rt) => {
      try {
        const res = await uni.$u.http.post('/app-api/member/auth/refresh-token', { refreshToken: rt });
        if (res.code === 0 && res.data?.accessToken) {
          uni.setStorageSync('accessToken', res.data.accessToken);
          if (res.data.refreshToken) uni.setStorageSync('refreshToken', res.data.refreshToken);
          return { success: true, token: res.data.accessToken, refreshToken: res.data.refreshToken };
        }
        return { success: false };
      } catch(e) { return { success: false }; }
    }, refreshToken);

    if (result.success) {
      log(`✅ Token 刷新成功`);
      this.setAuthToken(result.token, result.refreshToken);
      return true;
    }
    log('❌ 刷新失败');
    return false;
  }

  /** 通过 page.evaluate 调用 uni.$u.http 发 API */
  async callAPI(method, apiPath, data) {
    return await this.page.evaluate(async ({method, path, data}) => {
      try {
        const http = uni.$u.http;
        let res = method === 'GET'
          ? await http.get(path)
          : await http.post(path, data || {});
        return { success: true, code: res.code, msg: res.msg, data: res.data };
      } catch(e) {
        return { success: false, code: e.code, msg: e.msg, data: e.data, error: e.message };
      }
    }, { method, path: '/app-api' + apiPath, data });
  }

  /** 获取可预约时间段 */
  async getBookableTimes(fieldId) {
    return this.callAPI('GET', `/venue/field/get-bookable-times/${fieldId}`);
  }

  /** 创建订单 — 参数格式从页面源码逆向 */
  async createOrder(fieldId, startTime, endTime, date) {
    return this.callAPI('POST', '/venue/booking/orders/create', {
      bookings: [{
        venueId: CONFIG.venueId,
        fieldId,
        startTime,
        endTime,
        bookingDate: date,
      }],
      userId: CONFIG.userId,
      venueId: CONFIG.venueId,
      couponId: '',
    });
  }

  async close() {
    if (this.browser) {
      try { await this.browser.close(); } catch(e) {}
    }
  }
}

// ================= 主逻辑 =================
async function main() {
  const engine = new BookingEngine();

  try {
    // 1. 启动引擎
    const ok = await engine.start();
    if (!ok) {
      log('❌ 引擎启动失败');
      await engine.close();
      return;
    }

    // 2. 计算并等待目标时间
    const now = new Date();
    const target = new Date();
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);

    // 如果目标时间已过，设为明天
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    const wakeTime = target.getTime() - CONFIG.preWakeMs;
    if (now.getTime() < wakeTime) {
      const waitSec = Math.round((wakeTime - now.getTime()) / 1000);
      const mins = Math.floor(waitSec / 60);
      const secs = waitSec % 60;
      log(`⏳ 等待到 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2,'0')} (${mins}分${secs}秒后)`);
      await sleep(waitSec * 1000);
    }

    // 3. 精准等待到目标秒
    const exactTarget = target.getTime();
    while (Date.now() < exactTarget - 30) await sleep(10);
    while (Date.now() < exactTarget) { /* busy wait */ }

    log(`⚡⚡⚡ 猎杀时刻 ${new Date().toLocaleTimeString()} ⚡⚡⚡`);

    // 4. 执行抢场
    let booked = false;
    const today = new Date().toISOString().split('T')[0];

    // 4a. 首发狙击
    for (const wish of CONFIG.primaryWishes) {
      if (booked) break;

      log(`🔍 ${wish.name} ${wish.time}...`);
      const slots = await engine.getBookableTimes(wish.fieldId);

      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);

        if (ts) {
          log(`🎯 命中! ${wish.name} ${wish.time} ¥${ts.price || 15}`);
          const order = await engine.createOrder(wish.fieldId, wish.time, wish.timeEnd, today);
          if (order.success && order.code === 0) {
            log(`🎉🎉🎉 成功抢到 ${wish.name} ${wish.time}！`);
            log(`📋 订单号: ${order.data?.orderNo || '未知'}`);
            booked = true;
            break;
          } else {
            log(`⚠️ 下单失败: ${order.msg || order.error || '未知'}`);
          }
        } else {
          // 打印可用情况方便调试
          const avail = day?.timeSlots?.filter(s => s.bookable).map(s => `${s.startTime}-${s.endTime}`).join(', ');
          if (avail) log(`❌ ${wish.name} ${wish.time} 不可用 (可约: ${avail})`);
          else log(`❌ ${wish.name} ${wish.time} 不可用`);
        }
      } else {
        log(`⚠️ 查询失败: ${slots.msg || slots.error || '未知'}`);
      }
    }

    // 4b. 扫荡
    if (!booked) {
      log('♻️ 首发失利，开始扫荡...');
      for (const wish of CONFIG.fallbackWishes) {
        if (booked) break;

        const slots = await engine.getBookableTimes(wish.fieldId);
        if (slots.success && slots.code === 0 && slots.data) {
          const days = Array.isArray(slots.data) ? slots.data : [];
          const day = days.find(d => d.date === today) || days[0];
          if (day?.timeSlots) {
            for (const time of CONFIG.fallbackTimes) {
              const ts = day.timeSlots.find(s => s.startTime === time && s.bookable === true);
              if (ts) {
                const endTime = String(parseInt(time) + 1).padStart(2, '0') + ':00';
                log(`🎯 扫荡到 ${wish.name} ${time}!`);
                const order = await engine.createOrder(wish.fieldId, time, endTime, today);
                if (order.success && order.code === 0) {
                  log(`🎉 捡漏成功! ${wish.name} ${time}`);
                  booked = true;
                  break;
                }
                await sleep(50);
              }
            }
          }
        }
      }
    }

    if (booked) {
      log('🎊🎊🎊 任务完成！');
    } else {
      log('😢 所有场地已满，明天再来');
    }

  } catch (err) {
    log(`❌ 严重错误: ${err.message}`);
    console.error(err);
  }

  await engine.close();
}

if (require.main === module) {
  main();
}

module.exports = { BookingEngine, main };
