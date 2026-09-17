#!/bin/sh
# xiaohongshu-mcp 的二进制按 <os>-<arch> 命名，例如 darwin-arm64、linux-amd64。
# 上游只发布预编译产物，这里统一推导出目标平台，避免脚本写死某台机器的架构。

xhs_platform() {
  if [ -n "${XHS_PLATFORM:-}" ]; then
    echo "$XHS_PLATFORM"
    return 0
  fi

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  case "$os" in
    darwin|linux) ;;
    *) echo "unsupported OS for xiaohongshu-mcp: $os" >&2; return 1 ;;
  esac

  arch=$(uname -m)
  case "$arch" in
    arm64|aarch64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) echo "unsupported architecture for xiaohongshu-mcp: $arch" >&2; return 1 ;;
  esac

  echo "${os}-${arch}"
}

# 二进制缺失时列出仓库里实际可用的平台，直接说明该补哪个文件。
xhs_require_binary() {
  binary=$1
  name=$2
  if [ -x "$binary" ]; then
    return 0
  fi

  echo "$name binary not found or not executable: $binary" >&2
  echo "available in $ROOT_DIR/xiaohongshu-mcp/bin:" >&2
  ls "$ROOT_DIR/xiaohongshu-mcp/bin" 2>/dev/null | sed 's/^/  /' >&2 || echo "  (directory missing)" >&2
  echo "download the build for your platform from https://github.com/xpzouying/xiaohongshu-mcp/releases" >&2
  echo "or set ${3:-XHS_MCP_BINARY} to a compatible build." >&2
  exit 1
}
