// application bootstrap and state controllers

// state and config
let map;
let aircraftMarkers = {};
let selectedHex     = null;
let showTrails      = true;

let lastSuccessfulTelemetry = null;
let telemetryFailures = 0;
let activeEmergencies = [];

// flight profile altitude history and chart
const altitudeHistory = {};
let profileChart = null;

const STATION_COORDS = [37.7749, -122.3194];
const tempHistory    = [];
const MAX_HISTORY    = 60;

// anomaly thresholds
const ANOMALY = {
  ALT_FLOOR:        0,
  VRATE_EXTREME:    4000,
  SEEN_WARN_SEC:    5,
  SEEN_CRITICAL_SEC: 20,
  SEEN_PURGE_SEC:   40,
  SQUAWK_EMERGENCY: ['7500', '7600', '7700'],
};

// detect mobile / phone device via touch, user agent, or screen width
function isMobileDevice() {
  if (typeof window === 'undefined') return false;
  const hasTouch = Boolean(
    (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 0)
  );
  const isNarrow = window.innerWidth <= 900;
  const isMobileUA = Boolean(
    navigator.userAgent &&
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  );
  return (isNarrow && hasTouch) || isMobileUA || isNarrow;
}

// mobile sheet controls
function collapseSheet() {
  const sidebar = document.getElementById('sidebar');
  const handleBar = document.getElementById('sheet-handle-bar');
  const btnText = document.getElementById('sheet-toggle-text');
  if (sidebar) sidebar.classList.add('sheet-collapsed');
  if (handleBar) handleBar.setAttribute('aria-expanded', 'false');
  if (btnText) btnText.textContent = 'EXPAND';
  if (map) setTimeout(() => map.invalidateSize(), 180);
}

function expandSheet() {
  const sidebar = document.getElementById('sidebar');
  const handleBar = document.getElementById('sheet-handle-bar');
  const btnText = document.getElementById('sheet-toggle-text');
  if (sidebar) sidebar.classList.remove('sheet-collapsed');
  if (handleBar) handleBar.setAttribute('aria-expanded', 'true');
  if (btnText) btnText.textContent = 'DISMISS';
  if (map) setTimeout(() => map.invalidateSize(), 180);
}

function toggleMobileSheet(e) {
  if (e) e.stopPropagation();
  if (!isMobileDevice()) return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('sheet-collapsed')) {
    expandSheet();
  } else {
    collapseSheet();
  }
}

// synchronize UI classes to current viewport / device mode
function applyDeviceMode() {
  const isMobile = isMobileDevice();
  const sidebar = document.getElementById('sidebar');
  if (isMobile) {
    document.body.classList.add('is-mobile');
    if (sidebar && !selectedHex) {
      collapseSheet();
    }
  } else {
    document.body.classList.remove('is-mobile');
    if (sidebar) {
      sidebar.classList.remove('sheet-collapsed');
    }
  }
  if (map) {
    setTimeout(() => map.invalidateSize(), 150);
  }
}

// initialize tabular ticker slots
function initTickerSlots() {
  document.querySelectorAll('.field-val, .stat-num, .metric-val, .tactical-stat-val, .sparkline-stat-val').forEach((el) => {
    el.classList.add('ticker-slot');
    const txt = el.textContent.trim();
    if (txt) {
      el.innerHTML = `<span class="ticker-view">${txt}</span>`;
      el._animTarget = txt;
    }
  });
}

// set field text and anomaly states
function setField(id, text, anomalyClass) {
  const el = document.getElementById(id);
  if (!el) return;

  const targetStr = String(text ?? '').trim();

  // update anomaly state
  const currentAnomaly = el.classList.contains('val-anomaly') ? 'val-anomaly'
                       : el.classList.contains('val-warn') ? 'val-warn'
                       : el.classList.contains('val-stale') ? 'val-stale'
                       : null;
  if (currentAnomaly !== anomalyClass) {
    el.classList.remove('val-anomaly', 'val-warn', 'val-stale');
    if (anomalyClass) el.classList.add(anomalyClass);
  }

  // update container alert state
  const cardParent = el.closest('.field, .metric-card, .radar-stat');
  if (cardParent) {
    const currentCardAlert = cardParent.classList.contains('field-alert-anomaly') ? 'field-alert-anomaly'
                           : cardParent.classList.contains('field-alert-warn') ? 'field-alert-warn'
                           : cardParent.classList.contains('field-alert-stale') ? 'field-alert-stale'
                           : null;

    const targetCardAlert = anomalyClass === 'val-anomaly' ? 'field-alert-anomaly'
                          : anomalyClass === 'val-warn' ? 'field-alert-warn'
                          : anomalyClass === 'val-stale' ? 'field-alert-stale'
                          : null;

    if (currentCardAlert !== targetCardAlert) {
      cardParent.classList.remove('field-alert-anomaly', 'field-alert-warn', 'field-alert-stale');
      if (targetCardAlert) {
        void cardParent.offsetHeight;
        cardParent.classList.add(targetCardAlert);
      }
    }
  }

  if (el._animTarget === targetStr) return;
  el._animTarget = targetStr;

  el.classList.add('ticker-slot');

  let view = el.querySelector('.ticker-view');
  if (!view) {
    el.innerHTML = '';
    view = document.createElement('span');
    view.className = 'ticker-view';
    el.appendChild(view);
    view.textContent = targetStr;
    return;
  }

  // in-place tabular update
  view.textContent = targetStr;
}

// telemetry heartbeat state (green when online, red when offline)
function setHeartbeatState(isOnline) {
  const dot = document.getElementById('stream-heartbeat-dot');
  if (!dot) return;
  if (isOnline) {
    dot.classList.remove('stale');
  } else {
    dot.classList.add('stale');
  }
}

// render global system alerts (emergencies & hardware disconnect)
function updateAlertBanner() {
  const banner = document.getElementById('hud-alert-banner');
  const container = document.getElementById('hud-alert-content');
  if (!banner || !container) return;

  const alerts = [];

  // 1. Station Disconnect alert: Pi offline / heartbeat lost
  const isDisconnected = (lastSuccessfulTelemetry !== null && (telemetryFailures >= 3 || Date.now() - lastSuccessfulTelemetry > 4000))
                      || (lastSuccessfulTelemetry === null && telemetryFailures >= 4);

  if (isDisconnected) {
    alerts.push(`
      <div class="alert-item alert-warn">
        <div class="alert-item-body">
          <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span class="alert-tag">Station Disconnected</span>
          <span class="alert-text">Telemetry heartbeat lost</span>
        </div>
      </div>
    `);
  }

  // 2. Active Aircraft Squawk Emergencies
  if (activeEmergencies && activeEmergencies.length > 0) {
    activeEmergencies.forEach((ac) => {
      const sq = String(ac.squawk);
      const emergencyLabel = sq === '7700' ? 'General Emergency'
                           : sq === '7600' ? 'Radio Failure (NORDO)'
                           : sq === '7500' ? 'Unlawful Interference (Hijack)'
                           : 'Emergency';
      const callsign = ac.flight ? ac.flight.trim() : String(ac.hex || '').toUpperCase();
      const altStr = (ac.alt_baro !== null && ac.alt_baro !== undefined && !isNaN(ac.alt_baro))
        ? `${Number(ac.alt_baro).toLocaleString()} FT` : 'ALT UNK';
      const speedStr = (ac.speed !== null && ac.speed !== undefined && !isNaN(ac.speed))
        ? `${Math.round(ac.speed)} KT` : 'SPD UNK';

      alerts.push(`
        <div class="alert-item alert-danger">
          <div class="alert-item-body">
            <svg class="alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
              <line x1="12" y1="9" x2="12" y2="13"></line>
              <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
            <span class="alert-tag">Emergency Squawk ${sq}</span>
            <span class="alert-text">${callsign} declaring ${emergencyLabel} (${altStr}, ${speedStr})</span>
          </div>
          <button class="alert-action-btn" type="button" data-focus-hex="${ac.hex}">Track on Radar</button>
        </div>
      `);
    });
  }

  if (alerts.length > 0) {
    container.innerHTML = alerts.join('');
    banner.style.display = 'flex';

    container.querySelectorAll('button[data-focus-hex]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const hex = btn.getAttribute('data-focus-hex');
        const radarTab = document.querySelector('.nav-tab[data-tab="tab-radar"]');
        if (radarTab) radarTab.click();
        setTimeout(() => {
          selectTarget(hex);
          const target = aircraftMarkers[hex]?.data;
          if (target && map) map.panTo([target.lat, target.lon]);
        }, 150);
      });
    });
  } else {
    banner.style.display = 'none';
    container.innerHTML = '';
  }
}

// initialize leaflet map
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView(STATION_COORDS, 9);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'dark-tiles',
  }).addTo(map);

  // deselect target on raw map click only
  map.on('click', (e) => {
    if (e && e.originalEvent && e.originalEvent.target) {
      const target = e.originalEvent.target;
      if (target.closest('.radar-overlay-bar, .leaflet-control, .sidebar, button, input, a, [role="button"]')) {
        return;
      }
    }
    if (selectedHex) {
      clearSidebar();
      refreshMarkerIcons();
    }
  });
}

// create plane marker icon
function createPlaneIcon(heading = 0, isSelected = false, squawk = '----', isStale = false, isWarn = false) {
  const isEmergency = ANOMALY.SQUAWK_EMERGENCY.includes(String(squawk));
  let statusClass = '';
  if (isSelected) {
    statusClass = 'selected';
  } else if (isEmergency) {
    statusClass = 'emergency';
  } else if (isStale) {
    statusClass = 'stale';
  } else if (isWarn) {
    statusClass = 'warn';
  }

  const html = `
    <div style="transform: rotate(${heading}deg); width: 32px; height: 32px;
                display: flex; align-items: center; justify-content: center;">
      <svg class="plane-svg ${statusClass}" viewBox="-4 -4 40 40"
           style="overflow: visible;" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(3.2, -0.9) rotate(-45 16 16)">
          <path d="M12.25 8.719l-0.469 0.469 4 0.344 2.406-2.406c0.375-0.375
            1.063-0.938 2.063-1.563s1.656-0.813 1.906-0.563c0.688 0.688 0
            2.031-2.063 4.063l-2.375 2.375 0.344 4 0.469-0.438c0.375-0.406
            0.781-0.406 1.094-0.094 0.375 0.375 0.219 0.906-0.531
            1.656l-0.75 0.781 0.375 2.688 0.531-0.563c0.344-0.375
            0.719-0.375 1.063-0.063 0.375 0.375 0.313 0.844-0.188
            1.344l-1.125 1.125c0.438 3 0.5 4.688 0.156 5.031-0.156
            0.125-0.375 0.25-0.688 0.313-0.281 0.031-0.531
            0-0.688-0.125-0.125-0.156-0.313-0.719-0.5-1.688-0.219-1-0.75-2.688-1.688-5.063-0.906-2.406-1.563-3.75-1.875-4.094-0.125-0.125-0.313-0.125-0.531
            0-0.219 0.094-1 0.75-2.25 1.969-1.25 1.25-2.406 2.25-3.5
            3.031-0.031 0.188 0.063 0.813 0.219 1.844s0.219 1.719 0.188
            1.969c-0.063 0.25-0.313 0.594-0.719 1-0.219 0.219-0.375
            0.344-0.531 0.375-0.406-0.406-1.031-1.719-1.875-3.875-2.344-1.031-3.625-1.688-3.875-1.938
            0-0.125 0.125-0.313 0.344-0.531 0.406-0.406 0.75-0.656
            1.031-0.688 0.25-0.063 0.906 0.031 1.938 0.219 1.031 0.156
            1.656 0.219 1.875 0.219 0.75-1.125 2.156-2.781
            4.344-4.969 0.625-0.688 0.813-1.125
            0.594-1.344-0.313-0.344-1.688-0.969-4.063-1.875-2.406-0.906-4.063-1.5-5.063-1.688-1-0.219-1.563-0.375-1.688-0.531-0.156-0.125-0.188-0.375-0.125-0.688
            0.031-0.313 0.156-0.531 0.313-0.688 0.313-0.313 2-0.281 5.031
            0.156l1.094-1.125c0.5-0.469 0.969-0.531
            1.344-0.156 0.344 0.313 0.313
            0.688-0.031 1.031l-0.563 0.531 2.688 0.375
            0.75-0.719c0.75-0.75 1.281-0.906 1.656-0.531 0.344 0.344
            0.313 0.688-0.063 1.094z" />
        </g>
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: 'plane-icon-wrapper',
    iconSize:   [24, 24],
    iconAnchor: [16, 16],
  });
}

// poll hardware telemetry
async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) {
      telemetryFailures++;
      setHeartbeatState(false);
      updateAlertBanner();
      return;
    }
    const d = await res.json();
    lastSuccessfulTelemetry = Date.now();
    telemetryFailures = 0;
    setHeartbeatState(true);
    updateAlertBanner();

    // header ribbon
    if (typeof d.cpu_temp_c === 'number' && !isNaN(d.cpu_temp_c)) {
      setField('cpu-temp', `${d.cpu_temp_c.toFixed(1)}°C`);
      updateThermalSparkline(d.cpu_temp_c);
    }
    if (typeof d.cpu_usage_pct === 'number' && !isNaN(d.cpu_usage_pct)) {
      setField('cpu-usage', `${d.cpu_usage_pct.toFixed(0)}%`);
    }
    if (typeof d.memory_used_pct === 'number' && !isNaN(d.memory_used_pct)) {
      setField('ram-usage', `${d.memory_used_pct.toFixed(0)}%`);
    }
    if (typeof d.uptime_hours === 'number' && !isNaN(d.uptime_hours)) {
      setField('node-uptime', `${d.uptime_hours.toFixed(1)}H`);
    }

    // per-core load bars
    if (Array.isArray(d.cpu_per_core)) {
      d.cpu_per_core.forEach((pct, i) => {
        const bar = document.getElementById(`core-bar-${i}`);
        if (bar) {
          bar.style.width = `${Math.min(100, Math.round(pct))}%`;
        }
        setField(`core-val-${i}`, `${Math.round(pct)}%`);
      });
    }

    // system vitals
    setField('telem-freq',  `${d.cpu_freq_mhz || '----'} MHz`);
    setField('telem-procs', String(d.process_count || '---'));
    setField('telem-mem',
      `${d.memory_used_mb} / ${d.memory_total_mb} MB (${d.memory_used_pct}%)`);
    setField('telem-disk',
      `${d.disk_used_gb} / ${d.disk_total_gb} GB (${d.disk_used_pct}%)`);
    setField('telem-net',
      `▲ ${d.net_sent_mb} MB  ▼ ${d.net_recv_mb} MB`);

    if (d.load_avg) {
      setField('telem-load', d.load_avg.map(n => n.toFixed(2)).join(' / '));
    }
  } catch (err) {
    console.warn('Telemetry poll error:', err);
    telemetryFailures++;
    setHeartbeatState(false);
    updateAlertBanner();
  }
}

// update thermal history sparkline
function updateThermalSparkline(temp) {
  if (typeof temp !== 'number' || isNaN(temp)) return;
  tempHistory.push(temp);
  if (tempHistory.length > MAX_HISTORY) tempHistory.shift();

  const poly = document.getElementById('temp-sparkline-line');
  if (!poly) return;

  setField('sparkline-current', `${temp.toFixed(1)}°C`);

  const W = 300, H = 65, MIN_T = 30, MAX_T = 85;

  const points = tempHistory.map((t, i) => {
    const x       = (i / Math.max(1, MAX_HISTORY - 1)) * W;
    const clamped = Math.max(MIN_T, Math.min(MAX_T, t));
    const y       = H - ((clamped - MIN_T) / (MAX_T - MIN_T)) * (H - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  poly.setAttribute('points', points);
}

// poll ads-b contacts
async function fetchAircraft() {
  try {
    const res = await fetch('/api/aircraft');
    if (!res.ok) return;
    const data = await res.json();

    const status      = (data.status || 'UNKNOWN').toUpperCase();
    const rawContacts = data.aircraft || [];
    const contacts    = rawContacts.filter((ac) =>
      typeof ac.seen_sec !== 'number' || isNaN(ac.seen_sec) || ac.seen_sec < ANOMALY.SEEN_PURGE_SEC
    );
    const activeHexes = new Set();
    let   maxDist     = 0;

    updateReceiverBadge(status);

    // update map contacts
    contacts.forEach((ac) => {
      const hex   = ac.hex;
      const lat   = ac.lat;
      const lon   = ac.lon;
      const track = ac.track || 0;
      const isSel   = (hex === selectedHex);
      const isStale = (typeof ac.seen_sec === 'number' && !isNaN(ac.seen_sec) && ac.seen_sec >= ANOMALY.SEEN_CRITICAL_SEC);
      const isWarn  = (!isStale && typeof ac.seen_sec === 'number' && !isNaN(ac.seen_sec) && ac.seen_sec >= ANOMALY.SEEN_WARN_SEC);

      activeHexes.add(hex);
      if (ac.distance_nm && ac.distance_nm > maxDist) maxDist = ac.distance_nm;

      // record live flight profile telemetry
      if (typeof ac.alt_baro === 'number' && !isNaN(ac.alt_baro)) {
        if (!altitudeHistory[hex]) {
          altitudeHistory[hex] = [];
        }
        const hist = altitudeHistory[hex];
        const lastPt = hist[hist.length - 1];
        const nowTs = Date.now();
        if (!lastPt || (nowTs - lastPt.timestamp >= 900)) {
          const nowD = new Date();
          const tLabel = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}:${String(nowD.getSeconds()).padStart(2, '0')}`;
          hist.push({
            alt: ac.alt_baro,
            vrate: ac.vert_rate || 0,
            timestamp: nowTs,
            label: tLabel,
          });
          if (hist.length > 50) hist.shift();
        }
      }

      if (aircraftMarkers[hex]) {
        const entry = aircraftMarkers[hex];
        entry.marker.setLatLng([lat, lon]);
        entry.marker.setIcon(createPlaneIcon(track, isSel, ac.squawk, isStale, isWarn));
        entry.data = ac;

        // append trail coordinates
        const last = entry.trail[entry.trail.length - 1];
        if (!last || last[0] !== lat || last[1] !== lon) {
          entry.trail.push([lat, lon]);
          if (entry.trail.length > 50) entry.trail.shift();
          entry.polyline.setLatLngs(entry.trail);
        }

        if (isSel) updateSidebar(ac);
      } else {
        const marker = L.marker([lat, lon], {
          icon: createPlaneIcon(track, isSel, ac.squawk, isStale, isWarn),
        }).addTo(map);

        const polyline = L.polyline([[lat, lon]], {
          color:     isSel ? '#ffb300' : '#00e5ff',
          weight:    2.5,
          opacity:   showTrails ? 0.45 : 0,
          dashArray: '3, 4',
        }).addTo(map);

        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          selectTarget(hex);
        });

        polyline.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          selectTarget(hex);
        });

        aircraftMarkers[hex] = { marker, polyline, trail: [[lat, lon]], data: ac };
      }
    });

    // purge inactive contacts
    Object.keys(aircraftMarkers).forEach((hex) => {
      if (!activeHexes.has(hex)) {
        map.removeLayer(aircraftMarkers[hex].marker);
        map.removeLayer(aircraftMarkers[hex].polyline);
        delete aircraftMarkers[hex];
        if (selectedHex === hex) clearSidebar();
      }
    });

    // purge untracked altitude histories
    Object.keys(altitudeHistory).forEach((hex) => {
      if (!activeHexes.has(hex) && hex !== selectedHex) {
        delete altitudeHistory[hex];
      }
    });

    // update overlay stats
    setField('hud-max-range',
      maxDist > 0 ? `${maxDist.toFixed(1)} NM` : '-- NM');

    // update table feeds
    updateAircraftTable(contacts, status);

    // detect squawk emergencies (7500, 7600, 7700)
    activeEmergencies = contacts.filter((ac) =>
      ANOMALY.SQUAWK_EMERGENCY.includes(String(ac.squawk))
    );
    updateAlertBanner();
  } catch (err) {
    console.warn('Aircraft poll error:', err);
  }
}

// update receiver status badge
function updateReceiverBadge(status) {
  const badge      = document.getElementById('receiver-status');
  const tableBadge = document.getElementById('table-status-badge');

  const classMap = {
    ONLINE:       'online',
    STANDBY:      'standby',
    INITIALIZING: 'initializing',
    DEGRADED:     'degraded',
    DISCONNECTED: 'disconnected',
    ERROR:        'error',
  };

  const statusClass = classMap[status] || 'disconnected';

  if (badge) {
    badge.textContent = status;
    badge.className   = `metric-val status-badge ${statusClass}`;
  }

  if (tableBadge) {
    tableBadge.textContent = `RECEIVER: ${status}`;
    tableBadge.className   = `target-badge status-badge ${statusClass}`;
  }
}

// refresh markers and breadcrumb trails
function refreshMarkerIcons() {
  Object.keys(aircraftMarkers).forEach((h) => {
    const entry = aircraftMarkers[h];
    const isSel = (h === selectedHex);
    const seen  = entry.data.seen_sec;
    const isStale = (typeof seen === 'number' && !isNaN(seen) && seen >= ANOMALY.SEEN_CRITICAL_SEC);
    const isWarn  = (!isStale && typeof seen === 'number' && !isNaN(seen) && seen >= ANOMALY.SEEN_WARN_SEC);

    entry.marker.setIcon(
      createPlaneIcon(entry.data.track || 0, isSel, entry.data.squawk, isStale, isWarn));

    entry.polyline.setStyle({
      color:   isSel ? '#ffb300' : '#00e5ff',
      opacity: showTrails ? (isSel ? 0.85 : 0.45) : 0,
    });
  });
}

// select target aircraft
function selectTarget(hex) {
  selectedHex = hex;
  const target = aircraftMarkers[hex]?.data;
  if (!target) return;

  refreshMarkerIcons();
  updateSidebar(target);
  fetchAircraftPhoto(hex);

  // update mobile sheet summary bar & auto-expand sheet on mobile
  const sidebar = document.getElementById('sidebar');
  const summaryCallsign = document.getElementById('sheet-summary-callsign');
  const summaryMeta = document.getElementById('sheet-summary-meta');
  const callsignStr = target.flight ? target.flight.trim() : String(hex).toUpperCase();
  const altStr = (target.alt_baro !== null && target.alt_baro !== undefined && !isNaN(target.alt_baro))
    ? `${Number(target.alt_baro).toLocaleString()} FT` : 'ALT UNK';
  const spdStr = (target.speed !== null && target.speed !== undefined && !isNaN(target.speed))
    ? `${Math.round(target.speed)} KT` : 'SPD UNK';

  if (summaryCallsign) summaryCallsign.textContent = callsignStr;
  if (summaryMeta) summaryMeta.textContent = `${altStr} • ${spdStr}`;

  if (sidebar && isMobileDevice()) {
    expandSheet();
  }
}

// update sidebar details
function updateSidebar(ac) {
  if (!ac) return;

  const alt     = ac.alt_baro;
  const vrate   = ac.vert_rate || 0;
  const speed   = ac.speed;
  const seen    = ac.seen_sec;
  const squawk  = ac.squawk || '----';

  const seenVal = (seen !== null && seen !== undefined && !isNaN(Number(seen)))
    ? Number(seen) : null;
  let seenClass = null;
  if (seenVal !== null) {
    if      (seenVal >= ANOMALY.SEEN_CRITICAL_SEC) seenClass = 'val-stale';
    else if (seenVal >= ANOMALY.SEEN_WARN_SEC)     seenClass = 'val-warn';
  }

  let hexAnomaly = null;
  if (ANOMALY.SQUAWK_EMERGENCY.includes(String(squawk))) {
    hexAnomaly = 'val-anomaly';
  } else if (seenClass) {
    hexAnomaly = seenClass;
  }
  setField('target-hex', String(ac.hex || 'NONE').toUpperCase(), hexAnomaly);
  setField('target-callsign', ac.flight || 'NO CALLSIGN');

  const altVal = (alt !== null && alt !== undefined && !isNaN(Number(alt)))
    ? Number(alt) : null;
  const altText = altVal !== null ? `${altVal.toLocaleString()} FT` : '---- FT';
  setField('target-alt', altText,
    (altVal !== null && altVal < ANOMALY.ALT_FLOOR) ? 'val-anomaly' : null);

  const vrateNum = Number(vrate) || 0;
  const vratePrefix = vrateNum > 0 ? `▲ +${vrateNum}` : (vrateNum < 0 ? `▼ ${vrateNum}` : '0');
  setField('target-vrate', `${vratePrefix} FPM`,
    Math.abs(vrateNum) > ANOMALY.VRATE_EXTREME ? 'val-warn' : null);

  const speedVal = (speed !== null && speed !== undefined && !isNaN(Number(speed)))
    ? Number(speed) : null;
  setField('target-speed', speedVal !== null ? `${Math.round(speedVal)} KT` : '--- KT');

  const trackVal = (ac.track !== null && ac.track !== undefined && !isNaN(Number(ac.track)))
    ? Number(ac.track) : null;
  setField('target-track', trackVal !== null ? `${Math.round(trackVal)}°` : '---°');

  setField('target-squawk', squawk,
    ANOMALY.SQUAWK_EMERGENCY.includes(String(squawk)) ? 'val-anomaly' : null);

  const selAltVal = (ac.selected_alt !== null && ac.selected_alt !== undefined && !isNaN(Number(ac.selected_alt)))
    ? Number(ac.selected_alt) : null;
  setField('target-sel-alt', selAltVal !== null ? `${selAltVal.toLocaleString()} FT` : '---- FT');

  const distVal = (ac.distance_nm !== null && ac.distance_nm !== undefined && !isNaN(Number(ac.distance_nm)))
    ? Number(ac.distance_nm) : null;
  setField('target-dist', distVal !== null ? `${distVal.toFixed(1)} NM` : '--.- NM');

  const rssiVal = (ac.rssi !== null && ac.rssi !== undefined && !isNaN(Number(ac.rssi)))
    ? Number(ac.rssi) : null;
  setField('target-rssi', rssiVal !== null ? `${rssiVal.toFixed(1)} dBFS` : '--.- dBFS');

  setField('target-seen', seenVal !== null ? `${seenVal.toFixed(1)} S` : '--.- S', seenClass);

  // update flight profile graph
  updateFlightProfile(ac.hex, ac);
}

// reset sidebar to empty state
function clearSidebar() {
  selectedHex = null;

  const defaults = {
    'target-hex':      'NONE',
    'target-callsign': '----',
    'target-alt':      '---- FT',
    'target-vrate':    '---- FPM',
    'target-speed':    '--- KT',
    'target-track':    '---°',
    'target-squawk':   '----',
    'target-sel-alt':  '---- FT',
    'target-dist':     '--.- NM',
    'target-rssi':     '--.- dBFS',
    'target-seen':     '--.- S',
  };

  Object.entries(defaults).forEach(([id, text]) => {
    setField(id, text);
  });

  const summaryCallsign = document.getElementById('sheet-summary-callsign');
  const summaryMeta = document.getElementById('sheet-summary-meta');
  if (summaryCallsign) summaryCallsign.textContent = 'AIRCRAFT INSPECTOR';
  if (summaryMeta) summaryMeta.textContent = 'SELECT MAP CONTACT';

  clearFlightProfile();

  if (isMobileDevice()) {
    collapseSheet();
  }

  const photoBox = document.getElementById('photo-box');
  if (photoBox) {
    photoBox.innerHTML = `
      <div class="flight-prompt">
        <svg class="flight-prompt-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
        </svg>
        <p class="flight-prompt-title">No aircraft selected</p>
        <p class="flight-prompt-desc">Click any aircraft on the map to view live aircraft data and photos.</p>
      </div>
    `;
  }
}

// fetch aircraft photo from public archive
async function fetchAircraftPhoto(hex) {
  const photoBox = document.getElementById('photo-box');
  if (!photoBox) return;

  photoBox.innerHTML = `
    <div class="photo-placeholder scanning">
      <div class="radar-scan-spinner" aria-hidden="true"></div>
      <span class="photo-status-title">Finding Aircraft Photo</span>
      <span class="photo-status-sub">ICAO: ${hex.toUpperCase()}</span>
    </div>
  `;

  try {
    const res = await fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`);
    if (!res.ok) throw new Error('Photo lookup failed');
    const data = await res.json();

    if (data.photos && data.photos.length > 0) {
      const photo = data.photos[0];
      photoBox.innerHTML = `
        <img src="${photo.thumbnail_large.src}" alt="${hex}">
        <span class="photo-credit">© ${photo.photographer}</span>
      `;
    } else {
      photoBox.innerHTML = `
        <div class="photo-placeholder empty">
          <svg class="photo-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <path d="M3 16l5-5c.9-.9 2.3-.9 3.2 0l5 5"/>
            <path d="M14 14l1-1c.9-.9 2.3-.9 3.2 0l3 3"/>
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
          </svg>
          <span class="photo-status-title">No Photo on File</span>
          <span class="photo-status-sub">Live aircraft data active</span>
        </div>
      `;
    }
  } catch {
    photoBox.innerHTML = `
      <div class="photo-placeholder offline">
        <span class="photo-status-title">Photo Archive Offline</span>
        <span class="photo-status-sub">Live aircraft data active</span>
      </div>
    `;
  }
}

// initialize flight profile altitude line chart (Chart.js)
function initFlightProfileChart() {
  const canvas = document.getElementById('altitude-profile-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  try {
    const ctx = canvas.getContext('2d');
    profileChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: [],
        datasets: [{
          data: [],
          borderColor: '#38bdf8',
          borderWidth: 1.75,
          backgroundColor: (context) => {
            const chart = context.chart;
            const { ctx: c, chartArea } = chart;
            if (!chartArea) return 'rgba(56, 189, 248, 0.08)';
            const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
            gradient.addColorStop(0, 'rgba(56, 189, 248, 0.22)');
            gradient.addColorStop(1, 'rgba(56, 189, 248, 0.0)');
            return gradient;
          },
          fill: true,
          tension: 0.22,
          pointRadius: (ctx) => {
            const index = ctx.dataIndex;
            const count = ctx.dataset.data.length;
            return index === count - 1 ? 3 : 0;
          },
          pointBackgroundColor: '#38bdf8',
          pointBorderColor: '#0e141f',
          pointBorderWidth: 1.5,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        layout: {
          padding: { top: 3, bottom: 2, left: 2, right: 4 }
        },
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            enabled: true,
            backgroundColor: 'rgba(14, 20, 31, 0.95)',
            borderColor: 'rgba(255, 255, 255, 0.15)',
            borderWidth: 1,
            padding: 5,
            titleFont: { family: 'JetBrains Mono', size: 9.5, weight: 600 },
            bodyFont: { family: 'JetBrains Mono', size: 10, weight: 500 },
            displayColors: false,
            callbacks: {
              label: (ctx) => `${Number(ctx.parsed.y).toLocaleString()} FT`,
            }
          }
        },
        scales: {
          x: {
            display: false,
          },
          y: {
            display: true,
            position: 'right',
            grid: {
              color: 'rgba(255, 255, 255, 0.05)',
              drawBorder: false,
            },
            ticks: {
              color: '#64748b',
              font: { family: 'JetBrains Mono', size: 8.5 },
              maxTicksLimit: 2,
              callback: (val) => `${Math.round(val / 1000)}k`,
            }
          }
        }
      }
    });
  } catch (err) {
    console.warn('Flight profile chart init error:', err);
  }
}

// update active flight profile graph
function updateFlightProfile(hex, ac) {
  const emptyBox = document.getElementById('profile-chart-empty');
  const badge    = document.getElementById('profile-trend-badge');
  const minEl    = document.getElementById('profile-stat-min');
  const maxEl    = document.getElementById('profile-stat-max');
  const deltaEl  = document.getElementById('profile-stat-delta');

  if (!hex) {
    clearFlightProfile();
    return;
  }

  // Ensure current altitude reading is in history
  if (ac && typeof ac.alt_baro === 'number' && !isNaN(ac.alt_baro)) {
    if (!altitudeHistory[hex]) {
      altitudeHistory[hex] = [];
    }
    const hist = altitudeHistory[hex];
    if (hist.length === 0) {
      const nowD = new Date();
      const tLabel = `${String(nowD.getHours()).padStart(2, '0')}:${String(nowD.getMinutes()).padStart(2, '0')}:${String(nowD.getSeconds()).padStart(2, '0')}`;
      hist.push({
        alt: ac.alt_baro,
        vrate: ac.vert_rate || 0,
        timestamp: Date.now(),
        label: tLabel,
      });
    }
  }

  const history = altitudeHistory[hex];
  if (!history || history.length === 0) {
    clearFlightProfile();
    return;
  }

  if (emptyBox) emptyBox.classList.add('hidden');

  const altitudes = history.map(p => p.alt);
  const minAlt = Math.min(...altitudes);
  const maxAlt = Math.max(...altitudes);
  const deltaAlt = altitudes[altitudes.length - 1] - altitudes[0];

  if (minEl) minEl.textContent = `${minAlt.toLocaleString()} FT`;
  if (maxEl) maxEl.textContent = `${maxAlt.toLocaleString()} FT`;
  if (deltaEl) {
    const sign = deltaAlt > 0 ? '+' : '';
    deltaEl.textContent = `${sign}${deltaAlt.toLocaleString()} FT`;
    deltaEl.style.color = deltaAlt > 100 ? 'var(--accent-info)' : (deltaAlt < -100 ? 'var(--accent-orange)' : 'var(--text-primary)');
  }

  // Trend detection
  const vrate = ac ? (Number(ac.vert_rate) || 0) : 0;
  if (badge) {
    badge.className = 'profile-trend-badge';
    if (vrate > 350) {
      badge.classList.add('badge-climb');
      badge.textContent = `CLIMB +${vrate} FPM`;
    } else if (vrate < -350) {
      badge.classList.add('badge-descent');
      badge.textContent = `DESCEND ${vrate} FPM`;
    } else {
      badge.classList.add('badge-level');
      badge.textContent = 'LEVEL / CRUISE';
    }
  }

  if (!profileChart) {
    initFlightProfileChart();
  }

  if (profileChart) {
    profileChart.data.labels = history.map(p => p.label || '');
    profileChart.data.datasets[0].data = altitudes;
    profileChart.update('none');
  }
}

// clear flight profile graph
function clearFlightProfile() {
  const emptyBox = document.getElementById('profile-chart-empty');
  const badge    = document.getElementById('profile-trend-badge');
  const minEl    = document.getElementById('profile-stat-min');
  const maxEl    = document.getElementById('profile-stat-max');
  const deltaEl  = document.getElementById('profile-stat-delta');

  if (emptyBox) emptyBox.classList.remove('hidden');
  if (badge) {
    badge.className = 'profile-trend-badge badge-level';
    badge.textContent = 'STANDBY';
  }
  if (minEl) minEl.textContent = '-- FT';
  if (maxEl) maxEl.textContent = '-- FT';
  if (deltaEl) {
    deltaEl.textContent = '-- FT';
    deltaEl.style.color = 'var(--text-primary)';
  }

  if (profileChart) {
    profileChart.data.labels = [];
    profileChart.data.datasets[0].data = [];
    profileChart.update('none');
  }
}

// fetch and render historical sqlite logger telemetry
async function fetchHistoryStats() {
  try {
    const res = await fetch('/api/history');
    if (!res.ok) return;
    const data = await res.json();

    setField('hist-total-today', String(data.total_today ?? 0));
    const uniqueSub = document.getElementById('hist-unique-sub');
    if (uniqueSub) {
      uniqueSub.textContent = `${data.unique_today ?? 0} unique airframes`;
    }
    setField('hist-peak-hour', data.peak_hour_str || '--');
    setField('hist-max-alt', data.max_alt_today > 0 ? `${Number(data.max_alt_today).toLocaleString()} FT` : '-- FT');
    setField('hist-all-time', String(data.all_time_total ?? 0));

    // Render 24-hour diurnal histogram
    const barsContainer = document.getElementById('hist-histogram-bars');
    if (barsContainer && Array.isArray(data.hourly_distribution)) {
      const maxCount = Math.max(1, ...data.hourly_distribution);
      barsContainer.innerHTML = data.hourly_distribution.map((count, hr) => {
        const pct = Math.max(4, Math.round((count / maxCount) * 100));
        const hrStr = `${String(hr).padStart(2, '0')}:00`;
        return `
          <div class="hist-bar-col" role="img" aria-label="${hrStr}: ${count} flights">
            <div class="hist-bar-fill" style="height: ${pct}%;"></div>
            <div class="hist-bar-tooltip">${hrStr} : ${count} flt</div>
          </div>
        `;
      }).join('');
    }

    // Render recent archived flights table
    const tbody = document.getElementById('hist-recent-tbody');
    if (tbody && Array.isArray(data.recent_flights)) {
      if (data.recent_flights.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="empty-table-msg">No flight sessions archived yet today</td></tr>`;
      } else {
        tbody.innerHTML = data.recent_flights.map(fl => {
          const altStr = fl.max_altitude > 0 ? `${Number(fl.max_altitude).toLocaleString()} FT` : '---- FT';
          return `
            <tr>
              <td class="hex-cell">${fl.hex}</td>
              <td class="flight-callsign">${fl.callsign}</td>
              <td>${fl.squawk}</td>
              <td>${fl.first_seen}</td>
              <td>${fl.last_seen}</td>
              <td>${altStr}</td>
            </tr>
          `;
        }).join('');
      }
    }
  } catch (err) {
    console.warn('History stats fetch error:', err);
  }
}

// mobile bottom slide-up sheet controls & gestures
function initMobileBottomSheet() {
  const sidebar = document.getElementById('sidebar');
  const handleBar = document.getElementById('sheet-handle-bar');
  const toggleBtn = document.getElementById('sheet-toggle-btn');

  if (!sidebar || !handleBar) return;

  handleBar.addEventListener('click', toggleMobileSheet);
  handleBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleMobileSheet(e);
    }
  });

  if (toggleBtn) {
    toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMobileSheet(e);
    });
  }

  // touch swipe / scroll-down gesture handling to dismiss or expand
  let touchStartY = 0;
  let touchStartX = 0;
  let isTouchingHeader = false;
  let isScrolledTopAtTouchStart = false;

  sidebar.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    isTouchingHeader = handleBar.contains(e.target);
    isScrolledTopAtTouchStart = sidebar.scrollTop <= 2;
  }, { passive: true });

  sidebar.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 1) return;
    const currentY = e.touches[0].clientY;
    const currentX = e.touches[0].clientX;
    const deltaY = currentY - touchStartY;
    const deltaX = currentX - touchStartX;

    // ensure vertical movement dominates
    if (Math.abs(deltaX) > Math.abs(deltaY)) return;

    const isCollapsed = sidebar.classList.contains('sheet-collapsed');

    // pull up to expand when collapsed
    if (isCollapsed) {
      if (deltaY < -30) {
        expandSheet();
        touchStartY = currentY;
      }
      return;
    }

    // pull down to dismiss when expanded
    // triggers if dragging on header bar OR dragging down from the top of the content
    if (deltaY > 35 && (isTouchingHeader || isScrolledTopAtTouchStart)) {
      if (e.cancelable && isTouchingHeader) {
        e.preventDefault();
      }
      collapseSheet();
      touchStartY = currentY;
    }
  }, { passive: false });

  window.addEventListener('resize', applyDeviceMode);
  window.addEventListener('orientationchange', applyDeviceMode);

  applyDeviceMode();
}

// update transponder tables
function updateAircraftTable(aircraftList, status) {
  const tbody = document.getElementById('aircraft-table-body');
  const sidebarTbody = document.getElementById('sidebar-aircraft-table-body');
  const countBadge = document.getElementById('sidebar-contacts-count');

  const count = aircraftList ? aircraftList.length : 0;
  if (countBadge) countBadge.textContent = String(count);

  if (!aircraftList || aircraftList.length === 0) {
    if (tbody) {
      tbody.innerHTML =
        `<tr><td colspan="10" class="empty-table-msg">` +
        `NO ACTIVE TRANSPONDER CONTACTS (${status})</td></tr>`;
    }
    if (sidebarTbody) {
      sidebarTbody.innerHTML = `<tr><td colspan="4" class="empty-table-msg">No aircraft in range</td></tr>`;
    }
    return;
  }

  // sort closest first
  const sorted = [...aircraftList].sort(
    (a, b) => (a.distance_nm || 999) - (b.distance_nm || 999));

  // tab 4 detailed transponder table
  if (tbody) {
    tbody.innerHTML = sorted.map((ac) => {
      const vrateNum  = Number(ac.vert_rate) || 0;
      const vrateStr  = vrateNum > 0 ? `+${vrateNum}` : `${vrateNum}`;
      const emergency = ANOMALY.SQUAWK_EMERGENCY.includes(String(ac.squawk));
      const isStale   = (typeof ac.seen_sec === 'number' && !isNaN(ac.seen_sec) && ac.seen_sec >= ANOMALY.SEEN_CRITICAL_SEC);
      const isWarn    = (!isStale && typeof ac.seen_sec === 'number' && !isNaN(ac.seen_sec) && ac.seen_sec >= ANOMALY.SEEN_WARN_SEC);
      const rowClass  = [
        'table-row-clickable',
        ac.hex === selectedHex ? 'selected-row' : '',
        emergency              ? 'row-emergency' : '',
        isStale                ? 'row-stale' : (isWarn ? 'row-warn' : ''),
      ].filter(Boolean).join(' ');

      const altVal = (ac.alt_baro !== undefined && ac.alt_baro !== null && !isNaN(Number(ac.alt_baro)))
        ? Number(ac.alt_baro) : null;
      const altStr = altVal !== null ? `${altVal.toLocaleString()} FT` : '----';
      const altClass = (altVal !== null && altVal < ANOMALY.ALT_FLOOR) ? 'cell-anomaly' : '';

      const speedVal = (ac.speed !== undefined && ac.speed !== null && !isNaN(Number(ac.speed)))
        ? Number(ac.speed) : null;
      const speedStr = speedVal !== null ? `${Math.round(speedVal)} KT` : '---';

      const trackVal = (ac.track !== undefined && ac.track !== null && !isNaN(Number(ac.track)))
        ? Number(ac.track) : null;
      const trackStr = trackVal !== null ? `${Math.round(trackVal)}°` : '---';

      const distVal = (ac.distance_nm !== undefined && ac.distance_nm !== null && !isNaN(Number(ac.distance_nm)))
        ? Number(ac.distance_nm) : null;
      const distStr = distVal !== null ? `${distVal.toFixed(1)} NM` : '--.-';

      const rssiVal = (ac.rssi !== undefined && ac.rssi !== null && !isNaN(Number(ac.rssi)))
        ? Number(ac.rssi) : null;
      const rssiStr = rssiVal !== null ? `${rssiVal.toFixed(1)} dBFS` : '--.-';

      const squawkStr = ac.squawk || '----';
      const squawkClass = emergency ? 'cell-anomaly' : '';

      const seenVal = (ac.seen_sec !== undefined && ac.seen_sec !== null && !isNaN(Number(ac.seen_sec)))
        ? Number(ac.seen_sec) : null;
      const seenStr = seenVal !== null ? `${seenVal.toFixed(1)} S` : '--.- S';
      const seenClass = isStale ? 'cell-stale' : (isWarn ? 'cell-warn' : '');

      return `
        <tr class="${rowClass}" data-hex="${ac.hex}">
          <td class="hex-cell">${String(ac.hex || '').toUpperCase()}</td>
          <td>${ac.flight || '----'}</td>
          <td class="${squawkClass}">${squawkStr}</td>
          <td class="${altClass}">${altStr}</td>
          <td>${vrateStr} FPM</td>
          <td>${speedStr}</td>
          <td>${trackStr}</td>
          <td>${distStr}</td>
          <td>${rssiStr}</td>
          <td class="${seenClass}">${seenStr}</td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('.table-row-clickable').forEach((row) => {
      row.addEventListener('click', () => {
        const hex = row.getAttribute('data-hex');
        const radarBtn = document.querySelector('.nav-tab[data-tab="tab-radar"]');
        if (radarBtn) radarBtn.click();

        setTimeout(() => {
          selectTarget(hex);
          const target = aircraftMarkers[hex]?.data;
          if (target && map) map.panTo([target.lat, target.lon]);
        }, 150);
      });
    });
  }

  // sidebar compact contacts table
  if (sidebarTbody) {
    sidebarTbody.innerHTML = sorted.map((ac) => {
      const isSel = ac.hex === selectedHex;
      const emergency = ANOMALY.SQUAWK_EMERGENCY.includes(String(ac.squawk));
      const rowClass = [
        'table-row-clickable',
        isSel ? 'selected-row' : '',
        emergency ? 'row-emergency' : '',
      ].filter(Boolean).join(' ');

      const callsign = ac.flight ? ac.flight.trim() : String(ac.hex || '').toUpperCase();
      const hexSub = ac.flight ? String(ac.hex || '').toUpperCase() : '';
      const altVal = (ac.alt_baro !== undefined && ac.alt_baro !== null && !isNaN(Number(ac.alt_baro)))
        ? Number(ac.alt_baro) : null;
      const altStr = altVal !== null ? `${altVal.toLocaleString()} FT` : '----';
      const speedVal = (ac.speed !== undefined && ac.speed !== null && !isNaN(Number(ac.speed)))
        ? Number(ac.speed) : null;
      const speedStr = speedVal !== null ? `${Math.round(speedVal)} KT` : '---';
      const distVal = (ac.distance_nm !== undefined && ac.distance_nm !== null && !isNaN(Number(ac.distance_nm)))
        ? Number(ac.distance_nm) : null;
      const distStr = distVal !== null ? `${distVal.toFixed(1)} NM` : '--.-';

      return `
        <tr class="${rowClass}" data-hex="${ac.hex}">
          <td class="cell-flight">
            <span class="flight-callsign">${callsign}</span>
            ${hexSub ? `<span class="flight-hex-sub">${hexSub}</span>` : ''}
          </td>
          <td class="cell-alt">${altStr}</td>
          <td class="cell-speed">${speedStr}</td>
          <td class="cell-dist">${distStr}</td>
        </tr>
      `;
    }).join('');

    sidebarTbody.querySelectorAll('.table-row-clickable').forEach((row) => {
      row.addEventListener('click', () => {
        const hex = row.getAttribute('data-hex');
        selectTarget(hex);
        const target = aircraftMarkers[hex]?.data;
        if (target && map) map.panTo([target.lat, target.lon]);
      });
    });
  }
}

// radar dock overlay controls
function initRadarControls() {
  const trailsBtn = document.getElementById('toggle-trails-btn');
  const centerBtn = document.getElementById('recenter-map-btn');
  const overlayBar = document.querySelector('.radar-overlay-bar');

  // suppress map click propagation
  if (overlayBar && typeof L !== 'undefined' && L.DomEvent) {
    L.DomEvent.disableClickPropagation(overlayBar);
    L.DomEvent.disableScrollPropagation(overlayBar);
  }

  trailsBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof L !== 'undefined' && L.DomEvent) L.DomEvent.stopPropagation(e);
    showTrails = !showTrails;
    trailsBtn.textContent = `TRAILS: ${showTrails ? 'ON' : 'OFF'}`;
    trailsBtn.classList.toggle('active', showTrails);
    refreshMarkerIcons();
  });

  centerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof L !== 'undefined' && L.DomEvent) L.DomEvent.stopPropagation(e);
    map?.setView(STATION_COORDS, 9);
  });
}

// tab navigation switcher
function initTabNavigation() {
  const tabs  = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId   = tab.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);

      if (targetPane && targetPane.classList.contains('active')) return;

      tabs.forEach((t)  => t.classList.remove('active'));
      panes.forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');

      if (targetPane) {
        targetPane.classList.add('active');
      }

      // recalculate leaflet viewport immediately
      if (targetId === 'tab-radar' && map) {
        map.invalidateSize();
      } else if (targetId === 'tab-telemetry') {
        fetchHistoryStats();
      }
    });
  });
}

// collapsible panels
function initCollapsibles() {
  // ensure heartbeat indicator is non-collapsible and clean
  const hb = document.querySelector('.stream-heartbeat');
  if (hb) {
    hb.classList.remove('collapsed');
    hb.removeAttribute('tabindex');
    hb.removeAttribute('role');
    hb.removeAttribute('aria-expanded');
    localStorage.removeItem('heartbeat_collapsed');
  }

  // sidebar contacts toggle
  const scToggle = document.getElementById('sidebar-contacts-toggle');
  const scPanel = document.getElementById('sidebar-contacts-panel');
  if (scToggle && scPanel) {
    if (localStorage.getItem('sidebar_contacts_collapsed') === '1') {
      scPanel.classList.add('collapsed');
      scToggle.setAttribute('aria-expanded', 'false');
    } else {
      scToggle.setAttribute('aria-expanded', 'true');
    }

    const toggleSidebarContacts = () => {
      scPanel.classList.toggle('collapsed');
      const isCollapsed = scPanel.classList.contains('collapsed');
      scToggle.setAttribute('aria-expanded', String(!isCollapsed));
      localStorage.setItem('sidebar_contacts_collapsed', isCollapsed ? '1' : '0');
    };

    scToggle.addEventListener('click', toggleSidebarContacts);
    scToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleSidebarContacts();
      }
    });
  }

  // telemetry table toggle
  const ttToggle = document.getElementById('telemetry-table-toggle');
  const ttCard = document.getElementById('telemetry-table-card');
  if (ttToggle && ttCard) {
    if (localStorage.getItem('telem_table_collapsed') === '1') {
      ttCard.classList.add('collapsed');
      ttToggle.setAttribute('aria-expanded', 'false');
    } else {
      ttToggle.setAttribute('aria-expanded', 'true');
    }

    const toggleTelemetryTable = () => {
      ttCard.classList.toggle('collapsed');
      const isCollapsed = ttCard.classList.contains('collapsed');
      ttToggle.setAttribute('aria-expanded', String(!isCollapsed));
      localStorage.setItem('telem_table_collapsed', isCollapsed ? '1' : '0');
    };

    ttToggle.addEventListener('click', toggleTelemetryTable);
    ttToggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleTelemetryTable();
      }
    });
  }
}

// application bootstrap
document.addEventListener('DOMContentLoaded', () => {
  initTickerSlots();
  initMap();
  initTabNavigation();
  initRadarControls();
  initCollapsibles();
  initMobileBottomSheet();
  initFlightProfileChart();

  fetchTelemetry();
  fetchAircraft();
  fetchHistoryStats();

  setInterval(fetchTelemetry, 1000);
  setInterval(fetchAircraft,  1000);
  setInterval(fetchHistoryStats, 8000);

  window.addEventListener('resize', () => {
    if (map) map.invalidateSize();
  });
});
