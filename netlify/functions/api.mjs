// Shared storage for the inventory, so every branch sees the same stock.
//   GET  /api/state[?etag=...]  -> { etag, state } or { etag, unchanged: true }
//   POST /api/op                -> applies one change, returns { etag, state }
// Data lives in Netlify Blobs. Set SHOP_PIN in the site's environment
// variables to require a PIN before anyone can read or change it.

import { getStore } from "@netlify/blobs";
import { applyOp, emptyState } from "../../public/logic.js";

const KEY = "inventory";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async (req) => {
  const pin = process.env.SHOP_PIN;
  if (pin && req.headers.get("x-shop-pin") !== pin) return json({ error: "PIN required" }, 401);

  const store = getStore({ name: "moar-er-dokan", consistency: "strong" });
  const route = new URL(req.url).pathname.replace(/^\/api\/?/, "").replace(/\/$/, "");

  if (req.method === "GET" && route === "state") {
    const known = new URL(req.url).searchParams.get("etag");
    if (known) {
      const meta = await store.getMetadata(KEY);
      if (meta && meta.etag === known) return json({ etag: known, unchanged: true });
    }
    const entry = await store.getWithMetadata(KEY, { type: "json" });
    return json({ etag: entry?.etag || "", state: entry?.data || emptyState() });
  }

  if (req.method === "POST" && route === "op") {
    let op;
    try {
      op = await req.json();
    } catch {
      return json({ error: "Bad request." }, 400);
    }
    // Read, apply, then write only if nobody else wrote in between; retry if they did.
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await store.getWithMetadata(KEY, { type: "json" });
      let next;
      try {
        next = applyOp(entry?.data || emptyState(), op);
      } catch (err) {
        return json({ error: err.message }, 400);
      }
      const result = await store.setJSON(KEY, next, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (result.modified) return json({ etag: result.etag || "", state: next });
      await wait(40 + Math.random() * 80 * (attempt + 1));
    }
    return json({ error: "The inventory is busy. Please try again." }, 409);
  }

  return json({ error: "Not found." }, 404);
};

export const config = { path: "/api/*" };
