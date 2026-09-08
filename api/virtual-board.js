const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const upstream = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/x-protobuf, application/octet-stream'
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Sofia Traffic GTFS-RT returned ${upstream.status}`
      });
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'application/x-protobuf');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).send(body);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Upstream GTFS-RT request timed out.'
      : (error?.message || 'Unable to fetch GTFS-RT.');

    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
};
