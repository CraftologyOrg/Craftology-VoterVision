import { createClient } from '@supabase/supabase-js';
import { SESSION_COOKIE } from '../lib/monitor/constants.js';
import {
  createStaffSession,
  deleteStaffSession,
  getStaffSession,
  touchStaffSession,
  updateStaffSession,
} from '../lib/monitor/sessions.js';

const COOKIE_MAX_AGE = 14 * 24 * 60 * 60;

function cookieOptions() {
  const secure = Boolean(process.env.RAILWAY_PUBLIC_DOMAIN)
    || Boolean(process.env.RAILWAY_ENVIRONMENT)
    || process.env.NODE_ENV === 'production';
  return {
    path: '/monitor',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    signed: true,
    maxAge: COOKIE_MAX_AGE,
  };
}

export function getMonitorCookieOptions() {
  return cookieOptions();
}

export function getSessionIdFromRequest(request) {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return null;
  if (typeof request.unsignCookie === 'function') {
    const unsigned = request.unsignCookie(raw);
    if (unsigned?.valid) return unsigned.value;
    return null;
  }
  return raw;
}

function authClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_ANON_KEY');
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function isAdminUser(supabase, userId) {
  const { data, error } = await supabase
    .from('user_roles')
    .select('role_name')
    .eq('user_id', userId)
    .maybeSingle();
  if (error || !data) return false;
  return data.role_name === 'admin';
}

function expiresAtFromSession(session) {
  if (session?.expires_at) return Number(session.expires_at) * 1000;
  if (session?.expires_in) return Date.now() + Number(session.expires_in) * 1000;
  return Date.now() + 60 * 60 * 1000;
}

export async function loginStaff(fastify, email, password) {
  const client = authClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: String(email || '').trim(),
    password: String(password || ''),
  });
  if (error || !data?.user || !data?.session) {
    const message = error?.message || 'Invalid email or password';
    const status = /confirm/i.test(message) ? 403 : 401;
    return { ok: false, status, error: message };
  }

  const admin = await isAdminUser(fastify.supabase, data.user.id);
  if (!admin) {
    return { ok: false, status: 403, error: 'Admin access required' };
  }

  const sessionId = createStaffSession({
    userId: data.user.id,
    email: data.user.email,
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: expiresAtFromSession(data.session),
  });

  return {
    ok: true,
    sessionId,
    user: { id: data.user.id, email: data.user.email },
  };
}

export async function resolveStaffSession(fastify, sessionId) {
  if (!sessionId) return null;
  const row = getStaffSession(sessionId);
  if (!row) return null;

  let accessToken = row.access_token;
  if (row.expires_at < Date.now() + 30_000) {
    if (!row.refresh_token) {
      deleteStaffSession(sessionId);
      return null;
    }
    const client = authClient();
    const { data, error } = await client.auth.refreshSession({ refresh_token: row.refresh_token });
    if (error || !data?.session) {
      deleteStaffSession(sessionId);
      return null;
    }
    accessToken = data.session.access_token;
    updateStaffSession(sessionId, {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: expiresAtFromSession(data.session),
    });
  } else {
    touchStaffSession(sessionId);
  }

  const { data: userData, error: userError } = await fastify.supabase.auth.getUser(accessToken);
  if (userError || !userData?.user) {
    deleteStaffSession(sessionId);
    return null;
  }

  const admin = await isAdminUser(fastify.supabase, userData.user.id);
  if (!admin) {
    deleteStaffSession(sessionId);
    return null;
  }

  return {
    id: userData.user.id,
    email: userData.user.email,
    sessionId,
  };
}

export async function staffAuthHook(request, reply) {
  const sessionId = getSessionIdFromRequest(request);
  const staff = await resolveStaffSession(request.server, sessionId);
  if (!staff) {
    return reply.code(401).send({ error: 'Staff login required' });
  }
  request.staff = staff;
}

export { SESSION_COOKIE };
