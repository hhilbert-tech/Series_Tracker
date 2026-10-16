from tracker.covers import CoverCache, placeholder_svg

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


class Fetcher:
    def __init__(self, result):
        self.result = result
        self.urls = []

    def __call__(self, url):
        self.urls.append(url)
        r = self.result
        if isinstance(r, Exception):
            raise r
        return r


# Acceptance test 10
def test_no_cover_anywhere_uses_placeholder_and_hits_network_once(tmp_path):
    f = Fetcher(None)  # definitive "no image"
    cache = CoverCache(tmp_path, f)
    assert cache.get_or_fetch("k1", ["https://a/1.jpg", "https://b/2.jpg"]) is None
    assert len(f.urls) == 2
    assert cache.get_or_fetch("k1", ["https://a/1.jpg", "https://b/2.jpg"]) is None
    assert len(f.urls) == 2                       # no second round of requests
    svg = placeholder_svg("Harbor Lights", "Harbor Lights")
    assert svg.startswith("<svg") and "Harbor Lights" in svg


def test_found_cover_is_cached_on_disk(tmp_path):
    f = Fetcher((PNG, "image/png"))
    cache = CoverCache(tmp_path, f)
    name = cache.get_or_fetch("k2", ["https://a/1.png"])
    assert name and (tmp_path / name).read_bytes() == PNG
    assert cache.get_or_fetch("k2", ["https://a/1.png"]) == name
    assert len(f.urls) == 1


def test_falls_through_to_second_source(tmp_path):
    answers = {"https://a/1": None, "https://b/2": (PNG, "image/png")}
    cache = CoverCache(tmp_path, lambda u: answers[u])
    assert cache.get_or_fetch("k3", ["https://a/1", "https://b/2"]) is not None


def test_transient_failure_is_not_cached_as_missing(tmp_path):
    f = Fetcher(OSError("network down"))
    cache = CoverCache(tmp_path, f)
    assert cache.get_or_fetch("k4", ["https://a/1"]) is None
    f.result = (PNG, "image/png")
    assert cache.get_or_fetch("k4", ["https://a/1"]) is not None


def test_rejects_non_images_and_oversize(tmp_path):
    assert CoverCache(tmp_path, lambda u: (b"<html>", "text/html")).get_or_fetch("a", ["u"]) is None
    assert CoverCache(tmp_path, lambda u: (b"x" * (6 * 1024 * 1024), "image/jpeg")).get_or_fetch("b", ["u"]) is None


def test_placeholder_escapes_and_is_deterministic():
    a = placeholder_svg("<script>", "seed")
    assert "<script>" not in a and "&lt;script&gt;" in a
    assert a == placeholder_svg("<script>", "seed")
