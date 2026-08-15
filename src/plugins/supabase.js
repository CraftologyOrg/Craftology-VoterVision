import { createClient } from '@supabase/supabase-js';
import fp from 'fastify-plugin';
import { loggedFetch } from '../lib/monitor/network.js';

const supabasePlugin = async (fastify) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      fetch: async (url, options) => {
        const href = String(url);
        // High-frequency auth/entitlement lookups would drown the network log.
        if (/license_tokens|\bproducts\b|auth\/v1\/user/.test(href)) {
          return fetch(url, options);
        }
        return loggedFetch(url, options, { service: 'supabase' });
      },
    },
  });

  fastify.decorate('supabase', supabase);
};

export default fp(supabasePlugin, { name: 'supabase' });
