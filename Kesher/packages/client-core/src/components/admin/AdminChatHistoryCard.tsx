import { useEffect, useState } from "react";
import { clearChatHistory, updateAckSettings } from "../../api";
import type { Bootstrap } from "../../types";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminChatHistoryCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

export function AdminChatHistoryCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminChatHistoryCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  const [busy, setBusy] = useState(false);
  const [busyAck, setBusyAck] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [ackEnabled, setAckEnabled] = useState(appData.ackEnabled);

  useEffect(() => {
    setAckEnabled(appData.ackEnabled);
  }, [appData.ackEnabled]);

  async function handleClear() {
    const confirmed = window.confirm(
      "Chatverlauf wirklich für alle verbundenen Geräte leeren?",
    );
    if (!confirmed) return;

    setBusy(true);
    setMessage("");
    setError("");
    try {
      await clearChatHistory(token, adminPin);
      setMessage("Chat-Verlauf wurde geleert.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chatverlauf konnte nicht geleert werden");
    } finally {
      setBusy(false);
    }
  }

  async function handleAckToggle(nextValue: boolean) {
    setBusyAck(true);
    setMessage("");
    setError("");
    try {
      const updated = await updateAckSettings(token, adminPin, nextValue);
      setAckEnabled(updated.enabled);
      setMessage(
        updated.enabled
          ? "ACK-Nachrichten sind jetzt aktiviert."
          : "ACK-Nachrichten sind jetzt deaktiviert.",
      );
      // Do not call refreshBootstrapData() here because it triggers an unnecessary room matrix resync
      // which causes the last chat message to be re-broadcasted. The config_updated WebSocket
      // message will update the ackEnabled state throughout the application.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Lesebestätigung konnte nicht gespeichert werden");
    } finally {
      setBusyAck(false);
    }
  }

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Chatverlauf"
        isOpen={isOpen}
        onToggle={() => setIsOpen((v) => !v)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block admin-chat-block">
            <div className="admin-block-header">
              <h4>ACK cues</h4>
              <span className={ackEnabled ? "admin-status-ok" : "admin-status-warn"}>
                {ackEnabled ? "Aktiv" : "Inaktiv"}
              </span>
            </div>

            <p>
              Schaltet Lesebestätigungen (ACK) im Chat für alle Geräte ein
              oder aus.
            </p>

            <label className="admin-chat-toggle-row">
              <input
                type="checkbox"
                checked={ackEnabled}
                disabled={busyAck}
                onChange={(e) => {
                  void handleAckToggle(e.target.checked);
                }}
              />
              <span>
                <strong>Lesebestätigungen aktivieren</strong>
                <small>Wenn aktiv, können Nachrichten im Chat bestätigt werden.</small>
              </span>
            </label>
          </div>

          <div className="admin-block admin-chat-block">
            <div className="admin-block-header">
              <h4>Verlauf bereinigen</h4>
            </div>
            <p>
              Leert den Chatverlauf aller Party Lines und Direktnachrichten,
              z. B. vor Beginn des Gottesdienstes.
            </p>
            <div className="admin-form-actions admin-chat-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  void handleClear();
                }}
                disabled={busy}
              >
                {busy ? "Lösche …" : "Für neuen Gottesdienst leeren"}
              </button>
            </div>
          </div>

          {message ? (
            <p className="admin-chat-message admin-chat-message-success">
              {message}
            </p>
          ) : null}

          {error ? <p className="admin-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
