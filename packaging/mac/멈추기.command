#!/bin/bash
# 실행 중인 출장비 관리 서버를 멈춥니다 (창을 닫아도 남아 있을 때만 쓰세요)
cd "$(dirname "$0")" || exit 1
N=$(pgrep -f "webmain.py" | wc -l | tr -d ' ')
if [ "$N" = "0" ]; then
  echo "실행 중인 서버가 없습니다."
else
  pkill -f "webmain.py"
  echo "서버 $N 개를 멈췄습니다."
fi
echo
read -r -p "엔터를 누르면 닫힙니다..." _
