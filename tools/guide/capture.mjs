import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH);
const OUT = process.argv[2];
const srv = spawn('python3', ['-c', `
from servera.travelbudget import travelbudget
from flask import Flask
app=Flask(__name__); app.register_blueprint(travelbudget)
app.run(port=5701, threaded=True)`], { cwd: process.cwd(), stdio: 'ignore', env: { ...process.env, TB_DATA_DIR: process.env.SEED } });
await new Promise(r => setTimeout(r, 2500));
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1180, height: 1000 }, deviceScaleFactor: 1 });
await pg.goto('http://127.0.0.1:5701/travelbudget', { waitUntil: 'networkidle' });
await pg.waitForSelector('#v-dash .hmain');
const shot = async (sel, name) => {
  const el = await pg.$(sel);
  if (!el) { console.log('  ! 없음', sel); return; }
  await el.screenshot({ path: `${OUT}/${name}.png` });
  const r = await el.boundingBox();
  console.log(`  ${name}  ${Math.round(r.width)}×${Math.round(r.height)}`);
};

// 1. 계획 등록 — 실제로 채운 상태
await pg.evaluate(() => nav('plan'));
await pg.waitForSelector('#pl_city');
await pg.fill('#pl_city', '청주');
await pg.fill('#pl_org', '원익머트리얼즈');
await pg.fill('#pl_purpose', 'NF3 순도 관리 정기 Audit');
await pg.fill('#pl_dep', '2026-08-04');
await pg.fill('#pl_ret', '2026-08-05');
await pg.fill('#travBody tr:nth-child(1) .t-nm', '박영희');
await pg.fill('#travBody tr:nth-child(1) .t-no', '20140508');
await pg.selectOption('#travBody tr:nth-child(1) .t-tm', 'EDTW소재기술');
await pg.fill('#travBody tr:nth-child(1) .t-p-trans', '120000');
await pg.fill('#travBody tr:nth-child(1) .t-p-lodg', '100000');
await pg.fill('#travBody tr:nth-child(1) .t-p-meal', '70000');
await new Promise(r => setTimeout(r, 400));
await shot('#v-plan .card', 's1-plan');
// 2. 확정 체크박스
await pg.check('#pl_confirm');
await new Promise(r => setTimeout(r, 200));
// 체크박스 한 줄만 찍으면 18px 짜리 띠가 되어 뭘 보는지 알 수 없다 — 등록 버튼까지 함께
const box = await pg.evaluate(() => {
  const cb = document.querySelector('#pl_confirm').closest('label');
  const bt = document.querySelector('#planBtn');
  const a = cb.getBoundingClientRect(), c = bt.getBoundingClientRect();
  return { x: Math.min(a.left, c.left) - 12, y: a.top - 12,
           width: Math.max(a.right, c.right) - Math.min(a.left, c.left) + 24,
           height: c.bottom - a.top + 24 };
});
await pg.screenshot({ path: `${OUT}/s2-confirm.png`, clip: box });
console.log(`  s2-confirm  ${Math.round(box.width)}×${Math.round(box.height)}`);

// 3. 실적 입력 — 값이 들어간 표
await pg.evaluate(() => nav('actual'));
await pg.waitForSelector('#actSel');
const gid = await pg.evaluate(() => { const o=[...document.querySelector('#actSel').options].find(x=>x.value); return o&&o.value; });
await pg.selectOption('#actSel', gid);
await pg.waitForSelector('#actRows tr');
await pg.fill('#actRows tr:nth-child(1) .a-trans', '118000');
await pg.fill('#actRows tr:nth-child(1) .a-lodg', '95000');
await pg.fill('#actRows tr:nth-child(1) .a-meal', '68000');
await new Promise(r => setTimeout(r, 400));
await shot('#v-actual .card', 's3-actual');

// 4. 인폼 카드
await pg.evaluate(async () => { const g = ST.groups.find(x => x.act_tot > 0); await reopenMail(g.group_id); });
await pg.waitForSelector('#mailCard', { timeout: 5000 });
await new Promise(r => setTimeout(r, 500));
await shot('#mailCard', 's4-mail');
await pg.evaluate(() => { document.getElementById('mailCard')?.remove(); mailPad(); });

// 5. 출장 내역 — 상태 배지
await pg.evaluate(() => nav('list'));
await pg.waitForSelector('#listBody tr');
await new Promise(r => setTimeout(r, 400));
await shot('#v-list .card .scroll, #v-list .card', 's5-list');
await b.close(); srv.kill('SIGKILL');
