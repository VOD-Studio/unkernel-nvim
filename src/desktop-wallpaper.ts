// SPDX-License-Identifier: MIT
// Desktop wallpaper presets, URL/file validation, CSS resolution,
// and IndexedDB persistence for custom uploaded wallpapers.

export const WALLPAPER_STORAGE_KEY = "unkernel-nvim.wallpaper";
export const WALLPAPER_IDB_NAME = "unkernel-nvim-wallpaper";
export const WALLPAPER_IDB_STORE = "assets";
export const WALLPAPER_IDB_KEY = "custom-wallpaper";
export const MAX_WALLPAPER_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_WALLPAPER_URL_LENGTH = 4096;
export const MAX_WALLPAPER_DATA_URL_LENGTH = 2 * 1024 * 1024;

export type WallpaperFit = "cover" | "contain" | "tile";

export type WallpaperPresetId =
  | "clay-ember"
  | "midnight-aurora"
  | "terracotta-dunes"
  | "alpine-peaks"
  | "topo-contour"
  | "terminal-grid"
  | "deep-ocean"
  | "obsidian-solid";

export type WallpaperSource =
  | { kind: "preset"; presetId: WallpaperPresetId }
  | { kind: "custom"; name?: string }
  | { kind: "url"; url: string };

export interface WallpaperConfig {
  source: WallpaperSource;
  fit: WallpaperFit;
  dim: number;
  blur: number;
}

export interface WallpaperPreset {
  readonly id: WallpaperPresetId;
  readonly name: string;
  readonly description: string;
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  readonly backgroundSize?: string;
  readonly backgroundRepeat?: string;
  readonly backgroundPosition?: string;
}

export interface ResolvedWallpaperStyles {
  backgroundColor: string;
  backgroundImage: string;
  backgroundSize: string;
  backgroundRepeat: string;
  backgroundPosition: string;
  blurPx: number;
  dimOpacity: number;
  usesImage: boolean;
}

export const WALLPAPER_FIT_OPTIONS: ReadonlyArray<{ value: WallpaperFit; label: string }> = [
  { value: "cover", label: "填充裁剪" },
  { value: "contain", label: "完整适配" },
  { value: "tile", label: "平铺" },
];

function svgDataUri(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

const TERRACOTTA_DUNES_SVG = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">' +
    "<defs>" +
    '<linearGradient id="sky" x1="0" y1="0" x2="0.8" y2="1">' +
    '<stop offset="0%" stop-color="#191314"/>' +
    '<stop offset="55%" stop-color="#281817"/>' +
    '<stop offset="100%" stop-color="#121215"/>' +
    "</linearGradient>" +
    '<radialGradient id="sun" cx="0.72" cy="0.28" r="0.45">' +
    '<stop offset="0%" stop-color="#d97757" stop-opacity="0.34"/>' +
    '<stop offset="55%" stop-color="#a85543" stop-opacity="0.12"/>' +
    '<stop offset="100%" stop-color="#191314" stop-opacity="0"/>' +
    "</radialGradient>" +
    "</defs>" +
    '<rect width="1600" height="900" fill="url(#sky)"/>' +
    '<rect width="1600" height="900" fill="url(#sun)"/>' +
    '<path d="M0,470 C280,380 540,560 860,460 C1160,365 1380,440 1600,390 L1600,900 L0,900 Z" fill="#3a211d" fill-opacity="0.65"/>' +
    '<path d="M0,580 C340,650 610,490 960,575 C1240,640 1440,540 1600,565 L1600,900 L0,900 Z" fill="#261717" fill-opacity="0.82"/>' +
    '<path d="M0,715 C380,645 700,775 1080,695 C1320,645 1480,710 1600,685 L1600,900 L0,900 Z" fill="#171214" fill-opacity="0.95"/>' +
    "</svg>",
);

const ALPINE_PEAKS_SVG = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice">' +
    "<defs>" +
    '<linearGradient id="twilight" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#111622"/>' +
    '<stop offset="60%" stop-color="#1c2333"/>' +
    '<stop offset="100%" stop-color="#101216"/>' +
    "</linearGradient>" +
    '<radialGradient id="glow" cx="0.24" cy="0.34" r="0.5">' +
    '<stop offset="0%" stop-color="#d97757" stop-opacity="0.22"/>' +
    '<stop offset="65%" stop-color="#5d7ca6" stop-opacity="0.08"/>' +
    '<stop offset="100%" stop-color="#111622" stop-opacity="0"/>' +
    "</radialGradient>" +
    "</defs>" +
    '<rect width="1600" height="900" fill="url(#twilight)"/>' +
    '<rect width="1600" height="900" fill="url(#glow)"/>' +
    '<polygon points="0,630 220,420 430,545 710,335 980,520 1260,375 1600,590 1600,900 0,900" fill="#1b2231"/>' +
    '<polygon points="0,710 290,515 540,640 830,455 1130,635 1410,490 1600,640 1600,900 0,900" fill="#151923"/>' +
    '<polygon points="0,785 370,635 670,745 970,595 1290,750 1600,660 1600,900 0,900" fill="#101216"/>' +
    "</svg>",
);

const TOPO_CONTOUR_SVG = svgDataUri(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">' +
    '<rect width="1200" height="800" fill="#111214"/>' +
    '<g fill="none" stroke="#d97757" stroke-opacity="0.13" stroke-width="1.4">' +
    '<path d="M-80,170 C190,90 360,260 630,190 C900,120 1050,240 1280,150"/>' +
    '<path d="M-80,245 C210,165 390,330 660,255 C920,185 1080,310 1280,220"/>' +
    '<path d="M-80,320 C240,245 420,400 690,320 C950,245 1110,375 1280,295"/>' +
    '<path d="M-80,415 C230,350 450,490 730,410 C980,335 1120,460 1280,390"/>' +
    '<path d="M-80,520 C210,470 480,590 760,515 C1010,445 1140,565 1280,505"/>' +
    '<path d="M-80,630 C250,590 500,695 790,625 C1030,565 1160,670 1280,620"/>' +
    "</g>" +
    '<g fill="none" stroke="#8e9aa8" stroke-opacity="0.09" stroke-width="1">' +
    '<ellipse cx="340" cy="390" rx="220" ry="125" transform="rotate(-14 340 390)"/>' +
    '<ellipse cx="340" cy="390" rx="150" ry="82" transform="rotate(-14 340 390)"/>' +
    '<ellipse cx="890" cy="480" rx="250" ry="138" transform="rotate(11 890 480)"/>' +
    '<ellipse cx="890" cy="480" rx="165" ry="90" transform="rotate(11 890 480)"/>' +
    "</g>" +
    "</svg>",
);

export const WALLPAPER_PRESETS: readonly WallpaperPreset[] = [
  {
    id: "clay-ember",
    name: "赤陶余烬",
    description: "Clay 暗色调默认柔光渐变",
    backgroundColor: "#111111",
    backgroundImage:
      "radial-gradient(900px 520px at 18% 18%, rgba(217, 119, 87, 0.16), transparent 65%), " +
      "radial-gradient(760px 500px at 84% 78%, rgba(122, 122, 122, 0.12), transparent 68%), " +
      "linear-gradient(160deg, #101010 0%, #151515 55%, #111111 100%)",
  },
  {
    id: "midnight-aurora",
    name: "极夜极光",
    description: "深邃夜空搭配青绿与靛蓝极光",
    backgroundColor: "#0c1116",
    backgroundImage:
      "radial-gradient(880px 520px at 22% 20%, rgba(76, 184, 152, 0.22), transparent 64%), " +
      "radial-gradient(820px 540px at 78% 72%, rgba(92, 126, 214, 0.18), transparent 66%), " +
      "linear-gradient(155deg, #0b1015 0%, #111821 52%, #0c1014 100%)",
  },
  {
    id: "terracotta-dunes",
    name: "沙丘晚霞",
    description: "层叠暗赤陶沙丘矢量剪影",
    backgroundColor: "#161113",
    backgroundImage: TERRACOTTA_DUNES_SVG,
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
  },
  {
    id: "alpine-peaks",
    name: "雪岭暮色",
    description: "暮色山脊与微暖地平线光晕",
    backgroundColor: "#101216",
    backgroundImage: ALPINE_PEAKS_SVG,
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
  },
  {
    id: "topo-contour",
    name: "等高线图",
    description: "极简地形等高线暗色纹理",
    backgroundColor: "#111214",
    backgroundImage: TOPO_CONTOUR_SVG,
    backgroundSize: "cover",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "center",
  },
  {
    id: "terminal-grid",
    name: "终端网格",
    description: "微弱工程网格与赤陶角标光晕",
    backgroundColor: "#111113",
    backgroundImage:
      "radial-gradient(760px 460px at 82% 22%, rgba(217, 119, 87, 0.15), transparent 64%), " +
      "linear-gradient(to right, rgba(255, 255, 255, 0.035) 1px, transparent 1px), " +
      "linear-gradient(to bottom, rgba(255, 255, 255, 0.035) 1px, transparent 1px)",
    backgroundSize: "100% 100%, 36px 36px, 36px 36px",
    backgroundRepeat: "no-repeat, repeat, repeat",
    backgroundPosition: "center, 0 0, 0 0",
  },
  {
    id: "deep-ocean",
    name: "深海微光",
    description: "午夜深蓝与柔和青色水波光影",
    backgroundColor: "#0c131a",
    backgroundImage:
      "radial-gradient(860px 540px at 76% 24%, rgba(74, 163, 200, 0.2), transparent 64%), " +
      "radial-gradient(720px 500px at 18% 82%, rgba(58, 122, 146, 0.16), transparent 66%), " +
      "linear-gradient(165deg, #0b1219 0%, #101b24 54%, #0c1218 100%)",
  },
  {
    id: "obsidian-solid",
    name: "纯粹曜石",
    description: "无干扰极简纯黑背景",
    backgroundColor: "#121212",
    backgroundImage: "none",
  },
];

export const DEFAULT_WALLPAPER_CONFIG: WallpaperConfig = {
  source: { kind: "preset", presetId: "clay-ember" },
  fit: "cover",
  dim: 0,
  blur: 0,
};

const PRESET_MAP = new Map<WallpaperPresetId, WallpaperPreset>(
  WALLPAPER_PRESETS.map((preset) => [preset.id, preset]),
);

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/svg+xml",
]);

const ALLOWED_IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

export function isWallpaperPresetId(value: string): value is WallpaperPresetId {
  return PRESET_MAP.has(value as WallpaperPresetId);
}

export function getWallpaperPreset(id: string): WallpaperPreset {
  return PRESET_MAP.get(id as WallpaperPresetId) ?? WALLPAPER_PRESETS[0]!;
}

export function getNextWallpaperPresetId(config: WallpaperConfig): WallpaperPresetId {
  if (config.source.kind === "preset") {
    const { presetId } = config.source;
    const idx = WALLPAPER_PRESETS.findIndex((preset) => preset.id === presetId);
    if (idx >= 0) {
      return WALLPAPER_PRESETS[(idx + 1) % WALLPAPER_PRESETS.length]!.id;
    }
  }
  return WALLPAPER_PRESETS[0]!.id;
}

export function parseWallpaperUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[\u0000-\u001f\u007f"'\\()]/.test(trimmed)) return null;

  if (/^data:image\/(png|jpeg|jpg|webp|avif|gif|svg\+xml);base64,[a-z0-9+/=]+$/i.test(trimmed)) {
    return trimmed.length <= MAX_WALLPAPER_DATA_URL_LENGTH ? trimmed : null;
  }

  if (trimmed.length > MAX_WALLPAPER_URL_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  const normalized = parsed.toString();
  if (/[\u0000-\u001f\u007f"'\\()]/.test(normalized)) return null;
  return normalized;
}

function clampDim(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  const clamped = Math.max(0, Math.min(0.75, raw));
  return Math.round(clamped * 100) / 100;
}

function clampBlur(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.round(Math.max(0, Math.min(24, raw)));
}

function parseFit(raw: unknown): WallpaperFit {
  if (raw === "cover" || raw === "contain" || raw === "tile") return raw;
  return "cover";
}

export function parseWallpaperConfig(raw: string | null): WallpaperConfig {
  if (!raw) return { ...DEFAULT_WALLPAPER_CONFIG };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_WALLPAPER_CONFIG };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_WALLPAPER_CONFIG };
  }
  const obj = parsed as Record<string, unknown>;
  const fit = parseFit(obj.fit);
  const dim = clampDim(obj.dim);
  const blur = clampBlur(obj.blur);

  const src = obj.source;
  if (!src || typeof src !== "object") {
    return { source: { ...DEFAULT_WALLPAPER_CONFIG.source }, fit, dim, blur };
  }
  const srcObj = src as Record<string, unknown>;
  if (srcObj.kind === "preset" && typeof srcObj.presetId === "string" && isWallpaperPresetId(srcObj.presetId)) {
    return { source: { kind: "preset", presetId: srcObj.presetId }, fit, dim, blur };
  }
  if (srcObj.kind === "custom") {
    const name = typeof srcObj.name === "string" && srcObj.name.trim() ? srcObj.name.trim().slice(0, 120) : undefined;
    return { source: name ? { kind: "custom", name } : { kind: "custom" }, fit, dim, blur };
  }
  if (srcObj.kind === "url" && typeof srcObj.url === "string") {
    const validUrl = parseWallpaperUrl(srcObj.url);
    if (validUrl) {
      return { source: { kind: "url", url: validUrl }, fit, dim, blur };
    }
  }

  return { source: { ...DEFAULT_WALLPAPER_CONFIG.source }, fit, dim, blur };
}

export function serializeWallpaperConfig(config: WallpaperConfig): string {
  return JSON.stringify({
    source: config.source,
    fit: parseFit(config.fit),
    dim: clampDim(config.dim),
    blur: clampBlur(config.blur),
  });
}

export function formatWallpaperSummary(config: WallpaperConfig): string {
  if (config.source.kind === "preset") {
    return getWallpaperPreset(config.source.presetId).name;
  }
  if (config.source.kind === "custom") {
    return config.source.name ? `本地图片 · ${config.source.name}` : "本地图片";
  }
  return "网络图片";
}

export function validateWallpaperFile(
  file: Pick<File, "name" | "type" | "size">,
): { ok: true } | { ok: false; error: string } {
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return { ok: false, error: "所选图片为空文件" };
  }
  if (file.size > MAX_WALLPAPER_FILE_BYTES) {
    return { ok: false, error: "壁纸图片不能超过 20 MiB" };
  }
  const mime = (file.type || "").toLowerCase();
  if (mime) {
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mime)) {
      return { ok: false, error: `不支持的图片格式: ${mime}` };
    }
    return { ok: true };
  }
  if (!ALLOWED_IMAGE_EXTENSIONS.test(file.name)) {
    return { ok: false, error: "请选择 PNG、JPEG、WebP、AVIF、GIF 或 SVG 图片" };
  }
  return { ok: true };
}

function fitToBackgroundCss(fit: WallpaperFit): {
  backgroundSize: string;
  backgroundRepeat: string;
  backgroundPosition: string;
} {
  switch (fit) {
    case "contain":
      return {
        backgroundSize: "contain",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
      };
    case "tile":
      return {
        backgroundSize: "auto",
        backgroundRepeat: "repeat",
        backgroundPosition: "top left",
      };
    case "cover":
    default:
      return {
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
        backgroundPosition: "center",
      };
  }
}

export function resolveWallpaperStyles(
  config: WallpaperConfig,
  customObjectUrl: string | null,
): ResolvedWallpaperStyles {
  const blurPx = clampBlur(config.blur);
  const dimOpacity = clampDim(config.dim);

  const imageUrl =
    config.source.kind === "url"
      ? config.source.url
      : config.source.kind === "custom"
        ? customObjectUrl
        : null;

  if (imageUrl) {
    const layout = fitToBackgroundCss(config.fit);
    return {
      backgroundColor: "#101010",
      backgroundImage: `url("${imageUrl}")`,
      backgroundSize: layout.backgroundSize,
      backgroundRepeat: layout.backgroundRepeat,
      backgroundPosition: layout.backgroundPosition,
      blurPx,
      dimOpacity,
      usesImage: true,
    };
  }

  const preset =
    config.source.kind === "preset"
      ? getWallpaperPreset(config.source.presetId)
      : WALLPAPER_PRESETS[0]!;

  return {
    backgroundColor: preset.backgroundColor,
    backgroundImage: preset.backgroundImage,
    backgroundSize: preset.backgroundSize ?? "cover",
    backgroundRepeat: preset.backgroundRepeat ?? "no-repeat",
    backgroundPosition: preset.backgroundPosition ?? "center",
    blurPx,
    dimOpacity,
    usesImage: false,
  };
}

function openWallpaperDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(WALLPAPER_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(WALLPAPER_IDB_STORE)) {
          db.createObjectStore(WALLPAPER_IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function saveCustomWallpaperBlob(blob: Blob): Promise<boolean> {
  const db = await openWallpaperDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(WALLPAPER_IDB_STORE, "readwrite");
      tx.objectStore(WALLPAPER_IDB_STORE).put(blob, WALLPAPER_IDB_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => {
        db.close();
        resolve(false);
      };
      tx.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      db.close();
      resolve(false);
    }
  });
}

export async function loadCustomWallpaperBlob(): Promise<Blob | null> {
  const db = await openWallpaperDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(WALLPAPER_IDB_STORE, "readonly");
      const req = tx.objectStore(WALLPAPER_IDB_STORE).get(WALLPAPER_IDB_KEY);
      req.onsuccess = () => {
        const res = req.result;
        resolve(res instanceof Blob ? res : null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
      tx.onabort = () => {
        db.close();
        resolve(null);
      };
    } catch {
      db.close();
      resolve(null);
    }
  });
}

export async function deleteCustomWallpaperBlob(): Promise<void> {
  const db = await openWallpaperDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(WALLPAPER_IDB_STORE, "readwrite");
      tx.objectStore(WALLPAPER_IDB_STORE).delete(WALLPAPER_IDB_KEY);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
      tx.onabort = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
