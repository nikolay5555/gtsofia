(function initGtsofiaVirtualBoardArrivals(global) {
  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalized(value) {
    return String(value ?? '').trim().toLocaleLowerCase('bg-BG').replace(/\s+/g, ' ');
  }

  function groupKey(candidate) {
    return [
      String(candidate?.route_id || '').trim(),
      normalized(candidate?.destination || ''),
      String(candidate?.route_ref || '').trim()
    ].join('|');
  }

  function pickStaticMatch(realtime, staticCandidates, matched) {
    const sourceTripId = String(realtime?.source_trip_id || realtime?.trip_id || '').trim();
    if (sourceTripId) {
      const exact = staticCandidates.find((candidate, index) => {
        if (matched.has(index)) return false;
        if (String(candidate?.source_trip_id || '').trim() !== sourceTripId) return false;
        if (String(candidate?.route_id || '') !== String(realtime?.route_id || '')) return false;
        return true;
      });
      if (exact) return exact;
    }

    const scheduledTimestamp = finite(realtime?.scheduled_timestamp);
    if (scheduledTimestamp == null) return null;

    const routeId = String(realtime?.route_id || '').trim();
    const destinationKey = normalized(realtime?.destination || '');
    const directionKey = String(realtime?.direction_key || '').trim();
    let best = null;
    let bestDistance = Infinity;

    staticCandidates.forEach((candidate, index) => {
      if (matched.has(index)) return;
      if (String(candidate?.route_id || '').trim() !== routeId) return;
      if (directionKey && String(candidate?.direction_key || '').trim() && directionKey !== String(candidate.direction_key).trim()) return;
      if (destinationKey && normalized(candidate?.destination || '') !== destinationKey) return;

      const staticTimestamp = finite(candidate?.timestamp);
      if (staticTimestamp == null) return;
      const distance = Math.abs(staticTimestamp - scheduledTimestamp);
      // Realtime scheduled_time is only a fallback identity hint. A five-minute
      // tolerance avoids replacing a genuinely different scheduled course.
      if (distance > 5 * 60 || distance >= bestDistance) return;
      best = { candidate, index };
      bestDistance = distance;
    });

    return best?.candidate || null;
  }

  function mergeArrivalCandidates({
    staticCandidates = [],
    realtimeCandidates = [],
    nowSeconds = Date.now() / 1000,
    maxResults = 4,
    isStaticConsumed = () => false
  } = {}) {
    const staticList = Array.isArray(staticCandidates) ? staticCandidates : [];
    const realtimeList = Array.isArray(realtimeCandidates) ? realtimeCandidates : [];
    const matched = new Set();
    const matches = [];
    const combined = [];

    for (const realtime of realtimeList) {
      const timestamp = finite(realtime?.timestamp);
      if (timestamp == null) continue;

      const match = pickStaticMatch(realtime, staticList, matched);
      if (match) {
        const index = staticList.indexOf(match);
        if (index >= 0) matched.add(index);
        matches.push({ realtime, static: match });
      }

      combined.push({
        ...realtime,
        timestamp,
        scheduled_timestamp: finite(realtime?.scheduled_timestamp) ?? finite(match?.timestamp),
        source: 'realtime',
        realtime: true,
        matched_static: Boolean(match),
        static_course_id: match?.course_id || null,
        source_trip_id: String(realtime?.source_trip_id || realtime?.trip_id || '').trim()
      });
    }

    staticList.forEach((candidate, index) => {
      if (matched.has(index)) return;
      if (isStaticConsumed(candidate)) return;
      const timestamp = finite(candidate?.timestamp);
      if (timestamp == null) return;
      combined.push({
        ...candidate,
        timestamp,
        source: 'static',
        realtime: false,
        matched_static: false
      });
    });

    const grouped = new Map();
    for (const candidate of combined) {
      const key = groupKey(candidate);
      if (!grouped.has(key)) {
        grouped.set(key, {
          route_id: String(candidate?.route_id || '').trim(),
          route_ref: String(candidate?.route_ref || '').trim(),
          direction_key: String(candidate?.direction_key || '').trim(),
          destination: String(candidate?.destination || '').trim(),
          meta: candidate?.meta || null,
          times: []
        });
      }
      grouped.get(key).times.push(candidate);
    }

    const routes = [...grouped.values()]
      .map(route => {
        const times = route.times
          .sort((a, b) => Number(a.timestamp) - Number(b.timestamp))
          .filter((time, index, list) => {
            if (index === 0) return true;
            const previous = list[index - 1];
            // Never collapse a realtime/static pair incorrectly: only identical
            // actual timestamps are duplicates.
            return Number(time.timestamp) !== Number(previous.timestamp);
          })
          .slice(0, maxResults);
        return { ...route, times };
      })
      .filter(route => route.times.length)
      .sort((a, b) => Number(a.times[0].timestamp) - Number(b.times[0].timestamp));

    return { routes, matches };
  }

  function roundRemainingMinutes(timestamp, nowSeconds = Date.now() / 1000) {
    const arrival = finite(timestamp);
    const now = finite(nowSeconds);
    if (arrival == null || now == null) return null;
    const remainingSeconds = Math.max(0, arrival - now);
    if (remainingSeconds < 60) return 0;
    return Math.max(1, Math.round(remainingSeconds / 60));
  }

  const api = { mergeArrivalCandidates, roundRemainingMinutes };
  global.GtsofiaVirtualBoardArrivals = api;

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
