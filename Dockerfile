# 🏸 川大场馆抢订系统 - Docker 部署
FROM node:20-bookworm-slim

# 安装 Chromium 系统依赖
RUN apt-get update -qq && apt-get install -y -qq \
    libnss3 libnspr4 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
    libgbm1 libasound2 libxshmfence1 libxcomposite1 libxdamage1 \
    libxrandr2 libpango-1.0-0 libcairo2 libcups2 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 装 Node 依赖
COPY package.json package-lock.json* ./
RUN npm install

# 下载 Chromium
RUN npx playwright install chromium

# 复制源码
COPY . .

ENV PORT=3456
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/render/.cache/ms-playwright
ENV RENDER_DATA_DIR=/data

EXPOSE 3456

CMD ["node", "dashboard.js"]
