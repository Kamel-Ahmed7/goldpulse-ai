/* GoldPulse AI - frontend
 * Modules: Api, Store, Hero, Ticker, Prices, Calc, Forecast, News, Tabs, App
 */
"use strict";

/* ============================== Config & helpers ============================== */
const CONFIG = {
  // Served by FastAPI -> relative URLs. Opened from disk -> talk to localhost.
  api: location.protocol === "file:" ? "http://localhost:8000" : "",
  refreshSeconds: 30,
  newsEveryCycles: 10, // ~5 minutes
  karats: [24, 22, 21, 18, 14],
};

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
const sign = (n) => (n > 0 ? "+" : "");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const findItem = (id) => Store.rates.items.find((i) => i.id === id);

const Api = {
  async get(path) {
    const res = await fetch(CONFIG.api + path);
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  },
};

const Store = { rates: null, prediction: null, prevSell: {} };

/* ================================ Hero cards ================================ */
const Hero = {
  delta(el, pct, abs) {
    el.className = "delta " + (pct >= 0 ? "up" : "down");
    el.textContent =
      `${pct >= 0 ? "▲" : "▼"} ${sign(pct)}${fmt(pct)}%` +
      (abs !== undefined ? ` (${sign(abs)}${fmt(abs)})` : "");
  },
  render() {
    const r = Store.rates;
    $("spotPrice").textContent = "$" + fmt(r.xauusd.price);
    this.delta($("spotDelta"), r.xauusd.change_pct, r.xauusd.change);
    $("g24Price").textContent = fmt(findItem("24k").sell);
    this.delta($("g24Delta"), findItem("24k").change_pct);
    $("g21Price").textContent = fmt(findItem("21k").sell);
    this.delta($("g21Delta"), findItem("21k").change_pct);
    $("fxPrice").textContent = fmt(r.usd_egp.rate);
    $("fxSource").textContent =
      (r.usd_egp.live ? "Live · " : "Estimate · ") + r.usd_egp.source;

    const badge = $("liveBadge");
    badge.textContent = r.is_live ? "Live" : "Offline data";
    badge.className = "badge " + (r.is_live ? "badge-live" : "badge-offline");
    badge.title = "Source: " + r.source;
    $("updatedAt").textContent = new Date().toLocaleTimeString();
  },
};

/* ================================== Ticker ================================== */
const Ticker = {
  render() {
    const r = Store.rates;
    const cell = (name, val, pct) =>
      `<span class="tick"><span class="tick-name">${name}</span><span class="tick-val">${val}</span>` +
      (pct === undefined
        ? ""
        : `<span class="${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${fmt(Math.abs(pct))}%</span>`) +
      `</span>`;
    const parts = [
      cell("XAU/USD", "$" + fmt(r.xauusd.price), r.xauusd.change_pct),
    ];
    ["24k", "22k", "21k", "18k"].forEach((id) =>
      parts.push(
        cell(id.toUpperCase(), fmt(findItem(id).sell), findItem(id).change_pct),
      ),
    );
    parts.push(
      cell(
        "Gold pound",
        fmt(findItem("coin").sell, 0),
        findItem("coin").change_pct,
      ),
    );
    parts.push(cell("USD/EGP", fmt(r.usd_egp.rate)));
    if (Store.prediction) {
      parts.push(
        cell(
          "AI next close",
          "$" + fmt(Store.prediction.predicted_close),
          Store.prediction.predicted_return_pct,
        ),
      );
    }
    const html = parts.join("");
    $("tickerTrack").innerHTML = html + html; // duplicated so the CSS loop is seamless
  },
};

/* ============================ Prices table + search ============================ */
const Prices = {
  category: "all",
  query: "",

  matches(item) {
    if (this.category !== "all" && item.category !== this.category)
      return false;
    const q = this.query.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      item.name,
      item.name_ar,
      `${item.karat}k`,
      `${item.karat} karat`,
      `${item.weight_g}g`,
      item.category === "coin" ? "coin pound gold pound guinea جنيه جنية" : "",
      item.category === "bullion" ? "ingot bar bullion سبيكة سبائك" : "",
    ]
      .join(" ")
      .toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  },

  render() {
    const body = $("ratesBody");
    const rows = Store.rates.items.filter((i) => this.matches(i));
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="6" class="empty">No match for "${esc(this.query)}". Try 21k, pound or 10g.</td></tr>`;
      return;
    }
    body.innerHTML = rows
      .map((i) => {
        const prev = Store.prevSell[i.id];
        const flash =
          prev === undefined || prev === i.sell
            ? ""
            : i.sell > prev
              ? "flash-up"
              : "flash-down";
        const d = i.category === "carat" ? 2 : 0;
        const spread = ((i.sell - i.buy) / i.sell) * 100;
        return `<tr class="${flash}">
        <td><span class="item-name">${esc(i.name)}</span><span class="item-ar" dir="rtl">${esc(i.name_ar)}</span><span class="item-unit">${esc(i.unit)}</span></td>
        <td class="num cell-sell">${fmt(i.sell, d)}</td>
        <td class="num">${fmt(i.buy, d)}</td>
        <td class="num cell-spread">${fmt(spread)}%</td>
        <td class="num cell-make">${i.workmanship ? fmt(i.workmanship, 0) : "-"}</td>
        <td class="num ${i.change_pct >= 0 ? "up" : "down"}">${sign(i.change_pct)}${fmt(i.change_pct)}%</td>
      </tr>`;
      })
      .join("");
    Store.rates.items.forEach((i) => (Store.prevSell[i.id] = i.sell));
  },

  init() {
    $("searchInput").addEventListener("input", (e) => {
      this.query = e.target.value;
      if (Store.rates) this.render();
    });
    $("chips").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document
        .querySelectorAll(".chip")
        .forEach((c) => c.classList.toggle("active", c === chip));
      this.category = chip.dataset.cat;
      if (Store.rates) this.render();
    });
    document.addEventListener("keydown", (e) => {
      // "/" jumps to search
      if (
        e.key === "/" &&
        !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)
      ) {
        e.preventDefault();
        $("searchInput").focus();
      }
    });
  },
};

/* ================================= Calculator ================================= */
const Calc = {
  mode: "money",
  tile: (label, value, hl = false) =>
    `<div class="result-tile ${hl ? "hl" : ""}"><span>${label}</span><strong>${value}</strong></div>`,

  init() {
    const opts = CONFIG.karats
      .map(
        (k) =>
          `<option value="${k}" ${k === 21 ? "selected" : ""}>${k}K</option>`,
      )
      .join("");
    $("moneyKarat").innerHTML = opts;
    $("goldKarat").innerHTML = opts;
    $("calcMode").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg");
      if (!btn) return;
      this.mode = btn.dataset.mode;
      document
        .querySelectorAll(".seg")
        .forEach((s) => s.classList.toggle("active", s === btn));
      $("moneyInputs").hidden = this.mode !== "money";
      $("goldInputs").hidden = this.mode !== "gold";
      this.render();
    });
    [
      "moneyAmount",
      "moneyCurrency",
      "moneyKarat",
      "goldGrams",
      "goldKarat",
    ].forEach((id) => $(id).addEventListener("input", () => this.render()));
  },

  render() {
    const out = $("calcResult");
    if (!Store.rates) {
      out.innerHTML = '<p class="empty">Waiting for live prices…</p>';
      return;
    }
    const fx = Store.rates.usd_egp.rate;

    if (this.mode === "money") {
      const amount = parseFloat($("moneyAmount").value);
      if (!(amount > 0)) {
        out.innerHTML =
          '<p class="empty">Enter an amount to see how much gold it buys.</p>';
        return;
      }
      const egp = $("moneyCurrency").value === "USD" ? amount * fx : amount;
      const k = +$("moneyKarat").value;
      const grams = egp / findItem(`${k}k`).sell; // you buy at the sell price
      out.innerHTML =
        this.tile(`Gold you can buy (${k}K)`, `${fmt(grams)} g`, true) +
        `<div class="result-row">${this.tile("Budget (EGP)", fmt(egp, 0))}${this.tile("Budget (USD)", "$" + fmt(egp / fx, 0))}</div>` +
        `<div class="result-row">${this.tile("Pure gold (24K equiv.)", `${fmt((grams * k) / 24)} g`)}${this.tile("Gold pounds (8g, 21K)", fmt(egp / findItem("coin").sell))}</div>`;
    } else {
      const grams = parseFloat($("goldGrams").value);
      if (!(grams > 0)) {
        out.innerHTML =
          '<p class="empty">Enter your gold weight to see its value.</p>';
        return;
      }
      const k = +$("goldKarat").value;
      const cash = grams * findItem(`${k}k`).buy; // what a shop pays you
      const retail = grams * findItem(`${k}k`).sell; // what it costs to buy the same gold
      out.innerHTML =
        this.tile("Cash value if you sell (EGP)", fmt(cash, 0), true) +
        `<div class="result-row">${this.tile("Cash value (USD)", "$" + fmt(cash / fx, 0))}${this.tile("Retail value (EGP)", fmt(retail, 0))}</div>` +
        `<div class="result-row">${this.tile("Retail value (USD)", "$" + fmt(retail / fx, 0))}${this.tile("Pure gold content", `${fmt((grams * k) / 24)} g (24K)`)}</div>`;
    }
  },
};

/* ================================ AI forecast ================================ */
const Forecast = {
  loaded: false,

  async run() {
    const btn = $("aiBtn");
    btn.disabled = true;
    btn.textContent = "Running…";
    try {
      const d = await Api.get("/api/predict");
      Store.prediction = d;
      this.loaded = true;
      this.render(d);
      if (Store.rates) Ticker.render();
    } catch (err) {
      console.error(err);
      $("aiWarnings").innerHTML =
        `<li>Could not reach the prediction service: ${esc(err.message)}</li>`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Run AI forecast";
    }
  },

  render(d) {
    const up = d.predicted_return_pct >= 0;
    $("aiGrid").hidden = false;
    $("aiClose").textContent = "$" + fmt(d.predicted_close);
    $("aiReturn").innerHTML =
      `<span class="${up ? "up" : "down"}">${sign(d.predicted_return_pct)}${fmt(d.predicted_return_pct)}%</span>`;
    $("aiSignal").innerHTML =
      `<span class="badge badge-${d.signal.toLowerCase()}">${d.signal}</span>`;
    $("aiEgp").textContent = fmt(d.est_21k_egp_gram);
    $("aiMeta").textContent =
      `${d.model_name} · based on the ${d.as_of} session (close $${fmt(d.last_close)})`;

    const feats = Object.entries(d.features || {});
    $("aiFeatures").hidden = !feats.length;
    $("aiFeatures").innerHTML = feats.length
      ? "Model inputs: " +
        feats.map(([k, v]) => `<code>${esc(k)} = ${fmt(v, 2)}</code>`).join(" ")
      : "";
    $("aiWarnings").innerHTML = d.warnings
      .map((w) => `<li>${esc(w)}</li>`)
      .join("");
    $("aiNotes").innerHTML = (d.notes || [])
      .map((n) => `<li>${esc(n)}</li>`)
      .join("");
    this.chart(d);
  },

  /* Catmull-Rom -> cubic Bezier, so the price line is smooth instead of jagged */
  smooth(pts) {
    let path = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i],
        p1 = pts[i],
        p2 = pts[i + 1],
        p3 = pts[i + 2] || p2;
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      path += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return path;
  },

  chart(d) {
    const closes = d.history.map((h) => h.c);
    const all = closes.concat(d.predicted_close);
    const W = 720,
      H = 250,
      P = { l: 56, r: 18, t: 14, b: 28 };
    const lo = Math.min(...all) - (Math.max(...all) - Math.min(...all)) * 0.08;
    const hi = Math.max(...all) + (Math.max(...all) - Math.min(...all)) * 0.08;
    const x = (i) => P.l + (i / (all.length - 1)) * (W - P.l - P.r);
    const y = (v) => P.t + (1 - (v - lo) / (hi - lo)) * (H - P.t - P.b);

    const pts = closes.map((v, i) => [x(i), y(v)]);
    const line = this.smooth(pts);
    const last = pts[pts.length - 1];
    const next = [x(all.length - 1), y(d.predicted_close)];
    const area = `${line} L${last[0].toFixed(1)} ${H - P.b} L${pts[0][0].toFixed(1)} ${H - P.b} Z`;
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((t) => {
        const v = lo + (hi - lo) * t,
          yy = y(v);
        return `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}"/><text x="${P.l - 8}" y="${yy + 4}" text-anchor="end">${Math.round(v)}</text>`;
      })
      .join("");
    const dot = d.predicted_return_pct >= 0 ? "#10b981" : "#ef4444";

    $("aiChart").hidden = false;
    $("aiChart").innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Last 60 daily closes and the predicted next close">
      ${grid}<path class="area" d="${area}"/><path class="line" d="${line}"/>
      <path class="proj" d="M${last[0].toFixed(1)} ${last[1].toFixed(1)} L${next[0].toFixed(1)} ${next[1].toFixed(1)}"/>
      <circle cx="${next[0]}" cy="${next[1]}" r="5" fill="${dot}"/>
      <text x="${W - P.r}" y="${H - 8}" text-anchor="end">Last 60 sessions · dashed = next-session forecast</text></svg>`;
  },
};

/* ================================== News ================================== */
const News = {
  ago(iso) {
    const m = Math.max(1, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 60
      ? `${m} min ago`
      : m < 1440
        ? `${Math.round(m / 60)} h ago`
        : `${Math.round(m / 1440)} d ago`;
  },
  async load() {
    try {
      const d = await Api.get("/api/gold-news");
      $("newsSummary").innerHTML =
        `<span>Overall</span><span class="badge badge-${d.overall.toLowerCase()}">${d.overall}</span>` +
        `<span>${d.counts.Bullish} bullish · ${d.counts.Neutral} neutral · ${d.counts.Bearish} bearish</span>` +
        (d.fallback
          ? '<span class="badge badge-muted">Sample data</span>'
          : "");
      $("newsList").innerHTML = d.articles
        .map((a) => {
          const title = a.url
            ? `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>`
            : `<span class="headline">${esc(a.title)}</span>`;
          return `<li class="news-item">${title}<span class="badge badge-${a.sentiment.toLowerCase()}">${a.sentiment}</span>
          <span class="news-meta">${esc(a.source)} · ${this.ago(a.published)}</span></li>`;
        })
        .join("");
    } catch (err) {
      console.error(err);
      $("newsList").innerHTML =
        '<li class="empty">Headlines are unavailable right now.</li>';
    }
  },
};

/* ================================== Tabs ================================== */
const Tabs = {
  init() {
    document.querySelector(".tabs").addEventListener("click", (e) => {
      const tab = e.target.closest(".tab");
      if (!tab) return;
      document.querySelectorAll(".tab").forEach((t) => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", t === tab);
      });
      document.querySelectorAll(".panel").forEach((p) => {
        const on = p.id === "tab-" + tab.dataset.tab;
        p.classList.toggle("active", on);
        p.hidden = !on;
      });
      if (tab.dataset.tab === "ai" && !Forecast.loaded) Forecast.run(); // first visit runs the model
    });
  },
};

/* =================================== App =================================== */
const App = {
  countdown: CONFIG.refreshSeconds,
  cycles: 0,

  async loadRates() {
    try {
      Store.rates = await Api.get("/api/rates");
      Hero.render();
      Ticker.render();
      Prices.render();
      Calc.render();
    } catch (err) {
      console.error(err);
      $("liveBadge").textContent = "Backend unreachable";
      $("liveBadge").className = "badge badge-offline";
    }
  },

  refresh() {
    this.countdown = CONFIG.refreshSeconds;
    this.cycles++;
    this.loadRates();
    if (this.cycles % CONFIG.newsEveryCycles === 0) News.load();
  },

  start() {
    setInterval(() => {
      if (document.hidden) return; // no polling while the tab is in the background
      this.countdown--;
      $("countdown").textContent = Math.max(this.countdown, 0);
      if (this.countdown <= 0) this.refresh();
    }, 1000);
  },

  init() {
    Tabs.init();
    Prices.init();
    Calc.init();
    $("aiBtn").addEventListener("click", () => Forecast.run());
    $("refreshBtn").addEventListener("click", () => {
      this.refresh();
      if (Forecast.loaded) Forecast.run();
    });
    this.loadRates();
    News.load();
    Forecast.run(); // preload so the ticker can show the AI close
    this.start();
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
