const COOKIE = "daily_session";
const MAX_SENTENCE = 500;
const MAX_PHOTO = 5 * 1024 * 1024;
const SESSION_DAYS = 30;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (url.pathname === "/api/login" && request.method === "POST") {
        return login(request, env);
      }

      if (url.pathname === "/api/logout" && request.method === "POST") {
        return logout(request);
      }

      const ok = await hasSession(request, env);
      if (!ok) {
        return json({ error: "unauthorized" }, 401);
      }

      await ensureSchema(env.DB);

      if (url.pathname === "/api/state" && request.method === "GET") {
        return getState(env);
      }

      if (url.pathname === "/api/sentence" && request.method === "PUT") {
        return saveSentence(request, env);
      }

      if (url.pathname === "/api/photo" && request.method === "POST") {
        return savePhoto(request, env);
      }

      if (url.pathname === "/api/photo" && request.method === "DELETE") {
        return deletePhoto(env);
      }

      const photoMatch = url.pathname.match(/^\/api\/photo\/(\d{4}-\d{2}-\d{2})$/);
      if (photoMatch && request.method === "GET") {
        return getPhoto(env, photoMatch[1]);
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      return json({ error: error.message || "server error" }, 500);
    }
  },
};

async function ensureSchema(db) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS entries (day TEXT PRIMARY KEY, sentence TEXT, photo_key TEXT, photo_type TEXT, updated_at TEXT NOT NULL)"
    )
    .run();
}

async function login(request, env) {
  if (!env.ACCESS_CODE) {
    return json({ error: "未配置访问码" }, 503);
  }

  const body = await readJson(request);
  const code = String(body.code ?? "");
  if (!(await secretEqual(code, env.ACCESS_CODE))) {
    return json({ error: "访问码不对" }, 401);
  }

  const token = await signToken(env.ACCESS_CODE);
  return json(
    { ok: true },
    200,
    { "Set-Cookie": sessionCookie(token, request, SESSION_DAYS) }
  );
}

function logout(request) {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", request, 0) });
}

async function getState(env) {
  const day = todayInShanghai();
  const today = await env.DB.prepare("SELECT * FROM entries WHERE day = ?")
    .bind(day)
    .first();
  const { results } = await env.DB.prepare(
    "SELECT day, sentence, photo_key FROM entries ORDER BY day DESC LIMIT 60"
  ).all();

  return json({
    day,
    today: serializeEntry(today),
    entries: (results ?? []).map(serializeEntry),
  });
}

async function saveSentence(request, env) {
  const body = await readJson(request);
  const sentence = String(body.sentence ?? "").trim();
  if (sentence.length > MAX_SENTENCE) {
    return json({ error: `最多 ${MAX_SENTENCE} 个字` }, 400);
  }

  const day = todayInShanghai();
  await upsertEntry(env.DB, day, { sentence: sentence || null });
  return getState(env);
}

async function savePhoto(request, env) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: "请选择一张照片" }, 400);
  }
  if (file.size > MAX_PHOTO) {
    return json({ error: "照片请小于 5MB" }, 400);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return json({ error: "只支持 JPG、PNG、WebP 或 GIF" }, 400);
  }

  const day = todayInShanghai();
  await env.PHOTOS.put(day, await file.arrayBuffer(), {
    metadata: { contentType: file.type },
  });
  await upsertEntry(env.DB, day, { photo_key: day, photo_type: file.type });
  return getState(env);
}

async function deletePhoto(env) {
  const day = todayInShanghai();
  await env.PHOTOS.delete(day);
  await upsertEntry(env.DB, day, { photo_key: null, photo_type: null });
  return getState(env);
}

async function getPhoto(env, day) {
  const result = await env.PHOTOS.getWithMetadata(day, { type: "arrayBuffer" });
  if (!result.value) {
    return json({ error: "not found" }, 404);
  }

  const headers = new Headers();
  headers.set("Content-Type", result.metadata?.contentType || "image/jpeg");
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(result.value, { headers });
}

async function upsertEntry(db, day, patch) {
  const current = (await db.prepare("SELECT * FROM entries WHERE day = ?").bind(day).first()) ?? {
    day,
    sentence: null,
    photo_key: null,
    photo_type: null,
  };

  const next = {
    day,
    sentence: patch.sentence === undefined ? current.sentence : patch.sentence,
    photo_key: patch.photo_key === undefined ? current.photo_key : patch.photo_key,
    photo_type: patch.photo_type === undefined ? current.photo_type : patch.photo_type,
    updated_at: new Date().toISOString(),
  };

  if (!next.sentence && !next.photo_key) {
    await db.prepare("DELETE FROM entries WHERE day = ?").bind(day).run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO entries (day, sentence, photo_key, photo_type, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         sentence = excluded.sentence,
         photo_key = excluded.photo_key,
         photo_type = excluded.photo_type,
         updated_at = excluded.updated_at`
    )
    .bind(next.day, next.sentence, next.photo_key, next.photo_type, next.updated_at)
    .run();
}

function serializeEntry(row) {
  if (!row) {
    return { day: todayInShanghai(), sentence: "", hasPhoto: false };
  }
  return {
    day: row.day,
    sentence: row.sentence ?? "",
    hasPhoto: Boolean(row.photo_key),
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

async function hasSession(request, env) {
  if (!env.ACCESS_CODE) return false;
  const token = readCookie(request, COOKIE);
  if (!token) return false;
  return verifyToken(token, env.ACCESS_CODE);
}

async function signToken(secret) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = String(exp);
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

async function verifyToken(token, secret) {
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = await hmacHex(secret, payload);
  return secretEqual(sig, expected);
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const bytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function secretEqual(a, b) {
  const left = await sha256Hex(String(a));
  const right = await sha256Hex(String(b));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(";").map((part) => part.trim());
  const match = parts.find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : "";
}

function sessionCookie(value, request, days) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  if (days <= 0) {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  }
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days * 86400}${secure}`;
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers });
}
