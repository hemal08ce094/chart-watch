// Shared data helpers for the dashboard and the widget.
export const PLATFORM_LABEL = { iphone: "iPhone", ipad: "iPad", watch: "Watch", mac: "Mac", vision: "Vision" };
export const CHART_LABEL = { "top-paid": "Paid", "top-free": "Free" };

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });
export const countryName = (cc) => { try { return regionNames.of(cc.toUpperCase()); } catch { return cc.toUpperCase(); } };
export const flag = (cc) => cc.toUpperCase().replace(/./g, (c) => String.fromCodePoint(0x1f1a5 + c.charCodeAt(0)));
export const fmt = new Intl.NumberFormat("en");

// Live local server first; otherwise the status.json the scheduled GitHub run publishes.
export async function fetchStatus() {
  try {
    const live = await fetch("api/status", { cache: "no-store" });
    if (live.ok && (live.headers.get("content-type") || "").includes("json")) return live.json();
  } catch { /* no local server */ }
  const res = await fetch(`status.json?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`status.json answered ${res.status}`);
  return res.json();
}

// Every chart position an app currently holds.
export function placements(data) {
  const out = [];
  for (const [aid, keys] of Object.entries(data.ranks || {})) {
    const app = data.apps[aid];
    if (!app) continue;
    for (const [key, r] of Object.entries(keys)) {
      if (r.rank == null) continue;
      const [platform, cc, chart, scope] = key.split("|");
      out.push({ aid, app, key, platform, cc, chart, scope, rank: r.rank, previous: r.previous, first: r.first, checked: r.checked });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

// Positive = climbed. "first" on the first check of a chart, "new" when it was unranked last time.
export function movement(p) {
  if (p.first) return { kind: "first" };
  if (p.previous == null) return { kind: "new" };
  const d = p.previous - p.rank;
  return d > 0 ? { kind: "up", d } : d < 0 ? { kind: "down", d: -d } : { kind: "same" };
}

export function featured(data) {
  const hits = [];
  for (const [aid, stores] of Object.entries(data.features || {})) {
    for (const [cc, f] of Object.entries(stores)) {
      if (f.editorsChoice || f.featuredIn) hits.push({ aid, app: data.apps[aid], cc, ...f });
    }
  }
  return hits;
}

export function lastFeatureCheck(data) {
  let latest = null;
  for (const stores of Object.values(data.features || {}))
    for (const f of Object.values(stores)) if (!latest || f.checked > latest) latest = f.checked;
  return latest;
}

export function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function scannerLine(sc) {
  if (!sc) return "";
  if (sc.status === "static") return `Updated ${ago(sc.lastSweepFinished)} · refreshes ${sc.schedule || "on a schedule"}`;
  if (sc.status === "error") return sc.lastError || "The scanner hit an error";
  if (sc.backoffSeconds > 0) return `Apple asked us to slow down · resuming in ${sc.backoffSeconds}s`;
  if (sc.status === "scanning") {
    const c = sc.current;
    const where = c ? `${countryName(c.storefront)}${c.platform ? " · " + PLATFORM_LABEL[c.platform] : " · featuring"}` : "";
    return `Scanning ${where} · ${fmt.format(sc.done)} of ${fmt.format(sc.total)} pages`;
  }
  if (sc.status === "resting") {
    const m = sc.nextSweepSeconds != null ? Math.ceil(sc.nextSweepSeconds / 60) : null;
    return `Sweep ${sc.sweep} finished ${ago(sc.lastSweepFinished)}${m != null ? ` · next in ${m} min` : ""}`;
  }
  return "Starting the scanner";
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
