const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/vehicle-positions';
const FEED_TIMEOUT_MS = 15000;

const CURRENT_STATUS = Object.freeze({
  INCOMING_AT: 0,
  STOPPED_AT: 1,
  IN_TRANSIT_TO: 2
});

const CURRENT_STATUS_NAME = Object.freeze({
  [CURRENT_STATUS.INCOMING_AT]: 'Пристига на спирка',
  [CURRENT_STATUS.STOPPED_AT]: 'На спирката',
  [CURRENT_STATUS.IN_TRANSIT_TO]: 'В движение'
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

function decodeFloat32(bytes) {
  if (bytes.length !== 4) throw new Error('Invalid float32 field.');
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  ).getFloat32(0, true);
}

function decodeTripDescriptor(bytes) {
  const state = { index: 0 };
  const trip = {
    tripId: '',
    routeId: '',
    directionId: '',
    startTime: '',
    startDate: '',
    scheduleRelationship: 0
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

function decodeVehicleDescriptor(bytes) {
  const state = { index: 0 };
  const vehicle = {
    id: '',
    label: '',
    licensePlate: ''
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      vehicle.id = decodeString(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      vehicle.label = decodeString(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      vehicle.licensePlate = decodeString(field.value);
    }
  }

  return vehicle;
}

function decodePosition(bytes) {
  const state = { index: 0 };
  const position = {
    latitude: null,
    longitude: null,
    bearing: null,
    speed: null
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 5) {
      position.latitude = decodeFloat32(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 5) {
      position.longitude = decodeFloat32(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 5) {
      position.bearing = decodeFloat32(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 5) {
      position.speed = decodeFloat32(field.value);
    }
  }

  return position;
}

function decodeVehiclePosition(bytes) {
  const state = { index: 0 };
  const result = {
    trip: null,
    vehicle: null,
    position: null,
    currentStopSequence: null,
    currentStopId: '',
    currentStatus: null,
    timestamp: null
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.trip = decodeTripDescriptor(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      result.position = decodePosition(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 0) {
      result.currentStopSequence = Number(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2) {
      result.currentStopId = decodeString(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 0) {
      result.currentStatus = Number(field.value);
    } else if (field.fieldNumber === 6 && field.wireType === 0) {
      const raw = field.value;
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) {
        result.timestamp = Number(raw);
      }
    } else if (field.fieldNumber === 8 && field.wireType === 2) {
      result.vehicle = decodeVehicleDescriptor(field.value);
    }
  }

  return result;
}

function decodeFeedHeader(bytes) {
  const state = { index: 0 };
  let timestamp = null;

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 3 && field.wireType === 0) {
      const raw = field.value;
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) timestamp = Number(raw);
    }
  }

  return timestamp;
}

function decodeFeedEntity(bytes) {
  const state = { index: 0 };
  const entity = {
    id: '',
    isDeleted: false,
    vehicle: null
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      entity.id = decodeString(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      entity.isDeleted = Boolean(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2) {
      entity.vehicle = decodeVehiclePosition(field.value);
    }
  }

  return entity;
}

function decodeVehiclePositionsFeed(buffer) {
  const bytes = new Uint8Array(buffer);
  const state = { index: 0 };
  const vehicles = [];
  let feedTimestamp = null;

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      feedTimestamp = decodeFeedHeader(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      const entity = decodeFeedEntity(field.value);
      if (entity.vehicle && !entity.isDeleted) {
        vehicles.push({
          entityId: entity.id,
          ...entity.vehicle
        });
      }
    }
  }

  return {
    vehicles,
    feedTimestamp: feedTimestamp || Math.floor(Date.now() / 1000)
  };
}

function normalizeVehicle(vehicle, feedTimestamp) {
  const position = vehicle.position || {};
  const trip = vehicle.trip || {};
  const descriptor = vehicle.vehicle || {};

  const latitude = Number(position.latitude);
  const longitude = Number(position.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const currentStatus = Number(vehicle.currentStatus);
  const timestamp = Number(vehicle.timestamp);

  return {
    id: String(descriptor.id || vehicle.entityId || '').trim(),
    label: String(descriptor.label || '').trim(),
    license_plate: String(descriptor.licensePlate || '').trim(),
    trip_id: String(trip.tripId || '').trim(),
    route_id: String(trip.routeId || '').trim(),
    direction_id: String(trip.directionId || '').trim(),
    start_time: String(trip.startTime || '').trim(),
    start_date: String(trip.startDate || '').trim(),
    latitude,
    longitude,
    bearing: Number.isFinite(Number(position.bearing)) ? Number(position.bearing) : null,
    speed: Number.isFinite(Number(position.speed)) ? Number(position.speed) : null,
    current_stop_sequence: Number.isFinite(Number(vehicle.currentStopSequence))
      ? Number(vehicle.currentStopSequence)
      : null,
    current_stop_id: String(vehicle.currentStopId || '').trim(),
    current_status: Number.isFinite(currentStatus) ? currentStatus : null,
    current_status_name: CURRENT_STATUS_NAME[currentStatus] || 'Статусът не е указан',
    timestamp: Number.isFinite(timestamp) ? timestamp : feedTimestamp
  };
}

function buildResponse(feed) {
  const byVehicle = new Map();

  for (const rawVehicle of feed.vehicles || []) {
    const vehicle = normalizeVehicle(rawVehicle, feed.feedTimestamp);
    if (!vehicle) continue;

    const key = vehicle.id || `${vehicle.trip_id}|${vehicle.latitude}|${vehicle.longitude}`;
    const existing = byVehicle.get(key);

    if (!existing || Number(vehicle.timestamp) >= Number(existing.timestamp)) {
      byVehicle.set(key, vehicle);
    }
  }

  const vehicles = [...byVehicle.values()];

  return {
    status: vehicles.length ? 'ok' : 'empty',
    generated_at: feed.feedTimestamp,
    vehicles
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);

  try {
    const upstream = await fetch(FEED_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/x-protobuf, application/octet-stream',
        'User-Agent': 'GTSofia realtime map'
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `Sofia Traffic GTFS-RT returned ${upstream.status}.`
      });
    }

    const body = await upstream.arrayBuffer();
    if (!body.byteLength) {
      return res.status(502).json({
        error: 'Sofia Traffic GTFS-RT vehicle positions feed is empty.'
      });
    }

    const feed = decodeVehiclePositionsFeed(body);
    const payload = buildResponse(feed);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.status(200).json(payload);
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Sofia Traffic GTFS-RT vehicle positions request timed out.'
      : (error?.message || 'Unable to fetch/decode GTFS-RT vehicle positions.');

    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
};
