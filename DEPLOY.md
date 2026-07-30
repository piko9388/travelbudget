# 사내 Flask 서버 업로드 방법 (v10.0)

## 0. 준비물

- 패키지 `travelbudget_flask_v10.0.zip` (파일명 전부 영문 — 사내 압축 해제 문제 없음)
- 사내 서버에 Python 3.8+ 와 Flask 3.x

```
pip install -r requirements.txt      # Flask 뿐입니다
```

---

## 1. 폴더 복사

압축을 풀면 이 구조입니다.

```
travelbudget_flask_v10.0/
└─ servera/
   └─ travelbudget/          ← 이 폴더 하나만 서버로 옮기면 됩니다
      ├─ __init__.py
      ├─ core.py             계산 엔진 (잔여 공식·검증·인폼·CSV)
      ├─ store.py            data.json 저장 + 자동백업 30개 + 감사로그
      ├─ routes.py           API 24개
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

좌측 하단에 **v10.0 · 2026-07-27** 이 보이면 이 버전이 올라간 것입니다.
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

## 8. HTML/화면만 바꿔 올릴 때 (데이터 그대로)

v10.0 변경은 **화면(HTML·JS)과 계산 표시**만이라 `data.json` 을 손대지 않습니다.
스키마도 그대로여서 기존 원장을 그대로 쓰면 됩니다.

바꿀 파일 — `servera/travelbudget/` 안 5개:

| 파일 | 이유 |
|---|---|
| `templates/index.html` | 글꼴·팔레트·막대 CSS·일괄 등록 메뉴 |
| `static/app.js` | 대시보드 도식화 · 인폼 드래그 · 엑셀 일괄 등록 · 안내 요약 |
| `templates/traveler_guide.html` | 안내 4단계(드래그 방식) |
| `core.py` | 비목 집계 · 구성비 분모 · 엑셀 양식 생성 함수 · 버전 표기 |
| `routes.py` | 양식 내려받기 라우트 1개 · 인폼 재조회 |

`store.py` 는 바뀌지 않았습니다 — **저장 로직·스키마 무변경**.

폴더를 통째로 덮어쓰고 재기동하면 되고, `TB_DATA_DIR` 을 앱 밖에 두셨다면 데이터는 그대로 유지됩니다.
기본 위치(`data_json/`)를 쓰신다면 **덮어쓰기 전에 그 폴더를 백업**하세요.

되돌리려면 이전 버전 폴더로 교체 후 재기동 — 데이터는 영향받지 않습니다.

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
