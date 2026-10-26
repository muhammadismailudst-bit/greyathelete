-- Kit Log v2: editable races and items. Run after setup.sql.
-- Safe to run more than once.
--
-- * races: editable list (name, optional date, note). Replaces "batch" and batch notes.
-- * items: editable list (Head band, Flag, ... plus your own). Removing one removes it everywhere.
-- * handouts.race_ids: the races a person has done.
-- Existing batch values become races, and batch notes become race notes.

-- ---------- Tables ----------
create table if not exists public.races (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 60),
  race_date   date,
  note        text not null default '' check (char_length(note) <= 2000),
  created_at  timestamptz not null default now()
);
create unique index if not exists races_name_key on public.races (lower(name));

create table if not exists public.items (
  id          text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
  name        text not null check (char_length(name) between 1 and 40),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists items_name_key on public.items (lower(name));

alter table public.handouts add column if not exists race_ids uuid[] not null default '{}';

alter table public.races enable row level security;
alter table public.items enable row level security;
revoke all on public.races, public.items from public, anon, authenticated;

-- ---------- Move existing data ----------
insert into public.items (id, name, sort) values
  ('headband', 'Head band', 1), ('flag', 'Flag', 2), ('bag', 'Bag', 3),
  ('badge', 'Badge', 4), ('tshirt', 'T-shirt', 5)
on conflict (id) do nothing;

insert into public.races (name, note)
select b.batch, coalesce(n.note, '')
from (select distinct batch from public.handouts where batch <> '') b
left join public.batch_notes n on n.batch = b.batch
where not exists (select 1 from public.races r where lower(r.name) = lower(b.batch));

update public.handouts h
   set race_ids = array[r.id], batch = ''
  from public.races r
 where h.batch <> '' and lower(r.name) = lower(h.batch);

-- ---------- Helpers ----------
-- Keep only items that still exist, and only true values.
create or replace function public._clean_items2(p jsonb)
returns jsonb language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(jsonb_object_agg(i.id, true), '{}'::jsonb)
  from items i
  where jsonb_typeof(p) = 'object' and p -> i.id = 'true'::jsonb;
$$;

-- Keep only races that still exist.
create or replace function public._clean_races(p jsonb)
returns uuid[] language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(array_agg(r.id order by r.id), '{}')
  from races r
  where jsonb_typeof(p) = 'array' and p ? r.id::text;
$$;

-- ---------- Read everything in one call ----------
create or replace function public.list_all(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', h.id, 'name', h.name, 'gym', h.gym, 'level', h.level, 'size', h.size,
                 'date', h.given_on, 'note', h.note, 'items', _clean_items2(h.items),
                 'races', to_jsonb(h.race_ids), 'created_at', h.created_at) order by h.created_at desc)
               from handouts h), '[]'::jsonb),
    'races',  coalesce((select jsonb_agg(jsonb_build_object(
                 'id', r.id, 'name', r.name, 'date', r.race_date, 'note', r.note)
                 order by r.race_date desc nulls last, r.created_at desc)
               from races r), '[]'::jsonb),
    'items',  coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name)
                 order by i.sort, i.created_at)
               from items i), '[]'::jsonb));
end $$;

-- ---------- People ----------
-- p_id null = create. data: name, gym, level, size, date, note, items {id: true}, races [uuid]
create or replace function public.save_person(p_token uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _require_session(p_token);
  if p_id is null then
    insert into handouts (name, gym, level, size, given_on, note, items, race_ids)
    values (trim(coalesce(p_data ->> 'name', '')), trim(coalesce(p_data ->> 'gym', '')),
            coalesce(p_data ->> 'level', ''), coalesce(p_data ->> 'size', ''),
            nullif(p_data ->> 'date', '')::date, trim(coalesce(p_data ->> 'note', '')),
            _clean_items2(p_data -> 'items'), _clean_races(p_data -> 'races'))
    returning id into v_id;
  else
    update handouts set
      name = trim(coalesce(p_data ->> 'name', '')), gym = trim(coalesce(p_data ->> 'gym', '')),
      level = coalesce(p_data ->> 'level', ''), size = coalesce(p_data ->> 'size', ''),
      given_on = nullif(p_data ->> 'date', '')::date, note = trim(coalesce(p_data ->> 'note', '')),
      items = _clean_items2(p_data -> 'items'), race_ids = _clean_races(p_data -> 'races'),
      updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.toggle_item(p_token uuid, p_id uuid, p_item text, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  if not exists (select 1 from items where id = p_item) then raise exception 'not_found'; end if;
  update handouts
     set items = case when p_value then _clean_items2(items) || jsonb_build_object(p_item, true)
                      else _clean_items2(items) - p_item end,
         updated_at = now()
   where id = p_id;
end $$;

create or replace function public.toggle_race(p_token uuid, p_id uuid, p_race uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  if not exists (select 1 from races where id = p_race) then raise exception 'not_found'; end if;
  update handouts
     set race_ids = case when p_value then array(select distinct unnest(array_remove(race_ids, p_race) || p_race))
                         else array_remove(race_ids, p_race) end,
         updated_at = now()
   where id = p_id;
end $$;

create or replace function public.delete_person(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  delete from handouts where id = p_id;
end $$;

-- ---------- Races ----------
create or replace function public.save_race(p_token uuid, p_id uuid, p_name text, p_date date, p_note text)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _require_session(p_token);
  if exists (select 1 from races where lower(name) = lower(trim(coalesce(p_name, '')))
             and (p_id is null or id <> p_id)) then
    raise exception 'duplicate_name';
  end if;
  if p_id is null then
    insert into races (name, race_date, note)
    values (trim(coalesce(p_name, '')), p_date, trim(coalesce(p_note, '')))
    returning id into v_id;
  else
    update races set name = trim(coalesce(p_name, '')), race_date = p_date, note = trim(coalesce(p_note, ''))
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_race(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  update handouts set race_ids = array_remove(race_ids, p_id) where p_id = any(race_ids);
  delete from races where id = p_id;
end $$;

-- ---------- Items ----------
-- p_id null = create (an id is made from the name).
create or replace function public.save_item(p_token uuid, p_id text, p_name text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_id   text;
begin
  perform _require_session(p_token);
  if exists (select 1 from items where lower(name) = lower(v_name) and (p_id is null or id <> p_id)) then
    raise exception 'duplicate_name';
  end if;
  if p_id is null then
    v_id := left(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), 24);
    v_id := trim(both '-' from v_id);
    if v_id = '' or exists (select 1 from items where id = v_id) then
      v_id := 'i-' || substr(md5(gen_random_uuid()::text), 1, 10);
    end if;
    insert into items (id, name, sort)
    values (v_id, v_name, coalesce((select max(sort) from items), 0) + 1);
  else
    update items set name = v_name where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_item(p_token uuid, p_id text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  update handouts set items = items - p_id where items ? p_id;
  delete from items where id = p_id;
end $$;

-- ---------- Who may call what ----------
revoke execute on function
  public._clean_items2(jsonb), public._clean_races(jsonb), public.list_all(uuid),
  public.save_person(uuid, uuid, jsonb), public.toggle_item(uuid, uuid, text, boolean),
  public.toggle_race(uuid, uuid, uuid, boolean), public.delete_person(uuid, uuid),
  public.save_race(uuid, uuid, text, date, text), public.delete_race(uuid, uuid),
  public.save_item(uuid, text, text), public.delete_item(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.list_all(uuid), public.save_person(uuid, uuid, jsonb),
  public.toggle_item(uuid, uuid, text, boolean), public.toggle_race(uuid, uuid, uuid, boolean),
  public.delete_person(uuid, uuid), public.save_race(uuid, uuid, text, date, text),
  public.delete_race(uuid, uuid), public.save_item(uuid, text, text), public.delete_item(uuid, text)
to anon, authenticated;

-- The v1 functions are replaced by the ones above; stop the app from calling them.
revoke execute on function
  public.list_handouts(uuid), public.save_handout(uuid, uuid, jsonb),
  public.set_item(uuid, uuid, text, boolean), public.delete_handout(uuid, uuid),
  public.list_batch_notes(uuid), public.save_batch_note(uuid, text, text)
from public, anon, authenticated;
