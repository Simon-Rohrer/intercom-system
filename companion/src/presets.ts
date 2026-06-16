import {
  combineRgb,
  type CompanionButtonStepActions,
  type CompanionPresetDefinitions,
} from "@companion-module/base";
import type { ModuleInstance } from "./main.js";

function rgbFromNumber(color: number): { r: number; g: number; b: number } {
  return {
    r: (color >> 16) & 0xff,
    g: (color >> 8) & 0xff,
    b: color & 0xff,
  };
}

export function parseButtonBgColor(color?: string): number {
  const value = (color || "").trim();
  if (!value) return combineRgb(0, 0, 0);
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  const hex =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : normalized;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return combineRgb(0, 0, 0);
  }
  return combineRgb(
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  );
}

export function deriveTextColor(bgcolor: number): number {
  const { r, g, b } = rgbFromNumber(bgcolor);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6
    ? combineRgb(0, 0, 0)
    : combineRgb(255, 255, 255);
}

function buildUniversalSyncedSlotPreset(self: ModuleInstance, slotIndex: number) {
  const button = self.getCurrentPageButtonConfig(slotIndex) || { index: slotIndex };
  const baseBg = parseButtonBgColor(button.color);
  const labelVar = `$(internal:btn_${slotIndex + 1}_label)`;
  const fallbackLabel = (button.label || "").trim();
  const style = {
    text: labelVar,
    textExpression: true,
    size: "auto" as const,
    color: deriveTextColor(baseBg),
    bgcolor: baseBg,
    show_topbar: false,
  };
  return {
    type: "button" as const,
    category: "Kesher Synced Slots",
    name: `Synced Slot ${slotIndex + 1}`,
    style,
    previewStyle: {
      ...style,
      text: fallbackLabel,
      textExpression: false,
    },
    feedbacks: [
      {
        feedbackId: "dynamic_button_image",
        options: { slotIndex },
      },
      {
        feedbackId: "synced_slot_style",
        options: { slotIndex },
      },
    ],
    steps: [
      {
        down: [
          {
            actionId: "trigger_synced_button",
            options: { buttonIndex: slotIndex, phase: "down" },
          },
        ],
        up: [
          {
            actionId: "trigger_synced_button",
            options: { buttonIndex: slotIndex, phase: "up" },
          },
        ],
      },
    ] as CompanionButtonStepActions[],
    options: { stepAutoProgress: true },
  };
}

function buildDynamicImageReadyPreset(slotIndex: number) {
  const style = {
    text: `KESHER ${slotIndex + 1}`,
    size: "auto" as const,
    color: combineRgb(255, 255, 255),
    bgcolor: combineRgb(20, 20, 20),
    show_topbar: false,
  };

  return {
    type: "button" as const,
    category: "Kesher Dynamic Web-UI Image",
    name: `Dynamic Image Slot ${slotIndex + 1}`,
    style,
    feedbacks: [
      {
        feedbackId: "dynamic_button_image",
        options: { slotIndex },
      },
    ],
    steps: [
      {
        down: [
          {
            actionId: "trigger_synced_button",
            options: { buttonIndex: slotIndex, phase: "down" },
          },
        ],
        up: [
          {
            actionId: "trigger_synced_button",
            options: { buttonIndex: slotIndex, phase: "up" },
          },
        ],
      },
    ] as CompanionButtonStepActions[],
    options: { stepAutoProgress: true },
  };
}

export function UpdatePresets(self: ModuleInstance): void {
  const presets: CompanionPresetDefinitions = {};

  for (let slotIndex = 0; slotIndex < 100; slotIndex += 1) {
    presets[`synced_slot_${slotIndex}`] = buildUniversalSyncedSlotPreset(
      self,
      slotIndex,
    );
    presets[`image_ready_slot_${slotIndex}`] = buildDynamicImageReadyPreset(
      slotIndex,
    );
  }

  self.setPresetDefinitions(presets);
}
