-- Fix for Supabase projects where pgcrypto functions live in the extensions schema.
-- Run this in Supabase SQL Editor if creating a room shows:
-- function gen_random_bytes(integer) does not exist

create extension if not exists pgcrypto with schema extensions;

create or replace function public.create_face_reveal_room()
returns table (room_id uuid, join_code text)
language plpgsql
security definer
set search_path = public, extensions
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
    v_code := upper(substr(encode(extensions.gen_random_bytes(5), 'hex'), 1, 8));

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

grant execute on function public.create_face_reveal_room() to authenticated;
