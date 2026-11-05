"""In-process lock ordering: production lane (L1), verification (L3), repository (L4)."""
from contextlib import contextmanager
import threading

_local = threading.local()


class OrderedLock:
    def __init__(self, rank, *, reentrant=False):
        self.rank = rank
        self._lock = threading.RLock() if reentrant else threading.Lock()

    def acquire(self, blocking=True):
        held = getattr(_local, "held", [])
        if held and (self.rank < held[-1].rank or (self.rank == held[-1].rank and self is not held[-1])):
            raise RuntimeError("lock order violation")
        if self in held and self.rank == 1:
            raise RuntimeError("production lane lock is not reentrant")
        if not self._lock.acquire(blocking=blocking):
            return False
        _local.held = held + [self]
        return True

    def release(self):
        held = getattr(_local, "held", [])
        if not held or held[-1] is not self:
            raise RuntimeError("locks must be released in reverse order")
        self._lock.release()
        _local.held = held[:-1]

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()


class Lanes:
    def __init__(self):
        self._registry = {}
        self._guard = threading.Lock()

    @contextmanager
    def try_hold(self, producer, method):
        with self._guard:
            lock = self._registry.setdefault((producer, method), OrderedLock(1))
        acquired = lock.acquire(blocking=False)
        try:
            yield acquired
        finally:
            if acquired:
                lock.release()
