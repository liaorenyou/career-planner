#!/bin/bash
# 安装 career-planner 的 launchd 每日 08:00 推送兜底（不依赖 DSH 进程）。
#
# 用法：
#   ./launchd/install.sh                # 安装并加载（幂等：会先卸载旧的再加载）
#   ./launchd/install.sh --uninstall    # 卸载
#   NODE_BIN=/opt/homebrew/bin/node ./launchd/install.sh   # 指定 node 路径
#
# 安装后：
#   launchctl print gui/$(id -u)/com.local.career-planner.push   # 看状态/下次触发时间
#   tail -f ~/.dsh/career-planner/push-cron.log                  # 看每次推送结果

set -euo pipefail

LABEL="com.local.career-planner.push"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_SRC="$SCRIPT_DIR/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

log() { printf '%s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,12p' "$0" | sed -e 's/^# \{0,1\}//'
}

uninstall() {
  if [ -f "$PLIST_DST" ]; then
    launchctl bootout "$DOMAIN" "$PLIST_DST" 2>/dev/null || launchctl unload -w "$PLIST_DST" 2>/dev/null || true
    rm -f "$PLIST_DST"
    log "已卸载：$PLIST_DST"
  else
    log "未安装：$PLIST_DST 不存在"
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  fi
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    log "注意：服务仍在运行，可执行 launchctl bootout $DOMAIN/$LABEL"
  fi
  exit 0
}

case "${1:-}" in
  --uninstall|-u) uninstall ;;
  --help|-h) usage; exit 0 ;;
esac

[ -f "$PLIST_SRC" ] || die "找不到模板：$PLIST_SRC"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -n "$NODE_BIN" ] || die "找不到 node；先安装 Node 24+，或用 NODE_BIN=/path/to/node 指定"
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
[ -x "$NODE_BIN" ] || die "node 不可执行：$NODE_BIN"
# nvm/volta 的 node 常是符号链接：取真实可执行文件路径，避免 launchd 环境里链接失效
REAL_NODE_BIN="$("$NODE_BIN" -p 'process.execPath' 2>/dev/null || true)"
if [ -n "$REAL_NODE_BIN" ] && [ -x "$REAL_NODE_BIN" ]; then
  NODE_BIN="$REAL_NODE_BIN"
fi

TARGET_SCRIPT="$PKG_DIR/bin/push-cron.mjs"
[ -f "$TARGET_SCRIPT" ] || die "找不到推送脚本：$TARGET_SCRIPT"

if [ ! -f "$DSH_HOME_DIR/career-planner/profile.json" ]; then
  log "提示：$DSH_HOME_DIR/career-planner/profile.json 还不存在。"
  log "      先在 DSH 面板里打开一次 career-planner 插件，否则第一次触发会以退出码 2 结束。"
fi

case "$(date +%Z)" in
  CST) : ;;
  *) log "提示：系统时区是 $(date +%Z)，不是 Asia/Shanghai(CST)。launchd 按系统本地时间触发，"
     log "      如需固定 8:00 北京时间：sudo systemsetup -settimezone Asia/Shanghai" ;;
esac

mkdir -p "$HOME/Library/LaunchAgents" "$DSH_HOME_DIR/career-planner"

# sed 替换：转义替换串里的 & 和 |（路径里极少出现，但避免踩坑）
esc() { printf '%s' "$1" | sed -e 's/[&|]/\\&/g'; }

sed -e "s|__NODE__|$(esc "$NODE_BIN")|g" \
    -e "s|__SCRIPT__|$(esc "$TARGET_SCRIPT")|g" \
    -e "s|__PKG__|$(esc "$PKG_DIR")|g" \
    -e "s|__DSHHOME__|$(esc "$DSH_HOME_DIR")|g" \
    "$PLIST_SRC" > "$PLIST_DST"
chmod 644 "$PLIST_DST"

log "已写入：$PLIST_DST"
log "  node:   $NODE_BIN"
log "  script: $TARGET_SCRIPT"
log "  data:   $DSH_HOME_DIR/career-planner"

# 幂等安装：先卸掉旧 job（有就卸，没有就继续）
launchctl bootout "$DOMAIN" "$PLIST_DST" 2>/dev/null || true
if launchctl bootstrap "$DOMAIN" "$PLIST_DST" 2>/dev/null; then
  log "已加载：launchctl bootstrap $DOMAIN"
elif launchctl load -w "$PLIST_DST" 2>/dev/null; then
  log "已加载：launchctl load -w（旧接口）"
else
  die "launchctl 加载失败，请手动运行：launchctl bootstrap $DOMAIN \"$PLIST_DST\""
fi

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  log "服务已就绪：$DOMAIN/${LABEL}（每天 08:02 触发，RunAtLoad=false）"
fi

cat <<EOF

下一步：
  node "$TARGET_SCRIPT" --dry      # 只看格式化消息，不发送
  node "$TARGET_SCRIPT" --force    # 立刻真发一次，验证 QQ/微信通道
  tail -n 5 "$DSH_HOME_DIR/career-planner/push-cron.log"
  launchctl print "$DOMAIN/${LABEL}"    # 看状态和下次触发时间

卸载：
  "$SCRIPT_DIR/install.sh" --uninstall
  或：launchctl bootout $DOMAIN "$PLIST_DST"
EOF
