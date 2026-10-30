package app

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAdminPasswordDelegatesToJMSWithoutLocalFallback(t *testing.T) {
	s := newCompanionTestServer(t)
	s.cfg.JMSAuthSecret = "server-test-secret"
	available := true
	central := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.jms-auth/api/verify-pin" {
			t.Errorf("wrong path %s", r.URL.Path)
		}
		var body struct {
			PIN       string `json:"pin"`
			SourceIP  string `json:"sourceIp"`
			IssuedAt  int64  `json:"issuedAt"`
			Signature string `json:"signature"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Fatal("invalid payload")
		}
		digest := sha256.Sum256([]byte(body.PIN))
		expected := s.centralSignature(fmt.Sprintf("kesher:verify-pin:%s:%d:%x", body.SourceIP, body.IssuedAt, digest))
		if body.Signature != expected || body.SourceIP != "192.0.2.9" {
			t.Error("signature/source mismatch")
		}
		if !available {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(map[string]bool{"valid": body.PIN == "New password ä!"})
	}))
	defer central.Close()
	s.cfg.JMSAuthURL = central.URL
	s.centralHTTPClient = central.Client()
	for _, tc := range []struct {
		pin    string
		valid  bool
		status int
	}{{"New password ä!", true, 200}, {defaultAdminPIN, false, 403}} {
		req := httptest.NewRequest("POST", "/", nil)
		req.RemoteAddr = "192.0.2.9:1234"
		rec := httptest.NewRecorder()
		if got := s.verifyAdminPIN(rec, req, tc.pin); got != tc.valid || rec.Code != tc.status {
			t.Fatalf("valid=%v status=%d", got, rec.Code)
		}
	}
	available = false
	req := httptest.NewRequest("POST", "/", nil)
	req.RemoteAddr = "192.0.2.9:1234"
	rec := httptest.NewRecorder()
	if s.verifyAdminPIN(rec, req, defaultAdminPIN) || rec.Code != 503 {
		t.Fatal("central outage allowed local fallback")
	}
}
