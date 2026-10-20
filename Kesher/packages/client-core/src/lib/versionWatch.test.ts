import { describe, expect, it } from "vitest";
import { assetSignature } from "./versionWatch";

describe("assetSignature", () => {
  it("lists the built scripts and styles of a page", () => {
    const html = `<script type="module" crossorigin src="/assets/index-E5zoNbc9.js"></script>
      <link rel="stylesheet" crossorigin href="/assets/index-BYHY2DDG.css"><link rel="icon" href="/favicon.svg">`;
    expect(assetSignature(html)).toBe("/assets/index-BYHY2DDG.css|/assets/index-E5zoNbc9.js");
  });

  it("changes with a new build and is empty in dev mode", () => {
    expect(assetSignature('<script src="/assets/index-AAA.js">')).not.toBe(assetSignature('<script src="/assets/index-BBB.js">'));
    expect(assetSignature('<script type="module" src="/src/main.tsx"></script>')).toBe("");
  });
});
