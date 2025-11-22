// Stato dispositivi e connessione
const devices = new Map(); // id -> { device, name, rssi, angle, radius, lastSeen }
let selectedDeviceId = null;
let bleServer = null;
let bleCharacteristic = null;
let scan = null;
let isScanning = false;

// Radar
const radarCanvas = document.getElementById('radarCanvas');
const ctx = radarCanvas.getContext('2d');
let sweepAngle = 0;
const RADIUS_MARGIN = 20;

// Elementi UI
const elScanStatus = document.getElementById('scanStatus');
const elDeviceCount = document.getElementById('deviceCount');
const elSelectedName = document.getElementById('selectedName');
const elSelectedId = document.getElementById('selectedId');
const elSelectedRssi = document.getElementById('selectedRssi');
const elSelectedLastSeen = document.getElementById('selectedLastSeen');
const elConnectionStatus = document.getElementById('connectionStatus');
const elLastValue = document.getElementById('lastValue');
const elLog = document.getElementById('log');
const inputServiceUuid = document.getElementById('serviceUuid');
const inputCharacteristicUuid = document.getElementById('characteristicUuid');
const inputWriteValue = document.getElementById('writeValue');

const btnStartScan = document.getElementById('btnStartScan');
const btnStopScan = document.getElementById('btnStopScan');
const btnConnect = document.getElementById('btnConnect');
const btnDisconnect = document.getElementById('btnDisconnect');
const btnRead = document.getElementById('btnRead');
const btnWrite = document.getElementById('btnWrite');
const btnClearLog = document.getElementById('btnClearLog');

function log(msg) {
  const line = document.createElement('div');
  line.className = 'log-line';

  const ts = document.createElement('span');
  ts.className = 'log-time';
  ts.textContent = `[${new Date().toLocaleTimeString()}] `;
  line.appendChild(ts);

  line.appendChild(document.createTextNode(msg));
  elLog.appendChild(line);
  elLog.scrollTop = elLog.scrollHeight;
}

function setScanState(active) {
  isScanning = active;
  elScanStatus.textContent = active ? 'In corso' : 'Fermata';
  btnStartScan.disabled = active;
  btnStopScan.disabled = !active;
}

function setConnectionState(connected) {
  elConnectionStatus.textContent = connected ? 'Connesso' : 'Non connesso';
  btnConnect.disabled = !selectedDeviceId || connected;
  btnDisconnect.disabled = !connected;
  btnRead.disabled = !connected;
  btnWrite.disabled = !connected;
}

// Mappa RSSI (-100..-40) -> raggio (dal centro verso l’esterno)
function rssiToRadius(rssi, maxRadius) {
  if (rssi == null) return maxRadius * 0.6;
  const minRssi = -100;
  const maxRssi = -40;
  const clamped = Math.max(minRssi, Math.min(maxRssi, rssi));
  const t = (clamped - minRssi) / (maxRssi - minRssi); // 0..1
  const minR = maxRadius * 0.2;
  const maxR = maxRadius;
  return minR + t * (maxR - minR);
}

function formatLastSeen(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 2000) return 'adesso';
  if (diff < 60000) return `${Math.round(diff / 1000)}s fa`;
  const m = Math.round(diff / 60000);
  return `${m} min fa`;
}

// Disegno del radar
function drawRadar() {
  const w = radarCanvas.width;
  const h = radarCanvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const maxRadius = Math.min(cx, cy) - RADIUS_MARGIN;

  ctx.clearRect(0, 0, w, h);

  // sfondo
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, w, h);

  // cerchi concentrici
  ctx.strokeStyle = 'rgba(34, 197, 94, 0.4)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (maxRadius / 4) * i, 0, Math.PI * 2);
    ctx.stroke();
  }

  // linee incroci
  ctx.beginPath();
  ctx.moveTo(cx - maxRadius, cy);
  ctx.lineTo(cx + maxRadius, cy);
  ctx.moveTo(cx, cy - maxRadius);
  ctx.lineTo(cx, cy + maxRadius);
  ctx.stroke();

  // sweep
  const sweepGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxRadius);
  sweepGradient.addColorStop(0, 'rgba(34, 197, 94, 0.0)');
  sweepGradient.addColorStop(1, 'rgba(34, 197, 94, 0.4)');
  ctx.fillStyle = sweepGradient;

  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.arc(cx, cy, maxRadius, sweepAngle, sweepAngle + Math.PI / 12);
  ctx.closePath();
  ctx.fill();

  sweepAngle += 0.03;
  if (sweepAngle > Math.PI * 2) sweepAngle -= Math.PI * 2;

  // disegna dispositivi
  const now = Date.now();
  devices.forEach((info, id) => {
    // fading se vecchio
    const age = now - info.lastSeen;
    let alpha = 1.0;
    if (age > 15000) alpha = 0.2;
    else if (age > 5000) alpha = 0.5;

    const r = rssiToRadius(info.rssi, maxRadius);
    const x = cx + Math.cos(info.angle) * r;
    const y = cy + Math.sin(info.angle) * r;

    // alone
    ctx.beginPath();
    ctx.strokeStyle = `rgba(34, 197, 94, ${alpha * 0.35})`;
    ctx.lineWidth = 1;
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.stroke();

    // punto centrale
    ctx.beginPath();
    const isSelected = id === selectedDeviceId;
    ctx.fillStyle = isSelected
      ? `rgba(248, 250, 252, ${alpha})`
      : `rgba(34, 197, 94, ${alpha})`;
    ctx.arc(x, y, isSelected ? 5 : 4, 0, Math.PI * 2);
    ctx.fill();

    // nome abbreviato
    ctx.font = '10px system-ui';
    ctx.fillStyle = 'rgba(209, 213, 219, 0.9)';
    ctx.textAlign = 'center';
    ctx.fillText((info.name || 'Sconosciuto').slice(0, 10), x, y - 12);

    // salva coordinate per click hit-test
    info.screenX = x;
    info.screenY = y;
  });

  requestAnimationFrame(drawRadar);
}

// click sul radar per selezionare dispositivo
radarCanvas.addEventListener('click', (e) => {
  const rect = radarCanvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;

  let closestId = null;
  let closestDist = Infinity;

  devices.forEach((info, id) => {
    if (info.screenX == null) return;
    const dx = x - info.screenX;
    const dy = y - info.screenY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 20 && dist < closestDist) {
      closestDist = dist;
      closestId = id;
    }
  });

  if (closestId) {
    selectDevice(closestId);
  }
});

function selectDevice(id) {
  selectedDeviceId = id;
  const info = devices.get(id);
  if (!info) return;

  elSelectedName.textContent = info.name || 'Sconosciuto';
  elSelectedId.textContent = info.device.id;
  elSelectedRssi.textContent = info.rssi != null ? info.rssi + ' dBm' : '—';
  elSelectedLastSeen.textContent = formatLastSeen(info.lastSeen);

  log(`📡 Dispositivo selezionato: ${info.name || 'Sconosciuto'} (${info.device.id})`);

  setConnectionState(!!(bleServer && bleServer.connected));
}

// Scansione BLE
async function startScan() {
  if (!navigator.bluetooth || !navigator.bluetooth.requestLEScan) {
    alert('Il browser non supporta requestLEScan (Web Bluetooth avanzato). Usa Chrome/Android e abilita le funzioni sperimentali.');
    log('❌ requestLEScan non supportato dal browser.');
    return;
  }

  try {
    log('🚀 Avvio scansione BLE…');
    devices.clear();
    elDeviceCount.textContent = '0';

    scan = await navigator.bluetooth.requestLEScan({
      acceptAllAdvertisements: true
      // puoi filtrare: filters: [{ namePrefix: 'ESP' }]
    });

    navigator.bluetooth.addEventListener('advertisementreceived', onAdvertisement);
    setScanState(true);
  } catch (err) {
    log('❌ Errore avvio scansione: ' + err);
  }
}

async function stopScan() {
  if (scan && scan.active) {
    scan.stop();
    log('🛑 Scansione fermata.');
  }
  setScanState(false);
}

function onAdvertisement(event) {
  const id = event.device.id;
  let info = devices.get(id);

  if (!info) {
    const angle = Math.random() * Math.PI * 2;
    info = {
      device: event.device,
      name: event.device.name || 'Sconosciuto',
      rssi: event.rssi ?? null,
      angle,
      radius: 0,
      lastSeen: Date.now()
    };
    devices.set(id, info);
    elDeviceCount.textContent = String(devices.size);
    log(`📡 Nuovo dispositivo: ${info.name} (RSSI: ${info.rssi ?? 'n/d'})`);
  } else {
    info.name = event.device.name || info.name;
    info.rssi = event.rssi ?? info.rssi;
    info.lastSeen = Date.now();
  }

  if (selectedDeviceId === id) {
    elSelectedRssi.textContent = info.rssi != null ? info.rssi + ' dBm' : '—';
    elSelectedLastSeen.textContent = formatLastSeen(info.lastSeen);
  }
}

// Connessione al dispositivo selezionato
async function connectToSelected() {
  if (!selectedDeviceId) {
    log('⚠️ Nessun dispositivo selezionato.');
    return;
  }

  const info = devices.get(selectedDeviceId);
  if (!info) {
    log('⚠️ Dispositivo non trovato in mappa.');
    return;
  }

  try {
    log('🔗 Connessione al dispositivo: ' + (info.name || 'Sconosciuto'));
    bleServer = await info.device.gatt.connect();
    log('✅ GATT server connesso.');
    setConnectionState(true);
  } catch (err) {
    log('❌ Errore connessione: ' + err);
  }
}

function disconnectFromDevice() {
  if (bleServer && bleServer.connected) {
    log('🔌 Disconnessione dal dispositivo…');
    bleServer.disconnect();
  } else {
    log('ℹ️ Nessuna connessione attiva.');
  }
  bleServer = null;
  bleCharacteristic = null;
  setConnectionState(false);
}

// Lettura caratteristica
async function readCharacteristic() {
  if (!bleServer || !bleServer.connected) {
    log('⚠️ Non connesso a nessun dispositivo.');
    return;
  }

  const serviceUuid = inputServiceUuid.value.trim();
  const characteristicUuid = inputCharacteristicUuid.value.trim();

  if (!serviceUuid || !characteristicUuid) {
    log('⚠️ Inserisci serviceUUID e characteristicUUID.');
    return;
  }

  try {
    log(`🔍 Ricerca servizio: ${serviceUuid}`);
    const service = await bleServer.getPrimaryService(serviceUuid);

    log(`🔍 Ricerca caratteristica: ${characteristicUuid}`);
    bleCharacteristic = await service.getCharacteristic(characteristicUuid);

    log('📥 Lettura valore…');
    const value = await bleCharacteristic.readValue();

    const bytes = [];
    for (let i = 0; i < value.byteLength; i++) {
      bytes.push(value.getUint8(i));
    }

    log('✅ Valore letto (byte): ' + bytes.join(' '));

    // prova interpretazione
    if (bytes.length === 1) {
      elLastValue.textContent = bytes[0] + ' (singolo byte)';
    } else {
      const decoder = new TextDecoder('utf-8');
      const str = decoder.decode(value.buffer);
      elLastValue.textContent = str + ` (raw: ${bytes.join(' ')})`;
    }
  } catch (err) {
    log('❌ Errore lettura: ' + err);
  }
}

// Scrittura caratteristica (invio comando)
async function writeCharacteristic() {
  if (!bleServer || !bleServer.connected) {
    log('⚠️ Non connesso a nessun dispositivo.');
    return;
  }

  const serviceUuid = inputServiceUuid.value.trim();
  const characteristicUuid = inputCharacteristicUuid.value.trim();
  const text = inputWriteValue.value;

  if (!serviceUuid || !characteristicUuid) {
    log('⚠️ Inserisci serviceUUID e characteristicUUID.');
    return;
  }
  if (!text) {
    log('⚠️ Nessun dato da inviare.');
    return;
  }

  try {
    if (!bleCharacteristic) {
      log(`🔍 Ricerca servizio: ${serviceUuid}`);
      const service = await bleServer.getPrimaryService(serviceUuid);

      log(`🔍 Ricerca caratteristica: ${characteristicUuid}`);
      bleCharacteristic = await service.getCharacteristic(characteristicUuid);
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    log(`📤 Scrittura: "${text}" (byte: ${Array.from(data).join(' ')})`);
    await bleCharacteristic.writeValue(data);
    log('✅ Comando inviato.');
  } catch (err) {
    log('❌ Errore scrittura: ' + err);
  }
}

// Event listeners
btnStartScan.addEventListener('click', startScan);
btnStopScan.addEventListener('click', stopScan);
btnConnect.addEventListener('click', connectToSelected);
btnDisconnect.addEventListener('click', disconnectFromDevice);
btnRead.addEventListener('click', readCharacteristic);
btnWrite.addEventListener('click', writeCharacteristic);
btnClearLog.addEventListener('click', () => (elLog.innerHTML = ''));

// Avvia animazione radar
requestAnimationFrame(drawRadar);
