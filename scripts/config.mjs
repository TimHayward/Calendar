export default {
  targetUrl: "https://app.involveeducation.com/involve/display/6491925eefde2898c2ee6c76",
  startDate: "2025-09-01",     // pin the fortnight start
  windowDays: 14,
  timeZone: "Europe/London",
  expectedCounts: null,        // or { week1: 20, week2: 15 } if you want hard assertions
  outputPath: "public/school-calendar.ics",
  outputJsonPath: "public/source-events.json",
  sanity: { minEvents: 1, protectLastGood: true, lastGoodPath: "public/school-calendar.lastgood.ics" },
  debug: { enabled: true, htmlPath: "public/debug-page.html", screenshotPath: "public/debug-page.png", networkLogPath: "public/debug-network.json" }
};
