import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import ical from "node-ical";
import { createEvents } from "ics";
import cfg from "./config.mjs";

const log = (...a) => console.log("[involve-ics]", ...a);

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
    const keys = Object.keys(obj[0]).map(k => k.toLowerCase());
    return keys.some(k =>
      ["start", "startdate", "start_time", "starts", "starts_at", "begins"].includes(k)
    );
  }
  if (obj.events && Array.isArray(obj.events)) return true;
  if (obj.data && Array.isArray(obj.data)) return true;
  return false;
}

function normaliseFromJSON(raw, tz) {
  const arr = Array.isArray(raw.events)
    ? raw.events
    : Array.isArray(raw.data)
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

    const s = e.start || e.starts_at || e.start_date || e.startDate || e.startsAt || e.starts || e.start_time;
    const en = e.end || e.ends_at || e.end_date || e.endDate || e.endsAt || e.ends || e.end_time;

    let start = typeof s === "number" ? DateTime.fromMillis(s, { zone: "utc" }) : DateTime.fromISO(String(s), { zone: "utc" });
    let end = en ? (typeof en === "number" ? DateTime.fromMillis(en, { zone: "utc" }) : DateTime.fromISO(String(en), { zone: "utc" })) : null;

    if (!start.isValid) continue;
    if (!end) end = start.plus({ hours: 1 });
    if (end <= start) end = start.plus({ minutes: 30 });

    out.push({ title, location, description, url, allDay, start: start.setZone(tz), end: end.setZone(tz) });
  }
  return out;
}

async function scrape() {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const captured = [];
  page.on("response", async resp => {
    try {
      const ct = resp.headers()["content-type"] || "";
      if (!ct.includes("application/json")) return;
      const url = resp.url();
      if (!/event|cal|sched|activity|occurrence|timeline|calendar|feed/i.test(url)) return;
      const json = await resp.json();
      captured.push({ url, json });
    } catch {
      /* ignore */
    }
  });

  log("Loading", cfg.targetUrl);
  await page.goto(cfg.targetUrl, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);

  let events = [];
  for (const c of captured) {
    if (isLikelyEventsJSON(c.json)) {
      events = normaliseFromJSON(c.json, cfg.timeZone);
      if (events.length) {
        log("Using JSON from", c.url, "→", events.length, "events");
        break;
      }
    }
  }

  if (!events.length) {
    // DOM fallback — heuristic selectors; adjust as needed for the site’s markup
    const dom = await page.evaluate(() => {
      const items = [];
      const candidates = document.querySelectorAll(
        '[data-event], [class*="event" i], [class*="calendar" i], article, li'
      );
      candidates.forEach(el => {
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
    const parseWhen = (_title, whenText) => {
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
        if (d.isValid) return { start: d.startOf("day"), end: d.plus({ days: 1 }).startOf("day"), allDay: true };
      }
      return null;
    };

    events = dom
      .map(e => {
        const parsed = parseWhen(e.title, e.when || e.rawText);
        if (!parsed) return null;
        return {
          title: e.title,
          location: e.where || "",
          description: "",
          url: e.href || null,
          allDay: parsed.allDay,
          start: parsed.start,
          end: parsed.end
        };
      })
      .filter(Boolean);

    log("DOM extraction produced", events.length, "events");
  }

  await browser.close();
  return events;
}

function filterWindow(all, start, end) {
  return all.filter(e => e.start < end && e.end > start);
}

function toIcsEvents(evts) {
  // The `ics` lib wants [yyyy, m, d] or [yyyy, m, d, hh, mm] in UTC
  return evts.map(e => {
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
      return {
        ...base,
        startInputType: "utc",
        endInputType: "utc",
        start: [s.year, s.month, s.day],
        end: [en.year, en.month, en.day] // exclusive end for all-day
      };
    } else {
      return {
        ...base,
        startInputType: "utc",
        endInputType: "utc",
        start: [s.year, s.month, s.day, s.hour, s.minute],
        end: [en.year, en.month, en.day, en.hour, en.minute]
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
  // Parse ICS back and compare counts & window compliance
  const parsed = ical.parseICS(icsText);
  const icsEvents = Object.values(parsed).filter(v => v.type === "VEVENT");

  const within = d => d >= start.toJSDate() && d <= end.toJSDate();

  const srcWindow = events.filter(e => e.start < end && e.end > start);
  const icsWindow = icsEvents.filter(v => within(v.start));

  if (icsWindow.length !== srcWindow.length) {
    throw new Error(`Validation failed: ICS count ${icsWindow.length} != source count ${srcWindow.length}`);
  }

  if (cfg.expectedCounts) {
    const w1End = start.plus({ days: 7 });
    const w1src = srcWindow.filter(e => e.start < w1End);
    const w2src = srcWindow.filter(e => e.start >= w1End);

    const w1ics = icsWindow.filter(v => v.start < w1End.toJSDate());
    const w2ics = icsWindow.filter(v => v.start >= w1End.toJSDate());

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
    throw new Error(`Sanity check: only ${events.length} events found (min ${cfg.sanity?.minEvents}).`);
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

  // Update last-good
  if (cfg.sanity?.protectLastGood) {
    fs.copyFileSync(cfg.outputPath, cfg.sanity.lastGoodPath);
  }
})();
