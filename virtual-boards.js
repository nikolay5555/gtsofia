(() => {
  const SOFIA_TIME_ZONE = 'Europe/Sofia';
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];
  const VIRTUAL_BOARD_PROXY_URL = 'https://sofiatraffic-proxy.onrender.com/virtual-board?stop_code=';
  const FAVORITE_STOPS_KEY = 'gtsofia.favoriteStops';

  let map = null;
  let stopMarkers = null;
  let stopMarkersById = new Map();
  let selectedStopMarker = null;
  let selectedStopId = null;
  let transportData = null;
  let refreshTimer = null;
  let countdownTimer = null;
  let refreshInFlight = false;
  let boardRenderToken = 0;
  let userMarker = null;

  function boardPanel() {
    return document.getElementById('virtualBoardBody');
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function getFavoriteStops() {
    try {
      const value = JSON.parse(localStorage.getItem(FAVORITE_STOPS_KEY) || '[]');
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function isFavoriteStop(stopId) {
    return getFavoriteStops().some(item => String(item.stop_id) === String(stopId));
  }

  function setFavoriteStop(stop) {
    const favorites = getFavoriteStops();
    const index = favorites.findIndex(item => String(item.stop_id) === String(stop.stop_id));
    if (index >= 0) {
      favorites.splice(index, 1);
    } else {
      favorites.push({
        stop_id: String(stop.stop_id),
        stop_code: String(stop.stop_code || stop.stop_id || ''),
        stop_name: String(stop.stop_name || stop.name || 'Спирка')
      });
    }
    localStorage.setItem(FAVORITE_STOPS_KEY, JSON.stringify(favorites));
    return index < 0;
  }

  function normalizeStopKey(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    if (/^M/i.test(raw)) return raw.toUpperCase();
    const numeric = raw.replace(/^0+(?=\d)/, '');
    return numeric || '0';
  }

  function stopIdsMatch(left, right) {
    const a = String(left ?? '').trim();
    const b = String(right ?? '').trim();
    if (!a || !b) return false;
    const am = /^M/i.test(a);
    const bm = /^M/i.test(b);
    if (am !== bm) return false;
    return normalizeStopKey(a) === normalizeStopKey(b);
  }

  function isMetroStop(stop) {
    return /^M/i.test(String(stop?.stop_id || '').trim())
      || /^M/i.test(String(stop?.stop_code || '').trim());
  }

  function findStopById(stopId) {
    return (transportData?.stops || []).find(stop =>
      stopIdsMatch(stop?.stop_id, stopId)
      || stopIdsMatch(stop?.stop_code, stopId)
    ) || null;
  }

  function getLineOverride(route) {
    const routeId = String(route?.route_id || route?.cgm_id || '').trim();
    const routeNumber = String(route?.route_short_name || route?.route_ref || '').trim();
    const overrides = Array.isArray(transportData?.lineOverrides)
      ? transportData.lineOverrides
      : [];
    return overrides.find(override =>
      String(override?.cgm_id || '').trim() === routeId
      || (!override?.cgm_id && String(override?.route_ref || '').trim() === routeNumber)
    ) || null;
  }

  function getLineType(route) {
    const number = String(route?.route_short_name || route?.route_ref || '').trim().toUpperCase();
    const nightBusLines = new Set(['N1', 'N2', 'N3', 'N4']);
    if (nightBusLines.has(number)) return 'night';

    const override = getLineOverride(route);
    if (override?.type) return override.type;
    if (route?.subtype === 'night') return 'night';
    if (route?.type === 'trolley') return 'trolleybus';
    if (['bus', 'tram', 'metro'].includes(String(route?.type || ''))) return route.type;

    switch (String(route?.route_type || '')) {
      case '0': return 'tram';
      case '1': return 'metro';
      case '11': return 'trolleybus';
      case '3': return 'bus';
      default: return 'bus';
    }
  }

  function getLineDisplayNumber(route, type) {
    const override = getLineOverride(route);
    const source = String(route?.route_short_name || route?.route_ref || '').trim();
    if (override?.route_ref) return String(override.route_ref).trim();
    return type === 'metro' ? source.replace(/^[МM]/i, '') : source;
  }

  function getTransportIcon(type, number) {
    const lineNumber = String(number || '').trim().toUpperCase();
    if (lineNumber === 'X43') return 'Icons/Active icons/torist-bus.svg';
    if (/^N[1-4]$/.test(lineNumber)) return 'Icons/Active icons/night-bus.svg';
    switch (type) {
      case 'bus': return 'Icons/Active icons/bus.svg';
      case 'night': return 'Icons/Active icons/night-bus.svg';
      case 'trolleybus': return 'Icons/Active icons/trolley.svg';
      case 'tram': return 'Icons/Active icons/tram.svg';
      case 'metro': return 'Icons/Active icons/metro.svg';
      default: return '';
    }
  }

  function getLineColor(route, type) {
    const override = getLineOverride(route);
    if (override?.color) {
      return String(override.color).startsWith('#')
        ? String(override.color)
        : `#${override.color}`;
    }
    if (!override?.type && (route?.route_color || route?.bg_color)) {
      return `#${String(route.route_color || route.bg_color).replace(/^#/, '')}`;
    }
    switch (type) {
      case 'bus':
      case 'night': return '#BE1E2D';
      case 'tram': return '#F7941D';
      case 'trolleybus': return '#27AAE1';
      case 'metro': return '#1C75BC';
      default: return '#BE1E2D';
    }
  }

  function getLineMeta(routeId, routeRef) {
    const id = String(routeId ?? '').trim();
    const ref = String(routeRef ?? '').trim();
    const route = (transportData?.routes || []).find(item =>
      String(item?.route_id || item?.cgm_id || '').trim() === id
      || String(item?.route_short_name || item?.route_ref || '').trim() === ref
    ) || null;

    const number = ref || route?.route_short_name || route?.route_ref || '—';
    const type = route ? getLineType(route) : (/^N/i.test(number) ? 'night' : 'bus');
    const displayNumber = route ? getLineDisplayNumber(route, type) : number;

    return {
      id: id || String(route?.route_id || route?.cgm_id || ''),
      number: displayNumber || '—',
      type,
      icon: getTransportIcon(type, displayNumber),
      color: route ? getLineColor(route, type) : '#BE1E2D',
      textColor: route?.route_text_color
        ? `#${String(route.route_text_color).replace(/^#/, '')}`
        : '#FFFFFF'
    };
  }

  function linePillHtml(line) {
    return `<span class="schedule-line-pill${line?.type === 'metro' ? ' metro' : ''}" style="--line-color:${escapeHtml(line?.color || '#BE1E2D')}; --line-text-color:${escapeHtml(line?.textColor || '#FFFFFF')}; background-color:${escapeHtml(line?.color || '#BE1E2D')}; color:${escapeHtml(line?.textColor || '#FFFFFF')};">${escapeHtml(line?.number || '—')}</span>`;
  }

  function lineIdentityHtml(line) {
    const icon = line?.icon
      ? `<span class="schedule-line-icon"><img src="${escapeHtml(line.icon)}" alt="" aria-hidden="true"></span>`
      : '';
    return `<span class="schedule-line-identity">${icon}${linePillHtml(line)}</span>`;
  }

  function destinationHtml(destination) {
    return `<span class="schedule-summary-arrow direction-arrow" aria-hidden="true"><img src="Icons/destinationarrow.svg" alt=""></span><strong class="schedule-summary-destination vb-destination">${escapeHtml(destination || '—')}</strong>`;
  }

  function formatArrivalCountdown(timestamp, nowSeconds = Date.now() / 1000) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return '';
    const remainingSeconds = seconds - nowSeconds;
    if (remainingSeconds < 60) return 'Сега';
    return `${Math.max(1, Math.round(remainingSeconds / 60))} мин.`;
  }

  function formatArrivalClock(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return '—';
    return new Intl.DateTimeFormat('bg-BG', {
      timeZone: SOFIA_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(seconds * 1000));
  }

  function getArrivalMinutes(timestamp) {
    const seconds = Number(timestamp);
    if (!Number.isFinite(seconds)) return null;
    return (seconds - Date.now() / 1000) / 60;
  }

  function countdownHtml(arrival, showLive) {
    const timestamp = Number(arrival?.timestamp);
    if (!Number.isFinite(timestamp)) return '';
    const live = showLive ? '<span class="vb-arrival-live" aria-hidden="true"></span>' : '';
    const countdown = formatArrivalCountdown(timestamp);
    const clock = formatArrivalClock(timestamp);
    return `<div class="vb-arrival-main">${live}<span class="vb-arrival-clock">${escapeHtml(clock)}</span><span class="vb-arrival-separator" aria-hidden="true">·</span><span class="vb-arrival-minutes" data-arrival-timestamp="${timestamp}">${escapeHtml(countdown)}</span></div>`;
  }

  async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { Accept: 'application/json' }
      });
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      return { response, data };
    } finally {
      clearTimeout(timer);
    }
  }

  // 1:1 with Dimitar5555's virtual-board architecture:
  // browser -> Sofia Traffic proxy -> ready routes.
  // There is deliberately NO client-side GTFS/static timetable fallback here.
  async function fetchVirtualBoard(stop) {
    const rawCode = String(stop?.stop_code || stop?.stop_id || '').trim();
    if (!rawCode) throw new Error('Липсва код на спирката.');

    const metro = isMetroStop(stop);
    const stopCodeForUrl = metro
      ? rawCode.replace(/\D/g, '')
      : rawCode;
    if (!stopCodeForUrl) throw new Error('Невалиден код на спирката.');

    const extraParams = metro ? '&metro' : '';
    const url = `${VIRTUAL_BOARD_PROXY_URL}${encodeURIComponent(stopCodeForUrl)}${extraParams}`;
    const { response, data } = await fetchJsonWithTimeout(url);

    if (!response.ok) {
      throw new Error(data?.error || `Virtual board proxy HTTP ${response.status}`);
    }
    if (!data || !Array.isArray(data.routes)) {
      throw new Error('Proxy-ят върна невалиден формат за виртуално табло.');
    }

    const nowSeconds = Date.now() / 1000;
    const routes = data.routes
      .filter(route => route && Array.isArray(route.times))
      .map(route => {
        const times = route.times
          .map(time => {
            const minutes = Number(time?.t);
            if (!Number.isFinite(minutes)) return null;
            return {
              timestamp: nowSeconds + minutes * 60,
              delay: null,
              scheduled: false,
              extras: Array.isArray(time?.extras) ? time.extras : []
            };
          })
          .filter(Boolean)
          .filter(time => time.timestamp >= nowSeconds)
          .sort((a, b) => a.timestamp - b.timestamp)
          .slice(0, 4);

        if (!times.length) return null;
        return {
          route_id: String(route?.route_id || route?.cgm_id || '').trim(),
          route_ref: String(route?.route_ref || '').trim(),
          type: String(route?.type || '').trim(),
          subtype: String(route?.subtype || '').trim(),
          destination: String(route?.destination || '').trim(),
          times,
          source: 'proxy',
          realtime: true
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.times[0].timestamp) - Number(b.times[0].timestamp));

    return {
      status: String(data?.status || (routes.length ? 'ok' : 'empty')),
      generatedAt: data?.generated_at || Date.now(),
      routes
    };
  }

  function renderEmptyBoard() {
    const panel = boardPanel();
    if (!panel) return;
    const favorites = getFavoriteStops();
    const favoritesHtml = favorites.length
      ? `<div class="virtual-board-favorites"><div class="virtual-board-favorites-heading"><h3>Любими спирки</h3></div><div class="virtual-board-favorites-list">${favorites.map(stop => `
          <button type="button" class="virtual-board-favorite-stop" data-stop-id="${escapeHtml(stop.stop_id)}">
            <span class="virtual-board-favorite-stop-star" aria-hidden="true">★</span>
            <span class="virtual-board-favorite-stop-info"><strong>${escapeHtml(stop.stop_name || 'Спирка')}</strong><span>[${escapeHtml(stop.stop_code || stop.stop_id || '')}]</span></span>
            <span class="virtual-board-favorite-stop-arrow" aria-hidden="true">→</span>
          </button>`).join('')}</div></div>`
      : '';

    panel.innerHTML = `<div class="virtual-board-empty"><p>Изберете спирка от картата, за да видите следващите пристигания</p>${favoritesHtml}</div>`;
    panel.querySelectorAll('.virtual-board-favorite-stop').forEach(button => {
      button.addEventListener('click', () => {
        const stop = findStopById(button.dataset.stopId);
        if (stop) selectStopOnMap(stop);
      });
    });
  }

  async function renderStopBoard(stop, boardData = null) {
    const renderToken = ++boardRenderToken;
    selectedStopId = String(stop.stop_id);
    const panel = boardPanel();
    if (!panel) return;

    const favorite = isFavoriteStop(stop.stop_id);
    panel.innerHTML = `
      <div class="virtual-board-header">
        <div>
          <div class="virtual-board-kicker">Спирка ${escapeHtml(stop.stop_code || stop.stop_id || '')}</div>
          <h2>${escapeHtml(stop.stop_name || stop.name || 'Спирка')}</h2>
        </div>
        <div class="virtual-board-header-actions">
          <button type="button" class="virtual-board-refresh is-loading" id="virtualBoardRefresh" disabled aria-label="Обнови таблото" title="Обнови таблото"><span aria-hidden="true">↻</span></button>
          <button type="button" class="virtual-board-favorite${favorite ? ' is-favorite' : ''}" id="virtualBoardFavorite" aria-label="${favorite ? 'Премахни от любими' : 'Добави в любими'}" title="${favorite ? 'Премахни от любими' : 'Добави в любими'}"><span aria-hidden="true">${favorite ? '★' : '☆'}</span></button>
          <button type="button" class="virtual-board-close" id="virtualBoardClose" aria-label="Затвори таблото">×</button>
        </div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-loading">Зареждане…</div></div>
    `;

    document.getElementById('virtualBoardClose')?.addEventListener('click', () => {
      ++boardRenderToken;
      selectedStopId = null;
      if (selectedStopMarker) {
        selectedStopMarker.setStyle({ fillColor: '#111827', color: '#ffffff', fillOpacity: 1 });
        selectedStopMarker = null;
      }
      renderEmptyBoard();
    });

    document.getElementById('virtualBoardFavorite')?.addEventListener('click', event => {
      const button = event.currentTarget;
      const newFavorite = setFavoriteStop(stop);
      button.classList.toggle('is-favorite', newFavorite);
      button.querySelector('span').textContent = newFavorite ? '★' : '☆';
      button.setAttribute('aria-label', newFavorite ? 'Премахни от любими' : 'Добави в любими');
      button.setAttribute('title', newFavorite ? 'Премахни от любими' : 'Добави в любими');
    });

    try {
      const data = boardData || await fetchVirtualBoard(stop);
      if (renderToken !== boardRenderToken || selectedStopId !== String(stop.stop_id)) return;

      const list = panel.querySelector('.virtual-board-list');
      const rows = data.routes
        .map(route => ({
          ...route,
          arrivals: (route.times || [])
            .map(time => ({
              timestamp: Number(time?.timestamp),
              delay: Number.isFinite(Number(time?.delay)) ? Number(time.delay) : null,
              scheduled: Boolean(time?.scheduled),
              extras: time?.extras || []
            }))
            .filter(time => Number.isFinite(time.timestamp))
            .filter(time => getArrivalMinutes(time.timestamp) >= 0)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(0, 4)
        }))
        .filter(route => route.arrivals.length)
        .sort((a, b) => a.arrivals[0].timestamp - b.arrivals[0].timestamp);

      if (data.status !== 'ok' || !rows.length) {
        list.innerHTML = '<div class="virtual-board-no-data">Няма предстоящи заминавания.</div>';
      } else {
        list.innerHTML = rows.map(row => {
          const meta = getLineMeta(row.route_id, row.route_ref);
          const arrivals = row.arrivals;
          const nextTimes = arrivals.slice(1, 4).map(time => {
            const tooltip = formatArrivalCountdown(time.timestamp);
            return `<span class="vb-next-time" tabindex="0" data-arrival-timestamp="${time.timestamp}" data-tooltip="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}">${escapeHtml(formatArrivalClock(time.timestamp))}</span>`;
          }).join('');
          return `
            <article class="vb-row">
              <div class="schedule-summary-route-row vb-route-row">
                ${lineIdentityHtml(meta)}
                ${destinationHtml(row.destination)}
              </div>
              <div class="vb-time-block">
                ${countdownHtml(arrivals[0], true)}
                ${arrivals.length > 1 ? `<div class="vb-next-times">${nextTimes}</div>` : ''}
              </div>
            </article>
          `;
        }).join('');
      }
    } catch (error) {
      if (renderToken !== boardRenderToken || selectedStopId !== String(stop.stop_id)) return;
      console.error('Virtual board proxy error:', error);
      panel.querySelector('.virtual-board-list').innerHTML = '<div class="virtual-board-error">Данните за виртуалното табло не могат да бъдат заредени.</div>';
    } finally {
      if (renderToken !== boardRenderToken || selectedStopId !== String(stop.stop_id)) return;
      const refreshButton = document.getElementById('virtualBoardRefresh');
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.classList.remove('is-loading');
        refreshButton.onclick = () => refreshSelectedBoard(true);
      }
    }
  }

  function selectStopOnMap(stop) {
    if (!stop || !map) return;
    if (selectedStopMarker) {
      selectedStopMarker.setStyle({ fillColor: '#111827', color: '#ffffff', fillOpacity: 1 });
    }
    const lat = Number(stop.stop_lat);
    const lon = Number(stop.stop_lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const marker = stopMarkersById.get(String(stop.stop_id));
    if (marker) {
      marker.setStyle({ fillColor: '#BE1E2D', color: '#ffffff', fillOpacity: 1 });
      selectedStopMarker = marker;
    }

    renderStopBoard(stop);
    map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
  }

  function setupStopSearch(stops) {
    const input = document.getElementById('stopSearch');
    const results = document.getElementById('stopSearchResults');
    if (!input || !results) return;

    const normalize = value => String(value || '')
      .toLocaleLowerCase('bg-BG')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const searchStops = query => {
      const needle = normalize(query).trim();
      if (!needle) return [];
      const seen = new Set();
      return stops
        .filter(stop => {
          const name = normalize(stop?.name || stop?.stop_name);
          const code = normalize(stop?.stop_code || stop?.stop_id);
          return name.includes(needle) || code.includes(needle);
        })
        .filter(stop => {
          const key = String(stop?.stop_code || stop?.stop_id || '').trim();
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 8);
    };

    const renderResults = matches => {
      results.innerHTML = matches.length
        ? matches.map(stop => `<button type="button" class="virtual-stop-search-result" data-stop-id="${escapeHtml(stop.stop_id)}"><strong>${escapeHtml(stop.name || stop.stop_name || 'Спирка')}</strong><span>${escapeHtml(stop.stop_code || stop.stop_id || '')}</span></button>`).join('')
        : '<div class="virtual-stop-search-empty">Няма намерени спирки.</div>';
      results.hidden = false;

      results.querySelectorAll('[data-stop-id]').forEach(button => {
        button.addEventListener('click', () => {
          const stop = findStopById(button.dataset.stopId);
          if (!stop) return;
          input.value = stop.name || stop.stop_name || '';
          results.hidden = true;
          selectStopOnMap(stop);
        });
      });
    };

    input.addEventListener('input', () => {
      const query = input.value.trim();
      if (!query) {
        results.hidden = true;
        results.innerHTML = '';
        return;
      }
      renderResults(searchStops(query));
    });
    input.addEventListener('focus', () => {
      if (input.value.trim()) renderResults(searchStops(input.value));
    });
    document.addEventListener('click', event => {
      if (!event.target.closest('.virtual-stop-search')) results.hidden = true;
    });
  }

  function setupGeolocation() {
    const button = document.getElementById('locateUserButton');
    if (!button) return;

    const locate = () => {
      if (!navigator.geolocation) {
        window.alert('Този браузър не поддържа определяне на локация.');
        return;
      }
      button.disabled = true;
      button.classList.add('is-loading');
      navigator.geolocation.getCurrentPosition(
        position => {
          const lat = position.coords.latitude;
          const lon = position.coords.longitude;
          if (!userMarker) {
            userMarker = L.circleMarker([lat, lon], {
              radius: 8,
              weight: 3,
              color: '#ffffff',
              fillColor: '#2563eb',
              fillOpacity: 1
            }).addTo(map);
            userMarker.bindTooltip('Вашата локация', { direction: 'top', offset: [0, -8] });
          } else {
            userMarker.setLatLng([lat, lon]);
          }
          map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
          button.disabled = false;
          button.classList.remove('is-loading');
        },
        error => {
          console.warn('Грешка при определяне на локацията:', error);
          button.disabled = false;
          button.classList.remove('is-loading');
          window.alert('Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    };
    button.addEventListener('click', locate);
  }

  function addStopMarkers(stops) {
    stopMarkers.clearLayers();
    stopMarkersById.clear();
    selectedStopMarker = null;
    const renderer = L.svg();

    for (const stop of stops) {
      const lat = Number(stop.stop_lat);
      const lon = Number(stop.stop_lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

      const clickTarget = L.circleMarker([lat, lon], {
        radius: 16,
        weight: 0,
        stroke: false,
        fillColor: '#111827',
        fillOpacity: 0.01,
        renderer,
        pane: 'markerPane'
      });
      const marker = L.circleMarker([lat, lon], {
        radius: 7,
        weight: 2,
        color: '#ffffff',
        fillColor: '#111827',
        fillOpacity: 1,
        renderer,
        pane: 'markerPane'
      });

      const tooltip = escapeHtml(stop.name || stop.stop_name || 'Спирка');
      marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -5] });
      clickTarget.bindTooltip(tooltip, { direction: 'top', offset: [0, -12] });
      const select = () => selectStopOnMap(stop);
      clickTarget.on('click', select);
      marker.on('click', select);
      clickTarget.addTo(stopMarkers);
      marker.addTo(stopMarkers);
      stopMarkersById.set(String(stop.stop_id), marker);
    }
  }

  function getActiveStops(stops) {
    // Use the local GTFS only for map/search metadata. It is NOT used for
    // virtual-board arrival generation or fallback.
    return stops.filter(stop => String(stop?.location_type ?? '0') === '0');
  }

  function initMap(stops) {
    if (typeof L === 'undefined') {
      const el = document.getElementById('virtualMap');
      if (el) el.innerHTML = '<div class="virtual-map-error">Картата не може да бъде заредена.</div>';
      return;
    }

    map = L.map('virtualMap', {
      center: SOFIA_CENTER,
      zoom: 12,
      minZoom: 10,
      preferCanvas: true,
      zoomControl: true
    });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    stopMarkers = L.layerGroup().addTo(map);
    addStopMarkers(stops);
    setTimeout(() => map.invalidateSize(), 100);
  }

  function updateBoardCountdowns() {
    const panel = boardPanel();
    if (!panel || !selectedStopId) return;
    const nowSeconds = Date.now() / 1000;
    panel.querySelectorAll('[data-arrival-timestamp]').forEach(element => {
      const timestamp = Number(element.dataset.arrivalTimestamp);
      if (!Number.isFinite(timestamp)) return;
      const countdown = formatArrivalCountdown(timestamp, nowSeconds);
      if (element.classList.contains('vb-arrival-minutes')) {
        element.textContent = countdown;
      } else {
        element.dataset.tooltip = countdown;
        element.setAttribute('aria-label', countdown);
      }
    });
  }

  async function refreshSelectedBoard(force = false) {
    if (!selectedStopId || refreshInFlight) return;
    const stop = findStopById(selectedStopId);
    if (!stop) return;

    const button = document.getElementById('virtualBoardRefresh');
    button?.classList.add('is-loading');
    if (button) button.disabled = true;
    refreshInFlight = true;

    try {
      const data = await fetchVirtualBoard(stop);
      await renderStopBoard(stop, data);
    } catch (error) {
      console.error('Неуспешно зареждане на виртуалното табло:', error);
      if (force && selectedStopId === String(stop.stop_id)) {
        const list = boardPanel()?.querySelector('.virtual-board-list');
        if (list) list.innerHTML = '<div class="virtual-board-error">Данните за виртуалното табло не могат да бъдат заредени.</div>';
      }
    } finally {
      refreshInFlight = false;
      if (selectedStopId === String(stop.stop_id)) {
        const refreshButton = document.getElementById('virtualBoardRefresh');
        if (refreshButton) {
          refreshButton.disabled = false;
          refreshButton.classList.remove('is-loading');
        }
      }
    }
  }

  function startTimers() {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    countdownTimer = setInterval(updateBoardCountdowns, 1000);
    refreshTimer = setInterval(() => {
      if (selectedStopId) refreshSelectedBoard();
    }, REFRESH_MS);
    updateBoardCountdowns();
  }

  async function initializeVirtualBoards() {
    try {
      transportData = await loadTransportData();
      const allStops = Array.isArray(transportData?.stops) ? transportData.stops : [];
      const stops = getActiveStops(allStops);
      initMap(stops);
      setupStopSearch(stops);
      setupGeolocation();
      renderEmptyBoard();

      const requestedStopId = new URLSearchParams(window.location.search).get('stop');
      if (requestedStopId) {
        const requestedStop = findStopById(requestedStopId);
        if (requestedStop) selectStopOnMap(requestedStop);
      }
      startTimers();
    } catch (error) {
      console.error('Неуспешно зареждане на GTFS за виртуалните табла:', error);
      const panel = boardPanel();
      if (panel) {
        panel.innerHTML = `<div class="virtual-board-error"><strong>Виртуалното табло не може да бъде заредено.</strong><span>${escapeHtml(error.message || 'Неизвестна грешка.')}</span></div>`;
      }
    }
  }

  document.addEventListener('DOMContentLoaded', initializeVirtualBoards);
})();
