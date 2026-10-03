const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const FEED_TIMEOUT_MS = 15000;
const MAX_RESULTS_PER_ROUTE = 4;
const LOOK_AHEAD_SECONDS = 3 * 60 * 60;

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
  return new TextDecoder().decode(bytes);
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
  const event = { delay: null, time: null };

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
  const result = { tripId: '', startDate: '', startTime: '' };

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
    delay: null,
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
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) result.timestamp = Number(raw);
    } else if (field.fieldNumber === 5 && field.wireType === 0) {
      result.delay = toSignedInt32(field.value);
    } else if (field.fieldNumber === 6 && field.wireType === 2) {
      result.tripProperties = decodeTripProperties(field.value);
    }
  }

  return result;
}

function decodeFeedEntity(bytes) {
  const state = { index: 0 };
  const entity = { id: '', tripUpdate: null };

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
          if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) feedTimestamp = Number(raw);
        }
      }
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      const entity = decodeFeedEntity(field.value);
      if (entity.tripUpdate?.trip) updates.push(entity.tripUpdate);
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
  if (digits) return String(Number(digits));

  return withoutMetroPrefix.toLowerCase();
}

function stopIdsMatch(left, right) {
  return normalizeStopKey(left) === normalizeStopKey(right);
}

function optionalFiniteNumber(value) {
  if (
    value === null
    || value === undefined
    || String(value).trim() === ""
  ) return null;

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function eventTimestamp(update) {
  if (Number.isFinite(update?.arrival?.time)) return update.arrival.time;
  if (Number.isFinite(update?.departure?.time)) return update.departure.time;
  return null;
}

function eventDelay(update) {
  if (Number.isFinite(update?.arrival?.delay)) return update.arrival.delay;
  if (Number.isFinite(update?.departure?.delay)) return update.departure.delay;
  return null;
}

function buildBoard(updates, stopCode, feedTimestamp) {
  const now = Math.floor(Date.now() / 1000);
  const target = normalizeStopKey(stopCode);
  const grouped = new Map();
  const skippedTrips = new Map();
  const suppressedTrips = new Map();

  const getTripRelationship = trip => {
    const value = Number(trip?.scheduleRelationship);
    return Number.isFinite(value) ? value : TRIP_RELATIONSHIP.SCHEDULED;
  };

  const getTripInstanceId = (trip, tripUpdate) => {
    const relationship = getTripRelationship(trip);
    if (relationship === TRIP_RELATIONSHIP.DUPLICATED) {
      return String(tripUpdate?.tripProperties?.tripId || "").trim();
    }
    return String(trip?.tripId || "").trim();
  };

  function normalizeStopTimeUpdates(stopTimeUpdates) {
    return (stopTimeUpdates || [])
      .map((update, index) => ({
        update,
        index,
        sequence: optionalFiniteNumber(update?.stopSequence)
      }))
      .sort((left, right) => {
        if (left.sequence != null && right.sequence != null) {
          return left.sequence - right.sequence;
        }
        if (left.sequence != null) return -1;
        if (right.sequence != null) return 1;
        return left.index - right.index;
      })
      .map(item => item.update);
  }

  function serializeDelayUpdates(stopTimeUpdates) {
    return normalizeStopTimeUpdates(stopTimeUpdates).map(update => ({
      stop_id: String(update?.stopId || "").trim(),
      stop_sequence: optionalFiniteNumber(update?.stopSequence),
schedule_relationship: optionalFiniteNumber(update?.scheduleRelationship)
        ?? STOP_RELATIONSHIP.SCHEDULED,
      delay: optionalFiniteNumber(eventDelay(update)),
      timestamp: optionalFiniteNumber(eventTimestamp(update)),
      scheduled_time: optionalFiniteNumber(
        update?.arrival?.scheduledTime
        ?? update?.departure?.scheduledTime
      )
    }));
  }

  for (const tripUpdate of updates || []) {
    const trip = tripUpdate?.trip;
    if (!trip) continue;

    const tripRelationship = getTripRelationship(trip);
    const tripId = getTripInstanceId(trip, tripUpdate);
    const sourceTripId = String(trip.tripId || "").trim();
    const tripStartDate = String(
      trip.startDate || tripUpdate.tripProperties?.startDate || ""
    ).trim();
    const tripStartTime = String(
      trip.startTime || tripUpdate.tripProperties?.startTime || ""
    ).trim();
    const tripRouteId = String(trip.routeId || "").trim();
    const tripDirectionId = String(trip.directionId || "").trim();

    // CANCELED/DELETED are explicit static-trip suppression signals. They do
    // not need StopTimeUpdates and take precedence over any stop update.
    if (
      tripRelationship === TRIP_RELATIONSHIP.CANCELED
      || tripRelationship === TRIP_RELATIONSHIP.DELETED
    ) {
      if (sourceTripId || tripId) {
        const key = [
          sourceTripId || tripId,
          tripStartDate,
          tripStartTime,
          tripRouteId,
          tripDirectionId
        ].join("|");

        suppressedTrips.set(key, {
          trip_id: sourceTripId || tripId,
          trip_instance_id: tripId || sourceTripId,
          start_date: tripStartDate,
          start_time: tripStartTime,
          route_id: tripRouteId,
          direction_id: tripDirectionId,
          schedule_relationship: tripRelationship,
          schedule_relationship_name: TRIP_RELATIONSHIP_NAME[tripRelationship]
            || `UNKNOWN_${tripRelationship}`
        });
      }
      continue;
    }

    for (const stopUpdate of normalizeStopTimeUpdates(tripUpdate.stopTimeUpdates)) {
      const stopRelationship = optionalFiniteNumber(stopUpdate?.scheduleRelationship)
        ?? STOP_RELATIONSHIP.SCHEDULED;

      const stopSequence = optionalFiniteNumber(stopUpdate?.stopSequence);

      // SKIPPED is useful even when the producer identifies the stop only by
      // stop_sequence. Keep it as an exact suppression signal for the frontend.
      if (stopRelationship === STOP_RELATIONSHIP.SKIPPED) {
        if (stopUpdate?.stopId && !stopIdsMatch(stopUpdate.stopId, target)) continue;

        const skippedKey = [
          tripId,
          tripStartDate,
          tripStartTime,
          tripRouteId,
          tripDirectionId,
          stopUpdate.stopId
            ? normalizeStopKey(stopUpdate.stopId)
            : `seq:${stopSequence ?? ''}`
        ].join("|");

        if (!skippedTrips.has(skippedKey)) {
          skippedTrips.set(skippedKey, {
            trip_id: tripId,
            source_trip_id: sourceTripId,
            start_date: tripStartDate,
            start_time: tripStartTime,
            route_id: tripRouteId,
            direction_id: tripDirectionId,
            stop_id: stopUpdate.stopId || "",
            stop_sequence: stopSequence,
            stop_schedule_relationship: stopRelationship,
            stop_schedule_relationship_name: STOP_RELATIONSHIP_NAME[stopRelationship]
              || `UNKNOWN_${stopRelationship}`
          });
        }
        continue;
      }

      if (stopRelationship === STOP_RELATIONSHIP.NO_DATA) continue;

      // A normal update can identify the stop by stop_id OR stop_sequence.
      // When only stop_sequence is supplied, keep it for the frontend, which
      // has the static stop_times mapping needed to resolve the selected stop.
      const hasTargetStopId =
        !!stopUpdate?.stopId && stopIdsMatch(stopUpdate.stopId, target);
      const sequenceOnly =
        !stopUpdate?.stopId && Number.isFinite(stopSequence);

      if (!hasTargetStopId && !sequenceOnly) continue;
      if (tripRelationship !== TRIP_RELATIONSHIP.NEW
        && tripRelationship !== TRIP_RELATIONSHIP.REPLACEMENT
        && stopUpdate?.stopId
        && !hasTargetStopId) {
        continue;
      }

      const timestamp = eventTimestamp(stopUpdate);
      const stopDelay = eventDelay(stopUpdate);
      const delay = Number.isFinite(stopDelay)
        ? stopDelay
        : (
          Number.isFinite(Number(tripUpdate?.delay))
            ? Number(tripUpdate.delay)
            : null
        );

      // For SCHEDULED trips delay-only StopTimeEvents are valid and the
      // frontend can resolve the absolute timestamp using static GTFS.
      if (!Number.isFinite(timestamp) && !Number.isFinite(Number(delay))) continue;

      if (Number.isFinite(timestamp)) {
        if (timestamp < now - 60) continue;
        if (timestamp > now + LOOK_AHEAD_SECONDS) continue;
      }

      const key = [
        tripId,
        tripStartDate,
        tripStartTime,
        tripRouteId,
        tripDirectionId
      ].join("|");

      if (!grouped.has(key)) {
        const terminalUpdate = (tripUpdate.stopTimeUpdates || [])
          .filter(item => {
            if (!item?.stopId) return false;
            const relationship = optionalFiniteNumber(item?.scheduleRelationship)
              ?? STOP_RELATIONSHIP.SCHEDULED;
            return relationship !== STOP_RELATIONSHIP.SKIPPED
              && relationship !== STOP_RELATIONSHIP.NO_DATA;
          })
          .sort((a, b) => {
            const sa = optionalFiniteNumber(a?.stopSequence) ?? -1;
            const sb = optionalFiniteNumber(b?.stopSequence) ?? -1;
            return sb - sa;
          })[0] || null;

        grouped.set(key, {
          trip_id: tripId,
          source_trip_id: sourceTripId,
          trip_instance_id: tripId,
          trip_start_date: tripStartDate,
          trip_start_time: tripStartTime,
          route_id: tripRouteId,
          direction_id: tripDirectionId,
          schedule_relationship: tripRelationship,
          schedule_relationship_name: TRIP_RELATIONSHIP_NAME[tripRelationship]
            || `UNKNOWN_${tripRelationship}`,
          destination_stop_id: terminalUpdate?.stopId || "",
          trip_delay: Number.isFinite(Number(tripUpdate?.delay))
            ? Number(tripUpdate.delay)
            : null,
          times: []
        });
      }

      grouped.get(key).times.push({
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
        delay,
        stop_id: stopUpdate.stopId || "",
        stop_sequence: stopSequence,
        stop_schedule_relationship: stopRelationship,
        stop_schedule_relationship_name: STOP_RELATIONSHIP_NAME[stopRelationship]
          || `UNKNOWN_${stopRelationship}`,
        scheduled_time: optionalFiniteNumber(
          stopUpdate?.arrival?.scheduledTime
          ?? stopUpdate?.departure?.scheduledTime
        )
      });
    }
  }

  const routes = [...grouped.values()]
    .map(row => ({
      ...row,
      times: row.times
        .sort((a, b) => {
          const aTime = Number.isFinite(Number(a.timestamp)) ? Number(a.timestamp) : Infinity;
          const bTime = Number.isFinite(Number(b.timestamp)) ? Number(b.timestamp) : Infinity;
          return aTime - bTime;
        })
        .slice(0, MAX_RESULTS_PER_ROUTE)
    }))
    .filter(row => row.times.length)
    .sort((a, b) => {
      const aTime = Number.isFinite(Number(a.times[0]?.timestamp))
        ? Number(a.times[0].timestamp)
        : Infinity;
      const bTime = Number.isFinite(Number(b.times[0]?.timestamp))
        ? Number(b.times[0].timestamp)
        : Infinity;
      return aTime - bTime;
    });

  const activeTrips = [];
  const seenActive = new Set();
  for (const update of updates || []) {
    const trip = update?.trip;
    if (!trip) continue;

    const relationship = getTripRelationship(trip);
    if (
      relationship === TRIP_RELATIONSHIP.CANCELED
      || relationship === TRIP_RELATIONSHIP.DELETED
    ) continue;

    const tripId = getTripInstanceId(trip, update);
    if (!tripId) continue;

    const tripKey = [
      tripId,
      String(trip.startDate || update.tripProperties?.startDate || ""),
      String(trip.startTime || update.tripProperties?.startTime || ""),
      String(trip.routeId || ""),
      String(trip.directionId || "")
    ].join("|");
    if (seenActive.has(tripKey)) continue;
    seenActive.add(tripKey);

    activeTrips.push({
      trip_id: tripId,
      source_trip_id: String(trip.tripId || "").trim(),
      start_date: String(trip.startDate || update.tripProperties?.startDate || ""),
      start_time: String(trip.startTime || update.tripProperties?.startTime || ""),
      route_id: String(trip.routeId || ""),
      direction_id: String(trip.directionId || ""),
      schedule_relationship: relationship,
      schedule_relationship_name: TRIP_RELATIONSHIP_NAME[relationship]
        || `UNKNOWN_${relationship}`,
      trip_delay: optionalFiniteNumber(update?.delay),
      delay_updates: serializeDelayUpdates(update.stopTimeUpdates)
    });
  }

  const realtimeRouteIds = [...new Set(
    (updates || [])
      .filter(update => {
        const relationship = getTripRelationship(update?.trip);
        return relationship !== TRIP_RELATIONSHIP.CANCELED
          && relationship !== TRIP_RELATIONSHIP.DELETED;
      })
      .map(update => String(update?.trip?.routeId || "").trim())
      .filter(Boolean)
  )];

  return {
    status: routes.length ? "ok" : "empty",
    stop_code: String(stopCode),
    generated_at: feedTimestamp,
    realtime_route_ids: realtimeRouteIds,
    active_trips: activeTrips,
    active_trip_ids: activeTrips.map(item => item.trip_id).filter(Boolean),
    skipped_trips: [...skippedTrips.values()],
    suppressed_trips: [...suppressedTrips.values()],
    routes
  };
}
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stopCode = String(req.query?.stop_code || '').trim();
  const requestedRouteIds = new Set(
    String(req.query?.route_ids || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );
  if (!stopCode) {
    return res.status(400).json({ error: 'Missing stop_code.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const upstream = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/x-protobuf, application/octet-stream',
        'User-Agent': 'GTSofia virtual boards'
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `Sofia Traffic GTFS-RT returned ${upstream.status}.`
      });
    }

    const body = await upstream.arrayBuffer();
    if (!body.byteLength) {
      return res.status(502).json({ error: 'Sofia Traffic GTFS-RT feed is empty.' });
    }

    const feed = decodeGtfsRealtimeFeed(body);
    const board = buildBoard(feed.updates, stopCode, feed.feedTimestamp);
    if (requestedRouteIds.size) {
      const tripRouteById = new Map(
        feed.updates.map(item => [
          String(item?.trip?.tripId || '').trim(),
          String(item?.trip?.routeId || '').trim()
        ])
      );
      board.active_trips = (board.active_trips || []).filter(item =>
        requestedRouteIds.has(String(item?.route_id || '').trim())
      );
      board.active_trip_ids = board.active_trips.map(item => String(item.trip_id || '').trim()).filter(Boolean);
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(board);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Sofia Traffic GTFS-RT request timed out.'
      : (error?.message || 'Unable to fetch/decode GTFS-RT.');

    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
};
