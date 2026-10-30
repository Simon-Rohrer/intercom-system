import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  CURRENT_EVENT, EMPTY_AGENDA, EMPTY_OPS, agendaLevelIs, apiPath, eventChoices, fmtDeviation, fmtRemaining, layoutActive,
  listSignature, opsLevelIs, parseState, screenShows, statusVariables, SCREEN_OFF,
} from "../dist/state.js";
import { request, trustedBase } from "../dist/transport.js";

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
  assert.deepEqual(parseState(null), { layouts: [], outputs: [], screens: [], agenda: EMPTY_AGENDA, ops: EMPTY_OPS });
  assert.deepEqual(parseState({ outputs: "x", layouts: [null, { id: 3 }] }).layouts, []);
  // Ältere Server ohne agenda/ops und kaputte Felder
  const broken = parseState({ agenda: { current: "x", next: 3, level: "lila", events: [null, { id: "" }, { name: "ohne id" }] }, ops: { overall: "grün", problems: "viele" } });
  assert.equal(broken.agenda.current, null);
  assert.equal(broken.agenda.next, null);
  assert.equal(broken.agenda.level, null);
  assert.deepEqual(broken.agenda.events, []);
  assert.equal(broken.ops.overall, "unknown");
  assert.equal(broken.ops.problems, 0);
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

const agendaBody = {
  ...body,
  agenda: {
    state: "connected", eventId: "42", event: "Gottesdienst", hasAgenda: true,
    current: { index: 3, title: "Predigt" }, remainingSec: 1740, deviationMin: 4, level: "warn", manual: true,
    next: { index: 4, title: "Abendmahl", responsible: "Anna", start: "2026-11-01T09:40:00Z" },
    events: [{ id: "42", name: "Gottesdienst", start: "2026-11-01T09:00:00Z" }, { id: 43, name: "Jugend", start: null }],
  },
  ops: { state: "ok", overall: "error", problems: 2, errors: 1, first: "LED-Wand prüfen" },
};

test("Ablauf und Event-Ops: Variablen wie die Statuszeile der Kachel", () => {
  const state = parseState(agendaBody);
  assert.deepEqual(statusVariables(state), {
    agenda_event: "Gottesdienst",
    agenda_current: "Predigt",
    agenda_remaining: "29:00",
    agenda_deviation: "+4 min",
    agenda_level: "warn",
    agenda_manual: true,
    agenda_next: "Abendmahl",
    agenda_next_responsible: "Anna",
    ops_overall: "Fehler",
    ops_level: "error",
    ops_problems: 2,
    ops_first: "LED-Wand prüfen",
  });
  // Nach Uhr: keine Abweichung in Minuten, sondern „nach Plan“
  const clock = statusVariables(parseState({ agenda: { ...agendaBody.agenda, manual: false, deviationMin: 0, level: "ok" } }));
  assert.equal(clock.agenda_deviation, "nach Plan");
  // Vor dem Beginn, nach dem Ende, Event ohne Ablauf, gar kein Event
  const before = statusVariables(parseState({ agenda: { ...agendaBody.agenda, current: null, remainingSec: null, level: null } }));
  assert.deepEqual([before.agenda_current, before.agenda_remaining, before.agenda_deviation, before.agenda_next], ["noch nicht begonnen", "–", "–", "Abendmahl"]);
  assert.equal(statusVariables(parseState({ agenda: { ...agendaBody.agenda, current: null, next: null } })).agenda_current, "Ablauf vorbei");
  assert.equal(statusVariables(parseState({ agenda: { ...agendaBody.agenda, hasAgenda: false, current: null, next: null } })).agenda_current, "kein Ablauf");
  const none = statusVariables(parseState({}));
  assert.equal(none.agenda_current, "kein Event");
  assert.equal(none.ops_overall, "–");
  assert.equal(none.ops_problems, 0);
});

test("Ampel-Rückmeldungen: Stufe des Ablaufs und der Event-Ops", () => {
  const state = parseState(agendaBody);
  assert.equal(agendaLevelIs(state, "warn"), true);
  assert.equal(agendaLevelIs(state, "ok"), false);
  assert.equal(agendaLevelIs(parseState({}), "ok"), false, "ohne laufenden Punkt keine Farbe");
  assert.equal(opsLevelIs(state, "error"), true);
  assert.equal(opsLevelIs(parseState({}), "unknown"), true);
});

test("Event-Auswahl: zuerst „aktuelles Event“, neue Events legen die Listen neu an", () => {
  const state = parseState(agendaBody);
  const choices = eventChoices(state);
  assert.equal(choices[0].id, CURRENT_EVENT);
  assert.deepEqual(choices.slice(1).map((c) => c.id), ["42", "43"]);
  assert.match(choices[1].label, /^Gottesdienst · So\., 01\.11\., 10:00$/);
  assert.equal(choices[2].label, "Jugend");
  // Restzeit/Punkt ändern die Signatur nicht, ein neues Event schon
  const ticked = parseState({ ...agendaBody, agenda: { ...agendaBody.agenda, remainingSec: 10, current: { index: 4, title: "Abendmahl" } } });
  assert.equal(listSignature(state), listSignature(ticked));
  const more = parseState({ ...agendaBody, agenda: { ...agendaBody.agenda, events: [...agendaBody.agenda.events, { id: "44", name: "Neu" }] } });
  assert.notEqual(listSignature(state), listSignature(more));
});

test("Restzeit und Abweichung wie in der Ablauf-Kachel formatiert", () => {
  assert.equal(fmtRemaining(210), "3:30");
  assert.equal(fmtRemaining(-80), "−1:20");
  assert.equal(fmtRemaining(3725), "1:02:05");
  assert.equal(fmtRemaining(null), "–");
  assert.equal(fmtDeviation(4), "+4 min");
  assert.equal(fmtDeviation(-2), "−2 min");
  assert.equal(fmtDeviation(0), "±0 min");
});

test("Ablauf-Tasten schicken JSON mit Geräteschlüssel, Fehlermeldung des Servers kommt an", async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, type: req.headers["content-type"], key: req.headers["x-jms-device-key"], origin: req.headers.origin, body: text });
      res.setHeader("Content-Type", "application/json");
      if (JSON.parse(text || "{}").action === "previous") {
        res.statusCode = 400;
        return res.end(JSON.stringify({ ok: false, error: "Kein vorheriger Punkt" }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = trustedBase("127.0.0.1", server.address().port);
    const key = "k".repeat(43);
    assert.deepEqual(await request(base, key, "POST", "/api/churchtools/agenda/position", { eventId: CURRENT_EVENT, action: "next" }), { ok: true });
    // Ohne Origin, sonst lehnt der Server die Geräteanfrage ab (sameOriginRequest)
    assert.deepEqual(seen[0], { method: "POST", url: "/api/churchtools/agenda/position", type: "application/json", key, origin: undefined, body: '{"eventId":"current","action":"next"}' });
    await assert.rejects(request(base, key, "POST", "/api/churchtools/agenda/position", { eventId: "42", action: "previous" }), /^Error: 400 Kein vorheriger Punkt$/);
    // Ohne Body wie bisher (Layout-Tasten): kein Content-Type
    await request(base, key, "POST", "/api/output/o1/next");
    assert.equal(seen[2].type, undefined);
    assert.equal(seen[2].body, "");
  } finally {
    server.close();
  }
});
