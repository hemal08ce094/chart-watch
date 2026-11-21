import {
  PLATFORM_LABEL, CHART_LABEL, countryName, flag, fmt, fetchStatus, placements, movement,
  featured, lastFeatureCheck, ago, scannerLine, esc,
} from "./common.js";

const view = { platform: "all", chart: "all", store: "all" };
const open = new Set();
let data = null;
let failures = 0;

const $ = (id) => document.getElementById(id);

function mvHTML(p) {
  const m = movement(p);
  if (m.kind === "up") return `<span class="mv up" title="Up ${m.d} since the last check">▲ ${m.d}</span>`;
  if (m.kind === "down") return `<span class="mv down" title="Down ${m.d} since the last check">▼ ${m.d}</span>`;
  if (m.kind === "new") return `<span class="mv new" title="Newly on this chart">New</span>`;
  if (m.kind === "first") return `<span class="mv same" title="First check of this chart"></span>`;
  return `<span class="mv same" title="No change">–</span>`;
}

const chartName = (p) => `${PLATFORM_LABEL[p.platform]} ${CHART_LABEL[p.chart]}${p.scope === "overall" ? " · Overall" : ""}`;

function filtered(all) {
  return all.filter((p) =>
    (view.platform === "all" || p.platform === view.platform) &&
    (view.chart === "all" || p.chart === view.chart) &&
    (view.store === "all" || p.cc === view.store));
}

function renderControls(all) {
  const counts = {};
  for (const p of all) {
    if (view.chart !== "all" && p.chart !== view.chart) continue;
    if (view.store !== "all" && p.cc !== view.store) continue;
    (counts[p.platform] ??= new Set()).add(p.aid);
  }
  const anyCount = new Set(Object.values(counts).flatMap((s) => [...s])).size;
  $("platforms").innerHTML = [["all", "All"], ...data.platforms.map((k) => [k, PLATFORM_LABEL[k]])]
    .map(([k, label]) => {
      const n = k === "all" ? anyCount : counts[k]?.size ?? 0;
      return `<button data-v="${k}" aria-pressed="${view.platform === k}">${label}<span class="n">${n}</span></button>`;
    }).join("");

  const sel = $("store");
  if (sel.options.length === 1) {
    const ccs = [...data.storefronts].sort((a, b) => countryName(a).localeCompare(countryName(b)));
    sel.insertAdjacentHTML("beforeend", ccs.map((cc) => `<option value="${cc}">${flag(cc)} ${esc(countryName(cc))}</option>`).join(""));
  }
}

function renderStats(all, list) {
  const apps = new Set(list.map((p) => p.aid));
  const best = list[0];
  const feats = featured(data);
  const total = Object.keys(data.apps).length;
  $("stats").innerHTML = `
    <div class="stat"><b>${apps.size}<small style="font-size:14px;color:var(--ink-3);font-weight:500"> / ${total}</small></b><span>Apps on a chart</span></div>
    <div class="stat"><b>${fmt.format(list.length)}</b><span>Chart placements</span></div>
    <div class="stat"><b>${best ? "#" + best.rank : "–"}</b><span>${best ? `${esc(best.app.name)} · ${flag(best.cc)} ${chartName(best)}` : "Best position"}</span></div>
    <div class="stat${feats.length ? " gold" : ""}"><b>${feats.length ? new Set(feats.map((f) => f.aid)).size : "None"}</b><span>Featured by Apple</span></div>`;
}

function renderRows(list) {
  const byApp = new Map();
  for (const p of list) {
    if (!byApp.has(p.aid)) byApp.set(p.aid, []);
    byApp.get(p.aid).push(p);
  }
  if (!byApp.size) {
    const scanning = data.scanner.status === "scanning" || data.scanner.status === "starting";
    $("rows").innerHTML = `<tr><td colspan="7" class="empty">${
      scanning && !Object.keys(data.ranks).length ? "The first sweep is still running. Results appear here as each chart is read."
      : "None of your apps is on a chart in this view. Try another platform or storefront."}</td></tr>`;
    return byApp;
  }
  const rows = [];
  for (const [aid, ps] of byApp) {
    const app = data.apps[aid];
    const best = ps[0];
    const perPlat = {};
    for (const p of ps) if (!perPlat[p.platform] || p.rank < perPlat[p.platform].rank) perPlat[p.platform] = p;
    const stores = new Set(ps.map((p) => p.cc)).size;
    const isOpen = open.has(aid);
    rows.push(`
      <tr class="app-row" data-aid="${aid}" tabindex="0" aria-expanded="${isOpen}">
        <td><span class="chev" aria-hidden="true">›</span></td>
        <td><div class="app"><img src="${esc(app.icon)}" alt="" loading="lazy"><div style="min-width:0"><div class="name">${esc(app.name)}</div><div class="genre">${esc(app.genre)}</div></div></div></td>
        <td class="r"><span class="best rank">#${best.rank}</span></td>
        <td class="hide-sm"><span class="where">${flag(best.cc)} ${esc(countryName(best.cc))} · ${chartName(best)}</span></td>
        <td class="hide-sm"><div class="plats">${data.platforms.filter((k) => perPlat[k]).map((k) =>
          `<span class="pl" title="Best on ${PLATFORM_LABEL[k]}: ${esc(countryName(perPlat[k].cc))}">${PLATFORM_LABEL[k]} <b>#${perPlat[k].rank}</b></span>`).join("")}</div></td>
        <td class="r num">${ps.length}<div class="where">${stores} ${stores === 1 ? "store" : "stores"}</div></td>
        <td class="r">${mvHTML(best)}</td>
      </tr>`);
    if (isOpen) {
      const groups = new Map();
      for (const p of ps) {
        const g = chartName(p);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(p);
      }
      const order = (g) => data.platforms.indexOf(groups.get(g)[0].platform);
      const html = [...groups.keys()].sort((a, b) => order(a) - order(b) || a.localeCompare(b)).map((g) => `
        <div class="group"><h4>${g} · ${esc(app.genre)}</h4><div class="chips">${groups.get(g).map((p) =>
          `<span class="chip" title="${esc(countryName(p.cc))}, checked ${ago(p.checked)}">${flag(p.cc)} ${p.cc.toUpperCase()} <span class="rank">#${p.rank}</span> ${mvHTML(p)}</span>`).join("")}</div></div>`).join("");
      rows.push(`<tr><td colspan="7" class="detail">${html}<div class="where" style="margin-top:10px"><a href="${esc(app.url)}" target="_blank" rel="noopener">Open on the App Store</a></div></td></tr>`);
    }
  }
  $("rows").innerHTML = rows.join("");
  return byApp;
}

function renderFeaturing() {
  const feats = featured(data);
  const checked = lastFeatureCheck(data);
  const stores = new Set(Object.values(data.features || {}).flatMap((s) => Object.keys(s)));
  if (!checked) { $("featuring").innerHTML = `<p class="feature-note">Not checked yet. The scanner checks app pages after the charts in each sweep.</p>`; return; }
  if (!feats.length) {
    $("featuring").innerHTML = `<p class="feature-note">No Editors' Choice badge and no “Featured In” story on any of your app pages in ${[...stores].map(flag).join(" ")} (last checked ${ago(checked)}). Today-tab placements aren't visible on app pages; App Store Connect → Featuring shows those.</p>`;
    return;
  }
  $("featuring").innerHTML = `<ul class="feature-list">${feats.map((f) =>
    `<li><b>${esc(f.app?.name)}</b> · ${flag(f.cc)} ${esc(countryName(f.cc))} · ${[f.editorsChoice && "Editors' Choice", f.featuredIn && "Featured In a story"].filter(Boolean).join(" and ")} · seen ${ago(f.checked)}</li>`).join("")}</ul>`;
}

function renderQuiet(byApp) {
  const quiet = Object.entries(data.apps).filter(([aid]) => !byApp.has(aid))
    .sort((a, b) => a[1].name.localeCompare(b[1].name));
  $("quiet").querySelector("summary").textContent = `${quiet.length} ${quiet.length === 1 ? "app" : "apps"} not on any chart in this view`;
  $("quiet-list").innerHTML = quiet.map(([, a]) => `<li>${esc(a.name)} <span style="color:var(--ink-3)">· ${a.platforms.map((k) => PLATFORM_LABEL[k]).join(", ")}</span></li>`).join("");
}

function renderLive() {
  const sc = data.scanner;
  $("scan").textContent = scannerLine(sc);
  $("dot").className = "dot " + (sc.status === "error" ? "err" : sc.backoffSeconds > 0 ? "warn" : sc.status === "scanning" ? "on" : "");
  $("bar").style.width = sc.status === "scanning" && sc.total ? `${(100 * sc.done) / sc.total}%` : sc.status === "resting" ? "100%" : "0";
  $("dev").textContent = `${data.developer.name ?? "Developer"} · ${Object.keys(data.apps).length} apps · ${data.storefronts.length} storefronts`;
}

function render() {
  if (!data) return;
  const all = placements(data);
  const list = filtered(all);
  renderControls(all);
  renderLive();
  renderStats(all, list);
  const byApp = renderRows(list);
  renderFeaturing();
  renderQuiet(byApp);
}

async function tick() {
  try {
    data = await fetchStatus();
    failures = 0;
    $("banner").innerHTML = "";
    render();
  } catch (e) {
    failures++;
    $("dot").className = "dot err";
    $("scan").textContent = "Couldn't load the chart data";
    $("banner").innerHTML = `<div class="banner err" role="alert">Couldn't load the chart data${data ? "; showing the last data received" : ""}. Locally, start the server with <code>python3 server.py</code> in the chart-watch folder. Retrying every ${failures > 3 ? 30 : 10} seconds.</div>`;
  }
  setTimeout(tick, failures > 3 ? 30000 : 10000);
}

document.addEventListener("click", (e) => {
  const seg = e.target.closest(".seg button");
  if (seg) {
    const group = seg.parentElement.id === "platforms" ? "platform" : "chart";
    view[group] = seg.dataset.v;
    if (group === "chart") seg.parentElement.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b === seg));
    render();
    return;
  }
  const row = e.target.closest("tr.app-row");
  if (row && !e.target.closest("a")) toggle(row.dataset.aid);
});
document.addEventListener("keydown", (e) => {
  const row = e.target.closest?.("tr.app-row");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); toggle(row.dataset.aid); }
});
$("store").addEventListener("change", (e) => { view.store = e.target.value; render(); });

function toggle(aid) {
  open.has(aid) ? open.delete(aid) : open.add(aid);
  render();
  document.querySelector(`tr.app-row[data-aid="${aid}"]`)?.focus();
}

setInterval(() => data && renderLive(), 5000);
tick();
