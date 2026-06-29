/**
 * Companion fallback renderer aligned with Kesher WebHID button visuals.
 *
 * Primary image rendering should come from backend-provided PNG buffers.
 * This renderer is used only when local metadata is available but the
 * backend image payload is missing.
 */

export interface ButtonState {
  channel: string;
  state: "IDLE" | "TALK" | "LISTEN" | "BROADCAST";
  label: string;
  talkCount?: number;
  listenCount?: number;
  isActive?: boolean;
  pressed?: boolean;
  actionType?: string;
  color?: string;
  isListening?: boolean;
}

export interface RenderOptions {
  width?: number;
  height?: number;
}

export interface ImageEffectOptions {
  mode: number;
  colorHex?: string;
  blinkOn?: boolean;
}

const DEFAULT_OPTIONS: Required<RenderOptions> = {
  width: 72,
  height: 72,
};

const streamDeckCanvasBackground = "#000000";
const defaultBackground = "#182028";
const defaultForeground = "#eef4ff";

type KeyPalette = {
  background: string;
  border: string;
  label: string;
};

let canvasModule: any = null;
try {
  canvasModule = eval("require")("canvas");
} catch {
  canvasModule = null;
}

export function isCanvasAvailable(): boolean {
  return Boolean(canvasModule && canvasModule.createCanvas);
}

export function renderButtonImage(
  state: ButtonState,
  options: RenderOptions = {},
): Buffer {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!isCanvasAvailable()) {
    return generateSolidColorPNG(opts.width, opts.height, "#000000");
  }

  try {
    return renderWithCanvas(state, opts);
  } catch (error) {
    console.warn("Canvas rendering failed, using fallback:", error);
    return generateSolidColorPNG(opts.width, opts.height, "#000000");
  }
}

export function applyImageEffectOverlay(
  imageBuffer: Buffer,
  options: ImageEffectOptions,
): Buffer {
  const mode = Number.isFinite(options.mode)
    ? Math.max(0, Math.min(2, Math.trunc(options.mode)))
    : 0;
  if (mode === 0 || imageBuffer.length === 0 || !isCanvasAvailable()) {
    return imageBuffer;
  }

  if (mode === 1 && !options.blinkOn) {
    return imageBuffer;
  }

  try {
    const { createCanvas, Image } = canvasModule;
    const image = new Image();
    image.src = imageBuffer;

    const width = Number(image.width || 72);
    const height = Number(image.height || 72);
    if (width <= 0 || height <= 0) {
      return imageBuffer;
    }

    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    const tint = normalizeHexColor(options.colorHex || "#ff2d26");
    const alpha = mode === 2 ? 0.5 : 0.62;
    ctx.fillStyle = hexToRgba(tint, alpha);
    ctx.fillRect(0, 0, width, height);

    if (mode === 2) {
      ctx.save();
      ctx.strokeStyle = hexToRgba(tint, 0.9);
      ctx.lineWidth = Math.max(3, Math.round(width * 0.07));
      ctx.strokeRect(1, 1, width - 2, height - 2);
      ctx.restore();
    }

    return canvas.toBuffer("image/png");
  } catch {
    return imageBuffer;
  }
}

function renderWithCanvas(
  state: ButtonState,
  opts: Required<RenderOptions>,
): Buffer {
  const { createCanvas } = canvasModule;
  const canvas = createCanvas(opts.width, opts.height);
  const ctx = canvas.getContext("2d");

  const actionType = String(state.actionType || "none");
  const pressed = Boolean(state.pressed || state.isActive || state.state === "TALK" || state.state === "BROADCAST");
  const useCallPressedColor = pressed && (
    actionType === "call_room" ||
    actionType === "reply_to_caller" ||
    actionType === "incoming_call_indicator"
  );
  const useEmergencyPressedColor =
    pressed &&
    actionType !== "listen_room" &&
    actionType !== "call_room" &&
    actionType !== "reply_to_caller" &&
    actionType !== "incoming_call_indicator";

  const palette = getButtonPalette(actionType, state.color, pressed);
  const fill = palette.background;
  const stroke = pressed ? mixColors(palette.border, "#ffffff", 0.2) : palette.border;
  const textColor = palette.label;

  const radius = Math.max(10, Math.round(canvas.width * 0.12));
  const cardInset = 2;
  const cardX = cardInset;
  const cardY = cardInset;
  const cardWidth = canvas.width - cardInset * 2;
  const cardHeight = canvas.height - cardInset * 2;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = streamDeckCanvasBackground;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  ctx.fillStyle = fill;
  ctx.fill();

  roundedRect(ctx, cardX, cardY, cardWidth, cardHeight, radius);
  ctx.lineWidth = useEmergencyPressedColor ? 4 : 3;
  ctx.strokeStyle = stroke;
  ctx.stroke();

  if (useEmergencyPressedColor) {
    roundedRect(ctx, cardX - 1, cardY - 1, cardWidth + 2, cardHeight + 2, radius + 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 115, 115, 0.28)";
    ctx.stroke();
  }

  if (useCallPressedColor) {
    roundedRect(ctx, cardX - 1, cardY - 1, cardWidth + 2, cardHeight + 2, radius + 1);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255, 214, 102, 0.35)";
    ctx.stroke();
  }

  if ((actionType === "ptt_room" || actionType === "listen_room") && state.isListening) {
    const stripeHeight = Math.max(6, Math.round(canvas.height * 0.075));
    roundedRect(
      ctx,
      cardX + 3,
      cardY + cardHeight - stripeHeight - 2,
      cardWidth - 6,
      stripeHeight,
      Math.max(3, Math.round(stripeHeight / 2)),
    );
    ctx.fillStyle = "#14c64b";
    ctx.fill();
  }

  const rawLabel = String(state.label || "").trim();
  const split = rawLabel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const primary = split[0] || "";
  const secondary = split[1] || "";

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (primary) {
    if (secondary) {
      const primaryFont = fitText(ctx, primary, canvas.width - 24, Math.max(20, Math.round(canvas.width * 0.2)), 800);
      ctx.fillStyle = textColor;
      ctx.font = `800 ${primaryFont}px sans-serif`;
      const primaryLines = wrapLines(ctx, primary, canvas.width - 24, 2);
      const primaryLineHeight = Math.round(primaryFont * 1.1);
      const primaryBlockHeight = primaryLines.length * primaryLineHeight;
      const primaryStartY =
        Math.round(canvas.height * 0.38) -
        primaryBlockHeight / 2 +
        primaryLineHeight / 2;
      primaryLines.forEach((line: string, index: number) => {
        ctx.fillText(line, canvas.width / 2, primaryStartY + index * primaryLineHeight);
      });

      const secondaryFont = fitText(ctx, secondary, canvas.width - 26, Math.max(11, Math.round(canvas.width * 0.1)), 600);
      ctx.fillStyle = mixColors(textColor, "#aeb6c0", 0.45);
      ctx.font = `600 ${secondaryFont}px sans-serif`;
      const secondaryLines = wrapLines(ctx, secondary, canvas.width - 26, 1);
      ctx.fillText(secondaryLines[0] || secondary, canvas.width / 2, Math.round(canvas.height * 0.68));
    } else {
      const labelFont = fitText(ctx, primary, canvas.width - 24, Math.max(18, Math.round(canvas.width * 0.15)), 800);
      ctx.fillStyle = textColor;
      ctx.font = `800 ${labelFont}px sans-serif`;
      const labelLines = wrapLines(ctx, primary, canvas.width - 24, 2);
      const labelLineHeight = Math.round(labelFont * 1.03);
      const labelStartY =
        Math.round(canvas.height * 0.56) -
        ((labelLines.length - 1) * labelLineHeight) / 2;
      labelLines.forEach((line: string, index: number) => {
        ctx.fillText(line, canvas.width / 2, labelStartY + index * labelLineHeight);
      });
    }
  }

  return canvas.toBuffer("image/png");
}

function normalizeHexColor(input?: string): string {
  const value = String(input || "").trim();
  if (!value) return defaultBackground;
  const short = /^#([0-9a-f]{3})$/i.exec(value);
  if (short) {
    const [, rgb] = short;
    return `#${rgb[0]}${rgb[0]}${rgb[1]}${rgb[1]}${rgb[2]}${rgb[2]}`.toLowerCase();
  }
  const long = /^#([0-9a-f]{6})$/i.exec(value);
  if (long) {
    return `#${long[1].toLowerCase()}`;
  }
  return defaultBackground;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hex);
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function mixColors(hex: string, target: string, amount: number): string {
  const sourceRgb = hexToRgb(hex);
  const targetRgb = hexToRgb(target);
  const mix = (left: number, right: number) =>
    Math.round(left + (right - left) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${mix(sourceRgb.r, targetRgb.r)}${mix(sourceRgb.g, targetRgb.g)}${mix(sourceRgb.b, targetRgb.b)}`;
}

function hexToRgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  const normalizedAlpha = Math.max(0, Math.min(1, alpha));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${normalizedAlpha})`;
}

function getButtonPalette(actionType: string, color: string | undefined, pressed: boolean): KeyPalette {
  const useEmergencyPressedColor =
    pressed &&
    actionType !== "none" &&
    actionType !== "listen_room" &&
    actionType !== "call_room" &&
    actionType !== "reply_to_caller" &&
    actionType !== "incoming_call_indicator";
  if (useEmergencyPressedColor) {
    return {
      background: "#ef1212",
      border: "#ff2d26",
      label: "#f7f7f7",
    };
  }

  if (String(color || "").trim()) {
    const custom = normalizeHexColor(color);
    return {
      background: "#000000",
      border: pressed ? mixColors(custom, "#ffffff", 0.42) : mixColors(custom, "#ffffff", 0.22),
      label: "#f2f5f8",
    };
  }

  switch (actionType) {
    case "broadcast_ptt":
      return { background: "#000000", border: "#ff2d26", label: "#f7f7f7" };
    case "call_room":
      return { background: "#000000", border: "#ffc067", label: "#f6f0e8" };
    case "select_talk_room":
      return { background: "#000000", border: "#2da8ff", label: "#ecf7ff" };
    case "ptt_selected":
      return { background: "#000000", border: "#ff4d4d", label: "#fff1f1" };
    case "listen_room":
      return { background: "#000000", border: "#26d07c", label: "#ebfff3" };
    case "direct_role":
    case "direct_user":
      return { background: "#000000", border: "#ff2d26", label: "#f3f5f7" };
    case "ptt_room":
      return { background: "#000000", border: "#1b2026", label: "#f1f4f8" };
    case "reply_to_caller":
      return { background: "#000000", border: "#ffc067", label: "#f6f0e8" };
    case "incoming_call_indicator":
      return { background: "#000000", border: "#ffd200", label: "#fff7d0" };
    case "mute_toggle":
      return { background: "#000000", border: "#f84e4e", label: "#fff1f1" };
    case "volume_delta":
      return { background: "#000000", border: "#9d8cff", label: "#f2f0ff" };
    case "page_up":
    case "page_down":
      return { background: "#000000", border: "#58ccf6", label: "#effbff" };
    default:
      return { background: "#000000", border: "#1a1f26", label: "#edf2f8" };
  }
}

function fitText(
  ctx: any,
  text: string,
  maxWidth: number,
  initialSize: number,
  weight: number,
): number {
  let size = initialSize;
  while (size > 12) {
    ctx.font = `${weight} ${size}px sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) {
      return size;
    }
    size -= 1;
  }
  return size;
}

function wrapLines(
  ctx: any,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word);
      current = "";
    }

    if (lines.length === maxLines - 1) {
      break;
    }
  }

  if (lines.length < maxLines && current) {
    lines.push(current);
  }

  const result = lines.slice(0, maxLines);
  if (result.length === maxLines && words.join(" ") !== result.join(" ")) {
    const last = result[result.length - 1] || "";
    result[result.length - 1] = `${last.slice(0, Math.max(0, last.length - 1))}...`;
  }
  return result;
}

function roundedRect(
  ctx: any,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
}

function generateSolidColorPNG(width: number, height: number, _hexColor: string): Buffer {
  const colorPNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, width & 0xff, 0x00, 0x00, 0x00, height & 0xff,
    0x08, 0x02, 0x00, 0x00, 0x00, 0xaa, 0xaa, 0xaa, 0xaa,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44,
    0xae, 0x42, 0x60, 0x82,
  ]);

  return colorPNG;
}
