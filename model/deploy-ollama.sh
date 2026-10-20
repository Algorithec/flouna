#!/bin/bash
# Deploy Flouna's 1.5B intent model to a Linux VM (Oracle Ampere A1, EC2, etc.)
# behind Caddy, so the model is reachable only over HTTPS with a bearer token.
#
# Ollama itself checks nothing: bound to 0.0.0.0 on 11434, anyone on the
# internet could run the model. Here it listens on localhost only and Caddy,
# which terminates TLS, refuses any request without the token the backend
# sends as OLLAMA_API_KEY (see server/src/modules/chat/llm/ollama.ts).
#
# Prerequisites:
#   - Ubuntu 22.04/24.04 VM, 20 GB disk, ports 80 and 443 open (NOT 11434)
#   - A DNS name pointing at the VM (Caddy needs it for the certificate)
#
# Usage:
#   1. Copy files to the VM:
#        scp -i your-key.pem model/flouna-1.5b-q8.gguf model/Modelfile-1.5b \
#            model/deploy-ollama.sh ubuntu@<VM_IP>:~/
#   2. SSH in and run:
#        ssh -i your-key.pem ubuntu@<VM_IP>
#        chmod +x deploy-ollama.sh
#        DOMAIN=llm.example.com ./deploy-ollama.sh
#      OLLAMA_API_KEY is generated if unset; pass your own to keep an existing one.
#
# After it finishes, set in the backend env:
#   LLM_PROVIDER=ollama
#   OLLAMA_URL=https://<DOMAIN>
#   OLLAMA_MODEL=flouna-1.5b
#   OLLAMA_API_KEY=<printed at the end>

set -euo pipefail

MODEL_NAME="flouna-1.5b"
: "${DOMAIN:?Set DOMAIN to the DNS name pointing at this VM, e.g. DOMAIN=llm.example.com}"
OLLAMA_API_KEY="${OLLAMA_API_KEY:-$(openssl rand -hex 32)}"

cd ~
for f in flouna-1.5b-q8.gguf Modelfile-1.5b; do
  [ -f "$f" ] || { echo "Missing ~/$f, copy it to the VM first"; exit 1; }
done

echo "=== 1/5 Installing Ollama ==="
command -v ollama >/dev/null || curl -fsSL https://ollama.com/install.sh | sh

echo "=== 2/5 Binding Ollama to localhost only ==="
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null <<CONF
[Service]
Environment="OLLAMA_HOST=127.0.0.1:11434"
Environment="OLLAMA_KEEP_ALIVE=-1"
CONF
sudo systemctl daemon-reload
sudo systemctl enable ollama
sudo systemctl restart ollama
sleep 3

echo "=== 3/5 Creating ${MODEL_NAME} ==="
# The GGUF is already q8_0, so no --quantize: Ollama only quantizes f16/f32.
ollama create "$MODEL_NAME" -f Modelfile-1.5b

echo "=== 4/5 Installing Caddy (HTTPS + bearer token) ==="
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
fi
sudo tee /etc/caddy/Caddyfile > /dev/null <<CADDY
${DOMAIN} {
	@unauthorized not header Authorization "Bearer ${OLLAMA_API_KEY}"
	respond @unauthorized 401
	reverse_proxy 127.0.0.1:11434
}
CADDY
sudo chmod 640 /etc/caddy/Caddyfile
sudo chown root:caddy /etc/caddy/Caddyfile
if command -v ufw >/dev/null && sudo ufw status | grep -q active; then
  sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
fi
# Ubuntu images on Oracle Cloud ship iptables rules that reject everything
# but SSH, ahead of any ufw rule, so open 80/443 there too.
if sudo iptables -S INPUT 2>/dev/null | grep -q "REJECT"; then
  for port in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null \
      || sudo iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT
  done
  command -v netfilter-persistent >/dev/null && sudo netfilter-persistent save
fi
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 5

echo "=== 5/5 Verifying through Caddy ==="
code=$(curl -s -o /dev/null -w "%{http_code}" "https://${DOMAIN}/api/tags" || true)
echo "  without token: HTTP ${code} (want 401)"
curl -s "https://${DOMAIN}/api/chat" \
  -H "Authorization: Bearer ${OLLAMA_API_KEY}" \
  -d "{\"model\": \"${MODEL_NAME}\", \"stream\": false,
       \"messages\": [{\"role\": \"user\", \"content\": \"biryani chahiye under 500\"}]}" \
  | python3 -c "import sys,json; print('  with token:', json.load(sys.stdin)['message']['content'])" \
  || echo "  with token: no answer yet (certificate or first load may still be in progress)"

echo ""
echo "=== Done ==="
echo "Set in the backend env:"
echo "  LLM_PROVIDER=ollama"
echo "  OLLAMA_URL=https://${DOMAIN}"
echo "  OLLAMA_MODEL=${MODEL_NAME}"
echo "  OLLAMA_API_KEY=${OLLAMA_API_KEY}"
echo "Store the key somewhere safe; it is only in /etc/caddy/Caddyfile on this VM."
