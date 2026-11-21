-- Single-chart purchases for Nashville Chart Book (one-time payment per chart, no subscription).
-- Run once in the Supabase SQL editor (project: mason-douglas-tools). Safe to read first;
-- it only ADDS things, and nothing in the live app uses them until the new code ships.

-- 1. A counter of single charts the user has bought and not yet used.
--    Users can only READ this table (no update grant), so they cannot change it themselves.
alter table chart_book.subscriptions
  add column if not exists single_credits integer not null default 0;
alter table chart_book.subscriptions
  add constraint subscriptions_single_credits_nonneg check (single_credits >= 0);

-- 2. Jobs can now be paid for with a single-chart credit.
alter table chart_book.jobs drop constraint jobs_mode_check;
alter table chart_book.jobs add constraint jobs_mode_check
  check (mode = any (array['subscription'::text, 'trial'::text, 'credit'::text]));

-- 3. One row per paid Stripe checkout session. The primary key means a retried
--    webhook can never credit the same purchase twice.
create table chart_book.credit_purchases (
  stripe_session_id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  credits integer not null check (credits > 0),
  stripe_payment_intent text,
  created_at timestamptz not null default now()
);
alter table chart_book.credit_purchases enable row level security;
revoke all on chart_book.credit_purchases from anon, authenticated;
grant select, insert on chart_book.credit_purchases to service_role;

-- 4. Adds credits once per purchase. Only the server (service role) can call it.
create or replace function chart_book.add_single_credits(
  p_user uuid, p_session text, p_credits integer, p_payment_intent text
) returns boolean
language plpgsql
set search_path = chart_book, pg_temp
as $$
begin
  insert into chart_book.credit_purchases (stripe_session_id, user_id, credits, stripe_payment_intent)
  values (p_session, p_user, p_credits, p_payment_intent)
  on conflict (stripe_session_id) do nothing;
  if not found then
    return false; -- this purchase was already credited
  end if;
  insert into chart_book.subscriptions (user_id, status, single_credits)
  values (p_user, 'inactive', p_credits)
  on conflict (user_id) do update
    set single_credits = chart_book.subscriptions.single_credits + excluded.single_credits,
        updated_at = now();
  return true;
end;
$$;
revoke all on function chart_book.add_single_credits(uuid, text, integer, text) from public, anon, authenticated;
grant execute on function chart_book.add_single_credits(uuid, text, integer, text) to service_role;
