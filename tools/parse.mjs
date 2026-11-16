import { DOMParser } from '@xmldom/xmldom';
import { readFileSync, writeFileSync } from 'fs';
import { parseAlsFile } from '../als.js';
const r = await parseAlsFile(readFileSync(process.argv[2]), DOMParser);
writeFileSync('/tmp/parsed.json', JSON.stringify(r));
console.log(r.warnings, r.elements);
for (const s of r.songs) console.log(s.slug, s.name, s.duration_seconds, s.bpm, s.song_key, s.lyrics.tracks.map(t=>t.label+':'+t.lines.length).join(' '), s.lyrics.sections.length, JSON.stringify(s.lyrics.tempo), JSON.stringify(s.lyrics.keys));
