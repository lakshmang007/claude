# RunPad with the toolchains it can run.
#   docker build -t runpad .
#   For a public server, use deploy/docker-compose.yml (HTTPS, limits, firewall).
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
      ruby php-cli perl lua5.4 bash coreutils util-linux procps iptables ca-certificates \
 && ln -sf /usr/bin/lua5.4 /usr/local/bin/lua \
 && rm -rf /var/lib/apt/lists/* \
 # Programs may write only in their own run directory.
 && chmod 0755 /tmp /var/tmp \
 && mkdir -p /work /data && chmod 0711 /work && chmod 0700 /data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
# The server stays root inside the container so it can start every program as a user of
# its own (from RUNPAD_EXEC_UIDS) and firewall those users off the network (NET_ADMIN).
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 RUNPAD_DATA=/data RUNPAD_WORK=/work RUNPAD_EXEC_UIDS=20000-20999
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/_api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server/index.js"]
