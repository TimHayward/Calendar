export const config = `export default {
  // Public Involve page (JS-rendered)
  targetUrl: "https://app.involveeducation.com/involve/display/6491925eefde2898c2ee6c76",

  // Date window
  startDate: "",           // "2025-09-01" for fixed window; blank => today
  windowDays: 14,
  timeZone: "Europe/London",

  // Optional: use ONLY when you know the exact weekly counts (e.g., for 2025-09-01..14)
  // Set to null to disable.
  expectedCounts: null,     // { week1: 20, week2: 15 }

  // Output locations (served by GitHub Pages)
  outputPath: "public/school-calendar.ics",
  outputJsonPath: "public/source-events.json",

  // Guardrails
  sanity: {
    minEvents: 1,
    // if true, do not overwrite last-good ICS when validation fails
    protectLastGood: true,
    lastGoodPath: "public/school-calendar.lastgood.ics"
  }
};`
