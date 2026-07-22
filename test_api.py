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
ok('CSV 29필드(상태 포함)', head.count(',')==28, head.count(',')+1)
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

print(f'\n{"="*48}\n  API 통합  {P[0]} passed / {F[0]} failed\n{"="*48}')
sys.exit(1 if F[0] else 0)
