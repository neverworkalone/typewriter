import unittest

from warroom import stage2


class RepairPageSizeTest(unittest.TestCase):
    def test_large_groups_are_cut_to_char_budget(self):
        groups = [{"blob": "가" * 160_000} for _ in range(8)]
        page = stage2.repair_page(groups, 0)
        self.assertEqual(len(page), 3)
        self.assertLess(sum(len(g["blob"]) for g in page), 1_048_576 // 2 + 1)

    def test_oversized_single_group_still_progresses(self):
        groups = [{"blob": "x" * 700_000}, {"blob": "y"}]
        self.assertEqual(len(stage2.repair_page(groups, 0)), 1)
        self.assertEqual(len(stage2.repair_page(groups, 1)), 1)

    def test_small_groups_keep_fixed_page(self):
        groups = [{"n": i} for i in range(20)]
        self.assertEqual(len(stage2.repair_page(groups, 0)), stage2.REPAIR_GROUPS_PER_RUN)
        self.assertEqual(len(stage2.repair_page(groups, 16)), 4)


if __name__ == "__main__":
    unittest.main()
