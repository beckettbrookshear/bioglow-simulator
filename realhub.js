/* BIOGLOW real robot link: talks to a real SPIKE Prime hub (SPIKE 3 firmware) over Web Bluetooth,
 * using LEGO's published protocol (https://lego.github.io/spike-prime-docs/). Works in Chrome and Edge.
 *
 * Messages are COBS-encoded (escaping 0x00-0x02), XORed with 3 and ended with 0x02. The hub streams
 * "device notifications" (battery, gyro, every motor and sensor) at the interval we ask for, prints
 * from a running program arrive as console notifications, and programs are uploaded in chunks with a
 * CRC32. Also builds the small MicroPython program that replays a simulator run's motor commands. */
(function (root) {
  'use strict';

  const SERVICE = '0000fd02-0000-1000-8000-00805f9b34fb';
  const RX_CHAR = '0000fd02-0001-1000-8000-00805f9b34fb'; // we write here (hub receives)
  const TX_CHAR = '0000fd02-0002-1000-8000-00805f9b34fb'; // hub notifies here (hub transmits)
  const PORT_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'];
  const MOTOR_TYPES = { 0x30: 'medium', 0x31: 'large', 0x41: 'small' };
  const COLOURS = ['black', 'magenta', 'violet', 'blue', 'azure', 'cyan', 'green', 'yellow', 'orange', 'red', 'white'];

  // ---- framing ----------------------------------------------------------------
  const MAX_BLOCK = 84, NO_DELIM = 0xff, OFFSET = 2;

  function cobsEncode(data) {
    const out = [];
    let codeAt = 0, block = 0;
    const begin = () => { codeAt = out.length; out.push(NO_DELIM); block = 1; };
    begin();
    for (const b of data) {
      if (b > 2) { out.push(b); block++; }
      if (b <= 2 || block > MAX_BLOCK) {
        if (b <= 2) out[codeAt] = b * MAX_BLOCK + block + OFFSET;
        begin();
      }
    }
    out[codeAt] = block + OFFSET;
    return out;
  }

  function cobsDecode(data) {
    const out = [];
    const unescape = (code) => {
      if (code === 0xff) return [null, MAX_BLOCK + 1];
      let value = Math.floor((code - OFFSET) / MAX_BLOCK), block = (code - OFFSET) % MAX_BLOCK;
      if (block === 0) { block = MAX_BLOCK; value--; }
      return [value, block];
    };
    let [value, block] = unescape(data[0]);
    for (let i = 1; i < data.length; i++) {
      if (--block > 0) { out.push(data[i]); continue; }
      if (value !== null) out.push(value);
      [value, block] = unescape(data[i]);
    }
    return Uint8Array.from(out);
  }

  function pack(msg) {
    const enc = cobsEncode(msg).map((b) => b ^ 3);
    enc.push(0x02);
    return Uint8Array.from(enc);
  }

  // one complete frame (without its delimiters) -> message bytes
  const unpack = (body) => cobsDecode(Uint8Array.from(body, (b) => b ^ 3));

  // CRC32 as the hub wants it: zlib's CRC32 over data padded with zeros to a multiple of 4 bytes
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(data, seed = 0) {
    let c = ~seed >>> 0;
    const len = Math.ceil(data.length / 4) * 4;
    for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ (i < data.length ? data[i] : 0)) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // ---- messages ---------------------------------------------------------------
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const MSG = {
    info: () => [0x00],
    deviceNotifications: (ms) => [0x28, ...u16(ms)],
    clearSlot: (slot) => [0x46, slot],
    startFileUpload: (name, slot, crc) => [0x0c, ...new TextEncoder().encode(name), 0, slot, ...u32(crc)],
    transferChunk: (runningCrc, chunk) => [0x10, ...u32(runningCrc), ...u16(chunk.length), ...chunk],
    programFlow: (stop, slot) => [0x1e, stop ? 1 : 0, slot],
  };
  const RESPONSE = { info: 0x01, deviceNotifications: 0x29, clearSlot: 0x47, startFileUpload: 0x0d, transferChunk: 0x11, programFlow: 0x1f };

  // Device messages inside a DeviceNotification: id -> total length including the id byte
  const DEVICE_LEN = { 0x00: 2, 0x01: 21, 0x02: 26, 0x0a: 12, 0x0b: 4, 0x0c: 9, 0x0d: 4, 0x0e: 11 };

  function parseDevices(p) {
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const out = { ports: {} };
    let i = 0;
    while (i < p.length) {
      const id = p[i], len = DEVICE_LEN[id];
      if (!len || i + len > p.length) { out.unknown = id; break; }
      const port = PORT_NAMES[p[i + 1]];
      if (id === 0x00) out.battery = p[i + 1];
      else if (id === 0x01) {
        out.imu = {
          up: p[i + 1], yawFace: p[i + 2],
          yaw: v.getInt16(i + 3, true), pitch: v.getInt16(i + 5, true), roll: v.getInt16(i + 7, true),
          accel: [v.getInt16(i + 9, true), v.getInt16(i + 11, true), v.getInt16(i + 13, true)],
          gyro: [v.getInt16(i + 15, true), v.getInt16(i + 17, true), v.getInt16(i + 19, true)],
        };
      } else if (id === 0x02) out.matrix = Array.from(p.subarray(i + 1, i + 26));
      else if (id === 0x0a) out.ports[port] = { kind: 'motor', motor: MOTOR_TYPES[p[i + 2]] || 'motor', abs: v.getInt16(i + 3, true), power: v.getInt16(i + 5, true), speed: v.getInt8(i + 7), pos: v.getInt32(i + 8, true) };
      else if (id === 0x0b) out.ports[port] = { kind: 'force', value: p[i + 2], pressed: !!p[i + 3] };
      else if (id === 0x0c) { const c = v.getInt8(i + 2); out.ports[port] = { kind: 'color', color: COLOURS[c] || 'none', rgb: [v.getUint16(i + 3, true), v.getUint16(i + 5, true), v.getUint16(i + 7, true)] }; }
      else if (id === 0x0d) out.ports[port] = { kind: 'distance', mm: v.getInt16(i + 2, true) };
      else if (id === 0x0e) out.ports[port] = { kind: 'matrix3' };
      i += len;
    }
    return out;
  }

  function parseMessage(m) {
    const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
    switch (m[0]) {
      case 0x01: return {
        type: 'info', rpc: m[1] + '.' + m[2] + '.' + v.getUint16(3, true), firmware: m[5] + '.' + m[6] + '.' + v.getUint16(7, true),
        maxPacket: v.getUint16(9, true), maxMessage: v.getUint16(11, true), maxChunk: v.getUint16(13, true), product: v.getUint16(15, true),
      };
      case 0x20: return { type: 'program', running: m[1] === 0 };
      case 0x21: { const end = m.indexOf(0, 1); return { type: 'console', text: new TextDecoder().decode(m.subarray(1, end < 0 ? m.length : end)) }; }
      case 0x3c: return { type: 'devices', ...parseDevices(m.subarray(3, 3 + v.getUint16(1, true))) };
      case 0x32: return { type: 'tunnel' };
      default: return { type: 'response', ok: m[1] === 0 };
    }
  }

  // ---- the hub connection -------------------------------------------------------
  class SpikeHub {
    constructor(bluetooth) {
      this.bluetooth = bluetooth || (typeof navigator !== 'undefined' && navigator.bluetooth);
      this.handlers = {};
      this.pending = [];
      this.queue = Promise.resolve();
      this.buf = { hi: null, lo: null };
      this.info = null;
      this.connected = false;
    }
    static get supported() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }
    on(event, fn) { (this.handlers[event] = this.handlers[event] || []).push(fn); return this; }
    emit(event, data) { for (const fn of this.handlers[event] || []) { try { fn(data); } catch (e) { console.error(e); } } }

    async connect(intervalMs = 50) {
      if (!this.bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome or Edge on a computer.');
      this.device = await this.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
      this.device.addEventListener('gattserverdisconnected', () => this.dropped());
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      this.rx = await service.getCharacteristic(RX_CHAR);
      this.tx = await service.getCharacteristic(TX_CHAR);
      this.tx.addEventListener('characteristicvaluechanged', (e) => {
        const dv = e.target.value;
        this.receive(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
      });
      await this.tx.startNotifications();
      this.connected = true;
      this.info = await this.request('info', MSG.info());
      this.emit('log', 'Hub firmware ' + this.info.firmware + ', protocol ' + this.info.rpc + ', packets up to ' + this.info.maxPacket + ' bytes');
      await this.setInterval(intervalMs);
      return this.info;
    }

    get name() { return (this.device && this.device.name) || 'SPIKE Prime hub'; }

    disconnect() {
      if (this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      else this.dropped();
    }

    dropped() {
      if (!this.connected && !this.device) return;
      this.connected = false;
      for (const p of this.pending) { clearTimeout(p.timer); p.reject(new Error('The hub disconnected.')); }
      this.pending = [];
      this.emit('disconnect');
    }

    setInterval(ms) { return this.request('deviceNotifications', MSG.deviceNotifications(ms)); }

    // Bytes can arrive split over several notifications or several messages per notification.
    // 0x01 starts a high-priority message (pausing a low-priority one), 0x02 ends the current one.
    receive(bytes) {
      for (const b of bytes) {
        if (b === 0x01) { this.buf.hi = []; continue; }
        if (b === 0x02) {
          if (this.buf.hi) { this.deliver(this.buf.hi); this.buf.hi = null; }
          else if (this.buf.lo) { this.deliver(this.buf.lo); this.buf.lo = null; }
          else this.buf.lo = [];
          continue;
        }
        if (this.buf.hi) this.buf.hi.push(b);
        else (this.buf.lo = this.buf.lo || []).push(b);
      }
    }

    deliver(body) {
      if (!body.length) return;
      let msg;
      try { msg = unpack(body); } catch (e) { this.emit('log', 'Could not decode a message from the hub'); return; }
      if (!msg.length) return;
      const parsed = parseMessage(msg);
      const waiting = this.pending.findIndex((p) => p.id === msg[0]);
      if (waiting >= 0) {
        const p = this.pending.splice(waiting, 1)[0];
        clearTimeout(p.timer);
        p.resolve(parsed);
      }
      if (parsed.type === 'devices') this.emit('devices', parsed);
      else if (parsed.type === 'console') this.emit('console', parsed.text);
      else if (parsed.type === 'program') this.emit('program', parsed.running);
    }

    send(msg) {
      const frame = pack(msg);
      const size = (this.info && this.info.maxPacket) || frame.length;
      const job = this.queue.then(async () => {
        for (let i = 0; i < frame.length; i += size) {
          const part = frame.slice(i, i + size);
          if (this.rx.writeValueWithoutResponse) await this.rx.writeValueWithoutResponse(part);
          else await this.rx.writeValue(part);
        }
      });
      this.queue = job.catch(() => {});
      return job;
    }

    request(kind, msg, timeoutMs = 5000) {
      if (!this.connected) return Promise.reject(new Error('Not connected to a hub.'));
      return new Promise((resolve, reject) => {
        const p = { id: RESPONSE[kind], resolve, reject };
        p.timer = setTimeout(() => {
          this.pending = this.pending.filter((x) => x !== p);
          reject(new Error('The hub did not answer (' + kind + ').'));
        }, timeoutMs);
        this.pending.push(p);
        this.send(msg).catch((e) => { clearTimeout(p.timer); this.pending = this.pending.filter((x) => x !== p); reject(e); });
      });
    }

    // Stores a program in a slot (0-19). progress(fraction) is called as chunks go across.
    async upload(source, slot, progress) {
      const data = new TextEncoder().encode(source);
      await this.request('clearSlot', MSG.clearSlot(slot)); // not acknowledged when the slot was already empty; fine
      const start = await this.request('startFileUpload', MSG.startFileUpload('program.py', slot, crc32(data)));
      if (!start.ok) throw new Error('The hub refused the upload.');
      const size = this.info.maxChunk;
      let running = 0;
      for (let i = 0; i < data.length; i += size) {
        const chunk = data.subarray(i, i + size);
        running = crc32(chunk, running);
        const r = await this.request('transferChunk', MSG.transferChunk(running, chunk));
        if (!r.ok) throw new Error('The hub rejected part of the program.');
        if (progress) progress(Math.min(1, (i + size) / data.length));
      }
    }

    async run(slot) { const r = await this.request('programFlow', MSG.programFlow(false, slot)); if (!r.ok) throw new Error('The hub would not start slot ' + slot + '.'); }
    async stop(slot) { await this.request('programFlow', MSG.programFlow(true, slot)); }
  }

  // ---- replaying a simulator run on the real robot --------------------------------
  // rows: [[ms since the previous row, value for each port...]], where a value is a speed in degrees per
  // second or 'coast' / 'brake' / 'hold'. Each number is stored as two characters (base 50, '(' to 'Y',
  // nothing that needs escaping) so a long run still makes a small file.
  const STOP_CODES = { coast: 2497, brake: 2498, hold: 2499 };
  const SPEED_ZERO = 1250;
  const enc2 = (n) => String.fromCharCode(40 + Math.floor(n / 50), 40 + (n % 50));

  function encodeRows(rows) {
    let s = '';
    for (const [dt, ...vals] of rows) {
      let wait = Math.max(0, Math.round(dt));
      while (wait > 2400) { // longer pauses become repeated rows
        s += enc2(2400) + vals.map(() => enc2(2496)).join(''); // 2496 = keep doing what you were doing
        wait -= 2400;
      }
      s += enc2(wait);
      for (const v of vals) s += enc2(typeof v === 'string' ? STOP_CODES[v] : Math.max(-1200, Math.min(1200, Math.round(v))) + SPEED_ZERO);
    }
    return s;
  }

  function replayProgram({ ports, rows, accel, about }) {
    const data = encodeRows(rows);
    const lines = [];
    for (let i = 0; i < data.length; i += 96) lines.push("    '" + data.slice(i, i + 96) + "'");
    return [
      '# BIOGLOW simulator replay: ' + (about || 'motor commands from a simulator run') + '.',
      '# Made by the BIOGLOW FLL Robot Simulator. It drives the motors exactly as the simulator did,',
      '# without reading any sensors, so the two robots can be compared.',
      'import motor, runloop, time',
      'from hub import port',
      '',
      'P = (' + ports.map((p) => 'port.' + p).join(', ') + (ports.length === 1 ? ',' : '') + ')',
      'ACCEL = ' + Math.round(accel),
      'D = (',
      ...lines,
      ')',
      '',
      'def num(i):',
      '    return (ord(D[i]) - 40) * 50 + ord(D[i + 1]) - 40',
      '',
      'def drive(p, v):',
      '    try:',
      '        motor.run(p, v, acceleration=ACCEL)',
      '    except TypeError:',
      '        motor.run(p, v)',
      '',
      'async def main():',
      '    n = len(P)',
      '    step = 2 * (n + 1)',
      '    last = [None] * n',
      "    print('BIOGLOW-GO')",
      '    t0 = time.ticks_ms()',
      '    t = 0',
      '    i = 0',
      '    while i < len(D):',
      '        t += num(i)',
      '        while time.ticks_diff(time.ticks_ms(), t0) < t:',
      '            await runloop.sleep_ms(2)',
      '        for k in range(n):',
      '            v = num(i + 2 + 2 * k)',
      '            if v != 2496 and v != last[k]:',
      '                last[k] = v',
      '                if v == 2497:',
      '                    motor.stop(P[k], stop=motor.COAST)',
      '                elif v == 2498:',
      '                    motor.stop(P[k], stop=motor.BRAKE)',
      '                elif v == 2499:',
      '                    motor.stop(P[k], stop=motor.HOLD)',
      '                else:',
      '                    drive(P[k], v - ' + SPEED_ZERO + ')',
      '        i += step',
      '    for p in P:',
      '        motor.stop(p, stop=motor.BRAKE)',
      "    print('BIOGLOW-END')",
      '',
      'runloop.run(main())',
      '',
    ].join('\n');
  }

  const api = { SERVICE, RX_CHAR, TX_CHAR, SpikeHub, pack, unpack, cobsEncode, cobsDecode, crc32, parseMessage, MSG, encodeRows, replayProgram, STOP_CODES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BioGlowHub = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
