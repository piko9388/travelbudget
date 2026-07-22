from flask import Blueprint

travelbudget = Blueprint(
    "travelbudget", __name__,
    url_prefix="/travelbudget",
    template_folder="templates",
    static_folder="static",
    static_url_path="/static",
)

from . import routes  # noqa: E402,F401

__all__ = ["travelbudget"]
