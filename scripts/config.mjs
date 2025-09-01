export default {
  // Your public Involve display URL
  targetUrl: "https://app.involveeducation.com/involve/display/6491925eefde2898c2ee6c76",

  // Date window
  startDate: "",          // e.g. "2025-09-01" for a fixed window; "" = today (local to Europe/London)
  windowDays: 14,
  timeZone: "Europe/London",

  // Optional exact split checks for a known fortnight (disable by leaving null)
  // expectedCounts: { week1: 20, week2: 15 },
  expectedCounts: null,

  // Output (published by GitHub Pages)
  outputPath: "public/school-calendar.ics",
  outputJsonPath: "public/source-events.json",

  // Guardrails
  sanity: {
    minEvents: 1,                 // fail build if fewer than this
    protectLastGood: true,        // don't overwrite if validation fails
    lastGoodPath: "public/school-calendar.lastgood.ics"
  }
};
