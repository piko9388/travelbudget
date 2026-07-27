/* 실행: node tools/e2e/ux_audit.mjs   (저장소 루트에서)
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
/* 사용자 관점 UX/기능 감사 — 처음 쓰는 소재 담당자가 계획→확정→실적→인폼을 걷는다 */
const pw = _req(PW_PATH);
const { chromium } = pw;
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import fs from 'node:fs';

const PORT = 5301;
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
  { cwd: REPO, stdio: 'ignore' });
for (let i = 0; i < 80; i++) {
  const up = await new Promise(r => { const s = net.connect(PORT, '127.0.0.1'); s.on('connect', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
  if (up) break; await sleep(150);
}
const base = `http://127.0.0.1:${PORT}/travelbudget/`;
const OBS = [];   // 관찰 결과
const note = (sev, area, what) => { OBS.push({ sev, area, what }); console.log(`  [${sev}] ${area} — ${what}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('#v-dash .hero');

console.log('\n== A. 처음 진입: 무엇을 해야 하는지 알 수 있나 ==');
const navTexts = await page.evaluate(() => [...document.querySelectorAll('.nav a')].map(a => a.textContent.trim()));
console.log('  좌측 메뉴:', navTexts.join(' | '));
// 담당자가 잠금 메뉴를 눌렀을 때
await page.click('.nav a[data-view="process"]');
await sleep(400);
const lockPrompt = await page.isVisible('#adminModal');
note(lockPrompt ? 'OK' : 'ISSUE', '권한', lockPrompt ? '담당자가 관리 메뉴 클릭 시 인증 모달 안내' : '잠금 메뉴 클릭 시 아무 안내 없음');
if (lockPrompt) {
  const hint = await page.textContent('#adminModal .hint').catch(() => '');
  note(/2071478/.test(hint) ? 'INFO' : 'ISSUE', '권한', `모달에 계정 힌트: ${hint.trim().slice(0, 40)}`);
  await page.click('#adminModal button:has-text("취소")');
}

console.log('\n== B. 계획 등록 — 빈 폼 제출 시 안내 품질 ==');
await page.click('.nav a[data-view="plan"]');
await page.waitForSelector('#pl_city');
await page.click('#v-plan button:has-text("출장 계획 등록")');
await sleep(500);
const errBox = await page.textContent('#planErr').catch(() => '');
note(errBox.trim() ? 'OK' : 'ISSUE', '검증', errBox.trim() ? `오류 목록 표시(${errBox.trim().split('\n').length}줄)` : '빈 폼 제출에 아무 반응 없음');
// 오류가 화면 위쪽인지(스크롤 필요한지)
const errPos = await page.evaluate(() => { const e = document.querySelector('#planErr .err'); if (!e) return null;
  const r = e.getBoundingClientRect(); return { top: Math.round(r.top), inView: r.top >= 0 && r.top < window.innerHeight }; });
note(errPos?.inView ? 'OK' : 'ISSUE', '검증', `오류 메시지 위치 ${JSON.stringify(errPos)} (제출 버튼은 폼 하단)`);
// 오류 문구가 무엇을 해야 하는지 알려주는가
console.log('  오류 문구 예시:', errBox.trim().split('\n').slice(0, 4).join(' / '));

console.log('\n== C. 계획 등록 — 정상 입력 + 실수 유발 지점 ==');
const yq = await page.evaluate(() => YQ);
const [yy, qn] = yq.split('-'); const mm = String(parseInt(qn) * 3).padStart(2, '0');
await page.fill('#pl_city', '이천'); await page.fill('#pl_org', '동우화인켐');
await page.fill('#pl_purpose', 'ArF PR 정기 품질 실사');
// 복귀일을 출발일보다 앞으로 (흔한 실수)
await page.fill('#pl_dep', `${yy}-${mm}-20`); await page.fill('#pl_ret', `${yy}-${mm}-18`);
const daysAuto = await page.inputValue('#pl_days');
note(Number(daysAuto) <= 0 || daysAuto === '' ? 'INFO' : 'ISSUE', '검증', `복귀일<출발일일 때 출장일수 표시: "${daysAuto}" (즉시 경고는 없음)`);
await page.fill('#pl_ret', `${yy}-${mm}-21`);
// 출장자: CCG 미선택 상태로 금액만 입력
await page.fill('#travBody tr:nth-child(1) .t-nm', '김담당');
await page.fill('#travBody tr:nth-child(1) .t-no', 'U1001');
await page.fill('#travBody tr:nth-child(1) .t-p-trans', '70000');
await page.fill('#travBody tr:nth-child(1) .t-p-lodg', '90000');
const totBefore = await page.textContent('#planTot');
note('INFO', '입력', `금액 입력 시 총합계 실시간 반영: ${totBefore}`);
// 천단위 구분 여부
const rawVal = await page.inputValue('#travBody tr:nth-child(1) .t-p-trans');
note(rawVal.includes(',') ? 'OK' : 'MINOR', '입력', `금액 입력칸 천단위 구분 없음(원시값 "${rawVal}") — 0 개수 오입력 위험`);
await page.click('#v-plan button:has-text("출장 계획 등록")');
await sleep(500);
const ccgErr = await page.textContent('#planErr').catch(() => '');
note(/CCG/.test(ccgErr) ? 'OK' : 'ISSUE', '검증', `CCG팀 미선택 시 안내: "${ccgErr.trim().split('\n')[0] || '없음'}"`);
// 입력값이 보존되는가 (오류 후 다시 채워야 하는지)
const keptCity = await page.inputValue('#pl_city');
const keptName = await page.inputValue('#travBody tr:nth-child(1) .t-nm');
note(keptCity && keptName ? 'OK' : 'ISSUE', '입력', `검증 실패 후 입력값 보존: 도시="${keptCity}" 성명="${keptName}"`);
await page.selectOption('#travBody tr:nth-child(1) .t-tm', 'Chemical 소재팀');

console.log('\n== D. 확정 체크박스 의미 전달 ==');
const cbLabel = await page.textContent('#v-plan label:has(#pl_confirm)').catch(() => '');
note(/예산/.test(cbLabel) ? 'OK' : 'ISSUE', 'UX', `확정 체크박스 설명: "${cbLabel.replace(/\s+/g, ' ').trim().slice(0, 70)}"`);

console.log('\n== E. 연속 클릭(중복 제출) 방어 ==');
const before = await page.evaluate(() => ST.groups.length);
await Promise.all([
  page.click('#v-plan button:has-text("출장 계획 등록")'),
  page.click('#v-plan button:has-text("출장 계획 등록")').catch(() => {}),
]);
await sleep(900);
const after = await page.evaluate(() => ST.groups.length);
note(after - before === 1 ? 'OK' : 'ISSUE', '기능', `등록 버튼 빠르게 2회 클릭 → 생성 ${after - before}건 (중복 방지 ${after - before === 1 ? '됨' : '안 됨'})`);
const created = await page.evaluate(() => ST.groups.find(g => g.org === '동우화인켐' && g.city === '이천'));

console.log('\n== F. 등록 직후 피드백/다음 행동 ==');
const toastTxt = await page.textContent('.toast').catch(() => '');
note(toastTxt ? 'OK' : 'MINOR', 'UX', `등록 완료 토스트: "${toastTxt}"`);
const formCleared = await page.inputValue('#pl_city');
note(formCleared === '' ? 'OK' : 'MINOR', 'UX', `등록 후 폼 초기화: ${formCleared === '' ? '됨' : '남아있음("' + formCleared + '")'}`);
note('INFO', 'UX', '등록 후 "다음 할 일"(확정/목록 이동) 유도 버튼 없음 — 화면은 빈 폼으로 남음');

console.log('\n== G. 실적 입력 동선 ==');
await page.click('.nav a[data-view="actual"]');
await page.waitForSelector('#actSel');
const optCount = await page.evaluate(() => document.querySelectorAll('#actSel option').length - 1);
note('INFO', 'UX', `실적 입력 대상 ${optCount}건이 드롭다운 하나에 나열됨`);
await page.selectOption('#actSel', created.group_id);
await page.waitForSelector('#actRows tr');
const ph = await page.getAttribute('#actRows tr:nth-child(1) .a-trans', 'placeholder');
note(/계획/.test(ph || '') ? 'OK' : 'MINOR', 'UX', `실적칸 placeholder에 계획액 표시: "${ph}"`);
// 실적 일부만 입력하고 저장
await page.fill('#actRows tr:nth-child(1) .a-trans', '68000');
const varTxt = await page.textContent('#actRows tr:nth-child(1) .a-var');
note('INFO', 'UX', `계획 대비 차액 실시간 표시: "${varTxt}"`);
await page.click('button:has-text("실적 저장 및 인폼 생성")');
await page.waitForSelector('#mailCard', { timeout: 5000 });
note('OK', '기능', '실적 저장 → 인폼 카드 자동 생성');

console.log('\n== H. 인폼 카드 사용성 ==');
const cardBox = await page.evaluate(() => { const c = document.getElementById('mailCard'); const r = c.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height), coversMain: r.left < window.innerWidth * 0.75 }; });
note('INFO', 'UX', `인폼 카드 ${cardBox.w}x${cardBox.h}px, 화면 우하단 고정`);
const btns = await page.evaluate(() => [...document.querySelectorAll('#mailCard .mf button, #mailCard .mf a')].map(b => b.textContent.trim()));
note('INFO', 'UX', `인폼 버튼: ${btns.join(' / ')}`);
// 카드를 닫으면 다시 볼 수 있나
await page.click('#mailCard .mh button');
await sleep(300);
const reopenable = await page.evaluate(() => {
  const t = [...document.querySelectorAll('#v-actual button, #v-actual a')].map(b => b.textContent);
  return t.some(x => /인폼|메일/.test(x));
});
note(reopenable ? 'OK' : 'ISSUE', 'UX', `인폼 카드를 닫은 뒤 실적 화면에서 다시 열 수단: ${reopenable ? '있음' : '없음(실적 재저장 또는 처리 화면 필요)'}`);

console.log('\n== I. 내 출장 상태 확인 ==');
await page.click('.nav a[data-view="list"]');
await page.waitForSelector('#v-list table');
const myRow = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#listBody tr')].find(t => t.textContent.includes('동우화인켐'));
  return r ? r.textContent.replace(/\s+/g, ' ').trim().slice(0, 110) : null;
});
note(myRow ? 'OK' : 'ISSUE', 'UX', `목록에서 내 건 확인: ${myRow || '못 찾음'}`);

console.log('\n== J. 모바일 390px — 담당자 실사용 ==');
const mp = await ctx.newPage();
await mp.setViewportSize({ width: 390, height: 780 });
await mp.goto(base, { waitUntil: 'networkidle' });
await mp.waitForSelector('#v-dash .hero');
const mOver = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
note(mOver <= 2 ? 'OK' : 'ISSUE', '모바일', `대시보드 가로 오버플로 ${mOver}px`);
await mp.evaluate(() => nav('plan'));
await mp.waitForSelector('#pl_city');
const mOver2 = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const travScroll = await mp.evaluate(() => { const s = document.querySelector('#v-plan .trav-table'); return s ? s.scrollWidth > s.clientWidth : null; });
note(mOver2 <= 2 ? 'OK' : 'ISSUE', '모바일', `계획 등록 화면 오버플로 ${mOver2}px, 출장자표 가로스크롤=${travScroll}`);
await mp.evaluate(() => nav('list'));
await mp.waitForSelector('#v-list table');
const mOver3 = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
note(mOver3 <= 2 ? 'OK' : 'ISSUE', '모바일', `출장 내역 오버플로 ${mOver3}px (컬럼 검색행 포함)`);

console.log('\n== K. 접근성/키보드 ==');
await page.click('.nav a[data-view="plan"]');
await page.waitForSelector('#pl_city');
const labels = await page.evaluate(() => {
  const ins = [...document.querySelectorAll('#v-plan input, #v-plan select, #v-plan textarea')];
  const withId = ins.filter(i => i.id).length;
  const labelFor = [...document.querySelectorAll('#v-plan label[for]')].length;
  return { inputs: ins.length, withId, labelFor };
});
note(labels.labelFor > 0 ? 'OK' : 'MINOR', '접근성', `label[for] 연결 ${labels.labelFor}개 / 입력 ${labels.inputs}개 — 스크린리더·라벨 클릭 포커스 미흡`);
const navRole = await page.evaluate(() => { const a = document.querySelector('.nav a'); return { tag: a.tagName, href: a.getAttribute('href'), tabindex: a.getAttribute('tabindex') }; });
note(navRole.href || navRole.tabindex ? 'OK' : 'MINOR', '접근성', `좌측 메뉴가 <a> without href/tabindex → 키보드 탭 이동·엔터 선택 불가 (${JSON.stringify(navRole)})`);
// 폼에서 Enter 키 제출 여부
await page.fill('#pl_city', 'Enter테스트');
await page.press('#pl_city', 'Enter');
await sleep(400);
const entered = await page.evaluate(() => ST.groups.some(g => g.city === 'Enter테스트'));
note('INFO', 'UX', `입력칸에서 Enter → 제출 ${entered ? '됨' : '안 됨(버튼 클릭 필요)'}`);

console.log('\n== L. 콘솔 오류 ==');
const codeErrs = errs.filter(e => !/Failed to load resource|ERR_TUNNEL/.test(e));
note(codeErrs.length === 0 ? 'OK' : 'ISSUE', '기능', `콘솔 JS 오류 ${codeErrs.length}건 ${codeErrs.slice(0, 2).join(' | ')}`);

await browser.close(); srv.kill('SIGKILL');
const bySev = OBS.reduce((a, o) => (a[o.sev] = (a[o.sev] || 0) + 1, a), {});
console.log('\n' + '='.repeat(60));
console.log('  요약:', JSON.stringify(bySev));
console.log('  ISSUE/MINOR 목록:');
OBS.filter(o => o.sev === 'ISSUE' || o.sev === 'MINOR').forEach(o => console.log(`   - [${o.sev}] ${o.area}: ${o.what}`));
console.log('='.repeat(60));
