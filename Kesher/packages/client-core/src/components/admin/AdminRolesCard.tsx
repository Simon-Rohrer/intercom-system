import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Role } from "../../types";
import { createRole, deleteRole, duplicateRole, updateRole } from "../../api";
import { AdminCardHeader } from "./AdminCardHeader";
import { useAdminAction } from "./useAdminAction";
import { useAdminCardOpenState } from "./adminCardOpen";

type AdminRolesCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

type RoleEditorMode = "create" | "edit" | "duplicate";

/**
 * Roles page of JMS Control ("Benutzer & Rechte" → Rollen), where roles are
 * managed centrally:
 *   intercom.local / kesher.local → https://jmscontrol.local/
 *   *.jms.de                      → https://multiview.jms.de/
 *   IP address or other name      → https://<hostname>:8090/
 */
export function multiviewRolesUrl(loc: Pick<Location, "hostname"> = window.location): string {
  const host = loc.hostname.toLowerCase();
  let base: string;
  if (host === "intercom.local" || host === "kesher.local") {
    base = "https://jmscontrol.local/";
  } else if (host.endsWith(".jms.de")) {
    base = "https://multiview.jms.de/";
  } else {
    base = `https://${loc.hostname}:8090/`;
  }
  return `${base}#/zugang/rollen`;
}

type RoleEditorState = {
  mode: RoleEditorMode;
  sourceRoleId?: string;
  id: string;
  name: string;
  defaultRoomId: string;
  defaultVoiceMode: "always_on" | "ptt" | "";
  defaultSimpleView: boolean;
};

function splitRoleNameSequence(name: string): { base: string; number: number } {
  const trimmed = name.trim();
  const match = trimmed.match(/^(.*\S)\s+(\d+)$/);
  if (!match) return { base: trimmed, number: 1 };
  return { base: match[1].trim(), number: Number(match[2]) };
}

function duplicateRoleIdBase(id: string): string {
  return id.trim().replace(/[-_]?\d+$/, "") || id.trim();
}

function nextDuplicateRoleIdentity(
  source: Role,
  roles: Role[],
): Pick<RoleEditorState, "id" | "name"> {
  const { base: nameBase } = splitRoleNameSequence(source.name);
  const idBase = duplicateRoleIdBase(source.id);
  const usedNames = new Set(
    roles.map((role) => role.name.trim().toLowerCase()),
  );
  const usedIds = new Set(roles.map((role) => role.id.trim().toLowerCase()));
  let nextNumber = 2;

  for (const role of roles) {
    const sequence = splitRoleNameSequence(role.name);
    if (
      sequence.base.toLowerCase() === nameBase.toLowerCase() &&
      sequence.number >= nextNumber
    ) {
      nextNumber = sequence.number + 1;
    }
  }

  while (true) {
    const name = `${nameBase} ${nextNumber}`;
    const id = `${idBase}-${nextNumber}`;
    if (!usedNames.has(name.toLowerCase()) && !usedIds.has(id.toLowerCase())) {
      return { id, name };
    }
    nextNumber += 1;
  }
}

export function AdminRolesCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminRolesCardProps) {
  const [isOpen, setIsOpen] = useAdminCardOpenState();
  // JMS server: roles are created, renamed and deleted in JMS Control
  // (Benutzer & Rechte); here they are only shown, greyed out
  const central = !!appData.centralRoles;
  const [roleEditor, setRoleEditor] = useState<RoleEditorState | null>(null);
  const roleEditorTrigger = useRef<HTMLElement | null>(null);
  const {
    busy: adminBusy,
    error: adminError,
    setError: setAdminError,
    run: runAdminAction,
  } = useAdminAction({ onSuccess: refreshBootstrapData });

  const closeRoleEditor = useCallback(() => {
    if (adminBusy) return;
    setRoleEditor(null);
    setAdminError("");
    window.setTimeout(() => roleEditorTrigger.current?.focus(), 0);
  }, [adminBusy, setAdminError]);

  const roleEditorOpen = roleEditor !== null;
  useEffect(() => {
    if (!roleEditorOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRoleEditor();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeRoleEditor, roleEditorOpen]);

  function openRoleEditor(editor: RoleEditorState) {
    roleEditorTrigger.current = document.activeElement as HTMLElement | null;
    setAdminError("");
    setRoleEditor(editor);
  }

  function openCreateRole() {
    openRoleEditor({
      mode: "create",
      id: "",
      name: "",
      defaultRoomId: "",
      defaultVoiceMode: "",
      defaultSimpleView: false,
    });
  }

  function openEditRole(role: Role) {
    openRoleEditor({
      mode: "edit",
      id: role.id,
      name: role.name,
      defaultRoomId: role.defaultRoomId || "",
      defaultVoiceMode: role.defaultVoiceMode || "",
      defaultSimpleView: !!role.defaultSimpleView,
    });
  }

  function openDuplicateRole(role: Role) {
    const identity = nextDuplicateRoleIdentity(role, appData.roles);
    openRoleEditor({
      mode: "duplicate",
      sourceRoleId: role.id,
      ...identity,
      defaultRoomId: role.defaultRoomId || "",
      defaultVoiceMode: role.defaultVoiceMode || "",
      defaultSimpleView: !!role.defaultSimpleView,
    });
  }

  function updateRoleEditor(patch: Partial<RoleEditorState>) {
    setRoleEditor((current) => (current ? { ...current, ...patch } : current));
  }

  function saveRoleConfig() {
    if (!roleEditor) return;
    const id = roleEditor.id.trim();
    const name = roleEditor.name.trim();
    if (!id || !name) return;

    void runAdminAction(async () => {
      if (roleEditor.mode === "create") {
        await createRole(token, adminPin, {
          id,
          name,
          defaultRoomId: roleEditor.defaultRoomId.trim() || undefined,
          defaultVoiceMode: roleEditor.defaultVoiceMode || undefined,
          defaultSimpleView: roleEditor.defaultSimpleView,
        });
      } else if (roleEditor.mode === "edit") {
        await updateRole(token, adminPin, roleEditor.id, {
          name,
          defaultRoomId: roleEditor.defaultRoomId.trim() || undefined,
          defaultVoiceMode: roleEditor.defaultVoiceMode || undefined,
          defaultSimpleView: roleEditor.defaultSimpleView,
        });
      } else if (roleEditor.sourceRoleId) {
        await duplicateRole(token, adminPin, roleEditor.sourceRoleId, {
          id,
          name,
          defaultRoomId: roleEditor.defaultRoomId.trim(),
          defaultVoiceMode: roleEditor.defaultVoiceMode,
          defaultSimpleView: roleEditor.defaultSimpleView,
        });
      }
      setRoleEditor(null);
      window.setTimeout(() => roleEditorTrigger.current?.focus(), 0);
    });
  }

  function removeRoleConfig(id: string) {
    void runAdminAction(async () => {
      await deleteRole(token, adminPin, id);
    });
  }

  const roleEditorTitle =
    roleEditor?.mode === "create"
      ? "Rolle anlegen"
      : roleEditor?.mode === "duplicate"
        ? "Rolle duplizieren"
        : "Rolle bearbeiten";
  const roleEditorDescription =
    roleEditor?.mode === "duplicate"
      ? "Prüfe die kopierten Einstellungen und passe sie vor dem Speichern an."
      : roleEditor?.mode === "create"
        ? "Gib Kennung, Namen und Standardwerte der Rolle ein."
        : "Ändere Namen und Standardwerte der Rolle.";

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Rollen"
        isOpen={isOpen}
        onToggle={() => setIsOpen((value) => !value)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Rollen ({appData.roles.length})</h4>
              {central ? null : (
                <button
                  type="button"
                  className="secondary"
                  onClick={openCreateRole}
                  disabled={adminBusy}
                >
                  + Neue Rolle
                </button>
              )}
            </div>
            {adminError && !roleEditor ? (
              <p className="admin-error">{adminError}</p>
            ) : null}
            <div className={central ? "admin-roles-locked" : undefined}>
            <ul
              className={central ? "admin-list admin-roles-central" : "admin-list"}
              aria-disabled={central ? "true" : undefined}
            >
              {appData.roles.map((role) => (
                <li key={role.id} className="admin-role-list-item">
                  <span>
                    {role.name} <small>({role.id})</small>
                  </span>
                  <div className="admin-role-list-actions">
                    {central ? null : (
                      <button
                        type="button"
                        className="secondary admin-role-duplicate"
                        aria-label={`Rolle ${role.name} duplizieren`}
                        title={`${role.name} duplizieren`}
                        disabled={adminBusy}
                        onClick={() => openDuplicateRole(role)}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <rect x="8" y="8" width="11" height="11" rx="2" />
                          <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                        </svg>
                        <span>Duplizieren</span>
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={adminBusy || central}
                      onClick={() => openEditRole(role)}
                    >
                      Bearbeiten
                    </button>
                    {central ? null : (
                      <button
                        type="button"
                        onClick={() => removeRoleConfig(role.id)}
                        disabled={adminBusy}
                        className="delete"
                      >
                        Löschen
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {central ? (
              <div
                className="admin-roles-overlay"
                role="dialog"
                aria-modal="false"
                aria-labelledby="admin-roles-overlay-title"
              >
                <div className="admin-roles-overlay-card">
                  <h3 id="admin-roles-overlay-title">
                    Rollen werden in JMS Control verwaltet
                  </h3>
                  <p>
                    Rollen legst du in JMS Control unter Benutzer &amp; Rechte
                    an, benennst sie um oder löschst sie. Die Änderungen werden
                    automatisch nach Kesher übertragen.
                  </p>
                  <a
                    className="button primary admin-roles-overlay-link"
                    href={multiviewRolesUrl()}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Rechte in JMS Control anpassen
                  </a>
                </div>
              </div>
            ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {roleEditor ? (
        <div
          className="admin-role-modal-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) closeRoleEditor();
          }}
        >
          <section
            className="admin-role-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-role-modal-title"
            aria-describedby="admin-role-modal-description"
          >
            <header className="admin-role-modal-header">
              <div>
                <h3 id="admin-role-modal-title">{roleEditorTitle}</h3>
                <p id="admin-role-modal-description">{roleEditorDescription}</p>
              </div>
              <button
                type="button"
                className="admin-role-modal-close"
                aria-label="Fenster schließen"
                title="Schließen"
                disabled={adminBusy}
                onClick={closeRoleEditor}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </header>

            <form
              className="admin-role-modal-form"
              onSubmit={(event) => {
                event.preventDefault();
                saveRoleConfig();
              }}
            >
              <div className="admin-role-modal-fields">
                <label>
                  <span>Kennung der Rolle</span>
                  <input
                    value={roleEditor.id}
                    onChange={(event) =>
                      updateRoleEditor({ id: event.target.value })
                    }
                    placeholder="z. B. licht-2"
                    readOnly={roleEditor.mode === "edit"}
                    autoFocus={roleEditor.mode !== "edit"}
                    required
                  />
                </label>
                <label>
                  <span>Name der Rolle</span>
                  <input
                    value={roleEditor.name}
                    onChange={(event) =>
                      updateRoleEditor({ name: event.target.value })
                    }
                    placeholder="z. B. Licht 2"
                    autoFocus={roleEditor.mode === "edit" && !central}
                    readOnly={central && roleEditor.mode === "edit"}
                    title={
                      central
                        ? "Umbenennen in JMS Control unter „Benutzer & Rechte“"
                        : undefined
                    }
                    required
                  />
                </label>
                <label>
                  <span>Standard-Party-Line zum Sprechen</span>
                  <select
                    value={roleEditor.defaultRoomId}
                    onChange={(event) =>
                      updateRoleEditor({ defaultRoomId: event.target.value })
                    }
                  >
                    <option value="">Keine Standard-Party-Line</option>
                    {appData.rooms.map((room) => (
                      <option key={`role-room-${room.id}`} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Standard-Sprechmodus</span>
                  <select
                    value={roleEditor.defaultVoiceMode}
                    onChange={(event) =>
                      updateRoleEditor({
                        defaultVoiceMode: event.target.value as
                          "always_on" | "ptt" | "",
                      })
                    }
                  >
                    <option value="">Kein Standard-Sprechmodus</option>
                    <option value="always_on">Dauerhaft an</option>
                    <option value="ptt">Gedrückt halten zum Sprechen</option>
                  </select>
                </label>
                <label className="admin-checkbox admin-role-modal-checkbox">
                  <input
                    type="checkbox"
                    checked={roleEditor.defaultSimpleView}
                    onChange={(event) =>
                      updateRoleEditor({
                        defaultSimpleView: event.target.checked,
                      })
                    }
                  />
                  <span>Standardmäßig die einfache Handy-Ansicht zeigen</span>
                </label>
              </div>

              {adminError ? (
                <p className="admin-error admin-role-modal-error">
                  {adminError}
                </p>
              ) : null}

              <footer className="admin-role-modal-actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={adminBusy}
                  onClick={closeRoleEditor}
                >
                  Abbrechen
                </button>
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    adminBusy ||
                    !roleEditor.id.trim() ||
                    !roleEditor.name.trim()
                  }
                >
                  {adminBusy ? "Speichere …" : "Speichern"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
