import { useEffect, useMemo, useState } from "react";
import type {
  LoginConflict,
  PublicBootstrap,
  RaspberryPiRemoteCommandRequest,
  RaspberryPiRemoteStationStatus,
  Room,
} from "../types";

type LoginMode = "operator" | "raspberry";

type LoginViewProps = {
  publicData: PublicBootstrap;
  username: string;
  roleId: string;
  onUsernameChange: (value: string) => void;
  onRoleChange: (roleId: string) => void;
  onLogin: () => void;
  loginError?: string;
  adminPin: string;
  onAdminPinChange: (value: string) => void;
  onAdminLogin: () => void;
  adminError?: string;
  takeoverConflict: LoginConflict | null;
  onConfirmTakeover: () => void;
  onCancelTakeover: () => void;
  raspberryRemoteStations: RaspberryPiRemoteStationStatus[] | null;
  raspberryRemoteError?: string;
  raspberryRemoteCommandBusy?: boolean;
  raspberryRemoteCommandStatus?: string;
  raspberryRemoteCommandError?: string;
  onRaspberryRemoteCommand: (command: RaspberryPiRemoteCommandRequest) => void;
};

function RequiredFieldHint({
  id,
  children,
}: {
  id: string;
  children: string;
}) {
  return (
    <p id={id} className="login-required-hint">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v5" />
        <path d="M12 16h.01" />
      </svg>
      <span>{children}</span>
    </p>
  );
}

function roleNameFor(publicData: PublicBootstrap, roleId: string): string {
  return publicData.roles.find((role) => role.id === roleId)?.name || roleId;
}

function roomCanListen(room: Room, roleId: string): boolean {
  return (
    room.receiverRoleIds.includes(roleId) ||
    room.forcedListenRoleIds.includes(roleId)
  );
}

function roomCanTalk(room: Room, roleId: string): boolean {
  return room.senderRoleIds.includes(roleId);
}

function sortRemoteRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => {
    const priority = (b.priorityLevel ?? 0) - (a.priorityLevel ?? 0);
    if (priority !== 0) return priority;
    return a.name.localeCompare(b.name);
  });
}

export function LoginView({
  publicData,
  username,
  roleId,
  onUsernameChange,
  onRoleChange,
  onLogin,
  loginError,
  adminPin,
  onAdminPinChange,
  onAdminLogin,
  adminError,
  takeoverConflict,
  onConfirmTakeover,
  onCancelTakeover,
  raspberryRemoteStations,
  raspberryRemoteError,
  raspberryRemoteCommandBusy,
  raspberryRemoteCommandStatus,
  raspberryRemoteCommandError,
  onRaspberryRemoteCommand,
}: LoginViewProps) {
  const stripWhitespace = (value: string) => value.replace(/\s+/g, "");
  const [showAdmin, setShowAdmin] = useState(false);
  const [loginMode, setLoginMode] = useState<LoginMode>("operator");
  const [selectedPiDeviceId, setSelectedPiDeviceId] = useState("");
  const [selectedRoomId, setSelectedRoomId] = useState("");
  const [remotePttPressed, setRemotePttPressed] = useState(false);
  const activeRoleIds = new Set(publicData.activeRoleIds);
  const availableRoles = publicData.roles.filter(
    (role) => !activeRoleIds.has(role.id),
  );
  const selectedRoleIsAvailable = availableRoles.some(
    (role) => role.id === roleId,
  );
  const usernameMissing = !username.trim();
  const roleMissing = !roleId || !selectedRoleIsAvailable;
  const roleHintText =
    availableRoles.length === 0
      ? "No roles are available right now."
      : roleId && !selectedRoleIsAvailable
        ? "The selected role is no longer available."
        : "Select a role to continue.";
  const joinDisabled = usernameMissing || roleMissing;
  const remoteStations = raspberryRemoteStations ?? [];
  const selectedStation = useMemo(
    () =>
      remoteStations.find((station) => station.deviceId === selectedPiDeviceId) ??
      null,
    [remoteStations, selectedPiDeviceId],
  );
  const selectedStationRoleId =
    selectedStation?.intercomRoleId || selectedStation?.roleId || "";
  const remoteRooms = useMemo(() => {
    if (!selectedStationRoleId) return [];
    return sortRemoteRooms(
      publicData.rooms.filter(
        (room) =>
          roomCanTalk(room, selectedStationRoleId) ||
          roomCanListen(room, selectedStationRoleId),
      ),
    );
  }, [publicData.rooms, selectedStationRoleId]);
  const selectedRoom =
    remoteRooms.find((room) => room.id === selectedRoomId) ?? null;
  const selectedRoomCanTalk =
    selectedRoom && selectedStationRoleId
      ? roomCanTalk(selectedRoom, selectedStationRoleId)
      : false;
  const pttDisabled =
    !selectedStation || !selectedRoom || !selectedRoomCanTalk || remotePttPressed;

  useEffect(() => {
    if (loginMode !== "raspberry") return;
    if (remoteStations.length === 0) {
      setSelectedPiDeviceId("");
      return;
    }
    if (!remoteStations.some((station) => station.deviceId === selectedPiDeviceId)) {
      setSelectedPiDeviceId(remoteStations[0].deviceId);
    }
  }, [loginMode, remoteStations, selectedPiDeviceId]);

  useEffect(() => {
    if (remoteRooms.length === 0) {
      setSelectedRoomId("");
      return;
    }
    if (!remoteRooms.some((room) => room.id === selectedRoomId)) {
      setSelectedRoomId(remoteRooms[0].id);
    }
  }, [remoteRooms, selectedRoomId]);

  const selectRemoteRoom = (room: Room) => {
    if (!selectedStation || !selectedStationRoleId) return;
    const canListen = roomCanListen(room, selectedStationRoleId);
    const canTalk = roomCanTalk(room, selectedStationRoleId);
    if (!canListen && !canTalk) return;
    setSelectedRoomId(room.id);
    onRaspberryRemoteCommand({
      deviceId: selectedStation.deviceId,
      command: "set_room_matrix",
      listenRoomIds: canListen ? [room.id] : [],
      talkRoomIds: canTalk ? [room.id] : [],
    });
  };

  const sendRemotePtt = (state: "ptt_start" | "ptt_stop") => {
    if (!selectedStation || !selectedRoom || !selectedRoomCanTalk) return;
    onRaspberryRemoteCommand({
      deviceId: selectedStation.deviceId,
      command: "ptt",
      scope: "room",
      targetId: selectedRoom.id,
      state,
    });
  };

  const sendRemoteSessionCommand = (
    command: Omit<RaspberryPiRemoteCommandRequest, "deviceId">,
  ) => {
    if (!selectedStation) return;
    onRaspberryRemoteCommand({
      deviceId: selectedStation.deviceId,
      ...command,
    });
  };

  const startRemotePtt = () => {
    if (pttDisabled) return;
    setRemotePttPressed(true);
    sendRemotePtt("ptt_start");
  };

  const stopRemotePtt = () => {
    if (!remotePttPressed) return;
    setRemotePttPressed(false);
    sendRemotePtt("ptt_stop");
  };

  return (
    <div className="root login">
      <div className="login-card panel">
        <div className="login-card-head">
          <h1>Live Production Intercom</h1>
          <p className="variant-subtitle">Station Deck</p>
        </div>
        <div className="login-mode-tabs" role="tablist" aria-label="Login mode">
          <button
            type="button"
            className={loginMode === "operator" ? "is-active" : ""}
            onClick={() => setLoginMode("operator")}
            role="tab"
            aria-selected={loginMode === "operator"}
          >
            Operator
          </button>
          <button
            type="button"
            className={loginMode === "raspberry" ? "is-active" : ""}
            onClick={() => setLoginMode("raspberry")}
            role="tab"
            aria-selected={loginMode === "raspberry"}
          >
            Raspberry remote
          </button>
        </div>

        {loginMode === "operator" ? (
          <div className="login-form">
            <div
              className={`login-field${usernameMissing ? " is-required-missing" : ""}`}
            >
              <label htmlFor="login-username">
                <span className="login-label-text">Display name</span>
              </label>
              <input
                id="login-username"
                value={username}
                onChange={(e) => onUsernameChange(stripWhitespace(e.target.value))}
                placeholder="e.g. Tim FOH"
                required
                aria-invalid={usernameMissing ? "true" : undefined}
                aria-describedby={
                  usernameMissing ? "login-username-required" : undefined
                }
              />
              {usernameMissing ? (
                <RequiredFieldHint id="login-username-required">
                  Enter a display name to continue.
                </RequiredFieldHint>
              ) : null}
            </div>
            <div
              className={`login-field${roleMissing ? " is-required-missing" : ""}`}
            >
              <label htmlFor="login-role">
                <span className="login-label-text">Role</span>
              </label>
              <select
                id="login-role"
                value={roleId}
                onChange={(e) => onRoleChange(e.target.value)}
                required
                aria-invalid={roleMissing ? "true" : undefined}
                aria-describedby={roleMissing ? "login-role-required" : undefined}
              >
                <option value="">Select role</option>
                {availableRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                {availableRoles.length === 0 ? (
                  <option value="" disabled>
                    No roles available
                  </option>
                ) : null}
              </select>
              {roleMissing ? (
                <RequiredFieldHint id="login-role-required">
                  {roleHintText}
                </RequiredFieldHint>
              ) : null}
            </div>
            <button
              className="primary"
              onClick={onLogin}
              disabled={joinDisabled}
            >
              Join Intercom
            </button>
            {loginError ? <p className="login-error">{loginError}</p> : null}
            {takeoverConflict ? (
              <div className="login-admin-card" role="alert">
                <div className="login-admin-head">
                  <h3>Role currently in use</h3>
                </div>
                <p className="login-admin-note">
                  {takeoverConflict.conflictRoleName ||
                    takeoverConflict.conflictRoleId}
                  {" "}
                  is currently active
                  {takeoverConflict.conflictUsername
                    ? ` by ${takeoverConflict.conflictUsername}`
                    : ""}
                  . Confirm takeover to replace the existing session.
                </p>
                <div className="login-admin-actions">
                  <button className="primary" onClick={onConfirmTakeover}>
                    Confirm takeover
                  </button>
                  <button className="secondary" onClick={onCancelTakeover}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="login-remote-panel">
            <div className="login-remote-stations" aria-label="Active Raspberry Pis">
              {remoteStations.length === 0 ? (
                <div className="login-remote-empty">
                  {raspberryRemoteError || "No active Raspberry Pi stations."}
                </div>
              ) : (
                remoteStations.map((station) => {
                  const stationRoleId = station.intercomRoleId || station.roleId;
                  const selected = station.deviceId === selectedPiDeviceId;
                  return (
                    <button
                      key={station.deviceId}
                      type="button"
                      className={`login-remote-station${selected ? " is-active" : ""}`}
                      onClick={() => setSelectedPiDeviceId(station.deviceId)}
                    >
                      <span>
                        <strong>{station.name}</strong>
                        <span>{roleNameFor(publicData, stationRoleId)}</span>
                      </span>
                      <span className="login-remote-status">Connected</span>
                    </button>
                  );
                })
              )}
            </div>

            {selectedStation ? (
              <div className="login-remote-control">
                <div className="login-remote-control-head">
                  <div>
                    <span className="login-label-text">Remote target</span>
                    <strong>{selectedStation.name}</strong>
                  </div>
                  <span>{roleNameFor(publicData, selectedStationRoleId)}</span>
                </div>
                <div className="login-remote-room-grid">
                  {remoteRooms.map((room) => {
                    const canListen = roomCanListen(room, selectedStationRoleId);
                    const canTalk = roomCanTalk(room, selectedStationRoleId);
                    const selected = room.id === selectedRoomId;
                    return (
                      <button
                        key={room.id}
                        type="button"
                        className={`login-remote-room${selected ? " is-active" : ""}`}
                        onClick={() => selectRemoteRoom(room)}
                      >
                        <span>{room.name}</span>
                        <small>
                          {[canTalk ? "Talk" : "", canListen ? "Listen" : ""]
                            .filter(Boolean)
                            .join(" / ")}
                        </small>
                      </button>
                    );
                  })}
                </div>
                <div className="login-remote-settings">
                  <button
                    type="button"
                    onClick={() =>
                      sendRemoteSessionCommand({
                        command: "set_voice_mode",
                        mode: "ptt",
                      })
                    }
                  >
                    PTT mode
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      sendRemoteSessionCommand({
                        command: "set_voice_mode",
                        mode: "always_on",
                      })
                    }
                  >
                    Always on
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      sendRemoteSessionCommand({
                        command: "input_gain_delta",
                        volumeDelta: -3,
                      })
                    }
                  >
                    Gain -3 dB
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      sendRemoteSessionCommand({
                        command: "input_gain_delta",
                        volumeDelta: 3,
                      })
                    }
                  >
                    Gain +3 dB
                  </button>
                </div>
                <button
                  type="button"
                  className={`primary login-remote-ptt${remotePttPressed ? " is-pressed" : ""}`}
                  disabled={!selectedStation || !selectedRoom || !selectedRoomCanTalk}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    startRemotePtt();
                  }}
                  onPointerUp={stopRemotePtt}
                  onPointerCancel={stopRemotePtt}
                  onPointerLeave={stopRemotePtt}
                  onKeyDown={(event) => {
                    if (event.key !== " " && event.key !== "Enter") return;
                    if (remotePttPressed) return;
                    event.preventDefault();
                    startRemotePtt();
                  }}
                  onKeyUp={(event) => {
                    if (event.key !== " " && event.key !== "Enter") return;
                    event.preventDefault();
                    stopRemotePtt();
                  }}
                >
                  Hold to talk
                </button>
              </div>
            ) : null}
            {raspberryRemoteCommandError ? (
              <p className="login-error">{raspberryRemoteCommandError}</p>
            ) : null}
            {raspberryRemoteCommandStatus && !raspberryRemoteCommandError ? (
              <p className="login-success">
                {raspberryRemoteCommandBusy
                  ? "Sending command..."
                  : raspberryRemoteCommandStatus}
              </p>
            ) : null}
          </div>
        )}

        <div className="login-admin-disclosure">
          <button
            type="button"
            className="login-admin-disclosure-trigger"
            onClick={() => setShowAdmin((value) => !value)}
            aria-expanded={showAdmin}
            aria-controls="login-admin-panel"
            aria-label="Admin console"
          >
            <span className="login-admin-disclosure-label">
              <span>Admin console</span>
              <span className="login-admin-pin-hint">PIN required</span>
            </span>
            <svg
              className={`login-admin-chevron${showAdmin ? " is-open" : ""}`}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>

          {showAdmin ? (
            <div
              id="login-admin-panel"
              className="login-admin-card login-admin-disclosure-panel"
              role="region"
              aria-label="Admin console"
            >
              <p className="login-admin-note">
                For role and channel configuration only.
              </p>
              <label>
                <span className="login-label-text">Admin PIN</span>
                <input
                  type="password"
                  value={adminPin}
                  onChange={(e) => onAdminPinChange(e.target.value)}
                  placeholder="PIN"
                  autoComplete="off"
                />
              </label>
              {adminError ? <p className="login-error">{adminError}</p> : null}
              <div className="login-admin-actions">
                <button
                  className="primary"
                  onClick={onAdminLogin}
                  disabled={!adminPin.trim()}
                >
                  Open admin console
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
