let map;
let aircraftMarkers = {}; // hex -> { marker, data }
let selectedHex = null;

// SVG airplane symbol, used in createPlaneIcon()
const PLANE_SVG = `
<svg class="plane-svg" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2L9 9H3L2 11L9 13V19L7 20V22L12 21L17 22V20L15 19V13L22 11L21 9H15L12 2Z" />
</svg>
`;

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

// Rotate SVG icon according to plane
function createPlaneIcon(heading = 0, isSelected = false) {
  const selectedClass = isSelected ? 'selected' : '';
  const html = `
    <div style="transform: rotate(${heading}deg); width: 24px; height: 24px;">
      <svg class="plane-svg ${selectedClass}" viewBox="0 0 24 24">
        <path d="M12 2L9 9H3L2 11L9 13V19L7 20V22L12 21L17 22V20L15 19V13L22 11L21 9H15L12 2Z" />
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

    // Update receiver status badge
    const badge = document.getElementById('receiver-status');
    badge.textContent = data.status;
    badge.className = 'metric-val status-badge';
    if (data.status === 'INACTIVE' || data.status === 'DEGRADED') {
      badge.classList.add('inactive');
    } else if (data.status === 'ERROR') {
      badge.classList.add('error');
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

// Initialize & Loop timers
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  fetchTelemetry();
  fetchAircraft();

  // Setting for hardware metrics
  setInterval(fetchTelemetry, 1000);

  // Setting for radio contact metrics
  setInterval(fetchAircraft, 1000);
});