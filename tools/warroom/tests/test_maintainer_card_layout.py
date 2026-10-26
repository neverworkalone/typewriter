"""Maintainer card layout matches Stage 2: title / identity / blank / PR + elapsed (fixed 4 lines).

Invariant: an Issue-backed card never wraps its status into the identity line; the last line is PR (or the hold
wording) on the left and the recorded elapsed time on the right.
"""
import unittest

from warroom import views


def card(**kw):
    base = {"state": "WORKING", "text": "x", "issue": "urgent issue #1890", "pr": "PR 생성 전", "detail": "", "elapsed": 40}
    return {**base, **kw}


class MaintainerCardLayout(unittest.TestCase):
    def lines(self, c):
        out = views.maintainer_card_text(c).split("\n")
        self.assertEqual(len(out), views.CARD_LINES)
        return out

    def test_table(self):
        for name, c, third_blank, bottom_l, bottom_r in [
            ("before PR", card(), True, "PR 생성 전", "경과 40초"),
            ("with PR", card(pr="PR #12"), True, "PR #12", "경과 40초"),
            ("no elapsed", card(elapsed=None), True, "PR 생성 전", ""),
            ("hold wording", card(pr="", detail="보류: 사유"), True, "보류: 사유", "경과 40초"),
            ("error", card(state="ERROR", pr="", detail="PR #3 · Maintainer ERROR"), True, "PR #3", ""),
        ]:
            with self.subTest(name):
                ls = self.lines(c)
                self.assertTrue(ls[0].startswith("Maintainer"))
                self.assertEqual(ls[1].strip(), "urgent issue #1890")
                self.assertEqual(ls[2].strip(), "")
                self.assertIn(bottom_l, ls[3])
                self.assertIn(bottom_r, ls[3])

    def test_without_issue_keeps_plain_wrap_and_idle_is_neutral(self):
        ls = self.lines({"state": "WORKING", "text": "urgent · 공통 결함 `x` · Issue 등록 대기"})
        self.assertIn("공통 결함", ls[1])
        idle = self.lines({"state": "IDLE", "text": ""})
        self.assertIn("진행 중인 작업 없음", idle[1])


if __name__ == "__main__":
    unittest.main()
