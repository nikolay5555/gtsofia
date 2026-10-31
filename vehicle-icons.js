(function (root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.VehicleIcons = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EXTRAS_ENDPOINT = 'https://sft-proxy.onrender.com/virtual-board?stop_code=';
  const REQUEST_TIMEOUT_MS = 7000;
  const CACHE_TTL_MS = 12000;
  const MATCH_TOLERANCE_MINUTES = 1;

  // The order matches the `extras` array used by Sofiatraffic-schedules:
  // 0 = air conditioning, 1 = wheelchair access, 2 = bike rack.
  const ICONS = Object.freeze([
    Object.freeze({
      index: 0,
      src: 'Icons/snow.svg',
      label: 'Климатик'
    }),
    Object.freeze({
      index: 1,
      src: 'Icons/chair.svg',
      label: 'Достъпност за инвалидни колички'
    }),
    Object.freeze({
      index: 2,
      src: 'Icons/wheel.svg',
      label: 'Велобагажник'
    })
  ]);

  const stopCache = new Map();

  function isEnabled(value) {
    return value === true || value === 1 || String(value ?? '').trim() === '1';
  }

  function getExtrasFlags(extras) {
    if (Array.isArray(extras) || typeof extras === 'string') {
      const values = typeof extras === 'string'
        ? extras.trim().split('')
        : extras;

      return ICONS.map(icon => isEnabled(values[icon.index]));
    }

    if (!extras || typeof extras !== 'object') {
      return [false, false, false];
    }

    return [
      isEnabled(extras.air_conditioning ?? extras.airConditioning ?? extras.ac ?? extras[0]),
      isEnabled(extras.wheelchair_access ?? extras.wheelchairAccess ?? extras.wheelchair ?? extras[1]),
      isEnabled(extras.bike_rack ?? extras.bikeRack ?? extras.bicycle ?? extras[2])
    ];
  }

  function renderHtml(extras) {
    const flags = getExtrasFlags(extras);
    const enabledIcons = ICONS.filter(icon => flags[icon.index]);

    if (!enabledIcons.length) return '';

    const labels = enabledIcons.map(icon => icon.label).join(', ');
    const images = enabledIcons.map(icon =>
      `<img class="vb-vehicle-icon" src="${icon.src}" alt="${icon.label}" title="${icon.label}" loading="lazy">`
    ).join('');

    return `<span class="vb-vehicle-icons" role="img" aria-label="Оборудване: ${labels}">${images}</span>`;
  }

  function normalizeLine(value) {
    return String(value ?? '')
      .trim()
      .toLocaleUpperCase('bg-BG')
      .replace(/\s+/g, '');
  }

  function normalizeDestination(value) {
    return String(value ?? '')
      .trim()
      .toLocaleLowerCase('bg-BG')
      .replace(/[–—]/g, '-')
      .replace(/[^\p{L}\p{N}]+/gu, '');
  }

  function getRouteLine(route) {
    return normalizeLine(
      route?.route_ref
      ?? route?.routeRef
      ?? route?.meta?.number
      ?? route?.number
    );
  }

  function getRouteDestinationKeys(route) {
    return [
      route?.destination,
      route?.headsign,
      route?.terminal_stop_id,
      route?.destination_stop_id,
      route?.destinationStopId,
      route?.meta?.destination
    ]
      .map(normalizeDestination)
      .filter(Boolean);
  }

  function getStopCode(stopCode) {
    const raw = String(stopCode ?? '').trim();
    if (!raw) return null;

    const isMetro = /^M/i.test(raw);
    return {
      code: isMetro ? raw.replace(/\D/g, '') : raw,
      isMetro
    };
  }

  function createCandidates(proxyRoutes) {
    const candidatesByLine = new Map();
    let candidateId = 0;

    for (const route of proxyRoutes) {
      const line = getRouteLine(route);
      if (!line) continue;

      const destinations = getRouteDestinationKeys(route);
      const times = Array.isArray(route?.times) ? route.times : [];

      for (const time of times) {
        const minutes = Number(time?.t);
        // Keep arrivals without enabled equipment flags as candidates too.
        // They are needed to detect same-minute vehicles in the opposite
        // direction; otherwise an equipped bus could be matched to the wrong
        // arrival simply because the other bus has no icons.
        if (!Number.isFinite(minutes) || time?.extras === undefined || time?.extras === null) continue;
        const flags = getExtrasFlags(time.extras);

        if (!candidatesByLine.has(line)) {
          candidatesByLine.set(line, []);
        }

        candidatesByLine.get(line).push({
          id: candidateId++,
          destinations,
          minutes,
          extras: time.extras,
          flags
        });
      }
    }

    return candidatesByLine;
  }

  function chooseCandidate(candidates, targetMinutes, targetDestinations, usedIds) {
    let matches = candidates.filter(candidate =>
      !usedIds.has(candidate.id)
      && Math.abs(candidate.minutes - targetMinutes) <= MATCH_TOLERANCE_MINUTES
    );

    if (!matches.length) return null;

    // Destination is the strongest direction signal. If the names differ
    // between the two projects, only fall back to time when that match is
    // unambiguous for this line.
    if (targetDestinations.length) {
      const targetDestinationSet = new Set(targetDestinations);
      const sameDestination = matches.filter(candidate =>
        candidate.destinations.some(destination => targetDestinationSet.has(destination))
      );

      if (sameDestination.length) {
        matches = sameDestination;
      }
    }

    matches.sort((left, right) =>
      Math.abs(left.minutes - targetMinutes)
      - Math.abs(right.minutes - targetMinutes)
    );

    const bestDifference = Math.abs(matches[0].minutes - targetMinutes);
    const bestMatches = matches.filter(candidate =>
      Math.abs(candidate.minutes - targetMinutes) === bestDifference
    );

    return bestMatches.length === 1 ? bestMatches[0] : null;
  }

  function attachExtras(routes, proxyRoutes, nowMs = Date.now()) {
    if (!Array.isArray(routes) || !Array.isArray(proxyRoutes)) return routes;

    const candidatesByLine = createCandidates(proxyRoutes);
    if (!candidatesByLine.size) return routes;

    const nowSeconds = Number(nowMs) / 1000;
    let matchedCount = 0;

    const enrichedRoutes = routes.map(route => {
      const line = getRouteLine(route);
      const candidates = candidatesByLine.get(line) || [];
      if (!candidates.length || !Array.isArray(route?.times)) return route;

      const targetDestinations = getRouteDestinationKeys(route);
      const usedIds = new Set();
      let routeChanged = false;

      const times = route.times.map(time => {
        if (time?.extras !== undefined && time?.extras !== null) return time;

        const timestamp = Number(time?.timestamp);
        if (!Number.isFinite(timestamp)) return time;

        const targetMinutes = Math.round((timestamp - nowSeconds) / 60);
        const candidate = chooseCandidate(
          candidates,
          targetMinutes,
          targetDestinations,
          usedIds
        );

        if (!candidate) return time;

        usedIds.add(candidate.id);
        matchedCount++;
        routeChanged = true;
        return { ...time, extras: candidate.extras };
      });

      return routeChanged ? { ...route, times } : route;
    });

    return matchedCount ? enrichedRoutes : routes;
  }

  async function fetchProxyRoutes(stopCode, fetchImpl = globalThis.fetch) {
    const stop = getStopCode(stopCode);
    if (!stop || typeof fetchImpl !== 'function') return [];

    const cacheKey = `${stop.code}|${stop.isMetro ? 'metro' : 'surface'}`;
    const cached = stopCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
      return cached.promise;
    }

    const url = `${EXTRAS_ENDPOINT}${encodeURIComponent(stop.code)}${stop.isMetro ? '&metro' : ''}`;
    const promise = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetchImpl(url, {
          method: 'GET',
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal
        });

        if (!response.ok) return [];

        const data = await response.json();
        return data?.status === 'ok' && Array.isArray(data?.routes)
          ? data.routes
          : [];
      } catch {
        // The virtual board must remain usable when the optional extras source
        // is unavailable (for example, during a proxy cold start).
        return [];
      } finally {
        clearTimeout(timeout);
      }
    })();

    stopCache.set(cacheKey, {
      promise,
      expiresAt: now + CACHE_TTL_MS
    });

    return promise;
  }

  async function enrichRoutes(routes, stopCode, options = {}) {
    const proxyRoutes = await fetchProxyRoutes(
      stopCode,
      options.fetchImpl || globalThis.fetch
    );

    return attachExtras(routes, proxyRoutes, options.nowMs ?? Date.now());
  }

  return Object.freeze({
    getExtrasFlags,
    renderHtml,
    attachExtras,
    fetchProxyRoutes,
    enrichRoutes
  });
});
