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

let mapView = null;

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

function fixPopup(f) {
  return `<div class="map-popup"><b>${formatTime(f.ts)}</b><br>${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}<br>&plusmn; ${Math.round(f.accuracy)} m &middot; ${f.ap_count} APs</div>`;
}

function latestPopup(f) {
  return `<div class="map-popup"><b>${escapeHtml(f.device_id)}</b><br>${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}<br>&plusmn; ${Math.round(f.accuracy)} m<br>${formatTime(f.ts)}</div>`;
}

function renderMap() {
  if (!mapView) return;
  const fixes = state.fixes;
  const signature = `${mapView.name}|${state.deviceId}|${state.range}|${fixes.length}|${state.latest?.id}`;
  if (signature === state.mapSignature) return;
  state.mapSignature = signature;

  mapView.setTrack(fixes);
  const f = state.latest;
  mapView.setLatest(f);
  if (!f) return;

  if (state.fittedFor !== state.deviceId) {
    state.fittedFor = state.deviceId;
    fitTrack();
  } else if (state.follow && f.id !== state.lastFixId) {
    mapView.panTo(f.lat, f.lng);
  }
  state.lastFixId = f.id;
}

function fitTrack() {
  mapView?.fitTrack(state.fixes, state.latest);
}

// ------------------------------------------------------------ map setup

const mapHooks = { onUserMove: () => setFollow(false), fixPopup, latestPopup };

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 8000);
}

// Google Maps rewrites its container, so each backend gets a fresh element.
function freshMapElement() {
  const old = $("map");
  const el = old.cloneNode(false);
  old.replaceWith(el);
  return el;
}

function useLeaflet(reason) {
  if (mapView?.name === "leaflet") return;
  try {
    mapView?.destroy();
  } catch (err) {
    // A Google map that failed authentication throws on teardown; its element is replaced anyway.
    console.warn(err);
  }
  mapView = createLeafletMap(freshMapElement(), mapHooks);
  state.mapSignature = null;
  state.fittedFor = null;
  if (reason) showToast(`${reason} Showing OpenStreetMap instead.`);
  renderMap();
}

async function initMap() {
  let config = {};
  try {
    config = await getJson("/api/config");
  } catch (err) {
    console.error(err);
  }

  const hasGoogle = Boolean(config.google_maps_key);
  const select = $("mapSelect");
  $("mapField").hidden = !hasGoogle;
  const preferred = localStorage.getItem("mapProvider") || "google";
  select.value = preferred;
  select.addEventListener("change", () => {
    localStorage.setItem("mapProvider", select.value);
    location.reload();
  });

  if (!hasGoogle || preferred !== "google") {
    useLeaflet();
    return;
  }

  try {
    const googleView = await createGoogleMap(
      freshMapElement(),
      {
        key: config.google_maps_key,
        mapId: config.google_maps_map_id,
        onAuthFailure: () =>
          useLeaflet("Google Maps rejected the API key (check the key, its referrer restrictions and billing)."),
      },
      mapHooks
    );
    if (mapView?.name === "leaflet") {
      try {
        googleView.destroy();
      } catch (err) {
        console.warn(err);
      }
      return;
    }
    mapView = googleView;
    state.mapSignature = null;
    renderMap();
  } catch (err) {
    console.error(err);
    useLeaflet("Google Maps could not be loaded.");
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
  if (state.follow && state.latest) mapView?.panTo(state.latest.lat, state.latest.lng);
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
  mapView?.focus(Number(row.dataset.lat), Number(row.dataset.lng));
});

initMap();
refresh();
setInterval(refresh, POLL_MS);
setInterval(renderStatus, 1000);
