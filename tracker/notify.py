"""Digest email: one per run, only when something is pending. Light theme only (email clients vary)."""
import html
import os
import smtplib
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from urllib.parse import urlencode

LABEL = {"announced": "New book announced", "date_changed": "Release date changed", "released": "Now released"}


class ConfigError(Exception):
    pass


@dataclass
class Digest:
    subject: str
    text: str
    html: str


def pending_events(conn):
    rows = conn.execute(
        """SELECT n.id, n.series_id, s.name AS series_name, n.hardcover_book_id, n.kind, n.position, n.title,
                  n.release_date, n.detail AS old_date,
                  (SELECT cover_path FROM series_book sb WHERE sb.series_id=n.series_id AND sb.position=n.position) AS cover_path
           FROM notification_log n JOIN series s ON s.id=n.series_id
           WHERE n.sent_at IS NULL AND n.suppressed=0 ORDER BY s.name, n.position, n.id""").fetchall()
    return [dict(r) for r in rows]


def _cover_url(base, e):
    if e.get("cover_path"):
        return f"{base}/covers/{e['cover_path']}"
    return f"{base}/placeholder.svg?" + urlencode({"title": e["title"] or "", "seed": e["series_name"]})


def _line(e):
    when = e["release_date"] or "date TBA"
    if e["kind"] == "date_changed":
        when = f"{e.get('old_date') or 'TBA'} -> {when}"
    pos = f"#{e['position']:g} " if e.get("position") is not None else ""
    return LABEL[e["kind"]], f"{pos}{e['title']}", when


def build_digest(events, base_url) -> Digest:
    base = base_url.rstrip("/")
    groups = {}
    for e in events:
        groups.setdefault(e["series_name"], []).append(e)
    n, m = len(events), len(groups)
    subject = f"Series Tracker: {n} new update{'s' if n != 1 else ''} in {m} series"

    text, parts = [], []
    for name, evs in groups.items():
        text.append(name)
        rows = []
        for e in evs:
            label, title, when = _line(e)
            text.append(f"  - {label}: {title} ({when})")
            rows.append(
                '<tr><td style="padding:6px 12px 6px 0;vertical-align:top">'
                f'<img src="{html.escape(_cover_url(base, e), quote=True)}" alt="Cover of {html.escape(e["title"] or "", quote=True)}" '
                'width="60" style="display:block;border-radius:3px;background:#eee"></td>'
                f'<td style="padding:6px 0;vertical-align:top"><strong>{html.escape(title)}</strong><br>'
                f'<span style="color:#5f5a54">{html.escape(label)} &middot; {html.escape(when)}</span></td></tr>')
        text.append("")
        parts.append(f'<h2 style="font:600 16px Georgia,serif;margin:18px 0 4px;color:#1d1b19">{html.escape(name)}</h2>'
                     f'<table role="presentation" cellspacing="0" cellpadding="0">{"".join(rows)}</table>')
    body = (f'<div style="font:14px/1.4 -apple-system,Segoe UI,Arial,sans-serif;color:#1d1b19;background:#ffffff;'
            f'max-width:560px;margin:0 auto;padding:16px">{"".join(parts)}'
            f'<p style="color:#5f5a54;font-size:12px;margin-top:24px">Manage or mute series at {html.escape(base)}</p></div>')
    return Digest(subject, "\n".join(text), body)


def deliver_pending(conn, send, base_url) -> int:
    """Send one digest for everything pending; mark sent only on success. Returns events delivered."""
    events = pending_events(conn)
    if not events:
        return 0
    try:
        send(build_digest(events, base_url))
    except Exception as e:  # noqa: BLE001 - keep queued, retry next run
        print(f"ERROR: could not send digest ({type(e).__name__}: {e}); will retry next run", file=sys.stderr)
        return 0
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    conn.executemany("UPDATE notification_log SET sent_at=? WHERE id=?", [(now, e["id"]) for e in events])
    conn.commit()
    return len(events)


def smtp_sender_from_env(env=None):
    env = os.environ if env is None else env
    names = ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "NOTIFY_TO")
    missing = [k for k in names if not env.get(k)]
    if missing:
        raise ConfigError("Missing email settings: " + ", ".join(missing))
    host, user, pw, to = (env[k] for k in names)
    port = int(env.get("SMTP_PORT", "587"))
    sender = env.get("SMTP_FROM", user)

    def send(d: Digest):
        msg = EmailMessage()
        msg["Subject"], msg["From"], msg["To"] = d.subject, sender, to
        msg.set_content(d.text)
        msg.add_alternative(d.html, subtype="html")
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=30) as s:
                s.login(user, pw)
                s.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as s:
                s.starttls()
                s.login(user, pw)
                s.send_message(msg)
    return send
