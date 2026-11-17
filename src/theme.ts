/**
 * Themes for AppleCos. A theme is a complete token set, not a light/dark
 * switch: each palette owns its own contrast and shape language. "system"
 * resolves to the palette that matches the OS appearance and keeps following
 * it while the choice stays on system.
 */

export type Palette =
  | "nocturne"
  | "atlas"
  | "terminal"
  | "press"
  | "ember"
  | "xuanzhi"
  | "dawn"
  | "moss";
export type ThemeChoice = Palette | "system";

export interface ThemeMeta {
  id: Palette;
  name: string;
  mood: string;
  scheme: "light" | "dark";
  /** Window background, mirrored to the native window. */
  background: string;
  /** Rail, surface and accent, used by the picker cards. */
  swatches: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  {
    id: "nocturne",
    name: "夜场",
    mood: "冷蓝幕布与一束紫光，衬线台词像台本。",
    scheme: "dark",
    background: "#12151f",
    swatches: ["#0e111a", "#1b2030", "#8e88e8"],
  },
  {
    id: "atlas",
    name: "星图",
    mood: "深墨海图与黄铜金，经纬网格铺在幕后。",
    scheme: "dark",
    background: "#08161e",
    swatches: ["#05131a", "#0e2029", "#c9a227"],
  },
  {
    id: "terminal",
    name: "舰桥",
    mood: "磷光绿终端，等宽字与方块光标，模拟器本来的样子。",
    scheme: "dark",
    background: "#090c0a",
    swatches: ["#060907", "#101512", "#6fe38b"],
  },
  {
    id: "press",
    name: "铅字",
    mood: "冷灰纸与朱红印章，双线分隔，像一册剧本。",
    scheme: "light",
    background: "#eff0ec",
    swatches: ["#21231f", "#fafaf7", "#b5342a"],
  },
  {
    id: "ember",
    name: "篝火",
    mood: "焦褐夜色与琥珀火光，圆角与暖光收在底部。",
    scheme: "dark",
    background: "#1a1210",
    swatches: ["#120c09", "#241812", "#e8963f"],
  },
  {
    id: "xuanzhi",
    name: "宣纸",
    mood: "暖白纸面与极淡纤维纹，墨字配赭石印，竖排感更像手稿。",
    scheme: "light",
    background: "#faf7f0",
    swatches: ["#2a241c", "#fffdf7", "#8b4a1d"],
  },
  {
    id: "dawn",
    name: "晨雾",
    mood: "冷白偏蓝的薄雾，深靛正文与晴空蓝强调，阴影柔而不散。",
    scheme: "light",
    background: "#f2f5f8",
    swatches: ["#1b2a44", "#ffffff", "#1d63d8"],
  },
  {
    id: "moss",
    name: "苔痕",
    mood: "浅灰绿纸与墨绿正文，苔绿强调，对比克制、边角收得很小。",
    scheme: "light",
    background: "#f4f6f0",
    swatches: ["#2b3527", "#fafcf6", "#4d6b38"],
  },
];

const STORAGE_KEY = "applecos.theme";
const PALETTES = new Set<string>(THEMES.map((theme) => theme.id));

/** Old builds stored "light" and "dark"; map them onto the palette that fits. */
const LEGACY: Record<string, ThemeChoice> = {
  light: "press",
  dark: "nocturne",
  system: "system",
};

function prefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

/** Palette used when the choice follows the OS appearance. */
export function systemPalette(): Palette {
  return prefersDark() ? "nocturne" : "press";
}

export function normalizeChoice(value: string | null | undefined): ThemeChoice {
  if (!value) return "system";
  // Own keys only: "constructor" must not resolve to a prototype member.
  if (Object.hasOwn(LEGACY, value)) return LEGACY[value] ?? "system";
  if (PALETTES.has(value)) return value as Palette;
  return "system";
}

export function resolvePalette(choice: ThemeChoice): Palette {
  return choice === "system" ? systemPalette() : choice;
}

export function themeMeta(palette: Palette): ThemeMeta {
  return THEMES.find((theme) => theme.id === palette) ?? (THEMES[0] as ThemeMeta);
}

/** The choice saved on this device, falling back to system. */
export function currentChoice(): ThemeChoice {
  const fromDom = document.documentElement.dataset.themeChoice;
  if (fromDom) return normalizeChoice(fromDom);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as
      | { choice?: string }
      | null;
    return normalizeChoice(saved?.choice);
  } catch {
    return "system";
  }
}

let shellBridge: Promise<{ setWindowBackground?: (color: string) => Promise<void> } | null> | null =
  null;

/**
 * Mirrors the stage colour onto the native window so resizing never flashes
 * the default background. Shell only exists once the Go side ships it, so a
 * missing binding is not an error.
 */
/** Colours the host accepts; anything else is skipped rather than sent. */
function isColorValue(color: string): boolean {
  return /^#[0-9a-f]{3,8}$/i.test(color.trim()) || color.startsWith("light-dark(");
}

function syncWindowBackground(color: string): void {
  if (!isColorValue(color)) return;
  if (!shellBridge) {
    shellBridge = import("./mygo")
      .then((mod) => (mod as unknown as { Shell?: { setWindowBackground?: (c: string) => Promise<void> } }).Shell ?? null)
      .catch(() => null);
  }
  void shellBridge.then((shell) => {
    if (!shell?.setWindowBackground) return;
    void shell.setWindowBackground(color).catch(() => undefined);
  });
}

export interface ThemeChange {
  choice: ThemeChoice;
  palette: Palette;
}

/**
 * Applies a theme choice to the document, remembers it, mirrors the window
 * colour and announces the change. Accepts legacy values as well.
 */
export function applyTheme(value: string | null | undefined, options?: { announce?: boolean }): Palette {
  const choice = normalizeChoice(value);
  const palette = resolvePalette(choice);
  const meta = themeMeta(palette);
  const root = document.documentElement;

  root.dataset.theme = palette;
  root.dataset.themeChoice = choice;
  root.style.colorScheme = meta.scheme;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ choice }));
  } catch {
    // Private mode or a full disk: the theme still applies for this session.
  }

  syncWindowBackground(meta.background);

  if (options?.announce !== false) {
    document.dispatchEvent(
      new CustomEvent<ThemeChange>("applecos:theme", { detail: { choice, palette } }),
    );
  }
  return palette;
}

/** Keeps a system choice in step with the OS appearance. */
export function watchSystemTheme(): void {
  let query: MediaQueryList | null = null;
  try {
    query = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return;
  }
  if (!query) return;
  const onChange = (): void => {
    if (currentChoice() === "system") applyTheme("system", { announce: true });
  };
  if (typeof query.addEventListener === "function") query.addEventListener("change", onChange);
  else query.addListener(onChange);
}

/** Colour of the current stage, for callers that need the raw value. */
export function stageColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--stage-bg").trim();
  return value || themeMeta(resolvePalette(currentChoice())).background;
}
