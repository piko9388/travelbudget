# -*- coding: utf-8 -*-
"""배포 전 점검 — 데이터가 어디 있는지 찾아서 안전한 교체 절차를 알려준다.

읽기만 한다. 어떤 파일도 만들거나 바꾸지 않는다.

    python3 check_data.py                  # 앱 폴더 기준 자동 탐색
    python3 check_data.py /var/lib/travelbudget   # 위치를 알고 있으면 직접 지정
"""
import json
import os
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
INSIDE = HERE / "servera" / "travelbudget" / "data_json"   # 기본값 — 앱 폴더 안 (위험)
ENVDIR = os.environ.get("TB_DATA_DIR")

BAR = "=" * 60


def look(d):
    """폴더 하나를 조사해 요약을 돌려준다. data.json 이 없으면 None."""
    d = Path(d)
    f = d / "data.json"
    if not f.exists():
        return None
    st = f.stat()
    info = {
        "dir": d, "file": f, "size": st.st_size,
        "mtime": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
        "backups": len(list((d / "backup").glob("*.json"))) if (d / "backup").exists() else 0,
    }
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
    except Exception as e:                     # 깨진 파일도 '있다'고는 알려줘야 한다
        info["error"] = f"{type(e).__name__}: {e}"
        return info
    g = data.get("groups") or []
    b = data.get("budget") or []
    info.update({
        "schema": data.get("schema_version", "(없음)"),
        "groups": len(g),
        "travelers": sum(len(x.get("travelers") or []) for x in g),
        "budget_revs": len(b),
        "alloc": sum(int(float(str(x.get("amt") or 0).replace(",", "") or 0)) for x in b),
        "act": sum(sum(int(float(str(p.get(f"a_{k}") or 0).replace(",", "") or 0))
                       for k in ("trans", "lodg", "meal", "etc"))
                   for x in g for p in (x.get("travelers") or [])),
        "quarters": sorted({x.get("yq") for x in g if x.get("yq")}),
        "audit": len(data.get("audit_log") or []),
        "settings": data.get("settings") or {},
    })
    return info


def settings_view(s):
    """설정 지문 — 업그레이드 전후로 이 블록이 같으면 설정이 안 흐트러진 것."""
    import hashlib
    keys = ("system_name", "notice", "notice_sub", "reference_url",
            "mail_recipients", "ccg_teams", "admin_pw")
    body = json.dumps({k: s.get(k) for k in keys}, ensure_ascii=False, sort_keys=True)
    return hashlib.md5(body.encode("utf-8")).hexdigest()[:12], body


def show(tag, info):
    print(f"\n[{tag}]  {info['dir']}")
    if "error" in info:
        print(f"  [주의] data.json 을 읽을 수 없습니다 — {info['error']}")
        print(f"     크기 {info['size']:,} bytes · 수정 {info['mtime']} · 백업 {info['backups']}개")
        print("     → backup/ 의 최신 파일로 되돌린 뒤 다시 확인하세요.")
        return
    print(f"  스키마      {info['schema']}")
    print(f"  출장        {info['groups']}건 · 출장자 {info['travelers']}명")
    print(f"  예산 리비전  {info['budget_revs']}건 · 배정 합계 {info['alloc']:,}원")
    print(f"  실적 합계    {info['act']:,}원")
    print(f"  분기        {', '.join(info['quarters']) or '(없음)'}")
    print(f"  감사 로그    {info['audit']}건")
    print(f"  파일        {info['size']:,} bytes · 수정 {info['mtime']} · 백업 {info['backups']}개")

    s = info.get("settings") or {}
    fp, _ = settings_view(s)
    mails = list(s.get("mail_recipients") or [])
    teams = s.get("ccg_teams")
    print()
    print("  ── 내가 고쳐 둔 설정 (업그레이드 후 이 블록이 그대로여야 합니다) ──")
    print(f"  설정 지문    {fp}      ← 올린 뒤 다시 실행해서 이 값만 비교하면 됩니다")
    print(f"  시스템 이름  {s.get('system_name') or '(없음)'}")
    print(f"  안내 문구    {(s.get('notice') or '(없음)')[:58]}")
    print(f"  안내 보조    {(s.get('notice_sub') or '(없음)')[:58]}")
    print(f"  참고 주소    {s.get('reference_url') or '(없음)'}")
    print(f"  담당자 암호  {'기본값(2071478)' if s.get('admin_pw') == '2071478' else '바꿔 두셨습니다'}")
    print(f"  인폼 수신인  {len(mails)}명")
    for m in mails:
        print(f"               · {m}")
    if isinstance(teams, list):
        print(f"  CCG 목록     {len(teams)}팀  (화면 [시스템 설정]에서 고쳐 둔 것 — data.json 에 있음)")
        for x in teams:
            print(f"               · {x.get('team','')} {x.get('ccg','')}")
    else:
        print("  CCG 목록     data.json 에 없음 — 프로그램 기본값(core.py)을 씁니다.")
        print("               화면 [시스템 설정]에서 한 번 저장하면 그때부터 data.json 이 이깁니다.")


def main():
    print(BAR)
    print("  배포 전 점검 — 데이터 위치 확인 (읽기만 합니다)")
    print(BAR)

    cands = []
    if len(sys.argv) > 1:
        cands.append(("직접 지정", sys.argv[1]))
    if ENVDIR:
        cands.append(("TB_DATA_DIR 환경변수", ENVDIR))
    cands.append(("앱 폴더 안 (기본값)", INSIDE))

    found = []
    seen = set()
    for tag, d in cands:
        key = str(Path(d).resolve())
        if key in seen:
            continue
        seen.add(key)
        info = look(d)
        if info:
            found.append((tag, info))
            show(tag, info)

    print()
    print(BAR)
    if not found:
        print("  data.json 을 찾지 못했습니다.")
        print(BAR)
        print("""
아직 데이터가 없는 서버이거나, 위치를 직접 지정해야 합니다.

  1) 서버에서 data.json 을 찾으세요
       Linux   : find / -name data.json -path '*travelbudget*' 2>/dev/null
       macOS   : find ~ / -name data.json -path '*travelbudget*' 2>/dev/null
       Windows : dir /s /b C:\\data.json
  2) 찾은 폴더를 인자로 넘겨 다시 실행
       python3 check_data.py <그 폴더>

찾아도 없다면 신규 설치입니다 — 그냥 폴더를 복사하고 올리면 됩니다.
""")
        return 0

    tag, info = found[0]
    inside = Path(info["dir"]).resolve() == INSIDE.resolve()

    # 두 곳에 다 있으면 어느 쪽이 정본인지 헷갈린다 — 앱이 실제로 쓰는 쪽을 못박아 준다
    if len(found) > 1:
        print("  [주의] data.json 이 두 곳에 있습니다. 앱이 쓰는 것은 위쪽 하나뿐입니다.")
        print(f"     정본 (앱이 쓰는 것) : {found[0][1]['dir']}   수정 {found[0][1]['mtime']}")
        for _t, _i in found[1:]:
            print(f"     오래된 사본        : {_i['dir']}   수정 {_i['mtime']}")
        print("     사본을 지우지 말고 그냥 두세요 — 지금 배포와 무관합니다.")
        print("     (수정 시각이 사본 쪽이 더 최근이면 TB_DATA_DIR 설정이 최근에 바뀐 것입니다."
              " 그 경우 어느 쪽이 맞는지 먼저 확인하세요)")
        print(BAR)

    if inside:
        print("  [주의] 데이터가 앱 폴더 **안**에 있습니다 — 폴더를 통째로 지우고 덮으면 날아갑니다.")
        print(BAR)
        print(f"""
데이터 위치: {info['dir']}

■ 절대 하지 말 것
    rm -rf servera/travelbudget            (또는 폴더 삭제 후 붙여넣기)
    → data_json/ 이 같이 지워집니다. 백업 30개도 그 안에 있어서 함께 사라집니다.

■ 안전한 방법 A — 파일 5개만 교체 (권장, 가장 안전)
    v10.29 에서 바뀐 것은 이 5개뿐입니다. 나머지는 손대지 않습니다.

      servera/travelbudget/core.py
      servera/travelbudget/routes.py
      servera/travelbudget/static/app.js
      servera/travelbudget/templates/index.html
      servera/travelbudget/templates/traveler_guide.html

    1. 원장 백업          cp -r {info['dir']} ~/tb_backup_$(date +%Y%m%d)
    2. 위 5개 파일만 덮어쓰기 (data_json/ 은 건드리지 않음)
    3. 서비스 재기동
    4. 좌측 하단에 v10.29 · 2026-08-06 확인

■ 안전한 방법 B — 데이터를 앱 밖으로 옮기고 나서 통째로 교체
    이번에 한 번만 하면 다음 배포부터는 폴더를 마음대로 덮어써도 됩니다.

    1. mkdir -p /var/lib/travelbudget
    2. cp -r {info['dir']}/* /var/lib/travelbudget/
    3. 서비스 환경변수에 TB_DATA_DIR=/var/lib/travelbudget 등록
       (Windows 서비스면 서비스 속성의 환경변수에 추가)
    4. 재기동 → 이 스크립트를 다시 돌려 새 위치가 잡혔는지 확인
    5. 그 다음에 폴더 교체
""")
    else:
        print("  데이터가 앱 폴더 밖에 있습니다 — 폴더를 통째로 덮어써도 안전합니다.")
        print(BAR)
        print(f"""
데이터 위치: {info['dir']}

■ 절차
    1. 원장 백업        cp -r {info['dir']} ~/tb_backup_$(date +%Y%m%d)
    2. servera/travelbudget/ 폴더를 v10.29 것으로 교체
    3. 재기동 → 좌측 하단 v10.29 · 2026-08-06 확인
""")

    print(f"""■ 올린 뒤 이 숫자가 그대로인지 확인하세요 (바뀌면 즉시 되돌릴 것)
    출장 {info.get('groups', '?')}건 · 배정 합계 {info.get('alloc', 0):,}원 · 실적 합계 {info.get('act', 0):,}원

■ 되돌리기
    앱만: 이전 버전 파일 5개로 교체 후 재기동. 데이터는 영향 없습니다.
    v10.29 는 출장·예산 데이터에 새 필드를 쓰지 않으므로, 되돌려도 이전 버전이 그대로 읽습니다.
    단, [시스템 설정]에서 CCG 목록을 고치면 settings.ccg_teams 한 칸이 생깁니다.
    이전 버전은 이 칸을 무시하고 코드에 박힌 CCG 목록을 쓰므로 오류는 나지 않지만,
    되돌린 동안에는 고친 CCG 목록이 반영되지 않습니다(데이터는 보존됨).
{BAR}""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
