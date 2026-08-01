#!/bin/bash
# 맥·아이패드용 테스트 패키지 만들기
#   ./tools/build_mac_pkg.sh [출력폴더]
# 결과: travelbudget_mac_vX.zip (더블클릭 실행) · travelbudget_ipad_vX.html (파이썬 불필요)
set -e
cd "$(dirname "$0")/.."
OUT="${1:-dist}"
VER="$(python3 -c "import re;print(re.search(r'APP_VERSION = \"([^\"]+)\"',open('servera/travelbudget/core.py',encoding='utf-8').read()).group(1))")"
P="$OUT/travelbudget_mac_$VER"
echo "== $VER 패키지 =="
rm -rf "$P"; mkdir -p "$P/servera" "$P/vendor" "$P/tools"

cp -r servera/travelbudget "$P/servera/"; cp servera/__init__.py "$P/servera/"
rm -rf "$P/servera/travelbudget/__pycache__" "$P/servera/travelbudget/data_json"
for f in webmain.py requirements.txt smoke_test.py check_data.py README.md DEPLOY.md \
         UPGRADE.md CHANGELOG_v10.md DATA_SCHEMA.md QWEN_PROMPT.md data.example.json test_api.py; do
  cp "$f" "$P/"
done
cp tools/build_docs.py "$P/tools/"
cp packaging/mac/시작하기.command packaging/mac/멈추기.command packaging/mac/읽어보세요.txt "$P/"
chmod +x "$P"/*.command

# 인터넷 없는 맥에서도 설치되도록 Flask 를 동봉 (순수 파이썬 휠 + markupsafe 는 버전별)
echo "-- Flask 동봉"
pip download flask -d "$P/vendor" --only-binary :all: --python-version 3.9 \
  --platform macosx_11_0_arm64 -q
for pv in 3.9 3.10 3.11 3.12 3.13; do
  for plat in macosx_11_0_arm64 macosx_10_9_x86_64; do
    pip download markupsafe -d "$P/vendor" --only-binary :all: \
      --python-version "$pv" --platform "$plat" -q 2>/dev/null || true
  done
done
pip download markupsafe -d "$P/vendor" --no-binary :all: -q 2>/dev/null || true

# 아이패드용 — 정적판 한 파일 (파이썬 없이 사파리에서 열림)
python3 tools/build_docs.py >/dev/null
cp docs/index.html "$P/travelbudget_ipad.html"
cp docs/index.html "$OUT/travelbudget_ipad_$VER.html"

find "$P" -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
( cd "$OUT" && rm -f "travelbudget_mac_$VER.zip" && zip -qr "travelbudget_mac_$VER.zip" "travelbudget_mac_$VER" )
echo "완료: $OUT/travelbudget_mac_$VER.zip · $OUT/travelbudget_ipad_$VER.html"
