// TTN Dashboard – app.js

const CHART_COLORS = [
  '#7c3aed','#10b981','#f59e0b','#ef4444',
  '#3b82f6','#ec4899','#14b8a6','#f97316',
];

// ── TTN API ────────────────────────────────────────────────────────────────
class TTNApi {
  constructor({ cluster, appId, apiKey }) {
    this.base  = `https://${cluster}/api/v3`;
    this.appId = appId;
    this.hdrs  = { Authorization: `Bearer ${apiKey}` };
  }

  async _get(path) {
    const r = await fetch(this.base + path, { headers: this.hdrs });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`API ${r.status}: ${body || r.statusText}`);
    }
    return r.json();
  }

  // TTN Storage Integration returns newline-delimited JSON
  async _ndjson(path) {
    const r = await fetch(this.base + path, { headers: this.hdrs });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`API ${r.status}: ${body || r.statusText}`);
    }
    const text = await r.text();
    return text.trim().split('\n')
      .filter(l => l)
      .map(l => { try { return JSON.parse(l).result; } catch { return null; } })
      .filter(Boolean);
  }

  async getDevices() {
    const d = await this._get(
      `/applications/${this.appId}/devices?field_mask=name,description,locations`
    );
    return d.end_devices || [];
  }

  getMessages(deviceId, limit = 50) {
    return this._ndjson(
      `/as/applications/${this.appId}/devices/${deviceId}` +
      `/packages/storage/uplink_message?limit=${limit}&order=-received_at`
    );
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────
function timeSince(dateStr) {
  if (!dateStr) return 'Okänd';
  const ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 60_000)   return 'Precis nu';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min sedan`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} tim sedan`;
  return `${Math.floor(ms / 86_400_000)} dag(ar) sedan`;
}

function statusOf(lastSeen) {
  if (!lastSeen) return 'unknown';
  const ms = Date.now() - new Date(lastSeen).getTime();
  if (ms < 3_600_000)  return 'online';
  if (ms < 86_400_000) return 'idle';
  return 'offline';
}

function fmtDateTime(dateStr) {
  if (!dateStr) return '–';
  return new Date(dateStr).toLocaleString('sv-SE');
}

function numericFields(payload) {
  if (!payload || typeof payload !== 'object') return {};
  return Object.fromEntries(
    Object.entries(payload).filter(([, v]) => typeof v === 'number')
  );
}

function shortLabel(dateStr) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Dashboard ──────────────────────────────────────────────────────────────
class Dashboard {
  constructor() {
    this.api            = null;
    this.devices        = [];
    this.latestMsgs     = {};  // deviceId → message[]
    this.selectedId     = null;
    this.chart          = null;
    this.refreshTimer   = null;
  }

  // Entry point
  init() {
    if (sessionStorage.getItem('ttn_auth') === '1') {
      this._startDashboard();
    }

    document.getElementById('loginForm').addEventListener('submit', async e => {
      e.preventDefault();
      const pw = document.getElementById('passwordInput').value;
      if (pw === CONFIG.password) {
        sessionStorage.setItem('ttn_auth', '1');
        document.getElementById('loginErr').classList.add('hidden');
        this._startDashboard();
      } else {
        document.getElementById('loginErr').classList.remove('hidden');
        document.getElementById('passwordInput').value = '';
      }
    });

    document.getElementById('logoutBtn').addEventListener('click',  () => this._logout());
    document.getElementById('refreshBtn').addEventListener('click', () => this._refresh());
    document.getElementById('backBtn').addEventListener('click',    () => this._showOverview());
  }

  _logout() {
    sessionStorage.removeItem('ttn_auth');
    clearInterval(this.refreshTimer);
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('loginSection').classList.remove('hidden');
    document.getElementById('passwordInput').value = '';
    this.selectedId = null;
  }

  _startDashboard() {
    this.api = new TTNApi(CONFIG);
    document.getElementById('loginSection').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    document.getElementById('appName').textContent = CONFIG.appId;
    this._refresh();
    this.refreshTimer = setInterval(() => this._refresh(), CONFIG.refreshInterval);
  }

  async _refresh() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    try {
      await this._loadDevices();
      document.getElementById('lastRefresh').textContent = fmtDateTime(new Date());
    } catch (err) {
      this._toast(err.message);
    } finally {
      btn.classList.remove('spinning');
    }
  }

  // Load all devices + their latest message in parallel
  async _loadDevices() {
    this.devices = await this.api.getDevices();

    await Promise.allSettled(this.devices.map(async d => {
      const id = d.ids.device_id;
      try {
        const msgs = await this.api.getMessages(id, 1);
        this.latestMsgs[id] = msgs;
      } catch {
        this.latestMsgs[id] = [];
      }
    }));

    this._renderSidebar();
    this._updateStats();

    // Re-render detail if a device is selected
    if (this.selectedId) {
      const dev = this.devices.find(d => d.ids.device_id === this.selectedId);
      if (dev) this._openDevice(dev, false);
    }
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────
  _renderSidebar() {
    document.getElementById('deviceCount').textContent = this.devices.length;
    const list = document.getElementById('deviceList');
    list.innerHTML = '';

    if (this.devices.length === 0) {
      list.innerHTML = '<div class="empty-sidebar">Inga enheter hittades.<br>Kontrollera App ID och API-nyckel.</div>';
      return;
    }

    this.devices.forEach(dev => {
      const id      = dev.ids.device_id;
      const msgs    = this.latestMsgs[id] || [];
      const lastAt  = msgs[0]?.received_at;
      const status  = statusOf(lastAt);
      const isActive = this.selectedId === id;

      const el = document.createElement('div');
      el.className = `device-item${isActive ? ' active' : ''}`;
      el.innerHTML = `
        <div class="dot ${status}"></div>
        <div style="flex:1;min-width:0">
          <div class="di-name">${dev.name || id}</div>
          <div class="di-id">${id}</div>
          <div class="di-seen">${lastAt ? timeSince(lastAt) : 'Ingen data'}</div>
        </div>
      `;
      el.addEventListener('click', () => this._openDevice(dev, true));
      list.appendChild(el);
    });
  }

  // ── Stats overview ────────────────────────────────────────────────────────
  _updateStats() {
    const counts = { online: 0, idle: 0, offline: 0, unknown: 0 };
    this.devices.forEach(d => {
      const msgs = this.latestMsgs[d.ids.device_id] || [];
      counts[statusOf(msgs[0]?.received_at)]++;
    });
    document.getElementById('statTotal').textContent   = this.devices.length;
    document.getElementById('statOnline').textContent  = counts.online;
    document.getElementById('statIdle').textContent    = counts.idle;
    document.getElementById('statOffline').textContent = counts.offline + counts.unknown;
  }

  _showOverview() {
    this.selectedId = null;
    this._renderSidebar();
    document.getElementById('deviceDetail').classList.add('hidden');
    document.getElementById('overview').classList.remove('hidden');
    if (this.chart) { this.chart.destroy(); this.chart = null; }
  }

  // ── Device detail ─────────────────────────────────────────────────────────
  async _openDevice(dev, fetchFresh) {
    const id = dev.ids.device_id;
    this.selectedId = id;
    this._renderSidebar();

    document.getElementById('overview').classList.add('hidden');
    document.getElementById('deviceDetail').classList.remove('hidden');
    document.getElementById('detailName').textContent = dev.name || id;
    document.getElementById('detailId').textContent   = id;
    document.getElementById('detailContent').innerHTML = '';

    if (this.chart) { this.chart.destroy(); this.chart = null; }

    if (!fetchFresh && this.latestMsgs[id]?.length) {
      this._renderDetail(dev, this.latestMsgs[id]);
      return;
    }

    document.getElementById('detailLoading').classList.remove('hidden');
    try {
      const msgs = await this.api.getMessages(id, CONFIG.historyLimit);
      this.latestMsgs[id] = msgs;
      this._renderDetail(dev, msgs);
    } catch (err) {
      document.getElementById('detailContent').innerHTML =
        `<div class="err-box">Kunde inte hämta data: ${err.message}</div>`;
    } finally {
      document.getElementById('detailLoading').classList.add('hidden');
    }
  }

  _renderDetail(dev, messages) {
    const container = document.getElementById('detailContent');
    container.innerHTML = '';

    if (!messages.length) {
      container.innerHTML = `
        <div class="no-data">
          Inga meddelanden hittades för denna enhet.<br>
          <span style="font-size:13px">Kontrollera att <em>Storage Integration</em> är aktiverat i TTN Console.</span>
        </div>`;
      return;
    }

    const latest  = messages[0];
    const uplink  = latest.uplink_message || {};
    const payload = uplink.decoded_payload;
    const gw      = (uplink.rx_metadata || [])[0] || {};
    const sf      = uplink.settings?.data_rate?.lora?.spreading_factor;
    const status  = statusOf(latest.received_at);

    // Meta cards
    const meta = document.createElement('div');
    meta.className = 'meta-grid';
    meta.innerHTML = `
      <div class="meta-card">
        <div class="meta-lbl">Status</div>
        <div class="meta-val"><span class="status-pill ${status}">${status}</span></div>
      </div>
      <div class="meta-card">
        <div class="meta-lbl">Senast sett</div>
        <div class="meta-val">${fmtDateTime(latest.received_at)}</div>
      </div>
      <div class="meta-card">
        <div class="meta-lbl">RSSI</div>
        <div class="meta-val">${gw.rssi != null ? gw.rssi + ' dBm' : '–'}</div>
      </div>
      <div class="meta-card">
        <div class="meta-lbl">SNR</div>
        <div class="meta-val">${gw.snr != null ? gw.snr + ' dB' : '–'}</div>
      </div>
      <div class="meta-card">
        <div class="meta-lbl">Spreading factor</div>
        <div class="meta-val">${sf != null ? 'SF' + sf : '–'}</div>
      </div>
      <div class="meta-card">
        <div class="meta-lbl">Sparade meddelanden</div>
        <div class="meta-val">${messages.length}</div>
      </div>
    `;
    container.appendChild(meta);

    // Payload section
    if (payload && typeof payload === 'object' && Object.keys(payload).length) {
      const title = document.createElement('div');
      title.className = 'sec-title';
      title.textContent = 'Avkodad payload (senaste uplink)';
      container.appendChild(title);

      const rows = Object.entries(payload).map(([k, v]) => {
        const display = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `<tr><td class="f-key">${k}</td><td class="f-val">${display}</td></tr>`;
      }).join('');

      const tbl = document.createElement('table');
      tbl.className = 'payload-tbl';
      tbl.innerHTML = `
        <thead><tr><th>Fält</th><th>Värde</th></tr></thead>
        <tbody>${rows}</tbody>
      `;
      container.appendChild(tbl);
    } else if (uplink.frm_payload) {
      const title = document.createElement('div');
      title.className = 'sec-title';
      title.textContent = 'Raw payload (Base64)';
      container.appendChild(title);
      const raw = document.createElement('div');
      raw.className = 'raw-payload';
      raw.textContent = uplink.frm_payload;
      container.appendChild(raw);
    }

    // Chart
    this._renderChart(container, messages);
  }

  _renderChart(container, messages) {
    const reversed = [...messages].reverse();
    const labels   = reversed.map(m => shortLabel(m.received_at));

    // Prefer decoded numeric fields; fall back to RSSI
    const firstPayload = reversed.find(m => m.uplink_message?.decoded_payload)?.uplink_message?.decoded_payload;
    const numKeys      = Object.keys(numericFields(firstPayload || {}));

    let datasets;
    if (numKeys.length) {
      datasets = numKeys.map((key, i) => ({
        label: key,
        data: reversed.map(m => m.uplink_message?.decoded_payload?.[key] ?? null),
        borderColor: CHART_COLORS[i % CHART_COLORS.length],
        backgroundColor: CHART_COLORS[i % CHART_COLORS.length] + '20',
        tension: 0.35,
        spanGaps: true,
        pointRadius: reversed.length > 30 ? 2 : 4,
      }));
    } else {
      datasets = [{
        label: 'RSSI (dBm)',
        data: reversed.map(m => (m.uplink_message?.rx_metadata || [])[0]?.rssi ?? null),
        borderColor: CHART_COLORS[0],
        backgroundColor: CHART_COLORS[0] + '20',
        tension: 0.35,
        spanGaps: true,
        pointRadius: reversed.length > 30 ? 2 : 4,
      }];
    }

    const titleEl = document.createElement('div');
    titleEl.className = 'sec-title';
    titleEl.textContent = 'Historisk data';

    const card = document.createElement('div');
    card.className = 'chart-card';
    card.appendChild(titleEl);

    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    const canvas = document.createElement('canvas');
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    container.appendChild(card);

    this.chart = new Chart(canvas, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: '#7d8590', font: { size: 12 } } },
          tooltip: { backgroundColor: '#21262d', borderColor: '#30363d', borderWidth: 1, titleColor: '#e6edf3', bodyColor: '#7d8590' },
        },
        scales: {
          x: {
            ticks: { color: '#7d8590', maxRotation: 45, maxTicksLimit: 12 },
            grid:  { color: '#21262d' },
          },
          y: {
            ticks: { color: '#7d8590' },
            grid:  { color: '#21262d' },
          },
        },
      },
    });
  }

  _toast(msg) {
    const el = document.getElementById('errorToast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), 6000);
  }
}

// Boot
const dash = new Dashboard();
dash.init();
