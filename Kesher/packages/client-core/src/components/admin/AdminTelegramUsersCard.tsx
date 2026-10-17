import { useEffect, useState } from "react";
import {
  createTelegramAllowlistEntry,
  deleteTelegramAllowlistEntry,
  getTelegramAllowlist,
} from "../../api";
import type { TelegramAllowlistEntry } from "../../types";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminAction } from "./useAdminAction";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminTelegramUsersCardProps = {
  token: string;
  adminPin: string;
};

export function AdminTelegramUsersCard({
  token,
  adminPin,
}: AdminTelegramUsersCardProps) {
  const containsWhitespace = (value: string) => /\s/.test(value);
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  const [entries, setEntries] = useState<TelegramAllowlistEntry[]>([]);
  const {
    busy,
    error,
    run: runAction,
  } = useAdminAction({
    onSuccess: loadAllowlist,
    defaultErrorMessage: "Aktion fehlgeschlagen",
  });

  const [createTelegramUsername, setCreateTelegramUsername] = useState("");
  const [createKesherUsername, setCreateKesherUsername] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createValidationError, setCreateValidationError] = useState("");

  async function loadAllowlist() {
    try {
      const data = await getTelegramAllowlist(token, adminPin);
      setEntries(data);
    } catch (err) {
      console.error("Failed to load telegram allowlist:", err);
    }
  }

  useEffect(() => {
    if (isOpen) {
      void loadAllowlist();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  function resetCreateForm() {
    setCreateTelegramUsername("");
    setCreateKesherUsername("");
    setCreateValidationError("");
  }

  function handleCreate() {
    const telegramUsername = createTelegramUsername.trim();
    const kesherUsername = createKesherUsername.trim();
    if (!telegramUsername || !kesherUsername) return;
    if (containsWhitespace(telegramUsername) || containsWhitespace(kesherUsername)) {
      setCreateValidationError("Benutzernamen dürfen keine Leerzeichen enthalten.");
      return;
    }
    setCreateValidationError("");
    void runAction(async () => {
      await createTelegramAllowlistEntry(token, adminPin, {
        telegramUsername,
        kesherUsername,
      });
      resetCreateForm();
      setShowCreateForm(false);
    });
  }

  function handleDelete(id: string) {
    void runAction(async () => {
      await deleteTelegramAllowlistEntry(token, adminPin, id);
    });
  }

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Erlaubte Telegram-Benutzer"
        isOpen={isOpen}
        onToggle={() => setIsOpen((v) => !v)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block">
            <p>
              <strong>Zugang:</strong> Nur Telegram-Benutzer auf dieser Liste
              können mit dem Bot schreiben. Bei der ersten Nachricht wird ihre
              Telegram-ID fest mit dem Benutzernamen verknüpft.
            </p>
          </div>
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Erlaubte Benutzer</h4>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  if (showCreateForm) resetCreateForm();
                  setShowCreateForm((prev) => !prev);
                }}
                disabled={busy}
              >
                {showCreateForm ? "Abbrechen" : "Benutzer hinzufügen"}
              </button>
            </div>
            {error ? <p className="admin-error">{error}</p> : null}
            {showCreateForm ? (
              <div className="admin-edit-panel">
                <div className="admin-edit-title">Neuen Benutzer erlauben</div>
                <div className="admin-grid">
                  <input
                    value={createTelegramUsername}
                    onChange={(e) => {
                      setCreateTelegramUsername(stripWhitespace(e.target.value));
                      setCreateValidationError("");
                    }}
                    placeholder="Telegram-@Benutzername"
                  />
                  <input
                    value={createKesherUsername}
                    onChange={(e) => {
                      setCreateKesherUsername(stripWhitespace(e.target.value));
                      setCreateValidationError("");
                    }}
                    placeholder="Name in Kesher (z. B. Sarah)"
                  />
                </div>
                {createValidationError ? (
                  <p className="admin-error">{createValidationError}</p>
                ) : null}
                <div className="admin-form-actions">
                  <button
                    onClick={handleCreate}
                    disabled={
                      busy ||
                      !createTelegramUsername.trim() ||
                      !createKesherUsername.trim() ||
                      containsWhitespace(createTelegramUsername.trim()) ||
                      containsWhitespace(createKesherUsername.trim())
                    }
                  >
                    Benutzer hinzufügen
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      resetCreateForm();
                      setShowCreateForm(false);
                    }}
                    disabled={busy}
                    className="secondary"
                  >
                    Abbrechen
                  </button>
                </div>
              </div>
            ) : null}
            <ul className="admin-list">
              {entries.length === 0 ? (
                <li>
                  <span className="admin-empty">
                    Noch keine Benutzer eingetragen. Füge Benutzer hinzu, um den Zugang zu erlauben.
                  </span>
                </li>
              ) : (
                entries.map((entry) => (
                  <li key={entry.id}>
                    <span>
                      <strong>@{entry.telegramUsername}</strong> → {entry.kesherUsername}
                      {" "}
                      <small>
                        ({entry.status})
                        {entry.isBound && entry.telegramNumericId ? (
                          <> • ID: {entry.telegramNumericId}</>
                        ) : null}
                      </small>
                    </span>
                    <button onClick={() => handleDelete(entry.id)} disabled={busy}>
                      Entziehen
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
