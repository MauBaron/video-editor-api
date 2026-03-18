# Video Editor API

A simple video editor with API management, connected to Supabase.

## Quick Start

### 1. Setup Supabase

1. Create a new Supabase project at https://supabase.com
2. Go to SQL Editor and run `database/schema.sql`
3. Get your credentials:
   - Project URL (Settings → API)
   - anon key (Settings → API → Project API keys)
   - service_role key (Settings → API → Project API keys)

### 2. Setup Backend

```bash
cd video-editor
cp .env.example .env
# Edit .env with your Supabase credentials

npm install
npm start
```

Server runs on http://localhost:3001

### 3. Setup Frontend

```bash
cd client
cp .env.example .env
# Edit .env with your Supabase credentials
# Set VITE_API_URL=http://localhost:3001/api/v1

npm install
npm run dev
```

Frontend runs on http://localhost:5173

## API Endpoints

```
POST   /api/v1/projects          — Create project
GET    /api/v1/projects          — List projects
GET    /api/v1/projects/:id      — Get project details
DELETE /api/v1/projects/:id     — Delete project

POST   /api/v1/assets/upload     — Upload video/audio
GET    /api/v1/assets/:id        — Get asset URL

POST   /api/v1/edits/cut         — Cut video
POST   /api/v1/edits/volume      — Adjust volume
POST   /api/v1/edits/concat      — Concatenate clips
POST   /api/v1/edits/text        — Add text overlay

POST   /api/v1/render            — Export final video
```

## Features

- ✅ Project management
- ✅ Video/audio upload to Supabase Storage
- ✅ Cut/trim videos
- ✅ Adjust volume
- ✅ Concatenate clips
- ✅ Add text overlays
- ✅ Export final video

## To Add

- Music/audio layering
- Transitions
- More text styling
- Timeline UI
