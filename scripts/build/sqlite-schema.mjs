import {
  MEANING_RELATION_ORIGINS,
  SQLITE_SCHEMA_VERSION,
} from '../../src/runtime/dictionary-contract.js';

export { SQLITE_SCHEMA_VERSION };

export const SQLITE_SCHEMA_SQL = `
CREATE TABLE metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE records (
  id TEXT PRIMARY KEY NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('entry', 'expression')),
  role TEXT NOT NULL CHECK (role IN ('start', 'reference-only')),
  candidate_id TEXT,
  lemma TEXT NOT NULL
);

CREATE TABLE search_forms (
  record_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  form TEXT NOT NULL,
  PRIMARY KEY (record_id, position),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE TABLE generated_surface_forms (
  form TEXT NOT NULL,
  record_id TEXT NOT NULL,
  sense_id TEXT NOT NULL,
  sense_position INTEGER NOT NULL CHECK (sense_position >= 0),
  rule_id TEXT NOT NULL CHECK (rule_id IN (
    'verb-present-adnominal-neun',
    'verb-past-adnominal-eun',
    'adjective-present-adnominal-eun',
    'adjective-present-adnominal-neun-exception',
    'predicate-future-adnominal-eul',
    'predicate-plain-past-coda-bearing',
    'predicate-plain-past-open-a',
    'predicate-plain-past-hada',
    'predicate-plain-past-open-o-boda',
    'predicate-plain-past-required-oda',
    'predicate-plain-past-registered-exception'
  )),
  PRIMARY KEY (form, record_id, sense_id),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE TABLE meanings (
  id TEXT PRIMARY KEY NOT NULL,
  lemma TEXT NOT NULL,
  gloss TEXT NOT NULL,
  pos TEXT NOT NULL CHECK (pos IN (
    'noun', 'adjective', 'verb', 'adverb', 'determiner', 'interjection',
    'particle', 'ending', 'affix', 'unclassified', 'expression'
  )),
  record_id TEXT NOT NULL,
  lexical_relation_count INTEGER NOT NULL CHECK (lexical_relation_count >= 0),
  exploratory_relation_count INTEGER NOT NULL CHECK (exploratory_relation_count >= 0),
  display_rank INTEGER NOT NULL UNIQUE CHECK (display_rank >= 1),
  FOREIGN KEY (record_id) REFERENCES records(id)
);

CREATE TABLE meaning_members (
  meaning_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  sense_id TEXT NOT NULL UNIQUE,
  record_id TEXT NOT NULL,
  PRIMARY KEY (meaning_id, position),
  FOREIGN KEY (meaning_id) REFERENCES meanings(id) ON DELETE CASCADE,
  FOREIGN KEY (record_id) REFERENCES records(id)
);

CREATE TABLE sense_adjudications (
  sense_id TEXT PRIMARY KEY NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('duplicate', 'out_of_scope')),
  record_id TEXT NOT NULL,
  duplicate_of_sense_id TEXT,
  CHECK ((reason = 'duplicate') = (duplicate_of_sense_id IS NOT NULL)),
  FOREIGN KEY (record_id) REFERENCES records(id)
);

CREATE TABLE meaning_relations (
  source_meaning_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  target_meaning_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (
    'direct', 'near', 'antonym', 'mood',
    'scene', 'sensory', 'action', 'association'
  )),
  note TEXT NOT NULL,
  relevance INTEGER CHECK (relevance IS NULL OR relevance BETWEEN 1 AND 9),
  origin TEXT NOT NULL CHECK (origin IN (
    '${MEANING_RELATION_ORIGINS.projection}', '${MEANING_RELATION_ORIGINS.authored}'
  )),
  CHECK (length(note) > 0),
  PRIMARY KEY (source_meaning_id, position),
  UNIQUE (source_meaning_id, target_meaning_id, type),
  CHECK (source_meaning_id <> target_meaning_id),
  FOREIGN KEY (source_meaning_id) REFERENCES meanings(id) ON DELETE CASCADE,
  FOREIGN KEY (target_meaning_id) REFERENCES meanings(id)
);

CREATE INDEX idx_records_lemma ON records(lemma);
CREATE INDEX idx_search_forms_form ON search_forms(form);
CREATE INDEX idx_meaning_members_record ON meaning_members(record_id);
CREATE INDEX idx_sense_adjudications_record ON sense_adjudications(record_id);
CREATE INDEX idx_generated_surface_forms_form ON generated_surface_forms(form);
CREATE INDEX idx_meanings_lemma ON meanings(lemma);
CREATE INDEX idx_meanings_record ON meanings(record_id);
CREATE INDEX idx_meaning_relations_target ON meaning_relations(target_meaning_id);
`;

/**
 * STDICT source tables that exist only in the Full database (artifacts/dictionary.sqlite). The Lite product database never ships them
 * (Typewriter shows meanings, not raw source senses); they back the sense -> meaning projection checks.
 */
export const SQLITE_SOURCE_SCHEMA_SQL = `
CREATE TABLE senses (
  id TEXT PRIMARY KEY NOT NULL,
  record_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  pos TEXT NOT NULL CHECK (pos IN (
    'noun', 'adjective', 'verb', 'adverb', 'determiner', 'interjection',
    'particle', 'ending', 'affix', 'unclassified', 'expression'
  )),
  gloss TEXT NOT NULL,
  UNIQUE (id, record_id),
  UNIQUE (record_id, position),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE TABLE relations (
  source_sense_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  target_record_id TEXT NOT NULL,
  target_sense_id TEXT,
  type TEXT NOT NULL CHECK (type IN (
    'direct', 'near', 'antonym', 'mood',
    'scene', 'sensory', 'action', 'association'
  )),
  note TEXT NOT NULL,
  relevance INTEGER CHECK (relevance IS NULL OR relevance BETWEEN 1 AND 9),
  PRIMARY KEY (source_sense_id, position),
  FOREIGN KEY (source_sense_id) REFERENCES senses(id) ON DELETE CASCADE,
  FOREIGN KEY (target_record_id) REFERENCES records(id),
  FOREIGN KEY (target_sense_id, target_record_id)
    REFERENCES senses(id, record_id)
);

CREATE TABLE meaning_relation_sources (
  source_meaning_id TEXT NOT NULL,
  relation_position INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  source_sense_id TEXT NOT NULL,
  source_position INTEGER NOT NULL CHECK (source_position >= 0),
  source_redirected INTEGER NOT NULL CHECK (source_redirected IN (0, 1)),
  target_redirected INTEGER NOT NULL CHECK (target_redirected IN (0, 1)),
  PRIMARY KEY (source_meaning_id, relation_position, position),
  UNIQUE (source_sense_id, source_position),
  FOREIGN KEY (source_meaning_id, relation_position)
    REFERENCES meaning_relations(source_meaning_id, position) ON DELETE CASCADE,
  FOREIGN KEY (source_sense_id, source_position)
    REFERENCES relations(source_sense_id, position)
);

CREATE INDEX idx_senses_record_position ON senses(record_id, position);
CREATE INDEX idx_relations_source_position ON relations(source_sense_id, position);
CREATE INDEX idx_relations_target ON relations(target_record_id, target_sense_id);
`;
