/* BIOGLOW FLL robot simulator - core (no DOM dependencies).
 * Units: centimetres, kilograms, seconds, degrees. Origin is the top-left inside corner of the table,
 * y points down. Heading 0 = up (north), 90 = right (east); positive turns are clockwise.
 *
 * Field layout follows the official BIOGLOW Wireframe & Path Diagram: a 200 x 114 cm mat pushed
 * against the bottom wall and centred on a 236.2 x 114.3 cm table, leaving an 18 cm home strip at
 * each end.
 *
 * Physics: a top-down rigid-body world (planck.js / Box2D). The robot is driven by two motor-driven
 * wheels with tyre grip limits, so it can slip, get pushed back, square up against walls and lose
 * speed under load. The program only sees encoders and a gyro, never the true position. Mission
 * models are fixed to the mat; their moving parts are spring-loaded plates that need a real push
 * (force and travel) to trigger. Loose models slide with mat friction.
 */
(function (root) {
  'use strict';

  const planck = root.planck || (typeof require === 'function' ? require('./vendor/planck.min.js') : null);
  // The parts of each mission model that stick out past its footprint (made by tools/make-outlines.html).
  const OUTLINES = root.BioGlowOutlines || (typeof require === 'function' ? (() => { try { return require('./model-outlines.js'); } catch (e) { return null; } })() : null) || {};
  const Vec2 = (x, y) => planck.Vec2(x, y);

  const FIELD = { w: 236.2, h: 114.3 }; // inside of the table walls
  const MAT_RECT = { x: 18.1, y: 0.4, w: 200, h: 113.9 };
  // SPIKE Prime style drive base: 56 mm wheels on medium motors.
  const WHEEL = { diameter: 5.6, width: 1.4, maxDegPerSec: 1000 };
  // These describe the robot that is built right now; setBuild() changes them (Robot tab).
  const ROBOT = {
    length: 18, width: 14, height: 11, wheelBase: 11.2,
    wheel: WHEEL,
    maxSpeed: (WHEEL.maxDegPerSec / 360) * Math.PI * WHEEL.diameter, // ~48.9 cm/s at 100%
    accel: 200, // cm/s^2 speed-up ramp the motor controller uses
    brakeAccel: 700, // cm/s^2 slow-down ramp (motors brake much harder than they accelerate)
    sensorOffset: 8, // colour sensor, cm ahead of the axle
    sensorSide: 0, // colour sensor, cm right of the centre line
    sensorSpot: 0.8, // colour sensor reading radius
    eyeRange: 200, eyeMin: 4, eyeCone: 5, // distance sensor range (cm) and half-angle (deg)
    eyeRate: 20, // distance sensor readings per second
    attachment: 'basket',
    basket: 9, // how far the attachment reaches in front of the bumper
  };

  // ---- robot builder ---------------------------------------------------------------
  const WHEELS = {
    56: { diameter: 5.6, width: 1.4, label: '56 mm SPIKE wheels' },
    62: { diameter: 6.24, width: 2.0, label: '62.4 mm wheels' },
    88: { diameter: 8.8, width: 1.4, label: '88 mm wheels' },
  };
  // Speed at 100% (regulated, deg/s) and stall torque (N*m) of the drive motors.
  const MOTORS = {
    medium: { maxDegPerSec: 1000, stall: 0.18, mass: 0.11, label: 'SPIKE medium motors' },
    large: { maxDegPerSec: 1050, stall: 0.25, mass: 0.16, label: 'SPIKE large motors' },
  };
  // Front attachments. `reach` is how far it sticks out in front of the bumper.
  const ATTACHMENTS = {
    basket: { reach: 9, mass: 0.04, label: 'Basket', about: 'Two side arms and a gate on motor C: closing the gate grabs loose models between the arms.' },
    hook: { reach: 12, mass: 0.03, label: 'Hook arm', about: 'One arm in the middle with a hook on motor C: closing it hooks the piece at the tip (leaves, the vine, the support tie, the cable anchor).' },
    pusher: { reach: 2, mass: 0.05, label: 'Flat pusher', about: 'A bumper across the whole front for pushing mission models. It cannot pick anything up.' },
    lifter: { reach: 10, mass: 0.04, label: 'Lift arm', about: 'A two-pronged fork on motor C, resting just above the mat: drive its prongs under a handle, then turn motor C \u21bb to lift it (M09, M12, M15).' },
  };
  // Attachments made from photos (Robot tab) are added here by registerAttachment(); see customSwing().
  let attachmentRev = 0;
  function registerAttachment(def) {
    const vox = attachmentVoxels(def);
    if (!vox.count) return null;
    const id = def.id;
    ATTACHMENTS[id] = {
      rev: ++attachmentRev, // a changed attachment rebuilds the robot (see buildKey)
      reach: 0, mass: clamp(vox.count * def.cell ** 3 * 0.00035, 0.01, 0.3), label: def.name || 'My attachment', custom: def,
      about: (def.mount === 'fixed' ? 'Made from your photos, fixed to the front of the robot.' : 'Made from your photos, turned by motor ' + (def.mount === 'spare' ? 'D' : 'C') + '.') + ' It pushes what it hits and lifts handles it is under.',
    };
    return ATTACHMENTS[id];
  }
  function unregisterAttachment(id) { if (ATTACHMENTS[id] && ATTACHMENTS[id].custom) delete ATTACHMENTS[id]; }
  // The robot itself made from photos (Robot tab), drawn in place of the standard parts when a build has
  // `look: true`. Same grids as a photo attachment, with the pivot at the bottom of the middle so the
  // cubes sit on the mat around the robot's centre. Only one is kept.
  let robotLook = null;
  function setRobotLook(def) {
    robotLook = def && attachmentVoxels(def).count ? { ...def, rev: ++attachmentRev } : null;
    return robotLook;
  }
  // What each hub port is plugged into. Inside the simulator each job keeps one letter (A and B the
  // left and right drive motors, C the attachment motor, D the spare motor, E the color sensor, F the
  // distance sensor, G a second color sensor). A build's `ports` say which hub port each job is wired
  // to, and programs are translated at the hub, so they use the real robot's port letters.
  const JOBS = {
    left: { inner: 'A', label: 'left drive motor', motor: true },
    right: { inner: 'B', label: 'right drive motor', motor: true },
    arm: { inner: 'C', label: 'attachment motor', motor: true },
    spare: { inner: 'D', label: 'spare motor', motor: true },
    color: { inner: 'E', label: 'color sensor' },
    color2: { inner: 'G', label: 'second color sensor' },
    distance: { inner: 'F', label: 'distance sensor' },
  };
  const HUB_PORTS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const WIRING_DEFAULT = { A: 'left', B: 'right', C: 'arm', D: 'spare', E: 'color', F: 'distance' };
  // Robots to pick from (Robot tab). 'custom' is whatever the builder fields say; the others are
  // official builds whose measurements and wiring are fixed. The attachment, and anything listed in
  // `choices` (with the build's own as the default), can still be changed.
  const ROBOT_MODELS = {
    custom: { label: 'Your own driving base', about: 'Set the wheels, motors, size, sensors and wiring yourself.' },
    adb: {
      label: 'SPIKE Prime Advanced Driving Base',
      about: 'The Competition Ready Advanced Driving Base from the SPIKE App: 88 mm wheels on the two medium motors (A left, E right), two color sensors looking down at the front (B left, F right), attachment motors on C and D, no distance sensor.',
      // The SPIKE App's own test program sets the pair to A+E and 1 rotation to 27.63 cm (88 mm wheels);
      // the port map is from the last page of the building instructions. Sizes are measured off the
      // instruction drawings (the 8.8 cm hub across the robot as the scale), so they are approximate.
      build: { wheel: 88, motor: 'medium', track: 12, length: 17.6, width: 16, height: 12, mass: 0.8, sensorAhead: 4.8, sensorSide: -2.7 },
      ports: { A: 'left', B: 'color', C: 'arm', D: 'spare', E: 'right', F: 'color2' },
      choices: ['motor'], // built with the medium motors; large ones fit the same way
    },
  };
  // Failure testing (Robot tab): parts switched off or working badly, to see how a program copes.
  // Keyed by job, so they follow the wiring. `power` and `grip` are % of normal, `noise` is extra sensor
  // noise (reflection % or cm), `drift` extra gyro drift in degrees per second.
  const FAULTS_DEFAULT = {
    left: { on: true, power: 100, grip: 100 }, right: { on: true, power: 100, grip: 100 },
    arm: { on: true, power: 100 }, spare: { on: true, power: 100 },
    color: { on: true, noise: 0 }, color2: { on: true, noise: 0 }, distance: { on: true, noise: 0 },
    gyro: { on: true, drift: 0 },
  };
  const FAULT_LIMITS = { power: [0, 100], grip: [10, 100], noise: [0, 30], drift: [-5, 5] };
  function normalizeFaults(f) {
    const out = {};
    for (const [part, dflt] of Object.entries(FAULTS_DEFAULT)) {
      const given = (f && f[part]) || {};
      out[part] = {};
      for (const [k, v] of Object.entries(dflt)) {
        out[part][k] = k === 'on' ? given.on !== false : clamp(Number(given[k] === undefined ? v : given[k]) || 0, ...FAULT_LIMITS[k]);
      }
    }
    return out;
  }
  const BUILD_DEFAULT = { model: 'custom', look: false, wheel: 56, motor: 'medium', track: 11.2, length: 18, width: 14, height: 11, mass: 0.95, sensorAhead: 8, sensorSide: 0, attachment: 'basket', ports: WIRING_DEFAULT };
  const BUILD_LIMITS = { track: [8, 18], length: [12, 28], width: [10, 22], height: [6, 40], mass: [0.5, 1.6], sensorAhead: [-6, 14], sensorSide: [-6, 6] };
  // Keeps a build within what can be assembled from the kit (the wheels have to fit beside the body).
  function normalizeBuild(b) {
    const out = { ...BUILD_DEFAULT, ...(b || {}) };
    if (!ROBOT_MODELS[out.model]) out.model = BUILD_DEFAULT.model;
    const model = ROBOT_MODELS[out.model];
    if (model.build) {
      const kept = {};
      for (const k of model.choices || []) if (b && b[k] !== undefined) kept[k] = b[k];
      Object.assign(out, model.build, { ports: model.ports }, kept);
    }
    if (!WHEELS[out.wheel]) out.wheel = BUILD_DEFAULT.wheel;
    if (!MOTORS[out.motor]) out.motor = BUILD_DEFAULT.motor;
    if (!ATTACHMENTS[out.attachment]) out.attachment = BUILD_DEFAULT.attachment;
    for (const [k, [lo, hi]] of Object.entries(BUILD_LIMITS)) out[k] = clamp(Number(out[k]) || BUILD_DEFAULT[k], lo, hi);
    out.track = Math.min(out.track, out.width - 1);
    out.sensorAhead = Math.min(out.sensorAhead, out.length / 2 + 1);
    out.sensorSide = clamp(out.sensorSide, -out.width / 2 + 1, out.width / 2 - 1);
    out.ports = normalizeWiring(out.ports);
    out.look = !!(out.look && robotLook);
    // two color sensors sit either side of the middle (the second mirrors the first)
    if (Object.values(out.ports).includes('color2') && Math.abs(out.sensorSide) < 1) out.sensorSide = -2.4;
    return out;
  }
  // Each job on at most one port; a robot needs both drive motors, so anything else falls back to the default wiring.
  function normalizeWiring(p) {
    const out = {}, used = new Set();
    for (const port of HUB_PORTS) {
      const job = p && p[port];
      if (JOBS[job] && !used.has(job)) { out[port] = job; used.add(job); } else out[port] = 'none';
    }
    return used.has('left') && used.has('right') ? out : { ...WIRING_DEFAULT };
  }
  const buildKeyOf = (b) => JSON.stringify(b) + (ATTACHMENTS[b.attachment].rev || '') + (b.look && robotLook ? ':' + robotLook.rev : '');
  function applyBuild(b) {
    const w = WHEELS[b.wheel], m = MOTORS[b.motor], a = ATTACHMENTS[b.attachment];
    Object.assign(WHEEL, { diameter: w.diameter, width: w.width, maxDegPerSec: m.maxDegPerSec });
    Object.assign(ROBOT, {
      length: b.length, width: b.width, height: b.height, wheelBase: b.track, sensorOffset: b.sensorAhead, sensorSide: b.sensorSide,
      attachment: b.attachment, basket: a.reach, maxSpeed: (WHEEL.maxDegPerSec / 360) * Math.PI * WHEEL.diameter,
    });
    ROBOT.model = b.model;
    ROBOT.look = b.look ? robotLook : null;
    ROBOT.ports = b.ports;
    ROBOT.sensorSide2 = -b.sensorSide;
    ROBOT.color2 = Object.values(b.ports).includes('color2');
    ROBOT.distanceSensor = Object.values(b.ports).includes('distance');
    ROBOT.swing = makeSwing(b.attachment);
    ROBOT.attachTop = 0;
    if (ROBOT.swing && ROBOT.swing.shape) { // how far it reaches past the bumper and how tall it stands, as it starts
      const pts = swingPoints(ROBOT.swing, ROBOT.swing.shape, ROBOT.swing.angle(0));
      if (a.custom) ROBOT.basket = Math.max(0, Math.max(...pts.map((p) => p[0])) - b.length / 2);
      ROBOT.attachTop = Math.max(...pts.map((p) => p[2]));
    }
    for (const port of HUB_PORTS) PORTS[port] = JOBS[b.ports[port]] ? JOBS[b.ports[port]].label : 'nothing';
    PHYS.robotMass = b.mass;
    PHYS.stallTorque = m.stall * 1e4;
    PHYS.freeSpeed = rad(m.maxDegPerSec * 1.1);
  }
  // Movement acceleration settings of the SPIKE App's "set movement acceleration" block (motor deg/s^2).
  const ACCEL_SETTINGS = { slow: 1000, medium: 3000, fast: 10000 };
  // Precision tokens left -> points (rulebook).
  const TOKEN_POINTS = [0, 10, 15, 25, 35, 50, 50];
  const MAX_HEIGHT = 30.5; // cm, equipment inspection height limit
  const G = 981; // cm/s^2
  const NEWTON = 100; // kg*cm/s^2 per newton
  const PHYS = {
    robotMass: 0.95, // kg, robot with hub, motors and attachments
    driveLoad: 0.8, // share of the weight on the two drive wheels (rest on the caster)
    tyreGrip: 0.95, // rubber tyre on the mat
    slideGrip: 0.85, // once a tyre is slipping
    casterGrip: 0.12, // steel ball caster
    stallTorque: 0.18 * 1e4, // N*m -> kg*cm^2/s^2 (SPIKE medium motor)
    freeSpeed: (1100 * Math.PI) / 180, // rad/s
    wheelInertia: 0.5, // kg*cm^2: wheel plus gearbox seen at the wheel
    motorKi: 20000, // integral gain of the motor speed controller
    bodyFriction: 0.3, // plastic on plastic/wood
    restitution: 0.05,
    matGrip: 0.4, // LEGO bricks sliding on the mat
  };
  // Real-world variation (toggle with sim.variation): how much a real robot differs from the ideal.
  const VARIATION = {
    wheelDiameter: 0.006, // +/- fraction per wheel (tyre wear, assembly)
    motorStrength: 0.05, // +/- fraction per motor
    gyroDrift: 1.0 / 60, // +/- deg per second
    gyroNoise: 0.1, // deg
    matGrip: 0.1, // +/- fraction
    startPos: 0.4, startAngle: 0.8, // how precisely the robot gets placed (cm, deg)
    reflectionNoise: 2, distanceNoise: 0.5,
  };
  const START = { x: 36, y: 97, h: 90 }; // in the left launch area, facing east
  // Hub ports, as on a SPIKE Prime driving base. Drive motors are mirrored: driving forward turns
  // the left motor (A) counterclockwise and the right motor (B) clockwise.
  const PORTS = {}; // hub port -> what is plugged into it, for the robot that is built (see applyBuild)
  const ARM = { closeAt: 45, min: -5, max: 95, accel: 8000 }; // basket gate on motor C (degrees)

  // Hub light matrix: 5x5 images and a 3x5 font for scrolling text (rows top to bottom, 1 = lit).
  const HUB_IMAGES = {
    heart: '01010 11111 11111 01110 00100', happy: '00000 01010 00000 10001 01110', sad: '00000 01010 00000 01110 10001',
    yes: '00000 00001 00010 10100 01000', no: '10001 01010 00100 01010 10001', 'arrow up': '00100 01110 10101 00100 00100',
    square: '11111 10001 10001 10001 11111', diamond: '00100 01010 10001 01010 00100', target: '11111 10001 10101 10001 11111',
    butterfly: '11011 11111 00100 11111 11011', ghost: '01110 10101 11111 11111 10101', skull: '01110 10101 11111 01110 01110',
  };
  const FONT = {
    A: '010 101 111 101 101', B: '110 101 110 101 110', C: '011 100 100 100 011', D: '110 101 101 101 110', E: '111 100 110 100 111',
    F: '111 100 110 100 100', G: '011 100 101 101 011', H: '101 101 111 101 101', I: '111 010 010 010 111', J: '001 001 001 101 010',
    K: '101 101 110 101 101', L: '100 100 100 100 111', M: '101 111 111 101 101', N: '110 101 101 101 101', O: '010 101 101 101 010',
    P: '110 101 110 100 100', Q: '010 101 101 110 011', R: '110 101 110 101 101', S: '011 100 010 001 110', T: '111 010 010 010 010',
    U: '101 101 101 101 111', V: '101 101 101 101 010', W: '101 101 111 111 101', X: '101 101 010 101 101', Y: '101 101 010 010 010',
    Z: '111 001 010 100 111', 0: '111 101 101 101 111', 1: '010 110 010 010 111', 2: '110 001 010 100 111', 3: '110 001 010 001 110',
    4: '101 101 111 001 001', 5: '111 100 110 001 110', 6: '011 100 111 101 111', 7: '111 001 010 010 010', 8: '111 101 111 101 111',
    9: '111 101 111 001 110', ' ': '000 000 000 000 000', '!': '010 010 010 000 010', '?': '110 001 010 000 010', '.': '000 000 000 000 010',
    '-': '000 000 111 000 000', ':': '000 010 000 010 000', '+': '000 010 111 010 000',
  };
  const SCROLL_COLS_PER_SEC = 10;
  // Built-in sounds as note sequences: [midi note, seconds] (0 = rest).
  const SOUNDS = {
    Beep: [[72, 0.15]], Chime: [[84, 0.12], [88, 0.12], [91, 0.3]], Cheer: [[72, 0.1], [76, 0.1], [79, 0.1], [84, 0.35]],
    Win: [[67, 0.12], [72, 0.12], [76, 0.12], [79, 0.12], [84, 0.4]], Lose: [[67, 0.2], [63, 0.2], [60, 0.45]],
    Hello: [[76, 0.12], [0, 0.04], [79, 0.2]], Teleport: [[60, 0.05], [67, 0.05], [72, 0.05], [79, 0.05], [84, 0.05], [91, 0.15]],
    Laser: [[96, 0.06], [91, 0.06], [86, 0.06], [81, 0.06], [76, 0.1]],
  };
  const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const DT = 0.02;
  const SUBSTEPS = 4; // physics runs at 200 Hz inside each DT
  const MATCH_TIME = 150;
  const LINE_HALF_WIDTH = 1.0;

  // Motion control (what the program asks the motors to do).
  // Planned slow-down for drives and turns follows the robot's acceleration setting.
  const planDecel = (sim) => sim.robot.accelCm * 0.8;
  const turnDecel = (sim) => sim.robot.accelCm * 0.5; // spinning a loaded robot stops slower than driving
  const MIN_SPEED = 1.5; // cm/s creep speed on final approach
  const DRIVE_TOL = 0.05; // cm of encoder travel
  const TURN_TOL = 0.1; // degrees of gyro
  const HEADING_HOLD = 0.6; // cm/s of steering per degree of gyro error while driving

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  // ---- field geometry (authored in mat cm from the wireframe, stored in table cm) ----
  const T = ([x, y]) => [x + MAT_RECT.x, y + MAT_RECT.y];
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(T);
  const box = (cx, cy, w, h, a) => {
    const c = Math.cos(rad(a)), s = Math.sin(rad(a));
    return [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
      .map(([u, v]) => T([cx + u * c - v * s, cy + u * s + v * c]));
  };
  const circ = (cx, cy, r) => Array.from({ length: 12 }, (_, i) =>
    T([cx + r * Math.cos((i / 12) * Math.PI * 2), cy + r * Math.sin((i / 12) * Math.PI * 2)]));
  const N = [0, -1], S = [0, 1], E = [1, 0], W = [-1, 0], SW = [-0.707, 0.707], SE = [0.707, 0.707];

  // pads: the parts of a model the robot pushes. `face` is the side the pad sits on and `at` where along
  // that side (-1..1), `travel` how far it goes in (cm) and `force` how hard it is to push (newtons).
  // 'latch' parts stay where the robot leaves them (one way, like the real models); their progress is
  // the furthest they were pushed. 'spring' parts spring back out and count full strokes.
  const latch = (key, face, travel, force, extra) => Object.assign({ key, face, travel, force, kind: 'latch' }, extra);
  // 'lift' parts are worked by a handle the robot can't just push: an attachment has to get under it and
  // lift it with a motor. `h` is the handle's underside above the mat, `rise` how far it has to go up
  // (cm), `reach` how far it sticks out of the model. They stay up (ratchets and catches hold them).
  const lift = (key, face, h, rise, extra) => Object.assign({ key, face, h, rise, reach: 1.6, kind: 'lift' }, extra);
  // 'pull' parts have a handle (a red bar `w` wide, `out` cm in front of the model, `zb` cm up) that only
  // moves outwards, `travel` cm: something has to hook behind it (between it and the model) and back away.
  const pull = (key, face, zb, travel, extra) => Object.assign({ key, face, zb, travel, out: 1.6, r: 0.5, w: 3, kind: 'pull' }, extra);
  // Push parts sit where the real part is: `out` is how far its front sticks out of the model before it
  // is pushed (at least `travel`, or the robot couldn't push it all the way), `zb` the handle's height.

  // M01 drone rig, as built from the official instructions (bags 1 and 2). Each of the four legs is a
  // black 32L Technic axle with an axle-and-pin connector on both ends, so it is rigid: 25.6 cm of axle
  // plus 0.4 cm out to each pin hole. Both legs on a side share one tan 3L pin on the drone, so the rig is
  // a two-bar linkage that folds up at the drone when the anchor comes closer to the pilot, and the
  // pilot's 4x4 turntable lets the whole rig swing around. Heights are pin centres above the mat (cm).
  const DRONE = {
    leg: 26.4,
    pilotPin: 2.5, // 8x8 round plate, turntable (2 plates), 6x6 round plate, 2x4 plate, 1x2 plate, Technic brick hole
    anchorPin: 1.22, // 2x2 round plate feet, 4x6 plate, Technic brick hole
    restPin: 4.1, // drone resting on its two trans-clear 2x2 bricks: 2 bricks, 2 plates, 1 brick, hole
    // pin connectors either side of the centre line: the anchor's and the pilot's pins stick out of
    // 4-stud wide bodies; the drone's of a 1x6, the anchor legs next to the brick and the pilot legs outside them
    pilotSide: 2.0, anchorSide: 2.0, droneInner: 2.8, droneOuter: 3.6,
    mass: 0.024, legMass: 0.004, // kg
    turntable: 0.01 * 1e4, // friction torque of the turntable, N*m -> kg*cm^2/s^2
  };
  // in-plane reach of each leg pair (its two pin connectors sit 0.8 cm apart sideways)
  DRONE.reachP = Math.sqrt(DRONE.leg ** 2 - (DRONE.droneOuter - DRONE.pilotSide) ** 2);
  DRONE.reachA = Math.sqrt(DRONE.leg ** 2 - (DRONE.droneInner - DRONE.anchorSide) ** 2);
  // furthest the anchor's pin can be from the pilot's: the legs lie as flat as the resting drone lets them
  DRONE.span = Math.sqrt(DRONE.reachP ** 2 - (DRONE.restPin - DRONE.pilotPin) ** 2) + Math.sqrt(DRONE.reachA ** 2 - (DRONE.restPin - DRONE.anchorPin) ** 2);
  DRONE.closest = 6; // the anchor up against the pilot
  // Where the drone's pin is with the anchor's pin `d` cm from the pilot's: x along the rig from the
  // pilot and h above the mat. The legs are circles about the two end pins; the drone is where they cross.
  function droneApex(d) {
    const dy = DRONE.anchorPin - DRONE.pilotPin, dist = Math.hypot(d, dy);
    const ux = d / dist, uy = dy / dist;
    const a = (DRONE.reachP ** 2 - DRONE.reachA ** 2 + dist * dist) / (2 * dist);
    const k = Math.sqrt(Math.max(0, DRONE.reachP ** 2 - a * a));
    const h = DRONE.pilotPin + a * uy + k * ux;
    if (h <= DRONE.restPin) return { x: Math.sqrt(DRONE.reachP ** 2 - (DRONE.restPin - DRONE.pilotPin) ** 2), h: DRONE.restPin, lift: 0 };
    return { x: a * ux - k * uy, h, lift: h - DRONE.restPin };
  }

  const MAT = {
    rect: MAT_RECT,
    home: [{ x: 0, y: 0, w: MAT_RECT.x, h: FIELD.h }, { x: MAT_RECT.x + MAT_RECT.w, y: 0, w: FIELD.w - MAT_RECT.x - MAT_RECT.w, h: FIELD.h }],
    launch: [
      { cx: MAT_RECT.x, cy: FIELD.h, r: 48, color: '#e4252b' },
      { cx: MAT_RECT.x + MAT_RECT.w, cy: FIELD.h, r: 48, color: '#1f6fc6' },
    ],
    lines: [
      [[46.4, 32.6], [51.3, 24.2], [76, 24.2]],
      [[133, 16.6], [143.3, 26.5], [168.5, 26.5]],
      [[94.2, 72.1], [100.9, 83.2]],
    ].map((l) => l.map(T)),
    surveyArea: box(105.15, 91.35, 7, 7, 30),
    docks: {
      mine: [[181.8, 11.4], [189.2, 3.3], [195.9, 9.2], [187.7, 17.3]].map(T),
      farm: rect(95.3, 44.3, 104.7, 58),
      city: rect(123.5, 98, 132.3, 111.6),
    },
    models: [
      // M01: the drone sits on rigid legs between the pilot and the red cable anchor (see DRONE). Push the
      // anchor towards the pilot and the legs fold up, lifting the drone; push it on into the LiDAR's
      // handle to flip the map.
      { id: 'pilot', mission: 1, name: 'drone launcher', shape: circ(115.1, 108.3, 3.3), h: 9 },
      { id: 'lidar', mission: 1, name: 'LiDAR map', shape: box(105.15, 91.35, 7.5, 5.5, 30), h: 6, pads: [latch('flip', SW, 2.2, 1.2, { at: 0.53, w: 1.4, out: 2.5, zb: 3.2, label: 'LiDAR map flipped over' })] }, // its push handle, on the left of the front
      { id: 'seedpod', mission: 2, name: 'seed pod', shape: box(63.65, 59.95, 4.8, 4.8, 45), h: 16 }, // its seeds hang off the ends of the tubes
      { id: 'rock', mission: 3, name: 'rock', shape: rect(1.2, 45.1, 14, 51.4), h: 9, pads: [{ key: 'flip', face: E, travel: 2, force: 2, kind: 'spring', steps: 2, at: 0.7, w: 1.6, out: 2.3, zb: 1.2, label: 'research flag' }] }, // the red research flag at the front corner
      { id: 'nest', mission: 4, name: 'nest', shape: rect(6, 6, 17.5, 17.5), h: 7 },
      { id: 'roots', mission: 5, name: 'plant root', shape: rect(38.3, 0.6, 42.4, 9.3), h: 13, pads: [latch('extend', S, 3, 1.5, { w: 2.4, out: 3.3, zb: 4 })] },
      { id: 'leafcutter', mission: 6, name: 'ant nest', shape: rect(146.1, 0.6, 153.9, 12.3), h: 9, pads: [latch('ant', S, 2.5, 0.8, { at: -0.96, w: 2.4, out: 2.8, look: 'ant', label: 'Ant touching the nest' })] }, // the ant itself, on its rack
      { id: 'fungus', mission: 7, name: 'mycelium', shape: rect(153.9, 0.6, 161.7, 12.3), h: 11, pads: [pull('extend', S, 1.0, 3, { at: 0.26, w: 3.2, label: 'Mycelium completely extended', handle: 'red handle of the mycelium' })] },
      { id: 'vine', mission: 8, name: 'tree', shape: rect(50.1, 1.4, 57.7, 14.3), h: 26 }, // the vine is hooked and pulled down
      { id: 'platform', mission: 9, name: 'research tree', shape: rect(57.7, 1.4, 65.3, 14.3), h: 17, pads: [
        lift('raise', S, 1.5, 1.5, { at: -0.72, w: 2.4, label: 'Research platform raised', handle: 'red ball handle' }), // book 7 step 63
        latch('camera', S, 1.5, 1.5, { at: 1, w: 1.4, out: 1.8, zb: 6, label: 'Camera trap deployed' }), // the red lever on the trunk
      ] },
      { id: 'spider', mission: 10, name: 'snail habitat', shape: rect(72.9, 6.7, 76.8, 11.2), h: 9, loose: { mass: 0.04 } },
      { id: 'snail', mission: 10, name: 'spider habitat', shape: rect(102.5, 40, 106.5, 43.5), h: 7, loose: { mass: 0.03 } },
      { id: 'window', mission: 11, name: 'root window', shape: box(140.7, 54.6, 7.8, 7.8, 45), h: 12, pads: [pull('cover', SW, 2.7, 2.5, { at: 0.45, w: 2.4, out: 0.8, look: 'model', label: 'Root cover down', handle: 'bar handle of the root cover' })] }, // it falls open when pulled
      { id: 'elder', mission: 12, name: 'forest elder', shape: circ(193.85, 38.3, 3.2), h: 24, pads: [lift('cane', W, 1.2, 1.5, { w: 3, label: 'Cane raised', handle: 'cane' })] },
      { id: 'post', mission: 12, name: 'post', shape: rect(192.6, 56.4, 195, 62.4), h: 6, ringable: true }, // the support tie drops over it
    ],
    // Loose models. The keystone species starts in the launch area; the others start on mission models
    // (`on`) and come loose when the robot completes that part of the mission. `hook` pieces can be
    // lifted off with the basket from above the model, `knock` pieces fall off when the robot hits them,
    // and `tether` pieces stay tied to a model by a cable or chain.
    items: [
      { id: 'keystone', type: 'keystone', x: 48.5, y: 97, r: 2.5, mass: 0.03 },
      // laid out with the legs flat and the drone resting on the mat; 4x6 studs, long side along the rig
      { id: 'anchor', type: 'anchor', x: 115.1 - DRONE.span + MAT_RECT.x, y: 108.3 + MAT_RECT.y, r: 2.2, size: [4.8, 3.2], mass: 0.022 },
      { id: 'seed1', type: 'seed', on: 'seedpod', knock: true, r: 1.4, mass: 0.005 },
      { id: 'seed2', type: 'seed', on: 'seedpod', knock: true, r: 1.4, mass: 0.005 },
      { id: 'seed3', type: 'seed', on: 'seedpod', knock: true, r: 1.4, mass: 0.005 },
      { id: 'seed4', type: 'seed', on: 'platform', knock: true, r: 1.3, mass: 0.004 }, // hangs on the tree until knocked off
      { id: 'leaf1', type: 'leaf', on: 'nest', hook: true, r: 1.6, mass: 0.004 },
      { id: 'leaf2', type: 'leaf', on: 'nest', hook: true, r: 1.6, mass: 0.004 },
      { id: 'katydid', type: 'katydid', on: 'nest', hook: true, r: 1.4, mass: 0.004 },
      { id: 'vineEnd', type: 'vine', on: 'vine', hook: true, hookWidth: 3.5, r: 1.5, mass: 0.01, tether: 'vine', len: 20 },
      { id: 'tie', type: 'tie', on: 'elder', hook: true, hookWidth: 3.5, r: 1.8, mass: 0.01, tether: 'elder', len: 40 },
      { id: 'frag1', type: 'fragment', on: 'leafcutter', r: 0.8, mass: 0.002 },
      { id: 'frag2', type: 'fragment', on: 'leafcutter', r: 0.8, mass: 0.002 },
      { id: 'frag3', type: 'fragment', on: 'leafcutter', r: 0.8, mass: 0.002 },
      { id: 'frag4', type: 'fragment', on: 'leafcutter', r: 0.8, mass: 0.002 },
    ],
  };

  // Interchangeable models (missions 13-15) can sit on any dock. Their pads face the open field
  // (`side` front), or the sides to its left or right.
  const DOCK_MODELS = {
    13: { id: 'restoration', name: 'restoration platform', h: 12 }, // the young trees rise when the keystone lands on it
    14: { id: 'replant', name: 'replantation station', h: 10 },
    // The building's three features are on different sides, so each needs its own approach.
    15: { id: 'building', name: 'biocentric building', h: 14, pads: [
      lift('canopy', null, 1.8, 1.5, { side: 'front', w: 4, label: 'Nesting canopy raised', handle: 'crank handle' }), // book 13 steps 20-30
      latch('skylight', null, 2.4, 1.5, { side: 'left', w: 4, out: 2.8, zb: 4.5, label: 'Garden skylight completely in' }),
      pull('hatch', null, 2.2, 2.5, { side: 'right', w: 3.2, out: 1.4, look: 'flap', label: 'Compost hatch opened', handle: 'red handle of the compost hatch' }), // it swings down to the mat
    ] },
  };
  const DEFAULT_DOCKS = { mine: 15, city: 14, farm: 13 };
  const DOCK_NEED = { mine: 'canopy', city: 'skylight', farm: 'hatch' };
  const FEATURES = { canopy: 'Nesting canopy raised', skylight: 'Garden skylight completely in', hatch: 'Compost hatch completely opened, touching the mat' };
  const DONE = 0.9; // a latch part counts once it is pushed this far (fraction of its travel)
  const RING_CATEGORY = 0x0002; // the M12 post: the support tie drops over it instead of bumping it
  const RIG_CATEGORY = 0x0004, ROBOT_CATEGORY = 0x0008; // the M01 drone and legs only get in the robot's way
  const ROBOT_HIGH_CATEGORY = 0x0040; // attachment parts 3 cm or more up: they pass over loose pieces
  // Collisions by height (planck is flat): model parts 3 cm or more up let low loose pieces pass under
  // them, and parts 4 cm or more up also let the robot's attachment (the basket, hook or pusher, all
  // under 4 cm tall) reach under them; only the taller body bumps into those.
  const OVERHANG_CATEGORY = 0x0010, HIGH_CATEGORY = 0x0020;
  const OVERHANG_HEIGHT = 3, ATTACHMENT_HEIGHT = 4;
  // At ground level the official footprints win: where a 3D model's base looks bigger than its footprint,
  // the model drawing is what's off. Outlines only add the parts that stick out higher up.
  const BASE_LEVEL = 1;
  const HOOK_WIDTH = 1.5; // cm either side of the basket's centre line that can hook a hanging piece (M04)
  const SCATTER_SPEED = 14; // cm/s: pushing the ant faster than this shakes leaf fragments loose (M06)
  // Missions with the No Equipment Constraint: their models score nothing while touching the robot.
  const NO_EQUIPMENT = new Set([1, 4, 5, 7, 9, 10, 12, 15]);

  // Official BIOGLOW mission conditions and points. `ok` / `count` read the model state.
  const MISSIONS = [
    { n: 0, name: 'Equipment Inspection', conds: [{ label: 'Robot and equipment fit completely in one launch area, under 30.5 cm', pts: 20, ok: (s) => s.inspection().ok }] },
    { n: 0, name: 'Precision Tokens', conds: [{ label: 'Precision tokens left', pts: 50, points: (s) => TOKEN_POINTS[s.tokens()], tokens: true }] },
    { n: 1, name: 'Drone Survey', conds: [
      { label: 'Drone no longer touching the mat', pts: 20, ok: (s) => s.droneUp() },
      { label: 'Bonus: and the LiDAR map completely flipped over, scan marker in the survey area', pts: 10, ok: (s) => s.droneUp() && s.done('lidar', 'flip') },
    ] },
    { n: 2, name: 'Exploding Seeds', conds: [{ label: 'Seeds no longer touching the stalk', each: 10, max: 3, count: (s) => s.released('seedpod') }] },
    { n: 3, name: 'Flip the Rock', conds: [
      { label: 'Research flag down', pts: 20, ok: (s) => s.strokes('rock', 'flip') >= 1 },
      { label: 'Bonus: and the rock returned to its original position', pts: 10, ok: (s) => s.strokes('rock', 'flip') >= 2 },
    ] },
    { n: 4, name: 'Lucky Leaves', conds: [
      { label: 'One leaf completely removed, no longer touching the nest', pts: 10, ok: (s) => s.leavesOut() >= 1 && s.katydidInHabitat() },
      { label: 'Bonus: and the second leaf removed, katydid in its original position', pts: 20, ok: (s) => s.leavesOut() >= 2 && s.katydidUndisturbed() },
    ] },
    { n: 5, name: 'Reaching Roots', conds: [
      { label: 'Plant root partially extended', pts: 10, ok: (s) => s.progress('roots', 'extend') >= 0.4 && s.progress('roots', 'extend') < DONE },
      { label: 'Plant root completely extended', pts: 20, ok: (s) => s.done('roots', 'extend') },
    ] },
    { n: 6, name: 'Leafcutter Frenzy', conds: [{ label: 'Ant touching the nest, leaf fragments contained in the nest', each: 10, max: 4, count: (s) => (s.done('leafcutter', 'ant') ? s.stillOn('leafcutter') : 0) }] },
    { n: 7, name: 'Humongous Fungus', conds: [
      { label: 'Mycelium completely extended', pts: 20, ok: (s) => s.done('fungus', 'extend') },
      { label: 'Bonus: connection with the opposing team\u2019s plant root (needs an opposing team)', pts: 10, unavailable: true, ok: () => false },
    ] },
    { n: 8, name: 'Tangled', conds: [{ label: 'Vine touching the mat', pts: 30, ok: (s) => s.released('vine') >= 1 }] },
    { n: 9, name: 'Research Platform', conds: [
      { label: 'Research platform raised', pts: 10, ok: (s) => s.done('platform', 'raise') },
      { label: 'Camera trap deployed', pts: 10, ok: (s) => s.done('platform', 'camera') },
      { label: 'Seed no longer touching the tree', pts: 10, ok: (s) => s.released('platform') >= 1 },
    ] },
    { n: 10, name: 'Fragile Microhabitats', conds: [
      { label: 'Spider habitat in its original starting position', pts: 10, ok: (s) => !s.touched('snail') },
      { label: 'Snail habitat in its original starting position', pts: 10, ok: (s) => !s.touched('spider') },
    ] },
    { n: 11, name: 'Window to the Past', conds: [{ label: 'Root cover down, touching the mat', pts: 20, ok: (s) => s.done('window', 'cover') }] },
    { n: 12, name: 'Forest Elder', conds: [
      { label: 'Cane completely raised, touching the tree', pts: 20, ok: (s) => s.done('elder', 'cane') },
      { label: 'Support tie around the post', pts: 10, ok: (s) => s.tieOnPost() },
    ] },
    { n: 13, name: 'Keystone Species', conds: [{ label: 'Keystone species on the restoration platform, and the young trees raised', pts: 30, ok: (s) => s.delivered('keystone', 13) > 0 }] },
    { n: 14, name: 'Seeds of Renewal', conds: [
      { label: 'Seeds contained within the replantation station', each: 5, max: 4, count: (s) => s.delivered('seed', 14) },
      { label: 'Bonus: and touching the mat', each: 5, max: 4, count: (s) => s.delivered('seed', 14, true) },
    ] },
    { n: 15, name: 'Biocentric Architecture', conds: ['canopy', 'skylight', 'hatch'].map((f) => (
      { label: FEATURES[f], pts: 10, ok: (s) => s.done('building', f) }
    )).concat([{ label: 'Environmental bonus for its dock', pts: 10, ok: (s) => s.done('building', DOCK_NEED[s.dockOf(15)]) }]) },
  ];

  // SPIKE colour sensor categories from an RGB sample.
  function classifyRGB(r, g, b) {
    const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255;
    const v = mx, s = mx === 0 ? 0 : (mx - mn) / mx;
    if (v < 0.22) return 'black';
    if (s < 0.22) return v > 0.62 ? 'white' : 'black';
    let hue;
    const d = mx - mn, R = r / 255, G2 = g / 255, B = b / 255;
    if (mx === R) hue = 60 * (((G2 - B) / d) % 6);
    else if (mx === G2) hue = 60 * ((B - R) / d + 2);
    else hue = 60 * ((R - G2) / d + 4);
    hue = (hue + 360) % 360;
    if (hue < 15 || hue >= 340) return 'red';
    if (hue < 70) return 'yellow';
    if (hue < 165) return 'green';
    if (hue < 205) return 'azure';
    if (hue < 255) return 'blue';
    if (hue < 290) return 'violet';
    return 'magenta';
  }

  // The attachment's solid parts as boxes: centre (u forward of the robot centre, v to the right) and size.
  // Attachments that swing (ROBOT.swing.shape) have boxes that follow the motor instead (Sim.attBoxes).
  function attachmentBoxes() {
    const L = ROBOT.length / 2, W2 = ROBOT.width / 2, R = ROBOT.basket;
    if (ROBOT.attachment === 'pusher') return [{ u: L + R / 2, v: 0, du: R, dv: ROBOT.width }];
    if (ROBOT.attachment === 'hook') return [{ u: L + R / 2, v: 0, du: R, dv: 1.2 }];
    return [-1, 1].map((side) => ({ u: L + R / 2, v: side * (W2 - 0.4), du: R, dv: 0.8 }));
  }

  // ---- attachments in 3D -----------------------------------------------------------
  // An attachment is a rigid part that can swing on a motor's axle. Its points are [u, v, z] about the
  // axle (u forward, v to the right, z up); the axle sits at `spot` on the robot (u forward of the
  // robot's centre, z above the mat; `back` mounts face backwards). The swing angle in degrees (+ lifts
  // the far end) comes from the motor's position. `lifters` are the points that can get under a handle
  // and lift it (M09, M12, M15); `shape` (when there is one) is the whole part, for collisions.
  const bits = (m, i, k) => m.bits.charCodeAt(k * m.w + i) === 49;
  // A photo attachment as cubes `cell` cm across: where the outline from the side and the outline from
  // above are both solid. Side grid: u across (the far end on the right), z up (row 0 at the top).
  // Top grid: u across, v down (row 0 on the robot's left). Both grids are `w` cells long.
  function attachmentVoxels(def, step) {
    const side = def.side, top = def.top, n = step || 1, cell = def.cell * n;
    const w = Math.min(side.w, top.w), out = [];
    const [pi, pk] = def.pivot || [0, side.h / 2];
    for (let i = 0; i < w; i += n) {
      for (let k = 0; k < side.h; k += n) {
        let s = false;
        for (let a = 0; a < n && !s; a++) for (let b = 0; b < n && !s; b++) if (i + a < w && k + b < side.h && bits(side, i + a, k + b)) s = true;
        if (!s) continue;
        for (let j = 0; j < top.h; j += n) {
          let t = false;
          for (let a = 0; a < n && !t; a++) for (let b = 0; b < n && !t; b++) if (i + a < w && j + b < top.h && bits(top, i + a, j + b)) t = true;
          if (t) out.push([i / n, j / n, k / n]);
        }
      }
    }
    const at = ([i, j, k]) => [(i * n + n / 2 - pi) * def.cell, (j * n + n / 2 - top.h / 2) * def.cell + (def.shift || 0), (pk - k * n - n / 2) * def.cell];
    return { cells: out, count: out.length, cell, at };
  }

  // Where each attachment motor's axle is on the robot that is built.
  function mountSpot(job) {
    const L = ROBOT.length / 2;
    if (ROBOT.model === 'adb') return job === 'spare' ? { u: -(L - 2.8), z: 4.4, back: true } : { u: L - 3.6, z: 4.0 };
    return job === 'spare' ? { u: -(L - 2), z: 8.2, back: true } : { u: L - 2, z: 8.2 };
  }

  function makeSwing(attachment) {
    const L = ROBOT.length / 2, W2 = ROBOT.width / 2, R = ROBOT.basket;
    const a = ATTACHMENTS[attachment];
    if (a.custom) return customSwing(a.custom);
    // the basket's gate and the hook hang from an axle at the front, 3.6 cm up: closed (motor C at 90
    // degrees) they hang straight down, and opening swings them up and back over the axle
    const gateAngle = (pos) => -(90 - clamp(pos, 0, 90));
    if (attachment === 'basket') {
      const pts = [];
      for (let v = -W2 + 1; v <= W2 - 1; v += 1) pts.push([0, v, -1.6]);
      return { job: 'arm', spot: { u: L + R, z: 3.6 }, angle: gateAngle, lifters: pts };
    }
    if (attachment === 'hook') return { job: 'arm', spot: { u: L + R, z: 3.6 }, angle: gateAngle, lifters: [[0.5, -0.6, -2.6], [0.5, 0, -2.6], [0.5, 0.6, -2.6]] };
    if (attachment === 'lifter') {
      // two prongs from an axle 6.4 cm up near the front of the body, their flat ends 0.6 cm above the mat
      const len = R + 1.5, drop = Math.asin((6.4 - 0.6) / len), pts = [];
      for (let d = 0; d <= len + 1e-6; d += 0.8) for (const v of [-2.8, -2.0, 2.0, 2.8]) pts.push([d * Math.cos(drop), v, -d * Math.sin(drop)]);
      const tips = pts.filter(([u]) => u >= (len - 3.5) * Math.cos(drop));
      return { job: 'arm', spot: { u: L - 1.5, z: 6.4 }, angle: (pos) => pos, range: [-2, 75], lifters: tips, shape: pts };
    }
    return null; // the pusher doesn't move
  }

  // A photo attachment: on a motor, its axle (def.pivot) goes on that motor's axle; fixed ones are
  // bolted to the front with their back edge against the bumper and their lowest point just above the mat.
  function customSwing(def) {
    const vox = attachmentVoxels(def, 2);
    const pts = vox.cells.map(vox.at);
    // only the outside matters for collisions and lifting
    const filled = new Set(vox.cells.map(([i, j, k]) => i + ',' + j + ',' + k));
    const surface = vox.cells.filter(([i, j, k]) => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([a, b, c]) => !filled.has((i + a) + ',' + (j + b) + ',' + (k + c)))).map(vox.at);
    const fixed = def.mount === 'fixed';
    let spot;
    if (fixed) {
      const minU = Math.min(...pts.map((p) => p[0])), minZ = Math.min(...pts.map((p) => p[2]));
      spot = { u: ROBOT.length / 2 - 0.3 - minU, z: (def.lift !== undefined ? def.lift : 0.4) - minZ };
    } else spot = mountSpot(def.mount);
    const k = (def.dir || 1) * (def.ratio || 1);
    const sw = { job: fixed ? null : def.mount, spot, lifters: surface, shape: surface, custom: true, start: 0, angle: (pos) => sw.start + k * pos };
    if (fixed) { sw.angle = () => 0; return sw; }
    // as fitted on the robot: turned from the photo by `start` degrees, or (by default) the least turn
    // that keeps it off the mat
    const low = (deg) => Math.min(...swingPoints(sw, surface, deg).map((p) => p[2]));
    if (def.start !== undefined) sw.start = def.start;
    else {
      for (let d = 0; d <= 180; d += 2) {
        if (low(d) >= 0.3) { sw.start = d; break; }
        if (low(-d) >= 0.3) { sw.start = -d; break; }
      }
    }
    // the motor can turn it until it hits the mat or the robot (parts already over the robot as it
    // starts, and those near the axle, don't count)
    const L = ROBOT.length / 2, W2 = ROBOT.width / 2;
    const inBody = ([u, v, z]) => Math.abs(u) < L && Math.abs(v) < W2 && z > 0 && z < ROBOT.height + 0.3;
    const far = surface.filter(([u, , z]) => Math.hypot(u, z) > 3);
    const startIn = swingPoints(sw, far, sw.start).map(inBody);
    const free = (deg) => low(deg) >= 0 && !swingPoints(sw, far, deg).some((p, i) => !startIn[i] && inBody(p));
    let lo = 0, hi = 0;
    while (lo > -270 && free(sw.start + lo - 2)) lo -= 2;
    while (hi < 270 && free(sw.start + hi + 2)) hi += 2;
    sw.range = [lo / k, hi / k].sort((a, b) => a - b);
    if (Math.abs(k) < 1e-6) sw.range = null;
    return sw;
  }

  // An attachment's points turned to `deg` and put on the robot: [u, v, z] in robot coordinates.
  function swingPoints(sw, pts, deg) {
    const c = Math.cos(rad(deg)), s = Math.sin(rad(deg)), m = sw.spot.back ? -1 : 1;
    return pts.map(([u, v, z]) => [sw.spot.u + m * (u * c - z * s), m * v, sw.spot.z + u * s + z * c]);
  }

  // Collision boxes for an attachment's points in robot coordinates: slices 1 cm long, split where
  // there is a gap across, low (under 3 cm, they hit loose pieces too) and high. The chassis covers
  // what is inside the body.
  function footprintOf(pts) {
    const L = ROBOT.length / 2, W2 = ROBOT.width / 2, bins = new Map();
    for (const [u, v, z] of pts) {
      if (z > MAX_HEIGHT || z < -0.5) continue;
      if (Math.abs(u) < L - 0.3 && Math.abs(v) < W2 - 0.3) continue;
      const key = Math.floor(u) + ':' + (z < OVERHANG_HEIGHT ? 0 : 1);
      if (!bins.has(key)) bins.set(key, []);
      bins.get(key).push(v);
    }
    const boxes = [];
    for (const [key, vs] of bins) {
      const [u0, band] = key.split(':').map(Number);
      vs.sort((a, b) => a - b);
      let start = vs[0];
      for (let i = 1; i <= vs.length; i++) {
        if (i < vs.length && vs[i] - vs[i - 1] < 1.3) continue;
        const end = vs[i - 1];
        boxes.push({ u: u0 + 0.5, v: (start + end) / 2, du: 1, dv: end - start + 0.8, high: band === 1 });
        if (i < vs.length) start = vs[i];
      }
    }
    return boxes.slice(0, 160);
  }

  function robotPoly(p, grow) {
    const g = grow || 0;
    const L = ROBOT.length / 2 + g, W2 = ROBOT.width / 2 + g;
    const fx = Math.sin(rad(p.h)), fy = -Math.cos(rad(p.h));
    const rx = Math.cos(rad(p.h)), ry = Math.sin(rad(p.h));
    return [[L, -W2], [L, W2], [-L, W2], [-L, -W2]].map(([a, b]) => [
      p.x + fx * a + rx * b,
      p.y + fy * a + ry * b,
    ]);
  }

  function closestOnSegment(px, py, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : clamp(((px - a[0]) * dx + (py - a[1]) * dy) / len2, 0, 1);
    return [a[0] + t * dx, a[1] + t * dy];
  }

  function distToSegment(px, py, a, b) {
    const [cx, cy] = closestOnSegment(px, py, a, b);
    return Math.hypot(px - cx, py - cy);
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // Distance from a point to a polygon's outline (0 if inside).
  function polyDistance(x, y, poly) {
    if (pointInPoly(x, y, poly)) return 0;
    let best = Infinity;
    for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSegment(x, y, poly[i], poly[(i + 1) % poly.length]));
    return best;
  }

  // True when two polygons overlap or come within `gap` of each other.
  function polysTouch(a, b, gap) {
    for (const [x, y] of a) if (polyDistance(x, y, b) <= gap) return true;
    for (const [x, y] of b) if (polyDistance(x, y, a) <= gap) return true;
    // two thin shapes can cross with no corner inside the other
    const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      const p1 = a[i], p2 = a[(i + 1) % a.length], q1 = b[j], q2 = b[(j + 1) % b.length];
      if (cross(p1, p2, q1) * cross(p1, p2, q2) < 0 && cross(q1, q2, p1) * cross(q1, q2, p2) < 0) return true;
    }
    return false;
  }

  const centroid = (poly) => [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  // A footprint's own frame, as the 3D models are built in it: centre, and the angle of its first edge (round ones: 0).
  const footprintFrame = (shape) => {
    const [cx, cy] = centroid(shape);
    return { cx, cy, ang: shape.length > 4 ? 0 : Math.atan2(shape[1][1] - shape[0][1], shape[1][0] - shape[0][0]) };
  };

  // Where a model's push plate sits: the polygon edge facing `dir`.
  function plateSpot(shape, dir, at) {
    const spot = faceSpot(shape, dir);
    if (at) { // slide along the face: tangent is the normal turned 90 degrees
      const k = at * spot.len * 0.5 * 0.8;
      spot.mx += -spot.ny * k; spot.my += spot.nx * k;
    }
    return spot;
  }
  function faceSpot(shape, dir) {
    const [cx, cy] = centroid(shape);
    if (shape.length > 4) { // round base
      const r = Math.hypot(shape[0][0] - cx, shape[0][1] - cy);
      return { mx: cx + dir[0] * r, my: cy + dir[1] * r, nx: dir[0], ny: dir[1], len: r * 1.6 };
    }
    let best = null;
    for (let i = 0; i < shape.length; i++) {
      const a = shape[i], b = shape[(i + 1) % shape.length];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      let nx = mx - cx, ny = my - cy;
      const ex = b[0] - a[0], ey = b[1] - a[1], len = Math.hypot(ex, ey);
      // outward edge normal
      let ux = ey / len, uy = -ex / len;
      if (ux * nx + uy * ny < 0) { ux = -ux; uy = -uy; }
      const score = ux * dir[0] + uy * dir[1];
      if (!best || score > best.score) best = { score, mx, my, nx: ux, ny: uy, len };
    }
    return best;
  }

  // Small seeded random generator so a "variation" run can be repeated.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const noop = () => {};

  class Sim {
    constructor() {
      this.token = null;
      this.manual = { f: 0, t: 0 };
      this.onLog = noop;
      this.onHub = noop; // hub light matrix / centre button changed
      this.onSound = noop; // (frequencyHz, seconds) or (0, 0) to stop
      this.docks = { ...DEFAULT_DOCKS };
      this.matPixels = null;
      this.variation = false; // real-world imperfections off by default
      this.seed = 1;
      this.battery = 1; // hub battery charge, 0..1
      this.build = normalizeBuild();
      applyBuild(this.build);
      this.faults = normalizeFaults();
      this.launch = { ...START }; // where the team places the robot in a launch area
      this.reset();
    }

    // Colour sensor reads the real mat artwork when the app provides it (RGBA, row-major).
    setMatPixels(data, w, h) { this.matPixels = { data, w, h }; }

    setDock(dock, mission) {
      const other = Object.keys(this.docks).find((k) => this.docks[k] === mission);
      if (other) this.docks[other] = this.docks[dock];
      this.docks[dock] = mission;
      this.reset();
    }

    dockOf(mission) { return Object.keys(this.docks).find((k) => this.docks[k] === mission); }

    // A fresh random robot/field for variation mode; same seed = same imperfections.
    setVariation(on, seed) {
      this.variation = !!on;
      if (seed !== undefined) this.seed = seed;
      this.reset();
    }

    // A different robot (Robot tab): new size, wheels, motors, sensor position or attachment.
    setBuild(b) {
      this.build = normalizeBuild(b);
      applyBuild(this.build);
      this.buildKey = buildKeyOf(this.build);
      this.reset();
    }

    setBattery(charge) { this.battery = clamp(Number(charge), 0, 1); }

    // Parts that don't work, or don't work well (see FAULTS_DEFAULT). Takes effect at once, even while
    // a program runs, and stays through a reset: resetting the field doesn't repair the robot.
    setFaults(f) {
      this.faults = normalizeFaults(f);
      if (this.faults.gyro.on) this.gyroStuck = null;
    }
    get faulty() { return JSON.stringify(this.faults) !== JSON.stringify(normalizeFaults()); }

    // Where the robot is placed for every launch: { x, y, h } on the table.
    setLaunch(pose) {
      this.launch = { x: Number(pose.x), y: Number(pose.y), h: ((Number(pose.h) % 360) + 360) % 360 };
      this.reset();
    }

    reset() {
      this.stopCode();
      this.gyroStuck = null;
      this.tokens = 6;
      this.buildKey = buildKeyOf(this.build);
      this.t = 0;
      this.started = false;
      this.over = false;
      this.actions = [];
      this.trail = [];
      this.trailTimer = 0;
      this.timerZero = 0;
      this.hub = { text: '', textStart: 0, image: null, grid: new Array(25).fill(0), brightness: 100, center: 'white', volume: 100, eyes: [0, 0, 0, 0] };
      this.buttons = { left: false, right: false };
      this.onHub(this.hub);

      const rand = rng(this.seed);
      const pm = (amt) => (this.variation ? (rand() * 2 - 1) * amt : 0);
      this.vary = {
        wheelL: 1 + pm(VARIATION.wheelDiameter), wheelR: 1 + pm(VARIATION.wheelDiameter),
        motorL: 1 + pm(VARIATION.motorStrength), motorR: 1 + pm(VARIATION.motorStrength),
        gyroDrift: pm(VARIATION.gyroDrift), grip: 1 + pm(VARIATION.matGrip),
        noise: this.variation ? rand : null,
      };
      const P = this.launch || START;
      const h0 = P.h + pm(VARIATION.startAngle);
      this.basketClosed = false; this.gateFix = null;
      this.poll = null;
      this.robot = {
        x: P.x + pm(VARIATION.startPos), y: P.y + pm(VARIATION.startPos), h: h0,
        cmdL: 0, cmdR: 0, setL: 0, setR: 0, wL: 0, wR: 0, iL: 0, iR: 0, encL: 0, encR: 0, wheels: {},
        gyro0: h0 - P.h, gyroT0: 0, hRef: P.h, slipping: false, yawZero: P.h,
        armPos: 0, armVel: 0, armCmd: 0, sparePos: 0, spareVel: 0, spareCmd: 0,
        moveMotors: ['A', 'B'], moveSpeed: 50, rotationCm: 17.5, motorSpeed: { A: 75, B: 75, C: 75, D: 75 },
        accelCm: ROBOT.accel, decelCm: ROBOT.brakeAccel, stopMode: 'brake',
      };
      this.buildWorld();
      this.syncFromWorld();
    }

    // ---- physics world -------------------------------------------------------
    buildWorld() {
      const world = new planck.World({ gravity: Vec2(0, 0) });
      this.world = world;
      const ground = world.createBody();
      this.ground = ground;
      const fix = { friction: PHYS.bodyFriction, restitution: PHYS.restitution };
      const poly = (pts) => planck.Polygon(pts.map(([x, y]) => Vec2(x, y)));

      // table walls
      const t = 10;
      ground.createFixture(planck.Box(FIELD.w / 2 + t, t / 2, Vec2(FIELD.w / 2, -t / 2), 0), fix);
      ground.createFixture(planck.Box(FIELD.w / 2 + t, t / 2, Vec2(FIELD.w / 2, FIELD.h + t / 2), 0), fix);
      ground.createFixture(planck.Box(t / 2, FIELD.h / 2, Vec2(-t / 2, FIELD.h / 2), 0), fix);
      ground.createFixture(planck.Box(t / 2, FIELD.h / 2, Vec2(FIELD.w + t / 2, FIELD.h / 2), 0), fix);

      // (collideConnected: the joint mustn't stop the body hitting the walls and models, which are part of the ground body)
      const slideOnMat = (body, mass, r) => {
        const f = PHYS.matGrip * this.vary.grip * mass * G;
        world.createJoint(planck.FrictionJoint({ maxForce: f, maxTorque: f * r * 0.6, collideConnected: true }, ground, body, body.getPosition()));
      };

      // mission models: bases are Dual-Locked to the mat; the parts the robot moves are pads
      this.solids = MAT.models.map((m) => ({ ...m }));
      for (const [dock, mission] of Object.entries(this.docks)) {
        const dm = DOCK_MODELS[mission];
        let pads = dm.pads;
        if (pads) { // front = towards the middle of the field
          const [cx, cy] = centroid(MAT.docks[dock]);
          const dx = FIELD.w / 2 - cx, dy = FIELD.h / 2 - cy, n = Math.hypot(dx, dy);
          const dirs = { front: [dx / n, dy / n], left: [-dy / n, dx / n], right: [dy / n, -dx / n] };
          pads = pads.map((pd) => ({ ...pd, face: dirs[pd.side || 'front'] }));
        }
        this.solids.push({ id: dm.id, mission, name: dm.name, shape: MAT.docks[dock], h: dm.h, dock, pads });
      }
      this.state = {};
      this.plates = [];
      for (const s of this.solids) {
        const st = { presses: 0, touched: false, pads: {} };
        this.state[s.id] = st;
        if (s.loose) {
          const [cx, cy] = centroid(s.shape);
          const body = world.createBody({ type: 'dynamic', position: Vec2(cx, cy), angularDamping: 2, linearDamping: 0.5 });
          const area = Math.abs(s.shape.reduce((a, p, i) => { const q = s.shape[(i + 1) % s.shape.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
          body.createFixture(poly(s.shape.map(([x, y]) => [x - cx, y - cy])), { ...fix, density: s.loose.mass / area });
          for (const o of this.outlinesOf(s)) body.createFixture(poly(o.pts), { ...fix, density: 0, filterCategoryBits: o.cat }); // weightless: the base carries the mass
          slideOnMat(body, s.loose.mass, 2);
          s.body = body;
          s.rest = { x: cx, y: cy };
          continue;
        }
        if (s.shape.length > 4) {
          const [cx, cy] = centroid(s.shape);
          ground.createFixture(planck.Circle(Vec2(cx, cy), Math.hypot(s.shape[0][0] - cx, s.shape[0][1] - cy)), fix);
        } else {
          ground.createFixture(poly(s.shape), s.ringable ? { ...fix, filterCategoryBits: RING_CATEGORY } : fix);
        }
        // what sticks out past the footprint, so the robot bumps into the model it can see
        const frame = footprintFrame(s.shape), c = Math.cos(frame.ang), sn = Math.sin(frame.ang);
        for (const o of this.outlinesOf(s)) {
          ground.createFixture(poly(o.pts.map(([x, z]) => [frame.cx + x * c - z * sn, frame.cy + x * sn + z * c])), { ...fix, filterCategoryBits: s.ringable ? RING_CATEGORY : o.cat });
        }
        for (const pd of s.pads || []) this.addPlate(s, st, pd);
      }

      // robot: chassis plus a basket grabber on the front
      const r = this.robot;
      const body = world.createBody({ type: 'dynamic', position: Vec2(r.x, r.y), angle: rad(r.h - 90), bullet: true });
      body.setSleepingAllowed(false);
      const L = ROBOT.length, Wd = ROBOT.width;
      body.createFixture(planck.Box(L / 2, Wd / 2), { ...fix, density: (PHYS.robotMass * 0.94) / (L * Wd), filterCategoryBits: ROBOT_CATEGORY });
      this.body = body;
      this.attFix = []; this.attBoxes = null; this.attAngle = null;
      if (ROBOT.swing && ROBOT.swing.shape) this.updateAttachment(true); // its collision boxes follow its motor
      else for (const part of attachmentBoxes()) { // in robot coordinates: u forward, v to the right
        body.createFixture(planck.Box(part.du / 2, part.dv / 2, Vec2(part.u, part.v), 0), { ...fix, density: (PHYS.robotMass * 0.03) / (part.du * part.dv), filterCategoryBits: ROBOT_CATEGORY, filterMaskBits: 0xffff & ~HIGH_CATEGORY });
      }

      // loose mission models; the ones still on a model wait there (inactive) until they come loose
      const slots = {};
      const nestOrder = this.shuffle(['leaf1', 'leaf2', 'katydid']); // the referee mixes up the nest (Update 01)
      this.items = MAT.items.map((i) => {
        let { x, y } = i, z = 0;
        if (i.on) {
          const host = this.solids.find((s2) => s2.id === i.on);
          const k = slots[i.on] = (slots[i.on] || 0) + 1;
          [x, y, z] = this.itemSlot(host, i, i.on === 'nest' ? nestOrder.indexOf(i.id) : k - 1);
        }
        const b = world.createBody({ type: 'dynamic', position: Vec2(x, y), linearDamping: 0.5, angularDamping: 2 });
        const shape = i.size ? planck.Box(i.size[0] / 2, i.size[1] / 2) : planck.Circle(i.r);
        const area = i.size ? i.size[0] * i.size[1] : Math.PI * i.r * i.r;
        b.createFixture(shape, { ...fix, density: i.mass / area, filterMaskBits: 0xffff & ~OVERHANG_CATEGORY & ~HIGH_CATEGORY & ~ROBOT_HIGH_CATEGORY & ~(i.type === 'tie' ? RING_CATEGORY : 0) });
        slideOnMat(b, i.mass, i.r);
        if (i.on) b.setActive(false);
        if (i.tether) { // a cable or chain back to its model: it can't be dragged further away than this
          const [hx, hy] = centroid(this.solids.find((s2) => s2.id === i.tether).shape);
          world.createJoint(planck.RopeJoint({ maxLength: i.len || Math.hypot(x - hx, y - hy), localAnchorA: Vec2(hx, hy), localAnchorB: Vec2(0, 0), collideConnected: true }, ground, b));
        }
        return { ...i, x, y, z, a: 0, carried: false, attached: !!i.on, home: i.on ? { x, y, z } : null, body: b, weld: null };
      });
      // the keystone species is placed by the team: where this robot's attachment would be on it, it goes just in front
      const fx = Math.sin(rad(r.h)), fy = -Math.cos(rad(r.h)), parts = this.robotParts(0.3);
      for (const it of this.items) {
        if (it.type !== 'keystone') continue;
        let n = 0;
        while (n < 80 && parts.some((pp) => polyDistance(it.x, it.y, pp) < it.r)) { it.x += fx * 0.5; it.y += fy * 0.5; n++; }
        if (n) it.body.setPosition(Vec2(it.x, it.y));
      }
      this.buildRig();
      this.katydidLeft = false; // katydid completely out of the leaf habitat at some point (M04 bonus lost)
      this.droneWasUp = false;
      this.scatterTimer = 0;
    }

    // The parts of a model outside its footprint that are low enough for this robot to hit: [{ pts, cat }]
    // in the model's own frame (see model-outlines.js).
    outlinesOf(s) {
      if (s.loose) return []; // small loose models keep their official footprint
      const list = OUTLINES[s.dock ? s.id + '@' + s.dock : s.id] || [];
      return list.filter((o) => o.minY >= BASE_LEVEL && o.minY < ROBOT.height && o.pts.length >= 3)
        .map((o) => ({ pts: o.pts, cat: o.minY >= ATTACHMENT_HEIGHT ? HIGH_CATEGORY : o.minY >= OVERHANG_HEIGHT ? OVERHANG_CATEGORY : 0x0001 }));
    }

    // M01 drone rig. The legs and drone are one body turning on the pilot's turntable; the anchor slides
    // in and out along it (it can't turn on its own: the pin connectors only hinge up and down).
    buildRig() {
      const world = this.world, ground = this.ground;
      const anchor = this.items.find((it) => it.type === 'anchor');
      const [px, py] = centroid(this.solids.find((s2) => s2.id === 'pilot').shape);
      const yaw = Math.atan2(anchor.y - py, anchor.x - px), d0 = Math.hypot(anchor.x - px, anchor.y - py);
      const boom = world.createBody({ type: 'dynamic', position: Vec2(px, py), angle: yaw, angularDamping: 1 });
      world.createJoint(planck.RevoluteJoint({ collideConnected: true }, ground, boom, Vec2(px, py)));
      const spin = world.createJoint(planck.FrictionJoint({ maxForce: 0, maxTorque: DRONE.turntable, collideConnected: true }, ground, boom, Vec2(px, py)));
      anchor.body.setTransform(Vec2(anchor.x, anchor.y), yaw);
      const slide = world.createJoint(planck.PrismaticJoint({
        enableLimit: true, lowerTranslation: DRONE.closest - d0, upperTranslation: DRONE.span - d0,
      }, boom, anchor.body, Vec2(anchor.x, anchor.y), Vec2(Math.cos(yaw), Math.sin(yaw))));
      this.rig = { boom, spin, slide, anchor, px, py, d0, built: null, fixtures: [] };
      this.updateRig();
    }

    // Each physics step: the drone's weight pushes the anchor back out (the legs want to lie flat), a
    // resting drone drags on the mat when the rig turns, and the legs block the robot where they are low.
    updateRig() {
      const rig = this.rig, boom = rig.boom;
      const d = clamp(rig.d0 + rig.slide.getJointTranslation(), DRONE.closest, DRONE.span);
      const apex = droneApex(d), a = boom.getAngle();
      if (apex.lift > 0) {
        const lo = d - 0.05, hi = Math.min(d + 0.05, DRONE.span);
        const slope = (droneApex(hi).h - droneApex(lo).h) / (hi - lo); // drone height per cm of anchor travel
        const push = -(DRONE.mass + 2 * DRONE.legMass) * G * slope;
        rig.anchor.body.applyForceToCenter(Vec2(Math.cos(a) * push, Math.sin(a) * push), true);
      }
      rig.spin.setMaxTorque(DRONE.turntable + (apex.lift > 0 ? 0 : PHYS.matGrip * this.vary.grip * DRONE.mass * G * apex.x));
      const key = Math.round(d * 4) + ':' + ROBOT.height;
      if (key !== rig.built) this.rigFixtures(d, apex);
      rig.built = key;
    }

    rigFixtures(d, apex) {
      const rig = this.rig, boom = rig.boom, H = ROBOT.height;
      for (const f of rig.fixtures) boom.destroyFixture(f);
      rig.fixtures = [];
      const opts = { friction: PHYS.bodyFriction, restitution: PHYS.restitution, density: 0, filterCategoryBits: RIG_CATEGORY, filterMaskBits: ROBOT_CATEGORY };
      const add = (pts, o) => rig.fixtures.push(boom.createFixture(planck.Polygon(pts.map(([x, y]) => Vec2(x, y))), o || opts));
      // a leg from pin [x, side, height] to pin, as far as it is lower than the robot (it drives under the rest)
      const leg = (p, q) => {
        if (p[2] >= H) return;
        const t = q[2] > H ? (H - p[2]) / (q[2] - p[2]) : 1;
        const ex = p[0] + (q[0] - p[0]) * t, ey = p[1] + (q[1] - p[1]) * t;
        const len = Math.hypot(ex - p[0], ey - p[1]);
        if (len < 0.2) return;
        const nx = (-(ey - p[1]) / len) * 0.24, ny = ((ex - p[0]) / len) * 0.24; // a 4.8 mm axle
        add([[p[0] + nx, p[1] + ny], [ex + nx, ey + ny], [ex - nx, ey - ny], [p[0] - nx, p[1] - ny]]);
      };
      for (const s of [-1, 1]) {
        leg([0, s * DRONE.pilotSide, DRONE.pilotPin], [apex.x, s * DRONE.droneOuter, apex.h]);
        leg([d, s * DRONE.anchorSide, DRONE.anchorPin], [apex.x, s * DRONE.droneInner, apex.h]);
      }
      const box = (x, u, v, o) => add([[x - u, -v], [x + u, -v], [x + u, v], [x - u, v]], o);
      if (apex.h - DRONE.restPin < H) { box(apex.x, 2.4, 2.4); box(apex.x, 0.4, 4.0); } // the drone: 6x6 studs of rotor arms, tan pins out the sides
      // A copy of the anchor's footprint that stops the rig swinging through walls and models. (The robot
      // pushes the anchor itself; only pushing on the anchor, the joint would force it through them.)
      const size = rig.anchor.size;
      box(d, size[0] / 2, size[1] / 2, { ...opts, filterMaskBits: 0xffff & ~ROBOT_CATEGORY & ~OVERHANG_CATEGORY & ~HIGH_CATEGORY });
      // what the robot has to swing round: the drone, plus the legs (each about half way along). The
      // solver gets 8 times that: squeezed between the robot and a wall, a 40 g body lets the joints
      // stretch. Only its inertia is scaled; the drone's weight and drag above use the real masses.
      const m = DRONE.mass, ml = DRONE.legMass, x = apex.x, k = 8;
      const mass = m + 4 * ml;
      const cx = (m * x + 2 * ml * (x / 2) + 2 * ml * ((x + d) / 2)) / mass;
      boom.setMassData({ mass: mass * k, center: Vec2(cx, 0), I: k * (m * x * x + 2 * ml * (x * x) / 3 + 2 * ml * (x * x + x * d + d * d) / 3) });
    }

    // The rig as it stands now, for drawing: pins as [x, y, height] in table cm.
    droneRig() {
      const rig = this.rig, a = rig.boom.getAngle(), c = Math.cos(a), sn = Math.sin(a);
      const d = clamp(rig.d0 + rig.slide.getJointTranslation(), DRONE.closest, DRONE.span), apex = droneApex(d);
      const at = (u, v, h) => [rig.px + u * c - v * sn, rig.py + u * sn + v * c, h];
      const legs = [];
      for (const s of [-1, 1]) {
        legs.push([at(apex.x, s * DRONE.droneOuter, apex.h), at(0, s * DRONE.pilotSide, DRONE.pilotPin)]);
        legs.push([at(apex.x, s * DRONE.droneInner, apex.h), at(d, s * DRONE.anchorSide, DRONE.anchorPin)]);
      }
      return { yaw: a, drone: at(apex.x, 0, apex.h), lift: apex.lift, legs, pilot: [rig.px, rig.py] };
    }

    // Seeded shuffle (variation runs repeat exactly; otherwise a new order every reset).
    shuffle(list) {
      const rand = this.variation ? rng(this.seed * 31 + 7) : Math.random;
      const a = list.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
      return a;
    }

    // Where a piece sits on its model before it comes loose: [x, y, height].
    itemSlot(host, item, k) {
      const [cx, cy] = centroid(host.shape);
      if (host.id === 'seedpod') { // book 2: hanging by their gold rings at the bottom of the hose loop, in front of the stalk
        const [p0, p1] = host.shape, ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const lx = (k - 1) * 1.2, lz = 3.6; // model-local: along the hose loop, and out in front under the stem
        return [cx + lx * Math.cos(ang) - lz * Math.sin(ang), cy + lx * Math.sin(ang) + lz * Math.cos(ang), 2.9];
      }
      if (host.id === 'nest') { // book 4: the leaves lie on the nest with their rope loops standing where the leaves meet, on the field side
        const spot = plateSpot(host.shape, S, (k - 1) * 0.5);
        return [spot.mx - spot.ny * 0 - spot.nx * 1.0, spot.my - spot.ny * 1.0, 1.3];
      }
      if (host.id === 'leafcutter') return [cx - 2.4, cy - 3.6 + k * 1.6, 2.9]; // book 6: four leaves standing on liftarms in a row along the back of the nest
      if (host.id === 'vine') { const spot = plateSpot(host.shape, S, 0); return [spot.mx - spot.nx * 1.8, spot.my - spot.ny * 1.8, 8]; } // wrapped on the trunk
      if (host.id === 'elder') { const spot = plateSpot(host.shape, W, 0); return [spot.mx - spot.nx * 1.2, spot.my - spot.ny * 1.2, 5]; } // hanging on the tree
      if (host.id === 'platform') { const spot = plateSpot(host.shape, S, 0.2); return [spot.mx, spot.my + 1.0, 11]; } // hanging on its red stick in front of the trunk
      return [cx, cy, 0];
    }

    // A piece comes off its model and lands on the mat, thrown `speed` cm/s along (dx, dy).
    releaseItem(it, dx, dy, speed) {
      if (!it.attached) return;
      const host = this.solids.find((s2) => s2.id === it.on);
      const n = Math.hypot(dx, dy) || 1;
      let x = it.x, y = it.y;
      // start just outside the model so it doesn't spawn inside the base
      for (let i = 0; i < 40 && polyDistance(x, y, host.shape) < it.r + 0.3; i++) { x += (dx / n) * 0.5; y += (dy / n) * 0.5; }
      it.attached = false;
      it.body.setPosition(Vec2(x, y));
      it.body.setActive(true);
      it.body.setLinearVelocity(Vec2((dx / n) * speed, (dy / n) * speed));
      it.body.setAngularVelocity((Math.random() - 0.5) * 8);
    }

    addPlate(s, st, pd) {
      if (pd.kind === 'lift') return this.addHandle(s, st, pd);
      if (pd.kind === 'pull') return this.addPull(s, st, pd);
      const spot = plateSpot(s.shape, pd.face, pd.at);
      const thick = 1, w = pd.w || Math.min(spot.len * 0.8, 8), out = pd.out !== undefined ? pd.out : pd.travel + thick;
      const cx = spot.mx + spot.nx * (out - thick / 2), cy = spot.my + spot.ny * (out - thick / 2);
      const ang = Math.atan2(spot.ny, spot.nx);
      const body = this.world.createBody({ type: 'dynamic', position: Vec2(cx, cy), angle: ang, linearDamping: 4 });
      body.createFixture(planck.Box(thick / 2, w / 2), { friction: 0.6, restitution: 0, density: 0.02 / (thick * w) });
      // Slides straight into the model between "out" (0) and "all the way in" (travel). A spring part
      // is pushed back out by its motor; a latch part is held by friction and can't be pulled back.
      const spring = pd.kind === 'spring';
      const joint = this.world.createJoint(planck.PrismaticJoint({
        enableLimit: true, lowerTranslation: 0, upperTranslation: pd.travel,
        enableMotor: true, motorSpeed: spring ? -6 : 0, maxMotorForce: pd.force * NEWTON,
      }, this.ground, body, Vec2(cx, cy), Vec2(-spot.nx, -spot.ny)));
      const ps = { max: 0, strokes: 0, latched: false };
      st.pads[pd.key] = ps;
      this.plates.push({ id: s.id, key: pd.key, pad: pd, solid: s, body, joint, st, ps, travel: pd.travel, steps: pd.steps || 1, spring, w, thick, h: Math.min(s.h, 6), t: 0, speed: 0, poly: null, nx: spot.nx, ny: spot.ny, face: [spot.mx, spot.my], out });
    }

    // A handle to lift (see `lift`): no body of its own (the model's base is what the robot bumps into),
    // just the space in front of the model where it sticks out.
    addHandle(s, st, pd) {
      const spot = plateSpot(s.shape, pd.face, pd.at), w = pd.w || Math.min(spot.len * 0.8, 8);
      const tx = -spot.ny, ty = spot.nx;
      const at = (d, t) => [spot.mx + spot.nx * d + tx * t, spot.my + spot.ny * d + ty * t];
      const ps = { max: 0, strokes: 0, latched: false };
      st.pads[pd.key] = ps;
      this.plates.push({
        id: s.id, key: pd.key, pad: pd, solid: s, lift: true, st, ps, w, thick: pd.reach, h: pd.h, rise: pd.rise, lifted: 0, under: new Set(), hinted: false,
        poly: [at(-0.3, -w / 2), at(pd.reach, -w / 2), at(pd.reach, w / 2), at(-0.3, w / 2)],
        cx: spot.mx + spot.nx * pd.reach / 2, cy: spot.my + spot.ny * pd.reach / 2, ang: Math.atan2(spot.ny, spot.nx), nx: spot.nx, ny: spot.ny, t: 0, speed: 0, travel: pd.rise,
      });
    }

    // A handle to pull (see `pull`): no body of its own either; it moves out as far as something hooked
    // behind it has pulled it. `s` is how far out it is.
    addPull(s, st, pd) {
      const spot = plateSpot(s.shape, pd.face, pd.at);
      const ps = { max: 0, strokes: 0, latched: false };
      st.pads[pd.key] = ps;
      const pl = {
        id: s.id, key: pd.key, pad: pd, solid: s, pull: true, st, ps, w: pd.w, thick: 2 * pd.r, travel: pd.travel, s: 0, hooks: new Set(), front: new Set(), hinted: false,
        face: [spot.mx, spot.my], nx: spot.nx, ny: spot.ny, tx: -spot.ny, ty: spot.nx, ang: Math.atan2(spot.ny, spot.nx), t: 0, speed: 0,
      };
      this.placePull(pl);
      this.plates.push(pl);
    }
    // the bar's outline on the mat, where it is now
    placePull(pl) {
      const d = pl.pad.out + pl.s, r = pl.pad.r, w2 = pl.w / 2;
      const at = (a, b) => [pl.face[0] + pl.nx * a + pl.tx * b, pl.face[1] + pl.ny * a + pl.ty * b];
      pl.poly = [at(d - r, -w2), at(d + r, -w2), at(d + r, w2), at(d - r, w2)];
      [pl.cx, pl.cy] = at(d, 0);
      pl.t = pl.s;
    }

    syncFromWorld() {
      const r = this.robot, p = this.body.getPosition();
      r.x = p.x; r.y = p.y; r.h = deg(this.body.getAngle()) + 90;
      for (const it of this.items) {
        if (it.attached || it.outOfPlay) continue;
        const q = it.body.getPosition();
        it.x = q.x; it.y = q.y; it.z = 0; it.a = deg(it.body.getAngle());
      }
      for (const s of this.solids) {
        if (!s.body) { s.pose = null; continue; }
        const q = s.body.getPosition();
        s.pose = { dx: q.x - s.rest.x, dy: q.y - s.rest.y, da: deg(s.body.getAngle()) };
      }
      for (const pl of this.plates) {
        if (pl.lift || pl.pull) continue;
        const q = pl.body.getPosition(), a = pl.body.getAngle();
        const c = Math.cos(a), sn = Math.sin(a);
        pl.t = pl.joint.getJointTranslation();
        pl.speed = Math.abs(pl.joint.getJointSpeed());
        pl.cx = q.x; pl.cy = q.y; pl.ang = a;
        pl.poly = [[-pl.thick / 2, -pl.w / 2], [pl.thick / 2, -pl.w / 2], [pl.thick / 2, pl.w / 2], [-pl.thick / 2, pl.w / 2]]
          .map(([u, v]) => [q.x + u * c - v * sn, q.y + u * sn + v * c]);
      }
    }

    start() { this.started = true; }

    get codeRunning() { return !!(this.token && this.token.alive); }
    get carried() { return this.items.filter((i) => i.carried); }

    stopCode() {
      if (this.token) this.token.alive = false;
      this.token = null;
      for (const a of this.actions || []) a.resolve(undefined);
      this.actions = [];
      this.handlers = [];
      if (this.robot) { const r = this.robot; r.cmdL = r.cmdR = r.armCmd = r.spareCmd = 0; }
      this.onSound(0, 0);
    }

    finish() {
      if (this.over) return;
      this.over = true;
      this.stopCode();
      const r = this.robot;
      r.cmdL = r.cmdR = r.setL = r.setR = 0;
    }

    log(...args) {
      const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      this.onLog(msg, this.t);
    }

    // Runs a program. Plain JavaScript runs top to bottom; block programs register event stacks
    // ("when program starts", "when color is ...") which then run side by side, like on the hub.
    runCode(src, onDone, onError) {
      this.stopCode();
      const token = { alive: true };
      this.token = token;
      const finish = () => { if (token.alive) { token.alive = false; onDone(); } };
      const fail = (e) => { if (token.alive) { token.alive = false; onError(e); } };
      const { robot, spike } = makeAPI(this, token, finish, fail);
      const con = { log: robot.log, warn: robot.log, error: robot.log };
      let fn;
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        fn = new AsyncFunction('robot', 'console', 'spike', src);
      } catch (e) {
        token.alive = false;
        onError(e);
        return;
      }
      this.start();
      this.timerZero = this.t;
      // a new program starts with the hub's default settings
      Object.assign(this.robot, { moveMotors: ['A', 'B'], moveSpeed: 50, rotationCm: 17.5, motorSpeed: { A: 75, B: 75, C: 75, D: 75 }, accelCm: ROBOT.accel, decelCm: ROBOT.brakeAccel, stopMode: 'brake' });
      fn(robot, con, spike).then(() => {
        if (!token.alive) return;
        if (!this.handlers.length) { finish(); return; }
        for (const h of this.handlers) if (h.kind === 'start') spike.launch(h);
        spike.checkDone();
      }, fail);
    }

    // Each motor (or the movement pair) runs one command at a time; a new one cuts off the old.
    startAction(a, resolve, slot) {
      this.start();
      a.resolve = resolve || noop;
      a.slot = slot || 'move';
      this.cancelSlot(a.slot);
      this.actions.push(a);
    }

    cancelSlot(slot) {
      const old = this.actions.find((x) => x.slot === slot);
      if (!old) return;
      this.actions = this.actions.filter((x) => x !== old);
      old.resolve(undefined);
    }

    // ---- hub ports -----------------------------------------------------------
    // Signed motor speed in % (+ = clockwise as seen on the motor's face).
    setPortPct(port, pct) {
      const r = this.robot, p = clamp(pct, -100, 100);
      if (port === 'A') r.cmdL = -p;
      else if (port === 'B') r.cmdR = p;
      else if (port === 'C') r.armCmd = p;
      else if (port === 'D') r.spareCmd = p;
    }

    // Motor position in degrees since the program started (+ = clockwise).
    portPos(port) {
      const r = this.robot;
      return { A: -r.encL, B: r.encR, C: r.armPos, D: r.sparePos }[port] || 0;
    }

    portSpeed(port) {
      const r = this.robot;
      const dps = { A: -deg(r.wL), B: deg(r.wR), C: r.armVel, D: r.spareVel }[port] || 0;
      return Math.round((dps / WHEEL.maxDegPerSec) * 100);
    }

    // Movement pair: forward speeds (%) for the left and right movement motors.
    setMovePct(left, right) {
      const [lp, rp] = this.robot.moveMotors;
      this.setPortPct(lp, -left);
      this.setPortPct(rp, right);
    }

    moveDeg(side) {
      const [lp, rp] = this.robot.moveMotors;
      return side === 'L' ? -this.portPos(lp) : this.portPos(rp);
    }

    // Attachment motors: basket gate on C (closes past 45 degrees, hard stops at both ends), spare on D.
    updateAuxMotors(h) {
      const r = this.robot;
      for (const k of ['arm', 'spare']) {
        const f = this.faults[k];
        const target = (clamp(r[k + 'Cmd'], -100, 100) / 100) * WHEEL.maxDegPerSec * (f.on ? f.power / 100 : 0);
        r[k + 'Vel'] += clamp(target - r[k + 'Vel'], -ARM.accel * h, ARM.accel * h);
        r[k + 'Pos'] += r[k + 'Vel'] * h;
      }
      // hard stops: the basket and hook at both ends of their swing, other attachments where they hit the mat
      const sw = ROBOT.swing;
      const [lo, hi] = sw && sw.range && sw.job === 'arm' ? sw.range : [ARM.min, ARM.max];
      if (r.armPos > hi || r.armPos < lo) { r.armPos = clamp(r.armPos, lo, hi); r.armVel = 0; }
      if (sw && sw.range && sw.job === 'spare' && (r.sparePos > sw.range[1] || r.sparePos < sw.range[0])) { r.sparePos = clamp(r.sparePos, ...sw.range); r.spareVel = 0; }
      if (!['basket', 'hook', 'pusher'].includes(ROBOT.attachment)) return; // only these open and close
      const closed = r.armPos >= ARM.closeAt;
      if (closed && !this.basketClosed) this.doGrab();
      if (!closed && this.basketClosed) this.doRelease();
      if (closed !== this.basketClosed) this.setGate(closed);
      this.basketClosed = closed;
    }

    // Brightness 0-100 of the 25 hub pixels right now (scrolling text is computed from sim time).
    hubPixels() {
      const hub = this.hub;
      if (!hub.text) return hub.grid;
      const cols = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
      for (const ch of String(hub.text).toUpperCase()) {
        const g = (FONT[ch] || FONT['?']).split(' ');
        for (let c = 0; c < 3; c++) cols.push(g.map((row) => (row[c] === '1' ? 1 : 0)));
        cols.push([0, 0, 0, 0, 0]);
      }
      const shift = Math.floor((this.t - hub.textStart) * SCROLL_COLS_PER_SEC);
      if (shift > cols.length) { hub.text = ''; return hub.grid; }
      const out = [];
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) out.push(((cols[x + shift] || [])[y] ? hub.brightness : 0));
      return out;
    }

    yaw() {
      let y = (this.gyro() - this.robot.yawZero) % 360;
      if (y > 180) y -= 360;
      if (y <= -180) y += 360;
      return y;
    }

    // ---- sensors the program can read -----------------------------------------
    gyro() {
      const r = this.robot, v = this.vary;
      const noise = v.noise ? (v.noise() * 2 - 1) * VARIATION.gyroNoise : 0;
      const g = r.h - r.gyro0 + v.gyroDrift * (this.t - (r.gyroT0 || 0)) + (r.faultDrift || 0) + noise;
      if (this.faults.gyro.on) return g;
      if (this.gyroStuck == null) this.gyroStuck = g; // a failed gyro keeps reporting its last reading
      return this.gyroStuck;
    }

    // Encoder distance (cm) using the nominal wheel size, like a real program does.
    encoderCm(side) { return ((side === 'L' ? this.robot.encL : this.robot.encR) / 360) * Math.PI * WHEEL.diameter; }

    // ---- simulation step --------------------------------------------------
    // Returns true when an action completed (caller should let user code run).
    // Stops early at that moment so the next command starts without lost time.
    step(dt) {
      if (this.over) return false;
      const r = this.robot;
      const h = dt / SUBSTEPS;

      for (let i = 0; i < SUBSTEPS; i++) {
        if (this.started) this.t += h;

        let completed = false;
        for (const a of this.actions.slice()) {
          if (!a.update(this, h)) continue;
          this.actions = this.actions.filter((x) => x !== a);
          if (a.halt) a.halt(this);
          else if (a.brake) { r.cmdL = r.cmdR = r.setL = r.setR = 0; }
          a.resolve(a.result);
          completed = true;
        }
        if (this.poll && this.poll()) completed = true;
        if (!this.codeRunning && !this.actions.length) {
          const { f, t } = this.manual;
          r.cmdL = f * 70 + t * 40;
          r.cmdR = f * 70 - t * 40;
          if (f || t) { this.start(); r.hRef = null; }
        }

        if (this.started) this.robot.faultDrift = (this.robot.faultDrift || 0) + this.faults.gyro.drift * h;
        this.driveWheels(h);
        this.updateAuxMotors(h);
        this.updateAttachment();
        this.updateRig();
        this.world.step(h, 10, 4);
        this.syncFromWorld();
        this.updateMissions();

        this.trailTimer += h;
        if (this.trailTimer >= 0.1) {
          this.trailTimer = 0;
          if (this.started && this.trail.length < 3000) this.trail.push([r.x, r.y]);
        }

        if (this.t >= MATCH_TIME) {
          this.log('Time is up!');
          this.finish();
          return true;
        }
        if (completed) return true;
      }
      return false;
    }

    // Motors -> wheels -> tyre grip -> robot body. Each wheel is a speed-controlled motor with a
    // torque limit; the tyre transfers force to the body only up to its grip, then it slips.
    driveWheels(h) {
      const r = this.robot, body = this.body, v = this.vary;
      const m = body.getMass(), I = body.getInertia();
      const fwd = body.getWorldVector(Vec2(1, 0)), lat = body.getWorldVector(Vec2(0, 1));
      const up = (r.accelCm / (WHEEL.diameter / 2)) * h, down = (r.decelCm / (WHEEL.diameter / 2)) * h; // rad/s per substep
      const volts = 0.87 + 0.13 * this.battery; // a flat battery lowers the motors' top speed and torque
      const cmdW = (c) => (clamp(c, -100, 100) / 100) * rad(WHEEL.maxDegPerSec);
      const slew = (set, target) => {
        const d = target - set;
        const speedingUp = Math.abs(target) > Math.abs(set) && Math.sign(target) === Math.sign(set || target);
        return set + clamp(d, speedingUp ? -up : -down, speedingUp ? up : down);
      };
      r.setL = slew(r.setL, cmdW(r.cmdL));
      r.setR = slew(r.setR, cmdW(r.cmdR));

      // inverse effective mass of the body at point p along direction d
      const invMass = (p, d) => {
        const c = body.getWorldCenter();
        const rx = p.x - c.x, ry = p.y - c.y;
        const rn = rx * d.y - ry * d.x;
        return 1 / m + (rn * rn) / I;
      };
      const wheelN = (PHYS.robotMass * G * PHYS.driveLoad) / 2;
      const J = PHYS.wheelInertia;
      let slipping = false;

      for (const side of ['L', 'R']) {
        const radius = (WHEEL.diameter / 2) * (side === 'L' ? v.wheelL : v.wheelR);
        const strength = side === 'L' ? v.motorL : v.motorR;
        const key = 'w' + side, set = side === 'L' ? r.setL : r.setR;
        const p = body.getWorldPoint(Vec2(0, side === 'L' ? -ROBOT.wheelBase / 2 : ROBOT.wheelBase / 2));

        // motor: PI speed controller (like SPIKE's), limited by the torque-speed curve
        let w = r[key];
        const fault = this.faults[side === 'L' ? 'left' : 'right']; // a switched-off motor gives no torque, so its wheel rolls free
        const maxTau = PHYS.stallTorque * strength * volts * (fault.on ? fault.power / 100 : 0);
        // torque-speed curve: no drive torque left at the (battery-dependent) free speed; braking is always strong
        const accelerating = Math.sign(set - w) === Math.sign(w) || w === 0;
        const avail = accelerating ? maxTau * Math.max(0.03, 1 - Math.abs(w) / (PHYS.freeSpeed * volts)) : maxTau;
        const ik = 'i' + side;
        const cmd = side === 'L' ? r.cmdL : r.cmdR;
        let tau;
        if (cmd === 0 && r.stopMode !== 'hold') {
          // stopped: "brake" shorts the motor (strong drag, no holding); "coast" lets the wheel roll free
          r[ik] = 0;
          if (side === 'L') r.setL = 0; else r.setR = 0;
          tau = r.stopMode === 'coast' ? clamp(-w * 0.02 * J / h, -avail, avail) : clamp((J * -w) / h * 0.6, -avail, avail);
        } else {
          r[ik] = clamp((r[ik] || 0) + PHYS.motorKi * (set - w) * h, -maxTau, maxTau);
          tau = clamp((J * (set - w)) / h + r[ik], -avail, avail);
        }
        w += (tau / J) * h;

        // tyre: impulse that would make the tyre roll without slipping, capped by grip
        const vel = body.getLinearVelocityFromWorldPoint(p);
        const vLong = vel.x * fwd.x + vel.y * fwd.y, vLat = vel.x * lat.x + vel.y * lat.y;
        let pLong = (w * radius - vLong) / (invMass(p, fwd) + (radius * radius) / J);
        let pLat = -vLat / invMass(p, lat);
        const grip = v.grip * fault.grip / 100;
        const maxP = PHYS.tyreGrip * grip * wheelN * h;
        const mag = Math.hypot(pLong, pLat);
        if (mag > maxP) {
          const k = (PHYS.slideGrip * grip * wheelN * h) / mag;
          pLong *= k; pLat *= k;
          slipping = true;
        }
        w -= (pLong * radius) / J;
        // for the Robot tab's live view: what the motor asked for, how fast the wheel turns, how fast the
        // ground goes by under it (in wheel rad/s), sideways skid (cm/s) and how hard the motor works
        r.wheels[side] = { set, w, ground: vLong / radius, skid: vLat, effort: maxTau ? clamp(tau / maxTau, -1, 1) : 0, slip: mag > maxP, dead: !fault.on };
        r[key] = w;
        r['enc' + side] += deg(w) * h;
        body.applyLinearImpulse(Vec2(fwd.x * pLong + lat.x * pLat, fwd.y * pLong + lat.y * pLat), p, true);
      }
      r.slipping = slipping;

      // ball caster: light sliding friction
      const pc = body.getWorldPoint(Vec2(-ROBOT.length / 2 + 2, 0));
      const vc = body.getLinearVelocityFromWorldPoint(pc);
      const sp = Math.hypot(vc.x, vc.y);
      if (sp > 1e-6) {
        const d = Vec2(vc.x / sp, vc.y / sp);
        const pMax = PHYS.casterGrip * PHYS.robotMass * G * (1 - PHYS.driveLoad) * h;
        const pc2 = Math.min(sp / invMass(pc, d), pMax);
        body.applyLinearImpulse(Vec2(-d.x * pc2, -d.y * pc2), pc, true);
      }
    }

    // Track how far each part was pushed, count spring strokes, let pieces come loose, check the habitats.
    updateMissions() {
      const tag = (s2) => ' (M' + String(s2.mission).padStart(2, '0') + ')';
      for (const pl of this.plates) {
        if (pl.lift) { this.updateHandle(pl, tag); continue; }
        if (pl.pull) { this.updatePull(pl, tag); continue; }
        const ps = pl.ps, f = clamp(pl.t / pl.travel, 0, 1);
        if (pl.spring) {
          if (!ps.latched && f >= 0.85) {
            ps.latched = true;
            if (ps.strokes < pl.steps) {
              ps.strokes++;
              this.log('Pushed the ' + pl.solid.name + tag(pl.solid) + ', ' + ps.strokes + '/' + pl.steps);
              this.onStroke(pl);
            }
          } else if (ps.latched && f <= 0.3) ps.latched = false;
          ps.max = Math.max(ps.max, f);
          continue;
        }
        // latch: one way, so the robot can't drag it back out
        if (pl.t > pl.joint.getLowerLimit() + 0.02) pl.joint.setLimits(pl.t - 0.01, pl.travel);
        const before = ps.max;
        ps.max = Math.max(ps.max, f);
        if (before < DONE && ps.max >= DONE) {
          this.log((pl.pad.label || 'Pushed the ' + pl.solid.name + ' all the way') + tag(pl.solid));
          this.onLatched(pl);
        } else if (pl.id === 'roots' && before < 0.4 && ps.max >= 0.4) this.log('Plant root partially extended' + tag(pl.solid));
        // M06: shoving the ant in too fast shakes the leaf fragments out of the nest
        if (pl.id === 'leafcutter' && pl.speed > SCATTER_SPEED && f < 1) {
          this.scatterTimer -= 1 / 200;
          if (this.scatterTimer <= 0) {
            const frag = this.items.find((it) => it.attached && it.on === 'leafcutter');
            if (frag) {
              this.scatterTimer = 0.05;
              const a = rad(70 + Math.random() * 40) * (Math.random() < 0.5 ? 1 : -1);
              this.releaseItem(frag, Math.cos(a) * pl.nx - Math.sin(a) * pl.ny, Math.sin(a) * pl.nx + Math.cos(a) * pl.ny, 25 + Math.random() * 20);
              this.log('Too fast! A leaf fragment fell out of the ant nest (M06)');
            }
          }
        }
      }
      for (const s2 of this.solids) {
        const st = this.state[s2.id];
        st.presses = Object.values(st.pads).reduce((n, p) => n + (p.strokes || (p.max >= DONE ? 1 : 0)), 0);
        if (!s2.pose || st.touched) continue;
        if (Math.hypot(s2.pose.dx, s2.pose.dy) > 0.3 || Math.abs(s2.pose.da) > 2) {
          st.touched = true;
          this.log('Oops - the ' + s2.name + ' moved!');
        }
      }
      // M02: a hanging seed falls when any part of the robot hits it
      const parts = this.robotParts(0.3);
      for (const it of this.items) {
        if (!it.attached || !it.knock) continue;
        if (parts.some((pp) => polyDistance(it.x, it.y, pp) < it.r)) {
          // it drops and bounces out sideways, away from the stalk
          const [hx, hy] = centroid(this.solids.find((s2) => s2.id === it.on).shape);
          const a = Math.atan2(it.y - hy, it.x - hx) + (Math.random() < 0.5 ? 1 : -1) * rad(60 + Math.random() * 30);
          this.releaseItem(it, Math.cos(a), Math.sin(a), 25 + Math.random() * 15);
          this.log(it.on === 'platform' ? 'Knocked the seed off the tree (M09)' : 'Knocked a seed off the stalk (M02)');
        }
      }
      // M01: the drone is up once the legs fold enough to lift it off the mat
      const up = this.droneUp();
      if (up && !this.droneWasUp) this.log('The legs fold up and lift the drone off the mat (M01)');
      this.droneWasUp = up;
      // M13: the young trees rise once the keystone species lands on the restoration platform
      const rest = this.state.restoration;
      if (rest) {
        const on = this.keystoneOnPlatform();
        if (on && !rest.raised) this.log('Keystone on the restoration platform: the young trees rise (M13)');
        rest.raised = rest.raised || on;
        rest.pads.trees = { max: rest.raised ? 1 : 0, strokes: 0 };
      }
      const katy = this.items.find((it) => it.type === 'katydid');
      if (katy && !this.katydidLeft && !this.inLeafHabitat(katy)) {
        this.katydidLeft = true;
        this.log('The katydid left the leaf habitat (M04 bonus lost)');
      }
    }

    // Position (degrees) of the motor that turns the attachment.
    swingPos() {
      const sw = ROBOT.swing;
      return !sw || !sw.job ? 0 : sw.job === 'spare' ? this.robot.sparePos : this.robot.armPos;
    }

    // The attachment's lifting points on the field now: [x, y, height] (cached for one physics step).
    liftPoints() {
      if (this.liftCache && this.liftCache.t === this.t) return this.liftCache.pts;
      const sw = ROBOT.swing, r = this.robot;
      let pts = [];
      if (sw && sw.lifters) {
        const fx = Math.sin(rad(r.h)), fy = -Math.cos(rad(r.h)), rx = Math.cos(rad(r.h)), ry = Math.sin(rad(r.h));
        pts = swingPoints(sw, sw.lifters, sw.angle(this.swingPos())).map(([u, v, z]) => [r.x + fx * u + rx * v, r.y + fy * u + ry * v, z]);
      }
      this.liftCache = { t: this.t, pts };
      return pts;
    }

    // A handle goes up with the attachment points that were under it and rise; pushing it does nothing.
    updateHandle(pl, tag) {
      const ps = pl.ps, r = this.robot;
      if (pl.lifted >= pl.rise || Math.hypot(r.x - pl.cx, r.y - pl.cy) > ROBOT.length + ROBOT.basket + 12) { pl.under.clear(); return; }
      const pts = this.liftPoints();
      let top = -Infinity;
      for (const i of pl.under) if (pts[i] && pointInPoly(pts[i][0], pts[i][1], pl.poly)) top = Math.max(top, pts[i][2]);
      const before = ps.max;
      if (top > pl.h + pl.lifted) {
        pl.lifted = Math.min(pl.rise, top - pl.h);
        ps.max = pl.lifted / pl.rise;
        pl.t = pl.lifted;
      }
      const underside = pl.h + pl.lifted;
      pl.under = new Set();
      pts.forEach(([x, y, z], i) => { if (z <= underside + 0.3 && z > -0.5 && pointInPoly(x, y, pl.poly)) pl.under.add(i); });
      if (before < DONE && ps.max >= DONE) {
        this.log(pl.pad.label + tag(pl.solid));
        this.onLatched(pl);
      } else if (before === 0 && ps.max > 0) this.log('Lifting the ' + pl.pad.handle + ' of the ' + pl.solid.name + tag(pl.solid));
      // a push on a handle does nothing: once the robot has pushed on it for a while with nothing under it, say why
      if (!pl.hinted && ps.max === 0 && (pl.tick = (pl.tick || 0) + 1) % 10 === 0) {
        pl.pushT = !pl.under.size && this.robotParts(0).some((pp) => polysTouch(pp, pl.poly, 0)) ? (pl.pushT || 0) + 10 / 200 : 0;
      }
      if (!pl.hinted && pl.pushT > 0.75) {
        pl.hinted = true;
        this.log('The ' + pl.pad.handle + ' of the ' + pl.solid.name + ' has to be lifted, not pushed: get an attachment under it (' + pl.h + ' cm up) and lift it with a motor' + tag(pl.solid));
      }
    }

    // A pull handle goes out with the attachment points hooked behind it. A point is hooked when it is
    // between the bar and the model, at about the bar's height, having got there from above or from the
    // side (not by going through the bar).
    updatePull(pl, tag) {
      const ps = pl.ps, r = this.robot, pd = pl.pad;
      if (pl.s >= pl.travel || Math.hypot(r.x - pl.cx, r.y - pl.cy) > ROBOT.length + ROBOT.basket + 12) { pl.hooks.clear(); pl.front.clear(); return; }
      const pts = this.liftPoints(), d = pd.out + pl.s, w2 = pl.w / 2 + 0.3;
      const zLo = pd.zb - pd.r - 1.5, zHi = pd.zb + pd.r + 0.2;
      const hooks = new Set(), front = new Set();
      let reach = -Infinity;
      pts.forEach(([x, y, z], i) => {
        const dx = x - pl.face[0], dy = y - pl.face[1];
        const a = dx * pl.nx + dy * pl.ny, b = dx * pl.tx + dy * pl.ty;
        if (Math.abs(b) > w2 || z < zLo || z > zHi) return;
        if (pl.hooks.has(i) && a >= -0.4) { hooks.add(i); reach = Math.max(reach, a); return; } // still hooked: it drags the bar
        if (a >= d - pd.r) { if (a <= d + pd.r && z > pd.zb - pd.r && z < pd.zb + pd.r - 0.3) front.add(i); return; } // in the bar (passing over or under it doesn't count)
        if (a < -0.4) return;
        if (!pl.front.has(i)) { hooks.add(i); reach = Math.max(reach, a); } // came from above or the side
      });
      pl.hooks = hooks; pl.front = front;
      const before = ps.max;
      // the hook drags the bar: its back stays just in front of the furthest hooked point
      if (reach > -Infinity) {
        const s2 = clamp(reach + pd.r - pd.out + 0.05, 0, pl.travel);
        if (s2 > pl.s) { pl.s = s2; this.placePull(pl); ps.max = pl.s / pl.travel; }
      }
      if (before < DONE && ps.max >= DONE) { this.log(pd.label + tag(pl.solid)); this.onLatched(pl); }
      else if (before === 0 && ps.max > 0) this.log('Pulling the ' + pd.handle + tag(pl.solid));
      // pushing it does nothing: say why, once
      if (!pl.hinted && ps.max === 0 && (pl.tick = (pl.tick || 0) + 1) % 10 === 0) {
        pl.pushT = !hooks.size && this.robotParts(0).some((pp) => polysTouch(pp, pl.poly, 0.3)) ? (pl.pushT || 0) + 10 / 200 : 0;
      }
      if (!pl.hinted && pl.pushT > 0.75) {
        pl.hinted = true;
        this.log('The ' + pd.handle + ' has to be pulled, not pushed: get a hook down behind it (between it and the model, ' + pd.zb + ' cm up) and back away' + tag(pl.solid));
      }
    }

    // Rebuilds a swinging attachment's collision boxes when its motor has turned it a little.
    updateAttachment(force) {
      const sw = ROBOT.swing;
      if (!sw || !sw.shape) return;
      const ang = sw.angle(this.swingPos());
      if (!force && Math.abs(ang - this.attAngle) < 2) return;
      this.attAngle = ang;
      for (const f of this.attFix) this.body.destroyFixture(f);
      this.attBoxes = footprintOf(swingPoints(sw, sw.shape, ang));
      // weightless (the chassis carries the robot's mass, so it doesn't change as the boxes do)
      this.attFix = this.attBoxes.map((b) => this.body.createFixture(planck.Box(b.du / 2, b.dv / 2, Vec2(b.u, b.v), 0), {
        friction: PHYS.bodyFriction, restitution: PHYS.restitution, density: 0,
        filterCategoryBits: b.high ? ROBOT_HIGH_CATEGORY : ROBOT_CATEGORY, filterMaskBits: b.high ? 0xffff : 0xffff & ~HIGH_CATEGORY,
      }));
    }

    // The robot's chassis and its attachment's solid parts (a basket is open between its arms), grown by `grow` cm.
    robotParts(grow, pose) {
      const r = pose || this.robot, fx = Math.sin(rad(r.h)), fy = -Math.cos(rad(r.h)), rx = Math.cos(rad(r.h)), ry = Math.sin(rad(r.h));
      const g = grow || 0;
      const boxes = (this.attBoxes || attachmentBoxes()).map((b) => [[b.u - b.du / 2, b.v - b.dv / 2 - g], [b.u + b.du / 2 + g, b.v - b.dv / 2 - g], [b.u + b.du / 2 + g, b.v + b.dv / 2 + g], [b.u - b.du / 2, b.v + b.dv / 2 + g]]
        .map(([u, v]) => [r.x + fx * u + rx * v, r.y + fy * u + ry * v]));
      return [robotPoly(r, g)].concat(boxes);
    }

    // ---- match rules ------------------------------------------------------------
    // Which launch area ('left' or 'right') the robot is completely inside, at `pose` or where it is now.
    launchAreaOf(pose) {
      const pts = [].concat(...this.robotParts(0, pose));
      for (const [i, a] of MAT.launch.entries()) {
        const side = i === 0 ? 1 : -1; // the left area opens to the right, the right one to the left
        if (pts.every(([x, y]) => Math.hypot(x - a.cx, y - a.cy) <= a.r && (x - a.cx) * side >= 0 && y <= FIELD.h)) return i === 0 ? 'left' : 'right';
      }
      return null;
    }

    inHome() { return !!this.launchAreaOf(); }

    // Equipment inspection: the robot fits completely in a launch area and under the height limit.
    inspection() {
      if (Math.max(ROBOT.height, ROBOT.attachTop || 0) > MAX_HEIGHT) return { ok: false, why: 'taller than ' + MAX_HEIGHT + ' cm' };
      if (!this.launchAreaOf(this.launch)) return { ok: false, why: 'does not fit completely inside a launch area' };
      return { ok: true };
    }

    // Puts the robot down at `pose` (it keeps hold of what is in its attachment) with its program state reset.
    placeRobot(pose) {
      const r = this.robot, body = this.body;
      const old = { x: r.x, y: r.y, a: body.getAngle() };
      const na = rad(pose.h - 90), dA = na - old.a, c = Math.cos(dA), sn = Math.sin(dA);
      body.setTransform(Vec2(pose.x, pose.y), na);
      body.setLinearVelocity(Vec2(0, 0)); body.setAngularVelocity(0);
      for (const it of this.carried) {
        const dx = it.x - old.x, dy = it.y - old.y;
        it.body.setTransform(Vec2(pose.x + dx * c - dy * sn, pose.y + dx * sn + dy * c), it.body.getAngle() + dA);
        it.body.setLinearVelocity(Vec2(0, 0));
      }
      Object.assign(r, { cmdL: 0, cmdR: 0, setL: 0, setR: 0, wL: 0, wR: 0, iL: 0, iR: 0, armCmd: 0, spareCmd: 0 });
      r.gyro0 = 0; r.gyroT0 = this.t; r.hRef = pose.h; r.yawZero = pose.h;
      this.syncFromWorld();
      r.h = pose.h;
    }

    // The team touches the robot. In home that's free; anywhere else the referee takes a precision
    // token, and anything the robot picked up on this trip is taken out of play.
    pickUp() {
      if (this.over) return false;
      const outside = this.started && !this.inHome();
      this.stopCode();
      if (outside) {
        if (this.tokens > 0) this.tokens--;
        this.log('Robot interrupted outside home: the referee takes a precision token (' + this.tokens + ' left)');
        // the keystone species is the team's own equipment; mission models it picked up outside home are not
        for (const it of this.carried.filter((i) => i.type !== 'keystone' && !i.grabbedInHome)) {
          this.world.destroyJoint(it.weld); it.weld = null; it.carried = false;
          it.outOfPlay = true; it.body.setActive(false); it.x = -100; it.y = -100;
          this.log('The ' + it.type + ' it was carrying goes to the referee');
        }
      }
      this.placeRobot(this.launch);
      return true;
    }

    // a visible gap (1 mm) under the drone's feet, with the robot not holding the anchor
    droneUp() {
      return !this.rig.anchor.carried && this.droneRig().lift >= 0.1;
    }

    keystoneOnPlatform() {
      const target = this.solids.find((s2) => s2.mission === 13 && s2.dock);
      return this.items.some((it) => it.type === 'keystone' && !it.carried && polyDistance(it.x, it.y, target.shape) <= it.r + 3);
    }

    tieOnPost() {
      const tie = this.items.find((it) => it.type === 'tie'), post = this.solids.find((s2) => s2.id === 'post');
      const [cx, cy] = centroid(post.shape);
      return !!tie && !tie.attached && !tie.carried && Math.hypot(tie.x - cx, tie.y - cy) <= 2.2;
    }

    // The leaf habitat is the nest plus the marked area around it on the mat.
    inLeafHabitat(it) {
      const nest = this.solids.find((s2) => s2.id === 'nest');
      return it.attached || polyDistance(it.x, it.y, nest.shape) < 6 + it.r;
    }

    // A spring part was pushed all the way in once.
    onStroke(pl) {
      if (pl.id === 'seedpod') { // each push fires one seed off the stalk
        const seed = this.items.find((it) => it.attached && it.on === 'seedpod');
        if (seed) {
          const [cx, cy] = centroid(pl.solid.shape);
          const a = Math.atan2(seed.y - cy, seed.x - cx) + (Math.random() - 0.5) * 0.6;
          this.releaseItem(seed, Math.cos(a), Math.sin(a), 35 + Math.random() * 25);
        }
      }
    }

    // A latch part reached the end of its travel.
    onLatched(pl) {
      if (pl.id === 'platform' && pl.key === 'seed') { // the seed drops off the tree
        const seed = this.items.find((it) => it.attached && it.on === 'platform');
        if (seed) this.releaseItem(seed, pl.nx, pl.ny, 12);
      }
    }

    // The basket grabber: closes on every loose model inside it.
    doGrab() {
      const r = this.robot;
      const fx = Math.sin(rad(r.h)), fy = -Math.cos(rad(r.h));
      const rx = Math.cos(rad(r.h)), ry = Math.sin(rad(r.h));
      const L = ROBOT.length / 2, W2 = ROBOT.width / 2, R = ROBOT.basket;
      if (ROBOT.attachment === 'pusher') { this.log('The flat pusher cannot pick anything up'); return false; }
      const hookArm = ROBOT.attachment === 'hook';
      let n = 0;
      for (const it of this.items) {
        if (it.carried || it.outOfPlay || (it.attached && !it.hook)) continue;
        const dx = it.x - r.x, dy = it.y - r.y;
        const u = dx * fx + dy * fy, v = dx * rx + dy * ry;
        // Basket: loose models between the arms; pieces hanging on a model (M04 leaves) are hooked from
        // above, a little past the tips, and only by the middle, so the robot has to line up on one piece.
        // Hook arm: only what is at its tip.
        let inReach;
        if (hookArm) inReach = u >= L + R - 4 && u <= L + R + (it.attached ? 4 : it.r + 1) && Math.abs(v) <= (it.attached ? (it.hookWidth || HOOK_WIDTH) + 0.5 : it.r + 1);
        else inReach = u >= L - 1 && u <= L + (it.attached ? R + 6 : R + 0.5) && Math.abs(v) <= (it.attached ? it.hookWidth || HOOK_WIDTH : W2);
        if (inReach) {
          if (it.attached) { // lifted off its model into the attachment, clear of the model
            const vv = hookArm ? 0 : clamp(v, -W2 + 2, W2 - 2);
            let uu = hookArm ? L + R - 0.5 : L + R / 2;
            const blocked = (px, py) => this.solids.some((s2) => !s2.loose && polyDistance(px, py, s2.shape) < it.r + 0.2) ||
              this.plates.some((pl) => pl.poly && polyDistance(px, py, pl.poly) < it.r + 0.2);
            while (uu > L + it.r + 0.2 && blocked(r.x + fx * uu + rx * vv, r.y + fy * uu + ry * vv)) uu -= 0.5;
            const bx = r.x + fx * uu + rx * vv, by = r.y + fy * uu + ry * vv;
            it.attached = false;
            it.body.setPosition(Vec2(bx, by));
            it.body.setActive(true);
            it.x = bx; it.y = by; it.z = 0;
            const what = { leaf: 'a leaf out of the nest (M04)', katydid: 'the katydid out of the nest - careful! (M04)', vine: 'the vine off the tree (M08)', tie: 'the support tie off the tree (M12)' }[it.type] || 'the ' + it.type;
            this.log('Lifted ' + what);
          }
          it.carried = true;
          it.grabbedInHome = this.inHome();
          it.weld = this.world.createJoint(planck.WeldJoint({}, this.body, it.body, it.body.getPosition()));
          n++;
        }
      }
      if (n) this.log((hookArm ? 'Hooked ' : 'Grabbed ') + this.carried.map((i) => i.id).join(', '));
      return n > 0;
    }

    // The basket's gate: closed, it is a bar across the front of the basket that pushes what it meets
    // (open, it is lifted out of the way).
    setGate(closed) {
      if (this.gateFix) { this.body.destroyFixture(this.gateFix); this.gateFix = null; }
      if (!closed || ROBOT.attachment !== 'basket') return;
      const L = ROBOT.length / 2 + ROBOT.basket, W2 = ROBOT.width / 2 - 0.8;
      this.gateFix = this.body.createFixture(planck.Box(0.4, W2, Vec2(L - 0.4, 0), 0), { friction: PHYS.bodyFriction, restitution: PHYS.restitution, density: 0, filterCategoryBits: ROBOT_CATEGORY, filterMaskBits: 0xffff & ~HIGH_CATEGORY });
    }

    doRelease() {
      const held = this.carried;
      if (!held.length) return false;
      this.log('Released ' + held.map((i) => i.id).join(', '));
      for (const it of held) { this.world.destroyJoint(it.weld); it.weld = null; it.carried = false; }
      return true;
    }

    // ---- light & distance sensors --------------------------------------------
    // Where color sensor `n` (1, or 2 for a second one) looks at the mat.
    sensorPoint(n) {
      const r = this.robot, side = n === 2 ? ROBOT.sensorSide2 : ROBOT.sensorSide;
      const fx = Math.sin(rad(r.h)), fy = -Math.cos(rad(r.h)), rx = Math.cos(rad(r.h)), ry = Math.sin(rad(r.h));
      return [r.x + fx * ROBOT.sensorOffset + rx * side, r.y + fy * ROBOT.sensorOffset + ry * side];
    }

    rgbAt(x, y) {
      const m = MAT_RECT;
      if (x < m.x || x > m.x + m.w || y < m.y || y > m.y + m.h) return [24, 24, 24]; // bare table in home
      const px = this.matPixels;
      if (px) {
        const ix = clamp(Math.floor(((x - m.x) / m.w) * px.w), 0, px.w - 1);
        const iy = clamp(Math.floor(((y - m.y) / m.h) * px.h), 0, px.h - 1);
        const k = (iy * px.w + ix) * 4;
        return [px.data[k], px.data[k + 1], px.data[k + 2]];
      }
      // No artwork loaded (e.g. tests): black lines, white launch areas, green forest.
      for (const line of MAT.lines) {
        for (let i = 0; i < line.length - 1; i++) {
          if (distToSegment(x, y, line[i], line[i + 1]) <= LINE_HALF_WIDTH) return [20, 20, 20];
        }
      }
      for (const l of MAT.launch) if (Math.hypot(x - l.cx, y - l.cy) <= l.r) return [245, 245, 245];
      return [90, 170, 80];
    }

    // The sensor sees a small spot (ROBOT.sensorSpot is its radius), not one pixel: the average colour there,
    // so tree shadows and highlights on the artwork don't flicker it, and readings fade across a line edge.
    spotRGB(x, y) {
      const s = ROBOT.sensorSpot, sum = [0, 0, 0];
      let n = 0;
      for (let ring = 0; ring <= 2; ring++) {
        const count = ring === 0 ? 1 : ring * 8;
        for (let k = 0; k < count; k++) {
          const a = (k / count) * Math.PI * 2, d = (ring / 2) * s;
          const p = this.rgbAt(x + Math.cos(a) * d, y + Math.sin(a) * d);
          sum[0] += p[0]; sum[1] += p[1]; sum[2] += p[2];
          n++;
        }
      }
      return sum.map((c) => c / n);
    }

    colorAt(x, y) { return classifyRGB(...this.spotRGB(x, y)); }

    // Color sensor `n` (1, or 2 for a second one); a switched-off sensor sees nothing, a noisy one flickers.
    colorFault(n) { return this.faults[n === 2 ? 'color2' : 'color']; }
    color(n) {
      const f = this.colorFault(n);
      if (!f.on) return 'none';
      const [x, y] = this.sensorPoint(n);
      if (!f.noise) return this.colorAt(x, y);
      return classifyRGB(...this.spotRGB(x, y).map((c) => clamp(c + (Math.random() * 2 - 1) * f.noise * 2.55, 0, 255)));
    }

    reflection(which) {
      const fault = this.colorFault(which);
      if (!fault.on) return 0;
      const [R, G2, B] = this.spotRGB(...this.sensorPoint(which));
      const noise = (this.vary.noise ? (this.vary.noise() * 2 - 1) * VARIATION.reflectionNoise : 0) + (Math.random() * 2 - 1) * fault.noise;
      return clamp(Math.round(((0.2126 * R + 0.7152 * G2 + 0.0722 * B) / 255) * 100 + noise), 0, 100);
    }

    // Ray casts across a narrow cone, like an ultrasonic beam. Ignores the robot itself.
    distance() {
      const f = this.faults.distance;
      if (!f.on) return ROBOT.eyeRange; // no reading, like nothing in range
      if (this.eye && this.t - this.eye.t < 1 / ROBOT.eyeRate && this.eye.t <= this.t) return this.eye.d;
      let d = this.measureDistance();
      if (f.noise && d < ROBOT.eyeRange) d = clamp(d + (Math.random() * 2 - 1) * f.noise, ROBOT.eyeMin, ROBOT.eyeRange - 0.1);
      this.eye = { t: this.t, d };
      return d;
    }

    measureDistance() {
      const r = this.robot;
      const ox = r.x + Math.sin(rad(r.h)) * ROBOT.length / 2;
      const oy = r.y - Math.cos(rad(r.h)) * ROBOT.length / 2;
      let best = ROBOT.eyeRange;
      for (const off of [-ROBOT.eyeCone, 0, ROBOT.eyeCone]) {
        const dx = Math.sin(rad(r.h + off)), dy = -Math.cos(rad(r.h + off));
        const range = ROBOT.eyeRange;
        this.world.rayCast(Vec2(ox, oy), Vec2(ox + dx * range, oy + dy * range), (f, p, nrm, frac) => {
          const b = f.getBody();
          if (b === this.body || this.items.some((it) => it.carried && it.body === b)) return -1;
          best = Math.min(best, frac * range);
          return frac;
        });
      }
      const noise = this.vary.noise ? (this.vary.noise() * 2 - 1) * VARIATION.distanceNoise : 0;
      return Math.max(ROBOT.eyeMin, best + (best < ROBOT.eyeRange ? noise : 0));
    }

    // ---- scoring ----------------------------------------------------------
    score() {
      const sim = this;
      const pad = (id, key) => (sim.state[id] && sim.state[id].pads[key]) || { max: 0, strokes: 0 };
      const nest = sim.solids.find((s2) => s2.id === 'nest');
      const view = {
        progress: (id, key) => pad(id, key).max,
        done: (id, key) => pad(id, key).max >= DONE,
        strokes: (id, key) => pad(id, key).strokes,
        touched: (id) => sim.state[id].touched,
        dockOf: (m) => sim.dockOf(m),
        released: (on) => sim.items.filter((it) => it.on === on && !it.attached).length,
        stillOn: (on) => sim.items.filter((it) => it.on === on && it.attached).length,
        leavesOut: () => sim.items.filter((it) => it.type === 'leaf' && !it.attached && !it.carried && polyDistance(it.x, it.y, nest.shape) > it.r).length,
        katydidInHabitat: () => sim.items.filter((it) => it.type === 'katydid').every((it) => !it.carried && sim.inLeafHabitat(it)),
        droneUp: () => sim.droneUp(),
        inspection: () => sim.inspection(),
        tokens: () => sim.tokens,
        tieOnPost: () => sim.tieOnPost(),
        katydidUndisturbed: () => sim.items.filter((it) => it.type === 'katydid').every((it) => it.attached) && !sim.katydidLeft,
        // loose items of a type inside/against the interchangeable model for `mission` (and on the mat)
        delivered(type, mission) {
          const target = sim.solids.find((s2) => s2.mission === mission && s2.dock);
          return sim.items.filter((it) => it.type === type && !it.carried && !it.attached &&
            polyDistance(it.x, it.y, target.shape) <= it.r + 3).length;
        },
      };
      // No Equipment Constraint: a model touching the robot (or riding in it) earns nothing.
      const robotParts = sim.robotParts(0.2);
      const touches = (shape) => robotParts.some((pp) => polysTouch(pp, shape, 0.2));
      const touchingRobot = (n) => sim.solids.some((s2) => s2.mission === n && touches(s2.pose ? movedShape(s2) : s2.shape)) ||
        sim.plates.some((pl) => pl.solid.mission === n && pl.poly && touches(pl.poly));
      function movedShape(s2) {
        const [cx, cy] = centroid(s2.shape), c = Math.cos(rad(s2.pose.da)), sn = Math.sin(rad(s2.pose.da));
        return s2.shape.map(([x, y]) => [cx + s2.pose.dx + (x - cx) * c - (y - cy) * sn, cy + s2.pose.dy + (x - cx) * sn + (y - cy) * c]);
      }
      const parts = [];
      for (const m of MISSIONS) {
        const blocked = NO_EQUIPMENT.has(m.n) && touchingRobot(m.n);
        const note = blocked ? ' \u2013 not counted while touching the robot' : '';
        for (const c of m.conds) {
          const tag = m.n ? 'M' + String(m.n).padStart(2, '0') + ' ' : '';
          if (c.each) {
            const would = clamp(c.count(view), 0, c.max), n = blocked ? 0 : would;
            parts.push({ mission: m.n, title: tag + m.name, cond: c.label + ' (' + n + '/' + c.max + ')' + (blocked && would ? note : ''), label: tag + m.name + ': ' + c.label, pts: n * c.each, max: c.max * c.each, earned: n > 0, blocked: blocked && would > 0 });
          } else if (c.points) {
            const pts = c.points(view);
            parts.push({ mission: m.n, title: tag + m.name, cond: c.label + ' (' + sim.tokens + '/6)', label: tag + m.name + ': ' + c.label, pts, max: c.pts, earned: pts > 0 });
          } else {
            const would = !!c.ok(view), ok = !blocked && would;
            const why = m.n === 0 && !would && view.inspection && !view.inspection().ok ? ' \u2013 the robot ' + view.inspection().why : '';
            parts.push({ mission: m.n, title: tag + m.name, cond: c.label + (blocked && would ? note : '') + why, label: tag + m.name + ': ' + c.label, pts: ok ? c.pts : 0, max: c.unavailable ? 0 : c.pts, earned: ok, blocked: blocked && would, unavailable: !!c.unavailable });
          }
        }
      }
      const total = parts.reduce((s, p) => s + p.pts, 0);
      // M05's two outcomes are exclusive, so the best possible run excludes the partial one.
      const max = parts.reduce((s, p) => s + p.max, 0) - 10;
      return { total, max, parts };
    }
  }

  // ---- actions ------------------------------------------------------------
  function waitAction(sec) {
    return { brake: false, el: 0, update(sim, dt) { this.el += dt; return this.el >= sec - 1e-9; } };
  }

  // Encoder-measured straight drive with a trapezoidal speed profile and gyro heading hold.
  // Like a real robot, it trusts the encoders: if the tyres slip, the robot ends up short.
  function driveAction(dist, speed) {
    const sign = dist >= 0 ? 1 : -1;
    const cruise = speed * ROBOT.maxSpeed / 100;
    const profile = (sim, rem) => clamp(Math.sqrt(2 * planDecel(sim) * Math.max(0, rem)), MIN_SPEED, cruise);
    const enc = (sim) => (sim.encoderCm('L') + sim.encoderCm('R')) / 2;
    return {
      brake: true, start: null, last: null, stall: 0, hold: null,
      update(sim, dt) {
        const r = sim.robot;
        const g = sim.gyro();
        if (this.start === null) {
          this.start = enc(sim); this.last = this.start;
          this.hold = r.hRef !== null && Math.abs(g - r.hRef) < 2 ? r.hRef : g;
          r.hRef = this.hold;
        }
        const e = enc(sim);
        const rem = Math.abs(dist) - (e - this.start) * sign;
        if (rem <= DRIVE_TOL) return true;
        const v = sign * profile(sim, rem);
        const steer = clamp((this.hold - g) * HEADING_HOLD, -cruise / 2, cruise / 2);
        r.cmdL = (v + steer) / ROBOT.maxSpeed * 100;
        r.cmdR = (v - steer) / ROBOT.maxSpeed * 100;
        // motors stalled (wheels not turning) for a second: give up, like SPIKE does
        if (Math.abs(e - this.last) < 0.002) { this.stall += dt; if (this.stall > 1) return true; }
        else this.stall = 0;
        this.last = e;
        return false;
      },
    };
  }

  // Gyro turn in place. Relative turns build on the previous target heading,
  // so four turn(90)s land on 360 rather than drifting.
  function turnAction(degs, speed, absolute) {
    const cruise = speed * ROBOT.maxSpeed / 100;
    const profile = (sim, rem) => clamp(Math.sqrt(2 * turnDecel(sim) * Math.max(0, rem)), MIN_SPEED, cruise);
    const arc = (d) => rad(Math.abs(d)) * ROBOT.wheelBase / 2; // wheel travel for d degrees
    return {
      brake: true, target: null, lastEnc: null, stall: 0,
      update(sim, dt) {
        const r = sim.robot;
        const g = sim.gyro();
        if (this.target === null) {
          const base = r.hRef !== null && Math.abs(g - r.hRef) < 2 ? r.hRef : g;
          this.target = absolute ? degs : base + degs;
          r.hRef = this.target;
        }
        const err = this.target - g;
        if (Math.abs(err) <= TURN_TOL) return true;
        // crept past the target and back (a loaded robot can't stop on a fraction of a degree): close enough
        if (this.lastErr !== undefined && Math.sign(err) !== Math.sign(this.lastErr) && Math.abs(err) < 1.5) return true;
        this.lastErr = err;
        const s = Math.sign(err) * profile(sim, arc(err)) / ROBOT.maxSpeed * 100;
        r.cmdL = s; r.cmdR = -s;
        // wheels stalled for a second (e.g. jammed against a wall): give up
        const e = Math.abs(sim.encoderCm('L')) + Math.abs(sim.encoderCm('R'));
        if (this.lastEnc !== null && Math.abs(e - this.lastEnc) < 0.002) { this.stall += dt; if (this.stall > 1) return true; }
        else this.stall = 0;
        this.lastEnc = e;
        return false;
      },
    };
  }

  // Motor run for an amount: rotations, degrees or seconds (+dir = clockwise).
  function motorRunAction(port, dir, amount, unit, speed) {
    const secs = unit === 'seconds';
    const target = unit === 'rotations' ? amount * 360 : amount;
    const cruise = (speed / 100) * WHEEL.maxDegPerSec;
    return {
      el: 0, start: null, last: null, stall: 0,
      halt(sim) { sim.setPortPct(port, 0); if (port === 'A') sim.robot.setL = 0; if (port === 'B') sim.robot.setR = 0; },
      update(sim, dt) {
        const pos = sim.portPos(port);
        if (this.start === null) { this.start = pos; this.last = pos; }
        let pct = speed;
        if (secs) { this.el += dt; if (this.el >= amount - 1e-9) return true; }
        else {
          const rem = Math.abs(target) - Math.abs(pos - this.start);
          if (rem <= 1) return true;
          pct = (clamp(Math.sqrt(2 * 20000 * rem), 30, cruise) / WHEEL.maxDegPerSec) * 100;
        }
        sim.setPortPct(port, dir * Math.sign(target || 1) * pct);
        if (Math.abs(pos - this.last) < 0.05) { this.stall += dt; if (this.stall > 0.5) return true; }
        else this.stall = 0;
        this.last = pos;
        return false;
      },
    };
  }

  function grabAction(sim) {
    return motorRunAction('C', 1, Math.max(0, 90 - sim.robot.armPos), 'degrees', 75);
  }

  function releaseAction(sim) {
    return motorRunAction('C', -1, Math.max(0, sim.robot.armPos), 'degrees', 75);
  }

  // SPIKE movement block: both movement motors at fixed speeds (no gyro correction), stopping when
  // the faster motor has turned far enough. Distances use the program's "1 rotation = x cm" setting.
  function moveAction(left, right, amount, unit) {
    const secs = unit === 'seconds';
    const lead = Math.abs(left) >= Math.abs(right) ? 'L' : 'R';
    const top = Math.max(Math.abs(left), Math.abs(right)) || 1;
    const cruise = (top / 100) * ROBOT.maxSpeed;
    let target = 0;
    return {
      brake: true, el: 0, start: null, last: null, stall: 0,
      update(sim, dt) {
        const pos = sim.moveDeg(lead);
        if (this.start === null) {
          const rot = sim.robot.rotationCm || 17.5;
          target = { cm: (amount / rot) * 360, in: ((amount * 2.54) / rot) * 360, rotations: amount * 360, degrees: amount }[unit] || 0;
          this.start = pos; this.last = pos;
        }
        let k = 1;
        if (secs) { this.el += dt; if (this.el >= amount - 1e-9) return true; }
        else {
          const rem = Math.abs(target) - Math.abs(pos - this.start);
          if (rem <= 1) return true; // within a degree of the encoder target
          const remCm = (rem / 360) * Math.PI * WHEEL.diameter;
          k = clamp(Math.sqrt(2 * planDecel(sim) * remCm), MIN_SPEED, cruise) / cruise;
        }
        const sgn = target < 0 ? -1 : 1;
        sim.setMovePct(left * k * sgn, right * k * sgn);
        if (Math.abs(pos - this.last) < 0.05) { this.stall += dt; if (this.stall > 1) return true; }
        else this.stall = 0;
        this.last = pos;
        return false;
      },
    };
  }

  // SPIKE steering: 0 = straight, 50 = inner wheel stopped, 100 = spin in place; negative = left.
  function steerSpeeds(steer, speed) {
    const s = clamp(steer, -100, 100), k = 1 - Math.abs(s) / 50;
    return s >= 0 ? [speed, speed * k] : [speed * k, speed];
  }

  // Plays a note sequence in sim time (so it speeds up with the simulation).
  function soundAction(notes) {
    return {
      i: -1, left: 0,
      halt(sim) { sim.onSound(0, 0); },
      update(sim, dt) {
        this.left -= dt;
        if (this.left > 0) return false;
        this.i++;
        if (this.i >= notes.length) return true;
        const [note, secs] = notes[this.i];
        this.left = secs;
        if (note) sim.onSound(midiHz(note), secs * 0.9); else sim.onSound(0, 0);
        return false;
      },
    };
  }

  class StopStack extends Error {}

  // ---- API handed to user code -------------------------------------------
  function makeAPI(sim, token, finish, fail) {
    const run = (action, slot) => new Promise((resolve) => {
      if (!token.alive || sim.over) return; // never resolves: run was stopped
      sim.startAction(action, resolve, slot);
    });
    const pct = (s, d) => clamp(Math.abs(s === undefined ? d : Number(s)) || d, 1, 100);
    const round1 = (n) => Math.round(n * 10) / 10;

    const robot = {
      drive: (cm, speed) => run(driveAction(Number(cm) || 0, pct(speed, 50))),
      turn: (d, speed) => run(turnAction(Number(d) || 0, pct(speed, 40))),
      turnTo: (target, speed) => {
        // shortest way round, measured from the gyro (not the rounded heading)
        const g = sim.gyro(), r = sim.robot;
        const from = r.hRef !== null && Math.abs(g - r.hRef) < 2 ? r.hRef : g;
        const delta = ((((Number(target) || 0) - from) % 360) + 540) % 360 - 180;
        return run(turnAction(from + delta, pct(speed, 40), true));
      },
      wait: (sec) => run(waitAction(Math.max(0, Number(sec) || 0)), Symbol('wait')),
      setMotors: (left, right) => {
        if (!token.alive) return;
        sim.robot.cmdL = clamp(Number(left) || 0, -100, 100);
        sim.robot.cmdR = clamp(Number(right) || 0, -100, 100);
        if (sim.robot.cmdL !== sim.robot.cmdR) sim.robot.hRef = null;
      },
      stop: () => { if (token.alive) { sim.robot.cmdL = sim.robot.cmdR = 0; } },
      grab: () => run(grabAction(sim), 'C').then(() => sim.carried.length > 0),
      release: () => run(releaseAction(sim), 'C'),
      color: (n) => (n === 2 && !ROBOT.color2 ? 'none' : sim.color(n)),
      reflection: (n) => (n === 2 && !ROBOT.color2 ? 0 : sim.reflection(n)),
      distance: () => round1(sim.distance()),
      heading: () => round1((((sim.gyro() % 360) + 360) % 360)) % 360,
      x: () => round1(sim.robot.x),
      y: () => round1(sim.robot.y),
      time: () => round1(sim.t),
      holding: () => sim.carried.length > 0,
      log: (...a) => sim.log(...a),
    };

    // ---- SPIKE word-block API (what the block editor generates) ----------------
    const num = (v) => Number(v) || 0;
    // Programs use the hub's port letters; these turn them into the simulator's jobs (see JOBS).
    const portWarn = {};
    const noPart = (port, what) => {
      if (portWarn[port + what]) return;
      portWarn[port + what] = true;
      sim.log('No ' + what + ' on port ' + port + ' (' + (PORTS[port] && PORTS[port] !== 'nothing' ? 'port ' + port + ' has the ' + PORTS[port] : 'nothing is plugged into port ' + port) + ')');
    };
    const offWarn = (port) => { // the part is there but switched off for failure testing: it just doesn't work
      const job = ROBOT.ports[port];
      if (sim.faults[job] && !sim.faults[job].on && !portWarn[port + 'off']) { portWarn[port + 'off'] = true; sim.log('The ' + PORTS[port] + ' on port ' + port + ' is switched off (failure testing, Robot tab)'); }
    };
    const motorOf = (port) => { const job = JOBS[ROBOT.ports[port]]; if (job && job.motor) { offWarn(port); return job.inner; } noPart(port, 'motor'); return null; };
    const sensorOf = (port) => { const job = ROBOT.ports[port]; if (job === 'color' || job === 'color2') { offWarn(port); return job === 'color2' ? 2 : 1; } noPart(port, 'color sensor'); return 0; };
    const hasDistance = (port) => { if (ROBOT.ports[port] === 'distance') { offWarn(port); return true; } noPart(port, 'distance sensor'); return false; };
    const cmpUnit = (cm, unit) => (unit === 'in' ? cm / 2.54 : unit === '%' ? Math.min(100, cm / 2) : cm);
    const handlers = sim.handlers;
    let running = 0;
    const r = sim.robot;

    const spike = {
      // events
      when(kind, args, fn) { handlers.push({ kind, args: args || [], fn, running: false, prev: false }); },
      launch(h) {
        if (h.running || !token.alive) return Promise.resolve();
        h.running = true; running++;
        return h.fn().catch((e) => { if (!(e instanceof StopStack)) fail(e); })
          .then(() => { h.running = false; running--; spike.checkDone(); });
      },
      checkDone() { if (running === 0 && !handlers.some((h) => h.kind !== 'start')) finish(); },
      broadcast(msg) { return Promise.all(handlers.filter((h) => h.kind === 'receive' && h.args[0] === String(msg)).map((h) => spike.launch(h))); },
      broadcastAndWait(msg) { return spike.broadcast(msg); },
      stop(what) {
        if (what === 'this stack') throw new StopStack();
        sim.setMovePct(0, 0);
        finish();
        return new Promise(() => {});
      },
      wait: (sec) => api.wait(sec),

      // movement
      move(dir, amount, unit) {
        const v = r.moveSpeed, a = num(amount);
        const [L, R] = { fwd: [v, v], back: [-v, -v], cw: [v, -v], ccw: [-v, v] }[dir];
        return run(moveAction(L, R, a, unit));
      },
      moveSteer(steer, amount, unit) { const [L, R] = steerSpeeds(num(steer), r.moveSpeed); return run(moveAction(L, R, num(amount), unit)); },
      moveTank(left, right, amount, unit) { return run(moveAction(clamp(num(left), -100, 100), clamp(num(right), -100, 100), num(amount), unit)); },
      startMoving(dir) {
        sim.cancelSlot('move');
        const v = r.moveSpeed;
        const [L, R] = { fwd: [v, v], back: [-v, -v], cw: [v, -v], ccw: [-v, v] }[dir];
        sim.setMovePct(L, R);
      },
      startSteer(steer) { sim.cancelSlot('move'); sim.setMovePct(...steerSpeeds(num(steer), r.moveSpeed)); },
      startTank(left, right) { sim.cancelSlot('move'); sim.setMovePct(clamp(num(left), -100, 100), clamp(num(right), -100, 100)); },
      stopMoving() { sim.cancelSlot('move'); sim.setMovePct(0, 0); },
      setMoveSpeed(p) { r.moveSpeed = clamp(Math.abs(num(p)), 0, 100); },
      // "set movement acceleration to slow / medium / fast" (motor degrees per second squared)
      setMoveAccel(setting) {
        const degPerS2 = ACCEL_SETTINGS[setting] || num(setting) || ACCEL_SETTINGS.medium;
        r.accelCm = r.decelCm = (degPerS2 / 360) * Math.PI * WHEEL.diameter;
      },
      // "set movement motors to brake / hold position / coast at stop"
      setStopMode(mode) { r.stopMode = ['brake', 'hold', 'coast'].includes(mode) ? mode : 'brake'; },
      setMoveMotors(pair) {
        const [a, b] = String(pair).split('+').map(motorOf);
        r.moveMotors = a && b ? [a, b] : ['A', 'B'];
      },
      setRotation(cm, unit) { r.rotationCm = Math.max(0.1, unit === 'in' ? num(cm) * 2.54 : num(cm)); },

      // motors
      motorRun(port, dir, amount, unit) {
        const m = motorOf(port);
        if (!m) return Promise.resolve();
        return run(motorRunAction(m, dir === 'ccw' ? -1 : 1, num(amount), unit, r.motorSpeed[m]), 'motor:' + m);
      },
      motorGoTo(port, mode, position) {
        const m = motorOf(port);
        if (!m) return Promise.resolve();
        const cur = ((sim.portPos(m) % 360) + 360) % 360, target = ((num(position) % 360) + 360) % 360;
        let delta = mode === 'clockwise' ? (target - cur + 360) % 360
          : mode === 'counterclockwise' ? -((cur - target + 360) % 360)
            : ((target - cur + 540) % 360) - 180;
        return run(motorRunAction(m, delta < 0 ? -1 : 1, Math.abs(delta), 'degrees', r.motorSpeed[m]), 'motor:' + m);
      },
      motorStart(port, dir) { const m = motorOf(port); if (m) { sim.cancelSlot('motor:' + m); sim.setPortPct(m, (dir === 'ccw' ? -1 : 1) * r.motorSpeed[m]); } },
      motorStop(port) { const m = motorOf(port); if (m) { sim.cancelSlot('motor:' + m); sim.setPortPct(m, 0); } },
      motorSetSpeed(port, p) { const m = motorOf(port); if (m) r.motorSpeed[m] = clamp(Math.abs(num(p)), 0, 100); },
      motorPosition(port) { const m = motorOf(port); return m ? Math.round(((sim.portPos(m) % 360) + 360) % 360) : 0; },
      motorRelative(port) { const m = motorOf(port); return m ? Math.round(sim.portPos(m) - (r['rel' + m] || 0)) : 0; },
      motorSetRelative(port, v) { const m = motorOf(port); if (m) r['rel' + m] = sim.portPos(m) - num(v); },
      motorSpeed(port) { const m = motorOf(port); return m ? sim.portSpeed(m) : 0; },

      // sensors
      color(port) { const n = sensorOf(port); return n ? sim.color(n) : 'none'; },
      colorIs(port, c) { return spike.color(port) === c; },
      reflection(port) { const n = sensorOf(port); return n ? sim.reflection(n) : 0; },
      reflectionIs(port, op, v) { const x = spike.reflection(port); return op === '<' ? x < num(v) : op === '>' ? x > num(v) : Math.round(x) === Math.round(num(v)); },
      distance(port, unit) {
        if (!hasDistance(port)) return 0;
        const d = sim.distance();
        return d >= ROBOT.eyeRange ? -1 : round1(cmpUnit(d, unit));
      },
      distanceIs(port, op, v, unit) {
        if (!hasDistance(port)) return false;
        const d = sim.distance();
        if (d >= ROBOT.eyeRange) return op === 'farther than';
        const x = cmpUnit(d, unit), t = num(v);
        return op === 'closer than' ? x < t : op === 'farther than' ? x > t : Math.abs(x - t) < 0.5;
      },
      angle(axis) { return axis === 'yaw' ? Math.round(sim.yaw()) : 0; },
      setYaw(v) { r.yawZero = sim.gyro() - num(v); },
      timer() { return round1(sim.t - sim.timerZero); },
      resetTimer() { sim.timerZero = sim.t; },

      // light
      write(text) { const hub = sim.hub; hub.text = String(text); hub.textStart = sim.t; sim.onHub(hub); },
      image(name, secs) {
        const hub = sim.hub, pattern = (HUB_IMAGES[name] || '').replace(/ /g, '');
        hub.text = ''; hub.image = name;
        hub.grid = Array.from({ length: 25 }, (_, i) => (pattern[i] === '1' ? hub.brightness : 0));
        sim.onHub(hub);
        if (secs === undefined) return Promise.resolve();
        return api.wait(secs).then(() => { if (hub.image === name) spike.lightsOff(); });
      },
      lightsOff() { const hub = sim.hub; hub.text = ''; hub.image = null; hub.grid = new Array(25).fill(0); sim.onHub(hub); },
      setBrightness(p) { sim.hub.brightness = clamp(num(p), 0, 100); },
      setPixel(x, y, p) {
        const ix = Math.round(num(x)) - 1, iy = Math.round(num(y)) - 1;
        if (ix < 0 || ix > 4 || iy < 0 || iy > 4) return;
        sim.hub.text = ''; sim.hub.grid = sim.hub.grid.slice(); sim.hub.grid[iy * 5 + ix] = clamp(num(p), 0, 100);
        sim.onHub(sim.hub);
      },
      centerLight(c) { sim.hub.center = c; sim.onHub(sim.hub); },
      eyes(port, a, b, c, d) { if (hasDistance(port)) { sim.hub.eyes = [a, b, c, d].map((x) => clamp(num(x), 0, 100)); sim.onHub(sim.hub); } },

      // sound
      beep(note, secs) {
        sim.onSound(midiHz(clamp(num(note), 44, 123)), secs === undefined ? 9999 : num(secs));
        return secs === undefined ? Promise.resolve() : api.wait(secs);
      },
      playSound(name, untilDone) {
        const notes = SOUNDS[name] || SOUNDS.Beep;
        const p = run(soundAction(notes), 'sound');
        return untilDone ? p : Promise.resolve();
      },
      stopSounds() { sim.cancelSlot('sound'); sim.onSound(0, 0); },
      setVolume(v) { sim.hub.volume = clamp(num(v), 0, 100); },
      changeVolume(v) { sim.hub.volume = clamp(sim.hub.volume + num(v), 0, 100); },
      volume: () => sim.hub.volume,

      // hub buttons
      buttonIs(which, state) { const down = !!sim.buttons[which]; return state === 'pressed' ? down : !down; },

      // operators that behave like Scratch's
      eq: (a, b) => (a !== '' && b !== '' && !isNaN(a) && !isNaN(b) ? Number(a) === Number(b) : String(a).toLowerCase() === String(b).toLowerCase()),
      random: (a, b) => {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return Number.isInteger(lo) && Number.isInteger(hi) ? lo + Math.floor(Math.random() * (hi - lo + 1)) : lo + Math.random() * (hi - lo);
      },
      mod: (a, b) => ((a % b) + b) % b,
      mathop(op, x) {
        const d = Math.PI / 180;
        return {
          abs: Math.abs(x), floor: Math.floor(x), ceiling: Math.ceil(x), sqrt: Math.sqrt(x),
          sin: Math.sin(x * d), cos: Math.cos(x * d), tan: Math.tan(x * d),
          asin: Math.asin(x) / d, acos: Math.acos(x) / d, atan: Math.atan(x) / d,
          ln: Math.log(x), log: Math.log10(x), 'e ^': Math.exp(x), '10 ^': Math.pow(10, x),
        }[op];
      },
      print: (...a) => sim.log(...a),
    };

    // Event hats are checked every physics step; each fires when its condition becomes true.
    sim.poll = () => {
      let fired = false;
      for (const h of handlers) {
        let cond = null;
        if (h.kind === 'color') cond = spike.color(h.args[0]) === h.args[1];
        else if (h.kind === 'distance') cond = spike.distanceIs(h.args[0], h.args[1], h.args[2], h.args[3]);
        else if (h.kind === 'timer') cond = spike.timer() > num(h.args[0]);
        else if (h.kind === 'button') cond = spike.buttonIs(h.args[0], h.args[1]);
        if (cond === null) continue;
        if (cond && !h.prev && !h.running) { spike.launch(h); fired = true; }
        h.prev = cond;
      }
      return fired;
    };

    const api = robot;
    return { robot, spike };
  }

  const api = {
    FIELD, ROBOT, PHYS, VARIATION, MAT, DRONE, DOCK_MODELS, ROBOT_MODELS, JOBS, HUB_PORTS, WIRING_DEFAULT, FAULTS_DEFAULT, FAULT_LIMITS, DT, MATCH_TIME, START, PORTS, ARM, HUB_IMAGES, SOUNDS, Sim,
    WHEELS, MOTORS, ATTACHMENTS, BUILD_DEFAULT, BUILD_LIMITS, normalizeBuild, ACCEL_SETTINGS, TOKEN_POINTS, MAX_HEIGHT,
    robotPoly, grabAction, releaseAction, classifyRGB,
    registerAttachment, unregisterAttachment, setRobotLook, getRobotLook: () => robotLook, attachmentVoxels, swingPoints, mountSpot, swingOf: customSwing,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BioGlow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
