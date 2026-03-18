import { useState, useEffect, useRef, useCallback } from 'react';
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
  const [timeline, setTimeline] = useState([]); // ordered clips on timeline
  const [playhead, setPlayhead] = useState(0); // seconds
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0); // global timeline time
  const [activeClipIndex, setActiveClipIndex] = useState(-1);
  const [sequenceSettings, setSequenceSettings] = useState({ width: 1080, height: 1920, fps: 30, label: '9:16 Vertical' });
  const [showSeqSettings, setShowSeqSettings] = useState(false);
  const [dragOverTimeline, setDragOverTimeline] = useState(false);
  const [draggingAsset, setDraggingAsset] = useState(null);
  const [zoom, setZoom] = useState(8); // pixels per second
  const ffmpegRef = useRef(new FFmpeg());
  const videoRef = useRef(null);
  const timelineRef = useRef(null);
  const playheadDragging = useRef(false);
  const animFrame = useRef(null);

  useEffect(() => { loadFFmpeg(); fetchProjects(); }, []);

  // Get clip start time on global timeline
  function getClipStartTime(idx) {
    let t = 0;
    for (let i = 0; i < idx; i++) t += (timeline[i]?.duration || 0);
    return t;
  }

  // Find which clip a global time falls in
  function getClipAtTime(globalTime) {
    let t = 0;
    for (let i = 0; i < timeline.length; i++) {
      const dur = timeline[i]?.duration || 0;
      if (globalTime < t + dur) return { index: i, localTime: globalTime - t };
      t += dur;
    }
    return { index: -1, localTime: 0 };
  }

  // Playback engine: track global time, switch clips automatically
  useEffect(() => {
    if (!videoRef.current || !isPlaying) return;
    const v = videoRef.current;

    const onTimeUpdate = () => {
      if (activeClipIndex < 0) return;
      const clipStart = getClipStartTime(activeClipIndex);
      const globalT = clipStart + v.currentTime;
      setCurrentTime(globalT);
      setPlayhead(globalT);
    };

    const onEnded = () => {
      // Move to next clip
      const nextIdx = activeClipIndex + 1;
      if (nextIdx < timeline.length) {
        setActiveClipIndex(nextIdx);
        setSelectedAsset(timeline[nextIdx]);
        setPreviewUrl(timeline[nextIdx].url);
        // Will auto-play via onLoadedData
      } else {
        setIsPlaying(false);
      }
    };

    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('ended', onEnded);
    return () => { v.removeEventListener('timeupdate', onTimeUpdate); v.removeEventListener('ended', onEnded); };
  }, [isPlaying, activeClipIndex, timeline]);

  async function loadFFmpeg() {
    setStatus('Loading FFmpeg engine...');
    const ffmpeg = ffmpegRef.current;
    ffmpeg.on('log', ({ message }) => console.log(message));
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
    setTimeline(a.filter(x => x.type === 'video'));
    setSelectedAsset(null); setPreviewUrl(null);
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
      if (type === 'video') duration = await getVideoDuration(file);
      const { data: asset } = await supabase.from('assets').insert({ project_id: currentProject.id, type, filename: file.name, storage_path: storagePath, duration, url }).select().single();
      if (asset) {
        const a = { ...asset, url };
        setAssets(prev => [...prev, a]);
        if (type === 'video') setTimeline(prev => [...prev, a]);
      }
    }
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

  // Drag from asset panel
  function onAssetDragStart(e, asset) {
    setDraggingAsset(asset);
    e.dataTransfer.setData('text/plain', asset.id);
    e.dataTransfer.effectAllowed = 'copy';
  }

  function onTimelineDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOverTimeline(true);
  }

  function onTimelineDragLeave() { setDragOverTimeline(false); }

  function onTimelineDrop(e) {
    e.preventDefault();
    setDragOverTimeline(false);
    if (draggingAsset && draggingAsset.type === 'video') {
      if (!timeline.find(t => t.id === draggingAsset.id)) {
        setTimeline(prev => [...prev, draggingAsset]);
      }
    }
    setDraggingAsset(null);
  }

  // Timeline clip reorder via drag
  function onClipDragStart(e, idx) {
    e.dataTransfer.setData('clip-index', String(idx));
    e.dataTransfer.effectAllowed = 'move';
  }

  function onClipDrop(e, dropIdx) {
    e.preventDefault();
    const dragIdx = parseInt(e.dataTransfer.getData('clip-index'));
    if (isNaN(dragIdx)) return;
    const newTimeline = [...timeline];
    const [moved] = newTimeline.splice(dragIdx, 1);
    newTimeline.splice(dropIdx, 0, moved);
    setTimeline(newTimeline);
  }

  // Playhead
  function getTotalDuration() {
    return timeline.reduce((sum, c) => sum + (c.duration || 0), 0);
  }

  function onTimelineClick(e) {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const totalWidth = getTotalDuration() * zoom;
    const time = (x / totalWidth) * getTotalDuration();
    seekToTime(Math.max(0, Math.min(time, getTotalDuration())));
  }

  function seekToTime(time) {
    setPlayhead(time);
    setCurrentTime(time);
    const { index, localTime } = getClipAtTime(time);
    if (index >= 0) {
      setActiveClipIndex(index);
      setSelectedAsset(timeline[index]);
      if (previewUrl !== timeline[index].url) {
        setPreviewUrl(timeline[index].url);
        // Wait for video to load then seek
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.currentTime = localTime;
            if (!isPlaying) videoRef.current.pause();
          }
        }, 200);
      } else {
        if (videoRef.current) videoRef.current.currentTime = localTime;
      }
    } else {
      // Past all clips — go to black
      setPreviewUrl(null);
      setSelectedAsset(null);
      setActiveClipIndex(-1);
    }
  }

  function togglePlay() {
    if (isPlaying) {
      if (videoRef.current) videoRef.current.pause();
      setIsPlaying(false);
      return;
    }
    // Start playing from current position
    if (timeline.length === 0) return;
    let { index, localTime } = getClipAtTime(playhead);
    if (index < 0) { index = 0; localTime = 0; setPlayhead(0); setCurrentTime(0); }
    setActiveClipIndex(index);
    setSelectedAsset(timeline[index]);
    setPreviewUrl(timeline[index].url);
    setIsPlaying(true);
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.currentTime = localTime;
        videoRef.current.play();
      }
    }, 150);
  }

  function selectClipForPreview(asset) {
    setSelectedAsset(asset);
    setPreviewUrl(asset.url);
  }

  // Effects
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
    setLoading(true); setStatus('Adding text...');
    const ffmpeg = ffmpegRef.current;
    const resp = await fetch(asset.url);
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await resp.arrayBuffer()));
    await ffmpeg.exec(['-i', 'input.mp4', '-vf', `drawtext=text='${text}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`, '-c:a', 'copy', 'output.mp4']);
    const output = await ffmpeg.readFile('output.mp4');
    await uploadResult(new Blob([output.buffer], { type: 'video/mp4' }), 'text', asset.duration);
  }

  async function removeDeadSpace(asset) {
    setLoading(true); setStatus('Removing silence...');
    const ffmpeg = ffmpegRef.current;
    const resp = await fetch(asset.url);
    await ffmpeg.writeFile('input.mp4', new Uint8Array(await resp.arrayBuffer()));
    await ffmpeg.exec(['-i', 'input.mp4', '-af', 'silenceremove=start_periods=1:start_duration=0.1:start_threshold=-40dB,silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-40dB', '-c:v', 'copy', 'output.mp4']);
    const output = await ffmpeg.readFile('output.mp4');
    await uploadResult(new Blob([output.buffer], { type: 'video/mp4' }), 'no-silence', null);
  }

  async function uploadResult(blob, suffix, duration) {
    const storagePath = `${currentProject.id}/${Date.now()}_${suffix}.mp4`;
    const { error } = await supabase.storage.from('videos').upload(storagePath, blob);
    if (error) { setStatus('Save failed: ' + error.message); setLoading(false); return; }
    const url = getPublicUrl('videos', storagePath);
    const { data: newAsset } = await supabase.from('assets').insert({ project_id: currentProject.id, type: 'video', filename: `${suffix}.mp4`, storage_path: storagePath, duration, url }).select().single();
    if (newAsset) {
      const a = { ...newAsset, url };
      setAssets(prev => [...prev, a]);
      setTimeline(prev => [...prev, a]);
      selectClipForPreview(a);
    }
    setStatus('Ready'); setLoading(false); setProgress(0);
  }

  async function deleteAsset(e, asset) {
    e.stopPropagation();
    if (!confirm('Delete?')) return;
    const bucket = asset.type === 'audio' ? 'audio' : 'videos';
    await supabase.storage.from(bucket).remove([asset.storage_path]);
    await supabase.from('assets').delete().eq('id', asset.id);
    setAssets(assets.filter(a => a.id !== asset.id));
    setTimeline(timeline.filter(t => t.id !== asset.id));
    if (selectedAsset?.id === asset.id) { setSelectedAsset(null); setPreviewUrl(null); }
  }

  function removeFromTimeline(e, idx) {
    e.stopPropagation();
    setTimeline(prev => prev.filter((_, i) => i !== idx));
  }

  function formatTC(s) {
    if (!s || isNaN(s)) return '00:00:00:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const fr = Math.floor((s % 1) * 30);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}:${String(fr).padStart(2,'0')}`;
  }

  // ============ PROJECT LIST ============
  if (!currentProject) {
    return (
      <div style={S.root}>
        <div style={S.topBar}>
          <div style={S.logo}>⬡ Covenant Editor</div>
        </div>
        <div style={S.projectPage}>
          <h2 style={S.projectTitle}>Recent Projects</h2>
          <div style={S.projectRow}>
            <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="New project..." style={S.input} onKeyDown={e => e.key === 'Enter' && createProject()} />
            <button onClick={createProject} style={S.btnBlue}>+ New Project</button>
          </div>
          <div style={S.projectGrid}>
            {projects.map(p => (
              <div key={p.id} style={S.projectCard} onClick={() => selectProject(p)}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎬</div>
                <div style={{ color: '#fff', fontWeight: 600, fontSize: '13px' }}>{p.name}</div>
                <div style={{ color: '#666', fontSize: '11px', marginTop: '4px' }}>{new Date(p.created_at).toLocaleDateString()}</div>
                <button onClick={e => deleteProject(e, p)} style={S.cardDel}>×</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const totalDur = getTotalDuration();

  // ============ EDITOR ============
  return (
    <div style={S.root}>
      {/* Top Menu */}
      <div style={S.topBar}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={S.logo}>⬡</div>
          <button onClick={() => { setCurrentProject(null); setAssets([]); setTimeline([]); setSelectedAsset(null); }} style={S.menuBtn}>← Projects</button>
          <span style={{ color: '#aaa', fontSize: '12px' }}>{currentProject.name}</span>
          <button onClick={() => setShowSeqSettings(!showSeqSettings)} style={S.menuBtn}>Sequence</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {loading && <div style={S.progressBar}><div style={{ ...S.progressFill, width: `${progress}%` }} /></div>}
          <span style={{ color: '#666', fontSize: '11px' }}>{status}</span>
        </div>
      </div>

      {/* Sequence Settings Popup */}
      {showSeqSettings && (
        <div style={S.seqPopup}>
          <div style={S.seqTitle}>Sequence Settings</div>
          <label style={S.seqLabel}>Width <input type="number" value={sequenceSettings.width} onChange={e => setSequenceSettings({...sequenceSettings, width: +e.target.value})} style={S.seqInput} /></label>
          <label style={S.seqLabel}>Height <input type="number" value={sequenceSettings.height} onChange={e => setSequenceSettings({...sequenceSettings, height: +e.target.value})} style={S.seqInput} /></label>
          <label style={S.seqLabel}>FPS <input type="number" value={sequenceSettings.fps} onChange={e => setSequenceSettings({...sequenceSettings, fps: +e.target.value})} style={S.seqInput} /></label>
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button onClick={() => setSequenceSettings({ width: 1080, height: 1920, fps: 30 })} style={S.seqPreset}>9:16 Vertical</button>
            <button onClick={() => setSequenceSettings({ width: 1920, height: 1080, fps: 30 })} style={S.seqPreset}>16:9 Landscape</button>
            <button onClick={() => setSequenceSettings({ width: 1080, height: 1080, fps: 30 })} style={S.seqPreset}>1:1 Square</button>
          </div>
          <button onClick={() => setShowSeqSettings(false)} style={{ ...S.btnBlue, marginTop: '12px', width: '100%' }}>Done</button>
        </div>
      )}

      <div style={S.editorLayout}>
        {/* Left Panel - Assets */}
        <div style={S.panel}>
          <div style={S.panelHead}>
            <span>Project</span>
            <label style={S.importBtn}>
              + Import
              <input type="file" accept="video/*,audio/*" multiple onChange={uploadFile} disabled={loading} style={{ display: 'none' }} />
            </label>
          </div>
          <div style={S.panelBody}>
            {assets.map(a => (
              <div key={a.id} draggable onDragStart={e => onAssetDragStart(e, a)} onClick={() => selectClipForPreview(a)}
                style={{ ...S.assetItem, ...(selectedAsset?.id === a.id ? { background: '#37373d' } : {}) }}>
                <div style={S.assetThumb}>{a.type === 'video' ? '🎞' : '🎵'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={S.assetName}>{a.filename}</div>
                  <div style={S.assetMeta}>{a.type} • {formatTC(a.duration)}</div>
                </div>
                <button onClick={e => deleteAsset(e, a)} style={S.xBtn}>×</button>
              </div>
            ))}
            {!assets.length && <div style={S.empty}>Drag & drop or click Import</div>}
          </div>
        </div>

        {/* Center - Program Monitor */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={S.panelHead}>
            <span>Program</span>
            <span style={{ color: '#666', fontSize: '10px' }}>{sequenceSettings.width}×{sequenceSettings.height} @ {sequenceSettings.fps}fps</span>
          </div>
          <div style={S.monitor}>
            {previewUrl ? (
              <video ref={videoRef} src={previewUrl} controls crossOrigin="anonymous"
                style={{ maxWidth: '100%', maxHeight: '100%', aspectRatio: '9/16' }}
                onLoadedData={() => { if (videoRef.current && isPlaying) videoRef.current.play(); }} />
            ) : (
              <div style={{ color: '#444', fontSize: '13px' }}>Select a clip to preview</div>
            )}
          </div>
          {/* Transport Controls */}
          <div style={S.transport}>
            <div style={S.timecode}>{formatTC(currentTime)}</div>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = 0; }} style={S.transportBtn}>⏮</button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime -= 1/30; }} style={S.transportBtn}>◀</button>
              <button onClick={togglePlay} style={{ ...S.transportBtn, background: '#4f8ef7', color: '#fff', width: '36px' }}>{isPlaying ? '⏸' : '▶'}</button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime += 1/30; }} style={S.transportBtn}>▶</button>
              <button onClick={() => { if (videoRef.current) videoRef.current.currentTime = videoRef.current.duration; }} style={S.transportBtn}>⏭</button>
            </div>
            <div style={S.timecode}>{formatTC(selectedAsset?.duration)}</div>
          </div>
        </div>

        {/* Right Panel - Effects */}
        <div style={S.panel}>
          <div style={S.panelHead}><span>Effects</span></div>
          <div style={S.panelBody}>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => cutVideo(selectedAsset)} style={S.effectBtn}>✂️ Razor / Cut</button>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => adjustVolume(selectedAsset)} style={S.effectBtn}>🔊 Audio Gain</button>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => addText(selectedAsset)} style={S.effectBtn}>T  Text Overlay</button>
            <button disabled={!selectedAsset || loading || !ffmpegLoaded} onClick={() => removeDeadSpace(selectedAsset)} style={S.effectBtn}>🔇 Remove Silence</button>
            <div style={{ height: '1px', background: '#3e3e3e', margin: '8px 0' }} />
            {selectedAsset && <a href={selectedAsset.url} download={selectedAsset.filename} style={S.effectBtn}>⬇️ Export</a>}
            {!ffmpegLoaded && <div style={{ color: '#f0ad4e', fontSize: '10px', padding: '8px' }}>Loading engine...</div>}
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div style={S.timelineWrap}>
        <div style={S.timelineHead}>
          <span style={{ fontSize: '11px', color: '#999', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Timeline</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '10px', color: '#666' }}>Zoom</span>
            <input type="range" min="2" max="30" value={zoom} onChange={e => setZoom(+e.target.value)} style={{ width: '80px', accentColor: '#4f8ef7' }} />
            <span style={{ fontSize: '10px', color: '#888' }}>{formatTC(totalDur)}</span>
          </div>
        </div>

        {/* Time ruler */}
        <div style={S.ruler}>
          {Array.from({ length: Math.ceil(totalDur) + 1 }, (_, i) => (
            <div key={i} style={{ position: 'absolute', left: `${i * zoom}px`, color: '#555', fontSize: '9px', borderLeft: '1px solid #333', height: '100%', paddingLeft: '3px' }}>
              {i}s
            </div>
          ))}
        </div>

        {/* V1 Track */}
        <div style={S.track} ref={timelineRef} onClick={onTimelineClick}
          onDragOver={onTimelineDragOver} onDragLeave={onTimelineDragLeave} onDrop={onTimelineDrop}>
          <div style={S.trackLabel}>V1</div>
          <div style={{ ...S.trackArea, ...(dragOverTimeline ? { background: '#2a3a4a' } : {}) }}>
            {timeline.map((clip, idx) => (
              <div key={`${clip.id}-${idx}`} draggable
                onDragStart={e => onClipDragStart(e, idx)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => onClipDrop(e, idx)}
                onClick={(e) => { e.stopPropagation(); selectClipForPreview(clip); }}
                style={{
                  ...S.clip,
                  width: `${Math.max((clip.duration || 5) * zoom, 40)}px`,
                  ...(activeClipIndex === idx ? { border: '1px solid #4f8ef7', background: '#3a5a8a' } : {}),
                  ...(selectedAsset?.id === clip.id && activeClipIndex !== idx ? { border: '1px solid #666' } : {})
                }}>
                <div style={S.clipName}>{clip.filename}</div>
                <div style={S.clipDur}>{formatTC(clip.duration)}</div>
                <button onClick={e => removeFromTimeline(e, idx)} style={S.clipX}>×</button>
              </div>
            ))}
            {!timeline.length && <div style={{ color: '#444', fontSize: '11px', padding: '8px' }}>Drag clips here</div>}

            {/* Playhead */}
            {totalDur > 0 && (
              <div style={{ position: 'absolute', left: `${40 + currentTime * zoom}px`, top: 0, bottom: 0, width: '2px', background: '#ff4444', zIndex: 10, pointerEvents: 'none' }}>
                <div style={{ position: 'absolute', top: '-6px', left: '-5px', width: 0, height: 0, borderLeft: '6px solid transparent', borderRight: '6px solid transparent', borderTop: '6px solid #ff4444' }} />
              </div>
            )}
          </div>
        </div>

        {/* A1 Track */}
        <div style={S.track}>
          <div style={S.trackLabel}>A1</div>
          <div style={S.trackArea}>
            {assets.filter(a => a.type === 'audio').map(a => (
              <div key={a.id} style={{ ...S.clipAudio, width: `${Math.max((a.duration || 5) * zoom, 40)}px` }}>
                <div style={S.clipName}>{a.filename}</div>
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
  topBar: { background: '#2d2d2d', borderBottom: '1px solid #3e3e3e', padding: '0 12px', height: '32px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 },
  logo: { color: '#9999ff', fontWeight: 700, fontSize: '14px' },
  menuBtn: { background: 'none', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: '12px', padding: '4px 8px' },
  progressBar: { width: '100px', height: '3px', background: '#333', borderRadius: '2px', overflow: 'hidden' },
  progressFill: { height: '100%', background: '#4f8ef7', transition: 'width 0.3s' },
  input: { flex: 1, padding: '8px 12px', background: '#2d2d2d', border: '1px solid #3e3e3e', borderRadius: '4px', color: '#fff', fontSize: '13px', outline: 'none' },
  btnBlue: { padding: '8px 16px', background: '#4f8ef7', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' },

  projectPage: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '40px' },
  projectTitle: { fontSize: '20px', fontWeight: 600, color: '#fff', marginBottom: '20px' },
  projectRow: { display: 'flex', gap: '8px', marginBottom: '24px', width: '100%', maxWidth: '500px' },
  projectGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', width: '100%', maxWidth: '700px' },
  projectCard: { background: '#2d2d2d', border: '1px solid #3e3e3e', borderRadius: '6px', padding: '20px', cursor: 'pointer', textAlign: 'center', position: 'relative' },
  cardDel: { position: 'absolute', top: '6px', right: '8px', background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '16px' },

  editorLayout: { display: 'flex', flex: 1, overflow: 'hidden' },
  panel: { width: '220px', background: '#252526', borderRight: '1px solid #3e3e3e', display: 'flex', flexDirection: 'column', flexShrink: 0 },
  panelHead: { padding: '6px 12px', borderBottom: '1px solid #3e3e3e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', color: '#999', background: '#2d2d2d' },
  panelBody: { flex: 1, overflow: 'auto', padding: '4px' },
  importBtn: { padding: '3px 8px', background: '#4f8ef7', borderRadius: '3px', color: '#fff', cursor: 'pointer', fontSize: '10px', fontWeight: 600 },

  assetItem: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px', borderRadius: '3px', cursor: 'grab', marginBottom: '1px' },
  assetThumb: { width: '32px', height: '24px', background: '#1e1e1e', borderRadius: '2px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', flexShrink: 0 },
  assetName: { color: '#ccc', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  assetMeta: { color: '#555', fontSize: '10px' },
  xBtn: { background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: '14px' },
  empty: { color: '#444', textAlign: 'center', padding: '20px', fontSize: '11px' },

  monitor: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#000', margin: '4px', borderRadius: '2px', overflow: 'hidden' },
  transport: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 12px', background: '#2d2d2d', borderTop: '1px solid #3e3e3e' },
  transportBtn: { width: '28px', height: '24px', background: '#333', border: '1px solid #444', borderRadius: '3px', color: '#ccc', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px' },
  timecode: { fontFamily: 'monospace', fontSize: '12px', color: '#4f8ef7', letterSpacing: '1px' },

  effectBtn: { display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 10px', background: 'none', border: '1px solid transparent', borderRadius: '3px', color: '#ccc', cursor: 'pointer', fontSize: '12px', textDecoration: 'none', textAlign: 'left', marginBottom: '2px' },

  seqPopup: { position: 'absolute', top: '36px', left: '200px', background: '#2d2d2d', border: '1px solid #4f8ef7', borderRadius: '6px', padding: '16px', zIndex: 100, width: '280px' },
  seqTitle: { color: '#fff', fontWeight: 600, fontSize: '13px', marginBottom: '12px' },
  seqLabel: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#aaa', fontSize: '12px', marginBottom: '6px' },
  seqInput: { width: '80px', padding: '4px 8px', background: '#1e1e1e', border: '1px solid #3e3e3e', borderRadius: '3px', color: '#fff', fontSize: '12px', textAlign: 'right' },
  seqPreset: { padding: '4px 8px', background: '#333', border: '1px solid #444', borderRadius: '3px', color: '#ccc', cursor: 'pointer', fontSize: '10px' },

  timelineWrap: { height: '180px', background: '#1e1e1e', borderTop: '2px solid #4f8ef7', flexShrink: 0, display: 'flex', flexDirection: 'column' },
  timelineHead: { padding: '4px 12px', background: '#2d2d2d', borderBottom: '1px solid #3e3e3e', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  ruler: { height: '18px', background: '#252526', borderBottom: '1px solid #333', position: 'relative', overflow: 'hidden', marginLeft: '40px' },
  track: { display: 'flex', height: '50px', borderBottom: '1px solid #2a2a2a', position: 'relative' },
  trackLabel: { width: '40px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#252526', borderRight: '1px solid #3e3e3e', fontSize: '10px', color: '#888', fontWeight: 600, flexShrink: 0 },
  trackArea: { flex: 1, display: 'flex', alignItems: 'center', padding: '4px', gap: '2px', overflow: 'auto', position: 'relative' },
  clip: { height: '38px', background: '#3a5a7a', borderRadius: '3px', padding: '2px 6px', display: 'flex', flexDirection: 'column', justifyContent: 'center', cursor: 'grab', flexShrink: 0, border: '1px solid transparent', position: 'relative', overflow: 'hidden' },
  clipAudio: { height: '38px', background: '#3a7a5a', borderRadius: '3px', padding: '2px 6px', display: 'flex', alignItems: 'center', flexShrink: 0 },
  clipName: { fontSize: '10px', color: '#fff', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  clipDur: { fontSize: '9px', color: 'rgba(255,255,255,0.5)' },
  clipX: { position: 'absolute', top: '1px', right: '3px', background: 'none', border: 'none', color: 'rgba(255,255,255,0.3)', cursor: 'pointer', fontSize: '12px' },
};

export default App;
