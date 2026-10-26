let map;
let aircraftMarkers = {}; // hex -> { marker, polyline, trail: [], data }
let selectedHex = null;

// Tactical Map Overlays
const STATION_COORDS = [37.7749, -122.3194];
let showTrails = true;

// Rolling 60-second temperature history for Tab 04 sparkline
const tempHistory = [];
const MAX_HISTORY = 60;

// Initialize map
function initMap() {
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false
  }).setView(STATION_COORDS, 9);

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'dark-tiles'
  }).addTo(map);

  // Deselect plane when clicking empty space on map
  map.on('click', () => {
    if (selectedHex) {
      clearSidebar();
      refreshMarkerIcons();
    }
  });
}


// Generate SVG icon & rotate to plane heading
function createPlaneIcon(heading = 0, isSelected = false, squawk = '----') {
  const isEmergency = ['7700', '7600', '7500'].includes(String(squawk));
  const selectedClass = isSelected ? 'selected' : (isEmergency ? 'emergency' : '');
  const html = `
    <div style="transform: rotate(${heading}deg); width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;">
      <svg class="plane-svg ${selectedClass}" viewBox="-4 -4 40 40" style="overflow: visible;" xmlns="http://www.w3.org/2000/svg">
        <g transform="translate(3.2, -0.9) rotate(-45 16 16)">
          <path d="M12.25 8.719l-0.469 0.469 4 0.344 2.406-2.406c0.375-0.375 1.063-0.938 2.063-1.563s1.656-0.813 1.906-0.563c0.688 0.688 0 2.031-2.063 4.063l-2.375 2.375 0.344 4 0.469-0.438c0.375-0.406 0.781-0.406 1.094-0.094 0.375 0.375 0.219 0.906-0.531 1.656l-0.75 0.781 0.375 2.688 0.531-0.563c0.344-0.375 0.719-0.375 1.063-0.063 0.375 0.375 0.313 0.844-0.188 1.344l-1.125 1.125c0.438 3 0.5 4.688 0.156 5.031-0.156 0.125-0.375 0.25-0.688 0.313-0.281 0.031-0.531 0-0.688-0.125-0.125-0.156-0.313-0.719-0.5-1.688-0.219-1-0.75-2.688-1.688-5.063-0.906-2.406-1.563-3.75-1.875-4.094-0.125-0.125-0.313-0.125-0.531 0-0.219 0.094-1 0.75-2.25 1.969-1.25 1.25-2.406 2.25-3.5 3.031-0.031 0.188 0.063 0.813 0.219 1.844s0.219 1.719 0.188 1.969c-0.063 0.25-0.313 0.594-0.719 1-0.219 0.219-0.375 0.344-0.531 0.375-0.406-0.406-1.031-1.719-1.875-3.875-2.344-1.031-3.625-1.688-3.875-1.938 0-0.125 0.125-0.313 0.344-0.531 0.406-0.406 0.75-0.656 1.031-0.688 0.25-0.063 0.906 0.031 1.938 0.219 1.031 0.156 1.656 0.219 1.875 0.219 0.75-1.125 2.156-2.781 4.344-4.969 0.625-0.688 0.813-1.125 0.594-1.344-0.313-0.344-1.688-0.969-4.063-1.875-2.406-0.906-4.063-1.5-5.063-1.688-1-0.219-1.563-0.375-1.688-0.531-0.156-0.125-0.188-0.375-0.125-0.688 0.031-0.313 0.156-0.531 0.313-0.688 0.313-0.313 2-0.281 5.031 0.156l1.094-1.125c0.5-0.469 0.969-0.531 1.344-0.156 0.344 0.313 0.313 0.688-0.031 1.031l-0.563 0.531 2.688 0.375 0.75-0.719c0.75-0.75 1.281-0.906 1.656-0.531 0.344 0.344 0.313 0.688-0.063 1.094z" />
        </g>
      </svg>
    </div>
  `;
  return L.divIcon({
    html: html,
    className: 'plane-icon-wrapper',
    iconSize: [24, 24],
    iconAnchor: [16, 16]
  });
}

// Grab telemetry from backend & populate both Top Header and Tab 04
async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) return;
    const data = await res.json();

    // Header Ribbon
    document.getElementById('cpu-temp').textContent = `${data.cpu_temp_c.toFixed(1)}°C`;
    document.getElementById('cpu-usage').textContent = `${data.cpu_usage_pct.toFixed(0)}%`;
    document.getElementById('ram-usage').textContent = `${data.memory_used_pct.toFixed(0)}%`;
    document.getElementById('node-uptime').textContent = `${data.uptime_hours.toFixed(1)}H`;

    // Tab 04: Per-Core Bars
    if (Array.isArray(data.cpu_per_core)) {
      data.cpu_per_core.forEach((pct, idx) => {
        const bar = document.getElementById(`core-bar-${idx}`);
        const val = document.getElementById(`core-val-${idx}`);
        if (bar && val) {
          bar.style.width = `${Math.min(100, Math.round(pct))}%`;
          val.textContent = `${Math.round(pct)}%`;
        }
      });
    }

    // Tab 04: System Vitals List
    document.getElementById('telem-freq').textContent = `${data.cpu_freq_mhz || '----'} MHz`;
    if (data.load_avg) {
      document.getElementById('telem-load').textContent = data.load_avg.map(n => n.toFixed(2)).join(' / ');
    }
    document.getElementById('telem-procs').textContent = data.process_count || '---';
    document.getElementById('telem-mem').textContent = `${data.memory_used_mb} / ${data.memory_total_mb} MB (${data.memory_used_pct}%)`;
    document.getElementById('telem-disk').textContent = `${data.disk_used_gb} / ${data.disk_total_gb} GB (${data.disk_used_pct}%)`;
    document.getElementById('telem-net').textContent = `▲ ${data.net_sent_mb} MB  ▼ ${data.net_recv_mb} MB`;

    // Update 60s Thermal Sparkline
    updateThermalSparkline(data.cpu_temp_c);
  } catch (err) {
    console.warn('Telemetry poll error:', err);
  }
}

// Render SVG Sparkline for CPU Temp
function updateThermalSparkline(temp) {
  tempHistory.push(temp);
  if (tempHistory.length > MAX_HISTORY) tempHistory.shift();

  const poly = document.getElementById('temp-sparkline-line');
  const label = document.getElementById('sparkline-current');
  if (!poly || !label) return;

  label.textContent = `${temp.toFixed(1)}°C`;

  const minTemp = 30;
  const maxTemp = 85;
  const width = 300;
  const height = 65;

  const points = tempHistory.map((t, i) => {
    const x = (i / Math.max(1, MAX_HISTORY - 1)) * width;
    const clamped = Math.max(minTemp, Math.min(maxTemp, t));
    const y = height - ((clamped - minTemp) / (maxTemp - minTemp)) * (height - 12) - 6;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  poly.setAttribute('points', points);
}

// Update radio contacts, trails, markers & Tab 04 table
async function fetchAircraft() {
  try {
    const res = await fetch('/api/aircraft');
    if (!res.ok) return;
    const data = await res.json();

    const status = (data.status || 'UNKNOWN').toUpperCase();
    updateReceiverBadge(status);

    const currentContacts = data.aircraft || [];
    const activeHexes = new Set();
    let maxDist = 0;

    currentContacts.forEach((ac) => {
      const hex = ac.hex;
      activeHexes.add(hex);

      const lat = ac.lat;
      const lon = ac.lon;
      const track = ac.track || 0;
      const isSelected = (hex === selectedHex);

      if (ac.distance_nm && ac.distance_nm > maxDist) {
        maxDist = ac.distance_nm;
      }

      if (aircraftMarkers[hex]) {
        const entry = aircraftMarkers[hex];
        entry.marker.setLatLng([lat, lon]);
        entry.marker.setIcon(createPlaneIcon(track, isSelected, ac.squawk));
        entry.data = ac;

        // Append coordinate to breadcrumb trail if moved
        const lastPt = entry.trail[entry.trail.length - 1];
        if (!lastPt || lastPt[0] !== lat || lastPt[1] !== lon) {
          entry.trail.push([lat, lon]);
          if (entry.trail.length > 50) entry.trail.shift();
          entry.polyline.setLatLngs(entry.trail);
        }

        if (isSelected) {
          updateSidebar(ac);
        }
      } else {
        const marker = L.marker([lat, lon], {
          icon: createPlaneIcon(track, isSelected, ac.squawk)
        }).addTo(map);

        const polyline = L.polyline([[lat, lon]], {
          color: isSelected ? '#ffb300' : '#00e5ff',
          weight: 2.5,
          opacity: showTrails ? 0.45 : 0,
          dashArray: '3, 4'
        }).addTo(map);

        marker.on('click', (e) => {
          L.DomEvent.stopPropagation(e);
          selectTarget(hex);
        });

        aircraftMarkers[hex] = {
          marker,
          polyline,
          trail: [[lat, lon]],
          data: ac
        };
      }
    });

    // Wipe stale contacts
    Object.keys(aircraftMarkers).forEach((hex) => {
      if (!activeHexes.has(hex)) {
        map.removeLayer(aircraftMarkers[hex].marker);
        map.removeLayer(aircraftMarkers[hex].polyline);
        delete aircraftMarkers[hex];

        if (selectedHex === hex) {
          clearSidebar();
        }
      }
    });

    // Update Radar Overlay Stats
    document.getElementById('hud-contact-count').textContent = currentContacts.length;
    document.getElementById('hud-max-range').textContent = maxDist > 0 ? `${maxDist.toFixed(1)} NM` : '-- NM';

    // Update Tab 04 Live Airspace Table
    updateAircraftTable(currentContacts, status);

  } catch (err) {
    console.warn('Aircraft poll error:', err);
  }
}

function updateReceiverBadge(status) {
  const badge = document.getElementById('receiver-status');
  const tableBadge = document.getElementById('table-status-badge');

  if (badge) {
    badge.textContent = status;
    badge.className = 'metric-val status-badge';
    
    if (status === 'ONLINE') badge.classList.add('online');
    else if (status === 'STANDBY') badge.classList.add('standby');
    else if (status === 'INITIALIZING') badge.classList.add('initializing');
    else if (status === 'DEGRADED') badge.classList.add('degraded');
    else badge.classList.add('disconnected');
  }

  if (tableBadge) {
    tableBadge.textContent = `RECEIVER: ${status}`;
  }
}

// Refresh all marker icons & trail colors on selection change
function refreshMarkerIcons() {
  Object.keys(aircraftMarkers).forEach((h) => {
    const entry = aircraftMarkers[h];
    const isSel = (h === selectedHex);
    entry.marker.setIcon(createPlaneIcon(entry.data.track || 0, isSel, entry.data.squawk));
    entry.polyline.setStyle({
      color: isSel ? '#ffb300' : '#00e5ff',
      opacity: showTrails ? (isSel ? 0.85 : 0.45) : 0
    });
  });
}

// Select Target & Trigger Planespotters.net lookup
function selectTarget(hex) {
  selectedHex = hex;
  const target = aircraftMarkers[hex]?.data;
  if (!target) return;

  refreshMarkerIcons();
  updateSidebar(target);
  fetchAircraftPhoto(hex);
}

// Populate Sidebar
function updateSidebar(ac) {
  document.getElementById('target-hex').textContent = ac.hex.toUpperCase();
  document.getElementById('target-callsign').textContent = ac.flight || 'NO CALLSIGN';
  document.getElementById('target-alt').textContent = ac.alt_baro !== null && ac.alt_baro !== undefined
    ? `${Number(ac.alt_baro).toLocaleString()} FT`
    : '---- FT';

  const vrate = ac.vert_rate || 0;
  const vrateSign = vrate > 0 ? `▲ +${vrate}` : (vrate < 0 ? `▼ ${vrate}` : `0`);
  document.getElementById('target-vrate').textContent = `${vrateSign} FPM`;

  document.getElementById('target-speed').textContent = ac.speed ? `${Math.round(ac.speed)} KT` : '--- KT';
  document.getElementById('target-track').textContent = ac.track !== null && ac.track !== undefined ? `${Math.round(ac.track)}°` : '---°';
  document.getElementById('target-squawk').textContent = ac.squawk || '----';
  document.getElementById('target-sel-alt').textContent = ac.selected_alt ? `${ac.selected_alt.toLocaleString()} FT` : '---- FT';
  document.getElementById('target-dist').textContent = ac.distance_nm !== undefined ? `${ac.distance_nm.toFixed(1)} NM` : '--.- NM';
  document.getElementById('target-rssi').textContent = ac.rssi !== undefined && ac.rssi !== null ? `${ac.rssi.toFixed(1)} dBFS` : '--.- dBFS';
  document.getElementById('target-seen').textContent = ac.seen_sec !== undefined ? `${ac.seen_sec.toFixed(1)} S` : '0.0 S';
}

function clearSidebar() {
  selectedHex = null;
  document.getElementById('target-hex').textContent = 'NONE';
  document.getElementById('target-callsign').textContent = '----';
  document.getElementById('target-alt').textContent = '---- FT';
  document.getElementById('target-vrate').textContent = '---- FPM';
  document.getElementById('target-speed').textContent = '--- KT';
  document.getElementById('target-track').textContent = '---°';
  document.getElementById('target-squawk').textContent = '----';
  document.getElementById('target-sel-alt').textContent = '---- FT';
  document.getElementById('target-dist').textContent = '--.- NM';
  document.getElementById('target-rssi').textContent = '--.- dBFS';
  document.getElementById('target-seen').textContent = '--.- S';

  const photoBox = document.getElementById('photo-box');
  photoBox.innerHTML = '<div class="photo-placeholder">AWAITING TARGET LOCK</div>';
}

// Populate Tab 04 Transponder Table
function updateAircraftTable(aircraftList, status) {
  const tbody = document.getElementById('aircraft-table-body');
  if (!tbody) return;

  if (!aircraftList || aircraftList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-table-msg">NO ACTIVE TRANSPONDER CONTACTS (${status})</td></tr>`;
    return;
  }

  // Sort closest aircraft first
  const sorted = [...aircraftList].sort((a, b) => (a.distance_nm || 999) - (b.distance_nm || 999));

  tbody.innerHTML = sorted.map((ac) => {
    const vrate = ac.vert_rate || 0;
    const vrateStr = vrate > 0 ? `+${vrate}` : `${vrate}`;
    return `
      <tr class="table-row-clickable ${ac.hex === selectedHex ? 'selected-row' : ''}" data-hex="${ac.hex}">
        <td class="hex-cell">${ac.hex.toUpperCase()}</td>
        <td>${ac.flight || '----'}</td>
        <td>${ac.squawk || '----'}</td>
        <td>${ac.alt_baro !== undefined && ac.alt_baro !== null ? Number(ac.alt_baro).toLocaleString() + ' FT' : '----'}</td>
        <td>${vrateStr} FPM</td>
        <td>${ac.speed ? Math.round(ac.speed) + ' KT' : '---'}</td>
        <td>${ac.track !== undefined && ac.track !== null ? Math.round(ac.track) + '°' : '---'}</td>
        <td>${ac.distance_nm !== undefined ? ac.distance_nm.toFixed(1) + ' NM' : '--.-'}</td>
        <td>${ac.rssi !== undefined && ac.rssi !== null ? ac.rssi.toFixed(1) + ' dBFS' : '--.-'}</td>
      </tr>
    `;
  }).join('');

  // Clicking a table row switches to Tab 01 and locks onto that plane
  tbody.querySelectorAll('.table-row-clickable').forEach((row) => {
    row.addEventListener('click', () => {
      const hex = row.getAttribute('data-hex');
      const radarTabBtn = document.querySelector('.nav-tab[data-tab="tab-radar"]');
      if (radarTabBtn) radarTabBtn.click();

      setTimeout(() => {
        selectTarget(hex);
        const target = aircraftMarkers[hex]?.data;
        if (target && map) {
          map.panTo([target.lat, target.lon]);
        }
      }, 150);
    });
  });
}

// Async Planespotters.net Photo Fetch
async function fetchAircraftPhoto(hex) {
  const photoBox = document.getElementById('photo-box');
  photoBox.innerHTML = '<div class="photo-placeholder">SCANNING PHOTO ARCHIVE...</div>';

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
      photoBox.innerHTML = '<div class="photo-placeholder">NO ARCHIVE PHOTO AVAILABLE</div>';
    }
  } catch (err) {
    photoBox.innerHTML = '<div class="photo-placeholder">PHOTO LOOKUP OFFLINE</div>';
  }
}

// Radar Overlay Control Buttons (Rings, Trails, Recenter)
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

// Tab Switching Controller with Leaflet Size Recalculation
function initTabNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = tab.getAttribute('data-tab');

      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      panes.forEach((pane) => {
        if (pane.id === targetId) {
          pane.classList.add('active');
        } else {
          pane.classList.remove('active');
        }
      });

      if (targetId === 'tab-radar' && map) {
        setTimeout(() => {
          map.invalidateSize();
        }, 100);
      }
    });
  });
}

// Initialize & Loop timers
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initTabNavigation();
  initRadarControls();
  fetchTelemetry();
  fetchAircraft();

  setInterval(fetchTelemetry, 1000);
  setInterval(fetchAircraft, 1000);
});