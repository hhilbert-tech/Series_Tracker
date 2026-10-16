"""Sliding-window rate limiter (Hardcover: 60 requests/minute)."""
import threading
import time
from collections import deque


class RateLimiter:
    def __init__(self, max_calls=60, period=60.0, clock=time.monotonic, sleep=time.sleep):
        self.max_calls, self.period = max_calls, period
        self._clock, self._sleep = clock, sleep
        self._stamps = deque()
        self._lock = threading.Lock()

    def acquire(self):
        with self._lock:
            while True:
                now = self._clock()
                while self._stamps and now - self._stamps[0] >= self.period:
                    self._stamps.popleft()
                if len(self._stamps) < self.max_calls:
                    self._stamps.append(now)
                    return
                self._sleep(self._stamps[0] + self.period - now)
