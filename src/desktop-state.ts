// SPDX-License-Identifier: MIT
// Pure window geometry, desktop presets, and launcher command parsing helpers.

export const DESKTOP_MODE_STORAGE_KEY = "unkernel-nvim.desktopMode";
export const GPU_ENABLED_STORAGE_KEY = "unkernel-nvim.gpuEnabled";
export const WAYLAND_SCALE_STORAGE_KEY = "unkernel-nvim.waylandScale";
export const BROWSER_FULLSCREEN_STORAGE_KEY = "unkernel-nvim.browserFullscreen";
export const WAYLAND_LODPI_STORAGE_KEY = "unkernel-nvim.waylandLodpi";
export const WAYLAND_SCALE_PRESETS = [1, 1.25, 1.5, 2] as const;

export const TOPBAR_HEIGHT = 30;
export const DOCK_CLEARANCE = 76;
export const MIN_WIN_WIDTH = 320;
export const MIN_WIN_HEIGHT = 200;

/** Bitmask matching wland's EDGE_TOP / EDGE_BOTTOM / EDGE_LEFT / EDGE_RIGHT. */
export const WIN_EDGE_TOP = 1;
export const WIN_EDGE_BOTTOM = 2;
export const WIN_EDGE_LEFT = 4;
export const WIN_EDGE_RIGHT = 8;

export interface DesktopBounds {
  width: number;
  height: number;
}

export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
}

export interface DesktopAppPreset {
  id: string;
  name: string;
  description: string;
  group: "工作区" | "实用工具" | "图形与兼容";
  command: string;
  args: readonly string[];
  category: "terminal" | "files" | "editor" | "image" | "document" | "archive" | "calculator" | "graphics" | "x11";
  requiresGpu?: boolean;
  lodpi?: boolean;
  debianPackages: readonly string[];
}

export const DESKTOP_APP_PRESETS: readonly DesktopAppPreset[] = [
  {
    id: "foot",
    name: "Foot",
    description: "Wayland 终端",
    group: "工作区",
    command: "foot",
    args: [],
    category: "terminal",
    debianPackages: ["foot"],
  },
  {
    id: "pcmanfm",
    name: "PCManFM",
    description: "工作区文件管理器",
    group: "工作区",
    command: "pcmanfm",
    args: ["/workspace"],
    category: "files",
    debianPackages: ["pcmanfm"],
  },
  {
    id: "mousepad",
    name: "Mousepad",
    description: "文本与代码编辑器",
    group: "工作区",
    command: "mousepad",
    args: [],
    category: "editor",
    debianPackages: ["mousepad"],
  },
  {
    id: "ristretto",
    name: "Ristretto",
    description: "图片浏览器",
    group: "实用工具",
    command: "ristretto",
    args: [],
    category: "image",
    debianPackages: ["ristretto"],
  },
  {
    id: "zathura",
    name: "Zathura",
    description: "用 Vim 键位读 PDF",
    group: "实用工具",
    command: "zathura",
    args: [],
    category: "document",
    debianPackages: ["zathura", "zathura-pdf-poppler"],
  },
  {
    id: "xarchiver",
    name: "Xarchiver",
    description: "压缩与解压文件",
    group: "实用工具",
    command: "xarchiver",
    args: [],
    category: "archive",
    debianPackages: ["xarchiver", "zip", "unzip"],
  },
  {
    id: "galculator",
    name: "Galculator",
    description: "科学计算器",
    group: "实用工具",
    command: "galculator",
    args: [],
    category: "calculator",
    debianPackages: ["galculator"],
  },
  {
    id: "glmark2",
    name: "glmark2",
    description: "OpenGL ES 基准测试",
    group: "图形与兼容",
    command: "glmark2-es2-wayland",
    args: [],
    category: "graphics",
    requiresGpu: true,
    debianPackages: ["glmark2-es2-wayland"],
  },
  {
    id: "xterm",
    name: "XTerm",
    description: "X11 终端 · 1× 缩放",
    group: "图形与兼容",
    command: "xterm",
    args: [],
    category: "x11",
    lodpi: true,
    debianPackages: ["xterm", "xfonts-base"],
  },
];

export function parseStoredBoolean(raw: string | null, fallback = false): boolean {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return fallback;
}

export function parseWaylandScale(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "auto") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0 || n > 4) return null;
  return n;
}

function formatScaleNumber(scale: number): string {
  return `${Number(scale.toFixed(2))}×`;
}

export function formatWaylandScale(scale: number | null, effectiveScale?: number): string {
  if (scale !== null) {
    return formatScaleNumber(scale);
  }
  if (effectiveScale !== undefined && Number.isFinite(effectiveScale) && effectiveScale > 0) {
    return `自动 (${formatScaleNumber(effectiveScale)})`;
  }
  return "自动";
}

export interface AudioButtonViewState {
  label: string;
  title: string;
  attention: boolean;
  pressed: boolean;
  action: "resume" | "toggle-mute";
}

export function formatAudioButtonState(state: string, muted: boolean): AudioButtonViewState {
  if (state === "waiting") {
    return {
      label: "点击启用音频",
      title: "浏览器拦截了自动播放，点击立即播放虚拟机音频",
      attention: true,
      pressed: false,
      action: "resume",
    };
  }
  if (muted) {
    return {
      label: "静音中",
      title: "点击取消静音",
      attention: false,
      pressed: true,
      action: "toggle-mute",
    };
  }
  if (state === "running") {
    return {
      label: "音频中",
      title: "点击静音",
      attention: false,
      pressed: false,
      action: "toggle-mute",
    };
  }
  return {
    label: "音频",
    title: "点击静音",
    attention: false,
    pressed: false,
    action: "toggle-mute",
  };
}

export function clampWindowRect(
  rect: WindowRect,
  bounds: DesktopBounds,
  minW = MIN_WIN_WIDTH,
  minH = MIN_WIN_HEIGHT,
): WindowRect {
  const maxAvailW = Math.max(160, Math.floor(bounds.width));
  const maxAvailH = Math.max(120, Math.floor(bounds.height));
  const effMinW = Math.min(minW, maxAvailW);
  const effMinH = Math.min(minH, maxAvailH);
  const width = Math.max(effMinW, Math.min(Math.round(rect.width), maxAvailW));
  const height = Math.max(effMinH, Math.min(Math.round(rect.height), maxAvailH));

  const minVisibleX = 64;
  const minX = -(width - minVisibleX);
  const maxX = Math.max(0, maxAvailW - minVisibleX);
  const x = Math.max(minX, Math.min(Math.round(rect.x), maxX));

  const maxY = Math.max(0, maxAvailH - 36);
  const y = Math.max(0, Math.min(Math.round(rect.y), maxY));

  return { x, y, width, height };
}

export function computeCascadeRect(
  index: number,
  bounds: DesktopBounds,
  preferredW = 760,
  preferredH = 520,
): WindowRect {
  const pad = 24;
  const availW = Math.max(MIN_WIN_WIDTH, Math.floor(bounds.width));
  const availH = Math.max(MIN_WIN_HEIGHT, Math.floor(bounds.height));
  const width = Math.min(preferredW, Math.max(MIN_WIN_WIDTH, availW - pad * 2));
  const height = Math.min(preferredH, Math.max(MIN_WIN_HEIGHT, availH - pad * 2));
  const step = 28;
  const maxSteps = Math.max(1, Math.min(6, Math.floor((availW - width) / step) + 1));
  const offset = (Math.max(0, index) % maxSteps) * step;

  return clampWindowRect(
    {
      x: Math.max(12, Math.min(pad + offset, availW - width - 12)),
      y: Math.max(12, Math.min(pad + offset, availH - height - 12)),
      width,
      height,
    },
    bounds,
  );
}

export function applyWindowResize(
  start: WindowRect,
  dx: number,
  dy: number,
  edges: number,
  bounds: DesktopBounds,
  minW = MIN_WIN_WIDTH,
  minH = MIN_WIN_HEIGHT,
  maxW = 0,
  maxH = 0,
): WindowRect {
  const effMinW = Math.min(minW, Math.max(160, bounds.width));
  const effMinH = Math.min(minH, Math.max(120, bounds.height));
  const effMaxW = maxW > 0 ? Math.min(maxW, bounds.width) : bounds.width;
  const effMaxH = maxH > 0 ? Math.min(maxH, bounds.height) : bounds.height;

  let { x, y, width, height } = start;

  if ((edges & WIN_EDGE_RIGHT) !== 0) {
    width = start.width + dx;
  }
  if ((edges & WIN_EDGE_BOTTOM) !== 0) {
    height = start.height + dy;
  }
  if ((edges & WIN_EDGE_LEFT) !== 0) {
    const rawW = start.width - dx;
    const clampedW = Math.max(effMinW, Math.min(rawW, Math.max(effMinW, effMaxW)));
    x = start.x + (start.width - clampedW);
    width = clampedW;
  }
  if ((edges & WIN_EDGE_TOP) !== 0) {
    const rawH = start.height - dy;
    const clampedH = Math.max(effMinH, Math.min(rawH, Math.max(effMinH, effMaxH)));
    y = start.y + (start.height - clampedH);
    height = clampedH;
  }

  width = Math.max(effMinW, Math.min(Math.round(width), Math.max(effMinW, effMaxW)));
  height = Math.max(effMinH, Math.min(Math.round(height), Math.max(effMinH, effMaxH)));
  x = Math.round(x);
  y = Math.max(0, Math.round(y));

  return { x, y, width, height };
}

/** Parse a command line entered into the App Launcher (supports single/double quotes and backslash escapes). */
export function parseLauncherCommand(raw: string): { file: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (escaping) {
      current += ch;
      escaping = false;
      inToken = true;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaping = true;
      inToken = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      inToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += ch;
    inToken = true;
  }

  if (inToken) {
    tokens.push(current);
  }
  if (tokens.length === 0) return null;
  return { file: tokens[0]!, args: tokens.slice(1) };
}

export function buildDebianDesktopInstallCommand(): string {
  const packages = DESKTOP_APP_PRESETS.flatMap((preset) => preset.debianPackages);
  return (
    "env DEBIAN_FRONTEND=noninteractive apt-get update && " +
    "env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
    "fonts-dejavu-core fonts-noto-cjk xwayland mesa-utils libegl1 libegl-mesa0 libgles2 " +
    packages.join(" ")
  );
}

/**
 * Compute cosine-falloff Dock magnification factors for item centers along X.
 */
export function computeDockMagnification(
  centers: readonly number[],
  pointerX: number | null,
  maxScale = 1.24,
  radius = 92,
): number[] {
  if (pointerX === null || !Number.isFinite(pointerX) || maxScale <= 1 || radius <= 0) {
    return centers.map(() => 1);
  }
  return centers.map((center) => {
    const dist = Math.abs(pointerX - center);
    if (dist >= radius) return 1;
    const factor = 0.5 * (1 + Math.cos((Math.PI * dist) / radius));
    return Number((1 + (maxScale - 1) * factor).toFixed(4));
  });
}

/**
 * Compute viewport-clamped coordinates for a right-click context menu, flipping
 * horizontally/vertically when the pointer is near the right or bottom edge.
 */
export function computeContextMenuPosition(
  pointerX: number,
  pointerY: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  padding = 10,
  topInset = TOPBAR_HEIGHT + 6,
): MenuPlacement {
  const safeW = Math.max(0, menuWidth);
  const safeH = Math.max(0, menuHeight);
  const maxLeft = Math.max(padding, viewportWidth - safeW - padding);
  const maxTop = Math.max(topInset, viewportHeight - safeH - padding);

  const rawLeft = pointerX + safeW + padding <= viewportWidth ? pointerX : pointerX - safeW;
  const rawTop = pointerY + safeH + padding <= viewportHeight ? pointerY : pointerY - safeH;

  return {
    left: Math.round(Math.max(padding, Math.min(rawLeft, maxLeft))),
    top: Math.round(Math.max(topInset, Math.min(rawTop, maxTop))),
  };
}
