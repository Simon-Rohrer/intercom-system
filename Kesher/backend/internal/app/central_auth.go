package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// The JMS server has one central login (in the Multiview): name + role, the
// admin with a PIN. Its admin is also Kesher's admin without typing the Kesher
// PIN: the Multiview hands out a short signed ticket, which Kesher checks with
// the shared JMS_AUTH_SECRET.

const centralTicketAudience = "kesher"

type centralTicketClaims struct {
	Name   string `json:"name"`
	RoleID string `json:"roleId"`
	Admin  bool   `json:"admin"`
	Aud    string `json:"aud"`
	Exp    int64  `json:"exp"` // Unix milliseconds
}

var errInvalidCentralTicket = errors.New("invalid ticket")

// verifyCentralTicket checks signature, audience and expiry of a ticket
// "<base64url payload>.<base64url HMAC-SHA256>".
func verifyCentralTicket(secret, ticket string, now time.Time) (centralTicketClaims, error) {
	var claims centralTicketClaims
	if secret == "" {
		return claims, errors.New("central login is not configured")
	}
	payload, signature, ok := strings.Cut(strings.TrimSpace(ticket), ".")
	if !ok || payload == "" || signature == "" {
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
	if claims.Aud != centralTicketAudience || now.UnixMilli() > claims.Exp {
		return claims, errInvalidCentralTicket
	}
	return claims, nil
}

type centralAdminLoginRequest struct {
	Ticket string `json:"ticket"`
}

// handleCentralAdminLogin opens an admin session for the admin of the central
// login. The session counts as admin without the X-Admin-Pin header.
func (s *Server) handleCentralAdminLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req centralAdminLoginRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	claims, err := verifyCentralTicket(s.cfg.JMSAuthSecret, req.Ticket, time.Now())
	if err != nil {
		if s.cfg.JMSAuthSecret == "" {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if !claims.Admin {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	session := s.sessions.CreateCentralAdmin(User{Username: "admin"})
	s.logger.Info("central admin login", "name", claims.Name)
	s.writeJSON(w, http.StatusOK, LoginResponse{Token: session.Token, User: User{Username: "admin"}})
}
