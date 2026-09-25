export const SQLITE_SCHEMA_VERSION = '2';

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

CREATE TABLE senses (
  id TEXT PRIMARY KEY NOT NULL,
  record_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  pos TEXT NOT NULL CHECK (pos IN ('noun', 'adjective', 'verb', 'adverb', 'expression')),
  gloss TEXT NOT NULL,
  UNIQUE (id, record_id),
  UNIQUE (record_id, position),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE TABLE generated_surface_forms (
  form TEXT NOT NULL,
  record_id TEXT NOT NULL,
  sense_id TEXT NOT NULL,
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
  FOREIGN KEY (sense_id, record_id)
    REFERENCES senses(id, record_id) ON DELETE CASCADE
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
  PRIMARY KEY (source_sense_id, position),
  FOREIGN KEY (source_sense_id) REFERENCES senses(id) ON DELETE CASCADE,
  FOREIGN KEY (target_record_id) REFERENCES records(id),
  FOREIGN KEY (target_sense_id, target_record_id)
    REFERENCES senses(id, record_id)
);

CREATE INDEX idx_records_lemma ON records(lemma);
CREATE INDEX idx_search_forms_form ON search_forms(form);
CREATE INDEX idx_senses_record_position ON senses(record_id, position);
CREATE INDEX idx_generated_surface_forms_form ON generated_surface_forms(form);
CREATE INDEX idx_relations_source_position ON relations(source_sense_id, position);
CREATE INDEX idx_relations_target ON relations(target_record_id, target_sense_id);
`;
