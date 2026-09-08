const PROXY_URL = 'https://sofiatraffic-proxy.onrender.com/virtual-board?stop_code=';

function formatSurfaceStopCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;
  return digits.padStart(4, '0');
}

function normalizeStopCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { code: '', metro: false };

  const metro = /^M/i.test(raw);
  if (metro) {
    const digits = raw.replace(/\D/g, '');
    return {
      code: digits || raw.replace(/^M/i, ''),
      metro: true
    };
  }

  return {
    code: formatSurfaceStopCode(raw),
    metro: false
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { code, metro } = normalizeStopCode(req.query?.stop_code);
  if (!code) {
    return res.status(400).json({ error: 'Missing stop_code.' });
  }

  const url = `${PROXY_URL}${encodeURIComponent(code)}${metro ? '&metro' : ''}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json'
      }
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(502).json({
        error: `Virtual board upstream returned ${upstream.status}.`,
        details: text.slice(0, 500)
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: 'Virtual board upstream returned invalid JSON.'
      });
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.routes)) {
      return res.status(502).json({
        error: 'Virtual board upstream returned an unexpected response.'
      });
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json(data);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Virtual board upstream request timed out.'
      : (error?.message || 'Unable to fetch virtual board data.');

    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
};
