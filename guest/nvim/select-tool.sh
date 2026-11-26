#!/bin/sh
# SPDX-License-Identifier: MIT
# Invoked by :UnkernelTool in the Debian guest.
set -eu

tool=$1
arch=$2
root=$3
case "$tool" in
  stylua)
    version=2.6.0
    url="https://github.com/JohnnyMorganz/StyLua/releases/download/v$version/stylua-linux-x86_64.zip"
    digest=a485f72bbfa22e4642e77a84b5edc2611a5cab7477b34e2e709dd8f78e919895
    program=stylua ;;
  lua_ls)
    version=3.19.2
    url="https://github.com/LuaLS/lua-language-server/releases/download/$version/lua-language-server-$version-linux-x64.tar.gz"
    digest=93ad326b10f6c00911dd8c450fa098332dbd8f9f45d1052f5636a2d54479b947
    program=bin/lua-language-server ;;
  *) echo "Unknown tool: $tool" >&2; exit 2 ;;
esac

mkdir -p "$root/selected"
exec 9>"$root/$tool.lock"
flock -n 9 || { echo "$tool 正在另一个会话中切换，请稍后重试" >&2; exit 1; }
choice=$root/selected/$tool
case "$arch" in
  native) rm -f "$choice"; exit 0 ;;
  x86_64) ;;
  *) echo "Unknown architecture: $arch" >&2; exit 2 ;;
esac

if ! grep -qx enabled /proc/sys/fs/binfmt_misc/x86_64 || [ ! -x /usr/local/libexec/kw-binfmt ]; then
  echo "Debian 未注册 x86_64 解释器，请检查 :checkhealth unkernel" >&2
  exit 1
fi

cache=$root/$tool-$version-x86_64
stage=$(mktemp -d "$root/.$tool.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
if [ ! -x "$cache/$program" ]; then
  if ! curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 --max-time 180 "$url" -o "$stage/archive"; then
    echo "下载 $tool 失败，请用 :checkhealth unkernel 检查 Wisp 联网后重试" >&2
    exit 1
  fi
  printf '%s  %s\n' "$digest" "$stage/archive" | sha256sum --check --status || {
    echo "$tool 下载文件的 SHA-256 校验失败" >&2; exit 1
  }
  mkdir "$stage/tool"
  case "$tool" in
    stylua) unzip -q "$stage/archive" -d "$stage/tool" ;;
    lua_ls) tar -xzf "$stage/archive" -C "$stage/tool" ;;
  esac
  chmod +x "$stage/tool/$program"
  if [ -d "$cache" ]; then mv "$cache" "$stage/old"; fi
  mv "$stage/tool" "$cache"
fi

# Executing the ELF lets kw-binfmt install Box64 and its amd64 libraries on first use.
# Publish the choice only after the guest actually ran the tool.
"$cache/$program" --version </dev/null
ln -s "$cache/$program" "$stage/selected"
mv -Tf "$stage/selected" "$choice"
