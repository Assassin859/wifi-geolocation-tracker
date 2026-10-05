// Copy this file to config.h (same folder) and fill in your values.
// config.h is git-ignored so your keys never get committed.
#pragma once

// ---------------------------------------------------------------- Wi-Fi uplink
// The network the board uses to reach the internet (home Wi-Fi or a phone hotspot).
#define WIFI_SSID      "YourWiFiName"
#define WIFI_PASSWORD  "YourWiFiPassword"

// ------------------------------------------------- Wi-Fi geolocation service
// GEO_PROVIDER_BEACONDB: free, no key, but only works where beaconDB knows the
//                        networks (add yours with the NeoStumbler Android app).
// GEO_PROVIDER_GOOGLE:   best coverage; needs a Google Cloud billing account and
//                        GOOGLE_API_KEY below, restricted to the "Geolocation API".
#define GEO_PROVIDER   GEO_PROVIDER_BEACONDB
#define GOOGLE_API_KEY "AIza...your-key..."

// ------------------------------------------------------------ Device identity
#define DEVICE_ID      "esp-tracker-01"

// ------------------------------------------------------------ Web dashboard
// Set ENABLE_DASHBOARD to 0 if you only use Blynk.
// DASHBOARD_URL must be reachable from the board, so use your PC's LAN IP, not localhost.
#define ENABLE_DASHBOARD  1
#define DASHBOARD_URL     "http://192.168.1.50:8000/api/location"
#define DASHBOARD_KEY     "change-me"   // must match DEVICE_API_KEY in server/.env

// ------------------------------------------------------------------- Blynk IoT
// Set ENABLE_BLYNK to 1 after creating a template in https://blynk.cloud
// The three BLYNK_* values are shown on the device's "Device Info" tab.
#define ENABLE_BLYNK  0
#define BLYNK_TEMPLATE_ID   "TMPLxxxxxxxxx"
#define BLYNK_TEMPLATE_NAME "WiFi Geo Tracker"
#define BLYNK_AUTH_TOKEN    "YourBlynkDeviceAuthToken"

// --------------------------------------------------------------------- Tuning
#define SCAN_INTERVAL_MS      30000UL     // how often to scan nearby networks
#define FORCE_REFRESH_MS      (15UL * 60UL * 1000UL) // re-query Google even when stationary
#define HEARTBEAT_MS          (5UL * 60UL * 1000UL)  // re-publish last fix while stationary
#define MAX_APS               15          // strongest APs sent per request
#define MIN_APS               2           // Google needs at least 2 APs for a fix
#define MIN_RSSI_DBM          -92         // ignore APs weaker than this
// Jaccard similarity of the visible BSSID set vs. the last query. At or above this
// value the device is treated as stationary and the geolocation call is skipped.
#define STATIONARY_SIMILARITY 0.5f
