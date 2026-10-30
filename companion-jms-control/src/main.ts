import {
  InstanceBase,
  InstanceStatus,
  combineRgb,
  runEntrypoint,
  type CompanionActionDefinitions,
  type CompanionFeedbackDefinitions,
  type CompanionPresetDefinitions,
  type CompanionVariableDefinition,
  type SomeCompanionConfigField,
} from "@companion-module/base";
import { readDeviceKey, request, trustedBase } from "./transport.js";
import {
  CURRENT_EVENT,
  EMPTY_AGENDA,
  EMPTY_OPS,
  SCREEN_OFF,
  agendaLevelIs,
  apiPath,
  eventChoices,
  layoutActive,
  layoutChoices,
  listSignature,
  opsLevelIs,
  outputChoices,
  parseState,
  screenChoices,
  screenShows,
  statusVariables,
  variableId,
  type JmsState,
} from "./state.js";

interface ModuleConfig {
  host: string;
  port: number;
  pollMs: number;
}

const ACTIVE_STYLE = { bgcolor: combineRgb(0, 150, 60), color: combineRgb(255, 255, 255) };
// Ampelfarben für Ablauf und Event-Ops (wie die Kacheln: grün / gelb / rot)
const LEVEL_STYLES = {
  ok: { bgcolor: combineRgb(0, 150, 60), color: combineRgb(255, 255, 255) },
  warn: { bgcolor: combineRgb(255, 176, 32), color: combineRgb(0, 0, 0) },
  bad: { bgcolor: combineRgb(200, 30, 30), color: combineRgb(255, 255, 255) },
};
const MANUAL_STYLE = { bgcolor: combineRgb(0, 110, 160), color: combineRgb(255, 255, 255) };
const AGENDA_LEVELS = [{ id: "ok", label: "Grün (im Plan)" }, { id: "warn", label: "Gelb" }, { id: "bad", label: "Rot" }];
const OPS_LEVELS = [{ id: "ok", label: "Grün" }, { id: "warn", label: "Gelb" }, { id: "error", label: "Rot" }, { id: "unknown", label: "Unbekannt" }];
const AGENDA_STEPS = {
  agenda_next: { action: "next", name: "Ablauf: nächster Punkt" },
  agenda_previous: { action: "previous", name: "Ablauf: vorheriger Punkt" },
  agenda_auto: { action: "auto", name: "Ablauf: wieder nach Uhr" },
} as const;
const EMPTY: JmsState = { layouts: [], outputs: [], screens: [], agenda: EMPTY_AGENDA, ops: EMPTY_OPS };

class JmsControlInstance extends InstanceBase<ModuleConfig> {
  private config: ModuleConfig = { host: "127.0.0.1", port: 8090, pollMs: 1000 };
  private state: JmsState = EMPTY;
  private signature = "";
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private lastError = "";

  async init(config: ModuleConfig): Promise<void> {
    this.config = config;
    this.defineAll();
    this.start();
  }

  async destroy(): Promise<void> {
    this.stop();
  }

  async configUpdated(config: ModuleConfig): Promise<void> {
    this.config = config;
    this.stop();
    this.signature = "";
    this.start();
  }

  getConfigFields(): SomeCompanionConfigField[] {
    return [
      { type: "static-text", id: "info", width: 12, label: "Hinweis",
        value: "Verbindung zu JMS Control (Multiview). Läuft Companion auf dem JMS-Server, bleiben 127.0.0.1 und 8090 stehen. Angemeldet wird mit dem Geräteschlüssel jms-device.key neben dem Modul." },
      { type: "textinput", id: "host", label: "Adresse", default: "127.0.0.1", width: 8 },
      { type: "number", id: "port", label: "Port", default: 8090, min: 1, max: 65535, width: 4 },
      { type: "number", id: "pollMs", label: "Abfrage alle … ms", default: 1000, min: 250, max: 10000, width: 4 },
    ];
  }

  private start(): void {
    this.updateStatus(InstanceStatus.Connecting);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), Math.max(250, Number(this.config.pollMs) || 1000));
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const base = trustedBase(String(this.config.host || "127.0.0.1").trim(), Number(this.config.port) || 8090);
    return request(base, readDeviceKey(), method, path, body);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      this.applyState(parseState(await this.call("GET", "/api/state")));
      if (this.lastError) this.log("info", "Verbindung zu JMS Control wieder da");
      this.lastError = "";
      this.updateStatus(InstanceStatus.Ok);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastError) this.log("warn", `JMS Control: ${message}`);
      this.lastError = message;
      this.updateStatus(/^40[13]/.test(message) ? InstanceStatus.AuthenticationFailure : InstanceStatus.ConnectionFailure, message);
      this.setVariableValues({ connected: false });
    } finally {
      this.polling = false;
    }
  }

  private applyState(state: JmsState): void {
    this.state = state;
    const signature = listSignature(state);
    if (signature !== this.signature) {
      this.signature = signature;
      this.defineAll();
    }
    const values: Record<string, string | number | boolean> = { connected: true, ...statusVariables(state) };
    for (const o of state.outputs) values[variableId("multiview", o.nr)] = o.layout ?? "";
    for (const s of state.screens) values[variableId("bildschirm", s.nr)] = s.output ?? "aus";
    this.setVariableValues(values);
    this.checkFeedbacks("layout_active", "screen_output", "agenda_level", "agenda_manual", "ops_level");
  }

  private async run(path: string, body?: unknown): Promise<void> {
    try {
      await this.call("POST", path, body);
      await this.poll();
    } catch (error) {
      this.log("error", `JMS Control: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private defineAll(): void {
    const outputs = outputChoices(this.state);
    const layouts = layoutChoices(this.state);
    const screens = screenChoices(this.state);
    const screenTargets = [{ id: SCREEN_OFF, label: "Aus (schwarz)" }, ...outputs];
    const events = eventChoices(this.state);

    const actions: CompanionActionDefinitions = {
      set_layout: {
        name: "Multiview: Layout zeigen",
        options: [
          { type: "dropdown", id: "output", label: "Multiview", choices: outputs, default: outputs[0]?.id ?? "", allowCustom: true },
          { type: "dropdown", id: "layout", label: "Layout", choices: layouts, default: layouts[0]?.id ?? "", allowCustom: true },
        ],
        callback: async (event) => {
          await this.run(apiPath("output", String(event.options.output), "layout", String(event.options.layout)));
        },
      },
      step_layout: {
        name: "Multiview: nächstes / vorheriges Layout",
        options: [
          { type: "dropdown", id: "output", label: "Multiview", choices: outputs, default: outputs[0]?.id ?? "", allowCustom: true },
          { type: "dropdown", id: "dir", label: "Richtung", choices: [{ id: "next", label: "Nächstes" }, { id: "prev", label: "Vorheriges" }], default: "next" },
        ],
        callback: async (event) => {
          await this.run(apiPath("output", String(event.options.output), String(event.options.dir)));
        },
      },
      screen_output: {
        name: "Bildschirm am Server: Multiview zuweisen",
        options: [
          { type: "dropdown", id: "screen", label: "Bildschirm", choices: screens, default: screens[0]?.id ?? "", allowCustom: true },
          { type: "dropdown", id: "output", label: "Multiview", choices: screenTargets, default: SCREEN_OFF, allowCustom: true },
        ],
        callback: async (event) => {
          await this.run(apiPath("screen", String(event.options.screen), "output", String(event.options.output)));
        },
      },
    };
    // Ablauf (ChurchTools): laufenden Punkt weiterschalten wie die Bedienung der Ablauf-Kachel
    for (const [id, step] of Object.entries(AGENDA_STEPS)) {
      actions[id] = {
        name: step.name,
        options: [
          { type: "dropdown", id: "event", label: "Event", choices: events, default: CURRENT_EVENT, allowCustom: true },
        ],
        callback: async (event) => {
          await this.run("/api/churchtools/agenda/position", { eventId: String(event.options.event || CURRENT_EVENT), action: step.action });
        },
      };
    }

    const feedbacks: CompanionFeedbackDefinitions = {
      layout_active: {
        type: "boolean",
        name: "Multiview: Layout ist aktiv",
        defaultStyle: ACTIVE_STYLE,
        options: [
          { type: "dropdown", id: "output", label: "Multiview", choices: outputs, default: outputs[0]?.id ?? "", allowCustom: true },
          { type: "dropdown", id: "layout", label: "Layout", choices: layouts, default: layouts[0]?.id ?? "", allowCustom: true },
        ],
        callback: (feedback) => layoutActive(this.state, String(feedback.options.output), String(feedback.options.layout)),
      },
      screen_output: {
        type: "boolean",
        name: "Bildschirm am Server zeigt Multiview",
        defaultStyle: ACTIVE_STYLE,
        options: [
          { type: "dropdown", id: "screen", label: "Bildschirm", choices: screens, default: screens[0]?.id ?? "", allowCustom: true },
          { type: "dropdown", id: "output", label: "Multiview", choices: screenTargets, default: SCREEN_OFF, allowCustom: true },
        ],
        callback: (feedback) => screenShows(this.state, String(feedback.options.screen), String(feedback.options.output)),
      },
      agenda_level: {
        type: "boolean",
        name: "Ablauf: Abweichung vom Plan in Stufe",
        description: "Schwellen wie in der Ablauf-Kachel (Standard: bis 2 min grün, bis 5 min gelb, darüber rot)",
        defaultStyle: LEVEL_STYLES.warn,
        options: [{ type: "dropdown", id: "level", label: "Stufe", choices: AGENDA_LEVELS, default: "warn" }],
        callback: (feedback) => agendaLevelIs(this.state, String(feedback.options.level)),
      },
      agenda_manual: {
        type: "boolean",
        name: "Ablauf: Punkt von Hand gesetzt (nicht nach Uhr)",
        defaultStyle: MANUAL_STYLE,
        options: [],
        callback: () => this.state.agenda.manual,
      },
      ops_level: {
        type: "boolean",
        name: "Event-Ops: Ampel zeigt",
        defaultStyle: LEVEL_STYLES.bad,
        options: [{ type: "dropdown", id: "level", label: "Farbe", choices: OPS_LEVELS, default: "error" }],
        callback: (feedback) => opsLevelIs(this.state, String(feedback.options.level)),
      },
    };

    const variables: CompanionVariableDefinition[] = [{ variableId: "connected", name: "Mit JMS Control verbunden" }];
    for (const o of this.state.outputs) variables.push({ variableId: variableId("multiview", o.nr), name: `Layout auf „${o.name}“` });
    for (const s of this.state.screens) variables.push({ variableId: variableId("bildschirm", s.nr), name: `Multiview auf Bildschirm „${s.name}“` });
    variables.push(
      { variableId: "agenda_event", name: "Ablauf: Event" },
      { variableId: "agenda_current", name: "Ablauf: laufender Punkt" },
      { variableId: "agenda_remaining", name: "Ablauf: Restzeit (m:ss)" },
      { variableId: "agenda_deviation", name: "Ablauf: Abweichung vom Plan (z. B. +4 min)" },
      { variableId: "agenda_level", name: "Ablauf: Stufe (ok / warn / bad)" },
      { variableId: "agenda_manual", name: "Ablauf: Punkt von Hand gesetzt" },
      { variableId: "agenda_next", name: "Ablauf: nächster Punkt" },
      { variableId: "agenda_next_responsible", name: "Ablauf: Verantwortlich für den nächsten Punkt" },
      { variableId: "ops_overall", name: "Event-Ops: Gesamtzustand (OK / Prüfen / Fehler)" },
      { variableId: "ops_level", name: "Event-Ops: Ampel (ok / warn / error / unknown)" },
      { variableId: "ops_problems", name: "Event-Ops: Anzahl Probleme" },
      { variableId: "ops_first", name: "Event-Ops: wichtigstes Problem" },
    );

    const presets: CompanionPresetDefinitions = {};
    for (const o of this.state.outputs) {
      const category = `Multiview ${o.name}`;
      for (const l of this.state.layouts) {
        presets[`layout_${o.id}_${l.id}`] = {
          type: "button",
          category,
          name: `${o.name}: ${l.name}`,
          style: { text: l.name, size: "auto", color: combineRgb(255, 255, 255), bgcolor: combineRgb(30, 30, 30) },
          steps: [{ down: [{ actionId: "set_layout", options: { output: o.id, layout: l.id } }], up: [] }],
          feedbacks: [{ feedbackId: "layout_active", options: { output: o.id, layout: l.id }, style: ACTIVE_STYLE }],
        };
      }
      for (const dir of ["prev", "next"] as const) {
        presets[`step_${o.id}_${dir}`] = {
          type: "button",
          category,
          name: `${o.name}: ${dir === "next" ? "nächstes" : "vorheriges"} Layout`,
          style: { text: `${dir === "next" ? "▶" : "◀"}\\n$(jms-control:${variableId("multiview", o.nr)})`, size: "auto", color: combineRgb(255, 255, 255), bgcolor: combineRgb(0, 0, 0) },
          steps: [{ down: [{ actionId: "step_layout", options: { output: o.id, dir } }], up: [] }],
          feedbacks: [],
        };
      }
    }
    for (const s of this.state.screens) {
      for (const target of screenTargets) {
        presets[`screen_${s.id}_${target.id}`] = {
          type: "button",
          category: `Bildschirm ${s.name}`,
          name: `${s.name} → ${target.label}`,
          style: { text: `${s.name}\\n${target.label}`, size: "auto", color: combineRgb(255, 255, 255), bgcolor: combineRgb(30, 30, 30) },
          steps: [{ down: [{ actionId: "screen_output", options: { screen: s.id, output: target.id } }], up: [] }],
          feedbacks: [{ feedbackId: "screen_output", options: { screen: s.id, output: target.id }, style: ACTIVE_STYLE }],
        };
      }
    }

    // Ablauf: Status mit Ampel, Schritte vor/zurück, „Nach Uhr“ leuchtet, solange von Hand gesetzt
    const white = combineRgb(255, 255, 255);
    const dark = combineRgb(30, 30, 30);
    presets.agenda_status = {
      type: "button",
      category: "Ablauf",
      name: "Ablauf: laufender Punkt mit Restzeit und Abweichung",
      style: { text: "$(jms-control:agenda_current)\\n$(jms-control:agenda_remaining)\\n$(jms-control:agenda_deviation)", size: "auto", color: white, bgcolor: dark },
      steps: [],
      feedbacks: (["ok", "warn", "bad"] as const).map((level) => ({ feedbackId: "agenda_level", options: { level }, style: LEVEL_STYLES[level] })),
    };
    presets.agenda_next = {
      type: "button",
      category: "Ablauf",
      name: "Ablauf: nächster Punkt",
      style: { text: "▶ $(jms-control:agenda_next)\\n$(jms-control:agenda_next_responsible)", size: "auto", color: white, bgcolor: combineRgb(0, 0, 0) },
      steps: [{ down: [{ actionId: "agenda_next", options: { event: CURRENT_EVENT } }], up: [] }],
      feedbacks: [],
    };
    presets.agenda_previous = {
      type: "button",
      category: "Ablauf",
      name: "Ablauf: vorheriger Punkt",
      style: { text: "◀\\nPunkt zurück", size: "auto", color: white, bgcolor: combineRgb(0, 0, 0) },
      steps: [{ down: [{ actionId: "agenda_previous", options: { event: CURRENT_EVENT } }], up: [] }],
      feedbacks: [],
    };
    presets.agenda_auto = {
      type: "button",
      category: "Ablauf",
      name: "Ablauf: wieder nach Uhr",
      style: { text: "Nach Uhr", size: "auto", color: white, bgcolor: dark },
      steps: [{ down: [{ actionId: "agenda_auto", options: { event: CURRENT_EVENT } }], up: [] }],
      feedbacks: [{ feedbackId: "agenda_manual", options: {}, style: MANUAL_STYLE }],
    };
    presets.agenda_upcoming = {
      type: "button",
      category: "Ablauf",
      name: "Ablauf: danach (nächster Punkt und Verantwortlicher)",
      style: { text: "Dann:\\n$(jms-control:agenda_next)\\n$(jms-control:agenda_next_responsible)", size: "auto", color: white, bgcolor: dark },
      steps: [],
      feedbacks: [],
    };
    // Event-Ops: Ampel wie die Kachel, Anzahl offener Punkte bzw. das wichtigste Problem
    presets.ops_status = {
      type: "button",
      category: "Event-Ops",
      name: "Event-Ops: Ampel mit Anzahl Probleme",
      style: { text: "Event-Ops\\n$(jms-control:ops_overall)\\n$(jms-control:ops_problems) offen", size: "auto", color: white, bgcolor: dark },
      steps: [],
      feedbacks: [
        { feedbackId: "ops_level", options: { level: "ok" }, style: LEVEL_STYLES.ok },
        { feedbackId: "ops_level", options: { level: "warn" }, style: LEVEL_STYLES.warn },
        { feedbackId: "ops_level", options: { level: "error" }, style: LEVEL_STYLES.bad },
      ],
    };
    presets.ops_first = {
      type: "button",
      category: "Event-Ops",
      name: "Event-Ops: wichtigstes Problem",
      style: { text: "$(jms-control:ops_first)", size: "auto", color: white, bgcolor: dark },
      steps: [],
      feedbacks: [
        { feedbackId: "ops_level", options: { level: "warn" }, style: LEVEL_STYLES.warn },
        { feedbackId: "ops_level", options: { level: "error" }, style: LEVEL_STYLES.bad },
      ],
    };

    this.setActionDefinitions(actions);
    this.setFeedbackDefinitions(feedbacks);
    this.setVariableDefinitions(variables);
    this.setPresetDefinitions(presets);
  }
}

runEntrypoint(JmsControlInstance, []);
