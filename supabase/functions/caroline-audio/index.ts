// caroline-audio: short-lived signed links to Caroline Practice audio in Cloudflare R2.
// Files live in the shared bucket under caroline/<song-slug>/<element-slug>.<ext>
// (the band app only ever lists songs/, so the two never mix).
//   { action: 'list' }                                   -> which songs have which files (members)
//   { action: 'urls', song }                             -> signed GET links for a song (members)
//   { action: 'upload', song, element, ext }             -> signed PUT link (admin)
//   { action: 'finalize', song, element, ext }           -> after an upload, removes other formats of that track (admin)
//   { action: 'delete', song, element }                  -> removes a file (admin)
// R2 keys come from this project's Edge Function secrets; the browser never sees them.
import { createClient } from 'npm:@supabase/supabase-js@2';

const BUCKET = 'tsp-practice';
const PREFIX = 'caroline/';
const ALLOWED_ORIGINS = ['https://aaronmark2222.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const EXTS = ['m4a', 'mp3', 'wav'];
const MIME: Record<string, string> = { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav' };

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256(text: string) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmac(key: ArrayBuffer | Uint8Array, text: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(text));
}
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

async function presign(method: 'GET' | 'PUT' | 'DELETE', key: string | null, expires: number, extra: Record<string, string> = {}) {
  const account = Deno.env.get('R2_ACCOUNT_ID');
  const akid = Deno.env.get('R2_ACCESS_KEY_ID');
  const secret = Deno.env.get('R2_SECRET_ACCESS_KEY');
  if (!account || !akid || !secret) throw new Error('r2_not_configured');
  const host = `${account}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/auto/s3/aws4_request`;
  const path = '/' + (key === null ? [BUCKET] : [BUCKET, ...key.split('/')]).map(rfc3986).join('/');
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${akid}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
    ...extra,
  };
  const query = Object.keys(params).sort().map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join('&');
  const canonical = [method, path, query, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let k = await hmac(enc.encode('AWS4' + secret), day);
  k = await hmac(k, 'auto');
  k = await hmac(k, 's3');
  k = await hmac(k, 'aws4_request');
  const signature = hex(await hmac(k, toSign));
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

async function listObjects(prefix: string) {
  const out: { key: string; size: number; modified: string }[] = [];
  let token = '';
  for (let page = 0; page < 10; page += 1) {
    const params: Record<string, string> = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) params['continuation-token'] = token;
    const res = await fetch(await presign('GET', null, 300, params));
    if (!res.ok) throw new Error(`r2_list_${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = /<Key>([^<]*)<\/Key>/.exec(m[1])?.[1] || '';
      out.push({
        key: key.replace(/&amp;/g, '&'),
        size: Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0),
        modified: /<LastModified>([^<]*)<\/LastModified>/.exec(m[1])?.[1] || '',
      });
    }
    token = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1] || '';
    if (!token) break;
  }
  return out;
}
function parseKey(key: string) {
  const m = /^caroline\/([a-z0-9-]{1,60})\/([a-z0-9-]{1,60})\.(m4a|mp3|wav)$/.exec(key);
  return m ? { song: m[1], element: m[2], ext: m[3] } : null;
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get('origin')), 'Content-Type': 'application/json' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  try {
    const db = createClient(Deno.env.get('SUPABASE_URL')!, (Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY'))!, {
      global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    });
    const { data: member } = await db.rpc('cp_is_member');
    if (!member) return reply(403, { ok: false, error: 'not_a_member' });
    const body = await req.json().catch(() => ({}));
    const admin = async () => (await db.rpc('cp_is_admin')).data === true;

    if (body.action === 'list') {
      const songs: Record<string, Record<string, { bytes: number; modified: string; ext: string; key: string }>> = {};
      for (const obj of await listObjects(PREFIX)) {
        const p = parseKey(obj.key);
        if (!p) continue;
        const prev = songs[p.song]?.[p.element];
        // one file per element; if two formats exist, the newest wins
        if (!prev || prev.modified < obj.modified) (songs[p.song] ||= {})[p.element] = { bytes: obj.size, modified: obj.modified, ext: p.ext, key: obj.key };
      }
      return reply(200, { ok: true, songs });
    }

    if (body.action === 'urls') {
      const song = String(body.song || '');
      if (!SLUG_RE.test(song)) return reply(400, { ok: false, error: 'bad_song' });
      const files: Record<string, { url: string; download: string; bytes: number; modified: string; ext: string }> = {};
      for (const obj of await listObjects(`${PREFIX}${song}/`)) {
        const p = parseKey(obj.key);
        if (!p) continue;
        const prev = files[p.element];
        if (prev && prev.modified >= obj.modified) continue;
        files[p.element] = {
          url: await presign('GET', obj.key, 3 * 3600),
          download: await presign('GET', obj.key, 3 * 3600, { 'response-content-disposition': `attachment; filename="${song}-${p.element}.${p.ext}"` }),
          bytes: obj.size, modified: obj.modified, ext: p.ext,
        };
      }
      return reply(200, { ok: true, files });
    }

    if (body.action === 'upload') {
      if (!(await admin())) return reply(403, { ok: false, error: 'admin_only' });
      const song = String(body.song || ''), element = String(body.element || ''), ext = String(body.ext || '');
      if (!SLUG_RE.test(song) || !SLUG_RE.test(element) || !EXTS.includes(ext)) return reply(400, { ok: false, error: 'bad_request' });
      const base = `${PREFIX}${song}/${element}`;
      return reply(200, { ok: true, put: await presign('PUT', `${base}.${ext}`, 3600), content_type: MIME[ext] });
    }

    if (body.action === 'finalize') {
      // after an upload: remove the same element in other formats, so one file per track remains
      if (!(await admin())) return reply(403, { ok: false, error: 'admin_only' });
      const song = String(body.song || ''), element = String(body.element || ''), ext = String(body.ext || '');
      if (!SLUG_RE.test(song) || !SLUG_RE.test(element) || !EXTS.includes(ext)) return reply(400, { ok: false, error: 'bad_request' });
      for (const x of EXTS) {
        if (x === ext) continue;
        const res = await fetch(await presign('DELETE', `${PREFIX}${song}/${element}.${x}`, 300), { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(`r2_delete_${res.status}`);
      }
      return reply(200, { ok: true });
    }

    if (body.action === 'delete') {
      if (!(await admin())) return reply(403, { ok: false, error: 'admin_only' });
      const song = String(body.song || ''), element = String(body.element || '');
      if (!SLUG_RE.test(song) || !SLUG_RE.test(element)) return reply(400, { ok: false, error: 'bad_request' });
      for (const x of EXTS) {
        const res = await fetch(await presign('DELETE', `${PREFIX}${song}/${element}.${x}`, 300), { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error(`r2_delete_${res.status}`);
      }
      return reply(200, { ok: true });
    }
    return reply(400, { ok: false, error: 'unknown_action' });
  } catch (e) {
    return reply(500, { ok: false, error: String((e as Error)?.message || e) });
  }
});
