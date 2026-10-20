package app

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type machineTestState struct {
	mu          sync.Mutex
	status      centralMachineStatus
	unavailable bool
}

func configureMachineTestServer(t *testing.T, server *Server) *machineTestState {
	t.Helper()
	state := &machineTestState{status: centralMachineStatus{Active: true, ID: "registered-device", Version: "version-1", Name: "CameraOne", DeviceID: "camera-one", RoleID: "audio", Mode: "mtls", Services: []string{"kesher"}, Capabilities: []string{"heartbeat", "image-stream"}, ExpiresAt: time.Now().Add(time.Hour).UnixMilli()}}
	mock := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload struct {
			DeviceID  string `json:"deviceId"`
			Version   string `json:"version"`
			IssuedAt  int64  `json:"issuedAt"`
			Signature string `json:"signature"`
		}
		if request.URL.Path != "/.jms-auth/api/machine-status" || request.Method != http.MethodPost || json.NewDecoder(request.Body).Decode(&payload) != nil {
			http.Error(writer, "invalid request", http.StatusBadRequest)
			return
		}
		mac := hmac.New(sha256.New, []byte(testCentralSecret))
		mac.Write([]byte(fmt.Sprintf("kesher:machine:%s:%s:%d", payload.DeviceID, payload.Version, payload.IssuedAt)))
		given, err := hex.DecodeString(payload.Signature)
		if err != nil || !hmac.Equal(given, mac.Sum(nil)) || time.Since(time.UnixMilli(payload.IssuedAt)).Abs() > 30*time.Second {
			http.Error(writer, "invalid signature", http.StatusForbidden)
			return
		}
		state.mu.Lock()
		defer state.mu.Unlock()
		if state.unavailable {
			http.Error(writer, "unavailable", http.StatusServiceUnavailable)
			return
		}
		_ = json.NewEncoder(writer).Encode(state.status)
	}))
	t.Cleanup(mock.Close)
	server.cfg.JMSAuthURL = mock.URL
	server.cfg.JMSAuthSecret = testCentralSecret
	server.centralHTTPClient = mock.Client()
	server.logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	return state
}

func signMachineClaims(t *testing.T, claims machineAssertion) string {
	t.Helper()
	raw, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(testCentralSecret))
	mac.Write([]byte(payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (state *machineTestState) assertion(t *testing.T) string {
	t.Helper()
	state.mu.Lock()
	defer state.mu.Unlock()
	return signMachineClaims(t, machineAssertion{Audience: "kesher-device", ID: state.status.ID, Version: state.status.Version, RoleID: state.status.RoleID, DeviceID: state.status.DeviceID, Capabilities: state.status.Capabilities, ExpiresAt: time.Now().Add(25 * time.Second).UnixMilli()})
}

func machineLogin(t *testing.T, server *Server, state *machineTestState, roleID string, takeover bool) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(fmt.Sprintf(`{"username":"CameraOne","roleId":%q}`, roleID)))
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	request.Header.Set("X-JMS-Gateway", "machine")
	response := httptest.NewRecorder()
	if takeover {
		server.handleLoginTakeover(response, request)
	} else {
		server.handleLogin(response, request)
	}
	return response
}

func TestMachineAssertionValidation(t *testing.T) {
	now := time.Now()
	valid := machineAssertion{Audience: "kesher-device", ID: "camera-1", Version: "version-1", RoleID: "audio", DeviceID: "camera-one", Capabilities: []string{"heartbeat"}, ExpiresAt: now.Add(25 * time.Second).UnixMilli()}
	if _, err := verifyMachineAssertion(testCentralSecret, signMachineClaims(t, valid), now); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*machineAssertion){
		"audience":            func(claims *machineAssertion) { claims.Audience = "kesher" },
		"expired":             func(claims *machineAssertion) { claims.ExpiresAt = now.UnixMilli() },
		"long-lived":          func(claims *machineAssertion) { claims.ExpiresAt = now.Add(time.Minute).UnixMilli() },
		"missing identity":    func(claims *machineAssertion) { claims.ID = "" },
		"signature separator": func(claims *machineAssertion) { claims.ID = "device:version" },
		"missing version":     func(claims *machineAssertion) { claims.Version = "" },
		"invalid capability":  func(claims *machineAssertion) { claims.Capabilities = []string{"admin\n"} },
	} {
		t.Run(name, func(t *testing.T) {
			claims := valid
			mutate(&claims)
			if _, err := verifyMachineAssertion(testCentralSecret, signMachineClaims(t, claims), now); err == nil {
				t.Fatal("invalid assertion accepted")
			}
		})
	}
	for _, assertion := range []string{"", "bad.payload", signMachineClaims(t, valid) + ".extra", strings.Repeat("a", 9000)} {
		if _, err := verifyMachineAssertion(testCentralSecret, assertion, now); err == nil {
			t.Fatal("malformed assertion accepted")
		}
	}
	if _, err := verifyMachineAssertion("wrong-secret", signMachineClaims(t, valid), now); err == nil {
		t.Fatal("wrong signing key accepted")
	}
}

func TestMachineLoginRequiresRegistryAndBoundRole(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	for _, takeover := range []bool{false, true} {
		response := machineLogin(t, server, state, "producer", takeover)
		if response.Code != http.StatusForbidden {
			t.Fatalf("role escalation returned %d", response.Code)
		}
	}
	session := centralSessionFromResponse(t, server, machineLogin(t, server, state, "audio", false))
	if session.DeviceID != "registered-device" || session.DeviceVersion != "version-1" || session.CentralAdmin || session.CentralSessionID != "" {
		t.Fatal("device binding missing")
	}
	request := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
	request.RemoteAddr = "198.51.100.99:4000"
	if !server.validateSessionRequest(request, session) {
		t.Fatal("valid device session should not depend on source IP")
	}
	state.mu.Lock()
	state.status.ID = "different-device"
	state.mu.Unlock()
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	if server.validateSessionRequest(request, session) {
		t.Fatal("token accepted with another device identity")
	}
	state.mu.Lock()
	state.status.ID = "registered-device"
	state.mu.Unlock()
	request.Header.Del("X-JMS-Device-Assertion")
	request.Header.Set("X-Admin-Pin", defaultAdminPIN)
	if server.requireAdmin(httptest.NewRecorder(), request, session) {
		t.Fatal("machine session gained administrator rights")
	}
	request = httptest.NewRequest(http.MethodPost, "/api/admin/login", strings.NewReader(`{"pin":"123456"}`))
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	response := httptest.NewRecorder()
	server.handleAdminLogin(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatal("machine created independent admin")
	}
}

func TestMachineSpoofedGatewayHeadersCannotLogin(t *testing.T) {
	server := newCompanionTestServer(t)
	configureMachineTestServer(t, server)
	for _, address := range []string{"127.0.0.1:3000", "192.168.0.21:4000", "192.168.0.161:5000"} {
		request := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"CameraOne","roleId":"audio"}`))
		request.RemoteAddr = address
		request.Header.Set("X-JMS-Gateway", "machine")
		request.Header.Set("X-JMS-Device-Id", "registered-device")
		response := httptest.NewRecorder()
		server.handleLogin(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("address/header impersonation returned %d", response.Code)
		}
	}
}

func TestMachineRevocationClosesRealtimeAndRejectsDirectBackend(t *testing.T) {
	for _, reason := range []string{"revoked", "version", "role", "expiry", "service", "unavailable"} {
		t.Run(reason, func(t *testing.T) {
			server := newCompanionTestServer(t)
			state := configureMachineTestServer(t, server)
			session := centralSessionFromResponse(t, server, machineLogin(t, server, state, "audio", false))
			closed := make(chan struct{})
			server.hub.Add(&client{session: session, user: User{ID: session.UserID, Username: session.Username, RoleID: session.RoleID}, send: make(chan WSOutbound, 8), closeNow: func() error { close(closed); return nil }})
			state.mu.Lock()
			switch reason {
			case "revoked":
				state.status.Active = false
			case "version":
				state.status.Version = "rotated"
			case "role":
				state.status.RoleID = "producer"
			case "expiry":
				state.status.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
			case "service":
				state.status.Services = []string{"multiview"}
			case "unavailable":
				state.unavailable = true
			}
			state.mu.Unlock()
			server.sweepCentralSessions(context.Background())
			select {
			case <-closed:
			default:
				t.Fatal("revoked device websocket remains connected")
			}
			request := httptest.NewRequest(http.MethodGet, "/api/bootstrap", nil)
			request.Header.Set("Authorization", "Bearer "+session.Token)
			response := httptest.NewRecorder()
			server.withAuth(server.handleBootstrap)(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatal("revoked session accepted directly by backend")
			}
		})
	}
}

func TestMachineCapabilitiesAndHeartbeatIdentity(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	for _, endpoint := range []string{"companion", "pi-manage", "chat-monitor"} {
		request := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
		request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
		if server.requireServiceCapability(httptest.NewRecorder(), request, endpoint) {
			t.Fatalf("missing capability %s granted", endpoint)
		}
	}
	for _, roleID := range []string{"audio", "producer"} {
		request := httptest.NewRequest(http.MethodGet, "/api/image-stream?roleId="+roleID, nil)
		request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
		if allowed := server.requireServiceCapability(httptest.NewRecorder(), request, "image-stream"); allowed != (roleID == "audio") {
			t.Fatal("image stream target bypass")
		}
	}
	for _, body := range []string{`{"deviceId":"other-device","name":"CameraOne","roleId":"audio"}`, `{"deviceId":"camera-one","name":"CameraOne","roleId":"producer"}`} {
		request := httptest.NewRequest(http.MethodPost, "/api/raspberry-pi/heartbeat", strings.NewReader(body))
		request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
		response := httptest.NewRecorder()
		server.handleRaspberryPiHeartbeat(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("heartbeat impersonation returned %d", response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/api/raspberry-pi/heartbeat", strings.NewReader(`{"deviceId":"camera-one","name":"UntrustedName","roleId":"audio"}`))
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	response := httptest.NewRecorder()
	server.handleRaspberryPiHeartbeat(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("valid heartbeat returned %d: %s", response.Code, response.Body.String())
	}
}

func TestMachineAssertionCannotOverrideRegistry(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	assertion := state.assertion(t)
	state.mu.Lock()
	state.status.Capabilities = []string{"pi-manage"}
	state.mu.Unlock()
	request := httptest.NewRequest(http.MethodPost, "/api/login", nil)
	request.Header.Set("X-JMS-Device-Assertion", assertion)
	if _, err := server.machineForRequest(request); err == nil {
		t.Fatal("stale device capabilities accepted")
	}
}

func TestMachineCompanionIgnoresLegacySecretInCentralMode(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	server.cfg.CompanionSharedSecret = "legacy-test-secret"
	state.mu.Lock()
	state.status.RoleID = ""
	state.status.DeviceID = ""
	state.status.Capabilities = []string{"companion", "image-stream"}
	state.mu.Unlock()
	request := httptest.NewRequest(http.MethodGet, "/api/companion/profiles?secret=legacy-test-secret", nil)
	request.Header.Set("X-Companion-Secret", "legacy-test-secret")
	if server.requireCompanionSecret(httptest.NewRecorder(), request) {
		t.Fatal("legacy secret bypassed device authentication")
	}
	request = httptest.NewRequest(http.MethodGet, "/api/companion/profiles", nil)
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	if !server.requireCompanionSecret(httptest.NewRecorder(), request) {
		t.Fatal("scoped Companion device required unnecessary legacy secret")
	}
	if _, allowed := server.authorizeMachineLogin(httptest.NewRecorder(), request, "audio", false); allowed {
		t.Fatal("Companion service created operator identity")
	}
}

func TestMachineStatusDeniesIdentityServiceAndRegistryMismatch(t *testing.T) {
	for name, mutate := range map[string]func(*centralMachineStatus){
		"wrong identity":          func(status *centralMachineStatus) { status.ID = "other-device" },
		"rotated version":         func(status *centralMachineStatus) { status.Version = "rotated" },
		"changed role":            func(status *centralMachineStatus) { status.RoleID = "producer" },
		"changed physical device": func(status *centralMachineStatus) { status.DeviceID = "another-camera" },
		"missing kesher service":  func(status *centralMachineStatus) { status.Services = []string{"multiview"} },
		"revoked":                 func(status *centralMachineStatus) { status.Active = false },
		"missing expiry":          func(status *centralMachineStatus) { status.ExpiresAt = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			server := newCompanionTestServer(t)
			state := configureMachineTestServer(t, server)
			assertion := state.assertion(t)
			state.mu.Lock()
			mutate(&state.status)
			state.mu.Unlock()
			request := httptest.NewRequest(http.MethodGet, "/api/protected", nil)
			request.Header.Set("X-JMS-Device-Assertion", assertion)
			if _, err := server.machineForRequest(request); err == nil {
				t.Fatal("registry mismatch accepted")
			}
		})
	}
}

func TestMachineServiceConnectionRevoked(t *testing.T) {
	server := newCompanionTestServer(t)
	state := configureMachineTestServer(t, server)
	request := httptest.NewRequest(http.MethodGet, "/api/image-stream?roleId=audio", nil)
	request.Header.Set("X-JMS-Device-Assertion", state.assertion(t))
	validate, allowed := server.serviceAuthorization(request, "image-stream")
	if !allowed {
		t.Fatal("valid service connection denied")
	}
	closed := make(chan struct{})
	stop := watchServiceConnection(validate, func() error { close(closed); return nil })
	defer stop()
	state.mu.Lock()
	state.status.Active = false
	state.mu.Unlock()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("revoked image stream remains connected")
	}
}

func TestUDPAudioDisabledByDefaultAndExplicitConfiguration(t *testing.T) {
	if defaultConfig().UDPAudioAddr != "" {
		t.Fatal("unauthenticated UDP relay enabled by default")
	}
	t.Setenv("UDP_AUDIO_ADDR", "")
	if loadConfigFromEnv().UDPAudioAddr != "" {
		t.Fatal("empty environment re-enabled relay")
	}
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(configPath, []byte("udp_audio_addr: \"\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := loadConfigFromFile(configPath)
	if err != nil || config.UDPAudioAddr != "" {
		t.Fatalf("empty YAML re-enabled relay: %v", err)
	}
}

func TestNativeTransportFallsBackToWebRTCWithoutUDPRelay(t *testing.T) {
	config := defaultConfig()
	config.DBPath = filepath.Join(t.TempDir(), "native-fallback.db")
	server, err := NewServer(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.store.Close() })
	if server.udpAudio != nil {
		t.Fatal("UDP listener active")
	}
	web := httptest.NewServer(server.httpSrv.Handler)
	t.Cleanup(web.Close)
	login := loginUserForTest(t, web.URL, "NativeStation", "audio")
	connection, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(web.URL, "http")+"/ws?token="+login.Token+"&transport=native", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	if err := connection.WriteJSON(WSInbound{Type: "webrtc_ready", Data: json.RawMessage(`{}`)}); err != nil {
		t.Fatal(err)
	}
	connection.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		var message struct {
			Type string `json:"type"`
		}
		if err := connection.ReadJSON(&message); err != nil {
			t.Fatalf("missing WebRTC offer: %v", err)
		}
		if message.Type == "native_audio_endpoint" {
			t.Fatal("server announced unsafe native transport")
		}
		if message.Type == "webrtc_offer" {
			return
		}
	}
}
