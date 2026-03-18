import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL, fetchFile } from '@ffmpeg/util';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

function App() {
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [assets, setAssets] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const ffmpegRef = useRef(new FFmpeg());

  useEffect(() => {
    loadFFmpeg();
    fetchProjects();
  }, []);

  async function loadFFmpeg() {
    setStatus('Loading FFmpeg...');
    const ffmpeg = ffmpegRef.current;
    ffmpeg.on('log', ({ message }) => {
      console.log(message);
    });
    ffmpeg.on('progress', ({ progress }) => {
      setStatus(`Processing: ${Math.round(progress * 100)}%`);
    });

    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setFfmpegLoaded(true);
    setStatus('Ready');
  }

  async function fetchProjects() {
    const { data } = await supabase
      .from('projects')
      .select('*')
      .order('created_at', { ascending: false });
    setProjects(data || []);
  }

  async function createProject() {
    if (!projectName.trim()) return;
    const { data } = await supabase
      .from('projects')
      .insert({ name: projectName })
      .select()
      .single();
    if (data) {
      setProjects([data, ...projects]);
      setProjectName('');
    }
  }

  async function selectProject(project) {
    setCurrentProject(project);
    const { data } = await supabase
      .from('assets')
      .select('*')
      .eq('project_id', project.id)
      .order('created_at', { ascending: true });
    setAssets(data || []);
  }

  function getPublicUrl(bucket, path) {
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  async function uploadFile(e) {
    const file = e.target.files[0];
    if (!file || !currentProject) return;

    setLoading(true);
    setStatus('Uploading...');

    const ext = file.name.split('.').pop();
    const type = file.type.startsWith('video') ? 'video' : 'audio';
    const bucket = type === 'audio' ? 'audio' : 'videos';
    const storagePath = `${currentProject.id}/${Date.now()}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(bucket)
      .upload(storagePath, file);

    if (uploadErr) {
      setStatus('Upload failed: ' + uploadErr.message);
      setLoading(false);
      return;
    }

    const url = getPublicUrl(bucket, storagePath);

    // Get duration
    let duration = null;
    if (type === 'video') {
      duration = await getVideoDuration(file);
    }

    const { data: asset } = await supabase
      .from('assets')
      .insert({
        project_id: currentProject.id,
        type,
        filename: file.name,
        storage_path: storagePath,
        duration,
        url
      })
      .select()
      .single();

    if (asset) {
      setAssets([...assets, { ...asset, url }]);
    }

    setStatus('Uploaded!');
    setLoading(false);
    e.target.value = '';
  }

  function getVideoDuration(file) {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        resolve(video.duration);
        URL.revokeObjectURL(video.src);
      };
      video.src = URL.createObjectURL(file);
    });
  }

  async function cutVideo(asset) {
    const start = prompt('Start time (seconds):', '0');
    const end = prompt('End time (seconds):', String(asset.duration || 10));
    if (!start || !end) return;

    setLoading(true);
    setStatus('Cutting video...');

    const ffmpeg = ffmpegRef.current;
    const response = await fetch(asset.url);
    const data = new Uint8Array(await response.arrayBuffer());

    await ffmpeg.writeFile('input.mp4', data);
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-ss', start,
      '-to', end,
      '-c', 'copy',
      'output.mp4'
    ]);

    const output = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([output.buffer], { type: 'video/mp4' });

    await uploadResult(blob, 'cut', parseFloat(end) - parseFloat(start));
  }

  async function adjustVolume(asset) {
    const vol = prompt('Volume (0.0 = mute, 1.0 = normal, 2.0 = 2x):', '1.0');
    if (!vol) return;

    setLoading(true);
    setStatus('Adjusting volume...');

    const ffmpeg = ffmpegRef.current;
    const response = await fetch(asset.url);
    const data = new Uint8Array(await response.arrayBuffer());

    await ffmpeg.writeFile('input.mp4', data);
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-af', `volume=${vol}`,
      '-c:v', 'copy',
      'output.mp4'
    ]);

    const output = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([output.buffer], { type: 'video/mp4' });

    await uploadResult(blob, 'volume', asset.duration);
  }

  async function addText(asset) {
    const text = prompt('Text to overlay:');
    if (!text) return;
    const size = prompt('Font size:', '48');
    const color = prompt('Color:', 'white');
    const pos = prompt('Position (top/center/bottom):', 'center');

    setLoading(true);
    setStatus('Adding text overlay...');

    const ffmpeg = ffmpegRef.current;
    const response = await fetch(asset.url);
    const data = new Uint8Array(await response.arrayBuffer());

    const y = pos === 'top' ? '50' : pos === 'bottom' ? '(h-text_h-50)' : '(h-text_h)/2';

    await ffmpeg.writeFile('input.mp4', data);
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-vf', `drawtext=text='${text}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=${y}`,
      '-c:a', 'copy',
      'output.mp4'
    ]);

    const output = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([output.buffer], { type: 'video/mp4' });

    await uploadResult(blob, 'text', asset.duration);
  }

  async function removeDeadSpace(asset) {
    setLoading(true);
    setStatus('Analyzing audio for dead space...');

    const ffmpeg = ffmpegRef.current;
    const response = await fetch(asset.url);
    const data = new Uint8Array(await response.arrayBuffer());

    await ffmpeg.writeFile('input.mp4', data);

    // Extract audio for analysis
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-af', 'silencedetect=noise=-40dB:d=0.3',
      '-f', 'null', '-'
    ]);

    // For now, use aggressive silenceremove
    setStatus('Removing dead space...');
    await ffmpeg.exec([
      '-i', 'input.mp4',
      '-af', 'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB,silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-40dB',
      '-c:v', 'copy',
      'output.mp4'
    ]);

    const output = await ffmpeg.readFile('output.mp4');
    const blob = new Blob([output.buffer], { type: 'video/mp4' });

    await uploadResult(blob, 'deadspace-removed', null);
  }

  async function uploadResult(blob, suffix, duration) {
    const storagePath = `${currentProject.id}/${Date.now()}_${suffix}.mp4`;

    const { error } = await supabase.storage
      .from('videos')
      .upload(storagePath, blob);

    if (error) {
      setStatus('Upload failed: ' + error.message);
      setLoading(false);
      return;
    }

    const url = getPublicUrl('videos', storagePath);

    const { data: newAsset } = await supabase
      .from('assets')
      .insert({
        project_id: currentProject.id,
        type: 'video',
        filename: `${suffix}.mp4`,
        storage_path: storagePath,
        duration,
        url
      })
      .select()
      .single();

    if (newAsset) {
      setAssets(prev => [...prev, { ...newAsset, url }]);
    }

    setStatus('Done!');
    setLoading(false);
  }

  async function deleteAsset(asset) {
    if (!confirm('Delete this asset?')) return;
    
    const bucket = asset.type === 'audio' ? 'audio' : 'videos';
    await supabase.storage.from(bucket).remove([asset.storage_path]);
    await supabase.from('assets').delete().eq('id', asset.id);
    setAssets(assets.filter(a => a.id !== asset.id));
  }

  async function downloadAsset(asset) {
    const a = document.createElement('a');
    a.href = asset.url;
    a.download = asset.filename;
    a.click();
  }

  const styles = {
    app: { padding: '20px', fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '900px', margin: '0 auto', background: '#0a0a0a', minHeight: '100vh', color: '#fff' },
    header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' },
    title: { fontSize: '24px', fontWeight: '700' },
    status: { fontSize: '13px', color: '#888', padding: '4px 8px', background: '#1a1a1a', borderRadius: '4px' },
    input: { padding: '10px 14px', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', color: '#fff', fontSize: '14px', flex: 1 },
    btn: { padding: '10px 18px', background: '#333', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '14px', fontWeight: '500' },
    btnPrimary: { padding: '10px 18px', background: '#4f46e5', border: 'none', borderRadius: '8px', color: '#fff', cursor: 'pointer', fontSize: '14px', fontWeight: '500' },
    btnDanger: { padding: '6px 12px', background: '#dc2626', border: 'none', borderRadius: '6px', color: '#fff', cursor: 'pointer', fontSize: '12px' },
    card: { padding: '16px', background: '#141414', border: '1px solid #222', borderRadius: '10px', marginBottom: '12px' },
    row: { display: 'flex', gap: '10px', marginBottom: '16px', alignItems: 'center' },
    grid: { display: 'grid', gap: '12px' },
    video: { maxWidth: '100%', borderRadius: '8px', marginTop: '10px' },
    label: { fontSize: '12px', color: '#666', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px' },
    actions: { display: 'flex', gap: '6px', marginTop: '10px', flexWrap: 'wrap' },
    smallBtn: { padding: '6px 12px', background: '#222', border: '1px solid #333', borderRadius: '6px', color: '#fff', cursor: 'pointer', fontSize: '12px' },
  };

  return (
    <div style={styles.app}>
      <div style={styles.header}>
        <div style={styles.title}>🎬 Video Editor</div>
        <div style={styles.status}>{loading ? '⏳ ' : ''}{status}</div>
      </div>

      {!currentProject ? (
        <div>
          <div style={styles.row}>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="New project name..."
              style={styles.input}
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
            />
            <button onClick={createProject} style={styles.btnPrimary}>+ Create</button>
          </div>

          <div style={styles.label}>Projects</div>
          <div style={styles.grid}>
            {projects.map(p => (
              <div
                key={p.id}
                onClick={() => selectProject(p)}
                style={{ ...styles.card, cursor: 'pointer' }}
              >
                <strong>{p.name}</strong>
                <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                  {new Date(p.created_at).toLocaleDateString()}
                </div>
              </div>
            ))}
            {projects.length === 0 && <div style={{ color: '#666' }}>No projects yet</div>}
          </div>
        </div>
      ) : (
        <div>
          <button onClick={() => { setCurrentProject(null); setAssets([]); }} style={styles.btn}>
            ← Back
          </button>
          <h2 style={{ margin: '16px 0' }}>{currentProject.name}</h2>

          <div style={{ ...styles.card, marginBottom: '20px' }}>
            <div style={styles.label}>Upload</div>
            <input
              type="file"
              accept="video/*,audio/*"
              onChange={uploadFile}
              disabled={loading}
              style={{ color: '#fff' }}
            />
          </div>

          <div style={styles.label}>Assets ({assets.length})</div>
          <div style={styles.grid}>
            {assets.map(a => (
              <div key={a.id} style={styles.card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <strong>{a.filename}</strong>
                  <span style={{ fontSize: '12px', color: '#666' }}>
                    {a.type} {a.duration ? `• ${a.duration.toFixed(1)}s` : ''}
                  </span>
                </div>

                {a.type === 'video' && a.url && (
                  <video src={a.url} controls style={styles.video} />
                )}
                {a.type === 'audio' && a.url && (
                  <audio src={a.url} controls style={{ width: '100%', marginTop: '10px' }} />
                )}

                <div style={styles.actions}>
                  {a.type === 'video' && ffmpegLoaded && (
                    <>
                      <button onClick={() => cutVideo(a)} disabled={loading} style={styles.smallBtn}>✂️ Cut</button>
                      <button onClick={() => adjustVolume(a)} disabled={loading} style={styles.smallBtn}>🔊 Volume</button>
                      <button onClick={() => addText(a)} disabled={loading} style={styles.smallBtn}>✏️ Text</button>
                      <button onClick={() => removeDeadSpace(a)} disabled={loading} style={styles.smallBtn}>🔇 Remove Dead Space</button>
                    </>
                  )}
                  <button onClick={() => downloadAsset(a)} style={styles.smallBtn}>⬇️ Download</button>
                  <button onClick={() => deleteAsset(a)} style={styles.btnDanger}>🗑️</button>
                </div>
              </div>
            ))}
            {assets.length === 0 && <div style={{ color: '#666' }}>Upload a video to get started</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
