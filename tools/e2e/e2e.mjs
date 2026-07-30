/* 실행: node tools/e2e/e2e.mjs   (저장소 루트에서)
   필요: Node 18+ 와 Playwright.  설치: npm i -D playwright && npx playwright install chromium
   PLAYWRIGHT_PATH 환경변수로 playwright 모듈 경로를 직접 지정할 수도 있습니다. */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const _req = createRequire(import.meta.url);
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'playwright';
const REPO = process.env.TB_REPO || process.cwd();
const TMP = fs_mkdtemp();
function fs_mkdtemp(){ const f = _req('node:fs'); return f.mkdtempSync(path.join(os.tmpdir(), 'tb_e2e_')); }
/* Browser E2E for the travel-budget app. Boots Flask on a random port, drives Chromium. */
const pw = _req(PW_PATH);
const { chromium } = pw;
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import fs from 'node:fs';

const PORT = 5137;
let P = 0, F = 0;
const ok = (n, c, got) => { if (c) { P++; console.log(`  PASS  ${n}`); } else { F++; console.log(`  FAIL  ${n} -> ${JSON.stringify(got)}`); } };

// fresh data

// 픽스처 — 신규 설치는 빈 원장이므로 예시 원장을 임시 폴더에 깔고 시작한다.
// (저장소/운영 data_json 은 절대 건드리지 않는다)
import { execFileSync } from 'node:child_process';
execFileSync('python3', ['-c',
  `import sys,json,os; sys.path.insert(0,r'${REPO}')\n` +
  `from servera.travelbudget import store\n` +
  `os.makedirs(r'${TMP}', exist_ok=True)\n` +
  `open(os.path.join(r'${TMP}','data.json'),'w',encoding='utf-8').write(json.dumps(store.example_data(),ensure_ascii=False))`],
  { cwd: REPO });
const srv = spawn('python3', ['-c',
  `import sys,os; os.environ['TB_DATA_DIR']=r'${TMP}'; sys.path.insert(0,r'${REPO}'); from webmain import app; app.run(host='127.0.0.1', port=${PORT}, debug=False, use_reloader=False)`],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
srv.stderr.on('data', d => { const s = d.toString(); if (/Traceback|Error/.test(s)) process.stderr.write('[srv] ' + s); });

async function waitPort() {
  for (let i = 0; i < 80; i++) {
    const up = await new Promise(r => { const s = net.connect(PORT, '127.0.0.1'); s.on('connect', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
    if (up) return true;
    await sleep(150);
  }
  return false;
}

const base = `http://127.0.0.1:${PORT}/travelbudget/`;
let browser;
try {
  if (!(await waitPort())) throw new Error('server did not start');
  browser = await chromium.launch();
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });

  // 1. Dashboard renders, formula visible
  const figTxt = await page.textContent('#v-dash .fig');
  ok('대시보드 hero 렌더', !!figTxt && figTxt.includes('가용'), figTxt);
  ok('공식 노출 (총예산−완료−처리중−확정예정=가용)', /총예산.*처리완료.*처리중.*확정예정.*가용/.test(figTxt), figTxt);

  // remaining number consistency vs KPIs
  const nums = await page.evaluate(() => ({
    alloc: ST.dash.alloc, done: ST.dash.done, wip: ST.dash.wip, remain: ST.dash.remain,
  }));
  ok('잔여 = 총예산−완료−처리중 (프런트 상태)', nums.remain === nums.alloc - nums.done - nums.wip, nums);

  // per-CCG share sums ~100%
  const share = await page.evaluate(() => ST.dash.byCcg.reduce((a, r) => a + r.share, 0));
  ok('CCG 구성비 합 ≈ 100%', Math.abs(share - 1) < 0.01 || (nums.done + nums.wip === 0), share);

  // 1b. 이용 안내(가이드) 화면
  await page.click('.nav a[data-view="guide"]');
  await page.waitForSelector('#v-guide.on .g-lead', { timeout: 3000 });
  ok('이용 안내 메뉴 열림', await page.isVisible('.flowbar'));
  ok('4단계 스텝 표시', (await page.$$('#v-guide .gstep')).length === 5, (await page.$$('#v-guide .gstep')).length);
  ok('처리 흐름 공식 노출', /가용 잔여 = 총예산 − 처리완료 − 처리중 − 확정예정/.test(await page.textContent('#v-guide .g-formula')));
  // jump button → plan
  await page.click('#v-guide button:has-text("출장 계획 등록으로 가기")');
  await page.waitForSelector('#v-plan.on #pl_city', { timeout: 3000 });
  ok('가이드 → 계획 등록 화면 이동', await page.isVisible('#pl_city'));

  // 2. Plan registration with companion
  await page.click('.nav a[data-view="plan"]');
  await page.waitForSelector('#pl_city');
  await page.fill('#pl_city', '수원');
  await page.fill('#pl_org', '테스트머트리얼즈');
  await page.fill('#pl_purpose', 'E2E 정기 Audit');
  const yq = await page.evaluate(() => YQ);
  const [yy, qn] = yq.split('-');
  const mm = String(parseInt(qn) * 3).padStart(2, '0');
  await page.fill('#pl_dep', `${yy}-${mm}-10`);
  await page.fill('#pl_ret', `${yy}-${mm}-11`);
  // traveler 1
  await page.fill('#travBody tr:nth-child(1) .t-nm', '홍길동');
  await page.fill('#travBody tr:nth-child(1) .t-no', 'E9001');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Gas 소재팀');
  const ccgAuto = await page.inputValue('#travBody tr:nth-child(1) .t-cc');
  ok('CCG No. 자동채움', ccgAuto === 'C1202', ccgAuto);
  await page.fill('#travBody tr:nth-child(1) .t-p-trans', '70000');
  await page.fill('#travBody tr:nth-child(1) .t-p-lodg', '90000');
  // add companion
  await page.click('button:has-text("+ 동행자 추가")');
  await page.fill('#travBody tr:nth-child(2) .t-nm', '김동행');
  await page.fill('#travBody tr:nth-child(2) .t-no', 'E9002');
  await page.selectOption('#travBody tr:nth-child(2) .t-tm', 'Photo 소재팀');
  await page.fill('#travBody tr:nth-child(2) .t-p-trans', '70000');
  const planTot = await page.textContent('#planTot');
  ok('계획 총합계 집계', planTot.replace(/[^0-9]/g, '') === '230000', planTot);
  await page.click('#v-plan button:has-text("출장 계획 등록")');
  await page.waitForFunction(() => document.querySelector('.toast'), { timeout: 4000 }).catch(() => {});
  await sleep(400);
  const created = await page.evaluate(() => ST.groups.find(g => g.org === '테스트머트리얼즈'));
  ok('계획 등록 저장됨 (2인)', created && created.travelers.length === 2, created && created.travelers.length);

  // 3. Actual entry -> inform card
  await page.click('.nav a[data-view="actual"]');
  await page.waitForSelector('#actSel');
  const gid = created.group_id;
  await page.selectOption('#actSel', gid);
  await page.waitForSelector('#actRows tr');
  await page.fill('#actRows tr:nth-child(1) .a-trans', '68000');
  await page.fill('#actRows tr:nth-child(1) .a-lodg', '88000');
  await page.fill('#actRows tr:nth-child(2) .a-trans', '69000');
  await page.click('button:has-text("실적 저장 및 인폼 생성")');
  await page.waitForSelector('#mailCard', { timeout: 5000 });
  const mailHtml = await page.innerHTML('#mailCard .body');
  ok('인폼 카드 HTML 표 생성', mailHtml.includes('<table'), mailHtml.slice(0, 40));
  ok('인폼에 출장자 표기', mailHtml.includes('홍길동') && mailHtml.includes('김동행'));
  const status = await page.evaluate(g => ST.groups.find(x => x.group_id === g).status, gid);
  ok('상태 자동 → 실적 입력·인폼', status === '실적 입력·인폼', status);

  // 4. Admin gate + 개인별 처리 (핵심: 같은 출장 5명 중 일부만 처리/보류)
  await page.evaluate(() => sessionStorage.removeItem('tb_pw'));
  await page.click('.nav a[data-view="process"]');
  await page.waitForSelector('#adminModal', { timeout: 3000 });
  ok('관리자 잠금 화면 프롬프트', await page.isVisible('#adminModal'));
  await page.fill('#admPw', '2071478');
  await page.click('#admOk');
  await page.waitForSelector('#v-process.on .pgroup', { timeout: 3000 });
  await sleep(200);
  const rowOf = name => page.locator('#v-process tr').filter({ hasText: name });
  // 김동행 → 소재 이관 시 '비용 처리 요청' 인폼 자동 생성 (기존 카드 제거 후 새 카드 확인)
  await page.evaluate(() => document.getElementById('mailCard')?.remove());
  await rowOf('김동행').getByRole('button', { name: '소재 이관', exact: true }).click();
  await page.waitForSelector('#mailCard .mh', { timeout: 4000 });
  await page.waitForFunction(() => /이관 결재 상신했습니다/.test(document.getElementById('mailCard')?.textContent || ''), { timeout: 4000 });
  const tHtml = await page.textContent('#mailCard');
  ok('이관 인폼 자동 생성(비용 처리 요청)', /이관 결재 상신했습니다/.test(tHtml) && /비용 처리 부탁드립니다/.test(tHtml), tHtml.slice(0, 50));
  await page.click('#mailCard .mh button');   // close card
  await sleep(200);
  await rowOf('홍길동').getByRole('button', { name: '처리 완료', exact: true }).click();
  await sleep(400);
  await rowOf('김동행').getByRole('button', { name: '보류', exact: true }).click();
  await sleep(400);
  const pst = await page.evaluate(g => {
    const grp = ST.groups.find(x => x.group_id === g);
    return { hong: grp.travelers.find(p => p.name === '홍길동').status,
      kim: grp.travelers.find(p => p.name === '김동행').status, roll: grp.roll, proc: grp.proc };
  }, gid);
  ok('개인별 처리 분리 (홍=완료 / 김=보류)', pst.hong === '처리 완료' && pst.kim === '보류', pst);
  ok('그룹 롤업=처리중, proc 완료1·보류1', pst.roll === '실적 입력·인폼' && pst.proc.done === 1 && pst.proc.hold === 1, pst);

  // 5. Budget view (admin) add revision, 감액 auto-negative
  await page.click('.nav a[data-view="budget"]');
  await page.waitForSelector('#bd_amt', { timeout: 3000 });
  await page.selectOption('#bd_type', '감액');
  await page.fill('#bd_amt', '500000');
  await page.fill('#bd_reason', 'E2E 감액');
  await page.click('button:has-text("리비전 반영")');
  await sleep(500);
  const negAmt = await page.evaluate(() => ST.budget.find(b => b.reason === 'E2E 감액')?.amt);
  ok('감액 자동 음수', negAmt === -500000, negAmt);

  // 5b. 대시보드 소진율 + 보류 알림
  await page.click('.nav a[data-view="dash"]');
  await page.waitForSelector('#v-dash .hero .label');
  ok('대시보드 소진율(%) 노출', /소진율\s*\d+%/.test(await page.textContent('#v-dash .hero .label')));
  ok('대시보드 보류 알림 노출', await page.isVisible('#v-dash .btn.red'));

  // 5c. 보류자 처리 완료 → 그룹 전체 완료로 롤업
  await page.click('.nav a[data-view="process"]');
  await page.waitForSelector('#v-process .pgroup', { timeout: 3000 });
  await sleep(200);
  await rowOf('김동행').getByRole('button', { name: '처리 완료', exact: true }).click();
  await sleep(400);
  const roll2 = await page.evaluate(g => ST.groups.find(x => x.group_id === g).roll, gid);
  ok('두 명 다 완료 → 그룹 처리 완료', roll2 === '처리 완료', roll2);

  // 5d. Live stored-XSS: script in org must NOT execute in admin's inform card
  let alerted = false;
  page.on('dialog', async d => { alerted = true; await d.dismiss(); });
  await page.click('.nav a[data-view="plan"]');
  await page.waitForSelector('#pl_city');
  await page.fill('#pl_city', 'XSS시');
  await page.fill('#pl_org', '<img src=x onerror=alert(1)>');
  await page.fill('#pl_purpose', 'XSS E2E');
  await page.fill('#pl_dep', `${yy}-${mm}-18`);
  await page.fill('#pl_ret', `${yy}-${mm}-18`);
  await page.fill('#travBody tr:nth-child(1) .t-nm', '해커');
  await page.fill('#travBody tr:nth-child(1) .t-no', 'X1');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Gas 소재팀');
  await page.fill('#travBody tr:nth-child(1) .t-p-trans', '10000');
  await page.click('#v-plan button:has-text("출장 계획 등록")');
  await sleep(400);
  const xgid = await page.evaluate(() => ST.groups.find(g => g.org.includes('onerror'))?.group_id);
  await page.click('.nav a[data-view="actual"]');
  await page.waitForSelector('#actSel');
  await page.selectOption('#actSel', xgid);
  await page.waitForSelector('#actRows tr');
  await page.fill('#actRows tr:nth-child(1) .a-trans', '10000');
  await page.click('button:has-text("실적 저장 및 인폼 생성")');
  await page.waitForSelector('#mailCard', { timeout: 5000 });
  await sleep(300);
  const imgInCard = await page.evaluate(() => document.querySelector('#mailCard .body img') ? true : false);
  ok('저장형 XSS 미실행 (alert 안 뜸)', alerted === false);
  ok('인폼 카드에 주입 <img> 노드 없음', imgInCard === false);

  // 5e. 잠정/확정 구분 + 예산 선확보 + 흔적 없는 삭제
  await page.click('.nav a[data-view="dash"]');
  await page.waitForSelector('#v-dash .kpi');
  const commitBefore = await page.evaluate(() => ST.dash.commit);
  ok('시드 확정예정 예산 확보 표시', commitBefore > 0, commitBefore);
  // 잠정 계획 생성 (확정 체크 안 함)
  await page.click('.nav a[data-view="plan"]');
  await page.waitForSelector('#pl_city');
  await page.fill('#pl_city', '대전'); await page.fill('#pl_org', '확정테스트'); await page.fill('#pl_purpose', '확정 E2E');
  await page.fill('#pl_dep', `${yy}-${mm}-20`); await page.fill('#pl_ret', `${yy}-${mm}-21`);
  await page.fill('#travBody tr:nth-child(1) .t-nm', '확정자'); await page.fill('#travBody tr:nth-child(1) .t-no', 'CF1');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Gas 소재팀'); await page.fill('#travBody tr:nth-child(1) .t-p-trans', '100000');
  await page.click('#v-plan button:has-text("출장 계획 등록")'); await sleep(400);
  const cfid = await page.evaluate(() => ST.groups.find(g => g.org === '확정테스트')?.group_id);
  ok('잠정으로 생성(계획 등록)', (await page.evaluate(g => ST.groups.find(x => x.group_id === g).status, cfid)) === '계획 등록');
  // 출장 내역에서 확정
  await page.click('.nav a[data-view="list"]');
  await page.waitForSelector('#v-list table');
  await page.locator('#listBody tr').filter({ hasText: '확정테스트' }).getByRole('button', { name: '출장 확정', exact: true }).click();
  await sleep(400);
  ok('출장 확정 → 확정 예정', (await page.evaluate(g => ST.groups.find(x => x.group_id === g).status, cfid)) === '확정 예정');
  ok('확정 시 예산 선확보 증가', (await page.evaluate(() => ST.dash.commit)) > commitBefore);
  // 잠정 계획 삭제 (시드 TB-0006 SK트리켐 = 계획 등록)
  await page.evaluate(() => { window.confirm = () => true; document.getElementById('mailCard')?.remove(); });
  const delRow = page.locator('#listBody tr').filter({ hasText: 'SK트리켐' });
  if (await delRow.getByRole('button', { name: '삭제', exact: true }).count()) {
    await delRow.getByRole('button', { name: '삭제', exact: true }).click(); await sleep(400);
  }
  ok('잠정 계획 흔적 없이 삭제', !(await page.evaluate(() => ST.groups.some(g => g.org === 'SK트리켐'))));

  // 5f. [P0] 사번에 심은 스크립트가 예산담당자 '클릭' 시 실행되지 않아야 (저장형 XSS)
  await page.evaluate(() => { document.getElementById('mailCard')?.remove(); });
  const XSS_EMP = "X',alert('pwn'),'";
  await page.evaluate(async (emp) => {
    const yq = YQ, yy = yq.split('-')[0], mm = String(parseInt(yq.split('-')[1]) * 3).padStart(2, '0');
    const g = {plan_type:'계획',city:'x',org:'XSS클릭',purpose:'p',kind:'정기 Audit',
      dep_dt:`${yy}-${mm}-19`,ret_dt:`${yy}-${mm}-19`,car:'미사용',
      travelers:[{name:'공격자',emp_no:emp,rank:'TL',ccg_nm:'Gas 소재팀',p_trans:50000}]};
    const r = await fetch('/travelbudget/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(g)});
    const id = (await r.json()).group.group_id;
    await fetch(`/travelbudget/api/groups/${id}/actual`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({travelers:[{emp_no:emp,a_trans:100000}]})});
  }, XSS_EMP);
  await page.evaluate(() => load().then(() => nav('process')));
  await page.waitForSelector('#v-process.on .pgroup', { timeout: 4000 });
  await sleep(400);
  const xrow = page.locator('#v-process tr').filter({ hasText: '공격자' });
  ok('XSS 대상 행 렌더됨(조건 성립)', await xrow.count() > 0, await xrow.count());
  await xrow.getByRole('button', { name: '소재 이관', exact: true }).click();
  await sleep(700);
  ok('[P0] 사번 클릭 XSS 미실행', alerted === false);
  const inlineOnclick = await page.evaluate(() =>
    [...document.querySelectorAll('#v-process button[onclick]')].some(b => (b.getAttribute('onclick')||'').includes('alert')));
  ok('[P0] onclick에 페이로드 미삽입', inlineOnclick === false);

  // 5g. [P0] 실서버 HTTP로 CSV 다운로드 (헤더 인코딩 — test_client는 못 잡는 경로)
  const csvResp = await page.evaluate(async () => {
    const r = await fetch('/travelbudget/api/export.csv');
    return { status: r.status, cd: r.headers.get('Content-Disposition') || '', len: (await r.text()).length };
  });
  ok('[P0] 실서버 CSV 200', csvResp.status === 200 && csvResp.len > 100, csvResp);

  // 5h. [신규] 출장 내역 — 프로세스별 분류 + 일자순 + 필터/정렬/검색
  await page.evaluate(() => { document.getElementById('mailCard')?.remove(); });
  await page.click('.nav a[data-view="list"]');
  await page.waitForSelector('#v-list table', { timeout: 3000 });
  await sleep(200);
  const stageInfo = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('#listBody tr.grp-head')].map(t => t.textContent.trim().split(/\s+/)[0]);
    const stages = [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length;
    return { heads, stages };
  });
  ok('프로세스별 구분 머리행 표시', stageInfo.heads.length >= 2, stageInfo.heads);
  // 프로세스 순서가 워크플로 순서를 따르는가
  const order = await page.evaluate(() => {
    const rank = {'계획(잠정)':0,'출장 확정 · 예산 반영':1,'실적 입력·인폼':2,'소재 이관':3,'처리 완료':4,'취소':5};
    const seq = [...document.querySelectorAll('#listBody tr.grp-head .status')].map(s => rank[s.textContent.trim()]);
    return seq.every((v, i) => i === 0 || seq[i-1] <= v);
  });
  ok('프로세스 순서 = 워크플로 순', order === true);
  // 같은 프로세스 안에서 일자 순차 배열 (내림차순 기본)
  const dateSorted = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#listBody tr')];
    let cur = [], groups = [];
    rows.forEach(r => { if (r.classList.contains('grp-head')) { if (cur.length) groups.push(cur); cur = []; }
      else { const t = r.children[3]?.textContent.trim(); if (t) cur.push(t); } });
    if (cur.length) groups.push(cur);
    return groups.every(g => g.every((v, i) => i === 0 || g[i-1] >= v));
  });
  ok('프로세스 내 일자 순차 배열', dateSorted === true);
  // 검색
  await page.fill('#listFilter', '원익');
  await sleep(500);
  const searched = await page.evaluate(() => [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length);
  ok('검색 필터 동작', searched >= 1 && searched < stageInfo.stages, {searched, before: stageInfo.stages});
  // 검색이 관리 버튼 문구를 매칭하지 않아야 (예: '삭제')
  await page.fill('#listFilter', '삭제');
  await sleep(500);
  ok('검색이 버튼 문구를 매칭하지 않음', (await page.evaluate(() => [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length)) === 0);
  await page.fill('#listFilter', '');
  await sleep(400);
  // 오름/내림차순 토글
  const before = await page.evaluate(() => document.querySelector('#listBody tr:not(.grp-head):not(.empty) td:nth-child(4)')?.textContent);
  await page.click('#v-list button:has-text("내림차순")');
  await sleep(300);
  const after = await page.evaluate(() => document.querySelector('#listBody tr:not(.grp-head):not(.empty) td:nth-child(4)')?.textContent);
  ok('오름/내림차순 토글 동작', before !== after, {before, after});
  // 컬럼별 검색창 (머리글 아래) — 출장 컬럼에 '원익' 입력
  await page.fill('#v-list tr.filt th:nth-child(2) input', '원익');
  await sleep(300);
  const colFiltered = await page.evaluate(() => [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length);
  ok('컬럼별 검색창 동작', colFiltered >= 1 && colFiltered < stageInfo.stages, {colFiltered});
  // 입력 후에도 포커스가 유지되는가 (본문만 갱신)
  ok('컬럼 검색 중 포커스 유지', await page.evaluate(() =>
    document.activeElement === document.querySelector('#v-list tr.filt th:nth-child(2) input')));
  await page.fill('#v-list tr.filt th:nth-child(2) input', '');
  await sleep(300);
  // 상태 컬럼 드롭다운 — 실제 존재하는 상태로 필터
  const someStatus = await page.evaluate(() =>
    document.querySelector('#listBody tr.grp-head .status')?.textContent.trim());
  const rawStatus = someStatus === '계획(잠정)' ? '계획 등록' : someStatus;
  await page.selectOption('#v-list tr.filt th:nth-child(1) select', rawStatus);
  await sleep(300);
  const stFiltered = await page.evaluate(() => [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length);
  ok('상태 컬럼 필터 동작', stFiltered >= 1 && stFiltered <= stageInfo.stages, {rawStatus, stFiltered});
  await page.click('#v-list button:has-text("필터 해제")');
  await sleep(300);
  // 머리글 클릭 정렬 — 순수 컬럼 정렬을 보려면 '프로세스별 묶기'를 끈다
  await page.uncheck('#v-list input[type=checkbox]');
  await sleep(300);
  await page.click('#v-list th.sortable:has-text("계획")');
  await sleep(300);
  ok('머리글 클릭 정렬 표시(▲▼)', await page.evaluate(() =>
    !!document.querySelector('#v-list .sic[data-k="plan"]')?.textContent.trim()));
  const planOrder = await page.evaluate(() => {
    const v = [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty) td:nth-child(5)')]
      .map(t => Number(t.textContent.replace(/[^0-9]/g, '')) || 0);
    return v.every((x, i) => i === 0 || v[i-1] >= x);
  });
  ok('계획 금액 내림차순 정렬', planOrder === true);
  // 다시 누르면 오름차순
  await page.click('#v-list th.sortable:has-text("계획")');
  await sleep(300);
  const planAsc = await page.evaluate(() => {
    const v = [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty) td:nth-child(5)')]
      .map(t => Number(t.textContent.replace(/[^0-9]/g, '')) || 0);
    return v.every((x, i) => i === 0 || v[i-1] <= x);
  });
  ok('머리글 재클릭 → 오름차순 전환', planAsc === true);
  await page.check('#v-list input[type=checkbox]');
  await sleep(300);
  ok('프로세스별 묶기 복원', (await page.evaluate(() => document.querySelectorAll('#listBody tr.grp-head').length)) >= 2);

  // 5i. [신규] 예산 관리 — 유형 필터·검색·정렬
  await page.click('.nav a[data-view="budget"]');
  await page.waitForSelector('#v-budget table', { timeout: 3000 });
  await sleep(200);
  const bRows = () => page.evaluate(() => document.querySelectorAll('#v-budget tbody tr').length);
  const b0 = await bRows();
  await page.fill('#v-budget .filter-row input', '정기');
  await sleep(500);
  ok('예산 검색 동작', (await bRows()) <= b0, {b0, now: await bRows()});
  await page.fill('#v-budget .filter-row input', '');
  await sleep(400);
  await page.click('#v-budget button:has-text("반영일")');
  await sleep(300);
  ok('예산 정렬 토글 동작', await page.isVisible('#v-budget button:has-text("오름차순")'));

  // 5j. [신규] 센터 제출 리포트
  await page.click('.nav a[data-view="dash"]');
  await page.waitForSelector('#v-dash .hero');
  ok('대시보드 안내 문구 노출', /센터 예산 사용 중/.test(await page.textContent('#v-dash .notice .nt')));
  ok('안내 보조 문구', /반려될 수 있음/.test(await page.textContent('#v-dash .notice .ns')));
  ok('좌측 하단 버전 표기', /v\d/.test(await page.textContent('#appVer')));
  await page.click('#v-dash button:has-text("센터 제출 리포트")');
  await page.waitForSelector('#mailCard', { timeout: 4000 });
  const rptTxt = await page.textContent('#mailCard');
  ok('센터 리포트 생성', /배정/.test(rptTxt) && /소진율/.test(rptTxt), rptTxt.slice(0, 40));
  await page.click('#mailCard .mh button');

  // 5k. [수정] 예산 관리 CSV 버튼 + 리포트 CSV 버튼(ReferenceError 재발 방지)
  const errBefore = errs.length;
  await page.click('.nav a[data-view="budget"]');
  await page.waitForSelector('#v-budget table', { timeout: 3000 });
  ok('예산 관리에 예산 CSV 버튼 존재',
     await page.evaluate(() => [...document.querySelectorAll('#v-budget a,#v-budget button')].some(e => /예산 CSV/.test(e.textContent))));
  const [bdl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#v-budget a:has-text("전체 예산 CSV"), #v-budget button:has-text("전체 예산 CSV")'),
  ]);
  const bs = await bdl.createReadStream(); let bcsv = ''; for await (const ch of bs) bcsv += ch;
  ok('예산 CSV 내용 정상', bcsv.includes('누적액') && bcsv.includes('최초배정'), bcsv.slice(0, 60));
  // 센터 리포트의 CSV 버튼 — 예전엔 downloadCsv 미정의로 ReferenceError
  await page.click('.nav a[data-view="dash"]');
  await page.waitForSelector('#v-dash .hero');
  await page.click('#v-dash button:has-text("센터 제출 리포트")');
  await page.waitForSelector('#mailCard', { timeout: 4000 });
  const [rdl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#mailCard a:has-text("예산 CSV"), #mailCard button:has-text("예산 CSV")'),
  ]);
  ok('리포트 예산 CSV 동작', !!rdl);
  ok('CSV 클릭에서 JS 에러 없음', errs.length === errBefore, errs.slice(errBefore, errBefore + 2));
  await page.click('#mailCard .mh button');

  // 6. Mobile 390 no horizontal overflow on dashboard
  const mp = await ctx.newPage();
  await mp.setViewportSize({ width: 390, height: 800 });
  await mp.goto(base, { waitUntil: 'networkidle' });
  await mp.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('모바일 390px 가로 오버플로 없음', overflow <= 2, overflow);

  /* ── 16. 입력 사용성 (금액 천단위·기간 경고·엔터 제출·인폼 재발행·키보드) ── */
  console.log('\n-- 16. 입력 사용성 --');
  await page.click('.nav a[data-view="plan"]');
  await page.waitForSelector('#pl_city');
  await page.fill('#travBody tr:nth-child(1) .t-p-trans', '1250000');
  ok('금액칸 천단위 자동 구분', (await page.inputValue('#travBody tr:nth-child(1) .t-p-trans')) === '1,250,000',
     await page.inputValue('#travBody tr:nth-child(1) .t-p-trans'));
  ok('천단위 표시여도 합계는 숫자로 집계', (await page.textContent('#travBody tr:nth-child(1) .t-sum')) === '1,250,000',
     await page.textContent('#travBody tr:nth-child(1) .t-sum'));
  const yq2 = await page.evaluate(() => YQ); const [y2, q2] = yq2.split('-');
  const m2 = String(parseInt(q2) * 3).padStart(2, '0');
  await page.fill('#pl_dep', `${y2}-${m2}-20`); await page.fill('#pl_ret', `${y2}-${m2}-18`);
  ok('복귀일<출발일 즉시 경고', (await page.isVisible('#plDateWarn')) &&
     (await page.textContent('#plDateWarn')).includes('빠릅니다'), await page.textContent('#plDateWarn'));
  await page.fill('#pl_ret', `${y2}-${m2}-21`);
  ok('기간 정정 시 경고 사라짐', !(await page.isVisible('#plDateWarn')));

  await page.fill('#pl_city', '엔터시'); await page.fill('#pl_org', '엔터제출테스트');
  await page.fill('#pl_purpose', '엔터키 제출 확인');
  await page.fill('#travBody tr:nth-child(1) .t-nm', '엔터');
  await page.fill('#travBody tr:nth-child(1) .t-no', 'EN1');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Gas 소재팀');
  await page.press('#pl_city', 'Enter');
  await sleep(600);
  const eg = await page.evaluate(() => ST.groups.find(g => g.org === '엔터제출테스트'));
  ok('입력칸에서 엔터 = 제출', !!eg && eg.travelers[0].p_trans === 1250000, eg && eg.travelers[0].p_trans);
  ok('등록 직후 다음 할 일 안내 노출', await page.isVisible('#v-plan .card.just'));
  ok('안내에 확정/실적 이동 버튼', (await page.textContent('#v-plan .card.just')).includes('출장 확정하기')
     && (await page.textContent('#v-plan .card.just')).includes('출장 실적 입력'));
  const filterEnter = await page.evaluate(() => {
    nav('actual'); const el = document.querySelector('#actFilter'); return !!el && !!el.closest('.filter-row');
  });
  ok('검색칸 엔터는 제출 제외', filterEnter);

  // 인폼 카드를 닫아도 다시 열 수 있어야 (실적 입력자 관점 핵심 동선)
  await page.evaluate(() => document.getElementById('mailCard')?.remove());
  await page.click('.nav a[data-view="actual"]');
  await page.waitForSelector('#actSel');
  await page.selectOption('#actSel', eg.group_id);
  await page.waitForSelector('#actRows tr');
  await page.fill('#actRows tr:nth-child(1) .a-trans', '1180000');
  ok('실적칸도 천단위 자동 구분', (await page.inputValue('#actRows tr:nth-child(1) .a-trans')) === '1,180,000',
     await page.inputValue('#actRows tr:nth-child(1) .a-trans'));
  await page.click('#actBody button:has-text("실적 저장 및 인폼 생성")');
  await page.waitForSelector('#mailCard', { timeout: 5000 });
  await page.evaluate(() => document.getElementById('mailCard')?.remove());   // 사용자가 카드를 닫음
  await page.selectOption('#actSel', eg.group_id);
  await page.waitForSelector('#actBody button:has-text("인폼 다시 보기")', { timeout: 3000 });
  await page.click('#actBody button:has-text("인폼 다시 보기")');
  await page.waitForSelector('#mailCard', { timeout: 4000 });
  const reHtml = await page.innerHTML('#mailCard .body');
  ok('닫은 인폼을 실적 화면에서 재발행', reHtml.includes('엔터') && reHtml.includes('1,180,000'), reHtml.slice(0, 60));
  await page.evaluate(() => document.getElementById('mailCard')?.remove());
  await page.click('.nav a[data-view="list"]');
  await page.waitForSelector('#listBody');
  await page.click(`#listBody button:has-text("인폼 보기") >> nth=0`);
  await page.waitForSelector('#mailCard', { timeout: 4000 });
  ok('출장 내역에서 인폼 재발행', await page.isVisible('#mailCard'));
  await page.evaluate(() => document.getElementById('mailCard')?.remove());

  // 접근성
  const a11y = await page.evaluate(() => {
    const nv = document.querySelector('.nav a');
    const labs = [...document.querySelectorAll('#v-plan label[for]')]
      .filter(l => document.getElementById(l.htmlFor)).length;
    return { tab: nv.tabIndex, role: nv.getAttribute('role'), labs };
  });
  ok('좌측 메뉴 키보드 접근 가능', a11y.tab === 0 && a11y.role === 'link', a11y);
  ok('계획 폼 label[for] 연결', a11y.labs >= 8, a11y.labs);
  await page.evaluate(() => document.querySelector('.nav a[data-view="dash"]').focus());
  await page.keyboard.press('Enter');
  ok('메뉴 엔터로 화면 전환', (await page.evaluate(() => VIEW)) === 'dash');

  /* ── 17. 관리자 메뉴의 Qwen 변환 프롬프트 ── */
  console.log('\n-- 17. Qwen 변환 프롬프트 --');
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.click('.nav a[data-view="data"]');
  await page.waitForSelector('#qwToggle', { timeout: 4000 });
  ok('데이터 관리에 변환 프롬프트 카드', await page.isVisible('button:has-text("변환 프롬프트 복사")'));
  ok('프롬프트 기본은 접힘', !(await page.isVisible('#qwBox')));
  await page.click('#qwToggle');
  await page.waitForSelector('#qwBox', { state: 'visible', timeout: 3000 });
  const shown = await page.textContent('#qwBox');
  ok('펼치면 프롬프트 본문 표시', shown.length > 3000 && shown.includes('[원본 데이터]'), shown.length);
  ok('펼친 뒤 버튼 문구 전환', (await page.textContent('#qwToggle')) === '접기');
  const boxOverflow = await page.evaluate(() => {
    const b = document.getElementById('qwBox');
    return { h: Math.round(b.getBoundingClientRect().height), scrolls: b.scrollHeight > b.clientHeight,
             pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  ok('프롬프트 박스가 페이지를 밀지 않음', boxOverflow.h <= 430 && boxOverflow.pageOverflow <= 2, boxOverflow);
  await page.click('button:has-text("변환 프롬프트 복사")');
  await sleep(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  ok('복사된 내용이 프롬프트 전문', clip.includes('당신은 사내 출장비 데이터 변환기입니다')
     && clip.includes('Gas 소재팀') && clip.includes('실적 입력·인폼')
     && clip.includes('[원본 데이터]') && clip.length > 3000, clip.length);
  ok('복사본에 자동계산 필드 금지 규칙 포함', clip.includes('출력하지 마세요'));
  await page.click('button:has-text("투입 전 검증 명령 복사")');
  await sleep(400);
  const clip2 = await page.evaluate(() => navigator.clipboard.readText());
  ok('검증 명령 복사', clip2.includes('validate_group') && clip2.includes('검증 실패'), clip2.slice(0, 40));
  await page.click('#qwToggle');
  ok('다시 접힘', !(await page.isVisible('#qwBox')));

  /* ── 18. v9.8 — 글꼴·대시보드 도식화·드래그 인폼·엑셀 일괄 등록 ── */
  console.log('\n-- 18. v9.8 개선 --');
  const fam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  ok('본문 글꼴 맑은 고딕 우선(윈도우 혼용 방지)', /^"?Malgun Gothic/.test(fam), fam);
  const proseFonts = await page.evaluate(() => [...new Set([...document.querySelectorAll('body *')]
    .map(e => getComputedStyle(e).fontFamily))].filter(f => !/monospace/.test(f)));
  ok('본문 글꼴 스택 1종', proseFonts.length === 1, proseFonts);

  await page.evaluate(() => { document.getElementById('mailCard')?.remove(); nav('dash'); });
  await sleep(200);
  ok('대시보드 CCG 막대 도식', (await page.$$('#v-dash .bars .brow')).length > 0);
  ok('막대 범례 3색(완료/처리중/확정)', (await page.$$('#v-dash .lgd i')).length === 3);
  const refTxt = await page.textContent('#v-dash .ref');
  ok('잠정은 표에서 빼고 참고로만 표기', refTxt.includes('잠정 계획') && refTxt.includes('반영되지 않'), refTxt.slice(0, 40));
  const ccgTh = await page.$$eval('#v-dash .fold th', e => e.map(x => x.textContent.trim()));
  ok('CCG 금액표에 잠정계획 열 없음', !ccgTh.includes('잠정계획'), ccgTh);
  ok('CCG 금액표는 기본 접힘', !(await page.isVisible('#v-dash .fold table')));

  // 인폼 카드 — Outlook 제거 · 드래그 · 접기(하단 버튼 가림 방지)
  const mgid = await page.evaluate(() => ST.groups.find(g => g.act_tot > 0)?.group_id);
  await page.evaluate(g => reopenMail(g), mgid);
  await page.waitForSelector('#mailCard', { timeout: 4000 });
  ok('Outlook 열기 버튼 없음', !(await page.$('#mailOpen')));
  ok('드래그 안내 노출', (await page.textContent('#mailCard .how')).includes('끌어다'));
  ok('본문이 draggable', (await page.getAttribute('#mailBody', 'draggable')) === 'true');
  const hBefore = await page.evaluate(() => document.getElementById('mailCard').getBoundingClientRect().height);
  await page.click('#mailCard .mh button[title="접기 / 펼치기"]');
  await sleep(150);
  const hAfter = await page.evaluate(() => document.getElementById('mailCard').getBoundingClientRect().height);
  ok('접으면 제목줄만 남음(하단 버튼 가림 해소)', hAfter < 60 && hAfter < hBefore / 3, {hBefore, hAfter});
  await page.evaluate(() => document.getElementById('mailCard')?.remove());

  // 엑셀 일괄 등록
  await page.click('.nav a[data-view="bulk"]');
  await page.waitForSelector('#bkText');
  await page.click('button:has-text("예시 넣어보기")');
  await sleep(400);
  const bkPrev = await page.textContent('#bkOut');
  ok('붙여넣기 → 동행자 묶어 미리보기', bkPrev.includes('2건') && bkPrev.includes('3명'), bkPrev.slice(0, 50));
  const nBefore = await page.evaluate(() => ST.groups.length);
  await page.click('#bkGo');
  await sleep(2500);
  ok('일괄 등록 2건 저장', (await page.evaluate(() => ST.groups.length)) - nBefore === 2);
  const bulkG = await page.evaluate(() => ST.groups.find(g => g.org === '원익머트리얼즈' && g.travelers.length === 2));
  ok('동행 2인 1건 · CCG 인식 · 콤마 금액 파싱', bulkG && bulkG.plan_tot === 460000, bulkG && bulkG.plan_tot);
  ok('일괄 등록은 기본 잠정(예산 미반영)', bulkG && bulkG.status === '계획 등록', bulkG && bulkG.status);
  // 잘못된 붙여넣기는 행 번호로 알려준다
  await page.fill('#bkText', '구분\tCCG명\t사번\t성명\t출장도시\t출장기관&업체\t출장목적&사유\t출발일자\n계획\t없는팀\t9\t홍\t\t\t\t');
  await sleep(300);
  ok('오류 행을 번호로 안내', (await page.textContent('#bkOut')).includes('2행'), (await page.textContent('#bkOut')).slice(0, 60));

  // 사용법 중복 제거 — 화면은 요약 + 인쇄용 링크 하나
  await page.click('.nav a[data-view="guide"]');
  await page.waitForSelector('#v-guide.on .g-lead');
  ok('화면 안내에 인쇄용 링크', await page.isVisible('#v-guide a[href="/travelbudget/guide"]'));
  const gLen = (await page.textContent('#v-guide')).length;
  ok('화면 안내는 요약(장문 중복 아님)', gLen < 2100, gLen);

  // ignore external-CDN load failures (sandbox blocks them); we only care about code errors
  const codeErrs = errs.filter(e => !/ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource/.test(e));
  ok('콘솔 JS 에러 없음 (외부 CDN 제외)', codeErrs.length === 0, codeErrs.slice(0, 3));
  const cdnBlocked = errs.some(e => /Failed to load resource|ERR_TUNNEL/.test(e));
  ok('외부 폰트 CDN 미의존 (사내망 안전)', !cdnBlocked, '외부 CDN 로드 실패 감지 — self-host 필요');
} catch (e) {
  console.log('  FAIL  E2E 예외 -> ' + (e && e.stack || e));
  F++;
} finally {
  if (browser) await browser.close();
  srv.kill('SIGKILL');
}
console.log(`\n${'='.repeat(48)}\n  브라우저 E2E  ${P} passed / ${F} failed\n${'='.repeat(48)}`);
process.exit(F ? 1 : 0);
