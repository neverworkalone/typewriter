/**
 * Stage 3 refinement rule (#2450, #2455): an editorial audit that may only Drop a whole approved Relation row or turn
 * a text-only row into an exact same-spelling Canonical ID Relation (Link Repair). Everything else — chunking,
 * checkpoint, orphan `z` accounting, validation and atomic writes — is the shared Refinement Engine core.
 */
import { createReverseCandidateFormLookup, sameSpellingTargets } from '../../admission.mjs';
import { parseRelationJsonl, serializeRelationJsonl } from '../../persisted-jsonl.mjs';
import { fail, idSensePairKey } from '../core.mjs';

export const label = 'Stage 3';
export const scratch = 'relation-edit';
export const scopedName = 'scoped Stage 3 Link Repair';
/** A scoped (Stage 2 Part) Stage 3 run reviews only text-only rows for Link Repair. */
export const scopedRow = (row) => 'text' in row;

export const usage = `Usage:
  node scripts/relation/edit-cli.mjs prepare --shard SSS
  node scripts/relation/edit-cli.mjs prepare --shard SSS --batch BB --part PP  # scoped text-only Link Repair
  node scripts/relation/edit-cli.mjs read-chunk --shard SSS [--out <file>]
  node scripts/relation/edit-cli.mjs read-chunk --shard SSS --batch BB --part PP
  node scripts/relation/edit-cli.mjs read-chunk --shard SSS --chunk NNN  # explicit chunk (parallel Supervisor)
  node scripts/relation/edit-cli.mjs refresh-pending --shard SSS
  node scripts/relation/edit-cli.mjs save-chunk --shard SSS --in <decisions.txt>
  node scripts/relation/edit-cli.mjs save-chunk --shard SSS --batch BB --part PP --in <decisions.txt>
  node scripts/relation/edit-cli.mjs save-chunk --shard SSS --chunk NNN --in <decisions.txt> --expect-view-sha256 <hash>
  node scripts/relation/edit-cli.mjs apply --shard SSS
  node scripts/relation/edit-cli.mjs apply --shard SSS --batch BB --part PP
  node scripts/relation/edit-cli.mjs report --shard SSS [--out <file>]
  node scripts/relation/edit-cli.mjs decisions --shard SSS --base <sha> [--out <file>]  # a PR's decisions from its diff
  node scripts/relation/edit-cli.mjs amend --shard SSS --base <sha> --in <delta.txt>  # rebuild the PR from its base`;

function targetAliases(text, index) {
  let number = 0;
  return sameSpellingTargets(index, text).flatMap((record) => record.senses.map((sense) => ({
    alias: `T${++number}`,
    record_id: record.record_id,
    lemma: record.lemma,
    sense_id: sense.sense_id,
    pos: sense.pos,
    gloss: sense.gloss,
  })));
}

function targetMeaningSet(targets) {
  return targets.map(({ record_id, lemma, sense_id, pos, gloss }) => ({ record_id, lemma, sense_id, pos, gloss }))
    .sort((left, right) => left.record_id.localeCompare(right.record_id) || left.sense_id.localeCompare(right.sense_id));
}

export function renderChunk(groups, index, number, total) {
  let relationNumber = 0;
  const senses = groups.map(({ record, sense, relations }) => ({
    source: { lemma: record.lemma, pos: sense.pos, gloss: sense.gloss },
    relations: relations.map(({ rowIndex, row }) => {
      const n = ++relationNumber;
      if ('text' in row) return { n, text: row.text, type: row.type, tier: row.relevance,
        targets: targetAliases(row.text, index), _row: rowIndex,
        _source_record_id: record.id, _source_sense_id: sense.id };
      const targetRecord = index.byId.get(row.target_record_id);
      const targetSense = index.senses.get(row.target_sense_id)?.sense;
      // Every ID target shows its POS and full gloss (#5745): a single-Sense, unique-spelling target can still be a
      // proper noun whose lemma alone reads like ordinary vocabulary (e.g. 인성론, a book title).
      return {
        n,
        target: targetRecord.lemma,
        target_record_id: row.target_record_id,
        target_sense_id: row.target_sense_id,
        target_pos: targetSense.pos,
        target_gloss: targetSense.gloss,
        type: row.type,
        tier: row.relevance,
        _row: rowIndex,
        _source_record_id: record.id,
        _source_sense_id: sense.id,
      };
    }),
  }));
  return { chunk: String(number).padStart(3, '0'), total_chunks: total,
    relation_count: relationNumber, senses };
}

const FIELD_ESCAPES = { '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' };
const FIELD_UNESCAPES = { '\\': '\\', t: '\t', n: '\n', r: '\r' };

export function escapeField(value) {
  if (typeof value !== 'string') fail('Stage 3 prompt view fields must be strings');
  return value.replace(/[\\\t\n\r]/gu, (character) => FIELD_ESCAPES[character]);
}

function unescapeField(value) {
  return value.replace(/\\(.?)/gsu, (_match, character) => {
    if (!(character in FIELD_UNESCAPES)) fail(`Stage 3 prompt view has an invalid escape: \\${character}`);
    return FIELD_UNESCAPES[character];
  });
}

/** Compact tab-separated model input; carries exactly the judgment facts of the stripped view (no record/sense IDs). */
export function renderPromptView(chunk) {
  const total = String(chunk.total_chunks).padStart(3, '0');
  const lines = [`chunk ${chunk.chunk}/${total} relations ${chunk.relation_count}`];
  const row = (...fields) => lines.push(fields.map(escapeField).join('\t'));
  for (const { source, relations } of chunk.senses) {
    row('S', source.lemma, source.pos, source.gloss);
    for (const relation of relations) {
      if ('text' in relation) {
        row(`X${relation.n}`, relation.text, relation.type, String(relation.tier));
        for (const target of relation.targets) row(target.alias, target.lemma, target.pos, target.gloss);
      } else {
        row(`I${relation.n}`, relation.target, relation.type, String(relation.tier),
          ...('target_pos' in relation ? [relation.target_pos, relation.target_gloss] : []));
      }
    }
  }
  return lines.join('\n');
}

/** Inverse of renderPromptView, returning the judgment fields of the stripped view (ID fields are not in the text). */
export function parsePromptView(text) {
  if (typeof text !== 'string') fail('Stage 3 prompt view must be text');
  const [header, ...body] = text.split('\n');
  const match = /^chunk (\d+)\/(\d+) relations (\d+)$/u.exec(header);
  if (!match) fail('Stage 3 prompt view header is invalid');
  const view = { chunk: match[1], total_chunks: Number(match[2]), relation_count: Number(match[3]), senses: [] };
  let sense = null;
  let text_only = null;
  for (const line of body) {
    const fields = line.split('\t').map(unescapeField);
    const tag = /^(S|I|X|T)(\d*)$/u.exec(fields[0]);
    const number = Number(tag?.[2]);
    if (!tag || (tag[1] === 'S') !== (tag[2] === '') || (tag[2] !== '' && !(number >= 1))) {
      fail(`Stage 3 prompt view has an invalid row tag: ${fields[0]}`);
    }
    if (tag[1] === 'S') {
      if (fields.length !== 4) fail('Stage 3 prompt view Sense row must have 4 fields');
      sense = { source: { lemma: fields[1], pos: fields[2], gloss: fields[3] }, relations: [] };
      view.senses.push(sense);
      text_only = null;
    } else if (!sense) {
      fail('Stage 3 prompt view row precedes its Source Sense');
    } else if (tag[1] === 'T') {
      if (!text_only || fields.length !== 4) fail('Stage 3 prompt view target row is misplaced or malformed');
      text_only.targets.push({ alias: fields[0], lemma: fields[1], pos: fields[2], gloss: fields[3] });
    } else {
      const tier = Number(fields[3]);
      if (!Number.isInteger(tier) || String(tier) !== fields[3]) fail('Stage 3 prompt view tier is invalid');
      const relation = { n: number, type: fields[2], tier };
      if (tag[1] === 'X') {
        if (fields.length !== 4) fail('Stage 3 prompt view text row must have 4 fields');
        relation.text = fields[1];
        relation.targets = [];
        text_only = relation;
      } else {
        if (fields.length !== 4 && fields.length !== 6) fail('Stage 3 prompt view ID row must have 4 or 6 fields');
        relation.target = fields[1];
        if (fields.length === 6) Object.assign(relation, { target_pos: fields[4], target_gloss: fields[5] });
        text_only = null;
      }
      sense.relations.push(relation);
    }
  }
  return view;
}

/** Checkpoint shape of one saved decision (the core checks its chunk and row). */
export function assertDecisionShape(decision) {
  const keys = Object.keys(decision).sort().join(',');
  if (decision.action === 'drop') {
    if (keys !== 'action,chunk,row') fail('Stage 3 Drop decision must have only action, chunk, and row');
  } else if (decision.action === 'repair') {
    if (keys !== 'action,chunk,row,target_record_id,target_sense_id') fail('Stage 3 Link Repair decision must have exact target IDs');
    if (typeof decision.target_record_id !== 'string' || typeof decision.target_sense_id !== 'string') fail('Stage 3 Link Repair decision has invalid target IDs');
  } else fail('Stage 3 checkpoint has an unknown decision');
}

export function decisionIdentity(decision) {
  return [decision.row, decision.action, decision.target_record_id ?? null, decision.target_sense_id ?? null];
}

export function saveSummary(decisions, view) {
  return {
    dropped: decisions.filter((decision) => decision.action === 'drop').length,
    repaired: decisions.filter((decision) => decision.action === 'repair').length,
    kept: view.relation_count - decisions.length,
  };
}

export function parseDecisionText(text, view, checkpoint, { explicit = false } = {}) {
  if (typeof text !== 'string') fail('Stage 3 chunk decisions must be text');
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const match = /^chunk\s+(\d{3})$/u.exec(lines[0] ?? '');
  if (!match || match[1] !== view.chunk) fail(`decision input must begin with "chunk ${view.chunk}"`);
  if (!explicit && checkpoint.completed_chunks.includes(view.chunk)) fail(`Stage 3 chunk ${view.chunk} is already saved`);
  const relations = view.senses.flatMap((sense) => sense.relations);
  const byNumber = new Map(relations.map((relation) => [relation.n, relation]));
  if (lines[1] === 'none') {
    if (lines.length !== 2) fail('none must be the only decision after the chunk marker');
    return [];
  }
  if (lines.length < 2) fail('write none when every Relation in this chunk should be kept');
  const decisions = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const drop = /^D\s+(\d+(?:\s+\d+)*)$/u.exec(line);
    const repair = /^L\s+(\d+)\s+T(\d+)$/u.exec(line);
    if (drop) {
      if (checkpoint.scope) fail('scoped Stage 3 Link Repair does not allow Drops');
      for (const rawNumber of drop[1].split(/\s+/u)) {
        const number = Number(rawNumber);
        const relation = byNumber.get(number);
        if (!relation || seen.has(number)) fail(`D ${number}: Relation number is unknown or repeated`);
        seen.add(number);
        decisions.push({ chunk: view.chunk, row: relation._row, action: 'drop' });
      }
      continue;
    }
    if (repair) {
      const number = Number(repair[1]);
      const relation = byNumber.get(number);
      if (!relation || seen.has(number)) fail(`L ${number}: Relation number is unknown or repeated`);
      if (typeof relation.text !== 'string') fail(`L ${number}: Link Repair applies only to a text-only Relation`);
      const target = relation.targets.find((item) => item.alias === `T${Number(repair[2])}`);
      if (!target) fail(`L ${number}: target alias T${repair[2]} is not an exact Canonical target for ${JSON.stringify(relation.text)}`);
      seen.add(number);
      decisions.push({ chunk: view.chunk, row: relation._row, action: 'repair', target_record_id: target.record_id, target_sense_id: target.sense_id });
      continue;
    }
    fail(`invalid decision line ${JSON.stringify(line)}; use D <row...>, L <row> T<target>, or none`);
  }
  if (explicit && checkpoint.completed_chunks.includes(view.chunk)) return decisions;
  const rows = new Set(checkpoint.decisions.map((decision) => decision.row));
  for (const decision of decisions) if (rows.has(decision.row)) fail(`Relation row ${decision.row} already has a saved edit`);
  return decisions;
}

function preparedRowsByNumber(view, chunk) {
  if (!view || view.chunk !== chunk || !Array.isArray(view.senses)) fail(`prepared Stage 3 chunk ${chunk} does not match its checkpoint`);
  const rows = new Map();
  for (const sense of view.senses) {
    if (!Array.isArray(sense.relations)) fail(`prepared Stage 3 chunk ${chunk} has an invalid Sense group`);
    for (const relation of sense.relations) {
      if (!Number.isSafeInteger(relation._row) || relation._row < 1 || rows.has(relation._row)) {
        fail(`prepared Stage 3 chunk ${chunk} has an invalid Relation row reference`);
      }
      rows.set(relation._row, { source: sense.source, relation });
    }
  }
  return rows;
}

/** Saved decisions must still bind to the exact rows, Senses and same-spelling targets their chunk showed. */
export async function validatePreparedDecisions({ decisions, currentRelations, index, readView }) {
  const rowsByChunk = new Map();
  for (const decision of decisions) {
    if (!rowsByChunk.has(decision.chunk)) {
      let view;
      try { view = JSON.parse(await readView(decision.chunk)); }
      catch (error) { fail(`prepared Stage 3 chunk ${decision.chunk} is unavailable or invalid: ${error.message}`); }
      rowsByChunk.set(decision.chunk, preparedRowsByNumber(view, decision.chunk));
    }
    const preparedEntry = rowsByChunk.get(decision.chunk).get(decision.row);
    const prepared = preparedEntry?.relation;
    const current = currentRelations[decision.row - 1];
    const currentSource = prepared && index.senses.get(prepared._source_sense_id);
    const samePreparedSourceSense = currentSource
      && currentSource.record.id === prepared._source_record_id
      && currentSource.record.lemma === preparedEntry.source?.lemma
      && currentSource.sense.pos === preparedEntry.source?.pos
      && currentSource.sense.gloss === preparedEntry.source?.gloss;
    if (!samePreparedSourceSense) {
      fail(`saved Stage 3 decision for Relation row ${decision.row} source Sense changed after prepare; prepare and review the changed rows again`);
    }
    const samePreparedRelation = prepared && current
      && current.source_record_id === prepared._source_record_id
      && current.source_sense_id === prepared._source_sense_id
      && current.type === prepared.type && current.relevance === prepared.tier
      && (typeof prepared.text === 'string'
        ? 'text' in current && current.text === prepared.text
        : !('text' in current) && current.target_record_id === prepared.target_record_id
          && current.target_sense_id === prepared.target_sense_id);
    if (!samePreparedRelation) {
      fail(`saved Stage 3 decision for Relation row ${decision.row} no longer matches its prepared Relation input; prepare and review the changed rows again`);
    }
    if (decision.action === 'repair' && !prepared.targets?.some((target) =>
      target.record_id === decision.target_record_id && target.sense_id === decision.target_sense_id)) {
      fail(`saved Link Repair for Relation row ${decision.row} does not match an exact target shown in its prepared chunk`);
    }
    if (decision.action === 'repair'
        && JSON.stringify(targetMeaningSet(prepared.targets ?? []))
          !== JSON.stringify(targetMeaningSet(targetAliases(current.text, index)))) {
      fail(`saved Link Repair target meanings or same-spelling choices changed after prepare for Relation row ${decision.row}; prepare and review the changed targets again`);
    }
  }
}

/** A decision against its baseline row: scope, text-only Link Repair, and an exact same-spelling target. */
export function checkDecision({ decision, original, scope, scopedSenseIds, context }) {
  if (scope && (decision.action !== 'repair' || !scopedSenseIds.has(original.source_sense_id))) {
    fail(`scoped Stage 3 Link Repair decision is outside ${scope.batch}/${scope.part} or is not a Link Repair`);
  }
  if (decision.action === 'repair') {
    if (!('text' in original)) fail(`saved Link Repair row ${decision.row} is no longer text-only`);
    const targets = sameSpellingTargets(context.index, original.text).flatMap((record) => record.senses.map((sense) => ({
      record_id: record.record_id, sense_id: sense.sense_id,
    })));
    if (!targets.some((target) => target.record_id === decision.target_record_id && target.sense_id === decision.target_sense_id)) {
      fail(`saved Link Repair row ${decision.row} does not target an exact same-spelling Canonical sense`);
    }
  }
}

/** Rows after the decisions: Drops remove their rows; each Link Repair that duplicates no surviving ID pair is rebuilt. */
export function transform({ context, beforeRelations, relationLines, decisions }) {
  const decisionByRow = new Map(decisions.map((decision) => [decision.row, decision]));
  const dropRows = [];
  const droppedRows = new Set();
  beforeRelations.forEach((row, index) => {
    const decision = decisionByRow.get(index + 1);
    if (decision?.action === 'drop') {
      dropRows.push(row);
      droppedRows.add(index + 1);
    }
  });

  // Resolve only exact ID Sense-pair collisions. The baseline validator has already established that the
  // existing Relations are valid; Drops remove their rows from this candidate set before repair selection.
  const pairOrigins = new Map();
  for (const row of context.otherRelations) {
    if ('text' in row) continue;
    const key = idSensePairKey(row.source_sense_id, row.target_sense_id);
    if (!pairOrigins.has(key)) pairOrigins.set(key, {
      kind: 'other_shard_relation', source_sense_id: row.source_sense_id, target_sense_id: row.target_sense_id,
    });
  }
  beforeRelations.forEach((row, index) => {
    const rowNumber = index + 1;
    const decision = decisionByRow.get(rowNumber);
    if (droppedRows.has(rowNumber) || decision?.action === 'repair' || 'text' in row) return;
    const key = idSensePairKey(row.source_sense_id, row.target_sense_id);
    if (!pairOrigins.has(key)) pairOrigins.set(key, {
      kind: 'surviving_relation', relation_row: rowNumber,
      source_sense_id: row.source_sense_id, target_sense_id: row.target_sense_id,
    });
  });

  const repairConflicts = [];
  const acceptedRepairRows = new Set();
  beforeRelations.forEach((original, index) => {
    const rowNumber = index + 1;
    const decision = decisionByRow.get(rowNumber);
    if (decision?.action !== 'repair') return;
    const key = idSensePairKey(original.source_sense_id, decision.target_sense_id);
    const conflict = pairOrigins.get(key);
    if (conflict) {
      repairConflicts.push({ relation_row: rowNumber, source_sense_id: original.source_sense_id,
        target_sense_id: decision.target_sense_id, conflict });
      return;
    }
    acceptedRepairRows.add(rowNumber);
    pairOrigins.set(key, {
      kind: 'earlier_link_repair', relation_row: rowNumber,
      source_sense_id: original.source_sense_id, target_sense_id: decision.target_sense_id,
    });
  });

  // Kept text-only rows must participate in reverse-candidate availability and accounting just like every other
  // surviving original row. Otherwise an accepted reverse repair could silently claim their candidate spelling.
  const remainingOriginalRows = beforeRelations.filter((row, index) => {
    const rowNumber = index + 1;
    return !droppedRows.has(rowNumber) && !acceptedRepairRows.has(rowNumber);
  });
  const reverseLookup = createReverseCandidateFormLookup({
    relationRows: [...context.otherRelations, ...remainingOriginalRows], dropRows: context.allDrops, index: context.index,
    candidateMerge: context.candidateMerge,
  });
  const repairedRows = new Map();
  for (const [index, original] of beforeRelations.entries()) {
    const rowNumber = index + 1;
    const decision = decisionByRow.get(rowNumber);
    if (decision?.action !== 'repair' || !acceptedRepairRows.has(rowNumber)) continue;
    const sourceRecord = context.index.byId.get(original.source_record_id);
    const reverseForms = reverseLookup.available(sourceRecord, decision.target_sense_id);
    const repaired = {
      source_record_id: original.source_record_id,
      source_sense_id: original.source_sense_id,
      target_record_id: decision.target_record_id,
      target_sense_id: decision.target_sense_id,
      type: original.type,
      relevance: original.relevance,
      reverse_type: original.type,
      reverse_relevance: original.relevance,
      candidate_assignment_version: 1,
      candidate_forms: [original.text],
      reverse_candidate_forms: reverseForms,
    };
    reverseLookup.addRelation(repaired);
    repairedRows.set(rowNumber, repaired);
  }

  const afterOwnRows = [];
  const afterRelationLines = [];
  for (const [index, original] of beforeRelations.entries()) {
    const rowNumber = index + 1;
    const decision = decisionByRow.get(rowNumber);
    if (decision?.action === 'drop') continue;
    const repaired = decision?.action === 'repair' ? repairedRows.get(rowNumber) : null;
    if (repaired) {
      afterOwnRows.push(repaired);
      afterRelationLines.push(serializeRelationJsonl([repaired]).trimEnd());
    } else {
      afterOwnRows.push(original);
      afterRelationLines.push(relationLines[index]);
    }
  }
  return { removedRows: dropRows, afterOwnRows, afterRelationLines,
    summary: { removed: dropRows.length, repaired: repairedRows.size, repair_conflicts: repairConflicts } };
}

function describeSense(index, recordId, senseId) {
  const record = index.byId.get(recordId);
  const sense = index.senses.get(senseId);
  if (!record || !sense || sense.record.id !== recordId) fail(`report cannot resolve Canonical sense ${senseId} on ${recordId}`);
  return { record_id: recordId, lemma: record.lemma, sense_id: senseId, pos: sense.sense.pos, gloss: sense.sense.gloss };
}

function describeRelation(index, row) {
  const description = {
    source: describeSense(index, row.source_record_id, row.source_sense_id),
    type: row.type,
    tier: row.relevance,
  };
  if ('text' in row) description.text = row.text;
  else description.target = describeSense(index, row.target_record_id, row.target_sense_id);
  return description;
}

const isRepairOf = (original, row) => 'text' in original && !('text' in row)
  && row.source_record_id === original.source_record_id
  && row.source_sense_id === original.source_sense_id
  && row.type === original.type && row.relevance === original.relevance
  && row.candidate_forms?.length === 1 && row.candidate_forms[0] === original.text;

/** Classify the working-tree diff against HEAD into deletions, Link Repairs, added rows (contract breach) and Drops. */
export function report(diff, index) {
  const unmatched = [...diff.addedRelations];
  const deletions = [];
  const repairs = [];
  for (const original of diff.removedRelations) {
    const position = unmatched.findIndex((row) => isRepairOf(original, row));
    if (position >= 0) {
      const [repaired] = unmatched.splice(position, 1);
      repairs.push({
        source: describeSense(index, original.source_record_id, original.source_sense_id),
        before: { text: original.text, type: original.type, tier: original.relevance },
        after: { target: describeSense(index, repaired.target_record_id, repaired.target_sense_id),
          type: repaired.type, tier: repaired.relevance },
      });
      continue;
    }
    deletions.push(describeRelation(index, original));
  }
  return {
    deleted_relations: deletions,
    link_repairs: repairs,
    added_relations: unmatched.map((row) => describeRelation(index, row)),
    added_drops: diff.addedDrops.map((row) => ({
      source: describeSense(index, row.source_record_id, row.source_sense_id),
      candidate: row.candidate,
      reason: row.reason,
    })),
  };
}

/**
 * The decisions of a Stage 3 PR from base..HEAD. Apply keeps every surviving row in place and only appends Drops, so
 * walking both Relation files in order classifies each base row as kept, repaired (its text replaced by an ID row in
 * place) or dropped. Anything else — an added or reordered row, a changed base Drop — is not an engine-shaped edit.
 */
export function decisionsFromDiff({ baseRelations, baseLines, headLines, baseDropLines, headDropLines }) {
  const decisions = [];
  let next = 0;
  baseLines.forEach((line, index) => {
    if (headLines[next] === line) {
      next += 1;
      return;
    }
    const row = index + 1;
    const head = headLines[next] === undefined ? null : parseRelationJsonl(`${headLines[next]}\n`, 'HEAD')[0];
    if (head && isRepairOf(baseRelations[index], head)) {
      decisions.push({ row, action: 'repair', target_record_id: head.target_record_id, target_sense_id: head.target_sense_id });
      next += 1;
      return;
    }
    decisions.push({ row, action: 'drop' });
  });
  if (next !== headLines.length) fail('Stage 3 PR adds or reorders Relation rows; only Drops and Link Repairs can be amended');
  if (headDropLines.length < baseDropLines.length || baseDropLines.some((line, index) => headDropLines[index] !== line)) {
    fail('Stage 3 PR changes base Drop rows; only appended orphan Drops can be amended');
  }
  return decisions;
}

/**
 * Apply an amend delta to the current decisions. Rows are 1-based rows of the base Relation file (as `decisions`
 * lists them): `D <row...>` drops, `L <row> <target_sense_id>` links a text-only row, `K <row...>` keeps the base row.
 */
export function applyDelta(current, text, baseRelations) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'amend' || lines.length < 2) fail('Stage 3 amend input must be "amend" followed by D, L, or K rows');
  const byRow = new Map(current.map((decision) => [decision.row, decision]));
  const seen = new Set();
  const take = (rawRow, verb) => {
    const row = Number(rawRow);
    if (!baseRelations[row - 1] || seen.has(row)) fail(`${verb} ${rawRow}: base Relation row is unknown or repeated`);
    seen.add(row);
    return row;
  };
  for (const line of lines.slice(1)) {
    const drop = /^D\s+(\d+(?:\s+\d+)*)$/u.exec(line);
    const keep = /^K\s+(\d+(?:\s+\d+)*)$/u.exec(line);
    const repair = /^L\s+(\d+)\s+(\S+)$/u.exec(line);
    if (drop) for (const raw of drop[1].split(/\s+/u)) { const row = take(raw, 'D'); byRow.set(row, { row, action: 'drop' }); }
    else if (keep) for (const raw of keep[1].split(/\s+/u)) byRow.delete(take(raw, 'K'));
    else if (repair) {
      const row = take(repair[1], 'L');
      const senseId = repair[2];
      const recordId = /^(.+)-s\d+$/u.exec(senseId)?.[1];
      if (!recordId) fail(`L ${row}: ${senseId} is not a Sense ID`);
      byRow.set(row, { row, action: 'repair', target_record_id: recordId, target_sense_id: senseId });
    } else fail(`invalid amend line ${JSON.stringify(line)}; use D <row...>, L <row> <target_sense_id>, or K <row...>`);
  }
  return [...byRow.values()].sort((left, right) => left.row - right.row);
}

/** One recovered decision with its base row and target meanings, as bounded review context. */
export function describeDecision(decision, baseRelations, index) {
  const original = baseRelations[decision.row - 1];
  return { ...decision, relation: describeRelation(index, original),
    ...(decision.action === 'repair' ? { target: describeSense(index, decision.target_record_id, decision.target_sense_id) } : {}) };
}
