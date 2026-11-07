// End-to-end test of the real desktop app: real window, real WebGL, real mouse input.
// Run with: npm run e2e  (screenshots go to THICKSHAKE_SHOTS, default ./e2e-shots)
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const outDir = process.env.THICKSHAKE_SHOTS || path.join(__dirname, '..', 'e2e-shots');
fs.mkdirSync(outDir, { recursive: true });
app.setPath('userData', path.join(app.getPath('temp'), `thickshake-e2e-${Date.now()}`));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The real main process isn't running here, so answer its housekeeping calls.
Menu.setApplicationMenu(null);
ipcMain.handle('set-title', () => {});
ipcMain.handle('autosave-read', () => null);
ipcMain.handle('autosave-write', () => {});
ipcMain.handle('autosave-clear', () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1600, height: 980, show: true, backgroundColor: '#17191c',
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.cjs'), contextIsolation: true, sandbox: false, backgroundThrottling: false },
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  win.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  await win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.focus();
  win.webContents.focus();
  await sleep(800);

  const js = (code) => win.webContents.executeJavaScript(`(async()=>{const T=window.__thickshake,ed=T.ed,vp=T.vp;${code}})()`);
  const shot = async (name) => { await sleep(350); const i = await win.webContents.capturePage(); fs.writeFileSync(path.join(outDir, `${name}.png`), i.toPNG()); };
  const send = (e) => win.webContents.sendInputEvent(e);
  const drag = async (a, b, opts = {}) => {
    const button = opts.button || 'left';
    const mods = opts.modifiers || [];
    send({ type: 'mouseMove', x: a.x, y: a.y });
    await sleep(40);
    send({ type: 'mouseDown', x: a.x, y: a.y, button, clickCount: 1, modifiers: mods });
    await sleep(40);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      send({ type: 'mouseMove', x: Math.round(a.x + ((b.x - a.x) * i) / steps), y: Math.round(a.y + ((b.y - a.y) * i) / steps), button, modifiers: mods });
      await sleep(25);
    }
    send({ type: 'mouseUp', x: b.x, y: b.y, button, clickCount: 1, modifiers: mods });
    await sleep(120);
  };
  const click = (p, o) => drag(p, p, o);
  /** Client coordinates of a world point in a pane (default: the active one). */
  const screen = (x, y, z, pane = 'vp.active') => js(`const p=${pane};const s=p.project(${x},${y},${z});const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)};`);
  const count = () => js('return {v:ed.model.verts.length,f:ed.model.faces.length,g:ed.model.groups.length,b:ed.model.bones.length}');

  try {
    await shot('01-welcome');
    check('Starts empty', (await count()).f === 0);

    // --- Create a box from the welcome card, using the real button.
    const btn = await js(`const b=[...document.querySelectorAll('.welcome button')].find(x=>x.textContent.includes('box'));const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};`);
    await click(btn);
    let c = await count();
    check('Welcome button creates a box', c.f === 6 && c.v === 8, JSON.stringify(c));
    check('Welcome card hides', await js(`return document.querySelector('.welcome').style.display==='none'`));

    // --- Maximize perspective and click a face.
    await js(`vp.setLayout('single',vp.panes[1]);vp.panes[1].yaw=0.5;vp.panes[1].pitch=0.5;vp.panes[1].update();vp.invalidate();`);
    await sleep(150);
    await js(`ed.clearSelection();ed.mode='face';ed.emit('selection','tool');`);
    const topPt = await screen(0, 0.5, 0);
    await click(topPt);
    const picked = await js(`const i=[...ed.selFaces];return i.length===1?ed.model.faces[i[0]].v.every(v=>Math.abs(ed.model.verts[v].p[1]-0.5)<1e-6):false`);
    check('Clicking the top of the box selects the top face', picked);

    // --- Move with the real gizmo: drag the Y arrow up.
    await js(`T.runCommand('tool.move');`);
    await sleep(120);
    const up = await js(`const c=vp.gizmoCenter();const s=vp.active.project(c.x,c.y,c.z);const u=vp.active.unitsPerPixel(c)*50;const e=vp.active.project(c.x,c.y+u,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(e.x+r.left),y:Math.round(e.y+r.top)}`);
    await drag(up, { x: up.x, y: up.y - 60 });
    const maxY = await js(`return Math.max(...ed.model.verts.map(v=>v.p[1]))`);
    check('Dragging the gizmo arrow moves the face up', maxY > 0.55, `top y=${maxY.toFixed(3)}`);
    const xSame = await js(`return ed.model.verts.every(v=>Math.abs(Math.abs(v.p[0])-0.5)<1e-5)`);
    check('Axis drag stays on its axis', xSame);
    await shot('02-gizmo-move');

    // --- Undo / redo through the keyboard.
    send({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); send({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
    await sleep(120);
    check('Ctrl+Z restores geometry', Math.abs((await js(`return Math.max(...ed.model.verts.map(v=>v.p[1]))`)) - 0.5) < 1e-6);
    await js(`T.runCommand('edit.redo')`);
    await sleep(80);
    check('Redo reapplies it', (await js(`return Math.max(...ed.model.verts.map(v=>v.p[1]))`)) > 0.55);

    // --- Rotate and scale gizmos.
    await js(`T.runCommand('tool.scale')`);
    await sleep(120);
    let cen = await js(`const c=vp.gizmoCenter();const s=vp.active.project(c.x,c.y,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    const beforeSize = await js(`const vs=[...ed.selectedVertexSet()].map(i=>ed.model.verts[i].p[0]);return Math.max(...vs)-Math.min(...vs)`);
    await drag(cen, { x: cen.x + 60, y: cen.y - 60 });
    const afterSize = await js(`const vs=[...ed.selectedVertexSet()].map(i=>ed.model.verts[i].p[0]);return Math.max(...vs)-Math.min(...vs)`);
    check('Scale handle enlarges the face', afterSize > beforeSize * 1.2, `${beforeSize.toFixed(2)} -> ${afterSize.toFixed(2)}`);
    await js(`T.runCommand('tool.rotate')`);
    await sleep(120);
    cen = await js(`const c=vp.gizmoCenter();const s=vp.active.project(c.x,c.y,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    const ring = await js(`const G=80*1.18;return ${0}+G`);
    const before = await js(`return JSON.stringify(ed.model.verts.map(v=>v.p))`);
    await drag({ x: cen.x + Math.round(ring), y: cen.y }, { x: cen.x, y: cen.y - Math.round(ring) });
    await shot('03-gizmo-rotate');
    check('Rotate view ring changes the face', before !== (await js(`return JSON.stringify(ed.model.verts.map(v=>v.p))`)));
    await js(`ed.undo();ed.undo();`);

    // --- Extrude by pulling a face with the tool (Push/Pull) and a real drag. Picked without T, so it doesn't
    // start extruding the selection at once.
    await js(`ed.tool='extrude';ed.emit('tool')`);
    await sleep(100);
    const f0 = (await count()).f;
    cen = await screen(0, 0.6, 0);
    await drag(cen, { x: cen.x, y: cen.y - 70 });
    c = await count();
    check('Extrude tool adds 4 walls', c.f === f0 + 4, `${f0} -> ${c.f}`);
    const y2 = await js(`return Math.max(...ed.model.verts.map(v=>v.p[1]))`);
    check('Extrude pulls along the normal', y2 > 0.7, `top y=${y2.toFixed(3)}`);
    await shot('04-extrude');
    const closed = await js(`const m=ed.model;const seen={};for(const f of m.faces)f.v.forEach((a,i)=>{const b=f.v[(i+1)%f.v.length];const k=a<b?a+'_'+b:b+'_'+a;seen[k]=(seen[k]||0)+1});return Object.values(seen).every(x=>x===2)`);
    check('Extruded mesh is still watertight', closed);
    // Pushing a face in keeps it closed and its walls facing out.
    const fPush = (await count()).f;
    const side = await screen(0, 0.3, 0.5);
    await drag(side, { x: side.x, y: side.y + 25 });
    check('Pushing a face in adds walls too', (await count()).f === fPush + 4);
    check('Pushed-in mesh is still watertight', await js(`const m=ed.model;const seen={};for(const f of m.faces)f.v.forEach((a,i)=>{const b=f.v[(i+1)%f.v.length];const k=a<b?a+'_'+b:b+'_'+a;seen[k]=(seen[k]||0)+1});return Object.values(seen).every(x=>x===2)`));
    await js(`ed.undo()`);

    // --- Adjustable op: inset then change its amount.
    await js(`T.runCommand('tool.select');T.runCommand('mesh.inset')`);
    await sleep(100);
    const f1 = (await count()).f;
    const verts1 = await js(`const f=ed.model.faces[[...ed.selFaces][0]];return f.v.map(v=>[...ed.model.verts[v].p])`);
    await js(`ed.adjustLastOp('amount',0.6)`);
    await sleep(100);
    const verts2 = await js(`const f=ed.model.faces[[...ed.selFaces][0]];return f.v.map(v=>[...ed.model.verts[v].p])`);
    check('Last-op panel re-runs without stacking', (await count()).f === f1 && JSON.stringify(verts1) !== JSON.stringify(verts2));
    await shot('05-lastop');
    await js(`T.runCommand('edit.undo')`);

    // --- Box select in an ortho view (real drag) in vertex mode.
    await js(`vp.setLayout('quad');vp.active=vp.panes[2];T.runCommand('mode.vertex');T.runCommand('select.none');vp.frameSelected(true);`);
    await sleep(200);
    const box3 = await js(`const P=ed.model.verts.map(v=>v.p);return {x0:Math.min(...P.map(p=>p[0])),x1:Math.max(...P.map(p=>p[0])),y0:Math.min(...P.map(p=>p[1])),y1:Math.max(...P.map(p=>p[1]))}`);
    const pA = await screen(box3.x0 - 0.05, box3.y1 + 0.05, 0, 'vp.panes[2]');
    const pB = await screen(box3.x1 + 0.05, box3.y0 - 0.05, 0, 'vp.panes[2]');
    await drag(pA, pB);
    const n = await js(`return ed.selVerts.size`);
    check('Box select in the Front view grabs vertices', n === (await count()).v, `${n} selected`);
    await js(`T.runCommand('select.none');T.runCommand('mode.face')`);

    // --- Primitive by real drag in the Top view.
    await js(`T.runCommand('tool.sphere')`);
    await sleep(100);
    const g0 = (await count()).g;
    const a = await screen(2, 0, 0, 'vp.panes[0]');
    await drag(a, { x: a.x + 40, y: a.y });
    c = await count();
    check('Dragging with the Sphere tool creates a group', c.g === g0 + 1);
    await js(`T.runCommand('tool.select')`);
    await shot('06-quad-with-sphere');

    // --- Full demo + heavy ops.
    await js(`ed.dirty=false;T.runCommand('file.sample')`);
    await sleep(500);
    await shot('07-demo-model');
    c = await count();
    check('Demo loads with skeleton', c.b === 5 && c.f > 100, JSON.stringify(c));

    await js(`T.runCommand('mesh.subdivide')`);
    await sleep(200);
    check('Subdivide all', (await count()).f > c.f);
    await js(`T.runCommand('edit.undo')`);
    await js(`T.runCommand('mesh.generateLods')`);
    await sleep(300);
    const lod = await js(`return ed.model.groups.filter(g=>g.kind==='lod').map(g=>({n:g.name,t:ed.model.faces.filter(f=>f.g===g.id).length}))`);
    check('LOD generation makes hidden groups', lod.length === 8, JSON.stringify(lod.slice(0, 2)));
    await js(`T.runCommand('mesh.collisionHull')`);
    await sleep(200);
    check('Collision hull', await js(`return ed.model.groups.some(g=>g.kind==='collision')`));

    // --- Real round trips through the same loaders the app uses.
    const rt = await js(`
      const src=ed.model;
      const glb=T.exportGLB(src,{...T.defaultExport,includeCollision:false});
      const m=await T.importFile('t.glb',glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength));
      return {groups:m.groups.length,src:src.groups.length,bones:m.bones.length,clips:m.clips.map(c=>c.name),mats:m.materials.length};
    `);
    check('GLB exports and re-imports with skeleton + clip', rt.bones === 5 && rt.clips.includes('Wobble') && rt.mats === 4, JSON.stringify(rt));

    const rtPose = await js(`
      const src=ed.model;
      const glb=T.exportGLB(src,{...T.defaultExport,includeLods:false,includeCollision:false});
      const m=await T.importFile('t.glb',glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength));
      const a=src.bones.find(b=>b.name==='Straw3');const b=m.bones.find(x=>x.name==='Straw3');
      const d=Math.hypot(a.head[0]-b.head[0],a.head[1]-b.head[1],a.head[2]-b.head[2]);
      const sw=src.faces.filter(f=>!src.groups.find(g=>g.id===f.g&&g.kind!=='mesh')).reduce((s,f)=>s+f.v.length-2,0);
      return {d,srcTris:sw,impTris:m.faces.length};
    `);
    check('GLB round trip keeps joint positions and triangle count', rtPose.d < 1e-3 && rtPose.srcTris === rtPose.impTris, JSON.stringify(rtPose));

    // --- Workspaces and panels.
    await js(`T.runCommand('edit.undo');T.runCommand('edit.undo');T.setWorkspace('animate');ed.frame=15;ed.emit('time');vp.frameSelected(true);`);
    await shot('08-animate');
    const moved = await js(`const d=ed.displayPositions();let best=0;ed.model.verts.forEach((v,i)=>{best=Math.max(best,Math.hypot(d[i*3]-v.p[0],d[i*3+1]-v.p[1],d[i*3+2]-v.p[2]))});return best`);
    check('Animated pose deforms the mesh', moved > 0.05, `max delta ${moved.toFixed(3)}`);

    // Rotate a joint in pose mode with the real gizmo: should write a key.
    const key0 = await js(`const c=ed.clip();const id=ed.model.bones.find(b=>b.name==='Top').id;ed.activeBone=id;ed.selBones=new Set([id]);ed.frame=22;ed.emit('selection','time');return (c.tracks[id]?.rot.length)||0`);
    await sleep(200);
    cen = await js(`const c=vp.gizmoCenter();const s=vp.active.project(c.x,c.y,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    await drag({ x: cen.x + 94, y: cen.y }, { x: cen.x + 60, y: cen.y - 70 });
    const key1 = await js(`const c=ed.clip();const id=ed.model.bones.find(b=>b.name==='Top').id;return c.tracks[id].rot.length`);
    check('Posing a joint with the gizmo writes a keyframe', key1 === key0 + 1, `${key0} -> ${key1}`);
    await shot('09-pose-key');
    await js(`T.runCommand('edit.undo')`);

    // Playback really advances.
    const f0p = await js(`ed.frame=0;T.runCommand('anim.play');return ed.frame`);
    await sleep(500);
    const f1p = await js(`const f=ed.frame;T.runCommand('anim.play');return f`);
    check('Playback advances frames', f1p > f0p + 3, `${f0p} -> ${f1p.toFixed(1)}`);

    await js(`T.setWorkspace('rig');vp.frameSelected(true);ed.activeBone=ed.model.bones.find(b=>b.name==='Straw2').id;ed.selBones=new Set([ed.activeBone]);vp.panes[1].shading='weights';vp.syncHeaders();ed.emit('selection','skeleton','view');`);
    await shot('10-rig-weights');

    await js(`T.setWorkspace('uv');T.runCommand('select.none');T.uvEditor.draw();`);
    await sleep(600);
    const uvState = await js(`const h=document.querySelector('.uv-host');const c=h.querySelector('canvas').getBoundingClientRect();return {display:getComputedStyle(h).display,w:Math.round(c.width),ws:ed.workspace,mode:ed.mode,tab:document.querySelector('.ws-tabs .active').textContent}`);
    check('UV workspace shows the editor beside the viewport', uvState.display === 'flex' && uvState.w > 200 && uvState.ws === 'uv' && uvState.tab === 'UV', JSON.stringify(uvState));
    await shot('11-uv');
    // Drag a UV island in the editor with the real mouse.
    await js(`T.runCommand('uv.smart')`);
    await sleep(150);
    const uvPt = await js(`const cv=T.uvEditor.el.querySelector('canvas');const rc=cv.getBoundingClientRect();const f=ed.model.faces[ed.selectedFaceSet(true).values().next().value];const u=T.uvEditor.shownFaces?null:null;const shown=T.uvEditor['shownFaces']();const fc=ed.model.faces[shown[0]];const [x,y]=T.uvEditor['toScreen'](fc.uv[0][0],fc.uv[0][1]);return {x:Math.round(rc.left+x),y:Math.round(rc.top+y),before:[...fc.uv[0]],fi:shown[0]}`);
    await drag(uvPt, { x: uvPt.x + 30, y: uvPt.y + 20 });
    const uvAfter = await js(`return [...ed.model.faces[${uvPt.fi}].uv[0]]`);
    check('Dragging a UV point in the editor moves it', Math.abs(uvAfter[0] - uvPt.before[0]) > 0.005, `${uvPt.before[0].toFixed(3)} -> ${uvAfter[0].toFixed(3)}`);

    await js(`T.setWorkspace('model');document.querySelector('[data-tab=audit]').click();`);
    await shot('12-audit');
    check('Leaving Animation returns to the Select tool', await js(`return ed.tool==='select'`));
    await js(`document.querySelector('[data-tab=material]').click();ed.activeMaterial=ed.model.materials[1].id;ed.emit('materials');`);
    await shot('13-material');

    // Scrubbing a material value survives panel refreshes and undoes as one step.
    const label = await js(`const l=[...document.querySelectorAll('.dock .num-label')].find(x=>x.textContent==='Roughness');l.scrollIntoView({block:'center'});const r=l.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    const rough0 = await js(`return ed.model.materials[1].roughness`);
    const depth0 = await js(`return ed.historyDepth`);
    await drag(label, { x: label.x - 40, y: label.y });
    await sleep(200);
    const rough1 = await js(`return ed.model.materials[1].roughness`);
    check('Scrubbing a material value tracks the whole drag', Math.abs(rough1 - (rough0 - 0.4)) < 0.021, `${rough0} -> ${rough1.toFixed(3)}`);
    check('A scrub is one undo step', (await js(`return ed.historyDepth`)) === depth0 + 1);
    await js(`T.runCommand('edit.undo')`);

    // Scrubbing the inspector's Centre field applies its delta exactly once.
    await js(`document.querySelector('[data-tab=scene]').click();ed.mode='face';ed.clearSelection();ed.selFaces.add(0);ed.emit('selection','tool');`);
    await sleep(200);
    const axisLabel = await js(`const l=document.querySelector('.dock .num-label.axis-0');const r=l.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    const cx0 = await js(`const v=[...ed.selectedVertexSet()].map(i=>ed.model.verts[i].p[0]);return (Math.max(...v)+Math.min(...v))/2`);
    await drag(axisLabel, { x: axisLabel.x + 50, y: axisLabel.y });
    await sleep(100);
    const cx1 = await js(`const v=[...ed.selectedVertexSet()].map(i=>ed.model.verts[i].p[0]);return (Math.max(...v)+Math.min(...v))/2`);
    check('Scrubbing the inspector applies once', Math.abs(cx1 - cx0 - 0.5) < 0.021, `moved ${(cx1 - cx0).toFixed(3)}, expected 0.5`);
    await js(`T.runCommand('edit.undo')`);

    // A gizmo drag released over the side panel must still finish and commit.
    await js(`T.runCommand('tool.move');vp.setLayout('single',vp.panes[1]);vp.frameSelected(false);`);
    await sleep(200);
    const gz = await js(`const c=vp.gizmoCenter();const s=vp.active.project(c.x,c.y,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    const depthG = await js(`return ed.historyDepth`);
    const dockX = await js(`return Math.round(document.querySelector('.dock').getBoundingClientRect().left+40)`);
    await drag(gz, { x: dockX, y: gz.y });
    await sleep(150);
    check('A drag released outside the viewport still commits', (await js(`return ed.historyDepth`)) === depthG + 1);
    await js(`T.runCommand('edit.undo');T.runCommand('tool.select');vp.setLayout('quad');`);

    // LightWave camera controls, with real mouse and keyboard input.
    await js(`T.runCommand('tool.select');T.runCommand('workspace.model');vp.setLayout('quad');`);
    await sleep(150);
    const paneAt = (name) => js(`const p=vp.panes.find(q=>q.kind==='${name}');const r=vp.el.getBoundingClientRect();return {x:Math.round(p.x+r.left+p.w/2),y:Math.round(p.y+r.top+p.h/2)}`);
    const cam = (name) => js(`const p=vp.panes.find(q=>q.kind==='${name}');return {yaw:p.yaw,pitch:p.pitch,bank:p.bankAngle,dist:p.dist,oh:p.orthoHeight,grid:p.gridScale(),t:p.target.toArray(),kind:p.kind}`);
    const near = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
    const pc = await paneAt('persp');
    const fc = await paneAt('front');
    const by = (a, dx, dy) => ({ x: a.x + dx, y: a.y + dy });

    let c0 = await cam('persp');
    await drag(pc, by(pc, 60, 30), { modifiers: ['alt'] });
    let c1 = await cam('persp');
    check('Alt+left drag rotates heading and pitch', !near(c1.yaw, c0.yaw) && !near(c1.pitch, c0.pitch));

    c0 = c1;
    await drag(pc, by(pc, 60, 0), { button: 'right', modifiers: ['alt'] });
    c1 = await cam('persp');
    check('Alt+right drag banks the perspective view', !near(c1.bank, c0.bank) && near(c1.dist, c0.dist) && near(c1.yaw, c0.yaw), `bank ${c1.bank.toFixed(3)}`);
    await js(`vp.active=vp.panes.find(q=>q.kind==='persp');T.runCommand('view.level')`);
    check('Level View clears the bank', near((await cam('persp')).bank, 0));

    c0 = await cam('persp');
    await drag(pc, by(pc, 40, 40), { modifiers: ['alt', 'shift'] });
    c1 = await cam('persp');
    check('Shift+Alt+left drag pans along the ground', near(c1.t[1], c0.t[1]) && (!near(c1.t[0], c0.t[0]) || !near(c1.t[2], c0.t[2])));

    c0 = c1;
    await drag(pc, by(pc, 0, 40), { button: 'right', modifiers: ['alt', 'shift'] });
    c1 = await cam('persp');
    check('Shift+Alt+right drag pans straight up or down', c1.t[1] > c0.t[1] && near(c1.t[0], c0.t[0]) && near(c1.t[2], c0.t[2]));

    c0 = c1;
    await drag(pc, by(pc, 80, 0), { modifiers: ['alt', 'control'] });
    c1 = await cam('persp');
    check('Ctrl+Alt+drag right zooms in', c1.dist < c0.dist, `${c0.dist.toFixed(2)} -> ${c1.dist.toFixed(2)}`);

    c0 = c1;
    await drag(pc, by(pc, 0, -80), { modifiers: ['alt', 'control'] });
    c1 = await cam('persp');
    check('Ctrl+Alt+drag up zooms in', c1.dist < c0.dist, `${c0.dist.toFixed(2)} -> ${c1.dist.toFixed(2)}`);

    let o0 = await cam('front');
    await drag(fc, by(fc, 40, 20), { modifiers: ['alt'] });
    let o1 = await cam('front');
    check('Alt+drag pans an orthographic view', !near(o1.t[0], o0.t[0]) && !near(o1.t[1], o0.t[1]));
    const others = await Promise.all(['top', 'right', 'persp'].map(cam));
    check('Other views follow the pan', others.every((v) => v.t.every((n, i) => near(n, o1.t[i]))));

    const oZoom = (await cam('front')).oh;
    send({ type: 'mouseMove', x: fc.x, y: fc.y });
    await sleep(60);
    send({ type: 'mouseWheel', x: fc.x, y: fc.y, deltaX: 0, deltaY: -120, canScroll: true });
    await sleep(120);
    const zoomed = await Promise.all(['front', 'top', 'right'].map(cam));
    check('Orthographic views share a zoom', zoomed[0].oh !== oZoom && zoomed.every((v) => near(v.oh, zoomed[0].oh)), `${oZoom.toFixed(2)} -> ${zoomed[0].oh.toFixed(2)}`);

    await js(`T.runCommand('view.link')`);
    const topBefore = await cam('top');
    await drag(fc, by(fc, 30, 10), { modifiers: ['alt'] });
    const topAfter = await cam('top');
    check('Link Viewports can be turned off', topAfter.t.every((n, i) => near(n, topBefore.t[i])));
    await js(`T.runCommand('view.link')`);
    o1 = await cam('front');

    const widget = (kind, drag) => js(`const p=vp.panes.find(q=>q.kind==='${kind}');const b=p.nav.querySelector('[data-drag="${drag}"]');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),disabled:b.disabled}`);
    let w = await widget('persp', 'orbit');
    c0 = await cam('persp');
    await drag(w, by(w, -50, 30));
    c1 = await cam('persp');
    check('Dragging the rotate button rotates the view', !near(c1.yaw, c0.yaw));
    w = await widget('persp', 'zoom');
    c0 = c1;
    await drag(w, by(w, -60, 0));
    c1 = await cam('persp');
    check('Dragging the zoom button zooms the view', c1.dist > c0.dist);
    c0 = c1;
    await drag(w, by(w, 0, -60));
    c1 = await cam('persp');
    check('Dragging the zoom button up zooms in', c1.dist < c0.dist);
    w = await widget('persp', 'pan');
    c0 = c1;
    await drag(w, by(w, -30, 40));
    c1 = await cam('persp');
    check('Dragging the pan button pans the view', c1.t.some((v, i) => !near(v, c0.t[i])));
    check('Rotate button is off in orthographic views', (await widget('front', 'orbit')).disabled);

    // Keys act on the pane under the mouse.
    const key = async (keyCode, modifiers = []) => { send({ type: 'keyDown', keyCode, modifiers }); send({ type: 'char', keyCode, modifiers }); send({ type: 'keyUp', keyCode, modifiers }); await sleep(80); };
    send({ type: 'mouseMove', x: fc.x, y: fc.y });
    await sleep(80);
    o0 = await cam('front');
    await key('Right');
    o1 = await cam('front');
    check('Right arrow pans one grid square', near(o1.t[0] - o0.t[0], o0.grid), `${(o1.t[0] - o0.t[0]).toFixed(3)} vs ${o0.grid}`);
    o0 = o1;
    await key('Up', ['shift']);
    o1 = await cam('front');
    check('Shift+Up pans four grid squares', near(o1.t[1] - o0.t[1], o0.grid * 4));
    o0 = o1;
    await key('Left', ['alt']);
    o1 = await cam('front');
    check('Alt+Left pans a tenth of a square', near(o0.t[0] - o1.t[0], o0.grid * 0.1));
    o0 = o1;
    await key('.');
    o1 = await cam('front');
    check('Period zooms in', o1.oh < o0.oh);
    o0 = o1;
    await key(',');
    o1 = await cam('front');
    check('Comma zooms out', o1.oh > o0.oh);

    send({ type: 'mouseMove', x: fc.x + 60, y: fc.y + 30 });
    await sleep(80);
    const gWant = await js(`const p=vp.panes.find(q=>q.kind==='front');const r=vp.el.getBoundingClientRect();return p.viewPlanePoint(${fc.x + 60}-r.left,${fc.y + 30}-r.top).toArray()`);
    await key('G');
    o1 = await cam('front');
    check('G centers the view under the mouse', near(o1.t[0], gWant[0], 1e-4) && near(o1.t[1], gWant[1], 1e-4));

    await js(`vp.panes.find(q=>q.kind==='front').target.set(50,50,50);vp.panes.find(q=>q.kind==='front').update();`);
    await key('A');
    o1 = await cam('front');
    check('A fits everything in view', Math.abs(o1.t[0]) < 40);

    const frameBefore = await js(`T.runCommand('workspace.animate');ed.frame=3;ed.emit('time');return ed.frame`);
    await key('Right');
    check('Right arrow still steps frames in Animation', (await js(`return ed.frame`)) === Math.min(frameBefore + 1, await js(`return ed.clip()?.length??0`)));
    await js(`T.runCommand('workspace.model');T.runCommand('tool.select');`);

    await js(`const p=vp.panes.find(q=>q.kind==='front');p.setKind('top');vp.syncHeaders();`);
    send({ type: 'mouseMove', x: fc.x, y: fc.y });
    await sleep(80);
    const kindOf = () => js(`const r=vp.el.getBoundingClientRect();return vp.panes.find(p=>p.contains(${fc.x}-r.left,${fc.y}-r.top)).kind`);
    await js(`ed.setMode('face')`);
    await key('num1');
    check('Numpad 1 shows Back', (await kindOf()) === 'back', await kindOf());
    await key('num1');
    check('Numpad 1 again shows Front', (await kindOf()) === 'front', await kindOf());
    check('Numpad 1 leaves the selection mode alone', (await js(`return ed.mode`)) === 'face');
    await key('1');
    check('Top row 1 still picks Vertex mode', (await js(`return ed.mode`)) === 'vertex');
    await js(`ed.setMode('face')`);
    const maxBefore = await js(`return vp.layout`);
    await key('num0');
    check('Numpad 0 maximizes the pane', (await js(`return vp.layout`)) !== maxBefore);
    await js(`vp.setLayout('quad')`);
    await shot('13b-lightwave-nav');

    // Interface icons must be SVG, never text symbols or emoji.
    await js(`T.runCommand('workspace.animate')`);
    await sleep(200);
    await shot('13c-svg-icons');
    const glyphs = await js(`return (document.body.innerText.match(/[\\u2190-\\u2BFF\\uFF00-\\uFFEF\\u{1F000}-\\u{1FAFF}]/gu)||[]).join('')`);
    check('No symbol characters in the interface', glyphs === '', glyphs);
    check('Timeline and pane buttons draw SVG', await js(`return [...document.querySelectorAll('.tl-btn,.pane-btn')].every(b=>b.querySelector('svg'))`));
    await js(`T.runCommand('workspace.model');T.runCommand('tool.select');`);

    // Drawing primitives the LightWave way, with real input.
    await js(`ed.loadModel(T.emptyModel(),null,'Draw');T.runCommand('workspace.model');vp.setLayout('quad');vp.panes.forEach(p=>p.frame([0,0,0],3));`);
    await sleep(150);
    const bboxOf = () => js(`const P=ed.model.verts.slice(window.__base||0).map(v=>v.p);const r=[0,1,2].map(i=>{const a=P.map(p=>p[i]);return [Math.min(...a),Math.max(...a)]});return r`);
    const world = (pane, x, y, z) => screen(x, y, z, `vp.panes.find(q=>q.kind==='${pane}')`);
    await js(`window.__base=ed.model.verts.length;T.runCommand('tool.pyramid')`);
    await sleep(80);
    const gP0 = (await count()).g;
    await drag(await world('top', -1, 0, -1), await world('top', 1, 0, 1));
    let bb = await bboxOf();
    check('Pyramid outline drawn in Top is flat until depth is drawn', (await count()).g === gP0 + 1 && Math.abs(bb[0][1] - bb[0][0] - 2) < 0.1 && Math.abs(bb[2][1] - bb[2][0] - 2) < 0.1 && bb[1][1] - bb[1][0] < 0.01, JSON.stringify(bb));
    const f0Draw = await world('front', 0.3, 0.1, 0);
    await drag(f0Draw, await world('front', 0.3, 1.1, 0));
    bb = await bboxOf();
    check('Dragging in another view adds depth', Math.abs(bb[1][1] - bb[1][0] - 1) < 0.1, JSON.stringify(bb[1]));
    await click(await world('top', 3, 0, 3), { button: 'right' });
    check('Right click finishes it and keeps the tool', await js(`return !vp.drawingPrim&&ed.tool==='pyramid'`));
    const closedPyr = await js(`const e=new Map();for(const f of ed.model.faces)f.v.forEach((a,i)=>{const b=f.v[(i+1)%f.v.length];const k=a<b?a+'_'+b:b+'_'+a;e.set(k,(e.get(k)||0)+1)});return [...e.values()].every(n=>n===2)&&ed.model.faces.length===5`);
    check('Pyramid is a watertight 5-sided mesh', closedPyr);

    await js(`window.__base=ed.model.verts.length;T.runCommand('tool.sphere');T.runCommand('create.lowPoly')`);
    check('Low Poly reduces segments and is checked', await js(`return ed.primSegments===8&&ed.lowPoly&&T.commands.get('create.lowPoly').checked()`));
    await drag(await world('right', 0, 0, 3), await world('right', 0, 2, 5), { modifiers: ['control'] });
    bb = await bboxOf();
    check('Ctrl makes the outline symmetrical', Math.abs((bb[1][1] - bb[1][0]) - (bb[2][1] - bb[2][0])) < 1e-3, JSON.stringify(bb));
    const vLow = await js(`return ed.model.verts.length-window.__base`);
    await key('Right');
    check('Arrow keys change segments', (await js(`return ed.model.verts.length-window.__base`)) > vLow);
    await key('Enter');
    bb = await bboxOf();
    check('Finishing without depth still makes a solid', bb[0][1] - bb[0][0] > 0.1, JSON.stringify(bb[0]));
    check('Low Poly is flat shaded', await js(`return ed.model.faces.slice(-3).every(f=>f.s===0)`));
    await js(`T.runCommand('create.lowPoly')`);
    check('Turning Low Poly off restores detail', await js(`return ed.primSegments>8&&!ed.lowPoly`));

    const beforeEsc = await count();
    await js(`T.runCommand('tool.box')`);
    await drag(await world('top', 3, 0, -3), await world('top', 5, 0, -1));
    check('Drawing adds a primitive', (await count()).g === beforeEsc.g + 1);
    await key('Escape');
    const afterEsc = await count();
    check('Esc removes the primitive being drawn', afterEsc.g === beforeEsc.g && afterEsc.v === beforeEsc.v, JSON.stringify(afterEsc));
    await js(`if(vp.drawingPrim)vp.dropPrim();T.runCommand('tool.select')`);

    // Draw on a surface: a box whose top faces +Y, so the new shape stands on it.
    await js(`ed.loadModel(T.emptyModel(),null,'Surface');T.runCommand('create.box');vp.panes.forEach(p=>p.frame([0,0,0],2));T.runCommand('create.onSurface');window.__base=ed.model.verts.length;T.runCommand('tool.cone');`);
    await sleep(150);
    const topFaceA = await screen(-0.2, 0.5, 0.2, `vp.panes.find(q=>q.kind==='persp')`);
    const topFaceB = await screen(0.2, 0.5, -0.2, `vp.panes.find(q=>q.kind==='persp')`);
    await drag(topFaceA, topFaceB);
    await key('Enter');
    bb = await bboxOf();
    check('Draw on Surface starts on the face and rises along its normal', Math.abs(bb[1][0] - 0.5) < 0.02 && bb[1][1] > 0.6, JSON.stringify(bb));
    await shot('13d-draw-on-surface');
    await js(`T.runCommand('create.onSurface');T.runCommand('tool.select');`);

    // The menus and tool options share one bar, and nothing is ever clipped.
    const barState = () => js(`const b=document.querySelector('.titlebar').getBoundingClientRect();const kids=[...document.querySelectorAll('.titlebar > *, .optionsbar > *')].filter(k=>k.getBoundingClientRect().width>0);return {h:Math.round(b.height),stageTop:Math.round(vp.el.getBoundingClientRect().top),clipped:kids.filter(k=>{const r=k.getBoundingClientRect();return r.right>b.right+1||r.bottom>b.bottom+1}).map(k=>k.className)}`);
    await js(`T.runCommand('tool.select');`);
    await sleep(120);
    let bar = await barState();
    check('Menus and tool options fit on one bar', bar.h <= 39 && bar.stageTop <= 39 && bar.clipped.length === 0, JSON.stringify(bar));
    await shot('13e-one-bar');
    await js(`T.runCommand('tool.sphere');`);
    await sleep(120);
    bar = await barState();
    check('Sphere options stay on one bar at this width', bar.h <= 39 && bar.clipped.length === 0, JSON.stringify(bar));
    const fullSize = win.getSize();
    win.setMinimumSize(800, 500);
    win.setSize(1000, 700);
    await sleep(350);
    bar = await barState();
    check('A narrow window wraps the bar instead of clipping controls', bar.clipped.length === 0 && bar.h > 39, JSON.stringify(bar));
    await shot('13f-narrow-bar');
    win.setSize(fullSize[0], fullSize[1]);
    await sleep(350);
    const bar2 = await js(`T.runCommand('tool.select');const r=vp.el.getBoundingClientRect();const c=vp.ov;return {cssH:parseInt(c.style.height),h:Math.round(r.height)}`);
    check('Viewports resize to fill the space', Math.abs(bar2.cssH - bar2.h) <= 1, JSON.stringify(bar2));

    // The UV editor, with real mouse and keyboard input.
    await js(`ed.loadModel(T.emptyModel(),null,'UV');T.runCommand('create.box');T.setWorkspace('uv');T.runCommand('select.all');T.runCommand('uv.unwrap');`);
    await sleep(300);
    const uvShot = (name) => shot(name);
    const uvPoint = (fi, c) => js(`const rc=T.uvEditor.el.querySelector('canvas').getBoundingClientRect();const u=ed.model.faces[${fi}].uv[${c}];const [x,y]=T.uvEditor.toScreen(u[0],u[1]);return {x:Math.round(rc.left+x),y:Math.round(rc.top+y)}`);
    const uvFaceMid = (fi) => js(`const rc=T.uvEditor.el.querySelector('canvas').getBoundingClientRect();const f=ed.model.faces[${fi}];const cu=f.uv.reduce((s,u)=>s+u[0],0)/f.uv.length,cv=f.uv.reduce((s,u)=>s+u[1],0)/f.uv.length;const [x,y]=T.uvEditor.toScreen(cu,cv);return {x:Math.round(rc.left+x),y:Math.round(rc.top+y)}`);
    const selCount = () => js(`return T.uvEditor['sel'].size`);
    check('Auto Unwrap handles a closed cube with no seams', await js(`return T.uvEditor['analysis']().islands.length<=6&&T.uvEditor['analysis']().overlap.size===0&&ed.model.faces.every(f=>!f.seam)`));
    check('The editor leads with a one-click Auto Unwrap', await js(`return [...document.querySelectorAll('.uv-bar .btn-primary')].some(b=>b.textContent==='Auto Unwrap')`));

    // A plain click must not make an undo step.
    let depthUV = await js(`return ed.historyDepth`);
    await js(`T.uvEditor.setMode('vertex')`);
    await click(await uvPoint(0, 0));
    const afterUVClick = await js(`return {depth:ed.historyDepth,labels:ed.historyLabels.slice(-2)}`);
    check('Clicking a UV point selects without an undo step', afterUVClick.depth === depthUV && (await selCount()) > 0, JSON.stringify({ depthUV, ...afterUVClick, sel: await selCount() }));

    // Selection modes.
    await js(`T.uvEditor.selectNone();T.uvEditor.setMode('face')`);
    await click(await uvFaceMid(0));
    check('Face mode selects the face under the click', (await selCount()) === 4);
    await js(`T.uvEditor.selectNone();T.uvEditor.setMode('island')`);
    await click(await uvFaceMid(0));
    check('Island mode selects the whole island', (await selCount()) === 4);

    // Handles: scale from the opposite side, and rotate.
    const handleOf = (id) => js(`const rc=T.uvEditor.el.querySelector('canvas').getBoundingClientRect();const l=T.uvEditor['handleLayout']();const p=id==='rot'?l.rot:l.handles.find(h=>h.id===id);return {x:Math.round(rc.left+p.x),y:Math.round(rc.top+p.y)}`.replace(/id===/g, `'${id}'===`).replace("h=>h.'" + id + "'===", 'h=>h.id===').replace("h.id==='" + id + "'===", "h.id==='"));
    const sizeOf = () => js(`const b=T.uvEditor['bbox']();return {w:b.c-b.a,h:b.d-b.b,a:b.a,c:b.c}`);
    const s0 = await sizeOf();
    const east = await js(`const rc=T.uvEditor.el.querySelector('canvas').getBoundingClientRect();const p=T.uvEditor['handleLayout']().handles.find(h=>h.id==='e');return {x:Math.round(rc.left+p.x),y:Math.round(rc.top+p.y)}`);
    await drag(east, { x: east.x + 30, y: east.y });
    const s1 = await sizeOf();
    check('The side handle scales one axis from the opposite side', s1.w > s0.w * 1.05 && Math.abs(s1.h - s0.h) < 1e-6 && Math.abs(s1.a - s0.a) < 1e-6, JSON.stringify([s0, s1]));
    const rotP = await js(`const rc=T.uvEditor.el.querySelector('canvas').getBoundingClientRect();const p=T.uvEditor['handleLayout']().rot;return {x:Math.round(rc.left+p.x),y:Math.round(rc.top+p.y)}`);
    const before3 = await js(`return JSON.stringify(ed.model.faces[0].uv)`);
    await drag(rotP, { x: rotP.x + 40, y: rotP.y + 10 });
    check('The round handle rotates the selection', (await js(`return JSON.stringify(ed.model.faces[0].uv)`)) !== before3);
    await js(`T.runCommand('edit.undo');T.runCommand('edit.undo')`);

    // Keys go to the editor only while the mouse is over it.
    const mid = await uvFaceMid(0);
    send({ type: 'mouseMove', x: mid.x, y: mid.y });
    await sleep(100);
    await key('2');
    check('Number keys pick the UV mode over the editor', (await js(`return T.uvEditor.mode`)) === 'edge' && (await js(`return ed.mode`)) !== 'vertex');
    const packedBefore = await js(`return ed.historyDepth`);
    await key('P');
    check('P packs over the editor instead of playing the animation', (await js(`return ed.historyDepth===${packedBefore}+1&&!ed.playing`)));
    await js(`T.runCommand('edit.undo')`);

    // Seams from UV edges, shown in the viewport, and honoured by the next unwrap.
    await js(`ed.loadModel(T.emptyModel(),null,'Seams');T.runCommand('create.cylinder');T.setWorkspace('uv');T.runCommand('select.all');`);
    await sleep(150);
    const seamRun = await js(`const m=ed.model;const k=(a,b)=>a<b?a+'_'+b:b+'_'+a;const wall=m.faces.filter(f=>f.v.length===4);const top=m.faces.find(f=>f.v.length>4);const seg=wall.length;const seams=[];for(const f of m.faces.filter(f=>f.v.length>4))f.v.forEach((a,i)=>seams.push(k(a,f.v[(i+1)%f.v.length])));seams.push(k(0,seg));ed.begin('s');m.faces.forEach(f=>f.v.forEach((a,i)=>{if(seams.includes(k(a,f.v[(i+1)%f.v.length]))){f.seam=f.seam||f.v.map(()=>false);f.seam[i]=true;}}));ed.commit();ed.emitAll();T.runCommand('uv.unwrap');return T.uvEditor['analysis']().islands.length`);
    check('Seams turn a cylinder into a wall and two caps', seamRun === 3, String(seamRun));
    await sleep(300);
    await js(`T.runCommand('uv.showStretch')`);
    await uvShot('13g-uv-seams-stretch');
    check('A seamed cylinder wall flattens without overlap', await js(`return T.uvEditor['analysis']().overlap.size===0&&Math.max(...T.uvEditor['analysis']().stretch.values())<1.3`), await js(`return Math.max(...T.uvEditor['analysis']().stretch.values()).toFixed(3)`));
    await js(`T.runCommand('uv.showStretch')`);

    // No seams at all on a round shape: one click, then pins and minimize stretch.
    await js(`ed.loadModel(T.emptyModel(),null,'Auto');T.runCommand('create.sphere');T.setWorkspace('uv');T.runCommand('select.all');`);
    await sleep(150);
    const autoBtn = await js(`const b=[...document.querySelectorAll('.uv-bar .btn-primary')].find(x=>x.textContent==='Auto Unwrap');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await click(autoBtn);
    await sleep(300);
    const autoOK = await js(`const a=T.uvEditor['analysis']();return {i:a.islands.length,o:a.overlap.size,w:Math.max(...a.stretch.values()),seams:a.seams.size}`);
    check('One click unwraps a sphere: no seams, no overlaps, low stretch', autoOK.i >= 2 && autoOK.o === 0 && autoOK.w < 2.2 && autoOK.seams === 0, JSON.stringify(autoOK));
    await js(`T.runCommand('uv.showStretch')`);
    await uvShot('13x-auto-unwrap');
    await js(`T.runCommand('uv.showStretch')`);
    const iA = await js(`const a=T.uvEditor['analysis']().islands[0];return a[0]`);
    const iPts = await js(`const f=ed.model.faces[${iA}];return f.uv.map(u=>[...u])`);
    await js(`T.uvEditor.selectNone();T.uvEditor['sel'].add('${iA}:0');T.uvEditor.pin(true);T.uvEditor.selectNone();`);
    check('Pin marks a point', await js(`return ed.model.faces[${iA}].pin?.[0]===true`));
    const before7 = await js(`return JSON.stringify(ed.model.faces[${iA}].uv[0])`);
    await js(`T.runCommand('uv.minimize')`);
    check('Minimize Stretch holds pinned points', (await js(`return JSON.stringify(ed.model.faces[${iA}].uv[0])`)) === before7 && (await js(`return ed.lastOp?.label==='Minimize stretch'`)));
    await js(`T.runCommand('edit.undo')`);
    await js(`T.runCommand('uv.live')`);
    check('Live Unwrap can be switched on', await js(`return T.uvEditor.live`));
    await js(`T.runCommand('uv.live');T.runCommand('uv.sticky')`);
    check('Sticky can be switched off to rip a corner free', await js(`return !T.uvEditor.sticky`));
    await js(`T.runCommand('uv.sticky');T.runCommand('uv.selectOverlaps')`);
    await js(`T.uvEditor.setMode('vertex');T.uvEditor.selectNone();void ${JSON.stringify(iPts.length)};`);

    // Overlap warning, menus, numeric fields and the layout PNG.
    await js(`const f=ed.model.faces;ed.begin('o');const u0=f[0].uv.map(u=>[...u]);f[1].uv.forEach((u,i)=>{if(u0[i]){u[0]=u0[i][0];u[1]=u0[i][1];}});ed.commit();ed.emitAll();`);
    await sleep(120);
    check('Overlapping faces are reported', await js(`return document.querySelector('.uv-warn')?.textContent.includes('overlapping')`));
    await js(`T.runCommand('edit.undo')`);
    const menuBtn = await js(`const b=[...document.querySelectorAll('.uv-menu-btn')].find(x=>x.textContent==='Arrange');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await click(menuBtn);
    check('The Arrange menu opens with its commands', await js(`const m=document.querySelector('.menu');return !!m&&m.textContent.includes('Pack Islands')&&m.textContent.includes('Stitch')`));
    await shot('13h-uv-menu');
    await click({ x: menuBtn.x, y: menuBtn.y + 300 });
    check('Clicking away closes the menu', await js(`return !document.querySelector('.menu')`));
    await js(`T.uvEditor.selectAll()`);
    await sleep(100);
    const widthField = await js(`const i=[...document.querySelectorAll('.uv-fields .num-input')].find(x=>x.getAttribute('aria-label')==='W');i.value='0.5';i.dispatchEvent(new Event('change'));return T.uvEditor['bbox']().c-T.uvEditor['bbox']().a`);
    check('Typing a width resizes the selection', Math.abs(widthField - 0.5) < 1e-6, String(widthField));
    const png = await js(`const b=await T.uvEditor.layoutPNG(256);return [b[0],b[1],b[2],b[3],b.length]`);
    check('The UV layout exports as a PNG', png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47 && png[4] > 200, JSON.stringify(png));

    // Dividers resize the panels, and framing fits a narrow pane.
    const paneW = () => js(`return {uv:Math.round(document.querySelector('.uv-host').getBoundingClientRect().width),stage:Math.round(document.querySelector('.stage-host').getBoundingClientRect().width),dock:Math.round(document.querySelector('.dock').getBoundingClientRect().width),canvas:parseInt(vp.ov.style.width)}`);
    const divAt = (sel) => js(`const r=document.querySelector('${sel}').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    let w0 = await paneW();
    let div = await divAt('.uv-split');
    await drag(div, { x: div.x - 250, y: div.y });
    await sleep(200);
    let w1 = await paneW();
    check('The UV divider resizes the editor and the viewport', w1.uv < w0.uv - 200 && w1.stage > w0.stage + 200 && Math.abs(w1.canvas - w1.stage) <= 1, JSON.stringify([w0, w1]));
    await js(`T.uvEditor.draw()`);
    await shot('13i-uv-resized');
    await drag(div, { x: 5, y: div.y });
    await sleep(200);
    check('The UV divider stops at a usable size', (await paneW()).uv >= 240);
    const reset = await divAt('.uv-split');
    send({ type: 'mouseMove', x: reset.x, y: reset.y });
    await sleep(40);
    send({ type: 'mouseDown', x: reset.x, y: reset.y, button: 'left', clickCount: 2 });
    send({ type: 'mouseUp', x: reset.x, y: reset.y, button: 'left', clickCount: 2 });
    await sleep(250);
    const afterReset = await paneW();
    check('Double-clicking the divider resets it', Math.abs(afterReset.uv - w0.uv) <= 2, JSON.stringify([w0.uv, afterReset.uv]));
    w0 = await paneW();
    div = await divAt('.dock-resize');
    await drag(div, { x: div.x - 80, y: div.y });
    await sleep(200);
    w1 = await paneW();
    check('The side panel divider resizes it', w1.dock > w0.dock + 60 && w1.dock < w0.dock + 100, JSON.stringify([w0.dock, w1.dock]));
    await js(`document.documentElement.style.removeProperty('--dock-w');localStorage.removeItem('thickshake.layout');`);
    await sleep(120);
    const fitNarrow = await js(`const p=vp.panes[1];vp.frameSelected(true);vp.renderNow();const r=[];for(const v of ed.model.verts){const s=p.project(...v.p);r.push(s.x>=p.x&&s.x<=p.x+p.w&&s.y>=p.y&&s.y<=p.y+p.h);}return r.every(Boolean)`);
    check('Framing fits the mesh inside a narrow pane', fitNarrow);
    await js(`T.runCommand('workspace.model');T.runCommand('tool.select');`);

    // Rigging, with real input.
    await js(`ed.loadModel(T.emptyModel(),null,'Rig');T.runCommand('create.cylinder');const ms=ed.model.verts;ms.forEach(v=>{v.p[1]*=2;v.p[1]+=1;});ed.emitAll();T.setWorkspace('rig');T.runCommand('rig.humanoid');vp.frameSelected(true);`);
    await sleep(300);
    check('The humanoid adds 24 named joints', await js(`return ed.model.bones.length===24&&ed.model.bones.some(b=>b.name==='UpperArm.R')`));
    check('The panel warns about unweighted vertices', await js(`return [...document.querySelectorAll('.verdict.bad')].some(x=>x.textContent.includes('no weight'))`));
    await js(`T.runCommand('rig.autoWeightsAll')`);
    await sleep(300);
    check('Auto-weight covers every vertex with heat weights', await js(`return ed.model.verts.every(v=>v.w&&v.w.length&&Math.abs(v.w.reduce((s,x)=>s+x[1],0)-1)<1e-6)&&ed.lastOp?.label==='Auto-weight'`));
    const depthPose = await js(`return ed.historyDepth`);
    await js(`T.runCommand('rig.testPose');const b=ed.model.bones.find(x=>x.name==='Spine');ed.activeBone=b.id;ed.selBones=new Set([b.id]);ed.emit('selection','skeleton');`);
    await sleep(200);
    check('Test Pose needs no clip and shows the rotate gizmo', await js(`return ed.testPose&&ed.tool==='rotate'&&ed.model.clips.length===0&&!!vp.gizmoCenter()`));
    const restTop = await js(`const P=ed.displayPositions();let hi=0;for(let i=1;i<P.length;i+=3)hi=Math.max(hi,P[i]);return JSON.stringify([...P])`);
    const ringPt = await js(`const c=vp.gizmoCenter();const p=vp.active;const s=p.project(c.x,c.y,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left+80*1.18),y:Math.round(s.y+r.top)}`);
    await drag(ringPt, { x: ringPt.x, y: ringPt.y + 45 });
    await sleep(200);
    check('Rotating a joint in Test Pose bends the mesh', (await js(`return JSON.stringify([...ed.displayPositions()])`)) !== restTop);
    check('Test Pose leaves no undo steps or clips', (await js(`return ed.historyDepth`)) === depthPose && (await js(`return ed.model.clips.length`)) === 0);
    await shot('13k-rig-test-pose');
    await js(`T.runCommand('rig.resetPose')`);
    await sleep(100);
    check('Reset returns the mesh to rest', (await js(`return JSON.stringify([...ed.displayPositions()])`)) === restTop);
    await js(`T.runCommand('rig.testPose')`);
    check('Stopping leaves the test pose off', await js(`return !ed.testPose&&!ed.poseActive&&ed.tool==='select'`));

    // Weight brush: a smooth stroke, and the brush stays on the facing surface.
    const paintTarget = await js(`const b=ed.model.bones.find(x=>x.name==='Chest');ed.activeBone=b.id;ed.brush.radius=70;ed.brush.strength=1;ed.brush.mode='add';ed.brush.through=false;T.runCommand('tool.paint');const p=vp.active;const eye=p.camera.position;let near=0,nd=Infinity;ed.model.verts.forEach((v,i)=>{const d=Math.hypot(v.p[0]-eye.x,v.p[1]-eye.y,v.p[2]-eye.z);if(d<nd){nd=d;near=i;}});const q=ed.model.verts[near].p;const s=p.project(q[0],q[1],q[2]);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top),bone:b.id}`);
    await sleep(120);
    const backBefore = await js(`const eye=vp.active.camera.position;const P=ed.model.verts;let far=-1,fd=-1;P.forEach((v,i)=>{const d=Math.hypot(v.p[0]-eye.x,v.p[1]-eye.y,v.p[2]-eye.z);if(d>fd&&Math.abs(v.p[1]-2)<1.1){fd=d;far=i;}});return {i:far,w:(P[far].w||[]).find(x=>x[0]===${paintTarget.bone})?.[1]??0}`);
    await click(paintTarget);
    await sleep(120);
    const painted = await js(`return ed.model.verts.filter(v=>(v.w||[]).some(x=>x[0]===${paintTarget.bone}&&x[1]>0.5)).length`);
    check('The weight brush paints the surface under it', painted > 0, String(painted));
    const backAfter = await js(`return (ed.model.verts[${backBefore.i}].w||[]).find(x=>x[0]===${paintTarget.bone})?.[1]??0`);
    check('The brush leaves the far side of the mesh alone', Math.abs(backAfter - backBefore.w) < 1e-9, `${backBefore.w} -> ${backAfter}`);
    const radius0 = await js(`return ed.brush.radius`);
    send({ type: 'mouseMove', x: paintTarget.x, y: paintTarget.y });
    await sleep(60);
    await key(']');
    check('] enlarges the brush', (await js(`return ed.brush.radius`)) > radius0);
    await js(`T.runCommand('tool.select')`);

    // The panel's exact numbers, deleting a joint, and mirroring from a bare chain.
    await js(`T.runCommand('workspace.rig');ed.setMode('vertex');ed.selVerts=new Set([0]);ed.emit('selection')`);
    await sleep(300);
    check('Selecting a vertex shows its exact weights', await js(`return [...document.querySelectorAll('.panel-section h3')].some(x=>x.textContent==='Vertex weights')`));
    const beforeDelete = await js(`const chest=ed.model.bones.find(x=>x.name==='Chest');ed.setMode('bone');ed.selBones=new Set([chest.id]);ed.activeBone=chest.id;T.runCommand('edit.delete');return ed.model.verts.every(v=>v.w&&v.w.length)&&!ed.model.bones.some(b=>b.name==='Chest')&&ed.model.bones.find(b=>b.name==='Neck').parent===ed.model.bones.find(b=>b.name==='Spine').id`);
    check('Deleting a joint keeps all weights and reconnects its children', beforeDelete);
    await js(`T.runCommand('edit.undo')`);
    const mirrored = await js(`ed.loadModel(T.emptyModel(),null,'Mirror');ed.transact('b',m=>{m.bones.push({id:900,name:'Root',parent:null,head:[0,1,0]},{id:901,name:'Arm',parent:900,head:[0.5,1,0]});m.nextId=950;});ed.setMode('bone');ed.selBones.clear();T.runCommand('rig.mirrorJoints');return ed.model.bones.map(b=>b.name).sort().join()`);
    check('Mirror Joints names both sides', mirrored === 'Arm.L,Arm.R,Root', mirrored);
    await js(`ed.loadModel(T.emptyModel(),null,'After rig');T.runCommand('create.box');T.runCommand('workspace.model');T.runCommand('tool.select');`);
    check('Nothing is drawn near-black between panels', await js(`return getComputedStyle(document.querySelector('.dock-resize')).backgroundColor===getComputedStyle(document.querySelector('.dock')).backgroundColor`));

    // Animation, with real input.
    await js(`ed.loadModel(T.emptyModel(),null,'Anim');T.runCommand('create.cylinder');ed.model.verts.forEach(v=>{v.p[1]=(v.p[1]+0.5)*2;});ed.emitAll();T.setWorkspace('rig');T.runCommand('rig.humanoid');T.runCommand('rig.autoWeightsAll');T.setWorkspace('animate');T.runCommand('anim.newClip');vp.frameSelected(true);`);
    await sleep(300);
    const bone = (name) => js(`return ed.model.bones.find(b=>b.name===${JSON.stringify(name)}).id`);
    const armId = await bone('UpperArm.L'), handId = await bone('Hand.L');
    const seedKeys = `const c=ed.clip();const s=(id,f,a)=>{const t=c.tracks[id]||(c.tracks[id]={rot:[],pos:[]});t.rot.push({f,v:[0,0,Math.sin(a/2),Math.cos(a/2)]});t.rot.sort((x,y)=>x.f-y.f);};`;
    await js(`${seedKeys}ed.begin('seed');s(${armId},0,0);s(${armId},20,0.6);s(${armId},40,0);s(${handId},20,0.3);ed.selBones=new Set([${armId}]);ed.activeBone=${armId};ed.commit();ed.emitAll();T.timeline.frameAll();`);
    await sleep(250);
    const keyPt = (id, f) => js(`const t=T.timeline;const rows=t.rows();const i=rows.findIndex(r=>r.id===${id});const rc=t.el.querySelector('canvas').getBoundingClientRect();return {x:Math.round(rc.left+t.xOf(${f})),y:Math.round(rc.top+22+(i+1)*20+10-t.scroll)}`);
    const trackFrames = (id) => js(`return ed.clip().tracks[${id}].rot.map(k=>k.f)`);

    let kp = await keyPt(armId, 20);
    await click(kp);
    check('Clicking a key selects it and moves the playhead', (await js(`return T.timeline.selectionSize===1&&ed.frame===20`)));
    kp = await keyPt(armId, 20);
    const pxFrame = await js(`return T.timeline.ppf`);
    await drag(kp, { x: kp.x + Math.round(pxFrame * 5), y: kp.y });
    check('Dragging a key retimes it', (await trackFrames(armId)).join() === '0,25,40', (await trackFrames(armId)).join());
    check('The moved key stays selected', await js(`return T.timeline.targets().some(r=>r.f===25)`));
    await js(`T.runCommand('edit.undo')`);
    await sleep(100);

    // Box-select, stretch, delete, copy and paste.
    const a0 = await keyPt(armId, 0), a40 = await keyPt(armId, 40);
    await drag({ x: a0.x - 8, y: a0.y - 8 }, { x: a40.x + 12, y: a0.y + 8 });
    check('Dragging a box selects keys', (await js(`return T.timeline.selectionSize`)) === 3, String(await js(`return T.timeline.selectionSize`)));
    const stretchEnd = await keyPt(armId, 40);
    await drag({ x: stretchEnd.x, y: stretchEnd.y + 60 }, { x: stretchEnd.x - Math.round(pxFrame * 20), y: stretchEnd.y + 60 });
    check('Dragging the end of a selection stretches its timing', (await trackFrames(armId)).join() === '0,10,20', (await trackFrames(armId)).join());
    await js(`T.runCommand('edit.undo');T.timeline.clearSelection()`);
    await sleep(120);
    kp = await keyPt(armId, 20);
    await click(kp);
    send({ type: 'mouseMove', x: kp.x, y: kp.y });
    await sleep(80);
    await js(`T.runCommand('anim.copyKeys');ed.frame=30;ed.emit('time');T.runCommand('anim.pasteKeys')`);
    check('Copied keys paste at the playhead', (await trackFrames(armId)).join() === '0,20,30,40', (await trackFrames(armId)).join());
    kp = await keyPt(armId, 30);
    await click(kp);
    await key('Delete');
    check('Delete removes the selected key while over the timeline', (await trackFrames(armId)).join() === '0,20,40', (await trackFrames(armId)).join());

    // Zoom, scrub and keys.
    const ppf0 = await js(`return T.timeline.ppf`);
    const tlC = await js(`const r=T.timeline.el.querySelector('canvas').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+60)}`);
    send({ type: 'mouseMove', x: tlC.x, y: tlC.y });
    await sleep(40);
    send({ type: 'mouseWheel', x: tlC.x, y: tlC.y, deltaX: 0, deltaY: 120, wheelTicksY: -1, canScroll: true, modifiers: ['control'] });
    await sleep(100);
    send({ type: 'mouseWheel', x: tlC.x, y: tlC.y, deltaX: 0, deltaY: 120, wheelTicksY: -1, canScroll: true, modifiers: ['control'] });
    await sleep(100);
    check('Ctrl+wheel zooms the timeline', (await js(`return T.timeline.ppf`)) !== ppf0);
    await key('A');
    check('A fits the clip again', Math.abs((await js(`return T.timeline.ppf`)) - ppf0) < 1e-6);
    const ruler = await js(`const t=T.timeline;const r=t.el.querySelector('canvas').getBoundingClientRect();return {x:Math.round(r.left+t.xOf(12)),y:Math.round(r.top+10)}`);
    await drag(ruler, { x: ruler.x, y: ruler.y });
    check('Clicking the ruler scrubs', (await js(`return ed.frame`)) === 12);

    // Curves.
    await js(`T.timeline.clearSelection();T.timeline.selectRefs([{bone:${armId},f:0}]);T.runCommand('anim.ease.smooth')`);
    const smoothC = await js(`return ed.clip().tracks[${armId}].rot[0].c`);
    check('The Curve menu sets a key\'s timing', Array.isArray(smoothC) && smoothC[0] === 0.42);
    const barMenu = await js(`const b=[...document.querySelectorAll('.tl-bar .uv-menu-btn')].find(x=>x.textContent==='Curve');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await click(barMenu);
    check('The Curve menu opens inside the window', await js(`const m=document.querySelector('.menu');if(!m)return false;const r=m.getBoundingClientRect();return m.textContent.includes('Overshoot')&&r.top>=0&&r.bottom<=innerHeight`));
    await shot('13l-curve-menu');
    await click({ x: 500, y: 300 });
    await js(`if(ed.tool!=='rotate')T.runCommand('tool.rotate')`);
    await js(`ed.activeBone=${armId};ed.selBones=new Set([${armId}]);ed.mode='bone';ed.emit('selection','skeleton');T.timeline.setView('graph')`);
    await sleep(200);
    const gPt = (ch, f) => js(`const t=T.timeline;const c=ed.clip();const tr=c.tracks[${armId}];const CH={label:0};const rc=t.el.querySelector('canvas').getBoundingClientRect();t.draw();const H=rc.height;const step=t.sampleStep(c);const chan={id:'rz',label:'Rotate Z',list:'rot',i:2,color:''};const s=t.series(tr,chan,c,step);const v=t.keyValue(tr,chan,c,${f},step,s.values);return {x:Math.round(rc.left+t.xOf(${f})),y:Math.round(rc.top+t.yOf(v,H)),v}`);
    let gp = await gPt('rz', 20);
    const zBefore = await js(`const q=ed.clip().tracks[${armId}].rot[1].v;return 2*Math.atan2(q[2],q[3])*180/Math.PI`);
    await drag(gp, { x: gp.x, y: gp.y + 25 });
    const zAfter = await js(`const q=ed.clip().tracks[${armId}].rot[1].v;return 2*Math.atan2(q[2],q[3])*180/Math.PI`);
    check('Dragging a curve key changes its value', zAfter < zBefore - 0.5, `${zBefore.toFixed(1)} -> ${zAfter.toFixed(1)}`);
    await shot('13m-graph-editor');
    const depthH = await js(`return ed.historyDepth`);
    const handle = await js(`const t=T.timeline;const c=ed.clip();const tr=c.tracks[${armId}];const rc=t.el.querySelector('canvas').getBoundingClientRect();const hp=t.handlePositions(tr,t.gSel.ch,c,t.gSel.f,rc.height);return {x:Math.round(rc.left+hp.h0.x),y:Math.round(rc.top+hp.h0.y)}`);
    const seg0 = await js(`return JSON.stringify(ed.clip().tracks[${armId}].rot[1].c||null)`);
    await drag(handle, { x: handle.x + 20, y: handle.y - 15 });
    check('Dragging a curve handle reshapes the timing as one undo step', (await js(`return JSON.stringify(ed.clip().tracks[${armId}].rot[1].c||null)`)) !== seg0 && (await js(`return ed.historyDepth`)) === depthH + 1);
    await js(`T.timeline.setView('dope')`);

    // IK: pull a hand with the real mouse.
    await js(`T.runCommand('tool.ik');ed.frame=20;ed.emit('time');vp.invalidate();`);
    await sleep(200);
    const handAt = await js(`const b=ed.bonePose().get(${handId}).pos;const s=vp.active.project(b[0],b[1],b[2]);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top),w:[...b]}`);
    const depthIK = await js(`return ed.historyDepth`);
    await drag(handAt, { x: handAt.x - 20, y: handAt.y - 40 });
    await sleep(150);
    const handAfter = await js(`const b=ed.bonePose().get(${handId}).pos;const s=vp.active.project(b[0],b[1],b[2]);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    check('IK Drag brings a hand to the cursor', Math.hypot(handAfter.x - (handAt.x - 20), handAfter.y - (handAt.y - 40)) < 6, JSON.stringify([handAt, handAfter]));
    check('IK writes keys up the chain as one undo step', await js(`const c=ed.clip();const lo=ed.model.bones.find(b=>b.name==='LowerArm.L').id;return c.tracks[lo]?.rot.some(k=>k.f===20)&&ed.historyDepth===${depthIK}+1`));
    await shot('13n-ik-trail');
    await sleep(120);
    const bars = await js(`return {top:Math.round(document.querySelector('.titlebar').getBoundingClientRect().height),tl:Math.round(document.querySelector('.tl-bar').getBoundingClientRect().height)}`);
    check('At this width the IK options and timeline controls each fit on one row', bars.top <= 39 && bars.tl <= 36, JSON.stringify(bars));

    // Overlays and pause behaviour.
    const pixelsOf = () => js(`const c=vp.ov;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i])n++;return n`);
    await js(`ed.trail=false;vp.invalidate()`);
    await sleep(120);
    const noTrail = await pixelsOf();
    await js(`ed.trail=true;vp.invalidate()`);
    await sleep(120);
    const withTrail = await pixelsOf();
    check('The motion trail draws', withTrail > noTrail, `${noTrail} -> ${withTrail}`);
    await js(`T.runCommand('anim.onion');vp.invalidate()`);
    await sleep(150);
    const withOnion = await pixelsOf();
    check('Onion skin draws ghost frames', withOnion > withTrail + 50, `${withTrail} -> ${withOnion}`);
    await shot('13o-onion');
    await js(`T.runCommand('anim.onion')`);
    await js(`ed.frame=3;T.runCommand('anim.play')`);
    await sleep(220);
    await js(`T.runCommand('anim.play')`);
    check('Pausing stops on a whole frame', await js(`return Number.isInteger(ed.frame)&&!ed.playing`));

    // Pose tools and clip tools.
    await js(`T.runCommand('tool.rotate');ed.selBones.clear();ed.frame=20;ed.emit('time');T.runCommand('anim.copyPose');ed.frame=35;ed.emit('time');T.runCommand('anim.pasteMirrored')`);
    const mirroredOK = await js(`const R=ed.model.bones.find(b=>b.name==='UpperArm.R').id;const c=ed.clip();const L=${armId};const l=c.tracks[L].rot.find(k=>k.f===20).v,r=c.tracks[R].rot.find(k=>k.f===35).v;return Math.abs(l[2]+r[2])<1e-6&&Math.abs(l[3]-r[3])<1e-6`);
    check('Paste Mirrored sends the left arm\'s pose to the right', mirroredOK);
    await js(`T.runCommand('anim.makeLoop')`);
    check('Make Loop closes the clip', await js(`const c=ed.clip();const t=c.tracks[${armId}].rot;return c.loop&&t[t.length-1].f===c.length`));
    const lenBefore = await js(`return ed.clip().length`);
    await js(`T.runCommand('anim.retime')`);
    await js(`ed.adjustLastOp('percent',50)`);
    check('Change Speed adjusts live from its panel', (await js(`return ed.clip().length`)) === Math.round(lenBefore / 2));
    await js(`T.runCommand('edit.undo')`);
    check('Undo restores the clip\'s speed', (await js(`return ed.clip().length`)) === lenBefore);
    const glb = await js(`T.runCommand('anim.ease.overshoot');const g=T.exportGLB(ed.model,T.defaultExport);return g.length`);
    check('An eased clip still exports', glb > 1000, String(glb));
    await js(`ed.loadModel(T.emptyModel(),null,'After anim');T.runCommand('create.box');T.runCommand('workspace.model');T.runCommand('tool.select');`);

    // Blockout: rough out a simple character with real input.
    await js(`ed.loadModel(T.emptyModel(),null,'Block');ed.mirrorX=false;ed.snap=false;T.runCommand('workspace.block');vp.panes.forEach(p=>p.frame([0,1,0],3));vp.linked=false;`);
    await sleep(300);
    check('Blockout starts ready for a character: Limb tool, symmetry on', await js(`return ed.tool==='limb'&&ed.mirrorX`));
    check('The panel leads with bodies and has no level shapes', await js(`const p=document.querySelector('.dock').textContent;return ['Start from','Character','Chibi','Creature','Limb'].every(x=>p.includes(x))&&!/Stairs|Doorway/.test(document.querySelector('.shape-grid').textContent)`));

    // Draw a limb from shoulder to elbow: it runs along the drag, and symmetry adds the other arm.
    const limbA = await world('front', 0.4, 1.5, 0), limbB = await world('front', 1.1, 1.1, 0);
    await drag(limbA, limbB);
    await key('Enter');
    const limbOK = await js(`const L=ed.model.groups.find(g=>g.name==='Limb.L');const R=ed.model.groups.find(g=>g.name==='Limb.R');if(!L||!R)return 'names:'+ed.model.groups.map(g=>g.name);const P=id=>ed.model.faces.filter(f=>f.g===id).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);const xs=P(L.id).map(p=>p[0]),ys=P(L.id).map(p=>p[1]);return [Math.min(...xs),Math.max(...xs),Math.min(...ys),Math.max(...ys),Math.min(...P(R.id).map(p=>p[0]))]`);
    check('Limb runs along the drag and gets its other side', Array.isArray(limbOK) && limbOK[0] > 0.2 && limbOK[1] < 1.3 && limbOK[3] < 1.75 && limbOK[2] > 0.85 && limbOK[4] < -1, JSON.stringify(limbOK));
    await shot('13r-limb');

    // Draw out character parts, a freehand tube, a silhouette, and sculpt them.
    const pieceBox = (name) => js(`const g=ed.model.groups.find(x=>x.name===${JSON.stringify(name)});if(!g)return null;const P=ed.model.faces.filter(f=>f.g===g.id).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);const r=[0,1,2].map(i=>[Math.min(...P.map(p=>p[i])),Math.max(...P.map(p=>p[i]))]);return {r,faces:ed.model.faces.filter(f=>f.g===g.id).length,s:ed.model.faces.find(f=>f.g===g.id).s}`);
    const partBtn = (label) => js(`const b=[...document.querySelectorAll('.shape-btn')].find(x=>x.textContent===${JSON.stringify(label)});const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await js(`ed.loadModel(T.emptyModel(),null,'Parts');T.runCommand('workspace.block');vp.panes.forEach(p=>p.frame([0,1,0],3));`);
    await sleep(250);
    await js(`document.querySelector('.dock-body, .dock')?.scrollTo?.(0,0)`);
    await click(await partBtn('Head'));
    check('Picking Head readies the part tool', await js(`return ed.tool==='part'&&ed.partKind==='head'`));
    await drag(await world('front', 0, 1.3, 0), await world('front', 0, 2, 0));
    await key('Enter');
    let hb = await pieceBox('Head');
    check('Dragging chin to crown draws a head that long, wider than a limb', hb && Math.abs(hb.r[1][0] - 1.3) < 0.08 && Math.abs(hb.r[1][1] - 2) < 0.08 && hb.r[0][1] - hb.r[0][0] > 0.35, JSON.stringify(hb));
    await click(await partBtn('Arm'));
    await drag(await world('front', 0.5, 1.2, 0), await world('front', 1.3, 0.9, 0));
    await key('Enter');
    const armNames2 = await js(`return ed.model.groups.map(g=>g.name).join()`);
    check('A part off the centre line gets its other side', armNames2.includes('Arm.L') && armNames2.includes('Arm.R') && armNames2.includes('Head') && !armNames2.includes('Head.'), armNames2);

    // Double-click finishes what's being drawn, without changing it.
    await js(`T.runCommand('tool.box')`);
    await sleep(80);
    const dblA = await world('front', -2, 0.2, 0), dblB = await world('front', -1.4, 0.8, 0);
    await drag(dblA, dblB);
    check('A drawn shape waits to be finished', await js(`return vp.drawingPrim`));
    const dblAt = await world('top', 4, 0, 3);
    const groupsDbl = (await count()).g;
    const vertsDbl = await js(`return ed.model.verts.length`);
    send({ type: 'mouseMove', x: dblAt.x, y: dblAt.y });
    await sleep(30);
    await js(`vp.ov.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:${dblAt.x},clientY:${dblAt.y}}))`);
    check('Double-click finishes the shape', await js(`return !vp.drawingPrim&&ed.tool==='box'`));
    check('Finishing keeps the piece as drawn', (await count()).g >= groupsDbl && (await js(`return ed.model.verts.length`)) >= vertsDbl);

    // Low poly really uses fewer faces and flat shading.
    const smoothFaces = (await pieceBox('Arm.L')).faces;
    await js(`T.runCommand('block.detail.low');T.runCommand('part.leg')`);
    await drag(await world('front', 0.6, 0.7, 0), await world('front', 0.6, 0.1, 0));
    await key('Enter');
    const lowLeg = await pieceBox('Leg.L');
    check('Low Poly detail draws chunky, flat-shaded parts', lowLeg && lowLeg.faces < smoothFaces && lowLeg.s === 0, JSON.stringify([smoothFaces, lowLeg]));
    await js(`T.runCommand('block.detail.medium')`);
    check('Medium detail returns to smooth pieces', await js(`return !ed.lowPoly&&ed.primSegments===12`));

    // Tube: draw a curving line.
    await js(`T.runCommand('tool.stroke');ed.strokeRadius=0.08;`);
    await sleep(100);
    const tubeA = await world('front', -1.8, 2.1, 0), tubeB = await world('front', -1.2, 1.1, 0);
    const midC = { x: Math.round((tubeA.x + tubeB.x) / 2) + 35, y: Math.round((tubeA.y + tubeB.y) / 2) };
    send({ type: 'mouseMove', x: tubeA.x, y: tubeA.y });
    await sleep(30);
    send({ type: 'mouseDown', x: tubeA.x, y: tubeA.y, button: 'left', clickCount: 1 });
    await sleep(30);
    for (let i = 1; i <= 10; i++) {
      const t = i / 10, q = (1 - t) * (1 - t), r = 2 * t * (1 - t), s = t * t;
      send({ type: 'mouseMove', x: Math.round(tubeA.x * q + midC.x * r + tubeB.x * s), y: Math.round(tubeA.y * q + midC.y * r + tubeB.y * s), button: 'left' });
      await sleep(25);
    }
    await shot('13t-tube-preview');
    send({ type: 'mouseUp', x: tubeB.x, y: tubeB.y, button: 'left', clickCount: 1 });
    await sleep(150);
    const tb = await pieceBox('Tube.R');
    check('Drawing a line makes a tube along it, and its other side', tb && tb.r[0][0] < -1.6 && tb.r[1][1] > 1.9 && !!(await pieceBox('Tube.L')), JSON.stringify(tb));

    // Draw Shape: inflate an outline.
    await js(`T.runCommand('tool.blob');ed.mirrorX=false;`);
    await sleep(100);
    const bc = await world('front', 0, 0.3, 0);
    send({ type: 'mouseMove', x: bc.x + 40, y: bc.y });
    await sleep(30);
    send({ type: 'mouseDown', x: bc.x + 40, y: bc.y, button: 'left', clickCount: 1 });
    await sleep(30);
    for (let i = 1; i <= 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      send({ type: 'mouseMove', x: Math.round(bc.x + Math.cos(a) * 40), y: Math.round(bc.y + Math.sin(a) * 20), button: 'left' });
      await sleep(15);
    }
    send({ type: 'mouseUp', x: bc.x + 40, y: bc.y, button: 'left', clickCount: 1 });
    await sleep(150);
    const sb = await pieceBox('Shape');
    check('Drawing around an outline inflates a solid of that size', sb && sb.r[0][1] - sb.r[0][0] > 0.2 && sb.r[2][1] - sb.r[2][0] > 0.05 && sb.r[1][1] - sb.r[1][0] < sb.r[0][1] - sb.r[0][0], JSON.stringify(sb));
    check('The drawn shape waits to be shaped with its rings, all in quads', await js(`return vp.pen.active&&ed.lastOp?.label==='Draw shape'&&ed.model.faces.filter(f=>f.g===ed.activeGroup).every(f=>f.v.length===4)`));
    await js(`vp.pen.finish()`);
    check('Finishing keeps the shape', await js(`return !vp.pen.active&&!!ed.model.groups.find(g=>g.name.startsWith('Shape'))`));
    await shot('13u-organic-pieces');

    // Sculpt: grab, inflate and smooth with the real mouse, all as single undo steps.
    await js(`ed.mirrorX=true;ed.sculpt.radius=45;T.runCommand('sculpt.grab');vp.active=vp.panes.find(q=>q.kind==='persp');`);
    await sleep(120);
    const headTop = await world('front', 0, 1.65, 0);
    const vertsJSON = () => js(`return JSON.stringify(ed.model.verts.map(v=>v.p))`);
    const d0 = await js(`return ed.historyDepth`);
    const before0 = await vertsJSON();
    await drag(headTop, { x: headTop.x + 25, y: headTop.y - 10 });
    check('Grab pulls the surface as one undo step', (await vertsJSON()) !== before0 && (await js(`return ed.historyDepth`)) === d0 + 1);
    const before1 = await vertsJSON();
    await js(`T.runCommand('sculpt.inflate')`);
    await drag(headTop, { x: headTop.x + 5, y: headTop.y });
    check('Inflate swells the surface', (await vertsJSON()) !== before1);
    const before2 = await vertsJSON();
    await js(`T.runCommand('sculpt.smooth')`);
    await drag(headTop, { x: headTop.x + 5, y: headTop.y });
    check('Smooth evens it out', (await vertsJSON()) !== before2);
    await js(`T.runCommand('edit.undo');T.runCommand('edit.undo');T.runCommand('edit.undo')`);
    check('Undo restores the sculpted surface', (await vertsJSON()) === before0);
    const brushR = await js(`return ed.sculpt.radius`);
    send({ type: 'mouseMove', x: headTop.x, y: headTop.y });
    await sleep(50);
    await key(']');
    check('] enlarges the sculpt brush', (await js(`return ed.sculpt.radius`)) > brushR);

    // Round off and lower poly on a whole piece.
    await js(`T.runCommand('tool.select');const g=ed.model.groups.find(x=>x.name==='Shape').id;ed.setMode('group');ed.clearSelection();ed.model.faces.forEach((f,i)=>{if(f.g===g)ed.selFaces.add(i)});ed.activeGroup=g;ed.emit('selection','groups');`);
    const fBefore = (await pieceBox('Shape')).faces;
    await js(`T.runCommand('block.round')`);
    const fRound = (await pieceBox('Shape')).faces;
    check('Round Off adds faces to a piece', fRound > fBefore, `${fBefore} -> ${fRound}`);
    // Counted in triangles: rounding makes quads, and simplifying makes triangles.
    const shapeTris = () => js(`const g=ed.model.groups.find(x=>x.name==='Shape').id;return ed.model.faces.filter(f=>f.g===g).reduce((s,f)=>s+f.v.length-2,0)`);
    const trisRound = await shapeTris();
    await js(`T.runCommand('block.reduce')`);
    const trisLow = await shapeTris();
    check('Lower Poly removes triangles from a piece', trisLow < trisRound * 0.7, `${trisRound} -> ${trisLow}`);
    await js(`const g=ed.model.groups.find(x=>x.name==='Shape').id;ed.clearSelection();ed.model.faces.forEach((f,i)=>{if(f.g===g)ed.selFaces.add(i)});ed.emit('selection');T.runCommand('tool.part');ed.tool='select';ed.emit('tool');`);
    await sleep(150);
    await shot('13v-blockout-panel');
    const panelFits = await js(`const d=document.querySelector('.dock');return d.scrollWidth<=d.clientWidth+1`);
    check('The longer panel doesn\'t overflow sideways', panelFits);

    // The newer tools, with real input where the tool takes any.
    await js(`ed.loadModel(T.emptyModel(),null,'More');T.runCommand('workspace.block');ed.mirrorX=false;vp.panes.forEach(p=>p.frame([0,1,0],3));T.runCommand('tool.lathe');`);
    await sleep(200);
    const lathePts = [];
    for (let i = 0; i <= 12; i++) lathePts.push(await world('front', 0.5 + Math.sin((i / 12) * Math.PI) * 0.35, 2 - (i / 12) * 1.6, 0));
    send({ type: 'mouseMove', x: lathePts[0].x, y: lathePts[0].y });
    await sleep(30);
    send({ type: 'mouseDown', x: lathePts[0].x, y: lathePts[0].y, button: 'left', clickCount: 1 });
    await sleep(30);
    for (const q of lathePts.slice(1)) { send({ type: 'mouseMove', x: q.x, y: q.y, button: 'left' }); await sleep(15); }
    send({ type: 'mouseUp', x: lathePts[12].x, y: lathePts[12].y, button: 'left', clickCount: 1 });
    await sleep(150);
    const lb = await pieceBox('Lathe');
    check('Lathe spins a drawn outline into a solid around the axis', lb && lb.r[1][1] > 1.8 && lb.r[1][0] < 0.5 && lb.r[2][1] - lb.r[2][0] > 0.5 && lb.r[0][1] > 0.3, JSON.stringify(lb));

    // Taper, bend and twist adjust live from the panel above the view.
    const selectNamed = (names) => js(`ed.setMode('group');ed.clearSelection();const ids=ed.model.groups.filter(g=>${JSON.stringify(names)}.includes(g.name)).map(g=>g.id);ed.model.faces.forEach((f,i)=>{if(ids.includes(f.g))ed.selFaces.add(i)});ed.activeGroup=ids[0];ed.emit('selection','groups');T.runCommand('tool.select');`);
    await selectNamed(['Lathe']);
    const lv0 = await vertsJSON();
    await js(`T.runCommand('block.taper')`);
    check('Taper reshapes a piece', (await vertsJSON()) !== lv0);
    const taper1 = await js(`return JSON.stringify(ed.model.verts.map(v=>v.p))`);
    await js(`ed.adjustLastOp('amount',-0.5)`);
    check('Its amount adjusts live', (await vertsJSON()) !== taper1);
    await js(`T.runCommand('edit.undo');T.runCommand('block.bend')`);
    check('Bend reshapes a piece', (await vertsJSON()) !== lv0);
    await js(`T.runCommand('edit.undo');T.runCommand('block.twist')`);
    check('Twist keeps working after undo', (await vertsJSON()) !== lv0);
    await js(`T.runCommand('edit.undo')`);
    check('Undo restores the piece', (await vertsJSON()) === lv0);

    // Fuse two overlapping pieces.
    await js(`ed.transact('a',m=>{});T.runCommand('create.sphere');`);
    const fuseIds = await js(`const n=ed.model.groups.map(g=>g.name);return n`);
    await selectNamed(fuseIds);
    const gBeforeFuse = (await count()).g;
    await js(`T.runCommand('block.fuse')`);
    const fused = await count();
    check('Fuse melts the selected pieces into one', gBeforeFuse >= 2 && fused.g === 1 && fused.f > 50, JSON.stringify([gBeforeFuse, fused]));
    check('The Fuse settings float over the view, keeping the top bar on one row', await js(`const b=document.querySelector('.titlebar').getBoundingClientRect();const l=document.querySelector('.lastop');return b.height<=39&&!!l&&l.closest('.stage-host')!==null&&l.textContent.includes('Detail')`));
    check('Fuse leaves a closed surface', await js(`const c=new Map();for(const f of ed.model.faces)f.v.forEach((a,i)=>{const b=f.v[(i+1)%f.v.length];const k=a<b?a+'_'+b:b+'_'+a;c.set(k,(c.get(k)||0)+1)});return [...c.values()].every(n=>n===2)`));
    await shot('13w-fused');
    const fineF = (await count()).f;
    await js(`ed.adjustLastOp('detail',16)`);
    check('A lower Detail makes the fused mesh low poly', (await count()).f < fineF / 2, `${fineF} -> ${(await count()).f}`);
    const fg = await js(`return ed.model.groups.length`);
    await js(`T.runCommand('edit.undo')`);
    check('Undo brings the separate pieces back', (await count()).g === gBeforeFuse && fg === 1);

    // Radial, centre, isolate.
    await js(`T.runCommand('edit.undo')`);
    await js(`T.runCommand('create.box')`);
    const boxName = await js(`return ed.model.groups[ed.model.groups.length-1].name`);
    await js(`const g=ed.model.groups[ed.model.groups.length-1].id;ed.transact('move',m=>{const seen=new Set();for(const f of m.faces)if(f.g===g)for(const v of f.v)if(!seen.has(v)){seen.add(v);m.verts[v].p=[m.verts[v].p[0]+2,m.verts[v].p[1],m.verts[v].p[2]];}});`);
    await selectNamed([boxName]);
    const gR = (await count()).g;
    await js(`T.runCommand('block.radial')`);
    check('Radial repeats a piece around a centre', (await count()).g === gR + 5, String((await count()).g));
    await js(`T.runCommand('edit.undo')`);
    await js(`T.runCommand('block.center')`);
    check('Centre puts a piece on the centre line', await js(`const g=ed.model.groups.find(x=>x.name===${JSON.stringify(boxName)}).id;const xs=ed.model.faces.filter(f=>f.g===g).flatMap(f=>f.v).map(v=>ed.model.verts[v].p[0]);return Math.abs(Math.max(...xs)+Math.min(...xs))<1e-5`));
    await js(`T.runCommand('block.isolate')`);
    check('Isolate hides everything else', await js(`return ed.model.groups.filter(g=>g.visible).length===1&&T.commands.get('block.isolate').checked()`));
    await js(`T.runCommand('block.isolate')`);
    check('Pressing it again brings everything back', await js(`return ed.model.groups.every(g=>g.visible)&&!T.commands.get('block.isolate').checked()`));

    // Flatten and pinch brushes.
    await js(`T.runCommand('sculpt.flatten');ed.sculpt.radius=40;ed.mirrorX=false;vp.active=vp.panes.find(q=>q.kind==='persp');`);
    await sleep(100);
    const surf = await world('front', 0.85, 1.2, 0);
    const before5 = await vertsJSON();
    await drag(surf, { x: surf.x + 4, y: surf.y });
    check('Flatten changes the surface', (await vertsJSON()) !== before5);
    const before6 = await vertsJSON();
    await js(`T.runCommand('sculpt.pinch')`);
    await drag(surf, { x: surf.x + 4, y: surf.y });
    check('Pinch changes the surface', (await vertsJSON()) !== before6);
    await js(`T.runCommand('tool.select');ed.mirrorX=true;`);

    // A starter body, in one click.
    await js(`ed.loadModel(T.emptyModel(),null,'Starter');T.runCommand('workspace.block');`);
    await sleep(200);
    const startBtn = await js(`const b=[...document.querySelectorAll('.dock button')].find(x=>x.textContent==='Character');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await click(startBtn);
    await sleep(250);
    check('One click adds a whole character of named pieces', await js(`const n=ed.model.groups.map(g=>g.name);return ['Head','Chest','UpperArm.L','UpperArm.R','Thigh.L','Foot.R'].every(x=>n.includes(x))&&ed.tool==='select'`));
    await shot('13s-character-starter');
    const moveTwin = await js(`const a=ed.model.groups.find(g=>g.name==='Hand.L').id;const b=ed.model.groups.find(g=>g.name==='Hand.R').id;const c=id=>{const P=ed.model.faces.filter(f=>f.g===id).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);return [Math.max(...P.map(p=>p[0])),Math.min(...P.map(p=>p[0]))]};return {a,b,ca:c(a),cb:c(b)}`);
    const handPt = await js(`const id=${moveTwin.a};const P=ed.model.faces.filter(f=>f.g===id).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);const m=[0,1,2].map(i=>P.reduce((s,p)=>s+p[i],0)/P.length);const pane=vp.panes.find(q=>q.kind==='front');const s=pane.project(...m);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    await click(handPt);
    await js(`T.runCommand('tool.move')`);
    await sleep(120);
    const giz = await js(`const c=vp.gizmoCenter();const pane=vp.panes.find(q=>q.kind==='front');vp.active=pane;const s=pane.project(c.x,c.y,c.z);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    await drag(giz, { x: giz.x + 25, y: giz.y });
    const handMoved = await js(`const c=id=>{const P=ed.model.faces.filter(f=>f.g===id).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);return [Math.max(...P.map(p=>p[0])),Math.min(...P.map(p=>p[0]))]};return {ca:c(${moveTwin.a}),cb:c(${moveTwin.b})}`);
    check('Moving a piece moves its mirror image', handMoved.ca[0] > moveTwin.ca[0] + 0.02 && Math.abs(handMoved.ca[0] + handMoved.cb[1]) < 1e-5, JSON.stringify([moveTwin, handMoved]));
    await js(`ed.loadModel(T.emptyModel(),null,'Block');T.runCommand('workspace.block');T.runCommand('tool.select');ed.mirrorX=false;vp.panes.forEach(p=>p.frame([0,1,0],3));`);
    await sleep(200);
    check('Blockout opens with coloured views and its panel', await js(`return ed.workspace==='block'&&vp.panes.every(p=>p.shading==='block')&&ed.mode==='group'&&document.querySelector('.dock-tabs [data-tab=block]').style.display!=='none'&&!!document.querySelector('.shape-grid')`));
    check('Blockout is general: no snap or scale figure forced on', await js(`return !ed.snap&&!ed.figure.show&&ed.drawOnSurface&&!ed.lowPoly`));
    check('The panel offers soft shapes and hard ones, and the Create menu has the rest', await js(`const t=[...document.querySelectorAll('.shape-grid')].map(g=>g.textContent).join();return ['Limb','Capsule','Sphere','Tapered','Box','Tube','Lathe','Head','Tail'].every(x=>t.includes(x))&&!!T.commands.get('tool.stairs')&&!!T.commands.get('tool.doorway')`));
    const shapeBtn = (label) => js(`const b=[...document.querySelectorAll('.shape-btn')].find(x=>x.textContent===${JSON.stringify(label)});const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    const fp = (x, y, z) => world('front', x, y, z);
    const piecesNamed = () => js(`return ed.model.groups.map(g=>g.name).sort().join()`);

    // A torso in the Front view, then depth in the Right view.
    await click(await shapeBtn('Sphere'));
    check('Clicking a shape in the panel picks its tool', await js(`return ed.tool==='sphere'`));
    await drag(await fp(-0.4, 1, 0), await fp(0.4, 2, 0));
    const depthAt = await world('right', 0, 1.5, 0);
    await drag(depthAt, { x: depthAt.x + 40, y: depthAt.y });
    await key('Enter');
    let box1 = await js(`const g=ed.model.groups[0].id;const P=ed.model.faces.filter(f=>f.g===g).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);const r=i=>Math.max(...P.map(p=>p[i]))-Math.min(...P.map(p=>p[i]));return [r(0),r(1),r(2)]`);
    check('Drawing makes a piece with width, height and depth', box1[0] > 0.7 && box1[1] > 0.9 && box1[2] > 0.1, JSON.stringify(box1));

    // With symmetry on, an arm drawn on one side gets the other.
    await js(`ed.mirrorX=true;ed.emit('view','tool');T.runCommand('tool.capsule')`);
    await sleep(120);
    await drag(await fp(0.9, 1.2, 0), await fp(1.4, 1.8, 0));
    await key('Enter');
    const armNames = await piecesNamed();
    check('Symmetry adds the other side of a piece, with named sides', armNames.includes('Capsule.L') && armNames.includes('Capsule.R') && (await count()).g === 3, armNames);
    const twinOK = await js(`const by=n=>{const g=ed.model.groups.find(x=>x.name===n).id;const P=ed.model.faces.filter(f=>f.g===g).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);return (Math.max(...P.map(p=>p[0]))+Math.min(...P.map(p=>p[0])))/2};return by('Capsule.L')+by('Capsule.R')`);
    check('The two sides mirror each other', Math.abs(twinOK) < 1e-5, String(twinOK));

    // Building out from a piece's surface.
    const torsoFaces = (await count()).f;
    await js(`T.runCommand('view.mirrorX');T.runCommand('tool.box');vp.setLayout('single',vp.panes[1]);vp.panes[1].frame([0,1.5,0],1.5);`);
    await sleep(200);
    const topHit = await js(`const p=vp.active;const s=p.project(0,2,0);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top)}`);
    const before3d = await js(`return ed.model.groups.length`);
    await drag({ x: topHit.x - 5, y: topHit.y + 3 }, { x: topHit.x + 15, y: topHit.y + 12 });
    await key('Enter');
    check('Starting on a piece builds on its surface', await js(`const g=ed.model.groups[ed.model.groups.length-1].id;const P=ed.model.faces.filter(f=>f.g===g).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);return ed.model.groups.length===${before3d}+1&&Math.max(...P.map(p=>p[1]))>1.7`));
    void torsoFaces;
    await js(`vp.setLayout('quad');T.runCommand('tool.select')`);
    await sleep(150);

    // Selecting a whole piece with a click, then moving it.
    const armP = await js(`const g=ed.model.groups.find(x=>x.name==='Capsule.L').id;const P=ed.model.faces.filter(f=>f.g===g).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);const c=[0,1,2].map(i=>(Math.max(...P.map(p=>p[i]))+Math.min(...P.map(p=>p[i])))/2);const pane=vp.panes.find(q=>q.kind==='front');const s=pane.project(...c);const r=vp.el.getBoundingClientRect();return {x:Math.round(s.x+r.left),y:Math.round(s.y+r.top),g}`);
    await click(armP);
    check('A click selects a whole piece', await js(`const fs=ed.model.faces.filter(f=>f.g===${armP.g}).length;return ed.selFaces.size===fs&&ed.activeGroup===${armP.g}`));
    await sleep(120);
    check('The panel shows colours and the measurement overlay starts off', await js(`return !!document.querySelector('.block-colors')&&!ed.blockDims`));
    await shot('13p-blockout');

    // Colour, duplicate, array, join, drop, leave.
    await js(`[...document.querySelectorAll('.color-chip')][3].click()`);
    check('A colour chip recolours the piece', await js(`return ed.model.groups.find(g=>g.id===${armP.g}).color==='#a3b18a'`));
    const g0dup = (await count()).g;
    await key('D', ['shift']);
    check('Shift+D copies the piece as its own and picks it up', (await count()).g === g0dup + 1 && (await js(`return ed.tool==='move'`)));
    await js(`T.runCommand('block.array');ed.adjustLastOp('count',3);`);
    check('Array adds separate pieces and adjusts live', (await count()).g === g0dup + 3, String((await count()).g));
    await js(`T.runCommand('edit.undo');T.runCommand('tool.select');T.runCommand('block.drop');`);
    check('Drop lowers the piece', await js(`return ed.selectedFaceSet().size>0`));
    await js(`T.runCommand('tool.stairs');`);
    await sleep(100);
    const stair = await fp(-2, 0, 0);
    await drag(stair, { x: stair.x + 50, y: stair.y - 50 });
    await key('Up');
    check('Arrow keys change the step count', await js(`return ed.primSteps===7`));
    await key('Enter');
    await js(`T.runCommand('tool.select');ed.primSteps=6;T.runCommand('block.figure');vp.invalidate();`);
    await sleep(120);
    check('The size reference is optional, and never joins the model', await js(`return ed.figure.show&&ed.model.groups.every(g=>!/figure/i.test(g.name))`));
    const matsMade = await js(`T.runCommand('block.colorsToMaterials');return ed.model.materials.length>0&&ed.model.groups.every(g=>g.material!==null)`);
    check('Colours become materials for export', matsMade);
    await js(`T.runCommand('block.figure');`);

    await js(`T.runCommand('workspace.model')`);
    await sleep(200);
    check('Leaving Blockout restores the views and hides its tab', await js(`return vp.panes[0].shading!=='block'&&ed.mode!=='group'&&document.querySelector('.dock-tabs [data-tab=block]').style.display==='none'&&!document.querySelector('.shape-grid')`));

    // Reference images: a solid red picture, so the pixels prove it's really drawn.
    await js(`ed.loadModel(T.emptyModel(),null,'Refs');T.runCommand('workspace.block');vp.panes.forEach(p=>p.frame([0,1,0],2.5));`);
    await sleep(200);
    const makeImage = `const c=document.createElement('canvas');c.width=200;c.height=400;const x=c.getContext('2d');x.fillStyle='#ff0000';x.fillRect(0,0,200,400);const blob=await new Promise(r=>c.toBlob(r,'image/png'));`;
    await js(`${makeImage}await T.addReference('front.png',await blob.arrayBuffer(),'front');`);
    await sleep(350);
    check('Adding a picture starts it ready to place', await js(`return ed.model.refs.length===1&&ed.refEdit&&ed.refActive===ed.model.refs[0].id&&ed.model.refs[0].view==='front'`));
    const pixelAt = (kind, wx, wy, wz) => js(`const p=vp.panes.find(q=>q.kind==='${kind}');vp.renderNow();const s=p.project(${wx},${wy},${wz});const r=vp.sg.renderer;const gl=r.getContext();const dpr=r.getPixelRatio();const o=new Uint8Array(4);gl.readPixels(Math.round(s.x*dpr),Math.round((vp.gl.clientHeight-s.y)*dpr),1,1,gl.RGBA,gl.UNSIGNED_BYTE,o);return [...o]`);
    const isRed = (px) => px[0] > 130 && px[1] < 90 && px[2] < 90;
    let rf = await js(`const r=ed.model.refs[0];return [r.x,r.y,r.size]`);
    let px = await pixelAt('front', rf[0], rf[1], 0);
    check('The picture shows in its own view', isRed(px), JSON.stringify(px));
    px = await pixelAt('right', 0, rf[1], 0);
    check('It stays out of the other side views', !isRed(px), JSON.stringify(px));
    await shot('13q-reference');

    // Move and scale it with the mouse.
    const refScreen = (u, v) => js(`const r=ed.model.refs[0];const p=vp.panes.find(q=>q.kind==='front');const w=r.size*r.width/r.height;const s=p.project(r.x+${u}*w/2,r.y+${v}*r.size/2,0);const b=vp.el.getBoundingClientRect();return {x:Math.round(s.x+b.left),y:Math.round(s.y+b.top)}`);
    let hit = await refScreen(0, 0);
    const before4 = await js(`return [ed.model.refs[0].x,ed.model.refs[0].y,ed.historyDepth]`);
    await drag(hit, { x: hit.x + 30, y: hit.y - 20 });
    let after4 = await js(`return [ed.model.refs[0].x,ed.model.refs[0].y,ed.historyDepth]`);
    check('Dragging the picture moves it as one undo step', after4[0] > before4[0] && after4[1] > before4[1] && after4[2] === before4[2] + 1, JSON.stringify([before4, after4]));
    const opp0 = await js(`const r=ed.model.refs[0];return [r.x-r.size*r.width/r.height/2,r.y+r.size/2,r.size]`);
    hit = await refScreen(1, -1);
    await drag(hit, { x: hit.x + 25, y: hit.y + 50 });
    const opp1 = await js(`const r=ed.model.refs[0];return [r.x-r.size*r.width/r.height/2,r.y+r.size/2,r.size]`);
    check('Dragging a corner scales from the opposite corner', opp1[2] > opp0[2] * 1.05 && Math.abs(opp1[0] - opp0[0]) < 1e-6 && Math.abs(opp1[1] - opp0[1]) < 1e-6, JSON.stringify([opp0, opp1]));
    await js(`T.runCommand('edit.undo');T.runCommand('edit.undo');T.runCommand('tool.box');`);
    check('Picking a shape ends placing, so drags draw again', await js(`return !ed.refEdit&&ed.tool==='box'`));

    // Tracing: draw a piece over the picture, and see through it.
    const rr = await js(`const r=ed.model.refs[0];return [r.x,r.y]`);
    await drag(await fp(rr[0] - 0.2, rr[1] - 0.2, 0), await fp(rr[0] + 0.2, rr[1] + 0.2, 0));
    check('Dragging over the picture draws a piece', (await count()).g === 1 && (await js(`return ed.model.refs[0].x`)) === rr[0]);
    await key('Enter');
    await js(`T.runCommand('tool.select');ed.clearSelection();ed.emit('selection')`);
    await sleep(120);
    const pieceAt = await js(`const g=ed.model.groups[0].id;const P=ed.model.faces.filter(f=>f.g===g).flatMap(f=>f.v).map(v=>ed.model.verts[v].p);return [0,1,2].map(i=>(Math.max(...P.map(p=>p[i]))+Math.min(...P.map(p=>p[i])))/2)`);
    const faceCenter = (i) => pieceAt[i];
    px = await pixelAt('front', faceCenter(0), faceCenter(1), faceCenter(2));
    check('The picture sits behind a solid piece', !isRed(px), JSON.stringify(px));
    await js(`T.runCommand('ref.ghost')`);
    await sleep(100);
    const ghostPx = await pixelAt('front', faceCenter(0), faceCenter(1), faceCenter(2));
    check('See-through pieces show the picture through them', ghostPx[0] > px[0] + 5 || (ghostPx[0] - ghostPx[1]) > (px[0] - px[1]) + 5, JSON.stringify([px, ghostPx]));
    await js(`T.runCommand('ref.ghost')`);
    const refGone = await js(`const r=ed.model.refs[0];ed.transact('h',d=>{d.refs[0].visible=false;});vp.renderNow();return r.x`);
    px = await pixelAt('front', refGone + 0.3, rr[1] + 0.6, 0);
    check('Hiding the picture removes it', !isRed(px), JSON.stringify(px));
    await js(`T.runCommand('edit.undo')`);

    // Drop a picture on a view, keep it through saving, and leave it out of exports.
    const dropped = await js(`${makeImage}const f=new File([blob],'side.png',{type:'image/png'});const dt=new DataTransfer();dt.items.add(f);const p=vp.panes.find(q=>q.kind==='right');const b=vp.el.getBoundingClientRect();window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,clientX:b.left+p.x+p.w/2,clientY:b.top+p.y+p.h/2,bubbles:true,cancelable:true}));await new Promise(r=>setTimeout(r,500));return ed.model.refs.map(r=>r.view).join()`);
    check('Dropping a picture on a view puts it behind that view', dropped === 'front,right', dropped);
    await sleep(150);
    // Near the picture's edge, clear of the piece in front of it.
    const rightPx = await js(`const r=ed.model.refs[1];return [r.x+r.size*r.width/r.height*0.48,r.y+r.size*0.48]`);
    px = await pixelAt('right', 0, rightPx[1], -rightPx[0]);
    check('It appears there, not mirrored away', isRed(px), JSON.stringify(px));
    const persist = await js(`const copy=T.parseProject(T.serializeProject(ed.model));return copy.refs.length`);
    check('Pictures save with the project', persist === 2);
    await js(`T.runCommand('ref.delete')`);
    check('Delete removes the active picture', await js(`return ed.model.refs.length===1`));
    await js(`ed.refActive=null;T.runCommand('workspace.model')`);
    await sleep(150);
    await js(`vp.linked=true;ed.loadModel(T.emptyModel(),null,'After block');T.runCommand('create.box');T.runCommand('tool.select');`);

    // Materials, with real clicks on the panel.
    await js(`ed.loadModel(T.emptyModel(),null,'Mats');T.runCommand('create.sphere');T.runCommand('workspace.model');ed.setMode('group');ed.clearSelection();ed.model.faces.forEach((f,i)=>ed.selFaces.add(i));ed.emit('selection');document.querySelector('[data-tab=material]').click();`);
    await sleep(350);
    check('The Material tab offers looks before any material exists', await js(`return document.querySelectorAll('.preset-btn').length>=20`));
    const presetBtn = (name) => js(`const b=document.querySelector('.preset-btn[data-preset="${name}"]');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await click(await presetBtn('Gold'));
    await sleep(300);
    check('A look starts a material and gives it to the selection', await js(`const m=ed.model.materials[0];return ed.model.materials.length===1&&m.name==='Gold'&&m.metallic===1&&ed.model.groups[0].material===m.id`));
    const previewPixels = await js(`const c=document.querySelector('.mat-preview');if(!c)return null;const g=document.createElement('canvas');g.width=c.width;g.height=c.height;const x=g.getContext('2d');x.drawImage(c,0,0);const d=x.getImageData(c.width>>1,c.height>>1,1,1).data;return [...d]`);
    check('The preview shows the material', previewPixels && previewPixels[0] > previewPixels[2] + 20, JSON.stringify(previewPixels));
    await shot('13y-materials');
    await click(await presetBtn('Car Paint'));
    await sleep(250);
    check('A look changes the active material, as one undo step', await js(`const m=ed.model.materials[0];return m.clearcoat===1&&m.metallic===0.6&&m.name==='Gold'`));
    await click(await presetBtn('Rubber'));
    await sleep(200);
    check('Looks leave nothing behind from the last one', await js(`const m=ed.model.materials[0];return m.clearcoat===0&&m.metallic===0`));
    await js(`T.runCommand('edit.undo');T.runCommand('edit.undo')`);
    await sleep(200);
    check('Undo restores the earlier look', await js(`return ed.model.materials[0].metallic===1&&!ed.model.materials[0].clearcoat`));

    // The viewport and scene use it: unlit colour is exact, whatever the light.
    await js(`vp.setLayout('single',vp.panes[1]);vp.panes[1].shading='pbr';vp.panes[1].frame([0,0,0],1);ed.clearSelection();ed.emit('selection');ed.transact('u',d=>{const t=d.materials[0];t.unlit=true;t.color='#00c040';});`);
    await sleep(250);
    const unlitPx = await js(`const p=vp.panes[1];vp.renderNow();const s=p.project(0,0,0);const r=vp.sg.renderer;const gl=r.getContext();const dpr=r.getPixelRatio();const o=new Uint8Array(4);gl.readPixels(Math.round(s.x*dpr),Math.round((vp.gl.clientHeight-s.y)*dpr),1,1,gl.RGBA,gl.UNSIGNED_BYTE,o);return [...o]`);
    check('Unlit shows its colour flat in the viewport', unlitPx[1] > 150 && unlitPx[0] < 40, JSON.stringify(unlitPx));
    await js(`ed.transact('l',d=>{d.materials[0].unlit=false;d.materials[0].metallic=0;});vp.setLayout('quad');`);
    await sleep(150);

    // Scrubbing a new slider, and texture tools working on real pixels.
    const coatLabel = await js(`const l=[...document.querySelectorAll('.dock .num-label')].find(x=>x.textContent==='Clearcoat');l.scrollIntoView({block:'center'});const r=l.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await drag(coatLabel, { x: coatLabel.x + 50, y: coatLabel.y });
    await sleep(200);
    check('Scrubbing Clearcoat changes it', await js(`return ed.model.materials[0].clearcoat>0.3&&ed.model.materials[0].clearcoat<0.7`));
    const makeTex = `const c=document.createElement('canvas');c.width=16;c.height=16;const x=c.getContext('2d');for(let i=0;i<16;i++){x.fillStyle=i%2?'#ffffff':'#303030';x.fillRect(i,0,1,16);}const url=c.toDataURL('image/png');`;
    await js(`${makeTex}ed.transact('t',d=>{d.textures.push({id:9000,name:'stripes',url,width:16,height:16});d.nextId=9100;d.materials[0].maps.base=9000;});`);
    await sleep(200);
    await js(`await T.panels.makeNormalFromBase(2)`);
    check('Normal maps generate from the base colour', await js(`const m=ed.model.materials[0];const t=ed.model.textures.find(x=>x.id===m.maps.normal);return !!t&&t.width===16&&t.url.startsWith('data:image/png')`));
    const normBefore = await js(`return ed.model.materials[0].maps.normal`);
    await js(`await T.panels.flipNormalGreen()`);
    check('Flip Green makes a new normal map', await js(`return ed.model.materials[0].maps.normal!==${normBefore}`));
    await js(`${makeTex}await T.panels.packOrmImage('roughness',url,'r.png');`);
    const ormPx = await js(`const m=ed.model.materials[0];const t=ed.model.textures.find(x=>x.id===m.maps.orm);const i=new Image();i.src=t.url;await i.decode();const c=document.createElement('canvas');c.width=t.width;c.height=t.height;const x=c.getContext('2d');x.drawImage(i,0,0);return {even:[...x.getImageData(0,0,1,1).data],odd:[...x.getImageData(1,0,1,1).data],rough:m.roughness,metal:m.metallic}`);
    check('Greyscale roughness packs into the green channel', ormPx.even[1] < 80 && ormPx.odd[1] > 200 && ormPx.even[0] === 255 && ormPx.rough === 1 && ormPx.metal === 1, JSON.stringify(ormPx));
    await js(`await T.panels.halveTextures()`);
    check('Half Size shrinks every map', await js(`const m=ed.model.materials[0];return Object.values(m.maps).every(id=>ed.model.textures.find(t=>t.id===id).width===8)`));

    // Everything survives a round trip through GLB, with the panel's tiling applied.
    const roundTrip = await js(`ed.transact('p',d=>{Object.assign(d.materials[0],{clearcoat:0.5,clearcoatRoughness:0.25,sheen:0.6,sheenColor:'#ff8040',transmission:0.4,ior:1.33,normalScale:0.5,alphaMode:'mask',alphaCutoff:0.3,uvScale:[2,3],uvOffset:[0.1,0.2],uvRotation:0.4,emissive:'#102030',emissiveStrength:3});});const g=T.exportGLB(ed.model,T.defaultExport);const r=await T.importFile('m.glb',g.buffer.slice(g.byteOffset,g.byteOffset+g.byteLength));const a=r.materials[0];return {cc:a.clearcoat,ccr:a.clearcoatRoughness,sh:a.sheen,col:a.sheenColor,tr:a.transmission,ior:a.ior,ns:a.normalScale,cut:a.alphaCutoff,mode:a.alphaMode,scale:a.uvScale,off:a.uvOffset,rot:a.uvRotation,emi:a.emissiveStrength,maps:Object.keys(a.maps).length}`);
    const near2 = (a, b, t = 0.02) => Math.abs(a - b) < t;
    check('Material settings survive a GLB round trip', near2(roundTrip.cc, 0.5) && near2(roundTrip.ccr, 0.25) && near2(roundTrip.tr, 0.4) && near2(roundTrip.ior, 1.33) && near2(roundTrip.ns, 0.5) && near2(roundTrip.cut, 0.3) && roundTrip.mode === 'mask' && near2(roundTrip.emi, 3), JSON.stringify(roundTrip));
    check('Sheen and tiling survive it too', near2(roundTrip.sh, 0.6, 0.05) && roundTrip.scale && near2(roundTrip.scale[0], 2) && near2(roundTrip.scale[1], 3) && near2(roundTrip.rot, 0.4), JSON.stringify(roundTrip));
    const unlitTrip = await js(`ed.transact('u',d=>{d.materials[0].unlit=true;});const g=T.exportGLB(ed.model,T.defaultExport);const r=await T.importFile('m.glb',g.buffer.slice(g.byteOffset,g.byteOffset+g.byteLength));return !!r.materials[0].unlit`);
    check('Unlit survives a GLB round trip', unlitTrip);
    await js(`ed.loadModel(T.emptyModel(),null,'After mats');T.runCommand('create.box');T.runCommand('workspace.model');T.runCommand('tool.select');`);

    // Primitives live behind one rail button.
    {
      await js(`ed.loadModel(T.emptyModel(),null,'Prims');T.setWorkspace('model');T.runCommand('tool.select');`);
      await sleep(200);
      const btn = await js(`const r=document.querySelector('.tool-flyout').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
      check('The rail has one Primitives button, and no separate shapes', await js(`const names=[...document.querySelectorAll('.toolrail .tool-btn')].map(b=>b.getAttribute('aria-label'));return names.includes('Primitives')&&!['Box','Sphere','GeoSphere','Cylinder','Cone','Pyramid','Plane','Torus'].some(n=>names.includes(n))`));
      check('The rail still fits without scrolling', await js(`const r=document.querySelector('.toolrail');return r.scrollHeight<=r.clientHeight`));
      await click(btn);
      await sleep(120);
      const items = await js(`return [...document.querySelectorAll('.flyout-menu .menu-item')].map(b=>b.textContent.trim())`);
      check('Clicking it opens every primitive with its name', ['Box', 'Sphere', 'GeoSphere', 'Cylinder', 'Cone', 'Pyramid', 'Torus', 'Plane', 'Capsule', 'Tapered', 'Wedge', 'Stairs', 'Doorway'].every((n) => items.includes(n)), items.join(','));
      check('Each one shows its icon', await js(`return [...document.querySelectorAll('.flyout-menu .menu-item')].every(b=>b.querySelector('svg'))`));
      check('The submenu opens beside the rail, on screen', await js(`const m=document.querySelector('.flyout-menu').getBoundingClientRect(),r=document.querySelector('.toolrail').getBoundingClientRect();return m.left>=r.right&&m.bottom<=innerHeight&&m.top>=0`));
      await shot('primitives-flyout');
      await click(btn);
      await sleep(100);
      check('Clicking the button again closes it', await js(`return !document.querySelector('.flyout-menu')`));
      await click(btn);
      await sleep(100);
      send({ type: 'keyDown', keyCode: 'Escape' }); send({ type: 'keyUp', keyCode: 'Escape' });
      await sleep(100);
      check('Esc closes it', await js(`return !document.querySelector('.flyout-menu')&&ed.tool==='select'`));
      await click(btn);
      await sleep(100);
      const sphereItem = await js(`const b=[...document.querySelectorAll('.flyout-menu .menu-item')].find(x=>x.textContent.trim()==='Sphere');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
      await click(sphereItem);
      await sleep(150);
      check('Picking one starts that tool and closes the submenu', await js(`return ed.tool==='sphere'&&!document.querySelector('.flyout-menu')`));
      check('The button lights up while a primitive tool is on', await js(`return document.querySelector('.tool-flyout').classList.contains('active')`));
      const a = await screen(-0.6, 0.6, 0, `vp.panes.find(q=>q.kind==='front')`);
      const b = await screen(0.6, -0.6, 0, `vp.panes.find(q=>q.kind==='front')`);
      await drag(a, b);
      await sleep(150);
      send({ type: 'keyDown', keyCode: 'Return' }); send({ type: 'keyUp', keyCode: 'Return' });
      await sleep(250);
      check('The picked tool draws in the view', (await count()).f > 10, JSON.stringify(await count()));
      await click(btn);
      await sleep(100);
      check('The submenu marks the tool in use', await js(`const a=document.querySelector('.flyout-menu .active');return !!a&&a.textContent.trim()==='Sphere'`));
      const blank = await screen(1.5, 1.2, 0, `vp.panes.find(q=>q.kind==='front')`);
      await js(`T.runCommand('tool.select')`);
      await sleep(80);
      send({ type: 'mouseDown', x: blank.x, y: blank.y, button: 'left', clickCount: 1 });
      await sleep(60);
      check('Clicking elsewhere closes it', await js(`return !document.querySelector('.flyout-menu')`));
      send({ type: 'mouseUp', x: blank.x, y: blank.y, button: 'left', clickCount: 1 });
      await sleep(80);
      await js(`T.runCommand('tool.select');ed.loadModel(T.emptyModel(),null,'After prims');T.runCommand('create.box');`);
      await sleep(150);
      const enter = () => { send({ type: 'keyDown', keyCode: 'Return' }); send({ type: 'char', keyCode: '\r' }); send({ type: 'keyUp', keyCode: 'Return' }); };
      // A real Tab from the button before it, since focus set by script doesn't count as keyboard focus after mouse use.
      await js(`const b=document.querySelector('.tool-flyout');const all=[...document.querySelectorAll('.toolrail button')];all[all.indexOf(b)-1].focus();`);
      send({ type: 'keyDown', keyCode: 'Tab' }); send({ type: 'keyUp', keyCode: 'Tab' });
      await sleep(80);
      check('Tab reaches the button', await js(`return document.activeElement.classList.contains('tool-flyout')&&document.activeElement.matches(':focus-visible')`));
      enter();
      for (let i = 0; i < 30 && !(await js(`return !!document.querySelector('.flyout-menu')`)); i++) await sleep(50);
      check('The keyboard can open it too', await js(`return !!document.querySelector('.flyout-menu')&&document.activeElement.classList.contains('menu-item')`));
      send({ type: 'keyDown', keyCode: 'Down' }); send({ type: 'keyUp', keyCode: 'Down' });
      await sleep(60);
      check('Arrow keys walk the list', await js(`return document.activeElement.textContent.trim()==='Sphere'`));
      enter();
      await sleep(120);
      check('Enter picks from the list', await js(`return ed.tool==='sphere'&&!document.querySelector('.flyout-menu')`));
      await js(`T.runCommand('tool.select')`);
      await sleep(80);
    }

    // Knife and Loop Cut, driven the way Blender's are: real keys, wheel and mouse.
    {
      const front = `vp.panes.find(q=>q.kind==='front')`;
      const press = (k) => { send({ type: 'keyDown', keyCode: k }); send({ type: 'keyUp', keyCode: k }); };
      const type = (k) => { send({ type: 'keyDown', keyCode: k }); send({ type: 'char', keyCode: k }); send({ type: 'keyUp', keyCode: k }); };
      const hoverAt = async (p) => { send({ type: 'mouseMove', x: p.x, y: p.y }); await sleep(70); };
      const fresh = async (cmd = 'create.box') => {
        await js(`ed.loadModel(T.emptyModel(),null,'Cuts');T.setWorkspace('model');T.runCommand('${cmd}');ed.clearSelection();ed.mode='vertex';T.runCommand('tool.select');const p=${front};vp.setLayout('single',p);p.shading='clay';p.frame([0,0,0],1);ed.emit('selection','tool');document.activeElement.blur();`);
        await sleep(250);
      };
      const stats = () => js(`const m=ed.model;return {v:m.verts.length,f:m.faces.length}`);
      const closed = `(()=>{const c=new Map();for(const f of ed.model.faces)f.v.forEach((v,i)=>{const w=f.v[(i+1)%f.v.length];const k=v<w?v+'_'+w:w+'_'+v;c.set(k,(c.get(k)||0)+1);});return [...c.values()].every(n=>n===2)})()`;

      // --- Loop Cut ---
      await fresh();
      const start = await js(`return ed.tool`);
      const onEdge = await screen(0.5, 0.1, 0.5, front);
      const leftEdge = await screen(-0.5, 0.1, 0.5, front);
      send({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] }); send({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
      await sleep(100);
      check('Ctrl+R starts Loop Cut', await js(`return ed.tool==='loopcut'`));
      await hoverAt(onEdge);
      check('Hovering an edge previews a loop, changing nothing', await js(`return !!vp.loopTool.hovering&&ed.model.faces.length===6`));
      await js(`vp.renderNow()`);
      await shot('loopcut-hover');
      send({ type: 'mouseWheel', x: onEdge.x, y: onEdge.y, deltaX: 0, deltaY: 120, wheelTicksY: 1, canScroll: true });
      await sleep(120);
      check('The wheel adds cuts instead of zooming', await js(`return vp.loopTool.cutCount===2`), await js(`return vp.loopTool.cutCount`));
      press('PageDown');
      await sleep(60);
      check('Page Down takes one away', await js(`return vp.loopTool.cutCount===1`));
      type('3');
      await sleep(60);
      check('Typing a number sets the cuts', await js(`return vp.loopTool.cutCount===3`));
      type('1');
      await sleep(1000);
      type('1');
      await sleep(60);
      check('Numbers typed apart start over', await js(`return vp.loopTool.cutCount===1`), await js(`return vp.loopTool.cutCount`));

      // A click places it and leaves the slide following the pointer, then a second click confirms.
      await click(onEdge);
      await sleep(150);
      check('A click places the loop and starts the slide', await js(`return vp.loopTool.sliding&&ed.model.faces.length===10`), JSON.stringify(await stats()));
      const up = await screen(0.5, 0.35, 0.5, front);
      await hoverAt(up);
      await sleep(150);
      const slid = await js(`return vp.loopTool.factor`);
      check('Moving the pointer slides it along the edge', Math.abs(slid - 0.5) < 0.2, String(slid));
      check('The slide is not an undo step yet', await js(`return ed.tool==='loopcut'&&ed.model.verts.length===12`));
      await click(up);
      await sleep(200);
      check('A second click confirms the slide', await js(`return !vp.loopTool.sliding`));
      const level = await js(`const ys=ed.model.verts.slice(8).map(v=>v.p[1]);return {n:ys.length,lo:Math.min(...ys),hi:Math.max(...ys)}`);
      check('The loop stays level all the way round, where it was put', level.n === 4 && level.hi - level.lo < 1e-5 && Math.abs(level.lo - 0.25) < 0.1, JSON.stringify(level));
      check('The mesh is still sealed', await js(`return ${closed}`));
      check('Ctrl+R gives back the tool you were using', (await js(`return ed.tool`)) === start, await js(`return ed.tool`));
      check('The new loop is selected', await js(`return ed.selVerts.size===4`));
      check('The panel offers Number of Cuts and Factor', await js(`const l=ed.lastOp;return l&&l.label==='Loop Cut'&&l.params.some(p=>p.key==='cuts')&&Math.abs(l.params.find(p=>p.key==='slide').value-${slid})<0.2`));
      await js(`ed.adjustLastOp('cuts',3)`);
      await sleep(150);
      check('Number of Cuts can be changed afterward', (await stats()).f === 6 + 12, JSON.stringify(await stats()));
      await js(`T.runCommand('edit.undo')`);
      await sleep(150);
      check('Undo removes the loop in one step', (await stats()).f === 6);

      // Esc and right click leave it centred, and it's still cut.
      await js(`T.runCommand('tool.loopcut')`);
      await sleep(80);
      await hoverAt(onEdge);
      await click(onEdge);
      await sleep(120);
      await hoverAt(up);
      await sleep(120);
      press('Escape');
      await sleep(200);
      const centred = await js(`return {f:ed.model.faces.length,y:ed.model.verts[8].p[1],tool:ed.tool}`);
      check('Esc during a slide keeps the cut, centred', centred.f === 10 && Math.abs(centred.y) < 1e-5, JSON.stringify(centred));
      check('From the toolbar, Loop Cut stays on for the next cut', centred.tool === 'loopcut');
      await js(`T.runCommand('edit.undo')`);
      await sleep(120);
      await hoverAt(onEdge);
      await click(onEdge);
      await sleep(100);
      await hoverAt(up);
      await sleep(100);
      send({ type: 'mouseDown', x: up.x, y: up.y, button: 'right', clickCount: 1 });
      await sleep(30);
      send({ type: 'mouseUp', x: up.x, y: up.y, button: 'right', clickCount: 1 });
      await sleep(200);
      check('A right click during a slide does the same', await js(`return ed.model.faces.length===10&&Math.abs(ed.model.verts[8].p[1])<1e-5&&!vp.loopTool.sliding`));
      await js(`T.runCommand('edit.undo')`);
      await sleep(120);

      // Drag: place and slide in one go. Even and typed values.
      await drag(onEdge, up);
      await sleep(200);
      check('Dragging places and slides in one go', await js(`return ed.model.faces.length===10&&ed.model.verts[8].p[1]>0.1&&!vp.loopTool.sliding`));
      await js(`T.runCommand('edit.undo')`);
      await sleep(120);
      await hoverAt(leftEdge);
      await click(leftEdge);
      await sleep(100);
      for (const ch of '-0.5') { type(ch); await sleep(30); }
      await sleep(80);
      press('Enter'); send({ type: 'char', keyCode: '\r' });
      await sleep(200);
      const typedSlide = await js(`return ed.lastOp&&ed.lastOp.params.find(p=>p.key==='slide').value`);
      check('A slide value can be typed', typedSlide === -0.5, String(typedSlide));
      await js(`T.runCommand('edit.undo');T.runCommand('tool.select');`);
      await sleep(120);

      // --- Knife ---
      await fresh();
      const kl = await screen(-0.9, 0, 0.5, front), kr = await screen(0.9, 0, 0.5, front);
      type('k');
      await sleep(100);
      check('K starts the Knife outside Animate', await js(`return ed.tool==='knife'`));
      await hoverAt(kl);
      await click(kl);
      await hoverAt(kr);
      check('Cutting previews without changing the model', (await stats()).f === 6 && await js(`return vp.knife.pointCount===1`));
      await click(kr);
      await sleep(80);
      await js(`vp.renderNow()`);
      await shot('knife-cut');
      check('Each click adds a point', await js(`return vp.knife.pointCount===2`));
      press('Enter'); send({ type: 'char', keyCode: '\r' });
      await sleep(250);
      const afterKnife = await stats();
      check('Enter cuts the visible face in two', afterKnife.f === 7 && afterKnife.v === 10, JSON.stringify(afterKnife));
      check('The mesh is still sealed after the Knife', await js(`return ${closed}`));
      check('K gives back the tool you were using', (await js(`return ed.tool`)) === start);
      check('The cut is selected', await js(`return ed.selVerts.size===2`));
      await js(`T.runCommand('edit.undo')`);
      await sleep(150);
      check('Undo removes the whole cut in one step', (await stats()).f === 6);

      // Esc cancels. Snapping to corners, Shift to skip it, Ctrl for midpoints.
      type('k');
      await sleep(80);
      await hoverAt(kl);
      await click(kl);
      await hoverAt(kr);
      press('Escape');
      await sleep(120);
      check('Esc cancels with nothing cut', (await stats()).f === 6 && await js(`return vp.knife.pointCount===0&&ed.tool===${JSON.stringify(start)}`));
      await js(`T.runCommand('tool.knife')`);
      await sleep(80);
      const corner = await screen(0.48, 0.48, 0.5, front);
      await hoverAt(corner);
      check('Near a corner it snaps to the corner', (await js(`return vp.knife.snapKind`)) === 'vert', await js(`return vp.knife.snapKind`));
      const nearEdge = await screen(0.48, 0.2, 0.5, front);
      await hoverAt(nearEdge);
      check('Near an edge it snaps to the edge', (await js(`return vp.knife.snapKind`)) === 'edge', await js(`return vp.knife.snapKind`));
      send({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
      await sleep(60);
      check('Holding Shift turns snapping off, without moving the pointer', (await js(`return vp.knife.snapKind`)) === 'face', await js(`return vp.knife.snapKind`));
      send({ type: 'keyUp', keyCode: 'Shift' });
      await sleep(60);
      send({ type: 'keyDown', keyCode: 'Control', modifiers: ['control'] });
      await sleep(60);
      check('Holding Ctrl snaps to the middle of the edge', (await js(`return vp.knife.snapKind`)) === 'mid', await js(`return vp.knife.snapKind`));
      send({ type: 'keyUp', keyCode: 'Control' });
      await sleep(60);

      // E starts a new cut; Ctrl+Z takes back a point; C cuts through.
      await hoverAt(kl);
      await click(kl);
      await hoverAt(kr);
      await click(kr);
      type('e');
      await sleep(50);
      const ka = await screen(0.2, 0.9, 0.5, front), kb = await screen(0.2, -0.9, 0.5, front), kc = await screen(-0.2, -0.9, 0.5, front);
      await hoverAt(ka);
      await click(ka);
      await hoverAt(kb);
      await click(kb);
      await hoverAt(kc);
      await click(kc);
      send({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); send({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
      await sleep(60);
      check('Ctrl+Z takes back the last point, not the last edit', await js(`return vp.knife.pointCount===4&&ed.model.faces.length===6`), await js(`return vp.knife.pointCount`));
      send({ type: 'keyDown', keyCode: 'Space' }); send({ type: 'char', keyCode: ' ' }); send({ type: 'keyUp', keyCode: 'Space' });
      await sleep(250);
      check('Space confirms, and E kept the two cuts apart so they cross', (await stats()).f === 9 && await js(`return ${closed}`), JSON.stringify(await stats()));
      await js(`T.runCommand('edit.undo')`);
      await sleep(150);
      type('c');
      await sleep(50);
      check('C turns on cut through', await js(`return vp.knife.options.through`));
      await hoverAt(kl);
      await click(kl);
      await hoverAt(kr);
      await click(kr);
      press('Enter'); send({ type: 'char', keyCode: '\r' });
      await sleep(250);
      check('Cut through goes all the way round', (await stats()).f === 10 && await js(`return ${closed}`), JSON.stringify(await stats()));
      await js(`T.runCommand('edit.undo')`);
      await sleep(120);
      type('c');
      await sleep(50);

      // A closed cut by double click, then confirm.
      const sq = [await screen(-0.2, -0.2, 0.5, front), await screen(0.2, -0.2, 0.5, front), await screen(0.2, 0.2, 0.5, front), await screen(-0.2, 0.2, 0.5, front)];
      send({ type: 'keyDown', keyCode: 'Shift', modifiers: ['shift'] });
      for (const q of sq.slice(0, 3)) { await hoverAt(q); send({ type: 'mouseDown', x: q.x, y: q.y, button: 'left', clickCount: 1, modifiers: ['shift'] }); await sleep(30); send({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 1, modifiers: ['shift'] }); await sleep(40); }
      const q = sq[3];
      await hoverAt(q);
      send({ type: 'mouseDown', x: q.x, y: q.y, button: 'left', clickCount: 1, modifiers: ['shift'] }); send({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 1, modifiers: ['shift'] });
      await sleep(30);
      send({ type: 'mouseDown', x: q.x, y: q.y, button: 'left', clickCount: 2, modifiers: ['shift'] }); send({ type: 'mouseUp', x: q.x, y: q.y, button: 'left', clickCount: 2, modifiers: ['shift'] });
      await sleep(80);
      send({ type: 'keyUp', keyCode: 'Shift' });
      press('Enter'); send({ type: 'char', keyCode: '\r' });
      await sleep(250);
      const hole = await js(`const m=ed.model;const inner=m.faces.filter(f=>f.v.every(v=>Math.abs(m.verts[v].p[0])<0.21&&Math.abs(m.verts[v].p[1])<0.21));return {inner:inner.length,f:m.faces.length,closed:${closed}}`);
      check('A double click closes the loop, making a new face inside', hole.inner === 1 && hole.closed, JSON.stringify(hole));
      await js(`T.runCommand('tool.select');`);

      // K still keys a pose in Animate.
      await js(`T.setWorkspace('animate');document.activeElement.blur();`);
      await sleep(150);
      type('k');
      await sleep(100);
      check('In Animate, K stays Set Key', await js(`return ed.tool!=='knife'`), await js(`return ed.tool`));
      await js(`T.setWorkspace('model');vp.setLayout('quad');ed.loadModel(T.emptyModel(),null,'After cuts');T.runCommand('create.box');T.runCommand('tool.select');`);
      await sleep(150);
    }

    // Colours, palettes, gradients and importing images.
    {
    await js(`localStorage.removeItem('thickshake.palettes');localStorage.removeItem('thickshake.recentColors');const c=T.panels.colorStore;c.custom=[];c.recent=[];c.setActive('Skin tones');ed.loadModel(T.emptyModel(),null,'Colours');T.runCommand('create.box');T.runCommand('workspace.model');T.runCommand('tool.select');T.panels.panelState.tab='material';T.panels.refreshDock();`);
    await sleep(250);
    const centerOf = (sel) => js(`const e=${sel};if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    const dockBtn = (text) => centerOf(`[...document.querySelectorAll('.dock button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})`);
    const mat0 = (expr) => js(`const m=ed.model.materials[0];return ${expr}`);
    await click(await presetBtn('Rubber'));
    await sleep(250);
    check('A material exists for the colour tests', await js(`return ed.model.materials.length===1&&ed.model.groups[0].material===ed.model.materials[0].id`));
    await js(`ed.transact('c',d=>{d.materials[0].color='#808080';});`);
    await sleep(200);

    // The picker: real drags on its square and hue bar.
    const baseBtn = `[...document.querySelectorAll('.dock .color-btn')].find(b=>b.title.startsWith('Base colour'))`;
    await click(await centerOf(baseBtn));
    await sleep(200);
    check('A colour button opens the picker', await js(`return !!document.querySelector('.color-picker')`));
    await shot('color-picker');
    check('The picker fits on screen', await js(`const r=document.querySelector('.color-picker').getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight`));
    const sq = await js(`const r=document.querySelector('.cp-sv-wrap').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}`);
    await click({ x: Math.round(sq.l + sq.w - 2), y: Math.round(sq.t + 2) });
    await sleep(150);
    const hueRect = await js(`const r=document.querySelector('.cp-hue-wrap').getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}`);
    const hy = Math.round(hueRect.t + hueRect.h / 2);
    await drag({ x: Math.round(hueRect.l + 2), y: hy }, { x: Math.round(hueRect.l + hueRect.w / 3), y: hy });
    await sleep(150);
    const picked = await mat0('m.color');
    check('Dragging the square and hue bar changes the colour live', /^#[0-9a-f]{6}$/.test(picked) && picked !== '#808080' && parseInt(picked.slice(3, 5), 16) > 200, picked);
    check('The picker stays open while you drag', await js(`return !!document.querySelector('.color-picker')`));
    await click(await js(`const r=document.querySelector('.cp-hex').getBoundingClientRect();document.querySelector('.cp-hex').focus();return {x:Math.round(r.left+10),y:Math.round(r.top+8)}`));
    await js(`document.querySelector('.cp-hex').select()`);
    for (const ch of '3366cc') { send({ type: 'char', keyCode: ch }); await sleep(15); }
    await sleep(100);
    check('Typing a hex code sets the colour', (await mat0('m.color')) === '#3366cc', await mat0('m.color'));
    send({ type: 'keyDown', keyCode: 'Escape' }); send({ type: 'keyUp', keyCode: 'Escape' });
    await sleep(200);
    check('Esc closes the picker and puts the colour back', (await mat0('m.color')) === '#808080' && await js(`return !document.querySelector('.color-picker')`), await mat0('m.color'));
    await click(await centerOf(baseBtn));
    await sleep(150);
    await click(await js(`const r=document.querySelector('.cp-chip[title="#c68a62"]').getBoundingClientRect();return {x:Math.round(r.left+6),y:Math.round(r.top+6)}`));
    await sleep(120);
    await click({ x: 500, y: 300 });
    await sleep(250);
    check('Clicking away keeps a colour from the palette', (await mat0('m.color')) === '#c68a62', await mat0('m.color'));
    check('The colour goes in the recent list', await js(`return T.panels.colorStore.recent[0]==='#c68a62'`));
    await js(`T.runCommand('edit.undo')`);
    await sleep(150);
    check('Picking a colour is one undo step', (await mat0('m.color')) === '#808080', await mat0('m.color'));

    // Palette swatches and your own palettes.
    await click(await centerOf(`document.querySelector('.dock .palette-chip[data-swatch="#a56c47"]')`));
    await sleep(200);
    check('A palette swatch in the panel sets the colour', (await mat0('m.color')) === '#a56c47');
    await click(await centerOf(`document.querySelector('.dock .palette-head .cp-mini')`));
    await sleep(200);
    check('Saving a colour starts a palette of your own', await js(`const c=T.panels.colorStore;return c.active==='My colours'&&c.current().colors[0]==='#a56c47'&&JSON.parse(localStorage.getItem('thickshake.palettes'))[0].name==='My colours'`));
    const made = await js(`const px=new Uint8ClampedArray(400);for(let i=0;i<100;i++){const a=i<70;px[i*4]=a?255:0;px[i*4+1]=0;px[i*4+2]=a?0:255;px[i*4+3]=255;}T.panels.makePaletteFromPixels(px,'Flag');const c=T.panels.colorStore;return {n:c.active,cols:c.current().colors}`);
    check('A palette can come from an image, main colour first', made.n === 'Flag' && made.cols.length === 2 && parseInt(made.cols[0].slice(1, 3), 16) > 220, JSON.stringify(made));
    await sleep(150);
    await click(await centerOf(`[...document.querySelectorAll('.dock .palette-tools button')].find(b=>b.textContent.trim()==='Delete')`));
    await sleep(150);
    check('Your palette can be deleted', await js(`return !T.panels.colorStore.isCustom('Flag')&&T.panels.colorStore.isCustom('My colours')`));
    await js(`const c=T.panels.colorStore;c.deletePalette('My colours');c.setActive('Skin tones');T.panels.refreshDock();`);

    // Gradients: added from the panel, and seen on the model by its colours.
    await js(`ed.transact('c',d=>{d.materials[0].unlit=true;});ed.clearSelection();ed.emit('selection');const p=vp.panes.find(x=>x.kind==='front');vp.setLayout('single',p);p.shading='pbr';p.frame([0,0,0],1);`);
    await sleep(250);
    await click(await dockBtn('Add gradient'));
    await sleep(300);
    check('Add Gradient bakes a base colour map', await mat0(`!!m.gradient&&m.maps.base!==undefined&&m.color==='#ffffff'&&m.gradient.stops.length===2`));
    await click(await centerOf(`document.querySelector('.dock .grad-preset[data-gradient="Shadow"]')`));
    await sleep(300);
    check('A gradient preset sets the colours', await mat0(`m.gradient.stops[0].color==='#1a1a22'&&m.gradient.stops[1].color==='#ffffff'`));
    const zf = await js(`return Math.max(...ed.model.verts.map(v=>v.p[2]))`);
    const yf = await js(`return Math.max(...ed.model.verts.map(v=>v.p[1]))`);
    const xf = await js(`return Math.max(...ed.model.verts.map(v=>v.p[0]))`);
    const lumAt = (x, y) => js(`const p=vp.panes.find(q=>q.kind==='front');vp.renderNow();const s=p.project(${x},${y},${zf});const r=vp.sg.renderer;const gl=r.getContext();const dpr=r.getPixelRatio();const o=new Uint8Array(4);gl.readPixels(Math.round(s.x*dpr),Math.round((vp.gl.clientHeight-s.y)*dpr),1,1,gl.RGBA,gl.UNSIGNED_BYTE,o);return o[0]`);
    const upTop = await lumAt(0, yf * 0.8), upBot = await lumAt(0, -yf * 0.8);
    check('An upward gradient is bright at the top of the model', upTop > upBot + 80, `${upTop} over ${upBot}`);
    await click(await centerOf(`document.querySelector('.dock .dir-btn[data-angle="180"]')`));
    let dnTop = 0, dnBot = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      dnTop = await lumAt(0, yf * 0.8); dnBot = await lumAt(0, -yf * 0.8);
      if (dnBot > dnTop + 80) break;
    }
    check('The Downward button flips it', dnBot > dnTop + 80, `${dnBot} over ${dnTop}`);
    await click(await centerOf(`document.querySelector('.dock .dir-btn[data-angle="90"]')`));
    // The new map decodes in the background, so wait for it to reach the screen.
    let rtR = 0, rtL = 0;
    for (let i = 0; i < 30; i++) {
      await sleep(100);
      rtR = await lumAt(xf * 0.8, 0); rtL = await lumAt(-xf * 0.8, 0);
      if (rtR > rtL + 80) break;
    }
    check('The To The Right button runs it across, as seen from the front', rtR > rtL + 80, `${rtR} over ${rtL}`);
    await shot('gradient-panel');
    await click(await centerOf(`document.querySelector('.dock .dir-btn[data-angle="0"]')`));
    await sleep(300);

    // Editing stops with real drags and clicks.
    const texCount = () => js(`return ed.model.textures.length`);
    const texBefore = await texCount();
    const barRect = await js(`const b=document.querySelector('.dock .grad-fill');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {l:r.left,t:r.top,w:r.width,h:r.height}`);
    await click({ x: Math.round(barRect.l + barRect.w / 2), y: Math.round(barRect.t + barRect.h / 2) });
    await sleep(300);
    check('Clicking the bar adds a colour at that spot, and selects it', await mat0(`m.gradient.stops.length===3&&Math.abs(m.gradient.stops[1].at-0.5)<0.03`) && await js(`return document.querySelector('.dock .grad-stop.active').dataset.stop==='1'`));
    const undoAddCheck = await texCount();
    check('Editing a gradient replaces its map instead of piling up', undoAddCheck === texBefore, `${texBefore} then ${undoAddCheck}`);
    const stopAt = await centerOf(`document.querySelector('.dock .grad-stop[data-stop="1"]')`);
    await drag(stopAt, { x: Math.round(barRect.l + barRect.w * 0.8), y: stopAt.y });
    await sleep(350);
    const stopNow = await mat0(`m.gradient.stops[1].at`);
    check('Dragging a marker moves that colour to where the pointer stopped', Math.abs(stopNow - 0.8) < 0.04, String(stopNow));
    check('A dragged gradient still bakes at full size', await js(`const m=ed.model.materials[0];return ed.model.textures.find(t=>t.id===m.maps.base).width===m.gradient.size`));
    await js(`T.runCommand('edit.undo')`);
    await sleep(250);
    check('Undo puts a dragged marker back in one step', Math.abs((await mat0(`m.gradient.stops[1].at`)) - 0.5) < 0.03);
    await click(await centerOf(`document.querySelector('.dock .grad-stop-row .color-btn')`));
    await sleep(200);
    await click(await js(`const r=document.querySelector('.cp-chip[title="#c68a62"]').getBoundingClientRect();return {x:Math.round(r.left+6),y:Math.round(r.top+6)}`));
    await sleep(250);
    await click({ x: 500, y: 300 });
    await sleep(350);
    check('The picker colours the selected marker', await mat0(`m.gradient.stops[1].color==='#c68a62'&&m.gradient.stops.length===3`), await mat0(`JSON.stringify(m.gradient.stops)`));
    await click(await centerOf(`document.querySelector('.dock .palette-chip[data-swatch="#44281a"]')`));
    await sleep(300);
    check('Palette swatches colour the selected marker too', await mat0(`m.gradient.stops[1].color==='#44281a'`));
    await click(await js(`const b=[...document.querySelectorAll('.dock .grad-stop-row button')].find(x=>x.textContent.trim()==='Remove');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`));
    await sleep(300);
    check('A colour can be removed', await mat0(`m.gradient.stops.length===2`));
    check('The last two colours cannot be removed', await js(`return [...document.querySelectorAll('.dock .grad-stop-row button')].find(x=>x.textContent.trim()==='Remove').disabled`));
    await click(await dockBtn('Reverse'));
    await sleep(300);
    check('Reverse swaps the colours', await mat0(`m.gradient.stops[0].color==='#ffffff'`));
    const trip = await js(`const g=T.exportGLB(ed.model,T.defaultExport);const r=await T.importFile('m.glb',g.buffer.slice(g.byteOffset,g.byteOffset+g.byteLength));const a=r.materials[0];const p=T.parseProject(T.serializeProject(ed.model));return {map:a.maps.base!==undefined,tex:r.textures.length,keep:!!p.materials[0].gradient}`);
    check('A gradient exports to GLB as an ordinary texture, and stays editable in a project', trip.map && trip.tex === 1 && trip.keep, JSON.stringify(trip));

    // Images: real files through drop and paste.
    await js(`ed.transact('l',d=>{d.materials[0].unlit=false;});`);
    await sleep(200);
    const png = `const png=async(col)=>{const c=document.createElement('canvas');c.width=8;c.height=8;const x=c.getContext('2d');x.fillStyle=col;x.fillRect(0,0,8,8);const b=await new Promise(r=>c.toBlob(r,'image/png'));return b;};const dt=async(list)=>{const d=new DataTransfer();for(const [n,col] of list)d.items.add(new File([await png(col)],n,{type:'image/png'}));return d;};`;
    await js(`${png}const el=document.querySelector('.dock [data-map-slot="emissive"]');el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:await dt([['anything.png','#ff0000']])}));`);
    await sleep(400);
    check('Dropping an image on a slot fills that slot, whatever its name', await mat0(`m.maps.emissive!==undefined`));
    await js(`ed.transact('x',d=>{delete d.materials[0].maps.emissive;});`);
    await sleep(150);
    await js(`${png}const el=document.querySelector('.dock .drop-hint');el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:await dt([['crate_normal.png','#8080ff'],['crate_rough.png','#808080'],['crate_albedo.png','#c08040']])}));`);
    for (let i = 0; i < 40 && !(await mat0(`m.maps.orm!==undefined`)); i++) await sleep(100);
    await sleep(200);
    const sorted = await js(`const m=ed.model.materials[0];const nm=id=>ed.model.textures.find(t=>t.id===id)?.name;return {b:nm(m.maps.base),n:nm(m.maps.normal),o:m.maps.orm!==undefined,g:!!m.gradient,rough:m.roughness}`);
    check('A dropped texture set sorts itself by file name', sorted.b === 'crate_albedo.png' && sorted.n === 'crate_normal.png' && sorted.o, JSON.stringify(sorted));
    check('A picture replaces the gradient', !sorted.g);
    await js(`T.runCommand('edit.undo')`);
    await sleep(200);
    await js(`ed.loadModel(T.emptyModel(),null,'Drop');T.runCommand('create.box');vp.setLayout('quad');T.setWorkspace('model');T.panels.panelState.tab='material';T.panels.refreshDock();`);
    await sleep(300);
    const onBox = await screen(0, 0, 0, `vp.panes.find(q=>q.kind==='persp')`);
    await js(`${png}const el=document.elementFromPoint(${onBox.x},${onBox.y});el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:${onBox.x},clientY:${onBox.y},dataTransfer:await dt([['Bricks_Color.png','#a04030']])}));`);
    await sleep(500);
    check('Dropping an image on a piece gives that piece a textured material', await js(`const m=ed.model.materials[0];return ed.model.materials.length===1&&m.name==='Bricks'&&m.color==='#ffffff'&&m.maps.base!==undefined&&ed.model.groups[0].material===m.id&&(ed.model.refs??[]).length===0`), await js(`return JSON.stringify(ed.model.materials.map(m=>m.name))`));
    const emptySpot = await js(`const p=vp.panes.find(q=>q.kind==='front');const r=vp.el.getBoundingClientRect();return {x:Math.round(r.left+p.x+12),y:Math.round(r.top+p.y+30)}`);
    await js(`${png}const el=document.elementFromPoint(${emptySpot.x},${emptySpot.y});el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,clientX:${emptySpot.x},clientY:${emptySpot.y},dataTransfer:await dt([['sketch.png','#ffffff']])}));`);
    await sleep(500);
    check('Dropping on empty space still makes a reference image', await js(`return (ed.model.refs??[]).length===1&&ed.model.materials.length===1`));
    const texBeforePaste = await texCount();
    await js(`${png}const d=await dt([['image.png','#00ff00']]);document.body.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));`);
    await sleep(500);
    check('Pasting an image loads it into the material', (await texCount()) === texBeforePaste + 1 && await js(`const m=ed.model.materials[0];return ed.model.textures.find(t=>t.id===m.maps.base).name==='Pasted image.png'`));
    await js(`const c=T.panels.colorStore;c.custom=[];c.recent=[];c.setActive('Skin tones');localStorage.removeItem('thickshake.palettes');localStorage.removeItem('thickshake.recentColors');ed.loadModel(T.emptyModel(),null,'After colours');T.runCommand('create.box');T.runCommand('workspace.model');T.runCommand('tool.select');T.panels.panelState.tab='scene';T.panels.refreshDock();`);
    await sleep(200);
    }

    // Viewport dividers.
    await js(`T.setWorkspace('model');localStorage.removeItem('thickshake.viewports');vp.splitX=vp.splitY=0.5;vp.setLayout('quad');`);
    await sleep(200);
    const paneSize = (i) => js(`const p=vp.panes[${i}];return {w:Math.round(p.w),h:Math.round(p.h),x:Math.round(p.x),y:Math.round(p.y)}`);
    const splitAt = (cls) => js(`const r=document.querySelector('.${cls}').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    let p0 = await paneSize(0);
    let sp = await splitAt('splitter-v');
    await drag(sp, { x: sp.x + 120, y: sp.y });
    await sleep(120);
    let p1 = await paneSize(0);
    check('The vertical divider resizes the viewports', Math.abs(p1.w - p0.w - 120) <= 3 && p1.h === p0.h, JSON.stringify([p0, p1]));
    sp = await splitAt('splitter-h');
    await drag(sp, { x: sp.x, y: sp.y - 90 });
    await sleep(120);
    p1 = await paneSize(0);
    check('The horizontal divider resizes the viewports', Math.abs(p1.h - p0.h + 90) <= 3, JSON.stringify([p0, p1]));
    sp = await splitAt('splitter-c');
    const beforeCross = await paneSize(3);
    await drag(sp, { x: sp.x - 60, y: sp.y + 40 });
    await sleep(120);
    const afterCross = await paneSize(3);
    check('The centre handle resizes both ways at once', Math.abs(afterCross.w - beforeCross.w - 60) <= 3 && Math.abs(afterCross.h - beforeCross.h + 40) <= 3, JSON.stringify([beforeCross, afterCross]));
    await shot('13j-viewports-resized');
    check('The layout of the viewports is remembered', await js(`return !!JSON.parse(localStorage.getItem('thickshake.viewports')||'null')`));
    sp = await splitAt('splitter-c');
    send({ type: 'mouseMove', x: sp.x, y: sp.y });
    await sleep(40);
    send({ type: 'mouseDown', x: sp.x, y: sp.y, button: 'left', clickCount: 2 });
    send({ type: 'mouseUp', x: sp.x, y: sp.y, button: 'left', clickCount: 2 });
    await sleep(200);
    check('Double-clicking a viewport divider resets it', await js(`return vp.splitX===0.5&&vp.splitY===0.5`));
    await js(`localStorage.removeItem('thickshake.viewports');`);

    // Ctrl+R must reach the app, not reload the window.
    await js(`window.__noReload=true;T.runCommand('tool.select')`);
    send({ type: 'keyDown', keyCode: 'R', modifiers: ['control'] }); send({ type: 'keyUp', keyCode: 'R', modifiers: ['control'] });
    await sleep(400);
    check('Ctrl+R picks Loop Cut instead of reloading', await js(`return window.__noReload===true&&ed.tool==='loopcut'`));
    await js(`T.runCommand('tool.select')`);

    await js(`T.runCommand('help.palette');const i=document.querySelector('.palette-input');i.value='extru';i.dispatchEvent(new Event('input'));`);
    await shot('14-palette');
    check('Palette finds commands', await js(`return document.querySelectorAll('.palette-item').length>0&&document.querySelector('.palette-item').textContent.includes('Extrude')`));
    await js(`document.querySelector('.palette-back').remove();`);

    await js(`T.runCommand('file.export')`);
    await shot('15-export');
    await js(`document.querySelector('.modal-back').querySelector('footer button').click();`);
    await sleep(100);

    // Menu opens with a real click.
    const mb = await js(`const b=[...document.querySelectorAll('.menu-btn')].find(x=>x.textContent==='Mesh');const r=b.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}`);
    await click(mb);
    check('Menu opens', await js(`return !!document.querySelector('.menu')`));
    await shot('16-menu');
    await js(`document.querySelector('.menu')?.remove()`);

    // Every menu command id resolves to a registered command.
    await js(`T.runCommand('help.shortcuts')`);
    await shot('17-shortcuts');
    await js(`document.querySelector('.modal-back footer button').click();`);

    check('No renderer errors logged', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) {
    check(`Scenario crashed: ${e.message}`, false);
    await shot('zz-crash').catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  app.exit(failed.length ? 1 : 0);
});
