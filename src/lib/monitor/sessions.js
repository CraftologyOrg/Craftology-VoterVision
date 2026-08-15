import { randomUUID } from 'node:crypto';
import { getDb } from './db.js';

export function createStaffSession({ userId, email, accessToken, refreshToken, expiresAt }) {
  const id = randomUUID();
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO staff_sessions (id, user_id, email, access_token, refresh_token, expires_at, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, userId, email || null, accessToken, refreshToken || null, expiresAt, now, now);
  return id;
}

export function getStaffSession(id) {
  if (!id) return null;
  return getDb().prepare('SELECT * FROM staff_sessions WHERE id = ?').get(id) || null;
}

export function updateStaffSession(id, { accessToken, refreshToken, expiresAt }) {
  getDb().prepare(`
    UPDATE staff_sessions
    SET access_token = ?, refresh_token = COALESCE(?, refresh_token), expires_at = ?, last_seen_at = ?
    WHERE id = ?
  `).run(accessToken, refreshToken || null, expiresAt, Date.now(), id);
}

export function touchStaffSession(id) {
  getDb().prepare('UPDATE staff_sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), id);
}

export function deleteStaffSession(id) {
  if (!id) return;
  getDb().prepare('DELETE FROM staff_sessions WHERE id = ?').run(id);
}
