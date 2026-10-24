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

export interface JmsState {
  layouts: StateLayout[];
  outputs: StateOutput[];
  screens: StateScreen[];
}

export interface Choice {
  id: string;
  label: string;
}

export const SCREEN_OFF = "aus";

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

/** Signatur der Auswahllisten: ändert sie sich, werden Aktionen, Rückmeldungen und Presets neu angelegt. */
export function listSignature(state: JmsState): string {
  return JSON.stringify([layoutChoices(state), outputChoices(state), screenChoices(state)]);
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
