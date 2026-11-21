#!/usr/bin/env python3
"""Chart Watch: a local server that keeps reading Apple's App Store top charts for
iPhone, iPad, Apple Watch, Mac and Apple Vision Pro, finds one developer's apps in
them, checks each app page for Editors' Choice and "Featured In", and serves a
dashboard (/) and a compact widget (/widget) that poll /api/status.

Run:  python3 server.py            then open http://localhost:8787
Env:  DEVELOPER_ID, PORT, REST_MINUTES
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DEVELOPER_ID = os.environ.get("DEVELOPER_ID", "1522352514")
PORT = int(os.environ.get("PORT", "8787"))
REST_MINUTES = float(os.environ.get("REST_MINUTES", "20"))
# Largest markets first, so the dashboard fills in where it matters most.
STOREFRONTS = ("us gb ca au in jp de fr cn kr br mx ae sa it es nl se ch tr "
               "ru pl tw hk sg my th id ph vn il za ar nz no dk fi at be ie pt").split()
FEATURE_STOREFRONTS = "us gb in jp de ae".split()
PLATFORMS = ["iphone", "ipad", "watch", "mac", "vision"]
WORKERS = 2          # parallel fetches; Apple answers 429 above a few per second
PAUSE = 0.7          # seconds between fetches per worker
HISTORY_LIMIT = 60   # rank changes kept per chart

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(HERE, "state.json")
SEED_FILE = os.path.join(HERE, "seed.json")
WEB_DIR = os.path.join(HERE, "web")
UA = {"User-Agent": "Mozilla/5.0 (Macintosh)"}

lock = threading.Lock()
state = {
    "developer": {"id": DEVELOPER_ID, "name": None},
    "apps": {},      # app_id -> {name, bundle, genre, genreId, icon, url, platforms}
    "ranks": {},     # app_id -> "platform|cc|chart|scope" -> {rank, previous, checked}
    "history": {},   # app_id -> key -> [[iso, rank_or_null], ...]
    "features": {},  # app_id -> cc -> {editorsChoice, featuredIn, checked}
    "scanner": {"status": "starting", "phase": None, "sweep": 0, "done": 0, "total": 0,
                "current": None, "lastSweepFinished": None, "lastError": None,
                "backoffUntil": None, "nextSweepAt": None},
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def get(url, retries=6):
    """Fetch a URL, backing off on 403/429. Returns text, or None for 404."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            return urllib.request.urlopen(req, timeout=30).read().decode("utf8", "ignore")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            wait = 15 * (attempt + 1)
            with lock:
                state["scanner"]["backoffUntil"] = time.time() + wait
                state["scanner"]["lastError"] = f"Apple returned HTTP {e.code}; pausing {wait}s"
            time.sleep(wait)
        except Exception as e:
            with lock:
                state["scanner"]["lastError"] = f"Network error: {e}"[:120]
            time.sleep(5)
    raise RuntimeError("gave up after retries")


def platforms_of(a):
    devices = a.get("supportedDevices", [])
    p = set()
    if a.get("kind") == "mac-software":
        p.add("mac")
    for d in devices:
        if d.startswith("iPhone"):
            p.add("iphone")
        elif d.startswith("iPad"):
            p.add("ipad")
        elif d.startswith("Watch"):
            p.add("watch")
        elif d.startswith("MacDesktop"):
            p.add("mac")
        elif d.startswith(("AppleVision", "RealityDevice")):
            p.add("vision")
    return sorted(p)


def load_apps():
    data = json.loads(get(f"https://itunes.apple.com/lookup?id={DEVELOPER_ID}&entity=software&limit=200"))
    results = data["results"]
    apps = {}
    for a in results[1:]:
        apps[str(a["trackId"])] = {
            "name": a["trackName"], "bundle": a["bundleId"],
            "genre": a.get("primaryGenreName", ""), "genreId": str(a.get("primaryGenreId", "")),
            "icon": a.get("artworkUrl100"), "url": a.get("trackViewUrl", "").split("?")[0],
            "platforms": platforms_of(a),
        }
    with lock:
        state["developer"]["name"] = results[0].get("artistName") if results else None
        state["apps"] = apps


def eligible(app, platform):
    """Could this app appear on that platform's chart? iPad apps can also run on
    Apple Vision Pro and Apple silicon Macs, so they are eligible there too."""
    p = app["platforms"]
    if platform in p:
        return True
    return platform in ("vision", "mac") and "ipad" in p


SEGMENT_RE = re.compile(r'"\$kind":"TopChartSegment".{0,200}?"chart":"(top-free|top-paid)"', re.S)
LOCKUP_RE = re.compile(r'"adamId":"(\d+)"(?:(?!"adamId").){0,4000}?"ordinal":"(\d+)"', re.S)
REMAINING_RE = re.compile(r'"nextPage":\{"remainingContent":\[(.*?)\]', re.S)


def parse_chart_page(html):
    """Returns {"top-free": [app ids in rank order], "top-paid": [...]}, up to 200 each."""
    marks = [(m.start(), m.group(1)) for m in SEGMENT_RE.finditer(html)]
    charts = {}
    for i, (start, chart) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(html)
        seg = html[start:end]
        ordered = [aid for aid, _ in sorted(((a, int(o)) for a, o in LOCKUP_RE.findall(seg)), key=lambda x: x[1])]
        rem = REMAINING_RE.search(seg)
        if rem:
            ordered += re.findall(r'"id":"(\d+)"', rem.group(1))
        charts[chart] = list(dict.fromkeys(ordered))
    return charts


def record(aid, key, rank, stamp):
    prev = state["ranks"].setdefault(aid, {}).get(key)
    state["ranks"][aid][key] = {"rank": rank, "previous": prev["rank"] if prev else None,
                                "first": prev is None, "checked": stamp}
    hist = state["history"].setdefault(aid, {}).setdefault(key, [])
    if not hist or hist[-1][1] != rank:
        hist.append([stamp, rank])
        del hist[:-HISTORY_LIMIT]


def chart_job(cc, platform, genre):
    path = f"https://apps.apple.com/{cc}/{platform}/charts" + (f"/{genre}" if genre else "")
    html = get(path)
    if html is None:
        return
    charts = parse_chart_page(html)
    if not charts:
        return
    stamp = now()
    with lock:
        for aid, app in state["apps"].items():
            if not eligible(app, platform) or (genre and app["genreId"] != genre):
                continue
            scope = "category" if genre else "overall"
            for chart, ids in charts.items():
                rank = ids.index(aid) + 1 if aid in ids else None
                key = f"{platform}|{cc}|{chart}|{scope}"
                # Overall charts are rarely reached; keep them only when ranked.
                if scope == "overall" and rank is None and key not in state["ranks"].get(aid, {}):
                    continue
                record(aid, key, rank, stamp)


def feature_job(cc, aid):
    with lock:
        bundle = state["apps"][aid]["bundle"]
    html = get(f"https://apps.apple.com/{cc}/app/id{aid}")
    if html is None:
        return
    ec = re.search(r'"bundleId":"%s","isEditorsChoice":(true|false)' % re.escape(bundle), html)
    fi = re.search(r'"featuredIn":\{"\$kind":"Shelf".{0,3000}?"items":\[(.)', html, re.S)
    with lock:
        state["features"].setdefault(aid, {})[cc] = {
            "editorsChoice": bool(ec and ec.group(1) == "true"),
            "featuredIn": bool(fi and fi.group(1) != "]"),
            "checked": now(),
        }


def build_jobs():
    with lock:
        apps = dict(state["apps"])
    jobs = []
    for cc in STOREFRONTS:
        for platform in PLATFORMS:
            genres = sorted({a["genreId"] for a in apps.values() if eligible(a, platform) and a["genreId"]})
            if not genres:
                continue
            jobs.append(("chart", cc, platform, None))
            jobs += [("chart", cc, platform, g) for g in genres]
    jobs += [("feature", cc, aid) for cc in FEATURE_STOREFRONTS for aid in apps]
    return jobs


def save():
    with lock:
        blob = json.dumps(state)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        f.write(blob)
    os.replace(tmp, STATE_FILE)


def seed():
    """Start from the last saved state, or from the earlier one-off scan in seed.json
    (iPhone category ranks read from each app page's chart badge)."""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            saved = json.load(f)
        if "features" in saved:  # current format
            state["scanner"]["sweep"] = saved.get("scanner", {}).get("sweep", 0)
            saved["scanner"] = state["scanner"]
            saved["apps"] = state["apps"] or saved.get("apps", {})
            state.update(saved)
            return
    if not os.path.exists(SEED_FILE):
        return
    with open(SEED_FILE) as f:
        old = json.load(f)
    by_name = {v["name"]: k for k, v in state["apps"].items()}
    stamp = datetime.fromtimestamp(os.path.getmtime(SEED_FILE), timezone.utc).isoformat(timespec="seconds")
    for name, stores in old.items():
        aid = by_name.get(name)
        if not aid:
            continue
        for cc, r in stores.items():
            if r.get("error") or r.get("na"):
                continue
            ch = r.get("chart")
            if ch:
                record(aid, f"iphone|{cc}|{ch[3]}|category", int(ch[0]), stamp)
            if cc in FEATURE_STOREFRONTS:
                state["features"].setdefault(aid, {})[cc] = {
                    "editorsChoice": r.get("ec") == "true", "featuredIn": bool(r.get("featuredIn")),
                    "checked": stamp}


def run_sweep(log=False):
    """One full pass over every chart and feature page."""
    load_apps()
    jobs = build_jobs()
    with lock:
        sc = state["scanner"]
        sc.update(status="scanning", sweep=sc["sweep"] + 1, done=0, total=len(jobs), nextSweepAt=None)
    it = iter(jobs)
    it_lock = threading.Lock()

    def worker():
        while True:
            with it_lock:
                job = next(it, None)
            if job is None:
                return
            with lock:
                state["scanner"]["current"] = {"kind": job[0], "storefront": job[1],
                                               "platform": job[2] if job[0] == "chart" else None}
            try:
                if job[0] == "chart":
                    chart_job(*job[1:])
                else:
                    feature_job(*job[1:])
                with lock:
                    state["scanner"]["backoffUntil"] = None
            except Exception as e:
                with lock:
                    state["scanner"]["lastError"] = f"Skipped a {job[0]} page in {job[1].upper()}: {e}"[:160]
            with lock:
                state["scanner"]["done"] += 1
                done = state["scanner"]["done"]
            if log and done % 100 == 0:
                print(f"{done}/{len(jobs)} pages", flush=True)
            time.sleep(PAUSE)

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(WORKERS)]
    for t in threads:
        t.start()
    while any(t.is_alive() for t in threads):
        time.sleep(20)
        save()
    with lock:
        state["scanner"].update(status="resting", current=None, lastSweepFinished=now())
    save()


def scanner():
    while True:
        try:
            run_sweep()
        except Exception as e:
            with lock:
                state["scanner"].update(status="error", lastError=f"Couldn't load the app list: {e}"[:160])
            time.sleep(60)
            continue
        with lock:
            state["scanner"]["nextSweepAt"] = time.time() + REST_MINUTES * 60
        time.sleep(REST_MINUTES * 60)


def status_body():
    with lock:
        body = dict(state)
        sc = body["scanner"] = dict(state["scanner"])
        b, n = sc.pop("backoffUntil", None), sc.pop("nextSweepAt", None)
        sc["backoffSeconds"] = max(0, int(b - time.time())) if b else 0
        sc["nextSweepSeconds"] = max(0, int(n - time.time())) if n else None
        body["storefronts"] = STOREFRONTS
        body["platforms"] = PLATFORMS
        body["serverTime"] = now()
        return json.dumps(body)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB_DIR, **kw)

    def log_message(self, *a):
        pass

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/api/status":
            data = status_body().encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return
        if route == "/widget":
            self.path = "/widget.html"
        return super().do_GET()


def run_once():
    """Scheduled mode (GitHub Actions): one sweep, then write web/status.json for the
    static dashboard. Exits non-zero when nothing was found, so a blocked run is visible."""
    load_apps()
    seed()
    run_sweep(log=True)
    with lock:
        sc = state["scanner"]
        sc.update(status="static", schedule=os.environ.get("SCHEDULE_LABEL", "every 2 hours"))
        errors = sc.get("lastError")
    body = status_body()
    with open(os.path.join(WEB_DIR, "status.json"), "w") as f:
        f.write(body)
    placed = sum(1 for keys in state["ranks"].values() for r in keys.values() if r.get("rank"))
    print(f"Sweep done: {placed} chart placements. Last error: {errors}")
    if placed == 0:
        raise SystemExit("No chart placements found; Apple may be blocking this runner.")


if __name__ == "__main__":
    import sys
    if "--once" in sys.argv:
        run_once()
        raise SystemExit(0)
    try:
        load_apps()
    except Exception as e:
        print("Couldn't load the app list yet:", e)
    seed()
    threading.Thread(target=scanner, daemon=True).start()
    print(f"Chart Watch running: http://localhost:{PORT}  (widget: http://localhost:{PORT}/widget)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
