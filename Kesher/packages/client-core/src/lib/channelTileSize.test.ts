import { beforeEach, describe, expect, it } from "vitest";
import {
  embedKeyGridClasses,
  normalizeChannelTileSize,
  resolveChannelTileSizeOverride,
} from "./channelTileSize";
import { fitKeyGrid, fitKeyGridWithMinimum } from "./keyGridFit";
import { globalSettingsStorageKey, loadGlobalSettings } from "../app/settings";

describe("Größe der Kanal-Kacheln", () => {
  beforeEach(() => {
    localStorage.removeItem(globalSettingsStorageKey);
  });

  it("liest die Vorgabe der Kachel aus der Adresse", () => {
    expect(resolveChannelTileSizeOverride("?embed=1&tileSize=large")).toBe("large");
    expect(resolveChannelTileSizeOverride("?tileSize=klein")).toBe("small");
    expect(resolveChannelTileSizeOverride("?tileSize=riesig")).toBeNull();
    expect(resolveChannelTileSizeOverride("?embed=1")).toBeNull();
    expect(normalizeChannelTileSize(3)).toBeNull();
  });

  it("speichert die Größe pro Gerät und fällt sonst auf Normal zurück", () => {
    expect(loadGlobalSettings().channelTileSize).toBe("normal");
    localStorage.setItem(globalSettingsStorageKey, JSON.stringify({ channelTileSize: "large" }));
    expect(loadGlobalSettings().channelTileSize).toBe("large");
    localStorage.setItem(globalSettingsStorageKey, JSON.stringify({ channelTileSize: "xxl" }));
    expect(loadGlobalSettings().channelTileSize).toBe("normal");
  });

  it("hält kleine Kacheln lesbar: Raster scrollt statt die Tasten weiter zu verkleinern", () => {
    // Kachel „Licht“ im Multiview (ca. 640×420, Platz für die Tasten ca. 610×260) mit vielen Leitungen
    const plain = fitKeyGrid(24, 610, 260, 8);
    expect(plain.keyHeight).toBeLessThan(64);
    const fit = fitKeyGridWithMinimum(24, 610, 260, 8, 64, 100);
    expect(fit.scroll).toBe(true);
    expect(fit.keyHeight).toBeGreaterThanOrEqual(64);
    expect(fit.keyWidth).toBeGreaterThanOrEqual(100);
    expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(24);
  });

  it("ändert nichts, solange die Tasten groß genug sind", () => {
    const fit = fitKeyGridWithMinimum(6, 640, 400, 8, 64, 100);
    expect(fit).toEqual(fitKeyGrid(6, 640, 400, 8));
    expect(fit.scroll).toBeUndefined();
  });

  it("nimmt bei sehr schmalen Fenstern eine Spalte statt Tasten ohne Breite", () => {
    const fit = fitKeyGridWithMinimum(5, 60, 100, 8, 64, 100);
    expect(fit.cols).toBe(1);
    expect(fit.rows).toBe(5);
    expect(fit.scroll).toBe(true);
  });

  it("blendet in kleinen Tasten erst Nebensachen aus, der Name bleibt", () => {
    const fit = (keyHeight: number) => ({ cols: 2, rows: 2, keyWidth: 150, keyHeight });
    expect(embedKeyGridClasses(fit(140), "normal")).toBe("");
    expect(embedKeyGridClasses(fit(90), "normal")).toBe("station-keys-tight");
    expect(embedKeyGridClasses(fit(60), "small")).toBe("station-keys-tight station-keys-tiny");
    // „Groß“: immer kompakt, damit der größere Name Platz hat
    expect(embedKeyGridClasses(fit(140), "large")).toBe("station-keys-tight");
    expect(embedKeyGridClasses({ ...fit(64), scroll: true }, "normal")).toContain("station-keys-scroll");
    expect(embedKeyGridClasses(null, "normal")).toBe("");
  });
});
