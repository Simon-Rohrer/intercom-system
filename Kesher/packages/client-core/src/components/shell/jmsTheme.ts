import { centralLoginAvailable } from "../../lib/centralLogin";
import { isDesktopApp } from "./shellLinks";

/**
 * Wallpaper, accent and light/dark of the signed-in user, like in JMS Control.
 *
 * The look is rebuilt in Kesher's own CSS (styles/shell.css) – JMS Control's
 * theme-boot.js and admin.css are deliberately NOT loaded (their variable names
 * collide with Kesher's). Only the user's choice comes from the central login
 * (`/.jms-auth/api/me` → prefs.wallpaper / prefs.theme) and the picture from
 * `/.jms-auth/api/wallpaper/<name>.jpg`. The values below mirror the list in
 * JMS Control (multiview/public/theme-boot.js) and are written as `--jms-*`
 * variables that only the sidebar frame reads. Without the central login
 * (desktop app, no network) the built-in gradients of shell.css stay.
 */

type Wallpaper = {
  id: string;
  /** dark picture; null = the blue gradient without a picture */
  file: string | null;
  /** own light picture (else the dark one under a light veil) */
  light?: string;
  accent: string;
  glass: string;
  side: string;
  dialog: string;
  bg: string;
};

const JMS_WALLPAPERS: Wallpaper[] = [
  { id: "graphit", file: "graphit", light: "graphit-hell", accent: "#8e8e93", glass: "rgba(36, 36, 38, 0.55)", side: "rgba(12, 12, 13, 0.55)", dialog: "rgba(34, 34, 36, 0.92)", bg: "#0a0a0b" },
  { id: "blau", file: null, accent: "#007aff", glass: "rgba(18, 36, 98, 0.5)", side: "rgba(8, 22, 70, 0.45)", dialog: "rgba(14, 30, 86, 0.88)", bg: "#0a1d57" },
  { id: "ozean", file: "ozean", light: "ozean-hell", accent: "#3478f6", glass: "rgba(16, 26, 92, 0.48)", side: "rgba(8, 14, 60, 0.45)", dialog: "rgba(14, 22, 78, 0.88)", bg: "#0b1050" },
  { id: "indigo", file: "indigo", light: "indigo-hell", accent: "#5e5ce6", glass: "rgba(22, 16, 70, 0.5)", side: "rgba(10, 6, 40, 0.5)", dialog: "rgba(20, 14, 62, 0.9)", bg: "#07052a" },
  { id: "abendrot", file: "abendrot", light: "abendrot-hell", accent: "#bf5af2", glass: "rgba(44, 22, 90, 0.48)", side: "rgba(24, 12, 60, 0.45)", dialog: "rgba(38, 20, 80, 0.9)", bg: "#1d0f4a" },
  { id: "kupfer", file: "kupfer", light: "kupfer-hell", accent: "#f57c1f", glass: "rgba(36, 24, 16, 0.55)", side: "rgba(14, 10, 8, 0.55)", dialog: "rgba(32, 22, 16, 0.92)", bg: "#0c0806" },
  { id: "salbei", file: "salbei", light: "salbei-hell", accent: "#7fa688", glass: "rgba(30, 38, 32, 0.55)", side: "rgba(10, 14, 11, 0.55)", dialog: "rgba(28, 34, 30, 0.92)", bg: "#0b0e0c" },
  { id: "tanne", file: "tanne", light: "tanne-hell", accent: "#4f9d77", glass: "rgba(22, 32, 28, 0.55)", side: "rgba(6, 10, 8, 0.55)", dialog: "rgba(22, 30, 26, 0.92)", bg: "#050806" },
  { id: "lagune", file: "lagune", light: "lagune-hell", accent: "#1fb5bd", glass: "rgba(10, 34, 38, 0.55)", side: "rgba(3, 12, 14, 0.55)", dialog: "rgba(10, 30, 34, 0.92)", bg: "#03090b" },
  { id: "lavendel", file: "lavendel", light: "lavendel-hell", accent: "#a57cf2", glass: "rgba(30, 20, 48, 0.55)", side: "rgba(10, 6, 18, 0.55)", dialog: "rgba(28, 18, 44, 0.92)", bg: "#07040c" },
  { id: "aurora", file: "aurora", light: "aurora-hell", accent: "#19c39a", glass: "rgba(8, 30, 34, 0.55)", side: "rgba(2, 10, 12, 0.55)", dialog: "rgba(8, 26, 30, 0.92)", bg: "#020a0c" },
  { id: "sonne", file: "sonne", light: "sonne-hell", accent: "#ff9f0a", glass: "rgba(42, 24, 8, 0.55)", side: "rgba(16, 8, 2, 0.55)", dialog: "rgba(38, 22, 8, 0.92)", bg: "#1a0c02" },
  { id: "rose", file: "rose", light: "rose-hell", accent: "#e0638c", glass: "rgba(40, 16, 26, 0.55)", side: "rgba(14, 6, 10, 0.55)", dialog: "rgba(36, 14, 24, 0.92)", bg: "#0a0507" },
  { id: "mitternacht", file: "mitternacht", light: "mitternacht-hell", accent: "#5b8cff", glass: "rgba(14, 22, 44, 0.55)", side: "rgba(4, 8, 18, 0.55)", dialog: "rgba(14, 20, 40, 0.92)", bg: "#02040a" },
];

const WALLPAPER_BASE = "/.jms-auth/api/wallpaper/";
const VARIABLES = ["accent", "wallpaper", "surface", "sidebar-bg", "dialog-bg", "bg"] as const;

type ThemePrefs = { theme?: string; wallpaper?: string };
type WallpaperVariables = Partial<Record<(typeof VARIABLES)[number], string>>;

/** The `--jms-*` values for a wallpaper, like applyWallpaper() in JMS Control. */
export function wallpaperVariables(id: string | undefined, dark: boolean): WallpaperVariables {
  const wp = JMS_WALLPAPERS.find((entry) => entry.id === id) ?? JMS_WALLPAPERS[0];
  if (!wp.file) return { accent: wp.accent };
  const picture = `url("${WALLPAPER_BASE}${wp.file}.jpg")`;
  if (dark) {
    return {
      accent: wp.accent,
      wallpaper: `${picture}, linear-gradient(165deg, #07174d, #0d2f8f 48%, #071338)`,
      surface: wp.glass,
      "sidebar-bg": wp.side,
      "dialog-bg": wp.dialog,
      bg: wp.bg,
    };
  }
  return {
    accent: wp.accent,
    wallpaper: wp.light
      ? `url("${WALLPAPER_BASE}${wp.light}.jpg"), linear-gradient(160deg, #eaf2ff, #cfe0ff 45%, #e6ecff)`
      : `linear-gradient(rgba(242, 245, 250, 0.62), rgba(242, 245, 250, 0.62)), ${picture}`,
  };
}

function prefersDark(theme: string): boolean {
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function applyVariables(values: WallpaperVariables): void {
  const style = document.documentElement.style;
  for (const name of VARIABLES) {
    const value = values[name];
    if (value) style.setProperty(`--jms-${name}`, value);
    else style.removeProperty(`--jms-${name}`);
  }
}

let started = false;

export function loadJmsTheme(): void {
  if (started || typeof document === "undefined") return;
  if (!centralLoginAvailable() || isDesktopApp()) return;
  started = true;
  void (async () => {
    let prefs: ThemePrefs | null = null;
    try {
      const res = await fetch("/.jms-auth/api/me", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (res.ok && res.headers.get("content-type")?.includes("json")) {
        const me = (await res.json()) as { prefs?: ThemePrefs } | null;
        prefs = me?.prefs ?? {};
      }
    } catch {
      // no central login reachable: keep the built-in look
    }
    if (!prefs) return;
    const theme = prefs.theme === "light" || prefs.theme === "dark" ? prefs.theme : "system";
    const root = document.documentElement;
    root.dataset.theme = theme;
    const apply = () => applyVariables(wallpaperVariables(prefs?.wallpaper || "graphit", prefersDark(theme)));
    apply();
    // "System": follow the device when it switches between light and dark
    if (theme === "system" && typeof window.matchMedia === "function") {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      if (query.addEventListener) query.addEventListener("change", apply);
      else query.addListener?.(apply);
    }
  })();
}
