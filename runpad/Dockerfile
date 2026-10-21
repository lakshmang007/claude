# RunPad with the toolchains it can run. Build:  docker build -t runpad .
# Run:  docker run -p 3000:3000 -v runpad-data:/data runpad
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 gcc g++ libc6-dev default-jdk-headless golang-go rustc \
      ruby php-cli perl lua5.4 bash coreutils util-linux procps ca-certificates \
 && ln -sf /usr/bin/lua5.4 /usr/local/bin/lua \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin runner
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# The server stays root inside the container so it can start programs as the unprivileged
# `runner` user, which cannot read /data.
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 RUNPAD_DATA=/data RUNPAD_WORK=/tmp/runpad RUNPAD_EXEC_UID=10001
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/_api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.js"]
