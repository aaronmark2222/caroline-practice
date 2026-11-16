// Caroline Practice — a small practice player cloned from the TSP Work app.
// Sign in, pick a song, play the Mixdown or a multitrack (on/solo/volume per track)
// with AbleSet-style lyrics in time, and practise together in a "room" where one device
// plays and the others follow. The admin (Aaron) has an Ableton Sync page that reads the
// .als (songs from locators, +LYRICS tracks, SECTIONS) and uploads the exported audio to R2.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.52.0';
import { parseAlsFile } from './als.js?v=20261116-1';

const SUPABASE_URL = 'https://hzvfrvjuqvmkeqbrgmqu.supabase.co';
const SUPABASE_KEY = 'sb_publishable_bXd0ymwEnYNqQCq1EwH2AA_0HajJecU';
// Own storage key: this app shares an origin (aaronmark2222.github.io) with TSP Work,
// so its sign-in must not overwrite or be overwritten by the band app's.
const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: 'cp-auth-v1', persistSession: true, autoRefreshToken: true } });
const USERNAME_DOMAIN = 'example.com';
const PHONE = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const mb = (b) => `${(b / 1048576).toFixed(b > 10485760 ? 0 : 1)} MB`;
const sget = (k, d) => { try { const v = sessionStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const sset = (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const lget = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

const state = {
  user: null, member: null, songs: [], elements: [], audio: {}, setMeta: {},
  song: null, view: 'practice',
};

// ------------------------------------------------------------------ auth
async function boot() {
  wireStatic();
  let data = {}, error = null;
  try { ({ data, error } = await db.auth.getSession()); } catch (e) { error = e; }
  if (data?.session) await enter(data.session.user);
  else {
    // Offline with an expired sign-in: open from what this device saved (read-only practice).
    const cached = dataCacheGet();
    if ((!navigator.onLine || error) && cached?.member) await enter({ id: cached.member.user_id });
    else showSignin();
  }
  db.auth.onAuthStateChange((ev, session) => {
    if (ev === 'SIGNED_OUT') showSignin();
    else if (session?.user && !state.user) enter(session.user);
  });
}

function showSignin(msg = '') {
  state.user = null; state.member = null;
  $('#boot').hidden = true; $('#app').hidden = true; $('#signin').hidden = false;
  $('#si-msg').textContent = msg;
}

async function signIn(e) {
  e.preventDefault();
  const u = $('#si-user').value.trim(), p = $('#si-pass').value;
  const email = u.includes('@') ? u : `${u.toLowerCase()}@${USERNAME_DOMAIN}`;
  $('#si-msg').textContent = 'Signing in…';
  const { data, error } = await db.auth.signInWithPassword({ email, password: p });
  if (error) { $('#si-msg').textContent = /invalid/i.test(error.message) ? 'That username or password is not right.' : error.message; return; }
  $('#si-pass').value = '';
  await enter(data.user);
}

async function enter(user) {
  if (state.user?.id === user.id) return;
  state.user = user;
  let { data: member, error } = await db.from('cp_users').select('user_id,name,role').eq('user_id', user.id).maybeSingle();
  // No connection: open from what this device saved last time (read-only practice).
  const cached = dataCacheGet();
  if (error && cached?.member?.user_id === user.id) { member = cached.member; error = null; state.offline = true; }
  if (error || !member) {
    await db.auth.signOut();
    showSignin(error ? 'Could not reach the server. Check the connection and try again.' : 'This account is not set up for Caroline Practice.');
    return;
  }
  state.member = member;
  $('#acct-name').textContent = member.name;
  $$('.admin-only').forEach((b) => { b.hidden = member.role !== 'admin'; });
  $('#signin').hidden = true; $('#boot').hidden = true; $('#app').hidden = false;
  dataCachePut({ member });
  await loadData();
  renderOfflineBanner();
  setView(member.role === 'admin' && lget('cp-view', 'practice') === 'sync' ? 'sync' : 'practice');
  const last = lget('cp-song', null);
  const first = state.songs.find((s) => s.slug === last) || state.songs[0];
  if (first) selectSong(first.slug, { quiet: true });
  roomRejoin();
}

async function signOut() {
  await roomLeave();
  enginePause();
  await db.auth.signOut();
  location.reload();
}

// ------------------------------------------------------------------ data
// Last loaded data is kept on the device so the app opens with no connection.
const DATA_CACHE = 'cp-data-cache-v1';
function dataCacheGet() { return lget(DATA_CACHE, null); }
function dataCachePut(patch) { lset(DATA_CACHE, { ...(dataCacheGet() || {}), ...patch, savedAt: new Date().toISOString() }); }

async function loadData() {
  let songs, meta;
  try {
    [songs, meta] = await Promise.all([
      db.from('cp_songs').select('*').eq('hidden', false).order('position'),
      db.from('cp_meta').select('key,value'),
    ]);
    if (songs.error || meta.error) throw songs.error || meta.error;
    state.songs = songs.data || [];
    state.setMeta = (meta.data || []).find((m) => m.key === 'set')?.value || {};
    state.offline = false;
    dataCachePut({ songs: state.songs, setMeta: state.setMeta });
  } catch (e) {
    const c = dataCacheGet() || {};
    state.songs = c.songs || []; state.setMeta = c.setMeta || {}; state.offline = true;
    console.warn('offline: using saved data', e);
  }
  state.elements = state.setMeta.elements || [];
  await refreshAudioList();
  renderSongChips();
}

async function fn(body) {
  const { data, error } = await db.functions.invoke('caroline-audio', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (!data?.ok) throw new Error(data?.error || 'request failed');
  return data;
}

async function refreshAudioList() {
  try { state.audio = (await fn({ action: 'list' })).songs || {}; state.audioLive = true; dataCachePut({ audio: state.audio }); }
  catch (e) { state.audio = dataCacheGet()?.audio || {}; state.audioLive = false; console.warn('audio list', e); }
  renderOfflinePanel();
}

const elementBySlug = (slug) => state.elements.find((e) => e.slug === slug)
  || { slug, name: slug, label: slug.replace(/-/g, ' '), kind: 'other', color: null };

// ------------------------------------------------------------------ views
function setView(v) {
  if (v === 'sync' && state.member?.role !== 'admin') v = 'practice';
  state.view = v; lset('cp-view', v);
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  $('#view-practice').hidden = v !== 'practice';
  $('#view-sync').hidden = v !== 'sync';
  document.body.classList.toggle('view-sync', v === 'sync');
  if (v === 'sync') renderSync();
}

function renderSongChips() {
  $('#song-chips').innerHTML = state.songs.map((s) => {
    const n = Object.keys(state.audio[s.slug] || {}).length || Object.keys(offline.manifest[s.slug] || {}).length;
    return `<button class="song-chip ${state.song?.slug === s.slug ? 'active' : ''}" data-song="${esc(s.slug)}"><b>${esc(s.name)}</b><span>${fmt(s.duration_seconds)}${s.song_key ? ' · ' + esc(s.song_key) : ''}${s.bpm ? ' · ' + esc(s.bpm) + ' BPM' : ''}${n ? '' : ' · no audio yet'}</span></button>`;
  }).join('') || '<span class="muted">No songs yet.</span>';
}

// ------------------------------------------------------------------ offline audio
// Same idea as TSP Work: every file played is saved on this device (always on),
// so it downloads once; "Save all" fills the device in one go; a newer upload
// shows an Update; with no connection the saved copies play. Files live in Cache
// Storage, with a manifest (version = bytes|upload time) in localStorage.
const OFFLINE_CACHE = 'cp-practice-audio-v1';
const OFFLINE_MANIFEST = 'cp-offline-manifest-v1';
const offline = { manifest: lget(OFFLINE_MANIFEST, {}), job: null, lastError: '', urls: new Map() };
const offlineSupported = () => typeof caches !== 'undefined';
const offlineVersion = (f) => `${f?.bytes || 0}|${f?.modified || ''}`;
const offlineKey = (song, el) => `https://cp-offline.local/${encodeURIComponent(song)}/${encodeURIComponent(el)}`;
function offlineSaveManifest() { lset(OFFLINE_MANIFEST, offline.manifest); }
try { navigator.storage?.persist?.(); } catch { /* ignore */ }
try { caches.delete('cp-audio-v1'); } catch { /* the old cache name */ }

// Songs opened in this visit stay in memory (compressed), so going back never downloads again.
const memBlobs = new Map();
const MEM_BUDGET = (PHONE ? 200 : 600) * 1048576;
function memGet(song, el, v) { const k = `${song}|${el}|${v}`; const b = memBlobs.get(k); if (b) { memBlobs.delete(k); memBlobs.set(k, b); } return b || null; }
function memPut(song, el, v, blob) {
  for (const k of [...memBlobs.keys()]) if (k.startsWith(`${song}|${el}|`)) memBlobs.delete(k);
  memBlobs.set(`${song}|${el}|${v}`, blob);
  let total = 0; for (const b of memBlobs.values()) total += b.size;
  for (const [k, b] of memBlobs) { if (total <= MEM_BUDGET) break; if (k.startsWith(`${song}|`)) continue; memBlobs.delete(k); total -= b.size; }
}
async function offlineRead(song, el) {
  if (!offlineSupported() || !offline.manifest[song]?.[el]) return null;
  try { const res = await (await caches.open(OFFLINE_CACHE)).match(offlineKey(song, el)); return res ? await res.blob() : null; } catch { return null; }
}
async function offlineWrite(song, el, file, blob) {
  if (!offlineSupported()) return;
  const ext = file.ext || 'm4a';
  await (await caches.open(OFFLINE_CACHE)).put(offlineKey(song, el), new Response(blob, { headers: { 'Content-Type': ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/mp4' } }));
  (offline.manifest[song] ||= {})[el] = { v: offlineVersion(file), bytes: blob.size, ext, modified: file.modified || '' };
  offlineSaveManifest();
}
// A saved copy that is the current upload (or any saved copy when offline / no link).
function offlineIsCurrent(song, el, file) {
  const m = offline.manifest[song]?.[el];
  return !!m && (!file?.url || file.offline || m.v === offlineVersion(file));
}
async function offlineTrackBlob(song, el, file, onProgress) {
  const v = offlineVersion(file);
  const inMem = memGet(song, el, v); if (inMem) return inMem;
  if (offlineIsCurrent(song, el, file)) { const b = await offlineRead(song, el); if (b) { memPut(song, el, v, b); return b; } }
  if (!file?.url) throw new Error('not saved on this device, and no connection');
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || file.bytes || 0;
  let blob;
  if (res.body && onProgress && total) {
    const reader = res.body.getReader(); const parts = []; let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(got / total); }
    blob = new Blob(parts, { type: res.headers.get('content-type') || 'audio/mp4' });
  } else blob = await res.blob();
  memPut(song, el, v, blob);
  try { await offlineWrite(song, el, file, blob); offline.lastError = ''; }
  catch (e) { offline.lastError = `${e?.name || 'Error'}: ${e?.message || e}`; console.warn('not saved on device', e); }
  renderOfflinePanel();
  return blob;
}
function offlineStats() {
  let files = 0, bytes = 0, mixdowns = 0, multitracks = 0;
  for (const [song, saved] of Object.entries(offline.manifest)) {
    for (const m of Object.values(saved)) { files += 1; bytes += m.bytes || 0; }
    if (saved.mixdown) mixdowns += 1;
    const parts = Object.keys(state.audio[song] || {}).filter((el) => el !== 'mixdown');
    const savedParts = Object.keys(saved).filter((el) => el !== 'mixdown');
    if (parts.length ? parts.every((el) => saved[el]) : savedParts.length) multitracks += 1;
  }
  return { files, bytes, mixdowns, multitracks };
}
// Saved files whose upload is newer.
function offlineUpdates() {
  const out = [];
  if (!state.audioLive) return out;
  for (const [song, saved] of Object.entries(offline.manifest)) {
    for (const [el, m] of Object.entries(saved)) {
      const up = state.audio[song]?.[el];
      if (up && m.v !== offlineVersion(up)) out.push({ song, el, bytes: up.bytes || 0 });
    }
  }
  return out;
}
async function offlineDownload(slugs, { everything, onlyUpdates } = {}) {
  if (offline.job || !offlineSupported()) return;
  const job = { done: 0, total: 0, bytes: 0, totalBytes: 0, failed: 0, current: '', cancelled: false };
  offline.job = job;
  const plan = [];
  for (const song of slugs) {
    for (const [el, f] of Object.entries(state.audio[song] || {})) {
      if (!everything && !onlyUpdates && el !== 'mixdown') continue;
      const saved = offline.manifest[song]?.[el];
      if (saved && saved.v === offlineVersion(f)) continue;
      if (onlyUpdates && !saved) continue;
      plan.push({ song, el, bytes: f.bytes || 0 });
    }
  }
  job.total = plan.length; job.totalBytes = plan.reduce((a, p) => a + p.bytes, 0);
  renderOfflinePanel();
  for (const song of [...new Set(plan.map((p) => p.song))]) {
    if (job.cancelled) break;
    let files;
    try { files = (await fn({ action: 'urls', song })).files || {}; } catch { const n = plan.filter((p) => p.song === song).length; job.failed += n; job.done += n; continue; }
    for (const item of plan.filter((p) => p.song === song)) {
      if (job.cancelled) break;
      const f = files[item.el];
      job.current = `${state.songs.find((x) => x.slug === song)?.name || song} · ${elementBySlug(item.el).label}`;
      renderOfflinePanel();
      try {
        if (!f) throw new Error('missing');
        const res = await fetch(f.url); if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        await offlineWrite(song, item.el, f, blob);
        job.bytes += blob.size;
      } catch (e) { job.failed += 1; console.warn('offline save failed', song, item.el, e); }
      job.done += 1; renderOfflinePanel();
    }
  }
  offline.job = null;
  toast(job.cancelled ? 'Stopped saving audio.' : `Saved ${job.done - job.failed} file${job.done - job.failed === 1 ? '' : 's'} on this device${job.failed ? ` (${job.failed} failed — try again on a better connection)` : ''}.`);
  renderOfflinePanel(); renderSongChips();
}
async function offlineClear() {
  if (!confirm('Delete the practice audio saved on this device? It saves again as songs are played.')) return;
  try { await caches.delete(OFFLINE_CACHE); } catch { /* ignore */ }
  offline.manifest = {}; offlineSaveManifest(); memBlobs.clear();
  renderOfflinePanel(); renderSongChips();
}
function renderOfflinePanel() {
  const box = $('#offline-card'); if (!box) return;
  if (!offlineSupported()) { box.innerHTML = '<h2>Offline audio</h2><p class="muted small">This browser cannot save audio on the device.</p>'; return; }
  const st = offlineStats(), ups = offlineUpdates(), job = offline.job;
  const upBytes = ups.reduce((a, u) => a + u.bytes, 0);
  const all = state.songs.map((x) => x.slug).filter((sl) => state.audio[sl]);
  const totalMix = all.filter((sl) => state.audio[sl]?.mixdown).length;
  const prog = job ? `<div style="margin-top:10px"><div class="bar"><i style="width:${job.totalBytes ? Math.round(job.bytes / job.totalBytes * 100) : Math.round(job.done / Math.max(1, job.total) * 100)}%"></i></div>
    <p class="small">Saving ${job.done} of ${job.total}${job.current ? ` · ${esc(job.current)}` : ''} · ${mb(job.bytes)} of ${mb(job.totalBytes)} <button class="btn small" id="off-stop">Stop</button></p></div>` : '';
  box.innerHTML = `<div class="row"><h2 style="margin:0">Offline audio</h2><span class="ok small">● On</span><span class="spacer"></span><span class="muted small">${state.offline || !navigator.onLine ? 'No connection — playing saved audio' : ''}</span></div>
    <p class="muted small">Songs are saved on this device as you play them, so they download once and play with no internet.</p>
    <p class="small">Saved: <b>${st.mixdowns}</b> of ${totalMix} Mixdowns · <b>${st.multitracks}</b> full multitrack${st.multitracks === 1 ? '' : 's'} · ${st.files} files, ${mb(st.bytes)}</p>
    ${ups.length ? `<p class="warnc small">${ups.length} saved file${ups.length === 1 ? ' has' : 's have'} a newer version (${mb(upBytes)}). <button class="btn small" id="off-update" ${job ? 'disabled' : ''}>Update</button></p>` : ''}
    <div class="row">
      <button class="btn small" id="off-mix" ${job || state.offline ? 'disabled' : ''}>Save all Mixdowns</button>
      <button class="btn small" id="off-all" ${job || state.offline ? 'disabled' : ''}>Save everything</button>
      <span class="spacer"></span>
      <button class="btn small ghost" id="off-clear" ${job || !st.files ? 'disabled' : ''}>Delete saved audio</button></div>
    ${prog}${offline.lastError ? `<p class="badc small">Could not save on this device: ${esc(offline.lastError)}</p>` : ''}`;
}
function renderOfflineBanner() {
  const off = state.offline || !navigator.onLine;
  const b = $('#offline-banner'); if (b) b.hidden = !off;
}

// ------------------------------------------------------------------ engine
// One transport, two engines: the Mixdown streams through a single <audio>
// element; the Multitrack decodes each track into Web Audio and plays them in step.
const pt = {
  mode: sget('cp-mode', 'mix'), files: {}, filesFor: null, filesAt: 0,
  audio: new Audio(), ctx: null, master: null, tracks: [], playing: false,
  startAt: 0, offset: 0, mixer: sget('cp-mixer', {}), loadingToken: 0,
};
pt.audio.preload = 'auto';
pt.audio.setAttribute('playsinline', '');

function ensureCtx() {
  if (pt.ctx) return pt.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  try { pt.ctx = PHONE ? new AC({ sampleRate: 24000 }) : new AC(); } catch { pt.ctx = new AC(); }
  pt.master = pt.ctx.createGain(); pt.master.connect(pt.ctx.destination);
  return pt.ctx;
}
const hasMix = () => !!pt.files.mixdown;
const multiTracks = () => pt.tracks;
const engineMode = () => (pt.mode === 'mix' && hasMix()) || !pt.tracks.length ? 'mix' : 'multi';
const songDuration = () => {
  const d = pt.audio.duration;
  if (engineMode() === 'mix' && isFinite(d) && d > 0) return d;
  const bufs = pt.tracks.map((t) => t.buffer?.duration || 0);
  return Math.max(state.song?.duration_seconds || 0, ...bufs, 0);
};

function mixerSetting(slug, kind) {
  if (!pt.mixer[slug]) pt.mixer[slug] = { on: kind !== 'stem', solo: false, vol: 0 };
  return pt.mixer[slug];
}
const anySolo = () => pt.tracks.some((t) => mixerSetting(t.slug, t.kind).solo);
function audible(t) { const m = mixerSetting(t.slug, t.kind); return anySolo() ? m.solo : m.on; }
const dbToGain = (db) => (db <= -60 ? 0 : 10 ** (db / 20));

function applyGains() {
  if (!pt.ctx) return;
  for (const t of pt.tracks) {
    if (!t.gain) continue;
    const g = audible(t) ? dbToGain(mixerSetting(t.slug, t.kind).vol) : 0;
    t.gain.gain.setTargetAtTime(g, pt.ctx.currentTime, 0.015);
  }
  sset('cp-mixer', pt.mixer);
}

function enginePosition() {
  if (room.following) return roomPosition();
  if (engineMode() === 'mix') return pt.audio.currentTime || 0;
  return pt.playing ? pt.offset + (pt.ctx.currentTime - pt.startAt) : pt.offset;
}
const engineIsPlaying = () => (room.following ? room.anchor?.playing : engineMode() === 'mix' ? !pt.audio.paused : pt.playing);

function stopSources() {
  for (const t of pt.tracks) { try { t.src?.stop(); } catch { /* already stopped */ } t.src = null; }
}
function startSource(t, when, offset) {
  if (!t.buffer || offset >= t.buffer.duration) return;
  const src = pt.ctx.createBufferSource(); src.buffer = t.buffer; src.connect(t.gain);
  src.start(when, Math.max(0, offset)); t.src = src;
}

async function enginePlay() {
  if (room.following) return roomCmd('play');
  if (!state.song) return;
  if (engineMode() === 'mix') {
    if (!pt.audio.src) return;
    if (pt.audio.ended || pt.audio.currentTime >= songDuration() - 0.05) pt.audio.currentTime = 0;
    try { await pt.audio.play(); } catch (e) { toast('Tap play again to start audio.'); console.warn(e); }
  } else {
    const ctx = ensureCtx();
    if (ctx.state !== 'running') await ctx.resume();
    if (pt.offset >= songDuration() - 0.05) pt.offset = 0;
    stopSources();
    pt.startAt = ctx.currentTime + 0.06;
    for (const t of pt.tracks) startSource(t, pt.startAt, pt.offset);
    pt.playing = true;
  }
  afterTransport();
}
function enginePause() {
  if (room.following) return roomCmd('pause');
  if (engineMode() === 'mix') pt.audio.pause();
  else if (pt.playing) { pt.offset = enginePosition(); stopSources(); pt.playing = false; }
  afterTransport();
}
function engineSeek(sec) {
  if (room.following) return roomCmd('seek', { t: sec });
  sec = Math.max(0, Math.min(sec, songDuration()));
  if (engineMode() === 'mix') { try { pt.audio.currentTime = sec; } catch { /* not loaded */ } }
  else if (pt.playing) { stopSources(); pt.offset = sec; pt.startAt = pt.ctx.currentTime + 0.03; for (const t of pt.tracks) startSource(t, pt.startAt, sec); }
  else pt.offset = sec;
  lyricsJumpScroll = true;
  afterTransport();
}
function engineStop() {
  if (room.following) return roomCmd('stop');
  enginePause(); engineSeek(0);
}
function afterTransport() { renderTransport(); roomHostSend(true); mediaSessionUpdate(); wakeLockUpdate(); }

async function setMode(mode) {
  if (room.following) return;
  if (mode === 'mix' && !hasMix()) { toast('There is no Mixdown for this song yet.'); return; }
  if (mode === 'multi' && !pt.tracks.length) { toast('There are no separate tracks for this song yet.'); return; }
  const was = engineIsPlaying(), pos = enginePosition();
  if (was) enginePause();
  pt.mode = mode; sset('cp-mode', mode);
  if (mode === 'multi') { pt.offset = pos; loadAudibleTracks(); }
  else { try { pt.audio.currentTime = pos; } catch { /* later */ } }
  renderTransport(); renderMixer();
  if (was) {
    if (mode === 'multi') await waitTracksReady();
    enginePlay();
  }
}

async function getFiles(slug) {
  if (pt.filesFor === slug && Date.now() - pt.filesAt < 2.5 * 3600e3) return pt.files;
  let files;
  try { files = (await fn({ action: 'urls', song: slug })).files || {}; pt.filesAt = Date.now(); }
  catch (e) {
    // No connection: what this device has saved for the song.
    const saved = offline.manifest[slug] || {};
    if (!Object.keys(saved).length) throw e;
    files = Object.fromEntries(Object.entries(saved).map(([el, m]) => [el, { url: null, offline: true, bytes: m.bytes, modified: m.modified, ext: m.ext }]));
    pt.filesAt = 0;
  }
  pt.files = files; pt.filesFor = slug;
  return pt.files;
}
// Mixdown: the saved copy when there is a current one (plays offline); otherwise it
// streams straight away and a copy is saved in the background for next time.
async function setMixdownSource(slug, file) {
  const token = pt.loadingToken;
  if (offlineIsCurrent(slug, 'mixdown', file)) {
    const blob = memGet(slug, 'mixdown', offlineVersion(file)) || await offlineRead(slug, 'mixdown');
    if (token !== pt.loadingToken) return;
    if (blob) {
      const old = offline.urls.get('mix'); if (old) URL.revokeObjectURL(old);
      const url = URL.createObjectURL(blob); offline.urls.set('mix', url);
      pt.audio.src = url; return;
    }
  }
  if (!file.url) { $('#practice-note').textContent = 'The Mixdown is not saved on this device and there is no connection.'; return; }
  pt.audio.src = file.url;
  offlineTrackBlob(slug, 'mixdown', file).catch(() => {});
}

// Decode a track (first time it is needed) and attach it to a playing mix.
async function ensureTrack(t) {
  if (t.buffer || t.loading || t.failed || t.silent) return t.loading;
  const token = pt.loadingToken;
  t.loading = (async () => {
    try {
      const ctx = ensureCtx();
      const buf = await (await offlineTrackBlob(state.song.slug, t.slug, pt.files[t.slug], (p) => { t.progress = p; renderMixerRow(t); })).arrayBuffer();
      if (token !== pt.loadingToken) return;
      let audioBuf = await ctx.decodeAudioData(buf);
      audioBuf = collapseDualMono(ctx, audioBuf);
      if (token !== pt.loadingToken) return;
      t.buffer = audioBuf;
      t.gain = ctx.createGain(); t.gain.gain.value = 0;
      t.analyser = ctx.createAnalyser(); t.analyser.fftSize = 512;
      t.gain.connect(t.analyser); t.analyser.connect(pt.master);
      applyGains();
      if (pt.playing && engineMode() === 'multi') startSource(t, ctx.currentTime + 0.02, enginePosition() + 0.02);
    } catch (e) { console.warn('track', t.slug, e); t.failed = String(e.message || e); }
    finally { t.loading = null; renderMixerRow(t); renderTransport(); }
  })();
  renderMixerRow(t);
  return t.loading;
}
function collapseDualMono(ctx, b) {
  if (b.numberOfChannels !== 2) return b;
  const l = b.getChannelData(0), r = b.getChannelData(1);
  const step = Math.max(1, Math.floor(l.length / 20000));
  for (let i = 0; i < l.length; i += step) if (Math.abs(l[i] - r[i]) > 1e-4) return b;
  const m = ctx.createBuffer(1, b.length, b.sampleRate); m.copyToChannel(l, 0);
  return m;
}
function loadAudibleTracks() {
  const want = pt.tracks.filter(audible);
  let i = 0; const next = () => { const t = want[i++]; if (t) ensureTrack(t).then(next); };
  next(); next(); next();
}
async function waitTracksReady() {
  const want = pt.tracks.filter(audible);
  await Promise.all(want.map((t) => ensureTrack(t)));
}

async function selectSong(slug, opts = {}) {
  const song = state.songs.find((s) => s.slug === slug);
  if (!song) return;
  const wasPlaying = !room.following && engineIsPlaying() && !opts.quiet;
  if (!room.following && state.song) enginePause();
  state.song = song; lset('cp-song', slug);
  pt.loadingToken += 1;
  stopSources(); pt.playing = false; pt.offset = 0;
  for (const t of pt.tracks) { try { t.gain?.disconnect(); t.analyser?.disconnect(); } catch { /* gone */ } }
  pt.tracks = []; pt.files = {}; pt.filesFor = null;
  pt.audio.pause(); pt.audio.removeAttribute('src'); pt.audio.load();
  renderSongChips(); renderLyrics(); renderTransport(); renderMixer();
  $('#practice-note').textContent = '';
  if (!opts.fromRoom) roomHostSend(true);
  if (room.following) { renderTransport(); return; }   // followers hold no audio
  let files;
  try { files = await getFiles(slug); } catch (e) { $('#practice-note').textContent = state.offline || !navigator.onLine ? 'No connection, and this song is not saved on this device yet.' : `Could not load audio: ${e.message}`; return; }
  if (state.song?.slug !== slug) return;
  const order = state.elements.map((e) => e.slug);
  pt.tracks = Object.keys(files).filter((k) => k !== 'mixdown')
    .sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999))
    .map((k) => { const e = elementBySlug(k); return { slug: k, label: e.label, color: e.color, kind: e.kind, bytes: files[k].bytes }; });
  if (files.mixdown) setMixdownSource(slug, files.mixdown);
  if (!files.mixdown && !pt.tracks.length) $('#practice-note').textContent = 'No practice audio for this song yet — lyrics only.';
  if (pt.mode === 'multi' || !files.mixdown) loadAudibleTracks();
  renderTransport(); renderMixer(); mediaSessionUpdate();
  if (wasPlaying) { if (engineMode() === 'multi') await waitTracksReady(); enginePlay(); }
}
function stepSong(d) {
  if (room.following) return roomCmd('song', { slug: neighbour(d) });
  const s = neighbour(d); if (s) selectSong(s);
}
function neighbour(d) {
  const i = state.songs.findIndex((s) => s.slug === state.song?.slug);
  return state.songs[(i + d + state.songs.length) % state.songs.length]?.slug;
}

pt.audio.addEventListener('ended', () => { renderTransport(); roomHostSend(true); });
pt.audio.addEventListener('play', () => afterTransport());
pt.audio.addEventListener('pause', () => afterTransport());
pt.audio.addEventListener('loadedmetadata', () => renderTransport());

// ------------------------------------------------------------------ transport UI
let seeking = false;
function renderTransport() {
  const s = state.song;
  $('#tp-title').textContent = s ? s.name : 'Choose a song';
  const mode = engineMode();
  $$('#tp-modes .mode[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.disabled = b.dataset.mode === 'mix' ? !hasMix() : !pt.tracks.length;
  });
  const busy = mode === 'multi' && pt.tracks.some((t) => audible(t) && t.loading);
  $('#tp-play').textContent = engineIsPlaying() ? '❚❚' : '▶';
  const playable = room.following || (mode === 'mix' ? hasMix() : pt.tracks.length > 0);
  ['#tp-play', '#tp-stop', '#tp-start', '#tp-seek'].forEach((q) => { $(q).disabled = !playable; });
  $('#tp-len').textContent = fmt(room.following ? room.anchor?.duration || s?.duration_seconds : songDuration());
  $('#tp-mixer').classList.toggle('open', !$('#mixer').hidden);
  $('#tp-mixer').disabled = !pt.tracks.length;
  let status = '';
  if (busy) {
    const loading = pt.tracks.filter((t) => audible(t) && t.loading);
    const p = loading.reduce((a, t) => a + (t.progress || 0), 0) / loading.length;
    status = `Loading tracks… ${Math.round(p * 100)}%`;
  }
  if (room.following) status = `Following ${room.hostName || 'the host'} · ${room.syncMs != null ? `synced ±${room.syncMs} ms` : 'syncing…'}`;
  $('#tp-status').textContent = status;
  document.body.classList.toggle('following', room.following);
}

function tick() {
  const s = state.song;
  if (s) {
    const pos = enginePosition();
    const dur = room.following ? (room.anchor?.duration || s.duration_seconds) : songDuration();
    if (!room.following && engineMode() === 'multi' && pt.playing && pos >= dur - 0.02) { pt.playing = false; stopSources(); pt.offset = dur; afterTransport(); }
    $('#tp-pos').textContent = fmt(pos);
    if (!seeking) $('#tp-seek').value = dur ? Math.round((pos / dur) * 1000) : 0;
    liveChips(pos);
    lyricsFit();
    lyricsUpdate(pos);
    if (!$('#mixer').hidden) meters();
    if ((engineIsPlaying() ? 1 : 0) !== tick.wasPlaying) { tick.wasPlaying = engineIsPlaying() ? 1 : 0; renderTransport(); }
  }
  $('#offline-card').addEventListener('click', (e) => {
    const all = state.songs.map((x) => x.slug);
    if (e.target.id === 'off-mix') offlineDownload(all);
    if (e.target.id === 'off-all') offlineDownload(all, { everything: true });
    if (e.target.id === 'off-update') offlineDownload(all, { onlyUpdates: true });
    if (e.target.id === 'off-stop' && offline.job) offline.job.cancelled = true;
    if (e.target.id === 'off-clear') offlineClear();
  });
  window.addEventListener('online', async () => { renderOfflineBanner(); if (state.member) { await loadData(); renderOfflineBanner(); renderOfflinePanel(); } });
  window.addEventListener('offline', () => { renderOfflineBanner(); renderOfflinePanel(); });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
    // Also put what this page is running into the app cache, so the very first
    // visit already opens with no connection.
    window.addEventListener('load', () => setTimeout(async () => {
      try {
        const cache = await caches.open('cp-app-shell-v1');
        const urls = new Set([new URL('./', location.href).href, new URL('index.html', location.href).href, new URL('vendor/lamejs.js', location.href).href]);
        for (const e of performance.getEntriesByType('resource')) { const u = new URL(e.name); if ((u.origin === location.origin && u.pathname.startsWith(new URL('./', location.href).pathname) && !u.pathname.endsWith('sw.js')) || u.hostname === 'esm.sh') urls.add(u.href); }
        for (const el of document.querySelectorAll('script[src], link[rel=stylesheet][href], link[rel~=icon][href]')) urls.add(new URL(el.src || el.href, location.href).href);
        await Promise.all([...urls].map((u) => cache.match(u).then((hit) => hit || cache.add(u)).catch(() => {})));
      } catch { /* ignore */ }
    }, 3000));
  }
  requestAnimationFrame(tick);
}

function liveChips(pos) {
  const s = state.song; const ly = s?.lyrics || {};
  const key = (ly.keys || []).filter((k) => k.t <= pos + 0.05).pop()?.key || s?.song_key;
  const bpm = (ly.tempo || []).filter((p) => p[0] <= pos + 0.05).pop()?.[1] || s?.bpm;
  $('#tp-key').textContent = key ? `Key ${key}` : '';
  $('#tp-bpm').textContent = bpm ? `${Math.round(bpm * 10) / 10} BPM` : '';
  // bar.beat from the tempo map (seconds -> beats)
  const tempo = ly.tempo?.length ? ly.tempo : (bpm ? [[0, bpm]] : null);
  if (tempo) {
    let beats = 0;
    for (let i = 0; i < tempo.length; i++) {
      const [t0, b0] = tempo[i]; const t1 = i + 1 < tempo.length ? tempo[i + 1][0] : Infinity;
      if (pos <= t0) break;
      beats += (Math.min(pos, t1) - t0) * b0 / 60;
    }
    const per = (ly.sig?.[0] || 4) * 4 / (ly.sig?.[1] || 4);
    $('#tp-bar').textContent = `Bar ${Math.floor(beats / per) + 1}.${Math.floor(beats % per) + 1}`;
  } else $('#tp-bar').textContent = '';
}

// ------------------------------------------------------------------ mixer
function renderMixer() {
  const box = $('#mixer');
  if (box.hidden) return;
  if (!pt.tracks.length) { box.innerHTML = '<div class="mx-head">No separate tracks for this song.</div>'; return; }
  box.classList.toggle('idle', engineMode() !== 'multi');
  box.innerHTML = `<div class="mx-head"><b>Mixer</b>${engineMode() !== 'multi' ? ' · the Mixdown is playing — <button class="btn small" id="mx-use">Use the Multitrack</button>' : ''}<span class="spacer"></span><button class="btn small" id="mx-reset">Reset</button></div>`
    + pt.tracks.map((t, i) => `<div class="mx-row" data-slug="${esc(t.slug)}"></div><div class="mx-meter" data-meter="${i}"><i></i></div>`).join('');
  pt.tracks.forEach(renderMixerRow);
}
function renderMixerRow(t) {
  const row = $(`#mixer .mx-row[data-slug="${CSS.escape(t.slug)}"]`);
  if (!row) return;
  const m = mixerSetting(t.slug, t.kind);
  const sub = t.failed ? 'failed — tap On to retry' : t.loading ? `loading ${Math.round((t.progress || 0) * 100)}%` : t.buffer ? (t.kind === 'stem' ? 'stem' : t.kind === 'cue' ? 'cue' : t.kind === 'part' ? 'part' : '') : 'not loaded';
  row.classList.toggle('muted-row', !audible(t));
  row.innerHTML = `<span class="mx-color" style="background:${esc(t.color || '#888')}"></span>
    <span class="mx-name">${esc(t.label)}<small>${esc(sub)}</small></span>
    <button class="mx-on ${m.on ? 'lit' : ''}" data-act="on" title="Track on/off">${m.on ? 'On' : 'Off'}</button>
    <button class="mx-solo ${m.solo ? 'lit' : ''}" data-act="solo" title="Solo">S</button>
    <input class="mx-fader" type="range" min="-40" max="6" step="0.5" value="${m.vol}" data-act="vol" aria-label="${esc(t.label)} volume">
    <span class="mx-db">${m.vol <= -40 ? '-∞' : (m.vol > 0 ? '+' : '') + m.vol} dB</span>`;
}
function mixerAction(slug, act, value) {
  const t = pt.tracks.find((x) => x.slug === slug); if (!t) return;
  const m = mixerSetting(slug, t.kind);
  if (act === 'on') { m.on = !m.on; if (t.failed && m.on) t.failed = null; }
  if (act === 'solo') m.solo = !m.solo;              // additive: each S joins or leaves the solo group
  if (act === 'vol') m.vol = Number(value) <= -40 ? -60 : Number(value);
  applyGains();
  for (const x of pt.tracks) { if (audible(x) && !x.buffer && engineMode() === 'multi') ensureTrack(x); }
  if (act === 'vol') { const row = $(`#mixer .mx-row[data-slug="${CSS.escape(slug)}"] .mx-db`); if (row) row.textContent = `${m.vol <= -40 ? '-∞' : (m.vol > 0 ? '+' : '') + m.vol} dB`; }
  else pt.tracks.forEach(renderMixerRow);
  renderTransport();
}
const meterBuf = new Float32Array(512);
function meters() {
  if (engineMode() !== 'multi') return;
  pt.tracks.forEach((t, i) => {
    const bar = $(`#mixer [data-meter="${i}"] i`); if (!bar) return;
    let peak = 0;
    if (t.analyser && pt.playing && audible(t)) { t.analyser.getFloatTimeDomainData(meterBuf); for (const v of meterBuf) { const a = Math.abs(v); if (a > peak) peak = a; } }
    t.meter = Math.max(peak, (t.meter || 0) * 0.9);
    bar.style.transform = `scaleX(${Math.min(1, t.meter)})`;
  });
}

// ------------------------------------------------------------------ lyrics
const LY_SIZES = ['S', 'M', 'L', 'XL'];
let lyLines = [], lySections = [], lyCurrent = -1, lyCurrentSec = -1, lyricsJumpScroll = false, lyTouchedAt = 0;

function lyricsTrackChoice(song) {
  const tracks = song?.lyrics?.tracks || [];
  const want = lget('cp-ly-track', 'lyrics');
  return tracks.find((t) => t.slug === want) || tracks.find((t) => t.slug === 'lyrics') || tracks[0] || null;
}
function chordHtml(text) {
  // AbleSet clip-name syntax: [X] chord box, "[Key:] [C]" key line, "\" line break, (text) stays plain.
  let s = String(text);
  const key = /^\s*\[Key:\]\s*\[([^\]]+)\]\s*$/.exec(s);
  if (key) return `<span class="ly-keyline">Key: ${esc(key[1])}</span>`;
  s = esc(s).replace(/\\/g, '<br>');
  s = s.replace(/\[([^\]]*)\]/g, (m, c) => (c === '>' || c === '<' ? '' : `<span class="ly-chord">${c}</span>`));
  return s;
}
function renderLyrics() {
  const song = state.song, box = $('#lyrics');
  const tracks = song?.lyrics?.tracks || [];
  const cur = lyricsTrackChoice(song);
  $('#ly-tracks').innerHTML = tracks.map((t) => `<button class="ly-chip ${t === cur ? 'active' : ''}" data-ly="${esc(t.slug)}"><i style="background:${esc(t.color || '#888')}"></i>${esc(t.label)}</button>`).join('');
  lyLines = []; lySections = []; lyCurrent = -1; lyCurrentSec = -1;
  if (!song) { box.innerHTML = '<div class="ly-empty">Choose a song.</div>'; return; }
  const sections = (song.lyrics?.sections || []).slice().sort((a, b) => a.t - b.t);
  const lines = (cur?.lines || []).slice().sort((a, b) => a.t - b.t);
  // a line goes under the section holding most of it
  const secOf = (l) => {
    let best = -1, most = -1;
    sections.forEach((s, i) => {
      const end = i + 1 < sections.length ? sections[i + 1].t : Infinity;
      const ov = Math.min(l.e, end) - Math.max(l.t, s.t);
      if (ov > most) { most = ov; best = i; }
    });
    return best;
  };
  const groups = sections.map(() => []); const loose = [];
  for (const l of lines) { const i = secOf(l); (i >= 0 ? groups[i] : loose).push(l); }
  let html = `<div class="ly-title">${esc(song.name.toUpperCase())}</div>`;
  const lineHtml = (l) => { lyLines.push(l); return `<div class="ly-line" data-i="${lyLines.length - 1}" style="--c:${esc(l.c || '#fff')}">${chordHtml(l.text)}</div>`; };
  loose.forEach((l) => { html += lineHtml(l); });
  sections.forEach((s, i) => {
    lySections.push(s);
    html += `<div class="ly-section" data-s="${i}" style="--sec:${esc(shade(s.c))}">${esc(s.name)}</div>`;
    groups[i].forEach((l) => { html += lineHtml(l); });
  });
  if (!lines.length && !sections.length) html += '<div class="ly-empty">No lyrics for this song.</div>';
  box.innerHTML = html;
  box._lineEls = $$('.ly-line', box); box._secEls = $$('.ly-section', box);
  $('#lyrics-scroll').scrollTop = 0;
  lyricsJumpScroll = true;
}
function shade(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return '#3a4a63';
  const n = parseInt(hex.slice(1), 16); const f = 0.62;
  const r = Math.round(((n >> 16) & 255) * f), g = Math.round(((n >> 8) & 255) * f), b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}
function lyricsUpdate(pos) {
  const box = $('#lyrics'); const els = box._lineEls || [];
  let cur = -1;
  for (let i = 0; i < lyLines.length; i++) { if (lyLines[i].t <= pos + 0.08 && pos < lyLines[i].e) cur = i; }
  let next = -1;
  if (cur < 0) for (let i = 0; i < lyLines.length; i++) if (lyLines[i].t > pos) { next = i; break; }
  let sec = -1; for (let i = 0; i < lySections.length; i++) if (lySections[i].t <= pos + 0.08) sec = i;
  if (cur !== lyCurrent || next !== lyUpdateNext || lyricsJumpScroll) {
    els.forEach((el, i) => { el.classList.toggle('current', i === cur); el.classList.toggle('next', i === next); });
    lyCurrent = cur; lyUpdateNext = next;
    const target = els[cur >= 0 ? cur : next] || (box._secEls || [])[sec];
    if (target) scrollLyricsTo(target);
  }
  if (sec !== lyCurrentSec) {
    (box._secEls || []).forEach((el, i) => el.classList.toggle('current', i === sec && cur < 0));
    lyCurrentSec = sec;
  }
  lyricsJumpScroll = false;
}
let lyUpdateNext = -1, lyScrollAnim = null;
// Puts a line about a third of the way down the lyrics box (same as TSP Work).
// Measured with getBoundingClientRect so it is right whatever the page layout,
// zoom or device; only the lyrics box scrolls, never the page.
function scrollLyricsTo(el) {
  const instant = lyricsJumpScroll;
  if (!instant && Date.now() - lyTouchedAt < 4000) return;   // the reader scrolled by hand: wait 4 s
  const sc = $('#lyrics-scroll');
  if (!sc || !sc.clientHeight) return;
  const top = el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - sc.clientHeight * 0.35;
  const goal = Math.max(0, Math.min(sc.scrollHeight - sc.clientHeight, Math.round(top)));
  if (Math.abs(sc.scrollTop - goal) < 2) return;
  cancelAnimationFrame(lyScrollAnim);
  if (instant) { sc.scrollTop = goal; return; }
  // iPhone/iPad: Safari's own smooth scrolling is the reliable way to glide there.
  if (PHONE && 'scrollBehavior' in document.documentElement.style) { sc.scrollTo({ top: goal, behavior: 'smooth' }); return; }
  const from = sc.scrollTop, dist = goal - from;
  const dur = Math.min(900, 420 + Math.abs(dist) * 0.6);
  const t0 = performance.now();
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const step = (now) => {
    if (Date.now() - lyTouchedAt < 300) return;   // the reader took over
    const k = Math.min(1, (now - t0) / dur);
    sc.scrollTop = from + dist * ease(k);
    if (k < 1) lyScrollAnim = requestAnimationFrame(step);
  };
  lyScrollAnim = requestAnimationFrame(step);
}
// The lyrics box always ends just above the playback bar, and the space above
// the first line / below the last is sized to the box (not the screen), so the
// current line can sit a third of the way down on the page and in full screen.
function lyricsFit() {
  const sc = $('#lyrics-scroll'), box = $('#lyrics');
  if (!sc || !box || $('#view-practice').hidden) return;
  let h;
  if (document.body.classList.contains('fs')) h = window.innerHeight;
  else {
    const bar = $('#transport');
    const barTop = bar && getComputedStyle(bar).display !== 'none' ? bar.getBoundingClientRect().top : window.innerHeight;
    h = Math.round(Math.max(260, barTop - 12 - sc.getBoundingClientRect().top));
  }
  if (Math.abs(sc.offsetHeight - h) > 2) sc.style.height = `${h}px`;
  const padTop = `${Math.round(h * 0.18)}px`, padBottom = `${Math.round(h * 0.62)}px`;
  if (box.style.paddingTop !== padTop) box.style.paddingTop = padTop;
  if (box.style.paddingBottom !== padBottom) box.style.paddingBottom = padBottom;
}
function setLySize(sz) {
  LY_SIZES.forEach((s) => document.body.classList.remove(`ly-${s}`));
  document.body.classList.add(`ly-${sz}`); lset('cp-ly-size', sz); lyricsJumpScroll = true;
}

// full screen
let fsTimer = 0;
function toggleFs(on = !document.body.classList.contains('fs')) {
  document.body.classList.toggle('fs', on);
  document.body.classList.remove('fs-quiet');
  if (on) { try { document.documentElement.requestFullscreen?.(); } catch { /* iPhone */ } fsPoke(); }
  else { try { if (document.fullscreenElement) document.exitFullscreen(); } catch { /* fine */ } }
  $('#btn-fs').classList.toggle('on', on);
  lyricsFit(); lyricsJumpScroll = true;
}
function fsPoke() {
  document.body.classList.remove('fs-quiet');
  clearTimeout(fsTimer);
  if (document.body.classList.contains('fs')) fsTimer = setTimeout(() => { if (engineIsPlaying() && $('#mixer').hidden) document.body.classList.add('fs-quiet'); }, 3000);
}

// ------------------------------------------------------------------ group practice (rooms)
// One device plays (the host); the others follow its playhead for the lyrics and can drive
// its transport. Supabase Realtime broadcast; clocks matched by round trips (shortest wins).
const room = {
  code: null, channel: null, host: false, following: false, anchor: null, offset: 0, bestRtt: Infinity, syncMs: null,
  members: 0, hostName: '', device: sget('cp-device', null) || Math.random().toString(36).slice(2, 10), lastSend: 0, pingTimer: 0, sendTimer: 0, lastHostSeen: 0,
};
sset('cp-device', room.device);
const roomCodeGen = () => Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');

async function roomOpen(code, host) {
  await roomLeave(true);
  room.code = code; room.host = host; room.following = !host; room.anchor = null; room.offset = 0; room.bestRtt = Infinity; room.syncMs = null;
  sset('cp-room', { code, host });
  const ch = db.channel(`cp-room-${code}`, { config: { broadcast: { self: false }, presence: { key: room.device } } });
  room.channel = ch;
  ch.on('broadcast', { event: 'state' }, ({ payload }) => roomOnState(payload));
  ch.on('broadcast', { event: 'ping' }, ({ payload }) => { if (room.host) ch.send({ type: 'broadcast', event: 'pong', payload: { ...payload, th: Date.now() } }); });
  ch.on('broadcast', { event: 'pong' }, ({ payload }) => roomOnPong(payload));
  ch.on('broadcast', { event: 'cmd' }, ({ payload }) => roomOnCmd(payload));
  ch.on('broadcast', { event: 'hello' }, () => roomHostSend(true));
  ch.on('broadcast', { event: 'bye' }, () => { if (room.following) { toast('The host ended the room.'); roomLeave(); } });
  ch.on('presence', { event: 'sync' }, () => { room.members = Object.keys(ch.presenceState()).length; renderRoomBar(); });
  ch.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await ch.track({ name: state.member?.name, host });
      if (host) roomHostSend(true);
      else { ch.send({ type: 'broadcast', event: 'hello', payload: {} }); roomPing(); }
    }
  });
  clearInterval(room.pingTimer); clearInterval(room.sendTimer);
  if (!host) {
    room.pingTimer = setInterval(roomPing, 4000);
    enginePauseLocal(); stopSources();
  } else room.sendTimer = setInterval(() => roomHostSend(false), 500);
  renderRoomBar(); renderTransport(); renderMixer(); wakeLockUpdate();
  if (!host) $('#mixer').hidden = true;
}
function enginePauseLocal() { pt.audio.pause(); if (pt.playing) { pt.offset = pt.ctx ? pt.offset + (pt.ctx.currentTime - pt.startAt) : pt.offset; stopSources(); pt.playing = false; } }
async function roomLeave(silent) {
  if (!room.channel) { room.code = null; room.following = false; sset('cp-room', null); renderRoomBar(); return; }
  try { if (room.host) await room.channel.send({ type: 'broadcast', event: 'bye', payload: {} }); } catch { /* offline */ }
  try { await db.removeChannel(room.channel); } catch { /* gone */ }
  clearInterval(room.pingTimer); clearInterval(room.sendTimer);
  const wasFollowing = room.following;
  room.channel = null; room.code = null; room.host = false; room.following = false; room.anchor = null;
  sset('cp-room', null);
  renderRoomBar(); renderTransport();
  if (wasFollowing && !silent && state.song) selectSong(state.song.slug, { quiet: true });
}
function roomRejoin() { const r = sget('cp-room', null); if (r?.code) roomOpen(r.code, r.host); }

function roomHostSend(force) {
  if (!room.host || !room.channel || !state.song) return;
  const now = Date.now();
  if (!force && now - room.lastSend < 450) return;
  room.lastSend = now;
  room.channel.send({ type: 'broadcast', event: 'state', payload: {
    song: state.song.slug, pos: enginePosition(), at: now, playing: !!engineIsPlaying(), duration: songDuration(), host: state.member?.name,
  } });
}
function roomOnState(p) {
  if (!room.following) return;
  room.lastHostSeen = Date.now();
  room.hostName = p.host || '';
  const newSong = p.song !== state.song?.slug;
  room.anchor = p;
  if (newSong) selectSong(p.song, { fromRoom: true, quiet: true });
  renderTransport();
}
function roomPosition() {
  const a = room.anchor; if (!a) return 0;
  if (!a.playing) return a.pos;
  const hostNow = Date.now() + room.offset;
  return Math.min(a.duration || Infinity, a.pos + (hostNow - a.at) / 1000);
}
function roomPing() { if (room.channel && room.following) room.channel.send({ type: 'broadcast', event: 'ping', payload: { from: room.device, t0: Date.now() } }); }
function roomOnPong(p) {
  if (p.from !== room.device) return;
  const t1 = Date.now(), rtt = t1 - p.t0;
  const off = p.th - (p.t0 + t1) / 2;
  // keep the least lopsided sample; let it age so a better network later can win
  room.bestRtt = Math.min(room.bestRtt * 1.05 + 2, 5000);
  if (rtt <= room.bestRtt) { room.bestRtt = rtt; room.offset = room.syncMs == null ? off : room.offset + (off - room.offset) * 0.5; room.syncMs = Math.round(rtt / 2); }
}
function roomCmd(cmd, extra = {}) {
  if (!room.channel) return;
  room.channel.send({ type: 'broadcast', event: 'cmd', payload: { cmd, ...extra } });
}
function roomOnCmd(p) {
  if (!room.host) return;
  if (p.cmd === 'play') enginePlay();
  else if (p.cmd === 'pause') enginePause();
  else if (p.cmd === 'stop') engineStop();
  else if (p.cmd === 'seek') engineSeek(Number(p.t) || 0);
  else if (p.cmd === 'song' && p.slug) selectSong(p.slug);
}
function renderRoomBar() {
  const bar = $('#room-bar');
  $('#btn-room').classList.toggle('on', !!room.code);
  if (!room.code) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.innerHTML = room.host
    ? `<span>Group practice · room <span class="code">${esc(room.code)}</span> · you are playing the audio · ${room.members || 1} device${room.members === 1 ? '' : 's'}</span><span class="spacer"></span><button class="btn small" id="room-end">End room</button>`
    : `<span>Following room <span class="code">${esc(room.code)}</span> · lyrics follow the host's playback</span><span class="spacer"></span><button class="btn small" id="room-end">Leave</button>`;
}
function roomDialog() {
  const d = $('#dlg');
  if (room.code) {
    d.innerHTML = `<h3>Group practice</h3><p>${room.host ? 'Share this code with the other devices:' : 'You are following room:'}</p><div class="big-code">${esc(room.code)}</div>
      <div class="actions"><button class="btn" value="close">Close</button><button class="btn danger" id="dlg-leave">${room.host ? 'End room' : 'Leave room'}</button></div>`;
  } else {
    d.innerHTML = `<h3>Group practice</h3>
      <p class="muted">One device plays the audio (connect it to the speaker). Every other device follows its lyrics in time, and can play, pause, seek or change song for everyone.</p>
      <button class="list-btn" id="dlg-make"><b>Make a room</b><br><span class="muted small">This device plays the audio</span></button>
      <div class="list-btn"><b>Join a room</b><div class="row" style="margin-top:8px"><input class="field" id="dlg-code" maxlength="4" placeholder="CODE" autocapitalize="characters" style="flex:1;text-transform:uppercase;letter-spacing:.2em"><button class="btn primary" id="dlg-join">Join</button></div></div>
      <div class="actions"><button class="btn" value="close">Close</button></div>`;
  }
  d.showModal();
}

// ------------------------------------------------------------------ media session + wake lock
function mediaSessionUpdate() {
  if (!('mediaSession' in navigator) || !state.song) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: state.song.name, artist: 'Caroline Practice', album: engineMode() === 'mix' ? 'Mixdown' : 'Multitrack', artwork: [{ src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] });
  } catch { /* old browser */ }
}
if ('mediaSession' in navigator) {
  const h = (a, f) => { try { navigator.mediaSession.setActionHandler(a, f); } catch { /* unsupported */ } };
  h('play', () => enginePlay()); h('pause', () => enginePause());
  h('previoustrack', () => stepSong(-1)); h('nexttrack', () => stepSong(1));
  h('seekto', (e) => engineSeek(e.seekTime));
}
let wakeLock = null;
async function wakeLockUpdate() {
  const want = engineIsPlaying() || room.following;
  try {
    if (want && !wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
    else if (!want && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { wakeLock = null; }
}

// ------------------------------------------------------------------ dialogs
function songPicker() {
  const d = $('#dlg');
  d.innerHTML = `<h3>Songs</h3>${state.songs.map((s) => `<button class="list-btn ${s.slug === state.song?.slug ? 'active' : ''}" data-pick="${esc(s.slug)}"><b>${esc(s.name)}</b> <span class="muted small">${fmt(s.duration_seconds)}${s.song_key ? ' · Key ' + esc(s.song_key) : ''}</span></button>`).join('')}<div class="actions"><button class="btn" value="close">Close</button></div>`;
  d.showModal();
}
function sizePicker() {
  const d = $('#dlg'); const cur = lget('cp-ly-size', 'M');
  d.innerHTML = `<h3>Text size</h3><div class="row">${LY_SIZES.map((s) => `<button class="btn ${s === cur ? 'primary' : ''}" data-size="${s}">${s}</button>`).join('')}</div><div class="actions"><button class="btn" value="close">Close</button></div>`;
  d.showModal();
}
function passwordDialog() {
  const d = $('#dlg');
  d.innerHTML = `<h3>Change password</h3><p class="muted small">At least 8 characters. Your other devices stay signed in.</p>
    <input class="field" id="pw1" type="password" autocomplete="new-password" placeholder="New password">
    <input class="field" id="pw2" type="password" autocomplete="new-password" placeholder="Repeat it" style="margin-top:8px">
    <p class="msg" id="pw-msg"></p><div class="actions"><button class="btn" value="close">Cancel</button><button class="btn primary" id="pw-save">Save</button></div>`;
  d.showModal();
}

// ------------------------------------------------------------------ wiring
function wireStatic() {
  setLySize(lget('cp-ly-size', 'M'));
  $('#signin-form').addEventListener('submit', signIn);
  $$('.tab').forEach((t) => t.addEventListener('click', () => setView(t.dataset.view)));
  $('#acct-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#acct-menu').hidden = !$('#acct-menu').hidden; });
  document.addEventListener('click', () => { $('#acct-menu').hidden = true; });
  $('#acct-out').addEventListener('click', signOut);
  $('#acct-pass').addEventListener('click', passwordDialog);
  $('#song-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-song]'); if (!b) return;
    if (room.following) roomCmd('song', { slug: b.dataset.song }); else selectSong(b.dataset.song);
  });
  $('#ly-tracks').addEventListener('click', (e) => { const b = e.target.closest('[data-ly]'); if (!b) return; lset('cp-ly-track', b.dataset.ly); renderLyrics(); });
  $('#lyrics').addEventListener('click', (e) => {
    const l = e.target.closest('.ly-line'); const s = e.target.closest('.ly-section');
    if (l) engineSeek(lyLines[+l.dataset.i].t); else if (s) engineSeek(lySections[+s.dataset.s].t);
    else if (document.body.classList.contains('fs')) document.body.classList.toggle('fs-quiet');
  });
  const sc = $('#lyrics-scroll');
  // A hand scroll (touch, wheel, keys, scrollbar) pauses the autoscroll for 4 s.
  ['touchstart', 'wheel', 'keydown', 'pointerdown'].forEach((ev) => sc.addEventListener(ev, () => { lyTouchedAt = Date.now(); cancelAnimationFrame(lyScrollAnim); }, { passive: true }));
  window.addEventListener('resize', () => { lyricsFit(); lyricsJumpScroll = true; });
  window.addEventListener('scroll', lyricsFit, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => { lyricsFit(); }).observe($('#transport'));
  $('#btn-size').addEventListener('click', sizePicker);
  $('#btn-fs').addEventListener('click', () => toggleFs());
  $('#btn-room').addEventListener('click', roomDialog);
  $('#room-bar').addEventListener('click', (e) => { if (e.target.id === 'room-end') roomLeave(); });
  ['mousemove', 'touchstart', 'keydown'].forEach((ev) => document.addEventListener(ev, fsPoke, { passive: true }));

  $('#tp-play').addEventListener('click', () => (engineIsPlaying() ? enginePause() : enginePlay()));
  $('#tp-stop').addEventListener('click', engineStop);
  $('#tp-start').addEventListener('click', () => engineSeek(0));
  $('#tp-prev').addEventListener('click', () => stepSong(-1));
  $('#tp-next').addEventListener('click', () => stepSong(1));
  $('#tp-song').addEventListener('click', songPicker);
  const seek = $('#tp-seek');
  seek.addEventListener('input', () => { seeking = true; const dur = room.following ? room.anchor?.duration || 0 : songDuration(); $('#tp-pos').textContent = fmt(seek.value / 1000 * dur); });
  seek.addEventListener('change', () => { const dur = room.following ? room.anchor?.duration || 0 : songDuration(); engineSeek(seek.value / 1000 * dur); seeking = false; });
  $('#tp-modes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]'); if (b) return setMode(b.dataset.mode);
    if (e.target.closest('#tp-mixer')) { $('#mixer').hidden = !$('#mixer').hidden; renderMixer(); renderTransport(); if (!$('#mixer').hidden && engineMode() === 'multi') loadAudibleTracks(); }
  });
  const mx = $('#mixer');
  mx.addEventListener('click', (e) => {
    if (e.target.id === 'mx-reset') { pt.mixer = {}; applyGains(); renderMixer(); return; }
    if (e.target.id === 'mx-use') { setMode('multi'); return; }
    const b = e.target.closest('[data-act]'); const row = e.target.closest('.mx-row');
    if (b && row && b.dataset.act !== 'vol') mixerAction(row.dataset.slug, b.dataset.act);
  });
  mx.addEventListener('input', (e) => { const row = e.target.closest('.mx-row'); if (row && e.target.dataset.act === 'vol') mixerAction(row.dataset.slug, 'vol', e.target.value); });
  document.addEventListener('pointerdown', (e) => {
    if (!mx.hidden && !e.target.closest('#mixer') && !e.target.closest('#tp-mixer') && !e.target.closest('#dlg')) { mx.hidden = true; renderTransport(); }
  });

  const d = $('#dlg');
  d.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.value === 'close' || t === d) { d.close(); return; }
    const pick = t.closest('[data-pick]');
    if (pick) { d.close(); if (room.following) roomCmd('song', { slug: pick.dataset.pick }); else selectSong(pick.dataset.pick); return; }
    const size = t.closest('[data-size]');
    if (size) { setLySize(size.dataset.size); d.close(); return; }
    if (t.closest('#dlg-make')) { d.close(); await roomOpen(roomCodeGen(), true); roomDialog(); return; }
    if (t.id === 'dlg-join') {
      const code = $('#dlg-code').value.trim().toUpperCase();
      if (!/^[A-Z0-9]{4}$/.test(code)) { toast('Type the 4-character room code.'); return; }
      d.close(); await roomOpen(code, false); toast(`Joined room ${code}. Waiting for the host…`); return;
    }
    if (t.id === 'dlg-leave') { d.close(); roomLeave(); return; }
    if (t.id === 'pw-save') {
      const a = $('#pw1').value, b = $('#pw2').value;
      if (a.length < 8) { $('#pw-msg').textContent = 'Use at least 8 characters.'; return; }
      if (a !== b) { $('#pw-msg').textContent = 'The two passwords differ.'; return; }
      const { error } = await db.auth.updateUser({ password: a });
      if (error) { $('#pw-msg').textContent = error.message; return; }
      d.close(); toast('Password changed.');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select') || $('#app').hidden || state.view !== 'practice') return;
    if (e.code === 'Space') { e.preventDefault(); engineIsPlaying() ? enginePause() : enginePlay(); }
    else if (e.key === 'f' || e.key === 'F') toggleFs();
    else if (e.key === 'Escape' && document.body.classList.contains('fs')) toggleFs(false);
    else if (e.key === 'ArrowRight') engineSeek(enginePosition() + 5);
    else if (e.key === 'ArrowLeft') engineSeek(enginePosition() - 5);
  });
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('fs')) toggleFs(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { wakeLockUpdate(); if (pt.ctx?.state === 'suspended' && pt.playing) pt.ctx.resume(); if (room.following) roomPing(); }
  });
  requestAnimationFrame(tick);
}

// ================================================================== Ableton Sync (admin)
const sync = { parsed: null, alsName: '', rows: [], busy: false, convert: true, skipSilent: true };

function renderSync() {
  const v = $('#view-sync');
  const meta = state.setMeta || {};
  const els = state.elements.filter((e) => e.slug);
  v.innerHTML = `<div class="sync-grid">
    <section class="card">
      <div class="row"><h2 style="margin:0">Ableton set</h2><span class="spacer"></span>
        <label class="btn primary">Read set (.als)…<input type="file" id="als-file" accept=".als" hidden></label></div>
      <p class="muted small">${meta.als_name ? `Last read: <b>${esc(meta.als_name)}</b> · ${esc(new Date(meta.read_at).toLocaleString())}` : 'No set read yet.'}
       Songs come from the <b>locators</b> (one at each song start, plus “SONG END” after the last). Lyrics from every <b>+LYRICS</b> track, sections from <b>SECTIONS</b>.</p>
      <div id="als-preview"></div>
      <table class="tbl"><thead><tr><th>Song</th><th>Length</th><th>Key</th><th>BPM</th><th>Lyrics tracks</th><th>Sections</th></tr></thead><tbody>
      ${state.songs.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${fmt(s.duration_seconds)}</td><td>${esc(s.song_key || '')}</td><td>${esc(s.bpm || '')}</td><td>${(s.lyrics?.tracks || []).map((t) => esc(t.label)).join(', ')}</td><td>${(s.lyrics?.sections || []).length}</td></tr>`).join('')}
      </tbody></table>
    </section>

    <section class="card">
      <div class="row"><h2 style="margin:0">Practice audio</h2><span class="spacer"></span><button class="btn small" id="aud-refresh">Refresh</button></div>
      ${state.songs.map((s) => {
        const have = state.audio[s.slug] || {};
        return `<h3>${esc(s.name)}</h3><div class="status-grid">${els.map((e) => {
          const f = have[e.slug];
          return `<div class="st ${f ? 'have' : ''}"><b><span class="dot" style="background:${esc(e.color || '#888')}"></span>${esc(e.label)}</b>${f ? `<span class="ok">✓ ${mb(f.bytes)} · ${esc(f.ext)}</span> <button class="btn small ghost" data-del="${esc(s.slug)}|${esc(e.slug)}" title="Delete this file">✕</button>` : '<span class="muted">—</span>'}</div>`;
        }).join('')}${Object.keys(have).filter((k) => !els.some((e) => e.slug === k)).map((k) => `<div class="st have"><b>${esc(k)}</b><span class="warnc">not in the set any more</span> <button class="btn small ghost" data-del="${esc(s.slug)}|${esc(k)}">✕</button></div>`).join('')}</div>`;
      }).join('')}
    </section>

    <section class="card" id="exp-card"></section>

    <section class="card">
      <h2>Upload exports by hand</h2>
      <details class="help"><summary>How to export from Ableton</summary><ol>
        <li>In Ableton, click the song's locator, then shift-click the next locator so the song's time range is selected (or set the loop brace over the song).</li>
        <li>File › Export Audio/Video. <b>Rendered Track: All Individual Tracks</b> (gives each track) — and once with <b>Main</b> for the Mixdown.</li>
        <li>Turn on <b>Encode MP3</b> (smaller and quicker; WAV also works and is converted here).</li>
        <li>Save with the <b>song name</b> as the file name (e.g. “Lean On Me”), so each file is matched to its song and track automatically.</li>
        <li>Drop all the files below, check the matches, press Upload. Silent tracks are skipped.</li></ol></details>
      <div class="drop" id="drop" style="margin-top:12px">Drop exported audio files here<br><span class="small">or</span><br>
        <label class="btn small">Choose files<input type="file" id="aud-files" accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a" multiple hidden></label>
        <label class="btn small">Choose a folder<input type="file" id="aud-folder" webkitdirectory multiple hidden></label></div>
      <div class="row" style="margin:10px 0">
        <label><input type="checkbox" id="opt-convert" ${sync.convert ? 'checked' : ''}> Convert WAV/AIFF to MP3 before uploading</label>
        <label><input type="checkbox" id="opt-silent" ${sync.skipSilent ? 'checked' : ''}> Skip silent tracks</label>
      </div>
      <div id="up-table"></div>
    </section>

    <section class="card"><h2>Sign-ins</h2><div id="users">Loading…</div>
      <p class="muted small">Caroline signs in with username <b>caroline</b>. She can use the same sign-in on any number of devices, and change her password from the menu at the top right.</p></section>
  </div>`;
  renderUploadTable();
  renderExportCard(); bridgeWatch();
  db.from('cp_users').select('name,role,created_at').order('created_at').then(({ data }) => {
    const u = $('#users'); if (u) u.innerHTML = (data || []).map((m) => `<div>${esc(m.name)} <span class="muted small">· ${esc(m.role)}</span></div>`).join('');
  });
  wireSync();
}

function wireSync() {
  const v = $('#view-sync');
  $('#als-file', v).addEventListener('change', (e) => readAls(e.target.files[0]));
  $('#aud-refresh', v).addEventListener('click', async () => { await refreshAudioList(); renderSongChips(); renderSync(); });
  $('#aud-files', v).addEventListener('change', (e) => addFiles(e.target.files));
  $('#aud-folder', v).addEventListener('change', (e) => addFiles(e.target.files));
  $('#opt-convert', v).addEventListener('change', (e) => { sync.convert = e.target.checked; });
  $('#opt-silent', v).addEventListener('change', (e) => { sync.skipSilent = e.target.checked; });
  const drop = $('#drop', v);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
  if (v._wired) return;   // the delegated listeners below are added once
  v._wired = true;
  v.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const [song, el] = del.dataset.del.split('|');
      if (!confirm(`Delete ${el} of ${song}? Players will no longer have it.`)) return;
      try { await fn({ action: 'delete', song, element: el }); toast('Deleted.'); await refreshAudioList(); renderSync(); } catch (err) { toast(`Delete failed: ${err.message}`); }
    }
    if (e.target.id === 'als-save') saveAls();
    if (e.target.id === 'exp-all') { exp.selected = new Set(state.songs.map((x) => x.slug)); lset('cp-exp-sel', [...exp.selected]); renderExportCard(); }
    if (e.target.id === 'exp-none') { exp.selected = new Set(); lset('cp-exp-sel', []); renderExportCard(); }
    if (e.target.id === 'exp-start') exportStart();
    if (e.target.id === 'exp-after') bridgeCall('/export/cancel', { after_song: true }).then(exportPoll);
    if (e.target.id === 'exp-cancel') { if (confirm('Cancel the export now? Live is put back as it was.')) bridgeCall('/export/cancel', {}).then(exportPoll); }
    if (e.target.id === 'exp-retry') bridgeProbe(true);
    if (e.target.id === 'up-go') uploadAll();
    if (e.target.id === 'up-clear') { sync.rows = []; renderUploadTable(); }
  });
  v.addEventListener('change', (e) => {
    if (e.target.matches('[data-exp-song]')) {
      e.target.checked ? exp.selected.add(e.target.dataset.expSong) : exp.selected.delete(e.target.dataset.expSong);
      lset('cp-exp-sel', [...exp.selected]); renderExportCard(); return;
    }
    if (e.target.id === 'exp-folder') { exp.folder = e.target.value.trim(); lset('cp-exp-folder', exp.folder); return; }
    if (e.target.id === 'exp-upload') { exp.upload = e.target.checked; return; }
    const sel = e.target.closest('select[data-row]'); if (!sel) return;
    const r = sync.rows[+sel.dataset.row]; r[sel.dataset.field] = sel.value; r.status = 'ready'; markDuplicates(); renderUploadTable();
  });
}

async function readAls(file) {
  if (!file) return;
  const p = $('#als-preview'); p.innerHTML = '<p>Reading the set…</p>';
  try {
    const parsed = await parseAlsFile(await file.arrayBuffer());
    sync.parsed = parsed; sync.alsName = file.name;
    const old = new Set(state.songs.map((s) => s.slug));
    const neu = new Set(parsed.songs.map((s) => s.slug));
    const removed = state.songs.filter((s) => !neu.has(s.slug));
    p.innerHTML = `<div class="card" style="background:rgba(243,154,38,.08)">
      <b>${esc(file.name)}</b>: ${parsed.songs.length} song${parsed.songs.length === 1 ? '' : 's'} · ${parsed.elements.length - 1} audio tracks
      <ul class="small">${parsed.songs.map((s) => `<li>${esc(s.name)} — ${fmt(s.duration_seconds)} · ${s.lyrics.tracks.length} lyrics tracks · ${s.lyrics.sections.length} sections ${old.has(s.slug) ? '' : '<span class="ok">(new)</span>'}</li>`).join('')}</ul>
      ${removed.length ? `<p class="warnc small">Not in the set any more (will be hidden): ${removed.map((s) => esc(s.name)).join(', ')}</p>` : ''}
      ${parsed.warnings.map((w) => `<p class="warnc small">⚠ ${esc(w)}</p>`).join('')}
      <div class="row"><button class="btn primary" id="als-save">Save to the app</button></div></div>`;
  } catch (e) { p.innerHTML = `<p class="badc">Could not read that file: ${esc(e.message)}</p>`; }
}

async function saveAls() {
  const parsed = sync.parsed; if (!parsed) return;
  const btn = $('#als-save'); btn.disabled = true; btn.textContent = 'Saving…';
  const rows = parsed.songs.map((s) => ({ ...s, hidden: false, updated_at: new Date().toISOString() }));
  const { error } = await db.from('cp_songs').upsert(rows, { onConflict: 'slug' });
  if (error) { toast(`Save failed: ${error.message}`); btn.disabled = false; btn.textContent = 'Save to the app'; return; }
  const keep = parsed.songs.map((s) => s.slug);
  const gone = state.songs.filter((s) => !keep.includes(s.slug)).map((s) => s.slug);
  if (gone.length) await db.from('cp_songs').update({ hidden: true }).in('slug', gone);
  await db.from('cp_meta').upsert({ key: 'set', value: { elements: parsed.elements, als_name: sync.alsName, read_at: new Date().toISOString() }, updated_at: new Date().toISOString() });
  sync.parsed = null;
  await loadData();
  if (state.song) { state.song = state.songs.find((s) => s.slug === state.song.slug) || null; renderLyrics(); }
  toast('Saved. Every device sees the new lyrics next time it opens the song.');
  renderSync();
}

// ---- export from Ableton (CarolineSync control surface on Aaron's Mac)
// CarolineSync is a separate Ableton control surface (tools/ableton-remote-script/CarolineSync),
// never the band's TSPWork. It listens on 127.0.0.1 only and checks the admin's token itself.
const BRIDGE_URLS = ['https://127.0.0.1:47721', 'http://127.0.0.1:47720'];
const exp = { base: null, status: null, job: null, timer: 0, poll: 0, selected: new Set(lget('cp-exp-sel', [])), folder: lget('cp-exp-folder', '~/Desktop/CAROLINE/Caroline Exports'), upload: true, starting: false, error: '' };
const EXP_ERRORS = {
  caroline_set_not_open: 'Open Caroline.als in Ableton first (CarolineSync only exports that set).',
  live_playing: 'Stop playback in Ableton first.', busy: 'CarolineSync is busy — try again in a moment.',
  export_folder_missing: 'That export folder’s parent folder does not exist on this Mac.', bad_export_folder: 'The export folder must be in your home folder or on an external drive.',
  not_admin: 'Only the admin can export.', auth_required: 'Sign in again, then retry.', auth_unreachable: 'CarolineSync could not check your sign-in (is this Mac online?).',
};
async function bridgeFetch(base, path, body, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || (body ? 15000 : 1500));
  try {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'text/plain' } : undefined, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}
async function bridgeProbe(render) {
  let status = null;
  for (const base of exp.base ? [exp.base, ...BRIDGE_URLS.filter((b) => b !== exp.base)] : BRIDGE_URLS) {
    try { const r = await bridgeFetch(base, '/status'); if (r?.app === 'carolinesync') { exp.base = base; status = r; break; } } catch { /* not there */ }
  }
  exp.status = status;
  if (status?.exporting) { exp.job = status.exporting; if (!exp.poll) exportPoll(); }
  if (render) renderExportCard();
  return status;
}
async function bridgeCall(path, body) {
  const token = async (refresh) => { try { const { data } = refresh ? await db.auth.refreshSession() : await db.auth.getSession(); return data?.session?.access_token; } catch { return null; } };
  if (!exp.base) await bridgeProbe();
  if (!exp.base) return { ok: false, error: 'not_running' };
  let r = await bridgeFetch(exp.base, path, { ...body, _auth: await token(false) }, 30000);
  if (r && ['auth_required', 'not_admin'].includes(r.error)) r = await bridgeFetch(exp.base, path, { ...body, _auth: await token(true) }, 30000);
  return r;
}
function bridgeWatch() {
  clearInterval(exp.timer);
  bridgeProbe(true);
  exp.timer = setInterval(() => { if (state.view !== 'sync') { clearInterval(exp.timer); return; } if (!exp.poll) bridgeProbe(true); }, 5000);
}
async function exportStart() {
  const songs = state.songs.filter((s) => exp.selected.has(s.slug));
  if (!songs.length) { toast('Tick at least one song.'); return; }
  exp.starting = true; exp.error = ''; renderExportCard();
  try {
    const elements = state.elements.map((e) => ({ slug: e.slug, track: e.name, group: e.group, label: e.label }));
    let uploads = {};
    if (exp.upload) uploads = (await fn({ action: 'upload_batch', songs: songs.map((s) => s.slug), elements: elements.map((e) => e.slug) })).urls;
    const r = await bridgeCall('/export', {
      export_root: exp.folder || '~/Desktop/CAROLINE/Caroline Exports', uploads, elements,
      songs: songs.map((s) => ({ song_id: s.slug, song_name: s.name, start_beat: s.start_beat, end_beat: s.end_beat, locator: s.name })),
    });
    if (!r?.ok) throw new Error(EXP_ERRORS[r?.error] || r?.error || 'CarolineSync did not answer');
    exp.job = r.job; exportPoll();
  } catch (e) { exp.error = e.message; }
  exp.starting = false; renderExportCard();
}
async function exportPoll() {
  clearTimeout(exp.poll); exp.poll = 0;
  let r; try { r = await bridgeCall('/export/state', {}); } catch { r = null; }
  if (r?.job) exp.job = r.job;
  renderExportCard();
  const st = exp.job?.state;
  if (['starting', 'running', 'uploading'].includes(st)) exp.poll = setTimeout(exportPoll, 3000);
  else if (st && exp.job.finished_at && exp.lastFinished !== exp.job.finished_at) {
    exp.lastFinished = exp.job.finished_at;
    const done = (exp.job.results || []).filter((x) => x.state === 'done').map((x) => x.song_id);
    done.forEach((sl) => exp.selected.delete(sl)); lset('cp-exp-sel', [...exp.selected]);
    await refreshAudioList(); renderSongChips(); pt.filesFor = null;
    toast(st === 'done' ? 'Export finished — the new audio is live for everyone.' : `Export ended: ${exp.job.error || st}`);
    renderSync();
  }
}
function renderExportCard() {
  const box = $('#exp-card'); if (!box) return;
  const s = exp.status, job = exp.job;
  const running = ['starting', 'running', 'uploading'].includes(job?.state);
  let head;
  if (!s && !running) head = `<p class="warnc">CarolineSync isn't answering on this Mac.</p>
    <details class="help" open><summary>How to switch it on</summary><ol>
    <li>Open Ableton Live with <b>Caroline.als</b>.</li>
    <li>Live › Settings › <b>Link, Tempo &amp; MIDI</b> › an empty <b>Control Surface</b> slot › choose <b>CarolineSync</b> (Input and Output: None). Leave TSPWork where it is.</li>
    <li>Use this page in a browser on the same Mac.</li></ol></details><button class="btn small" id="exp-retry">Check again</button>`;
  else if (s && !s.caroline_open && !running) head = `<p class="warnc">CarolineSync ${esc(s.version)} is connected, but the open set is not Caroline.als. Open <b>Caroline.als</b> in Ableton.</p><button class="btn small" id="exp-retry">Check again</button>`;
  else head = `<p class="ok small">CarolineSync ${esc(s?.version || '')} connected · Caroline.als is open.</p>`;
  const have = (slug) => !!state.audio[slug]?.mixdown;
  const list = state.songs.map((x) => `<label class="row" style="gap:8px;padding:4px 0"><input type="checkbox" data-exp-song="${esc(x.slug)}" ${exp.selected.has(x.slug) ? 'checked' : ''} ${running ? 'disabled' : ''}>
    <span class="${have(x.slug) ? 'ok' : ''}">${esc(x.name)}</span><span class="muted small">${fmt(x.duration_seconds)}${have(x.slug) ? ' · uploaded' : ''}</span></label>`).join('');
  let prog = '';
  if (job) {
    const q = job.queue || []; const idx = job.song_index || 0;
    const name = state.songs.find((x) => x.slug === job.song_id)?.name || job.song_id;
    const label = (sl) => state.elements.find((e) => e.slug === sl)?.label || sl;
    const doneSongs = (job.results || []).filter((r) => r.state === 'done').length;
    const pct = q.length ? Math.round(((doneSongs + (job.total ? (job.done || []).length / job.total : 0)) / q.length) * 100) : 0;
    prog = `<div style="margin-top:12px"><div class="bar"><i style="width:${running ? Math.min(99, pct) : 100}%"></i></div>
      <p class="small">${running ? `${job.state === 'uploading' ? 'Finishing uploads' : `Exporting <b>${esc(name)}</b> (${idx + 1} of ${q.length})${job.current ? ` · ${esc(label(job.current))}` : ''}`}` : `Last export: <b>${esc(job.state)}</b>`}
      · ${job.uploaded || 0} uploaded${job.upload_pending ? `, ${job.upload_pending} waiting` : ''}${job.stop_after_song ? ' · will stop after this song' : ''}</p>
      ${(job.results || []).map((r) => `<div class="small">${r.state === 'done' ? '<span class="ok">✓</span>' : r.state === 'error' ? '<span class="badc">✕</span>' : '·'} ${esc(state.songs.find((x) => x.slug === r.song_id)?.name || r.song_id)} — ${esc(r.state)}${r.files ? `, ${r.files} files` : ''}${r.error ? ` <span class="badc">${esc(r.error)}</span>` : ''}</div>`).join('')}
      ${(job.upload_failed || []).map((f) => `<div class="small badc">Upload failed: ${esc(f.song_id)} ${esc(label(f.label))} — ${esc(f.error)}</div>`).join('')}
      ${job.error && !running ? `<p class="badc small">${esc(job.error)}</p>` : ''}</div>`;
  }
  box.innerHTML = `<div class="row"><h2 style="margin:0">Export from Ableton</h2></div>
    <p class="muted small">Like TSP Work's overnight export: tick songs, press Start, and leave Ableton alone. Each track (stems, click, prompts, parts) is rendered on its own, plus a Mixdown of the tracks that are switched on in the set, then uploaded for everyone.</p>
    ${head}
    <div class="row" style="margin:6px 0"><button class="btn small" id="exp-all" ${running ? 'disabled' : ''}>Select all</button><button class="btn small" id="exp-none" ${running ? 'disabled' : ''}>Clear</button></div>
    ${list}
    <div class="row" style="margin-top:10px"><label class="small" style="flex:1;min-width:240px">Export folder on this Mac<input class="field" id="exp-folder" value="${esc(exp.folder)}" style="width:100%;margin-top:4px" ${running ? 'disabled' : ''}></label>
      <label class="small"><input type="checkbox" id="exp-upload" ${exp.upload ? 'checked' : ''} ${running ? 'disabled' : ''}> Upload to the app</label></div>
    <div class="row" style="margin-top:10px"><span class="spacer"></span>
      ${running ? `<button class="btn" id="exp-after">${job.stop_after_song ? 'Keep going' : 'Stop after this song'}</button><button class="btn danger" id="exp-cancel">Cancel</button>`
      : `<button class="btn primary" id="exp-start" ${!s?.caroline_open || exp.starting || !exp.selected.size ? 'disabled' : ''}>${exp.starting ? 'Starting…' : `Start export (${exp.selected.size} song${exp.selected.size === 1 ? '' : 's'})`}</button>`}</div>
    ${exp.error ? `<p class="badc small">${esc(exp.error)}</p>` : ''}${prog}`;
}

// ---- upload exports
const norm = (s) => String(s).toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
function matchFile(name) {
  const n = norm(name);
  let song = null, best = 0;
  for (const s of state.songs) { const k = norm(s.name); if (k && n.includes(k) && k.length > best) { song = s; best = k.length; } }
  let rest = song ? n.replace(norm(song.name), ' ').replace(/\s+/g, ' ').trim() : n;
  rest = rest.replace(/^\d+\s+/, '').trim();
  let el = null;
  if (/(^|\s)(main|master|mixdown|mix)$/.test(rest) || rest === '') el = state.elements.find((e) => e.kind === 'mixdown') || null;
  let len = 0;
  for (const e of state.elements) {
    if (e.kind === 'mixdown') continue;
    const k = norm(e.name);
    if (k && (rest === k || rest.endsWith(' ' + k)) && k.length > len) { el = e; len = k.length; }
  }
  return { song: song?.slug || '', element: el?.slug || '' };
}
function addFiles(list) {
  const files = [...(list || [])].filter((f) => /\.(wav|aiff?|mp3|m4a)$/i.test(f.name));
  if (!files.length) { toast('No audio files there.'); return; }
  for (const f of files) {
    const m = matchFile(f.name);
    sync.rows.push({ file: f, song: m.song || state.song?.slug || '', element: m.element, status: 'ready', note: '', progress: 0 });
  }
  markDuplicates(); renderUploadTable();
}
function markDuplicates() {
  const seen = new Map();
  for (const r of sync.rows) {
    if (r.status === 'duplicate') r.status = 'ready';
    if (!r.song || !r.element || ['done', 'skipped'].includes(r.status)) continue;
    const k = `${r.song}|${r.element}`;
    if (seen.has(k)) { r.status = 'duplicate'; seen.get(k).dup = true; } else seen.set(k, r);
  }
}
function renderUploadTable() {
  const box = $('#up-table'); if (!box) return;
  if (!sync.rows.length) { box.innerHTML = ''; return; }
  const songOpts = (v) => `<option value="">— song —</option>${state.songs.map((s) => `<option value="${esc(s.slug)}" ${s.slug === v ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;
  const elOpts = (v) => `<option value="">— skip this file —</option>${state.elements.map((e) => `<option value="${esc(e.slug)}" ${e.slug === v ? 'selected' : ''}>${esc(e.label)}</option>`).join('')}`;
  const stat = (r) => ({
    ready: r.song && r.element ? '<span class="muted">ready</span>' : '<span class="muted">will be skipped</span>',
    duplicate: '<span class="warnc">two files for this track — pick one</span>',
    working: `<div class="bar"><i style="width:${Math.round(r.progress * 100)}%"></i></div><span class="small muted">${esc(r.note)}</span>`,
    done: `<span class="ok">✓ ${esc(r.note || 'uploaded')}</span>`, skipped: `<span class="muted">${esc(r.note)}</span>`, error: `<span class="badc">${esc(r.note)}</span>`,
  }[r.status] || '');
  box.innerHTML = `<table class="tbl"><thead><tr><th>File</th><th>Song</th><th>Track</th><th>Status</th></tr></thead><tbody>${sync.rows.map((r, i) => `<tr>
    <td>${esc(r.file.name)}<br><span class="muted small">${mb(r.file.size)}</span></td>
    <td><select data-row="${i}" data-field="song" ${sync.busy ? 'disabled' : ''}>${songOpts(r.song)}</select></td>
    <td><select data-row="${i}" data-field="element" ${sync.busy ? 'disabled' : ''}>${elOpts(r.element)}</select></td>
    <td>${stat(r)}</td></tr>`).join('')}</tbody></table>
    <div class="row" style="margin-top:10px"><span class="spacer"></span><button class="btn" id="up-clear" ${sync.busy ? 'disabled' : ''}>Clear list</button><button class="btn primary" id="up-go" ${sync.busy ? 'disabled' : ''}>Upload ${sync.rows.filter((r) => r.status === 'ready' && r.song && r.element).length} files</button></div>`;
}

async function uploadAll() {
  if (sync.busy) return;
  sync.busy = true;
  const todo = sync.rows.filter((r) => r.status === 'ready' && r.song && r.element);
  for (const r of todo) {
    r.status = 'working'; r.progress = 0; r.note = 'checking…'; renderUploadTable();
    try { await uploadOne(r); } catch (e) { r.status = 'error'; r.note = e.message || String(e); }
    renderUploadTable();
  }
  sync.busy = false;
  await refreshAudioList(); renderSongChips();
  if (state.song) { pt.filesFor = null; }
  const ok = todo.filter((r) => r.status === 'done').length;
  toast(`${ok} file${ok === 1 ? '' : 's'} uploaded.`);
  renderSync();
}

async function uploadOne(r) {
  const song = state.songs.find((s) => s.slug === r.song);
  const isWav = /\.(wav|aiff?)$/i.test(r.file.name);
  const raw = await r.file.arrayBuffer();
  // decode once to check silence and length (and to convert)
  let decoded = null;
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    decoded = await new AC(2, 1, 44100).decodeAudioData(raw.slice(0));
  } catch { decoded = null; }
  if (decoded) {
    let peak = 0;
    for (let c = 0; c < decoded.numberOfChannels; c++) { const d = decoded.getChannelData(c); for (let i = 0; i < d.length; i += 7) { const a = Math.abs(d[i]); if (a > peak) peak = a; } }
    if (sync.skipSilent && peak < 0.0005) { r.status = 'skipped'; r.note = 'silent — skipped'; return; }
    const diff = Math.abs(decoded.duration - (song?.duration_seconds || decoded.duration));
    if (diff > 1.5) r.warn = `length ${fmt(decoded.duration)} vs song ${fmt(song.duration_seconds)} — lyrics may drift`;
  }
  let body = raw, ext = (/\.([a-z0-9]+)$/i.exec(r.file.name)?.[1] || 'mp3').toLowerCase();
  if (ext === 'aif' || ext === 'aiff') ext = 'wav';
  if (isWav && sync.convert && decoded) {
    r.note = 'converting to MP3…'; renderUploadTable();
    body = await encodeMp3(decoded, (p) => { r.progress = p * 0.6; renderUploadTableThrottled(); });
    ext = 'mp3';
  } else if (isWav && !/\.wav$/i.test(r.file.name)) throw new Error('AIFF needs conversion: tick “Convert to MP3”.');
  r.note = 'uploading…';
  const { put, content_type: ct } = await fn({ action: 'upload', song: r.song, element: r.element, ext });
  await new Promise((resolve, reject) => {
    const x = new XMLHttpRequest(); x.open('PUT', put); x.setRequestHeader('Content-Type', ct);
    const base = r.progress;
    x.upload.onprogress = (e) => { if (e.lengthComputable) { r.progress = base + (1 - base) * e.loaded / e.total; renderUploadTableThrottled(); } };
    x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(new Error(`upload failed (${x.status})`)));
    x.onerror = () => reject(new Error('upload failed (network)'));
    x.send(new Blob([body], { type: ct }));
  });
  await fn({ action: 'finalize', song: r.song, element: r.element, ext });
  r.status = 'done'; r.progress = 1; r.note = `${mb(body.byteLength ?? body.size)} ${ext}${r.warn ? ' · ⚠ ' + r.warn : ''}`;
}
let tableTimer = 0;
function renderUploadTableThrottled() { if (tableTimer) return; tableTimer = setTimeout(() => { tableTimer = 0; renderUploadTable(); }, 250); }

async function encodeMp3(buf, onProgress) {
  const { Mp3Encoder } = await import('./vendor/lamejs.js');
  const ch = Math.min(2, buf.numberOfChannels);
  const enc = new Mp3Encoder(ch, buf.sampleRate, 192);
  const L = buf.getChannelData(0), R = ch > 1 ? buf.getChannelData(1) : null;
  const toI16 = (f, a, b) => { const o = new Int16Array(b - a); for (let i = a; i < b; i++) { const s = Math.max(-1, Math.min(1, f[i])); o[i - a] = s < 0 ? s * 0x8000 : s * 0x7fff; } return o; };
  const out = []; const block = 1152 * 64;
  for (let i = 0; i < L.length; i += block) {
    const j = Math.min(L.length, i + block);
    const l = toI16(L, i, j), r = R ? toI16(R, i, j) : null;
    for (let k = 0; k < l.length; k += 1152) {
      const b = r ? enc.encodeBuffer(l.subarray(k, k + 1152), r.subarray(k, k + 1152)) : enc.encodeBuffer(l.subarray(k, k + 1152));
      if (b.length) out.push(new Uint8Array(b));
    }
    onProgress(j / L.length);
    await new Promise((res) => setTimeout(res, 0));   // keep the page responsive
  }
  const tail = enc.flush(); if (tail.length) out.push(new Uint8Array(tail));
  return new Blob(out, { type: 'audio/mpeg' }).arrayBuffer();
}

boot().catch((e) => { console.error(e); $('#boot').textContent = `Could not start: ${e.message}`; });
