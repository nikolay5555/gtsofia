const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/vehicle-positions';
const FEED_TIMEOUT_MS = 15000;

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
  if (bytes.length !== 4) return null;
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(0, true);
}

function decodeVehicleDescriptor(bytes) {
  const state = { index: 0 };
  const vehicle = { id: '', label: '', licensePlate: '' };

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

function decodeTripDescriptor(bytes) {
  const state = { index: 0 };
  const trip = {
    tripId: '',
    routeId: '',
    directionId: '',
    startTime: '',
    startDate: ''
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      trip.tripId = decodeString(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      trip.startTime = decodeString(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      trip.startDate = decodeString(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 2) {
      trip.routeId = decodeString(field.value);
    } else if (field.fieldNumber === 6 && field.wireType === 0) {
      trip.directionId = String(Number(field.value));
    }
  }

  return trip;
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

    if (field.wireType !== 5) continue;

    if (field.fieldNumber === 1) {
      position.latitude = decodeFloat32(field.value);
    } else if (field.fieldNumber === 2) {
      position.longitude = decodeFloat32(field.value);
    } else if (field.fieldNumber === 3) {
      position.bearing = decodeFloat32(field.value);
    } else if (field.fieldNumber === 5) {
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
    currentStatus: null,
    timestamp: null,
    stopId: ''
  };

  while (state.index < bytes.length) {
    const field = readField(bytes, state);

    if (field.fieldNumber === 1 && field.wireType === 2) {
      result.trip = decodeTripDescriptor(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      result.vehicle = decodeVehicleDescriptor(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      result.position = decodePosition(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 0) {
      result.currentStopSequence = Number(field.value);
    } else if (field.fieldNumber === 5 && field.wireType === 0) {
      result.currentStatus = Number(field.value);
    } else if (field.fieldNumber === 6 && field.wireType === 0) {
      const raw = field.value;
      if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) result.timestamp = Number(raw);
    } else if (field.fieldNumber === 7 && field.wireType === 2) {
      result.stopId = decodeString(field.value);
    }
  }

  return result;
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

function decodeGtfsRealtimeFeed(buffer) {
  const bytes = new Uint8Array(buffer);
  const state = { index: 0 };
  const vehicles = [];
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
      if (entity.vehicle?.position) vehicles.push(entity.vehicle);
    }
  }

  return {
    vehicles,
    feedTimestamp: feedTimestamp || Math.floor(Date.now() / 1000)
  };
}

function isValidPosition(position) {
  return Number.isFinite(position?.latitude)
    && Number.isFinite(position?.longitude)
    && position.latitude >= -90
    && position.latitude <= 90
    && position.longitude >= -180
    && position.longitude <= 180;
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
        'User-Agent': 'GTSofia vehicle map'
      }
    });

    if (!upstream.ok) {
      return res.status(502).json({
        error: `Sofia Traffic GTFS-RT returned ${upstream.status}.`
      });
    }

    const body = await upstream.arrayBuffer();
    if (!body.byteLength) {
      return res.status(502).json({ error: 'Sofia Traffic vehicle-position feed is empty.' });
    }

    const feed = decodeGtfsRealtimeFeed(body);
    const vehicles = feed.vehicles
      .filter(vehicle => isValidPosition(vehicle.position))
      .map(vehicle => ({
        vehicle_id: String(vehicle.vehicle?.id || '').trim(),
        vehicle_label: String(vehicle.vehicle?.label || '').trim(),
        license_plate: String(vehicle.vehicle?.licensePlate || '').trim(),
        trip_id: String(vehicle.trip?.tripId || '').trim(),
        route_id: String(vehicle.trip?.routeId || '').trim(),
        direction_id: String(vehicle.trip?.directionId || '').trim(),
        start_time: String(vehicle.trip?.startTime || '').trim(),
        start_date: String(vehicle.trip?.startDate || '').trim(),
        latitude: vehicle.position.latitude,
        longitude: vehicle.position.longitude,
        bearing: Number.isFinite(vehicle.position.bearing) ? vehicle.position.bearing : null,
        speed_mps: Number.isFinite(vehicle.position.speed) ? vehicle.position.speed : null,
        current_stop_sequence: Number.isFinite(vehicle.currentStopSequence)
          ? vehicle.currentStopSequence
          : null,
        current_status: Number.isFinite(vehicle.currentStatus)
          ? vehicle.currentStatus
          : null,
        stop_id: String(vehicle.stopId || '').trim(),
        timestamp: Number.isFinite(vehicle.timestamp) ? vehicle.timestamp : feed.feedTimestamp
      }));

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json({
      status: vehicles.length ? 'ok' : 'empty',
      generated_at: feed.feedTimestamp,
      vehicles
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'Sofia Traffic vehicle-position request timed out.'
      : (error?.message || 'Unable to fetch/decode vehicle-position GTFS-RT.');

    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
};
