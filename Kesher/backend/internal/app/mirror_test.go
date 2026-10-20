package app

import (
	"testing"
	"time"
)

// Die Kesher-Kachel in JMS Control (Zweit-Sitzung) steuert das Gerät, das die Rolle wirklich nutzt.
func TestPrimaryTokenForRolePrefersNewestRealDevice(t *testing.T) {
	now := time.Now()
	h := &Hub{clients: map[string]*client{
		"tile":   newPresenceTestClient("tile", "u1", "Multiview", "licht-mv", true, now),
		"old":    newPresenceTestClient("old", "u2", "Lasse", "licht-mv", false, now.Add(-time.Hour)),
		"laptop": newPresenceTestClient("laptop", "u2", "Lasse", "licht-mv", false, now.Add(-time.Minute)),
		"other":  newPresenceTestClient("other", "u3", "Tim", "ton", false, now),
		"tile2":  newPresenceTestClient("tile2", "u4", "Multiview 2", "licht-mv", true, now.Add(time.Second)),
	}}
	token, username, ok := h.PrimaryTokenForRole("licht-mv", "tile")
	if !ok || token != "laptop" || username != "Lasse" {
		t.Fatalf("expected laptop of Lasse, got %q %q %v", token, username, ok)
	}
	if _, _, ok := h.PrimaryTokenForRole("regie", "tile"); ok {
		t.Fatalf("no device for an unused role")
	}
	// Ohne echtes Gerät (nur Kacheln) gibt es kein Ziel – die Kachel arbeitet dann wie bisher allein
	onlyTiles := &Hub{clients: map[string]*client{
		"tile": newPresenceTestClient("tile", "u1", "Multiview", "licht-mv", true, now),
	}}
	if _, _, ok := onlyTiles.PrimaryTokenForRole("licht-mv", "tile"); ok {
		t.Fatalf("a secondary session must never be a forwarding target")
	}
}
