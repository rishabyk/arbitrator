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


def is_sdr_hardware_connected() -> bool:
    """Checks linux USB sysfs tree for RTL2832U tuner hardware"""
    usb_dir = "/sys/bus/usb/devices"
    if not os.path.exists(usb_dir):
        return False

    for dev in os.listdir(usb_dir):
        vendor_file = os.path.join(usb_dir, dev, "idVendor")
        product_file = os.path.join(usb_dir, dev, "idProduct")

        if os.path.exists(vendor_file) and os.path.exists(product_file):
            try:
                with open(vendor_file, "r") as vf, open(product_file, "r") as pf:
                    vendor = vf.read().strip()
                    product = pf.read().strip()
                    # 0bda:2838 or 0bda:2832 represents RTL-SDR tuners
                    if vendor == "0bda" and product in ("2838", "2832"):
                        return True
            except Exception:
                continue
    return False


def check_receiver_status():
    """Checks if USB plugged in, daemon process state, and JSON heartbeat"""
    hardware_present = is_sdr_hardware_connected()
    decoder_names = {"readsb", "dump1090", "dump1090-fa"}

    process_running = any(
        p.info["name"] in decoder_names
        for p in psutil.process_iter(["name"])
    )

    # if hardware is missing from the USB port
    if not hardware_present:
        return "DISCONNECTED", "RECEIVER MISSING // HARDWARE UNPLUGGED"

    # if hardware is plugged in, but daemon service is turned off (standby mode)
    if not process_running:
        return "STANDBY", "RECEIVER PARKED // LOW POWER STANDBY"

    # if Hardware is plugged in and daemon is running; check data heartbeat
    for path in ADSB_FILEPATHS:
        if os.path.exists(path):
            file_age_sec = time.time() - os.path.getmtime(path)
            if file_age_sec < 5:
                return "ONLINE", "RECEIVER ACTIVE // NO ISSUES"
            return "DEGRADED", "RECEIVER STALE // NO RECENT FRAMES"

    # 4. Process is up and hardware is present, but buffer is still priming
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
                        "hex": a.get("hex"),  # 24-bit ICAO aircraft transponder id
                        "flight": a.get(
                            "flight", "").strip(),  # Callsign/flight number
                        "squawk": a.get("squawk", "----"),  # squawk
                        "alt_baro": (
                            0 if a.get("alt_baro") == "ground" else a.get("alt_baro")
                        ),  # barometric altitude (ft)
                        "vert_rate": a.get(
                            "baro_rate", 0
                        ),  # vertical ascend/descend rate (ft/m)
                        "selected_alt": a.get(
                            "nav_altitude_mcp"
                        ),  # autopilot target altitude (ft)
                        "speed": a.get("gs"),  # Ground speed (kts)
                        "track": a.get("track"),  # Heading in deg (0–359.9°)
                        "lat": a.get("lat"),  # GPS latitude coordinate
                        "lon": a.get("lon"),  # GPS longitude coordinate
                        "rssi": a.get("rssi"),  # RF signal strength in dBFS (closer to 0 is stronger)
                        "seen_sec": a.get(
                            "seen"
                        ),  # seconds since last radio frame
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