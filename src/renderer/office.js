'use strict';
// Pixel office: a canvas floor where every agent is a small character.
// Behaviour is driven by real agent status (nothing is simulated):
//   starting -> walks in through the door      working -> sits at its desk, typing
//   idle     -> wanders (cooler, coffee, couch, printer, a colleague's desk)
//   waiting  -> walks into your office and asks (permission card, bottom-left)
// Rooms: your office, the orchestrator's office and one room per team (a lead and everyone under them).
//   stopped  -> walks out through the door     exited/error -> slumped at its desk
// All art is drawn with rectangles, so there are no image assets.
(function () {
  const MIN_H = 216, TOP = 34, LEFT = 8, CELL_W = 58, CELL_H = 58, BREAK_W = 74, SPEED = 38, HEAD = 26, HALL = 18, GAP = 4, PAD = 3; // HEAD leaves room for the name above the first row's speech bubbles
  let CORR_X = 0, W = 0; // corridor x and world width follow the window
  // Rooms: your office, the orchestrator's office, then one room per team (a lead and everyone under them).
  const TEAM_LABEL = { product: 'Product & Design', architect: 'Engineering', security: 'Security (SOC)', deploy: 'Deployment', researchlead: 'Research Dept' };
  const TEAM_ORDER = ['product', 'architect', 'security', 'deploy', 'researchlead'];
  const ROOM_COLORS = ['#f6c445', '#6ea8fe', '#7bd88f', '#ef8a62', '#b190ff', '#5fd3e8', '#f07ab8'];
  const SPOTS = [
    { k: 'cooler', x: 272, y: 52, emote: '\u{1F4A7}' },
    { k: 'coffee', x: 300, y: 52, emote: '☕' },
    { k: 'couch', x: 284, y: 130, emote: '\u{1F4AC}' },
    { k: 'printer', x: 290, y: 176, emote: '\u{1F4C4}' },
  ];
  const SKIN = ['#f1c9a5', '#e0a97e', '#c68863', '#8d5a3b', '#f6d7b9'];
  const HAIR = ['#2b2118', '#5a3825', '#a5672a', '#d9b45b', '#c44536', '#7a7f8c', '#1d1d28'];
  const PANTS = ['#2b3040', '#3a3f55', '#4a3b36', '#303a33'];
  const STATUS_COLOR = { working: '#2fa84f', idle: '#3b82f6', waiting: '#f2a900', starting: '#a855f7', exited: '#e5484d', error: '#e5484d', stopped: '#9a9a9f' };
  const STATUS_LABEL = { working: 'Working', idle: 'Idle', waiting: 'Needs you', starting: 'Starting', exited: 'Exited', stopped: 'Stopped', error: 'Error' };

  const hash = (s) => { let h = 7; for (const ch of String(s)) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return h; };
  const rand = (a, b) => a + Math.random() * (b - a);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const shade = (hex, k) => {
    const n = parseInt(String(hex).slice(1), 16) || 0x888888;
    const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
    return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
  };

  let box, scroller, cv, g, bgCv, tip, asksEl;
  let dpr = 1, cssW = 0, cssH = 0, S = 2, offX = 0, offY = 0, H = MIN_H;
  let graph = null, L = { rooms: [], bands: [], pos: [], sig: '' }, agents = [], handlers = {}, humanAsks = 0;
  const chars = new Map();
  const letters = [];
  const lockedUntil = new Map();
  let active = false, raf = 0, last = 0, asksKey = '';

  // ---------- layout + walking graph ----------
  // Slot 0 is you; slot i is agents[i - 1]. A room is a lead plus everyone under them (the team).
  function planRooms(list) {
    const byId = new Map(list.map((a) => [a.id, a]));
    const god = list.find((a) => a.isGod);
    const topOf = (a) => { // climb to the first manager below the orchestrator
      let cur = a;
      for (let n = 0; n < 20; n++) {
        const m = byId.get(cur.reportsTo);
        if (cur.isGod || !m || m.id === cur.id || m.isGod) return cur;
        cur = m;
      }
      return cur;
    };
    const teams = new Map(), secretSlots = [];
    list.forEach((a, i) => {
      if (a.isGod) return;
      if (a.secret) { secretSlots.push(i + 1); return; } // the secret office is its own locked room
      const t = topOf(a);
      if (!teams.has(t.id)) teams.set(t.id, []);
      teams.get(t.id).push(i + 1);
    });
    const rooms = [{ key: 'you', name: 'Your office', slots: [0], human: true }];
    if (god) rooms.push({ key: 'command', name: `${god.name}'s office`, slots: [list.indexOf(god) + 1] });
    const named = [], loose = [];
    for (const [tid, slots] of teams) {
      const t = byId.get(tid);
      slots.sort((x, y) => (list[y - 1].id === tid) - (list[x - 1].id === tid)); // the lead sits first
      if (t.lead || t.presetId || slots.length > 1) named.push({ key: `t_${tid}`, name: TEAM_LABEL[t.presetId] || `${t.name}'s team`, slots, order: TEAM_ORDER.indexOf(t.presetId) });
      else loose.push(...slots);
    }
    named.sort((a, b) => (a.order < 0 ? 99 : a.order) - (b.order < 0 ? 99 : b.order));
    rooms.push(...named);
    if (loose.length) rooms.push({ key: 'general', name: 'General', slots: loose });
    if (secretSlots.length) rooms.push({ key: 'secret', name: 'Secret office', slots: secretSlots, secret: true });
    rooms.forEach((r, i) => { r.idx = i; r.color = r.secret ? '#4b3f6b' : ROOM_COLORS[i % ROOM_COLORS.length]; });
    return rooms;
  }

  // Rooms flow left to right in bands; each band has a hallway below its rooms that leads to the corridor.
  function layout(rooms, ww) {
    const corr = ww - BREAK_W, avail = corr - LEFT - 8;
    const maxC = Math.max(2, Math.floor((avail - 2 * PAD) / CELL_W));
    for (const r of rooms) {
      const n = r.slots.length;
      r.cols = Math.max(1, Math.min(r.human ? 2 : n <= 3 ? n : n <= 6 ? 3 : 5, maxC));
      r.rows = Math.ceil(n / r.cols);
      r.w = r.cols * CELL_W + 2 * PAD; r.h = HEAD + r.rows * CELL_H + 4;
    }
    const bands = [];
    for (const r of rooms) { // first fit: the first band with space, so small rooms fill gaps
      let b = bands.find((x) => x.w + GAP + r.w <= avail);
      if (!b) { b = { rooms: [], w: 0 }; bands.push(b); }
      r.x = LEFT + b.w + (b.rooms.length ? GAP : 0);
      b.w += (b.rooms.length ? GAP : 0) + r.w;
      b.rooms.push(r);
    }
    let y = TOP, ok = true;
    const pos = [];
    for (const b of bands) {
      b.h = Math.max(...b.rooms.map((r) => r.h)); b.y = y; b.hall = y + b.h + HALL / 2;
      if (b.w > avail) ok = false;
      for (const r of b.rooms) {
        r.y = y; r.h = b.h; r.band = b;
        r.slots.forEach((slot, k) => { pos[slot] = { cx: r.x + PAD + (k % r.cols) * CELL_W + CELL_W / 2, top: y + HEAD + Math.floor(k / r.cols) * CELL_H, room: r }; });
      }
      y += b.h + HALL;
    }
    return { rooms, bands, pos, corr, ww, H: Math.max(MIN_H, y + 4), ok };
  }

  const slotXY = (i) => L.pos[i] || null;

  const bx = (x) => x + CORR_X - 246; // break-area art is authored for a 246px corridor

  function buildGraph() {
    CORR_X = L.corr; W = L.ww; H = L.H;
    const nodes = {}, adj = {};
    const node = (k, x, y) => { nodes[k] = { x, y }; adj[k] = adj[k] || new Set(); };
    const link = (a, b) => { adj[a].add(b); adj[b].add(a); };
    const ys = new Set([30]);
    for (const r of L.rooms) {
      const gk = (c, row) => `g${r.idx}_${c}_${row}`;
      for (let row = 0; row < r.rows; row++) {
        const ay = r.y + HEAD + row * CELL_H + 46;
        for (let c = 0; c <= r.cols; c++) node(gk(c, row), r.x + PAD + c * CELL_W, ay);
        if (row) link(gk(0, row - 1), gk(0, row));
        for (let c = 0; c < r.cols; c++) if (row * r.cols + c >= r.slots.length) link(gk(c, row), gk(c + 1, row)); // empty desk cell
      }
      r.slots.forEach((slot, k) => {
        const col = k % r.cols, row = Math.floor(k / r.cols), { cx, top } = L.pos[slot];
        node(`f${slot}`, cx, top + 46); link(gk(col, row), `f${slot}`); link(`f${slot}`, gk(col + 1, row));
        node(`s${slot}`, cx, top + 28); node(`o${slot}`, cx + CELL_W / 2, top + 28);
        link(`s${slot}`, `o${slot}`); link(`o${slot}`, gk(col + 1, row));
      });
      node(`rd${r.idx}`, r.x + PAD, r.band.hall); link(gk(0, r.rows - 1), `rd${r.idx}`); // the room's door onto the hallway
    }
    for (const b of L.bands) {
      ys.add(b.hall);
      for (let i = 1; i < b.rooms.length; i++) link(`rd${b.rooms[i - 1].idx}`, `rd${b.rooms[i].idx}`);
    }
    SPOTS.forEach((s) => ys.add(s.y));
    const sorted = [...ys].sort((a, b) => a - b);
    sorted.forEach((y) => node(`c${y}`, CORR_X, y));
    for (let i = 1; i < sorted.length; i++) link(`c${sorted[i - 1]}`, `c${sorted[i]}`);
    for (const b of L.bands) link(`rd${b.rooms[b.rooms.length - 1].idx}`, `c${b.hall}`);
    SPOTS.forEach((s) => {
      node(`p_${s.k}_a`, bx(s.x) - 7, s.y); node(`p_${s.k}_b`, bx(s.x) + 7, s.y);
      link(`c${s.y}`, `p_${s.k}_a`); link(`p_${s.k}_a`, `p_${s.k}_b`);
    });
    graph = { nodes, adj };
    bgCv = null;
  }

  function bfs(a, b) {
    if (a === b) return [a];
    const prev = new Map([[a, null]]);
    const q = [a];
    while (q.length) {
      const k = q.shift();
      for (const n of graph.adj[k]) {
        if (prev.has(n)) continue;
        prev.set(n, k);
        if (n === b) { const p = [n]; let c = k; while (c) { p.unshift(c); c = prev.get(c); } return p; }
        q.push(n);
      }
    }
    return null;
  }

  // ---------- characters ----------
  function makeChar(a, slot) {
    const h = hash(a.id);
    return {
      id: a.id, slot, x: 0, y: 0, node: '', to: '', path: [], moving: false, sit: false, dir: 1, anim: rand(0, 5), dwell: rand(3, 8),
      mode: 'idle', target: '', emote: '', gone: false, ghost: false, typing: false, color: '#6ea8fe',
      skin: SKIN[h % SKIN.length], hair: HAIR[(h >> 3) % HAIR.length], hairStyle: (h >> 6) % 5, pants: PANTS[(h >> 9) % PANTS.length],
    };
  }

  function place(c, key) {
    const n = graph.nodes[key];
    c.x = n.x; c.y = n.y; c.node = key; c.to = ''; c.path = []; c.moving = false; c.target = key;
    arrive(c);
  }

  function goto(c, key) {
    if (!graph.nodes[key]) return;
    const base = c.moving ? c.to : c.node;
    const p = graph.nodes[base] ? bfs(base, key) : null;
    if (!p) { place(c, key); return; }
    c.target = key;
    c.path = p.slice(1);
    if (!c.moving) {
      if (c.path.length) { c.to = c.path.shift(); c.moving = true; c.sit = false; c.emote = ''; } else arrive(c);
    }
  }

  function arrive(c) {
    c.sit = c.node === `s${c.slot}` && c.mode !== 'leave';
    c.dwell = rand(5, 11);
    const spot = SPOTS.find((s) => c.node.startsWith(`p_${s.k}_`));
    c.emote = spot ? spot.emote : '';
    if (c.mode === 'leave' && c.node === 'c30') c.gone = true;
  }

  const targeted = (key, except) => [...chars.values()].some((o) => o !== except && (o.moving ? o.target : o.node) === key);
  function freeSpot(c, spot) {
    const a = `p_${spot.k}_a`, b = `p_${spot.k}_b`;
    return targeted(a, c) && !targeted(b, c) ? b : a;
  }

  function askSpot(c) {
    // Walk into your office and stand beside your desk (aisle gaps), never on top of a name label.
    for (const k of ['g0_1_0', 'g0_0_0', 'g0_2_0']) if (graph.nodes[k] && !targeted(k, c)) return k;
    return 'g0_1_0';
  }

  function retarget(c, a) {
    c.ghost = a.status === 'exited' || a.status === 'error';
    c.typing = a.status === 'working';
    switch (a.status) {
      case 'working': case 'starting': case 'exited': case 'error':
        c.mode = 'desk'; goto(c, `s${c.slot}`); break;
      case 'waiting':
        c.mode = 'ask'; goto(c, askSpot(c)); break;
      case 'stopped':
        c.mode = 'leave'; goto(c, 'c30'); break;
      default: // idle
        c.mode = 'idle'; c.dwell = rand(2, 6);
        if (!c.moving && c.node === `o${c.slot}`) goto(c, `s${c.slot}`);
    }
  }

  function wander(c) {
    const seat = `s${c.slot}`, picks = [];
    if (c.node !== seat) picks.push(seat, seat);
    SPOTS.forEach((s) => picks.push(freeSpot(c, s)));
    for (const o of chars.values()) {
      const same = L.pos[o.slot] && L.pos[c.slot] && L.pos[o.slot].room.idx === L.pos[c.slot].room.idx; // visit teammates, not other rooms
      if (o !== c && !o.human && o.mode !== 'leave' && o.slot !== c.slot && same && !targeted(`f${o.slot}`, c)) picks.push(`f${o.slot}`);
    }
    const choices = picks.filter((k) => k !== c.node && graph.nodes[k]);
    if (choices.length) goto(c, choices[Math.floor(Math.random() * choices.length)]);
    else c.dwell = rand(4, 9);
  }

  // ---------- sync with the app ----------
  function sync(list, extra = {}) {
    agents = list;
    humanAsks = extra.asks || 0;
    relayout();

    const seen = new Set(['human']);
    let hc = chars.get('human');
    if (!hc) {
      hc = makeChar({ id: 'human' }, 0);
      hc.mode = 'human'; hc.human = true; hc.color = '#f5f5f7'; hc.skin = SKIN[4]; hc.hair = HAIR[1]; hc.hairStyle = 0;
      chars.set('human', hc); place(hc, 's0');
    }

    list.forEach((a, idx) => {
      const slot = idx + 1;
      seen.add(a.id);
      let c = chars.get(a.id);
      const fresh = !c;
      if (fresh) { c = makeChar(a, slot); chars.set(a.id, c); }
      const changed = fresh || c.slot !== slot || c.status !== a.status || c.gone;
      c.slot = slot; c.color = a.color || '#6ea8fe'; c.god = !!a.isGod; c.status = a.status; c.a = a; c.gone = false;
      if (fresh) {
        place(c, a.status === 'starting' ? 'c30' : `s${slot}`);
        c.mode = 'desk';
      }
      if (changed) retarget(c, a);
    });
    for (const id of [...chars.keys()]) if (!seen.has(id)) chars.delete(id);
    renderAsks();
    if (!active) draw();
  }

  // ---------- permission cards ----------
  function renderAsks() {
    const waiting = agents.filter((a) => a.status === 'waiting');
    const key = waiting.map((a) => `${a.id}|${a.ask || ''}|${lockedUntil.get(a.id) > Date.now() ? 1 : 0}`).join('~');
    if (key === asksKey) return;
    asksKey = key;
    asksEl.innerHTML = waiting.map((a) => {
      const locked = lockedUntil.get(a.id) > Date.now();
      return `<div class="ask-card" data-id="${esc(a.id)}" style="--c:${esc(a.color || '#ffd60a')}">
        <div class="ac-head"><b>${esc(a.name)}</b> <span>needs you</span></div>
        <div class="ac-msg">${a.ask ? esc(a.ask) : 'Waiting on a menu in its terminal (folder trust, update or confirmation).'}</div>
        <div class="ac-actions">
          ${a.ask ? `<button class="primary" data-act="allow" ${locked ? 'disabled' : ''}>Allow</button><button data-act="deny" ${locked ? 'disabled' : ''}>Deny</button>` : ''}
          <button data-act="open">Open terminal</button>
        </div></div>`;
    }).join('');
  }

  function envelope(from, to) {
    const a = chars.get(from), b = chars.get(to);
    if (!a || !b) return;
    letters.push({ a, b, t: 0 });
  }

  // ---------- update ----------
  function update(dt) {
    for (const c of chars.values()) {
      c.anim += dt;
      if (c.moving) {
        const t = graph.nodes[c.to];
        if (!t) { place(c, `s${c.slot}`); continue; }
        const dx = t.x - c.x, dy = t.y - c.y, d = Math.hypot(dx, dy), step = SPEED * dt;
        c.sit = false;
        if (d <= step) {
          c.x = t.x; c.y = t.y; c.node = c.to;
          if (c.path.length) c.to = c.path.shift(); else { c.moving = false; arrive(c); }
        } else {
          c.x += (dx / d) * step; c.y += (dy / d) * step;
          if (Math.abs(dx) > 0.3) c.dir = dx > 0 ? 1 : -1;
        }
      } else if (c.mode === 'idle') {
        c.dwell -= dt;
        if (c.dwell <= 0) wander(c);
      } else if (c.mode === 'ask') {
        c.dir = slotXY(0) && c.x > slotXY(0).cx ? -1 : 1;
      }
    }
    for (const [id, c] of [...chars]) if (c.gone) chars.delete(id);
    for (let i = letters.length - 1; i >= 0; i--) { letters[i].t += dt / 0.9; if (letters[i].t >= 1) letters.splice(i, 1); }
  }

  // ---------- drawing ----------
  const f = (col, x, y, w, h) => { g.fillStyle = col; g.fillRect(x, y, w, h); };

  // Light, warm palette: speckled beige tile floor, pale wall, dark outlines on everything.
  const OUT = '#3a2f26';

  function drawBackground() {
    const b = bgCv.getContext('2d');
    b.imageSmoothingEnabled = false;
    const fb = (col, x, y, w, h) => { b.fillStyle = col; b.fillRect(x, y, w, h); };
    const box2 = (x, y, w, h, fill, line = OUT) => { fb(line, x, y, w, h); fb(fill, x + 1, y + 1, w - 2, h - 2); };
    // floor: beige tiles with speckles
    fb('#dfd3ba', 0, 0, W, H);
    for (let y = 28; y < H; y += 16) for (let x = 0; x < W; x += 16) if (((x + y) / 16) % 2 === 0) fb('#e6dbc4', x, y, 16, 16);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < W * H / 40; i++) { const x = Math.floor(rnd() * W), y = 29 + Math.floor(rnd() * (H - 29)); fb(rnd() < 0.5 ? '#cbbd9f' : '#efe6d2', x, y, 1, 1); }
    fb('#cdbf9f', CORR_X + 5, 28, 1, H - 28);
    // wall
    fb('#f4ecdc', 0, 0, W, 28);
    fb('#e4d8bf', 0, 20, W, 8);
    fb('#a8957a', 0, 26, W, 2);
    fb('#7b6a53', 0, 28, W, 1);
    // windows with sky and clouds
    for (let i = 0, n = Math.max(2, Math.floor((CORR_X - 50) / 52)); i < n; i++) {
      const x = 14 + i * 52;
      box2(x - 1, 3, 38, 21, '#9bd3f2', '#4b6b82');
      fb('#bfe5f9', x + 1, 5, 34, 7);
      fb('#ffffff', x + 6 + (i % 3) * 5, 8, 8, 2); fb('#ffffff', x + 9 + (i % 3) * 5, 7, 5, 1);
      fb('#4b6b82', x + 17, 4, 2, 19); fb('#4b6b82', x, 13, 36, 1);
    }
    // whiteboard
    const wbx = CORR_X - 44;
    box2(wbx, 4, 32, 19, '#fbfbf8', '#7b8794');
    for (let i = 0; i < 4; i++) fb(['#e5589b', '#3b82f6', '#2fa84f', '#3b82f6'][i], wbx + 3, 7 + i * 3, 8 + ((i * 7) % 16), 1);
    fb('#f6c445', wbx + 22, 13, 6, 6);
    // door
    box2(CORR_X - 9, 6, 18, 22, '#c89a68', '#6b4a2c'); fb('#a97d4d', CORR_X - 6, 9, 12, 19); fb('#f2c14e', CORR_X + 4, 19, 2, 2);
    // break area (authored for a 246px corridor, shifted to wherever the corridor is)
    b.save(); b.translate(CORR_X - 246, 0);
    // clock + framed posters
    box2(262, 5, 13, 13, '#ffffff', '#4a4a50'); fb('#2a2c3c', 268, 7, 1, 5); fb('#2a2c3c', 268, 11, 4, 1);
    box2(284, 4, 14, 17, '#fff7e0', '#4a4a50'); fb('#e5589b', 287, 7, 8, 5); fb('#f6c445', 287, 13, 8, 2);
    // water cooler
    box2(257, 33, 12, 14, '#eef1f6', '#7b8794'); fb('#8ad0f5', 259, 21, 8, 12); fb('#c9ecfc', 260, 22, 2, 8); fb('#3b82f6', 261, 38, 4, 2);
    // coffee counter with machine
    box2(274, 33, 38, 13, '#f1ebe0', '#7b6a53'); fb('#d9cfbd', 276, 41, 34, 1);
    box2(279, 24, 9, 10, '#33363f', '#1d1f26'); fb('#e5484d', 282, 27, 2, 2); fb('#ffffff', 296, 29, 4, 4); fb('#6b4a35', 297, 30, 2, 1);
    // arcade cabinet
    box2(255, 62, 13, 22, '#2d2a55', '#1c1a38'); fb('#7cf2c9', 257, 65, 9, 7); fb('#ff5c8a', 258, 66, 3, 2); fb('#f6c445', 262, 69, 2, 2); fb('#e5484d', 258, 76, 2, 2); fb('#3b82f6', 262, 76, 2, 2);
    // file cabinets
    box2(298, 60, 14, 24, '#aeb4bf', '#5b6270'); fb('#5b6270', 298, 67, 14, 1); fb('#5b6270', 298, 75, 14, 1); fb('#eef1f6', 303, 63, 4, 1); fb('#eef1f6', 303, 71, 4, 1); fb('#eef1f6', 303, 79, 4, 1);
    // yellow rug, pink poufs, blue sofa
    box2(258, 94, 56, 40, '#f6c445', '#b98a1c');
    for (let x = 261; x < 311; x += 4) fb('#eeb52a', x, 97, 2, 34);
    box2(266, 105, 14, 9, '#ee6aa7', '#a8345f'); fb('#f7a0c9', 268, 106, 8, 2);
    box2(292, 105, 14, 9, '#ee6aa7', '#a8345f'); fb('#f7a0c9', 294, 106, 8, 2);
    box2(262, 137, 48, 13, '#4aa3df', '#245f8c'); fb('#7cc4f0', 264, 139, 44, 3); fb('#245f8c', 285, 140, 1, 9);
    // printer
    box2(276, 156, 24, 11, '#eef1f6', '#7b8794'); fb('#ffffff', 280, 152, 14, 5); fb('#3b82f6', 294, 160, 3, 2); fb('#aab2c0', 276, 164, 24, 3);
    // plants
    const plant = (x, y) => { box2(x, y + 10, 9, 8, '#b5683a', '#6b3a1c'); fb('#2f9e5b', x - 3, y + 3, 15, 8); fb('#46c47a', x, y - 2, 9, 8); fb('#2f9e5b', x + 2, y - 5, 5, 5); };
    plant(306, 28); plant(256, H - 24);
    // bookshelf
    if (H > 200) {
      box2(268, H - 28, 40, 20, '#9a6a3a', '#5c3d22');
      const A = ['#e5484d', '#3b82f6', '#f6c445', '#2fa84f', '#a855f7', '#f08a4b'];
      for (let i = 0; i < 6; i++) { fb(A[i], 271 + i * 6, H - 26, 4, 7); fb(A[(i + 3) % 6], 271 + i * 6, H - 17, 4, 7); }
    }
    b.restore();
    // rooms: tinted floor, walls, a header band for the name, and a doorway onto the hallway
    for (const bnd of L.bands) fb('#d9ccb0', 4, bnd.y + bnd.h + 3, CORR_X + 2, HALL - 6);
    for (const r of L.rooms) {
      box2(r.x, r.y, r.w, r.h, r.secret ? '#d9d2e6' : '#ebe1cb', r.secret ? '#2e2a40' : '#6b5a45');
      b.globalAlpha = r.secret ? 0.3 : 0.18; fb(r.color, r.x + 1, r.y + HEAD, r.w - 2, r.h - HEAD - 1);
      b.globalAlpha = 1; fb(r.secret ? '#4b3f6b' : '#fbf3df', r.x + 1, r.y + 1, r.w - 2, HEAD - 2);
      b.globalAlpha = r.secret ? 0 : 0.45; fb(r.color, r.x + 1, r.y + 1, r.w - 2, HEAD - 2);
      b.globalAlpha = 1; fb(r.secret ? '#2e2a40' : '#6b5a45', r.x + 1, r.y + HEAD - 1, r.w - 2, 1);
      if (r.secret) { fb('#f6c445', r.x + r.w - 15, r.y + 8, 8, 6); fb('#2e2a40', r.x + r.w - 13, r.y + 4, 4, 5); fb('#4b3f6b', r.x + r.w - 12, r.y + 6, 2, 3); } // a padlock on the sign
      fb('#ebe1cb', r.x + 1, r.y + r.h - 1, 10, 1); fb('#6b5a45', r.x + 11, r.y + r.h - 2, 1, 2); // doorway above the hallway
    }
    // your office: bookshelf, sofa and a plant beside your desk
    const you = L.rooms[0], cx1 = you.x + PAD + CELL_W, t1 = you.y + HEAD;
    box2(cx1 + 4, t1 + 3, 40, 20, '#9a6a3a', '#5c3d22');
    const BK = ['#e5484d', '#3b82f6', '#f6c445', '#2fa84f', '#a855f7', '#f08a4b'];
    for (let i = 0; i < 6; i++) { fb(BK[i], cx1 + 7 + i * 6, t1 + 5, 4, 7); fb(BK[(i + 3) % 6], cx1 + 7 + i * 6, t1 + 14, 4, 7); }
    box2(cx1 + 4, t1 + 36, 34, 13, '#4aa3df', '#245f8c'); fb('#7cc4f0', cx1 + 6, t1 + 38, 30, 3);
    plant(cx1 + 46, t1 + 34);
  }

  function chairAndDesk(i, phase) {
    const p = slotXY(i);
    if (!p) return;
    const { cx, top } = p;
    if (phase === 'chair') {
      f(OUT, cx - 8, top + 13, 16, 15); f('#59606e', cx - 7, top + 14, 14, 13); f('#7a8294', cx - 7, top + 14, 14, 2);
      return;
    }
    const a = i === 0 ? null : agents[i - 1];
    const h = hash(i * 977 + 13);
    // desk top (with outline), front panel and legs
    f(OUT, cx - 22, top + 21, 44, 19);
    f('#d9a46a', cx - 21, top + 22, 42, 10); f('#e8bb85', cx - 21, top + 22, 42, 1);
    f('#b07a45', cx - 21, top + 32, 42, 7); f('#8f5f32', cx - 18, top + 34, 14, 1); f('#8f5f32', cx + 4, top + 34, 14, 1);
    // monitor, back facing the viewer, with a status LED
    f(OUT, cx - 8, top + 17, 16, 9); f('#3b4150', cx - 7, top + 18, 14, 6); f('#5a6275', cx - 7, top + 18, 14, 1);
    f(OUT, cx - 2, top + 25, 4, 2); f('#8a92a3', cx - 1, top + 25, 2, 1);
    f(a && a.status === 'working' ? '#4ade80' : a && a.status === 'waiting' ? '#f6c445' : '#8a92a3', cx + 4, top + 22, 2, 1);
    if (a && a.status === 'working') f('rgba(120,180,255,0.35)', cx - 9, top + 27, 18, 3);
    // desk clutter, different per slot
    f('#ffffff', cx - 19, top + 25, 7, 5); f('#c5ccd8', cx - 18, top + 26, 5, 1);
    if (h % 3 === 0) { f('#f6c445', cx + 12, top + 24, 4, 4); f('#e5589b', cx + 15, top + 26, 3, 3); }
    else if (h % 3 === 1) { f('#ffffff', cx + 12, top + 24, 5, 5); f('#6b4a35', cx + 13, top + 25, 3, 1); }
    else { f('#2f9e5b', cx + 12, top + 21, 6, 6); f('#b5683a', cx + 13, top + 27, 4, 3); }
    if (h % 2 === 0) { f('#f6c445', cx + 9, top + 14, 5, 2); f('#f6c445', cx + 11, top + 16, 1, 7); }
    if (i === 0) f('#f6c445', cx - 6, top + 34, 12, 3);
    if (a) f(STATUS_COLOR[a.status] || '#9a9a9f', cx - 21, top + 39, 42, 1);
  }

  function drawChar(c) {
    const x = Math.round(c.x), y = Math.round(c.y);
    const walking = c.moving, ph = Math.floor(c.anim * 9) % 4;
    const bob = walking && ph % 2 === 1 ? 1 : 0;
    const ghost = c.ghost;
    g.globalAlpha = ghost ? 0.55 : 1;
    if (!c.sit) {
      f('rgba(60,40,20,0.22)', x - 6, y - 1, 12, 3);
      const lh = walking && ph === 1 ? 4 : 6, rh = walking && ph === 3 ? 4 : 6;
      f(OUT, x - 5, y - lh - 1, 5, lh + 1); f(OUT, x, y - rh - 1, 5, rh + 1);
      f(c.pants, x - 4, y - lh, 3, lh - 1); f(c.pants, x + 1, y - rh, 3, rh - 1);
      f('#1f1b17', x - 4, y - 1, 3, 1); f('#1f1b17', x + 1, y - 1, 3, 1);
    }
    const col = ghost ? '#9a9aa2' : c.color;
    // torso and arms, outlined
    f(OUT, x - 6, y - 14 + bob, 12, 10);
    f(col, x - 5, y - 13 + bob, 10, 8); f(shade(col, 0.8), x - 5, y - 6 + bob, 10, 1);
    f('#ffffff', x - 1, y - 13 + bob, 2, 3);
    if (c.god) { f('#e5484d', x, y - 11 + bob, 1, 5); f('#e5484d', x - 1, y - 12 + bob, 2, 1); }
    if (c.sit && c.typing) {
      const k = Math.floor(c.anim * 10) % 2;
      f(OUT, x - 8, y - 12, 3, 6); f(OUT, x + 5, y - 12, 3, 6);
      f(col, x - 7, y - 12, 2, 5); f(col, x + 5, y - 12, 2, 5);
      f(c.skin, x - 6, y - 8 + (k ? 0 : -1), 2, 2); f(c.skin, x + 4, y - 8 + (k ? -1 : 0), 2, 2);
    } else {
      const sw = walking ? (ph === 1 ? 1 : ph === 3 ? -1 : 0) : 0;
      f(OUT, x - 8, y - 13 + bob + sw, 3, 9); f(OUT, x + 5, y - 13 + bob - sw, 3, 9);
      f(col, x - 7, y - 12 + bob + sw, 2, 6); f(col, x + 5, y - 12 + bob - sw, 2, 6);
      f(c.skin, x - 7, y - 6 + bob + sw, 2, 2); f(c.skin, x + 5, y - 6 + bob - sw, 2, 2);
    }
    // head
    f(OUT, x - 5, y - 22 + bob, 10, 10);
    f(c.skin, x - 4, y - 20 + bob, 8, 7);
    const hh = c.hair;
    if (c.hairStyle === 0) { f(hh, x - 4, y - 21 + bob, 8, 3); f(hh, x - 4, y - 18 + bob, 1, 2); f(hh, x + 3, y - 18 + bob, 1, 2); }
    if (c.hairStyle === 1) { f(OUT, x - 6, y - 22 + bob, 12, 3); f(hh, x - 5, y - 21 + bob, 10, 3); f(hh, x - 5, y - 18 + bob, 2, 8); f(hh, x + 3, y - 18 + bob, 2, 8); }
    if (c.hairStyle === 2) { f(hh, x - 4, y - 21 + bob, 8, 3); f(OUT, x - 3, y - 24 + bob, 5, 3); f(hh, x - 2, y - 23 + bob, 3, 2); f(hh, x - 4, y - 18 + bob, 1, 1); f(hh, x + 3, y - 18 + bob, 1, 1); }
    if (c.hairStyle === 3) { f(hh, x - 4, y - 21 + bob, 8, 2); f(hh, x - 4, y - 19 + bob, 1, 2); f(hh, x + 3, y - 19 + bob, 1, 2); f(c.skin, x - 2, y - 21 + bob, 4, 1); }
    if (c.hairStyle === 4) { f(OUT, x - 4, y - 23 + bob, 8, 3); f(hh, x - 3, y - 22 + bob, 6, 3); f(hh, x - 4, y - 19 + bob, 1, 3); f(hh, x + 3, y - 19 + bob, 1, 3); }
    const blink = Math.floor((c.anim + (hash(c.id) % 7)) * 10) % 40 === 0;
    const ex = c.dir > 0 ? 1 : 0;
    if (ghost || blink) { f('#1b1b22', x - 3 + ex, y - 16 + bob, 2, 1); f('#1b1b22', x + ex, y - 16 + bob, 2, 1); }
    else { f('#1b1b22', x - 3 + ex, y - 17 + bob, 1, 2); f('#1b1b22', x + 1 + ex, y - 17 + bob, 1, 2); }
    f('#b5654a', x - 1 + ex, y - 14 + bob, 2, 1);
    if (c.sit && c.typing) f('rgba(140,190,255,0.20)', x - 4, y - 20 + bob, 8, 7);
    g.globalAlpha = 1;
  }

  function drawLabels() {
    // Text is drawn in device pixels (not art pixels) so it stays crisp.
    g.setTransform(1, 0, 0, 1, 0, 0);
    const cssS = S / dpr, fp = Math.round(Math.max(10, Math.min(14, cssS * 3.8)) * dpr);
    const X = (wx) => offX + wx * S, Y = (wy) => offY + wy * S;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const r of L.rooms) { // room name on its header band
      g.font = `700 ${fp}px Inter, "Segoe UI", sans-serif`;
      let label = r.name;
      const maxW = r.w * S - 8 * dpr;
      while (label.length > 3 && g.measureText(label).width > maxW) label = label.slice(0, -2) + '…';
      g.fillStyle = r.secret ? '#ffffff' : '#3a2f26';
      g.fillText(label, X(r.x + r.w / 2 - (r.secret ? 4 : 0)), Y(r.y + 9) + dpr * 0.5);
    }
    const n = agents.length + 1;
    for (let i = 0; i < n; i++) {
      const p = slotXY(i);
      if (!p) continue;
      const { cx, top } = p;
      const a = i === 0 ? null : agents[i - 1];
      g.font = `600 ${fp}px Inter, "Segoe UI", sans-serif`;
      const label = (a && a.isGod ? '★ ' : '') + (a ? a.name : 'You');
      const tw = g.measureText(label).width, pw = tw + 22 * dpr, ph = fp + 7 * dpr, px = X(cx) - pw / 2, py = Y(top + 41.5) - ph / 2;
      g.fillStyle = 'rgba(255,255,255,0.94)'; g.strokeStyle = 'rgba(58,47,38,0.18)'; g.lineWidth = dpr;
      g.beginPath(); g.roundRect(px, py, pw, ph, ph / 2); g.fill(); g.stroke();
      g.fillStyle = a ? (STATUS_COLOR[a.status] || '#9a9a9f') : '#1d1d1f';
      g.beginPath(); g.arc(px + 9 * dpr, py + ph / 2, 3 * dpr, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1d1d1f';
      g.fillText(label, X(cx) + 5 * dpr, py + ph / 2 + dpr * 0.5);
    }
    const bubble = (wx, wy, text, fg, bg, bd, mono) => {
      g.font = `600 ${fp}px ${mono ? '"Cascadia Mono", Consolas, monospace' : 'Inter, "Segoe UI", sans-serif'}`;
      const w = g.measureText(text).width + 14 * dpr, h = fp + 9 * dpr, bx = X(wx) - w / 2, by = Y(wy) - h;
      g.fillStyle = bg; g.strokeStyle = bd; g.lineWidth = Math.max(1.5, 1.5 * dpr);
      g.beginPath(); g.roundRect(bx, by, w, h, 8 * dpr); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(X(wx) - 4 * dpr, by + h); g.lineTo(X(wx), by + h + 5 * dpr); g.lineTo(X(wx) + 4 * dpr, by + h); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = bg; g.fillRect(X(wx) - 3 * dpr, by + h - g.lineWidth, 6 * dpr, g.lineWidth * 2);
      g.fillStyle = fg; g.fillText(text, X(wx), by + h / 2 + dpr * 0.5);
    };
    for (const c of chars.values()) {
      if (c.moving) continue;
      const a = c.a;
      const hy = c.y - (c.sit ? 25 : 26);
      if (c.human) {
        if (humanAsks) bubble(c.x, hy, `${humanAsks} to answer`, '#1d1d1f', '#f6c445', '#1d1d1f');
        continue;
      }
      if (!a) continue;
      if (a.status === 'working') {
        const dots = '·'.repeat(1 + (Math.floor(c.anim * 3) % 3));
        bubble(c.x, hy, a.lastTool ? a.lastTool.slice(0, 16) : dots, '#1d1d1f', '#ffffff', '#1d1d1f', !!a.lastTool);
      } else if (a.status === 'waiting') {
        const pulse = 1 + 0.12 * Math.sin(c.anim * 6);
        g.fillStyle = '#f6c445'; g.strokeStyle = '#1d1d1f'; g.lineWidth = 1.5 * dpr;
        g.beginPath(); g.arc(X(c.x), Y(hy) - 8 * dpr, 9 * dpr * pulse, 0, Math.PI * 2); g.fill(); g.stroke();
        g.fillStyle = '#1d1d1f'; g.font = `800 ${Math.round(fp * 1.2)}px Inter, sans-serif`; g.fillText('!', X(c.x), Y(hy) - 8 * dpr + dpr * 0.5);
      } else if (a.status === 'starting') {
        bubble(c.x, hy, 'hello…', '#1d1d1f', '#ffffff', '#1d1d1f');
      } else if (a.status === 'error') {
        bubble(c.x, hy, 'error', '#c62828', '#ffffff', '#c62828');
      } else if (a.status === 'exited') {
        bubble(c.x, hy, 'zzz', '#6b6b73', '#ffffff', '#9a9aa2');
      } else if (c.emote) {
        g.font = `${Math.round(fp * 1.5)}px "Segoe UI Emoji", sans-serif`;
        g.fillText(c.emote, X(c.x), Y(hy) - 6 * dpr - 2 * Math.sin(c.anim * 3) * dpr);
      }
    }
    g.setTransform(S, 0, 0, S, offX, offY);
  }

  function draw() {
    if (!g || !graph) return;
    if (!bgCv) { bgCv = document.createElement('canvas'); bgCv.width = W; bgCv.height = H; drawBackground(); }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f5eedd'; g.fillRect(0, 0, cv.width, cv.height);
    g.imageSmoothingEnabled = false;
    g.drawImage(bgCv, offX, offY, W * S, H * S);
    g.setTransform(S, 0, 0, S, offX, offY);
    const slotCount = agents.length + 1;
    for (let i = 0; i < slotCount; i++) chairAndDesk(i, 'chair');
    const bySlot = new Map();
    for (const c of chars.values()) if (c.sit) bySlot.set(c.slot, c);
    for (let i = 0; i < slotCount; i++) { const c = bySlot.get(i); if (c) drawChar(c); chairAndDesk(i, 'desk'); }
    [...chars.values()].filter((c) => !c.sit).sort((a, b) => a.y - b.y).forEach(drawChar);
    for (const l of letters) {
      const t = l.t, x = Math.round(l.a.x + (l.b.x - l.a.x) * t), y = Math.round(l.a.y + (l.b.y - l.a.y) * t - 20 - Math.sin(t * Math.PI) * 16);
      f('#f2f4f8', x - 4, y - 3, 8, 6); f('#9aa0b8', x - 4, y - 3, 8, 1); f('#4da3ff', x - 1, y - 1, 2, 2);
    }
    drawLabels();
  }

  function loop(ts) {
    if (!active) return;
    const dt = Math.min(0.05, (ts - last) / 1000 || 0);
    last = ts;
    update(dt);
    draw();
    raf = requestAnimationFrame(loop);
  }

  function setActive(on) {
    if (on === active) return;
    active = on;
    cancelAnimationFrame(raf);
    if (on) {
      resize();
      for (let i = 0; i < 80 && [...chars.values()].some((c) => c.moving); i++) update(0.25); // catch up while hidden
      last = performance.now();
      raf = requestAnimationFrame(loop);
    }
  }

  // ---------- sizing + pointer ----------
  // Pick the biggest integer pixel scale at which the office fits, then use whatever
  // width is left over for extra desk columns (3 to 8).
  function relayout() {
    if (!box) return;
    dpr = window.devicePixelRatio || 1;
    const sw = scroller.clientWidth, sh = scroller.clientHeight; // visible area; the canvas may be taller and scroll
    if (sw >= 50 && sh >= 50) { cssW = sw; cssH = sh; }
    const cw = (cssW || 800) * dpr, ch = (cssH || 600) * dpr;
    const rooms = planRooms(agents);
    let chosen = 2; // biggest integer scale at which every room fits; 2 is the floor
    for (let s = Math.max(2, Math.floor(Math.min(cw / 262, ch / MIN_H))); s >= 2; s--) {
      const l = layout(rooms, Math.floor(cw / s));
      if (l.ok && l.H * s <= ch) { chosen = s; break; }
    }
    S = chosen;
    const next = layout(rooms, Math.floor(cw / S));
    const sig = `${S}|${next.ww}|${rooms.map((x) => `${x.key}:${x.name}:${x.slots}:${x.x},${x.y},${x.w},${x.h}`).join(';')}`;
    if (!graph || sig !== L.sig) {
      L = { ...next, sig };
      buildGraph();
      for (const c of chars.values()) { // positions belong to the old layout
        const key = c.moving ? c.target : c.node;
        place(c, graph.nodes[key] ? key : `s${c.slot}`);
      }
    }
    const pw = Math.round((cssW || 800) * dpr), ph = Math.max(Math.round((cssH || 600) * dpr), Math.ceil(H * S)); // taller than the view = scrolls
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; cv.style.width = `${cssW || 800}px`; cv.style.height = `${ph / dpr}px`; }
    offX = Math.max(0, Math.floor((cv.width - W * S) / 2)); offY = Math.max(0, Math.floor((cv.height - H * S) / 2));
  }

  function resize() {
    if (!box) return;
    relayout();
    draw();
  }

  function pick(ev) {
    const r = cv.getBoundingClientRect();
    const wx = ((ev.clientX - r.left) * dpr - offX) / S, wy = ((ev.clientY - r.top) * dpr - offY) / S;
    for (const c of [...chars.values()].sort((a, b) => b.y - a.y)) {
      if (Math.abs(wx - c.x) <= 7 && wy <= c.y + 1 && wy >= c.y - 25) return c.human ? 'human' : c.id;
    }
    const n = agents.length + 1;
    for (let i = 0; i < n; i++) {
      const p = slotXY(i);
      if (p && Math.abs(wx - p.cx) <= 22 && wy >= p.top + 12 && wy <= p.top + 44) return i === 0 ? 'human' : agents[i - 1].id;
    }
    return null;
  }

  function showTip(ev, id) {
    const a = id && id !== 'human' ? agents.find((x) => x.id === id) : null;
    if (!id || (id !== 'human' && !a)) { tip.classList.add('hidden'); return; }
    tip.innerHTML = id === 'human'
      ? `<b>You</b><div class="t-sub">Human in the loop${humanAsks ? ` · ${humanAsks} waiting for you` : ''}</div>`
      : `<div class="t-top"><b>${esc(a.name)}</b>${a.isGod ? ' <span class="star">★</span>' : ''}<span class="t-pill st-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span></div>
        <div class="t-bottom"><span class="t-role">${esc(a.role || '')}</span><span class="t-chip">${esc(a.provider)}${a.model ? ' · ' + esc(a.model) : ''}</span></div>
        ${a.lastTool ? `<div class="t-row mono">${esc(a.lastTool)}</div>` : ''}${a.unread ? `<div class="t-row">${a.unread} unread message(s)</div>` : ''}`;
    tip.classList.remove('hidden');
    const r = box.getBoundingClientRect();
    tip.style.left = `${Math.max(4, Math.min(ev.clientX - r.left + 14, r.width - 240))}px`;
    tip.style.top = `${Math.max(4, Math.min(ev.clientY - r.top + 14, r.height - 100))}px`;
  }

  function init(el, h) {
    box = el; handlers = h || {};
    box.innerHTML = '<div class="office-scroll"><canvas></canvas></div><div class="office-tip hidden"></div><div class="office-asks"></div>';
    scroller = box.querySelector('.office-scroll'); cv = box.querySelector('canvas'); tip = box.querySelector('.office-tip'); asksEl = box.querySelector('.office-asks');
    g = cv.getContext('2d');
    new ResizeObserver(resize).observe(box);
    cv.addEventListener('mousemove', (ev) => { const id = pick(ev); cv.style.cursor = id ? 'pointer' : 'default'; showTip(ev, id); });
    cv.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    cv.addEventListener('click', (ev) => { const id = pick(ev); if (id && handlers.onOpen) handlers.onOpen(id); });
    asksEl.addEventListener('click', (ev) => {
      const act = ev.target.dataset && ev.target.dataset.act;
      const card = ev.target.closest('.ask-card');
      if (!act || !card) return;
      const id = card.dataset.id;
      if (act === 'open') { if (handlers.onOpen) handlers.onOpen(id); return; }
      lockedUntil.set(id, Date.now() + 2500); // stop double-clicks answering twice
      if (act === 'allow' && handlers.onAllow) handlers.onAllow(id);
      if (act === 'deny' && handlers.onDeny) handlers.onDeny(id);
      asksKey = ''; renderAsks();
      setTimeout(() => { asksKey = ''; renderAsks(); }, 2600);
    });
  }

  window.Office = { init, sync, envelope, setActive, resize };
})();
