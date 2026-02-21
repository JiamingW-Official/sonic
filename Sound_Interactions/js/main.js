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
    const track = Math.max(0, trackIndex | 0);
    const trackSeed = (track * 0.131 + 0.17) % 1;
    const lane = ((Math.round(midi) % 12) + 12) % 12;
    const pitchBand = lane < 4 ? 0 : (lane < 8 ? 1 : 2);
    const bandShift = pitchBand === 0 ? -0.07 : (pitchBand === 1 ? 0.0 : 0.08);
    const vel = clamp01(velocity != null ? velocity : 0.8);
    const h = (trackSeed + activeHue * 0.22 + bandShift + Math.sin((lane + track) * 0.7) * 0.014 + 1) % 1;
    const s = pitchBand === 1 ? 0.78 : 0.84;
    const l = 0.44 + vel * 0.3 + (pitchBand === 2 ? 0.06 : 0);
    outColor.setHSL(h, s, Math.min(0.9, l));
    return outColor;
  }

  function updateRoll3DLayer(now, syncA, syncB, impactFlash, activeHue) {
    if (!roll3DGroup || !roll3DSurfaces || !roll3DGlowSurfaces || !roll3DLines || !roll3DPoints) return;
    const preview = Array.isArray(midiRollPreview) ? midiRollPreview : [];
    const activeOrdered = collectOrderedActiveNotes();
    const live = Array.isArray(displayedMidiNotes) ? displayedMidiNotes : [];
    rollImpulses = rollImpulses.filter((e) => (now - e.t) <= 2.6);
    rollDrumImpulses = rollDrumImpulses.filter((e) => (now - e.t) <= 2.2);

    const melodicPreview = [];
    const drumPreview = [];
    let midiMin = 42;
    let midiMax = 90;
    for (let i = 0; i < preview.length; i++) {
      const n = preview[i];
      if (n.isDrum) {
        drumPreview.push(n);
        continue;
      }
      melodicPreview.push(n);
      const m = n.midi | 0;
      if (m < midiMin) midiMin = m;
      if (m > midiMax) midiMax = m;
    }
    for (let i = 0; i < live.length; i++) {
      const m = live[i] | 0;
      if (m < midiMin) midiMin = m;
      if (m > midiMax) midiMax = m;
    }
    for (let i = 0; i < rollImpulses.length; i++) {
      const m = rollImpulses[i].midi | 0;
      if (m < midiMin) midiMin = m;
      if (m > midiMax) midiMax = m;
    }

    midiMin = Math.max(0, midiMin - 4);
    midiMax = Math.min(127, midiMax + 4);
    const span = Math.max(16, midiMax - midiMin + 1);
    const nearZ = 2.7;
    const farZ = -6.9;
    const depthSpan = nearZ - farZ;
    const windowSec = Math.max(7.2, 15.2 / Math.max(0.72, midiPlaybackSpeed));
    const yBase = -0.08;
    const WEB_SPOKES = 14;
    const WEB_RINGS = 10;
    const webRot = 0.06 * Math.sin(now * 0.17) + 0.03 * Math.sin(now * 0.11 + 1.2);
    const webNearRadius = 2.0;

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
    function noteLane(midi, trackIndex) {
      const m = Math.max(midiMin, Math.min(midiMax, midi));
      const laneNorm = ((m - midiMin + 0.5) / span) - 0.5;
      const pc = ((Math.round(m) % 12) + 12) % 12;
      const base = (laneNorm + 0.5) * (WEB_SPOKES - 2);
      const jitter = ((pc / 12) - 0.5) * 0.14 + ((trackIndex | 0) % 3) * 0.02;
      const leftSpoke = Math.max(0, Math.min(WEB_SPOKES - 1.001, base + jitter));
      const rightSpoke = leftSpoke + 1.0;
      const radiusScale = 0.52 + Math.abs(laneNorm) * 0.92 + (Math.floor(m / 12) % 3) * 0.05;
      return { leftSpoke, rightSpoke, centerSpoke: leftSpoke + 0.5, radiusScale, laneNorm };
    }
    function drumLane(idx) {
      const lane = Math.max(0, Math.min(11, idx | 0));
      return {
        spoke: lane / 12 * WEB_SPOKES + 0.15,
        radiusScale: 1.12 + (lane % 3) * 0.08
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
    function pushPoint(posArr, colArr, idxRef, x, y, z, r, g, b) {
      if ((idxRef.i + 1) * 3 > posArr.length) return false;
      const p = idxRef.i * 3;
      posArr[p] = x; posArr[p + 1] = y; posArr[p + 2] = z;
      colArr[p] = r; colArr[p + 1] = g; colArr[p + 2] = b;
      idxRef.i++;
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
    const pointV = { i: 0 };

    // Spider-web track: radial spokes + concentric rings in perspective.
    for (let s = 0; s < WEB_SPOKES; s++) {
      let prev = webPoint(s, 0, 1.0);
      for (let r = 1; r <= WEB_RINGS; r++) {
        const p = webPoint(s, r / WEB_RINGS, 1.0);
        if (!pushLine(roll3DLinePosArray, lineV, prev.x, prev.y, prev.z, p.x, p.y, p.z)) break;
        prev = p;
      }
    }
    for (let r = 1; r <= WEB_RINGS; r++) {
      for (let s = 0; s < WEB_SPOKES; s++) {
        const a = webPoint(s, r / WEB_RINGS, 1.0);
        const b = webPoint((s + 1) % WEB_SPOKES, r / WEB_RINGS, 1.0);
        if (!pushLine(roll3DLinePosArray, lineV, a.x, a.y, a.z, b.x, b.y, b.z)) break;
      }
    }

    const previewLimit = 96;
    let melodicCount = 0;
    for (let i = 0; i < melodicPreview.length && melodicCount < previewLimit; i++) {
      const n = melodicPreview[i];
      const ahead = n.ahead != null ? n.ahead : ((n.time || 0) - midiPlaybackPosition);
      const dur = Math.max(0.06, Math.min(6.4, n.duration || 0.15));
      const durVisual = Math.max(0.1, Math.min(7.2, dur * 1.44));
      if (ahead > windowSec + 0.95 || (ahead + durVisual) < -0.45) continue;
      melodicCount++;

      const lane = noteLane(n.midi, n.trackIndex | 0);
      const headN = depthNormAtAhead(Math.max(0, ahead));
      const tailN = depthNormAtAhead(Math.max(0, ahead + durVisual));
      const pHeadL = webPoint(lane.leftSpoke, headN, lane.radiusScale);
      const pHeadR = webPoint(lane.rightSpoke, headN, lane.radiusScale);
      const pTailL = webPoint(lane.leftSpoke, tailN, lane.radiusScale);
      const pTailR = webPoint(lane.rightSpoke, tailN, lane.radiusScale);
      const headCx = (pHeadL.x + pHeadR.x) * 0.5;
      const headCy = (pHeadL.y + pHeadR.y) * 0.5;
      const headCz = (pHeadL.z + pHeadR.z) * 0.5;
      const tailCx = (pTailL.x + pTailR.x) * 0.5;
      const tailCy = (pTailL.y + pTailR.y) * 0.5;
      const tailCz = (pTailL.z + pTailR.z) * 0.5;

      const vel = clamp01(n.velocity != null ? n.velocity : 0.8);
      const depthNear = Math.max(pHeadL.near, pHeadR.near);
      rollTrackPitchColor(colTmp, n.trackIndex, n.midi, vel, activeHue);
      colTmp.setRGB(
        Math.min(1, colTmp.r + 0.24 + depthNear * 0.26),
        Math.min(1, colTmp.g + 0.24 + depthNear * 0.26),
        Math.min(1, colTmp.b + 0.26 + depthNear * 0.28)
      );
      const noteR = colTmp.r;
      const noteG = colTmp.g;
      const noteB = colTmp.b;

      // Box edges are explicitly on the two rails.
      pushStrongLine(roll3DLinePosArray, lineV, pTailL.x, pTailL.y, pTailL.z, pHeadL.x, pHeadL.y, pHeadL.z);
      pushStrongLine(roll3DLinePosArray, lineV, pTailR.x, pTailR.y, pTailR.z, pHeadR.x, pHeadR.y, pHeadR.z);
      pushStrongLine(roll3DLinePosArray, lineV, pTailL.x, pTailL.y, pTailL.z, pTailR.x, pTailR.y, pTailR.z);
      pushStrongLine(roll3DLinePosArray, lineV, pHeadL.x, pHeadL.y, pHeadL.z, pHeadR.x, pHeadR.y, pHeadR.z);

      // One clear MIDI trajectory line per note (no inner trend/wobble).
      pushStrongLine(roll3DLinePosArray, lineV, tailCx, tailCy, tailCz, headCx, headCy, headCz);

      const coreSteps = 6;
      for (let t = 0; t <= coreSteps; t++) {
        const tt = t / coreSteps;
        const px = tailCx + (headCx - tailCx) * tt;
        const py = tailCy + (headCy - tailCy) * tt;
        const pz = tailCz + (headCz - tailCz) * tt;
        const glow = 0.2 + Math.sin(tt * Math.PI) * 0.4;
        pushPoint(
          roll3DPointPosArray, roll3DPointColArray, pointV,
          px, py, pz,
          Math.min(1, noteR + glow),
          Math.min(1, noteG + glow),
          Math.min(1, noteB + glow + 0.02)
        );
      }
    }

    // Drum notes on outer web lanes, still far -> near.
    for (let i = 0; i < drumPreview.length && instCount < ROLL3D_MAX_INSTANCES; i++) {
      const n = drumPreview[i];
      const ahead = n.ahead != null ? n.ahead : ((n.time || 0) - midiPlaybackPosition);
      const dur = Math.max(0.03, Math.min(1.2, n.duration || 0.09));
      if (ahead > windowSec + 0.5 || (ahead + dur) < -0.2) continue;
      const lane = drumLane(n.drumClass != null ? n.drumClass : drumTypeToVisualIndex(n.drumType));
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
    }

    // Sparks / impulses
    for (let i = 0; i < rollImpulses.length; i++) {
      const ev = rollImpulses[i];
      const age = now - ev.t;
      if (age < 0 || age > 2.6) continue;
      const lane = noteLane(ev.midi, ev.src === 'M' ? 2 : 0);
      const core = webPoint(lane.centerSpoke, depthNormAtAhead(Math.max(0, (1.0 - age / 2.6) * windowSec * 0.8)), lane.radiusScale);
      const rr = 0.012 + age * 0.055;
      rollTrackPitchColor(colTmp, ev.src === 'D' ? 17 : (ev.src === 'M' ? 9 : 2), ev.midi, ev.velocity, activeHue);
      const count = 6 + Math.floor(ev.velocity * 6);
      for (let k = 0; k < count; k++) {
        const ang = (k / count) * TAU + age * 3.1;
        if (!pushPoint(
          roll3DPointPosArray, roll3DPointColArray, pointV,
          core.x + Math.cos(ang) * rr,
          core.y + Math.sin(ang * 1.4) * rr * 0.7,
          core.z - (k / count) * (0.1 + age * 0.16),
          Math.min(1, colTmp.r + 0.2),
          Math.min(1, colTmp.g + 0.2),
          Math.min(1, colTmp.b + 0.22)
        )) break;
      }
    }
    for (let i = 0; i < rollDrumImpulses.length; i++) {
      const ev = rollDrumImpulses[i];
      const age = now - ev.t;
      if (age < 0 || age > 2.2) continue;
      const lane = drumLane(ev.idx);
      const core = webPoint(lane.spoke, depthNormAtAhead(Math.max(0, (1.0 - age / 2.2) * windowSec * 0.72)), lane.radiusScale);
      const count = 5 + Math.floor(ev.velocity * 5);
      const rr = 0.012 + age * 0.05;
      colTmp.setHSL((activeHue + 0.12 + ev.idx * 0.03) % 1, 0.9, 0.72);
      for (let k = 0; k < count; k++) {
        const ang = (k / count) * TAU + age * 3.8;
        if (!pushPoint(
          roll3DPointPosArray, roll3DPointColArray, pointV,
          core.x + Math.cos(ang) * rr,
          core.y + Math.sin(ang * 1.4) * rr * 0.62,
          core.z - (k / count) * (0.1 + age * 0.14),
          Math.min(1, colTmp.r + 0.18),
          Math.min(1, colTmp.g + 0.18),
          Math.min(1, colTmp.b + 0.2)
        )) break;
      }
    }

    // Depth dust on web rings.
    for (let r = 2; r <= WEB_RINGS; r += 3) {
      for (let s = 0; s < WEB_SPOKES; s += 3) {
        const p = webPoint(s + 0.2 * Math.sin(now * 0.3 + s), r / WEB_RINGS, 0.92);
        const dim = 0.2 + p.near * 0.24;
        if (!pushPoint(
          roll3DPointPosArray, roll3DPointColArray, pointV,
          p.x, p.y, p.z,
          Math.min(1, 0.54 + dim), Math.min(1, 0.62 + dim), Math.min(1, 0.8 + dim)
        )) break;
      }
    }

    roll3DSurfaces.count = instCount;
    roll3DSurfaces.instanceMatrix.needsUpdate = true;
    roll3DGlowSurfaces.count = instCount;
    roll3DGlowSurfaces.instanceMatrix.needsUpdate = true;
    if (roll3DSurfaces.instanceColor) roll3DSurfaces.instanceColor.needsUpdate = true;
    if (roll3DGlowSurfaces.instanceColor) roll3DGlowSurfaces.instanceColor.needsUpdate = true;

    roll3DLines.geometry.setDrawRange(0, Math.floor(lineV.i / 3));
    roll3DLinePosAttr.needsUpdate = true;
    roll3DPoints.geometry.setDrawRange(0, pointV.i);
    roll3DPointPosAttr.needsUpdate = true;
    roll3DPointColAttr.needsUpdate = true;

    roll3DGroup.rotation.x = -0.015 + 0.005 * Math.sin(now * 0.2 + 0.4) + impactFlash * 0.006;
    roll3DGroup.rotation.y = 0.008 * Math.sin(now * 0.17 + 0.6);
    roll3DGroup.rotation.z = 0.003 * Math.sin(now * 0.24 + 1.1);
    roll3DGroup.position.set(0, -0.02 + 0.004 * Math.sin(now * 0.23), 0.5 + 0.008 * Math.sin(now * 0.19 + 0.9));
    roll3DSurfaces.material.opacity = Math.min(1.0, 0.84 + 0.12 * (0.5 + 0.5 * syncA) + impactFlash * 0.12);
    roll3DGlowSurfaces.material.opacity = Math.min(0.92, 0.28 + 0.1 * (0.5 + 0.5 * syncB) + impactFlash * 0.14);
    roll3DLines.material.opacity = Math.min(0.74, 0.28 + 0.08 * (0.5 + 0.5 * syncB) + impactFlash * 0.06);
    roll3DPoints.material.opacity = Math.min(0.98, 0.54 + 0.14 * (0.5 + 0.5 * syncA) + impactFlash * 0.1);
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
  const VERT_COL_POINTS = 720;
  const CENTRAL_COL_POINTS = 1000;
  const FLOATING_ORB_COUNT = 12;
  const FLOATING_POINTS_PER_ORB = 200;
  const BURST_RING_POINTS = 400;
  const PLASMA_POINTS = 1200;
  const MATRIX_SURF_POINTS = 5600;
  const PRISM_SPOKE_POINTS = 2400;
  const ROLL3D_MAX_INSTANCES = 320;
  const ROLL3D_MAX_LINES = 6400;
  const ROLL3D_MAX_POINTS = 12000;
  let burstRingTime = -1;
  let tunnelParticles, centralColumnParticles, radiatingParticles, speedLineParticles;
  let burstRingParticles, plasmaParticles, floatingParticleClouds, matrixSurfaceParticles, prismSpokeParticles, bgPlane;
  let roll3DGroup, roll3DFloor, roll3DSurfaces, roll3DGlowSurfaces, roll3DLines, roll3DPoints;
  let roll3DLinePosAttr, roll3DPointPosAttr, roll3DPointColAttr;
  let roll3DLinePosArray, roll3DPointPosArray, roll3DPointColArray;
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
  let composer, postScene, postCamera, postQuad, rtScene;
  const particleMatOpts = { transparent: true, sizeAttenuation: true, vertexColors: false, blending: THREE.AdditiveBlending, depthWrite: false };
  let noteRepeatOverlayEl = null;
  let noteRepeatRowEls = [];
  let noteRepeatSignature = '';
  let noteRepeatStyleEl = null;
  let lastKickImpact = -10;
  let lastDrumMinorImpact = -10;

  const velocityShader = `
    uniform float time;
    uniform vec3 attractor;
    uniform float attractorStrength;
    uniform float attractorCol;
    uniform float attractorRow;
    void main() {
      vec2 uv = gl_FragCoord.xy / resolution.xy;
      vec4 posData = texture2D( texturePosition, uv );
      vec4 velData = texture2D( textureVelocity, uv );
      vec3 pos = posData.xyz;
      vec3 vel = velData.xyz;
      float t = time * 0.5;
      float keyPhase = attractorCol * 0.5;
      float rowBias = (attractorRow - 1.0) * 0.01;
      vec3 curl;
      curl.x = sin(pos.y * 1.6 + t) * 0.006 + cos(pos.z * 2.0 + t * 0.8) * 0.004;
      curl.y = sin(pos.z * 1.6 + t * 1.1 + keyPhase) * 0.006 + cos(pos.x * 2.0 + t * 0.7) * 0.004 + rowBias;
      curl.z = sin(pos.x * 1.6 + t * 0.9 - keyPhase * 0.3) * 0.006 + cos(pos.y * 2.0 + t * 0.6) * 0.004;
      vec3 toAttractor = attractor - pos;
      float dist = length(toAttractor) + 0.02;
      float falloff = 1.0 / (dist * dist + 0.15);
      vec3 force = normalize(toAttractor) * attractorStrength * falloff * 0.14;
      vel = vel * 0.97 + curl + force;
      vel = clamp(vel, -0.07, 0.07);
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
          float f=0.0;
          float a=0.5;
          for(int i=0;i<5;i++){
            f+=a*noise(p);
            p=p*2.03+vec2(11.3,6.7);
            a*=0.5;
          }
          return f;
        }
        mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }
        vec2 voronoi(vec2 uv){
          vec2 i=floor(uv);
          vec2 f=fract(uv);
          float d1=10.0;
          float d2=10.0;
          for(float y=-1.0;y<=1.0;y+=1.0){
            for(float x=-1.0;x<=1.0;x+=1.0){
              vec2 g=vec2(x,y);
              vec2 o=hash2(i+g);
              vec2 p=g+0.5+0.35*sin(o*6.2831+time*0.18)-f;
              float d=dot(p,p);
              if(d<d1){ d2=d1; d1=d; } else if(d<d2){ d2=d; }
            }
          }
          return vec2(sqrt(d1),sqrt(max(0.0,d2-d1)));
        }
        vec3 hsl(float h,float s,float l){ vec3 k=vec3(1.0,2.0/3.0,1.0/3.0); vec3 p=clamp(abs(fract(vec3(h)+k)*6.0-3.0)-1.0,0.0,1.0); return l*mix(vec3(1.0),p,s); }
        void main(){
          vec2 uv=vUv;
          vec2 c=uv-0.5;
          float r=length(c);
          float a=atan(c.y,c.x);
          float syncA=sin(time*0.45);
          float syncB=sin(time*0.38+1.0);
          float breathe=0.5+0.5*syncA;
          float lvl=clamp(audioLevel,0.0,1.0);

          vec2 pA=rot(0.14*syncB)*(c*3.0)+vec2(time*0.06,-time*0.045);
          vec2 pB=rot(-0.28+0.08*syncA)*(c*5.4)+vec2(-time*0.05,time*0.04);
          float nA=fbm(pA);
          float nB=fbm(pB);
          float field=(nA*0.78+nB*0.56)+(0.26+0.18*lvl)*sin(a*4.0+time*0.22)+r*1.35;
          float contourA=1.0-smoothstep(0.0,0.03,abs(fract(field*(9.0+lvl*12.0))-0.5));
          float contourB=1.0-smoothstep(0.0,0.02,abs(fract(field*(5.2+lvl*7.5)+0.25)-0.5));
          float contour=contourA*0.64+contourB*0.42;

          vec2 v=voronoi(uv*vec2(10.0,6.2)+vec2(time*0.06,-time*0.05));
          float shardEdge=1.0-smoothstep(0.01,0.045,v.y);
          float shardFill=1.0-smoothstep(0.1,0.34,v.x);

          vec2 mUv=rot(0.08*syncA)*(c*vec2(74.0,56.0))+vec2(time*0.26,-time*0.21);
          float matrixA=1.0-smoothstep(0.0,0.022,abs(fract(mUv.x)-0.5));
          float matrixB=1.0-smoothstep(0.0,0.022,abs(fract(mUv.y)-0.5));
          float matrix=(matrixA*0.7+matrixB*0.5);

          float outerBand=smoothstep(0.24,0.92,r)*(1.0-smoothstep(0.9,1.2,r));
          float centerVoid=1.0-smoothstep(0.0,0.22,r);
          float spokes=pow(max(0.0,cos(a*(8.0+lvl*6.0)+time*0.4+sin(r*18.0-time*0.8))),10.0);
          float ringA=exp(-pow((r-(0.33+0.03*syncB))*8.8,2.0));
          float ringB=exp(-pow((r-(0.56+0.04*syncA))*9.6,2.0));

          vec3 deep=mix(vec3(0.005,0.008,0.02),vec3(0.015,0.014,0.032),breathe);
          vec3 tintA=hsl(activeHue+0.02,0.76,0.17);
          vec3 tintB=hsl(activeHue+0.56,0.58,0.16);
          vec3 tintC=hsl(activeHue+0.28,0.52,0.22);
          vec3 neb=tintA*(0.22+0.5*nA)+tintB*(0.18+0.44*nB);
          vec3 contourCol=mix(tintA,tintB,0.45+0.25*sin(time*0.18))*contour*outerBand*(0.05+0.08*lvl);
          vec3 matrixCol=tintC*matrix*outerBand*(0.018+0.03*lvl);
          vec3 shardCol=mix(vec3(0.8,0.92,1.0),tintB,0.56)*(shardEdge*0.78+shardFill*0.18)*outerBand*(0.015+0.038*lvl);
          vec3 ringCol=mix(tintA,tintC,0.5+0.5*syncB)*(ringA*0.24+ringB*0.18)*(0.4+0.6*lvl);
          vec3 spokeCol=tintC*spokes*outerBand*(0.018+0.05*lvl);

          vec2 edgeCell=floor((uv-0.5)*vec2(92.0,76.0)+floor(time*0.7));
          float sparkHash=hash(edgeCell);
          float spark=step(0.972,sparkHash)*(0.5+0.5*sin(time*0.9+sparkHash*20.0+r*32.0));
          vec3 sparkCol=mix(vec3(0.86,0.95,1.0),tintA,0.42)*spark*outerBand*0.18;

          vec3 col=deep+neb*0.44+contourCol+matrixCol+shardCol+ringCol+spokeCol+sparkCol;
          col=mix(col,deep+neb*0.24+ringCol*0.3,centerVoid*0.86);
          col*=1.0-smoothstep(0.84,1.18,r)*0.72;
          col+=vec3(0.02,0.03,0.05)*pow(max(0.0,1.0-r*1.35),2.0)*(0.5+0.5*lvl);

          float star=step(0.9987,hash(floor(uv*vec2(410.0,236.0))));
          float twinkle=0.6+0.4*sin(time*1.9+hash(floor(uv*vec2(410.0,236.0)))*130.0);
          col+=vec3(0.84,0.91,1.0)*star*0.09*twinkle;
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // --- Post-processing: kaleidoscope + prismatic CA + bloom + vignette + grain + ACES grading
    const pw = window.innerWidth, ph = window.innerHeight;
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
        bloomThreshold: { value: 0.3 },
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
        jitterMix: { value: 0.45 }
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
          for(float i=1.0;i<=5.0;i+=1.0){
            float t=i/5.0;
            float w=(1.0-t);
            vec2 suv=clamp(uv+dir*(0.08+t*0.28)*amount,0.003,0.997);
            acc+=texture2D(tex,suv).rgb*w;
            wSum+=w;
          }
          return acc/max(0.0001,wSum);
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

          // Base scene with CA
          vec3 scene=prismCA(tDiffuse,sampleUv,chromaticOffset+glitchAmt*0.0012);

          // --- Optical edge: Fresnel refraction + dispersion ---
          if(edgeFactor>0.005){
            float eps=0.0015;
            vec2 dL=distortWithEdge(uv+vec2(-eps,0.0)).xy;
            vec2 dR=distortWithEdge(uv+vec2(eps,0.0)).xy;
            vec2 dU=distortWithEdge(uv+vec2(0.0,eps)).xy;
            vec2 dD=distortWithEdge(uv+vec2(0.0,-eps)).xy;
            vec2 grad=vec2(length(dR-dL),length(dU-dD));
            vec2 refDir=normalize(vec2(-grad.y,grad.x)+1e-5);
            float sp=0.008*edgeFactor*kaleidoMix*(0.65+prismAmt*0.85);

            // 5-wavelength spectral dispersion at edges (realistic prism)
            float eR=texture2D(tDiffuse,finalUv+refDir*sp*2.0).r;
            float eY=(texture2D(tDiffuse,finalUv+refDir*sp*1.0).r+texture2D(tDiffuse,finalUv+refDir*sp*0.5).g)*0.5;
            float eG=texture2D(tDiffuse,finalUv).g;
            float eC=(texture2D(tDiffuse,finalUv-refDir*sp*0.5).g+texture2D(tDiffuse,finalUv-refDir*sp*1.0).b)*0.5;
            float eB=texture2D(tDiffuse,finalUv-refDir*sp*2.0).b;
            vec3 edgeSpec=vec3(mix(eR,eY,0.3),mix(eG,(eY+eC)*0.5,0.2),mix(eB,eC,0.3));

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

          // Bloom
          vec3 bloom=vec3(0.0); float total=0.0;
          float px=4.5/resolution.x, py=4.5/resolution.y;
          for(float x=-3.0;x<=3.0;x+=1.0){
            for(float y=-3.0;y<=3.0;y+=1.0){
              vec2 sUv=clamp(finalUv+vec2(x*px,y*py),0.003,0.997);
              vec3 s=texture2D(tDiffuse,sUv).rgb;
              float w=exp(-0.18*(x*x+y*y));
              if(luma(s)>bloomThreshold) bloom+=s*w;
              total+=w;
            }
          }
          bloom=bloom/max(total,1.0)*bloomStrength;

          // Anamorphic streaks (horizontal + vertical cross)
          vec3 streakH=vec3(0.0), streakV=vec3(0.0);
          for(float i=-5.0;i<=5.0;i+=1.0){
            float w=exp(-0.14*i*i);
            vec3 sh=texture2D(tDiffuse,clamp(finalUv+vec2(i*px*3.0,0.0),0.003,0.997)).rgb;
            vec3 sv=texture2D(tDiffuse,clamp(finalUv+vec2(0.0,i*py*3.0),0.003,0.997)).rgb;
            if(luma(sh)>bloomThreshold*1.1) streakH+=sh*w;
            if(luma(sv)>bloomThreshold*1.3) streakV+=sv*w;
          }

          vec3 col=scene+bloom;
          col+=streakH*0.07*bloomStrength+streakV*0.04*bloomStrength;
          // Center prism rays (structured, not chaotic fan lines)
          vec2 rc=uv-0.5;
          float rr=length(rc);
          float ra=atan(rc.y,rc.x);
          float rayCount=max(8.0,kaleidoFolds*0.55+7.0);
          float rays=pow(max(0.0,cos(ra*rayCount+time*0.38+sin(rr*22.0-time*0.7))),7.0);
          float rayMask=smoothstep(0.05,0.68,rr)*(1.0-smoothstep(0.62,0.98,rr));
          vec3 rayCol=mix(hueToRgb(themeHue+0.08),hueToRgb(themeHue+0.28),0.5+0.5*sin(time*0.2))*rays*rayMask*(0.05+0.11*prismAmt);
          col+=rayCol;

          // Contrast + saturation (premium, controlled)
          float l=luma(col);
          float contrastHi=clamp((contrastBoost-1.0)/1.8,0.0,1.0);
          col=mix(vec3(l),col,1.22+0.14*contrastHi);
          col=((col-0.5)*(contrastBoost+0.12+0.24*contrastHi))+0.5;
          col=max(col,0.0);

          // Optic shoulder: gentle highlight roll-off
          float shoulder=smoothstep(0.70,1.38,l)*(0.11+0.06*contrastHi);
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

          // Drum shock: instant monochrome inversion pulse (black -> white hit).
          if(impactFlash>0.001){
            float imp=smoothstep(0.0,1.0,impactFlash);
            float mono=dot(col,vec3(0.299,0.587,0.114));
            vec3 bw=vec3(mono);
            vec3 inv=vec3(1.0-mono);
            float rr=length((uv-0.5)*vec2(1.0,1.25));
            float ring=exp(-pow((rr*2.9-(0.95-imp*0.5))*3.6,2.0));
            col=mix(col,bw,imp*0.34);
            col=mix(col,inv,imp*(0.6+0.2*ring));
            col+=vec3(0.28,0.32,0.38)*imp*(0.35+0.65*ring);
          }

          // Vignette + center lift: keep composition focused and readable
          float vig=1.0-smoothstep(0.14,0.92,length((uv-0.5)*1.74));
          float centerLift=1.0+0.11*(1.0-smoothstep(0.0,0.34,length(uv-0.5)));
          col*=mix(0.50,1.0,vig);
          col*=centerLift;

          // Full-screen effects (no letterbox)

          // ACES tone mapping
          col=(col*(2.51*col+0.03))/(col*(2.43*col+0.59)+0.14);

          // Cinematic grading: deep teal shadows, warm amber highlights
          float ll=luma(col);
          col*=mix(vec3(0.8,0.92,1.2),vec3(1.15,1.05,0.88),smoothstep(0.1,0.65,ll));

          // Final polish: high-end S-curve contrast without dirty clipping
          vec3 col01=clamp(col,0.0,1.0);
          vec3 cCurve=smoothstep(vec3(0.025),vec3(0.985),col01);
          col=mix(col01,cCurve,0.30+0.42*contrastHi);
          col=((col-0.5)*(1.0+0.20+0.32*contrastHi))+0.5;
          col=max(col,0.0);
          if(pixelateMix>0.01){
            float cSteps=mix(280.0,64.0,pixelateMix);
            col=floor(col*cSteps+0.5)/cSteps;
          }

          // Rhythmic blink: very subtle (avoid overexposure)
          float blink=0.5+0.5*sin(time*0.55);
          col*=1.0+0.018*smoothstep(0.2,0.8,blink);
          col*=0.93;

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
          padLevel: { value: 0 }
        },
        vertexShader: `
          attribute vec2 particleUV;
          uniform sampler2D positionTexture;
          uniform float time;
          void main() {
            vec4 pos = texture2D( positionTexture, particleUV );
            vec4 mvPos = modelViewMatrix * vec4( pos.xyz, 1.0 );
            float depth = 1.0 / max(0.1, -mvPos.z);
            gl_PointSize = 0.14 * depth;
            gl_Position = projectionMatrix * mvPos;
          }
        `,
        fragmentShader: `
          uniform float time;
          uniform float keyHue;
          uniform float sparkleFlash;
          uniform float padLevel;
          vec3 hueToRgb(float h){
            vec3 k=vec3(1.0,2.0/3.0,1.0/3.0);
            return clamp(abs(fract(vec3(h)+k)*6.0-3.0)-1.0,0.0,1.0);
          }
          void main(){
            vec2 u=gl_PointCoord-0.5; float d=length(u);
            if(d>0.5) discard;
            float core=1.0-smoothstep(0.0,0.22,d);
            float halo=1.0-smoothstep(0.04,0.5,d);
            float a=mix(halo*0.65,1.0,core);
            float h=keyHue+sin(time*0.4+gl_PointCoord.x*6.28)*0.15;
            vec3 primary=hueToRgb(h)*0.85;
            vec3 secondary=hueToRgb(h+0.33)*0.45;
            vec3 tertiary=hueToRgb(h+0.67)*0.25;
            float pulse=0.85+0.15*sin(time*1.2+gl_PointCoord.y*12.0);
            vec3 col=mix(primary,primary+secondary,core*pulse);
            col+=tertiary*halo*0.4;
            col+=core*core*vec3(0.45,0.5,0.55);
            col+=sparkleFlash*hueToRgb(h+0.5)*0.65;
            col+=padLevel*0.12*hueToRgb(h+0.25);
            gl_FragColor=vec4(col,a*0.9);
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

    // --- Tunnel particles: dense, small, many (ref: hyperspace tunnel)
    const tunnelPos = [];
    const tunnelSegs = 160;
    for (let r = 0; r < TUNNEL_RINGS; r++) {
      const t = r / (TUNNEL_RINGS - 1);
      const z = -2.4 + t * 2.8;
      const radius = TUNNEL_RADIUS * (0.35 + 0.65 * (1 - t));
      for (let i = 0; i < tunnelSegs; i++) {
        const a = (i / tunnelSegs) * Math.PI * 2;
        tunnelPos.push(Math.cos(a) * radius, Math.sin(a) * radius, z);
      }
    }
    const radialLines = 56;
    const radialPoints = 33;
    for (let i = 0; i < radialLines; i++) {
      const a = (i / radialLines) * Math.PI * 2;
      for (let k = 0; k <= radialPoints - 1; k++) {
        const t = k / (radialPoints - 1);
        const len = 0.1 + t * TUNNEL_RADIUS;
        tunnelPos.push(Math.cos(a) * len, Math.sin(a) * len, -2.4 + t * 2.8);
      }
    }
    const tunnelGeo = new THREE.BufferGeometry();
    tunnelGeo.setAttribute('position', new THREE.Float32BufferAttribute(tunnelPos, 3));
    tunnelParticles = new THREE.Points(
      tunnelGeo,
      new THREE.PointsMaterial({ size: 0.0032, color: 0x00e5ff, opacity: 0.9, ...particleMatOpts })
    );
    tunnelParticles.userData.basePos = tunnelPos.slice();
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
      new THREE.PointsMaterial({ size: 0.003, color: 0x00ffff, opacity: 0.85, ...particleMatOpts })
    );
    scene.add(centralColumnParticles);

    // --- Radiating particles: points along each ray
    const radiatePos = [];
    const radiateCol = [];
    for (let i = 0; i < RADIATE_COUNT; i++) {
      const a = (i / RADIATE_COUNT) * Math.PI * 2;
      const hue = (i / RADIATE_COUNT) * 0.7 + 0.45;
      const col = new THREE.Color().setHSL(hue, 0.9, 0.7);
      for (let k = 0; k < RADIATE_POINTS_PER_RAY; k++) {
        const t = (k + 1) / (RADIATE_POINTS_PER_RAY + 1);
        const len = t * 1.4;
        radiatePos.push(Math.cos(a) * len, 0.02 * (Math.random() - 0.5), Math.sin(a) * len);
        radiateCol.push(col.r, col.g, col.b);
      }
    }
    const radiateGeo = new THREE.BufferGeometry();
    radiateGeo.setAttribute('position', new THREE.Float32BufferAttribute(radiatePos, 3));
    radiateGeo.setAttribute('color', new THREE.Float32BufferAttribute(radiateCol, 3));
    radiatingParticles = new THREE.Points(radiateGeo, new THREE.PointsMaterial({
      size: 0.0022, vertexColors: true, opacity: 0.88, ...particleMatOpts
    }));
    radiatingParticles.userData.basePos = radiatePos.slice(0);
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

    // --- Matrix surface particles: clean "surface" layer with breathing room
    const matrixPos = [];
    for (let i = 0; i < MATRIX_SURF_POINTS; i++) {
      const u = (Math.random() * 2 - 1) * 1.5;
      const v = (Math.random() * 2 - 1) * 1.0;
      const w = (Math.random() * 2 - 1) * 1.2;
      if (i % 2 === 0) matrixPos.push(u, v * 0.55, w * 0.45);
      else matrixPos.push(u * 0.42, v, w);
    }
    const matrixGeo = new THREE.BufferGeometry();
    matrixGeo.setAttribute('position', new THREE.Float32BufferAttribute(matrixPos, 3));
    matrixSurfaceParticles = new THREE.Points(
      matrixGeo,
      new THREE.PointsMaterial({ size: 0.0018, color: 0xb8d8ff, opacity: 0.0, ...particleMatOpts })
    );
    matrixSurfaceParticles.userData.basePos = matrixPos.slice(0);
    scene.add(matrixSurfaceParticles);

    // --- Prism spokes: radiating center optics (point-lines), clean and structured
    const spokePos = [];
    for (let i = 0; i < PRISM_SPOKE_POINTS; i++) {
      const spoke = i % 72;
      const lane = Math.floor(i / 72);
      const a = (spoke / 72) * Math.PI * 2;
      const t = lane / Math.max(1, (PRISM_SPOKE_POINTS / 72) - 1);
      const r = 0.05 + t * 1.45;
      spokePos.push(Math.cos(a) * r, (Math.random() - 0.5) * 0.015, Math.sin(a) * r);
    }
    const spokeGeo = new THREE.BufferGeometry();
    spokeGeo.setAttribute('position', new THREE.Float32BufferAttribute(spokePos, 3));
    prismSpokeParticles = new THREE.Points(
      spokeGeo,
      new THREE.PointsMaterial({ size: 0.0019, color: 0xd7e9ff, opacity: 0.0, ...particleMatOpts })
    );
    prismSpokeParticles.userData.basePos = spokePos.slice(0);
    scene.add(prismSpokeParticles);

    // --- Three.js Piano Roll: point-line-surface runway integrated into core scene
    roll3DGroup = new THREE.Group();
    roll3DGroup.position.set(0, -0.32, 0.44);
    roll3DGroup.rotation.x = -0.24;

    const rollSurfaceGeo = new THREE.PlaneGeometry(1, 1);
    const rollSurfaceMat = new THREE.MeshBasicMaterial({
      color: 0xe6f3ff,
      transparent: true,
      opacity: 0.62,
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
      color: 0xbfe8ff,
      transparent: true,
      opacity: 0.34,
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

    const rollLineGeo = new THREE.BufferGeometry();
    roll3DLinePosArray = new Float32Array(ROLL3D_MAX_LINES * 3);
    roll3DLinePosAttr = new THREE.BufferAttribute(roll3DLinePosArray, 3);
    roll3DLinePosAttr.setUsage(THREE.DynamicDrawUsage);
    rollLineGeo.setAttribute('position', roll3DLinePosAttr);
    roll3DLines = new THREE.LineSegments(
      rollLineGeo,
      new THREE.LineBasicMaterial({
        color: 0xe5f4ff,
        transparent: true,
        opacity: 0.38,
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
    if (rollOverlayScene) rollOverlayScene.add(roll3DGroup);
    else scene.add(roll3DGroup);

    // --- Burst ring particles (positions updated in animate)
    const burstPos = [];
    for (let i = 0; i < BURST_RING_POINTS; i++) {
      const a = (i / BURST_RING_POINTS) * Math.PI * 2;
      burstPos.push(Math.cos(a), Math.sin(a), 0);
    }
    const burstGeo = new THREE.BufferGeometry();
    burstGeo.setAttribute('position', new THREE.Float32BufferAttribute(burstPos, 3));
    burstRingParticles = new THREE.Points(
      burstGeo,
      new THREE.PointsMaterial({ size: 0.004, color: 0xff00ff, opacity: 0, ...particleMatOpts })
    );
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

    // --- Floating particle clouds: each orb = small point cloud
    floatingParticleClouds = new THREE.Group();
    const allFloatingPos = [];
    const allFloatingCol = [];
    for (let o = 0; o < FLOATING_ORB_COUNT; o++) {
      const hue = 0.5 + (o / FLOATING_ORB_COUNT) * 0.35;
      const col = new THREE.Color().setHSL(hue, 0.6, 0.55);
      for (let p = 0; p < FLOATING_POINTS_PER_ORB; p++) {
        const th = Math.acos(2 * Math.random() - 1);
        const ph = Math.random() * Math.PI * 2;
        const r = 0.08 * Math.cbrt(Math.random());
        allFloatingPos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
        allFloatingCol.push(col.r, col.g, col.b);
      }
    }
    const floatGeo = new THREE.BufferGeometry();
    floatGeo.setAttribute('position', new THREE.Float32BufferAttribute(allFloatingPos, 3));
    floatGeo.setAttribute('color', new THREE.Float32BufferAttribute(allFloatingCol, 3));
    const floatPts = new THREE.Points(floatGeo, new THREE.PointsMaterial({
      size: 0.0025, vertexColors: true, opacity: 0.78, ...particleMatOpts
    }));
    floatPts.userData.basePos = allFloatingPos.slice();
    floatPts.userData.orbCount = FLOATING_ORB_COUNT;
    floatPts.userData.pointsPerOrb = FLOATING_POINTS_PER_ORB;
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
      if (rtScene) rtScene.setSize(w, h);
      if (postQuad && postQuad.material.uniforms) postQuad.material.uniforms.resolution.value.set(w, h);
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
    { name:'Contour Vector', folds:8, hue:0.02, bloom:2.44, ca:0.0038, spiral:0.01, flow:0.88, pulse:0.26, shear:0.12, wave:0.24, glitch:0.05, mx:0, my:0, warp:0.34, prism:0.82, bio:0.28, rot:0.02, contrast:2.38, in:0.96, out:0.70 },
    { name:'Optic Axis', folds:12, hue:0.56, bloom:2.58, ca:0.0044, spiral:0.02, flow:0.36, pulse:0.32, shear:0.34, wave:0.22, glitch:0.08, mx:0, my:0, warp:0.30, prism:0.98, bio:0.30, rot:0.18, contrast:2.44, in:0.96, out:0.70 },
    { name:'Bio Relief', folds:7, hue:0.31, bloom:2.48, ca:0.0040, spiral:0.03, flow:0.72, pulse:0.58, shear:0.18, wave:0.36, glitch:0.08, mx:0, my:0, warp:0.48, prism:0.86, bio:0.84, rot:-0.06, contrast:2.34, in:0.95, out:0.68 },
    { name:'Prism Grid', folds:10, hue:0.63, bloom:2.36, ca:0.0048, spiral:0.01, flow:0.42, pulse:0.24, shear:0.82, wave:0.30, glitch:0.20, mx:1, my:0, warp:0.36, prism:1.02, bio:0.24, rot:0.22, contrast:2.66, in:0.97, out:0.72 },
    { name:'Pulse Ridge', folds:9, hue:0.95, bloom:2.76, ca:0.0046, spiral:0.02, flow:0.40, pulse:0.94, shear:0.20, wave:0.30, glitch:0.06, mx:0, my:0, warp:0.58, prism:0.88, bio:0.56, rot:-0.04, contrast:2.52, in:0.95, out:0.68 },
    { name:'Mirror Matrix', folds:11, hue:0.58, bloom:2.18, ca:0.0036, spiral:0.00, flow:0.30, pulse:0.22, shear:0.88, wave:0.26, glitch:0.22, mx:1, my:1, warp:0.28, prism:0.9, bio:0.2, rot:0.28, contrast:2.7, in:0.97, out:0.72 },
    { name:'Couture Spectrum', folds:14, hue:0.09, bloom:2.82, ca:0.0052, spiral:0.04, flow:0.62, pulse:0.44, shear:0.36, wave:0.42, glitch:0.18, mx:0, my:0, warp:0.72, prism:1.06, bio:0.66, rot:-0.14, contrast:2.58, in:0.96, out:0.7 },
    { name:'Crystal Loom', folds:16, hue:0.72, bloom:2.86, ca:0.0050, spiral:0.01, flow:0.34, pulse:0.38, shear:0.3, wave:0.28, glitch:0.08, mx:1, my:0, warp:0.42, prism:1.04, bio:0.34, rot:0.2, contrast:2.48, in:0.96, out:0.7 },
    { name:'Radial Frame', folds:6, hue:0.42, bloom:2.3, ca:0.0040, spiral:0.02, flow:0.76, pulse:0.38, shear:0.5, wave:0.84, glitch:0.16, mx:1, my:0, warp:0.66, prism:0.84, bio:0.48, rot:-0.16, contrast:2.56, in:0.95, out:0.68 },
    { name:'Metro Symmetry', folds:13, hue:0.18, bloom:2.52, ca:0.0042, spiral:0.03, flow:0.46, pulse:0.4, shear:0.58, wave:0.32, glitch:0.14, mx:1, my:0, warp:0.46, prism:0.94, bio:0.32, rot:0.3, contrast:2.6, in:0.97, out:0.72 },
    { name:'Scan Flux', folds:9, hue:0.02, bloom:2.34, ca:0.0052, spiral:0.00, flow:0.5, pulse:0.66, shear:0.32, wave:0.24, glitch:0.28, mx:0, my:0, warp:0.56, prism:0.9, bio:0.28, rot:-0.2, contrast:2.74, in:0.98, out:0.72 },
    { name:'Helix Field', folds:15, hue:0.88, bloom:2.7, ca:0.0046, spiral:0.03, flow:0.5, pulse:0.56, shear:0.24, wave:0.48, glitch:0.1, mx:0, my:0, warp:0.7, prism:1.0, bio:0.78, rot:0.12, contrast:2.46, in:0.96, out:0.7 },
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
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user', frameRate: { ideal: 30 } },
        audio: false
      });
      headVideo = document.createElement('video');
      headVideo.srcObject = stream;
      headVideo.setAttribute('playsinline', '');
      headVideo.setAttribute('muted', '');
      headVideo.style.cssText = 'position:fixed;bottom:8px;right:8px;width:120px;height:90px;opacity:0.3;z-index:999;border-radius:0;pointer-events:none;transform:scaleX(-1)';
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
    outputBusGain.connect(chorusSend);
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
    outputBusGain.connect(rev1); outputBusGain.connect(rev2); outputBusGain.connect(rev3);
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
    outputBusGain.connect(pingSend);
    pingSend.connect(pingL);
    pingSend.connect(pingR);
    pingL.connect(pingFbL); pingFbL.connect(pingR);
    pingR.connect(pingFbR); pingFbR.connect(pingL);
    pingL.connect(pingHP);
    pingR.connect(pingHP);
    pingHP.connect(pingLP);
    pingLP.connect(pingOut);

    // Final mix to destination.
    const dryGain = audioCtx.createGain(); dryGain.gain.value = 0.66;
    outputBusGain.connect(dryGain);
    dryGain.connect(audioCtx.destination);
    drumDryBus.connect(audioCtx.destination);
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
    gain.connect(drumGain);
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
    voiceOut.connect(masterGain);

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
    attractor.strength = 1.2;
    attractor.col = cell.col;
    attractor.row = cell.row;
    activeProfile = KEY_PROFILES[cell.col % KEY_PROFILES.length];
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
        variant: drumVariant
      });
    },
    initAudio,
    getAudioContext,
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
      if (Array.isArray(state.preview)) {
        midiRollPreview = state.preview.slice(0, ROLL3D_MAX_INSTANCES).map((n) => ({
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
    const menuLead = '<span style="opacity:.94">FILE</span>&nbsp;&nbsp;<span style="opacity:.94">EDIT</span>&nbsp;&nbsp;<span style="opacity:.94">VIEW</span>&nbsp;&nbsp;<span style="opacity:.94">SYNTH</span>&nbsp;&nbsp;<span style="opacity:.94">FX</span>&nbsp;&nbsp;<span style="opacity:.94">MIDI</span>&nbsp;&nbsp;<span style="opacity:.94">TOOLS</span>';
    hudEl.innerHTML = `${menuLead}&nbsp;&nbsp;<span style="opacity:.45">|</span>&nbsp;&nbsp;${modes.join(' &nbsp;<span style="opacity:.45">·</span>&nbsp; ')}`;
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
          gap: 8px 12px;
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
          font: 860 34px/1.02 "Lucida Console","Courier New","Tahoma","MS Sans Serif",monospace;
          letter-spacing: 0.04em;
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
          transform: translate(0.65px, -0.12px);
          pointer-events: none;
          mix-blend-mode: screen;
        }
        .note-head-code .glyph-ca-c {
          position: absolute;
          inset: 0 0 0 0;
          color: rgba(74,235,255,0.32);
          transform: translate(-0.65px, 0.12px);
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
      { top: '6.2%', left: '3%', right: '3%', alpha: 0.98, blur: 0, kind: 'top' },
      { top: '30%', left: '70%', right: '2.5%', alpha: 0.72, blur: 0.22, kind: 'right' },
      { top: '67%', left: '2.5%', right: '70%', alpha: 0.68, blur: 0.18, kind: 'left' },
      { top: '90.2%', left: '4%', right: '4%', alpha: 0.56, blur: 0.32, kind: 'bottom' }
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
        'gap:8px 12px',
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
        text-shadow:0 0 12px hsla(${hueDeg},52%,70%,0.36);
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
  function animate() {
    requestAnimationFrame(animate);
    if (!renderer || !scene || !camera) return;
    const now = performance.now() * 0.001;
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
    const kickFlash = Math.pow(Math.max(0, 1 - (now - lastKickImpact) / 0.16), 0.24);
    const minorDrumFlash = Math.pow(Math.max(0, 1 - (now - lastDrumMinorImpact) / 0.1), 0.64) * 0.2;
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
    const ampYaw = headTrackingActive ? 1.12 : 0.7;
    const ampPitch = headTrackingActive ? 0.72 : 0.45;
    const ampRoll = -0.038;
    const ampCamX = headTrackingActive ? 0.58 : 0.32;
    const ampCamY = headTrackingActive ? 0.32 : 0.18;
    const headLerp = 0.11;

    const headKaleidoBias = headOffset * ampKaleidoH + headOffsetY * ampKaleidoV;
    const breathe = 0.012 * syncA + 0.006 * syncB;
    const keyPush = attractor.strength > 0.05 ? (0.018 + 0.012 * syncB) * attractor.strength : 0;
    const idleKaleido = idleIntensity * 0.018 * syncA;
    const profileSpin = curProfileRoll * (0.014 + 0.024 * Math.min(1, attractor.strength + 0.1));
    const targetRotation = breathe + keyPush + gestureKaleidoBias + headKaleidoBias + idleKaleido + profileSpin;
    kaleidoRotation += (targetRotation - kaleidoRotation) * 0.4;

    if (camera) {
      const targetYaw = headOffset * ampYaw;
      const targetPitch = (0.5 - headYSmoothed) * ampPitch;
      const profileRoll = curProfileRoll * (0.024 + 0.05 * Math.min(1, attractor.strength + 0.12));
      camera.rotation.y += (targetYaw - camera.rotation.y) * headLerp;
      camera.rotation.x += (targetPitch - camera.rotation.x) * headLerp;
      camera.rotation.z += ((headOffset * ampRoll + profileRoll) - camera.rotation.z) * 0.06;
      if (headTrackingActive) {
        const targetCamX = headOffset * ampCamX;
        const targetCamY = headOffsetY * ampCamY;
        camera.position.x += (targetCamX - camera.position.x) * headLerp;
        camera.position.y += (targetCamY - camera.position.y) * headLerp;
      }
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

    if (tunnelParticles && tunnelParticles.geometry) {
      const posAttr = tunnelParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = tunnelParticles.userData.basePos;
      const m = 0.32 + tunnelW * 1.18;
      for (let i = 0; i < arr.length; i += 3) {
        const j = i / 3;
        const bx = base[i], by = base[i+1], bz = base[i+2];
        const shear = tunnelW * 0.2 * Math.sin(bz * 1.5 + colPhase * 2);
        const squash = 1 + tunnelW * 0.35 * Math.sin(colPhase * 1.2 + j * 0.02);
        arr[i]   = bx * squash + 0.28 * m * Math.sin(colPhase + j * 0.03) + shear;
        arr[i+1] = by / squash + 0.25 * m * Math.cos(colPhase * 1.1 + j * 0.04 + bz * 0.5) + shear * 0.5;
        arr[i+2] = bz + 0.35 * m * Math.sin(colPhase * 0.9 + bz * 0.6) + tunnelW * 0.25 * Math.cos(colPhase * 2 + j * 0.01);
      }
      posAttr.needsUpdate = true;
      tunnelParticles.material.opacity = 0.03 + tunnelW * Math.min(0.95, 0.62 + 0.2 * (0.5 + 0.5 * syncA) + str * 0.24);
      tunnelParticles.material.color.setHSL(currentKeyHue, 0.92, 0.35 + tunnelW * (0.44 + 0.1 * (0.5 + 0.5 * syncB)));
      tunnelParticles.material.size = 0.003 + tunnelW * 0.0021 * Math.abs(syncA);
    }

    if (centralColumnParticles && centralColumnParticles.geometry) {
      const posAttr = centralColumnParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const sustainGlow = Math.min(0.4, sustainedVoices.size * 0.1);
      // Clean structured core: matrix helix column with restrained breathing.
      for (let v = 0; v < CENTRAL_COL_POINTS; v++) {
        const t = v / (CENTRAL_COL_POINTS - 1);
        const baseY = t * 1.8 - 0.9;
        const coreR = 0.012 + centralW * 0.082;
        const twist = now * 0.9 + v * 0.12;
        const lattice = Math.sin(v * 0.23 + now * 1.08) * Math.sin(v * 0.07 + now * 0.76);
        arr[v * 3] = coreR * Math.sin(twist) + centralW * 0.032 * lattice;
        arr[v * 3 + 1] = baseY * (1.0 + centralW * 0.22) + centralW * 0.048 * Math.sin(now * 0.7 + v * 0.05);
        arr[v * 3 + 2] = coreR * Math.cos(twist) + centralW * 0.016 * Math.sin(v * 0.17 + now * 0.62);
      }
      posAttr.needsUpdate = true;
      centralColumnParticles.material.opacity = 0.03 + centralW * Math.min(0.97, 0.68 + sustainGlow + padLevel * 0.22 + 0.1 * (0.5 + 0.5 * syncA));
      centralColumnParticles.material.color.setHSL(currentKeyHue + 0.1, 0.9, 0.4 + centralW * (0.42 + 0.08 * (0.5 + 0.5 * syncA)));
      centralColumnParticles.material.size = 0.002 + centralW * (0.0018 + 0.0016 * Math.abs(syncB));
    }

    if (radiatingParticles && radiatingParticles.geometry) {
      const posAttr = radiatingParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const lanes = 12;
      const bands = 6;
      const laneSpacing = 0.16;
      for (let i = 0; i < RADIATE_COUNT; i++) {
        const lane = (i % lanes) - (lanes - 1) * 0.5;
        const band = Math.floor(i / lanes) % bands;
        const bandDepth = -1.0 + band * 0.42;
        for (let k = 0; k < RADIATE_POINTS_PER_RAY; k++) {
          const idx = (i * RADIATE_POINTS_PER_RAY + k) * 3;
          const t = k / (RADIATE_POINTS_PER_RAY - 1);
          const axis = (i % 2 === 0) ? 1 : -1;
          const z = bandDepth + (t - 0.5) * (1.5 + radiateW * 1.2);
          const x = lane * laneSpacing + axis * 0.04 * Math.sin(now * 0.8 + t * 6.0 + lane * 0.3);
          const y = 0.02 * Math.sin(now * 0.7 + lane * 0.4) + 0.03 * radiateW * Math.sin(t * 10.0 + now * 1.1 + band * 0.6);
          arr[idx] = x;
          arr[idx + 1] = y;
          arr[idx + 2] = z;
        }
      }
      posAttr.needsUpdate = true;
      radiatingParticles.material.opacity = 0.03 + radiateW * Math.min(0.9, 0.58 + str * 0.22 + 0.12 * (0.5 + 0.5 * syncB));
      radiatingParticles.material.size = 0.0024 + radiateW * (0.0012 + 0.0009 * Math.abs(syncA));
      radiatingParticles.material.color.setHSL(currentKeyHue + 0.06, 0.6, 0.86);
    }

    if (matrixSurfaceParticles && matrixSurfaceParticles.geometry && matrixSurfaceParticles.userData.basePos) {
      const posAttr = matrixSurfaceParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = matrixSurfaceParticles.userData.basePos;
      const surfW = Math.max(0.14, 0.55 * verticalW + 0.45 * speedW);
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i];
        const by = base[i + 1];
        const bz = base[i + 2];
        const wave = 0.018 * surfW * Math.sin(now * 0.9 + bx * 3.0 + bz * 2.2);
        arr[i] = bx + wave * 0.7;
        arr[i + 1] = by + 0.022 * surfW * Math.cos(now * 0.8 + bz * 2.8);
        arr[i + 2] = bz + wave * 0.5;
      }
      posAttr.needsUpdate = true;
      matrixSurfaceParticles.material.opacity = 0.02 + surfW * Math.min(0.36, 0.18 + 0.14 * (0.5 + 0.5 * syncA));
      matrixSurfaceParticles.material.size = 0.0016 + surfW * 0.0009;
      matrixSurfaceParticles.material.color.setHSL(currentKeyHue + 0.1, 0.42, 0.76);
    }

    if (prismSpokeParticles && prismSpokeParticles.geometry && prismSpokeParticles.userData.basePos) {
      const posAttr = prismSpokeParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = prismSpokeParticles.userData.basePos;
      const prismW = Math.max(0.12, 0.62 * radiateW + 0.38 * styleCrossover);
      const rot = now * (0.08 + 0.06 * prismW);
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      for (let i = 0; i < arr.length; i += 3) {
        const bx = base[i];
        const by = base[i + 1];
        const bz = base[i + 2];
        const x = bx * c - bz * s;
        const z = bx * s + bz * c;
        const radius = Math.sqrt(x * x + z * z);
        const pulse = 1.0 + 0.12 * prismW * Math.sin(now * 1.2 + radius * 5.0);
        arr[i] = x * pulse;
        arr[i + 1] = by + 0.01 * prismW * Math.sin(now * 0.9 + radius * 9.0);
        arr[i + 2] = z * pulse;
      }
      posAttr.needsUpdate = true;
      prismSpokeParticles.material.opacity = 0.02 + prismW * Math.min(0.58, 0.32 + 0.14 * (0.5 + 0.5 * syncB));
      prismSpokeParticles.material.size = 0.0017 + prismW * (0.001 + 0.0008 * Math.abs(syncA));
      prismSpokeParticles.material.color.setHSL(currentKeyHue + 0.24, 0.72, 0.9);
    }

    if (boxWireframe && boxWireframe.material) {
      boxWireframe.material.opacity = 0.12 + 0.035 * syncA + str * 0.06;
    }

    if (speedLineParticles && speedLineParticles.geometry && speedLineParticles.userData.basePos) {
      const posAttr = speedLineParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = speedLineParticles.userData.basePos;
      const speedMotion = (attractor.col || 0) % 4;
      for (let i = 0; i < arr.length; i += 3) {
        const lineIdx = Math.floor((i / 3) / SPEED_POINTS_PER_LINE);
        const ptIdx = (i / 3) % SPEED_POINTS_PER_LINE;
        const t = ptIdx / SPEED_POINTS_PER_LINE;
        const diag = (lineIdx % 2 === 0) ? 1 : -1;
        const m = 0.5 + speedW * 1.5;
        const phase = now * (3 + lineIdx * 0.15) + lineIdx * 0.4;
        arr[i]   = base[i] + 0.5 * m * Math.sin(phase) + diag * t * 0.15 * m;
        arr[i+1] = base[i+1] + diag * t * 0.2 * m + 0.12 * m * Math.cos(now * 3 + i * 0.01);
        arr[i+2] = base[i+2] + 0.25 * m * Math.sin(now * 1.5 + base[i+2] * 2);
        // Perpendicular wave (ribbon) for style 1/2; pulse bands for style 3
        if (speedW > 0.02) {
          const scatter = 0.018 * Math.sin(now * 2.4 + i * 0.16) * (1 - t);
          arr[i] += scatter;
          arr[i+1] += scatter * 0.6;
          if (speedMotion === 1) {
            arr[i+1] += speedW * 0.022 * m * Math.sin(t * 10 + now * 1.8);
            arr[i+2] += speedW * 0.018 * m * Math.cos(t * 9 + now * 1.3);
          } else if (speedMotion === 2) {
            arr[i] += speedW * 0.018 * m * Math.sin(t * 13 + now * 2.1) * (1 - t);
            arr[i+2] += speedW * 0.018 * m * Math.cos(t * 10 + now * 1.7) * (1 - t);
          } else if (speedMotion === 3) {
            const band = Math.floor(t * 6) * 0.6 + now * 1.2;
            arr[i+1] += speedW * 0.016 * m * Math.sin(band) * (1 - t);
          }
        }
      }
      posAttr.needsUpdate = true;
      speedLineParticles.material.opacity = 0.03 + speedW * Math.min(0.95, 0.62 + 0.22 * (0.5 + 0.5 * syncB) + str * 0.2);
      speedLineParticles.material.color.setHSL(currentKeyHue + 0.15, 0.92, 0.4 + speedW * (0.38 + 0.08 * (0.5 + 0.5 * syncA)));
      speedLineParticles.material.size = 0.002 + speedW * 0.0014 * Math.abs(syncB);
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
      colPts.material.size = 0.0028 + verticalW * 0.0014 * Math.abs(syncB) + (isKeyActive ? 0.001 : 0);
      colPts.material.color.setHSL(currentKeyHue + 0.08, 0.66, 0.92);
    }

    if (burstRingParticles && burstRingParticles.geometry) {
      const burstAge = burstRingTime >= 0 ? now - burstRingTime : 1;
      const burstDur = 1.0;
      if (burstAge < burstDur) {
        const t = burstAge / burstDur;
        burstRingParticles.visible = true;
        burstRingParticles.position.set(attractor.x, attractor.y, attractor.z);
        // Irregular starburst: non-uniform scale + rotation
        const scaleX = 0.04 + t * 1.3 + 0.15 * Math.sin(t * 8);
        const scaleY = 0.04 + t * 1.1 + 0.2 * Math.cos(t * 6);
        burstRingParticles.scale.set(scaleX, scaleY, 0.04 + t * 0.8);
        burstRingParticles.rotation.z = t * 2.5;
        burstRingParticles.rotation.x = t * 0.5 * Math.sin(now * 3);
        burstRingParticles.material.opacity = (1 - t * t) * 0.95;
        burstRingParticles.material.size = 0.004 + 0.003 * (1 - t);
        burstRingParticles.material.color.setHSL(currentKeyHue + t * 0.15, 0.95, 0.75 + 0.15 * (1 - t));
      } else {
        burstRingParticles.visible = false;
        burstRingParticles.rotation.set(0, 0, 0);
      }
    }

    if (plasmaParticles && plasmaParticles.geometry && plasmaParticles.userData.baseOffsets) {
      const posAttr = plasmaParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const off = plasmaParticles.userData.baseOffsets;
      // Motion style by key: 0=arc plume, 1=linear burst, 2=figure-8, 3=noise drift
      const plasmaMotion = (attractor.col || 0) % 4;
      const sc = 0.7 + str * 1.4 + plasmaW * 0.5 * Math.sin(now * 2.2);
      for (let i = 0; i < PLASMA_POINTS; i++) {
        const branch = Math.floor(i / 40);
        const branchT = (i % 40) / 40;
        const branchAngle = branch * 2.39996 + now * 0.3;
        if (plasmaW > 0.02) {
          const radius = branchT * 0.6 * sc;
          const jitter = 0.018 * Math.sin(i * 5.0 + now * 2.0);
          if (plasmaMotion === 0) {
              const arc = 0.14 * radius * Math.sin(branchT * 5.2 + now * 1.1 + branch * 0.3);
            arr[i*3]   = attractor.x + Math.cos(branchAngle) * radius + arc + jitter;
              arr[i*3+1] = attractor.y + branchT * 0.18 * Math.sin(now * 0.9 + branch) + off[i*3+1] * 0.18;
            arr[i*3+2] = attractor.z + Math.sin(branchAngle) * radius - arc * 0.7 + jitter * 0.6;
          } else if (plasmaMotion === 1) {
            arr[i*3]   = attractor.x + Math.cos(branchAngle) * radius + jitter * 0.5;
              arr[i*3+1] = attractor.y + branchT * 0.16 + off[i*3+1] * 0.12;
            arr[i*3+2] = attractor.z + Math.sin(branchAngle) * radius + jitter * 0.5;
          } else if (plasmaMotion === 2) {
            const liss = now * 1.0 + branch * 0.4;
            const lx = Math.sin(liss) * radius * 0.7;
            const lz = Math.sin(liss * 2 + 0.6) * radius * 0.5;
            arr[i*3]   = attractor.x + lx + Math.cos(branchAngle) * branchT * 0.15;
              arr[i*3+1] = attractor.y + branchT * 0.14 * Math.sin(now * 0.7 + branch);
            arr[i*3+2] = attractor.z + lz + Math.sin(branchAngle) * branchT * 0.15;
          } else {
            const drift = 0.05 * Math.sin(now * 0.6 + branch * 1.2) * branchT;
              const wobble = 0.1 * radius * Math.sin(now * 0.65 + branch * 1.1 + branchT * 7.0);
            arr[i*3]   = attractor.x + Math.cos(branchAngle) * radius * 0.72 + drift + wobble + off[i*3] * 0.15;
            arr[i*3+1] = attractor.y + branchT * 0.18 + 0.03 * Math.sin(now * 0.9 + branch * 1.5);
            arr[i*3+2] = attractor.z + Math.sin(branchAngle) * radius * 0.72 + drift * 0.6 - wobble * 0.7 + off[i*3+2] * 0.15;
          }
        } else {
          arr[i*3]   = attractor.x + off[i*3] * sc * 0.5 + 0.015 * Math.sin(now * 1.5 + i);
          arr[i*3+1] = attractor.y + off[i*3+1] * sc * 0.5 + 0.015 * Math.cos(now * 1.3 + i);
          arr[i*3+2] = attractor.z + off[i*3+2] * sc * 0.5;
        }
      }
      posAttr.needsUpdate = true;
      plasmaParticles.material.opacity = 0.02 + plasmaW * Math.min(0.96, 0.66 + padLevel * 0.22 + 0.12 * (0.5 + 0.5 * syncB));
      plasmaParticles.material.color.setHSL(currentKeyHue + 0.2, 0.92, 0.35 + plasmaW * (0.45 + 0.08 * (0.5 + 0.5 * syncA)));
      plasmaParticles.material.size = 0.003 + plasmaW * 0.0026 * Math.min(1, str);
    }

    if (floatingParticleClouds && floatingParticleClouds.children[0]) {
      const floatPts = floatingParticleClouds.children[0];
      const posAttr = floatPts.geometry.attributes.position;
      const arr = posAttr.array;
      const base = floatPts.userData.basePos;
      const nOrb = floatPts.userData.orbCount || FLOATING_ORB_COUNT;
      const ppo = floatPts.userData.pointsPerOrb || FLOATING_POINTS_PER_ORB;
      // Comet trails: orbs stretch into tails when active, figure-8 / Lissajous paths
      for (let o = 0; o < nOrb; o++) {
        const r = 0.5 + (o % 3) * 0.35;
        const sp = 0.25 + (o % 4) * 0.12;
        const ph = (o / nOrb) * Math.PI * 2;
        // Lissajous curve (irregular, not circular)
        const lissaA = 1 + (o % 3); const lissaB = 2 + (o % 2);
        const cx = Math.sin(now * sp * lissaA + ph) * r;
        const cz = Math.cos(now * sp * lissaB + ph * 1.3) * r * 0.8;
        const cy = 0.25 * Math.sin(now * sp * 1.5 + o * 1.1);
        for (let p = 0; p < ppo; p++) {
          const idx = (o * ppo + p) * 3;
          const t = p / ppo;
          // Trail: particles behind the orb center
          const trailLen = 0.05 + floatW * (0.15 + 0.1 * str);
          const trailOff = t * trailLen;
          const pastTime = now - trailOff * 2;
          const tcx = Math.sin(pastTime * sp * lissaA + ph) * r * (0.35 + floatW * 0.65) + cx * (1 - floatW);
          const tcz = Math.cos(pastTime * sp * lissaB + ph * 1.3) * r * 0.8 * (0.35 + floatW * 0.65) + cz * (1 - floatW);
          const tcy = 0.25 * Math.sin(pastTime * sp * 1.5 + o * 1.1) * (0.35 + floatW * 0.65) + cy * (1 - floatW);
          arr[idx]   = tcx + base[idx] * (1 - t * 0.5) + 0.02 * Math.sin(now * 1.8 + p * 0.2);
          arr[idx+1] = tcy + base[idx+1] * (1 - t * 0.5) + 0.02 * Math.sin(now * 1.2 + p * 0.15);
          arr[idx+2] = tcz + base[idx+2] * (1 - t * 0.5) + 0.02 * Math.cos(now * 1.5 + p * 0.18);
        }
      }
      posAttr.needsUpdate = true;
      floatPts.material.opacity = 0.03 + floatW * Math.min(0.94, 0.62 + 0.16 * (0.5 + 0.5 * syncA) + str * 0.2);
      floatPts.material.size = 0.003 + floatW * 0.0013 * Math.abs(syncB);
      floatPts.material.color.setHSL(currentKeyHue + 0.28, 0.52, 0.88);
    }

    updateRoll3DLayer(now, syncA, syncB, impactFlash, currentKeyHue);

    if (Math.floor(now * 6) % 1 === 0) updateHud();
    updateKeyDisplay();
    updateNoteRepeatOverlay();
    if (keyDisplayMesh && keyDisplayMesh.visible && keyDisplayMesh.userData.baseY != null) {
      keyDisplayMesh.position.y = keyDisplayMesh.userData.baseY + 0.014 * Math.sin(now * 0.45);
      keyDisplayMesh.rotation.z = 0.008 * Math.sin(now * 0.38 + 1.0) + curProfileRoll * 0.04;
      keyDisplayMesh.rotation.y = curProfileRoll * 0.12 + 0.01 * Math.sin(now * 0.32 + 0.7);
    }
    if (headTrackingActive) updateGestureBar();

    try {
      const renderRollOverlay = () => {
        if (!rollOverlayScene || !rollOverlayCamera || !roll3DGroup) return;
        rollOverlayCamera.position.x = 0.0;
        rollOverlayCamera.position.y = 0.0 + 0.008 * Math.sin(now * 0.2 + 0.5);
        rollOverlayCamera.position.z = 4.35 + 0.05 * Math.sin(now * 0.13 + 0.9);
        rollOverlayCamera.lookAt(0, -0.12, -1.9);
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(rollOverlayScene, rollOverlayCamera);
        renderer.autoClear = true;
      };
      if (postQuad && rtScene) {
        const pu = postQuad.material.uniforms;
        pu.tDiffuse.value = rtScene.texture;
        pu.time.value = now;
        pu.kaleidoFolds.value = currentKaleidoFolds;
        pu.kaleidoRotation.value = kaleidoRotation;
        pu.kaleidoMix.value = kaleidoMix;
        pu.chromaticOffset.value = Math.min(0.012, activeProfile.ca + touchIntensity * 0.0008 + dblFlash * 0.0012 + bassHit * 0.001 + micVisual * 0.001 + styleLsd * 0.0011 + styleCrossover * 0.0007);
        const focusBreath = keysPressed.size === 0 ? 0.04 * Math.sin(now * 0.1) : 0;
        const idleBreath = idleIntensity * (0.06 * Math.sin(now * 0.15) + 0.04);
        pu.textureLayerMix.value = idleIntensity * 0.72;
        pu.bloomStrength.value = Math.min(4.2, (activeProfile.bloom + dblFlash * 1.35 + touchIntensity * 0.5 + audioBoost * 1.0 + micVisual * 0.78 + focusBreath + idleBreath + gestureBloom + 0.06 * syncA + styleMuseum * 0.16 + styleCrossover * 0.14) * 0.76);
        pu.spiralAmt.value = Math.min(0.2, curSpiral * 0.11 + touchIntensity * 0.012 + trebleLevel * 0.016 + gestureSpiral * 0.08 + 0.004 * syncB + styleLsd * 0.01);
        pu.flowAmt.value = Math.min(1.24, curFlow + touchIntensity * 0.07 + 0.03 * syncA + styleMuseum * 0.1);
        pu.pulseAmt.value = Math.min(1.26, curPulse + midLevel * 0.12 + 0.022 * syncA + styleCrossover * 0.09);
        pu.shearAmt.value = Math.min(1.32, curShear + touchIntensity * 0.07 + 0.02 * syncB + styleMuseum * 0.06);
        pu.waveAmt.value = Math.min(1.32, curWave + trebleLevel * 0.14 + 0.026 * syncB + styleLsd * 0.12);
        pu.glitchAmt.value = Math.min(0.82, curGlitch + dblFlash * 0.26 + bassHit * 0.18 + gestureGlitch * 0.88 + styleLsd * 0.14 + styleCrossover * 0.08 + audioEnergy * 0.05 + touchIntensity * 0.04);
        pu.mirrorXY.value.set(curMirrorX, curMirrorY);
        pu.warpAmt.value = Math.min(1.12, curWarp + touchIntensity * 0.1 + midLevel * 0.12 + micVisual * 0.18 + gestureWarp * 0.82 + 0.02 * syncA + styleCrossover * 0.12 + styleLsd * 0.08);
        pu.contrastBoost.value = Math.min(3.2, Math.max(1.28, curContrast + 0.14 + dblFlash * 0.34 + impactFlash * 0.42 + bassHit * 0.24 + styleMuseum * 0.12 + styleCrossover * 0.14 + audioBoost * 0.08));
        pu.headLook.value.set(headOffset_g, headOffsetY);
        pu.themeHue.value = currentKeyHue;
        pu.prismAmt.value = Math.min(1.2, curPrism + styleCrossover * 0.16 + styleLsd * 0.08);
        pu.audioLevel.value = contourAudioLevel;
        pu.bioAmt.value = Math.min(1.0, curBio + styleCrossover * 0.12 + micVisual * 0.08);
        pu.impactFlash.value = Math.min(1.0, impactFlash + dblFlash * 0.12 + bassHit * 0.06);
        const pixelMixTarget = Math.min(1.0, PIXEL_MODE_VALUES[pixelModeIdx] * 0.9 + styleLsd * 0.07 + audioEnergy * 0.04);
        const analogMixTarget = Math.min(1.0, ANALOG_MODE_VALUES[analogModeIdx] * 0.92 + styleMuseum * 0.06 + midLevel * 0.04 + micVisual * 0.04);
        pu.pixelateMix.value += (pixelMixTarget - pu.pixelateMix.value) * 0.22;
        pu.analogMix.value += (analogMixTarget - pu.analogMix.value) * 0.22;
        pu.subpixelMix.value = Math.min(1.0, 0.3 + pu.pixelateMix.value * 0.56 + pu.analogMix.value * 0.24);
        pu.jitterMix.value = Math.min(1.0, 0.2 + pu.analogMix.value * 0.5 + curGlitch * 0.24 + styleLsd * 0.18 + touchIntensity * 0.08);
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(postScene, postCamera);
        renderRollOverlay();
      } else {
        renderer.render(scene, camera);
        renderRollOverlay();
      }
    } catch (e) {
      console.warn('Render error:', e && e.message ? e.message : e);
    }
  }
  animate();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGPGPU);
  else initGPGPU();
})();
