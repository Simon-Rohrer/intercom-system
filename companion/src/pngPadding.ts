/**
 * Pixel-Abstand pro Seite für Tastenbilder – ohne native canvas (im Companion-Paket nicht dabei).
 * Liest ein 8-Bit-PNG (Graustufen, RGB, RGBA, Palette; nicht interlaced), skaliert es in den
 * Bereich innerhalb der Abstände und schreibt wieder ein RGBA-PNG derselben Größe.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function hasPadding(padding: Padding): boolean {
  return Boolean(padding.top || padding.right || padding.bottom || padding.left);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(png: Buffer): Rgba | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  let offset = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Buffer | null = null;
  let alpha: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") alpha = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType];
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height || width * height > 1 << 22) return null;
  if (colorType === 3 && !palette) return null;

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0;
      pixels[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    let r: number, g: number, bl: number, al = 255;
    if (colorType === 3) {
      const index = pixels[p];
      r = palette![index * 3] ?? 0;
      g = palette![index * 3 + 1] ?? 0;
      bl = palette![index * 3 + 2] ?? 0;
      al = alpha && index < alpha.length ? alpha[index] : 255;
    } else if (colorType === 0 || colorType === 4) {
      r = g = bl = pixels[p];
      if (colorType === 4) al = pixels[p + 1];
    } else {
      r = pixels[p];
      g = pixels[p + 1];
      bl = pixels[p + 2];
      if (colorType === 6) al = pixels[p + 3];
    }
    data.set([r, g, bl, al], i * 4);
  }
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(image: Rgba): Buffer {
  const { width, height, data } = image;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/**
 * Abstände in Pixeln einer 72-px-Taste; bei größeren Bildern wird entsprechend umgerechnet.
 * Negative Werte schieben das Bild über den Rand hinaus. Liefert null, wenn das PNG nicht lesbar ist.
 */
export function padPng(png: Buffer, padding: Padding, keySize = 72): Buffer | null {
  const source = decodePng(png);
  if (!source) return null;
  const { width, height } = source;
  const scale = width / keySize;
  const left = padding.left * scale;
  const top = padding.top * scale;
  const innerWidth = width - left - padding.right * scale;
  const innerHeight = height - top - padding.bottom * scale;
  const out = new Uint8Array(width * height * 4);
  if (innerWidth >= 1 && innerHeight >= 1) {
    for (let y = 0; y < height; y++) {
      const sy = ((y + 0.5 - top) / innerHeight) * height - 0.5;
      if (sy < -0.5 || sy > height - 0.5) continue;
      for (let x = 0; x < width; x++) {
        const sx = ((x + 0.5 - left) / innerWidth) * width - 0.5;
        if (sx < -0.5 || sx > width - 0.5) continue;
        // bilinear, mit vormultipliziertem Alpha gegen dunkle Ränder
        const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
        const x1 = Math.min(width - 1, x0 + 1), y1 = Math.min(height - 1, y0 + 1);
        const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
        let r = 0, g = 0, b = 0, a = 0;
        for (const [px, py, w] of [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]]) {
          const i = (py * width + px) * 4;
          const pa = (source.data[i + 3] / 255) * w;
          r += source.data[i] * pa;
          g += source.data[i + 1] * pa;
          b += source.data[i + 2] * pa;
          a += pa;
        }
        const o = (y * width + x) * 4;
        if (a > 0) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a * 255)], o);
      }
    }
  }
  return encodePng({ width, height, data: out });
}
