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
  // 외부 호스트로 나가는 요청이 있으면 사내망에서 깨진다 — URL 로 직접 잡는다
  const extReq = [];
  page.on('request', r => {
    const u = r.url();
    if (!/^https?:\/\/127\.0\.0\.1|^https?:\/\/localhost|^data:|^blob:|^about:/.test(u)) extReq.push(u);
  });

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
  ok('잠정은 예산 미반영으로 안내', /예산에 (잡히지|반영되지) 않/.test(ghostTxt), ghostTxt.slice(0, 40));
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
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'EDTW소재기술');
  const ccgAuto = await page.inputValue('#travBody tr:nth-child(1) .t-cc');
  ok('CCG No. 자동채움', ccgAuto === '50119134', ccgAuto);
  await page.fill('#travBody tr:nth-child(1) .t-p-trans', '70000');
  await page.fill('#travBody tr:nth-child(1) .t-p-lodg', '90000');
  // add companion
  await page.click('button:has-text("+ 동행자 추가")');
  await page.fill('#travBody tr:nth-child(2) .t-nm', '김동행');
  await page.fill('#travBody tr:nth-child(2) .t-no', 'E9002');
  await page.selectOption('#travBody tr:nth-child(2) .t-tm', 'Patterning소재기술');
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
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'EDTW소재기술');
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
  await page.waitForSelector('#v-dash .hero > .stack');
  const commitBefore = await page.evaluate(() => ST.dash.commit);
  ok('시드 확정예정 예산 확보 표시', commitBefore > 0, commitBefore);
  // 잠정 계획 생성 (확정 체크 안 함)
  await page.click('.nav a[data-view="plan"]');
  await page.waitForSelector('#pl_city');
  await page.fill('#pl_city', '대전'); await page.fill('#pl_org', '확정테스트'); await page.fill('#pl_purpose', '확정 E2E');
  await page.fill('#pl_dep', `${yy}-${mm}-20`); await page.fill('#pl_ret', `${yy}-${mm}-21`);
  await page.fill('#travBody tr:nth-child(1) .t-nm', '확정자'); await page.fill('#travBody tr:nth-child(1) .t-no', 'CF1');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'EDTW소재기술'); await page.fill('#travBody tr:nth-child(1) .t-p-trans', '100000');
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
  // 삭제는 행에 그대로 노출하지 않고 ⋯ 메뉴 안에 둔다 (오클릭 방지) — 메뉴를 열어서 누른다
  if (await delRow.locator('details.rowmenu summary').count()) {
    await delRow.locator('details.rowmenu summary').first().click(); await sleep(250);
    await delRow.locator('.rowmenu-item.danger').first().click(); await sleep(500);
  }
  ok('잠정 계획 흔적 없이 삭제', !(await page.evaluate(() => ST.groups.some(g => g.org === 'SK트리켐'))));

  // 5f. [P0] 사번에 심은 스크립트가 예산담당자 '클릭' 시 실행되지 않아야 (저장형 XSS)
  await page.evaluate(() => { document.getElementById('mailCard')?.remove(); });
  const XSS_EMP = "X',alert('pwn'),'";
  await page.evaluate(async (emp) => {
    const yq = YQ, yy = yq.split('-')[0], mm = String(parseInt(yq.split('-')[1]) * 3).padStart(2, '0');
    const g = {plan_type:'계획',city:'x',org:'XSS클릭',purpose:'p',kind:'정기 Audit',
      dep_dt:`${yy}-${mm}-19`,ret_dt:`${yy}-${mm}-19`,car:'미사용',
      travelers:[{name:'공격자',emp_no:emp,rank:'TL',ccg_nm:'EDTW소재기술',p_trans:50000}]};
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
      else { const t = r.children[4]?.textContent.trim(); if (t) cur.push(t); } });   // 맨 앞 선택 열이 생겨 한 칸 밀림
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
  const before = await page.evaluate(() => document.querySelector('#listBody tr:not(.grp-head):not(.empty) td:nth-child(5)')?.textContent);
  await page.click('#v-list button:has-text("내림차순")');
  await sleep(300);
  const after = await page.evaluate(() => document.querySelector('#listBody tr:not(.grp-head):not(.empty) td:nth-child(5)')?.textContent);
  ok('오름/내림차순 토글 동작', before !== after, {before, after});
  // 컬럼별 검색창 (머리글 아래) — 출장 컬럼에 '원익' 입력
  await page.fill('#v-list tr.filt th:nth-child(3) input', '원익');
  await sleep(300);
  const colFiltered = await page.evaluate(() => [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length);
  ok('컬럼별 검색창 동작', colFiltered >= 1 && colFiltered < stageInfo.stages, {colFiltered});
  // 입력 후에도 포커스가 유지되는가 (본문만 갱신)
  ok('컬럼 검색 중 포커스 유지', await page.evaluate(() =>
    document.activeElement === document.querySelector('#v-list tr.filt th:nth-child(3) input')));
  await page.fill('#v-list tr.filt th:nth-child(3) input', '');
  await sleep(300);
  // 상태 컬럼 드롭다운 — 실제 존재하는 상태로 필터
  // 화면 라벨이 아니라 실제 값으로 고른다 — 라벨은 좁은 칸에 맞춰 짧게 쓸 수 있다
  const rawStatus = await page.evaluate(() => {
    const here = ST.groups.filter(g => g.yq === YQ);
    return here.length ? here[0].roll : ST.meta.statuses[0];
  });
  await page.selectOption('#v-list tr.filt th:nth-child(2) select', { value: rawStatus });
  await sleep(300);
  const stFiltered = await page.evaluate(() => [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty)')].length);
  ok('상태 컬럼 필터 동작', stFiltered >= 1 && stFiltered <= stageInfo.stages, {rawStatus, stFiltered});
  await page.click('#v-list button:has-text("필터 해제")');
  await sleep(300);
  // 머리글 클릭 정렬 — 순수 컬럼 정렬을 보려면 '프로세스별 묶기'를 끈다
  await page.uncheck('#v-list .filter-row input[type=checkbox]');
  await sleep(300);
  await page.click('#v-list th.sortable:has-text("계획")');
  await sleep(300);
  ok('머리글 클릭 정렬 표시(▲▼)', await page.evaluate(() =>
    !!document.querySelector('#v-list .sic[data-k="plan"]')?.textContent.trim()));
  const planOrder = await page.evaluate(() => {
    const v = [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty) td:nth-child(6)')]
      .map(t => Number(t.textContent.replace(/[^0-9]/g, '')) || 0);
    return v.every((x, i) => i === 0 || v[i-1] >= x);
  });
  ok('계획 금액 내림차순 정렬', planOrder === true);
  // 다시 누르면 오름차순
  await page.click('#v-list th.sortable:has-text("계획")');
  await sleep(300);
  const planAsc = await page.evaluate(() => {
    const v = [...document.querySelectorAll('#listBody tr:not(.grp-head):not(.empty) td:nth-child(6)')]
      .map(t => Number(t.textContent.replace(/[^0-9]/g, '')) || 0);
    return v.every((x, i) => i === 0 || v[i-1] <= x);
  });
  ok('머리글 재클릭 → 오름차순 전환', planAsc === true);
  await page.check('#v-list .filter-row input[type=checkbox]');
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
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'EDTW소재기술');
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
     && clip.includes('EDTW소재기술') && clip.includes('실적 입력·인폼')
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
  // 자체 호스팅 글꼴(TB UI)은 파일이 있을 때만 앞에 붙는다. 그 외에는 맑은 고딕이 첫째.
  ok('본문 글꼴이 맑은 고딕(또는 자체 호스팅) 우선', /^"?(Malgun Gothic|TB UI)/.test(fam), fam);
  ok('외부 웹폰트 이름 없음', !/Pretendard|Noto|Roboto|Inter/.test(fam), fam);
  const proseFonts = await page.evaluate(() => [...new Set([...document.querySelectorAll('body *')]
    .map(e => getComputedStyle(e).fontFamily))].filter(f => !/monospace/.test(f)));
  ok('본문 글꼴 스택 1종', proseFonts.length === 1, proseFonts);

  await page.evaluate(() => { document.getElementById('mailCard')?.remove(); nav('dash'); });
  await sleep(200);
  ok('대시보드 CCG 막대 도식', (await page.$$('#v-dash .card > .bars .brow')).length > 0);
  ok('막대 범례 3색(완료/처리중/확정)', (await page.$$('#v-dash .lgd i')).length === 3);
  const refTxt = await page.textContent('#v-dash .ref');
  // 잠정 설명은 예산 hero 한 곳에만 (v10.0 이전엔 hero·CCG 두 곳에 같은 문장이 찍혔다)
  ok('CCG 참고줄은 건수·인원만', /\d+건/.test(refTxt) && /인원\s*\d+명/.test(refTxt), refTxt.slice(0, 40));
  const planSent = await page.evaluate(() =>
    [...document.querySelectorAll('#v-dash')].map(x => x.textContent)
      .join('').split(/예산에 (?:잡히지|반영되지) 않/).length - 1);
  // 잠정이 0이면 문장 자체가 안 나오는 게 맞다(0원짜리 안내문 금지). 나올 때는 딱 한 번만.
  const planAmt = await page.evaluate(() => ST.dash.planAmt);
  ok('“예산 미반영” 문장 중복 없음', planAmt > 0 ? planSent === 1 : planSent === 0,
     { planAmt, planSent });

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
    return n[0] + n[1];              // 처리완료 + 처리중 (확정 예정은 아직 안 쓴 돈이라 제외)
  });
  ok('비목 합계 = 실집행 합계', cost.sum === barSum, { cost: cost.sum, bar: barSum });
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
  // 예전엔 카드가 떠 있어서 아래 버튼을 가렸고, 그래서 '접기'가 필요했다.
  // 이제는 화면 흐름 안에 놓이므로 '가리지 않는다'를 직접 잰다.
  const inline = await page.evaluate(() => {
    const c = document.getElementById('mailCard');
    const cs = getComputedStyle(c);
    const cr = c.getBoundingClientRect();
    // 카드 밖의 보이는 버튼 중 카드와 겹치는 것이 있는가
    const covered = [...document.querySelectorAll('button')].filter(b => {
      if (c.contains(b) || !b.checkVisibility()) return false;
      const r = b.getBoundingClientRect();
      return r.top < cr.bottom && r.bottom > cr.top && r.left < cr.right && r.right > cr.left;
    }).length;
    return { pos: cs.position, parent: c.parentElement.id, covered,
             zone: !!c.querySelector('.dragzone'),
             hint: (c.querySelector('.draghint') || {}).textContent || '',
             dashed: c.querySelector('.dragzone')
               ? getComputedStyle(c.querySelector('.dragzone')).borderStyle : '',
             cursor: getComputedStyle(c.querySelector('#mailBody')).cursor };
  });
  ok('인폼이 떠 있지 않고 화면 안에 놓임', inline.pos === 'static' && /^v-/.test(inline.parent), inline);
  ok('인폼이 다른 버튼을 가리지 않음', inline.covered === 0, inline.covered);
  ok('끌 수 있는 구역이 점선으로 표시됨', inline.zone && inline.dashed === 'dashed', inline.dashed);
  ok('끄는 방법이 글로 적혀 있음', /끌어/.test(inline.hint), inline.hint.slice(0, 40));
  ok('마우스 커서가 잡는 모양', inline.cursor === 'grab', inline.cursor);
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
  // CCG No. 는 선택지 라벨 안에 있다 — 칸 아래 캡션으로 두면 그 칸만 두 줄이 되어
  // 옆 칸들과 눈높이가 어긋난다. 전용 열도 만들지 않는다(열이 하나 더 늘면 표가 밀린다).
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => nav('plan'));
  await page.waitForSelector('#travBody tr');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'EDTW소재기술');
  const ccg = await page.evaluate(() => {
    const tr = document.querySelector('#travBody tr');
    const sel = tr.querySelector('.t-tm');
    const cs = getComputedStyle(sel);
    const cv = document.createElement('canvas').getContext('2d');
    cv.font = `${cs.fontSize} ${cs.fontFamily}`;
    const longest = [...sel.options].reduce((a, o) => o.textContent.length > a.textContent.length ? o : a);
    return { hidden: tr.querySelector('.t-cc').value, value: sel.value,
             label: sel.selectedOptions[0].textContent,
             caption: !!tr.querySelector('.ccgno'),
             cells: tr.children.length,
             room: Math.round(sel.clientWidth - parseFloat(cs.paddingLeft)
                              - parseFloat(cs.paddingRight) - 20),
             need: Math.round(cv.measureText(longest.textContent).width) };
  });
  ok('CCG 코드 자동 채움 유지', ccg.hidden === '50119134', ccg);
  ok('저장값은 팀 이름 그대로 (라벨에 오염되지 않음)', ccg.value === 'EDTW소재기술', ccg.value);
  ok('선택지 라벨에 CCG 번호가 함께 보임', ccg.label.includes('50119134'), ccg.label);
  ok('팀 칸 아래 캡션 없음 (한 줄 유지)', ccg.caption === false);
  ok('데스크톱에서 가장 긴 팀 이름도 잘리지 않음', ccg.room >= ccg.need,
     { room: ccg.room, need: ccg.need });
  // 번호를 위해 열을 새로 만들지 않았다 — 열이 하나 늘면 좁은 화면에서 표가 밀린다
  ok('CCG 번호 때문에 열이 늘지 않음 (한 행 10칸 유지)', ccg.cells === 10, ccg.cells);
  // 한 줄 안의 칸들이 같은 눈높이인가 — select 는 크롬이 line-height 를 무시해 3px 작게 그린다
  const rowTops = await page.evaluate(() => {
    const tr = document.querySelector('#travBody tr');
    const c = [...tr.querySelectorAll('input:not([type=hidden]),select,button')];
    const tops = c.map(e => Math.round(e.getBoundingClientRect().top));
    return Math.max(...tops) - Math.min(...tops);
  });
  ok('출장자 표 한 줄의 눈높이가 같음', rowTops === 0, rowTops);

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
      // 확정 예정 세그먼트(.ghost-seg)는 집계 밖이라 폭 검사에서 뺀다
      const seg = [...r.querySelectorAll('.bbar i:not(.ghost-seg)')]
        .reduce((a, i) => a + (parseFloat(i.style.width) || 0), 0);
      const m = r.querySelector('.bval').textContent.match(/(\d+)%/);
      return { seg: +seg.toFixed(1), pct: m ? +m[1] : null };
    }).filter(r => r.pct != null);      // '예정' 만 있는 행은 구성비가 없다
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
    rowBadges: [...document.querySelectorAll('#listBody tr td:nth-child(2) .status')]
      .filter(b => !b.classList.contains('urgent')).length,   // 맨 앞은 선택 열
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

  /* ── 22b. 타이포 — 윈도우에서 글자가 뭉개지지 않게 ── */
  console.log('\n-- 22b. 타이포 규율 --');
  await page.evaluate(() => nav('dash'));
  await page.waitForSelector('#v-dash .hmain');
  const typo = await page.evaluate(() => {
    const KO = /[가-힣]/, sz = new Set(), wt = new Set(), frac = [];
    for (const el of document.querySelectorAll('body *')) {
      if (!el.offsetParent && el.tagName !== 'BODY') continue;
      const t = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
      if (!t || !KO.test(t)) continue;
      const s = getComputedStyle(el);
      const fs = parseFloat(s.fontSize), lh = parseFloat(s.lineHeight);
      sz.add(fs); wt.add(s.fontWeight);
      if (!Number.isInteger(fs) || (Number.isFinite(lh) && !Number.isInteger(lh)))
        frac.push({ fs, lh, t: t.slice(0, 14) });
    }
    return { sz: [...sz].sort((a, b) => a - b), wt: [...wt].sort(), frac: frac.slice(0, 5), fracN: frac.length };
  });
  // 소수점 줄높이는 베이스라인을 서브픽셀에 걸어 줄마다 다르게 뭉갠다 — 이게 '글자 우그러짐'의 주범
  ok('소수점 크기·줄높이 0건', typo.fracN === 0, typo.frac);
  ok('11px 이하 한글 없음', typo.sz[0] >= 12, typo.sz);
  // 맑은 고딕은 400·700 뿐 — 5종을 선언해도 2종으로 렌더되어 위계가 안 생긴다
  ok('렌더 굵기 2종 이하', typo.wt.length <= 2, typo.wt);

  /* ── 23. v10.4 — 조용히 틀리는 값 · 막다른 길 · 거짓 표시 ── */
  console.log('\n-- 23. 조용한 오류 · 막다른 길 --');

  // 표 안 Enter 로 제출되면 안 된다 (덜 채운 계획 등록 / 실적 저장 + 인폼 메일 발행)
  await page.evaluate(() => nav('plan'));
  await page.waitForSelector('#travBody tr');
  const s23Cnt = await page.evaluate(() => ST.groups.length);
  await page.fill('#travBody tr:nth-child(1) .t-nm', '엔터테스트');
  await page.press('#travBody tr:nth-child(1) .t-nm', 'Enter');
  await sleep(600);
  ok('출장자 표 Enter 로 제출되지 않음',
     (await page.evaluate(() => ST.groups.length)) === s23Cnt, { s23Cnt });
  ok('표 바깥 입력칸은 그대로', await page.isVisible('#pl_city'));

  // 일괄 등록 — 조용히 틀리는 두 가지
  await page.evaluate(() => nav('bulk'));
  await page.waitForSelector('#bkText');
  const bulkChk = await page.evaluate(() => {
    // (1) '목적' 머리글 별칭이 자기 자신으로 매핑돼 그 열이 통째로 무시되던 문제
    const head = '출장도시\t출장기관&업체\tCCG명\t성명\t사번\t목적\t출발일자';
    const row = '청주\t원익머트리얼즈\tEDTW소재기술\t김테스트\tT001\tNF3 정기 점검\t2026-08-10';
    const r1 = bParse(head + '\n' + row);
    // (2) 빈 출장구분이 '정기 Audit' 으로 채워져 센터 CSV 에 그럴듯한 거짓이 나가던 문제
    const kind = bKind('');
    // (3) 머리글 없이 일부 열만 붙이면 27필드 순서로 오해 → 멈추고 머리글을 요청해야 한다
    const r3 = bParse('청주\t원익\t2026-08-10\t김철수');
    return {
      purpose: r1.groups[0]?.purpose || '',
      purposeErr: r1.errs.join(' '),
      kind,
      partialStopped: r3.groups.length === 0 && /머리글/.test(r3.errs.join(' ')),
      partialErr: r3.errs[0] || '',
    };
  });
  ok("일괄 '목적' 머리글이 목적으로 들어감", bulkChk.purpose === 'NF3 정기 점검', bulkChk);
  ok('빈 출장구분은 기타 (정기 Audit 아님)', bulkChk.kind === '기타', bulkChk.kind);
  ok('머리글 없는 일부 열은 멈추고 안내', bulkChk.partialStopped, bulkChk.partialErr);

  // 예산 미배정 분기가 초록 '정상'으로 보이면 안 된다
  const unset = await page.evaluate(() => {
    const real = ST.dash.alloc;
    ST.dash.alloc = 0; ST.dash.planAmt = 0; ST.dash.nPlan = 0;
    rDash(); nav('dash');
    const h = document.querySelector('#v-dash .hero');
    const r = { cls: h.className, msg: h.querySelector('.msg').textContent.trim(),
                lamp: getComputedStyle(h.querySelector('.lamp')).backgroundColor,
                zeroNote: /잠정 계획 0원/.test(h.textContent),
                cta: !!h.querySelector('button') };
    ST.dash.alloc = real; rDash(); nav('dash');
    return r;
  });
  ok('예산 미배정은 중립 상태', unset.cls.includes('unset') && !unset.msg.includes('정상'), unset);
  ok('예산 미배정에 초록 램프 없음', !/rgb\(22,\s*111,\s*89\)/.test(unset.lamp), unset.lamp);
  ok('0원짜리 안내문 없음', !unset.zeroNote, unset);
  ok('예산 배정으로 가는 버튼 제공', unset.cta, unset);

  // 목록 빈 화면 — 필터 탓으로 돌리지 않는다
  await page.evaluate(() => { nav('list'); LQ.q = 'ZZZ존재하지않는검색어'; renderListBody(); });
  await sleep(200);
  const emptyFiltered = await page.textContent('#listBody .empty');
  ok('필터로 비면 필터 해제 안내', /필터 해제|조건에 맞는/.test(emptyFiltered), emptyFiltered.slice(0, 40));
  ok('필터로 비면 해제 버튼 제공', await page.isVisible('#listBody .empty button'));
  await page.evaluate(() => { LQ.q = ''; renderListBody(); });

  // 정렬 화살표는 실제로 뒤집히는 열에만
  const arrows = await page.evaluate(() => {
    const read = () => [...document.querySelectorAll('#v-list .sic')]
      .map(e => ({ k: e.dataset.k, t: e.textContent.trim() })).filter(x => x.t);
    LQ.group = true; LQ.sort = 'stage'; renderListBody();
    const grouped = read();
    LQ.group = false; renderListBody();
    const flat = read();
    LQ.group = true; renderListBody();
    return { grouped, flat };
  });
  ok('묶기 중 ▲▼ 가 상태 열에 붙지 않음',
     !arrows.grouped.some(x => x.k === 'stage' && /[▲▼]/.test(x.t)), arrows.grouped);
  ok('묶기 중 화살표는 기간 열에',
     arrows.grouped.some(x => x.k === 'date' && /[▲▼]/.test(x.t)), arrows.grouped);

  // 검색 안내문구가 없는 기능을 약속하면 안 된다
  ok('검색 placeholder 에 전표번호 없음',
     !(await page.getAttribute('#listFilter', 'placeholder')).includes('전표번호'));

  // 필터 행 체크박스가 200px 로 늘어나면 라벨과 떨어져 클릭 판정이 이상해진다
  const cbw = await page.evaluate(() => {
    const cb = document.querySelector('#v-list .filter-row input[type=checkbox]');
    return cb ? Math.round(cb.getBoundingClientRect().width) : null;
  });
  ok('묶기 체크박스가 늘어나지 않음', cbw != null && cbw <= 32, cbw);

  // 처리 관리 — 남은 일이 위로, 완료는 아래
  await page.evaluate(() => { sessionStorage.setItem('tb_pw', '2071478'); nav('process'); });
  await page.waitForSelector('#v-process .pgroup, #v-process .note');
  const porder = await page.evaluate(() => [...document.querySelectorAll('#v-process .pgroup')]
    .map(b => b.querySelector('.status').textContent.trim()));
  const doneFirst = porder.findIndex(x => x === '처리 완료');
  ok('처리 완료가 맨 아래로', doneFirst === -1 || porder.slice(doneFirst).every(x => x === '처리 완료'), porder);

  // CCG 금액 열이 실제로 세로로 맞는가 ('%' 가 가변폭이라 금액 끝이 밀리던 문제)
  await page.evaluate(() => nav('dash'));
  await page.waitForSelector('#v-dash .card > .bars .brow');
  const alignPx = await page.evaluate(() => {
    const xs = [...document.querySelectorAll('#v-dash .card > .bars .bval')].map(v => {
      const sub = v.querySelector('.sub');
      return sub ? Math.round(sub.getBoundingClientRect().left) : null;
    }).filter(x => x != null);
    return xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  });
  ok('금액 끝이 세로로 맞음 (구성비 고정폭)', alignPx <= 1, alignPx);

  // 인폼은 화면 흐름 안에 놓인다 — 떠 있지 않으므로 여백 보정도, 가림도 없다
  const cover = await page.evaluate(async () => {
    const g = ST.groups.find(x => x.act_tot > 0);
    if (!g) return null;
    await reopenMail(g.group_id);
    await new Promise(r => setTimeout(r, 400));
    const card = document.getElementById('mailCard');
    if (!card) return null;
    const cr = card.getBoundingClientRect();
    const covered = [...document.querySelectorAll('button')].filter(b => {
      if (card.contains(b) || !b.checkVisibility()) return false;
      const r = b.getBoundingClientRect();
      return r.top < cr.bottom && r.bottom > cr.top && r.left < cr.right && r.right > cr.left;
    }).length;
    const pos = getComputedStyle(card).position;
    const inView = /^v-/.test(card.parentElement.id);
    card.remove();
    return { covered, pos, inView };
  });
  if (cover) {
    ok('인폼이 버튼을 가리지 않음(떠 있지 않음)', cover.covered === 0 && cover.pos === 'static', cover);
    ok('인폼이 지금 보고 있는 화면 안에 놓임', cover.inView, cover);
  }

  // 취소 확인 문구가 없는 복구 경로를 약속하면 안 된다
  const appSrc = await page.evaluate(() => fetch('/travelbudget/static/app.js').then(r => r.text()));
  ok('취소 안내가 거짓 복구 경로를 말하지 않음',
     !/되돌리려면 예산 담당자 모드가 필요/.test(appSrc));
  ok('취소 안내가 실제 복구 경로(백업 복원)를 안내', /백업 복원/.test(appSrc));

  /* ── 24. v10.6 — 실집행 기준 집계 · 비목별 내역 열람 ── */
  console.log('\n-- 24. 실집행 기준 · 비목별 내역 --');
  await page.evaluate(() => nav('dash'));
  await page.waitForSelector('#v-dash .card > .bars .brow');
  const basis = await page.evaluate(() => {
    const d = ST.dash;
    const rows = [...document.querySelectorAll('#v-dash .card > .bars .brow')].map(r => ({
      only: r.classList.contains('only-cmt'),
      val: r.querySelector('.bval').textContent.trim(),
      ghost: !!r.querySelector('.bbar i.ghost-seg'),
    }));
    return {
      rows,
      ccgPeople: d.byCcg.reduce((a, r) => a + r.people, 0),
      usedPeople: d.nUsedPeople, allPeople: d.nPeople,
      share: d.byCcg.reduce((a, r) => a + r.share, 0),
      costSum: (d.byCost || []).reduce((a, c) => a + c.amt, 0),
      used: d.done + d.wip, commit: d.commit,
    };
  });
  // 부서별 인원은 실집행만 — 아직 안 간 사람을 세면 숫자가 부풀어 보인다
  ok('부서별 인원 = 실집행 인원', basis.ccgPeople === basis.usedPeople, basis);
  ok('실집행 인원 <= 전체 인원', basis.usedPeople <= basis.allPeople, basis);
  ok('CCG 구성비 합 = 100%', Math.abs(basis.share - 1) < 0.01 || basis.used === 0, basis.share);
  ok('비목 합계 = 실집행 합계 (확정 예정 제외)', basis.costSum === basis.used, basis);
  // 확정만 있는 팀은 금액·구성비가 아니라 '예정'으로만 보여야 한다
  const onlyRows = basis.rows.filter(r => r.only);
  ok('확정만 있는 팀은 예정 표기', onlyRows.every(r => /예정/.test(r.val) && r.ghost), onlyRows);
  ok('확정만 있는 팀에 구성비 없음', onlyRows.every(r => !/%/.test(r.val)), onlyRows);

  // 출장 내역 — 상태를 건드리지 않고 비목별 내역을 볼 수 있어야 한다
  await page.evaluate(() => nav('list'));
  await page.waitForSelector('#listBody tr');
  const dgid = await page.evaluate(() => (ST.groups.find(g => g.act_tot > 0) || {}).group_id);
  const stBefore = await page.evaluate(g => {
    const x = ST.groups.find(y => y.group_id === g);
    return { roll: x.roll, st: x.status, act: x.act_tot };
  }, dgid);
  await page.evaluate(g => toggleDetail(g), dgid);
  await sleep(300);
  const dtl = await page.evaluate(() => {
    const d = document.querySelector('.dtl-row');
    if (!d) return null;
    const th = [...d.querySelectorAll('thead th')].map(x => x.textContent.trim());
    const foot = [...d.querySelectorAll('tfoot td')].map(x => x.textContent.trim());
    return { th, foot, copy: !!d.querySelector('button'), rows: d.querySelectorAll('tbody tr').length };
  });
  ok('내역이 펼쳐짐', !!dtl && dtl.rows > 0, dtl && dtl.rows);
  ok('비목 4종이 열로 표시', ['교통비', '숙박비', '식대&잡비', '기타'].every(k => dtl.th.includes(k)), dtl.th);
  ok('정산서에 필요한 열 존재', ['성명', '사번', 'CCG팀'].every(k => dtl.th.includes(k)), dtl.th);
  ok('합계 행 존재', dtl.foot.some(x => /합계/.test(x)), dtl.foot);
  ok('표 복사 버튼 제공', dtl.copy);
  // 핵심 — 보기만 해도 상태가 바뀌면 안 된다 (전에는 되돌리기→수정으로만 볼 수 있었다)
  const stAfter = await page.evaluate(g => {
    const x = ST.groups.find(y => y.group_id === g);
    return { roll: x.roll, st: x.status, act: x.act_tot };
  }, dgid);
  ok('내역을 봐도 상태·금액이 그대로', JSON.stringify(stBefore) === JSON.stringify(stAfter),
     { before: stBefore, after: stAfter });

  // 이관·처리 관리에서도 비목별이 보여야 한다 (이관 시 정산서를 쓰는 화면)
  await page.evaluate(() => { sessionStorage.setItem('tb_pw', '2071478'); nav('process'); });
  await page.waitForSelector('#v-process .pgroup, #v-process .note');
  const pdtl = await page.evaluate(() => {
    const d = document.querySelector('#v-process details.pdtl');
    if (!d) return null;
    d.open = true;
    const th = [...d.querySelectorAll('thead th')].map(x => x.textContent.trim());
    return { th, copy: !!d.querySelector('button') };
  });
  if (pdtl) {
    ok('이관·처리에도 비목별 내역', ['교통비', '숙박비', '식대&잡비', '기타'].every(k => pdtl.th.includes(k)), pdtl.th);
    ok('이관·처리에도 표 복사', pdtl.copy);
  }

  /* ── 25. v10.8 — 시스템 설정 화면 ── */
  console.log('\n-- 25. 시스템 설정 --');
  await page.evaluate(() => sessionStorage.removeItem('tb_pw'));
  await page.click('.nav a[data-view="config"]');
  await sleep(400);
  ok('설정은 인증 없이 못 봄 (담당자 모달)', await page.isVisible('#adminModal'));
  ok('인증 전에는 설정 내용이 안 남음',
     await page.evaluate(() => !document.querySelector('#cfgTeams')));
  await page.fill('#admPw', '2071478');
  await page.click('#admOk');
  await page.waitForSelector('#cfgTeams tr', { timeout: 5000 });
  ok('인증하면 그 화면이 다시 그려짐', await page.isVisible('#cfgTeams'));
  await page.evaluate(async () => { sessionStorage.setItem('tb_pw', '2071478'); await rConfig(); nav('config'); });
  await page.waitForSelector('#cfgTeams tr', { timeout: 5000 });
  const cfg = await page.evaluate(() => ({
    mails: document.querySelectorAll('#cfgMails .cfg-mail').length,
    teams: document.querySelectorAll('#cfgTeams tr').length,
    used: [...document.querySelectorAll('#cfgTeams .cfg-used')].filter(x => /사용 중/.test(x.textContent)).length,
    guarded: [...document.querySelectorAll('#cfgTeams tr')].filter(r => /삭제 불가/.test(r.textContent)).length,
    warn: !!document.querySelector('.cfg-warn'),
  }));
  ok('수신인·CCG 목록 렌더', cfg.mails > 0 && cfg.teams > 0, cfg);
  ok('원장에서 쓰이는 팀 수 표시', cfg.used > 0, cfg);
  ok('사용 중인 팀은 삭제 버튼 없음', cfg.guarded === cfg.used, cfg);
  ok('과거 데이터가 안 바뀐다는 경고 표시', cfg.warn);

  // 실제 저장 — 새 팀을 넣으면 계획 등록 드롭다운에 바로 나와야 한다
  await page.evaluate(() => { cfgAddTeam(); });
  await sleep(200);
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#cfgTeams tr');
    const last = rows[rows.length - 1];
    last.querySelector('.cfg-team').value = 'E2E 신규팀';
    last.querySelector('.cfg-code').value = 'CE2E';
  });
  await page.click('#cfgSave');
  await sleep(900);
  const applied = await page.evaluate(() => ({
    inState: (ST.ccg || []).some(t => t.ccg === 'CE2E'),
    inPlan: [...document.querySelectorAll('#travBody tr:nth-child(1) .t-tm option')].some(o => o.value === 'E2E 신규팀'),
  }));
  ok('저장한 팀이 /state 에 반영', applied.inState, applied);
  ok('저장한 팀이 계획 등록 드롭다운에 반영', applied.inPlan, applied);
  // 그 팀으로 실제 등록까지 되어야 한다 (검증이 기본 목록만 보면 400 이 난다)
  await page.evaluate(() => nav('plan'));
  await page.waitForSelector('#pl_city');
  await page.fill('#pl_city', '설정시');
  await page.fill('#pl_org', '설정업체');
  await page.fill('#pl_purpose', '설정 반영 확인');
  const s25yq = await page.evaluate(() => YQ);
  const [s25yy, s25q] = s25yq.split('-');
  const s25mm = String(parseInt(s25q) * 3).padStart(2, '0');
  await page.fill('#pl_dep', `${s25yy}-${s25mm}-12`);
  await page.fill('#pl_ret', `${s25yy}-${s25mm}-13`);
  await page.fill('#travBody tr:nth-child(1) .t-nm', '설정자');
  await page.fill('#travBody tr:nth-child(1) .t-no', 'CFG1');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'E2E 신규팀');
  const autoCode = await page.evaluate(() => document.querySelector('#travBody tr:nth-child(1) .t-cc').value);
  ok('새 팀의 CCG 코드 자동 채움', autoCode === 'CE2E', autoCode);
  await page.fill('#travBody tr:nth-child(1) .t-p-trans', '30000');
  await page.click('#v-plan button:has-text("출장 계획 등록")');
  await sleep(700);
  ok('설정으로 추가한 팀으로 등록 성공',
     await page.evaluate(() => ST.groups.some(g => g.org === '설정업체')));

  // 잘못된 값은 서버가 막아야 한다
  await page.evaluate(async () => { await rConfig(); nav('config'); });
  await page.waitForSelector('#cfgTeams tr');
  await page.evaluate(() => { document.querySelector('#cfgMails .cfg-mail').value = '주소아님'; });
  await page.click('#cfgSave');
  await sleep(700);
  ok('잘못된 메일 주소는 저장 거부', await page.isVisible('#cfgErr .err'));

  // ── §26 여러 건 한꺼번에 확정 · 행 메뉴 · 대시보드 순서 ──
  console.log('\n== 26. 일괄 확정 · 행 메뉴 · 부서별 현황 위치 ==');
  await page.evaluate(() => { window.confirm = () => true; });
  // 잠정 계획 3건을 만들어 놓고 한 번에 확정
  for (let i = 0; i < 3; i++) {
    await page.evaluate(async n => {
      await fetch('api/groups', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({plan_type: '계획', city: '일괄', org: 'B' + n, purpose: '일괄 확정',
          kind: '정기 Audit', dep_dt: ST.groups[0].dep_dt, ret_dt: ST.groups[0].dep_dt, car: '미사용',
          travelers: [{name: '일' + n, emp_no: 'E2EB' + n, rank: 'TL',
                       ccg_nm: ST.ccg[0].team, ccg: ST.ccg[0].ccg, p_trans: 10000}]})});
    }, i);
  }
  await page.evaluate(async () => { await load(); rList(); nav('list'); });
  await sleep(500);
  const bulk0 = await page.evaluate(() => ({commit: ST.dash.commit, avail: ST.dash.avail,
                                            plan: ST.dash.nPlan}));
  // 파괴적 동작이 행에 그대로 노출되지 않아야 한다
  const vis = await page.evaluate(() => [...document.querySelectorAll('#listBody td:last-child button')]
    .filter(b => b.checkVisibility() && /삭제|취소/.test(b.textContent)).length);
  ok('삭제·취소가 행에 그대로 노출되지 않음', vis === 0, vis);
  // ⋯ 메뉴: 하나만 열리고 Esc 로 닫힌다
  await page.locator('#listBody details.rowmenu summary').first().click();
  await sleep(200);
  ok('⋯ 메뉴 열림', (await page.evaluate(() => document.querySelectorAll('details.rowmenu[open]').length)) === 1);
  const menuHasDanger = await page.evaluate(() =>
    !!document.querySelector('details.rowmenu[open] .rowmenu-item.danger'));
  ok('메뉴 안에 위험 항목이 구분되어 있음', menuHasDanger);
  await page.locator('#listBody details.rowmenu summary').nth(2).click().catch(() => {});
  await sleep(200);
  ok('메뉴는 한 번에 하나만',
     (await page.evaluate(() => document.querySelectorAll('details.rowmenu[open]').length)) <= 1);
  await page.keyboard.press('Escape');
  await sleep(200);
  ok('Esc 로 메뉴 닫힘',
     (await page.evaluate(() => document.querySelectorAll('details.rowmenu[open]').length)) === 0);
  // 전체 선택 → 일괄 확정
  await page.click('#selAll');
  await sleep(400);
  const picked = await page.evaluate(() => document.querySelectorAll('#listBody input.lsel:checked').length);
  ok('전체 선택이 잠정 계획만 고름', picked > 0 && picked === bulk0.plan, {picked, plan: bulk0.plan});
  ok('선택 띠에 건수·합계 표시', await page.evaluate(() => {
    const b = document.querySelector('#selBar');
    return b.classList.contains('on') && /건.*원/.test(b.innerText);
  }));
  await page.click('#selGo');
  await sleep(1500);
  const bulk1 = await page.evaluate(() => ({commit: ST.dash.commit, avail: ST.dash.avail,
                                            plan: ST.dash.nPlan}));
  ok('일괄 확정으로 잠정이 0건', bulk1.plan === 0, bulk1);
  ok('확정액 증가 = 가용 감소',
     bulk1.commit - bulk0.commit === bulk0.avail - bulk1.avail,
     {c: [bulk0.commit, bulk1.commit], a: [bulk0.avail, bulk1.avail]});
  ok('확정 후 선택이 비워짐',
     (await page.evaluate(() => document.querySelectorAll('#listBody tr.picked').length)) === 0);
  // 부서별 현황이 첫 화면 안에 들어와야 한다
  await page.setViewportSize({width: 1366, height: 768});
  await page.evaluate(() => { rDash(); nav('dash'); });
  await sleep(500);
  const foldY = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#v-dash h2,#v-dash h3,#v-dash .card')]
      .find(e => e.textContent.trim().startsWith('CCG'));
    return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1;
  });
  ok('부서별 현황이 1366x768 첫 화면 안', foldY > 0 && foldY < 768, foldY);
  const queueY = await page.evaluate(() => {
    const el = [...document.querySelectorAll('#v-dash h2,#v-dash h3,#v-dash .card')]
      .find(e => e.textContent.trim().startsWith('바로 할 일'));
    return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1;
  });
  ok('부서별 현황이 큐보다 위', foldY < queueY, {foldY, queueY});
  await page.setViewportSize({width: 1440, height: 900});

  // ── §27 렌더된 모서리·그림자가 척도 안인가 (선언이 아니라 실제 화면 기준) ──
  console.log('\n== 27. 모서리 · 그림자 · 강조선 ==');
  await page.click('.nav a[data-view="list"]');
  await sleep(600);
  const look = await page.evaluate(() => {
    const vis = e => e.checkVisibility && e.checkVisibility();
    const radii = {}, shadows = {};
    [...document.querySelectorAll('*')].filter(vis).forEach(e => {
      const cs = getComputedStyle(e);
      if (cs.borderRadius && cs.borderRadius !== '0px') radii[cs.borderRadius] = (radii[cs.borderRadius] || 0) + 1;
      if (cs.boxShadow && cs.boxShadow !== 'none') shadows[cs.boxShadow] = (shadows[cs.boxShadow] || 0) + 1;
    });
    const g = s2 => { const e = document.querySelector(s2); return e ? getComputedStyle(e) : null; };
    return { radii: Object.keys(radii).sort(), shadows: Object.keys(shadows).length,
             btn: g('.btn')?.borderRadius, card: g('.card')?.borderRadius,
             badge: g('.status')?.borderRadius, th: g('th')?.borderBottomWidth,
             navOn: g('.nav a.on')?.boxShadow || '',
             navOnBg: g('.nav a.on')?.backgroundColor || '',
             navOnLine: g('.nav a.on')?.borderTopColor || '',
             soft: getComputedStyle(document.documentElement).getPropertyValue('--soft').trim() };
  });
  ok('렌더된 모서리 값이 4종 이하', look.radii.length <= 4, look.radii);
  ok('버튼 3px · 카드 4px (컨테이너가 한 단계 큼)',
     look.btn === '3px' && look.card === '4px', {btn: look.btn, card: look.card});
  ok('상태 배지는 알약', parseFloat(look.badge) >= 99, look.badge);
  ok('표 머리글 경계가 본문보다 두꺼움', parseFloat(look.th) >= 2, look.th);
  // 지금 보고 있는 메뉴 — 막대가 아니라 면(옅은 남색)으로 표시한다
  ok('지금 보고 있는 메뉴가 남색 면으로 채워짐',
     look.navOnBg === 'rgb(211, 225, 240)', look.navOnBg);
  ok('선택 항목 테두리도 남색 계열', look.navOnLine === 'rgb(184, 204, 226)', look.navOnLine);
  ok('강조 막대(그림자)를 쓰지 않음', look.navOn === '' || look.navOn === 'none', look.navOn.slice(0, 50));
  ok('그림자 종류 4개 이하', look.shadows <= 4, look.shadows);

  // ── §28 걸러 놓은 건만 센터 제출 양식으로 ──
  console.log('\n== 28. 걸러서 내보내기 ==');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { LQ.q = ''; LQ.col = {}; SEL.clear(); nav('list'); rList(); });
  await page.waitForTimeout(500);
  const expAll = await page.evaluate(() => ({
    href: document.querySelector('#lsXls').getAttribute('href'),
    label: document.querySelector('#lsXls').textContent.trim(),
    note: document.querySelector('#lsExpNote').textContent.trim(),
  }));
  ok('필터가 없으면 분기 전체 (gids 없음)', !/gids=/.test(expAll.href), expAll.href);
  ok('버튼에 건수 표시', /· \d+건$/.test(expAll.label), expAll.label);
  // 상태를 '확정 예정' 으로 걸러 본다 — 추가 예산 요청에 쓰는 조합
  await page.evaluate(() => { setCol('stage', '확정 예정'); });
  await page.waitForTimeout(400);
  const expOne = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#listBody tr')]
      .filter(tr => !tr.classList.contains('grp-head') && !tr.classList.contains('empty'));
    const href = document.querySelector('#lsXls').getAttribute('href');
    const gids = (href.match(/gids=([^&]*)/) || [, ''])[1];
    return { n: rows.length, gids: decodeURIComponent(gids).split(',').filter(Boolean),
             csv: document.querySelector('#lsCsv').getAttribute('href'),
             label: document.querySelector('#lsXls').textContent.trim(),
             note: document.querySelector('#lsExpNote').textContent.trim() };
  });
  ok('걸러진 건수만큼 gids 가 붙음', expOne.gids.length === expOne.n && expOne.n > 0, expOne);
  ok('CSV 버튼도 같은 대상', /gids=/.test(expOne.csv) &&
     decodeURIComponent((expOne.csv.match(/gids=([^&]*)/) || [, ''])[1]).split(',').length === expOne.n,
     expOne.csv);
  ok('버튼·안내에 같은 건수', expOne.label.includes(`${expOne.n}건`)
     && expOne.note.includes(`${expOne.n}건`), [expOne.label, expOne.note]);
  // 실제로 받아 보면 그 건만 들어 있다
  const got = await page.evaluate(async href => {
    const r = await fetch(href.replace('export.xls', 'export.csv'));
    const txt = (await r.text()).replace(/^\ufeff/, '');
    const lines = txt.trim().split('\r\n');
    return { head: lines[0], rows: lines.length - 1 };
  }, await page.getAttribute('#lsXls', 'href'));
  ok('내려받은 파일이 센터 양식 머리글', got.head.startsWith('구분,LV2,CCG,CCG명'), got.head.slice(0, 40));
  ok('내려받은 행이 걸러진 건의 출장자 수', got.rows > 0 && got.rows >= expOne.n, got);
  // 체크박스로 고른 것이 있으면 그 건만
  await page.evaluate(() => { LQ.col = {}; renderListBody(); });
  await page.waitForTimeout(300);
  const pickedGid = await page.evaluate(() => {
    const g = ST.groups.find(x => x.yq === YQ);
    SEL.add(g.group_id); renderListBody();
    return g.group_id;
  });
  await page.waitForTimeout(300);
  const expSel = await page.evaluate(() => ({
    href: document.querySelector('#lsXls').getAttribute('href'),
    note: document.querySelector('#lsExpNote').textContent.trim() }));
  ok('고른 것이 있으면 그것만 나간다',
     decodeURIComponent((expSel.href.match(/gids=([^&]*)/) || [, ''])[1]) === pickedGid, expSel.href);
  ok('안내가 \'고른\' 이라고 말함', expSel.note.startsWith('고른'), expSel.note);
  await page.evaluate(() => { SEL.clear(); renderListBody(); });

  // ignore external-CDN load failures (sandbox blocks them); we only care about code errors
  const codeErrs = errs.filter(e => !/ERR_TUNNEL_CONNECTION_FAILED|Failed to load resource/.test(e));
  ok('콘솔 JS 에러 없음 (외부 CDN 제외)', codeErrs.length === 0, codeErrs.slice(0, 3));
  // 권한 테스트가 일부러 만든 401 은 CDN 실패가 아니다 — 실제 외부 요청 URL 로 판정한다
  const cdnBlocked = extReq.length > 0;
  ok('외부 요청 0건 (사내망 안전)', !cdnBlocked, extReq.slice(0, 3));
} catch (e) {
  console.log('  FAIL  E2E 예외 -> ' + (e && e.stack || e));
  F++;
} finally {
  if (browser) await browser.close();
  srv.kill('SIGKILL');
}
console.log(`\n${'='.repeat(48)}\n  브라우저 E2E  ${P} passed / ${F} failed\n${'='.repeat(48)}`);
process.exit(F ? 1 : 0);
