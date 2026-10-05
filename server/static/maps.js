// Map backends for the dashboard. Both expose the same interface:
//   name                       "google" | "leaflet"
//   setTrack(fixes)            polyline + one dot per fix
//   setLatest(fix | null)      pulsing marker + accuracy circle
//   panTo(lat, lng)
//   focus(lat, lng)            pan and zoom in close
//   fitTrack(fixes, latest)
//   destroy()

const TRACK_COLOR = "#4f8cff";
const ACCURACY_COLOR = "#22d3ee";
const MAX_ZOOM_ON_FIT = 17;
// Each Google dot is a DOM element, so very long tracks only get dots on the newest fixes.
const MAX_GOOGLE_DOTS = 500;

function dotColor(accuracy) {
  if (accuracy <= 30) return "#22c55e";
  if (accuracy <= 100) return "#f59e0b";
  return "#ef4444";
}

// ---------------------------------------------------------------- Leaflet / OSM

function createLeafletMap(el, { onUserMove, fixPopup, latestPopup }) {
  const map = L.map(el, { zoomControl: true }).setView([20, 0], 2);

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

  const trackLine = L.polyline([], { color: TRACK_COLOR, weight: 3, opacity: 0.85 }).addTo(map);
  const pointsLayer = L.layerGroup().addTo(map);
  const accuracyCircle = L.circle([0, 0], {
    radius: 0, color: ACCURACY_COLOR, weight: 1.5, fillColor: ACCURACY_COLOR, fillOpacity: 0.12,
  });
  const latestMarker = L.marker([0, 0], {
    icon: L.divIcon({ className: "", html: '<div class="pulse-marker"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    zIndexOffset: 1000,
  });

  map.on("dragstart", onUserMove);

  return {
    name: "leaflet",

    setTrack(fixes) {
      trackLine.setLatLngs(fixes.map((f) => [f.lat, f.lng]));
      pointsLayer.clearLayers();
      fixes.slice(0, -1).forEach((f) => {
        L.circleMarker([f.lat, f.lng], {
          radius: 4, weight: 1, color: "#0b1020", fillColor: dotColor(f.accuracy), fillOpacity: 0.9,
        })
          .bindPopup(fixPopup(f))
          .addTo(pointsLayer);
      });
    },

    setLatest(f) {
      if (!f) {
        accuracyCircle.remove();
        latestMarker.remove();
        return;
      }
      accuracyCircle.setLatLng([f.lat, f.lng]).setRadius(f.accuracy).addTo(map);
      latestMarker.setLatLng([f.lat, f.lng]).bindPopup(latestPopup(f)).addTo(map);
    },

    panTo(lat, lng) {
      map.panTo([lat, lng]);
    },

    focus(lat, lng) {
      map.setView([lat, lng], Math.max(map.getZoom(), MAX_ZOOM_ON_FIT));
    },

    fitTrack(fixes, latest) {
      if (fixes.length > 1) {
        map.fitBounds(trackLine.getBounds().pad(0.2), { maxZoom: MAX_ZOOM_ON_FIT });
      } else if (latest) {
        map.fitBounds(accuracyCircle.getBounds().pad(0.5), { maxZoom: MAX_ZOOM_ON_FIT });
      }
    },

    destroy() {
      map.remove();
    },
  };
}

// ------------------------------------------------------- Google Maps JavaScript API

let googleMapsLoading = null;

function loadGoogleMaps(key) {
  if (googleMapsLoading) return googleMapsLoading;
  googleMapsLoading = new Promise((resolve, reject) => {
    window.__gmapsReady = resolve;
    const script = document.createElement("script");
    const params = new URLSearchParams({ key, v: "weekly", loading: "async", callback: "__gmapsReady" });
    script.src = `https://maps.googleapis.com/maps/api/js?${params}`;
    script.async = true;
    script.onerror = () => reject(new Error("Could not download the Google Maps script"));
    document.head.appendChild(script);
  });
  return googleMapsLoading;
}

async function createGoogleMap(el, { key, mapId, onAuthFailure }, { onUserMove, fixPopup, latestPopup }) {
  // Google calls this global when the key is invalid, unauthorised for this
  // referrer, or the Maps JavaScript API / billing is not enabled.
  window.gm_authFailure = onAuthFailure;

  await loadGoogleMaps(key);
  const { Map, Polyline, Circle, InfoWindow } = await google.maps.importLibrary("maps");
  const { AdvancedMarkerElement } = await google.maps.importLibrary("marker");
  const { LatLngBounds, ControlPosition, ColorScheme } = await google.maps.importLibrary("core");

  const map = new Map(el, {
    center: { lat: 20, lng: 0 },
    zoom: 2,
    // Advanced markers need a map ID; DEMO_MAP_ID works for development.
    mapId: mapId || "DEMO_MAP_ID",
    colorScheme: ColorScheme ? ColorScheme.DARK : undefined,
    mapTypeControl: true,
    mapTypeControlOptions: { position: ControlPosition.TOP_RIGHT },
    streetViewControl: true,
    fullscreenControl: true,
    scaleControl: true,
    clickableIcons: false,
    gestureHandling: "greedy",
  });

  const info = new InfoWindow();
  const trackLine = new Polyline({ map, strokeColor: TRACK_COLOR, strokeWeight: 3, strokeOpacity: 0.85 });
  const accuracyCircle = new Circle({
    strokeColor: ACCURACY_COLOR, strokeWeight: 1.5, fillColor: ACCURACY_COLOR, fillOpacity: 0.12, clickable: false,
  });

  const latestEl = document.createElement("div");
  latestEl.className = "pulse-marker gm-anchor-center";
  const latestMarker = new AdvancedMarkerElement({ content: latestEl, zIndex: 1000 });
  let latestFix = null;
  latestMarker.addListener("click", () => {
    if (!latestFix) return;
    info.setContent(latestPopup(latestFix));
    info.open({ map, anchor: latestMarker });
  });

  let dots = [];

  map.addListener("dragstart", onUserMove);

  function capZoomAfterFit() {
    google.maps.event.addListenerOnce(map, "idle", () => {
      if (map.getZoom() > MAX_ZOOM_ON_FIT) map.setZoom(MAX_ZOOM_ON_FIT);
    });
  }

  return {
    name: "google",

    setTrack(fixes) {
      trackLine.setPath(fixes.map((f) => ({ lat: f.lat, lng: f.lng })));

      dots.forEach((m) => (m.map = null));
      dots = fixes.slice(0, -1).slice(-MAX_GOOGLE_DOTS).map((f) => {
        const el = document.createElement("div");
        el.className = "gm-dot gm-anchor-center";
        el.style.background = dotColor(f.accuracy);
        const marker = new AdvancedMarkerElement({ map, position: { lat: f.lat, lng: f.lng }, content: el });
        marker.addListener("click", () => {
          info.setContent(fixPopup(f));
          info.open({ map, anchor: marker });
        });
        return marker;
      });
    },

    setLatest(f) {
      latestFix = f;
      if (!f) {
        accuracyCircle.setMap(null);
        latestMarker.map = null;
        return;
      }
      const pos = { lat: f.lat, lng: f.lng };
      accuracyCircle.setCenter(pos);
      accuracyCircle.setRadius(f.accuracy);
      accuracyCircle.setMap(map);
      latestMarker.position = pos;
      latestMarker.map = map;
    },

    panTo(lat, lng) {
      map.panTo({ lat, lng });
    },

    focus(lat, lng) {
      map.panTo({ lat, lng });
      map.setZoom(Math.max(map.getZoom(), MAX_ZOOM_ON_FIT));
    },

    fitTrack(fixes, latest) {
      if (fixes.length > 1) {
        const bounds = new LatLngBounds();
        fixes.forEach((f) => bounds.extend({ lat: f.lat, lng: f.lng }));
        map.fitBounds(bounds, 60);
        capZoomAfterFit();
      } else if (latest) {
        map.fitBounds(accuracyCircle.getBounds(), 60);
        capZoomAfterFit();
      }
    },

    destroy() {
      dots.forEach((m) => (m.map = null));
      latestMarker.map = null;
      google.maps.event.clearInstanceListeners(map);
    },
  };
}
