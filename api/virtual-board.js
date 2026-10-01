const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const FEED_TIMEOUT_MS = 15000;
const MAX_RESULTS_PER_ROUTE = 4;
const LOOK_AHEAD_SECONDS = 3 * 60 * 60;
const STATIC_TRANSPORT_DATA = require('../data/transport.json');

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
  const result = { trip: null, stopTimeUpdates: [], timestamp: null, delay: null, tripProperties: null };

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

function parseGtfsTime(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split(':');
  if (parts.length !== 3) return null;
  const [hour, minute, second] = parts.map(Number);
  if (![hour, minute, second].every(Number.isFinite)) return null;
  return hour * 3600 + minute * 60 + second;
}

function getSofiaDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Sofia',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value || '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day'))
  };
}

function parseGtfsServiceDate(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{8}$/.test(raw)) return null;
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(4, 6));
  const day = Number(raw.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function getSofiaOffsetMs(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Sofia',
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const raw = parts.find(part => part.type === 'timeZoneName')?.value || 'GMT+0';
  const match = raw.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === '+' ? 1 : -1;
  return sign * (Number(match[2]) * 60 + Number(match[3] || 0)) * 60 * 1000;
}

function gtfsSecondsToTimestamp(seconds, serviceDate = null) {
  if (!Number.isFinite(Number(seconds))) return null;

  const date = serviceDate ? parseGtfsServiceDate(serviceDate) : new Date();
  const parts = serviceDate
    ? { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() }
    : getSofiaDateParts();
  if (![parts.year, parts.month, parts.day].every(Number.isFinite)) return null;

  const baseUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  return (baseUtc + Number(seconds) * 1000 - getSofiaOffsetMs(new Date(baseUtc))) / 1000;
}

function buildStaticRealtimeIndex(data = STATIC_TRANSPORT_DATA) {
  const tripsById = new Map();
  for (const trip of data?.trips || []) {
    const tripId = String(trip?.trip_id || '').trim();
    if (tripId) tripsById.set(tripId, trip);
  }

  const scheduleByOriginalTripId = new Map();
  const directions = data?.directions || {};
  const schedules = data?.schedules || {};

  for (const [routeId, directionSet] of Object.entries(schedules)) {
    const routeDirections = directions?.[routeId] || {};
    for (const [directionKey, daySet] of Object.entries(directionSet || {})) {
      const direction = routeDirections?.[directionKey] || {};
      const pattern = Array.isArray(direction?.pattern)
        ? direction.pattern.map(String)
        : [];

      for (const dayType of ['weekday', 'weekend']) {
        for (const row of Array.isArray(daySet?.[dayType]) ? daySet[dayType] : []) {
          const originalTripId = String(row?.original_trip_id || '').trim();
          if (!originalTripId) continue;
          if (scheduleByOriginalTripId.has(originalTripId)) continue;

          const staticTrip = tripsById.get(originalTripId);
          scheduleByOriginalTripId.set(originalTripId, {
            route_id: String(routeId),
            direction_key: String(directionKey),
            pattern,
            times: Array.isArray(row?.times) ? row.times : [],
            stop_sequences: Array.isArray(row?.stop_sequences) ? row.stop_sequences : [],
            service_id: String(row?.service_id || staticTrip?.service_id || '').trim(),
            start_time: String(row?.start_time || '').trim()
          });
        }
      }
    }
  }

  return { tripsById, scheduleByOriginalTripId };
}

const STATIC_REALTIME_INDEX = buildStaticRealtimeIndex();

function resolveStaticStopIndex(row, stopCode) {
  const target = normalizeStopKey(stopCode);
  if (!target || !Array.isArray(row?.pattern)) return -1;

  const candidates = [];
  for (let index = 0; index < row.pattern.length; index++) {
    if (!stopIdsMatch(row.pattern[index], target)) continue;
    if (parseGtfsTime(row.times?.[index]) == null) continue;
    candidates.push(index);
  }

  if (!candidates.length) return -1;
  return candidates[0];
}

function resolveStaticUpdateIndex(row, stopUpdate) {
  if (!row) return -1;

  const stopSequence = Number(stopUpdate?.stopSequence);
  if (Number.isFinite(stopSequence) && Array.isArray(row.stop_sequences)) {
    const sequenceIndex = row.stop_sequences.findIndex(value => Number(value) === stopSequence);
    if (sequenceIndex >= 0) return sequenceIndex;
  }

  const stopId = String(stopUpdate?.stopId || '').trim();
  if (!stopId || !Array.isArray(row.pattern)) return -1;
  return row.pattern.findIndex(value => stopIdsMatch(value, stopId));
}

function getStaticEventDelaySeconds(row, index, stopUpdate, serviceDate = null) {
  const explicitDelay = eventDelay(stopUpdate);
  if (Number.isFinite(explicitDelay)) return explicitDelay;

  const eventTime = eventTimestamp(stopUpdate);
  if (!Number.isFinite(eventTime)) return null;

  const scheduledSeconds = parseGtfsTime(row?.times?.[index]);
  if (scheduledSeconds == null) return null;

  // The feed's absolute timestamp is authoritative. Prefer the realtime
  // trip's start_date so post-midnight trips are compared with the correct
  // GTFS service date; fall back to the current Sofia date only when the
  // producer omits start_date.
  const serviceDayTimestamp = gtfsSecondsToTimestamp(scheduledSeconds, serviceDate);
  if (!Number.isFinite(serviceDayTimestamp)) return null;
  return eventTime - serviceDayTimestamp;
}

function predictTripArrivalAtStop(tripUpdate, stopCode, staticIndex = STATIC_REALTIME_INDEX) {
  const trip = tripUpdate?.trip;
  const tripId = String(trip?.tripId || '').trim();
  if (!tripId) return null;

  const row = staticIndex?.scheduleByOriginalTripId?.get(tripId);
  if (!row) return null;

  const targetIndex = resolveStaticStopIndex(row, stopCode);
  if (targetIndex < 0) return null;

  const targetScheduledSeconds = parseGtfsTime(row.times?.[targetIndex]);
  if (targetScheduledSeconds == null) return null;

  const serviceDate = String(trip?.startDate || '').trim() || null;
  const targetScheduledTimestamp = gtfsSecondsToTimestamp(targetScheduledSeconds, serviceDate);
  if (!Number.isFinite(targetScheduledTimestamp)) return null;

  // TripUpdate.delay applies to subsequent stops until a StopTimeUpdate
  // provides a more specific delay value. The realtime spec defines this as
  // a propagation mechanism for trips whose feed does not repeat the delay
  // at every stop.
  let propagatedDelay = Number.isFinite(Number(tripUpdate?.delay))
    ? Number(tripUpdate.delay)
    : null;
  const updates = [...(tripUpdate?.stopTimeUpdates || [])]
    .map((update, order) => ({ update, order, index: resolveStaticUpdateIndex(row, update) }))
    .filter(item => item.index >= 0 && item.index <= targetIndex)
    .sort((left, right) => left.index - right.index || left.order - right.order);

  for (const item of updates) {
    const update = item.update;
    const relationship = Number.isFinite(Number(update?.scheduleRelationship))
      ? Number(update.scheduleRelationship)
      : STOP_RELATIONSHIP.SCHEDULED;

    if (item.index === targetIndex) {
      if (relationship === STOP_RELATIONSHIP.SKIPPED) {
        return { status: 'skipped', index: targetIndex };
      }
      if (relationship === STOP_RELATIONSHIP.NO_DATA) {
        return { status: 'no_data', index: targetIndex };
      }

      const explicitTimestamp = eventTimestamp(update);
      if (Number.isFinite(explicitTimestamp)) {
        return {
          status: 'arrival',
          timestamp: explicitTimestamp,
          delay: Number.isFinite(Number(eventDelay(update))) ? Number(eventDelay(update)) : null,
          scheduledTimestamp: Number.isFinite(Number(update?.arrival?.scheduledTime))
            ? Number(update.arrival.scheduledTime)
            : Number.isFinite(Number(update?.departure?.scheduledTime))
              ? Number(update.departure.scheduledTime)
              : targetScheduledTimestamp,
          inferred: false
        };
      }

      const directDelay = eventDelay(update);
      if (Number.isFinite(directDelay)) {
        return {
          status: 'arrival',
          timestamp: targetScheduledTimestamp + directDelay,
          delay: directDelay,
          scheduledTimestamp: targetScheduledTimestamp,
          inferred: true
        };
      }

      // An explicit SCHEDULED update without a timing event means that the
      // producer has no usable prediction for this stop. Do not invent one.
      return { status: 'no_data', index: targetIndex };
    }

    if (relationship === STOP_RELATIONSHIP.NO_DATA) {
      propagatedDelay = null;
      continue;
    }

    if (relationship === STOP_RELATIONSHIP.SKIPPED) {
      // Per GTFS-RT, SKIPPED does not stop delay propagation.
      continue;
    }

    propagatedDelay = getStaticEventDelaySeconds(row, item.index, update, serviceDate);
  }

  if (!Number.isFinite(Number(propagatedDelay))) return null;

  return {
    status: 'arrival',
    timestamp: targetScheduledTimestamp + Number(propagatedDelay),
    delay: Number(propagatedDelay),
    scheduledTimestamp: targetScheduledTimestamp,
    inferred: true
  };
}

function buildBoard(updates, stopCode, feedTimestamp, staticIndex = STATIC_REALTIME_INDEX) {
  const now = Math.floor(Date.now() / 1000);
  const target = normalizeStopKey(stopCode);
  const grouped = new Map();
  const skippedTrips = new Map();

  for (const tripUpdate of updates) {
    const trip = tripUpdate?.trip;
    if (!trip) continue;

    const tripRelationship = Number.isFinite(Number(trip.scheduleRelationship))
      ? Number(trip.scheduleRelationship)
      : TRIP_RELATIONSHIP.SCHEDULED;

    if (tripRelationship === TRIP_RELATIONSHIP.CANCELED
      || tripRelationship === TRIP_RELATIONSHIP.DELETED) {
      continue;
    }

    // Preserve explicit SKIPPED information for the requested stop so the
    // frontend can suppress the corresponding static course. stop_sequence is
    // retained because GTFS-RT permits it when stop_id is omitted.
    for (const stopUpdate of tripUpdate.stopTimeUpdates || []) {
      const stopRelationship = Number.isFinite(Number(stopUpdate?.scheduleRelationship))
        ? Number(stopUpdate.scheduleRelationship)
        : STOP_RELATIONSHIP.SCHEDULED;
      if (stopRelationship !== STOP_RELATIONSHIP.SKIPPED) continue;
      if (stopUpdate?.stopId && !stopIdsMatch(stopUpdate.stopId, target)) continue;
      if (!stopUpdate?.stopId && !Number.isFinite(Number(stopUpdate?.stopSequence))) continue;

      const skippedKey = [
        trip.tripId || '',
        trip.startDate || tripUpdate.tripProperties?.startDate || '',
        trip.startTime || tripUpdate.tripProperties?.startTime || '',
        trip.routeId || '',
        trip.directionId || '',
        stopUpdate.stopId
          ? normalizeStopKey(stopUpdate.stopId)
          : `seq:${Number(stopUpdate.stopSequence)}`
      ].join('|');

      if (!skippedTrips.has(skippedKey)) {
        skippedTrips.set(skippedKey, {
          trip_id: trip.tripId || '',
          start_date: trip.startDate || tripUpdate.tripProperties?.startDate || '',
          start_time: trip.startTime || tripUpdate.tripProperties?.startTime || '',
          route_id: trip.routeId || '',
          direction_id: trip.directionId || '',
          stop_id: stopUpdate.stopId || '',
          stop_sequence: Number.isFinite(Number(stopUpdate.stopSequence))
            ? Number(stopUpdate.stopSequence)
            : null,
          stop_schedule_relationship: stopRelationship,
          stop_schedule_relationship_name: STOP_RELATIONSHIP_NAME[stopRelationship] || `UNKNOWN_${stopRelationship}`
        });
      }
    }

    let prediction = predictTripArrivalAtStop(tripUpdate, stopCode, staticIndex);

    // Backward-compatible direct matching for realtime trips that are NEW/
    // REPLACEMENT or otherwise have no corresponding static GTFS trip.
    if (!prediction) {
      let directUpdate = null;
      for (const stopUpdate of tripUpdate.stopTimeUpdates || []) {
        if (!stopUpdate?.stopId || !stopIdsMatch(stopUpdate.stopId, target)) continue;
        const stopRelationship = Number.isFinite(Number(stopUpdate.scheduleRelationship))
          ? Number(stopUpdate.scheduleRelationship)
          : STOP_RELATIONSHIP.SCHEDULED;
        if (stopRelationship === STOP_RELATIONSHIP.SKIPPED
          || stopRelationship === STOP_RELATIONSHIP.NO_DATA) continue;
        if (!Number.isFinite(eventTimestamp(stopUpdate)) && !Number.isFinite(eventDelay(stopUpdate))) continue;
        directUpdate = stopUpdate;
        break;
      }

      if (directUpdate) {
        const explicitTimestamp = eventTimestamp(directUpdate);
        prediction = {
          status: 'arrival',
          timestamp: explicitTimestamp,
          delay: Number.isFinite(Number(eventDelay(directUpdate))) ? Number(eventDelay(directUpdate)) : null,
          scheduledTimestamp: Number.isFinite(Number(directUpdate?.arrival?.scheduledTime))
            ? Number(directUpdate.arrival.scheduledTime)
            : Number.isFinite(Number(directUpdate?.departure?.scheduledTime))
              ? Number(directUpdate.departure.scheduledTime)
              : null,
          inferred: false
        };
      }
    }

    if (!prediction || prediction.status !== 'arrival') continue;

    const timestamp = Number(prediction.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < now - 60) continue;
    if (timestamp > now + LOOK_AHEAD_SECONDS) continue;

    const routeId = String(trip.routeId || '').trim();
    const key = [
      trip.tripId || '',
      trip.startDate || tripUpdate.tripProperties?.startDate || '',
      trip.startTime || tripUpdate.tripProperties?.startTime || '',
      trip.routeId || '',
      trip.directionId || ''
    ].join('|');

    if (!grouped.has(key)) {
      const terminalUpdate = (tripUpdate.stopTimeUpdates || [])
        .filter(item => {
          if (!item?.stopId) return false;
          const relationship = Number.isFinite(Number(item.scheduleRelationship))
            ? Number(item.scheduleRelationship)
            : STOP_RELATIONSHIP.SCHEDULED;
          return relationship !== STOP_RELATIONSHIP.SKIPPED
            && relationship !== STOP_RELATIONSHIP.NO_DATA;
        })
        .sort((a, b) => {
          const sa = Number.isFinite(Number(a?.stopSequence)) ? Number(a.stopSequence) : -1;
          const sb = Number.isFinite(Number(b?.stopSequence)) ? Number(b.stopSequence) : -1;
          return sb - sa;
        })[0] || null;

      grouped.set(key, {
        trip_id: trip.tripId || '',
        trip_start_date: trip.startDate || tripUpdate.tripProperties?.startDate || '',
        trip_start_time: trip.startTime || tripUpdate.tripProperties?.startTime || '',
        route_id: routeId,
        direction_id: trip.directionId || '',
        schedule_relationship: tripRelationship,
        schedule_relationship_name: TRIP_RELATIONSHIP_NAME[tripRelationship] || `UNKNOWN_${tripRelationship}`,
        destination_stop_id: terminalUpdate?.stopId || '',
        times: []
      });
    }

    grouped.get(key).times.push({
      timestamp,
      delay: Number.isFinite(Number(prediction.delay)) ? Number(prediction.delay) : null,
      inferred: Boolean(prediction.inferred),
      stop_schedule_relationship: STOP_RELATIONSHIP.SCHEDULED,
      stop_schedule_relationship_name: STOP_RELATIONSHIP_NAME[STOP_RELATIONSHIP.SCHEDULED],
      scheduled_time: Number.isFinite(Number(prediction.scheduledTimestamp))
        ? Number(prediction.scheduledTimestamp)
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
    .sort((a, b) => a.times[0].timestamp - b.times[0].timestamp);

  const activeTrips = [];
  const seenActive = new Set();
  for (const update of updates || []) {
    const trip = update?.trip;
    if (!trip) continue;

    const relationship = Number.isFinite(Number(trip.scheduleRelationship))
      ? Number(trip.scheduleRelationship)
      : TRIP_RELATIONSHIP.SCHEDULED;
    if (relationship === TRIP_RELATIONSHIP.CANCELED
      || relationship === TRIP_RELATIONSHIP.DELETED) continue;

    const tripKey = [
      String(trip.tripId || ''),
      String(trip.startDate || update.tripProperties?.startDate || ''),
      String(trip.startTime || update.tripProperties?.startTime || ''),
      String(trip.routeId || ''),
      String(trip.directionId || '')
    ].join('|');
    if (seenActive.has(tripKey)) continue;
    seenActive.add(tripKey);

    activeTrips.push({
      trip_id: String(trip.tripId || ''),
      start_date: String(trip.startDate || update.tripProperties?.startDate || ''),
      start_time: String(trip.startTime || update.tripProperties?.startTime || ''),
      route_id: String(trip.routeId || ''),
      direction_id: String(trip.directionId || ''),
      schedule_relationship: relationship,
      schedule_relationship_name: TRIP_RELATIONSHIP_NAME[relationship] || `UNKNOWN_${relationship}`
    });
  }

  const realtimeRouteIds = [...new Set(
    (updates || [])
      .map(update => String(update?.trip?.routeId || '').trim())
      .filter(Boolean)
  )];

  return {
    status: routes.length ? 'ok' : 'empty',
    stop_code: String(stopCode),
    generated_at: feedTimestamp,
    realtime_route_ids: realtimeRouteIds,
    active_trips: activeTrips,
    skipped_trips: [...skippedTrips.values()],
    active_trip_ids: activeTrips.map(item => item.trip_id).filter(Boolean),
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

module.exports.buildBoard = buildBoard;
module.exports.buildStaticRealtimeIndex = buildStaticRealtimeIndex;
module.exports.predictTripArrivalAtStop = predictTripArrivalAtStop;
