import { combineRgb, } from "@companion-module/base";
import { deriveTextColor, parseButtonBgColor, renderPresetPreviewImage, } from "./presets.js";
import { applyImageEffectOverlay } from "./imageRenderer.js";
// 1x1 transparent PNG used to explicitly clear stale button images.
const TRANSPARENT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z8xQAAAAASUVORK5CYII=";
function optionValue(value) {
    if (value &&
        typeof value === "object" &&
        "value" in value &&
        "isExpression" in value) {
        return value.value;
    }
    return value;
}
function numberOption(options, keys, fallback) {
    for (const key of keys) {
        const raw = optionValue(options[key]);
        if (raw === undefined || raw === null || raw === "")
            continue;
        const parsed = Number(raw);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
function stringOption(options, key) {
    return String(optionValue(options[key]) || "").trim();
}
function imageFeedbackResult(fallbackStyle, imageBase64) {
    const dataUrl = `data:image/png;base64,${imageBase64}`;
    return {
        ...fallbackStyle,
        text: "",
        png64: imageBase64,
        image: dataUrl,
    };
}
function staleImageFallbackResult(fallbackStyle) {
    const style = fallbackStyle.text
        ? fallbackStyle
        : {
            color: fallbackStyle.color,
            bgcolor: fallbackStyle.bgcolor,
        };
    return {
        ...style,
        png64: TRANSPARENT_PNG_BASE64,
        image: `data:image/png;base64,${TRANSPARENT_PNG_BASE64}`,
    };
}
export function UpdateFeedbacks(self) {
    const roomChoices = self.getRoomChoices("all");
    const feedbacks = {
        bridge_connected: {
            name: "Bridge connected",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(0, 120, 0),
            },
            options: [],
            callback: () => self.bridgeConnected,
        },
        bridge_disconnected: {
            name: "Bridge disconnected",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(170, 20, 20),
            },
            options: [],
            callback: () => !self.bridgeConnected,
        },
        browser_bound: {
            name: "Browser bound",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(0, 90, 170),
            },
            options: [],
            callback: () => self.bound,
        },
        browser_unbound: {
            name: "Browser unbound",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(0, 0, 0),
                bgcolor: combineRgb(245, 180, 0),
            },
            options: [],
            callback: () => self.bridgeConnected && !self.bound,
        },
        ready_for_control: {
            name: "Ready for control (bridge + bound)",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(0, 145, 70),
            },
            options: [],
            callback: () => self.bridgeConnected && self.bound,
        },
        mic_live: {
            name: "Mic live",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(180, 0, 0),
            },
            options: [],
            callback: () => self.micEnabled,
        },
        last_command_failed: {
            name: "Last command failed",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(160, 0, 0),
            },
            options: [],
            callback: () => !self.lastCommandOK,
        },
        command_pending: {
            name: "Command pending",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(0, 0, 0),
                bgcolor: combineRgb(255, 220, 0),
            },
            options: [],
            callback: () => self.pendingCommandCount > 0,
        },
        reply_target_available: {
            name: "Reply-to-caller target available",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(0, 130, 90),
            },
            options: [],
            callback: () => self.replyDirectUserId !== "",
        },
        signal_active_blink: {
            name: "Signal active (blinking)",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(0, 0, 0),
                bgcolor: combineRgb(255, 210, 0),
            },
            options: [],
            callback: () => self.signalBlinkPhase &&
                self.signalBlinkAttentionActive(),
        },
        incoming_call_blink: {
            name: "Incoming call (blinking)",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(0, 0, 0),
                bgcolor: combineRgb(255, 210, 0),
            },
            options: [],
            callback: () => self.signalBlinkPhase &&
                self.incomingCallBlinkActive(),
        },
        voice_mode_is: {
            name: "Voice mode equals",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(0, 0, 0),
                bgcolor: combineRgb(230, 180, 0),
            },
            options: [
                {
                    id: "mode",
                    type: "dropdown",
                    label: "Mode",
                    default: "always_on",
                    choices: [
                        { id: "always_on", label: "Always on" },
                        { id: "ptt", label: "PTT" },
                    ],
                },
            ],
            callback: (feedback) => self.voiceMode === String(feedback.options.mode),
        },
        listen_room_selected: {
            name: "Listen partyline selected",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(0, 100, 170),
            },
            options: [
                {
                    id: "roomId",
                    type: "dropdown",
                    label: "Partyline",
                    default: roomChoices[0]?.id ?? "",
                    choices: roomChoices,
                },
            ],
            callback: (feedback) => self.listenRooms.includes(String(feedback.options.roomId || "")),
        },
        talk_room_selected: {
            name: "Talk partyline selected",
            type: "boolean",
            defaultStyle: {
                color: combineRgb(255, 255, 255),
                bgcolor: combineRgb(170, 60, 0),
            },
            options: [
                {
                    id: "roomId",
                    type: "dropdown",
                    label: "Partyline",
                    default: roomChoices[0]?.id ?? "",
                    choices: roomChoices,
                },
            ],
            callback: (feedback) => self.talkRooms.includes(String(feedback.options.roomId || "")),
        },
        synced_slot_style: {
            name: "Synced Kesher slot style",
            type: "advanced",
            options: [
                {
                    id: "slotIndex",
                    type: "number",
                    label: "Slot index",
                    default: 0,
                    min: 0,
                    max: 99,
                },
            ],
            callback: (feedback) => {
                const slotIndex = Number(feedback.options.slotIndex ?? 0);
                const button = self.getCurrentPageButtonConfig(slotIndex) || {
                    index: slotIndex,
                };
                const bgcolor = parseButtonBgColor(button.color);
                return {
                    text: self.resolveSyncedButtonLabel(button),
                    color: deriveTextColor(bgcolor),
                    bgcolor,
                };
            },
        },
        dynamic_button_image: {
            name: "Display Dynamic Web-UI Button Image",
            type: "advanced",
            options: [
                {
                    id: "slotIndex",
                    type: "number",
                    label: "Slot index (0-99)",
                    default: 0,
                    min: 0,
                    max: 99,
                },
                {
                    id: "sourcePageNumber",
                    type: "number",
                    label: "Kesher source page (-1 = current)",
                    default: -1,
                    min: -1,
                    max: 99,
                },
                {
                    id: "roleId",
                    type: "textinput",
                    label: "Kesher source role ID (blank = current)",
                    default: "",
                },
                {
                    id: "profileUsername",
                    type: "textinput",
                    label: "Kesher source profile username",
                    default: "",
                },
            ],
            callback: (feedback) => {
                // Keep legacy compatibility for existing buttons that still store bankIndex.
                const feedbackOptions = feedback.options;
                const slotIndex = numberOption(feedbackOptions, ["slotIndex", "bankIndex"], 0);
                const sourcePageNumber = numberOption(feedbackOptions, ["sourcePageNumber"], -1);
                const pageNumber = Number.isFinite(sourcePageNumber) && sourcePageNumber >= 0
                    ? Math.trunc(sourcePageNumber)
                    : undefined;
                const roleId = stringOption(feedbackOptions, "roleId");
                const profileUsername = stringOption(feedbackOptions, "profileUsername");
                const importedButton = pageNumber !== undefined && roleId
                    ? self.getPresetProfileButtonConfig(roleId, pageNumber, slotIndex, profileUsername)
                    : null;
                const button = importedButton || (pageNumber === undefined
                    ? self.getCurrentPageButtonConfig(slotIndex)
                    : self.getProfileButtonConfig(pageNumber, slotIndex)) ||
                    self.getCurrentPageButtonConfig(slotIndex) ||
                    { index: slotIndex };
                const bgcolor = parseButtonBgColor(button.color);
                const fallbackStyle = {
                    text: self.resolveSyncedButtonLabel(button),
                    color: deriveTextColor(bgcolor),
                    bgcolor,
                };
                const imageBuffer = self.getButtonImage(slotIndex, pageNumber);
                if (imageBuffer) {
                    const effectRule = self.getImageEffectRuleForSlot(slotIndex, pageNumber);
                    const rendered = applyImageEffectOverlay(imageBuffer, {
                        mode: effectRule.mode,
                        colorHex: effectRule.colorHex,
                        blinkOn: self.imageEffectBlinkPhase,
                    });
                    const imageBase64 = rendered.toString("base64");
                    // Keep modern and legacy render paths in sync.
                    return imageFeedbackResult(fallbackStyle, imageBase64);
                }
                const previewImageBase64 = renderPresetPreviewImage(self, button);
                if (previewImageBase64) {
                    return imageFeedbackResult(fallbackStyle, previewImageBase64);
                }
                // No image or preview for this slot/page yet: force-clear stale image from previous page.
                return staleImageFallbackResult(fallbackStyle);
            },
        },
    };
    self.setFeedbackDefinitions(feedbacks);
}
