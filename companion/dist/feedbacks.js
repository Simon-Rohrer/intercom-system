import { combineRgb, } from "@companion-module/base";
import { deriveTextColor, parseButtonBgColor, } from "./presets.js";
import { applyImageEffectOverlay } from "./imageRenderer.js";
// 1x1 transparent PNG used to explicitly clear stale button images.
const TRANSPARENT_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z8xQAAAAASUVORK5CYII=";
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
            callback: () => self.signalActive && self.signalBlinkPhase,
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
            ],
            callback: (feedback) => {
                // Keep legacy compatibility for existing buttons that still store bankIndex.
                const slotIndex = Number(feedback.options.slotIndex ?? feedback.options.bankIndex ?? 0);
                const imageBuffer = self.getButtonImage(slotIndex);
                if (imageBuffer) {
                    const effectRule = self.getImageEffectRuleForSlot(slotIndex);
                    const rendered = applyImageEffectOverlay(imageBuffer, {
                        mode: effectRule.mode,
                        colorHex: effectRule.colorHex,
                        blinkOn: self.imageEffectBlinkPhase,
                    });
                    const imageBase64 = rendered.toString("base64");
                    const dataUrl = `data:image/png;base64,${imageBase64}`;
                    // Keep modern and legacy render paths in sync.
                    return {
                        // Prefer string payload for broad Companion compatibility.
                        imageBuffer: imageBase64,
                        // Legacy compatibility for older renderers.
                        png64: imageBase64,
                        image: dataUrl,
                    };
                }
                // No image for this slot/page yet: force-clear stale image from previous page.
                return {
                    imageBuffer: TRANSPARENT_PNG_BASE64,
                    png64: TRANSPARENT_PNG_BASE64,
                    image: `data:image/png;base64,${TRANSPARENT_PNG_BASE64}`,
                };
            },
        },
    };
    self.setFeedbackDefinitions(feedbacks);
}
