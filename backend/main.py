import json
import os
import time
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import psutil

app = FastAPI(title="Node Arbitrator")

# Allows requests from local frontend instance during development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ADS-B .json output files
ADSB_FILEPATHS = [
    "/run/readsb/aircraft.json",
    "/run/dump1090-fa/aircraft.json",
    "/var/run/dump1090-mutability/aircraft.json",
]

def getCPUTemp() -> float:  
    "returns cpu temp, for get_telemetry"
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except Exception:
    # if testing w/o hardware
        return 0.0

@app.get("/api/telemetry")
def get_telemetry():
    """Returns system vitals such as temperatures, uptime, memory & disk"""
    cpu_percent = psutil.cpu_percent(interval=None)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    uptime_sec = time.time() - psutil.boot_time()

    return {
        "hostname": "arbitrator",
        "cpu_usage_pct": cpu_percent,
        "cpu_temp_c": getCPUTemp(),
        "memory_used_pct": mem.percent,
        "memory_used_mb": round(mem.used / (1024 * 1024)),
        "memory_total_mb": round(mem.total / (1024 * 1024)),
        "disk_used_pct": disk.percent,
        "uptime_hours": round(uptime_sec / 3600, 2),
    }


def check_receiver_status():
    """Checks if receiver processes are running, returns receiver state, sent to get_aircraft()"""
    decoder_names = {"readsb", "dump1090", "dump1090-fa"}

    # Check if a decoder daemon process is running
    process_running = any(
        p.info["name"] in decoder_names
        for p in psutil.process_iter(["name"])
    )

    if not process_running:
        return "INACTIVE", "RECEIVER OFFLINE // UNDER MAINTENANCE"

    # Check if the output file is actively receiving updates
    for path in ADSB_FILEPATHS:
        if os.path.exists(path):
            file_age_sec = time.time() - os.path.getmtime(path)
            if file_age_sec < 5:
                return "ONLINE", "RECEIVER ACTIVE // NO ISSUES"
            return "DEGRADED", "RECEIVER TROUBLE // NO RECENT FRAMES"

    return "INITIALIZING", "RECEIVER ATTEMPTING LOCK // PLEASE WAIT"


@app.get("/api/aircraft")
def get_aircraft():
    """Returns ADS-B contacts and receiver status"""
    status, status_msg = check_receiver_status()

    # Default payload, allows to escape early in case of receiver trouble
    response = {
        "status": status,
        "status_message": status_msg,
        "source": "sdr_receiver",
        "total_tracked": 0,
        "aircraft": [],
    }

    # if trouble with receiver, escape early
    if status != "ONLINE":
        return response

    # If ONLINE, parse the active aircraft file
    for path in ADSB_FILEPATHS:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    data = json.load(f)
                    aircraft = [
                        {
                            "hex": a.get("hex"),
                            "flight": a.get("flight", "").strip(),
                            "alt_baro": a.get("alt_baro"),
                            "speed": a.get("gs"),
                            "track": a.get("track"),
                            "lat": a.get("lat"),
                            "lon": a.get("lon"),
                            "rssi": a.get("rssi"),
                        }
                        for a in data.get("aircraft", [])
                        if a.get("lat") and a.get("lon")
                    ]
                    response["total_tracked"] = len(aircraft)
                    response["aircraft"] = aircraft
                    return response
            except Exception as e:
                response["status"] = "ERROR"
                response["status_message"] = f"BUFFER READ ERROR: {str(e)}"
                return response

    return response


# Pointing FastAPI to the Frontend directory
frontend_path = os.path.join(os.path.dirname(__file__), "../frontend")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="static")