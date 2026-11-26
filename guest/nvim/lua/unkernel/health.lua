-- SPDX-License-Identifier: MIT
local M = {}

function M.check()
  local tools = require("unkernel.tools")
  local health = vim.health
  health.start("Debian x86_64 开发工具")
  local handler = "/proc/sys/fs/binfmt_misc/x86_64"
  local lines = vim.fn.filereadable(handler) == 1 and vim.fn.readfile(handler) or {}
  if vim.list_contains(lines, "enabled") and vim.list_contains(lines, "interpreter /usr/local/libexec/kw-binfmt") then
    health.ok("x86_64 ELF 解释器已注册")
  else
    health.error("x86_64 ELF 解释器不可用，请使用支持 Box64 的 Debian 镜像")
  end
  if vim.fn.executable("/usr/bin/box64") == 1 and vim.uv.fs_stat("/usr/lib/x86_64-linux-gnu/libstdc++.so.6") then
    health.ok("Box64 和 amd64 运行库已就绪")
  else
    health.info("首次运行 x86_64 工具时，Debian 会通过 APT 安装 Box64 和 amd64 运行库")
  end
  local routes = vim.fn.filereadable("/proc/net/route") == 1 and vim.fn.readfile("/proc/net/route") or {}
  local default_route = vim.iter(routes):any(function(line) return line:match("^%S+%s+00000000%s") ~= nil end)
  if default_route then
    health.info("已配置默认路由。首次安装需要 Wisp 能访问 GitHub 和 Debian 软件源")
  else
    health.warn("缺少默认路由。首次安装前请在控制中心启用 Wisp 并重启虚拟机")
  end
  for _, name in ipairs(tools.names) do
    local path = tools.selected(name)
    if path and vim.fn.executable(path) ~= 1 then
      health.error(name .. " 的 x86_64 程序缺失，请重新执行 :UnkernelTool " .. name .. " x86_64")
    else
      health.info(name .. "  " .. (path and ("x86_64  " .. path) or "native"))
    end
  end
end

return M
