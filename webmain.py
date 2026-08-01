import os

from flask import Flask, redirect
# 사내 서버의 servera/__init__.py 는 이 프로젝트 소유가 아니므로
# 패키지 재노출에 기대지 않고 블루프린트를 직접 가져온다. (DEPLOY.md 와 동일한 import)
from servera.travelbudget import travelbudget

app = Flask(__name__)
app.register_blueprint(travelbudget)

@app.route('/')
def home():
    return redirect('/travelbudget/')

@app.route('/favicon.ico')
def favicon():
    return ('', 204)

if __name__ == '__main__':
    # 포트는 환경변수로 바꿀 수 있다.
    # macOS 12+ 는 5000 번을 AirPlay 수신 모드가 쓰고 있어서 그대로 두면 뜨지 않거나
    # 엉뚱한 응답이 온다 — 맥에서 볼 때는 TB_PORT=5050 처럼 지정한다.
    try:
        port = int(os.environ.get('TB_PORT') or 5000)
    except ValueError:
        port = 5000
    # data.json 단일 파일 저장이라 프로세스는 1개만 띄운다 (다중 worker 금지 — DEPLOY.md 참고)
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True, processes=1)
