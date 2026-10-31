/* BIOGLOW FLL robot simulator - SPIKE-style word blocks (Blockly 10, loaded from a CDN in index.html).
 * The palette mirrors the LEGO Education SPIKE App's word-block categories (Motors, Movement, Light,
 * Sound, Events, Control, Sensors, Operators, Variables, My Blocks) and the hub's ports:
 * A/B drive motors, C basket motor, D spare motor, E color sensor, F distance sensor.
 * Blocks compile to the simulator's `spike` API. If Blockly didn't load, BioGlowBlocks stays undefined.
 */
(function () {
  'use strict';
  if (!window.Blockly || !window.javascript) return;
  const { javascriptGenerator: gen, Order } = window.javascript;

  const C = {
    motors: '#0090f5', movement: '#ff4ccd', light: '#9966ff', sound: '#cf63cf', events: '#ffbf00',
    control: '#ffab19', sensors: '#5cb1d6', operators: '#59c059', variables: '#ff8c1a', myblocks: '#ff6680',
  };
  const PORTS = ['A', 'B', 'C', 'D', 'E', 'F'].map((p) => [p, p]);
  // every left+right pair, as in the SPIKE App (A+B first, then A+E for the Advanced Driving Base)
  const MOVE_PAIRS = ['A+B', 'A+E'].concat(PORTS.flatMap(([l]) => PORTS.filter(([r]) => r !== l).map(([r]) => l + '+' + r)).filter((p) => p !== 'A+B' && p !== 'A+E')).map((p) => [p, p]);
  const port = (dflt) => ({ type: 'field_dropdown', name: 'PORT', options: dflt ? [[dflt, dflt]].concat(PORTS.filter((p) => p[0] !== dflt)) : PORTS });
  const COLORS = [['black', 'black'], ['magenta', 'magenta'], ['violet', 'violet'], ['blue', 'blue'], ['azure', 'azure'],
    ['green', 'green'], ['yellow', 'yellow'], ['red', 'red'], ['white', 'white'], ['no color', 'none']];
  const DIR_MOTOR = [['↻', 'cw'], ['↺', 'ccw']];
  const DIR_MOVE = [['↑', 'fwd'], ['↓', 'back'], ['↻', 'cw'], ['↺', 'ccw']];
  const MOVE_UNITS = [['cm', 'cm'], ['in', 'in'], ['rotations', 'rotations'], ['degrees', 'degrees'], ['seconds', 'seconds']];
  const MOTOR_UNITS = [['rotations', 'rotations'], ['degrees', 'degrees'], ['seconds', 'seconds']];
  const DIST_OPS = [['closer than', 'closer than'], ['farther than', 'farther than'], ['exactly at', 'exactly at']];
  const DIST_UNITS = [['%', '%'], ['cm', 'cm'], ['in', 'in']];
  const IMAGES = ['heart', 'happy', 'sad', 'yes', 'no', 'arrow up', 'square', 'diamond', 'target', 'butterfly', 'ghost', 'skull'].map((i) => [i, i]);
  const SOUND_NAMES = ['Beep', 'Chime', 'Cheer', 'Win', 'Lose', 'Hello', 'Teleport', 'Laser'].map((x) => [x, x]);
  const BUTTONS = [['left', 'left'], ['right', 'right']];
  const PRESS = [['pressed', 'pressed'], ['released', 'released']];
  const dd = (name, options) => ({ type: 'field_dropdown', name, options });
  const val = (name, check) => ({ type: 'input_value', name, check });
  const stmt = (name) => ({ type: 'input_statement', name });

  const S = (colour, type, message0, args0, extra) => Object.assign({ type, message0, args0: args0 || [], colour, inputsInline: true, previousStatement: null, nextStatement: null }, extra);
  const R = (colour, type, message0, args0, output) => ({ type, message0, args0: args0 || [], colour, inputsInline: true, output: output === undefined ? 'Number' : output });
  const HAT = (type, message0, args0) => ({ type, message0, args0: args0 || [], colour: C.events, inputsInline: true, nextStatement: null });

  const DEFS = [
    // Motors
    S(C.motors, 'sp_motor_run', '%1 run %2 for %3 %4', [port('C'), dd('DIR', DIR_MOTOR), val('AMOUNT'), dd('UNIT', MOTOR_UNITS)]),
    S(C.motors, 'sp_motor_goto', '%1 go %2 to position %3', [port('C'), dd('MODE', [['shortest path', 'shortest'], ['clockwise', 'clockwise'], ['counterclockwise', 'counterclockwise']]), val('POS')]),
    S(C.motors, 'sp_motor_start', '%1 start motor %2', [port('C'), dd('DIR', DIR_MOTOR)]),
    S(C.motors, 'sp_motor_stop', '%1 stop motor', [port('C')]),
    S(C.motors, 'sp_motor_set_speed', '%1 set speed to %2 %%', [port('C'), val('SPEED')]),
    R(C.motors, 'sp_motor_position', '%1 position', [port('C')]),
    R(C.motors, 'sp_motor_relative', '%1 relative position', [port('C')]),
    S(C.motors, 'sp_motor_set_relative', 'set %1 relative position to %2', [port('C'), val('POS')]),
    R(C.motors, 'sp_motor_speed', '%1 speed', [port('C')]),

    // Movement
    S(C.movement, 'sp_move', 'move %1 for %2 %3', [dd('DIR', DIR_MOVE), val('AMOUNT'), dd('UNIT', MOVE_UNITS)]),
    S(C.movement, 'sp_move_steer', 'move steering %1 for %2 %3', [val('STEER'), val('AMOUNT'), dd('UNIT', MOVE_UNITS)]),
    S(C.movement, 'sp_start_moving', 'start moving %1', [dd('DIR', DIR_MOVE)]),
    S(C.movement, 'sp_start_steer', 'start moving steering %1', [val('STEER')]),
    S(C.movement, 'sp_move_tank', 'move with %1 %% and %2 %% for %3 %4', [val('L'), val('R'), val('AMOUNT'), dd('UNIT', MOVE_UNITS)]),
    S(C.movement, 'sp_start_tank', 'start moving with %1 %% and %2 %%', [val('L'), val('R')]),
    S(C.movement, 'sp_stop_moving', 'stop moving'),
    S(C.movement, 'sp_move_speed', 'set movement speed to %1 %%', [val('SPEED')]),
    S(C.movement, 'sp_move_motors', 'set movement motors to %1', [dd('PAIR', MOVE_PAIRS)]),
    S(C.movement, 'sp_rotation', 'set 1 motor rotation to %1 %2', [val('CM'), dd('UNIT', [['cm', 'cm'], ['in', 'in']])]),
    S(C.movement, 'sp_move_accel', 'set movement acceleration to %1', [dd('ACCEL', [['medium', 'medium'], ['slow', 'slow'], ['fast', 'fast']])]),
    S(C.movement, 'sp_move_stop', 'set movement motors to %1 at stop', [dd('STOP', [['brake', 'brake'], ['hold position', 'hold'], ['coast', 'coast']])]),

    // Light
    S(C.light, 'sp_image_for', 'turn on %1 for %2 seconds', [dd('IMAGE', IMAGES), val('SECS')]),
    S(C.light, 'sp_image', 'turn on %1', [dd('IMAGE', IMAGES)]),
    S(C.light, 'sp_write', 'write %1', [val('TEXT')]),
    S(C.light, 'sp_lights_off', 'turn off pixels'),
    S(C.light, 'sp_brightness', 'set pixel brightness to %1 %%', [val('P')]),
    S(C.light, 'sp_set_pixel', 'set pixel at %1 , %2 to %3 %%', [val('X'), val('Y'), val('P')]),
    S(C.light, 'sp_eyes', '%1 light up %2 %3 %4 %5', [port('F'), val('A'), val('B'), val('C2'), val('D')]),
    S(C.light, 'sp_center_light', 'set Center Button light to %1', [dd('COLOR', [['white', 'white'], ['red', 'red'], ['orange', 'orange'], ['yellow', 'yellow'],
      ['green', 'green'], ['azure', 'azure'], ['blue', 'blue'], ['violet', 'violet'], ['magenta', 'magenta'], ['off', 'off']])]),

    // Sound
    S(C.sound, 'sp_beep_for', 'play beep %1 for %2 seconds', [val('NOTE'), val('SECS')]),
    S(C.sound, 'sp_beep', 'start playing beep %1', [val('NOTE')]),
    S(C.sound, 'sp_play_sound', 'play sound %1 until done', [dd('SOUND', SOUND_NAMES)]),
    S(C.sound, 'sp_start_sound', 'start sound %1', [dd('SOUND', SOUND_NAMES)]),
    S(C.sound, 'sp_stop_sounds', 'stop all sounds'),
    S(C.sound, 'sp_change_volume', 'change volume by %1', [val('VOL')]),
    S(C.sound, 'sp_volume', 'set volume to %1 %%', [val('VOL')]),
    R(C.sound, 'sp_volume_value', 'volume'),

    // Events
    HAT('sp_when_start', 'when program starts'),
    HAT('sp_when_color', 'when %1 is color %2', [port('E'), dd('COLOR', COLORS)]),
    HAT('sp_when_distance', 'when %1 is %2 %3 %4', [port('F'), dd('OP', DIST_OPS), val('VALUE'), dd('UNIT', DIST_UNITS)]),
    HAT('sp_when_timer', 'when timer > %1', [val('VALUE')]),
    HAT('sp_when_button', 'when %1 Button %2', [dd('BTN', BUTTONS), dd('STATE', PRESS)]),
    HAT('sp_when_receive', 'when I receive %1', [{ type: 'field_input', name: 'MSG', text: 'message1' }]),
    S(C.events, 'sp_broadcast', 'broadcast %1', [{ type: 'field_input', name: 'MSG', text: 'message1' }]),
    S(C.events, 'sp_broadcast_wait', 'broadcast %1 and wait', [{ type: 'field_input', name: 'MSG', text: 'message1' }]),

    // Control
    S(C.control, 'sp_wait', 'wait %1 seconds', [val('SECS')]),
    S(C.control, 'sp_repeat', 'repeat %1 %2 %3', [val('TIMES'), { type: 'input_dummy' }, stmt('DO')], { inputsInline: false }),
    { type: 'sp_forever', message0: 'forever %1 %2', args0: [{ type: 'input_dummy' }, stmt('DO')], colour: C.control, previousStatement: null },
    S(C.control, 'sp_if', 'if %1 then %2 %3', [val('COND', 'Boolean'), { type: 'input_dummy' }, stmt('DO')], { inputsInline: false }),
    Object.assign(S(C.control, 'sp_ifelse', 'if %1 then %2 %3', [val('COND', 'Boolean'), { type: 'input_dummy' }, stmt('DO')], { inputsInline: false }),
      { message1: 'else %1', args1: [stmt('ELSE')] }),
    S(C.control, 'sp_wait_until', 'wait until %1', [val('COND', 'Boolean')]),
    S(C.control, 'sp_repeat_until', 'repeat until %1 %2 %3', [val('COND', 'Boolean'), { type: 'input_dummy' }, stmt('DO')], { inputsInline: false }),
    { type: 'sp_stop', message0: 'stop %1', args0: [dd('WHAT', [['all', 'all'], ['this stack', 'this stack']])], colour: C.control, previousStatement: null },

    // Sensors
    R(C.sensors, 'sp_is_color', '%1 is color %2 ?', [port('E'), dd('COLOR', COLORS)], 'Boolean'),
    R(C.sensors, 'sp_color', '%1 color', [port('E')], 'String'),
    R(C.sensors, 'sp_is_reflection', '%1 is reflected light %2 %3 %% ?', [port('E'), dd('OP', [['<', '<'], ['>', '>'], ['=', '=']]), val('VALUE')], 'Boolean'),
    R(C.sensors, 'sp_reflection', '%1 reflected light', [port('E')]),
    R(C.sensors, 'sp_is_distance', '%1 is %2 %3 %4 ?', [port('F'), dd('OP', DIST_OPS), val('VALUE'), dd('UNIT', DIST_UNITS)], 'Boolean'),
    R(C.sensors, 'sp_distance', '%1 distance in %2', [port('F'), dd('UNIT', DIST_UNITS)]),
    R(C.sensors, 'sp_angle', '%1 angle', [dd('AXIS', [['yaw', 'yaw'], ['pitch', 'pitch'], ['roll', 'roll']])]),
    S(C.sensors, 'sp_set_yaw', 'set yaw angle to %1', [val('VALUE')]),
    R(C.sensors, 'sp_button_is', 'is %1 Button %2 ?', [dd('BTN', BUTTONS), dd('STATE', PRESS)], 'Boolean'),
    R(C.sensors, 'sp_timer', 'timer'),
    S(C.sensors, 'sp_reset_timer', 'reset timer'),

    // Operators (Scratch style)
    ...[['op_add', '+'], ['op_sub', '-'], ['op_mul', '*'], ['op_div', '/']].map(([t, o]) => R(C.operators, t, '%1 ' + o + ' %2', [val('A'), val('B')])),
    R(C.operators, 'op_random', 'pick random %1 to %2', [val('A'), val('B')]),
    ...[['op_gt', '>'], ['op_lt', '<'], ['op_eq', '=']].map(([t, o]) => R(C.operators, t, '%1 ' + o + ' %2', [val('A'), val('B')], 'Boolean')),
    R(C.operators, 'op_and', '%1 and %2', [val('A', 'Boolean'), val('B', 'Boolean')], 'Boolean'),
    R(C.operators, 'op_or', '%1 or %2', [val('A', 'Boolean'), val('B', 'Boolean')], 'Boolean'),
    R(C.operators, 'op_not', 'not %1', [val('A', 'Boolean')], 'Boolean'),
    R(C.operators, 'op_join', 'join %1 %2', [val('A'), val('B')], 'String'),
    R(C.operators, 'op_letter', 'letter %1 of %2', [val('A'), val('B')], 'String'),
    R(C.operators, 'op_length', 'length of %1', [val('A')]),
    R(C.operators, 'op_contains', '%1 contains %2 ?', [val('A'), val('B')], 'Boolean'),
    R(C.operators, 'op_mod', '%1 mod %2', [val('A'), val('B')]),
    R(C.operators, 'op_round', 'round %1', [val('A')]),
    R(C.operators, 'op_mathop', '%1 of %2', [dd('OP', ['abs', 'floor', 'ceiling', 'sqrt', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'ln', 'log', 'e ^', '10 ^'].map((o) => [o, o])), val('A')]),
  ];
  // Category icon at the start of each hardware block, as in the SPIKE App.
  const svg = (body) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>');
  const ICONS = {
    [C.motors]: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v10M7 12h10"/>'),
    [C.movement]: svg('<rect x="4" y="5" width="5" height="14" rx="2"/><rect x="15" y="5" width="5" height="14" rx="2"/><path d="M9 12h6"/>'),
    [C.light]: svg('<g fill="white" stroke="none"><circle cx="6" cy="6" r="2"/><circle cx="12" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="12" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></g>'),
    [C.sound]: svg('<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/>'),
    [C.sensors]: svg('<circle cx="12" cy="12" r="3"/><path d="M5 12a7 7 0 0 1 14 0M2 12a10 10 0 0 1 20 0"/>'),
  };
  for (const d of DEFS) {
    const icon = ICONS[d.colour];
    if (!icon || !d.message0) continue;
    d.message0 = '%1 ' + d.message0.replace(/%(\d+)/g, (m, k) => '%' + (Number(k) + 1));
    d.args0 = [{ type: 'field_image', src: icon, width: 18, height: 18, alt: '' }].concat(d.args0);
  }
  Blockly.defineBlocksWithJsonArray(DEFS);

  const TIPS = {
    sp_motor_run: 'Run one motor a set amount. Clockwise is as seen looking at the motor face. Port C opens and closes the basket.',
    sp_motor_goto: 'Turn the motor to an absolute position (0-359 degrees).',
    sp_motor_start: 'Start the motor and keep it running until you stop it.',
    sp_motor_stop: 'Stop this motor.',
    sp_motor_set_speed: 'Speed used by this motor\'s run, go to position and start blocks (default 75%).',
    sp_motor_position: 'Absolute position, 0 to 359 degrees.',
    sp_motor_relative: 'Degrees turned since the program started (or since you last set it).',
    sp_motor_set_relative: 'Set what the relative position counts from.',
    sp_motor_speed: 'Current speed of the motor in %.',
    sp_move: 'Drive both movement motors. Distance is measured with the motor encoders only, no gyro. \u21bb/\u21ba spin in place.',
    sp_move_steer: 'Steering 0 = straight, 50 = one wheel stopped, 100 = spin in place. Negative steers left.',
    sp_start_moving: 'Start driving and keep going until "stop moving".',
    sp_start_steer: 'Start driving with steering and keep going.',
    sp_move_tank: 'Set the left and right motor speeds separately (tank drive).',
    sp_start_tank: 'Start driving with separate left and right speeds.',
    sp_stop_moving: 'Stop both movement motors.',
    sp_move_speed: 'Speed used by the move and start moving blocks (default 50%).',
    sp_move_motors: 'Which ports are the left and right movement motors (this robot uses A+B).',
    sp_rotation: 'How far the robot travels in one wheel rotation. 56 mm wheels travel about 17.6 cm.',
    sp_move_accel: 'How quickly the robot speeds up and slows down. Fast saves time but the wheels can slip; slow is gentler on loose models.',
    sp_move_stop: 'What the drive motors do when they stop: brake (stop quickly), hold position (fight back if pushed) or coast (roll to a stop).',
    sp_image_for: 'Show an image on the 5x5 light matrix for a while.',
    sp_image: 'Show an image on the light matrix.',
    sp_write: 'Scroll text across the light matrix.',
    sp_lights_off: 'Turn off every pixel on the light matrix.',
    sp_brightness: 'Brightness used for images and text.',
    sp_set_pixel: 'Light one pixel. x and y go from 1 to 5, starting top-left.',
    sp_eyes: 'Light the four segments around the distance sensor\'s eyes (0-100% each).',
    sp_center_light: 'Change the color of the hub\'s Center Button light.',
    sp_beep_for: 'Play a beep. 60 is middle C; each step is a semitone.',
    sp_beep: 'Start a beep that keeps playing until "stop all sounds".',
    sp_play_sound: 'Play a sound and wait for it to finish.',
    sp_start_sound: 'Start a sound and carry on straight away.',
    sp_stop_sounds: 'Stop all sounds.',
    sp_change_volume: 'Change the volume by this much.',
    sp_volume: 'Set the volume (0-100%).',
    sp_volume_value: 'Current volume in %.',
    sp_when_start: 'Blocks under this run when you press Run.',
    sp_when_color: 'Runs each time the color sensor starts seeing this color.',
    sp_when_distance: 'Runs each time the distance sensor reading crosses this value.',
    sp_when_timer: 'Runs once the timer passes this many seconds.',
    sp_when_button: 'Runs when you press or release the hub button (click the buttons on the hub under the field).',
    sp_when_receive: 'Runs when another stack broadcasts this message.',
    sp_broadcast: 'Start every "when I receive" stack with this message.',
    sp_broadcast_wait: 'Start the receivers and wait until they have all finished.',
    sp_wait: 'Pause this stack.',
    sp_repeat: 'Run the blocks inside this many times.',
    sp_forever: 'Run the blocks inside over and over.',
    sp_if: 'Run the blocks inside only if the condition is true.',
    sp_ifelse: 'Run the first set of blocks if the condition is true, otherwise the second.',
    sp_wait_until: 'Pause this stack until the condition is true.',
    sp_repeat_until: 'Repeat the blocks inside until the condition is true.',
    sp_stop: '"all" ends the whole program; "this stack" ends only this stack.',
    sp_is_color: 'True when the color sensor (port E) sees this color.',
    sp_color: 'The color the color sensor sees.',
    sp_is_reflection: 'Compare the reflected light (0 = black, 100 = white).',
    sp_reflection: 'Reflected light, 0 (black) to 100 (white).',
    sp_is_distance: 'Compare the distance sensor (port F) reading.',
    sp_distance: 'Distance to the nearest thing ahead (-1 if nothing within 200 cm).',
    sp_angle: 'Yaw counts up when the robot turns right and wraps at \u00b1180. Pitch and roll stay 0 on a flat table.',
    sp_set_yaw: 'Set what the yaw angle reads right now (usually 0 before a turn).',
    sp_button_is: 'True while that hub button is pressed (or released).',
    sp_timer: 'Seconds since the program started or the timer was reset.',
    sp_reset_timer: 'Set the timer back to 0.',
  };
  for (const [type, tip] of Object.entries(TIPS)) {
    const init = Blockly.Blocks[type].init;
    Blockly.Blocks[type].init = function () { init.call(this); this.setTooltip(tip); };
  }
  // Scratch-style rounded hats on the event blocks.
  for (const t of ['sp_when_start', 'sp_when_color', 'sp_when_distance', 'sp_when_timer', 'sp_when_button', 'sp_when_receive']) {
    const init = Blockly.Blocks[t].init;
    Blockly.Blocks[t].init = function () { init.call(this); this.hat = 'cap'; };
  }
  Object.assign(Blockly.Msg, {
    PROCEDURES_DEFNORETURN_TITLE: 'define', PROCEDURES_DEFNORETURN_PROCEDURE: 'my block',
    PROCEDURES_BEFORE_PARAMS: 'with:', PROCEDURES_CALL_BEFORE_PARAMS: 'with:',
    NEW_VARIABLE: 'Make a Variable', VARIABLES_SET: 'set %1 to %2', MATH_CHANGE_TITLE: 'change %1 by %2',
  });

  // ---- code generation -> spike API ---------------------------------------------
  const v = (b, name, dflt) => gen.valueToCode(b, name, Order.NONE) || dflt;
  const n = (b, name, dflt) => 'Number(' + v(b, name, dflt) + ')';
  const q = (s) => JSON.stringify(String(s));
  const P = (b) => q(b.getFieldValue('PORT'));
  const F = (b, name) => q(b.getFieldValue(name));
  const body = (b, name) => gen.statementToCode(b, name);
  const call = (s) => [s, Order.FUNCTION_CALL];
  const yieldLine = gen.INDENT + 'await spike.wait(0);\n';
  const f = gen.forBlock;

  f.sp_motor_run = (b) => 'await spike.motorRun(' + P(b) + ', ' + F(b, 'DIR') + ', ' + n(b, 'AMOUNT', '1') + ', ' + F(b, 'UNIT') + ');\n';
  f.sp_motor_goto = (b) => 'await spike.motorGoTo(' + P(b) + ', ' + F(b, 'MODE') + ', ' + n(b, 'POS', '0') + ');\n';
  f.sp_motor_start = (b) => 'spike.motorStart(' + P(b) + ', ' + F(b, 'DIR') + ');\n';
  f.sp_motor_stop = (b) => 'spike.motorStop(' + P(b) + ');\n';
  f.sp_motor_set_speed = (b) => 'spike.motorSetSpeed(' + P(b) + ', ' + n(b, 'SPEED', '75') + ');\n';
  f.sp_motor_position = (b) => call('spike.motorPosition(' + P(b) + ')');
  f.sp_motor_relative = (b) => call('spike.motorRelative(' + P(b) + ')');
  f.sp_motor_set_relative = (b) => 'spike.motorSetRelative(' + P(b) + ', ' + n(b, 'POS', '0') + ');\n';
  f.sp_motor_speed = (b) => call('spike.motorSpeed(' + P(b) + ')');

  f.sp_move = (b) => 'await spike.move(' + F(b, 'DIR') + ', ' + n(b, 'AMOUNT', '10') + ', ' + F(b, 'UNIT') + ');\n';
  f.sp_move_steer = (b) => 'await spike.moveSteer(' + n(b, 'STEER', '0') + ', ' + n(b, 'AMOUNT', '10') + ', ' + F(b, 'UNIT') + ');\n';
  f.sp_start_moving = (b) => 'spike.startMoving(' + F(b, 'DIR') + ');\n';
  f.sp_start_steer = (b) => 'spike.startSteer(' + n(b, 'STEER', '0') + ');\n';
  f.sp_move_tank = (b) => 'await spike.moveTank(' + n(b, 'L', '50') + ', ' + n(b, 'R', '50') + ', ' + n(b, 'AMOUNT', '10') + ', ' + F(b, 'UNIT') + ');\n';
  f.sp_start_tank = (b) => 'spike.startTank(' + n(b, 'L', '50') + ', ' + n(b, 'R', '50') + ');\n';
  f.sp_stop_moving = () => 'spike.stopMoving();\n';
  f.sp_move_speed = (b) => 'spike.setMoveSpeed(' + n(b, 'SPEED', '50') + ');\n';
  f.sp_move_motors = (b) => 'spike.setMoveMotors(' + F(b, 'PAIR') + ');\n';
  f.sp_move_accel = (b) => 'spike.setMoveAccel(' + F(b, 'ACCEL') + ');\n';
  f.sp_move_stop = (b) => 'spike.setStopMode(' + F(b, 'STOP') + ');\n';
  f.sp_rotation = (b) => 'spike.setRotation(' + n(b, 'CM', '17.5') + ', ' + F(b, 'UNIT') + ');\n';

  f.sp_image_for = (b) => 'await spike.image(' + F(b, 'IMAGE') + ', ' + n(b, 'SECS', '2') + ');\n';
  f.sp_image = (b) => 'spike.image(' + F(b, 'IMAGE') + ');\n';
  f.sp_write = (b) => 'spike.write(' + v(b, 'TEXT', "''") + ');\n';
  f.sp_lights_off = () => 'spike.lightsOff();\n';
  f.sp_center_light = (b) => 'spike.centerLight(' + F(b, 'COLOR') + ');\n';
  f.sp_brightness = (b) => 'spike.setBrightness(' + n(b, 'P', '75') + ');\n';
  f.sp_set_pixel = (b) => 'spike.setPixel(' + n(b, 'X', '1') + ', ' + n(b, 'Y', '1') + ', ' + n(b, 'P', '100') + ');\n';
  f.sp_eyes = (b) => 'spike.eyes(' + P(b) + ', ' + ['A', 'B', 'C2', 'D'].map((k) => n(b, k, '100')).join(', ') + ');\n';

  f.sp_beep_for = (b) => 'await spike.beep(' + n(b, 'NOTE', '60') + ', ' + n(b, 'SECS', '0.2') + ');\n';
  f.sp_beep = (b) => 'spike.beep(' + n(b, 'NOTE', '60') + ');\n';
  f.sp_stop_sounds = () => 'spike.stopSounds();\n';
  f.sp_play_sound = (b) => 'await spike.playSound(' + F(b, 'SOUND') + ', true);\n';
  f.sp_start_sound = (b) => 'spike.playSound(' + F(b, 'SOUND') + ', false);\n';
  f.sp_change_volume = (b) => 'spike.changeVolume(' + n(b, 'VOL', '-10') + ');\n';
  f.sp_volume_value = () => call('spike.volume()');
  f.sp_button_is = (b) => call('spike.buttonIs(' + F(b, 'BTN') + ', ' + F(b, 'STATE') + ')');
  f.sp_volume = (b) => 'spike.setVolume(' + n(b, 'VOL', '100') + ');\n';

  f.sp_broadcast = (b) => 'spike.broadcast(' + F(b, 'MSG') + ');\n';
  f.sp_broadcast_wait = (b) => 'await spike.broadcastAndWait(' + F(b, 'MSG') + ');\n';
  for (const t of ['sp_when_start', 'sp_when_color', 'sp_when_distance', 'sp_when_timer', 'sp_when_button', 'sp_when_receive']) f[t] = () => '';

  // Loops hand control back to the hub every pass, so a busy loop never freezes the page.
  f.sp_wait = (b) => 'await spike.wait(' + n(b, 'SECS', '1') + ');\n';
  f.sp_repeat = (b) => 'for (let i = 0, n = ' + n(b, 'TIMES', '10') + '; i < n; i++) {\n' + yieldLine + body(b, 'DO') + '}\n';
  f.sp_forever = (b) => 'while (true) {\n' + yieldLine + body(b, 'DO') + '}\n';
  f.sp_if = (b) => 'if (' + v(b, 'COND', 'false') + ') {\n' + body(b, 'DO') + '}\n';
  f.sp_ifelse = (b) => 'if (' + v(b, 'COND', 'false') + ') {\n' + body(b, 'DO') + '} else {\n' + body(b, 'ELSE') + '}\n';
  f.sp_wait_until = (b) => 'while (!(' + v(b, 'COND', 'false') + ')) {\n' + yieldLine + '}\n';
  f.sp_repeat_until = (b) => 'while (!(' + v(b, 'COND', 'false') + ')) {\n' + yieldLine + body(b, 'DO') + '}\n';
  f.sp_stop = (b) => 'await spike.stop(' + F(b, 'WHAT') + ');\n';

  f.sp_is_color = (b) => call('spike.colorIs(' + P(b) + ', ' + F(b, 'COLOR') + ')');
  f.sp_color = (b) => call('spike.color(' + P(b) + ')');
  f.sp_is_reflection = (b) => call('spike.reflectionIs(' + P(b) + ', ' + F(b, 'OP') + ', ' + n(b, 'VALUE', '50') + ')');
  f.sp_reflection = (b) => call('spike.reflection(' + P(b) + ')');
  f.sp_is_distance = (b) => call('spike.distanceIs(' + P(b) + ', ' + F(b, 'OP') + ', ' + n(b, 'VALUE', '15') + ', ' + F(b, 'UNIT') + ')');
  f.sp_distance = (b) => call('spike.distance(' + P(b) + ', ' + F(b, 'UNIT') + ')');
  f.sp_angle = (b) => call('spike.angle(' + F(b, 'AXIS') + ')');
  f.sp_set_yaw = (b) => 'spike.setYaw(' + n(b, 'VALUE', '0') + ');\n';
  f.sp_timer = () => call('spike.timer()');
  f.sp_reset_timer = () => 'spike.resetTimer();\n';

  const bin = (op, order) => (b) => ['(' + n(b, 'A', '0') + ' ' + op + ' ' + n(b, 'B', '0') + ')', order];
  f.op_add = bin('+', Order.ADDITION);
  f.op_sub = bin('-', Order.SUBTRACTION);
  f.op_mul = bin('*', Order.MULTIPLICATION);
  f.op_div = bin('/', Order.DIVISION);
  f.op_gt = bin('>', Order.RELATIONAL);
  f.op_lt = bin('<', Order.RELATIONAL);
  f.op_eq = (b) => call('spike.eq(' + v(b, 'A', "''") + ', ' + v(b, 'B', "''") + ')');
  f.op_random = (b) => call('spike.random(' + n(b, 'A', '1') + ', ' + n(b, 'B', '10') + ')');
  f.op_and = (b) => ['(' + v(b, 'A', 'false') + ' && ' + v(b, 'B', 'false') + ')', Order.LOGICAL_AND];
  f.op_or = (b) => ['(' + v(b, 'A', 'false') + ' || ' + v(b, 'B', 'false') + ')', Order.LOGICAL_OR];
  f.op_not = (b) => ['!(' + v(b, 'A', 'false') + ')', Order.LOGICAL_NOT];
  f.op_join = (b) => ['(String(' + v(b, 'A', "''") + ') + String(' + v(b, 'B', "''") + '))', Order.ADDITION];
  f.op_letter = (b) => call('(String(' + v(b, 'B', "''") + ').charAt(' + n(b, 'A', '1') + ' - 1))');
  f.op_length = (b) => call('String(' + v(b, 'A', "''") + ').length');
  f.op_contains = (b) => call('String(' + v(b, 'A', "''") + ').toLowerCase().includes(String(' + v(b, 'B', "''") + ').toLowerCase())');
  f.op_mod = (b) => call('spike.mod(' + n(b, 'A', '0') + ', ' + n(b, 'B', '1') + ')');
  f.op_round = (b) => call('Math.round(' + n(b, 'A', '0') + ')');
  f.op_mathop = (b) => call('spike.mathop(' + F(b, 'OP') + ', ' + n(b, 'A', '0') + ')');

  // My Blocks run as async functions so they can contain movement blocks.
  const callNoReturn = f.procedures_callnoreturn;
  f.procedures_callnoreturn = (b, g) => 'await ' + callNoReturn(b, g);

  const HATS = {
    sp_when_start: () => "'start', []",
    sp_when_color: (b) => "'color', [" + P(b) + ', ' + F(b, 'COLOR') + ']',
    sp_when_distance: (b) => "'distance', [" + P(b) + ', ' + F(b, 'OP') + ', ' + n(b, 'VALUE', '15') + ', ' + F(b, 'UNIT') + ']',
    sp_when_timer: (b) => "'timer', [" + n(b, 'VALUE', '5') + ']',
    sp_when_button: (b) => "'button', [" + F(b, 'BTN') + ', ' + F(b, 'STATE') + ']',
    sp_when_receive: (b) => "'receive', [" + F(b, 'MSG') + ']',
  };

  // ---- toolbox -------------------------------------------------------------------
  const N = (num) => ({ shadow: { type: 'math_number', fields: { NUM: num } } });
  const TXT = (t) => ({ shadow: { type: 'text', fields: { TEXT: t } } });
  const blk = (type, inputs, fields) => ({ kind: 'block', type, inputs, fields });
  const TOOLBOX = {
    kind: 'categoryToolbox',
    contents: [
      { kind: 'category', name: 'Motors', colour: C.motors, contents: [
        blk('sp_motor_run', { AMOUNT: N(1) }),
        blk('sp_motor_goto', { POS: N(0) }),
        blk('sp_motor_start'), blk('sp_motor_stop'),
        blk('sp_motor_set_speed', { SPEED: N(75) }),
        blk('sp_motor_position'), blk('sp_motor_relative'),
        blk('sp_motor_set_relative', { POS: N(0) }),
        blk('sp_motor_speed'),
      ] },
      { kind: 'category', name: 'Movement', colour: C.movement, contents: [
        blk('sp_move', { AMOUNT: N(10) }),
        blk('sp_move_steer', { STEER: N(30), AMOUNT: N(10) }),
        blk('sp_start_moving'),
        blk('sp_start_steer', { STEER: N(30) }),
        blk('sp_move_tank', { L: N(50), R: N(50), AMOUNT: N(10) }),
        blk('sp_start_tank', { L: N(50), R: N(50) }),
        blk('sp_stop_moving'),
        blk('sp_move_speed', { SPEED: N(50) }),
        blk('sp_move_motors'),
        blk('sp_rotation', { CM: N(17.5) }),
        blk('sp_move_accel'), blk('sp_move_stop'),
      ] },
      { kind: 'category', name: 'Light', colour: C.light, contents: [
        blk('sp_image_for', { SECS: N(2) }), blk('sp_image'),
        blk('sp_write', { TEXT: TXT('Hello') }), blk('sp_lights_off'),
        blk('sp_brightness', { P: N(75) }), blk('sp_set_pixel', { X: N(1), Y: N(1), P: N(100) }),
        blk('sp_center_light'), blk('sp_eyes', { A: N(100), B: N(100), C2: N(100), D: N(100) }),
      ] },
      { kind: 'category', name: 'Sound', colour: C.sound, contents: [
        blk('sp_play_sound'), blk('sp_start_sound'),
        blk('sp_beep_for', { NOTE: N(60), SECS: N(0.2) }), blk('sp_beep', { NOTE: N(60) }),
        blk('sp_stop_sounds'), blk('sp_change_volume', { VOL: N(-10) }), blk('sp_volume', { VOL: N(100) }), blk('sp_volume_value'),
      ] },
      { kind: 'category', name: 'Events', colour: C.events, contents: [
        blk('sp_when_start'), blk('sp_when_color'),
        blk('sp_when_distance', { VALUE: N(15) }), blk('sp_when_timer', { VALUE: N(5) }),
        blk('sp_when_button'), blk('sp_when_receive'), blk('sp_broadcast'), blk('sp_broadcast_wait'),
      ] },
      { kind: 'category', name: 'Control', colour: C.control, contents: [
        blk('sp_wait', { SECS: N(1) }), blk('sp_repeat', { TIMES: N(10) }), blk('sp_forever'),
        blk('sp_if'), blk('sp_ifelse'), blk('sp_wait_until'), blk('sp_repeat_until'), blk('sp_stop'),
      ] },
      { kind: 'category', name: 'Sensors', colour: C.sensors, contents: [
        blk('sp_is_color'), blk('sp_color'),
        blk('sp_is_reflection', { VALUE: N(50) }), blk('sp_reflection'),
        blk('sp_is_distance', { VALUE: N(15) }), blk('sp_distance'),
        blk('sp_angle'), blk('sp_set_yaw', { VALUE: N(0) }),
        blk('sp_button_is'), blk('sp_timer'), blk('sp_reset_timer'),
      ] },
      { kind: 'category', name: 'Operators', colour: C.operators, contents: [
        blk('op_add', { A: N(''), B: N('') }), blk('op_sub', { A: N(''), B: N('') }),
        blk('op_mul', { A: N(''), B: N('') }), blk('op_div', { A: N(''), B: N('') }),
        blk('op_random', { A: N(1), B: N(10) }),
        blk('op_gt', { A: N(''), B: N(50) }), blk('op_lt', { A: N(''), B: N(50) }), blk('op_eq', { A: N(''), B: N(50) }),
        blk('op_and'), blk('op_or'), blk('op_not'),
        blk('op_join', { A: TXT('apple'), B: TXT('banana') }), blk('op_letter', { A: N(1), B: TXT('apple') }),
        blk('op_length', { A: TXT('apple') }), blk('op_contains', { A: TXT('apple'), B: TXT('a') }),
        blk('op_mod', { A: N(''), B: N('') }), blk('op_round', { A: N('') }), blk('op_mathop', { A: N('') }),
      ] },
      { kind: 'category', name: 'Variables', colour: C.variables, custom: 'VARIABLE' },
      { kind: 'category', name: 'My Blocks', colour: C.myblocks, custom: 'MYBLOCKS' },
    ],
  };

  // ---- example program -------------------------------------------------------------
  // M03 flip the rock and put it back, M08 hook the vine and pull it down, then M02 knock the three seeds
  // off the stalk, using a gyro "turn to" My Block (the JavaScript example also delivers the keystone for M13).
  const chain = (list) => {
    const head = { ...list[0] };
    let cur = head;
    for (const b of list.slice(1)) { cur.next = { block: { ...b } }; cur = cur.next.block; }
    return head;
  };
  const move = (dir, amount, unit) => ({ type: 'sp_move', fields: { DIR: dir, UNIT: unit || 'cm' }, inputs: { AMOUNT: N(amount) } });
  const speed = (p) => ({ type: 'sp_move_speed', inputs: { SPEED: N(p) } });
  const motor = (dir, deg) => ({ type: 'sp_motor_run', fields: { PORT: 'C', DIR: dir, UNIT: 'degrees' }, inputs: { AMOUNT: N(deg) } });
  const varGet = (name) => ({ block: { type: 'variables_get', fields: { VAR: { name } } } });
  // "turn to angle": spin until the yaw reads `angle` (the yaw was set to 0 facing east at the start),
  // taking the short way round. Absolute angles fix any knock the robot took on the way.
  const turnTo = (d) => ({ type: 'procedures_callnoreturn', extraState: { name: 'turn to', params: ['angle'] }, inputs: { ARG0: { block: { type: 'math_number', fields: { NUM: d } } } } });
  const yaw = () => ({ block: { type: 'sp_angle', fields: { AXIS: 'yaw' } } });
  const op = (type, A, B) => ({ block: { type, inputs: { A, B } } });
  // how far to turn, -180..180: ((angle - yaw + 540) mod 360) - 180
  const turnError = () => op('op_sub', op('op_mod', op('op_add', op('op_sub', varGet('angle'), yaw()), N(540)), N(360)), N(180));
  const spin = () => ({ type: 'sp_ifelse', inputs: {
    COND: op('op_gt', turnError(), N(0)),
    DO: { block: { type: 'sp_start_steer', inputs: { STEER: N(100) } } },
    ELSE: { block: { type: 'sp_start_steer', inputs: { STEER: N(-100) } } },
  } });
  const waitTurn = (deg) => ({ type: 'sp_wait_until', inputs: { COND: op('op_lt', { block: { type: 'op_mathop', fields: { OP: 'abs' }, inputs: { A: turnError() } } }, N(deg)) } });
  const turnToDef = {
    type: 'procedures_defnoreturn', x: 560, y: 24, fields: { NAME: 'turn to' }, extraState: { params: [{ name: 'angle' }] },
    inputs: { STACK: { block: chain([
      // fast most of the way, then slowly for the last few degrees so the robot doesn't overshoot
      speed(25), spin(), waitTurn(12),
      speed(6), spin(), waitTurn(1),
      { type: 'sp_stop_moving' },
      speed(50),
    ]) } },
  };
  // yaw angles: 0 = east (the start), -90 = north, 180 = west, 90 = south
  const EXAMPLE = {
    blocks: { languageVersion: 0, blocks: [
      { ...chain([
        { type: 'sp_when_start' },
        { type: 'sp_set_yaw', inputs: { VALUE: N(0) } },
        { type: 'sp_write', inputs: { TEXT: TXT('M03') } },
        motor('cw', 90), // close the basket on the keystone species
        move('fwd', 20),
        turnTo(-90), move('fwd', 48.3),
        turnTo(180), // face the rock: the keystone pushes its lever
        speed(30), move('fwd', 8), move('back', 4), move('fwd', 4.5), speed(50), move('back', 8.5),
        { type: 'sp_write', inputs: { TEXT: TXT('M08') } },
        turnTo(0), move('fwd', 15.7),
        turnTo(-90), move('fwd', 12.6), // north, the basket over the vine on the tree
        motor('ccw', 90), motor('cw', 90), // open and close the basket: it hooks the vine (and keeps the keystone)
        move('back', 10), // pull the vine down onto the mat
        motor('ccw', 90), // let go
        move('back', 6),
        { type: 'sp_write', inputs: { TEXT: TXT('M02') } },
        turnTo(180), move('fwd', 7.2), turnTo(90), move('fwd', 25.5),
        turnTo(-45), // square on to the seed pod
        speed(30), move('fwd', 6.8), move('back', 4),
        { type: 'sp_repeat', inputs: { TIMES: N(2), DO: { block: chain([move('fwd', 5), move('back', 4)]) } } },
        speed(50), move('back', 6),
        { type: 'sp_image', fields: { IMAGE: 'happy' } },
        { type: 'sp_play_sound', fields: { SOUND: 'Win' } },
      ]), x: 24, y: 24 },
      turnToDef,
    ] },
  };

  // A new program, as the SPIKE App starts one: just "when program starts".
  const EMPTY = { blocks: { languageVersion: 0, blocks: [{ type: 'sp_when_start', x: 24, y: 24 }] } };

  // JavaScript for every event stack plus My Block definitions, or null if there is no event block.
  function generate(ws) {
    gen.init(ws);
    let code = '';
    for (const b of ws.getTopBlocks(true)) {
      if (!b.isEnabled()) continue;
      if (b.type === 'procedures_defnoreturn' || b.type === 'procedures_defreturn') { gen.blockToCode(b); continue; }
      if (!HATS[b.type]) continue;
      const inner = gen.blockToCode(b.getNextBlock()) || '';
      code += 'spike.when(' + HATS[b.type](b) + ', async () => {\n' + gen.prefixLines(inner, gen.INDENT) + '});\n';
    }
    if (!code) return null;
    return gen.finish(code).replace(/^function /gm, 'async function ');
  }

  // Compile a saved block program without showing it (used by tests and file checks).
  function compile(json) {
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(json || EXAMPLE, ws);
    const code = generate(ws);
    ws.dispose();
    return code;
  }

  function inject(el, onChange, look) {
    // The workspace follows the Look setting (Setup tab); the blocks keep their SPIKE colours.
    const SURFACES = {
      light: ['#f4f5f7', '#ffffff', '#3d3d3d', '#e9eef2', '#cfd6dd', '#000000'],
      dark: ['#232221', '#2b2a28', '#ebe7e2', '#33312f', '#55524e', '#ffffff'],
      'contrast-dark': ['#000000', '#000000', '#ffffff', '#1a1a1a', '#ffffff', '#ffffff'],
      'contrast-light': ['#ffffff', '#ffffff', '#000000', '#eeeeee', '#000000', '#000000'],
    };
    const themes = {};
    const themeFor = (look) => themes[look] || (themes[look] = make(look));
    const make = (look) => {
      const [bg, box, boxFg, fly, bar, mark] = SURFACES[look] || SURFACES.light;
      return Blockly.Theme.defineTheme('bioglow-spike-' + look, {
        base: Blockly.Themes.Zelos || Blockly.Themes.Classic,
        blockStyles: {
          variable_blocks: { colourPrimary: C.variables, colourSecondary: '#ec7b0e', colourTertiary: '#db6e00' },
          variable_dynamic_blocks: { colourPrimary: C.variables, colourSecondary: '#ec7b0e', colourTertiary: '#db6e00' },
          procedure_blocks: { colourPrimary: C.myblocks, colourSecondary: '#ff4d6a', colourTertiary: '#ff3355' },
        },
        componentStyles: {
          workspaceBackgroundColour: bg, toolboxBackgroundColour: box, toolboxForegroundColour: boxFg,
          flyoutBackgroundColour: fly, flyoutForegroundColour: boxFg, flyoutOpacity: 1,
          scrollbarColour: bar, insertionMarkerColour: mark, cursorColour: '#0090f5',
        },
        fontStyle: { family: 'system-ui, sans-serif', weight: '600', size: 11 },
      });
    };
    const theme = themeFor(look);
    const ws = Blockly.inject(el, {
      toolbox: TOOLBOX, renderer: 'zelos', theme, trashcan: true, sounds: false,
      zoom: { controls: true, wheel: true, startScale: 0.65, maxScale: 2, minScale: 0.3 },
      grid: { spacing: 24, length: 2, colour: '#dde3e8', snap: true },
      move: { scrollbars: true, drag: true, wheel: false },
    });
    ws.registerToolboxCategoryCallback('MYBLOCKS', (w) => {
      const items = [{ kind: 'block', type: 'procedures_defnoreturn' }];
      for (const [name, params] of Blockly.Procedures.allProcedures(w)[0]) {
        items.push({ kind: 'block', type: 'procedures_callnoreturn', extraState: { name, params } });
      }
      return items;
    });
    ws.addChangeListener((e) => { if (!e.isUiEvent) onChange(); });
    new ResizeObserver(() => Blockly.svgResize(ws)).observe(el);

    return {
      workspace: ws,
      getCode: () => generate(ws),
      save: () => Blockly.serialization.workspaces.save(ws),
      load(json) { Blockly.serialization.workspaces.load(json, ws); },
      loadExample() { Blockly.serialization.workspaces.load(EXAMPLE, ws); },
      loadEmpty() { Blockly.serialization.workspaces.load(EMPTY, ws); },
      setLook(l) { ws.setTheme(themeFor(l)); },
    };
  }

  window.BioGlowBlocks = { inject, compile, EXAMPLE, EMPTY };
})();
