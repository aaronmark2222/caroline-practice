"""CarolineSync: a small local bridge between the Caroline Practice app and Ableton Live.

A separate control surface from the band's TSPWork (which it never touches).
Safety rules (same as TSPWork's):
  * Listens on 127.0.0.1 only (ports 47720 http / 47721 https): nothing outside
    this Mac can reach it.
  * Accepts requests only from the GitHub Pages site (and localhost for testing),
    and every command must carry the signed-in Caroline Practice admin's
    short-lived Supabase token, which is confirmed with Supabase (rpc/cp_is_admin).
  * Exports run only while Caroline.als is the open set, render through Live's
    own Export dialog, put every solo/mute/loop back afterwards, never save the
    set, and upload only to the caroline/ folder of the R2 bucket.
"""
import hashlib
import json
import os
import re
import socket
import threading
import time

try:
    import queue
except ImportError:  # pragma: no cover
    import Queue as queue

try:
    import subprocess
except Exception:  # pragma: no cover
    subprocess = None

import Live  # noqa: F401  (Live's API is reached through self.song())
from _Framework.ControlSurface import ControlSurface

PORT = 47720
TLS_PORT = 47721
VERSION = '1.0'
HERE = os.path.dirname(os.path.abspath(__file__))
DEBUG_LOG = os.path.join(HERE, 'requests.log')
# The same 127.0.0.1 certificate TSPWork uses (copied next to this script on
# the Mac, never committed); it is already trusted in this Mac's Keychain.
CERT_FILE = os.path.join(HERE, 'carolinesync-localhost.crt')
KEY_FILE = os.path.join(HERE, 'carolinesync-localhost.key')
ALLOWED_ORIGINS = (
    'https://aaronmark2222.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
)
CAROLINE_ALS_PATH = '/Users/aaron/Desktop/CAROLINE/Caroline Project/Caroline.als'
SLUG_RE = re.compile(r'^[a-z0-9-]{1,60}$')
UPLOAD_RE = re.compile(r'^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com/tsp-practice/caroline/[a-z0-9-]+/[a-z0-9-]+\.(?:m4a|mp3|wav)\?[^\s"\'<>]+$')
EXPORT_ROOTS = ('/Volumes/', os.path.expanduser('~') + '/')
SUPABASE_URL = 'https://hzvfrvjuqvmkeqbrgmqu.supabase.co'
SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_bXd0ymwEnYNqQCq1EwH2AA_0HajJecU'
AUTH_CACHE_SECONDS = 300
AUTH_OFFLINE_GRACE_SECONDS = 24 * 3600
TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$')


def links_ok(uploads):
    """Every upload link must point at caroline/<song>/<track>. in the bucket."""
    if not isinstance(uploads, dict) or len(uploads) > 50:
        return False
    for slug, elements in uploads.items():
        if not SLUG_RE.match(str(slug)) or not isinstance(elements, dict) or len(elements) > 40:
            return False
        for el, links in elements.items():
            if not SLUG_RE.match(str(el)) or not isinstance(links, dict):
                return False
            for kind, url in links.items():
                if kind not in ('put', 'del', 'del_old') or not isinstance(url, str) or len(url) > 2000:
                    return False
                if not UPLOAD_RE.match(url) or ('/caroline/%s/%s.' % (slug, el)) not in url:
                    return False
    return True


class CarolineSync(ControlSurface):

    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._jobs = queue.Queue()
        self._busy = False
        self._stop = False
        self._servers = []
        self._export = None
        self._tls = self._tls_context()
        t = threading.Thread(target=self._serve, args=(PORT, None), name='CarolineSyncBridge')
        t.daemon = True
        t.start()
        if self._tls is not None:
            t2 = threading.Thread(target=self._serve, args=(TLS_PORT, self._tls), name='CarolineSyncBridgeTLS')
            t2.daemon = True
            t2.start()
        self.schedule_message(1, self._tick)
        self.log_message('CarolineSync %s: listening on 127.0.0.1:%d%s' % (VERSION, PORT, ' and :%d (https)' % TLS_PORT if self._tls else ''))
        self.show_message('CarolineSync %s: connected to Caroline Practice on this Mac' % VERSION)

    def disconnect(self):
        self._stop = True
        try:
            job = self._export
            if job and job.state['state'] in ('starting', 'running', 'uploading'):
                job.cancelled = True
                job.restore_state()
        except Exception:
            pass
        for srv in self._servers:
            try:
                srv.close()
            except Exception:
                pass
        ControlSurface.disconnect(self)

    # ------------------------------------------------------------ plumbing
    def _debug(self, line):
        try:
            if os.path.exists(DEBUG_LOG) and os.path.getsize(DEBUG_LOG) > 200000:
                os.rename(DEBUG_LOG, DEBUG_LOG + '.old')
            with open(DEBUG_LOG, 'a') as fh:
                fh.write('%s %s\n' % (time.strftime('%H:%M:%S'), line))
        except Exception:
            pass

    def _tls_context(self):
        if not (os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE)):
            return None
        try:
            import ssl
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(CERT_FILE, KEY_FILE)
            return ctx
        except Exception as err:
            self.log_message('CarolineSync https disabled: %r' % (err,))
            return None

    def _tick(self):
        if self._stop:
            return
        try:
            for _ in range(4):
                try:
                    job = self._jobs.get_nowait()
                except queue.Empty:
                    break
                try:
                    job['result'] = job['fn'](*job['args'])
                except Exception as err:
                    job['result'] = {'ok': False, 'error': 'live_error', 'detail': str(err)}
                    self.log_message('CarolineSync error: %r' % (err,))
                job['done'].set()
        finally:
            self.schedule_message(1, self._tick)

    def _run_on_main(self, fn, *args, timeout=4.0):
        job = {'fn': fn, 'args': args, 'done': threading.Event(), 'result': None}
        self._jobs.put(job)
        if not job['done'].wait(timeout):
            return {'ok': False, 'error': 'timeout'}
        return job['result']

    # Used by the exporter (same names as TSPWork's).
    def _all_tracks(self):
        return list(self.song().tracks)

    def _descendants(self, group):
        out = []
        for t in self._all_tracks():
            parent = t.group_track
            while parent is not None:
                if parent == group:
                    out.append(t)
                    break
                parent = parent.group_track
        return out

    def _unfold_parents(self, track):
        parent = track.group_track
        while parent is not None:
            try:
                if parent.is_foldable and parent.fold_state:
                    parent.fold_state = 0
            except Exception:
                pass
            parent = parent.group_track
        return []

    def _status(self, message):
        self.log_message(message)
        self.show_message(message)
        return {'ok': True}

    def _export_finished(self, job):
        self._busy = False
        st = job.state
        msg = 'CarolineSync %s: export %s: %d of %d songs done' % (
            VERSION, st['state'], sum(1 for r in st['results'] if r['state'] == 'done'), len(st['queue']))
        if st.get('error'):
            msg += ': ' + st['error'][:80]
        self._debug(msg)
        try:
            self._run_on_main(self._status, msg)
        except Exception:
            pass

    # ------------------------------------------------------------ commands
    def _cmd_status(self):
        path = getattr(self.song(), 'file_path', '') or ''
        return {'ok': True, 'app': 'carolinesync', 'version': VERSION, 'https': self._tls is not None,
                'open_als_path': path, 'caroline_open': path == CAROLINE_ALS_PATH,
                'playing': self.song().is_playing, 'busy': self._busy}

    def _export_request(self, path, payload):
        job = self._export
        if path.startswith('/export/state'):
            return {'ok': True, 'job': job.state if job else None}
        if path.startswith('/export/cancel'):
            if job and job.state['state'] in ('starting', 'running', 'uploading'):
                if payload.get('after_song'):
                    job.stop_after_song = not bool(payload.get('undo'))
                    job.state['stop_after_song'] = job.stop_after_song
                else:
                    job.cancelled = True
            return {'ok': True, 'job': job.state if job else None}
        if job and job.state['state'] in ('starting', 'running', 'uploading'):
            return {'ok': False, 'error': 'export_running', 'job': job.state}
        opened = self._run_on_main(self._cmd_status) or {}
        if not opened.get('caroline_open'):
            return {'ok': False, 'error': 'caroline_set_not_open', 'open_als_path': opened.get('open_als_path', '')}
        if opened.get('playing'):
            return {'ok': False, 'error': 'live_playing'}
        songs = []
        for item in (payload.get('songs') if isinstance(payload.get('songs'), list) else [])[:50]:
            if not isinstance(item, dict) or not SLUG_RE.match(str(item.get('song_id', ''))):
                return {'ok': False, 'error': 'bad_song'}
            try:
                start, end = float(item.get('start_beat')), float(item.get('end_beat'))
            except (TypeError, ValueError):
                return {'ok': False, 'error': 'bad_song_region'}
            if not (0 <= start < end):
                return {'ok': False, 'error': 'bad_song_region'}
            songs.append({'song_id': str(item['song_id']), 'song_name': str(item.get('song_name', ''))[:80],
                          'start': start, 'end': end, 'locator': str(item.get('locator', ''))[:80]})
        if not songs:
            return {'ok': False, 'error': 'no_songs'}
        elements = []
        for el in (payload.get('elements') if isinstance(payload.get('elements'), list) else [])[:40]:
            if not isinstance(el, dict) or not SLUG_RE.match(str(el.get('slug', ''))):
                return {'ok': False, 'error': 'bad_element'}
            elements.append({'slug': str(el['slug']), 'track': str(el.get('track', ''))[:80],
                             'group': str(el.get('group', ''))[:40], 'label': str(el.get('label', ''))[:60]})
        root = os.path.expanduser(str(payload.get('export_root') or '').strip())
        if not root or not os.path.isabs(root) or '..' in root.split('/') \
                or not (os.path.realpath(root) + '/').startswith(EXPORT_ROOTS):
            return {'ok': False, 'error': 'bad_export_folder'}
        if not os.path.isdir(os.path.dirname(root.rstrip('/'))):
            return {'ok': False, 'error': 'export_folder_missing', 'folder': root}
        uploads = payload.get('uploads') if isinstance(payload.get('uploads'), dict) else {}
        if uploads and not links_ok(uploads):
            return {'ok': False, 'error': 'bad_upload_url'}
        if self._busy:
            return {'ok': False, 'error': 'busy'}
        import importlib
        from . import exporter
        importlib.reload(exporter)
        self._busy = True
        self._export = exporter.CarolineExportJob(self, songs, root, uploads, elements)
        self._export.thread.start()
        return {'ok': True, 'job': self._export.state}

    # ------------------------------------------------------------ auth
    def _check_admin_online(self, token):
        if subprocess is None:
            return None
        config = 'header = "apikey: %s"\nheader = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' % (
            SUPABASE_PUBLISHABLE_KEY, token)
        try:
            out = subprocess.run(['/usr/bin/curl', '-sS', '-m', '6', '-X', 'POST', '-d', '{}', '-w', '\n%{http_code}',
                                  '-K', '-', SUPABASE_URL + '/rest/v1/rpc/cp_is_admin'],
                                 input=config, capture_output=True, text=True, timeout=10)
        except Exception:
            return None
        if out.returncode != 0:
            return None
        body, _, code = (out.stdout or '').rpartition('\n')
        if code.strip() == '200':
            return body.strip() == 'true'
        if code.strip() in ('400', '401', '403'):
            return False
        return None

    def _authorized(self, token):
        if not isinstance(token, str) or len(token) > 4096 or not TOKEN_RE.match(token):
            return False, 'auth_required'
        cache = getattr(self, '_auth_cache', None)
        if cache is None:
            cache = self._auth_cache = {}
        digest = hashlib.sha256(token.encode('ascii')).hexdigest()
        now = time.time()
        seen = cache.get(digest)
        if seen is not None and now - seen < AUTH_CACHE_SECONDS:
            return True, None
        verdict = self._check_admin_online(token)
        if verdict is True:
            if len(cache) > 50:
                cache.clear()
            cache[digest] = now
            return True, None
        if verdict is None:
            if seen is not None and now - seen < AUTH_OFFLINE_GRACE_SECONDS:
                return True, None
            return False, 'auth_unreachable'
        cache.pop(digest, None)
        return False, 'not_admin'

    # ------------------------------------------------------------ HTTP
    def _serve(self, port, tls):
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(('127.0.0.1', port))
            srv.listen(8)
            srv.settimeout(1.0)
            self._servers.append(srv)
        except Exception as err:
            self.log_message('CarolineSync could not open port %d: %r' % (port, err))
            return
        while not self._stop:
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            except Exception:
                if self._stop:
                    break
                continue
            w = threading.Thread(target=self._handle, args=(conn, tls))
            w.daemon = True
            w.start()

    def _handle(self, conn, tls=None):
        try:
            conn.settimeout(15)
            if tls is not None:
                try:
                    conn = tls.wrap_socket(conn, server_side=True)
                except Exception as err:
                    self._debug('tls handshake failed: %r' % (err,))
                    try:
                        conn.close()
                    except Exception:
                        pass
                    return
            data = b''
            while b'\r\n\r\n' not in data and len(data) < 16384:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                data += chunk
            head, _, body = data.partition(b'\r\n\r\n')
            lines = head.decode('latin-1').split('\r\n')
            method, path = (lines[0].split(' ') + ['', ''])[:2]
            headers = {}
            for line in lines[1:]:
                if ':' in line:
                    k, v = line.split(':', 1)
                    headers[k.strip().lower()] = v.strip()
            limit = 2 * 1024 * 1024 if path.startswith('/export') else 4096
            try:
                declared = int(headers.get('content-length', '0') or 0)
            except ValueError:
                declared = -1
            too_large = declared < 0 or declared > limit
            length = 0 if too_large else declared
            while len(body) < length:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                body += chunk
            origin = headers.get('origin', '')
            allowed = origin in ALLOWED_ORIGINS
            self._debug('%s %s %s origin=%s allowed=%s' % ('https' if tls is not None else 'http', method, path, origin or '-', allowed))
            if method == 'OPTIONS':
                return self._reply(conn, 204, None, origin if allowed else None)
            if not allowed:
                return self._reply(conn, 403, {'ok': False, 'error': 'origin_not_allowed'}, None)
            if too_large:
                return self._reply(conn, 413, {'ok': False, 'error': 'too_large'}, origin)
            if method == 'GET' and path.startswith('/status'):
                if self._export and self._export.state['state'] in ('starting', 'running', 'uploading'):
                    return self._reply(conn, 200, {'ok': True, 'app': 'carolinesync', 'version': VERSION,
                                                   'https': self._tls is not None, 'exporting': self._export.state}, origin)
                return self._reply(conn, 200, self._run_on_main(self._cmd_status), origin)
            if method != 'POST':
                return self._reply(conn, 404, {'ok': False, 'error': 'not_found'}, origin)
            try:
                payload = json.loads(body[:length].decode('utf-8') or '{}')
            except Exception:
                return self._reply(conn, 400, {'ok': False, 'error': 'bad_json'}, origin)
            if not isinstance(payload, dict):
                return self._reply(conn, 400, {'ok': False, 'error': 'bad_json'}, origin)
            authorized, why = self._authorized(payload.pop('_auth', None))
            if not authorized:
                self._debug('refused %s: %s' % (path, why))
                return self._reply(conn, 401, {'ok': False, 'error': why}, origin)
            if path.startswith('/export'):
                return self._reply(conn, 200, self._export_request(path, payload), origin)
            return self._reply(conn, 404, {'ok': False, 'error': 'not_found'}, origin)
        except Exception as err:
            self._debug('handler error: %r' % (err,))
            try:
                self._reply(conn, 500, {'ok': False, 'error': 'server_error'}, None)
            except Exception:
                pass
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _reply(self, conn, code, obj, origin):
        reason = {200: 'OK', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden',
                  404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 500: 'Server Error'}.get(code, 'OK')
        body = b'' if obj is None else json.dumps(obj).encode('utf-8')
        head = ['HTTP/1.1 %d %s' % (code, reason), 'Content-Type: application/json',
                'Content-Length: %d' % len(body), 'Cache-Control: no-store', 'Connection: close', 'Vary: Origin']
        if origin:
            head += ['Access-Control-Allow-Origin: %s' % origin, 'Access-Control-Allow-Methods: GET, POST, OPTIONS',
                     'Access-Control-Allow-Headers: Content-Type', 'Access-Control-Allow-Private-Network: true',
                     'Access-Control-Max-Age: 600']
        conn.sendall(('\r\n'.join(head) + '\r\n\r\n').encode('latin-1') + body)
