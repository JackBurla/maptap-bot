/* HN Graveyard — app.js  |  no frameworks, vanilla JS */
"use strict";

const state = {
  ghostMode:  false,
  meltdown:   false,
  wallPage:   0,
  crashPage:  0,
  wallCards:  [],
  crashCards: [],
  PAGE:       48,
  CRASH_PAGE: 30,
};

// ── utils ─────────────────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n == null) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}
function fmtPct(n) { return n == null ? "—" : n.toFixed(1) + "%"; }
function esc(s) {
  return String(s || "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;");
}
function setVal(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
async function loadJSON(p) {
  const r = await fetch(p);
  if (!r.ok) throw new Error(`${r.status} ${p}`);
  return r.json();
}

// ── stats ─────────────────────────────────────────────────────────────────────
function renderStats(o) {
  setVal("stat-show-hn",        fmtNum(o.n_show_hn));
  setVal("stat-zero",           fmtNum(o.n_zero_engagement));
  setVal("stat-pct-zero",       fmtPct(o.pct_zero));
  setVal("stat-one-done",       fmtNum(o.n_one_and_done));
  setVal("stat-dead-rate",      o.pct_checked_dead != null ? o.pct_checked_dead.toFixed(1) + "%" : "—");
  setVal("stat-unique-authors", fmtNum(o.n_unique_authors));
}

// ── url badge ─────────────────────────────────────────────────────────────────
function urlBadge(c) {
  if (!c.url) return "";
  if (c.url_alive === false) return `<span class="badge badge-gone">URL DEAD</span>`;
  if (c.url_alive === true)  return `<span class="badge badge-live">URL LIVE</span>`;
  return "";
}

// Strip the redundant "Show HN: " prefix — it's implicit context on every card.
function cleanTitle(t) {
  return (t || "").replace(/^Show HN:\s*/i, "");
}

// ── graveyard card ────────────────────────────────────────────────────────────
function renderCard(c, isMelt = false) {
  const title = cleanTitle(c.title);
  const titleEl = c.hn_url
    ? `<a href="${esc(c.hn_url)}" target="_blank" rel="noopener">${esc(title)}</a>`
    : esc(title);

  const domainEl = c.domain
    ? `<div class="gcard-domain"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.domain)}</a></div>`
    : "";

  const textEl = c.text
    ? `<p class="gcard-text">${esc(c.text)}</p>`
    : "";

  let meltEl = "";
  if (isMelt && c.crash_out_score > 0) {
    // Scale to ~12 (observed top score range) so bars fill visually.
    // Using the theoretical max (32) left bars at 30% even for the most extreme posts.
    const pct = Math.min(100, (c.crash_out_score / 12) * 100).toFixed(1);
    const tags = (c.crash_out_signals || []).slice(0, 5)
      .map(s => `<span class="melt-tag">${esc(s)}</span>`).join("");
    meltEl = `
      <div class="melt-score-row">
        <span class="melt-score-label">Meltdown</span>
        <div class="melt-bar-track"><div class="melt-bar-fill" style="width:${pct}%"></div></div>
        <span class="melt-score-num">${c.crash_out_score.toFixed(1)}</span>
      </div>
      ${tags ? `<div class="melt-signals">${tags}</div>` : ""}`;
  }

  return `<div class="gcard">
    <div class="gcard-title">${titleEl}</div>
    <div class="gcard-meta">
      <span class="gcard-author">${esc(c.by)}</span>
      <span class="gcard-dot">·</span>
      <span class="gcard-date">${esc(c.date_fmt || "")}</span>
    </div>
    ${domainEl}
    ${textEl}
    ${meltEl}
    <div class="gcard-footer">
      <span class="badge badge-ghost">0 pts</span>
      ${urlBadge(c)}
    </div>
  </div>`;
}

// ── wall rendering ────────────────────────────────────────────────────────────
function renderWall(isMelt) {
  const cards  = isMelt ? state.crashCards : state.wallCards;
  const page   = isMelt ? state.crashPage  : state.wallPage;
  const size   = isMelt ? state.CRASH_PAGE : state.PAGE;
  const wallEl = document.getElementById(isMelt ? "crash-wall" : "ghost-wall");
  const moreEl = document.getElementById(isMelt ? "crash-more" : "ghost-more");
  if (!wallEl) return;

  const slice = cards.slice(0, (page + 1) * size);
  wallEl.innerHTML = slice.map(c => renderCard(c, isMelt)).join("");
  if (moreEl) moreEl.style.display = slice.length < cards.length ? "block" : "none";
}

// ── toggles ───────────────────────────────────────────────────────────────────
function syncToggles() {
  const gb = document.getElementById("toggle-ghost");
  const mb = document.getElementById("toggle-meltdown");
  const gs = document.getElementById("ghost-section");
  const ms = document.getElementById("meltdown-section");

  gb?.classList.toggle("active-ghost",    state.ghostMode);
  mb?.classList.toggle("active-meltdown", state.meltdown);
  if (gs) gs.style.display = state.ghostMode ? "block" : "none";
  if (ms) ms.style.display = state.meltdown  ? "block" : "none";
}

// ── findings renderers ────────────────────────────────────────────────────────
function renderOneAndDone(f) {
  const sample = (f.rows || []).slice(0, 16);
  if (!sample.length) return `<div class="empty-state">No data.</div>`;
  return `<div class="wall">${sample.map(r => renderCard(r)).join("")}</div>`;
}

function renderLongCold(f) {
  const rows = (f.rows || []).slice(0, 20);
  if (!rows.length) return `<div class="empty-state">No data.</div>`;
  return `<div class="table-scroll"><table class="ftable">
    <thead><tr><th>Author</th><th>Zero runs</th><th>Total</th><th>Span</th><th>Last post</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="mono hi">${esc(r.author)}</td>
      <td class="mono red">${r.n_zero}</td>
      <td class="mono dim">${r.n_total}</td>
      <td class="mono dim">${r.years_span}y</td>
      <td class="dim">${esc((r.last_post || {}).date_fmt || "")}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderBreakthrough(f) {
  const rows = (f.rows || []).slice(0, 20);
  if (!rows.length) return `<div class="empty-state">No data.</div>`;
  return `<div class="table-scroll"><table class="ftable">
    <thead><tr><th>Author</th><th>Misses before</th><th>Breakout score</th><th>Date</th><th>Post</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td class="mono hi">${esc(r.author)}</td>
      <td class="mono red">${r.pre_breakout_cold}</td>
      <td class="mono green">${r.breakout_score} pts</td>
      <td class="dim">${esc(r.breakout_date || "")}</td>
      <td class="link" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${r.breakout_post ? `<a href="${esc(r.breakout_post.hn_url)}" target="_blank" rel="noopener">${esc(cleanTitle(r.breakout_post.title||"").slice(0,55))}</a>` : ""}
      </td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

function renderBarChart(rows, labelKey, valKey, maxOverride, danger) {
  if (!rows?.length) return `<div class="empty-state">No data.</div>`;
  const max = maxOverride || Math.max(...rows.map(r => r[valKey] || 0)) || 1;
  const isPct = maxOverride === 100;  // treat max=100 as a percentage scale
  return `<div class="chart-rows">${rows.map(r => {
    const pct = Math.round(100 * (r[valKey] || 0) / max);
    const raw = r[valKey] ?? 0;
    const val = isPct
      ? raw.toFixed(1) + "%"
      : (typeof raw === "number" && raw < 2 ? fmtPct(raw * 100) : fmtNum(raw));
    return `<div class="bar-row">
      <span class="bar-label">${esc(String(r[labelKey]))}</span>
      <div class="bar-track"><div class="bar-fill${danger ? " danger" : ""}" style="width:${pct}%"></div></div>
      <span class="bar-val">${esc(val)}</span>
    </div>`;
  }).join("")}</div>`;
}

function renderDeadUrls(f) {
  const domHtml = (f.top_domains || []).slice(0, 12).map(d => `
    <div class="bar-row">
      <span class="bar-label">${esc(d.domain)}</span>
      <div class="bar-track"><div class="bar-fill danger" style="width:${Math.round(100 * d.n / (f.top_domains[0]?.n || 1))}%"></div></div>
      <span class="bar-val">${fmtNum(d.n)}</span>
    </div>`).join("");
  const wallHtml = (f.rows || []).slice(0, 12).map(r => renderCard(r)).join("");
  return `
    <p class="finding-blurb" style="margin-bottom:0.75rem">Top domains hosting dead projects:</p>
    <div class="chart-rows" style="margin-bottom:1.5rem">${domHtml}</div>
    <div class="wall">${wallHtml}</div>`;
}

function renderCrashOut(f) {
  const sample = (f.rows || []).slice(0, 8);
  if (!sample.length) return `<div class="empty-state">Enable Meltdown Mode to browse the full wall.</div>`;
  return `<div class="wall">${sample.map(c => renderCard(c, true)).join("")}</div>`;
}

const RENDERERS = {
  one_and_done:      renderOneAndDone,
  long_cold:         renderLongCold,
  breakthrough:      renderBreakthrough,
  posting_hour:      f => renderBarChart(f.rows, "hour_label", "pct_zero", 100, true),
  dead_urls:         renderDeadUrls,
  year_over_year:    f => renderBarChart(f.rows, "year", "pct_zero", 100, true),
  forgotten_domains: f => renderBarChart(f.rows, "domain", "pct_zero", 100, true),
  crash_out:         renderCrashOut,
};

// ── findings accordion ────────────────────────────────────────────────────────
function renderFindings(findings) {
  const el = document.getElementById("findings-list");
  if (!el) return;

  el.innerHTML = findings.map((f, i) => `
    <div class="finding" id="finding-${esc(f.id)}">
      <div class="finding-header" onclick="toggleFinding('${esc(f.id)}')">
        <span class="finding-num">F${i + 1}</span>
        <span class="finding-title">${esc(f.title)}</span>
        <span class="finding-stat">${esc(f.stat || "")}</span>
        <svg class="finding-chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M4 6l4 4 4-4"/>
        </svg>
      </div>
      <div class="finding-body">
        <div class="finding-inner">
          <p class="finding-blurb">${esc(f.blurb || "")}</p>
          <div id="fd-${esc(f.id)}"></div>
        </div>
      </div>
    </div>`).join("");
}

function toggleFinding(id) {
  const el = document.getElementById(`finding-${id}`);
  if (!el) return;
  const opening = !el.classList.contains("open");
  el.classList.toggle("open", opening);

  if (opening) {
    const dataEl = document.getElementById(`fd-${id}`);
    if (dataEl && !dataEl.innerHTML.trim()) {
      const f = (window._findings || []).find(x => x.id === id);
      if (f && RENDERERS[id]) dataEl.innerHTML = RENDERERS[id](f);
    }
  }
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const [overall, wallData, crashData, findings] = await Promise.all([
      loadJSON("data/overall.json"),
      loadJSON("data/wall.json"),
      loadJSON("data/crashout.json"),
      loadJSON("data/findings.json"),
    ]);

    window._findings  = findings;
    state.wallCards   = wallData.cards  || [];
    state.crashCards  = crashData.cards || [];

    renderStats(overall);
    renderFindings(findings);
    renderWall(false);
    renderWall(true);
    syncToggles();

  } catch (err) {
    console.error("boot error:", err);
    const el = document.getElementById("findings-list");
    if (el) el.innerHTML = `<div class="empty-state">Error: ${esc(err.message)}</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  boot();

  document.getElementById("toggle-ghost")?.addEventListener("click", () => {
    state.ghostMode = !state.ghostMode;
    syncToggles();
    if (state.ghostMode)
      document.getElementById("ghost-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.getElementById("toggle-meltdown")?.addEventListener("click", () => {
    state.meltdown = !state.meltdown;
    syncToggles();
    if (state.meltdown)
      document.getElementById("meltdown-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.getElementById("ghost-more-btn")?.addEventListener("click", () => {
    state.wallPage++;
    renderWall(false);
  });
  document.getElementById("crash-more-btn")?.addEventListener("click", () => {
    state.crashPage++;
    renderWall(true);
  });
});
