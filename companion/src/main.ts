import {
  InstanceBase,
  InstanceStatus,
  runEntrypoint,
  type SomeCompanionConfigField,
} from "@companion-module/base";
import {
  Agent as UndiciAgent,
  WebSocket as UndiciWebSocket,
  fetch as undiciFetch,
  type Dispatcher,
} from "undici";
import { GetConfigFields, type ModuleConfig } from "./config.js";
import { UpdateActions } from "./actions.js";
import { UpdateFeedbacks } from "./feedbacks.js";
import {
  BuildPresetSignature,
  deriveTextColor,
  parseButtonBgColor,
  UpdatePresets,
} from "./presets.js";
import { UpdateVariableDefinitions } from "./variables.js";
import { UpgradeScripts } from "./upgrades.js";
import { ImageBridge } from "./imageBridge.js";
import type {
  CommandPayload,
  CompanionInbound,
  CompanionPresetProfile,
  CompanionState,
  CompanionProfileResponse,
  CompanionProfilesResponse,
  DiscoveryResponse,
  StreamDeckActionType,
  StreamDeckPageType,
  StreamDeckSettings,
} from "./types.js";

const allowedStreamDeckActionTypes = new Set<StreamDeckActionType>([
  "none",
  "ptt_room",
  "select_talk_room",
  "ptt_selected",
  "listen_room",
  "call_room",
  "direct_user",
  "direct_role",
  "reply_to_caller",
  "incoming_call_indicator",
  "broadcast_ptt",
  "mute_toggle",
  "volume_delta",
  "page_up",
  "page_down",
  "page_jump",
  "page_home",
  "page_back",
]);

type ImageEffectMode = 0 | 1 | 2;

type ImageEffectRule = {
  mode: ImageEffectMode;
  colorHex: string;
};

const signalBlinkIntervalMs = 300;
const maxIncomingCallBlinkCycles = 6;
const incomingCallBlinkDurationMs =
  signalBlinkIntervalMs * maxIncomingCallBlinkCycles * 2;

function normalizeProfileStreamDeckSettings(
  raw: unknown,
): StreamDeckSettings | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const gridColumns = Number(data.gridColumns);
  const gridRows = Number(data.gridRows);
  const version = Number(data.version);
  const selectedPage = Number(data.selectedPage);
  const rawPages = Array.isArray(data.pages) ? data.pages : [];
  const pages = rawPages
    .map((pageEntry) => {
      if (!pageEntry || typeof pageEntry !== "object") return null;
      const pageData = pageEntry as Record<string, unknown>;
      const page = Number(pageData.page);
      const rawButtons = Array.isArray(pageData.buttons) ? pageData.buttons : [];
      const buttons = rawButtons
        .map((buttonEntry) => {
          if (!buttonEntry || typeof buttonEntry !== "object") return null;
          const buttonData = buttonEntry as Record<string, unknown>;
          const index = Number(buttonData.index);
          if (!Number.isInteger(index) || index < 0) return null;

          let action;
          if (buttonData.action && typeof buttonData.action === "object") {
            const actionData = buttonData.action as Record<string, unknown>;
            const typeCandidate = String(actionData.type || "none");
            const type = allowedStreamDeckActionTypes.has(
              typeCandidate as StreamDeckActionType,
            )
              ? (typeCandidate as StreamDeckActionType)
              : "none";
            action = {
              type,
              roomId:
                typeof actionData.roomId === "string" ? actionData.roomId : undefined,
              userId:
                typeof actionData.userId === "string" ? actionData.userId : undefined,
              roleId:
                typeof actionData.roleId === "string" ? actionData.roleId : undefined,
              broadcastGroupId:
                typeof actionData.broadcastGroupId === "string"
                  ? actionData.broadcastGroupId
                  : undefined,
              volumeDelta:
                typeof actionData.volumeDelta === "number"
                  ? actionData.volumeDelta
                  : undefined,
              targetPage:
                typeof actionData.targetPage === "number"
                  ? actionData.targetPage
                  : undefined,
            };
          }

          return {
            index,
            label:
              typeof buttonData.label === "string" ? buttonData.label : undefined,
            color:
              typeof buttonData.color === "string" ? buttonData.color : undefined,
            action,
          };
        })
        .filter((button): button is NonNullable<typeof button> => !!button)
        .sort((a, b) => a.index - b.index);

      if (!Number.isInteger(page) || page < 0) return null;
      const pageTypeCandidate = String(pageData.pageType || "manual").trim();
      const pageType =
        pageTypeCandidate === "all_roles" || pageTypeCandidate === "all_party_lines"
          ? (pageTypeCandidate as StreamDeckPageType)
          : ("manual" as StreamDeckPageType);
      const parentPage = Number(pageData.parentPage);
      return {
        page,
        title: typeof pageData.title === "string" ? pageData.title : undefined,
        pageType,
        parentPage: Number.isInteger(parentPage) && parentPage >= 0 ? parentPage : undefined,
        buttons,
      };
    })
    .filter((page): page is NonNullable<typeof page> => !!page)
    .sort((a, b) => a.page - b.page);

  if (
    !Number.isInteger(gridColumns) ||
    !Number.isInteger(gridRows) ||
    !Number.isInteger(version) ||
    !Number.isInteger(selectedPage) ||
    pages.length === 0
  ) {
    return null;
  }

  return {
    version,
    gridColumns,
    gridRows,
    selectedPage,
    pages,
  };
}

export class ModuleInstance extends InstanceBase<ModuleConfig> {
  config!: ModuleConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectWatchdogTimer: NodeJS.Timeout | null = null;
  private bridgeHealthTimer: NodeJS.Timeout | null = null;
  private bridgeHealthAckTimer: NodeJS.Timeout | null = null;
  private bridgeHealthCommandId = "";
  private signalBlinkTimer: NodeJS.Timeout | null = null;
  private imageEffectBlinkTimer: NodeJS.Timeout | null = null;
  private discoveryRefreshTimer: NodeJS.Timeout | null = null;
  private discoveryRefreshInFlight = false;
  private reconnectAttempts = 0;
  private lastConnectionError = "";
  private insecureTlsDispatcher: Dispatcher | null = null;
  private presetSignature = "";
  private commandSeq = 0;
  private imageBridge: ImageBridge | null = null;
  private imageEffectMapRaw = "";
  private imageEffectMapParseError = "";
  private imageEffectRules = new Map<number, ImageEffectRule>();
  private buttonImageEffectValues = new Map<number, number>();
  private pendingCommands = new Map<
    string,
    { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  public bridgeConnected = false;
  public bound = false;
  public micEnabled = false;
  public voiceMode = "ptt";
  public listenRooms: string[] = [];
  public talkRooms: string[] = [];
  public replyDirectUserId = "";
  public replyDirectUsername = "";
  public signalActive = false;
  public signalFrom = "";
  public signalMessage = "";
  public signalStartedAt = 0;
  public signalBlinkPhase = false;
  public imageEffectBlinkPhase = false;
  public lastCommandOK = true;
  public pendingCommandCount = 0;
  public profileVersion = 0;
  public profileStreamDeckSettings: StreamDeckSettings | null = null;
  public presetProfiles: CompanionPresetProfile[] = [];
  public currentPageNumber = 0;
  public lastBridgeEventAt = 0;
  public lastBridgeCloseAt = 0;
  private appliedProfileVersion = 0;
  private lastPresetProfilesFetch = 0;
  private heldDirectRoleTargets = new Map<string, string>();
  private signalFingerprint = "";
  public discovery: DiscoveryResponse = {
    username: "",
    roleId: "",
    roleName: "",
    rooms: [],
    users: [],
    broadcastGroups: [],
  };

  constructor(internal: unknown) {
    super(internal);
  }

  async init(config: ModuleConfig): Promise<void> {
    this.config = config;
    this.startSignalBlinkTimer();
    this.startImageEffectBlinkTimer();
    this.startDiscoveryRefreshTimer();
    await this.refreshDiscovery();
    this.updateActions();
    this.updateFeedbacks();
    this.updatePresets();
    this.updateVariableDefinitions();
    this.connectBridge();
    this.connectImageBridge();
  }

  async destroy(): Promise<void> {
    this.clearReconnectTimer();
    this.clearConnectWatchdogTimer();
    this.clearBridgeHealthTimers();
    this.clearDiscoveryRefreshTimer();
    if (this.signalBlinkTimer) {
      clearInterval(this.signalBlinkTimer);
      this.signalBlinkTimer = null;
    }
    if (this.imageEffectBlinkTimer) {
      clearInterval(this.imageEffectBlinkTimer);
      this.imageEffectBlinkTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    if (this.imageBridge) {
      this.imageBridge.disconnect();
      this.imageBridge = null;
    }
    if (this.insecureTlsDispatcher) {
      await this.insecureTlsDispatcher.close();
      this.insecureTlsDispatcher = null;
    }
  }

  async configUpdated(config: ModuleConfig): Promise<void> {
    this.config = config;
    this.startDiscoveryRefreshTimer();
    await this.refreshDiscovery();
    this.connectBridge();
    this.connectImageBridge();
  }

  getConfigFields(): SomeCompanionConfigField[] {
    return GetConfigFields();
  }

  updateActions(): void {
    UpdateActions(this);
  }

  updateFeedbacks(): void {
    UpdateFeedbacks(this);
  }

  updatePresets(): void {
    const nextSignature = BuildPresetSignature(this);
    if (nextSignature === this.presetSignature) return;
    this.presetSignature = nextSignature;
    UpdatePresets(this);
  }

  updateVariableDefinitions(): void {
    UpdateVariableDefinitions(this);
    this.updateVariableValues();
  }

  getRoomChoices(
    filter: "all" | "talk" | "listen" = "all",
  ): Array<{ id: string; label: string }> {
    return this.discovery.rooms
      .filter((room) => {
        if (filter === "talk") return room.canTalk;
        if (filter === "listen") return room.canListen;
        return true;
      })
      .map((room) => ({ id: room.id, label: room.name }));
  }

  getUserChoices(): Array<{ id: string; label: string }> {
    const me = this.discovery.username;
    const activeUsers = this.discovery.activeRoleUsers || [];
    if (activeUsers.length > 0) {
      return activeUsers
        .filter((u) => u.username !== me)
        .slice()
        .sort((a, b) => {
          const roleCmp = (a.roleId || "").localeCompare(b.roleId || "", undefined, {
            sensitivity: "base",
          });
          if (roleCmp !== 0) return roleCmp;
          return (a.username || "").localeCompare(b.username || "", undefined, {
            sensitivity: "base",
          });
        })
        .map((u) => ({ id: u.userId, label: `${u.username} (${u.roleId})` }));
    }

    return this.discovery.users
      .filter((u) => u.username !== me)
      .slice()
      .sort((a, b) => {
        const roleCmp = (a.roleId || "").localeCompare(b.roleId || "", undefined, {
          sensitivity: "base",
        });
        if (roleCmp !== 0) return roleCmp;
        return (a.username || "").localeCompare(b.username || "", undefined, {
          sensitivity: "base",
        });
      })
      .map((u) => ({ id: u.id, label: `${u.username} (${u.roleId})` }));
  }

  getBroadcastChoices(): Array<{ id: string; label: string }> {
    return this.discovery.broadcastGroups.map((g) => ({
      id: g.id,
      label: g.name,
    }));
  }

  getActiveRoleUser(
    roleId: string,
  ): { roleId: string; username: string; userId: string } | null {
    const wantedRoleId = roleId.trim();
    if (!wantedRoleId) return null;
    const matches = (this.discovery.activeRoleUsers || [])
      .filter((entry) => (entry.roleId || "").trim() === wantedRoleId)
      .slice()
      .sort((a, b) => {
        const usernameCmp = (a.username || "").localeCompare(b.username || "", undefined, {
          sensitivity: "base",
        });
        if (usernameCmp !== 0) return usernameCmp;
        return (a.userId || "").localeCompare(b.userId || "", undefined, {
          sensitivity: "base",
        });
      });
    return matches[0] || null;
  }

  rememberHeldDirectRoleTarget(controlId: string, userId: string): void {
    this.heldDirectRoleTargets.set(controlId, userId);
  }

  consumeHeldDirectRoleTarget(controlId: string): string {
    const userId = this.heldDirectRoleTargets.get(controlId) || "";
    this.heldDirectRoleTargets.delete(controlId);
    return userId;
  }

  getProfileButtonConfig(pageNumber: number, buttonIndex: number) {
    const settings = this.profileStreamDeckSettings;
    if (!settings) return null;
    const page = settings.pages.find((entry) => entry.page === pageNumber);
    if (!page) return null;
    return page.buttons.find((entry) => entry.index === buttonIndex) || null;
  }

  getPresetProfileButtonConfig(
    roleId: string,
    pageNumber: number,
    buttonIndex: number,
  ) {
    const profile = this.presetProfiles.find(
      (entry) => entry.roleId === roleId,
    );
    const page = profile?.streamDeckSettings.pages.find(
      (entry) => entry.page === pageNumber,
    );
    if (!page) return null;
    return page.buttons.find((entry) => entry.index === buttonIndex) || null;
  }

  getCurrentPageButtonConfig(buttonIndex: number) {
    return this.getProfileButtonConfig(this.currentPageNumber, buttonIndex);
  }

  applyLocalPageNavigation(actionType: string): void {
    const normalized = String(actionType || "").trim();
    if (normalized !== "page_up" && normalized !== "page_down") return;

    const settings = this.profileStreamDeckSettings;
    if (!settings || !Array.isArray(settings.pages) || settings.pages.length === 0) {
      const delta = normalized === "page_up" ? 1 : -1;
      const next = Math.max(0, this.currentPageNumber + delta);
      if (next !== this.currentPageNumber) {
        this.log("info", `Local page fallback: ${this.currentPageNumber} -> ${next} via ${normalized}`);
        this.currentPageNumber = next;
        this.updateVariableValues();
        this.checkFeedbacks("dynamic_button_image");
      }
      return;
    }

    const order = settings.pages
      .map((entry) => Number(entry.page))
      .filter((page) => Number.isInteger(page))
      .sort((a, b) => a - b);
    if (order.length === 0) return;

    let index = order.findIndex((page) => page === this.currentPageNumber);
    if (index < 0) {
      index = 0;
    }

    const delta = normalized === "page_up" ? 1 : -1;
    const nextIndex = Math.max(0, Math.min(order.length - 1, index + delta));
    const nextPage = order[nextIndex];
    if (nextPage !== this.currentPageNumber) {
      this.log("info", `Local page fallback: ${this.currentPageNumber} -> ${nextPage} via ${normalized}`);
      this.currentPageNumber = nextPage;
      this.updateVariableValues();
      this.checkFeedbacks("dynamic_button_image");
    }
  }

  applyLocalPageBack(): void {
    const settings = this.profileStreamDeckSettings;
    const currentPage = settings?.pages.find((entry) => entry.page === this.currentPageNumber);
    const targetPage = currentPage?.parentPage;
    if (!Number.isInteger(targetPage)) {
      this.applyLocalPageJump(0);
      return;
    }
    if (targetPage !== this.currentPageNumber) {
      this.log("info", `Local page back: ${this.currentPageNumber} -> ${targetPage}`);
      this.currentPageNumber = Number(targetPage);
      this.updateVariableValues();
      this.checkFeedbacks("dynamic_button_image");
    }
  }

  applyLocalPageJump(targetPage: number): void {
    const settings = this.profileStreamDeckSettings;
    const order = (settings?.pages ?? [])
      .map((entry) => Number(entry.page))
      .filter((page) => Number.isInteger(page))
      .sort((a, b) => a - b);

    let nextPage = targetPage;
    if (order.length > 0 && !order.includes(targetPage)) {
      nextPage = order[0];
    }

    if (nextPage !== this.currentPageNumber) {
      this.log("info", `Local page jump: ${this.currentPageNumber} -> ${nextPage}`);
      this.currentPageNumber = nextPage;
      this.updateVariableValues();
      this.checkFeedbacks("dynamic_button_image");
    }
  }

  private getButtonImageEffectValue(slotIndex: number, pageNumber: number): number | undefined {
    const slot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : -1;
    const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : -1;
    if (slot < 0 || slot > 99 || page < 0) return undefined;
    return this.buttonImageEffectValues.get(page * 100 + slot);
  }

  getButtonEffectValue(buttonIndex: number, pageNumber?: number): number {
    const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber as number) : this.currentPageNumber;
    const pageScoped = this.getButtonImageEffectValue(buttonIndex, page);
    if (pageScoped !== undefined) return pageScoped;
    return this.buttonImageEffectValues.get(buttonIndex) ?? 0;
  }

  getCurrentPageButtonEffectValue(buttonIndex: number): number {
    return this.getButtonEffectValue(buttonIndex, this.currentPageNumber);
  }

  resolveSyncedButtonLabel(button: {
    label?: string;
    action?: {
      type?: string;
      roomId?: string;
      userId?: string;
      roleId?: string;
      broadcastGroupId?: string;
    };
  }): string {
    const explicitLabel = (button.label || "").trim();
    if (explicitLabel) return explicitLabel;

    const action = button.action;
    if (!action?.type) return "";

    switch (action.type) {
      case "ptt_room":
      case "select_talk_room":
      case "listen_room":
      case "call_room":
        return (
          this.discovery.rooms.find((room) => room.id === action.roomId)?.name ||
          (action.roomId || "")
        );
      case "ptt_selected":
        return "PTT";
      case "direct_user": {
        const user = this.discovery.users.find((entry) => entry.id === action.userId);
        return user?.username || action.userId || "";
      }
      case "direct_role": {
        const roleId = (action.roleId || "").trim();
        if (!roleId) return "";
        const active = (this.discovery.activeRoleUsers || []).find(
          (entry) => (entry.roleId || "").trim() === roleId,
        );
        if (active?.username) return `${active.username}\n${roleId}`;
        return roleId;
      }
      case "reply_to_caller":
        return this.replyDirectUsername
          ? `Reply\n${this.replyDirectUsername}`
          : "Reply";
      case "incoming_call_indicator":
        return "Incoming\nCall";
      case "broadcast_ptt":
        return (
          this.discovery.broadcastGroups.find(
            (group) => group.id === action.broadcastGroupId,
          )?.name || (action.broadcastGroupId || "")
        );
      case "mute_toggle":
        return "Mute";
      case "volume_delta":
        return "Volume";
      case "page_up":
        return "Page +";
      case "page_down":
        return "Page -";
      case "page_home":
        return "Home";
      case "page_jump": {
        const tp = (action as { targetPage?: number }).targetPage;
        return tp !== undefined ? `Page ${tp + 1}` : "Jump";
      }
      default:
        return "";
    }
  }

  private normalizeColorHex(value: unknown, fallback = "#ff2d26"): string {
    const text = String(value || "").trim();
    const normalized = text.startsWith("#") ? text.slice(1) : text;
    if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
      return `#${normalized.toLowerCase()}`;
    }
    if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
      const expanded = normalized
        .split("")
        .map((part) => `${part}${part}`)
        .join("");
      return `#${expanded.toLowerCase()}`;
    }
    return fallback;
  }

  private parseImageEffectMode(raw: unknown): ImageEffectMode | null {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const normalized = Math.trunc(raw);
      if (normalized === 0 || normalized === 1 || normalized === 2) {
        return normalized;
      }
      return null;
    }

    const text = String(raw || "").trim().toLowerCase();
    if (text === "0" || text === "none" || text === "off") return 0;
    if (text === "1" || text === "blink" || text === "blinking") return 1;
    if (text === "2" || text === "static" || text === "solid" || text === "glow") {
      return 2;
    }
    return null;
  }

  private applyImageEffectMapFromJson(rawJson: unknown): void {
    const rawText = String(rawJson || "").trim();
    if (rawText === this.imageEffectMapRaw) return;

    this.imageEffectMapRaw = rawText;
    this.imageEffectMapParseError = "";
    this.imageEffectRules.clear();

    if (!rawText) {
      this.updateVariableValues();
      this.checkFeedbacks("dynamic_button_image");
      return;
    }

    try {
      const parsed = JSON.parse(rawText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("imageEffectMapJson must be a JSON object");
      }

      for (const [rawCode, rawRule] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        const code = Number(rawCode);
        if (!Number.isInteger(code) || code < 0) continue;

        if (rawRule && typeof rawRule === "object" && !Array.isArray(rawRule)) {
          const ruleObject = rawRule as Record<string, unknown>;
          const mode = this.parseImageEffectMode(
            ruleObject.mode ?? ruleObject.type ?? ruleObject.effect,
          );
          if (mode === null) continue;
          const colorHex = this.normalizeColorHex(
            ruleObject.color ?? ruleObject.colorHex,
          );
          this.imageEffectRules.set(code, { mode, colorHex });
          continue;
        }

        const mode = this.parseImageEffectMode(rawRule);
        if (mode !== null) {
          this.imageEffectRules.set(code, {
            mode,
            colorHex: "#ff2d26",
          });
        }
      }
    } catch (error) {
      this.imageEffectMapParseError =
        error instanceof Error ? error.message : "invalid JSON";
      this.log("warn", `Invalid imageEffectMapJson: ${this.imageEffectMapParseError}`);
    }

    this.updateVariableValues();
    this.checkFeedbacks("dynamic_button_image");
  }

  private getImageEffectMapJsonFromState(state: CompanionState): string {
    return typeof state.imageEffectMapJson === "string"
      ? state.imageEffectMapJson
      : "";
  }

  private updateSignalState(active: boolean, from: string, message: string, startedAt: number): void {
    const normalizedFrom = String(from || "").trim();
    const normalizedMessage = String(message || "").trim();
    if (!active) {
      this.signalActive = false;
      this.signalFrom = "";
      this.signalMessage = "";
      this.signalStartedAt = 0;
      this.signalFingerprint = "";
      this.signalBlinkPhase = false;
      return;
    }

    const fingerprint = `${normalizedFrom}|${normalizedMessage}`;
    const fallbackStartedAt =
      fingerprint === this.signalFingerprint && this.signalStartedAt > 0
        ? this.signalStartedAt
        : Date.now();
    this.signalActive = true;
    this.signalFrom = normalizedFrom;
    this.signalMessage = normalizedMessage;
    this.signalStartedAt = Number.isFinite(startedAt) && startedAt > 0
      ? Math.trunc(startedAt)
      : fallbackStartedAt;
    this.signalFingerprint = fingerprint;
  }

  public signalBlinkAttentionActive(): boolean {
    if (!this.signalActive) return false;
    if (this.signalStartedAt <= 0) return false;
    return Date.now() - this.signalStartedAt < incomingCallBlinkDurationMs;
  }

  public incomingCallBlinkActive(): boolean {
    if (this.signalMessage.trim().toLowerCase() !== "call") return false;
    return this.signalBlinkAttentionActive();
  }

  setButtonImageEffectValue(slotIndex: number, effectValue: number, pageNumber?: number): void {
    const slot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : -1;
    const value = Number.isFinite(effectValue) ? Math.trunc(effectValue) : 0;
    if (slot < 0 || slot > 99) return;

    const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber as number) : -1;
    const key = page >= 0 ? page * 100 + slot : slot;
    if (this.buttonImageEffectValues.get(key) === value) return;

    this.buttonImageEffectValues.set(key, value);
    if (page === this.currentPageNumber) {
      this.buttonImageEffectValues.set(slot, value)
    }
    this.checkFeedbacks("dynamic_button_image");
  }

  getImageEffectRuleForSlot(slotIndex: number, pageNumber?: number): ImageEffectRule {
    const slot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : 0;
    const page = Number.isFinite(pageNumber)
      ? Math.trunc(pageNumber as number)
      : this.currentPageNumber;
    const effectValue = this.getButtonEffectValue(slot, pageNumber);
    const normalizedValue = Number.isFinite(effectValue) ? Math.trunc(effectValue) : 0;
    const buttonConfig = this.getProfileButtonConfig(page, slot);
    if (
      buttonConfig?.action?.type === "incoming_call_indicator" &&
      !this.incomingCallBlinkActive()
    ) {
      return {
        mode: 0,
        colorHex: "#ff2d26",
      };
    }
    const mapped = this.imageEffectRules.get(normalizedValue);
    if (mapped) return mapped;
    return {
      mode: 0,
      colorHex: "#ff2d26",
    };
  }



  private effectiveUseTls(): boolean {
    const port = Number(this.config.port || 0);
    return Boolean(this.config.useTls) || port === 443 || port === 8443;
  }

  private autoTlsEnabled(): boolean {
    const port = Number(this.config.port || 0);
    return !Boolean(this.config.useTls) && (port === 443 || port === 8443);
  }

  private allowSelfSignedTls(): boolean {
    return this.effectiveUseTls() && this.config.allowSelfSignedTls !== false;
  }

  private transportDispatcher(): Dispatcher | undefined {
    if (!this.allowSelfSignedTls()) return undefined;
    if (!this.insecureTlsDispatcher) {
      this.insecureTlsDispatcher = new UndiciAgent({
        connect: {
          rejectUnauthorized: false,
        },
      });
    }
    return this.insecureTlsDispatcher;
  }

  private baseHttpURL(): string {
    const protocol = this.effectiveUseTls() ? "https" : "http";
    return `${protocol}://${this.config.host}:${this.config.port}`;
  }

  private baseWsURL(): string {
    const protocol = this.effectiveUseTls() ? "wss" : "ws";
    return `${protocol}://${this.config.host}:${this.config.port}`;
  }

  private async fetchJson<T>(url: string, label: string): Promise<T> {
    const res = await undiciFetch(url, {
      dispatcher: this.transportDispatcher(),
    });
    if (!res.ok) {
      let body = "";
      try {
        body = (await res.text()).trim();
      } catch {
        body = "";
      }
      const statusText = [res.status, res.statusText].filter(Boolean).join(" ");
      const detail = body ? `${statusText}: ${body}` : statusText;
      throw new Error(`${label} failed (${detail})`);
    }
    return (await res.json()) as T;
  }

  private formatConnectionError(err: unknown, fallback: string): string {
    if (!(err instanceof Error)) return fallback;
    const cause = (err as Error & { cause?: unknown }).cause;
    if (cause && typeof cause === "object") {
      const detail = cause as { code?: unknown; message?: unknown };
      const code = typeof detail.code === "string" ? detail.code : "";
      const message = typeof detail.message === "string" ? detail.message : "";
      const causeText = [code, message].filter(Boolean).join(": ");
      if (causeText) return `${err.message}: ${causeText}`;
    }
    return err.message || fallback;
  }

  private createWebSocket(url: string): WebSocket {
    const dispatcher = this.transportDispatcher();
    if (dispatcher) {
      return new UndiciWebSocket(url, { dispatcher }) as unknown as WebSocket;
    }
    return new UndiciWebSocket(url) as unknown as WebSocket;
  }

  private companionSecretQuery(): string {
    const secret = (this.config.companionSecret || "").trim();
    if (!secret) return "";
    return `secret=${encodeURIComponent(secret)}`;
  }

  private companionTargetQuery(): string {
    const roleId = (this.config.roleId || "").trim();
    if (roleId) {
      return `roleId=${encodeURIComponent(roleId)}`;
    }
    return "";
  }

  private companionTargetLabel(): string {
    const roleId = (this.config.roleId || "").trim();
    if (roleId) return `roleId=${roleId}`;
    const username = (this.config.username || "").trim();
    if (username) return "auto (username ignored)";
    return "auto";
  }

  private static formatTimestamp(ts: number): string {
    if (!ts || !Number.isFinite(ts)) return "";
    return new Date(ts).toISOString();
  }

  runConnectionDiagnostics(forceReconnect = false): void {
    const bridgeState =
      this.ws?.readyState === WebSocket.OPEN
        ? "open"
        : this.ws?.readyState === WebSocket.CONNECTING
          ? "connecting"
          : this.ws?.readyState === WebSocket.CLOSING
            ? "closing"
            : this.ws?.readyState === WebSocket.CLOSED
              ? "closed"
              : "none";
    const imageDiag = this.imageBridge?.getDiagnostics();

    this.log(
      "info",
      [
        "Connection diagnostics:",
        `target=${this.companionTargetLabel()}`,
        `transport=${this.effectiveUseTls() ? "https/wss" : "http/ws"}`,
        `autoTls=${this.autoTlsEnabled()}`,
        `selfSignedTls=${this.allowSelfSignedTls()}`,
        `bridgeConnected=${this.bridgeConnected}`,
        `bridgeWsState=${bridgeState}`,
        `bound=${this.bound}`,
        `pendingCommands=${this.pendingCommandCount}`,
        `lastCommandOK=${this.lastCommandOK}`,
        `lastBridgeEventAt=${ModuleInstance.formatTimestamp(this.lastBridgeEventAt) || "n/a"}`,
        `lastBridgeCloseAt=${ModuleInstance.formatTimestamp(this.lastBridgeCloseAt) || "n/a"}`,
        `imageConnected=${imageDiag?.connected ?? false}`,
        `imageWsState=${imageDiag?.websocketState ?? "none"}`,
        `imageReconnectAttempts=${imageDiag?.reconnectAttempts ?? 0}`,
        `imageStoredImages=${imageDiag?.storedImageCount ?? 0}`,
        `imageLastMessageAt=${ModuleInstance.formatTimestamp(imageDiag?.lastMessageAt ?? 0) || "n/a"}`,
        `imageLastError=${imageDiag?.lastError || ""}`,
      ].join(" "),
    );

    if (forceReconnect) {
      this.log("info", "Connection diagnostics requested reconnect");
      this.connectBridge();
      this.connectImageBridge();
    }
  }

  runImageSlotDiagnostics(slotIndex: number): void {
    const normalizedSlot = Number.isFinite(slotIndex)
      ? Math.max(0, Math.min(99, Math.trunc(slotIndex)))
      : 0;
    const button = this.getCurrentPageButtonConfig(normalizedSlot) || {
      index: normalizedSlot,
    };
    const imageBuffer = this.getButtonImage(normalizedSlot);
    const imageDiag = this.imageBridge?.getDiagnostics();
    const actionType = button.action?.type || "none";
    const target =
      button.action?.roomId ||
      button.action?.userId ||
      button.action?.roleId ||
      button.action?.broadcastGroupId ||
      "";

    this.log(
      "info",
      [
        "Image slot diagnostics:",
        `slot=${normalizedSlot}`,
        `page=${this.currentPageNumber}`,
        `buttonLabel=${JSON.stringify((button.label || "").trim())}`,
        `buttonColor=${button.color || ""}`,
        `actionType=${actionType}`,
        `actionTarget=${target}`,
        `imageFound=${Boolean(imageBuffer)}`,
        `imageBytes=${imageBuffer?.length || 0}`,
        `imageConnected=${imageDiag?.connected ?? false}`,
        `imageWsState=${imageDiag?.websocketState ?? "none"}`,
        `imageStoredImages=${imageDiag?.storedImageCount ?? 0}`,
        `imageLastError=${imageDiag?.lastError || ""}`,
      ].join(" "),
    );
  }

  private toCompanionPresetProfile(
    profile: CompanionProfileResponse,
    streamDeckSettings: StreamDeckSettings | null = null,
  ): CompanionPresetProfile | null {
    const settings =
      streamDeckSettings || normalizeProfileStreamDeckSettings(profile.streamDeckSettings);
    if (!settings) return null;
    const roleId = String(
      profile.roleId || this.discovery.roleId || this.config.roleId || "",
    ).trim();
    if (!roleId) return null;
    return {
      roleId,
      roleName: profile.roleName || "",
      username: String(
        profile.username || this.discovery.username || this.config.username || "Default profile",
      ).trim(),
      profileVersion: Number(profile.profileVersion || 0),
      profileUpdatedAt: Number(profile.profileUpdatedAt || 0),
      streamDeckSettings: settings,
    };
  }

  private async refreshCompanionPresetProfiles(
    fallbackProfile: CompanionPresetProfile | null = null,
    force = false,
  ): Promise<void> {
    const host = (this.config.host || "").trim();
    if (!host) return;
    const now = Date.now();
    if (!force && now - this.lastPresetProfilesFetch < 5000) return;
    this.lastPresetProfilesFetch = now;

    const secretQuery = this.companionSecretQuery();
    const url = secretQuery
      ? `${this.baseHttpURL()}/api/companion/profiles?${secretQuery}`
      : `${this.baseHttpURL()}/api/companion/profiles`;
    try {
      const response = await this.fetchJson<CompanionProfilesResponse>(
        url,
        "published profiles fetch",
      );
      const profiles = (Array.isArray(response.profiles) ? response.profiles : [])
        .map((profile) => this.toCompanionPresetProfile(profile))
        .filter((profile): profile is CompanionPresetProfile => !!profile);
      this.presetProfiles = profiles.length > 0
        ? profiles
        : fallbackProfile
          ? [fallbackProfile]
          : [];
    } catch (err) {
      if (fallbackProfile) {
        this.presetProfiles = [fallbackProfile];
      }
      const detail = this.formatConnectionError(
        err,
        "unknown published profiles sync error",
      );
      this.log("warn", `Published profiles sync failed: ${detail}`);
    }
  }

  async refreshDiscovery(): Promise<void> {
    const host = (this.config.host || "").trim();
    const targetQuery = this.companionTargetQuery();
    if (!host || this.discoveryRefreshInFlight) return;
    const secretQuery = this.companionSecretQuery();
    const queryParts = [targetQuery, secretQuery].filter(Boolean);
    const url = queryParts.length
      ? `${this.baseHttpURL()}/api/companion/discovery?${queryParts.join("&")}`
      : `${this.baseHttpURL()}/api/companion/discovery`;
    this.discoveryRefreshInFlight = true;
    try {
      const data = await this.fetchJson<DiscoveryResponse>(url, "discovery");
      this.lastConnectionError = "";
      this.discovery = data;
      if (Number.isInteger(Number(data.currentPageNumber ?? NaN))) {
        this.currentPageNumber = Number(data.currentPageNumber ?? 0);
      }
      this.profileVersion = Number(data.profileVersion || 0);
      if (this.profileVersion > this.appliedProfileVersion) {
        await this.refreshCompanionProfile();
      }
      await this.refreshCompanionPresetProfiles(null, false);
      this.updateActions();
      this.updateFeedbacks();
      this.updatePresets();
      this.updateVariableDefinitions();
    } catch (err) {
      const syncError = this.formatConnectionError(err, "unknown discovery error");
      this.lastConnectionError = syncError;
      if (!this.bridgeConnected) {
        this.updateStatus(InstanceStatus.ConnectionFailure, syncError);
      }
      this.log(
        "warn",
        `Discovery refresh failed: ${syncError}`,
      );
    } finally {
      this.discoveryRefreshInFlight = false;
    }
  }

  async refreshCompanionProfile(): Promise<void> {
    const host = (this.config.host || "").trim();
    const targetQuery = this.companionTargetQuery();
    if (!host) return;
    const secretQuery = this.companionSecretQuery();
    const queryParts = [targetQuery, secretQuery].filter(Boolean);
    const url = queryParts.length
      ? `${this.baseHttpURL()}/api/companion/profile?${queryParts.join("&")}`
      : `${this.baseHttpURL()}/api/companion/profile`;
    try {
      const profile = await this.fetchJson<CompanionProfileResponse>(url, "profile fetch");
      this.lastConnectionError = "";
      this.discovery = {
        username: profile.username || this.discovery.username,
        roleId: profile.roleId || this.discovery.roleId,
        roleName: profile.roleName || this.discovery.roleName,
        pageNumber: Number(profile.pageNumber ?? this.discovery.pageNumber ?? -1),
        currentPageNumber: Number(
          profile.currentPageNumber ??
            this.discovery.currentPageNumber ??
            this.currentPageNumber,
        ),
        rooms: profile.rooms || [],
        users: profile.users || [],
        activeRoleUsers: profile.activeRoleUsers || [],
        broadcastGroups: profile.broadcastGroups || [],
        profileVersion: Number(profile.profileVersion || 0),
        profileStatus: profile.profileStatus || "published",
        profileUpdatedAt: Number(profile.profileUpdatedAt || 0),
      };
      this.profileStreamDeckSettings = normalizeProfileStreamDeckSettings(
        profile.streamDeckSettings,
      );
      const fallbackPresetProfile = this.toCompanionPresetProfile(
        profile,
        this.profileStreamDeckSettings,
      );
      this.presetProfiles = fallbackPresetProfile ? [fallbackPresetProfile] : [];
      this.currentPageNumber = Number(
        profile.currentPageNumber ??
          this.profileStreamDeckSettings?.selectedPage ??
          this.currentPageNumber,
      );
      this.profileVersion = Number(profile.profileVersion || 0);
      this.appliedProfileVersion = this.profileVersion;
      await this.refreshCompanionPresetProfiles(fallbackPresetProfile, true);
      this.updateActions();
      this.updateFeedbacks();
      this.updatePresets();
      this.updateVariableDefinitions();
    } catch (err) {
      const syncError = this.formatConnectionError(err, "unknown profile sync error");
      this.lastConnectionError = syncError;
      if (!this.bridgeConnected) {
        this.updateStatus(InstanceStatus.ConnectionFailure, syncError);
      }
      this.log("warn", `Companion profile sync failed: ${syncError}`);
      this.checkFeedbacks();
    }
  }

  private clearDiscoveryRefreshTimer(): void {
    if (this.discoveryRefreshTimer) {
      clearInterval(this.discoveryRefreshTimer);
      this.discoveryRefreshTimer = null;
    }
  }

  private startDiscoveryRefreshTimer(): void {
    if (this.discoveryRefreshTimer) return;
    this.discoveryRefreshTimer = setInterval(() => {
      void this.refreshDiscovery();
    }, 2000);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearConnectWatchdogTimer(): void {
    if (this.connectWatchdogTimer) {
      clearTimeout(this.connectWatchdogTimer);
      this.connectWatchdogTimer = null;
    }
  }

  private startConnectWatchdog(ws: WebSocket): void {
    this.clearConnectWatchdogTimer();
    this.connectWatchdogTimer = setTimeout(() => {
      if (this.ws !== ws) return;
      if (ws.readyState !== WebSocket.CONNECTING) return;
      this.log("warn", "Bridge websocket connect timeout; reconnecting");
      this.connectBridge();
    }, 7000);
  }

  private clearBridgeHealthTimers(): void {
    if (this.bridgeHealthTimer) {
      clearInterval(this.bridgeHealthTimer);
      this.bridgeHealthTimer = null;
    }
    if (this.bridgeHealthAckTimer) {
      clearTimeout(this.bridgeHealthAckTimer);
      this.bridgeHealthAckTimer = null;
    }
    this.bridgeHealthCommandId = "";
  }

  private startBridgeHealthTimer(ws: WebSocket): void {
    this.clearBridgeHealthTimers();
    this.bridgeHealthTimer = setInterval(() => {
      if (this.ws !== ws) return;
      if (ws.readyState !== WebSocket.OPEN) return;
      if (this.bridgeHealthCommandId) return;

      const commandId = `health-${Date.now()}`;
      this.bridgeHealthCommandId = commandId;
      try {
        ws.send(
          JSON.stringify({
            type: "command",
            data: {
              command: "press_button",
              buttonIndex: -1,
              state: "down",
              commandId,
            },
          }),
        );
      } catch {
        this.bridgeHealthCommandId = "";
        this.log("warn", "Bridge health-check send failed; reconnecting");
        if (this.ws === ws) {
          this.connectBridge();
        }
        return;
      }

      this.bridgeHealthAckTimer = setTimeout(() => {
        if (this.ws !== ws) return;
        if (!this.bridgeHealthCommandId) return;
        this.bridgeHealthCommandId = "";
        this.log("warn", "Bridge health-check timeout; reconnecting");
        this.connectBridge();
      }, 5000);
    }, 10000);
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectAttempts += 1;
    const delayMs = Math.min(
      8000,
      500 * 2 ** Math.min(5, this.reconnectAttempts),
    );
    this.reconnectTimer = setTimeout(() => this.connectBridge(), delayMs);
  }

  private startSignalBlinkTimer(): void {
    if (this.signalBlinkTimer) return;
    this.signalBlinkTimer = setInterval(() => {
      const nextBlinkPhase = this.signalBlinkAttentionActive()
        ? !this.signalBlinkPhase
        : false;
      if (nextBlinkPhase === this.signalBlinkPhase) return;
      this.signalBlinkPhase = nextBlinkPhase;
      this.checkSignalFeedbacks();
    }, signalBlinkIntervalMs);
  }

  private checkSignalFeedbacks(): void {
    this.checkFeedbacks("signal_active_blink");
    this.checkFeedbacks("incoming_call_blink");
  }

  private startImageEffectBlinkTimer(): void {
    if (this.imageEffectBlinkTimer) return;
    this.imageEffectBlinkTimer = setInterval(() => {
      this.imageEffectBlinkPhase = !this.imageEffectBlinkPhase;
      this.checkFeedbacks("dynamic_button_image");
    }, 450);
  }

  private connectBridge(): void {
    this.clearReconnectTimer();
    this.clearConnectWatchdogTimer();
    this.clearBridgeHealthTimers();
    this.ws?.close();
    this.ws = null;

    const host = (this.config.host || "").trim();
    const targetQuery = this.companionTargetQuery();
    const targetLabel = this.companionTargetLabel();
    if (!host) {
      this.updateStatus(
        InstanceStatus.BadConfig,
        "host is required",
      );
      this.bridgeConnected = false;
      this.bound = false;
      this.heldDirectRoleTargets.clear();
      this.micEnabled = false;
      this.listenRooms = [];
      this.talkRooms = [];
      this.replyDirectUserId = "";
      this.replyDirectUsername = "";
      this.signalActive = false;
      this.signalFrom = "";
      this.signalMessage = "";
      this.signalStartedAt = 0;
      this.signalFingerprint = "";
      this.signalBlinkPhase = false;
      this.lastCommandOK = false;
      this.pendingCommandCount = 0;
      this.updateVariableValues();
      this.checkFeedbacks();
      return;
    }

    const secretQuery = this.companionSecretQuery();
    const queryParts = [targetQuery, secretQuery].filter(Boolean);
    const url = queryParts.length
      ? `${this.baseWsURL()}/api/companion/ws?${queryParts.join("&")}`
      : `${this.baseWsURL()}/api/companion/ws`;
    this.updateStatus(InstanceStatus.Connecting);
    if (this.autoTlsEnabled()) {
      this.log(
        "info",
        `Using TLS automatically for backend port ${this.config.port}`,
      );
    }
    if (!targetQuery && (this.config.username || "").trim()) {
      this.log("warn", "Target username is deprecated and ignored; set target role ID");
    }
    const ws = this.createWebSocket(url);
    this.ws = ws;
    this.startConnectWatchdog(ws);

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.clearConnectWatchdogTimer();
      this.clearReconnectTimer();
      this.reconnectAttempts = 0;
      this.bridgeConnected = true;
      this.lastConnectionError = "";
      this.lastBridgeEventAt = Date.now();
      this.updateStatus(InstanceStatus.Ok);
      this.log("info", `Companion bridge connected (${targetLabel})`);
      this.startBridgeHealthTimer(ws);
      void this.refreshDiscovery();
      this.updateVariableValues();
      this.checkFeedbacks();
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      if (this.ws !== ws) return;
      try {
        const raw =
          typeof event.data === "string" ? event.data : String(event.data);
        const payload = JSON.parse(raw) as CompanionInbound;
        this.lastBridgeEventAt = Date.now();
        if (!payload || typeof payload !== "object") {
          this.log("warn", "Ignoring malformed bridge message");
          return;
        }

        if (payload.type === "companion_command_result") {
          if (!payload.data || typeof payload.data !== "object") {
            this.log("warn", "Ignoring malformed command result payload");
            return;
          }
          const commandID = String(payload.data.commandId || "");
          const status = String(payload.data.status || "").trim();
          if (commandID && commandID === this.bridgeHealthCommandId) {
            this.bridgeHealthCommandId = "";
            if (this.bridgeHealthAckTimer) {
              clearTimeout(this.bridgeHealthAckTimer);
              this.bridgeHealthAckTimer = null;
            }
            return;
          }
          this.log(
            "info",
            `Command result ${commandID || "(no-id)"}: ok=${payload.data.ok ? "1" : "0"}` +
              ` status=${status || ""}` +
              ` command=${String(payload.data.command || "")}` +
              ` error=${String(payload.data.error || "")}`,
          );
          const pending = this.pendingCommands.get(commandID);
          if (status === "queued") {
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingCommands.delete(commandID);
              this.lastCommandOK = true;
              pending.resolve();
            }
            this.pendingCommandCount = this.pendingCommands.size;
            this.updateVariableValues();
            this.checkFeedbacks();
            return;
          }
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommands.delete(commandID);
            this.pendingCommandCount = this.pendingCommands.size;
            if (payload.data.ok) {
              this.lastCommandOK = true;
              pending.resolve();
            } else {
              const errorMsg = payload.data.error || "command failed";
              this.lastCommandOK = false;
              pending.reject(new Error(errorMsg));
            }
          } else if (!payload.data.ok) {
            this.lastCommandOK = false;
          } else if (status !== "queued") {
            this.lastCommandOK = true;
            this.pendingCommandCount = this.pendingCommands.size;
          }
          this.updateVariableValues();
          this.checkFeedbacks();
          return;
        }

        if (payload.type !== "companion_state") return;
        if (!payload.data || typeof payload.data !== "object") {
          this.log("warn", "Ignoring malformed companion state payload");
          return;
        }
        this.bound = !!payload.data.bound;
        this.voiceMode = payload.data.presence?.voiceMode || "ptt";
        this.micEnabled = !!payload.data.presence?.micEnabled;
        this.listenRooms = payload.data.presence?.listenRooms || [];
        this.talkRooms = payload.data.presence?.talkRooms || [];
        this.replyDirectUserId = payload.data.replyDirectUserId || "";
        this.replyDirectUsername = payload.data.replyDirectUsername || "";
        const previousSignalFingerprint = this.signalFingerprint;
        const previousSignalStartedAt = this.signalStartedAt;
        const previousSignalBlinkPhase = this.signalBlinkPhase;
        const previousIncomingCallActive = this.incomingCallBlinkActive();
        this.updateSignalState(
          !!payload.data.signalActive,
          payload.data.signalFrom || "",
          payload.data.signalMessage || "",
          Number(payload.data.signalStartedAt || 0),
        );
        const incomingCallActive = this.incomingCallBlinkActive();
        const signalChanged =
          previousSignalFingerprint !== this.signalFingerprint ||
          previousSignalStartedAt !== this.signalStartedAt ||
          previousIncomingCallActive !== incomingCallActive;
        if (incomingCallActive && signalChanged) {
          this.signalBlinkPhase = true;
        }
        if (!this.signalActive) {
          this.signalBlinkPhase = false;
        }
        if (signalChanged || previousSignalBlinkPhase !== this.signalBlinkPhase) {
          this.checkSignalFeedbacks();
        }
        this.applyImageEffectMapFromJson(this.getImageEffectMapJsonFromState(payload.data));
        this.profileVersion = Number(payload.data.profileVersion || this.profileVersion || 0);
        if (Number.isInteger(Number(payload.data.currentPageNumber ?? NaN))) {
          const nextPage = Number(payload.data.currentPageNumber ?? 0);
          if (nextPage !== this.currentPageNumber) {
            this.log("info", `Companion state page changed: ${this.currentPageNumber} -> ${nextPage}`);
            this.currentPageNumber = nextPage;
          }
        }
        this.updateVariableValues();
        this.checkFeedbacks();
      } catch (err) {
        this.log(
          "warn",
          `Ignoring invalid bridge websocket message: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.clearConnectWatchdogTimer();
      this.clearBridgeHealthTimers();
      this.bridgeConnected = false;
      this.lastBridgeCloseAt = Date.now();
      this.bound = false;
      this.micEnabled = false;
      this.listenRooms = [];
      this.talkRooms = [];
      this.replyDirectUserId = "";
      this.replyDirectUsername = "";
      this.signalActive = false;
      this.signalFrom = "";
      this.signalMessage = "";
      this.signalStartedAt = 0;
      this.signalFingerprint = "";
      this.signalBlinkPhase = false;
      this.buttonImageEffectValues.clear();
      this.lastCommandOK = false;
      for (const pending of this.pendingCommands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("bridge disconnected"));
      }
      this.pendingCommands.clear();
      this.pendingCommandCount = 0;
      this.updateStatus(
        InstanceStatus.ConnectionFailure,
        this.lastConnectionError || "bridge disconnected",
      );
      this.updateVariableValues();
      this.checkFeedbacks();
      this.scheduleReconnect();
    };

    ws.onerror = (event) => {
      if (this.ws !== ws) return;
      this.log(
        "warn",
        `Bridge websocket error (${targetLabel || "unconfigured target"}); waiting for close event`,
      );
      if (!this.lastConnectionError) {
        this.lastConnectionError = "bridge websocket error";
      }
      // Do not call ws.close() here: undici can recurse error->close->error and crash.
      void event;
    };
  }

  private updateVariableValues(): void {
    const values: Record<string, string> = {};

    const bridgeState =
      this.ws?.readyState === WebSocket.OPEN
        ? "open"
        : this.ws?.readyState === WebSocket.CONNECTING
          ? "connecting"
          : this.ws?.readyState === WebSocket.CLOSING
            ? "closing"
            : this.ws?.readyState === WebSocket.CLOSED
              ? "closed"
              : "none";
    const imageDiag = this.imageBridge?.getDiagnostics();

    values["connection_target"] = this.companionTargetLabel();
    values["bridge_connected"] = this.bridgeConnected ? "1" : "0";
    values["bridge_ws_state"] = bridgeState;
    values["bridge_bound"] = this.bound ? "1" : "0";
    values["pending_commands"] = String(this.pendingCommandCount);
    values["last_command_ok"] = this.lastCommandOK ? "1" : "0";
    values["last_bridge_event_at"] = ModuleInstance.formatTimestamp(this.lastBridgeEventAt);
    values["last_bridge_close_at"] = ModuleInstance.formatTimestamp(this.lastBridgeCloseAt);
    values["image_connected"] = imageDiag?.connected ? "1" : "0";
    values["image_ws_state"] = imageDiag?.websocketState || "none";
    values["image_reconnect_attempts"] = String(imageDiag?.reconnectAttempts ?? 0);
    values["image_last_message_at"] = ModuleInstance.formatTimestamp(imageDiag?.lastMessageAt ?? 0);
    values["image_last_error"] = imageDiag?.lastError || "";
    values["image_stored_images"] = String(imageDiag?.storedImageCount ?? 0);
    values["image_effect_map_json"] = this.imageEffectMapRaw;
    values["image_effect_map_status"] = this.imageEffectMapParseError
      ? `error: ${this.imageEffectMapParseError}`
      : `ok (${this.imageEffectRules.size} rules)`;

    for (let slotIndex = 0; slotIndex < 100; slotIndex += 1) {
      const button = this.getCurrentPageButtonConfig(slotIndex) || { index: slotIndex };
      const buttonLabel = this.resolveSyncedButtonLabel(button);
      const baseBg = parseButtonBgColor(button.color);
      const effectValue = this.getCurrentPageButtonEffectValue(slotIndex);
      values[`btn_${slotIndex + 1}_label`] = buttonLabel;
      values[`button_${slotIndex + 1}_label`] = buttonLabel;
      values[`btn_${slotIndex + 1}_bgcolor`] = String(baseBg);
      values[`btn_${slotIndex + 1}_textcolor`] = String(deriveTextColor(baseBg));
      values[`btn_${slotIndex + 1}_effect`] = String(effectValue);
      values[`button_${slotIndex + 1}_effect`] = String(effectValue);
    }

    this.setVariableValues(values);
  }

  async sendBridgeCommand(payload: CommandPayload): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.lastCommandOK = false;
      this.updateVariableValues();
      this.checkFeedbacks();
      throw new Error("bridge is disconnected");
    }
    this.commandSeq += 1;
    const commandID = `cmd-${Date.now()}-${this.commandSeq}`;
    const payloadWithID: CommandPayload = { ...payload, commandId: commandID };
    this.log(
      "info",
      `Send command ${commandID}: ${String(payload.command || "")}` +
        ` idx=${String(payload.buttonIndex ?? "")}` +
        ` state=${String(payload.state ?? "")}`,
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(commandID);
        this.pendingCommandCount = this.pendingCommands.size;
        this.lastCommandOK = false;
        this.updateVariableValues();
        this.checkFeedbacks();
        reject(new Error("command timeout"));
      }, 5000);
      this.pendingCommands.set(commandID, { resolve, reject, timer });
      this.pendingCommandCount = this.pendingCommands.size;
      try {
        this.ws?.send(
          JSON.stringify({
            type: "command",
            data: payloadWithID,
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pendingCommands.delete(commandID);
        this.pendingCommandCount = this.pendingCommands.size;
        this.lastCommandOK = false;
        this.updateVariableValues();
        this.checkFeedbacks();
        reject(
          err instanceof Error ? err : new Error("failed to send command"),
        );
      }
    });
  }

  dispatchBridgeCommand(payload: CommandPayload, context = ""): void {
    void this.sendBridgeCommand(payload).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      const suffix = context ? ` (${context})` : "";
      this.log("warn", `Command dispatch failed${suffix}: ${reason}`);
    });
  }

  /**
   * Get a stored button image by index
   */
  getButtonImage(slotIndex: number, pageNumber?: number): Buffer | undefined {
    const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber as number) : this.currentPageNumber;
    return this.imageBridge?.getImage(slotIndex, page);
  }

  /**
   * Connect to the Kesher image stream
   */
  private connectImageBridge(): void {
    if (this.imageBridge) {
      this.imageBridge.disconnect();
      this.imageBridge = null;
    }

    const host = (this.config.host || "").trim();
    if (!host) {
      return;
    }

    const baseUrl = this.baseHttpURL();
    const targetQuery = this.companionTargetQuery();
    this.imageBridge = new ImageBridge(
      this,
      baseUrl,
      targetQuery,
      this.transportDispatcher(),
    );
    this.imageBridge.connect();
  }
}

runEntrypoint(ModuleInstance, UpgradeScripts);
