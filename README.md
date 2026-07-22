# 국내 출장비 관리 v8

소재전략 국내 출장비 계획·실적·인폼·정산 관리 (Flask + data.json 단일 파일 저장)

## 사내 서버 반영 (2단계)

1. `servera/travelbudget/` 폴더를 서버의 `servera/` 아래 복사
2. `webmain.py`에 2줄 추가
   ```python
   from servera.travelbudget import travelbudget
   app.register_blueprint(travelbudget)
   ```
   → `material.skhynix.com/travelbudget` 접속. (data_json/은 첫 실행 시 자동 생성·시드)

의존성: Flask 3.x 뿐 (`pip install -r requirements.txt`)

## 구성 (6개 파일)

| 파일 | 역할 |
|---|---|
| `core.py` | 계산 엔진 SSOT — 잔여 공식·검증·인폼 생성·CSV |
| `store.py` | data.json 원자적 저장 + 자동백업 30개 + 감사로그 |
| `routes.py` | API 14개 (관리자 행위는 X-Admin-PW 서버 검증) |
| `templates/index.html` | 화이트+네이비 테마, Pretendard |
| `static/app.js` | 전 화면 (대시보드/계획/실적/내역/이관·처리/예산/데이터) |
| `data_json/data.json` | 정본 (백업: `data_json/backup/`) |

## 핵심 규칙

- **잔여 = 총예산 − 처리완료 − 처리중** (미실시 계획은 참고 표기만, 차감·예측 없음)
- 상태: 계획 등록 → 실적 입력·인폼 → 소재 이관 → 처리 완료 (+취소)
- 출장 1건 = 그룹. 동행자는 출장자 행 추가, 비용은 개인별 저장, **인폼은 그룹당 1통** (HTML 표 + Outlook)
- 긴급 출장: 계획비 0 등록 허용, 실적 시 비고 필수
- 관리자(2071478/2071478): 소재 이관·처리 완료·예산·백업 복원 — 서버측 검증
- 감액 리비전은 금액 자동 음수 처리
- CSV 29필드, 개인별 행 전개, 분기/전체

## 검증

API 통합 42/42 · 브라우저 E2E 25/25 (모바일 390px 포함)
```
python3 test_api.py        # Flask test client
```
