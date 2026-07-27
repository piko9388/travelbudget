/* 국내 출장비 관리 — 프런트 (서버 SSOT 렌더) */
'use strict';
const API = '/travelbudget/api';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const won = n => (Math.round(Number(n) || 0)).toLocaleString('ko-KR');
const fmtD = d => d ? d.slice(5).replace('-', '/') : '';
const KEYS = ['trans', 'lodg', 'meal', 'etc'];

const TITLES = {guide:'이용 안내', dash:'대시보드', plan:'출장 계획 등록', actual:'출장 실적 입력',
  list:'출장 내역', process:'이관·처리 관리', budget:'예산 관리', data:'데이터 관리'};
const SUBS = {guide:'계획 작성부터 처리 완료까지 — 한눈에 보는 처리 흐름',
  dash:'잔여 = 총예산 − 처리완료 − 처리중', plan:'동행 출장은 출장자 행을 추가해 한 번에 등록',
  actual:'실적 저장 시 실비 이관 인폼이 자동 생성됩니다', list:'분기 전체 출장 이력',
  process:'실적 입력·인폼 → 소재 이관 → 처리 완료', budget:'예산 리비전 등록·이력 (감액은 자동 음수 처리)',
  data:'CSV 내보내기 · 자동 백업(30개) · 복원'};

let ST = null, YQ = null, VIEW = 'dash';

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
function dispSt(s){ return s === '계획 등록' ? '계획(잠정)' : s; }   // 잠정/확정 구분 명확히
function gname(g){ return [g.city, g.org].filter(Boolean).join(' '); }
function names(g){ return (g.travelers || []).map(p => esc(p.name)).join(', '); }
function procTag(g){   // 부분 처리(개인별 상태 분리) 표시 — 섞여 있을 때만
  const p = g.proc;
  if (!p || ['계획 등록', '확정 예정', '취소'].includes(g.status) || p.done === p.total) return '';
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
  qs.onchange = e => {
    const dirty = ($('#travBody')?.querySelector('.t-nm')?.value.trim()) || ACT_GID;
    if (dirty && !confirm('입력 중인 내용이 저장되지 않았습니다. 분기를 변경하면 사라집니다. 계속할까요?')) {
      e.target.value = YQ; return;
    }
    YQ = e.target.value; load();
  };
  renderAll();
}
function nav(v){
  VIEW = v;
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
function renderAll(){ rGuide(); rDash(); rPlan(); rActual(); rList(); rProcess(); rBudget(); rData(); }

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
        ${auto ? `<div class="gauto">⚙ 자동 · ${auto}</div>` : ''}
        ${jump ? `<div class="btns" style="margin-top:10px">${jump}</div>` : ''}
      </div>
    </div>`;
  const lead = `
    <div class="g-lead">
      <h2>출장비, 이렇게 흘러갑니다</h2>
      <p>출장자는 <b>계획</b>과 <b>실적</b>만 입력하면 됩니다. 인폼(메일)·이관·정산·이력은 시스템과 <b>소재 출장 예산 담당자</b>가 이어받습니다.
      입력은 한 번, 실비 이관 인폼은 <b>그룹당 한 통</b>이에요.</p>
      <div class="g-formula">가용 잔여 = 총예산 − 처리완료 − 처리중 − 확정예정(확보)</div>
    </div>
    <div class="card">
      <div class="flowbar">
        <span class="pill">① 계획(잠정)·확정</span><span class="arrow">→</span>
        <span class="pill wip">② 실적·인폼</span><span class="arrow">→</span>
        <span class="pill wip">③ 소재 이관</span><span class="arrow">→</span>
        <span class="pill done">④ 처리 완료</span>
      </div>`;
  const steps =
    step(1, '', '계획 등록', '계획을 올리고, 실제로 갈 건 ‘확정’', '담당자', 'owner',
      '도시·업체·목적·일자와 <b>출장자별 예상 비용</b>을 입력합니다(동행자는 행 추가). 처음엔 <b>잠정 계획</b>이고, 실제로 갈 건 <b>‘출장 확정’</b> 하면 계획 금액만큼 <b>예산이 미리 확보</b>돼요. 안 가게 된 잠정 계획은 ‘출장 내역’에서 <b>삭제</b>(흔적 없이 사라짐).',
      '잠정 계획은 예산 미반영(참고), 확정하면 가용 잔여에서 차감됩니다.',
      `<button class="btn pri" onclick="nav('plan')">출장 계획 등록으로 가기 →</button>`) +
    step(2, '', '실적 입력·인폼', '출장을 다녀온 뒤, 실제 쓴 금액을 넣습니다', '담당자', 'owner',
      '실제 사용액을 입력하면 <b>실비 이관 요청 인폼(메일)</b>이 그룹당 1통 자동으로 만들어집니다. 표 그대로 <b>복사</b>하거나 <b>Outlook으로 바로 열기</b> 할 수 있어요.',
      '계획 대비 차액이 자동 계산됩니다. (긴급 출장은 비고 필수)',
      `<button class="btn pri" onclick="nav('actual')">출장 실적 입력으로 가기 →</button>`) +
    step(3, 'admin', '소재 이관', '예산 담당자가 이관 후 소재 담당자에게 인폼', '예산 담당자', 'admin',
      '<b>소재 출장 예산 담당자</b>가 실비 이관 결재를 상신하고, <b>소재 담당자에게 이관 인폼(메일)</b>을 보냅니다 — “이관 결재 상신했습니다. 참조자로 추가했으니 이관 후 비용 처리 부탁드립니다.” <b>같은 출장이라도 사람마다 사정이 다르면</b>(예: 5명 중 1명만 예산 부족) <b>출장자별로 따로</b> 이관·완료·<b>보류</b>할 수 있어요.',
      '소재 이관 시 비용 처리 요청 인폼이 자동 생성됩니다. 보류(예산 부족 등)는 대시보드 ‘바로 할 일’에 알림으로 표시돼요.',
      `<button class="btn" onclick="nav('list')">내 출장 상태 확인 (출장 내역) →</button>`) +
    step(4, 'done', '처리 완료', '소재 담당자가 비용 처리하면 완료', '소재 담당자', 'owner',
      '이관 인폼을 받은 <b>소재 담당자</b>가 전표로 비용 처리를 하면 예산 담당자가 <b>‘처리 완료’</b>로 표시합니다. 이 금액이 예산에서 <b>최종 차감</b>돼요.',
      '', '') +
    step('취', 'cancel', '취소', '안 가게 되면 취소', '담당자·예산 담당자', 'owner',
      '일정 연기 등으로 출장이 취소되면 <b>계획·인폼 단계</b>에서 취소할 수 있습니다. 취소 건은 예산 계산에서 빠집니다.',
      '', '');
  const money = `
      <div class="note" style="margin:14px 0 0">
        💡 예산 계산: <b>가용 잔여 = 총예산 − 처리완료 − 처리중 − 확정예정(확보)</b>.
        <b>잠정 계획</b>은 참고만(미반영), <b>확정 예정</b>은 미리 확보(가용 차감), 실제 집행은 처리중·처리완료로 반영됩니다.
      </div></div>`;
  const legend = `
    <div class="card"><h2>상태 색상 보는 법</h2>
      <p class="cap">‘출장 내역’과 화면 곳곳의 배지 색으로 지금 어느 단계인지 한눈에 알 수 있어요.</p>
      <div class="glegend">
        <span><span class="status">계획 등록</span> 아직 계획만</span>
        <span><span class="status wip">처리중</span> 실적·인폼 / 소재 이관</span>
        <span><span class="status done">처리 완료</span> 정산 끝</span>
        <span><span class="status cancel">취소</span> 취소된 건</span>
        <span><span class="status urgent">긴급</span> 긴급 출장</span>
      </div></div>`;
  const faq = `
    <div class="card"><h2>자주 묻는 것</h2>
      <div class="gwhat"><b>· 같이 출장 가면?</b> 대표 1명이 그룹으로 등록하고 <b>동행자 행을 추가</b>하세요. 비용은 개인별로 저장되고, 인폼은 <b>그룹당 1통</b>만 나갑니다.</div>
      <div class="gwhat"><b>· 인폼은 누구에게 가나요?</b> ${to || '설정된 수신자'} 로 발송용 초안이 만들어집니다.</div>
      <div class="gwhat"><b>· 5명 중 일부만 처리됐다면?</b> 처리 관리에서 <b>출장자별로</b> 완료·보류를 따로 정할 수 있어요. 3명 완료·1명 보류 같은 상태가 예산·대시보드에 그대로 반영됩니다.</div>
      <div class="gwhat"><b>· 내 출장이 지금 어느 단계인지?</b> <a onclick="nav('list')" style="color:var(--blue);cursor:pointer;font-weight:700">‘출장 내역’</a>에서 상태 배지로 확인하세요.</div>
    </div>`;
  $('#v-guide').innerHTML = lead + steps + money + legend + faq;
}

/* ═══ 대시보드 ═══ */
function rDash(){
  const d = ST.dash;
  const av = d.avail !== undefined ? d.avail : d.remain;
  const burn = d.alloc ? Math.round((d.done + d.wip + (d.commit || 0)) / d.alloc * 100) : 0;
  const hero = `
    <div class="hero ${d.short ? 'alert' : ''}">
      <span class="lamp"></span>
      <div style="flex:1">
        <div class="msg">${d.short
          ? '확정·집행이 예산을 초과했습니다 — 센터 검토 및 추가 확보 필요'
          : d.noBudget ? '이 분기 예산이 아직 배정되지 않았습니다 — 예산 관리에서 배정하세요'
          : '소재 그룹 국내 출장비 잔액이 있어 정상 운영 중입니다'}</div>
        <div class="fig">총예산 <b>${won(d.alloc)}원</b> − 처리완료 <b>${won(d.done)}원</b> − 처리중 <b>${won(d.wip)}원</b> − 확정예정 <b>${won(d.commit || 0)}원</b> = 가용 <b style="color:${av < 0 ? 'var(--red)' : 'var(--navy)'}">${av < 0 ? '−' : ''}${won(Math.abs(av))}원</b></div>
        <div class="fig" style="color:var(--faint)">잠정 계획 ${won(d.planAmt)}원은 참고(예산 미반영) · 확정 시 위 ‘확정예정’으로 선확보됩니다</div>
      </div>
      <div style="text-align:right">
        <div class="label">가용 잔여 (확정 확보 반영) · 소진율 ${burn}%</div>
        <div class="amount">${av < 0 ? '−' : ''}${won(Math.abs(av))}원</div>
      </div>
    </div>`;
  const kpi = `
    <div class="kpis">
      <div class="kpi"><span>총 예산</span><b>${won(d.alloc)}</b><small>리비전 ${ST.budget.length}회</small></div>
      <div class="kpi"><span>확정 예정 <span class="au">예산 확보</span></span><b>${won(d.commit || 0)}</b><small>${d.nConfirm || 0}건 · 가용서 차감</small></div>
      <div class="kpi"><span>처리중 (인폼·이관)</span><b>${won(d.wip)}</b><small>${d.nWip}건 진행</small></div>
      <div class="kpi"><span>처리 완료</span><b>${won(d.done)}</b><small>${d.nDone}건 · 정산 완료</small></div>
    </div>`;
  const aw = d.todo.actual_wait.length, pw = d.todo.process_wait.length, hd = (d.todo.hold || []).length;
  const todo = (aw || pw || hd) ? `
    <div class="card"><h2>바로 할 일</h2><p class="cap">대시보드에서 바로 이동해 처리하세요.</p>
      <div class="btns" style="margin-top:0">
        ${aw ? `<button class="btn pri" onclick="nav('actual')">실적 입력 대기 ${aw}건 → 실적 입력</button>` : ''}
        ${pw ? `<button class="btn" onclick="goProcess()">이관·처리 대기 ${pw}건 → 처리 관리</button>` : ''}
        ${hd ? `<button class="btn red" onclick="goProcess()">보류 ${d.nHold}명 (예산부족 등) → 처리 관리</button>` : ''}
        <button class="btn" onclick="showReport()">센터 제출 리포트</button>
      </div></div>` : `
    <div class="card"><h2>바로 할 일</h2><p class="cap">지금 처리할 건이 없습니다.</p>
      <div class="btns" style="margin-top:0"><button class="btn" onclick="showReport()">센터 제출 리포트</button></div></div>`;
  const rows = d.byCcg.map(r => `<tr>
    <td><b>${esc(r.team)}</b> <span class="sub">${r.ccg}</span></td>
    <td class="num">${won(r.done)}</td><td class="num">${won(r.wip)}</td>
    <td class="num"><b>${won(r.total)}</b></td>
    <td class="num">${(r.share * 100).toFixed(1)}%</td>
    <td class="num" style="color:var(--blue)">${won(r.commit || 0)}</td>
    <td class="num sub">${won(r.plan)}</td>
    <td class="num">${r.groups}</td><td class="num">${r.people}</td></tr>`).join('')
    || '<tr><td colspan="9" style="color:var(--faint);text-align:center;padding:18px">집행 내역이 없습니다.</td></tr>';
  const tot = d.byCcg.reduce((a, r) => (
    {done:a.done + r.done, wip:a.wip + r.wip, total:a.total + r.total, commit:a.commit + (r.commit||0), plan:a.plan + r.plan,
     groups:a.groups + r.groups, people:a.people + r.people}), {done:0, wip:0, total:0, commit:0, plan:0, groups:0, people:0});
  const ccg = `
    <div class="card"><div class="card-head"><h2>CCG팀(부서)별 집행 현황</h2>
      <span class="cap" style="margin:0">총사용액 = 처리완료 + 처리중 · 확정예정은 선확보(가용 차감) · 잠정은 참고</span></div>
    <div class="scroll" style="margin-top:12px"><table>
      <thead><tr><th>CCG팀</th><th class="num">처리완료</th><th class="num">처리중</th>
        <th class="num">총사용액</th><th class="num">구성비</th><th class="num">확정예정</th><th class="num">잠정계획</th>
        <th class="num">출장 그룹</th><th class="num">참여 인원</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>합계</td><td class="num">${won(tot.done)}</td><td class="num">${won(tot.wip)}</td>
        <td class="num">${won(tot.total)}</td><td class="num">${tot.total ? '100.0%' : '–'}</td><td class="num">${won(tot.commit)}</td><td class="num">${won(tot.plan)}</td>
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
        <thead><tr><th>성명<span class="rq">*</span></th><th>사번<span class="rq">*</span></th><th>직책<span class="rq">*</span></th><th>CCG팀<span class="rq">*</span></th><th>CCG No.</th>
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
      <label style="display:flex;align-items:center;gap:8px;font-weight:600;margin-top:4px">
        <input type="checkbox" id="pl_confirm" style="width:auto;margin:0"> 이 출장은 <b style="margin:0 2px">실제로 갑니다</b> — 지금 <b style="margin:0 2px;color:var(--blue)">예산 확보(확정 예정)</b>. 미체크 시 잠정 계획으로 등록됩니다.
      </label>
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
function collectTravelers(){
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
    confirmed: $('#pl_confirm')?.checked || false,
    travelers: collectTravelers()};
  const {ok, data} = await api('/groups', {method: 'POST', body: JSON.stringify(body)});
  if (!ok) { showErr('#planErr', data.errors); return; }
  toast(`등록 완료 — ${dispSt(data.group.status)} · ${body.travelers.length}명`);
  YQ = data.group.yq;
  await load(); nav('plan');
}

/* ═══ 출장 실적 입력 ═══ */
let ACT_GID = null;
function rActual(){
  const targets = ST.groups.filter(g => g.yq === YQ && ['계획 등록', '확정 예정', '실적 입력·인폼'].includes(g.status));
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
    <div class="mh"><span>${esc(mail.heading || '실비 이관 요청 인폼 (그룹당 1통)')}</span>
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
    const url = `mailto:${encodeURIComponent(mail.to)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body_text)}`;
    if (url.length > 1900) {   // 긴 본문은 mailto 한도 초과로 잘림 — 복사로 대체
      copyText(mail.body_text, '본문이 길어 메일 대신 복사했습니다 — 새 메일에 붙여넣으세요');
      return;
    }
    location.href = url;
  };
  $('#mailCopyHtml').onclick = async () => {
    if (!navigator.clipboard) { copyText(mail.body_text); return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([mail.body_html], {type: 'text/html'}),
        'text/plain': new Blob([mail.body_text], {type: 'text/plain'})})]);
      toast('표 포함 복사됨 — Outlook에 붙여넣으세요');
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
  {k:'sap',   th:'전표번호', f:'txt', ph:'전표', num:true},
];
const LQ = {q:'', sort:'stage', dir:'desc', group:true, col:{}};
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
  if (k === 'sap')   return g.sap_doc || '';
  return '';
}
function listRows(){
  const all = ST.groups.filter(g => g.yq === YQ);
  const q = LQ.q.trim().toLowerCase();
  // 전체 검색은 '데이터'만 대상 — 관리 버튼 문구가 걸리지 않도록
  const hay = g => [g.city, g.org, g.purpose, g.roll, g.plan_type, g.sap_doc,
    ...(g.travelers || []).flatMap(p => [p.name, p.emp_no, p.ccg_nm])]
    .filter(Boolean).join(' ').toLowerCase();
  const G = all.filter(g => {
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
    if (LQ.group) { const d = a.stage - b.stage; if (d) return d; }   // 프로세스별 우선 분류
    const k = (LQ.sort === 'stage' && LQ.group) ? 'date' : LQ.sort;
    return sgn * cmpCol(a, b, k) || cmpCol(a, b, 'date');
  });
  return {all, G: sorted};
}
function sortList(k){
  if (LQ.sort === k) LQ.dir = LQ.dir === 'asc' ? 'desc' : 'asc';
  else { LQ.sort = k; LQ.dir = (k === 'plan' || k === 'act') ? 'desc' : 'asc'; }
  renderListBody();
}
function setCol(k, v){ LQ.col[k] = v; renderListBody(); }   // 본문만 갱신 → 입력 포커스 유지
function clearList(){ LQ.q = ''; LQ.col = {}; rList(); nav('list'); }
function toggleGroup(on){ LQ.group = on; renderListBody(); }
function toggleLDir(){ LQ.dir = LQ.dir === 'asc' ? 'desc' : 'asc'; renderListBody(); }

function listRowHtml(g){
  const acts = [];
  if (g.status === '계획 등록') {          // 잠정: 확정하거나 흔적 없이 삭제
    acts.push(`<button class="btn sm pri" onclick="setStatus('${g.group_id}','확정 예정')">출장 확정</button>`);
    acts.push(`<button class="btn sm" onclick="delGroup('${g.group_id}')">삭제</button>`);
  } else if (g.status === '확정 예정') {   // 확정: 예산 확보됨
    acts.push(`<button class="btn sm" onclick="setStatus('${g.group_id}','계획 등록')">확정 해제</button>`);
    acts.push(`<button class="btn sm red" onclick="setStatus('${g.group_id}','취소')">취소</button>`);
  }
  return `<tr>
    <td><span class="status ${stClass(g.roll)}">${esc(dispSt(g.roll))}</span>${g.plan_type === '긴급' ? ' <span class="status urgent">긴급</span>' : ''}</td>
    <td><b>${esc(gname(g))}</b><div class="sub">${esc(g.purpose)}</div></td>
    <td>${names(g)} <span class="sub">${g.travelers.length}명</span>${procTag(g)}</td>
    <td class="num">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)}</td>
    <td class="num">${g.plan_tot ? won(g.plan_tot) : '–'}</td>
    <td class="num"><b>${g.act_tot ? won(g.act_tot) : '–'}</b></td>
    <td class="num">${g.sap_doc ? esc(g.sap_doc) : '–'}</td>
    <td>${acts.join(' ') || '<span class="sub">진행/처리 단계</span>'}</td></tr>`;
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
        <b style="margin-left:6px">${n}건</b></td></tr>`;
    }
    body += listRowHtml(g);
  });
  const tb = $('#listBody');
  if (!tb) return;
  tb.innerHTML = body || '<tr class="empty"><td colspan="8" style="color:var(--faint);text-align:center;padding:18px">조건에 맞는 출장이 없습니다.</td></tr>';
  const cnt = $('#listCount');
  if (cnt) cnt.textContent = `${G.length}/${all.length}건 · 잠정 ${ST.dash.nPlan || 0} · 확정 ${ST.dash.nConfirm || 0}`;
  $$('#v-list .sic').forEach(el => {            // 정렬 표시(▲▼)
    el.textContent = el.dataset.k === LQ.sort ? (LQ.dir === 'asc' ? ' ▲' : ' ▼') : '';
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
    if (c.f === 'sel') return `<th><select class="colf" onchange="setCol('stage',this.value)">`
      + [''].concat(ST.meta.statuses).map(x => opt(x, LQ.col.stage || '', x ? dispSt(x) : '전체')).join('')
      + `</select></th>`;
    return `<th class="${c.num ? 'num' : ''}"><input class="colf" value="${esc(LQ.col[c.k] || '')}"`
      + ` placeholder="${esc(c.ph || '')}" oninput="setCol('${c.k}',this.value)"></th>`;
  }).join('');
  $('#v-list').innerHTML = `
    <div class="note">‘<b>계획(잠정)</b>’은 참고용 리스트 — 실제로 안 가면 <b>삭제</b>(흔적 없이 사라짐). 실제로 갈 건 ‘<b>출장 확정</b>’ 하면 계획 금액만큼 <b>예산이 미리 확보</b>됩니다. (확정 이후 취소는 기록으로 남습니다)</div>
    <div class="card">
      <div class="card-head"><h2>${YQ} 출장 내역 <span class="sub" id="listCount" style="font-weight:600"></span></h2>
        <a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">CSV 다운로드</a></div>
      <div class="filter-row" style="margin-top:12px">
        <input id="listFilter" value="${esc(LQ.q)}" placeholder="🔍 전체 검색 (성명·사번·업체·도시·목적·전표번호)"
          oninput="LQ.q=this.value; renderListBody()">
        <label style="display:flex;align-items:center;gap:6px;font-weight:600;margin:0;white-space:nowrap">
          <input type="checkbox" style="width:auto;margin:0" ${LQ.group ? 'checked' : ''}
            onchange="toggleGroup(this.checked)"> 프로세스별 묶기</label>
        <button class="btn" id="listDir" onclick="toggleLDir()">${dirIcon(LQ.dir)}</button>
        <button class="btn" onclick="clearList()">필터 해제</button>
      </div>
      <p class="cap" style="margin:-4px 0 10px">표 머리글을 누르면 그 항목 기준으로 정렬되고, 머리글 아래 칸에 입력하면 컬럼별로 검색됩니다.</p>
      <div class="scroll"><table>
        <thead>
          <tr>${ths}<th>관리</th></tr>
          <tr class="filt">${filts}<th></th></tr>
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
  const block = g => {
    const past = g.status !== '계획 등록';            // 실적 입력 후 = 개인별 처리 가능
    const pc = g.proc || {done:0, transfer:0, inform:0, hold:0, total:g.travelers.length};
    const src = g.inform_at || g.updated_at || g.created_at;
    const w = past && g.roll !== '처리 완료' && src ? Math.floor((Date.now() - new Date(src)) / 864e5) : null;
    const wtag = w === null ? '' : ` · <b style="color:${w >= 7 ? 'var(--red)' : w >= 3 ? '#8A5A10' : 'var(--faint)'}">대기 D+${w}</b>`;
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
    return `<div class="pgroup">
      <div class="pg-head">
        <span class="status ${stClass(g.roll)}">${esc(g.roll)}</span>
        <span class="nm">${esc(gname(g))}</span>
        <span class="sub">${fmtD(g.dep_dt)}–${fmtD(g.ret_dt)} · ${g.travelers.length}명 · 실적 ${g.act_tot ? won(g.act_tot) : '–'}</span>
        <span class="gb">${gb.join(' ')}</span>
      </div>
      <div style="padding:5px 13px 3px"><span class="pg-sum">${summary}</span></div>
      ${past ? `<div class="scroll" style="border:0"><table>
        <thead><tr><th style="width:120px">개인 상태</th><th>출장자</th><th class="num">실적</th><th>처리 (인당)</th></tr></thead>
        <tbody>${prows}</tbody></table></div>` : ''}
    </div>`;
  };
  $('#v-process').innerHTML = `
    <div class="note">실적 입력·인폼 → <b>소재 이관</b>(실비 이관 접수) → <b>처리 완료</b>(전표 처리 종료). 처리 완료·처리중(인폼·이관·<b>보류</b>) 금액만 잔여에서 차감됩니다.
      <br>같은 출장이라도 <b>출장자별로 따로</b> 처리·보류할 수 있어요 — 아래 ‘처리(인당)’ 버튼. 다 같이 처리할 땐 상단 ‘전체’ 버튼을 쓰세요.</div>
    <div class="card"><h2>${YQ} 이관·처리 관리 (출장자 개인별)</h2>
      ${G.map(block).join('') || '<div style="color:var(--faint);text-align:center;padding:22px">대상이 없습니다.</div>'}
    </div>`;
}
async function setStatus(gid, status){
  if (status === '취소' && !confirm('이 출장을 취소할까요?\n취소 건은 기록으로 남으며, 되돌리려면 관리자 인증이 필요합니다.')) return;
  const {ok, data} = await api(`/groups/${gid}/status`, {method: 'POST', body: JSON.stringify({status})});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(() => setStatus(gid, status)); return; }
    toast((data.errors || ['실패'])[0]); return;
  }
  if (data.mail) showMail(data.mail);          // 이관 → 비용 처리 요청 인폼
  toast(data.held ? `${dispSt(status)} — 보류 ${data.held}명은 제외(유지)됨` : `상태 변경 — ${dispSt(status)}`);
  await load(); nav(VIEW);
}
async function setPersonStatus(gid, emp, status){
  const {ok, data} = await api(`/groups/${gid}/status`, {method: 'POST', body: JSON.stringify({status, emp_no: emp})});
  if (!ok) {
    if (data.errors?.[0]?.includes('인증')) { askAdmin(() => setPersonStatus(gid, emp, status)); return; }
    toast((data.errors || ['실패'])[0]); return;
  }
  if (data.mail) showMail(data.mail);          // 이관 → 비용 처리 요청 인폼
  toast(`개인 처리 — ${status}`);
  await load(); nav(VIEW);
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
      <div class="filter-row" style="margin-top:10px">
        <input value="${esc(BQ.q)}" placeholder="🔍 REV·유형·사유·반영일"
          oninput="BQ.q=this.value; clearTimeout(window._bt); window._bt=setTimeout(()=>{rBudget();nav('budget')},250)">
        <select onchange="setBQ('type',this.value)">
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
        <div><label>금액 (원)</label><input type="number" id="bd_amt" step="100000"></div>
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
      <div class="scroll" style="margin-top:10px"><table>
        <thead><tr><th>REV</th><th class="num">반영일</th><th>유형</th><th class="num">증감액</th>
          <th class="num">누적</th><th>사유</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="color:var(--faint);text-align:center;padding:18px">조건에 맞는 리비전이 없습니다.</td></tr>'}</tbody>
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
        <a class="btn pri" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">${YQ} 출장 CSV</a>
        <a class="btn" href="${API}/export.csv">전체 출장 CSV</a>
        <a class="btn" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">${YQ} 예산 CSV</a>
        <a class="btn" href="${API}/export_budget.csv">전체 예산 CSV</a></div></div>
    <div class="card"><h2>자동 백업 (최근 30개 유지)</h2>
      <p class="cap">저장 직전 자동 백업됩니다. 복원은 관리자 인증이 필요합니다.</p>
      <div class="scroll"><table>
        <thead><tr><th>파일</th><th class="num">크기</th><th class="num">시각</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" style="color:var(--faint);text-align:center;padding:18px">백업이 없습니다.</td></tr>'}</tbody>
      </table></div></div>
    <div class="card"><h2>감사 로그 <span class="sub" style="font-weight:600">최근 활동 — 누가 무엇을 했는지</span></h2>
      <p class="cap">삭제·상태 변경·예산·복원 이력이 남습니다. 잠정 계획 삭제는 내용까지 기록됩니다.</p>
      <div id="auditBox"><button class="btn" onclick="loadAudit()">감사 로그 불러오기</button></div></div>
    <div class="card"><h2>정본 위치</h2>
      <div class="note">servera/travelbudget/data_json/data.json — 백업: data_json/backup/<br>
      운영 시 <b>TB_DATA_DIR</b> 환경변수로 앱 폴더 밖(예: /var/lib/travelbudget)을 지정하면 배포 시 덮어써도 데이터가 보존됩니다.</div></div>`;
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
    <tbody>${rows || '<tr><td colspan="4" style="color:var(--faint);text-align:center;padding:18px">기록이 없습니다.</td></tr>'}</tbody>
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
  const text = [`[${r.yq} 소재 그룹 국내 출장비 집행 현황]`, '',
    `배정 ${won(r.alloc)}원 / 집행 ${won(r.used)}원 (완료 ${won(r.done)} + 처리중 ${won(r.wip)})`,
    `확정 예정(확보) ${won(r.commit)}원 · 소진율 ${(r.burn * 100).toFixed(1)}%`,
    `가용 잔여 ${won(r.avail)}원` + (r.need > 0 ? ` · 추가 필요 예상 ${won(r.need)}원` : ''), '',
    `출장 ${r.nDone + r.nWip + r.nConfirm}건 (완료 ${r.nDone} · 진행 ${r.nWip} · 확정 ${r.nConfirm}) · 연인원 ${r.nPeople}명`].join('\n');
  document.getElementById('mailCard')?.remove();
  const el = document.createElement('div');
  el.className = 'mailcard'; el.id = 'mailCard'; el.style.width = '760px';
  el.innerHTML = `<div class="mh"><span>센터 제출 리포트 · ${esc(r.yq)}</span>
      <button onclick="this.closest('.mailcard').remove()">×</button></div>
    <div class="body">
      <div class="kpis" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="kpi"><span>배정</span><b>${won(r.alloc)}</b></div>
        <div class="kpi"><span>집행(완료+처리중)</span><b>${won(r.used)}</b></div>
        <div class="kpi"><span>확정 예정</span><b>${won(r.commit)}</b></div>
        <div class="kpi"><span>${r.need > 0 ? '추가 필요' : '가용 잔여'}</span><b style="color:${r.need > 0 ? 'var(--red)' : 'var(--navy)'}">${won(r.need > 0 ? r.need : r.avail)}</b></div>
      </div>
      <p class="cap" style="margin:6px 0 10px">소진율 ${(r.burn * 100).toFixed(1)}% · 출장 ${r.nDone + r.nWip + r.nConfirm}건 · 연인원 ${r.nPeople}명</p>
      <table style="width:100%"><thead><tr><th>CCG팀</th><th class="num">완료</th><th class="num">처리중</th>
        <th class="num">확정예정</th><th class="num">합계</th><th class="num">건</th><th class="num">인원</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center;color:var(--faint);padding:14px">집행 없음</td></tr>'}</tbody></table>
      <h2 style="font-size:13px;margin:14px 0 6px;color:var(--navy)">예산 리비전</h2>
      <table style="width:100%"><thead><tr><th class="num">반영일</th><th>유형</th><th class="num">증감</th><th>사유</th></tr></thead>
        <tbody>${revs || '<tr><td colspan="4" style="text-align:center;color:var(--faint);padding:14px">없음</td></tr>'}</tbody></table>
    </div>
    <div class="mf"><button class="btn sm pri" id="rptCopy">요약 복사</button>
      <a class="btn sm" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">상세 CSV</a>
      <a class="btn sm" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">예산 CSV</a></div>`;
  document.body.appendChild(el);
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
  setTimeout(() => $('#admId')?.focus(), 50);   // 모달이 이미 닫혔으면 무시
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
