package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"time"
)

type machineAssertion struct {
	Audience     string   `json:"aud"`
	ID           string   `json:"id"`
	Version      string   `json:"version"`
	RoleID       string   `json:"roleId"`
	DeviceID     string   `json:"deviceId"`
	Capabilities []string `json:"capabilities"`
	ExpiresAt    int64    `json:"exp"`
}

type centralMachineStatus struct {
	Active            bool     `json:"active"`
	ID                string   `json:"id"`
	Name              string   `json:"name"`
	Mode              string   `json:"mode"`
	Version           string   `json:"version"`
	Services          []string `json:"services"`
	Capabilities      []string `json:"capabilities"`
	RoleID            string   `json:"roleId"`
	RaspberryClientID string   `json:"raspberryClientId"`
	DeviceID          string   `json:"deviceId"`
	ExpiresAt         int64    `json:"expiresAt"`
	// MirrorRoles are the roles of the Kesher tiles a display station (e.g. the
	// server's HDMI kiosk) shows. It may open secondary sessions for them only.
	MirrorRoles []string `json:"mirrorRoles"`
}

// mayMirror reports whether the device may open a secondary session for roleID.
func (status centralMachineStatus) mayMirror(roleID string) bool {
	return roleID != "" && slices.Contains(status.MirrorRoles, roleID)
}

var errInvalidMachine = errors.New("invalid device identity")

func validMachineIdentifier(value string) bool {
	if len(value) == 0 || len(value) > 256 {
		return false
	}
	for _, character := range value {
		if (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') && character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func verifyMachineAssertion(secret, assertion string, now time.Time) (machineAssertion, error) {
	var claims machineAssertion
	payload, signature, ok := strings.Cut(assertion, ".")
	if secret == "" || !ok || payload == "" || signature == "" || len(assertion) > 8192 {
		return claims, errInvalidMachine
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	given, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(given, mac.Sum(nil)) {
		return claims, errInvalidMachine
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return claims, errInvalidMachine
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil || decoder.Decode(new(any)) != io.EOF {
		return claims, errInvalidMachine
	}
	if claims.Audience != "kesher-device" || !validMachineIdentifier(claims.ID) || !validMachineIdentifier(claims.Version) || claims.ExpiresAt <= now.UnixMilli() || claims.ExpiresAt > now.Add(30*time.Second).UnixMilli() || len(claims.RoleID) > 256 || len(claims.DeviceID) > 256 || len(claims.Capabilities) > 32 {
		return claims, errInvalidMachine
	}
	for _, capability := range claims.Capabilities {
		if !validMachineIdentifier(capability) {
			return claims, errInvalidMachine
		}
	}
	return claims, nil
}

func (s *Server) machineStatus(ctx context.Context, deviceID, version string) (centralMachineStatus, error) {
	var status centralMachineStatus
	if !validMachineIdentifier(deviceID) || !validMachineIdentifier(version) {
		return status, errInvalidMachine
	}
	issuedAt := time.Now().UnixMilli()
	payload := struct {
		DeviceID  string `json:"deviceId"`
		Version   string `json:"version"`
		IssuedAt  int64  `json:"issuedAt"`
		Signature string `json:"signature"`
	}{deviceID, version, issuedAt, s.centralSignature(fmt.Sprintf("kesher:machine:%s:%s:%d", deviceID, version, issuedAt))}
	if err := s.centralRequest(ctx, "machine-status", payload, &status); err != nil {
		return status, err
	}
	if !status.Active || status.ID != deviceID || status.Version != version || status.ExpiresAt <= time.Now().UnixMilli() || (!slices.Contains(status.Services, "kesher") && len(status.MirrorRoles) == 0) {
		return centralMachineStatus{}, errInvalidMachine
	}
	return status, nil
}

func (s *Server) machineForRequest(r *http.Request) (centralMachineStatus, error) {
	claims, err := verifyMachineAssertion(s.cfg.JMSAuthSecret, r.Header.Get("X-JMS-Device-Assertion"), time.Now())
	if err != nil {
		return centralMachineStatus{}, err
	}
	status, err := s.machineStatus(r.Context(), claims.ID, claims.Version)
	if err != nil || status.RoleID != claims.RoleID || status.DeviceID != claims.DeviceID || len(status.Capabilities) != len(claims.Capabilities) {
		return centralMachineStatus{}, errInvalidMachine
	}
	for _, capability := range claims.Capabilities {
		if !slices.Contains(status.Capabilities, capability) {
			return centralMachineStatus{}, errInvalidMachine
		}
	}
	return status, nil
}

func (s *Server) authorizeMachineLogin(w http.ResponseWriter, r *http.Request, roleID string, secondary bool) (centralMachineStatus, bool) {
	if s.cfg.JMSAuthURL == "" {
		return centralMachineStatus{}, true
	}
	status, err := s.machineForRequest(r)
	ownRole := slices.Contains(status.Services, "kesher") && status.RoleID == roleID
	if err != nil || roleID == "" || !(ownRole || (secondary && status.mayMirror(roleID))) {
		http.Error(w, "registered device role required", http.StatusForbidden)
		return centralMachineStatus{}, false
	}
	return status, true
}

func matchesMachineSession(session Session, status centralMachineStatus) bool {
	role := (slices.Contains(status.Services, "kesher") && session.RoleID == status.RoleID) || (session.Secondary && status.mayMirror(session.RoleID))
	return status.Active && session.DeviceID == status.ID && session.DeviceVersion == status.Version && session.StationDeviceID == status.DeviceID && role && status.ExpiresAt > time.Now().UnixMilli() && !session.CentralAdmin && session.CentralSessionID == ""
}

func (s *Server) validateMachineSession(ctx context.Context, session Session) bool {
	status, err := s.machineStatus(ctx, session.DeviceID, session.DeviceVersion)
	if err != nil || !matchesMachineSession(session, status) || !time.Now().Before(session.ExpiresAt) {
		s.revokeSession(session)
		return false
	}
	return true
}

func (s *Server) raspberryPiReadScope(r *http.Request) (centralMachineStatus, bool) {
	if _, allowed := s.serviceAuthorization(r, "pi-manage"); allowed {
		return centralMachineStatus{}, true
	}
	device, err := s.machineForRequest(r)
	if err != nil || device.DeviceID == "" || device.RoleID == "" || !slices.Contains(device.Capabilities, "heartbeat") || r.Header.Get("X-JMS-Gateway") == "central" {
		return centralMachineStatus{}, false
	}
	return device, true
}

func (s *Server) serviceAuthorization(r *http.Request, capability string) (func() bool, bool) {
	if s.cfg.JMSAuthURL == "" {
		return func() bool { return true }, true
	}
	if r.Header.Get("X-JMS-Device-Assertion") != "" {
		status, err := s.machineForRequest(r)
		if err != nil || !slices.Contains(status.Capabilities, capability) || !s.machineServiceTargetAllowed(r, status, capability) {
			return nil, false
		}
		return func() bool {
			current, err := s.machineStatus(r.Context(), status.ID, status.Version)
			return err == nil && slices.Contains(current.Capabilities, capability) && s.machineServiceTargetAllowed(r, current, capability)
		}, true
	}
	parentID := r.Header.Get("X-JMS-Session-Id")
	if parentID == "" {
		return nil, false
	}
	status, err := s.centralStatus(r.Context(), parentID)
	if err != nil || !s.humanServiceTargetAllowed(r, status, capability) {
		return nil, false
	}
	return func() bool {
		current, err := s.centralStatus(r.Context(), parentID)
		return err == nil && current.Version == status.Version && s.humanServiceTargetAllowed(r, current, capability)
	}, true
}

func (s *Server) machineServiceTargetAllowed(r *http.Request, status centralMachineStatus, capability string) bool {
	if capability != "image-stream" || status.RoleID == "" || slices.Contains(status.Capabilities, "companion") {
		return true
	}
	roleID, _ := s.resolveImageStreamTarget(r.Context(), r)
	return roleID == status.RoleID
}

func (s *Server) humanServiceTargetAllowed(r *http.Request, status centralSessionStatus, capability string) bool {
	if status.Admin {
		return true
	}
	if capability == "image-stream" && status.RoleID != "" {
		roleID, _ := s.resolveImageStreamTarget(r.Context(), r)
		return roleID == status.RoleID
	}
	return false
}

func (s *Server) requireServiceCapability(w http.ResponseWriter, r *http.Request, capability string) bool {
	_, allowed := s.serviceAuthorization(r, capability)
	if !allowed {
		http.Error(w, "device capability or central administrator required", http.StatusForbidden)
	}
	return allowed
}

func watchServiceConnection(validate func() bool, closeConnection func() error) func() {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !validate() {
					_ = closeConnection()
					return
				}
			}
		}
	}()
	return cancel
}
