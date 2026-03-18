-- Video Editor Database Schema for Supabase

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Assets table
CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT CHECK (type IN ('video', 'audio')),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  duration FLOAT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Edits table
CREATE TABLE IF NOT EXISTS edits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  params JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_assets_project_id ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_edits_project_id ON edits(project_id);

-- Row level security (optional - can be disabled for API access)
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE edits ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role access" ON projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role access" ON assets FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Service role access" ON edits FOR ALL USING (true) WITH CHECK (true);
