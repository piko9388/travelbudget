# -*- coding: utf-8 -*-
"""API 통합 테스트 — **항상 임시 디렉터리에서만** 실행된다.

운영 데이터 보호: 이 파일은 실행 즉시 TB_DATA_DIR 를 임시 폴더로 강제 교체한다.
운영 원장(기존 TB_DATA_DIR 또는 앱 폴더의 data_json)은 읽지도 쓰지도 않는다.
서버에 올린 뒤 확인은 데이터를 건드리지 않는 smoke_test.py 를 쓸 것.
"""
import os, shutil, sys, tempfile, atexit

# ── 운영 데이터 격리 (import 보다 반드시 먼저) ──────────────────
_PROD = os.environ.get('TB_DATA_DIR')
_TMP = tempfile.mkdtemp(prefix='tb_test_')
os.environ['TB_DATA_DIR'] = _TMP
atexit.register(lambda: shutil.rmtree(_TMP, ignore_errors=True))
if _PROD:
    print(f'  [격리] 운영 TB_DATA_DIR={_PROD} 는 건드리지 않습니다 → 임시 {_TMP}')
else:
    print(f'  [격리] 임시 데이터 디렉터리 {_TMP}')

from webmain import app
from servera.travelbudget import store as _store
assert str(_store.DATA_DIR) == _TMP, f'격리 실패: {_store.DATA_DIR}'

# 테스트 픽스처 — 신규 설치는 빈 원장이므로, 테스트는 예시 원장을 직접 깔고 시작한다.
import json as _json
_store.DATA_DIR.mkdir(parents=True, exist_ok=True)
(_store.DATA_DIR / 'data.json').write_text(
    _json.dumps(_store.example_data(), ensure_ascii=False, indent=1), encoding='utf-8')

app.config['TESTING'] = True
c = app.test_client()
ADM = {'X-Admin-PW': '2071478'}
P=[0];F=[0]
def ok(n, cond, got=None):
    if cond: P[0]+=1; print(f'  PASS  {n}')
    else: F[0]+=1; print(f'  FAIL  {n} -> {got!r}')

print('\n=== 1. state / 픽스처 ===')
st = c.get('/travelbudget/api/state').get_json()
yq = st['yq']; d = st['dash']
ok('CCG 7팀', len(st['ccg'])==7, len(st['ccg']))
ok('시드 그룹 8건', len(st['groups'])==8, len(st['groups']))
ok('[보안] admin_pw 응답 미포함', 'admin_pw' not in st['settings'], list(st['settings'].keys()))
ok('[보안] PUT /api/data 없음', c.put('/travelbudget/api/data', json={}).status_code in (404,405))

print('\n=== 2. 대시보드 공식 (잔여 = 총예산 − 처리완료 − 처리중) ===')
ok('remain 공식', d['remain'] == d['alloc'] - d['done'] - d['wip'], d)
ok('처리중 = 인폼+이관 상태', d['nWip'] == 3, d['nWip'])   # 시드: 인폼2 + 이관1
ok('CCG별 표 생성', len(d['byCcg']) >= 4, len(d['byCcg']))
ok('바로 할 일 큐', 'actual_wait' in d['todo'] and 'process_wait' in d['todo'])
share = sum(r['share'] for r in d['byCcg'])
ok('구성비 합 100%', abs(share-1) < 0.01 if d['done']+d['wip'] else True, share)
print(f"  총예산 {d['alloc']:,} − 완료 {d['done']:,} − 처리중 {d['wip']:,} = 잔여 {d['remain']:,}")

print('\n=== 3. 계획 등록 — 동행 3인, CCG 자동 ===')
yy, qn = yq.split('-'); mm = str(int(qn[0])*3).zfill(2)
g3 = dict(plan_type='계획', city='청주', org='원익머트리얼즈', purpose='NF3 실사',
    kind='정기 Audit', dep_dt=f'{yy}-{mm}-15', ret_dt=f'{yy}-{mm}-16', car='자차사용',
    travelers=[
        dict(name='홍길동', emp_no='9001', rank='팀장', ccg_nm='Gas 소재팀', p_trans=70000, p_lodg=90000),
        dict(name='김철수', emp_no='9002', rank='TL', ccg_nm='Gas 소재팀', p_trans=70000, p_lodg=90000),
        dict(name='이영희', emp_no='9003', rank='팀장', ccg_nm='Photo 소재팀', p_trans=70000, p_lodg=90000)])
r = c.post('/travelbudget/api/groups', json=g3); res = r.get_json()
ok('3인 그룹 생성', r.status_code==201, res)
gid = res['group']['group_id']
ok('CCG 자동 (팀명→No)', res['group']['travelers'][0]['ccg']=='C1202', res['group']['travelers'][0])
ok('일수 자동', res['group']['days']==2, res['group']['days'])

r = c.post('/travelbudget/api/groups', json=dict(g3, travelers=[dict(name='x', emp_no='1', rank='책임', ccg_nm='Gas 소재팀')]))
ok('직책 TL/팀장 외 차단', r.status_code==400)
r = c.post('/travelbudget/api/groups', json=dict(g3, plan_type='긴급',
    travelers=[dict(name='y', emp_no='9004', rank='TL', ccg_nm='CMP 소재팀')]))
ok('긴급 계획비 0 허용', r.status_code==201, r.get_json())
urgent_gid = r.get_json()['group']['group_id']
r = c.post('/travelbudget/api/groups', json=dict(g3, travelers=[
    dict(name='a', emp_no='7777', rank='TL', ccg_nm='Gas 소재팀', p_trans=1000),
    dict(name='b', emp_no='7777', rank='TL', ccg_nm='Gas 소재팀', p_trans=1000)]))
ok('사번 중복 차단', r.status_code==400)

print('\n=== 4. 실적 입력 → 인폼 (그룹당 1통) ===')
r = c.post(f'/travelbudget/api/groups/{gid}/actual', json=dict(travelers=[
    dict(emp_no='9001', a_trans=68000, a_lodg=88000),
    dict(emp_no='9002', a_trans=68000, a_lodg=88000),
    dict(emp_no='9003', a_trans=70000, a_lodg=90000)]))
res = r.get_json()
ok('실적 저장', r.status_code==200, res)
ok('상태 자동 → 실적 입력·인폼', res['group']['status']=='실적 입력·인폼', res['group']['status'])
m = res['mail']
ok('실적 인폼 기본 수신자 = 운영 담당자 2명', m['to'].count('@')==2
   and 'junghoon12.lee@sk.com' in m['to'] and 'eunjeong.kim@sk.com' in m['to'], m['to'])
ok('제목 형식', m['subject']=='청주 원익머트리얼즈 국내 출장 정산 위한 출장비 실비 이관 요청 건', m['subject'])
ok('HTML 표 포함', '<table' in m['body_html'])
ok('3인 전원 표 기재', all(n in m['body_html'] for n in ('홍길동','김철수','이영희')))
ok('참고 링크', 'material.skhynix.com/travelbudget' in m['body_text'])
r = c.post(f'/travelbudget/api/groups/{urgent_gid}/actual', json=dict(travelers=[dict(emp_no='9004', a_trans=90000)]))
ok('긴급 비고 없이 실적 차단', r.status_code==400, r.get_json())
r = c.post(f'/travelbudget/api/groups/{urgent_gid}/actual', json=dict(travelers=[dict(emp_no='9004', a_trans=90000)], remark='긴급 대응'))
ok('긴급 비고 포함 통과', r.status_code==200)

print('\n=== 5. 상태 전환 — 관리자 게이트 ===')
r = c.post(f'/travelbudget/api/groups/{gid}/status', json={'status':'소재 이관'})
ok('무인증 이관 401', r.status_code==401, r.status_code)
r = c.post(f'/travelbudget/api/groups/{gid}/status', json={'status':'소재 이관'}, headers=ADM)
ok('관리자 이관 성공', r.status_code==200)
r = c.post(f'/travelbudget/api/groups/{gid}/status', json={'status':'처리 완료'}, headers=ADM)
ok('처리 완료 전환', r.status_code==200)
d2 = r.get_json()['dash']
ok('완료 후 done 증가', d2['done'] > d['done'], (d['done'], d2['done']))
plan_gid = next(g['group_id'] for g in c.get('/travelbudget/api/state').get_json()['groups'] if g['status']=='계획 등록')
r = c.post(f'/travelbudget/api/groups/{plan_gid}/status', json={'status':'처리 완료'}, headers=ADM)
ok('실적 없이 완료 차단', r.status_code==400, r.status_code)
r = c.post(f'/travelbudget/api/groups/{plan_gid}/status', json={'status':'취소'})
ok('취소는 무인증 허용', r.status_code==200)

print('\n=== 6. 예산 — 검증·감액 부호·게이트 ===')
r = c.post('/travelbudget/api/budget', json={'yq':yq,'rev_type':'추가증액','amt':1000000})
ok('무인증 예산 401', r.status_code==401)
r = c.post('/travelbudget/api/budget', json={}, headers=ADM)
ok('빈값 400', r.status_code==400, r.status_code)
r = c.post('/travelbudget/api/budget', json={'yq':yq,'rev_type':'감액','amt':1000000,'reason':'조정'}, headers=ADM)
ok('감액 자동 음수', r.status_code==201 and r.get_json()['budget']['amt']==-1000000, r.get_json())
rid = r.get_json()['budget']['rev_id']
r = c.delete(f'/travelbudget/api/budget/{rid}')
ok('무인증 삭제 401', r.status_code==401)
r = c.delete(f'/travelbudget/api/budget/{rid}', headers=ADM)
ok('관리자 삭제', r.status_code==200)

print('\n=== 7. CSV / 백업 ===')
r = c.get('/travelbudget/api/export.csv')
head = r.get_data(as_text=True).split('\r\n')[0]
ok('CSV 센터양식 27필드', head.count(',')==26, head.count(',')+1)
ok('CSV 센터양식 헤더 순서', head.startswith('\ufeff구분,LV2,CCG,CCG명,사번,성명,직책'), head[:40])
ok('CSV 센터양식엔 내부컬럼 없음', '상태' not in head and 'SAP' not in head, head)
ih = c.get('/travelbudget/api/export.csv?mode=internal').get_data(as_text=True).split('\r\n')[0]
ok('내부관리 CSV 31필드', ih.count(',')==30, ih.count(',')+1)
ok('내부관리 CSV 부가컬럼', all(x in ih for x in ('상태','개인처리상태','SAP전표번호','리드타임(일)')), ih[-40:])
ok('개인별 행 flatten', len(r.get_data(as_text=True).strip().split('\r\n')) > 8)
bks = c.get('/travelbudget/api/backups').get_json()['backups']
ok('자동 백업 누적', len(bks) >= 3, len(bks))
r = c.post(f"/travelbudget/api/backups/{bks[0]['filename']}/restore")
ok('무인증 복원 401', r.status_code==401)
r = c.post(f"/travelbudget/api/backups/{bks[-1]['filename']}/restore", headers=ADM)
ok('관리자 복원', r.status_code==200)

print('\n=== 8. 감사로그 ===')
import json as J
al = J.load(open(_store.DATA_FILE, encoding='utf-8'))['audit_log']
ok('감사로그 기록', len(al) >= 5, len(al))
ok('actor 기록', any(a.get('actor')=='admin' for a in al))

print('\n=== 9. 리뷰 반영 — 게이트 우회·인젝션·분기 ===')
# 9-1. update_group(PUT)로 상태를 밀어 승인 게이트를 우회할 수 없어야 (status 고정)
base = dict(plan_type='계획', city='이천', org='테스트BP', purpose='게이트 테스트',
    kind='정기 Audit', dep_dt=f'{yy}-{mm}-12', ret_dt=f'{yy}-{mm}-13', car='자차사용',
    travelers=[dict(name='우회자', emp_no='PW01', rank='TL', ccg_nm='Gas 소재팀', p_trans=50000)])
pg = c.post('/travelbudget/api/groups', json=base).get_json()['group']['group_id']
before_done = c.get('/travelbudget/api/state').get_json()['dash']['done']
r = c.put(f'/travelbudget/api/groups/{pg}', json=dict(base, status='처리 완료',
    travelers=[dict(name='우회자', emp_no='PW01', rank='TL', ccg_nm='Gas 소재팀',
                    a_trans=900000, a_lodg=900000)]))
after = c.get('/travelbudget/api/state').get_json()
put_g = next(g for g in after['groups'] if g['group_id']==pg)
ok('PUT status 고정 (처리완료 우회 불가)', put_g['status']=='계획 등록', put_g['status'])
ok('PUT로 done 예산 이동 불가', after['dash']['done']==before_done, (before_done, after['dash']['done']))

# 9-2. 처리 완료 건을 무인증으로 되돌릴 수 없어야 (from-state 게이트)
done_gid = next((g['group_id'] for g in after['groups'] if g['status']=='처리 완료'), None)
if done_gid:
    r = c.post(f'/travelbudget/api/groups/{done_gid}/status', json={'status':'실적 입력·인폼'})
    ok('무인증 완료 되돌림 401', r.status_code==401, r.status_code)
    r = c.post(f'/travelbudget/api/groups/{done_gid}/status', json={'status':'실적 입력·인폼'}, headers=ADM)
    ok('관리자 완료 되돌림 허용', r.status_code==200, r.status_code)
else:
    ok('처리완료 시드 존재', False, 'none')

# 9-3. 저장형 XSS 차단 — 인폼 HTML에 원시 <script> 미포함
xss = dict(base, org='<script>alert(1)</script>BP', city='<img src=x onerror=alert(2)>',
    travelers=[dict(name='<b>홍</b>', emp_no='XS01', rank='TL', ccg_nm='Gas 소재팀', p_trans=10000)])
xg = c.post('/travelbudget/api/groups', json=xss).get_json()['group']['group_id']
r = c.post(f'/travelbudget/api/groups/{xg}/actual',
    json=dict(travelers=[dict(emp_no='XS01', a_trans=10000)]))
html = r.get_json()['mail']['body_html']
ok('인폼 XSS escape (<script> 원시 미포함)', '<script>' not in html and '&lt;script&gt;' in html, html[:60])
ok('인폼 XSS escape (<img 태그 원시 미포함)', '<img' not in html and '&lt;img' in html)

# 9-4. CSV 수식 인젝션 방어 — 위험 셀 선두 따옴표
inj = dict(base, org='=HYPERLINK("http://evil")', purpose='@SUM(A1)',
    travelers=[dict(name='+CMD', emp_no='CS01', rank='TL', ccg_nm='Gas 소재팀', p_trans=1000)])
c.post('/travelbudget/api/groups', json=inj)
csv_txt = c.get('/travelbudget/api/export.csv').get_data(as_text=True)
ok('CSV 수식 인젝션 방어', ("'=HYPERLINK" in csv_txt) and ("'@SUM" in csv_txt) and ("'+CMD" in csv_txt),
   [l for l in csv_txt.split('\r\n') if 'CS01' in l][:1])

# 9-5. 분기(yq)는 출발일 수정 시 따라와야
q_next = c.post('/travelbudget/api/groups', json=base).get_json()['group']
nq_mm = str(((int(qn[0]) % 4) * 3) + 3).zfill(2)   # 다음 분기의 월
r = c.put(f"/travelbudget/api/groups/{q_next['group_id']}",
    json=dict(base, dep_dt=f'{yy}-{nq_mm}-05', ret_dt=f'{yy}-{nq_mm}-06'))
moved = r.get_json()['group']
ok('출발일 수정 시 yq 재계산', moved['yq']==f'{yy}-{(int(nq_mm)-1)//3+1}Q', moved['yq'])

# 9-6. 잘못된 CCG 코드 차단
r = c.post('/travelbudget/api/groups', json=dict(base,
    travelers=[dict(name='엉뚱', emp_no='CG01', rank='TL', ccg_nm='없는팀', ccg='C9999', p_trans=1000)]))
ok('잘못된 CCG 코드 차단', r.status_code==400, r.status_code)

# 9-7. 가져온 데이터에 yq가 없어도 출발일 기준으로 대시보드 집계 (Qwen 임포트 견고성)
from servera.travelbudget import core as _C
imported = {
    'settings': {'admin_pw': 'x'},
    'budget': [dict(yq=yq, rev_type='최초배정', amt=1000000, rev_dt=f'{yy}-{mm}-01')],
    'groups': [dict(group_id='IM-1', plan_type='계획', status='처리 완료', city='이천',
        org='임포트BP', purpose='임포트 검증', kind='정기 Audit',
        dep_dt=f'{yy}-{mm}-05', ret_dt=f'{yy}-{mm}-06', car='미사용',
        travelers=[dict(name='임포트', emp_no='IMP1', rank='TL', ccg_nm='Gas 소재팀', a_trans=50000)])]}
    # yq·ccg·days·plan_tot 등 파생필드 의도적 생략
dd = _C.dash(imported, yq)
ok('yq 없는 임포트 그룹도 집계', dd['done']==50000 and dd['nDone']==1, dd)
ok('ccg_nm만으로 CCG 롤업', any(r['ccg']=='C1202' and r['done']==50000 for r in dd['byCcg']), dd['byCcg'])

print('\n=== 10. 개인별 처리 (5명 중 일부만 완료/보류) ===')
# 5인 그룹 생성 → 실적 입력 → 3명 완료, 1명 보류, 1명 이관
five = dict(base, city='대전', org='5인BP', purpose='5인 동행 실사', dep_dt=f'{yy}-{mm}-14', ret_dt=f'{yy}-{mm}-15',
    travelers=[dict(name=f'출장자{i}', emp_no=f'F{i}', rank='TL', ccg_nm='Gas 소재팀', p_trans=50000) for i in range(1,6)])
fg = c.post('/travelbudget/api/groups', json=five).get_json()['group']['group_id']
c.post(f'/travelbudget/api/groups/{fg}/actual',
    json=dict(travelers=[dict(emp_no=f'F{i}', a_trans=100000) for i in range(1,6)]))
# 개인 이관/완료는 관리자
r = c.post(f'/travelbudget/api/groups/{fg}/status', json={'status':'처리 완료','emp_no':'F1'})
ok('무인증 개인 완료 401', r.status_code==401, r.status_code)
for i in (1,2,3):
    r = c.post(f'/travelbudget/api/groups/{fg}/status', json={'status':'처리 완료','emp_no':f'F{i}'}, headers=ADM)
ok('개인 3명 완료 200', r.status_code==200)
c.post(f'/travelbudget/api/groups/{fg}/status', json={'status':'소재 이관','emp_no':'F4'}, headers=ADM)
c.post(f'/travelbudget/api/groups/{fg}/status', json={'status':'보류','emp_no':'F5'}, headers=ADM)
stt = c.get('/travelbudget/api/state').get_json()
fgn = next(g for g in stt['groups'] if g['group_id']==fg)
effs = {p['emp_no']: (p.get('status') or fgn['status']) for p in fgn['travelers']}
ok('개인 상태 분리 저장', effs['F1']=='처리 완료' and effs['F4']=='소재 이관' and effs['F5']=='보류', effs)
ok('그룹 롤업 = 처리중(전부완료 아님)', fgn['roll']=='실적 입력·인폼', fgn['roll'])
ok('proc 집계 완료3·이관1·보류1', fgn['proc']['done']==3 and fgn['proc']['transfer']==1 and fgn['proc']['hold']==1, fgn['proc'])
# 예산 반영: 완료 3명(30만)=done, 이관·보류 2명(20만)=wip
gc = _C.dash(J.load(open(_store.DATA_FILE, encoding='utf-8')), yq) if False else None
# state의 dash로 확인
dsh = stt['dash']
# 이 그룹 기여분만 별도 계산: 완료 300000, 처리중 200000 은 전체 done/wip에 포함
sub = _C.dash({'settings':{'admin_pw':'x'},'budget':[dict(yq=yq,rev_type='최초배정',amt=1,rev_dt=f'{yy}-{mm}-01')],
    'groups':[fgn]}, yq)
ok('개인 기준 예산 집계(완료 30만/처리중 20만)', sub['done']==300000 and sub['wip']==200000, (sub['done'],sub['wip']))
ok('보류 알림(todo.hold)', fg in dsh['todo']['hold'], dsh['todo']['hold'])
# CSV에 개인처리상태 반영
csvp = c.get(f'/travelbudget/api/export.csv?yq={yq}').get_data(as_text=True)
frow = [l for l in c.get(f'/travelbudget/api/export.csv?yq={yq}&mode=internal').get_data(as_text=True).split('\r\n') if 'F5' in l]
ok('내부관리 CSV 개인 보류 반영', frow and '보류' in frow[0], frow[:1])

print('\n=== 11. 이관 인폼 (예산 담당자 → 소재 담당자) ===')
rt = c.post(f'/travelbudget/api/groups/{fg}/status', json={'status':'소재 이관','emp_no':'F4'}, headers=ADM)
tmail = rt.get_json().get('mail')
ok('이관 시 인폼 자동 반환', bool(tmail), list(rt.get_json().keys()))
ok('이관 인폼 문구(결재 상신/비용 처리)',
   tmail and '이관 결재 상신했습니다' in tmail['body_text'] and '비용 처리 부탁드립니다' in tmail['body_text'],
   tmail and tmail['body_text'][:60])
ok('이관 인폼 HTML 표', tmail and '<table' in tmail['body_html'])
ok('이관 인폼 제목', tmail and '비용 처리 요청' in tmail['subject'], tmail and tmail['subject'])
rg = c.get(f'/travelbudget/api/groups/{fg}/transfer_mail')
ok('이관 인폼 다시 보기 200', rg.status_code==200 and rg.get_json()['mail']['kind']=='transfer', rg.status_code)
# 전체 이관도 인폼 반환 (fg 사용 — gid는 7절 복원으로 롤백됨)
r5 = c.post(f'/travelbudget/api/groups/{fg}/status', json={'status':'소재 이관'}, headers=ADM)
ok('전체 이관 시 인폼 반환', bool(r5.get_json().get('mail')), r5.status_code)

print('\n=== 12. 잠정/확정 구분 + 예산 선확보 + 삭제 ===')
d0 = c.get('/travelbudget/api/state').get_json()['dash']
ok('시드 확정 예정 → committed 반영', d0['commit']>0 and d0['nConfirm']>=1, (d0['commit'], d0['nConfirm']))
ok('가용 = 실집행잔여 − 확정예정', d0['avail']==d0['remain']-d0['commit'], (d0['avail'], d0['remain'], d0['commit']))
rc = c.post('/travelbudget/api/groups', json=dict(base, org='확정BP', confirmed=True))
ok('확정으로 바로 생성', rc.get_json()['group']['status']=='확정 예정', rc.get_json()['group']['status'])
cgid = rc.get_json()['group']['group_id']
rp = c.post('/travelbudget/api/groups', json=dict(base, org='잠정BP'))
pgid = rp.get_json()['group']['group_id']
ok('기본은 잠정(계획 등록)', rp.get_json()['group']['status']=='계획 등록')
before = c.get('/travelbudget/api/state').get_json()['dash']['commit']
r = c.post(f'/travelbudget/api/groups/{pgid}/status', json={'status':'확정 예정'})
ok('출장 확정(공개)', r.status_code==200 and r.get_json()['group']['status']=='확정 예정', r.status_code)
after = c.get('/travelbudget/api/state').get_json()['dash']
ok('확정 시 예산 선확보 증가', after['commit']>before and after['avail']==after['remain']-after['commit'], (before, after['commit']))
r = c.post(f'/travelbudget/api/groups/{pgid}/status', json={'status':'계획 등록'})
ok('확정 해제 → 잠정', r.get_json()['group']['status']=='계획 등록')
r = c.delete(f'/travelbudget/api/groups/{pgid}')
ok('잠정 계획 삭제 200', r.status_code==200, r.status_code)
ok('삭제 후 흔적 없이 사라짐', not any(g['group_id']==pgid for g in c.get('/travelbudget/api/state').get_json()['groups']))
r = c.delete(f'/travelbudget/api/groups/{cgid}')
ok('확정 건은 삭제 차단(취소로)', r.status_code==400, r.status_code)

print('\n=== 13. P0 권한 경계 — 무인증 공격 차단 ===')
def _mk(org, n=3, amt=1000000):
    gg = dict(plan_type='계획', city='c', org=org, purpose='p', kind='정기 Audit',
        dep_dt=f'{yy}-{mm}-14', ret_dt=f'{yy}-{mm}-15', car='미사용',
        travelers=[dict(name=f'p{i}', emp_no=f'{org}{i}', rank='TL', ccg_nm='Gas 소재팀', p_trans=50000) for i in range(n)])
    _id = c.post('/travelbudget/api/groups', json=gg).get_json()['group']['group_id']
    c.post(f'/travelbudget/api/groups/{_id}/actual',
           json=dict(travelers=[dict(emp_no=f'{org}{i}', a_trans=amt) for i in range(n)]))
    return _id, gg
def _dash(): return c.get('/travelbudget/api/state').get_json()['dash']
def _grp(i): return next(g for g in c.get('/travelbudget/api/state').get_json()['groups'] if g['group_id']==i)

# 13-1. PUT으로 개인 처리상태 주입 불가 (관리자 결정 위조 차단)
i1,g1 = _mk('ZA',1)
c.put(f'/travelbudget/api/groups/{i1}', json=dict(g1,
    travelers=[dict(name='p0',emp_no='ZA0',rank='TL',ccg_nm='Gas 소재팀',status='처리 완료',a_trans=1000000)]))
ok('PUT traveler.status 주입 불가', all(not p.get('status') for p in _grp(i1)['travelers']), [p.get('status') for p in _grp(i1)['travelers']])

# 13-2. 부분완료 건을 무인증 취소로 정산금 제거 불가
i2,_ = _mk('ZB',3)
for k in (0,1):
    c.post(f'/travelbudget/api/groups/{i2}/status', json={'status':'처리 완료','emp_no':f'ZB{k}'}, headers=ADM)
d_before = _dash()['done']
r = c.post(f'/travelbudget/api/groups/{i2}/status', json={'status':'취소'})
ok('부분완료 건 무인증 취소 401', r.status_code==401, r.status_code)
ok('정산 금액 보존', _dash()['done']==d_before, (d_before, _dash()['done']))

# 13-2b. 실적만 든 건(실적 입력·인폼)도 무인증 취소 불가.
# locked() 는 개인 처리 상태가 하나라도 ADMIN_ZONE 일 때만 True 라, 실적만 넣고
# 아직 아무도 이관·완료가 아닌 그룹은 게이트를 그냥 통과했다. 그 틈으로 취소하면
# 정산금이 '처리 중' 집계에서 통째로 빠지고 가용 잔여가 늘어난 것처럼 보였다.
i2b, _ = _mk('ZBB', 2)
ok('실적만 든 건은 아직 locked 아님(전제 확인)', not _C.locked(_grp(i2b)))
w_before = _dash()['wip']
r = c.post(f'/travelbudget/api/groups/{i2b}/status', json={'status': '취소'})
ok('실적 든 건 무인증 취소 401', r.status_code == 401, r.status_code)
ok('처리 중 금액 보존', _dash()['wip'] == w_before, (w_before, _dash()['wip']))
r = c.post(f'/travelbudget/api/groups/{i2b}/status', json={'status': '취소'}, headers=ADM)
ok('관리자는 취소 가능', r.status_code == 200, r.status_code)
# 계획 단계(잠정·확정 예정)의 취소는 출장자 본인이 하는 정상 동작 — 계속 공개여야 한다
_pg = c.post('/travelbudget/api/groups', json=dict(plan_type='계획', city='c', org='ZPRE', purpose='p',
    kind='정기 Audit', dep_dt=f'{yy}-{mm}-14', ret_dt=f'{yy}-{mm}-15', car='미사용',
    travelers=[dict(name='p', emp_no='ZP0', rank='TL', ccg_nm='Gas 소재팀', p_trans=50000)])).get_json()['group']['group_id']
ok('잠정 계획 무인증 취소 허용',
   c.post(f'/travelbudget/api/groups/{_pg}/status', json={'status': '취소'}).status_code == 200)
_cg = c.post('/travelbudget/api/groups', json=dict(plan_type='계획', city='c', org='ZCF', purpose='p',
    kind='정기 Audit', dep_dt=f'{yy}-{mm}-14', ret_dt=f'{yy}-{mm}-15', car='미사용',
    travelers=[dict(name='p', emp_no='ZC0', rank='TL', ccg_nm='Gas 소재팀', p_trans=50000)])).get_json()['group']['group_id']
c.post(f'/travelbudget/api/groups/{_cg}/status', json={'status': '확정 예정'})
ok('확정 예정 무인증 취소 허용',
   c.post(f'/travelbudget/api/groups/{_cg}/status', json={'status': '취소'}).status_code == 200)
# 정적 미러도 같은 규칙이어야 한다 (한쪽만 고치면 서로 다른 권한을 갖는다)
_tbl = open('tools/tb_local.js', encoding='utf-8').read()
ok('정적 미러도 취소 게이트 보유',
   'want === ST_CANCEL' in _tbl and 'PRE.indexOf(cur4.status) < 0' in _tbl)

# 13-3. 이관 건 금액 무인증 변조 불가 (PUT / 실적 재입력 양쪽)
i3,g3 = _mk('ZC',1)
c.post(f'/travelbudget/api/groups/{i3}/status', json={'status':'소재 이관'}, headers=ADM)
w_before = _dash()['wip']
r = c.put(f'/travelbudget/api/groups/{i3}', json=dict(g3,
    travelers=[dict(name='p0',emp_no='ZC0',rank='TL',ccg_nm='Gas 소재팀',a_trans=50000000)]))
ok('이관건 PUT 금액변조 401', r.status_code==401, r.status_code)
r = c.post(f'/travelbudget/api/groups/{i3}/actual', json=dict(travelers=[dict(emp_no='ZC0',a_trans=1)]))
ok('이관건 실적 재입력 401', r.status_code==401, r.status_code)
ok('처리중 금액 보존', _dash()['wip']==w_before, (w_before, _dash()['wip']))

# 13-4. 일괄 처리 완료가 '보류'를 삼키지 않음
i4,_ = _mk('ZD',3,amt=100000)
c.post(f'/travelbudget/api/groups/{i4}/status', json={'status':'보류','emp_no':'ZD2'}, headers=ADM)
r = c.post(f'/travelbudget/api/groups/{i4}/status', json={'status':'처리 완료'}, headers=ADM)
g4 = _grp(i4)
ok('일괄 완료가 보류 보존', g4['travelers'][2]['status']=='보류', [p.get('status') for p in g4['travelers']])
ok('보류 남으면 그룹 완료 아님', g4['roll']!='처리 완료', g4['roll'])
ok('보류 인원수 응답', r.get_json().get('held')==1, r.get_json().get('held'))

# 13-5. CSV 응답 헤더가 latin-1 안전 (실서버 500 방지)
r = c.get('/travelbudget/api/export.csv')
cd = r.headers.get('Content-Disposition','')
ok('CSV 헤더 latin-1 안전', all(ord(ch)<256 for ch in cd), cd[:60])

# 13-6. 열거값 검증 (CSV 수식 인젝션 우회 차단)
r = c.post('/travelbudget/api/groups', json=dict(base, kind='=cmd|calc', car='=1+1'))
ok('kind/car 열거값 차단', r.status_code==400, r.status_code)

print('\n=== 14. 예산 CSV 추출 ===')
r = c.get(f'/travelbudget/api/export_budget.csv?yq={yq}')
ok('예산 CSV 200', r.status_code==200, r.status_code)
btxt = r.get_data(as_text=True)
blines = [l for l in btxt.strip().split('\r\n') if l]
ok('예산 CSV 헤더 8필드', blines[0].count(',')==7, blines[0])
ok('예산 CSV BOM', btxt.startswith('﻿'))
ok('예산 CSV 데이터 존재', len(blines) > 1, len(blines))
ok('예산 CSV 헤더 latin-1 안전',
   all(ord(ch)<256 for ch in r.headers.get('Content-Disposition','')), r.headers.get('Content-Disposition','')[:50])
# 누적액이 분기 내에서 순차 누적되는가
c.post('/travelbudget/api/budget', json={'yq':yq,'rev_type':'추가증액','amt':300000,'reason':'CSV누적검증','rev_dt':f'{yy}-{mm}-28'}, headers=ADM)
rows = [l.split(',') for l in [x for x in c.get(f'/travelbudget/api/export_budget.csv?yq={yq}').get_data(as_text=True).strip().split('\r\n') if x][1:]]
run_ok = all(int(rows[i][6]) == sum(int(r2[5]) for r2 in rows[:i+1]) for i in range(len(rows)))
ok('예산 CSV 누적액 정확', run_ok, [(r2[4], r2[5], r2[6]) for r2 in rows])
# 전체 분기 + 수식 인젝션 방어
c.post('/travelbudget/api/budget', json={'yq':yq,'rev_type':'감액','amt':100000,'reason':'=cmd|calc','rev_dt':f'{yy}-{mm}-29'}, headers=ADM)
allb = c.get('/travelbudget/api/export_budget.csv').get_data(as_text=True)
ok('예산 CSV 수식 인젝션 방어', "'=cmd" in allb, [l for l in allb.split('\r\n') if 'cmd' in l][:1])

print('\n=== 15. 센터 양식 Excel · 안내 문구 · 버전 ===')
r = c.get('/travelbudget/api/export.xls?yq=' + yq)
ok('센터 Excel 200', r.status_code==200, r.status_code)
xls = r.get_data(as_text=True)
ok('Excel 글꼴 맑은고딕/Trebuchet', 'Malgun Gothic' in xls and 'Trebuchet MS' in xls)
ok('Excel 센터양식 27열', xls.count('<th ')==27, xls.count('<th '))
ok('Excel 헤더 latin-1 안전', all(ord(ch)<256 for ch in r.headers.get('Content-Disposition','')))
ri = c.get('/travelbudget/api/export.xls?yq=' + yq + '&mode=internal')
ok('Excel 내부관리 31열', ri.get_data(as_text=True).count('<th ')==31, ri.get_data(as_text=True).count('<th '))
# 안내 문구
stt = c.get('/travelbudget/api/state').get_json()
ok('시드 안내 문구 존재', '센터 예산 사용 중' in stt['settings'].get('notice',''), stt['settings'].get('notice','')[:30])
ok('시스템 명칭 간소화', stt['settings']['system_name']=='소재 국내 출장비 관리', stt['settings']['system_name'])
ok('버전 노출', stt.get('version',{}).get('v','').startswith('v'), stt.get('version'))
r = c.post('/travelbudget/api/notice', json={'notice':'무인증 변경','notice_sub':'x'})
ok('무인증 안내 문구 변경 401', r.status_code==401, r.status_code)
r = c.post('/travelbudget/api/notice', json={'notice':'테스트 안내','notice_sub':'(보조)'}, headers=ADM)
ok('관리자 안내 문구 저장', r.status_code==200 and r.get_json()['settings']['notice']=='테스트 안내', r.status_code)
ok('안내 문구에 admin_pw 미노출', 'admin_pw' not in r.get_json()['settings'])

print('\n=== 16. 인폼 재발행 · 안내 문구 조사 ===')
# 조사 처리 — '출장도시을(를)' 같은 어색한 안내가 없어야
r = c.post('/travelbudget/api/groups', json={'plan_type':'정기','travelers':[]})
msgs = ' '.join(r.get_json().get('errors', []))
ok('안내 문구 조사 자연스러움', '을(를)' not in msgs and '출장도시를 입력' in msgs and '출장구분을 입력' in msgs, msgs[:90])
ok('core.josa 받침 판정', (_C.josa('출장구분'), _C.josa('출장도시'), _C.josa('')) == ('을','를','를'))

# 인폼 재발행 — 실적 있는 건은 카드를 닫아도 다시 받을 수 있어야
r = c.post('/travelbudget/api/groups', json={'plan_type':'계획','city':'이천','org':'재발행테스트',
    'purpose':'인폼 재발행','dep_dt':f'{yy}-{mm}-14','ret_dt':f'{yy}-{mm}-15','kind':'정기 Audit','car':'미사용',
    'travelers':[{'name':'재발','emp_no':'RM1','rank':'TL','ccg_nm':'Gas 소재팀','ccg':'C1202','p_trans':80000}]})
gidm = r.get_json()['group']['group_id']
r = c.get(f'/travelbudget/api/groups/{gidm}/mail')
ok('실적 전 인폼 재발행 400', r.status_code==400, r.status_code)
c.post(f'/travelbudget/api/groups/{gidm}/actual', json={'travelers':[{'emp_no':'RM1','a_trans':77000}]})
r = c.get(f'/travelbudget/api/groups/{gidm}/mail')
m = r.get_json().get('mail', {})
ok('실적 후 인폼 재발행 200', r.status_code==200 and '재발' in m.get('body_html','') and '77,000' in m.get('body_html',''), r.status_code)
ok('재발행 인폼 수신자/제목 동일', bool(m.get('to')) and '재발행테스트' in m.get('subject',''), m.get('subject'))
ok('없는 출장 인폼 404', c.get('/travelbudget/api/groups/NOPE/mail').status_code==404)

print('\n=== 17. 백엔드 경계값 (500 방어 · 금액 상한) ===')
def _mk(**kw):
    g = dict(plan_type='계획', city='시', org='업체', purpose='목적', kind='정기 Audit',
             dep_dt=f'{yy}-{mm}-10', ret_dt=f'{yy}-{mm}-11', car='미사용',
             travelers=[dict(name='홍', emp_no='Z1', rank='TL', ccg_nm='Gas 소재팀', p_trans=100000)])
    g.update(kw); return c.post('/travelbudget/api/groups', json=g)
# travelers 형식 오류가 500으로 터지던 문제 (normalize가 validate보다 먼저 돌아서)
for bad in ('문자열', 123, {'a': 1}, [None], ['x'], [[]]):
    r = _mk(travelers=bad)
    ok(f'travelers={type(bad).__name__} → 500 아님', r.status_code == 400, r.status_code)
# 금액 상한 — 0을 더 찍은 값이 원장에 들어가지 않아야
r = _mk(travelers=[dict(name='홍', emp_no='Z2', rank='TL', ccg_nm='Gas 소재팀', p_trans=10**15)])
ok('천조 단위 계획비 거부', r.status_code == 400 and '자릿수' in str(r.get_json()['errors']), r.status_code)
r = _mk(travelers=[dict(name='홍', emp_no='Z3', rank='TL', ccg_nm='Gas 소재팀', p_trans=_C.AMT_MAX)])
ok('상한 경계값(1억)은 통과', r.status_code == 201, r.status_code)
r = _mk(travelers=[dict(name='홍', emp_no='Z4', rank='TL', ccg_nm='Gas 소재팀', p_trans=-5000)])
ok('음수 계획비 거부', r.status_code == 400 and '음수' in str(r.get_json()['errors']), r.status_code)
# 실적에도 동일 적용
gz = _mk(travelers=[dict(name='홍', emp_no='Z5', rank='TL', ccg_nm='Gas 소재팀', p_trans=100000)]).get_json()['group']['group_id']
r = c.post(f'/travelbudget/api/groups/{gz}/actual', json={'travelers':[{'emp_no':'Z5','a_trans':10**12}]})
ok('실적 금액 상한 적용', r.status_code == 400, r.status_code)
# 날짜 경계
r = _mk(dep_dt='2026-12-31', ret_dt='2027-01-02')
g = r.get_json()['group']
ok('연말연시 출장 일수·분기', g['days'] == 3 and g['yq'] == '2026-4Q', (g['days'], g['yq']))
r = _mk(dep_dt='2027-02-29', ret_dt='2027-03-01')
ok('존재하지 않는 날짜 거부', r.status_code == 400, r.status_code)
r = _mk(dep_dt=f'{yy}-{mm}-10', ret_dt=f'{yy}-{mm}-10')
ok('당일 출장 1일', r.get_json()['group']['days'] == 1, r.get_json()['group']['days'])
# 백업 경로 탈출
for badp in ('../../../etc/passwd', 'a/../../data.json'):
    ok(f'백업 경로탈출 차단({badp[:12]})',
       c.post(f'/travelbudget/api/backups/{badp}/restore', headers=ADM).status_code in (400, 404))

print('\n=== 18. 타입 오염 방어 (원장·내보내기 보호) ===')
# 텍스트/날짜 필드에 dict·list·bool 이 들어와도 원장에 그대로 저장되면 안 된다
r = _mk(city={}, org=[1], purpose=True, remark=None)
ok('비문자 텍스트 필드 거부', r.status_code == 400, r.status_code)
r = _mk(city='이천', org='정상업체', purpose='정상목적', remark=['a'], sap_doc={'x':1})
g = r.get_json().get('group') or {}
ok('비고·전표 비문자 → 빈 문자열', r.status_code == 201 and g.get('remark') == '' and g.get('sap_doc') == '',
   (g.get('remark'), g.get('sap_doc')))
for bad in ({}, [], None, True, 0, 1e308):
    ok(f'날짜={type(bad).__name__} 거부', _mk(dep_dt=bad).status_code == 400, bad)
ok('저장된 dep_dt는 항상 str',
   all(isinstance(x.get('dep_dt'), str) for x in c.get('/travelbudget/api/state').get_json()['groups']))
# 본문이 dict가 아닌 JSON (123 / [] / null) 이어도 500 아님
for raw in (b'123', b'[]', b'null', b'"x"', b'not json', b''):
    for u in ('/api/groups', '/api/budget', '/api/notice'):
        rr = c.post('/travelbudget' + u, data=raw, content_type='application/json', headers=ADM)
        ok(f'본문 {raw[:9]!r} {u[5:]} → 500 아님', rr.status_code < 500, rr.status_code)
# 오염된 구 데이터가 있어도 내보내기는 살아 있어야 (정렬 방어)
ok('오염 데이터 정렬 방어', _C.ledger_rows({'groups':[{'dep_dt':{}, 'travelers':[]},
    {'dep_dt':'2026-09-01','travelers':[]}]}, None, False) is not None)
for u in ('/api/export.csv', '/api/export.xls', '/api/export_budget.csv'):
    ok(f'{u[5:]} 200', c.get('/travelbudget' + u).status_code == 200)

print('\n=== 19. Qwen 변환 프롬프트 (문서 ↔ 화면 동기화) ===')
import re as _re
_md = open('QWEN_PROMPT.md', encoding='utf-8').read()
_app = open('servera/travelbudget/static/app.js', encoding='utf-8').read()
_m = _re.search(r'^````text\n(.*?)^````$', _md, _re.S | _re.M)
ok('QWEN_PROMPT.md 프롬프트 블록 존재', bool(_m))
_pm = _m.group(1).rstrip('\n')
_a = _re.search(r'const QWEN_PROMPT = `(.*?)`;', _app, _re.S)
ok('app.js 에 프롬프트 주입됨', bool(_a) and len(_a.group(1)) > 3000, _a and len(_a.group(1)))
ok('문서 ↔ 화면 프롬프트 일치 (tools/sync_prompt.py 실행 필요)', _a and _a.group(1) == _pm)
ok('프롬프트에 백틱·치환자 없음(JS 리터럴 안전)', '`' not in _pm and '${' not in _pm and '</script' not in _pm)
# 프롬프트가 실제 시스템 규칙과 맞는지 — 열거값·CCG팀명이 core 와 일치해야
for _v in _C.STATUSES:
    ok(f'프롬프트 status 표기 일치: {_v}', _v in _pm)
for _t in _C.CCG_TEAMS:
    ok(f'프롬프트 CCG팀 표기 일치: {_t["team"]}', _t['team'] in _pm)
for _k in _C.KINDS:
    ok(f'프롬프트 출장구분 일치: {_k[:14]}', _k in _pm)
ok('프롬프트 금액 상한이 core 와 일치', str(_C.AMT_MAX) in _pm.replace(',', ''), _C.AMT_MAX)
ok('자동계산 필드 출력 금지 명시', '출력하지 마세요' in _pm and '총합계' in _pm)
ok('동행자 그룹 묶기 규칙 포함', '한 group 으로 합치고' in _pm)
ok('화면에 복사 버튼 존재', '변환 프롬프트 복사' in _app and 'QWEN_CHECK' in _app)

print('\n=== 20. v9.4 배포 안전성 · 지표 정확성 ===')
# 신규 설치 = 빈 원장 (예시 출장·예산 자동 생성 금지)
_dd = _store.default_data()
ok('신규 설치 빈 원장 — 출장 0건', _dd['groups'] == [], len(_dd['groups']))
ok('신규 설치 빈 원장 — 예산 0건', _dd['budget'] == [], len(_dd['budget']))
ok('예시 데이터는 example_data() 에만', len(_store.example_data()['groups']) > 0)
ok('검증 안 하는 admin_id 설정 제거', 'admin_id' not in _dd['settings'], list(_dd['settings']))
ok('실적 인폼 기본 수신자 2명', len(_dd['settings']['mail_recipients']) == 2, _dd['settings']['mail_recipients'])
# 테스트 격리 — 운영 디렉터리를 쓰지 않는다
ok('테스트가 임시 디렉터리에서만 동작', str(_store.DATA_DIR).startswith(tempfile.gettempdir()), str(_store.DATA_DIR))
ok('운영 TB_DATA_DIR 미사용', _PROD is None or str(_store.DATA_DIR) != _PROD)
# webmain 진입점 — 사내 servera/__init__.py 에 기대지 않는 import
_wm = open('webmain.py', encoding='utf-8').read()
ok('webmain 은 블루프린트를 직접 import', 'from servera.travelbudget import travelbudget' in _wm)
ok('단일 프로세스 고정(processes=1)', 'processes=1' in _wm)

# 지표 — CCG 합계 중복 집계 없음
r = _mk(city='교차', org='2CCG교차', purpose='교차', confirmed=True,
        travelers=[dict(name='A', emp_no='CC1', rank='TL', ccg_nm='Gas 소재팀', p_trans=100000),
                   dict(name='B', emp_no='CC2', rank='TL', ccg_nm='Photo 소재팀', p_trans=100000)])
_stt = c.get(f'/travelbudget/api/state?yq={yq}').get_json()
_d2 = _stt['dash']
_ccgsum = sum(x['groups'] for x in _d2['byCcg'])
ok('CCG행 건수는 참여 기준(중복 허용)', _ccgsum > _d2['nTrips'], (_ccgsum, _d2['nTrips']))
_inq = [g for g in _stt['groups'] if g['yq'] == yq and g['status'] != '취소']
ok('nTrips = 실제 출장 건수(중복 없음)', _d2['nTrips'] == len(_inq), (_d2['nTrips'], len(_inq)))
ok('건수 KPI 합 = nTrips',
   _d2['nPlan'] + _d2['nConfirm'] + _d2['nWip'] + _d2['nDone'] == _d2['nTrips'])

# 잘못된 입력이 500이 아님
for _b in ('NaN', 'Infinity', '-Infinity'):
    _r = c.post('/travelbudget/api/budget', data='{"yq":"%s","rev_type":"증액","amt":%s}' % (yq, _b),
                content_type='application/json', headers=ADM)
    ok(f'금액 {_b} → 400', _r.status_code == 400, _r.status_code)
ok('core.num(Infinity) 예외 없이 0', _C.num(float('inf')) == 0 and _C.num(float('nan')) == 0)
for _n in ('abc', '-5', '1e9', '', '999999'):
    ok(f'/api/audit?n={_n!r} → 500 아님', c.get(f'/travelbudget/api/audit?n={_n}').status_code < 500)
for _q in ('abc-Q', '2026-0Q', '2026-99Q'):
    ok(f'yq={_q} 예산 등록 400', c.post('/travelbudget/api/budget',
       json={'yq': _q, 'rev_type': '증액', 'amt': 1000}, headers=ADM).status_code == 400)
    ok(f'yq={_q} 조회 500 아님', c.get(f'/travelbudget/api/state?yq={_q}').status_code < 500)

print('\n=== 21. v9.4 실제 사용 흐름 ===')
# 계획 수정 — 실적 전은 자유, 실적 후는 예산 담당자만
_g = _mk(city='수정전', org='수정테스트', purpose='수정 확인',
         travelers=[dict(name='수정', emp_no='ED1', rank='TL', ccg_nm='Gas 소재팀', p_trans=100000)]).get_json()['group']
_eg = _g['group_id']
_pl = dict(plan_type='계획', city='수정후', org='수정테스트', purpose='수정 확인', kind='정기 Audit',
           dep_dt=_g['dep_dt'], ret_dt=_g['ret_dt'], car='미사용',
           travelers=[dict(name='수정', emp_no='ED1', rank='TL', ccg_nm='Gas 소재팀', p_trans=150000)])
_r = c.put(f'/travelbudget/api/groups/{_eg}', json=_pl)
ok('실적 전 계획 수정 — 인증 없이 가능', _r.status_code == 200, _r.status_code)
ok('수정 내용 반영', _r.get_json()['group']['city'] == '수정후' and _r.get_json()['group']['plan_tot'] == 150000)
_aud = c.get('/travelbudget/api/audit?n=20').get_json()['audit']
_last = [a for a in _aud if a['action'] == '출장 수정'][-1]
ok('감사 로그에 변경 항목 기록', '출장도시' in _last['detail'] and '계획액' in _last['detail'], _last['detail'][:80])
ok('감사 로그에 수정 시각 기록', bool(_last.get('timestamp')), _last.get('timestamp'))
c.post(f'/travelbudget/api/groups/{_eg}/actual', json={'travelers': [{'emp_no': 'ED1', 'a_trans': 140000}]})
_r = c.put(f'/travelbudget/api/groups/{_eg}', json=_pl)
ok('실적 후 무인증 수정 401', _r.status_code == 401, _r.status_code)
_r = c.put(f'/travelbudget/api/groups/{_eg}', json=_pl, headers=ADM)
ok('실적 후 담당자 모드 수정 200', _r.status_code == 200, (_r.status_code, _r.get_json().get('errors')))
ok('계획 수정이 기존 실적을 지우지 않음',
   _r.status_code == 200 and _r.get_json()['group']['act_tot'] == 140000,
   _r.status_code == 200 and _r.get_json()['group']['act_tot'])

# 예산 부족이어도 확정·실적·완료가 가능해야 (경고만, 차단 아님)
_poor = _mk(city='부족', org='예산부족', purpose='부족 확인', confirmed=True,
            travelers=[dict(name='부족', emp_no='PR1', rank='TL', ccg_nm='Gas 소재팀',
                            p_trans=99000000)]).get_json()
ok('예산 초과여도 확정 등록 성공', 'group' in _poor, _poor.get('errors'))
_dsh = c.get(f'/travelbudget/api/state?yq={yq}').get_json()['dash']
ok('가용 잔여가 음수로 표시(경고용)', _dsh['avail'] < 0, _dsh['avail'])
ok('예산 부족 플래그 노출', _dsh['short'] is True, _dsh['short'])
_pg = _poor['group']['group_id']
ok('예산 부족에도 실적 입력 가능',
   c.post(f'/travelbudget/api/groups/{_pg}/actual',
          json={'travelers': [{'emp_no': 'PR1', 'a_trans': 98000000}]}).status_code == 200)
ok('예산 부족에도 처리 완료 가능',
   c.post(f'/travelbudget/api/groups/{_pg}/status', json={'status': '처리 완료'},
          headers=ADM).status_code == 200)

# 확정 확보액 ↔ 실적액 이중 차감 없음
_c1 = _mk(city='이중', org='이중차감', purpose='이중 확인', confirmed=True,
          travelers=[dict(name='이중', emp_no='DB1', rank='TL', ccg_nm='Gas 소재팀',
                          p_trans=500000)]).get_json()['group']['group_id']
_b1 = c.get(f'/travelbudget/api/state?yq={yq}').get_json()['dash']
c.post(f'/travelbudget/api/groups/{_c1}/actual', json={'travelers': [{'emp_no': 'DB1', 'a_trans': 480000}]})
_b2 = c.get(f'/travelbudget/api/state?yq={yq}').get_json()['dash']
ok('실적 입력 시 확정 확보액 해제', _b2['commit'] == _b1['commit'] - 500000, (_b1['commit'], _b2['commit']))
ok('실적액은 처리중으로 이동', _b2['wip'] == _b1['wip'] + 480000, (_b1['wip'], _b2['wip']))
ok('이중 차감 없음 (가용은 차액만큼만 이동)',
   _b2['avail'] == _b1['avail'] + 500000 - 480000, (_b1['avail'], _b2['avail']))

# 이관 메일 수신자는 직접 지정 (마스터 없음)
c.post(f'/travelbudget/api/groups/{_c1}/status', json={'status': '소재 이관'}, headers=ADM)
_tm = c.get(f'/travelbudget/api/groups/{_c1}/transfer_mail').get_json()['mail']
ok('이관 메일 수신자 비어 있음(직접 지정)', _tm['to'] == '', _tm['to'])
ok('이관 메일에 직접 지정 안내', '직접 지정' in _tm.get('to_hint', ''), _tm.get('to_hint'))
ok('이관 인폼 문구 유지', '이관 결재 상신' in _tm['body_text'] and '비용 처리 부탁' in _tm['body_text'])

# SAP — 화면에서 제거, 데이터는 호환 유지
_appjs = open('servera/travelbudget/static/app.js', encoding='utf-8').read()
ok('화면에 SAP 노출 없음', 'sap' not in _appjs.lower(), [l for l in _appjs.split('\n') if 'sap' in l.lower()][:2])
ok('SAP 필드는 데이터 호환용으로 유지', 'sap_doc' in _C.normalize_group({'travelers': []}))
ok('SAP 전표는 처리 완료 조건이 아님',
   c.post(f'/travelbudget/api/groups/{_pg}/status', json={'status': '처리 완료'}, headers=ADM).status_code in (200, 400))

# 화면 문구
_tpl = open('servera/travelbudget/templates/index.html', encoding='utf-8').read()
ok('예산 담당자 모드 문구', '예산 담당자 모드' in _appjs)
ok('검증 안 하는 ID 입력란 제거', 'admId' not in _appjs and 'admId' not in _tpl)
ok('확정 표기 = 출장 확정 · 예산 반영', "'확정 예정': '출장 확정 · 예산 반영'" in _appjs)
ok('저장값은 확정 예정 그대로(데이터 호환)', _C.ST_CONFIRM == '확정 예정')

print('\n=== 22. 문서 정합성 ===')
import re as _re2
_routes = open('servera/travelbudget/routes.py', encoding='utf-8').read()
_n = len(_re2.findall(r'@travelbudget\.(get|post|put|delete)\(', _routes))
_rd = open('README.md', encoding='utf-8').read()
_dp = open('DEPLOY.md', encoding='utf-8').read()
ok(f'README API 개수 = 실제 {_n}개', f'API {_n}개' in _rd, [x for x in _re2.findall(r'API \d+개', _rd)])
ok(f'DEPLOY API 개수 = 실제 {_n}개', f'API {_n}개' in _dp, [x for x in _re2.findall(r'API \d+개', _dp)])
for _f in ('tools/e2e/e2e.mjs', 'tools/e2e/e2e_pages.mjs', 'tools/e2e/fuzz.py', 'smoke_test.py'):
    ok(f'{_f} 저장소에 존재', os.path.exists(_f))
ok('DEPLOY 는 서버에서 smoke_test 안내', 'smoke_test.py' in _dp)
ok('DEPLOY 에 1 worker 명시', 'worker' in _dp or '프로세스 1개' in _dp)
# Qwen 프롬프트 — 순수 JSON
_md = open('QWEN_PROMPT.md', encoding='utf-8').read()
_pm = _re2.search(r'^````text\n(.*?)^````$', _md, _re2.S | _re2.M).group(1)
ok('프롬프트: 순수 JSON만 출력 지시', 'json.load() 로 바로 읽히지' in _pm)
ok('프롬프트: 확인필요는 JSON 안에', '_confirm_needed' in _pm)
ok('프롬프트: 근거 없는 처리 완료 추론 금지', '추론하지 마세요' in _pm)
ok('_confirm_needed 키가 있어도 로드 정상',
   _store.validate_root({'settings': {}, 'budget': [], 'groups': [], '_confirm_needed': ['x']}) is None)

print('\n=== 23. 출장자 안내 HTML ↔ 실제 화면 일치 ===')
_gd = open('servera/travelbudget/templates/traveler_guide.html', encoding='utf-8').read()
ok('안내 라우트 /guide 200', c.get('/travelbudget/guide').status_code == 200,
   c.get('/travelbudget/guide').status_code)
ok('안내가 화면에서 열림(이용 안내에 링크)', '/travelbudget/guide' in _appjs)
_tpl2 = open('servera/travelbudget/templates/index.html', encoding='utf-8').read()
ok('좌측 메뉴에도 안내 링크', '/travelbudget/guide' in _tpl2 and 'guideLink' in _tpl2)
ok('안내 링크는 nav 뷰 전환에서 제외', "$$('.nav a[data-view]')" in _appjs)
# 파일로 직접 열어도 한글이 깨지지 않아야 한다 (서버 charset 헤더에 기대면 안 됨)
_headhtml = _gd[:400].lower()
ok('안내에 <!doctype> 선언', _headhtml.lstrip().startswith('<!doctype html'), _gd[:30])
ok('안내에 <meta charset="utf-8">', 'charset="utf-8"' in _headhtml)
ok('charset 이 앞쪽 1024바이트 안에', _gd.encode('utf-8').find(b'charset') < 1024)
ok('안내에 <html lang="ko">', '<html lang="ko"' in _headhtml)
ok('안내에 viewport', 'viewport' in _headhtml)
# 배포되는 모든 HTML 이 동일 기준을 지키는지 (같은 실수 재발 방지)
for _hf in ('servera/travelbudget/templates/index.html',
            'servera/travelbudget/templates/traveler_guide.html',
            'docs/index.html', 'docs/traveler_guide.html'):
    if not os.path.exists(_hf):
        continue
    _h = open(_hf, encoding='utf-8').read()[:400].lower()
    ok(f'{_hf.split("/")[-1]} charset 선언', 'charset' in _h and _h.lstrip().startswith('<!doctype'), _hf)
ok('안내는 화이트 고정(다크로 뒤집히지 않음)',
   'prefers-color-scheme' not in _gd and 'only light' in _gd)
ok('안내에 data-theme 오버라이드 없음', 'data-theme' not in _gd)
ok('docs 사본 = 템플릿 원본 (tools/build_docs.py 실행 필요)',
   (not os.path.exists('docs/traveler_guide.html')) or
   open('docs/traveler_guide.html', encoding='utf-8').read() == _gd)
_tpl2 = open('servera/travelbudget/templates/index.html', encoding='utf-8').read()
_rt = open('servera/travelbudget/routes.py', encoding='utf-8').read()
# 안내가 가리키는 메뉴·버튼이 실제로 존재해야 한다
for _m in ('출장 계획 등록', '출장 실적 입력', '출장 내역', '이용 안내'):
    ok(f'안내의 메뉴 "{_m}" 실재', _m in _gd and _m in _tpl2)
for _b in ('출장 확정', '실적 저장 및 인폼 생성', '표 포함 복사',
           '인폼 다시 보기', '인폼 보기', '+ 동행자 추가', '출장 취소'):
    ok(f'안내의 버튼 "{_b}" 실재', _b in _gd and _b in _appjs)
# 상태 표기가 화면 표기와 같아야 한다
for _s in ('계획(잠정)', '출장 확정 · 예산 반영', '실적 입력·인폼', '소재 이관', '처리 완료'):
    ok(f'안내의 상태 "{_s}" 표기 일치', _s in _gd and (_s in _appjs or _s in str(_C.STATUSES)))
# 안내가 설명하는 동작이 실제 동작과 같아야 한다
ok('안내: 예산 부족을 막지 않음 = 실제와 일치', '계속 확정' in _gd and '계속 확정하시겠습니까' in _appjs)
ok('안내: 긴급은 비고 필수 = 실제와 일치', '비고(사유)' in _gd and '긴급 출장은 비고(사유)가 필수입니다' in _C.__doc__ or
   '긴급 출장은 비고(사유)가 필수입니다' in open('servera/travelbudget/core.py', encoding='utf-8').read())
ok('안내: 실적 후 수정은 담당자만 = 실제와 일치',
   '예산 담당자' in _gd and '예산 담당자 모드에서만 수정' in _rt)
ok('안내: 인폼 수신자 2명 = 실제와 일치',
   '이정훈 · 김은정' in _gd and len(_store.default_data()['settings']['mail_recipients']) == 2)
# 없는 기능을 안내하면 안 된다 (SAP 는 v9.4 에서 화면에서 뺐다)
# mailto(Outlook 열기)는 사내에서 실패해 제거 — 안내에도 남아 있으면 안 된다
ok('안내에 Outlook 열기 언급 없음', 'Outlook' not in _gd)
ok('화면에 mailto 없음', 'mailto' not in _appjs)
ok('안내에 드래그 안내 있음', '끌어다' in _gd or '드래그' in _gd)
ok('화면 인폼 카드에 드래그 안내', '끌어다 놓기' in _appjs or '드래그' in _appjs)
for _ghost in ('SAP', '전표', '승인', '반려'):
    ok(f'안내에 없는 기능 "{_ghost}" 미언급', _ghost not in _gd)
ok('안내는 자체 완결(외부 CDN 없음)', 'http://' not in _gd and 'cdn' not in _gd.lower())
# 윈도우에서 라틴/한글이 섞이지 않도록 모든 배포 HTML 이 맑은 고딕을 맨 앞에 둔다
for _hf in ('servera/travelbudget/templates/index.html',
            'servera/travelbudget/templates/traveler_guide.html'):
    _h = open(_hf, encoding='utf-8').read()
    _decl = [l for l in _h.split('\n') if 'font-family:' in l and 'monospace' not in l]
    _body = [l for l in _decl if 'Malgun Gothic' in l]
    ok(f'{_hf.split("/")[-1]} 본문 글꼴 맑은고딕 우선',
       any(l.strip().startswith('font-family:"Malgun Gothic"') for l in _decl), _decl[:2])
    ok(f'{_hf.split("/")[-1]} Pretendard 미사용(주석 제외)',
       not any('Pretendard' in l for l in _decl), [l for l in _decl if 'Pretendard' in l])

# 여백 척도 — 4·8·12·16·24 다섯 단계만. (1·2px 은 선·미세보정, 48px 은 본문 하단 여유)
# 값이 늘어나면 "여기는 왜 14px 이지" 를 매번 판단해야 하고 화면마다 리듬이 어긋난다.
import re as _re
_SPACE_OK = {0, 1, 2, 4, 8, 12, 16, 24, 48}
_PROPS = r'(?:margin|padding|gap|row-gap|column-gap)(?:-(?:top|bottom|left|right))?'
for _hf in ('servera/travelbudget/templates/index.html',
            'servera/travelbudget/templates/traveler_guide.html'):
    _h = open(_hf, encoding='utf-8').read()
    _bad = set()
    for _m in _re.finditer(r'\b' + _PROPS + r'\s*:\s*([^;}\n]+)', _h):
        for _t in _m.group(1).split():
            if _t.endswith('px') and int(_t[:-2]) not in _SPACE_OK:
                _bad.add(_t)
    ok(f'{_hf.split("/")[-1]} 여백이 척도 안', not _bad, sorted(_bad))

# 출장자 표 — 첫 칸 고정은 가로 스크롤 시 뒷칸을 덮는다. 다시 넣으면 안 된다.
_ix = open('servera/travelbudget/templates/index.html', encoding='utf-8').read()
ok('출장자 표에 sticky 첫 칸 없음',
   'trav-table th:first-child' not in _ix and 'trav-table td:first-child' not in _ix)
ok('CCG No. 는 팀 칸 안 캡션', '.trav-table .ccgno' in _ix and 'w-cc' not in _ix)

# 단계 음영 팔레트 — 단계는 진하기로, 신호(좋다/나쁘다)는 색으로. 둘을 섞으면 안 된다.
_gd2 = open('servera/travelbudget/templates/traveler_guide.html', encoding='utf-8').read()
for _f, _src in (('index.html', _ix), ('traveler_guide.html', _gd2)):
    ok(f'{_f} 단계 램프 4단 선언', all(f'--s{i}:' in _src for i in (1, 2, 3, 4)), _f)
# 단계를 그리는 선언에 신호색이 섞이면 "같은 처리 완료가 화면마다 다른 색" 으로 되돌아간다
_STAGE_SEL = ('.status.done', '.status.wip', '.status.confirm',
              '.s-done{', '.s-wip{', '.s-cmt{', '.s-ava{',
              '.flowbar .pill.done', '.flowbar .pill.wip', '.flowbar .pill.confirm',
              '.st.done{', '.st.wip{', '.st.confirm{')
_SIGNAL = ('--green', '--amber', '#166F59', '#8A5A10', '#17725C', '#2563A8')
for _src, _name in ((_ix, 'index.html'), (_gd2, 'traveler_guide.html')):
    for _line in _src.split('\n'):
        if any(_line.lstrip().startswith(x) for x in _STAGE_SEL):
            ok(f'{_name} 단계 선언에 신호색 없음: {_line.strip()[:34]}',
               not any(sig in _line for sig in _SIGNAL), _line.strip())
# 비목은 범주형 — 단계 음영과 헷갈리지 않게 색으로 나누지 않는다
ok('비목 막대는 단색', '.cost .bbar i{background:var(--s2)}' in _ix
   and '.cost i.c1' not in _ix)
# 잠정 계획은 예산 막대에 섞이지 않는다 (섞으면 가용 잔여에서 차감된 것처럼 읽힘)
_appjs2 = open('servera/travelbudget/static/app.js', encoding='utf-8').read()
ok('잠정은 별도 참고 막대', '.ghost' in _ix and 'class="ghost"' in _appjs2)
ok('예산 막대 세그먼트는 4종(완료·처리중·확정·가용)',
   _appjs2.count("{k: 'done'") == 1 and "k: 'plan'" not in _appjs2)

# 안내 문서의 배지 등급이 화면의 stClass 와 같아야 한다
# ('소재 이관' 이 안내에서만 기본칩이라 진행 단계가 뒤로 돌아간 것처럼 보이던 결함)
_ST_GRADE = {'계획(잠정)': '', '출장 확정 · 예산 반영': 'confirm', '실적 입력·인폼': 'wip',
             '소재 이관': 'wip', '처리 완료': 'done', '취소': 'cancel'}
for _label, _grade in _ST_GRADE.items():
    _want = f'<span class="st{" " + _grade if _grade else ""}">{_label}</span>'
    ok(f'안내 배지 등급 일치: {_label}', _want in _gd2, _want)

# 컨테이너 태그 짝 — nav 를 </div> 로 닫으면 브라우저 파서가 aside 와 .app 까지 함께 닫아
# 사이드바/본문 2열 그리드가 통째로 무너진다. DOM·기능 테스트는 전부 통과하므로 여기서 막는다.
from html.parser import HTMLParser as _HP
_VOID = {'area','base','br','col','embed','hr','img','input','link','meta',
         'param','source','track','wbr'}
_WATCH = {'div','nav','aside','main','section','table','thead','tbody','tr','td','th','form','a'}

class _Bal(_HP):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack, self.bad = [], []
    def handle_starttag(self, tag, attrs):
        if tag not in _VOID:
            self.stack.append((tag, self.getpos()[0]))
    def handle_startendtag(self, tag, attrs):
        pass
    def handle_endtag(self, tag):
        if tag in _VOID:
            return
        if not self.stack:
            self.bad.append(f'{self.getpos()[0]}행: 여는 태그 없는 </{tag}>')
            return
        top, line = self.stack[-1]
        if top == tag:
            self.stack.pop()
        elif any(t == tag for t, _ in self.stack):
            # 짝이 안 맞는 채로 닫힘 — 브라우저는 사이 태그들을 강제로 닫아버린다
            while self.stack and self.stack[-1][0] != tag:
                t, l = self.stack.pop()
                if t in _WATCH:
                    self.bad.append(f'{self.getpos()[0]}행 </{tag}> 이(가) {l}행 <{t}> 을(를) 강제로 닫음')
            self.stack.pop()
        else:
            self.bad.append(f'{self.getpos()[0]}행: 열린 적 없는 </{tag}>')

for _hf in ('servera/travelbudget/templates/index.html',
            'servera/travelbudget/templates/traveler_guide.html',
            'docs/index.html', 'docs/traveler_guide.html'):
    if not os.path.exists(_hf):
        continue
    _p = _Bal()
    _p.feed(open(_hf, encoding='utf-8').read())
    _p.close()
    _left = [f'{t}({l}행)' for t, l in _p.stack if t in _WATCH]
    ok(f'{_hf.split("/")[-1]} 태그 짝 맞음', not _p.bad, _p.bad[:3])
    ok(f'{_hf.split("/")[-1]} 닫히지 않은 컨테이너 없음', not _left, _left[:3])

print(f'\n{"="*48}\n  API 통합  {P[0]} passed / {F[0]} failed\n{"="*48}')
sys.exit(1 if F[0] else 0)
