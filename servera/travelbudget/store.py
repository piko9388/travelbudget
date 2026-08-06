# -*- coding: utf-8 -*-
"""data.json 저장소 — 원자적 쓰기 + 자동백업(30개) + 감사로그 + 시드."""
from __future__ import annotations
import json, os, shutil, tempfile, threading
from datetime import date, datetime, timedelta
from pathlib import Path

from . import core as C

_LOCK = threading.RLock()
LOCK = _LOCK  # 라우트에서 read-modify-write 전체를 한 락으로 묶기 위해 노출 (분실 갱신 방지)
BASE_DIR = Path(__file__).resolve().parent
# 정본 위치. 기본은 앱 폴더 안이지만, 배포 시 폴더를 통째로 덮어쓰면 데이터가 날아간다.
# 운영에서는 TB_DATA_DIR 로 앱 밖(예: /var/lib/travelbudget)을 지정할 것.
DATA_DIR = Path(os.environ.get("TB_DATA_DIR") or (BASE_DIR / "data_json"))
BACKUP_DIR = DATA_DIR / "backup"
DATA_FILE = DATA_DIR / "data.json"
MAX_BACKUPS = 30


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _settings():
    """운영 기본 설정 — 실적 인폼 기본 수신자는 소재 담당자 2명 + 센터 담당자 2명.
    (담당자·CCG 는 연 단위로 바뀐다. 운영 중에는 화면 [시스템 설정]에서 고친다)"""
    return {
        "system_name": "소재 국내 출장비 관리",
        "notice": ("현재 소재 배정 예산 소진 후 센터 예산 사용 중으로, "
                   "식비 15,000원, 회사 공용 차량 이용 통한 교통비 절감 요청 드립니다"),
        "notice_sub": "(사용 전/후 센터 검토 시 반려될 수 있음)",
        "admin_pw": "2071478",
        "mail_recipients": ["junghoon12.lee@sk.com", "eunjeong5.kim@sk.com",
                            "Jeewoung.Chun@sk.com", "geonyoung.kim@sk.com"],
        "reference_url": "material.skhynix.com/travelbudget",
        # 국내 출장 정산서(전자결재) 주소 — 바뀌면 [시스템 설정]에서 고친다
        "approval_url": "http://apv.skhynix.com/Website/Approval/Forms/Form_SRC.aspx?fmid=ef282431-0b98-9551-e66f8bc74cd2&mode=DRAFT&CFN_OpenWindowName=96845",
    }


def default_data():
    """신규 설치 기본값 — **빈 원장**. 예시 출장·예산을 만들지 않는다.
    (첫 화면에 예시가 실데이터처럼 보여 혼동되던 문제. 예시는 data.example.json 에만 둔다)"""
    return {
        "schema_version": "2.0",
        "updated_at": _now(),
        "settings": _settings(),
        "budget": [],
        "groups": [],
        "audit_log": [],
    }


def example_data():
    """예시 원장 — data.example.json 생성용. 운영 첫 실행 경로에서는 호출되지 않는다."""
    today = date.today()
    yq = C.year_quarter()
    qm = ((today.month - 1) // 3) * 3 + 1

    def dd(day, off=0):
        try:
            return (date(today.year, qm, min(day, 28)) + timedelta(days=off)).isoformat()
        except ValueError:
            return date(today.year, qm, 28).isoformat()

    def trav(name, emp, rank, team, p, a):
        return dict(name=name, emp_no=emp, rank=rank, ccg_nm=team,
                    ccg=C.CCG_BY_NM[team],
                    p_trans=p[0], p_lodg=p[1], p_meal=p[2], p_etc=p[3],
                    a_trans=a[0], a_lodg=a[1], a_meal=a[2], a_etc=a[3])

    def grp(gid, ptype, status, city, org, purpose, kind, dep, ret, car, travelers, remark=""):
        return dict(group_id=gid, plan_type=ptype, status=status, lv2="소재",
                    city=city, org=org, purpose=purpose, kind=kind,
                    dep_dt=dep, ret_dt=ret, car=car, travelers=travelers,
                    remark=remark, created_at=_now(), updated_at=_now())

    Z = [0, 0, 0, 0]
    K = C.KINDS
    groups = [
        grp("TB-0001", "계획", C.ST_DONE, "이천", "동우화인켐",
            "ArF Photo Resist 정기 품질 실사 및 CoA 항목 협의", K[2], dd(2), dd(3), "자차사용",
            [trav("김철수", "20150322", "팀장", "C&C소재기술",
                  [80000, 0, 90000, 20000], [60000, 0, 85000, 15000])]),
        grp("TB-0002", "계획", C.ST_DONE, "청주", "원익머트리얼즈",
            "NF3 순도 관리 정기 Audit", K[2], dd(4), dd(5), "자차사용",
            [trav("박영희", "20140508", "팀장", "EDTW소재기술",
                  [70000, 95000, 65000, 10000], [65000, 90000, 60000, 10000]),
             trav("이정훈", "2071478", "TL", "C&C소재기술",
                  [70000, 95000, 65000, 10000], [68000, 90000, 62000, 8000])]),
        grp("TB-0003", "계획", C.ST_TRANSFER, "화성", "동진쎄미켐",
            "KrF PR Outgassing 개선 사양 협의", K[1], dd(6), dd(7), "자차사용",
            [trav("이민호", "20120233", "팀장", "Patterning소재기술",
                  [60000, 0, 70000, 10000], [72000, 0, 78000, 12000])],
            "현지 미팅 연장으로 식대 증가"),
        grp("TB-0004", "긴급", C.ST_INFORM, "성남", "케이씨텍",
            "CMP Slurry 이물 유입 긴급 대응 (Particle 급증)", K[3], dd(7), dd(8), "자차사용",
            [trav("정다은", "20200711", "팀장", "C&C소재개발", Z, [90000, 105000, 60000, 30000])],
            "소재하자 발생에 따른 긴급 출장 (사전 계획 없음)"),
        grp("TB-0005", "계획", C.ST_INFORM, "공주", "솔브레인",
            "Wet Chemical 신규 Lot 품질 실사", K[1], dd(9), dd(10), "자차사용",
            [trav("이수진", "20180915", "팀장", "C&C소재기술",
                  [90000, 95000, 80000, 20000], [88000, 90000, 75000, 18000])]),
        grp("TB-0006", "계획", C.ST_PLAN, "세종", "SK트리켐",
            "Precursor PCN 대응 및 Lot 이력 협의", K[1], dd(20), dd(21), "자차사용",
            [trav("최준영", "20170419", "팀장", "EDTW소재개발",
                  [80000, 90000, 70000, 15000], Z)]),
        grp("TB-0007", "계획", C.ST_CONFIRM, "구미", "SK실트론",
            "Wafer 표면 결함 정기 Audit", K[2], dd(25), dd(26), "미사용",
            [trav("한지우", "20210302", "팀장", "P&C소재",
                  [120000, 100000, 70000, 20000], Z),
             trav("오세훈", "20160828", "팀장", "소재전략",
                  [120000, 100000, 70000, 20000], Z)]),
        grp("TB-0008", "계획", C.ST_CANCEL, "서울", "이엔에프테크놀로지",
            "i-line PR 정기 실사", K[2], dd(5), dd(5), "자차사용",
            [trav("이민호", "20120233", "팀장", "Patterning소재기술", [50000, 0, 40000, 10000], Z)],
            "BP 측 일정 연기 요청으로 취소"),
    ]
    budget = [
        dict(rev_id="B-0001", yq=yq, rev_dt=dd(1), rev_type="최초배정",
             amt=9000000, reason="분기 정기 배정 (전분기 실적 기반)"),
        dict(rev_id="B-0002", yq=yq, rev_dt=dd(15), rev_type="추가증액",
             amt=2000000, reason="긴급 품질 대응 출장 추가 발생"),
    ]
    return {
        "schema_version": "2.0",
        "updated_at": _now(),
        "settings": _settings(),
        "budget": budget,
        "groups": [C.normalize_group(g) for g in groups],
        "audit_log": [],
    }


def validate_root(data):
    if not isinstance(data, dict):
        raise ValueError("최상위 JSON은 객체여야 합니다.")
    if not isinstance(data.get("settings"), dict):
        raise ValueError("settings는 객체여야 합니다.")
    for key in ("budget", "groups"):
        if key not in data:
            raise ValueError(f"필수 키 누락: {key}")
        if not isinstance(data[key], list):
            raise ValueError(f"{key}는 배열이어야 합니다.")
        if not all(isinstance(x, dict) for x in data[key]):
            raise ValueError(f"{key}의 각 항목은 객체여야 합니다.")


def ensure_storage():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if not DATA_FILE.exists():
        save_data(default_data(), make_backup=False)


def load_data():
    ensure_storage()
    with _LOCK, DATA_FILE.open("r", encoding="utf-8") as f:
        data = json.load(f)
    validate_root(data)
    return data


def backup_current():
    if not DATA_FILE.exists():
        return
    name = datetime.now().strftime("data_%Y%m%d_%H%M%S_%f.json")
    shutil.copy2(DATA_FILE, BACKUP_DIR / name)
    # 파일명에 YYYYMMDD_HHMMSS_%f 가 박혀 있어 이름순 정렬이 곧 시간순 — copy2가 보존하는 mtime보다 안정적.
    for old in sorted(BACKUP_DIR.glob("data_*.json"),
                      key=lambda p: p.name, reverse=True)[MAX_BACKUPS:]:
        old.unlink(missing_ok=True)


def save_data(data, make_backup=True):
    validate_root(data)
    with _LOCK:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        if make_backup:
            backup_current()
        data["updated_at"] = _now()
        fd, tmp = tempfile.mkstemp(prefix="tb_", suffix=".json", dir=str(DATA_DIR))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, DATA_FILE)
            try:  # 디렉터리 엔트리까지 fsync — 크래시 시 rename 유실 방지 (미지원 플랫폼은 무시)
                dfd = os.open(str(DATA_DIR), os.O_DIRECTORY)
                try:
                    os.fsync(dfd)
                finally:
                    os.close(dfd)
            except OSError:
                pass
        finally:
            if os.path.exists(tmp):
                os.unlink(tmp)
    return data


def append_audit(data, action, detail="", actor=""):
    data.setdefault("audit_log", []).append({
        "timestamp": _now(), "actor": actor or "-",
        "action": action, "detail": detail})
    data["audit_log"] = data["audit_log"][-500:]


def list_backups():
    ensure_storage()
    return [{"filename": p.name, "size": p.stat().st_size,
             "modified_at": datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")}
            for p in sorted(BACKUP_DIR.glob("data_*.json"),
                            key=lambda x: x.name, reverse=True)]


def restore_backup(filename, *, audit_log=None):
    src = BACKUP_DIR / Path(filename).name
    if not src.exists():
        raise FileNotFoundError("백업 파일을 찾을 수 없습니다.")
    with src.open("r", encoding="utf-8") as f:
        data = json.load(f)
    validate_root(data)
    if audit_log is not None:            # 복원해도 감사 이력은 이어감 (단일 저장으로 처리)
        data["audit_log"] = audit_log
    return save_data(data, make_backup=True)
