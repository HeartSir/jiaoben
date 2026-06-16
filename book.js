/**
 * 🏸 book.js - 川大场馆自动抢订引擎
 *
 * 从 config.json 读取配置
 * 支持多志愿优先级抢场
 * 可被 dashboard.js 调用并返回状态
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ========== 路径 ==========
const CONFIG_FILE = path.join(__dirname, 'config.json');
const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

// ========== 状态 ==========
let _statusCallback = null;
let _logs = [];
let _lastResult = null;

function log(msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const entry = { time, msg, ts: Date.now() };
  _logs.push(entry);
  if (_logs.length > 200) _logs.shift();
  console.log(`[${time}] ${msg}`);
  if (_statusCallback) _statusCallback(entry);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function setStatusCallback(cb) {
  _statusCallback = cb;
}

function getLogs() {
  return _logs;
}

function getResult() {
  return _lastResult;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch(e) { return null; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ========== 引擎 ==========
class BookingEngine {
  constructor() {
    this.browser = null;
    this.page = null;
    this.auth = null;
    this.config = null;
  }

  loadAuth() {
    if (!fs.existsSync(AUTH_FILE)) return false;
    this.auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    return true;
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

  getUserId() {
    for (const originUrl of ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn']) {
      const origin = this.auth?.origins?.find(o => o.origin === originUrl);
      const raw = origin?.localStorage?.find(l => l.name === 'userInfo')?.value;
      if (raw) {
        const info = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch(e) { return null; } })() : raw;
        if (info) {
          if (info.data?.userId) return info.data.userId;
          if (info.userId) return info.userId;
        }
      }
    }
    return null;
  }

  saveAuthToken(token, refreshToken) {
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
    fs.writeFileSync(AUTH_FILE, JSON.stringify(this.auth, null, 2));
  }

  async start() {
    this.config = loadConfig();
    log('🏸 抢场引擎启动...');

    if (!this.loadAuth()) {
      log('❌ 未找到登录态，请先扫码登录');
      return false;
    }

    const userId = this.getUserId();
    log(`👤 用户ID: ${userId || '?'}`);

    log('🚀 启动无头浏览器...');
    const launchOpts = {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-software-rasterizer'],
    };

    // Render 环境检测
    const cacheDir = '/opt/render/.cache/ms-playwright';
    if (fs.existsSync(cacheDir)) {
      const dirs = fs.readdirSync(cacheDir).sort().reverse();
      const full = dirs.find(d => d.startsWith('chromium-') && !d.includes('headless'));
      if (full) {
        const p = path.join(cacheDir, full, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) {
          launchOpts.executablePath = p;
          log(`📂 Chromium: ${full}`);
        }
      }
    }

    if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
      launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    }

    try {
      this.browser = await chromium.launch(launchOpts);
    } catch (err) {
      if ((err.message || '').includes('Executable') && (err.message || '').includes('exist')) {
        log('⚠️ 安装浏览器...');
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

    log('📡 加载 uni-app 环境...');
    await this.page.goto('https://cgzx.scu.edu.cn/venue/', {
      waitUntil: 'domcontentloaded', timeout: 30000
    }).catch(e => log(`⚠️ ${e.message}`));
    await sleep(4000);

    // 注入 token
    const token = this.getToken();
    const refreshToken = this.getRefreshToken();
    if (token) {
      await this.page.evaluate(({t, rt}) => {
        try {
          uni.setStorageSync('accessToken', t);
          if (rt) uni.setStorageSync('refreshToken', rt);
        } catch(e) {}
      }, {t: token, rt: refreshToken});
    }

    // 等 uni 就绪
    for (let i = 0; i < 10; i++) {
      const ready = await this.page.evaluate(() => {
        try { return typeof uni !== 'undefined' && !!uni.$u?.http; }
        catch(e) { return false; }
      }).catch(() => false);
      if (ready) break;
      await sleep(2000);
    }

    // 刷新 token
    await this.ensureTokenValid();

    const t = await this.getLiveToken();
    log(`🔑 Token: ${t ? '✅' : '❌'}`);
    return !!t;
  }

  async getLiveToken() {
    return await this.page.evaluate(() => {
      try { return uni.getStorageSync('accessToken') || ''; }
      catch(e) { return ''; }
    });
  }

  async ensureTokenValid() {
    const valid = await this.page.evaluate(async () => {
      try {
        const res = await uni.$u.http.get('/app-api/member/user/get');
        return res.code === 0;
      } catch(e) { return false; }
    }).catch(() => false);
    if (valid) { log('✅ Token 有效'); return true; }

    log('🔄 Token 过期，刷新...');
    const rt = this.getRefreshToken();
    if (!rt) { log('❌ 无 refreshToken'); return false; }

    const result = await this.page.evaluate(async (r) => {
      try {
        const res = await uni.$u.http.post('/app-api/member/auth/refresh-token', { refreshToken: r });
        if (res.code === 0 && res.data?.accessToken) {
          uni.setStorageSync('accessToken', res.data.accessToken);
          if (res.data.refreshToken) uni.setStorageSync('refreshToken', res.data.refreshToken);
          return { ok: true, token: res.data.accessToken, rt: res.data.refreshToken };
        }
        return { ok: false };
      } catch(e) { return { ok: false }; }
    }, rt);

    if (result.ok) {
      log('✅ Token 刷新成功');
      this.saveAuthToken(result.token, result.rt);
      return true;
    }
    log('❌ 刷新失败');
    return false;
  }

  async callAPI(method, apiPath, data) {
    return await this.page.evaluate(async ({method, path, data}) => {
      try {
        const http = uni.$u.http;
        let res = method === 'GET'
          ? await http.get(path)
          : await http.post(path, data || {});
        return { success: true, code: res.code, msg: res.msg, data: res.data };
      } catch(e) {
        return { success: false, code: e.code, msg: e.msg, data: e.data };
      }
    }, { method, path: '/app-api' + apiPath, data });
  }

  async getBookableTimes(fieldId) {
    return this.callAPI('GET', `/venue/field/get-bookable-times/${fieldId}`);
  }

  async createOrder(fieldId, startTime, endTime, date) {
    const cfg = this.config;
    return this.callAPI('POST', '/venue/booking/orders/create', {
      bookings: [{
        venueId: cfg.venueId,
        fieldId,
        startTime,
        endTime,
        bookingDate: date,
      }],
      userId: this.getUserId(),
      venueId: cfg.venueId,
      couponId: '',
    });
  }

  async close() {
    if (this.browser) try { await this.browser.close(); } catch(e) {}
  }
}

// ========== 主流程 ==========
async function main() {
  const engine = new BookingEngine();

  try {
    const ok = await engine.start();
    if (!ok) {
      log('❌ 引擎启动失败');
      await engine.close();
      return { success: false, reason: '引擎启动失败' };
    }

    const cfg = engine.config;
    if (!cfg) {
      log('❌ 未找到 config.json');
      await engine.close();
      return { success: false, reason: '无配置文件' };
    }

    const targetHour = cfg.targetHour ?? 8;
    const targetMinute = cfg.targetMinute ?? 30;
    const targetSecond = cfg.targetSecond ?? 0;
    const preWakeMs = cfg.preWakeMs ?? 120000;

    // 计算等待时间
    const now = new Date();
    const target = new Date();
    target.setHours(targetHour, targetMinute, targetSecond, 0);
    if (target <= now) target.setDate(target.getDate() + 1);

    const wakeTime = target.getTime() - preWakeMs;
    if (now.getTime() < wakeTime) {
      const sec = Math.round((wakeTime - now.getTime()) / 1000);
      log(`⏳ 等待到 ${targetHour}:${String(targetMinute).padStart(2,'0')} (${sec}秒后)`);
      await sleep(wakeTime - Date.now());
    }

    // 精准等待到目标秒
    const exact = target.getTime();
    while (Date.now() < exact - 30) await sleep(10);
    while (Date.now() < exact) { /* busy wait */ }

    log(`⚡⚡⚡ 猎杀时刻! ${new Date().toLocaleTimeString()} ⚡⚡⚡`);

    let booked = false;
    const today = new Date().toISOString().split('T')[0];

    // === 按优先级依次尝试值班 ===
    const wishes = (cfg.wishes || []).filter(w => w.enabled !== false);
    for (let i = 0; i < wishes.length; i++) {
      if (booked) break;
      const wish = wishes[i];
      log(`🎯 [第${i+1}志愿] ${wish.name} ${wish.time}-${wish.timeEnd}`);

      const slots = await engine.getBookableTimes(wish.fieldId);
      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
        if (ts) {
          log(`🎯 命中! ${wish.name} ${wish.time} ¥${ts.price || 15}`);
          const order = await engine.createOrder(wish.fieldId, wish.time, wish.timeEnd, today);
          if (order.success && order.code === 0) {
            log(`🎉🎉🎉 抢场成功! ${wish.name} ${wish.time}`);
            log(`📋 订单号: ${order.data?.orderNo || '未知'}`);
            booked = true;
            break;
          } else {
            log(`❌ 下单失败: ${order.msg || '未知'}`);
          }
        } else {
          const avail = day?.timeSlots?.filter(s => s.bookable).map(s => `${s.startTime}`).join(', ');
          log(`⏳ ${wish.name} ${wish.time} 不可用${avail ? ' (可约: ' + avail + ')' : ''}`);
        }
      } else {
        log(`⚠️ 查询失败: ${slots.msg || ''}`);
      }
    }

    // === 扫荡模式 ===
    if (!booked && cfg.fallbackEnabled !== false) {
      log('♻️ 进入扫荡模式...');
      for (const v of (cfg.fallbackVenues || [])) {
        if (booked) break;
        const slots = await engine.getBookableTimes(v.fieldId);
        if (slots.success && slots.code === 0 && slots.data) {
          const days = Array.isArray(slots.data) ? slots.data : [];
          const day = days.find(d => d.date === today) || days[0];
          if (day?.timeSlots) {
            for (const t of (cfg.fallbackTimes || [])) {
              if (booked) break;
              const ts = day.timeSlots.find(s => s.startTime === t.time && s.bookable === true);
              if (ts) {
                log(`🎯 扫荡到 ${v.name} ${t.time}!`);
                const order = await engine.createOrder(v.fieldId, t.time, t.timeEnd, today);
                if (order.success && order.code === 0) {
                  log(`🎉 捡漏成功! ${v.name} ${t.time}`);
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

    await engine.close();
    _lastResult = { success: booked, time: new Date().toLocaleString('zh-CN') };
    return _lastResult;

  } catch (err) {
    log(`❌ 错误: ${err.message}`);
    await engine.close();
    _lastResult = { success: false, error: err.message, time: new Date().toLocaleString('zh-CN') };
    return _lastResult;
  }
}

// ========== 导出 ==========
module.exports = { main, BookingEngine, loadConfig, saveConfig, setStatusCallback, getLogs, getResult };

// ========== CLI 直接运行 ==========
if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
