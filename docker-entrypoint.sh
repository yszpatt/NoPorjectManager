#!/bin/sh
# 容器入口：保证「对外暴露」时一定有访问口令。
#
# 容器里必须绑定 0.0.0.0，否则端口映射进不来——也就是说容器版默认就是
# 对外暴露状态。而看板的口令一旦缺失，同一网络内任何人都能读写数据，
# 所以这里在没给 PM_PASSWORD 时自动生成一个。
#
# 认证方式是 HTTP Basic：用户名取自 PM_USER（默认 pm），口令取自 PM_PASSWORD。
set -e

DATA_DIR="${PM_DATA_DIR:-/data}"
PASSWORD_FILE="${DATA_DIR}/.password"
LEGACY_TOKEN_FILE="${DATA_DIR}/.token"
export PM_USER="${PM_USER:-pm}"

# 旧部署用的是 PM_TOKEN，这里当作口令接住，避免升级后认证失效
if [ -z "${PM_PASSWORD:-}" ] && [ -n "${PM_TOKEN:-}" ]; then
  PM_PASSWORD="${PM_TOKEN}"
  echo "[entrypoint] 提示: PM_TOKEN 已更名为 PM_PASSWORD，本次按 PM_PASSWORD 处理" >&2
fi

if [ -z "${PM_PASSWORD:-}" ]; then
  if [ "${PM_ALLOW_ANONYMOUS:-}" = "1" ]; then
    echo "[entrypoint] PM_ALLOW_ANONYMOUS=1：已关闭认证" >&2
    echo "[entrypoint] 请确认只对本机开放端口（例如 -p 127.0.0.1:8930:8930）" >&2
  else
    # 数据目录未必已经存在（镜像里预建了 /data，但换成别的挂载点就未必）
    mkdir -p "${DATA_DIR}"

    # 复用上次生成的口令，否则每次重启都会换新口令，浏览器要重新登录
    if [ -f "${PASSWORD_FILE}" ]; then
      PM_PASSWORD="$(cat "${PASSWORD_FILE}")"
    elif [ -f "${LEGACY_TOKEN_FILE}" ]; then
      # 从旧版令牌迁移：把原令牌原样当作口令，升级后还能从日志/记录里找回
      PM_PASSWORD="$(cat "${LEGACY_TOKEN_FILE}")"
      umask 077
      printf '%s' "${PM_PASSWORD}" > "${PASSWORD_FILE}"
      rm -f "${LEGACY_TOKEN_FILE}"
    else
      PM_PASSWORD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
      umask 077
      printf '%s' "${PM_PASSWORD}" > "${PASSWORD_FILE}"
    fi
    export PM_PASSWORD
    echo "[entrypoint] 访问口令已就绪：用户名 ${PM_USER}，口令 ${PM_PASSWORD}" >&2
    echo "[entrypoint] 看板：http://<主机>:${PM_UI_PORT:-8930}/（浏览器会弹出登录框）" >&2
    echo "[entrypoint] MCP ：http://<主机>:${PM_UI_PORT:-8930}/mcp（与看板共用同一套凭据）" >&2
  fi
fi

exec "$@"
