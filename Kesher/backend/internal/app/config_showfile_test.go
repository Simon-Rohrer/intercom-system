package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestExportConfigurationDocumentIncludesMetadataHeader(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store}
	doc, err := s.exportConfigurationDocument(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if doc.Meta.Format != configurationDocumentFormat {
		t.Fatalf("unexpected document format: %q", doc.Meta.Format)
	}
	if doc.Meta.SchemaVersion != configurationDocumentSchemaVersion {
		t.Fatalf("unexpected schema version: %d", doc.Meta.SchemaVersion)
	}
	if len(doc.Meta.Sections) != len(allConfigurationSections) {
		t.Fatalf("expected all sections in metadata, got %v", doc.Meta.Sections)
	}
	if doc.AckSettings == nil {
		t.Fatal("expected ack settings to be exported")
	}
}

func TestExportConfigurationDocumentIncludesStreamDeckSettings(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	user, err := store.UpsertUser(context.Background(), "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}
	if _, err := store.UpsertUserStreamDeckSettings(context.Background(), user.ID, settings); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store}
	doc, err := s.exportConfigurationDocument(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(doc.StreamDeck) != 1 {
		t.Fatalf("expected 1 stream deck assignment, got %d", len(doc.StreamDeck))
	}
	if doc.StreamDeck[0].RoleID != "audio" {
		t.Fatalf("unexpected stream deck role id: %q", doc.StreamDeck[0].RoleID)
	}
	if doc.StreamDeck[0].Settings.Pages[0].Buttons[0].Action == nil || doc.StreamDeck[0].Settings.Pages[0].Buttons[0].Action.Type != StreamDeckActionTypeReplyToCaller {
		t.Fatalf("unexpected stream deck action: %+v", doc.StreamDeck[0].Settings.Pages[0].Buttons[0].Action)
	}
}

func TestExportConfigurationDocumentSupportsSelectedSections(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	doc, err := s.exportConfigurationDocument(context.Background(), []string{
		configurationSectionRoles,
		configurationSectionRooms,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slicesEqual(doc.Meta.Sections, []string{configurationSectionRoles, configurationSectionRooms}) {
		t.Fatalf("unexpected selected sections: %v", doc.Meta.Sections)
	}
	if len(doc.Roles) == 0 || len(doc.Rooms) == 0 {
		t.Fatal("expected selected sections to contain data")
	}
	if len(doc.Users) != 0 || doc.AckSettings != nil || len(doc.TelegramMappings) != 0 {
		t.Fatal("expected unselected sections to be omitted")
	}
}

func TestConfigurationShowfileFullRoundTrip(t *testing.T) {
	ctx := context.Background()
	sourceStore, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer sourceStore.Close()

	user, err := sourceStore.UpsertUser(ctx, "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	if err := sourceStore.CreateTelegramMapping(ctx, "telegram-room-1", "-100123", "FOH Chat", "foh"); err != nil {
		t.Fatal(err)
	}
	if err := sourceStore.CreateTelegramAllowlistEntry(ctx, "allow-1", "alice_tg", "alice"); err != nil {
		t.Fatal(err)
	}
	if err := sourceStore.CreateTelegramUserMapping(ctx, "telegram-user-1", "42", "alice", "4242"); err != nil {
		t.Fatal(err)
	}
	if _, err := sourceStore.ToggleTelegramUserRoomSubscription(ctx, "42", "foh"); err != nil {
		t.Fatal(err)
	}
	streamDeck := DefaultStreamDeckSettings()
	streamDeck.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}
	if _, err := sourceStore.UpsertRoleStreamDeckSettings(ctx, "audio", streamDeck); err != nil {
		t.Fatal(err)
	}
	profile := CompanionProfileResponse{
		RoleID:          "audio",
		Username:        "alice",
		StreamDeck:      streamDeck,
		Rooms:           []CompanionRoomDiscovery{},
		Users:           []User{},
		BroadcastGroups: []BroadcastGroup{},
	}
	if _, err := sourceStore.PublishCompanionProfile(ctx, "audio", user.ID, profile); err != nil {
		t.Fatal(err)
	}
	if err := sourceStore.SaveCompanionRolePage(ctx, "audio", 3); err != nil {
		t.Fatal(err)
	}

	sourceServer := &Server{store: sourceStore, ackEnabled: false, ackSet: true}
	sourceDocument, err := sourceServer.exportConfigurationDocument(ctx)
	if err != nil {
		t.Fatal(err)
	}

	destinationStore, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer destinationStore.Close()
	destinationServer := &Server{store: destinationStore, ackEnabled: true, ackSet: true}
	if _, sections, _, err := destinationServer.importConfigurationDocument(ctx, ConfigurationImportRequest{
		Document: sourceDocument,
		Sections: append([]string(nil), sourceDocument.Meta.Sections...),
	}); err != nil {
		t.Fatal(err)
	} else if !reflect.DeepEqual(sections, sourceDocument.Meta.Sections) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}

	destinationDocument, err := destinationServer.exportConfigurationDocument(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertConfigurationPayloadEqual(t, sourceDocument, destinationDocument)
}

func TestImportConfigurationClearsMissingDefaultRoomFromLegacyShowfile(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	sections := []string{
		configurationSectionRoles,
		configurationSectionRooms,
		configurationSectionBroadcastGroups,
	}
	doc := ConfigurationDocument{
		Meta: ConfigurationMetadata{
			Format:        configurationDocumentFormat,
			SchemaVersion: configurationDocumentSchemaVersion,
			ExportedAt:    time.Now().UTC().Format(time.RFC3339),
			Sections:      sections,
		},
		Roles: []Role{{
			ID:               "pastor",
			Name:             "Pastor",
			DefaultRoomID:    "stage",
			DefaultVoiceMode: "ptt",
		}},
		Rooms: []Room{{
			ID:              "foh",
			Name:            "FOH",
			SenderRoleIDs:   []string{"pastor"},
			ReceiverRoleIDs: []string{"pastor"},
		}},
		BroadcastGroups: []BroadcastGroup{{
			ID:             "all",
			Name:           "All",
			RoomIDs:        []string{"foh"},
			AllowedRoleIDs: []string{"pastor"},
		}},
	}

	s := &Server{store: store}
	state, importedSections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: doc,
		Sections: sections,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slicesEqual(importedSections, sections) {
		t.Fatalf("unexpected imported sections: %v", importedSections)
	}
	if len(state.Roles) != 1 || state.Roles[0].DefaultRoomID != "" {
		t.Fatalf("expected missing default room to be cleared, got %+v", state.Roles)
	}
	warnings := configurationImportWarnings(doc, importedSections)
	if len(warnings) != 1 || !strings.Contains(warnings[0], "stage") {
		t.Fatalf("expected warning for missing stage room, got %v", warnings)
	}
}

func assertConfigurationPayloadEqual(t *testing.T, expected, actual ConfigurationDocument) {
	t.Helper()
	if !reflect.DeepEqual(expected.Meta.Sections, actual.Meta.Sections) ||
		!reflect.DeepEqual(expected.Roles, actual.Roles) ||
		!reflect.DeepEqual(expected.Users, actual.Users) ||
		!reflect.DeepEqual(expected.Rooms, actual.Rooms) ||
		!reflect.DeepEqual(expected.BroadcastGroups, actual.BroadcastGroups) ||
		!reflect.DeepEqual(expected.TelegramAllowlist, actual.TelegramAllowlist) ||
		!reflect.DeepEqual(expected.TelegramMappings, actual.TelegramMappings) ||
		!reflect.DeepEqual(expected.TelegramUsers, actual.TelegramUsers) ||
		!reflect.DeepEqual(expected.AckSettings, actual.AckSettings) ||
		!reflect.DeepEqual(expected.StreamDeck, actual.StreamDeck) ||
		!reflect.DeepEqual(expected.CompanionProfiles, actual.CompanionProfiles) ||
		!reflect.DeepEqual(expected.CompanionRolePages, actual.CompanionRolePages) {
		expectedJSON, _ := json.MarshalIndent(expected, "", "  ")
		actualJSON, _ := json.MarshalIndent(actual, "", "  ")
		t.Fatalf("showfile payloads differ after round trip\nexpected: %s\nactual: %s", expectedJSON, actualJSON)
	}
}

func TestImportConfigurationReplacesSelectedSectionsAndPreservesOthers(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if err := store.CreateRole(context.Background(), "qa", "QA", "foh", "ptt", false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertUser(context.Background(), "alice", "audio"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateTelegramMapping(context.Background(), "mapping-keep", "-100keep", "Keep", "foh"); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCompanionRolePage(context.Background(), "audio", 2); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	state, sections, revoked, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionRoles, configurationSectionAckSettings},
			},
			Roles: []Role{
				{ID: "audio", Name: "A1", DefaultRoomID: "foh", DefaultVoiceMode: "ptt"},
				{ID: "video", Name: "Video", DefaultRoomID: "stage", DefaultVoiceMode: "always_on"},
				{ID: "broadcast", Name: "Broadcast", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
				{ID: "camera", Name: "Camera", DefaultRoomID: "stage", DefaultVoiceMode: "ptt", DefaultSimpleView: true},
				{ID: "pastor", Name: "Pastor", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
				{ID: "producer", Name: "Producer", DefaultRoomID: "foh", DefaultVoiceMode: "ptt"},
				{ID: "lighting", Name: "Lighting", DefaultRoomID: "stage", DefaultVoiceMode: "ptt"},
				{ID: "qa", Name: "Quality", DefaultRoomID: "foh", DefaultVoiceMode: "ptt"},
			},
			AckSettings: &AckSettings{Enabled: false},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(revoked) != 0 {
		t.Fatalf("expected no revoked users, got %v", revoked)
	}
	if !slicesEqual(sections, []string{configurationSectionRoles, configurationSectionAckSettings}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
	if len(state.Rooms) == 0 || len(state.BroadcastGroups) == 0 {
		t.Fatal("expected non-selected sections to be preserved")
	}
	if state.AckEnabled {
		t.Fatal("expected imported ack setting to be false")
	}
	roles, err := store.ListRoles(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, role := range roles {
		if role.ID == "qa" && role.Name == "Quality" {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("expected imported role to be stored")
	}
	users, err := store.ListUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("expected existing users to stay untouched, got %+v", users)
	}
	if s.isAckEnabled() {
		t.Fatal("expected server ack flag to be updated")
	}
	telegramMappings, err := store.ListTelegramMappings(context.Background())
	if err != nil || len(telegramMappings) != 1 || telegramMappings[0].ID != "mapping-keep" {
		t.Fatalf("expected non-selected telegram mappings to be preserved, got %+v (err=%v)", telegramMappings, err)
	}
	companionPages, err := store.GetAllCompanionRolePages(context.Background())
	if err != nil || companionPages["audio"] != 2 {
		t.Fatalf("expected non-selected companion pages to be preserved, got %+v (err=%v)", companionPages, err)
	}
}

func TestImportConfigurationRevokesChangedUserSessions(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	user, err := store.UpsertUser(context.Background(), "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s := &Server{store: store, sessions: NewSessionManager(time.Minute), hub: hub}
	session := s.sessions.Create(user)
	hub.Add(&client{
		session:      session,
		user:         user,
		connectedAt:  time.Now(),
		send:         make(chan WSOutbound, 1),
		sendPriority: make(chan WSOutbound, 1),
		listenRooms:  map[string]struct{}{},
		talkRooms:    map[string]struct{}{},
	})

	state, _, revoked, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionUsers},
			},
			Users: []ConfigurationUserAssignment{{Username: "alice", RoleID: "video"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	s.revokeSessionsForUsernames(revoked)
	if _, ok := s.sessions.Get(session.Token); ok {
		t.Fatal("expected changed user session to be revoked")
	}
	users, err := store.ListUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if users[0].RoleID != "video" {
		t.Fatalf("expected updated user role, got %+v", users[0])
	}
	if len(state.Users) == 0 || state.Users[0].RoleID != "video" {
		t.Fatalf("expected replaced state to reflect imported users, got %+v", state.Users)
	}
	if token, ok := hub.LatestTokenForUsername("alice"); ok && token == session.Token {
		t.Fatal("expected websocket client to be removed after revoke")
	}
}

func TestImportConfigurationUsersSectionRemovesMissingUsers(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.UpsertUser(context.Background(), "alice", "audio"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertUser(context.Background(), "bob", "video"); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store, sessions: NewSessionManager(time.Minute), ackEnabled: true, ackSet: true}
	_, _, revoked, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionUsers},
			},
			Users: []ConfigurationUserAssignment{{Username: "alice", RoleID: "audio"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	users, err := store.ListUsers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0].Username != "alice" {
		t.Fatalf("expected missing imported users to be removed, got %+v", users)
	}
	if len(revoked) != 1 || revoked[0] != "bob" {
		t.Fatalf("expected removed user to be revoked, got %v", revoked)
	}
}

func TestImportConfigurationReplacesTelegramAllowlist(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if _, err := store.UpsertUser(context.Background(), "tim", "audio"); err != nil {
		t.Fatal(err)
	}
	if err := store.CreateTelegramAllowlistEntry(context.Background(), "old-id", "old_telegram", "tim"); err != nil {
		t.Fatal(err)
	}

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	state, sections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionTelegramAllowlist},
			},
			TelegramAllowlist: []TelegramAllowlistEntry{
				{ID: "new-id", TelegramUsername: "tim_telegram", KesherUsername: "tim"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slicesEqual(sections, []string{configurationSectionTelegramAllowlist}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
	if len(state.TelegramAllowlist) != 1 || state.TelegramAllowlist[0].TelegramUsername != "tim_telegram" {
		t.Fatalf("unexpected imported allowlist state: %+v", state.TelegramAllowlist)
	}
	entries, err := store.ListTelegramAllowlistEntries(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected 1 allowlist entry after replace, got %d", len(entries))
	}
	if entries[0].TelegramUsername != "tim_telegram" || entries[0].KesherUsername != "tim" {
		t.Fatalf("unexpected allowlist entry after import: %+v", entries[0])
	}
}

func TestImportConfigurationAcceptsOmittedEmptyTelegramAllowlistField(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	_, sections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionTelegramAllowlist},
			},
			// telegramAllowlist intentionally omitted (nil) to mirror JSON omitempty round-trips.
		},
	})
	if err != nil {
		t.Fatalf("expected omitted empty telegramAllowlist field to be accepted, got %v", err)
	}
	if !slicesEqual(sections, []string{configurationSectionTelegramAllowlist}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
}

func TestImportConfigurationReplacesStreamDeckSettings(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	user, err := store.UpsertUser(context.Background(), "alice", "audio")
	if err != nil {
		t.Fatal(err)
	}
	initial := DefaultStreamDeckSettings()
	initial.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeReplyToCaller}
	if _, err := store.UpsertUserStreamDeckSettings(context.Background(), user.ID, initial); err != nil {
		t.Fatal(err)
	}

	updated := DefaultStreamDeckSettings()
	updated.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypePageUp}

	s := &Server{store: store, ackEnabled: true, ackSet: true}
	_, sections, _, err := s.importConfigurationDocument(context.Background(), ConfigurationImportRequest{
		Document: ConfigurationDocument{
			Meta: ConfigurationMetadata{
				Format:        configurationDocumentFormat,
				SchemaVersion: configurationDocumentSchemaVersion,
				ExportedAt:    time.Now().UTC().Format(time.RFC3339),
				Sections:      []string{configurationSectionStreamDeck},
			},
			StreamDeck: []ConfigurationRoleStreamDeckSettings{
				{RoleID: "audio", Settings: updated},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slicesEqual(sections, []string{configurationSectionStreamDeck}) {
		t.Fatalf("unexpected imported sections: %v", sections)
	}
	loaded, err := store.GetUserStreamDeckSettings(context.Background(), user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Pages[0].Buttons[0].Action == nil || loaded.Pages[0].Buttons[0].Action.Type != StreamDeckActionTypePageUp {
		t.Fatalf("expected imported stream deck action, got %+v", loaded.Pages[0].Buttons[0].Action)
	}
}

func TestHandleAdminConfigurationExportReturnsJSONDocument(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	adminSession := s.sessions.Create(User{Username: "admin"})
	req := httptest.NewRequest(http.MethodGet, "/api/admin/configuration-export", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminConfigurationExport(rec, req, adminSession)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var doc ConfigurationDocument
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if doc.Meta.Format != configurationDocumentFormat {
		t.Fatalf("unexpected format: %q", doc.Meta.Format)
	}
	if rec.Header().Get("Content-Disposition") == "" {
		t.Fatal("expected attachment header to be set")
	}
}

func TestHandleAdminConfigurationExportFiltersRequestedSections(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	adminSession := s.sessions.Create(User{Username: "admin"})
	req := httptest.NewRequest(http.MethodGet, "/api/admin/configuration-export?sections=roles,rooms", nil)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminConfigurationExport(rec, req, adminSession)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var doc ConfigurationDocument
	if err := json.Unmarshal(rec.Body.Bytes(), &doc); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if !slicesEqual(doc.Meta.Sections, []string{configurationSectionRoles, configurationSectionRooms}) {
		t.Fatalf("unexpected exported sections: %v", doc.Meta.Sections)
	}
	if len(doc.Roles) == 0 || len(doc.Rooms) == 0 || len(doc.Users) != 0 {
		t.Fatalf("unexpected filtered export payload: %+v", doc)
	}
}

func TestHandleAdminConfigurationImportRejectsInvalidMetadata(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	s := &Server{store: store, sessions: NewSessionManager(time.Minute)}
	adminSession := s.sessions.Create(User{Username: "admin"})
	body := bytes.NewBufferString(`{"document":{"meta":{"format":"bad","schemaVersion":1,"exportedAt":"2026-03-14T10:00:00Z","sections":["roles"]},"roles":[]}}`)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/configuration-import", body)
	req.Header.Set("X-Admin-Pin", "123456")
	rec := httptest.NewRecorder()
	s.handleAdminConfigurationImport(rec, req, adminSession)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rec.Code)
	}
}

func slicesEqual(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
