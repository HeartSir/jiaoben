/**
 * 🏸 川大场馆自动抢订 - 服务器部署版
 *
 * 原理：用 Playwright 打开网页，通过页面自带的加密引擎完成API调用
 * 部署：可部署到 Render / 阿里云 / 本地定时任务
 *
 * 首次使用:
 *   1. node index.js         # 启动，扫码登录后自动保存登录态
 *   2. 后续每天早上 8:28，脚本自动打开并执行抢场
 *   3. 登录态每7天失效，重新跑一次即可
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const CONFIG = {
  // ===== 抢场时间 =====
  targetHour: 8,
  targetMinute: 30,
  targetSecond: 0,
  preWakeMs: 120000,    // 提前2分钟启动浏览器

  // ===== 场地配置 =====
  primaryWishes: [
    { venue: "3号场", time: "21:00 - 22:00" },
    { venue: "4号场", time: "21:00 - 22:00" },
    { venue: "2号场", time: "21:00 - 22:00" }
  ],
  fallbackVenues: ["3号场","4号场","7号场","8号场","2号场","5号场","6号场","9号场"],
  fallbackTimes: ["21:00 - 22:00","18:00 - 19:00","16:00 - 17:00","19:00 - 20:00","15:00 - 16:00","20:00 - 21:00","14:00 - 15:00","17:00 - 18:00"],

  // ===== 登录态持久化 =====
  authFile: path.join(__dirname, '.venue-auth.json'),
  headless: false,  // 服务器部署改成 true

  // ===== 预约页面 URL =====
  venueUrl: 'https://cgzx.scu.edu.cn/venue/subPackage/venue/venue_reservation?params=[PARAMS]&qrId=C00035000007',
};

const VENUE_URL = 'https://cgzx.scu.edu.cn/venue/subPackage/venue/venue_reservation?params=%5B%7B%22id%22%3A36%2C%22venueId%22%3A1%2C%22name%22%3A%221%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A37%2C%22venueId%22%3A1%2C%22name%22%3A%222%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A38%2C%22venueId%22%3A1%2C%22name%22%3A%223%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A39%2C%22venueId%22%3A1%2C%22name%22%3A%224%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A40%2C%22venueId%22%3A1%2C%22name%22%3A%225%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A41%2C%22venueId%22%3A1%2C%22name%22%3A%226%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A42%2C%22venueId%22%3A1%2C%22name%22%3A%227%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A43%2C%22venueId%22%3A1%2C%22name%22%3A%228%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A44%2C%22venueId%22%3A1%2C%22name%22%3A%229%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%2C%7B%22id%22%3A45%2C%22venueId%22%3A1%2C%22name%22%3A%2210%E5%8F%B7%E5%9C%BA%22%2C%22internalPrice%22%3Anull%2C%22externalPrice%22%3Anull%2C%22studentPrice%22%3A15%2C%22teacherPrice%22%3A25%2C%22familyPrice%22%3A25%2C%22outsidePrice%22%3A50%2C%22eveningEnabled%22%3A0%2C%22eveningConfig%22%3Anull%2C%22eveningConfigDTO%22%3Anull%2C%22holidayEnabled%22%3A1%2C%22holidayConfig%22%3A%22%7B%5C%22prices%5C%22%3A%7B%5C%22student%5C%22%3A%5C%220%5C%22%2C%5C%22teacher%5C%22%3A%5C%225%5C%22%2C%5C%22family%5C%22%3A%5C%225%5C%22%2C%5C%22outside%5C%22%3A%5C%2210%5C%22%7D%7D%22%2C%22holidayConfigDTO%22%3Anull%2C%22status%22%3A0%2C%22createTime%22%3A1742958432000%2C%22venueName%22%3Anull%2C%22campusName%22%3Anull%2C%22campusId%22%3Anull%2C%22availableTimeSlots%22%3Anull%2C%22bookingOrders%22%3Anull%7D%5D&qrId=C00035000007';

// ===== 工具函数 =====
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString('zh-CN', {hour12:false})}] ${msg}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== 核心逻辑 =====
async function main() {
  log('🚀 启动抢场引擎');

  // 1. 启动浏览器 (复用已保存的登录态)
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = fs.existsSync(CONFIG.authFile)
    ? await browser.newContext({ storageState: CONFIG.authFile, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    : await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });

  const page = await context.newPage();

  // 监听网络 - 捕获 token
  let accessToken = '';
  page.on('response', async resp => {
    const url = resp.url();
    if (url.includes('refresh-token') || url.includes('auth/login')) {
      try {
        const json = await resp.json();
        if (json.data?.accessToken) accessToken = json.data.accessToken;
        if (json.accessToken) accessToken = json.accessToken;
      } catch(e) {}
    }
  });

  try {
    // 2. 打开预约页面
    log('📡 打开预约页面...');
    await page.goto(VENUE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // 3. 检查登录状态
    const pageUrl = page.url();
    log(`📍 页面: ${pageUrl}`);

    if (pageUrl.includes('login') || pageUrl.includes('auth')) {
      log('🔑 需要登录 - 请在浏览器中扫码');
      log('⏳ 等待 90 秒...');
      await page.waitForTimeout(90000);

      // 保存登录态
      await context.storageState({ path: CONFIG.authFile });
      log('💾 登录态已保存');

      // 重新导航到预约页
      await page.goto(VENUE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(3000);
    } else {
      log('✅ 已登录');
    }

    // 4. 检查 token
    if (!accessToken) {
      accessToken = await page.evaluate(() => {
        try { return uni.getStorageSync('accessToken') || ''; } catch(e) { return ''; }
      });
    }
    log(`🔑 Token: ${accessToken.substring(0, 30)}...`);

    // 5. 计算等待时间
    const now = new Date();
    const target = new Date();
    target.setHours(CONFIG.targetHour, CONFIG.targetMinute, CONFIG.targetSecond, 0);
    // 如果目标时间已过，加一天
    if (target <= now) target.setDate(target.getDate() + 1);

    const wakeTime = target.getTime() - CONFIG.preWakeMs;
    const waitSec = Math.round((wakeTime - now.getTime()) / 1000);

    if (waitSec > 0) {
      log(`⏳ 等待到 ${CONFIG.targetHour}:${String(CONFIG.targetMinute).padStart(2,'0')}`);
      log(`   浏览器保持打开，将在 ${waitSec} 秒后开始`);
      await sleep(waitSec);
    }

    // 6. 等待精确触发时间
    const exactTarget = target.getTime();
    while (Date.now() < exactTarget - 1000) {
      await sleep(100);
    }
    await sleep(exactTarget - Date.now());

    // 7. ⚡ 发起抢场请求 (API 方式)
    log('⚡ 执行 API 抢场...');

    const apiEndpoint = async (method, apiPath, data) => {
      return await page.evaluate(async ({ method, path, data }) => {
        const http = uni.$u.http;
        if (method === 'GET') return await http.get(path);
        return await http.post(path, data || {});
      }, { method, path: '/app-api' + apiPath, data });
    };

    // 7a. 获取可预约时间段
    const venueFieldIds = { '1号场':36,'2号场':37,'3号场':38,'4号场':39,'5号场':40,'6号场':41,'7号场':42,'8号场':43,'9号场':44,'10号场':45 };

    let booked = false;
    for (const wish of CONFIG.primaryWishes) {
      if (booked) break;
      const fieldId = venueFieldIds[wish.venue];
      if (!fieldId) continue;

      log(`🔍 查询 ${wish.venue} 的 ${wish.time}...`);

      // 获取该场地的可预约时间
      const slots = await apiEndpoint('GET', `/venue/field/get-bookable-times/${fieldId}`);
      log(`   响应: ${JSON.stringify(slots).substring(0, 200)}`);

      if (slots?.code === 200 && slots.data) {
        // 找到对应时间的 slot
        const timeSlots = slots.data;
        const targetTime = wish.time;
        const matched = timeSlots.find(s => s.startTime === targetTime.split(' - ')[0]);

        if (matched && matched.available) {
          log(`🎯 发现可用时间! 创建订单...`);
          const order = await apiEndpoint('POST', '/venue/booking/orders/create', {
            fieldId: fieldId,
            date: new Date().toISOString().split('T')[0],
            timeSlotId: matched.id,
          });
          log(`📦 订单结果: ${JSON.stringify(order)}`);
          if (order?.code === 200) {
            log(`🎉🎉🎉 抢到了 ${wish.venue} ${wish.time}！`);
            booked = true;
            break;
          }
        } else {
          log(`❌ ${wish.venue} ${wish.time} 不可用`);
        }
      }
    }

    // 7b. 如果首发失败，扫荡
    if (!booked) {
      log('♻️ 首发失败，开始扫荡...');
      for (const venue of CONFIG.fallbackVenues) {
        if (booked) break;
        const fieldId = venueFieldIds[venue];
        if (!fieldId) continue;

        const slots = await apiEndpoint('GET', `/venue/field/get-bookable-times/${fieldId}`);
        if (slots?.code === 200 && slots.data) {
          for (const time of CONFIG.fallbackTimes) {
            const slot = slots.data.find(s => s.startTime === time.split(' - ')[0]);
            if (slot && slot.available) {
              log(`🎯 扫荡到 ${venue} ${time}!`);
              const order = await apiEndpoint('POST', '/venue/booking/orders/create', {
                fieldId, timeSlotId: slot.id,
              });
              if (order?.code === 200) {
                log(`🎉 捡漏成功！${venue} ${time}`);
                booked = true;
                break;
              }
            }
          }
        }
      }
    }

    if (!booked) log('😢 全部场地已满');

  } catch (err) {
    log(`❌ 错误: ${err.message}`);
  }

  // 保持开屏以便查看结果
  log('✅ 执行完毕，浏览器保持打开');
}

main().catch(console.error);
