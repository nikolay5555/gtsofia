const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const FEED_TIMEOUT_MS = 15000;
const FEED_CACHE_TTL_MS = 15000;
const MAX_RESULTS_PER_ROUTE = 3;
const LOOK_AHEAD_SECONDS = 3 * 60 * 60;

// Keep one TextDecoder instance instead of creating a new one for every
// protobuf string field.
const TEXT_DECODER = new TextDecoder();

// The serverless instance may be reused between requests. Keeping the
// decoded/indexed feed in module memory avoids downloading and parsing the
// same GTFS-RT feed again for every stop request that lands on the same
// warm instance.
let feedCache = null;
let feedFetchPromise = null;

// GTFS-Realtime TripDescriptor.schedule_relationship.
// Keep these values here instead of scattering magic numbers through the
// parser/business logic because TripDescriptor and StopTimeUpdate use
// different enums. See https://gtfs.org/documentation/realtime/reference/.
const TRIP_RELATIONSHIP = Object.freeze({
  SCHEDULED: 0,
  ADDED: 1,          // deprecated; keep for backwards-compatible producers
  UNSCHEDULED: 2,
  CANCELED: 3,
  REPLACEMENT: 5,
  DUPLICATED: 6,
  DELETED: 7,
  NEW: 8
});

const STOP_RELATIONSHIP = Object.freeze({
  SCHEDULED: 0,
  SKIPPED: 1,
  NO_DATA: 2,
  UNSCHEDULED: 3
});

const TRIP_RELATIONSHIP_NAME = Object.freeze(
  Object.fromEntries(Object.entries(TRIP_RELATIONSHIP).map(([name, value]) => [value, name]))
);

const STOP_RELATIONSHIP_NAME = Object.freeze(
  Object.fromEntries(Object.entries(STOP_RELATIONSHIP).map(([name, value]) => [value, name]))
);

function readVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;

  while (state.index < bytes.length) {
    const byte = bytes[state.index++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 70n) throw new Error('Invalid protobuf varint.');
  }

  throw new Error('Truncated protobuf varint.');
}

function readField(bytes, state) {
  const tag = Number(readVarint(bytes, state));
  const fieldNumber = tag >>> 3;
  const wireType = tag & 7;

  if (!fieldNumber) throw new Error('Invalid protobuf field number.');

  if (wireType === 0) {
    return { fieldNumber, wireType, value: readVarint(bytes, state) };
  }

  if (wireType === 1) {
    const end = state.index + 8;
    if (end > bytes.length) throw new Error('Truncated fixed64 field.');
    const value = bytes.subarray(state.index, end);
    state.index = end;
    return { fieldNumber, wireType, value };
  }

  if (wireType === 2) {
    const length = Number(readVarint(bytes, state));
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new Error('Invalid protobuf length.');
    }

    const end = state.index + length;
    if (end > bytes.length) throw new Error('Truncated length-delimited field.');

    const value = bytes.subarray(state.index, end);
    state.index = end;

    return { fieldNumber, wireType, value };
  }

  if (wireType === 5) {
    const end = state.index + 4;
    if (end > bytes.length) throw new Error('Truncated fixed32 field.');

    const value = bytes.subarray(state.index, end);
    state.index = end;

    return { fieldNumber, wireType, value };
  }

  throw new Error(`Unsupported protobuf wire type: ${wireType}`);
}

function decodeString(bytes) {
  return TEXT_DECODER.decode(bytes);
}

function toSignedInt32(value) {
  const n = Number(BigInt.asUintN(32, value));
  return n >= 0x80000000 ? n - 0x100000000 : n;
}

function decodeTripDescriptor(bytes) {
  const state = { index: 0 };

  const trip = {
    tripId: '',
    routeId: '',
    directionId: '',
    startTime: '',
    startDate: '',
    scheduleRelationship: TRIP_RELATIONSHIP.SCHEDULED
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      trip.tripId = decodeString(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      trip.startTime = decodeString(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      trip.startDate = decodeString(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 0) {
      trip.scheduleRelationship = Number(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 2) {
      trip.routeId = decodeString(field.value);
    } else if (field.fieldNumber === 6 && field.wireType === 0) {
      trip.directionId = String(Number(field.value));
    }
  }

  return trip;
}

function decodeStopTimeEvent(bytes) {
  const state = { index: 0 };

  const event = {
    delay: null,
    time: null,
    scheduledTime: null
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 0) {
      event.delay = toSignedInt32(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      const raw = field.value;

      if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('GTFS-RT timestamp exceeds JavaScript safe integer range.');
      }

      event.time = Number(raw);
    } else if (field.fieldNumber === 3 && field.wireType === 0) {
      const raw = field.value;

      if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('GTFS-RT scheduled timestamp exceeds JavaScript safe integer range.');
      }

      event.scheduledTime = Number(raw);
    }
  }

  return event;
}

function decodeStopTimeUpdate(bytes) {
  const state = { index: 0 };

  const update = {
    stopSequence: null,
    stopId: '',
    arrival: null,
    departure: null,
    scheduleRelationship: STOP_RELATIONSHIP.SCHEDULED
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 0) {
      update.stopSequence = Number(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      update.arrival = decodeStopTimeEvent(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      update.departure = decodeStopTimeEvent(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2) {
      update.stopId = decodeString(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 0) {
      update.scheduleRelationship = Number(field.value);
    }
  }

  return update;
}

function decodeTripProperties(bytes) {
  const state = { index: 0 };

  const result = {
    tripId: '',
    startDate: '',
    startTime: ''
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.tripId = decodeString(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      result.startDate = decodeString(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      result.startTime = decodeString(field.value);
    }
  }

  return result;
}

function decodeTripUpdate(bytes) {
  const state = { index: 0 };

  const result = {
    trip: null,
    stopTimeUpdates: [],
    timestamp: null,
    tripProperties: null
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.trip = decodeTripDescriptor(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      result.stopTimeUpdates.push(decodeStopTimeUpdate(field.value));
    } else if (field.fieldNumber === 4 && field.wireType === 0) {
      const raw = field.value;

      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) {
        result.timestamp = Number(raw);
      }
    } else if (field.fieldNumber === 6 && field.wireType === 2) {
      result.tripProperties = decodeTripProperties(field.value);
    }
  }

  return result;
}

function decodeFeedEntity(bytes) {
  const state = { index: 0 };

  const entity = {
    id: '',
    tripUpdate: null
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      entity.id = decodeString(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      entity.isDeleted = Boolean(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      entity.tripUpdate = decodeTripUpdate(field.value);
    }
  }

  return entity;
}

function decodeGtfsRealtimeFeed(buffer) {
  const bytes = new Uint8Array(buffer);
  const state = { index: 0 };

  const updates = [];
  let feedTimestamp = null;

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      const headerState = { index: 0 };

      while (headerState.index < field.value.length) {
        const headerField = readField(field.value, headerState);

        if (headerField.fieldNumber === 3 && headerField.wireType === 0) {
          const raw = headerField.value;

          if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) {
            feedTimestamp = Number(raw);
          }
        }
      }
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      const entity = decodeFeedEntity(field.value);

      if (entity.tripUpdate?.trip) {
        updates.push(entity.tripUpdate);
      }
    }
  }

  return {
    updates,
    feedTimestamp: feedTimestamp || Math.floor(Date.now() / 1000)
  };
}

function normalizeStopKey(value) {
  const raw = String(value ?? '').trim();

  if (!raw) return '';

  const withoutMetroPrefix = raw.replace(/^M/i, '');
  const digits = withoutMetroPrefix.replace(/\D/g, '');

  if (digits) {
    return String(Number(digits));
  }

  return withoutMetroPrefix.toLowerCase();
}

function stopIdsMatch(left, right) {
  return normalizeStopKey(left) === normalizeStopKey(right);
}

function eventTimestamp(update) {
  if (Number.isFinite(update?.arrival?.time)) {
    return update.arrival.time;
  }

  if (Number.isFinite(update?.departure?.time)) {
    return update.departure.time;
  }

  return null;
}

function eventDelay(update) {
  if (Number.isFinite(update?.arrival?.delay)) {
    return update.arrival.delay;
  }

  if (Number.isFinite(update?.departure?.delay)) {
    return update.departure.delay;
  }

  return null;
}

function getTripKey(tripUpdate) {
  const trip = tripUpdate?.trip;

  return [
    trip?.tripId || '',
    trip?.startDate || tripUpdate?.tripProperties?.startDate || '',
    trip?.startTime || tripUpdate?.tripProperties?.startTime || '',
    trip?.routeId || '',
    trip?.directionId || ''
  ].join('|');
}

function isCanceledOrDeleted(trip) {
  const relationship = Number.isFinite(Number(trip?.scheduleRelationship))
    ? Number(trip.scheduleRelationship)
    : TRIP_RELATIONSHIP.SCHEDULED;

  return relationship === TRIP_RELATIONSHIP.CANCELED
    || relationship === TRIP_RELATIONSHIP.DELETED;
}

function getTerminalStopId(tripUpdate) {
  return (tripUpdate?.stopTimeUpdates || [])
    .filter(item => {
      if (!item?.stopId) return false;

      const relationship = Number.isFinite(Number(item.scheduleRelationship))
        ? Number(item.scheduleRelationship)
        : STOP_RELATIONSHIP.SCHEDULED;

      return relationship !== STOP_RELATIONSHIP.SKIPPED
        && relationship !== STOP_RELATIONSHIP.NO_DATA;
    })
    .sort((a, b) => {
      const sa = Number.isFinite(Number(a?.stopSequence))
        ? Number(a.stopSequence)
        : -1;

      const sb = Number.isFinite(Number(b?.stopSequence))
        ? Number(b.stopSequence)
        : -1;

      return sb - sa;
    })[0]?.stopId || '';
}

function prepareFeed(updates, feedTimestamp) {
  const stopUpdatesByKey = new Map();
  const sequenceOnlySkipped = [];

  const activeTrips = [];
  const seenActive = new Set();

  const realtimeRouteIds = new Set();

  for (const update of updates || []) {
    const trip = update?.trip;

    if (!trip) continue;

    const relationship = Number.isFinite(Number(trip.scheduleRelationship))
      ? Number(trip.scheduleRelationship)
      : TRIP_RELATIONSHIP.SCHEDULED;

    const routeId = String(trip.routeId || '').trim();

    if (routeId) {
      realtimeRouteIds.add(routeId);
    }

    // Compute active trips only once per feed instead of once per board request.
    if (!isCanceledOrDeleted(trip)) {
      const tripKey = getTripKey(update);

      if (!seenActive.has(tripKey)) {
        seenActive.add(tripKey);

        activeTrips.push({
          trip_id: String(trip.tripId || ''),
          start_date: String(
            trip.startDate || update.tripProperties?.startDate || ''
          ),
          start_time: String(
            trip.startTime || update.tripProperties?.startTime || ''
          ),
          route_id: String(trip.routeId || ''),
          direction_id: String(trip.directionId || ''),
          destination_stop_id: String(getTerminalStopId(update)),
          schedule_relationship: relationship,
          schedule_relationship_name:
            TRIP_RELATIONSHIP_NAME[relationship]
            || `UNKNOWN_${relationship}`
        });
      }
    }

    if (isCanceledOrDeleted(trip)) {
      continue;
    }

    // Compute the terminal stop once per trip update.
    const terminalStopId = getTerminalStopId(update);

    for (const stopUpdate of update.stopTimeUpdates || []) {
      const stopRelationship = Number.isFinite(
        Number(stopUpdate.scheduleRelationship)
      )
        ? Number(stopUpdate.scheduleRelationship)
        : STOP_RELATIONSHIP.SCHEDULED;

      if (stopRelationship === STOP_RELATIONSHIP.SKIPPED) {
        if (stopUpdate?.stopId) {
          const stopKey = normalizeStopKey(stopUpdate.stopId);

          if (!stopUpdatesByKey.has(stopKey)) {
            stopUpdatesByKey.set(stopKey, []);
          }

          stopUpdatesByKey.get(stopKey).push({
            tripUpdate: update,
            stopUpdate,
            terminalStopId
          });
        } else {
          // Preserve the existing behavior for sequence-only SKIPPED records:
          // they are available to the frontend so it can resolve the stop
          // using the static trip pattern.
          sequenceOnlySkipped.push({
            tripUpdate: update,
            stopUpdate,
            terminalStopId
          });
        }

        continue;
      }

      if (!stopUpdate?.stopId) {
        continue;
      }

      const stopKey = normalizeStopKey(stopUpdate.stopId);

      if (!stopUpdatesByKey.has(stopKey)) {
        stopUpdatesByKey.set(stopKey, []);
      }

      stopUpdatesByKey.get(stopKey).push({
        tripUpdate: update,
        stopUpdate,
        terminalStopId
      });
    }
  }

  return {
    feedTimestamp,
    stopUpdatesByKey,
    sequenceOnlySkipped,
    activeTrips,
    realtimeRouteIds: [...realtimeRouteIds]
  };
}

async function fetchAndPrepareFeed() {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    FEED_TIMEOUT_MS
  );

  try {
    const upstream = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/x-protobuf, application/octet-stream',
        'User-Agent': 'GTSofia virtual boards'
      }
    });

    if (!upstream.ok) {
      throw new Error(
        `Sofia Traffic GTFS-RT returned ${upstream.status}.`
      );
    }

    const body = await upstream.arrayBuffer();

    if (!body.byteLength) {
      throw new Error(
        'Sofia Traffic GTFS-RT feed is empty.'
      );
    }

    const decoded = decodeGtfsRealtimeFeed(body);

    return prepareFeed(
      decoded.updates,
      decoded.feedTimestamp
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function getRealtimeFeed() {
  const now = Date.now();

  // Reuse the already decoded/indexed feed while it is fresh enough.
  if (
    feedCache
    && now - feedCache.cachedAt < FEED_CACHE_TTL_MS
  ) {
    return feedCache.feed;
  }

  // If multiple requests arrive at the same time, make only one upstream
  // request and let all callers wait for that same Promise.
  if (feedFetchPromise) {
    return feedFetchPromise;
  }

  feedFetchPromise = fetchAndPrepareFeed()
    .then(feed => {
      feedCache = {
        feed,
        cachedAt: Date.now()
      };

      return feed;
    })
    .finally(() => {
      feedFetchPromise = null;
    });

  return feedFetchPromise;
}

function buildBoard(feed, stopCode) {
  const now = Math.floor(Date.now() / 1000);
  const target = normalizeStopKey(stopCode);

  const grouped = new Map();
  const skippedTrips = new Map();

  // This is the main optimization:
  // instead of scanning every stop update in every trip in the feed,
  // start from updates already indexed for this particular stop.
  //
  // Sequence-only SKIPPED records are also included because the frontend
  // needs them to resolve them against the static trip pattern.
  const candidates = [
    ...(feed.stopUpdatesByKey.get(target) || []),
    ...feed.sequenceOnlySkipped
  ];

  for (const candidate of candidates) {
    const tripUpdate = candidate?.tripUpdate;
    const stopUpdate = candidate?.stopUpdate;
    const trip = tripUpdate?.trip;

    if (!trip || !stopUpdate) continue;

    const tripRelationship = Number.isFinite(
      Number(trip.scheduleRelationship)
    )
      ? Number(trip.scheduleRelationship)
      : TRIP_RELATIONSHIP.SCHEDULED;

    // CANCELED/DELETED are terminal states for the whole trip.
    if (
      tripRelationship === TRIP_RELATIONSHIP.CANCELED
      || tripRelationship === TRIP_RELATIONSHIP.DELETED
    ) {
      continue;
    }

    const stopRelationship = Number.isFinite(
      Number(stopUpdate.scheduleRelationship)
    )
      ? Number(stopUpdate.scheduleRelationship)
      : STOP_RELATIONSHIP.SCHEDULED;

    if (stopRelationship === STOP_RELATIONSHIP.SKIPPED) {
      if (
        stopUpdate?.stopId
        && !stopIdsMatch(stopUpdate.stopId, target)
      ) {
        continue;
      }

      const skippedKey = [
        trip.tripId || '',
        trip.startDate
          || tripUpdate.tripProperties?.startDate
          || '',
        trip.startTime
          || tripUpdate.tripProperties?.startTime
          || '',
        trip.routeId || '',
        trip.directionId || '',
        stopUpdate.stopId
          ? normalizeStopKey(stopUpdate.stopId)
          : `seq:${
              Number.isFinite(Number(stopUpdate.stopSequence))
                ? Number(stopUpdate.stopSequence)
                : ''
            }`
      ].join('|');

      if (!skippedTrips.has(skippedKey)) {
        skippedTrips.set(skippedKey, {
          trip_id: trip.tripId || '',
          start_date:
            trip.startDate
            || tripUpdate.tripProperties?.startDate
            || '',
          start_time:
            trip.startTime
            || tripUpdate.tripProperties?.startTime
            || '',
          route_id: trip.routeId || '',
          direction_id: trip.directionId || '',
          stop_id: stopUpdate.stopId || '',
          stop_sequence:
            Number.isFinite(Number(stopUpdate.stopSequence))
              ? Number(stopUpdate.stopSequence)
              : null,
          stop_schedule_relationship: stopRelationship,
          stop_schedule_relationship_name:
            STOP_RELATIONSHIP_NAME[stopRelationship]
            || `UNKNOWN_${stopRelationship}`
        });
      }

      continue;
    }

    // A normal arrival must still be for the requested stop.
    if (
      !stopUpdate?.stopId
      || !stopIdsMatch(stopUpdate.stopId, target)
    ) {
      continue;
    }

    // NO_DATA explicitly says no realtime timing is available here.
    // It must not suppress the static fallback.
    if (stopRelationship === STOP_RELATIONSHIP.NO_DATA) {
      continue;
    }

    const timestamp = eventTimestamp(stopUpdate);

    if (!Number.isFinite(timestamp)) {
      continue;
    }

    if (timestamp < now - 60) {
      continue;
    }

    if (timestamp > now + LOOK_AHEAD_SECONDS) {
      continue;
    }

    const delay = eventDelay(stopUpdate);
    const key = getTripKey(tripUpdate);

    if (!grouped.has(key)) {
      grouped.set(key, {
        trip_id: trip.tripId || '',
        trip_start_date:
          trip.startDate
          || tripUpdate.tripProperties?.startDate
          || '',
        trip_start_time:
          trip.startTime
          || tripUpdate.tripProperties?.startTime
          || '',
        route_id: trip.routeId || '',
        direction_id: trip.directionId || '',
        schedule_relationship: tripRelationship,
        schedule_relationship_name:
          TRIP_RELATIONSHIP_NAME[tripRelationship]
          || `UNKNOWN_${tripRelationship}`,
        destination_stop_id:
          candidate.terminalStopId || '',
        times: []
      });
    }

    grouped.get(key).times.push({
      timestamp,
      delay: Number.isFinite(delay) ? delay : null,
      stop_schedule_relationship: stopRelationship,
      stop_schedule_relationship_name:
        STOP_RELATIONSHIP_NAME[stopRelationship]
        || `UNKNOWN_${stopRelationship}`,
      scheduled_time:
        Number.isFinite(
          Number(stopUpdate?.arrival?.scheduledTime)
        )
          ? Number(stopUpdate.arrival.scheduledTime)
          : Number.isFinite(
              Number(stopUpdate?.departure?.scheduledTime)
            )
            ? Number(
                stopUpdate.departure.scheduledTime
              )
            : null
    });
  }

  const routes = [...grouped.values()]
    .map(row => ({
      ...row,
      times: row.times
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(0, MAX_RESULTS_PER_ROUTE)
    }))
    .filter(row => row.times.length)
    .sort(
      (a, b) =>
        a.times[0].timestamp
        - b.times[0].timestamp
    );

  return {
    status: routes.length ? 'ok' : 'empty',
    stop_code: String(stopCode),
    generated_at: feed.feedTimestamp,

    // Kept for API compatibility.
    // The frontend must not use route-level presence here to suppress
    // static fallback; fallback is directional and based on active_trips
    // / realtime route rows instead.
    realtime_route_ids: feed.realtimeRouteIds,

    active_trips: feed.activeTrips,

    // SKIPPED is an explicit suppression signal for static fallback.
    // It is kept per trip + stop so unrelated scheduled courses on the
    // same line/direction are not hidden.
    skipped_trips: [...skippedTrips.values()],

    // Keep this field for compatibility with the current frontend while
    // the richer active_trips representation is adopted.
    active_trip_ids: feed.activeTrips
      .map(item => item.trip_id)
      .filter(Boolean),

    routes
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      error: 'Method not allowed'
    });
  }

  const stopCode = String(
    req.query?.stop_code || ''
  ).trim();

  const requestedRouteIds = new Set(
    String(req.query?.route_ids || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );

  if (!stopCode) {
    return res.status(400).json({
      error: 'Missing stop_code.'
    });
  }

  try {
    const feed = await getRealtimeFeed();
    const board = buildBoard(feed, stopCode);

    if (requestedRouteIds.size) {
      board.active_trips =
        (board.active_trips || []).filter(item =>
          requestedRouteIds.has(
            String(item?.route_id || '').trim()
          )
        );

      board.active_trip_ids = board.active_trips
        .map(item =>
          String(item.trip_id || '').trim()
        )
        .filter(Boolean);
    }

    res.setHeader(
      'Content-Type',
      'application/json; charset=utf-8'
    );

    // Keep the browser from caching the board response.
    // The server-side feed cache is independent from this.
    res.setHeader(
      'Cache-Control',
      'no-store, max-age=0'
    );

    res.setHeader(
      'Access-Control-Allow-Origin',
      '*'
    );

    return res.status(200).json(board);
  } catch (error) {
    const message =
      error?.name === 'AbortError'
        ? 'Sofia Traffic GTFS-RT request timed out.'
        : (
            error?.message
            || 'Unable to fetch/decode GTFS-RT.'
          );

    return res.status(502).json({
      error: message
    });
  }
};
