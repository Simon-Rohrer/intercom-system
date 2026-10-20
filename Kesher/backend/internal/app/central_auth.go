package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"unicode"
)

const centralTicketAudience = "kesher"

type centralTicketClaims struct {
	Name      string `json:"name"`
	RoleID    string `json:"roleId"`
	Admin     bool   `json:"admin"`
	Aud       string `json:"aud"`
	Exp       int64  `json:"exp"`
	SessionID string `json:"sid"`
	Version   string `json:"ver"`
	TicketID  string `json:"jti"`
}

type centralSessionStatus struct {
	Active    bool   `json:"active"`
	SessionID string `json:"sessionId"`
	Admin     bool   `json:"admin"`
	RoleID    string `json:"roleId"`
	Name      string `json:"name"`
	ExpiresAt int64  `json:"expiresAt"`
	Version   string `json:"version"`
}

var errInvalidCentralTicket = errors.New("invalid ticket")

func verifyCentralTicket(secret, ticket string, now time.Time) (centralTicketClaims, error) {
	var claims centralTicketClaims
	if secret == "" {
		return claims, errors.New("central login is not configured")
	}
	payload, signature, ok := strings.Cut(strings.TrimSpace(ticket), ".")
	if !ok || payload == "" || signature == "" || len(ticket) > 8192 {
		return claims, errInvalidCentralTicket
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	given, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(given, mac.Sum(nil)) {
		return claims, errInvalidCentralTicket
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(raw, &claims) != nil {
		return claims, errInvalidCentralTicket
	}
	if claims.Aud != centralTicketAudience || now.UnixMilli() >= claims.Exp || claims.Exp > now.Add(time.Minute).UnixMilli() || claims.SessionID == "" || claims.Version == "" || claims.TicketID == "" || len(claims.SessionID) > 256 || len(claims.Version) > 256 || len(claims.TicketID) > 256 {
		return claims, errInvalidCentralTicket
	}
	return claims, nil
}

func newCentralHTTPClient(cfg Config) (*http.Client, error) {
	origin, err := url.Parse(cfg.JMSAuthURL)
	if err != nil || origin.Scheme != "https" || origin.Host == "" || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || (origin.Path != "" && origin.Path != "/") {
		return nil, errors.New("JMS_AUTH_URL must be an HTTPS origin")
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if cfg.JMSAuthCAFile != "" {
		certificate, err := os.ReadFile(cfg.JMSAuthCAFile)
		if err != nil {
			return nil, fmt.Errorf("read JMS_AUTH_CA_FILE: %w", err)
		}
		if !roots.AppendCertsFromPEM(certificate) {
			return nil, errors.New("JMS_AUTH_CA_FILE contains no certificates")
		}
	}
	return &http.Client{
		Timeout:   750 * time.Millisecond,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}, MaxIdleConnsPerHost: 16, IdleConnTimeout: 30 * time.Second},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("central auth redirects are not allowed")
		},
	}, nil
}

func (s *Server) centralRequest(ctx context.Context, path string, payload any, target any) error {
	if s.cfg.JMSAuthSecret == "" || s.cfg.JMSAuthURL == "" || s.centralHTTPClient == nil {
		return errors.New("central login is not configured")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(s.cfg.JMSAuthURL, "/")+"/.jms-auth/api/"+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := s.centralHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("central login validation unavailable")
	}
	return json.NewDecoder(io.LimitReader(response.Body, 8192)).Decode(target)
}

func (s *Server) centralSignature(value string) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.JMSAuthSecret))
	mac.Write([]byte(value))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) centralStatus(ctx context.Context, sessionID string) (centralSessionStatus, error) {
	issuedAt := time.Now().UnixMilli()
	payload := struct {
		SessionID string `json:"sessionId"`
		IssuedAt  int64  `json:"issuedAt"`
		Signature string `json:"signature"`
	}{sessionID, issuedAt, s.centralSignature(fmt.Sprintf("kesher:introspect:%s:%d", sessionID, issuedAt))}
	var status centralSessionStatus
	if err := s.centralRequest(ctx, "session-status", payload, &status); err != nil {
		return status, err
	}
	if !status.Active || status.SessionID != sessionID || status.Version == "" || status.ExpiresAt <= time.Now().UnixMilli() {
		return centralSessionStatus{}, errInvalidCentralTicket
	}
	return status, nil
}

func (s *Server) revokeCentralAdmins(ctx context.Context) error {
	if s.cfg.JMSAuthURL == "" {
		return nil
	}
	issuedAt := time.Now().UnixMilli()
	payload := struct {
		IssuedAt  int64  `json:"issuedAt"`
		Signature string `json:"signature"`
	}{issuedAt, s.centralSignature(fmt.Sprintf("kesher:revoke-admin:%d", issuedAt))}
	var result struct {
		OK bool `json:"ok"`
	}
	if err := s.centralRequest(ctx, "revoke-admin", payload, &result); err != nil {
		return err
	}
	if !result.OK {
		return errors.New("central revocation failed")
	}
	return nil
}

func (s *Server) consumeCentralTicket(ctx context.Context, claims centralTicketClaims) bool {
	accepted, err := s.store.consumeCentralTicket(ctx, claims.TicketID, claims.Exp)
	return err == nil && accepted
}

func (s *Server) revokeSession(session Session) {
	s.sessions.Delete(session.Token)
	if s.hub != nil {
		s.hub.RemoveWithReason(session.Token, "central_session_revoked")
	}
}

func matchesCentralSession(session Session, status centralSessionStatus) bool {
	return status.Active && status.SessionID == session.CentralSessionID && status.Version == session.CentralVersion && status.Admin == session.CentralAdmin && status.ExpiresAt > time.Now().UnixMilli() && (session.CentralAdmin || (status.Name == session.Username && status.RoleID == session.RoleID))
}

func (s *Server) validateCentralSession(ctx context.Context, session Session) bool {
	if session.DeviceID != "" {
		return s.validateMachineSession(ctx, session)
	}
	if session.CentralSessionID == "" {
		return !session.CentralAdmin
	}
	status, err := s.centralStatus(ctx, session.CentralSessionID)
	if err != nil || !matchesCentralSession(session, status) || !time.Now().Before(session.ExpiresAt) {
		s.revokeSession(session)
		return false
	}
	return true
}

func (s *Server) sweepCentralSessions(ctx context.Context) {
	groups := make(map[string][]Session)
	deviceGroups := make(map[string][]Session)
	snapshot := make(map[string]Session)
	for _, session := range s.sessions.Snapshot() {
		snapshot[session.Token] = session
	}
	if s.hub != nil {
		for _, session := range s.hub.sessionSnapshot() {
			snapshot[session.Token] = session
		}
	}
	for _, session := range snapshot {
		if _, active := s.sessions.Get(session.Token); !active || !time.Now().Before(session.ExpiresAt) {
			s.revokeSession(session)
		} else if session.CentralSessionID != "" {
			groups[session.CentralSessionID] = append(groups[session.CentralSessionID], session)
		} else if session.DeviceID != "" {
			deviceKey := session.DeviceID + "\x00" + session.DeviceVersion
			deviceGroups[deviceKey] = append(deviceGroups[deviceKey], session)
		} else if s.cfg.JMSAuthURL != "" {
			s.revokeSession(session)
		}
	}
	var waiting sync.WaitGroup
	for _, sessions := range deviceGroups {
		waiting.Add(1)
		go func(sessions []Session) {
			defer waiting.Done()
			status, err := s.machineStatus(ctx, sessions[0].DeviceID, sessions[0].DeviceVersion)
			for _, session := range sessions {
				if err != nil || !matchesMachineSession(session, status) {
					s.revokeSession(session)
				}
			}
		}(sessions)
	}
	for sessionID, sessions := range groups {
		waiting.Add(1)
		go func(sessionID string, sessions []Session) {
			defer waiting.Done()
			status, err := s.centralStatus(ctx, sessionID)
			for _, session := range sessions {
				if err != nil || !matchesCentralSession(session, status) {
					s.revokeSession(session)
				}
			}
		}(sessionID, sessions)
	}
	waiting.Wait()
}

func (s *Server) startCentralSessionCleanup() {
	ctx, cancel := context.WithCancel(context.Background())
	s.centralCleanupCancel = cancel
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.sweepCentralSessions(ctx)
			}
		}
	}()
}

type centralAdminLoginRequest struct {
	Ticket    string `json:"ticket"`
	Secondary bool   `json:"secondary"`
}

func (s *Server) handleCentralAdminLogin(w http.ResponseWriter, r *http.Request) {
	s.handleCentralLogin(w, r, true)
}

func (s *Server) handleCentralSessionLogin(w http.ResponseWriter, r *http.Request) {
	s.handleCentralLogin(w, r, false)
}

func (s *Server) handleCentralLogin(w http.ResponseWriter, r *http.Request, adminOnly bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req centralAdminLoginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if s.cfg.JMSAuthSecret == "" || s.cfg.JMSAuthURL == "" || s.centralHTTPClient == nil {
		http.Error(w, "central login unavailable", http.StatusServiceUnavailable)
		return
	}
	claims, err := verifyCentralTicket(s.cfg.JMSAuthSecret, req.Ticket, time.Now())
	if err != nil || (adminOnly && !claims.Admin) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if r.Header.Get("X-JMS-Gateway") == "central" && r.Header.Get("X-JMS-Session-Id") != claims.SessionID {
		http.Error(w, "central session mismatch", http.StatusForbidden)
		return
	}
	status, err := s.centralStatus(r.Context(), claims.SessionID)
	if err != nil || status.Version != claims.Version || status.Admin != claims.Admin || status.Name != claims.Name || status.RoleID != claims.RoleID {
		http.Error(w, "central session invalid", http.StatusUnauthorized)
		return
	}
	if !s.consumeCentralTicket(r.Context(), claims) {
		http.Error(w, "ticket already consumed", http.StatusForbidden)
		return
	}
	s.sessionMu.Lock()
	defer s.sessionMu.Unlock()
	user := User{Username: "admin"}
	if !claims.Admin {
		if !isValidLoginRequest(claims.Name, claims.RoleID) || strings.IndexFunc(claims.Name, unicode.IsControl) >= 0 {
			http.Error(w, "invalid identity", http.StatusBadRequest)
			return
		}
		exists, err := s.store.RoleExists(r.Context(), claims.RoleID)
		if err != nil || !exists {
			http.Error(w, "invalid role", http.StatusBadRequest)
			return
		}
		if existing, conflict := s.sessions.LatestForRole(claims.RoleID); conflict && !req.Secondary && !existing.Secondary && existing.CentralSessionID != claims.SessionID {
			s.writeJSON(w, http.StatusConflict, LoginConflictResponse{RequiresTakeover: true, ConflictRoleID: claims.RoleID, ConflictRoleName: s.roleNameByID(r.Context(), claims.RoleID), ConflictUsername: existing.Username})
			return
		}
		user, err = s.store.upsertCentralUser(r.Context(), claims.Name, claims.RoleID)
		if err != nil {
			s.internalErr(w, err)
			return
		}
	}
	if len(s.sessions.Snapshot()) >= 1024 {
		http.Error(w, "session capacity reached", http.StatusTooManyRequests)
		return
	}
	session := s.sessions.CreateCentral(user, status, req.Secondary)
	if !claims.Admin {
		s.sessions.ScheduleDisconnectLogout(session.Token, operatorSessionConnectGrace)
	}
	disableResponseCaching(w)
	s.writeJSON(w, http.StatusOK, LoginResponse{Token: session.Token, User: user})
}
