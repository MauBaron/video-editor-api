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
  // Timeline: array of tracks, each track is array of clips
  // clip = { id, asset, startOnTimeline, trimStart, trimEnd, duration (visible) }
  const [tracks, setTracks] = useState([
    { id: 'V1', type: 'video', clips: [] },
    { id: 'V2', type: 'video', clips: [] },
    { id: 'A1', type: 'audio', clips: [] },
  ]);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeClipId, setActiveClipId] = useState(null);
  const [zoom, setZoom] = useState(10); // px per second
  const [tool, setTool] = useState('select'); // select | razor | trim
  const [sequenceSettings] = useState({ width: 1080, height: 1920, fps: 30 });
  const [trimming, setTrimming] = useState(null); // { trackIdx, clipIdx, edge: 'left'|'right', startX, origTrimStart, origTrimEnd, origStart }
  const [draggingClip, setDraggingClip] = useState(null);
  const [scrollLeft, setScrollLeft] = useState(0);

  const ffmpegRef = useRef(new FFmpeg());
  const videoRef = useRef(null);
  const timelineScrollRef = useRef(null);
  const playIntervalRef = useRef(null);

  useEffect(() => { loadFFmpeg(); fetchProjects(); }, []);

  // Playback engine — let the video drive the playhead, not the other way around
  useEffect(() => {
    if (!isPlaying) return;
    // Start the current clip playing
    syncVideoToPlayhead(playhead, false);
    if (videoRef.current && videoRef.current.paused) videoRef.current.play();
  }, [isPlaying]);

  // Video timeupdate drives the playhead
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTimeUpdate = () => {
      if (!isPlaying) return;
      // Find current clip to calculate global time
      const v1 = tracks[0];
      const clip = v1.clips.find(c => c.id === activeClipId);
      if (!clip) return;
      const globalTime = clip.startOnTimeline + (v.currentTime - clip.trimStart);
      setPlayhead(globalTime);
    };
    const onEnded = () => {
      if (!isPlaying) return;
      // Find next clip
      const v1 = tracks[0];
      const idx = v1.clips.findIndex(c => c.id === activeClipId);
      if (idx >= 0 && idx < v1.clips.length - 1) {
        const nextClip = v1.clips[idx + 1];
        setActiveClipId(nextClip.id);
        setPreviewUrl(nextClip.asset.url);
        setSelectedAsset(nextClip.asset);
        setPlayhead(nextClip.startOnTimeline);
        setTimeout(() => {
          if (videoRef.current) { videoRef.current.currentTime = nextClip.trimStart; videoRef.current.play(); }
        }, 100);
      } else {
        setIsPlaying(false);
      }
    };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('ended', onEnded);
    return () => { v.removeEventListener('timeupdate', onTimeUpdate); v.removeEventListener('ended', onEnded); };
  }, [isPlaying, activeClipId, tracks]);

  function syncVideoToPlayhead(time, forceSeek) {
    // Find clip at this time on V1
    const v1 = tracks[0];
    const clip = v1.clips.find(c => time >= c.startOnTimeline && time < c.startOnTimeline + c.duration);
    if (clip) {
      const localTime = clip.trimStart + (time - clip.startOnTimeline);
      if (activeClipId !== clip.id) {
        // Switching to new clip
        setActiveClipId(clip.id);
        setPreviewUrl(clip.asset.url);
        setSelectedAsset(clip.asset);
        setTimeout(() => {
          if (videoRef.current) { videoRef.current.currentTime = localTime; videoRef.current.play(); }
        }, 100);
      } else if (forceSeek && videoRef.current) {
        videoRef.current.currentTime = localTime;
      }
      // During normal playback: do NOT seek — let video play naturally
    } else {
      if (activeClipId) { setActiveClipId(null); setPreviewUrl(null); if (videoRef.current) videoRef.current.pause(); }
    }
  }

  async function loadFFmpeg() {
    setStatus('Loading FFmpeg...');
    const ffmpeg = ffmpegRef.current;
    ffmpeg.on('progress', ({ progress: p }) => { setProgress(Math.round(p * 100)); setStatus(`Processing: ${Math.round(p * 100)}%`); });
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setFfmpegLoaded(true); setStatus('Ready');
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
    const a = data || [];
    setAssets(a);
    // Auto-populate V1 with videos, A1 with audio
    let vOffset = 0, aOffset = 0;
    const vClips = [], aClips = [];
    a.forEach(asset => {
      if (asset.type === 'video' && asset.duration) {
        vClips.push({ id: `clip-${asset.id}`, asset, startOnTimeline: vOffset, trimStart: 0, trimEnd: asset.duration, duration: asset.duration });
        vOffset += asset.duration;
      } else if (asset.type === 'audio' && asset.duration) {
        aClips.push({ id: `clip-${asset.id}`, asset, startOnTimeline: aOffset, trimStart: 0, trimEnd: asset.duration, duration: asset.duration });
        aOffset += asset.duration;
      }
    });
    setTracks([
      { id: 'V1', type: 'video', clips: vClips },
      { id: 'V2', type: 'video', clips: [] },
      { id: 'A1', type: 'audio', clips: aClips },
    ]);
    setSelectedAsset(null); setPreviewUrl(null); setPlayhead(0);
  }

  function getPublicUrl(bucket, path) {
    return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  }

  async function uploadFile(e) {
    const files = Array.from(e.target.files);
    if (!files.length || !currentProject) return;
    setLoading(true);
    for (const file of files) {
      setStatus(`Uploading ${file.name}...`);
      const ext = file.name.split('.').pop();
      const type = file.type.startsWith('video') ? 'video' : 'audio';
      const bucket = type === 'audio' ? 'audio' : 'videos';
      const storagePath = `${currentProject.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from(bucket).upload(storagePath, file);
      if (uploadErr) { setStatus('Upload failed: ' + uploadErr.message); continue; }
      const url = getPublicUrl(bucket, storagePath);
      let duration = null;
      if (type === 'video' || type === 'audio') duration = await getMediaDuration(file);
      const { data: asset } = await supabase.from('assets').insert({ project_id: currentProject.id, type, filename: file.name, storage_path: storagePath, duration, url }).select().single();
      if (asset) setAssets(prev => [...prev, { ...asset, url }]);
    }
    setStatus('Ready'); setLoading(false); e.target.value = '';
  }

  function getMediaDuration(file) {
    return new Promise(resolve => {
      const el = document.createElement(file.type.startsWith('video') ? 'video' : 'audio');
      el.preload = 'metadata';
      el.onloadedmetadata = () => { resolve(el.duration); URL.revokeObjectURL(el.src); };
      el.onerror = () => resolve(5);
      el.src = URL.createObjectURL(file);
    });
  }

  function getTotalDuration() {
    let max = 0;
    tracks.forEach(track => {
      track.clips.forEach(c => { max = Math.max(max, c.startOnTimeline + c.duration); });
    });
    return max || 30;
  }

  // Drop asset onto a track
  function onTrackDrop(e, trackIdx) {
    e.preventDefault();
    const assetId = e.dataTransfer.getData('asset-id');
    const clipData = e.dataTransfer.getData('clip-drag');
    
    if (clipData) {
      // Moving clip between tracks
      const { fromTrack, clipIdx } = JSON.parse(clipData);
      if (fromTrack === trackIdx) return;
      const newTracks = [...tracks];
      const [moved] = newTracks[fromTrack].clips.splice(clipIdx, 1);
      // Calculate drop position
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + (timelineScrollRef.current?.scrollLeft || 0);
      moved.startOnTimeline = Math.max(0, x / zoom);
      newTracks[trackIdx].clips.push(moved);
      newTracks[trackIdx].clips.sort((a, b) => a.startOnTimeline - b.startOnTimeline);
      setTracks(newTracks);
      return;
    }

    if (assetId) {
      const asset = assets.find(a => a.id === assetId);
      if (!asset || !asset.duration) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left + (timelineScrollRef.current?.scrollLeft || 0);
      const startTime = Math.max(0, x / zoom);
      const newClip = { id: `clip-${Date.now()}-${Math.random()}`, asset, startOnTimeline: startTime, trimStart: 0, trimEnd: asset.duration, duration: asset.duration };
      const newTracks = [...tracks];
      newTracks[trackIdx].clips.push(newClip);
      newTracks[trackIdx].clips.sort((a, b) => a.startOnTimeline - b.startOnTimeline);
      setTracks(newTracks);
    }
  }

  // Clip drag within track (reposition)
  function onClipMouseDown(e, trackIdx, clipIdx) {
    if (tool === 'razor') {
      // Razor: split clip at click point
      const clip = tracks[trackIdx].clips[clipIdx];
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const splitLocal = x / zoom; // time within visible clip
      if (splitLocal <= 0.1 || splitLocal >= clip.duration - 0.1) return;
      
      const newTracks = [...tracks];
      const left = { ...clip, id: clip.id + '-L', trimEnd: clip.trimStart + splitLocal, duration: splitLocal };
      const right = { ...clip, id: clip.id + '-R', startOnTimeline: clip.startOnTimeline + splitLocal, trimStart: clip.trimStart + splitLocal, duration: clip.duration - splitLocal };
      newTracks[trackIdx].clips.splice(clipIdx, 1, left, right);
      setTracks(newTracks);
      return;
    }

    if (tool === 'trim') return; // handled by edge handles

    // Select tool: drag to reposition
    e.preventDefault();
    const startX = e.clientX;
    const origStart = tracks[trackIdx].clips[clipIdx].startOnTimeline;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dt = dx / zoom;
      const newTracks = [...tracks];
      newTracks[trackIdx].clips[clipIdx].startOnTimeline = Math.max(0, origStart + dt);
      setTracks([...newTracks]);
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  // Trim handles
  function onTrimHandleMouseDown(e, trackIdx, clipIdx, edge) {
    e.stopPropagation();
    e.preventDefault();
    const clip = tracks[trackIdx].clips[clipIdx];
    const startX = e.clientX;
    const origTrimStart = clip.trimStart;
    const origTrimEnd = clip.trimEnd;
    const origStartOnTimeline = clip.startOnTimeline;
    const origDuration = clip.duration;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dt = dx / zoom;
      const newTracks = [...tracks];
      const c = newTracks[trackIdx].clips[clipIdx];
      
      if (edge === 'left') {
        const newTrimStart = Math.max(0, Math.min(origTrimEnd - 0.1, origTrimStart + dt));
        const trimDelta = newTrimStart - origTrimStart;
        c.trimStart = newTrimStart;
        c.startOnTimeline = origStartOnTimeline + trimDelta;
        c.duration = origDuration - trimDelta;
      } else {
        const newTrimEnd = Math.max(origTrimStart + 0.1, Math.min(clip.asset.duration, origTrimEnd + dt));
        c.trimEnd = newTrimEnd;
        c.duration = newTrimEnd - c.trimStart;
      }
      setTracks([...newTracks]);
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function deleteClip(trackIdx, clipIdx) {
    const newTracks = [...tracks];
    newTracks[trackIdx].clips.splice(clipIdx, 1);
    setTracks(newTracks);
  }

  // Playhead drag on ruler
  function onRulerMouseDown(e) {
    const updatePlayhead = (ev) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = (ev.clientX || e.clientX) - rect.left + (timelineScrollRef.current?.scrollLeft || 0);
      const t = Math.max(0, Math.min(x / zoom, getTotalDuration()));
      setPlayhead(t);
      syncVideoToPlayhead(t, true);
    };
    updatePlayhead(e);
    const onMove = (ev) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ev.clientX - rect.left + (timelineScrollRef.current?.scrollLeft || 0);
      const t = Math.max(0, Math.min(x / zoom, getTotalDuration()));
      setPlayhead(t);
      syncVideoToPlayhead(t, true);
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function togglePlay() {
    if (isPlaying) {
      setIsPlaying(false);
      if (videoRef.current) videoRef.current.pause();
    } else {
      if (playhead >= getTotalDuration()) setPlayhead(0);
      setIsPlaying(true);
      syncVideoToPlayhead(playhead);
    }
  }

  function selectClipForPreview(clip) {
    setSelectedAsset(clip.asset);
    setPreviewUrl(clip.asset.url);
    setActiveClipId(clip.id);
  }

  async function deleteAsset(e, asset) {
    e.stopPropagation();
    if (!confirm('Delete?')) return;
    const bucket = asset.type === 'audio' ? 'audio' : 'videos';
    await supabase.storage.from(bucket).remove([asset.storage_path]);
    await supabase.from('assets').delete().eq('id', asset.id);
    setAssets(assets.filter(a => a.id !== asset.id));
    // Remove from all tracks
    setTracks(tracks.map(t => ({ ...t, clips: t.clips.filter(c => c.asset.id !== asset.id) })));
    if (selectedAsset?.id === asset.id) { setSelectedAsset(null); setPreviewUrl(null); }
  }

  function formatTC(s) {
    if (!s || isNaN(s)) return '00:00:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 100);
    return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(ms).padStart(2,'0')}`;
  }

  const totalDur = getTotalDuration();
  const timelineWidth = Math.max(totalDur * zoom + 200, 800);

  // ============ PROJECT LIST ============
  if (!currentProject) {
    return (
      <div style={S.root}>
        <div style={S.topBar}><div style={S.logo}>⬡ Covenant Editor</div></div>
        <div style={S.projectPage}>
          <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#fff', marginBottom: '20px' }}>Projects</h2>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', width: '100%', maxWidth: '500px' }}>
            <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="New project..." style={S.input} onKeyDown={e => e.key === 'Enter' && createProject()} />
            <button onClick={createProject} style={S.btnBlue}>+ New</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', width: '100%', maxWidth: '700px' }}>
            {projects.map(p => (
              <div key={p.id} style={S.projectCard} onClick={() => selectProject(p)}>
                <div style={{ fontSize: '28px' }}>🎬</div>
                <div style={{ color: '#fff', fontWeight: 600, fontSize: '12px', marginTop: '6px' }}>{p.name}</div>
                <div style={{ color: '#555', fontSize: '10px', marginTop: '2px' }}>{new Date(p.created_at).toLocaleDateString()}</div>
                <button onClick={e => deleteProject(e, p)} style={{ position: 'absolute', top: 4, right: 6, background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '14px' }}>×</button>
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
      <div style={S.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={S.logo}>⬡</div>
          <button onClick={() => { setCurrentProject(null); setAssets([]); setTracks([{id:'V1',type:'video',clips:[]},{id:'V2',type:'video',clips:[]},{id:'A1',type:'audio',clips:[]}]); }} style={S.menuBtn}>← Projects</button>
          <span style={{ color: '#aaa', fontSize: '12px' }}>{currentProject.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {/* Tool selector */}
          <div style={{ display: 'flex', gap: '2px', background: '#1e1e1e', borderRadius: '4px', padding: '2px' }}>
            {[['select','↖','Select'],['razor','✂','Razor'],['trim','↔','Trim']].map(([t,icon,label]) => (
              <button key={t} onClick={() => setTool(t)} style={{ ...S.toolToggle, ...(tool === t ? { background: '#4f8ef7', color: '#fff' } : {}) }} title={label}>{icon}</button>
            ))}
          </div>
          {loading && <div style={S.progressBar}><div style={{ ...S.progressFill, width: `${progress}%` }} /></div>}
          <span style={{ color: '#555', fontSize: '11px' }}>{status}</span>
        </div>
      </div>

      <div style={S.editorLayout}>
        {/* Left: Assets */}
        <div style={S.panel}>
          <div style={S.panelHead}>
            <span>Media</span>
            <label style={S.importBtn}>+ Import<input type="file" accept="video/*,audio/*" multiple onChange={uploadFile} disabled={loading} style={{ display: 'none' }} /></label>
          </div>
          <div style={S.panelBody}>
            {assets.map(a => (
              <div key={a.id} draggable onDragStart={e => { e.dataTransfer.setData('asset-id', a.id); }} onClick={() => { setSelectedAsset(a); setPreviewUrl(a.url); }}
                style={{ ...S.assetItem, ...(selectedAsset?.id === a.id ? { background: '#37373d' } : {}) }}>
                <span style={{ fontSize: '14px' }}>{a.type === 'video' ? '🎞' : '🎵'}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={S.assetName}>{a.filename}</div>
                  <div style={{ color: '#555', fontSize: '10px' }}>{formatTC(a.duration)}</div>
                </div>
                <button onClick={e => deleteAsset(e, a)} style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', fontSize: '12px' }}>×</button>
              </div>
            ))}
            {!assets.length && <div style={{ color: '#444', textAlign: 'center', padding: '20px', fontSize: '11px' }}>Import media or drag files</div>}
          </div>
        </div>

        {/* Center: Monitor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={S.panelHead}>
            <span>Program</span>
            <span style={{ color: '#555', fontSize: '10px', fontFamily: 'monospace' }}>{formatTC(playhead)} / {formatTC(totalDur)}</span>
          </div>
          <div style={S.monitor}>
            {previewUrl ? (
              <video ref={videoRef} src={previewUrl} controls crossOrigin="anonymous" style={{ maxWidth: '100%', maxHeight: '100%', aspectRatio: '9/16' }} />
            ) : (
              <div style={{ color: '#333', fontSize: '13px' }}>No clip at playhead</div>
            )}
          </div>
          <div style={S.transport}>
            <div style={{ fontFamily: 'monospace', fontSize: '13px', color: '#4f8ef7', letterSpacing: '1px' }}>{formatTC(playhead)}</div>
            <div style={{ display: 'flex', gap: '2px' }}>
              <button onClick={() => setPlayhead(0)} style={S.tBtn}>⏮</button>
              <button onClick={() => { const t = Math.max(0, playhead - 1/30); setPlayhead(t); syncVideoToPlayhead(t, true); }} style={S.tBtn}>◀</button>
              <button onClick={togglePlay} style={{ ...S.tBtn, background: isPlaying ? '#e74c3c' : '#4f8ef7', color: '#fff', width: '36px', fontWeight: 700 }}>{isPlaying ? '⏸' : '▶'}</button>
              <button onClick={() => { const t = Math.min(totalDur, playhead + 1/30); setPlayhead(t); syncVideoToPlayhead(t, true); }} style={S.tBtn}>▶</button>
              <button onClick={() => setPlayhead(totalDur)} style={S.tBtn}>⏭</button>
            </div>
            <div style={{ fontFamily: 'monospace', fontSize: '13px', color: '#888', letterSpacing: '1px' }}>{formatTC(totalDur)}</div>
          </div>
        </div>

        {/* Right: Effects */}
        <div style={S.panel}>
          <div style={S.panelHead}><span>Effects</span></div>
          <div style={S.panelBody}>
            <div style={{ padding: '8px', color: '#666', fontSize: '11px' }}>
              <div style={{ marginBottom: '8px', color: '#999' }}>Tools</div>
              <div style={{ marginBottom: '4px' }}>↖ <b>Select</b> — drag clips</div>
              <div style={{ marginBottom: '4px' }}>✂ <b>Razor</b> — click to split</div>
              <div style={{ marginBottom: '12px' }}>↔ <b>Trim</b> — drag edges</div>
              <div style={{ marginBottom: '8px', color: '#999' }}>Keyboard</div>
              <div style={{ marginBottom: '4px' }}><kbd style={S.kbd}>Space</kbd> Play/Pause</div>
              <div style={{ marginBottom: '4px' }}><kbd style={S.kbd}>Del</kbd> Delete clip</div>
            </div>
            {selectedAsset && (
              <>
                <div style={{ height: '1px', background: '#333', margin: '8px 0' }} />
                <a href={selectedAsset.url} download={selectedAsset.filename} style={S.effectBtn}>⬇️ Export Selected</a>
              </>
            )}
            {!ffmpegLoaded && <div style={{ color: '#f0ad4e', fontSize: '10px', padding: '8px' }}>Loading engine...</div>}
          </div>
        </div>
      </div>

      {/* ============ TIMELINE ============ */}
      <div style={S.timelineWrap}>
        <div style={S.timelineHead}>
          <span style={{ fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Timeline</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: '#555' }}>Zoom</span>
            <input type="range" min="3" max="50" value={zoom} onChange={e => setZoom(+e.target.value)} style={{ width: '80px', accentColor: '#4f8ef7' }} />
          </div>
        </div>

        <div ref={timelineScrollRef} style={S.timelineScroll} onScroll={e => setScrollLeft(e.target.scrollLeft)}>
          <div style={{ width: `${timelineWidth}px`, position: 'relative' }}>
            {/* Ruler */}
            <div style={S.ruler} onMouseDown={onRulerMouseDown}>
              {Array.from({ length: Math.ceil(totalDur) + 1 }, (_, i) => (
                <div key={i} style={{ position: 'absolute', left: `${i * zoom}px`, height: '100%', borderLeft: '1px solid #333', paddingLeft: '3px', color: '#555', fontSize: '9px', userSelect: 'none' }}>
                  {i}s
                </div>
              ))}
              {/* Playhead on ruler */}
              <div style={{ position: 'absolute', left: `${playhead * zoom}px`, top: 0, bottom: 0, width: '2px', background: '#ff4444', zIndex: 20 }}>
                <div style={{ position: 'absolute', top: '-2px', left: '-6px', width: '14px', height: '14px', background: '#ff4444', clipPath: 'polygon(0 0, 100% 0, 50% 100%)', cursor: 'ew-resize' }} />
              </div>
            </div>

            {/* Tracks */}
            {tracks.map((track, trackIdx) => (
              <div key={track.id} style={S.track}
                onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
                onDrop={e => onTrackDrop(e, trackIdx)}>
                <div style={S.trackLabel}>{track.id}</div>
                <div style={{ flex: 1, position: 'relative', height: '100%' }}>
                  {track.clips.map((clip, clipIdx) => (
                    <div key={clip.id}
                      onMouseDown={e => onClipMouseDown(e, trackIdx, clipIdx)}
                      onDoubleClick={() => selectClipForPreview(clip)}
                      draggable
                      onDragStart={e => { e.dataTransfer.setData('clip-drag', JSON.stringify({ fromTrack: trackIdx, clipIdx })); }}
                      style={{
                        position: 'absolute',
                        left: `${clip.startOnTimeline * zoom}px`,
                        width: `${Math.max(clip.duration * zoom, 4)}px`,
                        height: '100%',
                        background: track.type === 'video'
                          ? (activeClipId === clip.id ? '#4a7abf' : '#3a5a8a')
                          : (activeClipId === clip.id ? '#4abf7a' : '#3a8a5a'),
                        borderRadius: '3px',
                        cursor: tool === 'razor' ? 'crosshair' : (tool === 'trim' ? 'ew-resize' : 'grab'),
                        overflow: 'hidden',
                        border: activeClipId === clip.id ? '1px solid #6af' : '1px solid rgba(255,255,255,0.1)',
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        padding: '0 4px',
                        userSelect: 'none',
                        boxSizing: 'border-box',
                      }}>
                      {/* Trim handles */}
                      <div onMouseDown={e => onTrimHandleMouseDown(e, trackIdx, clipIdx, 'left')}
                        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '6px', cursor: 'ew-resize', background: 'rgba(255,255,255,0.15)', borderRadius: '3px 0 0 3px' }} />
                      <div onMouseDown={e => onTrimHandleMouseDown(e, trackIdx, clipIdx, 'right')}
                        style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: '6px', cursor: 'ew-resize', background: 'rgba(255,255,255,0.15)', borderRadius: '0 3px 3px 0' }} />
                      
                      <div style={{ fontSize: '10px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', pointerEvents: 'none' }}>{clip.asset.filename}</div>
                      <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.5)', pointerEvents: 'none' }}>{formatTC(clip.duration)}</div>
                      
                      {/* Audio waveform placeholder */}
                      {track.type === 'audio' && (
                        <div style={{ position: 'absolute', bottom: '2px', left: '8px', right: '8px', height: '10px', display: 'flex', alignItems: 'end', gap: '1px', opacity: 0.4 }}>
                          {Array.from({ length: Math.min(Math.floor(clip.duration * zoom / 3), 100) }, (_, i) => (
                            <div key={i} style={{ width: '2px', height: `${2 + Math.random() * 8}px`, background: '#fff', borderRadius: '1px' }} />
                          ))}
                        </div>
                      )}
                      {/* Video waveform representation */}
                      {track.type === 'video' && clip.duration * zoom > 60 && (
                        <div style={{ position: 'absolute', bottom: '1px', left: '8px', right: '8px', height: '6px', display: 'flex', alignItems: 'end', gap: '1px', opacity: 0.25 }}>
                          {Array.from({ length: Math.min(Math.floor(clip.duration * zoom / 4), 80) }, (_, i) => (
                            <div key={i} style={{ width: '2px', height: `${1 + Math.random() * 5}px`, background: '#fff', borderRadius: '1px' }} />
                          ))}
                        </div>
                      )}
                    </div>
                  ))}

                  {/* Playhead line */}
                  <div style={{ position: 'absolute', left: `${playhead * zoom}px`, top: 0, bottom: 0, width: '2px', background: '#ff4444', zIndex: 10, pointerEvents: 'none' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const S = {
  root: { background: '#1e1e1e', color: '#d4d4d4', fontFamily: "'Segoe UI', system-ui, sans-serif", fontSize: '12px', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  topBar: { background: '#2d2d2d', borderBottom: '1px solid #3e3e3e', padding: '0 12px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  logo: { color: '#9999ff', fontWeight: 700, fontSize: '14px' },
  menuBtn: { background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '12px', padding: '4px 8px' },
  progressBar: { width: '100px', height: '3px', background: '#333', borderRadius: '2px', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#4f8ef7', transition: 'width 0.3s' },
  input: { flex: 1, padding: '8px 12px', background: '#2d2d2d', border: '1px solid #3e3e3e', borderRadius: '4px', color: '#fff', fontSize: '13px', outline: 'none' },
  btnBlue: { padding: '8px 16px', background: '#4f8ef7', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 600 },
  toolToggle: { padding: '4px 10px', background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontSize: '13px', borderRadius: '3px' },

  projectPage: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px' },
  projectCard: { background: '#2d2d2d', border: '1px solid #3e3e3e', borderRadius: '6px', padding: '16px', cursor: 'pointer', textAlign: 'center', position: 'relative' },

  editorLayout: { display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 },
  panel: { width: '200px', background: '#252526', borderRight: '1px solid #3e3e3e', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  panelHead: { padding: '6px 10px', borderBottom: '1px solid #3e3e3e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#999', background: '#2d2d2d' },
  panelBody: { flex: 1, overflow: 'auto', padding: '4px' },
  importBtn: { padding: '3px 8px', background: '#4f8ef7', borderRadius: '3px', color: '#fff', cursor: 'pointer', fontSize: '10px', fontWeight: 600 },

  assetItem: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 6px', borderRadius: '3px', cursor: 'grab', marginBottom: '1px' },
  assetName: { color: '#ccc', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },

  monitor: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', margin: '4px', borderRadius: '2px', overflow: 'hidden' },
  transport: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 12px', background: '#2d2d2d', borderTop: '1px solid #3e3e3e' },
  tBtn: { width: '28px', height: '24px', background: '#333', border: '1px solid #444', borderRadius: '3px', color: '#ccc', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px' },

  effectBtn: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 10px', background: 'none', border: 'none', borderRadius: '3px', color: '#ccc', cursor: 'pointer', fontSize: '12px', textDecoration: 'none' },
  kbd: { background: '#333', border: '1px solid #444', borderRadius: '3px', padding: '1px 5px', fontSize: '10px', fontFamily: 'monospace', color: '#aaa' },

  timelineWrap: { height: '220px', background: '#1e1e1e', borderTop: '2px solid #4f8ef7', flexShrink: 0, display: 'flex', flexDirection: 'column' },
  timelineHead: { padding: '4px 12px', background: '#2d2d2d', borderBottom: '1px solid #3e3e3e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 },
  timelineScroll: { flex: 1, overflow: 'auto', position: 'relative' },
  ruler: { height: '20px', background: '#252526', borderBottom: '1px solid #3e3e3e', position: 'relative', cursor: 'pointer', marginLeft: '40px' },
  track: { display: 'flex', height: '50px', borderBottom: '1px solid #2a2a2a' },
  trackLabel: { width: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#252526', borderRight: '1px solid #3e3e3e', fontSize: '10px', color: '#888', fontWeight: 600, flexShrink: 0 },
};

export default App;
