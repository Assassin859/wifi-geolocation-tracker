"""Publish a simulated walking track to the dashboard (no hardware or Google key needed).

    python tools/simulate_device.py
    python tools/simulate_device.py --lat 28.6139 --lng 77.2090 --count 60 --interval 1
"""

from __future__ import annotations

import argparse
import math
import os
import random
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "server" / ".env")

EARTH_RADIUS_M = 6371000


def move(lat: float, lng: float, distance_m: float, heading_deg: float) -> tuple[float, float]:
    h = math.radians(heading_deg)
    dlat = distance_m * math.cos(h) / EARTH_RADIUS_M
    dlng = distance_m * math.sin(h) / (EARTH_RADIUS_M * math.cos(math.radians(lat)))
    return lat + math.degrees(dlat), lng + math.degrees(dlng)


def fake_aps(rng: random.Random, count: int) -> list[dict]:
    names = ["HomeNet", "CafeFreeWiFi", "Office-5G", "JioFiber", "Airtel_Xstream", "TP-Link_A1", "", "NETGEAR42"]
    aps = []
    for _ in range(count):
        mac = [rng.randrange(256) & 0xFC] + [rng.randrange(256) for _ in range(5)]
        aps.append({
            "bssid": ":".join(f"{b:02X}" for b in mac),
            "ssid": rng.choice(names),
            "rssi": rng.randint(-90, -45),
            "channel": rng.choice([1, 6, 11, 36, 44, 149]),
        })
    return sorted(aps, key=lambda a: a["rssi"], reverse=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--server", default=os.getenv("DASHBOARD_BASE_URL", "http://127.0.0.1:8000"))
    parser.add_argument("--device-key", default=os.getenv("DEVICE_API_KEY", "change-me"))
    parser.add_argument("--device-id", default="sim-tracker")
    parser.add_argument("--lat", type=float, default=28.6139)
    parser.add_argument("--lng", type=float, default=77.2090)
    parser.add_argument("--count", type=int, default=40, help="number of fixes to send")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between fixes")
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    rng = random.Random(args.seed)
    lat, lng, heading = args.lat, args.lng, rng.uniform(0, 360)
    url = f"{args.server.rstrip('/')}/api/location"

    last = None
    for i in range(args.count):
        # Like the firmware, a stationary device re-publishes its previous fix.
        stationary = last is not None and rng.random() < 0.2
        if stationary:
            noisy_lat, noisy_lng, accuracy, aps = last
        else:
            heading = (heading + rng.gauss(0, 25)) % 360
            lat, lng = move(lat, lng, rng.uniform(25, 60), heading)
            accuracy = rng.uniform(12, 70)
            # Report a position scattered around the true one, like real Wi-Fi fixes.
            noisy_lat, noisy_lng = move(lat, lng, rng.uniform(0, accuracy * 0.5), rng.uniform(0, 360))
            aps = fake_aps(rng, rng.randint(4, 12))
            last = (noisy_lat, noisy_lng, accuracy, aps)

        payload = {
            "device_id": args.device_id,
            "lat": noisy_lat,
            "lng": noisy_lng,
            "accuracy": round(accuracy, 1),
            "ap_count": len(aps),
            "stationary": stationary,
            "uptime_s": int(i * args.interval),
            "uplink_rssi": rng.randint(-70, -40),
            "aps": aps,
        }
        res = requests.post(url, json=payload, headers={"X-Device-Key": args.device_key}, timeout=10)
        res.raise_for_status()
        print(f"[{i + 1}/{args.count}] {noisy_lat:.6f}, {noisy_lng:.6f}  +/- {accuracy:.0f} m"
              f"{'  (stationary)' if stationary else ''}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
