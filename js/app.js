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
        blue: tok("--s-blue"), aqua: tok("--s-aqua"), yellow: tok("--s-yellow"),
        red: tok("--s-red"), violet: tok("--s-violet"), gray: tok("--s-gray"),
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
    const fmtDT = iso => iso ? iso.slice(0, 16).replace("T", " ") : "";

    // ---- data ----
    let companies = [];
    let cache = {};        // slug -> {state, events}
    let geocache = { locations: {} };
    let mapInstance = null;
    let logQuery = "";
    let logSev = new Set();   // active severity filters (empty = show all)
    let logPage = 0;          // current page in the event log
    const LOG_PAGE_SIZE = 10;
    let closedQuery = "";
    let closedPage = 0;
    let closedSev = new Set();
    const CLOSED_PAGE_SIZE = 10;
    const defaultSort = () => ({ col: 5, dir: -1 });   // 5 = Published, newest first
    let logSort = defaultSort();
    const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

    async function loadCompany(slug) {
        if (cache[slug]) return cache[slug];
        const [state, evText] = await Promise.all([
            fetch(`data/${slug}/current_state.json`).then(r => r.json()),
            fetch(`data/${slug}/events.jsonl`).then(r => r.text()),
        ]);
        const events = evText.split("\n").filter(Boolean).map(l => JSON.parse(l));
        return (cache[slug] = { state, events });
    }

    // ---- derived series ----
    function monthKey(iso) { return iso.slice(0, 7); }
    function monthRange(events, jobs) {
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
                : (ev.type === "republished" && (ev.mechanism === "new_job_id" || ev.mechanism === "aged_relist")) ? 1 : 0;
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

    function chip(type) { return h("span", { class: `chip ${type}` }, type); }
    function chip2(cls, label) { return h("span", { class: `chip ${cls}` }, label); }

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
                        h("div", {}, chip2(`sev-${s}`, s), h("div", { class: "sev-rule" }, SEV_RULES[s])));
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
        { label: "Observed",  w: 96,  val: r => r.ev.date || "",                  defDir: -1 },
        { label: "Type",      w: 120, val: r => r.ev.type,                        defDir: 1 },
        { label: "Title",     w: 0,   val: r => (r.ev.title || "").toLowerCase(), defDir: 1 },
        { label: "Location",  w: 130, val: r => r.ev.location || "",              defDir: 1 },
        { label: "Severity",  w: 100, val: r => SEV_RANK[r.sev] || 0,             defDir: -1 },
        { label: "Published", w: 150, val: r => r.ev.published_at || "",          defDir: -1 },
    ];

    // Renders an already-sorted, already-paged list of { ev, sev } rows. Sorting and
    // paging live in refreshLog so a header click stays local (no full re-render).
    function logTable(rows, onSort) {
        const head = h("tr", {}, LOG_COLS.map((c, i) => h("th", {
            class: "sortable",
            onclick: () => onSort(i),
        }, c.label, logSort.col === i ? h("span", { class: "sort-arrow" }, logSort.dir === 1 ? "▲" : "▼") : null)));
        const body = rows.map(({ ev, sev }) => h("tr", {},
            h("td", { class: "dt" }, fmtDate(ev.date)),
            h("td", {}, chip(ev.type)),
            h("td", { class: "wrap" },
                ev.type === "headcount_manual" ? `headcount = ${ev.value} (${ev.source})`
                : ev.type === "noted_manual" ? h("span", {}, jobLink(ev), `, first seen ${ev.first_seen} (${ev.source})`)
                : jobLink(ev)),
            h("td", {}, ev.location || ""),
            h("td", {}, sev ? chip2(`sev-${sev}`, sev) : ""),
            h("td", { class: "dt" }, fmtDT(ev.published_at))));
        const colgroup = h("colgroup", {}, LOG_COLS.map(c =>
            h("col", c.w ? { style: `width:${c.w}px` } : {})));
        return h("div", { class: "tablewrap" },
            h("table", { class: "log-table" }, colgroup, h("thead", {}, head), h("tbody", {}, body)));
    }

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
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: '&copy; OpenStreetMap &copy; CARTO', subdomains: "abcd", maxZoom: 11,
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
                color: p.remote ? C.red : "#8fbcf2",
                fillColor: p.remote ? C.red : "#3987e5",
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

        const derived = [
            ["Departments", new Set(jobs.map(j => j.department).filter(Boolean)).size],
            ["Locations", new Set(jobs.map(j => j.location).filter(Boolean)).size],
            ["Remote roles", jobs.filter(j => j.is_remote).length],
            ["Tracking since", events.length ? fmtDate(events[0].date) : "n/a"],
            ["Feed", `${state.source[0].toUpperCase()}${state.source.slice(1)} (public)`],
        ];

        document.getElementById("sidebar").replaceChildren(
            logoBox,
            h("dl", { class: "side-facts" },
                cfg.website ? factRow("Homepage", h("a", { href: cfg.website, target: "_blank", rel: "noopener" },
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
            if (p > r.last) { r.last = p; r.title = ev.title; r.location = ev.location; }
        }
        const openKeys = new Set(jobs.map(j => j.lineage_key));
        const republishesOf = k => (lineage.get(k) || {}).republishes || 0;

        // --- repost severity ---
        // Judged PER POSTING: age from this posting's own publish date, plus how many times
        // the role (lineage) has actually been republished. So several distinct, concurrent
        // roles that merely share a title+location never drag each other's severity — a
        // brand-new posting reads fresh even if an older sibling has lingered for months.
        const sevFor = (publishedAt, reposts) =>
            sevByDays(publishedAt ? Math.floor((Date.now() - Date.parse(publishedAt)) / 86400e3) : 0, reposts);
        const jobSev = j => sevFor(j.published_at, republishesOf(j.lineage_key));
        const eventSev = ev => ["opened", "closed", "republished", "initialized"].includes(ev.type)
            ? sevFor(ev.published_at, republishesOf(ev.lineage_key)) : null;
        const sevCounts = Object.fromEntries(SEV.map(s => [s, jobs.filter(j => jobSev(j) === s).length]));
        // click a pill to filter the event log to that severity (multiple active)
        const logLegend = severityLegend(sevCounts, logSev, () => { logPage = 0; refreshLog(); });

        document.getElementById("poll-meta").textContent =
            `Updated ${fmtDate(state.fetched_at)}, ${state.fetched_at.slice(11, 16)} UTC`;
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
        const months = monthRange(events, jobs);
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
        const weekEvents = events.filter(e => ["opened", "closed", "republished"].includes(e.type));
        const weeks = [...new Set(weekEvents.map(e => weekStart(e.date)))].sort().slice(-16);
        const wkSeries = [
            { name: "opened", color: C.aqua },
            { name: "republished", color: C.yellow },
            { name: "closed", color: C.red },
        ].map(s => ({ ...s, values: weeks.map(w => weekEvents.filter(e => e.type === s.name && weekStart(e.date) === w).length) }));

        const gridTime = h("div", { class: "chart-grid" },
            card("Open roles over time", "replayed from the event log, carried forward to today",
                p => oot.length < 2
                    ? Charts.emptyNote(p, `${oot.length} data point so far (${state.job_count} open roles). The line fills in once tracking spans a day.`)
                    : Charts.timeLine(p, [{ name: "open roles", color: C.blue, points: oot }], { area: true, zeroBase: false })),
            card("Events per week", "Stacked by type. Initial import excluded.",
                p => Charts.columns(p, weeks, wkSeries,
                    { emptyMsg: "No post-import events yet. Fills in as the daily polls observe changes." })),
            card("Headcount", "manual entries only (public annual sources, never automated)",
                p => headcounts.length < 2
                    ? Charts.emptyNote(p, headcounts.length
                        ? `One entry: ${lastHc.value.toLocaleString("en-US")} (${lastHc.source}, ${fmtDate(lastHc.date)}). A trend needs a second one.`
                        : "No headcount entries yet. Add one with add_headcount.py.")
                    : Charts.timeLine(p, [{ name: "headcount", color: C.violet, points: headcounts.map(e => ({ t: new Date(e.date), v: e.value })) }], { zeroBase: false })));

        // --- republished roles --- (the flagship view; only shown once there is data)
        const repeats = [...lineage.entries()].filter(([, r]) => r.republishes > 0)
            .sort((a, b) => b[1].republishes - a[1].republishes);
        const repSection = repeats.length
            ? h("section", {},
                h("h2", {}, "Republished roles"),
                h("div", { class: "tablewrap" }, h("table", {},
                    h("thead", {}, h("tr", {},
                        h("th", {}, "Role"), h("th", {}, "Location"), h("th", {}, "Times published"),
                        h("th", {}, "First seen"), h("th", {}, "Last published"), h("th", {}, "Status"))),
                    h("tbody", {}, repeats.map(([key, r]) => h("tr", {},
                        h("td", { class: "wrap" },
                            h("span", { class: "chip republished" }, "republished"), " ", r.title),
                        h("td", {}, r.location || ""),
                        h("td", { class: "num" }, String(r.republishes + 1)),
                        h("td", { class: "dt" }, fmtDate(r.first)),
                        h("td", { class: "dt" }, fmtDate(r.last)),
                        h("td", {}, h("span", { class: `chip ${openKeys.has(key) ? "opened" : "closed"}` },
                            openKeys.has(key) ? "open" : "closed"))))))))
            : null;

        // --- event log ---
        // the event log is the live roster: only events for postings still in the feed.
        // once a posting closes (its id leaves the feed) it drops out of here and lives
        // solely in the Closed roles section below.
        const openJobIds = new Set(jobs.map(j => j.job_id));
        const allLogEvents = events.filter(e => e.type !== "headcount_manual" && openJobIds.has(e.job_id));
        const matchQuery = ev => {
            const q = logQuery.trim().toLowerCase();
            if (!q) return true;
            return (ev.title || "").toLowerCase().includes(q)
                || (ev.location || "").toLowerCase().includes(q)
                || (ev.type || "").toLowerCase().includes(q);
        };
        const onSort = i => {
            if (logSort.col === i) logSort.dir *= -1;
            else logSort = { col: i, dir: LOG_COLS[i].defDir };
            logPage = 0;
            refreshLog();   // local: no full re-render, so the map/charts aren't rebuilt
        };

        // The table and its controls re-render locally on search / sort / paging so the
        // search box keeps focus and the rest of the page (map, charts) isn't rebuilt.
        const logBody = h("div");
        const logControls = h("span", { class: "log-controls" });
        const bottomWrap = h("div");
        function refreshLog() {
            const col = LOG_COLS[logSort.col];
            const decorated = allLogEvents
                .filter(ev => matchQuery(ev) && (logSev.size === 0 || logSev.has(eventSev(ev))))
                .map(ev => ({ ev, sev: eventSev(ev) }));
            decorated.sort((a, b) => {
                const va = col.val(a), vb = col.val(b);
                return (va < vb ? -1 : va > vb ? 1 : 0) * logSort.dir;
            });
            const total = decorated.length;
            const ds = defaultSort();
            const filtering = logQuery.trim() || logSev.size;
            const modified = filtering || logSort.col !== ds.col || logSort.dir !== ds.dir;

            const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
            logPage = Math.min(Math.max(logPage, 0), pages - 1);
            const shown = decorated.slice(logPage * LOG_PAGE_SIZE, logPage * LOG_PAGE_SIZE + LOG_PAGE_SIZE);
            logBody.replaceChildren(logTable(shown, onSort));

            logControls.replaceChildren(...[
                modified ? h("button", {
                    class: "mini-btn",
                    onclick: () => { logQuery = ""; logSev = new Set(); logPage = 0; logSort = defaultSort(); route(); },
                }, "Reset") : null,
            ].filter(Boolean));

            // bottom: Prev/Next pager, matching Closed roles (shown when more than one page)
            bottomWrap.replaceChildren(...(pages > 1 ? [h("div", { class: "log-pager" },
                h("button", { class: "mini-btn", disabled: logPage === 0,
                    onclick: () => { logPage--; refreshLog(); } }, "‹ Prev"),
                h("span", { class: "log-pageinfo" },
                    `${logPage * LOG_PAGE_SIZE + 1}–${Math.min(total, (logPage + 1) * LOG_PAGE_SIZE)} of ${total}`),
                h("button", { class: "mini-btn", disabled: logPage >= pages - 1,
                    onclick: () => { logPage++; refreshLog(); } }, "Next ›"))] : []));
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
            ? Math.max(0, Math.floor((Date.parse(ev.date) - Date.parse(ev.published_at)) / 86400e3)) : 0;
        const daysListed = ev => (ev.published_at && ev.date) ? String(daysListedNum(ev)) : "";
        // severity a role had WHEN IT CLOSED (from how long it was listed, not "now")
        const closedSevOf = ev => sevByDays(daysListedNum(ev), republishesOf(ev.lineage_key));
        const CLOSED_COLS = [
            { label: "Closed", w: 96 }, { label: "Title", w: 0 }, { label: "Location", w: 130 },
            { label: "Severity", w: 100 }, { label: "Published", w: 150 }, { label: "Days listed", w: 120 },
        ];
        let closedSection;
        if (!closedAll.length) {
            closedSection = h("section", {}, h("h2", {}, "Closed roles"),
                h("p", { class: "caption" }, "No roles have closed since tracking began."));
        } else {
            const closedSevCounts = Object.fromEntries(SEV.map(s => [s, closedAll.filter(ev => closedSevOf(ev) === s).length]));
            const closedMatch = ev => {
                const q = closedQuery.trim().toLowerCase();
                return !q || (ev.title || "").toLowerCase().includes(q) || (ev.location || "").toLowerCase().includes(q);
            };
            const closedBody = h("div");
            const closedPager = h("div");
            const refreshClosed = () => {
                const filtered = closedAll.filter(ev =>
                    closedMatch(ev) && (closedSev.size === 0 || closedSev.has(closedSevOf(ev))));
                const pages = Math.max(1, Math.ceil(filtered.length / CLOSED_PAGE_SIZE));
                closedPage = Math.min(Math.max(closedPage, 0), pages - 1);
                const shown = filtered.slice(closedPage * CLOSED_PAGE_SIZE, closedPage * CLOSED_PAGE_SIZE + CLOSED_PAGE_SIZE);
                closedBody.replaceChildren(h("div", { class: "tablewrap" },
                    h("table", { class: "log-table" },
                        h("colgroup", {}, CLOSED_COLS.map(c => h("col", c.w ? { style: `width:${c.w}px` } : {}))),
                        h("thead", {}, h("tr", {}, CLOSED_COLS.map(c => h("th", {}, c.label)))),
                        h("tbody", {}, shown.map(ev => h("tr", {},
                            h("td", { class: "dt" }, fmtDate(ev.date)),
                            h("td", { class: "wrap" }, jobLink(ev)),
                            h("td", {}, ev.location || ""),
                            h("td", {}, chip2(`sev-${closedSevOf(ev)}`, closedSevOf(ev))),
                            h("td", { class: "dt" }, fmtDT(ev.published_at)),
                            h("td", { class: "num" }, daysListed(ev))))))));
                closedPager.replaceChildren(...(pages > 1 ? [h("div", { class: "log-pager" },
                    h("button", { class: "mini-btn", disabled: closedPage === 0, onclick: () => { closedPage--; refreshClosed(); } }, "‹ Prev"),
                    h("span", { class: "log-pageinfo" },
                        `${closedPage * CLOSED_PAGE_SIZE + 1}–${Math.min(filtered.length, (closedPage + 1) * CLOSED_PAGE_SIZE)} of ${filtered.length}`),
                    h("button", { class: "mini-btn", disabled: closedPage >= pages - 1, onclick: () => { closedPage++; refreshClosed(); } }, "Next ›"))] : []));
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
                        h("div", { class: "sect-head" }, h("h2", {}, "Closed roles"), closedSearch),
                        closedBody),
                    closedLegend),
                closedPager);   // pager below the grid, so the legend stops at the last row
        }

        app.replaceChildren(...[
            hero,
            logSection,                                                   // event log up top
            repSection,                                                   // republished roles — flagship view, above the graphs
            h("section", {}, h("h2", {}, "Current picture"), gridNow),    // stat graphs below
            h("section", {}, h("h2", {}, "Over time"), gridTime),
            closedSection,                                                // closed-jobs log at the bottom
        ].filter(Boolean));

        setupMap(mapEl, jobs);   // must run after the element is attached to the DOM
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
        if (!slug) { await renderHome(); return; }
        const cfg = companies.find(c => c.slug === slug) || {};
        document.getElementById("cs-name").textContent = cfg.name || slug;
        try {
            renderCompany(slug, await loadCompany(slug));
        } catch (err) {
            document.getElementById("app").replaceChildren(
                h("p", { class: "caption" }, `Failed to load data for ${slug}: ${err.message}`));
        }
    }

    // ---- overview home ----
    function relTime(iso) {
        const d = Math.floor((Date.now() - Date.parse(iso)) / 86400e3);
        if (d <= 0) return "today";
        if (d === 1) return "yesterday";
        if (d < 30) return `${d}d ago`;
        if (d < 365) return `${Math.floor(d / 30)}mo ago`;
        return `${Math.floor(d / 365)}y ago`;
    }

    function summarize(cfg, state, events) {
        const reps = new Map();
        let last = null, lastHc = null, changes = 0;
        for (const ev of events) {
            if (ev.type === "republished") reps.set(ev.lineage_key, (reps.get(ev.lineage_key) || 0) + 1);
            if (["opened", "closed", "republished"].includes(ev.type)) {
                changes++;
                if (!last || ev.date > last) last = ev.date;
            }
            if (ev.type === "headcount_manual") lastHc = ev.value;
        }
        const now = Date.now();
        const sev = { fresh: 0, aging: 0, stale: 0, flagged: 0 };
        for (const j of state.jobs) {
            const days = j.published_at ? Math.floor((now - Date.parse(j.published_at)) / 86400e3) : 0;
            sev[sevByDays(days, reps.get(j.lineage_key) || 0)]++;
        }
        // "repost pressure": how stale/recycled the roster reads — used to rank the cards
        const score = sev.flagged * 3 + sev.stale * 2 + sev.aging;
        return { cfg, jobs: state.job_count, sev, score, last, headcount: lastHc, changes };
    }

    const sevColor = s => tok({ fresh: "--st-good", aging: "--st-warning", stale: "--st-serious", flagged: "--st-critical" }[s]);

    function plainCard(title, caption, render) {
        const plot = h("div", { class: "plot" });
        render(plot);
        return h("div", { class: "pcard" }, h("h3", {}, title), h("p", { class: "caption" }, caption), plot);
    }

    function moveStat(n, label, color) {
        return h("div", { class: "move-stat" }, h("b", { style: `color:${color}` }, String(n)), h("span", {}, label));
    }

    function recentMovement(loaded) {
        const evs = [];
        for (const d of loaded) for (const e of d.events)
            if (["opened", "closed", "republished"].includes(e.type))
                evs.push({ type: e.type, title: e.title, date: e.date, company: d.cfg.name || d.cfg.slug, url: e.url });
        evs.sort((a, b) => (a.date < b.date ? 1 : -1));
        const since = Date.now() - 7 * 86400e3;
        const wk = evs.filter(e => Date.parse(e.date) >= since);
        const n = t => wk.filter(e => e.type === t).length;
        return { opened: n("opened"), closed: n("closed"), republished: n("republished"), feed: evs.slice(0, 8) };
    }

    // slim company row for the overview sidebar nav: logo + a severity mini-bar
    function navItem(r) {
        const cfg = r.cfg;
        const logo = h("img", { src: cfg.logo || `assets/companies/${cfg.slug}.png`, alt: "",
            class: cfg.logo_invert === false ? "logo-keep" : "" });
        const box = h("span", { class: "nav-logo" }, logo);
        logo.onerror = () => box.replaceChildren(h("b", { class: "nav-fallback" }, cfg.name || cfg.slug));
        return h("a", { class: "nav-co", href: `#${cfg.slug}`, "data-co": cfg.slug, title: `${cfg.name || cfg.slug}: ${r.jobs} open, ${r.sev.flagged} flagged` }, box);
    }

    async function renderHome() {
        document.getElementById("cs-name").textContent = "Overview";
        const app = document.getElementById("app");
        app.replaceChildren(h("p", { class: "caption" }, "Loading overview…"));

        const loaded = await Promise.all(companies.map(async c => {
            try { const { state, events } = await loadCompany(c.slug); return { cfg: c, state, events }; }
            catch { return { cfg: c, state: { jobs: [], job_count: 0 }, events: [] }; }
        }));
        const rows = loaded.map(d => summarize(d.cfg, d.state, d.events))
            .sort((a, b) => b.score - a.score || b.jobs - a.jobs);

        // last-updated = the freshest snapshot timestamp across all companies
        const lastUpdate = loaded.map(d => d.state && d.state.fetched_at).filter(Boolean).sort().pop();
        document.getElementById("poll-meta").textContent = lastUpdate
            ? `Updated ${fmtDate(lastUpdate)}, ${lastUpdate.slice(11, 16)} UTC` : "";

        const tot = { fresh: 0, aging: 0, stale: 0, flagged: 0 };
        let open = 0, changes = 0;
        for (const r of rows) { open += r.jobs; changes += r.changes || 0; for (const s of SEV) tot[s] += r.sev[s]; }
        const concern = tot.stale + tot.flagged;

        // ---- sidebar: short intro + company nav (alphabetical) ----
        const nav = [...rows].sort((a, b) =>
            (a.cfg.name || a.cfg.slug).localeCompare(b.cfg.name || b.cfg.slug, undefined, { sensitivity: "base" }));
        document.getElementById("sidebar").replaceChildren(
            h("div", { class: "side-intro" },
                h("p", {},
                    h("b", {}, "RepostWatch"),
                    ` scrapes the public job feeds of ${rows.length} space, Earth-observation and defence companies and logs every time a role opens, closes, or is quietly republished.`,
                    h("br"),
                    "How a company treats its postings is a quiet tell of what it is up to.")),
            h("div", { class: "side-sect" }, "Companies"),
            h("nav", { class: "co-nav" }, nav.map(navItem)));

        // ---- recent movement ----
        const mv = recentMovement(loaded);
        const movement = h("section", {},
            h("div", { class: "home-cards-head" }, h("h2", {}, "Recent movement"),
                h("span", { class: "caption" }, "opens, closes and reposts across every company, last 7 days")),
            h("div", { class: "move-row" },
                moveStat(mv.opened, "opened", sevColor("fresh")),
                moveStat(mv.republished, "republished", sevColor("aging")),
                moveStat(mv.closed, "closed", sevColor("flagged"))),
            mv.feed.length
                ? h("ul", { class: "move-feed" }, mv.feed.map(f => h("li", {},
                    h("span", { class: `chip ${f.type}` }, f.type),
                    f.type !== "closed" && safeUrl(f.url)
                        ? h("a", { class: "mf-role", href: safeUrl(f.url), target: "_blank", rel: "noopener" }, f.title)
                        : h("span", { class: "mf-role", title: f.type === "closed" ? "this role has since closed" : "" }, f.title),
                    h("span", { class: "mf-co" }, f.company),
                    h("span", { class: "mf-when" }, relTime(f.date)))))
                : h("p", { class: "caption" }, "No changes logged yet. Fills in as the polls observe opens and closes."),
            (mv.opened + mv.closed + mv.republished) > mv.feed.length
                ? h("p", { class: "move-more" }, `Showing the ${mv.feed.length} most recent of ${(mv.opened + mv.closed + mv.republished).toLocaleString("en-US")} changes this week.`)
                : null);

        // ---- trend charts ----
        const charts = h("section", {},
            h("h2", {}, "Trends"),
            h("div", { class: "home-charts" },
                plainCard("Severity of all open roles", "how fresh or stale the whole watchlist reads",
                    p => p.replaceChildren(
                        h("div", { class: "sevbar-track" },
                            SEV.map(s => tot[s] ? h("span", { class: `hc-seg sev-${s}`, style: `flex:${tot[s]}`, title: `${tot[s]} ${s}` }) : null).filter(Boolean)),
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

    function initSwitcher() {
        const wrap = document.getElementById("company-switcher"),
            btn = document.getElementById("cs-btn"),
            menu = document.getElementById("cs-menu"),
            search = document.getElementById("cs-search"),
            list = document.getElementById("cs-list");
        const close = () => { menu.hidden = true; wrap.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); };
        const fill = q => {
            const ql = (q || "").trim().toLowerCase();
            const matches = companies.filter(c =>
                (c.name || c.slug).toLowerCase().includes(ql) || c.slug.includes(ql))
                .sort((a, b) => (a.name || a.slug).localeCompare(b.name || b.slug, undefined, { sensitivity: "base" }));
            list.replaceChildren(...(matches.length
                ? matches.map(c => h("a", {
                    href: `#${c.slug}`, role: "option",
                    class: c.slug === currentSlug() ? "active" : "",
                    onclick: close,
                }, c.name || c.slug))
                : [h("div", { class: "cs-empty" }, "No matches")]));
        };
        btn.addEventListener("click", () => {
            const open = menu.hidden;
            menu.hidden = !open; wrap.classList.toggle("open", open); btn.setAttribute("aria-expanded", String(open));
            if (open) { search.value = ""; fill(""); search.focus(); }
        });
        search.addEventListener("input", () => fill(search.value));
        search.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
        document.addEventListener("click", e => { if (!e.target.closest("#company-switcher")) close(); });
        // a lone company isn't worth a search box
        if (companies.length < 2) search.style.display = "none";
    }

    // subtle drifting constellation behind the page (nods to satellite constellations)
    function initBackground() {
        const cv = document.getElementById("bg-constellation");
        if (!cv) return;
        const ctx = cv.getContext("2d");
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const N = 130, R = 145;
        let w, h, pts;
        const seed = () => {
            w = cv.width = innerWidth; h = cv.height = innerHeight;
            pts = Array.from({ length: N }, () => ({
                x: Math.random() * w, y: Math.random() * h,
                vx: (Math.random() - 0.5) * 0.14, vy: (Math.random() - 0.5) * 0.14,
            }));
        };
        seed();
        let rt = null;
        addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(seed, 200); });
        const draw = () => {
            ctx.clearRect(0, 0, w, h);
            for (const p of pts) {
                if (!reduce) { p.x += p.vx; p.y += p.vy; }
                if (p.x < 0 || p.x > w) p.vx *= -1;
                if (p.y < 0 || p.y > h) p.vy *= -1;
            }
            for (let i = 0; i < N; i++) {
                const a = pts[i];
                ctx.fillStyle = "rgba(120,180,255,0.55)";
                ctx.fillRect(a.x, a.y, 1.4, 1.4);
                for (let j = i + 1; j < N; j++) {
                    const b = pts[j], d = Math.hypot(a.x - b.x, a.y - b.y);
                    if (d < R) {
                        ctx.strokeStyle = `rgba(0,170,255,${0.15 * (1 - d / R)})`;
                        ctx.lineWidth = 1;
                        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                    }
                }
            }
            if (!reduce) requestAnimationFrame(draw);
        };
        draw();
    }

    async function init() {
        initBackground();
        const [index, geo] = await Promise.all([
            fetch("data/index.json").then(r => r.json()),
            fetch("data/geocache.json").then(r => r.json()).catch(() => ({ locations: {} })),
        ]);
        companies = index.companies;
        geocache = geo;
        initSwitcher();
        addEventListener("hashchange", () => {
            logQuery = ""; logSev = new Set(); logPage = 0; logSort = defaultSort();
            closedQuery = ""; closedPage = 0; closedSev = new Set();
            route();
        });
        let rt = null;
        addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(route, 200); });
        await route();
    }

    init().catch(err => {
        document.getElementById("app").replaceChildren(
            h("p", { class: "caption" }, `Failed to load data/index.json: ${err.message}`));
    });
})();
