import { createClient } from '@supabase/supabase-js';
import fp from 'fastify-plugin';

const supabasePlugin = async (fastify) => {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  fastify.decorate('supabase', supabase);
};

export default fp(supabasePlugin, { name: 'supabase' });
