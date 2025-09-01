// scripts/scrape-and-build-ics.mjs
// Loads the Involve page in a real browser (Playwright), captures JSON responses,
// falls back to DOM parsing if necessary, aggregates events across week-by-week
// navigation, filters to the configured window, emits a standards-compliant ICS,
// and validates the ICS against the source before publishing.
//
// Requires: playwright, luxon, ics, node-ical
// Config:   scripts/config.mjs

import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import ical from "node-ical";
import { createEvents } from "ics";
import cfg from "./config.mjs";

const log = (...a) => console.log("[involve-ics]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

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
    const keys = Object.keys(obj[0]).map((k) => k.toLowerCase());
    return keys.some((k) =>
      [
        "start",
        "startdate",
        "start_time",
        "starts",
        "starts_at",
        "begins",
        "dtstart",
        "starttime",
      ].includes(k)
    );
  }
  if (obj.events && Array.isArray(obj.events)) return true;
  if (obj.data && Array.isArray(obj.data)) return true;
  return false;
}

function normaliseFromJSON(raw, tz) {
  const arr = Array.isArray(raw?.events)
    ? raw.events
    : Array.isArray(raw?.data)
    ? raw.data
    : Array.isArray(raw)
    ? raw
    : [];
  const out = [];
  for (const e of arr) {
    const title = (e.title || e.name || "School event").toString().trim();
    const location = (e.location || e.place || "").toString().trim();
    const description = (e.description || "").toString();
    const url = e.url || e.link || e.event_url || null;
    const allDay = !!(e.all_day || e.allDay);

    const s =
      e.start ||
      e.starts_at ||
      e.start_date ||
      e.startDate ||
      e.startsAt ||
      e.starts ||
      e.start_time ||
      e.dtstart;
    const en =
      e.end ||
      e.ends_at ||
      e.end_date ||
      e.endDate ||
      e.endsAt ||
      e.ends ||
      e.end_time ||
      e.dtend;

    let start =
      typeof s === "number"
        ? DateTime.fromMillis(s, { zone: "utc" })
        : DateTime.fromISO(String(s), { zone: "utc" });
    let end = en
      ? typeof en === "number"
        ? DateTime.fromMillis(en, { zone: "utc" })
        : DateTime.fromISO(String(en), { zone: "utc" })
      : null;

    if (!start.isValid) continue;
    if (!end) end = start.plus({ hours: 1 });
    if (end <= start) end = start.plus({ minutes: 30 });

    out.push({
      title,
      location,
      description,
      url,
      allDay,
      start: start.setZone(tz),
      end: end.setZone(tz),
    });
  }
  return out;
}

async function acceptCookies(page) {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Allow all")',
    '[aria-label*="accept" i]',
    '[data-testid*="accept" i]',
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1000 }).catch(() => {});
        await sleep(400);
      }
    } catch {}
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const distance = 600;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        total += distance;
        if (total > document.body.scrollHeight * 1.5) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  });
}

async function pageNext(page) {
  const selectors = [
    '[aria-label="Next"]',
    '[data-testid*="next" i]',
    'button[aria-label*="next" i]',
    'button:has-text("Next")',
    '[class*="next" i] button',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ timeout: 2000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
  }
  return false;
}

async function scrape() {
  // Browser context tuned for a typical UK desktop
  const browser = await chromium.launch({ args: ["--lang=en-GB"], headless: true });
  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: cfg.timeZone || "Europe/London",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });

  // Capture candidate JSON across all frames and content-types
  const captured = [];
  context.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const url = resp.url();
      if (!/event|cal|sched|activity|occurrence|timeline|calendar|feed|graphql|api/i.test(url))
        return;

      if (ct.includes("json") || ct.includes("javascript") || ct.includes("text/plain")) {
        let data = null;
        try {
          data = await resp.json();
        } catch {
          const txt = await resp.text();
          try {
            data = JSON.parse(txt);
          } catch {
            /* ignore */
          }
        }
        if (data) captured.push({ url, json: data, ct });
      }
    } catch {}
  });

  const page = await context.newPage();
  if (cfg.debug?.enabled) {
    page.on("console", (msg) => console.log("[page]", msg.type(), msg.text()));
  }

  log("Loading", cfg.targetUrl);
  await page.goto(cfg.targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await acceptCookies(page);

  // Initial network/lazy-load settle
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await autoScroll(page);
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await sleep(800);

  // Advance the calendar to ensure we capture at least a fortnight of data
  const { start, end } = (function () {
    const tz = cfg.timeZone || "Europe/London";
    const s =
      (cfg.startDate &&
        DateTime.fromISO(cfg.startDate, { zone: tz }).startOf("day")) ||
      DateTime.now().setZone(tz).startOf("day");
    const e = s.plus({ days: cfg.windowDays });
    return { start: s, end: e };
  })();

  for (let i = 0; i < 6; i++) {
    // Stop early if captured JSON already includes events beyond our end bound
    const hasBeyondEnd = captured.some((c) => {
      try {
        const norm = normaliseFromJSON(c.json, cfg.timeZone);
        return norm.some((ev) => ev.start >= end);
      } catch {
        return false;
      }
    });
    if (hasBeyondEnd) break;

    const moved = await pageNext(page);
    if (!moved) break;
    await autoScroll(page);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await sleep(400);
  }

  // Prefer captured JSON
  let events = [];
  for (const c of captured) {
    if (isLikelyEventsJSON(c.json)) {
      const batch = normaliseFromJSON(c.json, cfg.timeZone);
      if (batch.length) {
        events = events.concat(batch);
      }
    }
  }

  // Fallback to DOM parsing (heuristics) if no JSON
  if (!events.length) {
    const dom = await page.evaluate(() => {
      const items = [];
      const candidates = document.querySelectorAll(
        '[data-event], [class*="event" i], [class*="calendar" i], article, li'
      );
      candidates.forEach((el) => {
        const text = el.innerText || "";
        const title =
          el.querySelector("h1,h2,h3,.title,[class*='title' i]")?.textContent?.trim();
        const when =
          el.querySelector("[class*='date' i],[class*='time' i],time")?.textContent?.trim();
        const where =
          el.querySelector("[class*='location' i],[class*='place' i]")?.textContent?.trim();
        const href = el.querySelector("a")?.href || null;
        if (
          title &&
          (when ||
            /\d{1,2}:\d{2}|am|pm|Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(
              text
            ))
        ) {
          items.push({ title, when, where, href, rawText: text });
        }
      });
      return items;
    });

    const tz = cfg.timeZone;
    const parseWhen = (_t, whenText) => {
      if (!whenText) return null;
      const cleaned = whenText.replace(/\s+–\s+/g, " - ").replace(/\u2013|\u2014/g, "-");

      let m =
        cleaned.match(
          /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+(\d{1,2}\s+\w+\s+\d{4})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/i
        ) || cleaned.match(/(\d{1,2}\s+\w+\s+\d{4})\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/i);
      if (m) {
        const datePart = m[2] ?? m[1];
        const t1 = m[m.length - 2];
        const t2 = m[m.length - 1];
        const d = DateTime.fromFormat(`${datePart} ${t1}`, "d LLL yyyy HH:mm", { zone: tz });
        const e = DateTime.fromFormat(`${datePart} ${t2}`, "d LLL yyyy HH:mm", { zone: tz });
        if (d.isValid && e.isValid) return { start: d, end: e, allDay: false };
      }

      m = cleaned.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
      if (m) {
        const d = DateTime.fromFormat(`${m[1]} ${m[2]} ${m[3]}`, "d LLL yyyy", { zone: tz });
        if (d.isValid)
          return { start: d.startOf("day"), end: d.plus({ days: 1 }).startOf("day"), allDay: true };
      }
      return null;
    };

    events = dom
      .map((e) => {
        const parsed = parseWhen(e.title, e.when || e.rawText);
        if (!parsed) return null;
        return {
          title: e.title,
          location: e.where || "",
          description: "",
          url: e.href || null,
          allDay: parsed.allDay,
          start: parsed.start,
          end: parsed.end,
        };
      })
      .filter(Boolean);

    log("DOM extraction produced", events.length, "events");
  }

  // Debug artefacts
  if (cfg.debug?.enabled) {
    try {
      ensureDir(cfg.debug.htmlPath);
      fs.writeFileSync(cfg.debug.htmlPath, await page.content(), "utf8");
    } catch {}
    try {
      ensureDir(cfg.debug.screenshotPath);
      await page.screenshot({ path: cfg.debug.screenshotPath, fullPage: true });
    } catch {}
    try {
      ensureDir(cfg.debug.networkLogPath);
      const redacted = captured.map(({ url, ct, json }) => ({ url, ct, keys: Object.keys(json || {}) }));
      fs.writeFileSync(
        cfg.debug.networkLogPath,
        JSON.stringify({ count: captured.length, entries: redacted }, null, 2),
        "utf8"
      );
    } catch {}
  }

  await browser.close();
  return events;
}

function filterWindow(all, start, end) {
  // Keep only events overlapping the window
  return all.filter((e) => e.start < end && e.end > start);
}

function toIcsEvents(evts) {
  // The `ics` lib wants arrays in UTC: [yyyy,m,d] or [yyyy,m,d,hh,mm]
  return evts.map((e) => {
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
      url: e.url || undefined,
    };
    if (e.allDay) {
      return {
        ...base,
        startInputType: "utc",
        endInputType: "utc",
        start: [s.year, s.month, s.day],
        end: [en.year, en.month, en.day], // exclusive end for all-day
      };
    } else {
      return {
        ...base,
        startInputType: "utc",
        endInputType: "utc",
        start: [s.year, s.month, s.day, s.hour, s.minute],
        end: [en.year, en.month, en.day, en.hour, en.minute],
      };
    }
  });
}

function writeICS(icsEvents, outPath) {
  return new Promise((resolve, reject) => {
    createEvents(icsEvents, (err, value) => {
      if (err) return reject(err);
      ensureDir(outPath);
      fs.writeFileSync(outPath, value, "utf8");
      resolve(value);
    });
  });
}

function validateAgainstSource(events, icsText, start, end) {
  const parsed = ical.parseICS(icsText);
  const icsEvents = Object.values(parsed).filter((v) => v.type === "VEVENT");

  const within = (d) => d >= start.toJSDate() && d <= end.toJSDate();

  const srcWindow = events.filter((e) => e.start < end && e.end > start);
  const icsWindow = icsEvents.filter((v) => within(v.start));

  if (icsWindow.length !== srcWindow.length) {
    throw new Error(
      `Validation failed: ICS count ${icsWindow.length} != source count ${srcWindow.length}`
    );
  }

  if (cfg.expectedCounts) {
    const w1End = start.plus({ days: 7 });
    const w1src = srcWindow.filter((e) => e.start < w1End);
    const w2src = srcWindow.filter((e) => e.start >= w1End);

    const w1ics = icsWindow.filter((v) => v.start < w1End.toJSDate());
    const w2ics = icsWindow.filter((v) => v.start >= w1End.toJSDate());

    if (w1src.length !== cfg.expectedCounts.week1 || w2src.length !== cfg.expectedCounts.week2) {
      throw new Error(
        `Source window counts differ from expected (src week1=${w1src.length}, week2=${w2src.length})`
      );
    }
    if (w1ics.length !== cfg.expectedCounts.week1 || w2ics.length !== cfg.expectedCounts.week2) {
      throw new Error(
        `ICS window counts differ from expected (ics week1=${w1ics.length}, week2=${w2ics.length})`
      );
    }
  }
}

(async () => {
  const { start, end } = windowBounds();
  const all = await scrape();
  const events = filterWindow(all, start, end);

  if ((events.length || 0) < (cfg.sanity?.minEvents ?? 1)) {
    throw new Error(
      `Sanity check: only ${events.length} events found (min ${cfg.sanity?.minEvents}).`
    );
  }

  const icsEvents = toIcsEvents(events);
  const icsText = await writeICS(icsEvents, cfg.outputPath);
  fs.writeFileSync(cfg.outputJsonPath, JSON.stringify(events, null, 2));

  try {
    validateAgainstSource(events, icsText, start, end);
    console.log(`\n✅ Built and validated ${events.length} events → ${cfg.outputPath}`);
  } catch (err) {
    console.error("❌ Validation failed:", err.message);
    if (cfg.sanity?.protectLastGood && fs.existsSync(cfg.sanity.lastGoodPath)) {
      fs.copyFileSync(cfg.sanity.lastGoodPath, cfg.outputPath);
      console.error("Reinstated last-good ICS.");
    }
    process.exit(1);
  }

  if (cfg.sanity?.protectLastGood) {
    fs.copyFileSync(cfg.outputPath, cfg.sanity.lastGoodPath);
  }
})();
