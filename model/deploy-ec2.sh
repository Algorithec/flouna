#!/bin/bash
# Deploy Flouna's Ollama model to an EC2 instance.
#
# Usage (from your Mac):
#   1. Launch EC2: t3.small, Ubuntu 24.04, 20GB disk, open port 11434
#   2. Copy files to EC2:
#        scp -i your-key.pem -r model/flouna-fused model/Modelfile ubuntu@<EC2_IP>:~/
#   3. SSH in and run this script:
#        ssh -i your-key.pem ubuntu@<EC2_IP>
#        chmod +x deploy-ec2.sh && ./deploy-ec2.sh
#
# After it finishes, set in your backend env:
#   OLLAMA_URL=http://<EC2_IP>:11434

set -e

echo "=== 1/4 Installing Ollama ==="
curl -fsSL https://ollama.com/install.sh | sh

echo "=== 2/4 Starting Ollama server ==="
# Bind to all interfaces so the backend can reach it
sudo systemctl stop ollama 2>/dev/null || true
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null <<CONF
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
CONF
sudo systemctl daemon-reload
sudo systemctl enable ollama
sudo systemctl start ollama
sleep 3

echo "=== 3/4 Creating Flouna model ==="
cd ~
ollama create flouna -f Modelfile --quantize q8_0

echo "=== 4/4 Verifying ==="
curl -s http://localhost:11434/api/chat -d '{
  "model": "flouna",
  "stream": false,
  "messages": [{"role": "user", "content": "biryani chahiye under 500"}]
}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['message']['content'])" 2>/dev/null || echo "(first load may take a moment)"

echo ""
echo "=== Done! ==="
echo "Ollama is running on port 11434"
echo "Set in your backend: OLLAMA_URL=http://$(curl -s http://checkip.amazonaws.com):11434"
