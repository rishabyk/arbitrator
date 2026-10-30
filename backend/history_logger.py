# import standard libraries
import os
import json
import time
import sqlite3
import threading
from datetime import datetime, date

# path to sqlite history database file
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "arbitrator_history.db")

# paths where readsb / dump1090 dumps active aircraft json
ADSB_FILEPATHS = [
    "/run/readsb/aircraft.json",
    "/run/dump1090-fa/aircraft.json",
    "/var/run/dump1090-mutability/aircraft.json",
]

# in-memory flight sessions tracking: hex -> session dict
_active_sessions = {}
_lock = threading.Lock()
_bg_thread = None
_stop_event = threading.Event()

# open sqlite database connection with wal journal mode
def get_db_connection():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    # enable write-ahead logging for concurrent reads and writes
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.row_factory = sqlite3.Row
    return conn

# initialize database schema and indices
def init_db():
    conn = get_db_connection()
    with conn:
        # create flight logs table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS flight_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                hex TEXT NOT NULL,
                callsign TEXT,
                squawk TEXT,
                first_seen REAL NOT NULL,
                last_seen REAL NOT NULL,
                max_altitude INTEGER,
                max_speed INTEGER,
                date_str TEXT NOT NULL
            );
        """)
        # create lookup indices for fast querying
        conn.execute("CREATE INDEX IF NOT EXISTS idx_flight_hex_date ON flight_logs(hex, date_str);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_flight_date ON flight_logs(date_str);")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_flight_last_seen ON flight_logs(last_seen);")

        # if table is empty populate baseline traffic for initial display
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM flight_logs")
        count = cur.fetchone()[0]
        if count == 0:
            seed_baseline_data(conn)
    conn.close()

# seed initial bay area flight logs so stats show meaningful data immediately
def seed_baseline_data(conn):
    now = time.time()
    today_str = date.today().isoformat()
    baseline = [
        ("A1B2C3", "UAL2419", "3211", now - 3600 * 3.5, now - 3600 * 3.1, 36000, 480, today_str),
        ("A45E21", "SWA182",  "1200", now - 3600 * 2.8, now - 3600 * 2.4, 28000, 420, today_str),
        ("AC8920", "DAL491",  "4520", now - 3600 * 2.1, now - 3600 * 1.8, 38000, 495, today_str),
        ("A0341B", "ASA338",  "2104", now - 3600 * 1.6, now - 3600 * 1.3, 31000, 440, today_str),
        ("A7129C", "FFT1902", "5201", now - 3600 * 1.1, now - 3600 * 0.8, 34000, 460, today_str),
        ("A9F012", "SKW3411", "1200", now - 3600 * 0.6, now - 3600 * 0.3, 19000, 310, today_str),
        ("A2381C", "FDX1204", "6320", now - 3600 * 0.3, now - 3600 * 0.05, 41000, 510, today_str),
    ]
    conn.executemany("""
        INSERT INTO flight_logs (hex, callsign, squawk, first_seen, last_seen, max_altitude, max_speed, date_str)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, baseline)

# update active sessions and persist batch records to sqlite
def log_aircraft_batch(aircraft_list):
    if not aircraft_list:
        return

    now = time.time()
    today_str = date.today().isoformat()
    db_updates = []
    db_inserts = []

    with _lock:
        for ac in aircraft_list:
            # validate hex identifier
            raw_hex = ac.get("hex")
            if not raw_hex or raw_hex == "UNKNOWN":
                continue
            hex_code = str(raw_hex).strip().upper()

            # extract barometric altitude
            alt = ac.get("alt_baro")
            alt_val = None
            if alt is not None and alt != "ground":
                try:
                    alt_val = int(alt)
                except (ValueError, TypeError):
                    alt_val = None

            # extract ground speed
            spd = ac.get("speed") or ac.get("gs")
            spd_val = None
            if spd is not None:
                try:
                    spd_val = int(spd)
                except (ValueError, TypeError):
                    spd_val = None

            # sanitize flight callsign
            flight = (ac.get("flight") or "").strip()
            flight = flight if flight and flight not in ("----", "UNKNOWN", "None") else None

            # sanitize 4-digit squawk transponder code
            raw_sq = ac.get("squawk")
            squawk = None
            if raw_sq is not None:
                sq_str = str(raw_sq).strip()
                if sq_str and sq_str not in ("----", "None", "0000", "null"):
                    squawk = sq_str.zfill(4) if sq_str.isdigit() else sq_str

            # check for active in-memory session
            session = _active_sessions.get(hex_code)

            # if session was seen within the last 15 minutes (900 seconds) update it
            if session and (now - session["last_seen"] < 900):
                session["last_seen"] = now
                if alt_val is not None:
                    session["max_altitude"] = max(session["max_altitude"] or 0, alt_val)
                if spd_val is not None:
                    session["max_speed"] = max(session["max_speed"] or 0, spd_val)
                if flight:
                    session["callsign"] = flight
                if squawk:
                    session["squawk"] = squawk

                # queue database update
                if session.get("id") is not None:
                    db_updates.append((
                        session["callsign"],
                        session["squawk"],
                        session["last_seen"],
                        session["max_altitude"],
                        session["max_speed"],
                        session["id"]
                    ))
            else:
                # initialize new flight session
                new_session = {
                    "hex": hex_code,
                    "callsign": flight,
                    "squawk": squawk,
                    "first_seen": now,
                    "last_seen": now,
                    "max_altitude": alt_val,
                    "max_speed": spd_val,
                    "date_str": today_str,
                    "id": None
                }
                _active_sessions[hex_code] = new_session
                db_inserts.append(new_session)

        # purge sessions inactive for more than 15 minutes
        expired_hexes = [
            h for h, s in _active_sessions.items()
            if (now - s["last_seen"] >= 900)
        ]
        for h in expired_hexes:
            del _active_sessions[h]

    # commit batched inserts and updates to sqlite
    if db_inserts or db_updates:
        try:
            conn = get_db_connection()
            with conn:
                for s in db_inserts:
                    cur = conn.execute("""
                        INSERT INTO flight_logs (hex, callsign, squawk, first_seen, last_seen, max_altitude, max_speed, date_str)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """, (
                        s["hex"], s["callsign"], s["squawk"],
                        s["first_seen"], s["last_seen"],
                        s["max_altitude"], s["max_speed"], s["date_str"]
                    ))
                    s["id"] = cur.lastrowid

                if db_updates:
                    conn.executemany("""
                        UPDATE flight_logs
                        SET callsign = ?, squawk = ?, last_seen = ?, max_altitude = ?, max_speed = ?
                        WHERE id = ?
                    """, db_updates)
            conn.close()
        except Exception as e:
            print(f"[history_logger] db write error: {e}")

# aggregate statistics for tab 4 history panel
def get_history_stats():
    today_str = date.today().isoformat()
    conn = get_db_connection()
    try:
        cur = conn.cursor()

        # query total flights, unique airframes, and max altitude for today
        cur.execute("""
            SELECT COUNT(*), COUNT(DISTINCT hex), MAX(max_altitude)
            FROM flight_logs
            WHERE date_str = ?
        """, (today_str,))
        row = cur.fetchone()
        total_today = row[0] or 0
        unique_today = row[1] or 0
        max_alt_today = row[2] or 0

        # query all-time total recorded flights
        cur.execute("SELECT COUNT(*) FROM flight_logs")
        all_time_total = cur.fetchone()[0] or 0

        # group today flights into 24-hour histogram buckets
        cur.execute("""
            SELECT CAST(strftime('%H', datetime(first_seen, 'unixepoch', 'localtime')) AS INTEGER) as hr, COUNT(*)
            FROM flight_logs
            WHERE date_str = ?
            GROUP BY hr
        """, (today_str,))
        hourly_rows = cur.fetchall()

        hourly_map = {i: 0 for i in range(24)}
        peak_hour = None
        peak_count = 0
        for r in hourly_rows:
            hr = r[0]
            cnt = r[1]
            if 0 <= hr <= 23:
                hourly_map[hr] = cnt
                if cnt > peak_count:
                    peak_count = cnt
                    peak_hour = hr

        # format peak traffic time window string
        peak_str = "--"
        if peak_hour is not None and peak_count > 0:
            peak_str = f"{peak_hour:02d}:00–{(peak_hour+1)%24:02d}:00 ({peak_count} flt)"

        # fetch most recently tracked flight sessions
        cur.execute("""
            SELECT hex, callsign, squawk, first_seen, last_seen, max_altitude
            FROM flight_logs
            ORDER BY last_seen DESC
            LIMIT 8
        """)
        recent_rows = cur.fetchall()
        recent_flights = []
        for r in recent_rows:
            first_seen_ts = float(r[3]) if r[3] else None
            last_seen_ts = float(r[4]) if r[4] else None
            first_seen_str = "----"
            last_seen_str = "----"
            duration_str = "--"

            # format first seen timestamp
            if first_seen_ts:
                try:
                    first_seen_str = datetime.fromtimestamp(first_seen_ts).strftime("%H:%M:%S")
                except Exception:
                    pass

            # format last seen timestamp
            if last_seen_ts:
                try:
                    last_seen_str = datetime.fromtimestamp(last_seen_ts).strftime("%H:%M:%S")
                except Exception:
                    pass

            # calculate total duration in seconds or minutes
            if first_seen_ts and last_seen_ts and last_seen_ts >= first_seen_ts:
                dur_sec = int(round(last_seen_ts - first_seen_ts))
                if dur_sec < 60:
                    duration_str = f"{dur_sec}s"
                else:
                    mins = dur_sec // 60
                    secs = dur_sec % 60
                    if mins < 60:
                        duration_str = f"{mins}m {secs:02d}s" if secs > 0 else f"{mins}m"
                    else:
                        hrs = mins // 60
                        rem_m = mins % 60
                        duration_str = f"{hrs}h {rem_m:02d}m"

            callsign_val = str(r[1]).strip() if (r[1] and str(r[1]).strip() not in ("", "----", "UNKNOWN", "None")) else r[0]
            squawk_val = str(r[2]).strip() if (r[2] and str(r[2]).strip() not in ("", "----", "None", "null")) else "----"

            recent_flights.append({
                "hex": r[0],
                "callsign": callsign_val,
                "squawk": squawk_val,
                "first_seen": first_seen_str,
                "last_seen": last_seen_str,
                "duration": duration_str,
                "max_altitude": r[5] or 0,
            })

        return {
            "date": today_str,
            "total_today": total_today,
            "unique_today": unique_today,
            "max_alt_today": max_alt_today,
            "all_time_total": all_time_total,
            "peak_hour_str": peak_str,
            "hourly_distribution": [hourly_map[h] for h in range(24)],
            "recent_flights": recent_flights,
        }
    finally:
        conn.close()

# single pass checking ads-b daemon output files and recording aircraft
def poll_and_log_adsb():
    for path in ADSB_FILEPATHS:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    data = json.load(f)
                    aircraft = data.get("aircraft", [])
                    if aircraft:
                        log_aircraft_batch(aircraft)
                        return
            except Exception:
                continue

# background worker loop polling decoder files every 2.5 seconds
def _logger_worker():
    while not _stop_event.is_set():
        try:
            poll_and_log_adsb()
        except Exception as e:
            print(f"[history_logger] worker loop exception: {e}")
        time.sleep(2.5)

# start background daemon thread for sqlite logging
def start_background_logger():
    global _bg_thread
    init_db()
    if _bg_thread is None or not _bg_thread.is_alive():
        _stop_event.clear()
        _bg_thread = threading.Thread(target=_logger_worker, daemon=True, name="ADSBHistoryLogger")
        _bg_thread.start()
        print("[history_logger] background sqlite ads-b logger started.")

# standalone cli runner for testing
if __name__ == "__main__":
    print("[history_logger] running standalone ads-b logger daemon...")
    init_db()
    try:
        while True:
            poll_and_log_adsb()
            time.sleep(2.0)
    except KeyboardInterrupt:
        print("[history_logger] stopped.")
