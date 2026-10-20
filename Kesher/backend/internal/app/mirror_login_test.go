package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The Kesher tile in JMS Control mirrors the role set in the tile – also when the person
// watching is the central admin – and never occupies it or carries the admin right.
func TestCentralMirrorLoginOpensSecondaryForTileRole(t *testing.T) {
	s := newCompanionTestServer(t)
	state := configureCentralTestServer(t, s, true)
	if exists, _ := s.store.RoleExists(context.Background(), "lighting"); !exists {
		if err := s.store.CreateRole(context.Background(), "lighting", "Licht Multiview", "", "ptt", false); err != nil {
			t.Fatal(err)
		}
	}
	login := func(ticketID string, secondary bool) *httptest.ResponseRecorder {
		claims := state.claims(ticketID)
		claims.Mirror = "lighting"
		body, _ := json.Marshal(centralAdminLoginRequest{Ticket: signCentralTicket(t, testCentralSecret, claims), Secondary: secondary, Username: "Multiview"})
		req := httptest.NewRequest(http.MethodPost, "/api/login/central", strings.NewReader(string(body)))
		req.Header.Set("X-JMS-Gateway", "central")
		req.Header.Set("X-JMS-Session-Id", "parent-session")
		rec := httptest.NewRecorder()
		s.handleCentralSessionLogin(rec, req)
		return rec
	}
	if rec := login("mirror-without-secondary", false); rec.Code != http.StatusForbidden {
		t.Fatalf("mirror ticket without secondary returned %d", rec.Code)
	}
	session := centralSessionFromResponse(t, s, login("mirror-ticket", true))
	if session.RoleID != "lighting" || !session.Secondary || !session.CentralMirror || session.CentralAdmin || session.Username != "Multiview" {
		t.Fatalf("unexpected mirror session %+v", session)
	}
	if roles := s.sessions.ActiveRoleIDs(); len(roles) != 0 {
		t.Fatalf("mirror occupied roles %v", roles)
	}
	req := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	req.Header.Set("X-JMS-Gateway", "central")
	req.Header.Set("X-JMS-Session-Id", "parent-session")
	if !s.validateSessionRequest(req, session) {
		t.Fatal("mirror of a valid central login rejected")
	}
	if s.requireAdmin(httptest.NewRecorder(), req, session) {
		t.Fatal("mirror inherited the central admin right")
	}
}

// The server's HDMI kiosk may mirror the roles of its Kesher tiles, but not use them as a
// real device and not use its own role without the Kesher service.
func TestDisplayStationMayOnlyMirrorTileRoles(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	state.mu.Lock()
	state.status.Services = []string{"multiview"}
	state.status.MirrorRoles = []string{"lighting"}
	state.mu.Unlock()
	request := httptest.NewRequest(http.MethodPost, "/api/login", nil)
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	if _, allowed := server.authorizeMachineLogin(httptest.NewRecorder(), request, "lighting", true); !allowed {
		t.Fatal("display station could not mirror its tile role")
	}
	if _, allowed := server.authorizeMachineLogin(httptest.NewRecorder(), request, "lighting", false); allowed {
		t.Fatal("display station occupied a mirrored role")
	}
	if _, allowed := server.authorizeMachineLogin(httptest.NewRecorder(), request, "audio", false); allowed {
		t.Fatal("station without Kesher service used its own role")
	}
	if _, allowed := server.authorizeMachineLogin(httptest.NewRecorder(), request, "producer", true); allowed {
		t.Fatal("display station mirrored a role without tile")
	}
	status, _ := server.machineForRequest(request)
	if !matchesMachineSession(Session{DeviceID: status.ID, DeviceVersion: status.Version, StationDeviceID: status.DeviceID, RoleID: "lighting", Secondary: true}, status) {
		t.Fatal("mirror session of the station not valid")
	}
	if matchesMachineSession(Session{DeviceID: status.ID, DeviceVersion: status.Version, StationDeviceID: status.DeviceID, RoleID: "lighting"}, status) {
		t.Fatal("real session for a mirrored role accepted")
	}
}
