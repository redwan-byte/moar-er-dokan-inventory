import { applyOp, emptyState, normalizeState } from "./logic.js";

const DATA_KEY = "moar-er-dokan:data";
const PREFS_KEY = "moar-er-dokan:prefs";
const PIN_KEY = "moar-er-dokan:pin";
const TABS = ["stock", "sell", "history", "settings"];
const RANGES = [["today", "Today"], ["7", "Last 7 days"], ["month", "This month"], ["last", "Last month"], ["all", "All time"]];

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const money = (n) => `৳ ${fmt(n)}`;
const round = (n) => Math.round(n * 100) / 100;
const sum = (list, key) => list.reduce((t, x) => t + (Number(x[key]) || 0), 0);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const pad = (n) => String(n).padStart(2, "0");
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dayStr(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dayStr(d); };
const byName = (a, z) => a.name.localeCompare(z.name);
const newestFirst = (a, z) => z.date.localeCompare(a.date) || String(z.createdAt).localeCompare(String(a.createdAt));
const options = (list, selected) => list.map((v) => `<option value="${esc(v)}"${v === selected ? " selected" : ""}>${esc(v)}</option>`).join("");

function niceDate(s) {
  const opts = { day: "numeric", month: "short" };
  if (s.slice(0, 4) !== today().slice(0, 4)) opts.year = "numeric";
  return new Date(`${s}T00:00`).toLocaleDateString("en-GB", opts);
}

function stamp(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${dayStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// localStorage can be full or blocked (private mode), so never let it throw.
const saved = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* nothing to do */ }
  },
};

const ICON = {
  search: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  trash: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>`,
};

/* ---------- state ---------- */
const prefs = { branch: "all", soldBy: "", range: "month", log: "sales", cloud: false, ...saved.get(PREFS_KEY, {}) };
const savePrefs = () => saved.set(PREFS_KEY, prefs);
const ui = { search: "", filter: "all" };
const draft = { date: today(), dateTouched: false, branch: "", soldBy: prefs.soldBy, buyer: "", productId: "", qty: "1", amount: "", amountEdited: false };
const db = { mode: "loading", state: emptyState(), etag: "", online: true, saving: false, rev: 0, error: "", pin: saved.get(PIN_KEY, "") };

const S = () => db.state;
const branches = () => S().settings.branches;
const productById = (id) => S().products.find((p) => p.id === id);
const viewBranch = () => (branches().includes(prefs.branch) ? prefs.branch : "all");
const lowAt = (p) => p.lowAt ?? S().settings.lowStock;
const qtyAt = (p, b) => (b === "all" ? branches().reduce((t, x) => t + (p.stock[x] || 0), 0) : p.stock[b] || 0);
const levelOf = (qty, p) => (qty <= 0 ? "out" : qty <= lowAt(p) ? "low" : "ok");
const currentTab = () => (TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "stock");

function statusOf(p, b) {
  if (b !== "all") return levelOf(qtyAt(p, b), p);
  const levels = branches().map((x) => levelOf(p.stock[x] || 0, p));
  return levels.includes("out") ? "out" : levels.includes("low") ? "low" : "ok";
}

/* ---------- saving & syncing ----------
   If the site has the Netlify Function (/api), everyone shares one inventory.
   Otherwise (e.g. a drag-and-drop deploy) data is kept in this browser. */
function api(path, body) {
  return fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-shop-pin": db.pin || "" },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
}

function useLocal() {
  db.mode = "local";
  db.state = normalizeState(saved.get(DATA_KEY, null));
  render();
}

function showError(message) {
  db.mode = "error";
  db.error = message;
  render();
}

function setRemote(body) {
  db.state = normalizeState(body.state);
  db.etag = body.etag || "";
}

async function connect() {
  db.mode = "loading";
  render();
  let res;
  try {
    res = await api("/api/state");
  } catch {
    return prefs.cloud ? showError("Can't reach the shared inventory. Check the internet connection and try again.") : useLocal();
  }
  if (res.status === 401) {
    const hadPin = Boolean(db.pin);
    db.mode = "locked";
    render();
    if (await askPin(hadPin)) connect();
    return;
  }
  const isJson = (res.headers.get("content-type") || "").includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;
  if (res.ok && body && body.state) {
    db.mode = "cloud";
    db.online = true;
    setRemote(body);
    if (!prefs.cloud) { prefs.cloud = true; savePrefs(); }
    return render();
  }
  if (isJson || prefs.cloud) return showError(body?.error || `The shared inventory didn't answer (error ${res.status}). Try again in a moment.`);
  useLocal();
}

async function refresh() {
  if (db.mode !== "cloud" || db.saving || document.hidden) return;
  const rev = db.rev;
  try {
    const res = await api(`/api/state?etag=${encodeURIComponent(db.etag)}`);
    if (res.status === 401) return connect();
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    if (rev !== db.rev || db.saving) return; // a save finished meanwhile and its answer is newer
    const wasOffline = !db.online;
    db.online = true;
    if (!body.unchanged) { setRemote(body); renderSoon(); } else if (wasOffline) renderChrome();
  } catch {
    if (db.online) { db.online = false; renderChrome(); }
  }
}

async function dispatch(op) {
  let next;
  try {
    next = applyOp(S(), op); // check it here first for an instant answer
  } catch (err) {
    toast(err.message, "error");
    return false;
  }

  if (db.mode === "local") {
    if (!saved.set(DATA_KEY, next)) {
      toast("Couldn't save on this device — browser storage is full or blocked.", "error");
      return false;
    }
    db.state = next;
    render();
    return true;
  }
  if (db.mode !== "cloud") return false;

  db.saving = true;
  db.rev++;
  renderChrome();
  try {
    const res = await api("/api/op", op);
    if (res.status === 401) {
      setTimeout(connect);
      throw new Error("The shop PIN has changed. Enter it again, then retry.");
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.state) throw new Error(body.error || `Couldn't save (error ${res.status}). Try again.`);
    setRemote(body);
    db.online = true;
    return true;
  } catch (err) {
    const offline = err instanceof TypeError; // fetch() itself failed
    if (offline) db.online = false;
    toast(offline ? "No connection — that was NOT saved. Try again." : err.message, "error");
    return false;
  } finally {
    db.saving = false;
    render();
  }
}

/* ---------- rendering ---------- */
let renderPending = false;

// Background updates wait until nobody is typing in the page.
function renderSoon() {
  const active = document.activeElement;
  if (active && $("#view").contains(active) && active.matches("input, select, textarea")) {
    renderPending = true;
    renderChrome();
    return;
  }
  render();
}

function render() {
  renderPending = false;
  renderChrome();
  const view = $("#view");
  if (db.mode === "loading") {
    view.innerHTML = `<section class="card note">Loading…</section>`;
  } else if (db.mode === "locked") {
    view.innerHTML = messageCard("This inventory is locked", "Enter the shop PIN to see stock and record sales.", `<button class="btn primary" data-act="retry">Enter PIN</button>`);
  } else if (db.mode === "error") {
    view.innerHTML = messageCard("Not connected", db.error, `<button class="btn primary" data-act="retry">Try again</button>`);
  } else {
    const tab = currentTab();
    view.innerHTML = { stock: viewStock, sell: viewSell, history: viewHistory, settings: viewSettings }[tab]();
    if (tab === "stock") renderStockList();
    if (tab === "sell") updateSellHints();
  }
}

function renderChrome() {
  const tab = currentTab();
  for (const a of document.querySelectorAll("#tabs [data-tab]")) {
    a.classList.toggle("active", a.dataset.tab === tab);
    if (a.dataset.tab === tab) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }

  const pick = $("#branchPick");
  const html = `<option value="all">All branches</option>${options(branches(), viewBranch())}`;
  if (pick.dataset.html !== html) { pick.innerHTML = html; pick.dataset.html = html; }
  pick.value = viewBranch();

  const [cls, label] =
    db.mode === "cloud" ? (db.saving ? ["", "Saving…"] : db.online ? ["good", "Shared · up to date"] : ["bad", "Offline · not syncing"])
    : db.mode === "local" ? ["local", "Saved on this device only"]
    : db.mode === "error" ? ["bad", "Not connected"]
    : db.mode === "locked" ? ["", "Locked"]
    : ["", "Connecting…"];
  const pill = $("#sync");
  pill.className = `sync ${cls}`;
  pill.innerHTML = `<i></i>${label}`;
}

const messageCard = (title, text, actions = "") =>
  `<section class="card empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${actions}</section>`;

const tile = (label, value, sub = "", cls = "") =>
  `<div class="stat ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;

/* ---------- Stock tab ---------- */
function viewStock() {
  const st = S();
  if (!st.products.length) {
    return messageCard(
      "No items yet",
      "Add what Moar er Dokan sells — snacks, drinks, stationery — and how many you have at each branch.",
      `<button class="btn primary" data-act="newItem">+ Add first item</button>`,
    );
  }
  const b = viewBranch();
  const t = today();
  const soldToday = st.sales.filter((x) => x.date === t && (b === "all" || x.branch === b));
  let units = 0, low = 0, out = 0;
  for (const p of st.products) {
    units += Math.max(0, qtyAt(p, b));
    const s = statusOf(p, b);
    if (s === "low") low++;
    if (s === "out") out++;
  }
  return `
    <section class="stats">
      ${tile("Items", fmt(st.products.length))}
      ${tile("Units in stock", fmt(units))}
      ${tile("Low · Out", `${low} · ${out}`, low + out ? "need restocking" : "all good", low + out ? "warn" : "")}
      ${tile("Sold today", money(sum(soldToday, "amount")), `${soldToday.length} sale${soldToday.length === 1 ? "" : "s"}`)}
    </section>
    <section class="card list-card">
      <div class="toolbar">
        <div class="search">${ICON.search}<input id="search" type="search" placeholder="Search items" value="${esc(ui.search)}" aria-label="Search items"></div>
        <div class="seg" role="group" aria-label="Show">
          <button type="button" data-act="filter" data-v="all" class="${ui.filter === "all" ? "on" : ""}">All</button>
          <button type="button" data-act="filter" data-v="low" class="${ui.filter === "low" ? "on" : ""}">Running low</button>
        </div>
        <button class="btn primary" data-act="newItem">+ New item</button>
      </div>
      <div id="stockList"></div>
    </section>`;
}

function renderStockList() {
  const box = $("#stockList");
  if (!box) return;
  const b = viewBranch();
  const q = ui.search.trim().toLowerCase();
  const list = S().products
    .filter((p) => !q || p.name.toLowerCase().includes(q) || (p.category || "").toLowerCase().includes(q))
    .filter((p) => ui.filter === "all" || statusOf(p, b) !== "ok")
    .sort(byName);
  box.innerHTML = list.length
    ? list.map((p) => itemRow(p, b)).join("")
    : `<p class="none">${q ? "No items match your search." : "Nothing is running low."}</p>`;
}

function itemRow(p, b) {
  const multi = b === "all" && branches().length > 1;
  const status = statusOf(p, b);
  let badge = "";
  let breakdown = "";
  if (multi) {
    const count = (lvl) => branches().filter((x) => levelOf(p.stock[x] || 0, p) === lvl).length;
    const outs = count("out");
    const lows = count("low");
    const plural = (n) => `${n} branch${n > 1 ? "es" : ""}`;
    if (outs) badge = `<span class="badge out">Out at ${plural(outs)}</span>`;
    else if (lows) badge = `<span class="badge low">Low at ${plural(lows)}</span>`;
    breakdown = `<div class="breakdown">${branches()
      .map((x) => `<span>${esc(x)} <b class="${levelOf(p.stock[x] || 0, p)}">${fmt(p.stock[x] || 0)}</b></span>`)
      .join("")}</div>`;
  } else if (status !== "ok") {
    badge = `<span class="badge ${status}">${status === "out" ? "Out" : "Low"}</span>`;
  }
  const meta = [p.category, money(p.price)].filter(Boolean).map(esc).join(" · ");
  const id = esc(p.id);
  return `
    <div class="row">
      <div class="row-main">
        <div class="row-title">${esc(p.name)}</div>
        <div class="row-meta">${meta}</div>
        ${breakdown}
      </div>
      <div class="row-qty ${multi ? "" : status}"><b>${fmt(qtyAt(p, b))}</b><span>${multi ? "total" : "in stock"}</span>${badge}</div>
      <div class="row-actions">
        <button class="btn small" data-act="sellItem" data-id="${id}">Sell</button>
        <button class="btn small" data-act="restock" data-id="${id}">+ Stock</button>
        <button class="btn small link" data-act="editItem" data-id="${id}">Edit</button>
      </div>
    </div>`;
}

function openItemDialog(p) {
  const isNew = !p;
  const cats = [...new Set(S().products.map((x) => x.category).filter(Boolean))].sort();
  openModal({
    title: isNew ? "New item" : "Edit item",
    body: `
      <label class="field"><span>Item name <i>*</i></span>
        <input name="name" value="${esc(p?.name)}" placeholder="e.g. Coca-Cola 250ml" maxlength="80" required${isNew ? " autofocus" : ""}></label>
      <div class="grid2">
        <label class="field"><span>Category</span>
          <input name="category" list="catList" value="${esc(p?.category)}" placeholder="e.g. Drinks" maxlength="40">
          <datalist id="catList">${options(cats)}</datalist></label>
        <label class="field"><span>Selling price (৳) <i>*</i></span>
          <input name="price" type="number" min="0" step="any" inputmode="decimal" value="${esc(p?.price)}" required></label>
      </div>
      <label class="field"><span>Low-stock alert</span>
        <input name="lowAt" type="number" min="0" step="1" inputmode="numeric" value="${esc(p?.lowAt)}" placeholder="Default: ${S().settings.lowStock}">
        <small>Mark as “Low” when this many or fewer are left.</small></label>
      <fieldset class="stock-set">
        <legend>${isNew ? "Opening stock" : "Stock count"}</legend>
        ${isNew ? "" : "<small>Change these only after counting. For a new delivery, use “+ Stock”.</small>"}
        ${branches()
          .map((b) => `<label class="field inline"><span>${esc(b)}</span>
            <input type="number" step="any" min="0" inputmode="decimal" data-branch="${esc(b)}" value="${p ? esc(p.stock[b] ?? 0) : ""}" placeholder="0"></label>`)
          .join("")}
      </fieldset>`,
    submit: isNew ? "Add item" : "Save",
    left: isNew ? "" : `<button type="button" class="btn danger" data-act="deleteItem" data-id="${esc(p.id)}">Delete</button>`,
    async onSubmit(fd, form) {
      // Send only the counts that were changed, so a sale made meanwhile isn't overwritten.
      const stockSet = {};
      for (const input of form.querySelectorAll("[data-branch]")) {
        const b = input.dataset.branch;
        const v = input.value.trim();
        const before = isNew ? undefined : (productById(p.id)?.stock[b] ?? 0);
        if (v !== "" && Number(v) !== before) stockSet[b] = v;
      }
      const ok = await dispatch({
        type: "saveProduct",
        product: { id: p?.id || uid(), name: fd.get("name"), category: fd.get("category"), price: fd.get("price"), lowAt: fd.get("lowAt") },
        stockSet,
      });
      if (ok) toast(isNew ? `Added “${String(fd.get("name")).trim()}”.` : "Saved.");
      return ok;
    },
  });
}

function openRestock(p) {
  const b0 = viewBranch() !== "all" ? viewBranch() : branches()[0];
  openModal({
    title: "Add stock",
    lead: `<p class="modal-lead"><b>${esc(p.name)}</b> · <span id="restockNow"></span></p>`,
    body: `
      <div class="grid2">
        <label class="field"><span>Branch <i>*</i></span><select name="branch" required>${options(branches(), b0)}</select></label>
        <label class="field"><span>Quantity added <i>*</i></span>
          <input name="qty" type="number" min="0.01" step="any" inputmode="decimal" required autofocus></label>
        <label class="field"><span>Date <i>*</i></span><input name="date" type="date" value="${today()}" required></label>
        <label class="field"><span>Added by</span><input name="by" value="${esc(prefs.soldBy)}" maxlength="60"></label>
      </div>
      <label class="field"><span>Note</span><input name="note" maxlength="120" placeholder="Supplier, invoice no. …"></label>`,
    submit: "Add stock",
    onOpen(m) {
      const update = () => {
        const now = productById(p.id)?.stock[m.querySelector("[name=branch]").value] || 0;
        const add = Number(m.querySelector("[name=qty]").value) || 0;
        $("#restockNow").textContent = add > 0 ? `${fmt(now)} now → ${fmt(now + add)} after` : `${fmt(now)} in stock now`;
      };
      m.oninput = update;
      update();
    },
    async onSubmit(fd) {
      const ok = await dispatch({
        type: "stockIn",
        entry: { id: uid(), productId: p.id, branch: fd.get("branch"), qty: fd.get("qty"), date: fd.get("date"), by: fd.get("by"), note: fd.get("note") },
      });
      if (ok) toast(`Added ${fmt(fd.get("qty"))} × ${p.name} at ${fd.get("branch")}.`);
      return ok;
    },
  });
}

/* ---------- Sell tab (same questions as the Google Form) ---------- */
function syncDraft() {
  if (!branches().includes(draft.branch)) draft.branch = viewBranch() !== "all" ? viewBranch() : branches()[0];
  if (!S().settings.buyers.includes(draft.buyer)) draft.buyer = "";
  if (!productById(draft.productId)) draft.productId = "";
  if (!draft.dateTouched) draft.date = today();
}

function itemOptions() {
  const label = (p) => `${esc(p.name)} — ${money(p.price)} · ${fmt(p.stock[draft.branch] || 0)} left`;
  const opt = (p) => `<option value="${esc(p.id)}"${p.id === draft.productId ? " selected" : ""}>${label(p)}</option>`;
  const groups = new Map();
  for (const p of [...S().products].sort(byName)) {
    const c = p.category || "Other";
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(p);
  }
  const names = [...groups.keys()].sort((a, z) => (a === "Other") - (z === "Other") || a.localeCompare(z));
  const body = groups.size > 1
    ? names.map((c) => `<optgroup label="${esc(c)}">${groups.get(c).map(opt).join("")}</optgroup>`).join("")
    : [...groups.values()].flat().map(opt).join("");
  return `<option value="">Choose</option>${body}`;
}

function viewSell() {
  const st = S();
  if (!st.products.length) {
    return messageCard("Nothing to sell yet", "Add items on the Stock tab first, then record sales here.", `<a class="btn primary" href="#stock">Go to Stock</a>`);
  }
  syncDraft();
  const sellers = [...new Set(st.sales.slice(-300).map((x) => x.soldBy))];
  return `
    <form class="card" id="sellForm" novalidate autocomplete="off">
      <div class="form-head">
        <h2>Sale entry</h2>
        <p>Fill this in every time something is sold. <span class="req">* Required</span></p>
      </div>
      <div class="grid2">
        <label class="field"><span>Sale Date <i>*</i></span><input type="date" name="date" value="${esc(draft.date)}" required></label>
        <label class="field"><span>Branch <i>*</i></span><select name="branch" required>${options(branches(), draft.branch)}</select></label>
        <label class="field"><span>Sold By <i>*</i></span>
          <input name="soldBy" list="sellerList" value="${esc(draft.soldBy)}" placeholder="Your name" maxlength="60" required>
          <datalist id="sellerList">${options(sellers)}</datalist></label>
        <label class="field"><span>Who Bought it? <i>*</i></span>
          <select name="buyer" required><option value="">Choose</option>${options(st.settings.buyers, draft.buyer)}</select></label>
      </div>
      <label class="field"><span>Item <i>*</i></span><select name="productId" id="sellItem" required>${itemOptions()}</select></label>
      <p class="hint" id="sellLeft"></p>
      <div class="grid2">
        <div class="field">
          <label class="field-label" for="sellQty">Quantity <i>*</i></label>
          <div class="stepper">
            <button type="button" data-act="qty" data-step="-1" aria-label="One less">−</button>
            <input id="sellQty" type="number" name="qty" min="0.01" step="any" inputmode="decimal" value="${esc(draft.qty)}" required>
            <button type="button" data-act="qty" data-step="1" aria-label="One more">+</button>
          </div>
        </div>
        <label class="field"><span>Bill Amount (৳) <i>*</i></span>
          <input type="number" name="amount" min="0" step="any" inputmode="decimal" value="${esc(draft.amount)}" placeholder="0" required>
          <small id="amountHint"></small></label>
      </div>
      <div class="form-actions">
        <button class="btn primary big" type="submit">Submit</button>
        <button class="btn link" type="button" data-act="clearSell">Clear form</button>
      </div>
    </form>
    <div id="todayBox">${todayCard()}</div>`;
}

function todayCard() {
  const t = today();
  const list = S().sales.filter((x) => x.date === t && x.branch === draft.branch).sort(newestFirst);
  if (!list.length) return "";
  return `
    <section class="card list-card">
      <div class="card-title"><h2>Today at ${esc(draft.branch)}</h2>
        <span class="muted">${list.length} sale${list.length === 1 ? "" : "s"} · ${money(sum(list, "amount"))}</span></div>
      ${list.slice(0, 8).map((x) => saleRow(x, false)).join("")}
      ${list.length > 8 ? `<p class="more"><a href="#history">See all in History</a></p>` : ""}
    </section>`;
}

const autoAmount = () => {
  const p = productById(draft.productId);
  const q = Number(draft.qty);
  return p && q > 0 ? round(p.price * q) : null;
};

function fillAmount() {
  const a = autoAmount();
  draft.amount = a == null ? "" : String(a);
  const input = $("#sellForm [name=amount]");
  if (input) input.value = draft.amount;
}

function onSellInput(el) {
  const { name, value } = el;
  if (name === "date") { draft.date = value; draft.dateTouched = true; }
  else if (name === "amount") { draft.amount = value; draft.amountEdited = value !== ""; }
  else if (name in draft) draft[name] = value;
  if (name === "productId") draft.amountEdited = false;
  if (name === "branch") {
    $("#sellItem").innerHTML = itemOptions();
    $("#todayBox").innerHTML = todayCard();
  }
  if (!draft.amountEdited && (name === "productId" || name === "qty")) fillAmount();
  updateSellHints();
}

function updateSellHints() {
  const left = $("#sellLeft");
  const hint = $("#amountHint");
  if (!left || !hint) return;
  const p = productById(draft.productId);
  if (!p) { left.className = "hint"; left.textContent = ""; hint.textContent = ""; return; }
  const n = p.stock[draft.branch] || 0;
  const lvl = levelOf(n, p);
  left.className = `hint ${lvl}`;
  left.textContent = `${fmt(n)} left at ${draft.branch}${lvl === "out" ? " — out of stock" : lvl === "low" ? " — running low" : ""}`;
  const auto = autoAmount();
  if (auto == null) hint.textContent = "";
  else if (draft.amountEdited && Number(draft.amount) !== auto) hint.innerHTML = `Price list says ${money(auto)} · <button type="button" class="linkish" data-act="useAuto">use that</button>`;
  else hint.textContent = `${money(p.price)} × ${fmt(draft.qty)} = ${money(auto)}`;
}

let selling = false;
async function submitSale(form) {
  if (selling) return;
  for (const key of ["date", "branch", "soldBy", "buyer", "productId", "qty", "amount"]) draft[key] = form.elements[key].value;
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const p = productById(draft.productId);
  const qty = Number(draft.qty);
  const left = p.stock[draft.branch] || 0;
  if (qty > left && !confirm(`Only ${fmt(left)} × ${p.name} left at ${draft.branch}.\nSave this sale anyway?`)) return;
  selling = true;
  const ok = await dispatch({
    type: "sale",
    sale: { id: uid(), date: draft.date, branch: draft.branch, soldBy: draft.soldBy, buyer: draft.buyer, productId: p.id, qty: draft.qty, amount: draft.amount },
  });
  selling = false;
  if (!ok) return;
  prefs.soldBy = draft.soldBy.trim();
  savePrefs();
  const now = productById(p.id)?.stock[draft.branch] ?? 0;
  toast(`Saved — ${p.name} × ${fmt(qty)}, ${money(draft.amount)}. ${fmt(now)} left at ${draft.branch}.`);
  Object.assign(draft, { productId: "", qty: "1", amount: "", amountEdited: false });
  render();
}

/* ---------- History tab ---------- */
function rangeDates() {
  const t = today();
  switch (prefs.range) {
    case "today": return [t, t];
    case "7": return [daysAgo(6), t];
    case "last": {
      const d = new Date();
      const first = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const last = new Date(d.getFullYear(), d.getMonth(), 0);
      return [dayStr(first), dayStr(last)];
    }
    case "all": return ["0000-00-00", "9999-99-99"];
    default: return [`${t.slice(0, 8)}01`, t];
  }
}

function historyRows() {
  const [from, to] = rangeDates();
  const b = viewBranch();
  const list = prefs.log === "stockIns" ? S().stockIns : S().sales;
  return list.filter((x) => x.date >= from && x.date <= to && (b === "all" || x.branch === b)).sort(newestFirst);
}

function topItems(rows) {
  const totals = new Map();
  for (const x of rows) totals.set(x.item, (totals.get(x.item) || 0) + x.qty);
  return [...totals].sort((a, z) => z[1] - a[1]).slice(0, 3).map(([name, q]) => `${esc(name)} ×${fmt(q)}`).join(", ");
}

function viewHistory() {
  const isSales = prefs.log !== "stockIns";
  const rows = historyRows();
  const showBranch = viewBranch() === "all" && branches().length > 1;
  const units = sum(rows, "qty");
  const summary = isSales
    ? `<span><b>${fmt(rows.length)}</b> sale${rows.length === 1 ? "" : "s"}</span><span><b>${fmt(units)}</b> items sold</span><span>Total <b>${money(sum(rows, "amount"))}</b></span>${rows.length ? `<span class="muted">Top: ${topItems(rows)}</span>` : ""}`
    : `<span><b>${fmt(rows.length)}</b> deliver${rows.length === 1 ? "y" : "ies"}</span><span><b>${fmt(units)}</b> units added</span>`;
  const seg = [["sales", "Sales"], ["stockIns", "Stock added"]]
    .map(([v, l]) => `<button type="button" data-act="log" data-v="${v}" class="${(isSales ? "sales" : "stockIns") === v ? "on" : ""}">${l}</button>`)
    .join("");
  const period = RANGES.find(([v]) => v === prefs.range)?.[1].toLowerCase() || "this period";
  return `
    <section class="card list-card">
      <div class="filters">
        <div class="seg" role="group" aria-label="Show">${seg}</div>
        <select id="rangePick" class="auto" aria-label="Period">${RANGES.map(([v, l]) => `<option value="${v}"${prefs.range === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="spacer"></span>
        <button class="btn small" data-act="exportLog"${rows.length ? "" : " disabled"}>Download CSV</button>
      </div>
      <div class="summary">${summary}</div>
      ${rows.length
        ? rows.slice(0, 200).map((x) => (isSales ? saleRow(x, showBranch) : stockInRow(x, showBranch))).join("")
        : `<p class="none">Nothing recorded for ${esc(period)}.</p>`}
      ${rows.length > 200 ? `<p class="more">Showing the latest 200 of ${fmt(rows.length)}. Download the CSV for everything.</p>` : ""}
    </section>`;
}

function saleRow(x, showBranch) {
  const meta = [x.buyer, `by ${x.soldBy}`, showBranch && x.branch].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="log">
      <div class="log-date">${niceDate(x.date)}</div>
      <div><b>${esc(x.item)}</b> × ${fmt(x.qty)}<div class="muted">${meta}</div></div>
      <div class="log-amt">${money(x.amount)}</div>
      <button class="icon-btn" data-act="delSale" data-id="${esc(x.id)}" title="Delete this sale" aria-label="Delete sale of ${esc(x.item)}">${ICON.trash}</button>
    </div>`;
}

function stockInRow(x, showBranch) {
  const meta = [x.note, x.by && `by ${x.by}`, showBranch && x.branch].filter(Boolean).map(esc).join(" · ");
  return `
    <div class="log">
      <div class="log-date">${niceDate(x.date)}</div>
      <div><b>${esc(x.item)}</b>${meta ? `<div class="muted">${meta}</div>` : ""}</div>
      <div class="log-amt plus">+${fmt(x.qty)}</div>
      <button class="icon-btn" data-act="delStockIn" data-id="${esc(x.id)}" title="Delete this entry" aria-label="Delete stock entry for ${esc(x.item)}">${ICON.trash}</button>
    </div>`;
}

/* ---------- Settings tab ---------- */
function viewSettings() {
  const st = S();
  const chips = (list, act) => `<div class="chips">${list
    .map((v) => `<span class="chip">${esc(v)}<button type="button" data-act="${act}" data-v="${esc(v)}" aria-label="Remove ${esc(v)}">×</button></span>`)
    .join("")}</div>`;
  const mode = db.mode === "cloud"
    ? `<div class="mode">Shared online — every phone and computer that opens this site sees the same stock and sales.</div>`
    : `<div class="mode local">Saved in this browser only, so other phones won't see these numbers. To share one inventory between branches, deploy the full project folder to Netlify (see README.md), then use “Restore from backup” there to bring this data across.</div>`;
  return `
    <section class="card">
      <h2>Branches</h2>
      <p>Each branch keeps its own stock count.</p>
      ${chips(st.settings.branches, "removeBranch")}
      <form class="inline-add" data-form="addBranch">
        <input name="v" placeholder="New branch name" maxlength="60" required aria-label="New branch name">
        <button class="btn" type="submit">Add</button>
      </form>
    </section>
    <section class="card">
      <h2>“Who Bought it?” options</h2>
      <p>The choices shown in the sale entry form.</p>
      ${chips(st.settings.buyers, "removeBuyer")}
      <form class="inline-add" data-form="addBuyer">
        <input name="v" placeholder="New option" maxlength="60" required aria-label="New buyer option">
        <button class="btn" type="submit">Add</button>
      </form>
    </section>
    <section class="card">
      <h2>Low-stock alert</h2>
      <p>Items are marked “Low” when this many or fewer are left. Each item can override it.</p>
      <form class="inline-add" data-form="lowStock">
        <input name="v" type="number" min="0" step="1" inputmode="numeric" value="${st.settings.lowStock}" required aria-label="Low-stock level">
        <button class="btn" type="submit">Save</button>
      </form>
    </section>
    <section class="card">
      <h2>Data &amp; backup</h2>
      ${mode}
      <div class="btn-row">
        <button class="btn" data-act="backup">Download backup</button>
        <button class="btn" data-act="restore">Restore from backup</button>
        <button class="btn" data-act="exportStock">Download stock list (CSV)</button>
        ${db.mode === "cloud" && db.pin ? `<button class="btn link" data-act="lock">Lock this device</button>` : ""}
      </div>
    </section>`;
}

/* ---------- files ---------- */
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const toCsv = (rows) => "﻿" + rows
  .map((r) => r.map((v) => {
    let s = String(v ?? "");
    if (typeof v === "string" && /^[=+\-@]/.test(s)) s = `'${s}`; // stop spreadsheets treating text as a formula
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(","))
  .join("\r\n");

function exportLog() {
  const rows = historyRows();
  const isSales = prefs.log !== "stockIns";
  const table = isSales
    ? [["Timestamp", "Sale Date", "Branch", "Sold By", "Who Bought it?", "Item", "Quantity", "Bill Amount"],
      ...rows.map((x) => [stamp(x.createdAt), x.date, x.branch, x.soldBy, x.buyer, x.item, x.qty, x.amount])]
    : [["Timestamp", "Date", "Branch", "Item", "Quantity Added", "Note", "Added By"],
      ...rows.map((x) => [stamp(x.createdAt), x.date, x.branch, x.item, x.qty, x.note, x.by])];
  download(`moar-er-dokan-${isSales ? "sales" : "stock-added"}-${today()}.csv`, toCsv(table), "text/csv;charset=utf-8");
}

function exportStock() {
  const bs = branches();
  const table = [
    ["Item", "Category", "Price", ...bs, "Total"],
    ...[...S().products].sort(byName).map((p) => [p.name, p.category || "", p.price, ...bs.map((b) => p.stock[b] || 0), qtyAt(p, "all")]),
  ];
  download(`moar-er-dokan-stock-${today()}.csv`, toCsv(table), "text/csv;charset=utf-8");
}

async function restoreFrom(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast("That file couldn't be read.", "error");
  }
  if (!data || !Array.isArray(data.products)) return toast("That file isn't a Moar er Dokan backup.", "error");
  const sales = Array.isArray(data.sales) ? data.sales.length : 0;
  if (!confirm(`Replace ALL current data with this backup?\n${data.products.length} items, ${sales} sales.\n\nTip: download a backup of the current data first.`)) return;
  if (await dispatch({ type: "replaceAll", state: data })) toast("Backup restored.");
}

/* ---------- dialog & toast ---------- */
const modal = $("#modal");
let modalSubmit = null;
let modalCancel = null;

function openModal({ title, lead = "", body, submit = "Save", left = "", onSubmit, onOpen, onCancel }) {
  modal.innerHTML = `
    <form class="modal-form" novalidate>
      <h2 tabindex="-1">${esc(title)}</h2>
      ${lead}
      <p class="form-error" id="modalError" role="alert"></p>
      ${body}
      <div class="modal-actions">${left}<span class="spacer"></span>
        <button type="button" class="btn link" data-act="closeModal">Cancel</button>
        <button type="submit" class="btn primary">${esc(submit)}</button>
      </div>
    </form>`;
  modalSubmit = onSubmit;
  modalCancel = onCancel || null;
  modal.oninput = null; // drop the previous dialog's live-preview handler
  if (!modal.open) modal.showModal();
  onOpen?.(modal);
  // Only jump into a field when the dialog asks for it, so phones don't pop the keyboard over an edit form.
  (modal.querySelector("[autofocus]") || modal.querySelector("h2")).focus();
}

function closeModal(cancelled = true) {
  const cb = cancelled ? modalCancel : null;
  modalSubmit = null;
  modalCancel = null;
  if (modal.open) modal.close();
  cb?.();
}

modal.addEventListener("cancel", (e) => { e.preventDefault(); closeModal(); });
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
modal.addEventListener("submit", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  const form = e.target;
  if (!form.checkValidity()) { form.reportValidity(); return; }
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  try {
    if (await modalSubmit?.(new FormData(form), form)) closeModal(false);
  } finally {
    btn.disabled = false;
  }
});

function askPin(wrong) {
  return new Promise((resolve) => {
    openModal({
      title: "Enter the shop PIN",
      lead: `<p class="modal-lead">This inventory is protected. Ask the owner for the PIN.</p>`,
      body: `<label class="field"><span>PIN</span><input name="pin" type="password" autocomplete="current-password" required autofocus></label>`,
      submit: "Unlock",
      onSubmit(fd) {
        db.pin = String(fd.get("pin")).trim();
        saved.set(PIN_KEY, db.pin);
        resolve(true);
        return true;
      },
      onCancel: () => resolve(false),
    });
    if (wrong) $("#modalError").textContent = "That PIN didn't work. Try again.";
  });
}

let toastTimer;
function toast(message, kind = "ok") {
  // The open dialog covers the page, so show its errors inside it.
  if (kind === "error" && modal.open && $("#modalError")) {
    $("#modalError").textContent = message;
    return;
  }
  const t = $("#toast");
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = "toast"; }, kind === "error" ? 6000 : 3500);
}

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const { act, id, v } = el.dataset;
  const p = id ? productById(id) : null;

  switch (act) {
    case "newItem": return openItemDialog();
    case "editItem": return p && openItemDialog(p);
    case "restock": return p && openRestock(p);
    case "closeModal": return closeModal();
    case "retry": return connect();

    case "sellItem":
      if (!p) return;
      Object.assign(draft, { productId: p.id, qty: "1", amountEdited: false });
      if (viewBranch() !== "all") draft.branch = viewBranch();
      fillAmount();
      location.hash = "sell";
      return;

    case "deleteItem": {
      if (!p || !confirm(`Delete “${p.name}”?\nIts past sales stay in History.`)) return;
      if (await dispatch({ type: "deleteProduct", id })) { closeModal(false); toast(`Deleted “${p.name}”.`); }
      return;
    }

    case "filter":
      ui.filter = v;
      return render();

    case "qty": {
      const q = Math.max(1, round((Number(draft.qty) || 0) + Number(el.dataset.step)));
      draft.qty = String(q);
      $("#sellQty").value = q;
      if (!draft.amountEdited) fillAmount();
      return updateSellHints();
    }

    case "useAuto":
      draft.amountEdited = false;
      fillAmount();
      return updateSellHints();

    case "clearSell":
      Object.assign(draft, { buyer: "", productId: "", qty: "1", amount: "", amountEdited: false, dateTouched: false });
      return render();

    case "delSale": {
      const x = S().sales.find((s) => s.id === id);
      if (!x || !confirm(`Delete this sale?\n${x.item} × ${fmt(x.qty)} — ${money(x.amount)}\n\n${fmt(x.qty)} will go back into stock at ${x.branch}.`)) return;
      if (await dispatch({ type: "deleteSale", id })) toast("Sale deleted and stock put back.");
      return;
    }

    case "delStockIn": {
      const x = S().stockIns.find((s) => s.id === id);
      if (!x || !confirm(`Delete this entry?\n+${fmt(x.qty)} × ${x.item}\n\n${fmt(x.qty)} will be taken off the stock at ${x.branch}.`)) return;
      if (await dispatch({ type: "deleteStockIn", id })) toast("Entry deleted and stock corrected.");
      return;
    }

    case "log":
      prefs.log = v;
      savePrefs();
      return render();

    case "exportLog": return exportLog();
    case "exportStock": return exportStock();
    case "backup": return download(`moar-er-dokan-backup-${today()}.json`, JSON.stringify(S(), null, 2), "application/json");
    case "restore": return $("#restoreFile").click();

    case "removeBranch": {
      if (branches().length === 1) return toast("Keep at least one branch.", "error");
      if (!confirm(`Remove the branch “${v}”?\nIts stock and sales stay saved and come back if you add a branch with the same name again.`)) return;
      if (await dispatch({ type: "settings", settings: { branches: branches().filter((b) => b !== v) } })) toast(`Removed ${v}.`);
      return;
    }

    case "removeBuyer": {
      const buyers = S().settings.buyers;
      if (buyers.length === 1) return toast("Keep at least one option.", "error");
      if (await dispatch({ type: "settings", settings: { buyers: buyers.filter((b) => b !== v) } })) toast(`Removed ${v}.`);
      return;
    }

    case "lock":
      saved.remove(PIN_KEY);
      location.reload();
      return;
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (form.closest("#modal")) return;
  e.preventDefault();
  if (form.id === "sellForm") return submitSale(form);

  const value = form.elements.v.value.trim();
  let ok = false;
  if (form.dataset.form === "addBranch") {
    if (branches().some((b) => b.toLowerCase() === value.toLowerCase())) return toast(`“${value}” is already a branch.`, "error");
    ok = await dispatch({ type: "settings", settings: { branches: [...branches(), value] } });
  } else if (form.dataset.form === "addBuyer") {
    const buyers = S().settings.buyers;
    if (buyers.some((b) => b.toLowerCase() === value.toLowerCase())) return toast(`“${value}” is already an option.`, "error");
    ok = await dispatch({ type: "settings", settings: { buyers: [...buyers, value] } });
  } else if (form.dataset.form === "lowStock") {
    ok = await dispatch({ type: "settings", settings: { lowStock: value } });
  }
  if (ok) toast("Saved.");
});

document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id === "search") {
    ui.search = el.value;
    renderStockList();
  } else if (el.form?.id === "sellForm") {
    onSellInput(el);
  }
});

document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.id === "branchPick") {
    prefs.branch = el.value;
    savePrefs();
    if (el.value !== "all") draft.branch = el.value;
    render();
  } else if (el.id === "rangePick") {
    prefs.range = el.value;
    savePrefs();
    render();
  } else if (el.id === "restoreFile") {
    restoreFrom(el);
  } else if (el.form?.id === "sellForm" && el.tagName === "SELECT") {
    onSellInput(el);
  }
});

document.addEventListener("focusout", () => setTimeout(() => { if (renderPending) renderSoon(); }));

window.addEventListener("hashchange", () => {
  render();
  const top = $("#tabs").offsetTop - 8;
  if (window.scrollY > top) window.scrollTo(0, top);
});

// Another tab on this device changed the data.
window.addEventListener("storage", (e) => {
  if (db.mode === "local" && e.key === DATA_KEY) {
    db.state = normalizeState(saved.get(DATA_KEY, null));
    renderSoon();
  }
});

document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
setInterval(refresh, 20000);

render();
connect();
