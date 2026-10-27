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
  let people = [], items = [], categories = [], comps = [];   // comps: [{id, name}]
  let events = [], evLoaded = false;   // [{id, title, starts_on, ends_on, start_time, end_time, location, details}]
  let tab = "athletes", showPast = false, evEditingId = null, evArmedDelete = false;
  const photos = new Map();                 // personId -> { ts, data } (data URL)
  let editingId = null, openId = null, armedDelete = null;
  let size = "", formCats = new Set(), formItems = new Set(), formComps = new Set();
  let formPhoto = { changed: false, data: null };
  let last = { date: "", gym: "" };
  let manageEditing = null;                 // "item:<id>" | "cat:<name>" | "comp:<id>"
  let loadSeq = 0, timer = null;


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
    people = []; items = []; categories = []; comps = []; events = []; photos.clear(); openId = null;
    closeEvSheet();
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
      comps: Array.isArray(d.competitions) ? d.competitions.map(String) : [], photoTs: typeof d.photo === "string" ? d.photo : "",
      name: str(d.name, 80) || "Unnamed", gym: str(d.gym, 80), categories: Array.isArray(d.categories) ? d.categories.map((c) => str(c, 40)).filter(Boolean) : [], size: str(d.size, 10),
      date: str(d.date, 10), note: str(d.note, 1000), createdAt: Date.parse(d.created_at) || 0,
    };
  }

  async function load() {
    const seq = ++loadSeq;
    try {
      const [data, evs] = await Promise.all([call("list_all", {}), call("list_events", {}).catch((e) => { if (e.code === "locked") throw e; return null; })]);
      if (seq !== loadSeq) return;
      if (Array.isArray(evs)) { events = evs.map(cleanEvent).filter(Boolean); evLoaded = true; }
      people = (Array.isArray(data && data.people) ? data.people : []).map(cleanPerson);
      items = (Array.isArray(data && data.items) ? data.items : []).map((i) => ({ id: String(i.id), name: str(i.name, 40) }));
      categories = (Array.isArray(data && data.categories) ? data.categories : []).map((c) => str(c, 40)).filter(Boolean);
      comps = (Array.isArray(data && data.competitions) ? data.competitions : []).map((r) => ({ id: String(r.id), name: str(r.name, 60) }));
      if (openId && !people.some((p) => p.id === openId)) openId = null;
      setStatus("");
      render();
      renderEvents();
      if (!$("manage").hidden && !manageEditing) renderManage();
      loadPhotos();
    } catch (err) {
      if (err.code === "locked") return;
      if (seq === loadSeq) setStatus(err.code === "offline" ? "Offline. Showing the last loaded list." : "Couldn't load the list. Reopen the app to retry.");
    }
  }
  // Fetch only photos that are new or changed since we last saw them.
  let photoBusy = false;
  async function loadPhotos() {
    if (photoBusy) return;
    for (const id of [...photos.keys()]) if (!people.some((p) => p.id === id && p.photoTs)) photos.delete(id);
    const need = people.filter((p) => p.photoTs && (!photos.has(p.id) || photos.get(p.id).ts !== p.photoTs));
    if (!need.length) return;
    photoBusy = true;
    try {
      for (let i = 0; i < need.length; i += 100) {
        const chunk = need.slice(i, i + 100);
        const got = await call("get_photos", { p_ids: chunk.map((p) => p.id) });
        for (const p of chunk) {
          const d = got && got[p.id];
          if (typeof d === "string" && d.startsWith("data:image/jpeg;base64,")) photos.set(p.id, { ts: p.photoTs, data: d });
        }
      }
      render();
    } catch { /* photos are optional; try again next refresh */ }
    finally { photoBusy = false; }
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

  // Find-or-create for each list. Each returns the key used on a person (item id or category name).
  const compName = (id) => (comps.find((c) => c.id === id) || {}).name || "";
  const compNames = (p) => comps.filter((c) => p.comps.includes(c.id)).map((c) => c.name);

  const LISTS = {
    comp: { word: "competition", max: 60,
      find: (n) => comps.find((c) => c.name.toLowerCase() === n.toLowerCase())?.id,
      create: async (n) => { const id = String(await call("save_race", { p_id: null, p_name: n, p_date: null, p_note: "" })); comps = [...comps, { id, name: n }]; return id; } },
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
    for (const c of categories) box.append(checkRow(c, formCats.has(c), (on) => { formCats = new Set(on ? [c] : []); renderFormCats(); }));
    box.append(addRow("cat", async (c) => { formCats = new Set([c]); renderFormCats(); }));
  }
  function renderFormComps() {
    const box = $("compChecklist"); box.replaceChildren();
    for (const c of comps) box.append(checkRow(c.name, formComps.has(c.id), (on) => { on ? formComps.add(c.id) : formComps.delete(c.id); renderFormComps(); }));
    box.append(addRow("comp", async (id) => { formComps.add(id); renderFormComps(); }));
  }
  function renderFormItems() {
    const box = $("checklist"); box.replaceChildren();
    for (const it of items) box.append(checkRow(it.name, formItems.has(it.id), (on) => { on ? formItems.add(it.id) : formItems.delete(it.id); renderFormItems(); }));
    box.append(addRow("item", async (id) => { formItems.add(id); renderFormItems(); }));
  }

  // ---------- Photo ----------
  function renderFormPhoto() {
    const box = $("fPhotoPreview"); box.replaceChildren();
    if (formPhoto.data) { const img = new Image(); img.src = formPhoto.data; img.alt = ""; box.append(img); }
    else box.append(el("span", null, "No photo"));
    $("fPhotoLabel").textContent = formPhoto.data ? "Change photo" : "Add photo";
    $("fPhotoRemove").hidden = !formPhoto.data;
  }
  // Shrink to at most 480px, centre-cropped square, as JPEG (about 30–60 KB).
  async function toJpeg(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = url; });
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      if (!side) throw new Error("empty");
      const out = Math.min(480, side);
      const c = document.createElement("canvas"); c.width = c.height = out;
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, out, out);
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
      for (const q of [0.82, 0.7, 0.55]) { const d = c.toDataURL("image/jpeg", q); if (d.length <= 290000) return d; }
      throw new Error("too_big");
    } finally { URL.revokeObjectURL(url); }
  }
  $("fPhoto").addEventListener("change", async () => {
    const f = $("fPhoto").files && $("fPhoto").files[0]; $("fPhoto").value = "";
    if (!f) return;
    if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) { $("formMsg").textContent = "That file isn't a photo."; return; }
    try { formPhoto = { changed: true, data: await toJpeg(f) }; renderFormPhoto(); $("formMsg").textContent = ""; }
    catch { $("formMsg").textContent = "Couldn't read that photo. Try a different one."; }
  });
  $("fPhotoRemove").addEventListener("click", () => { formPhoto = { changed: true, data: null }; renderFormPhoto(); });

  function openSheet(p) {
    editingId = p ? p.id : null;
    $("sheetTitle").textContent = p ? "Edit athlete" : "Add athlete";
    $("fName").value = p ? p.name : "";
    $("fGym").value = p ? p.gym : last.gym;
    $("fDate").value = p ? (p.date || "") : (last.date || today());
    $("fNote").value = p ? p.note : "";
    size = p ? p.size : ""; syncSeg($("segSize"), size);
    formCats = new Set(p ? p.categories : []);
    renderFormCats();
    formComps = new Set(p ? p.comps : []);
    renderFormComps();
    formPhoto = { changed: false, data: p && photos.has(p.id) ? photos.get(p.id).data : null };
    renderFormPhoto();
    formItems = new Set(p ? Object.keys(p.items) : []);
    renderFormItems();
    $("deleteBtn").hidden = !p; $("deleteBtn").textContent = "Delete athlete"; armedDelete = null;
    $("formMsg").textContent = "";
    $("toast").hidden = true;
    $("sheet").hidden = false; document.body.classList.add("locked");
    if (!p) setTimeout(() => $("fName").focus(), 50);
  }
  function closeSheet() { $("sheet").hidden = true; if ($("manage").hidden) document.body.classList.remove("locked"); editingId = null; }

  $("addBtn").addEventListener("click", () => (tab === "events" ? openEvSheet(null) : openSheet(null)));
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
      categories: categories.filter((c) => formCats.has(c)).slice(0, 1), size: SIZES.includes(size) ? size : "",
      date: isDate($("fDate").value) ? $("fDate").value : "",
      note: str($("fNote").value, 1000), items: its, competitions: comps.filter((c) => formComps.has(c.id)).map((c) => c.id),
    };
    if (!data.name) { $("formMsg").textContent = "Enter a name."; $("fName").focus(); return; }
    const b = $("saveBtn"); b.disabled = true;
    try {
      const id = String(await call("save_person", { p_id: editingId, p_data: data }));
      if (formPhoto.changed) {
        try { await call("set_photo", { p_id: id, p_data: formPhoto.data }); }
        catch (err) { if (err.code === "locked") throw err; toast("Saved, but the photo didn't upload. Try again from Edit."); }
      }
      toast((editingId ? "Saved " : "Added ") + data.name);
      last = { date: data.date, gym: data.gym };
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

  async function toggleItem(p, id) {
    const on = !p.items[id];
    if (on) p.items[id] = true; else delete p.items[id];
    render();
    try { await call("set_item_qty", { p_id: p.id, p_item: id, p_qty: on ? 1 : 0 }); load(); }
    catch (err) { load(); if (err.code !== "locked") toast(errorText(err)); }
  }

  async function toggleComp(p, id) {
    const on = !p.comps.includes(id);
    p.comps = on ? [...p.comps, id] : p.comps.filter((x) => x !== id);
    render();
    try { await call("toggle_race", { p_id: p.id, p_race: id, p_value: on }); load(); }
    catch (err) { load(); if (err.code !== "locked") toast(errorText(err)); }
  }

  async function toggleCat(p, name) {
    const on = !p.categories.includes(name);
    p.categories = on ? [name] : [];
    render();
    try { await call("toggle_category", { p_id: p.id, p_name: name, p_value: on }); load(); }
    catch (err) { load(); if (err.code !== "locked") toast(errorText(err)); }
  }

  // ---------- Lists sheet (categories & items) ----------
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

  $("compAdd").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = str($("newComp").value, 60); if (!name) { $("newComp").focus(); return; }
    if (await manageCall("save_race", { p_id: null, p_name: name, p_date: null, p_note: "" }, "Added " + name)) $("newComp").value = "";
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
    const ml = $("compList"); ml.replaceChildren();
    for (const c of comps) {
      const used = people.filter((p) => p.comps.includes(c.id)).length;
      const li = el("li");
      if (manageEditing === "comp:" + c.id) {
        const f = el("div", "m-edit");
        const n = document.createElement("input"); n.maxLength = 60; n.value = c.name; n.setAttribute("aria-label", "Competition name");
        const act = el("div", "actions");
        act.append(btn("btn-sm", "Cancel", () => { manageEditing = null; armedDelete = null; renderManage(); }),
          btn("btn-sm dark", "Save", () => { const nm = str(n.value, 60); if (!nm) { n.focus(); return; } manageCall("save_race", { p_id: c.id, p_name: nm, p_date: null, p_note: "" }, "Saved " + nm); }),
          btn("btn-sm danger push", armedDelete === "comp:" + c.id ? `Tap again (removes from ${used})` : "Delete", () => {
            if (armedDelete !== "comp:" + c.id) { armedDelete = "comp:" + c.id; renderManage(); return; }
            manageCall("delete_race", { p_id: c.id }, "Deleted " + c.name);
          }));
        f.append(n, act); li.append(f);
      } else {
        const row = el("div", "m-row");
        const nm = el("div", "m-name", c.name); nm.append(el("div", "m-sub", used + (used === 1 ? " athlete" : " athletes")));
        row.append(nm, btn("btn-sm", "Edit", () => { manageEditing = "comp:" + c.id; armedDelete = null; renderManage(); }));
        li.append(row);
      }
      ml.append(li);
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
      const cats = multi(c[2]);
      const row = { name, gym, categories: cats.slice(0, 1), size, competitions: multi(c[4]), items: multi(c[5]),
        note: c.slice(6).filter(Boolean).join(", ").slice(0, 1000),
        warn: [sw, cats.length > 1 && `only one category allowed, kept "${cats[0]}"`].filter(Boolean), skip: "" };
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

    const knownI = new Set(items.map((i) => i.name.toLowerCase())), knownC = new Set(categories.map((c) => c.toLowerCase())), knownM = new Set(comps.map((c) => c.name.toLowerCase()));
    const newM = new Map();
    const newI = new Map(), newC = new Map();
    for (const r of add) {
      for (const x of r.items) if (!knownI.has(x.toLowerCase())) newI.set(x.toLowerCase(), x);
      for (const x of r.categories) if (!knownC.has(x.toLowerCase())) newC.set(x.toLowerCase(), x);
      for (const x of r.competitions) if (!knownM.has(x.toLowerCase())) newM.set(x.toLowerCase(), x);
    }
    const wrap = el("div", "preview");
    const head = el("div", "preview-head");
    const skipped = bulkRows.length - add.length;
    head.append(el("b", null, `${add.length} to add` + (skipped ? ` · ${skipped} skipped` : "")));
    if (newI.size) head.append(el("span", null, "New items: " + [...newI.values()].join(", ")));
    if (newC.size) head.append(el("span", null, "New categories: " + [...newC.values()].join(", ")));
    if (newM.size) head.append(el("span", null, "New competitions: " + [...newM.values()].join(", ")));
    wrap.append(head);
    const ul = el("ul");
    for (const r of bulkRows.slice(0, 200)) {
      const li = el("li", r.skip ? "skip" : "");
      li.append(el("span", "p-name", (r.name || "(no name)") + (r.skip ? ` — skipped: ${r.skip}` : "")));
      const sub = [r.gym, r.categories.join(", "), r.size && "Size " + r.size].filter(Boolean).join(" · ");
      if (sub) li.append(el("span", "p-sub", sub));
      if (r.competitions.length) li.append(el("span", "p-sub", "Competitions: " + r.competitions.join(", ")));
      if (r.items.length) li.append(el("span", "p-sub", "Items: " + r.items.join(", ")));
      if (r.note) li.append(el("span", "p-sub", "Note: " + r.note));
      for (const w of r.warn) li.append(el("span", "p-sub warn", w.startsWith("only one") ? w : w + " (left blank)"));
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
  function filtered() {
    const q = $("qSearch").value.trim().toLowerCase(), g = $("qGym").value, cat = $("qCat").value, cm = $("qComp").value;
    return people.filter((p) => (!g || p.gym === g) && (!cat || p.categories.includes(cat)) && (!cm || p.comps.includes(cm)) &&
      (!q || [p.name, p.gym, ...compNames(p), p.note].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  }

  function render() {
    const ae = document.activeElement;
    if (ae && ae.closest && ae.closest("#list .add-inline") && ae.value) { pendingRender = true; return; }
    pendingRender = false;
    const gyms = [...new Set(people.map((p) => p.gym).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    fillSelect($("qGym"), gyms.map((g) => [g, g]), "All gyms");
    fillSelect($("qCat"), categories.map((c) => [c, c]), "All categories");
    fillSelect($("qComp"), comps.map((c) => [c.id, c.name]), "All competitions");
    syncFilterBtn();
    $("gymList").replaceChildren(...gyms.map((v) => new Option(v)));

    const shown = filtered();
    const done = shown.filter((p) => items.length && items.every((i) => p.items[i.id])).length;
    if (tab === "athletes") $("count").textContent = !people.length ? "" :
      (shown.length === people.length ? `${people.length} ${people.length === 1 ? "athlete" : "athletes"}` : `${shown.length} of ${people.length} athletes`) +
      (items.length ? ` · ${done} fully kitted` : "");

    const list = $("list"); list.replaceChildren();
    if (!people.length) {
      const e = el("div", "empty"); e.append(el("b", null, "No one added yet"), el("span", null, "Tap + Add to add an athlete, or use ⋯ → Bulk add for a list."));
      list.append(e); return;
    }
    if (!shown.length) { const e = el("div", "empty"); e.append(el("b", null, "No matches"), el("span", null, "Try a different search or filter.")); list.append(e); return; }
    const ul = el("ul");
    for (const p of shown) ul.append(personRow(p));
    list.append(ul);
  }

  function avatar(p, initials) {
    const a = el("div", "avatar");
    const ph = photos.get(p.id);
    if (ph) { const img = new Image(); img.src = ph.data; img.alt = ""; a.append(img); }
    else a.textContent = initials || "?";
    return a;
  }

  function personRow(p) {
    const li = el("li", "person");
    const given = items.filter((i) => p.items[i.id]).length;
    const row = el("button", "row"); row.type = "button"; row.setAttribute("aria-expanded", String(openId === p.id));
    // First letter of the first two words that start with a letter or digit (emoji-safe).
    const initials = p.name.split(/\s+/).map((w) => Array.from(w)[0] || "").filter((c) => /[\p{L}\p{N}]/u.test(c)).slice(0, 2).join("").toUpperCase();
    const who = el("div", "who");
    who.append(el("div", "name", p.name),
      el("div", "meta", [p.gym, p.categories.join(", "), p.size].filter(Boolean).join(" · ") || "—"));
    row.append(avatar(p, initials), who,
      el("span", "score" + (items.length && given === items.length ? " full" : ""), `${given}/${items.length}`));
    row.addEventListener("click", () => { openId = openId === p.id ? null : p.id; armedDelete = null; render(); });
    li.append(row);

    if (openId === p.id) {
      const d = el("div", "detail");
      const section = (label, rows, kind, onAdded) => {
        const t = el("div", "qty-list" + (kind === "cat" ? " single" : "")); t.append(...rows, addRow(kind, onAdded));
        d.append(el("div", "sec-lbl", label), t);
      };
      section("Category", categories.map((c) => checkRow(c, p.categories.includes(c), () => toggleCat(p, c))),
        "cat", async (c) => { if (!p.categories.includes(c)) await toggleCat(p, c); });
      section("Items given", items.map((it) => checkRow(it.name, !!p.items[it.id], () => toggleItem(p, it.id))),
        "item", async (id) => { if (!p.items[id]) await toggleItem(p, id); });
      section("Competitions", comps.map((c) => checkRow(c.name, p.comps.includes(c.id), () => toggleComp(p, c.id))),
        "comp", async (id) => { if (!p.comps.includes(id)) await toggleComp(p, id); });
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

  for (const id of ["qSearch", "qGym", "qCat", "qComp"]) $(id).addEventListener("input", render);
  $("qSearch").addEventListener("input", () => renderEvents());

  // ---------- Filter panel ----------
  const FILTERS = ["qCat", "qGym", "qComp"];
  function syncFilterBtn() {
    const n = FILTERS.filter((id) => $(id).value).length;
    $("filterCount").textContent = String(n); $("filterCount").hidden = !n;
    $("clearFilters").hidden = !n;
    $("filterBtn").setAttribute("aria-label", n ? `Filters (${n} on)` : "Filters");
  }
  $("filterBtn").addEventListener("click", () => {
    const open = $("filters").hidden;
    $("filters").hidden = !open; $("filterBtn").setAttribute("aria-expanded", String(open));
  });
  $("clearFilters").addEventListener("click", () => { for (const id of FILTERS) $(id).value = ""; syncFilterBtn(); render(); });
  for (const id of FILTERS) $(id).addEventListener("input", syncFilterBtn);

  // ---------- PDF report ----------
  // Builds a print-only page and opens the system print dialog ("Save as PDF" / Share → Save to Files).
  function buildReport(list) {
    const r = $("report"); r.replaceChildren();
    const head = el("div", "rp-head");
    const logo = new Image(); logo.src = "assets/logo.png"; logo.alt = "Grey Athletes"; logo.className = "rp-logo";
    const meta = el("div", "rp-meta");
    const now = new Date();
    meta.append(el("div", "rp-title", "Athlete kit report"),
      el("div", "rp-sub", now.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + " · " + list.length + (list.length === 1 ? " athlete" : " athletes")));
    const filters = [$("qCat").value && "Category: " + $("qCat").value, $("qComp").value && "Competition: " + compName($("qComp").value), $("qGym").value && "Gym: " + $("qGym").value,
      $("qSearch").value.trim() && `Search: "${$("qSearch").value.trim()}"`].filter(Boolean);
    if (filters.length) meta.append(el("div", "rp-sub", filters.join(" · ")));
    head.append(logo, meta);
    r.append(head);

    // Summary chips: how many got each item
    const sum = el("div", "rp-summary");
    for (const it of items) {
      const n = list.filter((p) => p.items[it.id]).length;
      const c = el("div", "rp-chip"); c.append(el("b", null, `${n}/${list.length}`), el("span", null, it.name)); sum.append(c);
    }
    r.append(sum);

    const withPhotos = list.some((p) => photos.has(p.id));
    const t = el("table", "rp-table");
    const thead = el("thead"), hr = el("tr");
    const th = (txt, cls) => hr.append(el("th", cls || null, txt));
    th("#", "num"); if (withPhotos) th("", "ph"); th("Athlete"); th("Category"); th("Size", "c");
    for (const it of items) th(it.name, "c item");
    th("Competitions"); th("Note");
    const cols = hr.children.length;
    const spacer = (tag) => { const tr = el("tr", "rp-space"); const c = el(tag); c.colSpan = cols; tr.append(c); return tr; };
    thead.append(spacer("th"), hr); t.append(thead);
    const tfoot = el("tfoot"); tfoot.append(spacer("td")); t.append(tfoot);
    const tb = el("tbody");
    list.forEach((p, i) => {
      const tr = el("tr");
      tr.append(el("td", "num", String(i + 1)));
      if (withPhotos) {
        const td = el("td", "ph"); const ph = photos.get(p.id);
        if (ph) { const img = new Image(); img.src = ph.data; img.alt = ""; td.append(img); }
        tr.append(td);
      }
      const who = el("td", "who"); who.append(el("b", null, p.name)); if (p.gym) who.append(el("span", null, p.gym));
      tr.append(who, el("td", null, p.categories.join(", ")), el("td", "c", p.size));
      for (const it of items) { const td = el("td", "c item"); td.append(el("span", p.items[it.id] ? "yes" : "no", p.items[it.id] ? "✓" : "–")); tr.append(td); }
      tr.append(el("td", "txt", compNames(p).join(", ")), el("td", "txt", p.note));
      tb.append(tr);
    });
    t.append(tb);
    r.append(t);
    r.append(el("div", "rp-foot", "Grey Athletes · generated " + now.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })));
    return [...r.querySelectorAll("img")];
  }

  $("pdfBtn").addEventListener("click", async () => {
    if (tab === "events") { exportEvents(); return; }
    const list = filtered();
    if (!list.length) { toast("Nothing to export. Clear the filters or add athletes first."); return; }
    toast("Preparing PDF…");
    await loadPhotos();
    const imgs = buildReport(list);
    await Promise.all(imgs.map((img) => (img.complete ? null : new Promise((ok) => { img.onload = img.onerror = ok; }))));
    const oldTitle = document.title;
    document.title = "Grey Athletes - kit report - " + today();
    $("toast").hidden = true;
    try { window.print(); } catch { toast("Printing isn't available here. Open the site in Safari or Chrome."); }
    setTimeout(() => { document.title = oldTitle; }, 1000);
  });

  // ---------- Events ----------
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const isTime = (t) => /^\d{2}:\d{2}$/.test(t || "");
  function cleanEvent(e) {
    if (!e || !isDate(e.starts_on)) return null;
    return { id: String(e.id), title: str(e.title, 120) || "Untitled", starts_on: e.starts_on,
      ends_on: isDate(e.ends_on) ? e.ends_on : "", start_time: isTime(e.start_time) ? e.start_time : "",
      end_time: isTime(e.end_time) ? e.end_time : "", location: str(e.location, 200), details: str(e.details, 4000) };
  }
  const lastDay = (e) => e.ends_on || e.starts_on;
  const dayDiff = (a, b) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5);
  const dParts = (d) => { const [y, m, dd] = d.split("-").map(Number); return { y, m, d: dd }; };
  function when(e) {
    const t = today();
    if (e.starts_on <= t && lastDay(e) >= t) return e.starts_on === lastDay(e) ? "Today" : "On now";
    const n = dayDiff(e.starts_on, t);
    if (n === 1) return "Tomorrow";
    if (n > 1 && n < 7) return `In ${n} days`;
    if (n >= 7 && n < 28) return `In ${Math.round(n / 7)} week${Math.round(n / 7) === 1 ? "" : "s"}`;
    return "";
  }
  function dateText(e) {
    const a = dParts(e.starts_on), b = e.ends_on ? dParts(e.ends_on) : null;
    const wd = (d) => new Date(Date.UTC(d.y, d.m - 1, d.d)).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
    const yr = (d) => (d.y !== new Date().getFullYear() ? " " + d.y : "");
    let s1 = `${wd(a)} ${a.d} ${MONTHS[a.m - 1]}` + (b && b.y === a.y ? "" : yr(a));
    if (b) s1 += ` – ${wd(b)} ${b.d} ${MONTHS[b.m - 1]}${yr(b)}`;
    const time = e.start_time ? e.start_time + (e.end_time ? "–" + e.end_time : "") : "All day";
    return `${s1} · ${time}`;
  }
  function evMatches(e) {
    const q = $("qSearch").value.trim().toLowerCase();
    return !q || [e.title, e.location, e.details].join(" ").toLowerCase().includes(q);
  }

  function eventCard(e) {
    const c = el("article", "ev");
    const a = dParts(e.starts_on);
    const badge = el("div", "ev-date");
    badge.append(el("b", null, e.ends_on && dParts(e.ends_on).m === a.m ? `${a.d}–${dParts(e.ends_on).d}` : String(a.d)), el("span", null, MONTHS[a.m - 1]));
    const body = el("div", "ev-body");
    const top = el("div", "ev-top");
    top.append(el("h3", "ev-title", e.title));
    const w = when(e); if (w) top.append(el("span", "ev-when" + (w === "Today" || w === "On now" ? " now" : ""), w));
    body.append(top, el("div", "ev-meta", dateText(e)));
    if (e.location) body.append(el("div", "ev-loc", e.location));
    if (e.details) { const d = el("p", "ev-details", e.details); body.append(d); d.addEventListener("click", () => d.classList.toggle("open")); }
    const edit = btn("btn-sm ev-edit", "Edit", () => openEvSheet(e));
    body.append(edit);
    c.append(badge, body);
    return c;
  }

  function renderEvents() {
    if (tab === "events") {
      const t = today();
      const list = events.filter(evMatches);
      const up = list.filter((e) => lastDay(e) >= t), past = list.filter((e) => lastDay(e) < t).reverse();
      const next = up[0];
      $("count").textContent = !evLoaded ? "" : `${up.length} upcoming ${up.length === 1 ? "event" : "events"}` + (next ? ` · next ${(when(next) || "on " + dateText(next).split(" · ")[0]).replace(/^In /, "in ").replace(/^Today$/, "today").replace(/^Tomorrow$/, "tomorrow").replace(/^On now$/, "on now")}` : "");
      const box = $("evList"); box.replaceChildren();
      if (!evLoaded) {
        const e = el("div", "empty"); e.append(el("b", null, "Events aren't set up yet"), el("span", null, "The database needs its events update first."));
        box.append(e);
      } else if (!up.length) {
        const e = el("div", "empty"); e.append(el("b", null, list.length < events.length ? "No matching events" : "No upcoming events"), el("span", null, "Tap + Add to add one."));
        box.append(e);
      }
      let month = "";
      for (const e of up) {
        const p = dParts(e.starts_on), key = `${p.y}-${p.m}`;
        if (key !== month) { month = key; box.append(el("div", "group-head", new Date(Date.UTC(p.y, p.m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }))); }
        box.append(eventCard(e));
      }
      $("pastBtn").hidden = !past.length;
      $("pastBtn").textContent = showPast ? "Hide past events" : `Show past events (${past.length})`;
      const pb = $("evPast"); pb.hidden = !showPast || !past.length; pb.replaceChildren(...(showPast ? past.map(eventCard) : []));
    }
    $("locList").replaceChildren(...[...new Set(events.map((e) => e.location).filter(Boolean))].sort().map((v) => new Option(v)));
  }
  $("pastBtn").addEventListener("click", () => { showPast = !showPast; renderEvents(); });

  // Tabs
  function setTab(next) {
    tab = next;
    try { localStorage.setItem("kitlog.tab", tab); } catch { /* ignore */ }
    $("tabAthletes").setAttribute("aria-selected", String(tab === "athletes"));
    $("tabEvents").setAttribute("aria-selected", String(tab === "events"));
    $("athletesView").hidden = tab !== "athletes";
    $("eventsView").hidden = tab !== "events";
    $("filterBtn").hidden = tab !== "athletes";
    if (tab !== "athletes") { $("filters").hidden = true; $("filterBtn").setAttribute("aria-expanded", "false"); }
    $("qSearch").placeholder = tab === "events" ? "Search events, places…" : "Search athletes, gyms…";
    $("addBtn").setAttribute("aria-label", tab === "events" ? "Add event" : "Add athlete");
    if (tab === "athletes") render(); else renderEvents();
  }
  $("tabAthletes").addEventListener("click", () => setTab("athletes"));
  $("tabEvents").addEventListener("click", () => setTab("events"));
  try { if (localStorage.getItem("kitlog.tab") === "events") setTab("events"); } catch { /* ignore */ }

  // Event form
  function syncAllDay() { $("eTimes").hidden = $("eAllDay").checked; }
  $("eAllDay").addEventListener("change", syncAllDay);
  function openEvSheet(e) {
    if (!evLoaded) { toast("Events aren't set up in the database yet."); return; }
    evEditingId = e ? e.id : null; evArmedDelete = false;
    $("evTitle").textContent = e ? "Edit event" : "Add event";
    $("eTitle").value = e ? e.title : "";
    $("eStart").value = e ? e.starts_on : today();
    $("eEnd").value = e ? e.ends_on : "";
    $("eAllDay").checked = e ? !e.start_time : true;
    $("eStartTime").value = e ? e.start_time : "";
    $("eEndTime").value = e ? e.end_time : "";
    $("eLocation").value = e ? e.location : "";
    $("eDetails").value = e ? e.details : "";
    $("evDelete").hidden = !e; $("evDelete").textContent = "Delete event";
    $("evMsg").textContent = "";
    syncAllDay();
    $("toast").hidden = true;
    $("evSheet").hidden = false; document.body.classList.add("locked");
    if (!e) setTimeout(() => $("eTitle").focus(), 50);
  }
  function closeEvSheet() { $("evSheet").hidden = true; evEditingId = null; if ($("sheet").hidden && $("manage").hidden && $("bulk").hidden) document.body.classList.remove("locked"); }
  $("evClose").addEventListener("click", closeEvSheet);
  $("evSheet").addEventListener("click", (e) => { if (e.target === $("evSheet")) closeEvSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("evSheet").hidden) closeEvSheet(); });

  $("evForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const allDay = $("eAllDay").checked;
    const data = {
      title: str($("eTitle").value, 120), starts_on: $("eStart").value, ends_on: isDate($("eEnd").value) ? $("eEnd").value : "",
      start_time: !allDay && isTime($("eStartTime").value) ? $("eStartTime").value : "",
      end_time: !allDay && isTime($("eEndTime").value) ? $("eEndTime").value : "",
      location: str($("eLocation").value, 200), details: str($("eDetails").value, 4000),
    };
    if (!data.title) { $("evMsg").textContent = "Enter the event name."; $("eTitle").focus(); return; }
    if (!isDate(data.starts_on)) { $("evMsg").textContent = "Pick a date."; $("eStart").focus(); return; }
    if (data.ends_on && data.ends_on < data.starts_on) { $("evMsg").textContent = "The end date is before the start date."; $("eEnd").focus(); return; }
    if (!allDay && !data.start_time) { $("evMsg").textContent = "Pick a start time, or switch on All day."; $("eStartTime").focus(); return; }
    const b = $("evSave"); b.disabled = true;
    try {
      await call("save_event", { p_id: evEditingId, p_data: data });
      toast((evEditingId ? "Saved " : "Added ") + data.title);
      closeEvSheet(); load();
    } catch (err) { if (err.code !== "locked") $("evMsg").textContent = errorText(err); }
    finally { b.disabled = false; }
  });
  $("evDelete").addEventListener("click", async () => {
    if (!evArmedDelete) { evArmedDelete = true; $("evDelete").textContent = "Tap again to delete"; return; }
    try { await call("delete_event", { p_id: evEditingId }); toast("Deleted"); closeEvSheet(); load(); }
    catch (err) { if (err.code !== "locked") $("evMsg").textContent = errorText(err); }
  });

  // Events PDF
  function exportEvents() {
    const t = today();
    const list = events.filter(evMatches).filter((e) => showPast || lastDay(e) >= t);
    if (!list.length) { toast("No events to export."); return; }
    const r = $("report"); r.replaceChildren();
    const head = el("div", "rp-head");
    const logo = new Image(); logo.src = "assets/logo.png"; logo.alt = "Grey Athletes"; logo.className = "rp-logo";
    const meta = el("div", "rp-meta");
    meta.append(el("div", "rp-title", "Upcoming events"), el("div", "rp-sub", new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }) + ` · ${list.length} ${list.length === 1 ? "event" : "events"}`));
    head.append(logo, meta); r.append(head);
    const tbl = el("table", "rp-table"), thead = el("thead"), hr = el("tr");
    for (const [txt, cls] of [["Date"], ["Time", "c"], ["Event"], ["Location"], ["Details"]]) hr.append(el("th", cls || null, txt));
    const spacer = (tag) => { const tr = el("tr", "rp-space"); const c = el(tag); c.colSpan = 5; tr.append(c); return tr; };
    thead.append(spacer("th"), hr); tbl.append(thead);
    const tb = el("tbody");
    for (const e of list) {
      const tr = el("tr");
      const [d, tm] = dateText(e).split(" · ");
      tr.append(el("td", "nowrap", d), el("td", "c nowrap", tm), el("td", "who", e.title), el("td", null, e.location), el("td", "txt", e.details));
      tb.append(tr);
    }
    const tf = el("tfoot"); tf.append(spacer("td"));
    tbl.append(tb, tf); r.append(tbl);
    r.append(el("div", "rp-foot", "Grey Athletes · generated " + new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })));
    const oldTitle = document.title; document.title = "Grey Athletes - events - " + today();
    const go = () => { try { window.print(); } catch { toast("Printing isn't available here. Open the site in Safari or Chrome."); } setTimeout(() => { document.title = oldTitle; }, 1000); };
    logo.complete ? go() : (logo.onload = logo.onerror = go);
  }

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
