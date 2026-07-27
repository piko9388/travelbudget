# 소재 국내 출장비 관리 v9.1

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
| `routes.py` | API 18개 (관리자 행위는 X-Admin-PW 서버 검증, `core.locked` 경계) |
| `templates/index.html` | 화이트+네이비 테마, Pretendard |
| `static/app.js` | 전 화면 (대시보드/계획/실적/내역/이관·처리/예산/데이터) |
| `data_json/data.json` | 정본 (백업: `data_json/backup/`) — 운영은 **`TB_DATA_DIR`** 로 앱 밖 지정 권장 |

## 핵심 규칙


- 상태: 계획 등록(잠정) → 확정 예정(예산 선확보) → 실적 입력·인폼 → 소재 이관 → 처리 완료 (+취소)
- **가용 잔여 = 총예산 − 처리완료 − 처리중 − 확정예정**. 잠정 계획은 참고(미반영)
- 출장자별 개별 처리(이관/완료/**보류**) 지원 — 일괄 처리 시 보류는 유지됨
- 출장 1건 = 그룹. 동행자는 출장자 행 추가, 비용은 개인별 저장, **인폼은 그룹당 1통** (HTML 표 + Outlook)
- 긴급 출장: 계획비 0 등록 허용, 실적 시 비고 필수
- 관리자(2071478/2071478): 소재 이관·처리 완료·예산·백업 복원 — 서버측 검증
- 감액 리비전은 금액 자동 음수 처리
- 내보내기: **센터 제출 Excel**(맑은 고딕/Trebuchet MS 서식) · **센터 양식 CSV 27필드**(최초 엑셀표 순서)
  · **내부관리 CSV 31필드**(+상태·개인처리상태·SAP전표·리드타임) · **예산 리비전 CSV 8필드**

## 입력 사용성 (v9.1)

- 금액칸 **천단위 자동 구분** — 0 개수 오입력 방지 (저장은 숫자, 화면만 서식)
- **복귀일 < 출발일** 즉시 경고 · 제출 전 그 자리에서 표시
- **엔터 = 제출** (계획·실적 화면, 검색칸 제외) · 좌측 메뉴 **키보드 탭·엔터** 이동
- **연속 클릭 이중 등록 차단** (제출 중 버튼 잠금)
- 등록 직후 **다음 할 일 안내** (확정 / 실적 입력 / 내역 확인)
- 인폼 카드를 닫아도 **인폼 다시 보기** — 실적 화면·출장 내역 어디서나 재발행

## 검증

API 통합 116/116 · 브라우저 E2E 73/73 · 정적 Pages E2E 19/19 (모바일 390px·무인증 공격·XSS 포함)
```
python3 test_api.py        # Flask test client
```
