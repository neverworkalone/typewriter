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
        "푸르다": [([tok("푸르", "VA"), tok("다", "EF")], 0.0)],
        "바라다": [([tok("바라", "VV")], 0.0), ([tok("바람", "NNG")], -1.0)],
        "물결무늬": [([tok("물결", "NNG"), tok("무늬", "NNG")], 0.0)],
        "조사만": [([tok("만", "JX")], 0.0)],
    }

    def analyze(self, text, top_n):
        if text == "오류":
            raise RuntimeError("boom")
        return self.TABLE.get(text, [])


class KiwiServiceTest(unittest.TestCase):
    def run_batch(self, texts):
        requests = [{"id": str(i), "text": t} for i, t in enumerate(texts)]
        return service.analyze_batch(FakeAnalyzer(), requests)["results"]

    def test_statuses_are_explicit_and_ordered(self):
        results = self.run_batch(["푸르다", "바라다", "물결무늬", "조사만", "없음", "오류", ""])
        self.assertEqual([r["id"] for r in results], [str(i) for i in range(7)])
        self.assertEqual(results[0]["status"], "ok")
        self.assertEqual(results[0]["proposals"], [{"lemma": "푸르다", "pos": "adjective", "form": "푸르"}])
        self.assertEqual(results[1]["status"], "ambiguous")
        self.assertEqual(len(results[2]["proposals"]), 2)
        self.assertEqual(results[3]["reason"], "no_content_morpheme")
        self.assertEqual(results[4]["reason"], "no_analysis")
        self.assertEqual(results[5]["status"], "error")
        self.assertEqual(results[6]["status"], "unsupported")

    def test_batch_limit_and_metadata(self):
        with self.assertRaises(ValueError):
            service.analyze_batch(FakeAnalyzer(), [{"id": "x", "text": "푸르다"}] * (service.MAX_BATCH_SIZE + 1))
        self.assertIn("kiwipiepy_version", service.run_metadata())


if __name__ == "__main__":
    unittest.main()
