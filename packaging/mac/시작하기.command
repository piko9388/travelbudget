#!/bin/bash
# 소재 국내 출장비 관리 — 맥에서 띄우기 (더블클릭)
# 처음 한 번만 준비 과정이 있고, 그다음부터는 바로 열립니다.

cd "$(dirname "$0")" || exit 1
clear
echo "============================================================"
echo "   소재 국내 출장비 관리 — 맥에서 실행"
echo "============================================================"
echo

# ── 1) 파이썬 확인 ──────────────────────────────────────────
PY=""
for c in python3 /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info>=(3,8) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
if [ -z "$PY" ]; then
  echo "  ✗ 파이썬 3.8 이상을 찾지 못했습니다."
  echo
  echo "  맥에 파이썬을 설치하세요 — 터미널에 아래 한 줄을 붙여넣고 엔터:"
  echo
  echo "      xcode-select --install"
  echo
  echo "  창이 뜨면 [설치]를 누르고, 끝나면 이 파일을 다시 더블클릭하세요."
  echo
  read -r -p "  엔터를 누르면 닫힙니다..." _
  exit 1
fi
echo "  ✓ 파이썬  $("$PY" -V 2>&1)"

# ── 2) 처음 한 번만: 전용 폴더에 Flask 설치 ─────────────────
# 맥에 원래 있던 파이썬을 건드리지 않습니다. .venv 폴더 안에만 넣습니다.
if [ ! -x ".venv/bin/python" ]; then
  echo "  · 처음 실행이라 준비 중입니다 (1~2분, 한 번만)…"
  "$PY" -m venv .venv >/dev/null 2>&1 || {
    echo "  ✗ 준비 폴더(.venv)를 만들지 못했습니다."
    echo "    다운로드 폴더 말고 '서류' 폴더 등으로 옮긴 뒤 다시 시도해 보세요."
    read -r -p "  엔터를 누르면 닫힙니다..." _; exit 1; }
fi
VPY=".venv/bin/python"

if ! "$VPY" -c "import flask" >/dev/null 2>&1; then
  # 같이 들어 있는 파일로 먼저 설치 — 인터넷이 없어도 됩니다
  "$VPY" -m pip install --quiet --no-index --find-links vendor Flask >/dev/null 2>&1 \
    || "$VPY" -m pip install --quiet Flask >/dev/null 2>&1
fi
if ! "$VPY" -c "import flask" >/dev/null 2>&1; then
  echo "  ✗ Flask 설치에 실패했습니다."
  echo "    인터넷에 연결한 뒤 다시 더블클릭하거나, 아래를 터미널에 붙여넣으세요:"
  echo "        cd \"$(pwd)\" && .venv/bin/python -m pip install Flask"
  read -r -p "  엔터를 누르면 닫힙니다..." _; exit 1
fi
echo "  ✓ Flask   $("$VPY" -c 'import flask;print(flask.__version__)' 2>/dev/null)"

# ── 3) 데이터 위치 — 앱 폴더 밖(홈)에 둡니다 ────────────────
# 이 폴더를 지우거나 새 버전을 받아도 입력한 내용이 남습니다.
export TB_DATA_DIR="$HOME/TravelBudget_데이터"
mkdir -p "$TB_DATA_DIR"
echo "  ✓ 데이터  $TB_DATA_DIR"

# ── 4) 빈 포트 찾기 ────────────────────────────────────────
# macOS 12 이상은 5000번을 'AirPlay 수신 모드'가 쓰고 있어서 피합니다.
PORT="$("$VPY" - <<'PYEOF'
import socket
for p in range(5050, 5090):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); print(p); break
    except OSError:
        continue
    finally:
        s.close()
else:
    print(0)
PYEOF
)"
if [ "$PORT" = "0" ] || [ -z "$PORT" ]; then
  echo "  ✗ 쓸 수 있는 포트를 찾지 못했습니다. 맥을 다시 켠 뒤 시도해 보세요."
  read -r -p "  엔터를 누르면 닫힙니다..." _; exit 1
fi
export TB_PORT="$PORT"
URL="http://127.0.0.1:$PORT/travelbudget/"

echo "  ✓ 주소    $URL"
echo
echo "------------------------------------------------------------"
echo "  브라우저가 곧 열립니다."
echo "  끝낼 때는  이 창에서  Control + C  를 누르거나 창을 닫으세요."
echo "------------------------------------------------------------"
echo

# 서버가 응답하면 브라우저를 연다 (먼저 열면 '연결할 수 없음'이 뜬다)
( for _ in $(seq 1 40); do
    if curl -s -o /dev/null "$URL" 2>/dev/null; then open "$URL" 2>/dev/null; exit 0; fi
    sleep 0.5
  done ) &

exec "$VPY" webmain.py
