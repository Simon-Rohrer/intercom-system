import { InstanceBase, InstanceStatus, runEntrypoint, } from "@companion-module/base";
import { Agent as UndiciAgent, WebSocket as UndiciWebSocket, fetch as undiciFetch, } from "undici";
import { GetConfigFields } from "./config.js";
import { UpdateActions } from "./actions.js";
import { UpdateFeedbacks } from "./feedbacks.js";
import { BuildPresetSignature, deriveTextColor, parseButtonBgColor, UpdatePresets, } from "./presets.js";
import { UpdateVariableDefinitions } from "./variables.js";
import { UpgradeScripts } from "./upgrades.js";
import { ImageBridge } from "./imageBridge.js";
const allowedStreamDeckActionTypes = new Set([
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
const incomingCallBlinkDurationMs = 5000;
function normalizeProfileStreamDeckSettings(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const data = raw;
    const gridColumns = Number(data.gridColumns);
    const gridRows = Number(data.gridRows);
    const version = Number(data.version);
    const selectedPage = Number(data.selectedPage);
    const rawPages = Array.isArray(data.pages) ? data.pages : [];
    const pages = rawPages
        .map((pageEntry) => {
        if (!pageEntry || typeof pageEntry !== "object")
            return null;
        const pageData = pageEntry;
        const page = Number(pageData.page);
        const rawButtons = Array.isArray(pageData.buttons) ? pageData.buttons : [];
        const buttons = rawButtons
            .map((buttonEntry) => {
            if (!buttonEntry || typeof buttonEntry !== "object")
                return null;
            const buttonData = buttonEntry;
            const index = Number(buttonData.index);
            if (!Number.isInteger(index) || index < 0)
                return null;
            let action;
            if (buttonData.action && typeof buttonData.action === "object") {
                const actionData = buttonData.action;
                const typeCandidate = String(actionData.type || "none");
                const type = allowedStreamDeckActionTypes.has(typeCandidate)
                    ? typeCandidate
                    : "none";
                action = {
                    type,
                    roomId: typeof actionData.roomId === "string" ? actionData.roomId : undefined,
                    userId: typeof actionData.userId === "string" ? actionData.userId : undefined,
                    roleId: typeof actionData.roleId === "string" ? actionData.roleId : undefined,
                    broadcastGroupId: typeof actionData.broadcastGroupId === "string"
                        ? actionData.broadcastGroupId
                        : undefined,
                    volumeDelta: typeof actionData.volumeDelta === "number"
                        ? actionData.volumeDelta
                        : undefined,
                    targetPage: typeof actionData.targetPage === "number"
                        ? actionData.targetPage
                        : undefined,
                };
            }
            return {
                index,
                label: typeof buttonData.label === "string" ? buttonData.label : undefined,
                color: typeof buttonData.color === "string" ? buttonData.color : undefined,
                action,
            };
        })
            .filter((button) => !!button)
            .sort((a, b) => a.index - b.index);
        if (!Number.isInteger(page) || page < 0)
            return null;
        const pageTypeCandidate = String(pageData.pageType || "manual").trim();
        const pageType = pageTypeCandidate === "all_roles" || pageTypeCandidate === "all_party_lines"
            ? pageTypeCandidate
            : "manual";
        const parentPage = Number(pageData.parentPage);
        return {
            page,
            title: typeof pageData.title === "string" ? pageData.title : undefined,
            pageType,
            parentPage: Number.isInteger(parentPage) && parentPage >= 0 ? parentPage : undefined,
            buttons,
        };
    })
        .filter((page) => !!page)
        .sort((a, b) => a.page - b.page);
    if (!Number.isInteger(gridColumns) ||
        !Number.isInteger(gridRows) ||
        !Number.isInteger(version) ||
        !Number.isInteger(selectedPage) ||
        pages.length === 0) {
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
export class ModuleInstance extends InstanceBase {
    config;
    ws = null;
    reconnectTimer = null;
    connectWatchdogTimer = null;
    bridgeHealthTimer = null;
    bridgeHealthAckTimer = null;
    bridgeHealthCommandId = "";
    signalBlinkTimer = null;
    imageEffectBlinkTimer = null;
    discoveryRefreshTimer = null;
    discoveryRefreshInFlight = false;
    reconnectAttempts = 0;
    lastConnectionError = "";
    insecureTlsDispatcher = null;
    presetSignature = "";
    commandSeq = 0;
    imageBridge = null;
    imageEffectMapRaw = "";
    imageEffectMapParseError = "";
    imageEffectRules = new Map();
    buttonImageEffectValues = new Map();
    pendingCommands = new Map();
    bridgeConnected = false;
    bound = false;
    micEnabled = false;
    voiceMode = "ptt";
    listenRooms = [];
    talkRooms = [];
    replyDirectUserId = "";
    replyDirectUsername = "";
    signalActive = false;
    signalFrom = "";
    signalMessage = "";
    signalStartedAt = 0;
    signalBlinkPhase = false;
    imageEffectBlinkPhase = false;
    lastCommandOK = true;
    pendingCommandCount = 0;
    profileVersion = 0;
    profileStreamDeckSettings = null;
    presetProfiles = [];
    currentPageNumber = 0;
    lastBridgeEventAt = 0;
    lastBridgeCloseAt = 0;
    appliedProfileVersion = 0;
    lastPresetProfilesFetch = 0;
    heldDirectRoleTargets = new Map();
    signalFingerprint = "";
    discovery = {
        username: "",
        roleId: "",
        roleName: "",
        rooms: [],
        users: [],
        broadcastGroups: [],
    };
    constructor(internal) {
        super(internal);
    }
    async init(config) {
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
    async destroy() {
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
    async configUpdated(config) {
        this.config = config;
        this.startDiscoveryRefreshTimer();
        await this.refreshDiscovery();
        this.connectBridge();
        this.connectImageBridge();
    }
    getConfigFields() {
        return GetConfigFields();
    }
    updateActions() {
        UpdateActions(this);
    }
    updateFeedbacks() {
        UpdateFeedbacks(this);
    }
    updatePresets() {
        const nextSignature = BuildPresetSignature(this);
        if (nextSignature === this.presetSignature)
            return;
        this.presetSignature = nextSignature;
        UpdatePresets(this);
    }
    updateVariableDefinitions() {
        UpdateVariableDefinitions(this);
        this.updateVariableValues();
    }
    getRoomChoices(filter = "all") {
        return this.discovery.rooms
            .filter((room) => {
            if (filter === "talk")
                return room.canTalk;
            if (filter === "listen")
                return room.canListen;
            return true;
        })
            .map((room) => ({ id: room.id, label: room.name }));
    }
    getUserChoices() {
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
                if (roleCmp !== 0)
                    return roleCmp;
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
            if (roleCmp !== 0)
                return roleCmp;
            return (a.username || "").localeCompare(b.username || "", undefined, {
                sensitivity: "base",
            });
        })
            .map((u) => ({ id: u.id, label: `${u.username} (${u.roleId})` }));
    }
    getBroadcastChoices() {
        return this.discovery.broadcastGroups.map((g) => ({
            id: g.id,
            label: g.name,
        }));
    }
    getActiveRoleUser(roleId) {
        const wantedRoleId = roleId.trim();
        if (!wantedRoleId)
            return null;
        const matches = (this.discovery.activeRoleUsers || [])
            .filter((entry) => (entry.roleId || "").trim() === wantedRoleId)
            .slice()
            .sort((a, b) => {
            const usernameCmp = (a.username || "").localeCompare(b.username || "", undefined, {
                sensitivity: "base",
            });
            if (usernameCmp !== 0)
                return usernameCmp;
            return (a.userId || "").localeCompare(b.userId || "", undefined, {
                sensitivity: "base",
            });
        });
        return matches[0] || null;
    }
    rememberHeldDirectRoleTarget(controlId, userId) {
        this.heldDirectRoleTargets.set(controlId, userId);
    }
    consumeHeldDirectRoleTarget(controlId) {
        const userId = this.heldDirectRoleTargets.get(controlId) || "";
        this.heldDirectRoleTargets.delete(controlId);
        return userId;
    }
    getProfileButtonConfig(pageNumber, buttonIndex) {
        const settings = this.profileStreamDeckSettings;
        if (!settings)
            return null;
        const page = settings.pages.find((entry) => entry.page === pageNumber);
        if (!page)
            return null;
        return page.buttons.find((entry) => entry.index === buttonIndex) || null;
    }
    getPresetProfileButtonConfig(roleId, pageNumber, buttonIndex) {
        const profile = this.presetProfiles.find((entry) => entry.roleId === roleId);
        const page = profile?.streamDeckSettings.pages.find((entry) => entry.page === pageNumber);
        if (!page)
            return null;
        return page.buttons.find((entry) => entry.index === buttonIndex) || null;
    }
    getCurrentPageButtonConfig(buttonIndex) {
        return this.getProfileButtonConfig(this.currentPageNumber, buttonIndex);
    }
    applyLocalPageNavigation(actionType) {
        const normalized = String(actionType || "").trim();
        if (normalized !== "page_up" && normalized !== "page_down")
            return;
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
        if (order.length === 0)
            return;
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
    applyLocalPageBack() {
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
    applyLocalPageJump(targetPage) {
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
    getButtonImageEffectValue(slotIndex, pageNumber) {
        const slot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : -1;
        const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : -1;
        if (slot < 0 || slot > 99 || page < 0)
            return undefined;
        return this.buttonImageEffectValues.get(page * 100 + slot);
    }
    getButtonEffectValue(buttonIndex, pageNumber) {
        const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : this.currentPageNumber;
        const pageScoped = this.getButtonImageEffectValue(buttonIndex, page);
        if (pageScoped !== undefined)
            return pageScoped;
        return this.buttonImageEffectValues.get(buttonIndex) ?? 0;
    }
    getCurrentPageButtonEffectValue(buttonIndex) {
        return this.getButtonEffectValue(buttonIndex, this.currentPageNumber);
    }
    resolveSyncedButtonLabel(button) {
        const explicitLabel = (button.label || "").trim();
        if (explicitLabel)
            return explicitLabel;
        const action = button.action;
        if (!action?.type)
            return "";
        switch (action.type) {
            case "ptt_room":
            case "select_talk_room":
            case "listen_room":
            case "call_room":
                return (this.discovery.rooms.find((room) => room.id === action.roomId)?.name ||
                    (action.roomId || ""));
            case "ptt_selected":
                return "PTT";
            case "direct_user": {
                const user = this.discovery.users.find((entry) => entry.id === action.userId);
                return user?.username || action.userId || "";
            }
            case "direct_role": {
                const roleId = (action.roleId || "").trim();
                if (!roleId)
                    return "";
                const active = (this.discovery.activeRoleUsers || []).find((entry) => (entry.roleId || "").trim() === roleId);
                if (active?.username)
                    return `${active.username}\n${roleId}`;
                return roleId;
            }
            case "reply_to_caller":
                return this.replyDirectUsername
                    ? `Reply\n${this.replyDirectUsername}`
                    : "Reply";
            case "incoming_call_indicator":
                return "Incoming\nCall";
            case "broadcast_ptt":
                return (this.discovery.broadcastGroups.find((group) => group.id === action.broadcastGroupId)?.name || (action.broadcastGroupId || ""));
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
                const tp = action.targetPage;
                return tp !== undefined ? `Page ${tp + 1}` : "Jump";
            }
            default:
                return "";
        }
    }
    normalizeColorHex(value, fallback = "#ff2d26") {
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
    parseImageEffectMode(raw) {
        if (typeof raw === "number" && Number.isFinite(raw)) {
            const normalized = Math.trunc(raw);
            if (normalized === 0 || normalized === 1 || normalized === 2) {
                return normalized;
            }
            return null;
        }
        const text = String(raw || "").trim().toLowerCase();
        if (text === "0" || text === "none" || text === "off")
            return 0;
        if (text === "1" || text === "blink" || text === "blinking")
            return 1;
        if (text === "2" || text === "static" || text === "solid" || text === "glow") {
            return 2;
        }
        return null;
    }
    applyImageEffectMapFromJson(rawJson) {
        const rawText = String(rawJson || "").trim();
        if (rawText === this.imageEffectMapRaw)
            return;
        this.imageEffectMapRaw = rawText;
        this.imageEffectMapParseError = "";
        this.imageEffectRules.clear();
        if (!rawText) {
            this.updateVariableValues();
            this.checkFeedbacks("dynamic_button_image");
            return;
        }
        try {
            const parsed = JSON.parse(rawText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("imageEffectMapJson must be a JSON object");
            }
            for (const [rawCode, rawRule] of Object.entries(parsed)) {
                const code = Number(rawCode);
                if (!Number.isInteger(code) || code < 0)
                    continue;
                if (rawRule && typeof rawRule === "object" && !Array.isArray(rawRule)) {
                    const ruleObject = rawRule;
                    const mode = this.parseImageEffectMode(ruleObject.mode ?? ruleObject.type ?? ruleObject.effect);
                    if (mode === null)
                        continue;
                    const colorHex = this.normalizeColorHex(ruleObject.color ?? ruleObject.colorHex);
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
        }
        catch (error) {
            this.imageEffectMapParseError =
                error instanceof Error ? error.message : "invalid JSON";
            this.log("warn", `Invalid imageEffectMapJson: ${this.imageEffectMapParseError}`);
        }
        this.updateVariableValues();
        this.checkFeedbacks("dynamic_button_image");
    }
    getImageEffectMapJsonFromState(state) {
        return typeof state.imageEffectMapJson === "string"
            ? state.imageEffectMapJson
            : "";
    }
    updateSignalState(active, from, message, startedAt) {
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
        const fallbackStartedAt = fingerprint === this.signalFingerprint && this.signalStartedAt > 0
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
    incomingCallBlinkActive() {
        if (!this.signalActive)
            return false;
        if (this.signalMessage.trim().toLowerCase() !== "call")
            return false;
        if (this.signalStartedAt <= 0)
            return true;
        return Date.now() - this.signalStartedAt < incomingCallBlinkDurationMs;
    }
    setButtonImageEffectValue(slotIndex, effectValue, pageNumber) {
        const slot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : -1;
        const value = Number.isFinite(effectValue) ? Math.trunc(effectValue) : 0;
        if (slot < 0 || slot > 99)
            return;
        const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : -1;
        const key = page >= 0 ? page * 100 + slot : slot;
        if (this.buttonImageEffectValues.get(key) === value)
            return;
        this.buttonImageEffectValues.set(key, value);
        if (page === this.currentPageNumber) {
            this.buttonImageEffectValues.set(slot, value);
        }
        this.checkFeedbacks("dynamic_button_image");
    }
    getImageEffectRuleForSlot(slotIndex, pageNumber) {
        const slot = Number.isFinite(slotIndex) ? Math.trunc(slotIndex) : 0;
        const effectValue = this.getButtonEffectValue(slot, pageNumber);
        const normalizedValue = Number.isFinite(effectValue) ? Math.trunc(effectValue) : 0;
        const mapped = this.imageEffectRules.get(normalizedValue);
        if (mapped)
            return mapped;
        return {
            mode: 0,
            colorHex: "#ff2d26",
        };
    }
    effectiveUseTls() {
        const port = Number(this.config.port || 0);
        return Boolean(this.config.useTls) || port === 443 || port === 8443;
    }
    autoTlsEnabled() {
        const port = Number(this.config.port || 0);
        return !Boolean(this.config.useTls) && (port === 443 || port === 8443);
    }
    allowSelfSignedTls() {
        return this.effectiveUseTls() && this.config.allowSelfSignedTls !== false;
    }
    transportDispatcher() {
        if (!this.allowSelfSignedTls())
            return undefined;
        if (!this.insecureTlsDispatcher) {
            this.insecureTlsDispatcher = new UndiciAgent({
                connect: {
                    rejectUnauthorized: false,
                },
            });
        }
        return this.insecureTlsDispatcher;
    }
    baseHttpURL() {
        const protocol = this.effectiveUseTls() ? "https" : "http";
        return `${protocol}://${this.config.host}:${this.config.port}`;
    }
    baseWsURL() {
        const protocol = this.effectiveUseTls() ? "wss" : "ws";
        return `${protocol}://${this.config.host}:${this.config.port}`;
    }
    async fetchJson(url, label) {
        const res = await undiciFetch(url, {
            dispatcher: this.transportDispatcher(),
        });
        if (!res.ok) {
            let body = "";
            try {
                body = (await res.text()).trim();
            }
            catch {
                body = "";
            }
            const statusText = [res.status, res.statusText].filter(Boolean).join(" ");
            const detail = body ? `${statusText}: ${body}` : statusText;
            throw new Error(`${label} failed (${detail})`);
        }
        return (await res.json());
    }
    formatConnectionError(err, fallback) {
        if (!(err instanceof Error))
            return fallback;
        const cause = err.cause;
        if (cause && typeof cause === "object") {
            const detail = cause;
            const code = typeof detail.code === "string" ? detail.code : "";
            const message = typeof detail.message === "string" ? detail.message : "";
            const causeText = [code, message].filter(Boolean).join(": ");
            if (causeText)
                return `${err.message}: ${causeText}`;
        }
        return err.message || fallback;
    }
    createWebSocket(url) {
        const dispatcher = this.transportDispatcher();
        if (dispatcher) {
            return new UndiciWebSocket(url, { dispatcher });
        }
        return new UndiciWebSocket(url);
    }
    companionSecretQuery() {
        const secret = (this.config.companionSecret || "").trim();
        if (!secret)
            return "";
        return `secret=${encodeURIComponent(secret)}`;
    }
    companionTargetQuery() {
        const roleId = (this.config.roleId || "").trim();
        if (roleId) {
            return `roleId=${encodeURIComponent(roleId)}`;
        }
        return "";
    }
    companionTargetLabel() {
        const roleId = (this.config.roleId || "").trim();
        if (roleId)
            return `roleId=${roleId}`;
        const username = (this.config.username || "").trim();
        if (username)
            return "auto (username ignored)";
        return "auto";
    }
    static formatTimestamp(ts) {
        if (!ts || !Number.isFinite(ts))
            return "";
        return new Date(ts).toISOString();
    }
    runConnectionDiagnostics(forceReconnect = false) {
        const bridgeState = this.ws?.readyState === WebSocket.OPEN
            ? "open"
            : this.ws?.readyState === WebSocket.CONNECTING
                ? "connecting"
                : this.ws?.readyState === WebSocket.CLOSING
                    ? "closing"
                    : this.ws?.readyState === WebSocket.CLOSED
                        ? "closed"
                        : "none";
        const imageDiag = this.imageBridge?.getDiagnostics();
        this.log("info", [
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
        ].join(" "));
        if (forceReconnect) {
            this.log("info", "Connection diagnostics requested reconnect");
            this.connectBridge();
            this.connectImageBridge();
        }
    }
    runImageSlotDiagnostics(slotIndex) {
        const normalizedSlot = Number.isFinite(slotIndex)
            ? Math.max(0, Math.min(99, Math.trunc(slotIndex)))
            : 0;
        const button = this.getCurrentPageButtonConfig(normalizedSlot) || {
            index: normalizedSlot,
        };
        const imageBuffer = this.getButtonImage(normalizedSlot);
        const imageDiag = this.imageBridge?.getDiagnostics();
        const actionType = button.action?.type || "none";
        const target = button.action?.roomId ||
            button.action?.userId ||
            button.action?.roleId ||
            button.action?.broadcastGroupId ||
            "";
        this.log("info", [
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
        ].join(" "));
    }
    toCompanionPresetProfile(profile, streamDeckSettings = null) {
        const settings = streamDeckSettings || normalizeProfileStreamDeckSettings(profile.streamDeckSettings);
        if (!settings)
            return null;
        const roleId = String(profile.roleId || this.discovery.roleId || this.config.roleId || "").trim();
        if (!roleId)
            return null;
        return {
            roleId,
            roleName: profile.roleName || "",
            username: String(profile.username || this.discovery.username || this.config.username || "Default profile").trim(),
            profileVersion: Number(profile.profileVersion || 0),
            profileUpdatedAt: Number(profile.profileUpdatedAt || 0),
            streamDeckSettings: settings,
        };
    }
    async refreshCompanionPresetProfiles(fallbackProfile = null, force = false) {
        const host = (this.config.host || "").trim();
        if (!host)
            return;
        const now = Date.now();
        if (!force && now - this.lastPresetProfilesFetch < 5000)
            return;
        this.lastPresetProfilesFetch = now;
        const secretQuery = this.companionSecretQuery();
        const url = secretQuery
            ? `${this.baseHttpURL()}/api/companion/profiles?${secretQuery}`
            : `${this.baseHttpURL()}/api/companion/profiles`;
        try {
            const response = await this.fetchJson(url, "published profiles fetch");
            const profiles = (Array.isArray(response.profiles) ? response.profiles : [])
                .map((profile) => this.toCompanionPresetProfile(profile))
                .filter((profile) => !!profile);
            this.presetProfiles = profiles.length > 0
                ? profiles
                : fallbackProfile
                    ? [fallbackProfile]
                    : [];
        }
        catch (err) {
            if (fallbackProfile) {
                this.presetProfiles = [fallbackProfile];
            }
            const detail = this.formatConnectionError(err, "unknown published profiles sync error");
            this.log("warn", `Published profiles sync failed: ${detail}`);
        }
    }
    async refreshDiscovery() {
        const host = (this.config.host || "").trim();
        const targetQuery = this.companionTargetQuery();
        if (!host || this.discoveryRefreshInFlight)
            return;
        const secretQuery = this.companionSecretQuery();
        const queryParts = [targetQuery, secretQuery].filter(Boolean);
        const url = queryParts.length
            ? `${this.baseHttpURL()}/api/companion/discovery?${queryParts.join("&")}`
            : `${this.baseHttpURL()}/api/companion/discovery`;
        this.discoveryRefreshInFlight = true;
        try {
            const data = await this.fetchJson(url, "discovery");
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
        }
        catch (err) {
            const syncError = this.formatConnectionError(err, "unknown discovery error");
            this.lastConnectionError = syncError;
            if (!this.bridgeConnected) {
                this.updateStatus(InstanceStatus.ConnectionFailure, syncError);
            }
            this.log("warn", `Discovery refresh failed: ${syncError}`);
        }
        finally {
            this.discoveryRefreshInFlight = false;
        }
    }
    async refreshCompanionProfile() {
        const host = (this.config.host || "").trim();
        const targetQuery = this.companionTargetQuery();
        if (!host)
            return;
        const secretQuery = this.companionSecretQuery();
        const queryParts = [targetQuery, secretQuery].filter(Boolean);
        const url = queryParts.length
            ? `${this.baseHttpURL()}/api/companion/profile?${queryParts.join("&")}`
            : `${this.baseHttpURL()}/api/companion/profile`;
        try {
            const profile = await this.fetchJson(url, "profile fetch");
            this.lastConnectionError = "";
            this.discovery = {
                username: profile.username || this.discovery.username,
                roleId: profile.roleId || this.discovery.roleId,
                roleName: profile.roleName || this.discovery.roleName,
                pageNumber: Number(profile.pageNumber ?? this.discovery.pageNumber ?? -1),
                currentPageNumber: Number(profile.currentPageNumber ??
                    this.discovery.currentPageNumber ??
                    this.currentPageNumber),
                rooms: profile.rooms || [],
                users: profile.users || [],
                activeRoleUsers: profile.activeRoleUsers || [],
                broadcastGroups: profile.broadcastGroups || [],
                profileVersion: Number(profile.profileVersion || 0),
                profileStatus: profile.profileStatus || "published",
                profileUpdatedAt: Number(profile.profileUpdatedAt || 0),
            };
            this.profileStreamDeckSettings = normalizeProfileStreamDeckSettings(profile.streamDeckSettings);
            const fallbackPresetProfile = this.toCompanionPresetProfile(profile, this.profileStreamDeckSettings);
            this.presetProfiles = fallbackPresetProfile ? [fallbackPresetProfile] : [];
            this.currentPageNumber = Number(profile.currentPageNumber ??
                this.profileStreamDeckSettings?.selectedPage ??
                this.currentPageNumber);
            this.profileVersion = Number(profile.profileVersion || 0);
            this.appliedProfileVersion = this.profileVersion;
            await this.refreshCompanionPresetProfiles(fallbackPresetProfile, true);
            this.updateActions();
            this.updateFeedbacks();
            this.updatePresets();
            this.updateVariableDefinitions();
        }
        catch (err) {
            const syncError = this.formatConnectionError(err, "unknown profile sync error");
            this.lastConnectionError = syncError;
            if (!this.bridgeConnected) {
                this.updateStatus(InstanceStatus.ConnectionFailure, syncError);
            }
            this.log("warn", `Companion profile sync failed: ${syncError}`);
            this.checkFeedbacks();
        }
    }
    clearDiscoveryRefreshTimer() {
        if (this.discoveryRefreshTimer) {
            clearInterval(this.discoveryRefreshTimer);
            this.discoveryRefreshTimer = null;
        }
    }
    startDiscoveryRefreshTimer() {
        if (this.discoveryRefreshTimer)
            return;
        this.discoveryRefreshTimer = setInterval(() => {
            void this.refreshDiscovery();
        }, 2000);
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
    clearConnectWatchdogTimer() {
        if (this.connectWatchdogTimer) {
            clearTimeout(this.connectWatchdogTimer);
            this.connectWatchdogTimer = null;
        }
    }
    startConnectWatchdog(ws) {
        this.clearConnectWatchdogTimer();
        this.connectWatchdogTimer = setTimeout(() => {
            if (this.ws !== ws)
                return;
            if (ws.readyState !== WebSocket.CONNECTING)
                return;
            this.log("warn", "Bridge websocket connect timeout; reconnecting");
            this.connectBridge();
        }, 7000);
    }
    clearBridgeHealthTimers() {
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
    startBridgeHealthTimer(ws) {
        this.clearBridgeHealthTimers();
        this.bridgeHealthTimer = setInterval(() => {
            if (this.ws !== ws)
                return;
            if (ws.readyState !== WebSocket.OPEN)
                return;
            if (this.bridgeHealthCommandId)
                return;
            const commandId = `health-${Date.now()}`;
            this.bridgeHealthCommandId = commandId;
            try {
                ws.send(JSON.stringify({
                    type: "command",
                    data: {
                        command: "press_button",
                        buttonIndex: -1,
                        state: "down",
                        commandId,
                    },
                }));
            }
            catch {
                this.bridgeHealthCommandId = "";
                this.log("warn", "Bridge health-check send failed; reconnecting");
                if (this.ws === ws) {
                    this.connectBridge();
                }
                return;
            }
            this.bridgeHealthAckTimer = setTimeout(() => {
                if (this.ws !== ws)
                    return;
                if (!this.bridgeHealthCommandId)
                    return;
                this.bridgeHealthCommandId = "";
                this.log("warn", "Bridge health-check timeout; reconnecting");
                this.connectBridge();
            }, 5000);
        }, 10000);
    }
    scheduleReconnect() {
        this.clearReconnectTimer();
        this.reconnectAttempts += 1;
        const delayMs = Math.min(8000, 500 * 2 ** Math.min(5, this.reconnectAttempts));
        this.reconnectTimer = setTimeout(() => this.connectBridge(), delayMs);
    }
    startSignalBlinkTimer() {
        if (this.signalBlinkTimer)
            return;
        this.signalBlinkTimer = setInterval(() => {
            const nextBlinkPhase = this.signalActive ? !this.signalBlinkPhase : false;
            if (nextBlinkPhase === this.signalBlinkPhase)
                return;
            this.signalBlinkPhase = nextBlinkPhase;
            this.checkSignalFeedbacks();
        }, 300);
    }
    checkSignalFeedbacks() {
        this.checkFeedbacks("signal_active_blink");
        this.checkFeedbacks("incoming_call_blink");
    }
    startImageEffectBlinkTimer() {
        if (this.imageEffectBlinkTimer)
            return;
        this.imageEffectBlinkTimer = setInterval(() => {
            this.imageEffectBlinkPhase = !this.imageEffectBlinkPhase;
            this.checkFeedbacks("dynamic_button_image");
        }, 450);
    }
    connectBridge() {
        this.clearReconnectTimer();
        this.clearConnectWatchdogTimer();
        this.clearBridgeHealthTimers();
        this.ws?.close();
        this.ws = null;
        const host = (this.config.host || "").trim();
        const targetQuery = this.companionTargetQuery();
        const targetLabel = this.companionTargetLabel();
        if (!host) {
            this.updateStatus(InstanceStatus.BadConfig, "host is required");
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
            this.log("info", `Using TLS automatically for backend port ${this.config.port}`);
        }
        if (!targetQuery && (this.config.username || "").trim()) {
            this.log("warn", "Target username is deprecated and ignored; set target role ID");
        }
        const ws = this.createWebSocket(url);
        this.ws = ws;
        this.startConnectWatchdog(ws);
        ws.onopen = () => {
            if (this.ws !== ws)
                return;
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
        ws.onmessage = (event) => {
            if (this.ws !== ws)
                return;
            try {
                const raw = typeof event.data === "string" ? event.data : String(event.data);
                const payload = JSON.parse(raw);
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
                    this.log("info", `Command result ${commandID || "(no-id)"}: ok=${payload.data.ok ? "1" : "0"}` +
                        ` status=${status || ""}` +
                        ` command=${String(payload.data.command || "")}` +
                        ` error=${String(payload.data.error || "")}`);
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
                        }
                        else {
                            const errorMsg = payload.data.error || "command failed";
                            this.lastCommandOK = false;
                            pending.reject(new Error(errorMsg));
                        }
                    }
                    else if (!payload.data.ok) {
                        this.lastCommandOK = false;
                    }
                    else if (status !== "queued") {
                        this.lastCommandOK = true;
                        this.pendingCommandCount = this.pendingCommands.size;
                    }
                    this.updateVariableValues();
                    this.checkFeedbacks();
                    return;
                }
                if (payload.type !== "companion_state")
                    return;
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
                this.updateSignalState(!!payload.data.signalActive, payload.data.signalFrom || "", payload.data.signalMessage || "", Number(payload.data.signalStartedAt || 0));
                const incomingCallActive = this.incomingCallBlinkActive();
                const signalChanged = previousSignalFingerprint !== this.signalFingerprint ||
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
            }
            catch (err) {
                this.log("warn", `Ignoring invalid bridge websocket message: ${err instanceof Error ? err.message : "unknown error"}`);
            }
        };
        ws.onclose = () => {
            if (this.ws !== ws)
                return;
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
            this.updateStatus(InstanceStatus.ConnectionFailure, this.lastConnectionError || "bridge disconnected");
            this.updateVariableValues();
            this.checkFeedbacks();
            this.scheduleReconnect();
        };
        ws.onerror = (event) => {
            if (this.ws !== ws)
                return;
            this.log("warn", `Bridge websocket error (${targetLabel || "unconfigured target"}); waiting for close event`);
            if (!this.lastConnectionError) {
                this.lastConnectionError = "bridge websocket error";
            }
            // Do not call ws.close() here: undici can recurse error->close->error and crash.
            void event;
        };
    }
    updateVariableValues() {
        const values = {};
        const bridgeState = this.ws?.readyState === WebSocket.OPEN
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
    async sendBridgeCommand(payload) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            this.lastCommandOK = false;
            this.updateVariableValues();
            this.checkFeedbacks();
            throw new Error("bridge is disconnected");
        }
        this.commandSeq += 1;
        const commandID = `cmd-${Date.now()}-${this.commandSeq}`;
        const payloadWithID = { ...payload, commandId: commandID };
        this.log("info", `Send command ${commandID}: ${String(payload.command || "")}` +
            ` idx=${String(payload.buttonIndex ?? "")}` +
            ` state=${String(payload.state ?? "")}`);
        await new Promise((resolve, reject) => {
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
                this.ws?.send(JSON.stringify({
                    type: "command",
                    data: payloadWithID,
                }));
            }
            catch (err) {
                clearTimeout(timer);
                this.pendingCommands.delete(commandID);
                this.pendingCommandCount = this.pendingCommands.size;
                this.lastCommandOK = false;
                this.updateVariableValues();
                this.checkFeedbacks();
                reject(err instanceof Error ? err : new Error("failed to send command"));
            }
        });
    }
    dispatchBridgeCommand(payload, context = "") {
        void this.sendBridgeCommand(payload).catch((err) => {
            const reason = err instanceof Error ? err.message : String(err);
            const suffix = context ? ` (${context})` : "";
            this.log("warn", `Command dispatch failed${suffix}: ${reason}`);
        });
    }
    /**
     * Get a stored button image by index
     */
    getButtonImage(slotIndex, pageNumber) {
        const page = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : this.currentPageNumber;
        return this.imageBridge?.getImage(slotIndex, page);
    }
    /**
     * Connect to the Kesher image stream
     */
    connectImageBridge() {
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
        this.imageBridge = new ImageBridge(this, baseUrl, targetQuery, this.transportDispatcher());
        this.imageBridge.connect();
    }
}
runEntrypoint(ModuleInstance, UpgradeScripts);
