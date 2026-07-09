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
    function niceTicks(maxVal, n = 4) {
        if (maxVal <= 0) return [0, 1];
        const raw = maxVal / n;
        const mag = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || 10 * mag;
        const ticks = [];
        for (let v = 0; v <= maxVal + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
        if (ticks[ticks.length - 1] < maxVal) ticks.push(ticks[ticks.length - 1] + step);
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
        const vMax = Math.max(...all.map(p => p.v));
        const vMin = opts.zeroBase === false ? Math.min(...all.map(p => p.v)) : 0;
        const ticks = niceTicks(vMax);
        const yMax = ticks[ticks.length - 1];
        const x = t => padL + ((+t - t0) / (t1 - t0)) * plotW;
        const y = v => padT + plotH - ((v - vMin) / (yMax - vMin || 1)) * plotH;

        for (const t of ticks) {
            if (t < vMin) continue;
            el("line", { x1: padL, x2: width - padR, y1: y(t), y2: y(t), stroke: tok("--grid"), "stroke-width": 1 }, s);
            el("text", { x: padL - 5, y: y(t) + 3, "text-anchor": "end", class: "axis-label" }, s).textContent = fmt(t);
        }

        // x ticks: 4 evenly spaced dates
        const fmtDate = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
        for (let i = 0; i <= 3; i++) {
            const tt = t0 + (i / 3) * (t1 - t0);
            el("text", {
                x: x(tt), y: height - 6,
                "text-anchor": i === 0 ? "start" : i === 3 ? "end" : "middle", class: "axis-label",
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

    return { barsH, columns, timeLine, emptyNote, showTooltip, hideTooltip };
})();
