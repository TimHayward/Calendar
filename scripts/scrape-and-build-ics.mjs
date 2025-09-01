import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { chromium } from "playwright";
import ical from "node-ical";
import { createEvents } from "ics";
import cfg from "./config.mjs";

const log = (...a) => console.log("[involve-ics]", ...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
      ["start","startdate","start_time","starts","starts_at","begins","dtstart","starttime"].includes(k)
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

    const s = e.start || e.starts_at || e.start_date || e.startDate || e.startsAt || e.starts || e.start_time || e.dtstart;
    const en = e.end || e.ends_at || e.end_date || e.endDate || e.endsAt || e.ends || e.end_time || e.dtend;

    let start = typeof s === "number" ? DateTime.fromMillis(s, { zone: "utc" }) : DateTime.fromISO(String(s), { zone: "utc" });
    let end = en ? (typeof en === "number" ? DateTime.fromMillis(en, { zone: "utc" }) : DateTime.fromISO(String(en), { zone: "utc" })) : null;

    if (!start.isValid) continue;
    if (!end) end = start.plus({ hours: 1 });
    if (end <= start) end = start.plus({ minutes: 30 });

    out.push({ title, location, description, url, allDay, start: start.setZone(tz), end: end.setZone(tz) });
  }
  return out;
}

async function acceptCookies(page) {
  // Click common cookie/consent buttons if present (non-fatal)
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Allow all")',
    '[aria-label*="accept" i]',
    '[data-testid*="accept" i]'
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click({ timeout: 1000 });
        await sleep(500);
      }
    } catch {}
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
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

async function scrape() {
  // Hardened context to look like a regular UK browser
  const browser = await chromium.launch({
    args: ["--lang=en-GB"],
    headless: true
  });

  const context = await browser.newContext({
    locale: "en-GB",
    timezoneId: cfg.timeZone || "Europe/London",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 900 }
  });

  // Capture JSON across all frames and content-types (json or text/plain)
  const captured = [];
  context.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const url = resp.url();
      if (!/event|cal|sched|activity|occurrence|timeline|calendar|feed|graphql|api/i.test(url)) return;

      if (ct.includes("json") || ct.includes("javascript") || ct.includes("text/plain")) {
        let data = null;
        try {
          data = await resp.json();
        } catch {
          const txt = await resp.text();
          try { data = JSON.parse(txt); } catch { /* ignore */ }
        }
        if (data) captured.push({ url, json: data, ct });
      }
    } catch {}
  });

  const page = await context.newPage();
  page.on("console", msg => {
    if (cfg.debug?.enabled) console.log("[page]", msg.type(), msg.text());
  });

  log("Loading", cfg.targetUrl);
  await page.goto(cfg.targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  await acceptCookies(page);

  // Allow network burst + lazy loads
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await autoScroll(page);
  await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  await sleep(1200);

  let events = [];
  for (const c of captured) {
    if (isLikelyEventsJSON(c.json)) {
      events = normaliseFromJSON(c.json, cfg.timeZone);
      if (events.length) {
        log("Using JSON from", c.url, "→", events.length, "events");
        br
