"""Atomic admission and explicit resumption of AI launches."""
from contextlib import contextmanager
from functools import wraps
import threading


class LaunchDenied(BaseException):
    """A closed gate denied a new permit; ordinary error handlers must not catch this."""


class LaunchGate:
    def __init__(self):
        self._condition = threading.Condition()
        self._open = True
        self._active = 0
        self._closing = 0
        self._local = threading.local()

    @property
    def is_open(self):
        with self._condition:
            return self._open

    def held(self):
        return bool(getattr(self._local, 'depth', 0))

    @contextmanager
    def unit(self):
        """One launch unit (a single task). Entering it from outside any unit re-checks the gate even when this thread
        already holds a wider permit; code running inside an admitted unit (the task's own launcher) inherits it, so an
        admitted task is never cut off between its preparation and its PID record."""
        with self._condition:
            inside = getattr(self._local, 'unit', 0)
        with self.permit(recheck=not inside):
            self._local.unit = inside + 1
            try:
                yield
            finally:
                self._local.unit = inside

    @contextmanager
    def permit(self, recheck=False):
        with self._condition:
            depth = getattr(self._local, 'depth', 0)
            if not depth:
                if not self._open:
                    raise LaunchDenied()
                self._active += 1
            elif recheck and not self._open:
                raise LaunchDenied()
            self._local.depth = depth + 1
        try:
            yield
        finally:
            with self._condition:
                self._local.depth -= 1
                if not self._local.depth:
                    self._active -= 1
                    self._condition.notify_all()

    def close(self):
        if self.held():
            raise RuntimeError('cannot close the launch gate while holding its permit')
        with self._condition:
            self._closing += 1
            self._open = False
            self._condition.notify_all()
            try:
                self._condition.wait_for(lambda: self._active == 0)
            finally:
                self._closing -= 1
                self._condition.notify_all()

    def open(self):
        """Reopen only after all close callers have observed the drained gate."""
        if self.held():
            raise RuntimeError('cannot open the launch gate while holding its permit')
        with self._condition:
            self._condition.wait_for(lambda: self._closing == 0)
            self._open = True
            self._condition.notify_all()



def task_launch_scope(fn):
    """Hold one launch unit from a parallel task launcher's first durable write through its PID/run evidence."""
    @wraps(fn)
    def wrapped(self, *args, **kwargs):
        with self.sup.launch_gate.unit():
            return fn(self, *args, **kwargs)
    return wrapped
