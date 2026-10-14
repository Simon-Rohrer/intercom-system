/** Admin navigation: one entry per section shown in the sidebar. */
export type AdminSectionId =
  | "showfile"
  | "roles"
  | "users"
  | "rooms"
  | "channels"
  | "routing"
  | "companion"
  | "streamdeck"
  | "telegram"
  | "chat"
  | "logs"
  | "status"
  | "security";

export type AdminSectionInfo = {
  id: AdminSectionId;
  label: string;
  group: string;
  description: string;
};

export const ADMIN_SECTIONS: AdminSectionInfo[] = [
  { id: "showfile", group: "Setup", label: "Showfile", description: "Komplette Konfiguration als Snapshot importieren und exportieren." },
  { id: "roles", group: "Setup", label: "Rollen", description: "Arbeitsplätze, ihre Standard-Party-Line und Voreinstellungen." },
  { id: "users", group: "Setup", label: "Benutzer", description: "Angemeldete und bekannte Benutzer verwalten." },
  { id: "rooms", group: "Setup", label: "Party Lines", description: "Wer auf welcher Leitung sprechen und hören darf. Feste Hörer können Listen nicht abwählen." },
  { id: "channels", group: "Setup", label: "Kanäle", description: "Audio-Kanäle und Broadcast-Gruppen." },
  { id: "routing", group: "Setup", label: "Routing", description: "Übersicht, welche Rolle wohin sendet und woher sie hört." },
  { id: "companion", group: "Geräte", label: "Companion", description: "Companion-Anbindung und Seiten-Konfiguration." },
  { id: "streamdeck", group: "Geräte", label: "Stream Deck", description: "Stream-Deck-Profile der Rollen." },
  { id: "telegram", group: "Dienste", label: "Telegram", description: "Bot, Gruppen-Zuordnung und Telegram-Benutzer." },
  { id: "chat", group: "Dienste", label: "Chatverlauf", description: "Chatverlauf einsehen und aufräumen." },
  { id: "status", group: "Betrieb", label: "Live-Zustand", description: "Verbindungen, Audio und Raspberry Pis – live alle 2 Sekunden." },
  { id: "logs", group: "Betrieb", label: "Logs", description: "Admin- und Laufzeit-Logs durchsuchen." },
  { id: "security", group: "Betrieb", label: "Admin-PIN", description: "PIN für den Admin-Bereich ändern." },
];
