import { test } from "node:test";
import assert from "node:assert/strict";
import { apiPath, layoutActive, listSignature, parseState, screenShows, SCREEN_OFF } from "../dist/state.js";
import { trustedBase } from "../dist/transport.js";

const body = {
  layouts: [{ nr: 1, id: "l1", name: "Gottesdienst" }, { nr: 2, id: "l2", name: "Probe" }],
  outputs: [{ nr: 1, id: "o1", name: "Licht", layout: "Probe", layoutId: "l2" }],
  screens: [{ nr: 1, id: "HDMI-A-1", name: "Ton", connected: true, output: "Licht", outputId: "o1" }, { nr: 2, id: "HDMI-A-2", name: "Bühne", connected: true }],
};

test("aktives Layout wird erkannt", () => {
  const state = parseState(body);
  assert.equal(layoutActive(state, "o1", "l2"), true);
  assert.equal(layoutActive(state, "o1", "l1"), false);
  assert.equal(layoutActive(state, "fehlt", "l2"), false);
});

test("Bildschirm-Zuordnung inklusive „aus“", () => {
  const state = parseState(body);
  assert.equal(screenShows(state, "HDMI-A-1", "o1"), true);
  assert.equal(screenShows(state, "HDMI-A-2", SCREEN_OFF), true);
  assert.equal(screenShows(state, "HDMI-A-1", SCREEN_OFF), false);
});

test("kaputte Antworten führen nicht zum Absturz", () => {
  assert.deepEqual(parseState(null), { layouts: [], outputs: [], screens: [] });
  assert.deepEqual(parseState({ outputs: "x", layouts: [null, { id: 3 }] }).layouts, []);
});

test("Signatur ändert sich nur bei neuen Listen, nicht beim Umschalten", () => {
  const a = parseState(body);
  const b = parseState({ ...body, outputs: [{ ...body.outputs[0], layout: "Gottesdienst", layoutId: "l1" }] });
  assert.equal(listSignature(a), listSignature(b));
  const c = parseState({ ...body, layouts: [...body.layouts, { nr: 3, id: "l3", name: "Neu" }] });
  assert.notEqual(listSignature(a), listSignature(c));
});

test("Pfade werden kodiert", () => {
  assert.equal(apiPath("output", "a b", "layout", "x/y"), "/api/output/a%20b/layout/x%2Fy");
});

test("Schlüssel geht nur an Loopback per HTTP, sonst HTTPS", () => {
  assert.equal(trustedBase("127.0.0.1", 8090), "http://127.0.0.1:8090");
  assert.equal(trustedBase("192.168.0.21", 8090), "https://192.168.0.21:8090");
});
