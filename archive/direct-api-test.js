/**
 * 直接 API 调用 - 纯 Node.js 版本
 * 不需要浏览器！用 sm-crypto 解密服务器响应
 */
const axios = require('axios');
const sm4 = require('sm-crypto').sm4;
const fs = require('fs');
const path = require('path');

const AUTH_FILE = path.join(__dirname, '.venue-auth.json');

// 配置
const BASE_URL = 'https://cgzx.scu.edu.cn/app-api';
const SM4_KEY = 'JeF8U9wHFOMfs2Y8';

// 加载 token
const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
const httpOrigin = auth.origins.find(o => o.origin === 'http://cgzx.scu.edu.cn');
const token = httpOrigin?.localStorage?.find(l => l.name === 'accessToken')?.value;

console.log(`🔑 Token: ${token?.substring(0,20)}...`);

// 创建 axios 实例
const api = axios.create({
  baseURL: BASE_URL,
  headers: {
    'tenant-id': '1',
    'terminal': '10',
    'Authorization': `Bearer ${token}`,
    'X-Timestamp': Date.now().toString(),
  }
});

// SM4 ECB 解密
function sm4Decrypt(hexData) {
  try {
    // sm-crypto 的 decrypt 接受 hex 格式
    const keyHex = Buffer.from(SM4_KEY, 'utf8').toString('hex');
    // key 是 16 bytes = 32 hex chars
    const plain = sm4.decrypt(hexData, keyHex, {
      padding: 'pkcs7',
      mode: 'ecb',
    });
    return plain;
  } catch(e) {
    console.error('解密失败:', e.message);
    return null;
  }
}

async function testAPI(method, path, body) {
  console.log(`\n📡 ${method} ${path}`);
  try {
    const config = {
      method: method.toLowerCase(),
      url: path,
      headers: {
        'X-Timestamp': Date.now().toString(),
      },
      // 不加密请求体，看看原始响应
      responseType: 'json',
    };

    if (body) config.data = body;

    const response = await api(config);
    const data = response.data;

    // 检查响应格式
    console.log(`   状态码: ${response.status}`);
    console.log(`   响应键: ${Object.keys(data).join(', ')}`);

    if (data.sign && data.data) {
      console.log(`   has sign: ✅ (${data.sign.substring(0, 30)}...)`);
      console.log(`   encrypted data: ${data.data.substring(0, 40)}...`);

      // 尝试解密
      const decrypted = sm4Decrypt(data.data);
      if (decrypted) {
        try {
          const parsed = JSON.parse(decrypted);
          console.log(`   解密成功!`);
          console.log(`   code: ${parsed.code}, msg: ${parsed.msg || ''}`);
          if (parsed.data) {
            const dataStr = JSON.stringify(parsed.data).substring(0, 500);
            console.log(`   data: ${dataStr}`);
          }
        } catch(e) {
          console.log(`   解密结果(非JSON): ${decrypted.substring(0, 200)}`);
        }
      }
    } else if (data.code !== undefined) {
      // 可能直接返回了明文
      console.log(`   code: ${data.code}, msg: ${data.msg || ''}`);
      if (data.data) {
        console.log(`   data: ${JSON.stringify(data.data).substring(0, 500)}`);
      }
    } else if (data.encrypted || data.ciphertext) {
      console.log(`   加密数据: ${JSON.stringify(data).substring(0, 200)}`);
    } else {
      console.log(`   原始响应: ${JSON.stringify(data).substring(0, 500)}`);
    }

    return data;
  } catch(e) {
    console.log(`   ❌ 错误: ${e.message}`);
    if (e.response) {
      console.log(`   响应状态: ${e.response.status}`);
      console.log(`   响应: ${JSON.stringify(e.response.data).substring(0, 300)}`);
    }
    return null;
  }
}

(async () => {
  // 测试几个 API
  console.log('\n========== 直接 API 测试 ==========');

  // 1. 场馆列表
  await testAPI('GET', '/venue/venue/list');

  // 2. 用户信息
  await testAPI('GET', '/member/user/get');

  // 3. 可预约时间段
  await testAPI('GET', '/venue/field/get-bookable-times/38');

  // 4. 预订配置
  await testAPI('GET', '/venue/booking-config/getConfig');

  console.log('\n========== 完成 ==========');
})();
