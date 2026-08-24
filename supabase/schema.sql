-- Short Clips Supabase schema
-- Run this in the Supabase SQL editor before using the app.
-- Also apply migrations under supabase/migrations/ for incremental updates.

create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  free_credits_remaining integer not null default 3 check (free_credits_remaining >= 0),
  is_premium boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  clerk_user_id text not null,
  prompt text not null,
  tone text,
  subtitle_theme text,
  script text,
  render_id text,
  video_url text,
  thumbnail_url text,
  status text not null default 'pending',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  next_visible_at timestamptz,
  claimed_by text,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  error text,
  progress text,
  credit_refunded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists videos_clerk_user_id_idx on public.videos (clerk_user_id);
create index if not exists videos_user_id_created_at_idx on public.videos (user_id, created_at desc);
create index if not exists videos_render_id_idx on public.videos (render_id);
create index if not exists videos_claim_idx on public.videos (status, next_visible_at);

comment on column public.videos.payload is 'Render inputs: script, pexelsUrls, tone, subtitleTheme, voice';

-- Service role from Next.js API routes bypasses RLS.
-- Keep RLS enabled so the anon key cannot read other users' rows.
alter table public.users enable row level security;
alter table public.videos enable row level security;

-- See supabase/migrations/ for:
-- claim_render_job, reserve_free_credit, refund_free_credit, grant_credits
-- (metered credits: no is_premium bypass on reserve/refund)
