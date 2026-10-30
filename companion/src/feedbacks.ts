import {
  combineRgb,
  type CompanionAdvancedFeedbackResult,
  type CompanionFeedbackDefinitions,
} from "@companion-module/base";
import type { ModuleInstance } from "./main.js";
import {
  normalizePreviewImageBase64,
  parseButtonBgColor,
} from "./presets.js";
import { hasPadding, padPng, type Padding } from "./pngPadding.js";

// Zuletzt verschobene Bilder je Taste: Feedbacks laufen oft (Blinken), das PNG nur bei Änderung neu rechnen
const paddedImages = new Map<string, { source: string; key: string; png64: string }>();

function paddedPng64(feedbackId: string, png64: string, padding: Padding): string {
  if (!hasPadding(padding)) return png64;
  const key = [padding.top, padding.right, padding.bottom, padding.left].join(",");
  const cached = paddedImages.get(feedbackId);
  if (cached && cached.source === png64 && cached.key === key) return cached.png64;
  let result = png64;
  try {
    result = padPng(Buffer.from(png64, "base64"), padding)?.toString("base64") || png64;
  } catch {
    result = png64;
  }
  if (paddedImages.size > 500) paddedImages.clear();
  paddedImages.set(feedbackId, { source: png64, key, png64: result });
  return result;
}

function optionValue(value: unknown): unknown {
  if (
    value &&
    typeof value === "object" &&
    "value" in value &&
    "isExpression" in value
  ) {
    return (value as { value: unknown }).value;
  }
  return value;
}

function numberOption(
  options: Record<string, unknown>,
  keys: string[],
  fallback: number,
): number {
  for (const key of keys) {
    const raw = optionValue(options[key]);
    if (raw === undefined || raw === null || raw === "") continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringOption(options: Record<string, unknown>, key: string): string {
  return String(optionValue(options[key]) || "").trim();
}

export function UpdateFeedbacks(self: ModuleInstance): void {
  const roomChoices = self.getRoomChoices("all");
  const feedbacks: CompanionFeedbackDefinitions = {
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
      callback: () =>
        self.signalBlinkPhase &&
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
      callback: () =>
        self.signalBlinkPhase &&
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
      callback: (feedback) =>
        self.listenRooms.includes(String(feedback.options.roomId || "")),
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
      callback: (feedback) =>
        self.talkRooms.includes(String(feedback.options.roomId || "")),
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
        {
          id: "paddingInfo",
          type: "static-text",
          label: "Bild verschieben (px)",
          value: "Abstand des Kesher-Bilds zum Tastenrand in Pixeln (Taste = 72 × 72 px). Negative Werte schieben über den Rand. Den Text verschiebt Companion selbst: Position im Stil bzw. bei Ebenen-Tasten X/Y/Breite/Höhe.",
        },
        { id: "padTop", type: "number", label: "Abstand oben (px)", default: 0, min: -72, max: 72 },
        { id: "padBottom", type: "number", label: "Abstand unten (px)", default: 0, min: -72, max: 72 },
        { id: "padLeft", type: "number", label: "Abstand links (px)", default: 0, min: -72, max: 72 },
        { id: "padRight", type: "number", label: "Abstand rechts (px)", default: 0, min: -72, max: 72 },
      ],
      callback: (feedback) => {
        // Keep legacy compatibility for existing buttons that still store bankIndex.
        const feedbackOptions = feedback.options as Record<string, unknown>;
        const slotIndex = numberOption(
          feedbackOptions,
          ["slotIndex", "bankIndex"],
          0,
        );
        const sourcePageNumber = numberOption(
          feedbackOptions,
          ["sourcePageNumber"],
          -1,
        );
        const pageNumber = Number.isFinite(sourcePageNumber) && sourcePageNumber >= 0
          ? Math.trunc(sourcePageNumber)
          : undefined;
        const roleId = stringOption(feedbackOptions, "roleId");
        const profileUsername = stringOption(feedbackOptions, "profileUsername");
        const importedButton = pageNumber !== undefined && roleId
          ? self.getPresetProfileButtonConfig(
              roleId,
              pageNumber,
              slotIndex,
              profileUsername,
            )
          : null;
        const button = importedButton || (pageNumber === undefined
          ? self.getCurrentPageButtonConfig(slotIndex)
          : self.getProfileButtonConfig(pageNumber, slotIndex)) ||
          { index: slotIndex };
        const bgcolor = parseButtonBgColor(button.color);
        // Label and text colour belong to Companion Style. Live Kesher
        // updates must not replace user text, blank labels or variables.
        const fallbackStyle = {
          bgcolor,
        };

        // Return the stored PNG image if available – this is what actually
        // drives the physical Stream Deck button image. Without it the button
        // shows only the fallback text/colour and never updates visually even
        // though new images arrive via the WebSocket.
        // Kesher's image is a transparent layer (frame, function badge such as "SELECT TALK",
        // state colours); background colour and label come from Companion around it.
        // Companion takes the image only as base64 text (png64) – a "png" buffer was silently
        // dropped, so keys showed just the black fallback text without colours/state.
        const img = self.getButtonImage(slotIndex, pageNumber);
        // Inactive pages may not have streamed a live image yet after startup.
        // Use that exact button's published preview until its first update.
        const sourcePng64 = img?.toString("base64") || normalizePreviewImageBase64(button.previewImageBuffer);
        const png64 = sourcePng64 && paddedPng64(feedback.id, sourcePng64, {
          top: numberOption(feedbackOptions, ["padTop"], 0),
          right: numberOption(feedbackOptions, ["padRight"], 0),
          bottom: numberOption(feedbackOptions, ["padBottom"], 0),
          left: numberOption(feedbackOptions, ["padLeft"], 0),
        });
        const result: CompanionAdvancedFeedbackResult = png64
          ? {
              ...fallbackStyle,
              png64,
              pngalignment: "center:center",
              show_topbar: false,
            }
          : fallbackStyle;
        return result;
      },
    },
  };
  self.setFeedbackDefinitions(feedbacks);
}
