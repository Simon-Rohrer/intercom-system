package app

import (
	"log/slog"
	"os"
	"testing"
	"time"
)

// A Kesher tile in JMS Control (secondary session) must follow the device that really
// uses its role, even when that person has other sessions under the same account.
func TestMirrorFollowsRolePrimary(t *testing.T) {
	store, err := NewStore(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	hub := NewHub(store, slog.New(slog.NewTextHandler(os.Stdout, nil)))
	now := time.Now()
	phone := &client{session: Session{Token: "phone", RoleID: "licht-mv"}, user: User{ID: "simon", Username: "Simon", RoleID: "admin"},
		send: make(chan WSOutbound, 16), listenRooms: toRoomSet([]string{"licht"}), talkRooms: toRoomSet([]string{}), connectedAt: now}
	// Same person, other session with another role (e.g. Kesher admin tab): hides the phone in the presence list
	laptop := &client{session: Session{Token: "laptop", RoleID: "admin"}, user: User{ID: "simon", Username: "Simon", RoleID: "admin"},
		send: make(chan WSOutbound, 16), connectedAt: now.Add(time.Second)}
	mirror := &client{session: Session{Token: "mirror", RoleID: "licht-mv", Secondary: true}, user: User{ID: "mv", Username: "Multiview", RoleID: "licht-mv"},
		send: make(chan WSOutbound, 16), connectedAt: now}
	hub.mu.Lock()
	hub.clients = map[string]*client{"phone": phone, "laptop": laptop, "mirror": mirror}
	hub.mu.Unlock()

	latest := func() *PresenceState {
		var state *PresenceState
		found := false
		for {
			select {
			case msg := <-mirror.send:
				if msg.Type == "mirror_state" {
					state, _ = msg.Data.(*PresenceState)
					found = true
				}
			default:
				if !found {
					t.Fatal("mirror got no mirror_state")
				}
				return state
			}
		}
	}

	hub.mu.RLock()
	hub.syncMirrorsLocked("")
	hub.mu.RUnlock()
	if got := latest(); got == nil || got.RoleID != "licht-mv" || len(got.ListenRooms) != 1 || got.ListenRooms[0] != "licht" {
		t.Fatalf("unexpected first state: %+v", got)
	}

	// Phone switches channels: the mirror gets the new state
	hub.mu.Lock()
	phone.listenRooms = toRoomSet([]string{"ton", "licht"})
	hub.mu.Unlock()
	hub.mu.RLock()
	hub.syncMirrorsLocked("")
	hub.mu.RUnlock()
	if got := latest(); got == nil || len(got.ListenRooms) != 2 {
		t.Fatalf("mirror did not follow channel switch: %+v", got)
	}

	// No change: nothing new
	hub.mu.RLock()
	hub.syncMirrorsLocked("")
	hub.mu.RUnlock()
	if len(mirror.send) != 0 {
		t.Fatal("unchanged state sent again")
	}

	// Phone leaves: mirror is told there is no device
	hub.mu.Lock()
	delete(hub.clients, "phone")
	hub.mu.Unlock()
	hub.mu.RLock()
	hub.syncMirrorsLocked("")
	hub.mu.RUnlock()
	if got := latest(); got != nil {
		t.Fatalf("expected no device, got %+v", got)
	}
}
