/* 국내 출장비 관리 — 정적(GitHub Pages) 로컬 백엔드
   Flask의 core.py/store.py/routes.py를 브라우저에서 동일 로직으로 구현.
   저장은 localStorage(브라우저별). 관리자 잠금은 UX용(클라이언트라 보안 경계 아님). */
(function (root) {
  'use strict';
  var LS_DATA = 'tb_data', LS_BACKUPS = 'tb_backups', MAX_BACKUPS = 30;

  // ── 상수 (core.py와 동일) ──
  var COST = [['trans', '교통비'], ['lodg', '숙박비'], ['meal', '식대&잡비'], ['etc', '기타']];
  var KEYS = COST.map(function (c) { return c[0]; });
  var PLAN_TYPES = ['계획', '변경', '긴급'];
  var RANKS = ['TL', '팀장'];
  var KINDS = ['기술교류(Live Demo, Data 분석)', '실사&사양 개선,협의', '정기 Audit',
    '비정기 Audit(Issue/Theme)', '기타'];
  var CARS = ['미사용', '자차사용'];
  var REV_TYPES = ['최초배정', '추가증액', '감액', '이월'];
  var ST_PLAN = '계획 등록', ST_INFORM = '실적 입력·인폼', ST_TRANSFER = '소재 이관',
    ST_DONE = '처리 완료', ST_CANCEL = '취소';
  var ST_CONFIRM = '확정 예정';                            // 실제로 감 → 예산 선확보
  var STATUSES = [ST_PLAN, ST_CONFIRM, ST_INFORM, ST_TRANSFER, ST_DONE, ST_CANCEL];
  var PRE = [ST_PLAN, ST_CONFIRM];                         // 실적 전(계획 단계)
  var WIP = [ST_INFORM, ST_TRANSFER];
  var ST_HOLD = '보류';                                    // 개인별 처리 보류
  var PSTATES = [ST_INFORM, ST_TRANSFER, ST_HOLD, ST_DONE]; // 출장자 개인 처리 상태
  var ADMIN_ZONE = [ST_TRANSFER, ST_HOLD, ST_DONE];         // 예산 담당자가 결정한 영역
  // core.CCG_TEAMS 와 이름·코드·순서까지 같아야 한다 (test_api §31 이 대조한다)
  var CCG_TEAMS = [
    { team: '소재전략', ccg: '50110502' }, { team: 'P&C소재', ccg: '50128121' },
    { team: 'Patterning소재기술', ccg: '50119135' }, { team: 'Patterning소재개발', ccg: '50077468' },
    { team: 'C&C소재기술', ccg: '50139632' }, { team: 'C&C소재개발', ccg: '50134405' },
    { team: 'EDTW소재기술', ccg: '50119134' }, { team: 'EDTW소재개발', ccg: '50103536' }];
  var CCG_BY_NM = {}; CCG_TEAMS.forEach(function (t) { CCG_BY_NM[t.team] = t.ccg; });
  var CCG_MAX = 40;
  // CCG 는 설정(data.settings.ccg_teams)에 있으면 그것을, 없으면 위 기본값을 쓴다 — core.py 와 동일
  function ccgTeams(data) {
    var raw = ((data || {}).settings || {}).ccg_teams;
    if (!Array.isArray(raw)) return CCG_TEAMS;
    var out = [], seen = {};
    raw.forEach(function (t) {
      if (!t || typeof t !== 'object') return;
      var nm = txt(t.team), cd = txt(t.ccg);
      if (!nm || !cd || seen[cd]) return;
      seen[cd] = 1; out.push({ team: nm, ccg: cd });
    });
    return out.slice(0, CCG_MAX).length ? out.slice(0, CCG_MAX) : CCG_TEAMS;
  }
  function ccgByNm(data) {
    var m = {}; ccgTeams(data).forEach(function (t) { m[t.team] = t.ccg; }); return m;
  }
  function ccgByCd(data) {
    var m = {}; ccgTeams(data).forEach(function (t) { m[t.ccg] = t.team; }); return m;
  }
  function ccgUsage(data) {
    var used = {}, names = {};
    (data.groups || []).forEach(function (g) {
      (g.travelers || []).forEach(function (p) {
        var k = txt(p.ccg); if (!k) return;
        used[k] = (used[k] || 0) + 1;
        if (names[k] === undefined) names[k] = txt(p.ccg_nm);
      });
    });
    var known = ccgByCd(data);
    var stale = Object.keys(used).filter(function (k) { return !known[k]; })
      .sort(function (a, b) { return used[b] - used[a]; })
      .map(function (k) { return { ccg: k, name: names[k] || k, n: used[k] }; });
    return { used: used, stale: stale };
  }
  // 표시용 팀 이름은 코드에서 파생 — 요청 진입 시 현재 설정으로 갱신한다 (routes._norm 과 같은 역할)
  var CUR_BY_CD = {};
  CCG_TEAMS.forEach(function (t) { CUR_BY_CD[t.ccg] = t.team; });
  var APP_VERSION = 'v10.25', APP_BUILD = '2026-08-03';
  var AMT_MAX = 100000000;   // 비용 1건 상한 — 오타 방어선
  // 텍스트 길이 상한 — 붙여넣기 사고 방어선 (core.TEXT_MAX 와 동일)
  var TEXT_MAX = [['city', '출장도시', 40], ['org', '출장기관&업체', 100],
                  ['purpose', '출장목적&사유', 300], ['remark', '비고', 500]];
  var PERSON_MAX = [['name', '성명', 40], ['emp_no', '사번', 30]];
  var TRAVELERS_MAX = 30;
  // 센터 관리 양식(정산 대장) 27필드 — 최초 제공 엑셀표 순서
  var CSV_HEADERS = ['구분', 'LV2', 'CCG', 'CCG명', '사번', '성명', '직책',
    '출장도시', '출장기관&업체', '출장목적&사유', '출발일자', '복귀일자',
    '출장일수', '출장시점', '자차사용여부', '출장구분',
    '계획_총합계', '계획_교통비', '계획_숙박비', '계획_식대&잡비', '계획_기타',
    '실적_총합계', '실적_교통비', '실적_숙박비', '실적_식대&잡비', '실적_기타', '비고'];
  var CSV_EXTRA = ['상태', '개인처리상태', 'SAP전표번호', '리드타임(일)'];
  var STAGE_ORDER = {}; STAGE_ORDER[ST_PLAN]=0; STAGE_ORDER[ST_CONFIRM]=1; STAGE_ORDER[ST_INFORM]=2;
  STAGE_ORDER[ST_TRANSFER]=3; STAGE_ORDER[ST_DONE]=4; STAGE_ORDER[ST_CANCEL]=5;

  // ── 유틸 ──
  function num(v) { var n = Math.round(Number(String(v == null ? 0 : v).replace(/,/g, ''))); return isFinite(n) ? n : 0; }
  function won(n) { return num(n).toLocaleString('en-US'); }
  function pad(n, w) { return String(n).padStart(w, '0'); }
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function parseD(s) {
    if (!s || typeof s === 'object' || typeof s === 'boolean') return null;
    var m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    // new Date 는 2027-02-29 를 3/1 로 굴려버린다 — 파이썬 date.fromisoformat 과 같게 거부
    if (isNaN(d.getTime()) || d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    return d;
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function tripDays(a, b) { var da = parseD(a), db = parseD(b); if (!da || !db) return 0; var n = Math.round((db - da) / 864e5); return n < 0 ? 0 : n + 1; }
  function quarter(s) { var d = parseD(s); return d ? (Math.floor(d.getMonth() / 3) + 1) + 'Q' : ''; }
  function yearQuarter(s) { var d = parseD(s) || today(); return d.getFullYear() + '-' + (Math.floor(d.getMonth() / 3) + 1) + 'Q'; }
  function yqList(n) {
    n = n || 6; var y = today().getFullYear(), q = Math.floor(today().getMonth() / 3) + 1, out = [];
    for (var i = 0; i < n; i++) { out.push(y + '-' + q + 'Q'); q--; if (q === 0) { y--; q = 4; } }
    var ny = today().getFullYear(), nq = Math.floor(today().getMonth() / 3) + 2;
    if (nq === 5) { ny++; nq = 1; }
    return [ny + '-' + nq + 'Q'].concat(out);
  }
  function pSum(p, x) { return KEYS.reduce(function (s, k) { return s + num(p[x + '_' + k]); }, 0); }
  function gSum(g, x) { return (g.travelers || []).reduce(function (s, p) { return s + pSum(p, x); }, 0); }
  function effStatus(p, g) {
    var gs = g.status;
    if (PRE.indexOf(gs) >= 0 || gs === ST_CANCEL) return gs;
    return p.status || gs;
  }
  function groupRoll(g) {
    var gs = g.status;
    if (PRE.indexOf(gs) >= 0 || gs === ST_CANCEL) return gs;
    var effs = (g.travelers || []).map(function (p) { return effStatus(p, g); });
    if (!effs.length) return gs;
    if (effs.every(function (e) { return e === ST_DONE; })) return ST_DONE;
    if (effs.every(function (e) { return e === ST_TRANSFER || e === ST_DONE; })) return ST_TRANSFER;
    return ST_INFORM;
  }
  // 예산 담당자 영역인가 — 여기 걸리면 모든 변경에 관리자 인증 필요
  function locked(g) {
    if ([ST_TRANSFER, ST_DONE, ST_CANCEL].indexOf(g.status) >= 0) return true;
    return (g.travelers || []).some(function (p) { return ADMIN_ZONE.indexOf(effStatus(p, g)) >= 0; });
  }
  function procCounts(g) {
    var c = { total: (g.travelers || []).length, inform: 0, transfer: 0, done: 0, hold: 0 };
    if (PRE.indexOf(g.status) >= 0 || g.status === ST_CANCEL) return c;
    (g.travelers || []).forEach(function (p) {
      var e = effStatus(p, g);
      if (e === ST_DONE) c.done++;
      else if (e === ST_TRANSFER) c.transfer++;
      else if (e === ST_HOLD) c.hold++;
      else c.inform++;
    });
    return c;
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' }[m]; }); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nowISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2) + 'T' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2); }
  function todayISO() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2); }
  function randHex(n) {
    var a = new Uint8Array(n); (root.crypto || globalThis.crypto).getRandomValues(a);
    return Array.from(a).map(function (b) { return pad(b.toString(16), 2); }).join('').slice(0, n);
  }
  function byteLen(s) { return typeof Blob !== 'undefined' ? new Blob([s]).size : Buffer.byteLength(s, 'utf8'); }

  // ── 정규화·검증 ──
  function txt(v) {            // dict/list/bool/null → 빈 값 (원장·정렬이 문자열 전제)
    if (v == null || typeof v === 'boolean' || typeof v === 'object') return '';
    return String(v).trim();
  }
  // 태그(#) — 서버 core.clean_tags 와 같은 규칙: # 를 떼고, 중복 제거, 8개·20자 상한
  var TAG_MAX = 8, TAG_LEN = 20;
  function cleanTags(v) {
    var raw = [];
    if (typeof v === 'string') raw = v.split(/[#,\n\t]/);
    else if (Array.isArray(v)) v.forEach(function (x) { raw = raw.concat(String(x).split(/[#,\n\t]/)); });
    else return [];
    var out = [];
    raw.forEach(function (x) {
      var s = String(x == null ? '' : x).replace(/^#+/, '').trim().slice(0, TAG_LEN);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out.slice(0, TAG_MAX);
  }
  function tagsUsed(data) {
    var n = {};
    (data.groups || []).forEach(function (g) {
      cleanTags(g.tags).forEach(function (x) { n[x] = (n[x] || 0) + 1; });
    });
    return Object.keys(n).map(function (k) { return { tag: k, n: n[k] }; })
      .sort(function (a, b) { return b.n - a.n || (a.tag < b.tag ? -1 : 1); });
  }
  function normalizeGroup(gin) {
    var g = clone(gin);
    if (g.plan_type == null) g.plan_type = '계획';
    if (g.status == null) g.status = ST_PLAN;
    if (g.lv2 == null) g.lv2 = '소재';
    g.travelers = Array.isArray(g.travelers) ? g.travelers.filter(function (p) { return p && typeof p === 'object'; }) : [];
    if (g.remark == null) g.remark = '';
    g.tags = cleanTags(g.tags);
    ['plan_type','status','lv2','city','org','purpose','kind','car','remark','group_id','sap_doc']
      .forEach(function (k) { g[k] = txt(g[k]); });
    ['dep_dt','ret_dt'].forEach(function (k) { var d = parseD(g[k]); g[k] = d ? iso(d) : ''; });
    g.days = tripDays(g.dep_dt, g.ret_dt);
    g.quarter = quarter(g.dep_dt);
    g.yq = parseD(g.dep_dt) ? yearQuarter(g.dep_dt) : (g.yq || yearQuarter());
    g.travelers.forEach(function (p) {
      if (p.rank == null) p.rank = 'TL';
      ['name','emp_no','rank','ccg_nm','ccg'].forEach(function (k) { p[k] = txt(p[k]); });
      if (!p.ccg && CCG_BY_NM[p.ccg_nm]) p.ccg = CCG_BY_NM[p.ccg_nm];
      if (p.ccg && CUR_BY_CD[p.ccg]) p.ccg_nm = CUR_BY_CD[p.ccg];   // core.normalize_group 과 동일
      p.status = PSTATES.indexOf(p.status) >= 0 ? p.status : '';   // 개인 처리 상태(없으면 그룹 상속)
      ['p', 'a'].forEach(function (x) { KEYS.forEach(function (k) { p[x + '_' + k] = num(p[x + '_' + k]); }); });
    });
    g.plan_tot = gSum(g, 'p'); g.act_tot = gSum(g, 'a');
    g.roll = groupRoll(g); g.proc = procCounts(g);
    g.stage = STAGE_ORDER[g.roll] === undefined ? 9 : STAGE_ORDER[g.roll];
    g.sap_doc = String(g.sap_doc || '').trim();
    var d0 = parseD(g.created_at), dp = parseD(g.dep_dt);
    g.lead_days = (d0 && dp) ? Math.round((dp - d0) / 864e5) : null;
    return g;
  }
  function josa(w, pair) {          // 받침 유무로 조사 선택
    pair = pair || '을를';
    if (!w) return pair[1];
    var c = w.charCodeAt(w.length - 1);
    return (c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28) ? pair[0] : pair[1];
  }
  function validateGroup(g, requireActual) {
    var e = [];
    [['city', '출장도시'], ['org', '출장기관&업체'], ['purpose', '출장목적&사유'],
    ['dep_dt', '출발일자'], ['ret_dt', '복귀일자'], ['kind', '출장구분']].forEach(function (kv) {
      if (!String(g[kv[0]] == null ? '' : g[kv[0]]).trim()) e.push(kv[1] + josa(kv[1]) + ' 입력하세요.');
    });
    TEXT_MAX.forEach(function (kv) {
      var v = txt(g[kv[0]]);
      if (v.length > kv[2]) e.push(kv[1] + josa(kv[1], '은는') + ' ' + kv[2] + '자를 넘습니다 ('
        + v.length.toLocaleString() + '자) — 붙여넣기가 잘못되지 않았는지 확인하세요.');
    });
    if (PLAN_TYPES.indexOf(g.plan_type) < 0) e.push('구분이 올바르지 않습니다.');
    if (STATUSES.indexOf(g.status) < 0) e.push('상태 값이 올바르지 않습니다.');
    if (String(g.kind || '').trim() && KINDS.indexOf(g.kind) < 0) e.push('출장구분이 올바르지 않습니다.');
    if (String(g.car || '').trim() && CARS.indexOf(g.car) < 0) e.push('자차사용여부가 올바르지 않습니다.');
    if (g.dep_dt && g.ret_dt && tripDays(g.dep_dt, g.ret_dt) < 1) e.push('복귀일자는 출발일자보다 빠를 수 없습니다.');
    var T = g.travelers || [];
    if (!Array.isArray(T) || T.some(function (p) { return !p || typeof p !== 'object'; }))
      return e.concat(['출장자 형식이 올바르지 않습니다.']);
    if (!T.length) e.push('출장자를 1명 이상 입력하세요.');
    if (T.length > TRAVELERS_MAX) e.push('한 출장의 동행은 ' + TRAVELERS_MAX + '명까지입니다 ('
      + T.length + '명) — 붙여넣기 범위가 잘못되지 않았는지 확인하세요.');
    var seen = {}, valid = {}; Object.keys(CCG_BY_NM).forEach(function (k) { valid[CCG_BY_NM[k]] = 1; });
    T.forEach(function (p, idx) {
      var i = idx + 1;
      if (!String(p.name == null ? '' : p.name).trim()) e.push(i + '번 출장자 성명을 입력하세요.');
      var emp = String(p.emp_no == null ? '' : p.emp_no).trim();
      if (!emp) e.push(i + '번 출장자 사번을 입력하세요.');
      else if (seen[emp]) e.push(i + '번 출장자 사번이 중복입니다.');
      else seen[emp] = 1;
      if (RANKS.indexOf(p.rank) < 0) e.push(i + '번 출장자 직책을 선택하세요 (TL/팀장).');
      var ccg = String(p.ccg == null ? '' : p.ccg).trim();
      if (!ccg) e.push(i + '번 출장자 CCG팀을 선택하세요.');
      else if (!valid[ccg]) e.push(i + '번 출장자 CCG팀이 올바르지 않습니다.');
      if (requireActual && pSum(p, 'a') < 0) e.push(i + '번 출장자 실적 비용이 올바르지 않습니다.');
      [['p', '계획'], ['a', '실적']].forEach(function (xl) {
        COST.forEach(function (ck) {
          var v = num(p[xl[0] + '_' + ck[0]]);
          if (v > AMT_MAX) e.push(i + '번 출장자 ' + xl[1] + ' ' + ck[1] + ' ' + won(v) + '원이 상한(' + won(AMT_MAX) + '원)을 넘습니다 — 자릿수를 확인하세요.');
          else if (v < 0) e.push(i + '번 출장자 ' + xl[1] + ' ' + ck[1] + '는 음수일 수 없습니다.');
        });
      });
    });
    if (requireActual && T.length && gSum(g, 'a') <= 0) e.push('실적 비용을 1개 이상 입력하세요.');
    if (g.plan_type !== '긴급' && PRE.indexOf(g.status) >= 0 && gSum(g, 'p') <= 0) e.push('계획 비용을 1개 이상 입력하세요.');
    if (g.plan_type === '긴급' && requireActual && !String(g.remark == null ? '' : g.remark).trim()) e.push('긴급 출장은 비고(사유)가 필수입니다.');
    return e;
  }
  function validateBudget(b) {
    var e = [], yq = String(b.yq == null ? '' : b.yq).trim();
    if (!yq || yq.indexOf('-') < 0 || !/Q$/.test(yq)) e.push('분기를 입력하세요 (예: 2026-3Q).');
    if (REV_TYPES.indexOf(b.rev_type) < 0) e.push('유형을 선택하세요.');
    if (num(b.amt) === 0) e.push('금액을 입력하세요.');
    return e;
  }
  function fixBudgetSign(b) { var amt = num(b.amt); b.amt = b.rev_type === '감액' ? -Math.abs(amt) : Math.abs(amt); return b; }

  // ── 대시보드 ──
  function dash(data, yq) {
    var G = (data.groups || []).map(normalizeGroup).filter(function (g) { return g.yq === yq; });
    var B = (data.budget || []).filter(function (b) { return b.yq === yq; });
    var alloc = B.reduce(function (s, b) { return s + num(b.amt); }, 0);
    var doneAmt = 0, wipAmt = 0, planAmt = 0, commitAmt = 0, nDone = 0, nWip = 0, nPlan = 0, nConfirm = 0, nCancel = 0, nPeople = 0;
    var costMap = {}; KEYS.forEach(function (k) { costMap[k] = 0; });
    var map = {}; CCG_TEAMS.forEach(function (t) { map[t.ccg] = { team: t.team, ccg: t.ccg, done: 0, wip: 0, commit: 0, plan: 0, groups: {}, people: 0, cpeople: 0 }; });
    map._ETC = { team: '기타(미등록 CCG)', ccg: '-', done: 0, wip: 0, commit: 0, plan: 0, groups: {}, people: 0, cpeople: 0 };
    var nUsedPeople = 0;
    // 확정 예정 = 계획 금액 선확보(가용 차감), 잠정 = 참고. 실적 이후는 개인 실효 상태 기준.
    G.forEach(function (g) {
      var gs = g.status;
      if (gs === ST_CANCEL) { nCancel++; return; }
      if (gs === ST_PLAN) nPlan++; else if (gs === ST_CONFIRM) nConfirm++; else if (g.roll === ST_DONE) nDone++; else nWip++;
      g.travelers.forEach(function (p) {
        nPeople++; var row = map[p.ccg] || map._ETC;
        if (gs === ST_PLAN) { var pl = pSum(p, 'p'); planAmt += pl; if (row) row.plan += pl; }
        else if (gs === ST_CONFIRM) {
          var pc = pSum(p, 'p'); commitAmt += pc; if (row) row.commit += pc;
        }
        else {
          var eff = effStatus(p, g), a = pSum(p, 'a');
          if (eff === ST_DONE) { doneAmt += a; if (row) row.done += a; }
          else { wipAmt += a; if (row) row.wip += a; }
          KEYS.forEach(function (k) { costMap[k] += num(p['a_' + k]); });
        }
        // 부서별 인원·참여 출장은 실집행 기준 — 아직 안 간 사람을 세면 숫자가 부풀어 보인다
        if (row) {
          if (PRE.indexOf(gs) < 0) { row.groups[g.group_id] = 1; row.people++; nUsedPeople++; }
          else if (gs === ST_CONFIRM) { row.cpeople++; }
        }
      });
    });
    var remain = alloc - doneAmt - wipAmt;
    var avail = remain - commitAmt;
    // 부서별 구분은 실집행(처리 중 + 처리 완료) 기준 — core.py 와 동일해야 한다.
    // 확정 예정은 아직 안 쓴 돈이라 합계·구성비·정렬에서 빼고 화면에서 흐리게 따로 보여준다.
    var usedTotal = doneAmt + wipAmt, byCcg = [];
    Object.keys(map).forEach(function (k) {
      var row = map[k], tot = row.done + row.wip;
      if (tot === 0 && row.commit === 0) return;
      byCcg.push({ team: row.team, ccg: row.ccg, done: row.done, wip: row.wip, commit: row.commit, total: tot, plan: row.plan, share: usedTotal ? tot / usedTotal : 0, groups: Object.keys(row.groups).length, people: row.people, cpeople: row.cpeople });
    });
    byCcg.sort(function (a, b) { return (b.total - a.total) || (b.commit - a.commit); });
    var td = today();
    var todo = {
      actual_wait: G.filter(function (g) { return g.status === ST_CONFIRM; }).filter(function (g) { var r = parseD(g.ret_dt); return r && r < td; }).map(function (g) { return g.group_id; }),
      process_wait: G.filter(function (g) { return PRE.indexOf(g.status) < 0 && g.status !== ST_CANCEL && g.roll !== ST_DONE; }).map(function (g) { return g.group_id; }),
      hold: G.filter(function (g) { return g.proc.hold > 0; }).map(function (g) { return g.group_id; })
    };
    return {
      yq: yq, alloc: alloc, done: doneAmt, wip: wipAmt, commit: commitAmt, remain: remain, avail: avail, planAmt: planAmt,
      short: avail < 0 && alloc > 0,
      noBudget: alloc <= 0 && (doneAmt + wipAmt + commitAmt) > 0,
      nDone: nDone, nWip: nWip, nPlan: nPlan, nConfirm: nConfirm, nCancel: nCancel, nPeople: nPeople,
      nTrips: nPlan + nConfirm + nWip + nDone,
      nUsedTrips: nWip + nDone,
      nUsedPeople: nUsedPeople,
      nHold: G.reduce(function (s, g) { return s + g.proc.hold; }, 0),
      byCcg: byCcg,
      byCost: COST.map(function (c) {
        return { key: c[0], name: c[1], amt: costMap[c[0]], share: usedTotal ? costMap[c[0]] / usedTotal : 0 };
      }),
      todo: todo
    };
  }

  // ── 이메일 인폼 ──
  function makeMail(gin, settings) {
    var g = normalizeGroup(gin);
    var name = [g.city, g.org].filter(Boolean).join(' ') || '국내 출장';
    var subject = name + ' 국내 출장 정산 위한 출장비 실비 이관 요청 건';
    var period = (g.dep_dt || '') + ' ~ ' + (g.ret_dt || '') + ' (' + (g.days || 0) + '일)';
    var T = g.travelers || [];
    var L = [name + ' 출장비 실비 이관 요청 드립니다.', '',
      '[출장 정보] ' + period + ' · ' + (g.purpose || ''),
      '출장 인원 ' + T.length + '명 · 실적 총액 ' + won(g.act_tot) + '원', '',
      'CCG팀\t성명\t사번\t교통비\t숙박비\t식대&잡비\t기타\t합계'];
    T.forEach(function (p) {
      L.push([p.ccg_nm || '', p.name || '', p.emp_no || '', won(p.a_trans), won(p.a_lodg), won(p.a_meal), won(p.a_etc), won(pSum(p, 'a'))].join('\t'));
    });
    if (g.remark) { L.push('', '[비고] ' + g.remark); }
    L.push('', '** 참고 : ' + (settings.reference_url || ''));
    var base = 'padding:6px 11px;border:1px solid #D8DEE8';
    var td = 'style="' + base + '"', tdr = 'style="' + base + ';text-align:right"',
      th = 'style="' + base + ';background:#EEF2F8"', thr = 'style="' + base + ';text-align:right;background:#EEF2F8"',
      tdf = 'style="' + base + ';background:#F6F8FB;font-weight:700"', tdrf = 'style="' + base + ';text-align:right;background:#F6F8FB;font-weight:700"';
    var rows = '', tots = { trans: 0, lodg: 0, meal: 0, etc: 0 };
    T.forEach(function (p) {
      KEYS.forEach(function (k) { tots[k] += p['a_' + k]; });
      rows += '<tr><td ' + td + '>' + escapeHtml(p.ccg_nm || '') + '</td><td ' + td + '>' + escapeHtml(p.name || '') + '</td><td ' + td + '>' + escapeHtml(p.emp_no || '') + '</td>'
        + KEYS.map(function (k) { return '<td ' + tdr + '>' + won(p['a_' + k]) + '</td>'; }).join('')
        + '<td ' + tdr + '><b>' + won(pSum(p, 'a')) + '</b></td></tr>';
    });
    var foot = '<tr><td ' + tdf + ' colspan="3">합계</td>'
      + KEYS.map(function (k) { return '<td ' + tdrf + '>' + won(tots[k]) + '</td>'; }).join('')
      + '<td ' + tdrf + '>' + won(g.act_tot) + '</td></tr>';
    var info = "<p style='margin:0 0 8px'>" + escapeHtml(name) + " 출장비 실비 이관 요청 드립니다.</p>"
      + "<table style='border-collapse:collapse;font-size:13px;margin:0 0 8px'>"
      + "<tr><td style='padding:2px 10px;color:#64718C'>기간</td><td style='padding:2px 10px'>" + escapeHtml(period) + "</td></tr>"
      + "<tr><td style='padding:2px 10px;color:#64718C'>목적</td><td style='padding:2px 10px'>" + escapeHtml(g.purpose || '') + "</td></tr>"
      + "<tr><td style='padding:2px 10px;color:#64718C'>인원</td><td style='padding:2px 10px'>" + T.length + "명 · 실적 총액 <b>" + won(g.act_tot) + "원</b></td></tr></table>";
    var table = "<table style='border-collapse:collapse;font-size:13px'><thead><tr><th " + th + ">CCG팀</th><th " + th + ">성명</th><th " + th + ">사번</th>"
      + COST.map(function (c) { return '<th ' + thr + '>' + escapeHtml(c[1]) + '</th>'; }).join('')
      + "<th " + thr + ">합계</th></tr></thead><tbody>" + rows + foot + "</tbody></table>";
    var remark = g.remark ? "<p style='margin:8px 0 0;font-size:13px'><b>비고</b> " + escapeHtml(g.remark) + "</p>" : '';
    var ref = "<p style='margin:10px 0 0;font-size:12px;color:#64718C'>** 참고 : " + escapeHtml(settings.reference_url || '') + "</p>";
    return { to: (settings.mail_recipients || []).join(';'), subject: subject, trip_name: name, kind: 'actual', heading: '실비 이관 요청 인폼 (그룹당 1통)', body_text: L.join('\n'), body_html: info + table + remark + ref };
  }

  // 이관 인폼 (예산 담당자 → 소재 담당자, 비용 처리 요청)
  function makeTransferMail(gin, settings, emps) {
    var g = normalizeGroup(gin);
    var name = [g.city, g.org].filter(Boolean).join(' ') || '국내 출장';
    var subject = '[출장비] ' + name + ' 이관 결재 상신 — 비용 처리 요청 건';
    var period = (g.dep_dt || '') + ' ~ ' + (g.ret_dt || '') + ' (' + (g.days || 0) + '일)';
    var keys = emps ? emps.map(String) : null;
    var T = (g.travelers || []).filter(function (p) { return !keys || keys.indexOf(String(p.emp_no)) >= 0; });
    var tot = T.reduce(function (s, p) { return s + pSum(p, 'a'); }, 0);
    var msg = ['요청하신 금액 이관 결재 상신했습니다.', '참조자로 추가하였으니, 이관 후 비용 처리 부탁드립니다.'];
    var L = msg.concat(['', '[출장 정보] ' + name + ' · ' + period + ' · ' + (g.purpose || ''),
      '이관 대상 ' + T.length + '명 · 이관 총액 ' + won(tot) + '원', '', '성명\tCCG팀\t사번\t이관금액']);
    T.forEach(function (p) { L.push([p.name || '', p.ccg_nm || '', p.emp_no || '', won(pSum(p, 'a'))].join('\t')); });
    L.push('', '** 참고 : ' + (settings.reference_url || ''));
    var base = 'padding:6px 11px;border:1px solid #D8DEE8';
    var td = 'style="' + base + '"', tdr = 'style="' + base + ';text-align:right"',
      th = 'style="' + base + ';background:#EEF2F8"', thr = 'style="' + base + ';text-align:right;background:#EEF2F8"',
      tdf = 'style="' + base + ';background:#F6F8FB;font-weight:700"', tdrf = 'style="' + base + ';text-align:right;background:#F6F8FB;font-weight:700"';
    var rows = T.map(function (p) {
      return '<tr><td ' + td + '>' + escapeHtml(p.name || '') + '</td><td ' + td + '>' + escapeHtml(p.ccg_nm || '') + '</td><td ' + td + '>' + escapeHtml(p.emp_no || '') + '</td><td ' + tdr + '><b>' + won(pSum(p, 'a')) + '</b></td></tr>';
    }).join('');
    var foot = '<tr><td ' + tdf + ' colspan="3">합계</td><td ' + tdrf + '>' + won(tot) + '</td></tr>';
    var lead = "<p style='margin:0 0 5px'>" + escapeHtml(msg[0]) + "</p><p style='margin:0 0 10px'>" + escapeHtml(msg[1]) + "</p>";
    var info = "<table style='border-collapse:collapse;font-size:13px;margin:0 0 8px'>"
      + "<tr><td style='padding:2px 10px;color:#64718C'>출장</td><td style='padding:2px 10px'>" + escapeHtml(name) + " · " + escapeHtml(period) + "</td></tr>"
      + "<tr><td style='padding:2px 10px;color:#64718C'>이관</td><td style='padding:2px 10px'>" + T.length + "명 · 이관 총액 <b>" + won(tot) + "원</b></td></tr></table>";
    var table = "<table style='border-collapse:collapse;font-size:13px'><thead><tr><th " + th + ">성명</th><th " + th + ">CCG팀</th><th " + th + ">사번</th><th " + thr + ">이관금액</th></tr></thead><tbody>" + rows + foot + "</tbody></table>";
    var ref = "<p style='margin:10px 0 0;font-size:12px;color:#64718C'>** 참고 : " + escapeHtml(settings.reference_url || '') + "</p>";
    var to = T.filter(function (p) { return p.email; }).map(function (p) { return p.email; }).join(';');
    return { to: to, subject: subject, trip_name: name, kind: 'transfer', heading: '이관 결재 상신 · 비용 처리 요청 인폼', body_text: L.join('\n'), body_html: lead + info + table + ref };
  }

  // ── 센터 제출 리포트 ──
  function centerReport(data, yq) {
    var d = dash(data, yq);
    var B = (data.budget || []).filter(function (b) { return b.yq === yq; })
      .sort(function (a, b) { return (a.rev_dt || '') < (b.rev_dt || '') ? -1 : 1; });
    var used = d.done + d.wip;
    return {
      yq: yq, alloc: d.alloc, done: d.done, wip: d.wip, commit: d.commit, used: used,
      avail: d.avail, need: Math.max(0, -d.avail),
      burn: d.alloc ? (used + d.commit) / d.alloc : 0,
      nDone: d.nDone, nWip: d.nWip, nConfirm: d.nConfirm, nPlan: d.nPlan, nPeople: d.nPeople,
      byCcg: d.byCcg.map(function (r) {
        return { team: r.team, ccg: r.ccg, done: r.done, wip: r.wip, commit: r.commit,
                 plan: r.plan, total: r.done + r.wip + r.commit, groups: r.groups, people: r.people };
      }),
      revisions: B.map(function (b) {
        return { rev_id: b.rev_id || '', rev_dt: b.rev_dt || '', rev_type: b.rev_type || '',
                 amt: num(b.amt), reason: b.reason || '' };
      })
    };
  }

  // ── CSV ──
  function csvCell(v) { var s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function csvSafe(v) { var s = v == null ? '' : String(v); return (s.length && '=+-@\t\r'.indexOf(s.charAt(0)) >= 0) ? "'" + s : s; }
  // gids 를 주면 그 출장건만 — 화면에서 걸러 놓은 것만 제출할 때 (서버 ledger_rows 와 같은 규칙)
  function ledgerRows(data, yq, internal, gids) {
    var out = [];
    var keep = (gids && gids.length) ? gids : null;
    var groups = (data.groups || []).slice().sort(function (a, b) { return String(a.dep_dt || '').localeCompare(String(b.dep_dt || '')); });
    groups.forEach(function (raw) {
      var g = normalizeGroup(raw); if (yq && g.yq !== yq) return;
      if (keep && keep.indexOf(g.group_id) < 0) return;
      g.travelers.forEach(function (p) {
        var row = [g.plan_type, '소재', p.ccg || '', csvSafe(p.ccg_nm || ''),
          csvSafe(p.emp_no || ''), csvSafe(p.name || ''), p.rank || '',
          csvSafe(g.city || ''), csvSafe(g.org || ''), csvSafe(g.purpose || ''),
          g.dep_dt || '', g.ret_dt || '', g.days, g.quarter, g.car || '', g.kind || '',
          pSum(p, 'p'), p.p_trans, p.p_lodg, p.p_meal, p.p_etc,
          pSum(p, 'a'), p.a_trans, p.a_lodg, p.a_meal, p.a_etc,
          csvSafe(g.remark || '')];
        if (internal) row = row.concat([groupRoll(g), effStatus(p, g), csvSafe(g.sap_doc || ''),
          (g.lead_days === null || g.lead_days === undefined) ? '' : g.lead_days]);
        out.push(row);
      });
    });
    return out;
  }
  function makeCsv(data, yq, internal, gids) {
    var heads = CSV_HEADERS.concat(internal ? CSV_EXTRA : []);
    var lines = [heads.map(csvCell).join(',')];
    ledgerRows(data, yq, internal, gids).forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }
  // 엑셀 서식(맑은 고딕) 포함 — CSV는 글꼴을 담을 수 없어 제출본은 이 파일
  function makeXls(data, yq, internal, gids) {
    var heads = CSV_HEADERS.concat(internal ? CSV_EXTRA : []);
    var font = "'Malgun Gothic','맑은 고딕',sans-serif";   // 엑셀 제출본은 맑은 고딕 고정
    var th = 'font-family:' + font + ';font-size:10pt;font-weight:bold;background:#EEF2F8;border:1px solid #B7C0CE;padding:4px 6px;text-align:center';
    var td = 'font-family:' + font + ';font-size:10pt;border:1px solid #D8DEE8;padding:3px 6px';
    var tdn = td + ";mso-number-format:'#,##0';text-align:right";
    var rows = ledgerRows(data, yq, internal, gids);
    var body = rows.map(function (r) {
      return '<tr>' + r.map(function (v, i) {
        var isNum = typeof v === 'number' || heads[i].indexOf('계획_') === 0 || heads[i].indexOf('실적_') === 0
          || heads[i] === '출장일수' || heads[i] === '리드타임(일)';
        return '<td style="' + (isNum ? tdn : td) + '">' + escapeHtml(String(v)) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    // 걸러서 낸 제출본은 제목에 그 사실을 적는다 — 받는 쪽이 '전체인 줄' 알면 안 된다
    var title = '소재 국내 출장비 정산 대장 ' + (yq || '전체');
    if (gids && gids.length) {
      var uniq = gids.filter(function (v, i) { return gids.indexOf(v) === i; });
      title += ' (선택 ' + uniq.length + '건 · 출장자 ' + rows.length + '명)';
    }
    return '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">'
      + '<head><meta charset="utf-8"><style>body,table,td,th{font-family:' + font + '}</style></head><body>'
      + '<table border="1" cellspacing="0" cellpadding="0">'
      + '<tr><td colspan="' + heads.length + '" style="' + th + ';font-size:12pt">' + escapeHtml(title) + '</td></tr>'
      + '<tr>' + heads.map(function (h) { return '<th style="' + th + '">' + escapeHtml(h) + '</th>'; }).join('') + '</tr>'
      + body + '</table></body></html>';
  }

  var BUDGET_CSV_HEADERS = ['no.', '분기', 'REV', '반영일', '유형', '증감액', '누적액', '사유'];
  function makeBudgetCsv(data, yq) {
    var B = (data.budget || []).filter(function (b) { return !yq || b.yq === yq; });
    B.sort(function (a, b) {
      var ka = (a.yq || '') + (a.rev_dt || '') + (a.rev_id || '');
      var kb = (b.yq || '') + (b.rev_dt || '') + (b.rev_id || '');
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    var out = [], run = 0, cur = null;
    B.forEach(function (b, i) {
      if (b.yq !== cur) { cur = b.yq; run = 0; }
      run += num(b.amt);
      out.push([i + 1, csvSafe(b.yq || ''), csvSafe(b.rev_id || ''), csvSafe(b.rev_dt || ''),
                csvSafe(b.rev_type || ''), num(b.amt), run, csvSafe(b.reason || '')]);
    });
    var lines = [BUDGET_CSV_HEADERS.map(csvCell).join(',')];
    out.forEach(function (r) { lines.push(r.map(csvCell).join(',')); });
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  // ── 시드 (store.py default_data와 동일) ──
  function seedData() {
    var t = today(), yq = yearQuarter(), qm = Math.floor(t.getMonth() / 3) * 3;
    function dd(day, off) {
      off = off || 0; var d = new Date(t.getFullYear(), qm, Math.min(day, 28));
      d = new Date(d.getTime() + off * 864e5);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
    }
    function trav(name, emp, rank, team, p, a) {
      return { name: name, emp_no: emp, rank: rank, ccg_nm: team, ccg: CCG_BY_NM[team],
        p_trans: p[0], p_lodg: p[1], p_meal: p[2], p_etc: p[3],
        a_trans: a[0], a_lodg: a[1], a_meal: a[2], a_etc: a[3] };
    }
    function grp(gid, ptype, status, city, org, purpose, kind, dep, ret, car, travelers, remark) {
      return { group_id: gid, plan_type: ptype, status: status, lv2: '소재', city: city, org: org,
        purpose: purpose, kind: kind, dep_dt: dep, ret_dt: ret, car: car, travelers: travelers,
        remark: remark || '', created_at: nowISO(), updated_at: nowISO() };
    }
    var Z = [0, 0, 0, 0], K = KINDS;
    var groups = [
      grp('TB-0001', '계획', ST_DONE, '이천', '동우화인켐',
        'ArF Photo Resist 정기 품질 실사 및 CoA 항목 협의', K[2], dd(2), dd(3), '자차사용',
        [trav('김철수', '20150322', '팀장', 'C&C소재기술', [80000, 0, 90000, 20000], [60000, 0, 85000, 15000])]),
      grp('TB-0002', '계획', ST_DONE, '청주', '원익머트리얼즈',
        'NF3 순도 관리 정기 Audit', K[2], dd(4), dd(5), '자차사용',
        [trav('박영희', '20140508', '팀장', 'EDTW소재기술', [70000, 95000, 65000, 10000], [65000, 90000, 60000, 10000]),
        trav('이정훈', '2071478', 'TL', 'C&C소재기술', [70000, 95000, 65000, 10000], [68000, 90000, 62000, 8000])]),
      grp('TB-0003', '계획', ST_TRANSFER, '화성', '동진쎄미켐',
        'KrF PR Outgassing 개선 사양 협의', K[1], dd(6), dd(7), '자차사용',
        [trav('이민호', '20120233', '팀장', 'Patterning소재기술', [60000, 0, 70000, 10000], [72000, 0, 78000, 12000])],
        '현지 미팅 연장으로 식대 증가'),
      grp('TB-0004', '긴급', ST_INFORM, '성남', '케이씨텍',
        'CMP Slurry 이물 유입 긴급 대응 (Particle 급증)', K[3], dd(7), dd(8), '자차사용',
        [trav('정다은', '20200711', '팀장', 'C&C소재개발', Z, [90000, 105000, 60000, 30000])],
        '소재하자 발생에 따른 긴급 출장 (사전 계획 없음)'),
      grp('TB-0005', '계획', ST_INFORM, '공주', '솔브레인',
        'Wet Chemical 신규 Lot 품질 실사', K[1], dd(9), dd(10), '자차사용',
        [trav('이수진', '20180915', '팀장', 'C&C소재기술', [90000, 95000, 80000, 20000], [88000, 90000, 75000, 18000])]),
      grp('TB-0006', '계획', ST_PLAN, '세종', 'SK트리켐',
        'Precursor PCN 대응 및 Lot 이력 협의', K[1], dd(20), dd(21), '자차사용',
        [trav('최준영', '20170419', '팀장', 'EDTW소재개발', [80000, 90000, 70000, 15000], Z)]),
      grp('TB-0007', '계획', ST_CONFIRM, '구미', 'SK실트론',
        'Wafer 표면 결함 정기 Audit', K[2], dd(25), dd(26), '미사용',
        [trav('한지우', '20210302', '팀장', 'P&C소재', [120000, 100000, 70000, 20000], Z),
        trav('오세훈', '20160828', '팀장', '소재전략', [120000, 100000, 70000, 20000], Z)]),
      grp('TB-0008', '계획', ST_CANCEL, '서울', '이엔에프테크놀로지',
        'i-line PR 정기 실사', K[2], dd(5), dd(5), '자차사용',
        [trav('이민호', '20120233', '팀장', 'Patterning소재기술', [50000, 0, 40000, 10000], Z)],
        'BP 측 일정 연기 요청으로 취소')
    ];
    var budget = [
      { rev_id: 'B-0001', yq: yq, rev_dt: dd(1), rev_type: '최초배정', amt: 9000000, reason: '분기 정기 배정 (전분기 실적 기반)' },
      { rev_id: 'B-0002', yq: yq, rev_dt: dd(15), rev_type: '추가증액', amt: 2000000, reason: '긴급 품질 대응 출장 추가 발생' }
    ];
    return {
      schema_version: '2.0', updated_at: nowISO(),
      settings: {
        system_name: '소재 국내 출장비 관리',
        notice: '현재 소재 배정 예산 소진 후 센터 예산 사용 중으로, 식비 15,000원, 회사 공용 차량 이용 통한 교통비 절감 요청 드립니다',
        notice_sub: '(사용 전/후 센터 검토 시 반려될 수 있음)',
        admin_pw: '2071478',
        // 소재 담당자 2 + 센터 담당자 2 — store._settings() 와 반드시 같아야 한다
        mail_recipients: ['junghoon12.lee@sk.com', 'eunjeong5.kim@sk.com',
                          'Jeewoung.Chun@sk.com', 'geonyoung.kim@sk.com'],
        reference_url: 'material.skhynix.com/travelbudget',
        approval_url: 'http://apv.skhynix.com/Website/Approval/Forms/Form_SRC.aspx?fmid=ef282431-0b98-9551-e66f8bc74cd2&mode=DRAFT&CFN_OpenWindowName=96845'
      },
      budget: budget, groups: groups.map(normalizeGroup), audit_log: []
    };
  }

  // ── 저장소 (localStorage) ──
  function LS() { return root.localStorage || globalThis.localStorage; }
  function appendAudit(data, action, detail, actor) {
    if (!data.audit_log) data.audit_log = [];
    data.audit_log.push({ timestamp: nowISO(), actor: actor || '-', action: action, detail: detail || '' });
    data.audit_log = data.audit_log.slice(-500);
  }
  function loadBackups() { try { return JSON.parse(LS().getItem(LS_BACKUPS) || '[]'); } catch (e) { return []; } }
  function saveBackups(b) { LS().setItem(LS_BACKUPS, JSON.stringify(b)); }
  var Store = {
    load: function () {
      var raw = LS().getItem(LS_DATA);
      if (!raw) { var d = seedData(); LS().setItem(LS_DATA, JSON.stringify(d)); return d; }
      return JSON.parse(raw);
    },
    save: function (data, makeBackup) {
      if (makeBackup !== false) {
        var cur = LS().getItem(LS_DATA);
        if (cur) {
          var d = new Date();
          var fn = 'data_' + d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '_'
            + pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2) + '_'
            + pad(d.getMilliseconds(), 3) + pad(Math.floor((root.crypto || globalThis.crypto).getRandomValues(new Uint8Array(1))[0]), 3) + '.json';
          var b = loadBackups(); b.push({ filename: fn, ts: nowISO(), size: byteLen(cur), data: cur });
          b.sort(function (x, y) { return x.filename < y.filename ? 1 : -1; });
          saveBackups(b.slice(0, MAX_BACKUPS));
        }
      }
      data.updated_at = nowISO();
      LS().setItem(LS_DATA, JSON.stringify(data));
      return data;
    },
    backups: function () {
      return loadBackups().slice().sort(function (x, y) { return x.filename < y.filename ? 1 : -1; })
        .map(function (b) { return { filename: b.filename, size: b.size, modified_at: b.ts }; });
    },
    restore: function (filename, auditLog) {
      var b = loadBackups().filter(function (x) { return x.filename === filename; })[0];
      if (!b) throw new Error('백업 파일을 찾을 수 없습니다.');
      var data = JSON.parse(b.data);
      if (auditLog != null) data.audit_log = auditLog;
      return Store.save(data, true);
    },
    reset: function () { LS().removeItem(LS_DATA); LS().removeItem(LS_BACKUPS); }
  };

  // ── 라우트 (routes.py와 동일한 게이트) ──
  function publicSettings(s) {
    var o = {}; Object.keys(s).forEach(function (k) { if (k !== 'admin_pw') o[k] = s[k]; });
    o.pw_default = String(s.admin_pw == null ? '' : s.admin_pw) === '2071478';
    return o;
  }
  function err(msgs, code) { return { ok: false, status: code || 400, data: { ok: false, errors: Array.isArray(msgs) ? msgs : [msgs] } }; }
  function okr(obj, code) { obj.ok = true; return { ok: true, status: code || 200, data: obj }; }
  function find(data, gid) { return (data.groups || []).filter(function (g) { return g.group_id === gid; })[0] || null; }

  function localApi(path, opt) {
    opt = opt || {};
    var method = (opt.method || 'GET').toUpperCase();
    var body = {}; if (opt.body) { try { body = JSON.parse(opt.body); } catch (e) { body = {}; } }
    var headers = opt.headers || {};
    var qs = ''; var qi = path.indexOf('?'); if (qi >= 0) { qs = path.slice(qi + 1); path = path.slice(0, qi); }
    function qp(k) { var m = qs.match(new RegExp('(?:^|&)' + k + '=([^&]*)')); return m ? decodeURIComponent(m[1]) : null; }
    var data = Store.load();
    CUR_BY_CD = ccgByCd(data);
    var _pw = String(data.settings.admin_pw == null ? '' : data.settings.admin_pw);
    var isAdmin = !!_pw && String(headers['X-Admin-PW'] || '') === _pw;
    var m;

    if (path === '/state' && method === 'GET') {
      var yq = qp('yq') || yearQuarter();
      var groups = (data.groups || []).map(normalizeGroup).sort(function (a, b) { return (b.dep_dt || '') < (a.dep_dt || '') ? -1 : (b.dep_dt || '') > (a.dep_dt || '') ? 1 : 0; });
      return okr({
        yq: yq, yqList: yqList(), settings: publicSettings(data.settings), ccg: ccgTeams(data),
        tags: tagsUsed(data),
        version: { v: APP_VERSION, build: APP_BUILD },
        dash: dash(data, yq), groups: groups,
        budget: (data.budget || []).filter(function (b) { return b.yq === yq; }).sort(function (a, b) { return (a.rev_dt || '') < (b.rev_dt || '') ? -1 : 1; }),
        meta: { planTypes: PLAN_TYPES, ranks: RANKS, kinds: KINDS, cars: CARS, revTypes: REV_TYPES, statuses: STATUSES, cost: COST.map(function (c) { return { k: c[0], label: c[1] }; }) }
      });
    }
    if (path === '/groups' && method === 'POST') {
      body.group_id = 'TB-' + randHex(8).toUpperCase();
      body.status = body.confirmed ? ST_CONFIRM : ST_PLAN; body.created_at = nowISO();
      (body.travelers || []).forEach(function (p) { if (p && typeof p === 'object') delete p.status; });
      var g = normalizeGroup(body); var e = validateGroup(g, false);
      if (e.length) return err(e);
      data.groups.push(g);
      appendAudit(data, '출장 계획 등록', g.group_id + ' ' + (g.org || '') + ' ' + g.travelers.length + '명');
      Store.save(data); return okr({ group: g }, 201);
    }
    if ((m = path.match(/^\/groups\/([^/]+)$/)) && method === 'PUT') {
      var cur = find(data, m[1]); if (!cur) return err('출장건을 찾을 수 없습니다.', 404);
      if (locked(cur) && !isAdmin) return err('이관·처리 단계의 건은 관리자만 수정할 수 있습니다.', 401);
      var merged = Object.assign({}, cur, body, { group_id: m[1], status: cur.status || ST_PLAN });
      var oldSt = {}; (cur.travelers || []).forEach(function (p) { oldSt[String(p.emp_no)] = p.status || ''; });
      (merged.travelers || []).forEach(function (p) { if (p && typeof p === 'object') p.status = oldSt[String(p.emp_no)] || ''; });
      var g2 = normalizeGroup(merged); var e2 = validateGroup(g2, WIP.indexOf(g2.status) >= 0);
      if (e2.length) return err(e2);
      g2.updated_at = nowISO(); data.groups[data.groups.indexOf(cur)] = g2;
      appendAudit(data, '출장 수정', m[1]); Store.save(data); return okr({ group: g2 });
    }
    // 태그는 분류·검색용이라 잠긴 건도 고칠 수 있다 (서버 /groups/<gid>/tags 와 같은 규칙)
    if ((m = path.match(/^\/groups\/([^/]+)\/tags$/)) && method === 'POST') {
      var curT = find(data, m[1]); if (!curT) return err('출장건을 찾을 수 없습니다.', 404);
      var before = cleanTags(curT.tags), tg = cleanTags(body.tags);
      curT.tags = tg; curT.updated_at = nowISO();
      if (before.join('|') !== tg.join('|')) {
        appendAudit(data, '태그 변경', m[1] + ' ' + (before.join('·') || '(없음)') + ' → ' + (tg.join('·') || '(없음)'));
        Store.save(data);
      }
      return okr({ tags: tg, tagsUsed: tagsUsed(data) });
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/actual$/)) && method === 'POST') {
      var cur3 = find(data, m[1]); if (!cur3) return err('출장건을 찾을 수 없습니다.', 404);
      if (cur3.status === ST_DONE || cur3.status === ST_CANCEL) return err('완료·취소된 건에는 실적을 입력할 수 없습니다.');
      if (locked(cur3) && !isAdmin) return err('이관·처리가 시작된 건의 실적은 관리자만 수정할 수 있습니다.', 401);
      var g3 = normalizeGroup(cur3);
      var byEmp = {}; (body.travelers || []).forEach(function (p) { byEmp[String(p.emp_no)] = p; });
      g3.travelers.forEach(function (p) {
        var src = byEmp[String(p.emp_no)];
        if (src) KEYS.forEach(function (k) { if (('a_' + k) in src) p['a_' + k] = num(src['a_' + k]); });
      });
      if ('remark' in body) g3.remark = String(body.remark == null ? '' : body.remark).trim();
      g3.status = ST_INFORM;
      var e3 = validateGroup(g3, true); if (e3.length) return err(e3);
      g3 = normalizeGroup(g3); g3.inform_at = nowISO(); g3.updated_at = g3.inform_at;
      data.groups[data.groups.indexOf(cur3)] = g3;
      appendAudit(data, '실적 입력·인폼', m[1] + ' 실적 ' + won(g3.act_tot) + '원');
      Store.save(data);
      return okr({ group: g3, mail: makeMail(g3, data.settings), dash: dash(data, g3.yq) });
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/status$/)) && method === 'POST') {
      var cur4 = find(data, m[1]); if (!cur4) return err('출장건을 찾을 수 없습니다.', 404);
      var want = body.status || '';
      var emp = body.emp_no;
      // ── 개인별 처리 ──
      if (emp !== undefined && emp !== null && emp !== '') {
        if (PSTATES.indexOf(want) < 0) return err('개인 처리 상태 값이 올바르지 않습니다.');
        if (cur4.status === ST_PLAN || cur4.status === ST_CANCEL) return err('실적 입력 후 개인별 처리가 가능합니다.');
        if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
        var gp = normalizeGroup(cur4);
        var tgt = gp.travelers.filter(function (p) { return String(p.emp_no) === String(emp); })[0];
        if (!tgt) return err('출장자를 찾을 수 없습니다.', 404);
        if ((want === ST_TRANSFER || want === ST_DONE) && pSum(tgt, 'a') <= 0)
          return err('실적이 입력된 출장자만 이관·처리할 수 있습니다.');
        gp.travelers.forEach(function (p) { if (!p.status) p.status = effStatus(p, cur4); });
        tgt.status = want; gp.status = groupRoll(gp); gp.updated_at = nowISO();
        data.groups[data.groups.indexOf(cur4)] = gp;
        appendAudit(data, '개인 처리 변경', m[1] + ' ' + emp + ' → ' + want, 'admin');
        Store.save(data);
        var gpn = normalizeGroup(gp); var r1 = { group: gpn, dash: dash(data, gpn.yq) };
        if (want === ST_TRANSFER) r1.mail = makeTransferMail(gpn, data.settings, [emp]);
        return okr(r1);
      }
      // ── 그룹 전체 ──
      if ([ST_PLAN, ST_CONFIRM, ST_INFORM, ST_TRANSFER, ST_DONE, ST_CANCEL].indexOf(want) < 0) return err('상태 값이 올바르지 않습니다.');
      if (want === ST_CONFIRM) {
        if (PRE.indexOf(cur4.status) < 0) return err('계획 단계에서만 출장 확정을 할 수 있습니다.');
        if (cur4.plan_type !== '긴급' && gSum(normalizeGroup(cur4), 'p') <= 0) return err('계획 비용이 있어야 예산을 확보(확정)할 수 있습니다.');
      }
      if (want === ST_PLAN && PRE.indexOf(cur4.status) < 0) return err('확정 예정 건만 잠정 계획으로 되돌릴 수 있습니다.');
      // 취소는 따로 — 실적 입력·인폼 건은 locked() 가 False 라 무인증 취소가 통과했다.
      // (routes.py 와 같은 규칙이어야 한다. 한쪽만 고치면 정적 미러가 다른 권한을 갖는다)
      if ((want === ST_TRANSFER || want === ST_DONE || locked(cur4)
           || (want === ST_CANCEL && PRE.indexOf(cur4.status) < 0)) && !isAdmin)
        return err('관리자 인증이 필요합니다.', 401);
      if ([ST_INFORM, ST_TRANSFER, ST_DONE].indexOf(want) >= 0 && gSum(normalizeGroup(cur4), 'a') <= 0)
        return err('실적이 입력된 건만 이관·처리할 수 있습니다.');
      var held = 0;
      if ([ST_INFORM, ST_TRANSFER, ST_DONE].indexOf(want) >= 0) {
        (cur4.travelers || []).forEach(function (p) {
          if (effStatus(p, cur4) === ST_HOLD) { p.status = ST_HOLD; held++; } else { p.status = want; }
        });
        cur4.status = want;
        cur4.status = groupRoll(cur4);      // 보류가 남으면 그룹은 완료로 올리지 않음
      } else {
        cur4.status = want;
        if (PRE.indexOf(want) >= 0) (cur4.travelers || []).forEach(function (p) { delete p.status; });
      }
      cur4.updated_at = nowISO();
      if (want === ST_DONE) cur4.settle_at = cur4.updated_at;
      appendAudit(data, '상태 변경', m[1] + ' → ' + want, isAdmin ? 'admin' : 'user');
      Store.save(data);
      var g4 = normalizeGroup(cur4); var r2 = { group: g4, dash: dash(data, g4.yq), held: held };
      if (want === ST_TRANSFER) r2.mail = makeTransferMail(g4, data.settings);
      return okr(r2);
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/mail$/)) && method === 'GET') {
      var curM = find(data, m[1]); if (!curM) return err('출장건을 찾을 수 없습니다.', 404);
      var gM = normalizeGroup(curM);
      if (gSum(gM, 'a') <= 0) return err('실적이 입력되지 않아 인폼을 만들 수 없습니다.', 400);
      return okr({ mail: makeMail(gM, data.settings) });
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/transfer_mail$/)) && method === 'GET') {
      var curT = find(data, m[1]); if (!curT) return err('출장건을 찾을 수 없습니다.', 404);
      var gT = normalizeGroup(curT);
      var emps = gT.travelers.filter(function (p) { return effStatus(p, gT) === ST_TRANSFER; }).map(function (p) { return p.emp_no; });
      if (!emps.length) return err('이관 상태의 출장자가 없습니다.', 404);
      return okr({ mail: makeTransferMail(gT, data.settings, emps) });
    }
    if ((m = path.match(/^\/groups\/([^/]+)$/)) && method === 'DELETE') {
      var curD = find(data, m[1]); if (!curD) return err('출장건을 찾을 수 없습니다.', 404);
      if (curD.status !== ST_PLAN) return err('잠정 계획(계획 등록) 건만 삭제할 수 있습니다. 확정·진행 건은 취소를 쓰세요.');
      var yqD = normalizeGroup(curD).yq;
      data.groups = data.groups.filter(function (x) { return x.group_id !== m[1]; });
      var whoD = (curD.travelers || []).map(function (p) { return p.name || ''; }).join(', ');
      appendAudit(data, '잠정 계획 삭제',
        m[1] + ' ' + (curD.city || '') + ' ' + (curD.org || '') + ' · ' + whoD +
        ' · 계획 ' + won(gSum(normalizeGroup(curD), 'p')) + '원', isAdmin ? 'admin' : 'user');
      Store.save(data);
      return okr({ dash: dash(data, yqD) });
    }
    if (path === '/admin/verify' && method === 'POST') {
      return String(body.pw == null ? '' : body.pw) === String(data.settings.admin_pw == null ? '' : data.settings.admin_pw)
        ? okr({}) : err('아이디 또는 비밀번호가 올바르지 않습니다.', 401);
    }
    if (path === '/budget' && method === 'POST') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var e5 = validateBudget(body); if (e5.length) return err(e5);
      var b2 = fixBudgetSign(body);
      var rec = { rev_id: 'B-' + randHex(8).toUpperCase(), yq: String(b2.yq).trim(),
        rev_dt: b2.rev_dt || todayISO(), rev_type: b2.rev_type, amt: b2.amt, reason: String(b2.reason == null ? '' : b2.reason).trim() };
      data.budget.push(rec);
      appendAudit(data, '예산 이력 추가', rec.rev_id + ' ' + rec.rev_type + ' ' + won(rec.amt), 'admin');
      Store.save(data); return okr({ budget: rec, dash: dash(data, rec.yq) }, 201);
    }
    if ((m = path.match(/^\/budget\/([^/]+)$/)) && method === 'DELETE') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var before = data.budget.length;
      data.budget = data.budget.filter(function (b) { return b.rev_id !== m[1]; });
      if (data.budget.length === before) return err('리비전을 찾을 수 없습니다.', 404);
      appendAudit(data, '예산 이력 삭제', m[1], 'admin'); Store.save(data); return okr({});
    }
    if ((m = path.match(/^\/groups\/([^/]+)\/sap$/)) && method === 'POST') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var curS = find(data, m[1]); if (!curS) return err('출장건을 찾을 수 없습니다.', 404);
      curS.sap_doc = String(body.sap_doc || '').trim(); curS.updated_at = nowISO();
      appendAudit(data, 'SAP 전표번호', m[1] + ' → ' + (curS.sap_doc || '(삭제)'), 'admin');
      Store.save(data);
      return okr({ group: normalizeGroup(curS) });
    }
    // 여러 건 한꺼번에 확정 — routes.bulk_status 와 같은 규칙 (허용 전환은 확정 하나뿐)
    if (path === '/groups/bulk_status' && method === 'POST') {
      var want = txt(body.status);
      var gids = (Array.isArray(body.group_ids) ? body.group_ids : []).map(txt).filter(Boolean);
      if (want !== ST_CONFIRM) return err('일괄로는 출장 확정만 할 수 있습니다.');
      if (!gids.length) return err('확정할 출장을 하나 이상 고르세요.');
      if (gids.length > 200) return err('한 번에 200건까지입니다.');
      var bdone = [], bfail = [], bseen = {};
      gids.forEach(function (gid) {
        if (bseen[gid]) return;
        bseen[gid] = 1;
        var cur = find(data, gid);
        if (!cur) { bfail.push({ gid: gid, name: gid, reason: '출장을 찾을 수 없습니다.' }); return; }
        var label = [cur.city, cur.org].filter(Boolean).join(' ') || gid;
        if (cur.status !== ST_PLAN) {
          bfail.push({ gid: gid, name: label, reason: '계획(잠정) 단계가 아닙니다 — 현재 ' + cur.status });
          return;
        }
        if (cur.plan_type !== '긴급' && gSum(normalizeGroup(cur), 'p') <= 0) {
          bfail.push({ gid: gid, name: label, reason: '계획 비용이 없어 예산을 확보할 수 없습니다.' });
          return;
        }
        cur.status = ST_CONFIRM; cur.updated_at = nowISO();
        bdone.push({ gid: gid, name: label });
      });
      if (bdone.length) {
        appendAudit(data, '일괄 출장 확정', bdone.length + '건', isAdmin ? 'admin' : 'user');
        Store.save(data);
      }
      return okr({ done: bdone, failed: bfail, dash: dash(data, yearQuarter()) });
    }
    if (path === '/settings' && method === 'GET') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var u = ccgUsage(data), st = data.settings;
      return okr({ settings: {
        system_name: st.system_name || '', reference_url: st.reference_url || '',
        approval_url: st.approval_url || '',
        admin_pw: st.admin_pw || '', mail_recipients: (st.mail_recipients || []).slice(),
        ccg_teams: ccgTeams(data), ccg_from_settings: Array.isArray(st.ccg_teams)
      }, ccgUsed: u.used, ccgStale: u.stale });
    }
    // 원장의 옛 CCG 코드를 새 팀으로 옮기기 — routes.ccg_migrate 와 같은 규칙
    if (path === '/ccg_migrate' && method === 'POST') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var src = txt(body.from), dst = txt(body.to), codes = ccgByCd(data);
      if (!src || !dst) return err('옮길 CCG 코드와 대상 팀을 모두 고르세요.');
      if (!codes[dst]) return err('대상 팀(' + dst + ')이 CCG 목록에 없습니다. 먼저 목록에 추가하세요.');
      if (src === dst) return err('같은 코드로는 옮길 수 없습니다.');
      var moved = 0, gCnt = 0;
      (data.groups || []).forEach(function (g) {
        var hit = false;
        (g.travelers || []).forEach(function (p) {
          if (txt(p.ccg) === src) { p.ccg = dst; p.ccg_nm = codes[dst]; moved++; hit = true; }
        });
        if (hit) gCnt++;
      });
      if (!moved) return err('원장에서 ' + src + ' 를 쓰는 출장자를 찾지 못했습니다.');
      appendAudit(data, 'CCG 코드 이동',
        src + ' → ' + dst + '(' + codes[dst] + ') · 출장자 ' + moved + '명 · 출장 ' + gCnt + '건', 'admin');
      Store.save(data);
      CUR_BY_CD = ccgByCd(data);
      var u2 = ccgUsage(data);
      return okr({ moved: moved, groups: gCnt, ccgUsed: u2.used, ccgStale: u2.stale });
    }
    if (path === '/settings' && method === 'POST') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var e = [], cur = data.settings;
      // 안 보낸 항목은 '지우라'가 아니라 '그대로 두라' — routes.py 와 동일
      var srcM = ('mail_recipients' in body) ? body.mail_recipients : cur.mail_recipients;
      var mails = (Array.isArray(srcM) ? srcM : [])
        .map(function (x) { return String(x == null ? '' : x).trim(); }).filter(Boolean);
      if (!mails.length) e.push('인폼 수신인을 1명 이상 입력하세요.');
      if (mails.length > 10) e.push('인폼 수신인은 10명까지입니다.');
      mails.forEach(function (m) {
        if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(m)) e.push('메일 주소 형식이 올바르지 않습니다 — ' + m);
      });
      var clean = [], codes = {}, names = {};
      var srcT = ('ccg_teams' in body) ? body.ccg_teams : ccgTeams(data);
      (Array.isArray(srcT) ? srcT : []).forEach(function (t, i) {
        if (!t || typeof t !== 'object') { e.push((i + 1) + '번 CCG 형식이 올바르지 않습니다.'); return; }
        var nm = txt(t.team), cd = txt(t.ccg);
        if (!nm || !cd) { e.push((i + 1) + '번 CCG — 팀명과 코드를 모두 입력하세요.'); return; }
        if (codes[cd]) { e.push('CCG 코드가 중복입니다 — ' + cd); return; }
        if (names[nm]) { e.push('CCG 팀명이 중복입니다 — ' + nm); return; }
        codes[cd] = 1; names[nm] = 1; clean.push({ team: nm, ccg: cd });
      });
      if (!clean.length) e.push('CCG 팀을 1개 이상 남겨야 합니다.');
      var used2 = {};
      (data.groups || []).forEach(function (g) {
        (g.travelers || []).forEach(function (p) { var k = txt(p.ccg); if (k) used2[k] = (used2[k] || 0) + 1; });
      });
      // '지금 목록에 있던 것을 빼는' 경우만 막는다 — routes._clean_settings 와 동일.
      // (개편 직후 원장에만 남은 옛 코드까지 걸면 메일 한 줄 바꾸는 저장도 거부된다)
      var prevCodes = ccgByCd(data);
      Object.keys(used2).forEach(function (cd) {
        if (!codes[cd] && prevCodes[cd]) e.push('‘' + cd + '’ 은 이미 ' + used2[cd] + '건에 쓰이고 있어 지울 수 없습니다.');
      });
      var pw = txt(body.admin_pw) || String(cur.admin_pw || '');
      if (pw.length < 4 || pw.indexOf(' ') >= 0) e.push('비밀번호는 공백 없이 4자 이상이어야 합니다.');
      if (e.length) return err(e);
      var before = JSON.stringify([cur.mail_recipients, cur.ccg_teams, cur.admin_pw, cur.system_name, cur.reference_url, cur.approval_url]);
      cur.mail_recipients = mails.slice(0, 10);
      cur.ccg_teams = clean;
      cur.admin_pw = pw;
      cur.system_name = (txt(body.system_name) || cur.system_name || '').slice(0, 60);
      if ('reference_url' in body) cur.reference_url = txt(body.reference_url).slice(0, 200);
      if ('approval_url' in body) {                       // 사람이 누르는 링크라 http(s) 만
        var au = txt(body.approval_url).slice(0, 300);
        if (au && !/^https?:\/\//i.test(au)) return err(['결재 사이트 주소는 http:// 또는 https:// 로 시작해야 합니다.']);
        cur.approval_url = au;
      }
      var chg = before === JSON.stringify([cur.mail_recipients, cur.ccg_teams, cur.admin_pw, cur.system_name, cur.reference_url, cur.approval_url]) ? [] : ['settings'];
      appendAudit(data, '시스템 설정 변경', chg.length ? '변경됨' : '변경 없음', 'admin');
      Store.save(data);
      return okr({ settings: publicSettings(cur), changed: chg, ccg: ccgTeams(data) });
    }
    if (path === '/notice' && method === 'POST') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      data.settings.notice = String(body.notice || '').slice(0, 500).trim();
      data.settings.notice_sub = String(body.notice_sub || '').slice(0, 300).trim();
      appendAudit(data, '안내 문구 변경', data.settings.notice.slice(0, 60), 'admin');
      Store.save(data);
      return okr({ settings: publicSettings(data.settings) });
    }
    if (path === '/report' && method === 'GET') {
      return okr({ report: centerReport(data, qp('yq') || yearQuarter()) });
    }
    if (path === '/audit' && method === 'GET') {
      return okr({ audit: (data.audit_log || []).slice().reverse().slice(0, 200) });
    }
    if (path === '/backups' && method === 'GET') { return okr({ backups: Store.backups() }); }
    if ((m = path.match(/^\/backups\/([^/]+)\/restore$/)) && method === 'POST') {
      if (!isAdmin) return err('관리자 인증이 필요합니다.', 401);
      var fn = decodeURIComponent(m[1]);
      var au = (Store.load().audit_log || []).slice();
      au.push({ timestamp: nowISO(), actor: 'admin', action: '백업 복원', detail: fn });
      try { Store.restore(fn, au.slice(-500)); } catch (e6) { return err(e6.message); }
      return okr({});
    }
    return err('알 수 없는 요청입니다.', 404);
  }

  var API = {
    localApi: localApi, Store: Store, makeCsv: makeCsv,
    // 테스트/재사용용 내부 함수
    makeBudgetCsv: makeBudgetCsv, makeXls: makeXls,
    _: { num: num, won: won, tripDays: tripDays, quarter: quarter, yearQuarter: yearQuarter, yqList: yqList,
      normalizeGroup: normalizeGroup, validateGroup: validateGroup, validateBudget: validateBudget,
      dash: dash, makeMail: makeMail, seedData: seedData, CCG_TEAMS: CCG_TEAMS, CSV_HEADERS: CSV_HEADERS,
      effStatus: effStatus, groupRoll: groupRoll, procCounts: procCounts }
  };
  root.__localApi = localApi;
  root.__tbStore = Store;
  root.downloadBudgetCsv = function (yq) {
    var text = makeBudgetCsv(Store.load(), yq || null);
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = '예산리비전_' + (yq || '전체') + '_' + todayISO().replace(/-/g, '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
  root.downloadXls = function (yq, internal, gids) {
    var text = makeXls(Store.load(), yq || null, !!internal, gids);
    var blob = new Blob(['\ufeff' + text], { type: 'application/vnd.ms-excel;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = '소재국내출장비_' + (internal ? '내부관리' : '센터제출') + '_' + (yq || '전체')
      + ((gids && gids.length) ? '_선택' + gids.length + '건' : '') + '_' + todayISO().replace(/-/g, '') + '.xls';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
  root.downloadCsv = function (yq, internal, gids) {
    var text = makeCsv(Store.load(), yq || null, !!internal, gids);
    var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = '소재국내출장비_' + (internal ? '내부관리' : '센터제출') + '_' + (yq || '전체')
      + ((gids && gids.length) ? '_선택' + gids.length + '건' : '') + '_' + todayISO().replace(/-/g, '') + '.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
