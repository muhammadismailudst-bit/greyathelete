-- Grey Athlete Kit Log — Supabase setup
-- Run this whole file once in Supabase: SQL Editor -> New query -> paste -> Run.
-- Then set the staff PIN (6-12 digits) in a new query:
--     select public.set_pin('your-pin-here');
-- Running set_pin again changes the PIN and logs everyone out.
--
-- Security model: the browser only ever holds the public "anon" key. Every table
-- has row level security on and no policies, and all table privileges are revoked
-- from the API roles, so the tables can't be read or written directly. The app can
-- only call the functions below; each one (except login) requires a session token
-- that login hands out for the correct PIN. The PIN itself is stored only as a
-- bcrypt hash.

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.app_config (
  id        int primary key default 1 check (id = 1),
  pin_hash  text not null
);

create table if not exists public.sessions (
  token       uuid primary key default gen_random_uuid(),
  expires_at  timestamptz not null
);

create table if not exists public.login_failures (
  at timestamptz not null default now()
);

create table if not exists public.handouts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  gym         text not null default '' check (char_length(gym) <= 80),
  level       text not null default '' check (level in ('', 'Beginner', 'Intermediate', 'Advanced')),
  size        text not null default '' check (size in ('', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL')),
  batch       text not null default '' check (char_length(batch) <= 40),
  given_on    date,
  note        text not null default '' check (char_length(note) <= 1000),
  items       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.batch_notes (
  batch       text primary key check (char_length(batch) between 1 and 40),
  note        text not null check (char_length(note) between 1 and 2000),
  updated_at  timestamptz not null default now()
);

-- Lock the tables: RLS on with no policies, and no direct privileges for API roles.
alter table public.app_config     enable row level security;
alter table public.sessions       enable row level security;
alter table public.login_failures enable row level security;
alter table public.handouts       enable row level security;
alter table public.batch_notes    enable row level security;
revoke all on public.app_config, public.sessions, public.login_failures,
              public.handouts, public.batch_notes from public, anon, authenticated;

-- ---------- Helpers (not callable from the app) ----------
create or replace function public._require_session(p_token uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_token is null or not exists (
       select 1 from sessions where token = p_token and expires_at > now()) then
    raise exception 'not_logged_in' using errcode = '28000';
  end if;
end $$;

create or replace function public._clean_items(p jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select jsonb_build_object(
    'headband', coalesce(p -> 'headband' = 'true'::jsonb, false),
    'flag',     coalesce(p -> 'flag'     = 'true'::jsonb, false),
    'bag',      coalesce(p -> 'bag'      = 'true'::jsonb, false),
    'badge',    coalesce(p -> 'badge'    = 'true'::jsonb, false),
    'tshirt',   coalesce(p -> 'tshirt'   = 'true'::jsonb, false));
$$;

-- Owner-only: run from the SQL editor.
create or replace function public.set_pin(p_pin text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pin !~ '^[0-9]{6,12}$' then
    raise exception 'PIN must be 6 to 12 digits';
  end if;
  insert into app_config (id, pin_hash) values (1, crypt(p_pin, gen_salt('bf', 10)))
    on conflict (id) do update set pin_hash = excluded.pin_hash;
  delete from sessions;           -- everyone must log in with the new PIN
  delete from login_failures;
  return 'PIN set. Everyone has been logged out.';
end $$;

-- ---------- App functions ----------
-- Returns {"token": "..."} or {"error": "wrong_pin" | "too_many_attempts" | "pin_not_set"}.
-- Wrong PINs return an error value (not an exception) so the failure record is kept.
-- Limit: 20 wrong PINs in 10 minutes across everyone, then new logins pause.
create or replace function public.login(p_pin text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_hash  text;
  v_token uuid;
begin
  delete from login_failures where at < now() - interval '10 minutes';
  if (select count(*) from login_failures) >= 20 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;

  select pin_hash into v_hash from app_config where id = 1;
  if v_hash is null then
    return jsonb_build_object('error', 'pin_not_set');
  end if;

  if p_pin is null or char_length(p_pin) > 12 or crypt(p_pin, v_hash) <> v_hash then
    insert into login_failures default values;
    return jsonb_build_object('error', 'wrong_pin');
  end if;

  delete from sessions where expires_at < now();
  insert into sessions (expires_at) values (now() + interval '30 days')
    returning token into v_token;
  return jsonb_build_object('token', v_token);
end $$;

create or replace function public.logout(p_token uuid)
returns void language sql security definer set search_path = public as $$
  delete from sessions where token = p_token;
$$;

create or replace function public.list_handouts(p_token uuid)
returns setof public.handouts language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return query select * from handouts order by created_at desc;
end $$;

-- p_id null = create, otherwise update that record.
create or replace function public.save_handout(p_token uuid, p_id uuid, p_data jsonb)
returns public.handouts language plpgsql security definer set search_path = public, extensions as $$
declare
  r public.handouts;
begin
  perform _require_session(p_token);
  if p_id is null then
    insert into handouts (name, gym, level, size, batch, given_on, note, items)
    values (trim(coalesce(p_data ->> 'name', '')),
            trim(coalesce(p_data ->> 'gym', '')),
            coalesce(p_data ->> 'level', ''),
            coalesce(p_data ->> 'size', ''),
            upper(trim(coalesce(p_data ->> 'batch', ''))),
            nullif(p_data ->> 'date', '')::date,
            trim(coalesce(p_data ->> 'note', '')),
            _clean_items(p_data -> 'items'))
    returning * into r;
  else
    update handouts set
      name     = trim(coalesce(p_data ->> 'name', '')),
      gym      = trim(coalesce(p_data ->> 'gym', '')),
      level    = coalesce(p_data ->> 'level', ''),
      size     = coalesce(p_data ->> 'size', ''),
      batch    = upper(trim(coalesce(p_data ->> 'batch', ''))),
      given_on = nullif(p_data ->> 'date', '')::date,
      note     = trim(coalesce(p_data ->> 'note', '')),
      items    = _clean_items(p_data -> 'items'),
      updated_at = now()
    where id = p_id
    returning * into r;
    if not found then raise exception 'not_found'; end if;
  end if;
  return r;
end $$;

-- Flip one item without touching the rest of the record (safe when two staff edit at once).
create or replace function public.set_item(p_token uuid, p_id uuid, p_key text, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  if p_key not in ('headband', 'flag', 'bag', 'badge', 'tshirt') then
    raise exception 'bad_item';
  end if;
  update handouts
     set items = jsonb_set(_clean_items(items), array[p_key], to_jsonb(coalesce(p_value, false))),
         updated_at = now()
   where id = p_id;
end $$;

create or replace function public.delete_handout(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  delete from handouts where id = p_id;
end $$;

create or replace function public.list_batch_notes(p_token uuid)
returns setof public.batch_notes language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return query select * from batch_notes order by batch;
end $$;

-- An empty note removes it.
create or replace function public.save_batch_note(p_token uuid, p_batch text, p_note text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  v_batch text := upper(trim(coalesce(p_batch, '')));
  v_note  text := trim(coalesce(p_note, ''));
begin
  perform _require_session(p_token);
  if v_batch = '' then raise exception 'bad_batch'; end if;
  if v_note = '' then
    delete from batch_notes where batch = v_batch;
  else
    insert into batch_notes (batch, note) values (v_batch, v_note)
      on conflict (batch) do update set note = excluded.note, updated_at = now();
  end if;
end $$;

-- ---------- Who may call what ----------
revoke execute on function
  public._require_session(uuid), public._clean_items(jsonb), public.set_pin(text),
  public.login(text), public.logout(uuid), public.list_handouts(uuid),
  public.save_handout(uuid, uuid, jsonb), public.set_item(uuid, uuid, text, boolean),
  public.delete_handout(uuid, uuid), public.list_batch_notes(uuid),
  public.save_batch_note(uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.login(text), public.logout(uuid), public.list_handouts(uuid),
  public.save_handout(uuid, uuid, jsonb), public.set_item(uuid, uuid, text, boolean),
  public.delete_handout(uuid, uuid), public.list_batch_notes(uuid),
  public.save_batch_note(uuid, text, text)
to anon, authenticated;
