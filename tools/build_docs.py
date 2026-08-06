#!/usr/bin/env python3
"""docs/index.html 조립 — Flask 템플릿 + 정적 백엔드 + app.js(호출부만 치환)."""
import re, sys, pathlib
REPO = pathlib.Path('/home/user/travelbudget')
BACKEND = REPO / 'tools/tb_local.js'
tpl = (REPO/'servera/travelbudget/templates/index.html').read_text(encoding='utf-8')
backend = BACKEND.read_text(encoding='utf-8')
app = (REPO/'servera/travelbudget/static/app.js').read_text(encoding='utf-8')
def s1(s, old, new, tag):
    assert s.count(old) == 1, f"[{tag}] 매칭 {s.count(old)}회 — 조립 스크립트 갱신 필요"
    return s.replace(old, new)
app = s1(app, """  const r = await fetch(API + path, opt);
  const b = await r.json().catch(() => ({}));
  return {ok: r.ok, status: r.status, data: b};""",
"""  return __localApi(path, opt);   // 정적(GitHub Pages) — 서버 대신 브라우저에서 동일 로직 처리""", "api")
# 정적판에는 서버가 없다 — 주소는 쓰지 않고 dataset.gids 만 넘긴다
app = s1(app,
    "  xls.href = `${API}/export.xls?${q}`;\n  csv.href = `${API}/export.csv?${q}`;",
    "  void q;   // 정적판: 주소 대신 아래 dataset.gids 로 넘긴다", "list-export-href")
_G = "(this.dataset.gids||'').split(',').filter(Boolean)"
app = s1(app,
    '<a class="btn pri" id="lsXls" href="${API}/export.xls?yq=${encodeURIComponent(YQ)}">센터 제출 양식 (Excel)</a>\n'
    '          <a class="btn" id="lsCsv" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">CSV</a>',
    f'<button class="btn pri" id="lsXls" onclick="downloadXls(YQ,false,{_G})">센터 제출 양식 (Excel)</button>\n'
    f'          <button class="btn" id="lsCsv" onclick="downloadCsv(YQ,false,{_G})">CSV</button>', "list-csv")
app = s1(app, """        <a class="btn pri" href="${API}/export.xls?yq=${encodeURIComponent(YQ)}">${YQ} 센터 제출 (Excel)</a>
        <a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">${YQ} 출장 CSV</a>
        <a class="btn" href="${API}/export.csv">전체 출장 CSV</a>
        <a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}&mode=internal">${YQ} 내부관리 CSV</a>""",
"""        <button class="btn pri" onclick="downloadXls(YQ)">${YQ} 센터 제출 (Excel)</button>
        <button class="btn" onclick="downloadCsv(YQ)">${YQ} 출장 CSV</button>
        <button class="btn" onclick="downloadCsv(null)">전체 출장 CSV</button>
        <button class="btn" onclick="downloadCsv(YQ,true)">${YQ} 내부관리 CSV</button>""", "data-csv")
app = s1(app, """    <div class="card"><h2>정본 위치</h2>
      <div class="note">servera/travelbudget/data_json/data.json — 백업: data_json/backup/<br>
      운영 시 <b>TB_DATA_DIR</b> 환경변수로 앱 폴더 밖(예: /var/lib/travelbudget)을 지정하면 배포 시 덮어써도 데이터가 보존됩니다.</div></div>`;""",
"""    <div class="card"><h2>저장 위치</h2>
      <div class="note">정적(GitHub Pages) 버전 — 데이터는 이 브라우저의 localStorage에 저장됩니다(브라우저별 개별). 여러 명이 공유하는 원장은 사내 Flask 버전을 사용하세요.</div></div>`;""", "data-note")
# 예산 CSV 링크 → Blob 다운로드
app = app.replace('<a class="btn" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">${YQ} 예산 CSV</a>',
                  '<button class="btn" onclick="downloadBudgetCsv(YQ)">${YQ} 예산 CSV</button>')
app = app.replace('<a class="btn" href="${API}/export_budget.csv">전체 예산 CSV</a>',
                  '<button class="btn" onclick="downloadBudgetCsv(null)">전체 예산 CSV</button>')
app = app.replace('<a class="btn sm" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">상세 CSV</a>',
                  '<button class="btn sm" onclick="downloadCsv(YQ)">상세 CSV</button>')
app = app.replace('<a class="btn sm" href="${API}/export_budget.csv?yq=${encodeURIComponent(YQ)}">예산 CSV</a>',
                  '<button class="btn sm" onclick="downloadBudgetCsv(YQ)">예산 CSV</button>')
app = app.replace('<a class="btn" href="${API}/bulk_template.xls" style="margin-left:auto">엑셀 양식 내려받기 ↓</a>',
                  '<a class="btn" href="bulk_template.xls" style="margin-left:auto">엑셀 양식 내려받기 ↓</a>')
assert 'export_budget.csv' not in app and 'export.csv' not in app, "정적판에 남은 서버 CSV 링크가 있습니다"

# 정적판에는 Flask 라우트가 없다 — 같은 폴더의 파일로 연결
# 정적 사본에는 글꼴 파일을 넣지 않으므로 Jinja 조건부 블록을 통째로 걷어낸다
# 글꼴 — 정적판은 파일을 따로 받을 수 없으므로 서브셋을 base64 로 심는다.
# (전체 2.0MB 대신 화면 문구·흔한 성씨 이름을 덮는 150KB 서브셋. 없는 글자는 맑은 고딕으로)
_font = REPO / 'servera/travelbudget/static/fonts/ui-subset.woff2'
if _font.exists():
    import base64
    _b64 = base64.b64encode(_font.read_bytes()).decode()
    _face = ('@font-face{font-family:"TB UI";'
             f'src:url("data:font/woff2;base64,{_b64}") format("woff2-variations");'
             'font-weight:45 930;font-style:normal;font-display:swap}')
    tpl = re.sub(r'\{% if ui_font == "var" %\}.*?\{% endif %\}', _face, tpl, flags=re.S)
    tpl = tpl.replace('{% if ui_font %}"TB UI",{% endif %}', '"TB UI",')
else:
    tpl = re.sub(r'\{% if ui_font == "var" %\}.*?\{% endif %\}', '', tpl, flags=re.S)
    tpl = tpl.replace('{% if ui_font %}"TB UI",{% endif %}', '')
tpl = tpl.replace('href="/travelbudget/guide"', 'href="traveler_guide.html"')
app = app.replace('href="/travelbudget/guide"', 'href="traveler_guide.html"')
assert '/travelbudget/guide' not in tpl and '/travelbudget/guide' not in app, "정적판에 남은 서버 경로"

marker = '<script src="/travelbudget/static/app.js"></script>'
assert tpl.count(marker) == 1
out = tpl.replace(marker, "<script>\n" + backend + "\n</script>\n<script>\n" + app + "\n</script>")
(REPO/'docs/index.html').write_text(out, encoding='utf-8')
print(f"docs/index.html 조립 완료 ({len(out):,} chars)")

# 출장자용 안내 — 템플릿이 원본, docs/ 는 GitHub Pages 용 사본
guide = (REPO/'servera/travelbudget/templates/traveler_guide.html').read_text(encoding='utf-8')
(REPO/'docs/traveler_guide.html').write_text(guide, encoding='utf-8')
print(f"docs/traveler_guide.html 복사 완료 ({len(guide):,} chars)")
