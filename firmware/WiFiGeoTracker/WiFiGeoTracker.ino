/*
  Wi-Fi Triangulation Geolocation Tracker
  ---------------------------------------
  Scans nearby Wi-Fi access points (BSSID + RSSI + channel), sends them to the
  Google Maps Geolocation API and receives latitude / longitude / accuracy -
  no GPS module required. Fixes are published to Blynk IoT and/or the bundled
  web dashboard (server/).

  Boards:    ESP32 (Arduino core 2.x / 3.x) or ESP8266 (Arduino core 3.x)
  Libraries: ArduinoJson 7.x (Benoit Blanchon)
             Blynk 1.3+ (Volodymyr Shymanskyy) - only if ENABLE_BLYNK = 1
*/

#if __has_include("config.h")
  #include "config.h"
#else
  #error "Missing config.h - copy config.example.h to config.h and fill in your keys."
#endif

#if defined(ESP32)
  #include <WiFi.h>
  #include <HTTPClient.h>
  #include <WiFiClientSecure.h>
  typedef WiFiClientSecure SecureClient;
  #define HTTP_CONNECT_FAILED HTTPC_ERROR_CONNECTION_REFUSED
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
  #include <WiFiClientSecureBearSSL.h>
  typedef BearSSL::WiFiClientSecure SecureClient;
  #define HTTP_CONNECT_FAILED HTTPC_ERROR_CONNECTION_FAILED
#else
  #error "This sketch supports ESP32 and ESP8266 boards only."
#endif

#include <ArduinoJson.h>

#if ENABLE_BLYNK
  #define BLYNK_PRINT Serial
  #if defined(ESP32)
    #include <BlynkSimpleEsp32.h>
  #else
    #include <BlynkSimpleEsp8266.h>
  #endif

  // Blynk datastreams (create these in your Blynk template):
  #define VPIN_LOCATION  V0   // Location  - Map widget (longitude, latitude)
  #define VPIN_ACCURACY  V1   // Double    - accuracy radius in metres
  #define VPIN_AP_COUNT  V2   // Integer   - access points used
  #define VPIN_STATUS    V3   // String    - Moving / Stationary / error text
  #define VPIN_MAPS_LINK V4   // String    - Google Maps URL of the last fix
  #define VPIN_LOCATE    V5   // Integer   - push button: force a new fix
#endif

static const char *GEOLOCATION_URL =
    "https://www.googleapis.com/geolocation/v1/geolocate?key=" GOOGLE_API_KEY;

struct AccessPoint {
  uint8_t bssid[6];
  char    bssidStr[18];
  char    ssid[33];
  int32_t rssi;
  int32_t channel;
};

struct Fix {
  bool     valid = false;
  double   lat = 0;
  double   lng = 0;
  float    accuracy = 0;
  uint8_t  apCount = 0;
  uint32_t obtainedAt = 0;
};

static AccessPoint aps[MAX_APS];
static uint8_t     apCount = 0;

// BSSID set used for the last successful Google query, for motion detection.
static uint8_t lastQueryBssids[MAX_APS][6];
static uint8_t lastQueryCount = 0;

static Fix      lastFix;
static uint32_t lastScanAt = 0;
static uint32_t lastPublishAt = 0;
static bool     forceRefresh = true;

// ---------------------------------------------------------------- helpers

static bool isLocallyAdministered(const uint8_t *mac) { return mac[0] & 0x02; }

static bool endsWith(const char *s, const char *suffix) {
  size_t ls = strlen(s), lx = strlen(suffix);
  return ls >= lx && strcasecmp(s + ls - lx, suffix) == 0;
}

static void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("[wifi] connecting to \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000) {
    delay(500);
    Serial.print('.');
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[wifi] connected, IP %s, RSSI %d dBm\n",
                  WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  } else {
    Serial.println("\n[wifi] connection failed, will retry");
  }
}

// ------------------------------------------------------------------ scanning

// Scans, filters and keeps the strongest MAX_APS access points in `aps`.
static void scanAccessPoints() {
  Serial.println("[scan] scanning...");
  int n = WiFi.scanNetworks(/*async=*/false, /*show_hidden=*/true);
  if (n < 0) n = 0;

  // Sort scan result indices by RSSI, strongest first.
  int *order = new int[n > 0 ? n : 1];
  for (int i = 0; i < n; i++) order[i] = i;
  for (int i = 1; i < n; i++) {
    int key = order[i], j = i - 1;
    while (j >= 0 && WiFi.RSSI(order[j]) < WiFi.RSSI(key)) { order[j + 1] = order[j]; j--; }
    order[j + 1] = key;
  }

  // Phone hotspots and other mobile APs usually use locally administered
  // (randomised) MACs. They move with their owner and poison the fix, so they
  // are only used when there are not enough fixed APs.
  int globalCount = 0;
  for (int k = 0; k < n; k++) {
    int i = order[k];
    if (WiFi.RSSI(i) >= MIN_RSSI_DBM && !isLocallyAdministered(WiFi.BSSID(i))) globalCount++;
  }
  bool dropLocal = globalCount >= MIN_APS;

  apCount = 0;
  for (int k = 0; k < n && apCount < MAX_APS; k++) {
    int i = order[k];
    String ssid = WiFi.SSID(i);
    const uint8_t *mac = WiFi.BSSID(i);

    if (WiFi.RSSI(i) < MIN_RSSI_DBM) continue;
    if (endsWith(ssid.c_str(), "_nomap")) continue;  // owner opted out of location services
    if (dropLocal && isLocallyAdministered(mac)) continue;

    AccessPoint &ap = aps[apCount++];
    memcpy(ap.bssid, mac, 6);
    snprintf(ap.bssidStr, sizeof(ap.bssidStr), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    strlcpy(ap.ssid, ssid.c_str(), sizeof(ap.ssid));
    ap.rssi = WiFi.RSSI(i);
    ap.channel = WiFi.channel(i);
  }

  delete[] order;
  WiFi.scanDelete();

  Serial.printf("[scan] %d networks visible, %u usable\n", n, apCount);
  for (uint8_t i = 0; i < apCount; i++) {
    Serial.printf("   %2u  %s  ch%-3d %4d dBm  %s\n", i + 1, aps[i].bssidStr,
                  (int)aps[i].channel, (int)aps[i].rssi,
                  aps[i].ssid[0] ? aps[i].ssid : "<hidden>");
  }
}

// Jaccard similarity between the current scan and the last queried BSSID set.
static float similarityToLastQuery() {
  if (lastQueryCount == 0 || apCount == 0) return 0.0f;
  int common = 0;
  for (uint8_t i = 0; i < apCount; i++) {
    for (uint8_t j = 0; j < lastQueryCount; j++) {
      if (memcmp(aps[i].bssid, lastQueryBssids[j], 6) == 0) { common++; break; }
    }
  }
  int unionSize = apCount + lastQueryCount - common;
  return unionSize > 0 ? (float)common / unionSize : 0.0f;
}

static void rememberQuerySet() {
  lastQueryCount = apCount;
  for (uint8_t i = 0; i < apCount; i++) memcpy(lastQueryBssids[i], aps[i].bssid, 6);
}

// ----------------------------------------------------- Google Geolocation API

// Returns true and fills `out` on success; otherwise fills `error`.
static bool queryGoogle(Fix &out, String &error) {
  JsonDocument req;
  req["considerIp"] = false;
  JsonArray list = req["wifiAccessPoints"].to<JsonArray>();
  for (uint8_t i = 0; i < apCount; i++) {
    JsonObject o = list.add<JsonObject>();
    o["macAddress"] = aps[i].bssidStr;
    o["signalStrength"] = aps[i].rssi;
    o["channel"] = aps[i].channel;
  }
  String body;
  serializeJson(req, body);

  SecureClient client;
  // Certificate validation is skipped to avoid shipping/rotating root CAs.
  // Restrict the API key to the Geolocation API to limit exposure.
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(client, GEOLOCATION_URL)) {
    error = "HTTPS begin failed";
    return false;
  }
  http.addHeader("Content-Type", "application/json");

  Serial.printf("[geo] querying Google with %u APs\n", apCount);
  int code = http.POST(body);
  String payload = code > 0 ? http.getString() : String();
  http.end();

  if (code <= 0) {
    error = "HTTP error: " + HTTPClient::errorToString(code);
    return false;
  }

  JsonDocument res;
  DeserializationError jerr = deserializeJson(res, payload);
  if (jerr) {
    error = String("Bad JSON (HTTP ") + code + "): " + jerr.c_str();
    return false;
  }

  if (code != 200) {
    const char *msg = res["error"]["message"] | "unknown error";
    const char *reason = res["error"]["errors"][0]["reason"] | "";
    error = String("Google ") + code + ": " + msg;
    if (reason[0]) error += String(" (") + reason + ")";
    return false;
  }

  out.valid = true;
  out.lat = res["location"]["lat"].as<double>();
  out.lng = res["location"]["lng"].as<double>();
  out.accuracy = res["accuracy"].as<float>();
  out.apCount = apCount;
  out.obtainedAt = millis();
  return true;
}

// ---------------------------------------------------------------- publishing

static String mapsLink(const Fix &f) {
  return "https://maps.google.com/?q=" + String(f.lat, 6) + "," + String(f.lng, 6);
}

#if ENABLE_DASHBOARD
static int postJson(WiFiClient &client, const char *url, const String &body) {
  HTTPClient http;
  http.setTimeout(8000);
  if (!http.begin(client, url)) return HTTP_CONNECT_FAILED;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DASHBOARD_KEY);
  int code = http.POST(body);
  http.end();
  return code;
}
#endif

static void publishDashboard(const Fix &f, bool stationary) {
#if ENABLE_DASHBOARD
  JsonDocument doc;
  doc["device_id"] = DEVICE_ID;
  doc["lat"] = serialized(String(f.lat, 7));
  doc["lng"] = serialized(String(f.lng, 7));
  doc["accuracy"] = f.accuracy;
  doc["ap_count"] = f.apCount;
  doc["stationary"] = stationary;
  doc["uptime_s"] = millis() / 1000;
  doc["uplink_rssi"] = WiFi.RSSI();
  JsonArray list = doc["aps"].to<JsonArray>();
  for (uint8_t i = 0; i < apCount; i++) {
    JsonObject o = list.add<JsonObject>();
    o["bssid"] = aps[i].bssidStr;
    o["ssid"] = aps[i].ssid;
    o["rssi"] = aps[i].rssi;
    o["channel"] = aps[i].channel;
  }
  String body;
  serializeJson(doc, body);

  int code;
  if (strncmp(DASHBOARD_URL, "https", 5) == 0) {
    SecureClient client;
    client.setInsecure();
    code = postJson(client, DASHBOARD_URL, body);
  } else {
    WiFiClient client;
    code = postJson(client, DASHBOARD_URL, body);
  }

  if (code == 200 || code == 201) {
    Serial.println("[dash] published");
  } else {
    Serial.printf("[dash] publish failed: %d %s\n", code,
                  code < 0 ? HTTPClient::errorToString(code).c_str() : "");
  }
#else
  (void)f; (void)stationary;
#endif
}

static void publishBlynk(const Fix &f, bool stationary) {
#if ENABLE_BLYNK
  if (!Blynk.connected()) return;
  Blynk.virtualWrite(VPIN_LOCATION, f.lng, f.lat);  // Blynk expects longitude first
  Blynk.virtualWrite(VPIN_ACCURACY, f.accuracy);
  Blynk.virtualWrite(VPIN_AP_COUNT, f.apCount);
  Blynk.virtualWrite(VPIN_STATUS, stationary ? "Stationary" : "Moving");
  Blynk.virtualWrite(VPIN_MAPS_LINK, mapsLink(f));
#else
  (void)f; (void)stationary;
#endif
}

static void publishStatus(const String &status) {
#if ENABLE_BLYNK
  if (Blynk.connected()) Blynk.virtualWrite(VPIN_STATUS, status);
#else
  (void)status;
#endif
}

static void publish(const Fix &f, bool stationary) {
  publishDashboard(f, stationary);
  publishBlynk(f, stationary);
  lastPublishAt = millis();
}

#if ENABLE_BLYNK
BLYNK_WRITE(VPIN_LOCATE) {
  if (param.asInt() == 1) {
    forceRefresh = true;
    lastScanAt = 0;  // run on the next loop iteration
  }
}
#endif

// ------------------------------------------------------------- main cycle

static void trackerCycle() {
  scanAccessPoints();

  if (apCount < MIN_APS) {
    Serial.printf("[geo] only %u usable APs (need %d), skipping\n", apCount, MIN_APS);
    publishStatus("Too few Wi-Fi networks");
    return;
  }

  float similarity = similarityToLastQuery();
  bool fixIsFresh = lastFix.valid && millis() - lastFix.obtainedAt < FORCE_REFRESH_MS;
  bool stationary = similarity >= STATIONARY_SIMILARITY;

  if (!forceRefresh && fixIsFresh && stationary) {
    Serial.printf("[geo] stationary (similarity %.2f), reusing last fix\n", similarity);
    if (millis() - lastPublishAt >= HEARTBEAT_MS) publish(lastFix, true);
    return;
  }

  Fix fix;
  String error;
  if (!queryGoogle(fix, error)) {
    Serial.printf("[geo] %s\n", error.c_str());
    publishStatus(error.substring(0, 60));
    return;
  }

  forceRefresh = false;
  rememberQuerySet();
  lastFix = fix;

  Serial.printf("[geo] FIX  lat %.6f  lng %.6f  +/- %.0f m  (%u APs, similarity %.2f)\n",
                fix.lat, fix.lng, fix.accuracy, fix.apCount, similarity);
  Serial.printf("[geo] %s\n", mapsLink(fix).c_str());
  publish(fix, false);
}

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Wi-Fi Triangulation Geolocation Tracker ===");
  Serial.printf("device: %s\n", DEVICE_ID);

  WiFi.persistent(false);
  connectWiFi();

#if ENABLE_BLYNK
  Blynk.config(BLYNK_AUTH_TOKEN);
  if (WiFi.status() == WL_CONNECTED) Blynk.connect(10000);
#endif
}

void loop() {
#if ENABLE_BLYNK
  Blynk.run();
#endif

  if (millis() - lastScanAt < SCAN_INTERVAL_MS && lastScanAt != 0) {
    delay(10);
    return;
  }
  lastScanAt = millis();

  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) return;

#if ENABLE_BLYNK
  if (!Blynk.connected()) Blynk.connect(5000);
#endif

  trackerCycle();
}
