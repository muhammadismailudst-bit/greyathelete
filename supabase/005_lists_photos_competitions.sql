-- Kit Log v5: editable category list, competitions as a note, fixed item list, athlete photos.
-- Run after 004. Safe to run more than once. Categories part:

-- Competitions: a free-text note per person (replaces the race tick list).
-- Races already ticked are copied in as text, once.
alter table public.handouts add column if not exists competitions text not null default ''
  check (char_length(competitions) <= 2000);
update public.handouts h
   set competitions = (select string_agg(r.name, ', ' order by r.race_date nulls last, r.name)
                         from public.races r where r.id = any(h.race_ids))
 where h.competitions = '' and cardinality(h.race_ids) > 0;

-- Photos: one small JPEG per person (resized in the browser), stored as a data URL.
create table if not exists public.photos (
  person_id   uuid primary key references public.handouts(id) on delete cascade,
  data        text not null check (data like 'data:image/jpeg;base64,%' and char_length(data) <= 300000),
  updated_at  timestamptz not null default now()
);
alter table public.photos enable row level security;
revoke all on public.photos from public, anon, authenticated;

-- Items: exactly Hand band, Flag, Badge, T-shirt.
update public.items set name = 'Hand band' where id = 'headband';
insert into public.items (id, name, sort) values
  ('headband', 'Hand band', 1), ('flag', 'Flag', 2), ('badge', 'Badge', 3), ('tshirt', 'T-shirt', 4)
on conflict (id) do update set sort = excluded.sort;
update public.handouts set items = items - array(select id from public.items
  where id not in ('headband', 'flag', 'badge', 'tshirt'));
delete from public.items where id not in ('headband', 'flag', 'badge', 'tshirt');

-- Categories:
create table if not exists public.categories (
  name        text primary key check (char_length(name) between 1 and 40),
  sort        int not null default 0,
  created_at  timestamptz not null default now()
);
create unique index if not exists categories_name_key on public.categories (lower(name));
alter table public.categories enable row level security;
revoke all on public.categories from public, anon, authenticated;

insert into public.categories (name, sort) values
  ('Qatari', 1), ('Rx', 2), ('Girls', 3), ('Master', 4), ('Fan', 5), ('Bartender', 6)
on conflict do nothing;

-- Keep only categories that exist (any case in, stored spelling out), in list order.
create or replace function public._clean_categories(p jsonb)
returns text[] language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(array_agg(c.name order by c.sort, c.created_at), '{}')
  from categories c
  where jsonb_typeof(p) = 'array'
    and exists (select 1 from jsonb_array_elements_text(p) x where lower(trim(x)) = lower(c.name));
$$;

-- Find a category by name (any case), creating it if missing.
create or replace function public._ensure_category(p_name text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_name text := left(trim(coalesce(p_name, '')), 40); v_found text;
begin
  if v_name = '' then return null; end if;
  select name into v_found from categories where lower(name) = lower(v_name);
  if v_found is null then
    insert into categories (name, sort) values (v_name, coalesce((select max(sort) from categories), 0) + 1)
      on conflict do nothing;
    select name into v_found from categories where lower(name) = lower(v_name);
  end if;
  return v_found;
end $$;

create or replace function public.list_all(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', h.id, 'name', h.name, 'gym', h.gym,
                 'categories', to_jsonb(_clean_categories(to_jsonb(h.categories))), 'size', h.size,
                 'date', h.given_on, 'note', h.note, 'competitions', h.competitions,
                 'items', _clean_items2(h.items),
                 'photo', (select ph.updated_at from photos ph where ph.person_id = h.id),
                 'created_at', h.created_at) order by h.created_at desc)
               from handouts h), '[]'::jsonb),
    'items',  coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name)
                 order by i.sort, i.created_at)
               from items i), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(c.name order by c.sort, c.created_at) from categories c), '[]'::jsonb));
end $$;

-- Tick or untick one category on a person.
create or replace function public.toggle_category(p_token uuid, p_id uuid, p_name text, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  perform _require_session(p_token);
  select name into v_name from categories where lower(name) = lower(trim(coalesce(p_name, '')));
  if v_name is null then raise exception 'not_found'; end if;
  update handouts
     set categories = case when p_value
                           then _clean_categories(to_jsonb(array_remove(categories, v_name) || v_name))
                           else array_remove(categories, v_name) end,
         updated_at = now()
   where id = p_id;
end $$;

-- p_old null = add. Otherwise rename (people keep it under the new name).
create or replace function public.save_category(p_token uuid, p_old text, p_name text)
returns text language plpgsql security definer set search_path = public, extensions as $$
declare v_name text := left(trim(coalesce(p_name, '')), 40); v_old text;
begin
  perform _require_session(p_token);
  if v_name = '' then raise exception 'bad_name'; end if;
  if p_old is not null then
    select name into v_old from categories where name = p_old;
    if v_old is null then raise exception 'not_found'; end if;
  end if;
  if exists (select 1 from categories where lower(name) = lower(v_name) and name is distinct from v_old) then
    raise exception 'duplicate_name';
  end if;
  if v_old is null then
    insert into categories (name, sort) values (v_name, coalesce((select max(sort) from categories), 0) + 1);
  elsif v_old <> v_name then
    update categories set name = v_name where name = v_old;
    update handouts set categories = array_replace(categories, v_old, v_name) where v_old = any(categories);
  end if;
  return v_name;
end $$;

create or replace function public.delete_category(p_token uuid, p_name text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  update handouts set categories = array_remove(categories, p_name) where p_name = any(categories);
  delete from categories where name = p_name;
end $$;

-- Bulk add: same as v4, but new category names are added to the list.
create or replace function public.bulk_add_people(p_token uuid, p_people jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  p jsonb; e jsonb; v_name text; v_gym text; v_size text;
  v_items jsonb; v_cats text[]; x text; v_id text; v_qty int;
  n_added int := 0; n_skipped int := 0;
begin
  perform _require_session(p_token);
  if jsonb_typeof(p_people) <> 'array' then raise exception 'bad_input'; end if;
  if jsonb_array_length(p_people) > 500 then raise exception 'too_many_rows'; end if;

  for p in select * from jsonb_array_elements(p_people) loop
    v_name := left(trim(coalesce(p ->> 'name', '')), 80);
    if v_name = '' then n_skipped := n_skipped + 1; continue; end if;
    v_gym := left(trim(coalesce(p ->> 'gym', '')), 80);
    if exists (select 1 from handouts where lower(name) = lower(v_name) and lower(gym) = lower(v_gym)) then
      n_skipped := n_skipped + 1; continue;
    end if;
    v_size := upper(coalesce(p ->> 'size', ''));
    if v_size not in ('XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL') then v_size := ''; end if;

    v_cats := '{}';
    if jsonb_typeof(p -> 'categories') = 'array' then
      for x in select jsonb_array_elements_text(p -> 'categories') limit 20 loop
        x := _ensure_category(x);
        if x is not null and not x = any(v_cats) then v_cats := v_cats || x; end if;
      end loop;
    end if;

    v_items := '{}'::jsonb;
    if jsonb_typeof(p -> 'items') = 'array' then
      for e in select * from jsonb_array_elements(p -> 'items') limit 50 loop
        if jsonb_typeof(e) = 'object' then
          x := e ->> 'name';
          v_qty := case when jsonb_typeof(e -> 'qty') = 'number' then floor((e ->> 'qty')::numeric)::int else 1 end;
        else
          x := e #>> '{}'; v_qty := 1;
        end if;
        v_qty := least(greatest(v_qty, 0), 999);
        if v_qty = 0 then continue; end if;
        v_id := _ensure_item(x);
        if v_id is not null then
          v_items := v_items || jsonb_build_object(v_id, coalesce((v_items ->> v_id)::int, 0) + v_qty);
        end if;
      end loop;
    end if;

    insert into handouts (name, gym, categories, size, note, competitions, items)
    values (v_name, v_gym, _clean_categories(to_jsonb(v_cats)), v_size,
            left(trim(coalesce(p ->> 'note', '')), 1000), left(trim(coalesce(p ->> 'competitions', '')), 2000),
            _clean_items2(v_items));
    n_added := n_added + 1;
  end loop;

  return jsonb_build_object('added', n_added, 'skipped', n_skipped);
end $$;

-- data: name, gym, categories [..], size, date, note, competitions, items {id: 1}
create or replace function public.save_person(p_token uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _require_session(p_token);
  if p_id is null then
    insert into handouts (name, gym, categories, size, given_on, note, competitions, items)
    values (trim(coalesce(p_data ->> 'name', '')), trim(coalesce(p_data ->> 'gym', '')),
            _clean_categories(p_data -> 'categories'), coalesce(p_data ->> 'size', ''),
            nullif(p_data ->> 'date', '')::date, trim(coalesce(p_data ->> 'note', '')),
            trim(coalesce(p_data ->> 'competitions', '')), _clean_items2(p_data -> 'items'))
    returning id into v_id;
  else
    update handouts set
      name = trim(coalesce(p_data ->> 'name', '')), gym = trim(coalesce(p_data ->> 'gym', '')),
      categories = _clean_categories(p_data -> 'categories'), size = coalesce(p_data ->> 'size', ''),
      given_on = nullif(p_data ->> 'date', '')::date, note = trim(coalesce(p_data ->> 'note', '')),
      competitions = trim(coalesce(p_data ->> 'competitions', '')),
      items = _clean_items2(p_data -> 'items'), updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

-- Photos. p_data null removes the photo.
create or replace function public.set_photo(p_token uuid, p_id uuid, p_data text)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  if not exists (select 1 from handouts where id = p_id) then raise exception 'not_found'; end if;
  if p_data is null then
    delete from photos where person_id = p_id;
  else
    if p_data not like 'data:image/jpeg;base64,%' or char_length(p_data) > 300000
       or substr(p_data, 24) !~ '^[A-Za-z0-9+/]+={0,2}$' then
      raise exception 'bad_photo';
    end if;
    insert into photos (person_id, data) values (p_id, p_data)
      on conflict (person_id) do update set data = excluded.data, updated_at = now();
  end if;
end $$;

-- p_ids: which photos to fetch (the app asks only for ones it hasn't cached). Max 100 per call.
create or replace function public.get_photos(p_token uuid, p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return coalesce((select jsonb_object_agg(person_id, data)
                     from photos where person_id = any(p_ids[1:100])), '{}'::jsonb);
end $$;

revoke execute on function public.save_person(uuid, uuid, jsonb), public.set_photo(uuid, uuid, text),
  public.get_photos(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.save_person(uuid, uuid, jsonb), public.set_photo(uuid, uuid, text),
  public.get_photos(uuid, uuid[]) to anon, authenticated;

-- The race tick list is gone from the app; stop it from being called.
revoke execute on function public.toggle_race(uuid, uuid, uuid, boolean), public.save_race(uuid, uuid, text, date, text),
  public.delete_race(uuid, uuid) from public, anon, authenticated;

revoke execute on function public._clean_categories(jsonb), public._ensure_category(text),
  public.list_all(uuid), public.toggle_category(uuid, uuid, text, boolean),
  public.save_category(uuid, text, text), public.delete_category(uuid, text),
  public.bulk_add_people(uuid, jsonb)
from public, anon, authenticated;
grant execute on function public.list_all(uuid), public.toggle_category(uuid, uuid, text, boolean),
  public.save_category(uuid, text, text), public.delete_category(uuid, text),
  public.bulk_add_people(uuid, jsonb)
to anon, authenticated;
