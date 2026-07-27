#!/usr/bin/env python3
"""docs/index.html 조립 — Flask 템플릿 + 정적 백엔드 + app.js(호출부만 치환)."""
import sys, pathlib
REPO = pathlib.Path('/home/user/travelbudget')
BACKEND = pathlib.Path('/tmp/claude-0/-home-user-travelbudget/678b9f1e-5fe9-57c5-9eaf-46aaeecd42db/scratchpad/tb_local.js')
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
app = s1(app, '<a class="btn" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">CSV 다운로드</a></div>',
              '<button class="btn" onclick="downloadCsv(YQ)">CSV 다운로드</button></div>', "list-csv")
app = s1(app, """        <a class="btn pri" href="${API}/export.csv?yq=${encodeURIComponent(YQ)}">${YQ} 출장 CSV</a>
        <a class="btn" href="${API}/export.csv">전체 출장 CSV</a>""",
"""        <button class="btn pri" onclick="downloadCsv(YQ)">${YQ} 출장 CSV</button>
        <button class="btn" onclick="downloadCsv(null)">전체 출장 CSV</button>""", "data-csv")
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
assert 'export_budget.csv' not in app and 'export.csv' not in app, "정적판에 남은 서버 CSV 링크가 있습니다"

marker = '<script src="/travelbudget/static/app.js"></script>'
assert tpl.count(marker) == 1
out = tpl.replace(marker, "<script>\n" + backend + "\n</script>\n<script>\n" + app + "\n</script>")
(REPO/'docs/index.html').write_text(out, encoding='utf-8')
print(f"docs/index.html 조립 완료 ({len(out):,} chars)")
