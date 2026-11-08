// Lite-only compressed adjacency lists (Issue #4761). Shared by the build (encode, verify) and the extension runtime (decode).
//
// One BLOB per source Meaning:   [version byte] then one record per relation, ordered by position.
//   ID record:   varint(position gap)  varint(target Meaning number)  byte(type << 5 | relevance << 1 | reverse)
//   Text record: varint(position gap)  varint(text pool id)           byte(type << 4 | relevance)
// `position gap` is position - (previous position + 1), so positions are strictly increasing by construction.
// A Meaning ID is `m` + an integer zero-padded to at least 3 digits; the integer is the packed number.

export const PACKED_FORMAT_VERSION = 1;
export const PACKED_TYPES = Object.freeze(['direct', 'near', 'antonym', 'mood', 'scene', 'sensory', 'action', 'association']);
export const PACKED_ORIGINS = Object.freeze(['typewriter-authored', 'typewriter-authored-reverse']);
/** Authored ID relations are exploratory, never `direct`/`antonym` (same rule as the `authored_relation_invalid` query). */
const AUTHORED_TYPES = new Set(PACKED_TYPES.filter((type) => type !== 'direct' && type !== 'antonym'));
const MAX_VARINT_BYTES = 8;

/** Integer behind a canonical Meaning ID; throws unless `meaningId(number) === id` (no silent truncation or collision). */
export function meaningNumber(id) {
  const match = /^m(\d+)$/u.exec(id);
  const number = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 1 || meaningId(number) !== id) {
    throw new Error(`Meaning ID ${JSON.stringify(id)} is not in canonical m<integer> form`);
  }
  return number;
}

export function meaningId(number) {
  return `m${String(number).padStart(3, '0')}`;
}

function writeVarint(bytes, value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid packed relation integer');
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value ? 128 : 0));
  } while (value);
}

function checkRelevance(relevance) {
  if (!Number.isInteger(relevance) || relevance < 1 || relevance > 9) throw new Error('Invalid packed relation relevance');
}

function pack(rows, writeRow) {
  if (rows.length === 0) throw new Error('A packed relation list must not be empty');
  const bytes = [PACKED_FORMAT_VERSION];
  let next = 0;
  for (const row of rows) {
    if (!Number.isInteger(row.position) || row.position < next) throw new Error('Packed relation positions must be strictly increasing');
    writeVarint(bytes, row.position - next);
    writeRow(bytes, row);
    next = row.position + 1;
  }
  return Uint8Array.from(bytes);
}

/** Rows: `{ position, target (Meaning number), type, relevance, origin, note }`, ascending `position`. */
export function encodePackedRelations(rows) {
  return pack(rows, (bytes, row) => {
    const type = PACKED_TYPES.indexOf(row.type);
    const origin = PACKED_ORIGINS.indexOf(row.origin);
    if (type < 0 || !AUTHORED_TYPES.has(row.type) || origin < 0) throw new Error('Invalid authored relation type or origin for packing');
    if (row.note !== '') throw new Error('Authored relations with a non-empty note cannot be packed');
    if (!Number.isSafeInteger(row.target) || row.target < 1) throw new Error('Invalid packed relation target');
    checkRelevance(row.relevance);
    writeVarint(bytes, row.target);
    bytes.push((type << 5) | (row.relevance << 1) | origin);
  });
}

/** Rows: `{ position, text (pool id), type, relevance }`, ascending `position`. */
export function encodePackedTextRelations(rows) {
  return pack(rows, (bytes, row) => {
    const type = PACKED_TYPES.indexOf(row.type);
    if (type < 0 || !AUTHORED_TYPES.has(row.type)) throw new Error('Invalid text relation type for packing');
    if (!Number.isSafeInteger(row.text) || row.text < 1) throw new Error('Invalid packed text pool id');
    checkRelevance(row.relevance);
    writeVarint(bytes, row.text);
    bytes.push((type << 4) | row.relevance);
  });
}

function unpack(data, readRow) {
  if (!data || data.length < 2) throw new Error('Truncated packed relation');
  if (data[0] !== PACKED_FORMAT_VERSION) throw new Error(`Unsupported packed relation version ${data[0]}`);
  const rows = [];
  let offset = 1;
  let next = 0;
  const reader = {
    varint() {
      let value = 0;
      let factor = 1;
      for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
        if (offset >= data.length) throw new Error('Truncated packed relation');
        const byte = data[offset++];
        value += (byte & 127) * factor;
        if (!Number.isSafeInteger(value)) throw new Error('Invalid packed relation integer');
        if (!(byte & 128)) return value;
        factor *= 128;
      }
      throw new Error('Invalid packed relation integer');
    },
    byte() {
      if (offset >= data.length) throw new Error('Truncated packed relation');
      return data[offset++];
    },
  };
  while (offset < data.length) {
    const position = next + reader.varint();
    rows.push(readRow(reader, position));
    next = position + 1;
  }
  return rows;
}

export function decodePackedRelations(data) {
  return unpack(data, (reader, position) => {
    const target = reader.varint();
    const flags = reader.byte();
    const type = PACKED_TYPES[flags >> 5];
    const relevance = (flags >> 1) & 15;
    if (target < 1 || !type || !AUTHORED_TYPES.has(type) || relevance < 1 || relevance > 9) throw new Error('Invalid packed relation');
    return { position, target, type, relevance, origin: PACKED_ORIGINS[flags & 1], note: '' };
  });
}

export function decodePackedTextRelations(data) {
  return unpack(data, (reader, position) => {
    const text = reader.varint();
    const flags = reader.byte();
    const type = PACKED_TYPES[flags >> 4];
    const relevance = flags & 15;
    if (flags >> 7 || text < 1 || !type || !AUTHORED_TYPES.has(type) || relevance < 1 || relevance > 9) throw new Error('Invalid packed text relation');
    return { position, text, type, relevance };
  });
}
