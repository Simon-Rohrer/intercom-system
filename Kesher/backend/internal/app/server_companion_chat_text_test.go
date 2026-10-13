package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func postChatText(s *Server, body, remoteAddr string, headers map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/companion/chat-text", strings.NewReader(body))
	req.RemoteAddr = remoteAddr
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.handleCompanionChatText(rec, req)
	return rec
}

func TestCompanionChatTextSendsAsOnlineStation(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	if err := s.store.CreateRole(ctx, "ct-light", "CT Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "ct-monitor", "CT Monitor", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole monitor failed: %v", err)
	}
	newChatTestClient(t, s, "Simon", "ct-light")
	monitor := newChatTestClient(t, s, "Chat-Monitor", "ct-monitor")

	rec := postChatText(s, `{"roleId":"ct-light","username":"Simon","message":"  Bühne heller bitte  "}`, "172.17.0.1:5000", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	event := nextChatEvent(t, monitor)
	if event.Scope != "global" || event.Body != "Bühne heller bitte" || event.Source != "multiview" {
		t.Fatalf("unexpected chat event: %+v", event)
	}
	if event.FromUser.Username != "Simon" || event.FromUser.RoleID != "ct-light" {
		t.Fatalf("expected the online station as sender, got %+v", event.FromUser)
	}
}

func TestCompanionChatTextRejectsProxiedAndRemoteRequests(t *testing.T) {
	s := newCompanionTestServer(t)
	if err := s.store.CreateRole(context.Background(), "ct-light", "CT Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	body := `{"roleId":"ct-light","message":"Hallo"}`
	if rec := postChatText(s, body, "127.0.0.1:5000", map[string]string{"X-Forwarded-For": "192.168.0.50"}); rec.Code != http.StatusForbidden {
		t.Fatalf("proxied request: expected 403, got %d", rec.Code)
	}
	if rec := postChatText(s, body, "8.8.8.8:5000", nil); rec.Code != http.StatusForbidden {
		t.Fatalf("public source: expected 403, got %d", rec.Code)
	}
}

func TestCompanionChatTextValidatesInput(t *testing.T) {
	s := newCompanionTestServer(t)
	if err := s.store.CreateRole(context.Background(), "ct-light", "CT Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	cases := map[string]struct {
		body string
		code int
	}{
		"empty message": {`{"roleId":"ct-light","message":"   "}`, http.StatusBadRequest},
		"unknown role":  {`{"roleId":"nope","message":"Hallo"}`, http.StatusNotFound},
		"too long":      {`{"roleId":"ct-light","message":"` + strings.Repeat("x", companionChatTextMaxRunes+1) + `"}`, http.StatusBadRequest},
		"bad json":      {`{`, http.StatusBadRequest},
	}
	for name, tc := range cases {
		if rec := postChatText(s, tc.body, "127.0.0.1:5000", nil); rec.Code != tc.code {
			t.Errorf("%s: expected %d, got %d", name, tc.code, rec.Code)
		}
	}
}

func TestCompanionChatTextAlertUsesAlertSource(t *testing.T) {
	s := newCompanionTestServer(t)
	ctx := context.Background()
	if err := s.store.CreateRole(ctx, "ct-light", "CT Licht", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole failed: %v", err)
	}
	if err := s.store.CreateRole(ctx, "ct-monitor", "CT Monitor", "", "ptt", false); err != nil {
		t.Fatalf("CreateRole monitor failed: %v", err)
	}
	monitor := newChatTestClient(t, s, "Chat-Monitor", "ct-monitor")

	rec := postChatText(s, `{"roleId":"ct-light","username":"Simon","message":"Beamer-Meldung wartet","alert":true}`, "127.0.0.1:5000", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	event := nextChatEvent(t, monitor)
	if event.Source != "multiview-alert" || event.Body != "Beamer-Meldung wartet" {
		t.Fatalf("unexpected chat event: %+v", event)
	}
}
