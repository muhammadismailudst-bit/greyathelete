-- Kit Log v10: with Google sign-in, nothing needs to be callable while signed out.
-- Removes EXECUTE from PUBLIC and anon on every SECURITY DEFINER function in public
-- (each one also checks the signed-in user's role). Run after 009. Safe to run more than once.
-- Later migrations should grant new functions to `authenticated` only.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef loop
    execute format('revoke execute on function %s from public, anon', f.sig);
  end loop;
end $$;
-- Not used by the app since item quantities (set_item_qty replaced it).
revoke execute on function public.toggle_item(uuid, uuid, text, boolean) from authenticated;
