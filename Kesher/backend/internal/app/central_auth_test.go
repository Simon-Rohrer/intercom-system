package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const testCentralSecret = "test-secret-test-secret-test-secret"

// signCentralTicket builds a ticket the same way the Multiview does (access.js createTicket).
func signCentralTicket(t *testing.T, secret string, claims centralTicketClaims) string {
	t.Helper()
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestVerifyCentralTicket(t *testing.T) {
	now := time.Now()
	valid := centralTicketClaims{Name: "Simon", RoleID: "admin", Admin: true, Aud: "kesher", Exp: now.Add(time.Minute).UnixMilli()}
	valid.SessionID, valid.Version, valid.TicketID = "parent-session", "version-1", "ticket-1"

	if _, err := verifyCentralTicket(testCentralSecret, signCentralTicket(t, testCentralSecret, valid), now); err != nil {
		t.Fatalf("valid ticket rejected: %v", err)
	}
	cases := map[string]string{
		"wrong secret": signCentralTicket(t, "other-secret", valid),
		"expired": signCentralTicket(t, testCentralSecret, centralTicketClaims{
			Name: "Simon", Admin: true, Aud: "kesher", Exp: now.Add(-time.Second).UnixMilli(),
		}),
		"other audience": signCentralTicket(t, testCentralSecret, centralTicketClaims{
			Name: "Simon", Admin: true, Aud: "portainer", Exp: now.Add(time.Minute).UnixMilli(),
		}),
		"no signature": strings.Split(signCentralTicket(t, testCentralSecret, valid), ".")[0],
		"garbage":      "abc.def",
	}
	for name, ticket := range cases {
		if _, err := verifyCentralTicket(testCentralSecret, ticket, now); err == nil {
			t.Errorf("%s: expected rejection", name)
		}
	}
	if _, err := verifyCentralTicket("", signCentralTicket(t, "", valid), now); err == nil {
		t.Error("empty secret must never accept a ticket")
	}
}

func postCentralLogin(s *Server, ticket string) *httptest.ResponseRecorder {
	s.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	body, _ := json.Marshal(centralAdminLoginRequest{Ticket: ticket})
	req := httptest.NewRequest(http.MethodPost, "/api/admin/login/central", strings.NewReader(string(body)))
	rec := httptest.NewRecorder()
	s.handleCentralAdminLogin(rec, req)
	return rec
}

func TestCentralAdminLoginGrantsAdminWithoutPin(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, true)
	ticket := signCentralTicket(t, testCentralSecret, state.claims("ticket-admin"))

	rec := postCentralLogin(s, ticket)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res LoginResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	session, ok := s.sessions.Get(res.Token)
	if !ok || !session.CentralAdmin || session.CentralSessionID != "parent-session" || session.CentralVersion != "version-1" {
		t.Fatalf("expected a central admin session, got %+v", session)
	}

	// Admin request without X-Admin-Pin: allowed for the central admin session ...
	req := httptest.NewRequest(http.MethodGet, "/api/admin/logs", nil)
	if !s.requireAdmin(httptest.NewRecorder(), req, session) {
		t.Fatal("central admin session must count as admin")
	}
	// ... but not for an ordinary session
	if s.requireAdmin(httptest.NewRecorder(), req, s.sessions.Create(User{Username: "Tim", RoleID: "licht"})) {
		t.Fatal("ordinary session without PIN must not be admin")
	}
}

func TestCentralAdminLoginRejectsNonAdminAndMissingSecret(t *testing.T) {
	s := newCompanionTestServer(t)
	claims := centralTicketClaims{Name: "Tim", RoleID: "licht", Admin: false, Aud: "kesher", Exp: time.Now().Add(time.Minute).UnixMilli()}

	// No secret configured: the feature is off
	if rec := postCentralLogin(s, signCentralTicket(t, "", claims)); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("without secret: expected 503, got %d", rec.Code)
	}
	state := configureCentralTestServer(t, s, false)
	claims = state.claims("ticket-user")
	if rec := postCentralLogin(s, signCentralTicket(t, testCentralSecret, claims)); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin ticket: expected 403, got %d", rec.Code)
	}
	if rec := postCentralLogin(s, "forged.ticket"); rec.Code != http.StatusForbidden {
		t.Fatalf("forged ticket: expected 403, got %d", rec.Code)
	}
}

type centralTestState struct {
	mu                    sync.Mutex
	status                centralSessionStatus
	unavailable           bool
	revocationUnavailable bool
	revocations           int
}

func (state *centralTestState) claims(ticketID string) centralTicketClaims {
	state.mu.Lock()
	defer state.mu.Unlock()
	return centralTicketClaims{Name: state.status.Name, RoleID: state.status.RoleID, Admin: state.status.Admin, Aud: "kesher", Exp: time.Now().Add(55 * time.Second).UnixMilli(), SessionID: state.status.SessionID, Version: state.status.Version, TicketID: ticketID}
}

func configureCentralTestServer(t *testing.T, s *Server, admin bool) *centralTestState {
	t.Helper()
	roleID := "admin"
	if !admin {
		roleID = "licht"
	}
	state := &centralTestState{status: centralSessionStatus{Active: true, SessionID: "parent-session", Version: "version-1", Admin: admin, Name: "Simon", RoleID: roleID, ExpiresAt: time.Now().Add(30 * time.Second).UnixMilli()}}
	mock := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			SessionID string `json:"sessionId"`
			IssuedAt  int64  `json:"issuedAt"`
			Signature string `json:"signature"`
		}
		if r.Method != http.MethodPost || json.NewDecoder(r.Body).Decode(&request) != nil {
			http.Error(w, "invalid", http.StatusBadRequest)
			return
		}
		message := fmt.Sprintf("kesher:introspect:%s:%d", request.SessionID, request.IssuedAt)
		if r.URL.Path == "/.jms-auth/api/revoke-admin" {
			message = fmt.Sprintf("kesher:revoke-admin:%d", request.IssuedAt)
		}
		mac := hmac.New(sha256.New, []byte(testCentralSecret))
		mac.Write([]byte(message))
		given, err := hex.DecodeString(request.Signature)
		if err != nil || !hmac.Equal(given, mac.Sum(nil)) || time.Since(time.UnixMilli(request.IssuedAt)).Abs() > 30*time.Second {
			http.Error(w, "bad signature", http.StatusForbidden)
			return
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if state.unavailable {
			http.Error(w, "offline", http.StatusServiceUnavailable)
			return
		}
		if r.URL.Path == "/.jms-auth/api/revoke-admin" {
			if state.revocationUnavailable {
				http.Error(w, "offline", http.StatusServiceUnavailable)
				return
			}
			state.revocations++
			state.status.Active = false
			_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
			return
		}
		_ = json.NewEncoder(w).Encode(state.status)
	}))
	t.Cleanup(mock.Close)
	s.cfg.JMSAuthSecret = testCentralSecret
	s.cfg.JMSAuthURL = mock.URL
	s.centralHTTPClient = mock.Client()
	return state
}

func centralSessionFromResponse(t *testing.T, s *Server, response *httptest.ResponseRecorder) Session {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("login status %d: %s", response.Code, response.Body.String())
	}
	var login LoginResponse
	if err := json.Unmarshal(response.Body.Bytes(), &login); err != nil {
		t.Fatal(err)
	}
	session, ok := s.sessions.Get(login.Token)
	if !ok {
		t.Fatal("session missing")
	}
	return session
}

func TestCentralTicketIsSingleUse(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, true)
	ticket := signCentralTicket(t, testCentralSecret, state.claims("unique-ticket"))
	session := centralSessionFromResponse(t, s, postCentralLogin(s, ticket))
	if session.ExpiresAt.UnixMilli() != state.status.ExpiresAt {
		t.Fatal("parent expiry not retained")
	}
	if rec := postCentralLogin(s, ticket); rec.Code != http.StatusForbidden {
		t.Fatalf("replay returned %d", rec.Code)
	}
}

func TestCentralSessionRevocationClosesRealtimeAndDeniesHTTP(t *testing.T) {
	for _, reason := range []string{"logout", "version", "unavailable", "expiry"} {
		t.Run(reason, func(t *testing.T) {
			s := newCompanionTestServer(t)
			state := configureCentralTestServer(t, s, true)
			session := centralSessionFromResponse(t, s, postCentralLogin(s, signCentralTicket(t, testCentralSecret, state.claims("ticket"))))
			closed := make(chan struct{})
			s.hub.Add(&client{session: session, user: User{Username: "admin"}, send: make(chan WSOutbound, 8), closeNow: func() error { close(closed); return nil }})
			state.mu.Lock()
			switch reason {
			case "logout":
				state.status.Active = false
			case "version":
				state.status.Version = "version-2"
			case "unavailable":
				state.unavailable = true
			case "expiry":
				state.status.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
			}
			state.mu.Unlock()
			s.sweepCentralSessions(context.Background())
			select {
			case <-closed:
			default:
				t.Fatal("realtime connection remained open")
			}
			if _, ok := s.sessions.Get(session.Token); ok {
				t.Fatal("local token remained active")
			}
			req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
			req.Header.Set("Authorization", "Bearer "+session.Token)
			rec := httptest.NewRecorder()
			s.withAuth(func(http.ResponseWriter, *http.Request, Session) { t.Fatal("revoked token reached handler") })(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("revoked HTTP status %d", rec.Code)
			}
		})
	}
}

func TestCentralNormalLoginBindsRoleAndRejectsAdminEscalation(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, false)
	state.mu.Lock()
	state.status.Name = "Tim Beispiel"
	state.mu.Unlock()
	if err := s.store.CreateRole(context.Background(), "licht", "Licht", "", "ptt", false); err != nil {
		t.Fatal(err)
	}
	request, _ := json.Marshal(centralAdminLoginRequest{Ticket: signCentralTicket(t, testCentralSecret, state.claims("normal-ticket"))})
	req := httptest.NewRequest(http.MethodPost, "/api/login/central", strings.NewReader(string(request)))
	req.Header.Set("X-JMS-Gateway", "central")
	req.Header.Set("X-JMS-Session-Id", "parent-session")
	rec := httptest.NewRecorder()
	s.handleCentralSessionLogin(rec, req)
	session := centralSessionFromResponse(t, s, rec)
	if session.RoleID != "licht" || session.Username != "Tim Beispiel" || session.CentralAdmin {
		t.Fatal("normal identity changed")
	}
	stored, err := s.store.FindUserByID(context.Background(), session.UserID)
	if err != nil || stored.Username != "Tim Beispiel" {
		t.Fatal("full central name was not preserved in persistence")
	}
	req.Header.Set("X-Admin-Pin", defaultAdminPIN)
	if s.requireAdmin(httptest.NewRecorder(), req, session) {
		t.Fatal("ordinary central user escalated using a PIN header")
	}
	if !s.validateSessionRequest(req, session) {
		t.Fatal("matching parent rejected")
	}
	req.Header.Set("X-JMS-Session-Id", "other-session")
	if s.validateSessionRequest(req, session) {
		t.Fatal("different central context accepted")
	}
}

func TestCentralFullNamesDoNotRelaxNativeNamesOrAcceptControls(t *testing.T) {
	s := newCompanionTestServer(t)
	if err := s.store.CreateRole(context.Background(), "licht", "Licht", "", "ptt", false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.UpsertUser(context.Background(), "Tim Beispiel", "licht"); err != ErrInvalidInput {
		t.Fatal("native name restriction changed")
	}
	for _, name := range []string{"Tim\nBeispiel", "Tim\tBeispiel", "Tim\x00Beispiel", "Tim\x7fBeispiel"} {
		if _, err := s.store.upsertCentralUser(context.Background(), name, "licht"); err != ErrInvalidInput {
			t.Fatal("central control character accepted")
		}
	}
}

func TestCentralHTTPFailsClosedWithoutSweep(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, true)
	session := centralSessionFromResponse(t, s, postCentralLogin(s, signCentralTicket(t, testCentralSecret, state.claims("ticket"))))
	state.mu.Lock()
	state.unavailable = true
	state.mu.Unlock()
	req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	req.Header.Set("Authorization", "Bearer "+session.Token)
	rec := httptest.NewRecorder()
	s.withAuth(func(http.ResponseWriter, *http.Request, Session) { t.Fatal("outage reached handler") })(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("outage HTTP status %d", rec.Code)
	}
}

func TestCentralTicketRequiresParentNonceAndBoundedExpiry(t *testing.T) {
	now := time.Now()
	valid := centralTicketClaims{Name: "Simon", RoleID: "admin", Admin: true, Aud: "kesher", Exp: now.Add(time.Minute).UnixMilli(), SessionID: "parent", Version: "version", TicketID: "ticket"}
	for _, change := range []func(*centralTicketClaims){func(claims *centralTicketClaims) { claims.SessionID = "" }, func(claims *centralTicketClaims) { claims.Version = "" }, func(claims *centralTicketClaims) { claims.TicketID = "" }, func(claims *centralTicketClaims) { claims.Exp = now.UnixMilli() }, func(claims *centralTicketClaims) { claims.Exp = now.Add(time.Hour).UnixMilli() }} {
		claims := valid
		change(&claims)
		if _, err := verifyCentralTicket(testCentralSecret, signCentralTicket(t, testCentralSecret, claims), now); err == nil {
			t.Fatal("invalid claims accepted")
		}
	}
}

func TestCentralClientRequiresHTTPSAndValidCertificate(t *testing.T) {
	for _, origin := range []string{"http://127.0.0.1", "https://user:pass@host", "https://host/path", "https://host?query=true"} {
		if _, err := newCentralHTTPClient(Config{JMSAuthURL: origin}); err == nil {
			t.Fatalf("unsafe origin accepted: %s", origin)
		}
	}
	if _, err := newCentralHTTPClient(Config{JMSAuthURL: "https://127.0.0.1", JMSAuthCAFile: "/missing-cert.pem"}); err == nil {
		t.Fatal("missing certificate accepted")
	}
	mock := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]bool{"active": true})
	}))
	defer mock.Close()
	client, err := newCentralHTTPClient(Config{JMSAuthURL: mock.URL})
	if err != nil {
		t.Fatal(err)
	}
	if response, err := client.Get(mock.URL); err == nil {
		response.Body.Close()
		t.Fatal("untrusted TLS certificate accepted")
	}
}

func TestCentralMultiLoginUsesServerPolicy(t *testing.T) {
	for _, multi := range []bool{false, true} {
		t.Run(fmt.Sprint(multi), func(t *testing.T) {
			s := newCompanionTestServer(t)
			state := configureCentralTestServer(t, s, false)
			if err := s.store.CreateRole(context.Background(), "licht", "Licht", "", "ptt", false); err != nil {
				t.Fatal(err)
			}
			state.status.MultiLogin = multi
			first := s.sessions.CreateCentral(User{ID: "first", Username: "Anna", RoleID: "licht"}, centralSessionStatus{SessionID: "other-session", Version: "version-1", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}, false)
			body, _ := json.Marshal(centralAdminLoginRequest{Ticket: signCentralTicket(t, testCentralSecret, state.claims("multi-ticket"))})
			rec := httptest.NewRecorder()
			s.handleCentralSessionLogin(rec, httptest.NewRequest(http.MethodPost, "/api/login/central", strings.NewReader(string(body))))
			expected := http.StatusConflict
			if multi {
				expected = http.StatusOK
			}
			if rec.Code != expected {
				t.Fatalf("got %d, want %d: %s", rec.Code, expected, rec.Body.String())
			}
			if _, ok := s.sessions.Get(first.Token); !ok {
				t.Fatal("existing person was logged out")
			}
			if multi {
				second := centralSessionFromResponse(t, s, rec)
				if second.Token == first.Token || second.Secondary {
					t.Fatal("independent login was not created")
				}
				s.sessions.Delete(second.Token)
				if _, ok := s.sessions.Get(first.Token); !ok {
					t.Fatal("logout affected another person")
				}
			}
		})
	}
}

func TestChatOnlyCannotEnterKesherOrKeepExistingSession(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, false)
	state.status.ChatOnly = true
	body, _ := json.Marshal(centralAdminLoginRequest{Ticket: signCentralTicket(t, testCentralSecret, state.claims("chat-only-ticket"))})
	rec := httptest.NewRecorder()
	s.handleCentralSessionLogin(rec, httptest.NewRequest(http.MethodPost, "/api/login/central", strings.NewReader(string(body))))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("chat-only ticket returned %d", rec.Code)
	}
	session := s.sessions.CreateCentral(User{Username: state.status.Name, RoleID: state.status.RoleID}, state.status, false)
	if matchesCentralSession(session, state.status) {
		t.Fatal("chat-only session retained Kesher access")
	}
}
