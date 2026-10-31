(function () {
  'use strict';
  const { Sim, FIELD, ROBOT, MAT, DOCK_MODELS, DT, MATCH_TIME, PORTS, grabAction, releaseAction, WHEELS, MOTORS, ATTACHMENTS, BUILD_DEFAULT, START, MAX_HEIGHT, ROBOT_MODELS, JOBS, HUB_PORTS } = window.BioGlow;
  const S = 4; // 2D view pixels per cm

  const EXAMPLE_JS = `// Example: M03 flip the rock (and put it back), M13 deliver the keystone species (the young
// trees rise when it lands), then M02 knock the seeds off the stalk.
// The robot starts in the left launch area facing east (heading 90).

await robot.grab();            // close the basket on the keystone species
await robot.drive(20);         // out of the launch area
await robot.turnTo(0);         // face north
await robot.drive(48.3);       // level with the rock

// M03: the keystone in the basket pushes the rock's lever. Push once to flip the rock
// (research flag down), back off, and push again to put the rock back.
await robot.turnTo(270);       // face west
await robot.drive(8, 30);
await robot.drive(-4, 30);
await robot.drive(4.5, 30);
await robot.drive(-8.5);

// M13: across to the restoration platform on the farm dock, north of the seed pod's tubes.
await robot.turnTo(0);         // face north
await robot.drive(3.9);
await robot.turnTo(90);        // face east
await robot.drive(40, 40);     // up against the restoration platform (it stops there)
await robot.release();         // the keystone stays on it and the young trees rise
await robot.drive(-8);

// M02: back to the seed pod. With the basket open, its arms knock the three hanging seeds
// off the stalk's tubes.
await robot.turnTo(270);       // face west
await robot.drive(25.6);
await robot.turnTo(180);       // face south
await robot.drive(32.8);
await robot.turnTo(90);
await robot.drive(5.9);
await robot.turnTo(45);        // square on to the seed pod
await robot.drive(6.6, 30);
await robot.drive(-6.6);
robot.log('Done at', robot.time(), 's');
`;

  const $ = (id) => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };
  const canvas = $('mat');
  const ctx = canvas.getContext('2d');
  const codeEl = $('code');
  const consoleEl = $('console');
  const statusEl = $('status');

  const sim = new Sim();
  let speed = 1;

  // ---- mat artwork -----------------------------------------------------------
  // Paints the mat (only the mat, not the table) into a w x h canvas.
  let matImg = null;
  function paintMatArt(c, w, h) {
    if (matImg) { c.drawImage(matImg, 0, 0, w, h); return; }
    const k = w / MAT.rect.w;
    const P = ([x, y]) => [(x - MAT.rect.x) * k, (y - MAT.rect.y) * k];
    c.fillStyle = '#5aa14f'; c.fillRect(0, 0, w, h);
    for (const l of MAT.launch) {
      const [x, y] = P([l.cx, l.cy]);
      c.beginPath(); c.arc(x, y, l.r * k, 0, Math.PI * 2);
      c.fillStyle = '#f5f5f5'; c.fill(); c.lineWidth = k; c.strokeStyle = l.color; c.stroke();
    }
    c.strokeStyle = '#111'; c.lineWidth = 2 * k; c.lineCap = c.lineJoin = 'round';
    for (const line of MAT.lines) {
      c.beginPath();
      line.forEach((p, i) => (i ? c.lineTo(...P(p)) : c.moveTo(...P(p))));
      c.stroke();
    }
  }

  function loadMatArt(done) {
    if (!window.BIOGLOW_MAT_IMAGE) { done(); return; }
    const img = new Image();
    img.onload = () => {
      matImg = img;
      // hand the pixels to the colour sensor
      const c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      sim.setMatPixels(g.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
      done();
    };
    img.onerror = () => done();
    img.src = window.BIOGLOW_MAT_IMAGE;
  }

  // ---- console -------------------------------------------------------------
  function print(msg, t, cls) {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = '<span class="t">[' + (t || 0).toFixed(1) + 's]</span> ';
    d.appendChild(document.createTextNode(msg));
    consoleEl.appendChild(d);
    if (cls === 'err' && !/^(code|split)$/.test(document.getElementById('main').dataset.tab)) document.querySelector('#tabs [data-tab=code]').classList.add('alert');
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  sim.onLog = (msg, t) => print(msg, t);

  // ---- hub: 5x5 light matrix, center button light, buttons, speaker ---------------
  const matrixEl = $('matrix');
  for (let i = 0; i < 25; i++) matrixEl.appendChild(document.createElement('i'));
  const CENTER_COLOURS = { white: '#ffffff', red: '#ff3b3b', orange: '#ff9a2e', yellow: '#ffe14d', green: '#3ddc5a', azure: '#5ad1ff', blue: '#2f6dff', violet: '#9a6bff', magenta: '#ff4fd8', off: '#2a2f35' };
  let lastPixels = '';
  function drawHub() {
    const px = sim.hubPixels();
    const key = px.join(',') + sim.hub.center;
    if (key === lastPixels) return;
    lastPixels = key;
    [...matrixEl.children].forEach((el, i) => {
      el.style.opacity = px[i] ? 0.35 + 0.65 * (px[i] / 100) : 1;
      el.classList.toggle('on', px[i] > 0);
    });
    $('centerbtn').style.background = CENTER_COLOURS[sim.hub.center] || CENTER_COLOURS.white;
  }
  sim.onHub = () => { lastPixels = ''; };
  for (const which of ['left', 'right']) {
    const btn = $('hub' + which);
    const set = (down) => (e) => { e.preventDefault(); sim.buttons[which] = down; btn.classList.toggle('down', down); };
    btn.addEventListener('pointerdown', set(true));
    btn.addEventListener('pointerup', set(false));
    btn.addEventListener('pointerleave', set(false));
  }

  let audio = null, osc = null, oscTimer = null;
  sim.onSound = (freq, secs) => {
    try {
      if (osc) { osc.stop(); osc = null; }
      clearTimeout(oscTimer);
      if (!freq) return;
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const gain = audio.createGain();
      gain.gain.value = 0.08 * (sim.hub.volume / 100);
      osc = audio.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(gain).connect(audio.destination);
      osc.start();
      const o = osc;
      oscTimer = setTimeout(() => { o.stop(); if (osc === o) osc = null; }, Math.min(secs, 30) * 1000 / Math.max(speed, 0.5));
    } catch (e) { /* audio unavailable */ }
  };

  // ---- code editors: blocks (default) or JavaScript --------------------------
  let blocks = null;
  let mode = 'blocks';
  const genEl = $('gencode');

  function showGenerated() {
    if (!blocks) return;
    const code = blocks.getCode();
    genEl.textContent = code === null ? '// Add a "when program starts" block to begin.' : code;
  }

  function setMode(m) {
    mode = blocks ? m : 'js';
    $('blockly').hidden = mode !== 'blocks';
    $('genwrap').hidden = mode !== 'blocks';
    codeEl.hidden = mode !== 'js';
    for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.mode === mode);
    store.set('bioglow3-mode', mode);
    if (mode === 'blocks') window.dispatchEvent(new Event('resize'));
  }

  function initEditors() {
    // Start with an empty program; "Load example" brings in the example. A saved copy of the
    // example that was never changed (from when the example loaded by default) is dropped too.
    const savedJs = store.get('bioglow2-code');
    codeEl.value = savedJs && savedJs !== EXAMPLE_JS ? savedJs : '';
    codeEl.addEventListener('input', () => store.set('bioglow2-code', codeEl.value));
    codeEl.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = codeEl.selectionStart;
        codeEl.setRangeText('  ', s, codeEl.selectionEnd, 'end');
        codeEl.dispatchEvent(new Event('input'));
      }
    });

    if (window.BioGlowBlocks) {
      try {
        blocks = window.BioGlowBlocks.inject($('blockly'), () => {
          store.set('bioglow3-blocks', JSON.stringify(blocks.save()));
          showGenerated();
        }, window.BioGlowLook.current);
        window.BioGlowLook.onChange((look) => blocks.setLook(look));
        // compare programs without Blockly's random ids, where the stacks sit, or comment bubbles
        const shape = (json) => JSON.stringify(json, (k, v) => (['id', 'x', 'y', 'icons'].includes(k) ? undefined : v));
        blocks.loadExample();
        const untouchedExample = shape(blocks.save());
        const saved = store.get('bioglow3-blocks');
        try {
          if (saved && shape(JSON.parse(saved)) !== untouchedExample) blocks.load(JSON.parse(saved));
          else blocks.loadEmpty();
        } catch (e) { blocks.loadEmpty(); }
        store.set('bioglow3-blocks', JSON.stringify(blocks.save()));
        showGenerated();
      } catch (e) {
        console.warn('Block editor unavailable:', e);
        blocks = null;
      }
    }
    for (const b of document.querySelectorAll('#modes button')) {
      if (b.dataset.mode === 'blocks' && !blocks) b.hidden = true;
      b.onclick = () => setMode(b.dataset.mode);
    }
    if (!blocks) print('Block editor needs an internet connection to load Blockly - using JavaScript.', 0, 'err');
    setMode(store.get('bioglow3-mode') || 'blocks');
  }

  // ---- controls ------------------------------------------------------------
  // A match is 2:30 of real time. The first Run starts it; after that the robot can be launched again
  // from home as often as there is time, like at a tournament. Reset starts a new match.
  function programSource() {
    const src = mode === 'blocks' ? blocks.getCode() : codeEl.value;
    if (src === null) print('Add an Events block such as "when program starts" and attach your blocks under it.', 0, 'err');
    return src;
  }
  function runCode(fresh) {
    const src = programSource();
    if (src === null) return;
    const inMatch = !fresh && sim.started && !sim.over;
    if (inMatch && sim.codeRunning) { print('The robot is still running. Stop it or pick it up first.', sim.t, 'err'); return; }
    if (inMatch && !sim.inHome()) { print('The robot is outside home. Pick it up first (the referee takes a precision token), then press Run.', sim.t, 'err'); return; }
    if (inMatch) { sim.pickUp(); print('Launch from the ' + (sim.launchAreaOf() || 'launch') + ' launch area.', sim.t); }
    else { sim.reset(); consoleEl.innerHTML = ''; }
    if (real) real.onRun(!inMatch, src);
    sim.runCode(
      src,
      () => print('Program finished. Pick the robot up and Run again while there is time, or press End to score the match.', sim.t),
      (e) => print('Error: ' + (e && e.message ? e.message : e), sim.t, 'err')
    );
  }
  $('run').onclick = () => { if (mainEl.dataset.tab !== 'split') setTab('field'); runCode(false); };
  $('pickup').onclick = () => {
    if (sim.over) return;
    const outside = sim.started && !sim.inHome();
    sim.pickUp();
    print(outside ? 'The robot is back in the launch area.' : 'Picked up in home (free). The robot is back in its launch spot.', sim.t);
  };
  $('stop').onclick = () => { sim.stopCode(); print('Stopped.', sim.t); };
  $('reset').onclick = () => { sim.reset(); consoleEl.innerHTML = ''; };
  $('end').onclick = () => sim.finish();
  $('speed').onchange = (e) => { speed = parseFloat(e.target.value); };
  $('example').onclick = () => {
    if (mode === 'blocks') { blocks.loadExample(); store.set('bioglow-spike-ports', '{}'); store.set('bioglow-project-name', ''); syncSpikePorts(); }
    else { codeEl.value = EXAMPLE_JS; store.set('bioglow2-code', EXAMPLE_JS); }
  };
  $('file').onchange = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    if (/\.llsp3$/i.test(f.name)) {
      reader.onload = () => openSpikeProject(reader.result, f.name);
      reader.readAsArrayBuffer(f);
      e.target.value = '';
      return;
    }
    reader.onload = () => {
      const text = String(reader.result);
      if (/\.json$/i.test(f.name) && blocks) {
        try { blocks.load(JSON.parse(text)); setMode('blocks'); } catch (err) { print('Could not read block file: ' + err.message, 0, 'err'); }
      } else {
        codeEl.value = text; store.set('bioglow2-code', text); setMode('js');
      }
    };
    reader.readAsText(f);
    e.target.value = '';
  };

  // ---- SPIKE App project files (.llsp3) ----------------------------------------
  const bannerEl = $('spikeBanner');
  function showBanner(html, notes) {
    bannerEl.innerHTML = '<button class="close" title="Hide">Close</button>' + html;
    if (notes && notes.length) {
      const ul = document.createElement('ul');
      for (const n of notes) { const li = document.createElement('li'); li.textContent = n; ul.appendChild(li); }
      bannerEl.appendChild(ul);
    }
    bannerEl.hidden = false;
    bannerEl.querySelector('.close').onclick = () => { bannerEl.hidden = true; };
  }
  async function openSpikeProject(data, fileName) {
    if (!window.SpikeFile || !blocks) { print('Opening SPIKE App files needs the block editor, which did not load.', 0, 'err'); return; }
    try {
      const { json, warnings, name, ports } = await SpikeFile.importLlsp3(data, sim.build.ports);
      blocks.load(json);
      store.set('bioglow-spike-ports', JSON.stringify(ports || {}));
      syncSpikePorts();
      setMode('blocks');
      store.set('bioglow3-blocks', JSON.stringify(blocks.save()));
      if (name) store.set('bioglow-project-name', name);
      showBanner('<b>Opened “' + escapeHtml(name || fileName) + '” from the SPIKE App.</b>' +
        (warnings.length ? ' A few things are different in the simulator:' : ' Every block came across.'), warnings);
    } catch (err) {
      print('Could not open ' + fileName + ': ' + err.message, 0, 'err');
    }
  }
  // A program opened from the SPIKE App keeps its team's wiring when it is saved back (Setup tab).
  function spikePorts() {
    try { return JSON.parse(store.get('bioglow-spike-ports') || '{}') || {}; } catch (e) { return {}; }
  }
  function syncSpikePorts() {
    const ports = spikePorts();
    const changed = Object.entries(ports);
    $('spikePortsRow').hidden = !changed.length;
    if (changed.length) {
      $('spikePortsNote').textContent = 'The opened program uses ' + changed.map(([our, their]) => their + ' for the simulator\u2019s ' + our).join(', ');
      $('spikePorts').value = store.get('bioglow-spike-ports-mode') || 'file';
    }
  }
  $('spikePorts').onchange = (e) => store.set('bioglow-spike-ports-mode', e.target.value);
  syncSpikePorts();
  const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  $('exportSpike').onclick = async () => {
    if (!window.SpikeFile || !blocks) { print('Saving for the SPIKE App needs the block editor, which did not load.', 0, 'err'); return; }
    if (mode !== 'blocks') { showBanner('<b>The SPIKE App opens word-block programs.</b> Switch to Blocks to save your program for it.'); return; }
    const name = store.get('bioglow-project-name') || 'BIOGLOW robot';
    try {
      const ports = $('spikePortsRow').hidden || $('spikePorts').value === 'sim' ? {} : spikePorts();
      const { blob, name: saved, warnings } = await SpikeFile.exportLlsp3(blocks.save(), name, ports);
      const portNote = Object.keys(ports).length ? ' It uses the opened program\u2019s own ports (change this in Setup).' : '';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = saved + '.llsp3';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      showBanner('<b>Saved “' + escapeHtml(saved) + '.llsp3” to your Downloads folder.</b> To open it on the real robot:' +
        '<ol><li>Click <b>Open SPIKE App</b>, choose <b>Launch Web App</b> and <b>SPIKE Prime</b> (or start the SPIKE App on your computer).</li>' +
        '<li>Use the app’s <b>Open</b> option (in its File menu) and pick the .llsp3 file from Downloads. If it asks about saving changes, say yes.</li>' +
        (portNote ? '<li>Connect the hub and press Run.' + portNote + '</li></ol>' :
          '<li>Connect the hub and press Run. Wire the robot like the simulator: drive motors on A (left) and B (right), basket motor on C, color sensor on E, distance sensor on F.</li></ol>') +
        (warnings.length ? 'A few blocks were saved a little differently:' : ''), warnings);
    } catch (err) {
      print('Could not save for the SPIKE App: ' + err.message, 0, 'err');
    }
  };

  $('save').onclick = () => {
    const isBlocks = mode === 'blocks';
    const body = isBlocks ? JSON.stringify(blocks.save(), null, 2) : codeEl.value;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: isBlocks ? 'application/json' : 'text/javascript' }));
    a.download = isBlocks ? 'robot-program.json' : 'robot-code.js';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Tab bar across the top: pick what fills the window (field, code, both, score, robot, setup, help)
  const mainEl = $('main');
  const tabBtns = document.querySelectorAll('#tabs button');
  function setTab(t) {
    if (![...tabBtns].some((b) => b.dataset.tab === t)) t = 'split';
    mainEl.dataset.tab = t;
    for (const b of tabBtns) b.classList.toggle('on', b.dataset.tab === t);
    if (t === 'code' || t === 'split') document.querySelector('#tabs [data-tab=code]').classList.remove('alert');
    store.set('bioglow-tab', t);
    window.dispatchEvent(new Event('resize'));
  }
  for (const b of tabBtns) b.onclick = () => setTab(b.dataset.tab);
  setTab(store.get('bioglow-tab') || 'split');

  // Header bar: fullscreen
  $('fullscreen').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
  };

  // ---- robot builder (Robot tab) -----------------------------------------------
  const builderFields = { bModel: 'model', bWheel: 'wheel', bMotor: 'motor', bTrack: 'track', bLength: 'length', bWidth: 'width', bHeight: 'height', bMass: 'mass', bSensorAhead: 'sensorAhead', bSensorSide: 'sensorSide', bAttach: 'attachment' };
  const fillSelect = (el, entries) => { el.innerHTML = ''; for (const [v, label] of entries) { const o = document.createElement('option'); o.value = v; o.textContent = label; el.appendChild(o); } };
  fillSelect($('bWheel'), Object.entries(WHEELS).map(([k, w]) => [k, w.label]));
  fillSelect($('bMotor'), Object.entries(MOTORS).map(([k, m]) => [k, m.label]));
  // attachments made from photos are kept in this browser
  let photoAttachments = [];
  try { photoAttachments = JSON.parse(store.get('bioglow-attachments') || '[]').filter((d) => window.BioGlow.registerAttachment(d)); } catch (e) { photoAttachments = []; }
  // the robot made from photos is kept in this browser too (before the saved build is loaded, which may use it)
  let robotLook = null;
  try { robotLook = JSON.parse(store.get('bioglow-robot-look') || 'null'); if (robotLook && !window.BioGlow.setRobotLook(robotLook)) robotLook = null; } catch (e) { robotLook = null; }
  function fillAttachments() { fillSelect($('bAttach'), Object.entries(ATTACHMENTS).map(([k, a]) => [k, a.label + (a.custom ? ' (from photos)' : '')])); }
  fillAttachments();
  // the robot can be picked on the Robot tab, on Setup and beside the field; they all drive the Robot tab's menu
  for (const sel of document.querySelectorAll('#bModel, .model-pick')) fillSelect(sel, Object.entries(ROBOT_MODELS).map(([k, m]) => [k, m.label]));
  for (const sel of document.querySelectorAll('.model-pick')) sel.addEventListener('change', () => { $('bModel').value = sel.value; $('bModel').dispatchEvent(new Event('change')); });
  // what each job does, for the Ports list
  const jobNotes = (b) => ({
    left: 'movement motor', right: 'movement motor',
    arm: { basket: '\u21bb 90\u00b0 closes the basket gate, \u21ba opens it', hook: '\u21bb 90\u00b0 closes the hook, \u21ba lets go', pusher: 'not used by the pusher', lifter: '\u21bb lifts the fork (up to 75\u00b0), \u21ba lowers it' }[b.attachment] || swingNote(b, 'arm'),
    spare: swingNote(b, 'spare') || 'nothing attached',
    color: 'looking down at the mat, ' + b.sensorAhead + ' cm ahead of the wheels',
    color2: 'looking down at the mat, beside the first one',
    distance: 'facing forward, 4\u2013200 cm, 20 readings a second',
    none: 'nothing plugged in',
  });
  function swingNote(b, job) { // a photo attachment on this motor
    const a = ATTACHMENTS[b.attachment], sw = ROBOT.swing;
    if (!a || !a.custom) return '';
    if (a.custom.mount !== job) return job === 'arm' ? 'not used (' + a.label + (a.custom.mount === 'fixed' ? ' is fixed to the front)' : ' is on the spare motor)') : '';
    const up = (a.custom.dir || 1) > 0 ? '\u21bb' : '\u21ba';
    return up + ' lifts ' + a.label + (sw && sw.range ? ' (it can turn ' + Math.round(sw.range[0]) + '\u00b0 to ' + Math.round(sw.range[1]) + '\u00b0 before it hits the mat or the robot)' : '');
  }
  const jobShort = { left: 'drive', right: 'drive', arm: 'attachment', spare: 'spare', color: 'color', color2: 'color', distance: 'distance' };
  function showPorts(b) {
    const fixed = !!ROBOT_MODELS[b.model].build, notes = jobNotes(b);
    $('portsNote').textContent = fixed ? 'Wired as in the building instructions. Programs use these port letters, just like on the real hub.'
      : 'Choose what is plugged into each port. Programs use these port letters, just like on the real hub.';
    const list = $('portsList');
    list.innerHTML = '';
    for (const port of HUB_PORTS) {
      const job = b.ports[port];
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('span');
      name.innerHTML = '<b class="port"></b> ';
      name.firstChild.textContent = port;
      if (fixed) name.appendChild(document.createTextNode(JOBS[job] ? JOBS[job].label.replace(/^./, (c) => c.toUpperCase()) : 'Nothing'));
      else {
        const sel = document.createElement('select');
        fillSelect(sel, [['none', 'Nothing']].concat(Object.entries(JOBS).map(([k, j]) => [k, j.label.replace(/^./, (c) => c.toUpperCase())])));
        sel.value = JOBS[job] ? job : 'none';
        sel.onchange = () => { // a job moves to this port (whatever had it before is unplugged)
          const ports = { ...sim.build.ports };
          for (const p of HUB_PORTS) if (ports[p] === sel.value) ports[p] = 'none';
          ports[port] = sel.value;
          sim.setBuild({ ...sim.build, ports });
          if (sim.build.ports[port] !== sel.value) print('A robot needs a left and a right drive motor, so the wiring went back to the standard one.', 0, 'err');
          store.set('bioglow-build', JSON.stringify(sim.build));
          showBuild();
        };
        name.appendChild(sel);
      }
      const what = document.createElement('span'); what.textContent = notes[JOBS[job] ? job : 'none'];
      row.append(name, what);
      list.appendChild(row);
    }
    const hint = HUB_PORTS.filter((p) => JOBS[b.ports[p]]).map((p) => p + ' ' + jobShort[b.ports[p]]).join(' \u00b7 ');
    $('hubPorts').textContent = hint;
    $('hubBox').title = 'Hub: light matrix and center button. Ports: ' + HUB_PORTS.map((p) => p + ' ' + PORTS[p]).join(', ');
  }
  function showBuild() {
    const b = sim.build;
    for (const [id, key] of Object.entries(builderFields)) $(id).value = String(b[key]);
    $('bAttachAbout').textContent = ATTACHMENTS[b.attachment].about;
    if (typeof showPhotoAttachments === 'function') showPhotoAttachments();
    if (typeof showRobotLook === 'function') showRobotLook();
    $('bModelAbout').textContent = ROBOT_MODELS[b.model].about;
    for (const sel of document.querySelectorAll('.model-pick')) sel.value = b.model;
    const fixed = !!ROBOT_MODELS[b.model].build;
    const choices = ROBOT_MODELS[b.model].choices || [];
    for (const [id, key] of Object.entries(builderFields)) if (id !== 'bModel' && id !== 'bAttach') $(id).disabled = fixed && !choices.includes(key);
    $('bSensorName').firstChild.textContent = ROBOT.color2 ? 'Color sensors' : 'Color sensor';
    showPorts(b);
    showFaults();
    const travel = Math.PI * ROBOT.wheel.diameter;
    const insp = sim.inspection();
    const rows = [
      ['Top speed', 'speed 100%', 'about ' + Math.round(ROBOT.maxSpeed) + ' cm/s'],
      ['1 motor rotation', 'set this in your program: "set 1 motor rotation to ' + travel.toFixed(1) + ' cm"', travel.toFixed(1) + ' cm of travel'],
      ['Turning', 'motor degrees for a 90\u00b0 turn on the spot', Math.round((ROBOT.wheelBase / ROBOT.wheel.diameter) * 90) + '\u00b0'],
      ['Size with attachment', 'length \u00d7 width \u00d7 height', (ROBOT.length + ROBOT.basket).toFixed(1) + ' \u00d7 ' + ROBOT.width.toFixed(1) + ' \u00d7 ' + ROBOT.height + ' cm'],
      ['Equipment inspection', 'fits in a launch area, under ' + MAX_HEIGHT + ' cm', insp.ok ? '\u2713 passes' : '\u2717 ' + insp.why],
    ];
    $('specs').innerHTML = '';
    for (const [name, sub, value] of rows) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = '<span></span><span></span>';
      row.firstChild.textContent = name;
      const small = document.createElement('small'); small.textContent = sub; row.firstChild.appendChild(small);
      row.lastChild.textContent = value;
      if (name === 'Equipment inspection' && !insp.ok) row.lastChild.className = 'bad';
      $('specs').appendChild(row);
    }
    showLaunch();
  }
  function readBuild() {
    const b = {};
    for (const [id, key] of Object.entries(builderFields)) b[key] = ['model', 'wheel', 'motor', 'attachment'].includes(key) ? $(id).value : Number($(id).value);
    b.wheel = Number(b.wheel);
    b.ports = sim.build.ports; // leaving an official robot, your own starts from its measurements and wiring
    b.look = b.model === sim.build.model && sim.build.look; // picking another robot shows that robot, not your photos
    if (b.model !== sim.build.model && ROBOT_MODELS[b.model].build) delete b.motor; // a newly picked robot starts with its own motors
    return b;
  }
  // ---- failure testing (Robot tab): parts switched off or working badly -------------------
  const FAULT_ROWS = [ // [part, setting, label, about, unit, step]
    ['left', 'power', 'Left drive motor', 'Strength; off = no power, the wheel rolls free', '%', 5],
    ['left', 'grip', 'Left wheel grip', 'A worn or dusty tyre slips sooner', '%', 5],
    ['right', 'power', 'Right drive motor', 'Strength; off = no power, the wheel rolls free', '%', 5],
    ['right', 'grip', 'Right wheel grip', 'A worn or dusty tyre slips sooner', '%', 5],
    ['arm', 'power', 'Attachment motor', 'Strength; off = the attachment does not move', '%', 5],
    ['spare', 'power', 'Spare motor', 'Strength; off = it does not move', '%', 5],
    ['color', 'noise', 'Color sensor', 'Extra noise in its readings; off = reads nothing', '\u00b1', 1],
    ['color2', 'noise', 'Second color sensor', 'Extra noise in its readings; off = reads nothing', '\u00b1', 1],
    ['distance', 'noise', 'Distance sensor', 'Extra noise in cm; off = never sees anything', '\u00b1', 1],
    ['gyro', 'drift', 'Gyro (yaw)', 'Extra drift in degrees per second; off = stuck on its last reading', '\u00b0/s', 0.1],
  ];
  const { FAULTS_DEFAULT, FAULT_LIMITS } = window.BioGlow;
  try { sim.setFaults(JSON.parse(store.get('bioglow-faults') || '{}')); } catch (e) { /* keep a working robot */ }
  function saveFaults(f) { sim.setFaults(f); store.set('bioglow-faults', JSON.stringify(sim.faults)); showFaults(); }
  function showFaults() {
    const list = $('faultsList'), f = sim.faults, wired = Object.values(sim.build.ports);
    list.innerHTML = '';
    for (const [part, key, label, about, unit, step] of FAULT_ROWS) {
      if (part !== 'gyro' && !wired.includes(part)) continue; // not fitted to this robot
      const port = HUB_PORTS.find((p) => sim.build.ports[p] === part);
      const off = !f[part].on && key !== 'grip'; // a tyre still grips (or not) with its motor switched off
      const row = document.createElement('div'); row.className = 'row' + (off ? ' off' : '');
      const name = document.createElement('span');
      name.textContent = label + ' ';
      if (port && key !== 'grip') { const b = document.createElement('b'); b.className = 'port'; b.textContent = port; name.appendChild(b); }
      const small = document.createElement('small'); small.textContent = about; name.appendChild(small);
      const end = document.createElement('span'); end.className = 'row-end';
      const [lo, hi] = FAULT_LIMITS[key];
      const slider = document.createElement('input');
      Object.assign(slider, { type: 'range', min: lo, max: hi, step, value: f[part][key] });
      slider.disabled = off;
      const out = document.createElement('output');
      const fmt = (v) => (unit === '%' ? v + '%' : unit === '\u00b1' ? (Number(v) ? '\u00b1' + v : 'none') : (v > 0 ? '+' : '') + Number(v).toFixed(1) + unit);
      out.textContent = fmt(f[part][key]);
      slider.oninput = () => { out.textContent = fmt(slider.value); sim.setFaults({ ...sim.faults, [part]: { ...sim.faults[part], [key]: Number(slider.value) } }); };
      slider.onchange = () => saveFaults(sim.faults);
      end.append(slider, out);
      if (key !== 'grip') { // one on/off switch per part
        const sw = document.createElement('label'); sw.className = 'switch'; sw.title = 'Working';
        sw.innerHTML = '<input type="checkbox"><i></i>';
        sw.firstChild.checked = f[part].on;
        sw.firstChild.onchange = (e) => saveFaults({ ...sim.faults, [part]: { ...sim.faults[part], on: e.target.checked } });
        end.appendChild(sw);
      }
      row.append(name, end);
      list.appendChild(row);
    }
    const repair = document.createElement('div'); repair.className = 'row';
    repair.innerHTML = '<span>Repair everything<small>Back to a robot where every part works properly</small></span><button>Repair all</button>';
    repair.querySelector('button').onclick = () => saveFaults(FAULTS_DEFAULT);
    list.appendChild(repair);
    $('faultBadge').hidden = !sim.faulty;
  }

  for (const id of Object.keys(builderFields)) $(id).addEventListener('change', () => {
    sim.setBuild(readBuild());
    store.set('bioglow-build', JSON.stringify(sim.build));
    showBuild();
  });
  $('bDefault').onclick = () => { sim.setBuild(BUILD_DEFAULT); store.set('bioglow-build', JSON.stringify(sim.build)); showBuild(); };

  // ---- attachments from photos (Robot tab) ------------------------------------------------
  function savePhotoAttachments() {
    const full = JSON.stringify(photoAttachments);
    store.set('bioglow-attachments', full);
    if (store.get('bioglow-attachments') === full) return;
    // no room for the photos: keep the shapes (they can still be used, just not changed)
    store.set('bioglow-attachments', JSON.stringify(photoAttachments.map((d) => ({ ...d, photos: undefined }))));
    print('There is no room left in this browser for the photos, so only the attachments\u2019 shapes are kept.', sim.t, 'err');
  }
  function useAttachment(id) {
    sim.setBuild({ ...sim.build, attachment: id });
    store.set('bioglow-build', JSON.stringify(sim.build));
    showBuild();
  }
  function showPhotoAttachments() {
    const list = $('amSaved');
    list.innerHTML = '';
    for (const def of photoAttachments) {
      const row = document.createElement('div'); row.className = 'row';
      const name = document.createElement('span'); name.textContent = def.name;
      const small = document.createElement('small');
      small.textContent = (def.len ? def.len + ' cm long, ' : '') + (def.mount === 'fixed' ? 'fixed to the front' : 'on motor ' + (def.mount === 'spare' ? 'D' : 'C')) + (sim.build.attachment === def.id ? ' \u00b7 fitted now' : '');
      name.appendChild(small);
      const btns = document.createElement('span'); btns.className = 'row-end';
      const btn = (text, fn, cls) => { const b = document.createElement('button'); b.textContent = text; b.onclick = fn; if (cls) b.className = cls; btns.appendChild(b); };
      if (sim.build.attachment !== def.id) btn('Fit', () => useAttachment(def.id), 'suggested');
      btn('Change', () => maker.open(def));
      btn('Delete', () => {
        if (!confirm('Delete "' + def.name + '"? Its photos go too.')) return;
        photoAttachments = photoAttachments.filter((d) => d.id !== def.id);
        window.BioGlow.unregisterAttachment(def.id);
        savePhotoAttachments();
        fillAttachments();
        if (sim.build.attachment === def.id) useAttachment(BUILD_DEFAULT.attachment); else showBuild();
      });
      row.append(name, btns);
      list.appendChild(row);
    }
  }
  const maker = window.BioGlowMaker ? window.BioGlowMaker.init({
    sim,
    onSave(def) {
      window.BioGlow.unregisterAttachment(def.id);
      if (!window.BioGlow.registerAttachment(def)) { print('That attachment has no solid parts, so it was not saved.', sim.t, 'err'); return; }
      photoAttachments = photoAttachments.filter((d) => d.id !== def.id).concat([def]);
      savePhotoAttachments();
      fillAttachments();
      useAttachment(def.id);
      print('Fitted "' + def.name + '" to the robot' + (def.mount === 'fixed' ? '.' : ': turn motor ' + (def.mount === 'spare' ? 'D' : 'C') + ' in your program to move it.'), sim.t);
    },
  }) : null;

  // ---- the robot from photos (Robot tab) ------------------------------------------------------
  function saveRobotLook() {
    const full = JSON.stringify(robotLook);
    store.set('bioglow-robot-look', full);
    if (store.get('bioglow-robot-look') === full) return;
    store.set('bioglow-robot-look', JSON.stringify({ ...robotLook, photos: undefined }));
    print('There is no room left in this browser for the robot\u2019s photos, so only its shape is kept.', sim.t, 'err');
  }
  // Using the photos makes it your own driving base (keeping the wheels, motors and wiring) at the size
  // measured from them.
  function useRobotLook(on) {
    let b = { ...sim.build, look: on };
    if (on) b = { ...b, model: 'custom', length: robotLook.size.length, width: robotLook.size.width, height: Math.round(robotLook.size.height) };
    sim.setBuild(b);
    store.set('bioglow-build', JSON.stringify(sim.build));
    showBuild();
  }
  function showRobotLook() {
    const list = $('rmSaved');
    list.innerHTML = '';
    list.hidden = !robotLook;
    if (!robotLook) return;
    const row = document.createElement('div'); row.className = 'row';
    const name = document.createElement('span'); name.textContent = robotLook.name;
    const small = document.createElement('small'), z = robotLook.size;
    small.textContent = z.length.toFixed(1) + ' \u00d7 ' + z.width.toFixed(1) + ' \u00d7 ' + z.height.toFixed(1) + ' cm' + (sim.build.look ? ' \u00b7 in use now' : '');
    name.appendChild(small);
    const btns = document.createElement('span'); btns.className = 'row-end';
    const btn = (text, fn, cls) => { const b = document.createElement('button'); b.textContent = text; b.onclick = fn; if (cls) b.className = cls; btns.appendChild(b); };
    if (sim.build.look) btn('Use the standard look', () => useRobotLook(false));
    else btn('Use', () => useRobotLook(true), 'suggested');
    btn('Change', () => robotMaker.open(robotLook));
    btn('Delete', () => {
      if (!confirm('Delete "' + robotLook.name + '"? Its photos go too.')) return;
      robotLook = null;
      window.BioGlow.setRobotLook(null);
      store.set('bioglow-robot-look', 'null');
      useRobotLook(false);
    });
    row.append(name, btns);
    list.appendChild(row);
  }
  const robotMaker = window.BioGlowMaker ? window.BioGlowMaker.initRobot({
    onSave(def) {
      if (!window.BioGlow.setRobotLook(def)) { print('That robot has no solid parts, so it was not saved.', sim.t, 'err'); return; }
      robotLook = def;
      saveRobotLook();
      useRobotLook(true);
      print('The robot now looks like your photos and is ' + sim.build.length + ' \u00d7 ' + sim.build.width + ' \u00d7 ' + sim.build.height + ' cm. Check its wheels and sensor position under Build your robot.', sim.t);
    },
  }) : null;

  // ---- look: colours and highlight colour (Setup tab; applied by the script in <head>) ----
  const Look = window.BioGlowLook;
  $('lookTheme').value = Look.theme;
  $('lookTheme').addEventListener('change', (e) => Look.setTheme(e.target.value));
  for (const [name, [dark]] of Object.entries(Look.ACCENTS)) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.dataset.accent = name; b.title = name[0].toUpperCase() + name.slice(1);
    b.setAttribute('aria-label', b.title); b.style.setProperty('--swatch', dark[0]);
    b.onclick = () => Look.setAccent(name);
    $('lookAccent').append(b);
  }
  const showAccent = () => { for (const b of $('lookAccent').children) b.setAttribute('aria-pressed', b.dataset.accent === Look.accent); };
  showAccent();
  Look.onChange(showAccent);

  // ---- launch position and battery (Setup tab) ---------------------------------------
  const corner = (area) => (area === 'right' ? { x: MAT.launch[1].cx, sign: -1 } : { x: MAT.launch[0].cx, sign: 1 });
  function poseFromForm() {
    const area = $('lArea').value, c = corner(area);
    return { x: c.x + c.sign * Number($('lAlong').value), y: FIELD.h - Number($('lUp').value), h: Number($('lHeading').value) };
  }
  function showLaunch() {
    const p = sim.launch, area = p.x > FIELD.w / 2 ? 'right' : 'left', c = corner(area);
    $('lArea').value = area;
    $('lAlong').value = ((p.x - c.x) * c.sign).toFixed(1);
    $('lUp').value = (FIELD.h - p.y).toFixed(1);
    $('lHeading').value = Math.round(p.h);
    const inside = sim.launchAreaOf(p);
    $('lCheck').textContent = inside ? '\u2713 The robot fits completely inside the ' + inside + ' launch area' : '\u2717 Part of the robot is outside the launch area: move it or turn it';
    $('lCheck').className = inside ? '' : 'bad';
  }
  const standardSpot = (area) => (area === 'right' ? { x: FIELD.w - START.x, y: START.y, h: 270 } : { ...START });
  for (const id of ['lAlong', 'lUp', 'lHeading']) $(id).addEventListener('change', () => { sim.setLaunch(poseFromForm()); store.set('bioglow-launch', JSON.stringify(sim.launch)); showBuild(); });
  $('lArea').addEventListener('change', () => { sim.setLaunch(standardSpot($('lArea').value)); store.set('bioglow-launch', JSON.stringify(sim.launch)); showBuild(); });
  $('lDefault').onclick = () => { sim.setLaunch(standardSpot($('lArea').value)); store.set('bioglow-launch', JSON.stringify(sim.launch)); showBuild(); };
  $('battery').addEventListener('change', (e) => { sim.setBattery(Number(e.target.value)); store.set('bioglow-battery', e.target.value); });
  try {
    const savedBuild = JSON.parse(store.get('bioglow-build') || 'null');
    if (savedBuild) sim.setBuild(savedBuild);
    const savedLaunch = JSON.parse(store.get('bioglow-launch') || 'null');
    if (savedLaunch) sim.setLaunch(savedLaunch);
    const bat = store.get('bioglow-battery');
    if (bat) { sim.setBattery(Number(bat)); $('battery').value = bat; }
  } catch (e) { /* ignore a bad saved robot */ }
  showBuild();

  // Interchangeable model docks (missions 13-15)
  function syncDockSelects() {
    for (const sel of document.querySelectorAll('#docks select')) sel.value = String(sim.docks[sel.dataset.dock]);
  }
  try {
    const saved = JSON.parse(store.get('bioglow2-docks') || 'null');
    if (saved) for (const [dock, m] of Object.entries(saved)) sim.setDock(dock, m);
  } catch (e) { /* ignore bad saved docks */ }
  for (const sel of document.querySelectorAll('#docks select')) {
    sel.innerHTML = Object.entries(DOCK_MODELS).map(([m, d]) => '<option value="' + m + '">M' + m + ' ' + d.name + '</option>').join('');
    sel.onchange = () => {
      if (sim.codeRunning) { syncDockSelects(); return; }
      sim.setDock(sel.dataset.dock, Number(sel.value));
      sim.reset();
      syncDockSelects();

  // Real-world variation: wheel size, motor strength, gyro drift, mat grip, placement, sensor noise
  const varEl = $('variation'), seedEl = $('seed');
  function applyVariation() {
    if (sim.codeRunning) return;
    sim.setVariation(varEl.checked, Math.max(1, parseInt(seedEl.value, 10) || 1));
    seedEl.disabled = !varEl.checked; $('reroll').disabled = !varEl.checked;
    store.set('bioglow2-variation', JSON.stringify({ on: varEl.checked, seed: sim.seed }));
  }
  try {
    const v = JSON.parse(store.get('bioglow2-variation') || 'null');
    if (v) { varEl.checked = !!v.on; seedEl.value = v.seed; }
  } catch (e) { /* ignore */ }
  varEl.onchange = applyVariation;
  seedEl.onchange = applyVariation;
  $('reroll').onclick = () => { seedEl.value = 1 + Math.floor(Math.random() * 9999); applyVariation(); };
  applyVariation();
      store.set('bioglow2-docks', JSON.stringify(sim.docks));
    };
  }
  syncDockSelects();

  // Real-world variation: wheel size, motor strength, gyro drift, mat grip, placement, sensor noise
  const varEl = $('variation'), seedEl = $('seed');
  function applyVariation() {
    if (sim.codeRunning) return;
    sim.setVariation(varEl.checked, Math.max(1, parseInt(seedEl.value, 10) || 1));
    seedEl.disabled = !varEl.checked; $('reroll').disabled = !varEl.checked;
    store.set('bioglow2-variation', JSON.stringify({ on: varEl.checked, seed: sim.seed }));
  }
  try {
    const v = JSON.parse(store.get('bioglow2-variation') || 'null');
    if (v) { varEl.checked = !!v.on; seedEl.value = v.seed; }
  } catch (e) { /* ignore */ }
  varEl.onchange = applyVariation;
  seedEl.onchange = applyVariation;
  $('reroll').onclick = () => { seedEl.value = 1 + Math.floor(Math.random() * 9999); applyVariation(); };
  applyVariation();

  // Optional keyboard driving (only when no code is running)
  const keys = new Set();
  function updateManual() {
    const up = keys.has('arrowup') || keys.has('w'), down = keys.has('arrowdown') || keys.has('s');
    const left = keys.has('arrowleft') || keys.has('a'), right = keys.has('arrowright') || keys.has('d');
    sim.manual.f = (up ? 1 : 0) - (down ? 1 : 0);
    sim.manual.t = (right ? 1 : 0) - (left ? 1 : 0);
  }
  const typing = (e) => /^(TEXTAREA|INPUT|SELECT)$/.test(e.target.tagName) || !!(e.target.closest && e.target.closest('#blockly'));
  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    const k = e.key.toLowerCase();
    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' '].includes(k)) e.preventDefault();
    if (k === ' ' && !e.repeat && !sim.codeRunning && !sim.over && !sim.actions.length) {
      sim.startAction(sim.carried.length ? releaseAction(sim) : grabAction(sim), null, 'C');
    }
    keys.add(k); updateManual();
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); updateManual(); });

  // ---- 2D drawing ------------------------------------------------------------
  const MODEL_COLOURS = {
    1: '#e0e0e0', 2: '#c4e86b', 3: '#9aa7b0', 4: '#3f9b3a', 5: '#8a5a32', 6: '#e8c27a', 7: '#f4f1e8', 8: '#6b4423',
    9: '#d9b98a', 10: '#ffffff', 11: '#7a3b22', 12: '#d8c49a', 13: '#2b2b2b', 14: '#7a4a26', 15: '#9bd13b',
  };
  // a free-standing model's outline after it has been pushed (pose is relative to its start)
  const moved = (shape, pose) => {
    const cx = shape.reduce((a, p) => a + p[0], 0) / shape.length;
    const cy = shape.reduce((a, p) => a + p[1], 0) / shape.length;
    const c = Math.cos((pose.da * Math.PI) / 180), sn = Math.sin((pose.da * Math.PI) / 180);
    return shape.map(([x, y]) => [cx + pose.dx + (x - cx) * c - (y - cy) * sn, cy + pose.dy + (x - cx) * sn + (y - cy) * c]);
  };
  const polyPath = (shape) => {
    ctx.beginPath();
    shape.forEach(([x, y], i) => (i ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S)));
    ctx.closePath();
  };

  function draw2D() {
    ctx.fillStyle = '#202224';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const mr = MAT.rect;
    ctx.save();
    ctx.translate(mr.x * S, mr.y * S);
    paintMatArt(ctx, mr.w * S, mr.h * S);
    ctx.restore();

    ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const s of sim.solids) {
      const st = sim.state[s.id];
      const shape = s.pose ? moved(s.shape, s.pose) : s.shape;
      polyPath(shape);
      ctx.fillStyle = MODEL_COLOURS[s.mission];
      ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 2; ctx.strokeStyle = s.fragile && st.touched ? '#ff3b3b' : st.presses ? '#34ffd0' : '#1a1a1a';
      ctx.stroke();
      const cx = shape.reduce((a, p) => a + p[0], 0) / shape.length;
      const cy = shape.reduce((a, p) => a + p[1], 0) / shape.length;
      ctx.fillStyle = '#d62828';
      ctx.fillRect(cx * S - 10, cy * S - 7, 20, 14);
      ctx.fillStyle = '#fff';
      ctx.fillText(String(s.mission).padStart(2, '0'), cx * S, cy * S + 0.5);
    }

    // the parts the robot works: red to push, red with an arrow to pull, dashed to lift
    for (const pl of sim.plates) {
      polyPath(pl.poly);
      const done = pl.ps.latched || pl.ps.max >= 0.9;
      if (pl.lift) { // a handle to lift: dashed, with an arrow up
        ctx.fillStyle = done ? 'rgba(52,255,208,.5)' : 'rgba(255,122,26,.35)'; ctx.fill();
        ctx.setLineDash([3, 2]); ctx.lineWidth = 1.5; ctx.strokeStyle = done ? '#34ffd0' : '#ff7a1a'; ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#4a2000'; ctx.fillText('\u2191', pl.cx * S, pl.cy * S + 0.5);
        continue;
      }
      if (pl.pull) { // a handle to pull: red, with an arrow pointing the way it has to go
        ctx.fillStyle = done ? '#34ffd0' : '#d62828'; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
        if (!done) {
          const ax = pl.cx * S, ay = pl.cy * S, ex = ax + pl.nx * 3 * S, ey = ay + pl.ny * 3 * S;
          ctx.strokeStyle = '#d62828'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(ex, ey); ctx.stroke();
          ctx.beginPath(); ctx.arc(ex, ey, 2.5, 0, Math.PI * 2); ctx.fillStyle = '#d62828'; ctx.fill();
        }
        continue;
      }
      ctx.fillStyle = done ? '#34ffd0' : '#d62828'; ctx.fill(); // the part to push (a red handle, or the ant)
      ctx.lineWidth = 1; ctx.strokeStyle = '#4a0000'; ctx.stroke();
    }

    // cables and chains tying loose models to their mission model
    ctx.strokeStyle = 'rgba(20,20,20,.8)'; ctx.lineWidth = 1.5;
    for (const it of sim.items) {
      if (!it.tether || it.attached) continue;
      const host = sim.solids.find((s) => s.id === it.tether);
      const hx = host.shape.reduce((a, p) => a + p[0], 0) / host.shape.length, hy = host.shape.reduce((a, p) => a + p[1], 0) / host.shape.length;
      ctx.beginPath(); ctx.moveTo(hx * S, hy * S); ctx.lineTo(it.x * S, it.y * S); ctx.stroke();
    }
    // M01: the drone's four rigid legs (black 32L axles) and the drone, seen from above
    const rig = sim.droneRig();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 0.48 * S; ctx.lineCap = 'round';
    for (const [p, q] of rig.legs) { ctx.beginPath(); ctx.moveTo(p[0] * S, p[1] * S); ctx.lineTo(q[0] * S, q[1] * S); ctx.stroke(); }
    ctx.lineCap = 'butt';
    ctx.save();
    ctx.translate(rig.drone[0] * S, rig.drone[1] * S); ctx.rotate(rig.yaw);
    ctx.fillStyle = rig.lift > 0 ? '#ffffff' : '#d8dde2'; ctx.fillRect(-2.4 * S, -2.4 * S, 4.8 * S, 4.8 * S);
    ctx.lineWidth = 1; ctx.strokeStyle = '#111'; ctx.strokeRect(-2.4 * S, -2.4 * S, 4.8 * S, 4.8 * S);
    ctx.restore();
    for (const it of sim.items) {
      if (it.outOfPlay) continue;
      ctx.beginPath();
      if (it.size) { // a rectangular model, turned with its body
        const c = Math.cos(it.a * Math.PI / 180), sn = Math.sin(it.a * Math.PI / 180), u = it.size[0] / 2, v = it.size[1] / 2;
        [[-u, -v], [u, -v], [u, v], [-u, v]].forEach(([px, py], k) => ctx[k ? 'lineTo' : 'moveTo']((it.x + px * c - py * sn) * S, (it.y + px * sn + py * c) * S));
        ctx.closePath();
      } else ctx.arc(it.x * S, it.y * S, it.r * S, 0, Math.PI * 2);
      ctx.fillStyle = ITEM_COLOURS[it.type] || '#8a5a32';
      if (it.attached) ctx.globalAlpha = 0.75;
      ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = '#111'; ctx.stroke();
      ctx.globalAlpha = 1;
    }
    drawRobot();
  }

  const ITEM_COLOURS = { keystone: '#9b59d0', seed: '#8a5a32', leaf: '#9be04a', katydid: '#2f9e44', fragment: '#f2b233', anchor: '#d62828', vine: '#7cc142', tie: '#e03131' };

  // the photo robot's top grid as a little picture, one pixel per cell (made once per robot)
  let lookCache = null;
  function lookImage(look) {
    if (lookCache && lookCache.rev === look.rev) return lookCache.img;
    const m = look.top, c = document.createElement('canvas');
    c.width = m.w; c.height = m.h;
    const g = c.getContext('2d'), img = g.createImageData(m.w, m.h);
    for (let i = 0; i < m.w * m.h; i++) {
      if (m.bits.charCodeAt(i) !== 49) continue;
      for (let k = 0; k < 3; k++) img.data[i * 4 + k] = parseInt(m.rgb.substr(i * 6 + k * 2, 2), 16);
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    lookCache = { rev: look.rev, img: c };
    return c;
  }
  function drawRobot() {
    const r = sim.robot;
    if (sim.trail.length > 1) {
      ctx.strokeStyle = 'rgba(255,120,0,.85)'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
      ctx.beginPath();
      sim.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S)));
      ctx.stroke();
    }
    ctx.save();
    ctx.translate(r.x * S, r.y * S);
    ctx.rotate((r.h * Math.PI) / 180);
    const W = ROBOT.width * S, L = ROBOT.length * S;
    const wx = (ROBOT.wheelBase / 2) * S, ww = ROBOT.wheel.width * S, wl = ROBOT.wheel.diameter * S;
    const R = ROBOT.basket * S;
    if (ROBOT.attachment === 'basket') {
      ctx.fillStyle = 'rgba(43,108,176,.45)'; ctx.fillRect(-W / 2, -L / 2 - R, W, R);
      if (sim.basketClosed) { ctx.fillStyle = '#2b6cb0'; ctx.fillRect(-W / 2, -L / 2 - R, W, 1.2 * S); } // gate closed (motor C)
    } else if (ROBOT.attachment === 'hook') {
      ctx.fillStyle = '#2b6cb0'; ctx.fillRect(-0.6 * S, -L / 2 - R, 1.2 * S, R);
      ctx.fillStyle = sim.basketClosed ? '#ffb703' : '#2b6cb0'; ctx.fillRect(-1.6 * S, -L / 2 - R, 3.2 * S, 1.2 * S); // hook down (motor C)
    } else if (sim.attBoxes) { // lift arm or photo attachment: where it is now (lighter when it is up high)
      for (const b of sim.attBoxes) { ctx.fillStyle = b.high ? 'rgba(43,108,176,.4)' : '#2b6cb0'; ctx.fillRect((b.v - b.dv / 2) * S, -(b.u + b.du / 2) * S, b.dv * S, b.du * S); }
    } else if (ROBOT.attachment === 'pusher') {
      ctx.fillStyle = '#2b6cb0'; ctx.fillRect(-W / 2, -L / 2 - R, W, R); // pusher
    }
    const look = ROBOT.look && lookImage(ROBOT.look);
    if (look) { // the robot made from photos, seen from above (the photo's front is on the right)
      const k = ROBOT.look.cell * S;
      ctx.save(); ctx.rotate(-Math.PI / 2);
      ctx.drawImage(look, (-look.width / 2) * k, (-look.height / 2) * k, look.width * k, look.height * k);
      ctx.restore();
      ctx.strokeStyle = 'rgba(122,85,0,.6)'; ctx.lineWidth = 1; ctx.strokeRect(-W / 2, -L / 2, W, L); // what it bumps with
    } else {
      ctx.fillStyle = '#ffb703'; ctx.strokeStyle = '#7a5500'; ctx.lineWidth = 2;
      ctx.fillRect(-W / 2, -L / 2, W, L); ctx.strokeRect(-W / 2, -L / 2, W, L);
      ctx.fillStyle = '#222';
      ctx.fillRect(-wx - ww / 2, -wl / 2, ww, wl); // wheels
      ctx.fillRect(wx - ww / 2, -wl / 2, ww, wl);
      ctx.fillStyle = '#d62828'; ctx.fillRect(-W / 2, -L / 2, W, 5); // front bar
    }
    ctx.fillStyle = '#0077ff';
    ctx.beginPath(); ctx.arc(ROBOT.sensorSide * S, -ROBOT.sensorOffset * S, 4, 0, Math.PI * 2); ctx.fill(); // color sensor
    if (ROBOT.color2) { ctx.beginPath(); ctx.arc(ROBOT.sensorSide2 * S, -ROBOT.sensorOffset * S, 4, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    if (real) real.draw2D(ctx, S);
  }

  // ---- views ---------------------------------------------------------------
  const stageEl = $('stage');
  const overlayEl = $('overlay');
  let view3d = null;
  let view = '2d';

  function setView(v) {
    view = v;
    const is3d = v !== '2d';
    stageEl.classList.toggle('is3d', is3d);
    canvas.hidden = is3d;
    if (view3d) { view3d.el.hidden = !is3d; if (is3d) view3d.setMode(v); }
    for (const b of document.querySelectorAll('#views button[data-view]')) b.classList.toggle('on', b.dataset.view === v);
    store.set('bioglow-view', v);
  }

  function initViews() {
    try {
      if (window.BioGlow3D) view3d = window.BioGlow3D.create(stageEl, sim, paintMatArt);
      window.bioglowView = view3d;
    } catch (e) {
      console.warn('3D view unavailable:', e);
    }
    view = (view3d && store.get('bioglow-view')) || (view3d ? 'orbit' : '2d');
    for (const b of document.querySelectorAll('#views button[data-view]')) {
      if (b.dataset.view !== '2d' && !view3d) b.hidden = true;
      b.onclick = () => setView(b.dataset.view);
    }
    const qBtn = $('quality');
    if (view3d && view3d.canPost) {
      const applyQ = (q) => { view3d.setQuality(q); qBtn.textContent = q === 'realistic' ? 'Realistic' : 'Fast'; qBtn.classList.toggle('on', q === 'realistic'); };
      const picked = store.get('bioglow-quality-picked'); // only set when someone clicks the button
      applyQ(picked || 'realistic');
      if (!picked) autoQuality = applyQ;
      qBtn.onclick = () => { applyQ(view3d.quality === 'realistic' ? 'fast' : 'realistic'); store.set('bioglow-quality-picked', view3d.quality); autoQuality = null; };
    } else qBtn.hidden = true;
    if (!view3d) Object.assign($('hint'), { className: 'hint warn', textContent: '3D view needs an internet connection to load three.js - showing 2D.' });
    setView(view);
  }

  function draw() {
    if (view === '2d') draw2D();
    else view3d.render();
    const sc = sim.score();
    overlayEl.hidden = !sim.over;
    if (sim.over) overlayEl.textContent = 'Match over: ' + sc.total + ' points';
  }

  // ---- UI ------------------------------------------------------------------
  let lastScoreKey = '';
  function updateUI() {
    const left = Math.max(0, MATCH_TIME - sim.t);
    const clock = Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0');
    $('timer').textContent = clock;
    $('chipTime').textContent = clock;
    const sc = sim.score();
    $('score').textContent = sc.total;
    $('chipScore').textContent = sc.total;
    $('scoreBig').textContent = sc.total;
    const key = sc.parts.map((p) => p.pts + p.label).join('|');
    if (key !== lastScoreKey) {
      lastScoreKey = key;
      const ul = $('breakdown');
      ul.innerHTML = '';
      const groups = new Map();
      for (const p of sc.parts) {
        if (!groups.has(p.title)) groups.set(p.title, []);
        groups.get(p.title).push(p);
      }
      for (const [title, ps] of groups) {
        const got = ps.reduce((s, p) => s + p.pts, 0);
        const li = document.createElement('li');
        li.className = got ? 'earned' : '';
        const head = document.createElement('div');
        head.innerHTML = '<b></b><span></span>';
        head.firstChild.textContent = title;
        head.lastChild.textContent = got + ' / ' + (title.startsWith('M05') ? 20 : ps.reduce((s, p) => s + p.max, 0));
        li.appendChild(head);
        for (const p of ps) {
          const c = document.createElement('small');
          c.className = p.earned ? 'ok' : p.blocked ? 'blocked' : p.unavailable ? 'na' : '';
          c.textContent = (p.earned ? '\u2713 ' : p.blocked ? '\u26a0 ' : '\u2022 ') + p.cond + (p.unavailable ? ' (10, not in the simulator)' : ' (' + p.max + ')');
          li.appendChild(c);
        }
        ul.appendChild(li);
      }
    }
    const r = sim.robot;
    $('pos').textContent = r.x.toFixed(0) + ', ' + r.y.toFixed(0);
    $('hdg').textContent = ((((r.h % 360) + 360) % 360)).toFixed(0) + '°';
    $('col').textContent = sim.color();
    $('dst').textContent = ROBOT.distanceSensor ? sim.distance().toFixed(0) + ' cm' : 'none';
    $('hold').textContent = sim.carried.length ? sim.carried.length + ' model' + (sim.carried.length > 1 ? 's' : '') : '-';
    $('grip').textContent = r.slipping ? 'slipping!' : 'gripping';
    $('grip').className = r.slipping ? 'warn' : '';
    drawHub();
    statusEl.textContent = sim.over ? 'Match over' : sim.codeRunning ? 'Running code' : sim.started ? (sim.inHome() ? 'Match on \u00b7 robot in home' : 'Match on \u00b7 robot out on the field') : 'Ready';
    for (const sel of document.querySelectorAll('#docks select, #docks input, #docks button')) {
      if (sel.id !== 'seed' && sel.id !== 'reroll') sel.disabled = sim.codeRunning;
    }
  }

  // ---- live robot (Robot tab): everything going on on the robot, seen from above ---------------
  const SENSE_COLOURS = { black: '#151515', white: '#ffffff', red: '#e53935', yellow: '#fdd835', green: '#43a047', blue: '#1e63d6', azure: '#38b6e8', violet: '#8e5bd6', magenta: '#d63aa8' };
  const WHEEL_BLUE = '#3b8bf0', GROUND_GREEN = '#2fb56a', GYRO_ORANGE = '#f59e0b';
  const liveEl = $('live'), liveStats = $('liveStats'), lctx = liveEl.getContext('2d');
  let liveTheme = null, liveStatsAt = 0;
  window.BioGlowLook.onChange(() => { liveTheme = null; });
  const portOf = (job) => HUB_PORTS.find((p) => sim.build.ports[p] === job);
  let insp = null, inspFailed = false;
  function drawLive(now) {
    if (window.BioGlow3D && window.BioGlow3D.inspector && !inspFailed) { // the simulator's own 3D robot
      try {
        if (!insp) { insp = window.BioGlow3D.inspector($('liveView'), sim, paintMatArt); liveEl.hidden = true; }
        insp.render();
        liveNumbers(now);
        return;
      } catch (e) { inspFailed = true; liveEl.hidden = false; console.warn('Live 3D view failed, using the diagram', e); }
    }
    if (!liveTheme) { const cs = getComputedStyle(document.body); liveTheme = { fg: cs.getPropertyValue('--fg').trim(), dim: cs.getPropertyValue('--dim').trim(), error: cs.getPropertyValue('--error').trim(), accent: cs.getPropertyValue('--accent').trim() }; }
    const T = liveTheme, c = lctx, P = 460, r = sim.robot, R = ROBOT, ARM = window.BioGlow.ARM;
    const dpr = Math.min(3, window.devicePixelRatio || 1); // sharp on high-resolution screens
    if (liveEl.width !== Math.round(P * dpr)) liveEl.width = liveEl.height = Math.round(P * dpr);
    const rrect = (x, y, w, h, rad) => (c.roundRect ? c.roundRect(x, y, w, h, rad) : c.rect(x, y, w, h));
    const radius = R.wheel.diameter / 2, ms = (w) => w * radius; // wheel rad/s -> cm/s at the tyre
    const reach = R.basket, ww = Math.max(R.wheel.width, 1.2), wid = Math.max(R.width, R.wheelBase + ww + 7);
    const k = Math.min((P * 0.6) / (R.length + reach), (P * 0.82) / wid); // pixels per cm
    const cx = P / 2, cy = P / 2 + (reach * k) / 2 + 10;
    const at = (x, y) => [cx + x * k, cy + y * k]; // robot cm (x right, y back) -> canvas px
    const label = (x, y, text, colour, align) => { const [px, py] = at(x, y); c.fillStyle = colour || T.fg; c.textAlign = align || 'center'; c.fillText(text, px, py); };
    const arrow = (x0, y0, x1, y1, colour, width) => {
      const [ax, ay] = at(x0, y0), [bx, by] = at(x1, y1), len = Math.hypot(bx - ax, by - ay);
      if (len < 2) return;
      const ux = (bx - ax) / len, uy = (by - ay) / len, hd = Math.min(9, len * 0.5);
      c.strokeStyle = c.fillStyle = colour; c.lineWidth = width || 3;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx - ux * hd * 0.6, by - uy * hd * 0.6); c.stroke();
      c.beginPath(); c.moveTo(bx, by); c.lineTo(bx - ux * hd - uy * hd * 0.55, by - uy * hd + ux * hd * 0.55); c.lineTo(bx - ux * hd + uy * hd * 0.55, by - uy * hd - ux * hd * 0.55); c.fill();
    };
    const cross = (x, y, size) => { const [px, py] = at(x, y), s2 = size * k; c.strokeStyle = T.error; c.lineWidth = 3; c.beginPath(); c.moveTo(px - s2, py - s2); c.lineTo(px + s2, py + s2); c.moveTo(px + s2, py - s2); c.lineTo(px - s2, py + s2); c.stroke(); };
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, P, P);
    c.font = '13px system-ui, sans-serif'; c.textBaseline = 'middle';

    // body, hub and attachment
    const [bx, by] = at(-R.width / 2, -R.length / 2);
    c.fillStyle = 'rgba(128,128,128,.16)'; c.strokeStyle = T.dim; c.lineWidth = 1.5;
    c.beginPath(); rrect(bx, by, R.width * k, R.length * k, 6); c.fill(); c.stroke();
    const across = R.model === 'adb', hw = across ? 8.8 : 5.6, hl = across ? 5.6 : 8.8, [hx, hy] = at(-hw / 2, (across ? 0.4 : 1.2) - hl / 2);
    c.fillStyle = 'rgba(255,255,255,.75)'; c.strokeStyle = '#d8b400'; c.lineWidth = 2;
    c.beginPath(); rrect(hx, hy, hw * k, hl * k, 4); c.fill(); c.stroke();
    const front = -R.length / 2, armOk = sim.faults.arm.on;
    c.strokeStyle = armOk ? T.accent : T.dim; c.lineWidth = 3;
    const seg = (x0, y0, x1, y1, dash) => { const [a0, a1] = at(x0, y0), [b0, b1] = at(x1, y1); c.setLineDash(dash ? [5, 5] : []); c.beginPath(); c.moveTo(a0, a1); c.lineTo(b0, b1); c.stroke(); c.setLineDash([]); };
    const closed = r.armPos >= ARM.closeAt;
    if (R.attachment === 'basket') {
      for (const sd of [-1, 1]) seg(sd * (R.width / 2 - 0.4), front, sd * (R.width / 2 - 0.4), front - reach);
      seg(-R.width / 2 + 0.4, front - reach, R.width / 2 - 0.4, front - reach, !closed);
    } else if (R.attachment === 'hook') {
      seg(0, front, 0, front - reach); seg(-1, front - reach, 1, front - reach, !closed);
    } else if (sim.attBoxes) {
      c.fillStyle = armOk ? T.accent : T.dim;
      for (const b of sim.attBoxes) { const [px, py] = at(b.v - b.dv / 2, -(b.u + b.du / 2)); c.globalAlpha = b.high ? 0.35 : 0.8; c.fillRect(px, py, b.dv * k, b.du * k); }
      c.globalAlpha = 1;
    } else seg(-R.width / 2, front - reach, R.width / 2, front - reach);
    if (!armOk) cross(0, front - reach / 2, 1.2);

    // wheels: the tread moves with the encoder; red when slipping, crossed out when the motor is off
    const scaleV = ((R.length + reach) * 0.42) / R.maxSpeed; // cm of arrow per cm/s
    const room = (cy / k) - R.length / 2 - 1; // arrow room ahead of the axle
    const clampLen = (v) => Math.max(-room, Math.min(room, v * scaleV));
    for (const [side, sd] of [['L', -1], ['R', 1]]) {
      const info = r.wheels[side] || { set: 0, w: 0, ground: 0, effort: 0, slip: false, dead: false };
      const x = sd * R.wheelBase / 2, [wx, wy] = at(x - ww / 2, -radius);
      c.save();
      c.beginPath(); rrect(wx, wy, ww * k, R.wheel.diameter * k, 3); c.clip();
      c.fillStyle = info.dead ? '#777' : info.slip ? T.error : '#262626'; c.fillRect(wx, wy, ww * k, R.wheel.diameter * k);
      const pitch = 1.2, travel = ((side === 'L' ? r.encL : r.encR) / 360) * Math.PI * R.wheel.diameter;
      c.strokeStyle = 'rgba(255,255,255,.35)'; c.lineWidth = 2;
      for (let y = -radius - pitch + (((-travel % pitch) + pitch) % pitch); y < radius + pitch; y += pitch) { const [, py] = at(0, y); c.beginPath(); c.moveTo(wx, py); c.lineTo(wx + ww * k, py); c.stroke(); }
      c.restore();
      if (info.dead) cross(x, 0, 1.4);
      const out = x + sd * (ww / 2 + 1.3), out2 = out + sd * 1.6;
      // motor target (outline), wheel speed (blue) and ground speed (green)
      const [tx, ty] = at(out, -clampLen(ms(info.set))); c.strokeStyle = WHEEL_BLUE; c.lineWidth = 2; c.beginPath(); c.moveTo(tx - 7, ty); c.lineTo(tx + 7, ty); c.stroke();
      arrow(out, 0, out, -clampLen(ms(info.w)), WHEEL_BLUE);
      arrow(out2, 0, out2, -clampLen(ms(info.ground)), GROUND_GREEN);
      if (Math.abs(info.skid) > 0.5) arrow(x, radius + 0.8, x + Math.max(-4, Math.min(4, info.skid * scaleV)), radius + 0.8, T.error, 2);
      if (info.slip) label(x, radius + 2.2, 'SLIP', T.error);
      label(out2 + sd * 1.2, -radius - 1.2, (portOf(side === 'L' ? 'left' : 'right') || '') + ' ' + Math.round(info.effort * 100) + '%', T.dim, sd < 0 ? 'right' : 'left');
    }

    // how the robot as a whole is moving
    const v = sim.body.getLinearVelocity(), a = sim.body.getAngle(), fwd = v.x * Math.cos(a) + v.y * Math.sin(a), right = -v.x * Math.sin(a) + v.y * Math.cos(a);
    arrow(0, 0, Math.max(-room, Math.min(room, right * scaleV)), -clampLen(fwd), T.fg, 2.5);
    const spin = (sim.body.getAngularVelocity() * 180) / Math.PI;
    if (Math.abs(spin) > 2) { // turning: an arc around the middle
      const [ox, oy] = at(0, 0), rr = 3.2 * k, sweep = Math.min(Math.PI * 1.5, Math.abs(spin) / 120 * Math.PI), start = -Math.PI / 2;
      c.strokeStyle = T.fg; c.lineWidth = 2; c.beginPath();
      if (spin > 0) c.arc(ox, oy, rr, start, start + sweep); else c.arc(ox, oy, rr, start - sweep, start);
      c.stroke();
    }

    // color sensors (filled with what they see) and the distance sensor's beam
    const sensors = [[R.sensorSide, 1, 'color']].concat(R.color2 ? [[R.sensorSide2, 2, 'color2']] : []);
    const seen = {};
    for (const [sx, n, job] of sensors) {
      const col = sim.color(n), [px, py] = at(sx, -R.sensorOffset);
      seen[job] = col;
      c.beginPath(); c.arc(px, py, Math.max(6, 0.8 * k), 0, Math.PI * 2);
      c.fillStyle = SENSE_COLOURS[col] || 'transparent'; c.fill(); c.strokeStyle = T.fg; c.lineWidth = 2; c.stroke();
      if (!sim.faults[job].on) cross(sx, -R.sensorOffset, 1);
      label(sx, -R.sensorOffset + 1.8, portOf(job) || '', T.dim);
    }
    if (R.distanceSensor) {
      const d = sim.distance(), max = room - reach - 1, shown = Math.min(d, max);
      if (!sim.faults.distance.on) cross(0, front - 0.6, 1);
      else {
        c.setLineDash([4, 4]); seg(0, front, 0, front - shown); c.setLineDash([]);
        label(1, front - shown, d >= R.eyeRange ? 'nothing' : Math.round(d) + ' cm' + (d > max ? ' ↑' : ''), T.dim, 'left');
      }
    }

    // gyro: true heading (white) and what the gyro says (orange)
    const gx = P - 50, gy = 50, gr = 34;
    c.strokeStyle = T.dim; c.lineWidth = 1.5; c.beginPath(); c.arc(gx, gy, gr, 0, Math.PI * 2); c.stroke();
    const needle = (deg, colour) => { const t = (deg * Math.PI) / 180; c.strokeStyle = colour; c.lineWidth = 3; c.beginPath(); c.moveTo(gx, gy); c.lineTo(gx + Math.sin(t) * gr * 0.85, gy - Math.cos(t) * gr * 0.85); c.stroke(); };
    needle(r.h, T.fg); needle(sim.gyro(), sim.faults.gyro.on ? GYRO_ORANGE : T.error);
    c.fillStyle = T.dim; c.textAlign = 'center'; c.fillText('gyro', gx, gy + gr + 12);

    liveNumbers(now);
  }

  // The numbers beside the live view, a few times a second.
  function liveNumbers(now) {
    if (now - liveStatsAt < 120) return;
    liveStatsAt = now;
    const r = sim.robot, R = ROBOT, ARM = window.BioGlow.ARM, radius = R.wheel.diameter / 2, ms = (w) => w * radius;
    const v = sim.body.getLinearVelocity(), a = sim.body.getAngle(), fwd = v.x * Math.cos(a) + v.y * Math.sin(a), right = -v.x * Math.sin(a) + v.y * Math.cos(a);
    const spin = (sim.body.getAngularVelocity() * 180) / Math.PI, closed = r.armPos >= ARM.closeAt;
    const sensors = [[R.sensorSide, 1, 'color']].concat(R.color2 ? [[R.sensorSide2, 2, 'color2']] : []);
    const seen = {};
    for (const [, n, job] of sensors) seen[job] = sim.color(n);
    const f1 = (x) => (Math.abs(x) < 0.05 ? '0' : x.toFixed(1));
    const rows = [];
    const head = (t) => rows.push('<h3>' + t + '</h3>');
    const row = (name, value, cls) => rows.push('<span>' + name + '</span><span' + (cls ? ' class="' + cls + '"' : '') + '>' + value + '</span>');
    for (const [side, job, name] of [['L', 'left', 'Left'], ['R', 'right', 'Right']]) {
      const info = r.wheels[side] || { set: 0, w: 0, ground: 0, effort: 0, slip: false, dead: false, skid: 0 };
      head(name + ' wheel · port ' + (portOf(job) || '-'));
      row('Motor', info.dead ? 'switched off' : 'asks ' + f1(ms(info.set)) + ' cm/s, working ' + Math.round(Math.abs(info.effort) * 100) + '%', info.dead ? 'bad' : '');
      row('Wheel turning', f1(ms(info.w)) + ' cm/s');
      row('Ground going by', f1(ms(info.ground)) + ' cm/s');
      row('Grip', info.slip ? 'SLIPPING by ' + f1(Math.abs(ms(info.w - info.ground))) + ' cm/s' : Math.abs(info.skid) > 0.5 ? 'skidding sideways ' + f1(Math.abs(info.skid)) + ' cm/s' : 'gripping', info.slip ? 'bad' : 'good');
      row('Encoder', Math.round(side === 'L' ? r.encL : r.encR) + '°');
    }
    head('Whole robot');
    row('Speed', f1(fwd) + ' cm/s forward' + (Math.abs(right) > 0.5 ? ', ' + f1(Math.abs(right)) + ' sideways' : ''));
    row('Turning', f1(spin) + ' °/s');
    const hdg = ((r.h % 360) + 360) % 360, gyro = sim.gyro(), err = ((((gyro - r.h) % 360) + 540) % 360) - 180;
    row('Heading', Math.round(hdg) + '° really, gyro says ' + Math.round(((gyro % 360) + 360) % 360) + '°', Math.abs(err) > 2 || !sim.faults.gyro.on ? 'bad' : '');
    head('Sensors');
    for (const [, n, job] of sensors) row((job === 'color2' ? 'Second color' : 'Color') + ' · ' + (portOf(job) || '-'), sim.faults[job].on ? seen[job] + ', ' + sim.reflection(n) + '% reflected' : 'switched off', sim.faults[job].on ? '' : 'bad');
    if (R.distanceSensor) { const d = sim.distance(); row('Distance · ' + portOf('distance'), sim.faults.distance.on ? (d >= R.eyeRange ? 'nothing in range' : f1(d) + ' cm') : 'switched off', sim.faults.distance.on ? '' : 'bad'); }
    head('Other motors');
    if (portOf('arm')) row('Attachment · ' + portOf('arm'), sim.faults.arm.on ? Math.round(r.armPos) + '°' + (R.attachment === 'pusher' ? ', pusher' : R.attachment === 'basket' || R.attachment === 'hook' ? (closed ? ', closed' : ', open') : '') : 'switched off', sim.faults.arm.on ? '' : 'bad');
    if (portOf('spare')) row('Spare · ' + portOf('spare'), sim.faults.spare.on ? Math.round(r.sparePos) + '°' : 'switched off', sim.faults.spare.on ? '' : 'bad');
    row('Holding', sim.carried.length ? sim.carried.map((i) => i.type).join(', ') : 'nothing');
    row('Battery', Math.round(sim.battery * 100) + '%');
    liveStats.innerHTML = rows.join('');
  }

  // Realistic quality is too much for many laptops (often Windows ones with built-in graphics). If the
  // 3D view keeps running under 25 frames a second and nobody has picked a quality, drop to Fast.
  let autoQuality = null, watchFrom = 0, slowMs = 0, totalMs = 0;
  function watchFrameRate(now, ms) {
    if (!autoQuality || view === '2d' || view3d.quality !== 'realistic' || document.hidden) { watchFrom = 0; return; }
    if (!watchFrom) { watchFrom = now + 3000; slowMs = totalMs = 0; return; } // the first seconds are slow while everything is built
    if (now < watchFrom) return;
    totalMs += ms;
    if (ms > 40) slowMs += ms;
    if (totalMs < 3000) return;
    const slow = slowMs > totalMs * 0.6;
    slowMs = totalMs = 0;
    if (!slow) return;
    autoQuality('fast');
    autoQuality = null;
    const hint = $('hint'), was = hint.textContent;
    hint.textContent = 'Switched to Fast quality so the view stays smooth - click Fast to go back to Realistic.';
    setTimeout(() => { hint.textContent = was; }, 10000);
  }

  // ---- main loop -----------------------------------------------------------
  const channel = new MessageChannel();
  const macrotask = () => new Promise((res) => { channel.port1.onmessage = () => res(); channel.port2.postMessage(0); });

  // rAF timestamps can trail performance.now() after a slow startup, so never step backwards
  const clampDt = (s) => Math.max(0, Math.min(0.1, s));
  let last = performance.now(), acc = 0, busy = false;
  async function frame(now) {
    requestAnimationFrame(frame);
    const dtReal = clampDt((now - last) / 1000);
    watchFrameRate(now, now - last);
    last = now;
    if (busy) return;
    busy = true;
    acc += dtReal * speed;
    while (acc >= DT) {
      acc -= DT;
      // let user code continue after an action completes, before the next step
      const done = sim.step(DT);
      if (real) real.afterStep();
      if (done) await macrotask();
    }
    draw();
    updateUI();
    if ($('liveView').offsetParent) drawLive(now); // (the 2D diagram is hidden once the 3D view is up)
    if (real) real.frame(now);
    busy = false;
  }

  // ---- real robot (Robot tab) -------------------------------------------------
  let real = null;
  function initReal() {
    if (!window.BioGlowReal || !window.BioGlowHub) return;
    real = window.BioGlowReal.init({
      sim, print,
      source: programSource,
      runFresh: () => runCode(true),
      realtime: () => { speed = 1; $('speed').value = '1'; },
      view3d: () => (view === '2d' ? null : view3d),
    });
    window.bioglowReal = real;
  }

  loadMatArt(() => {
    initViews();
    initEditors();
    if (window.BioGlowSync) window.BioGlowSync.attach({ blocks, print: (msg, cls) => print(msg, sim.t, cls), store, button: $('sync') });
    initReal();
    requestAnimationFrame(frame);
    requestAnimationFrame(() => requestAnimationFrame(() => window.hideLoader && window.hideLoader()));
  });
})();
