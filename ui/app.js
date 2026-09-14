// ai-memory display — front end for scripts/serve.ts.
// Every node on the canvas is a real conversation from the encrypted store.
// The terminal answers with full-text search hits from your own record, or
// says "no matches". Nothing here is simulated or generated.

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('neural-canvas');
  const ctx = canvas.getContext('2d');

  const statNodes = document.getElementById('stat-nodes');
  const statLatency = document.getElementById('stat-latency');
  const statTps = document.getElementById('stat-tps');
  const statStatus = document.getElementById('stat-status');
  const statHost = document.getElementById('stat-host');

  const inspBadge = document.getElementById('insp-badge');
  const inspTitle = document.getElementById('insp-title');
  const inspDesc = document.getElementById('insp-desc');
  const inspDim = document.getElementById('insp-dim');
  const inspWeight = document.getElementById('insp-weight');
  const inspCluster = document.getElementById('insp-cluster');
  const inspVector = document.getElementById('insp-vector');
  const memorySearch = document.getElementById('memory-search');
  const engineBadge = document.getElementById('engine-badge');

  const terminalOutput = document.getElementById('terminal-output');
  const thoughtBox = document.getElementById('thought-box');
  const thoughtContent = document.getElementById('thought-content');
  const promptForm = document.getElementById('prompt-form');
  const promptInput = document.getElementById('prompt-input');

  const btnVoiceToggle = document.getElementById('btn-voice-toggle');
  const btnRefreshMesh = document.getElementById('btn-refresh-mesh');
  const btnMic = document.getElementById('btn-mic');
  const modeBtns = document.querySelectorAll('.mode-btn');

  let voiceEnabled = false;
  let isRecording = false;
  let layoutMode = 'mesh';
  let selectedNode = null;
  let mouse = { x: null, y: null, isDown: false, draggedNode: null };
  let storeCounts = null;

  if (statHost) statHost.textContent = location.host;

  // ── canvas: one node per conversation ──────────────────────────────────

  const CLUSTERS = {
    ChatGPT: { idx: 0, color: '#00f3ff' },
    Claude:  { idx: 1, color: '#a855f7' },
    Gemini:  { idx: 2, color: '#10b981' },
  };
  const FALLBACK = { idx: 3, color: '#ec4899' };

  let nodes = [];
  let signals = [];

  function resizeCanvas() {
    const parent = canvas.parentElement;
    canvas.width = parent.clientWidth;
    canvas.height = parent.clientHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  function fmtDate(ms) {
    if (!ms) return '—';
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  }

  class Node {
    constructor(i, conv) {
      this.id = i + 1;
      this.conv = conv;
      const c = CLUSTERS[conv.cluster] || FALLBACK;
      this.clusterIdx = c.idx;
      this.color = c.color;
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.vx = (Math.random() - 0.5) * 0.8;
      this.vy = (Math.random() - 0.5) * 0.8;
      this.radius = 4 + Math.min(6, Math.log2(1 + (conv.message_count || 1)));
      this.hit = false;
    }
    update() {
      if (this === mouse.draggedNode) { this.x = mouse.x; this.y = mouse.y; return; }
      if (layoutMode === 'mesh') {
        this.x += this.vx; this.y += this.vy;
        if (this.x < 10 || this.x > canvas.width - 10) this.vx *= -1;
        if (this.y < 10 || this.y > canvas.height - 10) this.vy *= -1;
      } else if (layoutMode === 'cluster') {
        const targetX = (canvas.width / 5) * (this.clusterIdx + 1);
        const targetY = canvas.height / 2;
        this.x += (targetX - this.x + Math.sin(Date.now() * 0.002 + this.id) * 30) * 0.02;
        this.y += (targetY - this.y + Math.cos(Date.now() * 0.002 + this.id) * 30) * 0.02;
      } else if (layoutMode === 'orbit') {
        const cx = canvas.width / 2, cy = canvas.height / 2;
        const r = 100 + this.id * 8;
        const a = Date.now() * 0.0005 * (this.id % 2 === 0 ? 1 : -1) + this.id * 0.3;
        this.x = cx + Math.cos(a) * r; this.y = cy + Math.sin(a) * r;
      }
    }
    draw() {
      const sel = selectedNode === this;
      ctx.save();
      ctx.beginPath();
      ctx.arc(this.x, this.y, sel ? this.radius + 4 : this.radius, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.color;
      ctx.shadowBlur = sel || this.hit ? 22 : 10;
      ctx.fill();
      if (sel || this.hit) { ctx.lineWidth = 2; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
      ctx.restore();
    }
  }

  async function loadNodes(q) {
    const url = '/api/nodes?limit=48' + (q ? '&q=' + encodeURIComponent(q) : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error('nodes ' + res.status);
    const data = await res.json();
    nodes = data.nodes.map((c, i) => new Node(i, c));
    selectedNode = nodes[0] || null;
    if (statNodes) statNodes.textContent = `${nodes.length} SHOWN`;
    if (selectedNode) updateInspector(selectedNode);
    else showEmptyInspector(q);
    return nodes;
  }

  function showEmptyInspector(q) {
    inspBadge.textContent = 'STORE';
    inspTitle.textContent = q ? `no conversations match "${q}"` : 'no conversations in the store yet';
    inspDesc.textContent = q ? 'Try another term. Search is full-text over your own record.' :
      'Run: bun scripts/ingest.ts <your export.zip>';
    inspDim.textContent = '—'; inspWeight.textContent = '—'; inspCluster.textContent = '—'; inspVector.textContent = '';
  }

  function updateInspector(node) {
    if (!node) return;
    const c = node.conv;
    inspBadge.textContent = `${c.cluster.toUpperCase()} · ${c.id.slice(-8)}`;
    inspTitle.textContent = c.title || '(untitled)';
    inspDesc.textContent = (c.thread_inferred ? 'Thread boundary inferred from timing (export had no thread id). ' : '') +
      `Started ${fmtDate(c.created_at)}, last activity ${fmtDate(c.updated_at)}.`;
    inspDim.textContent = `${c.message_count} messages`;
    inspWeight.textContent = fmtDate(c.created_at).slice(0, 10);
    inspCluster.textContent = c.cluster;
    inspVector.textContent = c.first ? c.first : '(no user message)';
  }

  function emitSignal(a, b) {
    signals.push({ fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, progress: 0, color: a.color, speed: 0.03 + Math.random() * 0.02 });
  }

  function animateCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(255,255,255,0.02)'; ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
    for (let y = 0; y < canvas.height; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 130) {
          ctx.beginPath(); ctx.moveTo(nodes[i].x, nodes[i].y); ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `rgba(0,243,255,${(1 - dist / 130) * 0.35})`; ctx.lineWidth = 1; ctx.stroke();
          if (Math.random() < 0.0008) emitSignal(nodes[i], nodes[j]);
        }
      }
    }
    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i]; s.progress += s.speed;
      const x = s.fromX + (s.toX - s.fromX) * s.progress, y = s.fromY + (s.toY - s.fromY) * s.progress;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fillStyle = s.color; ctx.shadowColor = s.color; ctx.shadowBlur = 10; ctx.fill();
      if (s.progress >= 1) signals.splice(i, 1);
    }
    nodes.forEach((n) => { n.update(); n.draw(); });
    requestAnimationFrame(animateCanvas);
  }

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    if (mouse.isDown && mouse.draggedNode) { mouse.draggedNode.x = mouse.x; mouse.draggedNode.y = mouse.y; }
  });
  canvas.addEventListener('mousedown', (e) => {
    const r = canvas.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    mouse.isDown = true;
    nodes.forEach((n) => {
      if (Math.hypot(cx - n.x, cy - n.y) < n.radius + 8) { selectedNode = n; mouse.draggedNode = n; updateInspector(n); }
    });
  });
  canvas.addEventListener('dblclick', () => { if (selectedNode) openConversation(selectedNode.conv.id); });
  window.addEventListener('mouseup', () => { mouse.isDown = false; mouse.draggedNode = null; });

  modeBtns.forEach((btn) => btn.addEventListener('click', () => {
    modeBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    layoutMode = btn.dataset.mode;
  }));

  if (btnRefreshMesh) btnRefreshMesh.addEventListener('click', async () => {
    await loadNodes(null);
    appendTerminalMessage('SYSTEM', `Reloaded ${nodes.length} most recent conversations from the store.`);
  });

  // memory search box → filter the canvas to matching conversations
  let searchTimer = null;
  if (memorySearch) memorySearch.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(() => loadNodes(q || null).catch((err) => appendTerminalMessage('SYSTEM', err.message)), 250);
  });

  // ── telemetry ──────────────────────────────────────────────────────────

  async function fetchTelemetry() {
    const t = performance.now();
    try {
      const res = await fetch('/api/telemetry');
      const data = await res.json();
      if (statLatency) statLatency.textContent = `${Math.round(performance.now() - t)} ms`;
      if (statStatus) statStatus.innerHTML = `<span class="dot-green"></span> ${data.status}${data.encrypted ? ' · ENCRYPTED' : ''}`;
      storeCounts = data.counts;
      if (engineBadge) engineBadge.textContent = `${data.counts.conversations.toLocaleString()} CONVERSATIONS · ${data.counts.messages.toLocaleString()} MESSAGES`;
      if (statTps) statTps.textContent = `${data.counts.chunks.toLocaleString()} chunks`;
    } catch {
      if (statLatency) statLatency.textContent = '-- ms';
      if (statStatus) statStatus.innerHTML = `<span class="dot-green" style="background:#ef4444;box-shadow:0 0 8px #ef4444"></span> BACKEND DOWN`;
      if (engineBadge) engineBadge.textContent = 'run: bun scripts/serve.ts';
    }
  }
  setInterval(fetchTelemetry, 3000);
  fetchTelemetry();

  // ── terminal ───────────────────────────────────────────────────────────

  function appendTerminalMessage(sender, text) {
    const div = document.createElement('div');
    div.className = `terminal-msg ${sender.toLowerCase()}-msg`;
    const s = document.createElement('span'); s.className = 'msg-sender'; s.textContent = `[${sender.toUpperCase()}]`;
    const t = document.createElement('span'); t.className = 'msg-text'; t.textContent = text;
    div.appendChild(s); div.appendChild(t);
    terminalOutput.appendChild(div);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
    return t;
  }

  function showTrace(steps) {
    thoughtContent.innerHTML = '';
    thoughtBox.classList.remove('hidden');
    steps.forEach((step, i) => setTimeout(() => {
      const d = document.createElement('div'); d.className = 'thought-step'; d.textContent = `⚡ ${step}`;
      thoughtContent.appendChild(d);
    }, i * 200));
  }
  function hideTrace() { setTimeout(() => thoughtBox.classList.add('hidden'), 1200); }

  function speakText(text) {
    if (!voiceEnabled || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }
  if (btnVoiceToggle) btnVoiceToggle.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    btnVoiceToggle.classList.toggle('active', voiceEnabled);
    appendTerminalMessage('SYSTEM', `Voice readout ${voiceEnabled ? 'enabled' : 'disabled'}.`);
  });

  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR(); rec.continuous = false; rec.interimResults = false;
    const stop = () => { isRecording = false; btnMic.classList.remove('recording'); promptInput.placeholder = 'Search your conversations…'; };
    rec.onstart = () => { isRecording = true; btnMic.classList.add('recording'); promptInput.placeholder = 'Listening…'; };
    rec.onresult = (e) => { const t = e.results[0][0].transcript; promptInput.value = t; handleUserSubmit(t); };
    rec.onerror = stop; rec.onend = stop;
    btnMic.addEventListener('click', () => (isRecording ? rec.stop() : rec.start()));
  } else {
    btnMic.style.opacity = '0.4'; btnMic.title = 'Speech recognition not available in this browser';
  }
  promptInput.placeholder = 'Search your conversations…';

  function streamInto(el, text, done) {
    let i = 0; const t0 = performance.now();
    const iv = setInterval(() => {
      el.textContent += text.charAt(i++);
      terminalOutput.scrollTop = terminalOutput.scrollHeight;
      if (i >= text.length) { clearInterval(iv); done && done(performance.now() - t0); }
    }, 6);
  }

  async function openConversation(id) {
    const res = await fetch('/api/conversation/' + encodeURIComponent(id));
    if (!res.ok) { appendTerminalMessage('SYSTEM', 'conversation not found'); return; }
    const c = await res.json();
    appendTerminalMessage('SYSTEM', `── ${c.cluster} · ${c.title || '(untitled)'} · ${c.messages.length} messages${c.thread_inferred ? ' · thread inferred' : ''} ──`);
    c.messages.slice(0, 40).forEach((m) => {
      const body = m.body.length > 600 ? m.body.slice(0, 600) + '…' : m.body;
      appendTerminalMessage(m.role === 'user' ? 'USER' : 'STORE', `${fmtDate(m.created_at)}${m.on_main_path ? '' : ' [branch]'}  ${body}`);
    });
    if (c.messages.length > 40) appendTerminalMessage('SYSTEM', `… ${c.messages.length - 40} more messages not shown`);
  }

  async function handleUserSubmit(q) {
    q = q.trim();
    if (!q) return;
    appendTerminalMessage('USER', q);
    promptInput.value = '';
    const total = storeCounts ? storeCounts.messages.toLocaleString() : '?';
    showTrace([`FTS5 full-text search over ${total} messages and ${storeCounts ? storeCounts.chunks.toLocaleString() : '?'} file chunks`, 'ranking by bm25', 'reading back your own record — nothing generated']);
    const t0 = performance.now();
    let data;
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=8');
      data = await res.json();
    } catch (e) {
      hideTrace(); appendTerminalMessage('SYSTEM', 'backend unreachable — run: bun scripts/serve.ts'); return;
    }
    const ms = Math.round(performance.now() - t0);
    hideTrace();
    nodes.forEach((n) => (n.hit = false));
    if (!data.results.length) {
      appendTerminalMessage('STORE', `no matches for "${q}" (${ms} ms)`);
      return;
    }
    const hitIds = new Set(data.results.filter((r) => r.kind === 'conversation').map((r) => r.conversation_id));
    nodes.forEach((n) => { if (hitIds.has(n.conv.id)) { n.hit = true; emitSignal(n, nodes[Math.floor(Math.random() * nodes.length)]); } });
    const first = nodes.find((n) => n.hit); if (first) { selectedNode = first; updateInspector(first); }
    const lines = data.results.map((r, i) => r.kind === 'conversation'
      ? `${i + 1}. [${r.provider}] ${r.title || '(untitled)'} · ${r.role} · ${fmtDate(r.created_at)}\n   ${r.snippet.replace(/\s+/g, ' ')}`
      : `${i + 1}. [file] ${r.path}\n   ${r.snippet.replace(/\s+/g, ' ')}`);
    const text = `${data.results.length} matches in ${ms} ms\n` + lines.join('\n');
    const el = appendTerminalMessage('STORE', '');
    streamInto(el, text, (elapsed) => {
      if (statTps) statTps.textContent = `${(text.length / (elapsed / 1000)).toFixed(0)} ch/s`;
      speakText(`${data.results.length} matches. First: ${lines[0].split('\n')[0]}`);
    });
  }

  promptForm.addEventListener('submit', (e) => { e.preventDefault(); handleUserSubmit(promptInput.value); });

  // ── boot ───────────────────────────────────────────────────────────────
  loadNodes(null)
    .then(() => appendTerminalMessage('SYSTEM', `Connected to the store. ${nodes.length} recent conversations on the canvas. Type a word to search; double-click a node to read it.`))
    .catch((err) => appendTerminalMessage('SYSTEM', `backend unreachable (${err.message}) — run: bun scripts/serve.ts`));
  animateCanvas();
});
