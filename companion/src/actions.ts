import type { CompanionActionDefinitions } from "@companion-module/base";
import type { ModuleInstance } from "./main.js";

export function UpdateActions(self: ModuleInstance): void {
  const actions: CompanionActionDefinitions = {
    trigger_synced_button: {
      name: "Trigger synced Kesher slot",
      options: [
        {
          id: "buttonIndex",
          type: "number",
          label: "Kesher slot index",
          default: 0,
          min: 0,
          max: 99,
        },
        {
          id: "phase",
          type: "dropdown",
          label: "Trigger phase",
          default: "down",
          choices: [
            { id: "down", label: "Button down" },
            { id: "up", label: "Button up" },
          ],
        },
        {
          id: "sourcePageNumber",
          type: "number",
          label: "Kesher source page (-1 = current)",
          default: -1,
          min: -1,
          max: 999,
        },
        {
          id: "roleId",
          type: "textinput",
          label: "Target role ID (blank = current)",
          default: "",
        },
      ],
      callback: async (event) => {
        const buttonIndex = Number(event.options.buttonIndex ?? 0);
        const phase =
          String(event.options.phase || "down") === "up" ? "up" : "down";
        const sourcePageNumber = Number(event.options.sourcePageNumber ?? -1);
        const targetRoleId = String(event.options.roleId || "").trim();
        const hasSourcePage =
          Number.isInteger(sourcePageNumber) && sourcePageNumber >= 0;
        const button = hasSourcePage
          ? targetRoleId
            ? self.getPresetProfileButtonConfig(
                targetRoleId,
                sourcePageNumber,
                buttonIndex,
              )
            : self.getProfileButtonConfig(sourcePageNumber, buttonIndex)
          : self.getCurrentPageButtonConfig(buttonIndex);
        const actionType = String(button?.action?.type || "none");
        const label = String(button?.label || "").trim();
        self.log(
          "info",
          `Trigger slot ${buttonIndex} page=${hasSourcePage ? sourcePageNumber : self.currentPageNumber} phase=${phase} action=${actionType} label=${label}`,
        );
        if (hasSourcePage) {
          self.dispatchBridgeCommand(
            {
              command: "press_button",
              roleId: targetRoleId || undefined,
              buttonIndex,
              state: phase,
              sourcePageNumber,
            },
            `trigger_synced_button slot=${buttonIndex} sourcePage=${sourcePageNumber} phase=${phase}`,
          );
          return;
        }
        if (actionType === "page_up" || actionType === "page_down") {
          if (phase === "down") {
            self.applyLocalPageNavigation(actionType);
            self.dispatchBridgeCommand(
              { command: actionType },
              `trigger_synced_button slot=${buttonIndex} phase=${phase} direct=${actionType}`,
            );
          }
          return;
        }
        if (actionType === "page_back") {
          if (phase === "down") {
            self.applyLocalPageBack();
            self.dispatchBridgeCommand(
              { command: "page_back" },
              `trigger_synced_button slot=${buttonIndex} phase=${phase} direct=${actionType}`,
            );
          }
          return;
        }
        if (actionType === "page_jump" || actionType === "page_home") {
          if (phase === "down") {
            const targetPage =
              actionType === "page_home" ? 0 : (button?.action?.targetPage ?? 0);
            self.applyLocalPageJump(targetPage);
            self.dispatchBridgeCommand(
              actionType === "page_home"
                ? { command: "page_home" }
                : { command: "page_jump", pageNumber: targetPage },
              `trigger_synced_button slot=${buttonIndex} phase=${phase} direct=${actionType} target=${targetPage}`,
            );
          }
          return;
        }
        self.dispatchBridgeCommand(
          {
            command: "press_button",
            buttonIndex,
            state: phase,
          },
          `trigger_synced_button index=${buttonIndex} phase=${phase}`,
        );
      },
    },
    connection_diagnostics: {
      name: "Connection diagnostics (log)",
      options: [],
      callback: async () => {
        self.runConnectionDiagnostics(false);
      },
    },
    connection_diagnostics_reconnect: {
      name: "Connection diagnostics + reconnect",
      options: [],
      callback: async () => {
        self.runConnectionDiagnostics(true);
      },
    },
    connection_roundtrip_check: {
      name: "Connection roundtrip check (no-op)",
      options: [],
      callback: async () => {
        await self.sendBridgeCommand({
          command: "press_button",
          buttonIndex: -1,
          state: "down",
        });
        self.runConnectionDiagnostics(false);
      },
    },
    image_slot_diagnostics: {
      name: "Image slot diagnostics (log)",
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
      callback: async (event) => {
        const slotIndex = Number(event.options.slotIndex ?? 0);
        self.runImageSlotDiagnostics(slotIndex);
      },
    },
  };
  self.setActionDefinitions(actions);
}
