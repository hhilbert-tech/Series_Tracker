from tests.conftest import TODAY
from tests.fakes import book
from tracker import db
from tracker.check import run_check
from tracker.notify import build_digest, deliver_pending


def seeded(conn, client):
    sid = db.upsert_series(conn, 1, "Harbor <Lights>", "A. Writer")
    db.bump_progress(conn, sid, 3)
    conn.commit()
    client.series[1] = [book(3, date="2020-01-01"), book(4, "Tides & Ties", date="2027-03-01")]
    return sid


def test_digest_content_and_escaping(conn, client):
    seeded(conn, client)
    res = run_check(conn, client, today=TODAY)
    d = build_digest(res.events, base_url="http://tracker.example")
    assert "Harbor <Lights>" in d.text and "Tides & Ties" in d.text
    assert "Harbor &lt;Lights&gt;" in d.html and "Tides &amp; Ties" in d.html
    assert 'alt="Cover of Tides &amp; Ties"' in d.html
    assert "http://tracker.example/" in d.html
    assert "prefers-color-scheme" not in d.html          # light theme only
    assert "announced" in d.subject.lower() or "new" in d.subject.lower()


def test_deliver_marks_sent_and_retries_after_failure(conn, client):
    seeded(conn, client)
    run_check(conn, client, today=TODAY)
    sent = []

    def boom(d):
        raise OSError("smtp down")

    assert deliver_pending(conn, boom, base_url="http://x") == 0
    assert conn.execute("SELECT COUNT(*) FROM notification_log WHERE sent_at IS NULL").fetchone()[0] == 1
    assert deliver_pending(conn, sent.append, base_url="http://x") == 1     # retried
    assert conn.execute("SELECT COUNT(*) FROM notification_log WHERE sent_at IS NULL").fetchone()[0] == 0
    assert deliver_pending(conn, sent.append, base_url="http://x") == 0     # nothing -> no email
    assert len(sent) == 1
