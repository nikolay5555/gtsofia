const path = require('node:path');
const fs = require('node:fs');

const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const FEED_TIMEOUT_MS = 15000;
const MAX_RESULTS_PER_ROUTE = 4;
const LOOK_AHEAD_SECONDS = 3 * 60 * 60;

const DATA_DIR = path.join(__dirname, '..', 'data');
const routes = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'routes.json'), 'utf8'));
const stops = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stops.json'), 'utf8'));
const directions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'directions.json'), 'utf8'));
const realtimeTripMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'realtime-trip-map.json'), 'utf8'));

const routeByCgmId = new Map(routes.map(route => [String(route.cgm_id), route]));
const stopByCode = new Map(stops.map(stop => [String(stop.code), stop]));
const directionByCode = new Map(directions.map(direction => [String(direction.code), direction]));

const TRIP_RELATIONSHIP = Object.freeze({
  SCHEDULED: 0,
  ADDED: 1,
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

  if (wireType === 0) return { fieldNumber, wireType, value: readVarint(bytes, state) };
  if (wireType === 1) {
    const end = state.index + 8;
    if (end > bytes.length) throw new Error('Truncated fixed64 field.');
    const value = bytes.subarray(state.index, end);
    state.index = end;
    return { fieldNumber, wireType, value };
  }
  if (wireType === 2) {
    const length = Number(readVarint(bytes, state));
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('Invalid protobuf length.');
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

function safeTimestamp(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function decodeTripDescriptor(bytes) {
  const state = { index: 0 };
  const trip = { tripId: '', routeId: '', directionId: '', startTime: '', startDate: '', scheduleRelationship: 0 };
  while (state.index < bytes.length) {
    const field = readField(bytes, state);
    if (field.fieldNumber === 1 && field.wireType === 2) trip.tripId = decodeString(field.value);
    else if (field.fieldNumber === 2 && field.wireType === 2) trip.startTime = decodeString(field.value);
    else if (field.fieldNumber === 3 && field.wireType === 2) trip.startDate = decodeString(field.value);
    else if (field.fieldNumber === 4 && field.wireType === 0) trip.scheduleRelationship = Number(field.value);
    else if (field.fieldNumber === 5 && field.wireType === 2) trip.routeId = decodeString(field.value);
    else if (field.fieldNumber === 6 && field.wireType === 0) trip.directionId = String(Number(field.value));
  }
  return trip;
}

function decodeStopTimeEvent(bytes) {
  const state = { index: 0 };
  const event = { delay: null, time: null, scheduledTime: null };
  while (state.index < bytes.length) {
    const field = readField(bytes, state);
    if (field.fieldNumber === 1 && field.wireType === 0) event.delay = toSignedInt32(field.value);
    else if (field.fieldNumber === 2 && field.wireType === 0) event.time = safeTimestamp(field.value);
    else if (field.fieldNumber === 3 && field.wireType === 0) event.scheduledTime = safeTimestamp(field.value);
  }
  return event;
}

function decodeStopTimeUpdate(bytes) {
  const state = { index: 0 };
  const update = { stopSequence: null, stopId: '', arrival: null, departure: null, scheduleRelationship: 0 };
  while (state.index < bytes.length) {
    const field = readField(bytes, state);
    if (field.fieldNumber === 1 && field.wireType === 0) update.stopSequence = Number(field.value);
    else if (field.fieldNumber === 2 && field.wireType === 2) update.arrival = decodeStopTimeEvent(field.value);
    else if (field.fieldNumber === 3 && field.wireType === 2) update.departure = decodeStopTimeEvent(field.value);
    else if (field.fieldNumber === 4 && field.wireType === 2) update.stopId = decodeString(field.value);
    else if (field.fieldNumber === 5 && field.wireType === 0) update.scheduleRelationship = Number(field.value);
  }
  return update;
}

function decodeTripProperties(bytes) {
  const state = { index: 0 };
  const result = { tripId: '', startDate: '', startTime: '' };
  while (state.index < bytes.length) {
    const field = readField(bytes, state);
    if (field.fieldNumber === 1 && field.wireType === 2) result.tripId = decodeString(field.value);
    else if (field.fieldNumber === 2 && field.wireType === 2) result.startDate = decodeString(field.value);
    else if (field.fieldNumber === 3 && field.wireType === 2) result.startTime = decodeString(field.value);
  }
  return result;
}

function decodeTripUpdate(bytes) {
  const state = { index: 0 };
  const result = { trip: null, stopTimeUpdates: [], timestamp: null, tripProperties: null };
  while (state.index < bytes.length) {
    const field = readField(bytes, state);
    if (field.fieldNumber === 1 && field.wireType === 2) result.trip = decodeTripDescriptor(field.value);
    else if (field.fieldNumber === 2 && field.wireType === 2) result.stopTimeUpdates.push(decodeStopTimeUpdate(field.value));
    else if (field.fieldNumber === 4 && field.wireType === 0) result.timestamp = safeTimestamp(field.value);
    else if (field.fieldNumber === 6 && field.wireType === 2) result.tripProperties = decodeTripProperties(field.value);
  }
  return result;
}

function decodeFeedEntity(bytes) {
  const state = { index: 0 };
  const entity = { id: '', tripUpdate: null };
  while (state.index < bytes.length) {
    const field = readField(bytes, state);
    if (field.fieldNumber === 1 && field.wireType === 2) entity.id = decodeString(field.value);
    else if (field.fieldNumber === 2 && field.wireType === 0) entity.isDeleted = Boolean(field.value);
    else if (field.fieldNumber === 3 && field.wireType === 2) entity.tripUpdate = decodeTripUpdate(field.value);
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
        if (headerField.fieldNumber === 3 && headerField.wireType === 0) feedTimestamp = safeTimestamp(headerField.value);
      }
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      const entity = decodeFeedEntity(field.value);
      if (entity.tripUpdate?.trip) updates.push(entity.tripUpdate);
    }
  }
  return { updates, feedTimestamp: feedTimestamp || Math.floor(Date.now() / 1000) };
}

function canonicalStopCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^M/i.test(raw)) return `M${raw.slice(1)}`;
  const digits = raw.replace(/\D/g, '');
  return digits ? digits.padStart(4, '0') : raw;
}

function routeSubtype(route) {
  const ref = String(route?.route_ref || '').trim().toUpperCase();
  if (ref.startsWith('N')) return 'night';
  if (ref.startsWith('У')) return 'school';
  if ((ref.endsWith('ТБ') || ref.endsWith('ТМ') || ref.startsWith('M')) && route?.type === 'bus') return 'temporary';
  return null;
}

function getTimestamp(stopUpdate) {
  if (Number.isFinite(stopUpdate?.arrival?.time)) return stopUpdate.arrival.time;
  if (Number.isFinite(stopUpdate?.departure?.time)) return stopUpdate.departure.time;
  return null;
}

function getScheduledTimestamp(stopUpdate) {
  if (Number.isFinite(stopUpdate?.arrival?.scheduledTime)) return stopUpdate.arrival.scheduledTime;
  if (Number.isFinite(stopUpdate?.departure?.scheduledTime)) return stopUpdate.departure.scheduledTime;
  return null;
}

function getDestination(routeInfo, trip, tripUpdate) {
  const directionCode = routeInfo?.direction_code ?? trip?.directionId ?? '';
  const direction = directionByCode.get(String(directionCode));
  const terminalCode = direction?.stops?.at(-1);
  const staticStop = terminalCode ? stopByCode.get(String(terminalCode)) : null;
  const staticName = staticStop?.names?.bg;
  if (staticName) return staticName;
  const terminalUpdate = (tripUpdate?.stopTimeUpdates || [])
    .filter(update => canonicalStopCode(update?.stopId))
    .sort((a, b) => Number(b?.stopSequence ?? -1) - Number(a?.stopSequence ?? -1))[0];
  const fallbackStop = terminalUpdate ? stopByCode.get(canonicalStopCode(terminalUpdate.stopId)) : null;
  return fallbackStop?.names?.bg || trip?.tripHeadsign || routeInfo?.trip_headsign || '—';
}

function makeExtras(routeInfo) {
  const wheelchair = routeInfo?.wheelchair_accessible === '1' ? '1' : '0';
  const bike = routeInfo?.bikes_allowed === '1' ? '1' : '0';
  return `0${wheelchair}${bike}`;
}

function routeForTrip(trip) {
  return realtimeTripMap[String(trip?.tripId || '')] || null;
}

function buildBoard(updates, stopCode, feedTimestamp, nowSeconds = Math.floor(Date.now() / 1000)) {
  const target = canonicalStopCode(stopCode);
  const grouped = new Map();

  for (const tripUpdate of updates || []) {
    const trip = tripUpdate?.trip;
    if (!trip) continue;
    const relationship = Number(trip.scheduleRelationship ?? TRIP_RELATIONSHIP.SCHEDULED);
    if (relationship === TRIP_RELATIONSHIP.CANCELED || relationship === TRIP_RELATIONSHIP.DELETED) continue;

    const routeInfo = routeForTrip(trip) || {
      route_id: String(trip.routeId || '').trim(),
      direction_code: trip.directionId || '',
      trip_headsign: ''
    };
    const route = routeByCgmId.get(String(routeInfo.route_id || trip.routeId || '').trim());
    if (!route) continue;

    for (const stopUpdate of tripUpdate.stopTimeUpdates || []) {
      const stopRelationship = Number(stopUpdate.scheduleRelationship ?? STOP_RELATIONSHIP.SCHEDULED);
      if (stopRelationship === STOP_RELATIONSHIP.SKIPPED || stopRelationship === STOP_RELATIONSHIP.NO_DATA) continue;
      if (canonicalStopCode(stopUpdate.stopId) !== target) continue;

      const timestamp = getTimestamp(stopUpdate);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < nowSeconds - 60 || timestamp > nowSeconds + LOOK_AHEAD_SECONDS) continue;

      const destination = getDestination(routeInfo, trip, tripUpdate);
      const key = `${route.cgm_id}|${destination}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          route_id: route.cgm_id,
          direction_id: routeInfo.direction_code || '',
          destination_stop_id: directionByCode.get(String(routeInfo.direction_code || ''))?.stops?.at(-1) || '',
          route_ref: route.route_ref,
          type: route.type,
          subtype: routeSubtype(route),
          bg_color: route.bg_color || null,
          text_color: route.text_color || null,
          destination,
          times: [],
          _route_sort: String(route.route_ref),
          _logical_key: key
        });
      }
      grouped.get(key).times.push({
        t: Math.max(0, Math.round((timestamp - nowSeconds) / 60)),
        extras: makeExtras(routeInfo),
        _timestamp: timestamp,
        _scheduled_time: getScheduledTimestamp(stopUpdate)
      });
    }
  }

  return [...grouped.values()]
    .map(route => ({
      route_id: route.route_id,
      direction_id: route.direction_id,
      destination_stop_id: route.destination_stop_id,
      route_ref: route.route_ref,
      type: route.type,
      subtype: route.subtype,
      destination: route.destination,
      times: route.times
        .sort((a, b) => a._timestamp - b._timestamp)
        .slice(0, MAX_RESULTS_PER_ROUTE)
        .map(item => ({ t: item.t, extras: item.extras }))
    }))
    .filter(route => route.times.length)
    .sort((a, b) => (a.times[0]?.t ?? Infinity) - (b.times[0]?.t ?? Infinity));
}

async function fetchRealtimeFeed(signal) {
  const upstream = await fetch(FEED_URL, {
    signal,
    headers: {
      Accept: 'application/x-protobuf, application/octet-stream',
      'User-Agent': 'GTSofia virtual boards'
    }
  });
  if (!upstream.ok) throw new Error(`Sofia Traffic GTFS-RT returned ${upstream.status}.`);
  const body = await upstream.arrayBuffer();
  if (!body.byteLength) throw new Error('Sofia Traffic GTFS-RT feed is empty.');
  return decodeGtfsRealtimeFeed(body);
}

function jsonResponse(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  return res.status(status).json(payload);
}

async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stopCode = String(req.query?.stop_code || '').trim();
  if (!stopCode) return res.status(400).json({ error: 'Missing stop_code.' });
  const canonical = canonicalStopCode(stopCode);
  if (!stopByCode.has(canonical)) return res.status(404).json({ error: 'Unknown stop_code.' });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const feed = await fetchRealtimeFeed(controller.signal);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const routes = buildBoard(feed.updates, canonical, feed.feedTimestamp, nowSeconds);
    const realtimeRouteIds = [...new Set(
      (feed.updates || [])
        .filter(update => {
          const relationship = Number(update?.trip?.scheduleRelationship ?? TRIP_RELATIONSHIP.SCHEDULED);
          return relationship !== TRIP_RELATIONSHIP.CANCELED && relationship !== TRIP_RELATIONSHIP.DELETED;
        })
        .map(update => String(update?.trip?.routeId || '').trim())
        .filter(Boolean)
    )];
    const activeTrips = (feed.updates || [])
      .filter(update => {
        const relationship = Number(update?.trip?.scheduleRelationship ?? TRIP_RELATIONSHIP.SCHEDULED);
        return Boolean(update?.trip?.tripId) && relationship !== TRIP_RELATIONSHIP.CANCELED && relationship !== TRIP_RELATIONSHIP.DELETED;
      })
      .map(update => ({
        trip_id: String(update.trip.tripId),
        route_id: String(update.trip.routeId || ''),
        direction_id: String(update.trip.directionId || ''),
        schedule_relationship_name: relationshipName(update.trip.scheduleRelationship)
      }));
    const skippedTrips = [];
    for (const update of feed.updates || []) {
      if (!update?.trip?.tripId) continue;
      for (const stopUpdate of update.stopTimeUpdates || []) {
        const relationship = Number(stopUpdate?.scheduleRelationship);
        if (relationship !== STOP_RELATIONSHIP.SKIPPED) continue;
        skippedTrips.push({
          trip_id: String(update.trip.tripId),
          route_id: String(update.trip.routeId || ''),
          direction_id: String(update.trip.directionId || ''),
          stop_id: String(stopUpdate.stopId || ''),
          stop_sequence: Number.isFinite(Number(stopUpdate.stopSequence)) ? Number(stopUpdate.stopSequence) : null,
          start_time: String(update.tripProperties?.startTime || ''),
          schedule_relationship_name: relationshipName(relationship)
        });
      }
    }

    return jsonResponse(res, 200, {
      status: routes.length ? 'ok' : 'empty',
      stop_code: canonical,
      generated_at: new Date(feed.feedTimestamp * 1000).toISOString(),
      now_timestamp: nowSeconds,
      realtime_route_ids: realtimeRouteIds,
      active_trips: activeTrips,
      skipped_trips: skippedTrips,
      routes
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Sofia Traffic GTFS-RT request timed out.'
      : (error?.message || 'Unable to fetch/decode GTFS-RT.');
    return jsonResponse(res, 502, { error: message });
  } finally {
    clearTimeout(timeout);
  }
}

handler.__test = { canonicalStopCode, routeSubtype, buildBoard, decodeGtfsRealtimeFeed };
module.exports = handler;
