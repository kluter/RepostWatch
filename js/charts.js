/* ============================================================
   RepostWatch – charts.js
   Small hand-rolled SVG chart components, no dependencies.
   Mark specs: bars ≤24px with a 4px rounded data-end (square at
   the baseline), 2px lines, ≥8px markers with a 2px surface ring,
   2px surface gaps between touching fills, hairline gridlines,
   hover tooltips on every chart.
   ============================================================ */
"use strict";

const Charts = (() => {

    const NS = "http://www.w3.org/2000/svg";
    const CSS = getComputedStyle(document.documentElement);
    const tok = name => CSS.getPropertyValue(name).trim();

    // ---- tooltip singleton (textContent only — labels are untrusted data) ----
    let ttEl = null;
    function tooltip() {
        if (!ttEl) { ttEl = document.createElement("div"); ttEl.id = "tooltip"; document.body.appendChild(ttEl); }
        return ttEl;
    }
    function showTooltip(cx, cy, title, rows) {
        const tt = tooltip();
        tt.replaceChildren();
        if (title) {
            const t = document.createElement("div");
            t.className = "tt-title"; t.textContent = title;
            tt.appendChild(t);
        }
        for (const r of rows) {
            const row = document.createElement("div"); row.className = "tt-row";
            if (r.color) {
                const k = document.createElement("span"); k.className = "tt-key";
                k.style.background = r.color; row.appendChild(k);
            }
            const v = document.createElement("span"); v.className = "tt-val";
            v.textContent = r.value; row.appendChild(v);
            if (r.name) {
                const n = document.createElement("span"); n.className = "tt-name";
                n.textContent = r.name; row.appendChild(n);
            }
            tt.appendChild(row);
        }
        tt.style.display = "block";
        const pad = 12, w = tt.offsetWidth, h = tt.offsetHeight;
        let x = cx + pad, y = cy + pad;
        if (x + w > innerWidth - 8) x = cx - w - pad;
        if (y + h > innerHeight - 8) y = cy - h - pad;
        tt.style.left = x + "px"; tt.style.top = y + "px";
    }
    function hideTooltip() { if (ttEl) ttEl.style.display = "none"; }

    // ---- svg helpers ----
    function el(name, attrs, parent) {
        const n = document.createElementNS(NS, name);
        for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
        if (parent) parent.appendChild(n);
        return n;
    }
    function svgRoot(container, w, h) {
        const s = el("svg", { viewBox: `0 0 ${w} ${h}`, width: w, height: h });
        container.replaceChildren(s);
        return s;
    }
    // horizontal bar: square at left baseline, 4px rounded right data-end
    function hBarPath(x, y, w, h) {
        const r = Math.min(4, w, h / 2);
        return `M${x},${y} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} H${x} Z`;
    }
    // column: square at bottom baseline, 4px rounded top data-end
    function colPath(x, yTop, w, hgt, rounded) {
        if (!rounded) return `M${x},${yTop} h${w} v${hgt} h${-w} Z`;
        const r = Math.min(4, hgt, w / 2);
        return `M${x},${yTop + hgt} V${yTop + r} A${r},${r} 0 0 1 ${x + r},${yTop} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${yTop + r} V${yTop + hgt} Z`;
    }
    function niceStep(range, n = 4) {
        const raw = (range || 1) / n;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
    }
    function niceTicks(maxVal, n = 4) {
        if (maxVal <= 0) return [0, 1];
        const step = niceStep(maxVal, n);
        const ticks = [];
        for (let v = 0; v <= maxVal + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
        if (ticks[ticks.length - 1] < maxVal) ticks.push(ticks[ticks.length - 1] + step);
        return ticks;
    }
    // ticks over an arbitrary [min,max] band (for zoomed, non-zero-based axes)
    function niceTicksRange(min, max, n = 4) {
        const step = niceStep(max - min, n);
        const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
        const ticks = [];
        for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
        return ticks;
    }
    const fmt = n => n.toLocaleString("en-US");

    function emptyNote(container, msg) {
        const d = document.createElement("div");
        d.className = "empty-note"; d.textContent = msg;
        container.replaceChildren(d);
    }

    function legend(container, series, shape) {
        if (series.length < 2) return;   // single series: the title names it
        const lg = document.createElement("div"); lg.className = "legend";
        for (const s of series) {
            const key = document.createElement("span"); key.className = "key";
            const sw = document.createElement("span");
            sw.className = shape === "line" ? "swatch-line" : "swatch-rect";
            sw.style.background = s.color;
            key.append(sw, document.createTextNode(s.name));
            lg.appendChild(key);
        }
        container.appendChild(lg);
    }

    // ================= horizontal bars =================
    // rows: [{label, value}] — magnitude with one hue
    function barsH(container, rows, opts = {}) {
        if (!rows.length) return emptyNote(container, opts.emptyMsg || "No data yet.");
        const color = opts.color || tok("--s-blue");
        const width = Math.max(280, container.clientWidth || 320);
        const barH = 16, gap = 8, labelW = Math.min(230, width * 0.38);
        const padR = 40;
        const height = rows.length * (barH + gap) + 4;
        const s = svgRoot(container, width, height);
        const maxV = Math.max(...rows.map(r => r.value));
        const plotW = width - labelW - padR;

        rows.forEach((r, i) => {
            const y = i * (barH + gap) + 2;
            const w = Math.max(1, (r.value / maxV) * plotW);
            const maxChars = Math.floor((labelW - 12) / 5.8);   // ~5.8px per char at 11px
            el("text", { x: labelW - 8, y: y + barH / 2 + 3.5, "text-anchor": "end", class: "bar-cat-label" }, s)
                .textContent = r.label.length > maxChars ? r.label.slice(0, maxChars - 1) + "…" : r.label;
            const bar = el("path", { d: hBarPath(labelW, y, w, barH), fill: color }, s);
            el("text", { x: labelW + w + 6, y: y + barH / 2 + 3.5, class: "value-label" }, s).textContent = fmt(r.value);
            // hit target bigger than the mark: full row band
            const hit = el("rect", { x: 0, y: y - gap / 2, width, height: barH + gap, fill: "transparent" }, s);
            hit.addEventListener("pointermove", e => {
                bar.setAttribute("opacity", "0.82");
                showTooltip(e.clientX, e.clientY, r.label, [{ color, value: fmt(r.value), name: opts.unit || "" }]);
            });
            hit.addEventListener("pointerleave", () => { bar.removeAttribute("opacity"); hideTooltip(); });
        });
    }

    // ================= columns (single or stacked) =================
    // categories: ["2026-01", ...]; series: [{name, color, values[]}]
    function columns(container, categories, series, opts = {}) {
        const totals = categories.map((_, i) => series.reduce((a, s) => a + (s.values[i] || 0), 0));
        if (!categories.length || Math.max(...totals) === 0)
            return emptyNote(container, opts.emptyMsg || "No data yet.");

        const width = Math.max(280, container.clientWidth || 320);
        const height = opts.height || 180;
        const padL = 30, padR = 8, padT = 8, padB = 20;
        const plotW = width - padL - padR, plotH = height - padT - padB;
        const s = svgRoot(container, width, height);

        const ticks = niceTicks(Math.max(...totals));
        const maxV = ticks[ticks.length - 1];
        const y = v => padT + plotH - (v / maxV) * plotH;

        for (const t of ticks) {
            el("line", { x1: padL, x2: width - padR, y1: y(t), y2: y(t), stroke: tok("--grid"), "stroke-width": 1 }, s);
            el("text", { x: padL - 5, y: y(t) + 3, "text-anchor": "end", class: "axis-label" }, s).textContent = fmt(t);
        }
        el("line", { x1: padL, x2: width - padR, y1: y(0), y2: y(0), stroke: tok("--baseline"), "stroke-width": 1 }, s);

        const band = plotW / categories.length;
        const colW = Math.min(24, band * 0.62);
        const SEG_GAP = 2;   // surface gap between stacked segments

        const labelEvery = Math.ceil(categories.length / Math.floor(plotW / 52));
        categories.forEach((cat, i) => {
            const x = padL + i * band + (band - colW) / 2;
            let acc = 0;
            const segs = [];
            series.forEach(sr => {
                const v = sr.values[i] || 0;
                if (v > 0) segs.push({ sr, v, from: acc, to: acc + v }); acc += v;
            });
            segs.forEach((seg, k) => {
                const yTop = y(seg.to), yBot = y(seg.from);
                const gapTop = k < segs.length - 1 ? SEG_GAP / 2 : 0;
                const gapBot = k > 0 ? SEG_GAP / 2 : 0;
                const hgt = Math.max(1, yBot - yTop - gapTop - gapBot);
                seg.node = el("path", {
                    d: colPath(x, yTop + gapTop, colW, hgt, k === segs.length - 1),
                    fill: seg.sr.color,
                }, s);
            });
            if (i % labelEvery === 0)
                el("text", { x: x + colW / 2, y: height - 6, "text-anchor": "middle", class: "axis-label" }, s)
                    .textContent = opts.catLabel ? opts.catLabel(cat) : cat;
            // hit target: the whole category band
            const hit = el("rect", { x: padL + i * band, y: padT, width: band, height: plotH, fill: "transparent" }, s);
            hit.addEventListener("pointermove", e => {
                segs.forEach(seg => seg.node.setAttribute("opacity", "0.82"));
                const rows = series.map(sr => ({ color: sr.color, value: fmt(sr.values[i] || 0), name: sr.name }))
                    .filter(r => series.length === 1 || r.value !== "0");
                showTooltip(e.clientX, e.clientY, opts.catTitle ? opts.catTitle(cat) : cat,
                    rows.length ? rows : [{ value: "0", name: "events" }]);
            });
            hit.addEventListener("pointerleave", () => { segs.forEach(seg => seg.node.removeAttribute("opacity")); hideTooltip(); });
        });
        legend(container, series, "rect");
    }

    // ================= line (time series) =================
    // series: [{name, color, points: [{t: Date, v: number}]}]
    function timeLine(container, series, opts = {}) {
        const all = series.flatMap(s => s.points);
        if (!all.length) return emptyNote(container, opts.emptyMsg || "No data yet.");

        const width = Math.max(280, container.clientWidth || 320);
        const height = opts.height || 180;
        const padL = 38, padR = 14, padT = 8, padB = 20;
        const plotW = width - padL - padR, plotH = height - padT - padB;
        const s = svgRoot(container, width, height);
        const surface = tok("--panel");

        let t0 = Math.min(...all.map(p => +p.t)), t1 = Math.max(...all.map(p => +p.t));
        if (t0 === t1) { t0 -= 86400e3 * 3; t1 += 86400e3 * 3; }   // single point: pad the domain
        const dataMax = Math.max(...all.map(p => p.v)), dataMin = Math.min(...all.map(p => p.v));
        let ticks, vMin, yMax;
        if (opts.zeroBase === false) {
            // zoom to the data band with padding so small ups/downs are visible instead of
            // being flattened against a 0 baseline; snap the bounds to round tick values.
            // pad >= 2 keeps the span >= 4 so counts get whole-number ticks, not 123.5.
            const pad = Math.max(2, (dataMax - dataMin) * 0.35);
            ticks = niceTicksRange(Math.max(0, dataMin - pad), dataMax + pad);
            vMin = ticks[0];
            yMax = ticks[ticks.length - 1];
        } else {
            ticks = niceTicks(dataMax);
            vMin = 0;
            yMax = ticks[ticks.length - 1];
        }
        const x = t => padL + ((+t - t0) / (t1 - t0)) * plotW;
        const y = v => padT + plotH - ((v - vMin) / (yMax - vMin || 1)) * plotH;

        for (const t of ticks) {
            if (t < vMin) continue;
            el("line", { x1: padL, x2: width - padR, y1: y(t), y2: y(t), stroke: tok("--grid"), "stroke-width": 1 }, s);
            el("text", { x: padL - 5, y: y(t) + 3, "text-anchor": "end", class: "axis-label" }, s).textContent = fmt(t);
        }

        // x labels: even PIXEL targets snapped to real days, then de-collided using each
        // label's box. Pixel spacing (not index spacing) keeps labels apart when points
        // bunch up in time — e.g. the "today" anchor sitting a day after the last event.
        const fmtDate = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        const dayVals = [...new Set(all.map(p => +p.t))].sort((a, b) => a - b);
        const maxLab = Math.min(width > 500 ? 5 : 3, dayVals.length);
        const targets = Array.from({ length: maxLab }, (_, i) =>
            padL + (maxLab <= 1 ? 0 : i * plotW / (maxLab - 1)));
        let picked = [...new Set(targets.map(tx =>
            dayVals.reduce((b, v) => Math.abs(x(v) - tx) < Math.abs(x(b) - tx) ? v : b, dayVals[0])))]
            .sort((a, b) => a - b);
        // start/end labels are anchored inward, so their box leans one way; middles are centred.
        const HALF = 32;   // ~half a 10px "YYYY-MM-DD" label, in px
        const boxOf = (d, i, n) => i === 0 ? [x(d), x(d) + 2 * HALF]
            : i === n - 1 ? [x(d) - 2 * HALF, x(d)] : [x(d) - HALF, x(d) + HALF];
        for (let again = true; again; ) {          // drop overlapping middle labels until none touch
            again = false;
            for (let i = 1; i < picked.length - 1 && !again; i++) {
                const [l, r] = boxOf(picked[i], i, picked.length);
                if (l < boxOf(picked[i - 1], i - 1, picked.length)[1] + 4
                    || r > boxOf(picked[i + 1], i + 1, picked.length)[0] - 4) { picked.splice(i, 1); again = true; }
            }
        }
        if (picked.length === 2 && boxOf(picked[0], 0, 2)[1] > boxOf(picked[1], 1, 2)[0]) picked.shift();
        for (let k = 0; k < picked.length; k++) {
            const tt = picked[k];
            el("text", {
                x: x(tt), y: height - 6,
                "text-anchor": k === 0 ? "start" : k === picked.length - 1 ? "end" : "middle", class: "axis-label",
            }, s).textContent = fmtDate(new Date(tt));
        }

        for (const sr of series) {
            const pts = [...sr.points].sort((a, b) => a.t - b.t);
            const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join(" ");
            if (opts.area && pts.length > 1) {
                el("path", {
                    d: `${d} L${x(pts[pts.length - 1].t)},${y(vMin)} L${x(pts[0].t)},${y(vMin)} Z`,
                    fill: sr.color, opacity: 0.1,
                }, s);
            }
            if (pts.length > 1)
                el("path", { d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, s);
            // markers on sparse series and on the endpoint, with a 2px surface ring
            const markAll = pts.length <= 20;
            pts.forEach((p, i) => {
                if (markAll || i === pts.length - 1)
                    el("circle", { cx: x(p.t), cy: y(p.v), r: 4, fill: sr.color, stroke: surface, "stroke-width": 2 }, s);
            });
            sr._pts = pts;
        }

        // crosshair + tooltip: snap to nearest data x
        const xs = [...new Set(all.map(p => +p.t))].sort((a, b) => a - b);
        const cross = el("line", { y1: padT, y2: padT + plotH, stroke: tok("--border-2"), "stroke-width": 1, visibility: "hidden" }, s);
        const hit = el("rect", { x: padL, y: padT, width: plotW, height: plotH, fill: "transparent" }, s);
        hit.addEventListener("pointermove", e => {
            const rect = s.getBoundingClientRect();
            const mx = (e.clientX - rect.left) * (width / rect.width);
            const tNear = xs.reduce((a, b) => Math.abs(x(b) - mx) < Math.abs(x(a) - mx) ? b : a);
            cross.setAttribute("x1", x(tNear)); cross.setAttribute("x2", x(tNear));
            cross.setAttribute("visibility", "visible");
            const rows = series
                .map(sr => { const p = sr._pts.find(p => +p.t === tNear); return p ? { color: sr.color, value: fmt(p.v), name: sr.name } : null; })
                .filter(Boolean);
            showTooltip(e.clientX, e.clientY, fmtDate(new Date(tNear)), rows);
        });
        hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); hideTooltip(); });
        legend(container, series, "line");
    }

    // ================= scatter =================
    // points: [{x, y, label, color}] — one dot per item.
    // opts: {xUnit, xName, yName, legendItems, height, r, bands, zones}
    //   bands: [{test, label, weight}] bottom-first — y collapses onto discrete jittered rows
    //          instead of a continuous axis (e.g. "posted once" / "twice" / "3+").
    //   zones: {x, cells:[{q,label,tint}]} — faint behavior quadrants; the vertical split is
    //          at x days, the horizontal split sits on top of the first (bottom) band.
    function scatter(container, points, opts = {}) {
        if (!points.length) return emptyNote(container, opts.emptyMsg || "No data yet.");
        const width = Math.max(280, container.clientWidth || 320);
        const height = opts.height || 200;
        const padL = 34, padR = 14, padT = 14, padB = 26, padX = 18, padY = 12;
        const plotW = width - padL - padR, plotH = height - padT - padB;
        const xPlot = plotW - padX * 2;                       // inset so dots never touch the x-axis ends
        const yTopEdge = padT + padY, yBotEdge = padT + plotH - padY, regionH = yBotEdge - yTopEdge;
        const s = svgRoot(container, width, height);
        const z = opts.zones;

        // ---- x: log (log1p so 0 days is valid), with the zone divider (90d) PINNED to the middle
        //         so the quadrants stay balanced on every company. Spreads the dense young end and
        //         compresses the long tail. xmax caps near p97 so one freak outlier can't dominate. ----
        const xs = points.map(p => p.x).sort((a, b) => a - b);
        const p97 = xs[Math.min(xs.length - 1, Math.ceil(xs.length * 0.97) - 1)];
        const xticks = niceTicks(Math.max(p97, (z ? z.x : 0) * 1.5, 10));
        const xmax = xticks[xticks.length - 1];
        const anchor = z ? z.x : null, anchorFrac = 0.5;      // pin 90d at mid-width
        const L1 = v => Math.log1p(Math.max(0, Math.min(v, xmax)));
        const Lmax = L1(xmax), Lanc = anchor != null ? L1(anchor) : null;
        const frac = v => anchor == null ? L1(v) / Lmax
            : L1(v) <= Lanc ? anchorFrac * (L1(v) / Lanc)
                : anchorFrac + (1 - anchorFrac) * (L1(v) - Lanc) / (Lmax - Lanc);
        const X = v => padL + padX + frac(v) * xPlot;

        // ---- y: discrete bands (bottom-first), weighted heights, dots jittered within a band.
        //         Bands tile an inset region so dots keep clear of the top and baseline. ----
        const bands = opts.bands || [{ test: () => true, label: "", weight: 1 }];
        const totalW = bands.reduce((a, b) => a + (b.weight || 1), 0);
        let acc = 0;
        const bandInfo = bands.map(b => {
            const w = b.weight || 1;
            const yBot = yBotEdge - (acc / totalW) * regionH;
            acc += w;
            const yTop = yBotEdge - (acc / totalW) * regionH;
            return { ...b, yTop, yBot, yc: (yBot + yTop) / 2, h: yBot - yTop };
        });
        const bandOf = v => bandInfo.find(b => b.test(v)) || bandInfo[bandInfo.length - 1];
        // per-band value extent: a band spanning several counts (e.g. "3+") orders dots by count
        for (const b of bandInfo) { b.vMin = Infinity; b.vMax = -Infinity; }
        for (const pt of points) { const b = bandOf(pt.y); b.vMin = Math.min(b.vMin, pt.y); b.vMax = Math.max(b.vMax, pt.y); }
        // stable per-point jitter in [-1, 1] so dots don't jump on re-render
        const jitter = str => {
            let h = 0;
            for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
            return ((h % 1000) / 1000 - 0.5) * 2;
        };

        // ---- behavior zones: faint tint + dashed dividers (drawn behind) ----
        if (z) {
            const xM = X(z.x), yM = bandInfo[0].yTop, xR = width - padR, yB = padT + plotH;
            const bounds = q => ({ x: q[1] === "l" ? padL : xM, w: q[1] === "l" ? xM - padL : xR - xM,
                y: q[0] === "t" ? padT : yM, h: q[0] === "t" ? yM - padT : yB - yM });
            for (const c of z.cells || []) if (c.tint) {
                const b = bounds(c.q);
                el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, fill: tok(c.tint), "fill-opacity": 0.04 }, s);
            }
            el("line", { x1: xM, x2: xM, y1: padT, y2: yB, stroke: tok("--border-2"), "stroke-width": 1, "stroke-dasharray": "3 3" }, s);
            el("line", { x1: padL, x2: xR, y1: yM, y2: yM, stroke: tok("--border-2"), "stroke-width": 1, "stroke-dasharray": "3 3" }, s);
        }

        // band rows + labels
        for (const b of bandInfo) {
            el("line", { x1: padL, x2: width - padR, y1: b.yc, y2: b.yc, stroke: tok("--grid"), "stroke-width": 1 }, s);
            if (b.label) el("text", { x: padL - 5, y: b.yc + 3, "text-anchor": "end", class: "axis-label" }, s).textContent = b.label;
        }
        el("line", { x1: padL, x2: width - padR, y1: padT + plotH, y2: padT + plotH, stroke: tok("--baseline"), "stroke-width": 1 }, s);
        // x ticks: keep 0 / the 90d anchor / max first (never dropped), then fill in nice values
        // and a couple in the young half, skipping any that would crowd an already-placed label.
        const sub = anchor != null ? [Math.round(anchor / 3), Math.round(anchor * 2 / 3)] : [];
        const keyTicks = [0, ...(anchor != null ? [anchor] : []), xmax];
        const xtickVals = [...keyTicks, ...sub, ...xticks]
            .filter((v, i, a) => v <= xmax && a.indexOf(v) === i);   // priority order, de-duped
        const shownTx = [];
        for (const t of xtickVals) {
            const tx = X(t);
            if (shownTx.some(sx => Math.abs(sx - tx) < 30)) continue;
            shownTx.push(tx);
            el("text", { x: tx, y: height - 7, "text-anchor": "middle", class: "axis-label" }, s)
                .textContent = fmt(t) + (opts.xUnit || "");
        }
        if (z) for (const c of z.cells || []) {
            const left = c.q[1] === "l", top = c.q[0] === "t";
            el("text", { x: left ? padL + 6 : width - padR - 6, y: top ? padT + 11 : padT + plotH - 6,
                "text-anchor": left ? "start" : "end", class: "axis-label" }, s).textContent = c.label;
        }

        const def = opts.color || tok("--accent");
        for (const pt of points) {
            const b = bandOf(pt.y);
            const cx = X(pt.x);
            const key = (pt.label || "") + "|" + pt.x + "|" + pt.y;
            // in a band covering several counts, place higher counts higher and keep jitter small
            // for ties; a single-count band (1, 2) just spreads its cloud.
            const cy = b.vMax > b.vMin
                ? b.yc + (0.5 - (pt.y - b.vMin) / (b.vMax - b.vMin)) * (b.h * 0.6) + jitter(key) * (b.h * 0.12)
                : b.yc + jitter(key) * (b.h * 0.32);
            const color = pt.color || def;
            const c = el("circle", { cx, cy, r: opts.r || 3.3,
                fill: color, "fill-opacity": 0.5, stroke: color, "stroke-width": 0.5 }, s);
            c.addEventListener("pointermove", e => {
                c.setAttribute("fill-opacity", "0.95");
                showTooltip(e.clientX, e.clientY, pt.label || "", [
                    { value: `${fmt(pt.x)}${opts.xUnit || ""}`, name: opts.xName || "" },
                    { value: fmt(pt.y), name: opts.yName || "" },
                ]);
            });
            c.addEventListener("pointerleave", () => { c.setAttribute("fill-opacity", "0.5"); hideTooltip(); });
        }
        if (opts.legendItems) legend(container, opts.legendItems, "rect");
    }

    return { barsH, columns, timeLine, scatter, emptyNote, showTooltip, hideTooltip };
})();
