import fp from 'fastify-plugin';

const CACHE_TTL_MS = parseInt(process.env.AUTH_CACHE_TTL_MS, 10) || 60000;
const CACHE_MAX_ENTRIES = parseInt(process.env.AUTH_CACHE_MAX_ENTRIES, 10) || 5000;

const authPlugin = async (fastify) => {
  const tokenCache = new Map();
  const enforceCacheLimit = () => {
    while (tokenCache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = tokenCache.keys().next().value;
      if (!oldestKey) break;
      tokenCache.delete(oldestKey);
    }
  };

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of tokenCache) {
      if (entry.cacheExpiresAt < now) tokenCache.delete(key);
    }
  }, 10 * 60 * 1000).unref();

  fastify.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.skipAuth) return;

    const captchaToken = request.headers['captcha-token'];
    const hwid = request.headers['hwid'];

    if (!captchaToken || !hwid) {
      return reply.code(401).send({ error: 'Missing Captcha-Token or HWID header' });
    }

    const cacheKey = `${captchaToken}:${hwid}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.cacheExpiresAt > Date.now()) {
      request.user = cached.user;
      request.license = cached.license;
      return;
    }

    const { data: tokenRow, error: tokenError } = await fastify.supabase
      .from('license_tokens')
      .select(`
        id,
        hwid,
        expires_at,
        licenses (
          id,
          user_id,
          active,
          product_name,
          license_key,
          hwid,
          expires_at
        )
      `)
      .eq('token', captchaToken)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (tokenError) {
      request.log.error(tokenError, 'license_tokens query failed');
      return reply.code(500).send({ error: 'Auth check failed' });
    }

    if (!tokenRow) {
      return reply.code(401).send({ error: 'Invalid or expired token' });
    }

    if (tokenRow.hwid !== hwid) {
      return reply.code(403).send({ error: 'HWID mismatch' });
    }

    const license = tokenRow.licenses;

    if (!license) {
      return reply.code(403).send({ error: 'License not found' });
    }

    if (!license.active) {
      return reply.code(403).send({ error: 'License is inactive' });
    }

    if (license.expires_at && new Date(license.expires_at) < new Date()) {
      return reply.code(403).send({ error: 'License has expired' });
    }

    const user = { id: license.user_id };

    const tokenExpiry = new Date(tokenRow.expires_at).getTime();
    const cacheExpiresAt = Math.min(Date.now() + CACHE_TTL_MS, tokenExpiry);
    tokenCache.set(cacheKey, { user, license, cacheExpiresAt });
    enforceCacheLimit();

    request.user = user;
    request.license = license;
  });
};

export default fp(authPlugin, {
  name: 'auth',
  dependencies: ['supabase'],
});
