from flask import Flask, redirect
from servera import travelbudget

app = Flask(__name__)
app.register_blueprint(travelbudget)

@app.route('/')
def home():
    return redirect('/travelbudget/')

@app.route('/favicon.ico')
def favicon():
    return ('', 204)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=False)
