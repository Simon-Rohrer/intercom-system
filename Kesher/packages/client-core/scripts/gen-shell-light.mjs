// Erzeugt src/styles/shell-light.css: helle Fassung der festen (dunklen) Farben aus den
// älteren Stylesheets – nur innerhalb der Seitenleiste (.k-shell) und nur im hellen Modus.
// Aufruf nach Änderungen an den Farben in app.css & Co.:
//   node packages/client-core/scripts/gen-shell-light.mjs
//
// Vorgehen: Jede Regel, die eine Farb-Eigenschaft setzt, wird mit dem Präfix für den hellen
// Modus wiederholt (auch unveränderte Werte, damit die Reihenfolge der Kaskade gleich bleibt).
// Feste Farben werden dabei umgerechnet: helle Schrift → dunkle Tokens, dunkle Flächen → helles
// Glas, weiße Schleier/Linien → dunkelblaue. Farbige Flächen (Sprechen/Hören/Rufen …) bleiben.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.join(here, "..", "src", "styles");
const SOURCES = ["app.css", "station.css", "settings.css", "chat.css", "simple.css", "admin.css"];
const OUT = path.join(stylesDir, "shell-light.css");

const COLOR_PROPS = new Set([
  "color", "background", "background-color", "background-image",
  "border", "border-color", "border-top", "border-right", "border-bottom", "border-left",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "outline-color", "fill", "stroke", "caret-color",
]);
const COLORED_VARS = /var\(--(talk|listen|call|p2p|forced|accent|k-talk|k-listen|k-call|k-bcast|k-direct|k-accent|k-ok|k-bad|delete-bg|station-card-head-active-bg|station-call-active-bg|station-pin-active-bg)/;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Minimal CSS parser: returns [{type:'rule', selector, decls}|{type:'at', prelude, children}]
function parse(css) {
  let i = 0;
  function block() {
    const items = [];
    while (i < css.length) {
      const close = css.indexOf("}", i);
      const open = css.indexOf("{", i);
      if (close !== -1 && (open === -1 || close < open)) {
        i = close + 1;
        return items;
      }
      if (open === -1) {
        i = css.length;
        break;
      }
      const prelude = css.slice(i, open).trim();
      i = open + 1;
      if (prelude.startsWith("@")) {
        if (/^@(keyframes|-webkit-keyframes|font-face|import)/.test(prelude)) {
          // skip balanced block
          let depth = 1;
          while (i < css.length && depth > 0) {
            if (css[i] === "{") depth++;
            else if (css[i] === "}") depth--;
            i++;
          }
          continue;
        }
        items.push({ type: "at", prelude, children: block() });
      } else {
        const end = css.indexOf("}", i);
        const body = css.slice(i, end);
        i = end + 1;
        items.push({ type: "rule", selector: prelude, decls: splitDecls(body) });
      }
    }
    return items;
  }
  return block();
}

function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && ch === sep) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function splitDecls(body) {
  return splitTop(body, ";")
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const idx = d.indexOf(":");
      return { prop: d.slice(0, idx).trim().toLowerCase(), value: d.slice(idx + 1).trim() };
    })
    .filter((d) => d.prop && !d.prop.startsWith("--"));
}

function parseColor(text) {
  const t = text.trim().toLowerCase();
  if (t === "white") return { r: 255, g: 255, b: 255, a: 1 };
  if (t === "black") return { r: 0, g: 0, b: 0, a: 1 };
  let m = /^#([0-9a-f]{3,8})$/.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    const n = (s) => parseInt(s, 16);
    return { r: n(h.slice(0, 2)), g: n(h.slice(2, 4)), b: n(h.slice(4, 6)), a: h.length === 8 ? n(h.slice(6, 8)) / 255 : 1 };
  }
  m = /^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(t);
  if (m) {
    let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

function lum({ r, g, b }) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function sat({ r, g, b }) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}
const fmt = (n) => Math.round(n * 1000) / 1000;

function mapText(c) {
  const s = sat(c);
  const L = lum(c);
  if (s > 0.25 && L > 0.25) {
    if (c.r >= c.g && c.r >= c.b) return c.g > c.b * 1.25 && c.g > 120 ? "var(--k-call)" : "var(--k-bad)";
    if (c.g >= c.r && c.g >= c.b && c.b < 200) return "var(--k-ok)";
  }
  if (L < 0.35) return null; // already dark text
  const strength = c.a * Math.min(1, L * 1.1);
  if (strength > 0.8) return "var(--k-ink)";
  if (strength > 0.5) return "var(--k-ink-2)";
  return "var(--k-ink-3)";
}

function mapFill(c) {
  const s = sat(c);
  const L = lum(c);
  if (s > 0.35 && L > 0.04 && c.a > 0.5) return null; // real colour (status, accent)
  if (L < 0.2) {
    // dark panel → light glass
    if (c.a < 0.1) return `rgba(255, 255, 255, ${fmt(Math.min(0.5, c.a * 4))})`;
    return `rgba(255, 255, 255, ${fmt(Math.min(0.95, 0.55 + 0.4 * c.a))})`;
  }
  if (L > 0.75 && c.a < 0.35) return `rgba(20, 40, 90, ${fmt(Math.min(0.2, c.a * 1.3))})`;
  if (s > 0.35 && c.a <= 0.5) return null; // tinted wash of a colour – fine on light
  return null;
}

function mapLine(c) {
  const L = lum(c);
  const s = sat(c);
  if (s > 0.35 && c.a > 0.3) return null;
  if (L > 0.6) return `rgba(20, 40, 90, ${fmt(Math.max(0.08, Math.min(0.3, c.a)))})`;
  if (L < 0.2 && c.a > 0.5) return "var(--k-line)";
  return null;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b/g;

function transform(prop, value, ruleHasColoredFill) {
  const kind = prop === "color" || prop === "fill" || prop === "stroke" || prop === "caret-color"
    ? "text"
    : prop.startsWith("border") || prop === "outline-color"
      ? "line"
      : "fill";
  if (kind === "text" && ruleHasColoredFill) return value;
  return value.replace(COLOR_RE, (lit) => {
    const c = parseColor(lit);
    if (!c) return lit;
    const mapped = kind === "text" ? mapText(c) : kind === "line" ? mapLine(c) : mapFill(c);
    return mapped ?? lit;
  });
}

function hasColoredFill(decls) {
  return decls.some((d) => {
    if (!d.prop.startsWith("background")) return false;
    if (COLORED_VARS.test(d.value)) return true;
    const lits = d.value.match(COLOR_RE) || [];
    return lits.some((lit) => {
      const c = parseColor(lit);
      return c && sat(c) > 0.35 && c.a > 0.6 && lum(c) > 0.04;
    });
  });
}

// AppShell setzt data-scheme="light" | "dark" (System-Einstellung oder Wahl in JMS Control).
// :where() hält die Spezifität gleich wie im Original – die Kaskade bleibt dieselbe.
// Browser ohne :where() (z. B. Safari 12) bekommen von AppShell immer "dark".
const PREFIX = ':where(.k-shell[data-scheme="light"])';

// Schlüssel einer Regel: die letzte Klasse im letzten Teil des Selektors (".a.b .c:hover" → "c").
function selectorKeys(selector) {
  return splitTop(selector, ",").map((s) => {
    const last = s.trim().split(/[\s>+~]+/).pop() || "";
    const classes = last.match(/\.[A-Za-z0-9_-]+/g);
    if (classes) return classes[classes.length - 1];
    // ".audio-section h4": eigener Schlüssel; reine Element-Selektoren (button, input) nicht
    return /\.[A-Za-z]/.test(s) ? s.trim() : null;
  });
}

function scopeSelector(selector, prefix) {
  const parts = splitTop(selector, ",").map((s) => s.trim()).filter(Boolean);
  const kept = parts.filter(
    (s) =>
      !/^(:root|html|body)\b/.test(s) &&
      !s.includes(".k-shell") &&
      selectorKeys(s)[0] !== null,
  );
  if (kept.length === 0) return null;
  return kept
    .map((s) => {
      // .root.station-shell etc. sit inside .k-shell; ".k-shell X" works for all of them
      return `${prefix} ${s}`;
    })
    .join(",\n");
}

function changedKeysOf(items, keys = new Set()) {
  for (const item of items) {
    if (item.type === "at") {
      changedKeysOf(item.children, keys);
      continue;
    }
    const colored = hasColoredFill(item.decls);
    const changed = item.decls.some(
      (d) => COLOR_PROPS.has(d.prop) && transform(d.prop, d.value, colored) !== d.value,
    );
    if (changed) selectorKeys(item.selector).forEach((k) => k && keys.add(k));
  }
  return keys;
}

// Regeln mit geänderten Farben – plus alle Regeln für dieselben Elemente (gleicher Schlüssel),
// damit z. B. ".x.active" weiterhin gegen ".x" gewinnt.
function emitRules(items, keys, indent = "") {
  let out = "";
  for (const item of items) {
    if (item.type === "at") {
      const inner = emitRules(item.children, keys, indent + "  ");
      if (inner.trim()) out += `${indent}${item.prelude} {\n${inner}${indent}}\n`;
      continue;
    }
    const decls = item.decls.filter((d) => COLOR_PROPS.has(d.prop));
    if (decls.length === 0) continue;
    if (!selectorKeys(item.selector).some((k) => keys.has(k))) continue;
    const colored = hasColoredFill(item.decls);
    const sel = scopeSelector(item.selector, PREFIX);
    if (!sel) continue;
    const body = decls.map((d) => `${indent}  ${d.prop}: ${transform(d.prop, d.value, colored)};`).join("\n");
    out += `${indent}${sel} {\n${body}\n${indent}}\n`;
  }
  return out;
}

let all = [];
for (const file of SOURCES) {
  all = all.concat(parse(stripComments(fs.readFileSync(path.join(stylesDir, file), "utf8"))));
}

const header = `/* ERZEUGT von scripts/gen-shell-light.mjs – nicht von Hand ändern.
   Helle Fassung der festen Farben aus ${SOURCES.join(", ")}:
   gilt nur innerhalb der Seitenleiste (.k-shell) und nur im hellen Modus. */\n`;
const keys = changedKeysOf(all);
fs.writeFileSync(OUT, `${header}\n${emitRules(all, keys)}`);
console.log(`wrote ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
