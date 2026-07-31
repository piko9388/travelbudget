# -*- coding: utf-8 -*-
"""배포 확인용 스모크 테스트 — **운영 데이터를 전혀 변경하지 않습니다.**

읽기(GET)만 호출하고, 쓰기 라우트는 '무인증이면 401' 인지만 확인합니다.
(401 은 서버가 요청을 거부한 것이므로 데이터가 바뀌지 않습니다)

사용법 — 서버를 올린 뒤 같은 장비에서:
    python3 smoke_test.py                          # 기본 http://127.0.0.1:5000
    python3 smoke_test.py http://127.0.0.1:8080    # 포트가 다르면 지정

전체 기능 테스트는 test_api.py 이며, 그쪽은 임시 폴더에서만 돕니다.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5000").rstrip("/")
API = BASE + "/travelbudget/api"
P = [0]
F = [0]


def ok(name, cond, got=None):
    if cond:
        P[0] += 1
        print(f"  PASS  {name}")
    else:
        F[0] += 1
        print(f"  FAIL  {name} -> {got!r}")


def req(path, method="GET", body=None, headers=None):
    r = urllib.request.Request(API + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read()
            return resp.status, resp.headers, (json.loads(raw) if raw[:1] in (b"{", b"[") else raw)
    except urllib.error.HTTPError as e:
        return e.code, e.headers, None
    except Exception as e:
        return 0, None, str(e)


print(f"대상: {BASE}  (읽기 전용 — 운영 데이터를 변경하지 않습니다)\n")

print("=== 1. 기동·화면 ===")
st, _, _ = req("/state")
ok("서버 응답 (GET /api/state 200)", st == 200, st)
if st != 200:
    print("\n  서버가 응답하지 않습니다. 기동 상태와 포트를 확인하세요.")
    sys.exit(1)
_, _, state = req("/state")
ok("설정 로드", isinstance(state, dict) and "settings" in state)
ok("[보안] 응답에 admin_pw 미포함", "admin_pw" not in json.dumps(state))
# 팀 수는 조직 개편으로 바뀐다(화면 [시스템 설정]). 숫자를 박지 말고 '비어 있지 않은가'만 본다.
_ccg = state.get("ccg", [])
ok("CCG 목록 로드", len(_ccg) >= 1 and all(t.get("team") and t.get("ccg") for t in _ccg),
   f"{len(_ccg)}팀")
v = state.get("version", {})
print(f"        버전 {v.get('v')} · {v.get('build')}")
d = state.get("dash", {})
print(f"        분기 {state.get('yq')} — 출장 {d.get('nTrips', 0)}건 / 인원 {d.get('nPeople', 0)}명 / "
      f"총예산 {d.get('alloc', 0):,}원 / 가용 {d.get('avail', 0):,}원")

print("\n=== 2. 계산식 정합 ===")
ok("가용 = 총예산 − 처리완료 − 처리중 − 확정예정",
   d.get("avail") == d.get("alloc", 0) - d.get("done", 0) - d.get("wip", 0) - d.get("commit", 0),
   {k: d.get(k) for k in ("alloc", "done", "wip", "commit", "avail")})
ok("CCG 합계가 실제 출장 건수와 일치(중복 없음)",
   d.get("nTrips") == d.get("nPlan", 0) + d.get("nConfirm", 0) + d.get("nWip", 0) + d.get("nDone", 0),
   d.get("nTrips"))

print("\n=== 3. 내보내기 (읽기) ===")
for label, path in (("센터 제출 Excel", "/export.xls"), ("센터 양식 CSV", "/export.csv"),
                    ("예산 CSV", "/export_budget.csv"), ("센터 리포트", "/report")):
    code, hdr, _ = req(path)
    cd = (hdr or {}).get("Content-Disposition", "") if hdr else ""
    ok(f"{label} 200", code == 200, code)
    if cd:
        ok(f"{label} 헤더 인코딩 안전", all(ord(ch) < 256 for ch in cd))

print("\n=== 4. 권한 경계 (무인증 = 거부, 데이터 변경 없음) ===")
for label, path, method, body in (
        ("예산 리비전", "/budget", "POST", {"yq": "2000-1Q", "rev_type": "증액", "amt": 1}),
        ("안내 문구", "/notice", "POST", {"notice": "smoke"}),
        ("백업 복원", "/backups/none.json/restore", "POST", None)):
    code, _, _ = req(path, method, body)
    ok(f"무인증 {label} 차단(401)", code == 401, code)

print("\n=== 5. 잘못된 입력이 서버를 죽이지 않는가 ===")
for label, path in (("분기 형식 오류", "/state?yq=abc-Q"),
                    ("감사로그 개수 오류", "/audit?n=abc"),
                    ("없는 출장 조회", "/groups/NOPE/mail")):
    code, _, _ = req(path)
    ok(f"{label} → 500 아님", code < 500, code)

print(f"\n{'=' * 52}\n  스모크 테스트  {P[0]} passed / {F[0]} failed")
print("  (운영 데이터는 변경되지 않았습니다)")
print("=" * 52)
sys.exit(1 if F[0] else 0)
