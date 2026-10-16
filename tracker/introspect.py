"""Check the field names this app relies on against Hardcover's live schema.

    HARDCOVER_TOKEN=... python -m tracker.introspect
"""
import sys

from .hardcover import HardcoverClient, HardcoverError

EXPECTED = {
    "books": ["id", "title", "release_date", "image", "canonical_id", "is_partial_book", "compilation",
              "users_count", "contributions", "book_series"],
    "editions": ["isbn_13", "isbn_10", "book"],
    "series": ["id", "name", "is_completed", "author", "books_count"],
    "book_series": ["position", "series", "book", "book_id", "series_id"],
    "user_books": ["status_id", "book"],
}
Q = "query($n: String!) { __type(name: $n) { fields { name } } }"


def main() -> int:
    client = HardcoverClient.from_env()
    bad = 0
    try:
        for typ, fields in EXPECTED.items():
            t = client._gql(Q, {"n": typ}).get("__type")
            have = {f["name"] for f in (t or {}).get("fields", [])}
            missing = [f for f in fields if f not in have]
            print(f"{typ}: {'OK' if t and not missing else 'MISSING ' + (', '.join(missing) if t else 'type not found')}")
            bad += bool(missing or not t)
    except HardcoverError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
