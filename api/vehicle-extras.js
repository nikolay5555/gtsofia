const UPSTREAM_URL = 'https://sft-proxy.onrender.com/virtual-board?stop_code=';
const UPSTREAM_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10000;

let cache = new Map();

module.exports = async function vehicleExtrasHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'error', error: 'Method not allowed.' });
  }

  const rawStopCode = String(req.query?.stop_code ?? '').trim();
  if (!rawStopCode) {
    return res.status(400).json({ status: 'error', error: 'Missing stop_code.' });
  }

  const isMetro = /^M/i.test(rawStopCode) || req.query?.metro === '1' || req.query?.metro === '';
  const stopCode = isMetro ? rawStopCode.replace(/\D/g, '') : rawStopCode;
  if (!stopCode) {
    return res.status(400).json({ status: 'error', error: 'Invalid stop_code.' });
  }

  const cacheKey = `${stopCode}|${isMetro ? 'metro' : 'surface'}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      const data = await cached.promise;
      return res.status(200).json(data);
    } catch {
      cache.delete(cacheKey);
    }
  }

  const upstreamUrl = `${UPSTREAM_URL}${encodeURIComponent(stopCode)}${isMetro ? '&metro' : ''}`;
  const requestPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal
      });

      if (!upstream.ok) {
        throw new Error(`Vehicle extras upstream returned ${upstream.status}.`);
      }

      const data = await upstream.json();
      if (data?.status !== 'ok' || !Array.isArray(data?.routes)) {
        throw new Error('Vehicle extras upstream returned an unexpected response.');
      }

      return { status: 'ok', routes: data.routes };
    } finally {
      clearTimeout(timeout);
    }
  })();

  cache.set(cacheKey, {
    promise: requestPromise,
    expiresAt: Date.now() + CACHE_TTL_MS
  });

  try {
    const data = await requestPromise;
    return res.status(200).json(data);
  } catch (error) {
    cache.delete(cacheKey);
    console.error('Vehicle extras proxy error:', error);
    return res.status(502).json({
      status: 'error',
      error: 'Vehicle equipment data is temporarily unavailable.'
    });
  }
};
