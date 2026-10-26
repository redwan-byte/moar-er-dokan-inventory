// Inventory rules shared by the browser app and the Netlify Function, so every
// change is checked and applied the same way on a phone and on the server.

export function emptyState() {
  return {
    version: 1,
    settings: {
      branches: ["Gulshan Link"],
      buyers: ["Member", "Guest", "Staff"],
      lowStock: 5,
    },
    products: [], // { id, name, category, price, lowAt, stock: { [branch]: qty } }
    sales: [], // { id, date, branch, soldBy, buyer, productId, item, qty, amount, createdAt }
    stockIns: [], // { id, date, branch, productId, item, qty, note, by, createdAt }
    updatedAt: null,
  };
}

const text = (v, max) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const toNum = (v) => (v === "" || v == null ? NaN : Number(v));
const round = (n) => Math.round(n * 100) / 100;
const isDay = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const names = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => text(x, 60)).filter(Boolean))] : []);

function fail(message) {
  throw new Error(message);
}

function cleanStock(stock) {
  const out = {};
  for (const [branch, qty] of Object.entries(stock && typeof stock === "object" ? stock : {})) {
    const n = Number(qty);
    if (text(branch, 60) && Number.isFinite(n)) out[text(branch, 60)] = round(n);
  }
  return out;
}

export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== "object") return base;
  const s = raw.settings || {};
  const branches = names(s.branches);
  const buyers = names(s.buyers);
  const low = Number(s.lowStock);
  return {
    version: 1,
    settings: {
      branches: branches.length ? branches : base.settings.branches,
      buyers: buyers.length ? buyers : base.settings.buyers,
      lowStock: Number.isFinite(low) && low >= 0 ? Math.floor(low) : base.settings.lowStock,
    },
    products: (Array.isArray(raw.products) ? raw.products : [])
      .filter((p) => p && p.id && p.name)
      .map((p) => ({ ...p, stock: cleanStock(p.stock) })),
    sales: (Array.isArray(raw.sales) ? raw.sales : []).filter((x) => x && x.id),
    stockIns: (Array.isArray(raw.stockIns) ? raw.stockIns : []).filter((x) => x && x.id),
    updatedAt: raw.updatedAt || null,
  };
}

// Returns a new state with `op` applied, or throws an Error with a message
// that is safe to show to the person using the app.
export function applyOp(state, op, now = new Date().toISOString()) {
  const s = normalizeState(state);
  const { branches } = s.settings;
  const findProduct = (id) => s.products.find((p) => p.id === id) || fail("That item isn't in the inventory any more.");
  const branch = (v) => (branches.includes(text(v, 60)) ? text(v, 60) : fail("Pick a branch."));
  const positive = (v, what) => (round(toNum(v)) > 0 ? round(toNum(v)) : fail(`${what} must be more than 0.`));
  const id = (v) => text(v, 40) || fail("Missing id.");

  switch (op && op.type) {
    case "saveProduct": {
      const p = op.product || {};
      const pid = id(p.id);
      const name = text(p.name, 80) || fail("Item name is required.");
      const price = round(toNum(p.price));
      if (!(price >= 0)) fail("Price must be 0 or more.");
      const low = toNum(p.lowAt);
      if (s.products.some((x) => x.id !== pid && x.name.toLowerCase() === name.toLowerCase())) {
        fail(`"${name}" is already in the list.`);
      }
      let item = s.products.find((x) => x.id === pid);
      if (!item) {
        item = { id: pid, stock: {}, createdAt: now };
        s.products.push(item);
      }
      Object.assign(item, { name, category: text(p.category, 40), price, lowAt: low >= 0 ? Math.floor(low) : null, updatedAt: now });
      // Only the counts someone actually changed are sent, so an edit never
      // overwrites a sale another branch made a moment ago.
      for (const [b, v] of Object.entries(op.stockSet || {})) {
        const n = round(toNum(v));
        if (!(n >= 0)) fail("Stock can't be negative.");
        item.stock[branch(b)] = n;
      }
      break;
    }

    case "deleteProduct":
      s.products = s.products.filter((p) => p.id !== op.id);
      break;

    case "sale": {
      const x = op.sale || {};
      const sid = id(x.id);
      if (s.sales.some((e) => e.id === sid)) break; // already saved (a retried request)
      const item = findProduct(x.productId);
      const b = branch(x.branch);
      const qty = positive(x.qty, "Quantity");
      const amount = round(toNum(x.amount));
      if (!(amount >= 0)) fail("Bill amount must be 0 or more.");
      if (!isDay(x.date)) fail("Pick the sale date.");
      const soldBy = text(x.soldBy, 60) || fail("Fill in who sold it.");
      const buyer = text(x.buyer, 60) || fail("Pick who bought it.");
      item.stock[b] = round((item.stock[b] || 0) - qty);
      s.sales.push({ id: sid, date: x.date, branch: b, soldBy, buyer, productId: item.id, item: item.name, qty, amount, createdAt: now });
      break;
    }

    case "deleteSale": {
      const x = s.sales.find((e) => e.id === op.id);
      if (!x) break;
      s.sales = s.sales.filter((e) => e !== x);
      const item = s.products.find((p) => p.id === x.productId);
      if (item) item.stock[x.branch] = round((item.stock[x.branch] || 0) + x.qty);
      break;
    }

    case "stockIn": {
      const x = op.entry || {};
      const eid = id(x.id);
      if (s.stockIns.some((e) => e.id === eid)) break;
      const item = findProduct(x.productId);
      const b = branch(x.branch);
      const qty = positive(x.qty, "Quantity");
      if (!isDay(x.date)) fail("Pick the date.");
      item.stock[b] = round((item.stock[b] || 0) + qty);
      s.stockIns.push({
        id: eid, date: x.date, branch: b, productId: item.id, item: item.name, qty,
        note: text(x.note, 120), by: text(x.by, 60), createdAt: now,
      });
      break;
    }

    case "deleteStockIn": {
      const x = s.stockIns.find((e) => e.id === op.id);
      if (!x) break;
      s.stockIns = s.stockIns.filter((e) => e !== x);
      const item = s.products.find((p) => p.id === x.productId);
      if (item) item.stock[x.branch] = round((item.stock[x.branch] || 0) - x.qty);
      break;
    }

    case "settings": {
      const p = op.settings || {};
      if (p.branches !== undefined) {
        s.settings.branches = names(p.branches);
        if (!s.settings.branches.length) fail("Keep at least one branch.");
      }
      if (p.buyers !== undefined) {
        s.settings.buyers = names(p.buyers);
        if (!s.settings.buyers.length) fail("Keep at least one buyer option.");
      }
      if (p.lowStock !== undefined) {
        const n = toNum(p.lowStock);
        if (!(n >= 0)) fail("Low-stock level must be 0 or more.");
        s.settings.lowStock = Math.floor(n);
      }
      break;
    }

    case "replaceAll":
      if (!op.state || !Array.isArray(op.state.products)) fail("That file isn't a Moar er Dokan backup.");
      return { ...normalizeState(op.state), updatedAt: now };

    default:
      fail("Unknown change.");
  }

  s.updatedAt = now;
  return s;
}
