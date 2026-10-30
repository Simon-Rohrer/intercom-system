import React from "react";
import { multiviewRolesUrl } from "./AdminRolesCard";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminPinCardProps = {
  central?: boolean;
  onUpdateAdminPin: (currentPin: string, newPin: string) => Promise<void>;
};

export function AdminPinCard({ onUpdateAdminPin, central = false }: AdminPinCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  const [pinCurrentInput, setPinCurrentInput] = React.useState("");
  const [pinNewInput, setPinNewInput] = React.useState("");
  const [pinConfirmInput, setPinConfirmInput] = React.useState("");
  const [pinMessage, setPinMessage] = React.useState("");
  const [pinMessageType, setPinMessageType] = React.useState<
    "success" | "error" | ""
  >("");
  const [pinBusy, setPinBusy] = React.useState(false);

  const handleUpdatePin = async () => {
    setPinMessage("");
    setPinMessageType("");
    if (!pinNewInput.trim()) {
      setPinMessage("Die neue PIN darf nicht leer sein.");
      setPinMessageType("error");
      return;
    }
    if (pinNewInput !== pinConfirmInput) {
      setPinMessage("Neue PIN und Bestätigung stimmen nicht überein.");
      setPinMessageType("error");
      return;
    }
    setPinBusy(true);
    try {
      await onUpdateAdminPin(pinCurrentInput.trim(), pinNewInput.trim());
      setPinMessage("✓ Admin PIN updated successfully.");
      setPinMessageType("success");
      setPinCurrentInput("");
      setPinNewInput("");
      setPinConfirmInput("");
    } catch {
      setPinMessage("✗ PIN konnte nicht geändert werden.");
      setPinMessageType("error");
    } finally {
      setPinBusy(false);
    }
  };

  if (central) return (
    <div className="admin-card">
      <div className="admin-card-body">
        <div className="admin-roles-overlay-card" role="note">
          <h3>Admin-PIN wird in JMS Control verwaltet</h3>
          <p>Das Admin-Passwort wird zentral in JMS Control unter Benutzer &amp; Rechte → Admin-PIN festgelegt und geändert. Es gilt auch für die Admin-Anmeldung in Kesher.</p>
          <a className="button primary admin-roles-overlay-link" href={multiviewRolesUrl().replace("#/zugang/rollen", "#/einstellungen/zugang/anmeldung")}>
            Admin-Passwort in JMS Control ändern
          </a>
        </div>
      </div>
    </div>
  );

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Admin-PIN"
        isOpen={isOpen}
        onToggle={() => setIsOpen((v) => !v)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-pin-form">
            <div className="admin-pin-field">
              <label htmlFor="pin-current">Aktuelle PIN</label>
              <input
                id="pin-current"
                type="password"
                value={pinCurrentInput}
                onChange={(e) => setPinCurrentInput(e.target.value)}
                placeholder="Aktuelle PIN eingeben"
              />
            </div>
            <div className="admin-pin-field">
              <label htmlFor="pin-new">Neue PIN</label>
              <input
                id="pin-new"
                type="password"
                value={pinNewInput}
                onChange={(e) => setPinNewInput(e.target.value)}
                placeholder="Neue PIN eingeben"
              />
            </div>
            <div className="admin-pin-field">
              <label htmlFor="pin-confirm">PIN bestätigen</label>
              <input
                id="pin-confirm"
                type="password"
                value={pinConfirmInput}
                onChange={(e) => setPinConfirmInput(e.target.value)}
                placeholder="Neue PIN wiederholen"
              />
            </div>
          </div>
          <div className="admin-pin-actions">
            <button
              onClick={() => {
                void handleUpdatePin();
              }}
              className="primary"
              disabled={pinBusy}
            >
              PIN ändern
            </button>
            {pinMessage ? (
              <div
                className={`admin-pin-message admin-pin-message-${pinMessageType}`}
              >
                {pinMessage}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
