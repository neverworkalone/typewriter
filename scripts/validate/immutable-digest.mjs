// Digest memoization that is sound by construction.
//
// Shared validation hashes the same complete-canonical values (records, semantic
// audit) once per historical batch. A digest may be reused only if the hashed
// content cannot have changed, so only values that were deeply frozen through
// `deepFreezeJson` are memoized: a frozen JSON graph is immutable, hence its
// digest is a pure function of its identity. A freshly built array of such
// frozen values is keyed by the identity sequence of its elements, which fixes
// its serialization exactly. Any other value is always hashed from scratch.

const verifiedImmutable = new WeakSet();
const objectDigests = new WeakMap();
const identities = new WeakMap();
const sequenceDigests = new Map();
let nextIdentity = 1;

function isPlainJsonContainer(value) {
  if (Array.isArray(value)) return true;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep-freeze a JSON-shaped graph and register it as immutable. Returns false
 * (without registering anything above the offending node) when the graph holds a
 * non-JSON container, in which case it keeps being hashed from scratch.
 */
export function deepFreezeJson(value) {
  if (value === null || typeof value !== 'object') return true;
  if (verifiedImmutable.has(value)) return true;
  if (!isPlainJsonContainer(value)) return false;
  let allImmutable = true;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (!deepFreezeJson(child)) allImmutable = false;
  }
  Object.freeze(value);
  if (allImmutable) verifiedImmutable.add(value);
  return allImmutable;
}

function identityOf(value) {
  let identity = identities.get(value);
  if (identity === undefined) {
    identity = nextIdentity;
    nextIdentity += 1;
    identities.set(value, identity);
  }
  return identity;
}

export function isVerifiedImmutable(value) {
  return value !== null && typeof value === 'object' && verifiedImmutable.has(value);
}

/**
 * Return `compute()` for `value`, reusing an earlier result only when `value` is
 * a verified-immutable object or an array made only of verified-immutable
 * objects. `namespace` separates digests of different serializations.
 */
export function memoizedDigest(namespace, value, compute) {
  if (value === null || typeof value !== 'object') return compute();
  if (verifiedImmutable.has(value)) {
    let perNamespace = objectDigests.get(value);
    const cached = perNamespace?.get(namespace);
    if (cached !== undefined) return cached;
    const digest = compute();
    if (!perNamespace) {
      perNamespace = new Map();
      objectDigests.set(value, perNamespace);
    }
    perNamespace.set(namespace, digest);
    return digest;
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isVerifiedImmutable)) {
    const key = `${namespace}:${value.map(identityOf).join(',')}`;
    const cached = sequenceDigests.get(key);
    if (cached !== undefined) return cached;
    const digest = compute();
    sequenceDigests.set(key, digest);
    return digest;
  }
  return compute();
}

/**
 * Evidence that complete-revision work was reused instead of repeated: counts per
 * named check of how often its result was computed versus reused, kept on the
 * owner (the shared audit cache or the shared canonical context).
 */
export function recordCompleteRevisionCheck(owner, name, kind) {
  owner.completeRevisionStats ??= {};
  owner.completeRevisionStats[name] ??= { computed: 0, reused: 0 };
  owner.completeRevisionStats[name][kind] += 1;
}
