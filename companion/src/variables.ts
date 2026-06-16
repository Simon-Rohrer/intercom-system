import type { CompanionVariableDefinition } from "@companion-module/base";
import type { ModuleInstance } from "./main.js";

export function UpdateVariableDefinitions(self: ModuleInstance): void {
  const defs: CompanionVariableDefinition[] = [];

  defs.push({
    variableId: "connection_target",
    name: "Active connection target label (roleId=... / username=... / auto)",
  });
  defs.push({
    variableId: "bridge_connected",
    name: "Bridge connected (1/0)",
  });
  defs.push({
    variableId: "bridge_ws_state",
    name: "Bridge websocket state (open/connecting/closing/closed/none)",
  });
  defs.push({
    variableId: "bridge_bound",
    name: "Bridge bound to active Kesher user (1/0)",
  });
  defs.push({
    variableId: "pending_commands",
    name: "Pending bridge commands count",
  });
  defs.push({
    variableId: "last_command_ok",
    name: "Last command status OK (1/0)",
  });
  defs.push({
    variableId: "last_bridge_event_at",
    name: "Last bridge message timestamp (ISO)",
  });
  defs.push({
    variableId: "last_bridge_close_at",
    name: "Last bridge close timestamp (ISO)",
  });
  defs.push({
    variableId: "image_connected",
    name: "Image stream connected (1/0)",
  });
  defs.push({
    variableId: "image_ws_state",
    name: "Image stream websocket state (open/connecting/closing/closed/none)",
  });
  defs.push({
    variableId: "image_reconnect_attempts",
    name: "Image stream reconnect attempts",
  });
  defs.push({
    variableId: "image_last_message_at",
    name: "Last image stream message timestamp (ISO)",
  });
  defs.push({
    variableId: "image_last_error",
    name: "Last image stream error message",
  });
  defs.push({
    variableId: "image_stored_images",
    name: "Stored image buffers count",
  });
  defs.push({
    variableId: "image_effect_map_json",
    name: "Backend image effect map JSON (raw)",
  });
  defs.push({
    variableId: "image_effect_map_status",
    name: "Image effect map parse status",
  });

  for (let slotIndex = 0; slotIndex < 100; slotIndex += 1) {
    defs.push({
      variableId: `btn_${slotIndex + 1}_label`,
      name: `Slot ${slotIndex + 1} label (empty when not configured)`,
    });
    defs.push({
      variableId: `button_${slotIndex + 1}_label`,
      name: `Backup slot ${slotIndex + 1} label (legacy alias)`,
    });
    defs.push({
      variableId: `btn_${slotIndex + 1}_bgcolor`,
      name: `Slot ${slotIndex + 1} background color (numeric RGB)`,
    });
    defs.push({
      variableId: `btn_${slotIndex + 1}_textcolor`,
      name: `Slot ${slotIndex + 1} text color (numeric RGB, auto-contrast)`,
    });
    defs.push({
      variableId: `btn_${slotIndex + 1}_effect`,
      name: `Slot ${slotIndex + 1} effect value (int, from profile/state)`,
    });
    defs.push({
      variableId: `button_${slotIndex + 1}_effect`,
      name: `Backup slot ${slotIndex + 1} effect value (legacy alias)`,
    });
  }

  self.setVariableDefinitions(defs);
}
