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
const BASE_DIR = (process.pkg ? path.dirname(process.execPath) : __dirname);
// 📌 持久数据目录
// Render 免费版不支持磁盘挂载，用 /tmp/venue-data（重启丢失）
// Render 付费版/Windows 开发环境用 BASE_DIR
const DATA_DIR = process.env.RENDER_DATA_DIR || (process.platform === 'linux' ? '/tmp/venue-data' : BASE_DIR);
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_FILE = path.join(DATA_DIR, '.venue-auth.json');

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
  // 优先从持久存储读取，没有则用部署包里的默认配置
  const files = [CONFIG_FILE, path.join(BASE_DIR, 'config.json')];
  for (const f of files) {
    if (fs.existsSync(f)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
        // 如果是从 BASE_DIR 读的而 CONFIG_FILE 不存在，复制一份到持久存储
        if (f !== CONFIG_FILE && !fs.existsSync(CONFIG_FILE)) {
          try {
            fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
          } catch(e) {}
        }
        return cfg;
      } catch(e) { return null; }
    }
  }
  return null;
}

function saveConfig(cfg) {
  try { fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); } catch(e) {}
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

  // 动态获取场馆下的所有场地 — 多种方式尝试
  async discoverFields(venueId) {
    // 方法1: 尝试直接 API 路径
    const patterns = [
      `/venue/field/list?venueId=${venueId}`,
      `/venue/field/list-by-venue-id/${venueId}`,
      `/venue/field/page?venueId=${venueId}&pageSize=100`,
      `/venue/field/list-all`,
      `/venue/venue-field/list-by-venue?venueId=${venueId}`,
      `/venue/venue/${venueId}/fields`,
      `/venue/venue/${venueId}`,
      `/venue/field/get-bookable-times?venueId=${venueId}`,
    ];
    for (const path of patterns) {
      try {
        const result = await this.callAPI('GET', path);
        if (result.success && result.code === 0 && result.data) {
          const raw = Array.isArray(result.data)
            ? result.data
            : result.data.records || result.data.list || result.data.items || [];
          if (raw.length > 0) {
            const fields = raw.map(f => ({
              id: f.id,
              name: f.name || `场地 #${f.id}`,
            }));
            log(`📋 API 获取到 ${fields.length} 个场地`);
            return fields;
          }
        }
      } catch (e) { /* 试下一个 */ }
    }

    // 方法2: 用 uni.request 直接调用（绕开 uni.$u.http 的拦截器）
    try {
      log(`📡 尝试 uni.request 直达...`);
      const result = await this.page.evaluate(async (vid) => {
        async function tryUni(path) {
          try {
            return await new Promise((resolve, reject) => {
              uni.request({ url: '/app-api' + path, method: 'GET', success: resolve, fail: reject });
            });
          } catch(e) { return null; }
        }
        const paths = [
          `/venue/field/list?venueId=${vid}`,
          `/venue/field/list-by-venue-id/${vid}`,
          `/venue/field/page?venueId=${vid}&pageSize=100`,
        ];
        for (const p of paths) {
          const res = await tryUni(p);
          if (res?.data?.code === 0 && res.data.data) {
            const raw = Array.isArray(res.data.data) ? res.data.data
              : res.data.data.records || res.data.data.list || [];
            if (raw.length > 0) {
              return raw.map(f => ({ id: f.id, name: f.name || `场地 #${f.id}` }));
            }
          }
        }
        return null;
      }, venueId);
      if (result && result.length > 0) {
        log(`📋 uni.request 获取到 ${result.length} 个场地`);
        return result;
      }
    } catch(e) { log(`⚠️ uni.request 失败: ${e.message}`); }

    // 方法3: 导航到场馆页面，读取 Vue 组件的响应式数据
    try {
      log(`🌐 尝试从页面提取 uni-app 组件数据...`);
      await this.page.goto('https://cgzx.scu.edu.cn/venue/', {
        waitUntil: 'domcontentloaded', timeout: 15000,
      }).catch(() => {});

      // 等 uni-app 就绪
      for (let i = 0; i < 15; i++) {
        const ready = await this.page.evaluate(() => {
          try { return typeof uni !== 'undefined' && !!uni.getStorageSync; } catch(e) { return false; }
        }).catch(() => false);
        if (ready) break;
        await sleep(1000);
      }

      // 注入 token
      const token = this.getToken();
      if (token) {
        await this.page.evaluate(t => {
          try { uni.setStorageSync('accessToken', t); } catch(e) {}
        }, token);
      }

      await sleep(2000);

      // 遍历页面上的所有 Vue 实例，找场地列表
      const fields = await this.page.evaluate((vid) => {
        const results = [];
        const seen = new Set();

        function tryExtract(obj, depth = 0) {
          if (depth > 4 || !obj || seen.size > 200) return;
          try {
            // 如果这个对象看起来像场地列表（有 fieldId 或 id + 中文名）
            if (Array.isArray(obj) && obj.length > 0 && obj.length < 100) {
              for (const item of obj) {
                if (item && (item.id || item.fieldId) && (item.name || item.fieldName)) {
                  const id = item.id || item.fieldId;
                  if (!seen.has(id)) {
                    seen.add(id);
                    results.push({ id, name: item.name || item.fieldName });
                  }
                }
              }
              if (results.length > 2) return; // 找到了就停止深入
            }
            // 递归遍历对象属性
            if (typeof obj === 'object' && obj !== null) {
              for (const key of Object.keys(obj)) {
                if (key.startsWith('_') || key === 'constructor' || key === 'prototype') continue;
                try { tryExtract(obj[key], depth + 1); } catch(e) {}
                if (results.length > 20) return;
              }
            }
          } catch(e) {}
        }

        // 从各个可能的入口遍历
        const roots = [
          document.querySelector('#app')?.__vue__,
          document.querySelector('#app')?.__vue_app__,
          document.querySelector('.uni-app')?.__vue__,
          window.__vue__,
        ];
        for (const root of roots) {
          tryExtract(root);
        }

        // 去重按 id
        const dedup = new Map();
        results.forEach(r => { if (!dedup.has(r.id)) dedup.set(r.id, r); });
        return Array.from(dedup.values());
      }, venueId);

      if (fields && fields.length > 0) {
        log(`📋 从页面提取到 ${fields.length} 个场地`);
        return fields;
      }
    } catch(e) {
      log(`⚠️ 页面提取失败: ${e.message}`);
    }

    log(`⚠️ 所有方式均无法获取场馆 #${venueId} 的场地列表`);
    return null;
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

// ========== 场馆-场地映射（用于扫描功能） ==========
const VENUE_FIELDS = {
  1: [ // 望江体育馆二楼羽毛球场
    { id: 36, name: '1号场' }, { id: 37, name: '2号场' }, { id: 38, name: '3号场' },
    { id: 39, name: '4号场' }, { id: 40, name: '5号场' }, { id: 41, name: '6号场' },
    { id: 42, name: '7号场' }, { id: 43, name: '8号场' }, { id: 44, name: '9号场' },
    { id: 45, name: '10号场' },
  ],
  9: [ // 华西体育馆羽毛球场
    { id: 1, name: '1号场' }, { id: 2, name: '2号场' }, { id: 3, name: '3号场' },
    { id: 4, name: '4号场' }, { id: 5, name: '5号场' }, { id: 6, name: '6号场' },
  ],
  4: [ // 望江体育馆一楼羽毛球场
    { id: 46, name: '1号场' }, { id: 47, name: '2号场' }, { id: 48, name: '3号场' },
    { id: 49, name: '4号场' }, { id: 50, name: '5号场' }, { id: 51, name: '6号场' },
    { id: 52, name: '7号场' },
  ],
};

function getFieldsForVenue(venueId) {
  return VENUE_FIELDS[venueId] || [];
}

function getVenueName(venueId) {
  const names = {
    1: '望江体育馆二楼羽毛球场',
    9: '华西体育馆羽毛球场',
    4: '望江体育馆一楼羽毛球场',
    19: '江安体育馆羽毛球场',
    22: '江安南区网球场',
    18: '江安网球场',
    12: '华西网球馆',
    10: '华西网球场',
    5: '望江体育馆乒乓球馆',
    3: '望江红土网球场',
    2: '望江西区网球场',
  };
  return names[venueId] || `场馆 #${venueId}`;
}

function computeEndTime(startTime) {
  const h = parseInt(startTime) + 1;
  return String(Math.min(h, 22)).padStart(2, '0') + ':00';
}

// ========== 面板持久引擎（扫描/一键预约） ==========
// 独立于 main() 的调度引擎，面板通过它实时查询和预约
let _panelEngine = null;
let _panelEnginePromise = null;

async function _ensurePanelEngine() {
  // 🔑 如果引擎正在启动中，等待它完成而不是直接返回 false
  if (_panelEnginePromise) {
    log('⏳ 面板引擎正在启动，等待中...');
    return await _panelEnginePromise;
  }

  // 检查已有引擎是否还活着
  if (_panelEngine && _panelEngine.page) {
    try {
      const alive = await _panelEngine.page.evaluate(() => true).catch(() => false);
      if (alive && !_panelEngine.page.isClosed()) return true;
    } catch (e) {
      log('面板引擎已断开，重建中...');
    }
    await _panelEngine.close().catch(() => {});
    _panelEngine = null;
  }

  // 启动新引擎（后续调用者会自动等待这个 Promise）
  _panelEnginePromise = (async () => {
    try {
      log('🔄 启动面板引擎...');
      _panelEngine = new BookingEngine();
      const ok = await _panelEngine.start();
      if (ok) log('✅ 面板引擎就绪');
      else log('❌ 面板引擎启动失败');
      return ok;
    } finally {
      _panelEnginePromise = null;
    }
  })();

  return await _panelEnginePromise;
}

async function scanAvailableSlots() {
  // 确保引擎运行中
  if (!_panelEngine || !_panelEngine.page) {
    const ok = await _ensurePanelEngine();
    if (!ok) return { success: false, error: '引擎启动失败，请先扫码登录' };
  }

  // 重新加载最新配置
  const cfg = loadConfig();
  if (!cfg) return { success: false, error: '未找到配置' };

  const venueId = cfg.venueId || 1;
  const today = new Date().toISOString().split('T')[0];

  // 获取场地列表（硬编码优先，动态提取兜底）
  let fields = getFieldsForVenue(venueId);
  if (!fields || fields.length === 0) {
    log(`📡 未找到场馆 #${venueId} 的硬编码场地，尝试去页面提取...`);
    fields = await discoverVenueFields(venueId);
  }
  if (!fields || fields.length === 0) {
    return { success: false, error: '未能获取该场馆的场地列表，该场馆暂不支持扫描功能' };
  }

  const slots = [];

  log(`📡 开始扫描 ${fields.length} 个场地...`);
  for (const field of fields) {
    try {
      const result = await _panelEngine.getBookableTimes(field.id);
      if (result.success && result.code === 0 && result.data) {
        const days = Array.isArray(result.data) ? result.data : [];
        const day = days.find(d => d.date === today) || days[0];
        if (day?.timeSlots) {
          for (const ts of day.timeSlots) {
            if (ts.bookable === true) {
              slots.push({
                fieldId: field.id,
                fieldName: field.name,
                startTime: ts.startTime,
                endTime: ts.endTime || computeEndTime(ts.startTime),
                price: ts.price || 15,
              });
            }
          }
        }
      }
    } catch (e) {
      log(`⚠️ 查询 ${field.name} 失败: ${e.message}`);
    }
    await sleep(50);
  }

  log(`📊 扫描完成，共 ${slots.length} 个可用时段`);
  return { success: true, slots, venueId, venueName: getVenueName(venueId) };
}

async function discoverVenueFields(venueId) {
  // 先查硬编码表
  const hardcoded = getFieldsForVenue(venueId);
  if (hardcoded.length > 0) return hardcoded;

  // 用面板引擎去学校页面提取（前提：已登录）
  if (_panelEngine && _panelEngine.page) {
    try {
      const discovered = await _panelEngine.discoverFields(venueId);
      if (discovered && discovered.length > 0) return discovered;
    } catch (e) {
      log(`⚠️ 动态获取场地失败: ${e.message}`);
    }
  }

  // 先尝试启动引擎
  const ok = await _ensurePanelEngine();
  if (ok && _panelEngine?.page) {
    try {
      const discovered = await _panelEngine.discoverFields(venueId);
      if (discovered && discovered.length > 0) return discovered;
    } catch (e) {
      log(`⚠️ 动态获取场地失败: ${e.message}`);
    }
  }

  // 都失败了，返回空（用户需要先登录，或该场馆暂时不支持）
  log(`⚠️ 无法获取场馆 #${venueId} 的场地列表`);
  return [];
}

async function quickBookSlot(fieldId, fieldName, startTime, endTime) {
  if (!_panelEngine || !_panelEngine.page) {
    const ok = await _ensurePanelEngine();
    if (!ok) return { success: false, error: '引擎未就绪，请先扫码登录' };
  }

  const today = new Date().toISOString().split('T')[0];
  log(`📋 快速预约 ${fieldName} ${startTime}-${endTime}...`);
  const result = await _panelEngine.createOrder(fieldId, startTime, endTime, today);

  if (result.success && result.code === 0) {
    const orderNo = result.data?.orderNo || '未知';
    log(`🎉 预约成功! ${fieldName} ${startTime} 订单: ${orderNo}`);
    return { success: true, orderNo };
  } else {
    log(`❌ 预约失败: ${result.msg || '未知错误'}`);
    return { success: false, error: result.msg || '预约失败' };
  }
}

async function stopEngine() {
  if (_panelEngine) {
    log('🛑 关闭面板引擎');
    await _panelEngine.close().catch(() => {});
    _panelEngine = null;
  }
}

// ========== 导出 ==========
module.exports = {
  main, BookingEngine,
  loadConfig, saveConfig, setStatusCallback, getLogs, getResult,
  scanAvailableSlots, quickBookSlot, stopEngine,
  discoverVenueFields, getFieldsForVenue, VENUE_FIELDS,
  ensurePanelEngine: _ensurePanelEngine,
};

// ========== CLI 直接运行 ==========
if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
