-- Applied to project hzvfrvjuqvmkeqbrgmqu as migration "caroline_practice_analytics" (17 Nov 2026 IST).
-- Caroline Practice usage analytics: sessions per device, practice plays, events (errors etc.).
create table public.cp_sessions (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id text not null,
  device text, os text, browser text, standalone boolean, screen text, app_version text,
  info jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  active_seconds integer not null default 0,
  view_seconds jsonb not null default '{}'::jsonb,
  offline boolean not null default false
);
create index cp_sessions_started on public.cp_sessions (started_at desc);
create index cp_sessions_device on public.cp_sessions (device_id);

create table public.cp_plays (
  id uuid primary key,
  session_id uuid references public.cp_sessions(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id text,
  song_slug text not null,
  mode text,
  room_role text,
  room_code text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  seconds_played numeric not null default 0,
  start_pos numeric, end_pos numeric, max_pos numeric, song_seconds numeric,
  reached_end boolean not null default false,
  seeks integer not null default 0, pauses integer not null default 0,
  fullscreen_seconds numeric not null default 0,
  lyrics_track text,
  mixer jsonb,
  offline boolean not null default false
);
create index cp_plays_started on public.cp_plays (started_at desc);
create index cp_plays_session on public.cp_plays (session_id);

create table public.cp_events (
  id uuid primary key,
  session_id uuid references public.cp_sessions(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  device_id text,
  at timestamptz not null default now(),
  kind text not null,
  song_slug text,
  detail jsonb not null default '{}'::jsonb
);
create index cp_events_at on public.cp_events (at desc);
create index cp_events_kind on public.cp_events (kind, at desc);
create index cp_events_session on public.cp_events (session_id);

alter table public.cp_sessions enable row level security;
alter table public.cp_plays enable row level security;
alter table public.cp_events enable row level security;

create policy cp_sessions_ins on public.cp_sessions for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.cp_is_member()));
create policy cp_sessions_upd on public.cp_sessions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy cp_sessions_sel on public.cp_sessions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.cp_is_admin()));
create policy cp_plays_ins on public.cp_plays for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.cp_is_member()));
create policy cp_plays_upd on public.cp_plays for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy cp_plays_sel on public.cp_plays for select to authenticated
  using (user_id = (select auth.uid()) or (select public.cp_is_admin()));
create policy cp_events_ins on public.cp_events for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.cp_is_member()));
create policy cp_events_upd on public.cp_events for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy cp_events_sel on public.cp_events for select to authenticated
  using (user_id = (select auth.uid()) or (select public.cp_is_admin()));
revoke all on public.cp_sessions, public.cp_plays, public.cp_events from anon;

create view public.cp_usage_daily with (security_invoker = true) as
with s as (
  select (started_at at time zone 'Asia/Kolkata')::date as day, count(*) as sessions, count(distinct device_id) as devices,
         sum(active_seconds) as active from public.cp_sessions group by 1),
p as (
  select (started_at at time zone 'Asia/Kolkata')::date as day, sum(seconds_played) as played,
         count(*) filter (where seconds_played >= 30) as plays from public.cp_plays group by 1)
select coalesce(s.day, p.day) as day, coalesce(s.sessions, 0) as sessions, coalesce(s.devices, 0) as devices,
       round(coalesce(s.active, 0) / 60.0, 1) as active_minutes,
       round(coalesce(p.played, 0) / 60.0, 1) as practice_minutes, coalesce(p.plays, 0) as plays
from s full join p on p.day = s.day;

create view public.cp_usage_devices with (security_invoker = true) as
with s as (
  select device_id, max(device) as device, max(os) as os, max(browser) as browser, bool_or(standalone) as home_screen_app,
         count(*) as sessions, min(started_at) as first_seen, max(last_seen_at) as last_seen, sum(active_seconds) as active
  from public.cp_sessions group by device_id),
p as (select device_id, sum(seconds_played) as played from public.cp_plays group by device_id),
e as (select device_id, count(*) as errors from public.cp_events where kind like '%error%' group by device_id)
select s.device_id, s.device, s.os, s.browser, s.home_screen_app, s.sessions, s.first_seen, s.last_seen,
       round(coalesce(s.active, 0) / 60.0, 1) as active_minutes,
       round(coalesce(p.played, 0) / 60.0, 1) as practice_minutes,
       coalesce(e.errors, 0) as errors
from s left join p using (device_id) left join e using (device_id);

create view public.cp_usage_songs with (security_invoker = true) as
select p.song_slug,
       count(*) filter (where p.seconds_played >= 30) as plays,
       count(*) filter (where p.reached_end) as played_to_end,
       round(sum(p.seconds_played) / 60.0, 1) as practice_minutes,
       round(coalesce(sum(p.seconds_played) filter (where p.mode = 'mix'), 0) / 60.0, 1) as mixdown_minutes,
       round(coalesce(sum(p.seconds_played) filter (where p.mode = 'multi'), 0) / 60.0, 1) as multitrack_minutes,
       round(coalesce(sum(p.seconds_played) filter (where p.room_role is not null), 0) / 60.0, 1) as room_minutes,
       count(distinct p.device_id) as devices,
       max(p.updated_at) as last_played
from public.cp_plays p
group by p.song_slug;
