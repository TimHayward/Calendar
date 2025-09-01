export const validate = `import fs from 'node:fs';
import ical from 'node-ical';
import cfg from './config.mjs';

const ics = fs.readFileSync(cfg.outputPath, 'utf8');
const parsed = ical.parseICS(ics);
const events = Object.values(parsed).filter(v => v.type === 'VEVENT');
console.log('VEVENT count:', events.length);
for (const e of events.slice(0, 5)) {
  console.log('•', e.summary, e.start.toISOString(), '→', e.end.toISOString());
}
`
