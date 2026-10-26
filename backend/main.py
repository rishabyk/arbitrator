import json
import math
import os
import subprocess
import time
from fastapi import FastAPI, HTTPException
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

# Default Station Coordinates (Bay Area) for Range & Distance Calculations
STATION_LAT = 37.7749
STATION_LON = -122.3194


def calc_distance_nm(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculates great-circle distance in Nautical Miles (NM) using Haversine formula."""
    r_nm = 3440.065  # Earth radius in Nautical Miles
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)

    a = (
        math.sin(dphi / 2.0) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    )
    return round(2 * r_nm * math.atan2(math.sqrt(a), math.sqrt(1 - a)), 1)


def getCPUTemp() -> float:
    """Returns Pi 5 SoC temperature in Celsius."""
    try:
        with open("/sys/class/thermal/thermal_zone0/temp", "r") as f:
            return round(int(f.read().strip()) / 1000.0, 1)
    except Exception:
        return 0.0


def is_sdr_hardware_connected() -> bool:
    """Checks Linux USB sysfs tree for RTL2832U tuner hardware."""
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
                    if vendor == "0bda" and product in ("2838", "2832"):
                        return True
            except Exception:
                continue
    return False


def check_receiver_status():
    """Checks if USB plugged in, daemon process state, and JSON heartbeat."""
    hardware_present = is_sdr_hardware_connected()
    decoder_names = {"readsb", "dump1090", "dump1090-fa"}

    process_running = any(
        p.info["name"] in decoder_names
        for p in psutil.process_iter(["name"])
    )

    if not hardware_present:
        return "DISCONNECTED", "RECEIVER MISSING // HARDWARE UNPLUGGED"

    if not process_running:
        return "STANDBY", "RECEIVER PARKED // LOW POWER STANDBY"

    for path in ADSB_FILEPATHS:
        if os.path.exists(path):
            file_age_sec = time.time() - os.path.getmtime(path)
            if file_age_sec < 5:
                return "ONLINE", "RECEIVER ACTIVE // NO ISSUES"
            return "DEGRADED", "RECEIVER STALE // NO RECENT FRAMES"

    return "INITIALIZING", "RECEIVER ATTEMPTING LOCK // PLEASE WAIT"


@app.get("/api/telemetry")
def get_telemetry():
    """Returns comprehensive system vitals: CPU cores, clock, thermals, RAM, disk, network & uptime."""
    cpu_percent = psutil.cpu_percent(interval=None)
    cpu_per_core = psutil.cpu_percent(interval=None, percpu=True)
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    net = psutil.net_io_counters()
    uptime_sec = time.time() - psutil.boot_time()

    try:
        freq = psutil.cpu_freq()
        cpu_freq_mhz = round(freq.current) if freq else 0
    except Exception:
        cpu_freq_mhz = 0

    try:
        load_1m, load_5m, load_15m = [round(x, 2) for x in os.getloadavg()]
    except Exception:
        load_1m, load_5m, load_15m = 0.0, 0.0, 0.0

    return {
        "hostname": "arbitrator",
        "cpu_usage_pct": cpu_percent,
        "cpu_per_core": cpu_per_core,
        "cpu_freq_mhz": cpu_freq_mhz,
        "cpu_temp_c": getCPUTemp(),
        "load_avg": [load_1m, load_5m, load_15m],
        "memory_used_pct": mem.percent,
        "memory_used_mb": round(mem.used / (1024 * 1024)),
        "memory_total_mb": round(mem.total / (1024 * 1024)),
        "disk_used_pct": disk.percent,
        "disk_used_gb": round(disk.used / (1024 ** 3), 1),
        "disk_total_gb": round(disk.total / (1024 ** 3), 1),
        "net_sent_mb": round(net.bytes_sent / (1024 * 1024), 1),
        "net_recv_mb": round(net.bytes_recv / (1024 * 1024), 1),
        "process_count": len(psutil.pids()),
        "uptime_hours": round(uptime_sec / 3600, 2),
    }


@app.post("/api/receiver/toggle")
def toggle_receiver():
    """Starts or stops the readsb systemd daemon to control SDR power and thermals."""
    if not is_sdr_hardware_connected():
        raise HTTPException(
            status_code=400,
            detail="SDR hardware is unplugged. Connect the USB tuner first.",
        )

    status, _ = check_receiver_status()
    target_action = "stop" if status in ("ONLINE", "INITIALIZING", "DEGRADED") else "start"

    try:
        subprocess.run(
            ["sudo", "systemctl", target_action, "readsb"],
            check=True,
            timeout=10,
        )
        time.sleep(0.4)  # Allow systemd process table to settle
        new_status, new_msg = check_receiver_status()
        return {
            "success": True,
            "action": target_action,
            "status": new_status,
            "status_message": new_msg,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to {target_action} readsb: {str(e)}",
        )


@app.get("/api/aircraft")
def get_aircraft():
    """Returns ADS-B contacts, distance from station, and receiver status."""
    status, status_msg = check_receiver_status()

    response = {
        "status": status,
        "status_message": status_msg,
        "source": "sdr_receiver",
        "station_lat": STATION_LAT,
        "station_lon": STATION_LON,
        "total_tracked": 0,
        "aircraft": [],
    }

    if status != "ONLINE":
        return response

    for path in ADSB_FILEPATHS:
        if os.path.exists(path):
            try:
                with open(path, "r") as f:
                    data = json.load(f)

                    aircraft = [
                        {
                            "hex": a.get("hex"),
                            "flight": a.get("flight", "").strip(),
                            "squawk": a.get("squawk", "----"),
                            "alt_baro": (
                                0 if a.get("alt_baro") == "ground" else a.get("alt_baro")
                            ),
                            "vert_rate": a.get("baro_rate", 0),
                            "selected_alt": a.get("nav_altitude_mcp"),
                            "speed": a.get("gs"),
                            "track": a.get("track"),
                            "lat": a.get("lat"),
                            "lon": a.get("lon"),
                            "distance_nm": calc_distance_nm(
                                STATION_LAT, STATION_LON, a.get("lat"), a.get("lon")
                            ),
                            "rssi": a.get("rssi"),
                            "seen_sec": a.get("seen", 0),
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