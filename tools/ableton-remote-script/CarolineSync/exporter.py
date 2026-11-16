"""Caroline Practice exporter (copied from TSPWork's exporter.py, 16 Nov 2026).

This is a separate copy so the band's TSPWork is never touched. It drives
Live's own File > Export Audio/Video dialog exactly like TSPWork does; the
Caroline job (CarolineExportJob, at the end) decides which tracks to export.
The band-specific ExportJob above it is unused here but kept unchanged so the
rendering/upload machinery stays identical to the proven TSPWork code.
"""
"""Practice-audio export for TSPWork (agreed with Aaron, 7 Nov 2026).

For one song it renders, through Live's own File > Export Audio/Video dialog
(Rendered Track = Main, Encode MP3 on, Encode PCM off: set once by Aaron):

  * Stems     STEMS > BASS / DRUMS / OTHER / VOCALS
  * Parts     LIVE CHANNELS > <X> Live (fed by PARTS > <X> Part; Drums also by
              Drums Midi Part), so the part's track must be on
  * Backing   one file: for each of MUSIC / BACKING VOCALS / PERCUSSION / SFX,
              MIXED BACKING's track if it has clips in the song, otherwise the
              BACKING TRACKS group of that name
  * Clicks    CPC > CLICK Live (the click only)                (16 Nov 2026,
  * Prompts   CPC > PROMPTS + Vocal Prompts + Intro Que          replacing CPC;
              Backup Que and Loop are in neither)
  * Mixdown   Parts + Backing + Clicks + Prompts, with STEMS filling gaps: DRUMS if no drum
              part, OTHER if no guitar and no keyboard part, BASS if no bass
              part, VOCALS unless every vocal part is Completed in TSP Work

Each element is rendered by soloing its tracks and exporting Main over the
song's range (loop brace + Edit > Select Loop). Every solo, track on/off state,
the loop brace, the selected track and the playhead are put back afterwards.
The Live set is never saved.
"""
import os
import re
import subprocess
import threading
import time
try:
    import queue
except ImportError:  # pragma: no cover
    import Queue as queue

EXPORT_ROOT = os.path.expanduser('~/Desktop/CAROLINE/Caroline Exports')
UPLOAD_TMP = os.path.join('/tmp', 'carolinesync-upload')
AAC_BITRATE = 128000

STEMS = [('BASS', 'Bass'), ('DRUMS', 'Drums'), ('OTHER', 'Other'), ('VOCALS', 'Vocals')]
# key, label, PARTS source track names, LIVE CHANNELS track, TSP Work task key
PARTS = [
    ('bass', 'Bass', ['Bass Part'], 'BASS Live', 'bass_part'),
    ('keyboard', 'Keyboard', ['Keyboard Part'], 'KEYBOARD Live', 'keyboard_part'),
    ('guitar', 'Guitar', ['Guitar Part'], 'GUITAR Live', 'guitar_part'),
    ('violin', 'Violin', ['Violin Part'], 'VIOLIN Live', 'violin_part'),
    ('percussion', 'Percussion', ['Percussion Part'], 'PERCUSSION Live', 'percussion_part'),
    ('drums', 'Drums', ['Drums Part', 'Drums Midi Part'], 'DRUMS Live', 'drums_part'),
    ('dale', 'Dale Vox', ['Dale Vox Part'], 'DALE VOX Live', 'vox_dale'),
    ('anston', 'Anston Vox', ['Anston Vox Part'], 'ANSTON VOX Live', 'vox_anston'),
]
BACKING = ['MUSIC', 'BACKING VOCALS', 'PERCUSSION', 'SFX']
# PARTS tracks that must be soloed too (not just on): Drums Midi Part only
# feeds Drums Part (which feeds DRUMS Live) when it is soloed itself.
EXTRA_SOLO = {'drums': ['Drums Midi Part']}
# The CPC group split into two practice files (Aaron, 16 Nov 2026). Track names
# are matched by their start ('CLICK Live +CLICK', 'PROMPTS +GUIDE', ...).
CLICK_TRACKS = ['CLICK Live']
PROMPT_TRACKS = ['PROMPTS', 'Vocal Prompts', 'Intro Que']
# A track is exported only if it has an active (not deactivated) clip with at
# least this much inside the song; muted-only or sliver-only tracks are skipped.
MIN_CLIP_BEATS = 0.25
# A part with less than this much active audio in the song (in beats; 16 = 4
# bars of 4/4) is a stray clip and counts as missing: no part file, and its
# stem fills the mixdown. Measured on the set (7 Nov 2026): strays are one
# clip of 3-8 beats; the shortest real parts (e.g. a violin lead) are 20+.
MIN_PART_BEATS = 16.0

# Fixed AppleScripts: data (folder, file name) is passed as arguments, never
# pasted into the script text.
OPEN_AND_EXPORT = '''
on run argv
    set folderPath to item 1 of argv
    set fileName to item 2 of argv
    tell application "System Events"
        set p to first application process whose bundle identifier is "com.ableton.live"
        set frontmost of p to true
        delay 0.3
        if not (frontmost of p) then return "not_front"
        tell p
            set fm to menu 1 of menu bar item "File" of menu bar 1
            set items_ to (menu items of fm whose name starts with "Export Audio")
            if (count of items_) is 0 then return "no_export_item"
            click item 1 of items_
        end tell
        -- Live's own dialogs are not always in "windows"; look at every
        -- top-level element, and inside only small windows (the dialog is
        -- ~300 px wide), so the big main window is never searched.
        set dlg to missing value
        set exportButton to missing value
        set seen to ""
        repeat 60 times
            delay 0.15
            set cands to {}
            tell p
                try
                    set cands to cands & (windows)
                end try
                try
                    set cands to cands & (UI elements whose role is "AXWindow")
                end try
            end tell
            set seen to ""
            repeat with w in cands
                try
                    set sz to size of w
                    set seen to seen & (item 1 of sz as text) & "x" & (item 2 of sz as text) & " "
                    if (item 1 of sz) < 600 then
                        set hits to {}
                        try
                            set hits to (buttons of group 1 of w whose name is "Export")
                        end try
                        if (count of hits) is 0 then
                            try
                                set hits to (buttons of group 1 of w whose title is "Export")
                            end try
                        end if
                        if (count of hits) is 0 then
                            try
                                set allEls to entire contents of w
                                repeat with el in allEls
                                    try
                                        if role of el is "AXButton" and (name of el is "Export" or title of el is "Export" or description of el is "Export") then
                                            set hits to {el}
                                            exit repeat
                                        end if
                                    end try
                                end repeat
                            end try
                        end if
                        if (count of hits) > 0 then
                            set dlg to w
                            set exportButton to item 1 of hits
                            exit repeat
                        end if
                    end if
                end try
            end repeat
            if dlg is not missing value then exit repeat
        end repeat
        if dlg is missing value then return "no_export_dialog (windows: " & seen & ")"
        set chooser to ""
        try
            set chooser to value of (first pop up button of group 1 of dlg whose description is "Rendered Track Chooser")
        end try
        if chooser is "" then
            try
                set chooser to value of pop up button 1 of group 1 of dlg
            end try
        end if
        if chooser is not "" and chooser is not "Main" then
            try
                click (first button of group 1 of dlg whose name is "Cancel")
            end try
            return "chooser_not_main:" & chooser
        end if
        ignoring application responses
            click exportButton
        end ignoring
        set savePanel to missing value
        repeat 80 times
            delay 0.1
            tell p
                if exists window "Save" then
                    set savePanel to window "Save"
                    exit repeat
                end if
            end tell
        end repeat
        if savePanel is missing value then return "no_save_panel"
        delay 0.3
        keystroke "g" using {command down, shift down}
        delay 0.6
        keystroke folderPath
        delay 0.3
        key code 36
        delay 1.0
        keystroke "a" using command down
        delay 0.3
        keystroke fileName
        delay 0.4
        key code 36
    end tell
    return "ok"
end run
'''

CLOSE_DIALOGS = '''
tell application "System Events"
    set p to first application process whose bundle identifier is "com.ableton.live"
    tell p
        if exists window "Save" then
            try
                click button "Cancel" of window "Save"
            end try
            delay 0.5
        end if
        repeat with w in (UI elements whose role is "AXWindow")
            try
                if (item 1 of (size of w as list)) < 600 then
                    repeat with el in (entire contents of w)
                        try
                            if role of el is "AXButton" and name of el is "Cancel" then
                                click el
                                exit repeat
                            end if
                        end try
                    end repeat
                end if
            end try
        end repeat
    end tell
end tell
return "ok"
'''

ZOOM_SELECTION = '''
tell application "System Events"
    set p to first application process whose bundle identifier is "com.ableton.live"
    tell p
        set viewMenu to menu 1 of menu bar item "View" of menu bar 1
        set zoomItems to (menu items of viewMenu whose name contains "Time Selection")
        if (count of zoomItems) is 0 then return "no_zoom_item"
        if not (enabled of item 1 of zoomItems) then return "zoom_disabled"
        click item 1 of zoomItems
    end tell
end tell
return "ok"
'''

SELECT_LOOP = '''
tell application "System Events"
    set p to first application process whose bundle identifier is "com.ableton.live"
    set frontmost of p to true
    delay 0.2
    tell p
        set editMenu to menu 1 of menu bar item "Edit" of menu bar 1
        set selectItems to (menu items of editMenu whose name contains "Select Loop")
        if (count of selectItems) is 0 then return "no_select_loop"
        click item 1 of selectItems
    end tell
end tell
return "ok"
'''


def osascript(script, *args, timeout=40):
    try:
        out = subprocess.run(['/usr/bin/osascript', '-e', script] + [str(a) for a in args],
                             capture_output=True, text=True, timeout=timeout)
    except Exception as err:
        return 'osascript_failed: %s' % err
    if out.returncode != 0:
        err = (out.stderr or '').strip()
        if '-1719' in err or '-25211' in err or 'assistive' in err.lower() or 'not allowed' in err.lower():
            return 'accessibility_needed'
        return 'osascript_error: %s' % err[:200]
    return (out.stdout or '').strip()


LIVE_RESPONDS = '''
tell application "System Events"
    set p to first application process whose bundle identifier is "com.ableton.live"
    return (count of windows of p) as text
end tell
'''


def wait_for_live(max_wait=600):
    """After a long render Live can ignore UI scripting for a while; wait
    until it answers again (True) or give up after max_wait seconds."""
    started = time.time()
    while time.time() - started < max_wait:
        out = osascript(LIVE_RESPONDS, timeout=20)
        if out and out[0].isdigit():
            return True
        time.sleep(5)
    return False


def safe_name(text):
    text = re.sub(r'[\\/:*?"<>|]+', ' ', str(text or '')).strip()
    return re.sub(r'\s+', ' ', text)[:80] or 'Song'


class ExportJob(object):
    def __init__(self, surface, songs, root=None, uploads=None):
        """songs: [{'song_id', 'song_name', 'vocals_complete', 'instrumental'}],
        exported one after another in this order, into `root` (default
        ~/Music/TSP Exports). uploads: {song_id: {element: {'put', 'del'}}}
        signed R2 links; each file is uploaded as soon as it is exported, in
        a separate thread, while the next one renders."""
        self.s = surface
        self.songs = songs
        self.root = root or EXPORT_ROOT
        self.uploads = uploads or {}
        self.upload_queue = queue.Queue()
        self.upload_thread = None
        self.caffeinate = None
        self.state = {'state': 'starting', 'song_id': songs[0]['song_id'], 'done': [], 'skipped': [],
                      'current': None, 'total': 0, 'error': None, 'folder': None,
                      'queue': [x['song_id'] for x in songs], 'song_index': 0, 'results': [],
                      'root': root or EXPORT_ROOT, 'upload': bool(uploads),
                      'uploaded': 0, 'upload_failed': [], 'upload_pending': 0, 'uploaded_bytes': 0,
                      'started_at': time.time()}
        self._saved = None
        self.cancelled = False
        self.stop_after_song = False  # set by TSPWork 1.17's /export/cancel {after_song: true}
        self.thread = threading.Thread(target=self.run, name='CarolineSyncExport')
        self.thread.daemon = True

    def _folder_name(self):
        return safe_name('%s %s' % (self.song_id, self.song_name))

    def _file_base(self, label):
        return safe_name('%s - %s' % (self.song_id, label))

    def _select_song(self, song):
        self.song_id = song['song_id']
        self.song_name = song.get('song_name', '')
        self.vocals_complete = set(song.get('vocals_complete') or [])
        self.instrumental = bool(song.get('instrumental'))   # 'I' songs: no vocals in the mixdown

    # ------------------------------------------------------------ track helpers (main thread)
    def _tracks(self):
        return list(self.s.song().tracks)

    def _named(self, name, ancestor=None):
        for t in self._tracks():
            if t.name.strip() != name:
                continue
            if ancestor is None:
                return t
            parent = t.group_track
            while parent is not None:
                if parent.name.strip() == ancestor:
                    return t
                parent = parent.group_track
        return None

    def _starting(self, prefix, ancestor):
        # A track inside `ancestor` whose name starts with `prefix` (word-wise).
        for t in self._tracks():
            name = t.name.strip()
            if name != prefix and not name.startswith(prefix + ' '):
                continue
            parent = t.group_track
            while parent is not None:
                if parent.name.strip() == ancestor:
                    return t
                parent = parent.group_track
        return None

    def _has_clips(self, track, s, e):
        if track is None:
            return False
        pool = self.s._descendants(track) if getattr(track, 'is_foldable', False) else [track]
        for t in pool:
            try:
                for c in t.arrangement_clips:
                    # Only active clips count, and only if more than a sliver of
                    # them (a quarter beat) falls inside the song.
                    if c.muted:
                        continue
                    if min(e, c.end_time) - max(s, c.start_time) >= MIN_CLIP_BEATS:
                        return True
            except Exception:
                continue
        return False

    def _coverage(self, tracks, s, e):
        spans = []
        for track in tracks:
            pool = self.s._descendants(track) if getattr(track, 'is_foldable', False) else [track]
            for t in pool:
                try:
                    for c in t.arrangement_clips:
                        if not c.muted:
                            a, b = max(s, c.start_time), min(e, c.end_time)
                            if b - a >= MIN_CLIP_BEATS:
                                spans.append((a, b))
                except Exception:
                    continue
        total, end = 0.0, s
        for a, b in sorted(spans):
            if b <= end:
                continue
            total += b - max(a, end)
            end = b
        return total

    def _ancestors(self, track):
        out = []
        parent = track.group_track
        while parent is not None:
            out.append(parent)
            parent = parent.group_track
        return out

    # ------------------------------------------------------------ planning (main thread)
    def plan(self):
        region = self.s._song_region(self.song_id)
        if region is None:
            return {'ok': False, 'error': 'song_not_found'}
        s, e = region
        elements = []   # (file label, [tracks to solo], [tracks that must be on])
        stems = {}
        for name, label in STEMS:
            t = self._named(name, 'STEMS')
            if self._has_clips(t, s, e):
                stems[name] = t
                elements.append(('Stem - %s' % label, [t], [t]))
        parts = {}
        for key, label, sources, live_name, task_key in PARTS:
            src = [x for x in (self._named(n, 'PARTS') for n in sources) if x is not None]
            live = self._named(live_name, 'LIVE CHANNELS')
            if live is None or not any(self._has_clips(x, s, e) for x in src):
                continue
            if self._coverage(src, s, e) < MIN_PART_BEATS:
                self.state['skipped'].append('Part - %s (only stray clips)' % label)
                continue
            extra = [x for x in src if x.name.strip() in EXTRA_SOLO.get(key, [])]
            parts[key] = (live, src, task_key, extra)
            elements.append(('Part - %s' % label, [live] + extra, [live] + src))
        backing = []
        for comp in BACKING:
            mixed = self._named(comp, 'MIXED BACKING')
            if self._has_clips(mixed, s, e):
                backing.append(mixed)
                continue
            group = self._named(comp, 'BACKING TRACKS')
            if self._has_clips(group, s, e):
                backing.append(group)
        if backing:
            elements.append(('Backing', backing, list(backing)))
        cpc = self._named('CPC')
        backup = self._named('Backup Que', 'CPC')
        clicks = [t for t in (self._starting(n, 'CPC') for n in CLICK_TRACKS) if self._has_clips(t, s, e)]
        prompts = [t for t in (self._starting(n, 'CPC') for n in PROMPT_TRACKS) if self._has_clips(t, s, e)]
        group_on = [cpc] if cpc is not None else []
        if clicks:
            elements.append(('Clicks', clicks, clicks + group_on))
        if prompts:
            elements.append(('Prompts', prompts, prompts + group_on))
        # Mixdown: parts + backing + clicks + prompts, STEMS only to fill gaps.
        mix, need_on = [], []
        for key in parts:
            if key in ('dale', 'anston'):
                continue
            live, src, _, extra = parts[key]
            mix += [live] + extra
            need_on += [live] + src
        vocal_parts = [parts[k] for k in ('dale', 'anston') if k in parts]
        vocals_done = bool(vocal_parts) and all(p[2] in self.vocals_complete for p in vocal_parts)
        if vocals_done:
            for live, src, _, extra in vocal_parts:
                mix += [live] + extra
                need_on += [live] + src
        fill = []
        if 'drums' not in parts:
            fill.append('DRUMS')
        if 'guitar' not in parts and 'keyboard' not in parts:
            fill.append('OTHER')
        if 'bass' not in parts:
            fill.append('BASS')
        if not vocals_done and not self.instrumental:
            fill.append('VOCALS')
        for name in fill:
            if name in stems:
                mix.append(stems[name])
                need_on.append(stems[name])
        mix += backing
        need_on += backing
        mix += clicks + prompts
        need_on += clicks + prompts + (group_on if clicks or prompts else [])
        if mix:
            elements.append(('Mixdown', mix, need_on))
        self.region = region
        self.elements = elements
        self.backup = backup
        self.mix_notes = {'stems_used': [n for n in fill if n in stems], 'vocal_parts_used': vocals_done,
                          'instrumental': self.instrumental}
        return {'ok': True, 'elements': [el[0] for el in elements]}

    def save_state(self):
        song = self.s.song()
        all_tracks = list(song.tracks) + list(song.return_tracks)
        self._saved = {
            'solo': [(t, t.solo) for t in all_tracks],
            'mute': [(t, t.mute) for t in all_tracks],
            'loop': (song.loop_start, song.loop_length, song.loop),
            'selected': song.view.selected_track,
            'time': song.current_song_time,
        }
        if song.is_playing:
            song.stop_playing()
        if self.backup is not None:
            self.backup.mute = True
        return {'ok': True}

    def restore_state(self):
        if not self._saved:
            return {'ok': True}
        song = self.s.song()
        sv = self._saved
        for t, v in sv['solo']:
            try:
                if t.solo != v:
                    t.solo = v
            except Exception:
                pass
        for t, v in sv['mute']:
            try:
                if t.mute != v:
                    t.mute = v
            except Exception:
                pass
        ls, ll, lo = sv['loop']
        song.loop_start, song.loop_length, song.loop = ls, ll, lo
        try:
            if sv['selected'] is not None:
                song.view.selected_track = sv['selected']
        except Exception:
            pass
        song.current_song_time = sv['time']   # also clears the time selection
        self._saved = None
        return {'ok': True}

    def setup_element(self, index):
        label, solo, need_on = self.elements[index]
        song = self.s.song()
        targets = list(solo)
        for t in list(song.tracks) + list(song.return_tracks):
            want = any(t == x for x in targets)
            try:
                if t.solo != want:
                    t.solo = want
            except Exception:
                pass
        for t in need_on:
            for x in [t] + self._ancestors(t):
                try:
                    if x.mute:
                        x.mute = False
                except Exception:
                    pass
        if self.backup is not None:
            self.backup.mute = True
        s, e = self.region
        song.loop_start = s
        song.loop_length = e - s
        song.current_song_time = s
        self.s._unfold_parents(solo[0])
        song.view.selected_track = solo[0]
        view = self.s.application().view
        view.show_view('Arranger')
        view.focus_view('Arranger')
        return {'ok': True}

    # ------------------------------------------------------------ the job (worker thread)
    def _main(self, fn, *args):
        result = self.s._run_on_main(fn, *args, timeout=8.0)
        if not result or not result.get('ok'):
            raise RuntimeError((result or {}).get('error') or (result or {}).get('detail') or 'live_timeout')
        return result

    def _new_file(self, folder, before):
        return any(not f.startswith('.') and f not in before and os.path.isfile(os.path.join(folder, f))
                   for f in os.listdir(folder))

    def _wait_for_file(self, folder, base, before, timeout=900):
        """Wait for the new audio file to appear and stop growing. Typed file
        names can lose characters, so any new file in the folder counts; it
        is then renamed to the intended name."""
        started = time.time()
        last, stable, found = -1, 0, None
        while time.time() - started < timeout:
            time.sleep(1.0)
            if self.cancelled:
                raise RuntimeError('cancelled')
            new = [f for f in os.listdir(folder)
                   if not f.startswith('.') and f not in before and os.path.isfile(os.path.join(folder, f))]
            if not new:
                continue
            found = sorted(new, key=lambda f: os.path.getmtime(os.path.join(folder, f)))[-1]
            size = os.path.getsize(os.path.join(folder, found))
            if size > 0 and size == last:
                stable += 1
                if stable >= 4:
                    ext = os.path.splitext(found)[1] or '.mp3'
                    target = base + ext
                    if found != target:
                        if os.path.exists(os.path.join(folder, target)):
                            os.remove(os.path.join(folder, target))
                        os.rename(os.path.join(folder, found), os.path.join(folder, target))
                    return target
            else:
                stable = 0
            last = size
        raise RuntimeError('export_timeout (no new file in %s; check the Save window)' % folder)

    def _export_song(self):
        st = self.state
        plan = self._main(self.plan)
        folder = os.path.join(self.root, self._folder_name())
        os.makedirs(folder, exist_ok=True)
        st.update({'state': 'running', 'folder': folder, 'total': len(plan['elements']),
                   'elements': plan['elements'], 'mix': self.mix_notes, 'done': []})
        if self._saved is None:
            self._main(self.save_state)
        # Clean up a file left with a damaged name by an earlier run.
        for f in os.listdir(folder):
            if f.startswith(' - ') or f.startswith('- '):
                os.remove(os.path.join(folder, f))
        # Show the song first (zoomed to its whole range) so it's visible
        # which song is being exported.
        if self.elements:
            self._main(self.setup_element, 0)
            time.sleep(0.3)
            if osascript(SELECT_LOOP) == 'ok':
                time.sleep(0.3)
                osascript(ZOOM_SELECTION)
            time.sleep(1.0)
        for i, (label, _, _) in enumerate(self.elements):
            if self.cancelled:
                raise RuntimeError('cancelled')
            base = self._file_base(label)
            st['current'] = label
            file_started = time.time()
            for f in os.listdir(folder):
                if f.startswith(base + '.'):
                    os.remove(os.path.join(folder, f))
            before = set(os.listdir(folder))
            self._main(self.setup_element, i)
            time.sleep(0.3)
            out = osascript(SELECT_LOOP)
            if out != 'ok':
                raise RuntimeError(out)
            time.sleep(0.3)
            # Live may still be busy finishing the previous (long) file and not
            # answer UI scripting yet: wait for it, and retry the dialog.
            out = ''
            for attempt in range(3):
                if attempt:
                    if self._new_file(folder, before):
                        out = 'ok'  # the export went ahead despite the timeout
                        break
                    osascript(CLOSE_DIALOGS, timeout=60)
                    wait_for_live()
                    time.sleep(3)
                    self._main(self.setup_element, i)
                    time.sleep(0.3)
                    if osascript(SELECT_LOOP) != 'ok':
                        continue
                    time.sleep(0.3)
                out = osascript(OPEN_AND_EXPORT, folder, base, timeout=150)
                if out == 'ok' or out in ('accessibility_needed',):
                    break
                st['retries'] = st.get('retries', 0) + 1
            if out != 'ok':
                raise RuntimeError(out)
            name = self._wait_for_file(folder, base, before)
            st['done'].append({'label': label, 'file': name, 'seconds': round(time.time() - file_started, 1)})
            self._queue_upload(label, os.path.join(folder, name))
        st['current'] = None
        # Files from an earlier export that this run no longer makes (e.g. a
        # stray part) are removed from the band app too.
        links = self.uploads.get(self.song_id) or {}
        made = set(el[0] for el in self.elements)
        for label, link in links.items():
            if label in made:
                continue
            for key in ('del', 'del_old'):
                if link.get(key):
                    self.upload_queue.put(('delete', self.song_id, label, None, link[key]))
                    st['upload_pending'] += 1

    # ------------------------------------------------------------ uploads (own thread)
    def _queue_upload(self, label, path):
        link = (self.uploads.get(self.song_id) or {}).get(label)
        if not link or not link.get('put'):
            return
        self.state['upload_pending'] += 1
        self.upload_queue.put(('put', self.song_id, label, path, link['put'], link.get('del_old')))

    def _upload_worker(self):
        st = self.state
        while True:
            job = self.upload_queue.get()
            if job is None:
                return
            kind, song_id, label, path, url = job[:5]
            del_old = job[5] if len(job) > 5 else None
            tmp = None
            try:
                if kind == 'put':
                    # The band app gets AAC 128 kbps (~40% of the 320 kbps MP3):
                    # macOS's own afconvert, so nothing to install.
                    tmp = os.path.join(UPLOAD_TMP, '%s-%d.m4a' % (re.sub(r'[^A-Za-z0-9]+', '-', '%s %s' % (song_id, label)), int(time.time() * 1000)))
                    os.makedirs(UPLOAD_TMP, exist_ok=True)
                    conv = subprocess.run(['/usr/bin/afconvert', '-f', 'm4af', '-d', 'aac', '-b', str(AAC_BITRATE), '-s', '0', path, tmp],
                                          capture_output=True, text=True, timeout=600)
                    if conv.returncode != 0 or not os.path.exists(tmp):
                        raise RuntimeError('convert failed: ' + (conv.stderr or '').strip()[:120])
                    cmd = ['/usr/bin/curl', '-sS', '-f', '--retry', '3', '--retry-delay', '5', '-X', 'PUT',
                           '-H', 'Content-Type: audio/mp4', '-T', tmp, url]
                else:
                    cmd = ['/usr/bin/curl', '-sS', '-f', '--retry', '2', '-X', 'DELETE', url]
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
                if out.returncode != 0:
                    raise RuntimeError((out.stderr or 'curl %d' % out.returncode).strip()[:160])
                if kind == 'put':
                    st['uploaded'] += 1
                    st['uploaded_bytes'] += os.path.getsize(tmp)
                    if del_old:   # an older MP3 of the same track: remove it (no duplicates)
                        subprocess.run(['/usr/bin/curl', '-sS', '-X', 'DELETE', del_old], capture_output=True, timeout=120)
            except Exception as err:
                st['upload_failed'].append({'song_id': song_id, 'label': label, 'error': str(err)[:160]})
            finally:
                st['upload_pending'] = max(0, st['upload_pending'] - 1)
                if tmp and os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except Exception:
                        pass

    def _keep_awake(self, on):
        # Stops the Mac idle-sleeping during an overnight run (screen may sleep).
        try:
            if on and self.caffeinate is None:
                # -d keeps the display on too: a locked screen can block the UI
                # scripting that drives Live's Export dialog overnight.
                self.caffeinate = subprocess.Popen(['/usr/bin/caffeinate', '-d', '-i', '-s', '-w', str(os.getpid())])
            elif not on and self.caffeinate is not None:
                self.caffeinate.terminate()
                self.caffeinate = None
        except Exception:
            self.caffeinate = None

    def run(self):
        st = self.state
        self._keep_awake(True)
        if self.uploads:
            self.upload_thread = threading.Thread(target=self._upload_worker, name='CarolineSyncUpload')
            self.upload_thread.daemon = True
            self.upload_thread.start()
        try:
            for index, song in enumerate(self.songs):
                if self.cancelled:
                    st['results'].append({'song_id': song['song_id'], 'state': 'cancelled', 'files': 0})
                    continue
                if self.stop_after_song:
                    # Stopped by Aaron after the previous song: the rest are left for another run.
                    st['results'].append({'song_id': song['song_id'], 'state': 'stopped', 'files': 0})
                    continue
                song_started = time.time()
                self._select_song(song)
                st.update({'song_index': index, 'song_id': self.song_id, 'error': None,
                           'done': [], 'skipped': [], 'total': 0, 'current': None, 'folder': None,
                           'song_started_at': song_started})
                try:
                    try:
                        self._export_song()
                    except Exception as first:
                        if self.cancelled or 'accessibility' in str(first) or 'export_folder' in str(first):
                            raise
                        # One fresh try of the whole song after a hiccup (e.g. Live
                        # not answering after a long render).
                        st['song_retries'] = st.get('song_retries', 0) + 1
                        osascript(CLOSE_DIALOGS, timeout=60)
                        wait_for_live()
                        time.sleep(5)
                        st.update({'done': [], 'skipped': [], 'current': None,
                                   'last_error': str(first)[:200]})
                        self._export_song()
                    st['results'].append({'song_id': self.song_id, 'state': 'done', 'files': len(st['done']),
                                          'skipped': list(st['skipped']),
                                          # timing, logged by the app for time-left estimates
                                          'started_at': song_started, 'finished_at': time.time(),
                                          'seconds': round(time.time() - song_started, 1),
                                          'file_seconds': [[d['label'], d.get('seconds')] for d in st['done']]})
                except Exception as err:
                    st['error'] = str(err)[:300]
                    st['results'].append({'song_id': self.song_id, 'state': 'error', 'files': len(st['done']),
                                          'error': st['error'], 'started_at': song_started, 'finished_at': time.time(),
                                          'seconds': round(time.time() - song_started, 1)})
                    osascript(CLOSE_DIALOGS, timeout=20)  # don't leave Export/Save open
            # Unattended runs: give each song that failed one last try at the end.
            for pos, r in enumerate(list(st['results'])):
                if r['state'] != 'error' or self.cancelled or self.stop_after_song:
                    continue
                song = next((x for x in self.songs if x['song_id'] == r['song_id']), None)
                if song is None:
                    continue
                osascript(CLOSE_DIALOGS, timeout=60)
                wait_for_live()
                time.sleep(5)
                song_started = time.time()
                self._select_song(song)
                st.update({'song_index': self.songs.index(song), 'song_id': self.song_id, 'error': None,
                           'done': [], 'skipped': [], 'total': 0, 'current': None, 'folder': None,
                           'song_started_at': song_started, 'final_retry': True})
                try:
                    self._export_song()
                    st['results'][pos] = {'song_id': self.song_id, 'state': 'done', 'files': len(st['done']),
                                          'skipped': list(st['skipped']), 'retried': True,
                                          'started_at': song_started, 'finished_at': time.time(),
                                          'seconds': round(time.time() - song_started, 1),
                                          'file_seconds': [[d['label'], d.get('seconds')] for d in st['done']]}
                except Exception as err:
                    r['error'] = ('%s (retried: %s)' % (r.get('error', ''), str(err)[:120]))[:300]
                    osascript(CLOSE_DIALOGS, timeout=20)
                st['final_retry'] = False
            failed = [r for r in st['results'] if r['state'] not in ('done', 'stopped')]
            st['stopped_early'] = any(r['state'] == 'stopped' for r in st['results'])
            st['state'] = 'error' if failed else 'done'
            if failed and not st.get('error'):
                st['error'] = '%d song(s) not exported' % len(failed)
        except Exception as err:
            st['state'] = 'error'
            st['error'] = str(err)[:300]
        finally:
            try:
                self.s._run_on_main(self.restore_state, timeout=10.0)
            except Exception:
                pass
            st['current'] = None
            if self.upload_thread is not None:
                # Ableton is done; let the last uploads finish.
                final = st['state']
                st['state'] = 'uploading'
                self.upload_queue.put(None)
                self.upload_thread.join(timeout=3600)
                st['state'] = 'error' if (final == 'error' or st['upload_failed']) else 'done'
                if st['upload_failed'] and not st.get('error'):
                    st['error'] = '%d upload(s) failed' % len(st['upload_failed'])
            self._keep_awake(False)
            st['finished_at'] = time.time()
            self.s._export_finished(self)


# After a song delete renumbers its family in TSP Work, the export folders on
# the drive still carry the old IDs ("E6 Song/E6 - Mixdown.mp3"). This renames
# them to match. Nothing is deleted: the deleted song's folder goes into
# "_Deleted songs" in the same export folder. Moves run in ascending order, so
# each new name is free by the time it is used. Returns what was done.
def renumber_exports(root, deleted_id, moves):
    done = []
    if not root or not os.path.isdir(root):
        # The drive isn't plugged in: report it, so the app tries again later.
        return {'ok': False, 'error': 'export_folder_missing', 'renamed': done}
    id_re = re.compile(r'^[A-Z][A-Za-z]*\d+$')
    def folders_for(song_id):
        return [f for f in sorted(os.listdir(root))
                if os.path.isdir(os.path.join(root, f)) and (f == song_id or f.startswith(song_id + ' '))]
    if deleted_id and id_re.match(deleted_id):
        trash = os.path.join(root, '_Deleted songs')
        for f in folders_for(deleted_id):
            os.makedirs(trash, exist_ok=True)
            target = os.path.join(trash, '%s (deleted %s)' % (f, time.strftime('%Y-%m-%d %H%M')))
            os.rename(os.path.join(root, f), target)
            done.append({'from': f, 'to': os.path.join('_Deleted songs', os.path.basename(target))})
    for move in moves or []:
        old, new, name = str(move.get('from', '')), str(move.get('to', '')), str(move.get('name', ''))
        if not (id_re.match(old) and id_re.match(new)):
            continue
        for f in folders_for(old):
            folder = os.path.join(root, f)
            for g in os.listdir(folder):
                if g.startswith(old + ' - '):
                    os.rename(os.path.join(folder, g), os.path.join(folder, new + g[len(old):]))
            target_name = safe_name('%s %s' % (new, name)) if name else new + f[len(old):]
            target = os.path.join(root, target_name)
            if os.path.exists(target):
                target = os.path.join(root, target_name + ' (renumbered)')
            os.rename(folder, target)
            done.append({'from': f, 'to': os.path.basename(target)})
    return {'ok': True, 'renamed': done}


class CarolineExportJob(ExportJob):
    """Songs are the regions between locators (sent by the app); every track
    the app lists (children of STEMS / CPC / PARTS) is exported on its own when
    it has clips in the song, plus a Mixdown of those tracks as they are
    switched on in the set. Uploads are keyed by the app's track slugs."""

    def __init__(self, surface, songs, root, uploads, elements):
        ExportJob.__init__(self, surface, songs, root, uploads)
        self.element_specs = elements
        self.state['profile'] = 'caroline'

    def _select_song(self, song):
        self.song_id = song['song_id']
        self.song_name = song.get('song_name', '')
        self.song_region = (song['start'], song['end'])
        self.locator = song.get('locator', '')
        self.vocals_complete = set()
        self.instrumental = False

    def _folder_name(self):
        return safe_name(self.song_name or self.song_id)

    def _file_base(self, label):
        spec = next((e for e in self.element_specs if e['slug'] == label), None)
        nice = (spec or {}).get('label') or ('Mixdown' if label == 'mixdown' else label)
        return safe_name('%s - %s' % (self.song_name or self.song_id, nice))

    def _find(self, name, group):
        name, group = name.strip().lower(), group.strip().lower()
        for t in self._tracks():
            if t.name.strip().lower() != name or getattr(t, 'is_foldable', False):
                continue
            parent = t.group_track
            while parent is not None:
                if parent.name.strip().lower() == group:
                    return t
                parent = parent.group_track
        return None

    def plan(self):
        s, e = self.song_region
        song = self.s.song()
        # The locator must be where the app says, so a changed set is never exported blindly.
        if self.locator:
            ok = any(abs(c.time - s) < 0.01 and c.name.strip().lower() == self.locator.strip().lower() for c in song.cue_points)
            if not ok:
                return {'ok': False, 'error': 'locator_moved: read the set again on the Ableton Sync page (%s)' % self.locator}
        elements, mix = [], []
        for spec in self.element_specs:
            if spec['slug'] == 'mixdown':
                continue
            t = self._find(spec['track'], spec['group'])
            if t is None or not self._has_clips(t, s, e):
                continue
            elements.append((spec['slug'], [t], [t]))
            if not (t.mute or any(p.mute for p in self._ancestors(t))):
                mix.append(t)
        if mix:
            elements.append(('mixdown', mix, []))
        self.region = (s, e)
        self.elements = elements
        self.backup = None
        self.mix_notes = {'mixdown_tracks': [t.name for t in mix]}
        return {'ok': True, 'elements': [el[0] for el in elements]}
