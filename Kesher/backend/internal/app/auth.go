package app

import (
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

type SessionManager struct {
	mu              sync.RWMutex
	sessions        map[string]Session
	ttl             time.Duration
	scheduledRevoke map[string]*time.Timer
}

func NewSessionManager(ttl time.Duration) *SessionManager {
	return &SessionManager{
		sessions:        make(map[string]Session),
		ttl:             ttl,
		scheduledRevoke: make(map[string]*time.Timer),
	}
}

func (m *SessionManager) Create(user User) Session {
	return m.create(Session{UserID: user.ID, Username: user.Username, RoleID: user.RoleID})
}

// CreateSecondary creates a session for an additional device of the role
// (see Session.Secondary).
func (m *SessionManager) CreateSecondary(user User) Session {
	return m.create(Session{UserID: user.ID, Username: user.Username, RoleID: user.RoleID, Secondary: true})
}

func (m *SessionManager) CreateCentral(user User, parent centralSessionStatus, secondary bool) Session {
	return m.create(Session{UserID: user.ID, Username: user.Username, RoleID: user.RoleID, CentralAdmin: parent.Admin, CentralSessionID: parent.SessionID, CentralVersion: parent.Version, ExpiresAt: time.UnixMilli(parent.ExpiresAt), Secondary: secondary})
}

// CreateCentralMirror opens a secondary session of the mirrored role for a
// central login. It never carries the central admin right.
func (m *SessionManager) CreateCentralMirror(user User, parent centralSessionStatus) Session {
	return m.create(Session{UserID: user.ID, Username: user.Username, RoleID: user.RoleID, CentralMirror: true, CentralSessionID: parent.SessionID, CentralVersion: parent.Version, ExpiresAt: time.UnixMilli(parent.ExpiresAt), Secondary: true})
}

func (m *SessionManager) CreateDevice(user User, device centralMachineStatus, secondary bool) Session {
	expiresAt := time.Now().Add(m.ttl)
	if deviceExpiry := time.UnixMilli(device.ExpiresAt); deviceExpiry.Before(expiresAt) {
		expiresAt = deviceExpiry
	}
	return m.create(Session{UserID: user.ID, Username: user.Username, RoleID: user.RoleID, DeviceID: device.ID, DeviceVersion: device.Version, StationDeviceID: device.DeviceID, ExpiresAt: expiresAt, Secondary: secondary})
}

// create stores s under a new token with a fresh expiry.
func (m *SessionManager) create(s Session) Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	s.Token = uuid.NewString()
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(m.ttl)
	}
	m.sessions[s.Token] = s
	return s
}

func (m *SessionManager) Get(token string) (Session, bool) {
	m.mu.RLock()
	s, ok := m.sessions[token]
	m.mu.RUnlock()
	if !ok {
		return Session{}, false
	}
	if time.Now().After(s.ExpiresAt) {
		m.Delete(token)
		return Session{}, false
	}
	return s, true
}

func (m *SessionManager) Snapshot() []Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		result = append(result, session)
	}
	return result
}

func (m *SessionManager) Delete(token string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if timer, ok := m.scheduledRevoke[token]; ok {
		timer.Stop()
		delete(m.scheduledRevoke, token)
	}
	delete(m.sessions, token)
}

func (m *SessionManager) ScheduleDisconnectLogout(token string, delay time.Duration) bool {
	if delay <= 0 {
		m.Delete(token)
		return true
	}

	m.mu.Lock()
	if _, ok := m.sessions[token]; !ok {
		m.mu.Unlock()
		return false
	}
	if timer, ok := m.scheduledRevoke[token]; ok {
		timer.Stop()
	}
	m.scheduledRevoke[token] = time.AfterFunc(delay, func() {
		m.Delete(token)
	})
	m.mu.Unlock()
	return true
}

func (m *SessionManager) CancelScheduledDisconnectLogout(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	timer, ok := m.scheduledRevoke[token]
	if !ok {
		return false
	}
	timer.Stop()
	delete(m.scheduledRevoke, token)
	return true
}

func (m *SessionManager) LatestForRole(roleID string) (Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	var selected Session
	var found bool
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		if session.RoleID != roleID {
			continue
		}
		// A real device of the role always wins over secondary devices.
		better := !found ||
			(selected.Secondary && !session.Secondary) ||
			(selected.Secondary == session.Secondary && session.ExpiresAt.After(selected.ExpiresAt))
		if better {
			selected = session
			found = true
		}
	}
	if !found {
		return Session{}, false
	}
	return selected, true
}

func (m *SessionManager) ActiveRoleIDs() []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	now := time.Now()
	roleIDs := make(map[string]struct{})
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		roleID := strings.TrimSpace(session.RoleID)
		if roleID != "" && !session.Secondary {
			roleIDs[roleID] = struct{}{}
		}
	}

	result := make([]string, 0, len(roleIDs))
	for roleID := range roleIDs {
		result = append(result, roleID)
	}
	sort.Strings(result)
	return result
}

func (m *SessionManager) DeleteByRole(roleID string) []Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	deleted := make([]Session, 0)
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		if session.RoleID != roleID || session.Secondary {
			continue
		}
		deleted = append(deleted, session)
		delete(m.sessions, token)
	}
	return deleted
}

func (m *SessionManager) DeleteByUsername(username string) []Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	username = strings.TrimSpace(username)
	now := time.Now()
	deleted := make([]Session, 0)
	for token, session := range m.sessions {
		if now.After(session.ExpiresAt) {
			delete(m.sessions, token)
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(session.Username), username) {
			continue
		}
		deleted = append(deleted, session)
		delete(m.sessions, token)
	}
	return deleted
}
