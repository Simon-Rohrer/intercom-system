package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDevicePresenceUsesRegisteredIdentityNotDisplayName(t *testing.T) {
	for _, stationID := range []string{"kamera-1-pi", "", "other-device"} {
		t.Run("station="+stationID, func(t *testing.T) {
			store, err := NewStore(":memory:")
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			ctx := context.Background()
			_, err = store.UpsertRaspberryPiHeartbeat(ctx, RaspberryPiHeartbeatRequest{DeviceID: "kamera-1-pi", Name: "Registered-Pi", RoleID: "camera", BrowserStatus: "running"})
			if err != nil {
				t.Fatal(err)
			}
			hub := NewHub(store, slog.New(slog.NewTextHandler(io.Discard, nil)))
			user := User{ID: "device-user", Username: "Browser-Name", RoleID: "camera"}
			manager := NewSessionManager(time.Minute)
			session := manager.CreateDevice(user, centralMachineStatus{ID: "registry-id", Version: "version", DeviceID: stationID, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}, false)
			hub.Add(&client{session: session, user: user, send: make(chan WSOutbound, 4)})
			server := &Server{store: store, hub: hub, cfg: Config{JMSAuthURL: "https://auth.invalid"}}
			response, err := server.buildRaspberryPiStationsResponse(ctx)
			if err != nil || len(response.Stations) != 1 {
				t.Fatalf("unexpected result: %#v %v", response, err)
			}
			if response.Stations[0].IntercomConnected != (stationID == "kamera-1-pi") {
				t.Fatalf("presence is not bound to registered device: %#v", response.Stations[0])
			}
		})
	}
}

func TestDeviceReadsOnlyOwnLauncherStatusWithoutControl(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	for _, station := range []RaspberryPiHeartbeatRequest{
		{DeviceID: "camera-one", Name: "Registered-Camera", RoleID: "audio", BrowserStatus: "running"},
		{DeviceID: "other-camera", Name: "Other-Camera", RoleID: "producer", BrowserStatus: "running"},
	} {
		if _, err := server.store.UpsertRaspberryPiHeartbeat(context.Background(), station); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(http.MethodGet, "/api/raspberry-pis/remote?deviceId=other-camera", nil)
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	request.Header.Set("X-JMS-Gateway", "machine")
	response := httptest.NewRecorder()
	server.handleRaspberryPiRemoteStations(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("own status rejected: %d", response.Code)
	}
	var result RaspberryPiRemoteStationsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Stations) != 1 || result.Stations[0].DeviceID != "camera-one" || result.Stations[0].RoleID != "audio" {
		t.Fatalf("station scope bypass: %#v", result.Stations)
	}
	command := httptest.NewRequest(http.MethodPost, "/api/raspberry-pis/remote-command", strings.NewReader(`{"deviceId":"camera-one","command":"set_mic"}`))
	command.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	response = httptest.NewRecorder()
	server.handleRaspberryPiRemoteCommand(response, command)
	if response.Code != http.StatusForbidden {
		t.Fatal("status reader gained remote control")
	}
	state.mu.Lock()
	state.status.Capabilities = []string{"pi-manage"}
	state.mu.Unlock()
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	response = httptest.NewRecorder()
	server.handleRaspberryPiRemoteStations(response, request)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Stations) != 2 {
		t.Fatal("management scope lost existing all-stations access")
	}
}

func TestDeviceLauncherStatusFailsClosed(t *testing.T) {
	for _, scenario := range []string{"anonymous", "revoked", "unavailable", "missing-capability", "missing-device", "missing-role", "human-gateway"} {
		t.Run(scenario, func(t *testing.T) {
			server := newCompanionTestServer(t)
			state := configureMachineTestServer(t, server)
			state.mu.Lock()
			switch scenario {
			case "revoked":
				state.status.Active = false
			case "unavailable":
				state.unavailable = true
			case "missing-capability":
				state.status.Capabilities = []string{"display"}
			case "missing-device":
				state.status.DeviceID = ""
			case "missing-role":
				state.status.RoleID = ""
			}
			state.mu.Unlock()
			request := httptest.NewRequest(http.MethodGet, "/api/raspberry-pis/remote", nil)
			if scenario != "anonymous" {
				request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
			}
			if scenario == "human-gateway" {
				request.Header.Set("X-JMS-Gateway", "central")
			}
			response := httptest.NewRecorder()
			server.handleRaspberryPiRemoteStations(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("%s returned %d", scenario, response.Code)
			}
		})
	}
}
