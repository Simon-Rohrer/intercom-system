package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
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
	s.cfg.JMSAuthSecret = testCentralSecret
	ticket := signCentralTicket(t, testCentralSecret, centralTicketClaims{
		Name: "Simon", RoleID: "admin", Admin: true, Aud: "kesher", Exp: time.Now().Add(time.Minute).UnixMilli(),
	})

	rec := postCentralLogin(s, ticket)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res LoginResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatalf("decode: %v", err)
	}
	session, ok := s.sessions.Get(res.Token)
	if !ok || !session.CentralAdmin {
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
	s.cfg.JMSAuthSecret = testCentralSecret
	if rec := postCentralLogin(s, signCentralTicket(t, testCentralSecret, claims)); rec.Code != http.StatusForbidden {
		t.Fatalf("non-admin ticket: expected 403, got %d", rec.Code)
	}
	if rec := postCentralLogin(s, "forged.ticket"); rec.Code != http.StatusForbidden {
		t.Fatalf("forged ticket: expected 403, got %d", rec.Code)
	}
}
