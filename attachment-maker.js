/* BIOGLOW attachment and robot makers (Robot tab): turn two photos of an attachment the team has built,
 * one from the side and one from above, into an attachment the simulator can use; or two photos of the
 * whole robot into the 3D model drawn for it. Each photo is cut out from its
 * plain background, scaled by the length the team types in, and turned into a grid of 4 mm cells; the
 * simulator (sim.js) makes the 3D shape from where both outlines are solid, fits it to a motor's axle and
 * swings it with that motor, so programs drive it like the real one.
 *
 * The background is found from the photo's edges (so the attachment must not touch them); the axle goes
 * in the hole nearest the robot end when the side photo shows one, or at that end otherwise. */
(function () {
  'use strict';
  const CELL = 0.4; // cm: grid cells are half a LEGO stud
  const MAX_PX = 420; // photos are shrunk to this many pixels along their longer side
  const $ = (id) => document.getElementById(id);

  // ---- cutting out --------------------------------------------------------------------
  // Foreground = pixels far enough in colour from every background colour: the photo's edges, plus any
  // the team tapped. Specks are removed, and only the big pieces are kept.
  function analyse(img, thr, extraBg) {
    const { width: w, height: h, data } = img;
    const edge = [];
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.02));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x >= band && y >= band && x < w - band && y < h - band) continue;
      const i = (y * w + x) * 4; edge.push([data[i], data[i + 1], data[i + 2]]);
    }
    const median = [0, 1, 2].map((c) => { const v = edge.map((p) => p[c]).sort((a, b) => a - b); return v[v.length >> 1]; });
    const bgs = [median, ...(extraBg || [])], t2 = thr * thr;
    let fg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      let d = Infinity;
      for (const [R, G, B] of bgs) d = Math.min(d, (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2);
      fg[i] = d > t2 ? 1 : 0;
    }
    fg = grow(shrink(fg, w, h), w, h); // remove specks one pixel across
    // pieces of foreground: keep the big ones
    const label = new Int32Array(w * h), comps = labelParts(fg, w, h, label, 1);
    const biggest = Math.max(0, ...comps.map((c) => c.area));
    const keep = new Set(comps.filter((c) => c.area >= Math.max(20, biggest * 0.15)).map((c) => c.id));
    for (let i = 0; i < w * h; i++) fg[i] = fg[i] && keep.has(label[i]) ? 1 : 0;
    // holes: background enclosed by the attachment (an axle hole shows up as one)
    const holeLabel = new Int32Array(w * h), holes = labelParts(fg, w, h, holeLabel, 0).filter((c) => !c.edge);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (fg[y * w + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { w, h, fg, data, bg: median, holes, bbox: x1 < 0 ? null : { x0, y0, x1, y1 }, touchesEdge: x1 >= 0 && (x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1) };
  }
  function shrink(m, w, h) {
    const o = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; o[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] ? 1 : 0; }
    return o;
  }
  function grow(m, w, h) {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = m[i] || (x > 0 && m[i - 1]) || (x < w - 1 && m[i + 1]) || (y > 0 && m[i - w]) || (y < h - 1 && m[i + w]) ? 1 : 0; }
    return o;
  }
  // 4-connected pieces of the pixels equal to `value`: [{ id, area, cx, cy, edge }]
  function labelParts(m, w, h, label, value) {
    const parts = [], stack = new Int32Array(w * h);
    let id = 0;
    for (let s = 0; s < w * h; s++) {
      if (m[s] !== value || label[s]) continue;
      id++;
      let n = 0, top = 0, sx = 0, sy = 0, edge = false;
      stack[top++] = s; label[s] = id;
      while (top) {
        const i = stack[--top], x = i % w, y = (i / w) | 0;
        n++; sx += x; sy += y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
        for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
          if (j >= 0 && m[j] === value && !label[j]) { label[j] = id; stack[top++] = j; }
        }
      }
      parts.push({ id, area: n, cx: sx / n, cy: sy / n, edge });
    }
    return parts;
  }

  // The cut-out as a grid `cells` long: { w, h, bits, rgb } (see attachmentVoxels in sim.js), and the
  // size of a cell in photo pixels.
  function toGrid(a, cells) {
    const b = a.bbox, bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1, px = bw / cells;
    const gw = cells, gh = Math.max(1, Math.round(bh / px));
    let bits = '', rgb = '';
    for (let k = 0; k < gh; k++) for (let i = 0; i < gw; i++) {
      let n = 0, on = 0, r = 0, g = 0, bl = 0;
      for (let y = Math.floor(b.y0 + k * px); y < Math.min(a.h, b.y0 + (k + 1) * px); y++) for (let x = Math.floor(b.x0 + i * px); x < Math.min(a.w, b.x0 + (i + 1) * px); x++) {
        n++;
        const j = y * a.w + x;
        if (!a.fg[j]) continue;
        on++; r += a.data[j * 4]; g += a.data[j * 4 + 1]; bl += a.data[j * 4 + 2];
      }
      const solid = n && on / n >= 0.4;
      bits += solid ? '1' : '0';
      rgb += solid ? [r, g, bl].map((v) => Math.round(v / on).toString(16).padStart(2, '0')).join('') : '000000';
    }
    return { grid: { w: gw, h: gh, bits, rgb }, px };
  }

  // ---- the two photo panels (side and top), shared by both makers ------------------------------
  // hooks: changed() after a photo or its cut-out changes; say(text, cls) for problems; tap(st, x, y)
  // for a tap on a photo that isn't picking background; overlay(st, g) to draw on top; end: the label
  // for the end that goes on the right.
  function photoPanels(box, hooks) {
    const photos = {};
    function photoState(view) {
      const fig = box.querySelector('.am-photo[data-view="' + view + '"]');
      const st = { view, fig, canvas: fig.querySelector('canvas'), video: fig.querySelector('video'), src: null, thr: 60, bg: [], a: null, pickBg: false, stream: null, pivot: null };
      const tool = (act) => fig.querySelector('[data-act="' + act + '"]');
      fig.querySelector('input[type=file]').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f), im = new Image();
        im.onload = () => { setSource(st, im); URL.revokeObjectURL(url); };
        im.onerror = () => hooks.say('That file could not be opened as a picture.', 'bad');
        im.src = url;
        e.target.value = '';
      });
      tool('camera').onclick = () => startCamera(st);
      tool('snap').onclick = () => snap(st);
      tool('flip').onclick = () => transform(st, 'flip');
      tool('rotate').onclick = () => transform(st, 'rotate');
      tool('thr').oninput = (e) => { st.thr = Number(e.target.value); update(st); };
      tool('bg').onclick = () => { st.pickBg = !st.pickBg; tool('bg').classList.toggle('down', st.pickBg); };
      st.canvas.addEventListener('click', (e) => {
        if (!st.a) return;
        const r = st.canvas.getBoundingClientRect();
        const x = Math.round(((e.clientX - r.left) / r.width) * st.canvas.width), y = Math.round(((e.clientY - r.top) / r.height) * st.canvas.height);
        if (st.pickBg) { // this colour is background too
          const i = (y * st.a.w + x) * 4;
          st.bg.push([st.a.data[i], st.a.data[i + 1], st.a.data[i + 2]]);
          st.pickBg = false; tool('bg').classList.remove('down');
          update(st);
        } else if (hooks.tap) hooks.tap(st, x, y);
      });
      return st;
    }

    // a photo (image, video frame or canvas), shrunk to MAX_PX
    function setSource(st, im) {
      const iw = im.videoWidth || im.naturalWidth || im.width, ih = im.videoHeight || im.naturalHeight || im.height;
      const k = Math.min(1, MAX_PX / Math.max(iw, ih));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(iw * k)); c.height = Math.max(1, Math.round(ih * k));
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      st.src = c; st.bg = []; st.pivot = null; st.pivotAuto = true;
      update(st);
    }
    function transform(st, how) {
      if (!st.src) return;
      const s = st.src, c = document.createElement('canvas'), g = c.getContext('2d');
      if (how === 'flip') { c.width = s.width; c.height = s.height; g.translate(s.width, 0); g.scale(-1, 1); }
      else { c.width = s.height; c.height = s.width; g.translate(s.height, 0); g.rotate(Math.PI / 2); }
      g.drawImage(s, 0, 0);
      st.src = c; st.pivot = null; st.pivotAuto = true;
      update(st);
    }
    async function startCamera(st) {
      stopCamera(st);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hooks.say('This browser cannot use the camera here. Use Choose photo instead.', 'bad'); return; }
      try {
        st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
      } catch (e) { hooks.say('The camera could not be opened (' + (e.message || e.name) + '). Use Choose photo instead.', 'bad'); return; }
      st.video.srcObject = st.stream;
      st.video.hidden = false; st.canvas.hidden = true;
      st.fig.querySelector('.am-empty').hidden = true;
      st.fig.querySelector('[data-act="snap"]').hidden = false;
      try { await st.video.play(); } catch (e) { /* plays once it has frames */ }
    }
    function snap(st) {
      if (!st.stream || !st.video.videoWidth) return;
      setSource(st, st.video);
      stopCamera(st);
    }
    function stopCamera(st) {
      if (st.stream) for (const t of st.stream.getTracks()) t.stop();
      st.stream = null;
      st.video.hidden = true; st.video.srcObject = null;
      st.fig.querySelector('[data-act="snap"]').hidden = true;
      st.canvas.hidden = !st.src;
      st.fig.querySelector('.am-empty').hidden = !!st.src;
    }

    function update(st) {
      if (!st.src) { draw(st); hooks.changed(); return; }
      const img = st.src.getContext('2d').getImageData(0, 0, st.src.width, st.src.height);
      st.a = analyse(img, st.thr, st.bg);
      st.fig.querySelector('[data-act="thr"]').value = st.thr;
      draw(st);
      hooks.changed();
    }

    // the photo with the background dimmed, the outline's box, and whatever the maker adds
    function draw(st) {
      const c = st.canvas, a = st.a;
      st.canvas.hidden = !st.src || !!st.stream;
      st.fig.querySelector('.am-empty').hidden = !!st.src || !!st.stream;
      if (!st.src || !a) return;
      c.width = a.w; c.height = a.h;
      const g = c.getContext('2d'), out = g.createImageData(a.w, a.h);
      for (let i = 0; i < a.w * a.h; i++) {
        const on = a.fg[i];
        for (let k = 0; k < 3; k++) out.data[i * 4 + k] = on ? a.data[i * 4 + k] : a.data[i * 4 + k] * 0.25 + 20;
        out.data[i * 4 + 3] = 255;
      }
      g.putImageData(out, 0, 0);
      if (a.bbox) {
        g.setLineDash([4, 3]); g.strokeStyle = '#48b9c7'; g.lineWidth = 1.5;
        g.strokeRect(a.bbox.x0 - 1.5, a.bbox.y0 - 1.5, a.bbox.x1 - a.bbox.x0 + 3, a.bbox.y1 - a.bbox.y0 + 3);
        g.setLineDash([]);
        g.fillStyle = '#48b9c7'; g.font = 'bold 13px system-ui, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'bottom';
        g.fillText(hooks.end + ' \u2192', a.w - 6, a.h - 6);
      }
      if (hooks.overlay) hooks.overlay(st, g);
    }

    // clears both panels, then loads saved photos ({ side: { src, thr, bg, ... }, top }) as they were cut out
    function load(saved, each) {
      for (const st of Object.values(photos)) { stopCamera(st); st.src = null; st.a = null; st.bg = []; st.pivot = null; st.pivotAuto = true; st.thr = 60; }
      for (const [view, p] of Object.entries(saved || {})) {
        const im = new Image();
        im.onload = () => {
          const st = photos[view];
          setSource(st, im);
          st.thr = p.thr || 60; st.bg = p.bg || [];
          if (each) each(st, p);
          update(st);
        };
        im.src = p.src;
      }
    }
    // the photos for saving, as JPEGs
    const jpeg = (st) => { try { return st.src.toDataURL('image/jpeg', 0.8); } catch (e) { return null; } };
    const stopAll = () => { for (const st of Object.values(photos)) stopCamera(st); };
    // the panels' warnings: nothing found, or touching the photo's edge
    function warn() {
      for (const st of Object.values(photos)) {
        const edge = st.a && st.a.bbox && st.a.touchesEdge;
        st.fig.querySelector('.am-warn').textContent = !st.src ? '' : !st.a || !st.a.bbox ? 'Nothing found: move the Cut-out slider left.' : edge ? 'It touches the edge of the photo: step back so there is background all round.' : '';
      }
    }

    photos.side = photoState('side');
    photos.top = photoState('top');
    return { photos, draw, load, jpeg, stopAll, warn };
  }
  const pxPerCm = (st, len) => (st.a && st.a.bbox && len ? (st.a.bbox.x1 - st.a.bbox.x0 + 1) / len : 0);

  // ---- the attachment maker ------------------------------------------------------------------
  function init(app) {
    const { sim } = app;
    const B = window.BioGlow;
    const box = $('amMaker');
    let editing = null, mountTouched = false, tryPos = 0;
    const panels = photoPanels(box, {
      end: 'far end',
      changed: () => refresh(),
      say: (text, cls) => say(text, cls),
      tap: (st, x, y) => { if (st.view === 'side') { st.pivot = [x, y]; st.pivotAuto = false; panels.draw(st); refresh(); } },
      overlay: (st, g) => { // the axle
        const piv = st.view === 'side' && currentPivot();
        if (!piv || box.querySelector('#amMount').value === 'fixed') return;
        g.strokeStyle = '#faa41a'; g.lineWidth = 2.5;
        g.beginPath(); g.arc(piv[0], piv[1], 7, 0, Math.PI * 2); g.stroke();
        g.beginPath(); g.moveTo(piv[0] - 11, piv[1]); g.lineTo(piv[0] + 11, piv[1]); g.moveTo(piv[0], piv[1] - 11); g.lineTo(piv[0], piv[1] + 11); g.stroke();
      },
    });
    const photos = panels.photos;

    // ---- sizes, fitting and the axle ----------------------------------------------------------
    const lengthCm = () => Math.max(0, Number($('amLen').value) || 0);
    const scale = (st) => pxPerCm(st, lengthCm());
    function holeForAxle() {
      const st = photos.side, k = scale(st);
      if (!st.a || !k) return null;
      const ok = st.a.holes.filter((hl) => { const d = (2 * Math.sqrt(hl.area / Math.PI)) / k; return d >= 0.3 && d <= 0.9; });
      ok.sort((p, q) => p.cx - q.cx); // nearest the robot end
      return ok[0] || null;
    }
    function autoPivot() {
      const a = photos.side.a, k = scale(photos.side);
      if (!a || !a.bbox || !k) return null;
      const hole = holeForAxle();
      if (hole) return { at: [hole.cx, hole.cy], why: 'in the hole nearest the robot end' };
      const b = a.bbox, bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      const mean = (x0, x1, y0, y1, axis) => {
        let s = 0, n = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (a.fg[y * a.w + x]) { s += axis ? y : x; n++; }
        return n ? s / n : null;
      };
      if (bh > bw * 1.5) { // a tall arm hangs from its top end
        const x = mean(b.x0, b.x1, b.y0, b.y0 + Math.ceil(bh * 0.1), 0);
        return { at: [x, b.y0 + 0.5 * k], why: 'at its top end' };
      }
      const y = mean(b.x0, b.x0 + Math.ceil(bw * 0.1), b.y0, b.y1, 1);
      return { at: [b.x0 + 0.5 * k, y], why: 'at the end nearest the robot' };
    }
    function currentPivot() {
      const st = photos.side;
      if (st.pivot && !st.pivotAuto) return st.pivot;
      const p = autoPivot();
      return p ? p.at : null;
    }
    // which motor (or none) it most likely goes on
    function suggestMount() {
      const ks = scale(photos.side), kt = scale(photos.top);
      const ports = Object.values(sim.build.ports);
      const motor = ports.includes('arm') ? 'arm' : ports.includes('spare') ? 'spare' : 'fixed';
      if (!ks || !kt) return { mount: motor, why: '' };
      const tall = (photos.side.a.bbox.y1 - photos.side.a.bbox.y0 + 1) / ks, wide = (photos.top.a.bbox.y1 - photos.top.a.bbox.y0 + 1) / kt;
      if (wide >= 0.6 * B.ROBOT.width && tall <= 6) return { mount: 'fixed', why: 'It is wide and low like a pusher, so it is fixed to the front.' };
      if (motor === 'fixed') return { mount: 'fixed', why: 'This robot has no attachment motor plugged in, so it is fixed to the front.' };
      return { mount: motor, why: 'It swings on motor ' + (motor === 'arm' ? 'C' : 'D') + ', the ' + (motor === 'arm' ? 'attachment' : 'spare') + ' motor.' };
    }

    // the attachment as it would be saved, or a reason it can't be yet
    function build() {
      const s = photos.side, t = photos.top, len = lengthCm();
      if (!s.a || !s.a.bbox) return { why: 'Add the photo from the side.' };
      if (!t.a || !t.a.bbox) return { why: 'Add the photo from above.' };
      if (!(len >= 2 && len <= 40)) return { why: 'Type in how long it is, between 2 and 40 cm.' };
      const cells = Math.max(2, Math.round(len / CELL));
      const sg = toGrid(s.a, cells), tg = toGrid(t.a, cells);
      if (sg.grid.h * CELL > 40 || tg.grid.h * CELL > 40) return { why: 'At that length it would be over 40 cm across: check the length.' };
      const mount = $('amMount').value, piv = currentPivot() || [s.a.bbox.x0, (s.a.bbox.y0 + s.a.bbox.y1) / 2];
      const def = {
        id: editing ? editing.id : 'photo-' + Date.now().toString(36),
        name: ($('amName').value || '').trim() || 'My attachment',
        cell: CELL, side: sg.grid, top: tg.grid, mount,
        pivot: [(piv[0] - s.a.bbox.x0) / sg.px, (piv[1] - s.a.bbox.y0) / sg.px],
        dir: Number($('amDir').value) || 1,
      };
      if (!$('amAuto').checked) def.start = Number($('amStart').value);
      if (!B.attachmentVoxels(def).count) return { why: 'The two outlines don’t overlap anywhere: check both photos have the far end on the right.' };
      return { def, why: '' };
    }

    function refresh() {
      const sug = suggestMount();
      if (!mountTouched && sug.mount) $('amMount').value = sug.mount;
      const fixed = $('amMount').value === 'fixed';
      const piv = autoPivot();
      $('amMountWhy').textContent = mountTouched ? '' : sug.why;
      $('amAxle').textContent = fixed ? 'Fixed attachments have no axle.' : photos.side.pivot && !photos.side.pivotAuto ? 'Where you tapped. Tap the side photo again to move it.' : piv ? 'Found ' + piv.why + '. Tap the side photo where the axle really goes.' : 'Tap the side photo where the motor’s axle goes in.';
      for (const id of ['amDir', 'amStart', 'amAuto', 'amTry']) $(id).disabled = fixed;
      $('amHoles').textContent = lengthCm() ? '= ' + (lengthCm() / 0.8).toFixed(1) + ' LEGO holes (studs) long' : '';
      panels.warn();
      panels.draw(photos.side);
      preview();
    }

    // side and top views of the robot with the attachment fitted, turned by the "Try the motor" slider
    function preview() {
      const res = build();
      $('amSave').disabled = !res.def;
      say(res.why, res.why ? '' : 'good', true);
      for (const id of ['amSideView', 'amTopView']) { const c = $(id); c.getContext('2d').clearRect(0, 0, c.width, c.height); }
      if (!res.def) { $('amTryNote').textContent = ''; return; }
      const def = res.def, sw = B.swingOf(def), R = B.ROBOT;
      const vox = B.attachmentVoxels(def, 1), pts0 = vox.cells.map(vox.at);
      let pos = tryPos;
      if (sw.range) pos = Math.max(sw.range[0], Math.min(sw.range[1], pos));
      const pts = B.swingPoints(sw, pts0, sw.angle(pos));
      if ($('amAuto').checked) $('amStart').value = Math.round(sw.start);
      $('amTryNote').textContent = def.mount === 'fixed' ? '' : 'Motor ' + (def.mount === 'arm' ? 'C' : 'D') + ' at ' + Math.round(pos) + '°' + (sw.range ? ' (it can turn from ' + Math.round(sw.range[0]) + '° to ' + Math.round(sw.range[1]) + '° before it hits the mat or the robot)' : '');
      const css = getComputedStyle(document.body), fg = css.getPropertyValue('--dim').trim(), acc = css.getPropertyValue('--accent').trim();
      const view = (id, pick, robotRect, ground) => {
        const c = $(id), W = c.clientWidth || 300, H = 170, dpr = window.devicePixelRatio || 1;
        c.width = W * dpr; c.height = H * dpr; c.style.height = H + 'px';
        const g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const xs = pts.map((p) => pick(p)[0]).concat([robotRect[0], robotRect[2]]), ys = pts.map((p) => pick(p)[1]).concat([robotRect[1], robotRect[3]]);
        const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys, ground ? 0 : Infinity), maxY = Math.max(...ys);
        const k = Math.min((W - 24) / (maxX - minX || 1), (H - 34) / (maxY - minY || 1));
        const X = (x) => 12 + (x - minX) * k, Y = (y) => H - 22 - (y - minY) * k;
        g.fillStyle = fg; g.font = '12px system-ui, sans-serif';
        if (ground) { g.strokeStyle = fg; g.lineWidth = 1; g.beginPath(); g.moveTo(0, Y(0) + 0.5); g.lineTo(W, Y(0) + 0.5); g.stroke(); g.fillText('mat', 4, Y(0) + 14); }
        g.strokeStyle = fg; g.lineWidth = 1.5; g.setLineDash([4, 3]);
        g.strokeRect(X(robotRect[0]), Y(robotRect[3]), (robotRect[2] - robotRect[0]) * k, (robotRect[3] - robotRect[1]) * k);
        g.setLineDash([]);
        g.fillText('robot', X(robotRect[0]) + 4, Y(robotRect[3]) + 14);
        g.fillStyle = acc;
        const s = Math.max(1.5, vox.cell * k);
        for (const p of pts) { const [x, y] = pick(p); g.fillRect(X(x) - s / 2, Y(y) - s / 2, s, s); }
        return { X, Y };
      };
      const side = view('amSideView', (p) => [p[0], p[2]], [-R.length / 2, 0.6, R.length / 2, R.height], true);
      if (def.mount !== 'fixed') { // the axle
        const g = $('amSideView').getContext('2d');
        g.fillStyle = '#faa41a'; g.beginPath(); g.arc(side.X(sw.spot.u), side.Y(sw.spot.z), 4, 0, Math.PI * 2); g.fill();
      }
      view('amTopView', (p) => [p[0], -p[1]], [-R.length / 2, -R.width / 2, R.length / 2, R.width / 2], false);
    }

    function say(text, cls, quiet) {
      const n = $('amMsg');
      n.textContent = text; n.className = 'rr-step ' + (cls || ''); n.hidden = !text || (quiet && cls === 'good');
    }

    function open(def) {
      editing = def || null;
      mountTouched = !!def;
      tryPos = 0; $('amTry').value = 0;
      $('amName').value = def ? def.name : '';
      $('amLen').value = def && def.len ? def.len : '';
      $('amMount').value = def ? def.mount : 'arm';
      $('amDir').value = def ? String(def.dir || 1) : '1';
      $('amAuto').checked = !def || def.start === undefined;
      $('amStart').value = def && def.start !== undefined ? def.start : 0;
      box.hidden = false;
      $('amNew').hidden = true;
      panels.load(def && def.photos, (st, p) => { if (st.view === 'side' && p.pivot) { st.pivot = p.pivot; st.pivotAuto = false; } });
      refresh();
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function close() {
      panels.stopAll();
      box.hidden = true;
      $('amNew').hidden = false;
      editing = null;
    }

    $('amLen').addEventListener('input', refresh);
    $('amName').addEventListener('input', () => preview());
    $('amMount').addEventListener('change', () => { mountTouched = true; refresh(); });
    $('amDir').addEventListener('change', refresh);
    $('amAuto').addEventListener('change', refresh);
    $('amStart').addEventListener('input', () => { $('amAuto').checked = false; preview(); });
    $('amTry').addEventListener('input', (e) => { tryPos = Number(e.target.value); preview(); });
    $('amCancel').onclick = close;
    $('amNew').onclick = () => open(null);
    $('amSave').onclick = () => {
      const res = build();
      if (!res.def) return;
      const def = res.def;
      def.len = lengthCm();
      def.photos = {
        side: { src: panels.jpeg(photos.side), thr: photos.side.thr, bg: photos.side.bg, pivot: photos.side.pivotAuto ? null : photos.side.pivot },
        top: { src: panels.jpeg(photos.top), thr: photos.top.thr, bg: photos.top.bg },
      };
      app.onSave(def);
      close();
    };
    return { open, close };
  }

  // ---- the robot maker ----------------------------------------------------------------------
  // Two photos of the whole robot (without its attachment), front on the right. The length the team
  // types in scales both; the width and height are measured from them. app.onSave(def) gets the model.
  function initRobot(app) {
    const B = window.BioGlow;
    const box = $('rmMaker');
    let editing = null;
    const panels = photoPanels(box, { end: 'front', changed: () => refresh(), say: (text, cls) => say(text, cls) });
    const photos = panels.photos;
    const lengthCm = () => Math.max(0, Number($('rmLen').value) || 0);

    // the robot as it would be saved, or a reason it can't be yet
    function build() {
      const s = photos.side, t = photos.top, len = lengthCm();
      if (!s.a || !s.a.bbox) return { why: 'Add the photo from the side.' };
      if (!t.a || !t.a.bbox) return { why: 'Add the photo from above.' };
      if (!(len >= 8 && len <= 40)) return { why: 'Type in how long the robot is, between 8 and 40 cm.' };
      const cells = Math.max(2, Math.round(len / CELL));
      const sg = toGrid(s.a, cells), tg = toGrid(t.a, cells);
      const size = { length: +(cells * CELL).toFixed(1), width: +(tg.grid.h * CELL).toFixed(1), height: +(sg.grid.h * CELL).toFixed(1) };
      if (size.width > 40 || size.height > 45) return { why: 'At that length it would be ' + size.width.toFixed(0) + ' cm wide and ' + size.height.toFixed(0) + ' cm tall: check the length.' };
      const def = {
        name: ($('rmName').value || '').trim() || 'My robot',
        cell: CELL, side: sg.grid, top: tg.grid, pivot: [cells / 2, sg.grid.h], size,
      };
      if (!B.attachmentVoxels(def).count) return { why: 'The two outlines don\u2019t overlap anywhere: check both photos have the front on the right.' };
      return { def, why: '' };
    }

    // the size it measures, and what the simulator can use (its robot body is a box within BUILD_LIMITS)
    function sizeNote(size) {
      const L = B.BUILD_LIMITS, out = [];
      const check = (v, [lo, hi], what) => { if (v < lo || v > hi) out.push(what + ' ' + (v < lo ? 'at least ' + lo : 'at most ' + hi) + ' cm'); };
      check(size.length, L.length, 'long'); check(size.width, L.width, 'wide'); check(size.height, L.height, 'tall');
      return size.length.toFixed(1) + ' \u00d7 ' + size.width.toFixed(1) + ' \u00d7 ' + size.height.toFixed(1) + ' cm (length \u00d7 width \u00d7 height)' +
        (out.length ? '. The simulator\u2019s robot can only be ' + out.join(', ') + ', so it bumps into things as if it were that size.' : '');
    }

    function refresh() {
      panels.warn();
      $('rmHoles').textContent = lengthCm() ? '= ' + (lengthCm() / 0.8).toFixed(1) + ' LEGO holes (studs) long' : '';
      const res = build();
      $('rmSave').disabled = !res.def;
      say(res.why, res.why ? '' : 'good', true);
      $('rmSize').textContent = res.def ? sizeNote(res.def.size) : '';
      // what the model looks like from the side and from above: the two cut-outs, in their colours
      for (const [id, view] of [['rmSideView', 'side'], ['rmTopView', 'top']]) {
        const c = $(id), W = c.clientWidth || 300, H = 150, dpr = window.devicePixelRatio || 1;
        c.width = W * dpr; c.height = H * dpr; c.style.height = H + 'px';
        const g = c.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, W, H);
        if (!res.def) continue;
        const m = res.def[view], k = Math.min((W - 20) / m.w, (H - 20) / m.h), x0 = (W - m.w * k) / 2, y0 = (H - m.h * k) / 2;
        for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
          if (m.bits.charCodeAt(j * m.w + i) !== 49) continue;
          g.fillStyle = '#' + m.rgb.substr((j * m.w + i) * 6, 6);
          g.fillRect(x0 + i * k, y0 + j * k, Math.ceil(k), Math.ceil(k));
        }
        if (view === 'side') { // the mat
          g.strokeStyle = getComputedStyle(document.body).getPropertyValue('--dim').trim(); g.lineWidth = 1;
          g.beginPath(); g.moveTo(0, y0 + m.h * k + 0.5); g.lineTo(W, y0 + m.h * k + 0.5); g.stroke();
        }
      }
    }

    function say(text, cls, quiet) {
      const n = $('rmMsg');
      n.textContent = text; n.className = 'rr-step ' + (cls || ''); n.hidden = !text || (quiet && cls === 'good');
    }

    function open(def) {
      editing = def || null;
      $('rmName').value = def ? def.name : '';
      $('rmLen').value = def && def.size ? def.size.length : '';
      panels.load(def && def.photos);
      box.hidden = false;
      $('rmNew').hidden = true;
      refresh();
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    function close() {
      panels.stopAll();
      box.hidden = true;
      $('rmNew').hidden = false;
      editing = null;
    }

    $('rmLen').addEventListener('input', refresh);
    $('rmName').addEventListener('input', refresh);
    $('rmCancel').onclick = close;
    $('rmNew').onclick = () => open(null);
    $('rmSave').onclick = () => {
      const res = build();
      if (!res.def) return;
      const def = res.def;
      def.photos = {
        side: { src: panels.jpeg(photos.side), thr: photos.side.thr, bg: photos.side.bg },
        top: { src: panels.jpeg(photos.top), thr: photos.top.thr, bg: photos.top.bg },
      };
      app.onSave(def);
      close();
    };
    return { open, close };
  }

  window.BioGlowMaker = { init, initRobot, analyse, toGrid, CELL };
})();
