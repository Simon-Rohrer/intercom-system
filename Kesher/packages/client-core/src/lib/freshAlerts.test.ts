import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ALERT_HIGHLIGHT_MS, useFreshAlerts } from "./freshAlerts";

type Entry = { id: string; alert: boolean };
const keyOf = (e: Entry) => e.id;
const isAlert = (e: Entry) => e.alert;

describe("useFreshAlerts", () => {
  it("keeps alerts that were there on open normal and highlights new ones for 15 s", () => {
    let clock = 1_000_000;
    const now = () => clock;
    const old = { id: "a", alert: true };
    const { result, rerender } = renderHook(({ list }) => useFreshAlerts(list, keyOf, isAlert, now), {
      initialProps: { list: [old] },
    });
    expect(result.current(old)).toBe("");

    const fresh = { id: "b", alert: true };
    rerender({ list: [old, fresh] });
    expect(result.current(fresh)).toBe("pop");

    clock += 5_000;
    rerender({ list: [old, fresh] });
    expect(result.current(fresh)).toBe("fresh");

    clock += ALERT_HIGHLIGHT_MS;
    rerender({ list: [old, fresh] });
    expect(result.current(fresh)).toBe("");
    expect(result.current({ id: "c", alert: false })).toBe("");
  });
});
