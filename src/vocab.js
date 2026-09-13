import { WORDS } from "./words.js";

const INTERVALS = [1, 2, 4, 7, 15, 30, 60];
const DEFAULT_WEEKLY = 20;

export async function ensureVocab(db) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS vocab_settings (id INTEGER PRIMARY KEY CHECK (id = 1), weekly_new INTEGER NOT NULL DEFAULT 20, updated_at TEXT NOT NULL)"
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS vocab_words (
        id TEXT PRIMARY KEY,
        term TEXT NOT NULL,
        phonetic TEXT,
        pos TEXT,
        meaning TEXT NOT NULL,
        grammar TEXT,
        context_kind TEXT,
        context_title TEXT,
        context_body TEXT,
        topic TEXT
      )`
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS vocab_progress (
        word_id TEXT PRIMARY KEY,
        stage INTEGER NOT NULL DEFAULT 0,
        interval_days INTEGER NOT NULL DEFAULT 0,
        due_on TEXT NOT NULL,
        introduced_on TEXT,
        last_grade TEXT,
        updated_at TEXT NOT NULL
      )`
    )
    .run();

  const settings = await db.prepare("SELECT id FROM vocab_settings WHERE id = 1").first();
  if (!settings) {
    await db
      .prepare("INSERT INTO vocab_settings (id, weekly_new, updated_at) VALUES (1, ?, ?)")
      .bind(DEFAULT_WEEKLY, new Date().toISOString())
      .run();
  }

  for (const word of WORDS) {
    await db
      .prepare(
        `INSERT INTO vocab_words (id, term, phonetic, pos, meaning, grammar, context_kind, context_title, context_body, topic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           term = excluded.term,
           phonetic = excluded.phonetic,
           pos = excluded.pos,
           meaning = excluded.meaning,
           grammar = excluded.grammar,
           context_kind = excluded.context_kind,
           context_title = excluded.context_title,
           context_body = excluded.context_body,
           topic = excluded.topic`
      )
      .bind(
        word.id,
        word.term,
        word.phonetic,
        word.pos,
        word.meaning,
        word.grammar,
        word.contextKind,
        word.contextTitle,
        word.contextBody,
        word.topic
      )
      .run();
  }
}

export async function getVocab(env) {
  const day = todayInShanghai();
  await introduceToday(env.DB, day);
  return vocabState(env.DB, day);
}

export async function reviewWord(env, wordId, grade) {
  const allowed = new Set(["again", "hard", "good", "easy"]);
  if (!allowed.has(grade)) {
    throw Object.assign(new Error("评分不对"), { status: 400 });
  }

  const day = todayInShanghai();
  const row = await env.DB.prepare(
    `SELECT p.*, w.term FROM vocab_progress p
     JOIN vocab_words w ON w.id = p.word_id
     WHERE p.word_id = ?`
  )
    .bind(wordId)
    .first();

  if (!row) {
    throw Object.assign(new Error("还没有这个单词的进度"), { status: 404 });
  }

  const next = nextSchedule(row, grade, day);
  await env.DB.prepare(
    `UPDATE vocab_progress
     SET stage = ?, interval_days = ?, due_on = ?, last_grade = ?, updated_at = ?
     WHERE word_id = ?`
  )
    .bind(next.stage, next.interval_days, next.due_on, grade, new Date().toISOString(), wordId)
    .run();

  return vocabState(env.DB, day);
}

export async function updateVocabSettings(env, weeklyNew) {
  const value = Number(weeklyNew);
  if (!Number.isInteger(value) || value < 5 || value > 70) {
    throw Object.assign(new Error("每周新词请设在 5 到 70 之间"), { status: 400 });
  }

  await env.DB.prepare("UPDATE vocab_settings SET weekly_new = ?, updated_at = ? WHERE id = 1")
    .bind(value, new Date().toISOString())
    .run();

  return getVocab(env);
}

async function introduceToday(db, day) {
  const settings = await db.prepare("SELECT weekly_new FROM vocab_settings WHERE id = 1").first();
  const weeklyNew = settings?.weekly_new ?? DEFAULT_WEEKLY;
  const start = weekStartMonday(day);
  const introduced = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM vocab_progress WHERE introduced_on >= ? AND introduced_on <= ?"
    )
    .bind(start, day)
    .first();
  const used = Number(introduced?.n ?? 0);
  const remaining = Math.max(0, weeklyNew - used);
  const planned = plannedForDay(weeklyNew, day);
  const todayTarget = Math.min(planned, remaining);
  const alreadyToday = await db
    .prepare("SELECT COUNT(*) AS n FROM vocab_progress WHERE introduced_on = ?")
    .bind(day)
    .first();
  const need = Math.max(0, todayTarget - Number(alreadyToday?.n ?? 0));
  if (need === 0) return;

  const { results } = await db
    .prepare(
      `SELECT id FROM vocab_words
       WHERE id NOT IN (SELECT word_id FROM vocab_progress)
       ORDER BY topic, term
       LIMIT ?`
    )
    .bind(need)
    .all();

  const now = new Date().toISOString();
  for (const item of results ?? []) {
    await db
      .prepare(
        `INSERT INTO vocab_progress (word_id, stage, interval_days, due_on, introduced_on, last_grade, updated_at)
         VALUES (?, 0, 0, ?, ?, NULL, ?)`
      )
      .bind(item.id, day, day, now)
      .run();
  }
}

async function vocabState(db, day) {
  const settings = await db.prepare("SELECT weekly_new FROM vocab_settings WHERE id = 1").first();
  const weeklyNew = settings?.weekly_new ?? DEFAULT_WEEKLY;
  const start = weekStartMonday(day);
  const introduced = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM vocab_progress WHERE introduced_on >= ? AND introduced_on <= ?"
    )
    .bind(start, day)
    .first();
  const learned = await db
    .prepare("SELECT COUNT(*) AS n FROM vocab_progress WHERE last_grade IN ('good', 'easy')")
    .first();

  const { results: newRows } = await db
    .prepare(
      `SELECT w.*, p.stage, p.due_on, p.last_grade, p.introduced_on
       FROM vocab_progress p
       JOIN vocab_words w ON w.id = p.word_id
       WHERE p.introduced_on = ?
       ORDER BY w.topic, w.term`
    )
    .bind(day)
    .all();

  const { results: reviewRows } = await db
    .prepare(
      `SELECT w.*, p.stage, p.due_on, p.last_grade, p.introduced_on
       FROM vocab_progress p
       JOIN vocab_words w ON w.id = p.word_id
       WHERE p.due_on <= ? AND p.introduced_on < ?
       ORDER BY p.due_on, w.term`
    )
    .bind(day, day)
    .all();

  return {
    day,
    weeklyNew,
    introducedThisWeek: Number(introduced?.n ?? 0),
    mastered: Number(learned?.n ?? 0),
    bankSize: WORDS.length,
    newWords: (newRows ?? []).map((row) => serializeWord(row, day)),
    reviewWords: (reviewRows ?? []).map((row) => serializeWord(row, day)),
  };
}

function nextSchedule(row, grade, day) {
  let stage = Number(row.stage ?? 0);
  if (grade === "again") {
    stage = 0;
    return { stage, interval_days: 1, due_on: addDays(day, 1) };
  }
  if (grade === "hard") {
    const interval = Math.max(1, Number(row.interval_days) || 1);
    return { stage, interval_days: interval, due_on: addDays(day, interval) };
  }
  if (grade === "easy") {
    stage = Math.min(INTERVALS.length - 1, stage + 2);
  } else {
    stage = Math.min(INTERVALS.length - 1, stage + 1);
  }
  const interval = INTERVALS[stage];
  return { stage, interval_days: interval, due_on: addDays(day, interval) };
}

function serializeWord(row, day) {
  return {
    id: row.id,
    term: row.term,
    phonetic: row.phonetic,
    pos: row.pos,
    meaning: row.meaning,
    grammar: row.grammar,
    contextKind: row.context_kind,
    contextTitle: row.context_title,
    contextBody: row.context_body,
    topic: row.topic,
    stage: row.stage,
    dueOn: row.due_on,
    lastGrade: row.last_grade,
    done: Boolean(row.last_grade) && row.due_on > day,
  };
}

function todayInShanghai() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function weekStartMonday(day) {
  const date = new Date(`${day}T12:00:00+08:00`);
  const weekday = date.getDay();
  const offset = weekday === 0 ? 6 : weekday - 1;
  date.setDate(date.getDate() - offset);
  return shanghaiDay(date);
}

function plannedForDay(weeklyNew, day) {
  const perDay = Math.floor(weeklyNew / 7);
  const extra = weeklyNew % 7;
  const index = daysBetween(weekStartMonday(day), day);
  return perDay + (index < extra ? 1 : 0);
}

function daysBetween(start, end) {
  const a = Date.parse(`${start}T00:00:00+08:00`);
  const b = Date.parse(`${end}T00:00:00+08:00`);
  return Math.round((b - a) / 86400000);
}

function addDays(day, amount) {
  const date = new Date(`${day}T12:00:00+08:00`);
  date.setDate(date.getDate() + amount);
  return shanghaiDay(date);
}

function shanghaiDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
