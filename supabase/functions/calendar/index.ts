// Grey Athletes: the Events tab reads and writes the "Grey Events" Google Calendar directly,
// so the app and Google Calendar always show the same events.
//
// POST { action: "list" }                              -> { events: [...] }      (admins and viewers)
// POST { action: "save", id?: string, event: {...} }   -> { event }              (admins)
// POST { action: "delete", id: string }                -> { ok: true }           (admins)
//
// Who is calling: the signed-in Supabase user's token (Authorization header) is checked by asking
// the database (rpc my_access), which also gives their role. Google access: a service account
// whose JSON key is the GOOGLE_SERVICE_ACCOUNT secret; the calendar is shared with that account.
// Deployed with verify_jwt = false because this function does its own check (so CORS preflight works).

const TZ = "Asia/Qatar";
const DEFAULT_CALENDAR = "d4e18040a3d5ad38b0890740c4c3b9724080f0281f20c91dd2d6b96c098e9305@group.calendar.google.com";
const DEFAULT_ORIGINS = ["https://muhammadismailudst-bit.github.io"];   // override with ALLOWED_ORIGINS (comma-separated)
const GCAL = "https://www.googleapis.com/calendar/v3";

type Env = (key: string) => string | undefined;
type AppEvent = {
  id: string; title: string; starts_on: string; ends_on: string;
  start_time: string; end_time: string; location: string; details: string; link: string;
};

// ---------- small helpers ----------
const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isTime = (s: unknown) => typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
const isEventId = (s: unknown) => typeof s === "string" && /^[A-Za-z0-9_-]{1,1024}$/.test(s);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function plusHour(t: string): string {
  const [h, m] = t.split(":").map(Number);
  return h >= 23 ? "23:59" : `${String(h + 1).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
// A Google dateTime ("2026-10-30T08:00:00+03:00") as Qatar wall-clock date and time.
// One without an offset is already wall-clock time in the event's zone (we always write Qatar time).
function local(dt: string): { date: string; time: string } {
  const bare = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2}(\.\d+)?)?$/.exec(dt);
  if (bare) return { date: bare[1], time: bare[2] };
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(dt));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
// Descriptions edited in Google Calendar can contain simple HTML; keep the text.
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<li>/gi, "• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export function fromGoogle(g: any): AppEvent | null {
  if (!g || g.status === "cancelled" || !g.start) return null;
  let starts_on = "", ends_on = "", start_time = "", end_time = "";
  if (g.start.date) {                               // all day; Google's end date is exclusive
    starts_on = g.start.date;
    const last = g.end?.date ? addDays(g.end.date, -1) : starts_on;
    ends_on = last > starts_on ? last : "";
  } else if (g.start.dateTime) {
    const s = local(g.start.dateTime), e = local(g.end?.dateTime ?? g.start.dateTime);
    starts_on = s.date; start_time = s.time; end_time = e.time;
    ends_on = e.date > s.date ? e.date : "";
  } else return null;
  return {
    id: String(g.id), title: text(g.summary, 300) || "(No title)", starts_on, ends_on, start_time, end_time,
    location: text(g.location, 500), details: plain(text(g.description, 8000)), link: typeof g.htmlLink === "string" ? g.htmlLink : "",
  };
}

// App fields -> Google event fields. Throws "bad_input" for anything the app would not send.
export function toGoogle(e: any): Record<string, unknown> {
  const title = text(e?.title, 120);
  const s = e?.starts_on, end = e?.ends_on || "";
  if (!title || !isDate(s) || (end && !isDate(end))) throw new Error("bad_input");
  const last = end && end > s ? end : s;
  const out: Record<string, unknown> = {
    summary: title, location: text(e?.location, 200), description: text(e?.details, 4000),
  };
  if (isTime(e?.start_time)) {
    const st = e.start_time;
    let et = isTime(e?.end_time) ? e.end_time : plusHour(st);
    if (last === s && et <= st) et = plusHour(st);
    out.start = { dateTime: `${s}T${st}:00`, timeZone: TZ };
    out.end = { dateTime: `${last}T${et}:00`, timeZone: TZ };
  } else {
    out.start = { date: s };
    out.end = { date: addDays(last, 1) };
  }
  return out;
}

// ---------- Google service-account token (RS256 JWT -> access token), cached while warm ----------
let cachedToken = { token: "", exp: 0 };
const b64url = (b: ArrayBuffer | Uint8Array | string) => {
  const bytes = typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(b);
  let s = ""; for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
function pemToDer(pem: string): ArrayBuffer {
  const b = atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));
  const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out.buffer;
}
async function googleToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken.token && cachedToken.exp - 120 > now) return cachedToken.token;
  const raw = env("GOOGLE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("not_configured");
  const sa = JSON.parse(raw);
  const aud = sa.token_uri || "https://oauth2.googleapis.com/token";
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/calendar.events", aud, iat: now, exp: now + 3600,
  }));
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(sa.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const res = await fetch(aud, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) { console.error("google token", res.status, await res.text()); throw new Error("google_auth"); }
  const t = await res.json();
  cachedToken = { token: t.access_token, exp: now + (t.expires_in || 3600) };
  return cachedToken.token;
}

async function gcal(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const token = await googleToken(env);
  const res = await fetch(GCAL + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  if (res.status === 204 || res.status === 410) return null;          // deleted / already gone
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) { console.error("google api", res.status, await res.text()); throw new Error(res.status === 403 ? "calendar_not_shared" : "google_error"); }
  return res.json();
}

// ---------- who is calling ----------
async function roleOf(env: Env, auth: string | null): Promise<string | null> {
  if (!auth || !/^Bearer .+/.test(auth)) return null;
  const res = await fetch(`${env("SUPABASE_URL")}/rest/v1/rpc/my_access`, {
    method: "POST", headers: { apikey: env("SUPABASE_ANON_KEY") || "", Authorization: auth, "Content-Type": "application/json" }, body: "{}",
  });
  if (!res.ok) return null;
  const me = await res.json().catch(() => null);
  return me && (me.role === "admin" || me.role === "viewer") ? me.role : "none";
}

// ---------- request handler ----------
export async function handle(req: Request, env: Env): Promise<Response> {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env("ALLOWED_ORIGINS") || "").split(",").map((o) => o.trim()).filter(Boolean);
  const origins = allowed.length ? allowed : DEFAULT_ORIGINS;
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": origins.includes(origin) ? origin : origins[0],
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return reply(405, { error: "method_not_allowed" });

  const role = await roleOf(env, req.headers.get("Authorization"));
  if (!role) return reply(401, { error: "not_logged_in" });
  if (role === "none") return reply(403, { error: "no_access" });

  let body: any;
  try { body = await req.json(); } catch { return reply(400, { error: "bad_input" }); }
  const cal = `/calendars/${encodeURIComponent(env("GREY_CALENDAR_ID") || DEFAULT_CALENDAR)}/events`;

  try {
    if (body?.action === "list") {
      // From a year back (so "Show past events" has something) through everything upcoming.
      const timeMin = new Date(Date.now() - 365 * 864e5).toISOString();
      const events: AppEvent[] = [];
      let page = "";
      for (let i = 0; i < 10; i++) {
        const q = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin, maxResults: "2500", timeZone: TZ });
        if (page) q.set("pageToken", page);
        const r = await gcal(env, `${cal}?${q}`);
        for (const g of r?.items || []) { const e = fromGoogle(g); if (e) events.push(e); }
        page = r?.nextPageToken || "";
        if (!page) break;
      }
      return reply(200, { events });
    }

    if (role !== "admin") return reply(403, { error: "not_allowed" });

    if (body?.action === "save") {
      const fields = toGoogle(body.event);
      if (body.id) {
        if (!isEventId(body.id)) return reply(400, { error: "bad_input" });
        // Read, change our fields, write back: keeps reminders, guests, colour etc. set in Google.
        const current = await gcal(env, `${cal}/${encodeURIComponent(body.id)}`);
        const saved = await gcal(env, `${cal}/${encodeURIComponent(body.id)}`, { method: "PUT", body: JSON.stringify({ ...current, ...fields }) });
        return reply(200, { event: fromGoogle(saved) });
      }
      const saved = await gcal(env, cal, { method: "POST", body: JSON.stringify(fields) });
      return reply(200, { event: fromGoogle(saved) });
    }

    if (body?.action === "delete") {
      if (!isEventId(body.id)) return reply(400, { error: "bad_input" });
      await gcal(env, `${cal}/${encodeURIComponent(body.id)}`, { method: "DELETE" });
      return reply(200, { ok: true });
    }
    return reply(400, { error: "bad_input" });
  } catch (err) {
    const code = err instanceof Error ? err.message : "google_error";
    const status = code === "bad_input" ? 400 : code === "not_found" ? 404 : code === "not_configured" ? 503 : 502;
    return reply(status, { error: ["bad_input", "not_found", "not_configured", "google_auth", "calendar_not_shared"].includes(code) ? code : "google_error" });
  }
}

// Supabase Edge Runtime entry point (skipped when the file is imported by local tests).
declare const Deno: any;
if (typeof Deno !== "undefined" && Deno?.serve) {
  Deno.serve((req: Request) => handle(req, (k) => Deno.env.get(k)));
}
