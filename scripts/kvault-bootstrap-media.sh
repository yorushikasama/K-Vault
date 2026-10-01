#!/usr/bin/env bash
#
# kvault-bootstrap-media - 幂等安装"视频解析"相关的一切运行时依赖
#
# 内容：yt-dlp、ffmpeg、Playwright + Chromium（抓抖音游客 Cookie 用）、
#       Cookie 抓取脚本、两个 systemd timer（Cookie 续期 / yt-dlp 更新）
#
# 设计原则：每一步都先判断再装，重复执行是安全的；装不上不阻断部署，
# 但必须留下能被 /api/resolve-url/status 反映出来的痕迹。
#
# 用法：sudo kvault-bootstrap-media [REPO_DIR]   （默认 /opt/k-vault）

set -euo pipefail

REPO="${1:-/opt/k-vault}"
VENV=/opt/kvault-cb
ENV_FILE=/etc/kvault.env
SERVICE_USER=kvault

step(){ printf '\n==> %s\n' "$*"; }
fail(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
warn(){ printf 'WARNING: %s\n' "$*" >&2; }

[ "$(id -u)" -eq 0 ] || fail "需要 root：sudo $0"

ensure_env_var(){
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '    已有 %s，保持不动\n' "$key"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    printf '    已写入 %s=%s\n' "$key" "$value"
  fi
}

step "1/5 yt-dlp 与 ffmpeg"
if ! command -v yt-dlp >/dev/null 2>&1; then
  printf '    安装 yt-dlp…\n'
  curl -fsSL -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    || fail "yt-dlp 下载失败"
  chmod 755 /usr/local/bin/yt-dlp
fi
printf '    yt-dlp %s\n' "$(yt-dlp --version 2>&1)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg >/dev/null
fi
command -v ffmpeg >/dev/null 2>&1 \
  || warn "ffmpeg 不可用：分离音视频流（B站/YouTube）将无法合并，只能播单一流格式"
printf '    ffmpeg %s\n' "$(ffmpeg -version 2>/dev/null | head -n1 | cut -d' ' -f3 || echo 不可用)"

step "2/5 Python venv + Playwright（抓游客 Cookie）"
if [ ! -x "$VENV/bin/python" ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv >/dev/null
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" show playwright >/dev/null 2>&1 || "$VENV/bin/pip" install -q playwright
if [ -z "$(ls "$HOME/.cache/ms-playwright" 2>/dev/null)" ]; then
  "$VENV/bin/playwright" install --with-deps chromium
else
  printf '    Chromium 已就绪\n'
fi

step "3/5 Cookie 抓取脚本（从仓库安装，保证版本一致）"
HARVEST_SRC="$REPO/scripts/douyin-cookie-harvest.py"
[ -f "$HARVEST_SRC" ] || fail "仓库里找不到 $HARVEST_SRC"
install -m 644 "$HARVEST_SRC" "$VENV/harvest-douyin.py"
printf '    已安装 %s（首行: %s）\n' "$VENV/harvest-douyin.py" "$(head -n1 "$VENV/harvest-douyin.py")"

step "4/5 systemd timer：Cookie 续期 + yt-dlp 更新"
DATA_DIR_VALUE=$(grep -E '^DATA_DIR=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-)
DATA_DIR_VALUE=${DATA_DIR_VALUE:-/opt/k-vault/data}
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR_VALUE/cookies"

cat > /tmp/kv-douyin.service <<UNIT
[Unit]
Description=K-Vault - refresh Douyin guest cookies for media resolve
After=network-online.target

[Service]
Type=oneshot
Environment=DATA_DIR=$DATA_DIR_VALUE
ExecStart=$VENV/bin/python $VENV/harvest-douyin.py
TimeoutStartSec=600
UNIT
cat > /tmp/kv-douyin.timer <<UNIT
[Unit]
Description=K-Vault - refresh Douyin guest cookies daily at 04:30

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=1800
Persistent=true
Unit=kvault-douyin-cookies.service

[Install]
WantedBy=timers.target
UNIT
cat > /tmp/kv-ytdlp.service <<UNIT
[Unit]
Description=K-Vault - self-update yt-dlp
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/yt-dlp -U
TimeoutStartSec=300
UNIT
cat > /tmp/kv-ytdlp.timer <<UNIT
[Unit]
Description=K-Vault - refresh yt-dlp weekly

[Timer]
OnCalendar=Mon *-*-* 05:10:00
RandomizedDelaySec=1800
Persistent=true
Unit=kvault-ytdlp-update.service

[Install]
WantedBy=timers.target
UNIT
install -m 644 /tmp/kv-douyin.service /etc/systemd/system/kvault-douyin-cookies.service
install -m 644 /tmp/kv-douyin.timer   /etc/systemd/system/kvault-douyin-cookies.timer
install -m 644 /tmp/kv-ytdlp.service  /etc/systemd/system/kvault-ytdlp-update.service
install -m 644 /tmp/kv-ytdlp.timer    /etc/systemd/system/kvault-ytdlp-update.timer
rm -f /tmp/kv-douyin.service /tmp/kv-douyin.timer /tmp/kv-ytdlp.service /tmp/kv-ytdlp.timer
systemctl daemon-reload
systemctl enable --now kvault-douyin-cookies.timer kvault-ytdlp-update.timer
printf '    Cookie 续期: %s / yt-dlp 更新: %s\n' \
  "$(systemctl is-active kvault-douyin-cookies.timer)" \
  "$(systemctl is-active kvault-ytdlp-update.timer)"

step "5/5 环境变量（缺才补，已有不覆盖）"
[ -f "$ENV_FILE" ] || touch "$ENV_FILE"
ensure_env_var "MEDIA_RESOLVE_TEMP_DIR" "$DATA_DIR_VALUE/tmp"
ensure_env_var "MEDIA_RESOLVE_COOKIES_FILE" "$DATA_DIR_VALUE/cookies/douyin.cookies.txt"
mkdir -p "$DATA_DIR_VALUE/tmp" "$DATA_DIR_VALUE/cookies"
chown -R "$SERVICE_USER":"$SERVICE_USER" "$DATA_DIR_VALUE/tmp" "$DATA_DIR_VALUE/cookies" 2>/dev/null || true
chmod 700 "$DATA_DIR_VALUE/cookies" 2>/dev/null || true
printf '    建议复查: %s\n' "$ENV_FILE"

printf '\nBootstrap 完成。注意：\n'
printf '  - Cookie 首次抓取需要手动跑一次：%s/bin/python %s/harvest-douyin.py\n' "$VENV" "$VENV"
printf '  - 抓取/续期需要能访问 douyin.com；若服务器在境外，是否可行只能实测\n'
printf '  - Chromium 缓存在 root 的 ~/.cache/ms-playwright，勿随仓库迁移\n'
