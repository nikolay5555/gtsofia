"use strict";

// Compact GTFS-Realtime protobuf decoder, kept separate from HTTP/API logic.
const TEXT_DECODER = new TextDecoder();

// GTFS-Realtime TripDescriptor.schedule_relationship.
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
  Object.fromEntries(
    Object.entries(TRIP_RELATIONSHIP)
      .map(([name, value]) => [value, name])
  )
);

const STOP_RELATIONSHIP_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(STOP_RELATIONSHIP)
      .map(([name, value]) => [value, name])
  )
);

function readVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;

  while (state.index < bytes.length) {
    const byte = bytes[state.index++];

    value |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return value;
    }

    shift += 7n;

    if (shift > 70n) {
      throw new Error('Invalid protobuf varint.');
    }
  }

  throw new Error('Truncated protobuf varint.');
}

function readField(bytes, state) {
  const tag = Number(readVarint(bytes, state));
  const fieldNumber = tag >>> 3;
  const wireType = tag & 7;

  if (!fieldNumber) {
    throw new Error('Invalid protobuf field number.');
  }

  if (wireType === 0) {
    return {
      fieldNumber,
      wireType,
      value: readVarint(bytes, state)
    };
  }

  if (wireType === 1) {
    const end = state.index + 8;

    if (end > bytes.length) {
      throw new Error('Truncated fixed64 field.');
    }

    const value = bytes.subarray(
      state.index,
      end
    );

    state.index = end;

    return {
      fieldNumber,
      wireType,
      value
    };
  }

  if (wireType === 2) {
    const length = Number(
      readVarint(bytes, state)
    );

    if (
      !Number.isSafeInteger(length)
      || length < 0
    ) {
      throw new Error('Invalid protobuf length.');
    }

    const end =
      state.index + length;

    if (end > bytes.length) {
      throw new Error(
        'Truncated length-delimited field.'
      );
    }

    const value = bytes.subarray(
      state.index,
      end
    );

    state.index = end;

    return {
      fieldNumber,
      wireType,
      value
    };
  }

  if (wireType === 5) {
    const end = state.index + 4;

    if (end > bytes.length) {
      throw new Error(
        'Truncated fixed32 field.'
      );
    }

    const value = bytes.subarray(
      state.index,
      end
    );

    state.index = end;

    return {
      fieldNumber,
      wireType,
      value
    };
  }

  throw new Error(
    `Unsupported protobuf wire type: ${wireType}`
  );
}

function decodeString(bytes) {
  return TEXT_DECODER.decode(bytes);
}

function toSignedInt32(value) {
  const n = Number(
    BigInt.asUintN(32, value)
  );

  return n >= 0x80000000
    ? n - 0x100000000
    : n;
}

function decodeTripDescriptor(bytes) {
  const state = { index: 0 };

  const trip = {
    tripId: '',
    routeId: '',
    directionId: '',
    startTime: '',
    startDate: '',
    scheduleRelationship:
      TRIP_RELATIONSHIP.SCHEDULED
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      trip.tripId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      trip.startTime =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      trip.startDate =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 4
      && field.wireType === 0
    ) {
      trip.scheduleRelationship =
        Number(field.value);
    } else if (
      field.fieldNumber === 5
      && field.wireType === 2
    ) {
      trip.routeId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 6
      && field.wireType === 0
    ) {
      trip.directionId =
        String(Number(field.value));
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
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 0
    ) {
      event.delay =
        toSignedInt32(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw > BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        throw new Error(
          'GTFS-RT timestamp exceeds JavaScript safe integer range.'
        );
      }

      event.time = Number(raw);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw > BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        throw new Error(
          'GTFS-RT scheduled timestamp exceeds JavaScript safe integer range.'
        );
      }

      event.scheduledTime =
        Number(raw);
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
    scheduleRelationship:
      STOP_RELATIONSHIP.SCHEDULED
  };

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 0
    ) {
      update.stopSequence =
        Number(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      update.arrival =
        decodeStopTimeEvent(
          field.value
        );
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      update.departure =
        decodeStopTimeEvent(
          field.value
        );
    } else if (
      field.fieldNumber === 4
      && field.wireType === 2
    ) {
      update.stopId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 5
      && field.wireType === 0
    ) {
      update.scheduleRelationship =
        Number(field.value);
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
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      result.tripId =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      result.startDate =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      result.startTime =
        decodeString(field.value);
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
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      result.trip =
        decodeTripDescriptor(
          field.value
        );
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      result.stopTimeUpdates.push(
        decodeStopTimeUpdate(
          field.value
        )
      );
    } else if (
      field.fieldNumber === 4
      && field.wireType === 0
    ) {
      const raw = field.value;

      if (
        raw <= BigInt(
          Number.MAX_SAFE_INTEGER
        )
      ) {
        result.timestamp =
          Number(raw);
      }
    } else if (
      field.fieldNumber === 6
      && field.wireType === 2
    ) {
      result.tripProperties =
        decodeTripProperties(
          field.value
        );
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
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      entity.id =
        decodeString(field.value);
    } else if (
      field.fieldNumber === 2
      && field.wireType === 0
    ) {
      entity.isDeleted =
        Boolean(field.value);
    } else if (
      field.fieldNumber === 3
      && field.wireType === 2
    ) {
      entity.tripUpdate =
        decodeTripUpdate(
          field.value
        );
    }
  }

  return entity;
}

function decodeGtfsRealtimeFeed(buffer) {
  const bytes =
    new Uint8Array(buffer);

  const state = { index: 0 };

  const updates = [];

  let feedTimestamp = null;

  while (state.index < bytes.length) {
    const field = readField(
      bytes,
      state
    );

    if (
      field.fieldNumber === 1
      && field.wireType === 2
    ) {
      const headerState = {
        index: 0
      };

      while (
        headerState.index
        < field.value.length
      ) {
        const headerField =
          readField(
            field.value,
            headerState
          );

        if (
          headerField.fieldNumber === 3
          && headerField.wireType === 0
        ) {
          const raw =
            headerField.value;

          if (
            raw <= BigInt(
              Number.MAX_SAFE_INTEGER
            )
          ) {
            feedTimestamp =
              Number(raw);
          }
        }
      }
    } else if (
      field.fieldNumber === 2
      && field.wireType === 2
    ) {
      const entity =
        decodeFeedEntity(
          field.value
        );

      if (
        entity.tripUpdate?.trip
      ) {
        updates.push(
          entity.tripUpdate
        );
      }
    }
  }

  return {
    updates,
    feedTimestamp:
      feedTimestamp
      || Math.floor(
        Date.now() / 1000
      )
  };
}

module.exports = {
  decodeGtfsRealtimeFeed,
  TRIP_RELATIONSHIP,
  STOP_RELATIONSHIP,
  TRIP_RELATIONSHIP_NAME,
  STOP_RELATIONSHIP_NAME,
};
