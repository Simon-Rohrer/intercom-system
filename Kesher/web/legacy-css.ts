import type { Plugin } from "vite";

// Ersatzwerte für alte Browser (z. B. iPad Air 1 mit iOS 12 / Safari 12) im fertigen CSS.
// Lightning CSS (build.cssTarget) erledigt das meiste; übrig bleiben:
//   - clamp(a, b, c) → max(a, min(b, c))  (gleiche Bedeutung, geht ab Safari 11.1)
//   - Deklarationen mit color-mix() oder Container-Einheiten (cqi, cqw …) bekommen davor eine
//     Ersatz-Deklaration; neue Browser nehmen weiter die Originalzeile, alte verwerfen sie.

function splitTopLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && ch === sep) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function replaceFunction(css: string, name: string, replacer: (args: string[]) => string): string {
  const re = new RegExp(`(^|[^\\w-])${name}\\(`, "g");
  for (let guard = 0; guard < 10000; guard++) {
    re.lastIndex = 0;
    const m = re.exec(css);
    if (!m) break;
    const start = m.index + m[1].length;
    const open = start + name.length;
    let depth = 0;
    let end = -1;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) break;
    const args = splitTopLevel(css.slice(open + 1, end), ",").map((a) => a.trim());
    css = css.slice(0, start) + replacer(args) + css.slice(end + 1);
  }
  return css;
}

/** color-mix(in srgb, A 16%, B) → die Farbe mit dem größeren Anteil. */
function pickMixColor(args: string[]): string {
  const stops = args.slice(1).map((s) => {
    const m = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(s);
    return m ? { color: m[1], pct: Number(m[2]) } : { color: s, pct: null as number | null };
  });
  if (stops.length !== 2) return stops[0]?.color ?? "transparent";
  const [a, b] = stops;
  const pa = a.pct != null ? a.pct : b.pct != null ? 100 - b.pct : 50;
  return pa >= 50 ? a.color : b.color;
}

const CQ_UNIT = /(-?(?:\d+\.?\d*|\.\d+))cq(min|max|w|h|i|b)\b/g;
const CQ_TO_VIEWPORT: Record<string, string> = { w: "vw", i: "vw", h: "vh", b: "vh", min: "vmin", max: "vmax" };

function fallbackFor(declaration: string): string | null {
  CQ_UNIT.lastIndex = 0;
  if (!/color-mix\(/.test(declaration) && !CQ_UNIT.test(declaration)) return null;
  let value = replaceFunction(declaration, "color-mix", pickMixColor);
  value = value.replace(CQ_UNIT, (_all, n: string, unit: string) => n + CQ_TO_VIEWPORT[unit]);
  return value;
}

export function lowerCss(css: string): string {
  css = replaceFunction(css, "clamp", ([min, val, max]) => `max(${min}, min(${val}, ${max}))`);
  return css.replace(/\{([^{}]*)\}/g, (_all, body: string) => {
    const declarations = splitTopLevel(body, ";").flatMap((decl) => {
      const fallback = fallbackFor(decl);
      return fallback ? [fallback, decl] : [decl];
    });
    return `{${declarations.join(";")}}`;
  });
}

export function legacyCss(): Plugin {
  return {
    name: "kesher-legacy-css",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css") && typeof file.source === "string") {
          file.source = lowerCss(file.source);
        }
      }
    }
  };
}
