-- Applied to project hzvfrvjuqvmkeqbrgmqu as migration "caroline_practice_init" (16 Nov 2026).
-- Caroline Practice shares the TSP Work Supabase project; its tables are prefixed cp_.
create table public.cp_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text not null,
  role text not null default 'teacher' check (role in ('admin','teacher')),
  created_at timestamptz not null default now()
);
create table public.cp_songs (
  slug text primary key check (slug ~ '^[a-z0-9-]{1,60}$'),
  name text not null,
  position int not null default 0,
  start_beat double precision,
  end_beat double precision,
  duration_seconds double precision,
  bpm numeric,
  song_key text,
  lyrics jsonb not null default '{}'::jsonb,
  hidden boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.cp_meta (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create or replace function public.cp_is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cp_users where user_id = (select auth.uid()));
$$;
create or replace function public.cp_is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.cp_users where user_id = (select auth.uid()) and role = 'admin');
$$;
revoke execute on function public.cp_is_member() from public, anon;
revoke execute on function public.cp_is_admin() from public, anon;
grant execute on function public.cp_is_member() to authenticated;
grant execute on function public.cp_is_admin() to authenticated;
alter table public.cp_users enable row level security;
alter table public.cp_songs enable row level security;
alter table public.cp_meta enable row level security;
create policy cp_users_read on public.cp_users for select to authenticated
  using (user_id = (select auth.uid()) or (select public.cp_is_admin()));
create policy cp_songs_read on public.cp_songs for select to authenticated using ((select public.cp_is_member()));
create policy cp_songs_admin_ins on public.cp_songs for insert to authenticated with check ((select public.cp_is_admin()));
create policy cp_songs_admin_upd on public.cp_songs for update to authenticated using ((select public.cp_is_admin())) with check ((select public.cp_is_admin()));
create policy cp_songs_admin_del on public.cp_songs for delete to authenticated using ((select public.cp_is_admin()));
create policy cp_meta_read on public.cp_meta for select to authenticated using ((select public.cp_is_member()));
create policy cp_meta_admin_ins on public.cp_meta for insert to authenticated with check ((select public.cp_is_admin()));
create policy cp_meta_admin_upd on public.cp_meta for update to authenticated using ((select public.cp_is_admin())) with check ((select public.cp_is_admin()));
revoke all on public.cp_users, public.cp_songs, public.cp_meta from anon;
-- The live migration also ran: insert into public.cp_users (user_id, name, role) select id, 'Aaron', 'admin' from auth.users where email = 'aaronmark2222@gmail.com';
-- Other users (Caroline) are added by the admin directly; there is no public sign-up.
