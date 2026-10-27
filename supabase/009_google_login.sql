-- Kit Log v9: Google sign-in with roles. Run after 008, and only AFTER Google sign-in is
-- switched on in Supabase (Authentication -> Sign In / Providers -> Google). Safe to run more than once.
--
-- Roles
--   admin   everything (athletes, lists, events, team)
--   viewer  Events tab only, read-only
-- A signed-in Google account that is not in app_users gets "no access".
--
-- How it is enforced: every athlete/list/event-editing function already starts with
-- _require_session(...). That check now reads the signed-in Supabase user from the request
-- (auth.uid()) and requires the admin role. Reading events uses _require_viewer().
-- The old PIN login is switched off.

create table if not exists public.app_users (
  email     text primary key check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role      text not null check (role in ('admin', 'viewer')),
  added_by  text,
  added_at  timestamptz not null default now()
);
alter table public.app_users enable row level security;
revoke all on public.app_users from public, anon, authenticated;

insert into public.app_users (email, role, added_by)
values ('muhammadismailudst@gmail.com', 'admin', 'setup')
on conflict (email) do nothing;

-- The signed-in user's verified email, or null.
create or replace function public._my_email()
returns text language sql stable security definer set search_path = public, auth as $$
  select lower(u.email) from auth.users u
  where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;

create or replace function public._my_role()
returns text language sql stable security definer set search_path = public, auth as $$
  select a.role from public.app_users a where a.email = public._my_email();
$$;

-- Admin only. Keeps its old signature (the token argument is ignored) so every
-- existing function is protected without being rewritten.
create or replace function public._require_session(p_token uuid)
returns void language plpgsql stable security definer set search_path = public, auth as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'not_logged_in' using errcode = '28000'; end if;
  r := _my_role();
  if r is null then raise exception 'no_access'; end if;
  if r <> 'admin' then raise exception 'not_allowed'; end if;
end $$;

-- Admin or viewer.
create or replace function public._require_viewer()
returns void language plpgsql stable security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not_logged_in' using errcode = '28000'; end if;
  if _my_role() is null then raise exception 'no_access'; end if;
end $$;

-- Who am I? Works for any signed-in user, so the app can show "no access" with their email.
create or replace function public.my_access(p_token uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, auth as $$
begin
  if auth.uid() is null then raise exception 'not_logged_in' using errcode = '28000'; end if;
  return jsonb_build_object('email', _my_email(), 'role', _my_role());
end $$;

-- Events: viewers may read.
create or replace function public.list_events(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_viewer();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'title', e.title, 'starts_on', e.starts_on, 'ends_on', e.ends_on,
      'start_time', to_char(e.start_time, 'HH24:MI'), 'end_time', to_char(e.end_time, 'HH24:MI'),
      'location', e.location, 'details', e.details)
    order by e.starts_on, e.start_time nulls first, e.title) from events e), '[]'::jsonb);
end $$;

-- ---------- Team (admins only) ----------
create or replace function public.list_team(p_token uuid default null)
returns jsonb language plpgsql security definer set search_path = public, auth as $$
begin
  perform _require_session(null);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'email', a.email, 'role', a.role, 'added_at', a.added_at,
      'joined', exists (select 1 from auth.users u where lower(u.email) = a.email))
    order by a.role, a.email) from app_users a), '[]'::jsonb);
end $$;

create or replace function public.set_team_member(p_token uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform _require_session(null);
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'bad_email'; end if;
  if p_role not in ('admin', 'viewer') then raise exception 'bad_role'; end if;
  if p_role <> 'admin' and exists (select 1 from app_users where email = v_email and role = 'admin')
     and (select count(*) from app_users where role = 'admin') <= 1 then
    raise exception 'last_admin';
  end if;
  insert into app_users (email, role, added_by) values (v_email, p_role, _my_email())
    on conflict (email) do update set role = excluded.role;
end $$;

create or replace function public.remove_team_member(p_token uuid, p_email text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_email text := lower(trim(coalesce(p_email, '')));
begin
  perform _require_session(null);
  if exists (select 1 from app_users where email = v_email and role = 'admin')
     and (select count(*) from app_users where role = 'admin') <= 1 then
    raise exception 'last_admin';
  end if;
  delete from app_users where email = v_email;
end $$;

-- ---------- Who may call what ----------
revoke execute on function public._my_email(), public._my_role(), public._require_viewer()
  from public, anon, authenticated;
revoke execute on function public.my_access(uuid), public.list_events(uuid), public.list_team(uuid),
  public.set_team_member(uuid, text, text), public.remove_team_member(uuid, text)
  from public, anon, authenticated;
grant execute on function public.my_access(uuid), public.list_events(uuid), public.list_team(uuid),
  public.set_team_member(uuid, text, text), public.remove_team_member(uuid, text)
  to authenticated;

-- PIN login is retired.
revoke execute on function public.login(text), public.logout(uuid) from public, anon, authenticated;
delete from public.sessions;
