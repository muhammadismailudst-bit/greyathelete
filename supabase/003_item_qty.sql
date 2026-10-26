-- Kit Log v3: a quantity per item (e.g. T-shirt x2). Run after 002. Safe to run more than once.
-- Items on a person are stored as {item_id: qty}. Old "true" values count as 1.

-- Keep only items that still exist, with a whole-number quantity from 1 to 999.
create or replace function public._clean_items2(p jsonb)
returns jsonb language sql stable security definer set search_path = public, pg_catalog as $$
  select coalesce(jsonb_object_agg(i.id, q.qty), '{}'::jsonb)
  from items i
  cross join lateral (
    select case
      when p -> i.id = 'true'::jsonb then 1
      when jsonb_typeof(p -> i.id) = 'number' then least(greatest(floor((p ->> i.id)::numeric)::int, 0), 999)
      else 0 end as qty) q
  where jsonb_typeof(p) = 'object' and q.qty > 0;
$$;

-- Set how many of one item a person got. 0 removes it.
create or replace function public.set_item_qty(p_token uuid, p_id uuid, p_item text, p_qty int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_qty int := least(greatest(coalesce(p_qty, 0), 0), 999);
begin
  perform _require_session(p_token);
  if not exists (select 1 from items where id = p_item) then raise exception 'not_found'; end if;
  update handouts
     set items = case when v_qty > 0 then _clean_items2(items) || jsonb_build_object(p_item, v_qty)
                      else _clean_items2(items) - p_item end,
         updated_at = now()
   where id = p_id;
end $$;

-- Bulk add: items may be names ("Bag") or {"name": "T-shirt", "qty": 2}.
create or replace function public.bulk_add_people(p_token uuid, p_people jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  p jsonb; e jsonb; v_name text; v_gym text; v_level text; v_size text;
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
    v_level := coalesce(p ->> 'level', '');
    if v_level not in ('Beginner', 'Intermediate', 'Advanced') then v_level := ''; end if;
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

    insert into handouts (name, gym, level, size, note, items, race_ids)
    values (v_name, v_gym, v_level, v_size, left(trim(coalesce(p ->> 'note', '')), 1000), _clean_items2(v_items), v_races);
    n_added := n_added + 1;
  end loop;

  return jsonb_build_object('added', n_added, 'skipped', n_skipped);
end $$;

revoke execute on function public.set_item_qty(uuid, uuid, text, int), public.bulk_add_people(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.set_item_qty(uuid, uuid, text, int), public.bulk_add_people(uuid, jsonb)
  to anon, authenticated;
