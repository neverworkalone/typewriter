// Per-output limit for every Git subprocess that reads whole committed files or canonical patches. Production
// authority files (semantic decision source, inventories, relation packets) grow with each relation backfill batch,
// so this is deliberately far above the current largest blob; exceeding it still fails closed.
export const GIT_MAX_BUFFER = 512 * 1024 * 1024;
