-- Face Reveal MVP schema
-- Run this in the Supabase SQL editor.

create extension if not exists pgcrypto;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'face-reveals',
  'face-reveals',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

create table if not exists public.face_reveal_rooms (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  join_code text not null unique,
  status text not null default 'open' check (status in ('open', 'revealed', 'expired')),
  created_at timestamptz not null default now(),
  revealed_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours'
);

create table if not exists public.face_reveal_participants (
  room_id uuid not null references public.face_reveal_rooms(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slot text not null check (slot in ('a', 'b')),
  image_path text,
  uploaded_at timestamptz,
  joined_at timestamptz not null default now(),

  primary key (room_id, user_id),
  unique (room_id, slot)
);

create index if not exists face_reveal_rooms_join_code_idx
on public.face_reveal_rooms (join_code);

create index if not exists face_reveal_participants_room_idx
on public.face_reveal_participants (room_id);

alter table public.face_reveal_rooms enable row level security;
alter table public.face_reveal_participants enable row level security;

-- Keep base tables private. The frontend talks through security definer RPC functions.
revoke all on public.face_reveal_rooms from anon, authenticated;
revoke all on public.face_reveal_participants from anon, authenticated;

create or replace function public.create_face_reveal_room()
returns table (room_id uuid, join_code text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_code text;
  v_attempts int := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  loop
    v_code := upper(substr(encode(gen_random_bytes(5), 'hex'), 1, 8));

    begin
      insert into public.face_reveal_rooms (created_by, join_code)
      values (auth.uid(), v_code)
      returning id into v_room_id;
      exit;
    exception when unique_violation then
      v_attempts := v_attempts + 1;
      if v_attempts > 8 then
        raise exception 'Could not create a unique room code';
      end if;
    end;
  end loop;

  insert into public.face_reveal_participants (room_id, user_id, slot)
  values (v_room_id, auth.uid(), 'a');

  return query select v_room_id, v_code;
end;
$$;

create or replace function public.join_face_reveal_room(p_join_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room_id uuid;
  v_count int;
  v_slot text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select id
  into v_room_id
  from public.face_reveal_rooms
  where join_code = upper(trim(p_join_code))
    and expires_at > now()
    and status = 'open'
  for update;

  if v_room_id is null then
    raise exception 'Room not found or expired';
  end if;

  if exists (
    select 1
    from public.face_reveal_participants
    where room_id = v_room_id
      and user_id = auth.uid()
  ) then
    return v_room_id;
  end if;

  select count(*)
  into v_count
  from public.face_reveal_participants
  where room_id = v_room_id;

  if v_count >= 2 then
    raise exception 'Room is full';
  end if;

  if exists (
    select 1
    from public.face_reveal_participants
    where room_id = v_room_id
      and slot = 'a'
  ) then
    v_slot := 'b';
  else
    v_slot := 'a';
  end if;

  insert into public.face_reveal_participants (room_id, user_id, slot)
  values (v_room_id, auth.uid(), v_slot);

  return v_room_id;
end;
$$;

create or replace function public.complete_face_upload(p_room_id uuid, p_image_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_participant_count int;
  v_uploaded_count int;
  v_expected_prefix text;
  v_room_status text;
  v_expires_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_expected_prefix := p_room_id::text || '/' || auth.uid()::text || '/';

  if left(p_image_path, length(v_expected_prefix)) <> v_expected_prefix then
    raise exception 'Invalid image path';
  end if;

  select status, expires_at
  into v_room_status, v_expires_at
  from public.face_reveal_rooms
  where id = p_room_id
  for update;

  if v_room_status is null then
    raise exception 'Room not found';
  end if;

  if v_expires_at <= now() then
    update public.face_reveal_rooms
    set status = 'expired'
    where id = p_room_id
      and status = 'open';

    raise exception 'Room expired';
  end if;

  if v_room_status <> 'open' then
    raise exception 'Room is not open';
  end if;

  if not exists (
    select 1
    from public.face_reveal_participants
    where room_id = p_room_id
      and user_id = auth.uid()
  ) then
    raise exception 'You are not part of this room';
  end if;

  update public.face_reveal_participants
  set image_path = p_image_path,
      uploaded_at = now()
  where room_id = p_room_id
    and user_id = auth.uid()
    and image_path is null;

  if not found then
    raise exception 'Image already uploaded';
  end if;

  select count(*)
  into v_participant_count
  from public.face_reveal_participants
  where room_id = p_room_id;

  select count(*)
  into v_uploaded_count
  from public.face_reveal_participants
  where room_id = p_room_id
    and image_path is not null;

  if v_participant_count = 2 and v_uploaded_count = 2 then
    update public.face_reveal_rooms
    set status = 'revealed',
        revealed_at = now()
    where id = p_room_id
      and status = 'open';
  end if;
end;
$$;

create or replace function public.get_face_reveal_room_state(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.face_reveal_rooms%rowtype;
  v_my_slot text;
  v_my_uploaded boolean;
  v_participant_count int;
  v_status text;
  v_is_revealed boolean;
  v_participants jsonb;
  v_image_paths jsonb;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.face_reveal_rooms
  set status = 'expired'
  where id = p_room_id
    and status = 'open'
    and expires_at <= now();

  select *
  into v_room
  from public.face_reveal_rooms
  where id = p_room_id;

  if v_room.id is null then
    raise exception 'Room not found';
  end if;

  select slot, image_path is not null
  into v_my_slot, v_my_uploaded
  from public.face_reveal_participants
  where room_id = p_room_id
    and user_id = auth.uid();

  if v_my_slot is null then
    raise exception 'You are not part of this room';
  end if;

  select count(*)
  into v_participant_count
  from public.face_reveal_participants
  where room_id = p_room_id;

  v_status := v_room.status;
  v_is_revealed := v_status = 'revealed';

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slot', p.slot,
        'uploaded', p.image_path is not null,
        'isMe', p.user_id = auth.uid()
      )
      order by p.slot
    ),
    '[]'::jsonb
  )
  into v_participants
  from public.face_reveal_participants p
  where p.room_id = p_room_id;

  if v_is_revealed then
    select coalesce(jsonb_agg(p.image_path order by p.slot), '[]'::jsonb)
    into v_image_paths
    from public.face_reveal_participants p
    where p.room_id = p_room_id
      and p.image_path is not null;
  else
    v_image_paths := '[]'::jsonb;
  end if;

  return jsonb_build_object(
    'roomId', v_room.id,
    'joinCode', v_room.join_code,
    'status', v_status,
    'mySlot', v_my_slot,
    'myUploaded', v_my_uploaded,
    'bothJoined', v_participant_count = 2,
    'isRevealed', v_is_revealed,
    'revealedAt', v_room.revealed_at,
    'expiresAt', v_room.expires_at,
    'participants', v_participants,
    'imagePaths', v_image_paths
  );
end;
$$;

create or replace function public.can_upload_face_reveal_object(p_object_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
begin
  if v_uid is null then
    return false;
  end if;

  if split_part(p_object_name, '/', 2) <> v_uid::text then
    return false;
  end if;

  begin
    v_room_id := split_part(p_object_name, '/', 1)::uuid;
  exception when others then
    return false;
  end;

  return exists (
    select 1
    from public.face_reveal_participants p
    join public.face_reveal_rooms r on r.id = p.room_id
    where p.room_id = v_room_id
      and p.user_id = v_uid
      and p.image_path is null
      and r.status = 'open'
      and r.expires_at > now()
  );
end;
$$;

create or replace function public.can_read_face_reveal_object(p_object_name text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return false;
  end if;

  -- A user can read their own uploaded object.
  if split_part(p_object_name, '/', 2) = v_uid::text then
    return true;
  end if;

  -- A participant can read the other object only after the room is revealed.
  return exists (
    select 1
    from public.face_reveal_participants uploaded
    join public.face_reveal_rooms room on room.id = uploaded.room_id
    join public.face_reveal_participants me on me.room_id = uploaded.room_id
    where uploaded.image_path = p_object_name
      and me.user_id = v_uid
      and room.status = 'revealed'
  );
end;
$$;

create or replace function public.expire_old_face_reveal_rooms()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update public.face_reveal_rooms
  set status = 'expired'
  where status = 'open'
    and expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.create_face_reveal_room() to authenticated;
grant execute on function public.join_face_reveal_room(text) to authenticated;
grant execute on function public.complete_face_upload(uuid, text) to authenticated;
grant execute on function public.get_face_reveal_room_state(uuid) to authenticated;
grant execute on function public.can_upload_face_reveal_object(text) to authenticated;
grant execute on function public.can_read_face_reveal_object(text) to authenticated;
grant execute on function public.expire_old_face_reveal_rooms() to authenticated;

-- Storage policies
DROP POLICY IF EXISTS "Face Reveal uploads are private" ON storage.objects;
DROP POLICY IF EXISTS "Face Reveal reads only after unlock" ON storage.objects;

create policy "Face Reveal uploads are private"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'face-reveals'
  and public.can_upload_face_reveal_object(name)
);

create policy "Face Reveal reads only after unlock"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'face-reveals'
  and public.can_read_face_reveal_object(name)
);
