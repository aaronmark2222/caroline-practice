# Caroline Practice

A small practice player for Caroline's students, cloned from the TSP Work band app and cut down to two pages:

- **Practice** (everyone): pick a song, play the **Mixdown** or the **Multitrack** (each track On/Off, Solo, volume; stems off by default), with AbleSet-style lyrics/chords running in time, full-screen lyrics, live key/BPM/bar, and **Group practice**: one device makes a room and plays the audio; other devices join with the 4-letter code and follow the lyrics in step (and can play/pause/seek/change song for everyone).
- **Ableton Sync** (admin only): read the `.als` (songs from **locators** — no Song IDs; lyrics from every `+LYRICS` track; sections from `SECTIONS`; tempo/key), and upload the exported audio (files are matched to song and track by name; WAV is converted to MP3 in the browser; silent tracks are skipped).

## How it is built
- Static site (`index.html`, `app.js`, `als.js`, `styles.css`) on GitHub Pages; no build step.
- **Supabase** project `hzvfrvjuqvmkeqbrgmqu` (shared with TSP Work, tables prefixed `cp_`): `cp_users` (who may sign in; role `admin`/`teacher`), `cp_songs` (one row per locator song, with lyrics JSON), `cp_meta` (`set`: the exportable tracks read from the set). RLS: members read, admin writes. Schema in `supabase/migrations/`.
- **Edge Function** `caroline-audio` (`supabase/functions/caroline-audio/`): signed R2 links (list, urls, upload, finalize, delete). R2 keys are the project's existing Edge Function secrets.
- **Cloudflare R2**: bucket `tsp-practice`, prefix `caroline/<song>/<track>.<mp3|m4a|wav>` (TSP Work only lists `songs/`, so the two never mix).
- Sign-in is stored under its own key (`cp-auth-v1`) so it never clashes with TSP Work on the same origin.
- `vendor/lamejs.js`: MP3 encoder (LGPL, see `vendor/LICENSE`).

## Adding a sign-in
Usernames map to `<username>@example.com`. Ask Claude (or run SQL as the admin) to create an auth user and a `cp_users` row.
