"""Synthetic regressions for khaiii_service.py (no Khaiii install required; NOT proof the official binary ran)."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

SPEC = importlib.util.spec_from_file_location("khaiii_service", Path(__file__).with_name("khaiii_service.py"))
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


def word(*pairs):
    return SimpleNamespace(morphs=[SimpleNamespace(lex=lex, tag=tag) for lex, tag in pairs])


class FakeApi:
    TABLE = {
        "먹었다": [word(("먹", "VV"), ("었", "EP"), ("다", "EC"))],
        "아름다웠던": [word(("아름답", "VA"), ("었", "EP"), ("던", "ETM"))],
        "망각했다": [word(("망각", "NNG"), ("하", "XSV"), ("였", "EP"), ("다", "EC"))],
        "행복한": [word(("행복", "NNG"), ("하", "XSA"), ("ㄴ", "ETM"))],
        "사사하다": [word(("사", "NNG"), ("사", "NNG"), ("하", "XSV"))],
        "물결무늬": [word(("물결", "NNG"), ("무늬", "NNG"))],
        "서울에": [word(("서울", "NNP"), ("에", "JKB"))],
        "조사만": [word(("만", "JX"))],
        "ㅁㅁㅁ": [word(("ㅁ", "NNG"), ("ㅁㅁ", "NNG"))],
        "둘셋": [word(("둘", "NNG")), word(("셋", "NNG"))],
    }

    def analyze(self, text):
        if text == "오류":
            raise RuntimeError("boom")
        return self.TABLE.get(text, [])


def one(text):
    return service.analyze_one(FakeApi(), text)


class KhaiiiServiceTest(unittest.TestCase):
    def test_inflected_predicates_map_to_dictionary_form(self):
        self.assertEqual(one("먹었다")["analyses"], [[{"lemma": "먹다", "pos": "verb", "form": "먹"}]])
        self.assertEqual(one("아름다웠던")["analyses"][0][0]["lemma"], "아름답다")

    def test_derivation_is_one_predicate_without_invented_links(self):
        for text, lemma, pos in (("망각했다", "망각하다", "verb"), ("행복한", "행복하다", "adjective")):
            path = one(text)["analyses"][0]
            self.assertEqual(path, [{"lemma": lemma, "pos": pos, "form": lemma[:-1]}])
            self.assertFalse(any(k.startswith("derived_from") for k in path[0]))

    def test_unrelated_extra_morpheme_stays_visible_for_the_resolver(self):
        path = one("사사하다")["analyses"][0]
        self.assertEqual([item["lemma"] for item in path], ["사", "사하다"])
        self.assertEqual([item["lemma"] for item in one("물결무늬")["analyses"][0]], ["물결", "무늬"])

    def test_single_best_path_and_no_scores(self):
        result = one("먹었다")
        self.assertEqual(len(result["analyses"]), 1)
        self.assertNotIn("score", result)

    def test_unsupported_and_failure_are_explicit(self):
        self.assertEqual(one("서울에")["reason"], "unmapped_content_morpheme")
        self.assertEqual(one("조사만")["reason"], "no_content_morpheme")
        self.assertEqual(one("")["reason"], "empty_or_too_long")
        self.assertEqual(one("두 단어")["reason"], "multi_word_input")
        self.assertEqual(one("둘셋")["reason"], "no_analysis")
        self.assertEqual(one("없음")["reason"], "no_analysis")
        self.assertEqual(one("오류"), {"status": "error", "reason": "RuntimeError", "analyses": []})

    def test_non_hangul_form_is_not_proposed(self):
        self.assertEqual(one("ㅁㅁㅁ")["status"], "unsupported")

    def test_batch_binds_input_digest(self):
        service.run_metadata = lambda: {"provider": "khaiii"}  # the resource bundle only exists in the container
        response = service.analyze_batch(FakeApi(), [{"id": "x", "text": "먹었다"}])
        self.assertEqual(len(response["results"][0]["input_digest"]), 64)
        with self.assertRaises(ValueError):
            service.analyze_batch(FakeApi(), [{"id": str(i), "text": "a"} for i in range(501)])


if __name__ == "__main__":
    unittest.main()
