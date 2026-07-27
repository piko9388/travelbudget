# -*- coding: utf-8 -*-
"""전 쓰기 라우트 퍼징 — 500(서버 다운) 유발 입력이 남아 있는지.
실행: python3 tools/e2e/fuzz.py   (임시 폴더에서만 동작, 운영 데이터 무관)"""
import os, sys, shutil, itertools
REPO = os.environ.get('TB_REPO') or os.getcwd()
sys.path.insert(0, REPO); os.chdir(REPO)
import tempfile
D = tempfile.mkdtemp(prefix='tb_fuzz_')
shutil.rmtree(D, ignore_errors=True); os.environ['TB_DATA_DIR'] = D
from webmain import app
app.config['TESTING'] = True
c = app.test_client(); ADM = {'X-Admin-PW': '2071478'}; B = '/travelbudget'
base = dict(plan_type='계획', city='시', org='업', purpose='목', kind='정기 Audit',
            dep_dt='2026-09-10', ret_dt='2026-09-11',
            travelers=[dict(name='홍', emp_no='F1', rank='TL', ccg_nm='Gas 소재팀', p_trans=100000)])
gid = c.post(B + '/api/groups', json=base).get_json()['group']['group_id']

VALS = [None, 0, -1, '', ' ', 'x' * 300, [], {}, [[]], [None], True, 3.7, '<script>',
        "' OR 1=1", chr(0), 1e308, {'a': {'b': {'c': 1}}}, ['a', 'b'], -(10 ** 18)]
FIELDS = ['plan_type', 'city', 'org', 'purpose', 'kind', 'dep_dt', 'ret_dt', 'car', 'remark',
          'travelers', 'status', 'confirmed', 'group_id', 'yq', 'lv2', 'sap_doc',
          'created_at', 'plan_tot', 'proc', 'roll']
crash, n = [], 0
for f, v in itertools.product(FIELDS, VALS):
    for meth, url, payload in (
        ('post', B + '/api/groups', {**base, f: v}),
        ('put', f'{B}/api/groups/{gid}', {f: v}),
        ('post', f'{B}/api/groups/{gid}/actual', {f: v, 'travelers': [{'emp_no': 'F1', 'a_trans': 1000}]}),
    ):
        n += 1
        try:
            r = getattr(c, meth)(url, json=payload, headers=ADM)
            if r.status_code >= 500:
                crash.append((meth, f, repr(v)[:26], r.status_code))
        except Exception as e:
            crash.append((meth, f, repr(v)[:26], type(e).__name__ + ':' + str(e)[:60]))

for v in VALS:
    for meth, url, payload in (
        ('post', f'{B}/api/groups/{gid}/status', {'status': v}),
        ('post', f'{B}/api/groups/{gid}/status', {'status': '소재 이관', 'emp_no': v}),
        ('post', B + '/api/budget', {'yq': v, 'rev_type': '증액', 'amt': 1}),
        ('post', B + '/api/budget', {'yq': '2026-3Q', 'rev_type': '증액', 'amt': v}),
        ('post', B + '/api/notice', {'notice': v, 'notice_sub': v}),
        ('post', f'{B}/api/groups/{gid}/sap', {'sap_doc': v}),
    ):
        n += 1
        try:
            r = getattr(c, meth)(url, json=payload, headers=ADM)
            if r.status_code >= 500:
                crash.append((meth, url.split('/')[-1], repr(v)[:26], r.status_code))
        except Exception as e:
            crash.append((meth, url.split('/')[-1], repr(v)[:26], type(e).__name__ + ':' + str(e)[:60]))

for v in ['', 'x', '../..', '%00', '2026-3Q' * 50, ' ']:
    for u in ['/api/export.csv?yq=', '/api/export.xls?yq=', '/api/export_budget.csv?yq=', '/api/report?yq=']:
        n += 1
        r = c.get(B + u + v)
        if r.status_code >= 500:
            crash.append(('get', u, v[:20], r.status_code))

# 본문이 JSON이 아닌 경우
for body in (b'', b'not json', b'[]', b'null', b'123', b'{"a":'):
    for u in ('/api/groups', f'/api/groups/{gid}/actual', '/api/budget', '/api/notice'):
        n += 1
        r = c.post(B + u, data=body, content_type='application/json', headers=ADM)
        if r.status_code >= 500:
            crash.append(('post', u, body[:14], r.status_code))

print(f'퍼징 {n:,}회 → 500/예외 {len(crash)}건')
for x in crash[:20]:
    print('  ', x)
