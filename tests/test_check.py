import pytest

from tests.conftest import TODAY
from tests.fakes import book
from tracker import db
from tracker.check import main, run_check
from tracker.hardcover import HardcoverAuthError

PAST = "2020-01-01"
FUTURE = "2027-03-01"


def add_series(conn, hc_id=1, name="Harbor Lights", max_read=3, muted=0):
    sid = db.upsert_series(conn, hc_id, name, "A. Writer")
    conn.execute("UPDATE series SET muted=? WHERE id=?", (muted, sid))
    db.bump_progress(conn, sid, max_read)
    conn.commit()
    return sid


def four_books(date4):
    return [book(1, date=PAST), book(2, date=PAST), book(3, date=PAST), book(4, date=date4)]


def log_count(conn):
    return conn.execute("SELECT COUNT(*) FROM notification_log").fetchone()[0]


# Acceptance test 3
@pytest.mark.parametrize("date4", [FUTURE, None])
def test_announces_next_book(conn, client, date4):
    add_series(conn)
    client.series[1] = four_books(date4)
    res = run_check(conn, client, today=TODAY)
    assert [(e["kind"], e["position"]) for e in res.events] == [("announced", 4.0)]
    assert not res.errors


# Acceptance test 4
def test_second_run_emits_nothing(conn, client):
    add_series(conn)
    client.series[1] = four_books(FUTURE)
    run_check(conn, client, today=TODAY)
    n = log_count(conn)
    again = run_check(conn, client, today=TODAY)
    assert again.events == [] and log_count(conn) == n


# Acceptance test 5
def test_muted_series_is_skipped(conn, client):
    add_series(conn, muted=1)
    client.series[1] = four_books(FUTURE)
    res = run_check(conn, client, today=TODAY)
    assert res.events == [] and client.calls == [] and log_count(conn) == 0


# Acceptance test 7 (job half)
def test_auth_failure_is_reported_not_raised(conn, client):
    add_series(conn, 1, "One")
    add_series(conn, 2, "Two")
    client.fail = HardcoverAuthError("Hardcover rejected the token (HTTP 401). Check HARDCOVER_TOKEN.")
    res = run_check(conn, client, today=TODAY)
    assert res.events == [] and len(res.errors) == 1 and "401" in res.errors[0]
    assert conn.execute("SELECT COUNT(*) FROM series WHERE last_checked_at IS NOT NULL").fetchone()[0] == 0
    assert len(client.calls) == 1  # stops hammering a rejected token


def test_other_errors_do_not_stop_remaining_series(conn, client):
    from tracker.hardcover import HardcoverError
    add_series(conn, 1, "One")
    add_series(conn, 2, "Two")
    client.series[2] = four_books(FUTURE)
    orig = client.series_books

    def flaky(sid):
        if sid == 1:
            raise HardcoverError("boom")
        return orig(sid)

    client.series_books = flaky
    res = run_check(conn, client, today=TODAY)
    assert len(res.errors) == 1 and "One" in res.errors[0]
    assert [e["kind"] for e in res.events] == ["announced"]


def test_cli_returns_error_code_instead_of_crashing(conn, client, capsys):
    add_series(conn)
    client.fail = HardcoverAuthError("Hardcover rejected the token (HTTP 401). Check HARDCOVER_TOKEN.")
    assert main(["--dry-run"], client=client, conn=conn) == 2
    assert "401" in capsys.readouterr().err


# Baseline + later behaviour
def test_first_sight_of_already_released_books_is_silent(conn, client):
    add_series(conn, max_read=1)
    client.series[1] = [book(i, date=PAST) for i in range(1, 5)]
    assert run_check(conn, client, today=TODAY).events == []
    # and does not resurface as "released" later
    assert run_check(conn, client, today=TODAY).events == []


def test_date_change_then_release(conn, client):
    add_series(conn)
    client.series[1] = four_books("2026-12-01")
    run_check(conn, client, today=TODAY)

    client.series[1] = four_books("2027-02-01")
    res = run_check(conn, client, today=TODAY)
    assert [(e["kind"], e["old_date"], e["release_date"]) for e in res.events] == \
        [("date_changed", "2026-12-01", "2027-02-01")]

    from datetime import date
    res = run_check(conn, client, today=date(2027, 2, 2))
    assert [e["kind"] for e in res.events] == ["released"]
    assert run_check(conn, client, today=date(2027, 2, 3)).events == []


def test_new_book_after_baseline_is_announced(conn, client):
    add_series(conn)
    client.series[1] = [book(i, date=PAST) for i in range(1, 4)]
    run_check(conn, client, today=TODAY)
    client.series[1] = client.series[1] + [book(4, date=FUTURE)]
    res = run_check(conn, client, today=TODAY)
    assert [(e["kind"], e["position"]) for e in res.events] == [("announced", 4.0)]


def test_decimal_positions_never_announce(conn, client):
    add_series(conn, max_read=3)
    client.series[1] = [book(1, date=PAST), book(2, date=PAST), book(3, date=PAST), book(3.5, date=FUTURE)]
    assert run_check(conn, client, today=TODAY).events == []


def test_completed_series_fully_read_is_skipped(conn, client):
    sid = add_series(conn, max_read=3)
    client.series[1] = [book(i, date=PAST) for i in range(1, 4)]
    run_check(conn, client, today=TODAY)
    conn.execute("UPDATE series SET complete=1 WHERE id=?", (sid,))
    client.calls.clear()
    run_check(conn, client, today=TODAY)
    assert client.calls == []
