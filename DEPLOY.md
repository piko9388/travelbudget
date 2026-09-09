# 사내 Flask 서버 업로드 방법 (v10.28)

## 0. 준비물

- 패키지 `travelbudget_flask_v10.28.zip` (파일명 전부 영문 — 사내 압축 해제 문제 없음)

> **이미 데이터가 쌓인 서버에 올리는 경우 → [UPGRADE.md](UPGRADE.md) 를 보세요.**
> 클릭 순서까지 적은 초보자용 안내입니다(백업 → 파일 5개 교체 → 숫자 대조 → 되돌리기).
> 이 문서 8장은 같은 내용의 요약본입니다. 어느 쪽이든 `python3 check_data.py` 로
> 데이터 위치를 먼저 확인해야 절차가 정해집니다.
- 사내 서버에 Python 3.8+ 와 Flask 3.x

```
pip install -r requirements.txt      # Flask 뿐입니다
```

---

## 1. 폴더 복사

압축을 풀면 이 구조입니다.

```
travelbudget_flask_v10.28/
└─ servera/
   └─ travelbudget/          ← 이 폴더 하나만 서버로 옮기면 됩니다
      ├─ __init__.py
      ├─ core.py             계산 엔진 (잔여 공식·검증·인폼·CSV)
      ├─ store.py            data.json 저장 + 자동백업 30개 + 감사로그
      ├─ routes.py           API 26개 + 화면 3개
      ├─ templates/index.html
      └─ static/app.js
```

`servera/travelbudget/` 를 사내 서버의 **`servera/` 아래**에 그대로 복사합니다.

```
사내서버/
└─ servera/
   ├─ (기존 다른 모듈들…)
   └─ travelbudget/          ← 여기에 붙여넣기
```

---

## 2. `webmain.py` 에 2줄 추가

```python
from servera.travelbudget import travelbudget
app.register_blueprint(travelbudget)
```

이미 다른 블루프린트가 있다면 그 옆에 나란히 두면 됩니다. **기존 코드는 건드리지 않습니다.**

---

## 3. 프로세스는 1개만 (중요)

`data.json` 파일 하나가 정본이라 **여러 프로세스가 동시에 쓰면 서로의 저장을 덮어씁니다.**
프로세스 1개 + 스레드 방식으로만 올리세요. (월 20건 규모라 성능 문제는 없습니다)

- 개발/단독 실행: `python3 webmain.py` — 이미 `processes=1` 로 고정되어 있습니다
- gunicorn 을 쓴다면: `gunicorn -w 1 --threads 4 webmain:app`  ← **`-w 1` 필수**
- uWSGI 라면: `--processes 1 --threads 4`
- IIS/waitress: `waitress-serve --threads=4 webmain:app` (waitress 는 단일 프로세스)

다중 worker(`-w 2` 이상)로 올리면 저장 충돌이 납니다. SQLite 전환은 이번 범위가 아닙니다.

---

## 4. 데이터 저장 위치 지정 (권장)

기본값은 `servera/travelbudget/data_json/` 이라 **재배포 시 덮어쓰면 데이터가 날아갑니다.**
앱 폴더 **밖**을 환경변수로 지정하세요.

```bash
export TB_DATA_DIR=/var/lib/travelbudget
```

Windows 서비스라면 서비스 환경변수에 `TB_DATA_DIR` 을 등록합니다.
폴더는 첫 실행 시 자동 생성되고 시드 데이터가 들어갑니다.

---

## 5. 재기동 → 접속

```
material.skhynix.com/travelbudget
```

좌측 하단에 **v10.28 · 2026-08-06** 이 보이면 이 버전이 올라간 것입니다.
(버전이 안 바뀌었으면 브라우저 캐시 — `Ctrl+F5`)

---

## 6. 올린 뒤 3분 점검

| 확인 | 방법 | 정상 |
|---|---|---|
| 기동 | `/travelbudget` 접속 | 대시보드 표시 |
| 저장 | 출장 계획 1건 등록 | 목록에 뜸 |
| 데이터 위치 | `$TB_DATA_DIR/data.json` | 파일 생성됨 |
| 백업 | `$TB_DATA_DIR/backup/` | 파일 쌓임 |
| 예산 담당자 모드 | 예산 관리 → 2071478 | 화면 열림 |
| 내보내기 | 데이터 관리 → 센터 제출 (Excel) | 파일 받아짐 |
| 변환 프롬프트 | 데이터 관리 → 변환 프롬프트 복사 | 복사됨 토스트 |
| 출장자 안내 | `/travelbudget/guide` 접속 | 4단계 안내 표시 |
| 엑셀 일괄 등록 | 좌측 메뉴 → 예시 넣어보기 | 2건 미리보기 |
| 엑셀 양식 | 일괄 등록 → 엑셀 양식 내려받기 | 파일 받아짐 |
| 화면 배치 | 대시보드 | 좌측 메뉴가 **본문 왼쪽**에 붙어 있음 |
| 비목 구성 | 대시보드 하단 | 교통·숙박·식대·기타 막대 표시 |
| 빈 원장 확인 | 첫 접속 시 대시보드 | 예시 출장이 **없어야** 정상 |

올린 서버가 정상인지 확인하려면 — **운영 데이터를 전혀 바꾸지 않는** 스모크 테스트를 쓰세요.

```bash
python3 smoke_test.py                        # 기본 http://127.0.0.1:5000
python3 smoke_test.py http://127.0.0.1:8080  # 포트가 다르면 지정
```

19개 항목(기동·계산식·내보내기·권한 경계·예외 입력)을 **읽기만** 해서 확인합니다.

> ⚠ `test_api.py` 는 전체 기능 테스트(309개)이며 **운영 서버에서 돌릴 필요가 없습니다.**
> 돌리더라도 실행 즉시 임시 폴더로 격리되어 운영 원장을 읽거나 바꾸지 않지만,
> 배포 확인 용도로는 위 `smoke_test.py` 를 쓰세요.

---

## 7. 기존 데이터 이관

변환 프롬프트는 **화면 → 데이터 관리 → 기존 데이터 변환** 에서 복사하거나 `QWEN_PROMPT.md` 를 씁니다.
`DATA_SCHEMA.md` 형식으로 만든 `data.json` 을 `$TB_DATA_DIR/data.json` 에 덮어쓰고 재기동합니다.
덮어쓰기 **전에 기존 파일을 백업**하세요. (변환 프롬프트는 `QWEN_PROMPT.md`)

```bash
cp $TB_DATA_DIR/data.json $TB_DATA_DIR/data.json.bak
cp 새로만든_data.json $TB_DATA_DIR/data.json
```

넣은 뒤 화면에서 **총예산·처리완료·가용 잔여** 숫자가 기존 엑셀과 맞는지 먼저 확인하세요.
틀리면 되돌립니다.

```bash
cp $TB_DATA_DIR/data.json.bak $TB_DATA_DIR/data.json
```

---

## 8. 기존 데이터를 그대로 두고 올리기 (업그레이드)

### 8-0. 먼저 이것부터 — 데이터가 어디 있는지 확인

절차가 여기서 갈립니다. 서버에서 한 번 돌리세요. **읽기만 하고 아무것도 바꾸지 않습니다.**

```bash
python3 check_data.py
```

출력이 둘 중 하나입니다.

| 출력 | 뜻 | 가는 곳 |
|---|---|---|
| ✅ 데이터가 앱 폴더 **밖** | `TB_DATA_DIR` 이 잡혀 있음 | 8-2 (폴더 통째로 교체 가능) |
| ⚠ 데이터가 앱 폴더 **안** | 기본 위치 `data_json/` 사용 | 8-1 (파일만 교체) |

스크립트가 지금 원장의 **출장 건수·배정 합계·실적 합계**도 찍어 줍니다.
그 숫자를 적어 두고, 올린 뒤 화면에서 같은지 확인하세요. **다르면 즉시 되돌립니다.**

### 8-1. 데이터가 앱 폴더 안에 있는 경우 — 파일 5개만 교체

> ⚠ `servera/travelbudget/` 폴더를 **삭제하고** 붙여넣지 마세요.
> `data_json/` 이 그 안에 있어서 원장과 자동 백업 30개가 함께 사라집니다.
> Windows 탐색기의 "덮어쓰기"는 병합이라 안전하지만, "폴더 삭제 후 붙여넣기"는 데이터를 지웁니다.

바꿀 파일은 이 5개뿐입니다. 나머지는 손대지 않습니다.

```
servera/travelbudget/core.py
servera/travelbudget/routes.py
servera/travelbudget/static/app.js
servera/travelbudget/templates/index.html
servera/travelbudget/templates/traveler_guide.html
```

```bash
# 1. 원장 백업 (앱 폴더 밖으로)
cp -r servera/travelbudget/data_json ~/tb_backup_$(date +%Y%m%d)

# 2. 5개 파일만 덮어쓰기
cp travelbudget_flask_v10.28/servera/travelbudget/core.py                       servera/travelbudget/
cp travelbudget_flask_v10.28/servera/travelbudget/routes.py                     servera/travelbudget/
cp travelbudget_flask_v10.28/servera/travelbudget/static/app.js                 servera/travelbudget/static/
cp travelbudget_flask_v10.28/servera/travelbudget/templates/index.html          servera/travelbudget/templates/
cp travelbudget_flask_v10.28/servera/travelbudget/templates/traveler_guide.html servera/travelbudget/templates/

# 3. 재기동 후 확인
python3 check_data.py       # 숫자가 그대로인지
python3 smoke_test.py       # 19개 항목 (읽기만)
```

`store.py` 의 **저장 로직**은 v9.4 이후 한 줄도 바뀌지 않았습니다 — 건드릴 필요가 없습니다.
(v10.28 에서 `store.py` 의 신규 설치용 기본값만 바뀌었고, 이미 원장이 있는 서버에서는 쓰이지 않습니다)

### 8-2. 데이터가 앱 폴더 밖에 있는 경우 — 폴더 통째로 교체

```bash
cp -r $TB_DATA_DIR ~/tb_backup_$(date +%Y%m%d)      # 1. 원장 백업
rm -rf servera/travelbudget                          # 2. 앱 폴더 교체
cp -r travelbudget_flask_v10.28/servera/travelbudget servera/
# 3. 재기동 → check_data.py · smoke_test.py
```

### 8-3. 다음 배포부터 편해지는 준비 (한 번만)

기본 위치를 쓰고 있다면, 이번에 데이터를 앱 밖으로 옮겨 두면 다음부터는 8-2 로 끝납니다.

```bash
mkdir -p /var/lib/travelbudget
cp -r servera/travelbudget/data_json/* /var/lib/travelbudget/
export TB_DATA_DIR=/var/lib/travelbudget      # 서비스 환경변수에 등록
# 재기동 → python3 check_data.py 로 새 위치가 잡혔는지 확인
```

Windows 서비스면 서비스 속성의 환경변수에 `TB_DATA_DIR` 을 추가합니다.

### 8-4. 데이터가 안전한 근거

| 확인 | 결과 |
|---|---|
| `data.json` 스키마 버전 | `2.0` — v9.4 이후 무변경 |
| `data.json` 의 출장·예산 필드 | v9.4와 **완전히 동일** (추가 0 · 삭제 0) |
| `store.py` (저장·백업 로직) | v9.4 이후 무변경 |
| 배포 패키지 안의 `data_json/` | **없음** — 압축을 풀어도 원장을 덮지 않음 |
| 되돌리기 | 출장·예산 필드가 그대로라 이전 버전이 그대로 읽음 |

한 가지만 예외입니다. **[시스템 설정]에서 CCG 목록을 고치면** `settings.ccg_teams` 칸이 새로 생깁니다.
출장·예산 데이터가 아니라 설정 한 칸이고, 고치기 전에는 생기지 않습니다.
이전 버전으로 되돌리면 이 칸을 **무시하고** 코드에 박힌 CCG 목록을 쓰므로 오류는 나지 않습니다 —
되돌린 동안만 고친 목록이 반영되지 않을 뿐, 원장 데이터는 그대로입니다.

## 8-5. 출장자용 안내서의 화면 캡처 갱신

`출장자용 안내`(`/travelbudget/guide`)에는 단계별 **실제 화면 캡처**가 파일 안에 들어 있습니다.
외부 이미지 파일을 부르지 않으므로 HTML 하나만 메일로 보내도 그대로 보입니다.

**화면(UI)을 바꾼 뒤에는 캡처를 다시 만드세요.** 낡은 캡처는 없느니만 못합니다.

```bash
pip install pillow                       # 최초 1회
NODE_BIN=node PLAYWRIGHT_PATH=<playwright 경로> python3 tools/build_guide.py
```

- 임시 원장으로 화면을 띄워 캡처하므로 **운영 데이터를 쓰지 않습니다**
- 화면이 안 바뀌었으면 파일도 안 바뀝니다(같은 결과가 나옵니다)
- 안내서가 300KB 를 넘으면 경고합니다 — 메일 첨부가 불편해지는 선입니다

Playwright 가 없는 서버라면 개발 PC 에서 돌린 뒤 `traveler_guide.html` 만 옮기면 됩니다.

---

## 8-6. 맥에서 띄워 보기 (검토·시연용)

사내 서버는 윈도우지만, **맥에서도 그대로 돕니다.** 윈도우 전용 코드나 경로를 쓰지 않습니다.

```bash
cd travelbudget_flask_v10.28
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export TB_DATA_DIR="$HOME/travelbudget_data"   # 원장을 홈 폴더에 (앱 폴더 밖)
export TB_PORT=5050                            # ★ 맥에서는 5000 을 쓰지 마세요
python3 webmain.py
```

브라우저에서 `http://127.0.0.1:5050/travelbudget/` — 멈출 때는 그 터미널에서 **Ctrl + C**.

> ⚠ **macOS 12 이상은 5000번 포트를 AirPlay 수신 모드가 쓰고 있습니다.**
> 그대로 두면 안 뜨거나 엉뚱한 응답이 옵니다. `TB_PORT` 로 다른 번호를 주세요
> (또는 시스템 설정 → 일반 → AirDrop 및 Handoff → **AirPlay 수신 모드** 끄기).

점검도 같은 방식입니다.

```bash
python3 smoke_test.py http://127.0.0.1:5050    # 19개 항목, 읽기만
python3 check_data.py "$TB_DATA_DIR"           # 데이터 위치·건수 확인
```

**글꼴** — 맥에는 맑은 고딕이 없어서 라틴은 **SF Pro**, 한글은 **Apple SD Gothic Neo** 로 떨어집니다.
윈도우 순서(맑은 고딕 우선)는 그대로 두고 그 뒤에 애플 글꼴을 받쳐 뒀으므로
**사내 윈도우 화면은 한 픽셀도 바뀌지 않습니다.**

맥에서 만든 원장을 그대로 서버로 옮겨도 됩니다 — `data.json` 은 UTF-8 텍스트 한 개라
운영체제와 무관합니다.

---

## 9. 되돌리기 (롤백)

- **앱만 되돌리기**: 이전 버전 `travelbudget/` 폴더로 교체 후 재기동. `TB_DATA_DIR` 을 쓰면 데이터는 그대로 유지됩니다.
- **데이터만 되돌리기**: 화면 → 데이터 관리 → 백업 목록에서 복원 (관리자 인증 필요). 자동 백업 30개가 항상 남아 있습니다.

---

## 10. 알아둘 것

- **관리자 계정 2071478 / 2071478 은 화면에 공개**되어 있습니다. 사내망 전용이라 의도된 설정이며,
  금액을 움직이는 행위(소재 이관·처리 완료·예산 리비전·백업 복원·안내 문구)는 **서버에서 검증**합니다.
  사외 공개나 계정 분리가 필요해지면 `routes.py` 의 `_is_admin()` 한 곳만 바꾸면 됩니다.
- 외부 CDN·웹폰트를 전혀 쓰지 않습니다 (사내망 차단 환경 안전).
- 데이터베이스 없음. `data.json` 파일 하나가 정본입니다.
