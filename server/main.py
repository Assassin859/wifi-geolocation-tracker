"""Web dashboard backend for the Wi-Fi Triangulation Geolocation Tracker.

Run from the wifi-geolocation-tracker folder:
    uvicorn server.main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")

DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "change-me")
DB_PATH = Path(os.getenv("TRACKER_DB", ROOT / "data" / "tracker.db"))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS fixes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id   TEXT    NOT NULL,
    ts          REAL    NOT NULL,
    lat         REAL    NOT NULL,
    lng         REAL    NOT NULL,
    accuracy    REAL    NOT NULL,
    ap_count    INTEGER NOT NULL,
    stationary  INTEGER NOT NULL DEFAULT 0,
    uptime_s    INTEGER,
    uplink_rssi INTEGER,
    aps_json    TEXT
);
CREATE INDEX IF NOT EXISTS idx_fixes_device_ts ON fixes (device_id, ts);
"""


@contextmanager
def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


with db() as _conn:
    _conn.executescript(SCHEMA)


class AccessPoint(BaseModel):
    bssid: str
    ssid: str = ""
    rssi: int
    channel: int | None = None


class LocationIn(BaseModel):
    device_id: str = Field(min_length=1, max_length=64)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy: float = Field(ge=0)
    ap_count: int = Field(ge=0)
    stationary: bool = False
    uptime_s: int | None = None
    uplink_rssi: int | None = None
    aps: list[AccessPoint] = []


def row_to_fix(row: sqlite3.Row, include_aps: bool = False) -> dict:
    fix = {
        "id": row["id"],
        "device_id": row["device_id"],
        "ts": row["ts"],
        "lat": row["lat"],
        "lng": row["lng"],
        "accuracy": row["accuracy"],
        "ap_count": row["ap_count"],
        "stationary": bool(row["stationary"]),
        "uptime_s": row["uptime_s"],
        "uplink_rssi": row["uplink_rssi"],
    }
    if include_aps:
        fix["aps"] = json.loads(row["aps_json"] or "[]")
    return fix


app = FastAPI(title="Wi-Fi Geolocation Tracker")


@app.post("/api/location", status_code=201)
def ingest_location(fix: LocationIn, x_device_key: str = Header(default="")):
    if x_device_key != DEVICE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid X-Device-Key")
    with db() as conn:
        cur = conn.execute(
            """INSERT INTO fixes (device_id, ts, lat, lng, accuracy, ap_count, stationary,
                                  uptime_s, uplink_rssi, aps_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                fix.device_id,
                time.time(),
                fix.lat,
                fix.lng,
                fix.accuracy,
                fix.ap_count,
                int(fix.stationary),
                fix.uptime_s,
                fix.uplink_rssi,
                json.dumps([ap.model_dump() for ap in fix.aps]),
            ),
        )
    return {"id": cur.lastrowid}


@app.get("/api/devices")
def list_devices():
    with db() as conn:
        rows = conn.execute(
            """SELECT f.* , c.fix_count FROM fixes f
               JOIN (SELECT device_id, MAX(id) AS last_id, COUNT(*) AS fix_count
                     FROM fixes GROUP BY device_id) c ON f.id = c.last_id
               ORDER BY f.ts DESC"""
        ).fetchall()
    return [{**row_to_fix(r), "fix_count": r["fix_count"]} for r in rows]


@app.get("/api/locations")
def list_locations(
    device_id: str,
    since: float | None = Query(default=None, description="Unix timestamp"),
    limit: int = Query(default=2000, ge=1, le=20000),
):
    sql = "SELECT * FROM fixes WHERE device_id = ?"
    params: list = [device_id]
    if since is not None:
        sql += " AND ts >= ?"
        params.append(since)
    sql += " ORDER BY ts DESC LIMIT ?"
    params.append(limit)
    with db() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [row_to_fix(r) for r in reversed(rows)]


@app.get("/api/latest")
def latest(device_id: str):
    with db() as conn:
        row = conn.execute(
            "SELECT * FROM fixes WHERE device_id = ? ORDER BY ts DESC LIMIT 1", (device_id,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No fixes for this device")
    return row_to_fix(row, include_aps=True)


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")
