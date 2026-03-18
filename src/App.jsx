import { useState, useEffect, useRef } from 'react';
import { createClient } from '@supabase/supabase-js';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseAnonKey);

function App() {
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [assets, setAssets] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('Ready');
  const [progress, setProgress] = useState(0);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const ffmpegRef = useRef(new FFmpeg());
  const videoRef = useRef(null);

  useEffect(() => {
    loadFFmpeg();
    fetchProjects();
  }, []);

  async function loadFFmpeg() {
    setStatus('Loading FFmpeg engine...');
    const ffmpeg = ffmpegRef.current;
    ffmpeg.on('log', ({ message }) => console.log(message));
    ffmpeg.on('progress', ({ progress: p }) => {
      setProgress(Math.round(p * 100));
      setStatus(`Processing: ${Math.round(p * 100)}%`);
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
    const { data } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    setProjects(data || []);
  }

  async function createProject() {
    if (!projectName.trim()) return;
    const { data } = await supabase.from('projects').insert({ name: projectName }).select().single();
    if (data) { setProjects([data, ...projects]); setProjectName(''); }
  }

  async function deleteProject(e, project) {
    e.stopPropagation();
    if (!confirm(`Delete "${project.name}"?`)) return;
    await supabase.from('assets').delete().eq('project_id', project.id);
    await supabase.from('projects').delete().eq('id', project.id);
    setProjects(projects.filter(p => p.id !== project.id));
  }

  async function selectProject(project) {
    setCurrentProject(project);
    const { data } = await supabase.from('assets').select('*').eq('project_id', project.id).order('created_at', { ascending: true });
    setAssets(data || []);
    setSelectedAsset(null);
    setPreviewUrl(null);
  }

  function getPublicUrl(bucket, path) {
    return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  async function uploadFile(e) {
    const file = e.target.files[0];
    if (!file || !currentProject) return;
    setLoading(true); setStatus('Uploading...');
    const ext = file.name.split('.').pop();
    const type = file.type.startsWith('video') ? 'video' : 'audio';
    const bucket = type === 'audio' ? 'audio' : 'videos';
    const storagePath = `${currentProject.id}/${Date.now()}.${ext}`;
    const { error: uploadErr } = await supabase.storage.from(bucket).upload(storagePath, file);
    if (uploadErr) { setStatus('Upload failed: ' + uploadErr.message); setLoading(false); return; }
    const url = getPublicUrl(bucket, storagePath);
    let duration = null;
    if (type === 'video') duration = await getVideoDuration(file);
    const { data: asset } = await supabase.from('assets').insert({ project_id: currentProject.id, type, filename: file.name, storage_path: storagePath, duration, url }).select().single();
    if (asset) setAssets(prev => [...prev, { ...asset, url }]);
    setStatus('Ready'); setLoading(false); e.target.value = '';
  }

  function getVideoDuration(file) {
    return new Promise(resolve => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => { resolve(v.duration); URL.revokeObjectURL(v.src); };
      v.src = URL.createObjectURL(file);
    });
  }

  function selectAssetForPreview(asset) {
    setSelectedAsset(asset);
    setPreviewUrl(asset.url);
  }

  async function cutVideo(asset) {
    const start = prompt('Start time (seconds):', '0');
    const end = prompt('End time (seconds):', String(Math.floor(asset.duration || 10)));
    if (!start || !end) return;
    setLoading(true); setStatus('Cutting...');
    const ffmpeg = ffmpegRef.current;
    const resp = await fetch(asset.url);
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await resp.arrayBuffer()));
    await ffmpeg.exec(['-i', 'input.mp4', '-ss', start, '-to', end, '-c', 'copy', 'output.mp4']);
    const output = await ffmpeg.readFile('output.mp4');
    await uploadResult(new Blob([output.buffer], { type: 'video/mp4' }), `cut_${start}-${end}`, parseFloat(end) - parseFloat(start));
  }

  async function adjustVolume(asset) {
    const vol = prompt('Volume (0.0=mute, 1.0=normal, 2.0=2x):', '1.0');
    if (!vol) return;
    setLoading(true); setStatus('Adjusting volume...');
    const ffmpeg = ffmpegRef.current;
    const resp = await fetch(asset.url);
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await resp.arrayBuffer()));
    await ffmpeg.exec(['-i', 'input.mp4', '-af', `volume=${vol}`, '-c:v', 'copy', 'output.mp4']);
    const output = await ffmpeg.readFile('output.mp4');
    await uploadResult(new Blob([output.buffer], { type: 'video/mp4' }), `vol_${vol}`, asset.duration);
  }

  async function addText(asset) {
    const text = prompt('Text:');
    if (!text) return;
    const size = prompt('Size:', '48');
    const color = prompt('Color:', 'white');
    setLoading(true); setStatus('Adding text...');
    const ffmpeg = ffmpegRef.current;
    const resp = await fetch(asset.url);
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await resp.arrayBuffer()));
    await ffmpeg.exec(['-i', 'input.mp4', '-vf', `drawtext=text='${text}':fontsize=${size}:fontcolor=${color}:x=(w-text_w)/2:y=(h-text_h)/2`, '-c:a', 'copy', 'output.mp4']);
    const output = await ffmpeg.readFile('output.mp4');
    await uploadResult(new Blob([output.buffer], { type: 'video/mp4' }), 'text', asset.duration);
  }

  async function removeDeadSpace(asset) {
    setLoading(true); setStatus('Removing dead space...');
    const ffmpeg = ffmpegRef.current;
    const resp = await fetch(asset.url);
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await resp.arrayBuffer()));
    await ffmpeg.exec(['-i', 'input.mp4', '-af', 'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB,silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-40dB', '-c:v', 'copy', 'output.mp4']);
    const output = await ffmpeg.readFile('output.mp4');
    await uploadResult(new Blob([output.buffer], { type: 'video/mp4' }), 'no-dead-space', null);
  }

  async function uploadResult(blob, suffix, duration) {
    const storagePath = `${currentProject.id}/${Date.now()}_${suffix}.mp4`;
    const { error } = await supabase.storage.from('videos').upload(storagePath, blob);
    if (error) { setStatus('Save failed: ' + error.message); setLoading(false); return; }
    const url = getPublicUrl('videos', storagePath);
    const { data: newAsset } = await supabase.from('assets').insert({ project_id: currentProject.id, type: 'video', filename: `${suffix}.mp4`, storage_path: storagePath, duration, url }).select().single();
    if (newAsset) { setAssets(prev => [...prev, { ...newAsset, url }]); selectAssetForPreview({ ...newAsset, url }); }
    setStatus('Ready'); setLoading(false); setProgress(0);
  }

  async function deleteAsset(e, asset) {
    e.stopPropagation();
    if (!confirm('Delete?')) return;
    const bucket = asset.type === 'audio' ? 'audio' : 'videos';
    await supabase.storage.from(bucket).remove([asset.storage_path]);
    await supabase.from('assets').delete().eq('id', asset.id);
    setAssets(assets.filter(a => a.id !== asset.id));
    if (selectedAsset?.id === asset.id) { setSelectedAsset(null); setPreviewUrl(null); }
  }

  function formatTime(s) {
    if (!s) return '00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ============ PROJECT LIST ============
  if (!currentProject) {
    return (
      <div style={S.root}>
        <div style={S.topBar}>
          <div style={S.logo}>⬡ Covenant Editor</div>
          <div style={S.topStatus}>{status}</div>
        </div>
        <div style={S.projectPage}>
          <h2 style={S.projectTitle}>Your Projects</h2>
          <div style={S.projectRow}>
            <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="New project..." style={S.projectInput} onKeyDown={e => e.key === 'Enter' && createProject()} />
            <button onClick={createProject} style={S.btnBlue}>+ New Project</button>
          </div>
          <div style={S.projectGrid}>
            {projects.map(p => (
              <div key={p.id} style={S.projectCard} onClick={() => selectProject(p)}>
                <div style={S.projectCardIcon}>🎬</div>
                <div style={S.projectCardName}>{p.name}</div>
                <div style={S.projectCardDate}>{new Date(p.created_at).toLocaleDateString()}</div>
                <button onClick={e => deleteProject(e, p)} style={S.projectCardDel}>×</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ============ EDITOR ============
  return (
    <div style={S.root}>
      {/* Top Menu Bar */}
      <div style={S.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={S.logo}>⬡</div>
          <button onClick={() => { setCurrentProject(null); setAssets([]); setSelectedAsset(null); setPreviewUrl(null); }} style={S.menuItem}>File</button>
          <span style={S.menuItem}>{currentProject.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {loading && <div style={S.progressBar}><div style={{ ...S.progressFill, width: `${progress}%` }} /></div>}
          <div style={S.topStatus}>{loading ? '⏳' : '●'} {status}</div>
        </div>
      </div>

      <div style={S.editorLayout}>
        {/* Left Panel - Project Assets */}
        <div style={S.leftPanel}>
          <div style={S.panelHeader}>
            <span>Project</span>
            <label style={S.importBtn}>
              + Import
              <input type="file" accept="video/*,audio/*" onChange={uploadFile} disabled={loading} style={{ display: 'none' }} />
            </label>
          </div>
          <div style={S.assetList}>
            {assets.map(a => (
              <div key={a.id} style={{ ...S.assetItem, ...(selectedAsset?.id === a.id ? S.assetItemSelected : {}) }} onClick={() => selectAssetForPreview(a)}>
                <div style={S.assetThumb}>{a.type === 'video' ? '🎞' : '🎵'}</div>
                <div style={S.assetInfo}>
                  <div style={S.assetName}>{a.filename}</div>
                  <div style={S.assetMeta}>{a.type} • {formatTime(a.duration)}</div>
                </div>
                <button onClick={e => deleteAsset(e, a)} style={S.assetDel}>×</button>
              </div>
            ))}
            {assets.length === 0 && <div style={S.emptyState}>Import media to begin</div>}
          </div>
        </div>

        {/* Center - Preview Monitor */}
        <div style={S.centerPanel}>
          <div style={S.monitorLabel}>Program</div>
          <div style={S.monitor}>
            {previewUrl ? (
              <video ref={videoRef} src={previewUrl} controls style={S.videoPlayer} />
            ) : (
              <div style={S.monitorEmpty}>No clip selected</div>
            )}
          </div>
        </div>

        {/* Right Panel - Effects/Tools */}
        <div style={S.rightPanel}>
          <div style={S.panelHeader}>Effects</div>
          <div style={S.toolList}>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => cutVideo(selectedAsset)} style={S.toolBtn}>
              <span style={S.toolIcon}>✂️</span> Razor / Cut
            </button>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => adjustVolume(selectedAsset)} style={S.toolBtn}>
              <span style={S.toolIcon}>🔊</span> Audio Gain
            </button>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => addText(selectedAsset)} style={S.toolBtn}>
              <span style={S.toolIcon}>T</span> Text Overlay
            </button>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => removeDeadSpace(selectedAsset)} style={S.toolBtn}>
              <span style={S.toolIcon}>🔇</span> Remove Silence
            </button>
            <div style={S.toolDivider} />
            {selectedAsset && (
              <a href={selectedAsset.url} download={selectedAsset.filename} style={S.toolBtn}>
                <span style={S.toolIcon}>⬇️</span> Export / Download
              </a>
            )}
          </div>
          {!ffmpegLoaded && <div style={S.engineStatus}>Loading engine...</div>}
        </div>
      </div>

      {/* Bottom - Timeline */}
      <div style={S.timeline}>
        <div style={S.timelineHeader}>
          <span style={S.timelineLabel}>Timeline</span>
        </div>
        <div style={S.timelineTracks}>
          <div style={S.trackLabel}>V1</div>
          <div style={S.trackArea}>
            {assets.filter(a => a.type === 'video').map(a => (
              <div key={a.id} onClick={() => selectAssetForPreview(a)} style={{ ...S.timelineClip, ...(selectedAsset?.id === a.id ? S.timelineClipSelected : {}), width: `${Math.max((a.duration || 5) * 8, 60)}px` }}>
                <div style={S.clipName}>{a.filename}</div>
                <div style={S.clipDuration}>{formatTime(a.duration)}</div>
              </div>
            ))}
          </div>
        </div>
        <div style={S.timelineTracks}>
          <div style={S.trackLabel}>A1</div>
          <div style={S.trackArea}>
            {assets.filter(a => a.type === 'audio').map(a => (
              <div key={a.id} onClick={() => selectAssetForPreview(a)} style={{ ...S.timelineClipAudio, width: `${Math.max((a.duration || 5) * 8, 60)}px` }}>
                <div style={S.clipName}>{a.filename}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ PREMIERE PRO STYLES ============
const S = {
  root: { background: '#1e1e1e', color: '#d4d4d4', fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: '12px', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { background: '#2d2d2d', borderBottom: '1px solid #3e3e3e', padding: '0 12px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  logo: { color: '#9999ff', fontWeight: '700', fontSize: '14px' },
  menuItem: { color: '#ccc', cursor: 'pointer', padding: '4px 8px', fontSize: '12px', background: 'none', border: 'none' },
  topStatus: { color: '#888', fontSize: '11px' },
  progressBar: { width: '120px', height: '4px', background: '#333', borderRadius: '2px', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#4f8ef7', transition: 'width 0.3s' },

  // Project page
  projectPage: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px' },
  projectTitle: { fontSize: '20px', fontWeight: '600', color: '#fff', marginBottom: '20px' },
  projectRow: { display: 'flex', gap: '8px', marginBottom: '24px', width: '100%', maxWidth: '500px' },
  projectInput: { flex: 1, padding: '8px 12px', background: '#2d2d2d', border: '1px solid #3e3e3e', borderRadius: '4px', color: '#fff', fontSize: '13px', outline: 'none' },
  btnBlue: { padding: '8px 16px', background: '#4f8ef7', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: '600', whiteSpace: 'nowrap' },
  projectGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', width: '100%', maxWidth: '800px' },
  projectCard: { background: '#2d2d2d', border: '1px solid #3e3e3e', borderRadius: '6px', padding: '20px 16px', cursor: 'pointer', textAlign: 'center', position: 'relative', transition: 'border-color 0.2s' },
  projectCardIcon: { fontSize: '28px', marginBottom: '8px' },
  projectCardName: { color: '#fff', fontWeight: '600', fontSize: '13px' },
  projectCardDate: { color: '#888', fontSize: '11px', marginTop: '4px' },
  projectCardDel: { position: 'absolute', top: '6px', right: '8px', background: 'none', border: 'none', color: '#666', cursor: 'pointer', fontSize: '16px' },

  // Editor layout
  editorLayout: { display: 'flex', flex: 1, overflow: 'hidden' },

  // Left panel
  leftPanel: { width: '220px', background: '#252526', borderRight: '1px solid #3e3e3e', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  panelHeader: { padding: '8px 12px', borderBottom: '1px solid #3e3e3e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#999' },
  importBtn: { padding: '3px 8px', background: '#4f8ef7', borderRadius: '3px', color: '#fff', cursor: 'pointer', fontSize: '10px', fontWeight: '600' },
  assetList: { flex: 1, overflow: 'auto', padding: '4px' },
  assetItem: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '3px', cursor: 'pointer', marginBottom: '2px', position: 'relative' },
  assetItemSelected: { background: '#37373d' },
  assetThumb: { width: '32px', height: '24px', background: '#1e1e1e', borderRadius: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', flexShrink: 0 },
  assetInfo: { flex: 1, minWidth: 0 },
  assetName: { color: '#ccc', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  assetMeta: { color: '#666', fontSize: '10px' },
  assetDel: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '14px', padding: '2px', opacity: 0.5 },
  emptyState: { color: '#555', textAlign: 'center', padding: '20px', fontSize: '11px' },

  // Center panel
  centerPanel: { flex: 1, display: 'flex', flexDirection: 'column', background: '#1e1e1e' },
  monitorLabel: { padding: '6px 12px', borderBottom: '1px solid #3e3e3e', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#999', background: '#252526' },
  monitor: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', margin: '8px', borderRadius: '4px', overflow: 'hidden' },
  videoPlayer: { maxWidth: '100%', maxHeight: '100%' },
  monitorEmpty: { color: '#444', fontSize: '13px' },

  // Right panel
  rightPanel: { width: '200px', background: '#252526', borderLeft: '1px solid #3e3e3e', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  toolList: { padding: '8px', flex: 1 },
  toolBtn: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 10px', background: 'none', border: '1px solid transparent', borderRadius: '3px', color: '#ccc', cursor: 'pointer', fontSize: '12px', textDecoration: 'none', textAlign: 'left', marginBottom: '2px' },
  toolIcon: { width: '20px', textAlign: 'center' },
  toolDivider: { height: '1px', background: '#3e3e3e', margin: '8px 0' },
  engineStatus: { padding: '8px 12px', color: '#f0ad4e', fontSize: '10px', borderTop: '1px solid #3e3e3e' },

  // Timeline
  timeline: { height: '140px', background: '#252526', borderTop: '2px solid #3e3e3e', flexShrink: 0 },
  timelineHeader: { padding: '4px 12px', borderBottom: '1px solid #3e3e3e', display: 'flex', alignItems: 'center' },
  timelineLabel: { fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#999' },
  timelineTracks: { display: 'flex', height: '44px', borderBottom: '1px solid #333' },
  trackLabel: { width: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#2d2d2d', borderRight: '1px solid #3e3e3e', fontSize: '10px', color: '#888', fontWeight: '600' },
  trackArea: { flex: 1, display: 'flex', alignItems: 'center', padding: '4px 8px', gap: '4px', overflow: 'auto' },
  timelineClip: { height: '32px', background: '#4a6a9b', borderRadius: '3px', padding: '2px 8px', display: 'flex', flexDirection: 'column', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, border: '1px solid transparent' },
  timelineClipSelected: { border: '1px solid #4f8ef7', background: '#5a7aab' },
  timelineClipAudio: { height: '32px', background: '#4a9b6a', borderRadius: '3px', padding: '2px 8px', display: 'flex', alignItems: 'center', cursor: 'pointer', flexShrink: 0 },
  clipName: { fontSize: '10px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  clipDuration: { fontSize: '9px', color: 'rgba(255,255,255,0.6)' },
};

export default App;
