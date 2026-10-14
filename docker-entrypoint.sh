#!/bin/sh
# 容器入口：保证「对外暴露」时一定有访问令牌。
#
# 容器里必须绑定 0.0.0.0，否则端口映射进不来——也就是说容器版默认就是
# 对外暴露状态。而看板的口令一旦缺失，同一网络内任何人都能读写数据，
# 所以这里在没给 PM_TOKEN 时自动生成一个。
set -e

DATA_DIR="${PM_DATA_DIR:-/data}"
TOKEN_FILE="${DATA_DIR}/.token"

if [ -z "${PM_TOKEN:-}" ]; then
  if [ "${PM_ALLOW_ANONYMOUS:-}" = "1" ]; then
    echo "[entrypoint] PM_ALLOW_ANONYMOUS=1：已关闭访问令牌校验" >&2
    echo "[entrypoint] 请确认只对本机开放端口（例如 -p 127.0.0.1:8930:8930）" >&2
  else
    # 数据目录未必已经存在（镜像里预建了 /data，但换成别的挂载点就未必）
    mkdir -p "${DATA_DIR}"

    # 复用上次生成的令牌，否则每次重启都会让浏览器里存的令牌失效
    if [ -f "${TOKEN_FILE}" ]; then
      PM_TOKEN="$(cat "${TOKEN_FILE}")"
    else
      PM_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))')"
      umask 077
      printf '%s' "${PM_TOKEN}" > "${TOKEN_FILE}"
    fi
    export PM_TOKEN
    echo "[entrypoint] 访问令牌：${PM_TOKEN}" >&2
    echo "[entrypoint] 打开看板：http://<主机>:${PM_UI_PORT:-8930}/?token=${PM_TOKEN}" >&2
  fi
fi

exec "$@"
