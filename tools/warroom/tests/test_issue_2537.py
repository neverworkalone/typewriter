"""Issue #2537: parse packed Stage 3 Link Repair proposals deterministically."""
import unittest

from warroom import stage3


def context():
    view = {
        "chunk": "007",
        "relation_count": 5,
        "senses": [{"relations": [
            {"n": 50, "target": "already linked"},
            {"n": 66, "text": "two candidates", "targets": [
                {"alias": "T1", "record_id": "w1", "sense_id": "w1-s1"},
                {"alias": "T2", "record_id": "w2", "sense_id": "w2-s2"},
            ]},
            {"n": 84, "text": "third candidate", "targets": [
                {"alias": "T3", "record_id": "w3", "sense_id": "w3-s3"},
            ]},
            {"n": 90, "text": "one candidate", "targets": [
                {"alias": "T1", "record_id": "w4", "sense_id": "w4-s4"},
            ]},
            {"n": 91, "text": "drop candidate", "targets": []},
        ]}],
    }
    return stage3.decision_context(view, "007")


class Stage3PackedLinkRepair(unittest.TestCase):
    def setUp(self):
        self.context = context()

    def test_packed_and_expanded_repairs_normalize_to_one_link_per_line(self):
        packed, packed_warnings = stage3.normalize_decisions(
            "chunk 007\nL 66 T2 84 T3 90 T1\nD 91\n", "007", self.context)
        expanded, expanded_warnings = stage3.normalize_decisions(
            "chunk 007\nL 66 T2\nL 84 T3\nL 90 T1\nD 91\n", "007", self.context)

        expected = "chunk 007\nL 66 T2\nL 84 T3\nL 90 T1\nD 91\n"
        self.assertEqual(packed, expected)
        self.assertEqual(expanded, expected)
        self.assertEqual(packed_warnings, [])
        self.assertEqual(expanded_warnings, [])

    def test_invalid_packed_pairs_are_discarded_per_relation(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 007\nL 50 T1 66 T99 777 T1 84 T3\n", "007", self.context)

        self.assertEqual(text, "chunk 007\nL 84 T3\n")
        self.assertEqual(len(warnings), 3)
        self.assertTrue(any("Relation 50" in warning and "ID-linked" in warning for warning in warnings))
        self.assertTrue(any("Relation 66" in warning and "T99" in warning for warning in warnings))
        self.assertTrue(any("Relation 777" in warning for warning in warnings))

    def test_repeated_and_conflicting_rows_discard_all_actions_for_each_row(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 007\nL 66 T1 66 T2\nD 84\nL 84 T3\nL 90 T1\n", "007", self.context)

        self.assertEqual(text, "chunk 007\nL 90 T1\n")
        self.assertEqual(len(warnings), 2)
        self.assertTrue(any("Relation 66" in warning and "중복" in warning for warning in warnings))
        self.assertTrue(any("Relation 84" in warning and "중복" in warning for warning in warnings))

    def test_incomplete_junk_and_mixed_action_lines_fail_closed(self):
        for malformed in (
            "L 66 T1 84",
            "L 66 T1 84 T3 junk",
            "L 66 T1 D 84",
        ):
            with self.subTest(malformed=malformed):
                text, warnings = stage3.normalize_decisions(
                    f"chunk 007\n{malformed}\nD 91\n", "007", self.context)
                self.assertEqual(text, "chunk 007\nD 91\n")
                self.assertEqual(len(warnings), 1)
                self.assertIn("잘못된 제안 줄만 폐기", warnings[0])

