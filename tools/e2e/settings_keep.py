# -*- coding: utf-8 -*-
"""설정 보존 리허설 — 실행: python3 tools/e2e/settings_keep.py   (저장소 루트에서)

"업그레이드하면 내가 고쳐 둔 안내 문구·메일 수신인·CCG 가 날아가지 않나?" 를
말이 아니라 실제로 확인한다. 옛 버전 서버를 띄워 설정을 고치고, 파일 5개만 갈아끼운 뒤
원장과 설정이 한 글자도 안 바뀌었는지 대조한다.

운영 데이터는 건드리지 않는다 — 임시 폴더에 예시 원장을 복사해서 쓴다.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(os.environ.get("TB_REPO") or Path(__file__).resolve().parents[2])
OLD_REF = os.environ.get("TB_OLD_REF", "35b4d66")     # v9.4 — 설정 화면이 없던 시절
PORT = int(os.environ.get("TB_PORT", "5191"))
B = f"http://127.0.0.1:{PORT}/travelbudget/api"
ADM = {"X-Admin-PW": "2071478"}
FILES5 = ("servera/travelbudget/core.py", "servera/travelbudget/routes.py",
          "servera/travelbudget/static/app.js",
          "servera/travelbudget/templates/index.html",
          "servera/travelbudget/templates/traveler_guide.html")
op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
P = [0]
F = [0]


def ok(name, cond, got=None):
    if cond:
        P[0] += 1
        print(f"  PASS  {name}")
    else:
        F[0] += 1
        print(f"  FAIL  {name} -> {got!r}")


def call(path, method="GET", body=None, hdr=None):
    r = urllib.request.Request(B + path, method=method,
                               data=json.dumps(body).encode() if body is not None else None)
    r.add_header("Content-Type", "application/json")
    for k, v in (hdr or {}).items():
        r.add_header(k, v)
    try:
        with op.open(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def boot(app_dir, data_dir):
    p = subprocess.Popen(
        [sys.executable, "-c",
         f"import sys; sys.path.insert(0, {str(app_dir)!r})\n"
         "from flask import Flask\n"
         "from servera.travelbudget import travelbudget\n"
         "app = Flask(__name__); app.register_blueprint(travelbudget)\n"
         f"app.run(host='127.0.0.1', port={PORT}, threaded=True)"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        env={**os.environ, "TB_DATA_DIR": str(data_dir)})
    for _ in range(50):
        time.sleep(0.4)
        try:
            call("/state")
            return p
        except Exception:
            pass
    p.kill()
    raise SystemExit("서버가 뜨지 않았습니다.")


def md5(p):
    return hashlib.md5(Path(p).read_bytes()).hexdigest()


def put_files(app_dir, src_root):
    t = app_dir / "servera/travelbudget"
    for rel in FILES5:
        src = src_root / rel
        if src.exists():
            dst = t / Path(rel).relative_to("servera/travelbudget")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)


TMP = Path(tempfile.mkdtemp(prefix="tb_setkeep_"))
srv = None
try:
    # ── 준비: 옛 버전 서버 + 예시 원장 ──
    APP = TMP / "app"
    APP.mkdir(parents=True)
    rc = subprocess.run(f"git -C {REPO} archive {OLD_REF} | tar -x -C {APP}",
                        shell=True, capture_output=True)
    if rc.returncode:
        print("git 히스토리를 읽을 수 없어 건너뜁니다 (zip 배포본에서 실행한 경우).")
        sys.exit(0)
    DJ = APP / "servera/travelbudget/data_json"
    DJ.mkdir(parents=True, exist_ok=True)
    shutil.copy2(REPO / "data.example.json", DJ / "data.json")
    put_files(APP, REPO)          # 먼저 지금 버전으로 올려 설정 화면을 쓸 수 있게 한다
    srv = boot(APP, DJ)

    print("\n=== 1. 운영자가 화면에서 설정을 고친다 ===")
    NOTICE = "2026-3Q 소재 예산 소진 — 센터 예산 사용 중입니다"
    SUB = "(센터 검토 시 반려될 수 있음)"
    MAILS = ["junghoon12.lee@sk.com", "eunjeong5.kim@sk.com",
             "Jeewoung.Chun@sk.com", "geonyoung.kim@sk.com"]
    st, cur = call("/settings", hdr=ADM)
    TEAMS = list(cur["settings"]["ccg_teams"]) + [{"team": "신규소재TF", "ccg": "50188888"}]
    # 안내 문구는 대시보드의 [안내 문구 수정](/notice), 수신인·CCG 는 [시스템 설정](/settings)
    st1, _ = call("/notice", "POST", dict(notice=NOTICE, notice_sub=SUB), ADM)
    st2, _ = call("/settings", "POST", dict(mail_recipients=MAILS, ccg_teams=TEAMS), ADM)
    ok("안내 문구 저장", st1 == 200, st1)
    ok("수신인·CCG 저장", st2 == 200, st2)
    st, before = call("/state")
    ok("안내 문구 반영", before["settings"]["notice"] == NOTICE)
    ok("수신인 4명 반영", before["settings"]["mail_recipients"] == MAILS)
    ok("CCG 목록이 data.json 으로 들어옴",
       len(before["settings"].get("ccg_teams") or []) == len(TEAMS))

    snap = {
        "settings": json.dumps(before["settings"], ensure_ascii=False, sort_keys=True),
        "md5": md5(DJ / "data.json"),
        "groups": len(json.loads((DJ / "data.json").read_text(encoding="utf-8"))["groups"]),
        "dash": {k: before["dash"].get(k) for k in ("done", "wip", "commit", "avail")},
        "csv": hashlib.md5(op.open(B + "/export.csv", timeout=20).read()).hexdigest(),
    }
    srv.terminate(); srv.wait(); srv = None

    print("\n=== 2. 옛 버전으로 되돌렸다가 다시 새 버전으로 — 파일 5개만 교체 ===")
    OLD = TMP / "old"
    OLD.mkdir()
    subprocess.run(f"git -C {REPO} archive {OLD_REF} {' '.join(FILES5)} | tar -x -C {OLD}",
                   shell=True, capture_output=True)
    put_files(APP, OLD)           # 옛 버전으로
    put_files(APP, REPO)          # 다시 새 버전으로 (= 실제 업그레이드와 같은 동작)
    srv = boot(APP, DJ)
    st, after = call("/state")
    ok("안내 문구 그대로", after["settings"]["notice"] == NOTICE, after["settings"]["notice"][:40])
    ok("안내 보조 문구 그대로", after["settings"]["notice_sub"] == SUB)
    ok("메일 수신인 그대로", after["settings"]["mail_recipients"] == MAILS,
       after["settings"]["mail_recipients"])
    ok("CCG 목록 그대로 (새로 넣은 팀 포함)",
       [t["ccg"] for t in (after["settings"].get("ccg_teams") or [])]
       == [t["ccg"] for t in TEAMS])
    ok("설정 전체가 한 글자도 안 바뀜",
       json.dumps(after["settings"], ensure_ascii=False, sort_keys=True) == snap["settings"])
    ok("data.json 파일 자체가 그대로 (md5 동일)", md5(DJ / "data.json") == snap["md5"])
    ok("출장 건수 그대로",
       len(json.loads((DJ / "data.json").read_text(encoding="utf-8"))["groups"]) == snap["groups"])
    ok("대시보드 금액 그대로",
       {k: after["dash"].get(k) for k in ("done", "wip", "commit", "avail")} == snap["dash"])
    ok("센터 제출 CSV 그대로",
       hashlib.md5(op.open(B + "/export.csv", timeout=20).read()).hexdigest() == snap["csv"])

    print("\n=== 3. 고쳐 둔 설정이 실제로 쓰이는가 ===")
    gs = json.loads((DJ / "data.json").read_text(encoding="utf-8"))["groups"]
    paid = [g for g in gs
            if sum(int(p.get(k) or 0) for p in (g.get("travelers") or [])
                   for k in ("a_trans", "a_lodg", "a_meal", "a_etc")) > 0]
    if paid:
        st, m = call(f"/groups/{paid[0]['group_id']}/mail")
        ok("인폼 수신인이 고쳐 둔 4명",
           st == 200 and m.get("mail", {}).get("to") == ";".join(MAILS),
           (st, m.get("mail", {}).get("to")))
    st, cfg = call("/settings", hdr=ADM)
    ok("설정 화면 수신인 4명", cfg["settings"]["mail_recipients"] == MAILS)
    ok("CCG 출처가 data.json", cfg["settings"].get("ccg_from_settings") is True)

    print("\n=== 4. 한 번도 안 고친 서버 — 새 기본값이 저절로 들어오지는 않는다 ===")
    srv.terminate(); srv.wait(); srv = None
    APP2 = TMP / "app2"
    APP2.mkdir()
    subprocess.run(f"git -C {REPO} archive {OLD_REF} | tar -x -C {APP2}", shell=True, check=True)
    DJ2 = APP2 / "servera/travelbudget/data_json"
    DJ2.mkdir(parents=True, exist_ok=True)
    raw = json.loads((REPO / "data.example.json").read_text(encoding="utf-8"))
    raw["settings"]["mail_recipients"] = ["junghoon12.lee@sk.com", "eunjeong.kim@sk.com"]
    raw["settings"].pop("ccg_teams", None)
    (DJ2 / "data.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    put_files(APP2, REPO)
    srv = boot(APP2, DJ2)
    st, old = call("/state")
    ok("옛 수신인 2명이 그대로 남는다 (자동으로 안 바뀜)",
       old["settings"]["mail_recipients"] == ["junghoon12.lee@sk.com", "eunjeong.kim@sk.com"],
       old["settings"]["mail_recipients"])
    ok("CCG 는 화면에서 고친 적 없으면 프로그램 기본값을 쓴다",
       "ccg_teams" not in old["settings"])
    st, _ = call("/settings", "POST", dict(mail_recipients=MAILS), ADM)
    st, fixed = call("/state")
    ok("화면에서 한 번 고치면 반영된다", fixed["settings"]["mail_recipients"] == MAILS)
    ok("그때 안내 문구는 건드려지지 않는다",
       fixed["settings"]["notice"] == old["settings"]["notice"])
    ok("그 순간 CCG 목록도 data.json 에 박힌다",
       isinstance(fixed["settings"].get("ccg_teams"), list))
finally:
    if srv:
        srv.terminate()
        srv.wait()
    shutil.rmtree(TMP, ignore_errors=True)

print(f"\n{'='*52}\n  설정 보존 리허설  {P[0]} passed / {F[0]} failed\n{'='*52}")
sys.exit(1 if F[0] else 0)
