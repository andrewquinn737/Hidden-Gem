-- Hidden Gem — schema
-- Source of truth mirrors the live Supabase project (ref sfncertevakntsfvovsz).
-- Applied via the Supabase Management API (this project's Supabase MCP tool is
-- scoped to a different org, so schema changes go through api.supabase.com
-- directly rather than through an MCP migration tool).
create extension if not exists pgcrypto;

-- ============================================================
-- Types
-- ============================================================
create type public.pin_visibility as enum ('private', 'public');
create type public.invite_status as enum ('pending', 'accepted', 'declined');
create type public.calendar_provider as enum ('google', 'apple_caldav');
create type public.friend_request_status as enum ('pending', 'accepted', 'declined');

-- ============================================================
-- Tables
-- ============================================================
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  full_name text,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now()
);

create table public.pins (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text,
  directions text,
  category text,
  lat double precision not null,
  lng double precision not null,
  visibility public.pin_visibility not null default 'private',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pins_owner_id_idx on public.pins(owner_id);
create index pins_visibility_idx on public.pins(visibility);

create table public.pin_photos (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references public.pins(id) on delete cascade,
  storage_path text not null,
  created_at timestamptz not null default now()
);
create index pin_photos_pin_id_idx on public.pin_photos(pin_id);

create table public.pin_likes (
  pin_id uuid not null references public.pins(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (pin_id, user_id)
);

create table public.pin_comments (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references public.pins(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);
create index pin_comments_pin_id_idx on public.pin_comments(pin_id);

-- Facebook-style request/accept friends, not one-directional follows.
create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status public.friend_request_status not null default 'pending',
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> recipient_id),
  unique (requester_id, recipient_id)
);
create index friend_requests_requester_idx on public.friend_requests(requester_id);
create index friend_requests_recipient_idx on public.friend_requests(recipient_id);

create table public.pin_invites (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references public.pins(id) on delete cascade,
  inviter_id uuid not null references public.profiles(id) on delete cascade,
  invitee_user_id uuid references public.profiles(id) on delete cascade,
  invitee_email text,
  invitee_phone text,
  token uuid not null default gen_random_uuid() unique,
  status public.invite_status not null default 'pending',
  created_at timestamptz not null default now(),
  expires_at timestamptz
  -- No not-null-one-of check here: a pure "share by link" invite with no
  -- pre-chosen recipient is valid — whoever holds the token claims it via
  -- accept_pin_invite() below.
);
create index pin_invites_pin_id_idx on public.pin_invites(pin_id);
create index pin_invites_invitee_user_id_idx on public.pin_invites(invitee_user_id);

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references public.pins(id) on delete cascade,
  organizer_id uuid not null references public.profiles(id) on delete cascade,
  scheduled_at timestamptz not null,
  notes text,
  created_at timestamptz not null default now()
);
create index visits_pin_id_idx on public.visits(pin_id);
create index visits_organizer_id_idx on public.visits(organizer_id);

create table public.visit_participants (
  id uuid primary key default gen_random_uuid(),
  visit_id uuid not null references public.visits(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  invite_email text,
  invite_phone text,
  token uuid not null default gen_random_uuid() unique,
  status public.invite_status not null default 'pending',
  google_event_id text,
  apple_event_uid text,
  created_at timestamptz not null default now(),
  check (user_id is not null or invite_email is not null or invite_phone is not null)
);
create index visit_participants_visit_id_idx on public.visit_participants(visit_id);
create index visit_participants_user_id_idx on public.visit_participants(user_id);

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider public.calendar_provider not null,
  credential_ciphertext text,
  credential_iv text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- ============================================================
-- Storage
-- Bucket 'media', paths: avatars/{user_id}/..., pins/{pin_id}/...
-- NOT public — access goes through RLS on storage.objects, so private pin
-- photos stay private (fetch via createSignedUrl(), gated by the same
-- pin_is_visible() logic as everything else).
-- ============================================================
insert into storage.buckets (id, name, public)
values ('media', 'media', false)
on conflict (id) do nothing;

-- ============================================================
-- Helper functions
-- Live in `private`, not `public`, so PostgREST does not auto-expose them
-- as callable /rest/v1/rpc/* endpoints (Supabase's security linter flags
-- any SECURITY DEFINER function sitting in an exposed schema). RLS policies
-- can still call them freely — schema placement doesn't limit what a policy
-- expression can reference, only what PostgREST publishes.
-- ============================================================
create schema if not exists private;
grant usage on schema private to anon, authenticated;

create or replace function private.is_pin_owner(p_pin_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, private
as $$
  select exists (
    select 1 from public.pins where id = p_pin_id and owner_id = auth.uid()
  );
$$;
grant execute on function private.is_pin_owner(uuid) to anon, authenticated;

-- Used to gate visibility of rows in OTHER tables that reference an existing,
-- already-committed pin (pin_photos, pin_likes, pin_comments, storage.objects).
-- Deliberately NOT used for pins' own SELECT policy — see note on pins_select
-- below for why a self-referential STABLE lookup there causes a real bug.
create or replace function private.pin_is_visible(p_pin_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, private
as $$
  select exists (
    select 1 from public.pins p
    where p.id = p_pin_id
    and (
      p.visibility = 'public'
      or p.owner_id = auth.uid()
      or exists (
        select 1 from public.pin_invites pi
        where pi.pin_id = p.id and pi.invitee_user_id = auth.uid() and pi.status = 'accepted'
      )
      or exists (
        select 1 from public.visit_participants vp
        join public.visits v on v.id = vp.visit_id
        where v.pin_id = p.id and vp.user_id = auth.uid()
      )
      or exists (
        select 1 from public.friend_requests fr
        where fr.status = 'accepted'
        and (
          (fr.requester_id = auth.uid() and fr.recipient_id = p.owner_id)
          or (fr.recipient_id = auth.uid() and fr.requester_id = p.owner_id)
        )
      )
    )
  );
$$;
grant execute on function private.pin_is_visible(uuid) to anon, authenticated;

-- Used by visit_participants' policy (checking a DIFFERENT, already-committed
-- visits row) and by RPCs. Not used for visits' own SELECT policy — same
-- self-reference issue as pins_select, see below.
create or replace function private.is_visit_participant(p_visit_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, private
as $$
  select exists (
    select 1 from public.visits v
    where v.id = p_visit_id
    and (
      v.organizer_id = auth.uid()
      or exists (select 1 from public.visit_participants vp where vp.visit_id = v.id and vp.user_id = auth.uid())
    )
  );
$$;
grant execute on function private.is_visit_participant(uuid) to anon, authenticated;

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  base_username text;
  final_username text;
  suffix int := 0;
begin
  -- 'user' as the final coalesce fallback matters for OAuth providers (e.g.
  -- Facebook) where a user can decline the email permission — without it,
  -- base_username could end up NULL and violate profiles.username NOT NULL.
  base_username := lower(regexp_replace(
    coalesce(
      new.raw_user_meta_data->>'username',
      split_part(new.email, '@', 1),
      new.raw_user_meta_data->>'name',
      new.raw_user_meta_data->>'full_name',
      'user'
    ),
    '[^a-z0-9_]', '', 'g'
  ));
  if base_username = '' then
    base_username := 'user';
  end if;
  final_username := base_username;
  while exists (select 1 from public.profiles where username = final_username) loop
    suffix := suffix + 1;
    final_username := base_username || suffix::text;
  end loop;
  insert into public.profiles (id, username, full_name, avatar_url)
  values (
    new.id,
    final_username,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = public, private
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger pins_set_updated_at
  before update on public.pins
  for each row execute function private.set_updated_at();

-- Narrow RPCs — the only functions meant to be publicly callable via
-- /rest/v1/rpc/*, so these stay in `public` and are granted explicitly.
create or replace function public.get_pin_invite_by_token(p_token uuid)
returns table (
  invite_id uuid, pin_id uuid, pin_title text, pin_description text, status public.invite_status
)
language sql
security definer
stable
set search_path = public
as $$
  select pi.id, pi.pin_id, p.title, p.description, pi.status
  from public.pin_invites pi
  join public.pins p on p.id = pi.pin_id
  where pi.token = p_token
  and (pi.expires_at is null or pi.expires_at > now());
$$;
grant execute on function public.get_pin_invite_by_token(uuid) to anon, authenticated;

create or replace function public.get_visit_invite_by_token(p_token uuid)
returns table (
  participant_id uuid, visit_id uuid, pin_title text, scheduled_at timestamptz, notes text, status public.invite_status
)
language sql
security definer
stable
set search_path = public
as $$
  select vp.id, v.id, p.title, v.scheduled_at, v.notes, vp.status
  from public.visit_participants vp
  join public.visits v on v.id = vp.visit_id
  join public.pins p on p.id = v.pin_id
  where vp.token = p_token;
$$;
grant execute on function public.get_visit_invite_by_token(uuid) to anon, authenticated;

create or replace function public.get_my_calendar_connections()
returns table (provider public.calendar_provider, connected_at timestamptz)
language sql
security definer
stable
set search_path = public
as $$
  select provider, created_at from public.calendar_connections where user_id = auth.uid();
$$;
grant execute on function public.get_my_calendar_connections() to authenticated;

-- Claim a pin_invites / visit_participants row by token — this is what
-- actually grants a link recipient (or emailed/texted invitee) access,
-- by attaching their auth.uid() to the row. SECURITY DEFINER so it runs
-- as the table owner and bypasses RLS for the UPDATE itself; the WHERE
-- clause (token match, not already claimed by someone else) is the real
-- access check, same "do the check inside the function" pattern as the
-- rest of this schema.
create or replace function public.accept_pin_invite(p_token uuid)
returns table (pin_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pin_id uuid;
begin
  update public.pin_invites
  set invitee_user_id = auth.uid(), status = 'accepted'
  where token = p_token
    and (expires_at is null or expires_at > now())
    and (invitee_user_id is null or invitee_user_id = auth.uid())
  returning pin_invites.pin_id into v_pin_id;

  if v_pin_id is null then
    raise exception 'Invite not found or expired';
  end if;

  return query select v_pin_id;
end;
$$;
grant execute on function public.accept_pin_invite(uuid) to authenticated;

create or replace function public.accept_visit_invite(p_token uuid)
returns table (visit_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit_id uuid;
begin
  update public.visit_participants
  set user_id = auth.uid(), status = 'accepted'
  where token = p_token
    and (user_id is null or user_id = auth.uid())
  returning visit_participants.visit_id into v_visit_id;

  if v_visit_id is null then
    raise exception 'Invite not found';
  end if;

  return query select v_visit_id;
end;
$$;
grant execute on function public.accept_visit_invite(uuid) to authenticated;

-- ============================================================
-- RLS
-- ============================================================
alter table public.profiles enable row level security;
create policy "profiles_select_all" on public.profiles for select using (true);
create policy "profiles_insert_self" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update_self" on public.profiles for update using (auth.uid() = id);
create policy "profiles_delete_self" on public.profiles for delete using (auth.uid() = id);

alter table public.pins enable row level security;
-- IMPORTANT: this checks pins' own columns directly (visibility, owner_id)
-- rather than calling a STABLE helper that re-queries `pins` by id. A STABLE
-- SECURITY DEFINER function takes its snapshot at the start of the statement,
-- so on INSERT ... RETURNING it can't see the row it's meant to be checking —
-- the insert then gets rejected as if invisible to its own creator. Confirmed
-- with a real insert-as-owner test during setup; keep this policy inlined.
create policy "pins_select" on public.pins for select using (
  visibility = 'public'
  or owner_id = auth.uid()
  or exists (
    select 1 from public.pin_invites pi
    where pi.pin_id = pins.id and pi.invitee_user_id = auth.uid() and pi.status = 'accepted'
  )
  or exists (
    select 1 from public.visit_participants vp
    join public.visits v on v.id = vp.visit_id
    where v.pin_id = pins.id and vp.user_id = auth.uid()
  )
  or exists (
    select 1 from public.friend_requests fr
    where fr.status = 'accepted'
    and (
      (fr.requester_id = auth.uid() and fr.recipient_id = pins.owner_id)
      or (fr.recipient_id = auth.uid() and fr.requester_id = pins.owner_id)
    )
  )
);
create policy "pins_insert_self" on public.pins for insert with check (owner_id = auth.uid());
create policy "pins_update_owner" on public.pins for update using (owner_id = auth.uid());
create policy "pins_delete_owner" on public.pins for delete using (owner_id = auth.uid());

alter table public.pin_photos enable row level security;
create policy "pin_photos_select" on public.pin_photos for select using (private.pin_is_visible(pin_id));
create policy "pin_photos_insert_owner" on public.pin_photos for insert with check (private.is_pin_owner(pin_id));
create policy "pin_photos_update_owner" on public.pin_photos for update using (private.is_pin_owner(pin_id));
create policy "pin_photos_delete_owner" on public.pin_photos for delete using (private.is_pin_owner(pin_id));

alter table public.pin_likes enable row level security;
create policy "pin_likes_select" on public.pin_likes for select using (private.pin_is_visible(pin_id));
create policy "pin_likes_insert_self" on public.pin_likes for insert with check (user_id = auth.uid() and private.pin_is_visible(pin_id));
create policy "pin_likes_delete_self" on public.pin_likes for delete using (user_id = auth.uid());

alter table public.pin_comments enable row level security;
create policy "pin_comments_select" on public.pin_comments for select using (private.pin_is_visible(pin_id));
create policy "pin_comments_insert_self" on public.pin_comments for insert with check (user_id = auth.uid() and private.pin_is_visible(pin_id));
create policy "pin_comments_update_self" on public.pin_comments for update using (user_id = auth.uid());
create policy "pin_comments_delete_self" on public.pin_comments for delete using (user_id = auth.uid());

alter table public.friend_requests enable row level security;
create policy "friend_requests_select_own" on public.friend_requests
  for select using (requester_id = auth.uid() or recipient_id = auth.uid());
create policy "friend_requests_insert_self" on public.friend_requests
  for insert with check (requester_id = auth.uid());
create policy "friend_requests_update_recipient_or_requester" on public.friend_requests
  for update using (requester_id = auth.uid() or recipient_id = auth.uid());
create policy "friend_requests_delete_own" on public.friend_requests
  for delete using (requester_id = auth.uid() or recipient_id = auth.uid());

alter table public.pin_invites enable row level security;
create policy "pin_invites_select_own" on public.pin_invites for select using (inviter_id = auth.uid() or invitee_user_id = auth.uid());
create policy "pin_invites_insert_owner" on public.pin_invites for insert with check (inviter_id = auth.uid() and private.is_pin_owner(pin_id));
create policy "pin_invites_update_participant" on public.pin_invites for update using (inviter_id = auth.uid() or invitee_user_id = auth.uid());
create policy "pin_invites_delete_inviter" on public.pin_invites for delete using (inviter_id = auth.uid());

alter table public.visits enable row level security;
-- Same self-reference caveat as pins_select above — inlined against visits'
-- own organizer_id column instead of re-querying visits via a STABLE helper,
-- so INSERT ... RETURNING works correctly for the organizer.
create policy "visits_select_participant" on public.visits for select using (
  organizer_id = auth.uid()
  or exists (
    select 1 from public.visit_participants vp
    where vp.visit_id = visits.id and vp.user_id = auth.uid()
  )
);
create policy "visits_insert_organizer" on public.visits for insert with check (organizer_id = auth.uid());
create policy "visits_update_organizer" on public.visits for update using (organizer_id = auth.uid());
create policy "visits_delete_organizer" on public.visits for delete using (organizer_id = auth.uid());

alter table public.visit_participants enable row level security;
create policy "visit_participants_select" on public.visit_participants for select using (
  user_id = auth.uid() or private.is_visit_participant(visit_id)
);
create policy "visit_participants_insert_organizer" on public.visit_participants for insert with check (
  exists (select 1 from public.visits v where v.id = visit_id and v.organizer_id = auth.uid())
);
create policy "visit_participants_update_self_or_organizer" on public.visit_participants for update using (
  user_id = auth.uid() or exists (select 1 from public.visits v where v.id = visit_id and v.organizer_id = auth.uid())
);
create policy "visit_participants_delete_organizer" on public.visit_participants for delete using (
  exists (select 1 from public.visits v where v.id = visit_id and v.organizer_id = auth.uid())
);

-- calendar_connections: intentionally NO policies for select/insert/update/delete.
-- Only service_role (edge functions, bypasses RLS) may touch this table directly.
-- Clients read status only via get_my_calendar_connections().
alter table public.calendar_connections enable row level security;

-- ============================================================
-- Storage RLS (bucket 'media', paths: avatars/{user_id}/..., pins/{pin_id}/...)
-- ============================================================
create policy "media_select_avatars" on storage.objects for select using (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars'
);
create policy "media_insert_own_avatar" on storage.objects for insert with check (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = auth.uid()::text
);
create policy "media_update_own_avatar" on storage.objects for update using (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = auth.uid()::text
);
create policy "media_delete_own_avatar" on storage.objects for delete using (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'avatars' and (storage.foldername(name))[2] = auth.uid()::text
);

create policy "media_select_pin_photos" on storage.objects for select using (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'pins'
  and private.pin_is_visible(((storage.foldername(name))[2])::uuid)
);
create policy "media_insert_pin_photos" on storage.objects for insert with check (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'pins'
  and private.is_pin_owner(((storage.foldername(name))[2])::uuid)
);
create policy "media_update_pin_photos" on storage.objects for update using (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'pins'
  and private.is_pin_owner(((storage.foldername(name))[2])::uuid)
);
create policy "media_delete_pin_photos" on storage.objects for delete using (
  bucket_id = 'media' and (storage.foldername(name))[1] = 'pins'
  and private.is_pin_owner(((storage.foldername(name))[2])::uuid)
);
