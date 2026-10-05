"""Locate this computer and optionally publish the fix to the dashboard.

Providers:
    windows   Windows Location Service (free, no key; Windows only)
    beacondb  beaconDB Wi-Fi database (free, no key; same request the ESP board sends)
    google    Google Geolocation API (needs GOOGLE_API_KEY)
    auto      google if GOOGLE_API_KEY is set, otherwise windows on Windows, otherwise beacondb

    python tools/pc_geolocate.py                        # auto provider, print the fix
    python tools/pc_geolocate.py --provider windows --post
    python tools/pc_geolocate.py --provider beacondb

Supported Wi-Fi scanners: Windows (netsh) and Linux (nmcli).
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import subprocess
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "server" / ".env")

GOOGLE_URL = "https://www.googleapis.com/geolocation/v1/geolocate"
BEACONDB_URL = "https://api.beacondb.net/v1/geolocate"
# beaconDB asks every client to identify itself.
USER_AGENT = "wifi-geolocation-tracker/1.0 (+https://github.com/Assassin859/wifi-geolocation-tracker)"
MAX_APS = 15
MIN_APS = 2

WINDOWS_LOCATION_PS = r"""
Add-Type -AssemblyName System.Device
$w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)
$null = $w.TryStart($false, [TimeSpan]::FromSeconds(15))
$i = 0
while (($w.Status -ne 'Ready' -or $w.Position.Location.IsUnknown) -and $w.Permission -ne 'Denied' -and $i -lt 40) {
    Start-Sleep -Milliseconds 500; $i++
}
$l = $w.Position.Location
@{ permission = "$($w.Permission)"; status = "$($w.Status)"; unknown = $l.IsUnknown;
   lat = $l.Latitude; lng = $l.Longitude; accuracy = $l.HorizontalAccuracy } | ConvertTo-Json -Compress
$w.Stop()
"""


def quality_to_dbm(percent: int) -> int:
    # Windows/NetworkManager report signal quality 0-100 %, roughly linear in -100..-50 dBm.
    return int(percent / 2 - 100)


def scan_windows() -> list[dict]:
    out = subprocess.run(
        ["netsh", "wlan", "show", "networks", "mode=bssid"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    ).stdout
    if "location" in out.lower() and "BSSID" not in out:
        sys.exit("netsh needs Location access: Settings > Privacy & security > Location > "
                 "enable 'Let desktop apps access your location'.")

    aps, ssid, current = [], "", None
    for raw in out.splitlines():
        line = raw.strip()
        if m := re.match(r"^SSID \d+\s*:\s*(.*)$", line):
            ssid = m.group(1).strip()
        elif m := re.match(r"^BSSID \d+\s*:\s*([0-9a-fA-F:]{17})", line):
            current = {"bssid": m.group(1).upper(), "ssid": ssid, "rssi": None, "channel": None}
            aps.append(current)
        elif current and (m := re.match(r"^Signal\s*:\s*(\d+)%", line)):
            current["rssi"] = quality_to_dbm(int(m.group(1)))
        elif current and (m := re.match(r"^Channel\s*:\s*(\d+)", line)):
            current["channel"] = int(m.group(1))
    return [ap for ap in aps if ap["rssi"] is not None]


def scan_linux() -> list[dict]:
    out = subprocess.run(
        ["nmcli", "-t", "-f", "BSSID,SSID,SIGNAL,CHAN", "dev", "wifi", "list", "--rescan", "yes"],
        capture_output=True, text=True, check=True,
    ).stdout
    aps = []
    for line in out.splitlines():
        parts = [p.replace("\\:", ":") for p in re.split(r"(?<!\\):", line)]
        if len(parts) != 4 or not parts[2].isdigit():
            continue
        aps.append({
            "bssid": parts[0].upper(),
            "ssid": parts[1],
            "rssi": quality_to_dbm(int(parts[2])),
            "channel": int(parts[3]) if parts[3].isdigit() else None,
        })
    return aps


def scan() -> list[dict]:
    system = platform.system()
    if system == "Windows":
        return scan_windows()
    if system == "Linux":
        return scan_linux()
    sys.exit(f"No Wi-Fi scanner implemented for {system}.")


def is_locally_administered(bssid: str) -> bool:
    return bool(int(bssid[:2], 16) & 0x02)


def select_aps(aps: list[dict]) -> list[dict]:
    """Same filtering rules as the firmware."""
    aps = [ap for ap in aps if not ap["ssid"].lower().endswith("_nomap")]
    aps.sort(key=lambda ap: ap["rssi"], reverse=True)
    fixed = [ap for ap in aps if not is_locally_administered(ap["bssid"])]
    if len(fixed) >= MIN_APS:
        aps = fixed
    return aps[:MAX_APS]


def query_wifi_service(name: str, url: str, aps: list[dict], params: dict | None = None) -> tuple[float, float, float]:
    """Google and beaconDB share the same request/response format."""
    body = {
        "considerIp": False,
        "wifiAccessPoints": [
            {k: v for k, v in {
                "macAddress": ap["bssid"],
                "signalStrength": ap["rssi"],
                "channel": ap["channel"],
            }.items() if v is not None}
            for ap in aps
        ],
    }
    res = requests.post(url, params=params, json=body, headers={"User-Agent": USER_AGENT}, timeout=15)
    data = res.json()
    if res.status_code != 200:
        err = data.get("error", {})
        reason = (err.get("errors") or [{}])[0].get("reason", "")
        hint = ""
        if name == "beaconDB" and reason == "notFound":
            hint = ("\nbeaconDB doesn't know these networks yet. Add them with the free NeoStumbler app "
                    "(Android), or try --provider windows.")
        sys.exit(f"{name} error {res.status_code}: {err.get('message')} ({reason}){hint}")
    if data.get("fallback"):
        sys.exit(f"{name} only returned a coarse '{data['fallback']}' fallback estimate, not a Wi-Fi fix.")
    return data["location"]["lat"], data["location"]["lng"], data["accuracy"]


def locate_windows() -> tuple[float, float, float]:
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_LOCATION_PS],
        capture_output=True, text=True, timeout=60,
    ).stdout.strip()
    try:
        data = json.loads(out.splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        sys.exit(f"Could not read the Windows location: {out or 'no output'}")
    if data["permission"] == "Denied":
        sys.exit("Windows denied location access: Settings > Privacy & security > Location > "
                 "turn on Location services and 'Let desktop apps access your location'.")
    if data["unknown"]:
        sys.exit(f"Windows has no location fix yet (status: {data['status']}). Try again in a minute.")
    return data["lat"], data["lng"], data["accuracy"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--provider", choices=["auto", "windows", "beacondb", "google"],
                        default=os.getenv("GEO_PROVIDER", "auto"))
    parser.add_argument("--api-key", default=os.getenv("GOOGLE_API_KEY"), help="Google API key (or GOOGLE_API_KEY in server/.env)")
    parser.add_argument("--post", action="store_true", help="publish the fix to the dashboard")
    parser.add_argument("--server", default=os.getenv("DASHBOARD_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--device-id", default="pc-" + platform.node().lower())
    parser.add_argument("--device-key", default=os.getenv("DEVICE_API_KEY", "change-me"))
    args = parser.parse_args()

    provider = args.provider
    if provider == "auto":
        if args.api_key:
            provider = "google"
        elif platform.system() == "Windows":
            provider = "windows"
        else:
            provider = "beacondb"
    if provider == "google" and not args.api_key:
        sys.exit("Set GOOGLE_API_KEY in server/.env or pass --api-key.")

    # The scan is listed on the dashboard for every provider, and is the input for Wi-Fi providers.
    raw = scan()
    aps = select_aps(raw)
    print(f"{len(raw)} access points visible, {len(aps)} used:")
    for ap in aps:
        print(f"  {ap['bssid']}  ch{ap['channel'] or '?':<3} {ap['rssi']:>4} dBm  {ap['ssid'] or '<hidden>'}")

    if provider == "windows":
        print("\nAsking Windows Location Service...")
        lat, lng, acc = locate_windows()
    else:
        if len(aps) < MIN_APS:
            print(f"\nWarning: Wi-Fi geolocation usually needs at least {MIN_APS} access points; the request may fail.")
        if provider == "google":
            print("\nQuerying Google Geolocation API...")
            lat, lng, acc = query_wifi_service("Google", GOOGLE_URL, aps, params={"key": args.api_key})
        else:
            print("\nQuerying beaconDB...")
            lat, lng, acc = query_wifi_service("beaconDB", BEACONDB_URL, aps)

    print(f"\nFix ({provider}): {lat:.6f}, {lng:.6f}  (+/- {acc:.0f} m)")
    print(f"https://www.google.com/maps/search/?api=1&query={lat},{lng}")

    if args.post:
        payload = {
            "device_id": args.device_id,
            "lat": lat, "lng": lng, "accuracy": acc,
            "ap_count": len(aps),
            "aps": aps,
        }
        res = requests.post(f"{args.server.rstrip('/')}/api/location", json=payload,
                            headers={"X-Device-Key": args.device_key}, timeout=10)
        res.raise_for_status()
        print(f"Published to {args.server} as '{args.device_id}'.")


if __name__ == "__main__":
    main()
