    String(staticTime?.start_time || "").trim(),
    Math.floor(timestamp)
  ].join("|");
}

function findRealtimeStaticMatch(
  realtimeRoute,
  realtimeTime,
  staticEntries,
  matchedStaticCourseKeys
) {
  const candidates = (staticEntries || []).filter(entry => {
    const courseKey = getStaticCourseKey(entry?.staticRoute, entry?.time);
    return courseKey && !matchedStaticCourseKeys.has(courseKey);
  });

  const relationship = getRealtimeTripScheduleRelationship(realtimeRoute, realtimeTime);
  if (relationship === 1) {
    // ADDED is deprecated in current GTFS-Realtime and its behavior was
    // explicitly unspecified. Do not reinterpret it as a scheduled trip or
    // attach it to a static course. Producers should use DUPLICATED or NEW.
    return null;
  }

  if (relationship === 5) {
    // REPLACEMENT is a complete replacement trip. GTFS-RT explicitly says
    // that the static GTFS times are not used for the replacement instance.
    // We can still render an absolute realtime timestamp when one is supplied,
    // but must never materialize it from the original static trip.
    return null;
  }

  if (relationship === 2 || relationship === 6 || relationship === 8) {
    // UNSCHEDULED, DUPLICATED and NEW have no ordinary static course to
    // consume. DUPLICATED references a static template but does not modify it.
    return null;
  }

  const realtimeTripId = getRealtimeTripId(realtimeRoute, realtimeTime);
  const realtimeStartDate = normalizeGtfsDateKey(
    getRealtimeTripStartDate(realtimeRoute, realtimeTime)
  );
  const realtimeStartTime = getRealtimeTripStartTime(realtimeRoute, realtimeTime);
  const realtimeStartSeconds = parseGtfsTime(realtimeStartTime);