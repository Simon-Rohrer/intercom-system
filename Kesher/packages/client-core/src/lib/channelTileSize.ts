import type { KeyGridFit } from "./keyGridFit";

/**
 * Größe der Kanal-Kacheln (Party Lines, Direkt, Durchsage): pro Gerät in den
 * Einstellungen wählbar, für eine Kesher-Kachel in JMS Control per
 * `?tileSize=small|normal|large` fest vorgegeben (die Kacheln eines Kiosks
 * teilen sich sonst dieselbe Ablage).
 */
export type ChannelTileSize = "small" | "normal" | "large";

export const channelTileSizes: ChannelTileSize[] = ["small", "normal", "large"];

export const channelTileSizeLabels: Record<ChannelTileSize, string> = {
  small: "Klein",
  normal: "Normal",
  large: "Groß",
};

export const defaultChannelTileSize: ChannelTileSize = "normal";

export function normalizeChannelTileSize(value: unknown): ChannelTileSize | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "small" || text === "klein" || text === "s") return "small";
  if (text === "normal" || text === "m") return "normal";
  if (text === "large" || text === "gross" || text === "groß" || text === "l") return "large";
  return null;
}

/** Vorgabe aus der Adresse (Kesher-Kachel in JMS Control), sonst null. */
export function resolveChannelTileSizeOverride(search: string): ChannelTileSize | null {
  return normalizeChannelTileSize(new URLSearchParams(search).get("tileSize"));
}

/**
 * Eingebettete Ansicht (Kachel in JMS Control): Unter `minKeyHeight` ×
 * `minKeyWidth` werden die Tasten nicht weiter verkleinert – das Raster
 * scrollt dann, statt die Kanalnamen abzuschneiden. `nameFactor` vergrößert
 * nur den Kanalnamen; `compact` blendet bei „Groß“ immer Zustandszeile und
 * Lautstärke aus, damit der größere Name Platz hat.
 */
export const embedTileMetrics: Record<
  ChannelTileSize,
  { minKeyHeight: number; minKeyWidth: number; nameFactor: number; compact: boolean }
> = {
  small: { minKeyHeight: 44, minKeyWidth: 72, nameFactor: 0.9, compact: false },
  normal: { minKeyHeight: 64, minKeyWidth: 100, nameFactor: 1, compact: false },
  large: { minKeyHeight: 110, minKeyWidth: 150, nameFactor: 1.35, compact: true },
};

/** Skalierung von Schrift und Knöpfen einer Taste (1 = normale Taste, ca. 140 px hoch). */
export function embedKeyScale(fit: KeyGridFit): number {
  return Math.min(1.8, Math.max(0.5, Math.min(fit.keyHeight / 140, fit.keyWidth / 190)));
}

/**
 * Klassen des eingebetteten Rasters: „tight“ blendet Lautstärke und die
 * Zustandszeile („Sprechen“) aus, „tiny“ zusätzlich Hören/Rufen – der
 * Kanalname bleibt immer sichtbar.
 */
export function embedKeyGridClasses(
  fit: KeyGridFit | null,
  size: ChannelTileSize,
): string {
  if (!fit) return "";
  const classes: string[] = [];
  // Mit Zustandszeile, Lautstärke und zweizeiligem Namen braucht eine Taste etwa
  // 175 px × Skalierung (der Regler ist fest 22 px hoch) – sonst würden Hören/Rufen
  // unten abgeschnitten.
  const fullHeight = 175 * embedKeyScale(fit);
  if (fit.keyHeight < Math.max(112, fullHeight) || embedTileMetrics[size].compact) {
    classes.push("station-keys-tight");
  }
  if (fit.keyHeight < 80) classes.push("station-keys-tiny");
  if (fit.scroll) classes.push("station-keys-scroll");
  return classes.join(" ");
}
