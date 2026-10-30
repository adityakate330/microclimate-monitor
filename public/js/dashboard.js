/**
 * dashboard.js - MicroClimate Monitor Frontend Controller
 * Handles real-time Socket.IO events, Chart.js graphs, SVG gauges,
 * multi-tab navigation, alerts, audio feedback, settings, and profile management.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Authentication & Session Guard
  // ---------------------------------------------------------------------------
  const token = localStorage.getItem('mcm_token') || sessionStorage.getItem('mcm_token');
  if (!token) {
    window.location.href = '/index.html';
    return;
  }

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------
  const state = {
    user: null,
    unit: localStorage.getItem('mcm_unit') || 'C', // 'C' or 'F'
    theme: localStorage.getItem('mcm_theme') || 'dark',
    soundEnabled: localStorage.getItem('mcm_sound') !== 'false',
    thresholds: {
      tempMin: 15, tempMax: 35,
      humMin: 30, humMax: 80,
      soilMin: 30, soilMax: 70
    },
    liveReadings: [], // Last 30 readings
    latestReading: null,
    alerts: [],
    unreadAlerts: 0,
    charts: {},
    socket: null,
    deviceStatus: { connected: false, port: null, demoMode: false }
  };

  // ---------------------------------------------------------------------------
  // API Helper
  // ---------------------------------------------------------------------------
  async function apiFetch(endpoint, options = {}) {
    options.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(options.headers || {})
    };

    try {
      const res = await fetch(endpoint, options);
      if (res.status === 401) {
        localStorage.removeItem('mcm_token');
        sessionStorage.removeItem('mcm_token');
        window.location.href = '/index.html';
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`Fetch error (${endpoint}):`, err);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Sound Alerts (Web Audio API)
  // ---------------------------------------------------------------------------
  function playAlertBeep(isCritical = false) {
    if (!state.soundEnabled) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = isCritical ? 'sawtooth' : 'sine';
      osc.frequency.setValueAtTime(isCritical ? 880 : 587.33, ctx.currentTime); // A5 or D5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + (isCritical ? 0.35 : 0.2));

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + (isCritical ? 0.35 : 0.2));
    } catch (e) {
      // Audio might be blocked by browser autoplay policy until interaction
    }
  }

  // ---------------------------------------------------------------------------
  // Toast Notifications
  // ---------------------------------------------------------------------------
  function showToast(message, type = 'info', title = '') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const iconMap = {
      success: 'fa-check-circle',
      warning: 'fa-triangle-exclamation',
      error: 'fa-circle-exclamation',
      info: 'fa-circle-info'
    };

    const header = title || (type === 'error' ? 'Alert' : type.charAt(0).toUpperCase() + type.slice(1));
    toast.innerHTML = `
      <i class="fas ${iconMap[type] || 'fa-bell'} toast-icon"></i>
      <div class="toast-body">
        <div class="toast-title">${header}</div>
        <div class="toast-message">${escapeHtml(message)}</div>
      </div>
      <button class="toast-close"><i class="fas fa-times"></i></button>
    `;

    toast.querySelector('.toast-close').addEventListener('click', () => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 350);
    });

    container.appendChild(toast);

    setTimeout(() => {
      if (toast.isConnected) {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 350);
      }
    }, 5000);
  }

  window.dismissBanner = function () {
    const banner = document.getElementById('alert-banner');
    if (banner) banner.classList.add('hidden');
  };

  function showAlertBanner(text) {
    const banner = document.getElementById('alert-banner');
    const bannerText = document.getElementById('alert-banner-text');
    if (banner && bannerText) {
      bannerText.textContent = text;
      banner.classList.remove('hidden');
    }
  }

  // ---------------------------------------------------------------------------
  // Unit & Conversion Helpers
  // ---------------------------------------------------------------------------
  function formatTemp(celsius) {
    if (celsius === null || celsius === undefined || isNaN(celsius)) return '--';
    if (state.unit === 'F') {
      const f = (celsius * 9) / 5 + 32;
      return f.toFixed(1);
    }
    return Number(celsius).toFixed(1);
  }

  function getTempUnit() {
    return state.unit === 'F' ? '°F' : '°C';
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  // ---------------------------------------------------------------------------
  // Gauge & Progress Ring Updates
  // ---------------------------------------------------------------------------
  function updateSvgGauge(elementId, value, min, max, warnMin, warnMax) {
    const circle = document.getElementById(elementId);
    if (!circle) return;

    // Radius = 70 (perimeter ~440) for 160px, radius = 88 (perimeter ~552) for 200px
    const isLarge = circle.getAttribute('r') === '88';
    const circumference = isLarge ? 2 * Math.PI * 88 : 2 * Math.PI * 70;

    let clamped = Math.max(min, Math.min(max, value));
    let ratio = (clamped - min) / (max - min);
    if (isNaN(ratio)) ratio = 0;

    const offset = circumference * (1 - ratio);
    circle.style.strokeDasharray = `${circumference}`;
    circle.style.strokeDashoffset = `${offset}`;

    // Color based on thresholds
    if (value < warnMin || value > warnMax) {
      circle.style.stroke = 'var(--danger)';
    } else {
      circle.style.stroke = elementId.includes('temp') ? 'var(--gauge-temp)'
                          : elementId.includes('hum') ? 'var(--gauge-hum)'
                          : 'var(--gauge-soil)';
    }
  }

  // ---------------------------------------------------------------------------
  // Status Evaluators
  // ---------------------------------------------------------------------------
  function evalParamStatus(value, min, max) {
    if (value === null || value === undefined) return { label: 'Waiting…', class: 'normal' };
    if (value < min) {
      return { label: 'Low', class: 'warning' };
    } else if (value > max) {
      return { label: 'High', class: 'critical' };
    }
    return { label: 'Optimal', class: 'normal' };
  }

  // ---------------------------------------------------------------------------
  // Render Sensor Data in Dashboard
  // ---------------------------------------------------------------------------
  function applyReading(reading) {
    state.latestReading = reading;
    state.liveReadings.push(reading);
    if (state.liveReadings.length > 30) {
      state.liveReadings.shift();
    }

    const { temp, hum, soil } = reading;
    const { tempMin, tempMax, humMin, humMax, soilMin, soilMax } = state.thresholds;

    // --- Temperature ---
    const tempStatus = evalParamStatus(temp, tempMin, tempMax);
    document.getElementById('val-temp').textContent = formatTemp(temp);
    document.getElementById('unit-temp').textContent = getTempUnit();
    const stTemp = document.getElementById('status-temp');
    stTemp.textContent = tempStatus.label;
    stTemp.className = `status-badge ${tempStatus.class}`;
    updateSvgGauge('gauge-temp', temp, 0, 50, tempMin, tempMax);

    const cardTemp = document.getElementById('card-temp');
    cardTemp.classList.remove('warning-state', 'critical-state');
    if (tempStatus.class === 'critical') cardTemp.classList.add('critical-state');
    else if (tempStatus.class === 'warning') cardTemp.classList.add('warning-state');

    // Detail temp page
    const valTempDet = document.getElementById('val-temp-detail');
    if (valTempDet) {
      valTempDet.textContent = formatTemp(temp);
      document.getElementById('unit-temp-detail').textContent = getTempUnit();
      const stTempDet = document.getElementById('status-temp-detail');
      stTempDet.textContent = tempStatus.label;
      stTempDet.className = `status-badge ${tempStatus.class}`;
      updateSvgGauge('gauge-temp-detail', temp, 0, 50, tempMin, tempMax);
      document.getElementById('stat-temp-current').textContent = `${formatTemp(temp)} ${getTempUnit()}`;
    }

    // --- Humidity ---
    const humStatus = evalParamStatus(hum, humMin, humMax);
    document.getElementById('val-hum').textContent = Math.round(hum);
    const stHum = document.getElementById('status-hum');
    stHum.textContent = humStatus.label;
    stHum.className = `status-badge ${humStatus.class}`;
    updateSvgGauge('gauge-hum', hum, 0, 100, humMin, humMax);

    const cardHum = document.getElementById('card-hum');
    cardHum.classList.remove('warning-state', 'critical-state');
    if (humStatus.class === 'critical') cardHum.classList.add('critical-state');
    else if (humStatus.class === 'warning') cardHum.classList.add('warning-state');

    // Detail hum page
    const valHumDet = document.getElementById('val-hum-detail');
    if (valHumDet) {
      valHumDet.textContent = Math.round(hum);
      const stHumDet = document.getElementById('status-hum-detail');
      stHumDet.textContent = humStatus.label;
      stHumDet.className = `status-badge ${humStatus.class}`;
      updateSvgGauge('gauge-hum-detail', hum, 0, 100, humMin, humMax);
      document.getElementById('stat-hum-current').textContent = `${Math.round(hum)} %`;
    }

    // --- Soil Moisture ---
    const soilStatus = evalParamStatus(soil, soilMin, soilMax);
    document.getElementById('val-soil').textContent = Math.round(soil);
    const stSoil = document.getElementById('status-soil');
    stSoil.textContent = soilStatus.label;
    stSoil.className = `status-badge ${soilStatus.class}`;
    updateSvgGauge('gauge-soil', soil, 0, 100, soilMin, soilMax);

    const cardSoil = document.getElementById('card-soil');
    cardSoil.classList.remove('warning-state', 'critical-state');
    if (soilStatus.class === 'critical') cardSoil.classList.add('critical-state');
    else if (soilStatus.class === 'warning') cardSoil.classList.add('warning-state');

    // Detail soil page
    const valSoilDet = document.getElementById('val-soil-detail');
    if (valSoilDet) {
      valSoilDet.textContent = Math.round(soil);
      const stSoilDet = document.getElementById('status-soil-detail');
      stSoilDet.textContent = soilStatus.label;
      stSoilDet.className = `status-badge ${soilStatus.class}`;
      updateSvgGauge('gauge-soil-detail', soil, 0, 100, soilMin, soilMax);
      document.getElementById('stat-soil-current').textContent = `${Math.round(soil)} %`;

      // Advisory text
      const iconElem = document.getElementById('soil-status-icon');
      const textElem = document.getElementById('soil-status-text');
      const sugElem = document.getElementById('soil-suggestion');
      if (soil < soilMin) {
        iconElem.textContent = '🏜️';
        textElem.textContent = `Dry (${Math.round(soil)}%) – Irrigation recommended`;
        sugElem.textContent = 'Soil moisture is critically low. Initiate automated irrigation or manual watering immediately.';
      } else if (soil > soilMax) {
        iconElem.textContent = '💧';
        textElem.textContent = `Waterlogged (${Math.round(soil)}%) – Pause watering`;
        sugElem.textContent = 'Excess moisture detected. Suspend watering to prevent root rot and aerate the substrate.';
      } else {
        iconElem.textContent = '🌿';
        textElem.textContent = `Optimal (${Math.round(soil)}%) – Healthy root zone`;
        sugElem.textContent = 'Moisture levels are within ideal range for healthy crop growth. No action required.';
      }
    }

    // --- Update Live Chart ---
    updateLiveChart();
    updateDetailStats();
  }

  // ---------------------------------------------------------------------------
  // Chart.js Implementations
  // ---------------------------------------------------------------------------
  function initCharts() {
    // 1. Live Multi-parameter Chart
    const liveCanvas = document.getElementById('live-chart');
    if (liveCanvas) {
      const ctx = liveCanvas.getContext('2d');
      state.charts.live = new Chart(ctx, {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            {
              label: 'Temp (°C)',
              borderColor: '#ef4444',
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              fill: true,
              tension: 0.35,
              data: []
            },
            {
              label: 'Humidity (%)',
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59, 130, 246, 0.12)',
              fill: true,
              tension: 0.35,
              data: []
            },
            {
              label: 'Soil (%)',
              borderColor: '#22c55e',
              backgroundColor: 'rgba(34, 197, 94, 0.12)',
              fill: true,
              tension: 0.35,
              data: []
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 400 },
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { color: 'rgba(255,255,255,0.5)', maxTicksLimit: 8 }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { color: 'rgba(255,255,255,0.5)' }
            }
          },
          plugins: {
            legend: { labels: { color: 'rgba(255,255,255,0.8)', boxWidth: 12 } }
          }
        }
      });
    }

    // Helper for single parameter detail charts
    function makeDetailChart(canvasId, label, color) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return null;
      return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [{
            label: label,
            borderColor: color,
            backgroundColor: `${color}20`,
            fill: true,
            tension: 0.35,
            data: []
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { color: 'rgba(255,255,255,0.5)', maxTicksLimit: 8 }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { color: 'rgba(255,255,255,0.5)' }
            }
          },
          plugins: {
            legend: { labels: { color: 'rgba(255,255,255,0.8)' } }
          }
        }
      });
    }

    state.charts.temp = makeDetailChart('temp-history-chart', 'Temperature', '#ef4444');
    state.charts.hum = makeDetailChart('hum-history-chart', 'Humidity (%)', '#3b82f6');
    state.charts.soil = makeDetailChart('soil-history-chart', 'Soil Moisture (%)', '#22c55e');

    // History & Analytics multi-line chart
    const histCanvas = document.getElementById('history-chart');
    if (histCanvas) {
      state.charts.history = new Chart(histCanvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: [],
          datasets: [
            { label: 'Temp', borderColor: '#ef4444', backgroundColor: 'transparent', data: [], tension: 0.3 },
            { label: 'Humidity', borderColor: '#3b82f6', backgroundColor: 'transparent', data: [], tension: 0.3 },
            { label: 'Soil', borderColor: '#22c55e', backgroundColor: 'transparent', data: [], tension: 0.3 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { color: 'rgba(255,255,255,0.5)', maxTicksLimit: 10 }
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { color: 'rgba(255,255,255,0.5)' }
            }
          },
          plugins: {
            legend: { labels: { color: 'rgba(255,255,255,0.8)' } }
          }
        }
      });
    }
  }

  function updateLiveChart() {
    const chart = state.charts.live;
    if (!chart) return;

    chart.data.labels = state.liveReadings.map(r => {
      const d = new Date(r.timestamp);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });

    chart.data.datasets[0].data = state.liveReadings.map(r =>
      state.unit === 'F' ? ((r.temp * 9) / 5 + 32).toFixed(1) : r.temp
    );
    chart.data.datasets[0].label = `Temp (${getTempUnit()})`;
    chart.data.datasets[1].data = state.liveReadings.map(r => r.hum);
    chart.data.datasets[2].data = state.liveReadings.map(r => r.soil);

    chart.update('none');
  }

  function updateDetailStats() {
    if (state.liveReadings.length === 0) return;

    function stats(arr) {
      const min = Math.min(...arr);
      const max = Math.max(...arr);
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      return { min, max, avg };
    }

    const temps = state.liveReadings.map(r => r.temp);
    const hums = state.liveReadings.map(r => r.hum);
    const soils = state.liveReadings.map(r => r.soil);

    const t = stats(temps);
    document.getElementById('stat-temp-min').textContent = `${formatTemp(t.min)} ${getTempUnit()}`;
    document.getElementById('stat-temp-max').textContent = `${formatTemp(t.max)} ${getTempUnit()}`;
    document.getElementById('stat-temp-avg').textContent = `${formatTemp(t.avg)} ${getTempUnit()}`;

    const h = stats(hums);
    document.getElementById('stat-hum-min').textContent = `${Math.round(h.min)} %`;
    document.getElementById('stat-hum-max').textContent = `${Math.round(h.max)} %`;
    document.getElementById('stat-hum-avg').textContent = `${Math.round(h.avg)} %`;

    const s = stats(soils);
    document.getElementById('stat-soil-min').textContent = `${Math.round(s.min)} %`;
    document.getElementById('stat-soil-max').textContent = `${Math.round(s.max)} %`;
    document.getElementById('stat-soil-avg').textContent = `${Math.round(s.avg)} %`;
  }

  // ---------------------------------------------------------------------------
  // Load Historical Series for Detail Charts
  // ---------------------------------------------------------------------------
  async function loadHistorySeries(chartType, range = '1h') {
    const data = await apiFetch(`/api/readings?range=${range}`);
    if (!data || !Array.isArray(data)) return;

    const labels = data.map(r => {
      const d = new Date(r.timestamp);
      return range === '7d' ? d.toLocaleDateString([], { month: 'numeric', day: 'numeric', hour: '2-digit' })
                            : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    });

    if (chartType === 'temp' && state.charts.temp) {
      state.charts.temp.data.labels = labels;
      state.charts.temp.data.datasets[0].data = data.map(r =>
        state.unit === 'F' ? ((r.temp * 9) / 5 + 32).toFixed(1) : r.temp
      );
      state.charts.temp.data.datasets[0].label = `Temperature (${getTempUnit()})`;
      state.charts.temp.update();
    } else if (chartType === 'hum' && state.charts.hum) {
      state.charts.hum.data.labels = labels;
      state.charts.hum.data.datasets[0].data = data.map(r => r.hum);
      state.charts.hum.update();
    } else if (chartType === 'soil' && state.charts.soil) {
      state.charts.soil.data.labels = labels;
      state.charts.soil.data.datasets[0].data = data.map(r => r.soil);
      state.charts.soil.update();
    } else if (chartType === 'history' && state.charts.history) {
      renderHistoryTableAndChart(data);
    }
  }

  function renderHistoryTableAndChart(readings) {
    const chart = state.charts.history;
    const labels = readings.map(r => {
      const d = new Date(r.timestamp);
      return d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    });

    if (chart) {
      chart.data.labels = labels;
      chart.data.datasets[0].data = readings.map(r =>
        state.unit === 'F' ? ((r.temp * 9) / 5 + 32).toFixed(1) : r.temp
      );
      chart.data.datasets[0].label = `Temp (${getTempUnit()})`;
      chart.data.datasets[1].data = readings.map(r => r.hum);
      chart.data.datasets[2].data = readings.map(r => r.soil);
      chart.update();
    }

    // Averages
    if (readings.length > 0) {
      const avgT = readings.reduce((a, b) => a + b.temp, 0) / readings.length;
      const avgH = readings.reduce((a, b) => a + b.hum, 0) / readings.length;
      const avgS = readings.reduce((a, b) => a + b.soil, 0) / readings.length;
      document.getElementById('hist-avg-temp').textContent = `${formatTemp(avgT)} ${getTempUnit()}`;
      document.getElementById('hist-avg-hum').textContent = `${Math.round(avgH)} %`;
      document.getElementById('hist-avg-soil').textContent = `${Math.round(avgS)} %`;
    }

    // Table rows
    const tbody = document.getElementById('history-table-body');
    const countElem = document.getElementById('history-count');
    if (countElem) countElem.textContent = `${readings.length} readings`;

    if (!tbody) return;
    if (readings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No readings available for this period</td></tr>';
      return;
    }

    // Show most recent 100 in table
    const tableData = [...readings].reverse().slice(0, 100);
    tbody.innerHTML = tableData.map(r => `
      <tr>
        <td>${new Date(r.timestamp).toLocaleString()}</td>
        <td>${formatTemp(r.temp)} ${getTempUnit()}</td>
        <td>${Math.round(r.hum)} %</td>
        <td>${Math.round(r.soil)} %</td>
      </tr>
    `).join('');
  }

  // ---------------------------------------------------------------------------
  // CSV Export
  // ---------------------------------------------------------------------------
  function exportCSV() {
    if (!state.liveReadings || state.liveReadings.length === 0) {
      showToast('No readings available to export.', 'warning');
      return;
    }

    let csv = 'Timestamp,Temperature (°C),Humidity (%),Soil Moisture (%)\n';
    state.liveReadings.forEach(r => {
      csv += `"${r.timestamp}",${r.temp},${r.hum},${r.soil}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `microclimate_readings_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Readings exported to CSV successfully.', 'success');
  }

  // ---------------------------------------------------------------------------
  // Alerts Handling
  // ---------------------------------------------------------------------------
  function addAlertItem(alert, prepend = true) {
    if (prepend) {
      state.alerts.unshift(alert);
      state.unreadAlerts++;
      playAlertBeep(alert.severity === 'critical');
      showAlertBanner(`${alert.severity.toUpperCase()}: ${alert.message}`);
      showToast(alert.message, alert.severity === 'critical' ? 'error' : 'warning');
    }

    updateAlertBadge();
    renderAlerts();
  }

  function updateAlertBadge() {
    const badge = document.getElementById('alert-badge');
    if (!badge) return;
    if (state.unreadAlerts > 0) {
      badge.textContent = state.unreadAlerts > 99 ? '99+' : state.unreadAlerts;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  function renderAlerts() {
    // 1. Dashboard Recent (top 5)
    const recentList = document.getElementById('recent-alerts-list');
    if (recentList) {
      const top5 = state.alerts.slice(0, 5);
      if (top5.length === 0) {
        recentList.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i> No recent alerts</div>';
      } else {
        recentList.innerHTML = top5.map(a => `
          <div class="alert-item ${a.severity}">
            <i class="fas ${a.severity === 'critical' ? 'fa-fire' : 'fa-triangle-exclamation'} alert-icon ${a.severity}"></i>
            <div class="alert-content">
              <div class="alert-message">${escapeHtml(a.message)}</div>
              <div class="alert-time">${new Date(a.timestamp).toLocaleTimeString()}</div>
            </div>
          </div>
        `).join('');
      }
    }

    // 2. Full Alerts Page with Filters
    const fullList = document.getElementById('alerts-full-list');
    if (fullList) {
      const pFilter = document.getElementById('alert-filter-param').value;
      const sFilter = document.getElementById('alert-filter-severity').value;

      let filtered = state.alerts;
      if (pFilter !== 'all') {
        filtered = filtered.filter(a => a.parameter.toLowerCase() === pFilter.toLowerCase());
      }
      if (sFilter !== 'all') {
        filtered = filtered.filter(a => a.severity.toLowerCase() === sFilter.toLowerCase());
      }

      if (filtered.length === 0) {
        fullList.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i> No alerts match filter criteria</div>';
      } else {
        fullList.innerHTML = filtered.map(a => `
          <div class="alert-item ${a.severity}">
            <i class="fas ${a.severity === 'critical' ? 'fa-fire' : 'fa-triangle-exclamation'} alert-icon ${a.severity}"></i>
            <div class="alert-content">
              <div class="alert-message">${escapeHtml(a.message)}</div>
              <div class="alert-time">${new Date(a.timestamp).toLocaleString()} • Parameter: ${a.parameter} • Value: ${a.value} (Threshold: ${a.threshold})</div>
            </div>
          </div>
        `).join('');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Device Connection & Status Bar
  // ---------------------------------------------------------------------------
  function updateDeviceStatus(status) {
    state.deviceStatus = status;
    const statusBox = document.getElementById('connection-status');
    const demoToggle = document.getElementById('demo-toggle');
    if (!statusBox) return;

    const dot = statusBox.querySelector('.status-dot');
    const text = statusBox.querySelector('.status-text');

    dot.className = 'status-dot';
    if (status.demoMode) {
      dot.classList.add('demo');
      text.textContent = 'Demo Mode (Simulated Data)';
      if (demoToggle) demoToggle.checked = true;
    } else if (status.connected) {
      dot.classList.add('connected');
      text.textContent = `Arduino Connected (${status.port || 'USB Serial'})`;
      if (demoToggle) demoToggle.checked = false;
    } else {
      dot.classList.add('disconnected');
      text.textContent = 'Hardware Disconnected';
      if (demoToggle) demoToggle.checked = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Navigation / Tabs
  // ---------------------------------------------------------------------------
  function setupNavigation() {
    const navItems = document.querySelectorAll('[data-page]');
    navItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetPage = item.getAttribute('data-page');
        navigateTo(targetPage);
      });
    });

    // Mobile sidebar toggle
    const hamburger = document.getElementById('hamburger');
    const sidebar = document.getElementById('sidebar');
    const sidebarClose = document.getElementById('sidebar-close');
    const overlay = document.getElementById('sidebar-overlay');

    if (hamburger && sidebar && overlay) {
      hamburger.addEventListener('click', () => {
        sidebar.classList.add('open');
        overlay.classList.add('active');
      });

      const closeSidebar = () => {
        sidebar.classList.remove('open');
        overlay.classList.remove('active');
      };

      sidebarClose.addEventListener('click', closeSidebar);
      overlay.addEventListener('click', closeSidebar);
    }
  }

  function navigateTo(pageId) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const targetSection = document.getElementById(`page-${pageId}`);
    if (targetSection) targetSection.classList.add('active');

    const activeNav = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (activeNav) activeNav.classList.add('active');

    // Clear alert badge count on visiting alerts
    if (pageId === 'alerts') {
      state.unreadAlerts = 0;
      updateAlertBadge();
    }

    // Refresh charts for specific detail pages
    if (['temperature', 'humidity', 'soil'].includes(pageId)) {
      const typeMap = { temperature: 'temp', humidity: 'hum', soil: 'soil' };
      loadHistorySeries(typeMap[pageId], '1h');
    } else if (pageId === 'history') {
      loadHistorySeries('history', '1h');
    }

    // Close mobile sidebar on nav
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar && overlay) {
      sidebar.classList.remove('open');
      overlay.classList.remove('active');
    }

    // Close user dropdown if open
    const dd = document.getElementById('user-dropdown');
    if (dd) dd.classList.add('hidden');
  }

  // ---------------------------------------------------------------------------
  // Settings & Preferences Controls
  // ---------------------------------------------------------------------------
  async function loadSettings() {
    // 1. Thresholds
    const t = await apiFetch('/api/thresholds');
    if (t) {
      state.thresholds = t;
      document.getElementById('set-temp-min').value = t.tempMin;
      document.getElementById('set-temp-max').value = t.tempMax;
      document.getElementById('set-hum-min').value = t.humMin;
      document.getElementById('set-hum-max').value = t.humMax;
      document.getElementById('set-soil-min').value = t.soilMin;
      document.getElementById('set-soil-max').value = t.soilMax;

      document.getElementById('temp-range-text').textContent = `${t.tempMin}°C – ${t.tempMax}°C`;
      document.getElementById('hum-range-text').textContent = `${t.humMin}% – ${t.humMax}%`;
      document.getElementById('soil-range-text').textContent = `${t.soilMin}% – ${t.soilMax}%`;
    }

    // 2. Ports
    refreshPorts();

    // 3. Status
    const s = await apiFetch('/api/status');
    if (s) updateDeviceStatus(s);

    // 4. Threshold save button
    document.getElementById('save-thresholds-btn').addEventListener('click', async () => {
      const newT = {
        tempMin: parseFloat(document.getElementById('set-temp-min').value) || 15,
        tempMax: parseFloat(document.getElementById('set-temp-max').value) || 35,
        humMin: parseFloat(document.getElementById('set-hum-min').value) || 30,
        humMax: parseFloat(document.getElementById('set-hum-max').value) || 80,
        soilMin: parseFloat(document.getElementById('set-soil-min').value) || 30,
        soilMax: parseFloat(document.getElementById('set-soil-max').value) || 70,
      };

      const res = await apiFetch('/api/thresholds', {
        method: 'POST',
        body: JSON.stringify(newT)
      });

      if (res && res.success) {
        state.thresholds = newT;
        document.getElementById('temp-range-text').textContent = `${newT.tempMin}°C – ${newT.tempMax}°C`;
        document.getElementById('hum-range-text').textContent = `${newT.humMin}% – ${newT.humMax}%`;
        document.getElementById('soil-range-text').textContent = `${newT.soilMin}% – ${newT.soilMax}%`;
        showToast('Threshold preferences saved successfully.', 'success');
      } else {
        showToast('Failed to save thresholds.', 'error');
      }
    });

    // 5. Connect / Disconnect / Demo
    document.getElementById('connect-btn').addEventListener('click', async () => {
      const port = document.getElementById('port-select').value;
      if (!port) {
        showToast('Please select a serial port from the dropdown.', 'warning');
        return;
      }
      const res = await apiFetch('/api/connect', {
        method: 'POST',
        body: JSON.stringify({ port })
      });
      if (res && res.success) {
        showToast(`Connected to Arduino on ${port}`, 'success');
      } else {
        showToast(res ? res.error : 'Connection failed', 'error');
      }
    });

    document.getElementById('disconnect-btn').addEventListener('click', async () => {
      const res = await apiFetch('/api/disconnect', { method: 'POST' });
      if (res && res.success) {
        showToast('Serial device disconnected', 'info');
      }
    });

    document.getElementById('demo-toggle').addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      const res = await apiFetch('/api/demo', {
        method: 'POST',
        body: JSON.stringify({ enabled })
      });
      if (res && res.success) {
        showToast(enabled ? 'Simulation demo mode activated' : 'Demo mode deactivated', 'info');
      }
    });

    document.getElementById('refresh-ports-btn').addEventListener('click', refreshPorts);

    // 6. Sound Toggle
    const soundToggle = document.getElementById('sound-toggle');
    soundToggle.checked = state.soundEnabled;
    soundToggle.addEventListener('change', (e) => {
      state.soundEnabled = e.target.checked;
      localStorage.setItem('mcm_sound', state.soundEnabled);
      showToast(`Audio alerts ${state.soundEnabled ? 'enabled' : 'muted'}`, 'info');
    });

    // 7. Theme
    applyTheme(state.theme);
    document.getElementById('theme-toggle').addEventListener('click', () => {
      const nextTheme = state.theme === 'dark' ? 'light' : 'dark';
      applyTheme(nextTheme);
    });
    document.getElementById('theme-dark-btn').addEventListener('click', () => applyTheme('dark'));
    document.getElementById('theme-light-btn').addEventListener('click', () => applyTheme('light'));

    // 8. Units
    document.getElementById('unit-c-btn').addEventListener('click', () => setUnit('C'));
    document.getElementById('unit-f-btn').addEventListener('click', () => setUnit('F'));
    updateUnitButtons();
  }

  async function refreshPorts() {
    const portSelect = document.getElementById('port-select');
    if (!portSelect) return;
    portSelect.innerHTML = '<option value="">Detecting ports…</option>';

    const ports = await apiFetch('/api/ports');
    portSelect.innerHTML = '<option value="">Select port…</option>';
    if (ports && ports.length > 0) {
      ports.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.path;
        opt.textContent = `${p.path} ${p.manufacturer ? '(' + p.manufacturer + ')' : ''}`;
        portSelect.appendChild(opt);
      });
    } else {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No serial ports detected';
      portSelect.appendChild(opt);
    }
  }

  function applyTheme(theme) {
    state.theme = theme;
    localStorage.setItem('mcm_theme', theme);
    document.documentElement.setAttribute('data-theme', theme);

    const icon = document.querySelector('#theme-toggle i');
    if (icon) {
      icon.className = theme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
    }

    const darkBtn = document.getElementById('theme-dark-btn');
    const lightBtn = document.getElementById('theme-light-btn');
    if (darkBtn && lightBtn) {
      darkBtn.classList.toggle('active', theme === 'dark');
      lightBtn.classList.toggle('active', theme === 'light');
    }
  }

  function setUnit(unit) {
    state.unit = unit;
    localStorage.setItem('mcm_unit', unit);
    updateUnitButtons();
    if (state.latestReading) applyReading(state.latestReading);
    showToast(`Display unit updated to °${unit}`, 'info');
  }

  function updateUnitButtons() {
    const cBtn = document.getElementById('unit-c-btn');
    const fBtn = document.getElementById('unit-f-btn');
    if (cBtn && fBtn) {
      cBtn.classList.toggle('active', state.unit === 'C');
      fBtn.classList.toggle('active', state.unit === 'F');
    }
  }

  // ---------------------------------------------------------------------------
  // Profile & Password Management
  // ---------------------------------------------------------------------------
  async function loadProfile() {
    const me = await apiFetch('/api/me');
    if (me) {
      state.user = me;
      document.getElementById('topbar-username').textContent = me.name || 'User';
      document.getElementById('profile-name').textContent = me.name || 'User';
      document.getElementById('profile-email').textContent = me.email || '';
      if (me.created_at) {
        document.getElementById('profile-since').textContent = new Date(me.created_at).toLocaleDateString([], {
          year: 'numeric', month: 'long', day: 'numeric'
        });
      }
    }

    // Change password handler
    const changeBtn = document.getElementById('change-password-btn');
    if (changeBtn) {
      changeBtn.addEventListener('click', async () => {
        const cur = document.getElementById('current-password').value;
        const n1 = document.getElementById('new-password').value;
        const n2 = document.getElementById('confirm-new-password').value;

        if (!cur || !n1) {
          showToast('Please fill out all password fields.', 'warning');
          return;
        }
        if (n1 !== n2) {
          showToast('New passwords do not match.', 'error');
          return;
        }
        if (n1.length < 6) {
          showToast('New password must be at least 6 characters.', 'error');
          return;
        }

        const res = await apiFetch('/api/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword: cur, newPassword: n1 })
        });

        if (res && res.success) {
          showToast('Password changed successfully!', 'success');
          document.getElementById('current-password').value = '';
          document.getElementById('new-password').value = '';
          document.getElementById('confirm-new-password').value = '';
        } else {
          showToast(res ? res.error : 'Failed to update password.', 'error');
        }
      });
    }

    // Logout triggers
    const doLogout = () => {
      localStorage.removeItem('mcm_token');
      sessionStorage.removeItem('mcm_token');
      window.location.href = '/index.html';
    };

    const l1 = document.getElementById('logout-btn');
    const l2 = document.getElementById('logout-btn-profile');
    if (l1) l1.addEventListener('click', doLogout);
    if (l2) l2.addEventListener('click', doLogout);

    // User dropdown toggle
    const userBtn = document.getElementById('user-menu-btn');
    const userDropdown = document.getElementById('user-dropdown');
    if (userBtn && userDropdown) {
      userBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        userDropdown.classList.toggle('hidden');
      });
      document.addEventListener('click', () => userDropdown.classList.add('hidden'));
    }
  }

  // ---------------------------------------------------------------------------
  // History & Filters Event Listeners
  // ---------------------------------------------------------------------------
  function setupHistoryAndAlertListeners() {
    // Range buttons
    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const chartType = btn.getAttribute('data-chart');
        const range = btn.getAttribute('data-range');

        // Toggle active style in current group
        btn.parentElement.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        loadHistorySeries(chartType, range);
      });
    });

    // Custom date range
    const customBtn = document.getElementById('history-custom-btn');
    if (customBtn) {
      customBtn.addEventListener('click', async () => {
        const start = document.getElementById('history-start').value;
        const end = document.getElementById('history-end').value;
        if (!start || !end) {
          showToast('Please select both start and end dates', 'warning');
          return;
        }

        const data = await apiFetch(`/api/readings?range=custom&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
        if (data) renderHistoryTableAndChart(data);
      });
    }

    // Export CSV
    const exportBtn = document.getElementById('export-csv-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportCSV);

    // Clear alerts
    const clearBtn = document.getElementById('clear-alerts-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (!confirm('Clear all alerts log?')) return;
        const res = await apiFetch('/api/alerts', { method: 'DELETE' });
        if (res && res.success) {
          state.alerts = [];
          state.unreadAlerts = 0;
          updateAlertBadge();
          renderAlerts();
          showToast('Alert log cleared.', 'info');
        }
      });
    }

    // Filter selectors
    const fParam = document.getElementById('alert-filter-param');
    const fSev = document.getElementById('alert-filter-severity');
    if (fParam) fParam.addEventListener('change', renderAlerts);
    if (fSev) fSev.addEventListener('change', renderAlerts);
  }

  // ---------------------------------------------------------------------------
  // Socket.IO Initialization
  // ---------------------------------------------------------------------------
  function initSocket() {
    const socket = io({
      auth: { token }
    });

    socket.on('connect', () => {
      console.log('[Socket.IO] Connected to MicroClimate server');
    });

    socket.on('reading', (data) => {
      applyReading(data);
    });

    socket.on('alert', (alert) => {
      addAlertItem(alert, true);
    });

    socket.on('status', (status) => {
      updateDeviceStatus(status);
    });

    socket.on('disconnect', () => {
      console.warn('[Socket.IO] Disconnected from server');
      updateDeviceStatus({ connected: false, port: null, demoMode: false });
    });

    state.socket = socket;
  }

  // ---------------------------------------------------------------------------
  // Boot Sequence
  // ---------------------------------------------------------------------------
  async function init() {
    setupNavigation();
    initCharts();
    setupHistoryAndAlertListeners();
    await loadProfile();
    await loadSettings();

    // Load initial 1 hour of readings
    const initialReadings = await apiFetch('/api/readings?range=1h');
    if (initialReadings && initialReadings.length > 0) {
      state.liveReadings = initialReadings.slice(-30);
      applyReading(state.liveReadings[state.liveReadings.length - 1]);
    }

    // Load initial alerts
    const initialAlerts = await apiFetch('/api/alerts?limit=50');
    if (initialAlerts && Array.isArray(initialAlerts)) {
      state.alerts = initialAlerts;
      renderAlerts();
    }

    // Connect real-time socket
    initSocket();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
