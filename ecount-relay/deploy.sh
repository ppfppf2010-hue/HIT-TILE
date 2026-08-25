#!/usr/bin/env bash
# 히트타일 이카운트 릴레이 서버 배포 스크립트
# VPS(우분투/데비안 계열)에서 root(또는 sudo 가능한 사용자)로 이 파일을 실행하세요:
#   bash deploy_ecount_relay.sh
set -e

echo "== 1) Node.js 설치 확인 =="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js가 없어서 설치합니다 (Node 20.x, Ubuntu/Debian 기준)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "Node.js 이미 설치됨: $(node -v)"
fi

echo
echo "== 2) 저장소 내려받기 =="
INSTALL_DIR="$HOME/hittile-ecount-relay"
if [ -d "$INSTALL_DIR" ]; then
  echo "$INSTALL_DIR 이미 있음 -> git pull로 갱신"
  cd "$INSTALL_DIR" && git pull
else
  git clone --depth 1 https://github.com/ppfppf2010-hue/HIT-TILE.git "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi
cd "$INSTALL_DIR/ecount-relay"

echo
echo "== 3) 패키지 설치 =="
npm install

echo
echo "== 4) 이카운트 연동 정보 입력 =="
echo "(이 값들은 이 서버의 .env 파일에만 저장되고, 어디로도 전송되지 않습니다)"
read -p "이카운트 회사코드(ECOUNT_COM_CODE): " COM_CODE
read -p "이카운트 로그인ID(ECOUNT_USER_ID): " USER_ID
read -p "이카운트 API인증키(ECOUNT_API_CERT_KEY): " CERT_KEY
read -p "이카운트 도메인 [sboapi=테스트키 / oapi=정식키] (기본 sboapi): " DOMAIN
DOMAIN=${DOMAIN:-sboapi}
RELAY_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")

cat > .env <<EOF
ECOUNT_COM_CODE=$COM_CODE
ECOUNT_USER_ID=$USER_ID
ECOUNT_API_CERT_KEY=$CERT_KEY
ECOUNT_DOMAIN=$DOMAIN
RELAY_SECRET=$RELAY_SECRET
PORT=3000
EOF
chmod 600 .env
echo ".env 생성 완료"

echo
echo "== 5) pm2로 상시 실행 등록 =="
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi
pm2 delete ecount-relay >/dev/null 2>&1 || true
pm2 start server.js --name ecount-relay
pm2 save
STARTUP_CMD=$(pm2 startup 2>&1 | grep 'sudo env' || true)
if [ -n "$STARTUP_CMD" ]; then
  echo "재부팅 시 자동시작을 위해 아래 명령을 그대로 한 번 실행하세요:"
  echo "$STARTUP_CMD"
  eval "$STARTUP_CMD" || true
fi

echo
echo "== 6) 헬스체크 =="
sleep 1
curl -s http://localhost:3000/health -H "X-Relay-Secret: $RELAY_SECRET" && echo || echo "(로컬 헬스체크 실패 - 로그를 확인하세요: pm2 logs ecount-relay)"

echo
echo "================================================================"
echo "배포 완료. 아래 두 가지를 확인/전달해주세요:"
echo "1) 방화벽에서 3000번 포트를 열거나(또는 nginx로 80/443 리버스프록시 설정) 외부에서 접속 가능하게 하기"
echo "2) 이 서버의 고정 IP를 이카운트 [Self-Customizing > API인증키발급 > IP등록]에 등록"
echo
echo "그 다음 Claude에게 아래 두 값만 알려주시면 GAS 쪽 연결까지 마무리합니다:"
echo "  - 이 서버에 외부에서 접속할 URL (예: http://<서버IP>:3000 또는 https://relay.내도메인.com)"
echo "  - RELAY_SECRET: $RELAY_SECRET"
echo "================================================================"
