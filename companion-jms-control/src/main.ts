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
  SCREEN_OFF,
  apiPath,
  layoutActive,
  layoutChoices,
  listSignature,
  outputChoices,
  parseState,
  screenChoices,
  screenShows,
  variableId,
  type JmsState,
} from "./state.js";

interface ModuleConfig {
  host: string;
  port: number;
  pollMs: number;
}

const ACTIVE_STYLE = { bgcolor: combineRgb(0, 150, 60), color: combineRgb(255, 255, 255) };
const EMPTY: JmsState = { layouts: [], outputs: [], screens: [] };

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

  private async call(method: "GET" | "POST", path: string): Promise<unknown> {
    const base = trustedBase(String(this.config.host || "127.0.0.1").trim(), Number(this.config.port) || 8090);
    return request(base, readDeviceKey(), method, path);
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
    const values: Record<string, string | boolean> = { connected: true };
    for (const o of state.outputs) values[variableId("multiview", o.nr)] = o.layout ?? "";
    for (const s of state.screens) values[variableId("bildschirm", s.nr)] = s.output ?? "aus";
    this.setVariableValues(values);
    this.checkFeedbacks("layout_active", "screen_output");
  }

  private async run(path: string): Promise<void> {
    try {
      await this.call("POST", path);
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
    };

    const variables: CompanionVariableDefinition[] = [{ variableId: "connected", name: "Mit JMS Control verbunden" }];
    for (const o of this.state.outputs) variables.push({ variableId: variableId("multiview", o.nr), name: `Layout auf „${o.name}“` });
    for (const s of this.state.screens) variables.push({ variableId: variableId("bildschirm", s.nr), name: `Multiview auf Bildschirm „${s.name}“` });

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

    this.setActionDefinitions(actions);
    this.setFeedbackDefinitions(feedbacks);
    this.setVariableDefinitions(variables);
    this.setPresetDefinitions(presets);
  }
}

runEntrypoint(JmsControlInstance, []);
