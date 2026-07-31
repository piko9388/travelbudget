#!/usr/bin/env python3
"""출장자용 안내서의 화면 캡처를 다시 만들어 HTML 안에 끼워 넣는다.

    python3 tools/build_guide.py

화면(UI)이 바뀌면 안내서의 캡처가 낡는다. 낡은 캡처는 없느니만 못하므로
UI 를 손댄 뒤에는 이 스크립트를 한 번 돌린다.

동작
    1. tools/guide/capture.mjs 로 각 단계 화면을 element 단위로 캡처 (Playwright)
    2. Pillow 로 잘라내고 팔레트 축소 — 70KB 내외로 줄인다
    3. traveler_guide.html 의 <figure data-shot="키"> 안 <img> 를 통째로 교체
       (data: URI 로 넣으므로 파일 하나만 있으면 메일·인쇄가 그대로 된다)

필요
    PLAYWRIGHT_PATH — playwright 모듈 경로 (없으면 'playwright' 로 찾는다)
    Pillow          — pip install pillow
"""
import base64
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GUIDE = REPO / "servera/travelbudget/templates/traveler_guide.html"
CAPTURE = REPO / "tools/guide/capture.mjs"
NODE = os.environ.get("NODE_BIN", "node")

# 단계별로 필요한 만큼만 남기고 색을 줄인다. UI 스크린샷은 색이 적어 손실이 거의 없다.
JOBS = {
    "s1-plan":    dict(crop=None,          colors=64),
    "s2-confirm": dict(crop=None,          colors=32),
    "s3-actual":  dict(crop=None,          colors=64),
    "s4-mail":    dict(crop=None,          colors=64),
    "s5-list":    dict(crop=(0, 0, 908, 430), colors=64),   # 위 몇 행이면 배지를 다 보여준다
}


def main():
    try:
        from PIL import Image
    except ImportError:
        print("Pillow 가 필요합니다 —  pip install pillow", file=sys.stderr)
        return 1
    if not CAPTURE.exists():
        print(f"캡처 스크립트가 없습니다: {CAPTURE}", file=sys.stderr)
        return 1

    out = Path(tempfile.mkdtemp(prefix="tb_guide_"))
    seed = out / "seed"
    seed.mkdir()
    # 캡처용 임시 원장 — 운영 데이터는 쓰지 않는다
    sys.path.insert(0, str(REPO))
    import json
    os.environ.setdefault("TB_DATA_DIR", str(out / "_scratch"))
    from servera.travelbudget import store
    (seed / "data.json").write_text(
        json.dumps(store.example_data(), ensure_ascii=False), encoding="utf-8")

    env = dict(os.environ, SEED=str(seed))
    print("1) 화면 캡처")
    r = subprocess.run([NODE, str(CAPTURE), str(out)], cwd=REPO, env=env)
    if r.returncode != 0:
        print("캡처 실패 — PLAYWRIGHT_PATH 를 확인하세요", file=sys.stderr)
        return 1

    print("2) 용량 줄이기")
    blobs = {}
    for name, j in JOBS.items():
        src = out / f"{name}.png"
        if not src.exists():
            print(f"   ! {name} 캡처 없음 — 건너뜀", file=sys.stderr)
            continue
        im = Image.open(src).convert("RGB")
        if j["crop"]:
            im = im.crop(j["crop"])
        q = im.quantize(colors=j["colors"], method=Image.MEDIANCUT, dither=Image.NONE)
        dst = out / f"{name}.opt.png"
        q.save(dst, optimize=True)
        blobs[name] = base64.b64encode(dst.read_bytes()).decode()
        print(f"   {name:12s} {im.size[0]}×{im.size[1]}  "
              f"{src.stat().st_size:>7,} → {dst.stat().st_size:>7,} bytes")

    print("3) 안내서에 끼워 넣기")
    html = GUIDE.read_text(encoding="utf-8")
    n = 0
    for name, b64 in blobs.items():
        # <figure data-shot="키"> 안의 <img src="..."> 만 교체 — 설명·구조는 건드리지 않는다
        pat = re.compile(
            r'(<figure class="shot" data-shot="' + re.escape(name) + r'">.*?<img[^>]*?src=")[^"]*(")',
            re.S)
        html, k = pat.subn(lambda m: m.group(1) + "data:image/png;base64," + b64 + m.group(2), html)
        if k:
            n += k
        else:
            print(f"   ! data-shot=\"{name}\" 자리를 찾지 못했습니다", file=sys.stderr)
    GUIDE.write_text(html, encoding="utf-8")
    size = len(html.encode("utf-8"))
    print(f"   {n}장 교체 · 안내서 {size:,} bytes")
    if size > 300_000:
        print("   ! 300KB 를 넘었습니다 — 메일 첨부가 불편해집니다", file=sys.stderr)

    print("4) docs 사본 갱신")
    subprocess.run([sys.executable, str(REPO / "tools/build_docs.py")], cwd=REPO)
    print("\n완료. 캡처가 화면과 맞는지 눈으로 한 번 확인하세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
