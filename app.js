(() => {
  "use strict";

  const ITEMS = [["headband", "Head band"], ["flag", "Flag"], ["bag", "Bag"], ["badge", "Badge"], ["tshirt", "T-shirt"]];
  const LEVELS = ["Beginner", "Intermediate", "Advanced"];
  const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
  const TOKEN_KEY = "kitlog.token";
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? `${+m[3]}-${+m[2]}-${m[1]}` : ""; };

  // ---------- Config ----------
  const cfg = window.KIT_CONFIG || {};
  const BASE = str(cfg.supabaseUrl, 200).replace(/\/+$/, "");
  const KEY = str(cfg.supabaseKey, 2000);
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(BASE) && KEY.length > 20;

  // ---------- Session token (memory first, browser storage as a convenience) ----------
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  function saveToken(t) {
    token = t;
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  // ---------- API ----------
  async function rpc(fn, args) {
    const headers = { "Content-Type": "application/json", apikey: KEY };
    if (KEY.startsWith("eyJ")) headers.Authorization = "Bearer " + KEY; // legacy JWT anon key
    let res;
    try {
      res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
    } catch {
      throw Object.assign(new Error("offline"), { code: "offline" });
    }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      const msg = (body && body.message) || "request_failed";
      throw Object.assign(new Error(msg), { code: msg });
    }
    return body;
  }

  function errorText(err) {
    const c = err && err.code;
    if (c === "offline") return "No connection. Check your internet and try again.";
    if (c === "not_found") return "That person was deleted by someone else.";
    return "Couldn't save. Try again.";
  }

  // Any call that finds the session gone sends you back to the PIN screen.
  async function call(fn, args) {
    try { return await rpc(fn, { p_token: token, ...args }); }
    catch (err) {
      if (err.code === "not_logged_in") { lock(false); throw Object.assign(new Error("locked"), { code: "locked" }); }
      throw err;
    }
  }

  // ---------- State ----------
  let rows = [], notes = new Map();
  let editingId = null, openId = null, armedDelete = false;
  let level = "", size = "";
  let last = { batch: "", date: "", gym: "" };
  let noteEditing = null, noteDraft = "", pendingRender = false;
  let loadSeq = 0, timer = null;

  // ---------- Views ----------
  function show(view) {
    $("setupView").hidden = view !== "setup";
    $("loginView").hidden = view !== "login";
    $("appView").hidden = view !== "app";
  }

  function lock(callServer) {
    if (callServer && token) rpc("logout", { p_token: token }).catch(() => {});
    saveToken(null);
    clearInterval(timer); timer = null;
    rows = []; notes = new Map(); openId = null; noteEditing = null;
    closeSheet();
    $("list").replaceChildren();
    $("pin").value = ""; $("loginMsg").textContent = "";
    show("login");
    setTimeout(() => $("pin").focus(), 50);
  }

  async function unlocked() {
    show("app");
    setStatus("Loading…");
    await load();
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
  }

  function setStatus(text) { $("status").textContent = text; $("status").hidden = !text; }

  // ---------- Login ----------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("pin").value.trim();
    if (!/^[0-9]{6,12}$/.test(pin)) { $("loginMsg").textContent = "The PIN is 6 to 12 digits."; return; }
    const btn = $("loginBtn"); btn.disabled = true; $("loginMsg").textContent = "";
    try {
      const r = await rpc("login", { p_pin: pin });
      if (r && r.token) { saveToken(r.token); $("pin").value = ""; await unlocked(); return; }
      const e2 = r && r.error;
      $("loginMsg").textContent =
        e2 === "wrong_pin" ? "Wrong PIN." :
        e2 === "too_many_attempts" ? "Too many wrong tries. Wait 10 minutes and try again." :
        e2 === "pin_not_set" ? "No PIN has been set yet. Ask the owner to set one (see README)." :
        "Couldn't log in. Try again.";
      $("pin").select();
    } catch (err) {
      $("loginMsg").textContent = err.code === "offline" ? "No connection. Check your internet." : "Couldn't log in. Try again.";
    } finally { btn.disabled = false; }
  });
  $("lockBtn").addEventListener("click", () => lock(true));

  // ---------- Data ----------
  function cleanRow(d) {
    const items = {};
    for (const [k] of ITEMS) items[k] = !!(d.items && d.items[k] === true);
    return {
      id: String(d.id), items,
      name: str(d.name, 80) || "Unnamed", gym: str(d.gym, 80), level: str(d.level, 20), size: str(d.size, 10),
      batch: str(d.batch, 40), date: str(d.given_on, 10), note: str(d.note, 1000),
      createdAt: Date.parse(d.created_at) || 0,
    };
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const [h, n] = await Promise.all([call("list_handouts", {}), call("list_batch_notes", {})]);
      if (seq !== loadSeq) return;                 // a newer load already landed
      rows = (Array.isArray(h) ? h : []).map(cleanRow);
      notes = new Map((Array.isArray(n) ? n : []).map((x) => [str(x.batch, 40), str(x.note, 2000)]));
      if (openId && !rows.some((r) => r.id === openId)) openId = null;
      setStatus("");
      render();
    } catch (err) {
      if (err.code === "locked") return;
      if (seq === loadSeq) setStatus(err.code === "offline" ? "Offline. Showing the last loaded list." : "Couldn't load the list. Pull down or reopen to retry.");
    }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && token && !$("appView").hidden) load(); });

  // ---------- Form sheet ----------
  function buildSeg(box, values, get, set) {
    for (const v of values) {
      const b = el("button", null, v); b.type = "button";
      b.addEventListener("click", () => { set(get() === v ? "" : v); syncSeg(box, get()); });
      box.append(b);
    }
  }
  function syncSeg(box, value) { for (const b of box.children) b.setAttribute("aria-pressed", String(b.textContent === value)); }
  buildSeg($("segLevel"), LEVELS, () => level, (v) => (level = v));
  buildSeg($("segSize"), SIZES, () => size, (v) => (size = v));
  for (const [k, label] of ITEMS) {
    const l = el("label", "check");
    const c = document.createElement("input"); c.type = "checkbox"; c.id = "it_" + k;
    l.append(el("span", null, label), c);
    $("checklist").append(l);
  }

  function openSheet(r) {
    editingId = r ? r.id : null; armedDelete = false;
    $("sheetTitle").textContent = r ? "Edit person" : "Add person";
    $("fName").value = r ? r.name : "";
    $("fGym").value = r ? r.gym : last.gym;
    $("fBatch").value = r ? r.batch : last.batch;
    $("fDate").value = r ? (r.date || today()) : (last.date || today());
    $("fNote").value = r ? r.note : "";
    level = r ? r.level : ""; size = r ? r.size : "";
    syncSeg($("segLevel"), level); syncSeg($("segSize"), size);
    for (const [k] of ITEMS) $("it_" + k).checked = r ? !!r.items[k] : false;
    $("deleteBtn").hidden = !r; $("deleteBtn").textContent = "Delete person";
    $("formMsg").textContent = "";
    $("toast").hidden = true;
    $("sheet").hidden = false; document.body.classList.add("locked");
    if (!r) setTimeout(() => $("fName").focus(), 50);
  }
  function closeSheet() { $("sheet").hidden = true; document.body.classList.remove("locked"); editingId = null; }

  $("addBtn").addEventListener("click", () => openSheet(null));
  $("closeBtn").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const items = {}; for (const [k] of ITEMS) items[k] = $("it_" + k).checked;
    const data = {
      name: str($("fName").value, 80), gym: str($("fGym").value, 80),
      level: LEVELS.includes(level) ? level : "", size: SIZES.includes(size) ? size : "",
      batch: str($("fBatch").value, 40).toUpperCase(), date: $("fDate").value || today(),
      note: str($("fNote").value, 1000), items,
    };
    if (!data.name) { $("formMsg").textContent = "Enter a name."; $("fName").focus(); return; }
    const btn = $("saveBtn"); btn.disabled = true;
    try {
      await call("save_handout", { p_id: editingId, p_data: data });
      toast((editingId ? "Saved " : "Added ") + data.name);
      last = { batch: data.batch, date: data.date, gym: data.gym };
      closeSheet();
      load();
    } catch (err) { if (err.code !== "locked") $("formMsg").textContent = errorText(err); }
    finally { btn.disabled = false; }
  });

  $("deleteBtn").addEventListener("click", async () => {
    if (!armedDelete) { armedDelete = true; $("deleteBtn").textContent = "Tap again to delete"; return; }
    const id = editingId;
    try {
      await call("delete_handout", { p_id: id });
      if (openId === id) openId = null;
      closeSheet(); toast("Deleted"); load();
    } catch (err) { if (err.code !== "locked") $("formMsg").textContent = errorText(err); }
  });

  async function toggleItem(r, k) {
    const next = !r.items[k];
    r.items[k] = next; render();                   // show it right away
    try { await call("set_item", { p_id: r.id, p_key: k, p_value: next }); load(); }
    catch (err) { r.items[k] = !next; render(); if (err.code !== "locked") toast(errorText(err)); }
  }

  // ---------- Batch notes ----------
  function startNote(batch) { noteEditing = batch; noteDraft = notes.get(batch) || ""; render(); setTimeout(() => { const t = $("noteText"); if (t) t.focus(); }, 30); }
  function stopNote() { noteEditing = null; noteDraft = ""; render(); }
  async function saveNote(batch, btn) {
    btn.disabled = true;
    try {
      await call("save_batch_note", { p_batch: batch, p_note: noteDraft.slice(0, 2000) });
      const v = noteDraft.trim(); v ? notes.set(batch, v) : notes.delete(batch);
      toast("Batch note saved"); stopNote(); load();
    } catch (err) { btn.disabled = false; if (err.code !== "locked") toast(errorText(err)); }
  }

  // ---------- Render ----------
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2200);
  }
  function fillSelect(sel, values, allLabel) {
    const cur = sel.value; sel.replaceChildren(new Option(allLabel, ""));
    for (const v of values) sel.append(new Option(v, v));
    sel.value = values.includes(cur) ? cur : "";
  }

  function render() {
    // Don't rebuild the list under someone typing a batch note; catch up after.
    if (noteEditing !== null && document.activeElement && document.activeElement.id === "noteText") { pendingRender = true; return; }
    pendingRender = false;

    const gyms = [...new Set(rows.map((r) => r.gym).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const batches = [...new Set(rows.map((r) => r.batch).filter(Boolean))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    fillSelect($("qGym"), gyms, "All gyms"); fillSelect($("qBatch"), batches, "All batches");
    $("gymList").replaceChildren(...gyms.map((v) => new Option(v)));
    $("batchList").replaceChildren(...batches.map((v) => new Option(v)));

    const q = $("qSearch").value.trim().toLowerCase(), g = $("qGym").value, b = $("qBatch").value;
    const shown = rows.filter((r) => (!g || r.gym === g) && (!b || r.batch === b) &&
      (!q || (r.name + " " + r.gym + " " + r.note).toLowerCase().includes(q)));
    $("count").textContent = rows.length ? `${shown.length} of ${rows.length}` : "";

    const list = $("list"); list.replaceChildren();
    if (!rows.length) {
      const e = el("div", "empty"); e.append(el("b", null, "No one added yet"), el("span", null, "Tap Add person to log who got which items."));
      list.append(e); return;
    }
    if (!shown.length) { const e = el("div", "empty"); e.append(el("b", null, "No matches"), el("span", null, "Try a different search or filter.")); list.append(e); return; }

    const groups = new Map();
    for (const r of shown) { if (!groups.has(r.batch)) groups.set(r.batch, []); groups.get(r.batch).push(r); }
    const keys = [...groups.keys()].sort((a, c) => (a === "") - (c === "") || c.localeCompare(a, undefined, { numeric: true }));
    for (const k of keys) {
      const people = groups.get(k).sort((a, c) => c.createdAt - a.createdAt);
      list.append(groupHead(k, people.length));
      if (k) list.append(...batchNote(k));
      const ul = el("ul");
      for (const r of people) ul.append(personRow(r));
      list.append(ul);
    }
  }

  function groupHead(batch, n) {
    const head = el("div", "group-head");
    const right = el("div", "group-right");
    right.append(el("span", null, n + (n === 1 ? " person" : " people")));
    if (batch && noteEditing !== batch) {
      const btn = el("button", "link small", notes.has(batch) ? "Edit note" : "+ Note"); btn.type = "button";
      btn.addEventListener("click", () => startNote(batch));
      right.append(btn);
    }
    head.append(el("span", "group-name", batch || "No batch"), right);
    return head;
  }

  function batchNote(batch) {
    if (noteEditing === batch) {
      const box = el("div", "note-edit");
      const t = document.createElement("textarea");
      t.id = "noteText"; t.maxLength = 2000; t.placeholder = "Note for batch " + batch; t.value = noteDraft;
      t.addEventListener("input", () => { noteDraft = t.value; });
      t.addEventListener("blur", () => { if (pendingRender) setTimeout(render, 0); });
      const act = el("div", "actions");
      const cancel = el("button", "btn-sm", "Cancel"); cancel.type = "button"; cancel.addEventListener("mousedown", (e) => e.preventDefault()); cancel.addEventListener("click", stopNote);
      const save = el("button", "btn-sm dark", "Save note"); save.type = "button"; save.addEventListener("mousedown", (e) => e.preventDefault()); save.addEventListener("click", () => saveNote(batch, save));
      act.append(cancel, save); box.append(t, act);
      return [box];
    }
    const v = notes.get(batch);
    return v ? [el("div", "batch-note", v)] : [];
  }

  function personRow(r) {
    const li = el("li", "person");
    const given = ITEMS.filter(([k]) => r.items[k]).length;
    const row = el("button", "row"); row.type = "button"; row.setAttribute("aria-expanded", String(openId === r.id));
    const initials = r.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    const who = el("div", "who");
    who.append(el("div", "name", r.name), el("div", "meta", [r.gym, r.size].filter(Boolean).join(" · ") || "—"));
    row.append(el("div", "avatar", initials || "?"), who, el("span", "score" + (given === ITEMS.length ? " full" : ""), `${given}/${ITEMS.length}`));
    row.addEventListener("click", () => { openId = openId === r.id ? null : r.id; render(); });
    li.append(row);

    if (openId === r.id) {
      const d = el("div", "detail");
      const ticks = el("div", "ticks");
      for (const [k, label] of ITEMS) {
        const t = el("button", "tick" + (r.items[k] ? " on" : ""), label); t.type = "button";
        t.setAttribute("aria-pressed", String(r.items[k]));
        t.addEventListener("click", () => toggleItem(r, k));
        ticks.append(t);
      }
      const facts = el("div", "facts");
      const fact = (label, v) => { if (!v) return; const s = el("span", null, label + " "); s.append(el("b", null, v)); facts.append(s); };
      fact("Level", r.level); fact("Size", r.size); fact("Date", fmtDate(r.date));
      d.append(ticks);
      if (facts.childElementCount) d.append(facts);
      if (r.note) d.append(el("div", "note", r.note));
      const act = el("div", "actions");
      const edit = el("button", "btn-sm", "Edit"); edit.type = "button"; edit.addEventListener("click", () => openSheet(r));
      act.append(edit); d.append(act);
      li.append(d);
    }
    return li;
  }

  for (const id of ["qSearch", "qGym", "qBatch"]) $(id).addEventListener("input", render);

  // ---------- Start ----------
  if (!configured) show("setup");
  else if (token) unlocked();
  else lock(false);
})();
