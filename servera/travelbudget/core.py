# -*- coding: utf-8 -*-
"""국내 출장비 관리 — 계산 엔진 (SSOT)
그룹(동행) 모델: 출장 1건 = 그룹, 출장자 travelers[] 개인별 행.
잔여 = 총예산 − 처리완료 − 처리중. 예측 기능 없음.
"""
from __future__ import annotations
import csv, io
from copy import deepcopy
from datetime import date

COST = (("trans", "교통비"), ("lodg", "숙박비"), ("meal", "식대&잡비"), ("etc", "기타"))
KEYS = tuple(k for k, _ in COST)

PLAN_TYPES = ("계획", "변경", "긴급")
RANKS = ("TL", "팀장")
KINDS = ("기술교류(Live Demo, Data 분석)", "실사&사양 개선,협의", "정기 Audit",
         "비정기 Audit(Issue/Theme)", "기타")
CARS = ("미사용", "자차사용")
REV_TYPES = ("최초배정", "추가증액", "감액", "이월")

# 상태: 계획 등록 → 실적 입력·인폼 → 소재 이관 → 처리 완료 / 취소
ST_PLAN, ST_INFORM, ST_TRANSFER, ST_DONE, ST_CANCEL = \
    "계획 등록", "실적 입력·인폼", "소재 이관", "처리 완료", "취소"
STATUSES = (ST_PLAN, ST_INFORM, ST_TRANSFER, ST_DONE, ST_CANCEL)
WIP = (ST_INFORM, ST_TRANSFER)          # 처리중 = 실적 있고 이관·처리 진행

CCG_TEAMS = [
    {"team": "Photo 소재팀",     "ccg": "C1303"},
    {"team": "Chemical 소재팀",  "ccg": "C1101"},
    {"team": "CMP 소재팀",       "ccg": "C1404"},
    {"team": "Gas 소재팀",       "ccg": "C1202"},
    {"team": "Precursor 소재팀", "ccg": "C1505"},
    {"team": "Wafer 소재팀",     "ccg": "C1606"},
    {"team": "Target 소재팀",    "ccg": "C1707"},
]
CCG_BY_NM = {t["team"]: t["ccg"] for t in CCG_TEAMS}

CSV_HEADERS = ["no.", "구분", "LV2", "CCG", "CCG명", "사번", "성명", "직책",
    "출장도시", "출장기관&업체", "출장목적&사유", "출발일자", "복귀일자", "출장일수",
    "출장시점", "자차사용여부", "출장구분", "상태",
    "계획_총합계", "계획_교통비", "계획_숙박비", "계획_식대&잡비", "계획_기타",
    "실적_총합계", "실적_교통비", "실적_숙박비", "실적_식대&잡비", "실적_기타", "비고"]


# ── 유틸 ──────────────────────────────────────────────────
def num(v):
    try:
        return int(round(float(str(v or 0).replace(",", ""))))
    except (ValueError, TypeError):
        return 0


def won(n):
    return format(num(n), ",d")


def _d(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except (ValueError, TypeError):
        return None


def trip_days(a, b):
    da, db = _d(a), _d(b)
    if not da or not db:
        return 0
    n = (db - da).days
    return 0 if n < 0 else n + 1


def quarter(s):
    d = _d(s)
    return f"{(d.month - 1) // 3 + 1}Q" if d else ""


def year_quarter(s=None):
    d = _d(s) or date.today()
    return f"{d.year}-{(d.month - 1) // 3 + 1}Q"


def yq_list(n=6):
    y, q = date.today().year, (date.today().month - 1) // 3 + 1
    out = []
    for _ in range(n):
        out.append(f"{y}-{q}Q")
        q -= 1
        if q == 0:
            y, q = y - 1, 4
    # 다음 분기(계획 취합 대상)를 맨 앞에
    ny, nq = date.today().year, (date.today().month - 1) // 3 + 2
    if nq == 5:
        ny, nq = ny + 1, 1
    return [f"{ny}-{nq}Q"] + out


def p_sum(p, x):
    return sum(num(p.get(f"{x}_{k}")) for k in KEYS)


def g_sum(g, x):
    return sum(p_sum(p, x) for p in g.get("travelers", []))


# ── 정규화·검증 ───────────────────────────────────────────
def normalize_group(g):
    g = deepcopy(g)
    g.setdefault("plan_type", "계획")
    g.setdefault("status", ST_PLAN)
    g.setdefault("lv2", "소재")
    g.setdefault("travelers", [])
    g.setdefault("remark", "")
    g["days"] = trip_days(g.get("dep_dt"), g.get("ret_dt"))
    g["quarter"] = quarter(g.get("dep_dt"))
    g["yq"] = g.get("yq") or year_quarter(g.get("dep_dt"))
    for p in g["travelers"]:
        p.setdefault("rank", "TL")
        if not p.get("ccg") and p.get("ccg_nm") in CCG_BY_NM:
            p["ccg"] = CCG_BY_NM[p["ccg_nm"]]
        for x in ("p", "a"):
            for k in KEYS:
                p[f"{x}_{k}"] = num(p.get(f"{x}_{k}"))
    g["plan_tot"] = g_sum(g, "p")
    g["act_tot"] = g_sum(g, "a")
    return g


def validate_group(g, require_actual=False):
    e = []
    for k, label in (("city", "출장도시"), ("org", "출장기관&업체"),
                     ("purpose", "출장목적&사유"), ("dep_dt", "출발일자"),
                     ("ret_dt", "복귀일자"), ("kind", "출장구분")):
        if not str(g.get(k, "")).strip():
            e.append(f"{label}을(를) 입력하세요.")
    if g.get("plan_type") not in PLAN_TYPES:
        e.append("구분이 올바르지 않습니다.")
    if g.get("status") not in STATUSES:
        e.append("상태 값이 올바르지 않습니다.")
    if g.get("dep_dt") and g.get("ret_dt") and trip_days(g["dep_dt"], g["ret_dt"]) < 1:
        e.append("복귀일자는 출발일자보다 빠를 수 없습니다.")
    T = g.get("travelers", [])
    if not T:
        e.append("출장자를 1명 이상 입력하세요.")
    seen = set()
    for i, p in enumerate(T, 1):
        if not str(p.get("name", "")).strip():
            e.append(f"{i}번 출장자 성명을 입력하세요.")
        if not str(p.get("emp_no", "")).strip():
            e.append(f"{i}번 출장자 사번을 입력하세요.")
        elif p["emp_no"] in seen:
            e.append(f"{i}번 출장자 사번이 중복입니다.")
        else:
            seen.add(str(p.get("emp_no")))
        if p.get("rank") not in RANKS:
            e.append(f"{i}번 출장자 직책을 선택하세요 (TL/팀장).")
        if not str(p.get("ccg", "")).strip():
            e.append(f"{i}번 출장자 CCG팀을 선택하세요.")
        if require_actual and p_sum(p, "a") <= 0:
            e.append(f"{i}번 출장자 실적 비용을 입력하세요.")
    # 긴급은 계획비 0 허용, 그 외 계획 필수
    if g.get("plan_type") != "긴급" and g.get("status") == ST_PLAN and g_sum(g, "p") <= 0:
        e.append("계획 비용을 1개 이상 입력하세요.")
    if g.get("plan_type") == "긴급" and require_actual and not str(g.get("remark", "")).strip():
        e.append("긴급 출장은 비고(사유)가 필수입니다.")
    return e


def validate_budget(b):
    e = []
    yq = str(b.get("yq", "")).strip()
    if not yq or "-" not in yq or not yq.endswith("Q"):
        e.append("분기를 입력하세요 (예: 2026-3Q).")
    if b.get("rev_type") not in REV_TYPES:
        e.append("유형을 선택하세요.")
    if num(b.get("amt")) == 0:
        e.append("금액을 입력하세요.")
    return e


def fix_budget_sign(b):
    """감액은 자동 음수, 그 외 자동 양수."""
    amt = num(b.get("amt"))
    b["amt"] = -abs(amt) if b.get("rev_type") == "감액" else abs(amt)
    return b


# ── 대시보드 (SSOT) ───────────────────────────────────────
def dash(data, yq):
    G = [normalize_group(g) for g in data.get("groups", []) if (g.get("yq") or "") == yq]
    B = [b for b in data.get("budget", []) if b.get("yq") == yq]
    alloc = sum(num(b.get("amt")) for b in B)

    done = [g for g in G if g["status"] == ST_DONE]
    wip = [g for g in G if g["status"] in WIP]
    plan = [g for g in G if g["status"] == ST_PLAN]
    cancel = [g for g in G if g["status"] == ST_CANCEL]

    done_amt = sum(g["act_tot"] for g in done)
    wip_amt = sum(g["act_tot"] for g in wip)
    plan_amt = sum(g["plan_tot"] for g in plan)
    remain = alloc - done_amt - wip_amt          # 요청 공식

    # CCG(부서)별 집행 — 개인별 행 기준 집계
    ccg_map = {}
    for t in CCG_TEAMS:
        ccg_map[t["ccg"]] = dict(team=t["team"], ccg=t["ccg"], done=0, wip=0,
                                 plan=0, groups=set(), people=0)
    for g in G:
        if g["status"] == ST_CANCEL:
            continue
        for p in g["travelers"]:
            row = ccg_map.get(p.get("ccg"))
            if not row:
                continue
            a = p_sum(p, "a")
            if g["status"] == ST_DONE:
                row["done"] += a
            elif g["status"] in WIP:
                row["wip"] += a
            else:
                row["plan"] += p_sum(p, "p")
            row["groups"].add(g["group_id"])
            row["people"] += 1
    used_total = done_amt + wip_amt
    by_ccg = []
    for row in ccg_map.values():
        tot = row["done"] + row["wip"]
        if row["people"] == 0:
            continue
        by_ccg.append(dict(team=row["team"], ccg=row["ccg"], done=row["done"],
                           wip=row["wip"], total=tot, plan=row["plan"],
                           share=(tot / used_total) if used_total else 0,
                           groups=len(row["groups"]), people=row["people"]))
    by_ccg.sort(key=lambda r: -r["total"])

    todo = {
        "actual_wait": [g["group_id"] for g in plan
                        if (_d(g.get("ret_dt")) or date.max) < date.today()],
        "process_wait": [g["group_id"] for g in wip],
    }
    return {
        "yq": yq, "alloc": alloc, "done": done_amt, "wip": wip_amt,
        "remain": remain, "planAmt": plan_amt, "short": remain < 0,
        "nDone": len(done), "nWip": len(wip), "nPlan": len(plan),
        "nCancel": len(cancel), "nPeople": sum(len(g["travelers"]) for g in G
                                               if g["status"] != ST_CANCEL),
        "byCcg": by_ccg, "todo": todo,
    }


# ── 이메일 인폼 (그룹당 1통, HTML 표) ─────────────────────
def make_mail(g, settings):
    g = normalize_group(g)
    name = " ".join(x for x in (g.get("city", ""), g.get("org", "")) if x) or "국내 출장"
    subject = f"{name} 국내 출장 정산 위한 출장비 실비 이관 요청 건"
    period = f"{g.get('dep_dt','')} ~ {g.get('ret_dt','')} ({g.get('days',0)}일)"
    T = g.get("travelers", [])

    # 평문
    L = [f"{name} 출장비 실비 이관 요청 드립니다.", "",
         f"[출장 정보] {period} · {g.get('purpose','')}",
         f"출장 인원 {len(T)}명 · 실적 총액 {won(g['act_tot'])}원", "",
         "CCG팀\t성명\t사번\t교통비\t숙박비\t식대&잡비\t기타\t합계"]
    for p in T:
        L.append("\t".join(str(x) for x in (p.get("ccg_nm", ""), p.get("name", ""),
                 p.get("emp_no", ""), won(p["a_trans"]), won(p["a_lodg"]),
                 won(p["a_meal"]), won(p["a_etc"]), won(p_sum(p, "a")))))
    if g.get("remark"):
        L += ["", f"[비고] {g['remark']}"]
    L += ["", f"** 참고 : {settings.get('reference_url','')}"]

    # HTML (Outlook 붙여넣기)
    td = 'style="padding:6px 11px;border:1px solid #D8DEE8"'
    tdr = 'style="padding:6px 11px;border:1px solid #D8DEE8;text-align:right"'
    th = 'style="padding:6px 11px;border:1px solid #D8DEE8;background:#EEF2F8"'
    thr = th[:-1] + ';text-align:right"'
    rows = ""
    tots = dict((k, 0) for k in KEYS)
    for p in T:
        for k in KEYS:
            tots[k] += p[f"a_{k}"]
        rows += (f"<tr><td {td}>{p.get('ccg_nm','')}</td><td {td}>{p.get('name','')}</td>"
                 f"<td {td}>{p.get('emp_no','')}</td>"
                 + "".join(f"<td {tdr}>{won(p[f'a_{k}'])}</td>" for k in KEYS)
                 + f"<td {tdr}><b>{won(p_sum(p,'a'))}</b></td></tr>")
    foot = (f'<tr><td {td} colspan="3" style="padding:6px 11px;border:1px solid #D8DEE8;'
            f'background:#F6F8FB;font-weight:700">합계</td>'
            + "".join(f"<td {tdr[:-1]};background:#F6F8FB;font-weight:700\">{won(tots[k])}</td>" for k in KEYS)
            + f"<td {tdr[:-1]};background:#F6F8FB;font-weight:700\">{won(g['act_tot'])}</td></tr>")
    info = (f"<p style='margin:0 0 8px'>{name} 출장비 실비 이관 요청 드립니다.</p>"
            f"<table style='border-collapse:collapse;font-size:13px;margin:0 0 8px'>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>기간</td><td style='padding:2px 10px'>{period}</td></tr>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>목적</td><td style='padding:2px 10px'>{g.get('purpose','')}</td></tr>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>인원</td><td style='padding:2px 10px'>{len(T)}명 · 실적 총액 <b>{won(g['act_tot'])}원</b></td></tr>"
            f"</table>")
    table = (f"<table style='border-collapse:collapse;font-size:13px'>"
             f"<thead><tr><th {th}>CCG팀</th><th {th}>성명</th><th {th}>사번</th>"
             + "".join(f"<th {thr}>{lbl}</th>" for _, lbl in COST)
             + f"<th {thr}>합계</th></tr></thead><tbody>{rows}{foot}</tbody></table>")
    remark = (f"<p style='margin:8px 0 0;font-size:13px'><b>비고</b> {g['remark']}</p>"
              if g.get("remark") else "")
    ref = (f"<p style='margin:10px 0 0;font-size:12px;color:#64718C'>"
           f"** 참고 : {settings.get('reference_url','')}</p>")
    return {"to": ";".join(settings.get("mail_recipients", [])),
            "subject": subject, "trip_name": name,
            "body_text": "\n".join(L), "body_html": info + table + remark + ref}


# ── CSV (개인별 행 flatten) ───────────────────────────────
def make_csv(data, yq=None):
    out, no = [], 1
    for raw in sorted(data.get("groups", []), key=lambda g: g.get("dep_dt", "")):
        g = normalize_group(raw)
        if yq and g["yq"] != yq:
            continue
        for p in g["travelers"]:
            out.append([no, g["plan_type"], "소재", p.get("ccg", ""), p.get("ccg_nm", ""),
                        p.get("emp_no", ""), p.get("name", ""), p.get("rank", ""),
                        g.get("city", ""), g.get("org", ""), g.get("purpose", ""),
                        g.get("dep_dt", ""), g.get("ret_dt", ""), g["days"], g["quarter"],
                        g.get("car", ""), g.get("kind", ""), g["status"],
                        p_sum(p, "p"), p["p_trans"], p["p_lodg"], p["p_meal"], p["p_etc"],
                        p_sum(p, "a"), p["a_trans"], p["a_lodg"], p["a_meal"], p["a_etc"],
                        g.get("remark", "")])
            no += 1
    b = io.StringIO()
    w = csv.writer(b, lineterminator="\r\n")
    w.writerow(CSV_HEADERS)
    w.writerows(out)
    return "\ufeff" + b.getvalue()
