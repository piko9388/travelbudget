/* 국내 출장비 관리 — 프런트 (서버 SSOT 렌더) */
'use strict';
const API = '/travelbudget/api';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const won = n => (Math.round(Number(n) || 0)).toLocaleString('ko-KR');
const fmtD = d => d ? d.slice(5).replace('-', '/') : '';
const KEYS = ['trans', 'lodg', 'meal', 'etc'];

/* 금액칸 — 천단위 자동 구분(0 개수 오입력 방지). 값 읽기는 반드시 mnum() 사용 */
function numFrom(t){
  // 붙여넣기·입력 공통 금액 파서. 콤마·'원'·공백은 버리고 소수점은 살려 반올림한다.
  // (소수점을 그냥 지우면 70000.4 → 700004 로 10배가 되어 원장이 틀어진다)
  const m = String(t ?? '').replace(/[^0-9.]/g, '').match(/^\d*\.?\d*/);
  const v = m ? parseFloat(m[0]) : NaN;
  return Number.isFinite(v) ? Math.round(v) : 0;
}
const mnum = el => numFrom(el && el.value);
function moneyFmt(el){
  const before = el.value.slice(0, el.selectionStart ?? el.value.length).replace(/[^0-9]/g, '').length;
  const raw = el.value.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, '');
  el.value = raw ? Number(raw).toLocaleString('ko-KR') : '';
  let seen = 0, pos = 0;
  while (pos < el.value.length && seen < before) { if (el.value[pos] >= '0' && el.value[pos] <= '9') seen++; pos++; }
  try { el.setSelectionRange(pos, pos); } catch (e) {}
}
const mfield = (cls, val, ph, fn) =>
  `<input type="text" inputmode="numeric" class="mny ${cls}" value="${val ? won(val) : ''}" placeholder="${ph}" oninput="moneyFmt(this);${fn}">`;

const TITLES = {guide:'이용 안내', dash:'대시보드', plan:'출장 계획 등록', actual:'출장 실적 입력',
  list:'출장 내역', process:'이관·처리 관리', budget:'예산 관리', data:'데이터 관리',
  config:'시스템 설정',
  bulk:'엑셀 일괄 등록'};
const SUBS = {guide:'계획 작성부터 처리 완료까지 — 한눈에 보는 처리 흐름',
  dash:'가용 잔여 = 총 예산 − 처리 완료 − 처리 중 − 확정 예정', plan:'동행 출장은 출장자 행을 추가해 한 번에 등록',
  actual:'실적 저장 시 실비 이관 인폼이 자동 생성됩니다', list:'분기 전체 출장 이력',
  process:'실적 입력·인폼 → 소재 이관 → 처리 완료', budget:'예산 리비전 등록·이력 (감액은 자동 음수 처리)',
  data:'CSV 내보내기 · 자동 백업(30개) · 복원',
  config:'CCG팀 · 인폼 수신인 등 — 코드 수정 없이 여기서 고칩니다',
  bulk:'센터 관리 시트에서 복사해 붙여넣으면 한 번에 등록됩니다'};

let ST = null, YQ = null, VIEW = 'dash';

function adminPw(){ return sessionStorage.getItem('tb_pw') || ''; }
async function api(path, opt = {}){
  opt.headers = Object.assign({'Content-Type':'application/json'}, opt.headers || {});
  if (adminPw()) opt.headers['X-Admin-PW'] = adminPw();
  const r = await fetch(API + path, opt);
  const b = await r.json().catch(() => ({}));
  return {ok: r.ok, status: r.status, data: b};
}
let BUSY = false;
async function once(btnSel, fn){          // 연속 클릭 = 이중 등록 → 실제로 잠근다
  if (BUSY) return;
  BUSY = true;
  const b = btnSel && $(btnSel);
  const label = b && b.textContent;
  if (b) { b.disabled = true; b.textContent = '처리 중…'; }
  try { await fn(); }
  finally {
    BUSY = false;
    if (b && b.isConnected) { b.disabled = false; b.textContent = label; }
  }
}
function toast(m){ const t = document.createElement('div'); t.className = 'toast';
  t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }
async function copyText(text, msg = '본문을 복사했습니다'){
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(text); toast(msg); return; }
    const ta = document.createElement('textarea');   // 사내 비-HTTPS 등 clipboard 미지원 환경 폴백
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const okc = document.execCommand('copy'); ta.remove();
    toast(okc ? msg : '복사할 수 없습니다 — 본문을 직접 선택해 복사하세요');
  } catch (e) { toast('복사할 수 없습니다 — 본문을 직접 선택해 복사하세요'); }
}
function showErr(sel, errs){ $(sel).innerHTML =
  `<div class="err">${(errs || ['요청 실패']).map(esc).join('\n')}</div>`; }
function stClass(s){ return s === '처리 완료' ? 'done' : s === '취소' ? 'cancel'
  : s === '확정 예정' ? 'confirm'
  : (s === '실적 입력·인폼' || s === '소재 이관') ? 'wip' : ''; }
// 화면 표기만 바꾼다 — data.json·CSV·센터 양식의 저장값은 그대로여야 하므로 여기서만 치환
const ST_LABEL = {'계획 등록': '계획(잠정)', '확정 예정': '출장 확정 · 예산 반영'};
// 좁은 칸(표 머리 필터)에서는 짧은 쪽을 쓴다 — 긴 이름은 잘려서 오히려 못 읽는다
const ST_SHORT = {'계획 등록': '계획(잠정)', '확정 예정': '출장 확정', '실적 입력·인폼': '실적·인폼'};
function dispSt(s){ return ST_LABEL[s] || s; }
function shortSt(s){ return ST_SHORT[s] || s; }
function gname(g){ return [g.city, g.org].filter(Boolean).join(' '); }
function names(g){ return (g.travelers || []).map(p => esc(p.name)).join(', '); }
function procTag(g){   // 부분 처리(개인별 상태 분리) 표시 — 섞여 있을 때만
  const p = g.proc;
  if (!p || ['계획 등록', '확정 예정', '취소'].includes(g.status) || p.done === p.total) return '';
  // 상태가 한 종류뿐이면 같은 행 첫 칸 배지가 이미 그 말을 한다 — 보류가 있을 때만 예외로 노출
  const buckets = [p.done, p.transfer, p.inform].filter(n => n > 0).length;
  if (!p.hold && buckets <= 1) return '';
  const bits = [];
  if (p.done) bits.push(`완료 ${p.done}`);
  if (p.transfer) bits.push(`이관 ${p.transfer}`);
  if (p.inform) bits.push(`인폼 ${p.inform}`);
  if (p.hold) bits.push(`보류 ${p.hold}`);
  if (!bits.length) return '';                 // 표시할 게 없으면 빈 괄호를 만들지 않는다
  return ` <span class="sub" style="color:${p.hold ? 'var(--red)' : 'var(--mut)'}">(${bits.join(' · ')})</span>`;
}

async function load(){
  const {data} = await api('/state' + (YQ ? '?yq=' + encodeURIComponent(YQ) : ''));
  ST = data; YQ = data.yq;
  const qs = $('#qsel');
  const opts = [...new Set([...data.yqList, YQ])];
  qs.innerHTML = opts.map(q => `<option${q === YQ ? ' selected' : ''}>${q}</option>`).join('');
  const vEl = $('#appVer');
  if (vEl && data.version) vEl.textContent = `${data.version.v} · ${data.version.build}`;
  // 이름표도 설정을 따라간다 — [시스템 설정]에서 이름을 바꾸면 좌측 상단도 같이 바뀐다
  const nEl = $('#brandName');
  const sysNm = data.settings && data.settings.system_name;
  if (nEl && sysNm) { nEl.textContent = sysNm; document.title = sysNm; }
  qs.onchange = e => {
    const dirty = ($('#travBody')?.querySelector('.t-nm')?.value.trim()) || ACT_GID;
    if (dirty && !confirm('입력 중인 내용이 저장되지 않았습니다. 분기를 변경하면 사라집니다. 계속할까요?')) {
      e.target.value = YQ; return;
    }
    YQ = e.target.value; load();
  };
  renderAll();
  nav(VIEW);          // 제목·부제·aria-current 를 첫 화면부터 맞춘다 (안 그러면 첫 클릭에 헤더가 밀린다)
}
const ADMIN_VIEW = {                       // 인증 통과 후 다시 그릴 화면
  get process(){ return rProcess; }, get budget(){ return rBudget; }, get config(){ return rConfig; },
};
function nav(v){
  VIEW = v;
  $$('.nav a[data-view]').forEach(a => {
    const on = a.dataset.view === v;
    a.classList.toggle('on', on);
    a.setAttribute('aria-current', on ? 'page' : 'false');
  });
  $$('.view').forEach(x => x.classList.remove('on'));
  $('#v-' + v).classList.add('on');
  $('#pageTitle').textContent = TITLES[v];
  $('#pageSub').textContent = SUBS[v];
}
// 좌측 상단 이름표 — 어디서든 누르면 대시보드로. (메뉴에도 대시보드가 있지만,
// 로고를 누르면 첫 화면으로 가는 것이 사람들이 가장 먼저 시도하는 동작이다)
{
  const brand = $('#brandHome');
  if (brand) {
    const home = () => nav('dash');
    brand.onclick = home;
    brand.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); home(); } };
  }
}
$$('.nav a[data-view]').forEach(a => {          // href 를 가진 외부 링크(출장자용 안내)는 제외
  a.tabIndex = 0; a.setAttribute('role', 'link');   // 키보드 탭 이동·엔터 선택
  const go = () => {
    const v = a.dataset.view;
    if (['process', 'budget', 'config'].includes(v) && !adminPw()) {
      // 인증이 풀린 뒤에도 이전에 그려둔 관리자 화면이 모달 뒤에 남아 있으면 안 된다.
      // 비웠으니 인증에 성공하면 그 화면만 다시 그린다 (안 그리면 빈 화면이 남는다)
      const el = $('#v-' + v); if (el) el.innerHTML = '';
      askAdmin(async () => { const f = ADMIN_VIEW[v]; if (f) await f(); nav(v); });
      return;
    }
    nav(v);
  };
  a.onclick = go;
  a.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
});
/* 엔터 = 제출 (한글 조합 중 엔터는 무시) */
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing || e.shiftKey || e.ctrlKey || e.metaKey) return;
  const el = e.target;
  if (!el || !el.matches || !el.matches('input:not([type=checkbox]):not([readonly])')) return;
  // 표 안에서는 Enter 로 제출하지 않는다 — 칸이 여러 개라 '지금까지 친 것'이 '다 친 것'이 아니다.
  // (표 바깥 단일 입력칸의 Enter 제출은 그대로 둔다)
  if (el.closest('#adminModal') || el.closest('.filter-row') || el.closest('.trav-table')) return;
  const fn = el.closest('#v-plan') ? submitPlan : el.closest('#v-actual') && ACT_GID ? submitActual : null;
  if (fn) { e.preventDefault(); fn(); }
});
function renderAll(){ rGuide(); rDash(); rPlan(); rBulk(); rActual(); rList(); rProcess(); rBudget(); rData(); rConfig(); }

/* QWEN_PROMPT_START — QWEN_PROMPT.md 에서 자동 주입. 직접 고치지 말 것 */
const QWEN_PROMPT = `당신은 사내 출장비 데이터 변환기입니다.
아래 [원본 데이터]를 [출력 스펙]에 맞는 JSON 하나로 변환하세요.
설명·주석·마크다운 없이 **JSON만** 출력합니다.

────────────────────────────────
[출력 스펙]

최상위 구조:
{
  "schema_version": "2.0",
  "settings": { ... },
  "budget": [ ... ],
  "groups": [ ... ],
  "audit_log": []
}

■ settings (그대로 사용, 수정 금지)
{
  "system_name": "소재 국내 출장비 관리",
  "admin_pw": "2071478",
  "mail_recipients": ["junghoon12.lee@sk.com", "eunjeong5.kim@sk.com"],
  "reference_url": "material.skhynix.com/travelbudget"
}

■ budget[] — 분기 예산 배정 이력. 한 줄 = 한 번의 배정/증액/감액
{ "rev_id": "B-0001", "yq": "2026-3Q", "rev_dt": "2026-07-01",
  "rev_type": "최초배정", "amt": 9000000, "reason": "분기 정기 배정" }
  - yq: 반드시 "YYYY-NQ" (예 2026-3Q). 1~3월=1Q, 4~6월=2Q, 7~9월=3Q, 10~12월=4Q
  - rev_type: 최초배정 / 추가증액 / 감액 / 이월  중 하나
  - amt: 정수(원). 감액은 반드시 음수 (예 -1000000)
  - 원본에 예산 정보가 없으면 budget 은 [] 로 두세요. 금액을 지어내지 마세요.

■ groups[] — 출장 1건 = 1개 객체. **같이 간 사람은 travelers 배열로 묶습니다**
{
  "group_id": "TB-0001",
  "plan_type": "계획",
  "status": "처리 완료",
  "city": "청주",
  "org": "원익머트리얼즈",
  "purpose": "NF3 순도 관리 정기 Audit",
  "kind": "정기 Audit",
  "dep_dt": "2026-08-04",
  "ret_dt": "2026-08-05",
  "car": "자차사용",
  "remark": "",
  "travelers": [
    { "name": "박영희", "emp_no": "20140508", "rank": "팀장", "ccg_nm": "EDTW소재기술",
      "p_trans": 70000, "p_lodg": 95000, "p_meal": 65000, "p_etc": 10000,
      "a_trans": 65000, "a_lodg": 90000, "a_meal": 60000, "a_etc": 10000 }
  ]
}

■ 필드 매핑 (원본 열 이름 → JSON 키)
  구분              → plan_type
  출장도시           → city
  출장기관&업체       → org
  출장목적&사유       → purpose
  출발일자           → dep_dt      (YYYY-MM-DD 로 변환)
  복귀일자           → ret_dt      (YYYY-MM-DD 로 변환)
  자차사용여부        → car
  출장구분           → kind
  비고              → remark
  사번              → travelers[].emp_no
  성명              → travelers[].name
  직책              → travelers[].rank
  CCG명             → travelers[].ccg_nm
  계획_교통비        → travelers[].p_trans
  계획_숙박비        → travelers[].p_lodg
  계획_식대&잡비      → travelers[].p_meal
  계획_기타          → travelers[].p_etc
  실적_교통비        → travelers[].a_trans
  실적_숙박비        → travelers[].a_lodg
  실적_식대&잡비      → travelers[].a_meal
  실적_기타          → travelers[].a_etc

  ※ LV2, CCG(코드), 출장일수, 출장시점, 계획_총합계, 실적_총합계 는 **출력하지 마세요.**
     시스템이 자동 계산합니다. 넣으면 오히려 틀립니다.

■ 열거값 — 아래 글자와 **정확히** 일치해야 합니다 (띄어쓰기·기호 포함)
  plan_type : 계획 / 변경 / 긴급
  status    : 계획 등록 / 확정 예정 / 실적 입력·인폼 / 소재 이관 / 처리 완료 / 취소
  rank      : TL / 팀장
  car       : 미사용 / 자차사용
  kind      : 기술교류(Live Demo, Data 분석) / 실사&사양 개선,협의 / 정기 Audit /
              비정기 Audit(Issue/Theme) / 기타
  ccg_nm    : 소재전략 / P&C소재 / Patterning소재기술 / Patterning소재개발 /
              C&C소재기술 / C&C소재개발 / EDTW소재기술 / EDTW소재개발
              (CCG 번호로 적혀 있으면 그대로 두지 말고 위 팀 이름으로 바꾸세요.
               50110502=소재전략 50128121=P&C소재 50119135=Patterning소재기술
               50077468=Patterning소재개발 50139632=C&C소재기술 50134405=C&C소재개발
               50119134=EDTW소재기술 50103536=EDTW소재개발)

  주의 1) "실적 입력·인폼" 의 가운뎃점은 U+00B7 (·) 입니다. 마침표(.)나 중점(・) 금지.
  주의 2) "식대&잡비", "실사&사양 개선,협의" 의 & 와 쉼표는 그대로 씁니다.
  주의 3) 원본 값이 위 목록에 없으면 가장 가까운 값으로 매핑하고,
          정말 애매하면 kind 는 "기타", plan_type 은 "계획" 으로 두세요.

■ 변환 규칙 (중요)

1) 그룹 묶기 — 원본이 "1인 1행"이면, 아래가 모두 같은 행들은 **한 group 으로 합치고**
   각 사람을 travelers 배열에 넣습니다.
     출장도시 + 출장기관&업체 + 출발일자 + 복귀일자 + 출장목적&사유
   (같은 출장을 다녀온 동행자입니다. 절대 사람 수만큼 group 을 만들지 마세요.)

2) group_id — "TB-0001" 부터 순번으로 부여. 전체에서 유일해야 합니다.

3) emp_no — **문자열**로. 앞의 0 이 있으면 유지 ("0012345"). 같은 group 안에서 중복 금지.
   중복이면 서로 다른 사람인지 확인하고, 정말 같은 사람이면 한 명으로 합치세요.

4) 금액 — **정수(원)**. 콤마·"원"·공백 제거. 빈 칸은 0.
   소수점이 있으면 반올림. 음수는 0 으로. 1억(100000000)을 넘는 값은 자릿수 오류이니
   원본을 그대로 두지 말고 해당 건을 [확인필요] 목록에 올리세요.

5) status 판정 — **원본에 근거가 있을 때만** 아래로 정합니다.
     정산/지급 완료가 원본에 명시된 건            → "처리 완료"
     이관했다고 명시된 건                        → "소재 이관"
     실적 금액이 있으나 처리 여부는 불명          → "실적 입력·인폼"
     아직 안 갔고 실제로 간다고 명시된 건         → "확정 예정"
     아직 안 갔고 갈지 미정인 건                 → "계획 등록"
     취소된 건                                  → "취소"

   [주의] 실적 금액이 있다는 이유만으로 "처리 완료" 로 추론하지 마세요.
     처리 완료는 돈이 실제로 나갔다는 뜻이라, 잘못 넣으면 예산 잔액이 틀어집니다.
     근거가 없으면 실적이 있어도 "실적 입력·인폼", 실적이 없으면 "계획 등록" 으로 두고
     해당 건을 _confirm_needed 에 적으세요.

6) 사람마다 처리 상태가 다른 경우 — 5명 중 3명만 처리됐다면
   각 traveler 에 "status" 를 개별로 넣습니다. 허용값:
     실적 입력·인폼 / 소재 이관 / 처리 완료 / 보류
   (예: 예산 부족으로 못 넘긴 사람은 "보류")
   전원이 같은 상태면 traveler 의 status 는 넣지 마세요.

7) 날짜 — 반드시 "YYYY-MM-DD". "2026.8.4", "26/08/04", "8월 4일" 등은 모두 변환.
   연도가 없으면 같은 시트의 다른 행이나 분기 정보로 추정하고, 추정한 건은 [확인필요]에 올리세요.
   복귀일이 출발일보다 빠르면 안 됩니다(당일 출장은 두 날짜가 같음).

8) 없는 값은 **지어내지 마세요.** 문자열은 "", 금액은 0 으로 둡니다.

────────────────────────────────
[출력 전 자가 점검 — 통과 못 하면 고쳐서 다시 출력]

□ 출력 전체가 JSON 하나인가 — json.load() 로 바로 읽히는가 (코드펜스·설명문 없이)
□ 최상위에 settings / budget / groups / audit_log 가 모두 있는가
□ 모든 group 에 travelers 가 1명 이상 있는가
□ 모든 group_id 가 유일한가
□ 같은 group 안에 emp_no 중복이 없는가
□ 모든 dep_dt / ret_dt 가 YYYY-MM-DD 이고, ret_dt >= dep_dt 인가
□ status / kind / rank / car / plan_type / ccg_nm 이 전부 허용값 목록과 글자까지 같은가
□ 모든 금액이 콤마 없는 정수인가 (0 이상, 1억 이하)
□ LV2·CCG코드·출장일수·총합계 같은 자동계산 필드를 넣지 않았는가
□ 근거 없이 "처리 완료" 로 추론한 건이 없는가

[출력 형식 — 반드시 지킬 것]
출력 전체가 **JSON 하나**여야 합니다. json.load() 로 바로 읽히지 않으면 실패입니다.
- 마크다운 코드펜스 금지, 인사말·설명·주석 금지, JSON 앞뒤에 어떤 글자도 붙이지 마세요.
- 판단이 애매했던 건은 **JSON 안의 _confirm_needed 배열**에 넣습니다. (시스템은 이 키를 무시합니다)

  "_confirm_needed": [
    "TB-0007 : 복귀일자 없음 → 출발일과 같게 처리",
    "TB-0012 : 실적 3,200,000원 (원본 자릿수 확인 요망)"
  ]

애매한 건이 없으면 "_confirm_needed": [] 로 둡니다.

────────────────────────────────
[원본 데이터]

(여기에 엑셀/CSV 내용을 붙여넣으세요)`;
/* QWEN_PROMPT_END */

/* ═══ 이용 안내 (처리 흐름) ═══ */
function rGuide(){
  const to = (ST.settings && ST.settings.mail_recipients || []).map(esc).join(', ');
  const step = (n, cls, status, title, role, roleCls, what, auto, jump) => `
    <div class="gstep ${cls}">
      <div class="gnum">${n}</div>
      <div class="gbody">
        <div class="gtitle"><span class="status ${stClass(status)}">${status}</span> ${title}
          <span class="grole ${roleCls}">${role}</span></div>
        <div class="gwhat">${what}</div>
        ${auto ? `<div class="gauto">자동 · ${auto}</div>` : ''}
        ${jump ? `<div class="btns" style="margin-top:8px">${jump}</div>` : ''}
      </div>
    </div>`;
  const lead = `
    <div class="g-lead">
      <a class="btn sm pri" href="/travelbudget/guide" target="_blank" rel="noopener"
         style="float:right;margin-left:12px">자세한 사용법 · 인쇄용 ↗</a>
      <h2>출장비는 이런 순서로 처리됩니다</h2>
      <p>출장 가시는 분은 <b>계획</b>과 <b>실적</b>만 넣으시면 됩니다. 메일 만들기와 이관·정산은
      <b>소재 출장 예산 담당자</b>와 시스템이 맡습니다. 같이 간 사람이 여럿이어도 <b>메일은 한 통</b>입니다.</p>
      <div class="g-formula">가용 잔여 = 총 예산 − 처리 완료 − 처리 중 − 확정 예정(확보)</div>
    </div>
    <div class="card">
      <div class="flowbar">
        <span class="pill">① 계획(잠정)·확정</span><span class="arrow">→</span>
        <span class="pill wip">② 실적·인폼</span><span class="arrow">→</span>
        <span class="pill wip">③ 소재 이관</span><span class="arrow">→</span>
        <span class="pill done">④ 처리 완료</span>
      </div>`;
  const steps =
    step(1, '', '계획 등록', '계획을 등록하고, 정말 가는 건은 확정합니다', '담당자', 'owner',
      '<b>출장 계획 등록</b>에 도시·업체·목적·일자와 사람별 예상 비용을 넣습니다. 여러 건이면 <b>엑셀 일괄 등록</b>에 시트를 붙여넣으세요.',
      '잠정 계획은 예산에 잡히지 않습니다. 확정하면 그만큼 가용 잔여에서 빠집니다.',
      `<button class="btn pri" onclick="nav('plan')">출장 계획 등록으로 가기 →</button>`) +
    step(2, '', '실적 입력·인폼', '다녀와서 실제 쓴 금액을 넣습니다', '담당자', 'owner',
      '<b>출장 실적 입력</b>에 실제 쓴 금액을 넣으면 메일이 만들어집니다. 그 표를 끌어다 메일 본문에 놓으면 됩니다.',
      '계획과의 차액은 자동으로 계산됩니다. 긴급 출장은 비고를 꼭 적어야 합니다.',
      `<button class="btn pri" onclick="nav('actual')">출장 실적 입력으로 가기 →</button>`) +
    step(3, 'admin', '소재 이관', '예산 담당자가 이관하고 소재 담당자에게 메일을 보냅니다', '예산 담당자', 'admin',
      '예산 담당자가 이관 결재를 올리고 소재 담당자에게 메일을 보냅니다. <b>사람별로 따로</b> 이관·완료·보류할 수 있습니다.',
      '이관하면 비용 처리 요청 메일이 만들어집니다. 보류된 건은 대시보드 바로 할 일에 표시됩니다.',
      `<button class="btn" onclick="nav('list')">내 출장 상태 확인 (출장 내역) →</button>`) +
    step(4, 'done', '처리 완료', '소재 담당자가 비용을 처리하면 끝납니다', '소재 담당자', 'owner',
      '소재 담당자가 비용을 처리하면 예산 담당자가 <b>처리 완료</b>로 표시합니다. 이 금액이 최종으로 빠집니다.',
      '', '') +
    step('취', 'cancel', '취소', '안 가게 되면 취소합니다', '담당자·예산 담당자', 'owner',
      '잠정 계획은 <b>삭제</b>, 확정한 뒤라면 <b>출장 취소</b>를 누릅니다. 확보됐던 예산은 다시 풀립니다.',
      '', '');
  const money = `
      <div class="note" style="margin:16px 0 0">
        예산 계산 — <b>가용 잔여 = 총 예산 − 처리 완료 − 처리 중 − 확정 예정(확보)</b>.
        <b>잠정 계획</b>은 참고용이라 예산에 잡히지 않고, <b>확정 예정</b>은 미리 확보해 둔 금액입니다. 실제 집행은 처리 중·처리 완료로 반영됩니다.
      </div></div>`;
  const legend = `
    <div class="card"><h2>배지 진하기 보는 법</h2>
      <p class="cap">단계가 진행될수록 배지가 진해집니다. <b>진할수록 이미 나간 돈</b>이라,
        색을 외우지 않고 진하기만 보시면 됩니다.</p>
      <div class="glegend">
        <span><span class="status">계획(잠정)</span> 예산 미반영</span>
        <span class="arrow">→</span>
        <span><span class="status confirm">확정 예정</span> 예산 선확보</span>
        <span class="arrow">→</span>
        <span><span class="status wip">처리 중</span> 실적·인폼 / 소재 이관</span>
        <span class="arrow">→</span>
        <span><span class="status done">처리 완료</span> 정산 끝</span>
      </div>
      <p class="cap" style="margin:8px 0 0">단계가 아닌 것은 빨강으로 따로 표시합니다.</p>
      <div class="glegend">
        <span><span class="status cancel">취소</span> 취소된 건</span>
        <span><span class="status urgent">긴급</span> 긴급 출장</span>
        <span><span class="status hold">보류</span> 처리가 막힌 건</span>
      </div></div>`;
  const faq = `
    <div class="card"><h2>자주 묻는 것</h2>
      <div class="gwhat"><b>· 같이 출장 가면?</b> 한 분이 대표로 등록하고 <b>동행자 행을 추가</b>하세요. 비용은 사람별로 저장되고, 메일은 <b>한 통</b>만 나갑니다.</div>
      <div class="gwhat"><b>· 메일은 누구에게 보내나요?</b> ${to || '설정된 수신자'} 앞으로 보낼 초안이 만들어집니다.</div>
      <div class="gwhat"><b>· 5명 중 일부만 처리됐다면?</b> 처리 관리에서 <b>사람별로</b> 완료·보류를 따로 정할 수 있습니다. 3명 완료·1명 보류 같은 상태가 예산·대시보드에 그대로 반영됩니다.</div>
      <div class="gwhat"><b>· 내 출장이 어디까지 왔는지?</b> <a onclick="nav('list')" style="color:var(--navy);cursor:pointer;font-weight:700">‘출장 내역’</a>에서 상태 배지로 확인하세요.</div>
    </div>`;
  $('#v-guide').innerHTML = lead + steps + money + legend + faq;
}

/* ═══ 대시보드 ═══ */
function rDash(){
  const d = ST.dash;
  const av = d.avail !== undefined ? d.avail : d.remain;
  const burn = d.alloc ? Math.round((d.done + d.wip + (d.commit || 0)) / d.alloc * 100) : 0;
  // 예산 한 장 — 큰 숫자 1개(가용) + 구성 막대 1개.
  // 이전엔 hero 공식과 KPI 카드 4장이 총 예산·처리 완료·처리 중·확정 예정 을 두 번씩
  // 보여주고 있었다(같은 네 숫자의 중복). 막대 하나로 합쳐 한 번만 보여준다.
  const segs = [
    {k: 'done', label: '처리 완료', v: d.done},
    {k: 'wip',  label: '처리 중',   v: d.wip},
    {k: 'cmt',  label: '확정 예정', v: d.commit || 0},
    {k: 'ava',  label: '가용 잔여', v: Math.max(0, av)},
  ].filter(x => x.v > 0);
  const segTot = segs.reduce((a, x) => a + x.v, 0) || 1;
  const hero = `
    <div class="hero ${d.short ? 'alert' : d.alloc > 0 ? '' : 'unset'}">
      <div class="hmain">
        <div class="hleft">
          <div class="label"><span class="lamp"></span>가용 잔여</div>
          <div class="amount">${av < 0 ? '−' : ''}${won(Math.abs(av))}<span class="won">원</span></div>
          <div class="msg">${d.short
            ? '확정·집행이 예산을 초과했습니다 — 센터 검토 및 추가 확보 필요'
            : d.alloc > 0 ? '정상 운영 중입니다'
            : '이 분기 예산이 아직 배정되지 않았습니다'}</div>
          ${d.alloc > 0 ? '' : `<div class="btns" style="margin-top:8px">
            <button class="btn sm pri" onclick="goBudget()">예산 배정하기 →</button></div>`}
        </div>
        <div class="hright">
          <div class="label">총 예산</div>
          <div class="htot">${won(d.alloc)}<span class="won">원</span></div>
          <div class="sub">소진율 ${burn}% · 리비전 ${ST.budget.length}회</div>
        </div>
      </div>
      ${d.alloc > 0 ? `
      <div class="stack" role="img" aria-label="예산 구성">
        ${segs.map(x => `<i class="s-${x.k}" style="width:${(x.v / segTot * 100).toFixed(2)}%"
           title="${x.label} ${won(x.v)}원"></i>`).join('')}
      </div>
      <div class="skey">
        ${segs.map(x => `<span><i class="s-${x.k}"></i>${x.label} <b>${won(x.v)}</b></span>`).join('')}
      </div>` : ''}
      ${d.alloc > 0 && d.planAmt > 0 ? `
      <div class="ghost">
        <div class="gl">잠정 계획 <b>${won(d.planAmt)}원</b> · ${d.nPlan || 0}건 — 아직 예산에 잡히지 않았습니다</div>
        <div class="stack" role="img"
             aria-label="잠정 계획 ${won(d.planAmt)}원, 총 예산 대비 ${(d.planAmt / d.alloc * 100).toFixed(1)}퍼센트">
          <i style="width:${Math.min(100, d.planAmt / d.alloc * 100).toFixed(2)}%"
             title="잠정 계획 ${won(d.planAmt)}원"></i>
        </div>
      </div>` : `
      ${d.planAmt > 0 ? `<div class="hnote">잠정 계획 <b>${won(d.planAmt)}원</b> (${d.nPlan || 0}건) 은 예산에 반영되지 않습니다
        — 실제로 가는 건은 <b>출장 확정</b> 시 ‘확정 예정’으로 잡힙니다.</div>` : ''}`}
    </div>`;
  const nt = (ST.settings && ST.settings.notice) || '';
  const ns = (ST.settings && ST.settings.notice_sub) || '';
  const notice = (nt || ns || adminPw()) ? `
    <div class="notice">
      <div id="noticeView" ${NOTICE_EDIT ? 'style="display:none"' : ''}>
        <div class="nt">${nt ? esc(nt) : '<span style="color:var(--faint);font-weight:500">안내 문구가 없습니다 — 예산 담당자가 등록할 수 있습니다.</span>'}</div>
        ${ns ? `<div class="ns">${esc(ns)}</div>` : ''}
        <div class="ne"><button class="btn sm" onclick="editNotice(true)">안내 문구 수정</button></div>
      </div>
      <div id="noticeEdit" ${NOTICE_EDIT ? '' : 'style="display:none"'}>
        <label>안내 문구 (대시보드 상단 노출)</label>
        <textarea id="nt_main">${esc(nt)}</textarea>
        <label style="margin-top:8px">보조 문구 (괄호 안내 등)</label>
        <input id="nt_sub" value="${esc(ns)}">
        <div class="btns" style="margin-top:8px">
          <button class="btn pri sm" onclick="saveNotice()">저장</button>
          <button class="btn sm" onclick="editNotice(false)">취소</button>
        </div>
      </div>
    </div>` : '';
  // 바로 할 일 — 건수 버튼이 아니라 큐. 서버가 group_id 배열을 정확히 주는데(core.dash todo)
  // 전에는 .length 만 쓰고 버렸다. 그래서 '1건'을 눌러 가면 드롭다운엔 4건이 있고,
  // 어느 1건인지, 며칠 묵었는지가 화면 어디에도 없었다.
  const aw = d.todo.actual_wait.length, pw = d.todo.process_wait.length, hd = (d.todo.hold || []).length;
  const QMAX = 6;
  const qitem = (gid, kind, cls, label, act, fn) => {
    const g = ST.groups.find(x => x.group_id === gid);
    if (!g) return null;
    const n = daysSince(g.ret_dt);
    return {g, kind, cls, label, act, fn, d: (n != null && n >= 0) ? n : null};
  };
  const qrows = [
    ...(d.todo.hold || []).map(id => qitem(id, 'hold', 'red', '보류', '처리 관리 →', 'openProcess')),
    ...d.todo.actual_wait.map(id => qitem(id, 'act', '', '실적 대기', '실적 입력 →', 'openActual')),
    ...d.todo.process_wait.map(id => qitem(id, 'proc', '', '이관·처리', '처리 관리 →', 'openProcess')),
  ].filter(Boolean).sort((a, b) => (b.d ?? -1) - (a.d ?? -1));   // 오래 묵은 건이 위로
  const dcol = n => n == null ? 'var(--mut)'
    : n >= 7 ? 'var(--red)' : n >= 3 ? 'var(--amber)' : 'var(--mut)';
  // 복귀 전(d=null)은 급할 이유가 없으니 큐 아래로
  const todo = qrows.length ? `
    <div class="card"><h2>바로 할 일</h2>
      <p class="cap">오래 묵은 순. 누르면 그 건으로 갑니다.</p>
      <div class="queue">
        ${qrows.slice(0, QMAX).map(r => `<div class="qrow">
          <div class="qk${r.cls === 'red' ? ' warn' : ''}">${r.label}</div>
          <div class="qnm">${esc(gname(r.g))} <span class="sub">${esc(names(r.g))}</span></div>
          <div class="qd" style="color:${dcol(r.d)}">${r.d == null ? '–' : 'D+' + r.d}</div>
          <button class="btn sm${r.cls === 'red' ? ' red' : ''}"
            onclick="${r.fn}('${r.g.group_id}')">${r.act}</button>
        </div>`).join('')}
        ${qrows.length > QMAX ? `<div class="qmore">외 ${qrows.length - QMAX}건 —
          <a onclick="nav('list')" style="color:var(--navy);cursor:pointer;font-weight:700">출장 내역</a>에서 전체 보기</div>` : ''}
      </div>
      <div class="btns"><button class="btn" onclick="showReport()">센터 제출 리포트</button></div>
    </div>` : `
    <div class="card"><h2>바로 할 일</h2><p class="cap">지금 처리할 건이 없습니다.</p>
      <div class="btns" style="margin-top:0"><button class="btn" onclick="showReport()">센터 제출 리포트</button></div></div>`;
  // ── CCG팀별 집행 — 막대로 도식화. 잠정(예산 미반영)은 표에서 빼고 아래에 따로 표기.
  //    (잠정 금액을 같은 표에 두면 실제 집행액보다 커져 숫자가 튀어 보임)
  // 부서별 구분은 실집행(처리 중 + 처리 완료) 기준. 확정 예정은 아직 안 쓴 돈이라
  // 합계·구성비에서 빼고 막대 뒤에 흐리게 덧붙인다 — '앞으로 들어올 것'으로만 읽히게.
  const rowsData = d.byCcg;
  const barTot = Math.max(1, rowsData.reduce((a, r) => a + r.total, 0));
  const seg = (v, cls) => v > 0 ? `<i class="${cls}" style="width:${(v / barTot * 100).toFixed(2)}%"></i>` : '';
  const bars = rowsData.map(r => {
    const cm = r.commit || 0;
    return `<div class="brow${r.total ? '' : ' only-cmt'}">
      <div class="bnm">${esc(r.team)}<span class="sub"> ${r.total ? `${r.people}명` : `예정 ${r.cpeople || 0}명`}</span></div>
      <div class="bbar" title="처리 완료 ${won(r.done)} · 처리 중 ${won(r.wip)}${cm ? ` / 확정 예정 ${won(cm)}` : ''}">
        ${seg(r.done, 'sd')}${seg(r.wip, 'sw')}${seg(cm, 'sc ghost-seg')}</div>
      <div class="bval">${r.total ? won(r.total) : '–'}<span class="sub"> ${r.total ? Math.round(r.share * 100) + '%' : '예정'}</span></div>
    </div>`;
  }).join('') || '<div class="note" style="margin:0">집행 내역이 없습니다.</div>';
  const cmtTot = rowsData.reduce((a, r) => a + (r.commit || 0), 0);

  const rows = rowsData.map(r => `<tr>
    <td><b>${esc(r.team)}</b> <span class="sub">${r.ccg}</span></td>
    <td class="num">${won(r.done)}</td><td class="num">${won(r.wip)}</td>
    <td class="num" style="color:var(--s2)">${won(r.commit || 0)}</td>
    <td class="num"><b>${won(r.done + r.wip + (r.commit || 0))}</b></td>
    <td class="num">${(r.share * 100).toFixed(1)}%</td>
    <td class="num">${r.people}</td></tr>`).join('')
    || '<tr><td colspan="7" style="color:var(--faint);text-align:center;padding:16px">집행 내역이 없습니다.</td></tr>';
  const tot = rowsData.reduce((a, r) => ({done: a.done + r.done, wip: a.wip + r.wip,
    commit: a.commit + (r.commit || 0), people: a.people + r.people}), {done:0, wip:0, commit:0, people:0});
  const totSum = tot.done + tot.wip + tot.commit;
  // 비목 구성 — CCG(누가 썼나) 다음에 무엇에 썼나. 같은 합계를 다른 축으로.
  // 단계 음영과 헷갈리지 않도록 색으로 나누지 않고 이름·길이로만 구분한다.
  function costStrip(d){
    const cs = (d.byCost || []).filter(c => c.amt > 0);
    const sum = cs.reduce((a, c) => a + c.amt, 0);
    if (!sum) return '';
    // CCG 막대와 같은 규칙 — 분모는 합계. 라벨이 35%면 막대도 35%.
    const denom = Math.max(1, sum);
    return `<div class="cost"><div class="ct">비목 구성 <span>합계 ${won(sum)}원</span></div>
      <div class="bars">${cs.map(c => `<div class="brow">
        <div class="bnm">${c.name}</div>
        <div class="bbar" title="${c.name} ${won(c.amt)}원"><i style="width:${(c.amt / denom * 100).toFixed(2)}%"></i></div>
        <div class="bval">${won(c.amt)}<span class="sub"> ${Math.round(c.share * 100)}%</span></div>
      </div>`).join('')}</div></div>`;
  }

  const ccg = !rowsData.length ? `
    <div class="card">
      <h2>CCG팀(부서)별 집행 현황</h2>
      <div class="note" style="margin:0">이번 분기(${esc(YQ)}) 집행 내역이 아직 없습니다 —
        출장을 <b>확정</b>하면 팀별·비목별로 여기에 쌓입니다.</div>
    </div>` : `
    <div class="card">
      <div class="card-head"><h2>CCG팀(부서)별 집행 현황</h2>
        <div class="lgd"><span><i class="sd"></i>처리 완료</span><span><i class="sw"></i>처리 중</span>
          <span><i class="sc ghost-seg"></i>확정 예정 <span class="sub">집계 제외</span></span></div></div>
      <div class="bars">${bars}</div>
      <details class="fold"><summary>금액 표로 보기</summary>
        <div class="scroll" style="margin-top:8px"><table>
          <thead><tr><th>CCG팀</th><th class="num">처리 완료</th><th class="num">처리 중</th>
            <th class="num">확정 예정</th><th class="num">합계</th><th class="num">구성비</th>
            <th class="num">인원</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>합계</td><td class="num">${won(tot.done)}</td><td class="num">${won(tot.wip)}</td>
            <td class="num">${won(tot.commit)}</td><td class="num">${won(totSum)}</td>
            <td class="num">${totSum ? '100.0%' : '–'}</td><td class="num">${tot.people}</td></tr></tfoot>
        </table></div></details>
      ${costStrip(d)}
      ${(d.nUsedTrips || 0) || cmtTot ? `<div class="ref">실집행 <b>${d.nUsedTrips || 0}건</b> · 인원 <b>${d.nUsedPeople || 0}명</b>
        <span class="sub">위 금액·인원은 처리 중·처리 완료만 셉니다${
          cmtTot ? ` · 확정 예정 ${won(cmtTot)}원은 아직 집계 밖` : ''}</span></div>` : ''}
    </div>`;
  // 부서별 현황이 먼저다 — 매번 스크롤해야 보이던 자리(y≈940px)를 첫 화면으로 올린다.
  // '바로 할 일' 큐는 그 아래. 큐는 목록·처리 화면에도 진입로가 있지만 부서별 집계는 여기뿐이다.
  $('#v-dash').innerHTML = notice + '<div class="askbox"></div>' + hero + ccg + todo;
  askDraw();
}
let NOTICE_EDIT = false;
function editNotice(on){
  if (on && !adminPw()) { askAdmin(() => { NOTICE_EDIT = true; rDash(); nav('dash'); }); return; }
  NOTICE_EDIT = on; rDash(); nav('dash');
}
async function saveNotice(){
  const body = {notice: $('#nt_main').value, notice_sub: $('#nt_sub').value};
  const {ok, data} = await api('/notice', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(saveNotice); return; }
    toast((data.errors || ['저장 실패'])[0]); return;
  }
  NOTICE_EDIT = false; toast('안내 문구를 저장했습니다');
  await load(); nav('dash');
}
function goProcess(){ if (!adminPw()) { askAdmin(() => nav('process')); return; } nav('process'); }
function goBudget(){ if (!adminPw()) { askAdmin(() => nav('budget')); return; } nav('budget'); }
/* 'YYYY-MM-DD' 를 Date.parse 에 넘기면 UTC 로 잡혀 KST 오전에 하루가 모자란다.
   로컬 자정 기준으로 직접 만든다. */
function dLocal(s){ const [y, m, d] = String(s || '').split('-').map(Number);
  return (y && m && d) ? new Date(y, m - 1, d) : null; }
function daysSince(s){ const t = dLocal(s); return t == null ? null
  : Math.floor((new Date().setHours(0, 0, 0, 0) - t) / 864e5); }
/* 큐에서 바로 그 건으로 — 이동 후 다시 찾게 만들지 않는다 */
function openActual(gid){
  nav('actual');
  const sel = $('#actSel');
  if (!sel) return;
  if (![...sel.options].some(o => o.value === gid)) { toast('이번 분기 실적 입력 대상이 아닙니다'); return; }
  const f = $('#actFilter');
  if (f && f.value) { f.value = ''; filterActual(); }   // 필터가 켜져 있으면 option.hidden 과 충돌한다
  sel.value = gid; pickActual(gid);
}
function openProcess(gid){
  const go = () => { nav('process');
    const el = document.querySelector(`#v-process [data-gid="${gid}"]`);
    if (el) { el.scrollIntoView({block: 'center'}); el.classList.add('flash');
              setTimeout(() => el.classList.remove('flash'), 1400); } };
  if (!adminPw()) { askAdmin(go); return; }
  go();
}

/* ═══ 출장 계획 등록 ═══ */
let TRAV_N = 0;
function travRow(p = {}){
  TRAV_N++;
  /* 팀 이름이 아니라 CCG 코드로 맞춘다.
     이름으로 맞추면, 설정에서 팀 이름을 바꾼 뒤 예전 건을 열었을 때 아무것도 선택되지 않고
     저장 시 팀 이름이 빈 값으로 덮여 쓰였다 (코드는 남아 검증은 통과 → 조용히 이름만 소실). */
  const known = !!p.ccg && ST.ccg.some(t => t.ccg === p.ccg);
  const teams = ST.ccg.map(t => {
    const sel = p.ccg ? t.ccg === p.ccg : t.team === p.ccg_nm;
    return `<option value="${esc(t.team)}" data-ccg="${esc(t.ccg)}"${sel ? ' selected' : ''}>`
      + `${esc(t.team)} · ${esc(t.ccg)}</option>`;
  }).join('')
  // 목록에 없는 코드(폐지된 팀 등)는 저장된 값을 그대로 남긴다 — 열었다고 지워지면 안 된다
  + (p.ccg && !known
     ? `<option value="${esc(p.ccg_nm || p.ccg)}" data-ccg="${esc(p.ccg)}" selected>`
       + `${esc(p.ccg_nm || p.ccg)} · ${esc(p.ccg)} (목록에 없음)</option>` : '');
  const ranks = ST.meta.ranks.map(r => `<option${r === (p.rank || 'TL') ? ' selected' : ''}>${r}</option>`).join('');
  return `<tr data-tid="${TRAV_N}">
    <td><input class="w-nm t-nm" value="${esc(p.name || '')}" placeholder="성명"></td>
    <td><input class="w-no t-no" value="${esc(p.emp_no || '')}" placeholder="사번"></td>
    <td><select class="w-rk t-rk" aria-label="직책">${ranks}</select></td>
    <td><select class="w-tm t-tm" aria-label="CCG팀(CCG 번호 포함)" onchange="syncCcg(this)"><option value="">선택</option>${teams}</select>
      <input class="t-cc" type="hidden" value="${esc(p.ccg || '')}"></td>
    ${KEYS.map(k => `<td>${mfield('w-mn t-p-' + k, p['p_' + k], '0', 'planSum()')}</td>`).join('')}
    <td class="num t-sum" style="font-weight:700">0</td>
    <td><button class="btn sm" onclick="this.closest('tr').remove(); planSum()">삭제</button></td>
  </tr>`;
}
function syncCcg(sel){
  // 선택지에 실린 코드를 그대로 쓴다 — 목록에 없는 팀(폐지 등)도 코드를 잃지 않게
  const opt = sel.selectedOptions[0];
  const code = (opt && opt.dataset.ccg) || (ST.ccg.find(x => x.team === sel.value) || {}).ccg || '';
  const tr = sel.closest('tr');
  tr.querySelector('.t-cc').value = code;
}
function planSum(){
  let tot = 0;
  $$('#travBody tr').forEach(tr => {
    let s = 0;
    KEYS.forEach(k => s += mnum(tr.querySelector('.t-p-' + k)));
    tr.querySelector('.t-sum').textContent = won(s);
    tot += s;
  });
  const el = $('#planTot'); if (el) el.textContent = won(tot) + '원';
  const d1 = $('#pl_dep')?.value, d2 = $('#pl_ret')?.value;
  const dy = $('#pl_days'), warn = $('#plDateWarn');
  const days = (d1 && d2) ? (new Date(d2) - new Date(d1)) / 864e5 + 1 : null;
  if (dy) dy.value = days === null ? '' : Math.max(0, days);
  if (warn) {   // 잘못된 기간은 제출 전에 그 자리에서 알려준다
    const bad = days !== null && days < 1;
    warn.textContent = bad ? '복귀일자가 출발일자보다 빠릅니다' : '';
    warn.style.display = bad ? 'block' : 'none';
    dy?.classList.toggle('bad', bad);
  }
}
let PLAN_JUST = null;
function justPanel(){
  const g = PLAN_JUST;
  if (!g) return '';
  const tentative = g.status === '계획 등록';
  return `<div class="card just">
    <div class="jt">등록되었습니다 — <b>${esc(gname(g))}</b> · ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} · ${(g.travelers || []).length}명
      <span class="status ${stClass(g.status)}">${esc(dispSt(g.status))}</span></div>
    <div class="jw">${tentative
      ? '아직 <b>잠정</b>이라 예산이 잡히지 않았습니다. 실제로 간다면 <b>출장 확정</b>을 눌러 예산을 확보하세요.'
      : '예산이 <b>확보</b>되었습니다. 다녀온 뒤 <b>출장 실적 입력</b>에서 실비를 넣으면 인폼이 자동 생성됩니다.'}</div>
    <div class="btns">
      ${tentative ? `<button class="btn pri" onclick="setStatus('${g.group_id}','확정 예정'); PLAN_JUST=null">출장 확정하기</button>` : ''}
      <button class="btn" onclick="nav('list')">출장 내역에서 확인</button>
      <button class="btn" onclick="nav('actual')">출장 실적 입력</button>
      <button class="btn" onclick="PLAN_JUST=null; rPlan(); nav('plan')">닫고 새로 등록</button>
    </div></div>`;
}
let EDIT_GID = null;                       // 수정 중인 출장 (null = 신규 등록)
function editGroup(gid){
  const g = ST.groups.find(x => x.group_id === gid);
  if (!g) { toast('출장을 찾을 수 없습니다'); return; }
  // 실적이 들어간 뒤에는 예산 담당자만 — 서버도 같은 기준으로 막는다
  if (g.act_tot > 0 && !adminPw()) { askAdmin(() => editGroup(gid)); return; }
  EDIT_GID = gid; PLAN_JUST = null;
  rPlan(); nav('plan');
  $('#pl_type').value = g.plan_type; $('#pl_city').value = g.city; $('#pl_org').value = g.org;
  $('#pl_kind').value = g.kind; $('#pl_car').value = g.car || '미사용';
  $('#pl_purpose').value = g.purpose; $('#pl_remark').value = g.remark || '';
  if ($('#pl_tags')) $('#pl_tags').value = (g.tags || []).join(', ');
  $('#pl_dep').value = g.dep_dt; $('#pl_ret').value = g.ret_dt;
  $('#travBody').innerHTML = '';
  (g.travelers || []).forEach(t => addTrav(t));
  planSum();
  $('#v-plan').scrollIntoView({block: 'start'});
}
function cancelEdit(){ EDIT_GID = null; rPlan(); nav('plan'); }
function rPlan(){
  const m = ST.meta;
  const ed = EDIT_GID ? ST.groups.find(x => x.group_id === EDIT_GID) : null;
  // 목록이 길어지면 닫힌 칸에서 잘려 오히려 못 읽는다 — 보이는 길이를 정해 두고 끊되,
  // 전체 문구는 title 로 남겨 마우스를 올리면 보이게 한다
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const copyOpts = ST.groups.filter(g => g.status !== '취소').slice(0, 30)
    .map(g => { const full = `${gname(g)} · ${names(g)} · ${fmtD(g.dep_dt)}`;
      return `<option value="${g.group_id}" title="${esc(full)}">${esc(cut(full, 16))}</option>`; }).join('');
  $('#v-plan').innerHTML = justPanel()
    + `
    <div class="card">
      <div class="card-head"><h2>${ed ? '출장 계획 수정' : '출장 계획 등록'}</h2>
        ${ed ? '' : `<select id="copySel" class="headsel" aria-label="이전 출장에서 불러오기" onchange="copyPlan(this.value)">
          <option value="">이전 출장 복사…</option>${copyOpts}</select>`}</div>
      ${ed ? `<div class="note"><b>${esc(gname(ed))}</b> · ${fmtD(ed.dep_dt)}–${fmtD(ed.ret_dt)} 를 수정합니다.
        <span class="status ${stClass(ed.roll)}">${esc(dispSt(ed.roll))}</span>
        ${ed.act_tot > 0 ? ' — 실적이 입력된 건이라 <b>예산 담당자 모드</b>에서만 저장됩니다.' : ''}
        <br>변경 내용은 감사 로그에 남습니다.</div>`
      : '<p class="cap">같이 가는 사람은 출장자 행을 추가하세요.</p>'}
      <div id="planErr"></div>
      <div class="form-grid c4">
        <div><label for="pl_type">구분<span class="rq">*</span></label>
          <select id="pl_type">${m.planTypes.map(t => `<option>${t}</option>`).join('')}</select></div>
        <div><label for="pl_city">출장 도시<span class="rq">*</span></label><input id="pl_city" placeholder="예: 청주"></div>
        <div><label for="pl_org">출장 기관&업체<span class="rq">*</span></label><input id="pl_org" placeholder="예: 원익머트리얼즈"></div>
        <div><label for="pl_kind">출장 구분<span class="rq">*</span></label>
          <select id="pl_kind">${m.kinds.map(k => `<option>${k}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid c4">
        <div><label for="pl_dep">출발일자<span class="rq">*</span></label><input type="date" id="pl_dep" onchange="planSum()"></div>
        <div><label for="pl_ret">복귀일자<span class="rq">*</span></label><input type="date" id="pl_ret" onchange="planSum()"></div>
        <div><label for="pl_days">출장일수 <span class="au">자동</span></label><input id="pl_days" class="auto" readonly>
          <div class="fwarn" id="plDateWarn" style="display:none"></div></div>
        <div><label for="pl_car">자차사용 여부</label>
          <select id="pl_car">${m.cars.map(c => `<option>${c}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid">
        <div><label for="pl_purpose">출장 목적&사유<span class="rq">*</span> <span class="au">소재명 포함</span></label>
          <textarea id="pl_purpose" placeholder="예: NF3 순도 관리 정기 Audit"></textarea></div>
      </div>
      <label style="margin-top:4px">출장자 <span class="au">동행자는 행 추가</span></label>
      <div class="scroll trav-table"><table>
        <thead>
          <tr><th rowspan="2">성명<span class="rq">*</span></th><th rowspan="2">사번<span class="rq">*</span></th>
            <th rowspan="2">직책<span class="rq">*</span></th><th rowspan="2">CCG팀 · No.<span class="rq">*</span></th>
            <th class="num grp" colspan="${m.cost.length}">계획 비용</th>
            <th class="num" rowspan="2">합계</th><th rowspan="2"></th></tr>
          <tr>${m.cost.map(c => `<th class="num sub2">${c.label}</th>`).join('')}</tr>
        </thead>
        <tbody id="travBody"></tbody>
      </table></div>
      <div class="btns" style="margin-top:8px">
        <button class="btn" onclick="addTrav()">+ 동행자 추가</button>
        <span style="margin-left:auto;font-weight:700;color:var(--navy)">계획 총합계 <span id="planTot">0원</span></span>
      </div>
      <div class="form-grid c2" style="margin-top:12px">
        <div><label for="pl_remark">비고</label><input id="pl_remark" placeholder="특이사항이 있으면 적어주세요"></div>
        <div><label for="pl_tags">태그 <span class="au">선택 · 쉼표로 여러 개</span></label>
          <input id="pl_tags" list="tagList" placeholder="예: CMP, 정기 Audit">
          <datalist id="tagList">${(ST.tags || []).map(x => `<option value="${esc(x.tag)}">`).join('')}</datalist>
          <div class="tagpick" id="plTagPick">${(ST.tags || []).slice(0, 12).map(x =>
            `<button type="button" class="tag" onclick="addPlanTag('${esc(x.tag).replace(/'/g, "\\'")}')"
               title="${x.n}건에 쓰임">#${esc(x.tag)}</button>`).join('')}</div>
        </div>
      </div>
      ${ed ? '' : `<label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:4px">
        <input type="checkbox" id="pl_confirm" style="width:auto;margin:0">
        <b style="margin:0 4px">실제로 가는 출장입니다</b>
        <span class="sub">체크하면 예산이 확보됩니다. 안 하면 잠정 계획으로 남습니다</span>
      </label>`}
      <div class="btns"><button class="btn pri" id="planBtn" onclick="submitPlan()">${ed ? '수정 저장' : '출장 계획 등록'}</button>
        ${ed ? '<button class="btn" onclick="cancelEdit()">수정 취소</button>' : ''}</div>
    </div>`;
  $('#travBody').innerHTML = travRow();
  planSum();
}
function addTrav(p){ $('#travBody').insertAdjacentHTML('beforeend', travRow(p || {})); planSum(); }
function copyPlan(gid){
  if (!gid) return;
  const g = ST.groups.find(x => x.group_id === gid);
  if (!g) return;
  $('#pl_type').value = g.plan_type; $('#pl_city').value = g.city; $('#pl_org').value = g.org;
  $('#pl_kind').value = g.kind; $('#pl_car').value = g.car || '미사용';
  $('#pl_purpose').value = g.purpose; $('#pl_remark').value = '';
  if ($('#pl_tags')) $('#pl_tags').value = (g.tags || []).join(', ');
  $('#pl_dep').value = ''; $('#pl_ret').value = '';
  $('#travBody').innerHTML = '';
  (g.travelers || []).forEach(p => addTrav(p));
  planSum();
  toast('이전 출장을 복사했습니다 — 일자·금액을 확인하세요');
}
function collectTravelers(){
  return $$('#travBody tr').map(tr => {
    const p = {name: tr.querySelector('.t-nm').value.trim(),
      emp_no: tr.querySelector('.t-no').value.trim(),
      rank: tr.querySelector('.t-rk').value,
      ccg_nm: tr.querySelector('.t-tm').value,
      ccg: tr.querySelector('.t-cc').value};
    KEYS.forEach(k => p['p_' + k] = mnum(tr.querySelector('.t-p-' + k)));
    return p;
  });
}
/* 태그는 주관식이 기본이고, 이미 쓰인 것은 눌러서 넣을 수 있게 한다
   (선택형만 두면 새 분류를 못 만들고, 주관식만 두면 같은 뜻이 여러 철자로 갈린다) */
function addPlanTag(tag){
  const el = $('#pl_tags'); if (!el) return;
  const cur = el.value.split(',').map(s => s.trim()).filter(Boolean);
  if (!cur.includes(tag)) cur.push(tag);
  el.value = cur.join(', ');
  el.focus();
}
function submitPlan(){ return once('#planBtn', _submitPlan); }
async function _submitPlan(){
  const body = {plan_type: $('#pl_type').value, city: $('#pl_city').value.trim(),
    org: $('#pl_org').value.trim(), kind: $('#pl_kind').value,
    dep_dt: $('#pl_dep').value, ret_dt: $('#pl_ret').value, car: $('#pl_car').value,
    purpose: $('#pl_purpose').value.trim(), remark: $('#pl_remark').value.trim(),
    tags: $('#pl_tags') ? $('#pl_tags').value : '',
    confirmed: $('#pl_confirm')?.checked || false,
    travelers: collectTravelers()};
  if (EDIT_GID) {                          // 수정 — 상태·개인 처리상태는 서버가 고정
    const r = await api(`/groups/${EDIT_GID}`, {method: 'PUT', body: JSON.stringify(body)});
    if (!r.ok) {
      if (r.status === 401) { askAdmin(() => submitPlan()); return; }
      showErr('#planErr', r.data.errors); return;
    }
    toast('수정 저장 완료 — 변경 내용은 감사 로그에 기록됩니다');
    EDIT_GID = null; await load(); nav('list'); return;
  }
  // 확정 시 예산이 모자라면 막지 않고 확인만 받는다 (차단 아님)
  if (body.confirmed) {
    const need = collectTravelers().reduce((sm, t) =>
      sm + KEYS.reduce((x, k) => x + (t['p_' + k] || 0), 0), 0);
    const after = (ST.dash.avail || 0) - need;
    if (after < 0 && !confirm(
        `확정 후 가용 잔여가 ${after < 0 ? '−' : ''}${won(Math.abs(after))}원입니다.\n` +
        '예산 부족을 인지한 상태로 계속 확정하시겠습니까?\n\n' +
        '[확인] 계속 확정   /   [취소] 돌아가기')) return;
  }
  const {ok, data} = await api('/groups', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) { showErr('#planErr', data.errors); return; }
  toast(`등록 완료 — ${dispSt(data.group.status)} · ${body.travelers.length}명`);
  PLAN_JUST = data.group;
  YQ = data.group.yq;
  await load(); nav('plan');
  $('#v-plan').scrollIntoView({block: 'start'});
}

/* ═══ 출장 실적 입력 ═══ */
let ACT_GID = null;
function rActual(){
  const targets = ST.groups.filter(g => g.yq === YQ && ['계획 등록', '확정 예정', '실적 입력·인폼'].includes(g.status));
  // 대시보드 '실적 대기' 와 같은 계산(core.dash().todo.actual_wait) — 두 화면 숫자가 어긋나지 않게
  const waiting = new Set(((ST.dash && ST.dash.todo && ST.dash.todo.actual_wait) || []));
  const optOf = g => `<option value="${g.group_id}">${esc(gname(g))} · ${names(g)} · ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} · ${g.status}${g.plan_type === '긴급' ? ' [긴급]' : ''}</option>`;
  const wg = targets.filter(g => waiting.has(g.group_id));
  const rest = targets.filter(g => !waiting.has(g.group_id));
  const opts = (wg.length ? `<optgroup label="복귀함 · 실적 대기 (${wg.length}건)">${wg.map(optOf).join('')}</optgroup>` : '')
    + (rest.length ? `<optgroup label="예정 · 작성 중 (${rest.length}건)">${rest.map(optOf).join('')}</optgroup>` : '');
  if (!targets.length) {                     // 0개짜리 목록을 검색하라고 두면 막다른 길이다
    $('#v-actual').innerHTML = `
      <div class="card">
        <h2>출장 실적 입력</h2>
        <p class="cap">실적을 넣을 출장이 없습니다.</p>
        <div class="note" style="margin:0">이번 분기(${esc(YQ)})에 <b>계획·확정 상태의 출장이 없습니다.</b>
          실적은 계획을 먼저 등록한 뒤에 넣습니다.
          <div style="margin-top:8px"><button class="btn sm pri" onclick="nav('plan')">출장 계획 등록 →</button>
          <button class="btn sm" onclick="nav('list')">출장 내역에서 확인 →</button></div></div>
      </div>`;
    ACT_GID = null; return;
  }
  $('#v-actual').innerHTML = `
    <div class="card">
      <h2>출장 실적 입력</h2>
      <p class="cap">실적을 저장하면 인폼이 자동으로 만들어집니다.</p>
      <div id="actErr"></div>
      <div class="filter-row">
        <input id="actFilter" placeholder="성명·업체·도시로 검색" oninput="filterActual()">
        <select id="actSel" aria-label="실적을 입력할 출장 고르기" onchange="pickActual(this.value)" style="flex:1;min-width:300px">
          <option value="">대상 출장 선택 (${targets.length}건${wg.length ? ` · 실적 대기 ${wg.length}` : ''})</option>${opts}</select>
      </div>
      <div id="actBody"></div>
    </div>`;
  ACT_GID = null;
}
function filterActual(){
  const q = $('#actFilter').value.trim();
  [...$('#actSel').options].forEach((o, i) => {
    if (i === 0) return;
    o.hidden = q && !o.textContent.includes(q);
  });
  // 전부 숨겨진 optgroup 라벨이 남으면 '있는데 안 보이는' 것처럼 읽힌다
  $$('#actSel optgroup').forEach(gp => {
    gp.hidden = [...gp.children].every(o => o.hidden);
  });
}
function pickActual(gid){
  ACT_GID = gid;
  const box = $('#actBody');
  if (!gid) { box.innerHTML = ''; return; }
  const g = ST.groups.find(x => x.group_id === gid);
  const m = ST.meta;
  const rows = g.travelers.map((p, i) => {
    const plan = KEYS.reduce((s, k) => s + (p['p_' + k] || 0), 0);
    return `<tr data-emp="${esc(p.emp_no)}">
      <td><b>${esc(p.name)}</b> <span class="sub">${esc(p.rank)} · ${esc(p.emp_no)}</span></td>
      <td>${esc(p.ccg_nm)}</td>
      ${KEYS.map(k => `<td>${mfield('w-mn a-' + k, p['a_' + k], '계획 ' + won(p['p_' + k]), 'actSum()')}</td>`).join('')}
      <td class="num a-sum" style="font-weight:700">0</td>
      <td class="num a-var">–</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="note"><b>${esc(gname(g))}</b> · ${esc(g.purpose)} · ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} (${g.days}일) · ${g.travelers.length}명 · 계획 합계 ${won(g.plan_tot)}원</div>
    <div class="scroll trav-table"><table>
      <thead>
        <tr><th rowspan="2">출장자</th><th rowspan="2">CCG팀</th>
          <th class="num grp" colspan="${m.cost.length}">실적 비용</th>
          <th class="num" rowspan="2">실적 합계</th><th class="num" rowspan="2">계획 대비</th></tr>
        <tr>${m.cost.map(c => `<th class="num sub2">${c.label}</th>`).join('')}</tr>
      </thead>
      <tbody id="actRows">${rows}</tbody>
      <tfoot><tr><td colspan="2">그룹 합계</td>
        ${KEYS.map(k => `<td class="num" id="af-${k}">0</td>`).join('')}
        <td class="num" id="afTot">0</td><td class="num" id="afVar">–</td></tr></tfoot>
    </table></div>
    <div class="form-grid" style="margin-top:12px">
      <div><label for="ac_remark">비고 <span class="au">긴급 출장은 필수</span></label><input id="ac_remark" value="${esc(g.remark || '')}"></div>
    </div>
    <div class="btns"><button class="btn pri" id="actBtn" onclick="submitActual()">실적 저장 및 인폼 생성 (${g.travelers.length}명)</button>
      ${g.act_tot > 0 ? `<button class="btn" onclick="reopenMail('${g.group_id}')">인폼 다시 보기</button>` : ''}</div>`;
  actSum();
}
function actSum(){
  const g = ST.groups.find(x => x.group_id === ACT_GID);
  if (!g) return;
  const ft = {trans:0, lodg:0, meal:0, etc:0};
  let tot = 0, planTot = 0;
  $$('#actRows tr').forEach(tr => {
    const emp = tr.dataset.emp;
    const p = g.travelers.find(x => String(x.emp_no) === emp) || {};
    let s = 0, pl = 0;
    KEYS.forEach(k => { const v = mnum(tr.querySelector('.a-' + k));
      s += v; ft[k] += v; pl += p['p_' + k] || 0; });
    tot += s; planTot += pl;
    tr.querySelector('.a-sum').textContent = won(s);
    const v = pl && s ? pl - s : 0;
    const el = tr.querySelector('.a-var');
    el.textContent = v ? (v > 0 ? '+' : '−') + won(Math.abs(v)) : '–';
    el.style.color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--faint)';
  });
  KEYS.forEach(k => $('#af-' + k).textContent = won(ft[k]));
  $('#afTot').textContent = won(tot);
  const gv = planTot && tot ? planTot - tot : 0;
  const fe = $('#afVar');
  fe.textContent = gv ? (gv > 0 ? '+' : '−') + won(Math.abs(gv)) : '–';
  fe.style.color = gv >= 0 ? 'var(--green)' : 'var(--red)';
}
function submitActual(){ return once('#actBtn', _submitActual); }
async function _submitActual(){
  const travelers = $$('#actRows tr').map(tr => {
    const p = {emp_no: tr.dataset.emp};
    KEYS.forEach(k => p['a_' + k] = mnum(tr.querySelector('.a-' + k)));
    return p;
  });
  const {ok, data} = await api(`/groups/${ACT_GID}/actual`,
    {method: 'POST', body: JSON.stringify({travelers, remark: $('#ac_remark').value.trim()})});
  if (!ok) { showErr('#actErr', data.errors); return; }
  const gid = ACT_GID;
  toast('실적 저장 — 상태: 실적 입력·인폼');
  await load(); nav('actual');
  const sel = $('#actSel');                 // 저장 후에도 선택 유지 — 인폼을 다시 열 수 있게
  if (sel) { sel.value = gid; pickActual(gid); }
  showMail(data.mail);
}

/* ═══ 엑셀 일괄 등록 — 센터 양식 시트에서 그대로 붙여넣기 ═══
   서버 API·data.json 스키마는 그대로. 화면에서 파싱해 기존 POST /api/groups 를 그대로 씁니다. */
const BULK_COLS = {                        // 표준 열이름 → 내부 키 (별칭 허용)
  '구분':'plan_type', '출장도시':'city', '도시':'city',
  '출장기관&업체':'org', '출장기관':'org', '업체':'org', 'BP':'org', 'BP사':'org',
  '출장목적&사유':'purpose', '출장목적':'purpose', '목적':'purpose', '목적&사유':'purpose',
  '출발일자':'dep_dt', '출발일':'dep_dt', '복귀일자':'ret_dt', '복귀일':'ret_dt',
  '자차사용여부':'car', '자차':'car', '출장구분':'kind', '비고':'remark',
  '사번':'emp_no', '성명':'name', '이름':'name', '직책':'rank',
  'CCG명':'ccg_nm', 'CCG팀':'ccg_nm', 'CCG':'_ccgcode', 'LV2':'_skip',
  '계획_교통비':'p_trans', '계획_숙박비':'p_lodg', '계획_식대&잡비':'p_meal', '계획_기타':'p_etc',
  '실적_교통비':'a_trans', '실적_숙박비':'a_lodg', '실적_식대&잡비':'a_meal', '실적_기타':'a_etc',
  '출장일수':'_skip', '출장시점':'_skip', '계획_총합계':'_skip', '실적_총합계':'_skip',
};
const BULK_MIN = ['출장도시','출장기관&업체','출장목적&사유','출발일자','성명','사번','CCG명'];
const CENTER_ORDER = ['구분','LV2','CCG','CCG명','사번','성명','직책','출장도시','출장기관&업체',
  '출장목적&사유','출발일자','복귀일자','출장일수','출장시점','자차사용여부','출장구분',
  '계획_총합계','계획_교통비','계획_숙박비','계획_식대&잡비','계획_기타',
  '실적_총합계','실적_교통비','실적_숙박비','실적_식대&잡비','실적_기타','비고'];
let BULK_ROWS = null;
/* 사내 LLM 에게 그대로 건네는 사양. 화면([JSON 형식 보기])과 문서(JSON_INPUT.md)가 같은 글을 쓴다. */
function jsonSpec(){ return JSON_SPEC.replace('{{CCG}}', ST.ccg.map(x => x.team).join(' · ')); }
const JSON_SPEC = `출장 계획을 아래 JSON 형식으로만 출력하세요. 설명·주석·코드펜스 없이 JSON 배열만 출력합니다.

[
  {
    "plan_type": "계획",                 // 계획 | 변경 | 긴급  (기본 계획)
    "city": "청주",                       // 필수 — 출장 도시
    "org": "원익머트리얼즈",               // 필수 — 출장 기관&업체
    "purpose": "NF3 순도 관리 정기 Audit", // 필수 — 출장 목적&사유 (소재명 포함 권장)
    "kind": "정기 Audit",                 // 기술교류(Live Demo, Data 분석) | 실사&사양 개선,협의 |
                                          //  정기 Audit | 비정기 Audit(Issue/Theme) | 기타
    "dep_dt": "2026-08-04",               // 필수 — 출발일자 YYYY-MM-DD
    "ret_dt": "2026-08-05",               // 복귀일자. 없으면 출발일과 같은 날(당일)
    "car": "미사용",                       // 미사용 | 자차사용
    "tags": ["CMP", "정기 Audit"],         // 선택 — 분류·검색용 (최대 8개, 각 20자)
    "remark": "",                          // 비고 (긴급 출장 실적 입력 시 필수)
    "travelers": [                         // 필수 — 1명 이상. 같이 가면 여기에 사람을 늘립니다
      {
        "name": "박영희",                  // 필수 — 성명
        "emp_no": "20140508",              // 필수 — 사번 (한 출장 안에서 중복 불가)
        "rank": "TL",                      // TL | 팀장
        "ccg_nm": "EDTW소재기술",           // 필수 — CCG팀명(정확히) 또는 CCG 코드 8자리
        "p_trans": 120000,                 // 계획 교통비 (숫자, 원)
        "p_lodg": 100000,                  // 계획 숙박비
        "p_meal": 70000,                   // 계획 식대&잡비
        "p_etc": 0                         // 계획 기타
      }
    ]
  }
]

규칙
· 한 번의 출장에 여러 명이 가면 travelers 에 사람을 추가합니다(출장 1건 = 객체 1개).
· 서로 다른 출장은 배열에 객체를 늘립니다.
· 금액은 숫자만 씁니다(콤마·"원" 없이). 모르면 0 을 넣습니다.
· 실적 금액은 넣지 않습니다 — 다녀온 뒤 화면에서 입력합니다.
· CCG팀명은 아래 목록의 이름을 정확히 씁니다: {{CCG}}
· 날짜는 반드시 YYYY-MM-DD 입니다.`;


const bnorm = t => String(t || '').replace(/\s+/g, '').replace(/[·・]/g, '·').trim();
function bTeam(v){                          // 'EDTW소재기술' 'EDTW소재개발' 'CCG번호' 모두 인식
  const q = bnorm(v).toLowerCase();
  if (!q) return '';
  const exact = ST.ccg.find(x => bnorm(x.team).toLowerCase() === q)
             || ST.ccg.find(x => x.ccg.toLowerCase() === q);
  if (exact) return exact.team;
  /* 앞글자 매칭은 '한 팀만' 걸릴 때만 쓴다.
     'Patterning소재기술/개발', 'C&C소재기술/개발' 처럼 앞이 같은 팀이 있어서,
     먼저 찾은 것을 그냥 쓰면 개발 건이 기술 팀으로 조용히 들어간다. */
  const pre = ST.ccg.filter(x => bnorm(x.team).toLowerCase().startsWith(q));
  return pre.length === 1 ? pre[0].team : '';
}
function bDate(v){                           // 2026.8.4 / 26-08-04 / 45000(엑셀 일련번호) 허용
  const t = String(v || '').trim();
  if (!t) return '';
  if (/^\d{5}$/.test(t)) {                   // 엑셀 날짜 일련번호
    const d = new Date(Date.UTC(1899, 11, 30) + Number(t) * 864e5);
    return d.toISOString().slice(0, 10);
  }
  const m = t.match(/(\d{2,4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
  if (!m) return '';
  let y = +m[1]; if (y < 100) y += 2000;
  return `${y}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
}
function bKind(v){
  const q = bnorm(v).toLowerCase();
  // 비어 있으면 '기타'. 특정 분류(정기 Audit)로 채우면 센터 제출본에 그럴듯한 거짓이 들어간다.
  if (!q) return '기타';
  return ST.meta.kinds.find(k => bnorm(k).toLowerCase() === q)
      || ST.meta.kinds.find(k => bnorm(k).toLowerCase().includes(q) || q.includes(bnorm(k).toLowerCase().slice(0,4)))
      || '기타';
}
/* JSON 으로 붙여넣는 경우 — 사내 LLM 에게 형식을 주고 받아 그대로 붙이는 길.
   엑셀 붙여넣기와 같은 화면·같은 미리보기·같은 등록 버튼을 쓴다(경로를 둘로 만들지 않는다). */
function bParseJson(text){
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { return {groups: [], errs: ['JSON 형식이 아닙니다 — ' + e.message]}; }
  if (raw && !Array.isArray(raw) && Array.isArray(raw.groups)) raw = raw.groups;   // {"groups":[...]} 도 허용
  if (!Array.isArray(raw)) raw = [raw];                                            // 한 건만 준 경우
  const errs = [], groups = [];
  raw.forEach((g, i) => {
    const n = i + 1;
    if (!g || typeof g !== 'object') { errs.push(`${n}번째 항목이 객체가 아닙니다.`); return; }
    const trav = Array.isArray(g.travelers) ? g.travelers : [];
    if (!trav.length) { errs.push(`${n}번째 — travelers 가 비어 있습니다.`); return; }
    const dep = bDate(g.dep_dt) || String(g.dep_dt || '').trim();
    const ret = bDate(g.ret_dt) || String(g.ret_dt || '').trim() || dep;
    if (!dep) { errs.push(`${n}번째 — dep_dt(출발일자)가 없습니다.`); return; }
    const T = trav.map((p, j) => {
      const team = bTeam(p.ccg_nm || p.ccg || '');
      if (!team) errs.push(`${n}번째 ${j + 1}번 출장자 — CCG팀을 알 수 없습니다: ${p.ccg_nm || p.ccg || '(비어 있음)'}`);
      const num = v => Math.max(0, Math.round(Number(String(v ?? 0).replace(/[^0-9.-]/g, '')) || 0));
      const row = {name: String(p.name || '').trim(), emp_no: String(p.emp_no || '').trim(),
                   rank: p.rank === '팀장' ? '팀장' : 'TL', ccg_nm: team};
      KEYS.forEach(k => { row['p_' + k] = num(p['p_' + k]); row['a_' + k] = num(p['a_' + k]); });
      if (!row.name || !row.emp_no) errs.push(`${n}번째 ${j + 1}번 출장자 — 성명·사번은 필수입니다.`);
      return row;
    });
    groups.push({plan_type: ['계획', '변경', '긴급'].includes(g.plan_type) ? g.plan_type : '계획',
                 city: String(g.city || '').trim(), org: String(g.org || '').trim(),
                 purpose: String(g.purpose || '').trim(), kind: bKind(g.kind),
                 dep_dt: dep, ret_dt: ret,
                 car: g.car === '자차사용' ? '자차사용' : '미사용',
                 remark: String(g.remark || '').trim(),
                 tags: g.tags ?? '',   // 정리는 서버 clean_tags 가 한다 (계획 폼과 같은 경로)
                 travelers: T, _rows: [`JSON ${n}`]});
  });
  groups.forEach((g, i) => {
    if (!g.city || !g.org || !g.purpose)
      errs.push(`${i + 1}번째 — city·org·purpose 는 필수입니다.`);
  });
  return {groups, errs};
}

/* ── 문답으로 끝내기 ────────────────────────────────────────────
   한 화면에 질문 하나. 고르면 바로 다음으로 넘어가고, 적어야 하는 것만 [다음]을 누른다.
   본인이 누구인지는 처음 한 번만 묻고 이 브라우저에 기억한다 — 그 뒤로는 안 묻는다.
   그래서 계획은 '어디로·언제·무슨 일로·누구랑·얼마' 다섯, 실적은 '어느 출장·얼마' 둘이다.

   고를 수 있는 값은 전부 눌러서 고른다(구분·CCG·직책·자차·태그). 날짜는 달력을 쓴다.
   자유롭게 적는 칸은 목적·비고뿐이고 그건 해석하지 않는다.

   저장은 하지 않는다: 마지막 확인 화면에서 사람이 누르면 기존 라우트로 나간다.
   (문답이 새 쓰기 경로가 되면 검증·권한 게이트가 무의미해진다) */
const ME_KEY = 'tb_me';
function meGet(){
  try { const v = JSON.parse(localStorage.getItem(ME_KEY) || 'null');
    return v && v.emp_no && v.name ? v : null; } catch (e) { return null; }
}
function meSet(p){ try { localStorage.setItem(ME_KEY, JSON.stringify(p)); } catch (e) {} askDraw(); }
function meClear(){ try { localStorage.removeItem(ME_KEY); } catch (e) {} ASK = null; askDraw(); }
/* 원장에 이미 있는 사람 — 대부분 여기서 자기 이름을 찾는다 */
function mePeople(){
  const seen = [], out = [];
  for (const g of ST.groups) for (const p of (g.travelers || [])) {
    if (p.emp_no && !seen.includes(String(p.emp_no))) {
      seen.push(String(p.emp_no));
      out.push({name: p.name, emp_no: String(p.emp_no), rank: p.rank || 'TL', ccg_nm: p.ccg_nm});
    }
  }
  return out;
}
/* 조직도를 붙일 수 없어서 — 지금까지 간 사람의 이력이 곧 명부다.
   이름을 치면 사번·직책·CCG 를 이력에서 끌어온다. 같은 이름이 둘이면 고르게 한다. */
function nameHits(name){
  const q = bnorm(name).toLowerCase();
  if (!q) return [];
  return mePeople().filter(p => bnorm(p.name).toLowerCase() === q);
}
function namePrefix(name){
  const q = bnorm(name).toLowerCase();
  if (q.length < 1) return [];
  const seen = [];
  return mePeople().filter(p => {
    const n = bnorm(p.name).toLowerCase();
    if (n === q || !n.startsWith(q) || seen.includes(n)) return false;
    seen.push(n); return true;
  }).slice(0, 6);
}
const nameSay = p => `${esc(p.emp_no)} · ${esc(p.rank)} · ${esc(p.ccg_nm)}`;
/* 다시 그리면 이미 친 글이 지워진다 — 힌트 칸만 갈아 끼운다 */
function nameLook(pre){
  const box = $('#' + pre + '_hit'); if (!box) return;
  const v = ($('#' + pre + '_nm') || {}).value || '';
  const hit = nameHits(v);
  if (hit.length === 1) { namePut(pre, hit[0]); return; }
  if (hit.length > 1) {
    box.innerHTML = `<div class="namehit warn">같은 이름이 ${hit.length}명입니다 — 고르세요</div>
      <div class="askchips">${hit.map(p =>
        `<button type="button" class="askchip" onclick='namePick("${pre}",${JSON.stringify(p)
          .replace(/'/g, "&#39;")})'>${esc(p.name)} <span class="sub">${nameSay(p)}</span></button>`).join('')}</div>`;
    return;
  }
  const near = namePrefix(v);
  box.innerHTML = near.length
    ? `<div class="askchips">${near.map(p =>
        `<button type="button" class="askchip" onclick='namePick("${pre}",${JSON.stringify(p)
          .replace(/'/g, "&#39;")})'>${esc(p.name)} <span class="sub">${esc(p.ccg_nm)}</span></button>`).join('')}</div>`
    : (v.trim() ? '<div class="namehit">이력에 없는 이름입니다 — 사번과 CCG팀을 넣어 주세요</div>' : '');
}
function namePick(pre, p){ namePut(pre, typeof p === 'string' ? JSON.parse(p) : p); }
function namePut(pre, p){
  askFill(pre + '_nm', p.name); askFill(pre + '_no', p.emp_no);
  const rk = $('#' + pre + '_rk'), tm = $('#' + pre + '_tm');
  if (rk) rk.value = p.rank || 'TL';
  if (tm) tm.value = p.ccg_nm || '';
  const box = $('#' + pre + '_hit');
  if (box) box.innerHTML = `<div class="namehit ok">이력에서 채웠습니다 — ${nameSay(p)}</div>`;
}
function meManual(){ ME_MANUAL = true; askDraw(); }
function meSetFrom(emp){
  const p = mePeople().find(x => x.emp_no === String(emp));
  if (p) meSet(p);
}
function meSaveNew(){
  const p = {name: ($('#me_nm') || {}).value?.trim(), emp_no: ($('#me_no') || {}).value?.trim(),
    rank: ($('#me_rk') || {}).value, ccg_nm: ($('#me_tm') || {}).value};
  if (!p.name || !p.emp_no || !p.ccg_nm) { toast('성명·사번·CCG팀을 넣어 주세요'); return; }
  meSet(p);
}

const askOpt = (label, fn, sub) =>
  `<button type="button" class="askopt" onclick="${fn}">${label}${
    sub ? `<span class="sub">${sub}</span>` : ''}</button>`;

const ASK_STEP = {
  where: {
    q: () => '어디로 가시나요?',
    view: () => {
      const seen = [], out = [];
      for (const g of ST.groups) {
        const k = `${g.city}|${g.org}`;
        if (g.city && g.org && !seen.includes(k)) { seen.push(k); out.push(g); }
        if (out.length >= 6) break;
      }
      return out.map(g => askOpt(esc(g.org), `askTake('where',{city:'${esc(g.city)}',org:'${esc(g.org)}'})`,
        esc(g.city))).join('')
        + `<div class="askor">또는 직접</div>
           <div class="form-grid c2">
             <div><label for="a_city">출장 도시</label><input id="a_city" placeholder="예: 청주"></div>
             <div><label for="a_org">출장 기관&업체</label><input id="a_org" placeholder="예: 원익머트리얼즈"></div>
           </div>`;
    },
    read: () => ({city: ($('#a_city') || {}).value?.trim() || '',
                  org: ($('#a_org') || {}).value?.trim() || ''}),
    okay: v => v.city && v.org,
    warn: '도시와 기관&업체를 넣어 주세요',
    show: v => `${esc(v.city)} · <b>${esc(v.org)}</b>`,
  },
  when: {
    q: () => '언제 다녀오시나요?',
    view: () => `
      <div class="form-grid c2">
        <div><label for="a_dep">출발일자</label><input type="date" id="a_dep" onchange="askSameDay()"></div>
        <div><label for="a_ret">복귀일자</label><input type="date" id="a_ret"></div>
      </div>
      <div class="askor">차는 어떻게</div>
      ${ST.meta.cars.map(c => askOpt(esc(c), `askSetCar('${esc(c)}')`)).join('')}`,
    read: () => { const d = ($('#a_dep') || {}).value || '';
      return {dep: d, ret: ($('#a_ret') || {}).value || d, car: askSel.car || '미사용'}; },
    okay: v => !!v.dep,
    warn: '출발일자를 달력에서 골라 주세요',
    show: v => `<b>${esc(v.dep)}</b> ~ <b>${esc(v.ret)}</b> <span class="sub">${esc(v.car)}</span>`,
  },
  why: {
    q: () => '무슨 일로 가시나요?',
    view: () => `
      <div><label for="a_purpose">출장 목적&사유 <span class="au">소재명 포함</span></label>
        <input id="a_purpose" placeholder="예: NF3 순도 관리 정기 Audit"></div>
      <div class="askor">어떤 일인가요 — 누르면 넘어갑니다</div>
      ${ST.meta.kinds.map(k => askOpt(esc(k), `askSetKind('${esc(k).replace(/'/g, "\\'")}')`)).join('')}`,
    read: () => ({purpose: ($('#a_purpose') || {}).value?.trim() || '', kind: askSel.kind || '기타'}),
    okay: v => !!v.purpose,
    warn: '출장 목적을 적어 주세요',
    show: v => `<b>${esc(v.purpose)}</b>${
      bnorm(v.purpose).toLowerCase().includes(bnorm(v.kind).toLowerCase())
        ? '' : ` <span class="sub">${esc(v.kind)}</span>`}`,
  },
  who: {
    q: () => '같이 가시는 분이 있나요?',
    view: () => {
      const me = meGet() || {};
      const mine = `<div class="askme"><b>${esc(me.name)}</b>
        <span class="sub">${esc(me.emp_no)} · ${esc(me.rank)} · ${esc(me.ccg_nm)}</span></div>`;
      const others = (ASK.who || []).map((p, i) => `<div class="askme">
        <b>${esc(p.name)}</b> <span class="sub">${esc(p.emp_no)} · ${esc(p.rank)} · ${esc(p.ccg_nm)}</span>
        <button class="btn sm" onclick="askDropWho(${i})">빼기</button></div>`).join('');
      const seen = [String(me.emp_no)].concat((ASK.who || []).map(x => String(x.emp_no)));
      const past = mePeople().filter(p => !seen.includes(p.emp_no)).slice(0, 6);
      return mine + others
        + `<div class="askor">같이 가는 분 — 누르면 들어갑니다</div>`
        + past.map(p => askOpt(esc(p.name), `askAddWho('${esc(p.emp_no)}')`, esc(p.ccg_nm))).join('')
        + `<div class="askor">목록에 없으면 직접</div>
           <div class="form-grid c4">
             <div><label for="a_nm">성명</label>
               <input id="a_nm" placeholder="이름을 치면 사번을 찾습니다" oninput="nameLook('a')"></div>
             <div><label for="a_no">사번</label><input id="a_no" placeholder="사번"></div>
             <div><label for="a_rk">직책</label><select id="a_rk">${
               ST.meta.ranks.map(r => `<option>${r}</option>`).join('')}</select></div>
             <div><label for="a_tm">CCG팀</label><select id="a_tm"><option value="">선택</option>${
               ST.ccg.map(t => `<option value="${esc(t.team)}">${esc(t.team)} · ${esc(t.ccg)}</option>`).join('')
             }</select></div>
           </div>
           <div id="a_hit"></div>
           <div class="btns" style="margin-top:8px"><button class="btn" onclick="askAddWho()">이분도 넣기</button></div>`;
    },
    read: () => [meGet()].concat(ASK.who || []).filter(Boolean),
    okay: v => v.length > 0,
    warn: '출장 가는 분이 없습니다',
    show: v => v.map(p => `<b>${esc(p.name)}</b>`).join(', ') + ` <span class="sub">${v.length}명</span>`,
  },
  cost: {
    q: () => '1인당 얼마쯤 드나요?',
    view: () => `<div class="form-grid c4">${
      ST.meta.cost.map((c, i) => `<div><label>${esc(c.label)}</label>${
        mfield('a-c-' + KEYS[i], 0, '0', 'askCostSum()')}</div>`).join('')}</div>
      <div class="askor" id="askCostTot">1인당 합계 0원</div>`,
    read: () => { const o = {}; KEYS.forEach(k => o[k] = mnum($('.a-c-' + k))); return o; },
    okay: () => true,
    show: v => askMoneyShow(v),
  },
  trip: {
    q: () => '어느 출장을 다녀오셨나요?',
    view: () => {
      const me = meGet() || {};
      const today = new Date().toISOString().slice(0, 10);
      const mine = ST.groups
        .filter(g => g.status !== '취소' && g.roll !== '처리 완료'
          && (g.travelers || []).some(p => String(p.emp_no) === String(me.emp_no)))
        .sort((a, b) => ((b.ret_dt <= today) - (a.ret_dt <= today)) || String(b.dep_dt).localeCompare(a.dep_dt));
      if (!mine.length) return `<div class="note">${esc(me.name)}님 앞으로 실적을 넣을 출장이 없습니다.</div>`;
      return mine.slice(0, 8).map(g => askOpt(esc(gname(g)),
        `askTake('trip','${g.group_id}')`,
        `${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} · ${esc(dispSt(g.roll))}`)).join('');
    },
    read: () => ASK.v.trip || null,
    okay: v => !!v,
    warn: '출장을 골라 주세요',
    show: v => { const g = ST.groups.find(x => x.group_id === v) || {};
      return `<b>${esc(gname(g))}</b> <span class="sub">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</span>`; },
  },
  spent: {
    q: () => '얼마 쓰셨어요?',
    view: () => {
      const p = askMyRow();
      return (p ? askOpt('계획대로 썼습니다', 'askAsPlanned()',
        `교통 ${won(p.p_trans)} · 숙박 ${won(p.p_lodg)} · 식대&잡비 ${won(p.p_meal)} · 기타 ${won(p.p_etc)}`) : '')
        + `<div class="askor">다르면 직접</div>
           <div class="form-grid c4">${ST.meta.cost.map((c, i) => `<div><label>${esc(c.label)}</label>${
             mfield('a-s-' + KEYS[i], 0, p ? won(p['p_' + KEYS[i]]) : '0', 'askSpentSum()')}</div>`).join('')}</div>
           <div class="askor" id="askSpentTot">실적 합계 0원</div>`;
    },
    read: () => { const o = {}; KEYS.forEach(k => o[k] = mnum($('.a-s-' + k))); return o; },
    okay: () => true,
    show: v => askMoneyShow(v),
  },
};
function askMoneyShow(v){
  const on = KEYS.map((k, i) => v[k] ? `${esc(ST.meta.cost[i].label)} <b>${won(v[k])}</b>` : '').filter(Boolean);
  const tot = KEYS.reduce((s, k) => s + v[k], 0);
  return on.length ? on.join(' · ') + ` <span class="sub">합계 ${won(tot)}</span>` : '0';
}
function askMyRow(){
  const me = meGet() || {};
  const g = ST.groups.find(x => x.group_id === ASK.v.trip);
  return g && (g.travelers || []).find(x => String(x.emp_no) === String(me.emp_no));
}
const ASK_FLOW = {plan: ['where', 'when', 'why', 'who', 'cost'], act: ['trip', 'spent']};
let ASK = null, askSel = {}, ME_MANUAL = false;

/* 고르면 바로 다음으로 — 누르고 또 [다음]을 누르게 하지 않는다 */
function askTake(k, v){ ASK.v[k] = v; ASK.i = ASK_FLOW[ASK.mode].indexOf(k) + 1; askDraw(); }
function askSetCar(c){ askSel.car = c; askNext(); }
function askSetKind(k){ askSel.kind = k; askNext(); }
function askSameDay(){ const d = $('#a_dep'), r = $('#a_ret'); if (d && r && !r.value) r.value = d.value; }
function askAddWho(emp){
  const p = emp ? mePeople().find(x => x.emp_no === String(emp))
    : {name: ($('#a_nm') || {}).value?.trim(), emp_no: ($('#a_no') || {}).value?.trim(),
       rank: ($('#a_rk') || {}).value, ccg_nm: ($('#a_tm') || {}).value};
  if (!p || !p.name || !p.emp_no || !p.ccg_nm) { toast('성명·사번·CCG팀을 넣어 주세요'); return; }
  ASK.who = ASK.who || [];
  const me = meGet() || {};
  if (String(p.emp_no) === String(me.emp_no) || ASK.who.some(x => String(x.emp_no) === String(p.emp_no))) {
    toast('이미 들어간 분입니다'); return;
  }
  ASK.who.push(p);
  askDraw();
}
function askDropWho(i){ (ASK.who || []).splice(i, 1); askDraw(); }
function askAsPlanned(){
  const p = askMyRow(); if (!p) return;
  KEYS.forEach(k => { const el = $('.a-s-' + k); if (el) el.value = won(p['p_' + k]); });
  askSpentSum();
  askNext();
}
const askSum = (sel, out, label) => {
  const t = KEYS.reduce((s, k) => s + mnum($(sel + k)), 0);
  const el = $(out); if (el) el.textContent = `${label} ${won(t)}원`;
};
function askCostSum(){ askSum('.a-c-', '#askCostTot', '1인당 합계'); }
function askSpentSum(){ askSum('.a-s-', '#askSpentTot', '실적 합계'); }
function askAddTag(t){
  const el = $('#a_tags'); if (!el) return;
  const cur = el.value.split(',').map(x => x.trim()).filter(Boolean);
  if (!cur.includes(t)) cur.push(t);
  el.value = cur.join(', ');
}

function askStart(mode){ ASK = {mode, i: 0, v: {}, who: [], extra: false}; askSel = {}; askDraw(); }
function askStop(){ ASK = null; askSel = {}; askDraw(); }
/* 처음 한 번 — 누구신지 */
function askMeBox(){
  const past = mePeople().slice(0, 8);
  return `<div class="card askcard">
    <div class="askq3">누구세요?</div>
    <p class="cap">한 번만 여쭤보고 이 브라우저에 기억합니다. 다음부터는 안 묻습니다.</p>
    ${past.length ? `<div class="askchips">${past.map(p =>
      `<button type="button" class="askchip" onclick="meSetFrom('${esc(p.emp_no)}')"
         title="${esc(p.emp_no)} · ${esc(p.ccg_nm)}">${esc(p.name)}</button>`).join('')}</div>` : ''}
    ${past.length && !ME_MANUAL
      ? `<div class="askfoot"><button class="btn sm" onclick="meManual()">목록에 없어요</button></div>`
      : `<div class="askor">직접 넣어 주세요</div>
    <div class="form-grid c4">
      <div><label for="me_nm">성명</label>
        <input id="me_nm" placeholder="이름을 치면 사번을 찾습니다" oninput="nameLook('me')"></div>
      <div><label for="me_no">사번</label><input id="me_no" placeholder="사번"></div>
      <div><label for="me_rk">직책</label><select id="me_rk">${
        ST.meta.ranks.map(r => `<option>${r}</option>`).join('')}</select></div>
      <div><label for="me_tm">CCG팀</label><select id="me_tm"><option value="">선택</option>${
        ST.ccg.map(t => `<option value="${esc(t.team)}">${esc(t.team)} · ${esc(t.ccg)}</option>`).join('')
      }</select></div>
    </div>
    <div id="me_hit"></div>
    <div class="btns" style="margin-top:8px"><button class="btn pri" onclick="meSaveNew()">이게 접니다</button></div>`}
  </div>`;
}
function askBox(){
  const me = meGet();
  if (!me) return askMeBox();
  if (!ASK) {
    return `<div class="card askcard">
      <div class="askq3">${esc(me.name)}님, 무엇을 하시겠어요?</div>
      <div class="askgrid">
        ${askOpt('출장 계획 넣기', "askStart('plan')", '가기 전에 계획과 예상 비용을 올립니다')}
        ${askOpt('다녀와서 실적 넣기', "askStart('act')", '실제 쓴 금액을 넣으면 인폼이 만들어집니다')}
      </div>
      <div class="askfoot"><button class="btn sm" onclick="meClear()">${esc(me.name)}님이 아닌가요?</button></div>
    </div>`;
  }
  const flow = ASK_FLOW[ASK.mode];
  const done = ASK.i >= flow.length;
  // 지나온 답은 위에 한 줄씩 — 물어본 말과 고른 값을 둘 다 늘어놓지 않는다
  const trail = flow.slice(0, ASK.i).map(k => {
    const st = ASK_STEP[k], has = ASK.v[k] !== undefined && ASK.v[k] !== null;
    return `<button type="button" class="askdone" onclick="askBack('${k}')">
      <span class="askv">${has ? st.show(ASK.v[k]) : '건너뜀'}</span><span class="askedit">고치기</span></button>`;
  }).join('');
  const body = done ? askConfirm() : (() => {
    const st = ASK_STEP[flow[ASK.i]];
    const needBtn = !['trip'].includes(flow[ASK.i]);
    return `<div class="askq3">${esc(st.q())}</div>${st.view()}
      ${needBtn ? `<div class="btns" style="margin-top:24px">
        <button class="btn pri" onclick="askNext()">다음</button>
        <button class="btn" onclick="askStop()">그만두기</button></div>`
      : `<div class="askfoot"><button class="btn sm" onclick="askStop()">그만두기</button></div>`}`;
  })();
  return `<div class="card askcard">
    ${trail}${body}</div>`;
}
function askConfirm(){
  const p = ASK.mode === 'plan' ? askPlanBody() : null;
  return `<div class="askq3">${ASK.mode === 'plan' ? '이대로 등록할까요?' : '이대로 저장할까요?'}</div>
    <div id="askErr"></div>
    ${ASK.mode === 'plan' ? `
      <div class="asksum">출장자 ${p.travelers.length}명 · 계획 합계
        <b>${won(p.travelers.reduce((s, t) => s + KEYS.reduce((x, k) => x + (t['p_' + k] || 0), 0), 0))}원</b></div>
      <label class="askchk"><input type="checkbox" id="askConfirm">
        <b>실제로 가는 출장입니다</b>
        <span class="sub">체크하면 예산이 확보됩니다. 안 하면 잠정 계획으로 남습니다</span></label>` : ''}
    ${ASK.extra ? `
      ${ASK.mode === 'plan' ? `
      <div class="askor">구분</div>
      <div class="tagpick" id="pick-ptype">${ST.meta.planTypes.map(t =>
        `<button type="button" class="tag${(askSel.ptype || '계획') === t ? ' on' : ''}"
           onclick="askSet('ptype','${esc(t)}')">${esc(t)}</button>`).join('')}</div>
      <div class="askor">태그</div>
      ${(ST.tags || []).length ? `<div class="tagpick">${(ST.tags || []).slice(0, 12).map(x =>
        `<button type="button" class="tag" onclick="askAddTag('${esc(x.tag).replace(/'/g, "\\'")}')">#${esc(x.tag)}</button>`
      ).join('')}</div>` : ''}
      <input id="a_tags" placeholder="새 태그는 쉼표로 여러 개" style="margin-top:4px">` : ''}
      <div style="margin-top:12px"><label for="a_remark">비고</label>
        <input id="a_remark" placeholder="특이사항이 있으면 적어주세요"></div>`
    : `<div class="askfoot"><button class="btn sm" onclick="askExtra()">${
        ASK.mode === 'plan' ? '구분·태그·비고 넣기' : '비고 넣기'}</button></div>`}
    <div class="btns" style="margin-top:24px">
      <button class="btn pri" id="askBtn" onclick="askSubmit()">${ASK.mode === 'plan' ? '등록' : '실적 저장'}</button>
      <button class="btn" onclick="askStop()">그만두기</button></div>`;
}
function askExtra(){ ASK.extra = true; askDraw(); }
/* 칩만 갈아 끼운다 — 다시 그리면 같은 화면에 이미 친 글이 지워진다 */
function askSet(name, v){
  askSel[name] = v;
  const box = $('#pick-' + name);
  if (!box) { askDraw(); return; }
  [...box.children].forEach(b => b.classList.toggle('on', b.textContent.trim() === v));
}
function askDraw(){
  const box = $('.askbox');
  if (!box) return;
  box.innerHTML = askBox();
  if (ASK && ASK.i < ASK_FLOW[ASK.mode].length) askRestore(ASK_FLOW[ASK.mode][ASK.i]);
  if (ASK && ASK.i >= ASK_FLOW[ASK.mode].length && ASK.extra) askRestore('extra');
  const el = box.querySelector('.askq3 ~ .form-grid input,.askq3 ~ div input');
  if (el && el.type !== 'checkbox') el.focus();
}
/* 고치기로 돌아오면 넣어 뒀던 값이 그대로 있어야 한다 */
function askRestore(k){
  const v = ASK.v[k];
  if (k === 'extra') { askFill('a_tags', (ASK.extraV || {}).tags || ''); askFill('a_remark', (ASK.extraV || {}).remark || ''); return; }
  if (v === undefined || v === null) return;
  if (k === 'where') { askFill('a_city', v.city); askFill('a_org', v.org); }
  if (k === 'why')   { askFill('a_purpose', v.purpose); askSel.kind = v.kind; }
  if (k === 'when')  { askFill('a_dep', v.dep); askFill('a_ret', v.ret); askSel.car = v.car; }
  if (k === 'cost')  { KEYS.forEach(x => askFill2('.a-c-' + x, v[x])); askCostSum(); }
  if (k === 'spent') { KEYS.forEach(x => askFill2('.a-s-' + x, v[x])); askSpentSum(); }
}
function askFill(id, v){ const el = $('#' + id); if (el) el.value = v || ''; }
function askFill2(sel, v){ const el = $(sel); if (el) el.value = v ? won(v) : ''; }
function askBack(k){ if (ASK) { ASK.i = ASK_FLOW[ASK.mode].indexOf(k); askDraw(); } }
function askNext(){
  if (!ASK) return;
  const k = ASK_FLOW[ASK.mode][ASK.i];
  const st = ASK_STEP[k];
  const v = st.read();
  if (!st.okay(v)) { toast(st.warn || '값을 넣어 주세요'); return; }
  ASK.v[k] = v;
  ASK.i++;
  askDraw();
}
function askExtraRead(){
  ASK.extraV = {tags: ($('#a_tags') || {}).value || '', remark: ($('#a_remark') || {}).value || ''};
  return ASK.extraV;
}

/* 저장은 기존 라우트로 나간다 — 검증·권한·감사 로그가 전부 그대로 살아 있다 */
function askSubmit(){ return once('#askBtn', ASK && ASK.mode === 'plan' ? askSendPlan : askSendAct); }
function askPlanBody(){
  const v = ASK.v;
  const w = v.where || {city: '', org: ''};
  const y = v.why || {purpose: '', kind: '기타'};
  const t = v.when || {dep: '', ret: '', car: '미사용'};
  const c = v.cost || {trans: 0, lodg: 0, meal: 0, etc: 0};
  const x = ASK.extra ? askExtraRead() : (ASK.extraV || {tags: '', remark: ''});
  return {plan_type: askSel.ptype || '계획', city: w.city, org: w.org, kind: y.kind,
    dep_dt: t.dep, ret_dt: t.ret || t.dep, car: t.car,
    purpose: y.purpose, remark: (x.remark || '').trim(),
    tags: (x.tags || '').split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean),
    confirmed: $('#askConfirm')?.checked || false,
    travelers: (v.who || []).map(p => ({name: p.name, emp_no: p.emp_no, rank: p.rank, ccg_nm: p.ccg_nm,
      p_trans: c.trans, p_lodg: c.lodg, p_meal: c.meal, p_etc: c.etc}))};
}
async function askSendPlan(){
  const body = askPlanBody();
  // 확정 시 예산이 모자라면 막지 않고 확인만 받는다 (계획 화면과 같은 규칙)
  if (body.confirmed) {
    const need = body.travelers.reduce((sm, t) => sm + KEYS.reduce((x, k) => x + (t['p_' + k] || 0), 0), 0);
    const after = (ST.dash.avail || 0) - need;
    if (after < 0 && !confirm(
        `확정 후 가용 잔여가 −${won(Math.abs(after))}원입니다.\n` +
        '예산 부족을 인지한 상태로 계속 확정하시겠습니까?\n\n' +
        '[확인] 계속 확정   /   [취소] 돌아가기')) return;
  }
  const {ok, data} = await api('/groups', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) { showErr('#askErr', data.errors); return; }
  toast(`등록 완료 — ${dispSt(data.group.status)} · ${body.travelers.length}명`);
  PLAN_JUST = data.group;
  YQ = data.group.yq;
  ASK = null; askSel = {};
  await load();
}
async function askSendAct(){
  const me = meGet() || {};
  const gid = ASK.v.trip;
  const g = ST.groups.find(x => x.group_id === gid);
  if (!g) { showErr('#askErr', ['연결된 출장이 없습니다.']); return; }
  const c = ASK.v.spent || {trans: 0, lodg: 0, meal: 0, etc: 0};
  const x = ASK.extra ? askExtraRead() : (ASK.extraV || {remark: ''});
  // 내 줄만 보낸다 — 서버가 사번으로 맞춰 넣으므로 같이 가신 분 실적은 건드리지 않는다
  const body = {travelers: [{emp_no: me.emp_no,
    a_trans: c.trans, a_lodg: c.lodg, a_meal: c.meal, a_etc: c.etc}]};
  if ((x.remark || '').trim()) body.remark = x.remark.trim();
  const {ok, data} = await api(`/groups/${gid}/actual`, {method: 'POST', body: JSON.stringify(body)});
  if (!ok) {
    if (data.status === 401 || (data.errors || []).some(t => /관리자/.test(t))) {
      askAdmin(() => askSubmit()); return;
    }
    showErr('#askErr', data.errors); return;
  }
  // 같이 가신 분 실적이 아직 0이면 인폼 금액이 그만큼 비어 나간다 — 저장은 됐으니 알리기만
  const rest = (data.group.travelers || []).filter(p =>
    String(p.emp_no) !== String(me.emp_no) && KEYS.every(k => !p['a_' + k])).length;
  toast(rest ? `저장했습니다 — 같이 가신 ${rest}명 실적은 아직 비어 있습니다`
             : '저장했습니다 — 인폼 메일이 만들어졌습니다');
  ASK = null; askSel = {};
  await load();
}
function bParse(text){
  const raw = String(text || '').trim();
  if (raw.startsWith('[') || raw.startsWith('{')) return bParseJson(raw);
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (!lines.length) return {groups: [], errs: ['붙여넣은 내용이 없습니다.']};
  const cut = l => l.split('\t').length > 1 ? l.split('\t') : l.split(',');
  let head = cut(lines[0]).map(bnorm);
  let map, body;
  if (head.some(h => BULK_COLS[h])) {        // 머리글이 있는 경우 — 이름으로 매칭
    map = head.map(h => BULK_COLS[h] || '_skip');
    body = lines.slice(1);
  } else {                                   // 머리글 없이 값만 붙인 경우 — 센터 27필드 순서로 가정
    // 열 수가 27에 한참 못 미치면 '일부 열만' 복사한 것이다. 그대로 순서로 읽으면
    // 날짜를 CCG명으로 해석하는 식으로 조용히 어긋난다 — 여기서 멈추고 머리글을 요청한다.
    const ncol = Math.max(...lines.map(l => cut(l).length));
    if (ncol < CENTER_ORDER.length - 4) {
      return {groups: [], errs: [
        `머리글 없이 ${ncol}개 열만 붙여넣었습니다 (센터 양식은 ${CENTER_ORDER.length}개 열).`,
        '일부 열만 복사할 때는 반드시 머리글 행을 함께 붙여넣으세요 — 순서만으로는 어느 칸인지 알 수 없습니다.',
        '필요한 열: ' + BULK_MIN.join(' · '),
      ]};
    }
    map = CENTER_ORDER.map(h => BULK_COLS[h] || '_skip');
    body = lines;
  }
  const errs = [], byKey = new Map();
  body.forEach((line, i) => {
    const c = cut(line), o = {};
    map.forEach((k, j) => { if (k && k !== '_skip') o[k] = (c[j] ?? '').trim(); });
    const ln = i + (body === lines ? 1 : 2);
    const dep = bDate(o.dep_dt), ret = bDate(o.ret_dt) || bDate(o.dep_dt);
    const team = bTeam(o.ccg_nm) || bTeam(o._ccgcode);
    const miss = [];
    if (!o.city) miss.push('출장도시');
    if (!o.org) miss.push('기관&업체');
    if (!o.purpose) miss.push('목적&사유');
    if (!dep) miss.push('출발일자');
    if (!o.name) miss.push('성명');
    if (!o.emp_no) miss.push('사번');
    if (!team) miss.push('CCG명' + (o.ccg_nm ? `('${o.ccg_nm}' 인식 불가)` : ''));
    if (miss.length) { errs.push(`${ln}행: ${miss.join(', ')} 없음/오류`); return; }
    const key = [o.city, o.org, dep, ret, o.purpose].join('|');
    if (!byKey.has(key)) byKey.set(key, {
      plan_type: ['계획','변경','긴급'].includes(bnorm(o.plan_type)) ? bnorm(o.plan_type) : '계획',
      city: o.city, org: o.org, purpose: o.purpose, dep_dt: dep, ret_dt: ret,
      car: bnorm(o.car).includes('자차') ? '자차사용' : '미사용',
      kind: bKind(o.kind), remark: o.remark || '', travelers: [], _rows: [],
    });
    const g = byKey.get(key);
    if (g.travelers.some(t => t.emp_no === o.emp_no)) { errs.push(`${ln}행: 같은 출장에 사번 ${o.emp_no} 중복`); return; }
    const t = {name: o.name, emp_no: o.emp_no,
      rank: bnorm(o.rank) === '팀장' ? '팀장' : 'TL', ccg_nm: team};
    KEYS.forEach(k => { t['p_' + k] = numFrom(o['p_' + k]); t['a_' + k] = numFrom(o['a_' + k]); });
    g.travelers.push(t); g._rows.push(ln);
  });
  return {groups: [...byKey.values()], errs};
}
function bPreview(){
  const {groups, errs} = bParse($('#bkText').value);
  BULK_ROWS = groups;
  const rows = groups.map((g, i) => {
    const pt = g.travelers.reduce((a, t) => a + KEYS.reduce((x, k) => x + t['p_' + k], 0), 0);
    const at = g.travelers.reduce((a, t) => a + KEYS.reduce((x, k) => x + t['a_' + k], 0), 0);
    return `<tr><td class="num">${i + 1}</td>
      <td><b>${esc(g.city)} ${esc(g.org)}</b><div class="sub">${esc(g.purpose)}</div></td>
      <td class="num">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</td>
      <td>${g.travelers.map(t => esc(t.name)).join(', ')} <span class="sub">${g.travelers.length}명</span></td>
      <td class="num">${pt ? won(pt) : '–'}</td><td class="num">${at ? won(at) : '–'}</td>
      <td class="sub">${g._rows.join(',')}행</td></tr>`;
  }).join('');
  $('#bkOut').innerHTML = `
    ${errs.length ? `<div class="err">${errs.map(esc).join('\n')}</div>` : ''}
    ${groups.length ? `<div class="note" style="margin:8px 0 0">
        <b>${groups.length}건</b> · 출장자 <b>${groups.reduce((a, g) => a + g.travelers.length, 0)}명</b>
        — 같은 도시·업체·일자·목적은 한 건으로 묶었습니다. 내용을 확인하고 아래 버튼을 누르세요.</div>
      <div class="scroll" style="margin-top:8px"><table>
        <thead><tr><th class="num">#</th><th>출장</th><th class="num">기간</th><th>출장자</th>
          <th class="num">계획</th><th class="num">실적</th><th>원본</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
      <div class="btns">
        <button class="btn pri" id="bkGo" onclick="bSubmit()">${groups.length}건 등록</button>
        <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin:0">
          <input type="checkbox" id="bkConfirm" style="width:auto;margin:0"> 실제로 가는 출장 — 바로 확정(예산 반영)</label>
      </div>`
    : '<div class="note" style="margin:8px 0 0">등록할 수 있는 행이 없습니다.</div>'}`;
}
async function bSubmit(){
  if (!BULK_ROWS || !BULK_ROWS.length) return;
  const confirmed = $('#bkConfirm')?.checked || false;
  const btn = $('#bkGo'); if (btn) { btn.disabled = true; btn.textContent = '등록 중…'; }
  let okN = 0; const fail = [];
  for (const g of BULK_ROWS) {
    const body = {...g, confirmed}; delete body._rows;
    const r = await api('/groups', {method: 'POST', body: JSON.stringify(body)});
    if (r.ok) okN++; else fail.push(`${g.city} ${g.org}: ${(r.data.errors || ['실패'])[0]}`);
  }
  await load();
  BULK_ROWS = null;
  rBulk(); nav('bulk');                     // 화면을 먼저 새로 그린 뒤 결과를 넣는다
  $('#bkText').value = fail.length ? $('#bkText').value : '';   // 실패가 있으면 원본을 남겨 고칠 수 있게
  $('#bkOut').innerHTML = `<div class="${fail.length ? 'err' : 'note'}" style="margin:8px 0 0">
    <b>${okN}건 등록 완료</b>${fail.length
      ? `\n실패 ${fail.length}건 — 아래 내용을 고쳐 다시 등록하세요:\n${fail.map(esc).join('\n')}`
      : ''}</div>`;
  toast(`${okN}건 등록 완료${fail.length ? ` · 실패 ${fail.length}건` : ''}`);
}
function rBulk(){
  $('#v-bulk').innerHTML = `
    <div class="card">
      <h2>엑셀 · JSON 으로 한 번에 등록</h2>
      <p class="cap">센터 관리 시트에서 <b>행을 선택해 복사(Ctrl+C)</b> 하고 아래 칸에 <b>붙여넣기(Ctrl+V)</b> 하세요.
        머리글이 있어도 되고, 없으면 센터 27필드 순서로 읽습니다.
        <b>JSON</b> 을 붙여넣어도 같은 방식으로 등록됩니다(사내 LLM 이 만든 결과를 그대로).</p>
      <div class="note">
        <b>꼭 있어야 하는 열</b> · 출장도시 · 출장기관&amp;업체 · 출장목적&amp;사유 · 출발일자 · 성명 · 사번 · CCG명<br>
        <span class="sub">복귀일자가 없으면 출발일과 같은 날(당일)로, 자차·출장구분·비고가 없으면 기본값으로 넣습니다.
        같은 도시·업체·일자·목적 행은 <b>동행자</b>로 보고 한 건으로 묶습니다. 금액은 콤마·"원"이 있어도 됩니다.</span>
      </div>
      <details class="fold" style="margin-top:12px">
        <summary>JSON 형식 보기 — 사내 LLM 에게 이 형식을 그대로 주세요</summary>
        <div class="promptbox" id="jsonSpec">${esc(jsonSpec())}</div>
        <div class="btns" style="margin-top:8px">
          <button class="btn sm" onclick="copyText(jsonSpec(),'JSON 형식 안내를 복사했습니다')">형식 복사</button>
          <button class="btn sm" onclick="bSampleJson()">JSON 예시 넣어보기</button>
        </div>
      </details>
      <label for="bkText">붙여넣기</label>
      <textarea id="bkText" class="mono" style="min-height:152px;font-size:13px;line-height:20px"
        placeholder="예)  계획  소재  50119134  EDTW소재기술  20140508  박영희  팀장  청주  원익머트리얼즈  NF3 정기 Audit  2026-08-04  2026-08-05 ..."
        oninput="bPreview()"></textarea>
      <div class="btns" style="margin-top:8px">
        <button class="btn" onclick="bPreview()">확인</button>
        <button class="btn" onclick="$('#bkText').value='';$('#bkOut').innerHTML='';BULK_ROWS=null">지우기</button>
        <button class="btn" onclick="bSample()">예시 넣어보기</button>
        <a class="btn" href="${API}/bulk_template.xls" style="margin-left:auto">엑셀 양식 내려받기 ↓</a>
      </div>
      <div id="bkOut"></div>
    </div>`;
}
function bSampleJson(){
  const yy = YQ.split('-')[0], mm = String(parseInt(YQ.split('-')[1]) * 3).padStart(2, '0');
  const teams = ST.ccg.map(x => x.team);
  $('#bkText').value = JSON.stringify([
    {plan_type: '계획', city: '청주', org: '원익머트리얼즈', purpose: 'NF3 순도 관리 정기 Audit',
     kind: '정기 Audit', dep_dt: `${yy}-${mm}-04`, ret_dt: `${yy}-${mm}-05`, car: '자차사용', remark: '',
     travelers: [
       {name: '박영희', emp_no: '20140508', rank: '팀장', ccg_nm: teams[0],
        p_trans: 70000, p_lodg: 95000, p_meal: 65000, p_etc: 0},
       {name: '이정훈', emp_no: '2071478', rank: 'TL', ccg_nm: teams[Math.min(1, teams.length - 1)],
        p_trans: 70000, p_lodg: 95000, p_meal: 65000, p_etc: 0}]},
    {plan_type: '계획', city: '이천', org: '동우화인켐', purpose: 'ArF PR 품질 실사',
     kind: '실사&사양 개선,협의', dep_dt: `${yy}-${mm}-11`, ret_dt: `${yy}-${mm}-11`, car: '미사용', remark: '',
     travelers: [
       {name: '김철수', emp_no: '20150322', rank: '팀장', ccg_nm: teams[Math.min(2, teams.length - 1)],
        p_trans: 80000, p_lodg: 0, p_meal: 30000, p_etc: 0}]},
  ], null, 2);
  bPreview();
}
function bSample(){
  const yy = YQ.split('-')[0], mm = String(parseInt(YQ.split('-')[1]) * 3).padStart(2, '0');
  $('#bkText').value =
    ['구분\tCCG명\t사번\t성명\t직책\t출장도시\t출장기관&업체\t출장목적&사유\t출발일자\t복귀일자\t자차사용여부\t출장구분\t계획_교통비\t계획_숙박비\t계획_식대&잡비',
     `계획\tEDTW소재기술\t20140508\t박영희\t팀장\t청주\t원익머트리얼즈\tNF3 순도 정기 Audit\t${yy}-${mm}-04\t${yy}-${mm}-05\t자차사용\t정기 Audit\t70,000\t95,000\t65,000`,
     `계획\tC&C소재기술\t2071478\t이정훈\tTL\t청주\t원익머트리얼즈\tNF3 순도 정기 Audit\t${yy}-${mm}-04\t${yy}-${mm}-05\t자차사용\t정기 Audit\t70,000\t95,000\t65,000`,
     `계획\tPatterning소재기술\t20150322\t김철수\t팀장\t이천\t동우화인켐\tArF PR 품질 실사\t${yy}-${mm}-11\t${yy}-${mm}-11\t미사용\t실사&사양 개선,협의\t80,000\t0\t30,000`].join('\n');
  bPreview();
}

/* 태그 편집 — 분류·검색용이라 이관·완료된 건도 고칠 수 있다(금액·상태는 건드리지 않는다) */
async function editTags(gid){
  const g = ST.groups.find(x => x.group_id === gid); if (!g) return;
  const used = (ST.tags || []).map(x => x.tag).join(' · ');
  const cur = (g.tags || []).join(', ');
  const v = prompt(`태그 (쉼표로 여러 개, 비우면 전부 삭제)\n\n${gname(g)}\n`
    + (used ? `\n지금까지 쓰인 태그: ${used}` : ''), cur);
  if (v === null) return;
  const {ok, data} = await api(`/groups/${gid}/tags`, {method: 'POST', body: JSON.stringify({tags: v})});
  if (!ok) { toast((data.errors || ['저장 실패'])[0]); return; }
  await load(); renderListBody();
  toast(data.tags.length ? `태그 ${data.tags.length}개 저장` : '태그를 모두 지웠습니다');
}

/* ═══ 결재 작성 도우미 (국내 출장 정산서) ═══
   결재는 사내 전자결재 사이트에서 사람이 올린다. 이 화면은 그 창의 칸 순서 그대로
   '넣을 값'을 꺼내 주고, 한 줄씩·통째로 복사하게만 한다. 값을 대신 써 넣지 않는다.
   정산서는 인원을 추가할 수 있어 한 출장을 한 장으로 올린다 — 공통 값 + 인원별 값. */
const APV_TRANS = ['타인 차량 동승', '공용차량', '개인차량(고속도로이용)', '개인차량(국도이용)',
                   '대중교통', '셔틀버스', '의전차량', '항공기', '고속철도', '렌트차량'];
const APV_FROM = ['근무지 사업장 — 분당캠퍼스', '근무지 사업장 — 센터원오피스',
                  '근무지 사업장 — 이천캠퍼스', '근무지 사업장 — 청주캠퍼스', '거주지(주소 입력)'];

/* 출장 한 건에 한 번만 넣는 값 = [라벨, 값, 도움말]. 값이 비면 '시스템에 없는 값'으로 표시 */
function apvCommon(g){
  const car = g.car === '자차사용' ? '개인차량(고속도로이용)' : '대중교통';
  return [
    ['출장 목적', g.purpose || '', ''],
    ['세부일정', `${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} ${g.city} ${g.org} · ${g.purpose}`,
     '일자 · 방문처 · 목적을 한 줄로'],
    ['방문회사', g.org || '', ''],
    ['방문자', names(g).replace(/<[^>]*>/g, ''), '우리 쪽 출장자입니다. 상대측 담당자는 결재 창에서 직접'],
    ['목적지 주소 및 전화번호', '', '시스템에 없는 값 — 결재 창에서 직접'],
    ['출장일시', `${g.dep_dt} ~ ${g.ret_dt || g.dep_dt}`, '시작 ~ 종료'],
    ['교통편', car, '자차 여부로 미리 골라 둔 것 — 실제와 다르면 결재 창에서 바꾸세요'],
    ['출발지', '', '근무지 사업장 또는 거주지 — 결재 창에서 고르세요'],
    ['출장지', [g.city, g.org].filter(Boolean).join(' '), '주소는 결재 창에서 [추가]'],
    ['비고', g.remark || '', ''],
  ];
}
/* 인원 — 정산서에서 [추가]로 늘리는 부분. 사람마다 사번·소속·금액이 붙는다 */
function apvPeopleHead(isAct){
  return ['성명', '사번', '소속 CCG',
          `${isAct ? '실적' : '계획'} 교통비`, '숙박비', '식대&잡비', '기타', '합계'];
}
function apvPeopleRows(g){
  const isAct = (g.act_tot || 0) > 0, pre = isAct ? 'a_' : 'p_';
  return (g.travelers || []).map(p => {
    const v = k => Number(p[pre + k]) || 0;
    const sum = ['trans', 'lodg', 'meal', 'etc'].reduce((a, k) => a + v(k), 0);
    return [p.name || '', p.emp_no || '', `${p.ccg_nm || ''}${p.ccg ? ` (${p.ccg})` : ''}`,
            won(v('trans')), won(v('lodg')), won(v('meal')), won(v('etc')), won(sum)];
  });
}
/* 통째로 복사 — 탭으로 나눠 결재 창·엑셀 어디에 붙여도 칸이 맞는다 */
function apvText(g){
  const isAct = (g.act_tot || 0) > 0;
  const L = apvCommon(g).filter(([, v]) => v).map(([k, v]) => `${k}\t${v}`);
  L.push('', `인원 ${(g.travelers || []).length}명`);
  L.push(apvPeopleHead(isAct).join('\t'));
  apvPeopleRows(g).forEach(r => L.push(r.join('\t')));
  L.push(`${isAct ? '실적' : '계획'} 총합계\t${won(isAct ? g.act_tot : g.plan_tot)}원`);
  return L.join('\n');
}
function openApproval(gid){ drawApproval(gid); }
function drawApproval(gid){
  const g = ST.groups.find(x => x.group_id === gid);
  if (!g) return;
  const T = g.travelers || [];
  const url = (ST.settings && ST.settings.approval_url) || '';
  const isAct = (g.act_tot || 0) > 0;
  const head = apvPeopleHead(isAct);
  document.getElementById('apvCard')?.remove();
  const el = document.createElement('section');
  el.className = 'mailcard'; el.id = 'apvCard';
  el.innerHTML = `
    <div class="mh"><span>국내 출장 정산서 작성 도우미 · ${esc(gname(g))} ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</span>
      <span class="mhb"><button title="닫기" onclick="this.closest('.mailcard').remove()">×</button></span></div>
    <div class="how">사내 결재 창의 칸 순서대로 정리했습니다. 줄마다 <b>복사</b>, 위에 <b>전체 복사</b>.
      <span class="sub">${isAct ? '실적이 입력된 건이라 <b>실적 금액</b>' : '아직 실적 전이라 <b>계획 금액</b>'}을
      보여줍니다. 정산서는 <b>인원을 추가</b>할 수 있어 이 출장 <b>${T.length}명을 한 장</b>에 올립니다.</span></div>
    <div style="padding:0 16px 16px">
      <div class="btns" style="margin:12px 0">
        ${url ? `<a class="btn pri" href="${esc(url)}" target="_blank" rel="noopener">국내 출장 정산서 열기 ↗</a>`
              : `<span class="sub">결재 사이트 주소가 없습니다 — <b>시스템 설정</b>에서 넣으면 여기에 바로가기가 생깁니다.</span>`}
        <button class="btn" onclick="copyText(apvText(ST.groups.find(x=>x.group_id==='${gid}')),
          '정산서 항목을 전부 복사했습니다 (공통 + 인원)')">전체 복사</button>
      </div>

      <div class="scroll"><table class="apv-tbl">
        <thead><tr><th>정산서 칸 — 한 번만</th><th>넣을 값</th><th></th></tr></thead>
        <tbody>${apvCommon(g).map(([k, v, hint]) => `<tr>
          <td>${esc(k)}</td>
          <td>${v ? `<b>${esc(v)}</b>${hint ? `<div class="sub">${esc(hint)}</div>` : ''}`
            : `<span class="sub">${esc(hint || '시스템에 없는 값')}</span>`}</td>
          <td class="num">${v ? `<button class="btn sm"
            onclick="copyText(${JSON.stringify(String(v))},'복사했습니다')">복사</button>` : ''}</td></tr>`).join('')}
        </tbody></table></div>

      <h2 style="margin:16px 0 4px;color:var(--navy);font-size:16px;line-height:24px">인원 ${T.length}명 — 정산서에서 [추가]</h2>
      <p class="cap" style="margin:0 0 8px">사람 줄의 <b>복사</b>는 그 한 명의 값을 탭으로 나눠 담습니다.</p>
      <div class="scroll"><table class="apv-tbl">
        <thead><tr>${head.map((h, i) => `<th${i >= 3 ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}<th></th></tr></thead>
        <tbody>${apvPeopleRows(g).map((r, i) => `<tr>
          ${r.map((v, j) => `<td${j >= 3 ? ' class="num"' : ''}>${j === 7 ? `<b>${esc(v)}</b>` : esc(v)}</td>`).join('')}
          <td class="num"><button class="btn sm"
            onclick="copyText(${JSON.stringify(apvPeopleRows(g)[i].join('\t'))},'${esc(r[0])} 줄을 복사했습니다')">복사</button></td>
        </tr>`).join('')}
        </tbody>
        <tfoot><tr><td colspan="7">${isAct ? '실적' : '계획'} 총합계</td>
          <td class="num"><b>${won(isAct ? g.act_tot : g.plan_tot)}원</b></td><td></td></tr></tfoot>
      </table></div>

      <details class="fold" style="margin-top:12px">
        <summary>교통편 · 출발지 선택지 — 결재 창에서 고르는 것</summary>
        <div class="note" style="margin-top:8px">
          <b>교통편</b> ${APV_TRANS.map(x => esc(x)).join(' · ')}<br>
          <span class="sub">국도이용을 고르면 이동경로를 함께 적어야 합니다.</span>
        </div>
        <div class="note" style="margin-top:8px">
          <b>출발지</b> ${APV_FROM.map(x => esc(x)).join(' · ')}
        </div>
      </details>
      <p class="cap" style="margin:12px 0 0">증빙(카드 지불 정보)은 결재 창이 직접 불러옵니다.
        위 <b>${isAct ? '실적' : '계획'} 총합계</b>와 대조하세요.</p>
    </div>`;
  mailHost().appendChild(el);
  el.scrollIntoView({behavior: 'smooth', block: 'center'});
}

/* ═══ 인폼 카드 ═══ */
async function reopenMail(gid){
  const {ok, data} = await api(`/groups/${gid}/mail`);
  if (!ok) { toast((data.errors || ['인폼을 만들 수 없습니다'])[0]); return; }
  showMail(data.mail);
}
/* 인폼은 지금 보고 있는 화면의 맨 아래에 붙는다.
   떠 있는 카드는 아래쪽 버튼을 가려서 접기·여백 보정이 필요했다 — 흐름 안에 두면 그럴 일이 없다. */
function mailHost(){
  return [...document.querySelectorAll('.view')].find(v => v.offsetParent !== null) || document.body;
}
function showMail(mail){
  document.getElementById('mailCard')?.remove();
  const el = document.createElement('section');
  el.className = 'mailcard'; el.id = 'mailCard';
  el.innerHTML = `
    <div class="mh"><span>${esc(mail.heading || '실비 이관 요청 인폼 (그룹당 1통)')}</span>
      <span class="mhb">
        <button title="닫기" onclick="this.closest('.mailcard').remove()">×</button></span></div>
    <div class="meta">
      <div class="row"><span class="k">수신</span>${mail.to
        ? `<span style="word-break:break-all">${esc(mail.to)}</span>`
        : `<span style="color:var(--red);font-weight:700">${esc(mail.to_hint || '수신자: 직접 지정')}</span>`}</div>
      <div class="row"><span class="k">제목</span><span>${esc(mail.subject)}</span></div>
    </div>
    <div class="how">아래 표를 <b>끌어다 놓기(드래그 &amp; 드롭)</b> 하거나 <b>표 포함 복사</b> 후
      메일에 붙여넣어 보내주세요. <span class="sub">서식·표가 그대로 유지됩니다.</span></div>
    <div class="dragzone">
      <div class="draghint"><span class="grip" aria-hidden="true">⠿</span>
        <span>여기를 <b>마우스로 끌어</b> 메일 본문에 놓으세요</span></div>
      <div class="body" id="mailBody" draggable="true"
           title="끌어서 메일 본문에 놓으세요">${mail.body_html}</div>
    </div>
    <div class="mf">
      <button class="btn sm pri" id="mailCopyHtml">표 포함 복사</button>
      <button class="btn sm" id="mailCopyText">본문 텍스트 복사</button>
      <span class="mfhint">수신 · 제목은 위에 있습니다</span>
    </div>`;
  mailHost().appendChild(el);
  el.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  // 드래그로 메일에 바로 떨어뜨릴 수 있게 HTML 서식을 함께 실어 보낸다
  const zone = el.querySelector('.dragzone');
  $('#mailBody').addEventListener('dragstart', e => {
    e.dataTransfer.setData('text/html', mail.body_html);
    e.dataTransfer.setData('text/plain', mail.body_text);
    e.dataTransfer.effectAllowed = 'copy';
    zone.classList.add('dragging');          // 끌고 가는 중이라는 표시
  });
  $('#mailBody').addEventListener('dragend', () => zone.classList.remove('dragging'));
  $('#mailCopyHtml').onclick = async () => {
    if (!navigator.clipboard) { copyText(mail.body_text); return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([mail.body_html], {type: 'text/html'}),
        'text/plain': new Blob([mail.body_text], {type: 'text/plain'})})]);
      toast('표 포함 복사됨 — 메일에 붙여넣으세요');
    } catch (e) { copyText(mail.body_text, '텍스트로 복사되었습니다'); }
  };
  $('#mailCopyText').onclick = () => copyText(mail.body_text, '본문을 복사했습니다');
}

/* ═══ 출장 내역 ═══ */
/* 목록 정렬·필터·검색 상태 (출장 내역 / 예산 관리 공용) */
// 컬럼 정의 — 머리글 클릭 정렬 + 컬럼별 검색창
const LCOLS = [
  {k:'stage', th:'상태',     f:'sel'},
  {k:'name',  th:'출장',     f:'txt', ph:'도시·업체·목적'},
  {k:'trav',  th:'출장자',   f:'txt', ph:'성명·사번·팀'},
  {k:'date',  th:'기간',     f:'txt', ph:'예: 07/25', num:true},
  {k:'plan',  th:'계획',     f:'min', ph:'≥금액', num:true},
  {k:'act',   th:'실적',     f:'min', ph:'≥금액', num:true},
];
const LQ = {q:'', sort:'stage', dir:'desc', group:true, col:{}, tag:''};
const BQ = {q:'', type:'', dir:'desc'};
function setBQ(k, v){ BQ[k] = v; rBudget(); nav('budget'); }
function toggleBDir(){ BQ.dir = BQ.dir === 'asc' ? 'desc' : 'asc'; rBudget(); nav('budget'); }
const dirIcon = d => d === 'asc' ? '▲ 오름차순' : '▼ 내림차순';

function lVal(g, k){
  if (k === 'stage') return g.stage;
  if (k === 'name')  return gname(g) + ' ' + (g.purpose || '');
  if (k === 'trav')  return (g.travelers || []).map(p => `${p.name} ${p.emp_no} ${p.ccg_nm || ''}`).join(' ');
  if (k === 'date')  return g.dep_dt || '';
  if (k === 'plan')  return g.plan_tot || 0;
  if (k === 'act')   return g.act_tot || 0;
  return '';
}
function listRows(){
  const all = ST.groups.filter(g => g.yq === YQ);
  const q = LQ.q.trim().toLowerCase();
  // 전체 검색은 '데이터'만 대상 — 관리 버튼 문구가 걸리지 않도록
  const hay = g => [g.city, g.org, g.purpose, g.roll, g.plan_type, ...(g.tags || []),
    ...(g.travelers || []).flatMap(p => [p.name, p.emp_no, p.ccg_nm])]
    .filter(Boolean).join(' ').toLowerCase();
  const G = all.filter(g => {
    if (LQ.tag && !(g.tags || []).includes(LQ.tag)) return false;
    if (q && !hay(g).includes(q)) return false;
    for (const c of LCOLS) {                       // 컬럼별 검색창
      const v = String(LQ.col[c.k] || '').trim();
      if (!v) continue;
      if (c.k === 'stage') { if (g.roll !== v) return false; continue; }
      if (c.f === 'min') {
        if ((Number(lVal(g, c.k)) || 0) < (Number(v.replace(/[^0-9-]/g, '')) || 0)) return false;
        continue;
      }
      if (c.k === 'date') {
        const period = `${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} ${g.dep_dt} ${g.ret_dt}`;
        if (!period.includes(v)) return false;
        continue;
      }
      if (!String(lVal(g, c.k)).toLowerCase().includes(v.toLowerCase())) return false;
    }
    return true;
  });
  const sgn = LQ.dir === 'asc' ? 1 : -1;
  const cmpCol = (a, b, k) => { const x = lVal(a, k), y = lVal(b, k);
    return (typeof x === 'number' && typeof y === 'number') ? x - y
      : (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0); };
  const sorted = G.slice().sort((a, b) => {
    if (LQ.group) { const d = a.stage - b.stage; if (d) return d; }   // 그룹은 항상 워크플로 순
    const k = effSort();
    return sgn * cmpCol(a, b, k) || cmpCol(a, b, 'date');
  });
  return {all, G: sorted};
}
/* 묶기 중에는 그룹 순서가 고정이라 '상태' 정렬의 실제 대상은 기간이다.
   ▲▼ 를 상태 머리글에 붙이면 누른 곳과 뒤집히는 곳이 달라 거짓말이 된다. */
function effSort(){ return (LQ.group && LQ.sort === 'stage') ? 'date' : LQ.sort; }
function sortList(k){
  if (LQ.sort === k) LQ.dir = LQ.dir === 'asc' ? 'desc' : 'asc';
  else { LQ.sort = k; LQ.dir = (k === 'plan' || k === 'act') ? 'desc' : 'asc'; }
  renderListBody();
}
function setCol(k, v){ LQ.col[k] = v; renderListBody(); }   // 본문만 갱신 → 입력 포커스 유지
function clearList(){ LQ.q = ''; LQ.col = {}; LQ.tag = ''; rList(); nav('list'); }
function setTagFilter(tag){ LQ.tag = (LQ.tag === tag) ? '' : tag; rList(); nav('list'); }
function toggleGroup(on){ LQ.group = on; renderListBody(); }
function toggleLDir(){ LQ.dir = LQ.dir === 'asc' ? 'desc' : 'asc'; renderListBody(); }

/* 출장자별 비목 내역 — 사내 출장 정산서를 쓰려면 이게 보여야 한다.
   지금까지는 이 정보가 '출장 실적 입력' 화면에만 있어서, 담당자가 확인하려면
   되돌리기 → 수정 으로 들어가야 했다(상태를 건드려야 볼 수 있었다).
   여기서는 읽기만 한다 — 어떤 상태도 바뀌지 않는다. */
const n0 = v => Number.isFinite(+v) ? +v : 0;
function detailRows(g){
  const act = g.act_tot > 0;                       // 실적이 있으면 실적, 없으면 계획
  const px = act ? 'a_' : 'p_';
  const body = g.travelers.map(p => {
    const cells = KEYS.map(k => n0(p[px + k]));
    const sum = cells.reduce((a, v) => a + v, 0);
    const plan = KEYS.reduce((a, k) => a + n0(p['p_' + k]), 0);
    const gap = act ? sum - plan : 0;
    const eff = pEff(p, g);
    return `<tr>
      <td><b>${esc(p.name)}</b> <span class="sub">${esc(p.rank || '')}</span></td>
      <td class="mono">${esc(p.emp_no)}</td>
      <td>${esc(p.ccg_nm || '')} <span class="sub">${esc(p.ccg || '')}</span></td>
      ${cells.map(v => `<td class="num">${v ? won(v) : '–'}</td>`).join('')}
      <td class="num"><b>${won(sum)}</b></td>
      ${act ? `<td class="num" style="color:${gap > 0 ? 'var(--red)' : gap < 0 ? 'var(--green)' : 'var(--mut)'}">${
        gap ? (gap > 0 ? '+' : '−') + won(Math.abs(gap)) : '–'}</td>` : ''}
      <td>${eff ? `<span class="status ${pStClass(eff)}">${esc(eff)}</span>` : '<span class="sub">–</span>'}</td>
    </tr>`;
  }).join('');
  const tot = KEYS.map(k => g.travelers.reduce((a, p) => a + n0(p[px + k]), 0));
  return `<table class="dtl">
    <thead><tr><th>성명</th><th>사번</th><th>CCG팀</th>
      ${KEYS.map((k, i) => `<th class="num">${ST.meta.cost[i].label}</th>`).join('')}
      <th class="num">${act ? '실적' : '계획'} 합계</th>${act ? '<th class="num">계획 대비</th>' : ''}
      <th>처리 상태</th></tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr><td colspan="3">합계 ${g.travelers.length}명</td>
      ${tot.map(v => `<td class="num">${won(v)}</td>`).join('')}
      <td class="num">${won(tot.reduce((a, v) => a + v, 0))}</td>${act ? '<td></td>' : ''}<td></td></tr></tfoot>
  </table>`;
}
/* 출장자 개인의 실효 처리 상태 — core.eff_status 와 같은 규칙 */
function pEff(p, g){
  if (['계획 등록', '확정 예정', '취소'].includes(g.status)) return '';
  return p.status || g.status;
}
/* 정산서에 그대로 옮길 수 있게 탭 구분으로 — 엑셀에 붙여넣으면 칸이 맞는다 */
function copyDetail(gid){
  const g = ST.groups.find(x => x.group_id === gid);
  if (!g) return;
  const act = g.act_tot > 0, px = act ? 'a_' : 'p_';
  const head = ['성명', '사번', '직책', 'CCG팀', 'CCG', ...ST.meta.cost.map(c => c.label), '합계'];
  const lines = [`${gname(g)} · ${g.purpose} · ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} (${act ? '실적' : '계획'})`,
    head.join('\t')];
  g.travelers.forEach(p => {
    const cells = KEYS.map(k => n0(p[px + k]));
    lines.push([p.name, p.emp_no, p.rank || '', p.ccg_nm || '', p.ccg || '',
      ...cells, cells.reduce((a, v) => a + v, 0)].join('\t'));
  });
  copyText(lines.join('\n'), '정산서용 표를 복사했습니다 — 엑셀에 붙여넣으세요');
}
let DTL = new Set();                       // 펼쳐 둔 행 (다시 그려도 유지)
let PDTL = new Set();                      // 이관·처리 화면에서 펼쳐 둔 그룹
/* 행 아무 데나 눌러 내역을 편다. 버튼·체크박스·메뉴 위에서 누른 것은 그쪽 동작이라 건너뛴다
   (예전엔 '내역 ▼' 버튼이 따로 있었는데, 행을 눌러도 같은 일이 나야 자연스럽다) */
function rowClick(ev, gid){
  if (ev.target.closest('button,a,input,select,label,details,.rowmenu')) return;
  toggleDetail(gid);
}
function toggleDetail(gid){
  DTL.has(gid) ? DTL.delete(gid) : DTL.add(gid);
  renderListBody();
}
/* 행의 ⋯ 메뉴 — 한 번에 하나만 열리고, 바깥을 누르거나 Esc 로 닫힌다 */
function closeMenus(except){
  $$('details.rowmenu[open]').forEach(d => { if (d !== except) d.removeAttribute('open'); });
}
document.addEventListener('click', e => {
  const d = e.target.closest('details.rowmenu');
  closeMenus(d);
}, true);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenus(); });

/* ═══ 여러 건 골라 한 번에 확정 ═══
   엑셀로 20건을 넣고 하나씩 20번 누르던 자리. 고를 수 있는 것은 잠정 계획뿐이고,
   금액이 나가는 전환(이관·완료·취소)은 일괄로 열지 않는다. */
const SEL = new Set();
function toggleSel(gid, on){
  if (on) SEL.add(gid); else SEL.delete(gid);
  renderListBody();
}
function selAll(on){
  const {G} = listRows();
  G.filter(g => g.status === '계획 등록').forEach(g => on ? SEL.add(g.group_id) : SEL.delete(g.group_id));
  renderListBody();
}
function selClear(){ SEL.clear(); renderListBody(); }
function drawSelBar(G){
  const bar = $('#selBar');
  if (!bar) return;
  const pick = G.filter(g => SEL.has(g.group_id));
  const able = G.filter(g => g.status === '계획 등록');
  const head = $('#selAll');
  if (head) {
    head.checked = able.length > 0 && able.every(g => SEL.has(g.group_id));
    head.indeterminate = !head.checked && able.some(g => SEL.has(g.group_id));
    head.disabled = able.length === 0;
  }
  if (!pick.length) { bar.className = 'selbar'; bar.innerHTML = ''; return; }
  const sum = pick.reduce((a, g) => a + (g.plan_tot || 0), 0);
  const avail = ST.dash.avail || 0;
  const over = sum > avail;
  bar.className = 'selbar on';
  bar.innerHTML = `<span><b>${n0(pick.length)}건</b> 선택 · 계획 합계 <b>${won(sum)}</b>원`
    + (over ? ` <span style="color:var(--red)">— 가용 잔여 ${won(avail)}원을 넘습니다</span>` : '')
    + `</span>
    <span class="gb">
      <button class="btn pri sm" id="selGo" onclick="bulkConfirm()">선택한 ${n0(pick.length)}건 출장 확정</button>
      <button class="btn sm" onclick="selClear()">선택 해제</button>
    </span>`;
}
async function bulkConfirm(){
  const {G} = listRows();
  const pick = G.filter(g => SEL.has(g.group_id));
  if (!pick.length) return;
  const sum = pick.reduce((a, g) => a + (g.plan_tot || 0), 0);
  const avail = ST.dash.avail || 0;
  let msg = `${pick.length}건을 출장 확정할까요?\n계획 합계 ${won(sum)}원만큼 예산이 확보됩니다.\n\n`
    + pick.slice(0, 8).map(g =>
        ` · ${fmtD(g.dep_dt)} ${gname(g)} — ${(g.purpose || '').slice(0, 24)}`
        + ` (${g.travelers.length}명 ${won(g.plan_tot)}원)`).join('\n')
    + (pick.length > 8 ? `\n … 외 ${pick.length - 8}건` : '');
  if (sum > avail) msg += `\n\n확정 후 가용 잔여가 −${won(sum - avail)}원이 됩니다. 그래도 진행할까요?`;
  if (!confirm(msg)) return;
  const btn = $('#selGo');
  if (btn) { btn.disabled = true; btn.textContent = '확정 중…'; }
  const {ok, data} = await api('/groups/bulk_status', {method: 'POST',
    body: JSON.stringify({status: '확정 예정', group_ids: pick.map(g => g.group_id)})});
  if (!ok) { toast((data.errors || ['확정하지 못했습니다'])[0]); if (btn) btn.disabled = false; return; }
  const done = (data.done || []).length, fail = data.failed || [];
  SEL.clear();
  await load();
  rList(); nav('list');
  if (fail.length) {
    showErr('#listErr', [`${done}건 확정 · ${fail.length}건 실패`]
      .concat(fail.slice(0, 5).map(f => `${f.name} — ${f.reason}`)));
  } else {
    toast(`${done}건을 확정했습니다 — 예산에 반영됐습니다`);
  }
}
function listRowHtml(g, grouped){
  /* 행마다 버튼 4개를 늘어놓으면 한 화면에 100개가 넘고, 되돌릴 수 없는 삭제가
     주요 동작과 같은 크기로 붙는다. 주요 동작 1개 + 내역 + 나머지는 ⋯ 메뉴로. */
  const gid = g.group_id;
  const main = [];                          // 눈에 보이는 주요 동작 (상태마다 하나)
  const more = [];                          // ⋯ 안으로 들어가는 것
  if (g.status === '계획 등록') {
    main.push(`<button class="btn sm pri" onclick="setStatus('${gid}','확정 예정')">출장 확정</button>`);
    more.push(['수정', `editGroup('${gid}')`, '']);
    more.push(['삭제 (되돌릴 수 없음)', `delGroup('${gid}')`, 'danger']);
  } else if (g.status === '확정 예정') {
    main.push(`<button class="btn sm" onclick="openActual('${gid}')">실적 입력</button>`);
    more.push(['수정', `editGroup('${gid}')`, '']);
    more.push(['확정 해제 (잠정으로)', `setStatus('${gid}','계획 등록')`, '']);
    more.push(['출장 취소', `setStatus('${gid}','취소')`, 'danger']);
  } else if (g.status !== '취소') {
    if (g.act_tot > 0) main.push(`<button class="btn sm" onclick="reopenMail('${gid}')">인폼 보기</button>`);
    more.push(['수정', `editGroup('${gid}')`, '']);
    more.push(['이관·처리 관리로', `openProcess('${gid}')`, '']);
  }
  if (g.act_tot > 0 && !more.some(m => m[0] === '인폼 보기')
      && !main.some(x => x.includes('인폼'))) more.push(['인폼 보기', `reopenMail('${gid}')`, '']);
  // 결재는 사내 사이트에서 올린다 — 여기서는 '결재 창에 넣을 값'을 그대로 꺼내 준다
  more.push(['태그 편집', `editTags('${gid}')`, '']);
  if (g.status !== '취소') more.push(['정산서 작성 도우미', `openApproval('${gid}')`, '']);
  const open = DTL.has(gid);
  const menu = more.length ? `<details class="rowmenu"><summary class="btn sm" title="더 보기">⋯</summary>
    <div class="rowmenu-pop">${more.map(([label, fn, cls]) =>
      `<button class="rowmenu-item${cls ? ' ' + cls : ''}" onclick="closeMenus();${fn}">${label}</button>`).join('')}
    </div></details>` : '';
  const acts = [...main, menu].filter(Boolean);
  // 잠정만 골라서 한 번에 확정할 수 있게 — 엑셀로 20건 넣고 20번 누르던 것
  const pick = g.status === '계획 등록'
    ? `<input type="checkbox" class="lsel" data-gid="${gid}" ${SEL.has(gid) ? 'checked' : ''}
         aria-label="${esc(gname(g))} 선택" onchange="toggleSel('${gid}',this.checked)">`
    : '';
  return `<tr class="lrow${SEL.has(gid) ? ' picked' : ''}${open ? ' open' : ''}"
      onclick="rowClick(event,'${gid}')" title="누르면 전체 내용과 출장자별 내역이 열립니다">
    <td class="pick">${pick}</td>
    <td>${grouped ? '' : `<span class="status ${stClass(g.roll)}">${esc(dispSt(g.roll))}</span>`}${
      g.plan_type === '긴급' ? '<span class="status urgent">긴급</span>' : ''}${
      ''}</td>
    <td class="trip"><b>${esc(gname(g))}</b><div class="sub">${esc(g.purpose)}</div>${
      (g.tags || []).length ? `<div class="tags">${g.tags.map(x =>
        `<button type="button" class="tag${LQ.tag === x ? ' on' : ''}"
           onclick="event.stopPropagation();setTagFilter('${esc(x).replace(/'/g, "\\'")}')"
           title="이 태그만 보기">#${esc(x)}</button>`).join('')}</div>` : ''}
      <span class="tw" aria-hidden="true">${open ? '▲' : '▼'}</span></td>
    <td>${names(g)} <span class="sub">${g.travelers.length}명</span>${procTag(g)}</td>
    <td class="num">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</td>
    <td class="num">${g.plan_tot ? won(g.plan_tot) : '–'}</td>
    <td class="num"><b>${g.act_tot ? won(g.act_tot) : '–'}</b></td>
    <td>${acts.join(' ') || `<span class="sub">${g.roll === '취소' ? '–' : '진행/처리 단계'}</span>`}</td></tr>
    ${open ? `<tr class="dtl-row"><td colspan="8">
      <div class="dtl-head"><b>${esc(gname(g))}</b> <span class="sub">${esc(g.purpose)}</span>
        <span class="gb"><button class="btn sm" onclick="copyDetail('${g.group_id}')">표 복사</button>
        ${g.act_tot > 0 ? `<button class="btn sm" onclick="reopenMail('${g.group_id}')">인폼 보기</button>` : ''}</span></div>
      <div class="scroll" style="border:0">${detailRows(g)}</div>
      ${g.remark ? `<div class="dtl-rm"><b>비고</b> ${esc(g.remark)}</div>` : ''}
    </td></tr>` : ''}`;
}
/* 내보내기 대상 — 고른 것이 있으면 그것만, 없으면 지금 화면에 걸러진 것만.
   버튼에 건수를 찍어, 무엇이 나갈지 누르기 전에 보이게 한다. */
const EXPORT_MAX = 800;                     // 주소줄 길이 한계 (서버도 같은 값으로 막는다)
function exportTargets(G){
  const pick = G.filter(g => SEL.has(g.group_id));
  const rows = pick.length ? pick : G;
  return { rows, bySel: pick.length > 0 };
}
function syncExport(G, all){
  const xls = $('#lsXls'), csv = $('#lsCsv'), note = $('#lsExpNote');
  if (!xls || !csv) return;
  const { rows, bySel } = exportTargets(G);
  const whole = !bySel && rows.length === all.length;      // 분기 전체면 gids 를 붙이지 않는다
  const ids = rows.map(g => g.group_id);
  const q = `yq=${encodeURIComponent(YQ)}`
    + (whole || !ids.length || ids.length > EXPORT_MAX ? '' : `&gids=${encodeURIComponent(ids.join(','))}`);
  xls.href = `${API}/export.xls?${q}`;
  csv.href = `${API}/export.csv?${q}`;
  // 정적판(아이패드)에는 서버가 없어 주소 대신 이 값을 읽어 파일을 만든다
  const tag = (whole || !ids.length || ids.length > EXPORT_MAX) ? '' : ids.join(',');
  xls.dataset.gids = tag; csv.dataset.gids = tag;
  const pax = rows.reduce((s, g) => s + (g.travelers || []).length, 0);
  const money = rows.reduce((s, g) => s + (g.plan_tot || 0), 0);
  xls.textContent = `센터 제출 양식 (Excel) · ${rows.length}건`;
  if (note) {
    note.textContent = !rows.length ? '내보낼 건이 없습니다.'
      : ids.length > EXPORT_MAX
        ? `${rows.length}건은 한 번에 내보낼 수 있는 ${EXPORT_MAX}건을 넘어 분기 전체가 나갑니다. 조건을 더 좁혀 주세요.`
        : `${bySel ? '고른' : whole ? '이번 분기 전체' : '지금 걸러진'} ${rows.length}건 · 출장자 ${pax}명 · 계획 ${won(money)}원 이 나갑니다.`;
  }
}
function renderListBody(){
  const {all, G} = listRows();
  let body = '', last = null;
  G.forEach(g => {
    if (LQ.group && g.roll !== last) {          // 프로세스가 바뀔 때마다 구분 머리행
      last = g.roll;
      const n = G.filter(x => x.roll === g.roll).length;
      body += `<tr class="grp-head"><td colspan="8">
        <span class="status ${stClass(g.roll)}">${esc(dispSt(g.roll))}</span>
        <b style="margin-left:4px">${n}건</b></td></tr>`;
    }
    body += listRowHtml(g, LQ.group);
  });
  const tb = $('#listBody');
  if (!tb) return;
  // 빈 이유를 구분한다 — 필터 탓과 '이번 분기에 아직 없음'은 다음 행동이 다르다
  const filtered = !!(LQ.q.trim() || Object.values(LQ.col).some(v => String(v || '').trim()));
  const emptyMsg = all.length === 0
    ? `이번 분기(${esc(YQ)})에 등록된 출장이 없습니다.
       <div style="margin-top:8px"><button class="btn sm pri" onclick="nav('plan')">출장 계획 등록 →</button>
       <button class="btn sm" onclick="nav('bulk')">엑셀에서 일괄 등록 →</button></div>`
    : filtered
      ? `검색·필터 조건에 맞는 출장이 없습니다. <b>${all.length}건</b> 중 0건.
         <div style="margin-top:8px"><button class="btn sm" onclick="clearList()">필터 해제 →</button></div>`
      : '표시할 출장이 없습니다.';
  tb.innerHTML = body || `<tr class="empty"><td colspan="8" style="color:var(--mut);text-align:center;padding:24px">${emptyMsg}</td></tr>`;
  const cnt = $('#listCount');
  if (cnt) cnt.textContent = `${G.length}/${all.length}건 · 잠정 ${ST.dash.nPlan || 0} · 확정 ${ST.dash.nConfirm || 0}`;
  drawSelBar(G);
  syncExport(G, all);
  const eff = effSort();
  $$('#v-list .sic').forEach(el => {            // 정렬 표시(▲▼) — 실제로 뒤집히는 열에만
    el.textContent = el.dataset.k === eff ? (LQ.dir === 'asc' ? ' ▲' : ' ▼')
      : (el.dataset.k === 'stage' && LQ.group) ? ' ⋯' : '';
    if (el.dataset.k === 'stage' && LQ.group) el.title = '묶기 중에는 프로세스 순서 고정';
  });
  const dirBtn = $('#listDir');
  if (dirBtn) dirBtn.textContent = dirIcon(LQ.dir);
}
function rList(){
  const opt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label || v || '전체')}</option>`;
  // 머리글: 클릭하면 그 컬럼 기준 정렬 (다시 누르면 오름/내림 전환)
  const ths = LCOLS.map(c =>
    `<th class="sortable${c.num ? ' num' : ''}" onclick="sortList('${c.k}')" title="클릭: ${esc(c.th)} 기준 정렬">`
    + `${esc(c.th)}<span class="sic" data-k="${c.k}"></span></th>`).join('');
  // 컬럼별 검색창 — 상태는 선택, 금액은 '이상', 나머지는 포함 검색
  const filts = LCOLS.map(c => {
    if (c.f === 'sel') return `<th><select class="colf colf-sel" aria-label="상태로 거르기" onchange="setCol('stage',this.value)">`
      + [''].concat(ST.meta.statuses).map(x => opt(x, LQ.col.stage || '', x ? shortSt(x) : '전체')).join('')
      + `</select></th>`;
    return `<th class="${c.num ? 'num' : ''}"><input class="colf" value="${esc(LQ.col[c.k] || '')}"`
      + ` placeholder="${esc(c.ph || '')}" oninput="setCol('${c.k}',this.value)"></th>`;
  }).join('');
  $('#v-list').innerHTML = `
    <div class="note"><b>계획(잠정)</b>은 참고용이라 예산에 잡히지 않습니다.
      실제로 가는 건만 <b>출장 확정</b>을 누르면 계획 금액만큼 예산이 확보됩니다.</div>
    <div class="card">
      <div class="card-head"><h2>${YQ} 출장 내역 <span class="sub" id="listCount" style="font-weight:600"></span></h2>
        <div class="btns" style="margin:0">
          <a class="btn pri" id="lsXls" href="${API}/export.xls?yq=${encodeURIComponent(YQ)}">센터 제출 양식 (Excel)</a>
          <a class="btn" id="lsCsv" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">CSV</a>
        </div></div>
      <p class="cap" id="lsExpNote" style="margin:4px 0 0"></p>
      <div class="filter-row" style="margin-top:12px">
        <input id="listFilter" value="${esc(LQ.q)}" placeholder="전체 검색 (성명·사번·업체·도시·목적)"
          oninput="LQ.q=this.value; renderListBody()">
        <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin:0;white-space:nowrap">
          <input type="checkbox" style="width:auto;margin:0" ${LQ.group ? 'checked' : ''}
            onchange="toggleGroup(this.checked)"> 프로세스별 묶기</label>
        <button class="btn" id="listDir" onclick="toggleLDir()">${dirIcon(LQ.dir)}</button>
        <button class="btn" onclick="clearList()">필터 해제</button>
      </div>
      <p class="cap" style="margin:-4px 0 12px">머리글을 누르면 정렬, 아래 칸에 입력하면 검색됩니다. <b>행을 누르면</b> 잘린 이름까지 전부와 출장자별 내역이 열립니다.</p>
      <div id="listErr"></div>
      <div id="selBar" class="selbar"></div>
      <div class="scroll"><table>
        <thead>
          <tr><th class="pick"><input type="checkbox" id="selAll" aria-label="잠정 계획 전체 선택"
                onchange="selAll(this.checked)" title="보이는 잠정 계획 전체 선택"></th>${ths}<th>관리</th></tr>
          <tr class="filt"><th class="pick"></th>${filts}<th></th></tr>
        </thead>
        <tbody id="listBody"></tbody>
      </table></div>
    </div>`;
  renderListBody();
}

/* ═══ 이관·처리 관리 (관리자) — 출장자 개인별 처리 ═══ */
function pStClass(s){ return s === '처리 완료' ? 'done' : s === '보류' ? 'hold'
  : (s === '소재 이관' || s === '실적 입력·인폼') ? 'wip' : ''; }
/* 사용자 입력(사번)을 JS 문자열로 보간하면 따옴표 탈출로 코드가 실행된다.
   data 속성 + 이벤트 위임으로 값을 '데이터'로만 전달한다. */
function pBtn(gid, emp, status, label, cls){
  return `<button class="btn sm ${cls || ''}" data-act="person" data-gid="${esc(gid)}"`
    + ` data-emp="${esc(emp)}" data-st="${esc(status)}">${label}</button>`;
}
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('button[data-act="person"]');
  if (b) setPersonStatus(b.dataset.gid, b.dataset.emp, b.dataset.st);
});
function rProcess(){
  // 이관·처리 = 실적 이후 단계만. 계획(잠정)·확정 예정은 ‘출장 내역’에서 관리.
  const G = ST.groups.filter(g => g.yq === YQ && !['계획 등록', '확정 예정', '취소'].includes(g.status));
  // 남은 일이 위로 — 처리 완료는 아래, 같은 단계면 오래 묵은 순.
  // 2차 키는 dep_dt 다. updated_at 을 쓰면 개인 처리마다 갱신돼 클릭할 때마다 행이 순간이동한다.
  const waitOf = g => { const t = dLocal((g.inform_at || g.updated_at || g.created_at || '').slice(0, 10));
    return t ? Math.floor((new Date().setHours(0,0,0,0) - t) / 864e5) : -1; };
  G.sort((a, b) => (a.roll === '처리 완료') - (b.roll === '처리 완료')
    || (b.proc?.hold || 0) - (a.proc?.hold || 0)
    || waitOf(b) - waitOf(a)
    || String(a.dep_dt).localeCompare(String(b.dep_dt)));
  const block = g => {
    const past = g.status !== '계획 등록';            // 실적 입력 후 = 개인별 처리 가능
    const pc = g.proc || {done:0, transfer:0, inform:0, hold:0, total:g.travelers.length};
    const src = g.inform_at || g.updated_at || g.created_at;
    const w = past && g.roll !== '처리 완료' && src ? Math.floor((Date.now() - new Date(src)) / 864e5) : null;
    const wtag = w === null ? '' : ` · <b style="color:${w >= 7 ? 'var(--red)' : w >= 3 ? 'var(--amber)' : 'var(--mut)'}">대기 D+${w}</b>`;
    const summary = !past ? '실적 미입력 (먼저 실적을 입력하세요)'
      : `완료 ${pc.done} · 이관 ${pc.transfer} · 인폼 ${pc.inform}${pc.hold ? ` · <b>보류 ${pc.hold}</b>` : ''} / ${pc.total}명${wtag}`;
    // 그룹 전체 버튼 (공통 케이스)
    const gb = [];
    if (past && g.travelers.length > 1 && g.roll !== '처리 완료')
      gb.push(`<button class="btn sm pri" onclick="setStatus('${g.group_id}','처리 완료')">전체 처리 완료</button>`);
    if (past && g.travelers.length > 1 && pc.transfer + pc.done < pc.total)
      gb.push(`<button class="btn sm" onclick="setStatus('${g.group_id}','소재 이관')">전체 소재 이관</button>`);
    if (past && pc.transfer > 0)
      gb.push(`<button class="btn sm" onclick="openTransferMail('${g.group_id}')">이관 인폼</button>`);
    if (['계획 등록', '실적 입력·인폼'].includes(g.roll))
      gb.push(`<button class="btn sm red" onclick="setStatus('${g.group_id}','취소')">출장 취소</button>`);
    // 개인별 행
    const prows = !past ? '' : g.travelers.map(p => {
      const eff = p.status || g.status;
      const a = KEYS.reduce((s, k) => s + (p['a_' + k] || 0), 0);
      const b = [];
      if (['실적 입력·인폼', '보류'].includes(eff)) b.push(pBtn(g.group_id, p.emp_no, '소재 이관', '소재 이관', 'pri'));
      if (['실적 입력·인폼', '소재 이관', '보류'].includes(eff)) b.push(pBtn(g.group_id, p.emp_no, '처리 완료', '처리 완료', 'pri'));
      if (!['보류', '처리 완료'].includes(eff)) b.push(pBtn(g.group_id, p.emp_no, '보류', '보류', 'red'));
      if (['소재 이관', '처리 완료', '보류'].includes(eff)) b.push(pBtn(g.group_id, p.emp_no, '실적 입력·인폼', '되돌리기'));
      return `<tr>
        <td><span class="status ${pStClass(eff)}">${esc(eff)}</span></td>
        <td><b>${esc(p.name)}</b> <span class="sub">${esc(p.ccg_nm)}</span></td>
        <td class="num">${a ? won(a) : '–'}</td>
        <td>${b.join(' ')}</td></tr>`;
    }).join('');
    return `<div class="pgroup" data-gid="${g.group_id}">
      <div class="pg-head">
        <span class="status ${stClass(g.roll)}">${esc(g.roll)}</span>
        <span class="nm">${esc(gname(g))}</span>
        <span class="sub">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} · ${g.travelers.length}명 · 실적 ${g.act_tot ? won(g.act_tot) : '–'}</span>
        <span class="gb">${gb.join(' ')}</span>
      </div>
      <div style="padding:4px 12px"><span class="pg-sum">${summary}</span></div>
      ${past ? `<div class="scroll" style="border:0"><table>
        <thead><tr><th style="width:120px">개인 상태</th><th>출장자</th><th class="num">실적</th><th>처리 (인당)</th></tr></thead>
        <tbody>${prows}</tbody></table></div>
      <details class="fold pdtl"${PDTL.has(g.group_id) ? ' open' : ''}
        ontoggle="this.open?PDTL.add('${g.group_id}'):PDTL.delete('${g.group_id}')">
        <summary>비목별 내역 보기 <span class="sub">교통·숙박·식대·기타 — 정산서 기입용</span></summary>
        <div class="dtl-head" style="margin-top:8px">
          <span class="sub">${esc(g.purpose)}</span>
          <span class="gb"><button class="btn sm" onclick="copyDetail('${g.group_id}')">표 복사</button></span></div>
        <div class="scroll" style="border:0">${detailRows(g)}</div>
        ${g.remark ? `<div class="dtl-rm"><b>비고</b> ${esc(g.remark)}</div>` : ''}
      </details>` : ''}
    </div>`;
  };
  $('#v-process').innerHTML = `
    <div class="note">실적 입력·인폼 → <b>소재 이관</b>(실비 이관 접수) → <b>처리 완료</b>(전표 처리 종료). 처리 완료·처리 중(인폼·이관·<b>보류</b>) 금액만 잔여에서 차감됩니다.
      <br>같은 출장이라도 <b>출장자별로 따로</b> 처리·보류할 수 있어요 — 아래 ‘처리(인당)’ 버튼. 다 같이 처리할 땐 상단 ‘전체’ 버튼을 쓰세요.</div>
    <div class="card"><h2>${YQ} 이관·처리 관리 (출장자 개인별)</h2>
      ${G.map(block).join('') || `<div class="note" style="margin:0">
        이관·처리할 건이 없습니다 — 실적이 입력된 출장만 여기에 옵니다.
        <div style="margin-top:8px"><button class="btn sm" onclick="nav('actual')">출장 실적 입력 →</button>
        <button class="btn sm" onclick="nav('list')">출장 내역에서 확인 →</button></div></div>`}
    </div>`;
}
function shortfallOk(gid){
  // 확정하면 계획액만큼 예산이 잡힌다 — 모자라면 알리기만 하고 진행 여부는 사용자가 결정
  const g = ST.groups.find(x => x.group_id === gid);
  if (!g) return true;
  const after = (ST.dash.avail || 0) - (g.plan_tot || 0);
  if (after >= 0) return true;
  return confirm(
    `확정 후 가용 잔여가 −${won(Math.abs(after))}원입니다.\n` +
    '예산 부족을 인지한 상태로 계속 확정하시겠습니까?\n\n' +
    '[확인] 계속 확정   /   [취소] 돌아가기');
}
async function setStatus(gid, status){
  if (status === '취소' && !confirm('이 출장을 취소할까요?\n\n취소 건은 기록으로 남고 예산에서 빠집니다.\n화면에서 되돌리는 방법은 없습니다 — 되살리려면 데이터 관리 → 백업 복원이 필요합니다.')) return;
  if (status === '확정 예정' && !shortfallOk(gid)) return;
  const {ok, data} = await api(`/groups/${gid}/status`, {method: 'POST', body: JSON.stringify({status})});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(() => setStatus(gid, status)); return; }
    toast((data.errors || ['실패'])[0]); return;
  }
  toast(data.held ? `${dispSt(status)} — 보류 ${data.held}명은 제외(유지)됨` : `상태 변경 — ${dispSt(status)}`);
  await load(); nav(VIEW);
  // 인폼은 화면 안에 그리므로 재렌더가 끝난 뒤에 붙인다 (먼저 붙이면 지워진다)
  if (data.mail) showMail(data.mail);          // 이관 → 비용 처리 요청 인폼
}
async function setPersonStatus(gid, emp, status){
  const {ok, data} = await api(`/groups/${gid}/status`, {method: 'POST', body: JSON.stringify({status, emp_no: emp})});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(() => setPersonStatus(gid, emp, status)); return; }
    toast((data.errors || ['실패'])[0]); return;
  }
  toast(`개인 처리 — ${status}`);
  await load(); nav(VIEW);
  if (data.mail) showMail(data.mail);          // 재렌더 후에 붙인다
}
async function delGroup(gid){
  const g = ST.groups.find(x => x.group_id === gid);
  const label = g ? gname(g) : '출장';
  if (!confirm(`잠정 계획 ‘${label}’을(를) 삭제할까요?\n실제로 가지 않는 계획은 흔적 없이 사라집니다. (되돌릴 수 없음)`)) return;
  const {ok, data} = await api('/groups/' + gid, {method: 'DELETE'});
  if (!ok) { toast((data.errors || ['삭제 실패'])[0]); return; }
  toast('잠정 계획을 삭제했습니다'); await load(); nav(VIEW);
}
async function openTransferMail(gid){
  const {ok, data} = await api(`/groups/${gid}/transfer_mail`);
  if (!ok) { toast((data.errors || ['이관 인폼을 만들 수 없습니다'])[0]); return; }
  showMail(data.mail);
}

/* ═══ 예산 관리 (관리자) ═══ */
function rBudget(){
  // 누적은 항상 일자 오름차순 기준으로 계산하고, 표시 순서만 정렬 옵션을 따른다
  const asc = ST.budget.slice().sort((a, b) => (a.rev_dt || '') < (b.rev_dt || '') ? -1 : 1);
  let run = 0;
  const withRun = asc.map(b => { run += Number(b.amt) || 0; return {...b, run}; });
  const bq = BQ.q.trim().toLowerCase();
  let BR = withRun.filter(b => (!BQ.type || b.rev_type === BQ.type)
    && (!bq || [b.rev_id, b.rev_dt, b.rev_type, b.reason].filter(Boolean).join(' ').toLowerCase().includes(bq)));
  if (BQ.dir === 'desc') BR = BR.slice().reverse();
  const rows = BR.map(b => `<tr>
    <td>${esc(b.rev_id)}</td><td class="num">${esc(b.rev_dt)}</td>
    <td><span class="status">${esc(b.rev_type)}</span></td>
    <td class="num" style="color:${b.amt >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700">${b.amt >= 0 ? '+' : '−'}${won(Math.abs(b.amt))}</td>
    <td class="num"><b>${won(b.run)}</b></td>
    <td>${esc(b.reason || '')}</td>
    <td><button class="btn sm red" onclick="delBudget('${esc(b.rev_id)}')">삭제</button></td></tr>`).join('');
  const bopt = (v, cur, label) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label || v || '전체')}</option>`;
  const bctl = `
      <div class="filter-row" style="margin-top:8px">
        <input value="${esc(BQ.q)}" placeholder="REV·유형·사유·반영일"
          oninput="BQ.q=this.value; clearTimeout(window._bt); window._bt=setTimeout(()=>{rBudget();nav('budget')},250)">
        <select aria-label="리비전 유형으로 거르기" onchange="setBQ('type',this.value)">
          ${[''].concat(ST.meta.revTypes).map(t => bopt(t, BQ.type, t || '전체 유형')).join('')}
        </select>
        <button class="btn" onclick="toggleBDir()">반영일 ${dirIcon(BQ.dir)}</button>
        ${(BQ.q || BQ.type) ? `<button class="btn" onclick="BQ.q='';BQ.type='';rBudget();nav('budget')">필터 해제</button>` : ''}
      </div>`;
  $('#v-budget').innerHTML = `
    <div class="card"><h2>예산 리비전 등록</h2>
      <p class="cap">감액은 금액을 자동으로 음수 처리합니다.</p>
      <div id="bdErr"></div>
      <div class="form-grid c4">
        <div><label>분기</label><input id="bd_yq" value="${YQ}"></div>
        <div><label>유형</label><select id="bd_type">${ST.meta.revTypes.map(t => `<option>${t}</option>`).join('')}</select></div>
        <div><label for="bd_amt">금액 (원)</label><input type="text" inputmode="numeric" class="mny" id="bd_amt" placeholder="0" oninput="moneyFmt(this)"></div>
        <div><label>반영일</label><input type="date" id="bd_dt" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="form-grid"><div><label>사유</label><input id="bd_reason"></div></div>
      <div class="btns"><button class="btn pri" onclick="submitBudget()">리비전 반영</button></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>${YQ} 리비전 이력 <span class="sub" style="font-weight:600">${BR.length}/${withRun.length}건 · 누적 ${won(ST.dash.alloc)}원</span></h2>
        <span class="btns" style="margin:0">
          <a class="btn" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">${YQ} 예산 CSV</a>
          <a class="btn" href="${API}/export_budget.csv">전체 예산 CSV</a>
        </span></div>
      ${bctl}
      <div class="scroll" style="margin-top:8px"><table>
        <thead><tr><th>REV</th><th class="num">반영일</th><th>유형</th><th class="num">증감액</th>
          <th class="num">누적</th><th>사유</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="color:var(--faint);text-align:center;padding:16px">조건에 맞는 리비전이 없습니다.</td></tr>'}</tbody>
      </table></div></div>`;
}
async function submitBudget(){
  const body = {yq: $('#bd_yq').value.trim(), rev_type: $('#bd_type').value,
    amt: mnum($('#bd_amt')), rev_dt: $('#bd_dt').value, reason: $('#bd_reason').value.trim()};
  const {ok, data} = await api('/budget', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(submitBudget); return; }
    showErr('#bdErr', data.errors); return;
  }
  toast(`${data.budget.rev_id} 예산 반영`);
  YQ = body.yq; await load(); nav('budget');
}
async function delBudget(rid){
  if (!confirm(`${rid} 리비전을 삭제할까요?`)) return;
  const {ok, data} = await api('/budget/' + rid, {method: 'DELETE'});
  if (!ok) { toast((data.errors || ['실패'])[0]); return; }
  toast('삭제되었습니다'); await load(); nav('budget');
}

/* ═══ 데이터 관리 ═══ */
/* ═══ 시스템 설정 (관리자) ═══
   CCG·인폼 수신인처럼 조직이 바뀌면 같이 바뀌는 값들. 전에는 코드에 있어서
   바뀔 때마다 배포해야 했다. 이제 원장(data.json)에 있고 여기서 고친다. */
let CFG = null, CFG_USED = {}, CFG_STALE = [];
/* 조직 개편으로 CCG 코드가 통째로 바뀌면, 원장에는 옛 코드가 남고 그 코드는
   '사용 중'이라 목록에서 지울 수도 없다. 옛 코드를 새 팀으로 옮기는 자리. */
function cfgStaleCard(){
  if (!CFG_STALE.length) return '';
  const opts = (CFG.ccg_teams || []).filter(t => t.team && t.ccg)
    .map(t => `<option value="${esc(t.ccg)}">${esc(t.team)} (${esc(t.ccg)})</option>`).join('');
  const rows = CFG_STALE.map((s, i) => `<tr>
    <td><b>${esc(s.name)}</b> <span class="sub">${esc(s.ccg)}</span></td>
    <td class="num">출장자 <b>${n0(s.n)}</b>명</td>
    <td><select id="mig${i}" class="cfg-mig" aria-label="옮길 팀 고르기"><option value="">옮길 팀 선택</option>${opts}</select></td>
    <td><button class="btn sm" onclick="cfgMigrate('${esc(s.ccg)}', ${i})">옮기기</button></td>
  </tr>`).join('');
  return `<div class="card">
    <div class="card-head"><h2>원장 CCG 정리</h2>
      <span class="sub" style="color:var(--red)">${CFG_STALE.length}개 코드가 목록에 없음</span></div>
    <p class="cap">원장에는 있는데 위 <b>CCG팀</b> 목록에는 없는 코드입니다.
      그대로 두면 대시보드에서 <b>기타(미등록 CCG)</b> 로 묶이고, 옛 팀 행도 지울 수 없습니다.</p>
    <div class="scroll"><table class="cfg-tbl">
      <thead><tr><th>원장의 옛 CCG</th><th>대상</th><th>옮길 팀</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <div class="cfg-warn">옮기면 <b>해당 출장자의 CCG 코드와 팀 이름이 새 팀 값으로 바뀝니다.</b>
      금액·날짜·상태는 그대로입니다. 실행 직전 자동 백업이 만들어지고 감사 로그에 남으므로,
      잘못 옮겼으면 <b>데이터 관리 → 백업 복원</b>으로 되돌릴 수 있습니다.</div>
  </div>`;
}
async function cfgMigrate(from, i){
  const sel = $('#mig' + i);
  const to = sel && sel.value;
  if (!to) { toast('옮길 팀을 먼저 고르세요'); return; }
  const nm = sel.options[sel.selectedIndex].text;
  if (!confirm(`원장의 ‘${from}’ 을(를) ${nm} 로 옮길까요?\n\n`
    + '해당 출장자의 CCG 코드·팀 이름이 바뀝니다. 금액·날짜·상태는 그대로입니다.\n'
    + '실행 직전 자동 백업이 만들어집니다.')) return;
  const {ok, data} = await api('/ccg_migrate', {method: 'POST',
    body: JSON.stringify({from, to})});
  if (!ok) { toast((data.errors || ['옮기지 못했습니다'])[0]); return; }
  toast(`출장자 ${n0(data.moved)}명 · 출장 ${n0(data.groups)}건을 옮겼습니다`);
  await load(); await rConfig(); nav('config');
}
async function rConfig(){
  const box = $('#v-config');
  if (!box) return;
  if (!adminPw()) {
    box.innerHTML = `<div class="card"><h2>시스템 설정</h2>
      <p class="cap">예산 담당자만 열 수 있습니다.</p>
      <div class="btns" style="margin-top:0"><button class="btn pri" onclick="askAdmin(()=>{rConfig();nav('config')})">담당자 인증</button></div></div>`;
    return;
  }
  const {ok, data} = await api('/settings');
  if (!ok || !data.settings) {
    box.innerHTML = `<div class="card"><h2>시스템 설정</h2>
      <div class="err">${esc((data.errors || ['설정을 불러오지 못했습니다'])[0])}</div>
      <div class="btns"><button class="btn" onclick="askAdmin(()=>{rConfig();nav('config')})">담당자 인증</button></div></div>`;
    return;
  }
  CFG = data.settings; CFG_USED = data.ccgUsed || {}; CFG_STALE = data.ccgStale || [];
  drawConfig();
}
function drawConfig(){
  const c = CFG;
  const mails = (c.mail_recipients || []).map((m, i) => `
    <div class="cfg-row"><input class="cfg-mail" value="${esc(m)}" placeholder="이름@sk.com">
      <button class="btn sm" onclick="cfgDelMail(${i})">삭제</button></div>`).join('');
  const rows = (c.ccg_teams || []).map((t, i) => {
    const n = CFG_USED[t.ccg] || 0;
    return `<tr>
      <td><input class="cfg-team" value="${esc(t.team)}" placeholder="팀 이름"></td>
      <td><input class="cfg-code" value="${esc(t.ccg)}" placeholder="C0000" style="max-width:120px"></td>
      <td class="cfg-used">${n ? `사용 중 <b>${n}건</b>` : '미사용'}</td>
      <td>${n ? '<span class="sub">삭제 불가</span>'
             : `<button class="btn sm" onclick="cfgDelTeam(${i})">삭제</button>`}</td>
    </tr>`;
  }).join('');
  $('#v-config').innerHTML = `
    <div class="note">여기서 고친 값은 <b>원장(data.json)</b>에 저장됩니다 — 코드를 바꾸거나 다시 배포하지 않아도 됩니다.
      되돌리려면 <b>데이터 관리 → 백업 복원</b>을 쓰세요.</div>
    <div id="cfgErr"></div>

    <div class="card">
      <h2>인폼 수신인</h2>
      <p class="cap">실적을 저장할 때 만들어지는 인폼의 <b>수신</b> 칸에 들어갈 주소입니다.</p>
      <div id="cfgMails">${mails}</div>
      <div class="btns" style="margin-top:8px"><button class="btn sm" onclick="cfgAddMail()">+ 수신인 추가</button></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>CCG팀</h2>
        <span class="sub">${c.ccg_from_settings ? '원장에 저장된 목록을 쓰는 중' : '아직 기본 목록을 쓰는 중 — 저장하면 원장으로 옮겨집니다'}</span></div>
      <p class="cap">계획 등록 화면의 <b>CCG팀 드롭다운</b>과 <b>CCG 코드 자동 채움</b>에 쓰입니다.</p>
      <div class="scroll"><table class="cfg-tbl">
        <thead><tr><th>팀 이름</th><th>CCG 코드</th><th>원장 사용</th><th></th></tr></thead>
        <tbody id="cfgTeams">${rows}</tbody></table></div>
      <div class="btns" style="margin-top:8px"><button class="btn sm" onclick="cfgAddTeam()">+ 팀 추가</button></div>
      <div class="cfg-warn"><b>금액과 소속(CCG 코드)은 바뀌지 않습니다.</b>
        팀 <b>이름</b>만 고치면 과거 건도 새 이름으로 보입니다 — 같은 팀이 화면마다 다른 이름으로
        보이지 않도록, 이름은 <b>코드에서 가져와</b> 표시합니다. 원장에 저장된 코드와 금액은 그대로입니다.<br>
        <b>코드</b>가 바뀌는 개편이라면 아래 <b>원장 CCG 정리</b>에서 옮기세요.
        쓰이는 중인 코드는 그냥 지울 수 없습니다 — 지우면 과거 건의 소속이 미아가 됩니다.</div>
    </div>

    ${cfgStaleCard()}

    <div class="card">
      <h2>그 외</h2>
      <div class="form-grid c2">
        <div><label for="cfgName">시스템 이름</label>
          <input id="cfgName" value="${esc(c.system_name || '')}" maxlength="60"></div>
        <div><label for="cfgUrl">참조 주소 <span class="au">인폼 하단에 표기</span></label>
          <input id="cfgUrl" value="${esc(c.reference_url || '')}" maxlength="200"></div>
        <div><label for="cfgApv">사내 결재 사이트 <span class="au">https:// 로 시작</span></label>
          <input id="cfgApv" value="${esc(c.approval_url || '')}" maxlength="300"
            placeholder="https://approval.skhynix.com/..."></div>
        <div><label for="cfgPw">담당자 비밀번호 <span class="au">공백 없이 4자 이상</span></label>
          <input id="cfgPw" value="${esc(c.admin_pw || '')}"></div>
      </div>
      <div class="cfg-warn">비밀번호를 바꾸면 <b>로그인 화면의 안내 문구에서 번호가 사라집니다</b>
        (기본값일 때만 화면에 그대로 안내합니다). 바꾼 값은 담당자끼리 따로 공유하세요.</div>
    </div>

    <div class="btns">
      <button class="btn pri" id="cfgSave" onclick="cfgSave()">설정 저장</button>
      <button class="btn" onclick="rConfig()">되돌리기(다시 불러오기)</button>
    </div>`;
}
function cfgRead(){
  return {
    mail_recipients: $$('#cfgMails .cfg-mail').map(i => i.value.trim()).filter(Boolean),
    ccg_teams: $$('#cfgTeams tr').map(tr => ({
      team: tr.querySelector('.cfg-team').value.trim(),
      ccg: tr.querySelector('.cfg-code').value.trim(),
    })).filter(t => t.team || t.ccg),
    system_name: $('#cfgName').value.trim(),
    reference_url: $('#cfgUrl').value.trim(),
    approval_url: $('#cfgApv').value.trim(),
    admin_pw: $('#cfgPw').value.trim(),
  };
}
function cfgKeep(){ Object.assign(CFG, cfgRead()); }        // 다시 그릴 때 입력 중이던 값 유지
function cfgAddMail(){ cfgKeep(); CFG.mail_recipients.push(''); drawConfig(); }
function cfgDelMail(i){ cfgKeep(); CFG.mail_recipients.splice(i, 1); drawConfig(); }
function cfgAddTeam(){ cfgKeep(); CFG.ccg_teams.push({team: '', ccg: ''}); drawConfig(); }
function cfgDelTeam(i){ cfgKeep(); CFG.ccg_teams.splice(i, 1); drawConfig(); }
async function cfgSave(){
  const body = cfgRead();
  const btn = $('#cfgSave');
  if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
  const {ok, data} = await api('/settings', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) {
    showErr('#cfgErr', data.errors || ['저장하지 못했습니다']);
    if (btn) { btn.disabled = false; btn.textContent = '설정 저장'; }
    $('#cfgErr').scrollIntoView({block: 'center'});
    return;
  }
  // 비밀번호를 바꿨다면 지금 세션도 새 값으로 — 안 그러면 다음 요청부터 401 로 잠긴다
  if (body.admin_pw && body.admin_pw !== adminPw()) sessionStorage.setItem('tb_pw', body.admin_pw);
  toast((data.changed || []).length ? `설정을 저장했습니다` : '바뀐 내용이 없습니다');
  await load(); await rConfig(); nav('config');
}

async function rData(){
  const {data} = await api('/backups');
  const rows = (data.backups || []).slice(0, 10).map(b => `<tr>
    <td>${esc(b.filename)}</td><td class="num">${(b.size / 1024).toFixed(1)}KB</td>
    <td class="num">${esc(b.modified_at).replace('T', ' ')}</td>
    <td><button class="btn sm" onclick="restoreBackup('${esc(b.filename)}')">복원</button></td></tr>`).join('');
  $('#v-data').innerHTML = `
    <div class="card"><h2>내보내기</h2>
      <div class="btns" style="margin-top:8px">
        <a class="btn pri" href="${API}/export.xls?yq=${encodeURIComponent(YQ)}">${YQ} 센터 제출 (Excel)</a>
        <a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">${YQ} 출장 CSV</a>
        <a class="btn" href="${API}/export.csv">전체 출장 CSV</a>
        <a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}&mode=internal">${YQ} 내부관리 CSV</a>
        <a class="btn" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">${YQ} 예산 CSV</a>
        <a class="btn" href="${API}/export_budget.csv">전체 예산 CSV</a></div></div>
    <div class="card"><h2>자동 백업 (최근 30개 유지)</h2>
      <p class="cap">저장 직전 자동 백업됩니다. 복원은 관리자 인증이 필요합니다.</p>
      <div class="scroll"><table>
        <thead><tr><th>파일</th><th class="num">크기</th><th class="num">시각</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="color:var(--faint);text-align:center;padding:16px">백업이 없습니다.</td></tr>'}</tbody>
      </table></div></div>
    <div class="card"><h2>감사 로그 <span class="sub" style="font-weight:600">최근 활동 — 누가 무엇을 했는지</span></h2>
      <p class="cap">삭제·상태 변경·예산·복원 이력이 남습니다. 잠정 계획 삭제는 내용까지 기록됩니다.</p>
      <div id="auditBox"><button class="btn" onclick="loadAudit()">감사 로그 불러오기</button></div></div>
    <div class="card"><h2>기존 데이터 변환 <span class="sub" style="font-weight:600">사내 Qwen용 프롬프트</span></h2>
      <p class="cap">기존 엑셀·CSV를 이 시스템 형식(data.json)으로 바꿀 때 씁니다.
        아래 프롬프트를 복사해 사내 Qwen에 붙여넣고, 맨 끝 [원본 데이터] 자리에 엑셀 내용을 붙여넣으세요.</p>
      <div class="note">동행자 묶기(같은 출장 = 1건), 상태 판정, 금액 정수화, 열거값 표기까지 규칙이 들어 있습니다.
        <b>서버에 넣기 전</b> 아래 검증 명령으로 <b>검증 실패 0 건</b>을 확인하세요.</div>
      <div class="btns" style="margin-top:0">
        <button class="btn pri" onclick="copyText(QWEN_PROMPT, '변환 프롬프트를 복사했습니다 — Qwen에 붙여넣으세요')">변환 프롬프트 복사</button>
        <button class="btn" onclick="togglePrompt()" id="qwToggle">프롬프트 펼쳐보기</button>
        <button class="btn" onclick="copyText(QWEN_CHECK, '검증 명령을 복사했습니다')">투입 전 검증 명령 복사</button>
      </div>
      <pre id="qwBox" class="promptbox" style="display:none"></pre></div>
    <div class="card"><h2>정본 위치</h2>
      <div class="note">servera/travelbudget/data_json/data.json — 백업: data_json/backup/<br>
      운영 시 <b>TB_DATA_DIR</b> 환경변수로 앱 폴더 밖(예: /var/lib/travelbudget)을 지정하면 배포 시 덮어써도 데이터가 보존됩니다.</div></div>`;
}
const QWEN_CHECK = `python3 -c "
import json,sys; sys.path.insert(0,'.')
from servera.travelbudget import core as C
d=json.load(open('data.json',encoding='utf-8'))
bad=0
for g in d['groups']:
    e=C.validate_group(C.normalize_group(g), require_actual=g.get('status') in C.WIP)
    if e: bad+=1; print(g.get('group_id'), e[:3])
print('검증 실패', bad, '건 /', len(d['groups']), '건')"`;
function togglePrompt(){
  const box = $('#qwBox'), btn = $('#qwToggle');
  const open = box.style.display === 'none';
  if (open && !box.textContent) box.textContent = QWEN_PROMPT;   // 긴 텍스트는 열 때 한 번만
  box.style.display = open ? 'block' : 'none';
  btn.textContent = open ? '접기' : '프롬프트 펼쳐보기';
}
async function loadAudit(){
  const {ok, data} = await api('/audit?n=200');
  if (!ok) { toast('감사 로그를 불러오지 못했습니다'); return; }
  const rows = (data.audit || []).map(a => `<tr>
    <td class="num">${esc(String(a.timestamp || '').replace('T', ' '))}</td>
    <td>${esc(a.actor || '-')}</td><td>${esc(a.action || '')}</td>
    <td>${esc(a.detail || '')}</td></tr>`).join('');
  $('#auditBox').innerHTML = `<div class="scroll"><table>
    <thead><tr><th class="num">시각</th><th>행위자</th><th>동작</th><th>내용</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" style="color:var(--faint);text-align:center;padding:16px">기록이 없습니다.</td></tr>'}</tbody>
  </table></div>`;
}

/* ═══ 센터 제출 리포트 ═══ */
async function showReport(){
  const {ok, data} = await api('/report?yq=' + encodeURIComponent(YQ));
  if (!ok) { toast('리포트를 만들지 못했습니다'); return; }
  const r = data.report;
  const rows = r.byCcg.map(x => `<tr><td>${esc(x.team)} <span class="sub">${esc(x.ccg)}</span></td>
    <td class="num">${won(x.done)}</td><td class="num">${won(x.wip)}</td><td class="num">${won(x.commit)}</td>
    <td class="num"><b>${won(x.total)}</b></td><td class="num">${x.groups}</td><td class="num">${x.people}</td></tr>`).join('');
  const revs = r.revisions.map(b => `<tr><td class="num">${esc(b.rev_dt)}</td><td>${esc(b.rev_type)}</td>
    <td class="num">${b.amt >= 0 ? '+' : '−'}${won(Math.abs(b.amt))}</td><td>${esc(b.reason || '')}</td></tr>`).join('');
  const text = [`[${r.yq} 소재 국내 출장비 집행 현황]`, '',
    `배정 ${won(r.alloc)}원 / 집행 ${won(r.used)}원 (완료 ${won(r.done)} + 처리 중 ${won(r.wip)})`,
    `확정 예정(확보) ${won(r.commit)}원 · 소진율 ${(r.burn * 100).toFixed(1)}%`,
    `가용 잔여 ${won(r.avail)}원` + (r.need > 0 ? ` · 추가 필요 예상 ${won(r.need)}원` : ''), '',
    `출장 ${r.nDone + r.nWip + r.nConfirm}건 (완료 ${r.nDone} · 진행 ${r.nWip} · 확정 ${r.nConfirm}) · 연인원 ${r.nPeople}명`].join('\n');
  document.getElementById('mailCard')?.remove();
  const el = document.createElement('section');
  el.className = 'mailcard'; el.id = 'mailCard';
  el.innerHTML = `<div class="mh"><span>센터 제출 리포트 · ${esc(r.yq)}</span>
      <button onclick="this.closest('.mailcard').remove()">×</button></div>
    <div class="body">
      <div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="kpi"><span>배정</span><b>${won(r.alloc)}</b></div>
        <div class="kpi"><span>집행(완료+처리 중)</span><b>${won(r.used)}</b></div>
        <div class="kpi"><span>확정 예정</span><b>${won(r.commit)}</b></div>
        <div class="kpi"><span>${r.need > 0 ? '추가 필요' : '가용 잔여'}</span><b style="color:${r.need > 0 ? 'var(--red)' : 'var(--navy)'}">${won(r.need > 0 ? r.need : r.avail)}</b></div>
      </div>
      <p class="cap" style="margin:8px 0">소진율 ${(r.burn * 100).toFixed(1)}% · 출장 ${r.nDone + r.nWip + r.nConfirm}건 · 연인원 ${r.nPeople}명</p>
      <table style="width:100%"><thead><tr><th>CCG팀</th><th class="num">완료</th><th class="num">처리 중</th>
        <th class="num">확정 예정</th><th class="num">합계</th><th class="num">건</th><th class="num">인원</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--faint);padding:12px">집행 없음</td></tr>'}</tbody></table>
      <h2 style="font-size:13px;line-height:20px;margin:16px 0 8px;color:var(--navy)">예산 리비전</h2>
      <table style="width:100%"><thead><tr><th class="num">반영일</th><th>유형</th><th class="num">증감</th><th>사유</th></tr></thead>
        <tbody>${revs || '<tr><td colspan="4" style="text-align:center;color:var(--faint);padding:12px">없음</td></tr>'}</tbody></table>
    </div>
    <div class="mf"><button class="btn sm pri" id="rptCopy">요약 복사</button>
      <a class="btn sm" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">상세 CSV</a>
      <a class="btn sm" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">예산 CSV</a></div>`;
  mailHost().appendChild(el);
  el.scrollIntoView({behavior: 'smooth', block: 'nearest'});
  $('#rptCopy').onclick = () => copyText(text, '센터 제출용 요약을 복사했습니다');
}

async function restoreBackup(fn){
  if (!confirm(`${fn}\n이 시점으로 복원할까요? 현재 데이터는 백업 후 교체됩니다.`)) return;
  const {ok, data} = await api(`/backups/${encodeURIComponent(fn)}/restore`, {method: 'POST'});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(() => restoreBackup(fn)); return; }
    toast((data.errors || ['복원 실패'])[0]); return;
  }
  toast('복원되었습니다'); await load();
}

/* ═══ 관리자 인증 ═══ */
function askAdmin(then){
  document.getElementById('adminModal')?.remove();
  const m = document.createElement('div');
  m.className = 'modal'; m.id = 'adminModal';
  m.innerHTML = `<div class="modal-box">
    <div class="mh">예산 담당자 모드</div>
    <div class="mb">
      <div class="merr" id="admErr">비밀번호가 올바르지 않습니다.</div>
      <label for="admPw">비밀번호</label><input id="admPw" type="password" autocomplete="off">
      <div class="hint">${(ST.settings && ST.settings.pw_default === false)
        ? '담당자가 비밀번호를 변경했습니다 — 소재 출장 예산 담당자에게 문의하세요.'
        : '소재 출장 예산 담당자용 공개 비밀번호 — <b>2071478</b>'}<br>
        이관·처리 완료·예산 리비전·백업 복원에 필요합니다.</div>
      <div class="btns" style="margin-top:0">
        <button class="btn pri" id="admOk">확인</button>
        <button class="btn" onclick="document.getElementById('adminModal').remove()">취소</button>
      </div></div></div>`;
  document.body.appendChild(m);
  setTimeout(() => $('#admPw')?.focus(), 50);   // 모달이 이미 닫혔으면 무시
  const go = async () => {
    const {ok} = await api('/admin/verify', {method: 'POST', body: JSON.stringify({pw: $('#admPw').value})});
    if (!ok) { $('#admErr').style.display = 'block'; return; }
    sessionStorage.setItem('tb_pw', $('#admPw').value);
    m.remove(); if (then) then();
  };
  $('#admOk').onclick = go;
  $('#admPw').onkeydown = e => { if (e.key === 'Enter') go(); };
}

load().catch(e => {
  // 셸(사이드바·연락처)은 남긴다 — 화면이 안 뜨는 상황일수록 연락처가 필요하다
  const box = $('#v-dash') || document.querySelector('main') || document.body;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
  box.classList.add('on');
  box.innerHTML = `
    <div class="card">
      <h2 style="color:var(--red)">데이터를 읽지 못했습니다</h2>
      <p class="cap">화면 코드가 아니라 원장 파일이나 서버 쪽 문제입니다. 아래를 순서대로 확인하세요.</p>
      <div class="err">${esc(e.message || String(e))}</div>
      <ol style="margin:12px 0 0 16px;padding:0;color:var(--ink2);font-size:13px;line-height:20px">
        <li><b>Ctrl+F5</b> 로 다시 불러오기 — 캐시 문제면 여기서 해결됩니다.</li>
        <li>서버가 떠 있는지 확인 — 주소창의 <code>/travelbudget</code> 를 다시 여세요.</li>
        <li>그래도 안 되면 <b>data.json 이 깨진 것</b>입니다.
            <code>$TB_DATA_DIR/backup/</code> 의 최신 백업으로 되돌리고 재기동하세요.
            (자동 백업 30개가 항상 남아 있습니다)</li>
      </ol>
      <div class="ref" style="margin-top:16px">문의 — 소재전략 이정훈 TL ·
        <b>junghoon12.lee@sk.com</b> · 010-3376-7923</div>
    </div>`;
  const t = $('#pageTitle'); if (t) t.textContent = '오류';
  const sb = $('#pageSub'); if (sb) sb.textContent = '데이터 로드 실패';
});
