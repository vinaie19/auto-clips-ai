-- Self-hosted render queue: extend videos + claim/credit RPCs

alter table public.videos
  add column if not exists attempts integer not null default 0,
  add column if not exists max_attempts integer not null default 3,
  add column if not exists next_visible_at timestamptz,
  add column if not exists claimed_by text,
  add column if not exists claimed_at timestamptz,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists payload jsonb not null default '{}'::jsonb,
  add column if not exists error text,
  add column if not exists progress text,
  add column if not exists credit_refunded boolean not null default false;

update public.videos set status = 'pending' where status = 'queued';

alter table public.videos alter column status set default 'pending';

create index if not exists videos_claim_idx
  on public.videos (status, next_visible_at);

comment on column public.videos.payload is 'Render inputs: script, pexelsUrls, tone, subtitleTheme, voice';

-- Atomic credit reserve (returns updated row or no rows if none left)
create or replace function public.reserve_free_credit(p_user_id uuid)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_user public.users;
begin
  update public.users
  set
    free_credits_remaining = free_credits_remaining - 1,
    updated_at = now()
  where id = p_user_id
    and is_premium = false
    and free_credits_remaining > 0
  returning * into updated_user;

  if found then
    return updated_user;
  end if;

  select * into updated_user from public.users where id = p_user_id;
  if found and updated_user.is_premium then
    return updated_user;
  end if;

  return null;
end;
$$;

-- Refund one free credit (idempotent caller should gate via videos.credit_refunded)
create or replace function public.refund_free_credit(p_user_id uuid)
returns public.users
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_user public.users;
begin
  update public.users
  set
    free_credits_remaining = free_credits_remaining + 1,
    updated_at = now()
  where id = p_user_id
    and is_premium = false
  returning * into updated_user;

  if found then
    return updated_user;
  end if;

  select * into updated_user from public.users where id = p_user_id;
  return updated_user;
end;
$$;

-- Claim next render job (SKIP LOCKED). Returns 0 rows when idle.
-- SETOF avoids PostgREST turning SQL NULL composites into {id: null, ...}.
create or replace function public.claim_render_job(
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

        update public.users
        set
          free_credits_remaining = free_credits_remaining + 1,
          updated_at = now()
        where id = job.user_id
          and is_premium = false;
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

grant execute on function public.reserve_free_credit(uuid) to service_role;
grant execute on function public.refund_free_credit(uuid) to service_role;
grant execute on function public.claim_render_job(text, int) to service_role;
