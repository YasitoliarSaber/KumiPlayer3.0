-- Applied after the archived v25 fixture, this is the complete v26-only delta.
CREATE TABLE media_collections (
    collection_id TEXT PRIMARY KEY,
    collection_key TEXT NOT NULL UNIQUE,
    preferred_title TEXT NOT NULL,
    root_id TEXT NOT NULL REFERENCES source_roots(root_id),
    parent_collection_id TEXT REFERENCES media_collections(collection_id),
    created_at TEXT NOT NULL
);
CREATE TABLE revision_collection_members (
    revision_id TEXT NOT NULL REFERENCES import_revisions(revision_id) ON DELETE CASCADE,
    collection_id TEXT NOT NULL REFERENCES media_collections(collection_id) ON DELETE CASCADE,
    work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
    PRIMARY KEY(revision_id, collection_id, work_id)
);
CREATE INDEX idx_collection_members_work ON revision_collection_members(work_id, collection_id);
PRAGMA user_version = 26;
