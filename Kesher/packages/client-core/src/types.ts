export type Role = {
  id: string;
  name: string;
  defaultRoomId?: string;
  defaultVoiceMode?: "always_on" | "ptt";
  defaultSimpleView?: boolean;
};

export type VersionInfo = {
  version: string;
  buildTimestamp: string;
};

// NOTE: this type is still called Room for backwards compatibility with
// the server API JSON, but user-facing UI now refers to these entities as
// "party lines". When communicating with new code or documentation, prefer
// the term party line instead of room.
export type Room = {
  id: string;
  name: string;
  priorityLevel?: number;
  senderRoleIds: string[];
  receiverRoleIds: string[];
  forcedListenRoleIds: string[];
};
export type BroadcastGroup = {
  id: string;
  name: string;
  priorityLevel?: number;
  roomIds: string[];
  allowedRoleIds: string[];
};
export type User = { id: string; username: string; roleId: string };

export type UserWithOnlineStatus = User & { online: boolean };
export type ConfigurationSection =
  | "roles"
  | "users"
  | "rooms"
  | "broadcastGroups"
  | "telegramAllowlist"
  | "telegramMappings"
  | "telegramUsers"
  | "ackSettings"
  | "streamDeckSettings"
  | "companionProfiles"
  | "companionRolePages";

export type ConfigurationMetadata = {
  format: string;
  schemaVersion: number;
  exportedAt: string;
  sourceVersion: VersionInfo;
  sections: ConfigurationSection[];
};

export type ConfigurationUserAssignment = {
  id?: string;
  username: string;
  roleId: string;
};

export type ConfigurationUserStreamDeckSettings = {
  roleId?: string;
  username?: string;
  settings: StreamDeckSettings;
};

export type ConfigurationTelegramUser = {
  id: string;
  telegramUserId: string;
  username: string;
  privateChatId: string;
  createdAt: number;
  roomIds: string[];
};

export type ConfigurationCompanionProfile = {
  roleId: string;
  profileVersion: number;
  profile: CompanionProfileResponse;
  publishedByUserId?: string;
  createdAt: number;
  updatedAt: number;
};

export type ConfigurationDocument = {
  meta: ConfigurationMetadata;
  roles: Role[];
  users: ConfigurationUserAssignment[];
  rooms: Room[];
  broadcastGroups: BroadcastGroup[];
  telegramAllowlist: TelegramAllowlistEntry[];
  telegramMappings?: TelegramMapping[];
  telegramUsers?: ConfigurationTelegramUser[];
  ackSettings: { enabled: boolean } | null;
  streamDeckSettings: ConfigurationUserStreamDeckSettings[];
  companionProfiles?: ConfigurationCompanionProfile[];
  companionRolePages?: Record<string, number>;
};

export type ConfigurationImportResponse = {
  importedSections: ConfigurationSection[];
  warnings?: string[];
};

export type CompanionPublishedProfileSummary = {
  roleId: string;
  username: string;
  profileVersion: number;
  profileStatus: string;
  profileUpdatedAt?: number;
};

export type CompanionAdminSummary = {
  sharedSecret: string;
  publishedProfiles: CompanionPublishedProfileSummary[];
};

export type CompanionProfileResponse = {
  roleId: string;
  username: string;
  pageNumber?: number;
  profileVersion: number;
  profileStatus: string;
  profileUpdatedAt?: number;
};

export type CompanionRolePageConfig = {
  roleId: string;
  pageNumber: number;
};

export type CompanionRolePagesResponse = {
  rolePages: Record<string, number>;
};

export type LoginSuccess = {
  token: string;
  user: User;
  showBirthdayGreeting?: boolean;
};
export type LoginConflict = {
  requiresTakeover: true;
  conflictRoleId: string;
  conflictRoleName?: string;
  conflictUsername?: string;
};
export type SessionRevokedEvent = {
  reason: string;
  timestamp: number;
};
export type Presence = {
  userId: string;
  username: string;
  roleId: string;
  listenRooms: string[];
  talkRooms: string[];
  voiceMode: "ptt" | "always_on";
  micEnabled: boolean;
  broadcastActive: boolean;
};

export type PublicBootstrap = {
  roles: Role[];
  rooms: Room[];
  broadcastGroups: BroadcastGroup[];
  activeRoleIds: string[];
  ackEnabled: boolean;
  appVersion: VersionInfo;
};

export type Bootstrap = PublicBootstrap & {
  self: User;
  users: User[];
};

export type TelegramMapping = {
  id: string;
  chatId: string;
  label: string;
  roomId: string;
};

export type TelegramStatus = {
  botConfigured: boolean;
  mode: "polling" | "webhook" | "";
  mappings: TelegramMapping[];
};

export type TelegramAllowlistEntry = {
  id: string;
  telegramUsername: string;
  telegramNumericId?: string;
  kesherUsername: string;
  createdAt: number;
  status: string;
  isBound: boolean;
};

export type HubRealtimeStats = {
  connectedClients: number;
  normalQueueDepthTotal: number;
  normalQueueDepthMax: number;
  priorityQueueDepthTotal: number;
  priorityQueueDepthMax: number;
  droppedCriticalMessages: number;
  droppedNormalMessages: number;
  droppedMessagesByType: Record<string, number>;
  presenceBroadcasts: number;
  presenceBroadcastsMerged: number;
};

export type MediaRealtimeStats = {
  peers: number;
  sources: number;
  syncRequests: number;
  syncRuns: number;
  syncRequestsCoalesced: number;
  syncRunAvgMs: number;
  syncRunMaxMs: number;
  voiceStateToSyncAvgMs: number;
  voiceStateToSyncMaxMs: number;
  renegotiations: number;
  renegotiationAvgMs: number;
  renegotiationMaxMs: number;
};

export type StorePolicyCacheStats = {
  roomPolicyHits: number;
  roomPolicyMisses: number;
  broadcastAllowedHits: number;
  broadcastAllowedMisses: number;
  broadcastRoomHits: number;
  broadcastRoomMisses: number;
  forcedListenHits: number;
  forcedListenMisses: number;
};

export type RealtimeStatsResponse = {
  hub: HubRealtimeStats;
  media: MediaRealtimeStats;
  storePolicyCache: StorePolicyCacheStats;
  timestampUnixMs: number;
};

export type RaspberryPiStationStatus = {
  deviceId: string;
  name: string;
  ipAddress: string;
  roleId: string;
  lowPowerMode: boolean;
  launcherVersion: string;
  browserStatus: string;
  loginStatus: string;
  loginError?: string;
  lastSeenUnixMs: number;
  updatedAtUnixMs: number;
  online: boolean;
  intercomConnected: boolean;
  effectiveStatus: string;
  intercomUsername?: string;
  intercomRoleId?: string;
  secondsSinceSeen: number;
};

export type RaspberryPiStationsResponse = {
  stations: RaspberryPiStationStatus[];
  timestampUnixMs: number;
  offlineAfterMs: number;
};

export type AdminLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export type AdminLogEntry = {
  timestampUnixMs: number;
  level: AdminLogLevel | string;
  category: string;
  message: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  username?: string;
  roleId?: string;
  remoteAddr?: string;
  error?: string;
};

export type AdminLogsResponse = {
  entries: AdminLogEntry[];
  total: number;
  timestampUnixMs: number;
};

export type StatusResponse = {
  roomListenerCounts: Record<string, number>;
  timestampUnixMs: number;
};

export type StreamDeckActionType =
  | "none"
  | "ptt_room"
  | "select_talk_room"
  | "select_listen_room"
  | "ptt_selected"
  | "listen_room"
  | "call_room"
  | "direct_user"
  | "direct_role"
  | "reply_to_caller"
  | "incoming_call_indicator"
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

export type RoutedEvent = {
  scope: "direct" | "room" | "broadcast" | "global";
  targetType?: "room" | "user" | "role" | "global";
  targetId: string;
  body: string;
  source?: string;
  signal?: string;
  messageId?: string;
  ackRequired?: boolean;
  acked?: boolean;
  ackedBy?: User;
  ackedAt?: number;
  fromUser: User;
  timestamp: number;
};

export type ChatTarget =
  | { scope: "global"; targetType: "global"; targetId: "global" }
  | { scope: "room"; targetType: "room"; targetId: string }
  | { scope: "direct"; targetType: "user"; targetId: string };

export type ChatAckUpdate = {
  messageId: string;
  senderUserId: string;
  ackedBy: User;
  ackedAt: number;
};
