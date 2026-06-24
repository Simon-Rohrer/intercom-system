import { useCallback, useMemo, useState } from "react";
import type { Bootstrap, Room, Role } from "../../types";
import { updateRoutingMatrix, type RoutingMatrixEntry } from "../../api";
import { AdminCardHeader } from "./AdminCardHeader";

type AdminRoutingMatrixCardProps = {
  token: string;
  adminPin: string;
  appData: Bootstrap;
  refreshBootstrapData: () => Promise<void>;
};

type CellState = {
  talk: boolean;
  defaultTalk: boolean;
  listen: boolean;
  forced: boolean;
};

/** Build a map of roleId → roomId → { talk, defaultTalk, listen, forced } from bootstrap data. */
function buildMatrix(
  roles: Role[],
  rooms: Room[],
): Record<string, Record<string, CellState>> {
  const matrix: Record<string, Record<string, CellState>> = {};
  for (const role of roles) {
    matrix[role.id] = {};
    for (const room of rooms) {
      matrix[role.id][room.id] = {
        talk: (room.senderRoleIds ?? []).includes(role.id),
        defaultTalk:
          role.defaultRoomId === room.id &&
          (room.senderRoleIds ?? []).includes(role.id),
        listen: (room.receiverRoleIds ?? []).includes(role.id),
        forced: (room.forcedListenRoleIds ?? []).includes(role.id),
      };
    }
  }
  return matrix;
}

/** Convert local matrix state back to per-room entries suitable for the API. */
function matrixToEntries(
  matrix: Record<string, Record<string, CellState>>,
  roles: Role[],
  rooms: Room[],
): RoutingMatrixEntry[] {
  return rooms.map((room) => {
    const senderRoleIds: string[] = [];
    const defaultTalkRoleIds: string[] = [];
    const receiverRoleIds: string[] = [];
    const forcedListenRoleIds: string[] = [];
    for (const role of roles) {
      const cell = matrix[role.id]?.[room.id];
      if (cell?.talk) senderRoleIds.push(role.id);
      if (cell?.defaultTalk) defaultTalkRoleIds.push(role.id);
      if (cell?.listen) receiverRoleIds.push(role.id);
      if (cell?.forced) forcedListenRoleIds.push(role.id);
    }
    return {
      roomId: room.id,
      senderRoleIds,
      defaultTalkRoleIds,
      receiverRoleIds,
      forcedListenRoleIds,
    };
  });
}

export function AdminRoutingMatrixCard({
  token,
  adminPin,
  appData,
  refreshBootstrapData,
}: AdminRoutingMatrixCardProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminError, setAdminError] = useState("");

  // Local working copy of the matrix (editable before saving)
  const serverMatrix = useMemo(
    () => buildMatrix(appData.roles, appData.rooms),
    [appData.roles, appData.rooms],
  );
  const [localMatrix, setLocalMatrix] = useState<
    Record<string, Record<string, CellState>>
  >(() => buildMatrix(appData.roles, appData.rooms));

  // Re-sync local matrix when server data changes (e.g. after save)
  const [prevRooms, setPrevRooms] = useState(appData.rooms);
  const [prevRoles, setPrevRoles] = useState(appData.roles);
  if (appData.rooms !== prevRooms || appData.roles !== prevRoles) {
    setPrevRooms(appData.rooms);
    setPrevRoles(appData.roles);
    setLocalMatrix(buildMatrix(appData.roles, appData.rooms));
  }

  const isDirty = useMemo(() => {
    for (const role of appData.roles) {
      for (const room of appData.rooms) {
        const local = localMatrix[role.id]?.[room.id];
        const server = serverMatrix[role.id]?.[room.id];
        if (!local || !server) continue;
        if (
          local.talk !== server.talk ||
          local.defaultTalk !== server.defaultTalk ||
          local.listen !== server.listen ||
          local.forced !== server.forced
        )
          return true;
      }
    }
    return false;
  }, [localMatrix, serverMatrix, appData.roles, appData.rooms]);

  const toggleCell = useCallback(
    (
      roleId: string,
      roomId: string,
      field: "talk" | "defaultTalk" | "listen" | "forced",
    ) => {
      setLocalMatrix((prev) => {
        const next = { ...prev };
        next[roleId] = { ...next[roleId] };
        const cur = next[roleId][roomId];
        const updated = { ...cur };

        if (field === "defaultTalk") {
          const hasOtherDefault = Object.entries(next[roleId]).some(
            ([candidateRoomId, candidate]) =>
              candidateRoomId !== roomId && candidate.defaultTalk,
          );
          if (cur.defaultTalk) {
            updated.defaultTalk = false;
          } else if (cur.talk && !hasOtherDefault) {
            updated.defaultTalk = true;
          }
        } else if (field === "forced") {
          updated.forced = !cur.forced;
          // Turning on forced → also enable listen
          if (updated.forced) updated.listen = true;
        } else if (field === "listen") {
          updated.listen = !cur.listen;
          // Turning off listen → also disable forced
          if (!updated.listen) updated.forced = false;
        } else {
          updated.talk = !cur.talk;
          if (!updated.talk) updated.defaultTalk = false;
        }

        next[roleId][roomId] = updated;
        return next;
      });
    },
    [],
  );

  const resetMatrix = useCallback(() => {
    setLocalMatrix(buildMatrix(appData.roles, appData.rooms));
  }, [appData.roles, appData.rooms]);

  async function saveMatrix() {
    setAdminBusy(true);
    setAdminError("");
    try {
      const entries = matrixToEntries(
        localMatrix,
        appData.roles,
        appData.rooms,
      );
      await updateRoutingMatrix(token, adminPin, entries);
      await refreshBootstrapData();
    } catch (error) {
      setAdminError(
        error instanceof Error ? error.message : "failed to save matrix",
      );
    } finally {
      setAdminBusy(false);
    }
  }

  if (appData.roles.length === 0 || appData.rooms.length === 0) {
    return null;
  }

  return (
    <div className="admin-card">
      <AdminCardHeader
        title="Routing Matrix"
        isOpen={isOpen}
        onToggle={() => setIsOpen((v) => !v)}
      />
      {isOpen ? (
        <div className="admin-card-body">
          {adminError ? <p className="admin-error">{adminError}</p> : null}

          <p className="routing-matrix-hint">
            Click <strong>T</strong>&thinsp;(Talk), <strong>D</strong>
            &thinsp;(Default Talk), <strong>L</strong>&thinsp;(Listen), or{" "}
            <strong>F</strong>&thinsp;(Forced listen). Each role can have only
            one Default Talk party line.
          </p>

          <div className="routing-matrix-wrapper">
            <table className="routing-matrix" role="grid">
              <thead>
                <tr>
                  <th className="routing-matrix-corner">Role ╲ Party Line</th>
                  {appData.rooms.map((room) => (
                    <th key={room.id} className="routing-matrix-col-header">
                      {room.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {appData.roles.map((role) => (
                  <tr key={role.id}>
                    <th className="routing-matrix-row-header">{role.name}</th>
                    {appData.rooms.map((room) => {
                      const cell = localMatrix[role.id]?.[room.id] ?? {
                        talk: false,
                        defaultTalk: false,
                        listen: false,
                        forced: false,
                      };
                      const roleHasDefaultTalk = appData.rooms.some(
                        (candidateRoom) =>
                          localMatrix[role.id]?.[candidateRoom.id]?.defaultTalk,
                      );
                      const defaultTalkUnavailable =
                        !cell.talk ||
                        (roleHasDefaultTalk && !cell.defaultTalk);
                      return (
                        <td key={room.id} className="routing-matrix-cell">
                          <button
                            type="button"
                            className={`routing-matrix-toggle routing-matrix-talk${cell.talk ? " active" : ""}`}
                            onClick={() => toggleCell(role.id, room.id, "talk")}
                            disabled={adminBusy}
                            aria-label={`Talk ${role.name} → ${room.name}: ${cell.talk ? "on" : "off"}`}
                            title={`Talk: ${cell.talk ? "ON" : "off"}`}
                          >
                            T
                          </button>
                          <button
                            type="button"
                            className={`routing-matrix-toggle routing-matrix-default-talk${cell.defaultTalk ? " active" : ""}${defaultTalkUnavailable ? " unavailable" : ""}`}
                            onClick={() =>
                              toggleCell(role.id, room.id, "defaultTalk")
                            }
                            disabled={adminBusy || defaultTalkUnavailable}
                            aria-label={`Default Talk ${role.name} → ${room.name}: ${cell.defaultTalk ? "on" : "off"}`}
                            title={
                              !cell.talk
                                ? "Enable Talk first"
                                : roleHasDefaultTalk && !cell.defaultTalk
                                  ? "This role already has a Default Talk party line"
                                  : `Default Talk: ${cell.defaultTalk ? "ON" : "off"}`
                            }
                          >
                            D
                          </button>
                          <button
                            type="button"
                            className={`routing-matrix-toggle routing-matrix-listen${cell.listen ? " active" : ""}`}
                            onClick={() =>
                              toggleCell(role.id, room.id, "listen")
                            }
                            disabled={adminBusy}
                            aria-label={`Listen ${role.name} → ${room.name}: ${cell.listen ? "on" : "off"}`}
                            title={`Listen: ${cell.listen ? "ON" : "off"}`}
                          >
                            L
                          </button>
                          <button
                            type="button"
                            className={`routing-matrix-toggle routing-matrix-forced${cell.forced ? " active" : ""}${!cell.listen ? " unavailable" : ""}`}
                            onClick={() =>
                              toggleCell(role.id, room.id, "forced")
                            }
                            disabled={adminBusy || !cell.listen}
                            aria-label={`Forced listen ${role.name} → ${room.name}: ${cell.forced ? "on" : "off"}`}
                            title={
                              cell.listen
                                ? `Forced listen: ${cell.forced ? "ON" : "off"}`
                                : "Enable Listen first"
                            }
                          >
                            F
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="routing-matrix-legend">
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-swatch routing-matrix-swatch-talk" />{" "}
              Talk
            </span>
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-swatch routing-matrix-swatch-default-talk" />{" "}
              Default Talk
            </span>
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-swatch routing-matrix-swatch-listen" />{" "}
              Listen
            </span>
            <span className="routing-matrix-legend-item">
              <span className="routing-matrix-swatch routing-matrix-swatch-forced" />{" "}
              Forced listen
            </span>
          </div>

          {isDirty ? (
            <div className="admin-form-actions" style={{ marginTop: "0.8rem" }}>
              <button
                onClick={() => void saveMatrix()}
                disabled={adminBusy}
                className="primary"
              >
                {adminBusy ? "Saving…" : "Save changes"}
              </button>
              <button
                onClick={resetMatrix}
                disabled={adminBusy}
                className="secondary"
              >
                Discard
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
