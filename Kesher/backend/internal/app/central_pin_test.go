package app

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func signedPINRequest(server *Server, pin, source string) *http.Request {
	issuedAt := time.Now().UnixMilli()
	digest := sha256.Sum256([]byte(pin))
	signature := server.centralSignature(fmt.Sprintf("kesher:verify-pin:%s:%d:%x", source, issuedAt, digest))
	body, _ := json.Marshal(map[string]any{"pin": pin, "sourceIp": source, "issuedAt": issuedAt, "signature": signature})
	request := httptest.NewRequest(http.MethodPost, "/api/admin/pin/verify-central", strings.NewReader(string(body)))
	request.RemoteAddr = "127.0.0.1:8000"
	return request
}

func TestCentralPINLimitsOriginalClientsSeparately(t *testing.T) {
	server := newCompanionTestServer(t)
	server.cfg.JMSAuthSecret = "isolated-test-secret"
	for attempt := 0; attempt < 8; attempt++ {
		response := httptest.NewRecorder()
		server.handleCentralPINVerification(response, signedPINRequest(server, "000000", "192.0.2.1"))
		if response.Code != http.StatusForbidden {
			t.Fatalf("bad PIN status %d", response.Code)
		}
	}
	blocked := httptest.NewRecorder()
	server.handleCentralPINVerification(blocked, signedPINRequest(server, defaultAdminPIN, "192.0.2.1"))
	if blocked.Code != http.StatusTooManyRequests {
		t.Fatalf("blocked client status %d", blocked.Code)
	}
	other := httptest.NewRecorder()
	server.handleCentralPINVerification(other, signedPINRequest(server, defaultAdminPIN, "192.0.2.2"))
	if other.Code != http.StatusOK {
		t.Fatalf("unrelated client blocked: %d", other.Code)
	}
	if len(server.sessions.Snapshot()) != 0 {
		t.Fatal("PIN verification created an independent admin session")
	}
}

func TestCentralPINRejectsUnauthenticatedSourceAttribution(t *testing.T) {
	server := newCompanionTestServer(t)
	server.cfg.JMSAuthSecret = "isolated-test-secret"
	for _, body := range []string{
		`{"pin":"123456","sourceIp":"192.0.2.1","issuedAt":1,"signature":"bad"}`,
		`{"pin":"123456","sourceIp":"192.0.2.2"}`,
	} {
		request := httptest.NewRequest(http.MethodPost, "/api/admin/pin/verify-central", strings.NewReader(body))
		request.Header.Set("X-Forwarded-For", "192.0.2.99")
		response := httptest.NewRecorder()
		server.handleCentralPINVerification(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("unsigned source accepted: %d", response.Code)
		}
	}
	if len(server.adminPINAttempts) != 0 {
		t.Fatal("unauthenticated request consumed another client's PIN attempts")
	}
}

func TestAdminPINUpdatesUseCentralCompatibleFormat(t *testing.T) {
	server := newCompanionTestServer(t)
	session := server.sessions.Create(User{Username: "admin"})
	for _, pin := range []string{"abc123", "123", "1234567890123", "1234 5", "１２３４"} {
		body, _ := json.Marshal(map[string]string{"newPin": pin})
		request := httptest.NewRequest(http.MethodPut, "/api/admin/pin", strings.NewReader(string(body)))
		request.Header.Set("X-Admin-Pin", defaultAdminPIN)
		response := httptest.NewRecorder()
		server.handleAdminPin(response, request, session)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("incompatible PIN status %d", response.Code)
		}
	}
	stored, err := server.store.GetAdminPIN(context.Background())
	if err != nil || stored != defaultAdminPIN {
		t.Fatal("invalid PIN update changed credentials")
	}
}
