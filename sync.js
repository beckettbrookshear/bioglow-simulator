// Sync: windows on different computers that enter the same keypad code share one block program.
// Edits travel through a free public MQTT relay (HiveMQ) over a secure websocket. The topic is a hash
// of the code and every program is AES-encrypted with a key made from the code, so the relay (and
// anyone listening on it) only sees scrambled data. The latest program is kept on the relay
// ("retained"), so a window that joins later gets it straight away.
(function () {
  'use strict';

  const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
  const MIN_DIGITS = 4, MAX_DIGITS = 8;
  const STALE_MS = 24 * 3600 * 1000;   // a program left on the relay longer than this is not loaded over yours
  const PEER_TIMEOUT = 30000, PING_EVERY = 10000;
  const me = Math.random().toString(36).slice(2, 10);
  const te = new TextEncoder(), td = new TextDecoder();

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function roomFor(code) {
    const topic = 'bioglow-app/v1/' + hex(await crypto.subtle.digest('SHA-256', te.encode('bioglow-sync:' + code))).slice(0, 32);
    const base = await crypto.subtle.importKey('raw', te.encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te.encode('bioglow-sync-v1'), iterations: 150000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return { code, key, state: topic + '/state', presence: topic + '/here' };
  }
  async function seal(room, obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, room.key, te.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64(out);
  }
  async function open(room, text) {
    const all = unb64(text);
    return JSON.parse(td.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, room.key, all.slice(12))));
  }

  function attach({ blocks, print, store, button }) {
    if (!blocks || !button) return;
    const ws = blocks.workspace;
    let client = null, room = null, status = 'off';
    let lastJson = '', lastAt = 0, gotState = false, firstTimer = 0, sendTimer = 0, pingTimer = 0, pending = null;
    const peers = new Map(); // id -> last seen

    // ---- the keypad dialog -------------------------------------------------------------------
    const dlg = document.createElement('dialog');
    dlg.className = 'sync-dlg';
    dlg.innerHTML =
      '<h3>Sync blocks</h3>' +
      '<p class="sync-help">Enter the same code on each computer. Block changes then show up on all of them.</p>' +
      '<div class="sync-code" aria-live="polite"></div>' +
      '<div class="sync-keys">' +
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => '<button data-k="' + d + '">' + d + '</button>').join('') +
      '<button data-k="clear" title="Clear">C</button><button data-k="0">0</button><button data-k="back" title="Delete">&#9003;</button></div>' +
      '<p class="sync-state"></p>' +
      '<div class="sync-actions"><button data-k="close" class="flat">Close</button><button data-k="leave" hidden>Stop syncing</button><button data-k="join" class="suggested">Join</button></div>';
    document.body.appendChild(dlg);
    const codeEl = dlg.querySelector('.sync-code'), stateEl = dlg.querySelector('.sync-state');
    const joinBtn = dlg.querySelector('[data-k=join]'), leaveBtn = dlg.querySelector('[data-k=leave]');
    let typed = '';

    function render() {
      codeEl.textContent = typed ? typed.split('').join(' ') : '– – – –';
      codeEl.classList.toggle('empty', !typed);
      const inRoom = room && typed === room.code;
      joinBtn.disabled = typed.length < MIN_DIGITS || inRoom;
      joinBtn.textContent = room && !inRoom ? 'Switch' : 'Join';
      leaveBtn.hidden = !room;
      const n = peers.size + 1;
      const words = { connecting: 'Connecting…', on: 'Synced with code ' + (room && room.code) + ' · ' + n + (n === 1 ? ' window (waiting for the others)' : ' windows'),
        retry: 'Lost the connection - trying again…', off: 'Not syncing. Use ' + MIN_DIGITS + '–' + MAX_DIGITS + ' digits; longer codes are more private.' };
      stateEl.textContent = words[status];
      stateEl.className = 'sync-state ' + status;
      button.textContent = status === 'off' ? 'Sync' : status === 'on' ? '● Synced ' + room.code + (n > 1 ? ' · ' + n : '') : '○ Sync ' + room.code + '…';
      button.classList.toggle('sync-on', status === 'on');
      button.classList.toggle('sync-wait', status === 'connecting' || status === 'retry');
    }
    function press(k) {
      if (/^\d$/.test(k)) { if (typed.length < MAX_DIGITS) typed += k; }
      else if (k === 'back') typed = typed.slice(0, -1);
      else if (k === 'clear') typed = '';
      else if (k === 'join') { if (!joinBtn.disabled) { join(typed); dlg.close(); } }
      else if (k === 'leave') { leave(true); typed = ''; }
      else if (k === 'close') dlg.close();
      render();
    }
    dlg.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) press(b.dataset.k); else if (e.target === dlg) dlg.close(); });
    dlg.addEventListener('keydown', (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') { e.preventDefault(); press('join'); }
      else return;
      e.preventDefault();
    });
    button.onclick = () => { typed = room ? room.code : ''; render(); dlg.showModal(); joinBtn.focus(); };

    // ---- sending and receiving ---------------------------------------------------------------
    const busy = () => (ws.isDragging && ws.isDragging()) || (Blockly.WidgetDiv && Blockly.WidgetDiv.isVisible()) ||
      (Blockly.DropDownDiv && Blockly.DropDownDiv.isVisible && Blockly.DropDownDiv.isVisible());

    async function publishState() {
      if (!client || !room) return;
      const json = blocks.save(), s = JSON.stringify(json);
      if (s === lastJson) return;
      lastJson = s; lastAt = Date.now();
      const r = room;
      const payload = await seal(r, { from: me, at: lastAt, blocks: json });
      if (client && room === r) client.publish(r.state, payload, { qos: 1, retain: true });
    }
    ws.addChangeListener((e) => {
      if (e.isUiEvent || !room) return;
      clearTimeout(sendTimer);
      sendTimer = setTimeout(publishState, 250);
    });

    function apply(msg) {
      if (busy()) { pending = msg; setTimeout(() => { if (pending === msg) { pending = null; apply(msg); } }, 300); return; }
      const s = JSON.stringify(msg.blocks);
      if (s === lastJson) return;
      const sx = ws.scrollX, sy = ws.scrollY;
      try { blocks.load(msg.blocks); } catch (err) { print('Sync: could not load the program from the other window (' + err.message + ').', 'err'); return; }
      ws.scroll(sx, sy);
      lastJson = JSON.stringify(blocks.save());
    }

    async function onMessage(topic, buf) {
      const r = room;
      if (!r) return;
      const text = buf.toString();
      if (topic === r.presence) {
        let p; try { p = JSON.parse(text); } catch (e) { return; }
        if (!p || p.from === me) return;
        if (p.kind === 'bye') peers.delete(p.from);
        else {
          const isNew = !peers.has(p.from);
          peers.set(p.from, Date.now());
          if (isNew && p.kind === 'hi') { sayHere('here'); print('Sync: another window joined code ' + r.code + '.'); }
        }
        render();
        return;
      }
      if (topic !== r.state || !text) return;
      let msg; try { msg = await open(r, text); } catch (e) { return; }
      if (room !== r || msg.from === me) return;
      const first = !gotState;
      if (first) clearTimeout(firstTimer);
      if (first && Date.now() - msg.at > STALE_MS) { gotState = true; lastJson = ''; publishState(); return; }
      if (msg.at < lastAt) return; // an older edit than the one on screen
      lastAt = msg.at;
      if (first) {
        const mine = JSON.stringify(blocks.save()), had = mine !== JSON.stringify(msg.blocks);
        if (had) store.set('bioglow-sync-backup', mine);
        apply(msg);
        gotState = true;
        if (had) print('Sync: loaded the program shared with code ' + r.code + '. (Your previous program was saved in this browser.)');
      } else apply(msg);
    }

    function sayHere(kind) { if (client && room) client.publish(room.presence, JSON.stringify({ from: me, kind })); }

    async function join(code) {
      if (!window.mqtt || !window.crypto || !crypto.subtle) { print('Sync needs an internet connection and a secure (https) page.', 'err'); return; }
      leave(false);
      const r = await roomFor(code);
      room = r; status = 'connecting'; render();
      gotState = false; lastJson = JSON.stringify(blocks.save()); lastAt = 0; peers.clear();
      store.set('bioglow-sync-code', code);
      const c = window.mqtt.connect(BROKER, {
        clientId: 'bioglow-' + me + '-' + Math.random().toString(36).slice(2, 6), clean: true,
        reconnectPeriod: 3000, connectTimeout: 20000, keepalive: 30,
        will: { topic: r.presence, payload: JSON.stringify({ from: me, kind: 'bye' }), qos: 0, retain: false },
      });
      client = c;
      c.on('connect', () => {
        if (client !== c) return;
        c.subscribe([r.state, r.presence], { qos: 1 }, () => {
          status = 'on'; render();
          sayHere('hi');
          // nobody has shared a program with this code yet: share ours
          clearTimeout(firstTimer);
          firstTimer = setTimeout(() => { if (room === r && !gotState) { gotState = true; lastJson = ''; publishState(); } }, 2500);
        });
      });
      c.on('reconnect', () => { if (client === c) { status = 'retry'; render(); } });
      c.on('offline', () => { if (client === c) { status = 'retry'; render(); } });
      c.on('message', onMessage);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (client !== c) return;
        sayHere('ping');
        const now = Date.now();
        for (const [id, seen] of peers) if (now - seen > PEER_TIMEOUT) peers.delete(id);
        render();
      }, PING_EVERY);
    }

    function leave(forget) {
      clearTimeout(firstTimer); clearTimeout(sendTimer); clearInterval(pingTimer);
      if (client) { try { sayHere('bye'); client.end(false); } catch (e) { /* already closed */ } }
      client = null; room = null; status = 'off'; peers.clear(); pending = null;
      if (forget) store.set('bioglow-sync-code', '');
      render();
    }
    window.addEventListener('pagehide', () => { if (client) sayHere('bye'); });

    render();
    const saved = store.get('bioglow-sync-code');
    if (saved && /^\d{4,8}$/.test(saved)) join(saved);
  }

  window.BioGlowSync = { attach };
})();
