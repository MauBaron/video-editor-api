import { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://your-project.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'your-anon-key';
const supabase = createClient(supabaseUrl, supabaseAnonKey);

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api/v1';

function App() {
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [assets, setAssets] = useState([]);
  const [projectName, setProjectName] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchProjects();
  }, []);

  async function fetchProjects() {
    try {
      const res = await fetch(`${API_URL}/projects`);
      const data = await res.json();
      setProjects(data);
    } catch (err) {
      console.error('Failed to fetch projects:', err);
    }
  }

  async function createProject() {
    if (!projectName.trim()) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: projectName })
      });
      const data = await res.json();
      setProjects([data, ...projects]);
      setProjectName('');
    } catch (err) {
      console.error('Failed to create project:', err);
    }
    setLoading(false);
  }

  async function selectProject(project) {
    try {
      const res = await fetch(`${API_URL}/projects/${project.id}`);
      const data = await res.json();
      setCurrentProject(data.project);
      setAssets(data.assets || []);
    } catch (err) {
      console.error('Failed to fetch project:', err);
    }
  }

  async function uploadFile(e) {
    const file = e.target.files[0];
    if (!file || !currentProject) return;
    
    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('projectId', currentProject.id);
    formData.append('type', file.type.startsWith('video') ? 'video' : 'audio');
    
    try {
      const res = await fetch(`${API_URL}/assets/upload`, {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      setAssets([...assets, data]);
    } catch (err) {
      console.error('Upload failed:', err);
    }
    setLoading(false);
  }

  async function cutVideo(assetId) {
    const start = prompt('Start time (seconds):');
    const end = prompt('End time (seconds):');
    if (!start || !end) return;
    
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/edits/cut`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          assetId, 
          start: parseFloat(start), 
          end: parseFloat(end),
          projectId: currentProject.id
        })
      });
      const data = await res.json();
      setAssets([...assets, data]);
    } catch (err) {
      console.error('Cut failed:', err);
    }
    setLoading(false);
  }

  async function adjustVolume(assetId) {
    const volume = prompt('Volume (0-200):', '100');
    if (!volume) return;
    
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/edits/volume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          assetId, 
          volume: parseInt(volume) / 100,
          projectId: currentProject.id
        })
      });
      const data = await res.json();
      setAssets([...assets, data]);
    } catch (err) {
      console.error('Volume adjust failed:', err);
    }
    setLoading(false);
  }

  async function addText(assetId) {
    const text = prompt('Text to overlay:');
    if (!text) return;
    
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/edits/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          assetId, 
          text,
          position: 'center',
          fontSize: 48,
          color: 'white',
          projectId: currentProject.id
        })
      });
      const data = await res.json();
      setAssets([...assets, data]);
    } catch (err) {
      console.error('Text overlay failed:', err);
    }
    setLoading(false);
  }

  async function renderVideo(assetId) {
    setLoading(true);
    try {
      const res = await fetch(`${API_URL}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          assetId, 
          projectId: currentProject.id
        })
      });
      const data = await res.json();
      alert(`Render complete! URL: ${data.url}`);
    } catch (err) {
      console.error('Render failed:', err);
    }
    setLoading(false);
  }

  return (
    <div style={{ padding: '20px', fontFamily: 'system-ui' }}>
      <h1>🎬 Video Editor</h1>
      
      {!currentProject ? (
        <div>
          <h2>Projects</h2>
          <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="Project name"
              style={{ padding: '8px', flex: 1 }}
            />
            <button onClick={createProject} disabled={loading} style={{ padding: '8px 16px' }}>
              Create Project
            </button>
          </div>
          
          <div style={{ display: 'grid', gap: '10px' }}>
            {projects.map(p => (
              <div 
                key={p.id} 
                onClick={() => selectProject(p)}
                style={{ 
                  padding: '15px', 
                  border: '1px solid #ddd', 
                  cursor: 'pointer',
                  borderRadius: '8px'
                }}
              >
                {p.name}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <button onClick={() => setCurrentProject(null)} style={{ marginBottom: '20px' }}>
            ← Back to Projects
          </button>
          <h2>{currentProject.name}</h2>
          
          <div style={{ marginBottom: '20px' }}>
            <input type="file" accept="video/*,audio/*" onChange={uploadFile} disabled={loading} />
          </div>
          
          <h3>Assets</h3>
          <div style={{ display: 'grid', gap: '10px' }}>
            {assets.map(a => (
              <div key={a.id} style={{ padding: '15px', border: '1px solid #ddd', borderRadius: '8px' }}>
                <strong>{a.filename}</strong> ({a.type}) - {a.duration?.toFixed(1)}s
                {a.url && (
                  <div style={{ marginTop: '10px' }}>
                    <video src={a.url} controls style={{ maxWidth: '200px' }} />
                  </div>
                )}
                <div style={{ marginTop: '10px', display: 'flex', gap: '5px' }}>
                  {a.type === 'video' && (
                    <>
                      <button onClick={() => cutVideo(a.id)}>✂️ Cut</button>
                      <button onClick={() => adjustVolume(a.id)}>🔊 Volume</button>
                      <button onClick={() => addText(a.id)}>✏️ Text</button>
                      <button onClick={() => renderVideo(a.id)}>🎬 Export</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
