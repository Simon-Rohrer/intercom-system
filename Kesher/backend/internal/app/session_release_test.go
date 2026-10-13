package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// A login whose window is closed before the websocket opens must not keep the
// role occupied until the session TTL.
func TestOperatorSessionWithoutConnectionIsReleased(t *testing.T) {
	s := newCompanionTestServer(t)
	user := User{ID: "u1", Username: "Licht", RoleID: "lighting"}

	session := s.createOperatorSession(user, false)

	s.sessions.mu.RLock()
	_, pending := s.sessions.scheduledRevoke[session.Token]
	s.sessions.mu.RUnlock()
	if !pending {
		t.Fatalf("expected a pending logout for a session without a connection")
	}
	if !s.sessions.CancelScheduledDisconnectLogout(session.Token) {
		t.Fatalf("connecting the websocket must be able to cancel the pending logout")
	}
}

// A late HTTP request from a closed window must not cancel the disconnect
// logout; previously this left a "ghost" session that blocked the role.
func TestHTTPRequestDoesNotCancelDisconnectLogout(t *testing.T) {
	s := newCompanionTestServer(t)
	session := s.sessions.Create(User{ID: "u1", Username: "Licht", RoleID: "lighting"})
	s.sessions.ScheduleDisconnectLogout(session.Token, 50*time.Millisecond)

	handler := s.withAuth(func(w http.ResponseWriter, _ *http.Request, _ Session) {
		w.WriteHeader(http.StatusNoContent)
	})
	req := httptest.NewRequest(http.MethodGet, "/api/status", nil)
	req.Header.Set("Authorization", "Bearer "+session.Token)
	rec := httptest.NewRecorder()
	handler(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("expected the request to be served, got %d", rec.Code)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, ok := s.sessions.LatestForRole("lighting"); !ok {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("role is still occupied after the disconnect logout delay")
}
