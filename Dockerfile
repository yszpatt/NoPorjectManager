# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 前端构建阶段
# ---------------------------------------------------------------------------
FROM node:24-alpine AS web
WORKDIR /build/web
# 先只拷依赖清单：依赖没变时这层可以复用缓存
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY web/ ./
RUN npm run build

# ---------------------------------------------------------------------------
# 运行时阶段
# ---------------------------------------------------------------------------
FROM node:24-alpine

# 早失败：本项目用内建 node:sqlite（Node ≥ 22.5）。基础镜像若不含它，
# 镜像能构建成功但一跑就崩——不如在这里就拦下来
RUN node -e "const { DatabaseSync } = require('node:sqlite'); new DatabaseSync(':memory:').close();"

# git：commit 采集要用；tzdata：让 TZ 生效，否则「今天」会按 UTC 算，
# 每日计划与动态流的日期分组都会错位
RUN apk add --no-cache git tzdata

LABEL org.opencontainers.image.title="NoProjectManager" \
      org.opencontainers.image.description="本地优先的项目管理看板：Markdown 事实源 + SQLite 索引 + MCP 服务" \
      org.opencontainers.image.source="https://github.com/yszpatt/NoProjectManager" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# 容器里必须绑 0.0.0.0，否则端口映射进不来（入口脚本会因此强制要求访问令牌）
ENV NODE_ENV=production \
    PM_DATA_DIR=/data \
    PM_UI_PORT=8930 \
    PM_HTTP_PORT=8931 \
    PM_HOST=0.0.0.0

# 只装运行时依赖。注意 tsx 在 dependencies 里——入口是 TypeScript，
# 运行期由 tsx 直接执行，没有构建产物这一步
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit && npm cache clean --force

COPY bin/ ./bin/
COPY src/ ./src/
COPY scripts/healthcheck.mjs ./scripts/
COPY docker-entrypoint.sh /usr/local/bin/
COPY --from=web /build/web/dist ./web/dist

# /data 的属主决定具名卷的初始权限；绑定挂载则由宿主机决定，需自行保证 uid 1000 可写
RUN mkdir -p /data \
 && chown -R node:node /data \
 && chmod +x /usr/local/bin/docker-entrypoint.sh

USER node

VOLUME ["/data"]
# 看板 UI、REST API 与 MCP(HTTP) 全在这一个端口上（MCP 端点是 /mcp）
EXPOSE 8930

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "scripts/healthcheck.mjs"]

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "bin/pm.mjs", "serve"]
