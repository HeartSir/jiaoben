/**
 * setup.js - 部署环境初始化
 *
 * 在服务器上首次部署时运行：node setup.js
 * 1. 下载 Chromium
 * 2. 创建默认 config.json（如果不存在）
 * 3. 验证环境
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const { createWriteStream, existsSync, mkdirSync } = fs;

// ========== 配置 ==========
const CHROMIUM_REVISION = '1228';
const CHROMIUM_DIR = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp',
  '.cache', 'ms-playwright');
const BASE_DIR = __dirname;

const CHROMIUM_URLS = [
  // 主 Chromium
  {
    name: 'chromium',
    dirName: `chromium-${CHROMIUM_REVISION}`,
    url: `https://cdn.playwright.dev/builds/cft/149.0.7827.55/${process.platform === 'win32' ? 'win64/chrome-win64.zip' : process.platform === 'darwin' ? 'mac-arm64/chrome-mac-arm64.zip' : 'linux64/chrome-linux64.zip'}`,
    extractFolder: process.platform === 'win32' ? 'chrome-win64' : process.platform === 'darwin' ? 'chrome-mac-arm64' : 'chrome-linux64',
    executable: process.platform === 'win32' ? 'chrome.exe' : 'chrome',
    checkFile: process.platform === 'win32' ? 'chrome.exe' : 'chrome',
  },
  // Headless shell（Linux 需要）
  ...(process.platform === 'linux' ? [{
    name: 'chromium-headless-shell',
    dirName: `chromium_headless_shell-${CHROMIUM_REVISION}`,
    url: 'https://cdn.playwright.dev/builds/cft/149.0.7827.55/linux64/chrome-headless-shell-linux64.zip',
    extractFolder: 'chrome-headless-shell-linux64',
    executable: 'chrome-headless-shell',
    checkFile: 'chrome-headless-shell',
  }] : []),
];

// ========== 工具函数 ==========

function log(msg) {
  console.log(`[setup] ${msg}`);
}

async function download(url, destPath, label) {
  log(`⬇️  下载 ${label}...`);

  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = createWriteStream(destPath);

    const req = proto.get(url, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      const total = parseInt(response.headers['content-length'] || '0');
      let downloaded = 0;
      let lastPct = -1;

      response.on('data', chunk => {
        downloaded += chunk.length;
        file.write(chunk);
        if (total > 0) {
          const pct = Math.round(downloaded * 100 / total);
          if (pct !== lastPct) {
            lastPct = pct;
            process.stdout.write(`\r  📥 ${label}: ${pct}% (${Math.round(downloaded / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`);
          }
        }
      });

      response.on('end', () => {
        process.stdout.write('\n');
        file.end();
      });

      file.on('finish', () => {
        log(`✅ ${label} 下载完成`);
        resolve();
      });
    });

    req.on('error', reject);
    req.setTimeout(600000, () => { req.destroy(); reject(new Error('下载超时')); });
  });
}

async function extractZip(zipPath, targetDir, extractFolder) {
  log(`📦 解压 ${path.basename(zipPath)}...`);
  const tmpDir = path.join(path.dirname(zipPath), 'extract-tmp');

  if (existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  // 使用系统 unzip（跨平台）
  try {
    if (process.platform === 'win32') {
      // Windows: 使用 PowerShell
      execSync(`powershell -command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe', timeout: 120000 });
    } else {
      execSync(`unzip -o "${zipPath}" -d "${tmpDir}"`, { stdio: 'pipe', timeout: 120000 });
    }
  } catch (e) {
    // 如果系统 unzip 失败，尝试 npm unzip (playwright 依赖自带)
    try {
      execSync(`node -e "const z=require('child_process'); z.execSync('npx playwright install chromium',{stdio:'inherit',timeout:300000})"`, { stdio: 'inherit', timeout: 300000, cwd: BASE_DIR });
      log('✅ 已通过 npx playwright install chromium 安装 Chromium');
      return; // playwright 自己处理了解压
    } catch(e2) {
      throw new Error(`解压失败，请手动安装: unzip ${zipPath}`);
    }
  }

  const extracted = path.join(tmpDir, extractFolder);
  if (existsSync(extracted)) {
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    // 移动所有文件
    const items = fs.readdirSync(extracted);
    for (const item of items) {
      const src = path.join(extracted, item);
      const dst = path.join(targetDir, item);
      fs.renameSync(src, dst);
    }
  }

  // 清理
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(zipPath); } catch (e) {}
  log(`✅ 解压完成: ${targetDir}`);
}

// ========== 主流程 ==========

async function main() {
  console.log('\n  🏸 川大场馆抢订系统 — 部署初始化\n');

  // ---- Step 1: 检查 Node.js 版本 ----
  log(`Node.js: ${process.version}`);
  if (parseInt(process.version.slice(1)) < 18) {
    log('⚠️ 建议 Node.js >= 18');
  }

  // ---- Step 2: 安装 npm 依赖 ----
  if (!existsSync(path.join(BASE_DIR, 'node_modules', 'express'))) {
    log('📦 安装 npm 依赖...');
    execSync('npm install --production', { cwd: BASE_DIR, stdio: 'inherit', timeout: 120000 });
    log('✅ npm 依赖安装完成');
  } else {
    log('✅ npm 依赖已存在');
  }

  // ---- Step 3: 下载/检查 Chromium ----
  mkdirSync(CHROMIUM_DIR, { recursive: true });

  for (const item of CHROMIUM_URLS) {
    const targetDir = path.join(CHROMIUM_DIR, item.dirName);
    const checkPath = path.join(targetDir, item.checkFile);

    if (existsSync(checkPath)) {
      log(`✅ ${item.name} 已安装: ${targetDir}`);
      continue;
    }

    log(`🌐 需要下载 ${item.name} (约200MB)...`);
    const zipPath = path.join(require('os').tmpdir(), `${item.name}.zip`);
    await download(item.url, zipPath, item.name);
    await extractZip(zipPath, targetDir, item.extractFolder);

    if (!existsSync(checkPath)) {
      log(`❌ ${item.name} 解压后未找到可执行文件`);
      log(`   期望路径: ${checkPath}`);
      log('   请尝试手动安装: npx playwright install chromium');
      process.exit(1);
    }
  }

  // ---- Step 4: 设置环境变量 ----
  const pwDir = path.join(CHROMIUM_DIR, `chromium-${CHROMIUM_REVISION}`,
    process.platform === 'win32' ? 'chrome-win64' :
    process.platform === 'darwin' ? 'chrome-mac-arm64' : 'chrome-linux64');

  log(`\n📌 环境变量设置 (添加到 .env 或启动脚本):`);
  log(`  export PLAYWRIGHT_BROWSERS_PATH="${CHROMIUM_DIR}"`);
  log(`  export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${path.join(pwDir, process.platform === 'win32' ? 'chrome.exe' : 'chrome')}"`);

  // ---- Step 5: 创建默认 config.json ----
  const configFile = path.join(BASE_DIR, 'config.json');
  if (!existsSync(configFile)) {
    const defaultConfig = {
      venueId: 1,
      targetHour: 8,
      targetMinute: 30,
      targetSecond: 0,
      preWakeMs: 120000,
      wishes: [
        { name: '3号场', fieldId: 38, time: '21:00', timeEnd: '22:00', enabled: true },
      ],
      fallbackEnabled: true,
      fallbackVenues: [
        { name: '3号场', fieldId: 38 },
        { name: '4号场', fieldId: 39 },
      ],
      fallbackTimes: [
        { time: '21:00', timeEnd: '22:00' },
      ],
    };
    fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));
    log(`✅ 已创建默认配置: ${configFile}`);
  } else {
    log(`✅ 配置已存在: ${configFile}`);
  }

  // ---- Step 6: 最终检查 ----
  log('\n🔍 环境检查:');
  log(`  Node.js:        ${process.version} ${process.platform}`);
  log(`  Chromium:       ${existsSync(path.join(CHROMIUM_DIR, `chromium-${CHROMIUM_REVISION}`)) ? '✅' : '❌'}`);
  log(`  Dashboard:      ${existsSync(path.join(BASE_DIR, 'dashboard.js')) ? '✅' : '❌'}`);
  log(`  Public:         ${existsSync(path.join(BASE_DIR, 'public', 'index.html')) ? '✅' : '❌'}`);
  log(`  Config:         ${existsSync(configFile) ? '✅' : '❌'}`);

  console.log(`\n  🎯 部署完成！启动服务:`);
  console.log(`  ─────────────────────────────`);
  console.log(`  PLAYWRIGHT_BROWSERS_PATH="${CHROMIUM_DIR}"`);
  console.log(`  PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="${path.join(pwDir, process.platform === 'win32' ? 'chrome.exe' : 'chrome')}"`);
  console.log(`  node dashboard.js`);
  console.log(`  ─────────────────────────────`);
  console.log(`  📍 访问 http://localhost:3456\n`);
}

main().catch(err => {
  console.error('\n❌ 初始化失败:', err.message);
  process.exit(1);
});
