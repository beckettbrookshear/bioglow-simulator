/* BIOGLOW FLL robot simulator - LEGO Education SPIKE App 3 project files (.llsp3).
 * An .llsp3 is a zip with manifest.json, icon.svg and scratch.sb3; scratch.sb3 is another zip whose
 * project.json is a Scratch 3 project using the SPIKE App's opcodes (flippermove_move, ...). The opcodes,
 * input names, shadow blocks and menu values below follow projects saved by the SPIKE App itself.
 * exportLlsp3(blocksJson, name) builds the file from a saved Blockly workspace; importLlsp3(data) reads one back.
 * Needs Blockly, JSZip and sim.js (for the hub images and sounds). If any is missing, SpikeFile stays undefined.
 */
(function () {
  'use strict';
  if (!window.Blockly || !window.JSZip || !window.BioGlow) return;
  const { HUB_IMAGES, SOUNDS } = window.BioGlow;

  const PROJECT_VERSION = 38; // SPIKE App 3 word-block project version
  const EMPTY_SVG = 'd41d8cd98f00b204e9800998ecf8427e'; // md5 of an empty file: the app's blank costume
  const NUM = 4, POSITIVE = 5, WHOLE = 6, TEXT = 10, BROADCAST = 11, VARIABLE = 12;

  // Our menu values <-> SPIKE App menu values.
  const COLOR_OUT = { black: '0', magenta: '1', violet: '1', blue: '3', azure: '4', green: '6', yellow: '7', red: '9', white: '10', none: '-1' };
  const COLOR_IN = { 0: 'black', 1: 'magenta', 2: 'violet', 3: 'blue', 4: 'azure', 5: 'azure', 6: 'green', 7: 'yellow', 8: 'red', 9: 'red', 10: 'white', '-1': 'none' };
  const LIGHT_OUT = { off: '0', magenta: '1', violet: '2', blue: '3', azure: '4', green: '6', yellow: '7', orange: '8', red: '9', white: '10' };
  const LIGHT_IN = Object.fromEntries(Object.entries(LIGHT_OUT).map(([k, v]) => [v, k]).concat([['5', 'azure']]));
  const DIST_OUT = { 'closer than': '<', 'farther than': '>', 'exactly at': '=' };
  const DIST_IN = { '<': 'closer than', '>': 'farther than', '=': 'exactly at' };
  const UNIT_OUT = { in: 'inches' };
  const UNIT_IN = { inches: 'in' };
  const MOTOR_DIR = { cw: 'clockwise', ccw: 'counterclockwise' };
  const MOTOR_DIR_IN = { clockwise: 'cw', counterclockwise: 'ccw' };
  const imageOut = (name) => (HUB_IMAGES[name] || HUB_IMAGES.happy).replace(/ /g, '').replace(/1/g, '9');
  // Nearest of our named images to a SPIKE brightness pattern (any lit pixel counts as on).
  function imageIn(pattern) {
    const bits = String(pattern).split('').map((c) => (c !== '0' ? '1' : '0')).join('');
    let best = 'happy', bestD = 99;
    for (const [name, img] of Object.entries(HUB_IMAGES)) {
      const p = img.replace(/ /g, '');
      let d = 0;
      for (let i = 0; i < 25; i++) d += p[i] !== bits[i];
      if (d < bestD) { best = name; bestD = d; }
    }
    return { name: best, exact: bestD === 0 };
  }

  const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const randomId = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]; return s; };
  const numStr = (x) => String(Math.round(Number(x) * 1000) / 1000);

  // ---- export: Blockly workspace -> Scratch blocks ---------------------------------------------
  class Exporter {
    constructor(ws, ports) {
      this.ws = ws;
      this.ports = ports || {}; // our port -> port on the real robot (when it is wired differently)
      this.blocks = {};
      this.count = 0;
      this.warnings = new Set();
      this.broadcasts = {}; // name -> id
      this.variables = {}; // id -> [name, 0]
      this.procs = {}; // name -> { proccode, argIds, params }
      this.params = null; // parameter names of the My Block being exported
      this.rotationCm = 17.5;
      this.soundStacks = new Set();
      for (const vm of ws.getAllVariables()) this.variables[vm.getId()] = [vm.name, 0];
    }
    id() { return 'bg' + (++this.count).toString(36).padStart(4, '0'); }
    warn(msg) { this.warnings.add(msg); }

    add(opcode, parent, extra) {
      const id = this.id();
      this.blocks[id] = Object.assign({ opcode, next: null, parent, inputs: {}, fields: {}, shadow: false, topLevel: false }, extra);
      return id;
    }
    // A SPIKE menu lives in its own shadow block holding one field named field_<opcode>.
    shadow(parent, opcode, value, field) {
      const id = this.id();
      this.blocks[id] = { opcode, next: null, parent, inputs: {}, fields: { [field || 'field_' + opcode]: [String(value), null] }, shadow: true, topLevel: false };
      return id;
    }
    broadcastId(name) {
      if (!this.broadcasts[name]) this.broadcasts[name] = 'bc' + randomId(18);
      return this.broadcasts[name];
    }

    // A literal number or text sitting in an input, or undefined if a reporter block is plugged in.
    literal(b, name) {
      const t = b.getInputTargetBlock(name);
      if (!t) return '';
      if (t.type === 'math_number') return String(t.getFieldValue('NUM'));
      if (t.type === 'text') return String(t.getFieldValue('TEXT'));
      return undefined;
    }
    // Number/text input: [1, [type, value]] for a literal, [3, reporter, [type, '']] for a reporter.
    value(b, name, parent, type, dflt) {
      const lit = this.literal(b, name);
      if (lit !== undefined) return [1, [type || NUM, lit === '' && dflt !== undefined ? String(dflt) : lit]];
      return [3, this.expr(b.getInputTargetBlock(name), parent), [type || NUM, '']];
    }
    // Input whose default is a SPIKE menu/number shadow (steering wheel, piano, pixel index...).
    menuValue(b, name, parent, opcode, dflt, map) {
      const lit = this.literal(b, name);
      if (lit !== undefined) return [1, this.shadow(parent, opcode, map ? map(lit === '' ? dflt : lit) : (lit === '' ? dflt : lit))];
      return [3, this.expr(b.getInputTargetBlock(name), parent), this.shadow(parent, opcode, dflt)];
    }
    bool(b, name, parent, block) {
      const t = b.getInputTargetBlock(name);
      if (t) this.blocks[block].inputs[name === 'COND' ? 'CONDITION' : name] = [2, this.expr(t, parent)];
    }
    portOut(p) { return String(p).split('').map((c) => this.ports[c] || c).join(''); }
    port(b, parent, opcode) { return [1, this.shadow(parent, opcode, this.portOut(b.getFieldValue('PORT')))]; }

    // ---- reporters --------------------------------------------------------------------
    expr(b, parent) {
      if (!b) return null;
      const add = (op) => this.add(op, parent);
      const set = (id, inputs, fields) => {
        Object.assign(this.blocks[id].inputs, inputs || {});
        for (const [k, v] of Object.entries(fields || {})) this.blocks[id].fields[k] = [v, null];
        return id;
      };
      const bin = (op, a, c, type) => { const id = add(op); return set(id, { [a]: this.value(b, 'A', id, type), [c]: this.value(b, 'B', id, type) }); };
      const logic = (op) => { const id = add(op); this.bool(b, 'A', id, id); this.bool(b, 'B', id, id); const ins = this.blocks[id].inputs; if (ins.A) { ins.OPERAND1 = ins.A; delete ins.A; } if (ins.B) { ins.OPERAND2 = ins.B; delete ins.B; } return id; };
      let id;
      switch (b.type) {
        case 'variables_get': {
          const v = b.getField('VAR').getVariable();
          if (this.params && this.params.includes(v.name)) return set(add('argument_reporter_string_number'), null, { VALUE: v.name });
          return [VARIABLE, v.name, v.getId()];
        }
        case 'math_number': return set(add('operator_add'), { NUM1: [1, [NUM, String(b.getFieldValue('NUM'))]], NUM2: [1, [NUM, '0']] });
        case 'text': return set(add('operator_join'), { STRING1: [1, [TEXT, String(b.getFieldValue('TEXT'))]], STRING2: [1, [TEXT, '']] });
        case 'sp_motor_position': id = add('flippermotor_absolutePosition'); return set(id, { PORT: this.port(b, id, 'flippermotor_single-motor-selector') });
        case 'sp_motor_relative': id = add('flippermoremotor_position'); return set(id, { PORT: this.port(b, id, 'flippermoremotor_single-motor-selector') });
        case 'sp_motor_speed': id = add('flippermotor_speed'); return set(id, { PORT: this.port(b, id, 'flippermotor_single-motor-selector') });
        case 'sp_volume_value': return add('sound_volume');
        case 'sp_is_color':
          id = add('flippersensors_isColor');
          if (b.getFieldValue('COLOR') === 'violet') this.warn('Violet and magenta are the same color choice in the SPIKE App, so violet was saved as magenta.');
          return set(id, { PORT: this.port(b, id, 'flippersensors_color-sensor-selector'), VALUE: [1, this.shadow(id, 'flippersensors_color-selector', COLOR_OUT[b.getFieldValue('COLOR')])] });
        case 'sp_color': id = add('flippersensors_color'); return set(id, { PORT: this.port(b, id, 'flippersensors_color-sensor-selector') });
        case 'sp_is_reflection':
          id = add('flippersensors_isReflectivity');
          return set(id, { PORT: this.port(b, id, 'flippersensors_color-sensor-selector'), VALUE: this.value(b, 'VALUE', id, NUM, 50) }, { COMPARATOR: b.getFieldValue('OP') });
        case 'sp_reflection': id = add('flippersensors_reflectivity'); return set(id, { PORT: this.port(b, id, 'flippersensors_color-sensor-selector') });
        case 'sp_is_distance':
          id = add('flippersensors_isDistance');
          return set(id, { PORT: this.port(b, id, 'flippersensors_distance-sensor-selector'), VALUE: this.value(b, 'VALUE', id, NUM, 15) },
            { COMPARATOR: DIST_OUT[b.getFieldValue('OP')], UNIT: UNIT_OUT[b.getFieldValue('UNIT')] || b.getFieldValue('UNIT') });
        case 'sp_distance':
          id = add('flippersensors_distance');
          return set(id, { PORT: this.port(b, id, 'flippersensors_distance-sensor-selector') }, { UNIT: UNIT_OUT[b.getFieldValue('UNIT')] || b.getFieldValue('UNIT') });
        case 'sp_angle': return set(add('flippersensors_orientationAxis'), null, { AXIS: b.getFieldValue('AXIS') });
        case 'sp_button_is': return set(add('flippersensors_buttonIsPressed'), null, { BUTTON: b.getFieldValue('BTN'), EVENT: b.getFieldValue('STATE') });
        case 'sp_timer': return add('flippersensors_timer');
        case 'op_add': return bin('operator_add', 'NUM1', 'NUM2');
        case 'op_sub': return bin('operator_subtract', 'NUM1', 'NUM2');
        case 'op_mul': return bin('operator_multiply', 'NUM1', 'NUM2');
        case 'op_div': return bin('operator_divide', 'NUM1', 'NUM2');
        case 'op_mod': return bin('operator_mod', 'NUM1', 'NUM2');
        case 'op_gt': return bin('operator_gt', 'OPERAND1', 'OPERAND2', TEXT);
        case 'op_lt': return bin('operator_lt', 'OPERAND1', 'OPERAND2', TEXT);
        case 'op_eq': return bin('operator_equals', 'OPERAND1', 'OPERAND2', TEXT);
        case 'op_random': return bin('operator_random', 'FROM', 'TO');
        case 'op_join': return bin('operator_join', 'STRING1', 'STRING2', TEXT);
        case 'op_contains': return bin('operator_contains', 'STRING1', 'STRING2', TEXT);
        case 'op_letter': id = add('operator_letter_of'); return set(id, { LETTER: this.value(b, 'A', id, WHOLE, 1), STRING: this.value(b, 'B', id, TEXT) });
        case 'op_length': id = add('operator_length'); return set(id, { STRING: this.value(b, 'A', id, TEXT) });
        case 'op_round': id = add('operator_round'); return set(id, { NUM: this.value(b, 'A', id) });
        case 'op_mathop': id = add('operator_mathop'); return set(id, { NUM: this.value(b, 'A', id) }, { OPERATOR: b.getFieldValue('OP') });
        case 'op_and': return logic('operator_and');
        case 'op_or': return logic('operator_or');
        case 'op_not': id = add('operator_not'); { const t = b.getInputTargetBlock('A'); if (t) this.blocks[id].inputs.OPERAND = [2, this.expr(t, id)]; } return id;
        default:
          this.warn('The "' + b.type + '" block has no SPIKE App version and was left out.');
          return null;
      }
    }

    // ---- statements: returns the ids it added, in order ---------------------------------
    stmt(b, parent) {
      const one = (op, inputs, fields, after) => {
        const id = this.add(op, parent);
        const blk = this.blocks[id];
        for (const [k, f] of Object.entries(inputs || {})) blk.inputs[k] = f(id);
        for (const [k, v] of Object.entries(fields || {})) blk.fields[k] = [v, null];
        if (after) after(id);
        return [id];
      };
      const val = (name, type, dflt) => (id) => this.value(b, name, id, type, dflt);
      const menu = (name, opcode, dflt, map) => (id) => this.menuValue(b, name, id, opcode, dflt, map);
      const fixed = (opcode, value) => (id) => [1, this.shadow(id, opcode, value)];
      const motorPort = (id) => this.port(b, id, 'flippermotor_multiple-port-selector');
      const unit = (name) => UNIT_OUT[b.getFieldValue(name)] || b.getFieldValue(name);
      const sub = (name, input) => (id) => { const first = this.chain(b.getInputTargetBlock(name), id); if (first) this.blocks[id].inputs[input] = [2, first]; };
      const dir = b.getField('DIR') ? b.getFieldValue('DIR') : null;

      switch (b.type) {
        // motors
        case 'sp_motor_run': return one('flippermotor_motorTurnForDirection', { PORT: motorPort, DIRECTION: fixed('flippermotor_custom-icon-direction', MOTOR_DIR[dir]), VALUE: val('AMOUNT', NUM, 1) }, { UNIT: b.getFieldValue('UNIT') });
        case 'sp_motor_goto': return one('flippermotor_motorGoDirectionToPosition', { PORT: motorPort, POSITION: menu('POS', 'flippermotor_custom-angle', '0') }, { DIRECTION: b.getFieldValue('MODE') });
        case 'sp_motor_start': return one('flippermotor_motorStartDirection', { PORT: motorPort, DIRECTION: fixed('flippermotor_custom-icon-direction', MOTOR_DIR[dir]) });
        case 'sp_motor_stop': return one('flippermotor_motorStop', { PORT: motorPort });
        case 'sp_motor_set_speed': return one('flippermotor_motorSetSpeed', { PORT: motorPort, SPEED: val('SPEED', NUM, 75) });
        case 'sp_motor_set_relative': return one('flippermoremotor_motorSetDegreeCounted', { PORT: (id) => this.port(b, id, 'flippermoremotor_multiple-port-selector'), VALUE: val('POS', NUM, 0) });

        // movement (spinning on the spot is "move with steering 100" in the SPIKE App)
        case 'sp_move':
          if (dir === 'fwd' || dir === 'back') return one('flippermove_move', { DIRECTION: fixed('flippermove_custom-icon-direction', dir === 'fwd' ? 'forward' : 'back'), VALUE: val('AMOUNT', NUM, 10) }, { UNIT: unit('UNIT') });
          return this.steer(b, parent, (id) => [1, this.shadow(id, 'flippermove_rotation-wheel', dir === 'cw' ? '100' : '-100')]);
        case 'sp_move_steer': return this.steer(b, parent, menu('STEER', 'flippermove_rotation-wheel', '0'));
        case 'sp_start_moving':
          if (dir === 'fwd' || dir === 'back') return one('flippermove_startMove', { DIRECTION: fixed('flippermove_custom-icon-direction', dir === 'fwd' ? 'forward' : 'back') });
          return one('flippermove_startSteer', { STEERING: fixed('flippermove_rotation-wheel', dir === 'cw' ? '100' : '-100') });
        case 'sp_start_steer': return one('flippermove_startSteer', { STEERING: menu('STEER', 'flippermove_rotation-wheel', '0') });
        case 'sp_start_tank': return one('flippermoremove_startDualSpeed', { LEFT: val('L', NUM, 50), RIGHT: val('R', NUM, 50) });
        case 'sp_move_tank': return this.tank(b, parent);
        case 'sp_stop_moving': return one('flippermove_stopMove');
        case 'sp_move_speed': return one('flippermove_movementSpeed', { SPEED: val('SPEED', NUM, 50) });
        case 'sp_move_motors': return one('flippermove_setMovementPair', { PAIR: fixed('flippermove_movement-port-selector', this.portOut(b.getFieldValue('PAIR').replace('+', ''))) });
        case 'sp_move_accel': {
          const v = { slow: '1000 1000', medium: '3000 3000', fast: '10000 10000' }[b.getFieldValue('ACCEL')] || '3000 3000';
          return one('flippermoremove_movementSetAcceleration', { ACCELERATION: (id) => [1, this.shadow(id, 'flippermoremove_menu_acceleration', v, 'acceleration')] });
        }
        case 'sp_move_stop': return one('flippermoremove_movementSetStopMethod', null, { STOP: { coast: '0', brake: '1', hold: '2' }[b.getFieldValue('STOP')] || '1' });
        case 'sp_rotation': {
          const lit = this.literal(b, 'CM');
          if (lit === undefined) this.warn('"set 1 motor rotation" needs a typed number in the SPIKE App, so 17.5 was used.');
          const cm = lit === undefined || lit === '' ? '17.5' : lit;
          this.rotationCm = Number(cm) * (b.getFieldValue('UNIT') === 'in' ? 2.54 : 1) || 17.5;
          return one('flippermove_setDistance', { DISTANCE: fixed('flippermove_custom-set-move-distance-number', cm) }, { UNIT: unit('UNIT') === 'in' ? 'inches' : unit('UNIT') });
        }

        // light
        case 'sp_image_for': return one('flipperlight_lightDisplayImageOnForTime', { MATRIX: fixed('flipperlight_matrix-5x5-brightness-image', imageOut(b.getFieldValue('IMAGE'))), VALUE: val('SECS', NUM, 2) });
        case 'sp_image': return one('flipperlight_lightDisplayImageOn', { MATRIX: fixed('flipperlight_matrix-5x5-brightness-image', imageOut(b.getFieldValue('IMAGE'))) });
        case 'sp_write': return one('flipperlight_lightDisplayText', { TEXT: val('TEXT', TEXT, 'Hello') });
        case 'sp_lights_off': return one('flipperlight_lightDisplayOff');
        case 'sp_brightness': return one('flipperlight_lightDisplaySetBrightness', { BRIGHTNESS: val('P', NUM, 75) });
        case 'sp_set_pixel': return one('flipperlight_lightDisplaySetPixel', { X: menu('X', 'flipperlight_matrix-pixel-index', '1'), Y: menu('Y', 'flipperlight_matrix-pixel-index', '1'), BRIGHTNESS: val('P', NUM, 100) });
        case 'sp_center_light': return one('flipperlight_centerButtonLight', { COLOR: fixed('flipperlight_color-selector-vertical', LIGHT_OUT[b.getFieldValue('COLOR')]) });
        case 'sp_eyes': {
          const parts = ['A', 'B', 'C2', 'D'].map((k) => { const l = this.literal(b, k); if (l === undefined) this.warn('Distance sensor lights need typed numbers in the SPIKE App, so 100 was used.'); return l === undefined || l === '' ? '100' : numStr(l); });
          return one('flipperlight_ultrasonicLightUp', { PORT: (id) => this.port(b, id, 'flipperlight_distance-sensor-selector'), VALUE: fixed('flipperlight_led-selector', parts.join(' ')) });
        }

        // sound (our hub sounds are note tunes, so they are saved as the beeps that make them)
        case 'sp_beep_for': return one('flippersound_beepForTime', { NOTE: menu('NOTE', 'flippersound_custom-piano', '60'), DURATION: val('SECS', NUM, 0.2) });
        case 'sp_beep': return one('flippersound_beep', { NOTE: menu('NOTE', 'flippersound_custom-piano', '60') });
        case 'sp_play_sound': return this.tune(b.getFieldValue('SOUND'), parent);
        case 'sp_start_sound': {
          const name = b.getFieldValue('SOUND');
          this.soundStacks.add(name);
          return one('event_broadcast', { BROADCAST_INPUT: () => [1, [BROADCAST, 'play ' + name, this.broadcastId('play ' + name)]] });
        }
        case 'sp_stop_sounds': return one('flippersound_stopSound');
        case 'sp_change_volume': return one('sound_changevolumeby', { VOLUME: val('VOL', NUM, -10) });
        case 'sp_volume': return one('sound_setvolumeto', { VOLUME: val('VOL', NUM, 100) });

        // events
        case 'sp_broadcast': case 'sp_broadcast_wait': {
          const msg = b.getFieldValue('MSG');
          return one(b.type === 'sp_broadcast' ? 'event_broadcast' : 'event_broadcastandwait', { BROADCAST_INPUT: () => [1, [BROADCAST, msg, this.broadcastId(msg)]] });
        }

        // control
        case 'sp_wait': return one('control_wait', { DURATION: val('SECS', POSITIVE, 1) });
        case 'sp_repeat': return one('control_repeat', { TIMES: val('TIMES', WHOLE, 10) }, null, sub('DO', 'SUBSTACK'));
        case 'sp_forever': return one('control_forever', null, null, sub('DO', 'SUBSTACK'));
        case 'sp_if': return one('control_if', null, null, (id) => { this.bool(b, 'COND', id, id); sub('DO', 'SUBSTACK')(id); });
        case 'sp_ifelse': return one('control_if_else', null, null, (id) => { this.bool(b, 'COND', id, id); sub('DO', 'SUBSTACK')(id); sub('ELSE', 'SUBSTACK2')(id); });
        case 'sp_wait_until': return one('control_wait_until', null, null, (id) => this.bool(b, 'COND', id, id));
        case 'sp_repeat_until': return one('control_repeat_until', null, null, (id) => { this.bool(b, 'COND', id, id); sub('DO', 'SUBSTACK')(id); });
        case 'sp_stop': return one('flippercontrol_stop', null, { STOP_OPTION: b.getFieldValue('WHAT') === 'all' ? 'all' : 'this' });

        // sensors
        case 'sp_set_yaw': {
          const lit = this.literal(b, 'VALUE');
          if (lit === undefined || (lit !== '' && Number(lit) !== 0)) this.warn('The SPIKE App can only set the yaw angle to 0, so "set yaw angle to" was saved as 0.');
          return one('flippersensors_resetYaw');
        }
        case 'sp_reset_timer': return one('flippersensors_resetTimer');

        // variables and My Blocks
        case 'variables_set': {
          const v = b.getField('VAR').getVariable();
          return one('data_setvariableto', { VALUE: val('VALUE', TEXT, '0') }, null, (id) => { this.blocks[id].fields.VARIABLE = [v.name, v.getId()]; });
        }
        case 'math_change': {
          const v = b.getField('VAR').getVariable();
          return one('data_changevariableby', { VALUE: val('DELTA', NUM, 1) }, null, (id) => { this.blocks[id].fields.VARIABLE = [v.name, v.getId()]; });
        }
        case 'procedures_callnoreturn': {
          const p = this.procs[b.getProcedureCall()];
          if (!p) { this.warn('A My Block call without its "define" block was left out.'); return []; }
          return one('procedures_call', null, null, (id) => {
            const blk = this.blocks[id];
            blk.mutation = { tagName: 'mutation', children: [], proccode: p.proccode, argumentids: JSON.stringify(p.argIds), warp: 'false' };
            p.argIds.forEach((aid, i) => { blk.inputs[aid] = this.value(b, 'ARG' + i, id, TEXT, ''); });
          });
        }
        default:
          this.warn('The "' + b.type + '" block has no SPIKE App version and was left out.');
          return [];
      }
    }

    // The SPIKE App's steering block measures rotations, degrees or seconds only, so distances become
    // wheel rotations (the same encoder target the robot uses for cm).
    steer(b, parent, steering) {
      const id = this.add('flippermove_steer', parent);
      const blk = this.blocks[id];
      blk.inputs.STEERING = steering(id);
      const u = b.getFieldValue('UNIT');
      if (u === 'cm' || u === 'in') {
        const cmPer = u === 'in' ? 2.54 : 1;
        const lit = this.literal(b, 'AMOUNT');
        if (lit !== undefined) blk.inputs.VALUE = [1, [NUM, numStr((Number(lit === '' ? 10 : lit) * cmPer) / this.rotationCm)]];
        else {
          const div = this.add('operator_divide', id);
          this.blocks[div].inputs.NUM1 = this.value(b, 'AMOUNT', div, NUM);
          this.blocks[div].inputs.NUM2 = [1, [NUM, numStr(this.rotationCm / cmPer)]];
          blk.inputs.VALUE = [3, div, [NUM, '']];
        }
        blk.fields.UNIT = ['rotations', null];
        this.warn('Steering and spin moves in cm were saved in wheel rotations (' + numStr(this.rotationCm) + ' cm each), because the SPIKE App\u2019s steering block has no cm.');
      } else {
        blk.inputs.VALUE = this.value(b, 'AMOUNT', id, NUM, 10);
        blk.fields.UNIT = [u, null];
      }
      return [id];
    }

    // "move with L% and R% for ..." has no single SPIKE App block: start the motors at those speeds,
    // then wait until the faster wheel's encoder has turned far enough (or the time is up) and stop.
    tank(b, parent) {
      const ids = [];
      const unitName = b.getFieldValue('UNIT');
      const lit = (k) => { const l = this.literal(b, k); return l === undefined ? NaN : Number(l === '' ? 50 : l); };
      const L = lit('L'), R = lit('R');
      const lead = !isNaN(L) && !isNaN(R) && Math.abs(R) > Math.abs(L) ? 'B' : 'A';
      const start = this.add('flippermoremove_startDualSpeed', parent);
      this.blocks[start].inputs.LEFT = this.value(b, 'L', start, NUM, 50);
      this.blocks[start].inputs.RIGHT = this.value(b, 'R', start, NUM, 50);
      if (unitName === 'seconds') {
        const w = this.add('control_wait', parent);
        this.blocks[w].inputs.DURATION = this.value(b, 'AMOUNT', w, POSITIVE, 1);
        ids.push(start, w);
      } else {
        const reset = this.add('flippermoremotor_motorSetDegreeCounted', parent);
        this.blocks[reset].inputs.PORT = [1, this.shadow(reset, 'flippermoremotor_multiple-port-selector', this.portOut(lead))];
        this.blocks[reset].inputs.VALUE = [1, [NUM, '0']];
        const perUnit = { cm: 360 / this.rotationCm, in: (360 * 2.54) / this.rotationCm, rotations: 360, degrees: 1 }[unitName] || 1;
        const wait = this.add('control_wait_until', parent);
        const gt = this.add('operator_gt', wait);
        const abs = this.add('operator_mathop', gt);
        const pos = this.add('flippermoremotor_position', abs);
        this.blocks[pos].inputs.PORT = [1, this.shadow(pos, 'flippermoremotor_single-motor-selector', this.portOut(lead))];
        this.blocks[abs].inputs.NUM = [3, pos, [NUM, '']];
        this.blocks[abs].fields.OPERATOR = ['abs', null];
        this.blocks[gt].inputs.OPERAND1 = [3, abs, [TEXT, '']];
        const amount = this.literal(b, 'AMOUNT');
        if (amount !== undefined) {
          this.blocks[gt].inputs.OPERAND2 = [1, [TEXT, numStr(Math.abs(Number(amount === '' ? 10 : amount)) * perUnit)]];
        } else {
          const mul = this.add('operator_multiply', gt);
          this.blocks[mul].inputs.NUM1 = this.value(b, 'AMOUNT', mul, NUM);
          this.blocks[mul].inputs.NUM2 = [1, [NUM, numStr(perUnit)]];
          this.blocks[gt].inputs.OPERAND2 = [3, mul, [TEXT, '']];
        }
        this.blocks[wait].inputs.CONDITION = [2, gt];
        ids.push(reset, start, wait);
      }
      ids.push(this.add('flippermove_stopMove', parent));
      return ids;
    }

    // A hub sound as the beeps that make it up (a note of 0 is a rest).
    tune(name, parent) {
      return (SOUNDS[name] || SOUNDS.Beep).map(([note, secs]) => {
        if (!note) {
          const w = this.add('control_wait', parent);
          this.blocks[w].inputs.DURATION = [1, [POSITIVE, numStr(secs)]];
          return w;
        }
        const id = this.add('flippersound_beepForTime', parent);
        this.blocks[id].inputs.NOTE = [1, this.shadow(id, 'flippersound_custom-piano', String(note))];
        this.blocks[id].inputs.DURATION = [1, [NUM, numStr(secs)]];
        return id;
      });
    }

    // Exports a stack starting at block b under parent; returns the first id.
    chain(b, parent) {
      let first = null, prev = null;
      for (; b; b = b.getNextBlock()) {
        if (!b.isEnabled()) continue;
        for (const id of this.stmt(b, prev || parent)) {
          this.blocks[id].parent = prev || parent;
          if (prev) this.blocks[prev].next = id;
          if (!first) first = id;
          prev = id;
        }
      }
      return first;
    }

    hat(b) {
      const xy = b.getRelativeToSurfaceXY();
      const top = { topLevel: true, x: Math.round(xy.x * 1.6), y: Math.round(xy.y * 1.6) };
      const h = (op) => this.add(op, null, top);
      let id;
      switch (b.type) {
        case 'sp_when_start': id = h('flipperevents_whenProgramStarts'); break;
        case 'sp_when_color':
          id = h('flipperevents_whenColor');
          this.blocks[id].inputs.PORT = [1, this.shadow(id, 'flipperevents_color-sensor-selector', this.portOut(b.getFieldValue('PORT')))];
          this.blocks[id].inputs.OPTION = [1, this.shadow(id, 'flipperevents_color-selector', COLOR_OUT[b.getFieldValue('COLOR')])];
          break;
        case 'sp_when_distance':
          id = h('flipperevents_whenDistance');
          this.blocks[id].inputs.PORT = [1, this.shadow(id, 'flipperevents_distance-sensor-selector', this.portOut(b.getFieldValue('PORT')))];
          this.blocks[id].inputs.VALUE = this.value(b, 'VALUE', id, NUM, 15);
          this.blocks[id].fields.COMPARATOR = [DIST_OUT[b.getFieldValue('OP')], null];
          this.blocks[id].fields.UNIT = [UNIT_OUT[b.getFieldValue('UNIT')] || b.getFieldValue('UNIT'), null];
          break;
        case 'sp_when_timer': id = h('flipperevents_whenTimer'); this.blocks[id].inputs.VALUE = this.value(b, 'VALUE', id, NUM, 5); break;
        case 'sp_when_button':
          id = h('flipperevents_whenButton');
          this.blocks[id].fields.BUTTON = [b.getFieldValue('BTN'), null];
          this.blocks[id].fields.EVENT = [b.getFieldValue('STATE'), null];
          break;
        case 'sp_when_receive': {
          const msg = b.getFieldValue('MSG');
          id = h('event_whenbroadcastreceived');
          this.blocks[id].fields.BROADCAST_OPTION = [msg, this.broadcastId(msg)];
          break;
        }
        default: return false;
      }
      const first = this.chain(b.getNextBlock(), id);
      if (first) this.blocks[id].next = first;
      return true;
    }

    // My Block: procedures_definition -> procedures_prototype (shadow) with an argument reporter per input.
    definition(b) {
      const [name, params] = b.getProcedureDef();
      const p = this.procs[name];
      const xy = b.getRelativeToSurfaceXY();
      const def = this.add('procedures_definition', null, { topLevel: true, x: Math.round(xy.x * 1.6), y: Math.round(xy.y * 1.6) });
      const proto = this.add('procedures_prototype', def, { shadow: true });
      this.blocks[def].inputs.custom_block = [1, proto];
      this.blocks[proto].mutation = {
        tagName: 'mutation', children: [], proccode: p.proccode, argumentids: JSON.stringify(p.argIds),
        argumentnames: JSON.stringify(params), argumentdefaults: JSON.stringify(params.map(() => '')), warp: 'false',
      };
      p.argIds.forEach((aid, i) => {
        const r = this.add('argument_reporter_string_number', proto, { shadow: true });
        this.blocks[r].fields.VALUE = [params[i], null];
        this.blocks[proto].inputs[aid] = [1, r];
      });
      this.params = params;
      const first = this.chain(b.getInputTargetBlock('STACK'), def);
      this.params = null;
      if (first) this.blocks[def].next = first;
    }

    run() {
      const tops = this.ws.getTopBlocks(true).filter((b) => b.isEnabled());
      const defs = tops.filter((b) => b.type === 'procedures_defnoreturn');
      for (const d of defs) {
        const [name, params] = d.getProcedureDef();
        this.procs[name] = { proccode: [name].concat(params.map(() => '%s')).join(' '), argIds: params.map(() => 'ar' + randomId(18)) };
      }
      // Programs need a "when program starts" stack that names the movement motors, as SPIKE's templates do.
      for (const b of tops) {
        if (b.type === 'procedures_defnoreturn') this.definition(b);
        else if (!this.hat(b)) {
          this.warn('Blocks that are not under an event block were left out (the hub would not run them either).');
        }
      }
      for (const name of this.soundStacks) {
        const id = this.add('event_whenbroadcastreceived', null, { topLevel: true, x: 2400, y: 200 + 400 * [...this.soundStacks].indexOf(name) });
        this.blocks[id].fields.BROADCAST_OPTION = ['play ' + name, this.broadcastId('play ' + name)];
        let prev = id;
        for (const n of this.tune(name, id)) { this.blocks[n].parent = prev; this.blocks[prev].next = n; prev = n; }
      }
      // Every block in the simulator expects the drive motors on A+B; say so at the top of each start stack.
      const usesMove = Object.values(this.blocks).some((x) => /^flipper(more)?move_/.test(x.opcode) && x.opcode !== 'flippermove_setMovementPair');
      const hasPair = Object.values(this.blocks).some((x) => x.opcode === 'flippermove_setMovementPair');
      if (usesMove && !hasPair) {
        for (const [hid, h] of Object.entries(this.blocks)) {
          if (h.opcode !== 'flipperevents_whenProgramStarts') continue;
          const pair = this.add('flippermove_setMovementPair', hid);
          this.blocks[pair].inputs.PAIR = [1, this.shadow(pair, 'flippermove_movement-port-selector', this.portOut('AB'))];
          this.blocks[pair].next = h.next;
          if (h.next) this.blocks[h.next].parent = pair;
          h.next = pair;
        }
      }
      return this;
    }

    extensions() {
      const core = new Set(['control', 'operator', 'data', 'event', 'procedures', 'argument', 'sound']);
      const ext = new Set();
      for (const b of Object.values(this.blocks)) { const e = b.opcode.split('_')[0]; if (!core.has(e)) ext.add(e); }
      return [...ext].sort();
    }

    project() {
      const costume = (name, x, y) => ({ assetId: EMPTY_SVG, name, bitmapResolution: 1, md5ext: EMPTY_SVG + '.svg', dataFormat: 'svg', rotationCenterX: x, rotationCenterY: y });
      const broadcasts = Object.fromEntries(Object.entries(this.broadcasts).map(([name, id]) => [id, name]));
      return {
        targets: [
          { isStage: true, name: 'Stage', variables: this.variables, lists: {}, broadcasts, blocks: {}, comments: {}, currentCostume: 0,
            costumes: [costume('backdrop1', 47, 55)], sounds: [], volume: 0, tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null },
          { isStage: false, name: randomId(20), variables: {}, lists: {}, broadcasts: {}, blocks: this.blocks, comments: {}, currentCostume: 0,
            costumes: [costume(randomId(20), 240, 180)], sounds: [], volume: 100, visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around' },
        ],
        monitors: [],
        extensions: this.extensions(),
        meta: { semver: '3.0.0', vm: '0.2.0', agent: (navigator && navigator.userAgent) || '' },
      };
    }
  }

  const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect width="60" height="60" rx="12" fill="#1f1e1d"/>' +
    '<rect x="12" y="16" width="36" height="28" rx="6" fill="#48b9c7"/><circle cx="23" cy="30" r="4" fill="#1f1e1d"/><circle cx="37" cy="30" r="4" fill="#1f1e1d"/></svg>';

  function safeName(name) {
    return String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'BIOGLOW robot';
  }

  // Returns { project, warnings } without zipping (used by the file export and by tests).
  function toProject(json, ports) {
    const ws = new Blockly.Workspace();
    try {
      Blockly.serialization.workspaces.load(json, ws);
      const x = new Exporter(ws, ports).run();
      return { project: x.project(), warnings: [...x.warnings] };
    } finally { ws.dispose(); }
  }

  async function exportLlsp3(json, name, ports) {
    const { project, warnings } = toProject(json, ports);
    const projectName = safeName(name);
    const sb3 = new JSZip();
    sb3.file('project.json', JSON.stringify(project));
    sb3.file(EMPTY_SVG + '.svg', '');
    const sb3Data = await sb3.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    const now = new Date().toISOString();
    const manifest = {
      type: 'word-blocks', appType: 'llsp3', autoDelete: false, created: now, id: randomId(12), lastsaved: now, size: sb3Data.length,
      name: projectName, slotIndex: 0, workspaceX: 120, workspaceY: 120, zoomLevel: 0.675, showAllBlocks: false, version: PROJECT_VERSION,
      hardware: {}, extensions: project.extensions, state: { playMode: 'download' }, extraFiles: [], lastConnectedHubType: 'flipper',
    };
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('scratch.sb3', sb3Data);
    zip.file('icon.svg', ICON_SVG);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/zip' });
    return { blob, name: projectName, warnings };
  }

  // ---- import: Scratch blocks -> Blockly JSON ------------------------------------------------
  // Robots are wired differently. Work out which of the team's ports is the left/right drive motor,
  // color sensor, distance sensor and other motors, and map them onto the ports those parts have on
  // the simulator robot (`wiring`: port -> job, from the Robot tab). Returns { their port: our port }.
  function portRoles(all, wiring) {
    const ours = {}; // our port -> their port
    const portFor = (job) => Object.keys(wiring).find((p) => wiring[p] === job);
    const take = (job, their) => { const our = portFor(job); if (our && their && !ours[our] && !Object.values(ours).includes(their)) ours[our] = their; };
    const menus = Object.values(all).filter((b) => b && b.shadow && b.fields && Object.keys(b.fields).length === 1);
    const val = (b) => String(Object.values(b.fields)[0][0]);
    const pair = menus.find((b) => b.opcode === 'flippermove_movement-port-selector');
    const drive = pair && val(pair).length === 2 ? val(pair) : 'AB';
    take('left', drive[0]); take('right', drive[1]);
    const colors = [...new Set(menus.filter((b) => /color-sensor-selector$/.test(b.opcode)).map((b) => val(b)[0]))];
    take('color', colors[0]); take('color2', colors[1]);
    const first = (re) => { const m = menus.find((b) => re.test(b.opcode)); return m ? val(m)[0] : null; };
    take('distance', first(/distance-sensor-selector$/));
    for (const m of menus) {
      if (!/motor_(multiple-port-selector|single-motor-selector)$/.test(m.opcode)) continue;
      for (const c of val(m)) if (!Object.values(ours).includes(c)) { if (!ours[portFor('arm')]) take('arm', c); else take('spare', c); }
    }
    const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (const our of letters) if (!ours[our] && !Object.values(ours).includes(our)) ours[our] = our;
    for (const our of letters) if (!ours[our]) ours[our] = letters.find((l) => !Object.values(ours).includes(l));
    const theirs = {};
    for (const [our, their] of Object.entries(ours)) theirs[their] = our;
    return theirs;
  }

  function fromProject(project, wiring) {
    wiring = wiring || { A: 'left', B: 'right', C: 'arm', D: 'spare', E: 'color', F: 'distance' };
    const warnings = new Set();
    const warn = (m) => warnings.add(m);
    const sprite = project.targets.find((t) => !t.isStage) || { blocks: {} };
    const all = sprite.blocks;
    const variables = new Map();
    for (const t of project.targets) for (const [id, v] of Object.entries(t.variables || {})) variables.set(id, v[0]);
    const firstVar = new Map();
    for (const [id, n] of variables) if (!firstVar.has(String(n).toLowerCase())) firstVar.set(String(n).toLowerCase(), id);
    const procs = {}; // proccode -> { name, params, argIds }
    for (const b of Object.values(all)) {
      if (b && b.opcode === 'procedures_prototype') {
        const m = b.mutation;
        const params = JSON.parse(m.argumentnames || '[]');
        let name = m.proccode.replace(/%[sbn]/g, '').replace(/\s+/g, ' ').trim() || 'my block';
        procs[m.proccode] = { name, params, argIds: JSON.parse(m.argumentids || '[]') };
      }
    }
    // Two different SPIKE blocks may share a name once their input slots are removed.
    const seen = {};
    for (const p of Object.values(procs)) { seen[p.name] = (seen[p.name] || 0) + 1; if (seen[p.name] > 1) p.name += ' ' + seen[p.name]; }

    const N = (x) => ({ shadow: { type: 'math_number', fields: { NUM: Number(x) || 0 } } });
    const T = (x) => ({ shadow: { type: 'text', fields: { TEXT: String(x) } } });
    const varGet = (name) => ({ block: { type: 'variables_get', fields: { VAR: { id: varId(name) } } } });
    // Blockly variable names ignore case ("Angle" and "angle" are one variable).
    const varIds = new Map();
    function varId(name) {
      const key = String(name).toLowerCase();
      for (const [id, n] of variables) if (String(n).toLowerCase() === key) return firstVar.get(key) || id;
      if (!varIds.has(key)) varIds.set(key, { id: 'v' + randomId(18), name });
      return varIds.get(key).id;
    }
    const menuOf = (input) => {
      if (!input) return undefined;
      const s = typeof input[1] === 'string' ? all[input[1]] : null;
      if (s && s.shadow) return Object.values(s.fields)[0][0];
      return undefined;
    };
    // An input as a Blockly input: a typed literal becomes a number/text shadow, a reporter a block.
    function input(inp, kind) {
      const shadowOf = (x) => (kind === 'text' || (kind === 'auto' && (String(x).trim() === '' || isNaN(Number(x)))) ? T(x) : N(x));
      if (!inp) return kind === 'text' || kind === 'auto' ? T('') : N(0);
      const [mode, a, c] = inp;
      const lit = (v) => {
        if (Array.isArray(v)) {
          if (v[0] === VARIABLE) return varGet(v[1]);
          return shadowOf(v[1]);
        }
        const s = all[v];
        if (s && s.shadow && s.opcode !== 'argument_reporter_string_number') return shadowOf(Object.values(s.fields)[0][0]);
        const blk = expr(v);
        return blk ? { block: blk } : shadowOf(0);
      };
      if (mode === 1) return lit(a);
      const blk = Array.isArray(a) ? null : expr(a);
      const out = Array.isArray(a) ? lit(a) : (blk ? { block: blk } : {});
      const fallback = c !== undefined && c !== null ? lit(c) : null;
      if (fallback && fallback.shadow) out.shadow = fallback.shadow;
      return out;
    }
    const boolIn = (inp) => { if (!inp || inp[1] == null) return undefined; const blk = expr(inp[1]); return blk ? { block: blk } : undefined; };
    const field = (b, k) => (b.fields[k] ? b.fields[k][0] : undefined);
    const portMap = portRoles(all, wiring);
    const drivePair = ['left', 'right'].map((job) => Object.keys(wiring).find((p) => wiring[p] === job)).join('+'); // the team's pair ends up on our drive motors
    const portIn = (p) => String(p).split('').map((c) => portMap[c] || c).join('');
    const portOf = (b, k) => portIn(menuOf(b.inputs[k || 'PORT']) || 'A')[0];

    function expr(id) {
      const b = all[id];
      if (!b) return null;
      const op = (type, A, B, kind) => ({ type, inputs: { A: input(b.inputs[A], kind), B: input(b.inputs[B], kind) } });
      const bools = (type) => {
        const inputs = {};
        const a = boolIn(b.inputs.OPERAND1), c = boolIn(b.inputs.OPERAND2);
        if (a) inputs.A = a; if (c) inputs.B = c;
        return { type, inputs };
      };
      switch (b.opcode) {
        case 'argument_reporter_string_number': case 'argument_reporter_boolean': return varGet(field(b, 'VALUE')).block;
        case 'data_variable': return varGet(field(b, 'VARIABLE')).block;
        case 'flippermotor_absolutePosition': return { type: 'sp_motor_position', fields: { PORT: portOf(b) } };
        case 'flippermoremotor_position': case 'flippermotor_relativePosition': return { type: 'sp_motor_relative', fields: { PORT: portOf(b) } };
        case 'flippermotor_speed': return { type: 'sp_motor_speed', fields: { PORT: portOf(b) } };
        case 'sound_volume': return { type: 'sp_volume_value' };
        case 'flippersensors_isColor': return { type: 'sp_is_color', fields: { PORT: portOf(b), COLOR: COLOR_IN[menuOf(b.inputs.VALUE)] || 'red' } };
        case 'flippersensors_color': return { type: 'sp_color', fields: { PORT: portOf(b) } };
        case 'flippersensors_isReflectivity': return { type: 'sp_is_reflection', fields: { PORT: portOf(b), OP: field(b, 'COMPARATOR') || '<' }, inputs: { VALUE: input(b.inputs.VALUE) } };
        case 'flippersensors_reflectivity': return { type: 'sp_reflection', fields: { PORT: portOf(b) } };
        case 'flippersensors_isDistance': return { type: 'sp_is_distance', fields: { PORT: portOf(b), OP: DIST_IN[field(b, 'COMPARATOR')] || 'closer than', UNIT: UNIT_IN[field(b, 'UNIT')] || field(b, 'UNIT') || 'cm' }, inputs: { VALUE: input(b.inputs.VALUE) } };
        case 'flippersensors_distance': return { type: 'sp_distance', fields: { PORT: portOf(b), UNIT: UNIT_IN[field(b, 'UNIT')] || field(b, 'UNIT') || 'cm' } };
        case 'flippersensors_orientationAxis': return { type: 'sp_angle', fields: { AXIS: field(b, 'AXIS') || 'yaw' } };
        case 'flippersensors_buttonIsPressed': return { type: 'sp_button_is', fields: { BTN: field(b, 'BUTTON') || 'left', STATE: field(b, 'EVENT') || 'pressed' } };
        case 'flippersensors_timer': return { type: 'sp_timer' };
        case 'operator_add': return op('op_add', 'NUM1', 'NUM2');
        case 'operator_subtract': return op('op_sub', 'NUM1', 'NUM2');
        case 'operator_multiply': return op('op_mul', 'NUM1', 'NUM2');
        case 'operator_divide': return op('op_div', 'NUM1', 'NUM2');
        case 'operator_mod': return op('op_mod', 'NUM1', 'NUM2');
        case 'operator_gt': return op('op_gt', 'OPERAND1', 'OPERAND2');
        case 'operator_lt': return op('op_lt', 'OPERAND1', 'OPERAND2');
        case 'operator_equals': return op('op_eq', 'OPERAND1', 'OPERAND2', 'auto');
        case 'operator_random': return op('op_random', 'FROM', 'TO');
        case 'operator_join': return op('op_join', 'STRING1', 'STRING2', 'text');
        case 'operator_contains': return op('op_contains', 'STRING1', 'STRING2', 'text');
        case 'operator_letter_of': return { type: 'op_letter', inputs: { A: input(b.inputs.LETTER), B: input(b.inputs.STRING, 'text') } };
        case 'operator_length': return { type: 'op_length', inputs: { A: input(b.inputs.STRING, 'text') } };
        case 'operator_round': return { type: 'op_round', inputs: { A: input(b.inputs.NUM) } };
        case 'operator_mathop': return { type: 'op_mathop', fields: { OP: field(b, 'OPERATOR') || 'abs' }, inputs: { A: input(b.inputs.NUM) } };
        case 'operator_and': return bools('op_and');
        case 'operator_or': return bools('op_or');
        case 'operator_not': { const a = boolIn(b.inputs.OPERAND); return { type: 'op_not', inputs: a ? { A: a } : {} }; }
        // "is VALUE in between LOW and HIGH" = not (VALUE < LOW) and not (VALUE > HIGH)
        case 'flipperoperator_isInBetween': {
          const value = () => input(b.inputs.VALUE);
          return { type: 'op_and', inputs: {
            A: { block: { type: 'op_not', inputs: { A: { block: { type: 'op_lt', inputs: { A: value(), B: input(b.inputs.LOW) } } } } } },
            B: { block: { type: 'op_not', inputs: { A: { block: { type: 'op_gt', inputs: { A: value(), B: input(b.inputs.HIGH) } } } } } },
          } };
        }
        default:
          warn('The SPIKE block "' + b.opcode + '" is not in the simulator, so it was left out.');
          return null;
      }
    }

    // Statement -> Blockly block JSON (or null to skip).
    function stmt(b) {
      const S = (type, fields, inputs) => ({ type, fields: fields || {}, inputs: inputs || {} });
      const unit = (k) => UNIT_IN[field(b, k)] || field(b, k);
      const sub = (k) => { const first = b.inputs[k] && b.inputs[k][1]; const c = first ? chain(first) : null; return c ? { block: c } : undefined; };
      const withSubs = (blk, map) => { for (const [from, to] of Object.entries(map)) { const s = sub(from); if (s) blk.inputs[to] = s; } return blk; };
      const withCond = (blk) => { const c = boolIn(b.inputs.CONDITION); if (c) blk.inputs.COND = c; return blk; };
      const steering = () => {
        const lit = menuOf(b.inputs.STEERING);
        const inp = input(b.inputs.STEERING);
        return { lit, inp };
      };
      switch (b.opcode) {
        case 'flippermotor_motorTurnForDirection': return S('sp_motor_run', { PORT: portOf(b), DIR: MOTOR_DIR_IN[menuOf(b.inputs.DIRECTION)] || 'cw', UNIT: field(b, 'UNIT') || 'rotations' }, { AMOUNT: input(b.inputs.VALUE) });
        case 'flippermotor_motorGoDirectionToPosition': return S('sp_motor_goto', { PORT: portOf(b), MODE: field(b, 'DIRECTION') || 'shortest' }, { POS: input(b.inputs.POSITION) });
        case 'flippermotor_motorStartDirection': return S('sp_motor_start', { PORT: portOf(b), DIR: MOTOR_DIR_IN[menuOf(b.inputs.DIRECTION)] || 'cw' });
        case 'flippermotor_motorStop': return S('sp_motor_stop', { PORT: portOf(b) });
        case 'flippermotor_motorSetSpeed': return S('sp_motor_set_speed', { PORT: portOf(b) }, { SPEED: input(b.inputs.SPEED) });
        case 'flippermoremotor_motorSetDegreeCounted': case 'flippermotor_motorSetDegreeCounted': return S('sp_motor_set_relative', { PORT: portOf(b) }, { POS: input(b.inputs.VALUE) });
        case 'flippermove_move': return S('sp_move', { DIR: menuOf(b.inputs.DIRECTION) === 'back' ? 'back' : 'fwd', UNIT: unit('UNIT') || 'cm' }, { AMOUNT: input(b.inputs.VALUE) });
        case 'flippermove_steer': return S('sp_move_steer', { UNIT: unit('UNIT') || 'cm' }, { STEER: steering().inp, AMOUNT: input(b.inputs.VALUE) });
        case 'flippermove_startMove': return S('sp_start_moving', { DIR: menuOf(b.inputs.DIRECTION) === 'back' ? 'back' : 'fwd' });
        case 'flippermove_startSteer': return S('sp_start_steer', {}, { STEER: steering().inp });
        case 'flippermoremove_startDualSpeed': case 'flippermove_startDualSpeed': return S('sp_start_tank', {}, { L: input(b.inputs.LEFT), R: input(b.inputs.RIGHT) });
        case 'flippermove_stopMove': return S('sp_stop_moving');
        case 'flippermove_movementSpeed': case 'flippermove_setMovementSpeed': return S('sp_move_speed', {}, { SPEED: input(b.inputs.SPEED) });
        case 'flippermove_setMovementPair': return S('sp_move_motors', { PAIR: drivePair });
        case 'flippermove_setDistance': return S('sp_rotation', { UNIT: unit('UNIT') === 'in' ? 'in' : 'cm' }, { CM: input(b.inputs.DISTANCE) });
        case 'flipperlight_lightDisplayImageOnForTime': case 'flipperlight_lightDisplayImageOn': {
          const img = imageIn(menuOf(b.inputs.MATRIX) || '');
          if (!img.exact) warn('Custom light-matrix pictures were changed to the nearest built-in image ("' + img.name + '").');
          return b.opcode.endsWith('ForTime') ? S('sp_image_for', { IMAGE: img.name }, { SECS: input(b.inputs.VALUE) }) : S('sp_image', { IMAGE: img.name });
        }
        case 'flipperlight_lightDisplayText': return S('sp_write', {}, { TEXT: input(b.inputs.TEXT, 'text') });
        case 'flipperlight_lightDisplayOff': return S('sp_lights_off');
        case 'flipperlight_lightDisplaySetBrightness': return S('sp_brightness', {}, { P: input(b.inputs.BRIGHTNESS) });
        case 'flipperlight_lightDisplaySetPixel': return S('sp_set_pixel', {}, { X: input(b.inputs.X), Y: input(b.inputs.Y), P: input(b.inputs.BRIGHTNESS) });
        case 'flipperlight_centerButtonLight': return S('sp_center_light', { COLOR: LIGHT_IN[menuOf(b.inputs.COLOR)] || 'white' });
        case 'flipperlight_ultrasonicLightUp': {
          const parts = String(menuOf(b.inputs.VALUE) || '100 100 100 100').split(/\s+/);
          return S('sp_eyes', { PORT: portOf(b) }, { A: N(parts[0]), B: N(parts[1]), C2: N(parts[2]), D: N(parts[3]) });
        }
        case 'flippersound_beepForTime': return S('sp_beep_for', {}, { NOTE: input(b.inputs.NOTE), SECS: input(b.inputs.DURATION) });
        case 'flippersound_beep': return S('sp_beep', {}, { NOTE: input(b.inputs.NOTE) });
        case 'flippersound_playSoundUntilDone': case 'flippersound_playSound':
          warn('SPIKE App sounds were changed to the simulator\'s "Beep" sound.');
          return S(b.opcode === 'flippersound_playSound' ? 'sp_start_sound' : 'sp_play_sound', { SOUND: 'Beep' });
        case 'flippersound_stopSound': return S('sp_stop_sounds');
        case 'sound_changevolumeby': return S('sp_change_volume', {}, { VOL: input(b.inputs.VOLUME) });
        case 'sound_setvolumeto': return S('sp_volume', {}, { VOL: input(b.inputs.VOLUME) });
        case 'event_broadcast': case 'event_broadcastandwait': {
          const m = b.inputs.BROADCAST_INPUT && b.inputs.BROADCAST_INPUT[1];
          const name = Array.isArray(m) ? m[1] : (all[m] && Object.values(all[m].fields)[0][0]) || 'message1';
          return S(b.opcode === 'event_broadcast' ? 'sp_broadcast' : 'sp_broadcast_wait', { MSG: name });
        }
        case 'control_wait': return S('sp_wait', {}, { SECS: input(b.inputs.DURATION) });
        case 'control_repeat': return withSubs(S('sp_repeat', {}, { TIMES: input(b.inputs.TIMES) }), { SUBSTACK: 'DO' });
        case 'control_forever': return withSubs(S('sp_forever'), { SUBSTACK: 'DO' });
        case 'control_if': return withSubs(withCond(S('sp_if')), { SUBSTACK: 'DO' });
        case 'control_if_else': return withSubs(withCond(S('sp_ifelse')), { SUBSTACK: 'DO', SUBSTACK2: 'ELSE' });
        case 'control_wait_until': return withCond(S('sp_wait_until'));
        case 'control_repeat_until': return withSubs(withCond(S('sp_repeat_until')), { SUBSTACK: 'DO' });
        case 'flippercontrol_stop': case 'control_stop': {
          const opt = field(b, 'STOP_OPTION') || 'all';
          return S('sp_stop', { WHAT: /this/.test(opt) ? 'this stack' : 'all' });
        }
        case 'flippersensors_resetYaw': case 'flippersensors_resetYawAxis': return S('sp_set_yaw', {}, { VALUE: N(0) });
        case 'flippersensors_resetTimer': return S('sp_reset_timer');
        case 'data_setvariableto': return { type: 'variables_set', fields: { VAR: { id: varId(field(b, 'VARIABLE')) } }, inputs: { VALUE: input(b.inputs.VALUE, 'auto') } };
        case 'data_changevariableby': return { type: 'math_change', fields: { VAR: { id: varId(field(b, 'VARIABLE')) } }, inputs: { DELTA: input(b.inputs.VALUE) } };
        case 'procedures_call': {
          const p = procs[b.mutation.proccode];
          if (!p) { warn('A My Block call without its "define" block was left out.'); return null; }
          const ids = JSON.parse(b.mutation.argumentids || '[]');
          const inputs = {};
          ids.forEach((aid, i) => { inputs['ARG' + i] = input(b.inputs[aid], 'auto'); });
          return { type: 'procedures_callnoreturn', extraState: { name: p.name, params: p.params }, inputs };
        }
        case 'flippermoremove_movementSetAcceleration': {
          const v = String(menuOf(b.inputs.ACCELERATION) || '3000 3000').split(' ')[0];
          return S('sp_move_accel', { ACCEL: Number(v) <= 1500 ? 'slow' : Number(v) >= 6000 ? 'fast' : 'medium' });
        }
        case 'flippermoremove_movementSetStopMethod':
          return S('sp_move_stop', { STOP: { 0: 'coast', 1: 'brake', 2: 'hold' }[field(b, 'STOP')] || 'brake' });
        case 'flippermoremotor_motorSetAcceleration':
          warn('"set acceleration" blocks for single motors were left out: the simulator uses the hub\'s default for them.');
          return null;
        case 'flippermoremotor_motorSetStopMethod':
          warn('"set motors to ... at stop" blocks for single motors were left out.');
          return null;
        default:
          warn('The SPIKE block "' + b.opcode + '" is not in the simulator, so it was left out.');
          return null;
      }
    }

    function chain(firstId) {
      let head = null, tail = null;
      for (let id = firstId; id && all[id]; id = all[id].next) {
        const blk = stmt(all[id]);
        if (!blk) continue;
        if (tail) tail.next = { block: blk }; else head = blk;
        tail = blk;
      }
      return head;
    }

    function hat(b) {
      const H = (type, fields, inputs) => ({ type, fields: fields || {}, inputs: inputs || {} });
      switch (b.opcode) {
        case 'flipperevents_whenProgramStarts': return H('sp_when_start');
        case 'flipperevents_whenColor': return H('sp_when_color', { PORT: portOf(b), COLOR: COLOR_IN[menuOf(b.inputs.OPTION)] || 'red' });
        case 'flipperevents_whenDistance': return H('sp_when_distance', { PORT: portOf(b), OP: DIST_IN[field(b, 'COMPARATOR')] || 'closer than', UNIT: UNIT_IN[field(b, 'UNIT')] || field(b, 'UNIT') || 'cm' }, { VALUE: input(b.inputs.VALUE) });
        case 'flipperevents_whenTimer': return H('sp_when_timer', {}, { VALUE: input(b.inputs.VALUE) });
        case 'flipperevents_whenButton': return H('sp_when_button', { BTN: field(b, 'BUTTON') || 'left', STATE: field(b, 'EVENT') || 'pressed' });
        case 'event_whenbroadcastreceived': return H('sp_when_receive', { MSG: field(b, 'BROADCAST_OPTION') || 'message1' });
        default: return null;
      }
    }

    const top = [];
    const ids = Object.keys(all).filter((id) => all[id] && all[id].topLevel && !all[id].shadow);
    ids.forEach((id, i) => {
      const b = all[id];
      if (!b.opcode) return;
      const pos = { x: Math.round((b.x || 0) / 1.6), y: Math.round((b.y || i * 200) / 1.6) };
      if (b.opcode === 'procedures_definition') {
        const proto = all[b.inputs.custom_block[1]];
        const p = procs[proto.mutation.proccode];
        const def = { type: 'procedures_defnoreturn', ...pos, fields: { NAME: p.name }, extraState: { params: p.params.map((name) => ({ name, id: varId(name) })) }, inputs: {} };
        const body = b.next ? chain(b.next) : null;
        if (body) def.inputs.STACK = { block: body };
        top.push(def);
        return;
      }
      const h = hat(b);
      if (h) {
        const body = b.next ? chain(b.next) : null;
        if (body) h.next = { block: body };
        top.push(Object.assign(h, pos));
      } else if (b.opcode.indexOf('flipperevents_') === 0) {
        warn('The SPIKE event "' + b.opcode + '" is not in the simulator, so its stack was left out.');
      }
    });

    const varList = [];
    const taken = new Set();
    for (const [id, name] of variables) {
      if (taken.has(String(name).toLowerCase())) continue;
      taken.add(String(name).toLowerCase());
      varList.push({ name, id });
    }
    for (const { id, name } of varIds.values()) varList.push({ name, id });
    // Ports that changed, as { our port: their port } so a later export can put them back.
    const ports = {};
    for (const [their, our] of Object.entries(portMap)) if (their !== our) ports[our] = their;
    if (Object.keys(ports).length) {
      const used = new Set();
      for (const b of Object.values(all)) if (b && b.shadow && /(port|motor|sensor)-selector$/.test(b.opcode)) for (const c of String(Object.values(b.fields)[0][0])) used.add(c);
      const names = { left: 'left drive motor', right: 'right drive motor', arm: 'attachment motor', spare: 'spare motor', color: 'color sensor', color2: 'second color sensor', distance: 'distance sensor' };
      const list = Object.entries(ports).filter(([our, their]) => used.has(their)).map(([our, their]) => 'their port ' + their + ' is now port ' + our + (names[wiring[our]] ? ' (' + names[wiring[our]] + ')' : ''));
      if (list.length) warnings.add('Ports were changed to match the simulator robot: ' + list.join(', ') + '.');
    }
    return { json: { blocks: { languageVersion: 0, blocks: top }, variables: varList }, warnings: [...warnings], ports };
  }

  async function importLlsp3(data, wiring) {
    const zip = await JSZip.loadAsync(data);
    const manifestFile = zip.file('manifest.json');
    const manifest = manifestFile ? JSON.parse(await manifestFile.async('string')) : {};
    if (manifest.type === 'python' || zip.file('projectbody.json')) throw new Error('this is a SPIKE Python project; only word-block projects can be opened as blocks');
    const sb3File = zip.file('scratch.sb3');
    if (!sb3File) throw new Error('no scratch.sb3 inside; is this a SPIKE App 3 word-block project?');
    const sb3 = await JSZip.loadAsync(await sb3File.async('uint8array'));
    const project = JSON.parse(await sb3.file('project.json').async('string'));
    const out = fromProject(project, wiring);
    out.name = manifest.name || '';
    return out;
  }

  window.SpikeFile = { exportLlsp3, importLlsp3, toProject, fromProject };
})();
