/* ==========================================================================
   ARBITRATOR // FRONTEND APPLICATION
   ==========================================================================
   Sections:
     01. Constants & State
     02. Utility — Anomaly-Aware Field Updater
     03. Map Initialization
     04. Aircraft Icon Factory
     05. Telemetry Polling  (Header Ribbon + Tab 04 Vitals)
     06. Thermal Sparkline
     07. Aircraft Polling & Marker Management
     08. Receiver Status Badge
     09. Marker Icon & Trail Refresh
     10. Target Selection & Sidebar
     11. Aircraft Photo Lookup
     12. Airspace Table  (Tab 04)
     13. Radar Overlay Controls
     14. Tab Navigation
     15. Bootstrap
   ========================================================================== */


/* ── 01. Constants & State ────────────────────────────────────────────── */

let map;
let aircraftMarkers = {};      // hex → { marker, polyline, trail: [], data }
let selectedHex     = null;
let showTrails      = true;

const STATION_COORDS = [37.7749, -122.3194];
const tempHistory    = [];
const MAX_HISTORY    = 60;

/** Anomaly detection thresholds */
const ANOMALY = {
  ALT_FLOOR:        0,                       // ft — negative altitude is anomalous
  VRATE_EXTREME:    4000,                    // fpm — extreme climb / descent
  SEEN_WARN_SEC:    5,                       // seconds → yellow warning threshold (5s - 15s)
  SEEN_CRITICAL_SEC: 15,                     // seconds → red stale threshold (15s - 30s)
  SEEN_PURGE_SEC:   30,                      // seconds → axe contact from tracking (>= 30s)
  SQUAWK_EMERGENCY: ['7500', '7600', '7700'],
};


/* ── 02. Utility — Anomaly-Aware Field Updater & Ticker Slot Engine ──── */

/**
 * Extracts numeric value, prefix, and suffix from a display string.
 * Examples:
 *  "0"             -> { prefix: "", suffix: "", value: 0 }
 *  "34.5 NM"       -> { prefix: "", suffix: " NM", value: 34.5 }
 *  "▲ +1,200 FPM"  -> { prefix: "▲ +", suffix: " FPM", value: 1200 }
 *  "-- NM"         -> null
 */
function extractNumber(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim();
  const match = s.match(/^([^\d\-+]*?)([-+]?[\d,]+\.?\d*|\.\d+)(.*)$/);
  if (!match) return null;

  const cleanNum = match[2].replace(/,/g, '');
  const val = parseFloat(cleanNum);
  if (isNaN(val)) return null;

  return {
    prefix: match[1],
    suffix: match[3],
    value: val,
  };
}

/**
 * Pre-initializes all metric, stat, and field values with ticker-slot containers
 * so that subsequent data updates smoothly slide without sudden DOM jumps.
 */
function initTickerSlots() {
  document.querySelectorAll('.field-val, .stat-num, .metric-value, .tactical-stat-val, .sparkline-stat-val').forEach((el) => {
    el.classList.add('ticker-slot');
    const txt = el.textContent.trim();
    if (txt) {
      el.innerHTML = `<span class="ticker-view">${txt}</span>`;
      el._animTarget = txt;
    }
  });
}

/**
 * Sets an element's text content with a real mechanical sliding ticker transition,
 * direction-aware (slides up if increasing, down if decreasing),
 * applies anomaly classes, and triggers visual card alert pulses.
 *
 * @param {string}      id            – DOM element ID
 * @param {string}      text          – New text to display
 * @param {string|null} [anomalyClass] – 'val-anomaly' | 'val-warn' | 'val-stale' | null
 */
function setField(id, text, anomalyClass) {
  const el = document.getElementById(id);
  if (!el) return;

  const targetStr = String(text ?? '').trim();

  // Swap anomaly state on the field element only if changed (prevents restarting CSS strobe animations)
  const currentAnomaly = el.classList.contains('val-anomaly') ? 'val-anomaly'
                       : el.classList.contains('val-warn') ? 'val-warn'
                       : el.classList.contains('val-stale') ? 'val-stale'
                       : null;
  if (currentAnomaly !== anomalyClass) {
    el.classList.remove('val-anomaly', 'val-warn', 'val-stale');
    if (anomalyClass) el.classList.add(anomalyClass);
  }

  // Sync container alert state only if changed
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

  // If text is identical to current target, no transition needed
  if (el._animTarget === targetStr) {
    return;
  }
  const prevStr = el._animTarget !== undefined ? el._animTarget : el.textContent.trim();
  el._animTarget = targetStr;

  // Pulse normal card flash if not an anomaly alert
  if (!anomalyClass && cardParent) {
    cardParent.classList.remove('field-flash');
    void cardParent.offsetHeight;
    cardParent.classList.add('field-flash');
  }

  // Determine direction: should new value slide up from bottom (isUp=true) or down from top (isUp=false)?
  const prevNum   = extractNumber(prevStr);
  const targetNum = extractNumber(targetStr);
  let isUp = true;
  if (prevNum !== null && targetNum !== null) {
    isUp = targetNum.value >= prevNum.value;
  } else if (prevStr === '0' || prevStr.startsWith('--') || prevStr === 'NONE' || prevStr === '----' || prevStr === '--- KT' || prevStr === '---°') {
    isUp = true;
  } else if (targetStr === '0' || targetStr.startsWith('--') || targetStr === 'NONE' || targetStr === '----' || targetStr === '--- KT' || targetStr === '---°') {
    isUp = false;
  }

  el.classList.add('ticker-slot');

  // Cancel any in-flight ticker timer on this element
  if (el._tickerTimer) {
    clearTimeout(el._tickerTimer);
    el._tickerTimer = null;
  }

  // Get active view or wrap existing content
  let currentView = el.querySelector('.ticker-view:not(.ticker-out)');
  if (!currentView) {
    el.innerHTML = '';
    currentView = document.createElement('span');
    currentView.className = 'ticker-view';
    currentView.textContent = prevStr;
    el.appendChild(currentView);
  } else {
    // Clean up any stale outgoing views immediately
    el.querySelectorAll('.ticker-out').forEach(node => node.remove());
  }

  const isFixedWidth = el.classList.contains('bar-val') || el.classList.contains('ticker-fixed');

  // Create incoming view
  const nextView = document.createElement('span');

  if (!isFixedWidth) {
    const prevWidth = currentView.offsetWidth;

    nextView.className = 'ticker-view';
    nextView.textContent = targetStr;

    // Measure intrinsic width without inheriting 100% width
    nextView.style.position = 'absolute';
    nextView.style.visibility = 'hidden';
    nextView.style.width = 'auto';
    nextView.style.whiteSpace = 'nowrap';
    el.appendChild(nextView);
    const nextWidth = nextView.offsetWidth;

    // Configure nextView for animation
    nextView.className = 'ticker-view ticker-next';
    nextView.style.width = '';
    nextView.style.visibility = 'visible';

    // Animate slot width if changed
    if (prevWidth > 0 && nextWidth > 0 && prevWidth !== nextWidth) {
      el.style.width = prevWidth + 'px';
      void el.offsetWidth;
      el.style.width = nextWidth + 'px';
    } else if (nextWidth > 0) {
      el.style.width = nextWidth + 'px';
    }
  } else {
    // Fixed-width right-anchored elements (e.g. CPU core load percentages)
    nextView.className = 'ticker-view ticker-next';
    nextView.textContent = targetStr;
    el.appendChild(nextView);
  }

  // Calculate transforms based on direction
  const outTransform     = isUp ? 'translateY(-100%)' : 'translateY(100%)';
  const inStartTransform = isUp ? 'translateY(100%)' : 'translateY(-100%)';

  nextView.style.transform = inStartTransform;
  nextView.style.opacity   = '0';

  // Force reflow so browser commits initial transform before transitioning
  void nextView.offsetHeight;

  // Execute slide
  currentView.classList.add('ticker-out');
  currentView.style.transform = outTransform;
  currentView.style.opacity   = '0';

  nextView.style.transform = 'translateY(0)';
  if (!anomalyClass) {
    nextView.style.opacity = '1';
    nextView.classList.add('stat-updating');
  } else {
    nextView.style.opacity = '';
  }

  // Clean up when animation finishes
  el._tickerTimer = setTimeout(() => {
    if (currentView.parentNode === el) {
      el.removeChild(currentView);
    }
    nextView.className = 'ticker-view';
    nextView.style.position  = '';
    nextView.style.transform = '';
    nextView.style.opacity   = '';
    if (!isFixedWidth) {
      el.style.width = '';
    }
    el._tickerTimer = null;
  }, 340);
}


/* ── 03. Map Initialization ───────────────────────────────────────────── */

function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
  }).setView(STATION_COORDS, 9);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'dark-tiles',
  }).addTo(map);

  // Deselect target when clicking empty map space
  map.on('click', () => {
    if (selectedHex) {
      clearSidebar();
      refreshMarkerIcons();
    }
  });
}


/* ── 04. Aircraft Icon Factory ────────────────────────────────────────── */

function createPlaneIcon(heading = 0, isSelected = false, squawk = '----', isStale = false, isWarn = false) {
  const isEmergency  = ANOMALY.SQUAWK_EMERGENCY.includes(String(squawk));
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


/* ── 05. Telemetry Polling ────────────────────────────────────────────── */

async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) return;
    const d = await res.json();

    /* — Header Ribbon — */
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

    /* — Tab 04: Per-Core Bars — */
    if (Array.isArray(d.cpu_per_core)) {
      d.cpu_per_core.forEach((pct, i) => {
        const bar = document.getElementById(`core-bar-${i}`);
        if (bar) {
          bar.style.width = `${Math.min(100, Math.round(pct))}%`;
        }
        setField(`core-val-${i}`, `${Math.round(pct)}%`);
      });
    }

    /* — Tab 04: System Vitals — */
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

    updateThermalSparkline(d.cpu_temp_c);
  } catch (err) {
    console.warn('Telemetry poll error:', err);
  }
}


/* ── 06. Thermal Sparkline ────────────────────────────────────────────── */

function updateThermalSparkline(temp) {
  if (typeof temp !== 'number' || isNaN(temp)) return;
  tempHistory.push(temp);
  if (tempHistory.length > MAX_HISTORY) tempHistory.shift();

  const poly  = document.getElementById('temp-sparkline-line');
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


/* ── 07. Aircraft Polling & Marker Management ─────────────────────────── */

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

    /* ── Process each contact ── */
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

      if (aircraftMarkers[hex]) {
        /* Update existing marker */
        const entry = aircraftMarkers[hex];
        entry.marker.setLatLng([lat, lon]);
        entry.marker.setIcon(createPlaneIcon(track, isSel, ac.squawk, isStale, isWarn));
        entry.data = ac;

        /* Append breadcrumb trail point */
        const last = entry.trail[entry.trail.length - 1];
        if (!last || last[0] !== lat || last[1] !== lon) {
          entry.trail.push([lat, lon]);
          if (entry.trail.length > 50) entry.trail.shift();
          entry.polyline.setLatLngs(entry.trail);
        }

        if (isSel) updateSidebar(ac);
      } else {
        /* Create new marker + trail */
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

        aircraftMarkers[hex] = { marker, polyline, trail: [[lat, lon]], data: ac };
      }
    });

    /* ── Purge stale contacts ── */
    Object.keys(aircraftMarkers).forEach((hex) => {
      if (!activeHexes.has(hex)) {
        map.removeLayer(aircraftMarkers[hex].marker);
        map.removeLayer(aircraftMarkers[hex].polyline);
        delete aircraftMarkers[hex];
        if (selectedHex === hex) clearSidebar();
      }
    });

    /* ── Radar overlay stats ── */
    setField('hud-contact-count', String(contacts.length));
    setField('hud-max-range',
      maxDist > 0 ? `${maxDist.toFixed(1)} NM` : '-- NM');

    /* ── Tab 04 table ── */
    updateAircraftTable(contacts, status);
  } catch (err) {
    console.warn('Aircraft poll error:', err);
  }
}


/* ── 08. Receiver Status Badge ────────────────────────────────────────── */

function updateReceiverBadge(status) {
  const badge      = document.getElementById('receiver-status');
  const tableBadge = document.getElementById('table-status-badge');

  if (badge) {
    badge.textContent = status;
    badge.className   = 'metric-val status-badge';

    const classMap = {
      ONLINE:       'online',
      STANDBY:      'standby',
      INITIALIZING: 'initializing',
      DEGRADED:     'degraded',
    };
    badge.classList.add(classMap[status] || 'disconnected');
  }

  if (tableBadge) {
    tableBadge.textContent = `RECEIVER: ${status}`;
  }
}


/* ── 09. Marker Icon & Trail Refresh ──────────────────────────────────── */

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


/* ── 10. Target Selection & Sidebar ───────────────────────────────────── */

function selectTarget(hex) {
  selectedHex = hex;
  const target = aircraftMarkers[hex]?.data;
  if (!target) return;

  refreshMarkerIcons();
  updateSidebar(target);
  fetchAircraftPhoto(hex);
}

function updateSidebar(ac) {
  if (!ac) return;

  const alt     = ac.alt_baro;
  const vrate   = ac.vert_rate || 0;
  const speed   = ac.speed;
  const seen    = ac.seen_sec;
  const squawk  = ac.squawk || '----';

  /* Last seen — warn (>= 10s) → critical stale (>= 15s) */
  const seenVal = (seen !== null && seen !== undefined && !isNaN(Number(seen)))
    ? Number(seen) : null;
  let seenClass = null;
  if (seenVal !== null) {
    if      (seenVal >= ANOMALY.SEEN_CRITICAL_SEC) seenClass = 'val-stale';
    else if (seenVal >= ANOMALY.SEEN_WARN_SEC)     seenClass = 'val-warn';
  }

  /* Hex badge — flags emergency squawk or stale telemetry */
  let hexAnomaly = null;
  if (ANOMALY.SQUAWK_EMERGENCY.includes(String(squawk))) {
    hexAnomaly = 'val-anomaly';
  } else if (seenClass) {
    hexAnomaly = seenClass;
  }
  setField('target-hex', String(ac.hex || 'NONE').toUpperCase(), hexAnomaly);

  /* Callsign */
  setField('target-callsign', ac.flight || 'NO CALLSIGN');

  /* Altitude — anomaly if negative */
  const altVal = (alt !== null && alt !== undefined && !isNaN(Number(alt)))
    ? Number(alt) : null;
  const altText = altVal !== null ? `${altVal.toLocaleString()} FT` : '---- FT';
  setField('target-alt', altText,
    (altVal !== null && altVal < ANOMALY.ALT_FLOOR) ? 'val-anomaly' : null);

  /* Vertical rate — warn if extreme */
  const vrateNum = Number(vrate) || 0;
  const vratePrefix = vrateNum > 0 ? `▲ +${vrateNum}` : (vrateNum < 0 ? `▼ ${vrateNum}` : '0');
  setField('target-vrate', `${vratePrefix} FPM`,
    Math.abs(vrateNum) > ANOMALY.VRATE_EXTREME ? 'val-warn' : null);

  /* Ground speed */
  const speedVal = (speed !== null && speed !== undefined && !isNaN(Number(speed)))
    ? Number(speed) : null;
  setField('target-speed', speedVal !== null ? `${Math.round(speedVal)} KT` : '--- KT');

  /* Heading */
  const trackVal = (ac.track !== null && ac.track !== undefined && !isNaN(Number(ac.track)))
    ? Number(ac.track) : null;
  setField('target-track', trackVal !== null ? `${Math.round(trackVal)}°` : '---°');

  /* Squawk — anomaly if emergency */
  setField('target-squawk', squawk,
    ANOMALY.SQUAWK_EMERGENCY.includes(String(squawk)) ? 'val-anomaly' : null);

  /* Selected altitude */
  const selAltVal = (ac.selected_alt !== null && ac.selected_alt !== undefined && !isNaN(Number(ac.selected_alt)))
    ? Number(ac.selected_alt) : null;
  setField('target-sel-alt', selAltVal !== null ? `${selAltVal.toLocaleString()} FT` : '---- FT');

  /* Distance */
  const distVal = (ac.distance_nm !== null && ac.distance_nm !== undefined && !isNaN(Number(ac.distance_nm)))
    ? Number(ac.distance_nm) : null;
  setField('target-dist', distVal !== null ? `${distVal.toFixed(1)} NM` : '--.- NM');

  /* Signal strength */
  const rssiVal = (ac.rssi !== null && ac.rssi !== undefined && !isNaN(Number(ac.rssi)))
    ? Number(ac.rssi) : null;
  setField('target-rssi', rssiVal !== null ? `${rssiVal.toFixed(1)} dBFS` : '--.- dBFS');

  /* Last seen value */
  setField('target-seen', seenVal !== null ? `${seenVal.toFixed(1)} S` : '--.- S', seenClass);
}

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
    const el = document.getElementById(id);
    if (el) {
      if (el._animRaf) cancelAnimationFrame(el._animRaf);
      el._animRaf = null;
      el._animValue = undefined;
    }
    setField(id, text);
  });

  document.getElementById('photo-box').innerHTML =
    '<div class="photo-placeholder">AWAITING TARGET LOCK</div>';
}


/* ── 11. Aircraft Photo Lookup ────────────────────────────────────────── */

async function fetchAircraftPhoto(hex) {
  const photoBox = document.getElementById('photo-box');
  photoBox.innerHTML =
    '<div class="photo-placeholder">SCANNING IMAGE ARCHIVE...</div>';

  try {
    const res = await fetch(
      `https://api.planespotters.net/pub/photos/hex/${hex}`);
    if (!res.ok) throw new Error('Photo lookup failed');
    const data = await res.json();

    if (data.photos && data.photos.length > 0) {
      const photo = data.photos[0];
      photoBox.innerHTML = `
        <img src="${photo.thumbnail_large.src}" alt="${hex}">
        <span class="photo-credit">© ${photo.photographer}</span>
      `;
    } else {
      photoBox.innerHTML =
        '<div class="photo-placeholder">NO IMAGE AVAILABLE</div>';
    }
  } catch {
    photoBox.innerHTML =
      '<div class="photo-placeholder">IMAGE LOOKUP OFFLINE</div>';
  }
}


/* ── 12. Airspace Table (Tab 04) ──────────────────────────────────────── */

function updateAircraftTable(aircraftList, status) {
  const tbody = document.getElementById('aircraft-table-body');
  if (!tbody) return;

  if (!aircraftList || aircraftList.length === 0) {
    tbody.innerHTML =
      `<tr><td colspan="10" class="empty-table-msg">` +
      `NO ACTIVE TRANSPONDER CONTACTS (${status})</td></tr>`;
    return;
  }

  /* Sort closest-first */
  const sorted = [...aircraftList].sort(
    (a, b) => (a.distance_nm || 999) - (b.distance_nm || 999));

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

  /* Row click → jump to radar tab and lock target */
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


/* ── 13. Radar Overlay Controls ───────────────────────────────────────── */

function initRadarControls() {
  const trailsBtn = document.getElementById('toggle-trails-btn');
  const centerBtn = document.getElementById('recenter-map-btn');

  trailsBtn?.addEventListener('click', () => {
    showTrails = !showTrails;
    trailsBtn.textContent = `TRAILS: ${showTrails ? 'ON' : 'OFF'}`;
    trailsBtn.classList.toggle('active', showTrails);
    refreshMarkerIcons();
  });

  centerBtn?.addEventListener('click', () => {
    map?.setView(STATION_COORDS, 9);
  });
}


/* ── 14. Tab Navigation ───────────────────────────────────────────────── */

function initTabNavigation() {
  const tabs  = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId   = tab.getAttribute('data-tab');
      const targetPane = document.getElementById(targetId);

      /* Skip if already on this tab */
      if (targetPane && targetPane.classList.contains('active')) return;

      /* Deactivate everything */
      tabs.forEach((t)  => t.classList.remove('active'));
      panes.forEach((p) => p.classList.remove('active'));

      /* Activate clicked tab button */
      tab.classList.add('active');

      /* Force reflow so the browser commits opacity:0 before we transition */
      if (targetPane) {
        void targetPane.offsetHeight;
        targetPane.classList.add('active');
      }

      /* Leaflet needs a size recalculation after the pane becomes visible */
      if (targetId === 'tab-radar' && map) {
        setTimeout(() => map.invalidateSize(), 100);
      }
    });
  });
}


/* ── 15. Bootstrap ────────────────────────────────────────────────────── */

document.addEventListener('DOMContentLoaded', () => {
  initTickerSlots();
  initMap();
  initTabNavigation();
  initRadarControls();

  fetchTelemetry();
  fetchAircraft();

  setInterval(fetchTelemetry, 1250);
  setInterval(fetchAircraft,  1250);
});
