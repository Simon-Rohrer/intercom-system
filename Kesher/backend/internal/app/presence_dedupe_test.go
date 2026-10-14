package app

import (
	"testing"
	"time"
)

func newPresenceTestClient(token, userID, username, roleID string, secondary bool, connectedAt time.Time) *client {
	return &client{
		session:     Session{Token: token, UserID: userID, Username: username, RoleID: roleID, Secondary: secondary},
		user:        User{ID: userID, Username: username, RoleID: roleID},
		connectedAt: connectedAt,
		listenRooms: map[string]struct{}{},
		talkRooms:   map[string]struct{}{},
	}
}

func TestPresenceListOneEntryPerUserPreferringRealDevice(t *testing.T) {
	now := time.Now()
	phone := newPresenceTestClient("phone", "u1", "Lasse", "light", false, now.Add(-time.Minute))
	phone.talkRooms["foh"] = struct{}{}
	stale := newPresenceTestClient("stale", "u1", "Lasse", "light", false, now.Add(-time.Hour))
	stale.talkRooms["stage"] = struct{}{}
	// Multiview-Kachel: gleicher Nutzer, neuer, aber Zweitgerät
	tile := newPresenceTestClient("tile", "u1", "Lasse", "light", true, now)
	tile.talkRooms["livestream"] = struct{}{}
	// Kachel unter anderem Namen, gleiche Rolle wie das Handy: nicht zusätzlich listen
	tileOtherName := newPresenceTestClient("tile2", "u2", "Lasse Kleinfeld", "light", true, now)
	// Kachel einer Rolle ohne echtes Gerät: bleibt sichtbar
	onlyTile := newPresenceTestClient("tile3", "u3", "Ton", "audio", true, now)

	h := &Hub{clients: map[string]*client{
		"phone": phone, "stale": stale, "tile": tile, "tile2": tileOtherName, "tile3": onlyTile,
	}}
	list := h.presenceListLocked()
	if len(list) != 2 {
		t.Fatalf("expected 2 entries (Lasse, Ton), got %d: %+v", len(list), list)
	}
	for _, p := range list {
		if p.UserID == "u1" && (len(p.TalkRooms) != 1 || p.TalkRooms[0] != "foh") {
			t.Fatalf("entry for u1 must be the phone's own state, got %+v", p.TalkRooms)
		}
		if p.UserID == "u2" {
			t.Fatalf("secondary tile of a role with a real device must not be listed")
		}
	}
}
