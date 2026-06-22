package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
)

const configurationDocumentFormat = "kesher-showfile"
const configurationDocumentSchemaVersion = 2
const minimumConfigurationDocumentSchemaVersion = 1

const (
	configurationSectionRoles             = "roles"
	configurationSectionUsers             = "users"
	configurationSectionRooms             = "rooms"
	configurationSectionBroadcastGroups   = "broadcastGroups"
	configurationSectionTelegramAllowlist = "telegramAllowlist"
	configurationSectionTelegramMappings  = "telegramMappings"
	configurationSectionTelegramUsers     = "telegramUsers"
	configurationSectionAckSettings       = "ackSettings"
	configurationSectionStreamDeck        = "streamDeckSettings"
	configurationSectionCompanionProfiles = "companionProfiles"
	configurationSectionCompanionPages    = "companionRolePages"
)

var allConfigurationSections = []string{
	configurationSectionRoles,
	configurationSectionUsers,
	configurationSectionRooms,
	configurationSectionBroadcastGroups,
	configurationSectionTelegramAllowlist,
	configurationSectionTelegramMappings,
	configurationSectionTelegramUsers,
	configurationSectionAckSettings,
	configurationSectionStreamDeck,
	configurationSectionCompanionProfiles,
	configurationSectionCompanionPages,
}

type ConfigurationMetadata struct {
	Format        string      `json:"format"`
	SchemaVersion int         `json:"schemaVersion"`
	ExportedAt    string      `json:"exportedAt"`
	SourceVersion VersionInfo `json:"sourceVersion"`
	Sections      []string    `json:"sections"`
}

type ConfigurationUserAssignment struct {
	ID       string `json:"id,omitempty"`
	Username string `json:"username"`
	RoleID   string `json:"roleId"`
}

type ConfigurationRoleStreamDeckSettings struct {
	RoleID   string             `json:"roleId,omitempty"`
	Username string             `json:"username,omitempty"`
	Settings StreamDeckSettings `json:"settings"`
}

type ConfigurationTelegramUser struct {
	ID             string   `json:"id"`
	TelegramUserID string   `json:"telegramUserId"`
	Username       string   `json:"username"`
	PrivateChatID  string   `json:"privateChatId"`
	CreatedAt      int64    `json:"createdAt"`
	RoomIDs        []string `json:"roomIds"`
}

type ConfigurationCompanionProfile struct {
	RoleID            string                   `json:"roleId"`
	ProfileVersion    int                      `json:"profileVersion"`
	Profile           CompanionProfileResponse `json:"profile"`
	PublishedByUserID string                   `json:"publishedByUserId,omitempty"`
	CreatedAt         int64                    `json:"createdAt"`
	UpdatedAt         int64                    `json:"updatedAt"`
}

type ConfigurationDocument struct {
	Meta               ConfigurationMetadata                 `json:"meta"`
	Roles              []Role                                `json:"roles,omitempty"`
	Users              []ConfigurationUserAssignment         `json:"users,omitempty"`
	Rooms              []Room                                `json:"rooms,omitempty"`
	BroadcastGroups    []BroadcastGroup                      `json:"broadcastGroups,omitempty"`
	TelegramAllowlist  []TelegramAllowlistEntry              `json:"telegramAllowlist,omitempty"`
	TelegramMappings   []TelegramMapping                     `json:"telegramMappings,omitempty"`
	TelegramUsers      []ConfigurationTelegramUser           `json:"telegramUsers,omitempty"`
	AckSettings        *AckSettings                          `json:"ackSettings,omitempty"`
	StreamDeck         []ConfigurationRoleStreamDeckSettings `json:"streamDeckSettings,omitempty"`
	CompanionProfiles  []ConfigurationCompanionProfile       `json:"companionProfiles,omitempty"`
	CompanionRolePages map[string]int                        `json:"companionRolePages,omitempty"`
}

type ConfigurationImportRequest struct {
	Document ConfigurationDocument `json:"document"`
	Sections []string              `json:"sections,omitempty"`
}

type ConfigurationImportResponse struct {
	ImportedSections []string `json:"importedSections"`
}

type configurationState struct {
	Roles              []Role
	Users              []User
	Rooms              []Room
	BroadcastGroups    []BroadcastGroup
	TelegramAllowlist  []TelegramAllowlistEntry
	TelegramMappings   []TelegramMapping
	TelegramUsers      []ConfigurationTelegramUser
	AckEnabled         bool
	StreamDeck         []ConfigurationRoleStreamDeckSettings
	CompanionProfiles  []ConfigurationCompanionProfile
	CompanionRolePages map[string]int
}

func invalidInputf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidInput, fmt.Sprintf(format, args...))
}

func conflictf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrConflict, fmt.Sprintf(format, args...))
}

func (s *Server) exportConfigurationDocument(ctx context.Context, requested ...[]string) (ConfigurationDocument, error) {
	state, err := s.store.currentConfigurationState(ctx)
	if err != nil {
		return ConfigurationDocument{}, err
	}
	var selected []string
	if len(requested) > 0 {
		selected = requested[0]
	}
	sections, err := normalizeExportSections(selected)
	if err != nil {
		return ConfigurationDocument{}, err
	}
	users := make([]ConfigurationUserAssignment, 0, len(state.Users))
	for _, user := range state.Users {
		users = append(users, ConfigurationUserAssignment{
			ID:       user.ID,
			Username: user.Username,
			RoleID:   user.RoleID,
		})
	}
	doc := ConfigurationDocument{
		Meta: ConfigurationMetadata{
			Format:        configurationDocumentFormat,
			SchemaVersion: configurationDocumentSchemaVersion,
			ExportedAt:    time.Now().UTC().Format(time.RFC3339),
			SourceVersion: GetVersionInfo(),
			Sections:      append([]string(nil), sections...),
		},
	}
	for _, section := range sections {
		switch section {
		case configurationSectionRoles:
			doc.Roles = append([]Role{}, state.Roles...)
		case configurationSectionUsers:
			doc.Users = users
		case configurationSectionRooms:
			doc.Rooms = append([]Room{}, state.Rooms...)
		case configurationSectionBroadcastGroups:
			doc.BroadcastGroups = append([]BroadcastGroup{}, state.BroadcastGroups...)
		case configurationSectionTelegramAllowlist:
			doc.TelegramAllowlist = append([]TelegramAllowlistEntry{}, state.TelegramAllowlist...)
		case configurationSectionTelegramMappings:
			doc.TelegramMappings = append([]TelegramMapping{}, state.TelegramMappings...)
		case configurationSectionTelegramUsers:
			doc.TelegramUsers = append([]ConfigurationTelegramUser{}, state.TelegramUsers...)
		case configurationSectionAckSettings:
			doc.AckSettings = &AckSettings{Enabled: s.isAckEnabled()}
		case configurationSectionStreamDeck:
			doc.StreamDeck = append([]ConfigurationRoleStreamDeckSettings{}, state.StreamDeck...)
		case configurationSectionCompanionProfiles:
			doc.CompanionProfiles = append([]ConfigurationCompanionProfile{}, state.CompanionProfiles...)
		case configurationSectionCompanionPages:
			doc.CompanionRolePages = cloneStringIntMap(state.CompanionRolePages)
		}
	}
	return doc, nil
}

func normalizeExportSections(requested []string) ([]string, error) {
	if len(requested) == 0 {
		return append([]string(nil), allConfigurationSections...), nil
	}
	seen := make(map[string]struct{}, len(requested))
	selected := make([]string, 0, len(requested))
	for _, section := range requested {
		section = strings.TrimSpace(section)
		if !slices.Contains(allConfigurationSections, section) {
			return nil, invalidInputf("unknown section %q", section)
		}
		if _, exists := seen[section]; exists {
			continue
		}
		seen[section] = struct{}{}
		selected = append(selected, section)
	}
	if len(selected) == 0 {
		return nil, invalidInputf("no sections selected")
	}
	return selected, nil
}

func cloneStringIntMap(source map[string]int) map[string]int {
	if source == nil {
		return map[string]int{}
	}
	cloned := make(map[string]int, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func (s *Store) currentConfigurationState(ctx context.Context) (configurationState, error) {
	roles, err := s.ListRoles(ctx)
	if err != nil {
		return configurationState{}, err
	}
	users, err := s.ListUsers(ctx)
	if err != nil {
		return configurationState{}, err
	}
	rooms, err := s.ListRooms(ctx)
	if err != nil {
		return configurationState{}, err
	}
	groups, err := s.ListBroadcastGroups(ctx)
	if err != nil {
		return configurationState{}, err
	}
	allowlist, err := s.ListTelegramAllowlistEntries(ctx)
	if err != nil {
		return configurationState{}, err
	}
	telegramMappings, err := s.ListTelegramMappings(ctx)
	if err != nil {
		return configurationState{}, err
	}
	telegramUsers, err := s.ListConfigurationTelegramUsers(ctx)
	if err != nil {
		return configurationState{}, err
	}
	streamDeck, err := s.ListConfigurationStreamDeckSettings(ctx)
	if err != nil {
		return configurationState{}, err
	}
	companionProfiles, err := s.ListConfigurationCompanionProfiles(ctx)
	if err != nil {
		return configurationState{}, err
	}
	companionRolePages, err := s.GetAllCompanionRolePages(ctx)
	if err != nil {
		return configurationState{}, err
	}
	return configurationState{
		Roles:              roles,
		Users:              users,
		Rooms:              rooms,
		BroadcastGroups:    groups,
		TelegramAllowlist:  allowlist,
		TelegramMappings:   telegramMappings,
		TelegramUsers:      telegramUsers,
		StreamDeck:         streamDeck,
		CompanionProfiles:  companionProfiles,
		CompanionRolePages: companionRolePages,
	}, nil
}

func (s *Store) ListConfigurationStreamDeckSettings(ctx context.Context) ([]ConfigurationRoleStreamDeckSettings, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT role_id, settings_json
		FROM role_stream_deck_settings
		ORDER BY role_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ConfigurationRoleStreamDeckSettings, 0)
	for rows.Next() {
		var roleID string
		var raw string
		if err := rows.Scan(&roleID, &raw); err != nil {
			return nil, err
		}
		var settings StreamDeckSettings
		if err := json.Unmarshal([]byte(raw), &settings); err != nil {
			return nil, ErrInvalidInput
		}
		normalized, err := validateStreamDeckSettings(settings)
		if err != nil {
			return nil, err
		}
		result = append(result, ConfigurationRoleStreamDeckSettings{
			RoleID:   roleID,
			Settings: normalized,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Store) ListConfigurationTelegramUsers(ctx context.Context) ([]ConfigurationTelegramUser, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, telegram_user_id, username, private_chat_id, created_at
		FROM telegram_user_mappings ORDER BY username COLLATE NOCASE`)
	if err != nil {
		return nil, err
	}
	result := make([]ConfigurationTelegramUser, 0)
	for rows.Next() {
		var entry ConfigurationTelegramUser
		if err := rows.Scan(&entry.ID, &entry.TelegramUserID, &entry.Username, &entry.PrivateChatID, &entry.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for index := range result {
		roomIDs, err := s.GetTelegramUserRoomSubscriptions(ctx, result[index].TelegramUserID)
		if err != nil {
			return nil, err
		}
		slices.Sort(roomIDs)
		result[index].RoomIDs = roomIDs
	}
	return result, nil
}

func (s *Store) ListConfigurationCompanionProfiles(ctx context.Context) ([]ConfigurationCompanionProfile, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT role_id, profile_version, profile_json,
		COALESCE(published_by_user_id, ''), created_at, updated_at
		FROM companion_profiles ORDER BY role_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]ConfigurationCompanionProfile, 0)
	for rows.Next() {
		var entry ConfigurationCompanionProfile
		var raw string
		if err := rows.Scan(
			&entry.RoleID,
			&entry.ProfileVersion,
			&raw,
			&entry.PublishedByUserID,
			&entry.CreatedAt,
			&entry.UpdatedAt,
		); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &entry.Profile); err != nil {
			return nil, ErrInvalidInput
		}
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func mergeConfigurationImport(current configurationState, doc ConfigurationDocument, requestedSections []string) (configurationState, []string, error) {
	sections, err := normalizeConfigurationSections(doc, requestedSections)
	if err != nil {
		return configurationState{}, nil, err
	}
	merged := configurationState{
		Roles:              append([]Role(nil), current.Roles...),
		Users:              append([]User(nil), current.Users...),
		Rooms:              append([]Room(nil), current.Rooms...),
		BroadcastGroups:    append([]BroadcastGroup(nil), current.BroadcastGroups...),
		TelegramAllowlist:  append([]TelegramAllowlistEntry(nil), current.TelegramAllowlist...),
		TelegramMappings:   append([]TelegramMapping(nil), current.TelegramMappings...),
		TelegramUsers:      append([]ConfigurationTelegramUser(nil), current.TelegramUsers...),
		AckEnabled:         current.AckEnabled,
		StreamDeck:         append([]ConfigurationRoleStreamDeckSettings(nil), current.StreamDeck...),
		CompanionProfiles:  append([]ConfigurationCompanionProfile(nil), current.CompanionProfiles...),
		CompanionRolePages: cloneStringIntMap(current.CompanionRolePages),
	}
	for _, section := range sections {
		switch section {
		case configurationSectionRoles:
			merged.Roles = append([]Role(nil), doc.Roles...)
		case configurationSectionUsers:
			merged.Users = importedAssignmentsToUsers(doc.Users)
		case configurationSectionRooms:
			merged.Rooms = append([]Room(nil), doc.Rooms...)
		case configurationSectionBroadcastGroups:
			merged.BroadcastGroups = append([]BroadcastGroup(nil), doc.BroadcastGroups...)
		case configurationSectionTelegramAllowlist:
			merged.TelegramAllowlist = append([]TelegramAllowlistEntry(nil), doc.TelegramAllowlist...)
		case configurationSectionTelegramMappings:
			merged.TelegramMappings = append([]TelegramMapping(nil), doc.TelegramMappings...)
		case configurationSectionTelegramUsers:
			merged.TelegramUsers = append([]ConfigurationTelegramUser(nil), doc.TelegramUsers...)
		case configurationSectionAckSettings:
			merged.AckEnabled = doc.AckSettings.Enabled
		case configurationSectionStreamDeck:
			normalizedStreamDeck, err := normalizeImportedStreamDeckAssignments(doc.StreamDeck, merged.Users)
			if err != nil {
				return configurationState{}, nil, err
			}
			merged.StreamDeck = normalizedStreamDeck
		case configurationSectionCompanionProfiles:
			merged.CompanionProfiles = append([]ConfigurationCompanionProfile(nil), doc.CompanionProfiles...)
		case configurationSectionCompanionPages:
			merged.CompanionRolePages = cloneStringIntMap(doc.CompanionRolePages)
		}
	}
	if err := validateConfigurationState(merged); err != nil {
		return configurationState{}, nil, err
	}
	return merged, sections, nil
}

func normalizeConfigurationSections(doc ConfigurationDocument, requestedSections []string) ([]string, error) {
	if err := validateConfigurationMetadata(doc.Meta); err != nil {
		return nil, err
	}
	sections := requestedSections
	if len(sections) == 0 {
		sections = doc.Meta.Sections
	}
	if len(sections) == 0 {
		return nil, invalidInputf("no sections selected")
	}
	seen := make(map[string]struct{}, len(sections))
	normalized := make([]string, 0, len(sections))
	for _, section := range sections {
		section = strings.TrimSpace(section)
		if !slices.Contains(allConfigurationSections, section) {
			return nil, invalidInputf("unknown section %q", section)
		}
		if _, ok := seen[section]; ok {
			continue
		}
		if !configurationDocumentHasSection(doc, section) {
			return nil, invalidInputf("section %q is selected but missing in document", section)
		}
		seen[section] = struct{}{}
		normalized = append(normalized, section)
	}
	if len(normalized) == 0 {
		return nil, invalidInputf("no effective sections to import")
	}
	return normalized, nil
}

func validateConfigurationMetadata(meta ConfigurationMetadata) error {
	if strings.TrimSpace(meta.Format) != configurationDocumentFormat {
		return invalidInputf("meta.format must be %q", configurationDocumentFormat)
	}
	if meta.SchemaVersion < minimumConfigurationDocumentSchemaVersion || meta.SchemaVersion > configurationDocumentSchemaVersion {
		return invalidInputf("meta.schemaVersion must be between %d and %d", minimumConfigurationDocumentSchemaVersion, configurationDocumentSchemaVersion)
	}
	if strings.TrimSpace(meta.ExportedAt) == "" {
		return invalidInputf("meta.exportedAt is required")
	}
	if _, err := time.Parse(time.RFC3339, meta.ExportedAt); err != nil {
		return invalidInputf("meta.exportedAt must be RFC3339")
	}
	if len(meta.Sections) == 0 {
		return invalidInputf("meta.sections must not be empty")
	}
	seen := make(map[string]struct{}, len(meta.Sections))
	for _, section := range meta.Sections {
		section = strings.TrimSpace(section)
		if !slices.Contains(allConfigurationSections, section) {
			return invalidInputf("meta.sections contains unknown section %q", section)
		}
		if _, ok := seen[section]; ok {
			return invalidInputf("meta.sections contains duplicate section %q", section)
		}
		seen[section] = struct{}{}
	}
	return nil
}

func configurationDocumentHasSection(doc ConfigurationDocument, section string) bool {
	if !slices.Contains(doc.Meta.Sections, section) {
		return false
	}
	switch section {
	case configurationSectionRoles:
		return true
	case configurationSectionUsers:
		return true
	case configurationSectionRooms:
		return true
	case configurationSectionBroadcastGroups:
		return true
	case configurationSectionTelegramAllowlist:
		return true
	case configurationSectionTelegramMappings:
		return true
	case configurationSectionTelegramUsers:
		return true
	case configurationSectionAckSettings:
		return doc.AckSettings != nil
	case configurationSectionStreamDeck:
		return true
	case configurationSectionCompanionProfiles:
		return true
	case configurationSectionCompanionPages:
		return true
	default:
		return false
	}
}

func normalizeImportedStreamDeckAssignments(imported []ConfigurationRoleStreamDeckSettings, users []User) ([]ConfigurationRoleStreamDeckSettings, error) {
	normalized := make([]ConfigurationRoleStreamDeckSettings, 0, len(imported))
	seenRoleIDs := make(map[string]struct{}, len(imported))
	for _, assignment := range imported {
		roleID := strings.TrimSpace(assignment.RoleID)
		username := strings.TrimSpace(assignment.Username)
		if roleID == "" && username != "" {
			for _, user := range users {
				if strings.EqualFold(user.Username, username) {
					roleID = strings.TrimSpace(user.RoleID)
					break
				}
			}
		}
		if roleID == "" {
			return nil, invalidInputf("streamDeckSettings roleId is required")
		}
		if _, ok := seenRoleIDs[roleID]; ok {
			return nil, conflictf("duplicate streamDeckSettings roleId %q", roleID)
		}
		settings, err := validateStreamDeckSettings(assignment.Settings)
		if err != nil {
			if errors.Is(err, ErrInvalidInput) {
				return nil, invalidInputf("streamDeckSettings for role %q is invalid", roleID)
			}
			return nil, err
		}
		seenRoleIDs[roleID] = struct{}{}
		normalized = append(normalized, ConfigurationRoleStreamDeckSettings{
			RoleID:   roleID,
			Settings: settings,
		})
	}
	return normalized, nil
}

func importedAssignmentsToUsers(imported []ConfigurationUserAssignment) []User {
	users := make([]User, 0, len(imported))
	for _, assignment := range imported {
		users = append(users, User{
			ID:       strings.TrimSpace(assignment.ID),
			Username: strings.TrimSpace(assignment.Username),
			RoleID:   strings.TrimSpace(assignment.RoleID),
		})
	}
	return users
}

func validateConfigurationState(state configurationState) error {
	roleByID := make(map[string]Role, len(state.Roles))
	roleNames := make(map[string]struct{}, len(state.Roles))
	for _, role := range state.Roles {
		roleID := strings.TrimSpace(role.ID)
		roleName := strings.TrimSpace(role.Name)
		if roleID == "" || roleName == "" {
			return invalidInputf("role id and name are required")
		}
		if _, exists := roleByID[roleID]; exists {
			return conflictf("duplicate role id %q", roleID)
		}
		if _, exists := roleNames[roleName]; exists {
			return conflictf("duplicate role name %q", roleName)
		}
		if strings.TrimSpace(role.DefaultVoiceMode) != "" && !isAllowedVoiceMode(role.DefaultVoiceMode) {
			return invalidInputf("role %q has unsupported defaultVoiceMode %q", roleID, role.DefaultVoiceMode)
		}
		roleByID[roleID] = role
		roleNames[roleName] = struct{}{}
	}

	roomByID := make(map[string]Room, len(state.Rooms))
	roomNames := make(map[string]struct{}, len(state.Rooms))
	for _, room := range state.Rooms {
		roomID := strings.TrimSpace(room.ID)
		roomName := strings.TrimSpace(room.Name)
		if roomID == "" || roomName == "" {
			return invalidInputf("room id and name are required")
		}
		if _, err := normalizePriorityLevel(room.PriorityLevel); err != nil {
			return invalidInputf("room %q has invalid priorityLevel %d", roomID, room.PriorityLevel)
		}
		if _, exists := roomByID[roomID]; exists {
			return conflictf("duplicate room id %q", roomID)
		}
		if _, exists := roomNames[roomName]; exists {
			return conflictf("duplicate room name %q", roomName)
		}
		for _, roleID := range mergeUnique(normalizeIDs(room.ReceiverRoleIDs), normalizeIDs(room.ForcedListenRoleIDs)) {
			if _, ok := roleByID[roleID]; !ok {
				return invalidInputf("room %q references unknown receiver/forced role %q", roomID, roleID)
			}
		}
		for _, roleID := range normalizeIDs(room.SenderRoleIDs) {
			if _, ok := roleByID[roleID]; !ok {
				return invalidInputf("room %q references unknown sender role %q", roomID, roleID)
			}
		}
		for _, roleID := range normalizeIDs(room.ForcedListenRoleIDs) {
			if _, ok := roleByID[roleID]; !ok {
				return invalidInputf("room %q references unknown forcedListen role %q", roomID, roleID)
			}
		}
		roomByID[roomID] = room
		roomNames[roomName] = struct{}{}
	}

	for _, role := range state.Roles {
		if strings.TrimSpace(role.DefaultRoomID) == "" {
			continue
		}
		if _, ok := roomByID[role.DefaultRoomID]; !ok {
			return invalidInputf("role %q references unknown defaultRoomId %q", role.ID, role.DefaultRoomID)
		}
	}

	groupIDs := make(map[string]struct{}, len(state.BroadcastGroups))
	groupNames := make(map[string]struct{}, len(state.BroadcastGroups))
	for _, group := range state.BroadcastGroups {
		groupID := strings.TrimSpace(group.ID)
		groupName := strings.TrimSpace(group.Name)
		if groupID == "" || groupName == "" {
			return invalidInputf("broadcast group id and name are required")
		}
		if _, err := normalizePriorityLevel(group.PriorityLevel); err != nil {
			return invalidInputf("broadcast group %q has invalid priorityLevel %d", groupID, group.PriorityLevel)
		}
		if _, exists := groupIDs[groupID]; exists {
			return conflictf("duplicate broadcast group id %q", groupID)
		}
		if _, exists := groupNames[groupName]; exists {
			return conflictf("duplicate broadcast group name %q", groupName)
		}
		roomIDs := normalizeIDs(group.RoomIDs)
		if len(roomIDs) == 0 {
			return invalidInputf("broadcast group %q must contain at least one room", groupID)
		}
		for _, roomID := range roomIDs {
			if _, ok := roomByID[roomID]; !ok {
				return invalidInputf("broadcast group %q references unknown room %q", groupID, roomID)
			}
		}
		for _, roleID := range normalizeIDs(group.AllowedRoleIDs) {
			if _, ok := roleByID[roleID]; !ok {
				return invalidInputf("broadcast group %q references unknown role %q", groupID, roleID)
			}
		}
		groupIDs[groupID] = struct{}{}
		groupNames[groupName] = struct{}{}
	}

	usernames := make(map[string]struct{}, len(state.Users))
	userByUsername := make(map[string]struct{}, len(state.Users))
	userIDs := make(map[string]struct{}, len(state.Users))
	for _, user := range state.Users {
		userID := strings.TrimSpace(user.ID)
		username := strings.TrimSpace(user.Username)
		roleID := strings.TrimSpace(user.RoleID)
		if username == "" || roleID == "" {
			return invalidInputf("user username and roleId are required")
		}
		if _, exists := usernames[username]; exists {
			return conflictf("duplicate username %q", username)
		}
		if userID != "" {
			if _, exists := userIDs[userID]; exists {
				return conflictf("duplicate user id %q", userID)
			}
			userIDs[userID] = struct{}{}
		}
		if _, ok := roleByID[roleID]; !ok {
			return invalidInputf("user %q references unknown roleId %q", username, roleID)
		}
		usernames[username] = struct{}{}
		userByUsername[strings.ToLower(username)] = struct{}{}
	}

	streamDeckByRoleID := make(map[string]struct{}, len(state.StreamDeck))
	for _, assignment := range state.StreamDeck {
		roleID := strings.TrimSpace(assignment.RoleID)
		if roleID == "" {
			return invalidInputf("streamDeckSettings roleId is required")
		}
		if _, exists := streamDeckByRoleID[roleID]; exists {
			return conflictf("duplicate streamDeckSettings roleId %q", roleID)
		}
		if _, ok := roleByID[roleID]; !ok {
			return invalidInputf("streamDeckSettings references unknown roleId %q", roleID)
		}
		if _, err := validateStreamDeckSettings(assignment.Settings); err != nil {
			return invalidInputf("streamDeckSettings for role %q is invalid", roleID)
		}
		streamDeckByRoleID[roleID] = struct{}{}
	}

	allowlistUsernames := make(map[string]struct{}, len(state.TelegramAllowlist))
	allowlistNumericIDs := make(map[string]struct{}, len(state.TelegramAllowlist))
	for _, entry := range state.TelegramAllowlist {
		telegramUsername := strings.TrimSpace(strings.TrimPrefix(entry.TelegramUsername, "@"))
		kesherUsername := strings.TrimSpace(entry.KesherUsername)
		if telegramUsername == "" || kesherUsername == "" || hasWhitespace(telegramUsername) || hasWhitespace(kesherUsername) {
			return invalidInputf("telegram allowlist entry requires telegramUsername and kesherUsername without whitespace")
		}
		if _, ok := allowlistUsernames[strings.ToLower(telegramUsername)]; ok {
			return conflictf("duplicate telegram username %q", telegramUsername)
		}
		allowlistUsernames[strings.ToLower(telegramUsername)] = struct{}{}
		numericID := strings.TrimSpace(entry.TelegramNumericID)
		if numericID != "" {
			if _, ok := allowlistNumericIDs[numericID]; ok {
				return conflictf("duplicate telegram numeric id %q", numericID)
			}
			allowlistNumericIDs[numericID] = struct{}{}
		}
		if _, ok := userByUsername[strings.ToLower(kesherUsername)]; !ok {
			return invalidInputf("telegram username %q references unknown kesherUsername %q", telegramUsername, kesherUsername)
		}
	}

	telegramMappingIDs := make(map[string]struct{}, len(state.TelegramMappings))
	telegramChatIDs := make(map[string]struct{}, len(state.TelegramMappings))
	for _, mapping := range state.TelegramMappings {
		mappingID := strings.TrimSpace(mapping.ID)
		chatID := strings.TrimSpace(mapping.ChatID)
		label := strings.TrimSpace(mapping.Label)
		roomID := strings.TrimSpace(mapping.RoomID)
		if mappingID == "" || chatID == "" || label == "" || roomID == "" {
			return invalidInputf("telegramMappings entries require id, chatId, label and roomId")
		}
		if _, exists := telegramMappingIDs[mappingID]; exists {
			return conflictf("duplicate telegram mapping id %q", mappingID)
		}
		if _, exists := telegramChatIDs[chatID]; exists {
			return conflictf("duplicate telegram chat id %q", chatID)
		}
		if _, exists := roomByID[roomID]; !exists {
			return invalidInputf("telegram mapping %q references unknown room %q", mappingID, roomID)
		}
		telegramMappingIDs[mappingID] = struct{}{}
		telegramChatIDs[chatID] = struct{}{}
	}

	telegramUserIDs := make(map[string]struct{}, len(state.TelegramUsers))
	telegramUserMappingIDs := make(map[string]struct{}, len(state.TelegramUsers))
	for _, mapping := range state.TelegramUsers {
		mappingID := strings.TrimSpace(mapping.ID)
		telegramUserID := strings.TrimSpace(mapping.TelegramUserID)
		username := strings.TrimSpace(mapping.Username)
		privateChatID := strings.TrimSpace(mapping.PrivateChatID)
		if mappingID == "" || telegramUserID == "" || username == "" || privateChatID == "" {
			return invalidInputf("telegramUsers entries require id, telegramUserId, username and privateChatId")
		}
		if _, exists := telegramUserMappingIDs[mappingID]; exists {
			return conflictf("duplicate telegram user mapping id %q", mappingID)
		}
		if _, exists := telegramUserIDs[telegramUserID]; exists {
			return conflictf("duplicate telegram user id %q", telegramUserID)
		}
		if _, exists := userByUsername[strings.ToLower(username)]; !exists {
			return invalidInputf("telegram user %q references unknown username %q", telegramUserID, username)
		}
		for _, roomID := range normalizeIDs(mapping.RoomIDs) {
			if _, exists := roomByID[roomID]; !exists {
				return invalidInputf("telegram user %q references unknown room %q", telegramUserID, roomID)
			}
		}
		telegramUserMappingIDs[mappingID] = struct{}{}
		telegramUserIDs[telegramUserID] = struct{}{}
	}

	companionProfileRoles := make(map[string]struct{}, len(state.CompanionProfiles))
	for _, profile := range state.CompanionProfiles {
		roleID := strings.TrimSpace(profile.RoleID)
		if roleID == "" || profile.ProfileVersion < 1 {
			return invalidInputf("companionProfiles entries require roleId and a positive profileVersion")
		}
		if _, exists := roleByID[roleID]; !exists {
			return invalidInputf("companion profile references unknown roleId %q", roleID)
		}
		if _, exists := companionProfileRoles[roleID]; exists {
			return conflictf("duplicate companion profile roleId %q", roleID)
		}
		companionProfileRoles[roleID] = struct{}{}
	}
	for roleID, pageNumber := range state.CompanionRolePages {
		if _, exists := roleByID[strings.TrimSpace(roleID)]; !exists {
			return invalidInputf("companionRolePages references unknown roleId %q", roleID)
		}
		if pageNumber < 0 {
			return invalidInputf("companionRolePages for %q must not be negative", roleID)
		}
	}
	return nil
}

func (s *Store) ReplaceConfiguration(ctx context.Context, state configurationState, updateUsers bool, rewriteStreamDeck bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	statements := []string{
		`DELETE FROM telegram_user_room_subscriptions`,
		`DELETE FROM telegram_user_mappings`,
		`DELETE FROM telegram_mappings`,
		`DELETE FROM telegram_allowlist`,
		`DELETE FROM companion_profiles`,
		`DELETE FROM companion_role_pages`,
		`DELETE FROM broadcast_group_rooms`,
		`DELETE FROM broadcast_group_roles`,
		`DELETE FROM room_sender_roles`,
		`DELETE FROM room_receiver_roles`,
		`DELETE FROM room_forced_listen_roles`,
		`DELETE FROM broadcast_groups`,
		`DELETE FROM rooms`,
		`DELETE FROM roles`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}

	for _, role := range state.Roles {
		defaultSimpleView := 0
		if role.DefaultSimpleView {
			defaultSimpleView = 1
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO roles (id, name, default_room_id, default_voice_mode, default_simple_view) VALUES (?, ?, ?, ?, ?)`,
			strings.TrimSpace(role.ID),
			strings.TrimSpace(role.Name),
			nullableString(role.DefaultRoomID),
			nullableString(role.DefaultVoiceMode),
			defaultSimpleView,
		); err != nil {
			return err
		}
	}

	for _, room := range state.Rooms {
		roomID := strings.TrimSpace(room.ID)
		if _, err := tx.ExecContext(ctx, `INSERT INTO rooms (id, name, priority_level) VALUES (?, ?, ?)`, roomID, strings.TrimSpace(room.Name), room.PriorityLevel); err != nil {
			return err
		}
		if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_sender_roles", roomID, normalizeIDs(room.SenderRoleIDs)); err != nil {
			return err
		}
		receiverRoleIDs := mergeUnique(normalizeIDs(room.ReceiverRoleIDs), normalizeIDs(room.ForcedListenRoleIDs))
		if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_receiver_roles", roomID, receiverRoleIDs); err != nil {
			return err
		}
		if err := s.replaceRoomRoleMappingsWithTx(ctx, tx, "room_forced_listen_roles", roomID, normalizeIDs(room.ForcedListenRoleIDs)); err != nil {
			return err
		}
	}

	for _, group := range state.BroadcastGroups {
		groupID := strings.TrimSpace(group.ID)
		if _, err := tx.ExecContext(ctx, `INSERT INTO broadcast_groups (id, name, priority_level) VALUES (?, ?, ?)`, groupID, strings.TrimSpace(group.Name), group.PriorityLevel); err != nil {
			return err
		}
		for _, roomID := range normalizeIDs(group.RoomIDs) {
			if _, err := tx.ExecContext(ctx, `INSERT INTO broadcast_group_rooms (broadcast_group_id, room_id) VALUES (?, ?)`, groupID, roomID); err != nil {
				return err
			}
		}
		if err := s.replaceBroadcastGroupRoleMappingsWithTx(ctx, tx, groupID, normalizeIDs(group.AllowedRoleIDs)); err != nil {
			return err
		}
	}

	for _, entry := range state.TelegramAllowlist {
		entryID := strings.TrimSpace(entry.ID)
		if entryID == "" {
			entryID = newID()
		}
		createdAt := entry.CreatedAt
		if createdAt == 0 {
			createdAt = time.Now().Unix()
		}
		telegramUsername := strings.TrimSpace(strings.TrimPrefix(entry.TelegramUsername, "@"))
		telegramNumericID := strings.TrimSpace(entry.TelegramNumericID)
		kesherUsername := strings.TrimSpace(entry.KesherUsername)
		if _, err := tx.ExecContext(ctx, `INSERT INTO telegram_allowlist (id, telegram_username, telegram_numeric_id, kesher_username, created_at) VALUES (?, ?, NULLIF(?, ''), ?, ?)`,
			entryID,
			telegramUsername,
			telegramNumericID,
			kesherUsername,
			createdAt,
		); err != nil {
			return err
		}
	}

	for _, mapping := range state.TelegramMappings {
		if _, err := tx.ExecContext(ctx, `INSERT INTO telegram_mappings (id, chat_id, label, room_id) VALUES (?, ?, ?, ?)`,
			strings.TrimSpace(mapping.ID),
			strings.TrimSpace(mapping.ChatID),
			strings.TrimSpace(mapping.Label),
			strings.TrimSpace(mapping.RoomID),
		); err != nil {
			return err
		}
	}

	for _, mapping := range state.TelegramUsers {
		if _, err := tx.ExecContext(ctx, `INSERT INTO telegram_user_mappings (id, telegram_user_id, username, private_chat_id, created_at) VALUES (?, ?, ?, ?, ?)`,
			strings.TrimSpace(mapping.ID),
			strings.TrimSpace(mapping.TelegramUserID),
			strings.TrimSpace(mapping.Username),
			strings.TrimSpace(mapping.PrivateChatID),
			mapping.CreatedAt,
		); err != nil {
			return err
		}
		for _, roomID := range normalizeIDs(mapping.RoomIDs) {
			if _, err := tx.ExecContext(ctx, `INSERT INTO telegram_user_room_subscriptions (telegram_user_id, room_id, created_at) VALUES (?, ?, ?)`,
				strings.TrimSpace(mapping.TelegramUserID), roomID, mapping.CreatedAt,
			); err != nil {
				return err
			}
		}
	}

	for _, profile := range state.CompanionProfiles {
		body, err := json.Marshal(profile.Profile)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO companion_profiles (role_id, profile_version, profile_json, published_by_user_id, created_at, updated_at) VALUES (?, ?, ?, NULLIF(?, ''), ?, ?)`,
			strings.TrimSpace(profile.RoleID),
			profile.ProfileVersion,
			string(body),
			strings.TrimSpace(profile.PublishedByUserID),
			profile.CreatedAt,
			profile.UpdatedAt,
		); err != nil {
			return err
		}
	}

	for roleID, pageNumber := range state.CompanionRolePages {
		if _, err := tx.ExecContext(ctx, `INSERT INTO companion_role_pages (role_id, page_number, updated_at) VALUES (?, ?, ?)`,
			strings.TrimSpace(roleID), pageNumber, time.Now().UnixMilli(),
		); err != nil {
			return err
		}
	}

	if updateUsers {
		if _, err := tx.ExecContext(ctx, `DELETE FROM users`); err != nil {
			return err
		}
		for _, user := range state.Users {
			if _, err := tx.ExecContext(ctx, `INSERT INTO users (id, username, role_id) VALUES (COALESCE(NULLIF(?, ''), lower(hex(randomblob(16)))), ?, ?)
				ON CONFLICT(username) DO UPDATE SET role_id = excluded.role_id`,
				strings.TrimSpace(user.ID),
				strings.TrimSpace(user.Username),
				strings.TrimSpace(user.RoleID),
			); err != nil {
				return err
			}
		}
	}

	if rewriteStreamDeck {
		if _, err := tx.ExecContext(ctx, `DELETE FROM role_stream_deck_settings`); err != nil {
			return err
		}
		now := time.Now().Unix()
		for _, assignment := range state.StreamDeck {
			settingsJSON, err := json.Marshal(assignment.Settings)
			if err != nil {
				return err
			}
			result, err := tx.ExecContext(ctx, `INSERT INTO role_stream_deck_settings (role_id, settings_json, created_at, updated_at)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(role_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
				assignment.RoleID,
				string(settingsJSON),
				now,
				now,
			)
			if err != nil {
				return err
			}
			affected, err := result.RowsAffected()
			if err != nil {
				return err
			}
			if affected == 0 {
				return invalidInputf("streamDeckSettings references unknown roleId %q", assignment.RoleID)
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	s.resetPolicyCaches()
	return nil
}

func changedUsernamesAfterImport(current []User, imported []User) []string {
	currentRoles := make(map[string]string, len(current))
	for _, user := range current {
		currentRoles[user.Username] = user.RoleID
	}
	importedRoles := make(map[string]string, len(imported))
	for _, user := range imported {
		importedRoles[user.Username] = user.RoleID
	}
	changed := make([]string, 0)
	seen := make(map[string]struct{})
	for _, user := range current {
		importedRole, ok := importedRoles[user.Username]
		if !ok || importedRole != user.RoleID {
			if _, exists := seen[user.Username]; !exists {
				changed = append(changed, user.Username)
				seen[user.Username] = struct{}{}
			}
		}
	}
	return changed
}

func (s *Server) revokeSessionsForUsernames(usernames []string) {
	if len(usernames) == 0 || s.sessions == nil {
		return
	}
	for _, username := range usernames {
		deleted := s.sessions.DeleteByUsername(username)
		for _, session := range deleted {
			if s.hub != nil {
				s.hub.RemoveWithReason(session.Token, "configuration_import")
			}
		}
	}
}

func (s *Server) importConfigurationDocument(ctx context.Context, req ConfigurationImportRequest) (configurationState, []string, []string, error) {
	currentState, err := s.store.currentConfigurationState(ctx)
	if err != nil {
		return configurationState{}, nil, nil, err
	}
	currentState.AckEnabled = s.isAckEnabled()
	mergedState, sections, err := mergeConfigurationImport(currentState, req.Document, req.Sections)
	if err != nil {
		return configurationState{}, nil, nil, err
	}
	updateUsers := slices.Contains(sections, configurationSectionUsers)
	rewriteStreamDeck := updateUsers || slices.Contains(sections, configurationSectionStreamDeck)
	if err := s.store.ReplaceConfiguration(ctx, mergedState, updateUsers, rewriteStreamDeck); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return configurationState{}, nil, nil, ErrNotFound
		}
		return configurationState{}, nil, nil, err
	}
	if slices.Contains(sections, configurationSectionAckSettings) {
		s.setAckEnabled(mergedState.AckEnabled)
	}
	var revokedUsernames []string
	if updateUsers {
		revokedUsernames = changedUsernamesAfterImport(currentState.Users, mergedState.Users)
	}
	return mergedState, sections, revokedUsernames, nil
}

func (s *Server) broadcastImportedConfiguration(state configurationState) {
	if s.hub == nil {
		return
	}
	s.hub.BroadcastConfigUpdate(PublicBootstrapResponse{
		Roles:           state.Roles,
		Rooms:           state.Rooms,
		BroadcastGroups: state.BroadcastGroups,
		AckEnabled:      s.isAckEnabled(),
		AppVersion:      GetVersionInfo(),
	})
}
