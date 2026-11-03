"""Issue #2321: candidate-scoped Stage 2 review-fix context and shared prompt policy."""
import unittest

from warroom import prompts, stage2


class ReviewPairSelection(unittest.TestCase):
    def setUp(self):
        self.items = [
            {"record_id": "w1", "sense_id": "w1-s1", "candidates": [
                {"text": "쉼표, 포함 후보"}, {"text": "같은 표현"}, {"text": "수정할 후보"}]},
            {"record_id": "w2", "sense_id": "w2-s1", "candidates": [{"text": "같은 표현"}]},
            {"record_id": "w3", "sense_id": "w3-s1", "candidates": [{"text": "다른 후보"}]},
        ]

    def test_supported_backtick_and_list_forms_preserve_candidate_commas_and_exact_senses(self):
        text = "\n".join([
            "- (`w1`, `w1-s1`, `쉼표, 포함 후보`)",
            "1. `w2, w2-s1, 같은 표현`",
            "`w1`, `w1-s1`, `같은 표현`",
            "- (`w2`, `w2-s1`, `같은 표현`)",  # duplicate tuple is removed
            "w1, w1-s1, 수정할 후보; w3, w3-s1, 다른 후보",
        ])
        result = stage2.review_pairs(text, self.items)
        pairs = [(row["record_id"], row["source_sense_id"], row["candidate"]) for row in result["pairs"]]
        self.assertCountEqual(pairs, [
            ("w1", "w1-s1", "쉼표, 포함 후보"),
            ("w2", "w2-s1", "같은 표현"),
            ("w1", "w1-s1", "같은 표현"),
            ("w1", "w1-s1", "수정할 후보"),
            ("w3", "w3-s1", "다른 후보"),
        ])
        self.assertEqual(len(pairs), 5, "duplicate structured tuples are removed")
        self.assertEqual(result["fallback_sense_ids"], [])

    def test_mismatches_are_reported_and_only_unidentified_target_senses_fall_back(self):
        result = stage2.review_pairs("`wrong-record`, `w1-s1`, `쉼표, 포함 후보`", self.items)
        self.assertEqual(result["pairs"], [])
        self.assertEqual(result["fallback_sense_ids"], ["w1-s1"])
        self.assertEqual(result["unmatched_pairs"], [{
            "record_id": "wrong-record", "source_sense_id": "w1-s1", "candidate": "쉼표, 포함 후보",
        }])

        result = stage2.review_pairs("- w1, w1-s1, 오타 후보", self.items)
        self.assertEqual(result["fallback_sense_ids"], ["w1-s1"])
        result = stage2.review_pairs("- w1, w999-s1, 오타 후보", self.items)
        self.assertEqual(result["fallback_sense_ids"], [])

    def test_each_event_keeps_its_own_pairs_and_prose_mentions_select_full_senses(self):
        events = [
            "`w1`, `w1-s1`, `쉼표, 포함 후보`",
            "Compare w2-s1 with peer target w3-s1. Prior review statistics mention w1-s1.",
        ]
        result = stage2.review_events(events, self.items)
        self.assertEqual(result["pairs"], [])
        self.assertEqual(result["fallback_sense_ids"], ["w1-s1", "w2-s1", "w3-s1"])

    def test_mixed_tuple_and_prose_in_one_event_keeps_all_required_context(self):
        result = stage2.review_pairs(
            "`w1`, `w1-s1`, `쉼표, 포함 후보`; w2-s1 is also affected.", self.items)
        self.assertEqual(result["pairs"], [{
            "record_id": "w1", "source_sense_id": "w1-s1", "candidate": "쉼표, 포함 후보",
        }])
        self.assertEqual(result["fallback_sense_ids"], ["w2-s1"])

    def test_plain_list_tuple_masks_only_tuple_before_same_line_prose(self):
        for separator in (". ", "; ", " — "):
            with self.subTest(separator=separator):
                result = stage2.review_pairs(
                    f"- w1, w1-s1, 수정할 후보{separator}w2-s1도 비교 대상입니다.", self.items)
                self.assertEqual(result["pairs"], [{
                    "record_id": "w1", "source_sense_id": "w1-s1", "candidate": "수정할 후보",
                }])
                self.assertEqual(result["fallback_sense_ids"], ["w2-s1"])

    def test_candidate_quote_does_not_narrow_a_prose_mentioned_sense(self):
        result = stage2.review_pairs(
            "`w1`, `w1-s1`, `같은 표현` was approved, but `자동차` is only a peer; "
            "w1-s1's Drop of 활동사진 is the finding.", self.items)
        self.assertEqual(result["pairs"], [])
        self.assertEqual(result["fallback_sense_ids"], ["w1-s1"])

    def test_same_candidate_text_stays_bound_to_the_tuple_sense(self):
        result = stage2.review_events([
            "`w1`, `w1-s1`, `같은 표현`",
            "The other source w2-s1 is mentioned in prose.",
        ], self.items)
        self.assertEqual(result["pairs"], [{
            "record_id": "w1", "source_sense_id": "w1-s1", "candidate": "같은 표현",
        }])
        self.assertEqual(result["fallback_sense_ids"], ["w2-s1"])

    def test_part_peer_is_full_and_outside_target_is_diagnostic_only(self):
        result = stage2.review_pairs("Compare w2-s1 with target w999-s1.", self.items)
        self.assertEqual(result["fallback_sense_ids"], ["w2-s1"])
        self.assertEqual(result["mentioned_sense_ids"], ["w2-s1", "w999-s1"])

    def test_overlapping_duplicate_and_adjacent_tuple_spans_leave_neighboring_senses_visible(self):
        text = ("(`w1`, `w1-s1`, `같은 표현`) and `w1, w1-s1, 같은 표현`\n"
                "w2-s1 immediately follows; w3-s1 remains after it.")
        tuples = stage2._review_triplets(text)
        masked = stage2._mask_spans(text, [(start, end) for _, _, _, start, end in tuples])
        self.assertEqual(len(masked), len(text))
        self.assertEqual(masked.count("\n"), text.count("\n"))
        self.assertIn("w2-s1 immediately follows", masked)
        self.assertIn("w3-s1 remains", masked)
        result = stage2.review_pairs(text, self.items)
        self.assertEqual(len(result["pairs"]), 1, "duplicate tuple values are removed")
        self.assertEqual(result["fallback_sense_ids"], ["w2-s1", "w3-s1"])

    def test_sense_id_free_prose_cannot_be_bound_by_the_parser(self):
        result = stage2.review_pairs("Please also fix this Sense's activities photo.", self.items)
        self.assertEqual(result["pairs"], [])
        self.assertEqual(result["fallback_sense_ids"], [])
        self.assertIn("without a Sense ID", stage2.review_events.__doc__)

    def test_sense_ids_followed_by_korean_text_are_still_found(self):
        result = stage2.review_pairs("w1-s1의 후보와 w2-s1은 비교 대상입니다.", self.items)
        self.assertEqual(result["fallback_sense_ids"], ["w1-s1", "w2-s1"])
        self.assertEqual(result["mentioned_sense_ids"], ["w1-s1", "w2-s1"])

class SharedStage2PolicyCard(unittest.TestCase):
    def test_chunk_and_fix_share_rendered_policy_and_preserve_fix_boundaries(self):
        batch = {"method": "s2", "shard": "001", "batch": "01-01", "branch": "codex/issue-2321",
                 "pr_number": 2321, "head_sha": "a" * 40}
        checkpoint = {"type_tier_policy": "source-mirror-v1", "pending_chunk": "001-01-01-001",
                      "next_chunk_number": 1, "decided": 0, "total": 1}
        policy = prompts._stage2_policy_card(checkpoint)
        chunk = prompts.stage2(batch, "chunk", checkpoint, view="# decision: c<n> R <type> <tier>\n")
        fix = prompts.fix(batch, [{"kind": "review", "author": "reviewer", "key": "review:1",
                                  "body": "Inspect w1-s1."}], False,
                         source_context="inspect w1-s1 @digest\nS\tw1-s1\tlemma\tnoun\tgloss", checkpoint=checkpoint)
        self.assertIn(policy, chunk)
        self.assertIn(policy, fix)
        self.assertIn("judge type/relevance once from the source sense", fix)
        self.assertNotIn("docs/relation-factory.md", fix)
        self.assertNotIn("docs/relation-editorial-policy.md", fix)
        self.assertIn("Do not reread docs or scripts", fix)
        for phrase in ("verify --shard 001 --batch 01 --part 01 --json", "600000 ms", "foreground",
                       "GH_CONFIG_DIR", "gh` CLI", "do not use GitHub MCP"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, fix)
        self.assertNotIn("{{", chunk + fix)


if __name__ == "__main__":
    unittest.main()
