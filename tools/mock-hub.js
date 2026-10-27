/* A pretend SPIKE Prime hub for trying the Real robot section without a robot: open the simulator
 * with ?mockhub at the end of its address. It replaces Web Bluetooth with a fake hub that speaks the
 * same protocol (framing, uploads with CRC checks, device notifications, console output) and runs the
 * simulator's replay programs on a simple robot whose right wheel is 3% smaller, so its path drifts. */
(function () {
  'use strict';
  const H = window.BioGlowHub;
  const PORTS = ['A', 'B', 'C', 'D', 'E', 'F'];
  const MAX_PACKET = 20, MAX_CHUNK = 84;
  const WHEEL = 5.6, TRACK = 11.2;

  function makeHub() {
    const motors = { A: { type: 0x30 }, C: { type: 0x30 }, E: { type: 0x30 } };
    for (const m of Object.values(motors)) Object.assign(m, { pos: 0, vel: 0, target: 0, mode: 'brake', accel: 1000 });
    const sensors = { B: 'color', F: 'color' };
    const slots = {};
    let upload = null, notifyTimer = null, tick = null, program = null, yaw = 0;
    const tx = new EventTarget(), rx = {};
    const device = new EventTarget();
    device.name = 'Pretend hub (no robot)';
    let inbox = [];

    function send(bytes) {
      const frame = H.pack(bytes);
      for (let i = 0; i < frame.length; i += MAX_PACKET) {
        const part = frame.slice(i, i + MAX_PACKET);
        setTimeout(() => { tx.value = new DataView(part.buffer); tx.dispatchEvent(new Event('characteristicvaluechanged')); }, 0);
      }
    }
    const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
    const i16 = (v) => u16(v & 0xffff);
    const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
    const consoleMsg = (text) => send([0x21, ...new TextEncoder().encode(text), 0]);

    function devicesPayload() {
      const p = [0x00, 87];
      p.push(0x01, 0, 0, ...i16(Math.round(yaw)), ...i16(0), ...i16(0), ...i16(0), ...i16(0), ...i16(980), ...i16(0), ...i16(0), ...i16(0));
      for (const [port, m] of Object.entries(motors)) {
        const pos = Math.round(m.pos);
        p.push(0x0a, PORTS.indexOf(port), m.type, ...i16((((pos % 360) + 540) % 360) - 180), ...i16(Math.round(m.vel / 11)), Math.max(-100, Math.min(100, Math.round(m.vel / 11))) & 0xff, ...u32(pos | 0));
      }
      for (const [port] of Object.entries(sensors)) p.push(0x0c, PORTS.indexOf(port), 6, ...u16(120), ...u16(400), ...u16(150));
      return [0x3c, ...u16(p.length), ...p];
    }

    function physics(dt) {
      for (const m of Object.values(motors)) {
        if (m.mode === 'run') {
          const d = m.target - m.vel, step = m.accel * dt;
          m.vel += Math.max(-step, Math.min(step, d));
        } else m.vel *= m.mode === 'coast' ? 0.9 : 0.5;
        m.pos += m.vel * dt;
      }
      const k = (Math.PI * WHEEL) / 360;
      const dl = -motors.A.vel * dt * k, dr = motors.E.vel * dt * k * 0.97;
      yaw -= ((dl - dr) / TRACK) * (180 / Math.PI) * 10; // tenths of a degree, anticlockwise positive
      if (yaw > 1800) yaw -= 3600;
      if (yaw < -1800) yaw += 3600;
      if (program) runProgram();
    }

    // Runs a BIOGLOW replay program the way the real one would.
    function startProgram(src) {
      const ports = [...src.match(/^P = \((.*)\)$/m)[1].matchAll(/port\.([A-F])/g)].map((m) => m[1]);
      const accel = Number(src.match(/^ACCEL = (\d+)/m)[1]);
      const block = src.slice(src.indexOf('D = ('), src.indexOf('\n)\n'));
      const data = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]).join('');
      program = { ports, accel, data, i: 0, t: 0, start: performance.now(), last: ports.map(() => null) };
      consoleMsg('BIOGLOW-GO');
    }
    function runProgram() {
      const pr = program, num = (i) => (pr.data.charCodeAt(i) - 40) * 50 + pr.data.charCodeAt(i + 1) - 40;
      const now = performance.now() - pr.start, step = 2 * (pr.ports.length + 1);
      while (pr.i < pr.data.length && pr.t + num(pr.i) <= now) {
        pr.t += num(pr.i);
        pr.ports.forEach((port, k) => {
          const v = num(pr.i + 2 + 2 * k), m = motors[port];
          if (!m) return;
          if (v === 2496 || v === pr.last[k]) return;
          pr.last[k] = v;
          if (v >= 2497) m.mode = ['coast', 'brake', 'hold'][v - 2497];
          else Object.assign(m, { mode: 'run', target: v - 1250, accel: pr.accel });
        });
        pr.i += step;
      }
      if (pr.i >= pr.data.length) {
        for (const m of Object.values(motors)) m.mode = 'brake';
        program = null;
        consoleMsg('BIOGLOW-END');
        send([0x20, 1]);
      }
    }

    function handle(m) {
      const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
      switch (m[0]) {
        case 0x00: send([0x01, 1, 0, ...u16(0), 1, 4, ...u16(321), ...u16(MAX_PACKET), ...u16(2048), ...u16(MAX_CHUNK), ...u16(0)]); break;
        case 0x28: {
          const ms = v.getUint16(1, true);
          clearInterval(notifyTimer);
          if (ms) notifyTimer = setInterval(() => send(devicesPayload()), ms);
          send([0x29, 0]);
          break;
        }
        case 0x46: send([0x47, slots[m[1]] ? 0 : 1]); delete slots[m[1]]; break;
        case 0x0c: {
          const end = m.indexOf(0, 1);
          upload = { slot: m[end + 1], crc: v.getUint32(end + 2, true), bytes: [], running: 0 };
          send([0x0d, 0]);
          break;
        }
        case 0x10: {
          const crc = v.getUint32(1, true), size = v.getUint16(5, true), chunk = m.subarray(7, 7 + size);
          upload.running = H.crc32(chunk, upload.running);
          const ok = upload.running === crc;
          upload.bytes.push(...chunk);
          if (ok && H.crc32(Uint8Array.from(upload.bytes)) === upload.crc) slots[upload.slot] = new TextDecoder().decode(Uint8Array.from(upload.bytes));
          send([0x11, ok ? 0 : 1]);
          break;
        }
        case 0x1e: {
          const stop = m[1], slot = m[2];
          if (stop) { program = null; for (const mo of Object.values(motors)) mo.mode = 'brake'; send([0x1f, 0]); send([0x20, 1]); break; }
          if (!slots[slot]) { send([0x1f, 1]); break; }
          send([0x1f, 0]);
          send([0x20, 0]);
          if (slots[slot].includes('BIOGLOW simulator replay')) setTimeout(() => startProgram(slots[slot]), 60);
          else consoleMsg('Hello from slot ' + slot);
          break;
        }
        default: send([m[0] + 1, 1]);
      }
    }

    rx.writeValueWithoutResponse = async (bytes) => {
      for (const b of new Uint8Array(bytes.buffer || bytes)) {
        if (b === 0x02) { if (inbox.length) handle(H.unpack(inbox)); inbox = []; } else inbox.push(b);
      }
    };
    tx.startNotifications = async () => tx;
    const service = { getCharacteristic: async (id) => (id === H.RX_CHAR ? rx : tx) };
    device.gatt = {
      connected: false,
      connect: async () => { device.gatt.connected = true; tick = setInterval(() => physics(0.01), 10); return { getPrimaryService: async () => service }; },
      disconnect: () => { device.gatt.connected = false; clearInterval(tick); clearInterval(notifyTimer); device.dispatchEvent(new Event('gattserverdisconnected')); },
    };
    device.mock = { motors, slots, get yaw() { return yaw; } };
    return device;
  }

  const bt = { requestDevice: async () => { const d = makeHub(); window.mockHubDevice = d; return d; } };
  try { Object.defineProperty(navigator, 'bluetooth', { value: bt, configurable: true }); } catch (e) { /* read-only navigator */ }
  console.log('BIOGLOW: using a pretend hub (?mockhub)');
})();
