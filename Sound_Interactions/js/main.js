import * as THREE from 'three';
import { GPUComputationRenderer } from './vendor/GPUComputationRenderer.js';
import { initMidiPlayer } from './midi-player.js';

(function () {
  const GRID_COLS = 12;
  const GRID_ROWS = 3;
  const COL_TO_SEMITONE = [0, 0, 2, 4, 5, 7, 7, 9, 11, 11, 0, 0];
  const NATURAL_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

  function snapToNatural(midi) {
    const oct = Math.floor(midi / 12);
    const s = midi % 12;
    const nearest = NATURAL_SEMITONES.reduce((a, b) => Math.abs(s - a) < Math.abs(s - b) ? a : b);
    return oct * 12 + nearest;
  }

  function cellToMidi(col, row) {
    return 48 + (2 - row) * 12 + COL_TO_SEMITONE[col];
  }
  function midiToCell(midi) {
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const row = Math.max(0, Math.min(2, 2 - Math.floor((m - 48) / 12)));
    const st = ((m % 12) + 12) % 12;
    return { col: st, row };
  }
  function getCellFromMouse(clientX, clientY) {
    const w = window.innerWidth, h = window.innerHeight;
    const col = Math.floor((clientX / w) * GRID_COLS);
    const row = Math.floor((clientY / h) * GRID_ROWS);
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return null;
    return { col, row };
  }
  function cellToPosition3D(col, row) {
    const x = ((col + 0.5) / GRID_COLS) * 3 - 1.5;
    const y = 0.6 - (row + 0.5) / GRID_ROWS * 1.2;
    return { x, y, z: 0 };
  }
  const TAU = Math.PI * 2;
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  // --- Shared particle utilities ---
  function lorenzStep(x, y, z, sigma, rho, beta, dt) {
    const dx = sigma * (y - x);
    const dy = x * (rho - z) - y;
    const dz = x * y - beta * z;
    return { x: x + dx * dt, y: y + dy * dt, z: z + dz * dt };
  }
  function curlNoise3D(x, y, z, t) {
    const e = 0.1;
    const n1 = Math.sin(x * 1.3 + t) * Math.cos(z * 0.9 + t * 0.7);
    const n2 = Math.sin(y * 1.1 + t * 0.8) * Math.cos(x * 0.8 + t * 0.5);
    const n3 = Math.sin(z * 1.2 + t * 0.6) * Math.cos(y * 1.0 + t * 0.9);
    return {
      x: (Math.sin((y + e) * 1.1 + t * 0.8) * Math.cos((x) * 0.8 + t * 0.5) - n2) / e -
         (Math.sin((z + e) * 1.2 + t * 0.6) * Math.cos((y) * 1.0 + t * 0.9) - n3) / e,
      y: (Math.sin((z + e) * 1.2 + t * 0.6) * Math.cos((y) * 1.0 + t * 0.9) - n3) / e -
         (Math.sin((x + e) * 1.3 + t) * Math.cos((z) * 0.9 + t * 0.7) - n1) / e,
      z: (Math.sin((x + e) * 1.3 + t) * Math.cos((z) * 0.9 + t * 0.7) - n1) / e -
         (Math.sin((y + e) * 1.1 + t * 0.8) * Math.cos((x) * 0.8 + t * 0.5) - n2) / e
    };
  }
  // Per-particle state arrays for physics-based systems
  let burstVelocities = null, burstAges = null, burstPhase = -10;
  let floatVelocities = null;
  let emberVelocities = null, emberAges = null, emberTemps = null;
  // Neural wave propagation state
  let neuralWaveFront = -10;
  // Crystal branch state
  let crystalBranchLen = null, crystalBranchPhase = null;

  function smoothApproach(current, target, attack, release) {
    const t = target > current ? attack : release;
    return current + (target - current) * t;
  }
  function softCap(v, cap) {
    if (v <= 0) return 0;
    return (v * cap) / (v + cap);
  }
  function circularHueMean(hues) {
    if (!hues || hues.length === 0) return 0.55;
    let sx = 0, sy = 0;
    for (let i = 0; i < hues.length; i++) {
      const a = hues[i] * TAU;
      sx += Math.cos(a);
      sy += Math.sin(a);
    }
    let ang = Math.atan2(sy, sx) / TAU;
    if (ang < 0) ang += 1;
    return ang;
  }
  function blendProfiles(profiles, keyCount, chordStep) {
    if (!profiles || profiles.length === 0) return null;
    const w = 1 / profiles.length;
    let bFolds = 0, bBloom = 0, bCa = 0, bSpiral = 0, bFlow = 0, bPulse = 0, bPrism = 0;
    let bBio = 0, bRot = 0;
    let bIn = 0, bOut = 0;
    let bShear = 0, bWave = 0, bGlitch = 0, bWarp = 0, bContrast = 0;
    let bMxScore = 0, bMyScore = 0;
    const hues = [];
    profiles.forEach(p => {
      bFolds += p.folds * w;
      bBloom += p.bloom * w;
      bCa += p.ca * w;
      bSpiral += (p.spiral || 0) * w;
      bFlow += (p.flow || 0) * w;
      bPulse += (p.pulse || 0) * w;
      bPrism += (p.prism || 0.62) * w;
      bBio += (p.bio != null ? p.bio : 0.35) * w;
      bRot += (p.rot || 0) * w;
      bIn += (p.in != null ? p.in : 0.56) * w;
      bOut += (p.out != null ? p.out : 0.26) * w;
      bShear += (p.shear || 0) * w;
      bWave += (p.wave || 0) * w;
      bGlitch += p.glitch * w;
      bWarp += p.warp * w;
      bContrast += p.contrast * w;
      bMxScore += (p.mx ? 1 : 0) * w;
      bMyScore += (p.my ? 1 : 0) * w;
      hues.push(p.hue);
    });
    const chordBoost = 1 + Math.max(0, keyCount - 1) * chordStep;
    const spiral = softCap(bSpiral * chordBoost, 0.88);
    const flow = softCap(bFlow * chordBoost, 1.45);
    const pulse = softCap(bPulse * chordBoost, 1.5);
    const shear = softCap(bShear * chordBoost, 1.45);
    const wave = softCap(bWave * chordBoost, 1.45);
    const glitch = softCap(bGlitch * chordBoost, 1.18);
    const warp = softCap(bWarp * chordBoost, 1.38);
    return {
      folds: bFolds,
      bloom: bBloom * chordBoost,
      ca: Math.min(0.014, bCa * chordBoost * 0.68),
      spiral,
      flow,
      pulse,
      shear,
      wave,
      glitch,
      warp,
      prism: softCap(bPrism * (1 + Math.max(0, keyCount - 1) * 0.06), 1.08),
      bio: softCap(bBio * (1 + Math.max(0, keyCount - 1) * 0.04), 1.05),
      rot: Math.max(-1, Math.min(1, bRot * (1 + Math.max(0, keyCount - 1) * 0.08))),
      contrast: Math.min(2.85, bContrast * chordBoost),
      in: Math.min(0.9, bIn + Math.max(0, keyCount - 1) * 0.02),
      out: Math.min(0.64, bOut + Math.max(0, keyCount - 1) * 0.016),
      mx: bMxScore > 0.44 ? 1 : 0,
      my: bMyScore > 0.44 ? 1 : 0,
      hue: circularHueMean(hues)
    };
  }
  const LAYER_GROUPS = {
    tunnel: [0, 5, 8],
    vertical: [1, 5, 9],
    central: [2, 9],
    radiate: [3, 8],
    speed: [4, 10],
    plasma: [6, 10, 11],
    float: [7, 11]
  };
  function computeLayerWeights(activeCols, fallbackCol, str, isKeyActive) {
    const cols = activeCols && activeCols.length ? activeCols : [fallbackCol];
    const count = cols.length;
    const raw = { tunnel: 0, vertical: 0, central: 0, radiate: 0, speed: 0, plasma: 0, float: 0 };
    const keys = Object.keys(raw);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const group = LAYER_GROUPS[k];
      let hit = 0;
      for (let j = 0; j < cols.length; j++) if (group.includes(cols[j])) hit++;
      const density = Math.pow(hit / Math.max(1, count), 0.82);
      const base = isKeyActive ? (0.18 + str * 1.02) : (0.08 + str * 0.36);
      raw[k] = Math.max(0, Math.min(1, density * base));
    }
    // Keep only the strongest layer families so chords stay organized and readable.
    raw.central *= 1.16;
    raw.tunnel *= 1.08;
    raw.radiate *= 1.05;
    raw.float *= 0.82;
    const ranked = Object.entries(raw).sort((a, b) => b[1] - a[1]);
    const out = { tunnel: 0, vertical: 0, central: 0, radiate: 0, speed: 0, plasma: 0, float: 0 };
    const keep = count >= 4 ? 3 : 2;
    const gain = isKeyActive ? [1.0, 0.74, 0.52] : [0.64, 0.42, 0.28];
    for (let i = 0; i < keep && i < ranked.length; i++) {
      const key = ranked[i][0];
      out[key] = ranked[i][1] * gain[i];
    }
    return out;
  }
  const STYLE_COL_MAP = ['museum', 'lsd', 'museum', 'lsd', 'museum', 'lsd', 'lsd', 'museum', 'lsd', 'museum', 'lsd', 'museum'];
  function styleFromCol(col) {
    const idx = ((col % GRID_COLS) + GRID_COLS) % GRID_COLS;
    return STYLE_COL_MAP[idx];
  }
  function styleBlendFromCols(cols, fallbackCol) {
    const arr = cols && cols.length ? cols : [fallbackCol];
    let museum = 0;
    let lsd = 0;
    for (let i = 0; i < arr.length; i++) {
      if (styleFromCol(arr[i]) === 'museum') museum++;
      else lsd++;
    }
    const total = Math.max(1, arr.length);
    const museumRatio = museum / total;
    const lsdRatio = lsd / total;
    const balance = 1.0 - Math.abs(museumRatio - lsdRatio);
    // Cross when styles interleave: higher for mixed chords than single-style blocks.
    let interleave = 0;
    if (arr.length > 1) {
      for (let i = 1; i < arr.length; i++) {
        if (styleFromCol(arr[i]) !== styleFromCol(arr[i - 1])) interleave++;
      }
      interleave /= (arr.length - 1);
    }
    return {
      museum: museumRatio,
      lsd: lsdRatio,
      crossover: Math.max(balance * 0.75, interleave * 0.95)
    };
  }

  function pushRollImpulse(midi, velocity, srcTag) {
    const t = performance.now() * 0.001;
    rollImpulses.push({
      midi: Math.max(0, Math.min(127, Math.round(midi))),
      velocity: clamp01(velocity != null ? velocity : 0.8),
      t,
      src: srcTag || 'K'
    });
    if (rollImpulses.length > 280) rollImpulses.splice(0, rollImpulses.length - 280);
  }
  function pushRollDrumImpulse(typeOrIndex, velocity, srcTag) {
    const idx = typeof typeOrIndex === 'number'
      ? Math.max(0, Math.min(11, Math.round(typeOrIndex)))
      : drumTypeToVisualIndex(typeOrIndex);
    const t = performance.now() * 0.001;
    rollDrumImpulses.push({
      idx,
      velocity: clamp01(velocity != null ? velocity : 0.9),
      t,
      src: srcTag || 'D'
    });
    if (rollDrumImpulses.length > 240) rollDrumImpulses.splice(0, rollDrumImpulses.length - 240);
  }

  function rollTrackPitchColor(outColor, trackIndex, midi, velocity, activeHue) {
    // Premium unified palette: electric blue → cyan → white, pitch-driven.
    // Each track shifts hue only ±10° within cool blue-cyan band (no rainbow).
    const vel = clamp01(velocity != null ? velocity : 0.8);
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const trackHue = (0.54 + ((trackIndex | 0) * 0.018) % 0.12 + activeHue * 0.04 + 1.0) % 1.0;
    const pitchNorm = m / 127;
    const s = Math.max(0.0, 0.90 - pitchNorm * 0.55); // high pitch fades to white
    const l = Math.min(0.96, 0.38 + pitchNorm * 0.44 + vel * 0.10);
    outColor.setHSL(trackHue, s, l);
    return outColor;
  }

  function updateRoll3DLayer(now, syncA, syncB, impactFlash, activeHue, kickFlash, drumFlash, drumTypes, headYaw, headPitch) {
    kickFlash = kickFlash || 0;
    drumFlash = drumFlash || 0;
    drumTypes = drumTypes || {};
    if (!roll3DGroup || !roll3DSurfaces || !roll3DGlowSurfaces || !roll3DQuads || !roll3DLines || !roll3DPoints) return;
    const preview = Array.isArray(midiRollPreview) ? midiRollPreview : [];
    const activeOrdered = collectOrderedActiveNotes();
    rollImpulses = rollImpulses.filter((e) => (now - e.t) <= 2.6);
    rollDrumImpulses = rollDrumImpulses.filter((e) => (now - e.t) <= 2.2);

    const melodicPreview = [];
    const drumPreview = [];
    // Fixed MIDI range for stable pitch mapping (no per-frame jitter).
    const midiMin = 24;
    const midiMax = 108;
    for (let i = 0; i < preview.length; i++) {
      const n = preview[i];
      if (n.isDrum) {
        drumPreview.push(n);
        continue;
      }
      melodicPreview.push(n);
    }

    const span = midiMax - midiMin + 1;
    const nearZ = 2.7;
    const farZ = -6.9;
    const depthSpan = nearZ - farZ;
    // Show exactly 4 bars ahead — tight, impactful window.
    const bpm4bar = Math.max(40, midiSourceBpm || 120);
    const windowSec = Math.max(3.0, (60 / bpm4bar) * 16 / Math.max(0.72, midiPlaybackSpeed));
    const yBase = -0.08;
    const MAX_VIS_TRACKS = 12;
    // Build track order first so polygon adapts: N tracks → N-gon.
    const trackDensity = new Map();
    for (let i = 0; i < melodicPreview.length; i++) {
      const t = melodicPreview[i].trackIndex | 0;
      trackDensity.set(t, (trackDensity.get(t) || 0) + 1);
    }
    for (let i = 0; i < drumPreview.length; i++) {
      const t = drumPreview[i].trackIndex | 0;
      trackDensity.set(t, (trackDensity.get(t) || 0) + 1);
    }
    const trackOrder = Array.from(trackDensity.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_VIS_TRACKS)
      .map((p) => p[0]);
    if (!trackOrder.length) trackOrder.push(0);
    const visibleTrackSet = new Set(trackOrder);
    const trackSlotMap = new Map();
    for (let i = 0; i < trackOrder.length; i++) trackSlotMap.set(trackOrder[i], i);
    // Dynamic polygon: 5 tracks → pentagon, 10 → decagon, etc.
    const WEB_SPOKES = Math.max(3, trackOrder.length);
    const WEB_RINGS = 10;
    // Static web rotation for frame-stable clip geometry.
    const webRot = 0;
    const webNearRadius = 2.0 + clamp01(syncA) * 0.22 + impactFlash * 0.14;

    function depthNormAtAhead(ahead) {
      return clamp01(ahead / windowSec);
    }
    function webPoint(spokeFloat, depthN, radiusScale) {
      const dn = clamp01(depthN);
      const farEase = Math.pow(dn, 1.08);
      const near = 1.0 - farEase;
      const ang = ((spokeFloat % WEB_SPOKES + WEB_SPOKES) % WEB_SPOKES) / WEB_SPOKES * TAU + webRot;
      const radius = 0.03 + webNearRadius * Math.max(0.3, radiusScale) * Math.pow(near, 0.88);
      return {
        x: Math.cos(ang) * radius,
        y: yBase + Math.sin(ang) * radius * 0.62 + near * 0.05,
        z: nearZ - farEase * depthSpan,
        near,
        farEase
      };
    }
    function trackSlotFor(trackIndex) {
      const t = trackIndex | 0;
      if (trackSlotMap.has(t)) return trackSlotMap.get(t);
      return 0;
    }
    function trackCorridor(trackIndex) {
      const slot = trackSlotFor(trackIndex);
      // Each track = one polygon face (spoke slot → slot+1, wraps via webPoint).
      return { slot, leftSpoke: slot, rightSpoke: slot + 1 };
    }
    function noteLane(midi, trackIndex) {
      const m = Math.max(midiMin, Math.min(midiMax, midi));
      const corridor = trackCorridor(trackIndex);
      const pitchNorm = clamp01((m - midiMin) / Math.max(1, midiMax - midiMin));
      return {
        leftSpoke: corridor.leftSpoke,
        rightSpoke: corridor.rightSpoke,
        centerSpoke: corridor.leftSpoke + 0.5,
        radiusScale: 1.0,
        laneNorm: pitchNorm * 2.0 - 1.0,
        trackSlot: corridor.slot
      };
    }
    function drumLane(idx, trackIndex) {
      const lane = Math.max(0, Math.min(11, idx | 0));
      const corridor = trackCorridor(trackIndex != null ? trackIndex : 0);
      const faceNorm = (lane + 0.5) / 12;
      return {
        spoke: corridor.leftSpoke + faceNorm,
        radiusScale: 1.08 + (lane % 3) * 0.05
      };
    }
    function pushLine(arr, idxRef, x1, y1, z1, x2, y2, z2) {
      if (idxRef.i + 6 > arr.length) return false;
      arr[idxRef.i++] = x1; arr[idxRef.i++] = y1; arr[idxRef.i++] = z1;
      arr[idxRef.i++] = x2; arr[idxRef.i++] = y2; arr[idxRef.i++] = z2;
      return true;
    }
    function pushStrongLine(arr, idxRef, x1, y1, z1, x2, y2, z2) {
      if (!pushLine(arr, idxRef, x1, y1, z1, x2, y2, z2)) return false;
      return pushLine(arr, idxRef, x1, y1, z1, x2, y2, z2);
    }
    // Glow line: semi-transparent quad strip behind a line — fakes soft bloom.
    function pushGlowLine(posArr, colArr, idxRef, x1, y1, z1, x2, y2, z2, r, g, b, width) {
      const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-6) return false;
      // Perpendicular in screen-ish plane (cross with view direction ~Z)
      const px = -dy, py = dx;
      const pLen = Math.sqrt(px * px + py * py) || 1;
      const hw = width * 0.5;
      const nx = (px / pLen) * hw, ny = (py / pLen) * hw;
      return pushQuadRaw(posArr, colArr, idxRef,
        x1 - nx, y1 - ny, z1 - 0.003,
        x1 + nx, y1 + ny, z1 - 0.003,
        x2 + nx, y2 + ny, z2 - 0.003,
        x2 - nx, y2 - ny, z2 - 0.003,
        r, g, b);
    }
    function pushPoint(posArr, colArr, idxRef, x, y, z, r, g, b) {
      if ((idxRef.i + 1) * 3 > posArr.length) return false;
      const p = idxRef.i * 3;
      posArr[p] = x; posArr[p + 1] = y; posArr[p + 2] = z;
      colArr[p] = r; colArr[p + 1] = g; colArr[p + 2] = b;
      idxRef.i++;
      return true;
    }
    function pushQuadRaw(posArr, colArr, idxRef, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
      if ((idxRef.i + 6) * 3 > posArr.length) return false;
      let p = idxRef.i * 3;
      posArr[p]=ax; posArr[p+1]=ay; posArr[p+2]=az; colArr[p]=r; colArr[p+1]=g; colArr[p+2]=b; p+=3;
      posArr[p]=bx; posArr[p+1]=by; posArr[p+2]=bz; colArr[p]=r; colArr[p+1]=g; colArr[p+2]=b; p+=3;
      posArr[p]=cx; posArr[p+1]=cy; posArr[p+2]=cz; colArr[p]=r; colArr[p+1]=g; colArr[p+2]=b; p+=3;
      posArr[p]=ax; posArr[p+1]=ay; posArr[p+2]=az; colArr[p]=r; colArr[p+1]=g; colArr[p+2]=b; p+=3;
      posArr[p]=cx; posArr[p+1]=cy; posArr[p+2]=cz; colArr[p]=r; colArr[p+1]=g; colArr[p+2]=b; p+=3;
      posArr[p]=dx; posArr[p+1]=dy; posArr[p+2]=dz; colArr[p]=r; colArr[p+1]=g; colArr[p+2]=b;
      idxRef.i += 6;
      return true;
    }

    const dummy = updateRoll3DLayer._dummy || (updateRoll3DLayer._dummy = new THREE.Object3D());
    const colTmp = updateRoll3DLayer._col || (updateRoll3DLayer._col = new THREE.Color());
    const dirTmp = updateRoll3DLayer._dir || (updateRoll3DLayer._dir = new THREE.Vector3());
    const sideTmp = updateRoll3DLayer._side || (updateRoll3DLayer._side = new THREE.Vector3());
    const upTmp = updateRoll3DLayer._up || (updateRoll3DLayer._up = new THREE.Vector3());
    const axisY = updateRoll3DLayer._axisY || (updateRoll3DLayer._axisY = new THREE.Vector3(0, 1, 0));
    const axisX = updateRoll3DLayer._axisX || (updateRoll3DLayer._axisX = new THREE.Vector3(1, 0, 0));
    const axisZ = updateRoll3DLayer._axisZ || (updateRoll3DLayer._axisZ = new THREE.Vector3(0, 0, 1));
    const basisMat = updateRoll3DLayer._basisMat || (updateRoll3DLayer._basisMat = new THREE.Matrix4());
    const quatTmp = updateRoll3DLayer._quat || (updateRoll3DLayer._quat = new THREE.Quaternion());
    let instCount = 0;
    const lineV = { i: 0 };
    const quadV = { i: 0 };
    const pointV = { i: 0 };

    // Near-face polygon: the primary structural frame + breathing glow.
    const breathPhase = Math.sin(now * 0.62) * 0.5 + 0.5;
    const glowPulse = 0.022 + breathPhase * 0.014 + clamp01(syncA) * 0.020 + impactFlash * 0.035;
    for (let s = 0; s < WEB_SPOKES; s++) {
      const pa = webPoint(s, 0, 1.0);
      const pb = webPoint((s + 1) % WEB_SPOKES, 0, 1.0);
      pushStrongLine(roll3DLinePosArray, lineV, pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
      // Inner glow: luminous core hue
      const edgeHue = (activeHue + s / WEB_SPOKES * 0.10 + now * 0.022) % 1;
      colTmp.setHSL(edgeHue, 0.32, 0.90);
      pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
        pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
        colTmp.r * glowPulse, colTmp.g * glowPulse, colTmp.b * glowPulse, 0.032);
      // Outer halo: wide soft color bloom — saturated, not white
      const outerGlow = glowPulse * 0.28;
      colTmp.setHSL(edgeHue, 0.42, 0.78);
      pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
        pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
        colTmp.r * outerGlow, colTmp.g * outerGlow, colTmp.b * outerGlow, 0.08);
    }
    // Two receding depth rings — layered parallax feel with soft glow.
    const depthRings = [0.32, 0.68];
    for (let ri = 0; ri < depthRings.length; ri++) {
      const ringFade = 1.0 - ri * 0.35;
      for (let s = 0; s < WEB_SPOKES; s++) {
        const pa = webPoint(s, depthRings[ri], 1.0);
        const pb = webPoint((s + 1) % WEB_SPOKES, depthRings[ri], 1.0);
        pushLine(roll3DLinePosArray, lineV, pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
        // Soft depth glow
        const dGlow = glowPulse * 0.22 * ringFade;
        colTmp.setHSL((activeHue + 0.04 + ri * 0.06) % 1, 0.22, 0.90);
        pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
          pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
          colTmp.r * dGlow, colTmp.g * dGlow, colTmp.b * dGlow, 0.04);
      }
    }
    // === VERTEX PRISM: refined optical dispersion — fewer bands, desaturated, precise ===
    const ringPulse = 0.36 + breathPhase * 0.12 + clamp01(syncA) * 0.28 + impactFlash * 0.18;
    const dispBase  = 0.008 + Math.sin(now * 0.72) * 0.003 + clamp01(syncA) * 0.012 + impactFlash * 0.008;
    const SPECN = 4; // fewer bands = more optical, less circus

    for (let s = 0; s < WEB_SPOKES; s++) {
      const pPrev = webPoint((s - 1 + WEB_SPOKES) % WEB_SPOKES, 0, 1.0);
      const pCur  = webPoint(s, 0, 1.0);
      const pNext = webPoint((s + 1) % WEB_SPOKES, 0, 1.0);
      const tx = (pNext.x - pPrev.x) * 0.5, ty = (pNext.y - pPrev.y) * 0.5;
      const tLen = Math.sqrt(tx * tx + ty * ty) || 1;
      const tnx = tx / tLen, tny = ty / tLen;
      const iridAnim = 1.0 + 0.22 * Math.sin(now * 1.6 + s * 1.2);

      for (let b = 0; b < SPECN; b++) {
        const chrOff   = (0.5 - b / (SPECN - 1)) * dispBase * 5.0 * iridAnim;
        const bandHue  = ((b / SPECN) + now * 0.10 + s / WEB_SPOKES * 0.25) % 1;
        // Desaturated — optical glass look, not neon
        colTmp.setHSL(bandHue, 0.55, 0.78);
        const lum = ringPulse * (0.55 + 0.25 * Math.sin(b * 1.2 + now * 1.4 + s * 0.7));
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          pCur.x + tnx * chrOff, pCur.y + tny * chrOff, pCur.z,
          colTmp.r * lum, colTmp.g * lum, colTmp.b * lum);
        // Ghost at depth — faint echo
        const pD    = webPoint(s, 0.12, 1.0);
        const gFade = lum * 0.32;
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          pD.x + tnx * chrOff * 1.2, pD.y + tny * chrOff * 1.2, pD.z,
          colTmp.r * gFade, colTmp.g * gFade, colTmp.b * gFade);
      }
      // Vertex core: bright but hue-tinted, not pure white
      const corePulse = ringPulse * (0.65 + 0.10 * Math.sin(now * 2.2 + s * 0.8));
      colTmp.setHSL((activeHue + s / WEB_SPOKES * 0.06) % 1, 0.30, 0.82);
      pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
        pCur.x, pCur.y, pCur.z, colTmp.r * corePulse, colTmp.g * corePulse, colTmp.b * corePulse);
    }
    // === AMBIENT HALO: 16 coherent particles — tighter orbit, desaturated ===
    const haloN = 16;
    for (let a = 0; a < haloN; a++) {
      const af      = a / haloN;
      const spokeF  = af * WEB_SPOKES;
      const breathe = 0.015 + 0.025 * Math.sin(now * 0.55 + a * 0.62);
      const depN    = 0.008 + 0.032 * Math.abs(Math.sin(now * 0.32 + a * 0.91));
      const pBase   = webPoint(spokeF, depN, 1.0 + breathe);
      const hue     = (activeHue + af * 0.18 + now * 0.025) % 1;
      const lum     = (0.18 + 0.14 * Math.sin(now * 0.82 + a * 1.5)) * ringPulse;
      // Very desaturated — more like light refraction than colored orbs
      colTmp.setHSL(hue, 0.35, 0.80);
      pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
        pBase.x, pBase.y, pBase.z,
        colTmp.r * lum, colTmp.g * lum, colTmp.b * lum);
    }

    // === KICK CONTOUR: topographic rings expanding outward, center distortion ===
    // Like zooming into a contour map — concentric elevation lines with chromatic center.
    if (kickFlash > 0.04) {
      const kExpand = 1.0 - kickFlash;        // 0→1 as ring expands outward
      const kBright = Math.pow(kickFlash, 0.45);
      const contourCount = 3;                  // 3 concentric contour rings
      const ringZ = nearZ - 0.03;

      for (let c = 0; c < contourCount; c++) {
        const cf = c / contourCount;
        // Each contour ring at a different expansion phase — staggered emergence
        const contourExpand = kExpand + cf * 0.18;
        if (contourExpand > 1.0) continue;
        const contourR = webNearRadius * (0.4 + contourExpand * 2.6) * (1.0 - cf * 0.12);
        // Outer contours fade faster — topographic depth illusion
        const contourFade = kBright * Math.pow(1.0 - cf * 0.22, 1.8) * (1.0 - contourExpand * 0.4);
        if (contourFade < 0.015) continue;
        const ringSegs = 24;
        // Contour line thickness decreases with distance — like elevation lines
        const lineWeight = (1.0 - cf * 0.15);

        for (let s = 0; s < ringSegs; s++) {
          const ang = (s / ringSegs) * TAU;
          // Organic deformation: each contour has slightly different turbulence
          const turb = Math.sin(ang * 4.2 + now * 8.0 + c * 1.8) * 0.028 * (1.0 + cf * 0.5)
                     + Math.sin(ang * 7.1 - now * 5.5 + c * 0.9) * 0.014;
          const r = contourR * (1.0 + turb);
          const cosA = Math.cos(ang), sinA = Math.sin(ang);
          // Contour color: near-white core, barely tinted — like etched glass
          const contourHue = (activeHue + cf * 0.06 + kExpand * 0.04) % 1;
          colTmp.setHSL(contourHue, 0.15 + cf * 0.08, 0.88 - cf * 0.06);
          pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
            cosA * r, yBase + sinA * r * 0.62, ringZ - cf * 0.06,
            colTmp.r * contourFade * lineWeight,
            colTmp.g * contourFade * lineWeight,
            colTmp.b * contourFade * lineWeight);
          // Draw contour as connected line segments too — for clean linework
          if (s > 0) {
            const prevAng = ((s - 1) / ringSegs) * TAU;
            const prevTurb = Math.sin(prevAng * 4.2 + now * 8.0 + c * 1.8) * 0.028 * (1.0 + cf * 0.5)
                           + Math.sin(prevAng * 7.1 - now * 5.5 + c * 0.9) * 0.014;
            const prevR = contourR * (1.0 + prevTurb);
            pushLine(roll3DLinePosArray, lineV,
              Math.cos(prevAng) * prevR, yBase + Math.sin(prevAng) * prevR * 0.62, ringZ - cf * 0.06,
              cosA * r, yBase + sinA * r * 0.62, ringZ - cf * 0.06);
          }
        }
        // Close the contour ring
        {
          const firstAng = 0;
          const lastAng = ((ringSegs - 1) / ringSegs) * TAU;
          const firstTurb = Math.sin(firstAng * 4.2 + now * 8.0 + c * 1.8) * 0.028 * (1.0 + cf * 0.5)
                          + Math.sin(firstAng * 7.1 - now * 5.5 + c * 0.9) * 0.014;
          const lastTurb = Math.sin(lastAng * 4.2 + now * 8.0 + c * 1.8) * 0.028 * (1.0 + cf * 0.5)
                         + Math.sin(lastAng * 7.1 - now * 5.5 + c * 0.9) * 0.014;
          const firstR = contourR * (1.0 + firstTurb);
          const lastR = contourR * (1.0 + lastTurb);
          pushLine(roll3DLinePosArray, lineV,
            Math.cos(lastAng) * lastR, yBase + Math.sin(lastAng) * lastR * 0.62, ringZ - cf * 0.06,
            Math.cos(firstAng) * firstR, yBase + Math.sin(firstAng) * firstR * 0.62, ringZ - cf * 0.06);
        }
      }

      // Center distortion: chromatic aberration bloom at origin — the "epicenter"
      if (kickFlash > 0.15) {
        const centerBright = Math.pow(kickFlash, 0.35) * 0.6;
        const centerCA = 0.025 + kickFlash * 0.05;
        // 3-channel split at center
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          centerCA, yBase, ringZ + 0.02,
          centerBright * 0.72, centerBright * 0.04, centerBright * 0.03);
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          -centerCA * 0.6, yBase + centerCA * 0.4, ringZ + 0.02,
          centerBright * 0.03, centerBright * 0.62, centerBright * 0.06);
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          -centerCA * 0.3, yBase - centerCA * 0.5, ringZ + 0.02,
          centerBright * 0.04, centerBright * 0.08, centerBright * 0.68);
        // White-hot center core
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          0, yBase, ringZ + 0.03,
          centerBright * 0.88, centerBright * 0.90, centerBright * 0.94);
      }

      // Pressure wave: sparse dots at expanding wavefront edge
      const wavePts = 6;
      for (let w = 0; w < wavePts; w++) {
        const wAng = (w / wavePts) * TAU + now * 0.8;
        const wR = webNearRadius * (0.6 + kExpand * 2.8);
        const wFade = kBright * 0.22 * (1.0 - kExpand * 0.5);
        if (wFade < 0.01) continue;
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          Math.cos(wAng) * wR, yBase + Math.sin(wAng) * wR * 0.62, ringZ - 0.02,
          wFade * 0.82, wFade * 0.84, wFade * 0.90);
      }
    }

    // === PER-DRUM-TYPE VISUALS: each drum gets a distinct, subtle signature ===
    // Snare: horizontal slash lines radiating outward
    const snareF = drumTypes.snare || 0;
    if (snareF > 0.02) {
      const sBright = Math.pow(snareF, 0.4) * 0.7;
      const sExpand = 1.0 - (snareF / 0.35);
      const slashCount = 4;
      const sZ = nearZ - 0.04;
      for (let i = 0; i < slashCount; i++) {
        const baseAng = (i / slashCount) * TAU + now * 0.3;
        const r1 = webNearRadius * (0.3 + sExpand * 1.6);
        const r2 = r1 + webNearRadius * 0.5 * sBright;
        const cosA = Math.cos(baseAng), sinA = Math.sin(baseAng);
        const x1 = cosA * r1, y1 = yBase + sinA * r1 * 0.62;
        const x2 = cosA * r2, y2 = yBase + sinA * r2 * 0.62;
        pushLine(roll3DLinePosArray, lineV, x1, y1, sZ, x2, y2, sZ);
        colTmp.setHSL((activeHue + 0.08) % 1, 0.18, 0.86);
        pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
          x1, y1, sZ, x2, y2, sZ,
          colTmp.r * sBright * 0.12, colTmp.g * sBright * 0.12, colTmp.b * sBright * 0.12, 0.018);
      }
    }
    // Hi-hat: fast shimmering arc at top
    const hatF = drumTypes.hat || 0;
    if (hatF > 0.02) {
      const hBright = Math.pow(hatF, 0.35) * 0.6;
      const hSegs = 8;
      const hZ = nearZ - 0.02;
      const hArc = Math.PI * 0.35;
      const hBase = -Math.PI * 0.5 + now * 2.4;
      for (let s = 0; s < hSegs; s++) {
        const ang = hBase + (s / hSegs) * hArc - hArc * 0.5;
        const shimmer = 0.7 + 0.3 * Math.sin(s * 5.3 + now * 18.0);
        const r = webNearRadius * (0.85 + hatF * 0.3);
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          Math.cos(ang) * r, yBase + Math.sin(ang) * r * 0.62, hZ,
          hBright * shimmer * 0.82, hBright * shimmer * 0.86, hBright * shimmer * 0.9);
      }
    }
    // Clap: double-pulse cross
    const clapF = drumTypes.clap || 0;
    if (clapF > 0.02) {
      const clBright = Math.pow(clapF, 0.4) * 0.65;
      const clZ = nearZ - 0.035;
      const clR = webNearRadius * (0.6 + clapF * 0.8);
      for (let arm = 0; arm < 4; arm++) {
        const ang = arm * Math.PI * 0.5 + Math.PI * 0.25;
        const cosA = Math.cos(ang), sinA = Math.sin(ang);
        pushLine(roll3DLinePosArray, lineV,
          cosA * clR * 0.2, yBase + sinA * clR * 0.2 * 0.62, clZ,
          cosA * clR, yBase + sinA * clR * 0.62, clZ);
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          cosA * clR, yBase + sinA * clR * 0.62, clZ,
          clBright * 0.88, clBright * 0.78, clBright * 0.65);
      }
    }
    // Tom: concentric arcs at bottom hemisphere
    const tomF = drumTypes.tom || 0;
    if (tomF > 0.02) {
      const tBright = Math.pow(tomF, 0.45) * 0.55;
      const tZ = nearZ - 0.05;
      for (let ring = 0; ring < 2; ring++) {
        const tR = webNearRadius * (0.5 + ring * 0.4 + tomF * 0.6);
        const tSegs = 6;
        const arcStart = Math.PI * 0.15;
        const arcEnd = Math.PI * 0.85;
        for (let s = 0; s < tSegs; s++) {
          const ang = arcStart + (s / tSegs) * (arcEnd - arcStart);
          const fade = tBright * (1.0 - ring * 0.35);
          colTmp.setHSL((activeHue + 0.35) % 1, 0.15, 0.82);
          pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
            Math.cos(ang) * tR, yBase + Math.sin(ang) * tR * 0.62, tZ - ring * 0.03,
            colTmp.r * fade, colTmp.g * fade, colTmp.b * fade);
          if (s > 0) {
            const pAng = arcStart + ((s - 1) / tSegs) * (arcEnd - arcStart);
            pushLine(roll3DLinePosArray, lineV,
              Math.cos(pAng) * tR, yBase + Math.sin(pAng) * tR * 0.62, tZ - ring * 0.03,
              Math.cos(ang) * tR, yBase + Math.sin(ang) * tR * 0.62, tZ - ring * 0.03);
          }
        }
      }
    }
    // Ride: slow rotating dotted circle
    const rideF = drumTypes.ride || 0;
    if (rideF > 0.02) {
      const rBright = Math.pow(rideF, 0.5) * 0.45;
      const rZ = nearZ - 0.03;
      const rR = webNearRadius * 0.72;
      const rDots = 6;
      for (let d = 0; d < rDots; d++) {
        const ang = (d / rDots) * TAU + now * 0.6;
        const pulse = 0.7 + 0.3 * Math.sin(d * 3.7 + now * 4.0);
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          Math.cos(ang) * rR, yBase + Math.sin(ang) * rR * 0.62, rZ,
          rBright * pulse * 0.78, rBright * pulse * 0.82, rBright * pulse * 0.88);
      }
    }
    // Crash: brief starburst lines from center
    const crashF = drumTypes.crash || 0;
    if (crashF > 0.03) {
      const crBright = Math.pow(crashF, 0.35) * 0.72;
      const crZ = nearZ - 0.025;
      const crRays = 5;
      for (let i = 0; i < crRays; i++) {
        const ang = (i / crRays) * TAU + now * 0.15;
        const rLen = webNearRadius * (0.9 + crashF * 1.2);
        const cosA = Math.cos(ang), sinA = Math.sin(ang);
        pushLine(roll3DLinePosArray, lineV,
          0, yBase, crZ,
          cosA * rLen, yBase + sinA * rLen * 0.62, crZ);
        colTmp.setHSL((activeHue + 0.45 + i * 0.06) % 1, 0.14, 0.88);
        pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
          0, yBase, crZ,
          cosA * rLen, yBase + sinA * rLen * 0.62, crZ,
          colTmp.r * crBright * 0.08, colTmp.g * crBright * 0.08, colTmp.b * crBright * 0.08, 0.014);
      }
    }
    // Generic drum ripple fallback (for any non-kick drum when per-type not triggered)
    if (drumFlash > 0.03 && kickFlash < 0.3) {
      const dExpand = 1.0 - (drumFlash / 0.2);
      const dBright = Math.pow(drumFlash, 0.5) * 0.4;
      const dContours = 2;
      const dRingZ = nearZ - 0.05;
      for (let c = 0; c < dContours; c++) {
        const cf = c / dContours;
        const dContourExpand = clamp01(dExpand + cf * 0.22);
        const dContourR = webNearRadius * (0.5 + dContourExpand * 1.8) * (1.0 - cf * 0.10);
        const dContourFade = dBright * Math.pow(1.0 - cf * 0.28, 1.6) * (1.0 - dContourExpand * 0.45);
        if (dContourFade < 0.01) continue;
        const dSegs = 16;
        for (let s = 0; s < dSegs; s++) {
          const ang = (s / dSegs) * TAU;
          const turb = Math.sin(ang * 3.5 + now * 6.0 + c * 2.2) * 0.020
                     + Math.sin(ang * 6.0 - now * 4.0 + c) * 0.010;
          const r = dContourR * (1.0 + turb);
          const cosA = Math.cos(ang), sinA = Math.sin(ang);
          colTmp.setHSL((activeHue + 0.52 + cf * 0.04) % 1, 0.12 + cf * 0.05, 0.82);
          pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
            cosA * r, yBase + sinA * r * 0.62, dRingZ - cf * 0.04,
            colTmp.r * dContourFade, colTmp.g * dContourFade, colTmp.b * dContourFade);
          if (s > 0) {
            const pAng = ((s - 1) / dSegs) * TAU;
            const pTurb = Math.sin(pAng * 3.5 + now * 6.0 + c * 2.2) * 0.020
                        + Math.sin(pAng * 6.0 - now * 4.0 + c) * 0.010;
            const pR = dContourR * (1.0 + pTurb);
            pushLine(roll3DLinePosArray, lineV,
              Math.cos(pAng) * pR, yBase + Math.sin(pAng) * pR * 0.62, dRingZ - cf * 0.04,
              cosA * r, yBase + sinA * r * 0.62, dRingZ - cf * 0.04);
          }
        }
      }
    }

    // === AIR CURRENTS: 2 slow flows — lightweight smoke ===
    for (let a = 0; a < 2; a++) {
      const seed     = a * 1.618033;
      const speed    = 0.045 + (seed * 0.17 % 0.08);
      const headD    = 1.0 - ((seed * 0.41 + now * speed) % 1.0);
      const spkFrac  = (seed * 3.7) % WEB_SPOKES;
      const trailPts = 12;
      for (let t = 0; t < trailPts; t++) {
        const tf   = t / trailPts;
        const tp   = Math.min(1.0, headD + tf * 0.48);
        if (tp >= 1.0) break;
        const f1 = Math.sin(now * 1.4 + a * 2.0 + tp * 4.8) * 0.018;
        const f2 = Math.cos(now * 2.6 - a * 1.3 + tp * 8.2) * 0.008;
        const pT = webPoint(spkFrac + f1, tp, 0.86 + f2 * 0.3);
        const lum = Math.pow(1.0 - tf, 2.5) * (0.30 + clamp01(syncA) * 0.16);
        if (lum < 0.012) break;
        // White core only — no CA split
        pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
          pT.x, pT.y, pT.z,
          lum * 0.72, lum * 0.74, lum * 0.78);
      }
    }

    // === SCANNING DEPTH LINES: glowing sweep with halo ===
    {
      const scanPhase = ((now * 0.12) % 1.0);
      const scanFade = Math.sin(scanPhase * Math.PI);
      if (scanFade > 0.15) {
        for (let s = 0; s < WEB_SPOKES; s++) {
          const pa = webPoint(s, scanPhase, 1.0);
          const pb = webPoint((s + 1) % WEB_SPOKES, scanPhase, 1.0);
          pushLine(roll3DLinePosArray, lineV, pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
          // Glow on scan line
          const sGlow = scanFade * 0.12;
          colTmp.setHSL((activeHue + 0.52) % 1, 0.42, 0.88);
          pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
            pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
            colTmp.r * sGlow, colTmp.g * sGlow, colTmp.b * sGlow, 0.05);
        }
      }
    }

    // === LUMINOUS ENERGY ARCS: beat-reactive glow arcs orbiting near face ===
    {
      const arcCount = 3;
      const arcSegs = 10;
      const arcEnergy = 0.12 + clamp01(syncA) * 0.22 + impactFlash * 0.18;
      for (let a = 0; a < arcCount; a++) {
        const arcPhase = now * (0.35 + a * 0.12) + a * TAU / arcCount;
        const arcSpan = 0.28 + Math.sin(now * 0.5 + a) * 0.08;
        const arcR = webNearRadius * (1.05 + a * 0.06 + Math.sin(now * 0.8 + a * 1.2) * 0.04);
        for (let s = 0; s < arcSegs; s++) {
          const t0 = s / arcSegs;
          const t1 = (s + 1) / arcSegs;
          const ang0 = arcPhase + t0 * arcSpan * TAU;
          const ang1 = arcPhase + t1 * arcSpan * TAU;
          const fade = Math.sin(t0 * Math.PI) * arcEnergy;
          if (fade < 0.008) continue;
          const x0 = Math.cos(ang0) * arcR, y0 = yBase + Math.sin(ang0) * arcR * 0.62;
          const x1 = Math.cos(ang1) * arcR, y1 = yBase + Math.sin(ang1) * arcR * 0.62;
          const arcZ = nearZ - 0.04 - a * 0.02;
          colTmp.setHSL((activeHue + 0.14 + a * 0.18 + t0 * 0.06) % 1, 0.55, 0.88);
          pushGlowLine(roll3DQuadPosArray, roll3DQuadColArray, quadV,
            x0, y0, arcZ, x1, y1, arcZ,
            colTmp.r * fade, colTmp.g * fade, colTmp.b * fade, 0.035);
          // Bright core point at each segment
          pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
            x0, y0, arcZ, colTmp.r * fade * 1.4, colTmp.g * fade * 1.4, colTmp.b * fade * 1.4);
        }
      }
    }

    // === ACTIVE NOTE BEAMS: subtle lines from near face for playing notes ===
    for (let i = 0; i < Math.min(6, activeOrdered.length); i++) {
      const n = activeOrdered[i];
      const c = trackCorridor(n.src === 'M' ? (i + 7) : i);
      const pNear = webPoint(c.leftSpoke + 0.5, 0, 1.0);
      const pMid  = webPoint(c.leftSpoke + 0.5, 0.05, 0.84);
      pushLine(roll3DLinePosArray, lineV, pNear.x, pNear.y, pNear.z, pMid.x, pMid.y, pMid.z);
    }

    const previewLimit = 1600;
    const twoBarSec = Math.min(12.0, Math.max(1.4, (60 / Math.max(40, midiSourceBpm || 120)) * 8));
    const preloadSlack = 0.5;
    const clipWindowStart = midiPlaybackPosition - 2 * twoBarSec - preloadSlack;
    const clipWindowEnd = midiPlaybackPosition + 2 * twoBarSec + preloadSlack;
    const melodicFiltered = [];
    for (let i = 0; i < melodicPreview.length && melodicFiltered.length < previewLimit; i++) {
      const n = melodicPreview[i];
      const trackIdx = n.trackIndex | 0;
      if (!visibleTrackSet.has(trackIdx)) continue;
      const start = typeof n.time === 'number' ? n.time : (midiPlaybackPosition + (n.ahead || 0));
      const dur = Math.max(0.04, Math.min(8.0, n.duration || 0.15));
      const end = start + dur;
      if (end < clipWindowStart || start > clipWindowEnd) continue;
      const midi = Math.max(0, Math.min(127, n.midi | 0));
      melodicFiltered.push({
        trackIdx,
        midi,
        velocity: clamp01(n.velocity != null ? n.velocity : 0.8),
        start,
        end
      });
    }

    const clipMap = new Map();
    for (let i = 0; i < melodicFiltered.length; i++) {
      const n = melodicFiltered[i];
      const chunkStartIdx = Math.floor(n.start / twoBarSec);
      const chunkEndIdx = Math.floor((n.end - 1e-4) / twoBarSec);
      for (let ci = chunkStartIdx; ci <= chunkEndIdx; ci++) {
        const clipStart = ci * twoBarSec;
        const clipEnd = clipStart + twoBarSec;
        if (clipEnd < clipWindowStart || clipStart > clipWindowEnd) continue;
        const segStart = Math.max(n.start, clipStart);
        const segEnd = Math.min(n.end, clipEnd);
        if ((segEnd - segStart) < 0.02) continue;
        const key = `${n.trackIdx}|${ci}`;
        let clip = clipMap.get(key);
        if (!clip) {
          clip = {
            trackIdx: n.trackIdx,
            slot: trackSlotFor(n.trackIdx),
            start: clipStart,
            notes: []
          };
          clipMap.set(key, clip);
        }
        clip.notes.push({
          midi: n.midi,
          velocity: n.velocity,
          start: segStart,
          end: segEnd
        });
      }
    }

    const clips = Array.from(clipMap.values());
    for (let i = 0; i < clips.length; i++) {
      clips[i].notes.sort((a, b) => a.start - b.start || a.midi - b.midi || b.velocity - a.velocity);
    }
    clips.sort((a, b) => a.start - b.start || a.slot - b.slot);
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const aheadStart = clip.start - midiPlaybackPosition;
      const aheadEnd = (clip.start + twoBarSec) - midiPlaybackPosition;
      if (aheadStart > windowSec + 1.5 || aheadEnd < (-twoBarSec - 0.2)) continue;

      const corridor = trackCorridor(clip.trackIdx);
      const headN = depthNormAtAhead(Math.max(0, aheadStart));
      const tailN = depthNormAtAhead(Math.max(0, aheadEnd));
      const pHeadL = webPoint(corridor.leftSpoke, headN, 1.0);
      const pHeadR = webPoint(corridor.rightSpoke, headN, 1.0);
      const pTailL = webPoint(corridor.leftSpoke, tailN, 1.0);
      const pTailR = webPoint(corridor.rightSpoke, tailN, 1.0);
      const rangeMin = 24;
      const rangeMax = 108;
      // Clip frame: clean single-weight lines only.
      pushLine(roll3DLinePosArray, lineV, pTailL.x, pTailL.y, pTailL.z, pHeadL.x, pHeadL.y, pHeadL.z);
      pushLine(roll3DLinePosArray, lineV, pTailR.x, pTailR.y, pTailR.z, pHeadR.x, pHeadR.y, pHeadR.z);
      pushLine(roll3DLinePosArray, lineV, pTailL.x, pTailL.y, pTailL.z, pTailR.x, pTailR.y, pTailR.z);
      pushLine(roll3DLinePosArray, lineV, pHeadL.x, pHeadL.y, pHeadL.z, pHeadR.x, pHeadR.y, pHeadR.z);

      // Internal piano-roll notes: CA prism fringes + bloom halo for near clips.
      const pitchDen = Math.max(1, rangeMax - rangeMin);
      const noteZOff = 0.022;
      const isNearClip = aheadStart < twoBarSec;
      const noteCap = Math.min(96, clip.notes.length);
      for (let k = 0; k < noteCap; k++) {
        const note = clip.notes[k];
        const t0 = clamp01((note.start - clip.start) / twoBarSec);
        const t1 = clamp01((note.end - clip.start) / twoBarSec);
        if (t1 <= t0 + 1e-4) continue;

        const l0x = pHeadL.x + (pTailL.x - pHeadL.x) * t0, l0y = pHeadL.y + (pTailL.y - pHeadL.y) * t0, l0z = pHeadL.z + (pTailL.z - pHeadL.z) * t0 + noteZOff;
        const r0x = pHeadR.x + (pTailR.x - pHeadR.x) * t0, r0y = pHeadR.y + (pTailR.y - pHeadR.y) * t0, r0z = pHeadR.z + (pTailR.z - pHeadR.z) * t0 + noteZOff;
        const l1x = pHeadL.x + (pTailL.x - pHeadL.x) * t1, l1y = pHeadL.y + (pTailL.y - pHeadL.y) * t1, l1z = pHeadL.z + (pTailL.z - pHeadL.z) * t1 + noteZOff;
        const r1x = pHeadR.x + (pTailR.x - pHeadR.x) * t1, r1y = pHeadR.y + (pTailR.y - pHeadR.y) * t1, r1z = pHeadR.z + (pTailR.z - pHeadR.z) * t1 + noteZOff;

        const pNorm = clamp01((note.midi - rangeMin) / pitchDen);
        const halfBand = (0.003 + note.velocity * 0.004) * (isNearClip ? (1.0 + impactFlash * 0.38) : 1.0);
        const u0 = clamp01(pNorm - halfBand);
        const u1 = clamp01(pNorm + halfBand);

        const ax = l0x + (r0x - l0x) * u0, ay = l0y + (r0y - l0y) * u0, az = l0z + (r0z - l0z) * u0;
        const bx = l0x + (r0x - l0x) * u1, by = l0y + (r0y - l0y) * u1, bz = l0z + (r0z - l0z) * u1;
        const cx = l1x + (r1x - l1x) * u1, cy = l1y + (r1y - l1y) * u1, cz = l1z + (r1z - l1z) * u1;
        const dx = l1x + (r1x - l1x) * u0, dy = l1y + (r1y - l1y) * u0, dz = l1z + (r1z - l1z) * u0;

        // Near-white note core: coherent laser light through glass.
        const nv = 0.48 + note.velocity * 0.44;
        const br = Math.min(1.0, nv + 0.04), bg = Math.min(1.0, nv + 0.06), bb = Math.min(1.0, nv + 0.18);

        if (isNearClip) {
          // Bloom halo: colored soft glow, not white — uses track hue
          const haloHue = (activeHue + clip.trackIdx * 0.062 + pNorm * 0.08) % 1;
          colTmp.setHSL(haloHue, 0.55, 0.65);
          const haloStr = nv * 0.08;
          const hu0 = clamp01(pNorm - halfBand * 3.5), hu1 = clamp01(pNorm + halfBand * 3.5);
          pushQuadRaw(roll3DQuadPosArray, roll3DQuadColArray, quadV,
            l0x + (r0x - l0x) * hu0, l0y + (r0y - l0y) * hu0, l0z - 0.004,
            l0x + (r0x - l0x) * hu1, l0y + (r0y - l0y) * hu1, l0z - 0.004,
            l1x + (r1x - l1x) * hu1, l1y + (r1y - l1y) * hu1, l1z - 0.004,
            l1x + (r1x - l1x) * hu0, l1y + (r1y - l1y) * hu0, l1z - 0.004,
            colTmp.r * haloStr, colTmp.g * haloStr, colTmp.b * haloStr);
          // Subtle CA fringes — barely visible color separation.
          const cau = 0.014;
          const ru = Math.max(0, u0 - cau);
          pushQuadRaw(roll3DQuadPosArray, roll3DQuadColArray, quadV,
            l0x + (r0x - l0x) * ru, l0y + (r0y - l0y) * ru, az + 0.001,
            ax, ay, az + 0.001,
            dx, dy, dz + 0.001,
            l1x + (r1x - l1x) * ru, l1y + (r1y - l1y) * ru, dz + 0.001,
            0.48, 0.06, 0.04);
          const cu = Math.min(1, u1 + cau);
          pushQuadRaw(roll3DQuadPosArray, roll3DQuadColArray, quadV,
            bx, by, bz + 0.001,
            l0x + (r0x - l0x) * cu, l0y + (r0y - l0y) * cu, bz + 0.001,
            l1x + (r1x - l1x) * cu, l1y + (r1y - l1y) * cu, cz + 0.001,
            cx, cy, cz + 0.001,
            0.04, 0.38, 0.55);
        }

        // Main note quad.
        pushQuadRaw(roll3DQuadPosArray, roll3DQuadColArray, quadV,
          ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, br, bg, bb);
        // Edge lines for far-field readability.
        pushLine(roll3DLinePosArray, lineV, ax, ay, az, dx, dy, dz);
        pushLine(roll3DLinePosArray, lineV, bx, by, bz, cx, cy, cz);
      }

    }

    // Drum notes on their track's polygon face.
    for (let i = 0; i < drumPreview.length && instCount < ROLL3D_MAX_INSTANCES; i++) {
      const n = drumPreview[i];
      if (!visibleTrackSet.has(n.trackIndex | 0)) continue;
      const ahead = n.ahead != null ? n.ahead : ((n.time || 0) - midiPlaybackPosition);
      const dur = Math.max(0.03, Math.min(1.2, n.duration || 0.09));
      if (ahead > windowSec + 0.5 || (ahead + dur) < -0.2) continue;
      const lane = drumLane(n.drumClass != null ? n.drumClass : drumTypeToVisualIndex(n.drumType), n.trackIndex);
      const pHead = webPoint(lane.spoke, depthNormAtAhead(Math.max(0, ahead)), lane.radiusScale);
      const pTail = webPoint(lane.spoke, depthNormAtAhead(Math.max(0, ahead + dur)), lane.radiusScale);
      dirTmp.set(pHead.x - pTail.x, pHead.y - pTail.y, pHead.z - pTail.z);
      const len = Math.max(0.06, dirTmp.length());
      dirTmp.normalize();
      quatTmp.setFromUnitVectors(axisY, dirTmp);
      const vel = clamp01(n.velocity != null ? n.velocity : 0.86);
      const vTag = String(n.drumVariant || '').toLowerCase();
      const bright = /bright|bell|click|splash|tight/.test(vTag);
      const dark = /deep|sub|dark|floor/.test(vTag);
      colTmp.setHSL((activeHue + 0.08 + i * 0.03) % 1, bright ? 0.9 : 0.82, Math.min(0.9, (dark ? 0.46 : 0.55) + vel * 0.28));
      dummy.position.set((pHead.x + pTail.x) * 0.5, (pHead.y + pTail.y) * 0.5, (pHead.z + pTail.z) * 0.5);
      dummy.quaternion.copy(quatTmp);
      dummy.scale.set(0.062 + vel * 0.02, len * 1.02, 1);
      dummy.updateMatrix();
      roll3DSurfaces.setMatrixAt(instCount, dummy.matrix);
      roll3DSurfaces.setColorAt(instCount, colTmp);
      dummy.scale.set(0.096, len * 1.08, 1);
      dummy.updateMatrix();
      roll3DGlowSurfaces.setMatrixAt(instCount, dummy.matrix);
      roll3DGlowSurfaces.setColorAt(instCount, colTmp);
      instCount++;
      pushLine(roll3DLinePosArray, lineV, pTail.x, pTail.y, pTail.z, pHead.x, pHead.y, pHead.z);
    }


    // Active note accents near the viewer.
    for (let i = 0; i < activeOrdered.length && instCount < ROLL3D_MAX_INSTANCES; i++) {
      const n = activeOrdered[i];
      const lane = noteLane(n.midi, i + 3);
      const pL = webPoint(lane.leftSpoke, 0, lane.radiusScale);
      const pR = webPoint(lane.rightSpoke, 0, lane.radiusScale);
      const pFarL = webPoint(lane.leftSpoke, 0.045, lane.radiusScale);
      const pFarR = webPoint(lane.rightSpoke, 0.045, lane.radiusScale);
      const nearCx = (pL.x + pR.x) * 0.5;
      const nearCy = (pL.y + pR.y) * 0.5;
      const nearCz = (pL.z + pR.z) * 0.5;
      const farCx = (pFarL.x + pFarR.x) * 0.5;
      const farCy = (pFarL.y + pFarR.y) * 0.5;
      const farCz = (pFarL.z + pFarR.z) * 0.5;
      dirTmp.set(nearCx - farCx, nearCy - farCy, nearCz - farCz);
      if (dirTmp.lengthSq() < 1e-5) dirTmp.copy(axisY);
      dirTmp.normalize();
      sideTmp.set(pR.x - pL.x, pR.y - pL.y, pR.z - pL.z);
      if (sideTmp.lengthSq() < 1e-5) sideTmp.copy(axisX);
      sideTmp.normalize();
      upTmp.crossVectors(sideTmp, dirTmp);
      if (upTmp.lengthSq() < 1e-5) upTmp.copy(axisZ);
      upTmp.normalize();
      basisMat.makeBasis(sideTmp, dirTmp, upTmp);
      quatTmp.setFromRotationMatrix(basisMat);
      const laneW = Math.max(0.09, Math.hypot(pR.x - pL.x, pR.y - pL.y, pR.z - pL.z));
      rollTrackPitchColor(colTmp, n.src === 'M' ? (i + 7) : i, n.midi, 1.0, activeHue);
      colTmp.setRGB(Math.min(1, colTmp.r + 0.3), Math.min(1, colTmp.g + 0.3), Math.min(1, colTmp.b + 0.32));
      dummy.position.set(nearCx + upTmp.x * (0.05 + (i % 3) * 0.008), nearCy + upTmp.y * (0.05 + (i % 3) * 0.008), nearCz + upTmp.z * (0.05 + (i % 3) * 0.008));
      dummy.quaternion.copy(quatTmp);
      dummy.scale.set(laneW * 0.92, 0.19, 1);
      dummy.updateMatrix();
      roll3DSurfaces.setMatrixAt(instCount, dummy.matrix);
      roll3DSurfaces.setColorAt(instCount, colTmp);
      dummy.scale.set(laneW * 1.28, 0.23, 1);
      dummy.updateMatrix();
      roll3DGlowSurfaces.setMatrixAt(instCount, dummy.matrix);
      roll3DGlowSurfaces.setColorAt(instCount, colTmp);
      instCount++;
      // Luminous halo point for active note
      const noteGlow = 0.35 + impactFlash * 0.28 + clamp01(syncA) * 0.15;
      pushPoint(roll3DPointPosArray, roll3DPointColArray, pointV,
        nearCx, nearCy, nearCz - 0.01,
        Math.min(1, colTmp.r + 0.15) * noteGlow,
        Math.min(1, colTmp.g + 0.15) * noteGlow,
        Math.min(1, colTmp.b + 0.18) * noteGlow);
    }

    // === NOTE TEXT LABELS: tiny labels at top-left corner of each near-clip note box ===
    let labelCount = 0;
    if (roll3DNoteLabels) {
      const labelDummy = dummy;
      const uvOffArr = roll3DNoteLabels.geometry.getAttribute('aUvOffset');
      for (let i = 0; i < clips.length && labelCount < ROLL3D_MAX_LABELS; i++) {
        const clip = clips[i];
        const aheadStart = clip.start - midiPlaybackPosition;
        const aheadEnd = (clip.start + twoBarSec) - midiPlaybackPosition;
        // Only show labels for the nearest clip
        if (aheadStart > twoBarSec * 0.8 || aheadEnd < -0.1) continue;
        const corridor = trackCorridor(clip.trackIdx);
        const headN2 = depthNormAtAhead(Math.max(0, aheadStart));
        const tailN2 = depthNormAtAhead(Math.max(0, aheadEnd));
        const pHL = webPoint(corridor.leftSpoke, headN2, 1.0);
        const pHR = webPoint(corridor.rightSpoke, headN2, 1.0);
        const pTL = webPoint(corridor.leftSpoke, tailN2, 1.0);
        const pTR = webPoint(corridor.rightSpoke, tailN2, 1.0);
        const rangeMin2 = 24, rangeMax2 = 108, pitchDen2 = rangeMax2 - rangeMin2;
        const cap2 = Math.min(20, clip.notes.length);
        for (let k = 0; k < cap2 && labelCount < ROLL3D_MAX_LABELS; k++) {
          const note = clip.notes[k];
          const t0 = clamp01((note.start - clip.start) / twoBarSec);
          const t1 = clamp01((note.end - clip.start) / twoBarSec);
          if ((t1 - t0) < 0.03) continue;
          const pN = clamp01((note.midi - rangeMin2) / pitchDen2);
          const hb = 0.003 + note.velocity * 0.005;
          // Position at the START (head) and LEFT edge of the note bar
          const u0 = clamp01(pN - hb);
          const tHead = t0 + 0.005; // slightly inside the head edge
          // Interpolate to the top-left corner of the note quad
          const lHx = pHL.x + (pTL.x - pHL.x) * tHead;
          const lHy = pHL.y + (pTL.y - pHL.y) * tHead;
          const lHz = pHL.z + (pTL.z - pHL.z) * tHead;
          const rHx = pHR.x + (pTR.x - pHR.x) * tHead;
          const rHy = pHR.y + (pTR.y - pHR.y) * tHead;
          const rHz = pHR.z + (pTR.z - pHR.z) * tHead;
          const cornerX = lHx + (rHx - lHx) * u0;
          const cornerY = lHy + (rHy - lHy) * u0;
          const cornerZ = lHz + (rHz - lHz) * u0 + 0.024 + 0.005;
          // Very small label: fixed tiny size
          labelDummy.position.set(cornerX, cornerY, cornerZ);
          labelDummy.quaternion.identity();
          labelDummy.scale.set(0.016, 0.008, 1);
          labelDummy.updateMatrix();
          roll3DNoteLabels.setMatrixAt(labelCount, labelDummy.matrix);
          if (uvOffArr) {
            uvOffArr.setX(labelCount, (note.midi % 12) / 12.0);
          }
          labelCount++;
        }
      }
      roll3DNoteLabels.count = labelCount;
      roll3DNoteLabels.instanceMatrix.needsUpdate = true;
      if (uvOffArr) uvOffArr.needsUpdate = true;
    }

    // === EMBER STORM: glowing embers rising with curl noise turbulence ===
    if (roll3DParticles && roll3DParticlePosArray && emberVelocities && emberAges && emberTemps) {
      const maxLife = 4.0;
      const turbulence = 0.003 + clamp01(syncA) * 0.004;
      const riseSpeed = 0.008 + audioEnergy * 0.006;
      // Spawn burst on beat
      if (impactFlash > 0.3) {
        const spawnN = Math.min(32, Math.floor(impactFlash * 48));
        for (let s = 0; s < spawnN; s++) {
          // Find a dead ember to respawn
          let slot = -1;
          for (let k = 0; k < ROLL3D_MAX_PARTICLES; k++) {
            if (emberAges[k] > maxLife) { slot = k; break; }
          }
          if (slot < 0) break;
          const sAng = (s * 2.39996 + now * 3.0) % TAU;
          const sR = webNearRadius * (0.2 + Math.random() * 0.6);
          const i3 = slot * 3;
          roll3DParticlePosArray[i3]     = Math.cos(sAng) * sR;
          roll3DParticlePosArray[i3 + 1] = yBase - 0.1;
          roll3DParticlePosArray[i3 + 2] = nearZ - Math.random() * 0.3;
          emberVelocities[i3]     = (Math.random() - 0.5) * 0.008;
          emberVelocities[i3 + 1] = riseSpeed * (0.8 + Math.random() * 0.4);
          emberVelocities[i3 + 2] = (Math.random() - 0.5) * 0.004;
          emberAges[slot] = 0;
          emberTemps[slot] = 1.0;
        }
      }
      // Also spawn ambient embers continuously
      for (let a = 0; a < 3; a++) {
        let slot = -1;
        for (let k = 0; k < ROLL3D_MAX_PARTICLES; k++) {
          if (emberAges[k] > maxLife) { slot = k; break; }
        }
        if (slot < 0) break;
        const sAng = Math.random() * TAU;
        const sR = webNearRadius * (0.1 + Math.random() * 0.5);
        const i3 = slot * 3;
        roll3DParticlePosArray[i3]     = Math.cos(sAng) * sR;
        roll3DParticlePosArray[i3 + 1] = yBase - 0.2 + Math.random() * 0.1;
        roll3DParticlePosArray[i3 + 2] = nearZ - Math.random() * depthSpan * 0.4;
        emberVelocities[i3]     = (Math.random() - 0.5) * 0.003;
        emberVelocities[i3 + 1] = riseSpeed * (0.4 + Math.random() * 0.3);
        emberVelocities[i3 + 2] = (Math.random() - 0.5) * 0.002;
        emberAges[slot] = 0;
        emberTemps[slot] = 0.5 + Math.random() * 0.3;
      }
      // Update all embers
      let activeCount = 0;
      for (let i = 0; i < ROLL3D_MAX_PARTICLES; i++) {
        const i3 = i * 3;
        if (emberAges[i] > maxLife) {
          // Dead ember: hide
          roll3DParticlePosArray[i3] = 0;
          roll3DParticlePosArray[i3+1] = -10;
          roll3DParticlePosArray[i3+2] = 0;
          roll3DParticleColArray[i3] = 0;
          roll3DParticleColArray[i3+1] = 0;
          roll3DParticleColArray[i3+2] = 0;
          continue;
        }
        activeCount++;
        emberAges[i] += 0.016;
        emberTemps[i] = Math.max(0, emberTemps[i] - 0.004);
        // Curl noise displacement
        const cn = curlNoise3D(
          roll3DParticlePosArray[i3] * 3.0,
          roll3DParticlePosArray[i3+1] * 3.0,
          roll3DParticlePosArray[i3+2] * 3.0,
          now * 0.5
        );
        emberVelocities[i3]     += cn.x * turbulence;
        emberVelocities[i3 + 1] += cn.y * turbulence * 0.3 + riseSpeed * 0.02;
        emberVelocities[i3 + 2] += cn.z * turbulence;
        // Damping
        emberVelocities[i3] *= 0.98;
        emberVelocities[i3+1] *= 0.98;
        emberVelocities[i3+2] *= 0.98;
        // Update position
        roll3DParticlePosArray[i3]     += emberVelocities[i3];
        roll3DParticlePosArray[i3 + 1] += emberVelocities[i3+1];
        roll3DParticlePosArray[i3 + 2] += emberVelocities[i3+2];
        // Temperature gradient: yellow-white → orange → red → dark ember
        const temp = emberTemps[i];
        const life = 1.0 - Math.min(1, emberAges[i] / maxLife);
        const fade = life * 0.7;
        roll3DParticleColArray[i3]     = fade * (0.3 + temp * 0.7);  // R: high when hot
        roll3DParticleColArray[i3 + 1] = fade * (0.08 + temp * 0.55); // G: medium when hot
        roll3DParticleColArray[i3 + 2] = fade * (0.02 + temp * 0.25); // B: low
      }
      roll3DParticles.geometry.setDrawRange(0, ROLL3D_MAX_PARTICLES);
      roll3DParticlePosAttr.needsUpdate = true;
      roll3DParticleColAttr.needsUpdate = true;
      roll3DParticles.material.opacity = Math.min(0.82, 0.42 + clamp01(syncA) * 0.18 + impactFlash * 0.16);
      roll3DParticles.material.size = 0.012 + clamp01(syncA) * 0.008 + impactFlash * 0.014;
    }

    roll3DSurfaces.count = instCount;
    roll3DSurfaces.instanceMatrix.needsUpdate = true;
    roll3DGlowSurfaces.count = instCount;
    roll3DGlowSurfaces.instanceMatrix.needsUpdate = true;
    if (roll3DSurfaces.instanceColor) roll3DSurfaces.instanceColor.needsUpdate = true;
    if (roll3DGlowSurfaces.instanceColor) roll3DGlowSurfaces.instanceColor.needsUpdate = true;

    roll3DQuads.geometry.setDrawRange(0, quadV.i);
    roll3DQuadPosAttr.needsUpdate = true;
    roll3DQuadColAttr.needsUpdate = true;

    roll3DLines.geometry.setDrawRange(0, Math.floor(lineV.i / 3));
    roll3DLinePosAttr.needsUpdate = true;
    roll3DPoints.geometry.setDrawRange(0, pointV.i);
    roll3DPointPosAttr.needsUpdate = true;
    roll3DPointColAttr.needsUpdate = true;

    // Deterministic glitch: rare, sharp displacement spikes.
    const glitchN = Math.sin(now * 31.4) * Math.cos(now * 17.7);
    const glitchAmt = Math.max(0, Math.abs(glitchN) - 0.88) * 0.42;
    // Head tracking → polygon yaw/pitch (glasses-like parallax)
    const hYaw = (headYaw || 0) * 0.6;   // horizontal head → Y rotation
    const hPitch = (headPitch || 0) * 0.35; // vertical head → X tilt
    roll3DGroup.rotation.x = -0.015 + hPitch;
    roll3DGroup.rotation.y = hYaw + glitchAmt * (glitchN > 0 ? 0.04 : -0.03);
    roll3DGroup.rotation.z = glitchAmt * (glitchN > 0 ? 1.0 : -0.8);
    roll3DGroup.position.set(glitchAmt * (glitchN > 0 ? 0.05 : -0.04), -0.02, 0.5);
    roll3DSurfaces.material.opacity = Math.min(0.88, 0.55 + impactFlash * 0.28);
    roll3DGlowSurfaces.material.opacity = Math.min(0.65, 0.24 + impactFlash * 0.22 + clamp01(syncA) * 0.14);
    roll3DQuads.material.opacity = Math.min(0.90, 0.68 + impactFlash * 0.14);
    roll3DLines.material.opacity = Math.min(0.85, 0.48 + clamp01(syncA) * 0.24 + impactFlash * 0.12);
    // Animate line hue: colored prismatic drift — saturated, not white
    const lineHue = (activeHue * 0.38 + now * 0.032 + Math.sin(now * 0.28) * 0.07) % 1;
    const lineSat = 0.42 + clamp01(syncA) * 0.20 + impactFlash * 0.10;
    const lineLum = 0.72 + clamp01(syncA) * 0.08;
    colTmp.setHSL(lineHue, lineSat, Math.min(0.85, lineLum));
    roll3DLines.material.color.copy(colTmp);
    roll3DPoints.material.opacity = Math.min(0.92, 0.58 + clamp01(syncA) * 0.24);
    roll3DPoints.material.size = 0.032 + clamp01(syncA) * 0.030 + impactFlash * 0.024;
  }
  const HARMONY_MODES = ['off', 'auto3', 'maj3', 'min3', 'fifth', 'ninth'];
  const HARMONY_MODE_LABEL = { off: 'OFF', auto3: 'AUTO3', maj3: 'MAJ3', min3: 'MIN3', fifth: '5TH', ninth: '9TH' };
  let harmonyModeIdx = 0;
  function getHarmonyMode() {
    return HARMONY_MODES[harmonyModeIdx] || 'off';
  }
  function cycleHarmonyMode() {
    harmonyModeIdx = (harmonyModeIdx + 1) % HARMONY_MODES.length;
    return getHarmonyMode();
  }
  function getSmartThirdSemitone(midi) {
    const pc = ((midi % 12) + 12) % 12;
    const diatonicMap = { 0: 4, 2: 3, 4: 3, 5: 4, 7: 4, 9: 3, 11: 3 };
    let semi = diatonicMap[pc] != null ? diatonicMap[pc] : 3;
    // LSD-leaning scenes bias slightly darker harmony; museum-leaning keeps brighter third.
    if (styleLsd > styleMuseum + 0.16) semi = 3;
    if (styleMuseum > styleLsd + 0.2) semi = 4;
    return semi;
  }
  function getHarmonySemitone(mode, midi) {
    if (mode === 'auto3' || mode === 'third') return getSmartThirdSemitone(midi);
    if (mode === 'maj3') return 4;
    if (mode === 'min3') return 3;
    if (mode === 'fifth') return 7;
    if (mode === 'ninth') return 14;
    return 0;
  }

  let scene, camera, renderer, gpuCompute, positionVariable, velocityVariable;
  let rollOverlayScene, rollOverlayCamera;
  let particlePoints, boxWireframe;
  let verticalParticleColumns;
  let attractor = { x: 0, y: 0, z: 0, strength: 0, col: 0, row: 0 };
  let useGPGPU = false;
  const W = 128;
  const N = W * W;
  const BOX_HALF = 1.22;
  const TUNNEL_RINGS = 36;
  const TUNNEL_RADIUS = 1.9;
  const SPECTRUM_BAR_COUNT = 12;
  const RADIATE_COUNT = 72;
  const RADIATE_POINTS_PER_RAY = 100;
  const SPEED_LINE_COUNT = 80;
  const SPEED_POINTS_PER_LINE = 120;
  const VERT_COL_POINTS = 360;
  const CENTRAL_COL_POINTS = 500;
  const FLOATING_ORB_COUNT = 8;
  const FLOATING_POINTS_PER_ORB = 100;
  const BURST_RING_POINTS = 200;
  const PLASMA_POINTS = 600;
  const MATRIX_SURF_POINTS = 2800;
  const PRISM_SPOKE_POINTS = 1200;
  const ROLL3D_MAX_INSTANCES = 320;
  const ROLL3D_MAX_LINES = 18000;
  const ROLL3D_MAX_POINTS = 9000;
  const ROLL3D_MAX_QUAD_VERTS = 45000;
  const ROLL3D_PREVIEW_CAP = 2400;
  let burstRingTime = -1;
  let tunnelParticles, centralColumnParticles, radiatingParticles, speedLineParticles;
  let burstRingParticles, plasmaParticles, floatingParticleClouds, matrixSurfaceParticles, prismSpokeParticles, bgPlane;
  let roll3DGroup, roll3DFloor, roll3DSurfaces, roll3DGlowSurfaces, roll3DLines, roll3DPoints, roll3DQuads;
  let roll3DLinePosAttr, roll3DPointPosAttr, roll3DPointColAttr, roll3DQuadPosAttr, roll3DQuadColAttr;
  let roll3DLinePosArray, roll3DPointPosArray, roll3DPointColArray, roll3DQuadPosArray, roll3DQuadColArray;
  // Note text labels: InstancedMesh with CanvasTexture atlas
  let roll3DNoteLabels, roll3DNoteLabelTexture;
  const ROLL3D_MAX_LABELS = 160;
  // Tunnel particle system
  let roll3DParticles, roll3DParticlePosArray, roll3DParticleColArray, roll3DParticlePosAttr, roll3DParticleColAttr;
  const ROLL3D_MAX_PARTICLES = 512;
  let rollImpulses = [];
  let rollDrumImpulses = [];
  let keyDisplayCanvas, keyDisplayTexture, keyDisplayMesh;
  let keyDisplayReveal = 0; // 0..1 for reveal animation
  let displayedMidiNotes = []; // current MIDI chord for text display (every note)
  let midiRollPreview = [];
  let midiPlaybackActive = false;
  let midiPlaybackSpeed = 1;
  let midiPlaybackPosition = 0;
  let midiPlaybackDuration = 0;
  let midiPlaybackPolyphony = 0;
  let midiSourceBpm = 120;
  let composer, postScene, postCamera, postQuad, rtScene;
  const particleMatOpts = { transparent: true, sizeAttenuation: true, vertexColors: false, blending: THREE.AdditiveBlending, depthWrite: false };
  let noteRepeatOverlayEl = null;
  let noteRepeatRowEls = [];
  let noteRepeatSignature = '';
  let noteRepeatStyleEl = null;
  let vhsTimestampEl = null;
  let datamoshPhase = 0;
  let datamoshDir = 0;
  let bracketFrameEl = null;
  let crosshairEl = null;
  let scanlineEl = null;
  let datastreamEl = null;
  let datastreamInnerEl = null;
  let gradientCornersEl = null;
  let spectrumEl = null;
  let specBars = [];
  let chordEl = null;
  let chordSubEl = null;
  let arcEl = null;
  let arcFgEl = null;
  let arcLabelEl = null;
  let dotsEl = null;
  let sysIdEl = null;
  let lastChordName = '';
  let noiseEl = null;
  let crtLinesEl = null;
  let glitchBarEl = null;
  let glitchBarTimer = 0;
  let velocityEl = null;
  let velocityFillEl = null;
  let velocityLabelEl = null;
  let keysigEl = null;
  let keysigSubEl = null;
  let lastKeysigName = '';
  let waveformEl = null;
  let waveformCanvas = null;
  let waveformCtx = null;
  let edgeLinesEl = null;
  let orbitEl = null;
  let freqLabelEl = null;
  let freqHzEl = null;
  let polycountEl = null;
  let polycountLabelEl = null;
  let tickerBars = [];
  let lastFreqHz = 0;
  let constellationEl = null;
  let constellationCanvas = null;
  let constellationCtx = null;
  let constellationMouseX = -9999;
  let constellationMouseY = -9999;
  let constellationShockwave = 0;
  let constellationFade = new Float32Array(12);
  let constellationParticles = null;   // lazy-init array of {x,y,vx,vy}
  let orbitRingRef = null;
  let orbitDotRefs = null;
  let frameBudgetOver = 0;             // counts consecutive slow frames
  let beatFlashEl = null;              // full-screen beat flash overlay
  let beatFlashLevel = 0;             // smoothed flash opacity (lerp target)
  let lastKickImpact = -10;
  let lastDrumMinorImpact = -10;
  // Per-drum-type impact timestamps for distinct visual treatments
  const lastDrumTypeImpact = { snare: -10, clap: -10, hat: -10, tom: -10, ride: -10, crash: -10 };

  const velocityShader = `
    #define TAU 6.28318530718
    uniform float time;
    uniform vec3 attractor;
    uniform float attractorStrength;
    uniform float attractorCol;
    uniform float attractorRow;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 posData = texture2D( texturePosition, uv );
      vec4 velData = texture2D( textureVelocity, uv );
      vec3 pos = posData.xyz;
      vec3 vel = velData.xyz;
      float t = time * 0.5;
      float keyPhase = attractorCol * 0.5;
      float rowBias = (attractorRow - 1.0) * 0.01;
      float id = hash(uv * 128.0);
      float idClass = floor(id * 6.0); // 6 behavioral classes

      // Multi-scale curl noise with harmonic overtones
      vec3 curl;
      curl.x = sin(pos.y*1.6+t)*0.005 + cos(pos.z*2.0+t*0.8)*0.004
             + sin(pos.y*4.2+t*1.5+keyPhase)*0.003
             + sin(pos.y*8.5-t*2.1)*0.0015;
      curl.y = sin(pos.z*1.6+t*1.1+keyPhase)*0.005 + cos(pos.x*2.0+t*0.7)*0.004 + rowBias
             + cos(pos.x*3.8-t*1.3)*0.003
             + cos(pos.z*7.2+t*1.8)*0.0015;
      curl.z = sin(pos.x*1.6+t*0.9-keyPhase*0.3)*0.005 + cos(pos.y*2.0+t*0.6)*0.004
             + sin(pos.z*3.5+t*1.1+keyPhase*0.5)*0.003
             + sin(pos.x*6.8-t*1.6)*0.0015;

      // Gravitational singularity: particles spiral inward then eject along poles
      vec3 toAttractor = attractor - pos;
      float dist = length(toAttractor) + 0.02;
      float falloff = 1.0 / (dist * dist + 0.12);
      vec3 attractDir = normalize(toAttractor);
      vec3 force = attractDir * attractorStrength * falloff * 0.14;

      // Orbital angular momentum: cross-product creates spiral
      vec3 orbitAxis = normalize(cross(toAttractor, vec3(0.0, 1.0, 0.1)));
      vec3 orbital = cross(orbitAxis, attractDir) * attractorStrength * falloff * 0.06;

      // Polar jets: near attractor, particles are ejected along Y axis
      float nearField = exp(-dist * dist * 8.0) * attractorStrength;
      vec3 jet = vec3(0.0, sign(pos.y - attractor.y + 0.001), 0.0) * nearField * 0.008;

      // Toroidal vortex field
      float torusR = 0.7 + 0.15 * sin(t * 0.25);
      float torusAngle = atan(pos.y, pos.x);
      vec3 torusCenter = vec3(cos(torusAngle)*torusR, sin(torusAngle)*torusR, 0.0);
      vec3 toTorus = torusCenter - pos;
      float torusDist = length(toTorus);
      vec3 torusTangent = normalize(cross(toTorus, vec3(0.0, 0.0, 1.0)));
      float vortexStr = 0.004 * exp(-torusDist*torusDist*3.5) * (0.3+0.7*id);
      vec3 vortex = torusTangent * vortexStr;

      // Repulsion shell: particles bounce off a breathing sphere
      float shellR = 0.45 + 0.15 * sin(t * 0.4);
      float posR = length(pos);
      float shellForce = exp(-pow((posR - shellR) * 6.0, 2.0)) * 0.004;
      vec3 repulsion = normalize(pos + vec3(0.001)) * shellForce * sign(posR - shellR);

      // Note-driven behavior — attractorCol selects the dominant physics personality
      // Each particle blends its ID-class with the note class for per-note unique motion
      float noteClass = floor(mod(attractorCol + idClass * 2.0, 12.0));

      if (noteClass < 1.0) {
        // C: Explosive radial burst — particles flung outward then spiral back
        float burst = max(0.0, sin(t * 2.0 + id * 6.28)) * 0.006;
        vel = vel * 0.968 + curl * 0.4 + normalize(pos + vec3(0.001)) * burst + orbital * 1.5 + force;
      } else if (noteClass < 2.0) {
        // C#: Crystalline lattice — particles snap toward grid positions
        vec3 gridSnap = (floor(pos * 8.0 + vec3(0.5)) / 8.0) - pos;
        vel = vel * 0.96 + curl * 0.3 + gridSnap * 0.003 + force * 0.8 + orbital * 0.5;
      } else if (noteClass < 3.0) {
        // D: Orbital spiraler — classic gravitational dance
        vel = vel * 0.974 + curl * 0.5 + orbital * 2.8 + vortex * 1.8 + force;
      } else if (noteClass < 4.0) {
        // D#: Black hole collapse — intense inward pull with polar jets
        vel = vel * 0.965 + curl * 0.3 + force * 2.0 + jet * 4.0 + orbital * 0.5;
      } else if (noteClass < 5.0) {
        // E: Lightning scatter — chaotic high-energy jitter
        vec3 jitter = vec3(sin(id*423.7+t*15.0),cos(id*267.3-t*18.0),sin(id*189.1+t*12.0))*0.004;
        vel = vel * 0.955 + curl * 1.8 + jitter + force * 0.6 + vortex * 0.3;
      } else if (noteClass < 6.0) {
        // F: Nebula drift — very slow, gentle, dreamy flow
        vel = vel * 0.988 + curl * 1.5 + vortex * 0.6 + force * 0.4 + orbital * 0.2;
      } else if (noteClass < 7.0) {
        // F#: Faceted bounce — shell repulsion dominates, particles ricochet
        vel = vel * 0.972 + curl * 0.5 + repulsion * 3.0 + force * 0.6 + vortex * 0.5;
      } else if (noteClass < 8.0) {
        // G: Solar eruption — strong upward jets + orbital + curl turbulence
        vec3 erupt = vec3(0.0, 1.0, 0.0) * max(0.0, sin(t * 1.8 + id * TAU)) * 0.005;
        vel = vel * 0.97 + curl * 0.9 + force + jet * 2.0 + erupt + orbital * 1.0;
      } else if (noteClass < 9.0) {
        // G#: Toroidal vortex — particles locked onto torus circulation
        vel = vel * 0.975 + curl * 0.4 + vortex * 3.5 + force * 0.5 + orbital * 0.3;
      } else if (noteClass < 10.0) {
        // A: Fractal freeze — phase oscillation creates crystalline pauses
        float phase = sin(t * 2.5 + id * 6.28);
        float freeze = smoothstep(0.3, 0.6, abs(phase));
        vel = vel * mix(0.99, 0.96, freeze) + curl * (0.3 + freeze * 0.8) + force * 0.5 + repulsion * 0.8;
      } else if (noteClass < 11.0) {
        // A#: Bio-organic — pulsing expansion/contraction with membrane bounce
        float pulse = sin(t * 3.0 + id * 3.14) * 0.004;
        float membraneR = 0.5 + 0.1 * sin(t * 0.8);
        float membraneForce = exp(-pow((length(pos) - membraneR) * 5.0, 2.0)) * 0.005 * sign(length(pos) - membraneR);
        vel = vel * 0.975 + curl * 0.7 + normalize(pos + vec3(0.001)) * pulse + vec3(membraneForce) + force * 0.5;
      } else {
        // B: Sacred geometry — particles converge toward golden-ratio spiral paths
        float goldenAngle = 2.399963; // TAU / phi^2
        float spiralPhase = atan(pos.y, pos.x) + length(pos.xy) * 10.0;
        vec3 spiralForce = vec3(-sin(spiralPhase), cos(spiralPhase), 0.0) * 0.003;
        vel = vel * 0.978 + curl * 0.6 + spiralForce + force * 0.6 + vortex * 0.8 + orbital * 0.4;
      }
      vel = clamp(vel, -0.09, 0.09);
      gl_FragColor = vec4(vel, 1.0);
    }
  `;

  const positionShader = `
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 posData = texture2D( texturePosition, uv );
      vec4 velData = texture2D( textureVelocity, uv );
      vec3 pos = posData.xyz + velData.xyz * 0.02;
      pos = clamp(pos, -${BOX_HALF}, ${BOX_HALF});
      gl_FragColor = vec4(pos, 1.0);
    }
  `;

  function initGPGPU() {
    const container = document.getElementById('canvas-container');
    if (!container) return;
    // Only init once: avoid creating multiple WebGL contexts (causes "Too many active WebGL contexts" and tab crash)
    if (renderer && scene) return;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0a18);
    camera = new THREE.PerspectiveCamera(48, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 4.5;

    // Roll overlay scene: independent top layer, not affected by main camera/post distortion.
    rollOverlayScene = new THREE.Scene();
    rollOverlayScene.background = null;
    rollOverlayCamera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 100);
    rollOverlayCamera.position.set(0, 0.0, 4.35);
    rollOverlayCamera.lookAt(0, -0.12, -1.9);

    // Background: dynamic aurora / nebula with stars
    const bgGeo = new THREE.PlaneGeometry(20, 20);
    const bgMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, activeHue: { value: 0.55 }, audioLevel: { value: 0 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        #define PI 3.14159265359
        #define TAU 6.28318530718
        uniform float time; uniform float activeHue; uniform float audioLevel;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        vec2 hash2(vec2 p){
          return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);
        }
        float noise(vec2 p){
          vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
        }
        float fbm(vec2 p){
          float f=0.0; float a=0.5;
          for(int i=0;i<6;i++){ f+=a*noise(p); p=p*2.07+vec2(11.3,6.7); a*=0.48; }
          return f;
        }
        float fbm3(vec2 p){
          float f=0.0; float a=0.5;
          for(int i=0;i<3;i++){ f+=a*noise(p); p=p*2.1+vec2(3.7,8.1); a*=0.5; }
          return f;
        }
        mat2 rot(float a){ float s=sin(a),c=cos(a); return mat2(c,-s,s,c); }

        // Voronoi with cell ID for unique per-shard coloring
        vec3 voronoiEx(vec2 uv){
          vec2 i=floor(uv); vec2 f=fract(uv);
          float d1=10.0, d2=10.0; vec2 cellId=vec2(0.0);
          for(float y=-1.0;y<=1.0;y+=1.0){
            for(float x=-1.0;x<=1.0;x+=1.0){
              vec2 g=vec2(x,y);
              vec2 o=hash2(i+g);
              vec2 p=g+0.5+0.38*sin(o*TAU+time*0.15)-f;
              float d=dot(p,p);
              if(d<d1){ d2=d1; d1=d; cellId=i+g; } else if(d<d2){ d2=d; }
            }
          }
          return vec3(sqrt(d1),sqrt(max(0.0,d2-d1)),hash(cellId));
        }

        vec3 hsl(float h,float s,float l){
          vec3 k=vec3(1.0,2.0/3.0,1.0/3.0);
          vec3 p=clamp(abs(fract(vec3(h)+k)*6.0-3.0)-1.0,0.0,1.0);
          return l*mix(vec3(1.0),p,s);
        }

        void main(){
          vec2 uv=vUv;
          vec2 c=uv-0.5;
          float r=length(c);
          float a=atan(c.y,c.x);
          float syncA=sin(time*0.45);
          float syncB=sin(time*0.38+1.0);
          float syncC=sin(time*0.27+2.3);
          float breathe=0.5+0.5*syncA;
          float lvl=clamp(audioLevel,0.0,1.0);

          // === Layer 1: Deep space nebula with domain warping ===
          vec2 pA=rot(0.14*syncB)*(c*3.2)+vec2(time*0.055,-time*0.04);
          vec2 pB=rot(-0.28+0.08*syncA)*(c*5.8)+vec2(-time*0.045,time*0.035);
          float warpN=fbm3(c*2.0+vec2(time*0.03));
          vec2 pC=rot(warpN*0.6)*(c*4.5)+vec2(time*0.03,time*0.02);
          float nA=fbm(pA);
          float nB=fbm(pB);
          float nC=fbm(pC);

          // === Layer 2: Topographic contour field (elevation scatter) ===
          float field=(nA*0.72+nB*0.48+nC*0.35)+(0.28+0.22*lvl)*sin(a*4.0+time*0.22)+r*1.4;
          float contourMajor=1.0-smoothstep(0.0,0.025,abs(fract(field*(10.0+lvl*14.0))-0.5));
          float contourMinor=1.0-smoothstep(0.0,0.015,abs(fract(field*(6.5+lvl*9.0)+0.33)-0.5));
          float contourFine=1.0-smoothstep(0.0,0.01,abs(fract(field*(18.0+lvl*6.0)+0.17)-0.5));
          float contour=contourMajor*0.58+contourMinor*0.35+contourFine*0.18;

          // Contour scatter: lines break and scatter outward with audio
          float scatterPhase=sin(field*22.0+time*0.8+a*2.0)*lvl;
          float contourScatter=contour*(1.0+scatterPhase*0.4);

          // === Layer 3: Prism Voronoi shards with spectral dispersion ===
          vec3 v1=voronoiEx(uv*vec2(8.0,5.0)+vec2(time*0.05,-time*0.04));
          vec3 v2=voronoiEx(uv*vec2(14.0,9.0)+vec2(-time*0.03,time*0.06));
          float shardEdge1=1.0-smoothstep(0.008,0.035,v1.y);
          float shardEdge2=1.0-smoothstep(0.006,0.025,v2.y);
          float shardFill=1.0-smoothstep(0.08,0.28,v1.x);

          // Per-shard spectral hue offset (prism refraction)
          float shardHueShift=v1.z*0.35+v2.z*0.2;
          vec3 shardPrism=hsl(activeHue+shardHueShift,0.72,0.28);

          // === Layer 4: Interference pattern (Moiré) ===
          vec2 m1=rot(0.12*syncA+time*0.02)*(c*vec2(48.0,36.0));
          vec2 m2=rot(-0.08*syncB+time*0.015)*(c*vec2(52.0,40.0));
          float moire1=sin(m1.x)*sin(m1.y);
          float moire2=sin(m2.x)*sin(m2.y);
          float moire=moire1*moire2;
          float moireLines=1.0-smoothstep(0.0,0.04,abs(moire));

          // === Layer 5: Radial prism dispersion rings ===
          float ringPhase=r*28.0-time*0.6+sin(a*3.0)*0.8;
          float prismRingR=exp(-pow(fract(ringPhase*0.08+0.00)*2.0-1.0,2.0)*8.0);
          float prismRingG=exp(-pow(fract(ringPhase*0.08+0.33)*2.0-1.0,2.0)*8.0);
          float prismRingB=exp(-pow(fract(ringPhase*0.08+0.66)*2.0-1.0,2.0)*8.0);
          vec3 prismRings=vec3(prismRingR,prismRingG,prismRingB)*0.12;
          float ringFade=smoothstep(0.15,0.5,r)*(1.0-smoothstep(0.75,1.1,r));
          prismRings*=ringFade*(0.5+0.8*lvl);

          // === Layer 6: Geodesic spoke lattice ===
          float spokeCount=6.0+floor(lvl*4.0);
          float spokeAngle=mod(a+time*0.08,TAU/spokeCount);
          float spokeLine=1.0-smoothstep(0.0,0.008+0.004*r,abs(spokeAngle-TAU/spokeCount*0.5));
          float spokeRing=1.0-smoothstep(0.0,0.012,abs(fract(r*16.0+time*0.15)-0.5));
          float geodesic=(spokeLine*0.6+spokeRing*0.4)*smoothstep(0.08,0.3,r);

          // === Layer 7: Duplication / echo ghost field ===
          vec2 ghost1=uv+vec2(sin(time*0.13)*0.08,cos(time*0.11)*0.06);
          vec2 ghost2=uv-vec2(cos(time*0.14)*0.06,sin(time*0.12)*0.08);
          float ghostN1=fbm3(ghost1*4.0+vec2(time*0.04));
          float ghostN2=fbm3(ghost2*4.0-vec2(time*0.03));
          float ghostContour1=1.0-smoothstep(0.0,0.03,abs(fract(ghostN1*8.0)-0.5));
          float ghostContour2=1.0-smoothstep(0.0,0.03,abs(fract(ghostN2*8.0)-0.5));
          float ghostEcho=(ghostContour1+ghostContour2)*0.3;

          // === Layer 8: Crystalline caustic network ===
          vec2 caustUv=rot(0.2*syncC)*(c*vec2(24.0,18.0))+vec2(time*0.08,-time*0.06);
          float caustA=sin(caustUv.x+sin(caustUv.y*1.4+time*0.3))*0.5+0.5;
          float caustB=sin(caustUv.y+cos(caustUv.x*1.2-time*0.25))*0.5+0.5;
          float caustic=pow(caustA*caustB,2.5);
          float caustEdge=1.0-smoothstep(0.0,0.05,abs(caustA-0.5))*
                          (1.0-smoothstep(0.0,0.05,abs(caustB-0.5)));

          // === Layer 9: Fractal warp — domain-warped recursive noise ===
          vec2 warpP=c*3.5;
          float wA=fbm3(warpP+vec2(time*0.04));
          float wB=fbm3(warpP+vec2(wA*1.5,time*0.03));
          float wC=fbm3(warpP+vec2(wB*1.5,-time*0.035));
          float fractalWarp=wC*wC; // self-similar structure
          float fractalEdge=1.0-smoothstep(0.0,0.02,abs(fract(wC*12.0+time*0.1)-0.5));

          // === Layer 10: Magnetic field lines ===
          float fieldAngle=a+sin(r*8.0+time*0.3)*0.3;
          float fieldLines=sin(fieldAngle*8.0)*sin(r*20.0-time*0.5);
          float fieldVis=pow(max(0.0,fieldLines),4.0);
          float fieldMask=smoothstep(0.15,0.4,r)*(1.0-smoothstep(0.7,0.95,r));

          // === Layer 11: Scattered light particles (fireflies) ===
          vec2 ffGrid=floor(c*vec2(32.0,24.0)+vec2(time*0.3,-time*0.2));
          float ffH=hash(ffGrid);
          float ffH2=hash(ffGrid+vec2(7.0,3.0));
          float firefly=step(0.94,ffH);
          vec2 ffPos=fract(c*vec2(32.0,24.0)+vec2(time*0.3,-time*0.2));
          float ffDist=length(ffPos-vec2(ffH,ffH2));
          float ffGlow=exp(-ffDist*ffDist*80.0)*firefly;
          float ffPulse=0.3+0.7*sin(time*3.0+ffH*20.0);

          // === Compose colors ===
          float outerBand=smoothstep(0.2,0.88,r)*(1.0-smoothstep(0.88,1.15,r));
          float centerVoid=1.0-smoothstep(0.0,0.2,r);

          vec3 deep=mix(vec3(0.004,0.006,0.018),vec3(0.012,0.012,0.028),breathe);
          vec3 tintA=hsl(activeHue+0.02,0.78,0.18);
          vec3 tintB=hsl(activeHue+0.56,0.62,0.17);
          vec3 tintC=hsl(activeHue+0.28,0.55,0.22);
          vec3 tintD=hsl(activeHue+0.78,0.48,0.14);

          // Nebula base
          vec3 neb=tintA*(0.24+0.52*nA)+tintB*(0.18+0.46*nB)+tintD*(0.08+0.2*nC);

          // Contour with scatter
          vec3 contourCol=mix(tintA,tintB,0.4+0.3*sin(time*0.18))*contourScatter*outerBand*(0.06+0.1*lvl);

          // Prism shards with per-cell color
          vec3 shardCol=shardPrism*(shardEdge1*0.82+shardFill*0.2)*outerBand*(0.02+0.05*lvl);
          shardCol+=mix(vec3(0.85,0.92,1.0),tintC,0.4)*shardEdge2*0.06*(0.3+0.7*lvl);

          // Moiré interference
          vec3 moireCol=mix(tintC,tintD,0.5)*moireLines*outerBand*(0.012+0.025*lvl);

          // Geodesic
          vec3 geodesicCol=mix(tintA,vec3(0.7,0.82,0.95),0.5)*geodesic*outerBand*(0.015+0.04*lvl);

          // Ghost echoes
          vec3 ghostCol=mix(tintB,tintD,0.5)*ghostEcho*(0.02+0.04*lvl);

          // Caustic
          vec3 causticCol=mix(vec3(0.9,0.95,1.0),tintA,0.35)*caustic*0.06*(0.4+0.8*lvl);
          causticCol+=tintC*caustEdge*0.03*(0.3+0.6*lvl);

          // Prism rings
          vec3 prismCol=prismRings;

          // Breathing rings
          float ringA=exp(-pow((r-(0.28+0.04*syncB))*9.5,2.0));
          float ringB=exp(-pow((r-(0.52+0.05*syncA))*10.0,2.0));
          float ringC=exp(-pow((r-(0.72+0.03*syncC))*11.0,2.0));
          vec3 ringCol=mix(tintA,tintC,0.5+0.5*syncB)*(ringA*0.22+ringB*0.16+ringC*0.1)*(0.4+0.7*lvl);

          // Fractal warp
          vec3 fractalCol=mix(tintA,tintD,fractalWarp)*fractalEdge*0.04*(0.3+0.6*lvl);
          fractalCol+=tintB*fractalWarp*0.03*(0.2+0.5*lvl);

          // Magnetic field
          vec3 fieldCol=mix(tintC,vec3(0.8,0.9,1.0),0.4)*fieldVis*fieldMask*(0.02+0.04*lvl);

          // Fireflies
          vec3 fireflyCol=hsl(fract(ffH*2.0+activeHue),0.7,0.9)*ffGlow*ffPulse*0.2*(0.5+lvl);

          // Compose
          vec3 col=deep+neb*0.42+contourCol+shardCol+moireCol+geodesicCol+ghostCol+causticCol+prismCol+ringCol
                  +fractalCol+fieldCol+fireflyCol;
          col=mix(col,deep+neb*0.22+ringCol*0.3,centerVoid*0.84);
          col*=1.0-smoothstep(0.82,1.15,r)*0.7;

          // Center subtle glow
          col+=vec3(0.02,0.025,0.045)*pow(max(0.0,1.0-r*1.3),2.0)*(0.5+0.5*lvl);

          // Stars with varied sizes and prismatic color
          vec2 starGrid=floor(uv*vec2(420.0,240.0));
          float starH=hash(starGrid);
          float star=step(0.9984,starH);
          float twinkle=0.5+0.5*sin(time*1.8+starH*140.0);
          float starSize=0.6+starH*0.8;
          vec3 starColor=hsl(starH*0.4+activeHue,0.3+starH*0.4,0.85);
          col+=starColor*star*0.1*twinkle*starSize;

          // Bright accent stars (rare, prismatic)
          float brightStar=step(0.9997,starH);
          vec3 brightColor=hsl(fract(starH*3.7+activeHue),0.7,0.95);
          col+=brightColor*brightStar*0.25*(0.6+0.4*sin(time*2.4+starH*80.0));

          gl_FragColor=vec4(max(col,vec3(0.0)),1.0);
        }
      `,
      depthWrite: false, depthTest: false
    });
    bgPlane = new THREE.Mesh(bgGeo, bgMat);
    bgPlane.position.z = -8;
    scene.add(bgPlane);

    // --- 3D key display: letters/symbols, mixed media, premium
    const keyDisplayWidth = 800;
    const keyDisplayHeight = 260;
    keyDisplayCanvas = document.createElement('canvas');
    keyDisplayCanvas.width = keyDisplayWidth;
    keyDisplayCanvas.height = keyDisplayHeight;
    keyDisplayTexture = new THREE.CanvasTexture(keyDisplayCanvas);
    keyDisplayTexture.minFilter = THREE.LinearFilter;
    keyDisplayTexture.magFilter = THREE.LinearFilter;
    const keyDisplayGeo = new THREE.PlaneGeometry(2.44, 0.82);
    const keyDisplayMat = new THREE.MeshBasicMaterial({
      map: keyDisplayTexture,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    keyDisplayMesh = new THREE.Mesh(keyDisplayGeo, keyDisplayMat);
    keyDisplayMesh.position.set(0, -0.24, 2.34);
    keyDisplayMesh.userData.baseY = -0.24;
    keyDisplayMesh.visible = false;
    keyDisplayMesh.renderOrder = 1000;
    scene.add(keyDisplayMesh);

    try {
      renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
    } catch (e) {
      console.warn('WebGL init failed', e);
      return;
    }
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(renderer.domElement);

    // --- Post-processing: kaleidoscope + prismatic CA + bloom + vignette + grain + ACES grading
    const rtScale = 0.75; // render post-processing at 75% res for performance
    const pw = Math.round(window.innerWidth * rtScale), ph = Math.round(window.innerHeight * rtScale);
    rtScene = new THREE.WebGLRenderTarget(pw, ph, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: /(iPad|iPhone|Android)/i.test(navigator.userAgent) ? THREE.UnsignedByteType : (THREE.HalfFloatType || THREE.UnsignedByteType),
      stencilBuffer: false
    });
    postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    postScene = new THREE.Scene();
    const postMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        resolution: { value: new THREE.Vector2(pw, ph) },
        time: { value: 0 },
        bloomStrength: { value: 1.6 },
        bloomThreshold: { value: 0.35 },
        chromaticOffset: { value: 0.0032 },
        kaleidoFolds: { value: 6.0 },
        kaleidoRotation: { value: 0.0 },
        kaleidoMix: { value: 0.15 },
        spiralAmt: { value: 0.0 },
        flowAmt: { value: 0.0 },
        pulseAmt: { value: 0.0 },
        shearAmt: { value: 0.0 },
        waveAmt: { value: 0.0 },
        glitchAmt: { value: 0.0 },
        mirrorXY: { value: new THREE.Vector2(0, 0) },
        warpAmt: { value: 0.0 },
        contrastBoost: { value: 1.0 },
        textureLayerMix: { value: 0.0 },
        headLook: { value: new THREE.Vector2(0, 0) },
        themeHue: { value: 0.0 },
        prismAmt: { value: 0.62 },
        audioLevel: { value: 0.0 },
        bioAmt: { value: 0.35 },
        impactFlash: { value: 0.0 },
        pixelateMix: { value: 0.58 },
        analogMix: { value: 0.66 },
        subpixelMix: { value: 0.58 },
        jitterMix: { value: 0.45 },
        zoomBlurAmt: { value: 0.0 },
        lensBlurAmt: { value: 2.0 },
        lensFlareAmt: { value: 0.15 },
        letterboxAmt: { value: 1.0 },
        anamorphicAmt: { value: 0.0 },
        gateWeaveAmt: { value: 0.3 },
        lightLeakAmt: { value: 0.0 }
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        #define PI 3.14159265359
        uniform sampler2D tDiffuse;
        uniform vec2 resolution;
        uniform float time;
        uniform float bloomStrength;
        uniform float bloomThreshold;
        uniform float chromaticOffset;
        uniform float kaleidoFolds;
        uniform float kaleidoRotation;
        uniform float kaleidoMix;
        uniform float spiralAmt;
        uniform float flowAmt;
        uniform float pulseAmt;
        uniform float shearAmt;
        uniform float waveAmt;
        uniform float glitchAmt;
        uniform vec2 mirrorXY;
        uniform float warpAmt;
        uniform float contrastBoost;
        uniform float textureLayerMix;
        uniform vec2 headLook;
        uniform float themeHue;
        uniform float prismAmt;
        uniform float audioLevel;
        uniform float bioAmt;
        uniform float impactFlash;
        uniform float pixelateMix;
        uniform float analogMix;
        uniform float subpixelMix;
        uniform float jitterMix;
        uniform float zoomBlurAmt;
        uniform float lensBlurAmt;
        uniform float lensFlareAmt;
        uniform float letterboxAmt;
        uniform float anamorphicAmt;
        uniform float gateWeaveAmt;
        uniform float lightLeakAmt;
        varying vec2 vUv;
        vec3 hueToRgb(float h){
          vec3 k=vec3(1.0,2.0/3.0,1.0/3.0);
          vec3 p=clamp(abs(fract(h+k)*6.0-3.0)-1.0,0.0,1.0);
          return mix(vec3(1.0),p,0.85);
        }

        float hash(float n){ return fract(sin(n)*43758.5453); }

        float hash1(float n){ return fract(sin(n)*43758.5453); }
        vec2 hash2v(vec2 p){ return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453); }
        float hash2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }

        // Voronoi broken-mirror: returns (cellCenter, distToEdge)
        // Each cell = an irregular shard of glass
        vec3 voronoiShatter(vec2 uv, float scale){
          vec2 iuv=floor(uv*scale);
          vec2 fuv=fract(uv*scale);
          float minDist=10.0;
          float secDist=10.0;
          vec2 cellCenter=vec2(0.0);
          vec2 cellId=vec2(0.0);
          for(float y=-1.0;y<=1.0;y+=1.0){
            for(float x=-1.0;x<=1.0;x+=1.0){
              vec2 neighbor=vec2(x,y);
              vec2 cellPt=hash2v(iuv+neighbor);
              // Animate cell centers slowly for living glass
              cellPt=0.5+0.4*sin(cellPt*6.28+time*0.3);
              vec2 diff=neighbor+cellPt-fuv;
              float d=length(diff);
              if(d<minDist){
                secDist=minDist;
                minDist=d;
                cellCenter=(iuv+neighbor+cellPt)/scale;
                cellId=iuv+neighbor;
              } else if(d<secDist){
                secDist=d;
              }
            }
          }
          float edgeDist=secDist-minDist;
          return vec3(cellCenter,edgeDist);
        }

        vec3 distortWithEdge(vec2 uv){
          vec2 c=uv-0.5; float r=length(c); float a=atan(c.y,c.x);
          float edge=0.0;
          // Shared slow rhythm for order (all motions feel in sync)
          float rhythm=sin(time*0.45);
          float rhythm2=sin(time*0.38+1.0);

          // Flow: gentle drift, ordered
          c+=flowAmt*vec2(rhythm*0.028,rhythm2*0.022)*(0.25+r*0.6);
          r=length(c); a=atan(c.y,c.x);
          // Pulse: radial breathe (same rhythm)
          c*=1.0+pulseAmt*0.055*rhythm*r;
          r=length(c); a=atan(c.y,c.x);
          // Shear: smooth lattice tilt
          float sx=shearAmt*0.12*rhythm; float sy=shearAmt*0.08*rhythm2;
          c=vec2(c.x+c.y*sx,c.y+c.x*sy);
          r=length(c); a=atan(c.y,c.x);
          // Wave: soft ripple (lower freq = more ordered)
          c+=waveAmt*vec2(sin(c.y*12.0+time*1.2)*0.015*r,sin(c.x*10.0+time*1.0)*0.015*r);
          r=length(c); a=atan(c.y,c.x);

          // Spiral is intentionally restrained: favor matrix folds over fan-like spin.
          float spiralT=spiralAmt*(0.16*r+0.05*sin(time*0.45+r*7.0));
          a+=spiralT;
          c=vec2(cos(a),sin(a))*r;
          float matrixFold=spiralAmt*0.018*sin((c.x+c.y)*22.0+time*0.85);
          c+=vec2(matrixFold,-matrixFold*0.8);

          // Warp: gentle barrel + ordered breath
          float breath=1.0+warpAmt*(r*r*2.0+0.25*sin(a*3.0+time*1.2)+0.12*cos(r*8.0+time*1.0));
          c*=breath;

          vec2 res=c+0.5;

          // Shattered mirror: radiating from center, subtle cracks
          if(kaleidoFolds>1.5){
            // Radial Voronoi: density increases toward edges, sparse at center
            vec2 fromCenter=res-0.5;
            float dist=length(fromCenter);
            // Shards get smaller farther from center (like impact fracture)
            float shardScale=(kaleidoFolds*0.5+2.0)*(0.6+dist*1.8);
            // Offset Voronoi by rotation for head-tracking response
            vec2 voroUv=res+vec2(kaleidoRotation*0.3,kaleidoRotation*0.2);
            vec3 voro=voronoiShatter(voroUv,shardScale);
            vec2 shardCenter=voro.xy;
            float edgeDist=voro.z;

            // Subtle per-shard offset (very small — elegant, not chaotic)
            float cellHash=hash2(floor(shardCenter*shardScale*1.7));
            float cellHash2=hash2(floor(shardCenter*shardScale*1.7)+17.0);
            vec2 shardOffset=(vec2(cellHash,cellHash2)-0.5)*0.025*dist;
            vec2 localUv=res-shardCenter;
            // Occasional flip in outer shards only
            if(cellHash>0.7 && dist>0.2) localUv.x=-localUv.x;
            if(cellHash2>0.7 && dist>0.25) localUv.y=-localUv.y;
            res=shardCenter+localUv+shardOffset;

            // Subtle crack lines — thinner, fade near center
            float crackIntensity=smoothstep(0.0,0.3,dist); // no cracks at center, full at edges
            float thinCrack=1.0-smoothstep(0.0,0.025,edgeDist);
            edge=thinCrack*crackIntensity*0.5; // subtle: max 0.5 opacity
          }

          // Mirror axes
          if(mirrorXY.x>0.5){
            float dm=abs(res.x-0.5);
            edge=max(edge,1.0-smoothstep(0.0,0.003,dm));
            res.x=dm+0.5;
          }
          if(mirrorXY.y>0.5){
            float dm=abs(res.y-0.5);
            edge=max(edge,1.0-smoothstep(0.0,0.003,dm));
            res.y=dm+0.5;
          }

          // Glitch: ordered horizontal scan, no random jumps (clean, not chaotic)
          if(glitchAmt>0.01){
            float band=floor(res.y*32.0);
            float t2=floor(time*4.0);
            float h1=hash1(band*7.3+t2*3.1);
            float h2=hash1(band*13.7+t2*1.7);
            res.x+=sin(band*4.0+time*5.0)*glitchAmt*0.06;
            res.x+=step(0.88,h1)*glitchAmt*0.12*(h2-0.5);
          }

          return vec3(clamp(res,0.003,0.997),edge);
        }

        vec3 prismCA(sampler2D tex, vec2 uv, float off){
          vec2 dir=normalize(uv-0.5+1e-5); float d=length(uv-0.5);
          float s=off*(0.22+d*(1.38+prismAmt*0.8));
          float r=texture2D(tex,uv+dir*s).r;
          float g=texture2D(tex,uv).g;
          float b=texture2D(tex,uv-dir*s).b;
          return vec3(r,g,b);
        }

        // Hue rotation for psychedelic color shift
        vec3 hueShift(vec3 col, float shift){
          float cosA=cos(shift), sinA=sin(shift);
          vec3 k=vec3(0.57735);
          return col*cosA+cross(k,col)*sinA+k*dot(k,col)*(1.0-cosA);
        }

        float luma(vec3 c){ return dot(c,vec3(0.299,0.587,0.114)); }
        vec3 radialScatter(sampler2D tex, vec2 uv, float amount){
          vec2 center=vec2(0.5);
          vec2 dir=center-uv;
          vec3 acc=vec3(0.0);
          float wSum=0.0;
          for(float i=1.0;i<=3.0;i+=1.0){
            float t=i/3.0;
            float w=(1.0-t);
            vec2 suv=clamp(uv+dir*(0.08+t*0.28)*amount,0.003,0.997);
            acc+=texture2D(tex,suv).rgb*w;
            wSum+=w;
          }
          return acc/max(0.0001,wSum);
        }

        // Zoom blur: radial motion blur from center — "air rushing at you"
        vec3 zoomBlurSample(sampler2D tex, vec2 uv, float amount){
          vec2 dir=uv-0.5;
          vec3 acc=texture2D(tex,uv).rgb;
          float w=1.0;
          for(float i=1.0;i<=4.0;i+=1.0){
            float t=i/4.0;
            float wi=1.0-t*0.82;
            acc+=texture2D(tex,clamp(uv-dir*t*amount,0.003,0.997)).rgb*wi;
            w+=wi;
          }
          return acc/w;
        }

        // Lens DOF: soft gaussian at screen edges, sharp at center
        vec3 lensDOF(sampler2D tex, vec2 uv, vec2 res, float amount){
          float dist=length(uv-0.5);
          float blur=dist*dist*amount*0.005;
          if(blur<0.0003) return texture2D(tex,uv).rgb;
          vec3 acc=vec3(0.0); float w=0.0;
          for(float x=-1.0;x<=1.0;x+=1.0){
            for(float y=-1.0;y<=1.0;y+=1.0){
              float wi=exp(-0.32*(x*x+y*y));
              acc+=texture2D(tex,clamp(uv+vec2(x,y)*blur/res,0.003,0.997)).rgb*wi;
              w+=wi;
            }
          }
          return acc/w;
        }

        vec3 cellularField(vec2 uv, float density, float t){
          vec2 p=uv*density;
          vec2 id=floor(p);
          vec2 f=fract(p)-0.5;
          float nearest=10.0;
          float secondN=10.0;
          float nucleus=0.0;
          for(float y=-1.0;y<=1.0;y+=1.0){
            for(float x=-1.0;x<=1.0;x+=1.0){
              vec2 o=vec2(x,y);
              vec2 rnd=hash2v(id+o);
              vec2 jitter=(rnd-0.5)*0.62;
              vec2 drift=0.16*vec2(sin(t*0.65+rnd.x*6.2831),cos(t*0.55+rnd.y*6.2831));
              vec2 c=o+jitter+drift;
              float d=length(f-c);
              if(d<nearest){
                secondN=nearest;
                nearest=d;
              } else if(d<secondN){
                secondN=d;
              }
              nucleus=max(nucleus,1.0-smoothstep(0.05,0.19,d));
            }
          }
          float membrane=1.0-smoothstep(0.012,0.05,secondN-nearest);
          return vec3(membrane,nucleus,nearest);
        }

        void main(){
          vec2 uv=vUv;
          vec3 dResult=distortWithEdge(uv);
          vec2 dUv=dResult.xy;
          float edgeFactor=dResult.z;
          vec2 finalUv=mix(uv,dUv,kaleidoMix);
          finalUv+=headLook*0.068;
          float pixScale=1.0+pixelateMix*10.0;
          vec2 pixStep=vec2(pixScale)/resolution;
          vec2 pixUv=floor(finalUv/pixStep+0.5)*pixStep;
          vec2 sampleUv=mix(finalUv,pixUv,pixelateMix);
          if(jitterMix>0.001){
            float lineIdx=floor(finalUv.y*resolution.y*0.52+time*(6.0+analogMix*16.0));
            float lineJ=(hash1(lineIdx*2.37)-0.5)*(0.001+0.0038*jitterMix)*(0.45+0.55*glitchAmt+0.45*analogMix);
            sampleUv.x=clamp(sampleUv.x+lineJ,0.003,0.997);
          }

          // Film gate weave: projector registration jitter at ~12fps
          if(gateWeaveAmt>0.001){
            float frameSlot=floor(time*12.0);
            float weaveX=(hash1(frameSlot*0.37)-0.5)*0.0012*gateWeaveAmt;
            float weaveY=(hash1(frameSlot*0.71+99.0)-0.5)*0.0007*gateWeaveAmt;
            sampleUv=clamp(sampleUv+vec2(weaveX,weaveY),vec2(0.003),vec2(0.997));
          }

          // Base scene with CA
          vec3 scene=prismCA(tDiffuse,sampleUv,chromaticOffset+glitchAmt*0.0012);

          // Zoom blur: radial motion blur pulsed by beat — air-rush feel
          if(zoomBlurAmt>0.001){
            vec3 zb=zoomBlurSample(tDiffuse,sampleUv,zoomBlurAmt);
            scene=mix(scene,zb,0.55);
          }

          // --- Optical edge: Fresnel refraction + dispersion ---
          if(edgeFactor>0.02){
            float eps=0.003;
            vec2 dR=distortWithEdge(uv+vec2(eps,0.0)).xy;
            vec2 dD=distortWithEdge(uv+vec2(0.0,eps)).xy;
            vec2 grad=vec2(length(dR-dUv.xy),length(dD-dUv.xy));
            vec2 refDir=normalize(vec2(-grad.y,grad.x)+1e-5);
            float sp=0.008*edgeFactor*kaleidoMix*(0.65+prismAmt*0.85);

            // 3-channel spectral dispersion at edges
            float eR=texture2D(tDiffuse,finalUv+refDir*sp*1.5).r;
            float eG=texture2D(tDiffuse,finalUv).g;
            float eB=texture2D(tDiffuse,finalUv-refDir*sp*1.5).b;
            vec3 edgeSpec=vec3(eR,eG,eB);

            // Fresnel: thin, bright, physically-based
            float fresnel=pow(edgeFactor,2.5)*(0.35+0.35*prismAmt)*kaleidoMix;

            scene=mix(scene,edgeSpec,edgeFactor*0.65*kaleidoMix);
            scene+=fresnel*vec3(1.0,0.98,0.95);
          }

          // Psychedelic hue rotation: edges shift color over time
          float hueOff=edgeFactor*(0.65+0.3*prismAmt)+sin(time*0.3+length(uv-0.5)*4.0)*(0.08+0.12*prismAmt);
          scene=mix(scene,hueShift(scene,hueOff),edgeFactor*0.35*kaleidoMix);
          // Optical forward scattering from center (clean prism haze)
          vec3 scatter=radialScatter(tDiffuse,finalUv,(0.55+0.45*kaleidoMix)*prismAmt);
          scene+=scatter*(0.07+0.06*prismAmt);

          // Natural bloom: multi-scale radial disc samples with soft-knee threshold
          // Soft knee: smooth transition instead of hard cutoff — preserves color
          float sceneLuma=luma(scene);
          float knee=smoothstep(bloomThreshold*0.6,bloomThreshold*1.6,sceneLuma);
          vec3 bloomSrc=scene*knee; // self-contribution from bright center pixel

          // Radial disc samples at 3 scales (near/mid/far) with golden-angle distribution
          // This creates natural circular light diffusion like a real lens
          vec3 bloomNear=vec3(0.0), bloomMid=vec3(0.0), bloomFar=vec3(0.0);
          float nearW=0.0, midW=0.0, farW=0.0;
          // 6 samples on inner ring (r≈3px), 6 on mid ring (r≈8px), 6 on outer ring (r≈16px)
          for(float i=0.0;i<6.0;i+=1.0){
            float ang=i*2.39996+time*0.04; // golden angle rotation
            vec2 dir=vec2(cos(ang),sin(ang));
            // Near ring: tight detail bloom
            vec2 offN=dir*3.5/resolution;
            vec3 sN=texture2D(tDiffuse,clamp(finalUv+offN,0.003,0.997)).rgb;
            float wN=smoothstep(bloomThreshold*0.7,bloomThreshold*1.5,luma(sN));
            bloomNear+=sN*wN; nearW+=1.0;
            // Mid ring: smooth spread
            vec2 offM=dir*9.0/resolution;
            vec3 sM=texture2D(tDiffuse,clamp(finalUv+offM,0.003,0.997)).rgb;
            float wM=smoothstep(bloomThreshold*0.8,bloomThreshold*1.8,luma(sM));
            bloomMid+=sM*wM; midW+=1.0;
            // Far ring: wide soft halo
            vec2 offF=dir*20.0/resolution;
            vec3 sF=texture2D(tDiffuse,clamp(finalUv+offF,0.003,0.997)).rgb;
            float wF=smoothstep(bloomThreshold,bloomThreshold*2.2,luma(sF));
            bloomFar+=sF*wF; farW+=1.0;
          }
          bloomNear/=max(nearW,1.0);
          bloomMid/=max(midW,1.0);
          bloomFar/=max(farW,1.0);
          // Combine scales: near bright + mid softer + far very soft = natural falloff
          vec3 bloom=bloomSrc*0.28+bloomNear*0.38+bloomMid*0.24+bloomFar*0.14;
          bloom*=bloomStrength;

          vec3 col=scene+bloom;

          // Lens DOF: soft bokeh at screen edges, sharp center
          if(lensBlurAmt>0.08){
            float edgeDist=length(vUv-0.5);
            float dofMask=smoothstep(0.12,0.52,edgeDist);
            if(dofMask>0.008){
              vec3 dof=lensDOF(tDiffuse,sampleUv,resolution,lensBlurAmt);
              col=mix(col,dof+bloom*0.25,dofMask*0.32);
            }
          }

          // Lens flare: ghost reflections from bright spots + central aura + impact glow
          if(lensFlareAmt>0.008){
            vec3 flare=vec3(0.0);
            for(float i=1.0;i<=2.0;i+=1.0){
              float sc=-0.28*i;
              vec2 gUv=clamp(0.5+(sampleUv-0.5)*sc,0.003,0.997);
              vec3 ghost=texture2D(tDiffuse,gUv).rgb;
              float gb=smoothstep(0.24,0.68,luma(ghost));
              vec3 tint=hueToRgb(themeHue+0.14*i);
              flare+=ghost*gb*tint*(0.07/i);
            }
            // Central aura glow (reuse scene instead of extra texture read)
            float aura=exp(-length(vUv-0.5)*3.6);
            float cBright=luma(scene);
            flare+=hueToRgb(themeHue+0.05)*aura*cBright*0.04;
            // Beat-reactive center bloom halo — tinted, not white
            float impactAura=exp(-length(vUv-0.5)*2.4)*impactFlash;
            flare+=hueToRgb(themeHue+0.08)*impactAura*0.12;
            col+=flare*lensFlareAmt;
          }

          // Anamorphic horizontal streak: blue-gold through bright areas
          if(anamorphicAmt>0.008){
            float brightSrc=dot(scene,vec3(0.2126,0.7152,0.0722));
            float streakMask=smoothstep(0.52,0.88,brightSrc);
            float stepX=18.0/resolution.x;
            vec3 s0=texture2D(tDiffuse,clamp(vec2(vUv.x-2.0*stepX,vUv.y),vec2(0.003),vec2(0.997))).rgb;
            vec3 s1=texture2D(tDiffuse,clamp(vec2(vUv.x-stepX,vUv.y),vec2(0.003),vec2(0.997))).rgb;
            vec3 s2=scene;
            vec3 s3=texture2D(tDiffuse,clamp(vec2(vUv.x+stepX,vUv.y),vec2(0.003),vec2(0.997))).rgb;
            vec3 s4=texture2D(tDiffuse,clamp(vec2(vUv.x+2.0*stepX,vUv.y),vec2(0.003),vec2(0.997))).rgb;
            float w0=exp(-2.0*0.55),w1=exp(-0.55),w2=1.0;
            vec3 streak=(s0*w0+s1*w1+s2*w2+s3*w1+s4*w0)/(w0*2.0+w1*2.0+w2);
            vec3 streakTint=mix(vec3(0.72,0.88,1.0),vec3(1.0,0.90,0.65),vUv.x);
            col+=streakTint*streak*streakMask*anamorphicAmt*0.18;
          }

          // Soft peripheral glow: subtle color-tinted, not white
          {
            float edgeR=length(vUv-0.5);
            float edgeGlow=smoothstep(0.42,0.78,edgeR)*(1.0-smoothstep(0.78,1.08,edgeR));
            vec3 edgeTint=hueToRgb(themeHue+0.12)*0.7+vec3(0.3,0.28,0.26);
            float edgePulse=0.015+0.008*sin(time*0.35)+0.012*audioLevel;
            col+=edgeTint*edgeGlow*edgePulse;
          }

          // === PRISMATIC STARBURST: multi-layered spectral rays ===
          vec2 rc=uv-0.5;
          float rr=length(rc);
          float ra=atan(rc.y,rc.x);
          float rayCount=max(8.0,kaleidoFolds*0.55+7.0);
          float rays=pow(max(0.0,cos(ra*rayCount+time*0.38+sin(rr*22.0-time*0.7))),7.0);
          float rays2=pow(max(0.0,cos(ra*(rayCount*2.0-1.0)-time*0.55+cos(rr*16.0+time*0.5))),12.0);
          float raysR=pow(max(0.0,cos((ra-0.02)*rayCount+time*0.38+sin(rr*22.0-time*0.7))),7.0);
          float raysB=pow(max(0.0,cos((ra+0.02)*rayCount+time*0.38+sin(rr*22.0-time*0.7))),7.0);
          float rayMask=smoothstep(0.04,0.65,rr)*(1.0-smoothstep(0.6,0.96,rr));
          vec3 rayCol;
          rayCol.r=raysR*0.9;
          rayCol.g=rays*0.85;
          rayCol.b=raysB*0.8;
          rayCol*=mix(hueToRgb(themeHue+0.08),hueToRgb(themeHue+0.28),0.5+0.5*sin(time*0.2));
          rayCol+=hueToRgb(themeHue+0.5)*rays2*0.35;
          col+=rayCol*rayMask*(0.06+0.14*prismAmt);

          // Contrast + saturation (premium, controlled)
          float l=luma(col);
          float contrastHi=clamp((contrastBoost-1.0)/1.8,0.0,1.0);
          col=mix(vec3(l),col,1.22+0.14*contrastHi);
          col=((col-0.5)*(contrastBoost+0.12+0.24*contrastHi))+0.5;
          col=max(col,0.0);

          // Optic shoulder: smooth highlight compression — prevents white blowout
          float shoulder=smoothstep(0.50,1.1,l)*(0.28+0.12*contrastHi);
          col=mix(col,col/(1.0+col),shoulder);

          // --- Thematic layers: one palette, each effect has clear meaning ---
          // themeTint: soft saturation so overlays feel part of the scene, not pasted
          vec3 themeTint=mix(vec3(0.92,0.93,0.96),hueToRgb(themeHue),0.68);
          vec2 c=uv-0.5; float r=length(c); float a=atan(c.y,c.x);
          // Contour topography: mountain mass/height follows live volume.
          float reactiveVol=clamp(audioLevel,0.0,1.0);
          float bioMix=clamp(bioAmt,0.0,1.0);
          float mountainSize=0.16+0.2*reactiveVol;
          float mountainHeight=0.85+1.5*reactiveVol;
          vec2 p1=vec2(0.34+0.08*sin(time*0.18),0.46+0.04*cos(time*0.21));
          vec2 p2=vec2(0.63+0.07*cos(time*0.14+1.2),0.39+0.05*sin(time*0.17+0.7));
          vec2 p3=vec2(0.50+0.06*sin(time*0.11+2.2),0.63+0.04*cos(time*0.16+1.4));
          vec2 d1=(uv-p1)*vec2(1.2,0.95);
          vec2 d2=(uv-p2)*vec2(1.15,1.05);
          vec2 d3=(uv-p3)*vec2(1.3,1.0);
          float m1=exp(-dot(d1,d1)/(0.014+mountainSize*0.09));
          float m2=exp(-dot(d2,d2)/(0.012+mountainSize*0.08));
          float m3=exp(-dot(d3,d3)/(0.011+mountainSize*0.07));
          float ridgeNoise=0.14*sin((uv.x+uv.y)*26.0+time*0.28)+0.1*sin((uv.x-uv.y)*34.0-time*0.24);
          vec3 isoVor=voronoiShatter(uv+vec2(time*0.03,-time*0.026),6.0+reactiveVol*8.5);
          float isoRidge=(1.0-smoothstep(0.0,0.03,isoVor.z))*0.26;
          float mountain=(m1*1.0+m2*0.82+m3*0.68+ridgeNoise*0.26+isoRidge)*mountainHeight;
          float contourDensity=mix(16.0,34.0,reactiveVol);
          float contourMajor=(1.0-smoothstep(0.0,0.032,abs(fract(mountain*contourDensity)-0.5)))*0.56;
          float contourMinor=(1.0-smoothstep(0.0,0.018,abs(fract(mountain*contourDensity*0.46+0.18)-0.5)))*0.3;
          float contourRadial=(1.0-smoothstep(0.0,0.018,abs(fract((r*20.0+sin(a*3.0))*0.6)-0.5)))*0.2;
          float contourIrregular=(1.0-smoothstep(0.0,0.02,abs(fract((mountain+isoRidge*3.0)*(11.0+reactiveVol*9.0))-0.5)))*0.34;
          float contour=contourMajor+contourMinor+contourRadial+contourIrregular;
          float contourIntent=0.16+flowAmt*0.62+bioMix*0.34+reactiveVol*0.2-shearAmt*0.1;
          float contourMask=smoothstep(0.32,0.84,contourIntent);
          vec2 mGrad=vec2(dFdx(mountain),dFdy(mountain));
          float slope=clamp(length(mGrad)*26.0,0.0,1.0);
          float ridgeLight=pow(1.0-slope,2.0)*(0.08+0.12*reactiveVol);
          float slopeShade=slope*(0.03+0.05*reactiveVol);
          col+=contour*themeTint*contourMask*(0.028+flowAmt*0.04+textureLayerMix*0.024+reactiveVol*0.03);
          col+=themeTint*ridgeLight*(0.03+0.022*flowAmt+0.015*contourMask);
          col-=vec3(0.01,0.009,0.007)*slopeShade*contourMask;

          // Grid: rhythm / lattice — fades from center so focus stays on content
          float grid=0.0;
          vec2 g=uv*resolution.xy*0.16;
          float radialFade=1.0-smoothstep(0.14,0.52,r);
          grid+=(1.0-smoothstep(0.0,0.055,abs(fract(g.x)-0.5)))*radialFade;
          grid+=(1.0-smoothstep(0.0,0.055,abs(fract(g.y)-0.5)))*radialFade;
          col+=grid*themeTint*(0.055+shearAmt*0.05+textureLayerMix*0.03);
          // Matrix veil: adds richness without clutter, tied to wave/shear and loudness.
          vec2 mv=uv*resolution.xy*0.095+vec2(time*0.24,-time*0.2);
          float matrixVeil=(1.0-smoothstep(0.0,0.045,abs(fract(mv.x)-0.5)))*(1.0-smoothstep(0.0,0.16,abs(fract(mv.y)-0.5)));
          col+=matrixVeil*themeTint*(0.018+0.03*shearAmt+0.026*waveAmt+0.02*reactiveVol);
          // Outer scattered prism shell: replaces excessive contour slicing at frame edge.
          float outerBand=smoothstep(0.58,0.9,r)*(1.0-smoothstep(0.9,1.05,r));
          vec2 edgeCell=floor((uv-0.5)*vec2(78.0,78.0));
          float edgeHash=hash2(edgeCell+floor(time*0.8));
          float edgeSpark=step(0.935,edgeHash)*(0.45+0.55*sin(time*0.72+edgeHash*15.0+r*24.0));
          float prismScatter=edgeSpark*outerBand;
          vec3 prismTint=mix(hueToRgb(themeHue+0.11),hueToRgb(themeHue+0.56),fract(edgeHash*3.7));
          col+=prismTint*prismScatter*(0.026+0.075*prismAmt+0.02*reactiveVol);
          // Avant-garde caustic matrix: dense in outer-middle ring, clean center preserved.
          vec2 cc=uv-0.5;
          float ang=0.28*sin(time*0.38+1.0)+0.06*audioLevel;
          vec2 rotCoord=vec2(cc.x*cos(ang)-cc.y*sin(ang),cc.x*sin(ang)+cc.y*cos(ang));
          vec2 cm=rotCoord*vec2(82.0,62.0)+vec2(time*0.34,-time*0.29);
          float lineA=1.0-smoothstep(0.0,0.02,abs(fract(cm.x)-0.5));
          float lineB=1.0-smoothstep(0.0,0.018,abs(fract(cm.y)-0.5));
          float causticBand=smoothstep(0.22,0.9,r)*(1.0-smoothstep(0.86,1.15,r));
          float caustic=(lineA*0.64+lineB*0.52)*causticBand;
          float shardBlink=step(0.928,hash2(floor(cm*0.7)+floor(time*1.6)))*(0.72+0.28*sin(time*0.9+r*16.0));
          vec3 causticTint=mix(hueToRgb(themeHue+0.2),vec3(0.95,0.98,1.0),0.42);
          col+=causticTint*caustic*(0.012+0.044*prismAmt+0.018*reactiveVol);
          col+=causticTint*shardBlink*causticBand*(0.01+0.022*prismAmt);

          // Organic layer: microorganism / cell membranes, tied to profile bio amount.
          if(bioMix>0.01){
            float cdens=mix(6.0,13.5,bioMix);
            vec2 cuv=uv+vec2(0.03*flowAmt*sin(time*0.22),0.025*waveAmt*cos(time*0.18));
            vec3 cell=cellularField(cuv,cdens,time);
            float membrane=cell.x;
            float nucleus=cell.y;
            vec3 bioTint=mix(hueToRgb(themeHue+0.16),themeTint,0.62);
            col+=bioTint*membrane*(0.012+0.05*bioMix+0.025*reactiveVol);
            col+=mix(vec3(0.9,0.97,1.0),bioTint,0.45)*nucleus*(0.008+0.028*bioMix);
          }

          // Heart: emotional pulse — only when pulse profile is active, gentle glow
          float heart=0.0;
          vec2 hp=uv-vec2(0.5,0.48+0.02*sin(time*0.3));
          float hx=hp.x*1.4; float hy=hp.y*1.2+0.08;
          float heartEq=pow(hx*hx+hy*hy-0.28,3.0)-hx*hx*hy*hy*hy*0.9;
          heart=(1.0-smoothstep(0.0,0.024,abs(heartEq)))*(0.5+0.5*sin(time*0.5));
          col+=heart*themeTint*(0.09*pulseAmt+textureLayerMix*0.04);

          if(textureLayerMix>0.005){
            float glyph=0.0;
            vec2 cellOff=hash2v(vec2(floor(time*0.5),0.0))*10.0;
            vec2 cell=floor(uv*vec2(32.0,18.0)+cellOff);
            float gx=hash2(cell); float gy=hash2(cell+vec2(1.0,0.0));
            vec2 local=fract(uv*vec2(32.0,18.0)+cellOff)-0.5;
            if(gx>0.92) glyph+=(1.0-smoothstep(0.02,0.04,abs(local.x)))*(1.0-smoothstep(0.05,0.15,abs(local.y)));
            if(gy>0.94) glyph+=1.0-smoothstep(0.01,0.03,length(local-vec2(0.1,0)));
            col+=glyph*themeTint*textureLayerMix*0.048;
            float arch=0.0;
            vec2 vp=vec2(0.5+0.12*sin(time*0.2),0.48);
            vec2 toC=uv-vp;
            for(float i=0.0;i<6.0;i+=1.0){
              float ang=i*0.33+time*0.05;
              vec2 rayDir=vec2(cos(ang),sin(ang));
              float distToRay=abs(toC.x*rayDir.y-toC.y*rayDir.x);
              float along=dot(toC,rayDir);
              float rayLine=1.0-smoothstep(0.0,0.006,distToRay);
              float rayAlong=smoothstep(0.0,0.05,along);
              float rayRadial=1.0-smoothstep(0.5,0.95,r*2.0);
              arch+=rayLine*rayAlong*rayRadial;
            }
            col+=arch*themeTint*textureLayerMix*0.038;
          }

          // Screen / cyber texture: analog computer aesthetics with clean control.
          float noiseSeed=hash2(floor(uv*resolution*0.82)+vec2(floor(time*47.0),floor(time*53.0)));
          float grain=(noiseSeed-0.5)*(0.0028+0.0075*analogMix);
          float scan=sin(uv.y*resolution.y*3.14159*(1.0+0.42*analogMix))*(0.0018+0.0056*analogMix);
          float crt=sin(uv.y*resolution.y*(1.0+0.25*analogMix)+time*(12.0+10.0*analogMix))*(0.0012+0.0038*analogMix);
          float pxX=1.0-smoothstep(0.0,0.05,abs(fract(uv.x*resolution.x*(0.2+0.3*pixelateMix))-0.5));
          float pxY=1.0-smoothstep(0.0,0.07,abs(fract(uv.y*resolution.y*(0.18+0.28*pixelateMix))-0.5));
          float pixelGrid=pxX*pxY;
          float glitchBand=step(0.89,hash1(floor(uv.y*56.0)+floor(time*(6.0+analogMix*8.0))));
          float vRoll=fract(uv.y+time*(0.018+0.06*analogMix));
          float rollBand=exp(-pow((vRoll-0.03)*34.0,2.0));
          vec3 cyberTint=mix(hueToRgb(themeHue+0.58),vec3(0.55,0.96,1.0),0.58);
          vec3 ghost=prismCA(tDiffuse,vec2(clamp(sampleUv.x+scan*2.8,0.003,0.997),sampleUv.y),chromaticOffset*0.45);
          col=mix(col,ghost,0.1*analogMix+0.1*glitchAmt);
          col+=grain+scan+crt;
          col+=cyberTint*pixelGrid*(0.01+0.03*pixelateMix+0.018*glitchAmt+0.018*textureLayerMix);
          col+=cyberTint*glitchBand*(0.004+0.016*glitchAmt+0.008*analogMix)*(1.0-smoothstep(0.0,0.46,abs(uv.x-0.5)));
          col+=cyberTint*rollBand*(0.008+0.028*analogMix+0.014*glitchAmt);
          float stripe=fract(uv.x*resolution.x*0.34);
          vec3 phosphor=vec3(
            0.86+0.2*(1.0-smoothstep(0.0,0.34,abs(stripe-0.16))),
            0.86+0.2*(1.0-smoothstep(0.0,0.34,abs(stripe-0.5))),
            0.86+0.2*(1.0-smoothstep(0.0,0.34,abs(stripe-0.84)))
          );
          col*=mix(vec3(1.0),phosphor,0.26*subpixelMix+0.22*analogMix);

          // === DRUM SHOCK: spectral shockwave explosion ===
          if(impactFlash>0.001){
            float imp=smoothstep(0.0,1.0,impactFlash);
            float mono=dot(col,vec3(0.299,0.587,0.114));
            vec3 bw=vec3(mono);
            vec3 inv=vec3(1.0-mono);
            float rr=length((uv-0.5)*vec2(1.0,1.25));

            // Expanding shockwave ring with spectral dispersion
            float ringPos=0.95-imp*0.65;
            float ringR=exp(-pow((rr*2.9-ringPos)*4.0,2.0));
            float ringG=exp(-pow((rr*2.9-ringPos*1.05)*4.0,2.0));
            float ringB=exp(-pow((rr*2.9-ringPos*0.95)*4.0,2.0));
            vec3 specRing=vec3(ringR,ringG,ringB);

            // Radial fracture lines from center
            float fracAngle=atan(uv.y-0.5,uv.x-0.5);
            float fractures=pow(max(0.0,sin(fracAngle*12.0+rr*30.0)),8.0);
            float fracMask=smoothstep(0.0,ringPos*0.35,rr)*(1.0-smoothstep(ringPos*0.35,ringPos+0.1,rr));

            // Temporal echo: ghosted copies at slightly offset positions
            vec2 echoDir=normalize(uv-0.5+1e-5);
            vec3 echo1=texture2D(tDiffuse,clamp(uv-echoDir*0.02*imp,0.003,0.997)).rgb;
            vec3 echo2=texture2D(tDiffuse,clamp(uv-echoDir*0.04*imp,0.003,0.997)).rgb;
            vec3 echoMix=mix(echo1,echo2,0.5)*imp*0.25;

            col=mix(col,bw,imp*0.28);
            col=mix(col,inv,imp*(0.5+0.3*max(ringR,max(ringG,ringB))));
            col+=hueToRgb(themeHue+0.1)*specRing*imp*0.5;
            col+=hueToRgb(themeHue+0.5)*fractures*fracMask*imp*0.3;
            col+=echoMix;
            col+=vec3(0.3,0.35,0.4)*imp*(0.3+0.7*max(ringR,max(ringG,ringB)));
          }

          // Light leak: overexposure at top-left and bottom-right corners
          if(lightLeakAmt>0.005){
            float leak1=exp(-length((vUv-vec2(0.0,1.0))*vec2(1.4,1.8))*2.8);
            float leak2=exp(-length((vUv-vec2(1.0,0.0))*vec2(1.4,1.8))*3.2);
            vec3 leakTint1=mix(vec3(1.0,0.82,0.58),hueToRgb(themeHue+0.1),0.3);
            vec3 leakTint2=mix(vec3(0.62,0.78,1.0),hueToRgb(themeHue+0.6),0.3);
            col+=leakTint1*leak1*lightLeakAmt*0.22;
            col+=leakTint2*leak2*lightLeakAmt*0.18;
          }

          // Vignette + center lift: keep composition focused and readable
          float vig=1.0-smoothstep(0.14,0.92,length((uv-0.5)*1.74));
          float centerLift=1.0+0.11*(1.0-smoothstep(0.0,0.34,length(uv-0.5)));
          col*=mix(0.50,1.0,vig);
          col*=centerLift;

          // Full-screen effects (no letterbox)

          // ACES tone mapping
          col=(col*(2.51*col+0.03))/(col*(2.43*col+0.59)+0.14);

          // Cinematic grading: three-stop — deep teal shadows, neutral mids, warm amber highlights
          float ll=luma(col);
          float shadowMask=smoothstep(0.25,0.0,ll);
          float highlightMask=smoothstep(0.5,0.9,ll);
          float midMask=1.0-shadowMask-highlightMask;
          col*=vec3(0.72,0.90,1.22)*shadowMask+vec3(0.96,0.97,0.99)*midMask+vec3(1.18,1.06,0.82)*highlightMask;

          // Final polish: gentle S-curve — preserves color, no white clipping
          vec3 col01=clamp(col,0.0,1.0);
          vec3 cCurve=smoothstep(vec3(0.03),vec3(0.98),col01);
          col=mix(col01,cCurve,0.22+0.28*contrastHi);
          col=((col-0.5)*(1.0+0.12+0.18*contrastHi))+0.5;
          col=max(col,0.0);
          if(pixelateMix>0.01){
            float cSteps=mix(280.0,64.0,pixelateMix);
            col=floor(col*cSteps+0.5)/cSteps;
          }

          // Rhythmic blink: very subtle (avoid overexposure)
          float blink=0.5+0.5*sin(time*0.55);
          col*=1.0+0.018*smoothstep(0.2,0.8,blink);
          col*=0.93;

          // Letterbox: cinematic bars (soft-edge)
          if(letterboxAmt>0.001){
            float barH=0.10*letterboxAmt;
            float barMask=smoothstep(barH,barH*0.6,vUv.y)
                         +smoothstep(1.0-barH,1.0-barH*0.6,vUv.y);
            col=mix(col,vec3(0.0),barMask);
          }

          gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);
        }
      `,
      depthWrite: false
    });
    const postGeo = new THREE.PlaneGeometry(2, 2);
    postQuad = new THREE.Mesh(postGeo, postMat);
    postScene.add(postQuad);

    try {
      gpuCompute = new GPUComputationRenderer(W, W, renderer);
      if (!renderer.capabilities.isWebGL2 && !renderer.extensions.has('OES_texture_float')) {
        throw new Error('Float texture not supported');
      }
      if (renderer.capabilities.maxVertexTextures === 0) {
        throw new Error('Vertex texture not supported');
      }

      const posTex = gpuCompute.createTexture();
      const velTex = gpuCompute.createTexture();
      const posData = posTex.image.data;
      const velData = velTex.image.data;
      for (let i = 0; i < N; i++) {
        posData[i * 4] = (Math.random() - 0.5) * 2 * BOX_HALF * 0.9;
        posData[i * 4 + 1] = (Math.random() - 0.5) * 2 * BOX_HALF * 0.9;
        posData[i * 4 + 2] = (Math.random() - 0.5) * 2 * BOX_HALF * 0.9;
        posData[i * 4 + 3] = 1;
        velData[i * 4] = (Math.random() - 0.5) * 0.02;
        velData[i * 4 + 1] = (Math.random() - 0.5) * 0.02;
        velData[i * 4 + 2] = (Math.random() - 0.5) * 0.02;
        velData[i * 4 + 3] = 1;
      }
      posTex.needsUpdate = true;
      velTex.needsUpdate = true;

      velocityVariable = gpuCompute.addVariable('textureVelocity', velocityShader, velTex);
      positionVariable = gpuCompute.addVariable('texturePosition', positionShader, posTex);
      velocityVariable.material.uniforms.time = { value: 0 };
      velocityVariable.material.uniforms.attractor = { value: new THREE.Vector3(0, 0, 0) };
      velocityVariable.material.uniforms.attractorStrength = { value: 0 };
      velocityVariable.material.uniforms.attractorCol = { value: 0 };
      velocityVariable.material.uniforms.attractorRow = { value: 1 };
      gpuCompute.setVariableDependencies(velocityVariable, [positionVariable, velocityVariable]);
      gpuCompute.setVariableDependencies(positionVariable, [positionVariable, velocityVariable]);
      const err = gpuCompute.init();
      if (err) throw new Error(err);
      useGPGPU = true;
    } catch (e) {
      console.warn('GPGPU init failed, using fallback:', e && e.message ? e.message : e);
      useGPGPU = false;
      gpuCompute = null;
      positionVariable = null;
      velocityVariable = null;
    }

    if (useGPGPU) {
      const pointsGeo = new THREE.BufferGeometry();
      const uvs = new Float32Array(N * 2);
      const positions = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        uvs[i * 2] = (i % W) / W;
        uvs[i * 2 + 1] = Math.floor(i / W) / W;
      }
      pointsGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      pointsGeo.setAttribute('particleUV', new THREE.BufferAttribute(uvs, 2));
      pointsGeo.setDrawRange(0, N);

      const pointsMat = new THREE.ShaderMaterial({
        uniforms: {
          positionTexture: { value: null },
          time: { value: 0 },
          keyHue: { value: 0.55 },
          sparkleFlash: { value: 0 },
          padLevel: { value: 0 },
          attractorCol: { value: 0 }
        },
        vertexShader: `
          attribute vec2 particleUV;
          uniform sampler2D positionTexture;
          uniform float time;
          uniform float attractorCol;
          varying float vDepth;
          varying float vId;
          varying vec3 vWorldPos;
          varying float vMorphClass;
          void main() {
            vec4 pos = texture2D( positionTexture, particleUV );
            vWorldPos = pos.xyz;
            vec4 mvPos = modelViewMatrix * vec4( pos.xyz, 1.0 );
            float depth = 1.0 / max(0.1, -mvPos.z);
            vDepth = -mvPos.z;
            vId = particleUV.x * 128.0 + particleUV.y * 16384.0;
            float idHash = fract(sin(vId * 43.7) * 4375.5453);
            // morphClass driven by note (attractorCol 0-11) — each note = unique visual
            vMorphClass = floor(mod(attractorCol + idHash * 2.0, 12.0));
            // Size varies per morphology type
            float sizeVar = 0.7 + idHash * 0.5;
            float mc = vMorphClass;
            if(mc < 0.5) sizeVar *= 1.5;        // C: Prismatic Supernova
            else if(mc < 1.5) sizeVar *= 1.2;   // C#: Quantum Crystal
            else if(mc < 2.5) sizeVar *= 1.3;   // D: Cosmic Eye
            else if(mc < 3.5) sizeVar *= 1.7;   // D#: Black Hole
            else if(mc < 4.5) sizeVar *= 1.1;   // E: Lightning Swarm
            else if(mc < 5.5) sizeVar *= 1.4;   // F: Nebula Bloom
            else if(mc < 6.5) sizeVar *= 1.0;   // F#: Diamond Shard
            else if(mc < 7.5) sizeVar *= 1.6;   // G: Solar Flare
            else if(mc < 8.5) sizeVar *= 1.3;   // G#: Vortex Ring
            else if(mc < 9.5) sizeVar *= 1.2;   // A: Fractal Frost
            else if(mc < 10.5) sizeVar *= 1.5;  // A#: Plasma Cell
            else sizeVar *= 1.4;                 // B: Sacred Geometry
            float breathe = 1.0 + 0.22 * sin(time * 0.8 + idHash * 6.28);
            gl_PointSize = 0.20 * depth * sizeVar * breathe;
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: `
          #define PI 3.14159265359
          #define TAU 6.28318530718
          uniform float time;
          uniform float keyHue;
          uniform float sparkleFlash;
          uniform float padLevel;
          uniform float attractorCol;
          varying float vDepth;
          varying float vId;
          varying vec3 vWorldPos;
          varying float vMorphClass;
          vec3 hueToRgb(float h){
            vec3 k=vec3(1.0,2.0/3.0,1.0/3.0);
            return clamp(abs(fract(vec3(h)+k)*6.0-3.0)-1.0,0.0,1.0);
          }
          float hash(float n){ return fract(sin(n)*43758.5453); }
          float noise2(vec2 p){
            vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
            float a=hash(dot(i,vec2(127.1,311.7)));
            float b=hash(dot(i+vec2(1.0,0.0),vec2(127.1,311.7)));
            float c=hash(dot(i+vec2(0.0,1.0),vec2(127.1,311.7)));
            float dd=hash(dot(i+vec2(1.0,1.0),vec2(127.1,311.7)));
            return mix(mix(a,b,f.x),mix(c,dd,f.x),f.y);
          }

          // SDF primitives
          float sdHex(vec2 p){ p=abs(p); return max(p.x*0.866+p.y*0.5,p.y)-0.5; }
          float sdStar(vec2 p, float n, float r){
            float a=atan(p.y,p.x)/TAU*n; float seg=floor(a+0.5); a=a-seg;
            return length(p)*cos((abs(a)-0.25)*TAU/n)-r;
          }
          float sdTriangle(vec2 p){
            p.y+=0.16; float k=sqrt(3.0); p.x=abs(p.x)-0.5; p.y+=0.5/k;
            if(p.x+k*p.y>0.0) p=vec2(p.x-k*p.y,-k*p.x-p.y)/2.0;
            p.x-=clamp(p.x,-2.0,0.0); return -length(p)*sign(p.y);
          }
          float sdPentagon(vec2 p){
            float a=atan(p.y,p.x)/TAU*5.0; float seg=floor(a+0.5); a=a-seg;
            return length(p)*cos((abs(a)-0.2)*TAU/5.0)-0.38;
          }

          void main(){
            vec2 u=gl_PointCoord-0.5;
            float d=length(u);
            if(d>0.5) discard;
            float angle=atan(u.y,u.x);
            float idH=hash(vId);
            float idH2=hash(vId+7.3);
            float idH3=hash(vId+19.1);
            float mc=vMorphClass;

            // ========== C (0): PRISMATIC SUPERNOVA — RGB-split explosion with spectral rays ==========
            if(mc<0.5){
              float dispersion=0.28+0.18*sin(time*0.35+idH*TAU);
              float spectral=fract((angle/PI)*0.5+dispersion*d*3.0);
              vec3 R=hueToRgb(keyHue-0.12+spectral*0.35);
              vec3 G=hueToRgb(keyHue+0.08+spectral*0.25);
              vec3 B=hueToRgb(keyHue+0.28+spectral*0.4);
              float rD=length(u+vec2(0.04*dispersion,0.015*dispersion));
              float bD=length(u-vec2(0.04*dispersion,-0.015*dispersion));
              vec3 col=R*(1.0-smoothstep(0.0,0.44,rD))*0.95
                      +G*(1.0-smoothstep(0.0,0.42,d))*0.9
                      +B*(1.0-smoothstep(0.0,0.40,bD))*0.85;
              float rays=pow(max(0.0,cos(angle*7.0+time*2.5+idH*9.0)),5.0);
              col+=hueToRgb(keyHue+0.15)*rays*(1.0-d*1.8)*0.6;
              float core=1.0-smoothstep(0.0,0.10,d);
              col+=vec3(1.0,0.95,0.85)*core*core*1.0;
              col+=sparkleFlash*hueToRgb(keyHue+0.5)*0.9;
              gl_FragColor=vec4(col,(1.0-smoothstep(0.0,0.5,d))*0.92); return;
            }

            // ========== C# (1): QUANTUM CRYSTAL — rotating octagonal facets with inner prismatic refraction ==========
            if(mc<1.5){
              float rot=time*0.5+idH*TAU;
              float cs=cos(rot),sn=sin(rot);
              vec2 ru=vec2(u.x*cs-u.y*sn,u.x*sn+u.y*cs);
              // Octagon SDF
              vec2 ap=abs(ru)*2.4;
              float octD=max(max(ap.x,ap.y),(ap.x+ap.y)*0.7071)-0.55;
              if(octD>0.06) discard;
              float edge=1.0-smoothstep(0.0,0.04,abs(octD));
              float fill=1.0-smoothstep(-0.06,0.0,octD);
              // Prismatic facets: triple overlapping grids
              float f1=abs(sin(ru.x*22.0+time*1.4))*abs(cos(ru.y*22.0-time));
              float f2=abs(sin((ru.x*0.7+ru.y*0.7)*18.0+time*0.8));
              float f3=abs(sin((ru.x*0.7-ru.y*0.7)*14.0-time*1.2));
              vec3 col=hueToRgb(keyHue+f1*0.3)*fill*0.5;
              col+=hueToRgb(keyHue+0.33+f2*0.2)*fill*f2*0.35;
              col+=hueToRgb(keyHue+0.67+f3*0.15)*fill*f3*0.25;
              col+=hueToRgb(keyHue+0.5)*edge*0.9;
              col+=vec3(0.95,1.0,1.0)*(1.0-smoothstep(0.0,0.03,d))*0.7;
              col+=sparkleFlash*vec3(1.0)*0.6;
              gl_FragColor=vec4(col,fill*0.88); return;
            }

            // ========== D (2): COSMIC EYE — layered iris with spiral fibers and void pupil ==========
            if(mc<2.5){
              float irisR=0.24+0.06*sin(time*0.5+idH*5.0);
              float pupil=1.0-smoothstep(0.0,0.07,d);
              float iris=exp(-pow((d-irisR)*9.0,2.0));
              float fibers=sin(angle*20.0+d*35.0-time*1.8)*0.5+0.5;
              float spiral=sin(angle*4.0+d*25.0+time*1.0)*0.5+0.5;
              float radialGlow=sin(angle*8.0-time*2.5)*0.5+0.5;
              vec3 irisCol=mix(hueToRgb(keyHue+0.05),hueToRgb(keyHue+0.4),fibers);
              irisCol=mix(irisCol,hueToRgb(keyHue+0.6),spiral*0.35);
              irisCol+=hueToRgb(keyHue+0.8)*radialGlow*iris*0.2;
              vec3 col=irisCol*iris*0.95;
              col=mix(col,vec3(0.01),pupil*0.92);
              float pupilRim=exp(-pow((d-0.055)*26.0,2.0));
              col+=hueToRgb(keyHue+0.65)*pupilRim*0.7;
              float outer=1.0-smoothstep(0.3,0.48,d);
              col+=hueToRgb(keyHue)*outer*0.12;
              col+=sparkleFlash*hueToRgb(keyHue+0.5)*iris*0.8;
              gl_FragColor=vec4(col,max(outer*0.5,iris)*0.9+pupil*0.5); return;
            }

            // ========== D# (3): BLACK HOLE — accretion disk, photon ring, gravitational lensing ==========
            if(mc<3.5){
              float diskAngle=angle+time*0.6+idH*TAU;
              float diskR=0.26+0.05*sin(diskAngle*2.0);
              float disk=exp(-pow((d-diskR)*11.0,2.0));
              float diskHot=exp(-pow((d-diskR*0.82)*15.0,2.0));
              float diskSpectral=fract(diskAngle/TAU+d*4.0);
              vec3 diskCol=hueToRgb(keyHue+diskSpectral*0.45)*disk*0.85;
              diskCol+=vec3(1.0,0.88,0.65)*diskHot*0.7;
              float eventH=1.0-smoothstep(0.0,0.09,d);
              float photonRing=exp(-pow((d-0.10)*30.0,2.0));
              float photonRing2=exp(-pow((d-0.13)*24.0,2.0));
              vec3 col=diskCol;
              col+=hueToRgb(keyHue+0.3)*photonRing*1.0;
              col+=hueToRgb(keyHue+0.55)*photonRing2*0.5;
              col=mix(col,vec3(0.0),eventH*0.97);
              float arcA=sin(angle*8.0-time*3.5+d*18.0)*0.5+0.5;
              float arcMask=smoothstep(0.11,0.17,d)*(1.0-smoothstep(0.33,0.45,d));
              col+=hueToRgb(keyHue+0.6)*arcA*arcMask*0.3;
              col+=sparkleFlash*vec3(1.0,0.95,0.85)*photonRing*1.3;
              gl_FragColor=vec4(col,(1.0-smoothstep(0.3,0.5,d))*0.88+disk*0.5); return;
            }

            // ========== E (4): LIGHTNING SWARM — 6-branch electric arcs with plasma glow ==========
            if(mc<4.5){
              float lightning=0.0;
              for(float b=0.0;b<6.0;b++){
                float bAngle=(b/6.0)*TAU+idH2*TAU+time*0.35;
                vec2 dir=vec2(cos(bAngle),sin(bAngle));
                float along=dot(u,dir);
                float perp=abs(u.x*dir.y-u.y*dir.x);
                float jag=sin(along*45.0+time*9.0+b*4.0)*0.014
                         +sin(along*90.0-time*14.0+b*8.0)*0.007
                         +sin(along*160.0+time*20.0)*0.003;
                float arc=exp(-pow((perp-jag)*50.0,2.0));
                float fade=smoothstep(-0.01,0.02,along)*(1.0-smoothstep(0.28,0.44,along));
                lightning+=arc*fade;
              }
              lightning=min(lightning,1.0);
              vec3 col=mix(hueToRgb(keyHue+0.55),vec3(0.92,0.96,1.0),lightning*0.65)*lightning;
              float core=1.0-smoothstep(0.0,0.08,d);
              col+=hueToRgb(keyHue+0.45)*core*0.6;
              float field=1.0-smoothstep(0.0,0.42,d);
              col+=hueToRgb(keyHue+0.3)*field*0.06;
              col+=sparkleFlash*vec3(1.0)*lightning*0.7;
              gl_FragColor=vec4(col,max(lightning*0.92,field*0.25)); return;
            }

            // ========== F (5): NEBULA BLOOM — volumetric gas cloud with emission filaments ==========
            if(mc<5.5){
              float n1=sin(u.x*14.0+time*0.4)*cos(u.y*16.0-time*0.35);
              float n2=sin((u.x+u.y)*9.0+time*0.6)*0.55;
              float n3=sin(u.x*28.0-time*1.2)*sin(u.y*24.0+time*0.85)*0.35;
              float n4=cos(u.x*6.0-u.y*8.0+time*0.3)*0.25;
              float density=0.55+n1*0.22+n2*0.16+n3*0.1+n4*0.08;
              density*=1.0-smoothstep(0.18,0.46,d);
              vec3 col=hueToRgb(keyHue+n1*0.18)*density*0.55;
              col+=hueToRgb(keyHue+0.35+n2*0.12)*density*density*0.45;
              col+=hueToRgb(keyHue+0.7)*pow(max(0.0,density),3.0)*0.35;
              float filament=pow(max(0.0,n1*n2),2.0)*density;
              col+=vec3(0.92,0.96,1.0)*filament*0.55;
              float rim=smoothstep(0.22,0.36,d)*(1.0-smoothstep(0.36,0.46,d));
              col+=hueToRgb(keyHue+0.18)*rim*0.25;
              col+=sparkleFlash*hueToRgb(keyHue+0.5)*density*0.7;
              col+=padLevel*0.15*hueToRgb(keyHue+0.25)*density;
              gl_FragColor=vec4(col,density*0.85); return;
            }

            // ========== F# (6): DIAMOND SHARD — sharp triangular facets with rainbow refraction ==========
            if(mc<6.5){
              float rot=time*0.35+idH*TAU;
              float cs=cos(rot),sn=sin(rot);
              vec2 ru=vec2(u.x*cs-u.y*sn,u.x*sn+u.y*cs);
              float triD=sdTriangle(ru*3.0);
              if(triD>0.06) discard;
              float edge=1.0-smoothstep(0.0,0.04,abs(triD));
              float fill=1.0-smoothstep(-0.06,0.0,triD);
              // Rainbow refraction through facets
              float refAngle=atan(ru.y,ru.x);
              float rainbow=fract(refAngle/TAU+d*5.0+time*0.2);
              vec3 col=hueToRgb(rainbow)*fill*0.55;
              // Internal fire
              float fire=abs(sin(ru.x*30.0+time*2.0))*abs(sin(ru.y*30.0-time*1.5));
              col+=hueToRgb(keyHue+fire*0.4)*fill*fire*0.4;
              col+=vec3(1.0,1.0,0.95)*edge*0.85;
              // Brilliant core
              float core=1.0-smoothstep(0.0,0.06,d);
              col+=vec3(1.0,0.98,0.92)*core*0.8;
              col+=sparkleFlash*hueToRgb(rainbow)*0.6;
              gl_FragColor=vec4(col,fill*0.9); return;
            }

            // ========== G (7): SOLAR FLARE — erupting corona with magnetic loops ==========
            if(mc<7.5){
              // Corona body
              float corona=1.0-smoothstep(0.0,0.35,d);
              float surface=1.0-smoothstep(0.0,0.15,d);
              // Magnetic loops: sinusoidal arches from surface
              float loops=0.0;
              for(float i=0.0;i<5.0;i++){
                float loopAngle=(i/5.0)*TAU+time*0.2+idH*3.0;
                float loopR=0.18+0.08*sin(time*0.5+i*1.3);
                vec2 loopCenter=vec2(cos(loopAngle),sin(loopAngle))*0.12;
                float loopD=abs(length(u-loopCenter)-loopR);
                float loopArc=exp(-loopD*loopD*800.0);
                float loopMask=smoothstep(0.1,0.16,length(u));
                loops+=loopArc*loopMask;
              }
              loops=min(loops,1.0);
              // Granulation texture
              float gran=noise2(u*60.0+vec2(time*2.0))*0.3;
              vec3 col=hueToRgb(keyHue-0.05)*(corona*0.5+gran*surface*0.3);
              col+=hueToRgb(keyHue+0.08)*surface*0.7;
              col+=vec3(1.0,0.92,0.7)*surface*surface*0.5;
              // Flare loops: hot white-yellow
              col+=mix(hueToRgb(keyHue+0.1),vec3(1.0,0.95,0.8),0.6)*loops*0.8;
              // Prominences: radial ejections
              float prom=pow(max(0.0,sin(angle*3.0+time*1.5)),8.0)*(1.0-smoothstep(0.2,0.45,d));
              col+=hueToRgb(keyHue+0.15)*prom*0.4;
              col+=sparkleFlash*vec3(1.0,0.9,0.7)*surface*0.8;
              gl_FragColor=vec4(col,(corona*0.8+loops*0.4+surface*0.3)*0.92); return;
            }

            // ========== G# (8): VORTEX RING — toroidal spiral with interference patterns ==========
            if(mc<8.5){
              // Torus: ring shape
              float torusR=0.22;
              float tubeR=0.10+0.02*sin(time*0.6);
              float ringD=abs(d-torusR);
              float torus=exp(-ringD*ringD/(tubeR*tubeR)*4.0);
              // Spiral windings around the tube
              float windAngle=angle*8.0+d*40.0-time*3.0+idH*TAU;
              float winding=sin(windAngle)*0.5+0.5;
              // Interference pattern
              float interf1=sin(angle*12.0+time*1.2)*0.5+0.5;
              float interf2=sin(d*50.0-time*2.5)*0.5+0.5;
              float pattern=interf1*interf2;
              vec3 col=hueToRgb(keyHue+winding*0.3)*torus*0.7;
              col+=hueToRgb(keyHue+0.4)*torus*pattern*0.4;
              col+=hueToRgb(keyHue+0.7)*(1.0-smoothstep(0.0,0.04,ringD))*0.5;
              // Inner void glow
              float inner=1.0-smoothstep(0.0,torusR-tubeR,d);
              col+=hueToRgb(keyHue+0.5)*inner*0.15;
              // Outer ripple
              float ripple=exp(-pow((d-0.38)*20.0,2.0));
              col+=hueToRgb(keyHue+0.2)*ripple*0.2;
              col+=sparkleFlash*hueToRgb(keyHue+0.6)*torus*0.7;
              gl_FragColor=vec4(col,(torus*0.85+inner*0.2+ripple*0.15)*0.9); return;
            }

            // ========== A (9): FRACTAL FROST — crystalline dendritic growth pattern ==========
            if(mc<9.5){
              // 6-fold symmetry: fold angle into sextant
              float fa=mod(angle+PI,TAU/6.0)-PI/6.0;
              vec2 su=vec2(cos(fa),sin(fa))*d;
              // Dendritic branches: hierarchical
              float branch=0.0;
              float scale=1.0;
              for(float i=0.0;i<4.0;i++){
                float bw=0.015*scale;
                float spine=exp(-pow(su.y/bw,2.0))*smoothstep(0.0,0.04,su.x)*(1.0-smoothstep(0.1*scale,0.35*scale,su.x));
                // Side branches
                float sideFreq=20.0+i*8.0;
                float sideAngle=sin(su.x*sideFreq+time*0.5+i*2.0)*0.3;
                float sideD=abs(su.y-sideAngle*su.x*0.3);
                float sideBranch=exp(-sideD*sideD/(bw*bw*0.5))*smoothstep(0.02,0.08,su.x)*(1.0-smoothstep(0.15*scale,0.3*scale,su.x));
                branch+=spine+sideBranch*0.6;
                scale*=0.7;
              }
              branch=min(branch,1.0);
              vec3 col=mix(hueToRgb(keyHue+0.55),vec3(0.85,0.95,1.0),0.5)*branch*0.8;
              col+=vec3(1.0,1.0,0.98)*(1.0-smoothstep(0.0,0.04,d))*0.5;
              // Frost shimmer
              float shimmer=hash(vId+floor(time*8.0))*branch;
              col+=vec3(0.9,0.95,1.0)*shimmer*0.3;
              col+=sparkleFlash*vec3(0.8,0.9,1.0)*branch*0.6;
              float alpha=branch*0.85+(1.0-smoothstep(0.0,0.06,d))*0.4;
              gl_FragColor=vec4(col,alpha*0.88); return;
            }

            // ========== A# (10): PLASMA CELL — organic cell membrane with mitosis animation ==========
            if(mc<10.5){
              // Cell membrane: wobbly circle
              float wobble=0.28+0.03*sin(angle*5.0+time*1.5)+0.02*sin(angle*8.0-time*2.0);
              float membrane=exp(-pow((d-wobble)*14.0,2.0));
              float inside=1.0-smoothstep(0.0,wobble-0.02,d);
              // Nucleus
              vec2 nucPos=vec2(0.04*sin(time*0.7),0.03*cos(time*0.9));
              float nucD=length(u-nucPos);
              float nucleus=1.0-smoothstep(0.0,0.08,nucD);
              // Organelles: scattered dots
              float organelles=0.0;
              for(float i=0.0;i<6.0;i++){
                float oAngle=i/6.0*TAU+time*0.3+idH*TAU;
                float oR=0.12+0.04*sin(time*0.5+i*1.5);
                vec2 oPos=vec2(cos(oAngle),sin(oAngle))*oR;
                float oD=length(u-oPos);
                organelles+=exp(-oD*oD*2000.0);
              }
              // Cytoplasm flow
              float flow=noise2(u*20.0+time*vec2(0.8,-0.6));
              vec3 col=hueToRgb(keyHue+0.1)*inside*0.3*(0.7+flow*0.3);
              col+=hueToRgb(keyHue+0.4)*membrane*0.7;
              col+=hueToRgb(keyHue-0.1)*nucleus*0.8;
              col+=hueToRgb(keyHue+0.6)*organelles*0.5;
              // Bioluminescent glow
              col+=hueToRgb(keyHue+0.3)*inside*flow*0.2;
              col+=sparkleFlash*hueToRgb(keyHue+0.5)*membrane*0.7;
              gl_FragColor=vec4(col,(inside*0.6+membrane*0.35+nucleus*0.3)*0.9); return;
            }

            // ========== B (11): SACRED GEOMETRY — nested pentagonal Flower of Life with golden spirals ==========
            {
              // Multi-layer sacred geometry
              float pattern=0.0;
              // Flower of Life: overlapping circles
              for(float i=0.0;i<6.0;i++){
                float fAngle=i/6.0*TAU+time*0.15;
                vec2 center=vec2(cos(fAngle),sin(fAngle))*0.14;
                float circD=abs(length(u-center)-0.14);
                pattern+=exp(-circD*circD*3000.0);
              }
              // Central circle
              float centralCirc=abs(d-0.14);
              pattern+=exp(-centralCirc*centralCirc*3000.0);
              // Pentagon overlay
              float rot2=time*0.2;
              float cs2=cos(rot2),sn2=sin(rot2);
              vec2 ru2=vec2(u.x*cs2-u.y*sn2,u.x*sn2+u.y*cs2);
              float pentD=sdPentagon(ru2*2.8);
              float pentEdge=exp(-pentD*pentD*1500.0);
              pattern+=pentEdge;
              // Golden spiral
              float spiralR=0.02*exp(angle*0.18+d*3.0);
              float spiralD=abs(d-fract(spiralR+time*0.1)*0.4);
              float spiral=exp(-spiralD*spiralD*800.0);
              pattern=min(pattern+spiral*0.5,1.5);
              // Metatron's grid radials
              for(float i=0.0;i<6.0;i++){
                float rAngle=i/6.0*TAU;
                float lineD=abs(u.x*sin(rAngle)-u.y*cos(rAngle));
                pattern+=exp(-lineD*lineD*4000.0)*0.3*(1.0-smoothstep(0.0,0.4,d));
              }
              pattern=min(pattern,1.2);
              vec3 col=hueToRgb(keyHue+0.15)*pattern*0.5;
              col+=hueToRgb(keyHue+0.45)*pentEdge*0.4;
              col+=vec3(1.0,0.95,0.85)*spiral*0.35;
              col+=hueToRgb(keyHue+0.7)*(1.0-smoothstep(0.0,0.04,d))*0.5;
              col+=sparkleFlash*hueToRgb(keyHue+0.5)*pattern*0.5;
              float alpha=pattern*0.55+(1.0-smoothstep(0.0,0.06,d))*0.35;
              gl_FragColor=vec4(col,alpha*0.88); return;
            }
          }
        `,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending
      });

      particlePoints = new THREE.Points(pointsGeo, pointsMat);
      scene.add(particlePoints);
    }

    const boxGeo = new THREE.BoxGeometry(BOX_HALF * 2, BOX_HALF * 2, BOX_HALF * 2);
    const boxWireMat = new THREE.LineBasicMaterial({
      color: 0x152535,
      transparent: true,
      opacity: 0.12
    });
    const wireframe = new THREE.WireframeGeometry(boxGeo);
    boxWireframe = new THREE.LineSegments(wireframe, boxWireMat);
    scene.add(boxWireframe);
    boxGeo.dispose();

    // --- Neural Web: cylindrical lattice of interconnected nodes along tunnel depth
    const tunnelPos = [];
    const neuralRings = TUNNEL_RINGS;
    const neuralNodesPerRing = 160;
    // Ring nodes
    for (let r = 0; r < neuralRings; r++) {
      const t = r / (neuralRings - 1);
      const z = -2.4 + t * 2.8;
      const radius = TUNNEL_RADIUS * (0.35 + 0.65 * (1 - t));
      for (let i = 0; i < neuralNodesPerRing; i++) {
        const a = (i / neuralNodesPerRing) * TAU;
        tunnelPos.push(Math.cos(a) * radius, Math.sin(a) * radius, z);
      }
    }
    // Axial connector nodes between rings
    const axialLines = 56;
    const axialPts = 33;
    for (let i = 0; i < axialLines; i++) {
      const a = (i / axialLines) * TAU;
      for (let k = 0; k < axialPts; k++) {
        const t = k / (axialPts - 1);
        const len = 0.1 + t * TUNNEL_RADIUS;
        tunnelPos.push(Math.cos(a) * len, Math.sin(a) * len, -2.4 + t * 2.8);
      }
    }
    const tunnelGeo = new THREE.BufferGeometry();
    tunnelGeo.setAttribute('position', new THREE.Float32BufferAttribute(tunnelPos, 3));
    tunnelParticles = new THREE.Points(
      tunnelGeo,
      new THREE.PointsMaterial({ size: 0.0038, color: 0x22ffcc, opacity: 0.92, ...particleMatOpts })
    );
    tunnelParticles.userData.basePos = tunnelPos.slice();
    tunnelParticles.userData.neuralRings = neuralRings;
    tunnelParticles.userData.nodesPerRing = neuralNodesPerRing;
    scene.add(tunnelParticles);

    // --- Vertical particle columns (spectrum): 12 columns, many points each
    verticalParticleColumns = new THREE.Group();
    const colPointsCount = SPECTRUM_BAR_COUNT * VERT_COL_POINTS;
    const colPositions = new Float32Array(colPointsCount * 3);
    const colColors = new Float32Array(colPointsCount * 3);
    let idx = 0;
    for (let c = 0; c < SPECTRUM_BAR_COUNT; c++) {
      const x = ((c + 0.5) / SPECTRUM_BAR_COUNT) * 2.8 - 1.4;
      const hue = (c / SPECTRUM_BAR_COUNT) * 0.65 + 0.45;
      const colColor = new THREE.Color().setHSL(hue, 0.95, 0.65);
      for (let v = 0; v < VERT_COL_POINTS; v++) {
        const ty = (v / (VERT_COL_POINTS - 1)) * 1.6 - 0.8;
        colPositions[idx * 3] = x;
        colPositions[idx * 3 + 1] = ty;
        colPositions[idx * 3 + 2] = -1.0;
        colColors[idx * 3] = colColor.r;
        colColors[idx * 3 + 1] = colColor.g;
        colColors[idx * 3 + 2] = colColor.b;
        idx++;
      }
    }
    const colGeo = new THREE.BufferGeometry();
    colGeo.setAttribute('position', new THREE.BufferAttribute(colPositions, 3));
    colGeo.setAttribute('color', new THREE.BufferAttribute(colColors, 3));
    const colPoints = new THREE.Points(colGeo, new THREE.PointsMaterial({
      size: 0.0025, vertexColors: true, opacity: 0.9, ...particleMatOpts
    }));
    verticalParticleColumns.add(colPoints);
    scene.add(verticalParticleColumns);

    // --- Central column: vertical line of particles
    const centralPos = [];
    for (let v = 0; v < CENTRAL_COL_POINTS; v++) {
      const y = (v / (CENTRAL_COL_POINTS - 1)) * 1.6 - 0.8;
      centralPos.push(0, y, 0);
    }
    const centralGeo = new THREE.BufferGeometry();
    centralGeo.setAttribute('position', new THREE.Float32BufferAttribute(centralPos, 3));
    centralColumnParticles = new THREE.Points(
      centralGeo,
      new THREE.PointsMaterial({ size: 0.004, color: 0xff44cc, opacity: 0.88, ...particleMatOpts })
    );
    scene.add(centralColumnParticles);

    // --- Lorenz Attractor Field: 72 trajectories × 100 trail points
    const radiatePos = [];
    const radiateCol = [];
    // Initialize Lorenz trajectories with varied starting points
    const lorenzTrajs = new Float32Array(RADIATE_COUNT * 3);
    for (let i = 0; i < RADIATE_COUNT; i++) {
      const a = (i / RADIATE_COUNT) * TAU;
      const r = 0.5 + (i % 7) * 0.12;
      lorenzTrajs[i * 3]     = Math.cos(a) * r + (i % 3 - 1) * 0.3;
      lorenzTrajs[i * 3 + 1] = Math.sin(a) * r + (i % 5 - 2) * 0.2;
      lorenzTrajs[i * 3 + 2] = 15 + (i % 11) * 2.0;
      for (let k = 0; k < RADIATE_POINTS_PER_RAY; k++) {
        radiatePos.push(0, 0, 0);
        radiateCol.push(0.3, 0.5, 0.8);
      }
    }
    const radiateGeo = new THREE.BufferGeometry();
    radiateGeo.setAttribute('position', new THREE.Float32BufferAttribute(radiatePos, 3));
    radiateGeo.setAttribute('color', new THREE.Float32BufferAttribute(radiateCol, 3));
    radiatingParticles = new THREE.Points(radiateGeo, new THREE.PointsMaterial({
      size: 0.0022, vertexColors: true, opacity: 0.88, ...particleMatOpts
    }));
    radiatingParticles.userData.lorenzTrajs = lorenzTrajs;
    radiatingParticles.userData.lorenzTrails = new Float32Array(RADIATE_COUNT * RADIATE_POINTS_PER_RAY * 3);
    // Initialize trails to starting positions
    for (let i = 0; i < RADIATE_COUNT; i++) {
      for (let k = 0; k < RADIATE_POINTS_PER_RAY; k++) {
        const idx = (i * RADIATE_POINTS_PER_RAY + k) * 3;
        radiatingParticles.userData.lorenzTrails[idx]     = lorenzTrajs[i * 3];
        radiatingParticles.userData.lorenzTrails[idx + 1] = lorenzTrajs[i * 3 + 1];
        radiatingParticles.userData.lorenzTrails[idx + 2] = lorenzTrajs[i * 3 + 2];
      }
    }
    scene.add(radiatingParticles);

    // --- Speed line particles: points along horizontal lines
    const speedPos = [];
    for (let i = 0; i < SPEED_LINE_COUNT; i++) {
      const t = i / (SPEED_LINE_COUNT - 1);
      const z = -2.2 + t * 2.6;
      const width = 0.15 + 0.45 * (1 - t);
      for (let k = 0; k < SPEED_POINTS_PER_LINE; k++) {
        const x = (k / (SPEED_POINTS_PER_LINE - 1) - 0.5) * 2 * width;
        speedPos.push(x, 0.03 * (Math.random() - 0.5), z);
      }
    }
    const speedGeo = new THREE.BufferGeometry();
    speedGeo.setAttribute('position', new THREE.Float32BufferAttribute(speedPos, 3));
    speedLineParticles = new THREE.Points(
      speedGeo,
      new THREE.PointsMaterial({ size: 0.002, color: 0x00ddff, opacity: 0.85, ...particleMatOpts })
    );
    speedLineParticles.userData.basePos = speedPos.slice(0);
    scene.add(speedLineParticles);

    // --- Voronoi Membrane: hexagonal honeycomb grid lattice on XZ plane
    const matrixPos = [];
    const voronoiSeeds = [];
    // Build a proper hex grid — flat-topped honeycomb
    const hexCellSize = 0.22; // distance between cell centers
    const hexRows = 9, hexCols = 11;
    const hexOffX = (hexCols - 1) * hexCellSize * 0.5;
    const hexOffZ = (hexRows - 1) * hexCellSize * 0.866 * 0.5;
    let voronoiCells = 0;
    for (let row = 0; row < hexRows; row++) {
      for (let col = 0; col < hexCols; col++) {
        const cx = col * hexCellSize + (row % 2) * hexCellSize * 0.5 - hexOffX;
        const cz = row * hexCellSize * 0.866 - hexOffZ;
        // Skip corners to make circular boundary
        if (cx * cx + cz * cz > 1.8 * 1.8) continue;
        voronoiSeeds.push(cx, 0, cz);
        voronoiCells++;
      }
    }
    // For each cell center, place center dot + 6 hex vertex points + edge midpoints
    const ptsPerCell = Math.floor(MATRIX_SURF_POINTS / Math.max(1, voronoiCells));
    for (let c = 0; c < voronoiCells; c++) {
      const sx = voronoiSeeds[c * 3], sz = voronoiSeeds[c * 3 + 2];
      // Cell center
      matrixPos.push(sx, 0, sz);
      // Hex vertices (6 corners of the hexagon)
      const hexR = hexCellSize * 0.55;
      for (let v = 0; v < 6; v++) {
        const a = (v / 6) * TAU;
        matrixPos.push(sx + Math.cos(a) * hexR, 0, sz + Math.sin(a) * hexR);
      }
      // Points along hex edges to form visible wireframe
      const edgePts = ptsPerCell - 7;
      for (let e = 0; e < edgePts; e++) {
        const side = e % 6;
        const lerp = ((Math.floor(e / 6) + 1) / (Math.floor(edgePts / 6) + 1));
        const a0 = (side / 6) * TAU;
        const a1 = ((side + 1) / 6) * TAU;
        const ex = sx + Math.cos(a0) * hexR * (1 - lerp) + Math.cos(a1) * hexR * lerp;
        const ez = sz + Math.sin(a0) * hexR * (1 - lerp) + Math.sin(a1) * hexR * lerp;
        matrixPos.push(ex, 0, ez);
      }
    }
    // Fill remaining slots
    while (matrixPos.length / 3 < MATRIX_SURF_POINTS) {
      const ci = Math.floor(Math.random() * voronoiCells);
      const a = Math.random() * TAU;
      const r = hexCellSize * 0.55 * Math.random();
      matrixPos.push(
        voronoiSeeds[ci * 3] + Math.cos(a) * r, 0,
        voronoiSeeds[ci * 3 + 2] + Math.sin(a) * r
      );
    }
    const matrixGeo = new THREE.BufferGeometry();
    matrixGeo.setAttribute('position', new THREE.Float32BufferAttribute(matrixPos, 3));
    matrixSurfaceParticles = new THREE.Points(
      matrixGeo,
      new THREE.PointsMaterial({ size: 0.0018, color: 0xb8d8ff, opacity: 0.0, ...particleMatOpts })
    );
    matrixSurfaceParticles.userData.basePos = matrixPos.slice(0);
    matrixSurfaceParticles.userData.voronoiSeeds = voronoiSeeds;
    matrixSurfaceParticles.userData.voronoiCells = voronoiCells;
    matrixSurfaceParticles.userData.rippleTime = -10;
    scene.add(matrixSurfaceParticles);

    // --- Crystal Growth: 3D fractal tree — branches fork upward in 3D
    const spokePos = [];
    const crystalBranches = 6;
    const ptsPerBranch = Math.floor(PRISM_SPOKE_POINTS / crystalBranches);
    for (let b = 0; b < crystalBranches; b++) {
      const mainAng = (b / crystalBranches) * TAU;
      const mainElev = ((b % 3) - 1) * 0.4; // branches at different vertical angles
      for (let p = 0; p < ptsPerBranch; p++) {
        const t = p / (ptsPerBranch - 1);
        // Recursive fork: depth increases with t
        const forkSeed = (p * 7 + b * 13) % 17;
        const forkAng = mainAng + (forkSeed % 5 - 2) * 0.25 * t;
        const forkElev = mainElev + (forkSeed % 3 - 1) * 0.3 * t;
        const r = t * 1.1;
        const x = Math.cos(forkAng) * r * Math.cos(forkElev);
        const y = Math.sin(forkElev) * r;
        const z = Math.sin(forkAng) * r * Math.cos(forkElev);
        spokePos.push(x, y, z);
      }
    }
    while (spokePos.length / 3 < PRISM_SPOKE_POINTS) spokePos.push(0, 0, 0);
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(spokePos, 3));
    prismSpokeParticles = new THREE.Points(
      spokeGeo,
      new THREE.PointsMaterial({ size: 0.0019, color: 0xd7e9ff, opacity: 0.0, ...particleMatOpts })
    );
    prismSpokeParticles.userData.basePos = spokePos.slice(0);
    prismSpokeParticles.userData.crystalBranches = crystalBranches;
    prismSpokeParticles.userData.ptsPerBranch = ptsPerBranch;
    crystalBranchLen = new Float32Array(PRISM_SPOKE_POINTS);
    crystalBranchPhase = new Float32Array(PRISM_SPOKE_POINTS);
    for (let i = 0; i < PRISM_SPOKE_POINTS; i++) {
      crystalBranchLen[i] = 0.3 + Math.random() * 0.7;
      crystalBranchPhase[i] = Math.random() * TAU;
    }
    scene.add(prismSpokeParticles);

    // --- Three.js Piano Roll: point-line-surface runway integrated into core scene
    roll3DGroup = new THREE.Group();
    roll3DGroup.position.set(0, -0.32, 0.44);
    roll3DGroup.rotation.x = -0.24;

    const rollSurfaceGeo = new THREE.PlaneGeometry(1, 1);
    const rollSurfaceMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      side: THREE.DoubleSide
    });
    roll3DSurfaces = new THREE.InstancedMesh(rollSurfaceGeo, rollSurfaceMat, ROLL3D_MAX_INSTANCES);
    roll3DSurfaces.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    roll3DSurfaces.count = 0;
    roll3DSurfaces.renderOrder = 620;
    roll3DSurfaces.frustumCulled = false;
    roll3DGroup.add(roll3DSurfaces);

    const rollGlowMat = new THREE.MeshBasicMaterial({
      color: 0x22aaff,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexColors: true,
      side: THREE.DoubleSide
    });
    roll3DGlowSurfaces = new THREE.InstancedMesh(rollSurfaceGeo, rollGlowMat, ROLL3D_MAX_INSTANCES);
    roll3DGlowSurfaces.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    roll3DGlowSurfaces.count = 0;
    roll3DGlowSurfaces.renderOrder = 619;
    roll3DGlowSurfaces.frustumCulled = false;
    roll3DGroup.add(roll3DGlowSurfaces);

    const rollQuadGeo = new THREE.BufferGeometry();
    roll3DQuadPosArray = new Float32Array(ROLL3D_MAX_QUAD_VERTS * 3);
    roll3DQuadColArray = new Float32Array(ROLL3D_MAX_QUAD_VERTS * 3);
    roll3DQuadPosAttr = new THREE.BufferAttribute(roll3DQuadPosArray, 3);
    roll3DQuadPosAttr.setUsage(THREE.DynamicDrawUsage);
    roll3DQuadColAttr = new THREE.BufferAttribute(roll3DQuadColArray, 3);
    roll3DQuadColAttr.setUsage(THREE.DynamicDrawUsage);
    rollQuadGeo.setAttribute('position', roll3DQuadPosAttr);
    rollQuadGeo.setAttribute('color', roll3DQuadColAttr);
    roll3DQuads = new THREE.Mesh(
      rollQuadGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.75,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      })
    );
    roll3DQuads.geometry.setDrawRange(0, 0);
    roll3DQuads.renderOrder = 621;
    roll3DQuads.frustumCulled = false;
    roll3DGroup.add(roll3DQuads);

    const rollLineGeo = new THREE.BufferGeometry();
    roll3DLinePosArray = new Float32Array(ROLL3D_MAX_LINES * 3);
    roll3DLinePosAttr = new THREE.BufferAttribute(roll3DLinePosArray, 3);
    roll3DLinePosAttr.setUsage(THREE.DynamicDrawUsage);
    rollLineGeo.setAttribute('position', roll3DLinePosAttr);
    roll3DLines = new THREE.LineSegments(
      rollLineGeo,
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.52,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    roll3DLines.geometry.setDrawRange(0, 0);
    roll3DLines.renderOrder = 618;
    roll3DLines.frustumCulled = false;
    roll3DGroup.add(roll3DLines);

    const rollPointGeo = new THREE.BufferGeometry();
    roll3DPointPosArray = new Float32Array(ROLL3D_MAX_POINTS * 3);
    roll3DPointColArray = new Float32Array(ROLL3D_MAX_POINTS * 3);
    roll3DPointPosAttr = new THREE.BufferAttribute(roll3DPointPosArray, 3);
    roll3DPointPosAttr.setUsage(THREE.DynamicDrawUsage);
    roll3DPointColAttr = new THREE.BufferAttribute(roll3DPointColArray, 3);
    roll3DPointColAttr.setUsage(THREE.DynamicDrawUsage);
    rollPointGeo.setAttribute('position', roll3DPointPosAttr);
    rollPointGeo.setAttribute('color', roll3DPointColAttr);
    roll3DPoints = new THREE.Points(
      rollPointGeo,
      new THREE.PointsMaterial({
        size: 0.0156,
        transparent: true,
        opacity: 0.62,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true
      })
    );
    roll3DPoints.geometry.setDrawRange(0, 0);
    roll3DPoints.renderOrder = 622;
    roll3DPoints.frustumCulled = false;
    roll3DGroup.add(roll3DPoints);

    // --- Note text label atlas: 12 note names rendered to a CanvasTexture ---
    {
      const atlasW = 512, atlasH = 64;
      const noteCanvas = document.createElement('canvas');
      noteCanvas.width = atlasW; noteCanvas.height = atlasH;
      const ctx2 = noteCanvas.getContext('2d');
      ctx2.clearRect(0, 0, atlasW, atlasH);
      ctx2.font = '500 28px "SF Mono", "Menlo", "Consolas", monospace';
      ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle';
      ctx2.fillStyle = '#ffffff';
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const cellW = atlasW / 12;
      for (let i = 0; i < 12; i++) {
        ctx2.fillText(names[i], cellW * (i + 0.5), atlasH * 0.5);
      }
      roll3DNoteLabelTexture = new THREE.CanvasTexture(noteCanvas);
      roll3DNoteLabelTexture.minFilter = THREE.LinearFilter;
      roll3DNoteLabelTexture.magFilter = THREE.LinearFilter;
      // Per-instance UV offset via InstancedBufferAttribute + custom ShaderMaterial
      const labelGeo = new THREE.PlaneGeometry(1, 1);
      const uvOffsetAttr = new THREE.InstancedBufferAttribute(new Float32Array(ROLL3D_MAX_LABELS), 1);
      uvOffsetAttr.setUsage(THREE.DynamicDrawUsage);
      labelGeo.setAttribute('aUvOffset', uvOffsetAttr);
      const labelMat = new THREE.ShaderMaterial({
        uniforms: {
          tAtlas: { value: roll3DNoteLabelTexture },
          opacity: { value: 0.52 }
        },
        vertexShader: `
          attribute float aUvOffset;
          varying vec2 vUv;
          varying float vOff;
          void main() {
            vUv = uv;
            vOff = aUvOffset;
            vec4 mvPos = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: `
          uniform sampler2D tAtlas;
          uniform float opacity;
          varying vec2 vUv;
          varying float vOff;
          void main() {
            // Each note occupies 1/12th of the atlas width
            vec2 atlasUv = vec2(vUv.x / 12.0 + vOff, vUv.y);
            vec4 t = texture2D(tAtlas, atlasUv);
            if (t.a < 0.05) discard;
            gl_FragColor = vec4(t.rgb, t.a * opacity);
          }
        `,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      roll3DNoteLabels = new THREE.InstancedMesh(labelGeo, labelMat, ROLL3D_MAX_LABELS);
      roll3DNoteLabels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      roll3DNoteLabels.count = 0;
      roll3DNoteLabels.renderOrder = 625;
      roll3DNoteLabels.frustumCulled = false;
      roll3DGroup.add(roll3DNoteLabels);
    }

    // --- Tunnel particle system: dedicated Points buffer for ambient + reactive particles ---
    {
      const pGeo = new THREE.BufferGeometry();
      roll3DParticlePosArray = new Float32Array(ROLL3D_MAX_PARTICLES * 3);
      roll3DParticleColArray = new Float32Array(ROLL3D_MAX_PARTICLES * 3);
      roll3DParticlePosAttr = new THREE.BufferAttribute(roll3DParticlePosArray, 3);
      roll3DParticlePosAttr.setUsage(THREE.DynamicDrawUsage);
      roll3DParticleColAttr = new THREE.BufferAttribute(roll3DParticleColArray, 3);
      roll3DParticleColAttr.setUsage(THREE.DynamicDrawUsage);
      pGeo.setAttribute('position', roll3DParticlePosAttr);
      pGeo.setAttribute('color', roll3DParticleColAttr);
      roll3DParticles = new THREE.Points(pGeo, new THREE.PointsMaterial({
        size: 0.018,
        transparent: true,
        opacity: 0.72,
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true
      }));
      roll3DParticles.geometry.setDrawRange(0, 0);
      roll3DParticles.renderOrder = 623;
      roll3DParticles.frustumCulled = false;
      roll3DGroup.add(roll3DParticles);
      // Ember Storm state arrays
      emberVelocities = new Float32Array(ROLL3D_MAX_PARTICLES * 3);
      emberAges = new Float32Array(ROLL3D_MAX_PARTICLES);
      emberTemps = new Float32Array(ROLL3D_MAX_PARTICLES);
      for (let i = 0; i < ROLL3D_MAX_PARTICLES; i++) {
        emberAges[i] = 999; // mark as dead initially
        emberTemps[i] = 0;
      }
    }

    if (rollOverlayScene) rollOverlayScene.add(roll3DGroup);
    else scene.add(roll3DGroup);

    // --- Shockwave Debris: physics-based torus explosion with reconvergence
    const burstPos = new Float32Array(BURST_RING_POINTS * 3);
    const burstCol = new Float32Array(BURST_RING_POINTS * 3);
    for (let i = 0; i < BURST_RING_POINTS; i++) {
      const a = (i / BURST_RING_POINTS) * TAU;
      burstPos[i * 3] = Math.cos(a) * 0.15;
      burstPos[i * 3 + 1] = Math.sin(a) * 0.15;
      burstPos[i * 3 + 2] = 0;
      burstCol[i * 3] = 0.4; burstCol[i * 3 + 1] = 0.25; burstCol[i * 3 + 2] = 0.1;
    }
    const burstGeo = new THREE.BufferGeometry();
    burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
    burstGeo.setAttribute('color', new THREE.BufferAttribute(burstCol, 3));
    burstRingParticles = new THREE.Points(
      burstGeo,
      new THREE.PointsMaterial({ size: 0.004, vertexColors: true, opacity: 0, ...particleMatOpts })
    );
    // Physics state
    burstVelocities = new Float32Array(BURST_RING_POINTS * 3);
    burstAges = new Float32Array(BURST_RING_POINTS);
    scene.add(burstRingParticles);

    // --- Plasma particles: cloud around attractor (positions updated in animate)
    const plasmaPos = [];
    for (let i = 0; i < PLASMA_POINTS; i++) {
      const th = Math.acos(2 * Math.random() - 1);
      const ph = Math.random() * Math.PI * 2;
      const r = 0.15 * Math.cbrt(Math.random());
      plasmaPos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
    const plasmaGeo = new THREE.BufferGeometry();
    plasmaGeo.setAttribute('position', new THREE.Float32BufferAttribute(plasmaPos, 3));
    plasmaParticles = new THREE.Points(
      plasmaGeo,
      new THREE.PointsMaterial({ size: 0.0035, color: 0x00eeff, opacity: 0, ...particleMatOpts })
    );
    plasmaParticles.userData.baseOffsets = plasmaPos.slice();
    scene.add(plasmaParticles);

    // --- Murmuration: boids flocking swarm
    floatingParticleClouds = new THREE.Group();
    const totalBoids = FLOATING_ORB_COUNT * FLOATING_POINTS_PER_ORB;
    const allFloatingPos = new Float32Array(totalBoids * 3);
    const allFloatingCol = new Float32Array(totalBoids * 3);
    // Initialize boids in a loose sphere
    for (let i = 0; i < totalBoids; i++) {
      const th = Math.acos(2 * Math.random() - 1);
      const ph = Math.random() * TAU;
      const r = 0.3 * Math.cbrt(Math.random());
      allFloatingPos[i * 3]     = r * Math.sin(th) * Math.cos(ph);
      allFloatingPos[i * 3 + 1] = r * Math.sin(th) * Math.sin(ph);
      allFloatingPos[i * 3 + 2] = r * Math.cos(th);
      allFloatingCol[i * 3] = 0.7; allFloatingCol[i * 3 + 1] = 0.75; allFloatingCol[i * 3 + 2] = 0.85;
    }
    const floatGeo = new THREE.BufferGeometry();
    floatGeo.setAttribute('position', new THREE.BufferAttribute(allFloatingPos, 3));
    floatGeo.setAttribute('color', new THREE.BufferAttribute(allFloatingCol, 3));
    const floatPts = new THREE.Points(floatGeo, new THREE.PointsMaterial({
      size: 0.0025, vertexColors: true, opacity: 0.78, ...particleMatOpts
    }));
    floatPts.userData.orbCount = FLOATING_ORB_COUNT;
    floatPts.userData.pointsPerOrb = FLOATING_POINTS_PER_ORB;
    // Boid velocities
    floatVelocities = new Float32Array(totalBoids * 3);
    for (let i = 0; i < totalBoids * 3; i++) floatVelocities[i] = (Math.random() - 0.5) * 0.02;
    floatingParticleClouds.add(floatPts);
    scene.add(floatingParticleClouds);

    if (!useGPGPU) {
      const fallbackGeo = new THREE.BufferGeometry();
      const fallbackPos = new Float32Array(4000 * 3);
      for (let i = 0; i < 4000; i++) {
        fallbackPos[i * 3] = (Math.random() - 0.5) * 2 * BOX_HALF * 0.9;
        fallbackPos[i * 3 + 1] = (Math.random() - 0.5) * 2 * BOX_HALF * 0.9;
        fallbackPos[i * 3 + 2] = (Math.random() - 0.5) * 2 * BOX_HALF * 0.9;
      }
      fallbackGeo.setAttribute('position', new THREE.BufferAttribute(fallbackPos, 3));
      const fallbackMat = new THREE.PointsMaterial({
        size: 0.002,
        color: 0x4488cc,
        transparent: true,
        opacity: 0.6,
        sizeAttenuation: true
      });
      particlePoints = new THREE.Points(fallbackGeo, fallbackMat);
      scene.add(particlePoints);
    }

    window.addEventListener('resize', () => {
      if (!camera || !renderer) return;
      const w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (rollOverlayCamera) {
        rollOverlayCamera.aspect = w / h;
        rollOverlayCamera.updateProjectionMatrix();
      }
      renderer.setSize(w, h);
      const rtW = Math.round(w * 0.75), rtH = Math.round(h * 0.75);
      if (rtScene) rtScene.setSize(rtW, rtH);
      if (postQuad && postQuad.material.uniforms) postQuad.material.uniforms.resolution.value.set(rtW, rtH);
    });
  }

  let gridMouseDown = false;
  let lastTriggeredCell = null;
  let audioCtx = null;
  let masterGain = null;
  const keysPressed = new Set();
  const sustainedVoices = new Map();
  let sustainPedalHeld = false;
  let visualFreezeUntil = 0;
  let masterVolume = 1.0;
  let helpOverlayEl = null;
  let helpOverlayVisible = false;
  // Idle auto-play: build → hold → decay (capped, no infinite stack)
  let idlePhase = 'rest';
  let idleIntensity = 0;
  let idleTimer = 0;
  const IDLE_REST_SEC = 2.5;
  const IDLE_BUILD_RATE = 0.018;
  const IDLE_CAP = 0.38;
  const IDLE_HOLD_SEC = 5;
  const IDLE_DECAY_RATE = 0.022;
  // Per-key / sparkle / pad visual state (Y2K reactive)
  let currentKeyHue = 0.55;
  let sparkleTime = 0;
  let padLevel = 0;
  // Distortion state - each key = completely different visual character
  let targetKaleidoFolds = 6;
  let currentKaleidoFolds = 6;
  let kaleidoMix = 0.15;
  let targetKaleidoMix = 0.15;
  let kaleidoRotation = 0;
  let curSpiral = 0, tgtSpiral = 0;
  let curFlow = 0, tgtFlow = 0;
  let curPulse = 0, tgtPulse = 0;
  let curShear = 0, tgtShear = 0;
  let curWave = 0, tgtWave = 0;
  let curGlitch = 0, tgtGlitch = 0;
  let curMirrorX = 0, tgtMirrorX = 0;
  let curMirrorY = 0, tgtMirrorY = 0;
  let curWarp = 0, tgtWarp = 0;
  let curPrism = 0.62, tgtPrism = 0.62;
  let curContrast = 1.22, tgtContrast = 1.22;
  let curBio = 0.35, tgtBio = 0.35;
  let curProfileRoll = 0, tgtProfileRoll = 0;
  let styleMuseum = 0.5;
  let styleLsd = 0.5;
  let styleCrossover = 0.0;
  const PIXEL_MODE_LABELS = ['soft', 'dense', 'hard'];
  const PIXEL_MODE_VALUES = [0.26, 0.58, 0.9];
  const ANALOG_MODE_LABELS = ['clean', 'crt', 'vhs'];
  const ANALOG_MODE_VALUES = [0.3, 0.66, 0.98];
  const TEXT_MODE_LABELS = ['clean', 'glitch', 'overclock'];
  const TEXT_GLITCH_VALUES = [0.72, 1.08, 1.48];
  let pixelModeIdx = 1;
  let analogModeIdx = 1;
  let textModeIdx = 1;
  function cyclePixelMode() { pixelModeIdx = (pixelModeIdx + 1) % PIXEL_MODE_VALUES.length; return PIXEL_MODE_LABELS[pixelModeIdx]; }
  function cycleAnalogMode() { analogModeIdx = (analogModeIdx + 1) % ANALOG_MODE_VALUES.length; return ANALOG_MODE_LABELS[analogModeIdx]; }
  function cycleTextMode() { textModeIdx = (textModeIdx + 1) % TEXT_GLITCH_VALUES.length; return TEXT_MODE_LABELS[textModeIdx]; }
  // KEY_PROFILES visual personality tuning table:
  // contour / kaleido / radiation / symmetry / optical-lsd are balanced per key.
  const KEY_PROFILES = [
    // C: Prismatic Supernova — blazing red-orange, explosive rays, high bloom, maximum prism
    { name:'Prismatic Supernova', folds:5, hue:0.0, bloom:3.2, ca:0.0065, spiral:0.06, flow:0.95, pulse:0.92, shear:0.05, wave:0.15, glitch:0.02, mx:0, my:0, warp:0.85, prism:1.3, bio:0.1, rot:0.0, contrast:2.9, in:0.98, out:0.75 },
    // C#: Quantum Crystal — electric violet, geometric, high contrast, mirror symmetry
    { name:'Quantum Crystal', folds:16, hue:0.78, bloom:2.1, ca:0.0030, spiral:0.0, flow:0.15, pulse:0.12, shear:0.95, wave:0.08, glitch:0.25, mx:1, my:1, warp:0.12, prism:0.6, bio:0.05, rot:0.35, contrast:3.2, in:0.99, out:0.78 },
    // D: Cosmic Eye — deep teal, organic flow, iris-like bio patterns
    { name:'Cosmic Eye', folds:7, hue:0.48, bloom:2.6, ca:0.0045, spiral:0.04, flow:0.82, pulse:0.55, shear:0.10, wave:0.65, glitch:0.04, mx:0, my:0, warp:0.55, prism:0.85, bio:0.92, rot:-0.08, contrast:2.3, in:0.95, out:0.65 },
    // D#: Black Hole — ultraviolet to black, extreme warp, high CA, void-like
    { name:'Black Hole', folds:3, hue:0.72, bloom:3.5, ca:0.0080, spiral:0.08, flow:0.25, pulse:0.18, shear:0.15, wave:0.10, glitch:0.35, mx:0, my:0, warp:0.95, prism:1.15, bio:0.0, rot:0.0, contrast:3.5, in:1.0, out:0.8 },
    // E: Lightning Swarm — electric cyan-white, chaotic, maximum glitch + shear
    { name:'Lightning Swarm', folds:9, hue:0.52, bloom:2.8, ca:0.0058, spiral:0.0, flow:0.10, pulse:0.85, shear:0.92, wave:0.42, glitch:0.40, mx:0, my:0, warp:0.40, prism:0.95, bio:0.15, rot:-0.25, contrast:2.85, in:0.97, out:0.72 },
    // F: Nebula Bloom — warm magenta-rose, dreamy flow, soft bio, low contrast
    { name:'Nebula Bloom', folds:6, hue:0.92, bloom:3.0, ca:0.0035, spiral:0.05, flow:0.92, pulse:0.30, shear:0.08, wave:0.78, glitch:0.0, mx:0, my:0, warp:0.72, prism:0.75, bio:0.88, rot:-0.12, contrast:2.0, in:0.93, out:0.62 },
    // F#: Diamond Shard — golden yellow, triangular mirror, maximum prism + sparkle
    { name:'Diamond Shard', folds:18, hue:0.13, bloom:2.4, ca:0.0070, spiral:0.02, flow:0.30, pulse:0.40, shear:0.70, wave:0.20, glitch:0.15, mx:1, my:0, warp:0.30, prism:1.4, bio:0.0, rot:0.28, contrast:2.75, in:0.97, out:0.74 },
    // G: Solar Flare — intense orange-red, explosive pulse, strong bloom, eruption feel
    { name:'Solar Flare', folds:8, hue:0.06, bloom:3.4, ca:0.0055, spiral:0.07, flow:0.68, pulse:0.98, shear:0.25, wave:0.55, glitch:0.08, mx:0, my:0, warp:0.78, prism:1.05, bio:0.45, rot:0.05, contrast:2.6, in:0.96, out:0.70 },
    // G#: Vortex Ring — seafoam green, toroidal, wave-dominated, hypnotic
    { name:'Vortex Ring', folds:11, hue:0.38, bloom:2.3, ca:0.0042, spiral:0.03, flow:0.55, pulse:0.35, shear:0.48, wave:0.95, glitch:0.10, mx:1, my:0, warp:0.48, prism:0.88, bio:0.35, rot:-0.18, contrast:2.45, in:0.95, out:0.68 },
    // A: Fractal Frost — ice blue-white, crystalline, high mirror, low bio, crisp
    { name:'Fractal Frost', folds:14, hue:0.58, bloom:2.0, ca:0.0032, spiral:0.01, flow:0.20, pulse:0.22, shear:0.82, wave:0.15, glitch:0.18, mx:1, my:1, warp:0.20, prism:0.70, bio:0.08, rot:0.32, contrast:3.1, in:0.98, out:0.76 },
    // A#: Plasma Cell — bio-green, organic, maximum bio, pulsing, cellular
    { name:'Plasma Cell', folds:5, hue:0.28, bloom:2.7, ca:0.0048, spiral:0.05, flow:0.85, pulse:0.72, shear:0.12, wave:0.60, glitch:0.06, mx:0, my:0, warp:0.62, prism:0.80, bio:0.98, rot:-0.06, contrast:2.2, in:0.94, out:0.64 },
    // B: Sacred Geometry — royal purple-gold, maximum folds, intricate symmetry
    { name:'Sacred Geometry', folds:20, hue:0.82, bloom:2.5, ca:0.0040, spiral:0.03, flow:0.40, pulse:0.45, shear:0.60, wave:0.35, glitch:0.12, mx:1, my:0, warp:0.45, prism:0.92, bio:0.42, rot:0.22, contrast:2.65, in:0.96, out:0.70 },
  ];
  let activeProfile = KEY_PROFILES[0];
  // Head tracking state
  let headRotationBias = 0;
  let headX = 0.5; // normalized 0..1, 0.5 = center
  let headY = 0.5;  // vertical 0..1, 0.5 = center (for VR/AR parallax)
  let headXSmoothed = 0.5; // follow general direction, no jitter (glasses-like)
  let headYSmoothed = 0.5;
  let headZone = 'CENTER'; // LEFT / CENTER / RIGHT
  let headTrackingActive = false;
  let headVideo = null;
  let headCanvas = null;
  let headCtx = null;
  let faceDetector = null;
  let lastHeadDetect = 0;
  let headBarEl = null;
  let headDotEl = null;
  let headLabelEl = null;
  let headConfEl = null;
  let prevFrameData = null;
  let detectionMethod = 'none';
  let headConfidence = 0;

  // --- Gesture control (hand = virtual knobs; same camera as head) ---
  let handX = 0.5;
  let prevHandX = 0.5;
  let handMotion = 0;
  let handKnob1 = 0.5;   // 0..1, maps from hand X position (effect mix / warp)
  let handKnob2 = 0;     // 0..1, maps from hand motion (bloom / intensity)
  let fastSwipeTime = -1;
  let fastSwipeDir = 0;  // -1 left, 1 right
  const FAST_SWIPE_VEL = 0.22;
  const FAST_SWIPE_DURATION = 0.45;
  let prevHandFrameData = null;
  let gestureBarEl = null;
  let gestureFillEl = null;
  let gestureLabelEl = null;
  let gestureKnobLabelEl = null;


  function createGestureBar() {
    if (gestureBarEl && document.body.contains(gestureBarEl)) return;
    gestureBarEl = document.createElement('div');
    gestureBarEl.style.cssText = 'position:fixed;top:38px;left:50%;transform:translateX(-50%);width:160px;height:6px;z-index:1000;pointer-events:none;background:rgba(0,0,0,0.35);border-radius:0;overflow:hidden;border:1px solid rgba(255,255,255,0.08);opacity:0;transition:opacity 0.5s';
    gestureFillEl = document.createElement('div');
    gestureFillEl.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:50%;background:linear-gradient(90deg,rgba(120,80,255,0.5),rgba(200,120,255,0.6));border-radius:0;transition:width 0.08s ease-out';
    gestureBarEl.appendChild(gestureFillEl);
    const tick = document.createElement('div');
    tick.style.cssText = 'position:absolute;left:50%;top:-2px;width:1px;height:10px;background:rgba(255,255,255,0.25);transform:translateX(-50%)';
    gestureBarEl.appendChild(tick);
    gestureLabelEl = document.createElement('div');
    gestureLabelEl.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:1000;pointer-events:none;font:600 8px/1 -apple-system,sans-serif;letter-spacing:2px;color:rgba(255,255,255,0.6);text-transform:uppercase;opacity:0;transition:opacity 0.5s';
    gestureLabelEl.textContent = 'NORMAL';
    gestureKnobLabelEl = document.createElement('div');
    gestureKnobLabelEl.style.cssText = 'position:fixed;top:58px;left:50%;transform:translateX(-50%);z-index:1000;pointer-events:none;font:7px/1 monospace;color:rgba(255,255,255,0.35);opacity:0;transition:opacity 0.5s';
    gestureKnobLabelEl.textContent = 'L← →R  ·  motion';
    document.body.appendChild(gestureBarEl);
    document.body.appendChild(gestureLabelEl);
    document.body.appendChild(gestureKnobLabelEl);
  }

  function updateGestureBar() {
    if (!gestureBarEl || !gestureFillEl || !gestureLabelEl) return;
    const pct = Math.max(0, Math.min(100, handKnob1 * 100));
    gestureFillEl.style.width = pct + '%';
    const hueDeg = Math.round(currentKeyHue * 360) % 360;
    gestureFillEl.style.background = `linear-gradient(90deg, hsla(${hueDeg}, 58%, 56%, 0.5), hsla(${(hueDeg + 36) % 360}, 54%, 70%, 0.62))`;
    const isFastSwipe = fastSwipeTime >= 0 && (performance.now() * 0.001 - fastSwipeTime) < FAST_SWIPE_DURATION;
    if (isFastSwipe) {
      gestureLabelEl.textContent = fastSwipeDir > 0 ? 'SWIPE →' : '← SWIPE';
      gestureLabelEl.style.color = `hsla(${(hueDeg + 42) % 360}, 70%, 82%, 0.95)`;
    } else if (handMotion > 0.25) {
      gestureLabelEl.textContent = 'ACTIVE';
      gestureLabelEl.style.color = `hsla(${(hueDeg + 16) % 360}, 52%, 78%, 0.86)`;
    } else {
      gestureLabelEl.textContent = 'NORMAL';
      gestureLabelEl.style.color = `hsla(${hueDeg}, 18%, 82%, 0.62)`;
    }
    gestureKnobLabelEl.textContent = 'L← knob →R  ·  motion ' + (handKnob2 * 100 | 0) + '%';
    gestureKnobLabelEl.style.color = `hsla(${hueDeg}, 18%, 78%, 0.38)`;
  }

  function detectHandGesture(data, cw, ch, hasPrev, prevData) {
    const yStart = Math.floor(ch * 0.5);
    const yEnd = ch;
    const numCols = 16;
    const colW = Math.floor(cw / numCols);
    const colEnergy = new Float32Array(numCols);
    const step = 2;
    let totalMotion = 0;

    for (let c = 0; c < numCols; c++) {
      const x0 = c * colW;
      const x1 = Math.min(x0 + colW, cw);
      let energy = 0;
      for (let y = yStart; y < yEnd; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * cw + x) * 4;
          const R = data[i], G = data[i+1], B = data[i+2];
          if (x + step < x1 && y + step < yEnd) {
            const j = (y * cw + x + step) * 4;
            const k = ((y + step) * cw + x) * 4;
            energy += Math.abs(R - data[j]) + Math.abs(G - data[j+1]) + Math.abs(B - data[j+2]);
            energy += Math.abs(R - data[k]) + Math.abs(G - data[k+1]) + Math.abs(B - data[k+2]);
          }
          if (hasPrev && prevData) {
            const m = (Math.abs(R - prevData[i]) + Math.abs(G - prevData[i+1]) + Math.abs(B - prevData[i+2])) * 2;
            energy += m;
            totalMotion += m;
          }
        }
      }
      colEnergy[c] = energy;
    }

    const smooth = new Float32Array(numCols);
    for (let c = 0; c < numCols; c++) {
      let s = colEnergy[c] * 2;
      if (c > 0) s += colEnergy[c-1];
      if (c < numCols-1) s += colEnergy[c+1];
      smooth[c] = s;
    }
    let peakCol = numCols / 2;
    let peakVal = 0;
    for (let c = 0; c < numCols; c++) {
      if (smooth[c] > peakVal) { peakVal = smooth[c]; peakCol = c; }
    }
    let wSum = 0, wTotal = 0;
    for (let c = Math.max(0, peakCol - 3); c <= Math.min(numCols - 1, peakCol + 3); c++) {
      wSum += smooth[c] * (c + 0.5);
      wTotal += smooth[c];
    }
    const centroid = wTotal > 0 ? wSum / wTotal / numCols : 0.5;
    const rawHandX = 1 - centroid;

    const dt = 0.033;
    const vel = (rawHandX - prevHandX) / dt;
    if (Math.abs(vel) >= FAST_SWIPE_VEL) {
      fastSwipeTime = performance.now() * 0.001;
      fastSwipeDir = vel > 0 ? 1 : -1;
    }
    prevHandX = rawHandX;
    handX += (rawHandX - handX) * 0.25;
    handKnob1 = Math.max(0, Math.min(1, handX));

    const motionNorm = Math.min(1, totalMotion / (numCols * 50));
    handMotion += (motionNorm - handMotion) * 0.2;
    handKnob2 = handMotion;

    updateGestureBar();
  }

  // --- Webcam head tracking (robust multi-strategy) ---
  function createHeadBar() {
    headBarEl = document.createElement('div');
    headBarEl.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);width:140px;height:4px;z-index:1000;pointer-events:none;background:rgba(255,255,255,0.08);border-radius:0;overflow:visible;opacity:0;transition:opacity 0.5s';
    // Thin track line with subtle gradient
    const track = document.createElement('div');
    track.style.cssText = 'position:absolute;inset:0;border-radius:0;background:linear-gradient(90deg,rgba(255,100,100,0.15),rgba(255,255,255,0.1) 50%,rgba(100,220,255,0.15))';
    headBarEl.appendChild(track);
    // Center tick
    const tick = document.createElement('div');
    tick.style.cssText = 'position:absolute;left:50%;top:-3px;width:1px;height:10px;background:rgba(255,255,255,0.2);transform:translateX(-50%)';
    headBarEl.appendChild(tick);
    // Moving dot — small, glowing
    headDotEl = document.createElement('div');
    headDotEl.style.cssText = 'position:absolute;width:8px;height:8px;border-radius:0;background:#fff;box-shadow:0 0 8px 2px rgba(255,255,255,0.6);top:50%;left:50%;transform:translate(-50%,-50%);transition:left 0.04s linear,background 0.15s,box-shadow 0.15s';
    headBarEl.appendChild(headDotEl);
    // Label — tiny, just below bar
    headLabelEl = document.createElement('div');
    headLabelEl.style.cssText = 'position:fixed;top:18px;left:50%;transform:translateX(-50%);z-index:1000;pointer-events:none;font:500 8px/1 -apple-system,sans-serif;letter-spacing:2.5px;color:rgba(255,255,255,0.45);text-transform:uppercase;opacity:0;transition:opacity 0.5s';
    headLabelEl.textContent = '\u25C6';
    // Confidence — hidden by default, tiny
    headConfEl = document.createElement('div');
    headConfEl.style.cssText = 'position:fixed;top:28px;left:50%;transform:translateX(-50%);z-index:1000;pointer-events:none;font:8px/1 monospace;color:rgba(255,255,255,0.2);opacity:0;transition:opacity 0.5s';
    document.body.appendChild(headBarEl);
    document.body.appendChild(headLabelEl);
    document.body.appendChild(headConfEl);
  }

  function createVhsTimestamp() {
    vhsTimestampEl = document.createElement('div');
    vhsTimestampEl.style.cssText = [
      'position:fixed',
      'bottom:14%',
      'right:2.5%',
      'z-index:1350',
      'pointer-events:none',
      'font:700 11px/1.2 "Lucida Console","Courier New",monospace',
      'letter-spacing:0.12em',
      'color:rgba(255,255,255,0.55)',
      'text-shadow:1px 0 rgba(255,50,50,0.4),-1px 0 rgba(50,220,255,0.35)',
      'mix-blend-mode:screen',
      'opacity:0',
      'transition:opacity 0.4s'
    ].join(';');
    document.body.appendChild(vhsTimestampEl);
  }

  // ═══ Y2K Design Elements ═══

  function createBracketFrame() {
    bracketFrameEl = document.createElement('div');
    bracketFrameEl.style.cssText = 'position:fixed;inset:0;z-index:1380;pointer-events:none;opacity:0.25';
    const corners = ['tl', 'tr', 'bl', 'br'];
    corners.forEach(c => {
      const d = document.createElement('div');
      d.className = 'y2k-bracket y2k-bracket-' + c;
      bracketFrameEl.appendChild(d);
    });
    document.body.appendChild(bracketFrameEl);
  }

  function createCrosshairs() {
    crosshairEl = document.createElement('div');
    crosshairEl.style.cssText = 'position:fixed;inset:0;z-index:1370;pointer-events:none;opacity:0.08';
    const positions = [
      { top: '33.3%', left: '33.3%', coord: '0.33 0.33' },
      { top: '33.3%', left: '66.6%', coord: '0.66 0.33' },
      { top: '66.6%', left: '33.3%', coord: '0.33 0.66' },
      { top: '66.6%', left: '66.6%', coord: '0.66 0.66' }
    ];
    positions.forEach(p => {
      const d = document.createElement('div');
      d.className = 'y2k-cross';
      d.style.top = p.top;
      d.style.left = p.left;
      d.textContent = '+';
      d.setAttribute('data-coord', p.coord);
      crosshairEl.appendChild(d);
    });
    document.body.appendChild(crosshairEl);
  }

  function createScanline() {
    scanlineEl = document.createElement('div');
    scanlineEl.id = 'y2k-scanline';
    document.body.appendChild(scanlineEl);
  }

  function createDatastream() {
    datastreamEl = document.createElement('div');
    datastreamEl.id = 'y2k-datastream';
    datastreamInnerEl = document.createElement('div');
    datastreamInnerEl.className = 'y2k-datastream-inner';
    datastreamEl.appendChild(datastreamInnerEl);
    document.body.appendChild(datastreamEl);
    updateDatastreamContent();
  }

  function createGradientCorners() {
    gradientCornersEl = document.createElement('div');
    gradientCornersEl.style.cssText = 'position:fixed;inset:0;z-index:1355;pointer-events:none;opacity:0.04';
    const tl = document.createElement('div');
    tl.className = 'y2k-gradient-corner y2k-gc-tl';
    const br = document.createElement('div');
    br.className = 'y2k-gradient-corner y2k-gc-br';
    gradientCornersEl.appendChild(tl);
    gradientCornersEl.appendChild(br);
    document.body.appendChild(gradientCornersEl);
  }

  function createSpectrum() {
    spectrumEl = document.createElement('div');
    spectrumEl.id = 'y2k-spectrum';
    specBars = [];
    for (let i = 0; i < 5; i++) {
      const bar = document.createElement('div');
      bar.className = 'y2k-spec-bar';
      bar.style.height = '2px';
      spectrumEl.appendChild(bar);
      specBars.push(bar);
    }
    document.body.appendChild(spectrumEl);
  }

  function createChordDisplay() {
    chordEl = document.createElement('div');
    chordEl.id = 'y2k-chord';
    var chordNameSpan = document.createElement('span');
    chordNameSpan.className = 'y2k-chord-name';
    chordEl.appendChild(chordNameSpan);
    chordSubEl = document.createElement('div');
    chordSubEl.id = 'y2k-chord-sub';
    chordEl.appendChild(chordSubEl);
    document.body.appendChild(chordEl);
  }

  function detectChord(notes) {
    if (!notes || notes.length < 2) return null;
    const classes = [...new Set(notes.map(n => n.midi % 12))].sort((a, b) => a - b);
    if (classes.length < 2) return null;
    const root = classes[0];
    const rootName = NOTE_NAMES[root];
    const intervals = classes.map(c => (c - root + 12) % 12);
    const has = n => intervals.indexOf(n) >= 0;
    let quality = '';
    let sub = '';
    if (has(4) && has(7) && has(11)) { quality = 'maj7'; sub = 'MAJOR SEVENTH'; }
    else if (has(3) && has(7) && has(10)) { quality = 'm7'; sub = 'MINOR SEVENTH'; }
    else if (has(4) && has(7) && has(10)) { quality = '7'; sub = 'DOMINANT 7TH'; }
    else if (has(3) && has(6)) { quality = 'dim'; sub = 'DIMINISHED'; }
    else if (has(4) && has(8)) { quality = 'aug'; sub = 'AUGMENTED'; }
    else if (has(2) && has(7)) { quality = 'sus2'; sub = 'SUSPENDED 2'; }
    else if (has(5) && has(7)) { quality = 'sus4'; sub = 'SUSPENDED 4'; }
    else if (has(4) && has(7)) { quality = ''; sub = 'MAJOR'; }
    else if (has(3) && has(7)) { quality = 'm'; sub = 'MINOR'; }
    else if (has(7)) { quality = '5'; sub = 'POWER'; }
    else { return null; }
    return { name: rootName + quality, sub: sub };
  }

  function createArcRing() {
    arcEl = document.createElement('div');
    arcEl.id = 'y2k-arc';
    const r = 19;
    const circ = 2 * Math.PI * r;
    arcEl.innerHTML = '<svg viewBox="0 0 44 44"><circle class="y2k-arc-bg" cx="22" cy="22" r="' + r + '"/><circle class="y2k-arc-fg" cx="22" cy="22" r="' + r + '" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + circ.toFixed(1) + '" transform="rotate(-90 22 22)"/></svg><div id="y2k-arc-label">0%</div>';
    document.body.appendChild(arcEl);
    arcFgEl = arcEl.querySelector('.y2k-arc-fg');
    arcLabelEl = arcEl.querySelector('#y2k-arc-label');
  }

  function createBreathingDots() {
    dotsEl = document.createElement('div');
    dotsEl.style.cssText = 'position:fixed;inset:0;z-index:1358;pointer-events:none';
    const positions = [
      { top: '18%', left: '8%' }, { top: '24%', right: '14%' },
      { top: '42%', left: '5%' }, { top: '52%', right: '6%' },
      { top: '78%', right: '22%' }, { top: '15%', right: '38%' },
      { top: '85%', left: '18%' }, { top: '38%', right: '32%' }
    ];
    positions.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'y2k-dot';
      d.style.animationDelay = (i * 0.4).toFixed(1) + 's';
      Object.keys(p).forEach(k => { d.style[k] = p[k]; });
      dotsEl.appendChild(d);
    });
    document.body.appendChild(dotsEl);
  }

  function createSysId() {
    sysIdEl = document.createElement('div');
    sysIdEl.id = 'y2k-sysid';
    sysIdEl.innerHTML = '<span>SONIC.SYS v2.6.0</span><span>BUILD 2026.02</span><span>48KHZ \u00B7 32BIT</span>';
    document.body.appendChild(sysIdEl);
  }

  function createCrtOverlays() {
    noiseEl = document.createElement('div');
    noiseEl.id = 'y2k-noise';
    document.body.appendChild(noiseEl);
    crtLinesEl = document.createElement('div');
    crtLinesEl.id = 'y2k-crt-lines';
    document.body.appendChild(crtLinesEl);
    glitchBarEl = document.createElement('div');
    glitchBarEl.id = 'y2k-glitch-bar';
    document.body.appendChild(glitchBarEl);
  }

  function createVelocityMeter() {
    velocityEl = document.createElement('div');
    velocityEl.id = 'y2k-velocity';
    velocityFillEl = document.createElement('div');
    velocityFillEl.id = 'y2k-velocity-fill';
    velocityLabelEl = document.createElement('div');
    velocityLabelEl.id = 'y2k-velocity-label';
    velocityLabelEl.textContent = 'VEL';
    velocityEl.appendChild(velocityFillEl);
    velocityEl.appendChild(velocityLabelEl);
    document.body.appendChild(velocityEl);
  }

  function createKeysigDisplay() {
    keysigEl = document.createElement('div');
    keysigEl.id = 'y2k-keysig';
    var keysigNameSpan = document.createElement('span');
    keysigNameSpan.className = 'y2k-keysig-name';
    keysigEl.appendChild(keysigNameSpan);
    keysigSubEl = document.createElement('div');
    keysigSubEl.id = 'y2k-keysig-sub';
    keysigEl.appendChild(keysigSubEl);
    document.body.appendChild(keysigEl);
  }

  function createWaveform() {
    waveformEl = document.createElement('div');
    waveformEl.id = 'y2k-waveform';
    waveformCanvas = document.createElement('canvas');
    waveformCanvas.width = 80;
    waveformCanvas.height = 140;
    waveformEl.appendChild(waveformCanvas);
    document.body.appendChild(waveformEl);
    waveformCtx = waveformCanvas.getContext('2d');
  }

  function createEdgeLines() {
    edgeLinesEl = document.createElement('div');
    edgeLinesEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:1356';
    var sides = ['left', 'right', 'top', 'bottom'];
    sides.forEach(function(s) {
      var d = document.createElement('div');
      d.className = 'y2k-edge-line y2k-edge-' + s;
      edgeLinesEl.appendChild(d);
    });
    document.body.appendChild(edgeLinesEl);
  }

  function createOrbitRing() {
    orbitEl = document.createElement('div');
    orbitEl.id = 'y2k-orbit';
    orbitEl.innerHTML = '<svg viewBox="0 0 64 64"><g id="y2k-orbit-group"><circle id="y2k-orbit-ring" cx="32" cy="32" r="28"/><circle class="y2k-orbit-dot" cx="32" cy="4" r="2"/><circle class="y2k-orbit-dot" cx="60" cy="32" r="1.5"/><circle class="y2k-orbit-dot" cx="32" cy="60" r="1.2"/></g></svg>';
    document.body.appendChild(orbitEl);
    orbitRingRef = orbitEl.querySelector('#y2k-orbit-ring');
    orbitDotRefs = orbitEl.querySelectorAll('.y2k-orbit-dot');
  }

  function createFreqLabel() {
    freqLabelEl = document.createElement('div');
    freqLabelEl.id = 'y2k-freq-label';
    freqHzEl = document.createElement('span');
    freqHzEl.id = 'y2k-freq-hz';
    freqLabelEl.appendChild(freqHzEl);
    freqLabelEl.appendChild(document.createTextNode('Hz'));
    document.body.appendChild(freqLabelEl);
  }

  function createPolycount() {
    polycountEl = document.createElement('div');
    polycountEl.id = 'y2k-polycount';
    polycountLabelEl = document.createElement('span');
    polycountLabelEl.id = 'y2k-polycount-label';
    polycountLabelEl.textContent = 'VOICES';
    polycountEl.appendChild(document.createTextNode('0'));
    polycountEl.appendChild(polycountLabelEl);
    document.body.appendChild(polycountEl);
  }

  function createTickerBars() {
    tickerBars = [];
    for (var i = 0; i < 6; i++) {
      var bar = document.createElement('div');
      bar.className = 'y2k-ticker-bar';
      bar.style.top = (20 + i * 10) + '%';
      bar.style.animationDelay = (i * 0.15) + 's';
      document.body.appendChild(bar);
      tickerBars.push(bar);
    }
  }

  function createConstellation() {
    constellationEl = document.createElement('div');
    constellationEl.id = 'y2k-constellation';
    constellationCanvas = document.createElement('canvas');
    constellationCanvas.width = 480;
    constellationCanvas.height = 480;
    constellationEl.appendChild(constellationCanvas);
    constellationCtx = constellationCanvas.getContext('2d');
    document.body.appendChild(constellationEl);
    window.addEventListener('mousemove', function(e) {
      constellationMouseX = e.clientX;
      constellationMouseY = e.clientY;
    }, { passive: true });
  }

  function createBeatFlash() {
    beatFlashEl = document.createElement('div');
    // Fixed gradient — never rewritten. Only opacity changes via smooth JS lerp.
    beatFlashEl.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none;opacity:0;mix-blend-mode:screen;background:radial-gradient(ellipse at center,rgba(255,255,255,0.45) 0%,rgba(200,220,255,0.15) 40%,rgba(0,0,0,0) 72%);will-change:opacity;contain:strict';
    document.body.appendChild(beatFlashEl);
  }

  function drawConstellation(hueDeg, activeNotes, energy, impact, kick, now) {
    var ctx = constellationCtx;
    if (!ctx) return;
    var W = 480, H = 480;
    ctx.clearRect(0, 0, W, H);
    var PI2 = Math.PI * 2;
    var cx = W * 0.5, cy = H * 0.5;
    // ── Aggressive beat scaling: ring SLAMS outward on kick ──
    var baseR = 90 + energy * 18;
    var impPulse = impact * 28;
    var kickPunch = kick * 18;
    var R = baseR + impPulse + kickPunch;
    var isPlaying = activeNotes.length > 0;
    // Beat-synced rotation: snaps forward on each kick
    var rotOffset = isPlaying ? now * 0.008 + kick * 0.15 : now * 0.025;

    // ── Build active note set + velocity map ──
    var activeSet = new Set();
    var velMap = {};
    for (var ai = 0; ai < activeNotes.length; ai++) {
      var pc = activeNotes[ai].midi % 12;
      activeSet.add(pc);
      velMap[pc] = Math.max(velMap[pc] || 0, activeNotes[ai].velocity || 0.7);
    }

    // ── Update afterglow (faster decay for punchy feel) ──
    for (var fi = 0; fi < 12; fi++) {
      if (activeSet.has(fi)) constellationFade[fi] = 1.0;
      else if (constellationFade[fi] > 0.01) constellationFade[fi] *= 0.88;
      else constellationFade[fi] = 0;
    }

    // ── Mouse warp ──
    var rect = constellationEl.getBoundingClientRect();
    var elCx = rect.left + rect.width * 0.5;
    var elCy = rect.top + rect.height * 0.5;
    var mdx = constellationMouseX - elCx;
    var mdy = constellationMouseY - elCy;
    var mDist = Math.sqrt(mdx * mdx + mdy * mdy);
    var warpFactor = mDist < 300 ? (300 - mDist) / 300 * 0.25 : 0;
    var mlx = (constellationMouseX - rect.left) / rect.width * W;
    var mly = (constellationMouseY - rect.top) / rect.height * H;

    // ── L0: Beat flash — full canvas white flash on strong kicks ──
    if (kick > 0.4) {
      ctx.fillStyle = 'hsla(' + hueDeg + ',90%,95%,' + ((kick - 0.4) * 0.12).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    // ── L1: Background energy field ──
    if (energy > 0.03 || impact > 0.05) {
      var bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R + 60);
      bgGrad.addColorStop(0, 'hsla(' + hueDeg + ',80%,60%,' + (energy * 0.12 + impact * 0.10).toFixed(3) + ')');
      bgGrad.addColorStop(0.5, 'hsla(' + hueDeg + ',60%,50%,' + (energy * 0.05 + impact * 0.04).toFixed(3) + ')');
      bgGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
    }

    // ── L2: Double rotating HUD rings ──
    ctx.save();
    ctx.translate(cx, cy);
    // Outer ring — counter-rotates, snaps on beat
    ctx.rotate(now * -0.02 - kick * 0.2);
    ctx.beginPath();
    ctx.arc(0, 0, R + 24, 0, PI2);
    ctx.strokeStyle = 'hsla(' + hueDeg + ',45%,78%,' + (0.06 + impact * 0.18).toFixed(2) + ')';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 10]);
    ctx.stroke();
    ctx.setLineDash([]);
    // Inner accent ring — rotates opposite
    ctx.rotate(now * 0.06 + kick * 0.3);
    ctx.beginPath();
    ctx.arc(0, 0, R + 12, 0, PI2);
    ctx.strokeStyle = 'hsla(' + ((hueDeg + 60) % 360) + ',40%,72%,' + (0.04 + impact * 0.10).toFixed(2) + ')';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 14]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // ── Compute node positions ──
    var nodes = [];
    for (var i = 0; i < 12; i++) {
      var angle = i * (PI2 / 12) - Math.PI * 0.5 + rotOffset;
      // Per-node jitter, amplified by beat
      var jitter = isPlaying ? Math.sin(now * 4.5 + i * 2.1) * (energy * 6 + kick * 10) : 0;
      var nr = R + jitter;
      var nx = cx + nr * Math.cos(angle);
      var ny = cy + nr * Math.sin(angle);
      if (warpFactor > 0) {
        nx += (mlx - cx) * warpFactor;
        ny += (mly - cy) * warpFactor;
      }
      nodes.push({ x: nx, y: ny, active: activeSet.has(i), angle: angle, vel: velMap[i] || 0, fade: constellationFade[i] });
    }

    // ── L3: Ambient particles (burst outward on kick) ──
    if (!constellationParticles) {
      constellationParticles = [];
      for (var pp = 0; pp < 14; pp++) {
        constellationParticles.push({ a: Math.random() * PI2, r: Math.random() * 0.6 + 0.2, speed: (Math.random() - 0.5) * 0.004, drift: Math.random() * 0.002 });
      }
    }
    ctx.globalAlpha = 0.3 + energy * 0.4 + kick * 0.2;
    for (var pi = 0; pi < 14; pi++) {
      var pt = constellationParticles[pi];
      pt.a += pt.speed + energy * 0.012 + kick * 0.04;
      pt.r += pt.drift + kick * 0.02;
      if (pt.r > 0.92) { pt.drift = -Math.abs(pt.drift); pt.r = 0.92; }
      if (pt.r < 0.08) { pt.drift = Math.abs(pt.drift); pt.r = 0.08; }
      var pRadius = R * pt.r;
      var px = cx + pRadius * Math.cos(pt.a + rotOffset);
      var py = cy + pRadius * Math.sin(pt.a + rotOffset);
      var pSize = 1.5 + energy * 2 + kick * 3;
      ctx.beginPath();
      ctx.arc(px, py, pSize, 0, PI2);
      ctx.fillStyle = 'hsla(' + ((hueDeg + pi * 25) % 360) + ',55%,82%,0.55)';
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // ── L4: Radial tick marks — pulse height on beat ──
    var tickExt = 6 + impact * 12 + kick * 8;
    for (var ti = 0; ti < 12; ti++) {
      var ta = nodes[ti].angle;
      var tFade = nodes[ti].fade;
      var tActive = tFade > 0.5;
      var tickInner = R - 10 - (tActive ? tickExt * 0.5 : 0);
      var tickOuter = R + 6 + (tActive ? tickExt : 0);
      ctx.beginPath();
      ctx.moveTo(cx + tickInner * Math.cos(ta), cy + tickInner * Math.sin(ta));
      ctx.lineTo(cx + tickOuter * Math.cos(ta), cy + tickOuter * Math.sin(ta));
      ctx.strokeStyle = tActive
        ? 'hsla(' + hueDeg + ',75%,88%,' + (0.4 + tFade * 0.5 + impact * 0.1).toFixed(2) + ')'
        : 'hsla(' + hueDeg + ',25%,65%,' + Math.max(0.06, tFade * 0.35).toFixed(2) + ')';
      ctx.lineWidth = tActive ? 3 : 1;
      ctx.stroke();
    }

    // ── L5: Harmonic arcs + polygon ──
    var activeIdxs = [];
    for (var j = 0; j < 12; j++) {
      if (nodes[j].active) activeIdxs.push(j);
    }
    if (activeIdxs.length >= 2) {
      ctx.lineCap = 'round';
      for (var a = 0; a < activeIdxs.length; a++) {
        for (var b = a + 1; b < activeIdxs.length; b++) {
          var na = nodes[activeIdxs[a]], nb = nodes[activeIdxs[b]];
          var interval = Math.abs(activeIdxs[b] - activeIdxs[a]);
          if (interval > 6) interval = 12 - interval;
          var tension = interval / 6;
          var mx = (na.x + nb.x) * 0.5, my = (na.y + nb.y) * 0.5;
          var perpX = -(nb.y - na.y), perpY = nb.x - na.x;
          var pLen = Math.sqrt(perpX * perpX + perpY * perpY) || 1;
          var dir = ((a + b) & 1) ? 1 : -1;
          var curveAmt = tension * 0.4 * dir;
          var cpx = mx + perpX / pLen * curveAmt * R;
          var cpy = my + perpY / pLen * curveAmt * R;
          // Glow
          ctx.beginPath();
          ctx.moveTo(na.x, na.y);
          ctx.quadraticCurveTo(cpx, cpy, nb.x, nb.y);
          ctx.strokeStyle = 'hsla(' + ((hueDeg + 180) % 360) + ',75%,78%,' + (0.08 + impact * 0.12).toFixed(2) + ')';
          ctx.lineWidth = 8 + impact * 4;
          ctx.stroke();
          // Core
          ctx.beginPath();
          ctx.moveTo(na.x, na.y);
          ctx.quadraticCurveTo(cpx, cpy, nb.x, nb.y);
          ctx.strokeStyle = 'hsla(' + ((hueDeg + 180) % 360) + ',68%,85%,' + (0.45 + impact * 0.25).toFixed(2) + ')';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';

      // Polygon fill — brighter on beat
      if (activeIdxs.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(nodes[activeIdxs[0]].x, nodes[activeIdxs[0]].y);
        for (var pk = 1; pk < activeIdxs.length; pk++) ctx.lineTo(nodes[activeIdxs[pk]].x, nodes[activeIdxs[pk]].y);
        ctx.closePath();
        ctx.fillStyle = 'hsla(' + hueDeg + ',65%,68%,' + (0.03 + impact * 0.08 + kick * 0.05).toFixed(3) + ')';
        ctx.fill();
      }
    }

    // ── L6: Nodes ──
    for (var k = 0; k < 12; k++) {
      var nd = nodes[k];
      var fade = nd.fade;
      if (nd.active) {
        // Beat-scaled glow layers
        var beatScale = 1 + impact * 0.6 + kick * 0.4;
        // L1: wide glow
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, (20 + nd.vel * 8) * beatScale, 0, PI2);
        ctx.fillStyle = 'hsla(' + hueDeg + ',85%,78%,' + (0.06 + kick * 0.04).toFixed(3) + ')';
        ctx.fill();
        // L2: mid glow
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, (10 + nd.vel * 4) * beatScale, 0, PI2);
        ctx.fillStyle = 'hsla(' + hueDeg + ',82%,82%,' + (0.16 + impact * 0.10).toFixed(2) + ')';
        ctx.fill();
        // L3: core
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, (5 + nd.vel * 2) * beatScale, 0, PI2);
        ctx.fillStyle = 'hsla(' + hueDeg + ',78%,95%,0.95)';
        ctx.fill();
      } else if (fade > 0.02) {
        // Afterglow trail
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 14 * fade, 0, PI2);
        ctx.fillStyle = 'hsla(' + hueDeg + ',60%,75%,' + (fade * 0.10).toFixed(3) + ')';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 4 + fade * 3, 0, PI2);
        ctx.fillStyle = 'hsla(' + hueDeg + ',55%,85%,' + (fade * 0.55).toFixed(3) + ')';
        ctx.fill();
      } else {
        // Mouse proximity
        var nsx = rect.left + nd.x / W * rect.width;
        var nsy = rect.top + nd.y / H * rect.height;
        var ndx2 = constellationMouseX - nsx, ndy2 = constellationMouseY - nsy;
        var nodeDist = Math.sqrt(ndx2 * ndx2 + ndy2 * ndy2);
        var proxAlpha = nodeDist < 100 ? 0.10 + (100 - nodeDist) / 100 * 0.40 : 0.10;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, nodeDist < 100 ? 4 : 2, 0, PI2);
        ctx.fillStyle = 'hsla(' + hueDeg + ',35%,75%,' + proxAlpha.toFixed(2) + ')';
        ctx.fill();
      }
    }

    // ── L7: Note labels ──
    var labelNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    ctx.font = '600 16px "Lucida Console", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var li = 0; li < 12; li++) {
      var lFade = nodes[li].fade;
      var showLabel = lFade > 0.1 || mDist < 220;
      if (!showLabel) continue;
      var lAngle = nodes[li].angle;
      var lR = R + 30;
      var lx = cx + lR * Math.cos(lAngle);
      var ly = cy + lR * Math.sin(lAngle);
      if (warpFactor > 0) { lx += (mlx - cx) * warpFactor; ly += (mly - cy) * warpFactor; }
      if (lFade > 0.5) {
        ctx.fillStyle = 'hsla(' + hueDeg + ',75%,94%,' + Math.min(0.95, 0.4 + lFade * 0.55).toFixed(2) + ')';
      } else if (mDist < 220) {
        var labelAlpha = Math.min(0.45, (220 - mDist) / 220 * 0.45);
        ctx.fillStyle = 'hsla(' + hueDeg + ',25%,72%,' + Math.max(labelAlpha, lFade * 0.5).toFixed(2) + ')';
      } else {
        ctx.fillStyle = 'hsla(' + hueDeg + ',35%,78%,' + (lFade * 0.5).toFixed(2) + ')';
      }
      ctx.fillText(labelNames[li], lx, ly);
    }

    // ── L8: Center root note ──
    if (isPlaying && activeNotes.length > 0) {
      var rootPc = activeNotes[0].midi % 12;
      // Glow circle
      ctx.beginPath();
      ctx.arc(cx, cy - 4, 30 + impact * 10, 0, PI2);
      ctx.fillStyle = 'hsla(' + hueDeg + ',65%,72%,' + (0.05 + impact * 0.06).toFixed(3) + ')';
      ctx.fill();
      ctx.font = '200 42px "Lucida Console", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'hsla(' + hueDeg + ',55%,96%,' + (0.7 + impact * 0.3).toFixed(2) + ')';
      ctx.fillText(labelNames[rootPc], cx, cy - 8);
      ctx.font = '400 12px "Lucida Console", monospace';
      ctx.fillStyle = 'hsla(' + hueDeg + ',40%,82%,' + (0.3 + impact * 0.15).toFixed(2) + ')';
      ctx.fillText('OCT' + (Math.floor(activeNotes[0].midi / 12) - 1), cx, cy + 18);
    }

    // ── L9: Shockwave rings (bigger, more dramatic) ──
    if (constellationShockwave > 0) {
      for (var sw = 0; sw < 4; sw++) {
        var swR = constellationShockwave - sw * 10;
        if (swR <= 0) continue;
        var swAlpha = (1 - swR / 80) * (1 - sw * 0.25);
        if (swAlpha <= 0) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, swR * 2.8, 0, PI2);
        ctx.strokeStyle = 'hsla(' + hueDeg + ',85%,88%,' + (swAlpha * 0.55).toFixed(3) + ')';
        ctx.lineWidth = 2.5 - sw * 0.5;
        ctx.stroke();
      }
    }

    // ── L10: Main ring (beat-reactive width + brightness) ──
    var ringAlpha = 0.10 + Math.sin(now * 0.8) * 0.03 + impact * 0.18 + kick * 0.10;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, PI2);
    ctx.strokeStyle = 'hsla(' + hueDeg + ',45%,78%,' + ringAlpha.toFixed(3) + ')';
    ctx.lineWidth = 1.5 + impact * 2;
    ctx.stroke();

    // ── L11: Energy spokes on strong beats ──
    if (impact > 0.3) {
      var spokeAlpha = (impact - 0.3) * 0.5;
      for (var si = 0; si < 6; si++) {
        var sAngle = si * (PI2 / 6) + now * 0.1;
        var sInner = R * 0.3;
        var sOuter = R + impact * 20;
        ctx.beginPath();
        ctx.moveTo(cx + sInner * Math.cos(sAngle), cy + sInner * Math.sin(sAngle));
        ctx.lineTo(cx + sOuter * Math.cos(sAngle), cy + sOuter * Math.sin(sAngle));
        ctx.strokeStyle = 'hsla(' + ((hueDeg + 90) % 360) + ',60%,80%,' + (spokeAlpha * 0.15).toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // ── L12: Mouse beam + crosshair ──
    if (mDist < 200 && warpFactor > 0) {
      var beamGrad = ctx.createLinearGradient(cx, cy, mlx, mly);
      beamGrad.addColorStop(0, 'hsla(' + hueDeg + ',60%,82%,' + (warpFactor * 0.6).toFixed(3) + ')');
      beamGrad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(mlx, mly);
      ctx.strokeStyle = beamGrad;
      ctx.lineWidth = 1;
      ctx.stroke();
      var chSize = 8;
      ctx.strokeStyle = 'hsla(' + hueDeg + ',50%,88%,' + Math.min(1, warpFactor * 2).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(mlx - chSize, mly); ctx.lineTo(mlx + chSize, mly);
      ctx.moveTo(mlx, mly - chSize); ctx.lineTo(mlx, mly + chSize);
      ctx.stroke();
    }
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }




  function updateDatastreamContent() {
    if (!datastreamInnerEl) return;
    const hueDeg = Math.round(currentKeyHue * 360) % 360;
    const bpm = midiSourceBpm ? Math.round(midiSourceBpm * midiPlaybackSpeed) : 120;
    const t = Math.floor(performance.now() * 0.001);
    const segments = [];
    for (let i = 0; i < 24; i++) {
      const hex = ((i * 17 + hueDeg + t) % 256).toString(16).toUpperCase().padStart(2, '0');
      const hex2 = ((i * 31 + 42) % 256).toString(16).toUpperCase().padStart(2, '0');
      const m = i % 6;
      if (m === 0) segments.push('SYS.' + bpm + 'BPM');
      else if (m === 1) segments.push('0x' + hex + hex2);
      else if (m === 2) segments.push('FFT:' + ((bassLevel * 255 | 0).toString(16).toUpperCase().padStart(2, '0')) + '/' + ((midLevel * 255 | 0).toString(16).toUpperCase().padStart(2, '0')) + '/' + ((trebleLevel * 255 | 0).toString(16).toUpperCase().padStart(2, '0')));
      else if (m === 3) segments.push('HUE:' + hueDeg + 'DEG');
      else if (m === 4) segments.push('NRG:' + (audioEnergy * 100 | 0) + '%');
      else segments.push('CH:' + keysPressed.size);
    }
    const text = segments.join('  \u00B7  ');
    datastreamInnerEl.textContent = text + '  \u00B7  ' + text;
  }

  function updateHeadBar() {
    if (!headBarEl) return;
    const pct = Math.max(3, Math.min(97, headX * 100));
    headDotEl.style.left = pct + '%';
    let zone;
    if (headX < 0.33) zone = 'L';
    else if (headX > 0.67) zone = 'R';
    else zone = '\u25C6';
    // Smooth color transition based on position (not just 3 zones)
    const r = Math.round(180 + headOffset_g * -300); // redder on left
    const b = Math.round(180 + headOffset_g * 300);  // bluer on right
    const dotColor = 'rgb(' + Math.max(100,Math.min(255,r)) + ',220,' + Math.max(100,Math.min(255,b)) + ')';
    headDotEl.style.background = dotColor;
    headDotEl.style.boxShadow = '0 0 8px 2px ' + dotColor;
    if (zone !== headZone) {
      headZone = zone;
      headLabelEl.textContent = zone;
    }
  }
  let headOffset_g = 0; // global for bar color

  async function initHeadTracking() {
    if (headTrackingActive) return;
    createHeadBar();
    createGestureBar();
    createVhsTimestamp();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user', frameRate: { ideal: 30 } },
        audio: false
      });
      headVideo = document.createElement('video');
      headVideo.srcObject = stream;
      headVideo.setAttribute('playsinline', '');
      headVideo.setAttribute('muted', '');
      headVideo.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;z-index:-1;pointer-events:none';
      document.body.appendChild(headVideo);
      await headVideo.play();
      // Wait for video to actually produce frames
      await new Promise(resolve => {
        const check = () => {
          if (headVideo.readyState >= 2 && headVideo.videoWidth > 0) resolve();
          else setTimeout(check, 100);
        };
        check();
      });
      headCanvas = document.createElement('canvas');
      headCanvas.width = 240; headCanvas.height = 180;
      headCtx = headCanvas.getContext('2d', { willReadFrequently: true });
      // Try native FaceDetector API
      if (typeof FaceDetector !== 'undefined') {
        try {
          faceDetector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
          // Test it actually works
          await faceDetector.detect(headCanvas);
          detectionMethod = 'FaceDetector API';
        } catch (_) { faceDetector = null; }
      }
      if (!faceDetector) detectionMethod = 'skin+motion';
      headTrackingActive = true;
      headBarEl.style.opacity = '1';
      headLabelEl.style.opacity = '1';
      headConfEl.style.opacity = '1';
      if (gestureBarEl) { gestureBarEl.style.opacity = '1'; gestureLabelEl.style.opacity = '1'; gestureKnobLabelEl.style.opacity = '1'; }
      console.log('Head tracking: ' + detectionMethod);
    } catch (e) {
      console.warn('Camera access denied or unavailable:', e.message || e);
      if (headBarEl) { headBarEl.remove(); headLabelEl.remove(); headConfEl.remove(); }
      if (gestureBarEl) { gestureBarEl.remove(); gestureLabelEl.remove(); gestureKnobLabelEl.remove(); }
    }
  }

  function detectHeadPosition() {
    if (!headTrackingActive || !headVideo || !headCtx) return;
    if (headVideo.readyState < 2) return;
    const now = performance.now();
    if (now - lastHeadDetect < 33) return; // ~30fps
    lastHeadDetect = now;

    const cw = headCanvas.width, ch = headCanvas.height;
    headCtx.drawImage(headVideo, 0, 0, cw, ch);

    let rawX = 0.5;
    let conf = 0;

    if (faceDetector) {
      const data = headCtx.getImageData(0, 0, cw, ch).data;
      detectHandGesture(data, cw, ch, !!prevFrameData, prevFrameData);
      if (!prevFrameData) prevFrameData = new Uint8Array(data.length);
      prevFrameData.set(data);
      faceDetector.detect(headCanvas).then(faces => {
        if (faces.length > 0) {
          const box = faces[0].boundingBox;
          const cx = (box.x + box.width / 2) / cw;
          const cy = (box.y + box.height / 2) / ch;
          rawX = 1 - cx;
          const rawY = 1 - cy; // up in frame = smaller Y
          conf = 0.95;
          const lerp = 0.52;
          headX += (rawX - headX) * lerp;
          headY += (rawY - headY) * lerp;
          headConfidence = conf;
          detectionMethod = 'FaceDetector';
          updateHeadBar();
        }
      }).catch(() => {});
      return;
    }

    // --- Robust column-energy detection ---
    // Divide frame into vertical columns. Find the column with the most
    // "interesting" content (high contrast + motion). The densest column cluster
    // = where the face/head is. This works regardless of skin tone.
    const data = headCtx.getImageData(0, 0, cw, ch).data;
    const hasPrev = prevFrameData && prevFrameData.length === data.length;
    const numCols = 16;
    const colW = Math.floor(cw / numCols);
    const colEnergy = new Float32Array(numCols);
    const step = 2;
    const yStart = Math.floor(ch * 0.05); // skip very top
    const yEnd = Math.floor(ch * 0.85);   // skip bottom (body/desk)

    for (let c = 0; c < numCols; c++) {
      const x0 = c * colW;
      const x1 = x0 + colW;
      let energy = 0;
      for (let y = yStart; y < yEnd; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * cw + x) * 4;
          const R = data[i], G = data[i+1], B = data[i+2];
          // Luminance contrast: difference from neighbors
          if (x + step < x1 && y + step < yEnd) {
            const j = (y * cw + x + step) * 4;
            const k = ((y + step) * cw + x) * 4;
            energy += Math.abs(R - data[j]) + Math.abs(G - data[j+1]) + Math.abs(B - data[j+2]);
            energy += Math.abs(R - data[k]) + Math.abs(G - data[k+1]) + Math.abs(B - data[k+2]);
          }
          // Motion energy
          if (hasPrev) {
            energy += (Math.abs(R - prevFrameData[i]) + Math.abs(G - prevFrameData[i+1]) + Math.abs(B - prevFrameData[i+2])) * 3;
          }
        }
      }
      colEnergy[c] = energy;
    }

    // Save frame
    if (!prevFrameData) prevFrameData = new Uint8Array(data.length);
    prevFrameData.set(data);

    // Hand gesture from bottom half of frame (virtual knobs + fast swipe)
    detectHandGesture(data, cw, ch, hasPrev, prevFrameData);

    // Find peak energy cluster (the face is the biggest high-energy region)
    // Smooth the column energies to find a broad peak
    const smooth = new Float32Array(numCols);
    for (let c = 0; c < numCols; c++) {
      let s = colEnergy[c] * 2;
      if (c > 0) s += colEnergy[c-1];
      if (c < numCols-1) s += colEnergy[c+1];
      if (c > 1) s += colEnergy[c-2] * 0.5;
      if (c < numCols-2) s += colEnergy[c+2] * 0.5;
      smooth[c] = s;
    }

    // Find the peak
    let peakCol = numCols / 2;
    let peakVal = 0;
    for (let c = 0; c < numCols; c++) {
      if (smooth[c] > peakVal) { peakVal = smooth[c]; peakCol = c; }
    }

    // Weighted centroid around the peak (±3 columns)
    let wSum = 0, wTotal = 0;
    for (let c = Math.max(0, peakCol - 3); c <= Math.min(numCols - 1, peakCol + 3); c++) {
      wSum += smooth[c] * (c + 0.5);
      wTotal += smooth[c];
    }
    const centroid = wTotal > 0 ? wSum / wTotal / numCols : 0.5;

    // Row energy in peak column for vertical head position (VR/AR)
    const numRows = 12;
    const rowH = Math.floor((yEnd - yStart) / numRows);
    let peakRow = numRows / 2;
    let rowPeakVal = 0;
    const x0 = peakCol * colW, x1 = x0 + colW;
    for (let r = 0; r < numRows; r++) {
      const y0 = yStart + r * rowH, y1 = Math.min(y0 + rowH, yEnd);
      let energy = 0;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const i = (y * cw + x) * 4;
          energy += data[i] + data[i+1] + data[i+2];
          if (hasPrev) energy += (Math.abs(data[i] - prevFrameData[i]) + Math.abs(data[i+1] - prevFrameData[i+1]) + Math.abs(data[i+2] - prevFrameData[i+2])) * 2;
        }
      }
      if (energy > rowPeakVal) { rowPeakVal = energy; peakRow = r; }
    }
    const rowCentroid = (peakRow + 0.5) / numRows;
    const rawY = 1 - rowCentroid;

    // Total energy — very low threshold to pick up any subject
    let totalEnergy = 0;
    for (let c = 0; c < numCols; c++) totalEnergy += colEnergy[c];
    const energyThreshold = numCols * 100; // very sensitive

    if (totalEnergy > energyThreshold) {
      rawX = 1 - centroid;
      conf = Math.min(1, totalEnergy / (energyThreshold * 5));
      detectionMethod = 'tracking';
    } else {
      conf = 0.1; // still try even with low energy
      rawX = 1 - centroid;
      detectionMethod = 'low';
    }

    // Very responsive lerp — track every small movement (sensitive, realistic)
    const lerpSpeed = 0.42 + conf * 0.45;
    headX += (rawX - headX) * lerpSpeed;
    headY += (rawY - headY) * lerpSpeed * 0.85;
    headConfidence = conf;
    updateHeadBar();
  }

  // Synth: low octave Z–M (C3–B3), mid Q–P (C4–E5), high [ ] (F5, G5)
  const KEY_TO_NOTE = {
    KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57, KeyM: 59,
    KeyQ: 60, KeyW: 62, KeyE: 64, KeyR: 65, KeyT: 67, KeyY: 69, KeyU: 71, KeyI: 72, KeyO: 74, KeyP: 76,
    BracketLeft: 77, BracketRight: 79
  };
  const KEY_TO_LABEL = {
    KeyZ: 'Z', KeyX: 'X', KeyC: 'C', KeyV: 'V', KeyB: 'B', KeyN: 'N', KeyM: 'M',
    KeyQ: 'Q', KeyW: 'W', KeyE: 'E', KeyR: 'R', KeyT: 'T', KeyY: 'Y', KeyU: 'U', KeyI: 'I', KeyO: 'O', KeyP: 'P',
    BracketLeft: '[', BracketRight: ']'
  };
  // Drums: middle row A–L + ; ' \ (12 pads, 2020s kit)
  const DRUM_KEYS = {
    KeyA: 'kick', KeyS: 'snare', KeyD: '808', KeyF: 'clap', KeyG: 'hatClosed', KeyH: 'hatOpen',
    KeyJ: 'rim', KeyK: 'snap', KeyL: 'tomLow', Semicolon: 'tomMid', Quote: 'ride', Backslash: 'crash'
  };
  const DRUM_KEY_ORDER = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Backslash'];
  function gmDrumToType(midi) {
    const m = Math.max(0, Math.min(127, Math.round(midi || 0)));
    if (m === 35 || m === 36) return 'kick';
    if (m === 37) return 'rim';
    if (m === 38 || m === 40) return 'snare';
    if (m === 39) return 'clap';
    if (m === 41 || m === 43) return 'tomLow';
    if (m === 45 || m === 47) return 'tomMid';
    if (m === 42 || m === 44) return 'hatClosed';
    if (m === 46) return 'hatOpen';
    if (m === 49 || m === 57) return 'crash';
    if (m === 51 || m === 59) return 'ride';
    if (m >= 27 && m <= 34) return '808';
    return 'snap';
  }
  function gmDrumVariant(midi) {
    const m = Math.max(0, Math.min(127, Math.round(midi || 0)));
    if (m === 35) return 'kick_deep';
    if (m === 36) return 'kick_punch';
    if (m === 37) return 'rim_wood';
    if (m === 38) return 'snare_acoustic';
    if (m === 39) return 'clap_wide';
    if (m === 40) return 'snare_tight';
    if (m === 41) return 'tom_floor';
    if (m === 42) return 'hat_closed_tight';
    if (m === 43) return 'tom_floor_bright';
    if (m === 44) return 'hat_pedal';
    if (m === 45) return 'tom_mid_round';
    if (m === 46) return 'hat_open_short';
    if (m === 47) return 'tom_mid_tight';
    if (m === 48) return 'tom_high_round';
    if (m === 49) return 'crash_bright';
    if (m === 50) return 'tom_high_tight';
    if (m === 51) return 'ride_bright';
    if (m === 52) return 'crash_soft';
    if (m === 53) return 'ride_bell';
    if (m === 55) return 'crash_splash';
    if (m === 57) return 'crash_dark';
    if (m === 59) return 'ride_dark';
    if (m >= 27 && m <= 30) return '808_sub';
    if (m >= 31 && m <= 34) return '808_click';
    return 'snap_dry';
  }
  function drumTypeToVisualIndex(type) {
    const t = String(type || '').toLowerCase();
    const map = {
      kick: 0, snare: 1, '808': 2, clap: 3, hatclosed: 4, hatopen: 5,
      rim: 6, snap: 7, tomlow: 8, tommid: 9, ride: 10, crash: 11
    };
    return map[t] != null ? map[t] : 7;
  }
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function midiToNoteName(midi) {
    const oct = Math.floor(midi / 12) - 1;
    return NOTE_NAMES[midi % 12] + oct;
  }
  const SUSTAIN_CLASSES = [0, 2, 4, 5];

  function isSustainNote(midi) {
    return SUSTAIN_CLASSES.indexOf(midi % 12) !== -1;
  }
  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  let reverbNode = null;
  let chorusDelay1 = null, chorusDelay2 = null;
  let compressor = null;
  let limiter = null;
  let mixAutoGain = null;
  let outputBusGain = null;
  let drumGain = null;
  let drumDryBus = null;
  let leadDriveCurve = null;
  let activeLeadVoices = 0;
  let activeDrumVoices = 0;
  let chordCount = 0; // how many notes active simultaneously

  // Per-track mixer: gain + pan nodes for MIDI track-level control
  const trackMixerNodes = new Map();
  function getTrackMixerNode(trackIndex) {
    if (!audioCtx || !masterGain) return null;
    const ti = trackIndex | 0;
    if (trackMixerNodes.has(ti)) return trackMixerNodes.get(ti);
    const g = audioCtx.createGain();
    g.gain.value = 1.0;
    const fxInput = audioCtx.createGain(); fxInput.gain.value = 1.0;
    const fxOutput = audioCtx.createGain(); fxOutput.gain.value = 1.0;
    fxInput.connect(fxOutput); // default passthrough
    fxOutput.connect(masterGain);
    let pan = null;
    if (typeof audioCtx.createStereoPanner === 'function') {
      pan = audioCtx.createStereoPanner();
      pan.pan.value = 0;
      g.connect(pan);
      pan.connect(fxInput);
    } else {
      g.connect(fxInput);
    }
    const node = { gain: g, pan: pan, volume: 1.0, panValue: 0, fxInput, fxOutput };
    trackMixerNodes.set(ti, node);
    if (!trackEffectChains.has(ti)) trackEffectChains.set(ti, createDefaultEffectChain());
    return node;
  }
  function setTrackVolume(trackIndex, vol) {
    const n = getTrackMixerNode(trackIndex);
    if (!n) return;
    n.volume = clamp01(vol);
    const t = audioCtx.currentTime;
    n.gain.gain.cancelScheduledValues(t);
    n.gain.gain.setValueAtTime(n.gain.gain.value, t);
    n.gain.gain.linearRampToValueAtTime(n.volume, t + 0.035);
  }
  function setTrackPan(trackIndex, panVal) {
    const n = getTrackMixerNode(trackIndex);
    if (!n || !n.pan) return;
    n.panValue = Math.max(-1, Math.min(1, panVal));
    const t = audioCtx.currentTime;
    n.pan.pan.cancelScheduledValues(t);
    n.pan.pan.setValueAtTime(n.pan.pan.value, t);
    n.pan.pan.linearRampToValueAtTime(n.panValue, t + 0.035);
  }
  // Drum track mixer nodes (same concept, routes through drumGain)
  const drumTrackMixerNodes = new Map();
  function getDrumTrackMixerNode(trackIndex) {
    if (!audioCtx || !drumGain) return null;
    const ti = trackIndex | 0;
    if (drumTrackMixerNodes.has(ti)) return drumTrackMixerNodes.get(ti);
    const g = audioCtx.createGain();
    g.gain.value = 1.0;
    const fxInput = audioCtx.createGain(); fxInput.gain.value = 1.0;
    const fxOutput = audioCtx.createGain(); fxOutput.gain.value = 1.0;
    fxInput.connect(fxOutput);
    fxOutput.connect(drumGain);
    let pan = null;
    if (typeof audioCtx.createStereoPanner === 'function') {
      pan = audioCtx.createStereoPanner();
      pan.pan.value = 0;
      g.connect(pan);
      pan.connect(fxInput);
    } else {
      g.connect(fxInput);
    }
    const node = { gain: g, pan: pan, volume: 1.0, panValue: 0, fxInput, fxOutput };
    drumTrackMixerNodes.set(ti, node);
    const key = 'd' + ti;
    if (!trackEffectChains.has(key)) trackEffectChains.set(key, createDefaultEffectChain());
    return node;
  }

  // === PER-TRACK EFFECT CHAINS ===
  const trackEffectChains = new Map();
  function createDefaultEffectChain() {
    return {
      eq:         { enabled: false, nodes: null, params: { lowFreq: 200, lowGain: 0, midFreq: 1000, midGain: 0, midQ: 1.0, highFreq: 5000, highGain: 0 } },
      phaser:     { enabled: false, nodes: null, params: { rate: 0.5, depth: 0.7, stages: 4, feedback: 0.4 } },
      reverb:     { enabled: false, nodes: null, params: { decay: 1.5, mix: 0.3, preDelay: 0.02, damping: 5000 } },
      delay:      { enabled: false, nodes: null, params: { time: 0.375, feedback: 0.35, mix: 0.3, filter: 4000 } },
      chorus:     { enabled: false, nodes: null, params: { rate: 1.1, depth: 0.006, mix: 0.4 } },
      distortion: { enabled: false, nodes: null, params: { drive: 4, tone: 3000, mix: 0.5 } }
    };
  }
  function createEQNodes(p) {
    const input = audioCtx.createGain(); input.gain.value = 1;
    const output = audioCtx.createGain(); output.gain.value = 1;
    const low = audioCtx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = p.lowFreq; low.gain.value = p.lowGain;
    const mid = audioCtx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = p.midFreq; mid.Q.value = p.midQ; mid.gain.value = p.midGain;
    const high = audioCtx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = p.highFreq; high.gain.value = p.highGain;
    input.connect(low); low.connect(mid); mid.connect(high); high.connect(output);
    return { input, output, low, mid, high };
  }
  function createPhaserNodes(p) {
    const input = audioCtx.createGain(); input.gain.value = 1;
    const output = audioCtx.createGain(); output.gain.value = 1;
    const dry = audioCtx.createGain(); dry.gain.value = 0.5;
    const wet = audioCtx.createGain(); wet.gain.value = 0.5;
    const stageCount = Math.round(p.stages) || 4;
    const stages = [];
    for (let i = 0; i < stageCount; i++) {
      const ap = audioCtx.createBiquadFilter(); ap.type = 'allpass';
      ap.frequency.value = 800 + i * 400; ap.Q.value = 0.5;
      stages.push(ap);
    }
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = p.rate;
    const lfoGain = audioCtx.createGain(); lfoGain.gain.value = p.depth * 1500;
    lfo.connect(lfoGain); stages.forEach(ap => lfoGain.connect(ap.frequency)); lfo.start();
    const fb = audioCtx.createGain(); fb.gain.value = p.feedback;
    input.connect(dry); dry.connect(output);
    let prev = input; stages.forEach(ap => { prev.connect(ap); prev = ap; });
    prev.connect(wet); prev.connect(fb); fb.connect(stages[0]); wet.connect(output);
    return { input, output, stages, lfo, lfoGain, fb, dry, wet };
  }
  function createReverbNodes(p) {
    const input = audioCtx.createGain(); input.gain.value = 1;
    const output = audioCtx.createGain(); output.gain.value = 1;
    const dry = audioCtx.createGain(); dry.gain.value = 1 - p.mix;
    const wet = audioCtx.createGain(); wet.gain.value = p.mix;
    const pre = audioCtx.createDelay(0.1); pre.delayTime.value = p.preDelay;
    const delays = [0.13, 0.17, 0.23, 0.29];
    const feedbacks = [0.45, 0.42, 0.38, 0.35];
    const taps = delays.map((d, i) => {
      const del = audioCtx.createDelay(1); del.delayTime.value = d * (p.decay / 1.5);
      const fbk = audioCtx.createGain(); fbk.gain.value = feedbacks[i] * Math.min(1, p.decay / 2);
      del.connect(fbk); fbk.connect(del); return { del, fb: fbk };
    });
    const damp = audioCtx.createBiquadFilter(); damp.type = 'lowpass'; damp.frequency.value = p.damping;
    input.connect(dry); dry.connect(output);
    input.connect(pre); taps.forEach(t => { pre.connect(t.del); t.del.connect(damp); });
    damp.connect(wet); wet.connect(output);
    return { input, output, dry, wet, pre, taps, damp };
  }
  function createDelayNodes(p) {
    const input = audioCtx.createGain(); input.gain.value = 1;
    const output = audioCtx.createGain(); output.gain.value = 1;
    const dry = audioCtx.createGain(); dry.gain.value = 1 - p.mix;
    const wet = audioCtx.createGain(); wet.gain.value = p.mix;
    const del = audioCtx.createDelay(2); del.delayTime.value = p.time;
    const fb = audioCtx.createGain(); fb.gain.value = p.feedback;
    const filt = audioCtx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = p.filter;
    input.connect(dry); dry.connect(output);
    input.connect(del); del.connect(filt); filt.connect(wet); filt.connect(fb); fb.connect(del);
    wet.connect(output);
    return { input, output, dry, wet, del, fb, filt };
  }
  function createChorusNodes(p) {
    const input = audioCtx.createGain(); input.gain.value = 1;
    const output = audioCtx.createGain(); output.gain.value = 1;
    const dry = audioCtx.createGain(); dry.gain.value = 1 - p.mix;
    const wet = audioCtx.createGain(); wet.gain.value = p.mix * 0.5;
    const del1 = audioCtx.createDelay(0.05); del1.delayTime.value = 0.012;
    const del2 = audioCtx.createDelay(0.05); del2.delayTime.value = 0.018;
    const lfo = audioCtx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = p.rate;
    const lg1 = audioCtx.createGain(); lg1.gain.value = p.depth;
    const lg2 = audioCtx.createGain(); lg2.gain.value = -p.depth;
    lfo.connect(lg1); lfo.connect(lg2); lg1.connect(del1.delayTime); lg2.connect(del2.delayTime); lfo.start();
    input.connect(dry); dry.connect(output);
    input.connect(del1); input.connect(del2); del1.connect(wet); del2.connect(wet); wet.connect(output);
    return { input, output, dry, wet, del1, del2, lfo, lg1, lg2 };
  }
  function createDistortionNodes(p) {
    const input = audioCtx.createGain(); input.gain.value = 1;
    const output = audioCtx.createGain(); output.gain.value = 1;
    const dry = audioCtx.createGain(); dry.gain.value = 1 - p.mix;
    const wet = audioCtx.createGain(); wet.gain.value = p.mix;
    const preGain = audioCtx.createGain(); preGain.gain.value = p.drive;
    const shaper = audioCtx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) { const x = (i / (curve.length - 1)) * 2 - 1; curve[i] = Math.tanh(x * p.drive); }
    shaper.curve = curve; shaper.oversample = '4x';
    const postGain = audioCtx.createGain(); postGain.gain.value = 1 / Math.max(1, p.drive * 0.5);
    const tone = audioCtx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = p.tone;
    input.connect(dry); dry.connect(output);
    input.connect(preGain); preGain.connect(shaper); shaper.connect(postGain); postGain.connect(tone); tone.connect(wet); wet.connect(output);
    return { input, output, dry, wet, preGain, shaper, postGain, tone };
  }
  function createEffectNodes(name, params) {
    switch (name) {
      case 'eq': return createEQNodes(params);
      case 'phaser': return createPhaserNodes(params);
      case 'reverb': return createReverbNodes(params);
      case 'delay': return createDelayNodes(params);
      case 'chorus': return createChorusNodes(params);
      case 'distortion': return createDistortionNodes(params);
      default: return null;
    }
  }
  function destroyEffectNodes(name, nodes) {
    if (!nodes) return;
    try { nodes.input.disconnect(); } catch (e) { /* ok */ }
    try { nodes.output.disconnect(); } catch (e) { /* ok */ }
    if ((name === 'phaser' || name === 'chorus') && nodes.lfo) {
      try { nodes.lfo.stop(); } catch (e) { /* ok */ }
      try { nodes.lfo.disconnect(); } catch (e) { /* ok */ }
    }
  }
  function updateEffectParams(name, nodes, p) {
    if (!nodes) return;
    switch (name) {
      case 'eq':
        nodes.low.frequency.value = p.lowFreq; nodes.low.gain.value = p.lowGain;
        nodes.mid.frequency.value = p.midFreq; nodes.mid.Q.value = p.midQ; nodes.mid.gain.value = p.midGain;
        nodes.high.frequency.value = p.highFreq; nodes.high.gain.value = p.highGain;
        break;
      case 'phaser':
        nodes.lfo.frequency.value = p.rate; nodes.lfoGain.gain.value = p.depth * 1500;
        nodes.fb.gain.value = p.feedback;
        break;
      case 'reverb':
        nodes.pre.delayTime.value = p.preDelay; nodes.damp.frequency.value = p.damping;
        nodes.dry.gain.value = 1 - p.mix; nodes.wet.gain.value = p.mix;
        break;
      case 'delay':
        nodes.del.delayTime.value = p.time; nodes.fb.gain.value = p.feedback;
        nodes.filt.frequency.value = p.filter;
        nodes.dry.gain.value = 1 - p.mix; nodes.wet.gain.value = p.mix;
        break;
      case 'chorus':
        nodes.lfo.frequency.value = p.rate; nodes.lg1.gain.value = p.depth; nodes.lg2.gain.value = -p.depth;
        nodes.dry.gain.value = 1 - p.mix; nodes.wet.gain.value = p.mix * 0.5;
        break;
      case 'distortion': {
        nodes.preGain.gain.value = p.drive;
        const c = new Float32Array(1024);
        for (let i = 0; i < c.length; i++) { const x = (i / (c.length - 1)) * 2 - 1; c[i] = Math.tanh(x * p.drive); }
        nodes.shaper.curve = c;
        nodes.postGain.gain.value = 1 / Math.max(1, p.drive * 0.5);
        nodes.tone.frequency.value = p.tone;
        nodes.dry.gain.value = 1 - p.mix; nodes.wet.gain.value = p.mix;
        break;
      }
    }
  }
  function rebuildEffectChainGeneric(fxInput, fxOutput, chain, dest) {
    // Disconnect inter-effect routing (output nodes only, preserves internal wiring)
    try { fxInput.disconnect(); } catch (e) { /* ok */ }
    try { fxOutput.disconnect(); } catch (e) { /* ok */ }
    const ORDER = ['eq', 'phaser', 'reverb', 'delay', 'chorus', 'distortion'];
    for (const nm of ORDER) {
      if (chain[nm].nodes) { try { chain[nm].nodes.output.disconnect(); } catch (e) { /* ok */ } }
    }
    const active = [];
    for (const nm of ORDER) {
      const fx = chain[nm];
      if (fx.enabled) {
        if (!fx.nodes) fx.nodes = createEffectNodes(nm, fx.params);
        updateEffectParams(nm, fx.nodes, fx.params);
        active.push(fx.nodes);
      }
    }
    if (active.length === 0) {
      fxInput.connect(fxOutput);
    } else {
      fxInput.connect(active[0].input);
      for (let i = 0; i < active.length - 1; i++) active[i].output.connect(active[i + 1].input);
      active[active.length - 1].output.connect(fxOutput);
    }
    if (dest) fxOutput.connect(dest);
  }
  function rebuildEffectChain(trackIndex, isDrum) {
    const mixNode = isDrum ? drumTrackMixerNodes.get(trackIndex | 0) : trackMixerNodes.get(trackIndex | 0);
    if (!mixNode || !mixNode.fxInput || !mixNode.fxOutput) return;
    const key = isDrum ? ('d' + trackIndex) : (trackIndex | 0);
    const chain = trackEffectChains.get(key);
    if (!chain) return;
    const dest = isDrum ? drumGain : masterGain;
    rebuildEffectChainGeneric(mixNode.fxInput, mixNode.fxOutput, chain, dest);
  }

  // === MAIN BUS EFFECT CHAIN ===
  let mainFxInput = null, mainFxOutput = null;
  let mainFxDownstream = []; // saved refs to reconnect after rebuild
  function rebuildMainEffectChain() {
    if (!mainFxInput || !mainFxOutput || !audioCtx) return;
    const chain = trackEffectChains.get('main');
    if (!chain) return;
    rebuildEffectChainGeneric(mainFxInput, mainFxOutput, chain, null);
    // Reconnect downstream: mainFxOutput → all saved destinations
    mainFxDownstream.forEach(n => { try { mainFxOutput.connect(n); } catch (e) { /* ok */ } });
  }

  function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Unified premium bus: poly gain staging -> tone EQ -> soft color -> glue comp -> limiter.
    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -21;
    compressor.knee.value = 12;
    compressor.ratio.value = 2.4;
    compressor.attack.value = 0.006;
    compressor.release.value = 0.18;

    limiter = audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -8.2;
    limiter.knee.value = 0.2;
    limiter.ratio.value = 30;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.16;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume;
    drumGain = audioCtx.createGain();
    drumGain.gain.value = masterVolume;
    drumDryBus = audioCtx.createGain();
    drumDryBus.gain.value = 0.9;
    mixAutoGain = audioCtx.createGain();
    mixAutoGain.gain.value = 1.0;

    const toneHighpass = audioCtx.createBiquadFilter();
    toneHighpass.type = 'highpass';
    toneHighpass.frequency.value = 34;
    toneHighpass.Q.value = 0.65;

    const toneLowShelf = audioCtx.createBiquadFilter();
    toneLowShelf.type = 'lowshelf';
    toneLowShelf.frequency.value = 170;
    toneLowShelf.gain.value = -1.4;

    const color = audioCtx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * 0.9) * 0.96;
    }
    color.curve = curve;
    color.oversample = '4x';
    leadDriveCurve = new Float32Array(512);
    for (let i = 0; i < leadDriveCurve.length; i++) {
      const x = (i / (leadDriveCurve.length - 1)) * 2 - 1;
      leadDriveCurve[i] = Math.tanh(x * 1.5) * 0.98;
    }

    const tonePresence = audioCtx.createBiquadFilter();
    tonePresence.type = 'peaking';
    tonePresence.frequency.value = 2350;
    tonePresence.Q.value = 1.02;
    tonePresence.gain.value = 0.9;

    const toneHarshCut = audioCtx.createBiquadFilter();
    toneHarshCut.type = 'peaking';
    toneHarshCut.frequency.value = 3350;
    toneHarshCut.Q.value = 1.35;
    toneHarshCut.gain.value = -1.45;

    const toneAir = audioCtx.createBiquadFilter();
    toneAir.type = 'highshelf';
    toneAir.frequency.value = 8600;
    toneAir.gain.value = 0.8;

    const toneSilk = audioCtx.createBiquadFilter();
    toneSilk.type = 'highshelf';
    toneSilk.frequency.value = 11500;
    toneSilk.gain.value = 0.35;

    outputBusGain = audioCtx.createGain();
    // Instrument bus +20% as requested (post-limiter synth path only).
    outputBusGain.gain.value = 0.972;

    const synthSaturator = audioCtx.createWaveShaper();
    const synthSatCurve = new Float32Array(1024);
    for (let i = 0; i < synthSatCurve.length; i++) {
      const x = (i / (synthSatCurve.length - 1)) * 2 - 1;
      synthSatCurve[i] = Math.tanh(x * 0.82) * 0.985;
    }
    synthSaturator.curve = synthSatCurve;
    synthSaturator.oversample = '4x';
    const synthTrim = audioCtx.createGain();
    synthTrim.gain.value = 0.94;

    // Drum path is fully dry/instant (no chorus/reverb/ping delay tails).
    const drumTightHP = audioCtx.createBiquadFilter();
    drumTightHP.type = 'highpass';
    drumTightHP.frequency.value = 34;
    drumTightHP.Q.value = 0.62;
    const drumTightLP = audioCtx.createBiquadFilter();
    drumTightLP.type = 'lowpass';
    drumTightLP.frequency.value = 14800;
    drumTightLP.Q.value = 0.55;
    const drumPunch = audioCtx.createDynamicsCompressor();
    drumPunch.threshold.value = -14;
    drumPunch.knee.value = 6;
    drumPunch.ratio.value = 3.4;
    drumPunch.attack.value = 0.002;
    drumPunch.release.value = 0.09;

    masterGain.connect(synthSaturator);
    synthSaturator.connect(synthTrim);
    synthTrim.connect(mixAutoGain);
    drumGain.connect(drumTightHP);
    drumTightHP.connect(drumTightLP);
    drumTightLP.connect(drumPunch);
    drumPunch.connect(drumDryBus);
    mixAutoGain.connect(toneHighpass);
    toneHighpass.connect(toneLowShelf);
    toneLowShelf.connect(color);
    color.connect(tonePresence);
    tonePresence.connect(toneHarshCut);
    toneHarshCut.connect(toneAir);
    toneAir.connect(toneSilk);
    toneSilk.connect(compressor);
    compressor.connect(limiter);
    limiter.connect(outputBusGain);

    // Stereo widener: subtle and clean.
    const merger = audioCtx.createChannelMerger(2);
    chorusDelay1 = audioCtx.createDelay(0.05);
    chorusDelay1.delayTime.value = 0.011;
    chorusDelay2 = audioCtx.createDelay(0.05);
    chorusDelay2.delayTime.value = 0.016;
    const chorusSend = audioCtx.createGain(); chorusSend.gain.value = 0.08;
    const chorusGainL = audioCtx.createGain(); chorusGainL.gain.value = 0.06;
    const chorusGainR = audioCtx.createGain(); chorusGainR.gain.value = 0.06;
    // chorusSend now fed from mainFxOutput above
    chorusSend.connect(chorusDelay1);
    chorusSend.connect(chorusDelay2);
    chorusDelay1.connect(chorusGainL);
    chorusDelay2.connect(chorusGainR);
    chorusGainL.connect(merger, 0, 0);
    chorusGainR.connect(merger, 0, 1);

    // LFO modulates chorus delay, restrained to avoid pitch wobble.
    const chorusLfo = audioCtx.createOscillator();
    chorusLfo.frequency.value = 0.62;
    const chorusLfoGain = audioCtx.createGain();
    chorusLfoGain.gain.value = 0.0012;
    chorusLfo.connect(chorusLfoGain);
    chorusLfoGain.connect(chorusDelay1.delayTime);
    chorusLfoGain.connect(chorusDelay2.delayTime);
    chorusLfo.start();

    // Reverb network: richer but still clean for dense chords.
    const rev1 = audioCtx.createDelay(1); rev1.delayTime.value = 0.16;
    const rev2 = audioCtx.createDelay(1); rev2.delayTime.value = 0.23;
    const rev3 = audioCtx.createDelay(1); rev3.delayTime.value = 0.31;
    const revFb1 = audioCtx.createGain(); revFb1.gain.value = 0.28;
    const revFb2 = audioCtx.createGain(); revFb2.gain.value = 0.25;
    const revFb3 = audioCtx.createGain(); revFb3.gain.value = 0.22;
    rev1.connect(revFb1); revFb1.connect(rev1); // feedback loops
    rev2.connect(revFb2); revFb2.connect(rev2);
    rev3.connect(revFb3); revFb3.connect(rev3);
    const revFilter = audioCtx.createBiquadFilter();
    revFilter.type = 'lowpass'; revFilter.frequency.value = 6200;
    const revGain = audioCtx.createGain(); revGain.gain.value = 0.027;
    // rev sends now fed from mainFxOutput above
    rev1.connect(revFilter); rev2.connect(revFilter); rev3.connect(revFilter);
    revFilter.connect(revGain);
    reverbNode = revGain;

    // High-end ping-pong shimmer: filtered echoes for richer sustain without muddy tails.
    const pingSend = audioCtx.createGain(); pingSend.gain.value = 0.042;
    const pingL = audioCtx.createDelay(0.8); pingL.delayTime.value = 0.19;
    const pingR = audioCtx.createDelay(0.8); pingR.delayTime.value = 0.27;
    const pingFbL = audioCtx.createGain(); pingFbL.gain.value = 0.19;
    const pingFbR = audioCtx.createGain(); pingFbR.gain.value = 0.17;
    const pingHP = audioCtx.createBiquadFilter(); pingHP.type = 'highpass'; pingHP.frequency.value = 980;
    const pingLP = audioCtx.createBiquadFilter(); pingLP.type = 'lowpass'; pingLP.frequency.value = 6400;
    const pingOut = audioCtx.createGain(); pingOut.gain.value = 0.062;
    // pingSend now fed from mainFxOutput above
    pingSend.connect(pingL);
    pingSend.connect(pingR);
    pingL.connect(pingFbL); pingFbL.connect(pingR);
    pingR.connect(pingFbR); pingFbR.connect(pingL);
    pingL.connect(pingHP);
    pingR.connect(pingHP);
    pingHP.connect(pingLP);
    pingLP.connect(pingOut);

    // === Main bus effect chain insert ===
    mainFxInput = audioCtx.createGain(); mainFxInput.gain.value = 1;
    mainFxOutput = audioCtx.createGain(); mainFxOutput.gain.value = 1;
    mainFxInput.connect(mainFxOutput); // default passthrough
    if (!trackEffectChains.has('main')) trackEffectChains.set('main', createDefaultEffectChain());

    // Final mix to destination.
    const dryGain = audioCtx.createGain(); dryGain.gain.value = 0.66;
    // Route: outputBusGain → mainFxInput → [effects] → mainFxOutput → dryGain
    outputBusGain.connect(mainFxInput);
    mainFxOutput.connect(dryGain);
    dryGain.connect(audioCtx.destination);
    drumDryBus.connect(audioCtx.destination);
    mainFxOutput.connect(chorusSend); // stereo widener fed from post-fx
    mainFxOutput.connect(rev1); mainFxOutput.connect(rev2); mainFxOutput.connect(rev3);
    mainFxOutput.connect(pingSend);
    mainFxDownstream = [dryGain, chorusSend, rev1, rev2, rev3, pingSend];
    merger.connect(audioCtx.destination);
    revGain.connect(audioCtx.destination);
    pingOut.connect(audioCtx.destination);
  }

  // --- Procedural drums ---
  // Drum bus -30% as requested.
  const DRUM_GAIN = 0.2778;
  const drumNoiseCache = new Map();
  function getDrumNoiseBuffer(durationSec, shape) {
    if (!audioCtx) return null;
    const dur = Math.max(0.01, durationSec);
    const key = `${dur.toFixed(4)}|${shape || 'lin'}`;
    if (drumNoiseCache.has(key)) return drumNoiseCache.get(key);
    const size = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
    const buf = audioCtx.createBuffer(1, size, audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      const t = i / Math.max(1, data.length - 1);
      const env = shape === 'exp' ? Math.exp(-t * 5.4) : (1 - t);
      data[i] = (Math.random() * 2 - 1) * env;
    }
    drumNoiseCache.set(key, buf);
    return buf;
  }
  function playDrum(type, opts) {
    if (!audioCtx || !drumGain) return;
    const o = opts || {};
    const variant = String(
      o.variant || (o.midiNote != null ? gmDrumVariant(o.midiNote) : '')
    ).toLowerCase();
    const hasVar = (tag) => variant.indexOf(String(tag || '').toLowerCase()) !== -1;
    const nowBase = audioCtx.currentTime;
    const reqStart = o.startTime != null ? o.startTime : nowBase + 0.0001;
    const now = Math.max(nowBase + 0.0001, reqStart);
    const vel = clamp01(o.velocity != null ? o.velocity : 0.9);
    activeDrumVoices = Math.min(48, activeDrumVoices + 1);
    const loadTrim = 1 / Math.pow(Math.max(1, activeDrumVoices), o.fromMIDI ? 0.24 : 0.2);
    const level = DRUM_GAIN * (0.58 + vel * 0.58) * loadTrim * (o.fromMIDI ? 0.9 : 1.0);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.0001, Math.max(0, now - 0.0001));
    // Route through per-track drum mixer node if trackIndex provided
    const drumTrackMix = (o.trackIndex != null) ? getDrumTrackMixerNode(o.trackIndex) : null;
    gain.connect(drumTrackMix ? drumTrackMix.gain : drumGain);
    let maxTail = 0.12;
    let cleaned = false;
    function setTail(sec) {
      maxTail = Math.max(maxTail, sec);
    }
    function cleanupAt(absTime) {
      const tailAt = Math.max(now + 0.02, absTime || (now + maxTail));
      gain.gain.cancelScheduledValues(tailAt);
      gain.gain.setTargetAtTime(0.0001, tailAt, 0.018);
      const cleanupMs = Math.max(20, (tailAt - nowBase + 0.22) * 1000);
      setTimeout(() => {
        if (cleaned) return;
        cleaned = true;
        try { gain.disconnect(); } catch (_) {}
        activeDrumVoices = Math.max(0, activeDrumVoices - 1);
      }, cleanupMs);
    }

    function noiseBurst(duration, filterFreq, filterType, shape, startOffset) {
      const off = startOffset || 0;
      const start = now + off;
      const src = audioCtx.createBufferSource();
      src.buffer = getDrumNoiseBuffer(duration, shape);
      if (!src.buffer) return;
      const filter = audioCtx.createBiquadFilter();
      filter.type = filterType || 'highpass';
      filter.frequency.setValueAtTime(filterFreq, start);
      src.connect(filter);
      filter.connect(gain);
      src.start(start);
      src.stop(start + duration);
      setTail(off + duration);
    }

    switch (type) {
      case 'kick': {
        let atk = 146;
        let mid = 54;
        let end = 33;
        let tail = 0.26;
        let transientHz = 180;
        let transientDur = 0.016;
        if (hasVar('deep') || hasVar('sub')) {
          atk = 122; mid = 46; end = 28; tail = 0.34; transientHz = 130; transientDur = 0.012;
        } else if (hasVar('tight')) {
          atk = 176; mid = 86; end = 48; tail = 0.19; transientHz = 280; transientDur = 0.01;
        } else if (hasVar('punch')) {
          atk = 160; mid = 62; end = 36; tail = 0.24; transientHz = 240; transientDur = 0.014;
        }
        gain.gain.setValueAtTime(level * 0.96, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + tail);
        noiseBurst(transientDur, transientHz, 'highpass', 'lin');
        if (hasVar('click') || hasVar('beater') || hasVar('punch')) {
          noiseBurst(0.007, 2600, 'highpass', 'lin', 0.0008);
        }
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(atk, now);
        osc.frequency.exponentialRampToValueAtTime(mid, now + 0.072);
        osc.frequency.exponentialRampToValueAtTime(end, now + Math.max(0.12, tail - 0.01));
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + tail + 0.03);
        setTail(tail + 0.03);
        break;
      }
      case 'snare': {
        let bodyStart = 196;
        let bodyEnd = 92;
        let bodyDur = 0.14;
        let noiseDur = 0.12;
        let noiseHz = 940;
        let gainTail = 0.13;
        if (hasVar('tight') || hasVar('electro')) {
          bodyStart = 224; bodyEnd = 120; bodyDur = 0.1; noiseDur = 0.09; noiseHz = 1250; gainTail = 0.1;
        } else if (hasVar('acoustic')) {
          bodyStart = 182; bodyEnd = 86; bodyDur = 0.15; noiseDur = 0.14; noiseHz = 860; gainTail = 0.15;
        }
        noiseBurst(noiseDur, noiseHz, 'highpass', 'exp');
        const body = audioCtx.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(bodyStart, now);
        body.frequency.exponentialRampToValueAtTime(bodyEnd, now + Math.max(0.05, bodyDur - 0.04));
        body.connect(gain);
        gain.gain.setValueAtTime(level * 0.7, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + gainTail);
        body.start(now);
        body.stop(now + bodyDur);
        setTail(Math.max(bodyDur, gainTail));
        break;
      }
      case '808': {
        let f0 = 70;
        let f1 = 42;
        let f2 = 30;
        let tail = 0.54;
        if (hasVar('sub')) {
          f0 = 58; f1 = 36; f2 = 24; tail = 0.72;
        } else if (hasVar('click')) {
          f0 = 84; f1 = 52; f2 = 36; tail = 0.42;
          noiseBurst(0.01, 2200, 'highpass', 'lin', 0.0);
        }
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f0, now);
        osc.frequency.exponentialRampToValueAtTime(f1, now + 0.06);
        osc.frequency.exponentialRampToValueAtTime(f2, now + Math.max(0.34, tail - 0.04));
        osc.connect(gain);
        gain.gain.setValueAtTime(level * 0.8, now);
        gain.gain.exponentialRampToValueAtTime(level * 0.32, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, now + tail);
        osc.start(now);
        osc.stop(now + tail + 0.04);
        setTail(tail + 0.04);
        break;
      }
      case 'clap': {
        const wide = hasVar('wide');
        gain.gain.setValueAtTime(level * (wide ? 0.6 : 0.56), now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + (wide ? 0.14 : 0.11));
        const layers = wide ? 5 : 4;
        for (let i = 0; i < layers; i++) {
          const t = now + i * 0.01;
          const src = audioCtx.createBufferSource();
          src.buffer = getDrumNoiseBuffer(0.055, 'exp');
          const hp = audioCtx.createBiquadFilter();
          hp.type = 'highpass';
          hp.frequency.setValueAtTime(wide ? 520 : 620, t);
          src.connect(hp);
          hp.connect(gain);
          src.start(t);
          src.stop(t + 0.055);
          setTail((i * 0.01) + 0.055);
        }
        break;
      }
      case 'hatClosed': {
        const pedal = hasVar('pedal');
        const tight = hasVar('tight');
        const dur = pedal ? 0.028 : (tight ? 0.034 : 0.046);
        const hz = pedal ? 6200 : (tight ? 8600 : 7600);
        gain.gain.setValueAtTime(level * (pedal ? 0.4 : 0.46), now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + dur);
        noiseBurst(dur + 0.008, hz, 'highpass', 'lin');
        break;
      }
      case 'hatOpen': {
        const shortOpen = hasVar('short');
        const dur = shortOpen ? 0.12 : 0.19;
        gain.gain.setValueAtTime(level * 0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + (shortOpen ? 0.12 : 0.17));
        noiseBurst(dur, shortOpen ? 9400 : 8800, 'bandpass', 'exp');
        break;
      }
      case 'rim': {
        gain.gain.setValueAtTime(level * 0.56, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.038);
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(980, now);
        osc.frequency.exponentialRampToValueAtTime(420, now + 0.028);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.038);
        noiseBurst(0.012, 2200, 'highpass', 'lin');
        break;
      }
      case 'snap': {
        gain.gain.setValueAtTime(level * 0.58, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.03);
        noiseBurst(0.036, 1400, 'highpass', 'lin');
        break;
      }
      case 'tomLow': {
        const floor = hasVar('floor');
        const startFreq = floor ? 94 : 108;
        const endFreq = floor ? 46 : 56;
        const dur = floor ? 0.24 : 0.2;
        gain.gain.setValueAtTime(level * 0.66, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + (floor ? 0.22 : 0.18));
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.14);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + dur);
        setTail(dur);
        break;
      }
      case 'tomMid': {
        const highTom = hasVar('high');
        gain.gain.setValueAtTime(level * 0.6, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + (highTom ? 0.12 : 0.14));
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(highTom ? 220 : 170, now);
        osc.frequency.exponentialRampToValueAtTime(highTom ? 118 : 94, now + 0.11);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + (highTom ? 0.13 : 0.16));
        break;
      }
      case 'ride': {
        const bell = hasVar('bell');
        const dark = hasVar('dark');
        gain.gain.setValueAtTime(level * 0.42, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
        noiseBurst(0.32, dark ? 8600 : 9900, 'bandpass', 'exp');
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(bell ? 6900 : (dark ? 4900 : 5600), now);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.22);
        setTail(0.32);
        break;
      }
      case 'crash': {
        const splash = hasVar('splash');
        const dark = hasVar('dark');
        gain.gain.setValueAtTime(level * 0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + (splash ? 0.24 : 0.42));
        noiseBurst(splash ? 0.26 : 0.45, dark ? 6200 : 7200, 'bandpass', 'exp');
        break;
      }
      default: {
        gain.gain.setValueAtTime(level * 0.54, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        noiseBurst(0.05, 1800, 'highpass', 'lin');
      }
    }
    cleanupAt(now + maxTail);
  }

  function triggerVisualsForDrum(drumIndex) {
    initGPGPU();
    const now = performance.now() * 0.001;
    const idx = Math.max(0, Math.min(11, drumIndex | 0));
    const col = idx % GRID_COLS;
    const row = 1;
    const pos = cellToPosition3D(col, row);
    attractor.x = pos.x;
    attractor.y = pos.y;
    attractor.z = pos.z;
    attractor.strength = 1.1;
    attractor.col = col;
    attractor.row = row;
    activeProfile = KEY_PROFILES[col % KEY_PROFILES.length];
    currentKeyHue = activeProfile.hue;
    targetKaleidoFolds = activeProfile.folds;
    targetKaleidoMix = 0.75;
    tgtSpiral = activeProfile.spiral;
    tgtFlow = activeProfile.flow ?? 0;
    tgtPulse = activeProfile.pulse ?? 0;
    tgtShear = activeProfile.shear ?? 0;
    tgtWave = activeProfile.wave ?? 0;
    tgtGlitch = activeProfile.glitch;
    tgtMirrorX = activeProfile.mx;
    tgtMirrorY = activeProfile.my;
    tgtWarp = activeProfile.warp;
    tgtPrism = activeProfile.prism ?? 0.62;
    tgtContrast = activeProfile.contrast;
    tgtBio = activeProfile.bio ?? 0.35;
    tgtProfileRoll = activeProfile.rot ?? 0;
    burstRingTime = now;
    if (idx === 0) lastKickImpact = now;
    else lastDrumMinorImpact = now;
    // Per-type timestamp
    const dtKey = idx === 1 ? 'snare' : idx === 3 ? 'clap' : (idx === 4 || idx === 5) ? 'hat' : (idx === 8 || idx === 9) ? 'tom' : idx === 10 ? 'ride' : idx === 11 ? 'crash' : null;
    if (dtKey) lastDrumTypeImpact[dtKey] = now;
    pushRollImpulse(36 + idx * 2, 1.0, 'D');
    pushRollDrumImpulse(idx, 1.0, 'D');
  }

  function triggerVisualsForMidiDrum(drumMidi, drumType, velocity, drumVariant) {
    initGPGPU();
    const now = performance.now() * 0.001;
    const resolvedType = drumType || gmDrumToType(drumMidi);
    const idx = drumTypeToVisualIndex(resolvedType);
    const col = idx % GRID_COLS;
    const row = 1;
    const pos = cellToPosition3D(col, row);
    attractor.x = pos.x;
    attractor.y = pos.y;
    attractor.z = pos.z;
    attractor.strength = Math.max(attractor.strength, 0.9 + clamp01(velocity || 0.9) * 0.28);
    attractor.col = col;
    attractor.row = row;
    const p = KEY_PROFILES[col % KEY_PROFILES.length];
    currentKeyHue += (p.hue - currentKeyHue) * 0.42;
    activeProfile = p;
    targetKaleidoMix = Math.max(targetKaleidoMix, 0.62);
    const vTag = String(drumVariant || '');
    const variantBoost = /bright|click|bell|splash|tight/.test(vTag) ? 0.06 : (/deep|sub|dark|floor/.test(vTag) ? 0.03 : 0.0);
    tgtGlitch = Math.max(tgtGlitch, (p.glitch || 0) * (0.88 + variantBoost));
    tgtContrast = Math.max(tgtContrast, p.contrast || 2.2);
    burstRingTime = now;
    if (idx === 0 || String(resolvedType).toLowerCase() === 'kick') lastKickImpact = now;
    else lastDrumMinorImpact = now;
    // Per-type timestamp
    const rtLow = String(resolvedType).toLowerCase();
    const dtKey2 = /snare/.test(rtLow) ? 'snare' : /clap/.test(rtLow) ? 'clap' : /hat/.test(rtLow) ? 'hat' : /tom/.test(rtLow) ? 'tom' : /ride/.test(rtLow) ? 'ride' : /crash/.test(rtLow) ? 'crash' : null;
    if (dtKey2) lastDrumTypeImpact[dtKey2] = now;
    pushRollImpulse(drumMidi != null ? drumMidi : (36 + idx), clamp01(velocity || 0.9), 'M');
    pushRollDrumImpulse(idx, clamp01(velocity || 0.9), 'M');
  }

  function createSynthVoice(midiNote, opts) {
    opts = opts || {};
    const midi = opts.snapPitch === false
      ? Math.max(0, Math.min(127, Math.round(midiNote)))
      : snapToNatural(midiNote);
    const velocity = opts.velocity != null ? opts.velocity : 0.8;
    const velNorm = clamp01(velocity);
    const fromMIDI = !!opts.fromMIDI;
    const hasScheduledDuration = opts.duration != null && opts.startTime != null;
    const sustained = !!opts.sustained;
    const shortOnly = !hasScheduledDuration && !sustained;
    const now = opts.startTime != null ? opts.startTime : audioCtx.currentTime;
    const freq = midiToFreq(midi);

    const polyHintInput = opts.polyHint != null
      ? opts.polyHint
      : (fromMIDI ? Math.max(1, displayedMidiNotes.length) : Math.max(1, keysPressed.size));
    const nActive = Math.max(1, Math.min(28, polyHintInput));
    const effectivePoly = Math.max(1, Math.max(nActive, activeLeadVoices + 1));
    const harmonyMode = getHarmonyMode();
    const harmonyPolyLimit = fromMIDI ? 5 : 7;
    // Harmony is keyboard-only; MIDI should reproduce source notes cleanly and predictably.
    const harmonyEnabled = !fromMIDI && harmonyMode !== 'off' && nActive >= 2 && nActive <= harmonyPolyLimit;
    const harmonySemitone = harmonyEnabled ? getHarmonySemitone(harmonyMode, midi) : 0;
    const harmonyRatio = harmonyEnabled ? Math.pow(2, harmonySemitone / 12) : 1.0;

    const pitchNorm = clamp01((midi - 36) / 60);
    const polyForGain = fromMIDI ? Math.max(1, Math.min(16, nActive)) : effectivePoly;
    const velStable = fromMIDI
      ? (0.7 + 0.3 * Math.pow(velNorm, 0.92))
      : (0.62 + 0.38 * Math.pow(velNorm, 0.88));
    const polyTrim = fromMIDI
      ? (1 / Math.pow(polyForGain, 0.34))
      : (1 / Math.pow(effectivePoly, 0.58));
    let peakGain = (fromMIDI ? 0.245 : 0.27) * velStable * polyTrim;
    if (harmonyEnabled) peakGain *= 0.92;
    peakGain = fromMIDI
      ? Math.max(0.03, Math.min(0.16, peakGain))
      : Math.max(0.038, Math.min(0.19, peakGain));
    const heavyMidi = fromMIDI && effectivePoly >= 10;
    const ultraMidi = fromMIDI && effectivePoly >= 14;
    const useOscB = !heavyMidi;
    const useAir = !ultraMidi;
    const useSub = midi < 74 && (!fromMIDI || effectivePoly <= 11);

    const oscA = audioCtx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = freq;
    oscA.detune.value = -2.8;
    const oscAGain = audioCtx.createGain();
    oscAGain.gain.value = 0.62;
    oscA.connect(oscAGain);

    const oscB = useOscB ? audioCtx.createOscillator() : null;
    const oscBGain = useOscB ? audioCtx.createGain() : null;
    if (oscB && oscBGain) {
      oscB.type = 'square';
      oscB.frequency.value = freq;
      oscB.detune.value = 4.5;
      oscBGain.gain.value = 0.22;
      oscB.connect(oscBGain);
    }

    const airOsc = useAir ? audioCtx.createOscillator() : null;
    const airGain = useAir ? audioCtx.createGain() : null;
    if (airOsc && airGain) {
      airOsc.type = 'sine';
      airOsc.frequency.value = freq * 2;
      airGain.gain.value = 0.045 + pitchNorm * 0.028;
      airOsc.connect(airGain);
    }

    const subOsc = useSub ? audioCtx.createOscillator() : null;
    const subGain = subOsc ? audioCtx.createGain() : null;
    if (subOsc && subGain) {
      subOsc.type = 'sine';
      subOsc.frequency.value = freq * 0.5;
      subGain.gain.value = Math.max(0.016, 0.07 - pitchNorm * 0.028);
      subOsc.connect(subGain);
    }

    const harmonyOsc = harmonyEnabled ? audioCtx.createOscillator() : null;
    const harmonyGain = harmonyEnabled ? audioCtx.createGain() : null;
    if (harmonyOsc && harmonyGain) {
      harmonyOsc.type = 'triangle';
      harmonyOsc.frequency.value = freq * harmonyRatio;
      harmonyOsc.detune.value = harmonyMode === 'ninth' ? 0.4 : 0.9;
      const harmonyBase = harmonyMode === 'ninth' ? 0.021 : 0.029;
      harmonyGain.gain.value = harmonyBase / Math.sqrt(Math.max(1, effectivePoly));
      harmonyOsc.connect(harmonyGain);
    }

    const mixBus = audioCtx.createGain();
    mixBus.gain.value = 1.0;
    oscAGain.connect(mixBus);
    if (oscBGain) oscBGain.connect(mixBus);
    if (airGain) airGain.connect(mixBus);
    if (subGain) subGain.connect(mixBus);
    if (harmonyGain) harmonyGain.connect(mixBus);

    const voiceLowpass = audioCtx.createBiquadFilter();
    voiceLowpass.type = 'lowpass';
    const brightness = clamp01(0.44 + velNorm * 0.31 + (1 - pitchNorm) * 0.16 - Math.min(0.14, (effectivePoly - 1) * 0.012));
    const lpStart = Math.min(9800, Math.max(1700, 1900 + brightness * 4600 + freq * 0.42));
    const lpSustain = Math.min(7200, Math.max(1300, 1400 + brightness * 2900 + freq * 0.2));
    voiceLowpass.frequency.setValueAtTime(lpStart, now);
    voiceLowpass.frequency.exponentialRampToValueAtTime(lpSustain, now + 0.1);
    voiceLowpass.Q.value = 0.72 + brightness * 0.18;

    const voiceHighpass = audioCtx.createBiquadFilter();
    voiceHighpass.type = 'highpass';
    voiceHighpass.frequency.value = Math.max(22, Math.min(80, 18 + freq * 0.048));
    voiceHighpass.Q.value = 0.64;

    const voicePresence = audioCtx.createBiquadFilter();
    voicePresence.type = 'peaking';
    voicePresence.frequency.value = 2100 + pitchNorm * 900;
    voicePresence.Q.value = 0.82;
    voicePresence.gain.value = 0.62 + brightness * 0.55;

    const voiceTame = audioCtx.createBiquadFilter();
    voiceTame.type = 'peaking';
    voiceTame.frequency.value = 4100;
    voiceTame.Q.value = 1.1;
    voiceTame.gain.value = -0.8;

    const voiceDrive = audioCtx.createWaveShaper();
    if (!leadDriveCurve) {
      leadDriveCurve = new Float32Array(512);
      for (let i = 0; i < leadDriveCurve.length; i++) {
        const x = (i / (leadDriveCurve.length - 1)) * 2 - 1;
        leadDriveCurve[i] = Math.tanh(x * 1.25) * 0.985;
      }
    }
    voiceDrive.curve = leadDriveCurve;
    voiceDrive.oversample = '2x';

    const envGain = audioCtx.createGain();
    envGain.gain.value = 0;

    mixBus.connect(voiceLowpass);
    voiceLowpass.connect(voiceHighpass);
    voiceHighpass.connect(voicePresence);
    voicePresence.connect(voiceTame);
    voiceTame.connect(voiceDrive);
    voiceDrive.connect(envGain);

    let voiceOut = envGain;
    if (typeof audioCtx.createStereoPanner === 'function') {
      const voicePan = audioCtx.createStereoPanner();
      voicePan.pan.value = Math.max(-0.12, Math.min(0.12, (midi - 66) / 42));
      envGain.connect(voicePan);
      voiceOut = voicePan;
    }
    // Route through per-track mixer node if trackIndex is provided (MIDI playback)
    const trackMix = (opts.trackIndex != null) ? getTrackMixerNode(opts.trackIndex) : null;
    voiceOut.connect(trackMix ? trackMix.gain : masterGain);

    const attack = shortOnly ? 0.004 : (sustained ? 0.008 : 0.0055);
    const decay = shortOnly ? 0.1 : (sustained ? 0.19 : 0.14);
    const sustainAmt = shortOnly ? 0.24 : (sustained ? 0.56 : 0.4);
    const release = shortOnly ? 0.26 : (sustained ? 0.4 : 0.32);
    const releaseEnd = now + attack + decay + release;
    envGain.gain.setValueAtTime(0, now);
    envGain.gain.linearRampToValueAtTime(peakGain, now + attack);
    envGain.gain.linearRampToValueAtTime(peakGain * sustainAmt, now + attack + decay);
    if (hasScheduledDuration) {
      const endTime = now + Math.max(0.02, opts.duration);
      envGain.gain.setValueAtTime(peakGain * sustainAmt, endTime);
      envGain.gain.linearRampToValueAtTime(0, endTime + release);
    } else if (sustained) {
      envGain.gain.setValueAtTime(peakGain * sustainAmt, now + attack + decay);
    } else {
      envGain.gain.linearRampToValueAtTime(0, releaseEnd);
    }

    activeLeadVoices += 1;
    pushRollImpulse(midi, velNorm, fromMIDI ? 'M' : (keysPressed.size > 0 ? 'K' : 'A'));
    const oscNodes = [oscA, oscB, airOsc];
    if (subOsc) oscNodes.push(subOsc);
    if (harmonyOsc) oscNodes.push(harmonyOsc);
    for (let i = 0; i < oscNodes.length; i++) {
      if (!oscNodes[i]) continue;
      oscNodes[i].start(now);
    }

    const scheduledStop = hasScheduledDuration
      ? now + Math.max(0.02, opts.duration) + release + 0.03
      : releaseEnd + 0.03;
    if (hasScheduledDuration || shortOnly) {
      for (let i = 0; i < oscNodes.length; i++) {
        if (!oscNodes[i]) continue;
        try { oscNodes[i].stop(scheduledStop); } catch (_) {}
      }
    }

    let released = false;
    function releaseCounter() {
      if (released) return;
      released = true;
      activeLeadVoices = Math.max(0, activeLeadVoices - 1);
    }
    oscA.onended = releaseCounter;

    function stop() {
      const t = audioCtx.currentTime;
      envGain.gain.cancelScheduledValues(t);
      envGain.gain.setValueAtTime(envGain.gain.value, t);
      envGain.gain.setTargetAtTime(0, t, 0.022);
      for (let i = 0; i < oscNodes.length; i++) {
        if (!oscNodes[i]) continue;
        try { oscNodes[i].stop(t + 0.11); } catch (_) {}
      }
    }
    return { stop };
  }

  function playNote(midiNote, sustained, velocity) {
    if (!audioCtx || !masterGain) return null;
    const voice = createSynthVoice(midiNote, { sustained, velocity: velocity != null ? velocity : 0.8 });
    return sustained ? voice : null;
  }

  function triggerCell(col, row) {
    initAudio();
    initGPGPU();
    const midi = cellToMidi(col, row);
    playNote(midi, false, 0.8);
    const pos = cellToPosition3D(col, row);
    attractor.x = pos.x;
    attractor.y = pos.y;
    attractor.z = pos.z;
    attractor.strength = 1.2;
    attractor.col = col;
    attractor.row = row;
    activeProfile = KEY_PROFILES[col % KEY_PROFILES.length];
    currentKeyHue = activeProfile.hue;
    targetKaleidoFolds = activeProfile.folds;
    targetKaleidoMix = 0.88;
    tgtSpiral = activeProfile.spiral;
    tgtFlow = activeProfile.flow ?? 0;
    tgtPulse = activeProfile.pulse ?? 0;
    tgtShear = activeProfile.shear ?? 0;
    tgtWave = activeProfile.wave ?? 0;
    tgtGlitch = activeProfile.glitch;
    tgtMirrorX = activeProfile.mx;
    tgtMirrorY = activeProfile.my;
    tgtWarp = activeProfile.warp;
    tgtPrism = activeProfile.prism ?? 0.62;
    tgtContrast = activeProfile.contrast;
    tgtBio = activeProfile.bio ?? 0.35;
    tgtProfileRoll = activeProfile.rot ?? 0;
    burstRingTime = performance.now() * 0.001;
  }

  function triggerVisualsForMidi(midi) {
    initGPGPU();
    const cell = midiToCell(midi);
    const pos = cellToPosition3D(cell.col, cell.row);
    attractor.x = pos.x;
    attractor.y = pos.y;
    attractor.z = pos.z;
    attractor.strength = 1.0 + (activeProfile ? activeProfile.in || 0 : 0) * 0.4;
    attractor.col = cell.col;
    attractor.row = cell.row;
    activeProfile = KEY_PROFILES[cell.col % KEY_PROFILES.length];
    currentKeyHue = activeProfile.hue;
    targetKaleidoFolds = activeProfile.folds;
    targetKaleidoMix = activeProfile.in ?? 0.88;
    tgtSpiral = activeProfile.spiral;
    tgtFlow = activeProfile.flow ?? 0;
    tgtPulse = activeProfile.pulse ?? 0;
    tgtShear = activeProfile.shear ?? 0;
    tgtWave = activeProfile.wave ?? 0;
    tgtGlitch = activeProfile.glitch;
    tgtMirrorX = activeProfile.mx;
    tgtMirrorY = activeProfile.my;
    tgtWarp = activeProfile.warp;
    tgtPrism = activeProfile.prism ?? 0.62;
    tgtContrast = activeProfile.contrast;
    tgtBio = activeProfile.bio ?? 0.35;
    tgtProfileRoll = activeProfile.rot ?? 0;
    burstRingTime = performance.now() * 0.001;
  }

  function getAudioContext() {
    initAudio();
    return audioCtx;
  }
  initMidiPlayer({
    createSynthVoice,
    triggerVisualsForMidi,
    triggerVisualsForMidiDrum: (drumMidi, drumType, velocity, drumVariant) => {
      triggerVisualsForMidiDrum(drumMidi, drumType, velocity, drumVariant);
    },
    playDrumFromMidi: (drumType, meta) => {
      initAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      const m = meta || {};
      const drumMidi = m.midiNote != null ? m.midiNote : 36;
      const velocity = clamp01(m.velocity != null ? m.velocity : 0.88);
      const mapped = drumType || gmDrumToType(drumMidi);
      const drumVariant = m.drumVariant || gmDrumVariant(drumMidi);
      playDrum(mapped, {
        startTime: m.startTime != null ? m.startTime : (audioCtx ? audioCtx.currentTime + 0.0001 : undefined),
        velocity,
        fromMIDI: true,
        midiNote: drumMidi,
        variant: drumVariant,
        trackIndex: m.trackIndex
      });
    },
    initAudio,
    getAudioContext,
    setTrackVolume: (trackIndex, vol) => { initAudio(); setTrackVolume(trackIndex, vol); },
    setTrackPan: (trackIndex, pan) => { initAudio(); setTrackPan(trackIndex, pan); },
    setDrumTrackVolume: (trackIndex, vol) => {
      initAudio();
      const n = getDrumTrackMixerNode(trackIndex);
      if (n) {
        n.volume = clamp01(vol);
        const t = audioCtx.currentTime;
        n.gain.gain.cancelScheduledValues(t);
        n.gain.gain.setValueAtTime(n.gain.gain.value, t);
        n.gain.gain.linearRampToValueAtTime(n.volume, t + 0.035);
      }
    },
    setDrumTrackPan: (trackIndex, pan) => {
      initAudio();
      const n = getDrumTrackMixerNode(trackIndex);
      if (n && n.pan) {
        n.panValue = Math.max(-1, Math.min(1, pan));
        const t = audioCtx.currentTime;
        n.pan.pan.cancelScheduledValues(t);
        n.pan.pan.setValueAtTime(n.pan.pan.value, t);
        n.pan.pan.linearRampToValueAtTime(n.panValue, t + 0.035);
      }
    },
    getTrackEffects: (trackIndex, isDrum) => {
      const key = isDrum ? ('d' + trackIndex) : (trackIndex | 0);
      if (!trackEffectChains.has(key)) trackEffectChains.set(key, createDefaultEffectChain());
      return trackEffectChains.get(key);
    },
    setTrackEffectEnabled: (trackIndex, isDrum, effectName, enabled) => {
      initAudio();
      const key = isDrum ? ('d' + trackIndex) : (trackIndex | 0);
      if (!trackEffectChains.has(key)) trackEffectChains.set(key, createDefaultEffectChain());
      const chain = trackEffectChains.get(key);
      if (!chain[effectName]) return;
      // Destroy old nodes if disabling
      if (!enabled && chain[effectName].nodes) {
        destroyEffectNodes(effectName, chain[effectName].nodes);
        chain[effectName].nodes = null;
      }
      chain[effectName].enabled = !!enabled;
      // Ensure mixer node exists
      if (isDrum) getDrumTrackMixerNode(trackIndex);
      else getTrackMixerNode(trackIndex);
      rebuildEffectChain(trackIndex, isDrum);
    },
    setTrackEffectParam: (trackIndex, isDrum, effectName, paramName, value) => {
      initAudio();
      const key = isDrum ? ('d' + trackIndex) : (trackIndex | 0);
      if (!trackEffectChains.has(key)) return;
      const chain = trackEffectChains.get(key);
      if (!chain[effectName]) return;
      chain[effectName].params[paramName] = value;
      if (chain[effectName].enabled && chain[effectName].nodes) {
        updateEffectParams(effectName, chain[effectName].nodes, chain[effectName].params);
      }
    },
    // === Main bus effect API ===
    getMainEffects: () => {
      if (!trackEffectChains.has('main')) trackEffectChains.set('main', createDefaultEffectChain());
      return trackEffectChains.get('main');
    },
    setMainEffectEnabled: (effectName, enabled) => {
      initAudio();
      if (!trackEffectChains.has('main')) trackEffectChains.set('main', createDefaultEffectChain());
      const chain = trackEffectChains.get('main');
      if (!chain[effectName]) return;
      if (!enabled && chain[effectName].nodes) {
        destroyEffectNodes(effectName, chain[effectName].nodes);
        chain[effectName].nodes = null;
      }
      chain[effectName].enabled = !!enabled;
      rebuildMainEffectChain();
    },
    setMainEffectParam: (effectName, paramName, value) => {
      initAudio();
      if (!trackEffectChains.has('main')) return;
      const chain = trackEffectChains.get('main');
      if (!chain[effectName]) return;
      chain[effectName].params[paramName] = value;
      if (chain[effectName].enabled && chain[effectName].nodes) {
        updateEffectParams(effectName, chain[effectName].nodes, chain[effectName].params);
      }
    },
    updateKeyDisplayFromMidi: (notes) => { displayedMidiNotes = notes && notes.length ? notes.slice() : []; },
    setMidiPlaybackState: (active) => {
      midiPlaybackActive = !!active;
      if (!midiPlaybackActive) midiPlaybackPolyphony = 0;
    },
    setMidiTransportInfo: (state) => {
      if (!state) return;
      if (typeof state.speed === 'number') midiPlaybackSpeed = Math.max(0.5, Math.min(2.0, state.speed));
      if (typeof state.position === 'number') midiPlaybackPosition = Math.max(0, state.position);
      if (typeof state.duration === 'number') midiPlaybackDuration = Math.max(0, state.duration);
      if (typeof state.polyphony === 'number') midiPlaybackPolyphony = Math.max(0, state.polyphony);
      if (typeof state.bpm === 'number') midiSourceBpm = Math.max(30, Math.min(260, state.bpm));
      if (Array.isArray(state.preview)) {
        midiRollPreview = state.preview.slice(0, ROLL3D_PREVIEW_CAP).map((n) => ({
          midi: Math.max(0, Math.min(127, Math.round(n.midi || 0))),
          velocity: clamp01(typeof n.velocity === 'number' ? n.velocity : 0.8),
          trackIndex: n.trackIndex | 0,
          ahead: typeof n.ahead === 'number' ? n.ahead : 0,
          duration: typeof n.duration === 'number' ? n.duration : 0.12,
          time: typeof n.time === 'number' ? n.time : 0,
          isDrum: !!n.isDrum,
          drumType: n.drumType || '',
          drumClass: n.drumClass != null ? Math.max(0, Math.min(11, n.drumClass | 0)) : null,
          drumVariant: n.drumVariant || ''
        }));
      }
    }
  });

  // Mode HUD: intentional, legible, minimal
  let hudEl = null;
  function createHud() {
    hudEl = document.createElement('div');
    hudEl.setAttribute('aria-live', 'polite');
    hudEl.className = 'hud-top-menu';
    document.body.appendChild(hudEl);
  }
  function updateHud() {
    if (!hudEl) createHud();
    const modes = [];
    const hueDeg = (Math.round((currentKeyHue % 1) * 360) + 360) % 360;
    modes.push('[1] mic ' + (micEnabled ? 'ON' : 'off'));
    modes.push('[2] arp ' + (arpEnabled ? 'ON' : 'off'));
    modes.push('[3] cam ' + (gyroEnabled ? 'ON' : 'off'));
    modes.push('[4] ambient ' + (ambientMode ? 'ON' : 'off'));
    modes.push('[6] harm ' + HARMONY_MODE_LABEL[getHarmonyMode()].toLowerCase());
    modes.push('[7] px ' + PIXEL_MODE_LABELS[pixelModeIdx]);
    modes.push('[8] analog ' + ANALOG_MODE_LABELS[analogModeIdx]);
    modes.push('[9] text ' + TEXT_MODE_LABELS[textModeIdx]);
    if (sustainPedalHeld) modes.push('sustain');
    if (performance.now() * 0.001 < visualFreezeUntil) modes.push('freeze');
    modes.push('vol ' + (masterVolume * 100 | 0) + '%');
    if (audioEnergy > 0.01) modes.push('audio ' + (audioEnergy * 100 | 0) + '%');
    if (micLevel > 0.01) modes.push('mic ' + (micLevel * 100 | 0) + '%');
    modes.push(`eq ${bassLevel * 100 | 0}/${midLevel * 100 | 0}/${trebleLevel * 100 | 0}`);
    modes.push(`fx w${curWarp * 100 | 0} g${curGlitch * 100 | 0} p${curPrism * 100 | 0}`);
    modes.push(`style m${styleMuseum * 100 | 0} l${styleLsd * 100 | 0}`);
    modes.push(`hue ${hueDeg}°`);
    modes.push(`zoom ${zoomLevel.toFixed(2)}x`);
    if (mixAutoGain) modes.push(`mix ${(mixAutoGain.gain.value * 100 | 0)}%`);
    if (headTrackingActive) modes.push(`head ${headZone.toLowerCase()}`);
    if (chordCount > 1) modes.push('chord ×' + chordCount);
    if (activeLeadVoices > 0) modes.push('voices ' + activeLeadVoices);
    if (midiPlaybackActive || midiPlaybackDuration > 0.01) {
      modes.push(`midi ${midiPlaybackSpeed.toFixed(2)}x ${midiPlaybackPosition.toFixed(1)}/${midiPlaybackDuration.toFixed(1)}s`);
      if (midiPlaybackPolyphony > 0) modes.push('m-poly ' + midiPlaybackPolyphony);
    }
    const menuItems = ['<span class="hud-accel">F</span>ile','<span class="hud-accel">E</span>dit','<span class="hud-accel">V</span>iew','<span class="hud-accel">S</span>ynth','F<span class="hud-accel">X</span>','<span class="hud-accel">M</span>IDI','<span class="hud-accel">T</span>ools'];
    const menuLead = '<span class="hud-menu-items">' + menuItems.map(m => `<span class="hud-menu-item">${m}</span>`).join('') + '</span>';
    const statusStr = '<span class="hud-status-bar">' + modes.join(' \u00B7 ') + '</span>';
    hudEl.innerHTML = menuLead + statusStr;
  }

  function createHelpOverlay() {
    if (helpOverlayEl) return;
    helpOverlayEl = document.createElement('div');
    helpOverlayEl.setAttribute('role', 'dialog');
    helpOverlayEl.setAttribute('aria-label', 'Shortcuts');
    helpOverlayEl.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,0.82);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:24px;opacity:0;visibility:hidden;transition:opacity 0.25s,visibility 0.25s;pointer-events:none';
    helpOverlayEl.innerHTML = `
      <div style="max-width:360px;font:11px/1.6 'SF Pro Text',system-ui,sans-serif;color:rgba(255,255,255,0.9);letter-spacing:0.03em;">
        <div style="font-weight:600;margin-bottom:12px;font-size:13px;">Sound Matrix · 快捷键</div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 20px;">
          <span style="color:rgba(255,255,255,0.5)">A–L ; ' \\</span><span>鼓组</span>
          <span style="color:rgba(255,255,255,0.5)">Z–M</span><span>低八度合成器</span>
          <span style="color:rgba(255,255,255,0.5)">Q–P [ ]</span><span>中/高八度</span>
          <span style="color:rgba(255,255,255,0.5)">Shift + 键</span><span>高八度</span>
          <span style="color:rgba(255,255,255,0.5)">Space</span><span>延音踏板（按住）</span>
	          <span style="color:rgba(255,255,255,0.5)">1–4</span><span>麦克风 / 琶音 / 摄像头 / 环境</span>
	          <span style="color:rgba(255,255,255,0.5)">5</span><span>视觉冻结 2 秒</span>
	          <span style="color:rgba(255,255,255,0.5)">6</span><span>智能和声（OFF / AUTO3 / MAJ3 / MIN3 / 5TH / 9TH）</span>
	          <span style="color:rgba(255,255,255,0.5)">7</span><span>像素层级（soft / dense / hard）</span>
	          <span style="color:rgba(255,255,255,0.5)">8</span><span>模拟屏（clean / crt / vhs）</span>
	          <span style="color:rgba(255,255,255,0.5)">9</span><span>文字引擎（clean / glitch / overclock）</span>
	          <span style="color:rgba(255,255,255,0.5)">− =</span><span>主音量减 / 加</span>
          <span style="color:rgba(255,255,255,0.5)">Alt + ↑/↓/0</span><span>MIDI 速度 + / - / 重置</span>
          <span style="color:rgba(255,255,255,0.5)">Alt + T</span><span>Tap Tempo</span>
          <span style="color:rgba(255,255,255,0.5)">Esc</span><span>停止延音 + 重置缩放</span>
          <span style="color:rgba(255,255,255,0.5)">?</span><span>本帮助</span>
          <span style="color:rgba(255,255,255,0.5)">滚轮</span><span>缩放</span>
          <span style="color:rgba(255,255,255,0.5)">双击</span><span>爆炸效果</span>
        </div>
        <div style="margin-top:14px;font-size:10px;color:rgba(255,255,255,0.4)">? 或 Esc 关闭</div>
      </div>`;
    document.body.appendChild(helpOverlayEl);
  }

  function toggleHelp() {
    createHelpOverlay();
    helpOverlayVisible = !helpOverlayVisible;
    helpOverlayEl.style.opacity = helpOverlayVisible ? '1' : '0';
    helpOverlayEl.style.visibility = helpOverlayVisible ? 'visible' : 'hidden';
    helpOverlayEl.style.pointerEvents = helpOverlayVisible ? 'auto' : 'none';
  }

  function stopAllSustained() {
    sustainedVoices.forEach(stop => { try { stop(); } catch (_) {} });
    sustainedVoices.clear();
  }

  let introHintHidden = false;
  let toastHideTimer = null;

  function hideIntroHint() {
    if (introHintHidden) return;
    introHintHidden = true;
    const el = document.getElementById('intro-hint');
    if (el) el.classList.add('ui-hidden');
  }

  function showModeToast(message) {
    const el = document.getElementById('mode-toast');
    if (!el) return;
    if (toastHideTimer) clearTimeout(toastHideTimer);
    el.textContent = message;
    el.classList.add('ui-visible');
    toastHideTimer = setTimeout(() => {
      el.classList.remove('ui-visible');
      toastHideTimer = null;
    }, 1600);
  }

  function onFirstInteraction() {
    initAudio();
    initGPGPU();
    initHeadTracking();
    initGyro();
    lastUserAction = performance.now();
    hideIntroHint();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    document.body.removeEventListener('click', onFirstInteraction);
    document.body.removeEventListener('keydown', onFirstInteraction);
  }

  function onGridMouseDown(e) {
    onFirstInteraction();
    markUserAction();
    gridMouseDown = true;
    const cell = getCellFromMouse(e.clientX, e.clientY);
    if (cell) {
      triggerCell(cell.col, cell.row);
      lastTriggeredCell = cell;
    }
  }

  function onGridMouseMove(e) {
    const cell = getCellFromMouse(e.clientX, e.clientY);
    if (!gridMouseDown) return;
    if (!cell) return;
    if (!lastTriggeredCell || cell.col !== lastTriggeredCell.col || cell.row !== lastTriggeredCell.row) {
      triggerCell(cell.col, cell.row);
      lastTriggeredCell = cell;
    }
  }

  function onGridMouseUp() {
    gridMouseDown = false;
    lastTriggeredCell = null;
  }

  function onKeyDown(e) {
    if (e.repeat) return;
    const key = e.code;

    // Help overlay: ? or Shift+/
    if (e.key === '?' || (key === 'Slash' && e.shiftKey)) {
      e.preventDefault();
      toggleHelp();
      return;
    }
    if (key === 'Escape') {
      e.preventDefault();
      if (helpOverlayVisible) { toggleHelp(); return; }
      stopAllSustained();
      zoomLevel = 1.0;
      showModeToast('Sustain off · zoom reset');
      return;
    }

    // Sustain pedal (Space)
    if (key === 'Space') {
      e.preventDefault();
      sustainPedalHeld = true;
      return;
    }

    // Visual freeze (5)
    if (key === 'Digit5') {
      e.preventDefault();
      visualFreezeUntil = performance.now() * 0.001 + 2;
      showModeToast('Freeze 2s');
      return;
    }
    if (key === 'Digit6') {
      e.preventDefault();
      const hm = cycleHarmonyMode();
      showModeToast('Harmony ' + HARMONY_MODE_LABEL[hm]);
      return;
    }
    if (key === 'Digit7') {
      e.preventDefault();
      showModeToast('Pixel ' + cyclePixelMode().toUpperCase());
      return;
    }
    if (key === 'Digit8') {
      e.preventDefault();
      showModeToast('Analog ' + cycleAnalogMode().toUpperCase());
      return;
    }
    if (key === 'Digit9') {
      e.preventDefault();
      showModeToast('Text ' + cycleTextMode().toUpperCase());
      return;
    }

    // Master volume − =
    if (key === 'Minus') {
      e.preventDefault();
      masterVolume = Math.max(0.05, masterVolume - 0.08);
      if (masterGain) masterGain.gain.value = masterVolume;
      if (drumGain) drumGain.gain.value = masterVolume;
      showModeToast('Vol ' + (masterVolume * 100 | 0) + '%');
      return;
    }
    if (key === 'Equal' || key === 'NumpadAdd') {
      e.preventDefault();
      masterVolume = Math.min(1, masterVolume + 0.08);
      if (masterGain) masterGain.gain.value = masterVolume;
      if (drumGain) drumGain.gain.value = masterVolume;
      showModeToast('Vol ' + (masterVolume * 100 | 0) + '%');
      return;
    }

    // Mode keys: 1=mic, 2=arp, 3=camera, 4=ambient
    if (key === 'Digit1') { toggleMic(); return; }
    if (key === 'Digit2') { toggleArp(); return; }
    if (key === 'Digit3') { initGyro(); return; }
    if (key === 'Digit4') { ambientMode ? stopAmbient() : startAmbient(); return; }

    // Drum row: A–L, ;, ', \
    const drumType = DRUM_KEYS[key];
    if (drumType != null) {
      e.preventDefault();
      markUserAction();
      initAudio();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      const drumIndex = DRUM_KEY_ORDER.indexOf(key);
      playDrum(drumType, { velocity: 1.0, startTime: audioCtx ? audioCtx.currentTime + 0.0001 : undefined, fromMIDI: false });
      triggerVisualsForDrum(drumIndex >= 0 ? drumIndex : 0);
      return;
    }

    const midi = KEY_TO_NOTE[key];
    if (midi == null) return;
    e.preventDefault();
    markUserAction();
    if (keysPressed.has(key)) return;
    keysPressed.add(key);
    const octaveUp = e.shiftKey ? 12 : 0;
    const midiPlay = Math.min(127, midi + octaveUp);
    const asSustained = sustainPedalHeld || isSustainNote(midi);
    if (asSustained) {
      const voice = playNote(midiPlay, true);
      if (voice) sustainedVoices.set(key, voice.stop);
    } else playNote(midiPlay, false);
    triggerVisualsForMidi(midiPlay);
    const n = keysPressed.size;
    chordCount = n;

    // Chord visual stacking: blend all active key profiles harmoniously
    if (n >= 2) {
      const activeProfiles = [];
      keysPressed.forEach(k => {
        const m = KEY_TO_NOTE[k];
        if (m != null) {
          const cell = midiToCell(m);
          activeProfiles.push(KEY_PROFILES[cell.col % KEY_PROFILES.length]);
        }
      });
      if (activeProfiles.length >= 2) {
        const blend = blendProfiles(activeProfiles, n, 0.15);
        if (blend) {
          targetKaleidoFolds = blend.folds;
          targetKaleidoMix = Math.min(0.94, 0.82 + (n - 1) * 0.03);
          tgtSpiral = blend.spiral;
          tgtFlow = blend.flow;
          tgtPulse = blend.pulse;
          tgtShear = blend.shear;
          tgtWave = blend.wave;
          tgtGlitch = blend.glitch;
          tgtMirrorX = blend.mx;
          tgtMirrorY = blend.my;
          tgtWarp = blend.warp;
          tgtPrism = blend.prism;
          tgtContrast = blend.contrast;
          tgtBio = blend.bio;
          tgtProfileRoll = blend.rot;
          currentKeyHue = blend.hue;
          activeProfile = { ...activeProfile, bloom: blend.bloom, ca: blend.ca, prism: blend.prism, bio: blend.bio, rot: blend.rot, in: blend.in, out: blend.out };
        }
      }
    }

    // Sparkle layer for 3+ keys
    if (n >= 3) {
      sparkleTime = performance.now() * 0.001;
    }
    // Pad swell for 5+ keys
    if (n >= 5) {
      padLevel = 1;
    }
  }

  function onKeyUp(e) {
    const key = e.code;
    if (key === 'Space') {
      e.preventDefault();
      sustainPedalHeld = false;
      return;
    }
    if (KEY_TO_NOTE[key] == null) return;
    e.preventDefault();
    keysPressed.delete(key);
    chordCount = keysPressed.size;
    if (isSustainNote(KEY_TO_NOTE[key])) {
      const stop = sustainedVoices.get(key);
      if (stop) { stop(); sustainedVoices.delete(key); }
    }
  }

  function updateKeyDisplay() {
    if (!keyDisplayMesh) return;
    keyDisplayReveal += (0 - keyDisplayReveal) * 0.24;
    keyDisplayMesh.visible = false;
  }

  function ensureNoteRepeatOverlay() {
    if (noteRepeatOverlayEl) return;
    if (!noteRepeatStyleEl) {
      noteRepeatStyleEl = document.createElement('style');
      noteRepeatStyleEl.textContent = `
        .note-row-edge {
          position: absolute;
          display: flex;
          flex-wrap: wrap;
          gap: 4px 2px;
          pointer-events: none;
        }
        .note-row-terminal {
          position: absolute;
          overflow: hidden;
          padding-top: 11px;
        }
        .note-row-terminal::before {
          content: attr(data-stream);
          position: absolute;
          left: 0;
          right: 0;
          top: -2px;
          white-space: nowrap;
          overflow: hidden;
          font: 760 12px/1 "Lucida Console","Courier New","Tahoma","MS Sans Serif",monospace;
          letter-spacing: 0.12em;
          color: rgba(188, 234, 255, 0.54);
          text-shadow: 0 0 10px rgba(98, 180, 255, 0.24);
          animation: terminalFlow var(--terminal-speed, 5.8s) linear infinite;
          pointer-events: none;
        }
        .note-head-code {
          display: inline-flex;
          align-items: center;
          gap: 7px;
          padding: 0;
          border-radius: 0;
          font: 860 140px/1.0 "Lucida Console","Courier New","Tahoma","MS Sans Serif",monospace;
          letter-spacing: -0.06em;
          flex: 0 0 18%;
          justify-content: center;
          background: transparent;
          position: relative;
          overflow: visible;
          animation: noteCodeJitter 0.9s steps(2,end) infinite;
          animation-delay: var(--gd, 0s);
        }
        .note-head-code .glyph-src {
          color: rgba(146, 215, 255, 0.66);
          font: 760 13px/1 "Lucida Console","Courier New","Tahoma","MS Sans Serif",monospace;
          letter-spacing: 0.06em;
        }
        .note-head-code .glyph-code {
          color: rgba(178,218,255,0.6);
          font: 680 12px/1 "Lucida Console","Courier New","Tahoma","MS Sans Serif",monospace;
          letter-spacing: 0.07em;
          text-transform: uppercase;
        }
        .note-head-code .glyph-code-r {
          color: rgba(178, 218, 255, 0.44);
          letter-spacing: 0.09em;
        }
        .note-head-code .note-glyph-stack {
          position: relative;
          display: inline-grid;
          place-items: center;
          min-width: 2.2em;
          line-height: 1;
        }
        .note-head-code .glyph-main {
          grid-area: 1 / 1;
          position: relative;
          color: rgba(236,244,255,0.95);
          text-shadow: 0 0 15px rgba(128,190,255,0.42);
        }
        .note-head-code .glyph-ca-r {
          position: absolute;
          inset: 0 0 0 0;
          color: rgba(255,76,122,0.34);
          transform: translate(2.8px, -0.5px);
          pointer-events: none;
          mix-blend-mode: screen;
        }
        .note-head-code .glyph-ca-c {
          position: absolute;
          inset: 0 0 0 0;
          color: rgba(74,235,255,0.32);
          transform: translate(-2.8px, 0.5px);
          pointer-events: none;
          mix-blend-mode: screen;
        }
        .note-head-code .glyph-caret {
          color: rgba(220, 245, 255, 0.9);
          font: 700 13px/1 "Lucida Console","Courier New","Tahoma","MS Sans Serif",monospace;
          letter-spacing: 0;
          animation: caretBlink 1s steps(2,end) infinite;
          text-shadow: 0 0 8px rgba(160, 225, 255, 0.45);
        }
        .note-row-side {
          align-items: flex-start;
          justify-content: flex-start;
          gap: 6px 10px;
        }
        .note-row-side.right {
          justify-content: flex-end;
          text-align: right;
        }
        /* Hide auxiliary glyphs in the big note row — only show the note letter */
        [data-kind="top"] .note-head-code .glyph-src,
        [data-kind="top"] .note-head-code .glyph-code,
        [data-kind="top"] .note-head-code .glyph-code-r,
        [data-kind="top"] .note-head-code .glyph-caret {
          display: none;
        }
        @keyframes noteCodeJitter {
          0% { transform: translate(0px, 0px); }
          16% { transform: translate(0.42px, -0.16px); }
          17% { transform: translate(-0.42px, 0.16px); }
          18% { transform: translate(0px, 0px); }
          52% { transform: translate(0px, 0px); }
          53% { transform: translate(0.46px, 0px); }
          55% { transform: translate(0px, 0px); }
          100% { transform: translate(0px, 0px); }
        }
        @keyframes noteScan {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(120%); }
        }
        @keyframes terminalFlow {
          0% { transform: translateX(0%); }
          100% { transform: translateX(-38%); }
        }
        @keyframes caretBlink {
          0%, 49% { opacity: 1; }
          50%, 100% { opacity: 0.15; }
        }
      `;
      document.head.appendChild(noteRepeatStyleEl);
    }
    noteRepeatOverlayEl = document.createElement('div');
    noteRepeatOverlayEl.style.cssText = [
      'position:fixed',
      'inset:0',
      'pointer-events:none',
      'z-index:1400',
      'opacity:0',
      'transition:opacity 120ms ease-out'
    ].join(';');
    const rows = [
      { top: '72%', left: '3%', right: '30%', alpha: 0.98, blur: 0, kind: 'top' },
      { top: '30%', left: '70%', right: '2.5%', alpha: 0.72, blur: 0.22, kind: 'right' },
      { top: '67%', left: '2.5%', right: '70%', alpha: 0.68, blur: 0.18, kind: 'left' },
      { top: '88%', left: '4%', right: '4%', alpha: 0.56, blur: 0.32, kind: 'bottom' }
    ];
    rows.forEach((cfg, idx) => {
      const row = document.createElement('div');
      row.classList.add('note-row-edge');
      row.dataset.kind = cfg.kind;
      if (idx === 0) row.classList.add('note-row-terminal');
      if (cfg.kind === 'left' || cfg.kind === 'right') row.classList.add('note-row-side');
      if (cfg.kind === 'right') row.classList.add('right');
      row.style.cssText = [
        'position:absolute',
        `top:${cfg.top}`,
        `left:${cfg.left}`,
        `right:${cfg.right}`,
        'display:flex',
        'flex-wrap:wrap',
        'gap:2px 0px',
        `justify-content:${cfg.kind === 'right' ? 'flex-end' : 'flex-start'}`,
        `opacity:${cfg.alpha}`,
        `filter:blur(${cfg.blur}px)`
      ].join(';');
      noteRepeatOverlayEl.appendChild(row);
      noteRepeatRowEls.push(row);
    });
    document.body.appendChild(noteRepeatOverlayEl);
  }

  function collectOrderedActiveNotes() {
    const keyNotes = [];
    keysPressed.forEach(k => {
      const midi = KEY_TO_NOTE[k];
      if (midi != null) keyNotes.push(Math.max(0, Math.min(127, midi)));
    });
    keyNotes.sort((a, b) => a - b);
    const midiNotes = displayedMidiNotes && displayedMidiNotes.length
      ? displayedMidiNotes.slice().sort((a, b) => a - b)
      : [];
    const merged = [];
    keyNotes.forEach(m => merged.push({ midi: m, src: 'K' }));
    midiNotes.forEach(m => merged.push({ midi: m, src: 'M' }));
    merged.sort((a, b) => a.midi - b.midi || (a.src === 'K' ? -1 : 1));
    return merged;
  }

  function updateNoteRepeatOverlay() {
    ensureNoteRepeatOverlay();
    const notes = collectOrderedActiveNotes();
    if (!notes.length) {
      noteRepeatOverlayEl.style.opacity = '0';
      noteRepeatSignature = '';
      return;
    }
    noteRepeatOverlayEl.style.opacity = '1';
    const hueDeg = Math.round(currentKeyHue * 360) % 360;
    const sig = `${hueDeg}|${notes.map(n => `${n.src}${midiToNoteName(n.midi)}`).join(',')}`;
    if (sig === noteRepeatSignature) return;
    noteRepeatSignature = sig;
    const baseStream = notes.map((n, i) => {
      const txt = midiToNoteName(n.midi);
      const codeA = ((txt.charCodeAt(0) + i * 17 + hueDeg) % 16).toString(16).toUpperCase();
      const codeB = ((txt.charCodeAt(txt.length - 1) + i * 9 + 7) % 16).toString(16).toUpperCase();
      return `${n.src === 'M' ? 'MIDI' : 'KEY'} ${txt} 0x${codeA}${codeB}`;
    }).join('   |   ');
    const terminalStream = Array(2 + textModeIdx * 2).fill(baseStream).join('   //   ');
    const htmlHead = notes.map((n, i) => {
      const txt = midiToNoteName(n.midi);
      const srcTag = n.src === 'M' ? 'M' : 'K';
      const seedA = ((i * 17 + txt.charCodeAt(0) * 7) % 16).toString(16).toUpperCase();
      const seedB = ((i * 11 + txt.charCodeAt(txt.length - 1) * 5) % 16).toString(16).toUpperCase();
      const seedC = ((i * 13 + txt.length * 9 + hueDeg) % 16).toString(16).toUpperCase();
      const seedD = ((i * 19 + txt.charCodeAt(0) + 3) % 16).toString(16).toUpperCase();
      return `<span class="note-head-code" style="
        --gd:${(i % 7) * 0.08}s;
        color:hsla(${hueDeg},42%,94%,0.96);
        text-shadow:0 0 60px hsla(${hueDeg},52%,70%,0.36),0 0 120px hsla(${hueDeg},52%,70%,0.18);
      ">
        <span class="glyph-src">${srcTag}</span>
        <span class="glyph-code">0x${seedA}${seedB}</span>
        <span class="note-glyph-stack">
          <span class="glyph-main">${txt}</span>
          <span class="glyph-ca-r">${txt}</span>
          <span class="glyph-ca-c">${txt}</span>
        </span>
        <span class="glyph-code glyph-code-r">${seedC}${seedD}</span>
        <span class="glyph-caret">_</span>
      </span>`;
    }).join('');
    const html = notes.map((n, i) => {
      const txt = midiToNoteName(n.midi);
      const srcTag = n.src === 'M' ? 'M:' : 'K:';
      const a = i % 2 === 0 ? 0.9 : 0.76;
      return `<span style="
        display:inline-block;
        padding:0;
        border-radius:0;
        font:780 24px/1.04 'Lucida Console','Courier New','Tahoma','MS Sans Serif','Consolas',monospace;
        letter-spacing:0.05em;
        color:hsla(${hueDeg},36%,96%,${a});
        background:transparent;
        text-shadow:0 0 8px hsla(${hueDeg},52%,70%,0.28);
      ">${srcTag}${txt}</span>`;
    }).join('');
    const htmlCompact = notes.map((n, i) => {
      const txt = midiToNoteName(n.midi);
      const srcTag = n.src === 'M' ? 'M' : 'K';
      const a = i % 2 === 0 ? 0.86 : 0.72;
      return `<span style="
        display:inline-block;
        padding:0;
        font:760 20px/1.02 'Lucida Console','Courier New','Tahoma','MS Sans Serif','Consolas',monospace;
        letter-spacing:0.06em;
        color:hsla(${hueDeg},36%,95%,${a});
        text-shadow:0 0 7px hsla(${hueDeg},52%,68%,0.22);
      ">${srcTag}.${txt}</span>`;
    }).join('');
    noteRepeatRowEls.forEach((row, idx) => {
      const kind = row.dataset.kind || '';
      row.innerHTML = kind === 'top'
        ? htmlHead
        : (kind === 'right' ? htmlCompact : html);
      if (kind === 'top') {
        row.setAttribute('data-stream', terminalStream);
        row.style.setProperty('--terminal-speed', `${Math.max(2.6, 5.8 - textModeIdx * 1.1)}s`);
      }
      if (kind === 'right') row.style.transform = 'translateX(3%)';
      else if (kind === 'left') row.style.transform = 'translateX(-2%)';
      else row.style.transform = 'translateX(0%)';
    });
    updateDatastreamContent();
  }

  // --- Additional interaction state ---
  let zoomLevel = 1.0;
  let mouseVelocity = 0;
  let lastMouseX = 0, lastMouseY = 0;
  let touchIntensity = 0;
  let lastDoubleTap = 0;

  // --- Audio Analyzer (drives visuals from sound output) ---
  let analyser = null;
  let analyserData = null;
  let bassLevel = 0, midLevel = 0, trebleLevel = 0, audioEnergy = 0;
  let contourAudioLevel = 0;

  function initAnalyser() {
    if (analyser || !audioCtx) return;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    if (outputBusGain) outputBusGain.connect(analyser);
    else if (limiter) limiter.connect(analyser);
    else if (compressor) compressor.connect(analyser);
    if (drumDryBus) drumDryBus.connect(analyser);
  }

  function updateAudioLevels() {
    if (!analyser) { initAnalyser(); return; }
    analyser.getByteFrequencyData(analyserData);
    const n = analyserData.length;
    let bass = 0, mid = 0, treble = 0;
    const bassEnd = Math.floor(n * 0.15);
    const midEnd = Math.floor(n * 0.5);
    for (let i = 0; i < bassEnd; i++) bass += analyserData[i];
    for (let i = bassEnd; i < midEnd; i++) mid += analyserData[i];
    for (let i = midEnd; i < n; i++) treble += analyserData[i];
    bassLevel = bass / (bassEnd * 255);
    midLevel = mid / ((midEnd - bassEnd) * 255);
    trebleLevel = treble / ((n - midEnd) * 255);
    audioEnergy = (bassLevel * 0.5 + midLevel * 0.3 + trebleLevel * 0.2);
  }

  function updateMixAutoGain() {
    if (!mixAutoGain) return;
    const midiActive = midiPlaybackActive || (displayedMidiNotes && displayedMidiNotes.length > 0);
    if (midiActive) {
      // MIDI playback: fixed gain target to avoid audible pumping.
      const targetMidi = 1.0;
      mixAutoGain.gain.value += (targetMidi - mixAutoGain.gain.value) * 0.06;
      return;
    }
    const polyKeyboard = keysPressed.size + sustainedVoices.size * 0.35;
    const polyMidi = Math.max(displayedMidiNotes.length, midiPlaybackPolyphony * 0.85);
    const poly = Math.max(polyKeyboard, polyMidi, chordCount);
    const polyComp = poly > 1 ? 1 / (1 + Math.pow(poly - 1, 1.1) * 0.16) : 1;
    const energyComp = 1 - Math.min(0.16, audioEnergy * 0.11 + bassLevel * 0.06 + midLevel * 0.03);
    const target = Math.max(0.72, Math.min(0.98, polyComp * energyComp));
    mixAutoGain.gain.value += (target - mixAutoGain.gain.value) * 0.11;
  }

  // --- Microphone → visuals: intuitive, smooth, gated ---
  // Principle: time-domain RMS (loudness) → smoothed → gate (ignore room noise) → scales bloom/warp/particles.
  // So: quiet = subtle glow, speaking/singing = gentle rise, loud = clear but not overwhelming.
  let micStream = null;
  let micAnalyser = null;
  let micData = null;
  let micLevel = 0;           // raw RMS 0..1
  let micLevelSmoothed = 0;   // lerped for smooth visuals
  const MIC_SMOOTH = 0.11;    // lower = smoother response
  const MIC_GATE = 0.012;     // below this = treat as silence (avoids room hiss driving UI)
  const MIC_VISUAL_SCALE = 0.65; // 0..1 mapped to visual intensity (more intuitive range)
  let micEnabled = false;
  function micVisualCurve(smoothedLevel) {
    // Soft-knee loudness map: quiet = subtle, speaking = moderate, loud = clear but bounded.
    const x = clamp01((smoothedLevel - MIC_GATE * 0.5) / 0.14);
    const low = Math.pow(x, 1.55) * 0.32;
    const midHigh = (1.0 - Math.exp(-x * 3.4)) * 0.56;
    return Math.min(0.72, (low + midHigh) * MIC_VISUAL_SCALE * 1.12);
  }

  async function toggleMic() {
    if (micEnabled && micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micEnabled = false; micStream = null;
      showModeToast('Mic off');
      return;
    }
    try {
      initAudio();
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = audioCtx.createMediaStreamSource(micStream);
      micAnalyser = audioCtx.createAnalyser();
      micAnalyser.fftSize = 256;
      micAnalyser.smoothingTimeConstant = 0.75;
      micData = new Uint8Array(micAnalyser.frequencyBinCount);
      src.connect(micAnalyser);
      micEnabled = true;
      showModeToast('Mic ON');
    } catch (e) { console.warn('Mic denied:', e); showModeToast('Mic denied'); }
  }

  function updateMicLevel() {
    if (!micEnabled || !micAnalyser) return;
    micAnalyser.getByteTimeDomainData(micData);
    let sum = 0;
    for (let i = 0; i < micData.length; i++) { const v = (micData[i] - 128) / 128; sum += v * v; }
    const raw = Math.sqrt(sum / micData.length);
    const gated = raw < MIC_GATE ? 0 : raw;
    micLevel = gated;
    micLevelSmoothed += (micLevel - micLevelSmoothed) * MIC_SMOOTH;
  }

  // --- Device gyroscope (mobile tilt) ---
  let gyroX = 0, gyroY = 0;
  let gyroEnabled = false;

  function initGyro() {
    if (gyroEnabled) return;
    const handler = (e) => {
      if (e.gamma != null) gyroX = Math.max(-1, Math.min(1, e.gamma / 45));
      if (e.beta != null) gyroY = Math.max(-1, Math.min(1, (e.beta - 45) / 45));
      if (!gyroEnabled) { gyroEnabled = true; showModeToast('Gyro ON'); }
    };
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(r => { if (r === 'granted') window.addEventListener('deviceorientation', handler); });
    } else {
      window.addEventListener('deviceorientation', handler);
    }
  }

  // --- Auto-Arpeggiator ---
  let arpEnabled = false;
  let arpInterval = null;
  let arpIndex = 0;
  let arpPattern = [0, 4, 7, 12, 7, 4]; // major triad up-down
  const ARP_PATTERNS = [
    [0, 4, 7, 12, 7, 4],     // major up-down
    [0, 3, 7, 12, 7, 3],     // minor up-down
    [0, 4, 7, 11, 12, 11, 7, 4], // maj7 cascade
    [0, 7, 12, 0, 5, 12],    // power fifths
    [0, 3, 7, 10, 14, 10, 7, 3], // min7 wave
    [0, 2, 4, 7, 9, 12, 9, 7, 4, 2], // pentatonic run
  ];

  function toggleArp() {
    if (arpEnabled) {
      clearInterval(arpInterval);
      arpEnabled = false;
      showModeToast('Arp off');
      return;
    }
    arpEnabled = true;
    showModeToast('Arp ON');
    arpPattern = ARP_PATTERNS[Math.floor(Math.random() * ARP_PATTERNS.length)];
    const bpm = 140;
    const stepMs = 60000 / bpm / 2; // 16th notes
    arpInterval = setInterval(() => {
      if (keysPressed.size === 0) return;
      // Get the lowest held note as root
      let rootMidi = 127;
      keysPressed.forEach(k => {
        const m = KEY_TO_NOTE[k];
        if (m != null && m < rootMidi) rootMidi = m;
      });
      if (rootMidi > 120) return;
      const note = rootMidi + arpPattern[arpIndex % arpPattern.length];
      arpIndex++;
      createSynthVoice(note, { sustained: false, velocity: 0.35 + Math.random() * 0.15 });
      triggerVisualsForMidi(note);
    }, stepMs);
  }

  // --- Ambient generative mode: subtle, responsive to user input ---
  // When idle long enough, very soft notes fade in; any key/drum/click stops it so you stay in control.
  let ambientMode = false;
  let ambientTimer = null;
  let lastUserAction = 0;
  const AMBIENT_DELAY = 22000; // 22s idle before ambient starts; any key/drum/click stops it (input-responsive)
  const AMBIENT_SCALES = [
    [0, 2, 4, 7, 9],       // pentatonic major
    [0, 3, 5, 7, 10],     // pentatonic minor
    [0, 2, 3, 5, 7, 8, 10], // dorian
    [0, 2, 4, 5, 7, 9, 11], // ionian
  ];
  let ambientScale = AMBIENT_SCALES[0];
  let ambientRoot = 60;
  let ambientNoteCount = 0; // first notes softer (fade-in)

  function startAmbient() {
    if (ambientMode) return;
    ambientMode = true;
    ambientNoteCount = 0;
    showModeToast('Ambient ON');
    ambientScale = AMBIENT_SCALES[Math.floor(Math.random() * AMBIENT_SCALES.length)];
    ambientRoot = 48 + Math.floor(Math.random() * 24);
    ambientStep();
  }

  function stopAmbient(skipToast) {
    ambientMode = false;
    if (ambientTimer) clearTimeout(ambientTimer);
    if (!skipToast) showModeToast('Ambient off');
  }

  function ambientStep() {
    if (!ambientMode || !audioCtx) return;
    // Subtle: very low velocity, gentle fade-in over first few notes
    ambientNoteCount++;
    const fadeIn = Math.min(1, ambientNoteCount / 6);
    const velBase = 0.055 + Math.random() * 0.06;
    const velocity = velBase * fadeIn;
    const degree = ambientScale[Math.floor(Math.random() * ambientScale.length)];
    const octave = Math.floor(Math.random() * 2) * 12;
    const note = ambientRoot + degree + octave;
    createSynthVoice(note, { sustained: Math.random() > 0.55, velocity });
    triggerVisualsForMidi(note);
    if (Math.random() > 0.82) {
      const d2 = ambientScale[(ambientScale.indexOf(degree) + 2) % ambientScale.length];
      createSynthVoice(ambientRoot + d2 + octave, { sustained: false, velocity: velocity * 0.7 });
    }
    const nextMs = 600 + Math.random() * 1200;
    ambientTimer = setTimeout(ambientStep, nextMs);
  }

  function markUserAction() {
    lastUserAction = performance.now();
    if (ambientMode) stopAmbient(true);
  }

  // Scroll wheel = zoom in/out (camera FOV + effect intensity)
  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.05 : -0.05;
    zoomLevel = Math.max(0.4, Math.min(2.5, zoomLevel + delta));
  }

  // Double-click = explosion effect (random key + flash)
  function onDblClick(e) {
    onFirstInteraction();
    const randomCol = Math.floor(Math.random() * GRID_COLS);
    const randomRow = Math.floor(Math.random() * GRID_ROWS);
    triggerCell(randomCol, randomRow);
    // Extra intensity burst
    attractor.strength = 2.5;
    targetKaleidoMix = 1.0;
    tgtPrism = Math.max(tgtPrism, 1.02);
    sparkleTime = performance.now() * 0.001;
    padLevel = 1;
    lastDoubleTap = performance.now() * 0.001;
  }

  // Touch interactions
  function onTouchStart(e) {
    onFirstInteraction();
    if (e.touches.length >= 2) {
      // Multi-touch = random explosion
      onDblClick(e);
      return;
    }
    const t = e.touches[0];
    const cell = getCellFromMouse(t.clientX, t.clientY);
    if (cell) {
      triggerCell(cell.col, cell.row);
      lastTriggeredCell = cell;
    }
    gridMouseDown = true;
  }
  function onTouchMove(e) {
    e.preventDefault();
    if (!e.touches[0]) return;
    const t = e.touches[0];
    // Track velocity
    const dx = t.clientX - lastMouseX;
    const dy = t.clientY - lastMouseY;
    mouseVelocity = Math.sqrt(dx * dx + dy * dy);
    lastMouseX = t.clientX; lastMouseY = t.clientY;
    const cell = getCellFromMouse(t.clientX, t.clientY);
    if (cell && gridMouseDown) {
      if (!lastTriggeredCell || cell.col !== lastTriggeredCell.col || cell.row !== lastTriggeredCell.row) {
        triggerCell(cell.col, cell.row);
        lastTriggeredCell = cell;
      }
    }
  }
  function onTouchEnd() { gridMouseDown = false; lastTriggeredCell = null; }

  // Mouse velocity tracking for enhanced visuals
  function onMouseMoveVelocity(e) {
    const dx = e.clientX - lastMouseX;
    const dy = e.clientY - lastMouseY;
    mouseVelocity = Math.sqrt(dx * dx + dy * dy);
    lastMouseX = e.clientX; lastMouseY = e.clientY;
  }

  setTimeout(hideIntroHint, 8000);
  document.body.addEventListener('click', onFirstInteraction);
  document.body.addEventListener('keydown', onFirstInteraction);
  document.body.addEventListener('keydown', onKeyDown);
  document.body.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousedown', onGridMouseDown);
  document.addEventListener('mousemove', onGridMouseMove);
  document.addEventListener('mousemove', onMouseMoveVelocity);
  document.addEventListener('mouseup', onGridMouseUp);
  document.addEventListener('mouseleave', () => { onGridMouseUp(); });
  document.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('dblclick', onDblClick);
  document.addEventListener('touchstart', onTouchStart, { passive: false });
  document.addEventListener('touchmove', onTouchMove, { passive: false });
  document.addEventListener('touchend', onTouchEnd);

  let time = 0;
  // ─── Visual & mic responsive mechanism (see RESPONSIVE.md for full doc) ───
  // (1) Keys/drums → attractor position + KEY_PROFILES (per-key hue, kaleido, glitch, warp, etc.) → particle pull + post FX.
  // (2) Master output analyser → bass/mid/treble/audioEnergy → bloom, warp, spiral, glitch, particle strength.
  // (3) Mic (time-domain RMS, smoothed, gated) → micVisual → bloom, warp, chromatic offset, particle attractor (subtle).
  // (4) Mouse/touch velocity → touchIntensity → warp, spiral, glitch. Head tracking → camera yaw + kaleido rotation.
  // (5) Chord (multiple keys) → blend KEY_PROFILES; 3+ keys = sparkle; 5+ = pad swell. All lerped for smooth transitions.

  // Hoisted outside animate to avoid per-frame function object allocation
  function _doRollOverlay(now) {
    if (!rollOverlayScene || !rollOverlayCamera || !roll3DGroup) return;
    rollOverlayCamera.position.x = 0.0;
    rollOverlayCamera.position.y = 0.008 * Math.sin(now * 0.2 + 0.5);
    rollOverlayCamera.position.z = 4.35 + 0.05 * Math.sin(now * 0.13 + 0.9);
    rollOverlayCamera.lookAt(0, -0.12, -1.9);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(rollOverlayScene, rollOverlayCamera);
    renderer.autoClear = true;
  }

  function animate() {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    var _frameStart = performance.now();
    const now = _frameStart * 0.001;
    time = now;
    const syncA = Math.sin(now * 0.45);
    const syncB = Math.sin(now * 0.38 + 1.0);

    padLevel *= 0.96;
    if (keysPressed.size >= 5) padLevel = Math.max(padLevel, 0.55);
    const sparkleFlash = Math.max(0, 1 - (now - sparkleTime) / 0.55);
    mouseVelocity *= 0.9;
    touchIntensity = Math.min(1, mouseVelocity / 50);

    const isIdle = keysPressed.size === 0 && attractor.strength < 0.06;
    if (!isIdle) {
      idlePhase = 'rest';
      idleIntensity *= 0.92;
      idleTimer = 0;
    } else {
      // Keep a restrained idle underlay (glyph/arch), no auto-audio.
      const idleTarget = 0.11 + 0.05 * (0.5 + 0.5 * syncA);
      idleIntensity += (idleTarget - idleIntensity) * 0.03;
      idleIntensity = Math.min(0.24, Math.max(0, idleIntensity));
    }

    // Audio analyzer → bass/mid/treble levels
    updateAudioLevels();
    updateMicLevel();
    updateMixAutoGain();

    // No auto-ambient: sound/effects only on key press or MIDI playback

    // Gyro → head offset (if no camera tracking but gyro available, VR/AR)
    if (gyroEnabled && !headTrackingActive) {
      headX += (0.5 + gyroX * 0.45 - headX) * 0.2;
      headY += (0.5 + gyroY * 0.35 - headY) * 0.2;
    }

    if (camera) {
      const targetFov = 48 / zoomLevel;
      camera.fov += (targetFov - camera.fov) * 0.05;
      camera.updateProjectionMatrix();
    }

    const dblFlash = Math.max(0, 1 - (now - lastDoubleTap) / 0.4);
    const kickFlash = Math.pow(Math.max(0, 1 - (now - lastKickImpact) / 0.18), 0.22);
    const minorDrumFlash = Math.pow(Math.max(0, 1 - (now - lastDrumMinorImpact) / 0.11), 0.58) * 0.25;
    const impactFlash = clamp01(kickFlash + minorDrumFlash);
    // Mic: smoothed + gated, scaled for intuitive visual range (not overwhelming)
    const micVisual = micVisualCurve(micLevelSmoothed);
    const audioBoost = audioEnergy * 0.6 + micVisual * 0.9;
    const bassHit = bassLevel > 0.4 ? (bassLevel - 0.4) * 2.5 : 0;
    const contourTarget = clamp01(audioEnergy * 0.82 + micVisual * 1.08 + bassHit * 0.12);
    contourAudioLevel += (contourTarget - contourAudioLevel) * 0.11;

    const profileAttack = activeProfile.in != null ? activeProfile.in : 0.78;
    const profileRelease = activeProfile.out != null ? activeProfile.out : 0.44;
    const blendAttack = Math.max(0.64, Math.min(0.92, profileAttack));
    const blendRelease = Math.max(0.36, Math.min(0.68, profileRelease));
    currentKaleidoFolds = smoothApproach(currentKaleidoFolds, targetKaleidoFolds, blendAttack, blendRelease);
    kaleidoMix = smoothApproach(kaleidoMix, targetKaleidoMix, Math.min(0.76, blendAttack), Math.max(0.28, blendRelease * 0.94));
    curSpiral = smoothApproach(curSpiral, tgtSpiral, blendAttack, blendRelease);
    curFlow = smoothApproach(curFlow, tgtFlow, blendAttack, blendRelease);
    curPulse = smoothApproach(curPulse, tgtPulse, blendAttack, blendRelease);
    curShear = smoothApproach(curShear, tgtShear, blendAttack, blendRelease);
    curWave = smoothApproach(curWave, tgtWave, blendAttack, blendRelease);
    curGlitch = smoothApproach(curGlitch, tgtGlitch, blendAttack, blendRelease);
    curMirrorX = smoothApproach(curMirrorX, tgtMirrorX, 0.32, 0.16);
    curMirrorY = smoothApproach(curMirrorY, tgtMirrorY, 0.32, 0.16);
    curWarp = smoothApproach(curWarp, tgtWarp, blendAttack, blendRelease);
    curPrism = smoothApproach(curPrism, tgtPrism, Math.min(0.58, blendAttack), Math.max(0.2, blendRelease * 0.92));
    curContrast = smoothApproach(curContrast, tgtContrast, blendAttack, blendRelease);
    curBio = smoothApproach(curBio, tgtBio, Math.min(0.56, blendAttack), Math.max(0.2, blendRelease * 0.9));
    curProfileRoll = smoothApproach(curProfileRoll, tgtProfileRoll, Math.min(0.5, blendAttack), Math.max(0.18, blendRelease * 0.9));
    if (now >= visualFreezeUntil && attractor.strength < 0.05) {
      targetKaleidoMix = Math.max(0.1, targetKaleidoMix * 0.998);
      tgtGlitch *= 0.995; tgtSpiral *= 0.995; tgtFlow *= 0.995; tgtPulse *= 0.995; tgtShear *= 0.995; tgtWave *= 0.995; tgtWarp *= 0.995; tgtPrism *= 0.997; tgtBio *= 0.996; tgtProfileRoll *= 0.992;
    }
    detectHeadPosition();
    const headSmooth = 0.068;
    headXSmoothed += (headX - headXSmoothed) * headSmooth;
    headYSmoothed += (headY - headYSmoothed) * headSmooth;
    const headOffset = headXSmoothed - 0.5;
    const headOffsetY = headYSmoothed - 0.5;
    headOffset_g = headOffset;

    // Keys always drive visuals when held (responsive during MIDI playback)
    if (keysPressed.size > 0) {
      let ax = 0, ay = 0, az = 0;
      let firstCol = 0, firstRow = 1;
      const keys = Array.from(keysPressed);
      keys.forEach((k, idx) => {
        const m = KEY_TO_NOTE[k];
        if (m != null) {
          const cell = midiToCell(m);
          const pos = cellToPosition3D(cell.col, cell.row);
          ax += pos.x; ay += pos.y; az += pos.z;
          if (idx === 0) { firstCol = cell.col; firstRow = cell.row; }
        }
      });
      const n = keys.length;
      if (n > 0) {
        attractor.x = ax / n;
        attractor.y = ay / n;
        attractor.z = az / n;
        attractor.strength = Math.max(attractor.strength, 1.05);
        attractor.col = firstCol;
        attractor.row = firstRow;
        if (n >= 2) {
          const activeProfiles = [];
          keys.forEach(k => {
            const m = KEY_TO_NOTE[k];
            if (m != null) activeProfiles.push(KEY_PROFILES[midiToCell(m).col % KEY_PROFILES.length]);
          });
          if (activeProfiles.length >= 2) {
            const blend = blendProfiles(activeProfiles, n, 0.12);
            if (blend) {
              targetKaleidoFolds = blend.folds;
              targetKaleidoMix = Math.min(0.92, 0.8 + (n - 1) * 0.028);
              tgtSpiral = blend.spiral;
              tgtFlow = blend.flow;
              tgtPulse = blend.pulse;
              tgtShear = blend.shear;
              tgtWave = blend.wave;
              tgtGlitch = blend.glitch;
              tgtMirrorX = blend.mx;
              tgtMirrorY = blend.my;
              tgtWarp = blend.warp;
              tgtPrism = blend.prism;
              tgtContrast = blend.contrast;
              tgtBio = blend.bio;
              tgtProfileRoll = blend.rot;
              currentKeyHue = blend.hue;
              activeProfile = { ...activeProfile, bloom: blend.bloom, ca: blend.ca, prism: blend.prism, bio: blend.bio, rot: blend.rot, in: blend.in, out: blend.out };
            }
          }
        }
      }
    }

    // Gesture: hand = virtual knobs; fast swipe = one-shot burst
    const fastSwipeActive = fastSwipeTime >= 0 && (now - fastSwipeTime) < FAST_SWIPE_DURATION;
    if (fastSwipeActive) sparkleTime = now;
    const gestureWarp = handKnob1 * 0.4;       // hand L→R = warp amount
    const gestureBloom = handKnob2 * 0.5;      // hand motion = bloom lift
    const gestureSpiral = handKnob2 * 0.08;   // motion gives only a light twist
    const gestureGlitch = fastSwipeActive ? 0.7 : 0;
    const gestureKaleidoBias = (handKnob1 - 0.5) * 0.06;
    // Integrated effect amplitudes (each different, premium, smooth — glasses-like)
    const ampKaleidoH = headTrackingActive ? 0.058 : 0.024;
    const ampKaleidoV = headTrackingActive ? -0.042 : -0.016;

    const headKaleidoBias = headOffset * ampKaleidoH + headOffsetY * ampKaleidoV;
    const breathe = 0.012 * syncA + 0.006 * syncB;
    const keyPush = attractor.strength > 0.05 ? (0.018 + 0.012 * syncB) * attractor.strength : 0;
    const idleKaleido = idleIntensity * 0.018 * syncA;
    const profileSpin = curProfileRoll * (0.014 + 0.024 * Math.min(1, attractor.strength + 0.1));
    const targetRotation = breathe + keyPush + gestureKaleidoBias + headKaleidoBias + idleKaleido + profileSpin;
    kaleidoRotation += (targetRotation - kaleidoRotation) * 0.4;

    if (camera) {
      // Camera stays fixed — no head tracking influence on background particles
      const profileRoll = curProfileRoll * (0.024 + 0.05 * Math.min(1, attractor.strength + 0.12));
      camera.rotation.y += (0 - camera.rotation.y) * 0.08;
      camera.rotation.x += (0 - camera.rotation.x) * 0.08;
      camera.rotation.z += (profileRoll - camera.rotation.z) * 0.06;
      camera.position.x += (0 - camera.position.x) * 0.08;
      camera.position.y += (0 - camera.position.y) * 0.08;
    }

    if (bgPlane && bgPlane.material && bgPlane.material.uniforms) {
      bgPlane.material.uniforms.time.value = now;
      bgPlane.material.uniforms.activeHue.value = currentKeyHue;
      bgPlane.material.uniforms.audioLevel.value = contourAudioLevel;
    }

    if (useGPGPU && gpuCompute && positionVariable && velocityVariable && particlePoints) {
      try {
        if (now >= visualFreezeUntil) attractor.strength *= 0.92;
        velocityVariable.material.uniforms.time.value = now;
        velocityVariable.material.uniforms.attractor.value.set(attractor.x, attractor.y, attractor.z);
        velocityVariable.material.uniforms.attractorStrength.value = attractor.strength + bassHit * 0.8 + micVisual * 0.5;
        velocityVariable.material.uniforms.attractorCol.value = attractor.col != null ? attractor.col : 0;
        velocityVariable.material.uniforms.attractorRow.value = attractor.row != null ? attractor.row : 1;
        gpuCompute.compute();
        particlePoints.material.uniforms.positionTexture.value = gpuCompute.getCurrentRenderTarget(positionVariable).texture;
        particlePoints.material.uniforms.time.value = now;
        particlePoints.material.uniforms.keyHue.value = currentKeyHue;
        particlePoints.material.uniforms.sparkleFlash.value = sparkleFlash;
        particlePoints.material.uniforms.padLevel.value = padLevel;
        particlePoints.material.uniforms.attractorCol.value = attractor.col != null ? attractor.col : 0;
      } catch (e) {
        useGPGPU = false;
        console.warn('GPGPU compute error, switching to fallback:', e && e.message ? e.message : e);
      }
    }

    const activeCol = Math.max(0, Math.min(SPECTRUM_BAR_COUNT - 1,
      Math.floor(((attractor.x + 1.5) / 3) * SPECTRUM_BAR_COUNT)));
    const str = Math.min(1, attractor.strength);
    const isKeyActive = str > 0.05;
    // Chord-aware layering: multi-key states stack cleanly and remain organized.
    const activeColsForLayers = [];
    if (keysPressed.size > 0) {
      keysPressed.forEach(k => {
        const m = KEY_TO_NOTE[k];
        if (m != null) activeColsForLayers.push(midiToCell(m).col);
      });
    }
    const styleBlend = styleBlendFromCols(activeColsForLayers, activeCol);
    styleMuseum += (styleBlend.museum - styleMuseum) * 0.24;
    styleLsd += (styleBlend.lsd - styleLsd) * 0.24;
    styleCrossover += (styleBlend.crossover - styleCrossover) * 0.2;
    const layerW = computeLayerWeights(activeColsForLayers, activeCol, str, isKeyActive);
    const colPhase = activeCol * 0.6 + now * 0.5;
    const tunnelW = layerW.tunnel;
    const verticalW = layerW.vertical;
    const centralW = layerW.central;
    const radiateW = layerW.radiate;
    const speedW = layerW.speed;
    const plasmaW = layerW.plasma;
    const floatW = layerW.float;

    // === NEURAL WEB: wave propagation on beat — ELECTRIC GREEN, large tunnel ===
    if (tunnelParticles && tunnelParticles.geometry) {
      const posAttr = tunnelParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = tunnelParticles.userData.basePos;
      if (impactFlash > 0.5 && (now - neuralWaveFront) > 0.3) neuralWaveFront = now;
      const waveAge = now - neuralWaveFront;
      const waveSpeed = 3.2;
      const waveWidth = 0.8;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i], by = base[i+1], bz = base[i+2];
        const radius = Math.sqrt(bx * bx + by * by);
        const depthN = (bz + 2.4) / 2.8;
        const wavePos = 1.0 - waveAge * waveSpeed / 2.8;
        const waveDist = Math.abs(depthN - wavePos);
        const waveStr = Math.exp(-waveDist * waveDist / (waveWidth * waveWidth)) * Math.max(0, 1.0 - waveAge * 0.8);
        const pulseR = 1.0 + waveStr * 0.35 + tunnelW * 0.12 * Math.sin(now * 1.2 + depthN * 4.0);
        const drift = tunnelW * 0.025 * Math.sin(now * 0.7 + (i / 3) * 0.02 + depthN * 3.0);
        const angle = Math.atan2(by, bx);
        arr[i]   = Math.cos(angle) * radius * pulseR + drift;
        arr[i+1] = Math.sin(angle) * radius * pulseR + drift * 0.6;
        arr[i+2] = bz + waveStr * 0.12 * Math.sin(now * 2.0 + angle * 3.0);
      }
      posAttr.needsUpdate = true;
      tunnelParticles.material.opacity = 0.03 + tunnelW * Math.min(0.95, 0.62 + 0.2 * (0.5 + 0.5 * syncA) + str * 0.24);
      // ELECTRIC GREEN — unique hue 0.33
      const waveHueShift = Math.max(0, 1.0 - waveAge * 1.2) * 0.12;
      tunnelParticles.material.color.setHSL(0.33 - waveHueShift * 0.1, 0.92, 0.42 + tunnelW * 0.35 + waveHueShift * 0.25);
      tunnelParticles.material.size = 0.004 + tunnelW * 0.003 * Math.abs(syncA) + Math.max(0, 1.0 - waveAge * 1.5) * 0.003;
    }

    // === DNA HELIX: double helix with dense rungs — HOT MAGENTA, centered ===
    if (centralColumnParticles && centralColumnParticles.geometry) {
      const posAttr = centralColumnParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const sustainGlow = Math.min(0.4, sustainedVoices.size * 0.1);
      const helixR = 0.38 + centralW * 0.45 + clamp01(bassHit) * 0.15;
      const helixRot = now * (0.7 + centralW * 0.35);
      const springSquash = 1.0 - impactFlash * 0.4;
      // 35% strand A, 35% strand B, 30% rungs (150 pts = ~19 rungs × 8 pts each)
      const strandPts = Math.floor(CENTRAL_COL_POINTS * 0.35); // 175
      const rungStart = strandPts * 2; // 350
      const rungTotal = CENTRAL_COL_POINTS - rungStart; // 150
      const ptsPerRung = 8;
      const rungCount = Math.floor(rungTotal / ptsPerRung); // ~18 rungs
      const revolutions = 4.0; // more turns for denser helix
      for (let v = 0; v < CENTRAL_COL_POINTS; v++) {
        if (v < strandPts) {
          // Strand A
          const st = v / (strandPts - 1);
          const baseY = (st * 2.8 - 1.4) * springSquash;
          const ang = helixRot + st * TAU * revolutions;
          arr[v * 3]     = Math.cos(ang) * helixR;
          arr[v * 3 + 1] = baseY + 0.04 * Math.sin(now * 1.5 + st * 8.0) * centralW;
          arr[v * 3 + 2] = Math.sin(ang) * helixR;
        } else if (v < rungStart) {
          // Strand B (offset by PI)
          const si = v - strandPts;
          const st = si / (strandPts - 1);
          const baseY = (st * 2.8 - 1.4) * springSquash;
          const ang = helixRot + st * TAU * revolutions + Math.PI;
          arr[v * 3]     = Math.cos(ang) * helixR;
          arr[v * 3 + 1] = baseY + 0.04 * Math.sin(now * 1.5 + st * 8.0 + 2.0) * centralW;
          arr[v * 3 + 2] = Math.sin(ang) * helixR;
        } else {
          // Rungs: connect strand A to strand B with multiple interpolated points
          const ri = v - rungStart;
          const rungIdx = Math.floor(ri / ptsPerRung);
          const ptInRung = ri % ptsPerRung;
          if (rungIdx < rungCount) {
            const rungT = (rungIdx + 0.5) / rungCount; // even spacing
            const rungY = (rungT * 2.8 - 1.4) * springSquash;
            const angA = helixRot + rungT * TAU * revolutions;
            const angB = angA + Math.PI;
            // Lerp across the rung (0→1 from strand A to strand B)
            const lerpT = ptInRung / (ptsPerRung - 1);
            const cosA = Math.cos(angA) * helixR, sinA = Math.sin(angA) * helixR;
            const cosB = Math.cos(angB) * helixR, sinB = Math.sin(angB) * helixR;
            arr[v * 3]     = cosA * (1 - lerpT) + cosB * lerpT;
            arr[v * 3 + 1] = rungY + 0.015 * Math.sin(now * 3.0 + rungIdx * 0.8) * centralW;
            arr[v * 3 + 2] = sinA * (1 - lerpT) + sinB * lerpT;
          } else {
            // Extra points: place on nearest strand
            const st = ri / Math.max(1, rungTotal - 1);
            const ang = helixRot + st * TAU * revolutions;
            arr[v * 3]     = Math.cos(ang) * helixR * 0.95;
            arr[v * 3 + 1] = (st * 2.8 - 1.4) * springSquash;
            arr[v * 3 + 2] = Math.sin(ang) * helixR * 0.95;
          }
        }
      }
      posAttr.needsUpdate = true;
      centralColumnParticles.material.opacity = 0.03 + centralW * Math.min(0.97, 0.72 + sustainGlow + padLevel * 0.22 + 0.1 * (0.5 + 0.5 * syncA));
      // HOT MAGENTA — unique hue 0.88
      centralColumnParticles.material.color.setHSL(0.88, 0.92, 0.52 + centralW * (0.30 + 0.08 * (0.5 + 0.5 * syncA)));
      centralColumnParticles.material.size = 0.008 + centralW * (0.005 + 0.003 * Math.abs(syncB));
    }

    // === LORENZ ATTRACTOR FIELD: 8 clean trajectories for readable butterfly shape ===
    if (radiatingParticles && radiatingParticles.geometry && radiatingParticles.userData.lorenzTrajs) {
      const posAttr = radiatingParticles.geometry.attributes.position;
      const colAttr = radiatingParticles.geometry.attributes.color;
      const arr = posAttr.array;
      const colArr = colAttr.array;
      const trajs = radiatingParticles.userData.lorenzTrajs;
      const trails = radiatingParticles.userData.lorenzTrails;
      // Only simulate 8 clean trajectories — use all 72 slots but only step 8
      const activeTrajs = 8;
      const sigma = 10.0 + clamp01(syncA) * 2.0;
      const rho = 24.0 + audioEnergy * 8.0 + impactFlash * 5.0;
      const beta = 2.667 + impactFlash * 1.5;
      const dt = 0.003;
      const scale = 0.065;
      // Step only the 8 active trajectory heads (use first 8 of the 72)
      for (let i = 0; i < activeTrajs; i++) {
        const ix = i * 3;
        const step = lorenzStep(trajs[ix], trajs[ix+1], trajs[ix+2], sigma, rho, beta, dt);
        const mag = Math.sqrt(step.x*step.x + step.y*step.y + step.z*step.z);
        if (mag > 80) { step.x *= 80/mag; step.y *= 80/mag; step.z *= 80/mag; }
        trajs[ix] = step.x; trajs[ix+1] = step.y; trajs[ix+2] = step.z;
        // Each active traj uses 9 consecutive trail slots (9 × 100 = 900 pts per butterfly arm)
        const slotsPerTraj = Math.floor(RADIATE_COUNT / activeTrajs); // 9
        for (let s = 0; s < slotsPerTraj; s++) {
          const slotIdx = i * slotsPerTraj + s;
          if (slotIdx >= RADIATE_COUNT) break;
          const trailBase = slotIdx * RADIATE_POINTS_PER_RAY * 3;
          // Shift trail
          for (let k = RADIATE_POINTS_PER_RAY - 1; k > 0; k--) {
            const dst = trailBase + k * 3;
            const src = trailBase + (k - 1) * 3;
            trails[dst] = trails[src]; trails[dst+1] = trails[src+1]; trails[dst+2] = trails[src+2];
          }
          // Head = current position + small offset per slot for trail thickness
          const offset = (s - slotsPerTraj * 0.5) * 0.08;
          trails[trailBase]     = step.x + offset * 0.3;
          trails[trailBase + 1] = step.y + offset * 0.2;
          trails[trailBase + 2] = step.z + offset * 0.15;
        }
      }
      // Write all trail positions to geometry + coloring
      const totalPts = RADIATE_COUNT * RADIATE_POINTS_PER_RAY;
      for (let p = 0; p < totalPts; p++) {
        const trajSlot = Math.floor(p / RADIATE_POINTS_PER_RAY);
        const k = p % RADIATE_POINTS_PER_RAY;
        const activeTraj = Math.floor(trajSlot / Math.floor(RADIATE_COUNT / activeTrajs));
        const idx = p * 3;
        const tb = trajSlot * RADIATE_POINTS_PER_RAY * 3 + k * 3;
        arr[idx]     = trails[tb] * scale;
        arr[idx + 1] = (trails[tb + 1] - 25) * scale;
        arr[idx + 2] = (trails[tb + 2] - 25) * scale;
        // Fade along trail length
        const fade = 1.0 - (k / RADIATE_POINTS_PER_RAY) * 0.9;
        // Per-trajectory hue shift for distinct arms
        const hueShift = (activeTraj % activeTrajs) / activeTrajs;
        // WARM ORANGE/FIRE with per-arm tint
        colArr[idx]     = fade * (0.80 + hueShift * 0.2);
        colArr[idx + 1] = fade * (0.30 + hueShift * 0.35);
        colArr[idx + 2] = fade * (0.05 + hueShift * 0.15);
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      radiatingParticles.material.opacity = 0.03 + radiateW * Math.min(0.92, 0.62 + str * 0.22 + 0.12 * (0.5 + 0.5 * syncB));
      radiatingParticles.material.size = 0.004 + radiateW * (0.003 + 0.002 * Math.abs(syncA));
    }

    // === VORONOI MEMBRANE: hexagonal honeycomb lattice with ripple wave on beat ===
    if (matrixSurfaceParticles && matrixSurfaceParticles.geometry && matrixSurfaceParticles.userData.basePos) {
      const posAttr = matrixSurfaceParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = matrixSurfaceParticles.userData.basePos;
      const surfW = Math.max(0.14, 0.55 * verticalW + 0.45 * speedW);
      const ud = matrixSurfaceParticles.userData;
      // Trigger ripple on beat
      if (impactFlash > 0.4 && (now - ud.rippleTime) > 0.4) ud.rippleTime = now;
      const rippleAge = now - ud.rippleTime;
      const rippleSpeed = 2.5;
      const rippleRadius = rippleAge * rippleSpeed;
      const rippleFade = Math.max(0, 1.0 - rippleAge * 0.5);
      // Slow gentle tilt rotation for 3D presence
      const tiltA = now * 0.08;
      const ctA = Math.cos(tiltA * 0.3) * 0.15;
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i], bz = base[i + 2];
        // Distance from center for ripple
        const dist = Math.sqrt(bx * bx + bz * bz);
        // Concentric ripple wave — Y displacement
        const rippleDist = Math.abs(dist - rippleRadius);
        const rippleStr = Math.exp(-rippleDist * rippleDist * 8.0) * rippleFade * 0.35;
        const rippleY = rippleStr * Math.sin(dist * 8.0 - rippleAge * 10.0);
        // Subtle hex breathing: cells pulse outward from center
        const breath = 0.015 * surfW * Math.sin(now * 1.2 + dist * 3.0);
        const breathDir = dist > 0.01 ? 1.0 / dist : 0;
        // Bass pulse lifts entire grid
        const bassLift = clamp01(bassHit) * 0.08;
        // Gentle tilt gives 3D depth
        const tiltY = bx * ctA;
        arr[i]     = bx + bx * breathDir * breath * 0.3;
        arr[i + 1] = rippleY + tiltY + bassLift + 0.02 * Math.sin(now * 2.0 + bx * 4.0 + bz * 3.0) * surfW;
        arr[i + 2] = bz + bz * breathDir * breath * 0.3;
      }
      posAttr.needsUpdate = true;
      matrixSurfaceParticles.material.opacity = 0.02 + surfW * Math.min(0.65, 0.35 + 0.18 * (0.5 + 0.5 * syncA) + rippleFade * 0.15);
      matrixSurfaceParticles.material.size = 0.004 + surfW * 0.002 + rippleFade * 0.0015;
      // TEAL/AQUAMARINE — unique hue 0.47
      matrixSurfaceParticles.material.color.setHSL(0.47, 0.78, 0.50 + rippleFade * 0.25);
    }

    // === CRYSTAL GROWTH: dendritic fractal branching, beat spawns sub-branches ===
    if (prismSpokeParticles && prismSpokeParticles.geometry && prismSpokeParticles.userData.basePos && crystalBranchLen) {
      const posAttr = prismSpokeParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = prismSpokeParticles.userData.basePos;
      const prismW = Math.max(0.12, 0.62 * radiateW + 0.38 * styleCrossover);
      const nBranches = prismSpokeParticles.userData.crystalBranches;
      const ppb = prismSpokeParticles.userData.ptsPerBranch;
      // Beat triggers growth burst
      if (impactFlash > 0.3) {
        for (let i = 0; i < PRISM_SPOKE_POINTS; i++) {
          crystalBranchLen[i] = Math.min(1.0, crystalBranchLen[i] + impactFlash * 0.15);
        }
      }
      // Slow rotation
      const rot = now * 0.06;
      const cr = Math.cos(rot), sr = Math.sin(rot);
      for (let b = 0; b < nBranches; b++) {
        for (let p = 0; p < ppb; p++) {
          const idx = (b * ppb + p);
          const i3 = idx * 3;
          const t = p / (ppb - 1);
          // Growth: points beyond branch length are pulled to tip
          const growT = Math.min(t, crystalBranchLen[idx]);
          // Dissolve: slowly recede between beats
          crystalBranchLen[idx] = Math.max(0.15, crystalBranchLen[idx] - 0.0003);
          const growScale = growT / Math.max(0.01, t);
          const bx = base[i3] * growScale;
          const by = base[i3 + 1] * growScale;
          const bz = base[i3 + 2] * growScale;
          // Rotate around Y axis
          const rx = bx * cr - bz * sr;
          const rz = bx * sr + bz * cr;
          // Ice crystal shimmer + subtle branch sway
          const shimmer = 0.012 * prismW * Math.sin(now * 2.5 + crystalBranchPhase[idx] + t * 12.0);
          const sway = t * 0.06 * Math.sin(now * 0.8 + b * 1.2) * prismW;
          arr[i3]     = rx + shimmer + sway;
          arr[i3 + 1] = by + 0.03 * Math.sin(now * 1.8 + t * 6.0) * prismW;
          arr[i3 + 2] = rz + shimmer * 0.7 + sway * 0.5;
        }
      }
      posAttr.needsUpdate = true;
      prismSpokeParticles.material.opacity = 0.02 + prismW * Math.min(0.72, 0.42 + 0.18 * (0.5 + 0.5 * syncB));
      // ELECTRIC VIOLET — unique hue 0.75
      prismSpokeParticles.material.color.setHSL(0.75, 0.88, 0.62 + prismW * 0.15);
      prismSpokeParticles.material.size = 0.004 + prismW * (0.003 + 0.002 * Math.abs(syncA));
    }

    if (boxWireframe && boxWireframe.material) {
      boxWireframe.material.opacity = 0.12 + 0.035 * syncA + str * 0.06;
    }

    // === FIBER OPTIC STREAMS: data packets racing along 3D spiral splines ===
    if (speedLineParticles && speedLineParticles.geometry) {
      const posAttr = speedLineParticles.geometry.attributes.position;
      const arr = posAttr.array;
      // 80 lines → 8 distinct spiral splines × 10 packets each, 120 trail pts per packet
      const splineCount = 8;
      const packetsPerSpline = 10;
      const trailLen = SPEED_POINTS_PER_LINE;
      const baseSpeed = 0.22 + clamp01(syncA) * 0.12;
      for (let sp = 0; sp < splineCount; sp++) {
        // Each spline is a distinct 3D helix/spiral with unique parameters
        const spAngle = (sp / splineCount) * TAU;
        const helixPitch = 0.6 + (sp % 3) * 0.35; // vertical rise per revolution
        const helixDir = (sp % 2) * 2 - 1; // CW or CCW
        const baseR = 0.5 + (sp % 4) * 0.25; // varying radii for depth
        for (let pk = 0; pk < packetsPerSpline; pk++) {
          const lineIdx = sp * packetsPerSpline + pk;
          if (lineIdx >= SPEED_LINE_COUNT) break;
          // Packet head position along spline (0..1 wrapping)
          const packetSpeed = baseSpeed + pk * 0.04 + (sp % 3) * 0.03;
          const headT = ((now * packetSpeed + pk * 0.1 + sp * 0.125) % 1.0);
          for (let k = 0; k < trailLen; k++) {
            const idx = (lineIdx * trailLen + k) * 3;
            // Long trail — 0.4 coverage means visible streaming lines
            const trailT = headT - (k / trailLen) * 0.4;
            const t = ((trailT % 1.0) + 1.0) % 1.0;
            // 3D helix spline: spirals around center
            const revolutions = 2.0;
            const ang = spAngle + t * TAU * revolutions * helixDir;
            const splineR = baseR + 0.4 * Math.sin(t * Math.PI); // bulge in middle
            const x = Math.cos(ang) * splineR;
            const z = Math.sin(ang) * splineR;
            const y = (t - 0.5) * helixPitch * 2.0 + 0.15 * Math.sin(t * TAU + sp);
            // Beat burst: pulse outward
            const fade = Math.pow(1.0 - k / trailLen, 1.8);
            const burstR = impactFlash * 0.08 * fade;
            arr[idx]     = x * (1.0 + burstR);
            arr[idx + 1] = y;
            arr[idx + 2] = z * (1.0 + burstR);
          }
        }
      }
      posAttr.needsUpdate = true;
      speedLineParticles.material.opacity = 0.03 + speedW * Math.min(0.95, 0.62 + 0.22 * (0.5 + 0.5 * syncB) + str * 0.2);
      // NEON BLUE — unique hue 0.58
      speedLineParticles.material.color.setHSL(0.58, 0.95, 0.48 + speedW * (0.32 + 0.08 * (0.5 + 0.5 * syncA)));
      speedLineParticles.material.size = 0.005 + speedW * 0.004 * Math.abs(syncB);
    }

    if (verticalParticleColumns && verticalParticleColumns.children[0]) {
      const colPts = verticalParticleColumns.children[0];
      const posAttr = colPts.geometry.attributes.position;
      const arr = posAttr.array;
      // Columns shatter apart, lean, and wave irregularly when active
      for (let c = 0; c < SPECTRUM_BAR_COUNT; c++) {
        const isActive = c === activeCol && isKeyActive;
        const baseX = ((c + 0.5) / SPECTRUM_BAR_COUNT) * 2.8 - 1.4;
        const lean = isActive ? 0.18 * Math.sin(colPhase * 2 + c) : 0;
        const explode = isActive ? 0.04 : 0;
        for (let v = 0; v < VERT_COL_POINTS; v++) {
          const i = c * VERT_COL_POINTS + v;
          const t = v / (VERT_COL_POINTS - 1);
          const baseY = t * 1.6 - 0.8;
          const phase = c * 0.65 + v * 0.04 + colPhase * 1.5;
          const waveAmp = isActive ? 0.32 + 0.12 * Math.sin(colPhase + c) : 0.08;
          const scatter = explode * Math.sin(v * 3.3 + colPhase * 3) * (0.5 + 0.5 * Math.sin(v * 0.7));
          arr[i*3]   = baseX + lean * t + 0.035 * Math.sin(colPhase + c + v * 0.04) + scatter;
          arr[i*3+1] = baseY + waveAmp * Math.sin(phase) + 0.12 * Math.sin(colPhase * 1.2 + v * 0.08 + c * 0.9);
          arr[i*3+2] = -1.0 + 0.05 * Math.sin(colPhase + c) + scatter * 0.6;
        }
      }
      posAttr.needsUpdate = true;
      colPts.material.opacity = 0.03 + verticalW * Math.min(0.95, 0.64 + str * 0.24 + 0.12 * (0.5 + 0.5 * syncA));
      colPts.material.size = 0.004 + verticalW * 0.002 * Math.abs(syncB) + (isKeyActive ? 0.002 : 0);
      // WARM WHITE with subtle rose tint — unique hue 0.95
      colPts.material.color.setHSL(0.95, 0.45, 0.88);
    }

    // === SHOCKWAVE DEBRIS: physics torus explosion, ballistic arcs, reconvergence ===
    if (burstRingParticles && burstRingParticles.geometry && burstVelocities) {
      const posAttr = burstRingParticles.geometry.attributes.position;
      const colAttr = burstRingParticles.geometry.attributes.color;
      const pArr = posAttr.array;
      const cArr = colAttr.array;
      burstRingParticles.position.set(attractor.x, attractor.y, attractor.z);
      burstRingParticles.scale.set(1, 1, 1);
      burstRingParticles.rotation.set(0, 0, 0);
      // Trigger explosion on beat — BIG ring, fast debris
      if (impactFlash > 0.5 && (now - burstPhase) > 0.5) {
        burstPhase = now;
        for (let i = 0; i < BURST_RING_POINTS; i++) {
          const a = (i / BURST_RING_POINTS) * TAU;
          pArr[i * 3] = Math.cos(a) * 0.5;
          pArr[i * 3 + 1] = Math.sin(a) * 0.5;
          pArr[i * 3 + 2] = 0;
          const speed = 2.0 + Math.random() * 3.0;
          const jitter = (Math.random() - 0.5) * 0.5;
          burstVelocities[i * 3]     = Math.cos(a + jitter) * speed;
          burstVelocities[i * 3 + 1] = Math.sin(a + jitter) * speed + Math.random() * 0.6;
          burstVelocities[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
          burstAges[i] = 0;
        }
      }
      const burstElapsed = now - burstPhase;
      const isExploding = burstElapsed < 3.0;
      const dt = 0.016;
      const gravity = -0.3;
      const drag = 0.985;
      const reconvergeStr = isExploding ? Math.max(0, (burstElapsed - 1.5) * 0.4) : 0.8;
      for (let i = 0; i < BURST_RING_POINTS; i++) {
        const i3 = i * 3;
        const a = (i / BURST_RING_POINTS) * TAU;
        // Target ring position — big ring
        const tx = Math.cos(a) * 0.5;
        const ty = Math.sin(a) * 0.5;
        const tz = 0;
        if (isExploding) {
          // Apply physics
          burstVelocities[i3 + 1] += gravity * dt;
          burstVelocities[i3] *= drag; burstVelocities[i3+1] *= drag; burstVelocities[i3+2] *= drag;
          // Reconvergence force: pull back toward ring
          burstVelocities[i3]     += (tx - pArr[i3]) * reconvergeStr * dt;
          burstVelocities[i3 + 1] += (ty - pArr[i3+1]) * reconvergeStr * dt;
          burstVelocities[i3 + 2] += (tz - pArr[i3+2]) * reconvergeStr * dt;
          pArr[i3]     += burstVelocities[i3] * dt;
          pArr[i3 + 1] += burstVelocities[i3+1] * dt;
          pArr[i3 + 2] += burstVelocities[i3+2] * dt;
          burstAges[i] += dt;
        } else {
          // Dormant: gentle ring drift
          pArr[i3]     = tx + 0.005 * Math.sin(now * 1.2 + i * 0.1);
          pArr[i3 + 1] = ty + 0.005 * Math.cos(now * 0.9 + i * 0.15);
          pArr[i3 + 2] = 0.003 * Math.sin(now * 0.7 + i * 0.2);
        }
        // Temperature color: hot orange→red→dark ember
        const heat = isExploding ? Math.max(0, 1.0 - burstAges[i] * 0.6) : 0.2;
        cArr[i3]     = 0.15 + heat * 0.85;
        cArr[i3 + 1] = 0.08 + heat * 0.55;
        cArr[i3 + 2] = 0.02 + heat * 0.12;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      burstRingParticles.visible = true;
      burstRingParticles.material.opacity = isExploding ? Math.min(0.98, 0.5 + impactFlash * 0.48) : 0.25;
      burstRingParticles.material.size = isExploding ? 0.012 + impactFlash * 0.008 : 0.006;
    }

    // === BIOLUMINESCENT JELLYFISH: dome bell + 12 layered tentacles, pump on beat ===
    if (plasmaParticles && plasmaParticles.geometry) {
      const posAttr = plasmaParticles.geometry.attributes.position;
      const arr = posAttr.array;
      // Bell: 160 pts dome (membrane rings), inner glow: 40 pts, Tentacles: 12 × ~33 pts
      const bellPts = 160;
      const innerPts = 40;
      const tentacleCount = 12;
      const tentaclePts = Math.floor((PLASMA_POINTS - bellPts - innerPts) / tentacleCount);
      // Organism center: gently orbits center
      const cx = attractor.x * 0.25 + 0.12 * Math.sin(now * 0.18);
      const cy = attractor.y * 0.25 + 0.1 * Math.sin(now * 0.22 + 1.0);
      const cz = attractor.z * 0.25 + 0.08 * Math.cos(now * 0.15);
      // Bell pump: contracts on beat
      const pumpPhase = impactFlash;
      const bellRadius = 0.6 * (1.0 + clamp01(bassHit) * 0.12 - pumpPhase * 0.2);
      const bellHeight = 0.4 * (1.0 - pumpPhase * 0.25);
      const jellyRot = now * 0.12;
      // Bell dome — structured as concentric rings for visible membrane
      for (let i = 0; i < bellPts; i++) {
        const ring = Math.floor(i / 20); // 8 rings of 20 pts
        const inRing = i % 20;
        const ringT = ring / 7; // 0..1 from top to rim
        const phi = ringT * Math.PI * 0.52;
        const theta = (inRing / 20) * TAU + jellyRot + ring * 0.15;
        const r = bellRadius * Math.sin(phi);
        const y = bellHeight * Math.cos(phi);
        const edgePulse = (ringT > 0.7) ? (1.0 + pumpPhase * 0.18) : 1.0;
        // Subtle radial breathing
        const breathe = 1.0 + 0.03 * Math.sin(now * 2.5 + ring * 1.2) * plasmaW;
        arr[i * 3]     = cx + Math.cos(theta) * r * edgePulse * breathe;
        arr[i * 3 + 1] = cy + y;
        arr[i * 3 + 2] = cz + Math.sin(theta) * r * edgePulse * breathe;
      }
      // Inner glow points — small cluster inside bell
      for (let i = 0; i < innerPts; i++) {
        const idx = bellPts + i;
        const t = i / (innerPts - 1);
        const phi = t * Math.PI * 0.35;
        const theta = (i * 2.39996 + jellyRot * 1.3) % TAU;
        const r = bellRadius * 0.35 * Math.sin(phi);
        const y = bellHeight * 0.6 * Math.cos(phi);
        arr[idx * 3]     = cx + Math.cos(theta) * r;
        arr[idx * 3 + 1] = cy + y * 0.8;
        arr[idx * 3 + 2] = cz + Math.sin(theta) * r;
      }
      // Tentacles: 12 tentacles in 2 layers (6 long outer + 6 shorter inner)
      for (let t = 0; t < tentacleCount; t++) {
        const isOuter = t < 6;
        const tentBaseAng = (t / (isOuter ? 6 : 6)) * TAU + jellyRot + (isOuter ? 0 : Math.PI / 6);
        const tentBaseR = bellRadius * (isOuter ? 0.88 : 0.55);
        const tentLength = isOuter ? 1.1 : 0.6;
        for (let p = 0; p < tentaclePts; p++) {
          const idx = bellPts + innerPts + t * tentaclePts + p;
          if (idx >= PLASMA_POINTS) break;
          const pt = p / (tentaclePts - 1);
          // Primary wave
          const waveFreq = isOuter ? 2.5 : 3.5;
          const wave1 = 0.1 * Math.sin(pt * waveFreq * TAU + now * 2.2 + t * 0.7) * (1.0 - pt * 0.4);
          // Secondary finer wave
          const wave2 = 0.04 * Math.sin(pt * 7.0 + now * 3.5 + t * 1.2) * (1.0 - pt * 0.6);
          const hangY = -pt * tentLength * (1.0 + pumpPhase * 0.25);
          // Tentacles spread outward and curl slightly
          const spreadR = tentBaseR * (1.0 + pt * 0.4 * (isOuter ? 1.0 : 0.5));
          const curl = pt * pt * 0.15 * Math.sin(now * 0.5 + t);
          arr[idx * 3]     = cx + Math.cos(tentBaseAng + curl) * spreadR + wave1 + wave2;
          arr[idx * 3 + 1] = cy - bellHeight * 0.25 + hangY;
          arr[idx * 3 + 2] = cz + Math.sin(tentBaseAng + curl) * spreadR + (wave1 + wave2) * 0.7;
        }
      }
      posAttr.needsUpdate = true;
      plasmaParticles.material.opacity = 0.02 + plasmaW * Math.min(0.95, 0.65 + padLevel * 0.18 + 0.12 * (0.5 + 0.5 * syncB));
      // DEEP PURPLE / BIOLUMINESCENT — unique hue 0.80
      plasmaParticles.material.color.setHSL(0.80, 0.85, 0.48 + plasmaW * (0.32 + pumpPhase * 0.18));
      plasmaParticles.material.size = 0.008 + plasmaW * 0.006 * Math.min(1, str) + pumpPhase * 0.004;
    }

    // === MURMURATION: boids flocking, scatter on beat, regroup ===
    if (floatingParticleClouds && floatingParticleClouds.children[0] && floatVelocities) {
      const floatPts = floatingParticleClouds.children[0];
      const posAttr = floatPts.geometry.attributes.position;
      const colAttr = floatPts.geometry.attributes.color;
      const arr = posAttr.array;
      const cArr = colAttr.array;
      const n = FLOATING_ORB_COUNT * FLOATING_POINTS_PER_ORB;
      // Moving attractor orbit — wide orbit
      const attractorSpeed = 0.2 + clamp01(syncA) * 0.1;
      const ax = Math.sin(now * attractorSpeed) * 1.0;
      const ay = 0.3 * Math.sin(now * attractorSpeed * 1.3 + 1.0);
      const az = Math.cos(now * attractorSpeed * 0.7) * 0.8;
      // Boids parameters
      const sepDist = 0.06;
      const cohesion = 0.003 + audioEnergy * 0.004;
      const alignment = 0.02;
      const separation = 0.008;
      const attractForce = 0.004;
      const maxSpeed = 0.015 + floatW * 0.01;
      // Scatter burst on beat — dramatic scatter
      const scatterStr = impactFlash * 0.22;
      // Simplified boids: use grid-free local neighborhood (check every 8th boid for perf)
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const px = arr[i3], py = arr[i3+1], pz = arr[i3+2];
        let sepX = 0, sepY = 0, sepZ = 0;
        let cohX = 0, cohY = 0, cohZ = 0;
        let alX = 0, alY = 0, alZ = 0;
        let neighbors = 0;
        // Sample ~20 random neighbors for O(n) instead of O(n^2)
        for (let s = 0; s < 20; s++) {
          const j = ((i * 7 + s * 37) % n);
          if (j === i) continue;
          const j3 = j * 3;
          const dx = arr[j3] - px, dy = arr[j3+1] - py, dz = arr[j3+2] - pz;
          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.001;
          if (dist < 0.25) {
            neighbors++;
            cohX += arr[j3]; cohY += arr[j3+1]; cohZ += arr[j3+2];
            alX += floatVelocities[j3]; alY += floatVelocities[j3+1]; alZ += floatVelocities[j3+2];
            if (dist < sepDist) {
              const repel = 1.0 / (dist * dist + 0.001);
              sepX -= dx * repel; sepY -= dy * repel; sepZ -= dz * repel;
            }
          }
        }
        if (neighbors > 0) {
          cohX = (cohX / neighbors - px) * cohesion;
          cohY = (cohY / neighbors - py) * cohesion;
          cohZ = (cohZ / neighbors - pz) * cohesion;
          alX = (alX / neighbors - floatVelocities[i3]) * alignment;
          alY = (alY / neighbors - floatVelocities[i3+1]) * alignment;
          alZ = (alZ / neighbors - floatVelocities[i3+2]) * alignment;
        }
        // Attractor pull
        const toAx = (ax - px) * attractForce;
        const toAy = (ay - py) * attractForce;
        const toAz = (az - pz) * attractForce;
        // Scatter on beat
        const scX = scatterStr * (Math.sin(i * 2.39996) * 2 - 1);
        const scY = scatterStr * (Math.cos(i * 1.618) * 2 - 1);
        const scZ = scatterStr * (Math.sin(i * 3.14159) * 2 - 1);
        // Apply forces
        floatVelocities[i3]     += sepX * separation + cohX + alX + toAx + scX;
        floatVelocities[i3 + 1] += sepY * separation + cohY + alY + toAy + scY;
        floatVelocities[i3 + 2] += sepZ * separation + cohZ + alZ + toAz + scZ;
        // Clamp speed
        const spd = Math.sqrt(floatVelocities[i3]*floatVelocities[i3] + floatVelocities[i3+1]*floatVelocities[i3+1] + floatVelocities[i3+2]*floatVelocities[i3+2]);
        if (spd > maxSpeed) {
          const sc = maxSpeed / spd;
          floatVelocities[i3] *= sc; floatVelocities[i3+1] *= sc; floatVelocities[i3+2] *= sc;
        }
        // Update position
        arr[i3]     += floatVelocities[i3];
        arr[i3 + 1] += floatVelocities[i3+1];
        arr[i3 + 2] += floatVelocities[i3+2];
        // Boundary: soft repulsion — wider boundary
        const bDist = Math.sqrt(arr[i3]*arr[i3] + arr[i3+1]*arr[i3+1] + arr[i3+2]*arr[i3+2]);
        if (bDist > 2.2) {
          const push = (bDist - 2.2) * 0.01;
          arr[i3] -= arr[i3] / bDist * push;
          arr[i3+1] -= arr[i3+1] / bDist * push;
          arr[i3+2] -= arr[i3+2] / bDist * push;
        }
        // WARM GOLD/AMBER: dense center = bright gold, edges = warm orange
        const centerDist = Math.sqrt((arr[i3]-ax)*(arr[i3]-ax) + (arr[i3+1]-ay)*(arr[i3+1]-ay) + (arr[i3+2]-az)*(arr[i3+2]-az));
        const brightness = Math.max(0.2, 1.0 - centerDist * 1.8);
        cArr[i3]     = brightness * 0.95 + (1-brightness) * 0.75;
        cArr[i3 + 1] = brightness * 0.82 + (1-brightness) * 0.42;
        cArr[i3 + 2] = brightness * 0.35 + (1-brightness) * 0.08;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      floatPts.material.opacity = 0.03 + floatW * Math.min(0.95, 0.65 + 0.16 * (0.5 + 0.5 * syncA) + str * 0.2);
      floatPts.material.size = 0.005 + floatW * 0.004 * Math.abs(syncB);
    }

    // Per-drum-type flash values
    const drumTypeFlashes = {};
    for (const dk in lastDrumTypeImpact) {
      drumTypeFlashes[dk] = Math.pow(Math.max(0, 1 - (now - lastDrumTypeImpact[dk]) / 0.13), 0.5) * 0.35;
    }
    updateRoll3DLayer(now, syncA, syncB, impactFlash, currentKeyHue, kickFlash, minorDrumFlash, drumTypeFlashes, headOffset_g, headOffsetY);

    if (Math.floor(now * 6) % 1 === 0) updateHud();
    updateKeyDisplay();
    updateNoteRepeatOverlay();
    if (keyDisplayMesh && keyDisplayMesh.visible && keyDisplayMesh.userData.baseY != null) {
      keyDisplayMesh.position.y = keyDisplayMesh.userData.baseY + 0.014 * Math.sin(now * 0.45);
      keyDisplayMesh.rotation.z = 0.008 * Math.sin(now * 0.38 + 1.0) + curProfileRoll * 0.04;
      keyDisplayMesh.rotation.y = curProfileRoll * 0.12 + 0.01 * Math.sin(now * 0.32 + 0.7);
    }
    if (headTrackingActive) updateGestureBar();

    // VHS timestamp: create lazily, update ~1/sec
    if (!vhsTimestampEl) createVhsTimestamp();
    if (vhsTimestampEl && Math.floor(now) !== Math.floor(now - 0.017)) {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      vhsTimestampEl.textContent = 'SP  ' + hh + ':' + mm + ':' + ss;
      vhsTimestampEl.style.opacity = (headTrackingActive || keysPressed.size > 0) ? '0.7' : '0.35';
    }

    // Datamosh: block-shift on kick drum hits
    if (kickFlash > 0.6 && datamoshPhase === 0) {
      datamoshPhase = now;
      datamoshDir = Math.random() > 0.5 ? 1 : -1;
    }
    if (datamoshPhase > 0 && noteRepeatOverlayEl) {
      const age = now - datamoshPhase;
      if (age < 0.15) {
        const shiftPx = datamoshDir * Math.round((0.15 - age) / 0.15 * 18);
        noteRepeatOverlayEl.style.transform = 'translateX(' + shiftPx + 'px)';
      } else {
        noteRepeatOverlayEl.style.transform = '';
        datamoshPhase = 0;
      }
    }

    // Beat-reactive interlace opacity
    {
      const interlaceTarget = 0.12 + impactFlash * 0.28 + (postQuad ? postQuad.material.uniforms.analogMix.value * 0.14 : 0);
      document.documentElement.style.setProperty('--interlace-opacity', interlaceTarget.toFixed(3));
    }

    // ═══ Y2K HUD: lazy create + reactive updates ═══
    if (!bracketFrameEl) createBracketFrame();
    if (!crosshairEl) createCrosshairs();
    if (!scanlineEl) createScanline();
    if (!datastreamEl) createDatastream();
    if (!gradientCornersEl) createGradientCorners();
    if (!spectrumEl) createSpectrum();
    if (!chordEl) createChordDisplay();
    if (!arcEl) createArcRing();
    if (!dotsEl) createBreathingDots();
    if (!sysIdEl) createSysId();
    if (!noiseEl) createCrtOverlays();
    if (!velocityEl) createVelocityMeter();
    if (!keysigEl) createKeysigDisplay();
    if (!waveformEl) createWaveform();
    if (!edgeLinesEl) createEdgeLines();
    if (!orbitEl) createOrbitRing();
    if (!freqLabelEl) createFreqLabel();
    if (!polycountEl) createPolycount();
    if (!tickerBars.length) createTickerBars();
    if (!constellationEl) createConstellation();

    // ═══ Y2K HUD: OPTIMIZED per-frame updates ═══
    // Strategy: batch reads, skip unchanged, reuse buffers, reduce DOM writes
    // frameBudgetOver > 10 → skip decorative elements to reclaim ms
    {
      const hueDeg = Math.round(currentKeyHue * 360) % 360;
      const isPlaying = keysPressed.size > 0 || midiPlaybackActive;
      const activeNotes = collectOrderedActiveNotes();
      const noteCount = activeNotes.length;
      const y2kFrame = Math.floor(now * 60);
      const isEvenFrame = (y2kFrame & 1) === 0;
      const isThrottled = frameBudgetOver > 10; // under pressure — skip decorative

      // ── Bracket frame — punchy scale burst + shake ──
      bracketFrameEl.style.opacity = Math.min(1.0, 0.25 + impactFlash * 0.60 + kickFlash * 0.20 + 0.06 * (0.5 + 0.5 * syncA));
      if (impactFlash > 0.25) {
        const jx = (Math.random() - 0.5) * (6 + kickFlash * 10);
        const jy = (Math.random() - 0.5) * (3 + kickFlash * 5);
        const s = 1.0 + impactFlash * 0.10 + kickFlash * 0.05;
        bracketFrameEl.style.transform = 'scale(' + s + ') translate(' + jx + 'px,' + jy + 'px)';
      } else {
        bracketFrameEl.style.transform = '';
      }
      // Color update only when hue changes (throttled)
      if (isEvenFrame) {
        const bc = 'hsla(' + hueDeg + ',45%,85%,0.7)';
        for (let i = 0; i < 4; i++) bracketFrameEl.children[i].style.borderColor = bc;
      }

      // ── Crosshairs — flash on kick (opacity only, no filter) ──
      crosshairEl.style.opacity = isPlaying ? Math.min(1.0, 0.35 + impactFlash * 0.55 + kickFlash * 0.25) : 0.10;

      // ── Scanline (throttled to even frames) ──
      if (isEvenFrame) scanlineEl.style.opacity = Math.min(1.0, 0.45 + impactFlash * 0.50 + kickFlash * 0.12);

      // ── Datastream (throttled to even frames) ──
      if (isEvenFrame) datastreamEl.style.opacity = Math.min(0.90, 0.25 + audioEnergy * 0.32 + impactFlash * 0.28 + kickFlash * 0.10);

      // ── Gradient corners (flash hard on beat) ──
      if (!isThrottled) gradientCornersEl.style.opacity = Math.min(0.50, 0.08 + impactFlash * 0.25 + kickFlash * 0.18 + audioEnergy * 0.10);
      if (!isThrottled && y2kFrame % 3 === 0) {
        gradientCornersEl.children[0].style.color = 'hsl(' + hueDeg + ',60%,72%)';
        gradientCornersEl.children[1].style.color = 'hsl(' + ((hueDeg + 180) % 360) + ',55%,66%)';
      }

      // ── Spectrum analyzer (throttled to even frames) ──
      if (isEvenFrame && specBars.length) {
        spectrumEl.style.opacity = Math.min(1.0, 0.40 + audioEnergy * 0.42 + impactFlash * 0.30 + kickFlash * 0.15);
        const bl = bassLevel, ml = midLevel, tl = trebleLevel;
        const beatBoost = impactFlash * 28 + kickFlash * 18;
        const bins0 = bl, bins1 = (bl + ml) * 0.5, bins2 = ml, bins3 = (ml + tl) * 0.5, bins4 = tl;
        specBars[0].style.height = Math.max(3, (bins0 * 62 + beatBoost) | 0) + 'px';
        specBars[1].style.height = Math.max(3, (bins1 * 62 + beatBoost * 0.8) | 0) + 'px';
        specBars[2].style.height = Math.max(3, (bins2 * 62 + beatBoost * 0.6) | 0) + 'px';
        specBars[3].style.height = Math.max(3, (bins3 * 62 + beatBoost * 0.8) | 0) + 'px';
        specBars[4].style.height = Math.max(3, (bins4 * 62 + beatBoost) | 0) + 'px';
        // Color update throttled to every 4th frame
        if (y2kFrame % 4 === 0) {
          for (let i = 0; i < 5; i++) {
            specBars[i].style.background = 'hsla(' + ((hueDeg + i * 30) % 360) + ',65%,72%,0.85)';
          }
        }
      }

      // ── Chord detection (only on note change — already cached via lastChordName) ──
      {
        const chord = detectChord(activeNotes);
        const chordName = chord ? chord.name : '';
        if (chordName !== lastChordName) {
          lastChordName = chordName;
          if (chord) {
            chordEl.style.opacity = '1';
            chordEl.childNodes[0].textContent = chord.name;
            chordSubEl.textContent = chord.sub;
            chordEl.style.color = 'hsla(' + hueDeg + ',42%,92%,0.8)';
          } else {
            chordEl.style.opacity = '0';
          }
        }
      }

      // ── Arc ring (2 writes: dashoffset + opacity) ──
      {
        const circ = 119.38; // precomputed 2 * PI * 19
        let pct, label;
        if (typeof midiPlaybackProgress === 'number' && midiPlaybackActive) {
          pct = midiPlaybackProgress;
          label = ((pct * 100) | 0) + '%';
        } else {
          pct = 0.5 + 0.5 * syncA;
          label = 'SYNC';
        }
        arcFgEl.style.strokeDashoffset = (circ * (1 - pct)).toFixed(1);
        arcEl.style.opacity = Math.min(0.95, 0.42 + impactFlash * 0.40 + kickFlash * 0.12);
        // Text + color update throttled
        if (isEvenFrame) {
          arcLabelEl.textContent = label;
          arcFgEl.style.stroke = 'hsla(' + hueDeg + ',55%,78%,0.7)';
        }
      }

      // ── Breathing dots (skip under pressure) ──
      if (!isThrottled) dotsEl.style.opacity = Math.min(0.9, 0.25 + audioEnergy * 0.40 + impactFlash * 0.20 + kickFlash * 0.08);

      // ── System ID (chromatic glitch on beat, throttled) ──
      if (isEvenFrame) {
        sysIdEl.style.opacity = Math.min(1.0, isPlaying ? 0.45 + impactFlash * 0.40 + kickFlash * 0.15 : 0.65);
        if (impactFlash > 0.35) {
          const r = Math.random() * (4 + kickFlash * 8);
          sysIdEl.style.textShadow = (2 + r) + 'px 0 rgba(255,50,80,' + (0.35 + kickFlash * 0.3) + '),' + (-2 - r) + 'px 0 rgba(50,200,255,' + (0.35 + kickFlash * 0.3) + '),0 0 ' + (10 + impactFlash * 14) + 'px rgba(120,180,255,0.25)';
        } else if (impactFlash < 0.05) {
          sysIdEl.style.textShadow = '';
        }
      }

      // ── CRT Noise (throttled) ──
      if (isEvenFrame) {
        noiseEl.style.opacity = 0.05 + impactFlash * 0.10 + kickFlash * 0.05;
      }

      // ── Glitch bar (on strong beat only) ──
      glitchBarTimer -= 0.016;
      if (impactFlash > 0.35 && glitchBarTimer <= 0 && Math.random() < 0.50) {
        const gH = 2 + Math.random() * 14 + kickFlash * 10;
        const gO = 0.10 + Math.random() * 0.20 + kickFlash * 0.15;
        glitchBarEl.style.cssText = 'position:fixed;left:0;right:0;z-index:1392;pointer-events:none;mix-blend-mode:screen;background:rgba(255,255,255,' + (0.08 + kickFlash * 0.08) + ');top:' + (Math.random() * 80 + 10) + '%;height:' + gH + 'px;opacity:' + gO + ';transform:translateX(' + ((Math.random() - 0.5) * (10 + kickFlash * 16)) + 'px)';
        glitchBarTimer = 0.05 + Math.random() * 0.08;
      } else if (glitchBarTimer <= 0 && glitchBarEl.style.height !== '0px') {
        glitchBarEl.style.opacity = '0';
        glitchBarEl.style.height = '0';
      }

      // ── Velocity meter (height + opacity, beat-reactive) ──
      {
        let avgVel = 0;
        if (noteCount > 0) {
          let sum = 0;
          for (let i = 0; i < noteCount; i++) sum += (activeNotes[i].velocity || 0.7);
          avgVel = sum / noteCount;
        }
        const velBoost = Math.min(1.0, avgVel + impactFlash * 0.15 + kickFlash * 0.10);
        velocityFillEl.style.height = ((velBoost * 100) | 0) + '%';
        velocityEl.style.opacity = isPlaying ? 0.55 + impactFlash * 0.35 + kickFlash * 0.10 : 0.15;
        // Gradient color throttled to every 6th frame (expensive to parse)
        if (y2kFrame % 6 === 0) {
          velocityFillEl.style.background = 'linear-gradient(0deg,hsla(' + hueDeg + ',60%,55%,0.6),hsla(' + ((hueDeg + 40) % 360) + ',70%,75%,0.8))';
        }
      }

      // ── Key signature (event-driven, updates only on note change) ──
      {
        let rootDisplay = '';
        let subDisplay = '';
        if (noteCount > 0) {
          rootDisplay = NOTE_NAMES[activeNotes[0].midi % 12];
          subDisplay = 'OCT ' + (Math.floor(activeNotes[0].midi / 12) - 1);
        }
        if (rootDisplay !== lastKeysigName) {
          lastKeysigName = rootDisplay;
          if (rootDisplay) {
            keysigEl.style.opacity = '0.7';
            keysigEl.childNodes[0].textContent = rootDisplay;
            keysigSubEl.textContent = subDisplay;
          } else {
            keysigEl.style.opacity = '0';
          }
        }
      }

      // ── Waveform (throttled to every 2nd frame, skip under pressure) ──
      if (isEvenFrame && !isThrottled && waveformCtx && analyser) {
        var bufLen = analyser.fftSize;
        if (!waveformCtx._buf || waveformCtx._buf.length !== bufLen) {
          waveformCtx._buf = new Uint8Array(bufLen);
        }
        analyser.getByteTimeDomainData(waveformCtx._buf);
        waveformCtx.clearRect(0, 0, 80, 140);
        waveformCtx.strokeStyle = 'hsla(' + hueDeg + ',60%,82%,' + (0.5 + impactFlash * 0.45 + kickFlash * 0.20) + ')';
        waveformCtx.lineWidth = 1.5 + kickFlash * 4;
        waveformCtx.beginPath();
        var step = Math.max(2, (bufLen / 70) | 0);
        for (var wi = 0; wi < 70; wi++) {
          var v = waveformCtx._buf[wi * step] * 0.0078125 - 1.0; // /128.0
          var x = v * 32 + 40;
          if (wi === 0) waveformCtx.moveTo(x, 0);
          else waveformCtx.lineTo(x, wi * 2);
        }
        waveformCtx.stroke();
        waveformEl.style.opacity = isPlaying ? Math.min(1.0, 0.40 + audioEnergy * 0.35 + impactFlash * 0.30 + kickFlash * 0.15) : 0.12;
      }

      // ── Edge lines (throttled to even frames) ──
      if (isEvenFrame) edgeLinesEl.style.opacity = Math.min(0.85, 0.20 + impactFlash * 0.45 + kickFlash * 0.18 + audioEnergy * 0.12);

      // ── Orbit ring (throttled to even frames, cached refs) ──
      if (isEvenFrame) orbitEl.style.opacity = Math.min(0.80, 0.25 + audioEnergy * 0.30 + impactFlash * 0.25 + kickFlash * 0.12);
      if (y2kFrame % 8 === 0 && orbitRingRef) {
        orbitRingRef.style.stroke = 'hsla(' + hueDeg + ',35%,70%,0.15)';
        var dotFill = 'hsla(' + hueDeg + ',55%,80%,0.65)';
        for (var od = 0; od < orbitDotRefs.length; od++) orbitDotRefs[od].style.fill = dotFill;
      }

      // ── Frequency label (event-driven, only on note change) ──
      if (noteCount > 0) {
        var hz = midiToFreq(activeNotes[0].midi);
        if (Math.abs(hz - lastFreqHz) > 0.5) {
          lastFreqHz = hz;
          freqHzEl.textContent = hz.toFixed(1);
        }
        freqLabelEl.style.opacity = '0.55';
      } else if (freqLabelEl.style.opacity !== '0') {
        freqLabelEl.style.opacity = '0';
      }

      // ── Polyphony count (beat-reactive) ──
      if (noteCount > 0) {
        polycountEl.childNodes[0].textContent = noteCount;
        polycountEl.style.opacity = Math.min(0.95, 0.45 + impactFlash * 0.35 + kickFlash * 0.12);
      } else if (polycountEl.style.opacity !== '0') {
        polycountEl.style.opacity = '0';
      }

      // ── Ticker bars (throttled, skip under pressure) ──
      if (isEvenFrame && !isThrottled && tickerBars.length) {
        var tBands = [bassLevel, bassLevel * 0.7 + midLevel * 0.3, midLevel, midLevel * 0.5 + trebleLevel * 0.5, trebleLevel, trebleLevel * 0.8];
        var tkBeat = impactFlash * 18 + kickFlash * 12;
        for (var ti = 0; ti < 6; ti++) {
          var tkLv = tBands[ti];
          tickerBars[ti].style.width = (6 + tkLv * 30 + tkBeat | 0) + 'px';
          tickerBars[ti].style.opacity = Math.min(0.85, 0.18 + tkLv * 0.48 + impactFlash * 0.18);
        }
        // Color update even less frequently
        if (y2kFrame % 12 === 0) {
          for (var tc = 0; tc < 6; tc++) {
            tickerBars[tc].style.background = 'hsla(' + ((hueDeg + tc * 25) % 360) + ',50%,72%,0.4)';
          }
        }
      }

      // ── Constellation (every 2nd frame; every 4th when throttled) ──
      if ((isThrottled ? (y2kFrame & 3) === 0 : isEvenFrame) && constellationCtx) {
        if (kickFlash > 0.25 && constellationShockwave <= 0) constellationShockwave = 1;
        drawConstellation(hueDeg, activeNotes, audioEnergy, impactFlash, kickFlash, now);
        constellationEl.style.opacity = isPlaying ? Math.min(1.0, 0.70 + impactFlash * 0.30 + kickFlash * 0.15) : 0.4;
        if (constellationShockwave > 0) constellationShockwave += 4;
        if (constellationShockwave > 80) constellationShockwave = 0;
      }

      // ── Full-screen beat flash (smooth lerp fade) ──
      if (!beatFlashEl) createBeatFlash();
      {
        const target = kickFlash > 0.3 ? kickFlash * 0.55 + impactFlash * 0.20 : 0;
        // Smooth attack (fast) and release (gradual)
        if (target > beatFlashLevel) {
          beatFlashLevel += (target - beatFlashLevel) * 0.6;
        } else {
          beatFlashLevel *= 0.88; // smooth exponential decay
          if (beatFlashLevel < 0.005) beatFlashLevel = 0;
        }
        beatFlashEl.style.opacity = beatFlashLevel;
      }
    }

    try {
      if (postQuad && rtScene) {
        const pu = postQuad.material.uniforms;
        pu.tDiffuse.value = rtScene.texture;
        pu.time.value = now;
        pu.kaleidoFolds.value = currentKaleidoFolds;
        pu.kaleidoRotation.value = kaleidoRotation;
        pu.kaleidoMix.value = kaleidoMix;
        pu.chromaticOffset.value = Math.min(0.018, activeProfile.ca + touchIntensity * 0.0008 + dblFlash * 0.0012 + bassHit * 0.0015 + micVisual * 0.001 + styleLsd * 0.0011 + styleCrossover * 0.0007 + kickFlash * 0.005 + impactFlash * 0.003);
        const focusBreath = keysPressed.size === 0 ? 0.04 * Math.sin(now * 0.1) : 0;
        const idleBreath = idleIntensity * (0.06 * Math.sin(now * 0.15) + 0.04);
        pu.textureLayerMix.value = idleIntensity * 0.72;
        pu.bloomStrength.value = Math.min(3.8, (activeProfile.bloom + dblFlash * 1.0 + touchIntensity * 0.4 + audioBoost * 0.8 + micVisual * 0.6 + focusBreath + idleBreath + gestureBloom + 0.05 * syncA + impactFlash * 0.50 + kickFlash * 0.30 + styleMuseum * 0.12 + styleCrossover * 0.10) * 0.7);
        pu.spiralAmt.value = Math.min(0.2, curSpiral * 0.11 + touchIntensity * 0.012 + trebleLevel * 0.016 + gestureSpiral * 0.08 + 0.004 * syncB + styleLsd * 0.01);
        pu.flowAmt.value = Math.min(1.24, curFlow + touchIntensity * 0.07 + 0.03 * syncA + styleMuseum * 0.1);
        pu.pulseAmt.value = Math.min(1.3, curPulse + midLevel * 0.12 + 0.022 * syncA + styleCrossover * 0.09 + kickFlash * 0.12);
        pu.shearAmt.value = Math.min(1.32, curShear + touchIntensity * 0.07 + 0.02 * syncB + styleMuseum * 0.06);
        pu.waveAmt.value = Math.min(1.32, curWave + trebleLevel * 0.14 + 0.026 * syncB + styleLsd * 0.12);
        pu.glitchAmt.value = Math.min(0.95, curGlitch + dblFlash * 0.26 + bassHit * 0.18 + gestureGlitch * 0.88 + styleLsd * 0.14 + styleCrossover * 0.08 + audioEnergy * 0.06 + touchIntensity * 0.04 + kickFlash * 0.42 + impactFlash * 0.10);
        pu.mirrorXY.value.set(curMirrorX, curMirrorY);
        pu.warpAmt.value = Math.min(1.2, curWarp + touchIntensity * 0.1 + midLevel * 0.12 + micVisual * 0.18 + gestureWarp * 0.82 + 0.02 * syncA + styleCrossover * 0.12 + styleLsd * 0.08 + kickFlash * 0.10);
        pu.contrastBoost.value = Math.min(2.8, Math.max(1.22, curContrast + 0.10 + dblFlash * 0.22 + impactFlash * 0.35 + kickFlash * 0.18 + bassHit * 0.16 + styleMuseum * 0.10 + styleCrossover * 0.10 + audioBoost * 0.06));
        pu.headLook.value.set(headOffset_g, headOffsetY);
        pu.themeHue.value = currentKeyHue;
        pu.prismAmt.value = Math.min(1.2, curPrism + styleCrossover * 0.16 + styleLsd * 0.08);
        pu.audioLevel.value = contourAudioLevel;
        pu.bioAmt.value = Math.min(1.0, curBio + styleCrossover * 0.12 + micVisual * 0.08);
        pu.impactFlash.value = Math.min(1.0, impactFlash + dblFlash * 0.12 + bassHit * 0.08 + kickFlash * 0.08);
        const pixelMixTarget = Math.min(1.0, PIXEL_MODE_VALUES[pixelModeIdx] * 0.9 + styleLsd * 0.07 + audioEnergy * 0.04);
        const analogMixTarget = Math.min(1.0, ANALOG_MODE_VALUES[analogModeIdx] * 0.92 + styleMuseum * 0.06 + midLevel * 0.04 + micVisual * 0.04);
        pu.pixelateMix.value += (pixelMixTarget - pu.pixelateMix.value) * 0.22;
        pu.analogMix.value += (analogMixTarget - pu.analogMix.value) * 0.22;
        pu.subpixelMix.value = Math.min(1.0, 0.3 + pu.pixelateMix.value * 0.56 + pu.analogMix.value * 0.24);
        pu.jitterMix.value = Math.min(1.0, 0.2 + pu.analogMix.value * 0.5 + curGlitch * 0.24 + styleLsd * 0.18 + touchIntensity * 0.08);
        // Zoom blur: pulse hard on beat, gentle idle — air-rush feel across entire scene
        pu.zoomBlurAmt.value = Math.min(0.22, impactFlash * 0.16 + syncA * 0.018 + bassHit * 0.06 + kickFlash * 0.05);
        // Lens DOF: always slightly soft at edges, stronger during impacts
        pu.lensBlurAmt.value = 1.8 + impactFlash * 2.2 + syncA * 0.3;
        // Lens flare: ghosts appear from bright beats
        pu.lensFlareAmt.value = Math.min(0.8, 0.08 + impactFlash * 0.35 + syncA * 0.06 + bassHit * 0.12);
        // Cinematic: gate weave, anamorphic streak, light leak, letterbox
        pu.gateWeaveAmt.value = 0.3 + curGlitch * 0.4 + impactFlash * 0.2;
        pu.anamorphicAmt.value = Math.min(0.6, impactFlash * 0.45 + bassHit * 0.12 + pu.bloomStrength.value * 0.06);
        pu.lightLeakAmt.value = Math.min(0.5, kickFlash * 0.45 + audioEnergy * 0.1);
        pu.letterboxAmt.value = 1.0;
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(postScene, postCamera);
        _doRollOverlay(now);
      } else {
        renderer.render(scene, camera);
        _doRollOverlay(now);
      }
    } catch (e) {
      console.warn('Render error:', e && e.message ? e.message : e);
    }

    // ── Frame budget monitor: auto-throttle HUD when over 18ms ──
    var _frameMs = performance.now() - _frameStart;
    if (_frameMs > 18) frameBudgetOver = Math.min(frameBudgetOver + 2, 30);
    else frameBudgetOver = Math.max(frameBudgetOver - 1, 0);
  }
  animate();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGPGPU);
  else initGPGPU();
})();
