from tracker.ratelimit import RateLimiter


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


# Acceptance test 6
def test_never_exceeds_60_per_minute():
    c = Clock()
    rl = RateLimiter(60, 60.0, clock=c.now, sleep=c.sleep)
    stamps = []
    for _ in range(250):
        rl.acquire()
        stamps.append(c.t)
    for s in stamps:
        assert sum(1 for x in stamps if s <= x < s + 60.0) <= 60
    assert stamps[59] == 0.0          # burst of 60 allowed immediately
    assert stamps[60] >= 60.0         # 61st must wait for the window


def test_spaced_calls_do_not_sleep():
    c = Clock()
    rl = RateLimiter(2, 10.0, clock=c.now, sleep=c.sleep)
    for _ in range(5):
        rl.acquire()
        c.t += 6.0
    assert c.t == 30.0
