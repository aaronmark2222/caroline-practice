# Caroline Practice — App Plan (master document)

_Last reconciled: **2026-11-16** · cache markers `app.js?v=20261116-1`, `styles.css?v=20261116-1`, `als.js?v=20261116-1` · Supabase migration `caroline_practice_init` · Edge Function `caroline-audio` **v1** · published from branch `gh-pages`._

The single source of truth for resuming work on **Caroline Practice**, a side project of the TSP Band App (TSP Work). Read sections 0–4 before changing anything. Live code and databases win over this file; this file wins over memory.

---

## 0. How to use and update this file

**Resume checklist**
1. Read sections 0–4.
2. Check live state: `git log --oneline | head` on `aaronmark2222/caroline-practice` (`main` and `gh-pages` should point to the same commit); Supabase `list_migrations` / `list_tables` (project `hzvfrvjuqvmkeqbrgmqu`, tables `cp_*`); `list_edge_functions` (`caroline-audio`).
3. The Mac folder `/Users/aaron/Claude Folders/Caroline Practice` is a clone of the repo and must match it (`git status` clean, same HEAD).

**"Update App Plan" (Aaron's trigger phrase)** — same routine as TSP Work:
1. Commit and push everything to `main`, then publish: `git push origin main:gh-pages`.
2. Compare the live Supabase `cp_` schema and migrations with `supabase/migrations/`; save any missing SQL.
3. Compare the deployed `caroline-audio` source (`get_edge_function`) with `supabase/functions/caroline-audio/index.ts`.
4. Pull the Mac clone so it matches GitHub.
5. Update this file (header, changed sections, decision log, known issues, changelog), commit "Update App Plan (<date>)", push, publish, and copy it to the claude.ai Project doc `claude/CAROLINE_APP_PLAN.md`.
6. Tell Aaron in a few lines what changed.

---

## 1. What it is

A practice player for **Caroline**'s students, who are performing three songs at their **annual day**. Aaron (bassist / playback engineer of The String Project) built the Ableton practice project and is the admin. It is a deliberately cut-down clone of TSP Work: **no Song IDs, tasks, setlists, gigs or member tracker** — only:

1. **Practice** (everyone signed in): Mixdown or Multitrack playback with AbleSet-style lyrics, and **Group practice rooms** so one device plays the audio while other devices follow the lyrics in step.
2. **Ableton Sync** (admin only): read the `.als`, upload the exported audio.

Users: **Aaron** (admin, signs in with his TSP Work email/password) and **Caroline** (teacher, username `caroline`; she uses one sign-in on many devices). Students do not have accounts; they use Caroline's devices or a room.

## 2. Systems and data flow

```text
GitHub (public) aaronmark2222/caroline-practice ── gh-pages ──► https://aaronmark2222.github.io/caroline-practice/
                                                                       │  browser
Supabase hzvfrvjuqvmkeqbrgmqu (shared with TSP Work) ◄── Auth + PostgREST (RLS) ──┤
   tables cp_users, cp_songs, cp_meta                                             │
   Edge Fn caroline-audio (R2 keys = project secrets) ──presigned URLs──►         │◄── audio GET/PUT ── Cloudflare R2 bucket tsp-practice, prefix caroline/
   Realtime broadcast channels cp-room-<CODE> (group practice)                     │
Ableton set: /Users/aaron/Desktop/CAROLINE/Caroline Project/Caroline.als ── read in the browser on the Sync page (als.js)
```

- **Source of truth:** the `.als` for songs (locators), lyrics (`+LYRICS` tracks), sections (SECTIONS), tempo, keys, track colours and the list of exportable tracks; R2 for which audio exists (no audio table; `caroline-audio` lists the prefix); Supabase for users and the saved copy of the set data.
- **Isolation from TSP Work:** Caroline has no `members` row, so every TSP table returns nothing for her (checked). TSP Work's `practice-audio` only lists `songs/`, so the `caroline/` prefix never shows there. This app stores its sign-in under `localStorage['cp-auth-v1']` because both apps live on the origin `aaronmark2222.github.io`.

## 3. Locations and identifiers

| Thing | Value |
|---|---|
| Repo | `aaronmark2222/caroline-practice` (public). Workspace clone: `/home/claude/cp` |
| Mac folder | `/Users/aaron/Claude Folders/Caroline Practice` — a git clone of the repo, plus git-ignored `private/` (sign-ins, notes) |
| Live site | https://aaronmark2222.github.io/caroline-practice/ (Pages source: branch `gh-pages`, root) |
| Ableton project | `/Users/aaron/Desktop/CAROLINE/Caroline Project/Caroline.als` (Aaron saves it himself; the app never writes to it) |
| Supabase | project `hzvfrvjuqvmkeqbrgmqu`; publishable key in `app.js` (public by design) |
| Edge Function | `caroline-audio` (verify_jwt on): `list`, `urls {song}`, `upload {song, element, ext}` (admin), `finalize` (admin; removes other formats), `delete` (admin) |
| R2 | bucket `tsp-practice`, keys `caroline/<song-slug>/<element-slug>.<mp3|m4a|wav>`; CORS already allows the GitHub Pages origin |
| Usernames | `<username>` → `<username>@example.com` in Supabase Auth (no real email; no public sign-up) |

## 4. Standing rules

1. Keep it small: only Practice and Ableton Sync. No Song IDs, tasks, setlists or gigs unless Aaron asks.
2. Same working rules as TSP Work: install and commit straight away so Aaron can test; bump the `?v=` markers in `index.html` (and the `als.js` import in `app.js`) on every frontend change; `node --check` before pushing; publish with `git push origin main:gh-pages`; keep the Mac folder identical to GitHub.
3. Never put passwords, R2 keys or the service-role key in the repo. Sign-ins live in the Mac folder's `private/` only.
4. RLS is the security boundary: members (`cp_is_member()`) read, admin (`cp_is_admin()`) writes. Never weaken TSP Work's policies for this app.
5. Never modify the `.als`; warn Aaron about problems seen in it.
6. Explain things plainly; Aaron is not a programmer.

## 5. Database (`cp_` tables, all RLS)

| Table | Purpose |
|---|---|
| `cp_users` | `user_id` (auth.users), `name`, `role` `admin`/`teacher`. Read own row (admin reads all). Rows: Aaron (admin), Caroline (teacher) |
| `cp_songs` | `slug` (from the locator name), `name` (Title Case), `position`, `start_beat`, `end_beat`, `duration_seconds`, `bpm`, `song_key`, `lyrics` jsonb `{tracks:[{slug,label,color,lines:[{t,e,text,c}]}], sections:[{t,name,c}], tempo:[[sec,bpm]], keys:[{t,key}], sig:[num,den]}`, `hidden` (song no longer in the set) |
| `cp_meta` | `set` → `{elements:[{slug,name,label,group,kind,color}], als_name, read_at}` |

Functions `cp_is_member()`, `cp_is_admin()` (security definer, authenticated only). Schema: `supabase/migrations/20261116_caroline_practice_init.sql`.

## 6. Frontend

- No build step: `index.html`, `app.js` (ES module, supabase-js from esm.sh), `als.js` (set reader, also runs in Node with `@xmldom/xmldom`), `styles.css`, `vendor/lamejs.js` (MP3 encoder, LGPL).
- **Practice:** song chips; lyrics card (track chips, Group practice, text size S/M/L/XL, full screen with auto-hiding controls); bottom transport (song, Key, BPM, Bar.Beat, Mixdown/Multitrack, mixer, prev/start/play/stop/next, seek).
  - Mixdown streams through one `<audio>` element. Multitrack decodes each track into Web Audio (phones at 24 kHz; identical-channel tracks stored mono), plays them in step; tracks are decoded only when audible; downloads are kept in Cache Storage `cp-audio-v1` keyed by file version.
  - Mixer per track: On/Off, additive Solo (solo overrides off), volume −∞…+6 dB, meter. Stems off by default. Settings persist for the browser session (`sessionStorage cp-mixer`).
  - Lyrics: AbleSet syntax — `[X]` chord box, `[Key:] [C]` key line, `\` line break; a line sits under the section holding most of it; current line enlarges; eased autoscroll (paused 4 s after a manual scroll); click a line/section to seek. Default track: Lyrics (choice remembered per device).
  - Keyboard: Space play/pause, F full screen, ←/→ ±5 s. Lock screen controls via Media Session. Screen kept awake while playing or following.
- **Group practice:** `Make a room` → 4-character code; host broadcasts `{song,pos,at,playing,duration}` every 500 ms on `cp-room-<CODE>`; followers measure the clock offset by ping/pong (shortest round trip wins), show `synced ±N ms`, hold no audio, and send commands (play/pause/stop/seek/song) the host applies. Host leaving ends the room.
- **Ableton Sync (admin):** Read set (.als parsed in the browser: gunzip + DOMParser) → preview → Save (upserts songs, hides songs no longer present, saves elements). Practice audio grid per song with delete. Upload exports: drop files/folder; song matched by name in the file name, track by the trailing track name (`Main`/`Master`/`Mixdown` → Mixdown); dropdowns to correct; WAV/AIFF converted to MP3 192 kbps; silent files skipped; length checked against the set (±1.5 s); PUT to presigned R2 URL with progress, then `finalize`.

## 7. The Ableton set (as read 16 Nov 2026)

- Locators: LEAN ON ME (beat 0), ASHAYEIN (124), LOKADA KALAJI (628), SONG END (988). Tempo 75 / 115 / 140, 4/4.
- Songs: Lean On Me 1:39 (C), Ashayein 4:23 (A), Lokada Kalaji 2:34 (G).
- ABLESET +LYRICS: Guitar Chords, Keyboard Chords, Flute, Lyrics, Lead Guitar, Brass; SECTIONS.
- Exportable tracks (elements): STEMS VOCALS/DRUMS/BASS/OTHERS (stems), CPC PROMPTS/CLICK (cues), PARTS Piano (audio), Flute, Lead Guitar, Brass (MIDI); plus Mixdown. The top-level "Piano" MIDI track is ignored.
- Issues seen: Lokada Kalaji section "Insrumental" typo; PARTS Piano has audio only in Lean On Me.

## 8. Runbooks

- **Frontend change:** edit → `cp app.js /tmp/a.mjs && node --check /tmp/a.mjs` → bump `?v=` → commit → `git push origin main && git push origin main:gh-pages` → pull the Mac clone → check the live site.
- **Add a sign-in:** SQL as in the migration notes: insert into `auth.users` (bcrypt via `extensions.crypt`) and `auth.identities`, then `cp_users`; record it in the Mac `private/ACCESS.md`.
- **Reset Caroline's password:** `update auth.users set encrypted_password = extensions.crypt('<new>', extensions.gen_salt('bf')) where email = 'caroline@example.com';` (or she changes it in the app).
- **New set version:** Aaron uses Ableton Sync → Read set → Save; re-export and upload changed songs.

## 9. Testing habits

Headless Chrome (Playwright) with a fake supabase-js module (routes esm.sh) and generated tone MP3s covers playback, mixer, lyrics, full screen, the Sync page and two-page rooms (BroadcastChannel stand-in). Note: python's `http.server` has no Range support, so Mixdown seeking fails there but not on R2.

## 10. Known issues / not yet checked

- Real sign-in, real Supabase reads and the R2 upload have not yet been run end to end by a person (the Claude workspace cannot reach Supabase).
- No practice audio uploaded yet (Aaron exports and uploads).
- iPhone memory with many long multitrack tracks is untested; phones decode at 24 kHz and only audible tracks.

## 11. Decision log

- **2026-11-16:** Built as a separate public repo with Pages from `gh-pages`; shares TSP's Supabase project (so the existing R2 secrets work) with `cp_` tables and its own Edge Function; R2 under `caroline/` in the same bucket; songs from locators only; Aaron admin with his TSP login, Caroline as username `caroline`; Mac folder is a clone with a git-ignored `private/`.

## 12. Changelog of this plan

- **2026-11-16:** Created.
