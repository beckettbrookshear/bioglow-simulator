/* BIOGLOW real robot: the Robot tab's "Real robot" section. Connects to a SPIKE Prime hub (realhub.js),
 * shows its live readings, draws a see-through "ghost" of the real robot on the field from its wheel
 * motors and gyro, and runs a program on both robots at once so they can be compared.
 *
 * "Run on both": the simulator run is recorded (motor commands, wheel travel, heading), the commands
 * are uploaded to the hub as a small replay program, and when the hub prints BIOGLOW-GO the simulator
 * runs the same program again from the start, side by side with the real robot. */
(function () {
  'use strict';
  const { JOBS, HUB_PORTS, MOTORS, ROBOT } = window.BioGlow;
  const H = window.BioGlowHub;
  const SLOT = 19; // the hub's last program slot; "Run on both" overwrites it
  const $ = (id) => document.getElementById(id);
  const deg = (r) => (r * 180) / Math.PI;
  const rad = (d) => (d * Math.PI) / 180;
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  };
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cmPerDeg = () => (Math.PI * ROBOT.wheel.diameter) / 360;

  function init(app) {
    const { sim } = app;
    let hub = null, devices = null, lastDevices = 0, hubRunning = false;
    let phase = 'idle'; // idle | recording | uploading | ready | running
    let rec = null;     // the latest simulator run, recorded step by step
    let live = null;    // the simulator's run beside the real robot during "Run on both"
    let real = null;    // the real robot's run during "Run on both"
    let expectRerun = false;
    const seenUnknown = {};
    const ghost = { show: store.get('bioglow-ghost') !== 'off', placed: false, x: 0, y: 0, h: 0, trail: [] };
    const odo = { prev: null, distL: 0, distR: 0, t: 0 };
    const gyro = { scale: 0, sign: 1, mode: 'checking', wheelSum: 0, rawSum: 0, prevYaw: null };

    // ---- log -----------------------------------------------------------------------
    const logLines = [];
    function log(msg) {
      const t = new Date();
      logLines.push(t.toTimeString().slice(0, 8) + '  ' + msg);
      if (logLines.length > 300) logLines.shift();
      $('rrLog').textContent = logLines.join('\n');
    }
    const say = (html, cls) => { const n = $('rrStep'); n.innerHTML = html; n.className = 'rr-step ' + (cls || ''); n.hidden = !html; };

    // ---- wiring ---------------------------------------------------------------------
    const portOf = (job) => HUB_PORTS.find((p) => sim.build.ports[p] === job);
    const motorPorts = () => HUB_PORTS.filter((p) => JOBS[sim.build.ports[p]] && JOBS[sim.build.ports[p]].motor);
    function innerPct(inner) {
      const r = sim.robot;
      return inner === 'A' ? -r.cmdL : inner === 'B' ? r.cmdR : inner === 'C' ? r.armCmd || 0 : inner === 'D' ? r.spareCmd || 0 : 0;
    }

    // ---- connection -------------------------------------------------------------------
    function connected() { return !!(hub && hub.connected); }
    async function connect() {
      if (connected()) { hub.disconnect(); return; }
      hub = new H.SpikeHub();
      hub.on('log', log);
      hub.on('devices', onDevices);
      hub.on('console', onConsole);
      hub.on('program', (running) => {
        hubRunning = running;
        log('Hub program ' + (running ? 'started' : 'stopped'));
        if (!running && phase === 'running') finishBoth('The hub program stopped.');
        refresh();
      });
      hub.on('disconnect', () => {
        log('Disconnected');
        devices = null; hubRunning = false;
        if (phase !== 'idle' && phase !== 'recording') { phase = 'idle'; say('The hub disconnected. Connect again and press Run on both.', 'bad'); }
        refresh();
      });
      $('rrConnect').disabled = true;
      $('rrConnect').textContent = 'Connecting...';
      try {
        await hub.connect(Number($('rrRate').value) || 50);
        log('Connected to ' + hub.name);
        say('');
      } catch (e) {
        const cancelled = e && e.name === 'NotFoundError';
        log(cancelled ? 'No hub chosen' : 'Could not connect: ' + (e.message || e));
        if (!cancelled) say('Could not connect: ' + esc(e.message || e) + '. Turn the hub on, press its Bluetooth button and try again.', 'bad');
        if (hub.connected) hub.disconnect();
      }
      $('rrConnect').disabled = false;
      refresh();
    }

    function onConsole(text) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        if (line.includes('BIOGLOW-GO')) bothStarted();
        else if (line.includes('BIOGLOW-END')) finishBoth();
        else { log('Hub: ' + line); app.print('Real robot: ' + line, sim.t); }
      }
    }

    // ---- live readings and the ghost --------------------------------------------------
    function onDevices(d) {
      const now = performance.now();
      const dt = lastDevices ? (now - lastDevices) / 1000 : 0.05;
      lastDevices = now;
      devices = d;
      if (d.unknown !== undefined && !seenUnknown[d.unknown]) { seenUnknown[d.unknown] = true; log('The hub sent a reading of a kind this page does not know (id ' + d.unknown + '); readings after it in the same message are skipped.'); }
      track(d, dt);
      if (phase === 'running' && real && !real.done) {
        real.samples.push({ t: (now - real.t0) / 1000, distL: odo.distL - real.base.distL, distR: odo.distR - real.base.distR, h: ghost.h, x: ghost.x, y: ghost.y });
      }
    }

    function placeGhost(pose) {
      Object.assign(ghost, { x: pose.x, y: pose.y, h: pose.h, placed: true, trail: [[pose.x, pose.y]] });
    }

    // Dead reckoning: wheel travel from the drive motors' positions, heading from the gyro once it has
    // been checked against the wheels (which also works out its direction and units), otherwise from
    // the difference between the wheels.
    function track(d, dt) {
      const L = d.ports[portOf('left')], R = d.ports[portOf('right')];
      if (!L || L.kind !== 'motor' || !R || R.kind !== 'motor') { odo.prev = null; return; }
      const k = cmPerDeg();
      const dl = -L.pos * k, dr = R.pos * k; // the left motor is mirrored: it turns backwards to drive forwards
      const yaw = d.imu ? d.imu.yaw : null;
      if (!odo.prev) { odo.prev = { dl, dr }; gyro.prevYaw = yaw; if (!ghost.placed) placeGhost(sim.launch); return; }
      let ddl = dl - odo.prev.dl, ddr = dr - odo.prev.dr;
      odo.prev = { dl, dr };
      const lim = k * (1600 * dt + 40);
      if (Math.abs(ddl) > lim || Math.abs(ddr) > lim) { log('The motor positions jumped (a program reset them); the ghost skips the jump.'); ddl = ddr = 0; }
      odo.distL += ddl; odo.distR += ddr;
      const wheelTurn = deg((ddl - ddr) / ROBOT.wheelBase); // + = clockwise, like the simulator's heading

      let raw = null;
      if (yaw !== null && gyro.prevYaw !== null) {
        raw = yaw - gyro.prevYaw;
        const full = gyro.scale === 1 ? 360 : 3600;
        if (raw > full / 2) raw -= full;
        if (raw < -full / 2) raw += full;
      }
      gyro.prevYaw = yaw;
      if (gyro.mode === 'checking' && raw !== null && Math.abs(raw) < 300) {
        gyro.wheelSum += wheelTurn; gyro.rawSum += raw;
        if (Math.abs(gyro.wheelSum) >= 30) checkGyro();
      }
      const turn = gyro.mode === 'gyro' && raw !== null ? gyro.sign * gyro.scale * raw : wheelTurn;
      const mid = rad(ghost.h + turn / 2), dist = (ddl + ddr) / 2;
      ghost.h = (((ghost.h + turn) % 360) + 360) % 360;
      ghost.x += dist * Math.sin(mid);
      ghost.y -= dist * Math.cos(mid);
      const last = ghost.trail[ghost.trail.length - 1];
      if (!last || Math.hypot(ghost.x - last[0], ghost.y - last[1]) > 0.5) { ghost.trail.push([ghost.x, ghost.y]); if (ghost.trail.length > 6000) ghost.trail.shift(); }
    }

    function checkGyro() {
      const r = gyro.rawSum / gyro.wheelSum, a = Math.abs(r);
      if (a >= 6 && a <= 14) Object.assign(gyro, { mode: 'gyro', scale: 0.1, sign: Math.sign(r) });
      else if (a >= 0.6 && a <= 1.4) Object.assign(gyro, { mode: 'gyro', scale: 1, sign: Math.sign(r) });
      else if (a < 0.25) gyro.mode = 'wheels';
      else { gyro.wheelSum = gyro.rawSum = 0; return; } // probably wheel slip: measure again
      log(gyro.mode === 'gyro'
        ? 'Gyro checked against the wheels: ' + (gyro.scale === 0.1 ? 'tenths of a degree' : 'degrees') + ', ' + (gyro.sign > 0 ? 'clockwise' : 'anticlockwise') + ' is positive. The ghost now turns with the gyro.'
        : 'The gyro yaw hardly moves while the wheels turn the robot (is the hub mounted on its side?). The ghost turns with the wheels instead.');
    }

    // ---- recording the simulator --------------------------------------------------------
    function sample(t0) {
      const r = sim.robot, k = cmPerDeg(), cmd = {};
      for (const p of motorPorts()) cmd[p] = innerPct(JOBS[sim.build.ports[p]].inner);
      return { t: sim.t - t0, distL: r.encL * k, distR: r.encR * k, h: r.h, x: r.x, y: r.y, cmd, stop: r.stopMode, accel: r.accelCm };
    }
    function onRun(fresh, src) {
      const run = { src, fresh, buildKey: sim.buildKey, launch: { ...sim.launch }, t0: sim.t, samples: [], done: false };
      if (expectRerun) { expectRerun = false; live = run; return; }
      rec = run;
    }
    function afterStep() {
      for (const run of [rec, live]) {
        if (!run || run.done) continue;
        run.samples.push(sample(run.t0));
        if (!sim.codeRunning) {
          run.done = true;
          if (run === rec && phase === 'recording') uploadRun();
          if (run === live) finalize();
        }
      }
    }

    // ---- run on both ----------------------------------------------------------------------
    function rowsOf(run, ports, minGap = 0) {
      const maxDeg = MOTORS[sim.build.motor] ? MOTORS[sim.build.motor].maxDegPerSec : 1000;
      const value = (s, p) => {
        const pct = s.cmd[p] || 0;
        return Math.abs(pct) < 0.5 ? s.stop : (pct / 100) * maxDeg;
      };
      const rows = [];
      let lastMs = 0, last = null;
      for (const s of run.samples) {
        const vals = ports.map((p) => value(s, p));
        const ms = Math.round(s.t * 1000);
        const changed = !last || vals.some((v, i) => (typeof v === 'string' || typeof last[i] === 'string' ? v !== last[i] : Math.abs(v - last[i]) >= 3));
        const stopping = last && vals.some((v, i) => typeof v === 'string' && v !== last[i]);
        if (!changed || (ms - lastMs < minGap && !stopping)) continue;
        rows.push([ms - lastMs, ...vals]);
        lastMs = ms; last = vals;
      }
      return rows;
    }

    async function runBoth() {
      if (phase === 'ready') return startReal();
      if (phase !== 'idle') return;
      if (!connected()) { say('Connect the hub first.', 'bad'); return; }
      const src = app.source();
      if (src === null) return;
      if (rec && rec.done && rec.fresh && rec.src === src && rec.buildKey === sim.buildKey && rec.samples.length > 1) { uploadRun(); return; }
      phase = 'recording';
      say('Running your program in the simulator first to record what the motors do...');
      app.runFresh();
      refresh();
    }

    async function uploadRun() {
      if (!connected()) { phase = 'idle'; say('The hub is not connected.', 'bad'); refresh(); return; }
      const have = devices ? devices.ports : {};
      const wanted = motorPorts();
      const ports = wanted.filter((p) => have[p] && have[p].kind === 'motor');
      const missing = wanted.filter((p) => !ports.includes(p));
      if (!ports.includes(portOf('left')) || !ports.includes(portOf('right'))) {
        phase = 'idle';
        say('The real robot needs drive motors on port ' + portOf('left') + ' (left) and port ' + portOf('right') + ' (right), like the simulator. Check the cables, or change the Ports section to match your robot.', 'bad');
        refresh();
        return;
      }
      // a program that steers all the time (gyro, line following) changes its speeds every step; for a
      // long run, keep at most one change every 20 times a second so the program fits in the hub's memory
      let rows = rowsOf(rec, ports);
      if (rows.length > 2500) rows = rowsOf(rec, ports, 50);
      if (rows.length > 2500) rows = rowsOf(rec, ports, 100);
      const secs = rec.samples[rec.samples.length - 1].t;
      const accel = Math.max(200, Math.min(10000, (rec.samples[0].accel / (Math.PI * ROBOT.wheel.diameter)) * 360));
      const program = H.replayProgram({ ports, rows, accel, about: secs.toFixed(1) + ' s run, ' + rows.length + ' motor commands' });
      phase = 'uploading';
      refresh();
      say('Sending the motor commands to the hub (program slot ' + SLOT + ')...');
      log('Uploading replay: ' + rows.length + ' commands for ports ' + ports.join(', ') + ', ' + program.length + ' bytes' + (missing.length ? '; no motor on ' + missing.join(', ') + ' so it is left out' : ''));
      try {
        await hub.upload(program, SLOT, (f) => { $('rrBoth').textContent = 'Sending ' + Math.round(f * 100) + '%'; });
      } catch (e) {
        phase = 'idle';
        say('Upload failed: ' + esc(e.message || e), 'bad');
        log('Upload failed: ' + (e.message || e));
        refresh();
        return;
      }
      phase = 'ready';
      say('<b>Ready.</b> Put the real robot in the launch area exactly where the simulator\'s robot starts, facing the same way, then press <b>Start both</b>.' + (missing.length ? ' (No motor found on port ' + missing.join(', ') + ', so that one stays still.)' : ''), 'good');
      refresh();
    }

    async function startReal() {
      phase = 'running';
      real = null; live = null;
      say('Starting the real robot...');
      refresh();
      try { await hub.run(SLOT); } catch (e) { phase = 'ready'; say('Could not start the hub program: ' + esc(e.message || e), 'bad'); refresh(); }
    }

    function bothStarted() {
      if (phase !== 'running') return;
      real = { t0: performance.now(), base: { distL: odo.distL, distR: odo.distR }, samples: [] };
      placeGhost(rec.launch);
      gyro.prevYaw = devices && devices.imu ? devices.imu.yaw : gyro.prevYaw;
      expectRerun = true;
      app.realtime();
      app.runFresh();
      say('Both robots are running. Orange: the simulator. Purple: the real robot (worked out from its wheels and gyro).');
      log('Real robot started; simulator started beside it');
      refresh();
    }

    // The real robot has finished (or stopped): keep its readings coming for a moment while it brakes,
    // then wait for the simulator too, which falls behind real time on a slow computer.
    function finishBoth(why) {
      if (phase !== 'running' || !real || real.ending) return;
      real.ending = true;
      if (why) log(why);
      setTimeout(() => { real.done = true; finalize(); }, 600);
    }

    function finalize() {
      if (phase !== 'running') return;
      if (!real || !real.done) return;
      if (live && !live.done) { say('The real robot has finished. Waiting for the simulator to catch up...'); return; }
      phase = 'idle';
      if (real.samples.length > 2 && live && live.samples.length) {
        const s = live.samples[live.samples.length - 1], r = real.samples[real.samples.length - 1];
        const gap = Math.hypot(s.x - r.x, s.y - r.y), dh = Math.abs(((r.h - s.h + 540) % 360) - 180);
        say('Finished. The real robot ended <b>' + gap.toFixed(1) + ' cm</b> from where the simulator\'s robot ended, facing <b>' + dh.toFixed(0) + '&deg;</b> differently. Wheels travelled: left ' + r.distL.toFixed(1) + ' cm (simulator ' + s.distL.toFixed(1) + '), right ' + r.distR.toFixed(1) + ' cm (simulator ' + s.distR.toFixed(1) + ').' + directionHints(s, r), gap < 5 && dh < 5 ? 'good' : '');
        app.print('Real robot vs simulator: ended ' + gap.toFixed(1) + ' cm apart, ' + dh.toFixed(0) + ' degrees apart.', sim.t);
      } else say('Stopped.');
      refresh();
      drawChart();
    }

    // A cable in the wrong port or a motor fitted the other way round shows up as the wheels
    // going the opposite way to the simulator's.
    function directionHints(s, r) {
      const big = (v) => Math.abs(v) > 5;
      const notes = [];
      if (big(s.distL) && big(r.distL) && Math.sign(s.distL) !== Math.sign(r.distL)) notes.push('the left wheel turned the opposite way');
      if (big(s.distR) && big(r.distR) && Math.sign(s.distR) !== Math.sign(r.distR)) notes.push('the right wheel turned the opposite way');
      return notes.length ? ' <b>Check:</b> ' + notes.join(' and ') + ' to the simulator\'s (a motor fitted the other way round, or left and right cables swapped).' : '';
    }

    async function stopAll() {
      if (phase === 'recording') { sim.stopCode(); }
      if (connected() && hubRunning) { try { await hub.stop(SLOT); } catch (e) { log(e.message || String(e)); } }
      if (phase === 'running') {
        sim.stopCode();
        if (live) live.done = true;
        if (real) { real.done = true; log('Stopped by you.'); finalize(); return; }
      }
      phase = 'idle';
      say('');
      refresh();
    }

    async function runSlot() {
      const slot = Number($('rrSlot').value);
      try { await hub.run(slot); log('Started slot ' + slot); } catch (e) { say(esc(e.message || e), 'bad'); }
    }

    // ---- UI -------------------------------------------------------------------------------
    function refresh() {
      const on = connected();
      $('rrConnect').textContent = on ? 'Disconnect' : 'Connect';
      $('rrState').textContent = on ? hub.name : 'not connected';
      $('rrState').className = on ? 'good' : '';
      $('rrBadge').hidden = !on;
      const labels = { idle: 'Run on both', recording: 'Recording...', uploading: 'Sending...', ready: 'Start both', running: 'Running...' };
      $('rrBoth').textContent = labels[phase];
      $('rrBoth').disabled = !on || phase === 'recording' || phase === 'uploading' || phase === 'running';
      $('rrBoth').classList.toggle('suggested', phase === 'ready');
      $('rrRunSlot').disabled = !on || phase !== 'idle';
      $('rrStop').disabled = !(phase !== 'idle' || (on && hubRunning));
      $('rrPlace').disabled = !on;
    }

    const PORT_JOB = { left: 'left drive motor', right: 'right drive motor', arm: 'attachment motor', spare: 'spare motor', color: 'colour sensor', color2: 'second colour sensor', distance: 'distance sensor' };
    const KIND_OF_JOB = { left: 'motor', right: 'motor', arm: 'motor', spare: 'motor', color: 'color', color2: 'color', distance: 'distance' };
    function describe(p) {
      if (p.kind === 'motor') return p.motor + ' motor &middot; ' + p.pos + '&deg; &middot; ' + p.speed + '% speed';
      if (p.kind === 'color') return 'colour sensor &middot; ' + p.color + ' &middot; RGB ' + p.rgb.join(', ');
      if (p.kind === 'distance') return 'distance sensor &middot; ' + (p.mm < 0 ? 'nothing seen' : (p.mm / 10).toFixed(1) + ' cm');
      if (p.kind === 'force') return 'force sensor &middot; ' + p.value + (p.pressed ? ' (pressed)' : '');
      return 'light matrix';
    }
    function showStats() {
      const el = $('rrStats');
      if (!connected()) { el.innerHTML = '<span class="dim">Readings from the real hub appear here once it is connected.</span>'; return; }
      if (!devices) { el.innerHTML = '<span class="dim">Waiting for readings...</span>'; return; }
      const stale = performance.now() - lastDevices > 1500;
      const rows = ['<h3>Hub' + (stale ? ' <span class="bad">(no new readings)</span>' : '') + '</h3>'];
      rows.push('<span>Battery</span><span' + (devices.battery < 20 ? ' class="bad"' : '') + '>' + (devices.battery !== undefined ? devices.battery + '%' : '-') + '</span>');
      if (hub.info) rows.push('<span>Firmware</span><span>' + hub.info.firmware + '</span>');
      rows.push('<span>Program</span><span>' + (hubRunning ? 'running' : 'stopped') + '</span>');
      if (devices.imu) {
        const m = devices.imu, sc = gyro.scale || 0.1;
        rows.push('<h3>Gyro</h3>');
        rows.push('<span>Yaw &middot; pitch &middot; roll</span><span>' + [m.yaw, m.pitch, m.roll].map((v) => (v * sc).toFixed(1) + '&deg;').join(' &middot; ') + '</span>');
        rows.push('<span>Ghost turns with</span><span>' + (gyro.mode === 'gyro' ? 'the gyro (checked)' : gyro.mode === 'wheels' ? 'the wheels (gyro not turning)' : 'the wheels until the gyro is checked (turn the robot 30&deg;)') + '</span>');
      }
      rows.push('<h3>Ports</h3>');
      for (const port of HUB_PORTS) {
        const job = sim.build.ports[port], p = devices.ports[port];
        const want = KIND_OF_JOB[job];
        const ok = !want || (p && p.kind === want);
        const note = want ? ' <small class="dim">(simulator: ' + PORT_JOB[job] + ')</small>' : '';
        rows.push('<span>' + port + '</span><span' + (ok ? '' : ' class="bad"') + '>' + (p ? describe(p) : 'nothing plugged in') + note + '</span>');
      }
      el.innerHTML = rows.join('');
    }

    // ---- comparison chart: three small panels, simulator vs real robot ---------------------
    const tip = $('rrTip');
    let chartModel = null, hoverT = null;
    function speeds(samples, key) {
      const out = [];
      let j = 0;
      for (let i = 0; i < samples.length; i++) {
        while (j < i && samples[i].t - samples[j].t > 0.12) j++;
        const a = samples[j], b = samples[i];
        out.push([b.t, b.t - a.t > 0.01 ? (b[key] - a[key]) / (b.t - a.t) : 0]);
      }
      return out;
    }
    function turned(samples) {
      let prev = null, acc = 0;
      return samples.map((s) => { if (prev !== null) acc += ((s.h - prev + 540) % 360) - 180; prev = s.h; return [s.t, acc]; });
    }
    function drawChart() {
      const cv = $('rrChart'), wrap = $('rrChartWrap');
      const runs = { sim: live && live.samples.length > 1 ? live.samples : null, real: real && real.samples.length > 1 ? real.samples : null };
      wrap.hidden = !runs.sim && !runs.real;
      if (wrap.hidden) return;
      const panels = [
        { title: 'Left wheel speed', unit: 'cm/s', get: (s) => speeds(s, 'distL') },
        { title: 'Right wheel speed', unit: 'cm/s', get: (s) => speeds(s, 'distR') },
        { title: 'Turned since the start', unit: '°', get: turned },
      ].map((p) => ({ ...p, sim: runs.sim ? p.get(runs.sim) : [], real: runs.real ? p.get(runs.real) : [] }));
      const tMax = Math.max(1, ...panels.flatMap((p) => [p.sim, p.real].map((l) => (l.length ? l[l.length - 1][0] : 0))));
      const css = getComputedStyle(cv);
      const col = { sim: css.getPropertyValue('--sim-c').trim() || '#e8590c', real: css.getPropertyValue('--real-c').trim() || '#7048e8', fg: css.getPropertyValue('--fg').trim(), dim: css.getPropertyValue('--dim').trim(), grid: css.getPropertyValue('--card-shade').trim() };
      const W = cv.clientWidth || 600, ph = 120, gap = 34, top = 8;
      const Hh = top + panels.length * (ph + gap);
      const dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = Hh * dpr; cv.style.height = Hh + 'px';
      const c = cv.getContext('2d');
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, W, Hh);
      const left = 48, right = 40, plotW = W - left - right;
      const X = (t) => left + (t / tMax) * plotW;
      c.font = '12px system-ui, sans-serif';
      panels.forEach((p, i) => {
        const y0 = top + i * (ph + gap) + 18;
        const vals = [...p.sim, ...p.real].map((v) => v[1]);
        let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
        if (hi - lo < 1) hi = lo + 1;
        const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
        const Y = (v) => y0 + ph - ((v - lo) / (hi - lo)) * ph;
        Object.assign(p, { y0, Y, lo, hi });
        c.fillStyle = col.fg; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
        c.fillText(p.title + ' (' + p.unit + ')', left, y0 - 6);
        // recessive grid: zero line and the top/bottom values
        c.strokeStyle = col.grid; c.lineWidth = 1;
        for (const v of [lo, 0, hi]) { c.beginPath(); c.moveTo(left, Math.round(Y(v)) + 0.5); c.lineTo(left + plotW, Math.round(Y(v)) + 0.5); c.stroke(); }
        c.fillStyle = col.dim; c.textAlign = 'right'; c.textBaseline = 'middle';
        for (const v of [lo, 0, hi]) c.fillText(Math.round(v), left - 6, Y(v));
        for (const k of ['sim', 'real']) {
          const line = p[k];
          if (line.length < 2) continue;
          c.strokeStyle = col[k]; c.lineWidth = 2; c.lineJoin = 'round';
          c.beginPath();
          line.forEach(([t, v], j) => (j ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v))));
          c.stroke();
        }
      });
      // time axis under the last panel
      const last = panels[panels.length - 1];
      c.fillStyle = col.dim; c.textAlign = 'center'; c.textBaseline = 'top';
      const step = tMax > 40 ? 10 : tMax > 16 ? 5 : tMax > 6 ? 2 : 1;
      for (let t = 0; t <= tMax + 1e-6; t += step) c.fillText(t + ' s', X(t), last.y0 + ph + 6);
      if (hoverT !== null) {
        const x = X(hoverT);
        c.strokeStyle = col.dim; c.lineWidth = 1;
        c.beginPath(); c.moveTo(x + 0.5, top); c.lineTo(x + 0.5, last.y0 + ph); c.stroke();
        for (const p of panels) for (const k of ['sim', 'real']) {
          const v = at(p[k], hoverT);
          if (v === null) continue;
          c.fillStyle = col[k]; c.strokeStyle = getComputedStyle(document.body).getPropertyValue('--card-bg').trim() || '#fff'; c.lineWidth = 2;
          c.beginPath(); c.arc(x, p.Y(v), 4.5, 0, Math.PI * 2); c.fill(); c.stroke();
        }
      }
      chartModel = { panels, X, tMax, left, plotW };
      fillTable(panels);
    }
    function at(line, t) {
      if (!line.length || t < line[0][0] || t > line[line.length - 1][0]) return null;
      let lo = 0, hi = line.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (line[m][0] <= t) lo = m; else hi = m; }
      const [t0, v0] = line[lo], [t1, v1] = line[hi];
      return t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v0;
    }
    function fillTable(panels) {
      const rows = [];
      const step = chartModel.tMax > 30 ? 1 : 0.5;
      for (let t = 0; t <= chartModel.tMax; t += step) {
        const cells = panels.flatMap((p) => ['sim', 'real'].map((k) => { const v = at(p[k], t); return v === null ? '-' : v.toFixed(1); }));
        rows.push('<tr><td>' + t.toFixed(1) + '</td><td>' + cells.join('</td><td>') + '</td></tr>');
      }
      $('rrTable').innerHTML = '<thead><tr><th>Time (s)</th>' + panels.map((p) => '<th>' + p.title + ', sim</th><th>' + p.title + ', real</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody>';
    }
    $('rrChart').addEventListener('pointermove', (e) => {
      if (!chartModel) return;
      const b = e.currentTarget.getBoundingClientRect(), x = e.clientX - b.left;
      const t = ((x - chartModel.left) / chartModel.plotW) * chartModel.tMax;
      if (t < 0 || t > chartModel.tMax) { hoverT = null; tip.hidden = true; drawChart(); return; }
      hoverT = t;
      drawChart();
      const lines = chartModel.panels.map((p) => {
        const f = (k) => { const v = at(p[k], t); return v === null ? '-' : v.toFixed(1); };
        return '<div>' + p.title + ': <i class="sw sim"></i>' + f('sim') + ' <i class="sw real"></i>' + f('real') + ' ' + p.unit + '</div>';
      });
      tip.innerHTML = '<b>' + t.toFixed(2) + ' s</b>' + lines.join('');
      tip.hidden = false;
      const wrapB = $('rrChartWrap').getBoundingClientRect();
      const tx = e.clientX - wrapB.left + 14;
      tip.style.left = Math.min(tx, wrapB.width - tip.offsetWidth - 4) + 'px';
      tip.style.top = e.clientY - wrapB.top + 12 + 'px';
    });
    $('rrChart').addEventListener('pointerleave', () => { hoverT = null; tip.hidden = true; drawChart(); });

    // ---- drawing the ghost --------------------------------------------------------------------
    function ghostVisible() { return ghost.show && ghost.placed && connected(); }
    function draw2D(ctx, S) {
      if (!ghostVisible()) return;
      const css = getComputedStyle($('rrChart'));
      const colour = css.getPropertyValue('--real-c').trim() || '#7048e8';
      ctx.save();
      if (ghost.trail.length > 1) {
        ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ghost.trail.forEach(([x, y], i) => (i ? ctx.lineTo(x * S, y * S) : ctx.moveTo(x * S, y * S)));
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.translate(ghost.x * S, ghost.y * S);
      ctx.rotate(rad(ghost.h));
      const W = ROBOT.width * S, L = ROBOT.length * S;
      ctx.globalAlpha = 0.25; ctx.fillStyle = colour; ctx.fillRect(-W / 2, -L / 2, W, L);
      ctx.globalAlpha = 1; ctx.strokeStyle = colour; ctx.lineWidth = 2; ctx.strokeRect(-W / 2, -L / 2, W, L);
      ctx.beginPath(); ctx.moveTo(-W / 4, -L / 2 + 6); ctx.lineTo(0, -L / 2 - 4); ctx.lineTo(W / 4, -L / 2 + 6); ctx.stroke(); // front
      ctx.restore();
    }

    let lastStats = 0, lastChart = 0;
    function frame(now) {
      const v = app.view3d();
      if (v && v.setGhost) v.setGhost(ghostVisible() ? ghost : null);
      if (now - lastStats > 150) { lastStats = now; if ($('rrStats').offsetParent) showStats(); }
      if (phase === 'running' && now - lastChart > 500) { lastChart = now; if ($('rrChart').offsetParent) drawChart(); }
    }

    // ---- set up ----------------------------------------------------------------------------
    for (let i = 0; i < 20; i++) { const o = document.createElement('option'); o.value = i; o.textContent = 'Slot ' + i; $('rrSlot').appendChild(o); }
    $('rrGhost').checked = ghost.show;
    $('rrGhost').onchange = (e) => { ghost.show = e.target.checked; store.set('bioglow-ghost', ghost.show ? 'on' : 'off'); };
    $('rrRate').value = store.get('bioglow-rate') || '50';
    $('rrRate').onchange = (e) => { store.set('bioglow-rate', e.target.value); if (connected()) hub.setInterval(Number(e.target.value)).catch((err) => log(err.message)); };
    $('rrConnect').onclick = connect;
    $('rrBoth').onclick = runBoth;
    $('rrStop').onclick = stopAll;
    $('rrRunSlot').onclick = runSlot;
    $('rrPlace').onclick = () => { placeGhost(sim.launch); log('Ghost put at the launch spot'); };
    $('rrCopyLog').onclick = async () => {
      const text = [navigator.userAgent, 'Robot: ' + sim.build.model + ', ports ' + JSON.stringify(sim.build.ports), ...logLines].join('\n');
      try { await navigator.clipboard.writeText(text); $('rrCopyLog').textContent = 'Copied'; }
      catch (e) { const r = document.createRange(); r.selectNodeContents($('rrLog')); getSelection().removeAllRanges(); getSelection().addRange(r); $('rrCopyLog').textContent = 'Selected: press Ctrl+C'; }
      setTimeout(() => { $('rrCopyLog').textContent = 'Copy log'; }, 2500);
    };
    if (!H.SpikeHub.supported) {
      $('rrConnect').disabled = true;
      say('Connecting needs <b>Chrome or Edge</b> on a computer (they have Web Bluetooth). Safari and Firefox cannot connect to the hub.', 'bad');
    }
    refresh();
    showStats();
    log('Ready. ' + (H.SpikeHub.supported ? 'Web Bluetooth is available.' : 'This browser has no Web Bluetooth.'));

    return { onRun, afterStep, frame, draw2D, get phase() { return phase; }, debug: { get rec() { return rec; }, get live() { return live; }, get real() { return real; }, rowsOf, motorPorts } };
  }

  window.BioGlowReal = { init };
})();
