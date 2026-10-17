import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Bootstrap,
  BroadcastGroup,
  CompanionProfileResponse,
  Presence,
  RaspberryPiStationStatus,
  StreamDeckActionType,
  StreamDeckButtonConfig,
  StreamDeckPageConfig,
  StreamDeckPageType,
  StreamDeckSettings,
} from "../types";
import type {
  ChannelAudioFeedSettings,
  InputChannelSelection,
  KeyboardShortcutSettings,
} from "../app/settings";
import type { ChannelAudioFeedStatus } from "../hooks/useIntercomSession";
import { renderStreamDeckPreviewImages, getRaspberryPiStationStatuses } from "../api";
import { createHoldButtonProps } from "../lib/holdButton";
import { resolveInputDeviceChannelCount } from "../lib/audioDeviceChannels";
import { withResolvedStreamDeckButtonLabel } from "../lib/streamDeckLabels";
import { roleAllowed } from "../lib/intercom";
import { fitKeyGrid, type KeyGridFit } from "../lib/keyGridFit";
import { resolveEmbedMode, resolveHideTalkControls } from "../lib/runtimeMode";
import { sortDirectUsersByRoleAndUsername } from "../lib/users";
import { BrandLogo } from "./BrandLogo";
import { KeyboardShortcutsSettings } from "./KeyboardShortcutsSettings";
import { LowPowerModeBadge } from "./LowPowerModeBadge";
import { PanelResizer, useStoredSize } from "./PanelResizer";
import { RaspberryPiStationsPanel } from "./RaspberryPiStationsPanel";
import { ChatPopoutSection } from "./panels/ChatPopoutSection";
import { AppShell, type ShellUser } from "./shell/AppShell";

const DB_MIN = -60;
const OUTPUT_DB_MAX = 6; // +6 dB ~ gain 2.0
const INPUT_DB_MAX = 18; // +18 dB ~ gain 7.94
const MUTE_POS = DB_MIN - 1; // sentinel slider position for mute

/** Slider position (dB) -> linear gain. Bottom-of-slider = mute. */
function sliderToGain(sliderDb: number, dbMax = OUTPUT_DB_MAX): number {
  if (sliderDb <= MUTE_POS) return 0;
  return Math.pow(10, Math.max(DB_MIN, Math.min(dbMax, sliderDb)) / 20);
}

/** Linear gain -> slider position (dB). */
function gainToSlider(gain: number, dbMax = OUTPUT_DB_MAX): number {
  if (gain <= 0) return MUTE_POS;
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return MUTE_POS;
  return Math.round(Math.max(DB_MIN, Math.min(dbMax, db)));
}

/** Gain -> display label like "+6 db", "0 db", "-inf". */
function gainToDbLabel(gain: number, dbMax = OUTPUT_DB_MAX): string {
  if (gain <= 0) return "-\u221E";
  const db = 20 * Math.log10(gain);
  if (db < DB_MIN) return "-\u221E";
  const r = Math.round(Math.max(DB_MIN, Math.min(dbMax, db)));
  if (r === 0) return "0 db";
  return `${r > 0 ? "+" : ""}${r} db`;
}

/** Slider fill percentage for CSS background gradient. */
function sliderFillPercent(gain: number, dbMax = OUTPUT_DB_MAX): number {
  const pos = gainToSlider(gain, dbMax);
  return ((pos - MUTE_POS) / (dbMax - MUTE_POS)) * 100;
}

function renderBreakableChannelName(name: string) {
  const parts = name.split("/");
  return parts.map((part, index) => (
    <Fragment key={`${part}-${index}`}>
      {part}
      {index < parts.length - 1 ? (
        <>
          /<wbr />
        </>
      ) : null}
    </Fragment>
  ));
}

const METER_DBFS_MIN = -60;
const GATE_THRESHOLD_DBFS_MIN = -72;
const GATE_THRESHOLD_DBFS_MAX = -12;
const STREAM_DECK_IMPORT_FORMAT = "kesher-user-streamdeck";
const STREAM_DECK_IMPORT_SCHEMA_VERSION = 1;

type StreamDeckImportDocument = {
  meta?: {
    format?: string;
    schemaVersion?: number;
    exportedAt?: string;
    username?: string;
  };
  settings?: unknown;
};

function normalizeImportedStreamDeckSettings(input: unknown): StreamDeckSettings {
  const raw = (input ?? {}) as Record<string, unknown>;
  const pagesRaw = Array.isArray(raw.pages) ? raw.pages : null;
  if (!pagesRaw || pagesRaw.length === 0) {
    throw new Error("Import fehlgeschlagen: Die Datei enthält keine Seiten.");
  }
  const gridColumns = Number(raw.gridColumns);
  const gridRows = Number(raw.gridRows);
  if (gridColumns !== 5 || gridRows !== 3) {
    throw new Error("Import fehlgeschlagen: Nur Stream-Deck-Belegungen mit 5×3 Tasten werden unterstützt.");
  }

  const selectedPage = Number(raw.selectedPage);
  if (!Number.isInteger(selectedPage) || selectedPage < 0) {
    throw new Error("Import fehlgeschlagen: Die gewählte Seite ist ungültig.");
  }

  const actionTypes = new Set<StreamDeckActionType>([
    "none",
    "ptt_room",
    "select_talk_room",
    "select_listen_room",
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
    "chat_message",
    "page_up",
    "page_down",
    "page_jump",
    "page_home",
    "page_back",
  ]);

  const normalizedPages = pagesRaw.map((pageEntry) => {
    const pageRaw = (pageEntry ?? {}) as Record<string, unknown>;
    const page = Number(pageRaw.page);
    const buttonsRaw = Array.isArray(pageRaw.buttons) ? pageRaw.buttons : null;
    if (!Number.isInteger(page) || page < 0 || !buttonsRaw || buttonsRaw.length !== 15) {
      throw new Error("Import fehlgeschlagen: Jede Seite braucht eine gültige Nummer und genau 15 Tasten.");
    }
    const seenIndices = new Set<number>();
    const buttons = buttonsRaw.map((buttonEntry) => {
      const buttonRaw = (buttonEntry ?? {}) as Record<string, unknown>;
      const index = Number(buttonRaw.index);
      if (!Number.isInteger(index) || index < 0 || index >= 15 || seenIndices.has(index)) {
        throw new Error("Import fehlgeschlagen: Die Tasten müssen eindeutig von 0 bis 14 nummeriert sein.");
      }
      seenIndices.add(index);

      const actionRaw = buttonRaw.action as Record<string, unknown> | undefined;
      if (!actionRaw) {
        return {
          index,
          label: typeof buttonRaw.label === "string" ? buttonRaw.label : "",
          color: typeof buttonRaw.color === "string" ? buttonRaw.color : "",
        };
      }

      const type = actionRaw.type;
      if (typeof type !== "string" || !actionTypes.has(type as StreamDeckActionType)) {
        throw new Error("Import fehlgeschlagen: Unbekannte Tastenfunktion.");
      }

      return {
        index,
        label: typeof buttonRaw.label === "string" ? buttonRaw.label : "",
        color: typeof buttonRaw.color === "string" ? buttonRaw.color : "",
        action: {
          type: type as StreamDeckActionType,
          roomId: typeof actionRaw.roomId === "string" ? actionRaw.roomId : undefined,
          userId: typeof actionRaw.userId === "string" ? actionRaw.userId : undefined,
          roleId: typeof actionRaw.roleId === "string" ? actionRaw.roleId : undefined,
          broadcastGroupId:
            typeof actionRaw.broadcastGroupId === "string"
              ? actionRaw.broadcastGroupId
              : undefined,
          volumeDelta:
            typeof actionRaw.volumeDelta === "number" && Number.isFinite(actionRaw.volumeDelta)
              ? actionRaw.volumeDelta
              : undefined,
          targetPage:
            typeof actionRaw.targetPage === "number" && Number.isFinite(actionRaw.targetPage)
              ? actionRaw.targetPage
              : undefined,
          message: typeof actionRaw.message === "string" ? actionRaw.message : undefined,
        },
      };
    });

    const pageTypeCandidate =
      typeof pageRaw.pageType === "string" ? pageRaw.pageType : "manual";
    const pageType =
      pageTypeCandidate === "all_roles" || pageTypeCandidate === "all_party_lines"
        ? (pageTypeCandidate as StreamDeckPageType)
        : ("manual" as StreamDeckPageType);
    const parentPage = Number(pageRaw.parentPage);

    return {
      page,
      title: typeof pageRaw.title === "string" ? pageRaw.title : "",
      pageType,
      parentPage: Number.isInteger(parentPage) && parentPage >= 0 ? parentPage : undefined,
      buttons,
    };
  });

  if (!normalizedPages.some((entry) => entry.page === selectedPage)) {
    throw new Error("Import fehlgeschlagen: Die gewählte Seite gibt es nicht.");
  }

  return {
    version:
      typeof raw.version === "number" && Number.isFinite(raw.version) && raw.version > 0
        ? raw.version
        : 1,
    gridColumns,
    gridRows,
    selectedPage,
    pages: normalizedPages,
  };
}

function parseStreamDeckImportDocument(text: string): StreamDeckSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Import fehlgeschlagen: Die Datei ist kein gültiges JSON.");
  }

  const doc = (parsed ?? {}) as StreamDeckImportDocument;
  if (doc && typeof doc === "object" && doc.settings !== undefined) {
    const format = doc.meta?.format;
    const schemaVersion = doc.meta?.schemaVersion;
    if (format && format !== STREAM_DECK_IMPORT_FORMAT) {
      throw new Error(`Import fehlgeschlagen: Erwartet wird das Format ${STREAM_DECK_IMPORT_FORMAT}.`);
    }
    if (
      typeof schemaVersion === "number" &&
      schemaVersion !== STREAM_DECK_IMPORT_SCHEMA_VERSION
    ) {
      throw new Error("Import fehlgeschlagen: Diese Dateiversion wird nicht unterstützt.");
    }
    return normalizeImportedStreamDeckSettings(doc.settings);
  }

  // Backward-compatible fallback: allow raw StreamDeckSettings JSON.
  return normalizeImportedStreamDeckSettings(parsed);
}

function createEmptyStreamDeckButtons(count: number) {
  return Array.from({ length: count }, (_, index) => ({ index }));
}

function createEmptyStreamDeckPage(
  settings: Pick<StreamDeckSettings, "gridColumns" | "gridRows">,
  page: number,
): StreamDeckPageConfig {
  return {
    page,
    title: "",
    pageType: "manual",
    buttons: createEmptyStreamDeckButtons(settings.gridColumns * settings.gridRows),
  };
}

function cloneStreamDeckButtonConfig(
  button: StreamDeckButtonConfig,
): StreamDeckButtonConfig {
  return {
    ...button,
    action: button.action ? { ...button.action } : undefined,
  };
}

function cloneStreamDeckSettings(settings: StreamDeckSettings): StreamDeckSettings {
  return {
    ...settings,
    pages: settings.pages.map((page) => ({
      ...page,
      buttons: page.buttons.map((button) => cloneStreamDeckButtonConfig(button)),
    })),
  };
}

function isConfiguredStreamDeckButton(button: StreamDeckButtonConfig) {
  return Boolean(
    (button.label && button.label.trim()) ||
      (button.color && button.color.trim()) ||
      (button.action && button.action.type !== "none"),
  );
}

function isConfiguredStreamDeckPage(page: StreamDeckPageConfig) {
  return Boolean(
    (page.title && page.title.trim()) ||
      (page.pageType && page.pageType !== "manual") ||
      page.parentPage !== undefined ||
      page.buttons.some(isConfiguredStreamDeckButton),
  );
}

function compactStreamDeckSettings(settings: StreamDeckSettings): StreamDeckSettings {
  const configuredPages = settings.pages
    .filter(isConfiguredStreamDeckPage)
    .sort((a, b) => a.page - b.page);
  const compactPages =
    configuredPages.length > 0
      ? configuredPages
      : [createEmptyStreamDeckPage(settings, 0)];
  const pageNumbers = new Set(compactPages.map((page) => page.page));
  const pages = compactPages.map((page) => ({
    ...page,
    parentPage:
      page.parentPage !== undefined && pageNumbers.has(page.parentPage)
        ? page.parentPage
        : undefined,
    buttons: page.buttons.map((button) => cloneStreamDeckButtonConfig(button)),
  }));
  const selectedPage = pageNumbers.has(settings.selectedPage)
    ? settings.selectedPage
    : pages[0].page;

  return {
    ...settings,
    selectedPage,
    pages,
  };
}

/** Mirrors StreamDeckChatMessageMaxLength in the backend. */
const STREAM_DECK_CHAT_MESSAGE_MAX_LENGTH = 200;

function streamDeckActionLabel(actionType: StreamDeckActionType | undefined) {
  switch (actionType) {
    case "ptt_room":
      return "Sprechen auf festem Kanal";
    case "select_talk_room":
      return "Sprechkanal wählen";
    case "select_listen_room":
      return "Kanal wählen + hören";
    case "ptt_selected":
      return "Sprechen auf gewählten Kanälen";
    case "listen_room":
      return "Kanal hören";
    case "call_room":
      return "Kanal rufen";
    case "direct_user":
      return "Person direkt";
    case "direct_role":
      return "Rolle direkt";
    case "reply_to_caller":
      return "Anrufer antworten";
    case "incoming_call_indicator":
      return "Anzeige eingehende Rufe";
    case "raspberry_status":
      return "Raspberry-Pi-Status";
    case "broadcast_ptt":
      return "Durchsage sprechen";
    case "page_up":
      return "Seite hoch";
    case "page_down":
      return "Seite runter";
    case "page_home":
      return "Startseite";
    case "page_jump":
      return "Seite / Ordner öffnen";
    case "volume_delta":
      return "Lautstärke";
    case "chat_message":
      return "Chat-Nachricht";
    case "none":
    case undefined:
      return "Leer";
    default:
      return "Belegt";
  }
}

function streamDeckPreviewSignature(
  button: StreamDeckButtonConfig & {
    isListening?: boolean;
    isPttSelected?: boolean;
  },
  pressed: boolean,
): string {
  const action = button.action;
  return [
    button.index,
    button.label || "",
    button.color || "",
    action?.type || "none",
    action?.roomId || "",
    action?.userId || "",
    action?.roleId || "",
    action?.broadcastGroupId || "",
    action?.volumeDelta ?? "",
    action?.message ?? "",
    button.isListening ? "1" : "0",
    button.isPttSelected ? "1" : "0",
    pressed ? "1" : "0",
  ].join("|");
}

function splitStreamDeckLabel(label?: string): { primary: string; subtitle: string } {
  const text = (label ?? "").trim();
  if (!text) {
    return { primary: "", subtitle: "" };
  }
  const parts = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    primary: parts[0] ?? "",
    subtitle: parts[1] ?? "",
  };
}

function meterDbFsToPercent(dbFs: number): number {
  const clamped = Math.max(METER_DBFS_MIN, Math.min(0, dbFs));
  return ((clamped - METER_DBFS_MIN) / (0 - METER_DBFS_MIN)) * 100;
}

function formatDbFs(dbFs: number): string {
  if (!Number.isFinite(dbFs) || dbFs <= METER_DBFS_MIN) return "-inf dBFS";
  if (Math.abs(dbFs) < 0.05) return "0.0 dBFS";
  return `${dbFs.toFixed(1)} dBFS`;
}

function formatGateThresholdDb(dbFs: number): string {
  return `${Math.round(dbFs)} dBFS`;
}

function gateThresholdDbToPercent(dbFs: number): number {
  const clamped = Math.max(
    GATE_THRESHOLD_DBFS_MIN,
    Math.min(GATE_THRESHOLD_DBFS_MAX, dbFs),
  );
  return (
    ((clamped - GATE_THRESHOLD_DBFS_MIN) /
      (GATE_THRESHOLD_DBFS_MAX - GATE_THRESHOLD_DBFS_MIN)) *
    100
  );
}

type SettingsIconName =
  | "audio"
  | "controls"
  | "hardware"
  | "info"
  | "keyboard"
  | "layout"
  | "settings"
  | "system";

type SettingsPageId =
  | "layout"
  | "interaction"
  | "system"
  | "shortcuts"
  | "streamdeck"
  | "audio";

const SETTINGS_NAV_ITEMS: {
  id: SettingsPageId;
  label: string;
  icon: SettingsIconName;
}[] = [
  { id: "layout", label: "Layout", icon: "layout" },
  { id: "interaction", label: "Bedienung", icon: "controls" },
  { id: "system", label: "System", icon: "system" },
  { id: "shortcuts", label: "Tastenkürzel", icon: "keyboard" },
  { id: "streamdeck", label: "Stream Deck", icon: "hardware" },
  { id: "audio", label: "Ton & Mikrofon", icon: "audio" },
];

function SettingsIcon({
  name,
  className = "",
}: {
  name: SettingsIconName;
  className?: string;
}) {
  const commonProps = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (name === "layout") {
    return (
      <svg {...commonProps}>
        <rect x="3" y="4" width="7" height="7" rx="1.5" />
        <rect x="14" y="4" width="7" height="7" rx="1.5" />
        <rect x="3" y="15" width="18" height="5" rx="1.5" />
      </svg>
    );
  }

  if (name === "controls") {
    return (
      <svg {...commonProps}>
        <path d="M4 7h10" />
        <path d="M18 7h2" />
        <circle cx="16" cy="7" r="2" />
        <path d="M4 17h2" />
        <path d="M10 17h10" />
        <circle cx="8" cy="17" r="2" />
      </svg>
    );
  }

  if (name === "system") {
    return (
      <svg {...commonProps}>
        <path d="M12 3v3" />
        <path d="M12 18v3" />
        <path d="M5.6 5.6l2.1 2.1" />
        <path d="M16.3 16.3l2.1 2.1" />
        <path d="M3 12h3" />
        <path d="M18 12h3" />
        <circle cx="12" cy="12" r="4" />
      </svg>
    );
  }

  if (name === "keyboard") {
    return (
      <svg {...commonProps}>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <path d="M7 10h.01" />
        <path d="M11 10h.01" />
        <path d="M15 10h.01" />
        <path d="M7 14h6" />
        <path d="M16 14h1" />
      </svg>
    );
  }

  if (name === "hardware") {
    return (
      <svg {...commonProps}>
        <rect x="5" y="4" width="14" height="16" rx="2" />
        <path d="M9 8h.01" />
        <path d="M12 8h.01" />
        <path d="M15 8h.01" />
        <path d="M9 12h.01" />
        <path d="M12 12h.01" />
        <path d="M15 12h.01" />
        <path d="M9 16h.01" />
        <path d="M12 16h.01" />
        <path d="M15 16h.01" />
      </svg>
    );
  }

  if (name === "audio") {
    return (
      <svg {...commonProps}>
        <path d="M4 14h4l5 4V6L8 10H4z" />
        <path d="M17 9.5a4 4 0 0 1 0 5" />
        <path d="M19.5 7a7.5 7.5 0 0 1 0 10" />
      </svg>
    );
  }

  if (name === "info") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5" />
        <path d="M12 8h.01" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.05.05a2 2 0 1 1-2.83 2.83l-.05-.05A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6V20a2 2 0 1 1-4 0v-.07a1.7 1.7 0 0 0-1-.6 1.7 1.7 0 0 0-1.88.34l-.05.05a2 2 0 1 1-2.83-2.83l.05-.05A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1H4a2 2 0 1 1 0-4h.07a1.7 1.7 0 0 0 .6-1 1.7 1.7 0 0 0-.34-1.88l-.05-.05A2 2 0 1 1 7.1 4.24l.05.05A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6V4a2 2 0 1 1 4 0v.07a1.7 1.7 0 0 0 1 .6 1.7 1.7 0 0 0 1.88-.34l.05-.05a2 2 0 1 1 2.83 2.83l-.05.05A1.7 1.7 0 0 0 19.4 9c.24.34.45.69.6 1H20a2 2 0 1 1 0 4h-.07a1.7 1.7 0 0 0-.53 1z" />
    </svg>
  );
}

function LogoutIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 6H6.5A2.5 2.5 0 0 0 4 8.5v7A2.5 2.5 0 0 0 6.5 18H10" />
      <path d="M14 8l4 4-4 4" />
      <path d="M18 12H9" />
    </svg>
  );
}

function ChevronIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

type StreamDeckUiIconName =
  | "check"
  | "device"
  | "download"
  | "reset"
  | "save"
  | "send"
  | "upload"
  | "warning";

function StreamDeckUiIcon({
  name,
  className = "",
}: {
  name: StreamDeckUiIconName;
  className?: string;
}) {
  const commonProps = {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
  };

  if (name === "check") {
    return (
      <svg {...commonProps}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }

  if (name === "warning") {
    return (
      <svg {...commonProps}>
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.2 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.8 4.3a2 2 0 0 0-3.6 0z" />
      </svg>
    );
  }

  if (name === "device") {
    return (
      <svg {...commonProps}>
        <rect x="6" y="3" width="12" height="18" rx="2" />
        <path d="M9 7h.01" />
        <path d="M12 7h.01" />
        <path d="M15 7h.01" />
        <path d="M9 11h.01" />
        <path d="M12 11h.01" />
        <path d="M15 11h.01" />
        <path d="M9 15h.01" />
        <path d="M12 15h.01" />
        <path d="M15 15h.01" />
      </svg>
    );
  }

  if (name === "download") {
    return (
      <svg {...commonProps}>
        <path d="M12 3v11" />
        <path d="m7 9 5 5 5-5" />
        <path d="M5 20h14" />
      </svg>
    );
  }

  if (name === "upload") {
    return (
      <svg {...commonProps}>
        <path d="M12 21V10" />
        <path d="m7 15 5-5 5 5" />
        <path d="M5 4h14" />
      </svg>
    );
  }

  if (name === "save") {
    return (
      <svg {...commonProps}>
        <path d="M5 4h12l2 2v14H5z" />
        <path d="M8 4v6h8V4" />
        <path d="M8 16h8" />
      </svg>
    );
  }

  if (name === "send") {
    return (
      <svg {...commonProps}>
        <path d="m22 2-7 20-4-9-9-4z" />
        <path d="M22 2 11 13" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

function SettingsSectionHeader({
  icon,
  title,
  eyebrow,
}: {
  icon: SettingsIconName;
  title: string;
  eyebrow: string;
}) {
  return (
    <div className="station-settings-section-head">
      <span className="station-settings-icon">
        <SettingsIcon name={icon} />
      </span>
      <div>
        <span>{eyebrow}</span>
        <h4 className="station-settings-section-title">{title}</h4>
      </div>
    </div>
  );
}

type StationSectionTone = "talk" | "direct" | "broadcast";

function StationSectionIcon({ tone }: { tone: StationSectionTone }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  if (tone === "direct") {
    return (
      <svg {...commonProps}>
        <path d="M7 8.5a4 4 0 0 1 8 0" />
        <path d="M3.5 15.5c1.7-2 4-3 6.5-3" />
        <path d="M20.5 15.5c-1.7-2-4-3-6.5-3" />
        <path d="M8 19h8" />
        <path d="M12 12.5V19" />
      </svg>
    );
  }

  if (tone === "broadcast") {
    return (
      <svg {...commonProps}>
        <path d="M5 10v4" />
        <path d="M8 8v8" />
        <path d="M11 5v14" />
        <path d="M15 8.5a4.5 4.5 0 0 1 0 7" />
        <path d="M18 6a8.5 8.5 0 0 1 0 12" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <path d="M5 15h3l4 4V5L8 9H5z" />
      <path d="M16 9.5a4 4 0 0 1 0 5" />
      <path d="M19 7a7.5 7.5 0 0 1 0 10" />
    </svg>
  );
}

function StationSectionHeader({
  tone,
  title,
  count,
  hint,
}: {
  tone: StationSectionTone;
  title: string;
  count: string;
  hint?: string;
}) {
  return (
    <div className={`station-section-head tone-${tone}`}>
      <span className="station-section-icon">
        <StationSectionIcon tone={tone} />
      </span>
      <h3>{title}</h3>
      {hint ? <span className="station-section-hint">{hint}</span> : null}
      <span className="station-section-count">{count}</span>
    </div>
  );
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/**
 * Station settings: a modal "Station-Setup" (kiosk) or, inside the sidebar
 * frame, the normal page "Einstellungen" with its sub-navigation as pills.
 */
function StationSettingsFrame({
  asPage,
  lowPowerMode,
  activePage,
  onSelectPage,
  onClose,
  children,
}: {
  asPage: boolean;
  lowPowerMode: boolean;
  activePage: SettingsPageId;
  onSelectPage: (page: SettingsPageId) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (asPage) {
    return (
      <section
        className="k-page station-settings-page"
        aria-labelledby="user-settings-title"
      >
        <div className="k-page-head">
          <div>
            <h1 id="user-settings-title">Einstellungen</h1>
            <p className="k-lead">
              Ansicht, Bedienung, Ton und Stream Deck für diese Station.
            </p>
          </div>
        </div>
        <nav className="k-subnav" aria-label="Bereiche der Einstellungen">
          {SETTINGS_NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`k-subnav-pill ${activePage === item.id ? "active" : ""}`.trim()}
              aria-current={activePage === item.id ? "page" : undefined}
              aria-controls={`settings-${item.id}`}
              onClick={() => onSelectPage(item.id)}
            >
              <SettingsIcon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="station-modal-body">{children}</div>
      </section>
    );
  }
  return (
    <div
      className={`station-modal-backdrop ${
        lowPowerMode ? "station-modal-backdrop-low-power" : ""
      }`.trim()}
      onClick={onClose}
    >
      <section
        className="station-modal panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="station-modal-header">
          <div className="station-modal-title">
            <span>Einstellungen</span>
            <h3 id="user-settings-title">Station-Setup</h3>
          </div>
          <button
            className="station-modal-close"
            onClick={onClose}
            aria-label="Einstellungen schließen"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="station-settings-shell">
          <nav
            className="station-settings-nav"
            aria-label="Bereiche der Einstellungen"
          >
            {SETTINGS_NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={activePage === item.id ? "active" : ""}
                aria-current={activePage === item.id ? "page" : undefined}
                aria-controls={`settings-${item.id}`}
                onClick={() => onSelectPage(item.id)}
              >
                <SettingsIcon name={item.icon} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="station-modal-body">{children}</div>
        </div>
      </section>
    </div>
  );
}

function StationMicMeter({ levelPercent }: { levelPercent: number }) {
  const segments = 16;
  const active = Math.round((Math.max(0, Math.min(100, levelPercent)) / 100) * segments);
  return (
    <span className="station-mic-meter" aria-hidden="true">
      {Array.from({ length: segments }, (_, index) => {
        const band =
          index >= segments * 0.9 ? "peak" : index >= segments * 0.7 ? "warning" : "signal";
        return (
          <span key={index} className={`${band} ${index < active ? "active" : ""}`} />
        );
      })}
    </span>
  );
}

function SettingsToggle({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className={`station-setting ${disabled ? "disabled" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="station-setting-toggle" aria-hidden="true" />
      <span className="station-setting-copy">
        <span className="station-setting-label">{label}</span>
        <small aria-hidden="true">{description}</small>
      </span>
    </label>
  );
}

function SettingsStatusCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="station-settings-status-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type ChannelAudioFeedRoomForm = {
  id?: string;
  name: string;
  priorityLevel: number;
  senderRoleIds: string[];
  receiverRoleIds: string[];
  forcedListenRoleIds: string[];
};

type ChannelAudioFeedEditor = {
  mode: "create" | "edit";
  feedId?: string;
  roomId?: string;
  name: string;
  priorityLevel: number;
  inputDeviceId: string;
  inputChannel: InputChannelSelection;
  gain: number;
  enabled: boolean;
  senderRoleIds: string[];
  receiverRoleIds: string[];
  forcedListenRoleIds: string[];
};

/** Gap between keys in the embedded layout (must match station.css). */
const EMBED_KEY_GAP = 8;

/**
 * Key size in the embedded layout as CSS variables: `--key-scale` scales the
 * text and buttons of a key (1 = the size of a normal key, ~140px high).
 */
function embedKeyGridStyle(fit: KeyGridFit | null): React.CSSProperties | undefined {
  if (!fit) return undefined;
  const scale = Math.min(
    1.8,
    Math.max(0.5, Math.min(fit.keyHeight / 140, fit.keyWidth / 190)),
  );
  return {
    "--fit-cols": fit.cols,
    "--fit-rows": fit.rows,
    "--key-scale": scale.toFixed(3),
  } as React.CSSProperties;
}

type StationIntercomViewProps = {
  token: string;
  connectionState: "connecting" | "connected" | "reconnecting" | "offline";
  lowPowerMode: boolean;
  audioControlsLowPowerMode?: boolean;
  appData: Bootstrap;
  doLogout: () => void;
  listenRoomIds: string[];
  talkRoomIds: string[];
  canRoleSendToRoom: (roomId: string, currentRoleId: string) => boolean;
  canRoleReceiveFromRoom: (roomId: string, currentRoleId: string) => boolean;
  toggleTalkRoom: (roomId: string) => void;
  toggleListenRoom: (roomId: string) => void;
  roomLevelById: Record<string, number>;
  isReceivingRoom: (roomId: string) => boolean;
  isReceivingBroadcast: (groupId: string) => boolean;
  isReceivingDirect: (userId: string) => boolean;
  broadcastPttPressed: string | null;
  startBroadcastPtt: (groupId: string) => void;
  stopBroadcastPtt: (groupId: string) => void;
  broadcastGroups: BroadcastGroup[];
  presence: Presence[];
  roomListenerCounts: Record<string, number>;
  roleNameById: Map<string, string>;
  lastDirectCallerUserId: string | null;
  directPttPressedUserId: string | null;
  startDirectPtt: (userId: string) => void;
  stopDirectPtt: (userId: string) => void;
  sendScopedSignal: (
    scopeValue: "direct" | "room" | "broadcast",
    scopedTargetId: string,
    signal: string,
  ) => void;
  pttPressed: boolean;
  startPtt: () => void;
  stopPtt: () => void;
  voiceMode: "always_on" | "ptt";
  setAlwaysOn: (enabled: boolean) => void;
  chatAndSignalPanel: React.ReactNode;
  raspberryPiStations: RaspberryPiStationStatus[] | null;
  raspberryPiStationsError: string;
  showDebug: boolean;
  realtimeDebugBlock: React.ReactNode;
  enableDirectPpt: boolean;
  onEnableDirectPptChange: (enabled: boolean) => void;
  enableDirectTabs: boolean;
  onEnableDirectTabsChange: (enabled: boolean) => void;
  swapPttAndReplyButtons: boolean;
  onSwapPttAndReplyButtonsChange: (enabled: boolean) => void;
  enableBackgroundAudioRecovery: boolean;
  onEnableBackgroundAudioRecoveryChange: (enabled: boolean) => void;
  keepScreenAwake: boolean;
  onKeepScreenAwakeChange: (enabled: boolean) => void;
  showVolumeControls: boolean;
  onShowVolumeControlsChange: (enabled: boolean) => void;
  mediaSessionSupported: boolean;
  wakeLockSupported: boolean;
  wakeLockActive: boolean;
  isStandaloneDisplayMode: boolean;
  onChannelPptStart: (channelId: string) => void;
  onChannelPptStop: (channelId: string) => void;
  pptPressedChannelId: string | null;
  pinnedRoomIds: string[];
  pinnedUserIds: string[];
  showPinnedOnly: boolean;
  onTogglePinnedUser: (userId: string) => void;
  onShowPinnedOnlyChange: (value: boolean) => void;
  isUserSettingsOpen: boolean;
  setIsUserSettingsOpen: (value: boolean) => void;
  roomGainById: Record<string, number>;
  directGainByUserId: Record<string, number>;
  onRoomGainChange: (roomId: string, gain: number) => void;
  onDirectGainChange: (userId: string, gain: number) => void;
  // Keyboard shortcuts
  keyboardShortcuts: KeyboardShortcutSettings;
  onKeyboardShortcutsChange: (next: KeyboardShortcutSettings) => void;
  onRecordingShortcutChange: (recording: boolean) => void;
  // Audio device props
  inputDevices: MediaDeviceInfo[];
  selectedInputDeviceId: string;
  selectedMicLabel: string;
  setSelectedInputDeviceId: (value: string) => void;
  selectedInputChannel: InputChannelSelection;
  inputChannelCount: number;
  onSelectedInputChannelChange: (channel: InputChannelSelection) => void;
  inputLevelDbFs: number;
  inputGain: number;
  inputClipping: boolean;
  isLocalMonitorActive: boolean;
  onToggleLocalMonitor: () => void;
  onInputGainChange: (deviceId: string, gain: number) => void;
  channelAudioFeeds: ChannelAudioFeedSettings[];
  channelAudioFeedStatuses: ChannelAudioFeedStatus[];
  onCreateChannelAudioFeed: (
    feed: Omit<ChannelAudioFeedSettings, "id">,
  ) => string;
  onUpdateChannelAudioFeed: (
    feedId: string,
    patch: Partial<Omit<ChannelAudioFeedSettings, "id">>,
  ) => void;
  onRemoveChannelAudioFeed: (feedId: string) => void;
  onCreateChannelAudioFeedRoom: (
    payload: ChannelAudioFeedRoomForm,
  ) => Promise<string>;
  onUpdateChannelAudioFeedRoom: (
    roomId: string,
    payload: ChannelAudioFeedRoomForm,
  ) => Promise<void>;
  audioGateEnabled: boolean;
  onAudioGateEnabledChange: (enabled: boolean) => void;
  audioGateThresholdDb: number;
  onAudioGateThresholdDbChange: (db: number) => void;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string;
  selectedOutputLabel: string;
  outputSelectionSupported: boolean;
  setSelectedOutputDeviceId: (value: string) => void;
  streamDeckSettings: StreamDeckSettings | null;
  streamDeckBusy: boolean;
  streamDeckError: string;
  onStreamDeckSettingsChange: (next: StreamDeckSettings) => void;
  onSaveStreamDeckSettings: (settings?: StreamDeckSettings) => void | Promise<void>;
  onResetStreamDeckSettings: () => void;
  onPublishCompanionProfile: (
    settings?: StreamDeckSettings,
  ) => Promise<CompanionProfileResponse>;
  streamDeckWebHidSupported: boolean;
  streamDeckWebHidActive: boolean;
  streamDeckWebHidBusy: boolean;
  onConnectStreamDeckWebHid: () => void;
  onDisconnectStreamDeckWebHid: () => void;
  streamDeckBridgeConnected: boolean;
  streamDeckBridgeLastEvent: string;
  lastCompanionCommand: {
    command: string;
    status: "executing" | "executed" | "rejected" | "failed";
    error?: string;
    at: number;
  } | null;
  onStreamDeckTestButtonEvent: (event: {
    page: number;
    buttonIndex: number;
    state: "down" | "up";
  }) => void;
  remoteControl?: {
    stationName: string;
    roleName: string;
    onLeave: () => void;
  };
  /**
   * Page frame with sidebar (like JMS Control). Not passed for kiosk
   * stations; ignored for the Raspberry remote session and embedded tiles.
   */
  shell?: { user: ShellUser };
};

export function StationIntercomView({
  token,
  connectionState,
  lowPowerMode,
  audioControlsLowPowerMode = lowPowerMode,
  appData,
  doLogout,
  listenRoomIds,
  talkRoomIds,
  canRoleSendToRoom,
  canRoleReceiveFromRoom,
  toggleTalkRoom,
  toggleListenRoom,
  roomLevelById,
  isReceivingRoom,
  isReceivingBroadcast,
  isReceivingDirect,
  broadcastPttPressed,
  startBroadcastPtt,
  stopBroadcastPtt,
  broadcastGroups,
  presence,
  roomListenerCounts,
  roleNameById,
  lastDirectCallerUserId,
  directPttPressedUserId,
  startDirectPtt,
  stopDirectPtt,
  sendScopedSignal,
  pttPressed,
  startPtt,
  stopPtt,
  voiceMode,
  setAlwaysOn,
  chatAndSignalPanel,
  raspberryPiStations,
  raspberryPiStationsError,
  showDebug,
  realtimeDebugBlock,
  enableDirectPpt,
  onEnableDirectPptChange,
  enableDirectTabs,
  onEnableDirectTabsChange,
  swapPttAndReplyButtons,
  onSwapPttAndReplyButtonsChange,
  enableBackgroundAudioRecovery,
  onEnableBackgroundAudioRecoveryChange,
  keepScreenAwake,
  onKeepScreenAwakeChange,
  showVolumeControls,
  onShowVolumeControlsChange,
  mediaSessionSupported,
  wakeLockSupported,
  wakeLockActive,
  isStandaloneDisplayMode,
  onChannelPptStart,
  onChannelPptStop,
  pptPressedChannelId,
  pinnedRoomIds,
  pinnedUserIds,
  showPinnedOnly,
  onTogglePinnedUser,
  onShowPinnedOnlyChange,
  isUserSettingsOpen,
  setIsUserSettingsOpen,
  roomGainById,
  directGainByUserId,
  onRoomGainChange,
  onDirectGainChange,
  keyboardShortcuts,
  onKeyboardShortcutsChange,
  onRecordingShortcutChange,
  inputDevices,
  selectedInputDeviceId,
  selectedMicLabel,
  setSelectedInputDeviceId,
  selectedInputChannel,
  inputChannelCount,
  onSelectedInputChannelChange,
  inputLevelDbFs,
  inputGain,
  inputClipping,
  isLocalMonitorActive,
  onToggleLocalMonitor,
  onInputGainChange,
  channelAudioFeeds,
  channelAudioFeedStatuses,
  onCreateChannelAudioFeed,
  onUpdateChannelAudioFeed,
  onRemoveChannelAudioFeed,
  onCreateChannelAudioFeedRoom,
  onUpdateChannelAudioFeedRoom,
  audioGateEnabled,
  onAudioGateEnabledChange,
  audioGateThresholdDb,
  onAudioGateThresholdDbChange,
  outputDevices,
  selectedOutputDeviceId,
  selectedOutputLabel,
  outputSelectionSupported,
  setSelectedOutputDeviceId,
  streamDeckSettings,
  streamDeckBusy,
  streamDeckError,
  onStreamDeckSettingsChange,
  onSaveStreamDeckSettings,
  onResetStreamDeckSettings,
  onPublishCompanionProfile,
  streamDeckWebHidSupported,
  streamDeckWebHidActive,
  streamDeckWebHidBusy,
  onConnectStreamDeckWebHid,
  onDisconnectStreamDeckWebHid,
  streamDeckBridgeConnected,
  streamDeckBridgeLastEvent,
  lastCompanionCommand,
  onStreamDeckTestButtonEvent,
  remoteControl,
  shell,
}: StationIntercomViewProps) {
  const [isMicMenuOpen, setIsMicMenuOpen] = useState(false);
  const [isOutputMenuOpen, setIsOutputMenuOpen] = useState(false);
  const micMenuRef = useRef<HTMLDivElement>(null);
  const contentGridRef = useRef<HTMLDivElement>(null);
  const secondaryColumnRef = useRef<HTMLElement>(null);
  const [sideWidth, setSideWidth] = useStoredSize("kesher.station.sideWidth");
  const [chatHeight, setChatHeight] = useStoredSize("kesher.station.chatHeight");
  const outputMenuRef = useRef<HTMLDivElement>(null);
  const [isAudioOpen, setIsAudioOpen] = useState(false);
  const [isPersonalAudioOpen, setIsPersonalAudioOpen] = useState(true);
  const [isChannelAudioFeedsOpen, setIsChannelAudioFeedsOpen] = useState(false);
  const [channelAudioFeedEditor, setChannelAudioFeedEditor] =
    useState<ChannelAudioFeedEditor | null>(null);
  const [channelAudioFeedSaveBusy, setChannelAudioFeedSaveBusy] =
    useState(false);
  const [channelAudioFeedSaveError, setChannelAudioFeedSaveError] =
    useState("");
  const [isStreamDeckOpen, setIsStreamDeckOpen] = useState(false);
  const [streamDeckTestMode, setStreamDeckTestMode] = useState(false);
  const streamDeckImportInputRef = useRef<HTMLInputElement>(null);
  const [streamDeckTransferMessage, setStreamDeckTransferMessage] = useState("");
  const [streamDeckTransferError, setStreamDeckTransferError] = useState("");
  const [streamDeckSaveBusy, setStreamDeckSaveBusy] = useState(false);
  const [companionPublishBusy, setCompanionPublishBusy] = useState(false);
  const [isCompanionPublishConfirmOpen, setIsCompanionPublishConfirmOpen] =
    useState(false);
  const [activeSettingsPage, setActiveSettingsPage] =
    useState<SettingsPageId>("layout");

  // Use live monitoring data from prop as primary source, fall back to API fetch.
  // This ensures the Stream Deck preview reflects current PI status without
  // requiring the user to open the streamdeck settings page first.
  const [raspberryPisFetched, setRaspberryPisFetched] = useState<RaspberryPiStationStatus[]>([]);
  useEffect(() => {
    if (activeSettingsPage === "streamdeck") {
      getRaspberryPiStationStatuses(token)
        .then((res) => setRaspberryPisFetched(res.stations))
        .catch(console.error);
    }
  }, [activeSettingsPage, token]);
  // Prefer live monitoring data from prop (updated by App.tsx poller), fall back to fetched list
  const raspberryPis: RaspberryPiStationStatus[] =
    (raspberryPiStations && raspberryPiStations.length > 0)
      ? raspberryPiStations
      : raspberryPisFetched;
  const [streamDeckPreviewPressedIndexes, setStreamDeckPreviewPressedIndexes] =
    useState<number[]>([]);
  const [activeDirectTab, setActiveDirectTab] = useState<string>("all");
  const [streamDeckSelectedButtonIndex, setStreamDeckSelectedButtonIndex] =
    useState(0);
  const [streamDeckClipboardButton, setStreamDeckClipboardButton] = useState<
    StreamDeckButtonConfig | null
  >(null);
  const [streamDeckDragSourceIndex, setStreamDeckDragSourceIndex] = useState<
    number | null
  >(null);
  const [streamDeckDropTargetIndex, setStreamDeckDropTargetIndex] = useState<
    number | null
  >(null);
  const [streamDeckUndoStack, setStreamDeckUndoStack] = useState<
    StreamDeckSettings[]
  >([]);
  const streamDeckPreviewCacheRef = useRef<
    Map<number, { signature: string; dataUrl: string }>
  >(new Map());
  const openSettingsPage = (page: SettingsPageId) => {
    setActiveSettingsPage(page);
    if (page === "streamdeck") {
      setIsStreamDeckOpen(true);
    }
    if (page === "audio") {
      setIsAudioOpen(true);
    }
  };
  const selectedInputChannelValue =
    inputChannelCount > 1 &&
    selectedInputChannel !== "all" &&
    selectedInputChannel <= inputChannelCount
      ? String(selectedInputChannel)
      : "all";
  const allInputsLabel =
    inputChannelCount === 1
      ? "Eingang 1"
      : inputChannelCount === 2
        ? "Eingang 1 + Eingang 2"
        : `Alle ${inputChannelCount} Eingänge`;
  const channelAudioFeedStatusById = useMemo(
    () =>
      new Map(channelAudioFeedStatuses.map((entry) => [entry.id, entry])),
    [channelAudioFeedStatuses],
  );
  const allRoleIds = useMemo(
    () => appData.roles.map((role) => role.id),
    [appData.roles],
  );

  const feedInputChannelCount = (deviceId: string): number => {
    if (!deviceId) return Math.max(1, inputChannelCount);
    const device = inputDevices.find((entry) => entry.deviceId === deviceId);
    return Math.max(
      1,
      resolveInputDeviceChannelCount(
        device as (MediaDeviceInfo & { inputChannels?: unknown }) | undefined,
      ) ?? (deviceId === selectedInputDeviceId ? inputChannelCount : 1),
    );
  };

  const feedInputChannelValueFor = (
    deviceId: string,
    inputChannel: InputChannelSelection,
  ): string => {
    const count = feedInputChannelCount(deviceId);
    return inputChannel !== "all" && inputChannel <= count
      ? String(inputChannel)
      : "all";
  };

  const feedInputChannelValue = (feed: ChannelAudioFeedSettings): string =>
    feedInputChannelValueFor(feed.inputDeviceId, feed.inputChannel);

  const feedAllInputsLabel = (count: number): string =>
    count === 1
      ? "Eingang 1"
      : count === 2
        ? "Eingang 1 + Eingang 2"
        : `Alle ${count} Eingänge`;

  const feedDeviceLabel = (deviceId: string): string => {
    if (!deviceId) return "Standard des Systems";
    return (
      inputDevices.find((entry) => entry.deviceId === deviceId)?.label ||
      `Eingang ${deviceId.slice(0, 6)}`
    );
  };

  const feedRoomLabel = (roomId: string): string => {
    if (!roomId) return "Neuer Sprechkanal";
    return appData.rooms.find((room) => room.id === roomId)?.name || roomId;
  };

  const openChannelAudioFeedEditor = (feed?: ChannelAudioFeedSettings) => {
    setChannelAudioFeedSaveError("");
    if (feed) {
      const room = appData.rooms.find((entry) => entry.id === feed.roomId);
      setChannelAudioFeedEditor({
        mode: "edit",
        feedId: feed.id,
        roomId: feed.roomId,
        name: feed.name,
        priorityLevel: room?.priorityLevel ?? 1,
        inputDeviceId: feed.inputDeviceId,
        inputChannel: feed.inputChannel,
        gain: feed.gain,
        enabled: feed.enabled,
        senderRoleIds: [...(room?.senderRoleIds || [appData.self.roleId])],
        receiverRoleIds: [...(room?.receiverRoleIds || allRoleIds)],
        forcedListenRoleIds: [...(room?.forcedListenRoleIds || [])],
      });
      return;
    }
    setChannelAudioFeedEditor({
      mode: "create",
      name: "",
      priorityLevel: 1,
      inputDeviceId: selectedInputDeviceId,
      inputChannel: selectedInputChannel,
      gain: 1,
      enabled: true,
      senderRoleIds: [appData.self.roleId],
      receiverRoleIds: allRoleIds,
      forcedListenRoleIds: [],
    });
  };

  const updateChannelAudioFeedEditor = (
    patch: Partial<ChannelAudioFeedEditor>,
  ) => {
    setChannelAudioFeedEditor((current) =>
      current ? { ...current, ...patch } : current,
    );
  };

  const toggleChannelAudioFeedEditorRole = (
    key: "senderRoleIds" | "receiverRoleIds" | "forcedListenRoleIds",
    roleId: string,
  ) => {
    setChannelAudioFeedEditor((current) => {
      if (!current) return current;
      const currentIds = current[key];
      const nextIds = currentIds.includes(roleId)
        ? currentIds.filter((id) => id !== roleId)
        : [...currentIds, roleId];
      return { ...current, [key]: nextIds };
    });
  };

  const saveChannelAudioFeedEditor = async () => {
    if (!channelAudioFeedEditor) return;
    const name = channelAudioFeedEditor.name.trim();
    if (!name) {
      setChannelAudioFeedSaveError("Bitte gib dem Feed einen Namen.");
      return;
    }
    const senderRoleIds = Array.from(
      new Set([appData.self.roleId, ...channelAudioFeedEditor.senderRoleIds]),
    ).filter(Boolean);
    if (senderRoleIds.length === 0) {
      setChannelAudioFeedSaveError("Mindestens eine Rolle muss senden dürfen.");
      return;
    }
    if (channelAudioFeedEditor.receiverRoleIds.length === 0) {
      setChannelAudioFeedSaveError("Mindestens eine Rolle muss hören dürfen.");
      return;
    }
    const payload: ChannelAudioFeedRoomForm = {
      name,
      priorityLevel: channelAudioFeedEditor.priorityLevel,
      senderRoleIds,
      receiverRoleIds: channelAudioFeedEditor.receiverRoleIds,
      forcedListenRoleIds: channelAudioFeedEditor.forcedListenRoleIds,
    };
    setChannelAudioFeedSaveError("");
    setChannelAudioFeedSaveBusy(true);
    try {
      if (channelAudioFeedEditor.mode === "edit") {
        const roomId = channelAudioFeedEditor.roomId || "";
        if (roomId) {
          await onUpdateChannelAudioFeedRoom(roomId, payload);
        }
        if (channelAudioFeedEditor.feedId) {
          onUpdateChannelAudioFeed(channelAudioFeedEditor.feedId, {
            name,
            roomId,
            inputDeviceId: channelAudioFeedEditor.inputDeviceId,
            inputChannel: channelAudioFeedEditor.inputChannel,
            gain: channelAudioFeedEditor.gain,
            enabled: channelAudioFeedEditor.enabled,
            ownerRoleId: appData.self.roleId,
          });
        }
      } else {
        const roomId = await onCreateChannelAudioFeedRoom(payload);
        onCreateChannelAudioFeed({
          ownerRoleId: appData.self.roleId,
          name,
          roomId,
          inputDeviceId: channelAudioFeedEditor.inputDeviceId,
          inputChannel: channelAudioFeedEditor.inputChannel,
          gain: channelAudioFeedEditor.gain,
          enabled: channelAudioFeedEditor.enabled,
        });
      }
      setChannelAudioFeedEditor(null);
    } catch (error) {
      setChannelAudioFeedSaveError(
        error instanceof Error ? error.message : "Feed konnte nicht gespeichert werden.",
      );
    } finally {
      setChannelAudioFeedSaveBusy(false);
    }
  };

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        micMenuRef.current &&
        !micMenuRef.current.contains(event.target as Node)
      ) {
        setIsMicMenuOpen(false);
      }
      if (
        outputMenuRef.current &&
        !outputMenuRef.current.contains(event.target as Node)
      ) {
        setIsOutputMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const channelAudioFeedEditorInputCount = channelAudioFeedEditor
    ? feedInputChannelCount(channelAudioFeedEditor.inputDeviceId)
    : 1;
  const channelAudioFeedEditorInputValue = channelAudioFeedEditor
    ? feedInputChannelValueFor(
        channelAudioFeedEditor.inputDeviceId,
        channelAudioFeedEditor.inputChannel,
      )
    : "all";

  const allDirectOnlineTargets = useMemo(() => {
    const directCandidates = presence.filter(
      (p) =>
        p.userId !== appData.self.id && p.username.toLowerCase() !== "admin",
    );
    return sortDirectUsersByRoleAndUsername(directCandidates, roleNameById);
  }, [appData.self.id, presence, roleNameById]);

  const directOnlineTargets = useMemo(
    () =>
      showPinnedOnly
        ? allDirectOnlineTargets.filter((p) => pinnedUserIds.includes(p.userId))
        : allDirectOnlineTargets,
    [allDirectOnlineTargets, pinnedUserIds, showPinnedOnly],
  );

  const directGroups = useMemo(() => {
    if (!enableDirectTabs) return [];

    const groups: Array<{
      tabId: string;
      label: string;
      count: number;
      users: typeof allDirectOnlineTargets;
    }> = [];

    // When tabs are enabled, always use allDirectOnlineTargets (ignore showPinnedOnly)

    // Favorites tab
    const favorites = allDirectOnlineTargets.filter((p) =>
      pinnedUserIds.includes(p.userId),
    );
    groups.push({
      tabId: "favorites",
      label: "Favoriten",
      count: favorites.length,
      users: favorites,
    });

    // Role-based tabs
    const roleGroups = new Map<string, typeof allDirectOnlineTargets>();
    for (const p of allDirectOnlineTargets) {
      if (!roleGroups.has(p.roleId)) {
        roleGroups.set(p.roleId, []);
      }
      roleGroups.get(p.roleId)!.push(p);
    }
    for (const [roleId, users] of roleGroups) {
      const roleLabel = roleNameById.get(roleId) || roleId || "Unbekannt";
      groups.push({
        tabId: roleId,
        label: roleLabel,
        count: users.length,
        users,
      });
    }

    // All tab
    groups.push({
      tabId: "all",
      label: "Alle",
      count: allDirectOnlineTargets.length,
      users: allDirectOnlineTargets,
    });

    return groups;
  }, [enableDirectTabs, allDirectOnlineTargets, pinnedUserIds, roleNameById]);

  const displayedDirectUsers = useMemo(() => {
    if (!enableDirectTabs) return directOnlineTargets;
    const group = directGroups.find((g) => g.tabId === activeDirectTab);
    return group ? group.users : [];
  }, [enableDirectTabs, directGroups, activeDirectTab, directOnlineTargets]);

  // Reset active tab if it no longer exists
  useEffect(() => {
    if (enableDirectTabs && directGroups.length > 0) {
      const tabExists = directGroups.some((g) => g.tabId === activeDirectTab);
      if (!tabExists) {
        setActiveDirectTab("all");
      }
    }
  }, [enableDirectTabs, directGroups, activeDirectTab]);

  const visibleRooms = useMemo(
    () =>
      showPinnedOnly
        ? appData.rooms.filter((room) => pinnedRoomIds.includes(room.id))
        : appData.rooms,
    [appData.rooms, pinnedRoomIds, showPinnedOnly],
  );

  // Embedded (Multiview tile): no page scroll, all party lines fit the window
  const embedMode = useMemo(() => resolveEmbedMode(window.location.search), []);
  const hideTalkControls = useMemo(
    () => embedMode && resolveHideTalkControls(window.location.search),
    [embedMode],
  );
  const talkGridRef = useRef<HTMLDivElement>(null);
  const [talkFit, setTalkFit] = useState<KeyGridFit | null>(null);
  useLayoutEffect(() => {
    const grid = talkGridRef.current;
    if (!embedMode || !grid) return;
    const measure = () => {
      const next = fitKeyGrid(
        visibleRooms.length,
        grid.clientWidth,
        grid.clientHeight,
        EMBED_KEY_GAP,
      );
      setTalkFit((prev) =>
        prev &&
        prev.cols === next.cols &&
        prev.rows === next.rows &&
        Math.abs(prev.keyHeight - next.keyHeight) < 1 &&
        Math.abs(prev.keyWidth - next.keyWidth) < 1
          ? prev
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(grid);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [embedMode, visibleRooms.length, hideTalkControls]);

  // Helper: get max priority for a user based on their active talk rooms and broadcasts
  const getMaxUserChannelPriority = (user: Presence): number | null => {
    let maxPriority: number | null = null;

    // Check talk rooms
    for (const roomId of user.talkRooms) {
      const room = appData.rooms.find((r) => r.id === roomId);
      if (room) {
        const p = room.priorityLevel ?? 1;
        if (maxPriority === null || p > maxPriority) {
          maxPriority = p;
        }
      }
    }

    // Check broadcast active
    if (user.broadcastActive) {
      for (const group of appData.broadcastGroups) {
        // User is broadcast active if they're in the broadcast group or an admin
        const p = group.priorityLevel ?? 1;
        if (maxPriority === null || p > maxPriority) {
          maxPriority = p;
        }
      }
    }

    return maxPriority;
  };

  const streamDeckPageOrder = useMemo(
    () =>
      (streamDeckSettings?.pages || [])
        .map((page) => page.page)
        .sort((a, b) => a - b),
    [streamDeckSettings],
  );

  const streamDeckCurrentPage = useMemo(() => {
    if (!streamDeckSettings || streamDeckSettings.pages.length === 0) {
      return null;
    }
    return (
      streamDeckSettings.pages.find(
        (page) => page.page === streamDeckSettings.selectedPage,
      ) || streamDeckSettings.pages[0]
    );
  }, [streamDeckSettings]);

  const streamDeckCurrentButtons = useMemo(
    () =>
      [...(streamDeckCurrentPage?.buttons || [])].sort(
        (a, b) => a.index - b.index,
      ),
    [streamDeckCurrentPage],
  );

  const streamDeckSelectedButton = useMemo(
    () =>
      streamDeckCurrentButtons.find(
        (button) => button.index === streamDeckSelectedButtonIndex,
      ) || streamDeckCurrentButtons[0] || null,
    [streamDeckCurrentButtons, streamDeckSelectedButtonIndex],
  );
  const streamDeckConfiguredButtonCount = useMemo(
    () =>
      (streamDeckSettings?.pages ?? []).reduce(
        (count, page) =>
          count + page.buttons.filter(isConfiguredStreamDeckButton).length,
        0,
      ),
    [streamDeckSettings],
  );
  const streamDeckConfiguredPageCount = useMemo(
    () =>
      (streamDeckSettings?.pages ?? []).filter(isConfiguredStreamDeckPage)
        .length,
    [streamDeckSettings],
  );
  const streamDeckCurrentPageConfiguredButtonCount = useMemo(
    () => streamDeckCurrentButtons.filter(isConfiguredStreamDeckButton).length,
    [streamDeckCurrentButtons],
  );
  const streamDeckErrorNotice = streamDeckError
    ? {
        tone: "error" as const,
        title: "Stream-Deck-Fehler",
        message: streamDeckError,
      }
    : null;

  const streamDeckTransferNotice = streamDeckTransferError
    ? {
        tone: "error" as const,
        title: "Das hat nicht geklappt",
        message: streamDeckTransferError,
      }
    : streamDeckTransferMessage
      ? {
          tone: "success" as const,
          title: "Erledigt",
          message: streamDeckTransferMessage,
        }
      : null;
  const companionPublishUsername =
    appData.self.username.trim() || "Standardprofil";
  const companionPublishRoleName =
    roleNameById.get(appData.self.roleId) ||
    appData.roles.find((role) => role.id === appData.self.roleId)?.name ||
    appData.self.roleId ||
    "Ohne Rolle";
  const companionPublishPresetPath =
    `Kesher / ${companionPublishRoleName} / ${companionPublishUsername}`;

  const streamDeckLabelLookup = useMemo(
    () => ({
      rooms: appData.rooms,
      roles: appData.roles,
      users: appData.users,
      activeUsers: presence.map((entry) => ({
        id: entry.userId,
        username: entry.username,
        roleId: entry.roleId,
      })),
      broadcastGroups,
    }),
    [appData.rooms, appData.roles, appData.users, broadcastGroups, presence],
  );

  const streamDeckPreviewPressedSet = useMemo(
    () => new Set(streamDeckPreviewPressedIndexes),
    [streamDeckPreviewPressedIndexes],
  );

  const [streamDeckPreviewImageByIndex, setStreamDeckPreviewImageByIndex] =
    useState<Map<number, string>>(new Map());

  const streamDeckPreviewRenderInputs = useMemo(() => {
    if (
      !isUserSettingsOpen ||
      activeSettingsPage !== "streamdeck" ||
      !isStreamDeckOpen
    ) {
      return [];
    }
    const cache = streamDeckPreviewCacheRef.current;
    const listeningRoomIds = new Set(listenRoomIds);
    const selectedTalkRoomIds = new Set(talkRoomIds);
    const visibleButtonIndices = new Set(
      streamDeckCurrentButtons.map((button) => button.index),
    );

    for (const cachedIndex of Array.from(cache.keys())) {
      if (!visibleButtonIndices.has(cachedIndex)) {
        cache.delete(cachedIndex);
      }
    }

    return streamDeckCurrentButtons.map((rawButton) => {
      const resolvedButton = withResolvedStreamDeckButtonLabel(
        rawButton,
        streamDeckLabelLookup,
      );
      const isListening =
        (rawButton.action?.type === "ptt_room" ||
          rawButton.action?.type === "select_talk_room" ||
          rawButton.action?.type === "select_listen_room" ||
          rawButton.action?.type === "listen_room") &&
        !!rawButton.action.roomId &&
        listeningRoomIds.has(rawButton.action.roomId);
      const isPttSelected =
        (rawButton.action?.type === "select_talk_room" ||
          rawButton.action?.type === "select_listen_room") &&
        !!rawButton.action.roomId &&
        selectedTalkRoomIds.has(rawButton.action.roomId);
      const button = {
        ...resolvedButton,
        isListening,
        isPttSelected,
      };
      const pressed = streamDeckPreviewPressedSet.has(rawButton.index);
      const signature = streamDeckPreviewSignature(button, pressed);
      const labels = splitStreamDeckLabel(resolvedButton.label);
      let previewState: "IDLE" | "TALK" | "LISTEN" | "BROADCAST" | "PI_ONLINE" | "PI_OFFLINE" = pressed
        ? rawButton.action?.type === "broadcast_ptt"
          ? "BROADCAST"
          : "TALK"
        : isListening
          ? "LISTEN"
          : "IDLE";

      if (rawButton.action?.type === "raspberry_status" && rawButton.action.raspberryPiId) {
        const piId = rawButton.action.raspberryPiId;
        // Match by name OR deviceId — the dropdown stores pi.name as value,
        // but the backend also accepts deviceId.
        const pi = raspberryPis.find(
          (p) => p.name === piId || p.deviceId === piId
        );
        if (pi) {
          const isOnline = ["intercom_connected", "waiting_for_intercom", "launcher_online"].includes(pi.effectiveStatus);
          previewState = isOnline ? "PI_ONLINE" : "PI_OFFLINE";
          labels.primary = pi.name || pi.deviceId;
          labels.subtitle = isOnline ? "Verbunden" : "Getrennt";
        } else {
          labels.primary = piId;
          labels.subtitle = raspberryPis.length === 0 ? "Lädt …" : "Nicht gefunden";
        }
      }

      return {
        buttonIndex: rawButton.index,
        signature,
        payload: {
          buttonIndex: rawButton.index,
          label: labels.primary,
          subtitle: labels.subtitle,
          actionType: rawButton.action?.type,
          color: rawButton.color,
          state: previewState,
          channel:
            rawButton.action?.roomId ||
            rawButton.action?.broadcastGroupId ||
            rawButton.action?.roleId ||
            rawButton.action?.userId ||
            "",
          isListening,
          isPttSelected,
          isActive: pressed,
        },
      };
    });
  }, [
    activeSettingsPage,
    isStreamDeckOpen,
    isUserSettingsOpen,
    listenRoomIds,
    talkRoomIds,
    streamDeckLabelLookup,
    streamDeckCurrentButtons,
    streamDeckPreviewPressedSet,
    raspberryPis,
  ]);

  useEffect(() => {
    const cache = streamDeckPreviewCacheRef.current;
    const initial = new Map<number, string>();
    const missingPayload: Array<{
      buttonIndex: number;
      label?: string;
      subtitle?: string;
      actionType?: StreamDeckActionType;
      color?: string;
      state?: "IDLE" | "TALK" | "LISTEN" | "BROADCAST" | "PI_ONLINE" | "PI_OFFLINE";
      channel?: string;
      isListening?: boolean;
      isPttSelected?: boolean;
      isActive?: boolean;
    }> = [];

    for (const item of streamDeckPreviewRenderInputs) {
      const cached = cache.get(item.buttonIndex);
      if (cached && cached.signature === item.signature) {
        initial.set(item.buttonIndex, cached.dataUrl);
      } else {
        missingPayload.push(item.payload);
      }
    }

    setStreamDeckPreviewImageByIndex(initial);

    if (missingPayload.length === 0) {
      return;
    }

    const abortController = new AbortController();

    void (async () => {
      try {
        const renderedByIndex = await renderStreamDeckPreviewImages(
          token,
          {
            width: 112,
            height: 112,
            buttons: missingPayload,
          },
          abortController.signal,
        );
        if (abortController.signal.aborted) {
          return;
        }

        for (const item of streamDeckPreviewRenderInputs) {
          const image = renderedByIndex.get(item.buttonIndex);
          if (!image) continue;
          cache.set(item.buttonIndex, {
            signature: item.signature,
            dataUrl: image,
          });
        }

        const nextMap = new Map<number, string>();
        for (const item of streamDeckPreviewRenderInputs) {
          const cached = cache.get(item.buttonIndex);
          if (!cached || cached.signature !== item.signature) continue;
          nextMap.set(item.buttonIndex, cached.dataUrl);
        }
        setStreamDeckPreviewImageByIndex(nextMap);
      } catch {
        if (abortController.signal.aborted) {
          return;
        }
      }
    })();

    return () => {
      abortController.abort();
    };
  }, [streamDeckPreviewRenderInputs, token]);

  const startStreamDeckPreviewPress = (buttonIndex: number) => {
    if (!streamDeckSettings || !streamDeckTestMode) return;
    setStreamDeckPreviewPressedIndexes((prev) =>
      prev.includes(buttonIndex) ? prev : [...prev, buttonIndex],
    );
    onStreamDeckTestButtonEvent({
      page: streamDeckSettings.selectedPage,
      buttonIndex,
      state: "down",
    });
  };

  const stopStreamDeckPreviewPress = (buttonIndex: number) => {
    if (!streamDeckSettings || !streamDeckTestMode) return;
    setStreamDeckPreviewPressedIndexes((prev) => {
      if (!prev.includes(buttonIndex)) return prev;
      return prev.filter((index) => index !== buttonIndex);
    });
    onStreamDeckTestButtonEvent({
      page: streamDeckSettings.selectedPage,
      buttonIndex,
      state: "up",
    });
  };

  useEffect(() => {
    if (streamDeckTestMode) return;
    setStreamDeckPreviewPressedIndexes([]);
  }, [streamDeckTestMode]);

  const applyStreamDeckSettings = (
    nextSettings: StreamDeckSettings,
    options?: {
      recordUndo?: boolean;
      message?: string;
      error?: string;
    },
  ) => {
    if (streamDeckSettings && options?.recordUndo !== false) {
      setStreamDeckUndoStack((prev) => [
        ...prev.slice(-24),
        cloneStreamDeckSettings(streamDeckSettings),
      ]);
    }
    onStreamDeckSettingsChange(nextSettings);
    if (options?.error !== undefined) {
      setStreamDeckTransferError(options.error);
    }
    if (options?.message !== undefined) {
      setStreamDeckTransferMessage(options.message);
    }
  };

  const undoLastStreamDeckChange = () => {
    const previousSettings = streamDeckUndoStack[streamDeckUndoStack.length - 1];
    if (!previousSettings) {
      return;
    }
    setStreamDeckUndoStack((prev) => prev.slice(0, -1));
    onStreamDeckSettingsChange(cloneStreamDeckSettings(previousSettings));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage("Letzte Änderung rückgängig gemacht.");
  };

  useEffect(() => {
    if (!streamDeckCurrentButtons.length) return;
    const exists = streamDeckCurrentButtons.some(
      (button) => button.index === streamDeckSelectedButtonIndex,
    );
    if (!exists) {
      setStreamDeckSelectedButtonIndex(streamDeckCurrentButtons[0].index);
    }
  }, [streamDeckCurrentButtons, streamDeckSelectedButtonIndex]);

  const updateStreamDeckSelectedButton = (
    updater: (button: NonNullable<typeof streamDeckSelectedButton>) => {
      index: number;
      label?: string;
      color?: string;
      action?: {
        type: StreamDeckActionType;
        roomId?: string;
        userId?: string;
        roleId?: string;
        broadcastGroupId?: string;
        volumeDelta?: number;
        targetPage?: number;
        message?: string;
      };
    },
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage || !streamDeckSelectedButton) {
      return;
    }
    const nextSelected = updater(streamDeckSelectedButton);
    const nextButtons = streamDeckCurrentPage.buttons.map((button) =>
      button.index === streamDeckSelectedButton.index ? nextSelected : button,
    );
    applyStreamDeckSettings({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page !== streamDeckCurrentPage.page
          ? page
          : {
              ...page,
              buttons: nextButtons,
            },
      ),
    });
  };

  const updateStreamDeckCurrentPageButtons = (
    updater: (buttons: StreamDeckButtonConfig[]) => StreamDeckButtonConfig[],
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage) {
      return;
    }
    const nextButtons = updater(streamDeckCurrentPage.buttons);
    applyStreamDeckSettings({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page !== streamDeckCurrentPage.page
          ? page
          : {
              ...page,
              buttons: nextButtons,
            },
      ),
    });
  };

  const copySelectedStreamDeckButton = () => {
    if (!streamDeckSelectedButton) {
      return;
    }
    setStreamDeckClipboardButton(cloneStreamDeckButtonConfig(streamDeckSelectedButton));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Taste ${streamDeckSelectedButton.index + 1} kopiert.`,
    );
  };

  const pasteIntoSelectedStreamDeckButton = () => {
    if (!streamDeckClipboardButton || !streamDeckSelectedButton) {
      return;
    }
    updateStreamDeckSelectedButton((button) => ({
      ...cloneStreamDeckButtonConfig(streamDeckClipboardButton),
      index: button.index,
    }));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `In Taste ${streamDeckSelectedButton.index + 1} eingefügt.`,
    );
  };

  const clearSelectedStreamDeckButton = () => {
    if (!streamDeckSelectedButton) {
      return;
    }
    updateStreamDeckSelectedButton((button) => ({ index: button.index }));
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Taste ${streamDeckSelectedButton.index + 1} geleert.`,
    );
  };

  const swapStreamDeckButtons = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) {
      return;
    }
    updateStreamDeckCurrentPageButtons((buttons) => {
      const source = buttons.find((button) => button.index === fromIndex);
      const target = buttons.find((button) => button.index === toIndex);
      if (!source || !target) {
        return buttons;
      }
      const sourceClone = cloneStreamDeckButtonConfig(source);
      const targetClone = cloneStreamDeckButtonConfig(target);
      return buttons.map((button) => {
        if (button.index === fromIndex) {
          return { ...targetClone, index: fromIndex };
        }
        if (button.index === toIndex) {
          return { ...sourceClone, index: toIndex };
        }
        return button;
      });
    });
    setStreamDeckSelectedButtonIndex(toIndex);
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage(
      `Taste ${fromIndex + 1} nach ${toIndex + 1} verschoben.`,
    );
  };

  const handleStreamDeckButtonDragStart = (buttonIndex: number) => {
    setStreamDeckDragSourceIndex(buttonIndex);
    setStreamDeckDropTargetIndex(buttonIndex);
    setStreamDeckSelectedButtonIndex(buttonIndex);
  };

  const handleStreamDeckButtonDrop = (buttonIndex: number) => {
    if (streamDeckDragSourceIndex === null) {
      return;
    }
    swapStreamDeckButtons(streamDeckDragSourceIndex, buttonIndex);
    setStreamDeckDragSourceIndex(null);
    setStreamDeckDropTargetIndex(null);
  };

  const resetStreamDeckDragState = () => {
    setStreamDeckDragSourceIndex(null);
    setStreamDeckDropTargetIndex(null);
  };

  const setStreamDeckActionType = (type: StreamDeckActionType) => {
    updateStreamDeckSelectedButton((button) => {
      if (type === "none") {
        return { ...button, action: undefined };
      }
      if (type === "page_home" || type === "page_jump") {
        const pageOrder = (streamDeckSettings?.pages ?? [])
          .map((page) => page.page)
          .sort((a, b) => a - b);
        const homePage = pageOrder[0] ?? 0;
        const defaultTargetPage =
          button.action?.type === "page_jump" && button.action.targetPage !== undefined
            ? button.action.targetPage
            : homePage;
        return {
          ...button,
          action: {
            type,
            targetPage: type === "page_home" ? homePage : defaultTargetPage,
          },
        };
      }
      if (
        type === "ptt_room" ||
        type === "select_talk_room" ||
        type === "select_listen_room" ||
        type === "listen_room" ||
        type === "call_room"
      ) {
        return {
          ...button,
          action: {
            type,
            roomId:
              button.action?.type === "ptt_room" ||
              button.action?.type === "select_talk_room" ||
              button.action?.type === "select_listen_room" ||
              button.action?.type === "listen_room" ||
              button.action?.type === "call_room"
                ? button.action.roomId
                : appData.rooms[0]?.id,
          },
        };
      }
      if (type === "direct_user") {
        return {
          ...button,
          action: {
            type,
            userId:
              button.action?.type === "direct_user"
                ? button.action.userId
                : appData.users[0]?.id,
          },
        };
      }
      if (type === "direct_role") {
        return {
          ...button,
          action: {
            type,
            roleId:
              button.action?.type === "direct_role"
                ? button.action.roleId
                : appData.roles[0]?.id,
          },
        };
      }
      if (type === "broadcast_ptt") {
        return {
          ...button,
          action: {
            type,
            broadcastGroupId:
              button.action?.type === "broadcast_ptt"
                ? button.action.broadcastGroupId
                : broadcastGroups[0]?.id,
          },
        };
      }
      if (type === "volume_delta") {
        return {
          ...button,
          action: {
            type,
            volumeDelta:
              button.action?.type === "volume_delta"
                ? button.action.volumeDelta || 1
                : 1,
          },
        };
      }
      if (type === "chat_message") {
        const previous =
          button.action?.type === "chat_message" ? button.action : undefined;
        return {
          ...button,
          action: {
            type,
            message: previous?.message ?? "",
            roomId: previous?.roomId,
          },
        };
      }
      return { ...button, action: { type } };
    });
  };

  const updateStreamDeckCurrentPageMeta = (
    updater: (page: NonNullable<typeof streamDeckCurrentPage>) => {
      page: number;
      title?: string;
      pageType?: StreamDeckPageType;
      parentPage?: number;
      buttons: StreamDeckButtonConfig[];
    },
  ) => {
    if (!streamDeckSettings || !streamDeckCurrentPage) {
      return;
    }
    const nextPage = updater(streamDeckCurrentPage);
    applyStreamDeckSettings({
      ...streamDeckSettings,
      pages: streamDeckSettings.pages.map((page) =>
        page.page === streamDeckCurrentPage.page ? nextPage : page,
      ),
    });
  };

  const goToStreamDeckPage = (direction: -1 | 1) => {
    if (!streamDeckSettings) return;
    const nextPage = Math.max(0, streamDeckSettings.selectedPage + direction);
    if (nextPage === streamDeckSettings.selectedPage) {
      return;
    }
    const pageExists = streamDeckSettings.pages.some(
      (page) => page.page === nextPage,
    );
    applyStreamDeckSettings({
      ...streamDeckSettings,
      selectedPage: nextPage,
      pages: [
        ...streamDeckSettings.pages,
        ...(pageExists ? [] : [createEmptyStreamDeckPage(streamDeckSettings, nextPage)]),
      ].sort((a, b) => a.page - b.page),
    });
  };

  const exportStreamDeckSettings = () => {
    if (!streamDeckSettings) {
      return;
    }
    const nowIso = new Date().toISOString();
    const settings = compactStreamDeckSettings(streamDeckSettings);
    const payload = {
      meta: {
        format: STREAM_DECK_IMPORT_FORMAT,
        schemaVersion: STREAM_DECK_IMPORT_SCHEMA_VERSION,
        exportedAt: nowIso,
        username: appData.self.username,
      },
      settings,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = window.URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    const username = appData.self.username.replace(/[^a-zA-Z0-9_-]/g, "_");
    anchor.href = url;
    anchor.download = `kesher-streamdeck-${username}-${nowIso.replace(/[:]/g, "-")}.json`;
    window.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.URL.revokeObjectURL(url);
    setStreamDeckTransferError("");
    setStreamDeckTransferMessage("Stream-Deck-Profil exportiert.");
  };

  const saveStreamDeckSettings = async () => {
    if (!streamDeckSettings) {
      return;
    }
    setStreamDeckSaveBusy(true);
    setStreamDeckTransferMessage("");
    setStreamDeckTransferError("");
    try {
      await onSaveStreamDeckSettings(compactStreamDeckSettings(streamDeckSettings));
      setStreamDeckTransferMessage("Stream-Deck-Profil gespeichert.");
    } catch (error) {
      setStreamDeckTransferError(
        error instanceof Error ? error.message : "Speichern fehlgeschlagen.",
      );
    } finally {
      setStreamDeckSaveBusy(false);
    }
  };

  const openStreamDeckImportPicker = () => {
    streamDeckImportInputRef.current?.click();
  };

  const importStreamDeckSettingsFromFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const nextSettings = parseStreamDeckImportDocument(text);
      applyStreamDeckSettings(nextSettings, {
        message: `${file.name} loaded. Click Save to persist it to your account.`,
        error: "",
      });
    } catch (error) {
      setStreamDeckTransferMessage("");
      setStreamDeckTransferError(
        error instanceof Error ? error.message : "Import fehlgeschlagen.",
      );
    } finally {
      event.target.value = "";
    }
  };

  const publishCompanionProfile = async () => {
    setCompanionPublishBusy(true);
    setStreamDeckSaveBusy(true);
    setStreamDeckTransferMessage("");
    setStreamDeckTransferError("");
    try {
      const settingsToPublish = streamDeckSettings
        ? compactStreamDeckSettings(streamDeckSettings)
        : undefined;
      const published = await onPublishCompanionProfile(settingsToPublish);
      setStreamDeckTransferError("");
      setStreamDeckTransferMessage(
        `Gespeichert und an Companion gesendet (Version ${published.profileVersion}, Rolle ${published.roleId}).`,
      );
    } catch (error) {
      setStreamDeckTransferMessage("");
      setStreamDeckTransferError(
        error instanceof Error ? error.message : "Senden an Companion fehlgeschlagen.",
      );
    } finally {
      setStreamDeckSaveBusy(false);
      setCompanionPublishBusy(false);
    }
  };

  const openCompanionPublishConfirm = () => {
    if (!streamDeckSettings || streamDeckBusy || companionPublishBusy) {
      return;
    }
    setStreamDeckTransferMessage("");
    setStreamDeckTransferError("");
    setIsCompanionPublishConfirmOpen(true);
  };

  const confirmCompanionPublish = async () => {
    setIsCompanionPublishConfirmOpen(false);
    await publishCompanionProfile();
  };

  const replyTarget =
    allDirectOnlineTargets.find((p) => p.userId === lastDirectCallerUserId) ||
    null;
  const replyTargetUserId = lastDirectCallerUserId;

  // Is user actively sending audio on their main talk rooms?
  // Not when direct PTT or broadcast PTT is active (audio goes there instead).
  const isSendingOnTalkRooms =
    (pttPressed || voiceMode === "always_on") &&
    !directPttPressedUserId &&
    !broadcastPttPressed;
  const mainPttButtonProps = createHoldButtonProps<HTMLButtonElement>({
    onStart: startPtt,
    onStop: stopPtt,
  });
  const replyButtonProps = createHoldButtonProps<HTMLButtonElement>({
    disabled: !replyTargetUserId,
    onStart: () => {
      if (replyTargetUserId) {
        startDirectPtt(replyTargetUserId);
      }
    },
    onStop: () => {
      if (replyTargetUserId) {
        stopDirectPtt(replyTargetUserId);
      }
    },
  });
  const talkTargetNames = visibleRooms
    .filter(
      (room) =>
        talkRoomIds.includes(room.id) &&
        canRoleSendToRoom(room.id, appData.self.roleId),
    )
    .map((room) => room.name);
  const mainPttButton = (
    <button
      key="ptt"
      className={`station-ptt hold-button ${pttPressed ? "active" : ""} ${
        isSendingOnTalkRooms && talkTargetNames.length > 0 ? "live" : ""
      }`}
      aria-label="Gedrückt halten zum Sprechen"
      {...mainPttButtonProps}
    >
      <strong>Gedrückt halten zum Sprechen</strong>
      <small>
        {talkTargetNames.length > 0
          ? `Sendet auf: ${talkTargetNames.join(", ")}`
          : "Keine Party Line vorgemerkt"}
      </small>
    </button>
  );
  const replyButton = (
    <button
      key="reply"
      className={`station-reply hold-button ${replyTargetUserId ? "has-caller" : "disabled"} ${
        replyTargetUserId && directPttPressedUserId === replyTargetUserId
          ? "active"
          : ""
      }`}
      disabled={!replyTargetUserId}
      {...replyButtonProps}
    >
      <strong>Anrufer antworten</strong>
      <small>
        {replyTarget
          ? replyTarget.username
          : replyTargetUserId
            ? "Letzter Anrufer"
            : "Kein aktiver Anrufer"}
      </small>
    </button>
  );
  const footerButtons = swapPttAndReplyButtons
    ? [mainPttButton, replyButton]
    : [replyButton, mainPttButton];
  const renderDirectCard = (p: Presence) => {
    const isPinned = pinnedUserIds.includes(p.userId);
    const isTalking = directPttPressedUserId === p.userId;
    const maxPriority = getMaxUserChannelPriority(p);
    const priorityLabels: Record<number, string> = { 0: "L", 2: "H", 3: "C" };
    return (
      <article
        key={`station-direct-${p.userId}`}
        className="station-card station-direct-card"
        data-talk={isTalking ? "live" : "off"}
        data-rx={isReceivingDirect(p.userId) ? "true" : "false"}
      >
        <div className="station-key-top">
          <span className="station-key-top-spacer" />
          {maxPriority !== null && maxPriority !== 1 ? (
            <span className={`priority-badge priority-${maxPriority}`} title="Priorität">
              {priorityLabels[maxPriority] || "?"}
            </span>
          ) : null}
          {isReceivingDirect(p.userId) ? (
            <span className="station-receiving-badge">RX</span>
          ) : null}
          <button
            type="button"
            className={`station-pin-top ${isPinned ? "active" : ""}`}
            aria-pressed={isPinned}
            onPointerDown={(event) => event.stopPropagation()}
            onPointerUp={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onTogglePinnedUser(p.userId);
            }}
            title={isPinned ? "Aus Favoriten entfernen" : "Zu Favoriten hinzufügen"}
          >
            ★
          </button>
        </div>
        <button
          className={`station-card-head direct-ptt hold-button ${isTalking ? "active" : ""}`}
          {...createHoldButtonProps<HTMLButtonElement>({
            onStart: () => startDirectPtt(p.userId),
            onStop: () => stopDirectPtt(p.userId),
          })}
        >
          <span className="station-direct-avatar" aria-hidden="true">
            {p.username.slice(0, 2).toUpperCase()}
          </span>
          <small>Direkt</small>
          <strong>{p.username}</strong>
          <em>{roleNameById.get(p.roleId) || p.roleId || "Unbekannte Rolle"}</em>
        </button>
        {showVolumeControls ? (
          <div className="station-gain-control">
            <label htmlFor={`direct-gain-${p.userId}`}>
              {gainToDbLabel(directGainByUserId[p.userId] ?? 1)}
            </label>
            <input
              id={`direct-gain-${p.userId}`}
              type="range"
              min={MUTE_POS}
              max={OUTPUT_DB_MAX}
              step={1}
              value={gainToSlider(directGainByUserId[p.userId] ?? 1)}
              style={
                {
                  "--fill": `${sliderFillPercent(directGainByUserId[p.userId] ?? 1)}%`,
                } as React.CSSProperties
              }
              onPointerDown={(event) => event.stopPropagation()}
              onPointerUp={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) =>
                onDirectGainChange(
                  p.userId,
                  sliderToGain(Number(event.currentTarget.value)),
                )
              }
            />
          </div>
        ) : null}
        <div className="station-card-actions single">
          <button
            className="call"
            onClick={() => sendScopedSignal("direct", p.userId, "call")}
            title="Person rufen"
          >
            Rufen
          </button>
        </div>
      </article>
    );
  };
  // Embedded: no chat column – the Multiview has its own chat tiles
  const hasChatAndSignalPanel = Boolean(chatAndSignalPanel) && !embedMode;
  const stationRoleLabel =
    remoteControl?.roleName ||
    roleNameById.get(appData.self.roleId) ||
    appData.self.roleId;
  const stationLiveLabel = remoteControl
    ? `Raspberry fernsteuern: ${remoteControl.stationName}`
    : appData.self.username;
  const micLevelPercent = lowPowerMode ? 0 : meterDbFsToPercent(inputLevelDbFs);
  // Sidebar frame like JMS Control – never for the Raspberry remote session or embedded tiles
  const inShell = Boolean(shell) && !remoteControl && !embedMode;
  const liveConnected = connectionState === "connected";
  const liveBadge = (
    <span
      className={`station-live-name ${liveConnected ? "connected" : "disconnected"}`}
      title={embedMode ? `${stationRoleLabel || "Admin"} · ${liveConnected ? "Verbunden" : "Offline"}` : undefined}
    >
      <span
        className={`station-live-dot ${liveConnected ? "connected" : "disconnected"}`}
        aria-hidden="true"
      />
      {embedMode ? (
        <span className="station-role-name">{stationRoleLabel || "Admin"}</span>
      ) : liveConnected ? "Live" : "Offline"}
    </span>
  );
  const micStats = !lowPowerMode ? (
    <div className="station-top-stats">
      <span className="station-top-stat-label">Mikrofon</span>
      <StationMicMeter levelPercent={micLevelPercent} />
    </div>
  ) : null;

  const stationView = (
    <div
      className={`root app station-shell ${
        lowPowerMode && isUserSettingsOpen ? "settings-open-low-power" : ""
      } ${remoteControl ? "station-shell-remote" : ""} ${
        embedMode ? "station-embed" : ""
      } ${inShell ? "station-in-shell" : ""}`.trim()}
    >
      {connectionState !== "connected" && (
        <div className="connection-offline-banner">
          <span className="connection-offline-icon" />
          {connectionState === "reconnecting"
            ? "Verbindung wird wiederhergestellt …"
            : connectionState === "connecting"
              ? "Verbinde …"
              : "Offline"}
        </div>
      )}
      <div className="station-header">
        {inShell ? null : (
        <div
          className={`station-topbar ${lowPowerMode ? "has-low-power" : ""}`.trim()}
        >
          <div className="station-live">
            <BrandLogo className="station-brand-logo" />
            <span className="station-live-sep" aria-hidden="true" />
            <div className="station-live-copy">
              <div className="station-live-role">{stationRoleLabel}</div>
              <div className="station-live-label">{stationLiveLabel}</div>
            </div>
            {liveBadge}
          </div>
          {micStats}
          {lowPowerMode ? (
            <LowPowerModeBadge className="station-low-power-badge" />
          ) : null}
          <div className="station-top-actions">
            <button
              type="button"
              className="station-top-admin"
              aria-label="Einstellungen"
              title="Einstellungen"
              onClick={() => setIsUserSettingsOpen(true)}
            >
              <SettingsIcon name="settings" className="station-top-admin-icon" />
              <span>Einstellungen</span>
            </button>
            <button
              type="button"
              className="station-top-logout"
              aria-label={remoteControl ? "Remote verlassen" : "Abmelden"}
              title={remoteControl ? "Remote verlassen" : "Abmelden"}
              onClick={remoteControl ? remoteControl.onLeave : doLogout}
            >
              <LogoutIcon className="station-top-logout-icon" />
              <span className="station-top-logout-label">
                {remoteControl ? "Remote verlassen" : "Abmelden"}
              </span>
            </button>
          </div>
        </div>
        )}

        {hideTalkControls ? null : (
        <section
          className={`station-controls ${
            isUserSettingsOpen ? "station-controls-hidden-mobile" : ""
          }`}
        >
          {footerButtons}
          <button
            type="button"
            role="switch"
            aria-checked={voiceMode === "always_on"}
            className={`station-always-on ${voiceMode === "always_on" ? "active" : ""}`}
            onClick={() => setAlwaysOn(voiceMode !== "always_on")}
          >
            <span className="station-always-on-indicator" aria-hidden="true" />
            <span className="station-always-on-text">Dauerhaft an</span>
          </button>
        </section>
        )}
      </div>

      <div
        className="station-content-grid"
        hidden={inShell && isUserSettingsOpen}
        ref={contentGridRef}
        style={
          sideWidth
            ? ({ "--station-side-w": `${sideWidth}px` } as React.CSSProperties)
            : undefined
        }
      >
        <div className="station-primary-column">
          <section className="station-block station-talk-section">
            <StationSectionHeader
              tone="talk"
              title="Party Lines"
              hint={
                enableDirectPpt
                  ? "Gedrückt halten = auf der Leitung sprechen"
                  : "Tippen = zum Sprechen vormerken · gedrückt halten oder „Dauerhaft an“ = senden"
              }
              count={`${visibleRooms.length} ${
                visibleRooms.length === 1 ? "Leitung" : "Leitungen"
              }`}
            />
            {visibleRooms.length === 0 ? (
              <p className="station-empty">Keine Party Lines vorhanden.</p>
            ) : null}
            <div
              className={`station-talk-grid ${
                embedMode && talkFit && talkFit.keyHeight < 112 ? "station-keys-tight" : ""
              } ${
                embedMode && talkFit && talkFit.keyHeight < 72 ? "station-keys-tiny" : ""
              }`.trim()}
              ref={talkGridRef}
              style={embedMode ? embedKeyGridStyle(talkFit) : undefined}
            >
              {visibleRooms.map((room) => {
                const listening = listenRoomIds.includes(room.id);
                const talking = talkRoomIds.includes(room.id);
                const canTalk = canRoleSendToRoom(room.id, appData.self.roleId);
                const canListen = canRoleReceiveFromRoom(
                  room.id,
                  appData.self.roleId,
                );
                const isForced = (room.forcedListenRoleIds ?? []).includes(
                  appData.self.roleId,
                );
                const isPttPressed =
                  enableDirectPpt && pptPressedChannelId === room.id;

                const handleTalkPointerDown = () => {
                  if (enableDirectPpt) {
                    onChannelPptStart(room.id);
                  }
                };

                const handleTalkPointerUp = () => {
                  if (enableDirectPpt) {
                    onChannelPptStop(room.id);
                  }
                };
                const talkButtonHoldProps =
                  canTalk && enableDirectPpt
                    ? createHoldButtonProps<HTMLButtonElement>({
                        onStart: handleTalkPointerDown,
                        onStop: handleTalkPointerUp,
                      })
                    : {};

                const listenerCount = roomListenerCounts[room.id] ?? 0;
                const remoteRoomLevel = roomLevelById[room.id] ?? 0;
                const selfSendingToRoom =
                  canTalk &&
                  ((enableDirectPpt && isPttPressed) ||
                    (talking && isSendingOnTalkRooms));
                const selfRoomLevel =
                  !lowPowerMode && selfSendingToRoom
                    ? meterDbFsToPercent(inputLevelDbFs) / 100
                    : 0;
                const lowPowerRoomLevel =
                  lowPowerMode && isReceivingRoom(room.id) ? 0.42 : 0;
                const roomLevel = Math.max(
                  remoteRoomLevel,
                  selfRoomLevel,
                  lowPowerRoomLevel,
                );
                const talkButtonClassName = `station-card-head ${
                  enableDirectPpt ? "hold-button " : ""
                }${
                  enableDirectPpt
                    ? isPttPressed && canTalk
                      ? "ppt-active"
                      : ""
                    : ""
                } ${canTalk ? "" : "disabled"}${
                  !enableDirectPpt && talking && canTalk ? " talk-armed" : ""
                }${
                  !enableDirectPpt && talking && canTalk && isSendingOnTalkRooms
                    ? " talk-live"
                    : ""
                }`;

                const talkState =
                  canTalk &&
                  ((enableDirectPpt && isPttPressed) ||
                    (!enableDirectPpt && talking && isSendingOnTalkRooms))
                    ? "live"
                    : !enableDirectPpt && talking && canTalk
                      ? "armed"
                      : "off";
                const listenState = isForced
                  ? "locked"
                  : listening && canListen
                    ? "on"
                    : "off";
                const roomPriority = room.priorityLevel ?? 1;
                const priorityLabels: Record<number, string> = {
                  0: "L",
                  2: "H",
                  3: "C",
                };

                return (
                  <article
                    key={`station-room-${room.id}`}
                    className="station-card station-room-card"
                    data-talk={talkState}
                    data-listen={listenState}
                    data-can-talk={canTalk ? "true" : "false"}
                    data-rx={isReceivingRoom(room.id) ? "true" : "false"}
                  >
                    <div className="station-key-top">
                      <div className="station-level-indicator">
                        <span
                          className="station-channel-meter"
                          role="meter"
                          aria-label={`${room.name} Pegel`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(roomLevel * 100)}
                        >
                          {Array.from({ length: 10 }, (_, index) => {
                            const segmentNumber = index + 1;
                            const activeSegments = Math.round(roomLevel * 10);
                            const band =
                              segmentNumber >= 9
                                ? "peak"
                                : segmentNumber >= 7
                                  ? "warning"
                                  : "signal";
                            return (
                              <span
                                key={segmentNumber}
                                className={`station-channel-meter-segment ${band} ${
                                  segmentNumber <= activeSegments ? "active" : ""
                                }`}
                              />
                            );
                          })}
                        </span>
                      </div>
                      {roomPriority !== 1 ? (
                        <span
                          className={`priority-badge priority-${roomPriority}`}
                          title="Priorität"
                        >
                          {priorityLabels[roomPriority] || "?"}
                        </span>
                      ) : null}
                      {isReceivingRoom(room.id) ? (
                        <span className="station-receiving-badge">RX</span>
                      ) : null}
                    </div>
                    <button
                      className={talkButtonClassName}
                      {...talkButtonHoldProps}
                      onClick={
                        !enableDirectPpt && canTalk
                          ? () => toggleTalkRoom(room.id)
                          : undefined
                      }
                      disabled={!canTalk}
                      title={
                        canTalk
                          ? ""
                          : "Deine Rolle darf auf dieser Party Line nicht sprechen"
                      }
                    >
                      <small>{canTalk ? "Sprechen" : "Nur hören"}</small>
                      <strong>{renderBreakableChannelName(room.name)}</strong>
                      {listenerCount > 0 ? (
                        <span
                          className="station-presence-badge"
                          title={`${listenerCount} Hörer`}
                        >
                          <span className="station-presence-dot" />
                          {listenerCount}
                        </span>
                      ) : null}
                    </button>
                    {showVolumeControls ? (
                      <div className="station-gain-control">
                        <label htmlFor={`room-gain-${room.id}`}>
                          {gainToDbLabel(roomGainById[room.id] ?? 1)}
                        </label>
                        <input
                          id={`room-gain-${room.id}`}
                          type="range"
                          min={MUTE_POS}
                          max={OUTPUT_DB_MAX}
                          step={1}
                          value={gainToSlider(roomGainById[room.id] ?? 1)}
                          style={
                            {
                              "--fill": `${sliderFillPercent(roomGainById[room.id] ?? 1)}%`,
                            } as React.CSSProperties
                          }
                          onPointerDown={(event) => event.stopPropagation()}
                          onPointerUp={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onChange={(event) =>
                            onRoomGainChange(
                              room.id,
                              sliderToGain(Number(event.currentTarget.value)),
                            )
                          }
                        />
                      </div>
                    ) : null}
                    <div className="station-card-actions">
                      <button
                        className={`listen ${listening && canListen ? "on" : ""} ${canListen ? "" : "disabled"} ${isForced ? "forced" : ""}`}
                        onClick={() => toggleListenRoom(room.id)}
                        disabled={!canListen || isForced}
                        title={
                          isForced
                            ? "Feste Hörer-Zuweisung – kann nicht abgewählt werden"
                            : canListen
                              ? ""
                              : "Deine Rolle darf diese Party Line nicht hören"
                        }
                      >
                        {isForced ? (
                          <LockIcon className="station-listen-lock" />
                        ) : (
                          <span className="station-listen-led" aria-hidden="true" />
                        )}
                        Hören
                      </button>
                      <button
                        className={`call ${canTalk ? "" : "disabled"}`}
                        onClick={() =>
                          sendScopedSignal("room", room.id, "call")
                        }
                        disabled={!canTalk}
                        title={
                          canTalk
                            ? ""
                            : "Deine Rolle darf auf dieser Party Line nicht rufen"
                        }
                      >
                        Rufen
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          {embedMode ? null : (
          <section className="station-block station-direct-section">
            <StationSectionHeader
              tone="direct"
              title="Direkt"
              hint="Gedrückt halten = direkt mit der Person sprechen"
              count={`${
                enableDirectTabs
                  ? allDirectOnlineTargets.length
                  : directOnlineTargets.length
              } online`}
            />
            {enableDirectTabs && directGroups.length > 0 ? (
              <>
                <div
                  className="station-direct-tabs"
                  role="tablist"
                  aria-label="Direkt-Gruppen"
                >
                  {directGroups.map((group) => (
                    <button
                      key={`direct-tab-${group.tabId}`}
                      role="tab"
                      className={`station-direct-tab ${activeDirectTab === group.tabId ? "active" : ""}`}
                      aria-selected={activeDirectTab === group.tabId}
                      onClick={() => setActiveDirectTab(group.tabId)}
                    >
                      <span>{group.label}</span>
                      <small>{group.count}</small>
                    </button>
                  ))}
                </div>
                {displayedDirectUsers.length === 0 ? (
                  <p className="station-empty">Niemand in diesem Tab.</p>
                ) : (
                  <div className="station-direct-grid">
                    {displayedDirectUsers.map(renderDirectCard)}
                  </div>
                )}
              </>
            ) : directOnlineTargets.length === 0 ? (
              <p className="station-empty">
                {showPinnedOnly
                  ? "Keine Favoriten online."
                  : "Sonst ist niemand online."}
              </p>
            ) : (
              <div className="station-direct-grid">
                {directOnlineTargets.map(renderDirectCard)}
              </div>
            )}
          </section>
          )}

          {!embedMode && broadcastGroups.length > 0 ? (
            <section className="station-block station-broadcast-section">
              <StationSectionHeader
                tone="broadcast"
                title="Durchsage"
                hint="Gedrückt halten = an alle in der Gruppe sprechen"
                count={`${broadcastGroups.length} ${
                  broadcastGroups.length === 1 ? "Gruppe" : "Gruppen"
                }`}
              />
              <div className="station-broadcast-grid">
                {broadcastGroups.map((group) => {
                  const allowedRoleIds = Array.isArray(group.allowedRoleIds)
                    ? group.allowedRoleIds
                    : [];
                  const canSend =
                    allowedRoleIds.length === 0 ||
                    allowedRoleIds.includes(appData.self.roleId);
                  const groupPriority = group.priorityLevel ?? 1;
                  const priorityLabels: Record<number, string> = {
                    0: "L",
                    2: "H",
                    3: "C",
                  };
                  const isLive = broadcastPttPressed === group.id;
                  return (
                    <article
                      key={group.id}
                      className="station-card station-broadcast-card"
                      data-talk={isLive ? "live" : "off"}
                      data-can-talk={canSend ? "true" : "false"}
                      data-rx={isReceivingBroadcast(group.id) ? "true" : "false"}
                    >
                      <div className="station-key-top">
                        <span className="station-key-top-spacer" />
                        {groupPriority !== 1 ? (
                          <span
                            className={`priority-badge priority-${groupPriority}`}
                            title="Priorität"
                          >
                            {priorityLabels[groupPriority] || "?"}
                          </span>
                        ) : null}
                        {isReceivingBroadcast(group.id) ? (
                          <span className="station-broadcast-receiving">RX</span>
                        ) : null}
                      </div>
                      <button
                        className={`station-broadcast-button hold-button ${isLive ? "active" : ""} ${
                          canSend ? "" : "disabled"
                        }`}
                        {...createHoldButtonProps<HTMLButtonElement>({
                          disabled: !canSend,
                          onStart: () => {
                            if (canSend) {
                              startBroadcastPtt(group.id);
                            }
                          },
                          onStop: () => {
                            if (canSend) {
                              stopBroadcastPtt(group.id);
                            }
                          },
                        })}
                        disabled={!canSend}
                        title={
                          canSend
                            ? ""
                            : "Deine Rolle darf in dieser Durchsage-Gruppe nicht sprechen"
                        }
                      >
                        <small>
                          <StationSectionIcon tone="broadcast" />
                          Durchsage
                        </small>
                        <strong>{group.name}</strong>
                      </button>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>

        {hasChatAndSignalPanel ? (
          <PanelResizer
            orientation="vertical"
            label="Breite von Chat und Seitenleiste ändern"
            className="station-col-resizer"
            direction={-1}
            min={280}
            max={() =>
              Math.min(760, (contentGridRef.current?.clientWidth ?? 1200) * 0.6)
            }
            getSize={() =>
              secondaryColumnRef.current?.getBoundingClientRect().width ?? 360
            }
            onResize={setSideWidth}
            onReset={() => setSideWidth(null)}
          />
        ) : null}
        {hasChatAndSignalPanel ? (
          <aside
            className="station-secondary-column"
            ref={secondaryColumnRef}
            style={
              chatHeight
                ? ({ "--station-chat-h": `${chatHeight}px` } as React.CSSProperties)
                : undefined
            }
          >
            <ChatPopoutSection>{chatAndSignalPanel}</ChatPopoutSection>
            <PanelResizer
              orientation="horizontal"
              label="Chat-Höhe ändern"
              className="station-chat-resizer"
              direction={1}
              min={220}
              max={() => {
                const column = secondaryColumnRef.current;
                const wide = window.matchMedia("(min-width: 1101px)").matches;
                return wide && column ? column.clientHeight - 110 : 900;
              }}
              getSize={() =>
                secondaryColumnRef.current
                  ?.querySelector(".station-chat-section")
                  ?.getBoundingClientRect().height ?? 420
              }
              onResize={setChatHeight}
              onReset={() => setChatHeight(null)}
            />
            <section className="station-block station-utility station-utility-section station-pi-monitoring">
              <div className="panel station-pi-monitoring-panel">
                <RaspberryPiStationsPanel
                  stations={raspberryPiStations}
                  title="Raspberry Pis"
                  emptyText="Kein Raspberry verbunden."
                  className="station-pi-stations"
                />
                {raspberryPiStationsError ? (
                  <small className="streamdeck-error">
                    {raspberryPiStationsError}
                  </small>
                ) : null}
              </div>
            </section>
          </aside>
        ) : null}
      </div>
      {showDebug ? (
        <section className="panel">{realtimeDebugBlock}</section>
      ) : null}
      {isUserSettingsOpen ? (
        <StationSettingsFrame
          asPage={inShell}
          lowPowerMode={lowPowerMode}
          activePage={activeSettingsPage}
          onSelectPage={openSettingsPage}
          onClose={() => setIsUserSettingsOpen(false)}
        >
                {activeSettingsPage === "layout" ? (
                <section
                  id="settings-layout"
                  className="station-settings-section station-settings-card"
                >
                  <SettingsSectionHeader
                    icon="layout"
                    eyebrow="Ansicht"
                    title="Layout"
                  />
                  <div className="station-settings-grid">
                    <SettingsToggle
                      label="Nur Favoriten zeigen"
                      description="Zeigt nur angeheftete Party Lines und Personen."
                      checked={showPinnedOnly}
                      onChange={onShowPinnedOnlyChange}
                    />
                    <SettingsToggle
                      label="Direkt-Personen in Reitern zeigen"
                      description="Ordnet Personen nach Favoriten und Rollen."
                      checked={enableDirectTabs}
                      onChange={onEnableDirectTabsChange}
                    />
                    <SettingsToggle
                      label="Lautstärkeregler zeigen"
                      description="Zeigt Regler für jede Party Line und jede Person."
                      checked={showVolumeControls}
                      onChange={onShowVolumeControlsChange}
                    />
                  </div>
                </section>
                ) : null}

                {activeSettingsPage === "interaction" ? (
                <section
                  id="settings-interaction"
                  className="station-settings-section station-settings-card"
                >
                  <SettingsSectionHeader
                    icon="controls"
                    eyebrow="Bedienung"
                    title="Sprechen & Antworten"
                  />
                  <div className="station-settings-grid">
                    <SettingsToggle
                      label="Direkt sprechen (Party Line gedrückt halten)"
                      description="Jede Party-Line-Taste wird zur Sprechtaste."
                      checked={enableDirectPpt}
                      onChange={onEnableDirectPptChange}
                    />
                    <SettingsToggle
                      label="Sprechen und Antworten tauschen"
                      description="Tauscht die Reihenfolge der beiden Knöpfe auf diesem Gerät."
                      checked={swapPttAndReplyButtons}
                      onChange={onSwapPttAndReplyButtonsChange}
                    />
                  </div>
                </section>
                ) : null}

                {activeSettingsPage === "system" ? (
                <section
                  id="settings-system"
                  className="station-settings-section station-settings-card"
                >
                  <SettingsSectionHeader
                    icon="system"
                    eyebrow="Gerät"
                    title="System"
                  />
                  <div className="station-settings-grid">
                    <SettingsToggle
                      label="Ton im Hintergrund wiederherstellen"
                      description="Hilft, den Ton nach Unterbrechungen wieder zu starten."
                      checked={enableBackgroundAudioRecovery}
                      onChange={onEnableBackgroundAudioRecoveryChange}
                    />
                    <SettingsToggle
                      label="Gerät wach halten, solange verbunden"
                      description={
                        wakeLockSupported
                          ? "Der Bildschirm geht nicht in den Ruhezustand."
                          : "In diesem Browser nicht möglich."
                      }
                      checked={keepScreenAwake}
                      disabled={!wakeLockSupported}
                      onChange={onKeepScreenAwakeChange}
                    />
                  </div>
                  <div className="station-settings-status-grid">
                    <SettingsStatusCard
                      label="Mediensteuerung"
                      value={mediaSessionSupported ? "Unterstützt" : "Nicht unterstützt"}
                    />
                    <SettingsStatusCard
                      label="Wach halten"
                      value={
                        wakeLockSupported
                          ? wakeLockActive
                            ? "Aktiv"
                            : "Verfügbar"
                          : "Nicht unterstützt"
                      }
                    />
                    <SettingsStatusCard
                      label="Ausführung"
                      value={isStandaloneDisplayMode ? "Installierte App" : "Browser-Tab"}
                    />
                  </div>
                  <small className="station-settings-meta">
                    Am Handy läuft es am zuverlässigsten, wenn „Ton im Hintergrund
                    wiederherstellen“ an ist und die App auf dem Home-Bildschirm liegt.
                  </small>
                </section>
                ) : null}

                {activeSettingsPage === "shortcuts" ? (
                <section
                  id="settings-shortcuts"
                  className="station-settings-section station-settings-card station-settings-panel-section"
                >
                  <SettingsSectionHeader
                    icon="keyboard"
                    eyebrow="Tastatur"
                    title="Tastenkürzel"
                  />
                  <KeyboardShortcutsSettings
                    shortcuts={keyboardShortcuts}
                    onShortcutsChange={onKeyboardShortcutsChange}
                    onRecordingChange={onRecordingShortcutChange}
                  />
                </section>
                ) : null}

                {activeSettingsPage === "streamdeck" ? (
                <section
                  id="settings-streamdeck"
                  className="station-settings-section station-settings-card streamdeck-settings-section"
                >
                  <SettingsSectionHeader
                    icon="hardware"
                    eyebrow="Geräte"
                    title="Stream Deck"
                  />
                <div className="streamdeck-panel">
                  {isStreamDeckOpen ? (
                    <div className="streamdeck-panel-body">
                      <div className="streamdeck-toolbar">
                        <ol className="streamdeck-steps" aria-label="So geht's">
                          <li><b>1</b> Tasten belegen</li>
                          <li><b>2</b> Speichern</li>
                          <li><b>3</b> An Companion senden</li>
                        </ol>
                        <div className="streamdeck-toolbar-main">
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-primary"
                            onClick={() => void saveStreamDeckSettings()}
                            disabled={
                              streamDeckBusy ||
                              streamDeckSaveBusy ||
                              !streamDeckSettings
                            }
                          >
                            <StreamDeckUiIcon name="save" />
                            {streamDeckSaveBusy || streamDeckBusy ? "Speichere …" : "Speichern"}
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn streamdeck-publish-btn"
                            onClick={openCompanionPublishConfirm}
                            disabled={
                              streamDeckBusy ||
                              companionPublishBusy ||
                              !streamDeckSettings
                            }
                          >
                            <StreamDeckUiIcon name="send" />
                            {companionPublishBusy ? "Sende …" : "An Companion senden"}
                          </button>
                        </div>
                      </div>
                      <div className="streamdeck-tools">
                        <input
                          ref={streamDeckImportInputRef}
                          type="file"
                          accept="application/json,.json"
                          data-testid="streamdeck-import-input"
                          className="streamdeck-import-input"
                          onChange={(event) => {
                            void importStreamDeckSettingsFromFile(event);
                          }}
                          disabled={streamDeckBusy}
                        />
                        <button
                          type="button"
                          className="shortcut-btn"
                          onClick={
                            streamDeckWebHidActive
                              ? onDisconnectStreamDeckWebHid
                              : onConnectStreamDeckWebHid
                          }
                          disabled={streamDeckWebHidBusy || !streamDeckWebHidSupported}
                        >
                          <StreamDeckUiIcon name="device" />
                          {streamDeckWebHidBusy
                            ? "Moment …"
                            : streamDeckWebHidActive
                              ? "Gerät trennen"
                              : "Gerät verbinden"}
                        </button>
                        <button
                          type="button"
                          className="shortcut-btn"
                          onClick={exportStreamDeckSettings}
                          disabled={streamDeckBusy || !streamDeckSettings}
                        >
                          <StreamDeckUiIcon name="download" />
                          Exportieren
                        </button>
                        <button
                          type="button"
                          className="shortcut-btn"
                          onClick={openStreamDeckImportPicker}
                          disabled={streamDeckBusy || !streamDeckSettings}
                        >
                          <StreamDeckUiIcon name="upload" />
                          Importieren
                        </button>
                        <button
                          type="button"
                          className="shortcut-btn shortcut-btn-clear"
                          onClick={onResetStreamDeckSettings}
                          disabled={streamDeckBusy || !streamDeckSettings}
                        >
                          <StreamDeckUiIcon name="reset" />
                          Zurücksetzen
                        </button>
                      </div>
                      {streamDeckErrorNotice ? (
                        <div
                          className={`streamdeck-notice ${streamDeckErrorNotice.tone}`}
                          role="alert"
                        >
                          <span className="streamdeck-notice-icon">
                            <StreamDeckUiIcon name="warning" />
                          </span>
                          <span>
                            <strong>{streamDeckErrorNotice.title}</strong>
                            <small>{streamDeckErrorNotice.message}</small>
                          </span>
                        </div>
                      ) : null}
                      <div className="streamdeck-status-grid">
                        <div
                          className={`streamdeck-status-card ${
                            streamDeckWebHidActive
                              ? "ok"
                              : streamDeckWebHidSupported
                                ? "wait"
                                : "warn"
                          }`}
                        >
                          <span>USB-Verbindung</span>
                          <strong>
                            {streamDeckWebHidSupported
                              ? streamDeckWebHidActive
                                ? "Verbunden"
                                : "Bereit"
                              : "Nicht unterstützt"}
                          </strong>
                        </div>
                        <div
                          className={`streamdeck-status-card ${
                            streamDeckBridgeConnected ? "ok" : "wait"
                          }`}
                        >
                          <span>Tasten-Brücke</span>
                          <strong>
                            {streamDeckBridgeConnected ? "Verbunden" : "Wartet"}
                          </strong>
                          {streamDeckBridgeLastEvent ? (
                            <small>{streamDeckBridgeLastEvent}</small>
                          ) : null}
                        </div>
                        <div className="streamdeck-status-card">
                          <span>Profil</span>
                          <strong>
                            {streamDeckConfiguredButtonCount} Tasten ·{" "}
                            {Math.max(1, streamDeckConfiguredPageCount)} Seiten
                          </strong>
                          {lastCompanionCommand ? (
                            <small>
                              Companion {lastCompanionCommand.status} ·{" "}
                              {new Date(lastCompanionCommand.at).toLocaleTimeString("de-DE")}
                            </small>
                          ) : null}
                        </div>
                      </div>
                      {lastCompanionCommand?.error ? (
                        <small className="streamdeck-error">
                          {lastCompanionCommand.error}
                        </small>
                      ) : null}
                      {showDebug ? (
                        <small className="station-settings-meta">
                          Debug: window.__kesherStreamDeckDev.buttonTap(0, 0),
                          buttonDown/buttonUp, listHidDevices().
                        </small>
                      ) : null}
                    {!streamDeckSettings ? (
                      <small className="station-settings-meta">
                        Lade Stream-Deck-Einstellungen …
                      </small>
                    ) : (
                      <div className="streamdeck-editor-shell">
                        <fieldset className="streamdeck-fieldset">
                        <div className="streamdeck-page-bar">
                          <div className="streamdeck-page-nav" aria-label="Seite wählen">
                            <button
                              type="button"
                              className="shortcut-btn"
                              aria-label="Vorherige Seite"
                              onClick={() => goToStreamDeckPage(-1)}
                              disabled={
                                streamDeckBusy ||
                                streamDeckSettings.selectedPage <= 0
                              }
                            >
                              {"‹"}
                            </button>
                            <span>
                              Seite {streamDeckSettings.selectedPage + 1}
                            </span>
                            <button
                              type="button"
                              className="shortcut-btn"
                              aria-label="Nächste Seite"
                              onClick={() => goToStreamDeckPage(1)}
                              disabled={streamDeckBusy}
                            >
                              {"›"}
                            </button>
                          </div>
                          <button
                            type="button"
                            className={`shortcut-btn ${streamDeckTestMode ? "active" : ""}`}
                            onClick={() => setStreamDeckTestMode((value) => !value)}
                            disabled={streamDeckBusy}
                            aria-pressed={streamDeckTestMode}
                            title="Tasten direkt im Browser ausprobieren"
                          >
                            {streamDeckTestMode ? "Testmodus an" : "Testmodus aus"}
                          </button>
                        </div>
                        {streamDeckTestMode ? (
                          <small className="streamdeck-mode-note">
                            Testmodus: Eine Taste im Raster gedrückt halten löst sie aus – ganz ohne echtes Stream Deck.
                          </small>
                        ) : null}
                        {streamDeckCurrentPage ? (
                          <div className="streamdeck-page-meta">
                            <label className="streamdeck-control">
                              <span>Seitentitel</span>
                              <input
                                type="text"
                                value={streamDeckCurrentPage.title || ""}
                                onChange={(event) =>
                                  updateStreamDeckCurrentPageMeta((page) => ({
                                    ...page,
                                    title: event.target.value,
                                  }))
                                }
                                placeholder="Optionaler Ordnername"
                              />
                            </label>
                            <label className="streamdeck-control">
                              <span>Seitentyp</span>
                              <select
                                value={streamDeckCurrentPage.pageType || "manual"}
                                onChange={(event) =>
                                  updateStreamDeckCurrentPageMeta((page) => ({
                                    ...page,
                                    pageType: event.target.value as StreamDeckPageType,
                                  }))
                                }
                              >
                                <option value="manual">Eigene Seite / Ordner</option>
                                <option value="all_roles">Automatisch: alle Rollen</option>
                                <option value="all_party_lines">Automatisch: alle Party Lines</option>
                              </select>
                            </label>
                            <label className="streamdeck-control">
                              <span>Übergeordnete Seite</span>
                              <select
                                value={String(streamDeckCurrentPage.parentPage ?? "")}
                                onChange={(event) =>
                                  updateStreamDeckCurrentPageMeta((page) => ({
                                    ...page,
                                    parentPage:
                                      event.target.value === ""
                                        ? undefined
                                        : Number(event.target.value),
                                  }))
                                }
                              >
                                <option value="">Oberste Ebene</option>
                                {(streamDeckSettings?.pages ?? [])
                                  .filter((page) => page.page !== streamDeckCurrentPage.page)
                                  .sort((a, b) => a.page - b.page)
                                  .map((page, index) => (
                                    <option key={`sd-parent-page-${page.page}`} value={String(page.page)}>
                                      {page.title?.trim() || `Seite ${index + 1}`}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          </div>
                        ) : null}

                        <div className="streamdeck-layout">
                          <div className="streamdeck-deck-panel">
                            <div className="streamdeck-panel-heading">
                              <div>
                                <span>Vorschau</span>
                                <strong>
                                  Seite {streamDeckSettings.selectedPage + 1}
                                </strong>
                              </div>
                              <small>
                                {streamDeckCurrentPageConfiguredButtonCount}/
                                {streamDeckCurrentButtons.length} belegt
                              </small>
                            </div>
                            <div className="streamdeck-grid" role="grid" aria-label="Stream-Deck-Tasten">
                              {streamDeckCurrentButtons.map((button) => {
                                const previewImage =
                                  streamDeckPreviewImageByIndex.get(button.index) || "";
                                const isPressedInPreview =
                                  streamDeckPreviewPressedIndexes.includes(button.index);
                                const showPressedRing =
                                  isPressedInPreview &&
                                  button.action?.type !== "listen_room" &&
                                  button.action?.type !== "select_listen_room";
                                return (
                                  <button
                                    type="button"
                                    key={`streamdeck-button-${button.index}`}
                                    aria-label={`Taste ${button.index + 1}`}
                                    className={`streamdeck-button ${
                                      streamDeckSelectedButton?.index === button.index
                                        ? "active"
                                        : ""
                                    } ${showPressedRing ? "test-pressed" : ""} ${
                                      streamDeckDragSourceIndex === button.index
                                        ? "drag-source"
                                        : ""
                                    } ${
                                      streamDeckDropTargetIndex === button.index &&
                                      streamDeckDragSourceIndex !== button.index
                                        ? "drag-target"
                                        : ""
                                    }`}
                                    draggable={!streamDeckTestMode}
                                    onClick={() => setStreamDeckSelectedButtonIndex(button.index)}
                                    onDragStart={(event) => {
                                      event.dataTransfer.effectAllowed = "move";
                                      handleStreamDeckButtonDragStart(button.index);
                                    }}
                                    onDragOver={(event) => {
                                      event.preventDefault();
                                      if (streamDeckDragSourceIndex !== null) {
                                        event.dataTransfer.dropEffect = "move";
                                        setStreamDeckDropTargetIndex(button.index);
                                      }
                                    }}
                                    onDragEnter={() => {
                                      if (streamDeckDragSourceIndex !== null) {
                                        setStreamDeckDropTargetIndex(button.index);
                                      }
                                    }}
                                    onDragEnd={resetStreamDeckDragState}
                                    onDrop={(event) => {
                                      event.preventDefault();
                                      handleStreamDeckButtonDrop(button.index);
                                    }}
                                    onPointerDown={() =>
                                      startStreamDeckPreviewPress(button.index)
                                    }
                                    onPointerUp={() =>
                                      stopStreamDeckPreviewPress(button.index)
                                    }
                                    onPointerCancel={() =>
                                      stopStreamDeckPreviewPress(button.index)
                                    }
                                    onPointerLeave={() =>
                                      stopStreamDeckPreviewPress(button.index)
                                    }
                                  >
                                    {previewImage ? (
                                      <img
                                        src={previewImage}
                                        alt={`Vorschau Taste ${button.index + 1}`}
                                        className="streamdeck-button-preview"
                                        draggable={false}
                                      />
                                    ) : (
                                      <span className="streamdeck-button-empty" aria-hidden="true">
                                        {button.index + 1}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="streamdeck-editor panel">
                        <div className="streamdeck-editor-heading">
                          <div>
                            <span>Ausgewählte Taste</span>
                            <h5>
                              Taste {(streamDeckSelectedButton?.index || 0) + 1}
                            </h5>
                          </div>
                          <small>
                            {streamDeckActionLabel(
                              streamDeckSelectedButton?.action?.type,
                            )}
                          </small>
                        </div>
                        <div className="streamdeck-editor-actions">
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={undoLastStreamDeckChange}
                            disabled={streamDeckUndoStack.length === 0}
                          >
                            Rückgängig
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={copySelectedStreamDeckButton}
                            disabled={!streamDeckSelectedButton}
                          >
                            Kopieren
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn"
                            onClick={pasteIntoSelectedStreamDeckButton}
                            disabled={!streamDeckSelectedButton || !streamDeckClipboardButton}
                          >
                            Einfügen
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-clear"
                            onClick={clearSelectedStreamDeckButton}
                            disabled={!streamDeckSelectedButton}
                          >
                            Leeren
                          </button>
                        </div>
                        <label className="streamdeck-control">
                          <span>Beschriftung</span>
                          <input
                            type="text"
                            value={streamDeckSelectedButton?.label || ""}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                label: event.target.value,
                              }))
                            }
                            placeholder="z. B. FOH"
                          />
                        </label>
                        <label className="streamdeck-control streamdeck-color-control">
                          <span>Farbe</span>
                          <input
                            type="color"
                            aria-label="Tastenfarbe wählen"
                            value={/^#[0-9a-f]{6}$/i.test(streamDeckSelectedButton?.color || "") ? streamDeckSelectedButton?.color : "#1f3f5f"}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                color: event.target.value,
                              }))
                            }
                          />
                          <input
                            type="text"
                            value={streamDeckSelectedButton?.color || ""}
                            onChange={(event) =>
                              updateStreamDeckSelectedButton((button) => ({
                                ...button,
                                color: event.target.value,
                              }))
                            }
                            placeholder="#1f3f5f"
                          />
                        </label>
                        <label className="streamdeck-control">
                          <span>Funktion</span>
                          <select
                            aria-label="Funktion der Taste"
                            value={streamDeckSelectedButton?.action?.type || "none"}
                            onChange={(event) =>
                              setStreamDeckActionType(
                                event.target.value as StreamDeckActionType,
                              )
                            }
                          >
                            <option value="none">Keine</option>
                            <optgroup label="Sprechkanäle">
                              <option value="select_talk_room">Sprechkanal wählen</option>
                              <option value="select_listen_room">Kanal wählen + hören (halten)</option>
                              <option value="ptt_selected">Sprechen auf gewählten Kanälen</option>
                              <option value="ptt_room">Sprechen auf festem Kanal</option>
                              <option value="listen_room">Kanal hören</option>
                              <option value="call_room">Kanal rufen</option>
                            </optgroup>
                            <optgroup label="Direkt">
                              <option value="direct_user">Person direkt</option>
                              <option value="direct_role">Rolle direkt</option>
                              <option value="reply_to_caller">Anrufer antworten</option>
                              <option value="incoming_call_indicator">Anzeige eingehende Rufe</option>
                              <option value="raspberry_status">Raspberry-Pi-Status</option>
                            </optgroup>
                            <optgroup label="Durchsage">
                              <option value="broadcast_ptt">Durchsage sprechen</option>
                            </optgroup>
                            <optgroup label="Navigation">
                              <option value="page_up">Seite hoch</option>
                              <option value="page_down">Seite runter</option>
                              <option value="page_home">Startseite (Seite 1)</option>
                              <option value="page_jump">Seite / Ordner öffnen</option>
                            </optgroup>
                            <optgroup label="Lautstärke">
                              <option value="volume_delta">Lautstärke +/−</option>
                            </optgroup>
                            <optgroup label="Chat">
                              <option value="chat_message">Chat-Nachricht senden</option>
                            </optgroup>
                          </select>
                        </label>

                        {streamDeckSelectedButton?.action?.type === "ptt_room" ||
                        streamDeckSelectedButton?.action?.type === "select_talk_room" ||
                        streamDeckSelectedButton?.action?.type === "select_listen_room" ||
                        streamDeckSelectedButton?.action?.type === "listen_room" ||
                        streamDeckSelectedButton?.action?.type === "call_room" ? (
                          <label className="streamdeck-control">
                            <span>Kanal</span>
                            <select
                              aria-label="Party Line der Taste"
                              value={streamDeckSelectedButton.action.roomId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: streamDeckSelectedButton.action?.type || "ptt_room",
                                    roomId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {appData.rooms.map((room) => (
                                <option key={`streamdeck-room-${room.id}`} value={room.id}>
                                  {room.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "raspberry_status" ? (
                          <label className="streamdeck-control">
                            <span>Raspberry Pi</span>
                            <select
                              aria-label="Raspberry Pi der Taste"
                              value={streamDeckSelectedButton.action.raspberryPiId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "raspberry_status",
                                    raspberryPiId: event.target.value,
                                  },
                                }))
                              }
                            >
                              <option value="">Pi wählen …</option>
                              {raspberryPis.map((pi) => {
                                const isOnline = ["intercom_connected", "waiting_for_intercom", "launcher_online"].includes(pi.effectiveStatus);
                                return (
                                  <option key={`streamdeck-pi-${pi.name}`} value={pi.name}>
                                    {isOnline ? "🟢" : "🔴"} {pi.name} {!isOnline ? "(Offline)" : ""}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "direct_user" ? (
                          <label className="streamdeck-control">
                            <span>Person</span>
                            <select
                              aria-label="Person der Taste"
                              value={streamDeckSelectedButton.action.userId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "direct_user",
                                    userId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {sortDirectUsersByRoleAndUsername(appData.users, roleNameById).map((user) => (
                                <option key={`streamdeck-user-${user.id}`} value={user.id}>
                                  {user.username} ({roleNameById.get(user.roleId) ?? user.roleId})
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "direct_role" ? (
                          <label className="streamdeck-control">
                            <span>Rolle</span>
                            <select
                              aria-label="Rolle der Taste"
                              value={streamDeckSelectedButton.action.roleId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "direct_role",
                                    roleId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {appData.roles.map((role) => {
                                const onlineRoleUsers = allDirectOnlineTargets
                                  .filter((entry) => entry.roleId === role.id)
                                  .map((entry) => entry.username);
                                const onlineHint =
                                  onlineRoleUsers.length > 0
                                    ? ` (${onlineRoleUsers.join(", ")})`
                                    : "";
                                return (
                                  <option key={`streamdeck-role-${role.id}`} value={role.id}>
                                    {role.name}{onlineHint}
                                  </option>
                                );
                              })}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "broadcast_ptt" ? (
                          <label className="streamdeck-control">
                            <span>Broadcast-Gruppe</span>
                            <select
                              aria-label="Durchsage-Gruppe der Taste"
                              value={streamDeckSelectedButton.action.broadcastGroupId || ""}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "broadcast_ptt",
                                    broadcastGroupId: event.target.value,
                                  },
                                }))
                              }
                            >
                              {broadcastGroups.map((group) => (
                                <option key={`streamdeck-group-${group.id}`} value={group.id}>
                                  {group.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "volume_delta" ? (
                          <label className="streamdeck-control">
                            <span>Schritt</span>
                            <select
                              aria-label="Lautstärke-Schritt der Taste"
                              value={String(
                                streamDeckSelectedButton.action.volumeDelta || 1,
                              )}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "volume_delta",
                                    volumeDelta: Number(event.target.value),
                                  },
                                }))
                              }
                            >
                              <option value="-2">-2</option>
                              <option value="-1">-1</option>
                              <option value="1">+1</option>
                              <option value="2">+2</option>
                            </select>
                          </label>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "chat_message" ? (
                          <>
                            <label className="streamdeck-control">
                              <span>Nachricht *</span>
                              <textarea
                                aria-label="Chat-Nachricht der Taste"
                                rows={2}
                                maxLength={STREAM_DECK_CHAT_MESSAGE_MAX_LENGTH}
                                placeholder="z. B. Bitte leiser"
                                value={streamDeckSelectedButton.action.message || ""}
                                aria-invalid={!streamDeckSelectedButton.action.message?.trim()}
                                onChange={(event) =>
                                  updateStreamDeckSelectedButton((button) => ({
                                    ...button,
                                    action: {
                                      type: "chat_message",
                                      message: event.target.value,
                                      roomId: button.action?.roomId,
                                    },
                                  }))
                                }
                              />
                              {!streamDeckSelectedButton.action.message?.trim() ? (
                                <em className="streamdeck-control-hint">
                                  Pflichtfeld – ohne Text kann nicht gespeichert werden.
                                </em>
                              ) : null}
                            </label>
                            <label className="streamdeck-control">
                              <span>Senden an</span>
                              <select
                                aria-label="Chat-Ziel der Taste"
                                value={streamDeckSelectedButton.action.roomId || ""}
                                onChange={(event) =>
                                  updateStreamDeckSelectedButton((button) => ({
                                    ...button,
                                    action: {
                                      type: "chat_message",
                                      message: button.action?.message,
                                      roomId: event.target.value || undefined,
                                    },
                                  }))
                                }
                              >
                                <option value="">Global (alle)</option>
                                {appData.rooms
                                  .filter((room) =>
                                    roleAllowed(room.senderRoleIds, appData.self.roleId),
                                  )
                                  .map((room) => (
                                    <option key={`streamdeck-chat-room-${room.id}`} value={room.id}>
                                      {room.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          </>
                        ) : null}

                        {streamDeckSelectedButton?.action?.type === "page_jump" ? (
                          <label className="streamdeck-control">
                            <span>Zielseite</span>
                            <select
                              aria-label="Zielseite der Taste"
                              value={String(
                                streamDeckSelectedButton.action.targetPage ?? 0,
                              )}
                              onChange={(event) =>
                                updateStreamDeckSelectedButton((button) => ({
                                  ...button,
                                  action: {
                                    type: "page_jump",
                                    targetPage: Number(event.target.value),
                                  },
                                }))
                              }
                            >
                              {(streamDeckSettings?.pages ?? [])
                                .map((p) => p.page)
                                .sort((a, b) => a - b)
                                .map((pageNo, idx) => (
                                  <option key={`sd-jump-page-${pageNo}`} value={String(pageNo)}>
                                    {(streamDeckSettings?.pages ?? []).find((page) => page.page === pageNo)?.title?.trim() || `Seite ${idx + 1}`}
                                  </option>
                                ))}
                            </select>
                          </label>
                        ) : null}
                          </div>
                        </div>
                        </fieldset>
                      </div>
                    )}
                    </div>
                  ) : null}
                </div>
                {isCompanionPublishConfirmOpen ? (
                  <div
                    className="streamdeck-confirm-backdrop"
                    role="presentation"
                    onMouseDown={(event) => {
                      if (event.target === event.currentTarget) {
                        setIsCompanionPublishConfirmOpen(false);
                      }
                    }}
                  >
                    <div
                      className="streamdeck-confirm-dialog"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="streamdeck-companion-confirm-title"
                    >
                      <div className="streamdeck-confirm-icon">
                        <StreamDeckUiIcon name="send" />
                      </div>
                      <div className="streamdeck-confirm-content">
                        <span className="streamdeck-confirm-eyebrow">
                          Companion
                        </span>
                        <h4 id="streamdeck-companion-confirm-title">
                          Stream-Deck-Profil an Companion senden?
                        </h4>
                        <p>
                          Kesher speichert die Belegung zuerst und sendet sie dann an Companion.
                        </p>
                        <div className="streamdeck-confirm-summary" aria-label="Was passiert">
                          <div>
                            <span>Speichern</span>
                            <strong>Aktuelle Stream-Deck-Belegung</strong>
                          </div>
                          <div>
                            <span>Companion</span>
                            <strong>Buttons / Presets / kesher</strong>
                          </div>
                        </div>
                        <div className="streamdeck-confirm-path">
                          {companionPublishPresetPath}
                        </div>
                        <div className="streamdeck-confirm-actions">
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-clear"
                            onClick={() => setIsCompanionPublishConfirmOpen(false)}
                          >
                            Abbrechen
                          </button>
                          <button
                            type="button"
                            className="shortcut-btn shortcut-btn-primary"
                            onClick={() => void confirmCompanionPublish()}
                            disabled={companionPublishBusy || streamDeckBusy}
                          >
                            <StreamDeckUiIcon name="send" />
                            {companionPublishBusy || streamDeckBusy
                              ? "Sende …"
                              : "Speichern und senden"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
                {streamDeckTransferNotice ? (
                  <div
                    className={`streamdeck-toast ${streamDeckTransferNotice.tone}`}
                    role={streamDeckTransferNotice.tone === "error" ? "alert" : "status"}
                  >
                    <span className="streamdeck-toast-icon">
                      <StreamDeckUiIcon name={streamDeckTransferNotice.tone === "error" ? "warning" : "check"} />
                    </span>
                    <span className="streamdeck-toast-text">
                      <strong>{streamDeckTransferNotice.title}</strong>
                      <small>{streamDeckTransferNotice.message}</small>
                    </span>
                    <button
                      type="button"
                      className="streamdeck-toast-close"
                      aria-label="Hinweis schließen"
                      onClick={() => {
                        setStreamDeckTransferError("");
                        setStreamDeckTransferMessage("");
                      }}
                    >
                      ×
                    </button>
                  </div>
                ) : null}
              </section>
                ) : null}

                {activeSettingsPage === "audio" ? (
                <section
                  id="settings-audio"
                  className="audio-section station-settings-card"
                >
                  <SettingsSectionHeader
                    icon="audio"
                    eyebrow="Ton"
                    title="Ton & Mikrofon"
                  />
                <div className={`audio-box ${isAudioOpen ? "" : "collapsed"}`}>
                  <div className="audio-box-header">
                    <button
                      type="button"
                      className="audio-box-toggle"
                      onClick={() => setIsAudioOpen((v) => !v)}
                      aria-expanded={isAudioOpen}
                    >
                      Ton-Einstellungen
                      <ChevronIcon className={`chev ${isAudioOpen ? "open" : ""}`} />
                    </button>
                  </div>
                  {isAudioOpen ? (
                    <div className="audio-box-body audio-subsection-stack">
                      <div
                        className={`audio-subsection ${isPersonalAudioOpen ? "" : "collapsed"}`}
                      >
                        <button
                          type="button"
                          className="audio-subsection-toggle"
                          onClick={() =>
                            setIsPersonalAudioOpen((value) => !value)
                          }
                          aria-expanded={isPersonalAudioOpen}
                        >
                          Mein Ton
                          <ChevronIcon
                            className={`chev ${isPersonalAudioOpen ? "open" : ""}`}
                          />
                        </button>
                        {isPersonalAudioOpen ? (
                          <div className="audio-subsection-body audio-personal-layout">
                            <div className="audio-device-card audio-device-card-input">
                              <div className="audio-card-head">
                                <div>
                                  <span>Eingang</span>
                                  <h4>Mikrofon</h4>
                                </div>
                                <span
                                  className={`audio-status-pill ${
                                    audioControlsLowPowerMode
                                      ? "paused"
                                      : inputClipping
                                        ? "warning"
                                        : "ok"
                                  }`}
                                >
                                  {audioControlsLowPowerMode
                                    ? "Anzeige pausiert"
                                    : inputClipping
                                      ? "Übersteuert"
                                      : "Bereit"}
                                </span>
                              </div>

                              <div className="audio-control-grid">
                                <div className="audio-control audio-control-device">
                                  <span className="audio-control-label">
                                    Gerät
                                  </span>
                                  <div className="mic-dropdown" ref={micMenuRef}>
                                    <button
                                      type="button"
                                      className="mic-dropdown-trigger"
                                      onClick={() => setIsMicMenuOpen((v) => !v)}
                                      disabled={inputDevices.length === 0}
                                      aria-haspopup="listbox"
                                      aria-expanded={isMicMenuOpen}
                                    >
                                      <span>{selectedMicLabel}</span>
                                      <span>v</span>
                                    </button>
                                    {isMicMenuOpen ? (
                                      <div
                                        className="mic-dropdown-menu"
                                        role="listbox"
                                      >
                                        {inputDevices.map((d) => (
                                          <button
                                            type="button"
                                            key={d.deviceId}
                                            className={`mic-dropdown-item ${d.deviceId === selectedInputDeviceId ? "active" : ""}`}
                                            onClick={() => {
                                              setSelectedInputDeviceId(
                                                d.deviceId,
                                              );
                                              setIsMicMenuOpen(false);
                                            }}
                                            title={
                                              d.label ||
                                              `Mikrofon ${d.deviceId.slice(0, 6)}`
                                            }
                                          >
                                            {d.label ||
                                              `Mikrofon ${d.deviceId.slice(0, 6)}`}
                                          </button>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                <label className="input-channel-control audio-control">
                                  <span>Eingang am Interface</span>
                                  <select
                                    aria-label="Eingang am Interface"
                                    value={selectedInputChannelValue}
                                    onChange={(event) =>
                                      onSelectedInputChannelChange(
                                        event.currentTarget.value === "all"
                                          ? "all"
                                          : Number(event.currentTarget.value),
                                      )
                                    }
                                  >
                                    <option value="all">{allInputsLabel}</option>
                                    {inputChannelCount > 1
                                      ? Array.from(
                                          { length: inputChannelCount },
                                          (_, index) => (
                                            <option
                                              key={`input-channel-${index + 1}`}
                                              value={index + 1}
                                            >
                                              Eingang {index + 1}
                                            </option>
                                          ),
                                        )
                                      : null}
                                  </select>
                                  <small>
                                    Wähle den Eingang am gewählten USB-Interface.
                                  </small>
                                </label>
                              </div>

                              <div className="audio-meter-card">
                                {audioControlsLowPowerMode ? (
                                  <div
                                    className="input-level-row input-level-row-muted"
                                    aria-live="polite"
                                  >
                                    <div className="input-level-head">
                                      <small>Eingangspegel</small>
                                      <strong>pausiert</strong>
                                    </div>
                                    <small className="input-level-status is-ok">
                                      Im Stromsparmodus ist die Pegelanzeige aus.
                                    </small>
                                  </div>
                                ) : (
                                  <div
                                    className="input-level-row"
                                    aria-live="polite"
                                  >
                                    <div className="input-level-head">
                                      <small>Eingangspegel</small>
                                      <strong>
                                        {formatDbFs(inputLevelDbFs)}
                                      </strong>
                                    </div>
                                    <div className="meter">
                                      <div
                                        className="meter-bar"
                                        style={{
                                          width: `${meterDbFsToPercent(inputLevelDbFs)}%`,
                                        }}
                                      />
                                    </div>
                                    <small
                                      className={`input-level-status ${inputClipping ? "is-clipping" : "is-ok"}`}
                                    >
                                      {inputClipping
                                        ? "Ton übersteuert"
                                        : "Pegel in Ordnung"}
                                    </small>
                                  </div>
                                )}
                              </div>

                              <div className="audio-utility-grid">
                                <div className="local-monitor-control audio-test-card">
                                  <small className="local-monitor-hint">
                                    Setz vor dem Test Kopfhörer auf.
                                  </small>
                                  <button
                                    type="button"
                                    className={`local-monitor-btn${isLocalMonitorActive ? " active" : ""}`}
                                    disabled={audioControlsLowPowerMode}
                                    onClick={onToggleLocalMonitor}
                                  >
                                    {audioControlsLowPowerMode
                                      ? "Tontest pausiert"
                                      : isLocalMonitorActive
                                        ? "Tontest beenden"
                                        : "Mikrofon testen"}
                                  </button>
                                  {isLocalMonitorActive ? (
                                    <small className="local-monitor-status">
                                      Du hörst dich jetzt selbst – Headset
                                      richten und Verstärkung prüfen.
                                    </small>
                                  ) : null}
                                </div>

                                <div className="station-gain-control input-gain-control audio-slider-card">
                                  <label htmlFor="input-gain">
                                    <span>Verstärkung</span>
                                    <strong>
                                      {gainToDbLabel(inputGain, INPUT_DB_MAX)}
                                    </strong>
                                  </label>
                                  <input
                                    id="input-gain"
                                    type="range"
                                    min={MUTE_POS}
                                    max={INPUT_DB_MAX}
                                    step={1}
                                    value={gainToSlider(inputGain, INPUT_DB_MAX)}
                                    style={
                                      {
                                        "--fill": `${sliderFillPercent(inputGain, INPUT_DB_MAX)}%`,
                                      } as React.CSSProperties
                                    }
                                    onChange={(event) =>
                                      onInputGainChange(
                                        selectedInputDeviceId,
                                        sliderToGain(
                                          Number(event.currentTarget.value),
                                          INPUT_DB_MAX,
                                        ),
                                      )
                                    }
                                    aria-label="Verstärkung"
                                  />
                                </div>
                              </div>
                            </div>

                            <div className="audio-device-card audio-device-card-output">
                              <div className="audio-card-head">
                                <div>
                                  <span>Ausgang</span>
                                  <h4>Lautsprecher</h4>
                                </div>
                              </div>
                              <div className="audio-control audio-control-device">
                                <span className="audio-control-label">
                                  Gerät
                                </span>
                                <div className="mic-dropdown" ref={outputMenuRef}>
                                  <button
                                    type="button"
                                    className="mic-dropdown-trigger"
                                    onClick={() =>
                                      setIsOutputMenuOpen((v) => !v)
                                    }
                                    disabled={outputDevices.length === 0}
                                    aria-haspopup="listbox"
                                    aria-expanded={isOutputMenuOpen}
                                  >
                                    <span>{selectedOutputLabel}</span>
                                    <span>v</span>
                                  </button>
                                  {isOutputMenuOpen ? (
                                    <div
                                      className="mic-dropdown-menu"
                                      role="listbox"
                                    >
                                      <button
                                        type="button"
                                        className={`mic-dropdown-item ${selectedOutputDeviceId === "" ? "active" : ""}`}
                                        onClick={() => {
                                          setSelectedOutputDeviceId("");
                                          setIsOutputMenuOpen(false);
                                        }}
                                        title="Standard des Systems"
                                      >
                                        Standard des Systems
                                      </button>
                                      {outputDevices.map((d) => (
                                        <button
                                          type="button"
                                          key={d.deviceId}
                                          className={`mic-dropdown-item ${d.deviceId === selectedOutputDeviceId ? "active" : ""}`}
                                          onClick={() => {
                                            setSelectedOutputDeviceId(
                                              d.deviceId,
                                            );
                                            setIsOutputMenuOpen(false);
                                          }}
                                          title={
                                            d.label ||
                                            `Ausgang ${d.deviceId.slice(0, 6)}`
                                          }
                                        >
                                          {d.label ||
                                            `Ausgang ${d.deviceId.slice(0, 6)}`}
                                        </button>
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                                {!outputSelectionSupported ? (
                                  <small>
                                    Dieser Browser kann den Lautsprecher nicht
                                    wählen; es wird der Standard des Systems genutzt.
                                  </small>
                                ) : null}
                              </div>
                            </div>

                            <div
                              className={`audio-gate-card ${
                                audioControlsLowPowerMode
                                  ? "disabled"
                                  : audioGateEnabled
                                    ? "active"
                                    : ""
                              }`}
                            >
                              <div className="audio-gate-header">
                                <div>
                                  <span>Bearbeitung</span>
                                  <h4>Rauschsperre</h4>
                                </div>
                                <label className="audio-gate-switch">
                                  <input
                                    type="checkbox"
                                    aria-label="Rauschsperre"
                                    checked={
                                      audioControlsLowPowerMode
                                        ? false
                                        : audioGateEnabled
                                    }
                                    disabled={audioControlsLowPowerMode}
                                    onChange={(event) =>
                                      onAudioGateEnabledChange(
                                        event.currentTarget.checked,
                                      )
                                    }
                                  />
                                  <span
                                    className="station-setting-toggle"
                                    aria-hidden="true"
                                  />
                                </label>
                              </div>
                              <p className="audio-gate-copy">
                                Blendet leise Hintergrundgeräusche vor der Verstärkung aus.
                              </p>
                              <div className="audio-gate-readout">
                                <span>Schwelle</span>
                                <strong>
                                  {formatGateThresholdDb(audioGateThresholdDb)}
                                </strong>
                              </div>
                              <div className="station-gain-control input-gain-control audio-gate-slider">
                                <label htmlFor="input-gate-threshold">
                                  <span>Schwelle der Rauschsperre</span>
                                  <strong>
                                    {formatGateThresholdDb(
                                      audioGateThresholdDb,
                                    )}
                                  </strong>
                                </label>
                                <input
                                  id="input-gate-threshold"
                                  type="range"
                                  min={GATE_THRESHOLD_DBFS_MIN}
                                  max={GATE_THRESHOLD_DBFS_MAX}
                                  step={1}
                                  value={audioGateThresholdDb}
                                  disabled={
                                    audioControlsLowPowerMode || !audioGateEnabled
                                  }
                                  style={
                                    {
                                      "--fill": `${gateThresholdDbToPercent(audioGateThresholdDb)}%`,
                                    } as React.CSSProperties
                                  }
                                  onChange={(event) =>
                                    onAudioGateThresholdDbChange(
                                      Number(event.currentTarget.value),
                                    )
                                  }
                                  aria-label="Schwelle der Rauschsperre"
                                />
                              </div>
                              <div className="audio-gate-scale" aria-hidden="true">
                                <span>Offen</span>
                                <span>Streng</span>
                              </div>
                              <small className="audio-gate-status">
                                {audioControlsLowPowerMode
                                  ? "Im Stromsparmodus ist die Rauschsperre aus."
                                  : audioGateEnabled
                                    ? "Rauschsperre aktiv"
                                    : "Rauschsperre aus"}
                              </small>
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div
                        className={`audio-subsection ${isChannelAudioFeedsOpen ? "" : "collapsed"}`}
                      >
                        <button
                          type="button"
                          className="audio-subsection-toggle"
                          onClick={() =>
                            setIsChannelAudioFeedsOpen((value) => !value)
                          }
                          aria-expanded={isChannelAudioFeedsOpen}
                        >
                          Audio-Zuspielungen
                          <ChevronIcon
                            className={`chev ${isChannelAudioFeedsOpen ? "open" : ""}`}
                          />
                        </button>
                        {isChannelAudioFeedsOpen ? (
                          <div className="audio-subsection-body channel-audio-feed-section">
                            <div className="channel-audio-feed-toolbar">
                              <div>
                                <strong>Audio-Zuspielungen</strong>
                                <small>
                                  Hier stehen nur Zuspielungen deiner aktuellen
                                  Rolle.
                                </small>
                              </div>
                              <button
                                type="button"
                                className="shortcut-btn shortcut-btn-primary"
                                onClick={() => openChannelAudioFeedEditor()}
                              >
                                Neuer Feed
                              </button>
                            </div>
                            {channelAudioFeeds.length === 0 ? (
                              <p className="station-empty">
                                Für diese Rolle gibt es noch keine Zuspielungen.
                              </p>
                            ) : (
                              <div className="channel-audio-feed-list">
                                {channelAudioFeeds.map((feed) => {
                                  const inputCount = feedInputChannelCount(
                                    feed.inputDeviceId,
                                  );
                                  const inputValue =
                                    feedInputChannelValue(feed);
                                  const inputLabel =
                                    inputValue === "all"
                                      ? feedAllInputsLabel(inputCount)
                                      : `Eingang ${inputValue}`;
                                  const status =
                                    channelAudioFeedStatusById.get(feed.id);
                                  return (
                                    <article
                                      key={feed.id}
                                      className="channel-audio-feed-card channel-audio-feed-summary-card"
                                    >
                                      <div className="channel-audio-feed-summary-main">
                                        <strong>
                                          {feed.name || "Feed ohne Namen"}
                                        </strong>
                                        <small>
                                          {feedRoomLabel(feed.roomId)}
                                        </small>
                                      </div>

                                      <div className="channel-audio-feed-summary-meta">
                                        <span>
                                          {feedDeviceLabel(feed.inputDeviceId)}
                                        </span>
                                        <span>{inputLabel}</span>
                                        <span
                                          className={`channel-audio-feed-status ${status?.state || "idle"}`}
                                        >
                                          {status?.state === "live"
                                            ? "Live"
                                            : status?.state === "starting"
                                              ? "Startet"
                                              : status?.state === "error"
                                                ? status.message ||
                                                  "Fehler"
                                                : feed.enabled
                                                  ? "Bereit"
                                                  : "Pausiert"}
                                        </span>
                                      </div>

                                      <div className="channel-audio-feed-summary-actions">
                                        <button
                                          type="button"
                                          className="shortcut-btn"
                                          onClick={() =>
                                            openChannelAudioFeedEditor(feed)
                                          }
                                        >
                                          Bearbeiten
                                        </button>
                                        <button
                                          type="button"
                                          className="shortcut-btn shortcut-btn-clear"
                                          onClick={() =>
                                            onRemoveChannelAudioFeed(feed.id)
                                          }
                                        >
                                          Entfernen
                                        </button>
                                      </div>
                                    </article>
                                  );
                                })}
                              </div>
                            )}
                            {channelAudioFeedEditor ? (
                              <div
                                className="channel-audio-room-editor-backdrop"
                                onClick={() => {
                                  if (!channelAudioFeedSaveBusy) {
                                    setChannelAudioFeedEditor(null);
                                  }
                                }}
                              >
                                <form
                                  className="channel-audio-room-editor channel-audio-feed-editor"
                                  role="dialog"
                                  aria-modal="true"
                                  aria-label={
                                    channelAudioFeedEditor.mode === "create"
                                      ? "Neuer Feed"
                                      : "Feed bearbeiten"
                                  }
                                  onClick={(event) => event.stopPropagation()}
                                  onSubmit={(event) => {
                                    event.preventDefault();
                                    void saveChannelAudioFeedEditor();
                                  }}
                                >
                                  <header className="channel-audio-room-editor-header">
                                    <div>
                                      <h4>
                                        {channelAudioFeedEditor.mode ===
                                        "create"
                                          ? "Neuer Feed"
                                          : "Feed bearbeiten"}
                                      </h4>
                                      <p>
                                        Lege den Eingang fest und welche Rollen
                                        auf dem zugehörigen Sprechkanal senden
                                        und hören dürfen.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      className="station-modal-close"
                                      onClick={() =>
                                        setChannelAudioFeedEditor(null)
                                      }
                                      disabled={channelAudioFeedSaveBusy}
                                      aria-label="Fenster schließen"
                                    >
                                      <CloseIcon />
                                    </button>
                                  </header>

                                  <div className="channel-audio-feed-editor-fields">
                                    <label className="streamdeck-control channel-audio-feed-name-control">
                                      <span>Name der Zuspielung *</span>
                                      <input
                                        type="text"
                                        value={channelAudioFeedEditor.name}
                                        onChange={(event) =>
                                          updateChannelAudioFeedEditor({
                                            name: event.currentTarget.value,
                                          })
                                        }
                                        placeholder="z. B. Musik"
                                        aria-invalid={
                                          channelAudioFeedSaveError !== "" &&
                                          channelAudioFeedEditor.name.trim() === ""
                                        }
                                      />
                                    </label>

                                    <div className="channel-audio-feed-derived-room">
                                      <span>Sprechkanal</span>
                                      <strong>
                                        {channelAudioFeedEditor.name.trim() ||
                                          "Wie der Name der Zuspielung"}
                                      </strong>
                                      <small>
                                        Der Sprechkanal bekommt automatisch den
                                        Namen der Zuspielung.
                                      </small>
                                    </div>

                                    <label className="streamdeck-control">
                                      <span>Eingangsgerät</span>
                                      <select
                                        value={
                                          channelAudioFeedEditor.inputDeviceId
                                        }
                                        onChange={(event) =>
                                          updateChannelAudioFeedEditor({
                                            inputDeviceId:
                                              event.currentTarget.value,
                                            inputChannel: "all",
                                          })
                                        }
                                      >
                                        <option value="">Standard des Systems</option>
                                        {inputDevices.map((device) => (
                                          <option
                                            key={device.deviceId}
                                            value={device.deviceId}
                                          >
                                            {device.label ||
                                              `Eingang ${device.deviceId.slice(0, 6)}`}
                                          </option>
                                        ))}
                                      </select>
                                    </label>

                                    <label className="streamdeck-control">
                                      <span>Eingang am Interface</span>
                                      <select
                                        aria-label="Eingang am Interface"
                                        value={channelAudioFeedEditorInputValue}
                                        onChange={(event) =>
                                          updateChannelAudioFeedEditor({
                                            inputChannel:
                                              event.currentTarget.value ===
                                              "all"
                                                ? "all"
                                                : Number(
                                                    event.currentTarget.value,
                                                  ),
                                          })
                                        }
                                      >
                                        <option value="all">
                                          {feedAllInputsLabel(
                                            channelAudioFeedEditorInputCount,
                                          )}
                                        </option>
                                        {channelAudioFeedEditorInputCount > 1
                                          ? Array.from(
                                              {
                                                length:
                                                  channelAudioFeedEditorInputCount,
                                              },
                                              (_, channelIndex) => (
                                                <option
                                                  key={`feed-editor-input-${channelIndex + 1}`}
                                                  value={channelIndex + 1}
                                                >
                                                  Eingang {channelIndex + 1}
                                                </option>
                                              ),
                                            )
                                          : null}
                                      </select>
                                    </label>

                                    <label className="streamdeck-control">
                                      <span>Priorität</span>
                                      <select
                                        value={
                                          channelAudioFeedEditor.priorityLevel
                                        }
                                        onChange={(event) =>
                                          updateChannelAudioFeedEditor({
                                            priorityLevel: Number(
                                              event.currentTarget.value,
                                            ),
                                          })
                                        }
                                      >
                                        <option value={0}>Niedrig</option>
                                        <option value={1}>Normal</option>
                                        <option value={2}>Hoch</option>
                                        <option value={3}>Kritisch</option>
                                      </select>
                                    </label>

                                    <label className="channel-audio-feed-enabled channel-audio-feed-editor-enabled">
                                      <input
                                        type="checkbox"
                                        checked={channelAudioFeedEditor.enabled}
                                        onChange={(event) =>
                                          updateChannelAudioFeedEditor({
                                            enabled:
                                              event.currentTarget.checked,
                                          })
                                        }
                                      />
                                      <span>Senden</span>
                                    </label>
                                  </div>

                                  <div className="station-gain-control input-gain-control channel-audio-feed-gain">
                                    <label htmlFor="channel-feed-editor-gain">
                                      {gainToDbLabel(
                                        channelAudioFeedEditor.gain,
                                        INPUT_DB_MAX,
                                      )}
                                    </label>
                                    <input
                                      id="channel-feed-editor-gain"
                                      type="range"
                                      min={MUTE_POS}
                                      max={INPUT_DB_MAX}
                                      step={1}
                                      value={gainToSlider(
                                        channelAudioFeedEditor.gain,
                                        INPUT_DB_MAX,
                                      )}
                                      style={
                                        {
                                          "--fill": `${sliderFillPercent(channelAudioFeedEditor.gain, INPUT_DB_MAX)}%`,
                                        } as React.CSSProperties
                                      }
                                      onChange={(event) =>
                                        updateChannelAudioFeedEditor({
                                          gain: sliderToGain(
                                            Number(event.currentTarget.value),
                                            INPUT_DB_MAX,
                                          ),
                                        })
                                      }
                                      aria-label="Verstärkung der Zuspielung"
                                    />
                                  </div>

                                  <div className="channel-audio-room-role-grid">
                                    {(
                                      [
                                        ["senderRoleIds", "Darf senden"],
                                        ["receiverRoleIds", "Darf hören"],
                                        ["forcedListenRoleIds", "Hört immer"],
                                      ] as const
                                    ).map(([key, label]) => (
                                      <fieldset
                                        key={key}
                                        className="channel-audio-room-role-group"
                                      >
                                        <legend>{label}</legend>
                                        {appData.roles.map((role) => {
                                          const isRequiredSenderRole =
                                            key === "senderRoleIds" &&
                                            role.id === appData.self.roleId;
                                          return (
                                            <label
                                              key={`${key}-${role.id}`}
                                              className={`channel-audio-room-role-option ${
                                                isRequiredSenderRole
                                                  ? "locked"
                                                  : ""
                                              }`}
                                              title={
                                                isRequiredSenderRole
                                                  ? "Deine Rolle muss diese Zuspielung senden dürfen."
                                                  : undefined
                                              }
                                            >
                                              <input
                                                type="checkbox"
                                                checked={
                                                  isRequiredSenderRole ||
                                                  channelAudioFeedEditor[
                                                    key
                                                  ].includes(role.id)
                                                }
                                                disabled={isRequiredSenderRole}
                                                onChange={() =>
                                                  toggleChannelAudioFeedEditorRole(
                                                    key,
                                                    role.id,
                                                  )
                                                }
                                              />
                                              <span>{role.name}</span>
                                            </label>
                                          );
                                        })}
                                      </fieldset>
                                    ))}
                                  </div>

                                  {channelAudioFeedSaveError ? (
                                    <p className="streamdeck-error">
                                      {channelAudioFeedSaveError}
                                    </p>
                                  ) : null}

                                  <footer className="channel-audio-room-editor-actions">
                                    <button
                                      type="button"
                                      className="shortcut-btn shortcut-btn-clear"
                                      onClick={() =>
                                        setChannelAudioFeedEditor(null)
                                      }
                                      disabled={channelAudioFeedSaveBusy}
                                    >
                                      Abbrechen
                                    </button>
                                    <button
                                      type="submit"
                                      className="shortcut-btn shortcut-btn-primary"
                                      disabled={channelAudioFeedSaveBusy}
                                    >
                                      {channelAudioFeedSaveBusy
                                        ? "Speichere …"
                                        : "Speichern"}
                                    </button>
                                  </footer>
                                </form>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
                </section>
                ) : null}

                {activeSettingsPage === "system" ? (
                <section
                  className="station-settings-section station-settings-card station-settings-version"
                >
                  <SettingsSectionHeader
                    icon="info"
                    eyebrow="Programm"
                    title="App-Version"
                  />
                  <div className="station-settings-version-grid">
                    <SettingsStatusCard
                      label="Version"
                      value={appData.appVersion.version}
                    />
                    <SettingsStatusCard
                      label="Erstellt"
                      value={appData.appVersion.buildTimestamp}
                    />
                  </div>
                </section>
                ) : null}

              <p className="station-modal-hint">
                Diese Einstellungen gelten nur für dich auf diesem Gerät.
              </p>
        </StationSettingsFrame>
      ) : null}
    </div>
  );

  if (!inShell || !shell) return stationView;
  return (
    <AppShell
      user={shell.user}
      fit={!isUserSettingsOpen}
      items={[
        {
          id: "intercom",
          label: "Intercom",
          icon: "intercom",
          active: !isUserSettingsOpen,
          onSelect: () => setIsUserSettingsOpen(false),
        },
        {
          id: "settings",
          label: "Einstellungen",
          icon: "settings",
          active: isUserSettingsOpen,
          onSelect: () => setIsUserSettingsOpen(true),
        },
      ]}
      status={
        <div className="k-station-status">
          <div className="k-station-who">
            <strong>{stationRoleLabel}</strong>
            <span>{stationLiveLabel}</span>
          </div>
          {liveBadge}
          {micStats}
        </div>
      }
    >
      {stationView}
    </AppShell>
  );
}
