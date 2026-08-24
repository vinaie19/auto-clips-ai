-- Short Clips Supabase schema
-- Run this in the Supabase SQL editor before using the app.

create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  clerk_user_id text not null unique,
  free_credits_remaining integer not null default 6 check (free_credits_remaining >= 0),
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
  status text not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists videos_clerk_user_id_idx on public.videos (clerk_user_id);
create index if not exists videos_user_id_created_at_idx on public.videos (user_id, created_at desc);
create index if not exists videos_render_id_idx on public.videos (render_id);

-- Service role from Next.js API routes bypasses RLS.
-- Keep RLS enabled so the anon key cannot read other users' rows.
alter table public.users enable row level security;
alter table public.videos enable row level security;
