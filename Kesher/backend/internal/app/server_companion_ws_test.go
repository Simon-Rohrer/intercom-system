package app

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func loginUserForTest(t *testing.T, baseHTTP, username, roleID string) LoginResponse {
	t.Helper()
	body, _ := json.Marshal(LoginRequest{Username: username, RoleID: roleID})
	resp, err := http.Post(baseHTTP+"/api/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("login %s: %v", username, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login %s: status %d", username, resp.StatusCode)
	}
	var out LoginResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode login %s: %v", username, err)
	}
	return out
}

func dialForTest(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", url, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// The Stream Deck incoming-call indicator only reacts to companion_state, so
// the bridge must push that state as soon as a call arrives — not only when
// some unrelated presence change happens to coincide with the call.
func TestCompanionWSPushesStateWhenIncomingCallStarts(t *testing.T) {
	previousBlinkDuration := companionIncomingCallBlinkDuration
	companionIncomingCallBlinkDuration = 4 * time.Second
	t.Cleanup(func() { companionIncomingCallBlinkDuration = previousBlinkDuration })

	cfg := defaultConfig()
	cfg.DBPath = t.TempDir() + "/companion-ws.db"
	cfg.AllowCORS = true
	cfg.TrustedLANHTTP = true
	cfg.StaticDir = ""
	srv, err := NewServer(cfg)
	if err != nil {
		t.Fatalf("new server: %v", err)
	}
	defer srv.store.Close()
	testHTTP := httptest.NewServer(srv.httpSrv.Handler)
	defer testHTTP.Close()
	baseWS := "ws" + strings.TrimPrefix(testHTTP.URL, "http")

	callee := loginUserForTest(t, testHTTP.URL, "callee", "audio")
	caller := loginUserForTest(t, testHTTP.URL, "caller", "producer")

	calleeConn := dialForTest(t, baseWS+"/ws?token="+callee.Token)
	callerConn := dialForTest(t, baseWS+"/ws?token="+caller.Token)
	for _, conn := range []*websocket.Conn{calleeConn, callerConn} {
		go func(c *websocket.Conn) {
			for {
				if _, _, err := c.ReadMessage(); err != nil {
					return
				}
			}
		}(conn)
	}

	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, ok := srv.hub.PresenceForUsername("callee"); ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("callee never registered with the hub")
		}
		time.Sleep(20 * time.Millisecond)
	}

	companionConn := dialForTest(t, baseWS+"/api/companion/ws?roleId=audio")
	messages := make(chan WSOutbound, 256)
	go func() {
		defer close(messages)
		for {
			var raw struct {
				Type string          `json:"type"`
				Data json.RawMessage `json:"data"`
			}
			if err := companionConn.ReadJSON(&raw); err != nil {
				return
			}
			messages <- WSOutbound{Type: raw.Type, Data: raw.Data}
		}
	}()

	// Let the connection settle so join/presence pushes are not mistaken for
	// the call-triggered push.
	settle := time.After(800 * time.Millisecond)
drain:
	for {
		select {
		case <-messages:
		case <-settle:
			break drain
		}
	}

	if err := callerConn.WriteJSON(WSInbound{
		Type: "signal",
		Data: RoutedEvent{Scope: "direct", TargetID: callee.User.ID, Signal: "call"},
	}); err != nil {
		t.Fatalf("send call: %v", err)
	}

	timeout := time.After(2 * time.Second)
	for {
		select {
		case msg, ok := <-messages:
			if !ok {
				t.Fatal("companion websocket closed before the call state arrived")
			}
			if msg.Type != "companion_state" {
				continue
			}
			var state CompanionBridgeState
			if err := json.Unmarshal(msg.Data.(json.RawMessage), &state); err != nil {
				t.Fatalf("decode companion state: %v", err)
			}
			if state.SignalActive && state.SignalMessage == "call" {
				if state.SignalFrom != "caller" {
					t.Fatalf("signalFrom = %q, want caller", state.SignalFrom)
				}
				// The hub's own signal ends after a couple of seconds; the
				// indicator latch must outlive it until acknowledged or timed out.
				time.Sleep(incomingSignalAttentionWindow + 500*time.Millisecond)
				if !srv.hasCompanionPendingIncomingCall("callee") {
					t.Fatal("incoming call latch ended together with the short hub signal")
				}
				waitForCompanionCallCleared(t, messages)
				return
			}
		case <-timeout:
			t.Fatal("companion bridge never pushed the incoming call state")
		}
	}
}

// After the blink window the bridge must push a state without the call so the
// Stream Deck indicator stops blinking.
func waitForCompanionCallCleared(t *testing.T, messages <-chan WSOutbound) {
	t.Helper()
	timeout := time.After(companionIncomingCallBlinkDuration + 2*time.Second)
	for {
		select {
		case msg, ok := <-messages:
			if !ok {
				t.Fatal("companion websocket closed before the call was cleared")
			}
			if msg.Type != "companion_state" {
				continue
			}
			var state CompanionBridgeState
			if err := json.Unmarshal(msg.Data.(json.RawMessage), &state); err != nil {
				t.Fatalf("decode companion state: %v", err)
			}
			if !state.SignalActive {
				return
			}
		case <-timeout:
			t.Fatal("companion bridge never cleared the incoming call state")
		}
	}
}
