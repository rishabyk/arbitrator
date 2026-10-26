# System restore bootstrap script

set -euo pipefail

echo -e "\n\033[1;36m[+] Initializing Arbitrator Node Restoration...\033[0m"

# Base packages & Dev Tools
echo -e "\033[1;33m[+] Updating packages & installing system dependencies...\033[0m"
sudo apt update
sudo apt install -y git python3-pip python3-venv uhubctl rtl-sdr librtlsdr-dev curl wget

# Blacklist Linux TV kernel drivers (prevents tuner locks on usb dongle)
echo -e "\033[1;33m[+] Configuring TV kernel driver blacklist...\033[0m"
cat << 'EOF' | sudo tee /etc/modprobe.d/blacklist-rtl.conf > /dev/null
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
EOF

# Passwordless sudo rule for headless access
echo -e "\033[1;33m[+] Configuring passwordless sudo rule...\033[0m"
echo "$USER ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/010_"$USER"-nopasswd > /dev/null

# Python venv setup
echo -e "\033[1;33m[+] Configuring Python virtual environment...\033[0m"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Tailscale
if ! command -v tailscale &> /dev/null; then
    echo -e "\033[1;33m[+] Installing Tailscale...\033[0m"
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh
else
    echo -e "\033[1;32m[+] Tailscale already installed.\033[0m"
fi

# readsb for reciever decoding
if ! command -v readsb &> /dev/null; then
    echo -e "\033[1;33m[+] Installing readsb ADS-B decoder daemon...\033[0m"
    bash -c "$(wget -nv -O - https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh)"
fi

# 7. Set Receiver to Standby
echo -e "\033[1;33m[+] Setting SDR Receiver to standby mode...\033[0m"
sudo systemctl disable --now readsb || true

echo -e "\n\033[1;32m[✓] Arbitrator restored.\033[0m"
echo -e "• SDR Receiver state: \033[1;33mSTANDBY (OFF)\033[0m"
echo -e "• Turn receiver ON:    \033[1;36msudo systemctl start readsb\033[0m"
echo -e "• Turn receiver OFF:   \033[1;36msudo systemctl stop readsb\033[0m"
echo -e "• Run backend server:  \033[1;34mcd backend && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000\033[0m\n"