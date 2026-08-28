const SOFIA_GTFS_RT_TRIP_UPDATES_URL =
  "https://gtfs.sofiatraffic.bg/api/v1/trip-updates";

function readVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < bytes.length) {
    const b = bytes[state.offset++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 70n) throw new Error("Invalid protobuf varint");
  }
  throw new Error("Unexpected end of protobuf varint");
}

function readLengthDelimited(bytes, state) {
  const length = Number(readVarint(bytes, state));
  const end = state.offset + length;
  if (end > bytes.length) throw new Error("Invalid protobuf length");
  const value = bytes.subarray(state.offset, end);
  state.offset = end;
  return value;
}

function readFields(bytes) {
  const state = { offset: 0 };
  const fields = [];
  while (state.offset < bytes.length) {
    const tag = Number(readVarint(bytes, state));
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;
    if (!fieldNumber) throw new Error("Invalid protobuf field");

    if (wireType === 0) {
      fields.push({ fieldNumber, wireType, value: readVarint(bytes, state) });
    } else if (wireType === 2) {
      fields.push({ fieldNumber, wireType, value: readLengthDelimited(bytes, state) });
    } else if (wireType === 1) {
      state.offset += 8;
      if (state.offset > bytes.length) throw new Error("Invalid protobuf fixed64");
    } else if (wireType === 5) {
      state.offset += 4;
      if (state.offset > bytes.length) throw new Error("Invalid protobuf fixed32");
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
  }
  return fields;
}

const textDecoder = new TextDecoder();
function decodeString(bytes) {
  return textDecoder.decode(bytes);
}

function parseTripDescriptor(bytes) {
  let tripId = "";
  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      tripId = decodeString(field.value);
    }
  }
  return { tripId };
}

function parseStopTimeEvent(bytes) {
  let delay = null;
  let time = null;
  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      const u = Number(field.value & 0xffffffffn);
      delay = u | 0;
    } else if (field.fieldNumber === 2 && field.wireType === 0) {
      time = field.value;
    }
  }
  return { delay, time };
}

function parseStopTimeUpdate(bytes) {
  let stopId = "";
  let arrival = null;
  let departure = null;
  let stopSequence = null;

  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 0) {
      stopSequence = Number(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      stopId = decodeString(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      arrival = parseStopTimeEvent(field.value);
    } else if (field.fieldNumber === 4 && field.wireType === 2) {
      departure = parseStopTimeEvent(field.value);
    }
  }

  return { stopId, stopSequence, arrival, departure };
}

function parseTripUpdate(bytes) {
  let trip = null;
  const stopTimeUpdates = [];

  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      trip = parseTripDescriptor(field.value);
    } else if (field.fieldNumber === 2 && field.wireType === 2) {
      stopTimeUpdates.push(parseStopTimeUpdate(field.value));
    }
  }

  return { trip, stopTimeUpdates };
}

function parseFeedEntity(bytes) {
  let id = "";
  let tripUpdate = null;

  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 1 && field.wireType === 2) {
      id = decodeString(field.value);
    } else if (field.fieldNumber === 3 && field.wireType === 2) {
      tripUpdate = parseTripUpdate(field.value);
    }
  }

  return { id, tripUpdate };
}

function parseFeedMessage(bytes) {
  const tripUpdates = [];
  for (const field of readFields(bytes)) {
    if (field.fieldNumber === 2 && field.wireType === 2) {
      const entity = parseFeedEntity(field.value);
      if (entity.tripUpdate) tripUpdates.push(entity.tripUpdate);
    }
  }
  return tripUpdates;
}

function gtfsRtUnixSecondsToDate(value) {
  if (value == null) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  return new Date(seconds * 1000);
}

export async function fetchSofiaTripUpdates() {
  const response = await fetch(SOFIA_GTFS_RT_TRIP_UPDATES_URL, {
    cache: "no-store",
    mode: "cors"
  });
  if (!response.ok) {
    throw new Error(`GTFS-RT HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  return parseFeedMessage(new Uint8Array(buffer));
}

export function buildRealtimeIndex(tripUpdates) {
  const index = new Map();

  for (const update of tripUpdates || []) {
    const tripId = update?.trip?.tripId;
    if (!tripId) continue;

    const stops = new Map();
    for (const stop of update.stopTimeUpdates || []) {
      if (!stop.stopId) continue;
      const event = stop.arrival?.time != null
        ? stop.arrival
        : stop.departure;
      if (!event) continue;

      stops.set(String(stop.stopId), {
        time: gtfsRtUnixSecondsToDate(event.time),
        delay: event.delay,
        hasExplicitTime: event.time != null
      });
    }

    index.set(String(tripId), stops);
  }

  return index;
}
