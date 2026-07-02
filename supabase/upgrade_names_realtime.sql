-- Face Reveal upgrade: optional display names + realtime-friendly policies.
-- Run this once in Supabase SQL Editor.

alter table public.face_reveal_participants
add column if not exists display_name text;

create or replace function public.clean_face_reveal_name(p_name text)
returns text
language sql
stable
as $$
  select nullif(left(regexp_replace(coalesce(trim(p_name), ''), '[^[:alnum:] _.-]', '', 'g'), 32), '');
$$;

create or replace function public.set_face_reveal_display_name(p_room_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  v_name := public.clean_face_reveal_name(p_display_name);

  update public.face_reveal_participants
  set display_name = v_name
  where room_id = p_room_id
    and user_id = auth.uid();

  if not found then
    raise exception 'You are not part of this room';
  end if;
end;
$$;

grant execute on function public.set_face_reveal_display_name(uuid, text) to authenticated;

create or replace function public.is_face_reveal_member(p_room_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.face_reveal_participants p
    where p.room_id = p_room_id
      and p.user_id = auth.uid()
  );
$$;

grant execute on function public.is_face_reveal_member(uuid) to authenticated;

grant select on public.face_reveal_rooms to authenticated;
grant select on public.face_reveal_participants to authenticated;

drop policy if exists "Face Reveal members can read rooms" on public.face_reveal_rooms;
create policy "Face Reveal members can read rooms"
on public.face_reveal_rooms
for select
to authenticated
using (public.is_face_reveal_member(id));

drop policy if exists "Face Reveal members can read participants" on public.face_reveal_participants;
create policy "Face Reveal members can read participants"
on public.face_reveal_participants
for select
to authenticated
using (public.is_face_reveal_member(room_id));

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
        'isMe', p.user_id = auth.uid(),
        'displayName', coalesce(nullif(trim(p.display_name), ''), case when p.user_id = auth.uid() then 'You' else 'Guest' end)
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

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'face_reveal_rooms'
  ) then
    alter publication supabase_realtime add table public.face_reveal_rooms;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'face_reveal_participants'
  ) then
    alter publication supabase_realtime add table public.face_reveal_participants;
  end if;
end $$;
