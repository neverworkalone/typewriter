"""Test-only subprocess targets for validating the parallel runner's failure paths."""
from __future__ import annotations

import os
import unittest


class SuccessfulCase(unittest.TestCase):
    def test_success(self):
        self.assertEqual(2 + 2, 4)


class IntentionalFailure(unittest.TestCase):
    def test_failure(self):
        print("intentional worker stdout")
        self.fail("intentional runner fixture failure")


class ProcessCrash(unittest.TestCase):
    def test_crash(self):
        os._exit(91)
