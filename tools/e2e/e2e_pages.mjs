/* 실행: node tools/e2e/e2e_pages.mjs   (저장소 루트에서)
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
/* E2E for the static GitHub Pages build (docs/index.html) over file:// */
const pw = _req(PW_PATH);
const { chromium } = pw;
import { setTimeout as sleep } from 'node:timers/promises';

const FILE = 'file://' + path.join(REPO, 'docs/index.html');
let P = 0, F = 0;
const ok = (n, c, got) => { if (c) { P++; console.log(`  PASS  ${n}`); } else { F++; console.log(`  FAIL  ${n} -> ${JSON.stringify(got)}`); } };

let browser;
try {
  browser = await chromium.launch();
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push(String(e)));

  await page.goto(FILE);
  await page.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });

  // seed + formula
  const nums = await page.evaluate(() => ({ alloc: ST.dash.alloc, done: ST.dash.done, wip: ST.dash.wip, remain: ST.dash.remain, groups: ST.groups.length }));
  ok('시드 8건 로드', nums.groups === 8, nums.groups);
  ok('잔여 = 총예산−완료−처리중', nums.remain === nums.alloc - nums.done - nums.wip, nums);
  const heroLabel = await page.textContent('#v-dash .hright');
  ok('소진율(%) 노출', /소진율\s*\d+%/.test(heroLabel), heroLabel);

  // guide screen
  await page.click('.nav a[data-view="guide"]');
  await page.waitForSelector('#v-guide.on .g-lead', { timeout: 3000 });
  ok('이용 안내 흐름/스텝', (await page.isVisible('.flowbar')) && (await page.$$('#v-guide .gstep')).length === 5, (await page.$$('#v-guide .gstep')).length);
  await page.click('#v-guide button:has-text("출장 실적 입력으로 가기")');
  await page.waitForSelector('#v-actual.on #actSel', { timeout: 3000 });
  ok('가이드 → 실적 입력 화면 이동', await page.isVisible('#actSel'));

  // plan + companion
  await page.click('.nav a[data-view="plan"]');
  await page.waitForSelector('#pl_city');
  const yq = await page.evaluate(() => YQ);
  const [yy, qn] = yq.split('-'); const mm = String(parseInt(qn) * 3).padStart(2, '0');
  await page.fill('#pl_city', '수원'); await page.fill('#pl_org', '페이지테스트');
  await page.fill('#pl_purpose', 'Pages E2E'); await page.fill('#pl_dep', `${yy}-${mm}-10`); await page.fill('#pl_ret', `${yy}-${mm}-11`);
  await page.fill('#travBody tr:nth-child(1) .t-nm', '홍길동');
  await page.fill('#travBody tr:nth-child(1) .t-no', 'P1');
  await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Gas 소재팀');
  ok('CCG 자동채움', (await page.inputValue('#travBody tr:nth-child(1) .t-cc')) === 'C1202');
  await page.fill('#travBody tr:nth-child(1) .t-p-trans', '70000');
  await page.click('button:has-text("+ 동행자 추가")');
  await page.fill('#travBody tr:nth-child(2) .t-nm', '김동행');
  await page.fill('#travBody tr:nth-child(2) .t-no', 'P2');
  await page.selectOption('#travBody tr:nth-child(2) .t-tm', 'Photo 소재팀');
  await page.fill('#travBody tr:nth-child(2) .t-p-trans', '70000');
  await page.click('#v-plan button:has-text("출장 계획 등록")');
  await sleep(400);
  const created = await page.evaluate(() => ST.groups.find(g => g.org === '페이지테스트'));
  ok('계획 등록 저장(2인)', created && created.travelers.length === 2, created && created.travelers.length);
  const gid = created.group_id;

  // actual -> inform card, no XSS
  let alerted = false; page.on('dialog', async d => { alerted = true; await d.dismiss(); });
  await page.click('.nav a[data-view="actual"]');
  await page.waitForSelector('#actSel');
  await page.selectOption('#actSel', gid);
  await page.waitForSelector('#actRows tr');
  await page.fill('#actRows tr:nth-child(1) .a-trans', '68000');
  await page.fill('#actRows tr:nth-child(2) .a-trans', '69000');
  await page.click('button:has-text("실적 저장 및 인폼 생성")');
  await page.waitForSelector('#mailCard', { timeout: 5000 });
  const mailHtml = await page.innerHTML('#mailCard .body');
  ok('인폼 HTML 표 생성', mailHtml.includes('<table') && mailHtml.includes('홍길동') && mailHtml.includes('김동행'));

  // admin gate + 개인별 처리 (같은 출장, 사람마다 따로)
  await page.evaluate(() => sessionStorage.removeItem('tb_pw'));
  await page.click('.nav a[data-view="process"]');
  await page.waitForSelector('#adminModal', { timeout: 3000 });
  ok('관리자 잠금 프롬프트', await page.isVisible('#adminModal'));
  await page.fill('#admPw', '2071478'); await page.click('#admOk');
  await page.waitForSelector('#v-process.on .pgroup', { timeout: 3000 });
  await sleep(200);
  const rowOf = name => page.locator('#v-process tr').filter({ hasText: name });
  await rowOf('홍길동').getByRole('button', { name: '처리 완료', exact: true }).click();
  await sleep(400);
  await rowOf('김동행').getByRole('button', { name: '보류', exact: true }).click();
  await sleep(400);
  const pst = await page.evaluate(g => {
    const grp = ST.groups.find(x => x.group_id === g);
    return { hong: grp.travelers.find(p => p.name === '홍길동').status,
      kim: grp.travelers.find(p => p.name === '김동행').status, proc: grp.proc };
  }, gid);
  ok('개인별 처리 분리 (홍=완료 / 김=보류)', pst.hong === '처리 완료' && pst.kim === '보류' && pst.proc.hold === 1, pst);
  await rowOf('김동행').getByRole('button', { name: '처리 완료', exact: true }).click();
  await sleep(400);
  ok('보류자 완료 → 그룹 처리 완료', (await page.evaluate(g => ST.groups.find(x => x.group_id === g).roll, gid)) === '처리 완료');

  // budget 감액
  await page.click('.nav a[data-view="budget"]');
  await page.waitForSelector('#bd_amt');
  await page.selectOption('#bd_type', '감액'); await page.fill('#bd_amt', '500000'); await page.fill('#bd_reason', 'Pages 감액');
  await page.click('button:has-text("리비전 반영")');
  await sleep(400);
  ok('감액 자동 음수', (await page.evaluate(() => ST.budget.find(b => b.reason === 'Pages 감액')?.amt)) === -500000);

  // CSV download works (blob)
  await page.click('.nav a[data-view="data"]');
  await page.waitForSelector('button:has-text("전체 출장 CSV")');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('button:has-text("전체 출장 CSV")'),
  ]);
  const stream = await download.createReadStream();
  let csv = ''; for await (const ch of stream) csv += ch;
  ok('CSV Blob 다운로드 내용(센터 27필드)', csv.charCodeAt(0) === 0xFEFF
    && csv.split('\r\n')[0].startsWith('\ufeff구분,LV2,CCG,CCG명,사번,성명,직책')
    && csv.split('\r\n')[0].split(',').length === 27
    && csv.includes('동우화인켐'), csv.slice(0, 40));

  // 예산 CSV (정적판 = Blob 다운로드)
  await page.evaluate(() => { document.getElementById('mailCard')?.remove();   // 카드가 하단 버튼을 가리므로 닫고 진행
    sessionStorage.setItem('tb_pw', '2071478'); nav('budget'); });
  await page.waitForSelector('#v-budget table', { timeout: 4000 });
  const [bdl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#v-budget button:has-text("전체 예산 CSV")'),
  ]);
  const bstream = await bdl.createReadStream(); let bcsv = ''; for await (const ch of bstream) bcsv += ch;
  ok('정적판 예산 CSV 내용', bcsv.charCodeAt(0) === 0xFEFF && bcsv.includes('누적액') && bcsv.includes('최초배정'), bcsv.slice(0, 50));

  // persistence across reload (localStorage)
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });
  const persisted = await page.evaluate(() => ST.groups.find(g => g.org === '페이지테스트'));
  ok('새로고침 후 데이터 유지(localStorage)', !!persisted && persisted.roll === '처리 완료', persisted && persisted.roll);

  // 정적 사본(tools/tb_local.js)이 core.py 와 같은 계산을 하는지 — 예전에 여기만 뒤처져
  // CCG 구성비 분모가 달라 '금액은 있는데 0%' 가 정적판에만 남았다
  const mirror = await page.evaluate(() => {
    const d = ST.dash;
    const cost = (d.byCost || []).reduce((a, c) => a + c.amt, 0);
    return { used: d.done + d.wip + d.commit, cost, nTrips: d.nTrips,
             zero: (d.byCcg || []).filter(r => r.total > 0 && Math.round(r.share * 100) === 0).length,
             names: (d.byCost || []).map(c => c.name) };
  });
  ok('정적판 비목 합계 = 집행 합계', mirror.cost === mirror.used, mirror);
  ok('정적판 비목 4종', mirror.names.join(',') === '교통비,숙박비,식대&잡비,기타', mirror.names);
  ok('정적판 CCG 0% 없음', mirror.zero === 0, mirror);
  ok('정적판 nTrips 제공', typeof mirror.nTrips === 'number', mirror.nTrips);

  // no external CDN, no code errors, XSS didn't fire
  const cdnBlocked = errs.some(e => /Failed to load resource|ERR_TUNNEL|jsdelivr/.test(e));
  const codeErrs = errs.filter(e => !/Failed to load resource|ERR_TUNNEL/.test(e));
  ok('외부 CDN 미의존', !cdnBlocked, errs.slice(0, 2));
  ok('콘솔 코드 에러 없음', codeErrs.length === 0, codeErrs.slice(0, 3));
  ok('저장형 XSS 미실행', alerted === false);

  // mobile overflow
  const mp = await ctx.newPage();
  await mp.setViewportSize({ width: 390, height: 800 });
  await mp.goto(FILE);
  await mp.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('모바일 390px 무오버플로', overflow <= 2, overflow);
} catch (e) {
  console.log('  FAIL  예외 -> ' + (e && e.stack || e)); F++;
} finally {
  if (browser) await browser.close();
}
console.log(`\n${'='.repeat(48)}\n  Pages 정적 E2E  ${P} passed / ${F} failed\n${'='.repeat(48)}`);
process.exit(F ? 1 : 0);
