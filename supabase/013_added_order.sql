-- Kit Log v13: each new athlete gets its own "added" time, even inside one bulk paste,
-- so "first added on top" keeps the pasted order. Run after 012. Safe to run more than once.
-- now() is fixed for a whole transaction; clock_timestamp() moves on for every row.
alter table public.handouts alter column created_at set default clock_timestamp();
