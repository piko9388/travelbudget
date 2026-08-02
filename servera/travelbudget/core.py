# -*- coding: utf-8 -*-
"""국내 출장비 관리 — 계산 엔진 (SSOT)
그룹(동행) 모델: 출장 1건 = 그룹, 출장자 travelers[] 개인별 행.
잔여 = 총예산 − 처리완료 − 처리중. 예측 기능 없음.
"""
from __future__ import annotations
import csv, io
from copy import deepcopy
from datetime import date
from html import escape

COST = (("trans", "교통비"), ("lodg", "숙박비"), ("meal", "식대&잡비"), ("etc", "기타"))
KEYS = tuple(k for k, _ in COST)

PLAN_TYPES = ("계획", "변경", "긴급")
RANKS = ("TL", "팀장")
KINDS = ("기술교류(Live Demo, Data 분석)", "실사&사양 개선,협의", "정기 Audit",
         "비정기 Audit(Issue/Theme)", "기타")
CARS = ("미사용", "자차사용")
REV_TYPES = ("최초배정", "추가증액", "감액", "이월")

# 상태: 계획 등록(잠정) → 확정 예정(예산 확보) → 실적 입력·인폼 → 소재 이관 → 처리 완료 / 취소
ST_PLAN, ST_INFORM, ST_TRANSFER, ST_DONE, ST_CANCEL = \
    "계획 등록", "실적 입력·인폼", "소재 이관", "처리 완료", "취소"
ST_CONFIRM = "확정 예정"                  # 실제로 감 → 계획 금액만큼 예산 선확보
STATUSES = (ST_PLAN, ST_CONFIRM, ST_INFORM, ST_TRANSFER, ST_DONE, ST_CANCEL)
PRE = (ST_PLAN, ST_CONFIRM)             # 실적 전(계획 단계) — 개인 처리 상태 없음
WIP = (ST_INFORM, ST_TRANSFER)          # 처리중 = 실적 있고 이관·처리 진행
ST_HOLD = "보류"                         # 개인별 처리 보류 (예: 예산 부족)
PSTATES = (ST_INFORM, ST_TRANSFER, ST_HOLD, ST_DONE)   # 출장자 개인 처리 상태
ADMIN_ZONE = (ST_TRANSFER, ST_HOLD, ST_DONE)           # 예산 담당자가 결정한 영역

# 조직 개편은 연 단위로 일어난다. 이 목록은 '처음 설치했을 때의 기본값'일 뿐이고,
# 운영 중에는 화면 [시스템 설정]에서 고친다(→ data.json 의 settings.ccg_teams).
CCG_TEAMS = [
    {"team": "소재전략",             "ccg": "50110502"},
    {"team": "P&C소재",              "ccg": "50128121"},
    {"team": "Patterning소재기술",   "ccg": "50119135"},
    {"team": "Patterning소재개발",   "ccg": "50077468"},
    {"team": "C&C소재기술",          "ccg": "50139632"},
    {"team": "C&C소재개발",          "ccg": "50134405"},
    {"team": "EDTW소재기술",         "ccg": "50119134"},
    {"team": "EDTW소재개발",         "ccg": "50103536"},
]
CCG_BY_NM = {t["team"]: t["ccg"] for t in CCG_TEAMS}
CCG_BY_CD = {t["ccg"]: t["team"] for t in CCG_TEAMS}
CCG_MAX = 40                             # 화면·표에서 다룰 수 있는 상한 (오입력 방어선)


def ccg_teams(data=None):
    """CCG 목록 — data.json 의 settings.ccg_teams 가 있으면 그것, 없으면 위 기본값.

    조직 코드는 바뀐다. 코드에만 두면 바뀔 때마다 배포해야 하므로 설정으로 옮겼다.
    설정 키가 없는 기존 원장도 그대로 돈다 — 스키마를 깨지 않는다."""
    raw = ((data or {}).get("settings") or {}).get("ccg_teams")
    if not isinstance(raw, list):
        return CCG_TEAMS
    out, seen = [], set()
    for t in raw:
        if not isinstance(t, dict):
            continue
        nm, cd = _txt(t.get("team")), _txt(t.get("ccg"))
        if not nm or not cd or cd in seen:
            continue
        seen.add(cd)
        out.append({"team": nm, "ccg": cd})
    return out[:CCG_MAX] or CCG_TEAMS     # 전부 걸러졌으면 기본값으로 (빈 목록은 등록 불가 상태)


def ccg_by_nm(data=None):
    return {t["team"]: t["ccg"] for t in ccg_teams(data)}


def ccg_by_cd(data=None):
    """CCG 코드 → 팀 이름. 표시용 이름은 항상 코드에서 파생한다."""
    return {t["ccg"]: t["team"] for t in ccg_teams(data)}

APP_VERSION = "v10.15"                     # 사내 서버 업로드 버전 (배포 시 여기만 올림)
APP_BUILD = "2026-08-01"

# 센터 관리 양식(정산 대장) 27필드 — 최초 제공 엑셀표 순서 그대로. 센터 제출은 이 양식.
CSV_HEADERS = ["구분", "LV2", "CCG", "CCG명", "사번", "성명", "직책",
    "출장도시", "출장기관&업체", "출장목적&사유", "출발일자", "복귀일자",
    "출장일수", "출장시점", "자차사용여부", "출장구분",
    "계획_총합계", "계획_교통비", "계획_숙박비", "계획_식대&잡비", "계획_기타",
    "실적_총합계", "실적_교통비", "실적_숙박비", "실적_식대&잡비", "실적_기타", "비고"]
# 내부 관리용 추가 컬럼 (센터 제출본에는 넣지 않음)
CSV_EXTRA = ["상태", "개인처리상태", "SAP전표번호", "리드타임(일)"]

# 프로세스 진행 순서 — 목록의 '프로세스별 우선 분류'에 쓰는 정렬 가중치
STAGE_ORDER = {ST_PLAN: 0, ST_CONFIRM: 1, ST_INFORM: 2, ST_TRANSFER: 3, ST_DONE: 4, ST_CANCEL: 5}
LEAD_DAYS_MIN = 7                        # 사전 신청 기준 (D-7)
# 비용 1건(1인·1항목) 상한 — 업무 규칙이 아니라 오타 방어선(0을 더 찍은 값이 원장에 들어가는 것을 막음)
AMT_MAX = 100_000_000
# 텍스트 길이 상한 — 업무 규칙이 아니라 붙여넣기 사고 방어선.
# (실제 값은 도시 2~4자, 업체 10자 안팎, 목적 30자 안팎이라 넉넉한 자리)
TEXT_MAX = (("city", "출장도시", 40), ("org", "출장기관&업체", 100),
            ("purpose", "출장목적&사유", 300), ("remark", "비고", 500))
PERSON_MAX = (("name", "성명", 40), ("emp_no", "사번", 30))
TRAVELERS_MAX = 30                       # 한 출장의 동행 상한 (센터 양식·인폼 표가 견디는 선)


# ── 유틸 ──────────────────────────────────────────────────
def num(v):
    """금액 정수화. NaN·Infinity·거대값은 0 — 어떤 입력도 예외를 던지지 않는다."""
    try:
        f = float(str(v or 0).replace(",", ""))
    except (ValueError, TypeError):
        return 0
    if f != f or f in (float("inf"), float("-inf")):   # NaN·±Infinity
        return 0
    if abs(f) > 1e15:                                   # 파이썬 int 는 무한정이라 여기서 끊는다
        return 0
    return int(round(f))


def won(n):
    return format(num(n), ",d")


def _txt(v):
    """텍스트 필드 정규화 — dict/list/bool/None은 빈 값으로.
    원장·CSV·정렬이 전부 '문자열'을 전제로 동작하므로, 저장 전에 여기서 형을 고정한다.
    (JSON API라 어떤 타입이든 들어올 수 있고, str()만 씌우면 '{}' 같은 값이 원장에 남는다)"""
    if v is None or isinstance(v, (dict, list, bool)):
        return ""
    return str(v).strip()


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


# ── 개인별 처리 상태 ───────────────────────────────────────
def eff_status(p, g):
    """출장자 실효 처리 상태 — 개인 상태가 있으면 개인, 없으면 그룹 상태 상속(구 데이터 호환)."""
    gs = g.get("status")
    if gs in PRE or gs == ST_CANCEL:
        return gs
    return p.get("status") or gs


def group_roll(g):
    """출장자 개인 상태 롤업 → 그룹 표시용 상태 (계획/확정/취소는 그대로)."""
    gs = g.get("status")
    if gs in PRE or gs == ST_CANCEL:
        return gs
    effs = [eff_status(p, g) for p in g.get("travelers", [])]
    if not effs:
        return gs
    if all(e == ST_DONE for e in effs):
        return ST_DONE
    if all(e in (ST_TRANSFER, ST_DONE) for e in effs):
        return ST_TRANSFER
    return ST_INFORM                     # 일부 인폼/보류 남음 → 처리중


def locked(g):
    """예산 담당자 영역인가 — 여기 걸리면 모든 변경에 관리자 인증 필요.
    원칙: 그룹이 이관·완료·취소이거나, 출장자 중 한 명이라도 이관·완료·보류면 잠금.
    (부분 완료 건이 '아직 담당자 영역'으로 오인되어 정산 금액이 조작되던 구멍을 막는다)"""
    if g.get("status") in (ST_TRANSFER, ST_DONE, ST_CANCEL):
        return True
    return any(eff_status(p, g) in ADMIN_ZONE for p in g.get("travelers", []))


def proc_counts(g):
    """그룹 내 개인 상태 집계 (UI 표시용)."""
    c = {"total": len(g.get("travelers", [])), "inform": 0,
         "transfer": 0, "done": 0, "hold": 0}
    if g.get("status") in PRE or g.get("status") == ST_CANCEL:
        return c
    for p in g.get("travelers", []):
        e = eff_status(p, g)
        if e == ST_DONE:
            c["done"] += 1
        elif e == ST_TRANSFER:
            c["transfer"] += 1
        elif e == ST_HOLD:
            c["hold"] += 1
        else:
            c["inform"] += 1
    return c


# ── 정규화·검증 ───────────────────────────────────────────
def normalize_group(g, by_nm=None, by_cd=None):
    by_nm = by_nm if by_nm is not None else CCG_BY_NM
    by_cd = by_cd if by_cd is not None else CCG_BY_CD
    g = deepcopy(g)
    g.setdefault("plan_type", "계획")
    g.setdefault("status", ST_PLAN)
    g.setdefault("lv2", "소재")
    # travelers는 반드시 dict의 list — 아니면 여기서 안전하게 비우고 validate_group이 400으로 돌려준다.
    # (정규화가 검증보다 먼저 도는 구조라, 여기서 막지 않으면 잘못된 형식이 500으로 터진다)
    T = g.get("travelers")
    g["travelers"] = [p for p in T if isinstance(p, dict)] if isinstance(T, list) else []
    g.setdefault("remark", "")
    for k in ("plan_type", "status", "lv2", "city", "org", "purpose",
              "kind", "car", "remark", "group_id", "sap_doc"):
        g[k] = _txt(g.get(k))
    for k in ("dep_dt", "ret_dt"):        # 날짜는 파싱되는 값만 남긴다 (아니면 빈 값 → 검증이 잡음)
        g[k] = str(_d(g.get(k)) or "")
    g["days"] = trip_days(g.get("dep_dt"), g.get("ret_dt"))
    g["quarter"] = quarter(g.get("dep_dt"))
    # 분기(yq)는 항상 출발일 기준으로 재계산 — 일자 수정 시 엉뚱한 분기에 귀속되지 않도록.
    g["yq"] = year_quarter(g["dep_dt"]) if _d(g.get("dep_dt")) else (g.get("yq") or year_quarter())
    for p in g["travelers"]:
        p.setdefault("rank", "TL")
        for k in ("name", "emp_no", "rank", "ccg_nm", "ccg"):
            p[k] = _txt(p.get(k))
        if not p.get("ccg") and p.get("ccg_nm") in by_nm:
            p["ccg"] = by_nm[p["ccg_nm"]]
        # 팀 이름은 코드에서 파생한다 — 등록된 코드면 현재 팀 이름으로 통일.
        # (설정에서 팀 이름을 바꾸면 대시보드는 새 이름, 내역·CSV·인폼은 옛 이름이라
        #  같은 팀이 화면마다 다른 이름으로 보이던 문제. 코드는 그대로 두므로 집계는 불변)
        if p.get("ccg") in by_cd:
            p["ccg_nm"] = by_cd[p["ccg"]]
        # 개인 처리 상태: 유효값만 유지, 그 외/없음은 ""(그룹 상속)
        p["status"] = p.get("status") if p.get("status") in PSTATES else ""
        for x in ("p", "a"):
            for k in KEYS:
                p[f"{x}_{k}"] = num(p.get(f"{x}_{k}"))
    g["plan_tot"] = g_sum(g, "p")
    g["act_tot"] = g_sum(g, "a")
    g["roll"] = group_roll(g)            # 개인 상태 롤업(표시용)
    g["proc"] = proc_counts(g)           # 개인 상태 집계(UI)
    g["stage"] = STAGE_ORDER.get(g["roll"], 9)     # 프로세스 정렬 가중치
    g["sap_doc"] = str(g.get("sap_doc") or "").strip()   # 소재팀 전표번호
    d0, dp = _d(g.get("created_at")), _d(g.get("dep_dt"))
    g["lead_days"] = (dp - d0).days if (d0 and dp) else None    # 사전 신청 리드타임
    return g


def josa(w, pair="을를"):
    """받침 유무로 조사 선택 — '출장도시을(를)' 같은 어색한 안내를 없앤다."""
    if not w:
        return pair[1]
    c = ord(w[-1])
    has_final = 0xAC00 <= c <= 0xD7A3 and (c - 0xAC00) % 28
    return pair[0] if has_final else pair[1]


def validate_group(g, require_actual=False, by_nm=None):
    e = []
    for k, label in (("city", "출장도시"), ("org", "출장기관&업체"),
                     ("purpose", "출장목적&사유"), ("dep_dt", "출발일자"),
                     ("ret_dt", "복귀일자"), ("kind", "출장구분")):
        if not str(g.get(k, "")).strip():
            e.append(f"{label}{josa(label)} 입력하세요.")
    # 금액엔 상한(1억)이 있는데 텍스트엔 없어서, 잘못 붙여넣은 5,000자가 그대로 원장에 들어갔다.
    # 업무 규칙이 아니라 사고 방어선 — 목록·CSV·인폼 표가 통째로 망가지는 것을 막는다.
    for k, label, lim in TEXT_MAX:
        v = _txt(g.get(k))
        if len(v) > lim:
            e.append(f"{label}{josa(label, '은는')} {lim}자를 넘습니다 ({len(v):,}자) — "
                     f"붙여넣기가 잘못되지 않았는지 확인하세요.")
    if g.get("plan_type") not in PLAN_TYPES:
        e.append("구분이 올바르지 않습니다.")
    if g.get("status") not in STATUSES:
        e.append("상태 값이 올바르지 않습니다.")
    if str(g.get("kind", "")).strip() and g.get("kind") not in KINDS:
        e.append("출장구분이 올바르지 않습니다.")
    if str(g.get("car", "")).strip() and g.get("car") not in CARS:
        e.append("자차사용여부가 올바르지 않습니다.")
    if g.get("dep_dt") and g.get("ret_dt") and trip_days(g["dep_dt"], g["ret_dt"]) < 1:
        e.append("복귀일자는 출발일자보다 빠를 수 없습니다.")
    T = g.get("travelers", [])
    if not isinstance(T, list) or any(not isinstance(p, dict) for p in T):
        return e + ["출장자 형식이 올바르지 않습니다."]     # 잘못된 타입은 500 대신 400
    if not T:
        e.append("출장자를 1명 이상 입력하세요.")
    if len(T) > TRAVELERS_MAX:
        e.append(f"한 출장의 동행은 {TRAVELERS_MAX}명까지입니다 ({len(T)}명) — "
                 f"붙여넣기 범위가 잘못되지 않았는지 확인하세요.")
    seen = set()
    valid_ccg = set((by_nm if by_nm is not None else CCG_BY_NM).values())
    for i, p in enumerate(T, 1):
        for k, label, lim in PERSON_MAX:
            if len(_txt(p.get(k))) > lim:
                e.append(f"{i}번 출장자 {label}{josa(label, '은는')} {lim}자를 넘습니다.")
        if not str(p.get("name", "")).strip():
            e.append(f"{i}번 출장자 성명을 입력하세요.")
        emp = str(p.get("emp_no", "")).strip()
        if not emp:
            e.append(f"{i}번 출장자 사번을 입력하세요.")
        elif emp in seen:
            e.append(f"{i}번 출장자 사번이 중복입니다.")
        else:
            seen.add(emp)
        if p.get("rank") not in RANKS:
            e.append(f"{i}번 출장자 직책을 선택하세요 (TL/팀장).")
        ccg = str(p.get("ccg", "")).strip()
        if not ccg:
            e.append(f"{i}번 출장자 CCG팀을 선택하세요.")
        elif ccg not in valid_ccg:
            e.append(f"{i}번 출장자 CCG팀이 올바르지 않습니다.")
        if require_actual and p_sum(p, "a") < 0:
            e.append(f"{i}번 출장자 실적 비용이 올바르지 않습니다.")
        for x, lab in (("p", "계획"), ("a", "실적")):
            for k, kl in COST:
                v = num(p.get(f"{x}_{k}"))
                if v > AMT_MAX:
                    e.append(f"{i}번 출장자 {lab} {kl} {won(v)}원이 상한({won(AMT_MAX)}원)을 넘습니다 — 자릿수를 확인하세요.")
                elif v < 0:
                    e.append(f"{i}번 출장자 {lab} {kl}는 음수일 수 없습니다.")
    # 실적 단계는 '그룹 합계'가 0보다 크면 통과 — 동행자 1명이 불참(0원)해도 저장 가능
    if require_actual and T and g_sum(g, "a") <= 0:
        e.append("실적 비용을 1개 이상 입력하세요.")
    # 긴급은 계획비 0 허용, 그 외 계획 단계(잠정·확정)는 계획 필수
    if g.get("plan_type") != "긴급" and g.get("status") in PRE and g_sum(g, "p") <= 0:
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
    # 정규화 후 필터 — yq는 출발일에서 파생되므로, 가져온 데이터에 yq가 없어도 올바른 분기에 집계됨.
    G = [g for g in (normalize_group(g) for g in data.get("groups", [])) if g["yq"] == yq]
    B = [b for b in data.get("budget", []) if b.get("yq") == yq]
    alloc = sum(num(b.get("amt")) for b in B)

    done_amt = wip_amt = plan_amt = commit_amt = 0
    nDone = nWip = nPlan = nConfirm = nCancel = nPeople = 0
    # 비목(교통·숙박·식대&잡비·기타) 구성 — 예산에 잡힌 축(확정 예정 이후)만 담는다.
    # 확정 전은 계획값(p_*), 확정 후는 실적값(a_*) 으로 위 합계와 같은 금액이 되게 한다.
    cost_map = {k: 0 for k, _ in COST}
    nUsedPeople = [0]                    # 실집행 인원 (계획·확정 단계 제외)
    ccg_map = {}
    for t in ccg_teams(data):
        ccg_map[t["ccg"]] = dict(team=t["team"], ccg=t["ccg"], done=0, wip=0,
                                 commit=0, plan=0, groups=set(), people=0, cpeople=0)
    # 미등록 CCG 코드도 버리지 않고 모아 합계가 어긋나지 않게 한다
    ccg_map["_ETC"] = dict(team="기타(미등록 CCG)", ccg="-", done=0, wip=0,
                           commit=0, plan=0, groups=set(), people=0, cpeople=0)
    # 확정 예정 = 계획 금액 선확보(가용에서 차감), 잠정 계획 = 참고만.
    # 실적 이후 금액은 출장자 개인 실효 상태 기준(5명 중 3완료·1보류 그대로).
    for g in G:
        gs = g["status"]
        if gs == ST_CANCEL:
            nCancel += 1
            continue
        if gs == ST_PLAN:
            nPlan += 1
        elif gs == ST_CONFIRM:
            nConfirm += 1
        elif g["roll"] == ST_DONE:
            nDone += 1
        else:
            nWip += 1
        for p in g["travelers"]:
            nPeople += 1
            row = ccg_map.get(p.get("ccg")) or ccg_map["_ETC"]
            used = gs not in PRE            # 실집행(처리 중·처리 완료) 단계인가
            if gs == ST_PLAN:
                pl = p_sum(p, "p")
                plan_amt += pl
                if row:
                    row["plan"] += pl
            elif gs == ST_CONFIRM:
                pl = p_sum(p, "p")
                commit_amt += pl
                if row:
                    row["commit"] += pl
            else:
                eff = eff_status(p, g)
                a = p_sum(p, "a")
                if eff == ST_DONE:
                    done_amt += a
                    if row:
                        row["done"] += a
                else:                    # 인폼·이관·보류 = 처리중
                    wip_amt += a
                    if row:
                        row["wip"] += a
                for k, _ in COST:
                    cost_map[k] += num(p.get("a_" + k))
            if row:
                # 부서별 인원·참여 출장은 실집행 기준. 계획·확정 단계 인원은 세지 않는다
                # (아직 안 간 사람까지 세면 '9명'이 '14명'으로 부풀어 보인다)
                if used:
                    row["groups"].add(g["group_id"])
                    row["people"] += 1
                    nUsedPeople[0] += 1
                elif gs == ST_CONFIRM:
                    row["cpeople"] += 1     # 확정 예정 인원 — 참고로만
    remain = alloc - done_amt - wip_amt              # 실집행 잔여
    avail = remain - commit_amt                      # 가용 잔여 (확정 예산 확보 반영)

    # 부서별 구분은 '실제로 집행된 것'(처리 중 + 처리 완료) 기준.
    # 확정 예정은 아직 안 쓴 돈이라 합계·구성비·정렬에 넣지 않고, 화면에서 흐리게 따로 보여준다.
    used_total = done_amt + wip_amt
    by_ccg = []
    for row in ccg_map.values():
        tot = row["done"] + row["wip"]
        if tot == 0 and row["commit"] == 0:
            continue
        by_ccg.append(dict(team=row["team"], ccg=row["ccg"], done=row["done"],
                           wip=row["wip"], commit=row["commit"], total=tot, plan=row["plan"],
                           share=(tot / used_total) if used_total else 0,
                           groups=len(row["groups"]), people=row["people"],
                           cpeople=row["cpeople"]))
    # 실집행이 큰 팀 우선. 실집행이 없고 확정만 있는 팀은 뒤로.
    by_ccg.sort(key=lambda r: (-r["total"], -r["commit"]))

    todo = {
        # 실적 독촉은 '실제로 간' 확정 건만 — 잠정 계획까지 독촉하지 않는다
        "actual_wait": [g["group_id"] for g in G if g["status"] == ST_CONFIRM
                        and (_d(g.get("ret_dt")) or date.max) < date.today()],
        "process_wait": [g["group_id"] for g in G
                         if g["status"] not in PRE and g["status"] != ST_CANCEL and g["roll"] != ST_DONE],
        # 보류 출장자가 있는 그룹 (예산 부족 등으로 처리 막힌 건)
        "hold": [g["group_id"] for g in G if g["proc"]["hold"] > 0],
    }
    return {
        "yq": yq, "alloc": alloc, "done": done_amt, "wip": wip_amt,
        "commit": commit_amt, "remain": remain, "avail": avail, "planAmt": plan_amt,
        "short": avail < 0 and alloc > 0,     # 예산 미배정 분기에 상시 적색 경보가 뜨지 않도록
        "noBudget": alloc <= 0 and (done_amt or wip_amt or commit_amt) > 0,
        "nDone": nDone, "nWip": nWip, "nPlan": nPlan, "nConfirm": nConfirm,
        "nCancel": nCancel, "nPeople": nPeople,
        # 실제 출장 건수(취소 제외, 중복 없음) — CCG행의 건수는 '참여' 기준이라
        # 두 팀이 함께 간 1건이 양쪽에 잡힌다. 합계에는 반드시 이 값을 쓸 것.
        "nTrips": nPlan + nConfirm + nWip + nDone,
        # 실집행 기준 — 부서별 카드와 같은 축. 화면의 '건수·인원'은 이 값을 쓴다.
        "nUsedTrips": nWip + nDone,
        "nUsedPeople": nUsedPeople[0],
        "nHold": sum(g["proc"]["hold"] for g in G),
        "byCcg": by_ccg, "byCost": [
            dict(key=k, name=nm, amt=cost_map[k],
                 share=(cost_map[k] / used_total) if used_total else 0)
            for k, nm in COST],
        "todo": todo,
    }


# ── 일괄 등록용 엑셀 양식 (센터 27필드 순서 — 붙여넣기 전제) ──────
BULK_REQUIRED = ("출장도시", "출장기관&업체", "출장목적&사유", "출발일자", "사번", "성명", "CCG명")


def bulk_template_xls():
    """의존성 없이 HTML 표로 만든 .xls 양식. 채워서 복사 → 화면에 붙여넣기."""
    font = "'Trebuchet MS','Malgun Gothic','맑은 고딕',sans-serif"
    req_mark = "<br><span style='font-size:8pt;color:#C00'>필수</span>"
    th = []
    for h in CSV_HEADERS:
        need = h in BULK_REQUIRED
        th.append('<th style="background:%s;border:1px solid #999;padding:5px 7px;'
                  'font-family:%s;font-size:11pt;white-space:nowrap">%s%s</th>'
                  % ("#DCE6F1" if need else "#F2F2F2", font, escape(h), req_mark if need else ""))
    sample = [
        ["계획", "소재", "50119134", "EDTW소재기술", "20140508", "박영희", "팀장", "청주", "원익머트리얼즈",
         "NF3 순도 정기 Audit", "2026-08-04", "2026-08-05", "", "", "자차사용", "정기 Audit",
         "", "70000", "95000", "65000", "10000", "", "", "", "", "", ""],
        ["계획", "소재", "50139632", "C&C소재기술", "2071478", "이정훈", "TL", "청주", "원익머트리얼즈",
         "NF3 순도 정기 Audit", "2026-08-04", "2026-08-05", "", "", "자차사용", "정기 Audit",
         "", "70000", "95000", "65000", "10000", "", "", "", "", "", "동행자 — 같은 출장으로 묶임"],
        ["계획", "소재", "50119135", "Patterning소재기술", "20150322", "김철수", "팀장", "이천", "동우화인켐",
         "ArF PR 품질 실사", "2026-08-11", "2026-08-11", "", "", "미사용", "실사&사양 개선,협의",
         "", "80000", "0", "30000", "0", "", "", "", "", "", "당일 출장"],
    ]
    rows = []
    for r in sample:
        tds = []
        for c in r:
            ns = "mso-number-format:'#,##0';text-align:right" if c.isdigit() and len(c) > 3 else ""
            tds.append('<td style="border:1px solid #BBB;padding:4px 7px;font-family:%s;'
                       'font-size:11pt;%s">%s</td>' % (font, ns, escape(c)))
        rows.append("<tr>" + "".join(tds) + "</tr>")
    guide = ("붙여넣기 방법 — (1) 아래 표에 데이터를 채웁니다(회색 열은 비워도 됩니다) "
             "(2) 데이터 행을 선택해 복사(Ctrl+C) (3) 시스템 좌측 메뉴 [엑셀 일괄 등록]에 붙여넣기(Ctrl+V) "
             "(4) 미리보기 확인 후 [등록]. 같은 도시·업체·일자·목적 행은 동행자로 보고 한 건으로 묶습니다. "
             "출장일수·총합계·출장시점은 시스템이 자동 계산하므로 비워 두세요.")
    numfmt = "<style>td,th{mso-number-format:'\\@'}</style>"
    head = ('<html xmlns:o="urn:schemas-microsoft-com:office:office" '
            'xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">'
            + numfmt + "</head><body>")
    top = ('<table border="0" cellspacing="0"><tr><td colspan="27" style="font-family:%s;font-size:12pt;'
           'font-weight:bold;padding:8px 4px;color:#17365D">소재 국내 출장비 — 일괄 등록 양식 '
           '(센터 관리 시트 27필드 순서)</td></tr><tr><td colspan="27" style="font-family:%s;'
           'font-size:10pt;padding:4px;color:#444">%s</td></tr>'
           '<tr><td colspan="27" style="height:6px"></td></tr></table>' % (font, font, guide))
    return (head + top + '<table border="1" cellspacing="0" cellpadding="0"><thead><tr>'
            + "".join(th) + "</tr></thead><tbody>" + "".join(rows) + "</tbody></table></body></html>")


# ── 센터 제출 리포트 (분기 계획·실적·부족액) ──────────────
def center_report(data, yq):
    """센터 협의·추가 확보 요청용 요약 — 분기 배정 대비 집행·확정·부족액."""
    d = dash(data, yq)
    B = sorted([b for b in data.get("budget", []) if b.get("yq") == yq],
               key=lambda b: _txt(b.get("rev_dt")))
    used = d["done"] + d["wip"]
    need = max(0, -d["avail"])                       # 확정분까지 감안한 부족액
    rows = [dict(team=r["team"], ccg=r["ccg"], done=r["done"], wip=r["wip"],
                 commit=r["commit"], plan=r["plan"],
                 total=r["done"] + r["wip"] + r["commit"],
                 groups=r["groups"], people=r["people"]) for r in d["byCcg"]]
    return {
        "yq": yq, "alloc": d["alloc"], "done": d["done"], "wip": d["wip"],
        "commit": d["commit"], "used": used, "avail": d["avail"],
        "need": need, "burn": (used + d["commit"]) / d["alloc"] if d["alloc"] else 0,
        "nDone": d["nDone"], "nWip": d["nWip"], "nConfirm": d["nConfirm"],
        "nPlan": d["nPlan"], "nPeople": d["nPeople"],
        "byCcg": rows,
        "revisions": [dict(rev_id=b.get("rev_id", ""), rev_dt=b.get("rev_dt", ""),
                           rev_type=b.get("rev_type", ""), amt=num(b.get("amt")),
                           reason=b.get("reason", "")) for b in B],
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

    # HTML (Outlook 붙여넣기) — 사용자 입력 값은 전부 escape (담당자 입력이 총괄 화면에서 실행되는 저장형 XSS 차단)
    base = "padding:6px 11px;border:1px solid #D8DEE8"
    td = f'style="{base}"'
    tdr = f'style="{base};text-align:right"'
    th = f'style="{base};background:#EEF2F8"'
    thr = f'style="{base};text-align:right;background:#EEF2F8"'
    tdf = f'style="{base};background:#F6F8FB;font-weight:700"'
    tdrf = f'style="{base};text-align:right;background:#F6F8FB;font-weight:700"'
    rows = ""
    tots = dict((k, 0) for k in KEYS)
    for p in T:
        for k in KEYS:
            tots[k] += p[f"a_{k}"]
        rows += (f"<tr><td {td}>{escape(str(p.get('ccg_nm','')))}</td>"
                 f"<td {td}>{escape(str(p.get('name','')))}</td>"
                 f"<td {td}>{escape(str(p.get('emp_no','')))}</td>"
                 + "".join(f"<td {tdr}>{won(p[f'a_{k}'])}</td>" for k in KEYS)
                 + f"<td {tdr}><b>{won(p_sum(p,'a'))}</b></td></tr>")
    foot = (f'<tr><td {tdf} colspan="3">합계</td>'
            + "".join(f"<td {tdrf}>{won(tots[k])}</td>" for k in KEYS)
            + f"<td {tdrf}>{won(g['act_tot'])}</td></tr>")
    info = (f"<p style='margin:0 0 8px'>{escape(name)} 출장비 실비 이관 요청 드립니다.</p>"
            f"<table style='border-collapse:collapse;font-size:13px;margin:0 0 8px'>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>기간</td><td style='padding:2px 10px'>{escape(period)}</td></tr>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>목적</td><td style='padding:2px 10px'>{escape(str(g.get('purpose','')))}</td></tr>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>인원</td><td style='padding:2px 10px'>{len(T)}명 · 실적 총액 <b>{won(g['act_tot'])}원</b></td></tr>"
            f"</table>")
    table = (f"<table style='border-collapse:collapse;font-size:13px'>"
             f"<thead><tr><th {th}>CCG팀</th><th {th}>성명</th><th {th}>사번</th>"
             + "".join(f"<th {thr}>{escape(lbl)}</th>" for _, lbl in COST)
             + f"<th {thr}>합계</th></tr></thead><tbody>{rows}{foot}</tbody></table>")
    remark = (f"<p style='margin:8px 0 0;font-size:13px'><b>비고</b> {escape(str(g['remark']))}</p>"
              if g.get("remark") else "")
    ref = (f"<p style='margin:10px 0 0;font-size:12px;color:#64718C'>"
           f"** 참고 : {escape(str(settings.get('reference_url','')))}</p>")
    return {"to": ";".join(settings.get("mail_recipients", [])),
            "subject": subject, "trip_name": name, "kind": "actual",
            "heading": "실비 이관 요청 인폼 (그룹당 1통)",
            "body_text": "\n".join(L), "body_html": info + table + remark + ref}


# ── 이관 인폼 (예산 담당자 → 소재 담당자, 비용 처리 요청) ──
def make_transfer_mail(g, settings, emps=None):
    """소재 이관 시점 인폼 — '이관 결재 상신했습니다. 이관 후 비용 처리 부탁드립니다.'"""
    g = normalize_group(g)
    name = " ".join(x for x in (g.get("city", ""), g.get("org", "")) if x) or "국내 출장"
    subject = f"[출장비] {name} 이관 결재 상신 — 비용 처리 요청 건"
    period = f"{g.get('dep_dt','')} ~ {g.get('ret_dt','')} ({g.get('days',0)}일)"
    keys = None if emps is None else {str(e) for e in emps}
    T = [p for p in g.get("travelers", []) if keys is None or str(p.get("emp_no")) in keys]
    tot = sum(p_sum(p, "a") for p in T)
    msg = ["요청하신 금액 이관 결재 상신했습니다.",
           "참조자로 추가하였으니, 이관 후 비용 처리 부탁드립니다."]

    # 평문
    L = msg + ["", f"[출장 정보] {name} · {period} · {g.get('purpose','')}",
               f"이관 대상 {len(T)}명 · 이관 총액 {won(tot)}원", "",
               "성명\tCCG팀\t사번\t이관금액"]
    for p in T:
        L.append("\t".join(str(x) for x in (p.get("name", ""), p.get("ccg_nm", ""),
                 p.get("emp_no", ""), won(p_sum(p, "a")))))
    L += ["", f"** 참고 : {settings.get('reference_url','')}"]

    # HTML (Outlook) — 사용자 입력 escape
    base = "padding:6px 11px;border:1px solid #D8DEE8"
    td = f'style="{base}"'
    tdr = f'style="{base};text-align:right"'
    th = f'style="{base};background:#EEF2F8"'
    thr = f'style="{base};text-align:right;background:#EEF2F8"'
    tdf = f'style="{base};background:#F6F8FB;font-weight:700"'
    tdrf = f'style="{base};text-align:right;background:#F6F8FB;font-weight:700"'
    rows = "".join(
        f"<tr><td {td}>{escape(str(p.get('name','')))}</td>"
        f"<td {td}>{escape(str(p.get('ccg_nm','')))}</td>"
        f"<td {td}>{escape(str(p.get('emp_no','')))}</td>"
        f"<td {tdr}><b>{won(p_sum(p,'a'))}</b></td></tr>" for p in T)
    foot = f'<tr><td {tdf} colspan="3">합계</td><td {tdrf}>{won(tot)}</td></tr>'
    lead = (f"<p style='margin:0 0 5px'>{escape(msg[0])}</p>"
            f"<p style='margin:0 0 10px'>{escape(msg[1])}</p>")
    info = (f"<table style='border-collapse:collapse;font-size:13px;margin:0 0 8px'>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>출장</td><td style='padding:2px 10px'>{escape(name)} · {escape(period)}</td></tr>"
            f"<tr><td style='padding:2px 10px;color:#64718C'>이관</td><td style='padding:2px 10px'>{len(T)}명 · 이관 총액 <b>{won(tot)}원</b></td></tr></table>")
    table = (f"<table style='border-collapse:collapse;font-size:13px'>"
             f"<thead><tr><th {th}>성명</th><th {th}>CCG팀</th><th {th}>사번</th><th {thr}>이관금액</th></tr></thead>"
             f"<tbody>{rows}{foot}</tbody></table>")
    ref = (f"<p style='margin:10px 0 0;font-size:12px;color:#64718C'>"
           f"** 참고 : {escape(str(settings.get('reference_url','')))}</p>")
    to = ";".join(p.get("email", "") for p in T if p.get("email"))
    # to 는 비워 둔다 — 이관 후 비용을 처리할 소재 담당자는 출장·site 마다 다르므로
    # 수신자 마스터를 두지 않고 담당자가 메일에서 직접 지정한다.
    return {"to": to, "subject": subject, "trip_name": name, "kind": "transfer",
            "to_hint": "수신자: 직접 지정 (이관 후 비용을 처리할 소재 담당자)",
            "heading": "이관 결재 상신 · 비용 처리 요청 인폼",
            "body_text": "\n".join(L), "body_html": lead + info + table + ref}


# ── CSV (개인별 행 flatten) ───────────────────────────────
def _csv_safe(v):
    """자유입력 셀의 수식 인젝션(=,+,-,@,탭/개행 선두) 방어 — Excel 자동실행 차단."""
    s = "" if v is None else str(v)
    return "'" + s if s[:1] in ("=", "+", "-", "@", "\t", "\r") else s


BUDGET_CSV_HEADERS = ["no.", "분기", "REV", "반영일", "유형", "증감액", "누적액", "사유"]


def make_budget_csv(data, yq=None):
    """예산 리비전 내역 CSV — 분기별 누적액 포함(분기가 바뀌면 누적 재시작)."""
    B = [b for b in data.get("budget", []) if not yq or b.get("yq") == yq]
    B.sort(key=lambda b: ((b.get("yq") or ""), (b.get("rev_dt") or ""), (b.get("rev_id") or "")))
    out, run, cur = [], 0, None
    for i, b in enumerate(B, 1):
        if b.get("yq") != cur:
            cur, run = b.get("yq"), 0
        run += num(b.get("amt"))
        out.append([i, _csv_safe(b.get("yq", "")), _csv_safe(b.get("rev_id", "")),
                    _csv_safe(b.get("rev_dt", "")), _csv_safe(b.get("rev_type", "")),
                    num(b.get("amt")), run, _csv_safe(b.get("reason", ""))])
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\r\n")
    w.writerow(BUDGET_CSV_HEADERS)
    w.writerows(out)
    return "﻿" + buf.getvalue()


def ledger_rows(data, yq=None, internal=False):
    """센터 관리 양식(정산 대장) 행 — 출장자 개인별 1행."""
    out = []
    by_cd = ccg_by_cd(data)                  # 제출본 CCG명도 설정 기준으로 통일
    for raw in sorted(data.get("groups", []), key=lambda g: _txt(g.get("dep_dt"))):
        g = normalize_group(raw, by_cd=by_cd)
        if yq and g["yq"] != yq:
            continue
        for p in g["travelers"]:
            row = [g["plan_type"], "소재", p.get("ccg", ""), _csv_safe(p.get("ccg_nm", "")),
                   _csv_safe(p.get("emp_no", "")), _csv_safe(p.get("name", "")), p.get("rank", ""),
                   _csv_safe(g.get("city", "")), _csv_safe(g.get("org", "")), _csv_safe(g.get("purpose", "")),
                   g.get("dep_dt", ""), g.get("ret_dt", ""), g["days"], g["quarter"],
                   g.get("car", ""), g.get("kind", ""),
                   p_sum(p, "p"), p["p_trans"], p["p_lodg"], p["p_meal"], p["p_etc"],
                   p_sum(p, "a"), p["a_trans"], p["a_lodg"], p["a_meal"], p["a_etc"],
                   _csv_safe(g.get("remark", ""))]
            if internal:      # 내부 관리용에만 상태·전표·리드타임 부가
                row += [group_roll(g), eff_status(p, g), _csv_safe(g.get("sap_doc", "")),
                        "" if g.get("lead_days") is None else g["lead_days"]]
            out.append(row)
    return out


def make_xls(data, yq=None, internal=False):
    """엑셀 서식 포함 내보내기 — 한글 맑은 고딕 / 영문·숫자 Trebuchet MS.
    CSV는 순수 텍스트라 글꼴을 담을 수 없어, 서식이 필요한 제출본은 이 파일을 쓴다.
    (외부 라이브러리 없이 Excel이 그대로 여는 HTML 표 형식)"""
    heads = CSV_HEADERS + (CSV_EXTRA if internal else [])
    rows = ledger_rows(data, yq, internal)
    # 영문·숫자는 Trebuchet MS, 한글은 맑은 고딕으로 떨어지도록 순서를 둔다
    font = "'Trebuchet MS','Malgun Gothic','맑은 고딕',sans-serif"
    th = (f"font-family:{font};font-size:10pt;font-weight:bold;background:#EEF2F8;"
          "border:1px solid #B7C0CE;padding:4px 6px;text-align:center")
    td = f"font-family:{font};font-size:10pt;border:1px solid #D8DEE8;padding:3px 6px"
    tdn = td + ";mso-number-format:'#,##0';text-align:right"
    def cell(v, i):
        num_col = isinstance(v, int) or (heads[i].startswith(("계획_", "실적_")) or heads[i] in ("출장일수", "리드타임(일)"))
        return f'<td style="{tdn if num_col else td}">{escape(str(v))}</td>'
    body = "".join("<tr>" + "".join(cell(v, i) for i, v in enumerate(r)) + "</tr>" for r in rows)
    title = f"소재 국내 출장비 정산 대장 {yq or '전체'}"
    return ('<html xmlns:o="urn:schemas-microsoft-com:office:office" '
            'xmlns:x="urn:schemas-microsoft-com:office:excel">'
            '<head><meta charset="utf-8">'
            f'<style>body,table,td,th{{font-family:{font}}}</style></head><body>'
            f'<table border="1" cellspacing="0" cellpadding="0">'
            f'<tr><td colspan="{len(heads)}" style="{th};font-size:12pt">{escape(title)}</td></tr>'
            "<tr>" + "".join(f'<th style="{th}">{escape(h)}</th>' for h in heads) + "</tr>"
            f"{body}</table></body></html>")


def make_csv(data, yq=None, internal=False):
    rows = ledger_rows(data, yq, internal)
    b = io.StringIO()
    w = csv.writer(b, lineterminator="\r\n")
    w.writerow(CSV_HEADERS + (CSV_EXTRA if internal else []))
    w.writerows(rows)
    return "\ufeff" + b.getvalue()
