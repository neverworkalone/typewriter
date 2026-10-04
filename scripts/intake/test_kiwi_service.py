"""Synthetic regressions for kiwi_service.py (no Kiwi install required)."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("kiwi_service", Path(__file__).with_name("kiwi_service.py"))
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


def tok(form, tag):
    return SimpleNamespace(form=form, tag=tag)


class FakeAnalyzer:
    TABLE = {
        "푸르다": [([tok("푸르", "VA-I"), tok("다", "EF")], 0.0)],
        "바라다": [([tok("바라", "VV")], 0.0), ([tok("바람", "NNG")], -1.0)],
        "물결무늬": [([tok("물결", "NNG"), tok("무늬", "NNG")], 0.0)],
        "매우": [([tok("매우", "MAG")], 0.0)],
        "조사만": [([tok("만", "JX")], 0.0)],
    }

    def analyze(self, text, top_n):
        if text == "오류":
            raise RuntimeError("boom")
        return self.TABLE.get(text, [])


class FlakyAnalyzer:
    """Corrupts the form on the first call(s), as kiwipiepy 0.24.0 occasionally does."""

    def __init__(self, bad_calls, bad_form="빚어\ufffd\ufffd"):
        self.calls = 0
        self.bad_calls = bad_calls
        self.bad_form = bad_form

    def analyze(self, text, top_n):
        self.calls += 1
        form = self.bad_form if self.calls <= self.bad_calls else "빚어지"
        return [([tok(form, "VV")], 0.0)]


class KiwiServiceTest(unittest.TestCase):
    def test_corrupted_output_is_retried_and_never_returned(self):
        recovered = service.analyze_one(FlakyAnalyzer(bad_calls=1), "빚어지다")
        self.assertEqual(recovered["status"], "ok")
        self.assertEqual(recovered["analyses"][0][0]["form"], "빚어지")
        unstable = service.analyze_one(FlakyAnalyzer(bad_calls=99), "빚어지다")
        self.assertEqual((unstable["status"], unstable["reason"]), ("error", "unstable_output"))

    def test_run_dependent_garbage_without_replacement_chars_is_not_accepted(self):
        class Drifting:
            calls = 0

            def analyze(self, text, top_n):
                self.calls += 1
                return [([tok(f"빚어{self.calls}", "VV")], 0.0)]

        outcome = service.analyze_one(Drifting(), "빚어지다")
        self.assertEqual((outcome["status"], outcome["reason"]), ("error", "unstable_output"))

    def run_batch(self, texts):
        requests = [{"id": str(i), "text": t} for i, t in enumerate(texts)]
        return service.analyze_batch(FakeAnalyzer(), requests)["results"]

    def test_statuses_are_explicit_and_ordered(self):
        results = self.run_batch(["푸르다", "바라다", "물결무늬", "조사만", "없음", "오류", ""])
        self.assertEqual([r["id"] for r in results], [str(i) for i in range(7)])
        self.assertEqual(results[0]["status"], "ok")
        self.assertEqual(results[0]["analyses"][0], [{"lemma": "푸르다", "pos": "adjective", "form": "푸르"}])
        self.assertEqual(len(results[1]["analyses"]), 2)
        self.assertEqual(len(results[2]["analyses"][0]), 2)
        self.assertEqual(results[3]["reason"], "no_content_morpheme")
        self.assertEqual(results[4]["reason"], "no_analysis")
        self.assertEqual(results[5]["status"], "error")
        self.assertEqual(results[6]["status"], "unsupported")

    def test_adverb_and_version_pin(self):
        self.assertEqual(self.run_batch(["매우"])[0]["analyses"][0][0]["pos"], "adverb")
        original = service._package_version
        service._package_version = lambda name: "9.9.9"
        try:
            with self.assertRaises(RuntimeError):
                service.verify_pinned_versions()
        finally:
            service._package_version = original

    def test_batch_limit_and_metadata(self):
        with self.assertRaises(ValueError):
            service.analyze_batch(FakeAnalyzer(), [{"id": "x", "text": "푸르다"}] * (service.MAX_BATCH_SIZE + 1))
        self.assertIn("kiwipiepy_version", service.run_metadata())


if __name__ == "__main__":
    unittest.main()
