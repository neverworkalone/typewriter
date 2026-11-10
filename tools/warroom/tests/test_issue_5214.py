"""#5214: a non-verb exact `action` target is repaired deterministically instead of exhausting the single correction."""
from __future__ import annotations

import unittest

from warroom import stage2

DIAG = (
    "chunk 028-02-02-t04 not saved, checkpoint unchanged: 2 problem(s)\n"
    "c33 줄타기: action target w483613/w483613-s1 has pos noun; expected verb or expression  ->  "
    "c33 R <type> <tier> T<k> (T<k> one of T124,T125,T126) | c33 R <type> <tier> none T124,T125,T126 | c33 D x|e\n"
    "c79 봉사: action target w149358/w149358-s1 has pos noun; expected verb or expression  ->  "
    "c79 R <type> <tier> T<k> (T<k> one of T342,T343) | c79 R <type> <tier> none T342,T343 | c79 D x|e"
)


class ActionTargetTextOnly(unittest.TestCase):
    def test_rewrites_only_named_exact_action_rows_keeping_type_and_tier(self):
        rows = ["c1 D e", "c33 R action 5 T124", "c79 R action 3 T343", "c80 R action 4 T9", "c81 R near 2 T5"]
        out, changed = stage2.action_target_text_only_rows(rows, DIAG)
        self.assertEqual(changed, ["c33", "c79"])
        self.assertEqual(out, ["c1 D e", "c33 R action 5 none T124,T125,T126", "c79 R action 3 none T342,T343",
                               "c80 R action 4 T9", "c81 R near 2 T5"])

    def test_other_diagnostics_and_foreign_targets_are_untouched(self):
        rows = ["c33 R action 5 T999", "c34 R mood 4 T1"]
        self.assertEqual(stage2.action_target_text_only_rows(rows, DIAG), (rows, []))
        self.assertEqual(stage2.action_target_text_only_rows(rows, "c34 x: relevance must be 1..9"), (rows, []))

    def test_rewritten_rows_stay_valid_decision_rows(self):
        out, _ = stage2.action_target_text_only_rows(["c33 R action 5 T124"], DIAG)
        self.assertRegex(out[0], stage2._HEADERLESS_FIX_ROW)


if __name__ == "__main__":
    unittest.main()
