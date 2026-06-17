const path = require('path');
const fs = require('fs');
const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // 打开场馆页面
  await page.goto('https://cgzx.scu.edu.cn/venue/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 5000));

  // 注入 token
  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const origin = auth.origins?.find(o => ['https://cgzx.scu.edu.cn','http://cgzx.scu.edu.cn'].includes(o.origin));
  const token = origin?.localStorage?.find(l => l.name === 'accessToken')?.value;
  const rt = origin?.localStorage?.find(l => l.name === 'refreshToken')?.value;
  if (token) {
    await page.evaluate(({t, r}) => { try { uni.setStorageSync('accessToken', t); if(r) uni.setStorageSync('refreshToken', r); } catch(e){} }, {t: token, r: rt});
  }

  // 等 uni 就绪
  for (let i = 0; i < 20; i++) {
    const ready = await page.evaluate(() => { try { return typeof uni !== 'undefined' && !!uni.$u?.http; } catch(e) { return false; } }).catch(() => false);
    if (ready) break;
    await new Promise(r => setTimeout(r, 2000));
  }

  // 获取 userId
  const userId = await page.evaluate(() => {
    try {
      const raw = uni.getStorageSync('userInfo');
      const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return info?.data?.userId || info?.userId || null;
    } catch(e) { return null; }
  });
  console.log('userId:', userId);

  // 先在页面里看看当前能拿到什么场地数据
  const venueInfo = await page.evaluate(async () => {
    try {
      // 查华西体育馆羽毛球场 (venueId=9) 的详情
      const res = await uni.$u.http.get('/app-api/venue/venue/detail?id=9');
      return { code: res.code, data: JSON.stringify(res.data).substring(0, 2000) };
    } catch(e) {
      return { code: e.code, msg: e.msg };
    }
  });
  console.log('\nvenue detail (venueId=9):', JSON.stringify(venueInfo));

  // 试试场地详情
  for (const fid of [1,2,3,4,5,6,7,8,36,37,38,39,40,46,47,48,49,50]) {
    const fi = await page.evaluate(async (id) => {
      try {
        const res = await uni.$u.http.get('/app-api/venue/field/get/' + id);
        return { code: res.code, data: JSON.stringify(res.data).substring(0, 300) };
      } catch(e) {
        return { code: e.code, msg: e.msg };
      }
    }, fid);
    if (fi.code === 0 && fi.data && fi.data !== '{}') {
      console.log(`  fieldId=${fid}: ${fi.data}`);
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
