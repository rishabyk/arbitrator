let map;
let aircraftMarkers = {}; // hex -> { marker, data }
let selectedHex = null;

// Initialize map
function initMap() {
  // Centering around Bay area
  map = L.map('map', {
    zoomControl: true,
    attributionControl: false
  }).setView([37.7749, -122.3194], 9);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'dark-tiles'
  }).addTo(map);

  // Deselects plane when clicking empty space on map
  map.on('click', () => {
  });
}

// generate SVG icon & rotate to plane heading
function createPlaneIcon(heading = 0, isSelected = false) {
  const selectedClass = isSelected ? 'selected' : '';
  const html = `
    <div style="transform: rotate(${heading}deg); width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;">
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
    iconAnchor: [12, 12]
  });
}

// Grab telemetry from backend
async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) return;
    const data = await res.json();

    document.getElementById('cpu-temp').textContent = `${data.cpu_temp_c.toFixed(1)}°C`;
    document.getElementById('cpu-usage').textContent = `${data.cpu_usage_pct.toFixed(0)}%`;
    document.getElementById('ram-usage').textContent = `${data.memory_used_pct.toFixed(0)}%`;
  } catch (err) {
    console.warn('Telemetry poll error:', err);
  }
}

// Update radio contacts & markers
async function fetchAircraft() {
  try {
    const res = await fetch('/api/aircraft');
    if (!res.ok) return;
    const data = await res.json();

// Update receiver status badge with dedicated color classes
    const badge = document.getElementById('receiver-status');
    const status = (data.status || 'UNKNOWN').toUpperCase();
    badge.textContent = status;
    badge.className = 'metric-val status-badge';

    if (status === 'ONLINE') {
      badge.classList.add('online');
    } else if (status === 'STANDBY') {
      badge.classList.add('standby');
    } else if (status === 'INITIALIZING') {
      badge.classList.add('initializing');
    } else if (status === 'DISCONNECTED') {
      badge.classList.add('disconnected');
    } else if (status === 'DEGRADED') {
      badge.classList.add('degraded');
    } else {
      badge.classList.add('disconnected');
    }

    const currentContacts = data.aircraft || [];
    const activeHexes = new Set();

    // Update or add aircraft
    currentContacts.forEach((ac) => {
      const hex = ac.hex;
      activeHexes.add(hex);

      const lat = ac.lat;
      const lon = ac.lon;
      const track = ac.track || 0;
      const isSelected = (hex === selectedHex);

      if (aircraftMarkers[hex]) {
        // Move marker smoothly
        const marker = aircraftMarkers[hex].marker;
        marker.setLatLng([lat, lon]);
        marker.setIcon(createPlaneIcon(track, isSelected));
        aircraftMarkers[hex].data = ac;

        // If this plane is currently selected in side panel, refresh its live numbers
        if (isSelected) {
          updateSidebar(ac);
        }
      } else {
        // Create new marker
        const marker = L.marker([lat, lon], {
          icon: createPlaneIcon(track, isSelected)
        }).addTo(map);

        marker.on('click', () => {
          selectTarget(hex);
        });

        aircraftMarkers[hex] = { marker, data: ac };
      }
    });

    // Wipe stale contacts 
    Object.keys(aircraftMarkers).forEach((hex) => {
      if (!activeHexes.has(hex)) {
        map.removeLayer(aircraftMarkers[hex].marker);
        delete aircraftMarkers[hex];

        if (selectedHex === hex) {
          clearSidebar();
        }
      }
    });

  } catch (err) {
    console.warn('Aircraft poll error:', err);
  }
}

// Select Target & Trigger Planespotters.net lookup
function selectTarget(hex) {
  selectedHex = hex;
  const target = aircraftMarkers[hex]?.data;
  if (!target) return;

  // Refresh all markers to update highlight color
  Object.keys(aircraftMarkers).forEach((h) => {
    const ac = aircraftMarkers[h].data;
    aircraftMarkers[h].marker.setIcon(createPlaneIcon(ac.track || 0, h === selectedHex));
  });

  updateSidebar(target);
  fetchAircraftPhoto(hex);
}

// Populate Sidebar
function updateSidebar(ac) {
  document.getElementById('target-hex').textContent = ac.hex.toUpperCase();
  document.getElementById('target-callsign').textContent = ac.flight || 'NO CALLSIGN';
  document.getElementById('target-alt').textContent = ac.alt_baro ? `${ac.alt_baro.toLocaleString()} FT` : '----';
  
  const vrate = ac.vert_rate || 0;
  const vrateSign = vrate > 0 ? `▲ +${vrate}` : (vrate < 0 ? `▼ ${vrate}` : `0`);
  document.getElementById('target-vrate').textContent = `${vrateSign} FPM`;

  document.getElementById('target-speed').textContent = ac.speed ? `${Math.round(ac.speed)} KT` : '---';
  document.getElementById('target-track').textContent = ac.track ? `${Math.round(ac.track)}°` : '---';
  document.getElementById('target-squawk').textContent = ac.squawk || '----';
  document.getElementById('target-sel-alt').textContent = ac.selected_alt ? `${ac.selected_alt.toLocaleString()} FT` : '----';
  document.getElementById('target-rssi').textContent = ac.rssi ? `${ac.rssi.toFixed(1)} dBFS` : '--.-';
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
  document.getElementById('target-rssi').textContent = '--.- dBFS';
  
  const photoBox = document.getElementById('photo-box');
  photoBox.innerHTML = '<div class="photo-placeholder">AWAITING TARGET LOCK</div>';
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

// Tab Switching Controller with Leaflet Size Recalculation
function initTabNavigation() {
  const tabs = document.querySelectorAll('.nav-tab');
  const panes = document.querySelectorAll('.tab-pane');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const targetId = tab.getAttribute('data-tab');

      // Update button active state
      tabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      // Update tab pane visibility
      panes.forEach((pane) => {
        if (pane.id === targetId) {
          pane.classList.add('active');
        } else {
          pane.classList.remove('active');
        }
      });

      // If returning to Radar tab, force Leaflet to recalculate tile layout
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
  fetchTelemetry();
  fetchAircraft();

  // Setting for hardware metrics
  setInterval(fetchTelemetry, 1000);

  // Setting for radio contact metrics
  setInterval(fetchAircraft, 1000);
});