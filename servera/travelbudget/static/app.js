/* 국내 출장비 관리 — 프런트 (서버 SSOT 렌더) */
'use strict';
const API = '/travelbudget/api';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const won = n => (Math.round(Number(n) || 0)).toLocaleString('ko-KR');
const fmtD = d => d ? d.slice(5).replace('-', '/') : '';
const KEYS = ['trans', 'lodg', 'meal', 'etc'];

const TITLES = {dash:'대시보드', plan:'출장 계획 등록', actual:'출장 실적 입력',
  list:'출장 내역', process:'이관·처리 관리', budget:'예산 관리', data:'데이터 관리'};
const SUBS = {dash:'잔여 = 총예산 − 처리완료 − 처리중', plan:'동행 출장은 출장자 행을 추가해 한 번에 등록',
  actual:'실적 저장 시 실비 이관 인폼이 자동 생성됩니다', list:'분기 전체 출장 이력',
  process:'실적 입력·인폼 → 소재 이관 → 처리 완료', budget:'예산 리비전 등록·이력 (감액은 자동 음수 처리)',
  data:'CSV 내보내기 · 자동 백업(30개) · 복원'};

let ST = null, YQ = null;

function adminPw(){ return sessionStorage.getItem('tb_pw') || ''; }
async function api(path, opt = {}){
  opt.headers = Object.assign({'Content-Type':'application/json'}, opt.headers || {});
  if (adminPw()) opt.headers['X-Admin-PW'] = adminPw();
  const r = await fetch(API + path, opt);
  const b = await r.json().catch(() => ({}));
  return {ok: r.ok, status: r.status, data: b};
}
function toast(m){ const t = document.createElement('div'); t.className = 'toast';
  t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 2200); }
function showErr(sel, errs){ $(sel).innerHTML =
  `<div class="err">${(errs || ['요청 실패']).map(esc).join('\n')}</div>`; }
function stClass(s){ return s === '처리 완료' ? 'done' : s === '취소' ? 'cancel'
  : (s === '실적 입력·인폼' || s === '소재 이관') ? 'wip' : ''; }
function badge(g){
  const urgent = g.plan_type === '긴급' ? ' <span class="status urgent">긴급</span>' : '';
  return `<span class="status ${stClass(g.status)}">${esc(g.status)}</span>${urgent}`;
}
function gname(g){ return [g.city, g.org].filter(Boolean).join(' '); }
function names(g){ return (g.travelers || []).map(p => esc(p.name)).join(', '); }

async function load(){
  const {data} = await api('/state' + (YQ ? '?yq=' + encodeURIComponent(YQ) : ''));
  ST = data; YQ = data.yq;
  const qs = $('#qsel');
  const opts = [...new Set([...data.yqList, YQ])];
  qs.innerHTML = opts.map(q => `<option${q === YQ ? ' selected' : ''}>${q}</option>`).join('');
  qs.onchange = e => { YQ = e.target.value; load(); };
  renderAll();
}
function nav(v){
  $$('.nav a').forEach(a => a.classList.toggle('on', a.dataset.view === v));
  $$('.view').forEach(x => x.classList.remove('on'));
  $('#v-' + v).classList.add('on');
  $('#pageTitle').textContent = TITLES[v];
  $('#pageSub').textContent = SUBS[v];
}
$$('.nav a').forEach(a => a.onclick = () => {
  const v = a.dataset.view;
  if ((v === 'process' || v === 'budget') && !adminPw()) { askAdmin(() => nav(v)); return; }
  nav(v);
});
function renderAll(){ rDash(); rPlan(); rActual(); rList(); rProcess(); rBudget(); rData(); }

/* ═══ 대시보드 ═══ */
function rDash(){
  const d = ST.dash;
  const hero = `
    <div class="hero ${d.short ? 'alert' : ''}">
      <span class="lamp"></span>
      <div style="flex:1">
        <div class="msg">${d.short
          ? '소재 그룹 국내 출장비 예산이 부족합니다 — 센터 검토 및 추가 지원 필요'
          : '소재 그룹 국내 출장비 잔액이 있어 정상 운영 중입니다'}</div>
        <div class="fig">총예산 <b>${won(d.alloc)}원</b> − 처리완료 <b>${won(d.done)}원</b> − 처리중 <b>${won(d.wip)}원</b> = 잔여 <b style="color:${d.remain < 0 ? 'var(--red)' : 'var(--navy)'}">${d.remain < 0 ? '−' : ''}${won(Math.abs(d.remain))}원</b></div>
      </div>
      <div style="text-align:right">
        <div class="label">현재 잔여 출장비</div>
        <div class="amount">${d.remain < 0 ? '−' : ''}${won(Math.abs(d.remain))}원</div>
      </div>
    </div>`;
  const kpi = `
    <div class="kpis">
      <div class="kpi"><span>총 예산</span><b>${won(d.alloc)}</b><small>리비전 ${ST.budget.length}회</small></div>
      <div class="kpi"><span>처리 완료</span><b>${won(d.done)}</b><small>${d.nDone}건 · 이관 완료</small></div>
      <div class="kpi"><span>처리중 (인폼·이관)</span><b>${won(d.wip)}</b><small>${d.nWip}건 진행</small></div>
      <div class="kpi"><span>미실시 계획 <span class="au">참고</span></span><b>${won(d.planAmt)}</b><small>${d.nPlan}건 · 잔여 미차감</small></div>
    </div>`;
  const aw = d.todo.actual_wait.length, pw = d.todo.process_wait.length;
  const todo = (aw || pw) ? `
    <div class="card"><h2>바로 할 일</h2><p class="cap">대시보드에서 바로 이동해 처리하세요.</p>
      <div class="btns" style="margin-top:0">
        ${aw ? `<button class="btn pri" onclick="nav('actual')">실적 입력 대기 ${aw}건 → 실적 입력</button>` : ''}
        ${pw ? `<button class="btn" onclick="goProcess()">이관·처리 대기 ${pw}건 → 처리 관리</button>` : ''}
      </div></div>` : '';
  const rows = d.byCcg.map(r => `<tr>
    <td><b>${esc(r.team)}</b> <span class="sub">${r.ccg}</span></td>
    <td class="num">${won(r.done)}</td><td class="num">${won(r.wip)}</td>
    <td class="num"><b>${won(r.total)}</b></td>
    <td class="num">${(r.share * 100).toFixed(1)}%</td>
    <td class="num">${won(r.plan)}</td>
    <td class="num">${r.groups}</td><td class="num">${r.people}</td></tr>`).join('')
    || '<tr><td colspan="8" style="color:var(--faint);text-align:center;padding:18px">집행 내역이 없습니다.</td></tr>';
  const tot = d.byCcg.reduce((a, r) => (KEYS.forEach(() => 0),
    {done:a.done + r.done, wip:a.wip + r.wip, total:a.total + r.total, plan:a.plan + r.plan,
     groups:a.groups + r.groups, people:a.people + r.people}), {done:0, wip:0, total:0, plan:0, groups:0, people:0});
  const ccg = `
    <div class="card"><div class="card-head"><h2>CCG팀(부서)별 집행 현황</h2>
      <span class="cap" style="margin:0">처리완료 + 처리중 = 총사용액 기준</span></div>
    <div class="scroll" style="margin-top:12px"><table>
      <thead><tr><th>CCG팀</th><th class="num">처리완료</th><th class="num">처리중</th>
        <th class="num">총사용액</th><th class="num">구성비</th><th class="num">미실시 계획</th>
        <th class="num">출장 그룹</th><th class="num">참여 인원</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>합계</td><td class="num">${won(tot.done)}</td><td class="num">${won(tot.wip)}</td>
        <td class="num">${won(tot.total)}</td><td class="num">100%</td><td class="num">${won(tot.plan)}</td>
        <td class="num">${tot.groups}</td><td class="num">${tot.people}</td></tr></tfoot>
    </table></div></div>`;
  $('#v-dash').innerHTML = hero + kpi + todo + ccg;
}
function goProcess(){ if (!adminPw()) { askAdmin(() => nav('process')); return; } nav('process'); }

/* ═══ 출장 계획 등록 ═══ */
let TRAV_N = 0;
function travRow(p = {}){
  TRAV_N++;
  const teams = ST.ccg.map(t => `<option${t.team === p.ccg_nm ? ' selected' : ''}>${esc(t.team)}</option>`).join('');
  const ranks = ST.meta.ranks.map(r => `<option${r === (p.rank || 'TL') ? ' selected' : ''}>${r}</option>`).join('');
  return `<tr data-tid="${TRAV_N}">
    <td><input class="w-nm t-nm" value="${esc(p.name || '')}" placeholder="성명"></td>
    <td><input class="w-no t-no" value="${esc(p.emp_no || '')}" placeholder="사번"></td>
    <td><select class="w-rk t-rk">${ranks}</select></td>
    <td><select class="w-tm t-tm" onchange="syncCcg(this)"><option value="">선택</option>${teams}</select></td>
    <td><input class="w-cc t-cc auto" value="${esc(p.ccg || '')}" readonly placeholder="자동"></td>
    ${KEYS.map(k => `<td><input type="number" class="w-mn t-p-${k}" step="1000" value="${p['p_' + k] || ''}" placeholder="0" oninput="planSum()"></td>`).join('')}
    <td class="num t-sum" style="font-weight:700">0</td>
    <td><button class="btn sm" onclick="this.closest('tr').remove(); planSum()">삭제</button></td>
  </tr>`;
}
function syncCcg(sel){
  const t = ST.ccg.find(x => x.team === sel.value);
  sel.closest('tr').querySelector('.t-cc').value = t ? t.ccg : '';
}
function planSum(){
  let tot = 0;
  $$('#travBody tr').forEach(tr => {
    let s = 0;
    KEYS.forEach(k => s += Number(tr.querySelector('.t-p-' + k).value) || 0);
    tr.querySelector('.t-sum').textContent = won(s);
    tot += s;
  });
  const el = $('#planTot'); if (el) el.textContent = won(tot) + '원';
  const d1 = $('#pl_dep')?.value, d2 = $('#pl_ret')?.value;
  const dy = $('#pl_days');
  if (dy) dy.value = (d1 && d2) ? Math.max(0, (new Date(d2) - new Date(d1)) / 864e5 + 1) : '';
}
function rPlan(){
  const m = ST.meta;
  const copyOpts = ST.groups.filter(g => g.status !== '취소').slice(0, 30)
    .map(g => `<option value="${g.group_id}">${esc(gname(g))} · ${names(g)} · ${fmtD(g.dep_dt)}</option>`).join('');
  $('#v-plan').innerHTML = `
    <div class="card">
      <div class="card-head"><h2>출장 계획 등록</h2>
        <select id="copySel" style="width:auto;min-width:250px" onchange="copyPlan(this.value)">
          <option value="">이전 출장 복사…</option>${copyOpts}</select></div>
      <p class="cap">공통 정보는 한 번만 입력하고, 동행자는 출장자 행으로 추가합니다. 긴급 출장은 계획비 없이 등록할 수 있습니다.</p>
      <div id="planErr"></div>
      <div class="form-grid c4">
        <div><label>구분<span class="rq">*</span></label>
          <select id="pl_type">${m.planTypes.map(t => `<option>${t}</option>`).join('')}</select></div>
        <div><label>출장 도시<span class="rq">*</span></label><input id="pl_city" placeholder="예: 청주"></div>
        <div><label>출장 기관&업체<span class="rq">*</span></label><input id="pl_org" placeholder="예: 원익머트리얼즈"></div>
        <div><label>출장 구분<span class="rq">*</span></label>
          <select id="pl_kind">${m.kinds.map(k => `<option>${k}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid c4">
        <div><label>출발일자<span class="rq">*</span></label><input type="date" id="pl_dep" onchange="planSum()"></div>
        <div><label>복귀일자<span class="rq">*</span></label><input type="date" id="pl_ret" onchange="planSum()"></div>
        <div><label>출장일수 <span class="au">자동</span></label><input id="pl_days" class="auto" readonly></div>
        <div><label>자차사용 여부</label>
          <select id="pl_car">${m.cars.map(c => `<option>${c}</option>`).join('')}</select></div>
      </div>
      <div class="form-grid">
        <div><label>출장 목적&사유<span class="rq">*</span> <span class="au">소재명 포함</span></label>
          <textarea id="pl_purpose" placeholder="예: NF3 순도 관리 정기 Audit"></textarea></div>
      </div>
      <label style="margin-top:4px">출장자 <span class="au">동행자는 행 추가</span></label>
      <div class="scroll trav-table"><table>
        <thead><tr><th>성명</th><th>사번</th><th>직책</th><th>CCG팀</th><th>CCG No.</th>
          ${m.cost.map(c => `<th class="num">계획 ${c.label}</th>`).join('')}<th class="num">합계</th><th></th></tr></thead>
        <tbody id="travBody"></tbody>
      </table></div>
      <div class="btns" style="margin-top:10px">
        <button class="btn" onclick="addTrav()">+ 동행자 추가</button>
        <span style="margin-left:auto;font-weight:700;color:var(--navy)">계획 총합계 <span id="planTot">0원</span></span>
      </div>
      <div class="form-grid" style="margin-top:12px">
        <div><label>비고</label><input id="pl_remark"></div>
      </div>
      <div class="btns"><button class="btn pri" onclick="submitPlan()">출장 계획 등록</button></div>
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
  $('#pl_dep').value = ''; $('#pl_ret').value = '';
  $('#travBody').innerHTML = '';
  (g.travelers || []).forEach(p => addTrav(p));
  planSum();
  toast('이전 출장을 복사했습니다 — 일자·금액을 확인하세요');
}
function collectTravelers(withActual){
  return $$('#travBody tr').map(tr => {
    const p = {name: tr.querySelector('.t-nm').value.trim(),
      emp_no: tr.querySelector('.t-no').value.trim(),
      rank: tr.querySelector('.t-rk').value,
      ccg_nm: tr.querySelector('.t-tm').value,
      ccg: tr.querySelector('.t-cc').value};
    KEYS.forEach(k => p['p_' + k] = Number(tr.querySelector('.t-p-' + k).value) || 0);
    return p;
  });
}
async function submitPlan(){
  const body = {plan_type: $('#pl_type').value, city: $('#pl_city').value.trim(),
    org: $('#pl_org').value.trim(), kind: $('#pl_kind').value,
    dep_dt: $('#pl_dep').value, ret_dt: $('#pl_ret').value, car: $('#pl_car').value,
    purpose: $('#pl_purpose').value.trim(), remark: $('#pl_remark').value.trim(),
    travelers: collectTravelers(false)};
  const {ok, data} = await api('/groups', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) { showErr('#planErr', data.errors); return; }
  toast(`등록 완료 — ${body.travelers.length}명`);
  YQ = data.group.yq;
  await load(); nav('plan');
}

/* ═══ 출장 실적 입력 ═══ */
let ACT_GID = null;
function rActual(){
  const targets = ST.groups.filter(g => ['계획 등록', '실적 입력·인폼'].includes(g.status));
  const opts = targets.map(g =>
    `<option value="${g.group_id}">${esc(gname(g))} · ${names(g)} · ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} · ${g.status}${g.plan_type === '긴급' ? ' [긴급]' : ''}</option>`).join('');
  $('#v-actual').innerHTML = `
    <div class="card">
      <h2>출장 실적 입력</h2>
      <p class="cap">대상 출장을 선택해 출장자별 실적을 입력하면, 저장과 동시에 그룹당 1통의 실비 이관 인폼이 생성됩니다.</p>
      <div id="actErr"></div>
      <div class="filter-row">
        <input id="actFilter" placeholder="성명·업체·도시로 검색" oninput="filterActual()">
        <select id="actSel" onchange="pickActual(this.value)" style="flex:1;min-width:300px">
          <option value="">대상 출장 선택 (${targets.length}건)</option>${opts}</select>
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
      ${KEYS.map(k => `<td><input type="number" class="a-${k}" step="1000" value="${p['a_' + k] || ''}" placeholder="계획 ${won(p['p_' + k])}" oninput="actSum()"></td>`).join('')}
      <td class="num a-sum" style="font-weight:700">0</td>
      <td class="num a-var">–</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <div class="note"><b>${esc(gname(g))}</b> · ${esc(g.purpose)} · ${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} (${g.days}일) · ${g.travelers.length}명 · 계획 합계 ${won(g.plan_tot)}원</div>
    <div class="scroll trav-table"><table>
      <thead><tr><th>출장자</th><th>CCG팀</th>
        ${m.cost.map(c => `<th class="num">실적 ${c.label}</th>`).join('')}
        <th class="num">실적 합계</th><th class="num">계획 대비</th></tr></thead>
      <tbody id="actRows">${rows}</tbody>
      <tfoot><tr><td colspan="2">그룹 합계</td>
        ${KEYS.map(k => `<td class="num" id="af-${k}">0</td>`).join('')}
        <td class="num" id="afTot">0</td><td class="num" id="afVar">–</td></tr></tfoot>
    </table></div>
    <div class="form-grid" style="margin-top:12px">
      <div><label>비고 <span class="au">긴급 출장은 필수</span></label><input id="ac_remark" value="${esc(g.remark || '')}"></div>
    </div>
    <div class="btns"><button class="btn pri" onclick="submitActual()">실적 저장 및 인폼 생성 (${g.travelers.length}명)</button></div>`;
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
    KEYS.forEach(k => { const v = Number(tr.querySelector('.a-' + k).value) || 0;
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
async function submitActual(){
  const travelers = $$('#actRows tr').map(tr => {
    const p = {emp_no: tr.dataset.emp};
    KEYS.forEach(k => p['a_' + k] = Number(tr.querySelector('.a-' + k).value) || 0);
    return p;
  });
  const {ok, data} = await api(`/groups/${ACT_GID}/actual`,
    {method: 'POST', body: JSON.stringify({travelers, remark: $('#ac_remark').value.trim()})});
  if (!ok) { showErr('#actErr', data.errors); return; }
  showMail(data.mail);
  toast('실적 저장 — 상태: 실적 입력·인폼');
  await load(); nav('actual');
}

/* ═══ 인폼 카드 ═══ */
function showMail(mail){
  document.getElementById('mailCard')?.remove();
  const el = document.createElement('div');
  el.className = 'mailcard'; el.id = 'mailCard';
  el.innerHTML = `
    <div class="mh"><span>실비 이관 요청 인폼 (그룹당 1통)</span>
      <button onclick="this.closest('.mailcard').remove()">×</button></div>
    <div class="meta">
      <div class="row"><span class="k">수신</span><span style="word-break:break-all">${esc(mail.to)}</span></div>
      <div class="row"><span class="k">제목</span><span>${esc(mail.subject)}</span></div>
    </div>
    <div class="body">${mail.body_html}</div>
    <div class="mf">
      <button class="btn sm pri" id="mailOpen">메일 열기 (Outlook)</button>
      <button class="btn sm" id="mailCopyHtml">표 포함 복사</button>
      <button class="btn sm" id="mailCopyText">본문 텍스트 복사</button>
    </div>`;
  document.body.appendChild(el);
  $('#mailOpen').onclick = () => {
    location.href = `mailto:${encodeURIComponent(mail.to)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body_text)}`;
  };
  $('#mailCopyHtml').onclick = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([mail.body_html], {type: 'text/html'}),
        'text/plain': new Blob([mail.body_text], {type: 'text/plain'})})]);
      toast('표 포함 복사됨 — Outlook에 붙여넣으세요');
    } catch (e) { await navigator.clipboard.writeText(mail.body_text); toast('텍스트로 복사되었습니다'); }
  };
  $('#mailCopyText').onclick = async () => {
    await navigator.clipboard.writeText(mail.body_text); toast('본문을 복사했습니다');
  };
}

/* ═══ 출장 내역 ═══ */
function rList(){
  const G = ST.groups.filter(g => g.yq === YQ);
  const row = g => `<tr>
    <td>${badge(g)}</td>
    <td><b>${esc(gname(g))}</b><div class="sub">${esc(g.purpose)}</div></td>
    <td>${names(g)} <span class="sub">${g.travelers.length}명</span></td>
    <td class="num">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</td>
    <td class="num">${g.plan_tot ? won(g.plan_tot) : '–'}</td>
    <td class="num"><b>${g.act_tot ? won(g.act_tot) : '–'}</b></td></tr>`;
  $('#v-list').innerHTML = `
    <div class="card">
      <div class="card-head"><h2>${YQ} 출장 내역 (${G.length}건)</h2>
        <a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">CSV 다운로드</a></div>
      <div class="filter-row" style="margin-top:12px">
        <input id="listFilter" placeholder="성명·업체·도시·목적으로 검색" oninput="filterList()"></div>
      <div class="scroll"><table>
        <thead><tr><th>상태</th><th>출장</th><th>출장자</th><th class="num">기간</th>
          <th class="num">계획</th><th class="num">실적</th></tr></thead>
        <tbody id="listBody">${G.map(row).join('') || '<tr><td colspan="6" style="color:var(--faint);text-align:center;padding:18px">해당 분기 출장이 없습니다.</td></tr>'}</tbody>
      </table></div>
    </div>`;
}
function filterList(){
  const q = $('#listFilter').value.trim();
  $$('#listBody tr').forEach(tr => tr.hidden = q && !tr.textContent.includes(q));
}

/* ═══ 이관·처리 관리 (관리자) ═══ */
function rProcess(){
  const G = ST.groups.filter(g => g.yq === YQ && g.status !== '취소');
  const row = g => {
    const acts = [];
    if (g.status === '실적 입력·인폼')
      acts.push(`<button class="btn sm pri" onclick="setStatus('${g.group_id}','소재 이관')">소재 이관</button>`);
    if (g.status === '소재 이관')
      acts.push(`<button class="btn sm pri" onclick="setStatus('${g.group_id}','처리 완료')">처리 완료</button>`);
    if (g.status === '처리 완료')
      acts.push(`<button class="btn sm" onclick="setStatus('${g.group_id}','소재 이관')">완료 해제</button>`);
    if (['계획 등록', '실적 입력·인폼'].includes(g.status))
      acts.push(`<button class="btn sm red" onclick="setStatus('${g.group_id}','취소')">취소</button>`);
    return `<tr>
      <td>${badge(g)}</td>
      <td><b>${esc(gname(g))}</b><div class="sub">${names(g)} · ${g.travelers.length}명</div></td>
      <td class="num">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</td>
      <td class="num">${g.act_tot ? won(g.act_tot) : '–'}</td>
      <td>${acts.join(' ') || '–'}</td></tr>`;
  };
  $('#v-process').innerHTML = `
    <div class="note">실적 입력·인폼 → <b>소재 이관</b>(실비 이관 접수) → <b>처리 완료</b>(전표 처리 종료). 처리 완료·처리중 금액만 잔여 예산에서 차감됩니다.</div>
    <div class="card"><h2>${YQ} 이관·처리 관리</h2>
      <div class="scroll" style="margin-top:10px"><table>
        <thead><tr><th>상태</th><th>출장</th><th class="num">기간</th><th class="num">실적</th><th>처리</th></tr></thead>
        <tbody>${G.map(row).join('') || '<tr><td colspan="5" style="color:var(--faint);text-align:center;padding:18px">대상이 없습니다.</td></tr>'}</tbody>
      </table></div></div>`;
}
async function setStatus(gid, status){
  const {ok, data} = await api(`/groups/${gid}/status`, {method: 'POST', body: JSON.stringify({status})});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(() => setStatus(gid, status)); return; }
    toast((data.errors || ['실패'])[0]); return;
  }
  toast(`상태 변경 — ${status}`);
  await load(); nav('process');
}

/* ═══ 예산 관리 (관리자) ═══ */
function rBudget(){
  let run = 0;
  const rows = ST.budget.map(b => { run += Number(b.amt) || 0; return `<tr>
    <td>${esc(b.rev_id)}</td><td class="num">${esc(b.rev_dt)}</td>
    <td><span class="status">${esc(b.rev_type)}</span></td>
    <td class="num" style="color:${b.amt >= 0 ? 'var(--green)' : 'var(--red)'};font-weight:700">${b.amt >= 0 ? '+' : '−'}${won(Math.abs(b.amt))}</td>
    <td class="num"><b>${won(run)}</b></td>
    <td>${esc(b.reason || '')}</td>
    <td><button class="btn sm red" onclick="delBudget('${esc(b.rev_id)}')">삭제</button></td></tr>`; }).join('');
  $('#v-budget').innerHTML = `
    <div class="card"><h2>예산 리비전 등록</h2>
      <p class="cap">감액은 금액을 자동으로 음수 처리합니다.</p>
      <div id="bdErr"></div>
      <div class="form-grid c4">
        <div><label>분기</label><input id="bd_yq" value="${YQ}"></div>
        <div><label>유형</label><select id="bd_type">${ST.meta.revTypes.map(t => `<option>${t}</option>`).join('')}</select></div>
        <div><label>금액 (원)</label><input type="number" id="bd_amt" step="100000"></div>
        <div><label>반영일</label><input type="date" id="bd_dt" value="${new Date().toISOString().slice(0, 10)}"></div>
      </div>
      <div class="form-grid"><div><label>사유</label><input id="bd_reason"></div></div>
      <div class="btns"><button class="btn pri" onclick="submitBudget()">리비전 반영</button></div>
    </div>
    <div class="card"><h2>${YQ} 리비전 이력 · 누적 ${won(ST.dash.alloc)}원</h2>
      <div class="scroll" style="margin-top:10px"><table>
        <thead><tr><th>REV</th><th class="num">반영일</th><th>유형</th><th class="num">증감액</th>
          <th class="num">누적</th><th>사유</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="color:var(--faint);text-align:center;padding:18px">등록된 예산이 없습니다.</td></tr>'}</tbody>
      </table></div></div>`;
}
async function submitBudget(){
  const body = {yq: $('#bd_yq').value.trim(), rev_type: $('#bd_type').value,
    amt: Number($('#bd_amt').value) || 0, rev_dt: $('#bd_dt').value, reason: $('#bd_reason').value.trim()};
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
async function rData(){
  const {data} = await api('/backups');
  const rows = (data.backups || []).slice(0, 10).map(b => `<tr>
    <td>${esc(b.filename)}</td><td class="num">${(b.size / 1024).toFixed(1)}KB</td>
    <td class="num">${esc(b.modified_at).replace('T', ' ')}</td>
    <td><button class="btn sm" onclick="restoreBackup('${esc(b.filename)}')">복원</button></td></tr>`).join('');
  $('#v-data').innerHTML = `
    <div class="card"><h2>내보내기</h2>
      <div class="btns" style="margin-top:6px">
        <a class="btn pri" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">${YQ} CSV</a>
        <a class="btn" href="${API}/export.csv">전체 CSV</a></div></div>
    <div class="card"><h2>자동 백업 (최근 30개 유지)</h2>
      <p class="cap">저장 직전 자동 백업됩니다. 복원은 관리자 인증이 필요합니다.</p>
      <div class="scroll"><table>
        <thead><tr><th>파일</th><th class="num">크기</th><th class="num">시각</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="color:var(--faint);text-align:center;padding:18px">백업이 없습니다.</td></tr>'}</tbody>
      </table></div></div>
    <div class="card"><h2>정본 위치</h2>
      <div class="note">servera/travelbudget/data_json/data.json — 백업: data_json/backup/</div></div>`;
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
    <div class="mh">관리자 인증</div>
    <div class="mb">
      <div class="merr" id="admErr">아이디 또는 비밀번호가 올바르지 않습니다.</div>
      <label>아이디</label><input id="admId" autocomplete="off" style="margin-bottom:10px">
      <label>비밀번호</label><input id="admPw" type="password" autocomplete="off">
      <div class="hint">공개 계정 — ID <b>2071478</b> / PW <b>2071478</b></div>
      <div class="btns" style="margin-top:0">
        <button class="btn pri" id="admOk">확인</button>
        <button class="btn" onclick="document.getElementById('adminModal').remove()">취소</button>
      </div></div></div>`;
  document.body.appendChild(m);
  setTimeout(() => $('#admId').focus(), 50);
  const go = async () => {
    const {ok} = await api('/admin/verify', {method: 'POST', body: JSON.stringify({pw: $('#admPw').value})});
    if (!ok) { $('#admErr').style.display = 'block'; return; }
    sessionStorage.setItem('tb_pw', $('#admPw').value);
    m.remove(); if (then) then();
  };
  $('#admOk').onclick = go;
  $('#admPw').onkeydown = e => { if (e.key === 'Enter') go(); };
}

load().catch(e => { document.body.innerHTML =
  `<pre style="padding:24px;color:#B42318">${esc(e.message)}</pre>`; });
