const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const FEED_TIMEOUT_MS = 15000;
const MAX_RESULTS_PER_ROUTE = 4;
const LOOK_AHEAD_SECONDS = 3 * 60 * 60;

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
    scheduleRelationship: 0
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      trip.tripId = decodeString(field.value);
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
    scheduleRelationship: 0
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

function decodeTripUpdate(bytes) {
  const state = { index: 0 };
  const result = { trip: null, stopTimeUpdates: [], timestamp: null };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.trip = decodeTripDescriptor(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      result.stopTimeUpdates.push(decodeStopTimeUpdate(field.value));
    } else if (field.fieldNumber === 4 && field.wireType === 0) {
      const raw = field.value;
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) result.timestamp = Number(raw);
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
      if (entity.tripUpdate?.trip?.tripId) updates.push(entity.tripUpdate);
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

function buildBoard(updates, stopCode, feedTimestamp) {
  const now = Math.floor(Date.now() / 1000);
  const target = normalizeStopKey(stopCode);
  const grouped = new Map();

  for (const tripUpdate of updates) {
    const trip = tripUpdate?.trip;
    if (!trip?.tripId) continue;

    // SCHEDULED=0, SKIPPED=1, CANCELED=2, MODIFIED=3, DELETED=6.
    if ([1, 2, 6].includes(trip.scheduleRelationship)) continue;

    for (const stopUpdate of tripUpdate.stopTimeUpdates || []) {
      if (!stopUpdate?.stopId || !stopIdsMatch(stopUpdate.stopId, target)) continue;
      if ([1, 2].includes(stopUpdate.scheduleRelationship)) continue;

      const timestamp = eventTimestamp(stopUpdate);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < now - 60) continue;
      if (timestamp > now + LOOK_AHEAD_SECONDS) continue;

      const delay = eventDelay(stopUpdate);
      const key = `${trip.routeId}|${trip.directionId}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          trip_id: trip.tripId,
          route_id: trip.routeId || '',
          direction_id: trip.directionId || '',
          times: []
        });
      }

      grouped.get(key).times.push({
        timestamp,
        delay: Number.isFinite(delay) ? delay : null
      });
    }
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

  return {
    status: routes.length ? 'ok' : 'empty',
    stop_code: String(stopCode),
    generated_at: feedTimestamp,
    routes
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stopCode = String(req.query?.stop_code || '').trim();
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
