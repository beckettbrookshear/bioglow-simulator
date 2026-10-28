/* BIOGLOW FLL robot simulator - 3D view (three.js r128, loaded from a CDN in index.html).
 * Sim coordinates map to world as: x -> x, y -> z, height -> y (up). Heading 0 faces -z.
 * Mission models are built from LEGO-sized parts (studded bricks, Technic beams, minifigs) to look
 * like the official BIOGLOW builds, sized to the wireframe footprints. They are visual only; the
 * physics uses the footprints and push pads in sim.js.
 * If three.js didn't load (e.g. offline), BioGlow3D stays undefined and app.js uses the 2D view.
 */
(function () {
  'use strict';
  if (!window.THREE || !THREE.OrbitControls) return;
  const { FIELD, ROBOT, MAT, PHYS, DRONE, ATTACHMENTS, attachmentVoxels } = window.BioGlow;
  const rad = (d) => (d * Math.PI) / 180;

  const WALL = { h: 7.6, t: 3.8 }; // 2x4 lumber border, laid on edge

  // ---- LEGO parts library ------------------------------------------------------
  const U = 0.8, PLATE = 0.32, BRICK = 0.96; // stud pitch and heights (cm)
  const mats = {};
  // ABS plastic: a glossy clear-coat over a slightly soft base, reflecting the room around it.
  // Handled plastic isn't perfectly smooth: faint mottling and hairline scratches break up the highlights.
  let wearTex = null;
  const plasticWear = () => {
    if (wearTex) return wearTex;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d'), img = g.createImageData(256, 256);
    for (let i = 0; i < 256 * 256; i++) { const v = 222 + Math.floor(Math.random() * 22); img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
    g.putImageData(img, 0, 0);
    g.lineWidth = 0.6;
    for (let i = 0; i < 60; i++) {
      g.strokeStyle = 'rgba(255,255,255,' + (0.15 + Math.random() * 0.3) + ')';
      const x = Math.random() * 256, y = Math.random() * 256, a = Math.random() * Math.PI, l = 8 + Math.random() * 30;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    wearTex = new THREE.CanvasTexture(c);
    wearTex.wrapS = wearTex.wrapT = THREE.RepeatWrapping;
    return wearTex;
  };
  const plastic = (hex, extra) => {
    const key = hex + JSON.stringify(extra || {});
    if (!mats[key]) {
      const clear = extra && extra.transparent;
      mats[key] = new THREE.MeshPhysicalMaterial(Object.assign({
        color: hex, roughness: 0.34, metalness: 0, clearcoat: 0.55, clearcoatRoughness: 0.14, envMapIntensity: 0.55,
        roughnessMap: clear ? null : plasticWear(),
      }, extra));
    }
    return mats[key];
  };
  const L = {
    white: plastic('#f2f3f2'), black: plastic('#1b1d1f'), lbg: plastic('#a3a6a8'), dbg: plastic('#6b6e6c'),
    red: plastic('#c91a09'), darkRed: plastic('#7a1212'), yellow: plastic('#f2cd37'), orange: plastic('#fe8a18'),
    lime: plastic('#bbe90b'), green: plastic('#237841'), brightGreen: plastic('#4b9f4a'), darkGreen: plastic('#184632'),
    olive: plastic('#9b9a5a'), tan: plastic('#e4cd9e'), darkTan: plastic('#958a73'), brown: plastic('#582a12'), rbrown: plastic('#8a4a2b'),
    nougat: plastic('#aa7d55'), azure: plastic('#078bc9'), medAzure: plastic('#36aebf'), teal: plastic('#069d9f'),
    magenta: plastic('#c8307c'), pink: plastic('#fc97ac'), purple: plastic('#7a4fbf'), skin: plastic('#f6d7b3'),
    figYellow: plastic('#ffd52b'), trans: plastic('#d9f2ff', { transparent: true, opacity: 0.45, roughness: 0.05 }),
    transRed: plastic('#ff3b3b', { transparent: true, opacity: 0.7, roughness: 0.1 }), steel: plastic('#c9ced3', { metalness: 0.8, roughness: 0.25 }),
    rubber: plastic('#141414', { roughness: 0.85, clearcoat: 0 }), wheelAzure: plastic('#68c3e2', { roughness: 0.7, clearcoat: 0.1 }), holeDark: plastic('#1e2022', { roughness: 0.8, clearcoat: 0 }),
  };
  const geoCache = {};
  const cached = (key, make) => geoCache[key] || (geoCache[key] = make());
  // Studs have a small chamfer on top so they catch a highlight, like real ones.
  const studGeo = cached('stud', () => new THREE.LatheGeometry([
    new THREE.Vector2(0, -0.085), new THREE.Vector2(0.24, -0.085), new THREE.Vector2(0.24, 0.06),
    new THREE.Vector2(0.225, 0.082), new THREE.Vector2(0.2, 0.085), new THREE.Vector2(0, 0.085)], 18));
  // Bricks get slightly rounded edges (moulded plastic is never perfectly sharp).
  const boxGeo = (w, h, d) => (THREE.RoundedBoxGeometry ? new THREE.RoundedBoxGeometry(w, h, d, 2, Math.min(0.06, h / 4, w / 4, d / 4)) : new THREE.BoxGeometry(w, h, d));
  const holeGeo = cached('hole', () => new THREE.CylinderGeometry(0.24, 0.24, 0.74, 12));

  function shadowy(o) { o.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } }); return o; }

  // A brick or plate nx x nz studs, `plates` tall (3 plates = 1 brick), bottom at y.
  // Real models are built from standard parts, so a big block is laid as 2-wide bricks up to 4 long
  // (plates up to 8 x 8), staggered course by course like a wall, with a seam between each piece.
  const runs = (n, max, offset) => {
    const out = [];
    let left = n;
    if (offset && n > max) { out.push(offset); left -= offset; }
    while (left > 0) { const k = Math.min(max, left); out.push(k); left -= k; }
    return out;
  };
  function brick(nx, nz, plates, mat, x, y, z, opts) {
    const o = opts || {};
    const g = new THREE.Group();
    const h = plates * PLATE;
    const longX = nx >= nz, nl = longX ? nx : nz, nw = longX ? nz : nx;
    const isBrick = plates >= 3, maxLong = o.whole ? nl : isBrick ? 4 : 8, maxWide = o.whole ? nw : isBrick ? 2 : 8; // `whole`: one moulded part
    const course = Math.round((y || 0) / BRICK);
    let w0 = 0;
    runs(nw, maxWide, 0).forEach((sw, si) => {
      let l0 = 0;
      for (const sl of runs(nl, maxLong, (course + si) % 2 ? 2 : 0)) {
        const px = longX ? sl : sw, pz = longX ? sw : sl;
        const piece = new THREE.Mesh(cached('b' + px + 'x' + pz + 'x' + plates, () => boxGeo(px * U - 0.035, h, pz * U - 0.035)), mat);
        const cl = l0 + sl / 2, cw = w0 + sw / 2;
        piece.position.set(((longX ? cl : cw) - nx / 2) * U, h / 2, ((longX ? cw : cl) - nz / 2) * U);
        g.add(piece);
        l0 += sl;
      }
      w0 += sw;
    });
    if (o.studs !== false) {
      const studs = new THREE.InstancedMesh(studGeo, mat, nx * nz);
      const m = new THREE.Matrix4();
      let i = 0;
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        m.makeTranslation((a - (nx - 1) / 2) * U, h + 0.085, (b - (nz - 1) / 2) * U);
        studs.setMatrixAt(i++, m);
      }
      g.add(studs);
    }
    g.position.set(x || 0, y || 0, z || 0);
    if (o.ry) g.rotation.y = o.ry;
    return shadowy(g);
  }
  const tile = (nx, nz, mat, x, y, z, opts) => brick(nx, nz, 1, mat, x, y, z, Object.assign({ studs: false }, opts));
  const plate = (nx, nz, mat, x, y, z, opts) => brick(nx, nz, 1, mat, x, y, z, opts);

  // A flat upright panel n studs wide and h cm tall, standing on y = 0.
  function panel(n, h, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(n * U - 0.02, h, PLATE), mat);
    m.position.y = h / 2;
    const g = new THREE.Group(); g.add(m);
    return shadowy(g);
  }

  // A round brick/plate/tile, radius in studs.
  function round(rStuds, plates, mat, x, y, z, studs) {
    const g = new THREE.Group();
    const h = plates * PLATE, r = rStuds * U - 0.01;
    const body = new THREE.Mesh(cached('r' + rStuds + 'x' + plates, () => new THREE.CylinderGeometry(r, r, h, 24)), mat);
    body.position.y = h / 2;
    g.add(body);
    if (studs) { const st = new THREE.Mesh(studGeo, mat); st.position.y = h + 0.085; g.add(st); }
    g.position.set(x || 0, y || 0, z || 0);
    return shadowy(g);
  }

  // A Technic beam `holes` long along local X (holes run along Z), centred at x,y,z.
  function beam(holes, mat, x, y, z, opts) {
    const o = opts || {};
    const g = new THREE.Group();
    const len = holes * U;
    const body = new THREE.Mesh(cached('beam' + holes, () => boxGeo(len - 0.08, 0.72, 0.72)), mat);
    g.add(body);
    for (const end of [-1, 1]) {
      const cap = new THREE.Mesh(cached('cap', () => new THREE.CylinderGeometry(0.36, 0.36, 0.72, 14)), mat);
      cap.rotation.x = Math.PI / 2;
      cap.position.x = end * (len / 2 - 0.04);
      g.add(cap);
    }
    const holesMesh = new THREE.InstancedMesh(holeGeo, L.holeDark, holes);
    const m = new THREE.Matrix4(), r90 = new THREE.Matrix4().makeRotationX(Math.PI / 2);
    for (let i = 0; i < holes; i++) { m.makeTranslation((i - (holes - 1) / 2) * U, 0, 0).multiply(r90); holesMesh.setMatrixAt(i, m); }
    g.add(holesMesh);
    g.position.set(x || 0, y || 0, z || 0);
    if (o.ry) g.rotation.y = o.ry;
    if (o.rz) g.rotation.z = o.rz;
    if (o.rx) g.rotation.x = o.rx;
    return shadowy(g);
  }
  const post = (holes, mat, x, y, z) => beam(holes, mat, x, y + (holes * U) / 2, z, { rz: Math.PI / 2 });

  // Studs on a grid of nx x nz, centred, at height y (local to a group).
  function studGrid(g, nx, nz, mat, y, keep) {
    const m = new THREE.Matrix4(), at = [];
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      const x = (a - (nx - 1) / 2) * U, z = (b - (nz - 1) / 2) * U;
      if (!keep || keep(x, z)) at.push([x, z]);
    }
    const studs = new THREE.InstancedMesh(studGeo, mat, Math.max(1, at.length));
    at.forEach(([x, z], i) => { m.makeTranslation(x, y + 0.085, z); studs.setMatrixAt(i, m); });
    studs.count = at.length;
    g.add(studs);
  }

  // A 1 x n Technic brick, long along local x, with n-1 holes through it along z (centres 0.58 cm up).
  function techBrick(n, mat, x, y, z, opts) {
    const g = brick(n, 1, 3, mat, 0, 0, 0, { whole: true });
    const ring = cached('techRing', () => new THREE.RingGeometry(0.24, 0.31, 16));
    const hole = cached('techHole', () => new THREE.CircleGeometry(0.24, 16));
    for (let i = 0; i < n - 1; i++) for (const s of [-1, 1]) {
      const hx = (i - (n - 2) / 2) * U;
      const r = new THREE.Mesh(ring, mat); r.position.set(hx, 0.58, s * (U / 2 + 0.012)); r.rotation.y = s < 0 ? Math.PI : 0; g.add(r);
      const h = new THREE.Mesh(hole, L.holeDark); h.position.set(hx, 0.58, s * (U / 2 + 0.006)); h.rotation.y = s < 0 ? Math.PI : 0; g.add(h);
    }
    g.position.set(x || 0, y || 0, z || 0);
    if (opts && opts.ry) g.rotation.y = opts.ry;
    return shadowy(g);
  }

  // A Technic pin `len` studs long along local z, centred at its middle (with a collar at `collar`).
  function pin(len, mat, x, y, z, collar) {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(cached('pin' + len, () => new THREE.CylinderGeometry(0.23, 0.23, len * U - 0.04, 12)), mat);
    shaft.rotation.x = Math.PI / 2; g.add(shaft);
    const c = new THREE.Mesh(cached('pinCollar', () => new THREE.CylinderGeometry(0.29, 0.29, 0.1, 12)), mat);
    c.rotation.x = Math.PI / 2; c.position.z = collar || 0; g.add(c);
    g.position.set(x || 0, y || 0, z || 0);
    return shadowy(g);
  }

  // Bricks with a shaped side profile (in local x-y, extruded along z), bottom at y. `profile` lists
  // [x, y] corners; studs go on the flat top over the x range `studX`.
  function shaped(profile, nz, mat, studX, x, y, z, ry) {
    const g = new THREE.Group();
    const geo = cached('shp' + JSON.stringify(profile) + nz, () => {
      const sh = new THREE.Shape(profile.map(([px, py]) => new THREE.Vector2(px, py)));
      const e = new THREE.ExtrudeGeometry(sh, { depth: nz * U - 0.02, bevelEnabled: false, curveSegments: 10 });
      e.translate(0, 0, -(nz * U - 0.02) / 2);
      return e;
    });
    g.add(new THREE.Mesh(geo, mat));
    if (studX) {
      const top = Math.max(...profile.map((p) => p[1]));
      const sx = new THREE.Group();
      const n = Math.round((studX[1] - studX[0]) / U);
      studGrid(sx, n, nz, mat, top);
      sx.position.x = (studX[0] + studX[1]) / 2;
      g.add(sx);
    }
    g.position.set(x || 0, y || 0, z || 0);
    if (ry) g.rotation.y = ry;
    return shadowy(g);
  }
  // 45 degree slope n deep (falling towards +x), one row of studs at the back
  const slope = (n, nz, mat, x, y, z, ry) => shaped([[-n * U / 2, 0], [n * U / 2, 0], [n * U / 2, PLATE], [-n * U / 2 + U, BRICK], [-n * U / 2, BRICK]], nz, mat, [-n * U / 2, -n * U / 2 + U], x, y, z, ry);
  // curved slope n deep, 2/3 brick tall, smooth top falling towards +x
  const curve = (n, nz, mat, x, y, z, ry) => {
    const w = n * U, h = 2 * PLATE, pts = [[-w / 2, 0], [w / 2, 0], [w / 2, 0.08]];
    for (let i = 1; i <= 8; i++) { const t = i / 8; pts.push([w / 2 - w * (1 - Math.cos(t * Math.PI / 2)), 0.08 + (h - 0.08) * Math.sin(t * Math.PI / 2)]); }
    pts.push([-w / 2, h]);
    return shaped(pts, nz, mat, null, x, y, z, ry);
  };
  // inverted curved slope 1 deep: a brick whose underside curves up towards +x
  const invCurve = (nz, mat, x, y, z, ry) => {
    const w = U, pts = [[-w / 2, 0], [-w / 2, BRICK], [w / 2, BRICK], [w / 2, BRICK - 0.12]];
    for (let i = 1; i <= 8; i++) { const t = i / 8; pts.push([w / 2 - w * Math.sin(t * Math.PI / 2), (BRICK - 0.12) * Math.cos(t * Math.PI / 2)]); }
    return shaped(pts, nz, mat, [-w / 2, w / 2], x, y, z, ry);
  };

  // A round plate n studs across (studs where they fit), `plates` thick, bottom at y.
  function discPlate(n, plates, mat, x, y, z, studs) {
    const g = new THREE.Group(), r = (n * U) / 2 - 0.01, h = plates * PLATE;
    const body = new THREE.Mesh(cached('disc' + n + 'x' + plates, () => new THREE.CylinderGeometry(r, r, h, 40)), mat);
    body.position.y = h / 2; g.add(body);
    if (studs !== false) studGrid(g, n, n, mat, h, (sx, sz) => Math.hypot(sx, sz) <= r - 0.3);
    g.position.set(x || 0, y || 0, z || 0);
    return shadowy(g);
  }

  // A 3x3 round corner plate: a quarter disc with its square corner at the local origin, filling +x +z.
  function cornerPlate(mat, x, y, z, ry) {
    const g = new THREE.Group(), R = 3 * U - 0.01;
    const geo = cached('corner3', () => {
      const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(R, 0); sh.absarc(0, 0, R, 0, Math.PI / 2, false); sh.lineTo(0, 0);
      const e = new THREE.ExtrudeGeometry(sh, { depth: PLATE, bevelEnabled: false, curveSegments: 16 });
      e.rotateX(Math.PI / 2); e.translate(0, PLATE, 0);
      return e;
    });
    g.add(new THREE.Mesh(geo, mat));
    const sg = new THREE.Group(); studGrid(sg, 3, 3, mat, PLATE, (sx, sz) => Math.hypot(sx + 1.2, sz + 1.2) <= R - 0.3);
    sg.position.set(1.2, 0, 1.2); g.add(sg);
    g.position.set(x || 0, y || 0, z || 0);
    if (ry) g.rotation.y = ry;
    return shadowy(g);
  }

  // A round 2x2 tile / plate (radius 1 stud) and a 1x1 round, bottom at y.
  const round2 = (mat, x, y, z, studs) => round(1, 1, mat, x, y, z, studs);
  const round1 = (mat, x, y, z, plates) => round(0.5, plates || 1, mat, x, y, z, true);

  // Flexible tube (vines, roots, cables) through points [[x,y,z],...].
  function tube(points, r, mat, closed) {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), !!closed);
    return shadowy(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(12, points.length * 10), r, 8, !!closed), mat));
  }

  // A leaf: flattened, pointed ellipsoid.
  function leaf(len, width, mat, x, y, z, ry, tilt) {
    const m = new THREE.Mesh(cached('leaf', () => new THREE.SphereGeometry(1, 12, 8)), mat);
    m.scale.set(len / 2, 0.12, width / 2);
    m.position.set(x, y, z);
    m.rotation.set(0, ry || 0, tilt || 0);
    return shadowy(m);
  }

  // A cluster of leaves and plates for tree tops and bushes.
  function canopy(r, y, palette, count, seed) {
    const g = new THREE.Group();
    let s = seed || 1;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r;
      const mat = palette[i % palette.length];
      g.add(leaf(2 + rnd() * 2.5, 1.2 + rnd(), mat, Math.cos(a) * d, y + rnd() * 2.5, Math.sin(a) * d, a, (rnd() - 0.5) * 0.8));
    }
    return g;
  }

  // A minifigure about 4 cm tall, facing -z. opts: seated (legs forward, bottom at y), helmet (colour).
  function minifig(torso, legs, hair, x, y, z, ry, opts) {
    const o = opts || {};
    const g = new THREE.Group();
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(cached('leg', () => new THREE.BoxGeometry(0.46, 1.25, 0.6)), legs);
      leg.position.set(s * 0.25, 0.62, 0);
      if (o.seated) { leg.rotation.x = Math.PI / 2; leg.position.set(s * 0.25, 0.95, -0.33); }
      g.add(leg);
    }
    const hips = new THREE.Mesh(cached('hips', () => new THREE.BoxGeometry(1.0, 0.3, 0.6)), legs); hips.position.y = 1.38; g.add(hips);
    const t = new THREE.Mesh(cached('torso', () => new THREE.CylinderGeometry(0.42, 0.62, 1.25, 4, 1)), torso);
    t.rotation.y = Math.PI / 4; t.scale.z = 0.6; t.position.y = 2.15; g.add(t);
    for (const s of [-1, 1]) {
      const arm = new THREE.Mesh(cached('arm', () => new THREE.CylinderGeometry(0.17, 0.17, 1.0, 8)), torso);
      arm.position.set(s * 0.62, 2.1, -0.1); arm.rotation.set(-0.4, 0, s * 0.15); g.add(arm);
      const hand = new THREE.Mesh(cached('hand', () => new THREE.SphereGeometry(0.17, 8, 6)), L.figYellow);
      hand.position.set(s * 0.68, 1.62, -0.32); g.add(hand);
    }
    const head = new THREE.Mesh(cached('head', () => new THREE.CylinderGeometry(0.36, 0.36, 0.72, 16)), L.figYellow); head.position.y = 3.15; g.add(head);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(cached('eye', () => new THREE.SphereGeometry(0.06, 6, 4)), L.black);
      eye.position.set(s * 0.14, 3.22, -0.34); g.add(eye);
    }
    if (hair) { const hr = new THREE.Mesh(cached('hair', () => new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)), hair); hr.position.y = 3.45; g.add(hr); }
    if (o.helmet) { // full-face helmet with a dark visor
      const hm = new THREE.Mesh(cached('helmet', () => new THREE.SphereGeometry(0.56, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62)), o.helmet);
      hm.position.y = 3.1; g.add(hm);
      const visor = new THREE.Mesh(cached('visor', () => new THREE.SphereGeometry(0.58, 16, 8, Math.PI * 1.2, Math.PI * 0.6, Math.PI * 0.32, Math.PI * 0.22)), L.black);
      visor.position.y = 3.1; g.add(visor);
    }
    g.position.set(x || 0, (y || 0) - (o.seated ? 0.65 : 0), z || 0);
    g.rotation.y = ry || 0;
    return shadowy(g);
  }

  // Ease a numeric property toward a target each frame (e.g. 'rotation.x').
  function ease(obj, path, target) {
    const [a, b] = path.split('.');
    obj[a][b] += (target - obj[a][b]) * 0.15;
  }

  // Centre, size and rotation of a convex footprint polygon from sim.js.
  function footprint(shape) {
    const cx = shape.reduce((s, p) => s + p[0], 0) / shape.length;
    const cy = shape.reduce((s, p) => s + p[1], 0) / shape.length;
    if (shape.length > 4) {
      const r = Math.hypot(shape[0][0] - cx, shape[0][1] - cy);
      return { cx, cy, w: r * 2, d: r * 2, ang: 0, r };
    }
    const ex = shape[1][0] - shape[0][0], ey = shape[1][1] - shape[0][1];
    const fx = shape[2][0] - shape[1][0], fy = shape[2][1] - shape[1][1];
    return { cx, cy, w: Math.hypot(ex, ey), d: Math.hypot(fx, fy), ang: Math.atan2(ey, ex) };
  }
  const studsFor = (cm) => Math.max(1, Math.floor(cm / U));

  // ---- mission models: local x = footprint width, local z = depth (+z = south), centred -------
  // Each returns { group, update(state, sim) } where update animates parts toward the model's state.
  const padMax = (st, key) => (st && st.pads && st.pads[key] ? st.pads[key].max : 0);
  const padDone = (st, key) => padMax(st, key) >= 0.9;
  // ---- M01 drone rig (bags 1 and 2 of the official instructions; sizes match DRONE in sim.js) -----

  // Red cable anchor: 4x6 plate on four 2x2 round plates, long along local x. -x faces the drone; the
  // pins for the legs stick out the sides at the middle.
  function anchorModel() {
    const g = new THREE.Group();
    for (const x of [-1.6, 1.6]) for (const z of [-0.8, 0.8]) g.add(round(1, 1, L.red, x, 0, z));
    g.add(plate(6, 4, L.red, 0, PLATE, 0));
    const y = 2 * PLATE;
    g.add(slope(2, 2, L.red, 1.6, y, -0.8), slope(2, 2, L.red, 1.6, y, 0.8)); // sloping away from the drone
    for (const s of [-1, 1]) g.add(techBrick(2, L.red, 0, y, s * 1.2), pin(2, L.yellow, 0, y + 0.58, s * 1.6));
    g.add(brick(2, 2, 3, L.red, 0, y, 0), brick(2, 4, 3, L.red, -1.6, y, 0));
    g.add(brick(1, 4, 3, L.red, -0.4, y + BRICK, 0), brick(2, 4, 3, L.red, -1.6, y + BRICK, 0), tile(2, 4, L.red, -1.6, y + 2 * BRICK, 0));
    return shadowy(g);
  }

  // The drone, with its origin on the axis of its two tan pins; local x along the legs, pins along z.
  function droneModel() {
    const g = new THREE.Group();
    const b = -DRONE.restPin; // bottom of its feet
    const aqua = plastic('#bfeee6', { transparent: true, opacity: 0.6, roughness: 0.08 });
    g.add(brick(2, 2, 3, aqua, 0, b, 0), brick(2, 2, 3, aqua, 0, b + BRICK, 0)); // feet
    g.add(plate(2, 4, L.medAzure, 0, b + 2 * BRICK, 0));
    const y1 = b + 2 * BRICK + PLATE;
    g.add(invCurve(2, L.black, 1.2, y1, 0), invCurve(2, L.black, -1.2, y1, 0, Math.PI), brick(2, 2, 3, L.red, 0, y1, 0));
    for (const s of [-1, 1]) { // cameras: Technic bricks with a red pin and a round tile lens
      g.add(techBrick(2, L.dbg, 0, y1, s * 1.2));
      const lens = new THREE.Mesh(cached('lens', () => new THREE.CylinderGeometry(0.36, 0.36, 0.16, 16)), L.dbg);
      lens.rotation.x = Math.PI / 2; lens.position.set(0, y1 + 0.58, s * 1.78); g.add(lens);
    }
    const y2 = y1 + BRICK;
    g.add(plate(2, 6, L.white, 0, y2, 0));
    for (const s of [-1, 1]) g.add(techBrick(2, L.white, 0, y2 + PLATE, s * 2.0), pin(3, L.tan, 0, 0, s * 2.8, -s * 0.4));
    const y3 = y2 + PLATE + BRICK;
    for (let i = 0; i < 4; i++) g.add(cornerPlate(L.white, 0, y3, 0, (i * Math.PI) / 2)); // rotor arms
    for (const x of [-1.6, 1.6]) for (const z of [-1.6, 1.6]) {
      g.add(round(1, 1, L.black, x, y3 + PLATE, z));
      const ring = new THREE.Mesh(cached('rotorRing', () => new THREE.RingGeometry(0.36, 0.44, 20)), L.lbg);
      ring.rotation.x = -Math.PI / 2; ring.position.set(x, y3 + 2 * PLATE + 0.005, z); g.add(ring);
    }
    return shadowy(g);
  }

  // One leg: a black 32L axle with an axle-and-pin connector on each end. Local x runs from one pin hole
  // (at the origin) to the other (DRONE.leg along), the pin holes along z.
  function legModel() {
    const g = new THREE.Group();
    const axle = 32 * U;
    for (const [w, h] of [[0.48, 0.18], [0.18, 0.48]]) { // cross-shaped axle
      const bar = new THREE.Mesh(cached('axle' + w, () => new THREE.BoxGeometry(axle, h, w)), L.black);
      bar.position.x = DRONE.leg / 2; g.add(bar);
    }
    for (const end of [0, DRONE.leg]) {
      const dir = end ? -1 : 1;
      const eye = new THREE.Mesh(cached('connEye', () => new THREE.CylinderGeometry(0.4, 0.4, U - 0.02, 16)), L.black);
      eye.rotation.x = Math.PI / 2; eye.position.x = end; g.add(eye);
      const sleeve = new THREE.Mesh(cached('connSleeve', () => new THREE.CylinderGeometry(0.34, 0.34, U, 12)), L.black);
      sleeve.rotation.z = Math.PI / 2; sleeve.position.x = end + dir * U; g.add(sleeve);
    }
    return shadowy(g);
  }

  // ---- parts used by the official building instructions (books 2-13) ----------------------
  const V3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);
  // A thick liftarm whose end holes sit at points a and b; its holes point along `holeAxis`
  // ([1,0,0] = left/right, [0,0,1] = front/back). Length in holes = |b - a| / 0.8 cm + 1.
  function beamAB(mat, a, b, holeAxis) {
    const A = V3(a), B = V3(b), d = B.clone().sub(A), holes = Math.round(d.length() / U) + 1;
    const x = d.clone().normalize(), z = V3(holeAxis || [0, 0, 1]);
    z.sub(x.clone().multiplyScalar(z.dot(x))).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const g = beam(holes, mat, 0, 0, 0);
    g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    g.position.copy(A.add(B).multiplyScalar(0.5));
    return g;
  }
  // A liftarm lying flat (holes upright), long along local x, turned `ry` about the vertical.
  function flatBeam(holes, mat, x, y, z, ry) {
    const g = new THREE.Group();
    g.add(beam(holes, mat, 0, 0, 0, { rx: Math.PI / 2 }));
    g.position.set(x, y, z); g.rotation.y = ry || 0;
    return g;
  }
  // A round bar, axle or hose segment from a to b.
  function rod(a, b, r, mat) {
    const A = V3(a), B = V3(b), m = new THREE.Mesh(cached('rod' + r, () => new THREE.CylinderGeometry(r, r, 1, 10)), mat);
    m.scale.y = A.distanceTo(B);
    m.position.copy(A.clone().add(B).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    return shadowy(m);
  }
  // A ribbed flexible hose through points (the ribs catch the light like the real part).
  function hose(points, mat) {
    const g = new THREE.Group();
    const curve = new THREE.CatmullRomCurve3(points.map(V3));
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.22, 8, false), mat));
    const n = Math.round(curve.getLength() / 0.25), rib = cached('rib25', () => new THREE.TorusGeometry(0.24, 0.05, 6, 12));
    for (let i = 1; i < n; i++) {
      const t = i / n, r = new THREE.Mesh(rib, mat);
      r.position.copy(curve.getPointAt(t));
      r.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), curve.getTangentAt(t));
      g.add(r);
    }
    return shadowy(g);
  }
  // A butterfly: two pairs of wings on a thin body.
  function butterfly(mat, x, y, z, ry) {
    const g = new THREE.Group();
    for (const s of [-1, 1]) g.add(leaf(1.1, 0.9, mat, s * 0.5, 0, -0.15, s * 0.5, s * 0.3), leaf(0.8, 0.6, mat, s * 0.4, 0, 0.35, -s * 0.5, s * 0.3));
    g.add(rod([0, 0, -0.5], [0, 0, 0.5], 0.08, L.black));
    g.position.set(x, y, z); g.rotation.y = ry || 0;
    return shadowy(g);
  }
  // Book 2 seed (steps 21-26): tan plates in a brown 2x2 dome bottom, a brown 2x2 round brick with
  // points, a 2x2 round tile with a stud, then an L-shaped bar with a gold ring. Bottom at y = 0.
  function seedModel(withRing) {
    const g = new THREE.Group();
    const dome = new THREE.Mesh(cached('dome2', () => new THREE.SphereGeometry(U - 0.02, 18, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2)), L.brown);
    dome.position.y = U - 0.02; g.add(dome);
    g.add(round(1, 3, L.brown, 0, U - 0.02));
    for (let i = 0; i < 4; i++) { const pt = new THREE.Mesh(cached('seedPt', () => new THREE.ConeGeometry(0.18, 0.4, 6)), L.brown); const a = i * Math.PI / 2 + 0.78; pt.position.set(Math.cos(a) * 0.72, U + 0.1, Math.sin(a) * 0.72); pt.rotation.z = Math.PI; g.add(pt); }
    const top = U - 0.02 + BRICK;
    g.add(round(1, 1, L.brown, 0, top), round(0.3, 1, L.brown, 0, top + PLATE));
    if (withRing) {
      g.add(rod([0, top + PLATE, 0], [0, top + PLATE + 1.4, 0], 0.16, L.brown));
      const ring = new THREE.Mesh(cached('goldRing', () => new THREE.TorusGeometry(0.55, 0.12, 8, 20)), plastic('#d9a72b', { metalness: 0.6, roughness: 0.25 }));
      ring.position.y = top + PLATE + 1.9; g.add(ring);
    }
    return shadowy(g);
  }
  // A long hexagonal plate nx wide and nz long (pointed at both ends, like the 3x12 leaf plates), lying
  // flat with studs where they fit, centred on the origin, bottom at y.
  function hexPlate(nx, nz, mat, y, studs) {
    const g = new THREE.Group(), w = nx * U / 2 - 0.01, l = nz * U / 2 - 0.01, tip = w * 1.1;
    const geo = cached('hex' + nx + 'x' + nz, () => {
      const sh = new THREE.Shape([[-w, -l + tip], [0, -l], [w, -l + tip], [w, l - tip], [0, l], [-w, l - tip]].map(([a, b]) => new THREE.Vector2(a, b)));
      const e = new THREE.ExtrudeGeometry(sh, { depth: PLATE, bevelEnabled: false }); e.rotateX(Math.PI / 2); e.translate(0, PLATE, 0); return e;
    });
    g.add(new THREE.Mesh(geo, mat));
    if (studs !== false) studGrid(g, nx, nz, mat, PLATE, (sx, sz) => Math.abs(sx) / w + Math.max(0, Math.abs(sz) - (l - tip)) / tip <= 1 - 0.4 / w);
    g.position.y = y || 0;
    return shadowy(g);
  }
  // Book 4 leaf (steps 11-12): a green 3x12 long hexagonal plate, a black clip plate and a green handle
  // plate standing at one end, and a light brown 21L hose looped upright through the handle. The loop is
  // at the origin; the leaf lies along -z from it. `katydid` adds the two black T-bars of the last leaf.
  function leafModel(katydid) {
    const g = new THREE.Group();
    const body = hexPlate(3, 12, L.green, 0); body.position.z = -4.6; g.add(body);
    g.add(round(0.5, 1, L.brown, 0, -PLATE, -2.6), brick(2, 1, 1, L.black, 0, PLATE, 0, { studs: false }).rotateX(-Math.PI / 2));
    g.add(brick(2, 1, 1, L.green, 0, PLATE + 0.1, -0.3, { studs: false }).rotateX(-Math.PI / 2));
    const loop = []; for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2; loop.push([Math.sin(a) * 0.9, PLATE + 0.9 + (1 - Math.cos(a)) * 3.3, -0.35]); }
    g.add(hose(loop, plastic('#b5895a')));
    if (katydid) for (const sx of [-0.4, 0.4]) { g.add(rod([sx, PLATE, -6.4], [sx, PLATE + 1.6, -6.4], 0.1, L.black), rod([sx - 0.5, PLATE + 1.6, -6.4], [sx + 0.5, PLATE + 1.6, -6.4], 0.1, L.black)); }
    return shadowy(g);
  }
  // A Technic hollow frame (5x7, 7x11 ...): nu holes along direction u, nv holes along v, from corner hole
  // o. Its holes point along u x v. Returns the four liftarms as one group.
  function frameAt(nu, nv, mat, o, u, v) {
    const g = new THREE.Group(), P = (a, b) => [o[0] + (u[0] * a + v[0] * b) * U, o[1] + (u[1] * a + v[1] * b) * U, o[2] + (u[2] * a + v[2] * b) * U];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    g.add(beamAB(mat, P(0, 0), P(nu - 1, 0), n), beamAB(mat, P(0, nv - 1), P(nu - 1, nv - 1), n));
    g.add(beamAB(mat, P(0, 0), P(0, nv - 1), n), beamAB(mat, P(nu - 1, 0), P(nu - 1, nv - 1), n));
    return g;
  }
  // A Technic gear with `teeth` teeth (radius teeth x 0.4 mm), axle along local z.
  function gear(teeth, mat, w) {
    const g = new THREE.Group(), r = teeth * 0.04;
    g.add(new THREE.Mesh(cached('gearBody' + teeth, () => new THREE.CylinderGeometry(r - 0.06, r - 0.06, w || 0.32, 24)).rotateX(Math.PI / 2), mat));
    const tooth = cached('gearTooth', () => new THREE.BoxGeometry(0.1, 0.14, w || 0.32));
    for (let i = 0; i < teeth; i++) { const t = new THREE.Mesh(tooth, mat), a = (i / teeth) * Math.PI * 2; t.position.set(Math.cos(a) * r, Math.sin(a) * r, 0); t.rotation.z = a; g.add(t); }
    return shadowy(g);
  }
  // An arch brick 1 wide, `len` studs long along local z and `hb` bricks tall, the arch opening underneath.
  function archBrick(len, hb, mat, x, y, z) {
    const geo = cached('arch' + len + 'x' + hb, () => {
      const L2l = len * U / 2 - 0.02, H = hb * BRICK, r = Math.min(L2l - U, H - PLATE);
      const sh = new THREE.Shape(); sh.moveTo(-L2l, 0); sh.lineTo(-L2l + U, 0); sh.absarc(0, 0, r, Math.PI, 0, true); sh.lineTo(L2l, 0); sh.lineTo(L2l, H); sh.lineTo(-L2l, H); sh.lineTo(-L2l, 0);
      const e = new THREE.ExtrudeGeometry(sh, { depth: U - 0.04, bevelEnabled: false, curveSegments: 16 }); e.translate(0, 0, -(U - 0.04) / 2); e.rotateY(Math.PI / 2); return e;
    });
    const g = new THREE.Group(); g.add(new THREE.Mesh(geo, mat));
    studGrid(g, 1, len, mat, hb * BRICK);
    g.position.set(x || 0, y || 0, z || 0);
    return shadowy(g);
  }
  // A 1x2 plate with a curved leaf on one side (the leaf reaching along +x).
  function leafPlate(plateMat, leafMat) {
    const g = new THREE.Group();
    g.add(plate(2, 1, plateMat, 0, 0, 0, { ry: Math.PI / 2 }));
    const lf = leaf(2.6, 1.3, leafMat, 1.6, 0.25, 0, 0, 0.25); g.add(lf);
    return shadowy(g);
  }
  // A brown 11x3 curved panel: a quarter of a round tree trunk (radius r), 11 holes tall, standing on y = 0
  // and spanning angles a0..a0+90 degrees around the trunk's axis.
  function curvedPanel(mat, r, a0) {
    const geo = cached('cpanel' + r, () => {
      const sh = new THREE.Shape(); sh.absarc(0, 0, r, 0.06, Math.PI / 2 - 0.06, false); sh.absarc(0, 0, r - 0.55, Math.PI / 2 - 0.06, 0.06, true);
      const e = new THREE.ExtrudeGeometry(sh, { depth: 11 * U - 0.04, bevelEnabled: false, curveSegments: 10 }); e.rotateX(-Math.PI / 2); return e;
    });
    const m = new THREE.Mesh(geo, mat); m.rotation.y = a0;
    return shadowy(m);
  }
  // A 6x5 plant leaves piece: a flat green triangle of studs, the point along +x.
  function plantLeaves(mat) {
    const g = new THREE.Group();
    const geo = cached('plant65', () => { const sh = new THREE.Shape([[-2.2, -2.0], [2.6, 0], [-2.2, 2.0]].map(([a, b]) => new THREE.Vector2(a, b))); const e = new THREE.ExtrudeGeometry(sh, { depth: PLATE, bevelEnabled: false }); e.rotateX(Math.PI / 2); e.translate(0, PLATE, 0); return e; });
    g.add(new THREE.Mesh(geo, mat));
    studGrid(g, 6, 5, mat, PLATE, (x, z) => x > -2.0 && Math.abs(z) < (2.6 - x) * 0.4 - 0.2);
    return shadowy(g);
  }
  // A small bird (book 7, step 98): white round plates and a 1x1 brick, triangle wings, an orange beak.
  function bird(body) {
    const g = new THREE.Group();
    g.add(round(0.5, 1, body, 0, 0, 0), brick(1, 1, 3, body, 0, PLATE, 0, { studs: false }), round(0.5, 2, body, -0.5, PLATE + 0.3, 0).rotateZ(Math.PI / 2));
    for (const s2 of [-1, 1]) g.add(leaf(1.0, 0.5, body, 0, PLATE + 0.6, s2 * 0.55, s2 * 0.3, 0));
    const beak = new THREE.Mesh(cached('beak', () => new THREE.ConeGeometry(0.15, 0.4, 6)), L.orange); beak.rotation.z = -Math.PI / 2; beak.position.set(0.6, PLATE + 0.75, 0); g.add(beak);
    return shadowy(g);
  }
  // LEGO colour names used by the text-based instructions that the basic palette lacks
  const L2 = {
    lightGreen: plastic('#9fcf45'), // "light green" liftarms (bright yellowish green)
    sandGreen: plastic('#a0bcac'), darkBrown: plastic('#352100'), reddishBrown: plastic('#582a12'),
    gold: plastic('#d9a72b', { metalness: 0.6, roughness: 0.25 }), transClear: plastic('#eef6ff', { transparent: true, opacity: 0.4, roughness: 0.05 }),
  };

  const BUILD = {
    pilot() { // M01 drone pilot (bag 2). The top sits on a 4x4 turntable and turns with the drone's legs.
      const g = new THREE.Group();
      g.add(discPlate(8, 1, L.lbg));
      g.add(tile(4, 4, L.black, 0, PLATE), round(1.75, 1, L.black, 0, 2 * PLATE)); // turntable base and top
      const top = new THREE.Group();
      top.position.y = 3 * PLATE;
      // local +x points along the legs to the drone; the pins stick out along z
      top.add(discPlate(6, 1, L.lbg), plate(2, 4, L.lime, 0, PLATE, 0));
      for (const s of [-1, 1]) {
        top.add(plate(2, 1, L.lbg, 0, 2 * PLATE, s * 1.2), techBrick(2, L.lbg, 0, 3 * PLATE, s * 1.2));
        top.add(pin(2, L.yellow, 0, 3 * PLATE + 0.58, s * 1.6));
        top.add(curve(2, 1, L.dbg, 0, 3 * PLATE + BRICK, s * 1.2)); // arm rests
      }
      // seat, facing the drone
      top.add(plate(2, 2, L.lime, 0, 2 * PLATE, 0, { studs: false }));
      const back = new THREE.Mesh(cached('seatBack', () => boxGeo(0.24, 1.3, 1.58)), L.lime);
      back.position.set(-0.68, 3 * PLATE + 0.65, 0); top.add(back);
      const fig = minifig(L.brown, L.teal, null, -0.1, 3 * PLATE, 0, -Math.PI / 2, { seated: true, helmet: L.white });
      const pad = new THREE.Mesh(cached('controller', () => boxGeo(1.0, 0.22, 0.5)), L.black);
      pad.position.set(0, 1.6, -0.45); fig.add(pad);
      top.add(fig);
      // radar dish on a pole beside the seat, the telescope pointing out to the side
      top.add(round2(L.lbg, -1.6, PLATE, 0.8), round2(L.dbg, -1.6, 2 * PLATE, 0.8));
      const pole = new THREE.Mesh(cached('pole', () => new THREE.CylinderGeometry(0.16, 0.16, 3.2, 10)), L.black);
      pole.position.set(-1.6, 3 * PLATE + 1.6, 0.8); top.add(pole);
      const scope = new THREE.Mesh(cached('scope', () => new THREE.CylinderGeometry(0.3, 0.22, 1.6, 12)), L.nougat);
      scope.rotation.x = Math.PI / 2; scope.position.set(-1.6, 3 * PLATE + 3.0, 1.8); top.add(scope);
      const dish = new THREE.Mesh(cached('dish', () => new THREE.SphereGeometry(1.7, 20, 6, 0, Math.PI * 2, 0, 0.5)), L.trans);
      dish.rotation.x = -Math.PI / 2; dish.position.set(-1.6, 3 * PLATE + 3.0, 2.6); top.add(dish);
      g.add(top);
      return { group: shadowy(g), update(st, sim) { top.rotation.y = -sim.droneRig().yaw; } };
    },
    lidar() { // M01 LiDAR map (bag 2): the map frame between two bent liftarms on Technic feet; it flips over between them
      const g = new THREE.Group();
      const pivotY = PLATE + 0.58, pivotZ = -1.0; // tan pins through the feet
      for (const s of [-1, 1]) {
        const x = s * 3.4;
        g.add(plate(1, 4, L.lbg, x, 0, 0), techBrick(4, L.dbg, x, PLATE, 0, { ry: Math.PI / 2 }), curve(2, 1, L.dbg, x, PLATE + BRICK, 0.4, Math.PI / 2));
        g.add(pin(2, L.tan, s * 3.0, pivotY, pivotZ).rotateY(Math.PI / 2));
        // bent liftarm: 3 holes straight up, then 4 holes leaning 53 degrees towards the front
        const arm = new THREE.Group();
        arm.add(beam(3, L.lbg, 0, U, 0, { rz: Math.PI / 2, ry: Math.PI / 2 }));
        const upper = beam(4, L.lbg, 0, 0, 0, { rz: Math.PI / 2, ry: Math.PI / 2 });
        const lean = new THREE.Group(); lean.position.y = 2 * U; lean.rotation.x = 0.925; lean.add(upper); upper.position.y = 1.5 * U;
        arm.add(lean);
        arm.position.set(s * 2.8, pivotY, pivotZ);
        g.add(arm);
      }
      g.add(plate(6, 1, L.lbg, 0, 0, -1.2), tile(4, 1, L.dbg, 0, PLATE, -1.2));
      // the map frame hangs between the arms' tops and turns on them
      const top = [0, pivotY + 2 * U + 3 * U * Math.cos(0.925), pivotZ + 3 * U * Math.sin(0.925)];
      const hinge = new THREE.Group();
      hinge.position.set(top[0], top[1], top[2]);
      const map = new THREE.Group();
      map.position.y = -BRICK / 2;
      for (const s of [-1, 1]) map.add(techBrick(6, L.lbg, 0, 0, s * 1.2), techBrick(2, L.lbg, s * 2.0, 0, 0, { ry: Math.PI / 2 }));
      const y = BRICK;
      map.add(shaped([[-2.4, 0], [2.4, 0], [2.4, PLATE], [-2.4, PLATE]], 2, L.green, [-2.4, 2.4], 0, y, -0.8)); // 2x6 double round plate
      map.add(tile(2, 2, L.rbrown, 0, y, 0.8), round2(L.brightGreen, 1.6, y, 0.8, true));
      map.add(plate(2, 1, L.green, -1.6, y, 0.4), plate(2, 1, L.lime, -1.6, y, 1.2), round1(L.red, -0.8, y + PLATE, -0.4));
      // push handle out the front: a tan bar on a 1x2 clip plate, with a white round button
      map.add(plate(1, 2, L.black, -1.6, -PLATE, 1.2, { studs: false }));
      const bar = new THREE.Mesh(cached('lidarBar', () => new THREE.CylinderGeometry(0.16, 0.16, 1.2, 10)), L.tan);
      bar.rotation.x = Math.PI / 2; bar.position.set(-1.6, -0.1, 2.2); map.add(bar);
      map.add(round(1, 1, L.white, -1.6, -0.1, 2.8).rotateX(Math.PI / 2));
      hinge.add(map);
      g.add(hinge);
      return { group: shadowy(g), update(st) { ease(hinge, 'rotation.x', -padMax(st, 'flip') * Math.PI); } };
    },
    seedpod(f) { // M02 Exploding Seeds, book 2 (35 steps). Local x along the 7L sides of the base frame.
      const g = new THREE.Group();
      // steps 1-4: a light gray 5x7 hollow frame lying flat, dark gray 5L thick liftarms pinned upright at its ends
      for (const s of [-1, 1]) { g.add(flatBeam(7, L.lbg, 0, 0.36, s * 1.6), flatBeam(5, L.lbg, s * 2.4, 0.36, 0, Math.PI / 2)); g.add(beam(5, L.dbg, s * 3.1, 0.36, 0, { ry: Math.PI / 2 })); }
      for (const s of [-1, 1]) g.add(pin(2, L.black, s * 2.7, 0.36, -0.8, 0).rotateY(Math.PI / 2), pin(3, plastic('#1e5aa8'), s * 2.7, 0.36, 0.8, 0).rotateY(Math.PI / 2));
      // step 5: the upright: a light gray 3x3 T-shaped liftarm, and a light green 11L liftarm beside it
      const X = [1, 0, 0], y0 = 0.36;
      g.add(beamAB(L.lbg, [0.72, y0, -U], [0.72, y0, U], X), beamAB(L.lbg, [0.72, y0, 0], [0.72, y0 + 2 * U, 0], X));
      g.add(beamAB(L2.lightGreen, [0, y0, 0], [0, y0 + 10 * U, 0], X));
      // steps 6-7: a light green 7x3 bent liftarm continues it (the 3L end bends 45 degrees back), and a
      // light green 7L liftarm on its pins runs back down to the front, parallel to the 3L end
      const top7 = [0, y0 + 15 * U, 0], d45 = Math.SQRT1_2;
      const tip = [-0.72, top7[1] + 2 * U * d45, -2 * U * d45];
      g.add(beamAB(L2.lightGreen, [-0.72, y0 + 9 * U, 0], [-0.72, top7[1], 0], X), beamAB(L2.lightGreen, [-0.72, top7[1], 0], tip, X));
      const hi = [0.72, tip[1], tip[2]], lo = [0.72, tip[1] - 6 * U * d45, tip[2] + 6 * U * d45];
      g.add(beamAB(L2.lightGreen, [0, hi[1], hi[2]], [0, lo[1], lo[2]], X));
      // steps 8-18: the stem - lime and yellow axle-and-pin connectors on red axles - along that liftarm,
      // reaching on up and back to the top of the model; a second light green 7L liftarm on its front
      const up = [0, d45, -d45], at = (p, k) => [p[0], p[1] + up[1] * k, p[2] + up[2] * k];
      const s0 = at(hi, -3 * U), s1 = at(hi, 5 * U);
      g.add(rod(s0, at(hi, 0), 0.24, L.lime), rod(at(hi, 0), at(hi, 2 * U), 0.2, L.red), rod(at(hi, 2 * U), at(hi, 3.2 * U), 0.3, L.yellow));
      g.add(rod(at(hi, 3.2 * U), at(hi, 4.2 * U), 0.2, L.lbg), rod(at(hi, 4.2 * U), s1, 0.3, L.yellow));
      for (const sx of [-1, 1]) g.add(rod([s1[0], s1[1], s1[2]], [s1[0] + sx * U, s1[1], s1[2]], 0.3, L.yellow)); // the two hose sockets
      g.add(beamAB(L2.lightGreen, [1.44, hi[1], hi[2]], [1.44, lo[1], lo[2]], X));
      // steps 13-20: a pink flower and lime leaves on red pins with studs, and a purple butterfly
      const fl = at(hi, 0.5 * U);
      g.add(round(0.5, 1, L.pink, fl[0] + 1.9, fl[1] + 0.3, fl[2], true), leaf(1.4, 0.7, L.lime, fl[0] + 2.2, fl[1] + 0.2, fl[2] + 0.5, 0.3, 0.3));
      g.add(butterfly(L.purple, 2.1, lo[1] + 1.2, lo[2] - 0.6, 0.4));
      g.add(leaf(1.6, 0.8, L.lime, 2.0, lo[1] + 2.2, lo[2] - 1.4, -0.3, 0.6), leaf(1.6, 0.8, L.lime, -1.6, tip[1] - 0.6, tip[2], 2.8, -0.5));
      // step 17: the green 6L bar the seeds' rings hook onto, near the low end of the stem
      const bar0 = [0.4, 2.9 + 4.0, 3.6];
      g.add(rod(bar0, [bar0[0], bar0[1] + 6 * U, bar0[2]], 0.16, L.green));
      // steps 33-35: two lime 19L flexible hoses from the top of the stem make a loop over the stand,
      // down to the seeds hanging on the bar (the seeds themselves are loose models)
      const ring = [0, 2.9 + 4.0, 3.6];
      for (const sx of [-1, 1]) {
        g.add(hose([[s1[0] + sx * 1.0, s1[1], s1[2]], [sx * 3.4, s1[1] - 0.4, s1[2] + 1.0], [sx * 4.8, 12.5, 0.2], [sx * 4.4, 9.6, 0.9], [sx * 2.4, ring[1] + 0.2, ring[2]], [sx * 1.2, ring[1], ring[2]]], L.lime));
      }
      return { group: shadowy(g), update() {} };
    },
    rock(f) { // M03 Flip the Rock, book 3 (67 steps). Local x along the 11L parts (east-west), +z the front.
      const g = new THREE.Group();
      const X = [1, 0, 0], transGreen = plastic('#7fd18f', { transparent: true, opacity: 0.6, roughness: 0.1 });
      // steps 1-7: base - a dark gray 5x11 panel, a lime 7x11 hollow frame on it (overhanging at the back),
      // lime 2x4 L-shaped liftarms at both ends
      const panelGeo = cached('panel5x11', () => boxGeo(11 * U - 0.04, U - 0.04, 5 * U - 0.04));
      const basePanel = new THREE.Mesh(panelGeo, L.dbg); basePanel.position.y = U / 2; g.add(basePanel);
      for (const s of [-1, 1]) { g.add(flatBeam(11, L.lime, 0, U + 0.36, s > 0 ? 2.0 - 0.4 : -3.6 + 0.4)); g.add(flatBeam(7, L.lime, s * 4.0, U + 0.36, -0.8, Math.PI / 2)); }
      for (const s of [-1, 1]) {
        const x = s * 4.8;
        g.add(beamAB(L.lime, [x, 0.36, 1.6], [x, 0.36, -0.8], X), beamAB(L.lime, [x, 0.36, -0.8], [x, 0.36 + U, -0.8], X));
        g.add(pin(3, L.tan, s * 4.5, U + 0.36, 1.2, 0).rotateY(Math.PI / 2));
      }
      // steps 8-15: the rotating platform - two light gray 11L liftarms under a dark gray 5x11 panel -
      // pivoting on yellow pins at its ends. Built around its pivot so it can roll over.
      const H = 3.4;
      const plat = new THREE.Group();
      plat.position.set(0, H, 0);
      const pp = new THREE.Mesh(panelGeo, L.dbg); plat.add(pp);
      for (const z of [-1.2, 1.2]) plat.add(beam(11, L.lbg, 0, -U, z));
      // the first scene (steps 27-45): a gray rock with clear green pools, a frog, a clear blue mushroom and flowers
      const rock = new THREE.Group();
      rock.position.y = U / 2;
      rock.add(plate(8, 4, L.lbg, -1.6, 0, 0), plate(2, 4, L.lbg, 2.4, 0, 0));
      const y1 = PLATE;
      rock.add(slope(3, 2, L.dbg, -3.2, y1, -0.4, Math.PI), shaped([[-0.8, 0], [0.8, 0], [0.8, PLATE], [-0.8, BRICK]], 2, L.dbg, null, -1.6, y1, 0.8));
      rock.add(slope(2, 4, L.lbg, -0.4, y1, -0.4, Math.PI / 2), slope(4, 1, L.dbg, 1.2, y1, 0, -Math.PI / 2));
      rock.add(slope(3, 3, L.lbg, 3.2, y1, -0.4, 0), slope(3, 1, L.lbg, 2.8, y1, 1.2, 0), slope(2, 2, L.lbg, 3.6, y1 + BRICK, -0.8, Math.PI / 2));
      for (const [x, z, ry] of [[-3.6, -1.2, 0], [-2.4, 0.8, Math.PI / 2], [-0.4, 1.2, 0], [1.6, 1.2, 0], [0.8, -1.2, 0]]) rock.add(tile(2, 1, transGreen, x, y1, z, { ry }));
      rock.add(plate(2, 1, L.red, -3.6, y1, 1.2), plate(2, 1, L.green, -3.6, y1 + PLATE, 1.2));
      for (const x of [-4, -3.2]) rock.add(slope(1, 1, L.lime, x, y1 + 2 * PLATE, 1.2, Math.PI));
      const cone = new THREE.Mesh(cached('cone1', () => new THREE.ConeGeometry(0.38, 0.95, 16)), plastic('#7fd6e8', { transparent: true, opacity: 0.7, roughness: 0.08 }));
      cone.position.set(-2.8, y1 + BRICK + 0.48, 0.8); rock.add(cone);
      const dish = new THREE.Mesh(cached('dish2', () => new THREE.SphereGeometry(0.85, 20, 6, 0, Math.PI * 2, 0, 0.9)), plastic('#7fd6e8', { transparent: true, opacity: 0.7, roughness: 0.08 }));
      dish.position.set(-2.8, y1 + BRICK + 0.3, 0.8); rock.add(dish);
      const frog = new THREE.Group(); // olive green frog
      const fb = new THREE.Mesh(cached('frogBody', () => new THREE.SphereGeometry(0.5, 14, 10)), L.olive); fb.scale.set(1.2, 0.7, 0.9); frog.add(fb);
      for (const s of [-1, 1]) { const e = new THREE.Mesh(cached('frogEye', () => new THREE.SphereGeometry(0.14, 8, 6)), L.olive); e.position.set(0.4, 0.3, s * 0.22); frog.add(e); }
      frog.position.set(-1.6, y1 + 0.4, -1.2); rock.add(frog);
      rock.add(leaf(1.2, 0.6, L.green, 3.4, y1 + BRICK * 1.6, -1.2, 0, 0.3), leaf(1.2, 0.6, L.green, 2.6, y1 + BRICK * 1.3, 0.4, 0.8, 0.3), round(0.5, 1, L.pink, 2.6, y1 + BRICK * 1.3 + 0.1, 0.4, true));
      plat.add(rock);
      // the second scene (steps 49-67), on the other face: brown and dark tan ground with white rounded
      // plates, a light brown spider, a red clip, and green plates and leaves on the front edge
      const den = new THREE.Group();
      den.rotation.x = Math.PI; den.position.y = -U / 2 - U;
      den.add(plate(8, 4, L.brown, -1.2, 0, 0), plate(8, 1, L.brown, 0, 0, -1.2));
      for (const [x, z] of [[-3.2, -1.2], [-3.2, 0], [-3.2, 1.2]]) den.add(plate(3, 2, L.darkTan, x, PLATE, z * 0.66));
      for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(cached('rp13', () => boxGeo(U - 0.04, PLATE, 3 * U - 0.04)), L.white); r.position.set(-1.6 + i * U, PLATE * 1.5, -0.4); den.add(r); }
      den.add(slope(2, 2, L.darkTan, 0.8, PLATE, -0.8, Math.PI), slope(4, 2, L.brown, 2.4, PLATE, 0.4, 0));
      for (const z of [-1.2, -0.4, 0.4]) den.add(slope(1, 1, L2.darkBrown, 3.6, PLATE, z, z > 0 ? Math.PI / 2 : -Math.PI / 2));
      const spider = new THREE.Mesh(cached('spiderBody', () => new THREE.SphereGeometry(0.38, 10, 8)), L.nougat); spider.position.set(-0.8, PLATE * 2 + 0.25, -0.4); den.add(spider);
      for (let i = 0; i < 8; i++) { const s2 = i < 4 ? -1 : 1, k = i % 4; den.add(rod([-0.8, PLATE * 2 + 0.25, -0.4], [-0.8 + s2 * 0.75, PLATE * 2, -0.4 + (k - 1.5) * 0.35], 0.04, L.nougat)); }
      den.add(brick(2, 1, 3, L.nougat, 2.6, PLATE, 1.2), rod([2.6, PLATE + 0.58, 1.6], [2.6, PLATE + 0.58, 2.1], 0.2, L.red));
      for (const x of [-2.8, 2.0]) den.add(plate(1, 3, L.green, x, -0.6, 1.95, { ry: 0 }));
      plat.add(den);
      for (const s of [-1, 1]) plat.add(pin(2, L.yellow, s * 4.6, 0, -1.2, 0).rotateY(Math.PI / 2));
      g.add(plat);
      // steps 16-26: lime 5L liftarms joining base and platform, red 4x6 bent levers standing at both ends,
      // dark gray 3x3 square liftarms with a pink flower, light gray 7L liftarms behind them
      for (const s of [-1, 1]) {
        const x = s * 5.3;
        g.add(beamAB(L.lime, [s * 4.6, U + 0.36, 1.2], [s * 4.6, H, -1.2], X));
        const lever = new THREE.Group();
        lever.position.set(s * 5.3, H, 0.4);
        lever.add(beamAB(L.red, [0, 0, 0], [0, 5 * U, 0], X), beamAB(L.red, [0, 5 * U, 0], [0, 5 * U + 3 * U * Math.SQRT1_2, 3 * U * Math.SQRT1_2], X));
        g.add(lever);
        const sq = new THREE.Group(); // 3x3 square liftarm, upright
        for (const [a2, b2] of [[[0, 0.36, -0.8], [0, 0.36, 0.8]], [[0, 0.36 + 2 * U, -0.8], [0, 0.36 + 2 * U, 0.8]], [[0, 0.36, -0.8], [0, 0.36 + 2 * U, -0.8]], [[0, 0.36, 0.8], [0, 0.36 + 2 * U, 0.8]]]) sq.add(beamAB(L.dbg, a2, b2, X));
        sq.position.set(x + s * 0.72, 0, 0.8); g.add(sq);
        g.add(round(0.5, 1, L.pink, x + s * 0.72, 0.36 + U, 2.0, true).rotateX(Math.PI / 2));
        g.add(beamAB(L.lbg, [x + s * 1.44, 0.36, -0.8], [x + s * 1.44, 0.36 + 6 * U, -0.8], X));
        g.add(beamAB(L.black, [x + s * 0.72, 0.36, 2.1], [x + s * 0.72, 0.36 + 2 * U, 2.1], X));
      }
      return {
        group: g,
        update(st) {
          // first push rolls the rock over (the brown den on top); the second puts it back
          ease(plat, 'rotation.x', st.presses === 1 ? Math.PI : 0);
        },
      };
    },
    nest(f) { // M04 Lucky Leaves, book 4: three big leaves joined at angles by A-shaped plates. They meet on
      // the field side (+z, where the loose leaves' rope loops stand) and fan out towards the wall.
      const g = new THREE.Group();
      const J = f.d / 2 - 1.2;
      for (const [ry, len] of [[0, 1], [0.87, 0.92], [-0.87, 0.92]]) {
        const leafG = new THREE.Group();
        leafG.position.z = J; leafG.rotation.y = ry;
        const b = hexPlate(4, Math.round(11 * len), L.green, 0); b.position.z = -4.6 * len; leafG.add(b); // 4x6 + 2x4 plates
        leafG.add(brick(6, 1, 3, L.lbg, 0, PLATE, -4.0 * len, { ry: Math.PI / 2 }), brick(2, 1, 3, L.lbg, -1.2, PLATE, -2.0, { ry: Math.PI / 2 }), brick(2, 1, 3, L.lbg, 1.2, PLATE, -2.0, { ry: Math.PI / 2 }));
        leafG.add(plate(2, 1, L.dbg, 0, PLATE + BRICK, -1.2, { ry: Math.PI / 2 }));
        for (const sx of [-1.2, 1.2]) leafG.add(tile(1, 4, L.green, sx, PLATE, -5.2 * len)); // the green tiles of the leaf's edges
        leafG.add(plate(1, 4, L.green, 0, PLATE + BRICK, -5.6 * len), tile(1, 4, L.green, 0, 2 * PLATE + BRICK, -5.6 * len));
        g.add(leafG);
      }
      // the light gray A-shaped plates and green 2x4 plates joining the leaves
      g.add(plate(4, 2, L.lbg, 0, 0, J - 0.4), plate(2, 4, L.green, -1.8, PLATE, J - 1.8), plate(2, 4, L.green, 1.8, PLATE, J - 1.8));
      return { group: shadowy(g), update() {} }; // the three leaves are loose models
    },
    roots(f) { // M05 Reaching Roots, book 5 (34 steps). Local x across the model, +z the front (field side).
      const g = new THREE.Group();
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], y0 = 0.36, h = (k) => y0 + k * U;
      // steps 1-11: two light gray 5x7 hollow frames standing upright side by side, a dark gray 3x3
      // square liftarm and the brown 7x3 bent liftarms of the trunk between them
      for (const x of [-1.44, 1.44]) g.add(frameAt(5, 7, L.lbg, [x, y0, -1.6], Z, Y));
      const sq = frameAt(3, 3, L.dbg, [0.72, y0, 0.0], Z, Y); g.add(sq);
      const d45 = Math.SQRT1_2;
      const trunk = (x) => { // 7L up from the frame's top front holes, then the 3L end leaning back
        const top = [x, h(5) + 6 * U, 1.6];
        g.add(beamAB(L.brown, [x, h(5), 1.6], top, X), beamAB(L.brown, top, [x, top[1] + 2 * U * d45, 1.6 - 2 * U * d45], X));
        return [x, top[1] + 2 * U * d45, 1.6 - 2 * U * d45];
      };
      const tA = trunk(-0.36); trunk(0.36);
      g.add(beamAB(L.green, [-1.08, h(6) + 4 * U, 1.6], [-1.08, h(6) + 5 * U, 1.6], X), beamAB(L.green, [1.08, h(6) + 4 * U, 1.6], [1.08, h(6) + 5 * U, 1.6], X));
      g.add(rod([-0.8, h(6) + 3.6 * U, 0.8], [0.8, h(6) + 3.6 * U, 0.8], 0.3, L.nougat)); // light brown 3L axle connector
      // step 8: the trunk extension - a brown 5L liftarm and another 7x3 bent liftarm, leaning back,
      // with a pink flower on a red pin
      const ext0 = tA, ext1 = [0, ext0[1] + 6 * U * 0.92, ext0[2] - 6 * U * 0.38];
      g.add(beamAB(L.brown, [0, ext0[1], ext0[2]], ext1, X), beamAB(L.brown, [0.72, ext0[1] - U, ext0[2] + 0.3], [0.72, ext0[1] + 3 * U, ext0[2] - 1.2], X));
      const ext2 = [0, ext1[1] + 2 * U * 0.6, ext1[2] - 2 * U * 0.8];
      g.add(beamAB(L.brown, ext1, ext2, X), round(0.5, 1, L.pink, 1.15, ext0[1] + 2 * U, ext0[2] - 0.6, true).rotateZ(-Math.PI / 2));
      // step 12: a brown 5L liftarm on a 3x3 square liftarm ties the two frames together at the bottom
      g.add(flatBeam(5, L.brown, 0, 0.36 + U, 0, 0), frameAt(3, 3, L.dbg, [-0.8, 0.36, -0.8], X, Z));
      // steps 14-23: the front detail - a green 3x3 plate standing on the front studs with brown slopes,
      // a brown 1x5x4 inverted half arch, and green slope tiles
      const front = new THREE.Group();
      front.position.set(0, 0, 2.05); front.rotation.x = Math.PI / 2;
      front.add(plate(3, 3, L.green, 0, 0, -1.2 + 1.2));
      front.add(slope(3, 2, L.brown, 0.4, PLATE, 0, -Math.PI / 2), brick(3, 2, 3, L.brown, -0.8, PLATE, -0.4), plate(2, 3, L.brown, -0.8, PLATE + BRICK, -0.4));
      front.add(curve(4, 1, L.brown, -0.4, PLATE + BRICK, -2.0, Math.PI / 2), slope(1, 2, L.green, 0, 2 * PLATE + BRICK, 0.4, Math.PI / 2));
      const arch = shaped([[0, 0], [5 * U, 0], [5 * U, 0.3], [2.4, 1.0], [0.8, 2.4], [0, 4 * BRICK]], 1, L.brown, null, 0, 0, 0, 0);
      arch.rotation.set(0, Math.PI / 2, 0); arch.position.set(1.2, PLATE, 1.2); front.add(arch);
      g.add(front);
      // steps 24-34: the branch on top - two green 7L liftarms on a 4L axle through the trunk's top hole, a
      // brown 5L liftarm standing at their back ends, red balls on red axles, and a brown macaroni tube, cone
      // and claw. Pushing the frame at the front swings it, reaching the root out.
      const branch = new THREE.Group();
      branch.position.set(...ext2);
      for (const x of [-0.72, 0.72]) branch.add(beamAB(L.green, [x, 0, 0], [x, 0, -6 * U], X));
      branch.add(rod([-1.6, 0, 0], [1.6, 0, 0], 0.22, L.black));
      branch.add(beamAB(L.brown, [0, 0, -2 * U], [0, 4 * U, -3 * U], X));
      const ball = cached('ball', () => new THREE.SphereGeometry(0.5, 16, 12));
      for (const p of [[-2.6, 0, 0], [0, 4 * U, -4.6]]) { const b2 = new THREE.Mesh(ball, L.red); b2.position.set(...p); branch.add(b2); }
      branch.add(rod([-1.6, 0, 0], [-2.2, 0, 0], 0.25, L.red), rod([0, 4 * U, -3 * U], [0, 4 * U, -4.2], 0.25, L.red));
      const mac = tube([[0.8, 4 * U + 0.2, -2.4], [1.4, 4 * U + 0.4, -2.4], [1.6, 4 * U + 1.2, -2.4]], 0.35, L.brown); branch.add(mac);
      const cone = new THREE.Mesh(cached('cone1b', () => new THREE.ConeGeometry(0.4, 0.9, 12)), L.brown); cone.position.set(1.6, 4 * U + 1.9, -2.4); branch.add(cone);
      branch.add(tube([[1.6, 4 * U + 2.3, -2.4], [1.4, 4 * U + 3.6, -2.2], [0.6, 4 * U + 4.6, -1.6], [-0.2, 4 * U + 4.9, -0.8]], 0.2, L.brown)); // the claw
      g.add(branch);
      return {
        group: shadowy(g),
        update(st) { ease(branch, 'rotation.x', -padMax(st, 'extend') * 0.9); },
      };
    },
    leafcutter(f) { // M06 Leafcutter Frenzy, book 6 steps 1-69. Built in the book's frame (x along the 12-stud
      // length, +z its front) and turned so the length runs north-south, the ant's end to the field (south).
      const g = new THREE.Group();
      const B = new THREE.Group(); B.rotation.y = Math.PI / 2; g.add(B);
      // steps 1-12: the base - a white 6x12 plate, tan slope bricks along the back, a tan 1x8 brick down the
      // right side, white 1x4 bricks with a slot along the front for the rack, tan plates on top
      B.add(plate(12, 6, L.white, 0, 0, 0));
      for (const [x, n] of [[-4.4, 1], [-3.2, 2], [-1.6, 1], [-0.4, 2], [1.2, 1]]) B.add(slope(2, n === 2 ? 4 : 2, L.tan, x + (n === 2 ? 0.4 : 0), PLATE, -1.6, -Math.PI / 2).rotateY(0));
      B.add(brick(1, 8, 3, L.tan, 4.4, PLATE, 0.4), plate(3, 3, L.tan, -4.0, PLATE, 1.2));
      for (const x of [-3.2, -0.0]) B.add(brick(4, 1, 3, L.white, x, PLATE, 2.0));
      B.add(plate(5, 1, L.green, -2.8, PLATE + BRICK, 2.0), plate(8, 1, L.tan, 1.6, PLATE + BRICK, 2.0), plate(12, 1, L.tan, 0, PLATE + BRICK, -2.0));
      B.add(brick(12, 1, 3, L.tan, 0, 2 * PLATE + BRICK, -2.0));
      // steps 13-21: the rack gear assembly sliding in the front slot, with a red slope platform for the ant
      const rack = new THREE.Group();
      rack.position.set(0, PLATE + 0.3, 2.8);
      rack.add(plate(12, 2, L.white, 0, 0, 0));
      for (let i = 0; i < 3; i++) {
        rack.add(tile(4, 1, L.white, 1.2 - i * 3.2, PLATE, 0.4));
        for (let t = 0; t < 12; t++) { const tt = new THREE.Mesh(cached('rackT', () => new THREE.BoxGeometry(0.12, 0.14, U - 0.06)), L.white); tt.position.set(1.2 - i * 3.2 - 1.45 + t * 0.264, 2 * PLATE + 0.07, 0.4); rack.add(tt); }
      }
      rack.add(slope(2, 2, L.red, -4.0, PLATE, -0.4, -Math.PI / 2), slope(2, 2, L.red, -4.0, PLATE, 0.8, Math.PI / 2));
      // the leafcutter ant (steps 40-47): black plates, a red domed abdomen, six legs, and its leaf
      const ant = new THREE.Group();
      ant.add(round(1, 1, L.black, 0, 0, 0));
      const abd = new THREE.Mesh(cached('antAbd', () => new THREE.SphereGeometry(0.75, 16, 12)), L.red); abd.position.set(-0.9, 0.75, 0); ant.add(abd);
      for (const sz of [-0.3, 0.3]) ant.add(round(0.5, 1, L.brown, 0.5, PLATE, sz, true));
      for (let i = 0; i < 6; i++) { const sz = i < 3 ? -1 : 1, k = i % 3; ant.add(rod([0.3 - k * 0.4, 0.15, sz * 0.35], [0.3 - k * 0.4 + (k - 1) * 0.3, 0.05, sz * 1.3], 0.06, L.black)); }
      ant.add(leafPlate(L.green, L.green).rotateZ(Math.PI / 2).translateY(-0.6));
      ant.position.set(-4.0, PLATE + BRICK + 0.1, 0.2);
      rack.add(ant);
      B.add(rack);
      // steps 26-38: the camshaft (four black cams and a 12 tooth gear) and the gear train - a tan 20 tooth
      // gear meshing with the rack and a light gray 28 tooth gear meshing with the cam's gear
      const gr20 = gear(20, L.tan), gr28 = gear(28, L.lbg), gr12 = gear(12, L.black);
      gr20.position.set(2.6, 1.2, 2.5); gr28.position.set(2.6, 1.6, 1.6); gr12.position.set(2.6, 2.9, 0.5);
      B.add(gr20, gr28, gr12, rod([2.6, 1.2, 3.4], [2.6, 1.2, 0.8], 0.15, L.brown));
      B.add(brick(2, 1, 3, L.white, 4.0, 2 * PLATE + BRICK, 0.4, { ry: Math.PI / 2 }));
      // steps 49-66: the top - six tan 1x8x2 arch bricks (the nest's tunnels) on tan 1x12 plates, two tan
      // 2x10 plates, white and tan curved slopes, green tiles, and the fungus garden: a white cone in a
      // clear dome
      const T = new THREE.Group(); T.position.y = PLATE + 2 * BRICK;
      T.add(plate(12, 1, L.tan, 0, 0, -2.8), plate(12, 1, L.tan, 0, 0, 2.8));
      for (let i = 0; i < 6; i++) T.add(archBrick(8, 2, L.tan, -3.6 + i * 1.6, PLATE, 0));
      T.add(plate(10, 2, L.tan, 0, PLATE + 2 * BRICK, -1.6), plate(10, 2, L.tan, 0, PLATE + 2 * BRICK, 1.2));
      const yT = 2 * PLATE + 2 * BRICK;
      for (let i = 0; i < 4; i++) T.add(curve(1, 2, L.tan, -3.6 + i * 2.4, yT, -2.0, Math.PI / 2), tile(1, 3, L.green, -3.6 + i * 2.4, yT, -0.4));
      T.add(curve(2, 2, L.white, 0, yT, 2.0, -Math.PI / 2), curve(3, 1, L.white, -2.8, yT, 1.6, -Math.PI / 2));
      T.add(round(0.5, 1, plastic('#d9f7c0', { emissive: '#4a8a3a', emissiveIntensity: 0.25 }), 1.6, yT + PLATE, 2.4));
      const wc = new THREE.Mesh(cached('cone1w', () => new THREE.ConeGeometry(0.38, 0.95, 16)), L.white); wc.position.set(0.8, yT + PLATE + 0.48, 2.4); T.add(wc);
      const dome = new THREE.Mesh(cached('dome2c', () => new THREE.SphereGeometry(0.8, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)), L2.transClear); dome.position.set(0.8, yT + PLATE, 2.4); T.add(dome);
      B.add(T);
      // the four leaves on liftarms standing in the top are loose models (the leaf fragments)
      return {
        group: g,
        update(st) {
          const p = padMax(st, 'ant');
          ease(rack, 'position.x', -3.85 + p * 2.5); // the ant starts on the rack's end, out of the nest
          ease(gr20, 'rotation.z', -p * 6); ease(gr28, 'rotation.z', -p * 6); ease(gr12, 'rotation.z', p * 9);
        },
      };
    },
    fungus(f) { // M07 Humongous Fungus, book 6 steps 70-91: the web trap on the leafcutter nest's small base.
      // A light gray 5x7 hollow frame carries the web base (L-shaped liftarms); a white 15L liftarm slides
      // through it, its red ball handle to the field (south) and the trap - white bent liftarms holding a
      // white climbing rope - at the far end, cocked up over the base. Pulling the handle springs it.
      const g = new THREE.Group();
      const X = [1, 0, 0], Z = [0, 0, 1], Y = [0, 1, 0];
      // the small base (step 10): white 4x4 plate, white 1x6 bricks, light gray 2x4 plates with pins
      g.add(plate(4, 6, L.white, -0.8, 0, 0.8), brick(1, 6, 3, L.white, -2.0, PLATE, 0.8), brick(1, 6, 3, L.white, 0.4, PLATE, 0.8));
      g.add(curve(3, 1, L.white, -0.8, PLATE + BRICK, 3.0, Math.PI / 2));
      // step 76: the light gray 5x7 hollow frame standing on the small base's pins, a 5L liftarm on top
      const fy = PLATE + BRICK + 0.36;
      g.add(frameAt(5, 7, L.lbg, [-2.4, fy, 0.4], X, Y));
      const top = fy + 6 * U;
      g.add(flatBeam(5, L.lbg, -0.8, top + U, 0.4));
      // steps 70-75: the web base - a red 3L liftarm and four 3x5 L-shaped liftarms (white outside)
      for (const [x, mat] of [[-2.4, L.white], [-1.6, L.lbg], [0.0, L.lbg], [0.8, L.white]]) {
        g.add(beamAB(mat, [x, top + U, 1.2], [x, top + U, -0.4], X), beamAB(mat, [x, top + U, 1.2], [x, top + U + 4 * U, 1.2], X));
      }
      g.add(beamAB(L.red, [-0.8, top + U, 1.2], [-0.8, top + U, -0.4], X), beamAB(L.white, [-0.8, top + U + 2 * U, 1.6], [-0.8, top + U + 4 * U, 1.6], X));
      // steps 78-90: the trap. The white 15L liftarm slides along z through the web base; it carries light
      // gray 5L liftarms, white 7x3 bent liftarms and white 7L liftarms with the rope between them.
      const ty = top + 2 * U;
      const trap = new THREE.Group();
      trap.position.set(-0.8, ty, 0);
      trap.add(beamAB(L.white, [0, 0, 5.0], [0, 0, 5.0 - 14 * U], X));
      // the white liftarm down to the red T-handle lying on the mat in front (drawn with the handles)
      trap.add(beamAB(L.white, [0, 0, 5.0], [0, 1.0 - ty, f.d / 2 + 1.6], X));
      const head = new THREE.Group(); // pivots on the tan pin at the far end of the 15L liftarm
      head.position.set(0, 0, 5.0 - 14 * U);
      for (const s2 of [-1, 1]) {
        const hx = s2 * 0.72;
        head.add(beamAB(L.lbg, [hx, 0, 0], [hx, 0, 4 * U], X));
        head.add(beamAB(L.white, [hx * 1.0, 0, 4 * U], [hx, 6 * U * 0.7, 4 * U + 6 * U * 0.7], X));
        head.add(beamAB(L.white, [hx * 2, 6 * U * 0.7, 4 * U + 6 * U * 0.7], [hx * 2, 6 * U * 0.7 + 6 * U, 4 * U + 6 * U * 0.7], X));
        head.add(rod([hx * 2, 6 * U * 0.7 + 6 * U, 4 * U + 6 * U * 0.7], [hx * 2, 6 * U * 0.7 + 6 * U, 4 * U + 6 * U * 0.7 + 0.5], 0.2, L.red));
      }
      const rope = []; for (let i = 0; i <= 12; i++) { const t = i / 12; rope.push([-1.44 + 2.88 * t, 6 * U * 0.7 + 4.6 - Math.sin(t * Math.PI) * 2.2, 4 * U + 6 * U * 0.7 + 0.8]); }
      head.add(tube(rope, 0.12, L.white));
      for (let i = 1; i < 12; i += 2) head.add(rod([rope[i][0], rope[i][1] - 0.3, rope[i][2]], [rope[i][0], rope[i][1] + 0.3, rope[i][2]], 0.08, L.white));
      trap.add(head);
      g.add(trap);
      const z0 = 0;
      return {
        group: shadowy(g),
        update(st) {
          const p = padMax(st, 'extend');
          ease(trap, 'position.z', z0 + p * 3); // pulled out by its handle
          ease(head, 'rotation.x', -1.9 * (1 - p)); // cocked up over the base until it is pulled all the way
        },
      };
    },
    vine(f) { // M08 Tangled, book 7 steps 1-45 and 76-102: the big tree. Its trunk is two storeys of brown 11x3
      // curved panels (four make a round trunk), with brown liftarm roots and green plates spreading at the foot,
      // upright liftarms above it carrying two arching branches, and canopies of 6x5 plant leaves.
      const g = new THREE.Group();
      const X = [1, 0, 0], Z = [0, 0, 1];
      const T = [1.0, 0, -0.6], R = 1.95; // the trunk's axis (toward the platform) and radius
      const trunk = new THREE.Group(); trunk.position.set(T[0], 0.5, T[2]); g.add(trunk);
      for (const y of [0, 11 * U]) for (let q = 0; q < 4; q++) { const cp = curvedPanel(L.brown, R, q * Math.PI / 2); cp.position.y = y; trunk.add(cp); }
      // light gray 3L pin connectors in the seams, green 3L liftarms and a light brown 7L liftarm on the front
      for (const y of [0.8, 7.2, 9.6, 16.0]) for (const sx of [-1, 1]) trunk.add(beamAB(L.lbg, [sx * 0.3, y, R - 0.1], [sx * 0.3, y + 2 * U, R - 0.1], Z));
      trunk.add(beamAB(L.green, [-1.2, 0.8, R], [-1.2, 0.8 + 2 * U, R], Z), beamAB(L.green, [1.2, 0.8, R], [1.2, 0.8 + 2 * U, R], Z), beamAB(L.nougat, [1.4, 2.2, -R], [1.4, 2.2 + 6 * U, -R], Z));
      trunk.add(beamAB(L.nougat, [-0.8, 16.0, R], [-0.8, 16.0 + 2 * U, R], Z));
      for (const [y, m] of [[11.6, L.green], [11.6, L.pink]]) trunk.add(round(0.5, 1, m, m === L.pink ? -0.5 : 0.5, y, R + 0.05, true).rotateX(Math.PI / 2));
      // roots (steps 9-11): brown 11L and light brown 7L liftarms lying on the mat, green L plates and
      // curved slopes on them, brown tall bricks with slope tiles
      for (const [ang, len, mat] of [[0, 11, L.brown], [Math.PI, 11, L.brown], [Math.PI / 2, 7, L.nougat], [-Math.PI / 2, 7, L.nougat]]) {
        const rt = new THREE.Group(); rt.position.set(T[0], 0, T[2]); rt.rotation.y = ang;
        rt.add(flatBeam(len, mat, (len - 1) * U / 2 - 0.4, 0.36, 0));
        rt.add(plate(3, 3, L.green, len * U / 2 - 0.4, 0.72, 0), curve(2, 2, L.green, len * U / 2 + 0.8, 0.72 + PLATE, 0, 0));
        rt.add(brick(1, 1, 6, L.brown, len * U - 1.0, 0, 0.8));
        g.add(rt);
      }
      // above the trunk (steps 22-45): an upright brown 15L liftarm (the tallest) and an 11L beside it, red
      // 7L lever, and the branches - pairs of brown 7x3 bent liftarms arching out to each side
      const top = 0.5 + 22 * U;
      trunk.add(beamAB(L.brown, [-0.4, 11 * U + 1.6, R + 0.4], [-0.4, 11 * U + 1.6 + 14 * U, R + 0.4], Z), beamAB(L.brown, [0.6, 11 * U + 1.6, R + 0.4], [0.6, 11 * U + 1.6 + 10 * U, R + 0.4], Z));
      trunk.add(beamAB(L.red, [-2.6, 11 * U + 1.6, R + 1.1], [2.2, 11 * U + 1.6, R + 1.1], Z));
      const tipY = 11 * U + 1.6 + 14 * U;
      const branch = (sx) => { // an arch of two bent liftarms from the tallest liftarm out to one side
        const p0 = [-0.4, tipY - U, R + 0.4], p1 = [-0.4 + sx * 3.2, tipY + 1.4, R + 0.4], p2 = [-0.4 + sx * 6.4, tipY - 0.6, R + 0.4];
        trunk.add(beamAB(L.brown, p0, p1, Z), beamAB(L.brown, p1, p2, Z), brick(2, 1, 3, L.brown, p1[0], p1[1] + 0.36, p1[2]), brick(1, 1, 3, L.brown, p2[0], p2[1] + 0.36, p2[2]));
        return [p1, p2];
      };
      const [lMid, lEnd] = branch(-1), [rMid, rEnd] = branch(1);
      trunk.add(beamAB(L.lime, [-0.4, tipY - 2 * U, R + 1.1], [-0.4 + 3 * U, tipY - 2 * U, R + 1.1], Z)); // lime 2x4 L-shaped liftarm
      // canopies (steps 96-101): green and light green 6x5 plant leaves, red flower plates with orange leaves
      const canopyAt = (p, turn, n) => {
        for (let i = 0; i < n; i++) {
          const pl = plantLeaves(i % 2 ? L2.lightGreen : L.green);
          pl.position.set(p[0] + Math.cos(turn + i * 2.1) * 1.6, p[1] + BRICK + 0.4 + i * 0.12, p[2] + Math.sin(turn + i * 2.1) * 1.6);
          pl.rotation.y = turn + i * 2.1; trunk.add(pl);
        }
        trunk.add(round(0.5, 1, L.red, p[0], p[1] + BRICK + 0.9, p[2] + 0.4, true), leaf(0.9, 0.4, L.orange, p[0], p[1] + BRICK + 1.3, p[2] + 0.4, 0, 0.6));
      };
      canopyAt(lEnd, 0.4, 3); canopyAt(lMid, 2.0, 3); canopyAt(rMid, 1.2, 3); canopyAt(rEnd, -0.6, 2);
      canopyAt([-0.4, tipY + 0.4, R + 0.4], 3.0, 2);
      const b1 = bird(L.white); b1.position.set(lEnd[0] + 0.4, lEnd[1] - 1.6, lEnd[2] + 0.9); trunk.add(b1);
      const b2 = bird(plastic('#f3e7a4')); b2.position.set(rMid[0] - 1.4, rMid[1] + BRICK + 0.6, rMid[2] - 0.6); trunk.add(b2);
      const frog = new THREE.Mesh(cached('frogBody', () => new THREE.SphereGeometry(0.5, 14, 10)), L.green); frog.scale.set(1.2, 0.7, 0.9); frog.position.set(0.8, 2 * 11 * U + 0.3, 0.6); trunk.add(frog);
      // the vine (steps 77-92): dark green axle connectors and dark tan and green macaroni tubes on red axles,
      // from a lime 5L liftarm on the front root, wound up round the trunk and hooked over a branch. Pulled
      // down, it becomes a loose model lying on the mat.
      const end = [0, 8, f.d / 2 + 1.8]; // the vine's end ball: its slot in sim.js
      const pts = [];
      for (let i = 0; i <= 28; i++) { const t = i / 28, a2 = Math.PI / 2 + t * Math.PI * 2.2, rr = R + 0.45; pts.push([T[0] + Math.cos(a2) * rr, 1.2 + t * 12.5, T[2] + Math.sin(a2) * rr]); }
      pts.push([end[0] + 0.6, end[1] + 2.0, end[2] - 1.6], [end[0], end[1] + 0.4, end[2]]);
      const vine = new THREE.Group();
      const curveV = new THREE.CatmullRomCurve3(pts.map(V3));
      vine.add(new THREE.Mesh(new THREE.TubeGeometry(curveV, 140, 0.34, 8, false), plastic('#958a73')));
      for (let i = 1; i < 18; i++) { const c2 = new THREE.Mesh(cached('vineJoint', () => new THREE.CylinderGeometry(0.42, 0.42, 0.7, 10)), i % 3 ? L.green : L.darkGreen); c2.position.copy(curveV.getPointAt(i / 18)); c2.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curveV.getTangentAt(i / 18)); vine.add(c2); }
      const vb = new THREE.Mesh(cached('ball', () => new THREE.SphereGeometry(0.5, 16, 12)), L.lbg); vb.position.set(...end); vine.add(vb);
      g.add(shadowy(vine), beamAB(L.lime, [T[0] - 0.6, 0.36 + U, T[2] + R + 0.9], [T[0] - 0.6 - 4 * U, 0.36 + U, T[2] + R + 0.9], Z));
      return { group: shadowy(g), update(st, sim) { vine.visible = sim.items.some((it) => it.type === 'vine' && it.attached); } };
    },
    platform(f) { // M09 Research Platform, book 7 steps 46-75: the research platform clamped to the tree, with
      // three researchers. Its light gray base stands beside the trunk; the floor rides up when it's raised.
      const g = new THREE.Group();
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
      // steps 46-52: the base - two light gray 15L liftarms, a dark gray 3x7 panel between them, red 3x5
      // L-shaped handles with red 5L liftarms, a yellow 7L liftarm across
      for (const x of [-1.6, 1.6]) g.add(beamAB(L.lbg, [x, 0.36, 5.6], [x, 0.36, 5.6 - 14 * U], X));
      g.add(brick(3, 7, 3, L.dbg, 0, 0.0, 2.0, { studs: false }), flatBeam(7, L.yellow, 0, 0.36 + U, 4.4, Math.PI / 2));
      // the raise handles (step 63): red L-shaped liftarms on the field end with red balls on red axles
      const handle = new THREE.Group();
      for (const x of [-2.4, 2.4]) {
        handle.add(beamAB(L.red, [x, 0.36, 5.6], [x, 0.36 + 2 * U, 5.6], X), beamAB(L.red, [x, 0.36, 5.6], [x, 0.36, 5.6 - 4 * U], X));
        handle.add(rod([x, 0.36 + 2 * U, 5.6], [x, 0.36 + 2 * U, 6.6], 0.22, L.red));
        const ball = new THREE.Mesh(cached('ball', () => new THREE.SphereGeometry(0.5, 16, 12)), L.red); ball.position.set(x, 0.36 + 2 * U, 7.0); handle.add(ball);
      }
      g.add(handle);
      // steps 53-56: two light gray 5x7 hollow frames standing on the panel, black 9L liftarms, the angled
      // light gray 11L liftarms that clamp round the trunk, and 1x12 bricks with jumper plates for the floor
      for (const z of [-0.4, 3.6]) g.add(frameAt(5, 7, L.lbg, [-1.6, BRICK + 0.36, z], X, Y));
      const deck = new THREE.Group();
      deck.position.y = 6.2;
      for (const z of [-0.8, 3.6]) deck.add(beamAB(L.lbg, [2.8, -0.4, z], [2.8 - 10 * U * 0.9, -0.4 + 10 * U * 0.43, z], Z), beamAB(L.black, [2.0, -1.4, z + 0.8], [2.0 - 8 * U, -1.4, z + 0.8], Z));
      for (const z of [-0.4, 3.2]) deck.add(brick(12, 1, 3, L.lbg, 0, -BRICK, z + 0.4, { ry: 0 }));
      // steps 64-70: the floor - tan 2x14 and 6x14 plates with dark tan edges and tan low fences
      const floor = new THREE.Group();
      floor.position.set(0, 0.2, 0.8);
      floor.add(plate(10, 14, L.tan, 0, 0, 0, { ry: Math.PI / 2 }));
      for (const x of [-4.0, 4.0]) floor.add(plate(1, 10, L.darkTan, x * 0.9, PLATE, 0));
      for (const [x, z, ry] of [[-3.6, -3.2, 0], [-3.6, 3.2, 0], [3.6, -3.2, 0], [3.6, 3.2, 0], [-1.6, -5.2, Math.PI / 2], [1.6, -5.2, Math.PI / 2], [-1.6, 5.2, Math.PI / 2], [1.6, 5.2, Math.PI / 2]]) {
        const fence = new THREE.Group(); fence.position.set(x, PLATE, z); fence.rotation.y = ry;
        fence.add(plate(1, 4, L.tan, 0, 0, 0)); for (let i = 0; i < 4; i++) fence.add(rod([0, PLATE, -1.2 + i * 0.8], [0, PLATE + 0.9, -1.2 + i * 0.8], 0.09, L.tan));
        fence.add(rod([0, PLATE + 0.85, -1.4], [0, PLATE + 0.85, 1.4], 0.09, L.tan)); floor.add(fence);
      }
      // the table (step 68): a brown 2x2 round brick, a dark brown 4x4 round plate, a mushroom (white cone,
      // transparent orange dish) and a yellow horn on a red flower plate
      const tb = new THREE.Group(); tb.position.set(0, PLATE, -0.8);
      tb.add(round(1, 3, L.brown, 0, 0, 0), discPlate(4, 1, L2.darkBrown, 0, BRICK, 0));
      const mc = new THREE.Mesh(cached('cone1w', () => new THREE.ConeGeometry(0.38, 0.95, 16)), L.white); mc.position.set(0.8, BRICK + PLATE + 0.48, 1.0); tb.add(mc);
      const md = new THREE.Mesh(cached('dish2o', () => new THREE.SphereGeometry(0.85, 20, 6, 0, Math.PI * 2, 0, 0.9)), plastic('#ff9a3c', { transparent: true, opacity: 0.75, roughness: 0.1 })); md.position.set(0.8, BRICK + PLATE + 0.6, 1.0); tb.add(md);
      tb.add(round(0.5, 1, L.red, -1.2, BRICK + PLATE, -1.2, true), tile(2, 1, L.tan, 0.4, BRICK + PLATE, -0.4));
      floor.add(tb, butterfly(plastic('#9fd3f0'), -1.6, PLATE + 0.4, 2.4, 0));
      const frog2 = new THREE.Mesh(cached('frogBody', () => new THREE.SphereGeometry(0.5, 14, 10)), L.orange); frog2.scale.set(1.2, 0.7, 0.9); frog2.position.set(1.6, PLATE + 0.35, 3.2); floor.add(frog2);
      // steps 57-62: the three researchers
      floor.add(minifig(L.green, L.darkTan, L.darkGreen, -2.2, PLATE, -2.6, 0.5), minifig(L.brown, L2.darkBrown, L.brown, 2.2, PLATE, -2.4, -0.4), minifig(L.darkGreen, L.darkGreen, L.brown, 0.4, PLATE, 2.0, Math.PI));
      deck.add(floor);
      g.add(deck);
      // camera trap: the red 3x5 L-shaped lever with a black handset (steps 5.1-5.6), on the side of the trunk
      const cam = new THREE.Group();
      cam.position.set(-f.w / 2 + 0.3, 8.6, 3.4);
      cam.add(beamAB(L.red, [0, 0, 0], [0, 0, -2 * U], X), beamAB(L.red, [0, 0, 0], [0, -4 * U, 0], X), brick(1, 3, 1, L.black, 0.5, -3 * U, 0, { studs: false }).rotateZ(Math.PI / 2));
      g.add(cam);
      return {
        group: g,
        update(st) {
          ease(deck, 'position.y', 6.2 + padMax(st, 'raise') * 5);
          ease(handle, 'rotation.x', -padMax(st, 'raise') * 0.4);
          ease(cam, 'rotation.x', padDone(st, 'camera') ? 1.3 : 0);
        },
      };
    },
    snail(f) { // M10 spider web habitat (beside the farm dock, as in the missions video), book 8 steps 1-9: a white "spider web" grid of six 9L liftarms standing
      // upright behind a brown gallows of 7x3 bent liftarms on a green L-shaped liftarm stand.
      const g = new THREE.Group();
      const hab = new THREE.Group(); hab.position.x = -2.0; g.add(hab);
      const Z = [0, 0, 1], y0 = 0.36, d45 = Math.SQRT1_2;
      // steps 1-6: lime 2L liftarms and two green 3x5 L-shaped liftarms make the stand
      for (const [sx, z] of [[-1, 0.36], [1, -0.36]]) hab.add(beamAB(L.green, [0, y0, z], [sx * 2 * U, y0, z], Z), beamAB(L.green, [0, y0, z], [0, y0 + 4 * U, z], Z));
      hab.add(beamAB(L.lime, [-U, y0, 1.08], [0, y0, 1.08], Z), beamAB(L.lime, [0, y0, -1.08], [U, y0, -1.08], Z));
      // steps 4-8: the gallows - a brown 7x3 bent liftarm up the stand, another across the top, and a brown
      // 3L liftarm hanging on a free-spinning pin
      const c1 = [0, y0 + 2 * U + 6 * U, 1.08];
      hab.add(beamAB(L.brown, [0, y0 + 2 * U, 1.08], c1, Z), beamAB(L.brown, c1, [2 * U * d45, c1[1] + 2 * U * d45, 1.08], Z));
      const topY = c1[1] + 2 * U * d45;
      hab.add(beamAB(L.brown, [-0.4, topY, 1.8], [-0.4 + 6 * U, topY, 1.8], Z), beamAB(L.brown, [-0.4, topY, 1.8], [-0.4 - 2 * U * d45, topY - 2 * U * d45, 1.8], Z));
      hab.add(beamAB(L.brown, [-0.4 + 5 * U, topY, 2.5], [-0.4 + 5 * U, topY - 2 * U, 2.5], Z));
      // step 9: the web - white 9L liftarms in a 9x9 grid, lines every four holes, upright behind the stand
      const web = new THREE.Group(); web.position.set(0.8, y0, -0.36);
      for (const k of [0, 4, 8]) { web.add(beamAB(L.white, [0, k * U, 0], [8 * U, k * U, 0], Z), beamAB(L.white, [k * U, 0, -0.72], [k * U, 8 * U, -0.72], Z)); }
      hab.add(web);
      // the black spider on a red pin with a stud, just off the middle of the web
      const spider = new THREE.Group();
      spider.add(new THREE.Mesh(cached('spB', () => new THREE.SphereGeometry(0.5, 12, 8)), L.black), new THREE.Mesh(cached('spH', () => new THREE.SphereGeometry(0.32, 10, 8)), L.black));
      spider.children[1].position.y = 0.65;
      for (let i = 0; i < 8; i++) { const s2 = i < 4 ? -1 : 1, k = i % 4; spider.add(rod([0, 0.1 + (k - 1.5) * 0.2, 0], [s2 * 1.1, -0.3 + (k - 1.5) * 0.45, 0.3], 0.05, L.black)); }
      spider.position.set(0.8 + 3 * U, y0 + 5 * U, 0.6);
      hab.add(shadowy(spider));
      return { group: shadowy(g), update() {} };
    },
    spider(f) { // M10 worm habitat (beside the research tree, as in the missions video), book 8 steps 10-23 (the book builds a worm): light gray 4x4 bent liftarm feet,
      // a brown 7x3 bent liftarm neck rising up to the right, and a lime 7x3 head with gray cams and yellow
      // 3L dish eyes on a white bar.
      const g = new THREE.Group();
      const W = new THREE.Group(); W.position.x = -2.2; g.add(W);
      const Z = [0, 0, 1], y0 = 0.36, d45 = Math.SQRT1_2;
      for (const z of [-0.72, 0.72]) W.add(beamAB(L.lbg, [-3 * U, y0, z], [0, y0, z], Z), beamAB(L.lbg, [0, y0, z], [0, y0 + 3 * U, z], Z));
      W.add(beamAB(L.dbg, [-3 * U, y0 + U, 0], [U, y0 + U, 0], Z), rod([-3 * U, y0, -1.2], [-3 * U, y0, 1.2], 0.18, L.yellow), rod([0, y0 + 3 * U, -1.2], [0, y0 + 3 * U, 1.2], 0.18, L.yellow));
      const base = [0, y0 + 3 * U, 0], corner = [base[0] + 6 * U * d45, base[1] + 6 * U * d45, 0];
      W.add(beamAB(L.brown, base, corner, Z), beamAB(L.brown, corner, [corner[0] + 2 * U, corner[1], 0], Z));
      W.add(beamAB(L.brown, [-1.6, y0, 1.3], [-1.6, y0 + 2 * U, 1.3], Z), beamAB(L.brown, [-0.4, y0 + U, -1.3], [-0.4, y0 + 3 * U, -1.3], Z));
      // the head: a lime 7x3 bent liftarm with four dark gray cams, black thin liftarms, an orange connector,
      // a white 4L bar with the two eyes (lime round plates under yellow 3L dishes) and a gold T-bar
      const head = new THREE.Group(); head.position.set(...corner);
      head.add(beamAB(L.lime, [-6 * U, 0.72, 0], [0, 0.72, 0], Z), beamAB(L.lime, [0, 0.72, 0], [2 * U * d45, 0.72 - 2 * U * d45, 0], Z));
      for (const z of [-0.9, -0.6, 0.6, 0.9]) { const cm = new THREE.Mesh(cached('cam', () => { const sh = new THREE.Shape(); sh.absarc(0, 0, 0.7, -2.2, 2.2, false); sh.lineTo(-1.6, 0); sh.closePath(); const e = new THREE.ExtrudeGeometry(sh, { depth: 0.25, bevelEnabled: false }); e.translate(0, 0, -0.125); return e; }), L.dbg); cm.position.set(-6 * U, 0.72, z); head.add(cm); }
      head.add(beamAB(L.black, [2 * U * d45, 0.72 - 2 * U * d45, 0], [2 * U * d45 + 0.5, 0.72 - 2 * U * d45 + 0.6, 0], Z), beamAB(L.orange, [0.9, 1.9, 0], [2.4, 1.9, 0], Z));
      head.add(rod([0.9, 1.9, -1.6], [0.9, 1.9, 1.6], 0.16, L.white), rod([2.4, 1.9, 0], [2.4, 2.6, 0], 0.1, L2.gold), rod([2.4, 2.6, -0.5], [2.4, 2.6, 0.5], 0.1, L2.gold));
      const dish = cached('dish3', () => new THREE.SphereGeometry(1.25, 24, 8, 0, Math.PI * 2, 0, 0.75));
      for (const s2 of [-1, 1]) {
        const eye = new THREE.Group(); eye.position.set(0.9, 1.9, s2 * 1.4); eye.rotation.x = s2 * Math.PI / 2;
        eye.add(round(0.5, 1, L.lime, 0, -0.1, 0, true)); const d = new THREE.Mesh(dish, L.yellow); d.position.y = -0.9; eye.add(d);
        head.add(eye);
      }
      W.add(head);
      return { group: shadowy(g), update() {} };
    },
    window(f) { // M11 Window to the Past, book 9 (40 steps). Local x across the 10-stud front, +z the window side
      // (the door): brown rock walls, green plates on top with roots hanging into the window, plants above.
      const g = new THREE.Group();
      // steps 9-12: the base - brown 1x10, 2x10 and 6x10 plates
      g.add(plate(10, 8, L.brown, 0, 0, -0.4));
      // step 13: four brown 2x4x6 rock panels make the side walls; clear 1x1 and 1x2 bricks on top
      const wallH = 6 * BRICK, rockBump = cached('rockBump', () => new THREE.DodecahedronGeometry(0.42, 0));
      let seed = 3; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      for (const sx of [-1, 1]) for (const z of [-1.6, 1.6]) {
        g.add(brick(2, 4, 18, L.brown, sx * 3.2, PLATE, z - 0.4, { whole: true, studs: false }));
        for (let i = 0; i < 14; i++) { const r2 = new THREE.Mesh(rockBump, rnd() < 0.3 ? L2.darkBrown : L.brown); r2.position.set(sx * (4.0 + 0.05), PLATE + 0.4 + rnd() * (wallH - 0.8), z - 0.4 + (rnd() - 0.5) * 3); r2.rotation.set(rnd() * 3, rnd() * 3, 0); r2.scale.set(0.6, 1, 1); g.add(r2); }
        g.add(brick(1, 1, 3, L2.transClear, sx * 3.6, PLATE + wallH, z - 1.6), brick(1, 2, 3, L2.transClear, sx * 2.8, PLATE + wallH, z));
      }
      // steps 15-31: green 2x8, 4x8 and 2x8 plates span the walls; roots hang from them into the window
      const yT = PLATE + wallH + BRICK;
      g.add(plate(8, 2, L.green, 0, yT, -3.2), plate(8, 4, L.green, 0, yT, -0.8), plate(8, 2, L.green, 0, yT, 1.6));
      g.add(tube([[1.2, yT, -3.2], [1.0, yT - 1.2, -3.0], [0.2, yT - 2.2, -2.6]], 0.38, L.tan));
      g.add(round(1, 3, L.brown, 0.2, yT - 3.3, -2.6), rod([0.2, yT - 3.3, -2.6], [0.2, yT - 4.1, -2.6], 0.12, L.tan));
      const inv = new THREE.Mesh(cached('invCone2', () => new THREE.CylinderGeometry(0.8, 0.3, 1.6, 16)), L.brown); inv.position.set(0, yT - 0.8, -0.8); g.add(inv);
      g.add(rod([0, yT - 1.6, -0.8], [0, yT - 4.0, -0.8], 0.1, L.white), brick(1, 1, 3, L.brown, 0, yT - 3.4, -0.8, { studs: false }));
      for (let i = 0; i < 4; i++) { const a2 = i * Math.PI / 2; g.add(rod([0, yT - 3.0, -0.8], [Math.cos(a2) * 0.9, yT - 3.6, -0.8 + Math.sin(a2) * 0.9], 0.06, L.tan)); }
      const tc = new THREE.Mesh(cached('cone2t', () => new THREE.CylinderGeometry(0.15, 0.8, 1.6, 16)), L.tan); tc.rotation.x = Math.PI; tc.position.set(0.8, yT - 0.8, 1.6); g.add(tc);
      // the plants on top
      const gc = new THREE.Mesh(cached('cone2g', () => new THREE.CylinderGeometry(0.15, 0.8, 1.6, 16)), L.green); gc.position.set(2.0, yT + PLATE + 0.8, -3.2); g.add(gc);
      for (const [x, z, m] of [[1.4, -3.6, L.pink], [2.6, -3.4, L.yellow], [2.0, -2.6, L.orange]]) { g.add(tube([[2.0, yT + 1.6, -3.2], [(2.0 + x) / 2, yT + 2.6, (z - 3.2) / 2], [x, yT + 3.3, z]], 0.07, L.green)); g.add(round(m === L.orange ? 1 : 0.5, 1, m, x, yT + 3.3, z, m !== L.orange)); }
      g.add(round(1, 3, L.brown, -2.4, yT + PLATE, -0.4), round(1, 1, L.tan, -2.4, yT + PLATE + BRICK, -0.4)); // the stump with its tree rings
      g.add(leaf(1.4, 0.6, L.green, -2.4, yT + PLATE + BRICK + 0.3, -1.4, Math.PI / 2, 0.4), leaf(1.4, 0.6, L.green, -1.4, yT + PLATE + BRICK + 0.3, -0.4, 0, 0.4));
      const dome = new THREE.Mesh(cached('dome2b', () => new THREE.SphereGeometry(0.8, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), L.brown); dome.position.set(-1.2, yT + 2 * PLATE, 1.6); g.add(dome);
      g.add(tube([[-1.2, yT + 1.1, 1.6], [-0.8, yT + 2.0, 1.2], [-0.4, yT + 2.4, 0.8], [0.0, yT + 3.0, 0.6]], 0.2, L.pink));
      const pl = plantLeaves(plastic('#b38dd6')); pl.position.set(0.0, yT + 3.1, 0.6); pl.rotation.y = -0.8; g.add(pl);
      g.add(leaf(1.6, 0.5, L.darkGreen, 1.2, yT + PLATE + 0.6, 0.4, 0.3, 1.2), leaf(1.6, 0.5, L.darkGreen, 1.6, yT + PLATE + 0.6, 0.4, 2.8, 1.2));
      const frog = new THREE.Mesh(cached('frogBody', () => new THREE.SphereGeometry(0.5, 14, 10)), plastic('#f3e7a4')); frog.scale.set(1.2, 0.7, 0.9); frog.position.set(1.4, yT + PLATE + 0.35, -0.2); g.add(frog);
      g.add(round(0.5, 1, L.red, 3.2, yT + PLATE, 1.2, true), round(1, 1, plastic('#9fd3f0'), 2.4, yT + PLATE + 1.0, 2.0));
      const wc = new THREE.Mesh(cached('cone1w', () => new THREE.ConeGeometry(0.38, 0.95, 16)), L.white); wc.position.set(2.4, yT + PLATE + 0.48, 2.0); g.add(wc);
      // steps 39-40: the nut hanging from a brown curved bar at the front
      g.add(tube([[-0.4, yT + PLATE, 2.4], [-0.4, yT + 2.2, 2.6], [-0.4, yT + 3.6, 3.4]], 0.12, L.brown));
      const nut = new THREE.Group(); nut.position.set(-0.4, yT + 2.4, 3.6);
      nut.add(brick(1, 1, 3, L.tan, 0, 0, 0, { studs: false }), round(0.5, 3, L.brown, 0, -BRICK, 0), rod([0, 1.0, 0], [0, 1.6, 0], 0.15, L.red));
      g.add(nut);
      // steps 1-8: the hinged door on the window side - a red 1x12 plate, a brown 6x10 plate, a black 2x4 tile,
      // red tiles and a shovel - standing closed over the window until it's knocked down
      const cover = new THREE.Group();
      cover.position.set(0, PLATE, f.d / 2 + 0.6); // its bar handle sticks out of the front, where the robot hooks it
      const door = new THREE.Group(); door.rotation.x = -Math.PI / 2; // built lying flat, stood up on its hinges
      door.add(plate(10, 6, L.brown, 0, 0, 2.4), plate(12, 1, L.red, 0, 0, 0.0), tile(4, 2, L.black, -1.6, PLATE, 0.4), tile(4, 1, L.red, 3.2, PLATE, 0.0), tile(1, 3, plastic('#a95500'), 3.2, PLATE, 2.0));
      door.add(rod([-2.4, -0.2, 2.4], [-0.4, -0.2, 2.4], 0.1, L.dbg));
      cover.add(door);
      g.add(cover);
      return { group: g, update(st) { const p = padMax(st, 'cover'); ease(cover, 'rotation.x', p >= 0.9 ? Math.PI / 2 : p * 0.5); } }; // pulled by its bar, then it falls open
    },
    elder(f) { // M12 Forest Elder, book 10 steps 1-23: a tan tree on a green 8x8 round plate. Its trunk is tan 2x2
      // round bricks on a yellow 11L axle, topped by a bent cylinder and a segmented bent horn with leafy
      // branches; dark tan support arms wrap round it, and the red ring hangs from it on a 21 link chain.
      const g = new THREE.Group();
      const X = [1, 0, 0], Z = [0, 0, 1];
      // steps 1-8: the base
      g.add(discPlate(8, 1, L.green, 0, 0, 0));
      for (const [x, z] of [[0, -2.4], [0, -1.6], [-1.6, -1.6], [1.6, -1.6]]) { const wp = new THREE.Mesh(cached('wall12', () => boxGeo(2 * U - 0.04, BRICK, 0.2)), L.red); wp.position.set(x, PLATE + BRICK / 2, z + (z < -2 ? -0.3 : 0.3)); g.add(wp); g.add(plate(2, 1, L.red, x, PLATE, z)); }
      g.add(brick(1, 2, 3, L.green, 2.8, PLATE, 0), brick(1, 2, 3, L.lbg, 2.0, PLATE, 0), round(2, 3, L.lbg, -0.4, PLATE, 0.4));
      g.add(plate(2, 3, L.green, -0.4, PLATE + BRICK, 2.0), plate(3, 2, L.green, 1.6, PLATE + BRICK, 0.0));
      g.add(round(0.5, 1, L.green, -2.4, PLATE, 0.8, true));
      const frog = new THREE.Mesh(cached('frogBody', () => new THREE.SphereGeometry(0.5, 14, 10)), plastic('#c8307c')); frog.scale.set(1.2, 0.7, 0.9); frog.position.set(-2.4, 2 * PLATE + 0.35, 0.8); g.add(frog);
      g.add(tube([[2.4, PLATE + 0.5, 0], [3.4, PLATE + 0.9, 0], [4.2, PLATE + 2.0, 0]], 0.12, L.brown)); // the brown curved bar
      // step 9: the trunk - tan 2x2 round bricks and plates on the axle, a sand green plate with four bars
      const T = [-0.4, PLATE + BRICK, 0.4];
      let y = T[1];
      for (const [k, m] of [[3, L.tan], [1, L2.sandGreen], [3, L.tan], [3, L.tan], [3, L.tan], [3, L.tan], [3, L.tan], [1, L.tan]]) { g.add(round(1, k, m, T[0], y, T[2])); y += k * PLATE; }
      for (const a2 of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) g.add(rod([T[0] + Math.cos(a2) * 0.8, T[1] + 3 * PLATE + 0.15, T[2] + Math.sin(a2) * 0.8], [T[0] + Math.cos(a2) * 1.2, T[1] + 3 * PLATE + 0.15, T[2] + Math.sin(a2) * 1.2], 0.08, L2.sandGreen));
      for (const sz of [-1, 1]) g.add(leaf(1.4, 0.6, L.green, T[0], T[1] + 3 * PLATE + 0.2, T[2] + sz * 1.6, Math.PI / 2, 0.3));
      // the tan 2x2 bent cylinder, then (step 10) another round brick and the segmented bent horn
      const bend = [[T[0], y, T[2]], [T[0] + 0.2, y + 1.2, T[2] + 0.5], [T[0] + 0.3, y + 2.0, T[2] + 1.6]];
      g.add(tube(bend, 0.78, L.tan));
      const top = [T[0] + 0.3, y + 2.2, T[2] + 2.3];
      const horn = []; for (let i = 0; i <= 6; i++) horn.push([top[0] - i * 0.45, top[1] + 0.9 + i * 0.5, top[2] + 0.4 - i * 0.2]);
      for (let i = 0; i < 6; i++) g.add(rod(horn[i], horn[i + 1], 0.75 - i * 0.09, L.tan));
      g.add(round(1, 3, L.tan, top[0], top[1] - 0.4, top[2]).rotateX(1.2), rod(horn[6], [horn[6][0] - 0.3, horn[6][1] + 0.6, horn[6][2] - 0.4], 0.12, L.red));
      // steps 11-19: leafy branches - tan macaroni tubes and cones, green 1x2 leaf plates, an orange butterfly
      for (const [p, dir] of [[horn[3], 1], [horn[5], -1], [[top[0], top[1] + 0.4, top[2] - 0.6], 0.4]]) {
        const q = [p[0] + dir * 1.6, p[1] + 0.3, p[2] - 0.8];
        g.add(tube([p, [p[0] + dir * 0.9, p[1] + 0.5, p[2] - 0.3], q], 0.32, L.tan));
        for (let i = 0; i < 3; i++) g.add(leaf(2.4, 1.0, i % 2 ? L.green : L.brightGreen, q[0] + dir * 0.6 * i, q[1] + 0.6 + i * 0.25, q[2] - 0.4 * i, dir * 0.6 + i * 1.2, -0.5));
      }
      g.add(butterfly(L.orange, horn[3][0] + 1.6, horn[3][1] + 1.6, horn[3][2] - 0.6, 0.3));
      // step 21: the support - dark tan 3L axle connectors on red axles ending in two dark brown arms that
      // wrap round the trunk. Pushed, it swings up (the cane).
      const cane = new THREE.Group(); cane.position.set(2.4, PLATE + 0.4, 1.8);
      cane.add(rod([0, 0, 0], [0, 4.6, 0], 0.3, L.darkTan), rod([0, 0, 0], [0, 1.6, 0], 0.32, L.green));
      for (const sz of [-1, 1]) cane.add(rod([0, 4.6, 0], [-1.6, 5.2, sz * 1.4], 0.26, L2.darkBrown), rod([-1.6, 5.2, sz * 1.4], [-2.8, 5.4, sz * 0.9], 0.26, L2.darkBrown));
      g.add(cane);
      // step 23: a root on the curved bar - a tan 2x2x2 cone on a tan round brick and green round plate
      const rootC = new THREE.Mesh(cached('cone2t', () => new THREE.CylinderGeometry(0.15, 0.8, 1.6, 16)), L.tan); rootC.position.set(4.2, PLATE + 0.6, 0); rootC.rotation.x = Math.PI; g.add(rootC);
      // step 22: the light gray 21 link chain from halfway up the trunk to the ring (the ring is a loose model)
      const links = [], linkG = cached('chainLink', () => new THREE.TorusGeometry(0.16, 0.05, 6, 10));
      for (let i = 0; i < 21; i++) { const l2 = new THREE.Mesh(linkG, L.lbg); l2.scale.set(1, 1.5, 1); l2.userData.moves = true; g.add(l2); links.push(l2); }
      const anchor = new THREE.Vector3(T[0] - 1.0, T[1] + 4 * BRICK, T[2]), tieW = new THREE.Vector3(), tieL = new THREE.Vector3(), mid = new THREE.Vector3();
      return {
        group: shadowy(g),
        update(st, sim) {
          ease(cane, 'rotation.z', st.presses ? 0.7 : 0);
          const tie = sim.items.find((it) => it.type === 'tie');
          if (!tie) return;
          tieW.set(tie.x, 0.12 + (tie.z || 0) + 0.5, tie.y); tieL.copy(tieW); g.updateMatrixWorld(); g.worldToLocal(tieL); // (fresh: the first frame comes before a render)
          const sag = Math.max(0, 6 - anchor.distanceTo(tieL)) * 0.6;
          links.forEach((l2, i) => {
            const t = (i + 0.5) / 21;
            mid.lerpVectors(anchor, tieL, t); mid.y -= Math.sin(t * Math.PI) * sag;
            l2.position.copy(mid); l2.rotation.set(0, i % 2 ? Math.PI / 2 : 0, 0);
          });
        },
      };
    },
    post(f) { // M12 post, book 10 step 24: the small frame - a light gray 1x11.5 double bent liftarm (7L lying flat,
      // 3L standing up), dark gray 3L liftarms on pins, and red 2L liftarms on a yellow 3L axle at the top
      const g = new THREE.Group();
      const X = [1, 0, 0], d45 = Math.SQRT1_2, y0 = 0.36;
      const a0 = [0, y0, 2.4], a1 = [0, y0, 2.4 - 6 * U], a2 = [0, y0 + U * d45 * 1.4, a1[2] - U * d45 * 1.4], a3 = [0, a2[1] + 2 * U, a2[2]];
      g.add(beamAB(L.lbg, a0, a1, X), beamAB(L.lbg, a1, a2, X), beamAB(L.lbg, a2, a3, X));
      g.add(beamAB(L.dbg, [0.72, y0, 2.4 - 2 * U], [0.72, y0, 2.4 - 4 * U], X), beamAB(L.dbg, [-0.72, y0, 2.4 - 3 * U], [-0.72, y0, 2.4 - 5 * U], X));
      g.add(rod([-1.2, a3[1], a3[2]], [1.2, a3[1], a3[2]], 0.18, L.yellow));
      for (const sx of [-0.72, 0.72]) g.add(beamAB(L.red, [sx, a3[1], a3[2]], [sx, a3[1], a3[2] + U], X));
      return { group: shadowy(g), update() {} }; // the red ring drops over it
    },
    // interchangeable models
    restoration(f) { // M13 Keystone Species, book 11 steps 1-36: a black and green Technic box with an insert of four
      // young trees (green cloud plates on brown liftarms) that pop up. Built long along x, then turned to
      // lie along the dock it's on.
      const g = new THREE.Group();
      const B = new THREE.Group(); if (f.d > f.w) B.rotation.y = Math.PI / 2; g.add(B);
      const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1], y0 = 0.36;
      // steps 1-21: the rectangle - two black 7x11 hollow frames standing as its ends, dark gray 9L liftarms
      // and black 3x5 L-shaped liftarms along its sides, green 7L liftarms standing inside each end
      for (const sx of [-1, 1]) {
        const x = sx * 5.2;
        B.add(frameAt(11, 7, L.black, [x, y0, -4.0], Z, Y));
        for (const z of [-1.2, 0.4]) B.add(beamAB(L.green, [x - sx * 0.72, y0, z], [x - sx * 0.72, y0 + 6 * U, z], X));
        // the lime connector with a yellow tile on a brown axle, on top of each end
        B.add(beamAB(L.lime, [x, y0 + 6 * U + 0.72, 3.2], [x, y0 + 6 * U + 0.72, 1.6], Y), tile(2, 1, L.yellow, x, y0 + 6 * U + 1.1, 3.6, { ry: Math.PI / 2 }));
        B.add(rod([x, y0 - 0.2, 3.2], [x, y0 + 6 * U + 1.2, 3.2], 0.16, L.brown));
      }
      for (const sz of [-1, 1]) {
        const z = sz * 4.7;
        B.add(beamAB(L.dbg, [-3.2, y0, z], [3.2, y0, z], Z));
        for (const sx of [-1, 1]) B.add(beamAB(L.black, [sx * 4.4, y0, z], [sx * 2.0, y0, z], Z), beamAB(L.black, [sx * 4.4, y0, z], [sx * 4.4, y0 + 2 * U, z], Z));
        // steps 22: green 15L liftarms raise the sides, with red and dark gray ball pins
        B.add(beamAB(L.green, [-5.6, y0 + 6 * U, z], [5.6, y0 + 6 * U, z], Z));
        for (const x of [-2.4, 2.4]) { const bp = new THREE.Mesh(cached('ballPin', () => new THREE.SphereGeometry(0.3, 12, 8)), x < 0 ? L.red : L.dbg); bp.position.set(x, y0 + 6 * U, z + sz * 0.7); B.add(bp); }
      }
      // steps 23-36: the insert - a light gray 5x11 panel, black 3x3 square liftarms, a black 7x11 hollow frame
      // lying flat on it, and the four trees on brown 7L liftarms; light brown handles at the front and back
      const ins = new THREE.Group();
      ins.add(new THREE.Mesh(cached('panel5x11', () => boxGeo(11 * U - 0.04, U - 0.04, 5 * U - 0.04)), L.lbg).translateY(U / 2));
      ins.add(frameAt(11, 7, L.black, [-4.0, U + 0.36, -2.4], X, Z));
      for (const sz of [-1, 1]) ins.add(frameAt(3, 3, L.black, [-0.8, U, sz * 2.4], X, Y));
      const trees = [];
      for (const [x, z, flip] of [[-3.2, -2.4, 1], [-3.2, 2.4, 1], [3.2, -2.4, -1], [3.2, 2.4, -1]]) {
        const t = new THREE.Group(); t.position.set(x, U + 0.72, z);
        t.add(beamAB(L.brown, [0, 0, 0], [0, 6 * U, 0], X));
        const cloud = new THREE.Group(); cloud.position.y = 6 * U + 0.4; cloud.rotation.x = Math.PI / 2;
        for (const [cx, cz, r] of [[0, 0, 1.1], [-0.9, 0.3, 0.8], [0.9, 0.3, 0.8], [0, -0.7, 0.7]]) cloud.add(round(r / U, 1, L.green, cx, 0, cz));
        cloud.add(round(0.5, 1, flip > 0 ? L.lime : L.red, 0.8, PLATE, 0, true), round(0.5, 1, L.green, -0.8, PLATE, 0, true));
        t.add(cloud); trees.push(t); ins.add(t);
      }
      for (const sz of [-1, 1]) ins.add(rod([0, U + 1.2, sz * 3.2], [0, U + 1.2, sz * 4.4], 0.35, L.nougat));
      B.add(ins);
      return { group: shadowy(g), update(st) { ease(ins, 'position.y', padMax(st, 'trees') * 2.6); } };
    },
    replant(f) { // M14 Seeds of Renewal, book 12 steps 1-20: the same Technic box as M13 (black 7x11 ends, green
      // sides) with brown 15L rails on top and eight brown cradles swinging inside it.
      const g = new THREE.Group();
      const B = new THREE.Group(); if (f.d > f.w) B.rotation.y = Math.PI / 2; g.add(B);
      const Y = [0, 1, 0], Z = [0, 0, 1], X = [1, 0, 0], y0 = 0.36, topY = y0 + 6 * U;
      for (const sx of [-1, 1]) {
        const x = sx * 5.2;
        B.add(frameAt(11, 7, L.black, [x, y0, -4.0], Z, Y), frameAt(3, 3, L.dbg, [x - sx * 0.72, y0 + U, sx > 0 ? -3.2 : 1.6], Z, Y));
        B.add(beamAB(L.lime, [x, topY + 0.72, sx * 3.2], [x, topY + 0.72, sx * 1.6], Y), tile(2, 1, L.yellow, x, topY + 1.1, sx * 3.6, { ry: Math.PI / 2 }));
        B.add(rod([x, y0 - 0.2, sx * 3.2], [x, topY + 1.2, sx * 3.2], 0.16, L.brown));
      }
      for (const sz of [-1, 1]) {
        const z = sz * 4.7;
        B.add(beamAB(L.green, [-3.2, y0, z], [3.2, y0, z], Z));
        for (const sx of [-1, 1]) B.add(beamAB(L.green, [sx * 4.4, y0, z], [sx * 2.0, y0, z], Z), beamAB(L.green, [sx * 4.4, y0, z], [sx * 4.4, y0 + 2 * U, z], Z));
        B.add(beamAB(L.brown, [-5.6, topY, z], [5.6, topY, z], Z)); // brown 15L rails
      }
      // step 19: six cradles hang from the rails' free-spinning pins - two brown 3L liftarms joined by brown
      // 5L axles and a light brown 3L axle connector
      const cradles = [];
      for (let i = 0; i < 6; i++) {
        const x = -4.0 + i * 1.6, c = new THREE.Group(); c.position.set(x, topY, 0);
        for (const sz of [-1, 1]) c.add(beamAB(L.brown, [0, 0, sz * 4.0], [0, -2 * U, sz * 4.0], Z));
        c.add(rod([0, -2 * U, -4.0], [0, -2 * U, -1.2], 0.16, L.brown), rod([0, -2 * U, 1.2], [0, -2 * U, 4.0], 0.16, L.brown), rod([0, -2 * U, -1.2], [0, -2 * U, 1.2], 0.3, L.nougat));
        B.add(c); cradles.push(c);
      }
      // step 20: two more across the ends, with dark green 3L axle connectors
      for (const z of [-1.6, 0.0]) {
        const c = new THREE.Group(); c.position.set(0, topY, z);
        for (const sx of [-1, 1]) c.add(beamAB(L.brown, [sx * 4.4, 0, 0], [sx * 4.4, -2 * U, 0], X));
        c.add(rod([-4.4, -2 * U, 0], [-1.6, -2 * U, 0], 0.16, L.brown), rod([1.6, -2 * U, 0], [4.4, -2 * U, 0], 0.16, L.brown), rod([-1.6, -2 * U, 0], [-0.4, -2 * U, 0], 0.3, L.brown), rod([-0.4, -2 * U, 0], [1.6, -2 * U, 0], 0.3, L.darkGreen));
        B.add(c);
      }
      return { group: shadowy(g), update() {} };
    },
    building(f) { // M15 Biocentric Architecture, book 13 steps 5-89: a greenhouse. Built long along x, then turned
      // to lie along its dock: a white floor with a stream and plants, tan walls with black windows, lime 7x11
      // hollow frames on both ends, and on the roof a sliding skylight, a lime garden plate that rises, a hinged
      // black hatch with a red ball handle, and a bird's nest.
      const g = new THREE.Group();
      const B = new THREE.Group(); if (f.d > f.w) B.rotation.y = Math.PI / 2; g.add(B);
      const Y = [0, 1, 0], Z = [0, 0, 1], X = [1, 0, 0], y0 = 0.36;
      // steps 5-15: the floor, a transparent blue stream, green tiles with plants
      B.add(plate(12, 11, L.white, 0, 0, 0));
      const transBlue = plastic('#59b6e8', { transparent: true, opacity: 0.7, roughness: 0.08 });
      B.add(tile(1, 2, transBlue, -3.6, PLATE, -2.4), tile(1, 1, transBlue, -3.6, PLATE, -1.2), tile(1, 1, transBlue, -2.8, PLATE, -2.8));
      for (const [x, z] of [[-2.4, -1.6], [-0.8, -1.6], [-2.4, 0.0], [-0.8, 0.0]]) B.add(tile(2, 2, L.green, x, PLATE, z), round(0.3, 1, L.green, x, 2 * PLATE, z));
      B.add(round(0.5, 1, L.pink, -2.4, 2 * PLATE, -1.6, true));
      for (let i = 0; i < 3; i++) { const pet = new THREE.Mesh(cached('petal', () => new THREE.CylinderGeometry(0.55, 0.3, 0.3, 6)), L.green); pet.position.set(-0.8, 2 * PLATE + 0.3 + i * 0.6, -1.6); B.add(pet); }
      B.add(round(0.5, 1, L.red, -0.8, 2 * PLATE + 1.9, -1.6, true));
      for (let i = 0; i < 6; i++) { const a2 = i * Math.PI / 3; B.add(rod([-2.4, 2 * PLATE + 0.2, 0], [-2.4 + Math.cos(a2) * 0.6, 2 * PLATE + 1.4, Math.sin(a2) * 0.6], 0.05, L.green), round(0.5, 1, i % 2 ? L.green : L.yellow, -2.4 + Math.cos(a2) * 0.6, 2 * PLATE + 1.4, Math.sin(a2) * 0.6)); }
      // steps 9-56: the tan walls along the front and back, with black 1x2x2 windows, green 1x2 bricks with
      // holes at the corners and dark tan plates and tan round plates on them
      const win = (x, z, ry) => {
        const w = new THREE.Group(); w.position.set(x, PLATE + BRICK, z); w.rotation.y = ry || 0;
        w.add(brick(2, 1, 6, L.black, 0, 0, 0, { whole: true, studs: true }));
        const pane = new THREE.Mesh(cached('pane12', () => new THREE.BoxGeometry(2 * U - 0.3, 2 * BRICK - 0.3, 0.08)), L2.transClear); pane.position.y = BRICK; w.add(pane);
        B.add(w);
      };
      for (const sz of [-1, 1]) {
        const z = sz * 4.0;
        B.add(brick(12, 1, 3, L.tan, 0, PLATE, z));
        for (const x of [-3.6, 2.4]) win(x, z);
        for (const [x, n] of [[-1.2, 4], [4.4, 2]]) B.add(brick(n, 1, 6, L.tan, x, PLATE + BRICK, z));
        B.add(brick(2, 1, 6, L.green, -4.4 + 0.0, PLATE + BRICK, z, { whole: true }), brick(1, 1, 6, L.green, 0.8, PLATE + BRICK, z, { whole: true }));
        B.add(brick(12, 1, 3, L.tan, 0, PLATE + 3 * BRICK, z), plate(2, 1, L.darkTan, -4.0, PLATE + 4 * BRICK, z), round(0.5, 1, L.tan, 3.6, PLATE + 4 * BRICK, z));
      }
      // steps 74-89: lime green 7x11 hollow frames on both ends, with the lime connectors and yellow tiles
      const roofY = PLATE + 4 * BRICK;
      for (const sx of [-1, 1]) {
        const x = sx * 5.2;
        B.add(frameAt(11, 7, L.lime, [x, y0, -4.0], Z, Y));
        B.add(beamAB(L.lime, [x, y0 + 6 * U + 0.72, sx * 3.2], [x, y0 + 6 * U + 0.72, sx * 1.6], Y), tile(2, 1, L.yellow, x, y0 + 6 * U + 1.1, sx * 3.6, { ry: Math.PI / 2 }));
        B.add(rod([x, y0 - 0.2, sx * 3.2], [x, y0 + 6 * U + 1.2, sx * 3.2], 0.16, L.brown));
      }
      // the crank (steps 20-30): black 3x3 quarter circle liftarms and a red ball handle at the front left
      const crank = new THREE.Group(); crank.position.set(-3.2, PLATE + BRICK, 4.5);
      for (const z of [-0.3, 0.3]) crank.add(tube(Array.from({ length: 9 }, (_, i) => { const a2 = (i / 8) * Math.PI / 2; return [Math.cos(a2) * 1.6 - 0.8, Math.sin(a2) * 1.6, z]; }), 0.3, L.black));
      crank.add(rod([-0.8, 1.6, 0], [-0.8, 1.6, 1.4], 0.18, L.yellow));
      const cb = new THREE.Mesh(cached('ball', () => new THREE.SphereGeometry(0.5, 16, 12)), L.red); cb.position.set(-1.6, 1.0, 1.8); crank.add(cb);
      crank.add(rod([-0.8, 1.6, 1.4], [-1.6, 1.0, 1.4], 0.16, L.black));
      B.add(crank);
      // the roof: tan 4x6 plates in the middle, and the bird's nest (steps 59-63)
      B.add(plate(6, 4, L.tan, -0.4, roofY, -1.6), plate(6, 4, L.tan, -0.4, roofY, 1.6));
      const nest = new THREE.Group(); nest.position.set(-0.4, roofY + PLATE, -1.2);
      nest.add(discPlate(4, 1, L.tan, 0, 0, 0));
      for (const [x, z] of [[0.4, 0.4], [0.4, -0.4], [-0.4, 0.4], [-0.4, -0.4]]) nest.add(leaf(1.0, 0.5, L2.gold, x * 1.6, PLATE + 0.1, z * 1.6, Math.atan2(z, x), 0.6));
      const egg = new THREE.Mesh(cached('egg', () => new THREE.SphereGeometry(0.35, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)), plastic('#f6d7b3')); egg.position.set(0.4, PLATE, 0.4); nest.add(egg);
      B.add(nest);
      const bb = bird(L.medAzure); bb.position.set(-2.2, roofY + PLATE, 2.4); B.add(bb);
      // the sliding skylight (steps 41-49): a black 6x6 tile on red and dark gray rail plates, on the right
      const sky = new THREE.Group(); sky.position.set(3.2, roofY + PLATE, 0);
      sky.add(plate(10, 1, L.dbg, -0.4, 0, -2.0), plate(10, 1, L.dbg, -0.4, 0, 2.0), plate(1, 6, L.red, 1.2, PLATE, 0), tile(6, 6, L.black, -0.8, PLATE, 0));
      B.add(sky);
      // the lime green 6x8 garden plate with lime slope tiles (steps 52-53): the canopy that rises
      const canopy = new THREE.Group(); canopy.position.set(2.4, roofY + 2 * PLATE + 0.1, -2.4);
      canopy.add(plate(8, 3, L.lime, 0, 0, 0));
      for (const z of [-0.8, 0, 0.8]) canopy.add(slope(1, 2, L.lime, -2.8, PLATE, z, Math.PI));
      for (const [x, m] of [[-0.8, L.yellow], [0.8, L.green], [2.0, L.yellow]]) canopy.add(round(0.5, 1, m, x, PLATE, 0, true));
      B.add(canopy);
      // the hinged hatch (steps 64-71): a black 4x10 plate on light gray hinge plates at the left, with a
      // light gray 3x5 L-shaped liftarm and a red ball handle at its free end, and a blue bird on it
      const hatch = new THREE.Group(); hatch.position.set(-4.8, roofY + PLATE, 0);
      const hp = new THREE.Group(); hp.position.x = 4.0;
      hp.add(plate(10, 4, L.black, 0, 0.1, 0, { ry: Math.PI / 2 }), plate(2, 4, L.lbg, -3.4, -PLATE + 0.1, 0));
      hp.add(beamAB(L.lbg, [0.4, 0.4, 2.1], [3.6, 0.4, 2.1], Z));
      const hb = new THREE.Mesh(cached('ball', () => new THREE.SphereGeometry(0.5, 16, 12)), L.red); hb.position.set(0.4, 0.4, 3.4); hp.add(hb, rod([0.4, 0.4, 2.1], [0.4, 0.4, 3.0], 0.2, L.red));
      hp.position.x = 1.6; hatch.add(hp);
      B.add(hatch);
      return {
        group: g,
        update(st) {
          ease(canopy, 'position.y', roofY + 2 * PLATE + 0.1 + padMax(st, 'canopy') * 2.7);
          ease(sky, 'position.x', 3.2 - padMax(st, 'skylight') * 2.4);
        },
      };
    },
  };

  // ---- SPIKE Prime driving base -----------------------------------------------------
  // Built facing -z (heading 0), origin at the centre of the wheel axle.
  // SPIKE Prime Advanced Driving Base (Competition Ready building instructions): medium motors inside
  // the 88 mm wheels, black 7x11 frames holding the wheels from the outside, black 5x7 frames
  // underneath, the azure 11x15 front frame with a medium motor and 24-tooth gear for attachments,
  // magenta 5x7 frames as front and back bumpers, and a medium motor at the back. Local -z is forward.
  function adbChassis() {
    const g = new THREE.Group(), wr = ROBOT.wheel.diameter / 2, tx = ROBOT.wheelBase / 2, Ln = ROBOT.length;
    const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
    const motor = (w, h, len, x, y, z, face) => { // white and azure SPIKE motor, output on the `face` side
      const m = new THREE.Group();
      const a = new THREE.Mesh(boxGeo(w, h, len / 2), L.white); a.position.z = -len / 4; m.add(a);
      const b = new THREE.Mesh(boxGeo(w, h, len / 2), L.medAzure); b.position.z = len / 4; m.add(b);
      const out = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.2, 20), L.medAzure);
      if (face) { out.rotation.z = Math.PI / 2; out.position.set(face * (w / 2 + 0.1), 0, -len / 4); } else out.position.set(0, h / 2 + 0.1, -len / 4);
      m.add(out); m.position.set(x, y, z);
      return shadowy(m);
    };
    for (const s of [-1, 1]) {
      const big = PHYS.stallTorque > 0.2e4; // medium motors as built, or large ones if chosen
      g.add(motor(big ? 2.8 : 2.4, big ? 4 : 3.2, big ? 6.4 : 4.8, s * (tx - ROBOT.wheel.width / 2 - (big ? 1.6 : 1.4)), wr, 0, s)); // drive motors (A, E)
      g.add(frameAt(11, 7, L.black, [s * (tx + ROBOT.wheel.width / 2 + 0.6), 0.8, -4.0], Z, Y)); // outside wheel supports
      g.add(beamAB(L.black, [s * (tx - 0.2), wr, 0], [s * (tx + ROBOT.wheel.width / 2 + 0.6), wr, 0], Z)); // axle support
      g.add(brick(2, 4, 3, L.yellow, s * 4.4, 1.2, -Ln / 2 + 1.6)); // front corner bricks
    }
    g.add(frameAt(5, 7, L.black, [-1.6, 1.0, -4.8], X, Z), frameAt(5, 7, L.black, [-1.6, 1.0, 0.8], X, Z)); // underneath
    g.add(frameAt(11, 7, L.medAzure, [-4.0, 2.0, -Ln / 2 + 0.4], X, Z)); // front frame
    g.add(frameAt(7, 5, L.magenta, [-2.4, 1.2, -Ln / 2 + 0.4], X, Y), frameAt(7, 5, L.magenta, [-2.4, 1.6, Ln / 2 - 0.4], X, Y)); // bumpers
    g.add(frameAt(7, 5, L.magenta, [-2.4, 6.0, -Ln / 2 + 1.2], X, Z), frameAt(7, 5, L.magenta, [-2.4, 7.2, Ln / 2 - 3.6], X, Z)); // top frames
    g.add(motor(2.4, 3.2, 4.0, 0, 4.0, -Ln / 2 + 3.6, 0), motor(2.4, 3.2, 4.0, 0, 4.4, Ln / 2 - 2.8, 0)); // attachment motors (C front, D back)
    const g24 = gear(24, L.lbg); g24.rotation.x = Math.PI / 2; g24.position.set(0, 6.0, -Ln / 2 + 2.6); g.add(g24);
    for (const s of [-1, 1]) g.add(rod([s * 2.4, 0.4, -Ln / 2 + 2.0], [s * 2.4, 1.6, -Ln / 2 + 2.0], 0.5, L.lbg)); // front skids
    return g;
  }

  function buildRobot() {
    const robot = new THREE.Group();
    const tyreMat = new THREE.MeshPhysicalMaterial({
      color: '#151515', roughness: 0.82, envMapIntensity: 0.6,
      normalMap: normalMap(128, (x, y) => (Math.floor(x / 8) % 2 ? 1.5 : 0) + valueNoise(x / 4, y / 4, 32) * 0.4), normalScale: new THREE.Vector2(0.8, 0.8),
    });
    // sized from the robot that is built (Robot tab)
    const Ln = ROBOT.length, W = ROBOT.width, wr = ROBOT.wheel.diameter / 2, track = ROBOT.wheelBase;
    const large = PHYS.stallTorque > 0.2e4;
    const frame = L.teal;
    const holes = (cm) => Math.max(3, Math.round(cm / 0.8));
    const adb = ROBOT.model === 'adb'; // the SPIKE Prime Advanced Driving Base has its own chassis below
    if (adb) robot.add(adbChassis());
    else { // chassis: Technic beams and frames
      for (const s of [-1, 1]) robot.add(beam(holes(Ln) - 1, L.lbg, s * (W / 2 - 3.8), 1.6, 0, { ry: Math.PI / 2 }));
      robot.add(beam(holes(W - 2.4), L.lbg, 0, 1.6, Ln / 2 - 1.4), beam(holes(W - 2.4), L.lbg, 0, 1.6, -Ln / 2 + 2.4));
      for (const s of [-1, 1]) robot.add(tile(holes(W / 2 - 0.6), holes(Ln * 0.6), frame, s * (W / 4), 2.4, 0.4, { studs: false }));
    }
    // drive motors with wheels (motor face points outward)
    for (const s of [-1, 1]) {
      const motor = new THREE.Group();
      motor.add(shadowy(new THREE.Mesh(large ? new THREE.BoxGeometry(2.8, 4, 6.4) : new THREE.BoxGeometry(2.4, 3.2, 4.8), L.white)));
      const face = new THREE.Mesh(new THREE.CylinderGeometry(1.25, 1.25, 0.3, 24), L.dbg);
      face.rotation.z = Math.PI / 2; face.position.x = s * 1.25; motor.add(face);
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.4, 12), L.azure);
      pin.rotation.z = Math.PI / 2; pin.position.x = s * 1.45; motor.add(pin);
      motor.position.set(s * Math.max(1.6, track / 2 - 2), Math.max(wr, 2), 0);
      if (!adb) robot.add(motor);
      const wheel = new THREE.Group();
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, ROBOT.wheel.width, 48), adb ? L.wheelAzure : tyreMat);
      tyre.rotation.z = Math.PI / 2; wheel.add(tyre);
      for (let k = 0; k < 2; k++) {
        const tread = new THREE.Mesh(new THREE.TorusGeometry(wr - 0.05, 0.12, 6, 32), L.rubber);
        tread.rotation.y = Math.PI / 2; tread.position.x = (k - 0.5) * 0.9; wheel.add(tread);
      }
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(wr * 0.68, wr * 0.68, ROBOT.wheel.width + 0.06, 24), adb ? L.black : L.lbg);
      rim.rotation.z = Math.PI / 2; wheel.add(rim);
      for (let k = 0; k < 6; k++) {
        const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.2, wr * 1.1, 0.35), adb ? L.dbg : L.white);
        spoke.position.x = s * 0.75; spoke.rotation.x = (k / 6) * Math.PI; wheel.add(spoke);
      }
      const hubcap = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, ROBOT.wheel.width + 0.2, 12), L.azure);
      hubcap.rotation.z = Math.PI / 2; wheel.add(hubcap);
      wheel.position.set(s * track / 2, wr, 0);
      robot.add(shadowy(wheel));
      robot.userData['wheel' + (s < 0 ? 'L' : 'R')] = wheel;
    }
    // ball caster at the back
    if (!adb) {
      const casterHousing = brick(2, 2, 3, L.dbg, 0, 0.9, Ln / 2 - 2);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), L.steel);
      ball.position.set(0, 0.9, Ln / 2 - 2);
      robot.add(casterHousing, shadowy(ball));
    }

    // SPIKE Prime hub (88 x 56 x 32 mm) lying on top, lengthwise
    const hub = new THREE.Group();
    const hubBody = new THREE.Mesh(new THREE.BoxGeometry(5.6, 3.2, 8.8), L.white);
    hub.add(hubBody);
    const hubTop = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.12, 8.2), plastic('#e8ecef'));
    hubTop.position.y = 1.62; hub.add(hubTop);
    for (const s of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.2, 8.0), L.yellow);
      side.position.set(s * 2.82, -0.2, 0); hub.add(side);
      for (let k = 0; k < 3; k++) {
        const portSock = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.9, 1.4), L.dbg);
        portSock.position.set(s * 2.86, -0.4, -2.4 + k * 2.4); hub.add(portSock);
      }
    }
    // 5x5 light matrix as a live texture
    const mCanvas = document.createElement('canvas');
    mCanvas.width = mCanvas.height = 64;
    const mTex = new THREE.CanvasTexture(mCanvas);
    mTex.magFilter = THREE.NearestFilter;
    mTex.encoding = THREE.sRGBEncoding;
    const matrix = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshStandardMaterial({ map: mTex, emissiveMap: mTex, emissive: '#ffffff', emissiveIntensity: 2.2, roughness: 0.3 }));
    matrix.rotation.x = -Math.PI / 2; matrix.rotation.z = Math.PI / 2; matrix.position.set(0, 1.7, -1.2); hub.add(matrix);
    const centerBtn = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.25, 24), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 1.8, roughness: 0.3 }));
    centerBtn.position.set(0, 1.72, 2.6); hub.add(centerBtn);
    for (const s of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.6), L.lbg);
      b.position.set(s * 1.5, 1.72, 2.6); hub.add(b);
    }
    const speaker = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 0.8), L.dbg);
    speaker.position.set(0, 1.68, 3.7); hub.add(speaker);
    hub.position.set(0, 6.4, 1.2);
    if (adb) { hub.position.set(0, ROBOT.height - 1.6, 0.4); hub.rotation.y = Math.PI / 2; } // across the robot, on top
    robot.add(shadowy(hub));
    if (!adb) robot.add(post(3, frame, -2.4, 3.2, -2.2), post(3, frame, 2.4, 3.2, -2.2), post(3, frame, -2.4, 3.2, 4.4), post(3, frame, 2.4, 3.2, 4.4));

    // color sensor(s) looking down, with their light spots
    const csMat = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.8 });
    const spotMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false });
    const spots = [], sensorGroups = [];
    let csFace = null;
    for (const side of ROBOT.color2 ? [ROBOT.sensorSide, ROBOT.sensorSide2] : [ROBOT.sensorSide]) {
      const cs = new THREE.Group();
      cs.add(shadowy(new THREE.Mesh(new THREE.BoxGeometry(2.4, 2, 2.4), adb ? L.white : L.black)));
      if (adb) { const face = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 1.8), L.black); face.position.y = -1.0; cs.add(face); }
      const f = new THREE.Mesh(new THREE.CylinderGeometry(adb ? 0.5 : 0.8, adb ? 0.5 : 0.8, 0.1, 20), csMat);
      f.position.y = -1.06; cs.add(f);
      csFace = csFace || f;
      cs.position.set(side, adb ? 1.5 : 1.9, -ROBOT.sensorOffset);
      robot.add(cs); sensorGroups.push(cs);
      const spot = new THREE.Mesh(new THREE.CircleGeometry(ROBOT.sensorSpot, 16), spotMat);
      spot.rotation.x = -Math.PI / 2; spot.position.set(side, 0.1, -ROBOT.sensorOffset);
      robot.add(spot); spots.push(spot);
    }

    // distance sensor (port F) on the front: black body, two eyes, four light segments
    const ds = new THREE.Group();
    ds.add(shadowy(new THREE.Mesh(new THREE.BoxGeometry(5.6, 2.4, 1.6), L.black)));
    const eyeLights = [];
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.4, 20), L.white);
      eye.rotation.x = Math.PI / 2; eye.position.set(s * 1.3, 0, -0.9); ds.add(eye);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.42, 16), L.black);
      lens.rotation.x = Math.PI / 2; lens.position.set(s * 1.3, 0, -0.92); ds.add(lens);
      for (const t of [-1, 1]) {
        const seg = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 0.1), new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0 }));
        seg.position.set(s * 1.3, t * 1.0, -0.82); ds.add(seg); eyeLights.push(seg);
      }
    }
    ds.position.set(0, 5, -Ln / 2 + 0.4);
    if (ROBOT.distanceSensor) robot.add(ds);

    // attachment on motor C: basket (two arms and a gate), hook arm, or flat pusher
    const reach = ROBOT.basket, att = new THREE.Group();
    robot.add(att);
    if (ROBOT.attachment === 'basket') {
      for (const s of [-1, 1]) {
        att.add(beam(holes(reach) + 1, L.azure, s * (W / 2 - 0.4), 0.8, -Ln / 2 - reach / 2, { ry: Math.PI / 2 }));
        att.add(beam(holes(reach) + 1, L.azure, s * (W / 2 - 0.4), 2.4, -Ln / 2 - reach / 2, { ry: Math.PI / 2 }));
      }
    } else if (ROBOT.attachment === 'hook') {
      att.add(beam(holes(reach) + 1, L.azure, 0, 1.6, -Ln / 2 - reach / 2, { ry: Math.PI / 2 }));
    } else if (ROBOT.attachment === 'pusher') {
      att.add(beam(holes(W), L.azure, 0, 0.8, -Ln / 2 - reach + 0.4), beam(holes(W), L.azure, 0, 2.4, -Ln / 2 - reach + 0.4));
      for (const s of [-1, 1]) att.add(beam(3, L.azure, s * (W / 2 - 1.2), 1.6, -Ln / 2 - reach / 2, { ry: Math.PI / 2 }));
    }
    const motorC = new THREE.Group();
    motorC.add(shadowy(new THREE.Mesh(new THREE.BoxGeometry(4.8, 2.4, 2.4), L.white)));
    const cFace = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.3, 20), L.dbg); cFace.rotation.z = Math.PI / 2; cFace.position.x = 2.45; motorC.add(cFace);
    motorC.position.set(-2.8, 8.2, -Ln / 2 + 2);
    if (!adb) robot.add(motorC);
    const gate = new THREE.Group();
    gate.position.set(0, 3.6, -Ln / 2 - reach);
    if (ROBOT.attachment === 'basket') gate.add(beam(holes(W) - 1, L.azure, 0, -1.6, 0), beam(holes(W) - 1, L.azure, 0, -0.2, 0));
    else if (ROBOT.attachment === 'hook') { // a hook that swings down on motor C
      gate.add(beam(3, L.azure, 0, -1.2, 0, { rz: Math.PI / 2 }));
      const tip = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.18, 6, 12, Math.PI), L.yellow); tip.position.set(0, -2.6, -0.5); tip.rotation.y = Math.PI / 2; gate.add(tip);
    }
    robot.add(gate);
    // the lift arm and photo attachments swing on their motor's axle (ROBOT.swing)
    const sw = ROBOT.swing, swingG = new THREE.Group();
    if (sw && sw.shape) {
      const mount = new THREE.Group();
      mount.position.set(0, sw.spot.z, -sw.spot.u);
      if (sw.spot.back) mount.rotation.y = Math.PI;
      mount.add(swingG); att.add(mount);
      if (ROBOT.attachment === 'lifter') {
        const len = reach + 1.5, drop = Math.asin((6.4 - 0.6) / len);
        for (const v of [-2.4, 2.4]) swingG.add(beamAB(L.azure, [v, 0, 0], [v, -len * Math.sin(drop), -len * Math.cos(drop)], [1, 0, 0]));
        swingG.add(rod([-3.2, 0, 0], [3.2, 0, 0], 0.24, L.black)); // the axle across
      } else if (ATTACHMENTS[ROBOT.attachment].custom) swingG.add(voxelMesh(ATTACHMENTS[ROBOT.attachment].custom));
    }

    // cables
    if (!adb) {
      for (const s of [-1, 1]) robot.add(tube([[s * 3.6, 4.4, 1.5], [s * 4.4, 6.5, 2.5], [s * 2.9, 6.4, 3.4]], 0.18, L.black));
      robot.add(tube([[-2.8, 8.2, -Ln / 2 + 3.2], [-2.6, 7.6, -1.5], [-2.9, 6.4, -1.4]], 0.18, L.black));
      robot.add(tube([[0, 2.9, -ROBOT.sensorOffset], [1.6, 4, -6], [2.9, 6.4, -1.4]], 0.18, L.black));
    }

    robot.traverse((m) => { if (m.isMesh && !spots.includes(m)) m.castShadow = true; });
    // motor C (and D) turn the gate, hook or swinging attachment
    const pose = (r) => {
      gate.rotation.x = -rad(Math.max(0, 90 - r.armPos));
      if (sw && sw.shape) swingG.rotation.x = rad(sw.angle(sw.job === 'spare' ? r.sparePos : sw.job ? r.armPos : 0));
    };
    return { robot, mCanvas, mTex, centerBtn, eyeLights, gate, pose, wheels: [robot.userData.wheelL, robot.userData.wheelR], csFace, sensorGroups, ds, hub, att, spots, matrix };
  }

  // An attachment made from photos, as cubes coloured from the photos: the tops from the photo from
  // above, the rest from the side photo. Robot coordinates (u forward, v right, z up) about its axle
  // map to x = v, y = z, z = -u.
  function voxelMesh(def) {
    const vox = attachmentVoxels(def), c = def.cell, side = def.side, top = def.top;
    const filled = new Set(vox.cells.map(([i, j, k]) => i + ',' + j + ',' + k));
    const has = (i, j, k) => filled.has(i + ',' + j + ',' + k);
    const colour = (m, a, b) => {
      const hex = m.rgb && m.rgb.substr((b * m.w + a) * 6, 6);
      return new THREE.Color(hex && hex.length === 6 ? '#' + hex : '#078bc9').convertSRGBToLinear();
    };
    const pos = [], col = [], nrm = [];
    // each face: neighbour step, normal (three axes), and the four corners as (x, y, z) offsets of the half cell
    const faces = [
      [[0, 0, -1], [0, 1, 0], [[-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]], // up (k is down the side grid)
      [[0, 0, 1], [0, -1, 0], [[-1, -1, 1], [1, -1, 1], [1, -1, -1], [-1, -1, -1]]], // down
      [[0, 1, 0], [1, 0, 0], [[1, -1, -1], [1, -1, 1], [1, 1, 1], [1, 1, -1]]], // right (+v)
      [[0, -1, 0], [-1, 0, 0], [[-1, -1, 1], [-1, -1, -1], [-1, 1, -1], [-1, 1, 1]]], // left
      [[1, 0, 0], [0, 0, -1], [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1]]], // far end (+u)
      [[-1, 0, 0], [0, 0, 1], [[1, -1, 1], [-1, -1, 1], [-1, 1, 1], [1, 1, 1]]], // near end
    ];
    for (const cellIJK of vox.cells) {
      const [i, j, k] = cellIJK, [u, v, z] = vox.at(cellIJK);
      for (const [[di, dj, dk], n, corners] of faces) {
        if (has(i + di, j + dj, k + dk)) continue;
        const shade = n[1] > 0 ? 1 : n[1] < 0 ? 0.55 : n[2] !== 0 ? 0.8 : 0.92;
        const cc = (n[1] > 0 ? colour(top, i, j) : colour(side, i, k)).multiplyScalar(shade);
        const q = corners.map(([a, b, d]) => [v + (a * c) / 2, z + (b * c) / 2, -u + (d * c) / 2]);
        // wind the two triangles anticlockwise as seen from outside
        const e1 = [0, 1, 2].map((x) => q[1][x] - q[0][x]), e2 = [0, 1, 2].map((x) => q[2][x] - q[0][x]);
        const out = (e1[1] * e2[2] - e1[2] * e2[1]) * n[0] + (e1[2] * e2[0] - e1[0] * e2[2]) * n[1] + (e1[0] * e2[1] - e1[1] * e2[0]) * n[2] > 0;
        for (const t of out ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) { pos.push(...q[t]); col.push(cc.r, cc.g, cc.b); nrm.push(...n); }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0 }));
    return shadowy(mesh);
  }

  // Procedural normal map from a height function, for paint, vinyl, tread and wood texture.
  function normalMap(size, height, repeat) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d'), img = g.createImageData(size, size);
    const hgt = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) hgt[y * size + x] = height(x, y);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = hgt[y * size + ((x + 1) % size)] - hgt[y * size + ((x + size - 1) % size)];
      const dy = hgt[((y + 1) % size) * size + x] - hgt[((y + size - 1) % size) * size + x];
      const n = Math.hypot(dx, dy, 1), k = (y * size + x) * 4;
      img.data[k] = (-dx / n * 0.5 + 0.5) * 255; img.data[k + 1] = (-dy / n * 0.5 + 0.5) * 255; img.data[k + 2] = (1 / n * 0.5 + 0.5) * 255; img.data[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat || 1, repeat || 1);
    return t;
  }
  const hash = (x, y) => { const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return v - Math.floor(v); };
  // Value noise that wraps every `period` lattice cells, so textures built from it tile without seams
  // (a seam at every tile edge shows up as stripes across a large surface).
  const valueNoise = (x, y, period) => {
    const p = period || 1e9, w = (i) => ((i % p) + p) % p;
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(w(xi), w(yi)), b = hash(w(xi + 1), w(yi)), c = hash(w(xi), w(yi + 1)), d = hash(w(xi + 1), w(yi + 1));
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };

  // Procedural wood grain for the table walls' top edges.
  function woodTexture() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#b48a5e'; g.fillRect(0, 0, 512, 64);
    for (let i = 0; i < 70; i++) {
      g.strokeStyle = 'rgba(90,55,25,' + (0.08 + Math.random() * 0.18) + ')';
      g.lineWidth = 1 + Math.random() * 2;
      const y = Math.random() * 64;
      g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= 512; x += 32) g.lineTo(x, y + Math.sin(x / 60 + i) * 3);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  const SPIKE_COLOURS = { white: '#ffffff', red: '#ff3b3b', orange: '#ff9a2e', yellow: '#ffe14d', green: '#3ddc5a', azure: '#5ad1ff', blue: '#2f6dff', violet: '#9a6bff', magenta: '#ff4fd8', off: '#222222' };
  const SENSOR_COLOURS = { black: '#202020', white: '#ffffff', red: '#ff3030', yellow: '#ffe040', green: '#40d060', blue: '#3060ff', azure: '#50c8ff', violet: '#9060ff', magenta: '#ff40d0' };

  // ---- the room: a school gym, as at a tournament ---------------------------------------
  // Painted block walls, bleachers, basketball hoops, a high ceiling with light panels, and two more
  // practice tables. None of it casts shadows; it is there so the field doesn't float in a void.
  const FLOOR_Y = -72;
  function canvasTex(w, h, paint, repeatX, repeatY) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeatX || 1, repeatY || 1);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    return t;
  }
  function buildGym(scene, cx, cz, matTex) {
    const room = new THREE.Group();
    const RX = 1200, RZ = 900, RH = 900; // half width, half depth, height (cm): about 24 x 18 x 9 m
    // painted concrete block: 40 x 20 cm blocks, 160 cm per texture tile
    const blockTex = (repeatX, repeatY) => canvasTex(512, 512, (g, w, h) => {
      g.fillStyle = '#a49e92'; g.fillRect(0, 0, w, h);
      for (let r = 0; r < 8; r++) for (let k = 0; k < 5; k++) {
        const x = k * 128 - (r % 2) * 64, v = 196 + Math.floor(hash(r, k) * 14);
        g.fillStyle = 'rgb(' + v + ',' + (v - 5) + ',' + (v - 16) + ')';
        g.fillRect(x + 3, r * 64 + 3, 122, 58);
        if (x < 0) g.fillRect(x + 3 + w, r * 64 + 3, 122, 58);
      }
    }, repeatX, repeatY);
    const wallMat = (len) => new THREE.MeshStandardMaterial({ map: blockTex(len / 160, RH / 160), roughness: 0.92 });
    const wall = (len, x, z, ry) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(len, RH), wallMat(len));
      m.position.set(x, FLOOR_Y + RH / 2, z); m.rotation.y = ry; room.add(m);
      const band = new THREE.Mesh(new THREE.PlaneGeometry(len, 120), new THREE.MeshStandardMaterial({ color: '#1f4f8f', roughness: 0.6 }));
      band.position.set(x, FLOOR_Y + 60, z); band.rotation.y = ry; band.translateZ(0.5); room.add(band);
    };
    wall(RX * 2, cx, cz - RZ, 0);
    wall(RX * 2, cx, cz + RZ, Math.PI);
    wall(RZ * 2, cx - RX, cz, Math.PI / 2);
    wall(RZ * 2, cx + RX, cz, -Math.PI / 2);
    // ceiling, roof trusses and rows of light panels (bright enough to bloom in Realistic quality)
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RX * 2, RZ * 2), new THREE.MeshStandardMaterial({ color: '#3a3d42', roughness: 0.9 }));
    ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, FLOOR_Y + RH, cz); room.add(ceil);
    const truss = new THREE.MeshStandardMaterial({ color: '#2b2e33', roughness: 0.7, metalness: 0.4 });
    const lamp = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.35, 2.2) });
    const housing = new THREE.MeshStandardMaterial({ color: '#d8d8d8', roughness: 0.5 });
    for (let x = -RX + 200; x <= RX - 200; x += 400) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(20, 60, RZ * 2), truss);
      t.position.set(cx + x, FLOOR_Y + RH - 30, cz); room.add(t);
      for (let z = -RZ + 225; z <= RZ - 225; z += 450) {
        const hsg = new THREE.Mesh(new THREE.BoxGeometry(70, 14, 70), housing);
        hsg.position.set(cx + x, FLOOR_Y + RH - 160, cz + z); room.add(hsg);
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(62, 62), lamp);
        panel.rotation.x = Math.PI / 2; panel.position.set(cx + x, FLOOR_Y + RH - 167.5, cz + z); room.add(panel);
      }
    }
    // pull-out bleachers along the far wall
    const wood = new THREE.MeshStandardMaterial({ color: '#b98d57', roughness: 0.55 });
    const riser = new THREE.MeshStandardMaterial({ color: '#2a2c30', roughness: 0.8 });
    for (let i = 0; i < 7; i++) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(RX * 1.4, 6, 30), wood);
      seat.position.set(cx, FLOOR_Y + 40 * (i + 1), cz - RZ + 30 + (6 - i) * 60 + 15); room.add(seat);
      const front = new THREE.Mesh(new THREE.BoxGeometry(RX * 1.4, 40 * (i + 1), 60), riser);
      front.position.set(cx, FLOOR_Y + 20 * (i + 1), cz - RZ + 30 + (6 - i) * 60); room.add(front);
    }
    // basketball hoops at both ends
    for (const s of [-1, 1]) {
      const x = cx + s * (RX - 120);
      const board = new THREE.Mesh(new THREE.BoxGeometry(3, 105, 180), new THREE.MeshStandardMaterial({ color: '#f4f4f4', roughness: 0.3 }));
      board.position.set(x, FLOOR_Y + 340, cz); room.add(board);
      const square = new THREE.Mesh(new THREE.PlaneGeometry(59, 45), new THREE.MeshBasicMaterial({ color: '#c0392b' }));
      square.position.set(x - s * 1.6, FLOOR_Y + 330, cz); square.rotation.y = -s * Math.PI / 2; room.add(square);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(23, 1, 8, 32), new THREE.MeshStandardMaterial({ color: '#e8641b', roughness: 0.4, metalness: 0.3 }));
      ring.rotation.x = Math.PI / 2; ring.position.set(x - s * 27, FLOOR_Y + 305, cz); room.add(ring);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(110, 8, 8), truss);
      arm.position.set(x + s * 55, FLOOR_Y + 400, cz); room.add(arm);
    }
    // painted court lines on the floor
    const line = new THREE.MeshBasicMaterial({ color: '#f0ece0', transparent: true, opacity: 0.85 });
    for (const [w, d, x, z] of [[RX * 1.7, 5, 0, -RZ * 0.8], [RX * 1.7, 5, 0, RZ * 0.8], [5, RZ * 1.6, -RX * 0.85, 0], [5, RZ * 1.6, RX * 0.85, 0], [5, RZ * 1.6, 0, 0]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), line);
      m.rotation.x = -Math.PI / 2; m.position.set(cx + x, FLOOR_Y + 0.2, cz + z); room.add(m);
    }
    const circle = new THREE.Mesh(new THREE.RingGeometry(180, 185, 64), line);
    circle.rotation.x = -Math.PI / 2; circle.position.set(cx + RX * 0.0 + 0.1, FLOOR_Y + 0.2, cz + 0.1); room.add(circle);
    // two more practice tables, further down the gym
    const black = new THREE.MeshStandardMaterial({ color: '#141517', roughness: 0.5 });
    const steel = new THREE.MeshStandardMaterial({ color: '#8a9096', roughness: 0.4, metalness: 0.8 });
    const matTop = new THREE.MeshStandardMaterial({ map: matTex, roughness: 0.65 });
    for (const [x, z] of [[-420, 470], [420, 470]]) {
      const t = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(236, 2, 114), [black, black, matTop, black, black, black]);
      top.position.y = 0; t.add(top);
      for (const [w, d, ox, oz] of [[244, 4, 0, -59], [244, 4, 0, 59], [4, 114, -120, 0], [4, 114, 120, 0]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 8, d), black); m.position.set(ox, 4, oz); t.add(m);
      }
      for (const ox of [-100, 100]) for (const oz of [-45, 45]) { const l = new THREE.Mesh(new THREE.BoxGeometry(5, 70, 5), steel); l.position.set(ox, -36, oz); t.add(l); }
      t.position.set(cx + x, 0, cz + z);
      room.add(t);
    }
    scene.add(room);
    return room;
  }

  // three.js r128 treats hex colours as linear light, then brightens them again for the screen, which
  // washes every LEGO colour out (tan comes out white). Convert each material's colours from sRGB to
  // linear once, as textures already are, so the bricks show their real colours. Colours brighter than
  // 1 (the ceiling lights) are deliberate light levels and are left alone.
  const linearized = new WeakSet();
  function linearizeColours(root) {
    root.traverse((o) => {
      if (!o.material) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (linearized.has(m)) continue;
        linearized.add(m);
        for (const key of ['color', 'emissive']) {
          const c = m[key];
          if (c && c.r <= 1 && c.g <= 1 && c.b <= 1) c.convertSRGBToLinear();
        }
      }
    });
  }

  function create(container, sim, paintMatArt) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap; // with a blur radius: soft-edged shadows like room lighting
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.domElement.className = 'gl';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    // Soft studio backdrop and a room environment for reflections on plastic, paint and steel.
    const bg = document.createElement('canvas');
    bg.width = 4; bg.height = 256;
    const bgc = bg.getContext('2d'), grad = bgc.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#5d6670'); grad.addColorStop(0.55, '#2b3036'); grad.addColorStop(1, '#121417');
    bgc.fillStyle = grad; bgc.fillRect(0, 0, 4, 256);
    const bgTex = new THREE.CanvasTexture(bg); bgTex.encoding = THREE.sRGBEncoding;
    scene.background = bgTex; // only seen if the gym isn't built
    if (THREE.RoomEnvironment) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }

    const cx = FIELD.w / 2, cz = FIELD.h / 2;
    const camera = new THREE.PerspectiveCamera(38, 2, 5, 3200); // far enough to see across the gym
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.maxPolarAngle = rad(86);
    controls.minDistance = 15;
    controls.maxDistance = 650; // stays inside the gym

    // ---- lights: soft sky, a key light with shadows, and a cool fill -------------------
    scene.add(new THREE.HemisphereLight('#f4f8ff', '#3a3226', scene.environment ? 0.18 : 0.5));
    // gym ceiling lights: high and nearly overhead, slightly warm, so shadows fall softly under things
    const sun = new THREE.DirectionalLight('#fff1dc', 0.62);
    sun.position.set(cx - 70, 290, cz + 95);
    sun.target.position.set(cx, 0, cz);
    sun.castShadow = true;
    const maxTex = renderer.capabilities.maxTextureSize;
    sun.shadow.mapSize.set(Math.min(4096, maxTex), Math.min(4096, maxTex));
    Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 100, bottom: -100, near: 150, far: 450 });
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.06;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#cfe3ff', 0.12);
    fill.position.set(cx + 160, 120, cz - 140);
    scene.add(fill);

    // ---- table and mat -----------------------------------------------------
    const mr = MAT.rect;
    const texCanvas = document.createElement('canvas');
    texCanvas.width = Math.min(3200, maxTex); texCanvas.height = Math.round(texCanvas.width * 0.57);
    paintMatArt(texCanvas.getContext('2d'), texCanvas.width, texCanvas.height);
    // a used mat: faint tyre scuffs where robots launch and turn in the home areas
    {
      const g = texCanvas.getContext('2d'), kx = texCanvas.width / mr.w, ky = texCanvas.height / mr.h;
      let seed = 7; const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
      g.lineCap = 'round';
      for (const hx of [0.1, 0.9]) for (let i = 0; i < 26; i++) {
        const x = (hx + (rnd() - 0.5) * 0.12) * mr.w * kx, y = (0.72 + (rnd() - 0.5) * 0.45) * mr.h * ky, r = (4 + rnd() * 18) * kx, a = rnd() * 6.28;
        g.strokeStyle = 'rgba(40,40,40,' + (0.025 + rnd() * 0.05) + ')'; g.lineWidth = (0.8 + rnd() * 1.2) * kx;
        g.beginPath(); g.arc(x, y, r, a, a + 0.4 + rnd() * 1.4); g.stroke();
      }
    }
    const tex = new THREE.CanvasTexture(texCanvas);
    tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    // printed vinyl: matte with a faint sheen
    // printed vinyl: matte with a faint sheen. Mats ship rolled up, so they never lie perfectly flat:
    // long gentle waves across the width and a few soft bumps (shading only; the physics stays flat).
    const vinyl = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.62, clearcoat: 0.08, clearcoatRoughness: 0.5, envMapIntensity: 0.35,
      normalMap: normalMap(512, (x, y) => Math.sin((x / 512) * Math.PI * 2 * 5) * 3 + Math.sin((x / 512) * Math.PI * 2 * 2 + 1) * 4 + valueNoise(x / 64, y / 64, 8) * 5), normalScale: new THREE.Vector2(0.06, 0.06),
    });
    const edge = new THREE.MeshStandardMaterial({ color: '#e4e3dc', roughness: 0.7 });
    const matMesh = new THREE.Mesh(new THREE.BoxGeometry(mr.w, 0.12, mr.h), [edge, edge, vinyl, edge, edge, edge]);
    matMesh.position.set(mr.x + mr.w / 2, 0.06, mr.y + mr.h / 2);
    matMesh.receiveShadow = true;
    scene.add(matMesh);

    // FLL tables have black-painted walls and surface; the mat sits on the surface, home areas are bare.
    // satin black paint with a slight orange-peel texture; sanded wood on the wall tops
    const paint = new THREE.MeshPhysicalMaterial({
      color: '#141517', roughness: 0.48, clearcoat: 0.25, clearcoatRoughness: 0.35, envMapIntensity: 0.7,
      normalMap: normalMap(128, (x, y) => valueNoise(x / 4, y / 4, 32)), normalScale: new THREE.Vector2(0.15, 0.15),
    });
    paint.normalMap.repeat.set(8, 8);
    const grain = woodTexture();
    const woodEdge = new THREE.MeshPhysicalMaterial({
      map: grain, roughness: 0.62, envMapIntensity: 0.5,
      normalMap: normalMap(256, (x, y) => Math.sin((y / 256) * Math.PI * 2 * 18 + valueNoise(x / 32, y / 8, 8) * 4) * 0.6), normalScale: new THREE.Vector2(0.35, 0.35),
    });
    const tableW = FIELD.w + WALL.t * 2, tableD = FIELD.h + WALL.t * 2;
    const add = (m) => { m.castShadow = m.receiveShadow = true; scene.add(m); return m; };
    // Bare table surface only in the two home areas. Nothing sits just under the mat: a surface 1.2 mm
    // below it fights it for depth (z-fighting) and shows through as stripes at some camera angles.
    for (const [x0, x1] of [[-WALL.t, mr.x], [mr.x + mr.w, FIELD.w + WALL.t]]) {
      const top = add(new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, 1.9, tableD), paint));
      top.position.set((x0 + x1) / 2, -0.95, cz);
      top.castShadow = false;
    }
    add(new THREE.Mesh(new THREE.BoxGeometry(mr.w, 1.9, WALL.t), paint)).position.set(mr.x + mr.w / 2, -0.95, -WALL.t / 2);
    add(new THREE.Mesh(new THREE.BoxGeometry(mr.w, 1.9, WALL.t), paint)).position.set(mr.x + mr.w / 2, -0.95, FIELD.h + WALL.t / 2);
    const under = add(new THREE.Mesh(new THREE.BoxGeometry(mr.w, 1.9, mr.h), paint)); // well below the mat
    under.position.set(mr.x + mr.w / 2, -3, mr.y + mr.h / 2);
    under.castShadow = false;
    const wall = (w, d, x, z) => {
      const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, WALL.h, d), [paint, paint, woodEdge, paint, paint, paint]));
      m.position.set(x, WALL.h / 2, z);
      return m;
    };
    wall(tableW, WALL.t, cx, -WALL.t / 2);
    wall(tableW, WALL.t, cx, FIELD.h + WALL.t / 2);
    wall(WALL.t, FIELD.h, -WALL.t / 2, cz);
    wall(WALL.t, FIELD.h, FIELD.w + WALL.t / 2, cz);
    // home-area tape lines at the mat edges
    for (const x of [mr.x, mr.x + mr.w]) {
      const tape = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, FIELD.h), plastic('#f2f2f2')));
      tape.position.set(x, 0.1, cz);
      tape.castShadow = false;
    }
    // apron, sawhorse legs and floor
    const steel = new THREE.MeshStandardMaterial({ color: '#8a9096', roughness: 0.38, metalness: 0.85, envMapIntensity: 1.0 });
    add(new THREE.Mesh(new THREE.BoxGeometry(tableW - 4, 8, tableD - 4), paint)).position.set(cx, -6, cz);
    for (const x of [20, FIELD.w - 20]) {
      for (const z of [8, FIELD.h - 8]) add(new THREE.Mesh(new THREE.BoxGeometry(5, 62, 5), steel)).position.set(x, -41, z);
      add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, FIELD.h - 16), steel)).position.set(x, -60, cz);
    }
    // varnished maple gym floor
    const floorTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const g = c.getContext('2d');
      for (let i = 0; i < 16; i++) {
        for (let j = 0; j < 4; j++) {
          const off = (i % 2) * 64, v = 150 + Math.floor(hash(i, j) * 40);
          g.fillStyle = 'rgb(' + v + ',' + Math.floor(v * 0.72) + ',' + Math.floor(v * 0.45) + ')';
          g.fillRect(i * 32, j * 128 + off - 64, 31, 127);
        }
        for (let k = 0; k < 40; k++) {
          g.strokeStyle = 'rgba(80,45,15,' + (0.05 + hash(i, k) * 0.1) + ')';
          g.beginPath(); const x = i * 32 + hash(k, i) * 31; g.moveTo(x, 0); g.lineTo(x + Math.sin(k) * 3, 512); g.stroke();
        }
      }
      const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(12, 12); t.encoding = THREE.sRGBEncoding; t.anisotropy = 8; return t;
    })();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(3000, 3000), new THREE.MeshPhysicalMaterial({ map: floorTex, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.8 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -72;
    floor.receiveShadow = true;
    scene.add(floor);
    buildGym(scene, cx, cz, tex);
    scene.fog = new THREE.Fog('#4a4d52', 1500, 3400); // a little haze across the hall

    // ---- mission models ----------------------------------------------------
    for (const shape of Object.values(MAT.docks)) {
      const f = footprint(shape);
      const dock = new THREE.Group();
      // books 11-13 end with the same dock: a dark gray 11x15 hollow frame lying flat, with black 5x7 hollow
      // frames standing at its two ends
      const long = f.d > f.w, A = long ? [0, 0, 1] : [1, 0, 0], Bv = long ? [1, 0, 0] : [0, 0, 1];
      const o = long ? [-4.0, 0.36, -5.6] : [-5.6, 0.36, -4.0];
      dock.add(frameAt(15, 11, L.dbg, o, A, Bv));
      for (const s2 of [-1, 1]) {
        const e = long ? [-2.4, 0.72, s2 * 6.3] : [s2 * 6.3, 0.72, -2.4];
        dock.add(frameAt(7, 5, L.black, e, long ? [1, 0, 0] : [0, 0, 1], [0, 1, 0]));
      }
      dock.position.set(f.cx, 0.12, f.cy);
      dock.rotation.y = -f.ang;
      scene.add(dock);
    }

    // Soft contact shadows: the dark, blurred patch where an object meets the mat (ambient occlusion).
    const aoTex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
      gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
      return new THREE.CanvasTexture(c);
    })();
    const aoMat = new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const contactShadow = (w, d) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), aoMat);
      m.rotation.x = -Math.PI / 2; m.position.y = 0.08; m.renderOrder = 1;
      return m;
    };

    let models = [];
    let dockKey = '';
    function buildModels() {
      for (const m of models) scene.remove(m.group);
      models = sim.solids.map((s) => {
        const f = footprint(s.shape);
        const b = BUILD[s.id](f);
        b.group.add(contactShadow(f.w * 1.5 + 2, f.d * 1.5 + 2));
        b.group.position.set(f.cx, s.dock ? 0.12 + 2 * PLATE : 0.12, f.cy);
        b.group.rotation.y = -f.ang;
        shadowy(b.group);
        scene.add(b.group);
        return { id: s.id, f, ...b };
      });
      dockKey = JSON.stringify(sim.docks);
    }
    buildModels();

    // The parts the robot works that aren't drawn by their model: red ball handles on red axles where a
    // part is pushed in, red T-bars where one is pulled out, and the compost hatch's flap. Lift handles,
    // the ant and the root cover are drawn (and moved) by their own models.
    let pads = [], padSource = null;
    const ballGeo = () => cached('ball', () => new THREE.SphereGeometry(0.5, 16, 12));
    function padPart(pl) {
      const g = new THREE.Group(), pd = pl.pad, look = pd.look;
      if (pl.lift || look === 'ant' || look === 'model') return g;
      if (pl.pull) { // a red axle across with a ball at each end, on a stem back into the model
        const bar = new THREE.Group();
        bar.add(rod([0, 0, -pl.w / 2], [0, 0, pl.w / 2], 0.24, L.red), rod([look === 'flap' ? -0.8 : -(pd.out + pl.travel), 0, 0], [0, 0, 0], 0.24, L.red));
        for (const e of [-1, 1]) { const b = new THREE.Mesh(ballGeo(), L.red); b.position.set(0, 0, e * (pl.w / 2 + 0.3)); bar.add(b); }
        bar.position.y = pd.zb;
        if (look === 'flap') { // a dark flap hinged at the bottom of the wall, the bar near its top
          const flap = new THREE.Group();
          const panel = new THREE.Mesh(boxGeo(0.32, 3.2, pl.w + 0.8), L.dbg); panel.position.set(0.16, 1.6, 0);
          flap.add(panel);
          flap.position.set(0.6, 0.35, 0); // the hinge, just proud of the wall
          bar.position.set(pd.out - 0.6, pd.zb - 0.35, 0);
          flap.add(bar);
          g.add(flap);
          g.userData.flap = flap;
        } else g.add(bar);
        scene.add(shadowy(g));
        return g;
      }
      // pushed: a red axle out of the model with a red ball on the end, and a red liftarm across a wide part
      const len = pl.out + 0.6;
      g.add(rod([-len, pd.zb || 1.2, 0], [0, pd.zb || 1.2, 0], 0.24, L.red));
      const b = new THREE.Mesh(ballGeo(), L.red); b.position.set(0.1, pd.zb || 1.2, 0); g.add(b);
      if (pl.w >= 2) g.add(beam(Math.max(2, Math.round(pl.w / U)), L.red, -0.2, pd.zb || 1.2, 0, { ry: Math.PI / 2 }));
      scene.add(shadowy(g));
      return g;
    }
    function syncPads() {
      if (sim.plates !== padSource) {
        for (const p of pads) scene.remove(p);
        pads = sim.plates.map(padPart);
        padSource = sim.plates;
      }
      sim.plates.forEach((pl, i) => {
        const g = pads[i];
        if (g.userData.flap) { // turns about its hinge on the wall, down onto the mat when it's fully open
          g.position.set(pl.face[0], 0.12, pl.face[1]);
          g.rotation.y = -pl.ang;
          g.userData.flap.rotation.z = -Math.min(1, pl.ps.max / 0.9) * Math.PI / 2;
          return;
        }
        const front = pl.pull ? 0 : pl.thick / 2; // a push part's handle is at the front of its plate
        g.position.set(pl.cx + Math.cos(pl.ang) * front, 0.12, pl.cy + Math.sin(pl.ang) * front);
        g.rotation.y = -pl.ang;
      });
    }

    // M01 drone on its four rigid legs, posed from the sim's linkage (the legs never change length)
    const drone = droneModel();
    scene.add(drone);
    const legs = [0, 1, 2, 3].map(() => { const m = legModel(); m.matrixAutoUpdate = false; scene.add(m); return m; });
    const MAT_Y = 0.12; // models stand on the mat
    const vx = new THREE.Vector3(), vy = new THREE.Vector3(), vz = new THREE.Vector3();
    function syncDrone() {
      const rig = sim.droneRig();
      const across = new THREE.Vector3(-Math.sin(rig.yaw), 0, Math.cos(rig.yaw));
      drone.position.set(rig.drone[0], MAT_Y + rig.drone[2], rig.drone[1]);
      drone.rotation.y = -rig.yaw;
      rig.legs.forEach(([p, q], i) => { // x along the leg, z along the pins
        vx.set(q[0] - p[0], q[2] - p[2], q[1] - p[1]).normalize();
        vz.copy(across).addScaledVector(vx, -across.dot(vx)).normalize();
        vy.crossVectors(vz, vx);
        legs[i].matrix.makeBasis(vx, vy, vz).setPosition(p[0], MAT_Y + p[2], p[1]);
      });
    }

    // loose models
    const nestSolid = sim.solids.find((s2) => s2.id === 'nest');
    const nestX = nestSolid ? nestSolid.shape.reduce((a2, p2) => a2 + p2[0], 0) / nestSolid.shape.length : 0;
    const itemMeshes = sim.items.map((it) => {
      const g = new THREE.Group();
      if (it.type === 'keystone') { // a team-built jaguar-ish keystone species
        g.add(brick(2, 4, 3, L.purple, 0, 1.2), brick(2, 2, 3, L.purple, 0, 2.2, -1.8), tile(2, 1, L.black, 0, 3.2, -2.6));
        for (const [x, z] of [[-0.4, -1.2], [0.4, -1.2], [-0.4, 1.2], [0.4, 1.2]]) g.add(brick(1, 1, 3, L.magenta, x, 0.24, z, { studs: false }));
        g.add(tube([[0, 2, 1.6], [0, 2.6, 2.6], [0.4, 3.2, 3]], 0.18, L.purple));
      } else if (it.type === 'leaf' || it.type === 'katydid') { // M04 leaves (book 4), pointing back into the nest
        const lf = leafModel(it.type === 'katydid');
        g.userData.leaf = lf; // turned each frame to lie along the nest leaf under its slot (the slots are shuffled)
        g.add(lf);
      } else if (it.type === 'anchor') { // M01 red cable anchor
        g.add(anchorModel());
      } else if (it.type === 'vine') { // M08 vine, pulled down onto the mat
        g.add(tube(Array.from({ length: 12 }, (_, i) => [Math.sin(i * 0.9) * 1.4, 0.35, -5 + i * 0.9]), 0.3, L.lime));
      } else if (it.type === 'tie') { // M12 ring (book 10, step 22): red 4x4 rounded corner plates and 1x4 plates in a ring, with red round tiles and a black bar plate for the chain
        const ringGeo = cached('tieRing', () => {
          const sh = new THREE.Shape(), R0 = 3.6, R1 = 2.8; sh.absarc(0, 0, R0, 0, Math.PI * 2, false);
          const hole = new THREE.Path(); hole.absarc(0, 0, R1, 0, Math.PI * 2, true); sh.holes.push(hole);
          const e = new THREE.ExtrudeGeometry(sh, { depth: 2 * PLATE, bevelEnabled: false, curveSegments: 32 }); e.rotateX(Math.PI / 2); e.translate(0, 2 * PLATE, 0); return e;
        });
        g.add(new THREE.Mesh(ringGeo, L.red));
        for (let i = 0; i < 4; i++) g.add(round(0.5, 1, L.red, -1.2 + i * 0.8, 2 * PLATE, -3.2));
        g.add(plate(4, 1, L.black, 0, 2 * PLATE, 3.2));
      } else if (it.type === 'fragment') { // M06 leaf (book 6, steps 68-69): a coloured 7L liftarm standing upright with a leaf plate on top
        const [arm, lf] = { frag1: [L.white, L.white], frag2: [L.orange, L.yellow], frag3: [plastic('#a95500'), L.orange], frag4: [L.green, L.green] }[it.id] || [L.green, L.green];
        g.add(beamAB(arm, [0, 0.36, 0], [0, 0.36 + 6 * U, 0], [1, 0, 0]), leafPlate(lf, lf).rotateZ(Math.PI / 2).translateY(0).translateX(6 * U + 0.4));
      } else {
        if (it.on === 'platform') { // book 7 pinecone (step 102): a brown cone and a 1x1 brick with studs all round, bristling with stems
          g.add(rod([0, 1.9, 0], [0, 2.6, 0], 0.2, L.red));
          const pc = new THREE.Mesh(cached('pinecone', () => new THREE.ConeGeometry(0.45, 1.0, 10)), L.brown); pc.rotation.x = Math.PI; pc.position.y = 1.2; g.add(pc);
          g.add(brick(1, 1, 3, L.brown, 0, 0.0, 0, { studs: false }));
          for (let i = 0; i < 4; i++) { const a2 = i * Math.PI / 2; g.add(rod([Math.cos(a2) * 0.4, 0.5, Math.sin(a2) * 0.4], [Math.cos(a2) * 0.9, 0.6, Math.sin(a2) * 0.9], 0.08, L.brown)); }
        } else g.add(seedModel(it.on === 'seedpod')); // book 2 seed, with its gold ring while it hangs on the stalk
      }
      shadowy(g);
      scene.add(g);
      return g;
    });

    // ---- robot ---------------------------------------------------------------
    let R = null, mctx = null, robotKey = null;
    function makeRobot() {
      if (R) scene.remove(R.robot);
      R = buildRobot();
      R.robot.add(contactShadow(ROBOT.width * 1.5, (ROBOT.length + ROBOT.basket) * 1.3));
      scene.add(R.robot);
      mctx = R.mCanvas.getContext('2d');
      matrixKey = '';
      robotKey = sim.buildKey;
    }
    let matrixKey = '';
    function drawMatrix() {
      const px = sim.hubPixels();
      const key = px.join(',');
      if (key === matrixKey) return;
      matrixKey = key;
      mctx.fillStyle = '#16191c'; mctx.fillRect(0, 0, 64, 64);
      for (let i = 0; i < 25; i++) {
        const v = px[i] / 100;
        mctx.fillStyle = v ? 'rgba(255,250,215,' + (0.35 + 0.65 * v) + ')' : '#2b3035';
        mctx.fillRect(4 + (i % 5) * 12, 4 + Math.floor(i / 5) * 12, 8, 8);
      }
      R.mTex.needsUpdate = true;
    }
    makeRobot();

    // distance sensor beam
    const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    scene.add(new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ color: '#ff4d6d', transparent: true, opacity: 0.6 })));
    const hitDot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), new THREE.MeshBasicMaterial({ color: '#ff4d6d' }));
    scene.add(hitDot);

    // path trail
    const TRAIL_MAX = 3000;
    const trailPos = new Float32Array(TRAIL_MAX * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: '#ff6a00', transparent: true, opacity: 0.8 }));
    trail.frustumCulled = false;
    scene.add(trail);
    let trailCount = -1;

    // The real robot's "ghost" (Robot tab, Real robot): a see-through box where the real robot is,
    // worked out from its wheels and gyro, and its path as a dashed purple line.
    const GHOST_COLOUR = '#7048e8';
    const ghostGroup = new THREE.Group();
    const ghostBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: GHOST_COLOUR, transparent: true, opacity: 0.22, depthWrite: false }));
    const ghostEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: GHOST_COLOUR }));
    const ghostNose = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.2, 3), new THREE.MeshBasicMaterial({ color: GHOST_COLOUR }));
    ghostNose.rotation.x = -Math.PI / 2;
    ghostGroup.add(ghostBox, ghostEdges, ghostNose);
    ghostGroup.visible = false;
    scene.add(ghostGroup);
    const ghostPos = new Float32Array(TRAIL_MAX * 3);
    const ghostTrailGeo = new THREE.BufferGeometry();
    ghostTrailGeo.setAttribute('position', new THREE.BufferAttribute(ghostPos, 3));
    const ghostTrail = new THREE.Line(ghostTrailGeo, new THREE.LineDashedMaterial({ color: GHOST_COLOUR, dashSize: 2.4, gapSize: 1.6 }));
    ghostTrail.frustumCulled = false;
    ghostTrail.visible = false;
    scene.add(ghostTrail);
    let ghostCount = -1, ghostFirst = null;
    function setGhost(g) {
      ghostGroup.visible = ghostTrail.visible = !!g;
      if (!g) return;
      const L = ROBOT.length, W = ROBOT.width, Ht = ROBOT.height;
      ghostBox.scale.set(W, Ht, L);
      ghostEdges.scale.set(W, Ht, L);
      ghostBox.position.y = ghostEdges.position.y = Ht / 2;
      ghostNose.position.set(0, Ht + 2, -L / 2 + 1.6);
      ghostGroup.position.set(g.x, 0.12, g.y);
      ghostGroup.rotation.y = -rad(g.h);
      const pts = g.trail.length > TRAIL_MAX ? g.trail.slice(-TRAIL_MAX) : g.trail;
      if (pts.length !== ghostCount || pts[0] !== ghostFirst) {
        ghostCount = pts.length; ghostFirst = pts[0];
        pts.forEach(([x, y], i) => { ghostPos[i * 3] = x; ghostPos[i * 3 + 1] = 0.25; ghostPos[i * 3 + 2] = y; });
        ghostTrailGeo.attributes.position.needsUpdate = true;
        ghostTrailGeo.setDrawRange(0, pts.length);
        ghostTrail.computeLineDistances();
      }
    }

    // ---- camera modes --------------------------------------------------------
    let mode = 'orbit';
    function fitDistance(margin) {
      const half = Math.tan(rad(camera.fov / 2));
      return Math.max((tableW / 2) / (half * camera.aspect), (tableD / 2) / half) * margin;
    }
    function setMode(m) {
      mode = m;
      controls.enabled = m !== 'follow';
      if (m === 'top') {
        controls.target.set(cx, 0, cz);
        camera.position.set(cx, fitDistance(1.04), cz + 0.01);
      } else if (m === 'orbit') {
        const d = fitDistance(1.2);
        controls.target.set(cx, 0, cz + 4);
        camera.position.set(cx, d * 0.78, cz + d * 0.66);
      }
      controls.update();
    }

    const fwd = new THREE.Vector3();
    function followCamera() {
      const r = sim.robot;
      fwd.set(Math.sin(rad(r.h)), 0, -Math.cos(rad(r.h)));
      const want = new THREE.Vector3(r.x, 0, r.y).addScaledVector(fwd, -42).setY(30);
      camera.position.lerp(want, 0.12);
      controls.target.lerp(new THREE.Vector3(r.x, 4, r.y).addScaledVector(fwd, 22), 0.2);
      camera.lookAt(controls.target);
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);
    resize();
    setMode('orbit');

    // ---- realistic rendering: ambient occlusion, LED glow, filmic colour, anti-aliasing ------
    const canPost = !!(THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass && THREE.ShaderPass && THREE.FXAAShader);
    let quality = canPost ? 'realistic' : 'fast';
    let composer = null, fxaa = null;
    const FilmShader = {
      uniforms: { tDiffuse: { value: null }, exposure: { value: 1.0 }, time: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: [
        'uniform sampler2D tDiffuse; uniform float exposure; uniform float time; varying vec2 vUv;',
        'vec3 aces(vec3 x) { x *= 0.6; return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }',
        'float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + time) * 43758.5453); }',
        'void main() {',
        '  vec3 c = texture2D(tDiffuse, vUv).rgb * exposure;',
        '  c = aces(c * 1.25);',
        '  c = pow(c, vec3(1.0 / 2.2));',                                   // linear -> display
        '  float l = dot(c, vec3(0.299, 0.587, 0.114)); c = mix(vec3(l), c, 1.08);', // a touch of saturation
        '  vec2 d = vUv - 0.5; c *= 1.0 - dot(d, d) * 0.55;',             // lens vignette
        '  c += (rnd(vUv) - 0.5) * 0.018;',                                 // fine film grain
        '  gl_FragColor = vec4(c, 1.0);',
        '}',
      ].join('\n'),
    };
    let bokeh = null;
    function buildComposer() {
      const w = container.clientWidth || 800, h = container.clientHeight || 450, pr = renderer.getPixelRatio();
      composer = new THREE.EffectComposer(renderer);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      if (THREE.SSAOPass) {
        // ambient occlusion: soft dark shading in the gaps between bricks and where models meet the mat.
        // Depths are 0..1 between the camera's near and far planes (5 - 3200 cm), so 0.004 is about 13 cm.
        const ao = new THREE.SSAOPass(scene, camera, w, h);
        Object.assign(ao, { kernelRadius: 1.6, minDistance: 0.00003, maxDistance: 0.004 });
        composer.addPass(ao);
      } else {
        composer.addPass(new THREE.RenderPass(scene, camera));
      }
      if (THREE.BokehPass) {
        // a real camera's depth of field: sharp where you are looking, the far end of the gym a little soft
        bokeh = new THREE.BokehPass(scene, camera, { focus: 300, aperture: 0.000006, maxblur: 0.006, width: w, height: h });
        composer.addPass(bokeh);
      }
      composer.addPass(new THREE.UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.3, 1.4)); // only bright LEDs glow
      composer.addPass(new THREE.ShaderPass(FilmShader));
      fxaa = new THREE.ShaderPass(THREE.FXAAShader);
      fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
      composer.addPass(fxaa);
    }
    function setQuality(q) {
      quality = canPost ? q : 'fast';
      if (quality === 'realistic') {
        renderer.toneMapping = THREE.NoToneMapping;
        if (!composer) buildComposer();
      } else {
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 0.95;
      }
      for (const m of Object.values(mats)) m.needsUpdate = true;
      scene.traverse((o) => { if (o.material && o.material.needsUpdate !== undefined) o.material.needsUpdate = true; });
    }
    new ResizeObserver(() => {
      if (!composer) return;
      const w = container.clientWidth, h = container.clientHeight, pr = renderer.getPixelRatio();
      if (!w || !h) return;
      composer.setSize(w, h);
      fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    }).observe(container);

    // ---- per-frame sync ------------------------------------------------------
    let lastEnc = [0, 0];
    let colourTick = 0;
    function render() {
      if (colourTick++ % 30 === 0) linearizeColours(scene); // picks up models, items and robots built since
      if (JSON.stringify(sim.docks) !== dockKey) buildModels();
      if (sim.buildKey !== robotKey) makeRobot();
      const r = sim.robot;
      R.robot.position.set(r.x, 0.12, r.y);
      R.robot.rotation.y = -rad(r.h);
      // wheels turn with the encoders, gate follows motor C, lights follow the hub
      R.wheels[0].rotation.x -= rad(r.encL - lastEnc[0]);
      R.wheels[1].rotation.x -= rad(r.encR - lastEnc[1]);
      lastEnc = [r.encL, r.encR];
      R.pose(r);
      drawMatrix();
      R.centerBtn.material.emissive.set(SPIKE_COLOURS[sim.hub.center] || '#ffffff');
      R.centerBtn.material.color.set(SPIKE_COLOURS[sim.hub.center] || '#ffffff');
      R.eyeLights.forEach((seg, i) => { seg.material.emissiveIntensity = (sim.hub.eyes[[0, 2, 1, 3][i]] || 0) / 40; });
      R.csFace.material.emissive.set(SENSOR_COLOURS[sim.color()] || '#ffffff');

      for (const m of models) {
        m.update(sim.state[m.id], sim);
        const s = sim.solids.find((x) => x.id === m.id);
        if (s && s.pose) { // free-standing models can be knocked around
          m.group.position.set(m.f.cx + s.pose.dx, 0.12, m.f.cy + s.pose.dy);
          m.group.rotation.y = -(m.f.ang + rad(s.pose.da));
        }
      }
      syncPads();
      syncDrone();

      sim.items.forEach((it, i) => {
        itemMeshes[i].position.set(it.x, 0.12 + (it.z || 0), it.y);
        itemMeshes[i].visible = !it.outOfPlay && !(it.type === 'vine' && it.attached); // the tree draws its own wrapped vine
        itemMeshes[i].rotation.y = -rad(it.a);
        const lf = itemMeshes[i].userData.leaf;
        if (lf && it.attached) { const dx = it.x - nestX; lf.rotation.y = dx < -1 ? 0.87 : dx > 1 ? -0.87 : 0; }
      });

      const d = sim.distance();
      fwd.set(Math.sin(rad(r.h)), 0, -Math.cos(rad(r.h)));
      const a = new THREE.Vector3(r.x, 5, r.y).addScaledVector(fwd, ROBOT.length / 2 + 0.8);
      const b = a.clone().addScaledVector(fwd, d);
      beamGeo.attributes.position.setXYZ(0, a.x, a.y, a.z);
      beamGeo.attributes.position.setXYZ(1, b.x, b.y, b.z);
      beamGeo.attributes.position.needsUpdate = true;
      hitDot.position.copy(b);
      hitDot.visible = d < ROBOT.eyeRange;

      if (sim.trail.length !== trailCount) {
        trailCount = sim.trail.length;
        sim.trail.forEach(([x, y], i) => { trailPos[i * 3] = x; trailPos[i * 3 + 1] = 0.2; trailPos[i * 3 + 2] = y; });
        trailGeo.attributes.position.needsUpdate = true;
        trailGeo.setDrawRange(0, trailCount);
      }

      if (mode === 'follow') followCamera();
      else controls.update();
      if (quality === 'realistic' && composer) {
        if (bokeh) bokeh.uniforms.focus.value = camera.position.distanceTo(controls.target);
        composer.render();
      }
      else renderer.render(scene, camera);
    }

    // Point the orbit camera at a spot (used by tests and handy from the browser console).
    function lookAt(tx, ty, tz, px, py, pz) { setMode('orbit'); controls.target.set(tx, ty, tz); camera.position.set(px, py, pz); controls.update(); }

    setQuality(quality);
    return { debug: { scene, renderer, sun, camera, get models() { return models; }, get robot() { return R; } }, render, setGhost, setMode, lookAt, setQuality, canPost, get quality() { return quality; }, get mode() { return mode; }, el: renderer.domElement };
  }

  // ---- live robot inspector (Robot tab) ------------------------------------------------------
  // The same robot model, lights and materials as the field view, close up on a plain white floor. The
  // robot stays put with its front up the screen while the floor's grid slides and turns underneath,
  // so the ground going by is what the tyres really feel. The robot keeps its colours except for parts
  // that are doing something: green = spinning, flashing red = slipping or a problem (Test failures).
  // Arrows beside each wheel: blue = how fast the wheel turns, grey = how fast the ground goes by.
  function inspector(container, sim, paintMatArt) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#ffffff');
    if (THREE.RoomEnvironment) {
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    scene.add(new THREE.HemisphereLight('#f4f8ff', '#3a3226', scene.environment ? 0.18 : 0.5));
    const sun = new THREE.DirectionalLight('#fff1dc', 0.62);
    sun.position.set(-18, 60, 22);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 10, far: 120 });
    sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.04;
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(36, 1, 1, 600);
    camera.position.set(0, 36, 25);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 3, -2);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.maxPolarAngle = rad(86); controls.minDistance = 15; controls.maxDistance = 160; controls.enablePan = false;

    // the ground: a white floor with a faint grid fixed to the table, and the table walls, all turned and
    // moved so the robot sits where it really is
    const ground = new THREE.Group(), table = new THREE.Group();
    ground.add(table); scene.add(ground);
    const TILE = 8, FLOOR = 600; // grid squares of 8 cm (10 studs)
    const gridCanvas = document.createElement('canvas'); gridCanvas.width = gridCanvas.height = 256;
    { const g = gridCanvas.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 256, 256); g.strokeStyle = '#d4d6d9'; g.lineWidth = 4; g.strokeRect(0, 0, 256, 256); }
    const gridTex = new THREE.CanvasTexture(gridCanvas);
    gridTex.wrapS = gridTex.wrapT = THREE.RepeatWrapping; gridTex.repeat.set(FLOOR / TILE, FLOOR / TILE);
    gridTex.encoding = THREE.sRGBEncoding; gridTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR, FLOOR), new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.95 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; table.add(floor);
    for (const [w, d, x, z] of [[FIELD.w + 7.6, 3.8, FIELD.w / 2, -1.9], [FIELD.w + 7.6, 3.8, FIELD.w / 2, FIELD.h + 1.9], [3.8, FIELD.h, -1.9, FIELD.h / 2], [3.8, FIELD.h, FIELD.w + 1.9, FIELD.h / 2]]) {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, 7.6, d), plastic('#e4e6e9', { roughness: 0.8, clearcoat: 0 }));
      wall.position.set(x, 3.8, z); wall.castShadow = wall.receiveShadow = true; table.add(wall);
    }
    linearizeColours(table);

    // a label that always faces the camera
    const tag = (text, colour) => {
      const c = document.createElement('canvas'); c.width = 256; c.height = 64;
      const g = c.getContext('2d'); g.font = 'bold 40px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.65)'; g.strokeText(text, 128, 34); g.fillStyle = colour; g.fillText(text, 128, 34);
      const tex = new THREE.CanvasTexture(c); tex.encoding = THREE.sRGBEncoding;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.scale.set(9, 2.25, 1); sp.renderOrder = 10; scene.add(sp);
      return sp;
    };
    // a solid arrow (shaft and cone) pointing along local -z, drawn on top so the robot never hides it
    const arrow = (hex) => {
      const m = new THREE.MeshBasicMaterial({ color: hex, depthTest: false, transparent: true, opacity: 0.95, toneMapped: false });
      linearized.add(m);
      const g = new THREE.Group(), shaft = new THREE.Mesh(cached('arrowShaft', () => new THREE.CylinderGeometry(0.28, 0.28, 1, 12)), m);
      const head = new THREE.Mesh(cached('arrowHead', () => new THREE.ConeGeometry(0.75, 1, 16)), m);
      shaft.rotation.x = head.rotation.x = -Math.PI / 2;
      shaft.renderOrder = head.renderOrder = 9;
      g.add(shaft, head); g.userData = { shaft, head };
      scene.add(g);
      return g;
    };
    const WHEEL_BLUE = 0x3b8bf0, GROUND_GREY = 0x5b6168;
    const arrows = { L: [arrow(WHEEL_BLUE), arrow(GROUND_GREY)], R: [arrow(WHEEL_BLUE), arrow(GROUND_GREY)] };
    const body = arrow(0x1f2328);
    const slipTags = { L: tag('SLIP', '#ff5a4e'), R: tag('SLIP', '#ff5a4e') }, offTags = { L: tag('OFF', '#bbbbbb'), R: tag('OFF', '#bbbbbb') };
    const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineDashedMaterial({ color: '#ff5050', dashSize: 0.8, gapSize: 0.5, depthTest: false, transparent: true }));
    beam.renderOrder = 9; scene.add(beam);
    const FORWARD = new THREE.Vector3(0, 0, -1);
    const setArrow = (a, x, y, z, len, dir) => {
      const L = Math.abs(len);
      a.visible = L > 0.3;
      if (!a.visible) return;
      a.position.set(x, y, z);
      a.quaternion.setFromUnitVectors(FORWARD, dir || new THREE.Vector3(0, 0, len > 0 ? -1 : 1));
      const hl = Math.min(1.6, L * 0.45), { shaft, head } = a.userData;
      shaft.scale.y = Math.max(0.01, L - hl); shaft.position.z = -(L - hl) / 2;
      head.scale.set(1, hl, 1); head.position.z = -(L - hl / 2);
    };

    let R = null, robotKey = null, lastEnc = [0, 0], mctx = null, matrixKey = '', tyres = {};
    // Parts that light up: each gets its own copies of its materials, so tinting them leaves the field
    // view alone. Green glow = spinning (stronger = faster), flashing red = slipping or a problem.
    const GREEN = new THREE.Color('#1fd65f').convertSRGBToLinear(), RED = new THREE.Color('#ff2a1a').convertSRGBToLinear();
    let parts = {};
    const light = (p, colour, strength) => { for (const m of p.mats) { m.emissive.copy(colour); m.emissiveIntensity = strength; } };

    function makeRobot() {
      if (R) scene.remove(R.robot);
      R = buildRobot();
      scene.add(R.robot);
      linearizeColours(R.robot);
      // each tyre gets its own material so one can glow red while the other grips
      tyres = {};
      R.wheels.forEach((w, i) => {
        const tyre = w.children[0], m = tyre.material.clone();
        m.emissive = new THREE.Color('#ff2a1a'); m.emissiveIntensity = 0; linearized.add(m);
        tyre.material = m; tyres[i ? 'R' : 'L'] = { mesh: tyre, mat: m, colour: m.color.clone() };
      });
      mctx = R.mCanvas.getContext('2d'); matrixKey = ''; lastEnc = [sim.robot.encL, sim.robot.encR];
      robotKey = sim.buildKey;
      const keep = new Set([R.matrix, R.csFace, R.centerBtn, ...R.spots, ...R.eyeLights]); // these light up by themselves
      const part = (...roots) => {
        const copies = new Map();
        for (const root of roots) root.traverse((o) => {
          if (!o.isMesh || keep.has(o) || !o.material || !o.material.emissive) return;
          if (!copies.has(o.material)) { const m = o.material.clone(); m.emissive = new THREE.Color(0); m.emissiveIntensity = 0; linearized.add(m); copies.set(o.material, m); }
          o.material = copies.get(o.material);
        });
        return { mats: [...copies.values()] };
      };
      parts = { L: part(R.wheels[0]), R: part(R.wheels[1]), att: part(R.att, R.gate), ds: part(R.ds), hub: part(R.hub), sensors: R.sensorGroups.map((g) => part(g)) };
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(container);

    function render() {
      if (sim.buildKey !== robotKey) makeRobot();
      const r = sim.robot, radius = ROBOT.wheel.diameter / 2;
      ground.rotation.y = rad(r.h); table.position.set(-r.x, 0, -r.y);
      floor.position.set(r.x, 0, r.y); gridTex.offset.set(r.x / TILE, -r.y / TILE); // the floor follows the robot, its grid stays put
      R.wheels[0].rotation.x -= rad(r.encL - lastEnc[0]);
      R.wheels[1].rotation.x -= rad(r.encR - lastEnc[1]);
      lastEnc = [r.encL, r.encR];
      R.pose(r);
      const px = sim.hubPixels(), key = px.join(',');
      if (key !== matrixKey) {
        matrixKey = key;
        mctx.fillStyle = '#16191c'; mctx.fillRect(0, 0, 64, 64);
        for (let i = 0; i < 25; i++) { const v = px[i] / 100; mctx.fillStyle = v ? 'rgba(255,250,215,' + (0.35 + 0.65 * v) + ')' : '#2b3035'; mctx.fillRect(4 + (i % 5) * 12, 4 + Math.floor(i / 5) * 12, 8, 8); }
        R.mTex.needsUpdate = true;
      }
      R.centerBtn.material.emissive.set(SPIKE_COLOURS[sim.hub.center] || '#ffffff');
      R.csFace.material.emissive.set(sim.faults.color.on ? SENSOR_COLOURS[sim.color()] || '#ffffff' : '#000000');

      // wheels: speed arrows, slip glow, switched-off motors
      const scale = ((ROBOT.length + ROBOT.basket) * 0.85) / ROBOT.maxSpeed; // a full-speed arrow is a little longer than the robot
      const ww = Math.max(ROBOT.wheel.width, 1.2);
      for (const [side, sd] of [['L', -1], ['R', 1]]) {
        const info = r.wheels[side] || { w: 0, ground: 0, slip: false, dead: false };
        const x = sd * (ROBOT.wheelBase / 2 + ww / 2);
        setArrow(arrows[side][0], x + sd * 1.0, 0.4, 0, info.w * radius * scale);
        setArrow(arrows[side][1], x + sd * 2.4, 0.4, 0, info.ground * radius * scale);
        slipTags[side].visible = info.slip; offTags[side].visible = info.dead;
        slipTags[side].position.set(sd * ROBOT.wheelBase / 2, ROBOT.wheel.diameter + 2.2, 0);
        offTags[side].position.set(sd * ROBOT.wheelBase / 2, ROBOT.wheel.diameter + (info.slip ? 4 : 2.2), 0);
      }
      // the robot's actual movement (white arrow over the hub)
      const v = sim.body.getLinearVelocity(), a = sim.body.getAngle();
      const fwd = v.x * Math.cos(a) + v.y * Math.sin(a), right = -v.x * Math.sin(a) + v.y * Math.cos(a);
      const len = Math.hypot(fwd, right) * scale;
      setArrow(body, 0, ROBOT.height + 1.5, 0, len, new THREE.Vector3(right, 0, -fwd).normalize());
      // what the distance sensor is measuring
      beam.visible = ROBOT.distanceSensor && sim.faults.distance.on;
      if (beam.visible) {
        const d = Math.min(sim.distance(), 80), z0 = -ROBOT.length / 2;
        beam.geometry.setFromPoints([new THREE.Vector3(0, 5, z0), new THREE.Vector3(0, 5, z0 - d)]);
        beam.computeLineDistances();
      }
      // light up what is going on: flashing red = slipping or a problem, green = spinning
      const f = sim.faults, maxW = ROBOT.maxSpeed / radius, flash = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(performance.now() / 1000 * Math.PI * 5));
      const show = (p, bad, spinning) => (bad ? light(p, RED, 1.3 * flash) : spinning > 0 ? light(p, GREEN, 0.25 + 0.6 * Math.min(1, spinning)) : light(p, RED, 0));
      for (const [side, job] of [['L', 'left'], ['R', 'right']]) {
        const info = r.wheels[side] || { w: 0, slip: false }, fj = f[job], speed = Math.abs(info.w) / maxW;
        show(parts[side], info.slip || !fj.on || fj.power < 100 || fj.grip < 100, speed > 0.02 ? speed : 0);
      }
      show(parts.att, !f.arm.on || f.arm.power < 100, Math.abs(r.armVel) > 5 ? Math.abs(r.armVel) / WHEEL.maxDegPerSec : 0);
      parts.sensors.forEach((p, i) => { const fj = f[i ? 'color2' : 'color']; show(p, !fj.on || fj.noise > 0, 0); });
      show(parts.ds, !f.distance.on || f.distance.noise > 0, 0);
      show(parts.hub, !f.gyro.on || f.gyro.drift !== 0, 0);
      controls.update();
      renderer.render(scene, camera);
    }
    makeRobot(); resize();
    return { render, el: renderer.domElement };
  }

  window.BioGlow3D = { create, inspector };
})();
