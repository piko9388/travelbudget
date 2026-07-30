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
  // v10 — hero 공식 텍스트 + KPI 카드 4장을 '구성 막대' 하나로 합침(같은 숫자 중복 제거)
  const heroTxt = await page.textContent('#v-dash .hero');
  ok('대시보드 hero 렌더', heroTxt.includes('가용 잔여') && heroTxt.includes('총 예산'), heroTxt.slice(0, 60));
  const keys = await page.$$eval('#v-dash .hero .skey span', e => e.map(x => x.textContent.trim()));
  ok('예산 구성 막대 범례 = 완료·처리중·확정·가용',
     keys.length === 4 && keys[0].includes('처리 완료') && keys[3].includes('가용 잔여'), keys);
  ok('구성 막대 세그먼트 표시', (await page.$$('#v-dash .hero > .stack i')).length === 4);
  ok('KPI 카드 제거(중복 숫자 없음)', !(await page.$('#v-dash .kpis')));
  const dupe = await page.evaluate(() => {
    const h = document.querySelector('#v-dash .hero').cloneNode(true);
    h.querySelector('.hnote')?.remove();          // 안내 문장의 참조는 지표 중복이 아님
    h.querySelector('.ghost .gl')?.remove();      // 잠정 참고 막대의 설명 문장도 지표가 아님
    const t = h.textContent;
    return ['총 예산', '처리 완료', '처리 중', '확정 예정'].map(k => [k, t.split(k).length - 1]);
  });
  ok('네 항목이 각각 1회만 노출', dupe.every(([, n]) => n === 1), dupe);
  // 잠정 계획은 예산에 안 잡히므로 위 막대에 섞지 않고 아래 참고 막대(또는 문장)로만 표기
  const ghostTxt = await page.textContent('#v-dash .ghost, #v-dash .hnote');
  ok('잠정은 예산 미반영으로 안내', ghostTxt.includes('반영되지 않습니다'), ghostTxt.slice(0, 40));
  const ghostBar = await page.evaluate(() => {
    const g = document.querySelector('#v-dash .ghost .stack i');
    if (!g) return null;
    const pct = parseFloat(g.style.width);
    return { pct, tot: ST.dash.alloc, plan: ST.dash.planAmt };
  });
  ok('잠정 참고 막대가 총 예산과 같은 축',
     !ghostBar || Math.abs(ghostBar.pct - ghostBar.plan / ghostBar.tot * 100) < 0.05, ghostBar);
  ok('잠정은 예산 막대에 섞이지 않음', await page.evaluate(() => {
    const segs = [...document.querySelectorAll('#v-dash .hero > .stack i')];
    return segs.every(i => !/s-plan|잠정/.test(i.className + (i.title || '')));
  }));

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
  const navOrder = await page.$$eval('.nav a[data-view]', e => e.map(x => x.dataset.view));
  ok('첫 메뉴 = 첫 화면(대시보드)', navOrder[0] === 'dash', navOrder);
  ok('도움말은 맨 아래', navOrder[navOrder.length - 1] === 'guide', navOrder);
  ok('4단계 스텝 표시', (await page.$$('#v-guide .gstep')).length === 5, (await page.$$('#v-guide .gstep')).length);
  ok('처리 흐름 공식 노출', /가용 잔여 = 총 예산 − 처리 완료 − 처리 중 − 확정 예정/.test(await page.textContent('#v-guide .g-formula')));
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
  ok('대시보드 소진율(%) 노출', /소진율\s*\d+%/.test(await page.textContent('#v-dash .hright')));
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
  await page.waitForSelector('#v-dash .hero .stack');
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
  ok('대시보드 CCG 막대 도식', (await page.$$('#v-dash .card > .bars .brow')).length > 0);
  ok('막대 범례 3색(완료/처리중/확정)', (await page.$$('#v-dash .lgd i')).length === 3);
  const refTxt = await page.textContent('#v-dash .ref');
  // 잠정 설명은 예산 hero 한 곳에만 (v10.0 이전엔 hero·CCG 두 곳에 같은 문장이 찍혔다)
  ok('CCG 참고줄은 건수·인원만', refTxt.includes('실제 출장') && refTxt.includes('참여 인원'), refTxt.slice(0, 40));
  const planSent = await page.evaluate(() =>
    [...document.querySelectorAll('#v-dash')].map(x => x.textContent)
      .join('').split('예산에 반영되지 않').length - 1);
  ok('“예산 미반영” 문장 중복 없음', planSent === 1, planSent);

  // 비목 구성 — CCG(누가) 다음 축(무엇에). 합계는 위 막대와 같아야 한다
  const cost = await page.evaluate(() => {
    const wrap = document.querySelector('#v-dash .cost');
    if (!wrap) return null;
    const keys = [...wrap.querySelectorAll('.brow .bnm')].map(x => x.textContent.trim());
    const sum = +(wrap.querySelector('.ct').textContent.match(/([\d,]+)원/) || [0, '0'])[1].replace(/,/g, '');
    const segs = [...wrap.querySelectorAll('.brow .bbar i')].length;
    const hues = [...wrap.querySelectorAll('.brow .bbar i')]
      .map(i => getComputedStyle(i).backgroundColor);
    return { keys, sum, segs, hues: [...new Set(hues)] };
  });
  ok('비목 구성 렌더', !!cost && cost.segs > 0, cost);
  ok('비목 항목 = 교통·숙박·식대·기타',
     cost.keys.every(k => /교통비|숙박비|식대&잡비|기타/.test(k)), cost.keys);
  // 비목은 범주형 — 색으로 나누면 단계 음영과 헷갈리므로 전부 같은 색이어야 한다
  ok('비목은 단색 (단계 음영과 혼동 금지)', cost.hues.length === 1, cost.hues);
  const barSum = await page.evaluate(() => {
    const t = document.querySelector('#v-dash .hero .skey').textContent;
    const n = [...t.matchAll(/([\d,]+)/g)].map(m => +m[1].replace(/,/g, ''));
    return n[0] + n[1] + n[2];        // 처리완료 + 처리중 + 확정예정
  });
  ok('비목 합계 = 예산 막대 집행 합계', cost.sum === barSum, { cost: cost.sum, bar: barSum });
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
  ok('화면 안내는 요약(장문 중복 아님)', gLen < 2600, gLen);

  /* ── 19. v10 회귀 방지 — CSS 삭제·구성비 축·사이드바 구조 ── */
  console.log('\n-- 19. v10 회귀 방지 --');
  // 센터 제출 리포트가 쓰는 .kpi 스타일이 살아 있는가 (대시보드에서 KPI를 뺄 때 함께 지워졌던 회귀)
  await page.evaluate(() => { document.getElementById('mailCard')?.remove(); nav('dash'); });
  await page.waitForSelector('#v-dash button:has-text("센터 제출 리포트")');
  await page.click('#v-dash button:has-text("센터 제출 리포트")');
  await page.waitForSelector('.mailcard .kpis', { timeout: 5000 });
  const kpiCss = await page.evaluate(() => {
    const g = getComputedStyle(document.querySelector('.mailcard .kpis'));
    const b = document.querySelector('.mailcard .kpi b');
    const sp = document.querySelector('.mailcard .kpi span');
    return { display: g.display, cols: g.gridTemplateColumns.split(' ').length,
             bDisp: getComputedStyle(b).display, bSize: getComputedStyle(b).fontSize,
             spDisp: getComputedStyle(sp).display };
  });
  ok('리포트 KPI 그리드 살아있음', kpiCss.display === 'grid' && kpiCss.cols === 4, kpiCss);
  ok('리포트 KPI 라벨·숫자 줄바꿈', kpiCss.spDisp === 'block' && kpiCss.bDisp === 'block', kpiCss);
  ok('리포트 KPI 숫자 크기 적용', parseFloat(kpiCss.bSize) >= 18, kpiCss.bSize);
  await page.evaluate(() => document.getElementById('mailCard')?.remove());

  // CCG 구성비 — 합계와 같은 축이어야 (확정만 있는 팀이 금액은 있는데 0% 로 찍히던 문제)
  await page.evaluate(() => nav('dash'));
  await page.waitForSelector('#v-dash .card > .bars .brow');
  const shares = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#v-dash .card > .bars .brow')].map(r => {
      const t = r.querySelector('.bval').textContent;
      const m = t.match(/([\d,]+)\s*(\d+)%/);
      return m ? { amt: +m[1].replace(/,/g, ''), pct: +m[2] } : null;
    }).filter(Boolean);
    return rows;
  });
  ok('금액이 있는데 0% 인 팀 없음', shares.every(r => !(r.amt > 0 && r.pct === 0)), shares);
  ok('구성비 합 ≈ 100%', Math.abs(shares.reduce((a, r) => a + r.pct, 0) - 100) <= shares.length, 
     shares.reduce((a, r) => a + r.pct, 0));

  // 사이드바 DOM — nav/div 태그 짝, 활성 표시, 외부 링크 위계
  const navDom = await page.evaluate(() => {
    const main = document.querySelector('nav.nav[aria-label]');
    const on = document.querySelector('.nav a.on');
    const ext = document.querySelector('.nav a.ext');
    return { hasLandmark: !!main, ariaCurrent: on && on.getAttribute('aria-current'),
             onWeight: on && getComputedStyle(on).fontWeight,
             extWeight: ext && getComputedStyle(ext).fontWeight,
             utilLast: !!document.querySelector('.nav.util') };
  });
  ok('주 메뉴에 nav 랜드마크', navDom.hasLandmark, navDom);
  ok('활성 항목 aria-current=page', navDom.ariaCurrent === 'page', navDom);
  ok('외부 링크가 활성 항목보다 가벼움',
     Number(navDom.extWeight) < Number(navDom.onWeight), navDom);
  ok('도움말 유틸 그룹 분리', navDom.utilLast);

  // 레이아웃 — 사이드바와 본문이 정말 좌우로 붙어 있는가
  // (nav 를 </div> 로 닫으면 파서가 aside 와 .app 까지 함께 닫아 main 이 그리드 밖으로 밀려난다.
  //  DOM·CSS·기능 테스트는 전부 통과하므로 실제 좌표로 확인한다)
  const lay = await page.evaluate(() => {
    const app = document.querySelector('.app'), a = document.querySelector('aside'), m = document.querySelector('main');
    const ra = a.getBoundingClientRect(), rm = m.getBoundingClientRect();
    return { appHasAside: app.contains(a), appHasMain: app.contains(m),
             asideInAside: !!a.querySelector('.nav.util') && !!a.querySelector('.contact'),
             display: getComputedStyle(app).display,
             cols: getComputedStyle(app).gridTemplateColumns.split(' ').length,
             sideBySide: ra.right <= rm.left + 1 && rm.top < ra.bottom };
  });
  ok('.app 안에 aside·main 둘 다', lay.appHasAside && lay.appHasMain, lay);
  ok('도움말·연락처가 aside 안에 남아있음', lay.asideInAside, lay);
  ok('.app 2열 그리드 유지', lay.display === 'grid' && lay.cols === 2, lay);
  ok('사이드바와 본문이 좌우 배치', lay.sideBySide, lay);

  /* ── 20. 단계 음영 팔레트 — 단계는 진하기로, 신호는 색으로 ── */
  console.log('\n-- 20. 단계 음영 팔레트 --');
  await page.evaluate(() => nav('guide'));
  await page.waitForSelector('#v-guide.on .glegend .status');
  const pal = await page.evaluate(() => {
    const px = s => (s.match(/\d+/g) || []).map(Number);
    const lin = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
    const cr = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
                           return (hi + .05) / (lo + .05); };
    const hue = ([r, g, b]) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (d < 8) return null;                      // 무채색 — 색상 판정 대상 아님
      let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    const pick = sel => {
      const el = document.querySelector(sel);
      const s = getComputedStyle(el);
      const bg = px(s.backgroundColor), fg = px(s.color);
      return { sel, bg, fg, lum: lum(bg), hue: hue(bg), text: cr(bg, fg) };
    };
    const stages = ['#v-guide .glegend .status:not([class*=" "])',
                    '#v-guide .glegend .status.confirm',
                    '#v-guide .glegend .status.wip',
                    '#v-guide .glegend .status.done'].map(pick);
    // 대시보드 막대 4칸도 같은 램프인지
    const segs = [...document.querySelectorAll('#v-dash .hero > .stack i')].map(i => {
      const bg = px(getComputedStyle(i).backgroundColor);
      return { lum: lum(bg), hue: hue(bg) };
    });
    return { stages, segs };
  });
  const st = pal.stages;
  ok('배지 4단계가 점점 진해짐 (계획→확정→처리중→완료)',
     st.every((x, i) => i === 0 || x.lum < st[i - 1].lum), st.map(x => x.lum.toFixed(3)));
  const hues = st.map(x => x.hue).filter(h => h !== null);
  ok('배지 4단계가 같은 색상(hue) — 무관한 범주로 안 읽히게',
     hues.length > 0 && Math.max(...hues) - Math.min(...hues) < 25, hues.map(h => Math.round(h)));
  ok('배지 글씨 대비 전부 AA', st.every(x => x.text >= 4.5), st.map(x => x.text.toFixed(2)));
  // 녹(정상)·황(경과)·적(초과)은 신호 전용 — 단계 배지에 쓰이면 안 된다
  const SIGNAL = h => (h > 60 && h < 200) || h < 40;
  ok('단계 배지에 신호색(녹·황·적) 없음', hues.every(h => !SIGNAL(h)), hues.map(h => Math.round(h)));

  await page.evaluate(() => nav('dash'));
  await page.waitForSelector('#v-dash .hero > .stack i');
  const segs = pal.segs;
  ok('예산 막대 4칸이 점점 옅어짐 (완료→처리중→확정→가용)',
     segs.length >= 2 && segs.every((x, i) => i === 0 || x.lum > segs[i - 1].lum),
     segs.map(x => x.lum.toFixed(3)));
  const segHues = segs.map(x => x.hue).filter(h => h !== null);
  ok('예산 막대도 같은 색상(hue)',
     segHues.length === 0 || Math.max(...segHues) - Math.min(...segHues) < 25,
     segHues.map(h => Math.round(h)));

  /* ── 21. 입력 칸 겹침 — 좁은 화면에서 표가 무너지지 않는가 ── */
  console.log('\n-- 21. 입력 칸 겹침 --');
  // 첫 칸 고정(sticky)을 쓰면 가로 스크롤 시 뒷칸 위로 올라와 사번·직책이 성명 밑으로 사라졌다.
  // 좌표를 직접 재서 막는다 — CSS 단언으로는 잡히지 않는 종류의 결함이다.
  const overlapAt = async (w, view, prep) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(v => nav(v), view);
    if (prep) await prep();
    await sleep(250);
    return page.evaluate(() => {
      const root = document.querySelector('.view.on');
      const sc = root.querySelector('.trav-table');
      if (!sc) return null;
      sc.scrollLeft = 200;                       // 스크롤된 상태에서 재는 것이 핵심
      const hit = [];
      for (const tr of root.querySelectorAll('table tr')) {
        const cells = [...tr.children].map(c => c.getBoundingClientRect()).filter(r => r.width > 0);
        for (let i = 0; i < cells.length - 1; i++) {
          const ox = Math.min(cells[i].right, cells[i + 1].right) - Math.max(cells[i].left, cells[i + 1].left);
          if (ox > 1) hit.push(Math.round(ox));
        }
      }
      return { hit, minW: sc.querySelector('table').scrollWidth, avail: sc.clientWidth };
    });
  };
  const addRows = async () => { for (let i = 0; i < 2; i++) await page.click('button:has-text("+ 동행자 추가")'); };
  for (const w of [1920, 1440, 1280, 1152, 1024]) {
    const r = await overlapAt(w, 'plan', w === 1920 ? addRows : null);
    ok(`계획 등록 ${w}px — 칸 겹침 없음`, r && r.hit.length === 0, r && r.hit.slice(0, 4));
    if (w >= 1152) ok(`계획 등록 ${w}px — 가로 스크롤 없음`, r.minW <= r.avail + 1, r);
  }
  // 실적 입력 표도 같은 기준
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => nav('actual'));
  await page.waitForSelector('#actSel');
  const anyGid = await page.evaluate(() => { const o = [...$('#actSel').options].find(x => x.value); return o && o.value; });
  if (anyGid) {
    await page.selectOption('#actSel', anyGid);
    await page.waitForSelector('#actRows tr');
    const ra = await overlapAt(1152, 'actual');
    ok('실적 입력 1152px — 칸 겹침 없음', ra && ra.hit.length === 0, ra && ra.hit.slice(0, 4));
  }
  // CCG No. 는 팀을 고르면 자동으로 채워지는 읽기전용 값 — 열을 차지하지 않고 팀 칸 안에 표기
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => nav('plan'));
  await page.waitForSelector('#travBody tr');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Gas 소재팀');
  const ccg = await page.evaluate(() => {
    const tr = document.querySelector('#travBody tr');
    return { hidden: tr.querySelector('.t-cc').value, shown: tr.querySelector('.t-cc-v').textContent.trim(),
             cols: document.querySelectorAll('#v-plan thead tr:first-child th').length };
  });
  ok('CCG 코드 자동 채움 유지', ccg.hidden === 'C1202' && ccg.shown === 'C1202', ccg);
  ok('CCG No. 전용 열 없음(팀 칸 안 표기)',
     !(await page.textContent('#v-plan thead')).includes('CCG No.'), ccg.cols);

  // 금액칸은 두 표에서 같은 크기 — 폭을 안 잡으면 열이 적은 실적 표에서 혼자 늘어난다
  const planMn = await page.evaluate(() =>
    Math.round(document.querySelector('#travBody .w-mn').getBoundingClientRect().width));
  await page.evaluate(() => nav('actual'));
  await page.waitForSelector('#actRows .w-mn');
  const actMn = await page.evaluate(() =>
    Math.round(document.querySelector('#actRows .w-mn').getBoundingClientRect().width));
  // 계획 표는 10열이라 1440px 에서 금액칸이 상한(110px)까지 못 간다 — 완전 동일은 불가능.
  // 막으려는 것은 '한쪽만 두 배로 늘어나는' 상태다(고치기 전 실적 195 vs 계획 110).
  ok('계획·실적 금액칸 폭이 서로 어긋나지 않음',
     Math.abs(planMn - actMn) <= 12, { plan: planMn, actual: actMn });
  ok('금액칸이 과도하게 늘어나지 않음', actMn <= 112, actMn);

  /* ── 22. v10.3 — 막대 축·큐·배지 중복 ── */
  console.log('\n-- 22. 막대 축 · 큐 · 배지 중복 --');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => nav('dash'));
  await page.waitForSelector('#v-dash .card > .bars .brow');
  // 막대 폭과 옆의 % 라벨이 같은 분모를 써야 한다.
  // 최댓값 정규화였을 때 '34%' 라벨 옆에서 막대가 가로를 꽉 채워 그림이 숫자와 반대였다.
  const axis = await page.evaluate(() => {
    const read = sel => [...document.querySelectorAll(sel)].map(r => {
      const w = parseFloat(r.querySelector('.bbar i').style.width) || 0;
      const seg = [...r.querySelectorAll('.bbar i')]
        .reduce((a, i) => a + (parseFloat(i.style.width) || 0), 0);
      const m = r.querySelector('.bval').textContent.match(/(\d+)%/);
      return { seg: +seg.toFixed(1), pct: m ? +m[1] : null, first: w };
    });
    return { ccg: read('#v-dash .card > .bars .brow'), cost: read('#v-dash .cost .brow') };
  });
  const axisOk = rows => rows.length > 0 && rows.every(r => r.pct != null && Math.abs(r.seg - r.pct) <= 1.2);
  ok('CCG 막대 폭 = 구성비 라벨', axisOk(axis.ccg), axis.ccg);
  ok('비목 막대 폭 = 구성비 라벨', axisOk(axis.cost), axis.cost);
  ok('막대가 라벨보다 부풀지 않음',
     [...axis.ccg, ...axis.cost].every(r => r.seg <= 100.5), [...axis.ccg, ...axis.cost].map(r => r.seg));

  // 바로 할 일 — 건수가 아니라 큐. 각 행이 특정 건을 가리키고 그 건으로 이동해야 한다.
  const q = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#v-dash .qrow')];
    return rows.map(r => ({
      kind: r.querySelector('.qk').textContent.trim(),
      name: r.querySelector('.qnm').textContent.trim().slice(0, 20),
      d: r.querySelector('.qd').textContent.trim(),
      go: r.querySelector('button').getAttribute('onclick'),
    }));
  });
  ok('바로 할 일이 행 큐', q.length > 0, q.length);
  ok('각 행이 특정 group_id 로 이동', q.every(r => /^open(Actual|Process)\('TB-[0-9A-Fa-f]+'\)$/.test(r.go)), q.map(r => r.go));
  ok('경과일 표시', q.every(r => /^(D\+\d+|–)$/.test(r.d)), q.map(r => r.d));
  const dnums = q.map(r => r.d.startsWith('D+') ? +r.d.slice(2) : -1);
  ok('오래 묵은 건이 위로', dnums.every((v, i) => i === 0 || v <= dnums[i - 1]), dnums);
  ok('건수만 적힌 버튼 없음',
     !/대기 \d+건 →/.test(await page.textContent('#v-dash')), '건수 버튼 잔존');

  // 딥링크 — 큐에서 누른 그 건이 실적 화면에서 선택돼 있어야 한다
  const actRow = q.find(r => r.go.startsWith('openActual'));
  if (actRow) {
    const gid = actRow.go.match(/'(TB-\d+)'/)[1];
    await page.evaluate(g => openActual(g), gid);
    await page.waitForSelector('#actRows tr', { timeout: 4000 });
    const sel = await page.inputValue('#actSel');
    ok('큐 → 실적 입력 딥링크 (그 건이 선택됨)', sel === gid, { want: gid, got: sel });
  }

  // 묶기 모드에서 행 배지가 머리행과 중복되지 않아야 한다
  await page.evaluate(() => nav('list'));
  await page.waitForSelector('#listBody tr');
  const dup = await page.evaluate(() => {
    const grouped = document.querySelector('#listGroup')?.checked ?? true;
    const heads = document.querySelectorAll('#listBody tr.grp-head').length;
    const rowBadges = [...document.querySelectorAll('#listBody tr:not(.grp-head) td:first-child .status')]
      .filter(b => !b.classList.contains('urgent')).length;
    return { grouped, heads, rowBadges };
  });
  ok('묶기 모드: 머리행 존재', dup.heads > 0, dup);
  ok('묶기 모드: 행 배지 중복 없음', !dup.grouped || dup.rowBadges === 0, dup);
  // 묶기를 끄면 행마다 상태를 알 수 있어야 한다
  await page.evaluate(() => toggleGroup(false));
  await sleep(200);
  const ung = await page.evaluate(() => ({
    heads: document.querySelectorAll('#listBody tr.grp-head').length,
    rowBadges: [...document.querySelectorAll('#listBody tr td:first-child .status')]
      .filter(b => !b.classList.contains('urgent')).length,
  }));
  ok('묶기 해제: 행마다 상태 배지', ung.heads === 0 && ung.rowBadges > 0, ung);
  await page.evaluate(() => toggleGroup(true));

  // 단계 램프 — 제일 헷갈리는 쌍(처리 중 ↔ 확정 예정)이 가장 넓게 벌어져야 한다
  const chain = await page.evaluate(() => {
    const px = s => (s.match(/\d+/g) || []).map(Number);
    const lin = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
    const lum = ([r, g, b]) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
    const cr = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); };
    const c = n => px(getComputedStyle(document.querySelector(n)).backgroundColor);
    const probe = document.createElement('div');
    document.body.appendChild(probe);
    const tok = t => { probe.style.background = `var(${t})`; return px(getComputedStyle(probe).backgroundColor); };
    const [s1, s2, s3, tr] = ['--s1', '--s2', '--s3', '--track'].map(tok);
    probe.remove();
    return { a: cr(s1, s2), b: cr(s2, s3), c: cr(s3, tr) };
  });
  ok('막대 사슬 인접 대비 2.0 이상', Math.min(chain.a, chain.b, chain.c) >= 2.0,
     { '완료|처리중': +chain.a.toFixed(2), '처리중|확정': +chain.b.toFixed(2), '확정|가용': +chain.c.toFixed(2) });
  ok('가장 헷갈리는 쌍(처리중|확정)이 제일 넓음', chain.b > chain.a,
     { '처리중|확정': +chain.b.toFixed(2), '완료|처리중': +chain.a.toFixed(2) });

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
