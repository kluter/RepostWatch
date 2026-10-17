/* ============================================================
   RepostWatch – app.js
   Loads committed data files, routes between companies (#slug),
   renders the hero (tiles + map), charts, severity, and the event log.
   ============================================================ */
"use strict";

(() => {

    const CSS = getComputedStyle(document.documentElement);
    const tok = name => CSS.getPropertyValue(name).trim();
    const C = {
        blue: tok("--s-blue"), blueRing: tok("--s-blue-ring"), aqua: tok("--s-aqua"), yellow: tok("--s-yellow"),
        red: tok("--s-red"), gray: tok("--s-gray"),
    };

    // ---- tiny DOM helpers (textContent only — data is untrusted) ----
    function h(tag, attrs = {}, ...children) {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) {
            if (v == null || v === false) continue;               // skip absent/false attrs
            if (k === "class") n.className = v;
            else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
            else n.setAttribute(k, v === true ? "" : v);          // v===true -> boolean attr
        }
        for (const c of children.flat()) {
            if (c == null) continue;
            n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
        }
        return n;
    }
    const fmtDate = iso => iso ? iso.slice(0, 10) : "";

    // Time zone. Our own timestamps (poll time, observed, closed, history) render in the viewer's
    // LOCAL zone by default, toggleable to UTC and remembered. Feed publish times are left in the
    // feed's own zone (fmtPublished) with the offset shown, so that one never silently shifts.
    // storage can throw (blocked site data, some private modes); the zone choice is a convenience only
    const store = {
        get: k => { try { return localStorage.getItem(k); } catch { return null; } },
        set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* not remembered, still works */ } },
    };
    let tzMode = store.get("rw-tz") === "utc" ? "utc" : "local";
    let _fmtCache = {};
    const _fmter = () => (_fmtCache[tzMode] ||= new Intl.DateTimeFormat("en-GB", {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        hour12: false, ...(tzMode === "utc" ? { timeZone: "UTC" } : {}),
    }));
    const fmtStamp = iso => {                          // our timestamp -> "YYYY-MM-DD HH:MM" in the active zone
        if (!iso) return "";
        const g = t => (_fmter().formatToParts(new Date(iso)).find(p => p.type === t) || {}).value || "";
        return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
    };
    const zoneLabel = () => {
        if (tzMode === "utc") return "UTC";
        const p = new Intl.DateTimeFormat("en-GB", { timeZoneName: "short" }).formatToParts(new Date());
        return (p.find(x => x.type === "timeZoneName") || {}).value || "local";
    };
    const fmtPublished = iso => {                      // feed time: keep its wall-clock, append its offset
        if (!iso) return "";
        const local = iso.slice(0, 16).replace("T", " ");
        const m = iso.match(/(Z|[+-]\d{2}:\d{2})$/);
        let off = "UTC";
        if (m && m[1] !== "Z" && m[1] !== "+00:00") {
            const s = m[1], mm = s.slice(4, 6);
            off = `UTC${s[0]}${parseInt(s.slice(1, 3), 10)}${mm !== "00" ? ":" + mm : ""}`;
        }
        return `${local} ${off}`;
    };

    // ---- data ----
    let companies = [];
    let cache = {};        // slug -> {state, events}
    let geocache = { locations: {} };
    let polledAt = null;   // bot's last run time (index.json polled_at) — proves the scraper is live
    let mapInstance = null;
    let logQuery = "";
    let logSev = new Set();   // active severity filters (empty = show all)
    let logPage = 0;          // current page in the event log
    let logSize = 10;         // rows per page; toggles 10 <-> 25
    let logOpen = new Set();   // job_ids whose per-listing history is expanded inline
    let closedQuery = "";
    let closedPage = 0;
    let closedSev = new Set();
    let closedSize = 10;
    let repQuery = "";
    let repPage = 0;
    let repSize = 10;
    let repOpen = new Set();   // lineage_keys whose repost/id history is expanded inline
    // rows are a fixed height (see .log-table tbody td in the CSS) so every page is the same
    // height and the Prev/Next pager never moves — and no scrollbar. This reserves a full
    // page of height via min-height, so a short last page doesn't pull the pager up.
    const ROW_H = 32, HEAD_H = 30;                       // must match the CSS row / header height
    const bodyHeight = n => `${HEAD_H + n * ROW_H}px`;
    const defaultSort = () => ({ col: 5, dir: -1 });   // 5 = Published, newest first
    let logSort = defaultSort();
    const resetLogState = () => {
        logQuery = ""; logSev = new Set(); logPage = 0; logSize = 10; logOpen = new Set(); logSort = defaultSort();
    };
    const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

    // fetch that rejects on a non-2xx status, so a missing file reads "HTTP 404" instead of a JSON parse error
    const fetchOk = url => fetch(url).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r;
    });

    async function loadCompany(slug) {
        if (cache[slug]) return cache[slug];
        const [state, evText] = await Promise.all([
            fetchOk(`data/${slug}/current_state.json`).then(r => r.json()),
            fetchOk(`data/${slug}/events.jsonl`).then(r => r.text()),
        ]);
        const events = evText.split("\n").filter(Boolean).map(l => JSON.parse(l));
        return (cache[slug] = { state, events });
    }

    // ---- derived series ----
    function monthKey(iso) { return iso.slice(0, 7); }
    function monthRange(jobs) {
        const keys = jobs.map(j => monthKey(j.published_at)).filter(Boolean).sort();
        if (!keys.length) return [];
        const out = [];
        let [y, m] = keys[0].split("-").map(Number);
        const last = keys[keys.length - 1];
        while (true) {
            const k = `${y}-${String(m).padStart(2, "0")}`;
            out.push(k);
            if (k === last) break;
            if (++m > 12) { m = 1; y++; }
            if (out.length > 36) break;
        }
        return out.slice(-12);
    }
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const monthLabel = k => MONTHS[Number(k.slice(5, 7)) - 1];
    const monthTitle = k => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}`;

    function countBy(list, keyFn, topN) {
        const m = new Map();
        for (const it of list) {
            const k = keyFn(it) || "(none)";
            m.set(k, (m.get(k) || 0) + 1);
        }
        let rows = [...m.entries()].map(([label, value]) => ({ label, value }))
            .sort((a, b) => b.value - a.value);
        if (topN && rows.length > topN) {
            const rest = rows.slice(topN - 1).reduce((a, r) => a + r.value, 0);
            rows = rows.slice(0, topN - 1).concat({ label: "Other", value: rest });
        }
        return rows;
    }

    function weekStart(iso) {
        const d = new Date(iso.slice(0, 10) + "T00:00:00Z");
        const dow = (d.getUTCDay() + 6) % 7;             // Monday = 0
        d.setUTCDate(d.getUTCDate() - dow);
        return d.toISOString().slice(0, 10);
    }

    function openOverTime(events) {
        const deltaByDay = new Map();
        for (const ev of events) {
            const day = fmtDate(ev.date);
            // a new-id republish is a listing that (re)appeared, offsetting its own close;
            // a published_at bump keeps the same listing, so it's net zero.
            const d = ev.type === "closed" ? -1
                : (ev.type === "opened" || ev.type === "initialized") ? 1
                : (ev.type === "republished" && ev.mechanism === "new_job_id") ? 1 : 0;
            if (d) deltaByDay.set(day, (deltaByDay.get(day) || 0) + d);
        }
        let acc = 0;
        return [...deltaByDay.entries()].sort()
            .map(([day, d]) => ({ t: new Date(day + "T00:00:00Z"), v: (acc += d) }));
    }

    // ---- render blocks ----
    function tile(value, label, sub, icon, help) {
        return h("div", { class: "tile", title: help || "" },
            h("div", {},
                h("div", { class: "value" }, String(value)),
                h("div", { class: "label" }, label),
                sub ? h("div", { class: "sub" }, sub) : null),
            icon ? h("img", { class: "icon", src: `assets/icons/${icon}.svg`, alt: "" }) : null);
    }

    function card(title, caption, render) {
        const plot = h("div", { class: "plot" });
        const hint = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        hint.setAttribute("viewBox", "0 0 24 24");
        hint.setAttribute("class", "expand-hint");
        hint.innerHTML = '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>';
        const c = h("div", { class: "card" },
            h("div", { class: "card-head" }, h("h3", {}, title), hint),
            h("p", { class: "caption" }, caption),
            plot);
        c._render = () => render(plot);
        c.addEventListener("click", () => {
            const expanding = !c.classList.contains("expanded");
            // one expanded card per row; clicking the expanded one collapses back to equal
            for (const sib of c.parentElement.children) sib.classList.remove("expanded");
            if (expanding) c.classList.add("expanded");
            for (const sib of c.parentElement.children) sib._render && sib._render();
        });
        render(plot);
        return c;
    }

    // pill label: the event type by default (its class picks the color), or any class + label
    function chip(cls, label = cls) { return h("span", { class: `chip ${cls}` }, label); }

    const CHANGE_TYPES = ["opened", "closed", "republished"];   // observed changes (excludes the initial import)
    const LIFECYCLE_TYPES = [...CHANGE_TYPES, "initialized"];   // events about a posting (not manual notes)
    const SEV = ["fresh", "aging", "stale", "flagged"];
    const SEV_RULES = {
        fresh: "under 45 days, no reposts",
        aging: "1 repost or 45+ days",
        stale: "2 reposts or 90+ days",
        flagged: "3+ reposts or 120+ days",
    };
    const sevByDays = (days, reposts) => {
        if (reposts >= 3 || days >= 120) return "flagged";
        if (reposts >= 2 || days >= 90) return "stale";
        if (reposts >= 1 || days >= 45) return "aging";
        return "fresh";
    };
    const DAY_MS = 86400e3;
    // whole days from an ISO timestamp to `until` (default now); 0 when the timestamp is missing
    const ageDays = (iso, until = Date.now()) => iso ? Math.floor((until - Date.parse(iso)) / DAY_MS) : 0;
    // { fresh: n, aging: n, stale: n, flagged: n } in one pass over the list
    const tallySev = (list, sevOf) => {
        const counts = Object.fromEntries(SEV.map(s => [s, 0]));
        for (const x of list) counts[sevOf(x)]++;
        return counts;
    };
    // severity legend column, also a filter: toggle a pill to constrain the adjacent
    // table to that severity (multiple active); onToggle re-renders that table.
    function severityLegend(counts, activeSet, onToggle) {
        return h("div", { class: "log-legend" },
            h("div", { class: "log-legend-title" }, "Repost severity"),
            h("div", { class: "log-legend-pills" },
                SEV.map(s => {
                    const pill = h("div", {
                        class: `sev-pill${activeSet.has(s) ? " active" : ""}`,
                        title: `Filter to ${s}`,
                        onclick: () => {
                            activeSet.has(s) ? activeSet.delete(s) : activeSet.add(s);
                            pill.classList.toggle("active", activeSet.has(s));
                            onToggle();
                        },
                    }, h("b", {}, String(counts[s] || 0)),
                        h("div", {}, chip(`sev-${s}`, s), h("div", { class: "sev-rule" }, SEV_RULES[s])));
                    return pill;
                })));
    }

    // only http(s) links become clickable — a feed's URL is untrusted, so never let a
    // javascript:/data: scheme through into an href.
    const safeUrl = u => /^https?:\/\//i.test(u || "") ? u : null;

    function jobLink(ev) {
        const url = safeUrl(ev.url);
        return url
            ? h("a", { href: url, rel: "noopener", target: "_blank" }, ev.title)
            : document.createTextNode(ev.title || "");
    }

    const SEV_RANK = { fresh: 1, aging: 2, stale: 3, flagged: 4 };
    const LOG_COLS = [
        { label: "Observed",  w: 150, val: r => r.ev.date || "",                  defDir: -1 },
        { label: "Type",      w: 112, val: r => r.ev.type,                        defDir: 1 },
        { label: "Title",     w: 0,   val: r => (r.ev.title || "").toLowerCase(), defDir: 1 },
        { label: "Location",  w: 118, val: r => r.ev.location || "",              defDir: 1 },
        { label: "Severity",  w: 92,  val: r => SEV_RANK[r.sev] || 0,             defDir: -1 },
        { label: "Published", w: 196, val: r => r.ev.published_at || "",          defDir: -1 },
        { label: "ATS id",    w: 88,  val: r => r.ev.job_id || "",                defDir: 1 },
    ];

    // Renders an already-sorted, already-paged list of { ev, sev, history } rows. Sorting and
    // paging live in refreshLog so a header click stays local (no full re-render). A posting
    // with more than one lifecycle event gets a caret that expands an inline history row.
    function logTable(rows, onSort, onToggle, heightPx) {
        const head = LOG_COLS.map((c, i) => h("th", {
            class: "sortable",
            onclick: () => onSort(i),
        }, c.label, logSort.col === i ? h("span", { class: "sort-arrow" }, logSort.dir === 1 ? "▲" : "▼") : null));
        const body = [];
        for (const { ev, sev, history } of rows) {
            const expandable = (history || []).length > 1;
            const open = expandable && logOpen.has(ev.job_id);
            const toggle = expandable
                ? rowToggle(open, `Show history (${history.length} events)`, () => onToggle(ev.job_id))
                : h("span", { class: "row-toggle-gap" });
            body.push(h("tr", { class: expandable ? "has-history" : "" },
                h("td", { class: "dt" }, fmtStamp(ev.date)),
                h("td", {}, chip(ev.type)),
                h("td", { class: "wrap", title: ev.title || "" },
                    toggle,
                    ev.type === "headcount_manual" ? `headcount = ${ev.value} (${ev.source})`
                    : ev.type === "noted_manual" ? h("span", {}, jobLink(ev), `, first seen ${ev.first_seen} (${ev.source})`)
                    : jobLink(ev)),
                h("td", {}, ev.location || ""),
                h("td", {}, sev ? chip(`sev-${sev}`, sev) : ""),
                h("td", { class: "dt" }, fmtPublished(ev.published_at)),
                atsIdCell(ev.job_id)));
            if (open) body.push(historyRow(LOG_COLS.length, history, false));   // one posting: its id is the row's
        }
        return fixedTable(LOG_COLS, head, body, heightPx);
    }

    // ---- shared table / paging pieces (event log, republished, closed, recent movement) ----
    const atsIdCell = id => h("td", { class: "ats-id", title: id || "" }, id || "");

    function rowToggle(open, showTitle, onToggle) {
        return h("button", {
            class: "row-toggle" + (open ? " open" : ""),
            title: open ? "Hide history" : showTitle,
            "aria-label": "Toggle history",
            onclick: e => { e.stopPropagation(); onToggle(); },
        }, "▸");
    }

    // inline expanded row under a table row: one line per event (date, type, optionally its ATS id)
    function historyRow(colspan, hist, withId) {
        return h("tr", { class: "log-detail-row" },
            h("td", { colspan },
                h("ol", { class: "log-history" }, hist.map(hv =>
                    h("li", {},
                        h("span", { class: "dt log-history-date" }, fmtStamp(hv.date)),
                        chip(hv.type),
                        withId ? h("span", { class: "log-history-id", title: hv.job_id || "" }, hv.job_id || "") : null)))));
    }

    // fixed-layout table; cols carry pixel widths (w: 0 = flexible). minHeight reserves a full
    // page so a short last page doesn't pull the pager up.
    function fixedTable(cols, headCells, bodyRows, minHeight) {
        return h("div", { class: "tablewrap", style: minHeight ? `min-height:${minHeight}` : "" },
            h("table", { class: "log-table" },
                h("colgroup", {}, cols.map(c => h("col", c.w ? { style: `width:${c.w}px` } : {}))),
                h("thead", {}, h("tr", {}, headCells)),
                h("tbody", {}, bodyRows)));
    }
    const plainHead = cols => cols.map(c => h("th", {}, c.label));

    // clamp a page index into range and slice that page out of the list
    function pageOf(list, page, size) {
        const pages = Math.max(1, Math.ceil(list.length / size));
        page = Math.min(Math.max(page, 0), pages - 1);
        return { page, pages, shown: list.slice(page * size, page * size + size) };
    }

    // Prev / "a–b of n" / Next, or null when everything fits on one page
    function pager(page, pages, size, total, onPage) {
        if (pages < 2) return null;
        return h("div", { class: "log-pager" },
            h("button", { class: "mini-btn", disabled: page === 0, onclick: () => onPage(page - 1) }, "‹ Prev"),
            h("span", { class: "log-pageinfo" }, `${page * size + 1}–${Math.min(total, (page + 1) * size)} of ${total}`),
            h("button", { class: "mini-btn", disabled: page >= pages - 1, onclick: () => onPage(page + 1) }, "Next ›"));
    }

    // "Show 25" / "Show 10", offered once the list outgrows a 10-row page
    function sizeToggle(size, total, onSize) {
        return total > 10
            ? h("button", { class: "mini-btn", onclick: () => onSize(size === 10 ? 25 : 10) }, size === 10 ? "Show 25" : "Show 10")
            : null;
    }
    const present = list => list.filter(Boolean);

    // Overview map: one marker per resolved location, sized by open-role count.
    // Coordinates come from the committed geocache (data/geocache.json); the
    // browser never geocodes.
    function setupMap(el, jobs) {
        if (mapInstance) { mapInstance.remove(); mapInstance = null; }
        const locs = (geocache && geocache.locations) || {};
        const agg = new Map();
        for (const j of jobs) {
            const key = (j.location || "").trim().toLowerCase();
            const g = locs[key];
            if (!g) continue;   // unknown, or deliberately null (e.g. "Remote")
            const ck = `${g.lat.toFixed(3)},${g.lon.toFixed(3)}`;
            const cur = agg.get(ck) || { lat: g.lat, lon: g.lon, label: g.label, count: 0, remote: !!g.remote };
            cur.count++; agg.set(ck, cur);
        }
        const map = L.map(el, { scrollWheelZoom: false, worldCopyJump: true });
        mapInstance = map;
        // Esri's free dark-gray basemap. CARTO's public raster tiles now require an API key
        // (they serve an "API KEY REQUIRED" watermark tile otherwise); Esri needs no key.
        L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
            attribution: "Tiles &copy; Esri", maxZoom: 11,
        }).addTo(map);

        const pts = [...agg.values()];
        if (!pts.length) { map.setView([25, 10], 1); return; }
        const maxC = Math.max(...pts.map(p => p.count));
        const markers = pts.map(p => {
            const r = 6 + Math.sqrt(p.count / maxC) * 15;
            // remote roles pin to a region centroid — draw them red so they read as
            // "somewhere in this region", distinct from the blue on-site markers.
            const m = L.circleMarker([p.lat, p.lon], {
                radius: r, weight: 1.5,
                color: p.remote ? C.red : C.blueRing,
                fillColor: p.remote ? C.red : C.blue,
                fillOpacity: p.remote ? 0.3 : 0.55,
            });
            const kind = p.remote ? "remote" : "open";
            m.bindPopup(h("div", {}, h("b", {}, p.label), h("br"),
                `${p.count} ${kind} role${p.count > 1 ? "s" : ""}`));
            // DOM node (not a string) so Leaflet doesn't parse the label as HTML
            m.bindTooltip(h("span", {}, `${p.label}: ${p.count}${p.remote ? " (remote)" : ""}`), { direction: "top", offset: [0, -4] });
            return m.addTo(map);
        });
        map.fitBounds(L.featureGroup(markers).getBounds().pad(0.3), { maxZoom: 6 });
        setTimeout(() => map.invalidateSize(), 60);
    }

    function renderSidebar(slug, state, events) {
        const cfg = companies.find(c => c.slug === slug) || {};
        const jobs = state.jobs;
        const factRow = (k, v) => h("div", { class: "row" },
            h("dt", {}, k), h("dd", {}, v instanceof Node ? v : String(v)));

        // dark/black logos get inverted to white on the dark sidebar; colored logos
        // (logo_invert: false in config) are only brightened so they keep their hue.
        const logo = h("img", {
            src: cfg.logo || `assets/companies/${slug}.png`, alt: `${cfg.name || slug} logo`,
            class: cfg.logo_invert === false ? "logo-keep" : "", "data-co": slug,
        });
        const logoBox = h("div", { class: "side-logo" }, logo);
        logo.onerror = () => {                      // no logo file: show the name big instead
            logoBox.replaceChildren(h("b", { style: "font-size:20px;color:#fff" }, (cfg.name || slug).toUpperCase()));
        };

        // "ATS response": the status code the feed returned on the last poll (no error == it answered
        // 200; an outage carries the error code), stamped with the bot's run time. This proves the
        // feed is reachable regardless of whether any job data changed.
        const err = state.feed_error;
        const feedStatus = h("span", { class: "feed-pill " + (err ? "bad" : "ok"), title: err ? err.message : "OK" },
            (err ? (err.code ? String(err.code) : err.message) : "200")
            + (polledAt ? ` · ${fmtStamp(polledAt)}` : ""));

        const derived = [
            ["Departments", new Set(jobs.map(j => j.department).filter(Boolean)).size],
            ["Locations", new Set(jobs.map(j => j.location).filter(Boolean)).size],
            ["Remote roles", jobs.filter(j => j.is_remote).length],
            ["Tracking since", events.length ? fmtDate(events[0].date) : "n/a"],
            ["Feed", `${cap(state.source)} (public)`],
            ["ATS response", feedStatus],
            ["Last change", state.fetched_at ? fmtStamp(state.fetched_at) : "n/a"],
        ];

        document.getElementById("detail").replaceChildren(
            logoBox,
            h("dl", { class: "side-facts" },
                safeUrl(cfg.website) ? factRow("Homepage", h("a", { href: safeUrl(cfg.website), target: "_blank", rel: "noopener" },
                    cfg.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))) : null,
                ...Object.entries(cfg.facts || {}).map(([k, v]) => factRow(k, v)),
                cfg.partners && cfg.partners.length
                    ? h("div", { class: "row row-stack" }, h("dt", {}, "Partners"),
                        h("dd", {}, cfg.partners.map(p => h("div", {}, p))))
                    : null),
            h("div", { class: "side-sect" }, "Hiring footprint"),
            h("dl", { class: "side-facts" }, derived.map(([k, v]) => factRow(k, v))));
    }

    function renderCompany(slug, { state, events }) {
        const app = document.getElementById("app");
        const jobs = state.jobs;
        const republishes = events.filter(e => e.type === "republished").length;
        const headcounts = events.filter(e => e.type === "headcount_manual");
        const lastHc = headcounts[headcounts.length - 1];
        const firstPoll = events.length ? fmtDate(events[0].date) : "n/a";

        // --- role lineage (identity across republishes) ---
        // republishes = number of actual `republished` events for the role (a fresh
        // publish date or a new id after closing). Concurrent, distinct roles that merely
        // share a title+location are NOT counted as republishes of one another.
        const lineage = new Map();
        const getLin = (k, ev) => {
            let r = lineage.get(k);
            if (!r) { r = { title: ev.title, location: ev.location, republishes: 0, first: "", last: "" }; lineage.set(k, r); }
            return r;
        };
        for (const ev of events) {
            if (!ev.lineage_key) continue;
            if (ev.type === "noted_manual") {
                // hand-logged observation (e.g. seen before tracking began): extends age only
                const r = getLin(ev.lineage_key, ev);
                if (ev.first_seen && (!r.first || ev.first_seen < r.first)) r.first = ev.first_seen;
                continue;
            }
            if (!["opened", "republished", "initialized"].includes(ev.type)) continue;
            const r = getLin(ev.lineage_key, ev);
            if (ev.type === "republished") r.republishes++;
            const p = ev.published_at || ev.date;
            if (!r.first || p < r.first) r.first = p;
            if (p > r.last) { r.last = p; r.title = ev.title; r.location = ev.location; r.job_id = ev.job_id; }
        }
        const openKeys = new Set(jobs.map(j => j.lineage_key));
        const republishesOf = k => (lineage.get(k) || {}).republishes || 0;

        // --- repost severity ---
        // Judged PER POSTING: age from this posting's own publish date, plus how many times
        // the role (lineage) has actually been republished. So several distinct, concurrent
        // roles that merely share a title+location never drag each other's severity — a
        // brand-new posting reads fresh even if an older sibling has lingered for months.
        const nowMs = Date.now();
        const sevFor = (publishedAt, reposts) => sevByDays(ageDays(publishedAt, nowMs), reposts);
        const jobSev = j => sevFor(j.published_at, republishesOf(j.lineage_key));
        const eventSev = ev => LIFECYCLE_TYPES.includes(ev.type)
            ? sevFor(ev.published_at, republishesOf(ev.lineage_key)) : null;
        const sevCounts = tallySev(jobs, jobSev);
        // click a pill to filter the event log to that severity (multiple active)
        const logLegend = severityLegend(sevCounts, logSev, () => { logPage = 0; refreshLog(); });

        const meta = document.getElementById("poll-meta");
        const ranAt = polledAt ? `${fmtStamp(polledAt)} ${zoneLabel()}` : "";
        if (state.feed_error) {
            meta.textContent = `Feed unavailable (${state.feed_error.message})` + (ranAt ? `, checked ${ranAt}` : "");
            meta.classList.add("feed-down");
        } else {
            meta.textContent = ranAt ? `Last bot run: ${ranAt}` : "";
            meta.classList.remove("feed-down");
        }
        renderSidebar(slug, state, events);

        // --- hero: stat tiles column + overview map ---
        const tiles = h("section", { id: "tiles" },
            tile(state.job_count, "open roles", null, "briefcase",
                "Positions currently listed in the company's public feed."),
            tile(republishes, "republishes observed", null, "repost",
                "Times a listed role got a fresh publish date or reappeared under a new id since tracking began."),
            tile(events.length, "events logged", `since ${firstPoll}`, "list",
                "Every change recorded (opened, closed, republished) since tracking began."),
            lastHc ? tile(lastHc.value.toLocaleString("en-US"), "headcount",
                `${lastHc.source}, ${fmtDate(lastHc.date)}, manual`, "users",
                "Most recent headcount, entered by hand from a public source. Never scraped or automated.") : null);
        const mapEl = h("div", { id: "map" });
        const introCard = h("div", { class: "hero-intro" },
            h("div", { class: "hero-intro-head" }, "What is RepostWatch?"),
            h("div", { class: "hero-intro-body" }, introParagraphs(companies.find(c => c.slug === slug) || {}, slug)));
        const hero = h("div", { class: "hero" },
            introCard,
            h("div", { class: "map-card" }, h("span", { class: "map-badge" }, "Open roles by location"), mapEl),
            tiles);

        // --- current picture ---
        const months = monthRange(jobs);
        const perMonth = months.map(m => jobs.filter(j => monthKey(j.published_at) === m).length);
        const gridNow = h("div", { class: "chart-grid" },
            card("Postings published per month", "Publish dates of currently listed roles. Republishing refreshes the date.",
                p => Charts.columns(p, months, [{ name: "postings", color: C.blue, values: perMonth }],
                    { catLabel: monthLabel, catTitle: monthTitle })),
            card("Open roles by department", "currently listed",
                p => Charts.barsH(p, countBy(jobs, j => j.department, 10), { color: C.blue, unit: "roles" })),
            card("Open roles by location", "primary location of currently listed roles",
                p => Charts.barsH(p, countBy(jobs, j => j.location, 10), { color: C.aqua, unit: "roles" })));

        // --- over time ---
        const oot = openOverTime(events);
        // A stable roster still tells a story: carry the current count forward to today so it
        // draws a flat line to the present instead of stopping dead at the last change.
        if (oot.length) {
            const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
            const last = oot[oot.length - 1];
            if (+today > +last.t) oot.push({ t: today, v: last.v });
        }
        const weekCounts = new Map();            // "week|type" -> count, one pass over the log
        for (const e of events) {
            if (!CHANGE_TYPES.includes(e.type)) continue;
            const k = `${weekStart(e.date)}|${e.type}`;
            weekCounts.set(k, (weekCounts.get(k) || 0) + 1);
        }
        const weeks = [...new Set([...weekCounts.keys()].map(k => k.split("|")[0]))].sort().slice(-16);
        const wkSeries = [
            { name: "opened", color: C.aqua },
            { name: "republished", color: C.yellow },
            { name: "closed", color: C.red },
        ].map(s => ({ ...s, values: weeks.map(w => weekCounts.get(`${w}|${s.name}`) || 0) }));

        const gridTime = h("div", { class: "chart-grid" },
            card("Open roles over time", "replayed from the event log, carried forward to today",
                p => oot.length < 2
                    ? Charts.emptyNote(p, `${oot.length} data point so far (${state.job_count} open roles). The line fills in once tracking spans a day.`)
                    : Charts.timeLine(p, [{ name: "open roles", color: C.blue, points: oot }], { area: true, zeroBase: false })),
            card("Events per week", "Stacked by type. Initial import excluded.",
                p => Charts.columns(p, weeks, wkSeries,
                    { emptyMsg: "No post-import events yet. Fills in as the daily polls observe changes." })),
            card("Time to close", "how long roles stayed listed before they closed",
                p => {
                    const closes = events.filter(e => e.type === "closed" && e.published_at && e.date);
                    if (closes.length < 3)
                        return Charts.emptyNote(p, closes.length
                            ? `Only ${closes.length} closed role${closes.length === 1 ? "" : "s"} so far; the spread fills in as more close.`
                            : "No roles have closed since tracking began.");
                    const bins = [["<1mo", 30], ["1-2mo", 60], ["2-3mo", 90], ["3-6mo", 180], ["6mo+", Infinity]];
                    const counts = bins.map(() => 0);
                    for (const e of closes) {
                        const d = Math.max(0, ageDays(e.published_at, Date.parse(e.date)));
                        counts[bins.findIndex(([, max]) => d < max)]++;
                    }
                    return Charts.columns(p, bins.map(([lab]) => lab), [{ name: "roles", color: C.blue, values: counts }]);
                }));

        // full lineage history (every posting under a role, across reposts / new ids), newest first,
        // so a republished row can expand to show the id history of that role's repeat postings.
        const historyByLineage = new Map();
        for (const e of events) {
            if (!e.lineage_key || e.type === "headcount_manual") continue;
            let list = historyByLineage.get(e.lineage_key);
            if (!list) historyByLineage.set(e.lineage_key, list = []);
            list.push(e);
        }
        for (const list of historyByLineage.values())
            list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

        // --- republished roles --- (the flagship view; only shown once there is data)
        const repeats = [...lineage.entries()].filter(([, r]) => r.republishes > 0)
            .sort((a, b) => b[1].republishes - a[1].republishes);
        let repSection = null;
        if (repeats.length) {
            const REP_COLS = [
                { label: "Role", w: 0 }, { label: "Location", w: 130 }, { label: "Times published", w: 124 },
                { label: "First seen", w: 104 }, { label: "Last published", w: 120 }, { label: "Status", w: 88 },
                { label: "ATS id", w: 88 },   // the latest posting's id (a republished role may have had several)
            ];
            const repMatch = ([, r]) => {
                const q = repQuery.trim().toLowerCase();
                return !q || (r.title || "").toLowerCase().includes(q) || (r.location || "").toLowerCase().includes(q)
                    || (r.job_id || "").toLowerCase().includes(q);
            };
            const repBody = h("div");
            const repPager = h("div");
            const repControls = h("span", { class: "log-controls" });
            const refreshRep = () => {
                const filtered = repeats.filter(repMatch);
                const pg = pageOf(filtered, repPage, repSize);
                repPage = pg.page;
                repBody.replaceChildren(fixedTable(REP_COLS, plainHead(REP_COLS), pg.shown.flatMap(([key, r]) => {
                    const hist = historyByLineage.get(key) || [];
                    const open = repOpen.has(key);
                    const toggle = rowToggle(open, `Show posting history (${hist.length} events)`,
                        () => { repOpen.has(key) ? repOpen.delete(key) : repOpen.add(key); refreshRep(); });
                    const isOpen = openKeys.has(key);
                    const rows = [h("tr", { class: "has-history" },
                        h("td", { class: "wrap", title: r.title || "" }, toggle, chip("republished"), " ", r.title),
                        h("td", {}, r.location || ""),
                        h("td", { class: "num" }, String(r.republishes + 1)),
                        h("td", { class: "dt" }, fmtDate(r.first)),
                        h("td", { class: "dt" }, fmtDate(r.last)),
                        h("td", {}, chip(isOpen ? "opened" : "closed", isOpen ? "open" : "closed")),
                        atsIdCell(r.job_id))];
                    if (open) rows.push(historyRow(REP_COLS.length, hist, true));   // a role may span several ids
                    return rows;
                }), bodyHeight(Math.min(repSize, filtered.length))));
                repControls.replaceChildren(...present([
                    sizeToggle(repSize, filtered.length, n => { repSize = n; repPage = 0; refreshRep(); })]));
                repPager.replaceChildren(...present([
                    pager(repPage, pg.pages, repSize, filtered.length, p => { repPage = p; refreshRep(); })]));
            };
            const repSearch = h("input", {
                class: "log-search", type: "search", placeholder: "Filter republished roles…",
                value: repQuery, "aria-label": "Filter republished roles",
                oninput: e => { repQuery = e.target.value; repPage = 0; refreshRep(); },
            });
            refreshRep();
            repSection = h("section", {},
                h("div", { class: "sect-head" }, h("h2", {}, "Republished roles"), repSearch, repControls),
                repBody,
                repPager);
        }

        // every title + location a posting ever carried, keyed by job id, so a search matches a role
        // by ANY label it has had. Companies relabel postings in place (the founding example: an
        // ICEYE role posted as "...Berlin"/Berlin was later retitled "...Germany"/Munich on the same
        // job id, then closed), so it must still be findable by its original "Berlin" label.
        const jobHistoryText = new Map();
        for (const e of events) {
            if (!e.job_id) continue;
            jobHistoryText.set(e.job_id,
                `${jobHistoryText.get(e.job_id) || ""} ${e.title || ""} ${e.location || ""} ${e.job_id}`.toLowerCase());
        }

        // --- event log ---
        // the event log is the live roster: one row per posting still in the feed, showing that
        // posting's most recent non-closed event (its current status). the full lifecycle of each
        // posting — including its closures and reopens — is kept in historyByJob, so a row with
        // more than one event can be expanded inline to show that specific listing's story.
        const openJobIds = new Set(jobs.map(j => j.job_id));
        const historyByJob = new Map();          // job_id -> its events, newest first
        for (const e of events) {
            if (e.type === "headcount_manual" || !openJobIds.has(e.job_id)) continue;
            let list = historyByJob.get(e.job_id);
            if (!list) historyByJob.set(e.job_id, list = []);
            list.push(e);
        }
        const allLogEvents = [];                 // one roster row per posting: its latest non-closed event
        for (const list of historyByJob.values()) {
            list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));   // newest first
            const latest = list.find(e => e.type !== "closed");             // roster row = current status
            if (latest) allLogEvents.push(latest);
        }
        const matchQuery = ev => {
            const q = logQuery.trim().toLowerCase();
            if (!q) return true;
            return (ev.title || "").toLowerCase().includes(q)
                || (ev.location || "").toLowerCase().includes(q)
                || (ev.type || "").toLowerCase().includes(q)
                || (jobHistoryText.get(ev.job_id) || "").includes(q);   // match any past label
        };
        const onSort = i => {
            if (logSort.col === i) logSort.dir *= -1;
            else logSort = { col: i, dir: LOG_COLS[i].defDir };
            logPage = 0;
            refreshLog();   // local: no full re-render, so the map/charts aren't rebuilt
        };
        const toggleRow = jid => { logOpen.has(jid) ? logOpen.delete(jid) : logOpen.add(jid); refreshLog(); };

        // The table and its controls re-render locally on search / sort / paging so the
        // search box keeps focus and the rest of the page (map, charts) isn't rebuilt.
        const logBody = h("div");
        const logControls = h("span", { class: "log-controls" });
        const bottomWrap = h("div");
        function refreshLog() {
            const col = LOG_COLS[logSort.col];
            const decorated = allLogEvents
                .filter(matchQuery)
                .map(ev => ({ ev, sev: eventSev(ev), history: historyByJob.get(ev.job_id) || [] }))
                .filter(r => logSev.size === 0 || logSev.has(r.sev));
            decorated.sort((a, b) => {
                const va = col.val(a), vb = col.val(b);
                return (va < vb ? -1 : va > vb ? 1 : 0) * logSort.dir;
            });
            const total = decorated.length;
            const ds = defaultSort();
            const filtering = logQuery.trim() || logSev.size;
            const modified = filtering || logSort.col !== ds.col || logSort.dir !== ds.dir;

            const pg = pageOf(decorated, logPage, logSize);
            logPage = pg.page;
            logBody.replaceChildren(logTable(pg.shown, onSort, toggleRow, bodyHeight(Math.min(logSize, total))));

            logControls.replaceChildren(...present([
                sizeToggle(logSize, total, n => { logSize = n; logPage = 0; refreshLog(); }),
                // full re-render: the severity legend holds the active filter set, so it is rebuilt too
                modified ? h("button", { class: "mini-btn", onclick: () => { resetLogState(); route(); } }, "Reset") : null,
            ]));

            // bottom: Prev/Next pager, matching Closed roles (shown when more than one page)
            bottomWrap.replaceChildren(...present([
                pager(logPage, pg.pages, logSize, total, p => { logPage = p; refreshLog(); })]));
        }
        const searchInput = h("input", {
            class: "log-search", type: "search", placeholder: "Filter by title…",
            value: logQuery, "aria-label": "Filter event log",
            oninput: e => { logQuery = e.target.value; logPage = 0; refreshLog(); },
        });
        refreshLog();
        const logSection = h("section", {},
            h("div", { class: "log-grid" },
                h("div", { class: "log-main" },
                    h("div", { class: "sect-head" },
                        h("h2", {}, "Event log"),
                        searchInput,
                        logControls),
                    logBody),
                logLegend),
            bottomWrap);   // pager below the grid, so the legend stops at the last row

        // --- closed roles --- (searchable, paginated log of jobs that left the feed)
        const closedAll = events.filter(e => e.type === "closed")
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
        // days a posting was listed = publish date -> the poll that saw it drop out
        const daysListedNum = ev => (ev.published_at && ev.date)
            ? Math.max(0, ageDays(ev.published_at, Date.parse(ev.date))) : 0;
        const daysListed = ev => (ev.published_at && ev.date) ? String(daysListedNum(ev)) : "";
        // severity a role had WHEN IT CLOSED (from how long it was listed, not "now"); fixed per
        // event, so it is computed once here rather than on every filter / render pass
        const closedSevMap = new Map(closedAll.map(ev =>
            [ev, sevByDays(daysListedNum(ev), republishesOf(ev.lineage_key))]));
        const closedSevOf = ev => closedSevMap.get(ev);
        const CLOSED_COLS = [
            { label: "Closed", w: 150 }, { label: "Title", w: 0 }, { label: "Location", w: 118 },
            { label: "Severity", w: 92 }, { label: "Published", w: 196 }, { label: "Days listed", w: 112 },
            { label: "ATS id", w: 88 },
        ];
        let closedSection;
        if (!closedAll.length) {
            closedSection = h("section", {}, h("h2", {}, "Closed roles"),
                h("p", { class: "caption" }, "No roles have closed since tracking began."));
        } else {
            const closedSevCounts = tallySev(closedAll, closedSevOf);
            const closedMatch = ev => {
                const q = closedQuery.trim().toLowerCase();
                return !q || (ev.title || "").toLowerCase().includes(q) || (ev.location || "").toLowerCase().includes(q)
                    || (jobHistoryText.get(ev.job_id) || "").includes(q);   // match any past label (e.g. find the "Berlin" role that closed as "Germany")
            };
            const closedBody = h("div");
            const closedPager = h("div");
            const closedControls = h("span", { class: "log-controls" });
            const refreshClosed = () => {
                const filtered = closedAll.filter(ev =>
                    closedMatch(ev) && (closedSev.size === 0 || closedSev.has(closedSevOf(ev))));
                const pg = pageOf(filtered, closedPage, closedSize);
                closedPage = pg.page;
                closedBody.replaceChildren(fixedTable(CLOSED_COLS, plainHead(CLOSED_COLS), pg.shown.map(ev => h("tr", {},
                    h("td", { class: "dt" }, fmtStamp(ev.date)),
                    h("td", { class: "wrap", title: ev.title || "" }, jobLink(ev)),
                    h("td", {}, ev.location || ""),
                    h("td", {}, chip(`sev-${closedSevOf(ev)}`, closedSevOf(ev))),
                    h("td", { class: "dt" }, fmtPublished(ev.published_at)),
                    h("td", { class: "num" }, daysListed(ev)),
                    atsIdCell(ev.job_id))), bodyHeight(Math.min(closedSize, filtered.length))));
                closedControls.replaceChildren(...present([
                    sizeToggle(closedSize, filtered.length, n => { closedSize = n; closedPage = 0; refreshClosed(); })]));
                closedPager.replaceChildren(...present([
                    pager(closedPage, pg.pages, closedSize, filtered.length, p => { closedPage = p; refreshClosed(); })]));
            };
            const closedSearch = h("input", {
                class: "log-search", type: "search", placeholder: "Filter closed roles…",
                value: closedQuery, "aria-label": "Filter closed roles",
                oninput: e => { closedQuery = e.target.value; closedPage = 0; refreshClosed(); },
            });
            const closedLegend = severityLegend(closedSevCounts, closedSev, () => { closedPage = 0; refreshClosed(); });
            refreshClosed();
            closedSection = h("section", {},
                h("div", { class: "log-grid" },
                    h("div", { class: "log-main" },
                        h("div", { class: "sect-head" }, h("h2", {}, "Closed roles"), closedSearch, closedControls),
                        closedBody),
                    closedLegend),
                closedPager);   // pager below the grid, so the legend stops at the last row
        }

        // --- lingering vs reposting --- (each role: how long it has been alive vs times posted)
        const scatterPts = [...lineage.entries()].map(([key, r]) => {
            const open = openKeys.has(key);
            const hist = historyByLineage.get(key) || [];
            const start = Date.parse(r.first);
            const end = open ? nowMs : (hist.length ? Date.parse(hist[0].date) : nowMs);
            return { x: Math.round((end - start) / DAY_MS), y: r.republishes + 1, label: r.title,
                color: open ? C.blue : C.gray };
        }).filter(p => Number.isFinite(p.x) && p.x >= 0);
        // full-width, non-collapsible panel; rendered after attach (below) so it sizes to the real width
        const scatterPlot = h("div", { class: "plot" });
        const scatterCard = h("div", { class: "pcard" },
            h("h3", {}, "Role lifespan vs times posted"),
            h("p", { class: "caption" },
                "each dot is a role, placed by days alive (x, log scale) and how many times it has been posted (rows). The dashed line sits at 90 days alive, the severity model's stale cutoff, and is centred so the four zones stay balanced. Top rows are reposted roles; top-right is long-lived and recycled."),
            scatterPlot);
        scatterCard._render = () => scatterPts.length < 3
            ? Charts.emptyNote(scatterPlot, "Not enough roles tracked yet to show a pattern.")
            : Charts.scatter(scatterPlot, scatterPts, {
                xUnit: "d", xName: "days alive", yName: "times posted", height: 240,
                legendItems: [{ name: "open", color: C.blue }, { name: "closed", color: C.gray }],
                // y collapses onto three rows (bottom-first); "posted once" gets the bottom half
                bands: [
                    { test: v => v === 1, label: "1", weight: 2 },
                    { test: v => v === 2, label: "2", weight: 1 },
                    { test: v => v >= 3, label: "3+", weight: 1 },
                ],
                zones: {
                    x: 90,   // 90 days alive = the "stale" age cutoff from the severity model
                    cells: [
                        { q: "bl", label: "fresh", tint: "--st-good" },         // green
                        { q: "br", label: "lingering", tint: "--st-serious" },  // orange
                        { q: "tl", label: "recycled", tint: "--st-warning" },   // yellow
                        { q: "tr", label: "zombie", tint: "--st-critical" },    // red
                    ],
                },
            });
        const scatterSection = h("section", {}, h("h2", {}, "Lingering vs reposting"), scatterCard);

        app.replaceChildren(...[
            hero,
            logSection,                                                   // event log up top
            repSection,                                                   // republished roles — flagship view, above the graphs
            h("section", {}, h("h2", {}, "Current picture"), gridNow),    // stat graphs below
            h("section", {}, h("h2", {}, "Over time"), gridTime),
            scatterSection,                                               // role lifespan vs repost count
            closedSection,                                                // closed-jobs log at the bottom
        ].filter(Boolean));

        setupMap(mapEl, jobs);   // must run after the element is attached to the DOM
        // render the scatter now that its plot is attached, so it uses the real (full) width
        scatterCard._render();
    }

    // ---- routing ----
    function currentSlug() {
        const hash = location.hash.replace(/^#\/?/, "");
        return companies.some(c => c.slug === hash) ? hash : "";   // "" -> overview home
    }

    function introParagraphs(cfg, slug) {
        const name = cfg.name || slug, ats = cap(cfg.ats || "ATS");
        return [
            h("p", {},
                "RepostWatch tracks how job postings change over time: when roles open, close, and get republished. ",
                "It reads only public applicant-tracking feeds, never LinkedIn or anything behind a login."),
            h("p", {},
                h("b", {}, name), " runs its hiring on ", h("b", {}, ats),
                ", the recruiting platform behind its public careers page. RepostWatch polls that feed a couple of times a day ",
                "and logs every change, so a role that quietly reappears month after month, or lingers open far too long, ",
                "surfaces here instead of blending in."),
        ];
    }

    async function route() {
        const slug = currentSlug();
        document.body.classList.toggle("home", !slug);
        setActiveRail(slug);
        if (!slug) {
            document.getElementById("detail").replaceChildren();
            await renderHome();
            return;
        }
        try {
            renderCompany(slug, await loadCompany(slug));
        } catch (err) {
            document.getElementById("app").replaceChildren(
                h("p", { class: "caption" }, `Failed to load data for ${slug}: ${err.message}`));
            document.getElementById("detail").replaceChildren();
        }
    }

    // ---- overview home ----
    function relTime(iso) {
        // compare calendar days, not elapsed hours: an event from 8pm yesterday should read
        // "yesterday" this morning, not "today" until a full 24h has passed.
        // Days are counted in the active zone (local or UTC), matching every other timestamp.
        const dayStart = ms => Date.parse(fmtStamp(new Date(ms).toISOString()).slice(0, 10) + "T00:00:00Z");
        const d = Math.round((dayStart(Date.now()) - dayStart(Date.parse(iso))) / DAY_MS);
        if (d <= 0) return "today";
        if (d === 1) return "yesterday";
        if (d < 30) return `${d}d ago`;
        if (d < 365) return `${Math.floor(d / 30)}mo ago`;
        return `${Math.floor(d / 365)}y ago`;
    }

    function summarize(cfg, state, events) {
        const reps = new Map();   // lineage_key -> republish count
        let lastHc = null;
        for (const ev of events) {
            if (ev.type === "republished") reps.set(ev.lineage_key, (reps.get(ev.lineage_key) || 0) + 1);
            if (ev.type === "headcount_manual") lastHc = ev.value;
        }
        const now = Date.now();
        const sev = tallySev(state.jobs, j => sevByDays(ageDays(j.published_at, now), reps.get(j.lineage_key) || 0));
        // "repost pressure": how stale/recycled the roster reads, used to rank the companies
        const score = sev.flagged * 3 + sev.stale * 2 + sev.aging;
        return { cfg, jobs: state.job_count, sev, score, headcount: lastHc, reps };
    }

    const sevColor = s => tok({ fresh: "--st-good", aging: "--st-warning", stale: "--st-serious", flagged: "--st-critical" }[s]);

    function plainCard(title, caption, render) {
        const plot = h("div", { class: "plot" });
        render(plot);
        const c = h("div", { class: "pcard" }, h("h3", {}, title), h("p", { class: "caption" }, caption), plot);
        c._render = () => render(plot);
        return c;
    }

    function moveStat(n, label, color, activeType, onToggle) {
        const active = activeType === label;
        return h("div", {
            class: "move-stat clickable" + (active ? " active" : ""),
            role: "button", tabindex: "0",
            title: active ? `showing only ${label}, click to clear` : `show only ${label}`,
            onclick: () => onToggle(label),
            onkeydown: e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(label); } },
        }, h("b", { style: `color:${color}` }, String(n)), h("span", {}, label));
    }

    // persistent left rail: one logo chip per company, alphabetical, the current one highlighted.
    function railItem(cfg) {
        const logo = h("img", { src: cfg.logo || `assets/companies/${cfg.slug}.png`, alt: "",
            class: cfg.logo_invert === false ? "logo-keep" : "" });
        const box = h("span", { class: "nav-logo" }, logo);
        logo.onerror = () => box.replaceChildren(h("b", { class: "nav-fallback" }, cfg.name || cfg.slug));
        return h("a", { class: "nav-co", href: `#${cfg.slug}`, "data-co": cfg.slug, title: cfg.name || cfg.slug }, box);
    }

    function buildRail() {
        const sorted = [...companies].sort((a, b) =>
            (a.name || a.slug).localeCompare(b.name || b.slug, undefined, { sensitivity: "base" }));
        document.getElementById("rail").replaceChildren(
            h("div", { class: "side-intro" },
                h("p", {},
                    h("b", {}, "RepostWatch"),
                    ` tracks the public job feeds of ${companies.length} space, Earth-observation and defence companies, logging every time a role opens, closes, or is quietly republished.`)),
            h("div", { class: "side-sect" }, "Companies"),
            h("nav", { class: "co-nav" }, sorted.map(railItem)));
    }

    function setActiveRail(slug) {
        for (const a of document.querySelectorAll("#rail .nav-co"))
            a.classList.toggle("active", a.getAttribute("data-co") === slug);
    }

    async function renderHome() {
        const app = document.getElementById("app");
        app.replaceChildren(h("p", { class: "caption" }, "Loading overview…"));

        const loaded = await Promise.all(companies.map(async c => {
            try { const { state, events } = await loadCompany(c.slug); return { cfg: c, state, events }; }
            catch { return { cfg: c, state: { jobs: [], job_count: 0 }, events: [] }; }
        }));
        for (const d of loaded) d.summary = summarize(d.cfg, d.state, d.events);
        const rows = loaded.map(d => d.summary).sort((a, b) => b.score - a.score || b.jobs - a.jobs);

        // the bot's last run time (index.json polled_at), same stamp as on the company pages
        const homeMeta = document.getElementById("poll-meta");
        homeMeta.classList.remove("feed-down");
        homeMeta.textContent = polledAt ? `Last bot run: ${fmtStamp(polledAt)} ${zoneLabel()}` : "";

        const tot = Object.fromEntries(SEV.map(s => [s, 0]));
        for (const r of rows) for (const s of SEV) tot[s] += r.sev[s];

        // ---- recent movement (day / week window, paginated, expandable to 25) ----
        const mvAll = [];
        for (const d of loaded) {
            const reps = d.summary.reps;   // for "times published"
            for (const e of d.events)
                if (CHANGE_TYPES.includes(e.type))
                    mvAll.push({ type: e.type, title: e.title, date: e.date, company: d.cfg.name || d.cfg.slug,
                        slug: d.cfg.slug, url: e.url, location: e.location, times: (reps.get(e.lineage_key) || 0) + 1 });
        }
        mvAll.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));   // newest first

        const MV_WINDOWS = { day: DAY_MS, week: 7 * DAY_MS };
        const MV_ROW = 32;                     // must match .move-feed li height in the CSS
        const mvCompanies = loaded.map(d => d.cfg.name || d.cfg.slug).sort((a, b) => a.localeCompare(b));
        let mvWin = "day", mvPage = 0, mvSize = 10, mvCompany = "", mvQuery = "", mvType = "";

        const mvCaption = h("span", { class: "caption" });
        const mvStats = h("div", { class: "move-row" });
        const mvBody = h("div", { class: "move-feed-wrap" });
        const mvFoot = h("div", { class: "move-foot" });

        // re-renders the feed in place (state stays in this closure) so paging / the
        // window switch never rebuild the map or charts below.
        function refreshMovement() {
            const since = Date.now() - MV_WINDOWS[mvWin];
            const q = mvQuery.toLowerCase();
            // base = window + company + search; the counters show counts of base and, when clicked,
            // filter the rows to that one type on top (so the other counts stay visible).
            const base = mvAll.filter(e =>
                Date.parse(e.date) >= since
                && (!mvCompany || e.company === mvCompany)
                && (!q || (e.title || "").toLowerCase().includes(q) || (e.location || "").toLowerCase().includes(q)));
            const count = t => base.filter(e => e.type === t).length;
            const list = mvType ? base.filter(e => e.type === mvType) : base;
            const total = list.length;

            const win = mvWin === "day" ? "last 24 hours" : "last 7 days";
            mvCaption.textContent = `opens, closes and reposts ${mvCompany ? `at ${mvCompany}` : "across every company"}, ${win}`
                + (mvQuery ? ` matching "${mvQuery}"` : "");
            const toggleType = t => { mvType = mvType === t ? "" : t; mvPage = 0; refreshMovement(); };
            mvStats.replaceChildren(
                moveStat(count("opened"), "opened", sevColor("fresh"), mvType, toggleType),
                moveStat(count("republished"), "republished", sevColor("aging"), mvType, toggleType),
                moveStat(count("closed"), "closed", sevColor("flagged"), mvType, toggleType));

            const pg = pageOf(list, mvPage, mvSize);
            mvPage = pg.page;

            if (total) {
                // reserve a whole page of height so the footer never jumps on a short last page
                mvBody.style.minHeight = `${Math.min(mvSize, total) * MV_ROW}px`;
                mvBody.replaceChildren(h("ul", { class: "move-feed" }, pg.shown.map(f => h("li", {},
                    chip(f.type),
                    f.type !== "closed" && safeUrl(f.url)
                        ? h("a", { class: "mf-role", href: safeUrl(f.url), target: "_blank", rel: "noopener" }, f.title)
                        : h("span", { class: "mf-role", title: f.type === "closed" ? "this role has since closed" : "" }, f.title),
                    h("span", { class: "mf-loc", title: f.location || "" }, f.location || ""),
                    h("span", { class: "mf-times", title: f.times > 1 ? `published ${f.times} times` : "" },
                        f.times > 1 ? `×${f.times}` : ""),
                    h("a", { class: "mf-co", href: `#${f.slug}`, title: `Open ${f.company}` }, f.company),
                    h("span", { class: "mf-when" }, relTime(f.date))))));
            } else {
                mvBody.style.minHeight = "";
                mvBody.replaceChildren(h("p", { class: "caption" },
                    mvCompany || mvQuery || mvType
                        ? `No matching changes in the ${win}.`
                        : `No changes in the ${win}.`));
            }

            mvFoot.replaceChildren(...present([
                sizeToggle(mvSize, total, n => { mvSize = n; mvPage = 0; refreshMovement(); }),
                pager(mvPage, pg.pages, mvSize, total, p => { mvPage = p; refreshMovement(); }),
            ]));
        }

        const mvSeg = h("div", { class: "seg-toggle" }, ["day", "week"].map(w => {
            const b = h("button", { class: mvWin === w ? "active" : "",
                onclick: () => {
                    if (mvWin === w) return;
                    mvWin = w; mvPage = 0;
                    for (const x of mvSeg.children) x.classList.toggle("active", x === b);
                    refreshMovement();
                } }, w === "day" ? "Day" : "Week");
            return b;
        }));

        const mvCoSel = h("select", { class: "mv-co-sel", "aria-label": "Filter by company",
            onchange: e => { mvCompany = e.target.value; mvPage = 0; refreshMovement(); } },
            h("option", { value: "" }, "All companies"),
            ...mvCompanies.map(n => h("option", { value: n }, n)));
        const mvSearch = h("input", { class: "log-search", type: "search", placeholder: "Search roles…",
            "aria-label": "Search recent movement",
            oninput: e => { mvQuery = e.target.value.trim(); mvPage = 0; refreshMovement(); } });
        const mvFilters = h("div", { class: "mv-filters" }, mvCoSel, mvSearch);

        refreshMovement();
        const movement = h("section", {},
            h("div", { class: "home-cards-head" },
                h("h2", {}, "Recent movement"), mvCaption, mvSeg),
            mvFilters, mvStats, mvBody, mvFoot);

        // ---- trend charts ----
        const charts = h("section", {},
            h("h2", {}, "Trends"),
            h("div", { class: "home-charts" },
                plainCard("Severity of all open roles", "how fresh or stale the whole watchlist reads",
                    p => p.replaceChildren(
                        h("div", { class: "sevbar-track" },
                            SEV.map(s => tot[s] ? h("span", { class: `sevbar-seg sev-${s}`, style: `flex:${tot[s]}`, title: `${tot[s]} ${s}` }) : null).filter(Boolean)),
                        h("div", { class: "sevbar-legend" },
                            SEV.map(s => h("span", { class: "sevbar-key", title: SEV_RULES[s] },
                                h("i", { class: `dot sev-${s}` }), h("b", {}, tot[s].toLocaleString("en-US")), " ", s))))),
                h("div", { class: "home-charts-2" },
                    plainCard("Hiring intensity", "open roles per 100 staff, who is hiring hardest for their size",
                        p => Charts.barsH(p, rows.filter(r => r.headcount)
                            .map(r => ({ label: r.cfg.name || r.cfg.slug, value: Math.round(r.jobs / r.headcount * 1000) / 10 }))
                            .sort((a, b) => b.value - a.value), { color: C.blue, unit: "per 100" })),
                    plainCard("Flagged roles by company", "roles 120+ days old or heavily reposted",
                        p => Charts.barsH(p, rows.map(r => ({ label: r.cfg.name || r.cfg.slug, value: r.sev.flagged }))
                            .filter(r => r.value).sort((a, b) => b.value - a.value), { color: sevColor("flagged"), unit: "flagged" })))));

        // lead with the single most telling read: hardest hirer for its size + worst repost pressure
        const topHi = rows.filter(r => r.headcount).map(r => ({ cfg: r.cfg, per: r.jobs / r.headcount * 100 }))
            .sort((a, b) => b.per - a.per)[0];
        const topFl = rows.filter(r => r.sev.flagged).sort((a, b) => b.sev.flagged - a.sev.flagged)[0];
        const same = topHi && topFl && topHi.cfg.slug === topFl.cfg.slug;
        const callout = same
            ? [h("b", {}, topHi.cfg.name || topHi.cfg.slug),
                ` is hiring hardest for its size (${Math.round(topHi.per)} open roles per 100 staff) and carries the most stale or reposted roles (${topFl.sev.flagged} flagged).`]
            : [...(topHi ? [h("b", {}, topHi.cfg.name || topHi.cfg.slug), ` is hiring hardest for its size, ${Math.round(topHi.per)} open roles per 100 staff. `] : []),
                ...(topFl ? [h("b", {}, topFl.cfg.name || topFl.cfg.slug), ` carries the most stale or reposted roles, ${topFl.sev.flagged} flagged.`] : [])];
        const hero = h("section", { class: "home-hero-lead" },
            h("h1", {}, "The hiring pulse of space and defence tech"),
            h("p", { class: "hero-callout" }, callout));

        app.replaceChildren(hero, h("hr", { class: "home-rule" }), movement, charts);
    }

    function initTz() {
        const btn = document.getElementById("tz-toggle");
        if (!btn) return;
        const paint = () => { btn.textContent = tzMode === "utc" ? "UTC" : "Local"; };
        paint();
        btn.addEventListener("click", () => {
            tzMode = tzMode === "utc" ? "local" : "utc";
            store.set("rw-tz", tzMode);
            _fmtCache = {};              // active zone changed; drop the cached formatter
            paint();
            route();                     // re-render current view with the new zone
        });
    }

    // subtle drifting constellation behind the page (nods to satellite constellations)
    function initBackground() {
        const cv = document.getElementById("bg-constellation");
        if (!cv) return;
        const ctx = cv.getContext("2d");
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const N = 130, R = 145, R2 = R * R;
        // links fade with distance; bucketing the fade into a few alpha steps lets each step be
        // stroked as one path, instead of one beginPath/stroke per link (thousands per frame)
        const BUCKETS = 6;
        const bucketStyle = Array.from({ length: BUCKETS }, (_, k) =>
            `rgba(0,170,255,${(0.15 * (1 - (k + 0.5) / BUCKETS)).toFixed(3)})`);
        let cw, ch, pts;
        const seed = () => {
            cw = cv.width = innerWidth; ch = cv.height = innerHeight;
            pts = Array.from({ length: N }, () => ({
                x: Math.random() * cw, y: Math.random() * ch,
                vx: (Math.random() - 0.5) * 0.14, vy: (Math.random() - 0.5) * 0.14,
            }));
        };
        const draw = () => {
            ctx.clearRect(0, 0, cw, ch);
            for (const p of pts) {
                if (!reduce) { p.x += p.vx; p.y += p.vy; }
                if (p.x < 0 || p.x > cw) p.vx *= -1;
                if (p.y < 0 || p.y > ch) p.vy *= -1;
            }
            const paths = Array.from({ length: BUCKETS }, () => new Path2D());
            ctx.fillStyle = "rgba(120,180,255,0.55)";
            for (let i = 0; i < N; i++) {
                const a = pts[i];
                ctx.fillRect(a.x, a.y, 1.4, 1.4);
                for (let j = i + 1; j < N; j++) {
                    const b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
                    if (d2 < R2) {
                        const path = paths[Math.min(BUCKETS - 1, Math.floor(Math.sqrt(d2) / R * BUCKETS))];
                        path.moveTo(a.x, a.y); path.lineTo(b.x, b.y);
                    }
                }
            }
            ctx.lineWidth = 1;
            paths.forEach((path, k) => { ctx.strokeStyle = bucketStyle[k]; ctx.stroke(path); });
            if (!reduce) requestAnimationFrame(draw);
        };
        seed();
        draw();
        let rt = null;
        // resizing the canvas clears it; the animated loop repaints on its own, a static one must redraw
        addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { seed(); if (reduce) draw(); }, 200); });
    }

    async function init() {
        initBackground();
        const [index, geo] = await Promise.all([
            fetchOk("data/index.json").then(r => r.json()),
            fetchOk("data/geocache.json").then(r => r.json()).catch(() => ({ locations: {} })),
        ]);
        companies = index.companies;
        polledAt = index.polled_at || null;
        geocache = geo;
        buildRail();          // persistent left company rail, built once; route() toggles the active chip
        initTz();
        addEventListener("hashchange", () => {
            resetLogState();
            closedQuery = ""; closedPage = 0; closedSev = new Set(); closedSize = 10;
            repQuery = ""; repPage = 0; repSize = 10; repOpen = new Set();
            route();
        });
        // charts size to their container, so a width change redraws them in place. No full
        // route(): that would rebuild the map and reset filters, paging and search focus.
        // Height-only resizes (a mobile keyboard opening) leave the charts alone.
        let rt = null, lastW = innerWidth;
        addEventListener("resize", () => {
            clearTimeout(rt);
            rt = setTimeout(() => {
                if (innerWidth === lastW) return;
                lastW = innerWidth;
                for (const n of document.querySelectorAll("#app .card, #app .pcard")) n._render && n._render();
            }, 200);
        });
        await route();
    }

    init().catch(err => {
        document.getElementById("app").replaceChildren(
            h("p", { class: "caption" }, `Failed to load data/index.json: ${err.message}`));
    });
})();
