#!/usr/bin/env bash
set -euo pipefail

# =========================================================
# OmniVideo remote VIP voice/render worker on AWS EC2 Spot.
# Run from the OmniVideo repo root with AWS CLI configured.
# =========================================================

# ====== CONFIG ======
REGION="${REGION:-ap-east-1}" # Hong Kong
AZ="${AZ:-ap-east-1a}"
INSTANCE_TYPE="${INSTANCE_TYPE:-c8g.xlarge}" # ARM64 Graviton4: 4 vCPU / 8 GiB
KEY_NAME="${KEY_NAME:-omnivideo-vip-key}"
SG_NAME="${SG_NAME:-omnivideo-vip-worker-sg}"
INSTANCE_NAME="${INSTANCE_NAME:-omnivideo-vip-worker-spot}"
WORKER_PORT="${WORKER_PORT:-8787}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-80}"

# Default Piper voice model used by the VIP EC2 voice/render worker.
# Override both env vars when testing another model.
DEFAULT_PIPER_MODEL_URL="https://drive.google.com/file/d/1F9rYPsYJ4--fEQ6A7Tv0Wxy1IVvHqzhb/view?usp=sharing"
DEFAULT_PIPER_MODEL_CONFIG_URL="https://drive.google.com/file/d/1qDZm60pX3-n6ODYixbTmL_VeAndVtMML/view?usp=sharing"
PIPER_MODEL_URL="${PIPER_MODEL_URL:-$DEFAULT_PIPER_MODEL_URL}"
PIPER_MODEL_CONFIG_URL="${PIPER_MODEL_CONFIG_URL:-$DEFAULT_PIPER_MODEL_CONFIG_URL}"

REMOTE_APP_DIR="/opt/omnivideo/app"
REMOTE_ARCHIVE="/tmp/omnivideo-worker.tar.gz"
# ====================

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

generate_worker_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
    return
  fi
  python3 - <<'PY'
import secrets
print(secrets.token_hex(24))
PY
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing command: $1"
    exit 1
  fi
}

require_cmd aws
require_cmd curl
require_cmd tar
require_cmd ssh
require_cmd scp

WORKER_TOKEN="${WORKER_TOKEN:-$(generate_worker_token)}"

if [[ ! -f package.json || ! -d src ]]; then
  echo "Run this script from the OmniVideo repository root."
  exit 1
fi

if { [[ -n "$PIPER_MODEL_URL" ]] && [[ -z "$PIPER_MODEL_CONFIG_URL" ]]; } || { [[ -z "$PIPER_MODEL_URL" ]] && [[ -n "$PIPER_MODEL_CONFIG_URL" ]]; }; then
  echo "PIPER_MODEL_URL and PIPER_MODEL_CONFIG_URL must be provided together."
  exit 1
fi

aws configure set region "$REGION"
MY_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '\n')/32"

log "Using region: $REGION"
log "Using AZ: $AZ"
log "Using instance type: $INSTANCE_TYPE"
log "Your IP: $MY_IP"

log "Checking AWS identity..."
aws sts get-caller-identity >/dev/null

log "Finding default VPC..."
VPC_ID="$(aws ec2 describe-vpcs \
  --region "$REGION" \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"

if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
  echo "No default VPC found in $REGION."
  exit 1
fi

log "Finding subnet in $AZ..."
SUBNET_ID="$(aws ec2 describe-subnets \
  --region "$REGION" \
  --filters "Name=vpc-id,Values=$VPC_ID" "Name=availability-zone,Values=$AZ" \
  --query 'Subnets[0].SubnetId' \
  --output text)"

if [[ "$SUBNET_ID" == "None" || -z "$SUBNET_ID" ]]; then
  echo "No subnet found in $AZ. Try AZ=ap-east-1b or AZ=ap-east-1c."
  exit 1
fi

log "Creating key pair if needed..."
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  aws ec2 create-key-pair \
    --region "$REGION" \
    --key-name "$KEY_NAME" \
    --query 'KeyMaterial' \
    --output text > "${KEY_NAME}.pem"
  chmod 400 "${KEY_NAME}.pem"
  log "Created local key file: ${KEY_NAME}.pem"
elif [[ ! -f "${KEY_NAME}.pem" ]]; then
  echo "AWS key pair $KEY_NAME exists, but ${KEY_NAME}.pem is not in this folder."
  exit 1
fi

log "Creating/reusing security group..."
SG_ID="$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' \
  --output text 2>/dev/null || true)"

if [[ "$SG_ID" == "None" || -z "$SG_ID" ]]; then
  SG_ID="$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "OmniVideo VIP worker security group" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' \
    --output text)"
fi

log "Allowing SSH and worker port only from current IP..."
aws ec2 authorize-security-group-ingress \
  --region "$REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$MY_IP,Description=SSH from current IP}]" \
  >/dev/null 2>&1 || true
aws ec2 authorize-security-group-ingress \
  --region "$REGION" \
  --group-id "$SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=$WORKER_PORT,ToPort=$WORKER_PORT,IpRanges=[{CidrIp=$MY_IP,Description=OmniVideo worker from current IP}]" \
  >/dev/null 2>&1 || true

log "Finding latest Ubuntu 24.04 ARM64 AMI..."
AMI_ID="$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*" \
    "Name=architecture,Values=arm64" \
    "Name=virtualization-type,Values=hvm" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text)"

if [[ "$AMI_ID" == "None" || -z "$AMI_ID" ]]; then
  echo "Could not find Ubuntu 24.04 ARM64 AMI."
  exit 1
fi

USER_DATA_FILE="$(mktemp)"
cat > "$USER_DATA_FILE" <<'EOF_USERDATA'
#!/bin/bash
set -euxo pipefail
exec > >(tee -a /var/log/omnivideo-vip-user-data.log) 2>&1

while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 3; done

apt-get update -y
apt-get install -y ca-certificates curl gnupg git rsync tar unzip python3 python3-venv python3-pip ffmpeg fontconfig fonts-dejavu-core

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

mkdir -p /opt/omnivideo/app /opt/omnivideo/runtime
chown -R ubuntu:ubuntu /opt/omnivideo
EOF_USERDATA

log "Launching EC2 Spot instance..."
INSTANCE_ID="$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$ROOT_VOLUME_SIZE_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --user-data "file://$USER_DATA_FILE" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Project,Value=omnivideo},{Key=Role,Value=vip-voice-render-worker}]" \
  --query 'Instances[0].InstanceId' \
  --output text)"
rm -f "$USER_DATA_FILE"

log "Instance: $INSTANCE_ID"
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
sleep 10
PUBLIC_IP="$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text)"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ServerAliveInterval=20 -i "${KEY_NAME}.pem")
log "Waiting for SSH..."
for _ in {1..60}; do
  if ssh "${SSH_OPTS[@]}" "ubuntu@$PUBLIC_IP" "true" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

log "Waiting for cloud-init..."
ssh "${SSH_OPTS[@]}" "ubuntu@$PUBLIC_IP" "sudo cloud-init status --wait"

TMP_ARCHIVE="$(mktemp -t omnivideo-worker.XXXXXX.tar.gz)"
log "Packing current repo into $TMP_ARCHIVE..."
COPYFILE_DISABLE=1 tar \
  --exclude='.git' \
  --exclude='.next' \
  --exclude='node_modules' \
  --exclude='.vendor' \
  --exclude='piper' \
  --exclude='*.pem' \
  --exclude="$TMP_ARCHIVE" \
  -czf "$TMP_ARCHIVE" .

log "Uploading repo archive..."
scp "${SSH_OPTS[@]}" "$TMP_ARCHIVE" "ubuntu@$PUBLIC_IP:$REMOTE_ARCHIVE"
rm -f "$TMP_ARCHIVE"

log "Installing app and worker service on EC2..."
ssh "${SSH_OPTS[@]}" "ubuntu@$PUBLIC_IP" \
  "WORKER_PORT='$WORKER_PORT' WORKER_TOKEN='$WORKER_TOKEN' PIPER_MODEL_URL='$PIPER_MODEL_URL' PIPER_MODEL_CONFIG_URL='$PIPER_MODEL_CONFIG_URL' REMOTE_APP_DIR='$REMOTE_APP_DIR' REMOTE_ARCHIVE='$REMOTE_ARCHIVE' bash -s" <<'EOF_REMOTE'
set -euxo pipefail

sudo rm -rf "$REMOTE_APP_DIR"
sudo mkdir -p "$REMOTE_APP_DIR"
sudo tar -xzf "$REMOTE_ARCHIVE" -C "$REMOTE_APP_DIR"
sudo chown -R ubuntu:ubuntu /opt/omnivideo
cd "$REMOTE_APP_DIR"

mkdir -p piper
python3 -m venv piper/.venv
./piper/.venv/bin/pip install --upgrade pip
./piper/.venv/bin/pip install piper-tts gdown

download_model_file() {
  local url="$1"
  local output="$2"
  if [ -z "$url" ]; then
    return 0
  fi
  if [[ "$url" == *"drive.google.com"* ]]; then
    local file_id=""
    if [[ "$url" =~ /file/d/([^/]+) ]]; then
      file_id="${BASH_REMATCH[1]}"
    elif [[ "$url" =~ [\?\&]id=([^&]+) ]]; then
      file_id="${BASH_REMATCH[1]}"
    fi
    if [ -z "$file_id" ]; then
      echo "Could not parse Google Drive file id from: $url"
      exit 1
    fi
    ./piper/.venv/bin/gdown "https://drive.google.com/uc?id=$file_id" -O "$output"
    return
  fi
  curl -fL "$url" -o "$output"
}

if [ -n "$PIPER_MODEL_URL" ]; then
  download_model_file "$PIPER_MODEL_URL" piper/model.onnx
fi
if [ -n "$PIPER_MODEL_CONFIG_URL" ]; then
  download_model_file "$PIPER_MODEL_CONFIG_URL" piper/model.onnx.json
fi

if [ ! -f piper/model.onnx ] || [ ! -f piper/model.onnx.json ]; then
  echo "INFO: piper/model.onnx and piper/model.onnx.json are not present on the worker."
  echo "EC2 render-only mode can still work, but EC2 voice + render requires both Piper files."
else
  echo "Piper model and config are ready for EC2 voice + render."
fi

cat > .env.production.local <<ENV
OMNIVIDEO_REMOTE_VIP_TOKEN=$WORKER_TOKEN
OMNIVIDEO_FFMPEG_PATH=/usr/bin/ffmpeg
OMNIVIDEO_VIP_RENDER_CHUNKS=4
PATH=$REMOTE_APP_DIR/piper/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV

npm install
npm run build

sudo tee /etc/systemd/system/omnivideo-vip-worker.service >/dev/null <<SERVICE
[Unit]
Description=OmniVideo remote VIP voice/render worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=$REMOTE_APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$WORKER_PORT
Environment=OMNIVIDEO_REMOTE_VIP_TOKEN=$WORKER_TOKEN
Environment=OMNIVIDEO_FFMPEG_PATH=/usr/bin/ffmpeg
Environment=OMNIVIDEO_VIP_RENDER_CHUNKS=4
Environment=PATH=$REMOTE_APP_DIR/piper/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

sudo systemctl daemon-reload
sudo systemctl enable omnivideo-vip-worker
sudo systemctl restart omnivideo-vip-worker
EOF_REMOTE

log "Waiting for worker HTTP health..."
for _ in {1..60}; do
  if curl -fsS "http://$PUBLIC_IP:$WORKER_PORT/api/audio/video-vip-voice-render" >/dev/null 2>&1; then
    break
  fi
  sleep 5
done

cat <<EOF_DONE

DONE
Instance ID: $INSTANCE_ID
Public IP: $PUBLIC_IP
Worker URL: http://$PUBLIC_IP:$WORKER_PORT
Worker token: $WORKER_TOKEN

Set these in your local OmniVideo app before using the remote seed:
export OMNIVIDEO_REMOTE_VIP_WORKER_URL="http://$PUBLIC_IP:$WORKER_PORT"
export OMNIVIDEO_REMOTE_VIP_TOKEN="$WORKER_TOKEN"

Piper model files are required for EC2 voice + render.
If you launched without PIPER_MODEL_URL and PIPER_MODEL_CONFIG_URL, only EC2 render-only mode can work until you upload both files:
scp -i ${KEY_NAME}.pem model.onnx ubuntu@$PUBLIC_IP:$REMOTE_APP_DIR/piper/model.onnx
scp -i ${KEY_NAME}.pem model.onnx.json ubuntu@$PUBLIC_IP:$REMOTE_APP_DIR/piper/model.onnx.json
ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP 'sudo systemctl restart omnivideo-vip-worker'

Useful checks:
ssh -i ${KEY_NAME}.pem ubuntu@$PUBLIC_IP
sudo tail -n 200 /var/log/omnivideo-vip-user-data.log
sudo journalctl -u omnivideo-vip-worker -f
curl -H "Authorization: Bearer $WORKER_TOKEN" http://$PUBLIC_IP:$WORKER_PORT/api/audio/video-vip-voice-render
EOF_DONE
