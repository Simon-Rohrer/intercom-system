package app

import (
	"context"
	"time"
)

func (s *Store) consumeCentralTicket(ctx context.Context, ticketID string, expiresAt int64) (bool, error) {
	now := time.Now().UnixMilli()
	if ticketID == "" || expiresAt <= now {
		return false, nil
	}
	transaction, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer transaction.Rollback()
	if _, err = transaction.ExecContext(ctx, `DELETE FROM central_ticket_redemptions WHERE expires_at <= ?`, now); err != nil {
		return false, err
	}
	var count int
	if err = transaction.QueryRowContext(ctx, `SELECT COUNT(*) FROM central_ticket_redemptions`).Scan(&count); err != nil {
		return false, err
	}
	if count >= 4096 {
		return false, nil
	}
	result, err := transaction.ExecContext(ctx, `INSERT OR IGNORE INTO central_ticket_redemptions (ticket_id,expires_at) VALUES (?,?)`, ticketID, expiresAt)
	if err != nil {
		return false, err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if err = transaction.Commit(); err != nil {
		return false, err
	}
	return inserted == 1, nil
}
