// scripts/scrape-and-build-ics.mjs
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import ical from "node-ical";
import { createEvents } from "ics";
import cfg from "./config.mjs";

const log = (...a) => console.log("[involve-ics]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }

function windowBounds() {
  const tz = cfg.timeZone || "Europe/London";
  const start =
    (cfg.startDate && DateTime.fromISO(cfg.startDate, { zone: tz }).startOf("day")) ||
    DateTime.now().setZone(tz).startOf("day");
  const end = start.plus({ days: cfg.windowDays });
  return { start, end, tz };
}

function isLikelyEventsJSON(obj) {
  if (!obj) return false;
  if (Array.isArray(obj) && obj.length && typeof obj[0] === "object") {
    const keys = Object.keys(obj[0]).map(k => k.toLowerCase());
    return keys.some(k => ["start","startdate","start_time","starts","starts_at","begins","dtstart","starttime"].includes(k));
  }
  if (obj.events && Array.isArray(obj.events)) return true;
  if (obj.data && Array.isArray(obj.data)) return true;
  return false;
}

function normaliseFromJSON(raw, tz) {
  const arr = Array.isArray(raw?.events) ? raw.events
          : Array.isArray(raw?.data)   ? raw.data
          : Array.isArray(raw)         ? raw : [];
  const out = [];
  for (const e of arr) {
    const title = (e.title || e.name || "School event").toString().trim();
    const location = (e.location || e.place || "").toString().trim();
    const description = (e.description || "").toString();
    const url = e.url || e.link || e.event_url || null;
    const allDay = !!(e.all_day || e.allDay);
    const s  = e.start || e.starts_at || e.start_date || e.startDate || e.startsAt || e.starts || e.start_time || e.dtstart;
    const en = e.end   || e.ends_at   || e.end_date   || e.endDate   || e.endsAt   || e.ends   || e.end_time   || e.dtend;

    let start = typeof s === "number" ? DateTime.fromMillis(s, { zone: "utc" }) : DateTime.fromISO(String(s), { zone: "utc" });
    let end   = en ? (typeof en === "number" ? DateTime.fromMillis(en, { zone: "utc" }) : DateTime.fromISO(String(en), { zone: "utc" })) : null;

    if (!start.isValid) continue;
    if (!end) end = start.plus({ hours: 1 });
    if (end <= start) end = start.plus({ minutes: 30 });

    out.push({ title, location, description, url, allDay, start: start.setZone(tz), end: end.setZone(tz) });
  }
  return out;
}

function uniqBy(arr, idFn) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = idFn(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

async function acceptCookies(page) {
  const candidates = [
    'button:has-text("Accept")','button:has-text("I agree")','button:has-text("Allow all")',
    '[aria-label*="accept" i]','[data-testid*="accept" i]'
  ];
  for (const sel of candidates) {
    try { const el = await page.$(sel); if (el) { await el.click({ timeout: 1000 }).catch(()=>{}); await sleep(300); } } catch {}
  }
}

async function autoScrollExhaustive(page) {
  // Trigger lazy loads by scrolling until height stabilises
  let last = 0, stable = 0;
  for (let i = 0; i < 40 && stable < 3; i++) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    if (h <= last) stable++; else stable = 0;
    last = h;
    await page.evaluate(() => window.scrollBy(0, 900));
    await page.waitForTimeout(200);
  }
  await page.waitForLoadState("networkidle").catch(()=>{});
}

async function readHeaderText(page) {
  // Try likely selectors for the date-range text; fall back to largest H-tag in header-ish areas
  const candidates = [
    '[class*="calendar" i] [class*="header" i]',
    '[role="heading"]',
    'header h1, header h2, header h3',
    '[class*="date-range" i]',
    'h1, h2'
  ];
  for (const sel of candidates) {
    try {
      const txt = await page.locator(sel).first().textContent({ timeout: 500 }).catch(() => null);
      if (txt && txt.trim().length > 0) return txt.trim();
    } catch {}
  }
  // Fallback: body text snapshot (cheap heuristic)
  try { return (await page.locator("body").textContent({ timeout: 500 })).slice(0, 200) || ""; } catch { return ""; }
}

async function clickWeekNav(page, which /* "next" | "prev" */) {
  // Return true only if the header text actually changes.
  const before = await readHeaderText(page);

  const selectorSets = {
    next: [
      '[aria-label="Next"]','[data-testid*="next" i]','button[aria-label*="next" i]',
      'button:has-text("Next")','[class*="next" i] button','[aria-label^="Next week" i]'
    ],
    prev: [
      '[aria-label="Previous"]','[data-testid*="prev" i]','button[aria-label*="prev" i]',
      'button:has-text("Previous")','[class*="prev" i] button','[aria-label^="Previous week" i]'
    ]
  };

  // Strategy 1: conventional selectors
  for (const sel of selectorSets[which]) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ timeout: 1500 }).catch(()=>{});
        await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(()=>{});
        await page.waitForTimeout(500);
        const after = await readHeaderText(page);
        if (after && after !== before) { log(`clicked ${which} via selector ${sel}`); return true; }
      }
    } catch {}
  }

  // Strategy 2: keyboard (only counts if header changes)
  try {
    await page.keyboard.press(which === "next" ? "ArrowRight" : "ArrowLeft");
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});
    await page.waitForTimeout(400);
    const after = await readHeaderText(page);
    if (after && after !== before) { log(`pressed keyboard ${which}`); return true; }
  } catch {}

  // Strategy 3: offset click near header text (right or left)
  try {
    const headerLoc = page.locator('header, [class*="header" i]').first();
    const box = await headerLoc.boundingBox();
    if (box) {
      const x = which === "next" ? box.x + box.width - 10 : box.x + 10;
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y);
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(()=>{});
      await page.waitForTimeout(400);
      const after = await readHeaderText(page);
      if (after && after !== before) { log(`clicked ${which} via offset near header`); return true; }
    }
  } catch {}

  return false;
}

(async () => {
  const watchdogEnds = Date.now() + 120000; // 120s wall clock watchdog
  const { start, end } = windowBounds();

  const browser = await chromium.launch({ args: ["--lang=en-GB"], headless: true });
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: cfg.timeZone || "Europe/London",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 }
  });

  // Capture candidate JSON across all frames/content-types
  const captured = [];
  context.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const url = resp.url();
      if (!/event|cal|sched|activity|occurrence|timeline|calendar|feed|graphql|api/i.test(url)) return;
      if (ct.includes("json") || ct.includes("javascript") || ct.includes("text/plain")) {
        let data = null;
        try { data = await resp.json(); }
        catch { const txt = await resp.text(); try { data = JSON.parse(txt); } catch {} }
        if (data) captured.push({ url, json: data, ct });
      }
    } catch {}
  });

  const page = await context.newPage();
  if (cfg.debug?.enabled) page.on("console", msg => console.log("[page]", msg.type(), msg.text()));

  log("Loading", cfg.targetUrl);
  await page.goto(cfg.targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(()=>{});
  await autoScrollExhaustive(page);

  const allNormalised = () => captured.flatMap(c => { try { return normaliseFromJSON(c.json, cfg.timeZone); } catch { return []; } });

  // Helper: current coverage
  const coverage = () => {
    const evs = allNormalised();
    if (!evs.length) return { min: null, max: null, okStart: false, okEnd: false, count: 0 };
    const min = evs.reduce((a,b)=> a.start < b.start ? a : b).start;
    const max = evs.reduce((a,b)=> a.start > b.start ? a : b).start;
    return { min, max, okStart: !!min && min <= start, okEnd: !!max && max >= end.minus({minutes:1}), count: evs.length };
  };

  // Expand both ways with strong guards
  let stale = 0;
  let lastCount = 0;
  let iterations = 0;
  const MAX_ITER = 20;
  const MAX_STALE = 5;

  // First try to ensure we include the start bound
  while (Date.now() < watchdogEnds && iterations < MAX_ITER) {
    iterations++;
    const { okStart, count } = coverage();
    if (okStart) break;
    const moved = await clickWeekNav(page, "prev");
    if (!moved) break;
    await autoScrollExhaustive(page);

    if (count === lastCount) stale++; else stale = 0;
    lastCount = count;
    if (stale >= MAX_STALE) { log("stopping: stale while going prev"); break; }
  }

  stale = 0;
  // Then ensure we include the end bound
  while (Date.now() < watchdogEnds && iterations < MAX_ITER) {
    iterations++;
    const { okEnd, count } = coverage();
    if (okEnd) break;
    const moved = await clickWeekNav(page, "next");
    if (!moved) break;
    await autoScrollExhaustive(page);

    if (count === lastCount) stale++; else stale = 0;
    lastCount = count;
    if (stale >= MAX_STALE) { log("stopping: stale while going next"); break; }
  }

  // Prefer captured JSON; dedupe
  let events = uniqBy(allNormalised(), e => `${e.title}|${e.start.toISO()}|${e.location || ""}`);
  // Filter to window
  events = events.filter(e => e.start < end && e.end > start);

  // Debug artefacts
  if (cfg.debug?.enabled) {
    try { ensureDir(cfg.debug.htmlPath); fs.writeFileSync(cfg.debug.htmlPath, await page.content(), "utf8"); } catch {}
    try { ensureDir(cfg.debug.screenshotPath); await page.screenshot({ path: cfg.debug.screenshotPath, fullPage: true }); } catch {}
    try {
      ensureDir(cfg.debug.networkLogPath);
      const redacted = captured.map(({ url, ct, json }) => ({ url, ct, keys: json && typeof json === "object" ? Object.keys(json) : [] }));
      fs.writeFileSync(cfg.debug.networkLogPath, JSON.stringify({ count: captured.length, entries: redacted }, null, 2), "utf8");
    } catch {}
  }

  await browser.close();

  // Sanity threshold
  if ((events.length || 0) < (cfg.sanity?.minEvents ?? 1)) {
    throw new Error(`Sanity check: only ${events.length} events found (min ${cfg.sanity?.minEvents}).`);
  }

  // Build ICS
  const icsEvents = events.map(e => {
    const s = e.start.setZone("utc");
    const en = e.end.setZone("utc");
    const base = {
      uid: `involve-${s.toMillis()}-${e.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      title: e.title,
      status: "CONFIRMED",
      calName: "School Calendar",
      productId: "Involve→ICS",
      busyStatus: "BUSY",
      location: e.location || undefined,
      description: e.description || undefined,
      url: e.url || undefined
    };
    if (e.allDay) {
      return { ...base, startInputType: "utc", endInputType: "utc", start: [s.year, s.month, s.day], end: [en.year, en.month, en.day] };
    } else {
      return { ...base, startInputType: "utc", endInputType: "utc", start: [s.year, s.month, s.day, s.hour, s.minute], end: [en.year, en.month, en.day, en.hour, en.minute] };
    }
  });

  const icsText = await new Promise((resolve, reject) => {
    createEvents(icsEvents, (err, value) => {
      if (err) return reject(err);
      ensureDir(cfg.outputPath);
      fs.writeFileSync(cfg.outputPath, value, "utf8");
      resolve(value);
    });
  });

  // Validate round-trip
  const parsed = ical.parseICS(icsText);
  const icsEventsParsed = Object.values(parsed).filter(v => v.type === "VEVENT");
  const within = (d) => d >= start.toJSDate() && d <= end.toJSDate();
  const icsWindow = icsEventsParsed.filter(v => within(v.start));

  if (icsWindow.length !== events.length) {
    throw new Error(`Validation failed: ICS count ${icsWindow.length} != source count ${events.length}`);
  }

  fs.writeFileSync(cfg.outputJsonPath, JSON.stringify(events, null, 2));

  if (cfg.sanity?.protectLastGood) {
    fs.copyFileSync(cfg.outputPath, cfg.sanity.lastGoodPath);
  }

  console.log(`\n✅ Built and validated ${events.length} events → ${cfg.outputPath}`);
})();
