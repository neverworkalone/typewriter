/**
 * Owner-selectable Lite storage optimizations (Issue #4761). Research build options, not extension user settings.
 *
 * They apply only to the Lite extraction and package (`pnpm run build`); the Full database from
 * `pnpm run build:dictionary` keeps its format. Each flag is independent, so all four combinations are valid:
 *
 *   idCompression:   Typewriter-authored ID relations are stored as one compressed adjacency BLOB per source Meaning
 *                    (`packed_meaning_relations`) instead of `meaning_relations` rows.
 *   textCompression: Text-only relations are stored as a deduplicated `text_pool` plus one compressed adjacency BLOB per
 *                    source Meaning (`packed_text_relations`) instead of `meaning_text_relations` rows.
 *
 * The chosen state is written to the Lite `metadata` and enforced by the runtime; see docs/lite-packed-relations-issue-4761.md
 * for how to build and keep each variant separately.
 */
export const LITE_OPTIMIZATION = {
  idCompression: true,
  textCompression: true,
};
