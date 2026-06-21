# Face Reveal

A simple mutual reveal app. Two people join the same private room, both upload an image, and the images unlock only after both uploads are complete.

## Stack

- Vite
- React
- TypeScript
- Supabase Auth
- Supabase Postgres
- Supabase Storage private bucket

## Supabase setup

1. Open your Supabase project.
2. Go to **Authentication → Sign In / Providers** and enable **Anonymous sign-ins**.
3. Go to the SQL editor and run the full file:

```txt
supabase/schema.sql
```

The SQL creates:

- `face_reveal_rooms`
- `face_reveal_participants`
- private Storage bucket `face-reveals`
- RPC functions for room creation, joining, upload completion, state loading, and Storage access checks
- Storage policies so images stay private until the reveal unlocks

## Local setup

Copy the env example:

```bash
cp .env.example .env.local
```

Fill in your Supabase values:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

Install and run:

```bash
npm install
npm run dev
```

## How it works

1. User A creates a room.
2. User A shares the generated link/code.
3. User B joins the room.
4. Each user uploads one image.
5. The database marks the room as `revealed` only after both users have uploaded.
6. The frontend receives image paths only after reveal.
7. Images are loaded through temporary signed URLs from the private bucket.

## Safety note

This is intended only for normal, consensual images. Do not use it for intimate images, harassment, impersonation, or uploading photos of someone without permission.
