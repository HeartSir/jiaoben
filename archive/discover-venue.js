const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

function getUserId() {
  try {
    const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
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
  } catch(e) {}
  return null;
}

async function main() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  await page.goto('https://cgzx.scu.edu.cn/venue/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const origin = auth.origins?.find(o => ['https://cgzx.scu.edu.cn','http://cgzx.scu.edu.cn'].includes(o.origin));
  const token = origin?.localStorage?.find(l => l.name === 'accessToken')?.value;
  const rt = origin?.localStorage?.find(l => l.name === 'refreshToken')?.value;
  const rawUserInfo = origin?.localStorage?.find(l => l.name === 'userInfo')?.value;
  if (token) {
    await page.evaluate(({t, r, u}) => {
      try { uni.setStorageSync('accessToken', t); if(r) uni.setStorageSync('refreshToken', r); if(u) uni.setStorageSync('userInfo', u); }
      catch(e){}
    }, {t: token, r: rt, u: rawUserInfo});
  }

  for (let i = 0; i < 20; i++) {
    const ready = await page.evaluate(() => { try { return typeof uni !== 'undefined' && !!uni.$u?.http; } catch(e) { return false; } }).catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // 刷新 token
  const refreshed = await page.evaluate(async () => {
    try {
      const ok = await uni.$u.http.get('/app-api/member/user/get');
      if (ok.code === 0) return true;
    } catch(e) {}
    try {
      const rt = uni.getStorageSync('refreshToken');
      const res = await uni.$u.http.post('/app-api/member/auth/refresh-token', { refreshToken: rt });
      if (res.code === 0 && res.data?.accessToken) {
        uni.setStorageSync('accessToken', res.data.accessToken);
        if (res.data.refreshToken) uni.setStorageSync('refreshToken', res.data.refreshToken);
        return true;
      }
    } catch(e) {}
    return false;
  });
  if (!refreshed) { console.log('❌ Token 无效'); await browser.close(); return; }
  console.log('✅ Token 有效');

  const userId = getUserId();
  console.log('userId:', userId);

  const today = new Date().toISOString().split('T')[0];
  console.log('date:', today);

  // 试所有可能的 fieldId
  console.log('\n=== 预约测试 venueId=9 ===');
  for (const fieldId of [1, 2, 3, 4, 5, 6, 7, 8, 46, 47, 48, 49, 50, 51, 52]) {
    await new Promise(r => setTimeout(r, 200)); // 间隔避免限流
    const result = await page.evaluate(async ({venueId, fieldId, userId, date}) => {
      const http = uni.$u.http;
      // 先用 get-bookable-times 看看这个场地属于哪个场馆
      try {
        const timesRes = await http.get('/app-api/venue/field/get-bookable-times/' + fieldId);
        if (timesRes.code === 0 && timesRes.data) {
          const days = Array.isArray(timesRes.data) ? timesRes.data : [];
          const day = days.find(d => d.date === date) || days[0];
          const slots = day?.timeSlots || [];
          // 找一个 bookable 的时间
          const avail = slots.find(s => s.bookable === true);
          if (avail) {
            // 尝试下单
            const orderRes = await http.post('/app-api/venue/booking/orders/create', {
              bookings: [{
                venueId: venueId,
                fieldId,
                startTime: avail.startTime,
                endTime: avail.endTime,
                bookingDate: date,
              }],
              userId,
              venueId,
              couponId: '',
            });
            return { fieldId, success: orderRes.code === 0, code: orderRes.code, msg: orderRes.msg, data: orderRes.data };
          } else {
            return { fieldId, success: false, msg: '该场地当前无可约时段', slots: slots.map(s => `${s.startTime}=${s.bookable?'可':'满'}`).join(',') };
          }
        } else {
          return { fieldId, success: false, msg: `查询失败 code=${timesRes.code}`, raw: JSON.stringify(timesRes).substring(0,200) };
        }
      } catch(e) {
        return { fieldId, success: false, msg: e.msg || 'error' };
      }
    }, { venueId: 9, fieldId, userId, date: today });
    console.log(`fieldId=${result.fieldId}: ${result.success ? '✅ 成功!' : '❌'} ${result.msg} ${result.slots||''}`);
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
