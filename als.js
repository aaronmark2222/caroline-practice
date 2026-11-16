// als.js — reads an Ableton Live set (.als, gzip XML) into what Caroline Practice needs:
// songs from locators (no Song IDs), AbleSet +LYRICS tracks, SECTIONS, tempo and the
// exportable audio tracks (children of STEMS / CPC / PARTS / any group except ABLESET).
// Works in the browser (DOMParser) and in Node (pass @xmldom/xmldom's DOMParser).

export const LIVE_PALETTE = [
  'FF94A6', 'FFA529', 'CC9927', 'F7F47C', 'BFFB00', '1AFF2F', '25FFA8', '5CFFE8', '8BC5FF', '5480E4', '92A7FF', 'D86CE4', 'E553A0', 'FFFFFF',
  'FF3636', 'F66C03', '99724B', 'FFF034', '87FF67', '3DC300', '00BFAF', '19E9FF', '10A4EE', '007DC0', '886CE4', 'B677C6', 'FF39D4', 'D0D0D0',
  'E2675A', 'FFA374', 'D3AD71', 'EDFFAE', 'D2E498', 'BAD074', '9BC48D', 'D4FDE1', 'CDF1F8', 'B9C1E3', 'CDBBE4', 'AE98E5', 'E5DCE1', 'A9A9A9',
  'C6928B', 'B78256', '99836A', 'BFBA69', 'A6BE00', '7DB04D', '88C2BA', '9BB3C4', '85A5C2', '8393CC', 'A595B5', 'BF9FBE', 'BC7196', '7B7B7B',
  'AF3333', 'A95131', '724F41', 'DBC300', '85961F', '539F31', '0A9C8E', '236384', '1A2F96', '2F52A2', '624BAD', 'A34BAD', 'CC2E6E', '3C3C3C',
];
export const hexColor = (i) => { const v = LIVE_PALETTE[Number(i)]; return v ? '#' + v : null; };
export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
export const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());

const kids = (el, tag) => {
  const out = [];
  if (!el) return out;
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (!tag || n.nodeName === tag)) out.push(n);
  return out;
};
const kid = (el, tag) => kids(el, tag)[0] || null;
const path = (el, p) => p.split('/').reduce((e, t) => kid(e, t), el);
const val = (el, p, d = null) => { const e = path(el, p); return e ? e.getAttribute('Value') : d; };
const num = (x) => Math.abs(x - Math.round(x)) < 1e-3 ? Math.round(x) : Math.round(x * 100) / 100;

/** gunzip an .als (ArrayBuffer/Uint8Array) to XML text; uses DecompressionStream (browser and Node 18+). */
export async function gunzipText(buf) {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).text();
}

function readTracks(liveSet) {
  const tracks = [];
  for (const t of kids(kid(liveSet, 'Tracks'))) {
    const clips = [];
    const seq = path(t, 'DeviceChain/MainSequencer');
    if (seq) {
      for (const arr of Array.from(seq.getElementsByTagName('ArrangerAutomation'))) {
        for (const c of kids(kid(arr, 'Events'))) {
          if (c.nodeName !== 'MidiClip' && c.nodeName !== 'AudioClip') continue;
          const s = val(c, 'CurrentStart'), e = val(c, 'CurrentEnd');
          if (s == null || e == null) continue;
          clips.push({ start: +s, end: +e, name: val(c, 'Name', '') || '', disabled: val(c, 'Disabled', 'false') === 'true', color: val(c, 'Color') });
        }
      }
    }
    clips.sort((a, b) => a.start - b.start || a.end - b.end);
    tracks.push({ id: t.getAttribute('Id'), kind: t.nodeName, name: (val(t, 'Name/EffectiveName', '') || '').trim(), group: val(t, 'TrackGroupId', '-1'), color: val(t, 'Color'), clips });
  }
  return tracks;
}

function envelope(main, param) {
  const target = path(main, `DeviceChain/Mixer/${param}/AutomationTarget`);
  const manual = val(main, `DeviceChain/Mixer/${param}/Manual`);
  const id = target && target.getAttribute('Id');
  for (const env of Array.from(main.getElementsByTagName('AutomationEnvelope'))) {
    if (val(env, 'EnvelopeTarget/PointeeId') !== id) continue;
    const ev = kids(path(env, 'Automation/Events')).filter((e) => e.getAttribute('Time') != null)
      .map((e) => [+e.getAttribute('Time'), +e.getAttribute('Value')]);
    if (ev.length) return ev.sort((a, b) => a[0] - b[0]);
  }
  return manual != null ? [[-63072000, +manual]] : [];
}

class Timeline {
  constructor(tempo, sig) { this.tempo = tempo.length ? tempo : [[-63072000, 120]]; this.sig = sig.length ? sig : [[-63072000, 201]]; }
  bpmAt(t) {
    const ev = this.tempo; let last = -1;
    for (let i = 0; i < ev.length; i++) { if (ev[i][0] <= t + 1e-9) last = i; else break; }
    if (last < 0) return ev[0][1];
    const [t0, v0] = ev[last];
    if (last + 1 < ev.length && t0 < t) { const [t1, v1] = ev[last + 1]; if (t1 > t0) return v0 + (v1 - v0) * (t - t0) / (t1 - t0); }
    return v0;
  }
  seconds(a, b) {
    const cuts = [...new Set([a, b, ...this.tempo.map((e) => e[0]).filter((t) => a < t && t < b)])].sort((x, y) => x - y);
    let total = 0;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const x0 = cuts[i], x1 = cuts[i + 1];
      const v0 = this.bpmAt(x0 + 1e-7), v1 = x1 - x0 > 2e-7 ? this.bpmAt(x1 - 1e-7) : v0;
      total += Math.abs(v1 - v0) < 1e-6 ? 60 * (x1 - x0) / v0 : 60 * (x1 - x0) / (v1 - v0) * Math.log(v1 / v0);
    }
    return total;
  }
  sigAt(t) {
    let code = 201;
    for (const [t0, v] of this.sig) { if (t0 <= t + 1e-6) code = v; else break; }
    code = Math.round(code);
    return [code % 99 + 1, 2 ** Math.floor(code / 99)];
  }
}

export function keyFrom(name) {
  const m = /\[Key:\]\s*\[([A-G])([#b]?)(m?)\]/.exec(name || '');
  return m ? m[1] + m[2] + m[3] : null;
}

/** Parse XML text of a Live set. */
export function parseAlsXml(xml, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(xml, 'text/xml');
  const liveSet = kid(doc.documentElement, 'LiveSet');
  if (!liveSet) throw new Error('This does not look like an Ableton Live set.');
  const tracks = readTracks(liveSet);
  const main = kid(liveSet, 'MainTrack') || kid(liveSet, 'MasterTrack');
  const tl = new Timeline(main ? envelope(main, 'Tempo') : [], main ? envelope(main, 'TimeSignature') : []);
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const topGroup = (t) => { let g = t; while (g && g.group !== '-1' && byId.get(g.group)) g = byId.get(g.group); return g; };
  const parentName = (t) => (byId.get(t.group)?.name || '').toUpperCase();
  const warnings = [];

  // ---- songs from locators
  const locators = kids(path(liveSet, 'Locators/Locators'), 'Locator')
    .map((l) => ({ t: +val(l, 'Time', 0), name: (val(l, 'Name', '') || '').trim() }))
    .sort((a, b) => a.t - b.t);
  const lastClipEnd = Math.max(0, ...tracks.flatMap((t) => t.clips.filter((c) => !c.disabled).map((c) => c.end)));
  const isEnd = (n) => /^(song\s*)?end$/i.test(n) || /^end\b/i.test(n);
  const songs = [];
  locators.forEach((l, i) => {
    if (isEnd(l.name) || !l.name) return;
    const next = locators.slice(i + 1).find((x) => x.t > l.t + 1e-6);
    const end = next ? next.t : lastClipEnd;
    if (end <= l.t) { warnings.push(`Locator "${l.name}" has nothing after it; ignored.`); return; }
    if (!next) warnings.push(`"${l.name}" is the last locator; its end was taken from the last clip. Add a "SONG END" locator to be exact.`);
    songs.push({ name: l.name, start: l.t, end });
  });
  const seen = new Set();
  for (const s of songs) {
    let slug = slugify(s.name) || 'song';
    while (seen.has(slug)) slug += '-2';
    seen.add(slug); s.slug = slug;
  }

  // ---- lyrics tracks (+LYRICS) and sections
  const lyricTracks = tracks.filter((t) => /\+LYRICS/i.test(t.name)).map((t) => {
    const label = titleCase(t.name.split(/\s+\+/)[0].trim());
    return { slug: slugify(label), label, color: hexColor(t.color), clips: t.clips };
  });
  const sectionTrack = tracks.find((t) => /^SECTIONS\b/i.test(t.name));
  if (!sectionTrack) warnings.push('No SECTIONS track found.');
  const chordsTrack = lyricTracks.find((t) => /chord/i.test(t.label)) || lyricTracks[0];

  // ---- exportable audio tracks: children of groups except ABLESET
  const elements = [{ slug: 'mixdown', name: 'Mixdown', label: 'Mixdown', group: '', kind: 'mixdown', color: null }];
  for (const t of tracks) {
    if (t.kind === 'GroupTrack' || t.group === '-1') continue;
    const top = topGroup(t);
    if (!top || /^ABLESET$/i.test(top.name) || /\+LYRICS/i.test(t.name)) continue;
    const g = parentName(t);
    const kind = /STEM/.test(g) ? 'stem' : /CPC|CUE|CLICK/.test(g) ? 'cue' : /PART/.test(g) ? 'part' : 'other';
    const nice = titleCase(t.name);
    elements.push({ slug: slugify(`${g} ${t.name}`), name: t.name, label: kind === 'stem' ? `${nice} (stem)` : nice, group: g.length <= 4 ? g : titleCase(g), kind, color: hexColor(t.color) });
  }

  const inSong = (clips, a, b) => clips.filter((c) => !c.disabled && c.end > a + 1e-6 && c.start < b - 1e-6);
  const out = songs.map((s, position) => {
    const a = s.start, b = s.end;
    const sec = (beat) => beat > a ? Math.round(tl.seconds(a, beat) * 1000) / 1000 : 0;
    const lyrics = { tracks: [], sections: [], tempo: [], keys: [], sig: tl.sigAt(a) };
    if (sectionTrack) for (const c of inSong(sectionTrack.clips, a, b)) lyrics.sections.push({ t: sec(Math.max(a, c.start)), name: c.name, c: hexColor(c.color) });
    for (const lt of lyricTracks) {
      const lines = [];
      for (const c of inSong(lt.clips, a, b)) {
        if (!c.name.trim()) continue;
        lines.push({ t: sec(Math.max(a, c.start)), e: sec(Math.min(b, c.end)), text: c.name, c: hexColor(c.color) });
      }
      if (lines.length) lyrics.tracks.push({ slug: lt.slug, label: lt.label, color: lt.color, lines });
    }
    if (chordsTrack) for (const c of inSong(chordsTrack.clips, a, b)) {
      const k = keyFrom(c.name);
      if (k && (!lyrics.keys.length || lyrics.keys[lyrics.keys.length - 1].key !== k)) lyrics.keys.push({ t: sec(Math.max(a, c.start)), key: k });
    }
    // tempo points in seconds from the song start (breakpoints; ramps sampled per beat)
    const pts = [[0, tl.bpmAt(a + 1e-7)]];
    for (const [t, v] of tl.tempo) if (a < t && t < b) pts.push([sec(t), v]);
    for (let beat = Math.floor(a) + 1; beat < b; beat += 1) {
      const v = tl.bpmAt(beat + 1e-7);
      if (Math.abs(v - pts[pts.length - 1][1]) > 0.05) pts.push([sec(beat), v]);
    }
    pts.sort((x, y) => x[0] - y[0]);
    // drop instant-jump duplicates: keep the last value at a given time
    const tempo = [];
    for (const p of pts) { if (tempo.length && Math.abs(tempo[tempo.length - 1][0] - p[0]) < 1e-3) tempo[tempo.length - 1] = p; else tempo.push(p); }
    lyrics.tempo = tempo.map(([t, v]) => [Math.round(t * 100) / 100, Math.round(v * 100) / 100]);
    return {
      slug: s.slug, name: titleCase(s.name), position, start_beat: a, end_beat: b,
      duration_seconds: Math.round(tl.seconds(a, b) * 1000) / 1000,
      bpm: num(tl.bpmAt(a + 1e-7)), song_key: lyrics.keys[0]?.key || null, lyrics,
    };
  });
  if (!out.length) warnings.push('No song locators found. Put a locator at the start of each song (and one called "SONG END" after the last).');
  return { songs: out, elements, warnings };
}

export async function parseAlsFile(buf, DOMParserImpl) {
  return parseAlsXml(await gunzipText(buf), DOMParserImpl);
}
