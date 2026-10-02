const POLL_MS = 5000;
// The firmware re-publishes every HEARTBEAT_MS (5 min) while stationary.
const LIVE_WITHIN_S = 6 * 60;
const STALE_WITHIN_S = 30 * 60;

const $ = (id) => document.getElementById(id);

const state = {
  deviceId: localStorage.getItem("deviceId") || "",
  range: Number(localStorage.getItem("range") || 86400),
  follow: true,
  fixes: [],
  latest: null,
  lastFixId: null,
  fittedFor: null,
  mapSignature: null,
};

// ------------------------------------------------------------------ map

const map = L.map("map", { zoomControl: true }).setView([20, 0], 2);

const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const dark = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, maxNativeZoom: 16, attribution: "Tiles &copy; Esri" }
);
const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Tiles &copy; Esri" }
);
L.control.layers({ Streets: streets, Dark: dark, Satellite: satellite }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const trackLine = L.polyline([], { color: "#4f8cff", weight: 3, opacity: 0.85 }).addTo(map);
const pointsLayer = L.layerGroup().addTo(map);
const accuracyCircle = L.circle([0, 0], {
  radius: 0, color: "#22d3ee", weight: 1.5, fillColor: "#22d3ee", fillOpacity: 0.12,
});
const latestMarker = L.marker([0, 0], {
  icon: L.divIcon({ className: "", html: '<div class="pulse-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
  zIndexOffset: 1000,
});

map.on("dragstart", () => setFollow(false));

// -------------------------------------------------------------- helpers

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function accuracyColor(m) {
  if (m <= 30) return "#22c55e";
  if (m <= 100) return "#f59e0b";
  return "#ef4444";
}

function rssiColor(dbm) {
  if (dbm >= -60) return "#22c55e";
  if (dbm >= -75) return "#f59e0b";
  return "#ef4444";
}

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Wi-Fi fixes jitter by tens of metres, so only count hops larger than the
// smaller of the two accuracy radii.
function trackDistance(fixes) {
  let total = 0;
  let prev = null;
  for (const f of fixes) {
    if (f.stationary) continue;
    if (prev) {
      const d = haversine(prev, f);
      if (d > Math.min(prev.accuracy, f.accuracy)) {
        total += d;
        prev = f;
      }
    } else {
      prev = f;
    }
  }
  return total;
}

function formatDistance(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function formatAge(seconds) {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${Math.round(seconds)} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

function formatTime(ts) {
  const d = new Date(ts * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString() : d.toLocaleString();
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function setFollow(on) {
  state.follow = on;
  $("followBtn").classList.toggle("active", on);
}

// ------------------------------------------------------------ rendering

function renderDevices(devices) {
  const select = $("deviceSelect");
  if (!devices.length) {
    select.innerHTML = '<option value="">No devices yet</option>';
    return;
  }
  if (!devices.some((d) => d.device_id === state.deviceId)) {
    state.deviceId = devices[0].device_id;
  }
  select.innerHTML = devices
    .map((d) => `<option value="${escapeHtml(d.device_id)}">${escapeHtml(d.device_id)} (${d.fix_count})</option>`)
    .join("");
  select.value = state.deviceId;
}

function renderStatus() {
  const pill = $("statusPill");
  const text = $("statusText");
  if (!state.latest) {
    pill.className = "pill pill-offline";
    text.textContent = "No data";
    return;
  }
  const age = Date.now() / 1000 - state.latest.ts;
  if (age <= LIVE_WITHIN_S) {
    pill.className = "pill pill-live";
    text.textContent = "Live";
  } else if (age <= STALE_WITHIN_S) {
    pill.className = "pill pill-stale";
    text.textContent = "Stale";
  } else {
    pill.className = "pill pill-offline";
    text.textContent = "Offline";
  }
  $("statAge").textContent = formatAge(age);
}

function renderStats() {
  const f = state.latest;
  $("emptyState").classList.toggle("show", !f);
  if (!f) {
    for (const id of ["statLat", "statLng", "statAcc", "statAps", "statAge", "statDist"]) $(id).textContent = "-";
    $("gmapsLink").classList.add("disabled");
    $("copyBtn").disabled = true;
    return;
  }
  $("statLat").textContent = f.lat.toFixed(6);
  $("statLng").textContent = f.lng.toFixed(6);
  $("statAcc").innerHTML = `<span style="color:${accuracyColor(f.accuracy)}">&plusmn; ${Math.round(f.accuracy)} m</span>`;
  $("statAps").textContent = f.ap_count;
  $("statDist").textContent = formatDistance(trackDistance(state.fixes));
  $("gmapsLink").href = `https://www.google.com/maps/search/?api=1&query=${f.lat},${f.lng}`;
  $("gmapsLink").classList.remove("disabled");
  $("copyBtn").disabled = false;

  const badge = $("motionBadge");
  badge.textContent = f.stationary ? "Stationary" : "Moving";
  badge.className = `badge ${f.stationary ? "stationary" : "moving"}`;
}

function renderAps() {
  const list = $("apList");
  const aps = state.latest?.aps || [];
  if (!aps.length) {
    list.innerHTML = '<li class="muted">No scan data yet</li>';
    return;
  }
  list.innerHTML = aps
    .map((ap) => {
      const pct = Math.max(4, Math.min(100, ((ap.rssi + 95) / 60) * 100));
      const name = ap.ssid ? escapeHtml(ap.ssid) : "&lt;hidden network&gt;";
      return `<li class="ap">
        <span class="ap-ssid ${ap.ssid ? "" : "hidden-ssid"}">${name}</span>
        <span class="ap-rssi">${ap.rssi} dBm</span>
        <span class="ap-meta">${escapeHtml(ap.bssid)}${ap.channel ? ` &middot; ch ${ap.channel}` : ""}</span>
        <span></span>
        <div class="ap-bar"><span style="width:${pct}%;background:${rssiColor(ap.rssi)}"></span></div>
      </li>`;
    })
    .join("");
}

function renderTable() {
  const rows = state.fixes.slice(-50).reverse();
  $("fixCount").textContent = `${state.fixes.length} in range`;
  $("fixTable").innerHTML = rows
    .map(
      (f) => `<tr class="clickable" data-lat="${f.lat}" data-lng="${f.lng}">
        <td>${formatTime(f.ts)}</td>
        <td class="mono">${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}</td>
        <td style="color:${accuracyColor(f.accuracy)}">${Math.round(f.accuracy)}</td>
        <td>${f.ap_count}</td>
      </tr>`
    )
    .join("");
}

function renderMap() {
  const fixes = state.fixes;
  const signature = `${state.deviceId}|${state.range}|${fixes.length}|${state.latest?.id}`;
  if (signature === state.mapSignature) return;
  state.mapSignature = signature;

  trackLine.setLatLngs(fixes.map((f) => [f.lat, f.lng]));

  pointsLayer.clearLayers();
  fixes.slice(0, -1).forEach((f) => {
    L.circleMarker([f.lat, f.lng], {
      radius: 4, weight: 1, color: "#0b1020", fillColor: accuracyColor(f.accuracy), fillOpacity: 0.9,
    })
      .bindPopup(`<b>${formatTime(f.ts)}</b><br>${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}<br>&plusmn; ${Math.round(f.accuracy)} m &middot; ${f.ap_count} APs`)
      .addTo(pointsLayer);
  });

  const f = state.latest;
  if (!f) {
    accuracyCircle.remove();
    latestMarker.remove();
    return;
  }
  accuracyCircle.setLatLng([f.lat, f.lng]).setRadius(f.accuracy).addTo(map);
  latestMarker
    .setLatLng([f.lat, f.lng])
    .bindPopup(`<b>${escapeHtml(f.device_id)}</b><br>${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}<br>&plusmn; ${Math.round(f.accuracy)} m`)
    .addTo(map);

  if (state.fittedFor !== state.deviceId) {
    state.fittedFor = state.deviceId;
    fitTrack();
  } else if (state.follow && f.id !== state.lastFixId) {
    map.panTo([f.lat, f.lng]);
  }
  state.lastFixId = f.id;
}

function fitTrack() {
  if (state.fixes.length > 1) {
    map.fitBounds(trackLine.getBounds().pad(0.2), { maxZoom: 17 });
  } else if (state.latest) {
    map.fitBounds(accuracyCircle.getBounds().pad(0.5), { maxZoom: 17 });
  }
}

// --------------------------------------------------------------- polling

async function refresh() {
  try {
    const devices = await getJson("/api/devices");
    renderDevices(devices);

    if (state.deviceId) {
      const since = state.range ? `&since=${Date.now() / 1000 - state.range}` : "";
      const id = encodeURIComponent(state.deviceId);
      const [fixes, latest] = await Promise.all([
        getJson(`/api/locations?device_id=${id}${since}`),
        getJson(`/api/latest?device_id=${id}`),
      ]);
      state.fixes = fixes;
      state.latest = latest;
    } else {
      state.fixes = [];
      state.latest = null;
    }
  } catch (err) {
    console.error(err);
  }
  renderStatus();
  renderStats();
  renderAps();
  renderTable();
  renderMap();
}

$("deviceSelect").addEventListener("change", (e) => {
  state.deviceId = e.target.value;
  localStorage.setItem("deviceId", state.deviceId);
  state.fittedFor = null;
  refresh();
});

$("rangeSelect").value = String(state.range);
$("rangeSelect").addEventListener("change", (e) => {
  state.range = Number(e.target.value);
  localStorage.setItem("range", state.range);
  state.fittedFor = null;
  refresh();
});

$("followBtn").addEventListener("click", () => {
  setFollow(!state.follow);
  if (state.follow && state.latest) map.panTo([state.latest.lat, state.latest.lng]);
});
$("fitBtn").addEventListener("click", () => {
  setFollow(false);
  fitTrack();
});

$("copyBtn").addEventListener("click", async () => {
  if (!state.latest) return;
  await navigator.clipboard.writeText(`${state.latest.lat.toFixed(6)}, ${state.latest.lng.toFixed(6)}`);
  $("copyBtn").textContent = "Copied!";
  setTimeout(() => ($("copyBtn").textContent = "Copy coordinates"), 1500);
});

$("fixTable").addEventListener("click", (e) => {
  const row = e.target.closest("tr[data-lat]");
  if (!row) return;
  setFollow(false);
  map.setView([Number(row.dataset.lat), Number(row.dataset.lng)], Math.max(map.getZoom(), 17));
});

refresh();
setInterval(refresh, POLL_MS);
setInterval(renderStatus, 1000);
