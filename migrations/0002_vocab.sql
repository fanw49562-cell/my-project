CREATE TABLE IF NOT EXISTS vocab_settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_new INTEGER NOT NULL DEFAULT 20, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS vocab_words (id TEXT PRIMARY KEY, term TEXT NOT NULL, phonetic TEXT, pos TEXT, meaning TEXT NOT NULL, grammar TEXT, context_kind TEXT, context_title TEXT, context_body TEXT, topic TEXT);
CREATE TABLE IF NOT EXISTS vocab_progress (word_id TEXT PRIMARY KEY, stage INTEGER NOT NULL DEFAULT 0, interval_days INTEGER NOT NULL DEFAULT 0, due_on TEXT NOT NULL, introduced_on TEXT, last_grade TEXT, updated_at TEXT NOT NULL);
INSERT OR IGNORE INTO vocab_settings (id, weekly_new, updated_at) VALUES (1, 20, datetime('now'));
