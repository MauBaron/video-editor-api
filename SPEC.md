# Video Editor API — Project Spec

## Overview
A simple web-based video editor with API management. Upload videos, cut/trim, adjust volume, add music, export. Connected to Supabase for storage and project management.

## Tech Stack
- **Frontend**: React + Remotion (for preview/rendering)
- **Backend**: Node.js/Express API
- **Storage**: Supabase Storage (videos, audio)
- **Database**: Supabase (projects, edits history)
- **Video Processing**: FFmpeg (server-side)

## Features

### 1. Project Management
- Create new project
- List projects
- Get project details
- Delete project

### 2. Asset Upload
- Upload video files (MP4, MOV)
- Upload audio files (MP3, WAV)
- Files stored in Supabase Storage

### 3. Video Editing Operations
- **Cut/Trim**: Set start/end time for a clip
- **Concatenate**: Stitch multiple clips together
- **Volume**: Adjust audio level (0-200%)
- **Mute**: Remove audio from clip
- **Text Overlay**: Add text at specific timestamp with position/style

### 4. Rendering
- Export final video as MP4
- Returns download URL

## API Endpoints

```
Base URL: /api/v1

# Projects
POST   /projects          — Create project
GET    /projects          — List all projects
GET    /projects/:id      — Get project details
DELETE /projects/:id     — Delete project

# Assets
POST   /assets/upload     — Upload video/audio
GET    /assets/:id        — Get asset URL

# Edits
POST   /edits/cut         — Cut a clip (start, end, assetId)
POST   /edits/concat      — Concatenate clips
POST   /edits/volume      — Adjust volume
POST   /edits/text        — Add text overlay

# Render
POST   /render            — Render final video
GET    /render/:id/status — Check render status
GET    /render/:id/download — Download finished video
```

## Database Schema (Supabase)

```sql
-- projects table
create table projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

-- assets table
create table assets (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id),
  type text check (type in ('video', 'audio')),
  filename text not null,
  storage_path text not null,
  duration float,
  created_at timestamp with time zone default now()
);

-- edits table
create table edits (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id),
  type text not null,
  params jsonb not null,
  created_at timestamp with time zone default now()
);
```

## Storage Buckets (Supabase)
- `videos` — raw uploaded videos
- `audio` — uploaded audio files
- `exports` — rendered final videos

## Frontend UI (Simple)
- Project list view
- Editor view with:
  - Video preview (Remotion Player)
  - Timeline showing clips
  - Controls: Cut, Volume, Add Text, Add Audio
  - Export button

## Environment Variables
```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
PORT=3001
```

## Acceptance Criteria
1. Can create a project
2. Can upload a video and get URL back
3. Can cut a video (specify start/end)
4. Can adjust volume on a video
5. Can concatenate multiple clips
6. Can add text overlay
7. Can export and download final MP4
8. All data persists in Supabase
