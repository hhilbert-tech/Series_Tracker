import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.fakes import FakeClient
from tracker.web import create_app

CSS = (Path(__file__).parent.parent / "tracker" / "static" / "style.css").read_text()


def tokens(block):
    return dict(re.findall(r"(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})", block))


def blocks():
    light = re.search(r":root\s*\{(.*?)\}", CSS, re.S).group(1)
    media = re.search(r"@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme=\"light\"\]\)\s*\{(.*?)\}", CSS, re.S).group(1)
    forced = re.search(r":root\[data-theme=\"dark\"\]\s*\{(.*?)\}", CSS, re.S).group(1)
    return tokens(light), tokens(media), tokens(forced)


def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


PAIRS = [("--text", "--bg"), ("--text", "--surface"), ("--muted", "--bg"), ("--muted", "--surface"),
         ("--accent", "--bg"), ("--accent", "--surface"), ("--on-accent", "--accent"), ("--danger", "--surface")]


def test_dark_values_identical_for_media_query_and_manual_override():
    _, media, forced = blocks()
    assert media == forced and media


@pytest.mark.parametrize("which", [0, 1])
def test_both_themes_meet_wcag_aa(which):
    t = blocks()[which]
    for fg, bg in PAIRS:
        assert ratio(t[fg], t[bg]) >= 4.5, (which, fg, bg, ratio(t[fg], t[bg]))


def test_light_and_dark_differ():
    light, dark, _ = blocks()
    assert light["--bg"] != dark["--bg"]


# Acceptance test 11
@pytest.fixture
def env(tmp_path):
    app = create_app(db_path=tmp_path / "t.db", covers_dir=tmp_path / "c",
                     client_factory=FakeClient, fetcher=lambda u: None)
    return app


def test_default_is_system(env):
    html = TestClient(env).get("/").text
    assert 'data-theme="system"' in html


@pytest.mark.parametrize("choice", ["dark", "light", "system"])
def test_choice_persists_across_reloads(env, choice):
    tc = TestClient(env)
    r = tc.post("/theme", data={"theme": choice}, follow_redirects=False)
    assert r.status_code == 303
    assert f'data-theme="{choice}"' in tc.get("/").text
    assert f'data-theme="{choice}"' in TestClient(env).get("/").text      # fresh client == reload


def test_invalid_theme_rejected(env):
    assert TestClient(env).post("/theme", data={"theme": "neon"}, follow_redirects=False).status_code == 400
