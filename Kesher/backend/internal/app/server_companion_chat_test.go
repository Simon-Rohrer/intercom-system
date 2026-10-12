package app

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func newChatTestClient(t *testing.T, s *Server, username, roleID string, listenRooms ...string) *client {
	t.Helper()
	user, err := s.store.UpsertUser(context.Background(), username, roleID)
	if err != nil {
		t.Fatalf("UpsertUser %s failed: %v", username, err)
	}
	listen := map[string]struct{}{}
	for _, roomID := range listenRooms {
		listen[roomID] = struct{}{}
	}
	c := &client{
		session:      s.sessions.Create(user),
		user:         user,
		send:         make(chan WSOutbound, 16),
		sendPriority: make(chan WSOutbound, 16),
		listenRooms:  listen,
		talkRooms:    map[string]struct{}{},
	}
	s.hub.Add(c)
	return c
}

func nextChatEvent(t *testing.T, c *client) RoutedEvent {
	t.Helper()
	for {
		var msg WSOutbound
		select {
		case msg = <-c.sendPriority:
		case msg = <-c.send:
		default:
			t.Fatalf("expected a chat message for %s", c.user.Username)
		}
		if msg.Type != "chat" {
			continue
		}
		event, ok := msg.Data.(RoutedEvent)
		if !ok {
			t.Fatalf("expected RoutedEvent payload, got %T", msg.Data)
		}
		return event
	}
}

func setupChatButton(t *testing.T, s *Server, roleID string, action StreamDeckButtonAction) {
	t.Helper()
	settings := DefaultStreamDeckSettings()
	settings.Pages[0].Buttons[0].Action = &action
	if _, err := s.store.UpsertRoleStreamDeckSettings(context.Background(), roleID, settings); err != nil {
		t.Fatalf("UpsertRoleStreamDeckSettings failed: %v", err)
	}
}

func TestCompanionChatMessageUsesOnlineStationAsSender(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	if err := s.store.CreateRole(ctx, "sd-light", "SD Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "sd-monitor", "SD Monitor", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole monitor failed: %v", err)
	}
	station := newChatTestClient(t, s, "Licht", "sd-light")
	monitor := newChatTestClient(t, s, "Chat-Monitor", "sd-monitor")
	setupChatButton(t, s, "sd-light", StreamDeckButtonAction{Type: StreamDeckActionTypeChatMessage, Message: "  Bitte leiser  "})

	res := s.executeCompanionButtonPress(ctx, "sd-light", "Licht", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !res.OK || res.Status != "executed" {
		t.Fatalf("expected chat button to execute, got %+v", res)
	}
	event := nextChatEvent(t, monitor)
	if event.Scope != "global" || event.Body != "Bitte leiser" || event.Source != "companion" || event.MessageID == "" {
		t.Fatalf("unexpected chat event: %+v", event)
	}
	if event.FromUser.Username != "Licht" || event.FromUser.RoleID != "sd-light" {
		t.Fatalf("expected the station as sender, got %+v", event.FromUser)
	}
	// The sender sees its own message as well.
	if own := nextChatEvent(t, station); own.MessageID != event.MessageID {
		t.Fatalf("expected sender echo, got %+v", own)
	}

	// Releasing the button must not send a second message.
	up := s.executeCompanionButtonPress(ctx, "sd-light", "Licht", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "up"})
	if !up.OK {
		t.Fatalf("expected release to succeed, got %+v", up)
	}
	for len(monitor.send) > 0 {
		if msg := <-monitor.send; msg.Type == "chat" {
			t.Fatalf("release sent another chat message: %+v", msg.Data)
		}
	}
}

func TestCompanionChatMessageWithoutStationUsesRoleAsSender(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	if err := s.store.CreateRole(ctx, "sd-light", "SD Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole lighting failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "sd-audio", "SD Ton", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole audio failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "sd-foh", "SD FOH", []string{"sd-light"}, []string{"sd-audio"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}
	listener := newChatTestClient(t, s, "Ton", "sd-audio", "sd-foh")
	setupChatButton(t, s, "sd-light", StreamDeckButtonAction{Type: StreamDeckActionTypeChatMessage, Message: "Bitte leiser", RoomID: "sd-foh"})

	res := s.executeCompanionButtonPress(ctx, "sd-light", "", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if !res.OK {
		t.Fatalf("expected chat button to execute without a station, got %+v", res)
	}
	event := nextChatEvent(t, listener)
	if event.Scope != "room" || event.TargetID != "sd-foh" || event.Body != "Bitte leiser" {
		t.Fatalf("unexpected chat event: %+v", event)
	}
	if event.FromUser.Username != "SD Licht" || event.FromUser.RoleID != "sd-light" {
		t.Fatalf("expected the role as sender, got %+v", event.FromUser)
	}
	history := s.hub.chatHistory.HistoryForRooms([]string{"sd-foh"})
	if len(history) != 1 || history[0].MessageID != event.MessageID {
		t.Fatalf("expected the message in the party-line history, got %+v", history)
	}
}

func TestCompanionChatMessageRejectsPartyLineWithoutTalkPermission(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	if err := s.store.CreateRole(ctx, "sd-light", "SD Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole lighting failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "sd-audio", "SD Ton", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole audio failed: %v", err)
	}
	if err := s.store.CreateRoom(ctx, "sd-foh", "SD FOH", []string{"sd-audio"}, []string{"sd-audio"}, nil); err != nil {
		t.Fatalf("CreateRoom failed: %v", err)
	}
	listener := newChatTestClient(t, s, "Ton", "sd-audio", "sd-foh")
	setupChatButton(t, s, "sd-light", StreamDeckButtonAction{Type: StreamDeckActionTypeChatMessage, Message: "Bitte leiser", RoomID: "sd-foh"})

	res := s.executeCompanionButtonPress(ctx, "sd-light", "", CompanionCommand{Command: "press_button", ButtonIndex: 0, State: "down"})
	if res.OK || res.Status != "rejected" {
		t.Fatalf("expected rejection without talk permission, got %+v", res)
	}
	for len(listener.send) > 0 {
		if msg := <-listener.send; msg.Type == "chat" {
			t.Fatalf("rejected button still sent %+v", msg.Data)
		}
	}
	if history := s.hub.chatHistory.HistoryForRooms([]string{"sd-foh"}); len(history) != 0 {
		t.Fatalf("rejected button was recorded in history: %+v", history)
	}
}

func TestValidateStreamDeckSettingsChatMessage(t *testing.T) {
	cases := map[string]struct {
		message string
		valid   bool
	}{
		"text":     {message: "Bitte leiser", valid: true},
		"empty":    {message: "   ", valid: false},
		"max":      {message: strings.Repeat("ä", StreamDeckChatMessageMaxLength), valid: true},
		"too long": {message: strings.Repeat("a", StreamDeckChatMessageMaxLength+1), valid: false},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			settings := DefaultStreamDeckSettings()
			settings.Pages[0].Buttons[0].Action = &StreamDeckButtonAction{Type: StreamDeckActionTypeChatMessage, Message: tc.message}
			_, err := validateStreamDeckSettings(settings)
			if tc.valid && err != nil {
				t.Fatalf("expected valid settings, got %v", err)
			}
			if !tc.valid && !errors.Is(err, ErrInvalidInput) {
				t.Fatalf("expected ErrInvalidInput, got %v", err)
			}
		})
	}
}
