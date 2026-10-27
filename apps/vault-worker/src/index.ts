// Lynxterm vault server: stores ciphertext and revisions, never a key. Items encrypted on device.

interface Env {
  DB: D1Database;
  ENROLL_TOKEN?: string;
  NEW_DEVICES?: string;
}

type Sealed = { nonce: string; ct: string };
type PushItem = { id: string; kind: string; baseRev: number; sealed: Sealed | null };
type Header = { kdf: unknown; salt: string; [key: string]: unknown };

// One statement per line: D1's exec() splits on newlines.
const SCHEMA = `CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK (id = 1), header TEXT NOT NULL, auth_hash TEXT NOT NULL)
CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, rev INTEGER NOT NULL, sealed TEXT)
CREATE INDEX IF NOT EXISTS items_rev ON items (rev)
CREATE TABLE IF NOT EXISTS devices (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL)
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)
CREATE TABLE IF NOT EXISTS tries (ip TEXT PRIMARY KEY, fails INTEGER NOT NULL, until INTEGER NOT NULL)
INSERT OR IGNORE INTO meta VALUES ('head', 0), ('failed', 0), ('failed_at', 0)`;

const PAGE = 500;

// Sent on every response as Lynxterm-Worker. App stops syncing on mismatch, names side to update.
// Bump with WORKER_VERSION in app sync.rs on any change one side needs the other to have.
const VERSION = 1;

// Wrong passwords per address, fail2ban style: first FREE_TRIES free, each later one bans for
// next BAN_MINUTES step. Week with no wrong one resets address; right one clears it at once.
const FREE_TRIES = 5;
const BAN_MINUTES = [30, 120, 720, 1440];
const FORGET_MS = 7 * 24 * 3600_000;
// All addresses: guesses spread over many machines close login for everyone.
// Signed-in devices keep syncing; only joining waits.
const GLOBAL_LIMIT = 50;
const GLOBAL_MS = 3600_000;

// NEW_DEVICES = off: only devices signed in now pass. No login or enrolment, nothing to guess.
// Set on Cloudflare so stolen device token can't turn it back on.
const closed = (env: Env) => /^(off|false|no|0)$/i.test(env.NEW_DEVICES?.trim() ?? "");
const JOINING = new Set(["GET /v1/prelogin", "POST /v1/enrol", "POST /v1/login"]);

let schemaReady: Promise<unknown> | undefined;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Lynxterm-Worker": String(VERSION) } });
const fail = (status: number, error: string) => json({ error }, status);

const relative = new Intl.RelativeTimeFormat("en");

function later(ms: number) {
  const min = Math.ceil(ms / 60_000);
  return min < 60 ? relative.format(min, "minute") : relative.format(Math.round(min / 60), "hour");
}

const tooMany = (ms: number, error: string) => fail(429, `${error} Try again ${later(ms)}.`);

const hex = (buf: ArrayBuffer) => new Uint8Array(buf).toHex();
const digest = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
const sha256 = async (text: string) => hex(await digest(text));

// Hash both sides: equal lengths for timingSafeEqual, no length leak.
const same = async (a: string, b: string) =>
  crypto.subtle.timingSafeEqual(await digest(a), await digest(b));

const isHeader = (h: unknown): h is Header =>
  typeof h === "object" && h !== null && "kdf" in h && typeof (h as Header).salt === "string";

async function meta(env: Env, key: string) {
  return (await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(key).first<number>("v")) ?? 0;
}

async function newDeviceToken(env: Env) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  await env.DB.prepare("INSERT INTO devices (token_hash, created_at) VALUES (?, ?)")
    .bind(await sha256(token), Date.now())
    .run();
  return token;
}

const tokenHash = (req: Request) =>
  sha256(req.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "");

async function isDevice(req: Request, env: Env) {
  const row = await env.DB.prepare("SELECT 1 FROM devices WHERE token_hash = ?")
    .bind(await tokenHash(req))
    .first();
  return row !== null;
}

/** Cloudflare sets header, clients can't fake it. IPv6 counts by /64: one machine usually
 *  holds whole block. */
function address(req: Request) {
  const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!ip.includes(":")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = Math.max(0, 8 - left.length - right.length);
  return [...left, ...Array<string>(gap).fill("0"), ...right].slice(0, 4).join(":") + "::/64";
}

/** Counts try before secret check, bans up front as if wrong: parallel guesses can't slip past.
 *  Returns { wait } while banned, else { ban }: ban length now, ms (0 while free tries left).
 *  Right secret calls `cleared`. */
async function attempt(env: Env, ip: string): Promise<{ wait: number } | { ban: number }> {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT fails, until FROM tries WHERE ip = ?")
    .bind(ip)
    .first<{ fails: number; until: number }>();
  if (row && row.until > now) return { wait: row.until - now };
  const fails = row && now - row.until < FORGET_MS ? row.fails + 1 : 1;
  const step = Math.min(fails - FREE_TRIES, BAN_MINUTES.length);
  const ban = step > 0 ? BAN_MINUTES[step - 1]! * 60_000 : 0;
  // Only if no other request from this address counted a try in between.
  const { meta: written } = await env.DB.prepare(
    `INSERT INTO tries (ip, fails, until) VALUES (?1, ?2, ?3)
     ON CONFLICT (ip) DO UPDATE SET fails = ?2, until = ?3 WHERE fails = ?4`,
  )
    .bind(ip, fails, now + ban, row?.fails ?? 0)
    .run();
  return written.changes ? { ban } : { wait: 60_000 };
}

const cleared = (env: Env, ip: string) => env.DB.prepare("DELETE FROM tries WHERE ip = ?").bind(ip);

/** Wrong password: counts toward global limit, forgets quiet addresses. */
const wrong = (env: Env, now: number) =>
  env.DB.batch([
    env.DB.prepare(
      `UPDATE meta SET v = IIF(?1 - (SELECT v FROM meta WHERE k = 'failed_at') > ?2, 1, v + 1)
       WHERE k = 'failed'`,
    ).bind(now, GLOBAL_MS),
    env.DB.prepare("UPDATE meta SET v = ? WHERE k = 'failed_at'").bind(now),
    env.DB.prepare("DELETE FROM tries WHERE until < ?").bind(now - FORGET_MS),
  ]);

const wrongMessage = (what: string, ban: number) =>
  ban ? `${what}. Try again ${later(ban)}.` : what;

// Public parameters only: what device needs to derive keys.
async function prelogin(env: Env) {
  const header = await env.DB.prepare("SELECT header FROM vault").first<string>("header");
  if (!header) return json({ enrolled: false });
  const { kdf, salt } = JSON.parse(header) as Header;
  return json({ enrolled: true, kdf, salt });
}

// First device uploads vault header. Closed for good once vault exists.
async function enrol(req: Request, env: Env) {
  const { enrollToken, authKey, header } = await req.json<{
    enrollToken: string;
    authKey: string;
    header: unknown;
  }>();
  if (!env.ENROLL_TOKEN) return fail(503, "Set the ENROLL_TOKEN secret on this Worker first");
  const ip = address(req);
  const gate = await attempt(env, ip);
  if ("wait" in gate) return tooMany(gate.wait, "Too many wrong tries from your network.");
  if (!(await same(String(enrollToken), env.ENROLL_TOKEN)))
    return fail(403, wrongMessage("Wrong enrolment token", gate.ban));
  await cleared(env, ip).run();
  if (typeof authKey !== "string" || !isHeader(header)) return fail(400, "Bad request");

  // authKey Argon2-stretched on device: plain hash enough. Wrapped vault key stored beside it
  // allows same offline guessing anyway.
  const { meta: result } = await env.DB.prepare(
    "INSERT OR IGNORE INTO vault (id, header, auth_hash) VALUES (1, ?, ?)",
  )
    .bind(JSON.stringify(header), await sha256(authKey))
    .run();
  if (!result.changes) return fail(409, "This Worker already holds a vault");
  return json({ token: await newDeviceToken(env) });
}

async function login(req: Request, env: Env) {
  const { authKey } = await req.json<{ authKey: string }>();
  const [vault, failed, failedAt] = await Promise.all([
    env.DB.prepare("SELECT header, auth_hash FROM vault").first<{
      header: string;
      auth_hash: string;
    }>(),
    meta(env, "failed"),
    meta(env, "failed_at"),
  ]);
  if (!vault) return fail(404, "No vault on this Worker yet");
  const now = Date.now();
  if (failed >= GLOBAL_LIMIT && now - failedAt < GLOBAL_MS)
    return tooMany(GLOBAL_MS - (now - failedAt), "Too many wrong passwords lately.");
  const ip = address(req);
  const gate = await attempt(env, ip);
  if ("wait" in gate) return tooMany(gate.wait, "Too many wrong passwords from your network.");

  if (!(await same(await sha256(String(authKey)), vault.auth_hash))) {
    await wrong(env, now);
    return fail(401, wrongMessage("Wrong master password", gate.ban));
  }
  await env.DB.batch([
    cleared(env, ip),
    env.DB.prepare("UPDATE meta SET v = 0 WHERE k = 'failed'"),
  ]);
  return json({ token: await newDeviceToken(env), header: JSON.parse(vault.header) });
}

async function pull(url: URL, env: Env) {
  const since = Number(url.searchParams.get("since")) || 0;
  const [header, { results }] = await Promise.all([
    env.DB.prepare("SELECT header FROM vault").first<string>("header"),
    env.DB.prepare("SELECT id, kind, rev, sealed FROM items WHERE rev > ? ORDER BY rev LIMIT ?")
      .bind(since, PAGE)
      .all<{ id: string; kind: string; rev: number; sealed: string | null }>(),
  ]);
  return json({
    header: header && JSON.parse(header),
    items: results.map((r) => ({ ...r, sealed: r.sealed && JSON.parse(r.sealed) })),
    more: results.length === PAGE,
  });
}

async function push(req: Request, env: Env) {
  const { items } = await req.json<{ items: PushItem[] }>();
  if (!Array.isArray(items) || items.length === 0 || items.length > PAGE)
    return fail(400, `Send 1 to ${PAGE} items`);

  // Batch is one transaction. Per item: bump head, then upsert applied only while stored rev
  // equals device baseRev. Lost race returns no row: item left out of accepted.
  const statements = items.flatMap((item) => [
    env.DB.prepare("UPDATE meta SET v = v + 1 WHERE k = 'head'"),
    env.DB.prepare(
      `INSERT INTO items (id, kind, rev, sealed) VALUES (?1, ?2, (SELECT v FROM meta WHERE k = 'head'), ?3)
       ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, rev = excluded.rev, sealed = excluded.sealed
       WHERE items.rev = ?4
       RETURNING id, rev`,
    ).bind(
      String(item.id),
      String(item.kind),
      item.sealed ? JSON.stringify(item.sealed) : null,
      Number(item.baseRev) || 0,
    ),
  ]);
  const results = await env.DB.batch<{ id: string; rev: number }>(statements);
  const accepted = results.filter((_, i) => i % 2 === 1).flatMap((r) => r.results);
  return json({ accepted });
}

// Master password changed on one device (recovery). Signs out every other device; they sign in
// with new password, so whoever knew old one is out too.
async function putHeader(req: Request, env: Env) {
  const { authKey, header } = await req.json<{ authKey: string; header: unknown }>();
  if (typeof authKey !== "string" || !isHeader(header)) return fail(400, "Bad request");
  await env.DB.batch([
    env.DB.prepare("UPDATE vault SET header = ?, auth_hash = ?").bind(
      JSON.stringify(header),
      await sha256(authKey),
    ),
    env.DB.prepare("DELETE FROM devices WHERE token_hash != ?").bind(await tokenHash(req)),
  ]);
  return json({ ok: true });
}

// `devices` counts sign-ins: device that joined twice counts twice.
async function status(env: Env) {
  const devices = await env.DB.prepare("SELECT COUNT(*) AS n FROM devices").first<number>("n");
  return json({ devices, newDevices: !closed(env) });
}

export default { fetch: handle } satisfies ExportedHandler<Env>;

async function handle(req: Request, env: Env): Promise<Response> {
  schemaReady ??= env.DB.exec(SCHEMA);
  await schemaReady;

  const url = new URL(req.url);
  const route = `${req.method} ${url.pathname}`;
  if (JOINING.has(route) && closed(env))
    return fail(
      403,
      "This Worker takes no new devices. Remove NEW_DEVICES from its variables on Cloudflare to add one.",
    );
  try {
    switch (route) {
      case "GET /v1/prelogin":
        return await prelogin(env);
      case "POST /v1/enrol":
        return await enrol(req, env);
      case "POST /v1/login":
        return await login(req, env);
    }
    if (!(await isDevice(req, env))) return fail(401, "This device is not signed in");
    switch (route) {
      case "GET /v1/sync":
        return await pull(url, env);
      case "POST /v1/sync":
        return await push(req, env);
      case "PUT /v1/header":
        return await putHeader(req, env);
      case "GET /v1/status":
        return await status(env);
    }
    return fail(404, "Not found");
  } catch (e) {
    return e instanceof SyntaxError ? fail(400, "Invalid JSON") : fail(500, "Request failed");
  }
}
