export type CompanionState = {
  roleId?: string;
  username: string;
  bound: boolean;
  currentPageNumber?: number;
  profileVersion?: number;
  profileStatus?: string;
  profileUpdatedAt?: number;
  replyDirectUserId?: string;
  replyDirectUsername?: string;
  signalActive?: boolean;
  signalFrom?: string;
  signalMessage?: string;
  imageEffectMapJson?: string;
  variables?: Record<string, unknown>;
  presence?: {
    listenRooms: string[];
    talkRooms: string[];
    voiceMode: string;
    micEnabled: boolean;
  };
};

export type DiscoveryRoom = {
  id: string;
  name: string;
  canTalk: boolean;
  canListen: boolean;
};

export type DiscoveryResponse = {
  username: string;
  roleId: string;
  pageNumber?: number;
  currentPageNumber?: number;
  profileVersion?: number;
  profileStatus?: string;
  profileUpdatedAt?: number;
  rooms: DiscoveryRoom[];
  users: Array<{ id: string; username: string; roleId: string }>;
  activeRoleUsers?: Array<{ roleId: string; username: string; userId: string }>;
  broadcastGroups: Array<{ id: string; name: string }>;
};

export type StreamDeckActionType =
  | "none"
  | "ptt_room"
  | "select_talk_room"
  | "ptt_selected"
  | "listen_room"
  | "call_room"
  | "direct_user"
  | "direct_role"
  | "reply_to_caller"
  | "broadcast_ptt"
  | "mute_toggle"
  | "volume_delta"
  | "page_up"
  | "page_down"
  | "page_jump"
  | "page_home"
  | "page_back";

export type StreamDeckPageType =
  | "manual"
  | "all_roles"
  | "all_party_lines";

export type StreamDeckButtonAction = {
  type: StreamDeckActionType;
  roomId?: string;
  userId?: string;
  roleId?: string;
  broadcastGroupId?: string;
  volumeDelta?: number;
  targetPage?: number;
};

export type StreamDeckButtonConfig = {
  index: number;
  label?: string;
  color?: string;
  action?: StreamDeckButtonAction;
};

export type StreamDeckPageConfig = {
  page: number;
  title?: string;
  pageType?: StreamDeckPageType;
  parentPage?: number;
  buttons: StreamDeckButtonConfig[];
};

export type StreamDeckSettings = {
  version: number;
  gridColumns: number;
  gridRows: number;
  selectedPage: number;
  pages: StreamDeckPageConfig[];
};

export type CompanionProfileResponse = {
  roleId: string;
  username: string;
  pageNumber?: number;
  currentPageNumber?: number;
  profileVersion: number;
  profileStatus: string;
  profileUpdatedAt?: number;
  rooms: DiscoveryRoom[];
  users: Array<{ id: string; username: string; roleId: string }>;
  activeRoleUsers?: Array<{ roleId: string; username: string; userId: string }>;
  broadcastGroups: Array<{ id: string; name: string }>;
  streamDeckSettings?: unknown;
};

export type CompanionInbound =
  | { type: "companion_state"; data: CompanionState }
  | {
      type: "companion_command_result";
      data: {
        ok: boolean;
        error?: string;
        commandId?: string;
        command?: string;
        status?: "queued" | "executed" | "rejected" | "failed";
        source?: string;
        timestamp?: number;
      };
    };

export type CommandPayload = {
  commandId?: string;
  command: string;
  buttonIndex?: number;
  volumeDelta?: number;
  mode?: "always_on" | "ptt";
  scope?: "direct" | "room" | "broadcast";
  targetId?: string;
  state?: "ptt_start" | "ptt_stop" | "down" | "up";
  signal?: string;
  roleId?: string;
  listenRoomIds?: string[];
  talkRoomIds?: string[];
  brightness?: number;
  pageNumber?: number;
};
