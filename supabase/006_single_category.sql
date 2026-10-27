-- Kit Log v6: one category per person. Run after 005. Safe to run more than once.
-- Function changes only (no tables), so it can run without a destructive-change prompt.

-- Ticking a category replaces any other; unticking clears it.
create or replace function public.toggle_category(p_token uuid, p_id uuid, p_name text, p_value boolean)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_name text;
begin
  perform _require_session(p_token);
  select name into v_name from categories where lower(name) = lower(trim(coalesce(p_name, '')));
  if v_name is null then raise exception 'not_found'; end if;
  update handouts
     set categories = case when p_value then array[v_name] else array_remove(categories, v_name) end,
         updated_at = now()
   where id = p_id;
end $$;

-- Same as v5, keeping only the first category sent.
create or replace function public.save_person(p_token uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid; v_cat text[];
begin
  perform _require_session(p_token);
  v_cat := (_clean_categories(case when jsonb_typeof(p_data -> 'categories') = 'array'
                                   then jsonb_build_array(p_data -> 'categories' -> 0) else '[]'::jsonb end));
  if p_id is null then
    insert into handouts (name, gym, categories, size, given_on, note, competitions, items)
    values (trim(coalesce(p_data ->> 'name', '')), trim(coalesce(p_data ->> 'gym', '')),
            v_cat, coalesce(p_data ->> 'size', ''),
            nullif(p_data ->> 'date', '')::date, trim(coalesce(p_data ->> 'note', '')),
            trim(coalesce(p_data ->> 'competitions', '')), _clean_items2(p_data -> 'items'))
    returning id into v_id;
  else
    update handouts set
      name = trim(coalesce(p_data ->> 'name', '')), gym = trim(coalesce(p_data ->> 'gym', '')),
      categories = v_cat, size = coalesce(p_data ->> 'size', ''),
      given_on = nullif(p_data ->> 'date', '')::date, note = trim(coalesce(p_data ->> 'note', '')),
      competitions = trim(coalesce(p_data ->> 'competitions', '')),
      items = _clean_items2(p_data -> 'items'), updated_at = now()
    where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

-- Bulk add keeps the first category of each row (the app only sends one).
-- People who already have several keep only the first.
update public.handouts set categories = categories[1:1] where cardinality(categories) > 1;

revoke execute on function public.toggle_category(uuid, uuid, text, boolean), public.save_person(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.toggle_category(uuid, uuid, text, boolean), public.save_person(uuid, uuid, jsonb)
  to anon, authenticated;
