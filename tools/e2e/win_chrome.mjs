/* 실행: node tools/e2e/win_chrome.mjs   (저장소 루트에서)
   윈도우 데스크톱 크롬 기준 점검 — 실제 서버를 띄우고 모든 화면을 훑는다.
   보는 것: 콘솔 오류 · 페이지 예외 · 실패 요청 · 가로 스크롤 · 글자 잘림 · 요소 겹침 ·
            버튼 클릭 크기 · 포커스 표시 · 모달/메뉴/인폼 동작 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
const _req = createRequire(import.meta.url);
const { chromium } = _req(process.env.PLAYWRIGHT_PATH || 'playwright');
const REPO = process.env.TB_REPO || process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tb_chrome_'));
const PORT = 5188;
let P = 0, F = 0;
const ok = (n, c, got) => { if (c) { P++; console.log(`  PASS  ${n}`); }
  else { F++; console.log(`  FAIL  ${n} -> ${JSON.stringify(got)}`); } };

// 이전 실행이 남긴 서버가 같은 포트에 살아 있으면 '낡은 화면'을 재게 된다 — 조용한 통과를 막는다
await new Promise((res, rej) => {
  const s = net.createServer();
  s.once('error', () => rej(new Error(`포트 ${PORT} 가 이미 쓰이고 있습니다. 이전 실행의 서버를 먼저 끄세요.`)));
  s.once('listening', () => s.close(res));
  s.listen(PORT, '127.0.0.1');
});
fs.copyFileSync(path.join(REPO, 'data.example.json'), path.join(TMP, 'data.json'));
const srv = spawn('python3', ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(REPO)})
from flask import Flask
from servera.travelbudget import travelbudget
app = Flask(__name__); app.register_blueprint(travelbudget)
app.run(host='127.0.0.1', port=${PORT}, threaded=True)`],
  { env: { ...process.env, TB_DATA_DIR: TMP }, stdio: 'ignore' });
await sleep(3500);

const errs = [], pageErrs = [], failed = [];
const b = await chromium.launch();

// 윈도우 데스크톱 크롬을 흉내낸다 — UA · 화면 크기 · 배율
for (const [w, h, label] of [[1366, 768, '1366×768 (노트북)'], [1920, 1080, '1920×1080 (데스크톱)']]) {
  const ctx = await b.newContext({
    viewport: { width: w, height: h }, deviceScaleFactor: 1,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const p = await ctx.newPage();
  p.on('console', m => { if (m.type() === 'error') errs.push(`${label} ${m.text().slice(0, 160)}`); });
  p.on('pageerror', e => pageErrs.push(`${label} ${String(e).slice(0, 160)}`));
  p.on('requestfailed', r => failed.push(`${label} ${r.url().slice(0, 120)}`));

  console.log(`\n== ${label} ==`);
  await p.goto(`http://127.0.0.1:${PORT}/travelbudget/`);
  await p.waitForTimeout(1500);
  // 관리 화면은 담당자 인증이 필요하다 — 공개된 사내 비밀번호로 미리 들어가 둔다
  await p.evaluate(() => sessionStorage.setItem('tb_pw', '2071478'));

  const VIEWS = ['dash', 'plan', 'bulk', 'actual', 'list', 'process', 'budget', 'config', 'data', 'guide'];
  for (const v of VIEWS) {
    await p.click(`.nav a[data-view="${v}"]`);
    await p.waitForTimeout(450);
    const r = await p.evaluate(() => {
      const de = document.documentElement;
      const vis = e => e.checkVisibility && e.checkVisibility();
      // 잘린 글자 — 넘치는데 말줄임도 스크롤도 없는 칸
      const clipped = [...document.querySelectorAll('td,th,label,.btn,h1,h2,.status,.nav a')]
        .filter(e => e.checkVisibility && e.checkVisibility())
        .filter(e => e.scrollWidth > e.clientWidth + 1)
        .filter(e => {
          const cs = getComputedStyle(e);
          return cs.textOverflow !== 'ellipsis' && cs.overflowX === 'visible';
        })
        .map(e => `${e.tagName}.${e.className}`.slice(0, 40));
      // 세로로 겹치는 카드 (레이아웃 깨짐)
      const cards = [...document.querySelectorAll('main .card, main .hero')]
        .filter(e => e.checkVisibility && e.checkVisibility())
        .map(e => e.getBoundingClientRect());
      let overlap = 0;
      for (let i = 1; i < cards.length; i++)
        if (cards[i].top < cards[i - 1].bottom - 1) overlap++;
      // 너무 작은 클릭 대상
      const tiny = [...document.querySelectorAll('button,.btn,.nav a,summary')]
        .filter(e => e.checkVisibility && e.checkVisibility())
        .filter(e => { const r = e.getBoundingClientRect(); return r.height > 0 && r.height < 24; })
        .map(e => `${e.className}:${Math.round(e.getBoundingClientRect().height)}px`);
      // 한 행 안의 입력칸들이 서로 다른 높이로 그려지면 줄이 우글거려 보인다
      const jitter = [];
      document.querySelectorAll('main tr, main .filter-row').forEach(row => {
        const ctl = [...row.querySelectorAll('input:not([type=hidden]):not([type=checkbox]),select,button')]
          .filter(vis);
        if (ctl.length < 2) return;
        const tops = ctl.map(e => Math.round(e.getBoundingClientRect().top));
        const spread = Math.max(...tops) - Math.min(...tops);
        if (spread > 1) jitter.push(`${row.className || row.tagName}:${spread}px`);
      });
      return { over: de.scrollWidth - de.clientWidth, clipped: [...new Set(clipped)], overlap,
               tiny: [...new Set(tiny)], jitter: [...new Set(jitter)] };
    });
    ok(`${v} — 가로 스크롤 없음`, r.over <= 0, r.over);
    ok(`${v} — 한 줄 안의 입력칸 눈높이 같음`, r.jitter.length === 0, r.jitter.slice(0, 3));
    ok(`${v} — 잘린 글자 없음`, r.clipped.length === 0, r.clipped.slice(0, 4));
    ok(`${v} — 카드 겹침 없음`, r.overlap === 0, r.overlap);
    ok(`${v} — 클릭 대상 24px 이상`, r.tiny.length === 0, r.tiny.slice(0, 4));
  }

  // 실제 조작 — 행 메뉴 · 모달 · 인폼 카드 · 붙여넣기
  if (w === 1366) {
    await p.click('.nav a[data-view="list"]'); await p.waitForTimeout(500);
    await p.click('details.rowmenu summary'); await p.waitForTimeout(300);
    const popIn = await p.evaluate(() => {
      const el = document.querySelector('.rowmenu-pop');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { right: Math.round(r.right), win: window.innerWidth, bottom: Math.round(r.bottom), wh: window.innerHeight };
    });
    ok('행 메뉴가 화면 밖으로 안 나감', popIn && popIn.right <= popIn.win + 1, popIn);
    await p.keyboard.press('Escape'); await p.waitForTimeout(200);
    ok('Esc 로 메뉴 닫힘', await p.evaluate(() => !document.querySelector('details.rowmenu[open]')));

    await p.click('.nav a[data-view="bulk"]'); await p.waitForTimeout(400);
    await p.click('button:has-text("예시 넣어보기")'); await p.waitForTimeout(600);
    const prev = await p.evaluate(() => (document.querySelector('#bkOut')?.innerText || '').length);
    ok('붙여넣기 미리보기 뜸', prev > 20, prev);
    const mono = await p.evaluate(() => getComputedStyle(document.querySelector('#bkText')).fontFamily);
    ok('붙여넣기 칸이 고정폭', /monospace|Consolas/.test(mono), mono);

    // 포커스 표시 — 키보드로만 쓰는 사람
    await p.click('.nav a[data-view="plan"]'); await p.waitForTimeout(400);
    await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
    const fo = await p.evaluate(() => {
      const e = document.activeElement; if (!e) return null;
      const cs = getComputedStyle(e);
      return { tag: e.tagName, outline: cs.outlineWidth, style: cs.outlineStyle };
    });
    ok('키보드 포커스가 눈에 보임', fo && parseFloat(fo.outline) >= 2 && fo.style !== 'none', fo);

    // 인쇄 미리보기에서 조작 UI 가 빠지는가
    await p.click('.nav a[data-view="list"]'); await p.waitForTimeout(400);
    await p.emulateMedia({ media: 'print' });
    const pr = await p.evaluate(() => ({
      aside: getComputedStyle(document.querySelector('aside')).display,
      pick: [...document.querySelectorAll('td.pick')].filter(e => getComputedStyle(e).display !== 'none').length,
      menu: [...document.querySelectorAll('details.rowmenu')].filter(e => getComputedStyle(e).display !== 'none').length,
    }));
    ok('인쇄에서 사이드바·선택칸·메뉴 숨김',
       pr.aside === 'none' && pr.pick === 0 && pr.menu === 0, pr);
    await p.emulateMedia({ media: 'screen' });
  }

  // 출장자용 안내(인쇄물)
  await p.goto(`http://127.0.0.1:${PORT}/travelbudget/guide`);
  await p.waitForTimeout(900);
  const g = await p.evaluate(() => {
    const de = document.documentElement;
    const imgs = [...document.querySelectorAll('img')];
    return { over: de.scrollWidth - de.clientWidth,
             broken: imgs.filter(i => !i.complete || i.naturalWidth === 0).length,
             wide: imgs.filter(i => i.getBoundingClientRect().width > i.parentElement.clientWidth + 1).length };
  });
  ok('안내문 — 가로 스크롤 없음', g.over <= 0, g.over);
  ok('안내문 — 깨진 그림 없음', g.broken === 0, g.broken);
  ok('안내문 — 그림이 칸을 넘지 않음', g.wide === 0, g.wide);
  await ctx.close();
}

ok('콘솔 오류 0건', errs.length === 0, errs.slice(0, 3));
ok('JS 예외 0건', pageErrs.length === 0, pageErrs.slice(0, 3));
ok('실패한 요청 0건', failed.length === 0, failed.slice(0, 3));

await b.close();
srv.kill();
console.log(`\n${'='.repeat(52)}\n  윈도우 크롬 점검  ${P} passed / ${F} failed\n${'='.repeat(52)}`);
process.exit(F ? 1 : 0);
