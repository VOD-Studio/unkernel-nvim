// SPDX-License-Identifier: MIT
import type { KernelHandle } from "unkernel";
import installer from "../guest/nvim/select-tool.sh?raw";
import plugin from "../guest/nvim/plugin/unkernel-tools.lua?raw";
import tools from "../guest/nvim/lua/unkernel/tools.lua?raw";
import health from "../guest/nvim/lua/unkernel/health.lua?raw";

/** Deliver the editor integration to new and previously seeded Debian disks. */
export async function installDebianTools(vm: KernelHandle): Promise<void> {
  const files = {
    "select-tool.sh": installer,
    "lua/unkernel/tools.lua": tools,
    "lua/unkernel/health.lua": health,
    "plugin/unkernel-tools.lua": plugin,
  };
  const result = await vm.exec("/bin/sh", ["-ec", `
    dir=/usr/local/share/nvim/site/pack/unkernel/start/unkernel-tools
    mkdir -p "$dir/lua/unkernel" "$dir/plugin"
    while [ "$#" -gt 0 ]; do
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
  `, "install-unkernel-tools", ...Object.entries(files).flat()], { user: "root" });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "安装 Neovim 工具命令失败");
}
