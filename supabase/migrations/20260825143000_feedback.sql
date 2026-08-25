-- Public feedback / contact submissions for follow-up.

create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  phone text not null,
  message text not null,
  status text not null default 'new'
    check (status in ('new', 'responded', 'archived')),
  admin_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists feedback_status_created_at_idx
  on public.feedback (status, created_at desc);

comment on table public.feedback is
  'User feedback with contact details for manual follow-up.';

-- Service role from Next.js API routes bypasses RLS.
-- Keep RLS on so the anon key cannot read or write submissions.
alter table public.feedback enable row level security;
