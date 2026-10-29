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

    def test_pr_2347_review_excerpts_select_the_complete_part_sense_sets(self):
        expected = {
            "w523977-s1", "w524392-s1", "w520343-s1", "w525757-s1",
            "w531793-s1", "w532241-s1", "w532527-s1", "w533719-s1",
        }
        items = [{"record_id": sense.split("-s")[0], "sense_id": sense, "candidates": []}
                 for sense in sorted(expected)]
        events = [
            "w524392-s1 초로(와) 같다의 연기 Drop은 유지하기 어렵습니다. "
            "w523977-s1 제 살 궁리는 다 한다의 눈치 Drop도 과도합니다. "
            "Canonical 연기 w236213-s1은 사라지는 이미지로 연결됩니다.",
            "w525757-s1의 자동차와 활동사진 Drop, w520343-s1의 당당하게·의기양양·당당·거드름·으스대다 Drop, "
            "w531793-s1의 봇물, w532241-s1의 짹짹, w532527-s1의 초야·겸손, w533719-s1의 기계공업을 지적합니다. "
            "다른 target w50571-s2는 Part 밖입니다.",
        ]
        result = stage2.review_events(events, items)
        self.assertEqual(set(result["fallback_sense_ids"]), expected)
        self.assertEqual(set(result["mentioned_sense_ids"]) - expected,
                         {"w236213-s1", "w50571-s2"})
        self.assertEqual(result["pairs"], [])

    def test_pr_2306_tuple_only_excerpt_preserves_pair_selection_until_prose_names_its_sense(self):
        items = [
            {"record_id": "w429287", "sense_id": "w429287-s1", "candidates": [{"text": "통실하다"}]},
            {"record_id": "w413140", "sense_id": "w413140-s2", "candidates": [{"text": "질문"}, {"text": "답변"}]},
        ]
        excerpt = ("1. (w429287, w429287-s1, 통실하다) — '보리퉁하다'에서 풍만함을 나타내는 '통실하다'는 near 연관입니다.\n"
                   "2. (w413140, w413140-s2, 질문), (w413140, w413140-s2, 답변) — 직접적인 수식 문맥입니다.")
        pure = stage2.review_pairs(excerpt, items)
        self.assertCountEqual(
            [(pair["record_id"], pair["source_sense_id"], pair["candidate"]) for pair in pure["pairs"]],
            [("w429287", "w429287-s1", "통실하다"),
             ("w413140", "w413140-s2", "질문"), ("w413140", "w413140-s2", "답변")])
        self.assertEqual(pure["fallback_sense_ids"], [])
        expanded = stage2.review_pairs(excerpt + " The same source w413140-s2 also has a prose finding.", items)
        self.assertEqual([(pair["record_id"], pair["candidate"]) for pair in expanded["pairs"]],
                         [("w429287", "통실하다")])
        self.assertEqual(expanded["fallback_sense_ids"], ["w413140-s2"])


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
