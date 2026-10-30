// Zustand von JMS Control (GET /api/state) und reine Hilfsfunktionen – ohne Companion-Abhängigkeit, damit testbar.

export interface StateLayout {
  nr: number;
  id: string;
  name: string;
}

export interface StateOutput {
  nr: number;
  id: string;
  name: string;
  layout: string | null;
  layoutId: string | null;
}

export interface StateScreen {
  nr: number;
  id: string;
  name: string;
  connected: boolean;
  output: string | null;
  outputId: string | null;
}

/** Stufe der Abweichung vom Plan (Schwellen der Ablauf-Kachel): grün / gelb / rot */
export type AgendaLevel = "ok" | "warn" | "bad";

export interface AgendaEvent {
  id: string;
  name: string;
  start: string | null;
}

/** Ablauf der Ablauf-Kachel (GET /api/state → agenda, vom Server gerechnet) */
export interface AgendaState {
  state: string;
  eventId: string | null;
  event: string;
  hasAgenda: boolean;
  current: { index: number; title: string } | null;
  remainingSec: number | null;
  deviationMin: number | null;
  level: AgendaLevel | null;
  manual: boolean;
  next: { index: number; title: string; responsible: string; start: string | null } | null;
  events: AgendaEvent[];
}

/** Ampel des Veranstaltungsbetriebs: ok = grün, warn = gelb, error = rot */
export type OpsLevel = "ok" | "warn" | "error" | "unknown";

export interface OpsState {
  state: string;
  overall: OpsLevel;
  problems: number;
  errors: number;
  first: string;
}

export interface JmsState {
  layouts: StateLayout[];
  outputs: StateOutput[];
  screens: StateScreen[];
  agenda: AgendaState;
  ops: OpsState;
}

export interface Choice {
  id: string;
  label: string;
}

export const SCREEN_OFF = "aus";
/** Auswahl „aktuelles Event“: der Server nimmt das Event, das die Ablauf-Kachel gerade zeigt. */
export const CURRENT_EVENT = "current";

export const EMPTY_AGENDA: AgendaState = {
  state: "unconfigured", eventId: null, event: "", hasAgenda: false, current: null, remainingSec: null, deviationMin: null,
  level: null, manual: false, next: null, events: [],
};
export const EMPTY_OPS: OpsState = { state: "connecting", overall: "unknown", problems: 0, errors: 0, first: "" };

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function parseAgenda(value: unknown): AgendaState {
  const a = record(value);
  if (!a) return EMPTY_AGENDA;
  const current = record(a.current);
  const next = record(a.next);
  const level = ["ok", "warn", "bad"].includes(a.level as string) ? (a.level as AgendaLevel) : null;
  return {
    state: text(a.state) || "unconfigured",
    eventId: a.eventId == null || a.eventId === "" ? null : String(a.eventId),
    event: text(a.event),
    hasAgenda: a.hasAgenda === true,
    current: current ? { index: number(current.index) ?? -1, title: text(current.title) } : null,
    remainingSec: number(a.remainingSec),
    deviationMin: number(a.deviationMin),
    level,
    manual: a.manual === true,
    next: next ? { index: number(next.index) ?? -1, title: text(next.title), responsible: text(next.responsible), start: text(next.start) || null } : null,
    events: (Array.isArray(a.events) ? a.events : [])
      .map((e) => record(e))
      .filter((e): e is Record<string, unknown> => Boolean(e) && e!.id != null && e!.id !== "")
      .map((e) => ({ id: String(e.id), name: text(e.name), start: text(e.start) || null })),
  };
}

function parseOps(value: unknown): OpsState {
  const o = record(value);
  if (!o) return EMPTY_OPS;
  return {
    state: text(o.state) || "connecting",
    overall: ["ok", "warn", "error"].includes(o.overall as string) ? (o.overall as OpsLevel) : "unknown",
    problems: Math.max(0, Math.round(number(o.problems) ?? 0)),
    errors: Math.max(0, Math.round(number(o.errors) ?? 0)),
    first: text(o.first),
  };
}

export function parseState(body: unknown): JmsState {
  const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
  return {
    layouts: list<StateLayout>(data.layouts).filter((l) => typeof l?.id === "string"),
    outputs: list<StateOutput>(data.outputs)
      .filter((o) => typeof o?.id === "string")
      .map((o) => ({ ...o, layoutId: o.layoutId ?? null })),
    screens: list<StateScreen>(data.screens)
      .filter((s) => typeof s?.id === "string")
      .map((s) => ({ ...s, outputId: s.outputId ?? null })),
    agenda: parseAgenda(data.agenda),
    ops: parseOps(data.ops),
  };
}

export function layoutChoices(state: JmsState): Choice[] {
  return state.layouts.map((l) => ({ id: l.id, label: l.name || l.id }));
}

export function outputChoices(state: JmsState): Choice[] {
  return state.outputs.map((o) => ({ id: o.id, label: o.name || o.id }));
}

export function screenChoices(state: JmsState): Choice[] {
  return state.screens.map((s) => ({ id: s.id, label: s.name || s.id }));
}

/** Auswahl für die Ablauf-Tasten: „aktuelles Event“ und die Events von heute bzw. die nächsten. */
export function eventChoices(state: JmsState): Choice[] {
  const day = (iso: string | null): string => {
    const date = iso ? new Date(iso) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })
      : "";
  };
  return [
    { id: CURRENT_EVENT, label: "Aktuelles Event (wie die Ablauf-Kachel)" },
    ...state.agenda.events.map((e) => ({ id: e.id, label: [e.name || e.id, day(e.start)].filter(Boolean).join(" · ") })),
  ];
}

/** Signatur der Auswahllisten: ändert sie sich, werden Aktionen, Rückmeldungen und Presets neu angelegt. */
export function listSignature(state: JmsState): string {
  return JSON.stringify([layoutChoices(state), outputChoices(state), screenChoices(state), eventChoices(state)]);
}

export function layoutActive(state: JmsState, outputId: string, layoutId: string): boolean {
  return state.outputs.some((o) => o.id === outputId && o.layoutId === layoutId);
}

export function screenShows(state: JmsState, screenId: string, outputId: string): boolean {
  const screen = state.screens.find((s) => s.id === screenId);
  if (!screen) return false;
  return outputId === SCREEN_OFF ? !screen.outputId : screen.outputId === outputId;
}

/** Variablen-ID aus einem Namen: nur a–z, 0–9 und _. */
export function variableId(prefix: string, nr: number): string {
  return `${prefix}_${nr}`;
}

export function apiPath(...parts: string[]): string {
  return "/api/" + parts.map((p) => encodeURIComponent(p)).join("/");
}

/** 222 s → "3:42", −80 s → "−1:20" (wie fmtRemaining der Ablauf-Kachel) */
export function fmtRemaining(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "–";
  const sign = seconds < 0 ? "−" : "";
  const s = Math.abs(Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${sign}${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${sign}${m}:${String(sec).padStart(2, "0")}`;
}

/** +4 → "+4 min", −2 → "−2 min", 0 → "±0 min" (wie fmtDeviation der Ablauf-Kachel) */
export function fmtDeviation(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "–";
  return `${minutes > 0 ? "+" : minutes < 0 ? "−" : "±"}${Math.abs(minutes)} min`;
}

const OPS_LABELS: Record<OpsLevel, string> = { ok: "OK", warn: "Prüfen", error: "Fehler", unknown: "–" };

/** Variablenwerte für Ablauf und Event-Ops (ohne Präfix jms-control:) */
export function statusVariables(state: JmsState): Record<string, string | number | boolean> {
  const a = state.agenda;
  const o = state.ops;
  return {
    agenda_event: a.event,
    agenda_current: a.current?.title ?? (a.next ? "noch nicht begonnen" : a.hasAgenda ? "Ablauf vorbei" : a.eventId ? "kein Ablauf" : "kein Event"),
    agenda_remaining: a.current ? fmtRemaining(a.remainingSec) : "–",
    // Nach Uhr läuft der Ablauf per Definition nach Plan – wie die Statuszeile der Kachel
    agenda_deviation: !a.current ? "–" : a.manual ? fmtDeviation(a.deviationMin) : "nach Plan",
    agenda_level: a.level ?? "",
    agenda_manual: a.manual,
    agenda_next: a.next?.title ?? (a.current ? "Ende" : ""),
    agenda_next_responsible: a.next?.responsible ?? "",
    ops_overall: OPS_LABELS[o.overall],
    ops_level: o.overall,
    ops_problems: o.problems,
    ops_first: o.first,
  };
}

export function agendaLevelIs(state: JmsState, level: string): boolean {
  return state.agenda.level !== null && state.agenda.level === level;
}

export function opsLevelIs(state: JmsState, level: string): boolean {
  return state.ops.overall === level;
}
