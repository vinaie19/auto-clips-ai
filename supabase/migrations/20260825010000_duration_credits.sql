-- Duration-based credits: charge 2/3/4 for 30/45/60s; free grant default 6.
-- reserve/refund accept p_amount; videos.credits_charged stores what was reserved.

alter table public.users
  alter column free_credits_remaining set default 6;

alter table public.videos
  add column if not exists credits_charged integer not null default 1
    check (credits_charged >= 1);

drop function if exists public.reserve_free_credit(uuid);
drop function if exists public.reserve_free_credit(uuid, integer);
drop function if exists public.refund_free_credit(uuid);
drop function if exists public.refund_free_credit(uuid, integer);

create or replace function public.reserve_free_credit(
  p_user_id uuid,
  p_amount integer default 1
)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_user public.users;
  amount integer := greatest(1, coalesce(p_amount, 1));
begin
  update public.users
  set
    free_credits_remaining = free_credits_remaining - amount,
    updated_at = now()
  where id = p_user_id
    and free_credits_remaining >= amount
  returning * into updated_user;

  if found then
    return updated_user;
  end if;

  return null;
end;
$$;

create or replace function public.refund_free_credit(
  p_user_id uuid,
  p_amount integer default 1
)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_user public.users;
  amount integer := greatest(1, coalesce(p_amount, 1));
begin
  update public.users
  set
    free_credits_remaining = free_credits_remaining + amount,
    updated_at = now()
  where id = p_user_id
  returning * into updated_user;

  if found then
    return updated_user;
  end if;

  return null;
end;
$$;

-- claim_render_job: refund credits_charged (not always 1) on max-attempts fail
drop function if exists public.claim_render_job(text, integer);
drop function if exists public.claim_render_job(text, int);

create function public.claim_render_job(
  p_worker_id text,
  p_lease_seconds int default 180
)
returns setof public.videos
language plpgsql
security definer
set search_path = public
as $$
declare
  job public.videos;
  new_attempts integer;
  refund_amount integer;
begin
  select * into job
  from public.videos
  where attempts < max_attempts
    and (
      status = 'pending'
      or (
        status in ('claimed', 'running')
        and next_visible_at is not null
        and next_visible_at <= now()
      )
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  if job.status in ('claimed', 'running') then
    new_attempts := job.attempts + 1;

    if new_attempts >= job.max_attempts then
      update public.videos
      set
        status = 'failed',
        error = coalesce(nullif(error, ''), 'max retries exceeded'),
        attempts = new_attempts,
        claimed_by = null,
        claimed_at = null,
        heartbeat_at = null,
        next_visible_at = null,
        expires_at = null,
        progress = null,
        updated_at = now()
      where id = job.id
      returning * into job;

      if job.credit_refunded = false then
        update public.videos
        set credit_refunded = true, updated_at = now()
        where id = job.id and credit_refunded = false;

        refund_amount := greatest(1, coalesce(job.credits_charged, 1));

        update public.users
        set
          free_credits_remaining = free_credits_remaining + refund_amount,
          updated_at = now()
        where id = job.user_id;
      end if;

      return;
    end if;
  else
    new_attempts := job.attempts;
  end if;

  update public.videos
  set
    status = 'claimed',
    claimed_by = p_worker_id,
    claimed_at = now(),
    heartbeat_at = now(),
    next_visible_at = now() + make_interval(secs => p_lease_seconds),
    expires_at = now() + make_interval(secs => p_lease_seconds),
    attempts = new_attempts,
    error = null,
    progress = 'claimed',
    updated_at = now()
  where id = job.id
  returning * into job;

  return next job;
end;
$$;

grant execute on function public.reserve_free_credit(uuid, integer) to service_role;
grant execute on function public.refund_free_credit(uuid, integer) to service_role;
grant execute on function public.claim_render_job(text, int) to service_role;
