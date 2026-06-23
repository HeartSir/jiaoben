/**
 * 🏸 book.js - 川大场馆自动抢订引擎
 *
 * 从 config.json 读取配置
 * 支持多志愿优先级抢场
 * 可被 dashboard.js 调用并返回状态
 */

const { chromium } = require('playwright');
const axios = require('axios');
const { sm3 } = require('sm-crypto');
const sm4 = require('sm-crypto').sm4;
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ========== SM2 直连加密（替代浏览器引擎） ==========
const { encrypt: sm2Encrypt, decrypt: sm2Decrypt } = require('./api-crypto');

// ========== 路径 ==========
const BASE_DIR = (process.pkg ? path.dirname(process.execPath) : __dirname);
// 📌 持久数据目录
// Render 免费版不支持磁盘挂载，用 /tmp/venue-data（重启丢失）
// Render 付费版/Windows 开发环境用 BASE_DIR
const DATA_DIR = process.env.RENDER_DATA_DIR || (process.platform === 'linux' ? '/tmp/venue-data' : BASE_DIR);
// 多用户数据目录
const USERS_DIR = path.join(DATA_DIR, 'users');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const AUTH_FILE = path.join(DATA_DIR, '.venue-auth.json');

// ========== 多用户上下文 ==========
let _currentUserId = null;

function setCurrentUser(userId) { _currentUserId = userId || null; }
function getCurrentUser() { return _currentUserId; }

function getUserDir(userId) {
  const dir = path.join(USERS_DIR, String(userId));
  try { fs.mkdirSync(dir, { recursive: true }); } catch(e) {}
  return dir;
}

function _getAuthFile(userId) {
  if (!userId) return AUTH_FILE;
  return path.join(getUserDir(userId), 'auth.json');
}

function _getConfigFile(userId) {
  if (!userId) return CONFIG_FILE;
  return path.join(getUserDir(userId), 'config.json');
}

// 列出所有用户
function listUsers() {
  try {
    if (!fs.existsSync(USERS_DIR)) return [];
    return fs.readdirSync(USERS_DIR).filter(f => {
      const p = path.join(USERS_DIR, f);
      if (!fs.statSync(p).isDirectory()) return false;
      // 有任意用户文件即视为有效用户（admin 新建的可能只有 priority.json）
      return fs.existsSync(path.join(p, 'auth.json'))
        || fs.existsSync(path.join(p, 'config.json'))
        || fs.existsSync(path.join(p, 'priority.json'));
    });
  } catch(e) { return []; }
}

// ========== 优先级 ==========
function readPriority(userId) {
  try {
    const f = path.join(getUserDir(userId), 'priority.json');
    if (fs.existsSync(f)) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (typeof data.priority === 'number') return data.priority;
    }
  } catch (e) { /* ignore */ }
  return 100; // 默认最低优先级
}

function savePriority(userId, priority) {
  const dir = getUserDir(userId);
  fs.writeFileSync(path.join(dir, 'priority.json'), JSON.stringify({ priority }, null, 2));
}

function loadPriorities() {
  const users = listUsers();
  const map = {};
  for (const uid of users) {
    map[uid] = readPriority(uid);
  }
  return map;
}

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

// ========== 计时日志（用于分析最佳抢场时机） ==========
let _timing = null;
const TIMING_DIR = process.platform === 'linux' ? '/var/log/venue-timing' : path.join(DATA_DIR, 'timing');

function _timingReset(userId, mode) {
  _timing = {
    runId: `${mode}_${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 21)}`,
    userId, mode,
    date: new Date().toISOString().split('T')[0],
    targetTime: null,
    startedAt: new Date().toISOString(),
    preScan: { tokenRefreshed: false, tokenRefreshMs: 0, syncFallback: false },
    fire: { intended: null, actual: null, offsetMs: null },
    scan: { startMs: 0, durationMs: 0, fieldCount: 0, hits: 0, perField: [] },
    order: { startMs: 0, durationMs: 0, count: 0, results: [] },
    monitor: null,
    fallback: null,
    result: { success: false, totalDurationMs: 0, bookedField: null },
    serverTime: null,
  };
}

function _timingFlush() {
  if (!_timing) return;
  try {
    if (!fs.existsSync(TIMING_DIR)) fs.mkdirSync(TIMING_DIR, { recursive: true });
    const file = path.join(TIMING_DIR, _timing.date + '.jsonl');
    fs.appendFileSync(file, JSON.stringify(_timing) + '\n');
  } catch(e) {
    // 写文件失败不阻断抢场
    console.error('[timing] write failed:', e.message);
  }
  _timing = null;
}

function _timingScanField(fieldId, venueId, durationMs, available, error) {
  if (!_timing) return;
  _timing.scan.perField.push({ fieldId, venueId, durationMs, available: !!available, error: error || null });
}

function _timingOrderResult(fieldId, venueId, success, code, msg, orderNo) {
  if (!_timing) return;
  _timing.order.results.push({ fieldId, venueId, success: !!success, code: code ?? -1, msg: msg || '', orderNo: orderNo || null });
}

function _timingSetServerTime(ts) {
  if (!_timing || !ts) return;
  _timing.serverTime = ts;
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

function loadConfig(userId) {
  const uid = userId || getCurrentUser();
  const userCfg = uid ? _getConfigFile(uid) : null;
  const files = [userCfg, CONFIG_FILE, path.join(BASE_DIR, 'config.json')].filter(Boolean);
  for (const f of files) {
    if (fs.existsSync(f)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));
        // 如果是共享配置但用户还没有自己的，复制一份
        if (uid && f !== userCfg && !fs.existsSync(userCfg)) {
          try {
            getUserDir(uid);
            fs.writeFileSync(userCfg, JSON.stringify(cfg, null, 2));
          } catch(e) {}
        }
        return cfg;
      } catch(e) { return null; }
    }
  }
  return null;
}

function saveConfig(cfg, userId) {
  const uid = userId || getCurrentUser();
  const file = uid ? _getConfigFile(uid) : CONFIG_FILE;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch(e) {}
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

// ========== 直接 API 调用（省内存，不需要浏览器） ==========
// Render 512MB 跑不动 Chromium，直接用 JWT Token 调学校 API
// 也适用于所有环境——比浏览器更快更稳

function _readAuthFile(userId) {
  const uid = userId || getCurrentUser();
  const file = _getAuthFile(uid);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { return null; }
}

function _writeAuthFile(auth, userId) {
  const uid = userId || getCurrentUser();
  const file = _getAuthFile(uid);
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch(e) {}
  fs.writeFileSync(file, JSON.stringify(auth, null, 2));
}

function readToken(userId) {
  const auth = _readAuthFile(userId);
  if (!auth) return null;
  for (const originUrl of ['https://cgzx.scu.edu.cn', 'http://cgzx.scu.edu.cn']) {
    const o = auth.origins?.find(x => x.origin === originUrl);
    const token = o?.localStorage?.find(l => l.name === 'accessToken')?.value;
    if (token) return token;
  }
  return null;
}

function readRefreshToken(userId) {
  const auth = _readAuthFile(userId);
  if (!auth) return null;
  for (const originUrl of ['https://cgzx.scu.edu.cn', 'http://cgzx.scu.edu.cn']) {
    const o = auth.origins?.find(x => x.origin === originUrl);
    const rt = o?.localStorage?.find(l => l.name === 'refreshToken')?.value;
    if (rt) return rt;
  }
  return null;
}

function saveToken(token, refreshToken, userId) {
  let auth = _readAuthFile(userId);
  if (!auth) auth = { cookies: [], origins: [] };
  auth.savedAt = Date.now();   // 记录 token 设置时间
  auth.verified = false;       // 新 token 需重新验证
  for (const originUrl of ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn']) {
    let origin = auth.origins?.find(o => o.origin === originUrl);
    if (!origin) {
      if (!auth.origins) auth.origins = [];
      origin = { origin: originUrl, localStorage: [] };
      auth.origins.push(origin);
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
  _writeAuthFile(auth, userId);
}

// 保存完整 auth（含 userInfo）
function saveFullAuth(authData, userId) {
  authData.savedAt = Date.now();   // 记录 token 设置时间
  authData.verified = false;       // 新 token 需重新验证
  _writeAuthFile(authData, userId);
}

// === SM 加密辅助函数 ===
// 学校 uni-app 使用 SM 国密加密通信，纯 Bearer token 会被 401 拒绝
// 这里尝试多种 SM3 签名和 SM4 加密方案

function smSign(method, apiPath, body, timestamp) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const pathLower = apiPath.toLowerCase();
  // 尝试多种常见签名格式
  const signCandidates = [
    sm3(timestamp + pathLower + bodyStr),
    sm3(pathLower + bodyStr + timestamp),
    sm3(bodyStr + timestamp),
    sm3(timestamp + bodyStr),
    sm3(method + pathLower + timestamp),
  ];
  return signCandidates;
}

function sm4EncryptBody(body) {
  // 尝试常用 SM4 密钥（部分学校使用固定密钥）
  // 川大 uni-app 常见的几个默认密钥
  const commonKeys = [
    'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6',
    '1234567890abcdef1234567890abcdef',
    '00000000000000000000000000000000',
    'cgzxscuvenuekey2024abcdef123456',
  ];
  const bodyStr = JSON.stringify(body);
  for (const key of commonKeys) {
    try {
      const encrypted = sm4.encrypt(bodyStr, key);
      return { encrypted, key };
    } catch(e) { continue; }
  }
  return null;
}

// 尝试多种鉴权头格式（含 SM3 签名）
function makeAuthHeaders(token, method, apiPath, data) {
  const timestamp = Date.now().toString();
  const signatures = smSign(method, apiPath, data, timestamp);

  const formats = [
    // Bearer + SM3 签名（多种格式）
    ...signatures.map((sign, i) => ({
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'timestamp': timestamp,
      'sign': sign,
      'sign-type': `v${i+1}`,
    })),
    // Bearer + SM3 签名（其他头部名）
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Sign': signatures[0], 'timestamp': timestamp },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'signature': signatures[0], 't': timestamp },
    // 无 SM3 但尝试不同鉴权头
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    { 'Authorization': token, 'Content-Type': 'application/json' },
    { 'x-access-token': token, 'Content-Type': 'application/json' },
    { 'Ticket': token, 'Content-Type': 'application/json' },
    { 'token': token, 'Content-Type': 'application/json' },
    { 'accessToken': token, 'Content-Type': 'application/json' },
  ];

  return formats;
}

async function callDirectAPI(method, apiPath, data, userId) {
  const token = readToken(userId);
  if (!token) return { success: false, code: -1, msg: '未登录', data: null };

  const isGet = method === 'GET';
  const bodyData = isGet ? undefined : data;

  // 尝试多种鉴权 + 加密方案
  let headers = makeAuthHeaders(token, method, apiPath, bodyData);
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    for (const h of headers) {
      try {
        let reqData = bodyData;
        let reqHeaders = { ...h };

        // 第二次尝试：用 SM4 加密 body
        if (attempt === 1 && !isGet && bodyData) {
          const enc = sm4EncryptBody(bodyData);
          if (enc) {
            reqData = enc.encrypted;
            reqHeaders['Content-Type'] = 'text/plain';
            reqHeaders['X-Encrypted'] = 'sm4';
            reqHeaders['X-Key'] = enc.key.substring(0, 8);
          }
        }

        const res = await axios({
          method,
          url: `https://cgzx.scu.edu.cn/app-api${apiPath}`,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            'Referer': 'https://cgzx.scu.edu.cn/',
            'Origin': 'https://cgzx.scu.edu.cn',
            ...reqHeaders,
          },
          data: reqData,
          timeout: 30000,
          validateStatus: () => true,
        });

        const body = res.data;
        // 非 JSON 响应（HTML 等）→ 鉴权失败或网关拒绝
        if (!body || typeof body !== 'object') {
          lastErr = { success: false, code: res.status || -1, msg: '服务器返回非 JSON（网关拒绝或 token 无效）', data: null };
          continue;
        }
        // 鉴权失败，试下一种格式
        if (res.status === 401 || body.code === 401 || body.msg?.includes('未登录') || body.msg?.includes('token')) {
          lastErr = { success: false, code: 401, msg: body.msg || '鉴权失败', data: null };
          continue;
        }
        return { success: true, code: body.code ?? 0, msg: body.msg || '', data: body.data };
      } catch (err) {
        lastErr = { success: false, code: -1, msg: err.code === 'ECONNABORTED' ? '请求超时' : err.message, data: null };
      }
    }
  }
  return lastErr;
}

async function directRefreshToken(userId) {
  const rt = readRefreshToken(userId);
  if (!rt) return false;
  const result = await callDirectAPI("POST", "/member/auth/refresh-token", { refreshToken: rt }, userId);
  if (result.success && result.code === 0 && result.data?.accessToken) {
    log('✅ Token 已刷新');
    saveToken(result.data.accessToken, result.data.refreshToken, userId);
    return true;
  }
  return false;
}

async function directGetBookableTimes(fieldId, userId) {
  return callDirectAPI('GET', `/venue/field/get-bookable-times/${fieldId}`, undefined, userId);
}

async function directGetUserId(userId) {
  // 方法1: 从保存的 userInfo 读取
  try {
    const auth = _readAuthFile(userId);
    if (auth) {
      for (const originUrl of ['http://cgzx.scu.edu.cn', 'https://cgzx.scu.edu.cn']) {
        const origin = auth.origins?.find(o => o.origin === originUrl);
        const raw = origin?.localStorage?.find(l => l.name === 'userInfo')?.value;
        if (raw) {
          const info = typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch(e) { return null; } })() : raw;
          if (info) {
            if (info.data?.userId) return info.data.userId;
            if (info.userId) return info.userId;
          }
        }
      }
    }
  } catch(e) {}

  // 方法2: 从 JWT payload 提取
  try {
    const token = readToken(userId);
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) {
      log(`⚠️ Token 格式异常（不是 JWT）`);
      return null;
    }
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    log(`🔍 JWT payload 字段: ${Object.keys(payload).join(', ')}`);
    // 常见字段名：userId, id, sub, user_id
    return payload.userId || payload.id || payload.sub || payload.user_id || null;
  } catch(e) {
    log(`⚠️ JWT 解析失败: ${e.message}`);
  }

  return null;
}

function isTokenExpired(userId) {
  const token = readToken(userId);
  if (!token) return true;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return payload.exp ? payload.exp * 1000 < Date.now() : false;
  } catch(e) { return false; }
}

// Token 验证状态缓存（每个用户独立）
const _tokenCheckCaches = new Map(); // userId -> { ts, valid, verified, msg }
const TOKEN_CHECK_INTERVAL = 30000;
function _getCache(uid) { if (!_tokenCheckCaches.has(uid)) _tokenCheckCaches.set(uid, { ts: 0, valid: false, verified: false, msg: '' }); return _tokenCheckCaches.get(uid); } // 30 秒缓存

// 读取 auth 元信息（savedAt, verified）
function _readAuthMeta(userId) {
  try {
    const authFile = _getAuthFile(userId || getCurrentUser());
    if (fs.existsSync(authFile)) {
      const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      return { savedAt: auth.savedAt || 0, verified: auth.verified || false };
    }
  } catch(e) {}
  return { savedAt: 0, verified: false };
}

// 写入 auth 元信息
function _writeAuthMeta(key, value, userId) {
  try {
    const authFile = _getAuthFile(userId || getCurrentUser());
    if (!fs.existsSync(authFile)) return;
    const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    auth[key] = value;
    fs.writeFileSync(authFile, JSON.stringify(auth, null, 2));
  } catch(e) {}
}

// 标记 token 已被真实 API 调用验证通过
function markTokenVerified(userId) {
  const uid = userId || getCurrentUser();
  _writeAuthMeta('verified', true, uid);
  _writeAuthMeta('lastVerified', Date.now(), uid);
  const cache = _getCache(uid);
  cache.ts = Date.now(); cache.valid = true; cache.verified = true; cache.msg = 'Token 有效（已验证）';
}

// 轻量检查 token 状态（不发 API，只读本地信息）
function checkTokenValid(userId) {
  const uid = userId || getCurrentUser();
  const token = readToken(uid);
  const now = Date.now();
  const cache = _getCache(uid);

  if (!token) {
    cache.ts = now; cache.valid = false; cache.verified = false; cache.msg = '未设置 Token';
    return { valid: false, verified: false, msg: '未设置 Token' };
  }

  // 短时间内用缓存（per-user）
  if (now - cache.ts < TOKEN_CHECK_INTERVAL) {
    return { valid: cache.valid, verified: cache.verified, msg: cache.msg };
  }

  const meta = _readAuthMeta(uid);
  const ageHours = meta.savedAt ? Math.floor((now - meta.savedAt) / 3600000) : null;
  const ageStr = ageHours !== null ? `（${ageHours}h 前设置）` : '';

  // 超过 24 小时 → 提示可能过期
  if (ageHours !== null && ageHours > 24) {
    cache.ts = now; cache.valid = false; cache.verified = meta.verified; cache.msg = `可能已过期 ${ageStr}`;
    return { valid: false, verified: meta.verified, msg: `Token 可能已过期 ${ageStr}` };
  }

  // 未超过 24h + 已验证 → 有效
  if (meta.verified) {
    cache.ts = now; cache.valid = true; cache.verified = true; cache.msg = `Token 有效 ${ageStr}`;
    return { valid: true, verified: true, msg: `Token 有效 ${ageStr}` };
  }

  // 未超过 24h + 未验证 → 待验证
  cache.ts = now; cache.valid = true; cache.verified = false; cache.msg = `Token 未验证 ${ageStr}`;
  return { valid: true, verified: false, msg: `Token 未验证 ${ageStr}` };
}

// 主动验证 token：发一次真实 API 请求看是否被拒绝
async function verifyTokenNow(userId) {
  const uid = userId || getCurrentUser();
  const token = readToken(uid);
  if (!token) return { valid: false, verified: false, msg: '未设置 Token' };

  const now = Date.now();
  const cache = _getCache(uid);
  try {
    // 用直连 API 验证；注意校外 IP 可能被学校拒绝（"未授权的访问"≠token 无效）
    const result = await callDirectAPI('GET', '/member/user/get', undefined, uid);

    // 🔑 网络受限 / IP 被拒 → 不改变已验证状态
    const blockedMsgs = ['非 JSON', '网关', '未授权的访问', '403', 'Forbidden', '无权', 'IP'];
    const isNetworkBlocked = (
      (!result.success && (
        result.msg?.includes('非 JSON') ||
        result.msg?.includes('网关') ||
        blockedMsgs.some(k => result.msg?.includes(k)) ||
        result.code === -1
      )) ||
      (result.success && result.msg && blockedMsgs.some(k => result.msg.includes(k)))
    );
    if (isNetworkBlocked) {
      const meta = _readAuthMeta(uid);
      // 如果从未验证过，默认信任（用户刚从学校网页拿的 token 大概率有效）
      const trust = meta.verified || (meta.savedAt && (now - meta.savedAt < 3600000));
      cache.ts = now;
      cache.valid = trust;
      cache.verified = meta.verified;
      cache.msg = '校外网络受限';
      return { valid: trust, verified: meta.verified, msg: '🌐 校外网络受限（' + (trust ? '信任' : '待验证') + '）' };
    }

    // 请求失败（其他原因）
    if (!result.success) {
      _writeAuthMeta('verified', false, uid);
      cache.ts = now; cache.valid = false; cache.verified = false; cache.msg = 'Token 无效';
      return { valid: false, verified: false, msg: 'Token 无效：' + (result.msg || 'API 拒绝') };
    }

    // 明确鉴权失败（token 确实过期/无效）
    if (result.code === 401 || (result.msg && (result.msg.includes('未登录') || result.msg.includes('过期') || result.msg.includes('失效')))) {
      _writeAuthMeta('verified', false, uid);
      cache.ts = now; cache.valid = false; cache.verified = false; cache.msg = 'Token 无效或已过期';
      return { valid: false, verified: false, msg: '❌ Token 无效（API 拒绝）' };
    }

    // API 返回正常且有用户数据 → 标记已验证
    if (result.code === 0 && result.data) {
      markTokenVerified(uid);
      const meta = _readAuthMeta(uid);
      const ageHours = meta.savedAt ? Math.floor((now - meta.savedAt) / 3600000) : null;
      const ageStr = ageHours !== null ? `（${ageHours}h 前设置）` : '';
      return { valid: true, verified: true, msg: `✅ Token 有效 ${ageStr}` };
    }

    // API 返回异常但不确定原因 → 保守处理
    const meta2 = _readAuthMeta(uid);
    cache.ts = now;
    cache.valid = meta2.verified;
    cache.verified = meta2.verified;
    cache.msg = '验证状态未知';
    return { valid: meta2.verified, verified: meta2.verified, msg: '⚠️ 验证状态未知：' + (result.msg || '接口返回异常') };
  } catch (e) {
    // 网络错误 → 无法判断，不改变验证状态
    const meta = _readAuthMeta(uid);
    return { valid: meta.verified, verified: meta.verified, msg: '无法验证（网络异常）：' + e.message };
  }
}

// ========== SM2 直连 API（纯 Node.js，无需浏览器，~150ms/请求） ==========

function _sm2GetToken() {
  const uid = getCurrentUser();
  if (!uid) return null;
  // 优先读 per-user token，不存在则回退到共享 token（兼容 login.js 旧方式）
  return readToken(uid) || readToken();
}

// SM2 直连刷新 token（纯 Node.js，不依赖浏览器）
async function _sm2RefreshToken() {
  const uid = getCurrentUser();
  if (!uid) return false;
  const rt = readRefreshToken(uid) || readRefreshToken();
  if (!rt) { log('⚠️ 无 refreshToken，无法刷新'); return false; }
  try {
    const r = await sm2CallApi('POST', '/member/auth/refresh-token', { refreshToken: rt });
    if (r && r.code === 0 && r.data?.accessToken) {
      saveToken(r.data.accessToken, r.data.refreshToken || null, uid);
      log('🔑 Token 已刷新（SM2 直连）');
      return true;
    }
    log(`⚠️ SM2 token 刷新失败: code=${r?.code} msg=${r?.msg}`);
  } catch (e) {
    log(`⚠️ SM2 token 刷新异常: ${e.message}`);
  }
  return false;
}

// 从浏览器引擎同步最新 token 到 auth.json
async function _syncTokenFromBrowser() {
  if (!_panelEngine || !_panelEngine.page || _panelEngine.page.isClosed()) return false;
  try {
    const storage = await _panelEngine.page.evaluate(() => {
      const items = {};
      ['accessToken', 'refreshToken', 'userInfo'].forEach(k => {
        try { items[k] = uni.getStorageSync(k); } catch(e) { items[k] = null; }
      });
      return items;
    });
    if (storage.accessToken) {
      const uid = getCurrentUser();
      if (uid) {
        saveToken(storage.accessToken, storage.refreshToken || null, uid);
        log('🔄 Token 已从浏览器同步');
        return true;
      }
    }
  } catch(e) {}
  return false;
}

// 单次 API 调用（优先 HTTPS，兼容 HTTP）
function sm2CallApi(method, apiPath, data, accessToken) {
  const token = accessToken || _sm2GetToken();
  if (!token) return Promise.reject(new Error('no_token'));
  const _call = (useHttps) => new Promise((resolve, reject) => {
    const enc = sm2Encrypt(data || {});
    let url = '/app-api' + apiPath;
    if (method === 'GET') url += '?' + new URLSearchParams(enc).toString();
    const transport = useHttps ? https : http;
    const req = transport.request({
      hostname: 'cgzx.scu.edu.cn', port: useHttps ? 443 : 80, path: url, method,
      headers: {
        authorization: token,
        'x-timestamp': String(Date.now()),
        'tenant-id': '1', 'terminal': '10',
        referer: (useHttps ? 'https' : 'http') + '://cgzx.scu.edu.cn/venue/',
        ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}),
      }
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const dec = sm2Decrypt(parsed);
          resolve(dec || { success: true, code: parsed.code || -1, msg: 'decrypt_failed', data: null });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    if (method !== 'GET') req.write(JSON.stringify(enc));
    req.end();
  });

  return _call(true).catch(() => _call(false)); // HTTPS 优先，失败降级 HTTP
}

// 查场地（可选传入 userId 避免依赖全局 setCurrentUser；per-user 优先，共享回退）
async function sm2GetBookableTimes(fieldId, _userId) {
  const token = _userId ? (readToken(_userId) || readToken()) : _sm2GetToken();
  try {
    const r = await sm2CallApi('GET', '/venue/field/get-bookable-times/' + fieldId, undefined, token);
    return { success: true, code: r.code || 0, msg: r.msg, data: r.data };
  } catch (e) {
    return { success: false, code: -1, msg: e.message, data: null };
  }
}

// 下单（可选传入 userId 避免依赖全局 setCurrentUser；per-user 优先，共享回退）
async function sm2CreateOrder(fieldId, startTime, endTime, date, venueId, _userId) {
  const bodyUserId = _userId ? _sm2GetUserId(_userId) : _sm2GetUserId();
  const token = _userId ? (readToken(_userId) || readToken()) : _sm2GetToken();
  const vid = venueId || 1;
  try {
    const r = await sm2CallApi('POST', '/venue/booking/orders/create', {
      bookings: [{ venueId: vid, fieldId, startTime, endTime, bookingDate: date }],
      userId: bodyUserId, venueId: vid, couponId: '',
    }, token);
    return { success: true, code: r.code || 0, msg: r.msg, data: r.data };
  } catch (e) {
    return { success: false, code: -1, msg: e.message, data: null };
  }
}

// 从 auth.json 读 userId（可选传入 uid 避免依赖全局 setCurrentUser）
function _sm2GetUserId(_uid) {
  const uid = _uid || getCurrentUser();
  if (!uid) return null;
  const authFile = _getAuthFile(uid);
  try {
    if (fs.existsSync(authFile)) {
      const raw = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      const origins = raw.origins || [];
      for (const o of origins) {
        const items = o.localStorage || [];
        for (const item of items) {
          if (item.name === 'userInfo') {
            const info = JSON.parse(item.value);
            if (info.userId) return info.userId;
          }
        }
      }
    }
  } catch(e) {}
  return null;
}

// ========== 引擎 ==========
class BookingEngine {
  constructor() {
    this.browser = null;
    this.page = null;
    this.auth = null;
    this.config = null;
    this.currentUserId = null;
  }

  loadAuth() {
    const file = _getAuthFile(getCurrentUser());
    if (!fs.existsSync(file)) return false;
    this.auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    this.currentUserId = getCurrentUser();
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
    const file = _getAuthFile(this.currentUserId);
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch(e) {}
    fs.writeFileSync(file, JSON.stringify(this.auth, null, 2));
  }

  // 🔑 切换当前用户 token（引擎复用，但 token 切到新用户）
  async switchUserToken(userId) {
    if (this.currentUserId === userId && this.page && !this.page.isClosed()) {
      // 同一用户，检查 page 是否还活着
      try { await this.page.evaluate(() => true); return true; } catch(e) {}
    }
    const prevUserId = _currentUserId;
    setCurrentUser(userId);
    const auth = _readAuthFile();
    if (!auth) { setCurrentUser(prevUserId); return false; }
    this.auth = auth;
    this.currentUserId = userId;
    // 重新注入 token 到 page
    if (this.page && !this.page.isClosed()) {
      const token = this.getToken();
      const rt = this.getRefreshToken();
      if (token) {
        try {
          await this.page.evaluate(({t, rt}) => {
            try {
              uni.setStorageSync('accessToken', t);
              if (rt) uni.setStorageSync('refreshToken', rt);
            } catch(e) {}
          }, {t: token, rt: rt});
        } catch(e) {}
      }
    }
    return true;
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
    const isLinux = process.platform === 'linux';

    // Windows: 用最小参数，避免 Chromium 崩溃
    // Linux/Render: 用激进内存优化参数
    const commonArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
    const linuxOnlyArgs = [
      '--disable-dev-shm-usage', '--disable-gpu', '--single-process',
      '--no-zygote', '--disable-extensions', '--disable-sync',
      '--js-flags=--max-old-space-size=128',
    ];
    const launchArgs = isLinux ? [...commonArgs, ...linuxOnlyArgs] : commonArgs;

    const launchOpts = { headless: true, args: launchArgs };

    // Render 环境检测
    const cacheDir = '/opt/render/.cache/ms-playwright';
    if (fs.existsSync(cacheDir)) {
      const dirs = fs.readdirSync(cacheDir).sort().reverse();
      const shell = dirs.find(d => d.includes('headless_shell'));
      if (shell) {
        const p = path.join(cacheDir, shell, 'chrome-linux64', 'chrome');
        if (fs.existsSync(p)) { launchOpts.executablePath = p; log(`📂 Chromium (headless): ${shell}`); }
      }
      if (!launchOpts.executablePath) {
        const full = dirs.find(d => d.startsWith('chromium-') && !d.includes('headless'));
        if (full) {
          const p = path.join(cacheDir, full, 'chrome-linux64', 'chrome');
          if (fs.existsSync(p)) { launchOpts.executablePath = p; log(`📂 Chromium: ${full}`); }
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
        log(`❌ Chromium 启动失败: ${err.message}`);
        throw err;
      }
    }

    const context = await this.browser.newContext({
      viewport: isLinux ? { width: 480, height: 360 } : { width: 1280, height: 720 },
      locale: 'zh-CN',
    });
    this.page = await context.newPage();

    // 仅 Linux 低内存环境拦截资源，Windows 完全不拦截（uni-app 需要完整环境）
    if (isLinux) {
      await this.page.route('**/*', (route) => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font'].includes(type)) route.abort();
        else route.continue();
      });
    }

    // 加载页面：用 'load' 而非 'domcontentloaded'（学校的 uni-app 需要 JS 执行完）
    log('📡 加载 uni-app 环境...');
    let pageOk = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.page.goto('https://cgzx.scu.edu.cn/venue/', {
          waitUntil: 'load', timeout: 30000
        });
        pageOk = true;
        log(`✅ 页面加载成功（第${attempt+1}次）`);
        break;
      } catch(e) {
        log(`⚠️ 页面加载尝试 ${attempt+1}/3 失败: ${e.message.substring(0, 60)}`);
        if (e.message?.includes('closed') || e.message?.includes('Target')) {
          log('❌ 浏览器已崩溃，无法继续');
          return false;
        }
        await sleep(2000);
      }
    }
    if (!pageOk) {
      log('⚠️ 页面加载多次失败，尝试继续...');
    }
    await sleep(2000); // 给 uni-app 框架初始化时间

    // 等 uni.$u.http 就绪
    let uniReady = false;
    for (let i = 0; i < 15; i++) {
      try {
        const ready = await this.page.evaluate(() => {
          try { return typeof uni !== 'undefined' && !!uni.$u?.http; }
          catch(e) { return false; }
        });
        if (ready) { uniReady = true; break; }
      } catch(e) { /* page may not be ready yet */ }
      await sleep(1500);
    }
    if (!uniReady) {
      log('⚠️ uni.$u.http 未就绪，页面可能加载不完整');
    } else {
      log('✅ uni.$u.http 就绪');
    }

    // ⭐ 注入 token — 必须在 uni 就绪之后！
    const token = this.getToken();
    const refreshToken = this.getRefreshToken();
    if (token) {
      try {
        await this.page.evaluate(({t, rt}) => {
          try {
            uni.setStorageSync('accessToken', t);
            if (rt) uni.setStorageSync('refreshToken', rt);
          } catch(e) {}
        }, {t: token, rt: refreshToken});
        // 验证注入
        const written = await this.page.evaluate(() => {
          try { return uni.getStorageSync('accessToken') || ''; } catch(e) { return ''; }
        });
        log(written ? '🔑 Token 已注入' : '⚠️ Token 注入后读取为空');
      } catch(e) {
        log(`⚠️ Token 注入异常: ${e.message}`);
      }
    }

    // 验证 token 有效性（失败也不阻塞）
    if (uniReady) {
      await this.ensureTokenValid();
    }

    // getLiveToken 有时不可靠（Storage 读写不一致），直接检查 AUTH_FILE
    const t = this.getToken();
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
    // 尝试用 /member/user/get 验证 token
    let apiOk = false;
    try {
      apiOk = await this.page.evaluate(async () => {
        try {
          const res = await uni.$u.http.get('/app-api/member/user/get');
          return res.code === 0;
        } catch(e) { return false; }
      }).catch(() => false);
    } catch(e) { /* 静默 */ }

    if (apiOk) { log('✅ Token 有效'); return true; }

    // ⚠️ /member/user/get 失败了不一定是 token 问题
    // 只要我们注入了 token，继续用——getBookableTimes 才是真正的检验
    log(`⚠️ Token 在线验证未通过（可能是 API 限制），继续使用已注入的 token`);
    return true;  // 不阻塞——token 已注入，后续 API 调用会自行判断

    // 以下代码暂时跳过（refresh 逻辑保留以便将来启用）
    /*
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
    */
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

  // 🚀 批量查询（废弃，实测比逐场 page.evaluate 慢 100ms）
  async _getBookableTimesBatch_deprecated(fieldIds) {
    const unique = [...new Set(fieldIds)];
    const results = await this.page.evaluate(async (fids) => {
      const http = uni.$u.http;
      const promises = fids.map(fid =>
        http.get('/app-api/venue/field/get-bookable-times/' + fid)
          .then(res => ({ success: true, code: res.code, msg: res.msg, data: res.data }))
          .catch(e => ({ success: false, code: e.code, msg: e.msg, data: e.data }))
      );
      return await Promise.all(promises);
    }, unique);
    // 映射回 fieldId → result
    const map = {};
    unique.forEach((fid, i) => { map[fid] = results[i]; });
    return map;
  }
  async discoverFields(venueId) {
    const hardcoded = getFieldsForVenue(venueId);
    if (hardcoded.length > 0) return hardcoded;

    // 无硬编码时尝试探测
    const ranges = {
      1: [36, 45], 4: [46, 52], 9: [1, 6], 19: [53, 60],
    };
    const [lo, hi] = ranges[venueId] || [1, 10];
    const found = [];
    for (let cid = lo; cid <= hi; cid++) {
      try {
        const result = await this.callAPI('GET', `/venue/field/get-bookable-times/${cid}`);
        if (result.success && result.code === 0 && Array.isArray(result.data) && result.data.length > 0) {
          found.push({ id: cid, name: `场地 ${cid}` });
        }
      } catch(e) {}
    }
    return found.length > 0 ? found : [];
  }

  async createOrder(fieldId, startTime, endTime, date, venueId) {
    const vid = venueId || this.config?.venueId || 1;
    return this.callAPI('POST', '/venue/booking/orders/create', {
      bookings: [{
        venueId: vid,
        fieldId,
        startTime,
        endTime,
        bookingDate: date,
      }],
      userId: this.getUserId(),
      venueId: vid,
      couponId: '',
    });
  }

  // 🔑 多时段合并预约：一次性提交多个 bookings（可能跨场馆），绕过支付跳转限制
  async createMultiOrder(bookings) {
    const userId = this.getUserId();
    // 以第一个 booking 的 venueId 为主 venueId
    const primaryVid = bookings[0]?.venueId || this.config?.venueId || 1;
    return this.callAPI('POST', '/venue/booking/orders/create', {
      bookings: bookings.map(b => ({
        venueId: b.venueId || primaryVid,
        fieldId: b.fieldId,
        startTime: b.startTime,
        endTime: b.endTime,
        bookingDate: b.date,
      })),
      userId,
      venueId: primaryVid,
      couponId: '',
    });
  }

  async close() {
    if (this.browser) try { await this.browser.close(); } catch(e) {}
  }
}

// ========== 直接 API 抢场（服务器/无头环境用，不需要浏览器） ==========
async function directMain(opts = {}) {
  const cfg = loadConfig();
  if (!cfg) {
    log('❌ 未找到 config.json');
    _lastResult = { success: false, error: '无配置文件' };
    return _lastResult;
  }

  // 获取 userId（从 auth 文件或 JWT payload，下单时需要）
  const serverUserId = await directGetUserId();

  // 检查 Token（isTokenExpired/readToken 内部用 getCurrentUser 查当前用户）
  if (isTokenExpired()) {
    log('🔄 Token 已过期，尝试刷新...');
    const refreshed = await directRefreshToken();
    if (!refreshed) {
      _lastResult = { success: false, error: '登录已过期，请重新粘贴 Token' };
      return _lastResult;
    }
  }
  if (!serverUserId) {
    log('⚠️ 无法获取用户 ID，预约接口可能需要 userId');
  }

  const venueId = cfg.venueId || 1;
  const targetHour = cfg.targetHour ?? 8;
  const targetMinute = cfg.targetMinute ?? 30;
  const targetSecond = cfg.targetSecond ?? 0;
  const preWakeMs = cfg.preWakeMs ?? 120000;

  // 计算等待时间
  const now = new Date();
  const target = new Date();
  target.setHours(targetHour, targetMinute, targetSecond, 0);
  // 已过目标时间 → 看是否 skipWait（调度器串行多用户时后面的用户应立即抢）
  if (target <= now) {
    if (opts.skipWait) {
      log(`⏩ 已过 ${targetHour}:${String(targetMinute).padStart(2,'0')}，立即开抢`);
    } else {
      target.setDate(target.getDate() + 1);
    }
  }

  if (!opts.skipWait || target > now) {
    const wakeTime = target.getTime() - preWakeMs;
    if (!opts.skipWait && now.getTime() < wakeTime) {
      const sec = Math.round((wakeTime - now.getTime()) / 1000);
      log(`⏳ 等待到 ${targetHour}:${String(targetMinute).padStart(2,'0')} (${sec}秒后)`);
      await sleep(wakeTime - Date.now());
    }
    while (Date.now() < target.getTime() - 30) await sleep(10);
    while (Date.now() < target.getTime()) { /* busy wait */ }
  }

  let booked = false;
  const today = new Date().toISOString().split('T')[0];
  const defaultVenueId = cfg.venueId || 1;

  const wishes = (cfg.wishes || []).filter(w => w.enabled !== false);

  // 并行扫描：所有志愿同时查 API
  const scanResults = await Promise.all(wishes.map(async (wish, i) => {
    const vid = wish.venueId || defaultVenueId;
    try {
      const slots = await directGetBookableTimes(wish.fieldId);
      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
        if (ts) {
          return { wish, price: ts.price || 15, venueId: vid, rank: i + 1 };
        }
      }
    } catch(e) { /* 单个失败不影响其他 */ }
    return null;
  }));

  const hits = scanResults.filter(Boolean);

  // 打印扫描结果
  for (let i = 0; i < wishes.length; i++) {
    const wish = wishes[i];
    const vid = wish.venueId || defaultVenueId;
    const hit = hits.find(h => h.wish.fieldId === wish.fieldId && h.wish.time === wish.time);
    if (hit) {
      log(`🎯 命中! [${getVenueName(vid)}] ${wish.name} ${wish.time} ¥${hit.price}`);
    } else {
      log(`⏳ [第${i+1}志愿] [${getVenueName(vid)}] ${wish.name} ${wish.time} 不可用`);
    }
  }

  // 🔑 命中时：并行提交独立订单（每人每天最多 2 个时段）
  const MAX_BOOK = 2;
  if (hits.length > 0) {
    const toSubmit = hits.slice(0, MAX_BOOK);
    log(`🚀 ${hits.length} 个命中，并行提交 ${toSubmit.length} 个独立订单...`);
    toSubmit.forEach(h => log(`  📌 [${getVenueName(h.venueId)}] ${h.wish.name} ${h.wish.time}-${h.wish.timeEnd} ¥${h.price}`));

    const orderResults = await Promise.all(toSubmit.map(h =>
      callDirectAPI('POST', '/venue/booking/orders/create', {
        bookings: [{
          venueId: h.venueId,
          fieldId: h.wish.fieldId,
          startTime: h.wish.time,
          endTime: h.wish.timeEnd,
          bookingDate: today,
        }],
        venueId: h.venueId,
        couponId: '',
        ...(serverUserId ? { userId: serverUserId } : {}),
      })
    ));

    // 统计结果
    let successCount = 0;
    for (let i = 0; i < toSubmit.length; i++) {
      const h = toSubmit[i];
      const order = orderResults[i];
      if (order && order.success && order.code === 0) {
        successCount++;
        log(`🎉🎉🎉 [${getVenueName(h.venueId)}] ${h.wish.name} ${h.wish.time} 成功! 订单: ${order.data?.orderNo || '?'}`);
        booked = true;
      } else {
        log(`❌ [${getVenueName(h.venueId)}] ${h.wish.name} ${h.wish.time} 失败: ${order?.msg || '未知'}`);
      }
    }
    if (successCount > 0) {
      log(`🎊 并行抢场完成! ${successCount}/${toSubmit.length} 成功`);
    }
  }

  // 🔍 首发全空 → 零延迟连续监测
  // 直连 API 返回 401（SM3 鉴权不工作），此路径通常无效，仅作降级兜底
  if (!booked && wishes.length > 0) {
    const MONITOR_MS = 5000; // 5秒，约11轮×4志愿
    const monitorStart = Date.now();
    let loopCount = 0;
    log(`🔍 连续监测（${wishes.length}志愿，零间隔，最长${MONITOR_MS/1000}s）...`);
    while (!booked && (Date.now() - monitorStart) < MONITOR_MS) {
      loopCount++;
      const reScan = await Promise.all(wishes.map(async (wish) => {
        try {
          const slots = await directGetBookableTimes(wish.fieldId);
          if (slots.success && slots.code === 0 && slots.data) {
            const days = Array.isArray(slots.data) ? slots.data : [];
            const day = days.find(d => d.date === today) || days[0];
            const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
            if (ts) return { wish, price: ts.price || 15, venueId: wish.venueId || venueId };
          }
        } catch(e) {}
        return null;
      }));
      const reHits = reScan.filter(Boolean);
      if (reHits.length > 0) {
        log(`🎯 监测到! ${reHits[0].wish.name} ${reHits[0].wish.time} 可预约!`);
        const toSubmit = reHits.slice(0, MAX_BOOK);
        const orderResults = await Promise.all(toSubmit.map(h =>
          callDirectAPI('POST', '/venue/booking/orders/create', {
            bookings: [{ venueId: h.venueId, fieldId: h.wish.fieldId, startTime: h.wish.time, endTime: h.wish.timeEnd, bookingDate: today }],
            venueId: h.venueId, couponId: '',
            ...(serverUserId ? { userId: serverUserId } : {}),
          })
        ));
        for (let i = 0; i < toSubmit.length; i++) {
          const h = toSubmit[i];
          const order = orderResults[i];
          if (order && order.success && order.code === 0) {
            log(`🎉 到手! ${h.wish.name} ${h.wish.time} 订单: ${order.data?.orderNo || '?'}`);
            booked = true;
          } else {
            log(`❌ 监测下单失败: ${h.wish.name} ${h.wish.time} — ${order?.msg || '未知'}`);
          }
        }
        // 下单失败不退出，继续监测
      }
      // 不 sleep — API 延迟自身就是节流
    }
    const monitorElapsed = Date.now() - monitorStart;
    const rps = (loopCount / (monitorElapsed / 1000)).toFixed(1);
    if (!booked) log(`🔍 监测结束（${loopCount}轮 ${(monitorElapsed/1000).toFixed(1)}s ${rps}轮/s），无果`);
  }

  // === 扫荡模式（监测无果后才扫荡） ===
  if (!booked && cfg.fallbackEnabled !== false) {
    log('♻️ 进入扫荡模式...');
    for (const v of (cfg.fallbackVenues || [])) {
      if (booked) break;
      const vid = v.venueId || defaultVenueId;
      const slots = await directGetBookableTimes(v.fieldId);
      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        if (day?.timeSlots) {
          for (const t of (cfg.fallbackTimes || [])) {
            if (booked) break;
            const ts = day.timeSlots.find(s => s.startTime === t.time && s.bookable === true);
            if (ts) {
              log(`🎯 扫荡到 [${getVenueName(vid)}] ${v.name} ${t.time}!`);
              const order = await callDirectAPI('POST', '/venue/booking/orders/create', {
                bookings: [{
                  venueId: vid,
                  fieldId: v.fieldId,
                  startTime: t.time,
                  endTime: t.timeEnd,
                  bookingDate: today,
                }],
                venueId: vid,
                couponId: '',
                ...(serverUserId ? { userId: serverUserId } : {}),
              });
              if (order.success && order.code === 0) {
                log(`🎉 扫荡成功! ${v.name} ${t.time}`);
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

  _lastResult = { success: booked, time: new Date().toLocaleString('zh-CN') };
  return _lastResult;
}

// ========== 主流程（自动选择模式） ==========
async function main(opts = {}) {
  const forceDirect = opts.directMode === true || opts.browserMode === true;

  // 优先 SM2 直连（纯 Node.js，~150ms/请求，无需浏览器）
  if (!opts.browserMode && !forceDirect) {
    const token = readToken(getCurrentUser()) || readToken();
    if (token) {
      log('⚡ SM2 直连模式（零浏览器开销）');
      try {
        const result = await sm2Run(opts);
        if (result && result.success) return result;
        log('⚠️ SM2 未成功，降级到浏览器引擎...');
      } catch (e) {
        log(`⚠️ SM2 直连失败: ${e.message}，降级到浏览器引擎`);
      }
    } else {
      log('⚠️ 无 Token，跳过 SM2 直连');
    }
  }

  // 浏览器引擎
  if (!forceDirect) {
    let engine = null;
    let isShared = false;

    try {
      if (_panelEngine && _panelEngine.page && !_panelEngine.page.isClosed()) {
        engine = _panelEngine;
        isShared = true;
        log('⚡ 复用暖机引擎（零延迟）');
        const uid = getCurrentUser();
        if (uid) await engine.switchUserToken(uid);
        engine.config = loadConfig();
      }
    } catch(e) { engine = null; isShared = false; }

    if (!engine) {
      engine = new BookingEngine();
      try {
        const ok = await engine.start();
        if (!ok) engine = null;
      } catch(e) {
        log(`⚠️ 浏览器引擎启动失败: ${e.message}`);
        await engine.close().catch(() => {});
        engine = null;
      }
    }

    if (engine) {
      try {
        const result = await engineRun(engine, opts);
        if (!isShared) await engine.close();
        return result;
      } catch(e) {
        if (!isShared) await engine.close().catch(() => {});
      }
    }
  }

  log('🖥️ 降级到直接 API 模式');
  return directMain(opts);
}

// ========== SM2 直连抢场（核心路径，最快 ~550ms） ==========
async function sm2Run(opts = {}) {
  const cfg = loadConfig();
  if (!cfg) {
    log('❌ 未找到配置');
    return { success: false, reason: '无配置文件' };
  }

  const targetHour = cfg.targetHour ?? 8;
  const targetMinute = cfg.targetMinute ?? 30;
  const targetSecond = cfg.targetSecond ?? 0;

  // 初始化计时日志
  const uid = getCurrentUser();
  _timingReset(uid, 'sm2');
  _timing.targetTime = `${String(targetHour).padStart(2,'0')}:${String(targetMinute).padStart(2,'0')}:${String(targetSecond).padStart(2,'0')}`;

  // 先用 SM2 直连刷新 token（纯 Node.js，不依赖浏览器）
  const tokT0 = Date.now();
  const refreshed = await _sm2RefreshToken();
  _timing.preScan.tokenRefreshMs = Date.now() - tokT0;
  _timing.preScan.tokenRefreshed = refreshed;
  if (!refreshed) {
    // 刷新失败（无 refreshToken 或过期），尝试从浏览器同步
    log('⚠️ SM2 刷新失败，尝试从浏览器同步...');
    const synced = await _syncTokenFromBrowser();
    _timing.preScan.tokenRefreshMs = Date.now() - tokT0;
    _timing.preScan.syncFallback = true;
    if (synced) {
      // 浏览器给了新鲜 token，再用 SM2 刷新一次拿到新的 refreshToken 存起来
      const retried = await _sm2RefreshToken();
      _timing.preScan.tokenRefreshMs = Date.now() - tokT0;
      _timing.preScan.tokenRefreshed = retried;
      if (retried) log('🔑 二次刷新成功，refreshToken 已更新');
    }
  }
  const preWakeMs = cfg.preWakeMs ?? 120000;

  const now = new Date();
  const target = new Date();
  target.setHours(targetHour, targetMinute, targetSecond, 0);
  if (target <= now) {
    if (opts.skipWait) {
      log(`⏩ 已过 ${targetHour}:${String(targetMinute).padStart(2,'0')}，立即开抢`);
    } else {
      target.setDate(target.getDate() + 1);
    }
  }

  if (!opts.skipWait || target > now) {
    const wakeTime = target.getTime() - preWakeMs;
    if (!opts.skipWait && now.getTime() < wakeTime) {
      const sec = Math.round((wakeTime - now.getTime()) / 1000);
      log(`⏳ 等待到 ${targetHour}:${String(targetMinute).padStart(2,'0')} (${sec}秒后)`);
      await sleep(wakeTime - Date.now());
    }
    while (Date.now() < target.getTime() - 30) await sleep(10);
    while (Date.now() < target.getTime()) { /* busy wait */ }
  }

  // 记录开火时间
  _timing.fire.intended = target.toISOString();
  _timing.fire.actual = Date.now();
  _timing.fire.offsetMs = _timing.fire.actual - target.getTime();

  let booked = false;
  const today = new Date().toISOString().split('T')[0];
  const defaultVenueId = cfg.venueId || 1;
  const MAX_BOOK = 2;

  const wishes = (cfg.wishes || []).filter(w => w.enabled !== false);
  // 每个志愿的独立优先级（默认 0，数字越大优先级越高）
  for (const w of wishes) { if (w.priority == null) w.priority = 0; }
  // 按优先级降序排列（高优先级先处理），同优先级保持原顺序
  wishes.sort((a, b) => b.priority - a.priority);

  // === 流水线扫描+下单（同优先级竞速，跨优先级保序） ===
  _timing.scan.startMs = Date.now();
  _timing.scan.fieldCount = wishes.length;
  const pipelineStart = Date.now();
  let orderCount = 0;
  let firstOrderAt = null;
  const orderPromises = [];

  // 计算优先级层级
  const wishPrios = wishes.map(w => w.priority);
  const levels = [...new Set(wishPrios)].sort((a, b) => b - a); // 降序

  // 每个优先级层：计数器 + gate（所有场扫完才解锁下层）
  const levelPending = {};  // prio → 剩余未完成扫描数
  const levelGates = {};    // prio → { p, r }
  const levelDone = {};     // prio → 该层是否已发过单（同层竞速，只发第一个）
  for (const lv of levels) {
    levelPending[lv] = wishes.filter(w => w.priority === lv).length;
    let r; levelGates[lv] = { p: new Promise(res => r = res), r };
    levelDone[lv] = false;
  }
  // 最高层无需等待，立即解锁
  if (levels.length > 0) levelGates[levels[0]].r();

  // 每个志愿的 scanGate = 比自己优先级高的所有层的 gate
  const scanGates = wishes.map(w => {
    const higher = levels.filter(lv => lv > w.priority);
    return { level: w.priority, gate: Promise.all(higher.map(lv => levelGates[lv].p)) };
  });

  const scanResults = await Promise.all(wishes.map(async (wish, i) => {
    const vid = wish.venueId || defaultVenueId;
    const fT0 = Date.now();
    let hit = null;
    try {
      const slots = await sm2GetBookableTimes(wish.fieldId, uid);
      const fMs = Date.now() - fT0;
      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
        if (day?.date) _timingSetServerTime(day.date);
        const avail = !!ts;
        _timingScanField(wish.fieldId, vid, fMs, avail, null);
        if (ts) {
          hit = { wish, price: ts.price || 15, venueId: vid, rank: i + 1 };
          log(`🎯 命中! [${getVenueName(vid)}] ${wish.name} ${wish.time} ¥${hit.price} (优先级${wish.priority})`);
        }
      } else {
        _timingScanField(wish.fieldId, vid, fMs, false, slots.code !== 0 ? `code=${slots.code}` : 'no_data');
      }
    } catch(e) {
      _timingScanField(wish.fieldId, vid, Date.now() - fT0, false, e.message);
    }
    if (!hit) log(`⏳ [${getVenueName(vid)}] ${wish.name} ${wish.time} 不可用 (优先级${wish.priority})`);

    // 本层计数器 -1；到 0 时解锁下一层
    levelPending[wish.priority]--;
    if (levelPending[wish.priority] <= 0) {
      const nextIdx = levels.indexOf(wish.priority) + 1;
      if (nextIdx < levels.length) levelGates[levels[nextIdx]].r();
    }

    // 命中 → 等更高层扫完 → 同层竞速先到先得
    if (hit && orderCount < MAX_BOOK) {
      await scanGates[i].gate;
      if (orderCount < MAX_BOOK && !levelDone[wish.priority]) {
        levelDone[wish.priority] = true;
        orderCount++;
        if (!firstOrderAt) firstOrderAt = Date.now();
        const orderP = sm2CreateOrder(wish.fieldId, wish.time, wish.timeEnd, today, vid, uid)
          .then(order => ({ hit, order }));
        orderPromises.push(orderP);
      }
    }
    return hit;
  }));

  const hits = scanResults.filter(Boolean);
  const scanMs = Date.now() - pipelineStart;
  _timing.scan.durationMs = scanMs;
  _timing.scan.hits = hits.length;

  // 等到所有下单完成
  if (orderPromises.length > 0) {
    _timing.order.count = orderPromises.length;
    _timing.order.startMs = firstOrderAt || Date.now();
    const orderStart = firstOrderAt || Date.now();
    const orderResults = await Promise.all(orderPromises);
    const orderMs = Date.now() - orderStart;
    _timing.order.durationMs = orderMs;

    let successCount = 0;
    for (const { hit, order } of orderResults) {
      const ok = order && order.success && order.code === 0;
      _timingOrderResult(hit.wish.fieldId, hit.venueId, ok, order?.code, order?.msg, order?.data?.orderNo || order?.data?.id);
      if (ok) {
        successCount++;
        log(`🎉🎉🎉 [${getVenueName(hit.venueId)}] ${hit.wish.name} ${hit.wish.time} 成功! 订单: ${order.data?.orderNo || order.data?.id || '?'}`);
        _timing.result.bookedField = { fieldId: hit.wish.fieldId, name: hit.wish.name, venueId: hit.venueId, time: hit.wish.time };
        booked = true;
      } else {
        log(`❌ [${getVenueName(hit.venueId)}] ${hit.wish.name} ${hit.wish.time} 失败: ${order?.msg || '未知'}`);
      }
    }
    if (successCount > 0) {
      const totalMs = Date.now() - pipelineStart;
      log(`🎊 SM2 抢场完成! ${successCount}/${orderPromises.length} 成功 (流水线总计 ${totalMs}ms, 扫描${scanMs}ms + 下单${orderMs}ms)`);
    }
  }

  // === 监测（同优先级竞速，跨优先级保序） ===
  if (!booked && wishes.length > 0) {
    const MONITOR_MS = 5000;
    const monitorStart = Date.now();
    let loopCount = 0;
    log(`🔍 SM2 连续监测（${wishes.length}志愿，约250ms/轮，最长${MONITOR_MS/1000}s）...`);
    while (!booked && (Date.now() - monitorStart) < MONITOR_MS) {
      loopCount++;
      const rPending = {}; const rGates = {}; const rDone = {};
      for (const lv of levels) {
        rPending[lv] = wishes.filter(w => w.priority === lv).length;
        let rr; rGates[lv] = { p: new Promise(res => rr = res), r: rr }; rDone[lv] = false;
      }
      if (levels.length > 0) rGates[levels[0]].r();
      let rOrderCount = 0;
      const rOrderPs = [];

      await Promise.all(wishes.map(async (wish) => {
        let hit = null;
        try {
          const slots = await sm2GetBookableTimes(wish.fieldId, uid);
          if (slots.success && slots.code === 0 && slots.data) {
            const days = Array.isArray(slots.data) ? slots.data : [];
            const day = days.find(d => d.date === today) || days[0];
            const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
            if (ts) hit = { wish, price: ts.price || 15, venueId: wish.venueId || defaultVenueId };
          }
        } catch(e) {}
        rPending[wish.priority]--;
        if (rPending[wish.priority] <= 0) {
          const nextIdx = levels.indexOf(wish.priority) + 1;
          if (nextIdx < levels.length) rGates[levels[nextIdx]].r();
        }
        if (hit && !booked && rOrderCount < MAX_BOOK) {
          const higher = levels.filter(lv => lv > wish.priority);
          await Promise.all(higher.map(lv => rGates[lv].p));
          if (!booked && rOrderCount < MAX_BOOK && !rDone[wish.priority]) {
            rDone[wish.priority] = true;
            rOrderCount++;
            log(`🎯 监测到! ${hit.wish.name} ${hit.wish.time} 可预约! (优先级${wish.priority})`);
            const orderP = sm2CreateOrder(wish.fieldId, wish.time, wish.timeEnd, today, wish.venueId || defaultVenueId, uid)
              .then(order => ({ hit, order }));
            rOrderPs.push(orderP);
          }
        }
      }));

      if (rOrderPs.length > 0) {
        const rResults = await Promise.all(rOrderPs);
        for (const { hit, order } of rResults) {
          if (order && order.success && order.code === 0) {
            log(`🎉 到手! ${hit.wish.name} ${hit.wish.time} 订单: ${order.data?.orderNo || order.data?.id || '?'}`);
            _timing.result.bookedField = { fieldId: hit.wish.fieldId, name: hit.wish.name, venueId: hit.venueId, time: hit.wish.time };
            booked = true;
          } else {
            log(`❌ 监测下单失败: ${hit.wish.name} ${hit.wish.time} — ${order?.msg || '未知'}`);
          }
        }
      }
    }
    const monitorElapsed = Date.now() - monitorStart;
    const avgRoundMs = Math.round(monitorElapsed / loopCount);
    _timing.monitor = {
      rounds: loopCount,
      durationMs: monitorElapsed,
      avgRoundMs,
      hitsFound: booked,
    };
    if (!booked) log(`🔍 监测结束（${loopCount}轮，avg ${avgRoundMs}ms/轮，${(loopCount/(monitorElapsed/1000)).toFixed(1)}轮/s），无果`);
  }

  // === 扫荡 ===
  if (!booked && cfg.fallbackEnabled !== false) {
    const fbT0 = Date.now();
    let fbVenues = 0;
    log('♻️ 进入扫荡模式（SM2）...');
    for (const v of (cfg.fallbackVenues || [])) {
      if (booked) break;
      const vid = v.venueId || defaultVenueId;
      fbVenues++;
      try {
        const slots = await sm2GetBookableTimes(v.fieldId, uid);
        if (slots.success && slots.code === 0 && slots.data) {
          const days = Array.isArray(slots.data) ? slots.data : [];
          const day = days.find(d => d.date === today) || days[0];
          if (day?.timeSlots) {
            for (const t of (cfg.fallbackTimes || [])) {
              if (booked) break;
              const ts = day.timeSlots.find(s => s.startTime === t.time && s.bookable === true);
              if (ts) {
                log(`🎯 扫荡到 [${getVenueName(vid)}] ${v.name} ${t.time}!`);
                const order = await sm2CreateOrder(v.fieldId, t.time, t.timeEnd, today, vid, uid);
                if (order.success && order.code === 0) {
                  log(`🎉 扫荡成功! ${v.name} ${t.time}`);
                  _timing.result.bookedField = { fieldId: v.fieldId, name: v.name, venueId: vid, time: t.time };
                  booked = true;
                  break;
                }
                await sleep(50);
              }
            }
          }
        }
      } catch(e) {}
    }
    _timing.fallback = {
      durationMs: Date.now() - fbT0,
      venuesScanned: fbVenues,
      success: booked,
    };
  }

  // 收尾
  _timing.result.success = booked;
  _timing.result.totalDurationMs = Date.now() - _timing.fire.actual;
  if (!_timing.monitor) _timing.monitor = null;
  _timingFlush();

  if (booked) {
    log('🎊🎊🎊 任务完成！');
  } else {
    log('😢 所有场地已满，明天再来');
  }

  _lastResult = { success: booked, time: new Date().toLocaleString('zh-CN') };
  return _lastResult;
}

// ========== 浏览器引擎抢场逻辑 ==========
async function engineRun(engine, opts = {}) {
  const cfg = engine.config;
  if (!cfg) {
    log('❌ 未找到 config.json');
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
  // 已过目标时间 → 看是否 skipWait（调度器串行多用户时后面的用户应立即抢）
  if (target <= now) {
    if (opts.skipWait) {
      log(`⏩ 已过 ${targetHour}:${String(targetMinute).padStart(2,'0')}，立即开抢`);
    } else {
      target.setDate(target.getDate() + 1);
    }
  }

  if (!opts.skipWait || target > now) {
    const wakeTime = target.getTime() - preWakeMs;
    if (!opts.skipWait && now.getTime() < wakeTime) {
      const sec = Math.round((wakeTime - now.getTime()) / 1000);
      log(`⏳ 等待到 ${targetHour}:${String(targetMinute).padStart(2,'0')} (${sec}秒后)`);
      await sleep(wakeTime - Date.now());
    }
    // 精准等到 8:30:00.000
    while (Date.now() < target.getTime() - 30) await sleep(10);
    while (Date.now() < target.getTime()) { /* busy wait */ }
  }

  let booked = false;
  const today = new Date().toISOString().split('T')[0];
  const defaultVenueId = cfg.venueId || 1;

  // === 准时发射 ===
  const wishes = (cfg.wishes || []).filter(w => w.enabled !== false);
  let scanResults = await Promise.all(wishes.map(async (wish, i) => {
    const vid = wish.venueId || defaultVenueId;
    try {
      const slots = await engine.getBookableTimes(wish.fieldId);
      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
        if (ts) return { wish, price: ts.price || 15, venueId: vid, rank: i + 1 };
      }
    } catch(e) {}
    return null;
  }));

  const hits = scanResults.filter(Boolean);

  // 打印扫描结果
  for (let i = 0; i < wishes.length; i++) {
    const wish = wishes[i];
    const vid = wish.venueId || defaultVenueId;
    const hit = hits.find(h => h.wish.fieldId === wish.fieldId && h.wish.time === wish.time);
    if (hit) {
      log(`🎯 命中! [${getVenueName(vid)}] ${wish.name} ${wish.time} ¥${hit.price}`);
    } else {
      log(`⏳ [第${i+1}志愿] [${getVenueName(vid)}] ${wish.name} ${wish.time} 不可用`);
    }
  }

  // 🔑 命中时：并行提交独立订单（每人每天最多 2 个时段）
  const MAX_BOOK = 2;
  if (hits.length > 0) {
    const toSubmit = hits.slice(0, MAX_BOOK);
    log(`🚀 ${hits.length} 个命中，并行提交 ${toSubmit.length} 个独立订单...`);
    toSubmit.forEach(h => log(`  📌 [${getVenueName(h.venueId)}] ${h.wish.name} ${h.wish.time}-${h.wish.timeEnd} ¥${h.price}`));

    const orderResults = await Promise.all(toSubmit.map(h =>
      engine.createOrder(h.wish.fieldId, h.wish.time, h.wish.timeEnd, today, h.venueId)
    ));

    // 统计结果
    let successCount = 0;
    for (let i = 0; i < toSubmit.length; i++) {
      const h = toSubmit[i];
      const order = orderResults[i];
      if (order && order.success && order.code === 0) {
        successCount++;
        log(`🎉🎉🎉 [${getVenueName(h.venueId)}] ${h.wish.name} ${h.wish.time} 成功! 订单: ${order.data?.orderNo || '?'}`);
        booked = true;
      } else {
        log(`❌ [${getVenueName(h.venueId)}] ${h.wish.name} ${h.wish.time} 失败: ${order?.msg || '未知'}`);
      }
    }
    if (successCount > 0) {
      log(`🎊 并行抢场完成! ${successCount}/${toSubmit.length} 成功`);
    }
  }

  // 🔍 首发全空 → 零延迟连续监测
  if (!booked && wishes.length > 0) {
    const MONITOR_MS = 5000; // 5秒，约11轮×4志愿
    const monitorStart = Date.now();
    let loopCount = 0;
    log(`🔍 连续监测（${wishes.length}志愿，约${wishes.length*170}ms/轮，最长${MONITOR_MS/1000}s）...`);
    while (!booked && (Date.now() - monitorStart) < MONITOR_MS) {
      loopCount++;
      const reScan = await Promise.all(wishes.map(async (wish) => {
        try {
          const slots = await engine.getBookableTimes(wish.fieldId);
          if (slots.success && slots.code === 0 && slots.data) {
            const days = Array.isArray(slots.data) ? slots.data : [];
            const day = days.find(d => d.date === today) || days[0];
            const ts = day?.timeSlots?.find(s => s.startTime === wish.time && s.bookable === true);
            if (ts) return { wish, price: ts.price || 15, venueId: wish.venueId || defaultVenueId };
          }
        } catch(e) {}
        return null;
      }));
      const reHits = reScan.filter(Boolean);
      if (reHits.length > 0) {
        log(`🎯 监测到! ${reHits[0].wish.name} ${reHits[0].wish.time} 可预约!`);
        const toSubmit = reHits.slice(0, MAX_BOOK);
        const orderResults = await Promise.all(toSubmit.map(h =>
          engine.createOrder(h.wish.fieldId, h.wish.time, h.wish.timeEnd, today, h.venueId)
        ));
        for (let i = 0; i < toSubmit.length; i++) {
          const h = toSubmit[i];
          const order = orderResults[i];
          if (order && order.success && order.code === 0) {
            log(`🎉 到手! ${h.wish.name} ${h.wish.time} 订单: ${order.data?.orderNo || '?'}`);
            booked = true;
          } else {
            log(`❌ 监测下单失败: ${h.wish.name} ${h.wish.time} — ${order?.msg || '未知'}`);
          }
        }
        // 下单失败不退出，继续监测下一个空位
      }
      // 不 sleep — 批量请求耗时本身就是天然节流
    }
    const monitorElapsed = Date.now() - monitorStart;
    const avgRoundMs = Math.round(monitorElapsed / loopCount);
    const rps = (loopCount / (monitorElapsed / 1000)).toFixed(1);
    if (!booked) log(`🔍 监测结束（${loopCount}轮，avg ${avgRoundMs}ms/轮，${rps}轮/s），无果`);
  }

  // === 扫荡模式（监测无果后才扫荡） ===
  if (!booked && cfg.fallbackEnabled !== false) {
    log('♻️ 进入扫荡模式...');
    for (const v of (cfg.fallbackVenues || [])) {
      if (booked) break;
      const vid = v.venueId || defaultVenueId;
      const slots = await engine.getBookableTimes(v.fieldId);
      if (slots.success && slots.code === 0 && slots.data) {
        const days = Array.isArray(slots.data) ? slots.data : [];
        const day = days.find(d => d.date === today) || days[0];
        if (day?.timeSlots) {
          for (const t of (cfg.fallbackTimes || [])) {
            if (booked) break;
            const ts = day.timeSlots.find(s => s.startTime === t.time && s.bookable === true);
            if (ts) {
              log(`🎯 扫荡到 [${getVenueName(vid)}] ${v.name} ${t.time}!`);
              const order = await engine.createOrder(v.fieldId, t.time, t.timeEnd, today, vid);
              if (order.success && order.code === 0) {
                log(`🎉 扫荡成功! ${v.name} ${t.time}`);
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

  _lastResult = { success: booked, time: new Date().toLocaleString('zh-CN') };
  return _lastResult;
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

// 反向查找：根据 fieldId 找到所属 venueId
function getVenueIdForField(fieldId) {
  for (const [vid, fields] of Object.entries(VENUE_FIELDS)) {
    if (fields.some(f => f.id === fieldId)) return parseInt(vid);
  }
  return 1; // 查不到默认望江
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

// 🔒 引擎互斥锁：多用户不能同时操作浏览器引擎（优先级排队）
let _engineBusy = false;
let _engineQueue = []; // { resolve, userId, priority, timestamp }

async function _acquireEngineLock(userId) {
  if (!_engineBusy) { _engineBusy = true; return; }
  const priority = userId ? readPriority(userId) : 100;
  return new Promise(resolve => {
    _engineQueue.push({ resolve, userId, priority, timestamp: Date.now() });
  });
}

function _releaseEngineLock() {
  if (_engineQueue.length > 0) {
    // 按优先级排序：低数字优先，同优先级按等待时间先到先服务
    _engineQueue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.timestamp - b.timestamp;
    });
    const next = _engineQueue.shift();
    next.resolve(); // 唤醒下一个等待者
  } else {
    _engineBusy = false;
  }
}

async function _ensurePanelEngine() {
  // 🔑 如果引擎正在启动中，等待它完成
  if (_panelEnginePromise) {
    log('⏳ 面板引擎正在启动，等待中...');
    const ok = await _panelEnginePromise;
    if (ok) {
      // 🔑 等待完成后仍需切换当前用户 token
      const uid = getCurrentUser();
      if (uid && _panelEngine) await _panelEngine.switchUserToken(uid);
    }
    return ok;
  }

  // 检查已有引擎是否还活着
  if (_panelEngine && _panelEngine.page) {
    try {
      const alive = await _panelEngine.page.evaluate(() => true).catch(() => false);
      if (alive && !_panelEngine.page.isClosed()) {
        // 🔑 切换 token 到当前用户
        const uid = getCurrentUser();
        if (uid) await _panelEngine.switchUserToken(uid);
        return true;
      }
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
    } catch (e) {
      log(`❌ 面板引擎崩溃: ${e.message}`);
      return false;
    } finally {
      _panelEnginePromise = null;
    }
  })();

  return await _panelEnginePromise;
}

// 🔒 加锁版：多用户安全的面板引擎操作（优先级排队）
async function _withEngineLock(fn, userId) {
  await _acquireEngineLock(userId);
  try {
    return await fn();
  } finally {
    _releaseEngineLock();
  }
}

async function scanAvailableSlots(userId, overrideVenueId) {
  const cfg = loadConfig();
  if (!cfg) return { success: false, error: '未找到配置' };

  const venueId = overrideVenueId || cfg.scanVenueId || cfg.venueId || 1;

  if (isTokenExpired(userId)) {
    log("🔄 Token 已过期，尝试刷新...");
    const refreshed = await directRefreshToken(userId);
    if (!refreshed) return { success: false, error: '登录已过期，请重新粘贴 Token' };
  }

  const fields = getFieldsForVenue(venueId);
  if (fields.length === 0) {
    return { success: false, error: '该场馆无场地数据，暂不支持扫描' };
  }
  log(`📋 ${getVenueName(venueId)}: ${fields.length} 个场地`);

  // 🔀 并行：SM2 + 浏览器同时扫描（同一个 token）
  const slots = await _scanAllSlotsDirect(venueId, userId);

  const now = new Date();
  const isBeforeOpen = now.getHours() < 8 || (now.getHours() === 8 && now.getMinutes() < 30);
  if (slots.length === 0 && isBeforeOpen) {
    log('💡 早上 8:30 才开放当天预约，现在还未开放');
  } else if (slots.length === 0) {
    log('💡 今天可能已约满，或未到开放时间（每天 8:30 开放）');
  }

  log(`📊 扫描完成: ${slots.length} 个可用时段`);
  markTokenVerified(userId);
  return { success: true, slots, venueId, venueName: getVenueName(venueId) };
}

// 独立版 discoverVenueFields（不依赖浏览器引擎）——硬编码表已验证正确
async function discoverVenueFields(venueId) {
  return getFieldsForVenue(venueId);
}

async function quickBookSlot(fieldId, fieldName, startTime, endTime, venueId, _userId) {
  const cfg = loadConfig(_userId);
  const vid = venueId || getVenueIdForField(fieldId);
  if (venueId && venueId !== getVenueIdForField(fieldId)) {
    log(`⚠️ 指定 venueId=${venueId} 但 fieldId=${fieldId} 属于 venueId=${getVenueIdForField(fieldId)}，以场地归属为准`);
  }
  const today = new Date().toISOString().split('T')[0];

  // 检查 Token
  if (isTokenExpired(_userId)) {
    log('🔄 Token 已过期，尝试刷新...');
    const refreshed = await directRefreshToken(_userId);
    if (!refreshed) {
      return { success: false, error: '登录已过期，请重新粘贴 Token' };
    }
  }

  // 优先 SM2 直连下单（零浏览器开销，~300ms）
  const sm2Token = readToken(_userId);
  if (sm2Token) {
    const sm2Order = await sm2CreateOrder(fieldId, startTime, endTime, today, vid, _userId);
    if (sm2Order && sm2Order.success && sm2Order.code === 0) {
      const orderNo = sm2Order.data?.orderNo || sm2Order.data?.id || '?';
      log(`🎉 SM2 捡漏成功! ${fieldName} ${startTime} 订单: ${orderNo}`);
      return { success: true, orderNo };
    }
    // SM2 失败降级到浏览器
    log(`⚠️ SM2 捡漏下单失败: ${sm2Order?.msg || '未知'}，降级浏览器...`);
  }

  // 先尝试用浏览器引擎预约（走 uni.$u.http 加密通道）
  if (!_panelEngine || !_panelEngine.page) {
    log('🔄 尝试启动浏览器引擎...');
    await _ensurePanelEngine();
  }

  if (_panelEngine && _panelEngine.page) {
    log(`📋 浏览器引擎预约 ${fieldName} ${startTime}-${endTime}...`);
    try {
      const result = await _panelEngine.createOrder(fieldId, startTime, endTime, today, vid);
      if (result.success && result.code === 0) {
        const orderNo = result.data?.orderNo || '未知';
        log(`🎉 预约成功! ${fieldName} ${startTime} 订单: ${orderNo}`);
        markTokenVerified(_userId);
        return { success: true, orderNo };
      } else {
        log(`❌ 预约失败: ${result.msg || '未知错误'}`);
        return { success: false, error: result.msg || '预约失败' };
      }
    } catch (e) {
      log(`⚠️ 浏览器预约失败: ${e.message}，尝试降级...`);
    }
  }

  // ⚠️ 降级到直接 API
  const apiUserId = await directGetUserId();
  log(`📋 直接 API 预约 ${fieldName} ${startTime}-${endTime}...`);

  try {
    const result = await callDirectAPI('POST', '/venue/booking/orders/create', {
      bookings: [{
        venueId: vid,
        fieldId,
        startTime,
        endTime,
        bookingDate: today,
      }],
      userId: apiUserId,
      venueId: vid,
      couponId: '',
    });

    if (result.success && result.code === 0) {
      const orderNo = result.data?.orderNo || '未知';
      log(`🎉 预约成功! ${fieldName} ${startTime} 订单: ${orderNo}`);
      markTokenVerified(_userId);
        return { success: true, orderNo };
    } else {
      log(`❌ 预约失败: ${result.msg || '未知错误'}`);
      return { success: false, error: result.msg || '预约失败' };
    }
  } catch (e) {
    log(`❌ 预约失败: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ========== 捡漏模式：持续扫描取消的场地 ==========
// 逻辑：先拍快照记录当前所有可约时段 → 每 N 秒轮询 → 发现新出现的就立刻预约
let _pickupState = {
  running: false,
  timer: null,
  knownSlots: new Set(),  // "fieldId|date|startTime" 已存在的可约时段
  booked: [],             // 捡漏成功的订单
  scanCount: 0,
  intervalMs: 5000,
  venueId: null,
  timeFilter: null,       // 只捡符合时间偏好的时段
};

function _slotKey(fieldId, date, startTime) {
  return `${fieldId}|${date}|${startTime}`;
}

// 从配置中提取时间偏好（志愿时间 + 扫荡时间）
function _getTimePreferences() {
  const cfg = loadConfig();
  if (!cfg) return null;
  const times = new Set();
  (cfg.wishes || []).forEach(w => {
    if (w.enabled !== false) times.add(w.time);
  });
  (cfg.fallbackTimes || []).forEach(t => times.add(t.time));
  return times.size > 0 ? times : null;
}

// 全场地扫描（SM2 优先 + 浏览器按需降级，取并集）
// SM2 快但偶有漏场/高峰期 401；浏览器慢但全。SM2 成功时跳过浏览器。
async function _scanAllSlotsDirect(venueId, userId) {
  const fields = getFieldsForVenue(venueId);
  if (fields.length === 0) return [];
  const today = new Date().toISOString().split('T')[0];
  const token = readToken(userId);

  if (!token) {
    return await _browserOrHttpsFallback(fields, venueId, today, userId);
  }

  // 🚀 SM2 优先扫描（纯 Node.js，无浏览器开销，~250ms）
  const sm2T0 = Date.now();
  log(`⚡ SM2 扫描（${fields.length} 场）...`);
  let sm2Slots = await _sm2ScanAllSlots(fields, venueId, today, userId);

  // SM2 全空 → 刷新后重试一次
  if (sm2Slots.length === 0) {
    const refreshed = await _sm2RefreshToken();
    if (refreshed) {
      sm2Slots = await _sm2ScanAllSlots(fields, venueId, today, userId);
    }
  }
  const sm2Ms = Date.now() - sm2T0;

  // SM2 覆盖了大部分场地 → 直接返回，跳过慢浏览器
  const sm2FieldSet = new Set(sm2Slots.map(s => s.fieldId));
  const sm2Coverage = fields.filter(f => sm2FieldSet.has(f.id)).length;
  const sm2IsComprehensive = sm2Slots.length > 0 && sm2Coverage >= Math.max(fields.length * 0.5, 1);

  if (sm2IsComprehensive) {
    log(`⚡ SM2 ${sm2Slots.length}个(${sm2Ms}ms)，覆盖${sm2Coverage}/${fields.length}场，跳过浏览器`);
    return sm2Slots;
  }

  // SM2 覆盖不足 → 浏览器降级
  log(`⚠️ SM2 仅${sm2Slots.length}个(${sm2Coverage}/${fields.length}场)，启动浏览器降级...`);
  let browserSlots = [];
  try {
    browserSlots = await Promise.race([
      _browserScanAllSlots(fields, venueId, today, userId),
      new Promise(r => setTimeout(() => r([]), 5000)),
    ]);
  } catch(e) {
    log(`⚠️ 浏览器扫描失败: ${e.message}`);
  }

  // 合并去重（fieldId + startTime 为 key）
  const merged = new Map();
  for (const s of sm2Slots) merged.set(`${s.fieldId}|${s.startTime}`, s);
  for (const s of browserSlots) {
    const k = `${s.fieldId}|${s.startTime}`;
    if (!merged.has(k)) merged.set(k, s);
  }
  const all = [...merged.values()];

  if (sm2Slots.length > 0 && browserSlots.length > 0) {
    const onlyBrowser = browserSlots.filter(b => !sm2Slots.some(s => s.fieldId === b.fieldId && s.startTime === b.startTime));
    log(`🔀 合并: SM2 ${sm2Slots.length}个(${sm2Ms}ms) + 浏览器 ${browserSlots.length}个 → 并集 ${all.length}个${onlyBrowser.length > 0 ? ` (浏览器多${onlyBrowser.length}个)` : ''}`);
  } else if (browserSlots.length > 0) {
    log(`🌐 浏览器 ${browserSlots.length}个，SM2 无结果`);
  }

  if (all.length > 0) return all;

  // 两边都空 → HTTPS 降级
  return await _httpsScanAllSlots(fields, venueId, today, userId);
}

// SM2 并发扫描所有场地（userId 传入避免依赖全局 setCurrentUser）
// 🔐 遇到"未登录"时自动刷新 token 并重试
let _sm2AuthRefreshing = false;  // 防止并发刷新
async function _sm2ScanAllSlots(fields, venueId, today, userId) {
  let authFixed = false;  // 是否已在本轮完成 token 刷新
  const results = await Promise.all(fields.map(async f => {
    const doScan = () => sm2GetBookableTimes(f.id, userId);
    try {
      let r = await doScan();
      // 鉴权错误 → 刷新 token 后重试一次
      if (r && r.code !== 0 && r.msg && /未登录|过期|失效|token|401/.test(r.msg) && !authFixed) {
        if (!_sm2AuthRefreshing) {
          _sm2AuthRefreshing = true;
          try {
            const refreshed = await _sm2RefreshToken();
            if (refreshed) { authFixed = true; r = await doScan(); }
          } finally { _sm2AuthRefreshing = false; }
        } else {
          // 等待其他 field 正在执行的刷新完成
          await new Promise(r => setTimeout(r, 500));
          if (authFixed || _sm2AuthRefreshing === false) r = await doScan();
        }
      }
      if (r && r.code === 0 && r.data) {
        const days = Array.isArray(r.data) ? r.data : [];
        const day = days.find(d => d.date === today) || days[0];
        if (day?.timeSlots) {
          return day.timeSlots.filter(ts => ts.bookable).map(ts => ({
            fieldId: f.id, fieldName: f.name, venueId,
            date: day.date, startTime: ts.startTime,
            endTime: ts.endTime || computeEndTime(ts.startTime),
            price: ts.price || 15,
          }));
        }
      }
      if (r && r.code !== 0 && r.msg) {
        log(`⚠️ SM2 ${f.name}: ${r.msg}`);
      }
    } catch(e) {}
    return [];
  }));
  return results.flat();
}

// 浏览器串行扫描所有场地（同一引擎，必须串行）
async function _browserScanAllSlots(fields, venueId, today, userId) {
  if (fields.length === 0) return [];
  // 确保引擎就绪（切换 token 到当前用户）
  const uid = userId || getCurrentUser();
  try {
    setCurrentUser(uid);
    const engineOk = await _ensurePanelEngine();
    if (!engineOk || !_panelEngine || !_panelEngine.page) {
      log('⚠️ 浏览器引擎不可用');
      return [];
    }
  } catch(e) {
    log(`⚠️ 浏览器引擎启动失败: ${e.message}`);
    return [];
  }

  // 🔒 获取引擎锁（多用户互斥）
  await _acquireEngineLock(uid);

  try {
    const slots = [];
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
                  fieldId: field.id, fieldName: field.name,
                  venueId,
                  date: day.date,
                  startTime: ts.startTime,
                  endTime: ts.endTime || computeEndTime(ts.startTime),
                  price: ts.price || 15,
                });
              }
            }
          }
        }
      } catch(e) {
        // 浏览器崩溃 → 尝试重启引擎，继续扫剩余场地
        const em = e.message || '';
        if (em.includes('closed') || em.includes('Target page') || em.includes('context')) {
          log(`🔄 浏览器崩溃，重启引擎继续...`);
          try { await _panelEngine.close().catch(() => {}); } catch(_) {}
          _panelEngine = null;
          try { await _ensurePanelEngine(); } catch(_) {}
        }
      }
      await sleep(30);
    }
    return slots;
  } finally {
    _releaseEngineLock();
  }
}

// HTTPS 直连扫描（无浏览器降级）
async function _httpsScanAllSlots(fields, venueId, today, userId) {
  log('🔄 降级 HTTPS 直连扫描...');
  const slots = [];
  for (const field of fields) {
    try {
      const result = await directGetBookableTimes(field.id, userId);
      if (result.success && result.code === 0 && result.data) {
        const days = Array.isArray(result.data) ? result.data : [];
        const day = days.find(d => d.date === today) || days[0];
        if (day?.timeSlots) {
          for (const ts of day.timeSlots) {
            if (ts.bookable === true) {
              slots.push({
                fieldId: field.id, fieldName: field.name,
                venueId,
                date: day.date,
                startTime: ts.startTime,
                endTime: ts.endTime || computeEndTime(ts.startTime),
                price: ts.price || 15,
              });
            }
          }
        }
      }
    } catch(e) { /* skip */ }
    await sleep(20);
  }
  return slots;
}

// 无 token 时的降级路径
async function _browserOrHttpsFallback(fields, venueId, today, userId) {
  try {
    const browserSlots = await _browserScanAllSlots(fields, venueId, today, userId);
    if (browserSlots.length > 0) return browserSlots;
  } catch(e) {}
  return await _httpsScanAllSlots(fields, venueId, today, userId);
}

// 从可订时段列表中选最高优先级的一个（puFieldIds 越靠前优先级越高）
function _pickBestSlot(slots, puTimes, puFieldIds) {
  const matching = slots.filter(s => {
    if (puTimes.length > 0 && !puTimes.includes(s.startTime)) return false;
    if (puFieldIds.length > 0 && !puFieldIds.includes(s.fieldId)) return false;
    return true;
  });
  if (matching.length === 0) return null;
  // 排序：时间优先级第一，场地优先级第二（同时间内部按场地优先级）
  matching.sort((a, b) => {
    const timeA = puTimes.length > 0 ? puTimes.indexOf(a.startTime) : -1;
    const timeB = puTimes.length > 0 ? puTimes.indexOf(b.startTime) : -1;
    if (timeA !== timeB) return timeA - timeB; // 时间越靠前越优先
    // 同时间 → 按场地优先级
    const fieldA = puFieldIds.length > 0 ? puFieldIds.indexOf(a.fieldId) : -1;
    const fieldB = puFieldIds.length > 0 ? puFieldIds.indexOf(b.fieldId) : -1;
    if (fieldA !== fieldB) return fieldA - fieldB; // 场地越靠前越优先
    return 0;
  });
  return matching[0];
}

async function startPickup(opts = {}, _userId) {
  if (_pickupState.running) {
    return { success: false, error: '捡漏已在运行中' };
  }

  const userId = _userId || getCurrentUser();
  const cfg = loadConfig(userId);
  if (!cfg) return { success: false, error: '无配置' };

  const venueId = opts.venueId || cfg.pickupVenueId || cfg.venueId || 1;
  const intervalMs = opts.intervalMs || 5000;
  const puTimes = (cfg.pickupTimes || []).map(t => t.time);
  const puFieldIds = (cfg.pickupFields || []).map(f => f.fieldId);

  log(`🔍 捡漏模式启动 — ${getVenueName(venueId)}`);
  log(`⏱ 扫描间隔: ${intervalMs / 1000}s`);
  if (puTimes.length) log(`🕐 时间优先级: ${puTimes.join(' > ')}`);
  else log(`🕐 时间: 不限`);
  if (puFieldIds.length) log(`🏟️ 场地优先级(同时间): ${puFieldIds.join(' > ')}`);
  else log(`🏟️ 场地: 不限`);

  // 初始扫描：见空就抢，但只抢一个最高优先级的
  const snapshot = await _scanAllSlotsDirect(venueId, userId);
  log(`📸 初始扫描: ${snapshot.length} 个可订时段`);

  const booked = [];
  const bestSlot = _pickBestSlot(snapshot, puTimes, puFieldIds);
  if (bestSlot) {
    log(`🎯 发现最佳空位: ${bestSlot.fieldName} ${bestSlot.startTime}-${bestSlot.endTime}，尝试下单...`);
    const result = await quickBookSlot(bestSlot.fieldId, bestSlot.fieldName, bestSlot.startTime, bestSlot.endTime, bestSlot.venueId, userId);
    if (result.success) {
      log(`🎉 捡漏下单成功! ${bestSlot.fieldName} ${bestSlot.startTime} 订单: ${result.orderNo}`);
      booked.push({
        fieldName: bestSlot.fieldName, fieldId: bestSlot.fieldId,
        startTime: bestSlot.startTime, endTime: bestSlot.endTime,
        orderNo: result.orderNo,
        time: new Date().toISOString(),
      });
    } else {
      log(`⚠️ 下单失败: ${result.error || '未知'}`);
    }
  } else {
    log(`📸 初始扫描无匹配空位（时间或场地偏好不匹配）`);
  }

  // 全部当前可订的都记入快照（包括刚抢到的），后续只抢新出现的（退订）
  const knownSlots = new Set();
  snapshot.forEach(s => knownSlots.add(_slotKey(s.fieldId, s.date, s.startTime)));

  _pickupState = {
    running: true, timer: null, knownSlots, booked,
    scanCount: 0, intervalMs, venueId, puTimes, puFieldIds,
  };

  // 轮询：检测退订空位，也只抢最高优先级的一个
  const poll = async () => {
    if (!_pickupState.running) return;
    try {
      _pickupState.scanCount++;
      const current = await _scanAllSlotsDirect(venueId, userId);

      // 收集所有新出现的空位，选最高优先级的一个
      const newSlots = [];
      for (const slot of current) {
        const key = _slotKey(slot.fieldId, slot.date, slot.startTime);
        if (!_pickupState.knownSlots.has(key)) {
          newSlots.push(slot);
        }
      }

      if (newSlots.length > 0) {
        const bestNew = _pickBestSlot(newSlots, _pickupState.puTimes, _pickupState.puFieldIds);
        // 把所有新槽位都加入快照（不论是否匹配偏好）
        newSlots.forEach(s => _pickupState.knownSlots.add(_slotKey(s.fieldId, s.date, s.startTime)));
        if (bestNew) {
          log(`🎯 [捡漏 #${_pickupState.scanCount}] 新空位: ${bestNew.fieldName} ${bestNew.startTime}-${bestNew.endTime}`);
          const result = await quickBookSlot(bestNew.fieldId, bestNew.fieldName, bestNew.startTime, bestNew.endTime, bestNew.venueId, userId);
          if (result.success) {
            log(`🎉 捡漏成功! ${bestNew.fieldName} ${bestNew.startTime} 订单: ${result.orderNo}`);
            _pickupState.booked.push({
              fieldName: bestNew.fieldName, fieldId: bestNew.fieldId,
              startTime: bestNew.startTime, endTime: bestNew.endTime,
              orderNo: result.orderNo,
              time: new Date().toISOString(),
            });
          }
        }
      }

      // 更新快照：保留当前所有可用的
      const currentKeys = new Set(current.map(s => _slotKey(s.fieldId, s.date, s.startTime)));
      _pickupState.knownSlots = currentKeys;
    } catch(e) {
      log(`⚠️ 捡漏扫描出错: ${e.message}`);
    }
    // 调度下一次
    if (_pickupState.running) {
      _pickupState.timer = setTimeout(poll, _pickupState.intervalMs);
    }
  };

  _pickupState.timer = setTimeout(poll, intervalMs);
  return {
    success: true,
    venueId,
    venueName: getVenueName(venueId),
    snapshotCount: snapshot.length,
    initialBooked: booked.length > 0 ? { fieldName: bestSlot.fieldName, startTime: bestSlot.startTime, endTime: bestSlot.endTime, orderNo: booked[0].orderNo } : null,
    initialMsg: bestSlot && booked.length === 0 ? `尝试下单${bestSlot.fieldName} ${bestSlot.startTime}失败: 时间冲突或已预约` : null,
  };
}

function stopPickup() {
  if (!_pickupState.running) {
    return { success: false, error: '捡漏未在运行' };
  }
  if (_pickupState.timer) clearTimeout(_pickupState.timer);
  const booked = [..._pickupState.booked];
  const scanCount = _pickupState.scanCount;
  _pickupState.running = false;
  _pickupState.timer = null;
  log(`🛑 捡漏模式已停止（扫描 ${scanCount} 轮，抢到 ${booked.length} 个）`);
  return { success: true, booked, scanCount };
}

function getPickupStatus() {
  return {
    running: _pickupState.running,
    scanCount: _pickupState.scanCount,
    booked: _pickupState.booked,
    knownSlotsCount: _pickupState.knownSlots?.size || 0,
    intervalMs: _pickupState.intervalMs,
    venueId: _pickupState.venueId,
  };
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
  discoverVenueFields, getFieldsForVenue, getVenueIdForField, VENUE_FIELDS,
  ensurePanelEngine: _ensurePanelEngine,
  startPickup, stopPickup, getPickupStatus,
  // 多用户支持
  setCurrentUser, getCurrentUser, listUsers,
  readToken, readRefreshToken, saveToken, saveFullAuth,
  getUserDir, _getAuthFile, _getConfigFile,
  isTokenExpired, checkTokenValid, verifyTokenNow, markTokenVerified,
  // 优先级
  readPriority, savePriority, loadPriorities,
  // 常量
  USERS_DIR,
};

// ========== CLI 直接运行 ==========
if (require.main === module) {
  main().catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
