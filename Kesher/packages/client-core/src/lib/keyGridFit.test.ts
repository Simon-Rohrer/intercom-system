import { describe, expect, it } from "vitest";
import { fitKeyGrid } from "./keyGridFit";

describe("fitKeyGrid", () => {
  it("puts few keys side by side in a wide window", () => {
    expect(fitKeyGrid(5, 640, 120, 8)).toMatchObject({ cols: 5, rows: 1 });
  });

  it("stacks keys in a tall, narrow window", () => {
    expect(fitKeyGrid(5, 160, 640, 8)).toMatchObject({ cols: 1, rows: 5 });
  });

  it("uses a grid when one row would make the keys too flat", () => {
    const fit = fitKeyGrid(6, 640, 400, 8);
    expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(6);
    expect(fit).toMatchObject({ cols: 3, rows: 2 });
  });

  it("always has a cell for every key", () => {
    for (let count = 1; count <= 24; count += 1) {
      const fit = fitKeyGrid(count, 900, 500, 8);
      expect(fit.cols * fit.rows).toBeGreaterThanOrEqual(count);
      expect(fit.keyWidth).toBeGreaterThan(0);
      expect(fit.keyHeight).toBeGreaterThan(0);
    }
  });

  it("falls back to a single cell without keys or space", () => {
    expect(fitKeyGrid(0, 500, 300, 8)).toMatchObject({ cols: 1, rows: 1 });
    expect(fitKeyGrid(4, 0, 0, 8)).toMatchObject({ cols: 1, rows: 1 });
  });
});
