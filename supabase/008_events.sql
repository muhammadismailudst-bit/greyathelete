-- Kit Log v8: Events tab. Run after 007. Safe to run more than once.
-- Dates and times are local (Qatar) wall-clock values. An event with no start time is all day.
-- ends_on is the last day (inclusive); null means a one-day event.

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (char_length(title) between 1 and 120),
  starts_on   date not null,
  ends_on     date check (ends_on is null or ends_on >= starts_on),
  start_time  time,
  end_time    time,
  location    text not null default '' check (char_length(location) <= 200),
  details     text not null default '' check (char_length(details) <= 4000),
  source_id   text unique,             -- Google Calendar event id, for imports
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.events enable row level security;
revoke all on public.events from public, anon, authenticated;

create or replace function public.list_events(p_token uuid)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', e.id, 'title', e.title, 'starts_on', e.starts_on, 'ends_on', e.ends_on,
      'start_time', to_char(e.start_time, 'HH24:MI'), 'end_time', to_char(e.end_time, 'HH24:MI'),
      'location', e.location, 'details', e.details)
    order by e.starts_on, e.start_time nulls first, e.title) from events e), '[]'::jsonb);
end $$;

-- p_id null = create. data: title, starts_on, ends_on, start_time, end_time, location, details
create or replace function public.save_event(p_token uuid, p_id uuid, p_data jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id uuid;
  v_start date := nullif(p_data ->> 'starts_on', '')::date;
  v_end   date := nullif(p_data ->> 'ends_on', '')::date;
  v_st    time := nullif(p_data ->> 'start_time', '')::time;
  v_et    time := nullif(p_data ->> 'end_time', '')::time;
begin
  perform _require_session(p_token);
  if v_start is null then raise exception 'bad_date'; end if;
  if v_end is not null and v_end <= v_start then v_end := null; end if;
  if v_st is null then v_et := null; end if;
  if p_id is null then
    insert into events (title, starts_on, ends_on, start_time, end_time, location, details)
    values (trim(coalesce(p_data ->> 'title', '')), v_start, v_end, v_st, v_et,
            trim(coalesce(p_data ->> 'location', '')), trim(coalesce(p_data ->> 'details', '')))
    returning id into v_id;
  else
    update events set title = trim(coalesce(p_data ->> 'title', '')), starts_on = v_start, ends_on = v_end,
           start_time = v_st, end_time = v_et, location = trim(coalesce(p_data ->> 'location', '')),
           details = trim(coalesce(p_data ->> 'details', '')), updated_at = now()
     where id = p_id returning id into v_id;
    if v_id is null then raise exception 'not_found'; end if;
  end if;
  return v_id;
end $$;

create or replace function public.delete_event(p_token uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_session(p_token);
  delete from events where id = p_id;
end $$;

revoke execute on function public.list_events(uuid), public.save_event(uuid, uuid, jsonb), public.delete_event(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.list_events(uuid), public.save_event(uuid, uuid, jsonb), public.delete_event(uuid, uuid)
  to anon, authenticated;

-- Imported from the "Grey Events" Google Calendar on 27 Oct 2026 (skipped if already imported).
insert into public.events (source_id, title, starts_on, ends_on, start_time, end_time, location, details) values
  ('9t3dubpekbiljcm1sngl3er0lo', 'Furkids x Snoonu Fundraiser', '2026-10-30', null, '08:00', '12:00', 'StrongBox Functional Fitness', 'Time approximate: morning.'),
  ('2gd47n7vcj657k25oh7t823hsc', 'Strongbox x Red Bull Halloween WOD', '2026-10-30', null, '18:00', '22:00', 'StrongBox Functional Fitness', 'Time approximate: evening.'),
  ('fdjflqlr5t1tt2i3b6g8l64jbk', 'Fortitude: FORTROX Fitness Race (teams of 2)', '2026-11-06', null, null, null, 'Fortitude, Al Samriya Estate', 'Fitness race with functional exercises between runs, teams of 2. Time TBC.'),
  ('nc7h8frodef8a9ifts10gav59c', 'SBX Super Series (Same Sex Pairs)', '2026-11-13', '2026-11-14', null, null, 'Strongbox Functional Fitness', ''),
  ('v7ahj0koukdqvq1i0d5b6f2h7o', 'Fortitude: Weekend at the Fort', '2026-11-20', '2026-11-21', null, null, 'Fortitude, Al Samriya Estate', 'Day 1 (Fri): weekend warrior team WOD, breakfast BBQ, kids activities, staycation / evening yoga. Day 2 (Sat, staycation clients only): morning run, breakfast, horse ride, yoga. Times TBC.'),
  ('duoc8s3mdrvo50itik6o4qj15s', 'The vault throwdown', '2026-12-04', null, '06:00', '22:00', 'The Vault Fitness', ''),
  ('q8sqgpb1vqui8crsff9opa0igs', 'Strongbox Gym Awards Evening', '2026-12-05', null, '18:00', '22:00', 'Strongbox Functional Fitness', 'Time approximate: evening.'),
  ('h1spcng3sdm53ju0croassfk3o', 'Fortitude: Thursday Night Lights (hybrid workout, teams of 3)', '2026-12-10', null, null, null, 'Fortitude, Al Samriya Estate', 'Time TBC (night event).'),
  ('fad8t0hb0tvrthlvvealnprduc', 'Quwwa OG Throwdown (Mixed Pairs)', '2026-12-11', null, null, null, '', ''),
  ('dqcf3sc4ji7ahi1gos08c7rs00', 'Fortitude: ARIES Battle of the Fort', '2027-01-29', null, null, null, 'Fortitude, Al Samriya Estate', 'Functional fitness competition sponsored by ARIES. Time TBC.'),
  ('kut1paig02ee5lukjkrd1mh1j0', 'Fortitude: Qatar Ultra Runners, Event 2', '2027-03-19', null, null, null, 'Fortitude, Al Samriya Estate', 'Time TBC.'),
  ('9b617i2q565pn8crchictksl6g', 'Fortitude: FORTROX Fitness Race (individual)', '2027-03-26', null, null, null, 'Fortitude, Al Samriya Estate', 'Individual fitness race with functional exercises between runs. Time TBC.'),
  ('pfn44prc080abqn1v36bn6bcmg', 'Fortitude: Weekend at the Fort', '2027-04-16', '2027-04-17', null, null, 'Fortitude, Al Samriya Estate', 'Day 1 (Fri): weekend warrior team WOD, breakfast BBQ, kids activities, staycation / evening yoga. Day 2 (Sat, staycation clients only): morning run, breakfast, yoga. Times TBC.')
on conflict (source_id) do nothing;
