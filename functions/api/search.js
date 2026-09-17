// GET /api/search?q=<keyword>
//
// Same-origin proxy for the EasyHome storefront's product search, needed because:
//  - The real storefront scopes search by an "x-tenant-id: 616" HTTP header, not a
//    shop_id body field. Products are dropshipped in from ~20+ different origin
//    shop_ids, so no fixed shop_id list can cover the catalog.
//  - The upstream API only does exact whole-token matching (no prefix/partial), so
//    "PEA" never finds "PEA60" server-side. We fetch the tenant's full catalog once
//    (cached at the edge) and do diacritics-insensitive substring matching here.
//  - The upstream CORS policy does not allow the x-tenant-id header from a foreign
//    origin (confirmed: browser fetch from easyhome.vn is blocked), so this call
//    cannot be made directly from the client. This Function makes it server-to-server.
//
// Never returns price fields to the client -- price_public from this API is known to
// be wrong, and the site policy is "Xem gia tot nhat ->" only, never a number.

const TENANT_ID = "616";
const UPSTREAM_URL = "https://easyhome.requa.vn/api/proxy/bff/variations/search";
const CDN_BASE = "https://r6i.pen.dropbuy.vn";
const SITE_BASE = "https://easyhome.requa.vn/";
const CATALOG_CACHE_TTL_SECONDS = 300; // 5 minutes
const CACHE_KEY_URL = "https://easyhome.vn/__catalog-cache__/tenant-" + TENANT_ID;
const MAX_RESULTS = 6;
const MAX_KEYWORD_LENGTH = 60;
const CATALOG_PAGE_SIZE = 500;
const CATALOG_MAX_PAGES = 10; // safety ceiling in case total_records is ever wrong

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function sanitizeKeyword(raw) {
  return String(raw || "")
    .normalize("NFC")
    // letters (incl. accented), numbers, spaces, and a small set of punctuation
    // commonly found in product names/SKUs. Everything else is stripped.
    .replace(/[^\p{L}\p{N}\s.\-_/]/gu, "")
    .trim()
    .slice(0, MAX_KEYWORD_LENGTH);
}

function normalizeText(str) {
  return String(str == null ? "" : str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();
}

function compactText(str) {
  return normalizeText(str).replace(/[^a-z0-9]/g, "");
}

async function fetchCatalogPage(pageNum) {
  const upstream = await fetch(UPSTREAM_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": TENANT_ID,
    },
    body: JSON.stringify({ keyword: "", page_num: pageNum, page_size: CATALOG_PAGE_SIZE }),
  });
  if (!upstream.ok) {
    throw new Error("upstream_status_" + upstream.status);
  }
  const upstreamJson = await upstream.json();
  if (!upstreamJson || upstreamJson.success !== true) {
    throw new Error("upstream_bad_response");
  }
  return upstreamJson.data || {};
}

async function fetchFullCatalogRaw() {
  const firstPage = await fetchCatalogPage(1);
  const totalRecords = firstPage.total_records || 0;
  let items = (firstPage.items || []).slice();

  let pageNum = 1;
  while (items.length < totalRecords && pageNum < CATALOG_MAX_PAGES) {
    pageNum++;
    const page = await fetchCatalogPage(pageNum);
    const pageItems = page.items || [];
    if (pageItems.length === 0) break; // no more data even though total said otherwise
    items = items.concat(pageItems);
  }

  // Dedupe by product_id -- "variations/search" could in principle return one row
  // per variation rather than per product; keep only the first row per product_id
  // so a single multi-color/multi-capacity item can't crowd out MAX_RESULTS.
  const seen = new Set();
  const deduped = [];
  for (const it of items) {
    if (seen.has(it.product_id)) continue;
    seen.add(it.product_id);
    deduped.push(it);
  }
  return deduped;
}

async function loadCatalog(context) {
  const cache = caches.default;
  const cacheKey = new Request(CACHE_KEY_URL, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached.json();
  }

  const rawItems = await fetchFullCatalogRaw();

  // Lean, price-free subset only -- this is what gets cached and ever leaves this Function.
  const catalog = rawItems
    .filter(function (it) {
      return !!it.slug; // skip items with no slug -- their link would be broken (SITE_BASE + "_p" + id)
    })
    .map(function (it) {
      const name = it.product_name || it.name || "";
      const sku = it.sku || "";
      const category = it.category_name || "";
      return {
        product_id: it.product_id,
        product_name: name,
        slug: it.slug,
        category_name: category,
        res_thumbnail_url: it.res_thumbnail_url || "",
        in_stock: it.in_stock !== false,
        warranty_type: it.warranty_type,
        warranty_duration: it.warranty_duration,
        _n: normalizeText(name + " " + sku + " " + category),
        _c: compactText(name + " " + sku),
      };
    });

  const cacheResponse = new Response(JSON.stringify(catalog), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "max-age=" + CATALOG_CACHE_TTL_SECONDS,
    },
  });
  context.waitUntil(cache.put(cacheKey, cacheResponse));

  return catalog;
}

function toCard(item) {
  return {
    product_id: item.product_id,
    product_name: item.product_name,
    link: SITE_BASE + item.slug + "_p" + item.product_id,
    thumbnail_url: item.res_thumbnail_url ? CDN_BASE + item.res_thumbnail_url : "",
    category_name: item.category_name || "",
    in_stock: item.in_stock !== false,
    warranty_type: item.warranty_type,
    warranty_duration: item.warranty_duration,
    // Deliberately no price field of any kind.
  };
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const keyword = sanitizeKeyword(url.searchParams.get("q"));

  if (keyword.length < 2) {
    return jsonResponse({ success: true, data: { items: [], total: 0 } });
  }

  let catalog;
  try {
    catalog = await loadCatalog(context);
  } catch (err) {
    return jsonResponse({ success: false, error: "catalog_unavailable" }, 502);
  }

  const qn = normalizeText(keyword);
  const qc = compactText(keyword);
  const matches = [];
  for (let i = 0; i < catalog.length; i++) {
    const p = catalog[i];
    const idx = qn ? p._n.indexOf(qn) : -1;
    const cidx = qc ? p._c.indexOf(qc) : -1;
    if (idx !== -1 || cidx !== -1) {
      matches.push({ item: p, rank: idx !== -1 ? idx : 1000 + cidx });
    }
  }
  matches.sort(function (a, b) {
    return a.rank - b.rank;
  });

  const items = matches.slice(0, MAX_RESULTS).map(function (m) {
    return toCard(m.item);
  });

  return jsonResponse({ success: true, data: { items: items, total: matches.length } });
}
