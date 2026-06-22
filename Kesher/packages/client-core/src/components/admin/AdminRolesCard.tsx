import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, Role } from "../../types";
import { createRole, deleteRole, duplicateRole, updateRole } from "../../api";
import { useAdminAction } from "./useAdminAction";

type AdminRolesCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

type RoleEditorMode = "create" | "edit" | "duplicate";

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
  const usedNames = new Set(roles.map((role) => role.name.trim().toLowerCase()));
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
  const [isOpen, setIsOpen] = useState(false);
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
      ? "Create role"
      : roleEditor?.mode === "duplicate"
        ? "Duplicate role"
        : "Edit role";
  const roleEditorDescription =
    roleEditor?.mode === "duplicate"
      ? "Review the copied role settings and adjust them before saving."
      : roleEditor?.mode === "create"
        ? "Enter the role details and defaults."
        : "Update the role details and defaults.";

  return (
    <div className="admin-card">
      <div className="admin-card-header">
        <div className="admin-card-title">Configuration · Roles</div>
        <div className="admin-card-actions">
          <button
            className="admin-toggle-button"
            onClick={() => setIsOpen((value) => !value)}
            aria-expanded={isOpen}
          >
            {isOpen ? "Hide" : "Show"}
          </button>
        </div>
      </div>
      {isOpen ? (
        <div className="admin-card-body">
          <div className="admin-block">
            <div className="admin-block-header">
              <h4>Roles ({appData.roles.length})</h4>
              <button
                type="button"
                className="secondary"
                onClick={openCreateRole}
                disabled={adminBusy}
              >
                Create role
              </button>
            </div>
            {adminError && !roleEditor ? (
              <p className="admin-error">{adminError}</p>
            ) : null}
            <ul className="admin-list">
              {appData.roles.map((role) => (
                <li key={role.id} className="admin-role-list-item">
                  <span>
                    {role.name} <small>({role.id})</small>
                  </span>
                  <div className="admin-role-list-actions">
                    <button
                      type="button"
                      className="secondary admin-role-duplicate"
                      aria-label={`Duplicate role ${role.name}`}
                      title={`Duplicate ${role.name}`}
                      disabled={adminBusy}
                      onClick={() => openDuplicateRole(role)}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="8" y="8" width="11" height="11" rx="2" />
                        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
                      </svg>
                      <span>Duplicate</span>
                    </button>
                    <button
                      type="button"
                      disabled={adminBusy}
                      onClick={() => openEditRole(role)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRoleConfig(role.id)}
                      disabled={adminBusy}
                      className="delete"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
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
                <p id="admin-role-modal-description">
                  {roleEditorDescription}
                </p>
              </div>
              <button
                type="button"
                className="admin-role-modal-close"
                aria-label="Close role dialog"
                title="Close"
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
                  <span>Role ID</span>
                  <input
                    value={roleEditor.id}
                    onChange={(event) =>
                      updateRoleEditor({ id: event.target.value })
                    }
                    placeholder="role-id"
                    readOnly={roleEditor.mode === "edit"}
                    autoFocus={roleEditor.mode !== "edit"}
                    required
                  />
                </label>
                <label>
                  <span>Role name</span>
                  <input
                    value={roleEditor.name}
                    onChange={(event) =>
                      updateRoleEditor({ name: event.target.value })
                    }
                    placeholder="Role name"
                    autoFocus={roleEditor.mode === "edit"}
                    required
                  />
                </label>
                <label>
                  <span>Default Talk party line</span>
                  <select
                    value={roleEditor.defaultRoomId}
                    onChange={(event) =>
                      updateRoleEditor({ defaultRoomId: event.target.value })
                    }
                  >
                    <option value="">No default party line</option>
                    {appData.rooms.map((room) => (
                      <option key={`role-room-${room.id}`} value={room.id}>
                        {room.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Default audio mode</span>
                  <select
                    value={roleEditor.defaultVoiceMode}
                    onChange={(event) =>
                      updateRoleEditor({
                        defaultVoiceMode: event.target.value as
                          | "always_on"
                          | "ptt"
                          | "",
                      })
                    }
                  >
                    <option value="">No default audio mode</option>
                    <option value="always_on">Always on</option>
                    <option value="ptt">PTT</option>
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
                  <span>Default to simple mobile view</span>
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
                  Cancel
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
                  {adminBusy ? "Saving…" : "Save"}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}
