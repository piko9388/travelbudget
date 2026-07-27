# -*- coding: utf-8 -*-
"""라우트 — 12개. 관리자 행위는 서버측 검증(X-Admin-PW). PUT /api/data 없음."""
from __future__ import annotations
import uuid
from datetime import datetime
from functools import wraps
from urllib.parse import quote
from flask import Response, jsonify, render_template, request

from . import travelbudget
from . import core as C
from .store import (LOCK, append_audit, list_backups, load_data, restore_backup, save_data)


def _err(msgs, code=400):
    return jsonify({"ok": False, "errors": msgs if isinstance(msgs, list) else [msgs]}), code


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
    yq = request.args.get("yq") or C.year_quarter()
    groups = [C.normalize_group(g) for g in data["groups"]]
    groups.sort(key=lambda g: g.get("dep_dt") or "", reverse=True)
    return jsonify({
        "yq": yq,
        "yqList": C.yq_list(),
        "settings": _public_settings(data["settings"]),
        "ccg": C.CCG_TEAMS,
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
    with LOCK:
        data = load_data()
        payload = request.get_json(silent=True) or {}
        payload["group_id"] = f"TB-{uuid.uuid4().hex[:8].upper()}"
        payload["status"] = C.ST_CONFIRM if payload.get("confirmed") else C.ST_PLAN
        payload["created_at"] = datetime.now().isoformat(timespec="seconds")
        for p in payload.get("travelers") or []:   # 개인 처리 상태 주입 금지 (신규는 항상 빈 값)
            if isinstance(p, dict):
                p.pop("status", None)
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
    with LOCK:
        data = load_data()
        cur = _find(data, gid)
        if cur is None:
            return _err("출장건을 찾을 수 없습니다.", 404)
        # 예산 담당자 영역(이관·완료·보류·취소)은 관리자만 수정 — 정산 금액 사후 변조 차단
        if C.locked(cur) and not _is_admin(data):
            return _err("이관·처리 단계의 건은 관리자만 수정할 수 있습니다.", 401)
        # 상태는 현재 값으로 고정 — 상태 전환은 오직 게이트가 있는 /actual·/status 로만.
        # (이 라우트로 status·실적을 밀어넣어 승인 게이트를 우회하고 예산을 움직이는 경로 차단)
        merged = {**cur, **(request.get_json(silent=True) or {}),
                  "group_id": gid, "status": cur.get("status") or C.ST_PLAN}
        # 개인 처리 상태도 동일 — 기존 값만 사번 기준으로 이식하고 요청 값은 폐기.
        old_st = {str(p.get("emp_no")): p.get("status", "") for p in cur.get("travelers", [])}
        for p in merged.get("travelers") or []:
            if isinstance(p, dict):
                p["status"] = old_st.get(str(p.get("emp_no")), "")
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
        body = request.get_json(silent=True) or {}
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
            g = C.normalize_group(cur)
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
            g = C.normalize_group(g)
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
            if cur.get("plan_type") != "긴급" and C.g_sum(C.normalize_group(cur), "p") <= 0:
                return _err("계획 비용이 있어야 예산을 확보(확정)할 수 있습니다.")
        if want == C.ST_PLAN and cur.get("status") not in C.PRE:
            return _err("확정 예정 건만 잠정 계획으로 되돌릴 수 있습니다.")
        # 관리자 통제 상태로 들어가거나, 이미 예산 담당자 영역인 건(부분 완료 포함)의
        # 어떤 전환이든 관리자 인증 필요. — 취소로 정산금을 지우던 우회 경로 차단.
        if (want in (C.ST_TRANSFER, C.ST_DONE) or C.locked(cur)) and not admin:
            return _err("관리자 인증이 필요합니다.", 401)
        # 이관·완료·인폼(되돌림 포함) 상태는 실적이 있어야만.
        if want in (C.ST_INFORM, C.ST_TRANSFER, C.ST_DONE) and C.g_sum(C.normalize_group(cur), "a") <= 0:
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
        g = C.normalize_group(cur)
        dash = C.dash(data, g["yq"])
        mail = C.make_transfer_mail(g, data["settings"]) if want == C.ST_TRANSFER else None
    return jsonify({"ok": True, "group": g, "dash": dash, "mail": mail, "held": held})


# ── 이관 인폼 다시 보기 (현재 '소재 이관' 상태 출장자 대상) ──
@travelbudget.get("/api/groups/<gid>/transfer_mail")
def transfer_mail(gid):
    data = load_data()
    cur = _find(data, gid)
    if cur is None:
        return _err("출장건을 찾을 수 없습니다.", 404)
    g = C.normalize_group(cur)
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
        yq = C.normalize_group(cur)["yq"]
        data["groups"] = [x for x in data["groups"] if x.get("group_id") != gid]
        # 삭제 내용을 감사로그에 남겨 사후 추적·복원 근거를 남긴다
        who = ", ".join(str(p.get("name", "")) for p in cur.get("travelers", []))
        append_audit(data, "잠정 계획 삭제",
                     f"{gid} {cur.get('city','')} {cur.get('org','')} · {who} · "
                     f"계획 {C.g_sum(C.normalize_group(cur), 'p'):,}원",
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
        doc = str((request.get_json(silent=True) or {}).get("sap_doc", "")).strip()
        cur["sap_doc"] = doc
        cur["updated_at"] = datetime.now().isoformat(timespec="seconds")
        append_audit(data, "SAP 전표번호", f"{gid} → {doc or '(삭제)'}", actor="admin")
        save_data(data)
        g = C.normalize_group(cur)
    return jsonify({"ok": True, "group": g})


# ── 센터 제출 리포트 / 감사 로그 ──────────────────────────
@travelbudget.get("/api/report")
def center_report():
    data = load_data()
    yq = request.args.get("yq") or C.year_quarter()
    return jsonify({"ok": True, "report": C.center_report(data, yq)})


@travelbudget.get("/api/audit")
def audit_log():
    data = load_data()
    n = min(int(request.args.get("n", 200) or 200), 500)
    return jsonify({"ok": True, "audit": list(reversed(data.get("audit_log", [])))[:n]})


# ── 예산 (관리자, 검증 + 감액 자동 음수) ──────────────────
@travelbudget.post("/api/budget")
@admin_required
def add_budget():
    b = request.get_json(silent=True) or {}
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
    pw = str((request.get_json(silent=True) or {}).get("pw", ""))
    return (jsonify({"ok": True}) if pw == str(data["settings"].get("admin_pw", ""))
            else _err("아이디 또는 비밀번호가 올바르지 않습니다.", 401))


# ── CSV / 백업 ────────────────────────────────────────────
@travelbudget.get("/api/export.csv")
def export_csv():
    yq = request.args.get("yq") or None
    content = C.make_csv(load_data(), yq)
    fn = f"국내출장비_{yq or '전체'}_{datetime.now().strftime('%Y%m%d')}.csv"
    # RFC 5987: 헤더는 latin-1만 허용 — 한글 파일명을 percent-encoding 해야 실서버에서 안 죽는다.
    return Response(content, mimetype="text/csv; charset=utf-8",
                    headers={"Content-Disposition":
                             "attachment; filename=travelbudget.csv; "
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
