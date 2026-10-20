package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAdminPINRateLimitIsPerSource(t *testing.T) {
	s := newCompanionTestServer(t)
	for attempt := 0; attempt < 8; attempt++ {
		req := httptest.NewRequest(http.MethodPost, "/api/admin/login", strings.NewReader(`{"pin":"wrong"}`))
		req.RemoteAddr = "192.0.2.1:5000"
		rec := httptest.NewRecorder()
		s.handleAdminLogin(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("attempt %d: %d", attempt, rec.Code)
		}
	}
	blocked := httptest.NewRequest(http.MethodPost, "/api/admin/login", strings.NewReader(`{"pin":"123456"}`))
	blocked.RemoteAddr = "192.0.2.1:5000"
	blocked.Header.Set("X-Forwarded-For", "192.0.2.99")
	rec := httptest.NewRecorder()
	s.handleAdminLogin(rec, blocked)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") == "" {
		t.Fatal("blocked source bypassed limiter")
	}
	other := httptest.NewRequest(http.MethodPost, "/api/admin/login", strings.NewReader(`{"pin":"123456"}`))
	other.RemoteAddr = "192.0.2.2:5000"
	rec = httptest.NewRecorder()
	s.handleAdminLogin(rec, other)
	if rec.Code != http.StatusOK {
		t.Fatalf("unrelated source blocked: %d", rec.Code)
	}
	s.adminPINMu.Lock()
	s.adminPINAttempts["192.0.2.1"].WindowStart = time.Now().Add(-16 * time.Minute)
	s.adminPINMu.Unlock()
	retry := httptest.NewRequest(http.MethodPost, "/api/admin/login", strings.NewReader(`{"pin":"123456"}`))
	retry.RemoteAddr = "192.0.2.1:5000"
	rec = httptest.NewRecorder()
	s.handleAdminLogin(rec, retry)
	if rec.Code != http.StatusOK {
		t.Fatalf("expired limit not released: %d", rec.Code)
	}
}

func TestAdminPINConcurrentVerificationIsBounded(t *testing.T) {
	s := newCompanionTestServer(t)
	req := httptest.NewRequest(http.MethodPost, "/api/admin/login", nil)
	finishers := make([]func(bool), 0, 4)
	for attempt := 0; attempt < 4; attempt++ {
		finish, ok := s.beginAdminPINAttempt(httptest.NewRecorder(), req)
		if !ok {
			t.Fatal("allowed concurrent verification rejected")
		}
		finishers = append(finishers, finish)
	}
	if _, ok := s.beginAdminPINAttempt(httptest.NewRecorder(), req); ok {
		t.Fatal("concurrent verification limit bypassed")
	}
	for _, finish := range finishers {
		finish(false)
	}
	if s.adminPINInFlight != 0 {
		t.Fatal("verification slots leaked")
	}
}

func TestGatewayCannotCreateIndependentSessions(t *testing.T) {
	s := newCompanionTestServer(t)
	s.cfg.JMSAuthURL = "https://central.example"
	for name, handler := range map[string]http.HandlerFunc{"login": s.handleLogin, "takeover": s.handleLoginTakeover, "admin": s.handleAdminLogin} {
		t.Run(name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{}`))
			req.Header.Set("X-JMS-Gateway", "central")
			rec := httptest.NewRecorder()
			handler(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Fatalf("independent session status %d", rec.Code)
			}
		})
	}
	legacy := s.sessions.Create(User{Username: "native", RoleID: "licht"})
	req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	req.Header.Set("X-JMS-Gateway", "central")
	req.Header.Set("X-JMS-Session-Id", "parent")
	if s.validateSessionRequest(req, legacy) {
		t.Fatal("independent token accepted in central browser context")
	}
	req.Header.Set("X-JMS-Gateway", "machine")
	if s.validateSessionRequest(req, legacy) {
		t.Fatal("unbound independent token accepted through forged machine header")
	}
}

func TestWebSocketOriginsAreRestricted(t *testing.T) {
	for _, testCase := range []struct {
		origin    string
		gateway   string
		fetchSite string
		allowed   bool
	}{
		{"https://intercom.local", "central", "same-origin", true},
		{"https://attacker.local", "central", "cross-site", false},
		{"https://intercom.local.attacker.example", "central", "cross-site", false},
		{"https://intercom.local/path", "central", "same-origin", false},
		{"null", "central", "cross-site", false},
		{"", "central", "", false},
		{"", "machine", "", true},
		{"", "machine", "cross-site", false},
		{"tauri://localhost", "machine", "", true},
		{"tauri://localhost", "central", "", false},
	} {
		req := httptest.NewRequest(http.MethodGet, "https://intercom.local/ws", nil)
		req.Header.Set("Origin", testCase.origin)
		req.Header.Set("X-JMS-Gateway", testCase.gateway)
		req.Header.Set("Sec-Fetch-Site", testCase.fetchSite)
		if allowedWebSocketOrigin(req) != testCase.allowed {
			t.Errorf("origin %q gateway %q result mismatch", testCase.origin, testCase.gateway)
		}
	}
}

// The authenticated WebSocket proxy forwards the public Origin with the
// loopback upstream Host. Test that deployed path, not just matching hosts.
func TestWebSocketOriginsBehindCentralProxy(t *testing.T) {
	for _, origin := range []string{
		"https://intercom.internal", "https://kesher.internal", "https://192.168.0.21:8443",
		"https://intercom.local", "https://kesher.local",
	} {
		t.Run(origin, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/ws", nil)
			req.Header.Set("Origin", origin)
			req.Header.Set("X-JMS-Gateway", "central")
			req.Header.Set("Sec-Fetch-Site", "same-origin")
			if !allowedWebSocketOrigin(req) {
				t.Fatalf("legitimate proxied origin rejected: %s", origin)
			}
		})
	}
	for _, origin := range []string{
		"https://intercom.internal.attacker.example", "https://kesher.internal.attacker.example",
		"http://intercom.internal", "https://intercom.internal:9443", "https://kesher.internal/path",
		"https://attacker.example@kesher.internal", "https://kesher.internal?query=1", "null", "",
	} {
		t.Run("reject "+origin, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:8080/ws", nil)
			req.Header.Set("Origin", origin)
			req.Header.Set("X-JMS-Gateway", "central")
			if allowedWebSocketOrigin(req) {
				t.Fatalf("unexpected proxied origin accepted: %s", origin)
			}
		})
	}
}

func TestAdminPINChangeRevokesCentralAndLocalAdmins(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, true)
	session := centralSessionFromResponse(t, s, postCentralLogin(s, signCentralTicket(t, testCentralSecret, state.claims("pin-ticket"))))
	legacy := s.sessions.Create(User{Username: "admin"})
	req := httptest.NewRequest(http.MethodPut, "/api/admin/pin", strings.NewReader(`{"newPin":"765432"}`))
	rec := httptest.NewRecorder()
	s.handleAdminPin(rec, req, session)
	if rec.Code != http.StatusOK {
		t.Fatalf("PIN update status %d: %s", rec.Code, rec.Body.String())
	}
	if state.revocations != 1 {
		t.Fatal("central admins were not revoked")
	}
	if _, ok := s.sessions.Get(session.Token); ok {
		t.Fatal("central local token remains")
	}
	if _, ok := s.sessions.Get(legacy.Token); ok {
		t.Fatal("independent local admin token remains")
	}
	stored, err := s.store.GetAdminPIN(context.Background())
	if err != nil || stored != "765432" {
		t.Fatal("new PIN not persisted")
	}
}

func TestAdminPINChangeFailsClosedWhenRevocationUnavailable(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, true)
	session := centralSessionFromResponse(t, s, postCentralLogin(s, signCentralTicket(t, testCentralSecret, state.claims("unavailable-revoke"))))
	state.mu.Lock()
	state.revocationUnavailable = true
	state.mu.Unlock()
	req := httptest.NewRequest(http.MethodPut, "/api/admin/pin", strings.NewReader(`{"newPin":"765432"}`))
	req.Header.Set("X-Admin-Pin", defaultAdminPIN)
	rec := httptest.NewRecorder()
	s.handleAdminPin(rec, req, session)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("PIN update status %d", rec.Code)
	}
	stored, err := s.store.GetAdminPIN(context.Background())
	if err != nil || stored != defaultAdminPIN {
		t.Fatal("PIN changed without central revocation")
	}
}

func TestCentralTicketReplayProtectionSurvivesRestart(t *testing.T) {
	path := filepath.Join(t.TempDir(), "auth.db")
	store, err := NewStore(path)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().Add(time.Minute).UnixMilli()
	accepted, err := store.consumeCentralTicket(context.Background(), "persistent-ticket", expiresAt)
	if err != nil || !accepted {
		t.Fatal("first redemption failed")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = NewStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	accepted, err = store.consumeCentralTicket(context.Background(), "persistent-ticket", expiresAt)
	if err != nil || accepted {
		t.Fatal("used ticket accepted after restart")
	}
	if _, err := store.db.Exec(`UPDATE central_ticket_redemptions SET expires_at=?`, time.Now().Add(-time.Second).UnixMilli()); err != nil {
		t.Fatal(err)
	}
	accepted, err = store.consumeCentralTicket(context.Background(), "fresh-ticket", expiresAt)
	if err != nil || !accepted {
		t.Fatal("fresh redemption failed")
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM central_ticket_redemptions`).Scan(&count); err != nil || count != 1 {
		t.Fatal("expired ticket identifiers not pruned")
	}
}

func TestSweepClosesAlreadyPrunedSessionConnection(t *testing.T) {
	s := newCompanionTestServer(t)
	session := s.sessions.Create(User{Username: "native"})
	closed := false
	s.hub.Add(&client{session: session, user: User{Username: "native"}, send: make(chan WSOutbound, 8), closeNow: func() error { closed = true; return nil }})
	s.sessions.Delete(session.Token)
	s.sweepCentralSessions(context.Background())
	if !closed {
		t.Fatal("pruned session retained realtime connection")
	}
}

func TestCentralSessionUsesParentExpiryInsteadOfNativeTTL(t *testing.T) {
	manager := NewSessionManager(time.Minute)
	parent := centralSessionStatus{Active: true, SessionID: "parent", Version: "version", ExpiresAt: time.Now().Add(24 * time.Hour).UnixMilli()}
	central := manager.CreateCentral(User{Username: "Simon", RoleID: "licht"}, parent, false)
	if central.ExpiresAt.UnixMilli() != parent.ExpiresAt {
		t.Fatal("central expiry diverged from parent")
	}
	native := manager.Create(User{Username: "native", RoleID: "native"})
	if time.Until(native.ExpiresAt) > time.Minute {
		t.Fatal("native TTL changed")
	}
}
