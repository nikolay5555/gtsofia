(() => {
  const REFRESH_MS = 15000;
  const SOFIA_CENTER = [42.6977, 23.3219];
  const VIRTUAL_BOARD_SETTINGS_KEY = 'gtsofia.virtualBoardSettings.v1';

  let transportData = null;
  let map = null;
  let markerLayer = null;
  let markerByStopCode = new Map();
  let selectedStop = null;
  let refreshTimer = null;
  let countdownTimer = null;
  let refreshInFlight = false;
  let lastBoard = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function loadSettings() {
    try {
      const settings = JSON.parse(localStorage.getItem(VIRTUAL_BOARD_SETTINGS_KEY) || '{}');
      return {
        show_condensed_view: settings.show_condensed_view !== false,
        use_exact_times: settings.use_exact_times === true
      };
    } catch {
      return { show_condensed_view: true, use_exact_times: false };
    }
  }

  function saveSettings() {
    const settings = {
      show_condensed_view: document.getElementById('virtualBoardCondensed')?.checked !== false,
      use_exact_times: document.getElementById('virtualBoardExactTime')?.checked === true
    };
    localStorage.setItem(VIRTUAL_BOARD_SETTINGS_KEY, JSON.stringify(settings));
  }

  function formatTime(minutes) {
    const total = Math.max(0, Math.floor(Number(minutes)));
    const hour = Math.floor(total / 60) % 24;
    const minute = total % 60;
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  function linePillHtml(route) {
    const bg = getLineColor(route);
    const text = getLineTextColor(route);
    const display = getLineDisplayNumber(route);
    const metro = getLineType(route) === 'metro';
    return `<span class="schedule-line-pill${metro ? ' metro' : ''}" style="background:${escapeHtml(bg)};color:${escapeHtml(text)}">${escapeHtml(display)}</span>`;
  }

  function appendExtras(extras, container) {
    const value = String(extras || '000');
    const icons = [
      ['snow', value[0] === '1', 'Климатик'],
      ['person-wheelchair', value[1] === '1', 'Достъпно за хора с инвалидни колички'],
      ['bicycle', value[2] === '1', 'Възможност за велосипеди']
    ];
    const active = icons.filter(icon => icon[1]);
    if (!active.length) return;
    const span = document.createElement('span');
    span.className = 'text-nowrap';
    span.title = active.map(icon => icon[2]).join(', ');
    for (const [icon] of active) {
      const element = document.createElement('i');
      element.className = `bi bi-${icon}`;
      span.appendChild(element);
      span.appendChild(document.createTextNode(' '));
    }
    span.lastChild?.remove();
    container.appendChild(document.createTextNode(' '));
    container.appendChild(span);
  }

  function exactTimeForRelative(relativeMinutes) {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes() + Number(relativeMinutes || 0);
    return formatTime(minutes);
  }

  function renderTimeSpan(time) {
    const relative = `${Number(time?.t ?? 0)} мин.`;
    const exact = exactTimeForRelative(time?.t ?? 0);
    const settings = loadSettings();
    const span = document.createElement('span');
    span.className = 'vb-time-value';
    span.dataset.relativeTime = relative;
    span.dataset.exactTime = exact;
    span.textContent = settings.use_exact_times ? exact : relative;
    return span;
  }

  function renderRouteRow(route, generatedAt, verbose = false) {
    const row = document.createElement('div');
    row.className = 'vb-row';

    const routeRow = document.createElement('div');
    routeRow.className = 'vb-route-row';

    const identity = document.createElement('span');
    identity.className = 'schedule-line-identity';
    identity.innerHTML = linePillHtml(route);
    routeRow.appendChild(identity);

    const arrow = document.createElement('img');
    arrow.className = 'vb-direction-arrow';
    arrow.src = 'Icons/destinationarrow.svg';
    arrow.alt = '';
    arrow.setAttribute('aria-hidden', 'true');
    routeRow.appendChild(arrow);

    const destination = document.createElement('span');
    destination.className = 'vb-destination';
    destination.textContent = route.destination || '—';
    routeRow.appendChild(destination);

    if (verbose) {
      const times = document.createElement('div');
      times.className = 'vb-verbose-times';
      for (const time of route.times || []) {
        const item = document.createElement('span');
        item.className = 'vb-verbose-time';
        item.appendChild(renderTimeSpan(time));
        appendExtras(time.extras, item);
        times.appendChild(item);
      }
      routeRow.appendChild(times);
    }

    row.appendChild(routeRow);

    if (!verbose) {
      const timeBlock = document.createElement('div');
      timeBlock.className = 'vb-time-block';
      for (const time of (route.times || []).slice(0, 3)) {
        const item = document.createElement('span');
        item.className = 'vb-arrival-main';
        const live = document.createElement('span');
        live.className = 'vb-arrival-live';
        live.setAttribute('aria-hidden', 'true');
        item.appendChild(live);
        const span = renderTimeSpan(time);
        span.classList.add('vb-arrival-clock');
        span.dataset.arrivalMinutes = String(time?.t ?? 0);
        item.appendChild(span);
        appendExtras(time.extras, item);
        timeBlock.appendChild(item);
      }
      while (timeBlock.children.length < 3) {
        const placeholder = document.createElement('span');
        placeholder.textContent = '—';
        placeholder.className = 'vb-arrival-main vb-arrival-placeholder';
        timeBlock.appendChild(placeholder);
      }
      row.appendChild(timeBlock);
    }
    return row;
  }

  function renderBoardRoutes(routes, generatedAt) {
    const body = document.getElementById('virtualBoardBody');
    const settings = loadSettings();
    body.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'virtual-board-header';
    header.innerHTML = `
      <div>
        <div class="virtual-board-kicker">Виртуално табло</div>
        <h2>${escapeHtml(getStopName(selectedStop, 'bg', true))}</h2>
        <p>[${escapeHtml(formatStopCode(selectedStop.code))}] · обновено ${escapeHtml(formatGeneratedAt(generatedAt))}</p>
      </div>
      <div class="virtual-board-header-actions">
        <button type="button" class="virtual-board-refresh" id="virtualBoardRefresh" aria-label="Обнови таблото" title="Обнови таблото"><span aria-hidden="true">↻</span></button>
      </div>`;
    body.appendChild(header);

    const list = document.createElement('div');
    list.className = 'virtual-board-list';

    if (!routes?.length) {
      list.innerHTML = `
        <div class="virtual-board-empty">
          <div class="virtual-board-empty-title">Няма текущи пристигащи превозни средства</div>
          <p>GTFS-Realtime не подава следващи пристигания за тази спирка в момента.</p>
        </div>`;
    } else if (settings.show_condensed_view) {
      routes.forEach(route => list.appendChild(renderRouteRow(route, generatedAt, false)));
    } else {
      routes.forEach(route => {
        for (const time of route.times || []) {
          list.appendChild(renderRouteRow({ ...route, times: [time] }, generatedAt, true));
        }
      });
    }

    body.appendChild(list);
    document.getElementById('virtualBoardRefresh')?.addEventListener('click', () => refreshSelectedBoard(true));
  }

  function formatGeneratedAt(value) {
    const date = new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }

  function updateRelativeTimes() {
    const now = Date.now();
    const currentMinute = new Date(now);
    const settings = loadSettings();
    document.querySelectorAll('.vb-time-value').forEach(span => {
      const relativeMinutes = Number(span.dataset.relativeTime?.split(' ')[0]);
      if (!Number.isFinite(relativeMinutes)) return;
      const target = now + relativeMinutes * 60000;
      const remaining = Math.max(0, Math.round((target - now) / 60000));
      const exact = formatTime(currentMinute.getHours() * 60 + currentMinute.getMinutes() + relativeMinutes);
      span.textContent = settings.use_exact_times ? exact : `${remaining} мин.`;
    });
  }

  function selectStopOnMap(stop) {
    selectedStop = stop;
    markerByStopCode.forEach(marker => marker.setStyle({ weight: 2, radius: 7 }));
    markerByStopCode.get(String(stop.code))?.setStyle({ weight: 4, radius: 9 });
    renderLoadingBoard();
    refreshSelectedBoard(true);
    const url = new URL(window.location.href);
    url.searchParams.set('stop', stop.code);
    history.replaceState(null, '', url);
  }

  function renderLoadingBoard() {
    const body = document.getElementById('virtualBoardBody');
    body.innerHTML = `
      <div class="virtual-board-header">
        <div><div class="virtual-board-kicker">Виртуално табло</div><h2>${escapeHtml(getStopName(selectedStop, 'bg', true))}</h2><p>[${escapeHtml(formatStopCode(selectedStop.code))}]</p></div>
      </div>
      <div class="virtual-board-list"><div class="virtual-board-empty">Зареждане…</div></div>`;
  }

  function renderError(message) {
    const body = document.getElementById('virtualBoardBody');
    body.innerHTML = `<div class="virtual-board-error"><strong>Виртуалното табло не може да бъде обновено.</strong><p>${escapeHtml(message || 'Неизвестна грешка.')}</p></div>`;
  }

  async function fetchVirtualBoard(stop) {
    const code = String(stop?.code || '').trim();
    if (!code) throw new Error('Липсва код на спирката.');
    const response = await fetch(`api/virtual-board?stop_code=${encodeURIComponent(code)}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store'
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || `Realtime API върна ${response.status}.`);
    return payload;
  }

  async function refreshSelectedBoard(force = false) {
    if (!selectedStop || refreshInFlight) return;
    refreshInFlight = true;
    document.getElementById('virtualBoardRefresh')?.classList.add('is-loading');
    try {
      const payload = await fetchVirtualBoard(selectedStop);
      lastBoard = payload;
      if (selectedStop) renderBoardRoutes(Array.isArray(payload.routes) ? payload.routes : [], payload.generated_at);
    } catch (error) {
      console.error('Virtual board error:', error);
      if (!lastBoard || force) renderError(error.message);
    } finally {
      refreshInFlight = false;
      document.getElementById('virtualBoardRefresh')?.classList.remove('is-loading');
    }
  }

  function searchStops(query) {
    const q = String(query || '').trim().toLocaleUpperCase('bg-BG');
    if (!q) return [];
    const codeQuery = q.replace(/^М/, 'M');
    const results = [];
    for (const stop of transportData.stops || []) {
      const code = String(stop.code || '').toUpperCase();
      const name = String(stop.names?.bg || '').toLocaleUpperCase('bg-BG');
      const en = String(stop.names?.en || '').toLocaleUpperCase('bg-BG');
      if (code.includes(codeQuery) || name.includes(q) || en.includes(q)) results.push(stop);
      if (results.length >= 12) break;
    }
    return results;
  }

  function setupSearch() {
    const input = document.getElementById('stopSearch');
    const results = document.getElementById('stopSearchResults');
    const render = items => {
      results.innerHTML = '';
      if (!items.length) {
        results.innerHTML = input.value.trim() ? '<div class="virtual-stop-search-empty">Няма намерени спирки.</div>' : '';
        results.hidden = !input.value.trim();
        return;
      }
      for (const stop of items) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'virtual-stop-search-result';
        button.innerHTML = `<strong>${escapeHtml(stop.names?.bg || 'Спирка')}</strong><span>${escapeHtml(stop.code)}</span>`;
        button.addEventListener('click', () => {
          results.hidden = true;
          input.value = `${stop.code} ${stop.names?.bg || ''}`.trim();
          selectStopOnMap(stop);
          map?.flyTo(stop.coords, 17, { animate: false });
          markerByStopCode.get(String(stop.code))?.openTooltip();
        });
        results.appendChild(button);
      }
      results.hidden = false;
    };
    input.addEventListener('input', () => render(searchStops(input.value)));
    document.addEventListener('click', event => {
      if (!event.target.closest('.virtual-stop-search')) results.hidden = true;
    });
  }

  function setupMap() {
    if (typeof L === 'undefined') {
      document.getElementById('virtualMap').innerHTML = '<div class="virtual-map-error">Картата не може да бъде заредена.</div>';
      return;
    }
    map = L.map('virtualMap', { center: SOFIA_CENTER, zoom: 12, minZoom: 10, zoomControl: true, preferCanvas: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);

    for (const stop of transportData.stops || []) {
      const lat = Number(stop.coords?.[0]);
      const lon = Number(stop.coords?.[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const marker = L.circleMarker([lat, lon], {
        radius: 7,
        weight: 2,
        color: '#ffffff',
        fillColor: '#111827',
        fillOpacity: 1
      });
      marker.bindTooltip(`[${formatStopCode(stop.code)}] ${getStopName(stop, 'bg', true)}`, { direction: 'top', offset: [0, -5] });
      marker.on('click', () => selectStopOnMap(stop));
      marker.addTo(markerLayer);
      markerByStopCode.set(String(stop.code), marker);
    }
    setTimeout(() => map.invalidateSize(), 100);
  }

  function setupGeolocation() {
    const button = document.getElementById('locateUserButton');
    if (!button) return;
    button.addEventListener('click', () => {
      if (!navigator.geolocation) {
        window.alert('Този браузър не поддържа определяне на локация.');
        return;
      }
      button.disabled = true;
      navigator.geolocation.getCurrentPosition(
        position => {
          button.disabled = false;
          map?.flyTo([position.coords.latitude, position.coords.longitude], 15);
        },
        () => {
          button.disabled = false;
          window.alert('Не успяхме да определим вашата локация. Проверете разрешението за достъп до местоположението.');
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
    });
  }

  function setupSettings() {
    const settings = loadSettings();
    const condensed = document.getElementById('virtualBoardCondensed');
    const exact = document.getElementById('virtualBoardExactTime');
    if (condensed) condensed.checked = settings.show_condensed_view;
    if (exact) exact.checked = settings.use_exact_times;
    [condensed, exact].forEach(input => input?.addEventListener('change', () => {
      saveSettings();
      if (selectedStop && lastBoard) renderBoardRoutes(lastBoard.routes || [], lastBoard.generated_at);
    }));
  }

  function startTimers() {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refreshTimer = setInterval(() => {
      if (selectedStop) refreshSelectedBoard(false);
    }, REFRESH_MS);
    countdownTimer = setInterval(updateRelativeTimes, 1000);
  }

  async function initialize() {
    try {
      transportData = await loadTransportData();
      setupSettings();
      setupMap();
      setupSearch();
      setupGeolocation();

      const requestedCode = new URLSearchParams(window.location.search).get('stop');
      if (requestedCode) {
        const stop = getStop(requestedCode, transportData.stops);
        if (stop) {
          selectedStop = stop;
          markerByStopCode.get(String(stop.code))?.setStyle({ weight: 4, radius: 9 });
          map?.flyTo(stop.coords, 17, { animate: false });
          renderLoadingBoard();
          await refreshSelectedBoard(true);
          document.getElementById('stopSearch').value = `${stop.code} ${stop.names?.bg || ''}`.trim();
        }
      }
      if (!selectedStop) {
        document.getElementById('virtualBoardBody').innerHTML = `
          <div class="virtual-board-empty">
            <div class="virtual-board-empty-title">Изберете спирка</div>
            <p>Изберете спирка от картата или потърсете по код/име, за да видите следващите пристигания.</p>
          </div>`;
      }
      startTimers();
    } catch (error) {
      console.error('Неуспешно зареждане на transport data:', error);
      renderError(error.message);
    }
  }

  document.addEventListener('DOMContentLoaded', initialize);
})();
