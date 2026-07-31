/* 실행: node tools/e2e/bulk_debug.mjs   (저장소 루트에서, Playwright 필요) */
/* 엑셀 붙여넣기 파서 적대적 검증 — 실제 엑셀 복사는 지저분하다 */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
const _req = createRequire(import.meta.url);
const pw = _req(process.env.PLAYWRIGHT_PATH || 'playwright');
const REPO = process.env.TB_REPO || process.cwd(), TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tbbd_'));
execFileSync('python3', ['-c', `import sys,json,os;sys.path.insert(0,r'${REPO}')\nfrom servera.travelbudget import store\nos.makedirs(r'${TMP}',exist_ok=True)\nopen(os.path.join(r'${TMP}','data.json'),'w',encoding='utf-8').write(json.dumps(store.example_data(),ensure_ascii=False))`], { cwd: REPO });
const srv = spawn('python3', ['-c', `import sys,os;os.environ['TB_DATA_DIR']=r'${TMP}';sys.path.insert(0,r'${REPO}');from webmain import app;app.run(port=5360)`], { cwd: REPO, stdio: 'ignore' });
await sleep(3000);
const b = await pw.chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
const errs = []; p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('http://127.0.0.1:5360/travelbudget/', { waitUntil: 'networkidle' });
await p.waitForFunction(() => document.querySelector('#v-dash .hero'), { timeout: 8000 });
await p.evaluate(() => nav('bulk'));
await p.waitForSelector('#bkText');

let P = 0, F = 0;
const ok = (n, c, g) => { c ? (P++, console.log('  PASS  ' + n)) : (F++, console.log('  FAIL  ' + n + ' -> ' + JSON.stringify(g))); };

// 파서를 직접 호출해 결과 검사 (등록까지 하지 않음)
const parse = t => p.evaluate(txt => { try { const r = bParse(txt);
  return {n: r.groups.length, errs: r.errs, g: r.groups.map(x => ({city:x.city, org:x.org, dep:x.dep_dt, ret:x.ret_dt,
    kind:x.kind, car:x.car, pt:x.plan_type, t:x.travelers.map(v=>({nm:v.name, no:v.emp_no, rk:v.rank, cc:v.ccg_nm,
    p:[v.p_trans,v.p_lodg,v.p_meal,v.p_etc], a:[v.a_trans,v.a_lodg,v.a_meal,v.a_etc]}))}))}; }
  catch (e) { return {throw: e.message}; } }, t);

const H = '구분\tCCG명\t사번\t성명\t직책\t출장도시\t출장기관&업체\t출장목적&사유\t출발일자\t복귀일자\t자차사용여부\t출장구분\t계획_교통비\t계획_숙박비\t계획_식대&잡비\t계획_기타';
const row = (o) => ['계획', o.cc??'EDTW소재기술', o.no??'1001', o.nm??'홍길동', o.rk??'TL',
  o.city??'청주', o.org??'원익', o.pp??'정기 실사', o.dep??'2026-08-04', o.ret??'2026-08-05',
  o.car??'미사용', o.kind??'정기 Audit', o.t1??'70000', o.t2??'0', o.t3??'0', o.t4??''].join('\t');

console.log('\n== A. 실제 엑셀 복사가 만드는 지저분함 ==');
let r = await parse(H + '\n' + row({}) + '\n');                     // 끝에 빈 줄
ok('끝 빈 줄 무시', r.n === 1 && !r.errs.length, r);
r = await parse(H + '\n' + row({}) + '\n\t\t\t\t\t\t\t\t\n' + row({no:'1002', nm:'김', dep:'2026-08-11', city:'이천'}));
ok('중간 빈 행(탭만) 무시', r.n === 2, {n:r.n, errs:r.errs});
r = await parse(H + '\r\n' + row({}) + '\r\n');                      // CRLF
ok('CRLF 처리', r.n === 1 && !r.errs.length, r.errs);
r = await parse(H + '\n' + row({}) + '\t\t\t');                      // 뒤쪽 여분 탭
ok('여분 탭 무시', r.n === 1, r.errs);
r = await parse(H.replace(/\t/g, ',') + '\n' + row({}).replace(/\t/g, ','));
ok('CSV(콤마) 붙여넣기도 인식', r.n === 1 && r.g[0].city === '청주', r);
r = await parse(H + '\n' + row({}).replace('청주', ' 청주 ').replace('원익', ' 원익 '));
ok('앞뒤 공백 제거', r.n === 1 && r.g[0].city === '청주' && r.g[0].org === '원익', r.g[0]);

console.log('\n== B. 날짜 표기 (엑셀에서 오는 온갖 형태) ==');
for (const [inp, want] of [['2026-08-04','2026-08-04'], ['2026.8.4','2026-08-04'],
     ['2026/8/4','2026-08-04'], ['26-08-04','2026-08-04'], ['2026년 8월 4일','2026-08-04'],
     ['46238','2026-08-04']]) {
  const rr = await parse(H + '\n' + row({dep: inp, ret: inp}));
  ok(`날짜 "${inp}" → ${want}`, rr.n === 1 && rr.g[0].dep === want, rr.n ? rr.g[0].dep : rr.errs);
}
r = await parse(H + '\n' + row({dep:'2026-08-04', ret:''}));
ok('복귀일 비면 당일 처리', r.n === 1 && r.g[0].ret === '2026-08-04', r.n ? r.g[0] : r.errs);
r = await parse(H + '\n' + row({dep:'2026-08-05', ret:'2026-08-04'}));
ok('복귀<출발 은 등록 시 서버가 거부(파서는 통과)', r.n === 1, r.errs);
r = await parse(H + '\n' + row({dep:'날짜아님'}));
ok('깨진 날짜는 행 번호로 오류', r.n === 0 && r.errs[0].includes('2행') && r.errs[0].includes('출발일자'), r.errs);

console.log('\n== C. CCG 팀명 인식 (표기가 제각각) ==');
for (const [inp, want] of [['EDTW소재기술','EDTW소재기술'], ['edtw소재기술','EDTW소재기술'],
     ['EDTW 소재기술','EDTW소재기술'], ['50119134','EDTW소재기술'], ['C&C소재기술','C&C소재기술'],
     ['  Patterning소재기술  ','Patterning소재기술'], ['소재전략','소재전략']]) {
  const rr = await parse(H + '\n' + row({cc: inp}));
  ok(`CCG "${inp.trim()}" → ${want}`, rr.n === 1 && rr.g[0].t[0].cc === want, rr.n ? rr.g[0].t[0].cc : rr.errs);
}
/* 앞이 같은 팀이 둘 이상이면 추측하면 안 된다.
   'Patterning소재' 는 기술/개발 둘 다에 걸린다 — 먼저 찾은 것을 쓰면 개발 건이 기술로 새어 들어간다. */
for (const amb of ['Patterning소재', 'C&C소재', 'EDTW소재']) {
  const rr = await parse(H + '\n' + row({cc: amb}));
  ok(`앞이 겹치는 "${amb}" 는 추측 안 함`, rr.n === 0 && String(rr.errs).includes(amb),
     rr.n ? rr.g[0].t[0].cc : rr.errs);
}
r = await parse(H + '\n' + row({cc:'없는팀'}));
ok('모르는 팀은 오류로 알림(추측 안 함)', r.n === 0 && r.errs[0].includes('없는팀'), r.errs);

console.log('\n== D. 금액 ==');
for (const [inp, want] of [['70000',70000], ['70,000',70000], ['70,000원',70000],
     [' 70000 ',70000], ['0',0], ['',0], ['-5000',5000], ['70000.4',70000]]) {
  const rr = await parse(H + '\n' + row({t1: inp}));
  ok(`금액 "${inp}" → ${want}`, rr.n === 1 && rr.g[0].t[0].p[0] === want, rr.n ? rr.g[0].t[0].p[0] : rr.errs);
}

console.log('\n== E. 동행자 묶기 ==');
r = await parse(H + '\n' + row({no:'1', nm:'A'}) + '\n' + row({no:'2', nm:'B', cc:'Patterning소재기술'}));
ok('같은 출장 2명 → 1건 2인', r.n === 1 && r.g[0].t.length === 2, {n:r.n, t:r.n&&r.g[0].t.length});
r = await parse(H + '\n' + row({no:'1', nm:'A'}) + '\n' + row({no:'1', nm:'A'}));
ok('같은 출장 사번 중복 → 오류', r.n === 1 && r.g[0].t.length === 1 && r.errs.some(e=>e.includes('중복')), r.errs);
r = await parse(H + '\n' + row({no:'1', nm:'A'}) + '\n' + row({no:'1', nm:'A', dep:'2026-08-20', ret:'2026-08-21'}));
ok('다른 일자면 별건 (사번 재사용 허용)', r.n === 2, {n:r.n, errs:r.errs});
r = await parse(H + '\n' + row({no:'1', pp:'목적A'}) + '\n' + row({no:'2', pp:'목적B'}));
ok('목적 다르면 별건', r.n === 2, r.n);

console.log('\n== F. 머리글 없이 센터 27필드 순서 ==');
const c27 = ['계획','소재','50119134','EDTW소재기술','20140508','박영희','팀장','청주','원익머트리얼즈',
  'NF3 정기 Audit','2026-08-04','2026-08-05','','','자차사용','정기 Audit','','70000','95000','65000','10000',
  '','','','','',''].join('\t');
r = await parse(c27);
ok('머리글 없이 27필드 순서 인식', r.n === 1 && r.g[0].t[0].cc === 'EDTW소재기술'
   && r.g[0].t[0].p[0] === 70000 && r.g[0].car === '자차사용', r.n ? r.g[0] : r.errs);
r = await parse(c27 + '\n' + c27.replace('20140508','2071478').replace('박영희','이정훈'));
ok('27필드 동행 2명 묶기', r.n === 1 && r.g[0].t.length === 2, {n:r.n});

console.log('\n== G. 필수값 누락·이상 입력 ==');
r = await parse(H + '\n' + row({city:''}));
ok('도시 없음 → 행 번호 오류', r.n === 0 && r.errs[0].includes('출장도시'), r.errs);
r = await parse(H + '\n' + row({nm:'', no:''}));
ok('성명·사번 없음 → 둘 다 지적', r.n === 0 && r.errs[0].includes('성명') && r.errs[0].includes('사번'), r.errs);
r = await parse('');
ok('빈 붙여넣기', r.n === 0 && r.errs.length === 1, r.errs);
r = await parse('아무말\n두번째줄');
ok('엉뚱한 텍스트는 오류만', r.n === 0 && r.errs.length > 0 && !r.throw, r);
r = await parse(H + '\n' + row({nm:'<img src=x onerror=alert(1)>'}));
ok('XSS 문자열도 예외 없이 처리', r.n === 1 && !r.throw, r.throw || 'ok');
r = await parse(H + '\n' + row({kind:'없는구분'}));
ok('모르는 출장구분 → 기타', r.n === 1 && r.g[0].kind === '기타', r.n && r.g[0].kind);
r = await parse(H + '\n' + row({car:'자차'}));
ok('"자차" → 자차사용', r.n === 1 && r.g[0].car === '자차사용', r.n && r.g[0].car);
r = await parse(H + '\n' + Array.from({length: 60}, (_, i) => row({no:'E'+i, nm:'N'+i})).join('\n'));
ok('60행 한 번에 (동행 60인 1건)', r.n === 1 && r.g[0].t.length === 60, {n:r.n, t:r.n&&r.g[0].t.length});

console.log('\n== H. XSS 실제 렌더 ==');
let alerted = false; p.on('dialog', async d => { alerted = true; await d.dismiss(); });
await p.fill('#bkText', H + '\n' + row({nm:'<img src=x onerror=alert(1)>', org:'"><script>alert(2)</script>'}));
await sleep(500);
ok('미리보기에서 스크립트 미실행', !alerted);
ok('미리보기 HTML 이스케이프', (await p.innerHTML('#bkOut')).includes('&lt;img'), (await p.innerHTML('#bkOut')).slice(0, 80));

console.log('\n== I. 실제 등록까지 (서버 검증과 맞물리는지) ==');
await p.fill('#bkText', H + '\n' + row({dep:'2026-08-05', ret:'2026-08-04', no:'BAD1'}));
await sleep(400);
const nb = await p.evaluate(() => ST.groups.length);
await p.click('#bkGo'); await sleep(1500);
const out = await p.textContent('#bkOut');
ok('복귀<출발은 서버가 거부하고 사유 표시', out.includes('실패') || out.includes('복귀'), out.slice(0, 80));
ok('실패 건은 저장되지 않음', (await p.evaluate(() => ST.groups.length)) === nb);

const codeErrs = errs.filter(e => !/status of 400|Failed to load resource/.test(e));
ok('콘솔 JS 에러 0건 (정상 400 거부 제외)', codeErrs.length === 0, codeErrs.slice(0, 3));
console.log(`\n${'='.repeat(52)}\n  붙여넣기 파서 디버깅  ${P} passed / ${F} failed\n${'='.repeat(52)}`);
await b.close(); srv.kill('SIGKILL');
process.exit(F ? 1 : 0);
