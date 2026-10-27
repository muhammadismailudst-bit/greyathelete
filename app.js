(() => {
  "use strict";

  const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "XXXL"];
  const TOKEN_KEY = "kitlog.token";
  const REFRESH_MS = 30000;

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const btn = (cls, text, onClick) => { const b = el("button", cls, text); b.type = "button"; if (onClick) b.addEventListener("click", onClick); return b; };
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  const fmtDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? `${+m[3]}-${+m[2]}-${m[1]}` : ""; };
  const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

  // ---------- Config ----------
  const cfg = window.KIT_CONFIG || {};
  const BASE = str(cfg.supabaseUrl, 200).replace(/\/+$/, "");
  const KEY = str(cfg.supabaseKey, 2000);
  const configured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(BASE) && KEY.length > 20;

  // ---------- Session token ----------
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* storage blocked */ }
  function saveToken(t) {
    token = t;
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }

  // ---------- API ----------
  async function rpc(fn, args) {
    const headers = { "Content-Type": "application/json", apikey: KEY };
    if (KEY.startsWith("eyJ")) headers.Authorization = "Bearer " + KEY;
    let res;
    try { res = await fetch(`${BASE}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) }); }
    catch { throw Object.assign(new Error("offline"), { code: "offline" }); }
    const text = await res.text();
    let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) { const msg = (body && body.message) || "request_failed"; throw Object.assign(new Error(msg), { code: msg }); }
    return body;
  }
  async function call(fn, args) {
    try { return await rpc(fn, { p_token: token, ...args }); }
    catch (err) {
      if (err.code === "not_logged_in") { lock(false); throw Object.assign(new Error("locked"), { code: "locked" }); }
      throw err;
    }
  }
  function errorText(err) {
    const c = err && err.code;
    if (c === "offline") return "No connection. Check your internet and try again.";
    if (c === "not_found") return "That was already deleted by someone else.";
    if (c === "duplicate_name") return "That name is already in the list.";
    return "Couldn't save. Try again.";
  }

  // ---------- State ----------
  let people = [], races = [], items = [], categories = [];
  let editingId = null, openId = null, armedDelete = null;
  let size = "", formCats = new Set(), formRaces = new Set(), formItems = new Set();
  let last = { date: "", gym: "", races: [] };
  let manageEditing = null;                 // "race:<id>" | "item:<id>" | "cat:<name>"
  let loadSeq = 0, timer = null;

  const raceById = () => new Map(races.map((r) => [r.id, r]));

  // ---------- Views ----------
  function show(view) {
    $("setupView").hidden = view !== "setup";
    $("loginView").hidden = view !== "login";
    $("appView").hidden = view !== "app";
  }
  function setStatus(text) { $("status").textContent = text; $("status").hidden = !text; }

  function lock(callServer) {
    if (callServer && token) rpc("logout", { p_token: token }).catch(() => {});
    saveToken(null);
    clearInterval(timer); timer = null;
    people = []; races = []; items = []; categories = []; openId = null;
    closeSheet(); closeManage(); $("bulk").hidden = true;
    $("list").replaceChildren();
    $("pin").value = ""; $("loginMsg").textContent = "";
    show("login");
    setTimeout(() => $("pin").focus(), 50);
  }

  async function unlocked() {
    show("app"); setStatus("Loading…");
    await load();
    clearInterval(timer);
    timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, REFRESH_MS);
  }

  // ---------- Login ----------
  $("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pin = $("pin").value.trim();
    if (!/^[0-9]{6,12}$/.test(pin)) { $("loginMsg").textContent = "The PIN is 6 to 12 digits."; return; }
    const b = $("loginBtn"); b.disabled = true; $("loginMsg").textContent = "";
    try {
      const r = await rpc("login", { p_pin: pin });
      if (r && r.token) { saveToken(r.token); $("pin").value = ""; await unlocked(); return; }
      const e2 = r && r.error;
      $("loginMsg").textContent =
        e2 === "wrong_pin" ? "Wrong PIN." :
        e2 === "too_many_attempts" ? "Too many wrong tries. Wait 10 minutes and try again." :
        e2 === "pin_not_set" ? "No PIN has been set yet." : "Couldn't log in. Try again.";
      $("pin").select();
    } catch (err) {
      $("loginMsg").textContent = err.code === "offline" ? "No connection. Check your internet." : "Couldn't log in. Try again.";
    } finally { b.disabled = false; }
  });
  $("lockBtn").addEventListener("click", () => lock(true));

  // ---------- Data ----------
  function cleanPerson(d) {
    const its = {};
    if (d.items && typeof d.items === "object") for (const k of Object.keys(d.items)) if (d.items[k] === true || d.items[k] > 0) its[k] = true;
    return {
      id: String(d.id), items: its,
      races: Array.isArray(d.races) ? d.races.map(String) : [],
      name: str(d.name, 80) || "Unnamed", gym: str(d.gym, 80), categories: Array.isArray(d.categories) ? d.categories.map((c) => str(c, 40)).filter(Boolean) : [], size: str(d.size, 10),
      date: str(d.date, 10), note: str(d.note, 1000), createdAt: Date.parse(d.created_at) || 0,
    };
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const data = await call("list_all", {});
      if (seq !== loadSeq) return;
      people = (Array.isArray(data && data.people) ? data.people : []).map(cleanPerson);
      races = (Array.isArray(data && data.races) ? data.races : []).map((r) => ({ id: String(r.id), name: str(r.name, 60), date: str(r.date, 10), note: str(r.note, 2000) }));
      items = (Array.isArray(data && data.items) ? data.items : []).map((i) => ({ id: String(i.id), name: str(i.name, 40) }));
      categories = (Array.isArray(data && data.categories) ? data.categories : []).map((c) => str(c, 40)).filter(Boolean);
      if (openId && !people.some((p) => p.id === openId)) openId = null;
      setStatus("");
      render();
      if (!$("manage").hidden && !manageEditing) renderManage();
    } catch (err) {
      if (err.code === "locked") return;
      if (seq === loadSeq) setStatus(err.code === "offline" ? "Offline. Showing the last loaded list." : "Couldn't load the list. Reopen the app to retry.");
    }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && token && !$("appView").hidden) load(); });

  // ---------- Toast ----------
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2200);
  }

  // ---------- Person sheet ----------
  function buildSeg(box, values, get, set) {
    for (const v of values) box.append(btn(null, v, () => { set(get() === v ? "" : v); syncSeg(box, get()); }));
  }
  function syncSeg(box, value) { for (const b of box.children) b.setAttribute("aria-pressed", String(b.textContent === value)); }
  buildSeg($("segSize"), SIZES, () => size, (v) => (size = v));

  // A full-width row with a tick box on the right.
  function checkRow(label, on, onChange, sub) {
    const row = el("label", "check-row" + (on ? " on" : ""));
    const name = el("span", "qty-name", label);
    if (sub) name.append(el("span", "m-sub", "  " + sub));
    const c = document.createElement("input"); c.type = "checkbox"; c.checked = on;
    c.addEventListener("change", () => onChange(c.checked));
    row.append(name, c);
    return row;
  }

  // Find-or-create for each list. Each returns the key used on a person (race id, item id, category name).
  const LISTS = {
    race: { word: "race", max: 60,
      find: (n) => races.find((r) => r.name.toLowerCase() === n.toLowerCase())?.id,
      create: async (n) => { const id = String(await call("save_race", { p_id: null, p_name: n, p_date: null, p_note: "" })); races = [{ id, name: n, date: "", note: "" }, ...races]; return id; } },
    item: { word: "item", max: 40,
      find: (n) => items.find((i) => i.name.toLowerCase() === n.toLowerCase())?.id,
      create: async (n) => { const id = String(await call("save_item", { p_id: null, p_name: n })); items = [...items, { id, name: n }]; return id; } },
    cat: { word: "category", max: 40,
      find: (n) => categories.find((c) => c.toLowerCase() === n.toLowerCase()),
      create: async (n) => { const name = String(await call("save_category", { p_old: null, p_name: n })); categories = [...categories, name]; return name; } },
  };

  // Type a new name and add it on the spot; onAdded gets its key. An existing name is just ticked.
  function addRow(kind, onAdded) {
    const L = LISTS[kind];
    const f = el("div", "add-inline");
    const i = document.createElement("input"); i.maxLength = L.max; i.placeholder = `Add ${L.word === "item" ? "an item" : "a " + L.word}…`;
    i.autocomplete = "off"; i.enterKeyHint = "done"; i.setAttribute("aria-label", "New " + L.word);
    const b = btn("btn-sm dark", "Add");
    f.append(i, b);
    i.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); b.click(); } });
    i.addEventListener("blur", () => { if (pendingRender) setTimeout(render, 0); });
    b.addEventListener("mousedown", (e) => e.preventDefault());   // keep focus so a refresh can't wipe the text
    b.addEventListener("click", async () => {
      const name = str(i.value, L.max); if (!name) { i.focus(); return; }
      const found = L.find(name);
      b.disabled = true;
      try {
        const key = found !== undefined ? found : await L.create(name);
        i.value = ""; i.blur();
        await onAdded(key);
        toast(found !== undefined ? "Ticked " + name : "Added " + name);
      } catch (err) { if (err.code !== "locked") toast(errorText(err)); b.disabled = false; }
    });
    return f;
  }


  function renderFormCats() {
    const box = $("catChecklist"); box.replaceChildren();
    for (const c of categories) box.append(checkRow(c, formCats.has(c), (on) => { on ? formCats.add(c) : formCats.delete(c); renderFormCats(); }));
    box.append(addRow("cat", async (c) => { formCats.add(c); renderFormCats(); }));
  }
  function renderFormRaces() {
    const box = $("raceChecklist"); box.replaceChildren();
    for (const r of races) box.append(checkRow(r.name, formRaces.has(r.id), (on) => { on ? formRaces.add(r.id) : formRaces.delete(r.id); renderFormRaces(); }, fmtDate(r.date)));
    box.append(addRow("race", async (id) => { formRaces.add(id); renderFormRaces(); }));
  }
  function renderFormItems() {
    const box = $("checklist"); box.replaceChildren();
    for (const it of items) box.append(checkRow(it.name, formItems.has(it.id), (on) => { on ? formItems.add(it.id) : formItems.delete(it.id); renderFormItems(); }));
    box.append(addRow("item", async (id) => { formItems.add(id); renderFormItems(); }));
  }

  function openSheet(p) {
    editingId = p ? p.id : null;
    $("sheetTitle").textContent = p ? "Edit person" : "Add person";
    $("fName").value = p ? p.name : "";
    $("fGym").value = p ? p.gym : last.gym;
    $("fDate").value = p ? (p.date || "") : (last.date || today());
    $("fNote").value = p ? p.note : "";
    size = p ? p.size : ""; syncSeg($("segSize"), size);
    formCats = new Set(p ? p.categories : []);
    renderFormCats();
    const presetRace = $("qRace").value;
    formRaces = new Set(p ? p.races : (presetRace ? [presetRace] : last.races));
    renderFormRaces();
    formItems = new Set(p ? Object.keys(p.items) : []);
    renderFormItems();
    $("deleteBtn").hidden = !p; $("deleteBtn").textContent = "Delete person"; armedDelete = null;
    $("formMsg").textContent = "";
    $("toast").hidden = true;
    $("sheet").hidden = false; document.body.classList.add("locked");
    if (!p) setTimeout(() => $("fName").focus(), 50);
  }
  function closeSheet() { $("sheet").hidden = true; if ($("manage").hidden) document.body.classList.remove("locked"); editingId = null; }

  $("addBtn").addEventListener("click", () => openSheet(null));
  $("closeBtn").addEventListener("click", closeSheet);
  $("sheet").addEventListener("click", (e) => { if (e.target === $("sheet")) closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("sheet").hidden) closeSheet(); else if (!$("bulk").hidden) closeBulk(); else if (!$("manage").hidden) closeManage();
  });

  $("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const its = {}; for (const it of items) if (formItems.has(it.id)) its[it.id] = 1;
    const data = {
      name: str($("fName").value, 80), gym: str($("fGym").value, 80),
      categories: categories.filter((c) => formCats.has(c)), size: SIZES.includes(size) ? size : "",
      date: isDate($("fDate").value) ? $("fDate").value : "",
      note: str($("fNote").value, 1000), items: its, races: races.filter((r) => formRaces.has(r.id)).map((r) => r.id),
    };
    if (!data.name) { $("formMsg").textContent = "Enter a name."; $("fName").focus(); return; }
    const b = $("saveBtn"); b.disabled = true;
    try {
      await call("save_person", { p_id: editingId, p_data: data });
      toast((editingId ? "Saved " : "Added ") + data.name);
      last = { date: data.date, gym: data.gym, races: data.races };
      closeSheet(); load();
    } catch (err) { if (err.code !== "locked") $("formMsg").textContent = errorText(err); }
    finally { b.disabled = false; }
  });

  async function deletePerson(id, name) {
    try {
      await call("delete_person", { p_id: id });
      if (openId === id) openId = null;
      people = people.filter((p) => p.id !== id); render();
      toast("Deleted " + name); load();
      return true;
    } catch (err) { if (err.code !== "locked") toast(errorText(err)); return false; }
  }
  $("deleteBtn").addEventListener("click", async () => {
    if (armedDelete !== "sheet") { armedDelete = "sheet"; $("deleteBtn").textContent = "Tap again to delete"; return; }
    const id = editingId, name = $("fName").value.trim() || "person";
    if (await deletePerson(id, name)) closeSheet();
  });

  async function toggleRace(p, id) {
    const on = !p.races.includes(id);
    p.races = on ? [...p.races, id] : p.races.filter((r) => r !== id);
    render();
    try { await call("toggle_race", { p_id: p.id, p_race: id, p_value: on }); load(); }
    catch (err) { load(); if (err.code !== "locked") toast(errorText(err)); }
  }

  async function toggleItem(p, id) {
    const on = !p.items[id];
    if (on) p.items[id] = true; else delete p.items[id];
    render();
    try { await call("set_item_qty", { p_id: p.id, p_item: id, p_qty: on ? 1 : 0 }); load(); }
    catch (err) { load(); if (err.code !== "locked") toast(errorText(err)); }
  }

  async function toggleCat(p, name) {
    const on = !p.categories.includes(name);
    p.categories = on ? categories.filter((c) => c === name || p.categories.includes(c)) : p.categories.filter((c) => c !== name);
    render();
    try { await call("toggle_category", { p_id: p.id, p_name: name, p_value: on }); load(); }
    catch (err) { load(); if (err.code !== "locked") toast(errorText(err)); }
  }

  // ---------- Races & items sheet ----------
  function openManage() { manageEditing = null; armedDelete = null; $("manageMsg").textContent = ""; renderManage(); $("manage").hidden = false; document.body.classList.add("locked"); }
  function closeManage() { $("manage").hidden = true; manageEditing = null; if ($("sheet").hidden) document.body.classList.remove("locked"); }
  $("manageBtn").addEventListener("click", openManage);
  $("manageClose").addEventListener("click", closeManage);
  $("manage").addEventListener("click", (e) => { if (e.target === $("manage")) closeManage(); });

  async function manageCall(fn, args, ok) {
    $("manageMsg").textContent = "";
    try { await call(fn, args); manageEditing = null; armedDelete = null; toast(ok); await load(); renderManage(); return true; }
    catch (err) { if (err.code !== "locked") $("manageMsg").textContent = errorText(err); return false; }
  }

  $("raceAdd").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = str($("newRace").value, 60); if (!name) { $("newRace").focus(); return; }
    const d = $("newRaceDate").value;
    if (await manageCall("save_race", { p_id: null, p_name: name, p_date: isDate(d) ? d : null, p_note: "" }, "Added " + name)) {
      $("newRace").value = ""; $("newRaceDate").value = "";
    }
  });
  $("catAdd").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = str($("newCat").value, 40); if (!name) { $("newCat").focus(); return; }
    if (await manageCall("save_category", { p_old: null, p_name: name }, "Added " + name)) $("newCat").value = "";
  });
  $("itemAdd").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = str($("newItem").value, 40); if (!name) { $("newItem").focus(); return; }
    if (await manageCall("save_item", { p_id: null, p_name: name }, "Added " + name)) $("newItem").value = "";
  });

  function renderManage() {
    const rl = $("raceList"); rl.replaceChildren();
    for (const r of races) {
      const used = people.filter((p) => p.races.includes(r.id)).length;
      const li = el("li");
      if (manageEditing === "race:" + r.id) {
        const f = el("div", "m-edit");
        const n = document.createElement("input"); n.maxLength = 60; n.value = r.name; n.setAttribute("aria-label", "Race name");
        const d = document.createElement("input"); d.type = "date"; d.value = r.date; d.setAttribute("aria-label", "Race date");
        const t = document.createElement("textarea"); t.maxLength = 2000; t.value = r.note; t.placeholder = "Race note (optional)";
        const del = btn("btn-sm danger push", armedDelete === "race:" + r.id ? `Tap again (removes from ${used})` : "Delete", () => {
          if (armedDelete !== "race:" + r.id) { armedDelete = "race:" + r.id; renderManage(); return; }
          manageCall("delete_race", { p_id: r.id }, "Deleted " + r.name);
        });
        const act = el("div", "actions");
        act.append(btn("btn-sm", "Cancel", () => { manageEditing = null; armedDelete = null; renderManage(); }),
          btn("btn-sm dark", "Save", () => {
            const nm = str(n.value, 60); if (!nm) { n.focus(); return; }
            manageCall("save_race", { p_id: r.id, p_name: nm, p_date: isDate(d.value) ? d.value : null, p_note: str(t.value, 2000) }, "Saved " + nm);
          }), del);
        f.append(n, d, t, act); li.append(f);
      } else {
        const row = el("div", "m-row");
        const nm = el("div", "m-name", r.name);
        nm.append(el("div", "m-sub", [fmtDate(r.date), used + (used === 1 ? " person" : " people")].filter(Boolean).join(" · ")));
        row.append(nm, btn("btn-sm", "Edit", () => { manageEditing = "race:" + r.id; armedDelete = null; renderManage(); }));
        li.append(row);
      }
      rl.append(li);
    }

    const cl = $("catList"); cl.replaceChildren();
    for (const c of categories) {
      const used = people.filter((p) => p.categories.includes(c)).length;
      const li = el("li");
      if (manageEditing === "cat:" + c) {
        const f = el("div", "m-edit");
        const n = document.createElement("input"); n.maxLength = 40; n.value = c; n.setAttribute("aria-label", "Category name");
        const act = el("div", "actions");
        act.append(btn("btn-sm", "Cancel", () => { manageEditing = null; armedDelete = null; renderManage(); }),
          btn("btn-sm dark", "Save", () => { const nm = str(n.value, 40); if (!nm) { n.focus(); return; } manageCall("save_category", { p_old: c, p_name: nm }, "Saved " + nm); }),
          btn("btn-sm danger push", armedDelete === "cat:" + c ? `Tap again (removes from ${used})` : "Delete", () => {
            if (armedDelete !== "cat:" + c) { armedDelete = "cat:" + c; renderManage(); return; }
            manageCall("delete_category", { p_name: c }, "Deleted " + c);
          }));
        f.append(n, act); li.append(f);
      } else {
        const row = el("div", "m-row");
        const nm = el("div", "m-name", c); nm.append(el("div", "m-sub", used + (used === 1 ? " person" : " people")));
        row.append(nm, btn("btn-sm", "Edit", () => { manageEditing = "cat:" + c; armedDelete = null; renderManage(); }));
        li.append(row);
      }
      cl.append(li);
    }

    const il = $("itemList"); il.replaceChildren();
    for (const it of items) {
      const used = people.filter((p) => p.items[it.id]).length;
      const li = el("li");
      if (manageEditing === "item:" + it.id) {
        const f = el("div", "m-edit");
        const n = document.createElement("input"); n.maxLength = 40; n.value = it.name; n.setAttribute("aria-label", "Item name");
        const act = el("div", "actions");
        act.append(btn("btn-sm", "Cancel", () => { manageEditing = null; armedDelete = null; renderManage(); }),
          btn("btn-sm dark", "Save", () => { const nm = str(n.value, 40); if (!nm) { n.focus(); return; } manageCall("save_item", { p_id: it.id, p_name: nm }, "Saved " + nm); }),
          btn("btn-sm danger push", armedDelete === "item:" + it.id ? `Tap again (removes from ${used})` : "Delete", () => {
            if (armedDelete !== "item:" + it.id) { armedDelete = "item:" + it.id; renderManage(); return; }
            manageCall("delete_item", { p_id: it.id }, "Deleted " + it.name);
          }));
        f.append(n, act); li.append(f);
      } else {
        const row = el("div", "m-row");
        const nm = el("div", "m-name", it.name); nm.append(el("div", "m-sub", used + " given"));
        row.append(nm, btn("btn-sm", "Edit", () => { manageEditing = "item:" + it.id; armedDelete = null; renderManage(); }));
        li.append(row);
      }
      il.append(li);
    }
  }

  // ---------- Bulk add ----------
  const BULK_MAX = 500;
  let bulkRows = [];

  // One line -> cells. Tabs (pasted from a spreadsheet) win; otherwise commas, with "quoted, values".
  function splitLine(line) {
    if (line.includes("\t")) return line.split("\t").map((c) => { const m = /^\s*"([\s\S]*)"\s*$/.exec(c); return m ? m[1].replace(/""/g, '"') : c; });
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"' && !cur.trim()) { q = true; cur = ""; }
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  const multi = (s) => {
    const seen = new Set(), out = [];
    for (const v of String(s || "").split(/[;|]/).map((x) => x.trim()).filter(Boolean)) {
      const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(v); }
    }
    return out;
  };
  function normSize(s) {
    let v = String(s || "").trim().toUpperCase().replace(/\s+/g, "");
    if (!v) return [""];
    v = { "2XL": "XXL", "3XL": "XXXL", SMALL: "S", MEDIUM: "M", LARGE: "L" }[v] || v;
    return SIZES.includes(v) ? [v] : ["", `size "${s.trim()}" not recognised`];
  }

  function parseBulk(text) {
    const existing = new Set(people.map((p) => (p.name + "|" + p.gym).toLowerCase()));
    const inPaste = new Set();
    const rows = [];
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    lines.forEach((line, i) => {
      const c = splitLine(line).map((x) => x.trim());
      if (i === 0 && c[0] && c[0].toLowerCase() === "name") return;      // header row
      const name = c[0].slice(0, 80), gym = (c[1] || "").slice(0, 80);
      const [size, sw] = normSize(c[3]);
      const row = { name, gym, categories: multi(c[2]), size, races: multi(c[4]), items: multi(c[5]),
        note: c.slice(6).filter(Boolean).join(", ").slice(0, 1000), warn: [sw].filter(Boolean), skip: "" };
      const key = (name + "|" + gym).toLowerCase();
      if (!name) row.skip = "no name";
      else if (existing.has(key)) row.skip = "already in the list";
      else if (inPaste.has(key)) row.skip = "repeated in this list";
      inPaste.add(key);
      rows.push(row);
    });
    return rows;
  }

  function renderBulkPreview() {
    bulkRows = parseBulk($("bulkText").value);
    const box = $("bulkPreview"); box.replaceChildren();
    const add = bulkRows.filter((r) => !r.skip);
    $("bulkSave").disabled = !add.length || add.length > BULK_MAX;
    $("bulkSave").textContent = add.length ? `Add ${add.length}` : "Add";
    $("bulkMsg").textContent = add.length > BULK_MAX ? `That's ${add.length} people. Add at most ${BULK_MAX} at a time.` : "";
    if (!bulkRows.length) return;

    const knownR = new Set(races.map((r) => r.name.toLowerCase())), knownI = new Set(items.map((i) => i.name.toLowerCase())), knownC = new Set(categories.map((c) => c.toLowerCase()));
    const newR = new Map(), newI = new Map(), newC = new Map();
    for (const r of add) {
      for (const x of r.races) if (!knownR.has(x.toLowerCase())) newR.set(x.toLowerCase(), x);
      for (const x of r.items) if (!knownI.has(x.toLowerCase())) newI.set(x.toLowerCase(), x);
      for (const x of r.categories) if (!knownC.has(x.toLowerCase())) newC.set(x.toLowerCase(), x);
    }
    const wrap = el("div", "preview");
    const head = el("div", "preview-head");
    const skipped = bulkRows.length - add.length;
    head.append(el("b", null, `${add.length} to add` + (skipped ? ` · ${skipped} skipped` : "")));
    if (newR.size) head.append(el("span", null, "New races: " + [...newR.values()].join(", ")));
    if (newI.size) head.append(el("span", null, "New items: " + [...newI.values()].join(", ")));
    if (newC.size) head.append(el("span", null, "New categories: " + [...newC.values()].join(", ")));
    wrap.append(head);
    const ul = el("ul");
    for (const r of bulkRows.slice(0, 200)) {
      const li = el("li", r.skip ? "skip" : "");
      li.append(el("span", "p-name", (r.name || "(no name)") + (r.skip ? ` — skipped: ${r.skip}` : "")));
      const sub = [r.gym, r.categories.join(", "), r.size && "Size " + r.size].filter(Boolean).join(" · ");
      if (sub) li.append(el("span", "p-sub", sub));
      if (r.races.length) li.append(el("span", "p-sub", "Races: " + r.races.join(", ")));
      if (r.items.length) li.append(el("span", "p-sub", "Items: " + r.items.join(", ")));
      if (r.note) li.append(el("span", "p-sub", "Note: " + r.note));
      for (const w of r.warn) li.append(el("span", "p-sub warn", w + " (left blank)"));
      ul.append(li);
    }
    if (bulkRows.length > 200) ul.append(el("li", "p-sub", `…and ${bulkRows.length - 200} more`));
    wrap.append(ul); box.append(wrap);
  }

  let bulkTimer;
  $("bulkText").addEventListener("input", () => { clearTimeout(bulkTimer); bulkTimer = setTimeout(renderBulkPreview, 250); });
  $("bulkUseExample").addEventListener("click", () => { $("bulkText").value = $("bulkExample").textContent; renderBulkPreview(); });
  $("bulkBtn").addEventListener("click", () => {
    $("bulkMsg").textContent = ""; renderBulkPreview();
    $("toast").hidden = true; $("bulk").hidden = false; document.body.classList.add("locked");
  });
  function closeBulk() { $("bulk").hidden = true; if ($("sheet").hidden && $("manage").hidden) document.body.classList.remove("locked"); }
  $("bulkClose").addEventListener("click", closeBulk);
  $("bulk").addEventListener("click", (e) => { if (e.target === $("bulk")) closeBulk(); });
  $("bulkSave").addEventListener("click", async () => {
    renderBulkPreview();
    const add = bulkRows.filter((r) => !r.skip);
    if (!add.length || add.length > BULK_MAX) return;
    const b = $("bulkSave"); b.disabled = true; $("bulkMsg").textContent = "";
    try {
      const res = await call("bulk_add_people", { p_people: add.map(({ warn, skip, ...r }) => r) });
      const n = (res && res.added) || 0, s = (res && res.skipped) || 0;
      toast(`Added ${n} ${n === 1 ? "person" : "people"}` + (s ? `, skipped ${s}` : ""));
      $("bulkText").value = ""; bulkRows = [];
      closeBulk(); load();
    } catch (err) {
      if (err.code !== "locked") $("bulkMsg").textContent = err.code === "offline" ? errorText(err) : "Couldn't add the list. Nothing was saved. Try again.";
    } finally { b.disabled = false; }
  });

  // ---------- List ----------
  function fillSelect(sel, opts, allLabel) {
    const cur = sel.value; sel.replaceChildren(new Option(allLabel, ""));
    for (const [v, label] of opts) sel.append(new Option(label, v));
    sel.value = opts.some(([v]) => v === cur) ? cur : "";
  }

  let pendingRender = false;
  function render() {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest("#list .add-inline") && ae.value) { pendingRender = true; return; }
    pendingRender = false;
    const gyms = [...new Set(people.map((p) => p.gym).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fillSelect($("qGym"), gyms.map((g) => [g, g]), "All gyms");
    fillSelect($("qRace"), races.map((r) => [r.id, r.name]), "All races");
    fillSelect($("qCat"), categories.map((c) => [c, c]), "All categories");
    $("gymList").replaceChildren(...gyms.map((v) => new Option(v)));

    const q = $("qSearch").value.trim().toLowerCase(), g = $("qGym").value, rid = $("qRace").value, cat = $("qCat").value;
    const shown = people.filter((p) => (!g || p.gym === g) && (!rid || p.races.includes(rid)) && (!cat || p.categories.includes(cat)) &&
      (!q || (p.name + " " + p.gym + " " + p.note).toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name));
    $("count").textContent = people.length ? `${shown.length}/${people.length}` : "";

    const list = $("list"); list.replaceChildren();
    const race = rid ? raceById().get(rid) : null;
    if (race) {
      const ban = el("div", "race-banner");
      ban.append(el("b", null, race.name), el("span", "m-sub", [fmtDate(race.date), shown.length + (shown.length === 1 ? " person" : " people")].filter(Boolean).join(" · ")));
      if (race.note) ban.append(el("span", "m-sub", race.note));
      list.append(ban);
    }
    if (!people.length) {
      const e = el("div", "empty"); e.append(el("b", null, "No one added yet"), el("span", null, "Tap + Add to add someone, or use ⋯ → Bulk add for a list."));
      list.append(e); return;
    }
    if (!shown.length) { const e = el("div", "empty"); e.append(el("b", null, "No matches"), el("span", null, "Try a different search or filter.")); list.append(e); return; }
    const ul = el("ul");
    for (const p of shown) ul.append(personRow(p));
    list.append(ul);
  }

  function personRow(p) {
    const li = el("li", "person");
    const rmap = raceById();
    const given = items.filter((i) => p.items[i.id]).length;
    const row = el("button", "row"); row.type = "button"; row.setAttribute("aria-expanded", String(openId === p.id));
    const initials = p.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
    const who = el("div", "who");
    const myRaces = p.races.map((id) => rmap.get(id)).filter(Boolean);
    who.append(el("div", "name", p.name),
      el("div", "meta", [p.gym, p.categories.join(", "), p.size, myRaces.length ? myRaces.length + (myRaces.length === 1 ? " race" : " races") : ""].filter(Boolean).join(" · ") || "—"));
    row.append(el("div", "avatar", initials || "?"), who,
      el("span", "score" + (items.length && given === items.length ? " full" : ""), `${given}/${items.length}`));
    row.addEventListener("click", () => { openId = openId === p.id ? null : p.id; armedDelete = null; render(); });
    li.append(row);

    if (openId === p.id) {
      const d = el("div", "detail");
      const section = (label, rows, kind, onAdded) => {
        const t = el("div", "qty-list"); t.append(...rows, addRow(kind, onAdded));
        d.append(el("div", "sec-lbl", label), t);
      };
      section("Category", categories.map((c) => checkRow(c, p.categories.includes(c), () => toggleCat(p, c))),
        "cat", async (c) => { if (!p.categories.includes(c)) await toggleCat(p, c); });
      section("Items given", items.map((it) => checkRow(it.name, !!p.items[it.id], () => toggleItem(p, it.id))),
        "item", async (id) => { if (!p.items[id]) await toggleItem(p, id); });
      section("Races done", races.map((r) => checkRow(r.name, p.races.includes(r.id), () => toggleRace(p, r.id), fmtDate(r.date))),
        "race", async (id) => { if (!p.races.includes(id)) await toggleRace(p, id); });
      const facts = el("div", "facts");
      const fact = (label, v) => { if (!v) return; const s = el("span", null, label + " "); s.append(el("b", null, v)); facts.append(s); };
      fact("Size", p.size); fact("Date", fmtDate(p.date));
      if (facts.childElementCount) d.append(facts);
      if (p.note) d.append(el("div", "note", p.note));
      const act = el("div", "actions");
      act.append(btn("btn-sm", "Edit", () => openSheet(p)),
        btn("btn-sm danger", armedDelete === "row:" + p.id ? "Tap again to delete" : "Delete", () => {
          if (armedDelete !== "row:" + p.id) { armedDelete = "row:" + p.id; render(); return; }
          armedDelete = null; deletePerson(p.id, p.name);
        }));
      d.append(act);
      li.append(d);
    }
    return li;
  }

  for (const id of ["qSearch", "qGym", "qRace", "qCat"]) $(id).addEventListener("input", render);

  // ---------- Header menu ----------
  function setMenu(open) { $("menu").hidden = !open; $("menuBtn").setAttribute("aria-expanded", String(open)); }
  $("menuBtn").addEventListener("click", (e) => { e.stopPropagation(); setMenu($("menu").hidden); });
  $("menu").addEventListener("click", () => setMenu(false));
  document.addEventListener("click", (e) => { if (!$("menu").hidden && !e.target.closest(".menu-wrap")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

  // ---------- Start ----------
  if (!configured) show("setup");
  else if (token) unlocked();
  else lock(false);
})();
