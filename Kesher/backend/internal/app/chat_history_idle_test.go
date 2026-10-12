package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestChatHistoryClearIfIdle(t *testing.T) {
	h := NewChatHistory(10)
	start := time.Now()

	if h.ClearIfIdle(start.Add(7*time.Hour), 6*time.Hour) {
		t.Fatalf("an empty history must not report a clear")
	}

	h.AppendGlobal(RoutedEvent{Scope: "global", TargetID: "global", Body: "Hallo", MessageID: "m1"})
	h.AppendForRoom("foh", RoutedEvent{Scope: "room", TargetID: "foh", Body: "FOH", MessageID: "m2"})
	h.AppendForUser("u1", RoutedEvent{Scope: "direct", TargetID: "u1", Body: "Direkt", MessageID: "m3"})

	if h.ClearIfIdle(time.Now().Add(5*time.Hour+59*time.Minute), 6*time.Hour) {
		t.Fatalf("history was cleared before six idle hours")
	}
	if h.ClearIfIdle(time.Now().Add(7*time.Hour), 0) {
		t.Fatalf("an idle limit of 0 must disable the cleanup")
	}
	if !h.ClearIfIdle(time.Now().Add(6*time.Hour), 6*time.Hour) {
		t.Fatalf("expected the history to be cleared after six idle hours")
	}
	if got := h.HistoryForUserAndRooms("u1", []string{"foh"}); len(got) != 0 {
		t.Fatalf("expected an empty history after the idle clear, got %+v", got)
	}
	if h.ClearIfIdle(time.Now().Add(24*time.Hour), 6*time.Hour) {
		t.Fatalf("a cleared history must not be cleared (and broadcast) again")
	}
}

func TestChatHistoryNewMessageRestartsIdleTime(t *testing.T) {
	h := NewChatHistory(10)
	h.AppendGlobal(RoutedEvent{Scope: "global", TargetID: "global", Body: "Erste", MessageID: "m1"})
	h.mu.Lock()
	h.lastMessageAt = time.Now().Add(-5 * time.Hour)
	h.mu.Unlock()

	h.AppendGlobal(RoutedEvent{Scope: "global", TargetID: "global", Body: "Zweite", MessageID: "m2"})
	if h.ClearIfIdle(time.Now().Add(2*time.Hour), 6*time.Hour) {
		t.Fatalf("a new message must restart the idle time")
	}
}

func TestHubClearChatHistoryIfIdleNotifiesClients(t *testing.T) {
	s := newCompanionTestServer(t)
	if err := s.store.CreateRole(t.Context(), "idle-role", "Idle Rolle", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	c := newChatTestClient(t, s, "Monitor", "idle-role")
	s.hub.chatHistory.AppendGlobal(RoutedEvent{Scope: "global", TargetID: "global", Body: "Hallo", MessageID: "m1"})

	if s.hub.ClearChatHistoryIfIdle(time.Now(), 6*time.Hour) {
		t.Fatalf("history was cleared without being idle")
	}
	if !s.hub.ClearChatHistoryIfIdle(time.Now().Add(6*time.Hour), 6*time.Hour) {
		t.Fatalf("expected an idle clear")
	}
	cleared := false
	for len(c.send) > 0 || len(c.sendPriority) > 0 {
		var msg WSOutbound
		select {
		case msg = <-c.sendPriority:
		case msg = <-c.send:
		}
		if msg.Type == "chat_history_cleared" {
			cleared = true
		}
	}
	if !cleared {
		t.Fatalf("expected clients to receive chat_history_cleared")
	}
}

func TestChatHistoryIdleClearConfig(t *testing.T) {
	if got := defaultConfig().ChatHistoryIdleClear; got != 6*time.Hour {
		t.Fatalf("expected a 6h default, got %v", got)
	}

	t.Setenv("CHAT_HISTORY_IDLE_CLEAR_MINUTES", "")
	if got := loadConfigFromEnv().ChatHistoryIdleClear; got != 6*time.Hour {
		t.Fatalf("expected a 6h default from env, got %v", got)
	}
	t.Setenv("CHAT_HISTORY_IDLE_CLEAR_MINUTES", "90")
	if got := loadConfigFromEnv().ChatHistoryIdleClear; got != 90*time.Minute {
		t.Fatalf("expected 90m from env, got %v", got)
	}
	t.Setenv("CHAT_HISTORY_IDLE_CLEAR_MINUTES", "0")
	if got := loadConfigFromEnv().ChatHistoryIdleClear; got != 0 {
		t.Fatalf("expected 0 to disable the cleanup, got %v", got)
	}

	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte("chat_history_idle_clear_minutes: 30\n"), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	cfg, err := loadConfigFromFile(path)
	if err != nil {
		t.Fatalf("loadConfigFromFile: %v", err)
	}
	if cfg.ChatHistoryIdleClear != 30*time.Minute {
		t.Fatalf("expected 30m from file, got %v", cfg.ChatHistoryIdleClear)
	}
}
