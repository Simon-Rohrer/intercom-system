export type KeyGridFit = {
  cols: number;
  rows: number;
  keyWidth: number;
  keyHeight: number;
  /** Tasten wären kleiner als die Mindestgröße: feste Höhe, das Raster scrollt. */
  scroll?: boolean;
};

/**
 * Wie fitKeyGrid, aber nie kleiner als `minKeyHeight` × `minKeyWidth`: Passen
 * die Tasten so nicht ins Fenster, bekommen sie die Mindesthöhe, so viele
 * Spalten wie mit Mindestbreite nebeneinander passen, und das Raster scrollt.
 * So bleiben die Kanalnamen in kleinen Kacheln lesbar.
 */
export function fitKeyGridWithMinimum(
  count: number,
  width: number,
  height: number,
  gap: number,
  minKeyHeight: number,
  minKeyWidth: number,
  aspect = 1.6,
): KeyGridFit {
  const fit = fitKeyGrid(count, width, height, gap, aspect);
  if (count <= 0 || width <= 0 || height <= 0) return fit;
  if (fit.keyHeight >= minKeyHeight && fit.keyWidth >= minKeyWidth) return fit;
  const cols = Math.max(
    1,
    Math.min(count, Math.floor((width + gap) / (minKeyWidth + gap))),
  );
  const rows = Math.ceil(count / cols);
  const keyWidth = Math.max(0, (width - gap * (cols - 1)) / cols);
  // Höhe: was ins Fenster passt, aber mindestens die Mindesthöhe
  const fitted = (height - gap * (rows - 1)) / rows;
  const keyHeight = Math.max(minKeyHeight, fitted);
  return { cols, rows, keyWidth, keyHeight, scroll: fitted < minKeyHeight };
}

/**
 * Columns and rows so that `count` keys fill a `width` × `height` box as
 * large as possible. A key counts at most `aspect` times as wide as it is
 * high, so one long row of flat keys does not win over a squarer grid.
 */
export function fitKeyGrid(
  count: number,
  width: number,
  height: number,
  gap: number,
  aspect = 1.6,
): KeyGridFit {
  if (count <= 0 || width <= 0 || height <= 0) {
    return {
      cols: 1,
      rows: 1,
      keyWidth: Math.max(width, 0),
      keyHeight: Math.max(height, 0),
    };
  }
  let best: (KeyGridFit & { score: number }) | null = null;
  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    // a column more that leaves the last row just as full gains nothing
    if (cols > 1 && Math.ceil(count / (cols - 1)) === rows) continue;
    const keyWidth = (width - gap * (cols - 1)) / cols;
    const keyHeight = (height - gap * (rows - 1)) / rows;
    if (keyWidth <= 0 || keyHeight <= 0) continue;
    const score = Math.min(keyWidth, keyHeight * aspect);
    if (!best || score > best.score) {
      best = { cols, rows, keyWidth, keyHeight, score };
    }
  }
  if (!best) {
    return { cols: count, rows: 1, keyWidth: 0, keyHeight: 0 };
  }
  const { score: _score, ...fit } = best;
  return fit;
}
