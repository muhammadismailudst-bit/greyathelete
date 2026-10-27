-- Kit Log v4: Category (الفئة) replaces Level. A person can have several categories.
-- Allowed: Qatari, Rx, Girls, Master, Fan, Bartender. Run after 003. Safe to run more than once.

alter table public.handouts add column if not exists categories text[] not null default '{}';

-- Keep only allowed categories, any case in, proper case out, no repeats.
create or replace function public._clean_categories(p jsonb)
returns text[] language sql immutable set search_path = pg_catalog as $$
  select coalesce(array_agg(c order by o), '{}')
  from unnest(array['Qatari', 'Rx', 'Girls', 'Master', 'Fan', 'Bartender']) with ordinality as a(c, o)
  where jsonb_typeof(p) = 'array'
    and exists (select 1 from jsonb_array_elements_text(p) x where lower(trim(x)) = lower(c));
$$;

create or replace function public.list_all(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', h.id, 'name', h.name, 'gym', h.gym, 'categories', to_jsonb(h.categories), 'size', h.size,
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

-- data: name, gym, categories [..], size, date, note, items {id: qty}, races [uuid]
create or replace function public.save_person(p_token uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _require_session(p_token);
  if p_id is null then
    insert into handouts (name, gym, categories, size, given_on, note, items, race_ids)
    values (trim(coalesce(p_data ->> 'name', '')), trim(coalesce(p_data ->> 'gym', '')),
            _clean_categories(p_data -> 'categories'), coalesce(p_data ->> 'size', ''),
            nullif(p_data ->> 'date', '')::date, trim(coalesce(p_data ->> 'note', '')),
            _clean_items2(p_data -> 'items'), _clean_races(p_data -> 'races'))
    returning id into v_id;
  else
    update handouts set
      name = trim(coalesce(p_data ->> 'name', '')), gym = trim(coalesce(p_data ->> 'gym', '')),
      categories = _clean_categories(p_data -> 'categories'), size = coalesce(p_data ->> 'size', ''),
      given_on = nullif(p_data ->> 'date', '')::date, note = trim(coalesce(p_data ->> 'note', '')),
      items = _clean_items2(p_data -> 'items'), race_ids = _clean_races(p_data -> 'races'),
      updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

-- Bulk add: same as v3, plus "categories": [..] instead of level.
create or replace function public.bulk_add_people(p_token uuid, p_people jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  p jsonb; e jsonb; v_name text; v_gym text; v_size text;
  v_items jsonb; v_races uuid[]; x text; v_id text; v_rid uuid; v_qty int;
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

    v_races := '{}';
    if jsonb_typeof(p -> 'races') = 'array' then
      for x in select jsonb_array_elements_text(p -> 'races') limit 50 loop
        v_rid := _ensure_race(x);
        if v_rid is not null and not v_rid = any(v_races) then v_races := v_races || v_rid; end if;
      end loop;
    end if;

    insert into handouts (name, gym, categories, size, note, items, race_ids)
    values (v_name, v_gym, _clean_categories(p -> 'categories'), v_size,
            left(trim(coalesce(p ->> 'note', '')), 1000), _clean_items2(v_items), v_races);
    n_added := n_added + 1;
  end loop;

  return jsonb_build_object('added', n_added, 'skipped', n_skipped);
end $$;

revoke execute on function public._clean_categories(jsonb) from public, anon, authenticated;
revoke execute on function public.list_all(uuid), public.save_person(uuid, uuid, jsonb),
  public.bulk_add_people(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.list_all(uuid), public.save_person(uuid, uuid, jsonb),
  public.bulk_add_people(uuid, jsonb) to anon, authenticated;
