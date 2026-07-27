#!/usr/bin/env python3
"""QWEN_PROMPT.md 의 프롬프트 블록 → app.js 의 QWEN_PROMPT 상수로 주입.

문서와 화면이 어긋나지 않도록 .md 를 단일 원본으로 둔다.
프롬프트를 고쳤으면 이 스크립트를 돌린 뒤 tools/build_docs.py 를 돌린다.
(어긋나면 test_api.py §19 가 실패한다)
"""
import pathlib, re, sys

REPO = pathlib.Path(__file__).resolve().parent.parent
MD = REPO / "QWEN_PROMPT.md"
APP = REPO / "servera/travelbudget/static/app.js"
START = "/* QWEN_PROMPT_START — QWEN_PROMPT.md 에서 자동 주입. 직접 고치지 말 것 */"
END = "/* QWEN_PROMPT_END */"


def extract(md_text):
    """```` 로 감싼 text 블록 하나를 꺼낸다."""
    m = re.search(r"^````text\n(.*?)^````$", md_text, re.S | re.M)
    if not m:
        sys.exit("QWEN_PROMPT.md 에서 ````text 블록을 찾지 못했습니다.")
    return m.group(1).rstrip("\n")


def main():
    prompt = extract(MD.read_text(encoding="utf-8"))
    for bad, why in (("`", "백틱"), ("${", "템플릿 치환자"), ("</script", "스크립트 종료 태그")):
        if bad in prompt:
            sys.exit(f"프롬프트에 {why}({bad})가 있어 JS 템플릿 리터럴로 넣을 수 없습니다.")
    app = APP.read_text(encoding="utf-8")
    block = f"{START}\nconst QWEN_PROMPT = `{prompt}`;\n{END}"
    if START in app:
        app = re.sub(re.escape(START) + r".*?" + re.escape(END), lambda _: block, app, flags=re.S)
    else:
        sys.exit("app.js 에 QWEN_PROMPT_START/END 표식이 없습니다.")
    APP.write_text(app, encoding="utf-8")
    print(f"app.js 에 프롬프트 주입 완료 ({len(prompt):,}자, {prompt.count(chr(10)) + 1}줄)")


if __name__ == "__main__":
    main()
