import type { SomeCompanionConfigField } from "@companion-module/base";

export interface ModuleConfig {
  host: string;
  port: number;
  useTls: boolean;
  companionSecret: string;
  roleId: string;
  username: string;
}

export function GetConfigFields(): SomeCompanionConfigField[] {
  return [
    {
      type: "textinput",
      id: "host",
      label: "Backend host",
      default: "192.168.0.21",
      width: 8,
    },
    {
      type: "number",
      id: "port",
      label: "Backend port",
      default: 8443,
      min: 1,
      max: 65535,
      width: 4,
    },
    {
      type: "checkbox",
      id: "useTls",
      label: "Use TLS (https/wss)",
      default: true,
      width: 4,
    },
    {
      type: "textinput",
      id: "companionSecret",
      label: "Companion shared secret",
      default: "",
      width: 8,
    },
    {
      type: "textinput",
      id: "roleId",
      label: "Target role ID (preferred)",
      default: "",
      width: 8,
    },
    {
      type: "textinput",
      id: "username",
      label: "Target username (deprecated; ignored)",
      default: "",
      width: 8,
    },
  ];
}
