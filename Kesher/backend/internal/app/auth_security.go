package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type verifiedPINSourceKey struct{}

func validAdminPINFormat(pin string) bool {
	if len(pin) < 4 || len(pin) > 12 {
		return false
	}
	for _, digit := range pin {
		if digit < '0' || digit > '9' {
			return false
		}
	}
	return true
}

func (s *Server) handleCentralPINVerification(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var request struct {
		PIN       string `json:"pin"`
		SourceIP  string `json:"sourceIp"`
		IssuedAt  int64  `json:"issuedAt"`
		Signature string `json:"signature"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}
	age := time.Now().UnixMilli() - request.IssuedAt
	digest := sha256.Sum256([]byte(request.PIN))
	message := fmt.Sprintf("kesher:verify-pin:%s:%d:%x", request.SourceIP, request.IssuedAt, digest)
	if s.cfg.JMSAuthSecret == "" || net.ParseIP(request.SourceIP) == nil || age < -30000 || age > 30000 || len(request.Signature) != 64 || !hmac.Equal([]byte(request.Signature), []byte(s.centralSignature(message))) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	verified := r.WithContext(context.WithValue(r.Context(), verifiedPINSourceKey{}, net.ParseIP(request.SourceIP).String()))
	if !s.verifyAdminPIN(w, verified, request.PIN) {
		return
	}
	disableResponseCaching(w)
	s.writeJSON(w, http.StatusOK, map[string]bool{"valid": true})
}

type adminPINAttempt struct {
	WindowStart time.Time
	Failures    int
	InFlight    int
}

func adminPINSource(r *http.Request) string {
	if source, ok := r.Context().Value(verifiedPINSourceKey{}).(string); ok {
		return source
	}
	address, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		address = r.RemoteAddr
	}
	if r.Header.Get("X-JMS-Gateway") != "" {
		forwarded := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-For"), ",")[0])
		if net.ParseIP(forwarded) != nil {
			address = forwarded
		}
	}
	return address
}

func (s *Server) beginAdminPINAttempt(w http.ResponseWriter, r *http.Request) (func(bool), bool) {
	s.adminPINMu.Lock()
	defer s.adminPINMu.Unlock()
	if s.adminPINAttempts == nil {
		s.adminPINAttempts = make(map[string]*adminPINAttempt)
	}
	now := time.Now()
	for source, attempt := range s.adminPINAttempts {
		if attempt.InFlight == 0 && now.Sub(attempt.WindowStart) >= 15*time.Minute {
			delete(s.adminPINAttempts, source)
		}
	}
	source := adminPINSource(r)
	attempt := s.adminPINAttempts[source]
	if attempt == nil && len(s.adminPINAttempts) < 4096 {
		attempt = &adminPINAttempt{WindowStart: now}
		s.adminPINAttempts[source] = attempt
	}
	if attempt == nil || attempt.Failures >= 8 || attempt.InFlight >= 4 || s.adminPINInFlight >= 16 {
		w.Header().Set("Retry-After", "900")
		http.Error(w, "too many authentication attempts", http.StatusTooManyRequests)
		return nil, false
	}
	attempt.InFlight++
	s.adminPINInFlight++
	return func(success bool) {
		s.adminPINMu.Lock()
		defer s.adminPINMu.Unlock()
		attempt.InFlight--
		s.adminPINInFlight--
		if success {
			attempt.Failures = 0
		} else {
			attempt.Failures++
		}
	}, true
}

func (s *Server) verifyAdminPIN(w http.ResponseWriter, r *http.Request, presented string) bool {
	finish, allowed := s.beginAdminPINAttempt(w, r)
	if !allowed {
		return false
	}
	success := false
	defer func() { finish(success) }()
	s.adminCredentialsMu.RLock()
	defer s.adminCredentialsMu.RUnlock()
	configured, err := s.store.GetAdminPIN(r.Context())
	if err != nil || strings.TrimSpace(configured) == "" {
		http.Error(w, "admin pin unavailable", http.StatusForbidden)
		return false
	}
	if subtle.ConstantTimeCompare([]byte(strings.TrimSpace(presented)), []byte(configured)) != 1 {
		http.Error(w, "forbidden", http.StatusForbidden)
		return false
	}
	success = true
	return true
}

func (s *Server) allowIndependentLogin(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.JMSAuthURL != "" {
		if _, err := verifyMachineAssertion(s.cfg.JMSAuthSecret, r.Header.Get("X-JMS-Device-Assertion"), time.Now()); err != nil || r.Header.Get("X-JMS-Gateway") == "central" {
			http.Error(w, "central login or registered device required", http.StatusForbidden)
			return false
		}
	}
	return true
}

func (s *Server) validateSessionRequest(r *http.Request, session Session) bool {
	if session.DeviceID != "" {
		if r.Header.Get("X-JMS-Gateway") == "central" {
			return false
		}
		if r.Header.Get("X-JMS-Device-Assertion") != "" {
			status, err := s.machineForRequest(r)
			if err != nil || !matchesMachineSession(session, status) {
				return false
			}
		}
		return s.validateMachineSession(r.Context(), session)
	}
	if s.cfg.JMSAuthURL != "" && session.CentralSessionID == "" {
		return false
	}
	if s.cfg.JMSAuthURL != "" && r.Header.Get("X-JMS-Gateway") == "central" && (session.CentralSessionID == "" || r.Header.Get("X-JMS-Session-Id") != session.CentralSessionID) {
		return false
	}
	return s.validateCentralSession(r.Context(), session)
}

func allowedWebSocketOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Site") == "" && r.Header.Get("X-JMS-Gateway") != "central"
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return false
	}
	if (parsed.Scheme == "https" || parsed.Scheme == "http") && strings.EqualFold(parsed.Host, r.Host) {
		return true
	}
	if r.Header.Get("X-JMS-Gateway") != "central" {
		switch origin {
		case "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost":
			return true
		}
	}
	switch origin {
	case "https://intercom.internal", "https://kesher.internal", "https://intercom.jms.de", "https://kesher.jms.de", "https://intercom.local", "https://kesher.local", "https://192.168.0.21:8443", "https://192.168.178.185":
		return true
	}
	return false
}
