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
    # data.json 단일 파일 저장이라 프로세스는 1개만 띄운다 (다중 worker 금지 — DEPLOY.md 참고)
    app.run(host='0.0.0.0', port=5000, debug=False, threaded=True, processes=1)
