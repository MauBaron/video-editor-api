import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set FFmpeg path
ffmpeg.setFfmpegPath('/opt/homebrew/bin/ffmpeg');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/temp', express.static('temp'));

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'temp/');
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Initialize buckets
async function initBuckets() {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const bucketNames = buckets?.map(b => b.name) || [];
    
    if (!bucketNames.includes('videos')) {
      await supabase.storage.createBucket('videos', { public: true });
    }
    if (!bucketNames.includes('audio')) {
      await supabase.storage.createBucket('audio', { public: true });
    }
    if (!bucketNames.includes('exports')) {
      await supabase.storage.createBucket('exports', { public: true });
    }
    console.log('Buckets initialized');
  } catch (err) {
    console.log('Bucket init skipped:', err.message);
  }
}

// ============ ROUTES ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ PROJECTS ============

// Create project
app.post('/api/v1/projects', async (req, res) => {
  try {
    const { name } = req.body;
    const id = uuidv4();
    
    const { data, error } = await supabase
      .from('projects')
      .insert({ id, name })
      .select()
      .single();
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List projects
app.get('/api/v1/projects', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get project
app.get('/api/v1/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('*')
      .eq('id', id)
      .single();
    
    if (projErr) throw projErr;
    
    const { data: assets } = await supabase
      .from('assets')
      .select('*')
      .eq('project_id', id);
    
    const { data: edits } = await supabase
      .from('edits')
      .select('*')
      .eq('project_id', id);
    
    res.json({ project, assets, edits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete project
app.delete('/api/v1/projects/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Delete assets first
    await supabase.from('assets').delete().eq('project_id', id);
    await supabase.from('edits').delete().eq('project_id', id);
    await supabase.from('projects').delete().eq('id', id);
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ASSETS ============

// Upload asset
app.post('/api/v1/assets/upload', upload.single('file'), async (req, res) => {
  try {
    const { projectId, type } = req.body;
    const file = req.file;
    
    if (!file) throw new Error('No file uploaded');
    
    const bucket = type === 'audio' ? 'audio' : 'videos';
    const fileName = `${projectId}/${uuidv4()}${path.extname(file.originalname)}`;
    
    // Upload to Supabase
    const fileBuffer = fs.readFileSync(file.path);
    const { error: uploadErr } = await supabase.storage
      .from(bucket)
      .upload(fileName, fileBuffer);
    
    if (uploadErr) throw uploadErr;
    
    // Get public URL
    const { data: { publicUrl } } = supabase.storage
      .from(bucket)
      .getPublicUrl(fileName);
    
    // Get duration for videos
    let duration = null;
    if (type === 'video') {
      duration = await getVideoDuration(file.path);
    }
    
    // Save to database
    const { data: asset, error: dbErr } = await supabase
      .from('assets')
      .insert({
        project_id: projectId,
        type,
        filename: file.originalname,
        storage_path: fileName,
        duration
      })
      .select()
      .single();
    
    // Clean up temp file
    fs.unlinkSync(file.path);
    
    res.json({
      ...asset,
      url: publicUrl
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get asset URL
app.get('/api/v1/assets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: asset, error } = await supabase
      .from('assets')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    
    const { data: { publicUrl } } = supabase.storage
      .from(asset.type === 'audio' ? 'audio' : 'videos')
      .getPublicUrl(asset.storage_path);
    
    res.json({ ...asset, url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ EDITS ============

// Cut video
app.post('/api/v1/edits/cut', async (req, res) => {
  try {
    const { assetId, start, end, projectId } = req.body;
    
    // Get asset info
    const { data: asset } = await supabase
      .from('assets')
      .select('*')
      .eq('id', assetId)
      .single();
    
    // Download source
    const tempInput = `temp/${uuidv4()}_input.mp4`;
    await downloadAsset(asset.storage_path, 'videos', tempInput);
    
    // Cut with FFmpeg
    const tempOutput = `temp/${uuidv4()}_cut.mp4`;
    await cutVideo(tempInput, tempOutput, start, end);
    
    // Upload result
    const fileName = `${projectId}/${uuidv4()}_cut.mp4`;
    const fileBuffer = fs.readFileSync(tempOutput);
    await supabase.storage.from('videos').upload(fileName, fileBuffer);
    
    const { data: { publicUrl } } = supabase.storage
      .from('videos')
      .getPublicUrl(fileName);
    
    // Save edit
    const { data: newAsset } = await supabase
      .from('assets')
      .insert({
        project_id: projectId,
        type: 'video',
        filename: 'cut.mp4',
        storage_path: fileName,
        duration: end - start
      })
      .select()
      .single();
    
    // Save edit record
    await supabase.from('edits').insert({
      project_id: projectId,
      type: 'cut',
      params: { assetId, start, end }
    });
    
    // Cleanup
    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);
    
    res.json({ ...newAsset, url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Adjust volume
app.post('/api/v1/edits/volume', async (req, res) => {
  try {
    const { assetId, volume, projectId } = req.body;
    
    const { data: asset } = await supabase
      .from('assets')
      .select('*')
      .eq('id', assetId)
      .single();
    
    const tempInput = `temp/${uuidv4()}_input.mp4`;
    await downloadAsset(asset.storage_path, 'videos', tempInput);
    
    const tempOutput = `temp/${uuidv4()}_vol.mp4`;
    await adjustVolume(tempInput, tempOutput, volume);
    
    const fileName = `${projectId}/${uuidv4()}_vol.mp4`;
    const fileBuffer = fs.readFileSync(tempOutput);
    await supabase.storage.from('videos').upload(fileName, fileBuffer);
    
    const { data: { publicUrl } } = supabase.storage
      .from('videos')
      .getPublicUrl(fileName);
    
    const { data: newAsset } = await supabase
      .from('assets')
      .insert({
        project_id: projectId,
        type: 'video',
        filename: 'volume.mp4',
        storage_path: fileName,
        duration: asset.duration
      })
      .select()
      .single();
    
    await supabase.from('edits').insert({
      project_id: projectId,
      type: 'volume',
      params: { assetId, volume }
    });
    
    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);
    
    res.json({ ...newAsset, url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Concatenate clips
app.post('/api/v1/edits/concat', async (req, res) => {
  try {
    const { assetIds, projectId } = req.body;
    
    // Get all assets
    const { data: assets } = await supabase
      .from('assets')
      .select('*')
      .in('id', assetIds);
    
    // Download all
    const tempFiles = [];
    for (const asset of assets) {
      const tempFile = `temp/${uuidv4()}_input.mp4`;
      await downloadAsset(asset.storage_path, 'videos', tempFile);
      tempFiles.push(tempFile);
    }
    
    // Concat with FFmpeg
    const tempOutput = `temp/${uuidv4()}_concat.mp4`;
    await concatVideos(tempFiles, tempOutput);
    
    const fileName = `${projectId}/${uuidv4()}_concat.mp4`;
    const fileBuffer = fs.readFileSync(tempOutput);
    await supabase.storage.from('videos').upload(fileName, fileBuffer);
    
    const { data: { publicUrl } } = supabase.storage
      .from('videos')
      .getPublicUrl(fileName);
    
    const totalDuration = assets.reduce((sum, a) => sum + (a.duration || 0), 0);
    
    const { data: newAsset } = await supabase
      .from('assets')
      .insert({
        project_id: projectId,
        type: 'video',
        filename: 'concat.mp4',
        storage_path: fileName,
        duration: totalDuration
      })
      .select()
      .single();
    
    await supabase.from('edits').insert({
      project_id: projectId,
      type: 'concat',
      params: { assetIds }
    });
    
    // Cleanup
    tempFiles.forEach(f => fs.unlinkSync(f));
    fs.unlinkSync(tempOutput);
    
    res.json({ ...newAsset, url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add text overlay
app.post('/api/v1/edits/text', async (req, res) => {
  try {
    const { assetId, text, position, fontSize, color, projectId } = req.body;
    
    const { data: asset } = await supabase
      .from('assets')
      .select('*')
      .eq('id', assetId)
      .single();
    
    const tempInput = `temp/${uuidv4()}_input.mp4`;
    await downloadAsset(asset.storage_path, 'videos', tempInput);
    
    const tempOutput = `temp/${uuidv4()}_text.mp4`;
    await addTextOverlay(tempInput, tempOutput, { text, position, fontSize, color });
    
    const fileName = `${projectId}/${uuidv4()}_text.mp4`;
    const fileBuffer = fs.readFileSync(tempOutput);
    await supabase.storage.from('videos').upload(fileName, fileBuffer);
    
    const { data: { publicUrl } } = supabase.storage
      .from('videos')
      .getPublicUrl(fileName);
    
    const { data: newAsset } = await supabase
      .from('assets')
      .insert({
        project_id: projectId,
        type: 'video',
        filename: 'text.mp4',
        storage_path: fileName,
        duration: asset.duration
      })
      .select()
      .single();
    
    await supabase.from('edits').insert({
      project_id: projectId,
      type: 'text',
      params: { assetId, text, position, fontSize, color }
    });
    
    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);
    
    res.json({ ...newAsset, url: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ RENDER ============

app.post('/api/v1/render', async (req, res) => {
  try {
    const { assetId, projectId } = req.body;
    
    const { data: asset } = await supabase
      .from('assets')
      .select('*')
      .eq('id', assetId)
      .single();
    
    const tempInput = `temp/${uuidv4()}_input.mp4`;
    await downloadAsset(asset.storage_path, 'videos', tempInput);
    
    const tempOutput = `temp/${uuidv4()}_export.mp4`;
    
    // Simple render (just copy)
    await new Promise((resolve, reject) => {
      ffmpeg(tempInput)
        .output(tempOutput)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    const fileName = `${projectId}/${uuidv4()}_export.mp4`;
    const fileBuffer = fs.readFileSync(tempOutput);
    await supabase.storage.from('exports').upload(fileName, fileBuffer);
    
    const { data: { publicUrl } } = supabase.storage
      .from('exports')
      .getPublicUrl(fileName);
    
    fs.unlinkSync(tempInput);
    fs.unlinkSync(tempOutput);
    
    res.json({ url: publicUrl, status: 'completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ HELPERS ============

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

async function downloadAsset(storagePath, bucket, destPath) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .download(storagePath);
  
  if (error) throw error;
  
  const buffer = Buffer.from(await data.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

function cutVideo(input, output, start, end) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .setStartTime(start)
      .setDuration(end - start)
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function adjustVolume(input, output, volume) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .volume(volume)
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function concatVideos(inputs, output) {
  return new Promise((resolve, reject) => {
    let command = ffmpeg();
    inputs.forEach(input => command = command.input(input));
    command
      .complexFilter('concat=n=' + inputs.length + ':v=1:a=1')
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

function addTextOverlay(input, output, opts) {
  const { text, position = 'center', fontSize = 24, color = 'white' } = opts;
  const x = position === 'center' ? '(w-text_w)/2' : position === 'top' ? '(w-text_w)/2' : '10';
  const y = position === 'center' ? '(h-text_h)/2' : position === 'top' ? '10' : '(h-text_h)-10';
  
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .complexFilter(`drawtext=text='${text}':fontsize=${fontSize}:fontcolor=${color}:x=${x}:y=${y}`)
      .output(output)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Start server
app.listen(PORT, async () => {
  console.log(`Video Editor API running on port ${PORT}`);
  await initBuckets();
});
