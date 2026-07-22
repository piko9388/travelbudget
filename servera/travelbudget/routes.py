# -*- coding: utf-8 -*-
"""라우트 — 12개. 관리자 행위는 서버측 검증(X-Admin-PW). PUT /api/data 없음."""
from __future__ import annotations
import uuid
from datetime import datetime
from functools import wraps
from flask import Response, jsonify, render_template, request

from . import travelbudget
from . import core as C
from .store import (append_audit, list_backups, load_data, restore_backup, save_data)


def _err(msgs, code=400):
    return jsonify({"ok": False, "errors": msgs if isinstance(msgs, list) else [msgs]}), code


def _is_admin(data):
    return request.headers.get("X-Admin-PW", "") == str(data["settings"].get("admin_pw", ""))


def admin_required(fn):
    @wraps(fn)
    def wrap(*a, **kw):
        if not _is_admin(load_data()):
            return _err("관리자 인증이 필요합니다.", 401)
        return fn(*a, **kw)
    return wrap


def _public_settings(s):
    return {k: v for k, v in s.items() if k not in ("admin_pw",)}


def _find(data, gid):
    return next((g for g in data["groups"] if g.get("group_id") == gid), None)


# ── 화면 ──────────────────────────────────────────────────
@travelbudget.get("/")
def index():
    return render_template("index.html")


@travelbudget.get("/favicon.ico")
def favicon():
    return ("", 204)


# ── 조회 (SSOT: 서버 계산) ────────────────────────────────
@travelbudget.get("/api/state")
def api_state():
    data = load_data()
    yq = request.args.get("yq") or data["settings"].get("active_yq") or C.year_quarter()
    groups = [C.normalize_group(g) for g in data["groups"]]
    groups.sort(key=lambda g: g.get("dep_dt") or "", reverse=True)
    return jsonify({
        "yq": yq,
        "yqList": C.yq_list(),
        "settings": _public_settings(data["settings"]),
        "ccg": data.get("ccg", C.CCG_TEAMS),
        "dash": C.dash(data, yq),
        "groups": groups,
        "budget": sorted([b for b in data["budget"] if b.get("yq") == yq],
                         key=lambda b: b.get("rev_dt") or ""),
        "meta": {"planTypes": C.PLAN_TYPES, "ranks": C.RANKS, "kinds": C.KINDS,
                 "cars": C.CARS, "revTypes": C.REV_TYPES, "statuses": C.STATUSES,
                 "cost": [{"k": k, "label": l} for k, l in C.COST]},
    })


# ── 출장 계획 등록 (그룹, 동행 포함) ──────────────────────
@travelbudget.post("/api/groups")
def create_group():
    data = load_data()
    payload = request.get_json(silent=True) or {}
    payload["group_id"] = f"TB-{uuid.uuid4().hex[:8].upper()}"
    payload["status"] = C.ST_PLAN
    payload["created_at"] = datetime.now().isoformat(timespec="seconds")
    g = C.normalize_group(payload)
    errors = C.validate_group(g)
    if errors:
        return _err(errors)
    data["groups"].append(g)
    append_audit(data, "출장 계획 등록", f"{g['group_id']} {g.get('org','')} {len(g['travelers'])}명")
    save_data(data)
    return jsonify({"ok": True, "group": g}), 201


@travelbudget.put("/api/groups/<gid>")
def update_group(gid):
    data = load_data()
    cur = _find(data, gid)
    if cur is None:
        return _err("출장건을 찾을 수 없습니다.", 404)
    if cur.get("status") in (C.ST_DONE,):
        return _err("처리 완료된 건은 수정할 수 없습니다.")
    merged = {**cur, **(request.get_json(silent=True) or {}), "group_id": gid}
    g = C.normalize_group(merged)
    errors = C.validate_group(g, require_actual=g["status"] in C.WIP)
    if errors:
        return _err(errors)
    g["updated_at"] = datetime.now().isoformat(timespec="seconds")
    data["groups"][data["groups"].index(cur)] = g
    append_audit(data, "출장 수정", gid)
    save_data(data)
    return jsonify({"ok": True, "group": g})


# ── 실적 입력 → 인폼 (상태 자동 전환) ─────────────────────
@travelbudget.post("/api/groups/<gid>/actual")
def input_actual(gid):
    data = load_data()
    cur = _find(data, gid)
    if cur is None:
        return _err("출장건을 찾을 수 없습니다.", 404)
    if cur.get("status") in (C.ST_DONE, C.ST_CANCEL):
        return _err("완료·취소된 건에는 실적을 입력할 수 없습니다.")
    body = request.get_json(silent=True) or {}
    g = C.normalize_group(cur)
    by_emp = {str(p.get("emp_no")): p for p in body.get("travelers", [])}
    for p in g["travelers"]:
        src = by_emp.get(str(p.get("emp_no")))
        if src:
            for k in C.KEYS:
                if f"a_{k}" in src:
                    p[f"a_{k}"] = C.num(src[f"a_{k}"])
    if "remark" in body:
        g["remark"] = str(body.get("remark") or "").strip()
    g["status"] = C.ST_INFORM
    errors = C.validate_group(g, require_actual=True)
    if errors:
        return _err(errors)
    g = C.normalize_group(g)
    g["inform_at"] = datetime.now().isoformat(timespec="seconds")
    g["updated_at"] = g["inform_at"]
    data["groups"][data["groups"].index(cur)] = g
    append_audit(data, "실적 입력·인폼", f"{gid} 실적 {g['act_tot']:,}원")
    save_data(data)
    return jsonify({"ok": True, "group": g,
                    "mail": C.make_mail(g, data["settings"]),
                    "dash": C.dash(data, g["yq"])})


# ── 상태 전환 (이관·처리 — 관리자) / 취소 ─────────────────
@travelbudget.post("/api/groups/<gid>/status")
def change_status(gid):
    data = load_data()
    cur = _find(data, gid)
    if cur is None:
        return _err("출장건을 찾을 수 없습니다.", 404)
    want = (request.get_json(silent=True) or {}).get("status", "")
    if want not in C.STATUSES:
        return _err("상태 값이 올바르지 않습니다.")
    if want in (C.ST_TRANSFER, C.ST_DONE) and not _is_admin(data):
        return _err("관리자 인증이 필요합니다.", 401)
    if want in (C.ST_TRANSFER, C.ST_DONE) and C.g_sum(C.normalize_group(cur), "a") <= 0:
        return _err("실적이 입력된 건만 이관·처리할 수 있습니다.")
    cur["status"] = want
    cur["updated_at"] = datetime.now().isoformat(timespec="seconds")
    if want == C.ST_DONE:
        cur["settle_at"] = cur["updated_at"]
    append_audit(data, "상태 변경", f"{gid} → {want}",
                 actor="admin" if _is_admin(data) else "user")
    save_data(data)
    return jsonify({"ok": True, "group": C.normalize_group(cur),
                    "dash": C.dash(data, C.normalize_group(cur)["yq"])})


# ── 예산 (관리자, 검증 + 감액 자동 음수) ──────────────────
@travelbudget.post("/api/budget")
@admin_required
def add_budget():
    data = load_data()
    b = request.get_json(silent=True) or {}
    errors = C.validate_budget(b)
    if errors:
        return _err(errors)
    b = C.fix_budget_sign(b)
    rec = {"rev_id": f"B-{uuid.uuid4().hex[:8].upper()}",
           "yq": str(b["yq"]).strip(), "rev_dt": b.get("rev_dt") or datetime.now().strftime("%Y-%m-%d"),
           "rev_type": b["rev_type"], "amt": b["amt"],
           "reason": str(b.get("reason") or "").strip()}
    data["budget"].append(rec)
    append_audit(data, "예산 이력 추가", f"{rec['rev_id']} {rec['rev_type']} {rec['amt']:,}", actor="admin")
    save_data(data)
    return jsonify({"ok": True, "budget": rec, "dash": C.dash(data, rec["yq"])}), 201


@travelbudget.delete("/api/budget/<rev_id>")
@admin_required
def del_budget(rev_id):
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
    pw = str((request.get_json(silent=True) or {}).get("pw", ""))
    return (jsonify({"ok": True}) if pw == str(data["settings"].get("admin_pw", ""))
            else _err("아이디 또는 비밀번호가 올바르지 않습니다.", 401))


# ── CSV / 백업 ────────────────────────────────────────────
@travelbudget.get("/api/export.csv")
def export_csv():
    yq = request.args.get("yq") or None
    content = C.make_csv(load_data(), yq)
    fn = f"국내출장비_{yq or '전체'}_{datetime.now().strftime('%Y%m%d')}.csv"
    return Response(content, mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{fn}"})


@travelbudget.get("/api/backups")
def backups():
    return jsonify({"ok": True, "backups": list_backups()})


@travelbudget.post("/api/backups/<filename>/restore")
@admin_required
def restore(filename):
    cur_audit = load_data().get("audit_log", [])       # 복원해도 감사 이력은 이어감
    try:
        restore_backup(filename)
    except (FileNotFoundError, ValueError) as exc:
        return _err(str(exc))
    data = load_data()
    data["audit_log"] = cur_audit
    append_audit(data, "백업 복원", filename, actor="admin")
    save_data(data, make_backup=False)
    return jsonify({"ok": True})
