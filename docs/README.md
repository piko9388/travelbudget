# 국내 출장비 관리 — 정적(GitHub Pages) 버전

`docs/index.html` 하나로 끝나는 **자체 완결 단일 파일**입니다. Flask 서버 없이 브라우저에서
바로 구동되며, 화면·계산·인폼·CSV·상태 흐름은 사내 Flask 버전과 **동일**합니다.

## 접속 주소

GitHub Pages를 켜면:

```
https://piko9388.github.io/travelbudget/
```

### Pages 켜는 법 (1회)

저장소 **Settings → Pages → Build and deployment**
- **Source**: Deploy from a branch
- **Branch**: `claude/business-trip-expense-standardization-5ml1km` · **폴더**: `/docs`
- Save → 1~2분 후 위 주소로 접속

(로컬에서 바로 열어도 동일하게 동작합니다: `docs/index.html` 더블클릭)

## Flask 버전과 다른 점 (정적 호스팅의 한계)

| 항목 | Flask(사내) 버전 | 정적(Pages) 버전 |
|---|---|---|
| 저장 | 서버 `data.json` (공유 원장) | **브라우저 localStorage (브라우저별 개별)** |
| 다중 사용자 | 담당자 제출 → 총괄 중앙 취합 | 각자 자기 브라우저에만 저장 |
| 관리자 잠금 | 서버측 검증(보안 경계) | **UX용**(클라이언트라 우회 가능) |
| 자동 백업 | 파일 30개 | localStorage 스냅샷 30개 |

→ **조회·데모·개인용**으로는 100% 동일하게 동작합니다. 여러 명이 공유하는 실제 원장은
사내 Flask 버전(`servera/travelbudget/`)을 사용하세요.

## 데이터 초기화

시드(예시 8건)로 되돌리려면 브라우저 콘솔에서:

```js
localStorage.removeItem('tb_data'); localStorage.removeItem('tb_backups'); location.reload();
```

## 로직 동기화

계산 엔진(잔여 공식·검증·인폼·CSV)은 Flask `core.py`와 1:1로 포팅되어 있으며,
Python↔JS 출력 패리티(대시보드 수치·CSV·인폼) 및 게이트(권한·인젝션) 테스트로 검증했습니다.
서버 로직을 바꾸면 `docs/index.html`의 인라인 백엔드도 함께 갱신하세요.
