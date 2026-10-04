"""Synthetic regressions for mecab_service.py (no MeCab install required; NOT proof the real runtime ran).

Outputs below are recorded from real mecab-ko 1.0.2 / mecab-ko-dic 1.0.0 `Tagger.parse` runs; the
real-runtime evidence lives in tests/factory-mecab-provider.test.mjs.
"""

import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("mecab_service", Path(__file__).with_name("mecab_service.py"))
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)

PLAIN = "*,*,*,*"


def tok(surface, tag, kind="*", first="*", last="*", expression="*"):
    return f"{surface}\t{tag},*,T,{surface},{kind},{first},{last},{expression}"


def out(*lines):
    return "\n".join(lines) + "\nEOS\n"


class FakeTagger:
    TABLE = {
        "먹었다": out(tok("먹", "VV"), tok("었", "EP"), tok("다", "EC")),
        "걸어": out(tok("걸", "VV", "Inflect", "VV", "VV", "걷/VV/*"), tok("어", "EC")),
        "도와": out(tok("도와", "VV+EC", "Inflect", "VV", "EC", "돕/VV/*+아/EC/*")),
        "망각했다": out(tok("망각", "NNG"), tok("했", "XSV+EP", "Inflect", "XSV", "EP", "하/XSV/*+았/EP/*"), tok("다", "EC")),
        "행복한": out(tok("행복", "NNG"), tok("한", "XSA+ETM", "Inflect", "XSA", "ETM", "하/XSA/*+ᆫ/ETM/*")),
        "아름다운": out(tok("아름다운", "VA+ETM", "Inflect", "VA", "ETM", "아름답/VA/*+ᆫ/ETM/*")),
        "천천히": out(tok("천천히", "MAG")),
        "꽃잎이": out(tok("꽃잎", "NNG", "Compound", "*", "*", "꽃/NNG/*+잎/NNG/*"), tok("이", "JKS")),
        "아버지가방에들어가신다": out(tok("아버지", "NNG"), tok("가", "JKS"), tok("방", "NNG"), tok("에", "JKB"), tok("들어가", "VV"),
                                tok("신다", "EP+EC", "Inflect", "EP", "EC", "시/EP/*+ㄴ다/EC/*")),
        "춥다": out(tok("춥다", "NNP")),
        "ㅋㅋㅋ": out(tok("ㅋㅋㅋ", "UNKNOWN")),
        "asdfgh": out(tok("asdfgh", "SL")),
        "먹어보다": out(tok("먹", "VV"), tok("어", "EC"), tok("보", "VX"), tok("다", "EC")),
        "먹": out(tok("먹", "VV")),
        "이다": out(tok("이", "VCP"), tok("다", "EC")),
        "사과이다": out(tok("사과", "NNG"), tok("이", "VCP"), tok("다", "EC")),
        "사과였다": out(tok("사과", "NNG"), tok("였", "VCP+EP", "Inflect", "VCP", "EP", "이/VCP/*+었/EP/*"), tok("다", "EC")),
        "사과아니다": out(tok("사과", "NNG"), tok("아니", "VCN"), tok("다", "EC")),
        "사과이다부호": out(tok("사과", "NNG"), tok("이", "ZZZ"), tok("다", "EC")),
        "사과가": out(tok("사과", "NNG"), tok("가", "JKS")),
        "먹었다.": out(tok("먹", "VV"), tok("었", "EP"), tok("다", "EF"), tok(".", "SF")),
        "사과이다만": out(tok("사과", "NNG"), tok("이", "VCP"), tok("다", "EF"), tok("만", "JX")),
        "서울에": out(tok("서울", "NNP"), tok("에", "JKB")),
        "합성": out(tok("합성", "NNG+JX")),
        "깨짐": "깨짐\tbroken\nEOS\n",
        "끊김": "EOS",
        "빈값": "EOS\n",
    }

    def parse(self, text):
        if text == "오류":
            raise RuntimeError("boom")
        return self.TABLE[text]


def one(text):
    return service.analyze_one(FakeTagger(), text)


def lemmas(text):
    result = one(text)
    assert result["status"] == "ok", (text, result)
    return [[f'{item["lemma"]}/{item["pos"]}' for item in path] for path in result["analyses"]]


class MecabServiceTest(unittest.TestCase):
    def test_plain_stem_gets_da_only_with_following_ending(self):
        self.assertEqual(lemmas("먹었다"), [["먹다/verb"]])
        self.assertEqual(one("먹")["reason"], "stem_without_ending")
        self.assertEqual(one("먹")["analyses"], [])

    def test_irregular_and_contracted_stems_come_from_the_dictionary_expression(self):
        self.assertEqual(lemmas("걸어"), [["걷다/verb"]])
        self.assertEqual(lemmas("도와"), [["돕다/verb"]])
        self.assertEqual(lemmas("아름다운"), [["아름답다/adjective"]])

    def test_derivation_is_one_predicate_without_a_root_link(self):
        self.assertEqual(lemmas("망각했다"), [["망각하다/verb"]])
        self.assertEqual(lemmas("행복한"), [["행복하다/adjective"]])
        for result in (one("망각했다"), one("행복한")):
            self.assertTrue(all("derived_from" not in item and "derived_from_index" not in item for item in result["analyses"][0]))

    def test_best_path_only_and_adverb_and_compound(self):
        self.assertEqual(lemmas("천천히"), [["천천히/adverb"]])
        self.assertEqual(lemmas("꽃잎이"), [["꽃잎/noun"]])
        self.assertEqual(len(one("걸어")["analyses"]), 1)

    def test_extra_content_morphemes_are_all_reported_for_the_shared_mismatch_hold(self):
        self.assertEqual(lemmas("아버지가방에들어가신다"), [["아버지/noun", "방/noun", "들어가다/verb"]])

    def test_unmapped_unknown_and_non_hangul_are_unsupported_not_guessed(self):
        for text in ["춥다", "ㅋㅋㅋ", "asdfgh", "먹어보다", "서울에"]:
            self.assertEqual(one(text)["status"], "unsupported", text)
            self.assertEqual(one(text)["analyses"], [], text)
        self.assertEqual(one("이다")["reason"], "unmapped_content_morpheme")
        self.assertEqual(one("합성")["reason"], "unexpandable_composite_tag")

    def test_unexplained_copula_or_unknown_tags_are_never_silently_dropped(self):
        # Before the functional-tag allowlist these returned ok with the bare noun (사과/noun).
        for text in ["사과이다", "사과였다", "사과아니다", "사과이다부호", "사과이다만"]:
            self.assertEqual((one(text)["status"], one(text)["reason"], one(text)["analyses"]), ("unsupported", "unmapped_content_morpheme", []), text)
        self.assertEqual(lemmas("사과가"), [["사과/noun"]], "particles stay harmless")
        self.assertEqual(lemmas("먹었다."), [["먹다/verb"]], "endings and punctuation stay harmless")
        for tag in ["JKS", "JX", "EP", "EF", "EC", "ETM", "SF", "SE", "SSO", "SY"]:
            self.assertTrue(service.FUNCTIONAL_TAG.match(tag), tag)
        for tag in ["VCP", "VCN", "ZZZ", "NNP", "SL", "SH", "SN"]:
            self.assertFalse(service.FUNCTIONAL_TAG.match(tag), tag)

    def test_invalid_input_and_malformed_output_fail_safe(self):
        self.assertEqual(one("   ")["reason"], "empty_or_too_long")
        self.assertEqual(one("가" * 2001)["reason"], "empty_or_too_long")
        self.assertEqual(one("두 단어")["reason"], "multi_word_input")
        self.assertEqual(one("빈값")["reason"], "no_analysis")
        for text in ["깨짐", "끊김"]:
            self.assertEqual((one(text)["status"], one(text)["reason"]), ("error", "malformed_output"))
        self.assertEqual((one("오류")["status"], one("오류")["reason"]), ("error", "RuntimeError"))

    def test_batch_is_ordered_bounded_and_digested(self):
        result = service.analyze_batch(FakeTagger(), [{"id": "b", "text": "먹었다"}, {"id": "a", "text": "천천히"}], {"provider": "mecab"})
        self.assertEqual([r["id"] for r in result["results"]], ["b", "a"])
        self.assertEqual(len(result["results"][0]["input_digest"]), 64)
        with self.assertRaises(ValueError):
            service.analyze_batch(FakeTagger(), [{"id": str(i), "text": "먹었다"} for i in range(501)], {})


if __name__ == "__main__":
    unittest.main()
