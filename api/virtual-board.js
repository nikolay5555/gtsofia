const FEED_URL = 'https://gtfs.sofiatraffic.bg/api/v1/trip-updates';
const FEED_TIMEOUT_MS = 15000;

// The browser refreshes the board every 15 seconds.
// Keep the decoded feed for the same period on a warm serverless instance.
const FEED_CACHE_TTL_MS = 15000;

const MAX_RESULTS_PER_ROUTE = 3;
const LOOK_AHEAD_SECONDS = 3 * 60 * 60;

// Keep the decoded feed in warm serverless instances and share concurrent fetches.
let feedCache = null;
let feedFetchPromise = null;

const {
  decodeGtfsRealtimeFeed,
  TRIP_RELATIONSHIP,
  STOP_RELATIONSHIP,
  TRIP_RELATIONSHIP_NAME,
  STOP_RELATIONSHIP_NAME,
} = require("./gtfs-realtime");

function normalizeStopKey(value) {
  const raw =
    String(value ?? "").trim();

  if (!raw) {
    return "";
  }

  const withoutMetroPrefix =
    raw.replace(/^M/i, "");

  const digits =
    withoutMetroPrefix.replace(
      /\D/g,
      ""
    );

  if (digits) {
    return String(
      Number(digits)
    );
  }

  return withoutMetroPrefix
    .toLowerCase();
}

function stopIdsMatch(
  left,
  right
) {
  return (
    normalizeStopKey(left)
    === normalizeStopKey(right)
  );
}

function eventTimestamp(
  update
) {
  if (
    Number.isFinite(
      update?.arrival?.time
    )
  ) {
    return update.arrival.time;
  }

  if (
    Number.isFinite(
      update?.departure?.time
    )
  ) {
    return update.departure.time;
  }

  return null;
}

function eventDelay(update) {
  if (
    Number.isFinite(
      update?.arrival?.delay
    )
  ) {
    return update.arrival.delay;
  }

  if (
    Number.isFinite(
      update?.departure?.delay
    )
  ) {
    return update.departure.delay;
  }

  return null;
}

function getTripRelationship(
  trip
) {
  return Number.isFinite(
    Number(
      trip?.scheduleRelationship
    )
  )
    ? Number(
        trip.scheduleRelationship
      )
    : TRIP_RELATIONSHIP.SCHEDULED;
}

function getStopRelationship(
  stopUpdate
) {
  return Number.isFinite(
    Number(
      stopUpdate?.scheduleRelationship
    )
  )
    ? Number(
        stopUpdate.scheduleRelationship
      )
    : STOP_RELATIONSHIP.SCHEDULED;
}

function getTripKey(
  tripUpdate
) {
  const trip =
    tripUpdate?.trip;

  return [
    trip?.tripId || "",
    trip?.startDate
      || tripUpdate
        ?.tripProperties
        ?.startDate
      || "",
    trip?.startTime
      || tripUpdate
        ?.tripProperties
        ?.startTime
      || "",
    trip?.routeId || "",
    trip?.directionId || ""
  ].join("|");
}

function isCanceledOrDeleted(
  trip
) {
  const relationship =
    getTripRelationship(trip);

  return (
    relationship
      === TRIP_RELATIONSHIP.CANCELED
    || relationship
      === TRIP_RELATIONSHIP.DELETED
  );
}

function getTerminalStopId(
  tripUpdate
) {
  return (
    tripUpdate
      ?.stopTimeUpdates
      || []
  )
    .filter(item => {
      if (!item?.stopId) {
        return false;
      }

      const relationship =
        getStopRelationship(item);

      return (
        relationship
          !== STOP_RELATIONSHIP.SKIPPED
        && relationship
          !== STOP_RELATIONSHIP.NO_DATA
      );
    })
    .sort(
      (a, b) => {
        const sa =
          Number.isFinite(
            Number(
              a?.stopSequence
            )
          )
            ? Number(
                a.stopSequence
              )
            : -1;

        const sb =
          Number.isFinite(
            Number(
              b?.stopSequence
            )
          )
            ? Number(
                b.stopSequence
              )
            : -1;

        return sb - sa;
      }
    )[0]?.stopId || "";
}

function buildBoard(
  updates,
  stopCode,
  feedTimestamp,
  requestedRouteIds = new Set()
) {
  const now =
    Math.floor(
      Date.now() / 1000
    );

  const target =
    normalizeStopKey(
      stopCode
    );

  const grouped =
    new Map();

  const skippedTrips =
    new Map();

  const canceledTrips =
    new Map();

  for (
    const tripUpdate
    of updates
  ) {
    const trip =
      tripUpdate?.trip;

    if (!trip) {
      continue;
    }

    // When route_ids were supplied by the frontend, ignore all other routes
    // immediately. This reduces the amount of work needed for active_trips
    // and the board itself.
    const routeId =
      String(
        trip.routeId || ""
      ).trim();

    if (
      requestedRouteIds.size
      && !requestedRouteIds.has(
        routeId
      )
    ) {
      continue;
    }

    const tripRelationship =
      getTripRelationship(trip);

    if (
      tripRelationship
        === TRIP_RELATIONSHIP.CANCELED
      || tripRelationship
        === TRIP_RELATIONSHIP.DELETED
    ) {
      const canceledKey = getTripKey(tripUpdate);
      if (!canceledTrips.has(canceledKey)) {
        canceledTrips.set(canceledKey, {
          trip_id: String(trip.tripId || ""),
          start_date: String(
            trip.startDate
            || tripUpdate?.tripProperties?.startDate
            || ""
          ),
          start_time: String(
            trip.startTime
            || tripUpdate?.tripProperties?.startTime
            || ""
          ),
          route_id: String(trip.routeId || ""),
          direction_id: String(trip.directionId || ""),
          schedule_relationship: tripRelationship,
          schedule_relationship_name:
            TRIP_RELATIONSHIP_NAME[tripRelationship]
            || `UNKNOWN_${tripRelationship}`
        });
      }
      continue;
    }

    for (
      const stopUpdate
      of tripUpdate
        .stopTimeUpdates
        || []
    ) {
      const stopRelationship =
        getStopRelationship(
          stopUpdate
        );

      if (
        stopRelationship
          === STOP_RELATIONSHIP.SKIPPED
      ) {
        if (
          stopUpdate?.stopId
          && !stopIdsMatch(
            stopUpdate.stopId,
            target
          )
        ) {
          continue;
        }

        const skippedKey = [
          trip.tripId || "",
          trip.startDate
            || tripUpdate
              .tripProperties
              ?.startDate
            || "",
          trip.startTime
            || tripUpdate
              .tripProperties
              ?.startTime
            || "",
          trip.routeId || "",
          trip.directionId || "",
          stopUpdate.stopId
            ? normalizeStopKey(
                stopUpdate.stopId
              )
            : `seq:${
                Number.isFinite(
                  Number(
                    stopUpdate.stopSequence
                  )
                )
                  ? Number(
                      stopUpdate
                        .stopSequence
                    )
                  : ""
              }`
        ].join("|");

        if (
          !skippedTrips.has(
            skippedKey
          )
        ) {
          skippedTrips.set(
            skippedKey,
            {
              trip_id:
                trip.tripId || "",
              start_date:
                trip.startDate
                  || tripUpdate
                    .tripProperties
                    ?.startDate
                  || "",
              start_time:
                trip.startTime
                  || tripUpdate
                    .tripProperties
                    ?.startTime
                  || "",
              route_id:
                trip.routeId || "",
              direction_id:
                trip.directionId
                || "",
              stop_id:
                stopUpdate.stopId
                || "",
              stop_sequence:
                Number.isFinite(
                  Number(
                    stopUpdate
                      .stopSequence
                  )
                )
                  ? Number(
                      stopUpdate
                        .stopSequence
                    )
                  : null,
              stop_schedule_relationship:
                stopRelationship,
              stop_schedule_relationship_name:
                STOP_RELATIONSHIP_NAME[
                  stopRelationship
                ]
                  || `UNKNOWN_${stopRelationship}`
            }
          );
        }

        continue;
      }

      if (
        !stopUpdate?.stopId
        || !stopIdsMatch(
          stopUpdate.stopId,
          target
        )
      ) {
        continue;
      }

      if (
        stopRelationship
          === STOP_RELATIONSHIP.NO_DATA
      ) {
        continue;
      }

      const timestamp =
        eventTimestamp(
          stopUpdate
        );

      if (
        !Number.isFinite(
          timestamp
        )
      ) {
        continue;
      }

      if (
        timestamp
        < now - 60
      ) {
        continue;
      }

      if (
        timestamp
        > now + LOOK_AHEAD_SECONDS
      ) {
        continue;
      }

      const delay =
        eventDelay(
          stopUpdate
        );

      const key =
        getTripKey(
          tripUpdate
        );

      if (!grouped.has(key)) {
        const terminalUpdate =
          (
            tripUpdate
              .stopTimeUpdates
            || []
          )
            .filter(item => {
              if (!item?.stopId) {
                return false;
              }

              const relationship =
                getStopRelationship(
                  item
                );

              return (
                relationship
                  !== STOP_RELATIONSHIP.SKIPPED
                && relationship
                  !== STOP_RELATIONSHIP.NO_DATA
              );
            })
            .sort(
              (a, b) => {
                const sa =
                  Number.isFinite(
                    Number(
                      a?.stopSequence
                    )
                  )
                    ? Number(
                        a.stopSequence
                      )
                    : -1;

                const sb =
                  Number.isFinite(
                    Number(
                      b?.stopSequence
                    )
                  )
                    ? Number(
                        b.stopSequence
                      )
                    : -1;

                return sb - sa;
              }
            )[0] || null;

        grouped.set(
          key,
          {
            trip_id:
              trip.tripId
              || "",
            trip_start_date:
              trip.startDate
                || tripUpdate
                  .tripProperties
                  ?.startDate
                || "",
            trip_start_time:
              trip.startTime
                || tripUpdate
                  .tripProperties
                  ?.startTime
                || "",
            route_id:
              trip.routeId
              || "",
            direction_id:
              trip.directionId
              || "",
            schedule_relationship:
              tripRelationship,
            schedule_relationship_name:
              TRIP_RELATIONSHIP_NAME[
                tripRelationship
              ]
                || `UNKNOWN_${tripRelationship}`,
            destination_stop_id:
              terminalUpdate
                ?.stopId
              || "",
            times: []
          }
        );
      }

      grouped
        .get(key)
        .times
        .push({
          timestamp,
          delay:
            Number.isFinite(delay)
              ? delay
              : null,
          stop_schedule_relationship:
            stopRelationship,
          stop_schedule_relationship_name:
            STOP_RELATIONSHIP_NAME[
              stopRelationship
            ]
              || `UNKNOWN_${stopRelationship}`,
          scheduled_time:
            Number.isFinite(
              Number(
                stopUpdate
                  ?.arrival
                  ?.scheduledTime
              )
            )
              ? Number(
                  stopUpdate
                    .arrival
                    .scheduledTime
                )
              : Number.isFinite(
                  Number(
                    stopUpdate
                      ?.departure
                      ?.scheduledTime
                  )
                )
                ? Number(
                    stopUpdate
                      .departure
                      .scheduledTime
                  )
                : null
        });
    }
  }

  const routes =
    [...grouped.values()]
      .map(row => ({
        ...row,
        times:
          row.times
            .sort(
              (a, b) =>
                a.timestamp
                - b.timestamp
            )
            .slice(
              0,
              MAX_RESULTS_PER_ROUTE
            )
      }))
      .filter(
        row =>
          row.times.length
      )
      .sort(
        (a, b) =>
          a.times[0].timestamp
          - b.times[0].timestamp
      );

  // Because requestedRouteIds has already been applied above, this loop
  // builds active_trips only for relevant routes.
  const activeTrips = [];

  const seenActive =
    new Set();

  for (
    const update
    of updates || []
  ) {
    const trip =
      update?.trip;

    if (!trip) {
      continue;
    }

    const routeId =
      String(
        trip.routeId || ""
      ).trim();

    if (
      requestedRouteIds.size
      && !requestedRouteIds.has(
        routeId
      )
    ) {
      continue;
    }

    const relationship =
      getTripRelationship(
        trip
      );

    if (
      relationship
        === TRIP_RELATIONSHIP.CANCELED
      || relationship
        === TRIP_RELATIONSHIP.DELETED
    ) {
      continue;
    }

    const tripKey =
      getTripKey(
        update
      );

    if (
      seenActive.has(
        tripKey
      )
    ) {
      continue;
    }

    seenActive.add(
      tripKey
    );

    const terminalUpdate =
      (
        update
          .stopTimeUpdates
        || []
      )
        .filter(item => {
          if (!item?.stopId) {
            return false;
          }

          const stopRelationship =
            getStopRelationship(
              item
            );

          return (
            stopRelationship
              !== STOP_RELATIONSHIP.SKIPPED
            && stopRelationship
              !== STOP_RELATIONSHIP.NO_DATA
          );
        })
        .sort(
          (a, b) => {
            const sa =
              Number.isFinite(
                Number(
                  a?.stopSequence
                )
              )
                ? Number(
                    a.stopSequence
                  )
                : -1;

            const sb =
              Number.isFinite(
                Number(
                  b?.stopSequence
                )
              )
                ? Number(
                    b.stopSequence
                  )
                : -1;

            return sb - sa;
          }
        )[0] || null;

    activeTrips.push({
      trip_id:
        String(
          trip.tripId || ""
        ),
      start_date:
        String(
          trip.startDate
            || update
              .tripProperties
              ?.startDate
            || ""
        ),
      start_time:
        String(
          trip.startTime
            || update
              .tripProperties
              ?.startTime
            || ""
        ),
      route_id:
        String(
          trip.routeId || ""
        ),
      direction_id:
        String(
          trip.directionId || ""
        ),
      destination_stop_id:
        String(
          terminalUpdate
            ?.stopId
          || ""
        ),
      schedule_relationship:
        relationship,
      schedule_relationship_name:
        TRIP_RELATIONSHIP_NAME[
          relationship
        ]
          || `UNKNOWN_${relationship}`
    });
  }

  const realtimeRouteIds =
    [
      ...new Set(
        (updates || [])
          .filter(update => {
            const routeId =
              String(
                update?.trip
                  ?.routeId || ""
              ).trim();

            return (
              !requestedRouteIds.size
              || requestedRouteIds.has(
                routeId
              )
            );
          })
          .map(
            update =>
              String(
                update?.trip
                  ?.routeId
                  || ""
              ).trim()
          )
          .filter(Boolean)
      )
    ];

  return {
    status:
      routes.length
        ? "ok"
        : "empty",

    stop_code:
      String(stopCode),

    generated_at:
      feedTimestamp,

    realtime_route_ids:
      realtimeRouteIds,

    active_trips:
      activeTrips,

    skipped_trips:
      [...skippedTrips.values()],

    canceled_trips:
      [...canceledTrips.values()],

    active_trip_ids:
      activeTrips
        .map(
          item =>
            item.trip_id
        )
        .filter(Boolean),

    routes
  };
}

async function fetchRealtimeFeed() {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      FEED_TIMEOUT_MS
    );

  try {
    const upstream =
      await fetch(
        FEED_URL,
        {
          signal:
            controller.signal,
          headers: {
            Accept:
              'application/x-protobuf, application/octet-stream',
            'User-Agent':
              'GTSofia virtual boards'
          }
        }
      );

    if (!upstream.ok) {
      throw new Error(
        `Sofia Traffic GTFS-RT returned ${upstream.status}.`
      );
    }

    const body =
      await upstream.arrayBuffer();

    if (
      !body.byteLength
    ) {
      throw new Error(
        'Sofia Traffic GTFS-RT feed is empty.'
      );
    }

    return decodeGtfsRealtimeFeed(
      body
    );
  } finally {
    clearTimeout(
      timeout
    );
  }
}

async function getRealtimeFeed() {
  const now =
    Date.now();

  // Fast path for a warm serverless instance.
  if (
    feedCache
    && now - feedCache.cachedAt
      < FEED_CACHE_TTL_MS
  ) {
    return feedCache.feed;
  }

  // Prevent duplicate simultaneous upstream downloads.
  if (feedFetchPromise) {
    return feedFetchPromise;
  }

  feedFetchPromise =
    fetchRealtimeFeed()
      .then(feed => {
        feedCache = {
          feed,
          cachedAt:
            Date.now()
        };

        return feed;
      })
      .finally(() => {
        feedFetchPromise =
          null;
      });

  return feedFetchPromise;
}

module.exports =
  async function handler(
    req,
    res
  ) {
    if (
      req.method !== "GET"
    ) {
      res.setHeader(
        "Allow",
        "GET"
      );

      return res
        .status(405)
        .json({
          error:
            "Method not allowed."
        });
    }

    const stopCode =
      String(
        req.query?.stop_code
        || ""
      ).trim();

    const requestedRouteIds =
      new Set(
        String(
          req.query?.route_ids
          || ""
        )
          .split(",")
          .map(
            value =>
              value.trim()
          )
          .filter(Boolean)
      );

    if (!stopCode) {
      return res
        .status(400)
        .json({
          error:
            "Missing stop_code."
        });
    }

    try {
      const feed =
        await getRealtimeFeed();

      const board =
        buildBoard(
          feed.updates,
          stopCode,
          feed.feedTimestamp,
          requestedRouteIds
        );

      res.setHeader(
        "Content-Type",
        "application/json; charset=utf-8"
      );

      // Browser must request the current board.
      // This does not disable our server-side in-memory feed cache.
      res.setHeader(
        "Cache-Control",
        "no-store, max-age=0"
      );

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      return res
        .status(200)
        .json(board);
    } catch (error) {
      const message =
        error?.name ===
        "AbortError"
          ? "Sofia Traffic GTFS-RT request timed out."
          : (
              error?.message
              || "Unable to fetch/decode GTFS-RT."
            );

      return res
        .status(502)
        .json({
          error: message
        });
    }
  };
