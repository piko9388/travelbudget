# -*- coding: utf-8 -*-
"""라우트 — 12개. 관리자 행위는 서버측 검증(X-Admin-PW). PUT /api/data 없음."""
from __future__ import annotations
import uuid
from datetime import datetime
from functools import wraps
from urllib.parse import quote
import re
from pathlib import Path

from flask import Response, jsonify, render_template, request

from . import travelbudget
from . import core as C
from .store import (LOCK, append_audit, list_backups, load_data, restore_backup, save_data)


def _err(msgs, code=400):
    return jsonify({"ok": False, "errors": msgs if isinstance(msgs, list) else [msgs]}), code


_FONT_DIR = Path(__file__).resolve().parent / "static" / "fonts"


def _has_ui_font():
    """static/fonts/ 에 ui-400.woff2 · ui-700.woff2 가 둘 다 있으면 True."""
    return all((_FONT_DIR / f"ui-{w}.woff2").exists() for w in (400, 700))


def _is_admin(data):
    # admin_pw가 비어 있으면 모든 요청이 관리자가 되어버린다 → 빈 값이면 항상 거부(fail-closed)
    pw = str(data["settings"].get("admin_pw", "") or "")
    return bool(pw) and request.headers.get("X-Admin-PW", "") == pw


def admin_required(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        if not _is_admin(load_data()):
            return _err("관리자 인증이 필요합니다.", 401)
        return fn(*a, **kw)
    return wrap


DEFAULT_PW = "2071478"                   # 배포 기본값. 바꾸면 로그인 힌트도 자동으로 감춘다


def _public_settings(s):
    out = {k: v for k, v in s.items() if k not in ("admin_pw",)}
    # 비밀번호는 사내 공개 설계다. 기본값 그대로면 로그인 화면에 그대로 안내하고,
    # 바꿨으면 숫자를 노출하지 않는다(바뀐 뒤에도 옛 번호를 안내하면 거짓말이 된다).
    out["pw_default"] = str(s.get("admin_pw", "")) == DEFAULT_PW
    return out


_MAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")


def _norm(g, data):
    """표시·메일·CSV 용 정규화 — 팀 이름을 설정 기준으로 통일해서 내보낸다."""
    return C.normalize_group(g, by_nm=C.ccg_by_nm(data), by_cd=C.ccg_by_cd(data))


def _ccg_usage(data):
    """원장에 실제로 쓰인 CCG 코드별 인원 수와, 그중 현재 목록에 없는 코드.
    (조직 개편으로 목록을 갈아끼우면 옛 코드가 원장에 남는다 — 화면에서 보여야 옮길 수 있다)"""
    used, names = {}, {}
    for g in data.get("groups", []):
        for p in (g.get("travelers") or []):
            k = C._txt(p.get("ccg"))
            if not k:
                continue
            used[k] = used.get(k, 0) + 1
            names.setdefault(k, C._txt(p.get("ccg_nm")))
    known = {t["ccg"] for t in C.ccg_teams(data)}
    stale = [{"ccg": k, "name": names.get(k) or k, "n": n}
             for k, n in sorted(used.items(), key=lambda kv: -kv[1]) if k not in known]
    return used, stale


def _clean_settings(body, cur, data):
    """설정 저장값 검증 — 잘못된 값이 원장에 들어가면 화면 전체가 못 쓰게 된다."""
    e, out = [], {}

    # 안 보낸 항목은 '지우라'가 아니라 '그대로 두라'. 화면은 전부 보내지만,
    # 한 항목만 고치는 호출(스크립트·부분 저장)이 나머지를 날리면 안 된다.
    raw_m = body.get("mail_recipients") if "mail_recipients" in body else cur.get("mail_recipients")
    raw_m = raw_m if isinstance(raw_m, list) else []
    mails = [str(m).strip() for m in raw_m if isinstance(m, (str, int)) and str(m).strip()]
    if not mails:
        e.append("인폼 수신인을 1명 이상 입력하세요.")
    if len(mails) > 10:
        e.append("인폼 수신인은 10명까지입니다.")
    for m in mails:
        if not _MAIL_RE.match(m):
            e.append(f"메일 주소 형식이 올바르지 않습니다 — {m}")
    if len(set(mails)) != len(mails):
        e.append("같은 메일 주소가 중복입니다.")
    out["mail_recipients"] = mails[:10]

    raw_t = body.get("ccg_teams") if "ccg_teams" in body else C.ccg_teams(data)
    teams = raw_t if isinstance(raw_t, list) else []
    clean, codes, names = [], set(), set()
    for i, t in enumerate(teams, 1):
        if not isinstance(t, dict):
            e.append(f"{i}번 CCG 형식이 올바르지 않습니다.")
            continue
        nm, cd = C._txt(t.get("team")), C._txt(t.get("ccg"))
        if not nm or not cd:
            e.append(f"{i}번 CCG — 팀명과 코드를 모두 입력하세요.")
            continue
        if len(nm) > 40 or len(cd) > 20:
            e.append(f"{i}번 CCG — 팀명 40자·코드 20자를 넘습니다.")
            continue
        if cd in codes:
            e.append(f"CCG 코드가 중복입니다 — {cd}")
            continue
        if nm in names:
            e.append(f"CCG 팀명이 중복입니다 — {nm}")
            continue
        codes.add(cd); names.add(nm)
        clean.append({"team": nm, "ccg": cd})
    if not clean:
        e.append("CCG 팀을 1개 이상 남겨야 합니다.")
    if len(clean) > C.CCG_MAX:
        e.append(f"CCG 팀은 {C.CCG_MAX}개까지입니다.")
    # 이미 원장에 쓰인 팀을 지우면 과거 건의 소속이 미아가 된다 — 막는다
    used = {}
    for g in data.get("groups", []):
        for p in (g.get("travelers") or []):
            k = C._txt(p.get("ccg"))
            if k:
                used[k] = used.get(k, 0) + 1
    # 단, '지금 목록에 있던 것을 빼는' 경우만 막는다.
    # 조직 개편 직후에는 원장에만 있고 목록에는 없는 옛 코드가 있는데(→ 원장 CCG 정리에서 옮김),
    # 그것까지 여기서 걸면 메일 주소 한 줄 바꾸는 저장까지 통째로 거부된다.
    prev = {t["ccg"] for t in C.ccg_teams(data)}
    for cd, n in used.items():
        if cd not in codes and cd in prev:
            nm = next((C._txt(p.get("ccg_nm")) for g in data.get("groups", [])
                       for p in (g.get("travelers") or []) if C._txt(p.get("ccg")) == cd), cd)
            e.append(f"‘{nm}({cd})’ 은 이미 {n}건에 쓰이고 있어 지울 수 없습니다. "
                     f"이름만 바꾸거나 그대로 두세요.")
    out["ccg_teams"] = clean

    pw = C._txt(body.get("admin_pw")) or str(cur.get("admin_pw", ""))
    if len(pw) < 4 or " " in pw:
        e.append("비밀번호는 공백 없이 4자 이상이어야 합니다.")
    out["admin_pw"] = pw

    nm = C._txt(body.get("system_name")) or cur.get("system_name", "")
    if len(nm) > 60:
        e.append("시스템 이름은 60자까지입니다.")
    out["system_name"] = nm[:60]
    out["reference_url"] = (C._txt(body.get("reference_url"))
                            if "reference_url" in body else cur.get("reference_url", ""))[:200]
    return e, out


_DIFF_LABELS = (("plan_type", "구분"), ("city", "출장도시"), ("org", "기관&업체"),
                ("purpose", "목적"), ("kind", "출장구분"), ("dep_dt", "출발일"),
                ("ret_dt", "복귀일"), ("car", "자차"), ("remark", "비고"))


def _diff_fields(old, new):
    """수정 전후 달라진 항목만 요약 — 감사 로그에 '무엇이 바뀌었는지' 남긴다."""
    out = []
    for k, label in _DIFF_LABELS:
        a, b = old.get(k, ""), new.get(k, "")
        if a != b:
            out.append(f"{label}: {a or '(없음)'}→{b or '(없음)'}")
    if old.get("plan_tot") != new.get("plan_tot"):
        out.append(f"계획액: {old.get('plan_tot', 0):,}→{new.get('plan_tot', 0):,}")
    on = [p.get("emp_no") for p in old.get("travelers", [])]
    nn = [p.get("emp_no") for p in new.get("travelers", [])]
    if on != nn:
        out.append(f"출장자: {len(on)}명→{len(nn)}명")
    return " / ".join(out)


def _qint(key, default, lo=1, hi=500):
    """쿼리 파라미터 정수 — 잘못된 값이면 500 대신 기본값. (?n=abc 로 서버가 죽던 것)"""
    try:
        return max(lo, min(int(str(request.args.get(key, default)).strip() or default), hi))
    except (ValueError, TypeError):
        return default


def _body():
    """요청 본문 — 반드시 dict. JSON API라 123·[]·null 같은 본문도 들어오므로 여기서 고정한다."""
    b = request.get_json(silent=True)
    return b if isinstance(b, dict) else {}


def _tlist(v):
    """요청 본문의 travelers를 안전한 dict 리스트로 — 형식 오류는 500이 아니라 검증 400으로."""
    return [p for p in v if isinstance(p, dict)] if isinstance(v, list) else []


def _find(data, gid):
    return next((g for g in data["groups"] if g.get("group_id") == gid), None)


# ── 화면 ──────────────────────────────────────────────────
@travelbudget.get("/")
def index():
    # 글꼴 파일이 실제로 있을 때만 @font-face 를 내보낸다.
    # 없는데 선언하면 매 로드마다 404 가 찍혀 서버 로그와 콘솔이 지저분해진다.
    return render_template("index.html", ui_font=_has_ui_font())


# ── 일괄 등록용 엑셀 양식 내려받기 (센터 27필드 순서) ──
@travelbudget.get("/api/bulk_template.xls")
def bulk_template():
    html = C.bulk_template_xls()
    fn = "출장비_일괄등록_양식.xls"
    return Response(html.encode("utf-8-sig"), mimetype="application/vnd.ms-excel",
                    headers={"Content-Disposition":
                             "attachment; filename=bulk_template.xls; "
                             f"filename*=UTF-8''{quote(fn, safe='')}"})


# ── 출장자용 인쇄 가능 안내 (독립 HTML — 메일 첨부·사내 게시용) ──
@travelbudget.get("/guide")
def traveler_guide():
    return render_template("traveler_guide.html")


@travelbudget.get("/favicon.ico")
def favicon():
    return ("", 204)


# ── 조회 (SSOT: 서버 계산) ────────────────────────────────
@travelbudget.get("/api/state")
def api_state():
    data = load_data()
    yq = request.args.get("yq") or C.year_quarter()
    _bc = C.ccg_by_cd(data)                  # 표시용 팀 이름은 설정 기준으로 통일
    groups = [C.normalize_group(g, by_cd=_bc) for g in data["groups"]]
    groups.sort(key=lambda g: g.get("dep_dt") or "", reverse=True)
    return jsonify({
        "yq": yq,
        "yqList": C.yq_list(),
        "settings": _public_settings(data["settings"]),
        "ccg": C.ccg_teams(data),
        "dash": C.dash(data, yq),
        "groups": groups,
        "budget": sorted([b for b in data["budget"] if b.get("yq") == yq],
                         key=lambda b: b.get("rev_dt") or ""),
        "version": {"v": C.APP_VERSION, "build": C.APP_BUILD},
        "meta": {"planTypes": C.PLAN_TYPES, "ranks": C.RANKS, "kinds": C.KINDS,
                 "cars": C.CARS, "revTypes": C.REV_TYPES, "statuses": C.STATUSES,
                 "cost": [{"k": k, "label": l} for k, l in C.COST]},
    })


# ── 출장 계획 등록 (그룹, 동행 포함) ──────────────────────
@travelbudget.post("/api/groups")
def create_group():
    with LOCK:
        data = load_data()
        payload = _body()
        payload["group_id"] = f"TB-{uuid.uuid4().hex[:8].upper()}"
        payload["status"] = C.ST_CONFIRM if payload.get("confirmed") else C.ST_PLAN
        payload["created_at"] = datetime.now().isoformat(timespec="seconds")
        for p in _tlist(payload.get("travelers")):   # 개인 처리 상태 주입 금지 (신규는 항상 빈 값)
            p.pop("status", None)
        g = C.normalize_group(payload, by_nm=C.ccg_by_nm(data))
        errors = C.validate_group(g, by_nm=C.ccg_by_nm(data))
        if errors:
            return _err(errors)
        data["groups"].append(g)
        append_audit(data, "출장 계획 등록", f"{g['group_id']} {g.get('org','')} {len(g['travelers'])}명")
        save_data(data)
    return jsonify({"ok": True, "group": g}), 201


@travelbudget.put("/api/groups/<gid>")
def update_group(gid):
    with LOCK:
        data = load_data()
        cur = _find(data, gid)
        if cur is None:
            return _err("출장건을 찾을 수 없습니다.", 404)
        # 예산 담당자 영역(이관·완료·보류·취소)은 관리자만 수정 — 정산 금액 사후 변조 차단
        # 실적이 들어간 뒤(=계획 단계를 벗어난 뒤)의 수정은 예산 담당자만.
        # 계획·확정 단계는 출장자가 자유롭게 고칠 수 있다.
        if (C.locked(cur) or cur.get("status") not in C.PRE) and not _is_admin(data):
            return _err("실적이 입력된 건은 예산 담당자 모드에서만 수정할 수 있습니다.", 401)
        # 상태는 현재 값으로 고정 — 상태 전환은 오직 게이트가 있는 /actual·/status 로만.
        # (이 라우트로 status·실적을 밀어넣어 승인 게이트를 우회하고 예산을 움직이는 경로 차단)
        merged = {**cur, **(_body()),
                  "group_id": gid, "status": cur.get("status") or C.ST_PLAN}
        # 개인 처리 상태와 **실적 금액**은 기존 값을 사번 기준으로 이식하고 요청 값은 폐기.
        # (계획 수정 화면은 계획액만 보내므로, 그대로 두면 이미 입력된 실적이 0 으로 지워진다)
        old = {str(p.get("emp_no")): p for p in cur.get("travelers", [])}
        for p in _tlist(merged.get("travelers")):
            src = old.get(str(p.get("emp_no")), {})
            p["status"] = src.get("status", "")
            for k in C.KEYS:
                p[f"a_{k}"] = C.num(src.get(f"a_{k}"))
        g = C.normalize_group(merged, by_nm=C.ccg_by_nm(data))
        errors = C.validate_group(g, require_actual=g["status"] in C.WIP, by_nm=C.ccg_by_nm(data))
        if errors:
            return _err(errors)
        g["updated_at"] = datetime.now().isoformat(timespec="seconds")
        changed = _diff_fields(_norm(cur, data), g)
        data["groups"][data["groups"].index(cur)] = g
        append_audit(data, "출장 수정",
                     f"{gid} {g.get('org','')} — {changed or '변경 없음'}",
                     actor="admin" if _is_admin(data) else "user")
        save_data(data)
    return jsonify({"ok": True, "group": g})


# ── 실적 입력 → 인폼 (상태 자동 전환) ─────────────────────
@travelbudget.post("/api/groups/<gid>/actual")
def input_actual(gid):
    with LOCK:
        data = load_data()
        cur = _find(data, gid)
        if cur is None:
            return _err("출장건을 찾을 수 없습니다.", 404)
        if cur.get("status") in (C.ST_DONE, C.ST_CANCEL):
            return _err("완료·취소된 건에는 실적을 입력할 수 없습니다.")
        # 이관·완료·보류된 인원이 있으면 실적 재입력은 관리자만 (정산 금액 사후 변조 차단)
        if C.locked(cur) and not _is_admin(data):
            return _err("이관·처리가 시작된 건의 실적은 관리자만 수정할 수 있습니다.", 401)
        body = _body()
        g = _norm(cur, data)
        by_emp = {str(p.get("emp_no")): p for p in _tlist(body.get("travelers"))}
        for p in g["travelers"]:
            src = by_emp.get(str(p.get("emp_no")))
            if src:
                for k in C.KEYS:
                    if f"a_{k}" in src:
                        p[f"a_{k}"] = C.num(src[f"a_{k}"])
        if "remark" in body:
            g["remark"] = str(body.get("remark") or "").strip()
        g["status"] = C.ST_INFORM
        errors = C.validate_group(g, require_actual=True, by_nm=C.ccg_by_nm(data))
        if errors:
            return _err(errors)
        g = _norm(g, data)
        g["inform_at"] = datetime.now().isoformat(timespec="seconds")
        g["updated_at"] = g["inform_at"]
        data["groups"][data["groups"].index(cur)] = g
        append_audit(data, "실적 입력·인폼", f"{gid} 실적 {g['act_tot']:,}원")
        save_data(data)
        mail = C.make_mail(g, data["settings"])
        dash = C.dash(data, g["yq"])
    return jsonify({"ok": True, "group": g, "mail": mail, "dash": dash})


# ── 상태 전환 (이관·처리 — 관리자) / 취소 ─────────────────
@travelbudget.post("/api/groups/<gid>/status")
def change_status(gid):
    with LOCK:
        data = load_data()
        cur = _find(data, gid)
        if cur is None:
            return _err("출장건을 찾을 수 없습니다.", 404)
        body = _body()
        want = body.get("status", "")
        emp = body.get("emp_no")
        admin = _is_admin(data)
        now = datetime.now().isoformat(timespec="seconds")

        # ── 개인별 처리 (5명 중 일부만 이관/완료/보류) ──
        if emp not in (None, ""):
            if want not in C.PSTATES:
                return _err("개인 처리 상태 값이 올바르지 않습니다.")
            if cur.get("status") in (C.ST_PLAN, C.ST_CANCEL):
                return _err("실적 입력 후 개인별 처리가 가능합니다.")
            if not admin:                # 이관·완료·보류·되돌림 모두 관리자
                return _err("관리자 인증이 필요합니다.", 401)
            g = _norm(cur, data)
            tgt = next((p for p in g["travelers"] if str(p.get("emp_no")) == str(emp)), None)
            if tgt is None:
                return _err("출장자를 찾을 수 없습니다.", 404)
            if want in (C.ST_TRANSFER, C.ST_DONE) and C.p_sum(tgt, "a") <= 0:
                return _err("실적이 입력된 출장자만 이관·처리할 수 있습니다.")
            # 개인 상태를 명시화(상속 해제) 후 대상만 변경 → 그룹 상태는 롤업
            for p in g["travelers"]:
                if not p.get("status"):
                    p["status"] = C.eff_status(p, cur)
            tgt["status"] = want
            g["status"] = C.group_roll(g)
            g["updated_at"] = now
            data["groups"][data["groups"].index(cur)] = g
            append_audit(data, "개인 처리 변경", f"{gid} {emp} → {want}", actor="admin")
            save_data(data)
            g = _norm(g, data)
            dash = C.dash(data, g["yq"])
            resp = {"ok": True, "group": g, "dash": dash}
            if want == C.ST_TRANSFER:     # 이관 → 비용 처리 요청 인폼
                resp["mail"] = C.make_transfer_mail(g, data["settings"], emps=[emp])
            return jsonify(resp)

        # ── 그룹 전체 전환 ──
        if want not in (C.ST_PLAN, C.ST_CONFIRM, C.ST_INFORM, C.ST_TRANSFER, C.ST_DONE, C.ST_CANCEL):
            return _err("상태 값이 올바르지 않습니다.")
        # 출장 확정 = 계획 금액 예산 선확보 (계획 단계 토글, 공개)
        if want == C.ST_CONFIRM:
            if cur.get("status") not in C.PRE:
                return _err("계획 단계에서만 출장 확정을 할 수 있습니다.")
            if cur.get("plan_type") != "긴급" and C.g_sum(_norm(cur, data), "p") <= 0:
                return _err("계획 비용이 있어야 예산을 확보(확정)할 수 있습니다.")
        if want == C.ST_PLAN and cur.get("status") not in C.PRE:
            return _err("확정 예정 건만 잠정 계획으로 되돌릴 수 있습니다.")
        # 관리자 통제 상태로 들어가거나, 이미 예산 담당자 영역인 건(부분 완료 포함)의
        # 어떤 전환이든 관리자 인증 필요.
        # 취소는 따로 본다 — 실적이 들어간 건(실적 입력·인폼)은 travelers 에 개인 처리 상태가
        # 아직 없어서 locked() 가 False 다. 그 틈으로 무인증 취소가 통과해 정산금이
        # 처리 중 집계에서 통째로 빠지고 가용 잔여가 늘어난 것처럼 보였다.
        # 계획 등록·확정 예정(PRE) 단계의 취소는 출장자 본인이 하는 정상 동작이라 공개로 둔다.
        if (want in (C.ST_TRANSFER, C.ST_DONE) or C.locked(cur)
                or (want == C.ST_CANCEL and cur.get("status") not in C.PRE)) and not admin:
            return _err("관리자 인증이 필요합니다.", 401)
        # 이관·완료·인폼(되돌림 포함) 상태는 실적이 있어야만.
        if want in (C.ST_INFORM, C.ST_TRANSFER, C.ST_DONE) and C.g_sum(_norm(cur, data), "a") <= 0:
            return _err("실적이 입력된 건만 이관·처리할 수 있습니다.")
        held = 0
        if want in (C.ST_INFORM, C.ST_TRANSFER, C.ST_DONE):
            # 전체 전환은 개인 상태도 함께 맞춤. 단 '보류'는 유지 —
            # 예산 부족 등으로 막아둔 인원이 일괄 처리에 휩쓸려 정산 완료로 둔갑하지 않도록.
            for p in cur.get("travelers", []):
                if C.eff_status(p, cur) == C.ST_HOLD:
                    p["status"] = C.ST_HOLD
                    held += 1
                else:
                    p["status"] = want
            cur["status"] = want
            cur["status"] = C.group_roll(cur)      # 보류가 남으면 그룹은 완료로 올리지 않음
        else:
            cur["status"] = want
            if want in C.PRE:             # 계획/확정 단계로 (되)돌아가면 개인 처리상태 초기화
                for p in cur.get("travelers", []):
                    p.pop("status", None)
        cur["updated_at"] = now
        if want == C.ST_DONE:
            cur["settle_at"] = cur["updated_at"]
        append_audit(data, "상태 변경", f"{gid} → {want}", actor="admin" if admin else "user")
        save_data(data)
        g = _norm(cur, data)
        dash = C.dash(data, g["yq"])
        mail = C.make_transfer_mail(g, data["settings"]) if want == C.ST_TRANSFER else None
    return jsonify({"ok": True, "group": g, "dash": dash, "mail": mail, "held": held})


# ── 실비 이관 요청 인폼 다시 보기 (카드를 닫아도 언제든 재발행) ──
@travelbudget.get("/api/groups/<gid>/mail")
def group_mail(gid):
    data = load_data()
    cur = _find(data, gid)
    if cur is None:
        return _err("출장건을 찾을 수 없습니다.", 404)
    g = _norm(cur, data)
    if C.g_sum(g, "a") <= 0:
        return _err("실적이 입력되지 않아 인폼을 만들 수 없습니다.", 400)
    return jsonify({"ok": True, "mail": C.make_mail(g, data["settings"])})


# ── 이관 인폼 다시 보기 (현재 '소재 이관' 상태 출장자 대상) ──
@travelbudget.get("/api/groups/<gid>/transfer_mail")
def transfer_mail(gid):
    data = load_data()
    cur = _find(data, gid)
    if cur is None:
        return _err("출장건을 찾을 수 없습니다.", 404)
    g = _norm(cur, data)
    emps = [p.get("emp_no") for p in g["travelers"] if C.eff_status(p, g) == C.ST_TRANSFER]
    if not emps:
        return _err("이관 상태의 출장자가 없습니다.", 404)
    return jsonify({"ok": True, "mail": C.make_transfer_mail(g, data["settings"], emps=emps)})


# ── 잠정 계획 삭제 (계획 등록만 — 흔적 없이 제거, 확정 이후는 취소) ──
@travelbudget.delete("/api/groups/<gid>")
def delete_group(gid):
    with LOCK:
        data = load_data()
        cur = _find(data, gid)
        if cur is None:
            return _err("출장건을 찾을 수 없습니다.", 404)
        if cur.get("status") != C.ST_PLAN:
            return _err("잠정 계획(계획 등록) 건만 삭제할 수 있습니다. 확정·진행 건은 취소를 쓰세요.")
        yq = _norm(cur, data)["yq"]
        data["groups"] = [x for x in data["groups"] if x.get("group_id") != gid]
        # 삭제 내용을 감사로그에 남겨 사후 추적·복원 근거를 남긴다
        who = ", ".join(str(p.get("name", "")) for p in cur.get("travelers", []))
        append_audit(data, "잠정 계획 삭제",
                     f"{gid} {cur.get('city','')} {cur.get('org','')} · {who} · "
                     f"계획 {C.g_sum(_norm(cur, data), 'p'):,}원",
                     actor="admin" if _is_admin(data) else "user")
        save_data(data)
        dash = C.dash(data, yq)
    return jsonify({"ok": True, "dash": dash})


# ── SAP 전표번호 기록 (소재팀 비용 처리 근거 — 관리자) ────
@travelbudget.post("/api/groups/<gid>/sap")
@admin_required
def set_sap(gid):
    with LOCK:
        data = load_data()
        cur = _find(data, gid)
        if cur is None:
            return _err("출장건을 찾을 수 없습니다.", 404)
        doc = str((_body()).get("sap_doc", "")).strip()
        cur["sap_doc"] = doc
        cur["updated_at"] = datetime.now().isoformat(timespec="seconds")
        append_audit(data, "SAP 전표번호", f"{gid} → {doc or '(삭제)'}", actor="admin")
        save_data(data)
        g = _norm(cur, data)
    return jsonify({"ok": True, "group": g})


# ── 여러 건 한꺼번에 확정 (엑셀로 20건 넣고 하나씩 누르던 것) ──
# 단건 라우트를 20번 부르면 저장·백업도 20번이다. 한 번의 락 안에서 처리하고 한 번만 저장한다.
# 허용 전환은 '계획 등록 → 확정 예정' 하나뿐 — 금액이 나가는 전환은 일괄로 열지 않는다.
@travelbudget.post("/api/groups/bulk_status")
def bulk_status():
    b = _body()
    want = C._txt(b.get("status"))
    gids = [C._txt(x) for x in (b.get("group_ids") or []) if C._txt(x)]
    if want != C.ST_CONFIRM:
        return _err("일괄로는 출장 확정만 할 수 있습니다.")
    if not gids:
        return _err("확정할 출장을 하나 이상 고르세요.")
    if len(gids) > 200:
        return _err("한 번에 200건까지입니다.")
    done, failed = [], []
    with LOCK:
        data = load_data()
        now = datetime.now().isoformat(timespec="seconds")
        seen = set()
        for gid in gids:
            if gid in seen:
                continue
            seen.add(gid)
            cur = _find(data, gid)
            if cur is None:
                failed.append({"gid": gid, "name": gid, "reason": "출장을 찾을 수 없습니다."})
                continue
            label = " ".join(filter(None, [cur.get("city"), cur.get("org")])) or gid
            if cur.get("status") != C.ST_PLAN:
                failed.append({"gid": gid, "name": label,
                               "reason": f"계획(잠정) 단계가 아닙니다 — 현재 {cur.get('status')}"})
                continue
            if cur.get("plan_type") != "긴급" and C.g_sum(_norm(cur, data), "p") <= 0:
                failed.append({"gid": gid, "name": label,
                               "reason": "계획 비용이 없어 예산을 확보할 수 없습니다."})
                continue
            cur["status"] = C.ST_CONFIRM
            cur["updated_at"] = now
            done.append({"gid": gid, "name": label})
        if done:
            append_audit(data, "일괄 출장 확정",
                         f"{len(done)}건 — " + ", ".join(d["name"] for d in done[:5])
                         + (" 외" if len(done) > 5 else ""),
                         actor="admin" if _is_admin(data) else "user")
            save_data(data)                      # 저장·백업은 한 번만
        dash = C.dash(data, C.year_quarter())
    return jsonify({"ok": True, "done": done, "failed": failed, "dash": dash})


# ── 대시보드 안내 문구 (관리자) ───────────────────────────
# ── 시스템 설정 (관리자) ────────────────────────────────
@travelbudget.get("/api/settings")
@admin_required
def get_settings():
    data = load_data()
    # 어느 팀이 몇 건에 쓰이는지 함께 준다 — 지우기 전에 화면에서 보여야 한다
    used, stale = _ccg_usage(data)
    s = data["settings"]
    return jsonify({"ok": True, "settings": {
        "system_name": s.get("system_name", ""),
        "reference_url": s.get("reference_url", ""),
        "admin_pw": s.get("admin_pw", ""),
        "mail_recipients": list(s.get("mail_recipients") or []),
        "ccg_teams": C.ccg_teams(data),
        "ccg_from_settings": isinstance(s.get("ccg_teams"), list),
    }, "ccgUsed": used, "ccgStale": stale})


# ── 원장의 옛 CCG 코드를 새 팀으로 옮기기 (관리자) ──────────
# 조직은 연 단위로 바뀐다. 목록만 갈아끼우면 원장의 옛 코드가 미아가 되고,
# 그 코드는 '사용 중'이라 목록에서 지울 수도 없다 — 그래서 옮기는 길을 연다.
@travelbudget.post("/api/ccg_migrate")
@admin_required
def ccg_migrate():
    b = _body()
    src, dst = C._txt(b.get("from")), C._txt(b.get("to"))
    with LOCK:
        data = load_data()
        codes = {t["ccg"]: t["team"] for t in C.ccg_teams(data)}
        if not src or not dst:
            return _err("옮길 CCG 코드와 대상 팀을 모두 고르세요.")
        if dst not in codes:
            return _err(f"대상 팀({dst})이 CCG 목록에 없습니다. 먼저 목록에 추가하세요.")
        if src == dst:
            return _err("같은 코드로는 옮길 수 없습니다.")
        moved, groups = 0, 0
        for g in data.get("groups", []):
            hit = False
            for p in (g.get("travelers") or []):
                if C._txt(p.get("ccg")) == src:
                    p["ccg"] = dst
                    p["ccg_nm"] = codes[dst]      # 이름은 대상 팀 이름으로
                    moved += 1
                    hit = True
            if hit:
                groups += 1
        if not moved:
            return _err(f"원장에서 {src} 를 쓰는 출장자를 찾지 못했습니다.")
        append_audit(data, "CCG 코드 이동",
                     f"{src} → {dst}({codes[dst]}) · 출장자 {moved}명 · 출장 {groups}건",
                     actor="admin")
        save_data(data)                            # 저장 직전 자동 백업 (되돌릴 수 있음)
        used, stale = _ccg_usage(data)
    return jsonify({"ok": True, "moved": moved, "groups": groups,
                    "ccgUsed": used, "ccgStale": stale})


@travelbudget.post("/api/settings")
@admin_required
def set_settings():
    b = _body()
    with LOCK:
        data = load_data()
        errs, clean = _clean_settings(b, data["settings"], data)
        if errs:
            return _err(errs)
        before = dict(data["settings"])
        data["settings"].update(clean)
        chg = [k for k in clean if before.get(k) != clean[k]]
        append_audit(data, "시스템 설정 변경",
                     ", ".join(chg) or "변경 없음", actor="admin")
        save_data(data)
        return jsonify({"ok": True, "settings": _public_settings(data["settings"]),
                        "changed": chg, "ccg": C.ccg_teams(data)})


@travelbudget.post("/api/notice")
@admin_required
def set_notice():
    with LOCK:
        data = load_data()
        b = _body()
        data["settings"]["notice"] = str(b.get("notice", ""))[:500].strip()
        data["settings"]["notice_sub"] = str(b.get("notice_sub", ""))[:300].strip()
        append_audit(data, "안내 문구 변경", data["settings"]["notice"][:60], actor="admin")
        save_data(data)
        st = _public_settings(data["settings"])
    return jsonify({"ok": True, "settings": st})


# ── 센터 제출 리포트 / 감사 로그 ──────────────────────────
@travelbudget.get("/api/report")
def center_report():
    data = load_data()
    yq = request.args.get("yq") or C.year_quarter()
    return jsonify({"ok": True, "report": C.center_report(data, yq)})


@travelbudget.get("/api/audit")
def audit_log():
    data = load_data()
    n = _qint("n", 200, lo=1, hi=500)
    return jsonify({"ok": True, "audit": list(reversed(data.get("audit_log", [])))[:n]})


# ── 예산 (관리자, 검증 + 감액 자동 음수) ──────────────────
@travelbudget.post("/api/budget")
@admin_required
def add_budget():
    b = _body()
    errors = C.validate_budget(b)
    if errors:
        return _err(errors)
    b = C.fix_budget_sign(b)
    rec = {"rev_id": f"B-{uuid.uuid4().hex[:8].upper()}",
           "yq": str(b["yq"]).strip(), "rev_dt": b.get("rev_dt") or datetime.now().strftime("%Y-%m-%d"),
           "rev_type": b["rev_type"], "amt": b["amt"],
           "reason": str(b.get("reason") or "").strip()}
    with LOCK:
        data = load_data()
        data["budget"].append(rec)
        append_audit(data, "예산 이력 추가", f"{rec['rev_id']} {rec['rev_type']} {rec['amt']:,}", actor="admin")
        save_data(data)
        dash = C.dash(data, rec["yq"])
    return jsonify({"ok": True, "budget": rec, "dash": dash}), 201


@travelbudget.delete("/api/budget/<rev_id>")
@admin_required
def del_budget(rev_id):
    with LOCK:
        data = load_data()
        before = len(data["budget"])
        data["budget"] = [b for b in data["budget"] if b.get("rev_id") != rev_id]
        if len(data["budget"]) == before:
            return _err("리비전을 찾을 수 없습니다.", 404)
        append_audit(data, "예산 이력 삭제", rev_id, actor="admin")
        save_data(data)
    return jsonify({"ok": True})


# ── 관리자 확인 ───────────────────────────────────────────
@travelbudget.post("/api/admin/verify")
def admin_verify():
    data = load_data()
    pw = str((_body()).get("pw", ""))
    return (jsonify({"ok": True}) if pw == str(data["settings"].get("admin_pw", ""))
            else _err("아이디 또는 비밀번호가 올바르지 않습니다.", 401))


# ── CSV / 백업 ────────────────────────────────────────────
# 화면에서 걸러 놓은 건만 내보낼 때 쓰는 목록. 주소줄 길이를 생각해 상한을 둔다
# (넘치면 조용히 자르지 않고 전체로 되돌린다 — 일부만 빠진 제출본이 더 위험하다).
GIDS_MAX = 800


def _gids_arg():
    """?gids=TB-0001,TB-0002 → ['TB-0001', ...]  (없으면 None = 전체)"""
    raw = (request.args.get("gids") or "").strip()
    if not raw:
        return None, ""
    ids = [x.strip() for x in raw.split(",") if x.strip()]
    if not ids or len(ids) > GIDS_MAX:
        return None, ""
    return ids, f"_선택{len(set(ids))}건"


@travelbudget.get("/api/export.csv")
def export_csv():
    yq = request.args.get("yq") or None
    internal = request.args.get("mode") == "internal"
    gids, tag = _gids_arg()
    content = C.make_csv(load_data(), yq, internal, gids)
    kind = "내부관리" if internal else "센터제출"
    fn = f"소재국내출장비_{kind}_{yq or '전체'}{tag}_{datetime.now().strftime('%Y%m%d')}.csv"
    # RFC 5987: 헤더는 latin-1만 허용 — 한글 파일명을 percent-encoding 해야 실서버에서 안 죽는다.
    return Response(content, mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition":
                             "attachment; filename=travelbudget.csv; "
                             f"filename*=UTF-8''{quote(fn, safe='')}"})


@travelbudget.get("/api/export.xls")
def export_xls():
    """엑셀 서식(맑은 고딕/Trebuchet MS) 포함 제출본."""
    yq = request.args.get("yq") or None
    internal = request.args.get("mode") == "internal"
    gids, tag = _gids_arg()
    content = C.make_xls(load_data(), yq, internal, gids)
    kind = "내부관리" if internal else "센터제출"
    fn = f"소재국내출장비_{kind}_{yq or '전체'}{tag}_{datetime.now().strftime('%Y%m%d')}.xls"
    return Response(content, mimetype="application/vnd.ms-excel; charset=utf-8",
                    headers={"Content-Disposition":
                             "attachment; filename=travelbudget.xls; "
                             f"filename*=UTF-8''{quote(fn, safe='')}"})


@travelbudget.get("/api/export_budget.csv")
def export_budget_csv():
    yq = request.args.get("yq") or None
    content = C.make_budget_csv(load_data(), yq)
    fn = f"예산리비전_{yq or '전체'}_{datetime.now().strftime('%Y%m%d')}.csv"
    return Response(content, mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition":
                             "attachment; filename=budget_revisions.csv; "
                             f"filename*=UTF-8''{quote(fn, safe='')}"})


@travelbudget.get("/api/backups")
def backups():
    return jsonify({"ok": True, "backups": list_backups()})


@travelbudget.post("/api/backups/<filename>/restore")
@admin_required
def restore(filename):
    with LOCK:
        cur_audit = list(load_data().get("audit_log", []))   # 복원해도 감사 이력은 이어감
        cur_audit.append({"timestamp": datetime.now().isoformat(timespec="seconds"),
                          "actor": "admin", "action": "백업 복원", "detail": filename})
        try:
            restore_backup(filename, audit_log=cur_audit[-500:])
        except (FileNotFoundError, ValueError) as exc:
            return _err(str(exc))
    return jsonify({"ok": True})
