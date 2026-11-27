// SPDX-License-Identifier: MIT
// Handcrafted inline SVG icon catalog and app-icon resolver for Desktop Mode
// (dock tiles, App Launcher cards, and floating window titlebars).

import { DESKTOP_APP_PRESETS, type DesktopAppPreset } from "./desktop-state.ts";

export type DesktopIconId =
  | "neovim"
  | "terminal"
  | "launcher"
  | "preview"
  | "display"
  | "settings"
  | "fullscreen"
  | "files"
  | "editor"
  | "image"
  | "document"
  | "archive"
  | "calculator"
  | "graphics"
  | "x11"
  | "browser"
  | "media"
  | "wayland";

export type DesktopIconVariant = "dock" | "card" | "titlebar";

export interface DesktopIconSpec {
  readonly id: DesktopIconId;
  readonly label: string;
  readonly svg: string;
}

const SVG_OPEN =
  '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" aria-hidden="true" focusable="false">';

export const DESKTOP_ICONS: Readonly<Record<DesktopIconId, DesktopIconSpec>> = {
  neovim: {
    id: "neovim",
    label: "Neovim",
    svg: `${SVG_OPEN}<path d="M5 6.4L9 3.6V20.4L5 17.6V6.4Z" fill="#5db888"/><path d="M19 6.4L15 3.6V20.4L19 17.6V6.4Z" fill="#4aa3c8"/><path d="M9 3.6L19 17.6L15 20.4L5 6.4L9 3.6Z" fill="#72d09c"/><path d="M9 3.6L15 12V20.4L9 12V3.6Z" fill="#3a7a5c" fill-opacity="0.34"/></svg>`,
  },
  terminal: {
    id: "terminal",
    label: "终端",
    svg: `${SVG_OPEN}<rect x="2.75" y="4.25" width="18.5" height="15.5" rx="3" stroke="#e6e6e6" stroke-opacity="0.22" stroke-width="1.5" fill="#ffffff" fill-opacity="0.04"/><path d="M6.8 9.2L10.6 12.2L6.8 15.2" stroke="#e08767" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.2 15.4H17.2" stroke="#e6e6e6" stroke-width="2.1" stroke-linecap="round"/></svg>`,
  },
  launcher: {
    id: "launcher",
    label: "应用启动器",
    svg: `${SVG_OPEN}<rect x="3.5" y="3.5" width="4.4" height="4.4" rx="1.2" fill="#d97757"/><rect x="9.8" y="3.5" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.88"/><rect x="16.1" y="3.5" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.65"/><rect x="3.5" y="9.8" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.88"/><rect x="9.8" y="9.8" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.96"/><rect x="16.1" y="9.8" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.72"/><rect x="3.5" y="16.1" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.65"/><rect x="9.8" y="16.1" width="4.4" height="4.4" rx="1.2" fill="#e2e2e7" fill-opacity="0.72"/><rect x="16.1" y="16.1" width="4.4" height="4.4" rx="1.2" fill="#d97757" fill-opacity="0.78"/></svg>`,
  },
  preview: {
    id: "preview",
    label: "端口预览",
    svg: `${SVG_OPEN}<circle cx="11.5" cy="12" r="7.5" stroke="#78b8e0" stroke-width="1.75" fill="#78b8e0" fill-opacity="0.1"/><ellipse cx="11.5" cy="12" rx="3.5" ry="7.5" stroke="#78b8e0" stroke-opacity="0.85" stroke-width="1.4"/><path d="M4.6 9.5H18.4M4.6 14.5H18.4" stroke="#78b8e0" stroke-opacity="0.78" stroke-width="1.35" stroke-linecap="round"/><circle cx="18.2" cy="6.2" r="2.7" fill="#d97757" stroke="#182530" stroke-width="1.3"/></svg>`,
  },
  display: {
    id: "display",
    label: "虚拟显示器",
    svg: `${SVG_OPEN}<rect x="3" y="4.2" width="18" height="12.4" rx="2.4" fill="#82aaff" fill-opacity="0.16" stroke="#82aaff" stroke-width="1.75"/><path d="M6.5 11.4L9.4 8.6L12.1 11.1L14.9 7.8L17.5 10.6" stroke="#b6ceff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 16.6V19.6M8.2 19.8H15.8" stroke="#9db9f5" stroke-width="1.75" stroke-linecap="round"/></svg>`,
  },
  settings: {
    id: "settings",
    label: "控制中心",
    svg: `${SVG_OPEN}<path d="M10.4 3.2H13.6L14.2 5.3C14.8 5.5 15.4 5.8 15.9 6.2L17.9 5.3L19.9 7.3L19 9.3C19.4 9.8 19.7 10.4 19.9 11L21.8 11.6V14.4L19.9 15C19.7 15.6 19.4 16.2 19 16.7L19.9 18.7L17.9 20.7L15.9 19.8C15.4 20.2 14.8 20.5 14.2 20.7L13.6 22.8H10.4L9.8 20.7C9.2 20.5 8.6 20.2 8.1 19.8L6.1 20.7L4.1 18.7L5 16.7C4.6 16.2 4.3 15.6 4.1 15L2.2 14.4V11.6L4.1 11C4.3 10.4 4.6 9.8 5 9.3L4.1 7.3L6.1 5.3L8.1 6.2C8.6 5.8 9.2 5.5 9.8 5.3L10.4 3.2Z" transform="translate(0 -1)" fill="#c8c8d0" fill-opacity="0.16" stroke="#c8c8d0" stroke-width="1.65" stroke-linejoin="round"/><circle cx="12" cy="12" r="3.1" stroke="#d97757" stroke-width="1.9" fill="#d97757" fill-opacity="0.22"/></svg>`,
  },
  fullscreen: {
    id: "fullscreen",
    label: "全屏终端",
    svg: `${SVG_OPEN}<path d="M4.2 8.2V5.2C4.2 4.65 4.65 4.2 5.2 4.2H8.2M15.8 4.2H18.8C19.35 4.2 19.8 4.65 19.8 5.2V8.2M19.8 15.8V18.8C19.8 19.35 19.35 19.8 18.8 19.8H15.8M8.2 19.8H5.2C4.65 19.8 4.2 19.35 4.2 18.8V15.8" stroke="#e09a7e" stroke-width="1.9" stroke-linecap="round"/><path d="M9.5 9.3L12.7 12L9.5 14.7" stroke="#e6e6e6" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.6 14.7H15.8" stroke="#e6e6e6" stroke-width="1.9" stroke-linecap="round"/></svg>`,
  },
  files: {
    id: "files",
    label: "文件管理器",
    svg: `${SVG_OPEN}<path d="M3.5 6.4C3.5 5.35 4.35 4.5 5.4 4.5H9.3L11.1 6.5H18.6C19.65 6.5 20.5 7.35 20.5 8.4V10H3.5V6.4Z" fill="#b87c3c"/><rect x="3.5" y="7.8" width="17" height="11.7" rx="2.2" fill="#e0a458"/><path d="M4.5 8.8H19.5" stroke="#f2c98a" stroke-opacity="0.7" stroke-width="1.2" stroke-linecap="round"/><rect x="8.8" y="12.2" width="6.4" height="1.8" rx="0.9" fill="#5b3b16" fill-opacity="0.45"/></svg>`,
  },
  editor: {
    id: "editor",
    label: "文本编辑器",
    svg: `${SVG_OPEN}<path d="M6 3.5H14.5L18.5 7.5V19.2C18.5 19.92 17.92 20.5 17.2 20.5H6C5.28 20.5 4.7 19.92 4.7 19.2V4.8C4.7 4.08 5.28 3.5 6 3.5Z" fill="#c8d4e6" fill-opacity="0.14" stroke="#c8d4e6" stroke-width="1.65" stroke-linejoin="round"/><path d="M14.2 3.7V7.8H18.3" stroke="#c8d4e6" stroke-opacity="0.75" stroke-width="1.4" stroke-linejoin="round"/><path d="M7.6 10.5H13.4M7.6 13.7H12M7.6 16.9H11.2" stroke="#c8d4e6" stroke-opacity="0.78" stroke-width="1.5" stroke-linecap="round"/><path d="M13.5 17.5L19.6 11.4L21.1 12.9L15 19L12.9 19.6L13.5 17.5Z" fill="#d97757"/></svg>`,
  },
  image: {
    id: "image",
    label: "图片浏览器",
    svg: `${SVG_OPEN}<rect x="2.8" y="4.2" width="18.4" height="15.6" rx="3.1" fill="#29483e" stroke="#98d8b6" stroke-width="1.5"/><circle cx="8" cy="9" r="1.8" fill="#f1d299"/><path d="m4.4 16 4.6-4.5 3.2 2.8 3.9-5 3.5 4.4v3.6c0 .6-.5 1-1.1 1H5.5c-.6 0-1.1-.4-1.1-1Z" fill="#87cba7"/></svg>`,
  },
  document: {
    id: "document",
    label: "PDF 阅读器",
    svg: `${SVG_OPEN}<path d="M3 5.7c3.4-1.2 6.4-.9 9 1.1 2.6-2 5.6-2.3 9-1.1v12.6c-3.5-1.1-6.6-.6-9 1.3-2.4-1.9-5.5-2.4-9-1.3Z" fill="#d5a0ae" stroke="#ffd4dc" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 7v12M5.6 8.3c1.5-.3 2.8-.1 4.2.6m-4.2 2c1.5-.3 2.8-.1 4.2.6" stroke="#784c5a" stroke-width="1.25" stroke-linecap="round"/><path d="M15.1 5.4v6.4l1.6-1.4 1.5.8V5Z" fill="#994d63"/></svg>`,
  },
  archive: {
    id: "archive",
    label: "压缩包管理器",
    svg: `${SVG_OPEN}<path d="M4.7 8h14.6v10.3a2 2 0 0 1-2 2H6.7a2 2 0 0 1-2-2Z" fill="#979bd4"/><rect x="3" y="4.2" width="18" height="4.8" rx="1.4" fill="#c6c9f4"/><path d="M5.2 10h13.6" stroke="#626797" stroke-width="1.2"/><rect x="8.6" y="12.2" width="6.8" height="3" rx="1" fill="#4b507c"/><path d="M10.1 13.6h3.8" stroke="#dce0ff" stroke-width="1.2" stroke-linecap="round"/></svg>`,
  },
  calculator: {
    id: "calculator",
    label: "科学计算器",
    svg: `${SVG_OPEN}<rect x="4.6" y="2.5" width="14.8" height="19" rx="2.8" fill="#409895" stroke="#a0e2d8" stroke-width="1.35"/><rect x="7" y="5.1" width="10" height="4.6" rx="1" fill="#cbefe2"/><path d="M7.7 12.8h1.6m2.4 0h1.6m-5.6 3.5h1.6m2.4 0h1.6" stroke="#c8f2e8" stroke-width="1.8" stroke-linecap="round"/><rect x="15.2" y="12" width="2" height="5.3" rx="1" fill="#163f42"/></svg>`,
  },
  graphics: {
    id: "graphics",
    label: "3D 图形",
    svg: `${SVG_OPEN}<path d="M12 3.3L19.4 7.6L12 11.9L4.6 7.6L12 3.3Z" fill="#c4a7ff"/><path d="M4.6 7.6L12 11.9V20.5L4.6 16.2V7.6Z" fill="#8b74e0"/><path d="M19.4 7.6L12 11.9V20.5L19.4 16.2V7.6Z" fill="#6786e8"/><path d="M12 3.3L19.4 7.6V16.2L12 20.5L4.6 16.2V7.6L12 3.3Z" stroke="#e4dcff" stroke-opacity="0.35" stroke-width="1.1" stroke-linejoin="round"/></svg>`,
  },
  x11: {
    id: "x11",
    label: "X11 应用",
    svg: `${SVG_OPEN}<path d="M4.8 4.5H9.2L19.2 19.5H14.8L4.8 4.5Z" fill="#6bc4cf"/><path d="M18.6 4.5L12.7 11.4L6.2 19.5" stroke="#e2e8f0" stroke-width="2.3" stroke-linecap="round"/><path d="M11.1 13.3L13.3 10.7" stroke="#16262a" stroke-width="2.6" stroke-linecap="round"/><path d="M18.6 4.5L5.8 19.5" stroke="#e2e8f0" stroke-width="2.1" stroke-linecap="round"/></svg>`,
  },
  browser: {
    id: "browser",
    label: "浏览器",
    svg: `${SVG_OPEN}<circle cx="12" cy="12" r="8.2" fill="#74b9d8" fill-opacity="0.14" stroke="#74b9d8" stroke-width="1.75"/><path d="M15.4 8.6L13.3 13.3L8.6 15.4L10.7 10.7L15.4 8.6Z" fill="#d97757"/><path d="M10.7 10.7L13.3 13.3L8.6 15.4L10.7 10.7Z" fill="#e6e6e6"/></svg>`,
  },
  media: {
    id: "media",
    label: "媒体播放",
    svg: `${SVG_OPEN}<rect x="3.5" y="4.5" width="17" height="15" rx="3.4" fill="#e07a7a" fill-opacity="0.16" stroke="#e07a7a" stroke-width="1.75"/><path d="M10.1 8.8L16.1 12L10.1 15.2V8.8Z" fill="#f09a9a"/></svg>`,
  },
  wayland: {
    id: "wayland",
    label: "Wayland 应用",
    svg: `${SVG_OPEN}<rect x="3.5" y="4.2" width="17" height="15.6" rx="2.8" fill="#e0a85c" fill-opacity="0.14" stroke="#e0a85c" stroke-width="1.7"/><path d="M3.8 8.8H20.2" stroke="#e0a85c" stroke-opacity="0.7" stroke-width="1.4"/><circle cx="6.5" cy="6.6" r="0.9" fill="#e07a7a"/><circle cx="9.2" cy="6.6" r="0.9" fill="#e0a85c"/><circle cx="11.9" cy="6.6" r="0.9" fill="#6bc49c"/><path d="M7.6 11.8L9.3 16.2L12 12.8L14.7 16.2L16.4 11.8" stroke="#f2d09c" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  },
};

const X11_PATTERN = /(xterm|uxterm|xeyes|xclock|xcalc|xwayland|\bx11\b)/;
const NEOVIM_PATTERN = /(neovim|\bnvim\b)/;
const TERMINAL_PATTERN =
  /(foot|alacritty|kitty|wezterm|konsole|terminator|tilix|sakura|urxvt|gnome-terminal|xfce4-terminal|terminal|\bst\b|\bshell\b|\bbash\b|\bzsh\b)/;
const FILES_PATTERN =
  /(pcmanfm|thunar|nautilus|dolphin|nemo|caja|spacefm|ranger|file\s*manager|文件|\bfiles\b)/;
const EDITOR_PATTERN =
  /(mousepad|gedit|kate|leafpad|pluma|geany|vscode|sublime|emacs|gvim|\bzed\b|编辑器|\bcode\b|\beditor\b)/;
const GRAPHICS_PATTERN =
  /(glmark|glxgears|vkcube|vulkan|opengl|weston-simple-egl|blender|gimp|inkscape|krita)/;
const BROWSER_PATTERN =
  /(firefox|chromium|chrome|brave|epiphany|qutebrowser|midori|surf|browser)/;
const MEDIA_PATTERN =
  /(mpv|vlc|\bfeh\b|\bimv\b|\beog\b|loupe|ristretto|sxiv|audacity|pavucontrol|player)/;

/** Resolve a Launcher preset entry to its icon ID. */
export function resolvePresetIcon(
  preset: Pick<DesktopAppPreset, "category">,
): DesktopIconId {
  return preset.category;
}

/** Resolve a running Wayland / Xwayland window to the best-matching icon ID. */
export function resolveWaylandAppIcon(
  appId?: string | null,
  title?: string | null,
): DesktopIconId {
  const desktopId = appId?.toLowerCase().split(".").at(-1);
  const preset = DESKTOP_APP_PRESETS.find((app) => app.id === desktopId || app.command === desktopId);
  if (preset) return resolvePresetIcon(preset);
  const haystack = `${appId ?? ""} ${title ?? ""}`.toLowerCase();
  if (!haystack.trim()) return "wayland";
  if (NEOVIM_PATTERN.test(haystack)) return "neovim";
  if (X11_PATTERN.test(haystack)) return "x11";
  if (TERMINAL_PATTERN.test(haystack)) return "terminal";
  if (FILES_PATTERN.test(haystack)) return "files";
  if (EDITOR_PATTERN.test(haystack)) return "editor";
  if (GRAPHICS_PATTERN.test(haystack)) return "graphics";
  if (BROWSER_PATTERN.test(haystack)) return "browser";
  if (MEDIA_PATTERN.test(haystack)) return "media";
  return "wayland";
}

const ALL_ICON_CLASSES: readonly string[] = [
  "app-icon",
  "app-icon-dock",
  "app-icon-card",
  "app-icon-titlebar",
  ...(Object.keys(DESKTOP_ICONS) as DesktopIconId[]).map((id) => `app-icon-${id}`),
];

/** Render a static icon into an existing container element. */
export function renderDesktopIcon(
  container: HTMLElement,
  iconId: DesktopIconId,
  variant: DesktopIconVariant = "dock",
): void {
  container.classList.remove(...ALL_ICON_CLASSES);
  container.classList.add("app-icon", `app-icon-${variant}`, `app-icon-${iconId}`);
  container.innerHTML = DESKTOP_ICONS[iconId].svg;
}

/** Create a non-interactive icon element ready for insertion into Dock, cards, or titlebars. */
export function createDesktopIconElement(
  iconId: DesktopIconId,
  variant: DesktopIconVariant = "dock",
): HTMLSpanElement {
  const span = document.createElement("span");
  span.setAttribute("aria-hidden", "true");
  renderDesktopIcon(span, iconId, variant);
  return span;
}
