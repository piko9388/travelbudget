# -*- coding: utf-8 -*-
import os, shutil, sys
D = 'servera/travelbudget/data_json'
if os.path.exists(D): shutil.rmtree(D)
from webmain import app
app.config['TESTING'] = True
c = app.test_client()
ADM = {'X-Admin-PW': '2071478'}
P=[0];F=[0]
def ok(n, cond, got=None):
    if cond: P[0]+=1; print(f'  PASS  {n}')
    else: F[0]+=1; print(f'  FAIL  {n} -> {got!r}')

print('\n=== 1. state / 시드 ===')
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
ok('수신 4명', m['to'].count('@')==4, m['to'])
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
al = J.load(open('servera/travelbudget/data_json/data.json'))['audit_log']
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
gc = _C.dash(J.load(open('servera/travelbudget/data_json/data.json')), yq) if False else None
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

print(f'\n{"="*48}\n  API 통합  {P[0]} passed / {F[0]} failed\n{"="*48}')
sys.exit(1 if F[0] else 0)
