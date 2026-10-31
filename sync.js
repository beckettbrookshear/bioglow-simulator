// Sync: windows on different computers that enter the same keypad code share one block program.
// Edits travel through a free public MQTT relay (HiveMQ) over a secure websocket. Each computer also
// keeps a team password, typed once. The topic is a hash of the password and code, and every program is
// AES-encrypted with a key made from both, so someone without the password who types the same code is
// on a different channel: they can't see, change or erase the team's blocks. The relay (and anyone
// listening on it) only sees scrambled data. The latest program is kept on the relay
// ("retained"), so a window that joins later gets it straight away.
(function () {
  'use strict';

  const BROKER = 'wss://broker.hivemq.com:8884/mqtt';
  const MIN_DIGITS = 4, MAX_DIGITS = 8, MIN_PASS = 8;
  const STALE_MS = 24 * 3600 * 1000;   // a program left on the relay longer than this is not loaded over yours
  const PEER_TIMEOUT = 30000, PING_EVERY = 10000;
  const me = Math.random().toString(36).slice(2, 10);
  const te = new TextEncoder(), td = new TextDecoder();

  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (bytes) => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function keyFrom(secret, salt) {
    const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: te.encode(salt), iterations: 150000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Anyone can watch every channel name on a public relay, so names come from the same slow key
  // stretching as the encryption key: working backwards from a name to the password takes ages.
  async function topicFrom(secret, salt) {
    const base = await crypto.subtle.importKey('raw', te.encode(secret), 'PBKDF2', false, ['deriveBits']);
    return 'bioglow-app/v2/' + hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: te.encode(salt), iterations: 150000, hash: 'SHA-256' }, base, 128));
  }
  async function roomFor(code, pass) {
    const topic = await topicFrom(pass + '\n' + code, 'bioglow-sync-topic-v2');
    const key = await keyFrom(pass + '\n' + code, 'bioglow-sync-v2');
    return { code, pass, key, state: topic + '/state', presence: topic + '/here' };
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
      '<label class="sync-team">Team password<input type="password" class="sync-pass" autocomplete="off" spellcheck="false"></label>' +
      '<p class="sync-help sync-team-help">Everyone on your team types the same one, once per computer. Without it, nobody can see or change your blocks, even with your code.</p>' +
      '<div class="sync-code" aria-live="polite"></div>' +
      '<div class="sync-keys">' +
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => '<button data-k="' + d + '">' + d + '</button>').join('') +
      '<button data-k="clear" title="Clear">C</button><button data-k="0">0</button><button data-k="back" title="Delete">&#9003;</button></div>' +
      '<p class="sync-state"></p>' +
      '<div class="sync-actions"><button data-k="close" class="flat">Close</button><button data-k="leave" hidden>Stop syncing</button><button data-k="join" class="suggested">Join</button></div>';
    document.body.appendChild(dlg);
    const codeEl = dlg.querySelector('.sync-code'), stateEl = dlg.querySelector('.sync-state');
    const joinBtn = dlg.querySelector('[data-k=join]'), leaveBtn = dlg.querySelector('[data-k=leave]'), passEl = dlg.querySelector('.sync-pass');
    let typed = '';

    function render() {
      codeEl.textContent = typed ? typed.split('').join(' ') : '– – – –';
      codeEl.classList.toggle('empty', !typed);
      const pass = passEl.value, passOk = pass.length >= MIN_PASS;
      const inRoom = room && typed === room.code && pass === room.pass;
      joinBtn.disabled = !passOk || typed.length < MIN_DIGITS || inRoom || (/^\d+$/.test(typed) && typed.length > MAX_DIGITS);
      joinBtn.textContent = room && !inRoom ? 'Switch' : 'Join';
      leaveBtn.hidden = !room;
      const n = peers.size + 1;
      const words = { connecting: 'Connecting…', on: 'Synced with code ' + (room && room.code) + ' · ' + n + (n === 1 ? ' window (waiting for the others)' : ' windows'),
        retry: 'Lost the connection - trying again…', off: 'Not syncing. Use ' + MIN_DIGITS + '–' + MAX_DIGITS + ' digits; longer codes are more private.' };
      stateEl.textContent = status === 'off' && !passOk ? 'Type the team password (at least ' + MIN_PASS + ' characters).' : words[status];
      stateEl.className = 'sync-state ' + status;
      button.textContent = status === 'off' ? 'Sync' : status === 'on' ? '● Synced ' + room.code + (n > 1 ? ' · ' + n : '') : '○ Sync ' + room.code + '…';
      button.classList.toggle('sync-on', status === 'on');
      button.classList.toggle('sync-wait', status === 'connecting' || status === 'retry');
    }
    function press(k) {
      if (/^\d$/.test(k) || /^[a-z]$/.test(k)) { if (typed.length < MAX_DIGITS + 2) typed += k; } // letters only from a keyboard
      else if (k === 'back') typed = typed.slice(0, -1);
      else if (k === 'clear') typed = '';
      else if (k === 'join') { if (!joinBtn.disabled) tryJoin(typed); }
      else if (k === 'leave') { leave(true); typed = ''; }
      else if (k === 'close') dlg.close();
      render();
    }
    dlg.addEventListener('click', (e) => { const b = e.target.closest('button[data-k]'); if (b) press(b.dataset.k); else if (e.target === dlg) dlg.close(); });
    passEl.addEventListener('input', render);
    dlg.addEventListener('keydown', (e) => {
      if (e.target === passEl) { if (e.key === 'Enter') { e.preventDefault(); press('join'); } return; } // typing the password
      if (/^\d$/.test(e.key)) press(e.key);
      else if (/^[a-z]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) press(e.key.toLowerCase());
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') { e.preventDefault(); press('join'); }
      else return;
      e.preventDefault();
    });
    async function tryJoin(code) {
      store.set('bioglow-team-pass', passEl.value);
      if (await isChatCode(code)) { typed = ''; render(); dlg.close(); openChat(store); return; }
      if (!/^\d+$/.test(code)) { stateEl.textContent = 'Codes are digits only.'; return; }
      join(code); dlg.close(); render();
    }
    button.onclick = () => {
      typed = room ? room.code : ''; passEl.value = store.get('bioglow-team-pass') || '';
      render(); dlg.showModal();
      (passEl.value ? joinBtn : passEl).focus();
    };

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
        let p; try { p = await open(r, text); } catch (e) { return; } // (presence is encrypted too)
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

    async function sayHere(kind) {
      const r = room;
      if (!client || !r) return;
      const payload = await seal(r, { from: me, kind });
      if (client && room === r) client.publish(r.presence, payload);
    }

    async function join(code) {
      if (!window.mqtt || !window.crypto || !crypto.subtle) { print('Sync needs an internet connection and a secure (https) page.', 'err'); return; }
      leave(false);
      const pass = store.get('bioglow-team-pass') || '';
      if (pass.length < MIN_PASS) return;
      const r = await roomFor(code, pass);
      r.bye = await seal(r, { from: me, kind: 'bye' }); // ready ahead, so leaving can send it straight away
      room = r; status = 'connecting'; render();
      gotState = false; lastJson = JSON.stringify(blocks.save()); lastAt = 0; peers.clear();
      store.set('bioglow-sync-code', code);
      const c = window.mqtt.connect(BROKER, {
        clientId: 'bioglow-' + me + '-' + Math.random().toString(36).slice(2, 6), clean: true,
        reconnectPeriod: 3000, connectTimeout: 20000, keepalive: 30,
        will: { topic: r.presence, payload: r.bye, qos: 0, retain: false },
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
      if (client && room) { try { client.publish(room.presence, room.bye); client.end(false); } catch (e) { /* already closed */ } }
      client = null; room = null; status = 'off'; peers.clear(); pending = null;
      if (forget) store.set('bioglow-sync-code', '');
      render();
    }
    window.addEventListener('pagehide', () => { if (client && room) client.publish(room.presence, room.bye); });

    render();
    const saved = store.get('bioglow-sync-code');
    if (saved && /^\d{4,8}$/.test(saved)) join(saved); // (only once a team password is saved)
  }

  // ---- chat --------------------------------------------------------------------------------------
  // The Chat tab asks for the chat code (typing the keypad code on the Sync keypad also opens it). Only fingerprints (hashes) of both codes are kept here. Messages are encrypted with a
  // key made from the second code, like Sync, and the last 50 stay on the relay for people who join later.
  const CHAT_OPEN = '54f8a2bf6302602207f077e774c4a8bb3381ab3e907f5dc7f8fdb720062ea30c';
  const CHAT_PASS = '0cd1a20c3a139caa98773abb0b6a62cec11ab2f1d23433b7054125f3315654ef';
  const CHAT_KEEP = 50;
  const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', te.encode(s)));
  const isChatCode = async (typed) => !!(window.crypto && crypto.subtle) && /[a-z]/.test(typed) && (await sha('bioglow-chat:' + typed)) === CHAT_OPEN;

  // Language filter. The word list is base64 so it doesn't show up as plain text in the page source.
  // A word ending in * also matches longer words that start with it, and one ending in ~ matches
  // anywhere inside a word. Look-alike symbols (sh!t), stretched letters (fuuuck) and spaced-out
  // letters (f u c k) are undone before checking.
  const BAD = atob('ZnVja34gZnVrKiBmY2sgZmsgc3RmdSB3dGYgc2hpdH4gc2gxdCBjdW50KiBiaXRjaCogYmlhdGNoIGRpY2sgZGlja3MgZGlja2hlYWQgY29jayBjb2NrcyBwdXNzeSBwdXNzaWVzIGFzcyBhc3NlcyBhc3Nob2xlKiBhcnNlIGR1bWJhc3MgamFja2FzcyBhc3NoYXQgYXNzd2lwZSBiYXN0YXJkKiBzbHV0KiB3aG9yZSogcGlzcyogd2FuayogdHdhdCogYm9sbG9jayogbW90aGVyZnVjayogbmlnZ34gZmFnIGZhZ3MgZmFnZ290KiByZXRhcmQqIHRyYW5ueSBraWtlIHNwaWMgY2hpbmsgcG9ybiogbnVkZSBudWRlcyBib29iKiB0aXRzIHRpdHR5IHRpdHRpZXMga3lz')
    .split(' ').map((w) => ({ word: w.replace(/[*~]$/, ''), how: w.slice(-1) }));
  const LOOKALIKE = { 0: 'o', 1: 'i', '!': 'i', '|': 'i', 3: 'e', 4: 'a', '@': 'a', 5: 's', $: 's', 7: 't', 8: 'b' };
  function badLanguage(text) {
    const plain = String(text).toLowerCase().replace(/[0-9!|@$]/g, (c) => LOOKALIKE[c] || c).replace(/[^a-z]+/g, ' ');
    const tokens = [];
    let run = '';
    for (const t of plain.split(' ').filter(Boolean)) { // f u c k -> fuck
      if (t.length === 1) { run += t; continue; }
      if (run) { tokens.push(run); run = ''; }
      tokens.push(t);
    }
    if (run) tokens.push(run);
    return tokens.some((t) => {
      const forms = [t, t.replace(/(.)\1{2,}/g, '$1'), t.replace(/(.)\1+/g, '$1')]; // as typed, fuuuck, fuuck
      return BAD.some(({ word, how }) => forms.some((f, i) => {
        if (i === 2 && /(.)\1/.test(word)) return false; // squashing every double letter only suits words without one
        return how === '~' ? f.includes(word) : how === '*' ? f.startsWith(word) : f === word;
      }));
    });
  }
  const CHAT_STRIKES = 3, CHAT_BAN_MS = 24 * 3600 * 1000;

  // The chat lives in its own Chat tab.
  let chat = null;
  const chatTab = () => document.querySelector('#tabs [data-tab=chat]');
  function setUpChat(store) {
    const tab = chatTab(), host = document.getElementById('chatBox');
    if (chat || !tab || !host) return;
    chat = makeChat(store, host);
    tab.addEventListener('click', () => { tab.classList.remove('alert'); chat.show(); });
  }
  function openChat(store) {
    setUpChat(store);
    if (chat) chatTab().click();
  }
  function makeChat(store, host) {
    const box = document.createElement('div');
    box.className = 'chat-panel';
    box.innerHTML =
      '<form class="chat-lock"><p class="sync-help">Talk with your team. Type the chat code to join.</p>' +
      '<input class="chat-pass" type="password" inputmode="numeric" autocomplete="off" aria-label="Chat code">' +
      '<p class="sync-state chat-err"></p>' +
      '<div class="sync-actions"><button class="suggested">Join</button></div></form>' +
      '<div class="chat-room" hidden>' +
      '<input class="chat-name" maxlength="20" placeholder="Your name" aria-label="Your name">' +
      '<div class="chat-log" aria-live="polite"></div>' +
      '<form class="chat-form"><input class="chat-text" maxlength="300" placeholder="Message" aria-label="Message" autocomplete="off"><button class="suggested">Send</button></form>' +
      '<p class="sync-state chat-status"></p>' +
      '<div class="sync-actions"><button type="button" data-c="leave" class="flat">Leave chat</button></div></div>';
    host.replaceChildren(box); // replaces the "didn't load" note in index.html
    const q = (s) => box.querySelector(s);
    const lock = q('.chat-lock'), passEl = q('.chat-pass'), errEl = q('.chat-err');
    const roomEl = q('.chat-room'), nameEl = q('.chat-name'), logEl = q('.chat-log'), textEl = q('.chat-text'), statusEl = q('.chat-status');
    let client = null, room = null;
    const msgs = new Map(); // id -> { id, name, text, at }
    const muted = new Set(); // senders who got bad language past their own filter

    nameEl.value = store.get('bioglow-chat-name') || '';
    nameEl.onchange = () => store.set('bioglow-chat-name', nameEl.value.trim());

    function status(text, cls) { statusEl.textContent = text; statusEl.className = 'sync-state chat-status ' + (cls || ''); }
    function draw() {
      const atEnd = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
      logEl.textContent = '';
      const list = [...msgs.values()].sort((a, b) => a.at - b.at);
      if (!list.length) { const p = document.createElement('p'); p.className = 'chat-empty'; p.textContent = 'No messages yet.'; logEl.appendChild(p); }
      for (const m of list) {
        const row = document.createElement('div'); row.className = 'chat-msg' + (m.from === me ? ' mine' : '');
        const who = document.createElement('b'); who.textContent = m.name || 'Someone';
        const when = document.createElement('small'); when.textContent = new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const text = document.createElement('span'); text.textContent = m.text;
        row.append(who, ' ', when, text);
        logEl.appendChild(row);
      }
      if (atEnd) logEl.scrollTop = logEl.scrollHeight;
    }
    function merge(list) {
      if (!Array.isArray(list)) return;
      for (const m of list) {
        if (!m || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
        if (badLanguage(m.text) || badLanguage(m.name || '')) muted.add(m.from);
        else if (!msgs.has(m.id) && m.from !== me && !chatTab().classList.contains('on')) chatTab().classList.add('alert'); // new message while on another tab
        msgs.set(m.id, m);
      }
      for (const [id, m] of msgs) if (muted.has(m.from)) msgs.delete(id);
      draw();
    }

    async function enter(pass) {
      const team = store.get('bioglow-team-pass') || '';
      const key = await keyFrom(team + '\n' + pass, 'bioglow-chat-v2');
      const r = { key, topic: (await topicFrom(team + '\n' + pass, 'bioglow-chat-topic-v2')) + '/chat' };
      room = r; msgs.clear(); draw();
      status('Connecting…', 'connecting');
      const c = window.mqtt.connect(BROKER, { clientId: 'bioglow-chat-' + me + '-' + Math.random().toString(36).slice(2, 6), clean: true, reconnectPeriod: 3000, connectTimeout: 20000, keepalive: 30 });
      client = c;
      c.on('connect', () => { if (client === c) c.subscribe(r.topic, { qos: 1 }, () => status('Connected', 'on')); });
      c.on('reconnect', () => { if (client === c) status('Lost the connection - trying again…', 'retry'); });
      c.on('message', async (topic, buf) => {
        if (client !== c || topic !== r.topic || !buf.length) return;
        try { merge(await open(r, buf.toString())); } catch (e) { /* not ours */ }
      });
    }
    async function send(text) {
      if (!client || !room) return;
      const name = nameEl.value.trim();
      if (badLanguage(text) || badLanguage(name)) { strike(); return; }
      store.set('bioglow-chat-name', name);
      const m = { id: me + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), from: me, name, text, at: Date.now() };
      msgs.set(m.id, m); draw();
      logEl.scrollTop = logEl.scrollHeight;
      const list = [...msgs.values()].sort((a, b) => a.at - b.at).slice(-CHAT_KEEP);
      client.publish(room.topic, await seal(room, list), { qos: 1, retain: true });
    }
    const bannedUntil = () => Number(store.get('bioglow-chat-banned-until')) || 0;
    function strike() {
      const n = (Number(store.get('bioglow-chat-strikes')) || 0) + 1;
      if (n < CHAT_STRIKES) {
        store.set('bioglow-chat-strikes', String(n));
        status('That has language that isn\'t allowed, so it wasn\'t sent. ' + (CHAT_STRIKES - n === 1 ? 'Once more and you\'ll be blocked from chat.' : 'Warning ' + n + ' of ' + (CHAT_STRIKES - 1) + '.'), 'retry');
        return;
      }
      store.set('bioglow-chat-strikes', '0');
      store.set('bioglow-chat-banned-until', String(Date.now() + CHAT_BAN_MS));
      close(); // back to the code screen, which says why
      errEl.textContent = blockedText();
    }
    const blockedText = () => 'You\'ve been blocked from chat for 24 hours for using inappropriate language (until ' +
      new Date(bannedUntil()).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ').';

    function close() {
      if (client) { try { client.end(false); } catch (e) { /* already closed */ } }
      client = null; room = null; msgs.clear();
      passEl.value = ''; errEl.textContent = ''; lock.hidden = false; roomEl.hidden = true; // the code is asked for every time
    }

    lock.onsubmit = async (e) => {
      e.preventDefault();
      const pass = passEl.value.trim();
      if (bannedUntil() > Date.now()) { errEl.textContent = blockedText(); return; }
      if ((store.get('bioglow-team-pass') || '').length < MIN_PASS) { errEl.textContent = 'Type your team password in Sync first.'; return; }
      if (!window.mqtt) { errEl.textContent = 'Chat needs an internet connection.'; return; }
      if ((await sha('bioglow-chat-pass:' + pass)) !== CHAT_PASS) { errEl.textContent = 'That code isn\'t right.'; passEl.select(); return; }
      lock.hidden = true; roomEl.hidden = false;
      (nameEl.value ? textEl : nameEl).focus();
      enter(pass);
    };
    q('.chat-form').onsubmit = (e) => {
      e.preventDefault();
      const text = textEl.value.trim();
      if (!text) return;
      textEl.value = '';
      send(text);
    };
    q('[data-c=leave]').onclick = () => { close(); passEl.focus(); };
    return { show() { (lock.hidden ? textEl : passEl).focus(); } };
  }

  window.BioGlowSync = { attach };

  // The chat starts by itself, so the Chat tab works even when Sync or the block editor doesn't.
  setUpChat({
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } },
  });

  // attach() replaces this. If it never runs (the browser kept an out-of-date copy of the other
  // scripts, or the block editor didn't load), say why instead of doing nothing.
  const btn = document.getElementById('sync');
  if (btn) btn.onclick = () => alert(window.Blockly
    ? 'Sync didn\'t start because part of this page is out of date. Reload it with Ctrl+Shift+R (Cmd+Shift+R on a Mac).'
    : 'Sync needs the block editor, which didn\'t load. Check the internet connection, or turn off ad or script blockers for this site, then reload.');
})();
