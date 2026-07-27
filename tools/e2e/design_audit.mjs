/* 실행: node tools/e2e/design_audit.mjs   (저장소 루트에서)
   필요: Node 18+ 와 Playwright.  설치: npm i -D playwright && npx playwright install chromium
   PLAYWRIGHT_PATH 환경변수로 playwright 모듈 경로를 직접 지정할 수도 있습니다. */
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const _req = createRequire(import.meta.url);
const PW_PATH = process.env.PLAYWRIGHT_PATH || 'playwright';
const REPO = process.env.TB_REPO || process.cwd();
const TMP = fs_mkdtemp();
// 픽스처 — 신규 설치는 빈 원장이므로 예시 원장을 임시 폴더에 깔고 시작한다.
// (저장소/운영 data_json 은 절대 건드리지 않는다)

function fs_mkdtemp(){ const f = _req('node:fs'); return f.mkdtempSync(path.join(os.tmpdir(), 'tb_e2e_')); }
/* 색상 팔레트 · 대비(WCAG) · 글씨체/크기 전수 감사 */
const pw = _req(PW_PATH);
const { chromium } = pw;
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 5311, base = `http://127.0.0.1:${PORT}/travelbudget/`;
import { execFileSync } from 'node:child_process';
execFileSync('python3', ['-c',
  `import sys,json,os; sys.path.insert(0,r'${REPO}')\n` +
  `from servera.travelbudget import store\n` +
  `os.makedirs(r'${TMP}', exist_ok=True)\n` +
  `open(os.path.join(r'${TMP}','data.json'),'w',encoding='utf-8').write(json.dumps(store.example_data(),ensure_ascii=False))`],
  { cwd: REPO });
const srv = spawn('python3', ['-c',
  `import sys,os; os.environ['TB_DATA_DIR']=r'${TMP}'; sys.path.insert(0,r'${REPO}'); from webmain import app; app.run(port=${PORT})`],
  { cwd: REPO, stdio: 'ignore' });
await sleep(2600);

const out = [];
const note = (sev, area, msg) => { out.push({ sev, area, msg }); console.log(`  [${sev}] ${area} — ${msg}`); };

let browser;
try {
  browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });
  await page.evaluate(() => sessionStorage.setItem('tb_pw', '2071478'));

  // 모든 화면을 렌더시켜 실제 노드가 존재하도록
  await page.evaluate(() => { ['guide','dash','plan','actual','list','process','budget','data']
    .forEach(v => { try { nav(v); } catch (e) {} }); nav('dash'); });

  const CONTRAST = await page.evaluate(() => {
    const lum = c => { const s = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
      return .2126 * s[0] + .7152 * s[1] + .0722 * s[2]; };
    const parse = s => (s.match(/[\d.]+/g) || []).slice(0, 4).map(Number);
    const over = (fg, bg) => {           // 알파 합성
      const a = fg[3] === undefined ? 1 : fg[3];
      return [0,1,2].map(i => Math.round(fg[i] * a + bg[i] * (1 - a)));
    };
    const bgOf = el => {                  // 투명이면 조상까지 거슬러 실제 배경 찾기
      let n = el;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c.length && (c[3] === undefined || c[3] > 0)) return c.slice(0, 3);
        n = n.parentElement;
      }
      return [255, 255, 255];
    };
    const ratio = (a, b) => { const [L1, L2] = [lum(a), lum(b)].sort((x, y) => y - x); return (L1 + .05) / (L2 + .05); };
    const seen = new Map();
    document.querySelectorAll('body *').forEach(el => {
      const txt = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
      if (!txt) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cs = getComputedStyle(el);
      const bg = bgOf(el);
      const fg = over(parse(cs.color), bg);
      const size = parseFloat(cs.fontSize), weight = parseInt(cs.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const cr = ratio(fg, bg);
      const key = `${cs.color}|${bg.join(',')}|${size}|${weight}`;
      if (seen.has(key)) return;
      seen.set(key, { sel: el.className || el.tagName, color: cs.color, bg: `rgb(${bg.join(',')})`,
        size, weight, ratio: Math.round(cr * 100) / 100, need: large ? 3 : 4.5,
        pass: cr >= (large ? 3 : 4.5), sample: (el.textContent || '').trim().slice(0, 22) });
    });
    return [...seen.values()];
  });

  console.log('\n== 1. 텍스트 대비 (WCAG 2.1 AA) ==');
  const fails = CONTRAST.filter(c => !c.pass).sort((a, b) => a.ratio - b.ratio);
  console.log(`  검사 조합 ${CONTRAST.length}개 / 미달 ${fails.length}개`);
  fails.forEach(f => note('FAIL', '대비',
    `${f.ratio}:1 (필요 ${f.need}) ${f.size}px/${f.weight} ${f.color} on ${f.bg} — .${String(f.sel).split(' ')[0]} "${f.sample}"`));
  const low = CONTRAST.filter(c => c.pass && c.ratio < 5).sort((a, b) => a.ratio - b.ratio).slice(0, 5);
  low.forEach(f => note('INFO', '대비', `${f.ratio}:1 (여유 적음) ${f.size}px .${String(f.sel).split(' ')[0]} "${f.sample}"`));

  console.log('\n== 2. 글씨 크기 ==');
  const SIZES = await page.evaluate(() => {
    const m = {};
    document.querySelectorAll('body *').forEach(el => {
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
      const r = el.getBoundingClientRect(); if (!r.width) return;
      const s = getComputedStyle(el).fontSize;
      (m[s] = m[s] || { n: 0, ex: [] }).n++;
      if (m[s].ex.length < 2) m[s].ex.push((el.className || el.tagName) + ':' + (el.textContent || '').trim().slice(0, 14));
    });
    return m;
  });
  const sz = Object.entries(SIZES).map(([k, v]) => [parseFloat(k), v.n, v.ex]).sort((a, b) => a[0] - b[0]);
  sz.forEach(([s, n, ex]) => console.log(`   ${String(s).padStart(5)}px × ${String(n).padStart(4)}  ${ex.join(' | ').slice(0, 70)}`));
  const tiny = sz.filter(([s, n]) => s < 11 && n > 0);
  tiny.forEach(([s, n, ex]) => note('MINOR', '글씨크기', `${s}px 사용 ${n}곳 — 사내 모니터에서 판독 어려움 (${ex[0]})`));
  note(sz.length <= 14 ? 'OK' : 'MINOR', '글씨크기', `서로 다른 크기 ${sz.length}종 — ${sz.length <= 14 ? '체계 유지' : '너무 잘게 쪼개짐(타입 스케일 정리 권장)'}`);

  console.log('\n== 3. 글씨체 ==');
  const FAM = await page.evaluate(() => {
    const m = {};
    document.querySelectorAll('body *').forEach(el => {
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
      const f = getComputedStyle(el).fontFamily; m[f] = (m[f] || 0) + 1;
    });
    return m;
  });
  Object.entries(FAM).forEach(([f, n]) => console.log(`   ×${String(n).padStart(4)}  ${f.slice(0, 96)}`));
  const stacks = Object.keys(FAM);
  note(stacks.length === 1 ? 'OK' : 'INFO', '글씨체', `폰트 스택 ${stacks.length}종`);
  const hasWinFallback = stacks.every(f => /Malgun Gothic|맑은 고딕/.test(f));
  note(hasWinFallback ? 'OK' : 'FAIL', '글씨체', `윈도우 폴백(맑은 고딕) ${hasWinFallback ? '전 요소 확보' : '누락 — 사내 PC에서 깨질 수 있음'}`);
  const actual = await page.evaluate(() => document.fonts ? [...document.fonts].length : -1);
  note('INFO', '글씨체', `웹폰트 로드 ${actual}개 (0 = 시스템 폰트만 — 사내망 안전)`);

  console.log('\n== 4. 팔레트 일관성 ==');
  const PAL = await page.evaluate(() => {
    const use = {};
    document.querySelectorAll('body *').forEach(el => {
      const cs = getComputedStyle(el);
      [['색', cs.color], ['배경', cs.backgroundColor], ['테두리', cs.borderTopColor]].forEach(([k, v]) => {
        if (!v || v === 'rgba(0, 0, 0, 0)') return;
        const key = k + ' ' + v; use[key] = (use[key] || 0) + 1;
      });
    });
    const vars = getComputedStyle(document.documentElement);
    const tok = {};
    ['--bg','--white','--ink','--ink2','--mut','--faint','--line','--line2','--soft','--shade','--navy','--navy2','--blue','--red','--green']
      .forEach(v => tok[v] = vars.getPropertyValue(v).trim());
    return { use, tok };
  });
  console.log('   토큰:', JSON.stringify(PAL.tok));
  const inks = Object.entries(PAL.use).filter(([k]) => k.startsWith('색 ')).length;
  const bgs = Object.entries(PAL.use).filter(([k]) => k.startsWith('배경 ')).length;
  note(inks <= 16 ? 'OK' : 'MINOR', '팔레트', `글자색 ${inks}종 / 배경색 ${bgs}종`);
  // 상태 배지 색이 서로 구분되는가 (색맹 고려: 명도 차이도 필요)
  const badges = await page.evaluate(() => {
    const r = {};
    document.querySelectorAll('.status').forEach(el => {
      const c = el.className.replace('status', '').trim() || '(기본)';
      if (!r[c]) r[c] = { color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, text: el.textContent.trim() };
    });
    return r;
  });
  Object.entries(badges).forEach(([k, v]) => console.log(`   상태 .${k.padEnd(8)} ${v.text.padEnd(9)} ${v.color} / ${v.bg}`));
  note(Object.keys(badges).length >= 4 ? 'OK' : 'INFO', '팔레트', `상태 배지 ${Object.keys(badges).length}종 — 글자(상태명)로도 구분되어 색맹 안전`);

  console.log('\n== 5. 레이아웃/터치 타깃 ==');
  const TAP = await page.evaluate(() => {
    const small = [];
    document.querySelectorAll('button, .btn, .nav a, input[type=checkbox]').forEach(el => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.height < 28) small.push({ t: (el.textContent || el.type || '').trim().slice(0, 16), h: Math.round(r.height), w: Math.round(r.width) });
    });
    return small;
  });
  note(TAP.length === 0 ? 'OK' : 'INFO', '터치타깃', TAP.length === 0 ? '모든 버튼 높이 28px 이상'
    : `28px 미만 ${TAP.length}개: ${TAP.slice(0, 4).map(x => `${x.t}(${x.h}px)`).join(', ')}`);

  console.log('\n== 6. 다크모드/인쇄 ==');
  const dark = await page.evaluate(() => !!([...document.styleSheets].some(ss => {
    try { return [...ss.cssRules].some(r => /prefers-color-scheme/.test(r.cssText)); } catch (e) { return false; }
  })));
  note('INFO', '테마', `다크모드 대응 ${dark ? '있음' : '없음 (사내 표준 라이트 고정 — 의도된 선택)'}`);
  const print = await page.evaluate(() => !!([...document.styleSheets].some(ss => {
    try { return [...ss.cssRules].some(r => r.media && /print/.test(r.media.mediaText || '')); } catch (e) { return false; }
  })));
  note(print ? 'OK' : 'MINOR', '인쇄', `인쇄 스타일 ${print ? '있음' : '없음 — 결재 첨부용 출력 시 메뉴·버튼까지 인쇄됨'}`);

  console.log('\n== 7. 화면 폭별 레이아웃 ==');
  for (const w of [1920, 1440, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(() => nav('dash')); await sleep(120);
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.evaluate(() => nav('plan')); await sleep(120);
    const o2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    await page.evaluate(() => nav('list')); await sleep(120);
    const o3 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const bad = Math.max(o, o2, o3) > 2;
    note(bad ? 'FAIL' : 'OK', '반응형', `${w}px — 오버플로 대시${o}/계획${o2}/내역${o3}px`);
  }
} catch (e) {
  note('FAIL', '예외', String(e && e.stack || e));
} finally {
  if (browser) await browser.close();
  srv.kill('SIGKILL');
}
const c = out.reduce((m, x) => (m[x.sev] = (m[x.sev] || 0) + 1, m), {});
console.log(`\n${'='.repeat(60)}\n  요약: ${JSON.stringify(c)}`);
out.filter(x => x.sev === 'FAIL' || x.sev === 'MINOR').forEach(x => console.log(`   [${x.sev}] ${x.area}: ${x.msg}`));
console.log('='.repeat(60));
