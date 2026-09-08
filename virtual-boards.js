(() => {
  const SOFIA_TIME_ZONE = "Europe/Sofia";
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];

  let map = null;
  let selectedStopId = null;
  let refreshTimer = null;
  let clockTimer = null;
  let stopMarkers = null;
  let transportData = null;
  let routeById = new Map();
  let routeMetaById = new Map();
  let routeMetaByNumber = new Map();
  let tripById = new Map();
  let tripStopsById = new Map();

  const boardPanel = () => document.getElementById("virtualBoardBody");

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getSofiaParts() {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: SOFIA_TIME_ZONE,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());

    const get = type => parts.find(part => part.type === type)?.value || "";

    return {
      weekday: get("weekday"),
      hour: Number(get("hour")),
      minute: Number(get("minute")),
      second: Number(get("second"))
    };
  }

  function isWeekendInSofia() {
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: SOFIA_TIME_ZONE,
      weekday: "short"
    }).format(new Date());

    return day === "Sat" || day === "Sun";
  }

  function getNowGtfsSeconds() {
    const parts = getSofiaParts();
    return (
      parts.hour * 3600 +
      parts.minute * 60 +
      parts.second
    );
  }

  function formatClockTime(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds) || 0);
    const hour = Math.floor(seconds / 3600) % 24;
    const minute = Math.floor((seconds % 3600) / 60);

    return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }

  function parseGtfsTime(value) {
    if (!value) return null;

    const parts = String(value).trim().split(":");
    if (parts.length !== 3) return null;

    const hour = Number(parts[0]);
    const minute = Number(parts[1]);
    const second = Number(parts[2]);

    if (![hour, minute, second].every(Number.isFinite)) return null;
    return hour * 3600 + minute * 60 + second;
  }

  // Minimal GTFS-Realtime protobuf decoder for TripUpdates.
  function readVarint(bytes, state) {
    let value = 0n;
    let shift = 0n;

    while (state.index < bytes.length) {
      const byte = bytes[state.index++];
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
      if (shift > 70n) throw new Error("Невалиден GTFS-RT varint.");
    }

    throw new Error("Непълен GTFS-RT varint.");
  }

  function readField(bytes, state) {
    const tag = Number(readVarint(bytes, state));
    const fieldNumber = tag >>> 3;
    const wireType = tag & 7;

    if (!fieldNumber) throw new Error("Невалидно GTFS-RT поле.");

    if (wireType === 0) {
      return { fieldNumber, wireType, value: readVarint(bytes, state) };
    }

    if (wireType === 1) {
      const end = state.index + 8;
      if (end > bytes.length) throw new Error("Непълно GTFS-RT съобщение.");
      const value = bytes.subarray(state.index, end);
      state.index = end;
      return { fieldNumber, wireType, value };
    }

    if (wireType === 2) {
      const length = Number(readVarint(bytes, state));
      const end = state.index + length;
      if (end > bytes.length) throw new Error("Непълно GTFS-RT protobuf съобщение.");
      const value = bytes.subarray(state.index, end);
      state.index = end;
      return { fieldNumber, wireType, value };
    }

    if (wireType === 5) {
      const end = state.index + 4;
      if (end > bytes.length) throw new Error("Непълно GTFS-RT съобщение.");
      const value = bytes.subarray(state.index, end);
      state.index = end;
      return { fieldNumber, wireType, value };
    }

    throw new Error(`Неподдържан GTFS-RT wire type: ${wireType}`);
  }

  function decodeString(bytes) {
    return new TextDecoder().decode(bytes);
  }

  function toSignedInt32(value) {
    const n = Number(value & 0xffffffffn) >>> 0;
    return n > 0x7fffffff ? n - 0x100000000 : n;
  }

  function decodeTripDescriptor(bytes) {
    const state = { index: 0 };
    const trip = {
      tripId: "",
      routeId: "",
      directionId: "",
      scheduleRelationship: null
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
    const result = { delay: null, time: null };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);

      if (field.fieldNumber === 1 && field.wireType === 0) {
        result.delay = toSignedInt32(field.value);
      } else if (field.fieldNumber === 2 && field.wireType === 0) {
        result.time = Number(field.value);
      }
    }

    return result;
  }

  function decodeStopTimeUpdate(bytes) {
    const state = { index: 0 };
    const result = {
      stopSequence: null,
      stopId: "",
      arrival: null,
      departure: null,
      scheduleRelationship: null
    };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);

      if (field.fieldNumber === 1 && field.wireType === 0) {
        result.stopSequence = Number(field.value);
      } else if (field.fieldNumber === 2 && field.wireType === 2) {
        result.arrival = decodeStopTimeEvent(field.value);
      } else if (field.fieldNumber === 3 && field.wireType === 2) {
        result.departure = decodeStopTimeEvent(field.value);
      } else if (field.fieldNumber === 4 && field.wireType === 2) {
        result.stopId = decodeString(field.value);
      } else if (field.fieldNumber === 5 && field.wireType === 0) {
        result.scheduleRelationship = Number(field.value);
      }
    }

    return result;
  }

  function decodeTripUpdate(bytes) {
    const state = { index: 0 };
    const result = {
      trip: null,
      stopTimeUpdates: []
    };

    while (state.index < bytes.length) {
      const field = readField(bytes, state);

      if (field.fieldNumber === 1 && field.wireType === 2) {
        result.trip = decodeTripDescriptor(field.value);
      } else if (field.fieldNumber === 2 && field.wireType === 2) {
        result.stopTimeUpdates.push(
          decodeStopTimeUpdate(field.value)
        );
      }
    }

    return result;
  }

  function decodeFeedEntity(bytes) {
    const state = { index: 0 };
    let tripUpdate = null;

    while (state.index < bytes.length) {
      const field = readField(bytes, state);

      if (field.fieldNumber === 3 && field.wireType === 2) {
        tripUpdate = decodeTripUpdate(field.value);
      }
    }

    return tripUpdate;
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

          if (
            headerField.fieldNumber === 3 &&
            headerField.wireType === 0
          ) {
            feedTimestamp = Number(headerField.value) * 1000;
          }
        }
      } else if (field.fieldNumber === 2 && field.wireType === 2) {
        const entity = decodeFeedEntity(field.value);

        if (entity?.trip?.tripId) {
          updates.push(entity);
        }
      }
    }

    return {
      updates,
      feedTimestamp: feedTimestamp || Date.now()
    };
  }

  function normalizeProxyStopCode(stop) {
    const rawCode = String(
      stop?.stop_code ??
      stop?.stop_id ??
      ""
    ).trim();

    if (!rawCode) {
      return {
        candidates: [],
        isMetro: false
      };
    }

    const rawId = String(stop?.stop_id ?? "").trim();
    const isMetro =
      /^M/i.test(rawCode) ||
      /^M/i.test(rawId);

    const digits = rawCode.replace(/\D/g, "");

    const candidates = [];

    if (digits) {
      candidates.push(String(Number(digits)));
      candidates.push(digits);
    }

    candidates.push(rawCode);

    return {
      candidates: [
        ...new Set(candidates.filter(Boolean))
      ],
      isMetro
    };
  }

  function getLineMeta(routeId, routeRef) {
    const id = String(routeId ?? "").trim();
    const ref = String(routeRef ?? "").trim();

    if (id && routeMetaById.has(id)) {
      return routeMetaById.get(id);
    }

    if (ref && routeMetaByNumber.has(ref)) {
      return routeMetaByNumber.get(ref);
    }

    const route = id ? routeById.get(id) : null;
    const number =
      ref ||
      route?.route_short_name ||
      "—";

    if (!route) {
      return {
        id,
        number,
        type: /^N/i.test(number)
          ? "night"
          : "bus",
        icon: "",
        color: "#BE1E2D",
        textColor: "#FFFFFF"
      };
    }

    const type =
      typeof getLineType === "function"
        ? getLineType(route)
        : "bus";

    const icon =
      typeof getTransportIcon === "function"
        ? getTransportIcon(route, type)
        : "";

    return {
      id,
      number,
      type,
      icon,
      color:
        route.route_color
          ? `#${String(route.route_color).replace(/^#/, "")}`
          : "#BE1E2D",
      textColor:
        route.route_text_color
          ? `#${String(route.route_text_color).replace(/^#/, "")}`
          : "#FFFFFF"
    };
  }

  async function loadTransportData() {
    const response = await fetch(
      "data/transport.json",
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(
        `GTFS данните не могат да бъдат заредени (${response.status}).`
      );
    }

    return response.json();
  }

  async function fetchVirtualBoard(stop) {
    const normalized = normalizeProxyStopCode(stop);

    if (!normalized.candidates.length) {
      throw new Error("Спирката няма валиден stop_code.");
    }

    let lastError = null;

    for (const candidate of normalized.candidates) {
      try {
        const url =
          `/api/virtual-board?stop_code=${encodeURIComponent(candidate)}${
            normalized.isMetro
              ? "&metro=true"
              : ""
          }`;

        const response = await fetch(url, {
          cache: "no-store",
          headers: {
            Accept: "application/json"
          }
        });

        if (!response.ok) {
          let message = `HTTP ${response.status}`;

          try {
            const body = await response.json();

            if (body?.error) {
              message = body.error;
            }
          } catch (_) {
            // Ignore invalid error bodies.
          }

          throw new Error(message);
        }

        const data = await response.json();

        if (!data || typeof data !== "object") {
          throw new Error("Невалиден отговор от realtime услугата.");
        }

        return data;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error(
      "Realtime данните не могат да бъдат заредени."
    );
  }

  function resolveStopName(stop) {
    return (
      stop?.name ||
      stop?.stop_name ||
      "Спирка"
    );
  }

  function getDestinationFromTrip(trip) {
    if (!trip) return "";

    const direct =
      trip.destination ||
      trip.headsign ||
      trip.trip_headsign ||
      "";

    if (direct) return String(direct);

    const directionId =
      trip.direction_id ??
      trip.directionId ??
      "";

    if (
      routeMetaById.has(String(trip.route_id))
    ) {
      const meta = routeMetaById.get(
        String(trip.route_id)
      );

      if (
        meta?.destinations &&
        meta.destinations[directionId]
      ) {
        return meta.destinations[directionId];
      }
    }

    return "";
  }

  function normalizeRealtimeRows(data, stop) {
    const rawRoutes =
      Array.isArray(data?.routes)
        ? data.routes
        : [];

    const rows = [];

    for (const routeGroup of rawRoutes) {
      if (!routeGroup) continue;

      const routeId = String(
        routeGroup.route_id ??
        routeGroup.routeId ??
        ""
      ).trim();

      const routeRef = String(
        routeGroup.route_short_name ??
        routeGroup.route_short_name ??
        routeGroup.route ??
        routeGroup.line ??
        ""
      ).trim();

      const meta = getLineMeta(
        routeId,
        routeRef
      );

      const directionGroups =
        Array.isArray(routeGroup.directions)
          ? routeGroup.directions
          : [routeGroup];

      for (const directionGroup of directionGroups) {
        if (!directionGroup) continue;

        const destination =
          String(
            directionGroup.destination ??
            directionGroup.headsign ??
            directionGroup.trip_headsign ??
            getDestinationFromTrip(
              directionGroup.trip
            ) ??
            ""
          ).trim();

        const times =
          Array.isArray(directionGroup.times)
            ? directionGroup.times
            : [];

        const arrivals = times
          .map(time => {
            if (
              typeof time === "number" ||
              typeof time === "string"
            ) {
              const numeric = Number(time);

              return Number.isFinite(numeric)
                ? {
                    minutes: Math.max(
                      0,
                      Math.round(numeric)
                    )
                  }
                : null;
            }

            if (!time || typeof time !== "object") {
              return null;
            }

            const rawMinutes =
              time.minutes ??
              time.min ??
              time.t ??
              null;

            const rawTime =
              time.time ??
              time.arrival ??
              time.arrival_time ??
              null;

            let minutes = Number(
              rawMinutes
            );

            let clockTime = null;

            if (
              Number.isFinite(minutes) &&
              minutes > 10000 &&
              !rawTime
            ) {
              const now = getNowGtfsSeconds();
              minutes = Math.max(
                0,
                Math.round(
                  (minutes - now) / 60
                )
              );
            }

            if (
              rawTime &&
              !Number.isFinite(minutes)
            ) {
              const parsed =
                parseGtfsTime(rawTime);

              if (parsed !== null) {
                const now =
                  getNowGtfsSeconds();

                let diff = parsed - now;

                if (diff < -43200) {
                  diff += 86400;
                }

                minutes = Math.max(
                  0,
                  Math.round(diff / 60)
                );
              }
            }

            if (!Number.isFinite(minutes)) {
              return null;
            }

            if (
              rawTime &&
              typeof rawTime === "string" &&
              /^\d{1,2}:\d{2}/.test(rawTime)
            ) {
              clockTime = rawTime.slice(
                0,
                5
              );
            }

            return {
              minutes: Math.max(
                0,
                Math.round(minutes)
              ),
              clockTime
            };
          })
          .filter(Boolean)
          .sort(
            (a, b) =>
              a.minutes - b.minutes
          );

        if (!arrivals.length) {
          continue;
        }

        rows.push({
          routeId,
          routeRef,
          meta,
          destination,
          arrivals: arrivals.slice(0, 5)
        });
      }
    }

    return rows;
  }

  function createRoutePill(meta) {
    const color =
      meta?.color ||
      "#BE1E2D";

    const textColor =
      meta?.textColor ||
      "#FFFFFF";

    return `
      <span
        class="line-pill"
        style="
          --line-color:${escapeHtml(color)};
          --line-text-color:${escapeHtml(textColor)};
          background-color:${escapeHtml(color)};
          color:${escapeHtml(textColor)};
        "
      >
        ${escapeHtml(meta?.number || "—")}
      </span>
    `;
  }

  function createTransportIcon(meta) {
    if (meta?.icon) {
      return `
        <span class="line-icon" aria-hidden="true">
          ${meta.icon}
        </span>
      `;
    }

    return `
      <span
        class="line-icon line-icon-placeholder"
        aria-hidden="true"
      ></span>
    `;
  }

  function createArrivalTime(arrival, index) {
    const minutes = Number(
      arrival?.minutes
    );

    if (!Number.isFinite(minutes)) {
      return "";
    }

    const clockTime =
      arrival?.clockTime ||
      "";

    const primaryTime =
      clockTime ||
      (() => {
        const now = getNowGtfsSeconds();
        return formatClockTime(
          now + minutes * 60
        );
      })();

    const liveIndicator =
      index === 0
        ? `
          <span
            class="live-indicator"
            aria-label="Най-близко пристигане"
            title="Най-близко пристигане"
          ></span>
        `
        : "";

    return `
      <div class="arrival-time">
        ${liveIndicator}
        <strong>${escapeHtml(primaryTime)}</strong>
        <span class="arrival-minutes">
          ${escapeHtml(minutes)} мин.
        </span>
      </div>
    `;
  }

  function renderRows(rows) {
    if (!rows.length) {
      return `
        <div class="virtual-board-empty">
          <p>
            Няма налични realtime пристигания
            за тази спирка.
          </p>
        </div>
      `;
    }

    return rows.map(row => {
      const firstArrival =
        row.arrivals[0] || null;

      const remaining =
        row.arrivals.slice(1);

      return `
        <article class="virtual-board-row">
          <div class="virtual-board-route">
            ${createTransportIcon(row.meta)}
            ${createRoutePill(row.meta)}

            <span class="destination-arrow" aria-hidden="true">
              →
            </span>

            <span class="destination">
              ${escapeHtml(
                row.destination ||
                "—"
              )}
            </span>
          </div>

          <div class="virtual-board-arrivals">
            ${
              firstArrival
                ? createArrivalTime(
                    firstArrival,
                    0
                  )
                : ""
            }

            ${
              remaining.length
                ? `
                  <div class="arrival-next">
                    ${remaining
                      .map((arrival, index) =>
                        createArrivalTime(
                          arrival,
                          index + 1
                        )
                      )
                      .join("")}
                  </div>
                `
                : ""
            }
          </div>
        </article>
      `;
    }).join("");
  }

  async function renderStopBoard(
    stop,
    data = null
  ) {
    selectedStopId =
      String(stop.stop_id);

    const panel = boardPanel();

    if (!panel) return;

    const stopTitle = resolveStopName(
      stop
    );

    panel.innerHTML = `
      <div class="virtual-board-loading">
        <span class="spinner" aria-hidden="true"></span>
        <span>Зареждане...</span>
      </div>
    `;

    try {
      const realtimeData =
        data ||
        await fetchVirtualBoard(stop);

      const rows =
        normalizeRealtimeRows(
          realtimeData,
          stop
        );

      panel.innerHTML = `
        <div class="virtual-board-header">
          <div>
            <h2>${escapeHtml(stopTitle)}</h2>
          </div>

          <button
            type="button"
            id="virtualBoardRefresh"
            class="virtual-board-refresh"
            aria-label="Обнови"
            title="Обнови"
          >
            ↻
          </button>
        </div>

        <div class="virtual-board-list">
          ${renderRows(rows)}
        </div>
      `;

      bindRefreshButton();
    } catch (error) {
      console.error(
        "Грешка при зареждане на realtime таблото:",
        error
      );

      panel.innerHTML = `
        <div class="virtual-board-error">
          Realtime данните не могат
          да бъдат заредени.
        </div>
      `;

      bindRefreshButton();
    }
  }

  function bindRefreshButton() {
    const refreshButton =
      document.getElementById(
        "virtualBoardRefresh"
      );

    if (
      !refreshButton ||
      refreshButton.dataset.bound
    ) {
      return;
    }

    refreshButton.dataset.bound = "true";

    refreshButton.addEventListener(
      "click",
      refreshSelectedBoard
    );
  }

  function renderEmptyBoard() {
    const panel = boardPanel();

    if (!panel) return;

    panel.innerHTML = `
      <div class="virtual-board-empty">
        <p>
          Изберете спирка от картата,
          за да видите следващите пристигания
        </p>
      </div>
    `;
  }

  function findStopById(stopId) {
    return (
      transportData?.stops || []
    ).find(
      stop =>
        String(stop.stop_id) ===
        String(stopId)
    ) || null;
  }

  function selectStopOnMap(stop) {
    if (!stop || !map) return;

    const lat = Number(stop.stop_lat);
    const lon = Number(stop.stop_lon);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return;
    }

    renderStopBoard(stop);

    map.setView(
      [lat, lon],
      Math.max(map.getZoom(), 15),
      { animate: true }
    );
  }

  function setupStopSearch(stops) {
    const input =
      document.getElementById(
        "stopSearch"
      );

    const results =
      document.getElementById(
        "stopSearchResults"
      );

    if (!input || !results) return;

    const normalized =
      value =>
        String(value || "")
          .toLocaleLowerCase(
            "bg-BG"
          )
          .normalize("NFD")
          .replace(
            /[\u0300-\u036f]/g,
            "");

    const searchStops =
      query => {
        const needle =
          normalized(query)
            .trim();

        if (!needle) return [];

        return stops
          .filter(stop => {
            const name =
              normalized(
                stop.name ||
                stop.stop_name
              );

            const code =
              normalized(
                stop.stop_code ||
                stop.stop_id
              );

            return (
              name.includes(needle) ||
              code.includes(needle)
            );
          })
          .slice(0, 8);
      };

    const renderResults =
      matches => {
        results.innerHTML =
          matches.length
            ? matches.map(stop => `
                <button
                  type="button"
                  class="virtual-stop-search-result"
                  data-stop-id="${escapeHtml(
                    stop.stop_id
                  )}"
                >
                  <strong>
                    ${escapeHtml(
                      stop.name ||
                      stop.stop_name ||
                      "Спирка"
                    )}
                  </strong>
                  <span>
                    ${escapeHtml(
                      stop.stop_code ||
                      stop.stop_id ||
                      ""
                    )}
                  </span>
                </button>
              `).join("")
            : `
              <div class="virtual-stop-search-empty">
                Няма намерени спирки.
              </div>
            `;

        results.hidden = false;

        results
          .querySelectorAll(
            "[data-stop-id]"
          )
          .forEach(button => {
            button.addEventListener(
              "click",
              () => {
                const stop =
                  findStopById(
                    button.dataset.stopId
                  );

                if (stop) {
                  input.value =
                    stop.name ||
                    stop.stop_name ||
                    "";

                  results.hidden = true;

                  selectStopOnMap(
                    stop
                  );
                }
              }
            );
          });
      };

    input.addEventListener(
      "input",
      () => {
        const query =
          input.value.trim();

        if (!query) {
          results.hidden = true;
          results.innerHTML = "";
          return;
        }

        renderResults(
          searchStops(query)
        );
      }
    );

    input.addEventListener(
      "focus",
      () => {
        if (input.value.trim()) {
          renderResults(
            searchStops(
              input.value
            )
          );
        }
      }
    );

    document.addEventListener(
      "click",
      event => {
        if (
          !event.target.closest(
            ".virtual-stop-search"
          )
        ) {
          results.hidden = true;
        }
      }
    );
  }

  function setupGeolocation() {
    const button =
      document.getElementById(
        "locateUserButton"
      );

    if (!button) return;

    let userMarker = null;

    const locate = () => {
      if (!navigator.geolocation) {
        window.alert(
          "Този браузър не поддържа определяне на локация."
        );
        return;
      }

      button.disabled = true;
      button.classList.add(
        "is-loading"
      );

      navigator.geolocation.getCurrentPosition(
        position => {
          const lat =
            position.coords.latitude;

          const lon =
            position.coords.longitude;

          if (!userMarker) {
            userMarker =
              L.circleMarker(
                [lat, lon],
                {
                  radius: 8,
                  weight: 3,
                  color: "#ffffff",
                  fillColor: "#2563eb",
                  fillOpacity: 1
                }
              ).addTo(map);

            userMarker.bindTooltip(
              "Вашата локация",
              {
                direction: "top",
                offset: [0, -8]
              }
            );
          } else {
            userMarker.setLatLng(
              [lat, lon]
            );
          }

          map.setView(
            [lat, lon],
            Math.max(
              map.getZoom(),
              15
            ),
            {
              animate: true
            }
          );

          button.disabled = false;
          button.classList.remove(
            "is-loading"
          );
        },
        error => {
          console.warn(
            "Грешка при определяне на локацията:",
            error
          );

          button.disabled = false;
          button.classList.remove(
            "is-loading"
          );

          window.alert(
            "Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението."
          );
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 30000
        }
      );
    };

    button.addEventListener(
      "click",
      locate
    );
  }

  function addStopMarkers(stops) {
    stopMarkers.clearLayers();

    const renderer =
      L.svg();

    for (const stop of stops) {
      const lat =
        Number(stop.stop_lat);

      const lon =
        Number(stop.stop_lon);

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        continue;
      }

      const clickTarget =
        L.circleMarker(
          [lat, lon],
          {
            radius: 16,
            weight: 0,
            stroke: false,
            fillColor: "#111827",
            fillOpacity: 0.01,
            renderer,
            pane: "markerPane"
          }
        );

      const marker =
        L.circleMarker(
          [lat, lon],
          {
            radius: 7,
            weight: 2,
            color: "#ffffff",
            fillColor: "#111827",
            fillOpacity: 0.9,
            renderer,
            pane: "markerPane"
          }
        );

      const stopTooltip =
        escapeHtml(
          stop.name ||
          stop.stop_name ||
          "Спирка"
        );

      marker.bindTooltip(
        stopTooltip,
        {
          direction: "top",
          offset: [0, -5]
        }
      );

      clickTarget.bindTooltip(
        stopTooltip,
        {
          direction: "top",
          offset: [0, -12]
        }
      );

      const select =
        () =>
          selectStopOnMap(
            stop
          );

      clickTarget.on(
        "click",
        select
      );

      marker.on(
        "click",
        select
      );

      clickTarget.addTo(
        stopMarkers
      );

      marker.addTo(
        stopMarkers
      );
    }
  }

  function getActiveStops(stops) {
    const activeStopIds =
      new Set();

    for (
      const directionSet of Object.values(
        transportData?.directions || {}
      )
    ) {
      for (
        const direction of Object.values(
          directionSet || {}
        )
      ) {
        for (
          const stop of
            direction?.stops || []
        ) {
          const stopId =
            String(
              stop?.stop_id ?? ""
            ).trim();

          if (stopId) {
            activeStopIds.add(
              stopId
            );
          }
        }
      }
    }

    return stops.filter(
      stop =>
        activeStopIds.has(
          String(
            stop?.stop_id ?? ""
          ).trim()
        )
    );
  }

  function initMap(stops) {
    if (typeof L === "undefined") {
      const mapElement =
        document.getElementById(
          "virtualMap"
        );

      if (mapElement) {
        mapElement.innerHTML =
          '<div class="virtual-map-error">Картата не може да бъде заредена.</div>';
      }

      return;
    }

    map =
      L.map(
        "virtualMap",
        {
          center:
            SOFIA_CENTER,
          zoom: 12,
          minZoom: 10,
          preferCanvas: true,
          zoomControl: true
        }
      );

    L.tileLayer(
      "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      {
        maxZoom: 19,
        attribution:
          "&copy; OpenStreetMap contributors"
      }
    ).addTo(map);

    stopMarkers =
      L.layerGroup().addTo(
        map
      );

    addStopMarkers(
      stops
    );

    setTimeout(
      () =>
        map.invalidateSize(),
      100
    );
  }

  function startTimers() {
    clearInterval(
      refreshTimer
    );

    refreshTimer =
      setInterval(
        () => {
          if (
            selectedStopId
          ) {
            refreshSelectedBoard();
          }
        },
        REFRESH_MS
      );
  }

  async function refreshSelectedBoard() {
    if (!selectedStopId) return;

    const stop =
      findStopById(
        selectedStopId
      );

    if (!stop) return;

    const refreshButton =
      document.getElementById(
        "virtualBoardRefresh"
      );

    refreshButton?.classList.add(
      "is-loading"
    );

    if (refreshButton) {
      refreshButton.disabled =
        true;
    }

    try {
      const data =
        await fetchVirtualBoard(
          stop
        );

      await renderStopBoard(
        stop,
        data
      );
    } catch (error) {
      console.error(
        "Неуспешно зареждане на GTFS-Realtime виртуално табло:",
        error
      );

      const list =
        boardPanel()?.querySelector(
          ".virtual-board-list"
        );

      if (list) {
        list.innerHTML = `
          <div class="virtual-board-error">
            Realtime данните не могат да бъдат заредени.
          </div>
        `;
      }
    }
  }

  async function initializeVirtualBoards() {
    try {
      transportData =
        await loadTransportData();

      routeById =
        new Map(
          (transportData.routes || [])
            .map(route => [
              String(
                route.route_id
              ),
              route
            ])
        );

      tripById =
        new Map(
          (transportData.trips || [])
            .map(trip => [
              String(
                trip.trip_id
              ),
              trip
            ])
        );

      tripStopsById =
        new Map();

      for (
        const directionSet of Object.values(
          transportData.directions || {}
        )
      ) {
        for (
          const direction of Object.values(
            directionSet || {}
          )
        ) {
          const tripId =
            String(
              direction?.trip_id ||
              ""
            ).trim();

          if (!tripId) continue;

          const stopIds =
            Array.isArray(
              direction?.stops
            )
              ? direction.stops
                  .map(
                    stop =>
                      String(
                        stop?.stop_id ||
                        ""
                      ).trim()
                  )
                  .filter(Boolean)
              : [];

          if (stopIds.length) {
            tripStopsById.set(
              tripId,
              stopIds
            );
          }
        }
      }

      const lines =
        convertGtfsRoutes(
          transportData.routes ||
            [],
          transportData.trips ||
            [],
          transportData.directions ||
            {}
        );

      routeMetaById =
        new Map(
          lines.map(line => [
            String(line.id),
            line
          ])
        );

      routeMetaByNumber =
        new Map(
          lines.map(line => [
            String(
              line.number
            ).trim(),
            line
          ])
        );

      const allStops =
        transportData.stops ||
        [];

      const stops =
        getActiveStops(
          allStops
        );

      initMap(
        stops
      );

      setupStopSearch(
        stops
      );

      setupGeolocation();

      startTimers();
    } catch (error) {
      console.error(
        "Неуспешно зареждане на GTFS за виртуалните табла:",
        error
      );

      const panel =
        boardPanel();

      if (panel) {
        panel.innerHTML = `
          <div class="virtual-board-error">
            <strong>
              Виртуалното табло не може
              да бъде заредено.
            </strong>
            <span>
              ${escapeHtml(
                error.message ||
                "Неизвестна грешка."
              )}
            </span>
          </div>
        `;
      }
    }
  }

  document.addEventListener(
    "DOMContentLoaded",
    initializeVirtualBoards
  );
})();
