"""Locate this computer with the same Wi-Fi + Google Geolocation API flow the ESP board uses.

Useful for checking your API key and the dashboard before flashing any hardware.

    python tools/pc_geolocate.py              # scan, query Google, print the fix
    python tools/pc_geolocate.py --post       # ...and publish it to the dashboard

Supported scanners: Windows (netsh) and Linux (nmcli).
"""

from __future__ import annotations

import argparse
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

GEOLOCATION_URL = "https://www.googleapis.com/geolocation/v1/geolocate"
MAX_APS = 15
MIN_APS = 2


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


def geolocate(aps: list[dict], api_key: str) -> dict:
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
    res = requests.post(GEOLOCATION_URL, params={"key": api_key}, json=body, timeout=15)
    data = res.json()
    if res.status_code != 200:
        err = data.get("error", {})
        reason = (err.get("errors") or [{}])[0].get("reason", "")
        sys.exit(f"Google API error {res.status_code}: {err.get('message')} ({reason})")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--api-key", default=os.getenv("GOOGLE_API_KEY"), help="Google API key (or GOOGLE_API_KEY in server/.env)")
    parser.add_argument("--post", action="store_true", help="publish the fix to the dashboard")
    parser.add_argument("--server", default=os.getenv("DASHBOARD_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--device-id", default="pc-" + platform.node().lower())
    parser.add_argument("--device-key", default=os.getenv("DEVICE_API_KEY", "change-me"))
    args = parser.parse_args()

    if not args.api_key:
        sys.exit("Set GOOGLE_API_KEY in server/.env or pass --api-key.")

    system = platform.system()
    if system == "Windows":
        raw = scan_windows()
    elif system == "Linux":
        raw = scan_linux()
    else:
        sys.exit(f"No Wi-Fi scanner implemented for {system}.")

    aps = select_aps(raw)
    print(f"{len(raw)} access points visible, {len(aps)} used:")
    for ap in aps:
        print(f"  {ap['bssid']}  ch{ap['channel'] or '?':<3} {ap['rssi']:>4} dBm  {ap['ssid'] or '<hidden>'}")
    if len(aps) < MIN_APS:
        print(f"\nWarning: Google usually needs at least {MIN_APS} access points; the request may fail.")

    data = geolocate(aps, args.api_key)
    lat, lng = data["location"]["lat"], data["location"]["lng"]
    acc = data["accuracy"]
    print(f"\nFix: {lat:.6f}, {lng:.6f}  (+/- {acc:.0f} m)")
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
