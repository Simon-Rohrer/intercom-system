package app

import (
	"testing"
	"time"
)

func TestSecondarySessionDoesNotOccupyRole(t *testing.T) {
	m := NewSessionManager(time.Hour)
	user := User{ID: "u1", Username: "Lasse", RoleID: "light"}

	tile := m.CreateSecondary(user)
	if _, conflict := m.LatestForRole("light"); !conflict {
		t.Fatal("expected the secondary session to be found as a fallback")
	}
	if ids := m.ActiveRoleIDs(); len(ids) != 0 {
		t.Fatalf("secondary session must not mark the role active, got %v", ids)
	}

	station := m.Create(user)
	latest, _ := m.LatestForRole("light")
	if latest.Token != station.Token {
		t.Fatalf("the real device must win over the secondary one, got %+v", latest)
	}

	deleted := m.DeleteByRole("light")
	if len(deleted) != 1 || deleted[0].Token != station.Token {
		t.Fatalf("takeover must only remove the real device, got %+v", deleted)
	}
	if _, ok := m.Get(tile.Token); !ok {
		t.Fatal("secondary session must survive a takeover")
	}
}
