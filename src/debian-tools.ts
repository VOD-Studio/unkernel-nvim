// SPDX-License-Identifier: MIT
import type { KernelHandle } from "unkernel";
import installer from "../guest/nvim/select-tool.sh?raw";
import plugin from "../guest/nvim/plugin/unkernel-tools.lua?raw";
import tools from "../guest/nvim/lua/unkernel/tools.lua?raw";
import health from "../guest/nvim/lua/unkernel/health.lua?raw";

const FISH_WAYLAND_CONF = `# Auto-generated unkernel Wayland integration for fish shells.
if not set -q WAYLAND_DISPLAY
  set -l _kw_on 0
  if test -r /proc/cmdline
    set -l _kw_cmd (cat /proc/cmdline 2>/dev/null)
    if string match -q '*kw.wayland=1*' -- "$_kw_cmd"
      set _kw_on 1
    end
  end
  for _kw_d in /run/user/*
    if test -d "$_kw_d" -a -O "$_kw_d"
      if test -S "$_kw_d/wayland-0"; or begin; test "$_kw_on" = 1; and not test -O /; end
        set -gx XDG_RUNTIME_DIR "$_kw_d"
        set -gx WAYLAND_DISPLAY wayland-0
        break
      end
    end
  end
  if not set -q WAYLAND_DISPLAY; and test "$_kw_on" = 1; and test -O /; and test -d /run/user/0
    for _kw_s in /run/user/*/wayland-0
      if test -S "$_kw_s"
        set -gx XDG_RUNTIME_DIR /run/user/0
        set -gx WAYLAND_DISPLAY "$_kw_s"
        break
      end
    end
  end
end

if set -q WAYLAND_DISPLAY
  set -q XDG_SESSION_TYPE; or set -gx XDG_SESSION_TYPE wayland
  set -q GDK_BACKEND; or set -gx GDK_BACKEND "wayland,x11"
  set -q QT_QPA_PLATFORM; or set -gx QT_QPA_PLATFORM "wayland;xcb"
  set -q SDL_VIDEODRIVER; or set -gx SDL_VIDEODRIVER "wayland,x11"
  set -q SDL_VIDEO_WAYLAND_PREFER_LIBDECOR; or set -gx SDL_VIDEO_WAYLAND_PREFER_LIBDECOR 1
  set -q MOZ_ENABLE_WAYLAND; or set -gx MOZ_ENABLE_WAYLAND 1
  set -q ELECTRON_OZONE_PLATFORM_HINT; or set -gx ELECTRON_OZONE_PLATFORM_HINT auto
  set -q ADW_DEBUG_COLOR_SCHEME; or set -gx ADW_DEBUG_COLOR_SCHEME prefer-dark
  if not set -q DISPLAY; and test -x /usr/bin/Xwayland
    set -l _kw_x
    if string match -q '/*' -- "$WAYLAND_DISPLAY"
      set _kw_x "$WAYLAND_DISPLAY.x11"
    else
      set _kw_x "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY.x11"
    end
    if test -r "$_kw_x"
      set -l _kw_disp (string trim -- (cat "$_kw_x" 2>/dev/null))
      if string match -rq '^:[0-9]+' -- "$_kw_disp"
        set -l _kw_num (string replace -r '^:' '' -- "$_kw_disp")
        if test -S "/tmp/.X11-unix/X$_kw_num"
          set -gx DISPLAY "$_kw_disp"
        end
      end
    end
  end
end

function wland-lodpi --description "Run a Wayland/X11 app at 1x LoDPI scale"
  if test (count $argv) -eq 0
    echo "用法: wland-lodpi <命令> [参数...]" >&2
    return 2
  end
  set -l _lodpi ""
  if set -q XDG_RUNTIME_DIR; and test -S "$XDG_RUNTIME_DIR/wayland-0-lodpi"
    set _lodpi "$XDG_RUNTIME_DIR/wayland-0-lodpi"
  else
    for _s in /run/user/*/wayland-0-lodpi
      if test -S "$_s"
        set _lodpi "$_s"
        if not string match -q '/run/user/0/*' -- "$_s"
          break
        end
      end
    end
  end
  if test -n "$_lodpi"
    env WAYLAND_DISPLAY="$_lodpi" $argv
  else
    $argv
  end
end
`;

/** Deliver the editor integration and fish Wayland env to new and previously seeded Debian disks. */
export async function installDebianTools(vm: KernelHandle): Promise<void> {
  const files = {
    "select-tool.sh": installer,
    "lua/unkernel/tools.lua": tools,
    "lua/unkernel/health.lua": health,
    "plugin/unkernel-tools.lua": plugin,
  };
  const result = await vm.exec("/bin/sh", ["-ec", `
    dir=/usr/local/share/nvim/site/pack/unkernel/start/unkernel-tools
    mkdir -p "$dir/lua/unkernel" "$dir/plugin" /etc/fish/conf.d
    while [ "$#" -gt 2 ]; do
      dest=$dir/$1
      if ! printf '%s' "$2" | cmp -s - "$dest"; then
        tmp=$(mktemp "$dest.XXXXXX")
        trap 'rm -f "$tmp"' EXIT
        printf '%s' "$2" > "$tmp"
        chmod 644 "$tmp"
        mv -f "$tmp" "$dest"
      fi
      shift 2
    done
    fish_dest=$1
    fish_body=$2
    if ! printf '%s' "$fish_body" | cmp -s - "$fish_dest"; then
      tmp=$(mktemp "$fish_dest.XXXXXX")
      trap 'rm -f "$tmp"' EXIT
      printf '%s' "$fish_body" > "$tmp"
      chmod 644 "$tmp"
      mv -f "$tmp" "$fish_dest"
    fi
  `, "install-unkernel-tools", ...Object.entries(files).flat(), "/etc/fish/conf.d/kw-wayland.fish", FISH_WAYLAND_CONF], { user: "root" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "安装 Neovim 工具命令失败");
}
