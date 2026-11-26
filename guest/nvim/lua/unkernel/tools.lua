-- SPDX-License-Identifier: MIT
local M = {}

M.names = { "stylua", "lua_ls" }
M.root = vim.fs.joinpath(vim.fn.stdpath("data"), "unkernel-tools")
local installer = vim.fs.joinpath(vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h:h"), "select-tool.sh")

function M.selected(tool)
  return vim.uv.fs_readlink(vim.fs.joinpath(M.root, "selected", tool))
end

local restore_stylua
local function configure_stylua(path)
  if restore_stylua then
    restore_stylua()
    restore_stylua = nil
  end
  if not path then return end

  vim.cmd("packadd! conform.nvim")
  local conform = require("conform")
  local original_formatter = conform.formatters.stylua
  local original_format = conform.format
  conform.formatters.stylua = function(bufnr)
    local base = original_formatter
    if type(base) == "function" then base = base(bufnr) end
    return vim.tbl_extend("force", base or {}, { command = path })
  end
  -- Both save hooks pass 500 ms explicitly, overriding Conform's filetype defaults.
  -- Box64 startup takes several seconds while LuaLS indexes on a single virtual CPU.
  conform.format = function(opts, callback)
    opts = opts or {}
    local buf = opts.bufnr or opts.buf or 0
    if not opts.async and vim.bo[buf].filetype == "lua" and (not opts.timeout_ms or opts.timeout_ms == 500) then
      local names = opts.formatters or conform.list_formatters_for_buffer(buf)
      if vim.list_contains(names, "stylua") then
        opts = vim.tbl_extend("force", opts, { timeout_ms = math.max(15000, conform.default_format_opts.timeout_ms or 0) })
      end
    end
    return original_format(opts, callback)
  end
  restore_stylua = function()
    conform.formatters.stylua = original_formatter
    conform.format = original_format
  end
end

local function configure_box64_shutdown(client)
  local rpc = client.rpc
  local notify = rpc.notify
  rpc.notify = function(method, params)
    -- LuaLS crashes in its exit handler under Box64. Neovim sends this notice
    -- after the server acknowledges shutdown, when it is ready to terminate.
    if method == "exit" and client:is_stopped() then
      rpc.terminate()
      return true
    end
    return notify(method, params)
  end
end

local native_lua_ls
local function configure_lua_ls(path, restart)
  if not native_lua_ls then
    local config = vim.lsp.config.lua_ls or {}
    native_lua_ls = { cmd = config.cmd or { "lua-language-server" }, on_init = config.on_init or {} }
  end
  local enabled = restart and vim.lsp.is_enabled("lua_ls")
  if enabled then
    -- Send didClose before shutdown and release the buffers for the replacement.
    for _, client in ipairs(vim.lsp.get_clients({ name = "lua_ls" })) do
      for _, buf in ipairs(vim.tbl_keys(client.attached_buffers)) do
        vim.lsp.buf_detach_client(buf, client.id)
      end
    end
    vim.lsp.enable("lua_ls", false)
  end
  local config = vim.deepcopy(native_lua_ls)
  if path then
    config.cmd = type(config.cmd) == "table" and config.cmd or {}
    config.cmd[1] = path
    if type(config.on_init) == "function" then config.on_init = { config.on_init } end
    table.insert(config.on_init, configure_box64_shutdown)
  end
  vim.lsp.config("lua_ls", config)
  if enabled then vim.lsp.enable("lua_ls") end
  if not path then native_lua_ls = nil end
end

local applied = {}
local function apply(tool, path, restart)
  if applied[tool] == path then return true end
  if path and vim.fn.executable(path) ~= 1 then
    vim.notify(tool .. " 程序缺失，请重新执行 :UnkernelTool " .. tool .. " x86_64", vim.log.levels.WARN)
    return false
  end
  local configure = tool == "stylua" and configure_stylua or configure_lua_ls
  local ok, err = pcall(configure, path, restart)
  if not ok then
    vim.notify(tool .. " 配置失败\n" .. tostring(err), vim.log.levels.ERROR)
    return false
  end
  applied[tool] = path
  return true
end

function M.setup()
  for _, tool in ipairs(M.names) do
    local path = M.selected(tool)
    if path then apply(tool, path, false) end
  end
  vim.api.nvim_create_user_command("UnkernelTool", function(opts)
    local tool, arch = unpack(opts.fargs)
    if #opts.fargs == 0 then
      local lines = { ":UnkernelTool <工具> <native|x86_64>" }
      for _, name in ipairs(M.names) do
        table.insert(lines, name .. "  " .. (M.selected(name) and "x86_64" or "native"))
      end
      vim.notify(table.concat(lines, "\n"))
      return
    end
    if #opts.fargs ~= 2 or not vim.list_contains(M.names, tool) or (arch ~= "native" and arch ~= "x86_64") then
      vim.notify("用法  :UnkernelTool <stylua|lua_ls> <native|x86_64>", vim.log.levels.ERROR)
      return
    end
    if arch == "x86_64" then
      vim.notify("正在准备 x86_64 " .. tool .. "，首次安装需要 Wisp 联网，可继续编辑")
    end
    vim.system({ "/bin/sh", installer, tool, arch, M.root }, { text = true }, vim.schedule_wrap(function(result)
      if result.code ~= 0 then
        local detail = vim.trim(result.stderr or "")
        vim.notify(tool .. " 切换失败\n" .. detail:sub(-1600), vim.log.levels.ERROR)
        return
      end
      local path = M.selected(tool)
      if apply(tool, path, true) then
        vim.notify(tool .. " 已切换到 " .. (path and "x86_64" or "native"))
      end
    end))
  end, {
    nargs = "*",
    desc = "选择 Debian 中 Neovim 使用的工具架构",
    complete = function(lead, line)
      local choices = line:match("^%s*%S+%s+%S+%s") and { "native", "x86_64" } or M.names
      return vim.tbl_filter(function(value) return vim.startswith(value, lead) end, choices)
    end,
  })
end

return M
