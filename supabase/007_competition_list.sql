-- Kit Log v7: competitions become a multiple-choice list again (stored in the races table,
-- linked through handouts.race_ids), with add / rename / delete. Run after 006. Safe to run more than once.

-- Turn any typed competition notes into list entries, then clear the note.
do $$
declare h record; x text; v_rid uuid;
begin
  for h in select id, competitions from public.handouts where competitions <> '' loop
    for x in select trim(t) from regexp_split_to_table(h.competitions, '[,;\n]') t loop
      continue when x = '';
      select id into v_rid from public.races where lower(name) = lower(left(x, 60));
      if v_rid is null then insert into public.races (name) values (left(x, 60)) returning id into v_rid; end if;
      update public.handouts set race_ids = array_append(array_remove(race_ids, v_rid), v_rid) where id = h.id;
    end loop;
    update public.handouts set competitions = '' where id = h.id;
  end loop;
end $$;

create or replace function public.list_all(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return jsonb_build_object(
    'people', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', h.id, 'name', h.name, 'gym', h.gym,
                 'categories', to_jsonb(_clean_categories(to_jsonb(h.categories))), 'size', h.size,
                 'date', h.given_on, 'note', h.note,
                 'competitions', to_jsonb(array(select r.id from races r where r.id = any(h.race_ids))),
                 'items', _clean_items2(h.items),
                 'photo', (select ph.updated_at from photos ph where ph.person_id = h.id),
                 'created_at', h.created_at) order by h.created_at desc)
               from handouts h), '[]'::jsonb),
    'competitions', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name)
                 order by r.created_at, r.name) from races r), '[]'::jsonb),
    'items',  coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name)
                 order by i.sort, i.created_at)
               from items i), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(c.name order by c.sort, c.created_at) from categories c), '[]'::jsonb));
end $$;

-- data: name, gym, categories [one], size, date, note, competitions [race ids], items {id: 1}
create or replace function public.save_person(p_token uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_cat text[];
begin
  perform _require_session(p_token);
  v_cat := (_clean_categories(case when jsonb_typeof(p_data -> 'categories') = 'array'
                                   then jsonb_build_array(p_data -> 'categories' -> 0) else '[]'::jsonb end));
  if p_id is null then
    insert into handouts (name, gym, categories, size, given_on, note, race_ids, items)
    values (trim(coalesce(p_data ->> 'name', '')), trim(coalesce(p_data ->> 'gym', '')),
            v_cat, coalesce(p_data ->> 'size', ''),
            nullif(p_data ->> 'date', '')::date, trim(coalesce(p_data ->> 'note', '')),
            _clean_races(p_data -> 'competitions'), _clean_items2(p_data -> 'items'))
    returning id into v_id;
  else
    update handouts set
      name = trim(coalesce(p_data ->> 'name', '')), gym = trim(coalesce(p_data ->> 'gym', '')),
      categories = v_cat, size = coalesce(p_data ->> 'size', ''),
      given_on = nullif(p_data ->> 'date', '')::date, note = trim(coalesce(p_data ->> 'note', '')),
      race_ids = _clean_races(p_data -> 'competitions'),
      items = _clean_items2(p_data -> 'items'), updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

-- Bulk add: competitions are names; new ones are added to the list.
create or replace function public.bulk_add_people(p_token uuid, p_people jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  p jsonb; e jsonb; v_name text; v_gym text; v_size text;
  v_items jsonb; v_cats text[]; v_races uuid[]; x text; v_id text; v_rid uuid; v_qty int;
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
      for x in select jsonb_array_elements_text(p -> 'categories') limit 1 loop
        x := _ensure_category(x);
        if x is not null then v_cats := array[x]; end if;
      end loop;
    end if;

    v_races := '{}';
    if jsonb_typeof(p -> 'competitions') = 'array' then
      for x in select jsonb_array_elements_text(p -> 'competitions') limit 50 loop
        v_rid := _ensure_race(x);
        if v_rid is not null and not v_rid = any(v_races) then v_races := v_races || v_rid; end if;
      end loop;
    end if;

    v_items := '{}'::jsonb;
    if jsonb_typeof(p -> 'items') = 'array' then
      for e in select * from jsonb_array_elements(p -> 'items') limit 50 loop
        x := case when jsonb_typeof(e) = 'object' then e ->> 'name' else e #>> '{}' end;
        v_id := _ensure_item(x);
        if v_id is not null then v_items := v_items || jsonb_build_object(v_id, 1); end if;
      end loop;
    end if;

    insert into handouts (name, gym, categories, size, note, race_ids, items)
    values (v_name, v_gym, v_cats, v_size, left(trim(coalesce(p ->> 'note', '')), 1000),
            v_races, _clean_items2(v_items));
    n_added := n_added + 1;
  end loop;

  return jsonb_build_object('added', n_added, 'skipped', n_skipped);
end $$;

revoke execute on function public.list_all(uuid), public.save_person(uuid, uuid, jsonb),
  public.bulk_add_people(uuid, jsonb), public.toggle_race(uuid, uuid, uuid, boolean),
  public.save_race(uuid, uuid, text, date, text), public.delete_race(uuid, uuid)
from public, anon, authenticated;
grant execute on function public.list_all(uuid), public.save_person(uuid, uuid, jsonb),
  public.bulk_add_people(uuid, jsonb), public.toggle_race(uuid, uuid, uuid, boolean),
  public.save_race(uuid, uuid, text, date, text), public.delete_race(uuid, uuid)
to anon, authenticated;
