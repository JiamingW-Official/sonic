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
    const out = { tunnel: 0, vertical: 0, central: 0, radiate: 0, speed: 0, plasma: 0, float: 0 };
    const keys = Object.keys(out);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const group = LAYER_GROUPS[k];
      let hit = 0;
      for (let j = 0; j < cols.length; j++) if (group.includes(cols[j])) hit++;
      const density = Math.pow(hit / Math.max(1, count), 0.82);
      const base = isKeyActive ? (0.18 + str * 1.02) : (0.08 + str * 0.36);
      out[k] = Math.max(0, Math.min(1, density * base));
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
  let burstRingTime = -1;
  let tunnelParticles, centralColumnParticles, radiatingParticles, speedLineParticles;
  let burstRingParticles, plasmaParticles, floatingParticleClouds, matrixSurfaceParticles, prismSpokeParticles, bgPlane;
  let keyDisplayCanvas, keyDisplayTexture, keyDisplayMesh;
  let keyDisplayReveal = 0; // 0..1 for reveal animation
  let displayedMidiNotes = []; // current MIDI chord for text display (every note)
  let composer, postScene, postCamera, postQuad, rtScene;
  const particleMatOpts = { transparent: true, sizeAttenuation: true, vertexColors: false, blending: THREE.AdditiveBlending, depthWrite: false };
  let noteRepeatOverlayEl = null;
  let noteRepeatRowEls = [];
  let noteRepeatSignature = '';
  let noteRepeatStyleEl = null;

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
            p=p*2.02+vec2(13.7,7.3);
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
              vec2 p=g+0.5+0.42*sin(o*6.2831+time*0.2)-f;
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
          float centerBlank=1.0-smoothstep(0.0,0.24,r);
          float outerMask=smoothstep(0.22,0.74,r)*(1.0-smoothstep(0.9,1.08,r));

          vec2 rc=rot(0.12*syncB+0.08*lvl)*c;
          float nA=fbm(rc*3.2+vec2(time*0.09,-time*0.06));
          float nB=fbm(rot(-0.32+0.14*syncA)*(c*4.9)+vec2(-time*0.07,time*0.05));
          float nC=fbm(vec2(a*2.3+time*0.18+lvl*0.5,r*7.8-time*0.15));
          vec2 v=voronoi(uv*vec2(8.0,5.8)+vec2(time*0.08,-time*0.06));
          float cell=1.0-smoothstep(0.06,0.24,v.x);
          float edge=1.0-smoothstep(0.008,0.03,v.y);

          float radialGridA=1.0-smoothstep(0.0,0.018,abs(fract((a/PI)*7.5+0.16*syncB)-0.5));
          float radialGridB=1.0-smoothstep(0.0,0.016,abs(fract(r*12.0+0.12*syncA)-0.5));
          float matrix=(1.0-smoothstep(0.0,0.04,abs(fract((uv.x+0.5*sin(time*0.05))*48.0)-0.5)))*
                       (1.0-smoothstep(0.0,0.13,abs(fract((uv.y+0.5*cos(time*0.04))*22.0)-0.5)));
          float lsdNoise=fbm(rot(0.52+0.18*syncA)*(c*(7.2+lvl*2.4))+vec2(time*0.24,-time*0.2));
          float lsdMeshA=1.0-smoothstep(0.0,0.02,abs(fract((a/PI)*(13.0+lvl*7.0)+lsdNoise*1.7+time*0.22)-0.5));
          float lsdMeshB=1.0-smoothstep(0.0,0.018,abs(fract(r*23.0-lsdNoise*2.1-time*0.26)-0.5));
          float lsdShard=pow(max(0.0,cos(a*(20.0+lvl*9.0)+time*0.44+sin(r*20.0-time*0.7))),9.0);

          float prismRing1=exp(-pow((r-(0.26+0.05*syncB))*7.3,2.0));
          float prismRing2=exp(-pow((r-(0.48+0.04*syncA))*8.2,2.0));
          float fanFold=pow(max(0.0,cos(a*(10.0+lvl*6.0)+time*0.24+sin(r*20.0-time*0.45))),8.0);

          vec3 base=mix(vec3(0.010,0.012,0.028),vec3(0.022,0.018,0.045),breathe);
          vec3 neb=hsl(activeHue,0.82,0.12)*nA+hsl(activeHue+0.16,0.72,0.10)*nB+hsl(activeHue+0.52,0.64,0.08)*nC;
          vec3 couture=hsl(activeHue+0.57,0.7,0.2)*pow(radialGridA,1.3)*(0.025+0.04*lvl);
          vec3 matrixCol=hsl(activeHue+0.21,0.44,0.24)*matrix*(0.018+0.03*(0.5+0.5*syncB)+0.03*lvl);
          vec3 cellCol=mix(hsl(activeHue+0.08,0.62,0.14),hsl(activeHue+0.64,0.56,0.16),0.5+0.5*sin(time*0.12))*cell*(0.03+0.06*lvl);
          vec3 ringCol=hsl(activeHue+0.1,0.72,0.24)*prismRing1*(0.24+0.12*lvl)+hsl(activeHue+0.48,0.68,0.22)*prismRing2*(0.18+0.1*lvl);
          vec3 fanCol=hsl(activeHue+0.34,0.6,0.24)*fanFold*prismRing2*(0.14+0.08*lvl);
          vec3 lsdDense=hsl(activeHue+0.62,0.72,0.24)*(lsdMeshA*0.58+lsdMeshB*0.42)*(0.026+0.05*lvl)*outerMask;
          vec3 lsdShards=hsl(activeHue+0.28,0.66,0.26)*lsdShard*(0.02+0.042*lvl)*outerMask;

          vec3 col=base+neb+couture+matrixCol+cellCol+ringCol+fanCol+lsdDense+lsdShards;
          col+=edge*mix(vec3(0.75,0.9,1.0),hsl(activeHue+0.2,0.5,0.3),0.55)*(0.045+0.06*lvl);

          float star1=step(0.9982,hash(floor(uv*vec2(420.0,250.0))));
          float star2=step(0.9987,hash(floor(uv*vec2(300.0,200.0)+41.0)));
          float twinkle=0.52+0.48*sin(time*2.0+hash(floor(uv*vec2(420.0,250.0)))*140.0);
          col+=(star1+star2*0.65)*0.11*vec3(0.86,0.92,1.0)*twinkle;

          col*=mix(1.0,0.28,smoothstep(0.0,0.96,r));
          col=mix(col, base+neb*0.58+ringCol*0.42, centerBlank*0.52);
          col*=1.0+0.09*(1.0-smoothstep(0.0,0.28,r));
          gl_FragColor=vec4(col,1.0);
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
    const keyDisplayGeo = new THREE.PlaneGeometry(2.1, 0.68);
    const keyDisplayMat = new THREE.MeshBasicMaterial({
      map: keyDisplayTexture,
      transparent: true,
      opacity: 0.94,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    keyDisplayMesh = new THREE.Mesh(keyDisplayGeo, keyDisplayMat);
    keyDisplayMesh.position.set(0, -0.22, 2.35);
    keyDisplayMesh.userData.baseY = -0.22;
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
          float ridgeNoise=0.12*sin((uv.x+uv.y)*26.0+time*0.28)+0.08*sin((uv.x-uv.y)*34.0-time*0.24);
          float mountain=(m1*1.0+m2*0.82+m3*0.68+ridgeNoise*0.22)*mountainHeight;
          float contourDensity=mix(16.0,34.0,reactiveVol);
          float contourMajor=(1.0-smoothstep(0.0,0.032,abs(fract(mountain*contourDensity)-0.5)))*0.56;
          float contourMinor=(1.0-smoothstep(0.0,0.018,abs(fract(mountain*contourDensity*0.46+0.18)-0.5)))*0.3;
          float contourRadial=(1.0-smoothstep(0.0,0.018,abs(fract((r*20.0+sin(a*3.0))*0.6)-0.5)))*0.2;
          float contour=contourMajor+contourMinor+contourRadial;
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
  let masterVolume = 0.4;
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
    { name:'Contour Prime', folds:7,  hue:0.01, bloom:2.40, ca:0.0046, spiral:0.02, flow:0.92, pulse:0.16, shear:0.08, wave:0.32, glitch:0.04, mx:0, my:0, warp:0.32, prism:0.76, bio:0.30, rot:0.00, contrast:2.20, in:0.90, out:0.60 },
    { name:'Glass Mandala', folds:28, hue:0.54, bloom:2.90, ca:0.0058, spiral:0.03, flow:0.18, pulse:0.26, shear:0.12, wave:0.14, glitch:0.05, mx:0, my:0, warp:0.26, prism:1.02, bio:0.34, rot:0.24, contrast:2.18, in:0.90, out:0.58 },
    { name:'Bio Topography', folds:4, hue:0.30, bloom:2.55, ca:0.0044, spiral:0.04, flow:0.82, pulse:0.66, shear:0.16, wave:0.34, glitch:0.08, mx:0, my:0, warp:0.46, prism:0.74, bio:0.92, rot:-0.10, contrast:2.06, in:0.90, out:0.58 },
    { name:'Prism Matrix',  folds:3,  hue:0.63, bloom:1.74, ca:0.0052, spiral:0.02, flow:0.22, pulse:0.20, shear:1.00, wave:0.26, glitch:0.52, mx:1, my:1, warp:0.30, prism:0.94, bio:0.24, rot:0.30, contrast:2.42, in:0.92, out:0.62 },
    { name:'Pulse Heart',   folds:6,  hue:0.95, bloom:3.12, ca:0.0054, spiral:0.03, flow:0.30, pulse:1.00, shear:0.12, wave:0.36, glitch:0.06, mx:0, my:0, warp:0.54, prism:0.78, bio:0.64, rot:-0.06, contrast:2.30, in:0.90, out:0.58 },
    { name:'Symmetry City', folds:0,  hue:0.58, bloom:1.38, ca:0.0034, spiral:0.01, flow:0.14, pulse:0.18, shear:0.96, wave:0.24, glitch:0.50, mx:1, my:1, warp:0.24, prism:0.82, bio:0.16, rot:0.34, contrast:2.40, in:0.92, out:0.64 },
    { name:'LSD Couture',   folds:17, hue:0.09, bloom:2.96, ca:0.0061, spiral:0.07, flow:0.56, pulse:0.48, shear:0.30, wave:0.46, glitch:0.28, mx:0, my:0, warp:0.66, prism:1.04, bio:0.72, rot:-0.20, contrast:2.22, in:0.90, out:0.58 },
    { name:'Crystal Mirror',folds:32, hue:0.72, bloom:3.04, ca:0.0062, spiral:0.02, flow:0.20, pulse:0.42, shear:0.24, wave:0.28, glitch:0.08, mx:1, my:0, warp:0.38, prism:1.06, bio:0.38, rot:0.26, contrast:2.14, in:0.90, out:0.58 },
    { name:'Radial Matrix', folds:2,  hue:0.42, bloom:1.98, ca:0.0042, spiral:0.03, flow:0.70, pulse:0.34, shear:0.46, wave:0.96, glitch:0.30, mx:1, my:0, warp:0.72, prism:0.74, bio:0.54, rot:-0.22, contrast:2.32, in:0.90, out:0.58 },
    { name:'Axis Lattice',  folds:11, hue:0.18, bloom:2.48, ca:0.0048, spiral:0.05, flow:0.34, pulse:0.40, shear:0.56, wave:0.30, glitch:0.24, mx:1, my:0, warp:0.44, prism:0.88, bio:0.34, rot:0.40, contrast:2.26, in:0.92, out:0.60 },
    { name:'Scan Luxe',     folds:0,  hue:0.02, bloom:2.04, ca:0.0064, spiral:0.01, flow:0.42, pulse:0.72, shear:0.34, wave:0.20, glitch:0.78, mx:0, my:0, warp:0.60, prism:0.82, bio:0.30, rot:-0.30, contrast:2.48, in:0.94, out:0.64 },
    { name:'Helix Tissue',  folds:14, hue:0.88, bloom:2.78, ca:0.0051, spiral:0.06, flow:0.38, pulse:0.62, shear:0.20, wave:0.52, glitch:0.12, mx:0, my:0, warp:0.68, prism:0.96, bio:0.80, rot:0.16, contrast:2.12, in:0.90, out:0.58 },
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
  // Drums: middle row A–L + ; and ' (11 pads, 2020s kit)
  const DRUM_KEYS = {
    KeyA: 'kick', KeyS: 'snare', KeyD: '808', KeyF: 'clap', KeyG: 'hatClosed', KeyH: 'hatOpen',
    KeyJ: 'rim', KeyK: 'snap', KeyL: 'tomLow', Semicolon: 'tomMid', Quote: 'ride'
  };
  const DRUM_KEY_ORDER = ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'];
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
  let drumGain = null; // drums route into the same premium bus for timbre consistency
  let leadDriveCurve = null;
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
    limiter.threshold.value = -7.2;
    limiter.knee.value = 0.2;
    limiter.ratio.value = 28;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.16;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume;
    drumGain = audioCtx.createGain();
    drumGain.gain.value = masterVolume;
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
    outputBusGain.gain.value = 0.84;

    masterGain.connect(mixAutoGain);
    drumGain.connect(mixAutoGain);
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

    // Reverb network: shorter, cleaner tail.
    const rev1 = audioCtx.createDelay(1); rev1.delayTime.value = 0.13;
    const rev2 = audioCtx.createDelay(1); rev2.delayTime.value = 0.18;
    const rev3 = audioCtx.createDelay(1); rev3.delayTime.value = 0.25;
    const revFb1 = audioCtx.createGain(); revFb1.gain.value = 0.22;
    const revFb2 = audioCtx.createGain(); revFb2.gain.value = 0.2;
    const revFb3 = audioCtx.createGain(); revFb3.gain.value = 0.18;
    rev1.connect(revFb1); revFb1.connect(rev1); // feedback loops
    rev2.connect(revFb2); revFb2.connect(rev2);
    rev3.connect(revFb3); revFb3.connect(rev3);
    const revFilter = audioCtx.createBiquadFilter();
    revFilter.type = 'lowpass'; revFilter.frequency.value = 5200;
    const revGain = audioCtx.createGain(); revGain.gain.value = 0.014;
    outputBusGain.connect(rev1); outputBusGain.connect(rev2); outputBusGain.connect(rev3);
    rev1.connect(revFilter); rev2.connect(revFilter); rev3.connect(revFilter);
    revFilter.connect(revGain);
    reverbNode = revGain;

    // High-end ping-pong shimmer: filtered echoes for richer sustain without muddy tails.
    const pingSend = audioCtx.createGain(); pingSend.gain.value = 0.07;
    const pingL = audioCtx.createDelay(0.8); pingL.delayTime.value = 0.19;
    const pingR = audioCtx.createDelay(0.8); pingR.delayTime.value = 0.27;
    const pingFbL = audioCtx.createGain(); pingFbL.gain.value = 0.19;
    const pingFbR = audioCtx.createGain(); pingFbR.gain.value = 0.17;
    const pingHP = audioCtx.createBiquadFilter(); pingHP.type = 'highpass'; pingHP.frequency.value = 980;
    const pingLP = audioCtx.createBiquadFilter(); pingLP.type = 'lowpass'; pingLP.frequency.value = 6400;
    const pingOut = audioCtx.createGain(); pingOut.gain.value = 0.09;
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
    const dryGain = audioCtx.createGain(); dryGain.gain.value = 0.72;
    outputBusGain.connect(dryGain);
    dryGain.connect(audioCtx.destination);
    merger.connect(audioCtx.destination);
    revGain.connect(audioCtx.destination);
    pingOut.connect(audioCtx.destination);
  }

  // --- Modern 2020s-style procedural drums (not overwhelming; sit in mix) ---
  const DRUM_GAIN = 0.5; // keep drums subtle so synth and ambient stay forward
  function playDrum(type) {
    if (!audioCtx || !drumGain) return;
    const now = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    gain.connect(drumGain);

    function noiseBurst(duration, filterFreq, type) {
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * duration, audioCtx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      const filter = audioCtx.createBiquadFilter();
      filter.type = type || 'highpass';
      filter.frequency.value = filterFreq;
      src.connect(filter);
      filter.connect(gain);
      src.start(now);
      src.stop(now + duration);
    }

    switch (type) {
      case 'kick': {
        gain.gain.setValueAtTime(0.85 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
        noiseBurst(0.02, 200, 'highpass');
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.25);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.3);
        break;
      }
      case 'snare': {
        noiseBurst(0.12, 800, 'highpass');
        const body = audioCtx.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(180, now);
        body.frequency.exponentialRampToValueAtTime(80, now + 0.1);
        body.connect(gain);
        gain.gain.setValueAtTime(0.6 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
        body.start(now);
        body.stop(now + 0.15);
        break;
      }
      case '808': {
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(65, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.06);
        osc.frequency.exponentialRampToValueAtTime(32, now + 0.5);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.75 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.35 * DRUM_GAIN, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.55);
        osc.start(now);
        osc.stop(now + 0.6);
        break;
      }
      case 'clap': {
        for (let i = 0; i < 5; i++) {
          const t = now + i * 0.012;
          const b = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.06, audioCtx.sampleRate);
          const d = b.getChannelData(0);
          for (let j = 0; j < d.length; j++) d[j] = (Math.random() * 2 - 1) * Math.exp(-j / (d.length * 0.15));
          const src = audioCtx.createBufferSource();
          src.buffer = b;
          const f = audioCtx.createBiquadFilter();
          f.type = 'highpass';
          f.frequency.value = 600;
          src.connect(f);
          f.connect(gain);
          src.start(t);
          src.stop(t + 0.06);
        }
        gain.gain.setValueAtTime(0.5 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        break;
      }
      case 'hatClosed': {
        const b = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.05, audioCtx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        const src = audioCtx.createBufferSource();
        src.buffer = b;
        const f = audioCtx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 7000;
        f.Q.value = 0.5;
        src.connect(f);
        f.connect(gain);
        gain.gain.setValueAtTime(0.4 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
        src.start(now);
        src.stop(now + 0.05);
        break;
      }
      case 'hatOpen': {
        const b = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.2, audioCtx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 2.5));
        const src = audioCtx.createBufferSource();
        src.buffer = b;
        const f = audioCtx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 9000;
        f.Q.value = 1;
        src.connect(f);
        f.connect(gain);
        gain.gain.setValueAtTime(0.35 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        src.start(now);
        src.stop(now + 0.2);
        break;
      }
      case 'rim': {
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(900, now);
        osc.frequency.exponentialRampToValueAtTime(400, now + 0.03);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.5 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);
        osc.start(now);
        osc.stop(now + 0.05);
        noiseBurst(0.015, 2000, 'highpass');
        break;
      }
      case 'snap': {
        const b = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.04, audioCtx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
        const src = audioCtx.createBufferSource();
        src.buffer = b;
        const f = audioCtx.createBiquadFilter();
        f.type = 'highpass';
        f.frequency.value = 1200;
        src.connect(f);
        f.connect(gain);
        gain.gain.setValueAtTime(0.55 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.035);
        src.start(now);
        src.stop(now + 0.04);
        break;
      }
      case 'tomLow': {
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.exponentialRampToValueAtTime(55, now + 0.15);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.6 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.22);
        break;
      }
      case 'tomMid': {
        const osc = audioCtx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(160, now);
        osc.frequency.exponentialRampToValueAtTime(90, now + 0.12);
        osc.connect(gain);
        gain.gain.setValueAtTime(0.55 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.16);
        osc.start(now);
        osc.stop(now + 0.18);
        break;
      }
      case 'ride': {
        gain.gain.setValueAtTime(0.38 * DRUM_GAIN, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.32);
        const b = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.35, audioCtx.sampleRate);
        const d = b.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (d.length * 3));
        const src = audioCtx.createBufferSource();
        src.buffer = b;
        const f = audioCtx.createBiquadFilter();
        f.type = 'bandpass';
        f.frequency.value = 10000;
        f.Q.value = 2;
        src.connect(f);
        f.connect(gain);
        src.start(now);
        src.stop(now + 0.35);
        const osc2 = audioCtx.createOscillator();
        osc2.type = 'sine';
        osc2.frequency.value = 5800;
        osc2.connect(gain);
        osc2.start(now);
        osc2.stop(now + 0.25);
        break;
      }
      default:
        break;
    }
  }

  function triggerVisualsForDrum(drumIndex) {
    initGPGPU();
    const col = drumIndex % GRID_COLS;
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
    burstRingTime = performance.now() * 0.001;
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
    const nActive = Math.max(1, Math.min(24, polyHintInput));
    // Keep one stable synth identity in MIDI playback: no architecture switches by poly.
    const ecoMode = false;
    const ultraEco = false;
    const harmonyMode = getHarmonyMode();
    const harmonyPolyLimit = fromMIDI ? 5 : 7;
    // Harmony is keyboard-only; MIDI should reproduce source notes cleanly and predictably.
    const harmonyEnabled = !fromMIDI && harmonyMode !== 'off' && nActive >= 2 && nActive <= harmonyPolyLimit;
    const harmonySemitone = harmonyEnabled ? getHarmonySemitone(harmonyMode, midi) : 0;
    const harmonyRatio = harmonyEnabled ? Math.pow(2, harmonySemitone / 12) : 1.0;

    const pitchNorm = clamp01((midi - 36) / 60);
    const velStable = 0.62 + 0.38 * Math.pow(velNorm, 0.82);
    const polyTrim = nActive > 1 ? 1 / (1 + Math.pow(nActive - 1, 1.08) * 0.16) : 1;
    const sourceTrim = fromMIDI ? 0.96 : 1.0;
    let peakGain = 0.31 * velStable * polyTrim * sourceTrim;
    if (harmonyEnabled) peakGain *= 0.95;
    peakGain = Math.max(0.07, Math.min(0.38, peakGain));

    const oscA = audioCtx.createOscillator();
    oscA.type = freq > 1300 ? 'triangle' : 'sawtooth';
    oscA.frequency.value = freq;
    oscA.detune.value = -2.2;
    const oscAGain = audioCtx.createGain();
    oscAGain.gain.value = 0.66;
    oscA.connect(oscAGain);

    const oscB = ultraEco ? null : audioCtx.createOscillator();
    const oscBGain = ultraEco ? null : audioCtx.createGain();
    if (oscB && oscBGain) {
      oscB.type = ecoMode ? 'triangle' : 'sawtooth';
      oscB.frequency.value = freq;
      oscB.detune.value = 2.4;
      oscBGain.gain.value = ecoMode ? 0.2 : 0.34;
      oscB.connect(oscBGain);
    }

    const subOsc = ultraEco ? null : audioCtx.createOscillator();
    const subGain = ultraEco ? null : audioCtx.createGain();
    if (subOsc && subGain) {
      subOsc.type = 'sine';
      subOsc.frequency.value = freq * 0.5;
      subGain.gain.value = Math.max(0.02, 0.1 - pitchNorm * 0.04);
      subOsc.connect(subGain);
    }

    const harmonyOsc = harmonyEnabled ? audioCtx.createOscillator() : null;
    const harmonyGain = harmonyEnabled ? audioCtx.createGain() : null;
    if (harmonyOsc && harmonyGain) {
      harmonyOsc.type = ecoMode ? 'triangle' : 'sawtooth';
      harmonyOsc.frequency.value = freq * harmonyRatio;
      harmonyOsc.detune.value = harmonyMode === 'ninth' ? 0.6 : 1.2;
      const harmonyBase = harmonyMode === 'ninth' ? 0.04 : 0.05;
      harmonyGain.gain.value = harmonyBase / Math.sqrt(Math.max(1, nActive));
      harmonyOsc.connect(harmonyGain);
    }

    const mixBus = audioCtx.createGain();
    mixBus.gain.value = 1.0;
    oscAGain.connect(mixBus);
    if (oscBGain) oscBGain.connect(mixBus);
    if (subGain) subGain.connect(mixBus);
    if (harmonyGain) harmonyGain.connect(mixBus);

    const voiceLowpass = audioCtx.createBiquadFilter();
    voiceLowpass.type = 'lowpass';
    const brightness = clamp01(0.42 + velNorm * 0.34 + (1 - pitchNorm) * 0.18 - Math.min(0.16, (nActive - 1) * 0.02));
    const lpStart = Math.min(9800, Math.max(1600, 1800 + brightness * 4200 + freq * 0.52));
    const lpSustain = Math.min(6800, Math.max(1200, 1300 + brightness * 2400 + freq * 0.26));
    voiceLowpass.frequency.setValueAtTime(lpStart, now);
    voiceLowpass.frequency.exponentialRampToValueAtTime(lpSustain, now + 0.09);
    voiceLowpass.Q.value = 0.8 + brightness * 0.22;

    const voiceHighpass = audioCtx.createBiquadFilter();
    voiceHighpass.type = 'highpass';
    voiceHighpass.frequency.value = Math.max(24, Math.min(110, freq * 0.09));
    voiceHighpass.Q.value = 0.72;

    const voiceDrive = audioCtx.createWaveShaper();
    if (!leadDriveCurve) {
      leadDriveCurve = new Float32Array(512);
      for (let i = 0; i < leadDriveCurve.length; i++) {
        const x = (i / (leadDriveCurve.length - 1)) * 2 - 1;
        leadDriveCurve[i] = Math.tanh(x * 1.5) * 0.98;
      }
    }
    voiceDrive.curve = leadDriveCurve;
    voiceDrive.oversample = '2x';

    const envGain = audioCtx.createGain();
    envGain.gain.value = 0;

    mixBus.connect(voiceLowpass);
    voiceLowpass.connect(voiceHighpass);
    voiceHighpass.connect(voiceDrive);
    voiceDrive.connect(envGain);

    let voiceOut = envGain;
    if (typeof audioCtx.createStereoPanner === 'function') {
      const voicePan = audioCtx.createStereoPanner();
      voicePan.pan.value = Math.max(-0.22, Math.min(0.22, (midi - 66) / 34));
      envGain.connect(voicePan);
      voiceOut = voicePan;
    }
    voiceOut.connect(masterGain);

    const attack = shortOnly ? 0.0035 : (sustained ? 0.007 : 0.005);
    const decay = shortOnly ? 0.07 : (sustained ? 0.11 : 0.085);
    const sustainAmt = shortOnly ? 0.18 : (sustained ? 0.46 : 0.28);
    const release = shortOnly ? 0.16 : (sustained ? 0.24 : 0.2);
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

    const oscNodes = [oscA];
    if (oscB) oscNodes.push(oscB);
    if (subOsc) oscNodes.push(subOsc);
    if (harmonyOsc) oscNodes.push(harmonyOsc);
    for (let i = 0; i < oscNodes.length; i++) oscNodes[i].start(now);

    const scheduledStop = hasScheduledDuration
      ? now + Math.max(0.02, opts.duration) + release + 0.03
      : releaseEnd + 0.03;
    if (hasScheduledDuration || shortOnly) {
      for (let i = 0; i < oscNodes.length; i++) {
        try { oscNodes[i].stop(scheduledStop); } catch (_) {}
      }
    }

    function stop() {
      const t = audioCtx.currentTime;
      envGain.gain.cancelScheduledValues(t);
      envGain.gain.setValueAtTime(envGain.gain.value, t);
      envGain.gain.setTargetAtTime(0, t, 0.012);
      for (let i = 0; i < oscNodes.length; i++) {
        try { oscNodes[i].stop(t + 0.05); } catch (_) {}
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
    initAudio,
    getAudioContext,
    updateKeyDisplayFromMidi: (notes) => { displayedMidiNotes = notes && notes.length ? notes.slice() : []; }
  });

  // Mode HUD: intentional, legible, minimal
  let hudEl = null;
  function createHud() {
    hudEl = document.createElement('div');
    hudEl.setAttribute('aria-live', 'polite');
    hudEl.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:1000;pointer-events:none;font:11px/1.5 "JetBrains Mono","IBM Plex Mono","SFMono-Regular","Menlo","Consolas",monospace;color:rgba(214,238,255,0.62);letter-spacing:0.04em;background:rgba(2,8,14,0.26);padding:6px 10px;border-radius:0;backdrop-filter:blur(6px)';
    document.body.appendChild(hudEl);
  }
  function updateHud() {
    if (!hudEl) createHud();
    const modes = [];
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
    if (chordCount > 1) modes.push('chord ×' + chordCount);
    hudEl.innerHTML = modes.join(' &nbsp;·&nbsp; ');
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
          <span style="color:rgba(255,255,255,0.5)">A–L ; '</span><span>鼓组</span>
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

    // Drum row: A–L, ;, '
    const drumType = DRUM_KEYS[key];
    if (drumType != null) {
      e.preventDefault();
      markUserAction();
      initAudio();
      initGPGPU();
      const drumIndex = DRUM_KEY_ORDER.indexOf(key);
      const col = drumIndex >= 0 ? drumIndex % GRID_COLS : 0;
      const drumMidi = cellToMidi(col, 1);
      playNote(drumMidi, false, 0.76);
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
    if (!keyDisplayCanvas || !keyDisplayTexture || !keyDisplayMesh) return;
    const hasKeys = keysPressed.size > 0;
    const hasMidi = displayedMidiNotes.length > 0;
    const targetReveal = (hasKeys || hasMidi) ? 1 : 0;
    keyDisplayReveal = smoothApproach(keyDisplayReveal, targetReveal, 0.66, 0.52);
    const visible = keyDisplayReveal > 0.02;
    keyDisplayMesh.visible = visible;
    if (visible) {
      const s = 0.97 + 0.03 * keyDisplayReveal;
      keyDisplayMesh.scale.set(s, s, 1);
      if (keyDisplayMesh.material) keyDisplayMesh.material.opacity = 0.74 + 0.14 * keyDisplayReveal;
    }
    const ctx = keyDisplayCanvas.getContext('2d');
    if (!ctx) return;
    const w = keyDisplayCanvas.width;
    const h = keyDisplayCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (!hasKeys && !hasMidi) {
      keyDisplayTexture.needsUpdate = true;
      return;
    }
    const hueDeg = Math.round(currentKeyHue * 360) % 360;
    const now = performance.now() * 0.001;
    const rhythmA = 0.5 + 0.5 * Math.sin(now * 0.45);
    const rhythmB = 0.5 + 0.5 * Math.sin(now * 0.38 + 1.0);
    const codeFont = `"JetBrains Mono","IBM Plex Mono","Fira Code","SFMono-Regular","Menlo","Consolas",monospace`;
    const txtFx = TEXT_GLITCH_VALUES[textModeIdx];
    ctx.imageSmoothingEnabled = false;
    const pairs = [];
    if (hasKeys) {
      keysPressed.forEach(k => {
        const midi = KEY_TO_NOTE[k];
        if (midi != null) pairs.push({ key: k, midi });
      });
      pairs.sort((a, b) => a.midi - b.midi);
    }
    const keyLabels = pairs.map(p => KEY_TO_LABEL[p.key] || p.key.replace('Key', ''));
    const keyNotes = pairs.map(p => midiToNoteName(p.midi));
    const sortedMidi = hasMidi ? [...displayedMidiNotes].sort((a, b) => a - b) : [];
    const midiLabels = sortedMidi.map(m => midiToNoteName(m));
    const ordered = collectOrderedActiveNotes();
    const letters = keyLabels.join('   ');
    const keyText = keyNotes.join(' · ');
    const midiText = midiLabels.join(' · ');

    const mergedText = ordered.map(n => midiToNoteName(n.midi)).join(' · ');
    const mergedDetail = ordered.map(n => `${n.src}:${midiToNoteName(n.midi)}`).join('   ');
    const summaryText = mergedText || (hasKeys ? keyText : midiText);
    const detailText = mergedDetail || (hasKeys && hasMidi && midiText && midiText !== keyText ? ('MIDI  ' + midiText) : '');
    const denseText = hasKeys && hasMidi
      ? (`KEY ${keyLabels.join(' | ')}   +   MIDI ${midiLabels.join(' | ')}`)
      : (hasKeys ? keyLabels.join(' | ') : midiLabels.join(' | '));
    const sourceText = hasKeys && hasMidi ? `<KEYBOARD + MIDI ${letters}>` : (hasKeys ? (`<KEY ${letters}>`) : '<MIDI STREAM>');
    const streamSeed = [sourceText, detailText, summaryText].filter(Boolean).join(' // ');

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const streamText = (`${streamSeed} // `).repeat(8 + textModeIdx * 4);
    const streamSpan = Math.max(420, w * 0.8);
    const scrollA = (now * (126 + textModeIdx * 34)) % streamSpan;
    const scrollB = (now * (88 + textModeIdx * 22)) % streamSpan;
    ctx.font = `640 ${12 + textModeIdx * 2}px ${codeFont}`;
    ctx.fillStyle = `hsla(${hueDeg}, 30%, 84%, ${0.44 + 0.18 * keyDisplayReveal})`;
    ctx.fillText(streamText, -scrollA, h * 0.2);
    ctx.fillText(streamText, -scrollA + streamSpan, h * 0.2);
    ctx.fillStyle = `hsla(${hueDeg}, 26%, 78%, ${0.32 + 0.16 * keyDisplayReveal})`;
    ctx.fillText(streamText, -streamSpan + scrollB, h * 0.27);
    ctx.fillText(streamText, scrollB, h * 0.27);

    ctx.textAlign = 'center';
    const summaryCount = Math.max(1, (summaryText ? summaryText.split('·').length : 1));
    const summarySize = Math.min(62 + textModeIdx * 4, 30 + Math.floor(240 / summaryCount) + textModeIdx * 2);
    const sourceSize = Math.max(15 + textModeIdx, Math.min(24 + textModeIdx, summarySize - 8));
    const denseSize = Math.max(11, sourceSize - 1);

    if (sourceText) {
      ctx.font = `650 ${sourceSize}px ${codeFont}`;
      ctx.fillStyle = `hsla(${hueDeg}, 30%, 88%, ${0.62 + 0.12 * keyDisplayReveal + rhythmA * 0.05})`;
      ctx.fillText(sourceText, w / 2, h * 0.41);
    }

    if (denseText) {
      ctx.font = `610 ${denseSize}px ${codeFont}`;
      ctx.fillStyle = `hsla(${hueDeg}, 24%, 82%, ${0.52 + 0.1 * keyDisplayReveal + rhythmB * 0.04})`;
      ctx.fillText(denseText, w / 2, h * 0.5);
    }

    if (summaryText) {
      const glitchJit = Math.sin(now * (16.0 + textModeIdx * 6.0) + summaryCount * 0.7) * (0.9 + 1.5 * txtFx);
      ctx.font = `760 ${summarySize}px ${codeFont}`;
      const offA = 1.2 + txtFx * 1.8;
      const offB = 1.2 + txtFx * 1.6;
      ctx.fillStyle = `hsla(${(hueDeg + 352) % 360}, 86%, 68%, ${0.16 + 0.12 * keyDisplayReveal})`;
      ctx.fillText(summaryText, w / 2 + offA + glitchJit, h * 0.64);
      ctx.fillStyle = `hsla(${(hueDeg + 18) % 360}, 86%, 72%, ${0.18 + 0.12 * keyDisplayReveal})`;
      ctx.fillText(summaryText, w / 2 - offB - glitchJit, h * 0.64);
      ctx.fillStyle = `hsla(${hueDeg}, 44%, 96%, ${0.9 + 0.08 * keyDisplayReveal})`;
      ctx.shadowBlur = 22 + 14 * keyDisplayReveal + txtFx * 4;
      ctx.shadowColor = `hsla(${hueDeg}, 72%, 68%, ${0.24 + 0.18 * keyDisplayReveal + txtFx * 0.04})`;
      ctx.fillText(summaryText, w / 2, h * 0.64);
      if (textModeIdx > 0) {
        const strips = 2 + textModeIdx * 2;
        for (let i = 0; i < strips; i++) {
          const y = h * 0.56 + ((i + 1) / (strips + 2)) * h * 0.16;
          const bandH = 2 + ((i + textModeIdx) % 3);
          const xShift = ((i % 2 === 0 ? 1 : -1) * (1.8 + txtFx * 2.6)) + Math.sin(now * (22 + i * 3.5)) * 1.2;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, y, w, bandH);
          ctx.clip();
          ctx.fillStyle = `hsla(${(hueDeg + 8) % 360}, 38%, 94%, ${0.3 + 0.15 * keyDisplayReveal})`;
          ctx.fillText(summaryText, w / 2 + xShift, h * 0.64);
          ctx.restore();
        }
      }
    }
    if (detailText) {
      ctx.font = `580 ${Math.max(11, sourceSize - 1)}px ${codeFont}`;
      ctx.fillStyle = `hsla(${hueDeg}, 22%, 82%, ${0.5 + 0.12 * keyDisplayReveal + rhythmB * 0.05})`;
      ctx.fillText(detailText, w / 2, h * 0.79);
    }

    const tags = [];
    if (hasKeys) tags.push('KEYBOARD');
    if (hasMidi) tags.push('MIDI');
    ctx.font = `700 11px ${codeFont}`;
    ctx.fillStyle = `hsla(${hueDeg}, 24%, 80%, ${0.4 + 0.12 * keyDisplayReveal + rhythmA * 0.06})`;
    ctx.fillText(tags.join('   •   '), w / 2, 16);
    ctx.shadowBlur = 0;
    keyDisplayTexture.needsUpdate = true;
  }

  function ensureNoteRepeatOverlay() {
    if (noteRepeatOverlayEl) return;
    if (!noteRepeatStyleEl) {
      noteRepeatStyleEl = document.createElement('style');
      noteRepeatStyleEl.textContent = `
        .note-row-terminal {
          position: absolute;
          overflow: hidden;
          padding-top: 9px;
        }
        .note-row-terminal::before {
          content: attr(data-stream);
          position: absolute;
          left: 0;
          right: 0;
          top: -2px;
          white-space: nowrap;
          overflow: hidden;
          font: 760 11px/1 "SFMono-Regular","Menlo","Consolas",monospace;
          letter-spacing: 0.1em;
          color: rgba(188, 234, 255, 0.5);
          text-shadow: 0 0 10px rgba(98, 180, 255, 0.26);
          animation: terminalFlow var(--terminal-speed, 5.8s) linear infinite;
          pointer-events: none;
        }
        .note-head-code {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 0;
          border-radius: 0;
          font: 860 22px/1.04 "SFMono-Regular","Menlo","Consolas",monospace;
          letter-spacing: 0.03em;
          background: transparent;
          position: relative;
          overflow: visible;
          animation: noteCodeJitter 0.9s steps(2,end) infinite;
          animation-delay: var(--gd, 0s);
        }
        .note-head-code .glyph-src {
          color: rgba(146, 215, 255, 0.66);
          font: 760 11px/1 "SFMono-Regular","Menlo","Consolas",monospace;
          letter-spacing: 0.06em;
        }
        .note-head-code .glyph-code {
          color: rgba(178,218,255,0.6);
          font: 680 11px/1 "SFMono-Regular","Menlo","Consolas",monospace;
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
          text-shadow: 0 0 12px rgba(128,190,255,0.36);
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
          font: 700 13px/1 "SFMono-Regular","Menlo","Consolas",monospace;
          letter-spacing: 0;
          animation: caretBlink 1s steps(2,end) infinite;
          text-shadow: 0 0 8px rgba(160, 225, 255, 0.45);
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
      { top: '9.5%', alpha: 0.98, blur: 0 },
      { top: '49%', alpha: 0.7, blur: 0.2 },
      { top: '84%', alpha: 0.56, blur: 0.35 }
    ];
    rows.forEach((cfg, idx) => {
      const row = document.createElement('div');
      if (idx === 0) row.classList.add('note-row-terminal');
      row.style.cssText = [
        'position:absolute',
        `top:${cfg.top}`,
        'left:4%',
        'right:4%',
        'display:flex',
        'flex-wrap:wrap',
        'gap:8px 10px',
        'justify-content:flex-start',
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
        font:780 19px/1.06 'JetBrains Mono','IBM Plex Mono','SFMono-Regular','Menlo','Consolas',monospace;
        letter-spacing:0.05em;
        color:hsla(${hueDeg},36%,96%,${a});
        background:transparent;
        text-shadow:0 0 8px hsla(${hueDeg},52%,70%,0.28);
      ">${srcTag}${txt}</span>`;
    }).join('');
    noteRepeatRowEls.forEach((row, idx) => {
      row.innerHTML = idx === 0 ? htmlHead : html;
      if (idx === 0) {
        row.setAttribute('data-stream', terminalStream);
        row.style.setProperty('--terminal-speed', `${Math.max(2.6, 5.8 - textModeIdx * 1.1)}s`);
      }
      row.style.transform = idx === 0 ? 'translateX(0%)' : (idx === 1 ? 'translateX(6%)' : 'translateX(-4%)');
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
    const midiActive = displayedMidiNotes && displayedMidiNotes.length > 0;
    if (midiActive) {
      // MIDI playback: fixed gain target to avoid audible pumping.
      const targetMidi = 0.92;
      mixAutoGain.gain.value += (targetMidi - mixAutoGain.gain.value) * 0.08;
      return;
    }
    const polyKeyboard = keysPressed.size + sustainedVoices.size * 0.35;
    const polyMidi = displayedMidiNotes.length;
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
      const m = 0.45 + tunnelW * 1.95;
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
          const scatter = 0.04 * Math.sin(now * 3 + i * 0.2) * (1 - t);
          arr[i] += scatter;
          arr[i+1] += scatter * 0.6;
          if (speedMotion === 1) {
            arr[i+1] += speedW * 0.04 * m * Math.sin(t * 12 + now * 2);
            arr[i+2] += speedW * 0.03 * m * Math.cos(t * 10 + now * 1.5);
          } else if (speedMotion === 2) {
            arr[i] += speedW * 0.03 * m * Math.sin(t * 15 + now * 2.5) * (1 - t);
            arr[i+2] += speedW * 0.03 * m * Math.cos(t * 12 + now * 2) * (1 - t);
          } else if (speedMotion === 3) {
            const band = Math.floor(t * 6) * 0.6 + now * 1.2;
            arr[i+1] += speedW * 0.025 * m * Math.sin(band) * (1 - t);
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
        const explode = isActive ? 0.1 : 0;
        for (let v = 0; v < VERT_COL_POINTS; v++) {
          const i = c * VERT_COL_POINTS + v;
          const t = v / (VERT_COL_POINTS - 1);
          const baseY = t * 1.6 - 0.8;
          const phase = c * 0.65 + v * 0.04 + colPhase * 1.5;
          const waveAmp = isActive ? 0.6 + 0.25 * Math.sin(colPhase + c) : 0.12;
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
            const arc = 0.22 * radius * Math.sin(branchT * 6.0 + now * 1.2 + branch * 0.35);
            arr[i*3]   = attractor.x + Math.cos(branchAngle) * radius + arc + jitter;
            arr[i*3+1] = attractor.y + branchT * 0.24 * Math.sin(now * 1.0 + branch) + off[i*3+1] * 0.25;
            arr[i*3+2] = attractor.z + Math.sin(branchAngle) * radius - arc * 0.7 + jitter * 0.6;
          } else if (plasmaMotion === 1) {
            arr[i*3]   = attractor.x + Math.cos(branchAngle) * radius + jitter * 0.5;
            arr[i*3+1] = attractor.y + branchT * 0.22 + off[i*3+1] * 0.15;
            arr[i*3+2] = attractor.z + Math.sin(branchAngle) * radius + jitter * 0.5;
          } else if (plasmaMotion === 2) {
            const liss = now * 1.0 + branch * 0.4;
            const lx = Math.sin(liss) * radius * 0.7;
            const lz = Math.sin(liss * 2 + 0.6) * radius * 0.5;
            arr[i*3]   = attractor.x + lx + Math.cos(branchAngle) * branchT * 0.15;
            arr[i*3+1] = attractor.y + branchT * 0.18 * Math.sin(now * 0.8 + branch);
            arr[i*3+2] = attractor.z + lz + Math.sin(branchAngle) * branchT * 0.15;
          } else {
            const drift = 0.05 * Math.sin(now * 0.6 + branch * 1.2) * branchT;
            const wobble = 0.16 * radius * Math.sin(now * 0.7 + branch * 1.1 + branchT * 8.0);
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
      if (postQuad && rtScene) {
        const pu = postQuad.material.uniforms;
        pu.tDiffuse.value = rtScene.texture;
        pu.time.value = now;
        pu.kaleidoFolds.value = currentKaleidoFolds;
        pu.kaleidoRotation.value = kaleidoRotation;
        pu.kaleidoMix.value = kaleidoMix;
        pu.chromaticOffset.value = Math.min(0.018, activeProfile.ca + touchIntensity * 0.0011 + dblFlash * 0.0018 + bassHit * 0.0014 + micVisual * 0.0013 + styleLsd * 0.0018 + styleCrossover * 0.0009);
        const focusBreath = keysPressed.size === 0 ? 0.04 * Math.sin(now * 0.1) : 0;
        const idleBreath = idleIntensity * (0.06 * Math.sin(now * 0.15) + 0.04);
        pu.textureLayerMix.value = idleIntensity;
        pu.bloomStrength.value = Math.min(4.2, (activeProfile.bloom + dblFlash * 1.35 + touchIntensity * 0.5 + audioBoost * 1.0 + micVisual * 0.78 + focusBreath + idleBreath + gestureBloom + 0.06 * syncA + styleMuseum * 0.16 + styleCrossover * 0.14) * 0.76);
        pu.spiralAmt.value = Math.min(0.32, curSpiral * 0.14 + touchIntensity * 0.018 + trebleLevel * 0.024 + gestureSpiral * 0.12 + 0.006 * syncB + styleLsd * 0.016);
        pu.flowAmt.value = Math.min(1.7, curFlow + touchIntensity * 0.1 + 0.04 * syncA + styleMuseum * 0.14);
        pu.pulseAmt.value = Math.min(1.7, curPulse + midLevel * 0.15 + 0.03 * syncA + styleCrossover * 0.12);
        pu.shearAmt.value = Math.min(1.8, curShear + touchIntensity * 0.1 + 0.03 * syncB + styleMuseum * 0.08);
        pu.waveAmt.value = Math.min(1.8, curWave + trebleLevel * 0.2 + 0.04 * syncB + styleLsd * 0.2);
        pu.glitchAmt.value = Math.min(1.25, curGlitch + dblFlash * 0.42 + bassHit * 0.28 + gestureGlitch + styleLsd * 0.22 + styleCrossover * 0.1 + audioEnergy * 0.08 + touchIntensity * 0.05);
        pu.mirrorXY.value.set(curMirrorX, curMirrorY);
        pu.warpAmt.value = Math.min(1.55, curWarp + touchIntensity * 0.14 + midLevel * 0.18 + micVisual * 0.24 + gestureWarp + 0.035 * syncA + styleCrossover * 0.18 + styleLsd * 0.12);
        pu.contrastBoost.value = Math.min(3.1, curContrast + dblFlash * 0.42 + bassHit * 0.34 + styleMuseum * 0.14 + styleCrossover * 0.12 + audioBoost * 0.06);
        pu.headLook.value.set(headOffset_g, headOffsetY);
        pu.themeHue.value = currentKeyHue;
        pu.prismAmt.value = Math.min(1.2, curPrism + styleCrossover * 0.16 + styleLsd * 0.08);
        pu.audioLevel.value = contourAudioLevel;
        pu.bioAmt.value = Math.min(1.0, curBio + styleCrossover * 0.12 + micVisual * 0.08);
        const pixelMixTarget = Math.min(1.0, PIXEL_MODE_VALUES[pixelModeIdx] + styleLsd * 0.09 + audioEnergy * 0.06);
        const analogMixTarget = Math.min(1.0, ANALOG_MODE_VALUES[analogModeIdx] + styleMuseum * 0.08 + midLevel * 0.06 + micVisual * 0.05);
        pu.pixelateMix.value += (pixelMixTarget - pu.pixelateMix.value) * 0.22;
        pu.analogMix.value += (analogMixTarget - pu.analogMix.value) * 0.22;
        pu.subpixelMix.value = Math.min(1.0, 0.3 + pu.pixelateMix.value * 0.56 + pu.analogMix.value * 0.24);
        pu.jitterMix.value = Math.min(1.0, 0.2 + pu.analogMix.value * 0.5 + curGlitch * 0.24 + styleLsd * 0.18 + touchIntensity * 0.08);
        renderer.setRenderTarget(rtScene);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(postScene, postCamera);
      } else {
        renderer.render(scene, camera);
      }
    } catch (e) {
      console.warn('Render error:', e && e.message ? e.message : e);
    }
  }
  animate();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGPGPU);
  else initGPGPU();
})();
