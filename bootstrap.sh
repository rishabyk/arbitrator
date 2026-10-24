set -euo pipefail

echo -e "\n\033[1;36m[+] Restoring Arbitrator\033[0m"

# Packages & devtools
echo -e "\033[1;33m[+] Updating packages & installing dependencies...\033[0m"
sudo apt update
sudo apt install -y git python3-pip python3-venv uhubctl rtl-sdr librtlsdr-dev

# 2. Passwordless sudo
echo -e "\033[1;33m[+] Adding passwordless sudo rule...\033[0m"
echo "$USER ALL=(ALL) NOPASSWD: ALL" | sudo tee /etc/sudoers.d/010_"$USER"-nopasswd > /dev/null

# 3. Python venv setup
echo -e "\033[1;33m[+] Adding Python Venv...\033[0m"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/backend"

if [ ! -d "venv" ]; then
    python3 -m venv venv
fi

# setup dependencies
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# 4. Installing Tailscale
if ! command -v tailscale &> /dev/null; then
    echo -e "\033[1;33m[+] Installing Tailscale...\033[0m"
    curl -fsSL https://tailscale.com/install.sh | sh
    sudo tailscale up --ssh
else
    echo -e "\033[1;32m[+] Tailscale already installed.\033[0m"
fi

echo -e "\n\033[1;32m[✓] Restored Arbitrator successfully.\033[0m"
echo -e "Run backend with: \033[1;34mcd backend && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000\033[0m\n"