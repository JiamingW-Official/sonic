import * as THREE from 'three';
import { GPUComputationRenderer } from './vendor/GPUComputationRenderer.js';

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
    const m = snapToNatural(midi);
    const row = Math.max(0, Math.min(2, 2 - Math.floor((m - 48) / 12)));
    const st = m % 12;
    const colMap = { 0: 0, 2: 2, 4: 3, 5: 4, 7: 5, 9: 7, 11: 8 };
    return { col: colMap[st] !== undefined ? colMap[st] : 0, row };
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
  let burstRingTime = -1;
  let tunnelParticles, centralColumnParticles, radiatingParticles, speedLineParticles;
  let burstRingParticles, plasmaParticles, floatingParticleClouds, bgPlane;
  let keyDisplayCanvas, keyDisplayTexture, keyDisplayMesh;
  let keyDisplayReveal = 0; // 0..1 for reveal animation
  let composer, postScene, postCamera, postQuad, rtScene;
  const particleMatOpts = { transparent: true, sizeAttenuation: true, vertexColors: false, blending: THREE.AdditiveBlending, depthWrite: false };

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
    camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 3.4;

    // Background: dynamic aurora / nebula with stars
    const bgGeo = new THREE.PlaneGeometry(20, 20);
    const bgMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, activeHue: { value: 0.55 } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        #define PI 3.14159265359
        uniform float time; uniform float activeHue;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
        }
        float fbm(vec2 p){ float f=0.0; f+=0.5*noise(p); p*=2.01; f+=0.25*noise(p); p*=2.02; f+=0.125*noise(p); p*=2.03; f+=0.0625*noise(p); return f; }
        vec3 hsl(float h,float s,float l){ vec3 k=vec3(1.0,2.0/3.0,1.0/3.0); vec3 p=clamp(abs(fract(vec3(h)+k)*6.0-3.0)-1.0,0.0,1.0); return l*mix(vec3(1.0),p,s); }
        void main(){
          vec2 c=vUv-0.5; float d=length(c); float angle=atan(c.y,c.x); float t=time*0.12;
          float n1=fbm(vUv*3.0+vec2(t,-t*0.7));
          float n2=fbm(vUv*5.0+vec2(-t*0.8,t*0.5));
          float n3=fbm(vec2(angle*1.5+t,d*4.0-t*0.5));
          float aurora=sin(c.y*14.0+t*4.0+sin(c.x*5.0+t*2.0)*3.0)*0.5+0.5;
          aurora*=smoothstep(0.55,0.0,abs(c.y-0.08*sin(t*3.0+c.x*6.0)));
          vec3 col1=hsl(activeHue,0.78,0.09)*n1;
          vec3 col2=hsl(activeHue+0.32,0.7,0.08)*n2;
          vec3 col3=hsl(activeHue+0.58,0.72,0.07)*n3;
          vec3 auroraCol=hsl(activeHue+0.12,0.85,0.14)*aurora;
          vec3 base=vec3(0.02,0.01,0.05);
          vec3 col=base+col1+col2+col3+auroraCol;
          col*=mix(1.0,0.25,smoothstep(0.0,0.9,d));
          float star1=step(0.997,hash(floor(vUv*350.0)));
          float star2=step(0.998,hash(floor(vUv*200.0+42.0)));
          float twinkle=0.5+0.5*sin(time*3.5+hash(floor(vUv*350.0))*120.0);
          col+=(star1+star2*0.5)*0.14*vec3(0.85,0.9,1.0)*twinkle;
          gl_FragColor=vec4(col,1.0);
        }
      `,
      depthWrite: false, depthTest: false
    });
    bgPlane = new THREE.Mesh(bgGeo, bgMat);
    bgPlane.position.z = -8;
    scene.add(bgPlane);

    // --- 3D keyboard note display (canvas texture on plane)
    const keyDisplayWidth = 512;
    const keyDisplayHeight = 128;
    keyDisplayCanvas = document.createElement('canvas');
    keyDisplayCanvas.width = keyDisplayWidth;
    keyDisplayCanvas.height = keyDisplayHeight;
    keyDisplayTexture = new THREE.CanvasTexture(keyDisplayCanvas);
    keyDisplayTexture.minFilter = THREE.LinearFilter;
    keyDisplayTexture.magFilter = THREE.LinearFilter;
    const keyDisplayGeo = new THREE.PlaneGeometry(1.8, 0.45);
    const keyDisplayMat = new THREE.MeshBasicMaterial({
      map: keyDisplayTexture,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide
    });
    keyDisplayMesh = new THREE.Mesh(keyDisplayGeo, keyDisplayMat);
    keyDisplayMesh.position.set(0, -1.05, 2.2);
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
        chromaticOffset: { value: 0.005 },
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
        textureLayerMix: { value: 0.0 }
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
        varying vec2 vUv;

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

          // Flow: linear drift (not spiral) — stronger toward edges
          c+=flowAmt*vec2(sin(time*0.4)*0.04,cos(time*0.37)*0.03)*(0.2+r);
          r=length(c); a=atan(c.y,c.x);
          // Pulse: radial breathe in/out
          c*=1.0+pulseAmt*0.08*sin(time*1.2)*r;
          r=length(c); a=atan(c.y,c.x);
          // Shear: skew that evolves (lattice / parallelogram)
          float sx=shearAmt*0.18*sin(time*0.7); float sy=shearAmt*0.12*cos(time*0.9);
          c=vec2(c.x+c.y*sx,c.y+c.x*sy);
          r=length(c); a=atan(c.y,c.x);
          // Wave: sine displacement (ripple, not rotation)
          c+=waveAmt*vec2(sin(c.y*20.0+time*2.0)*0.02*r,sin(c.x*18.0+time*1.7)*0.02*r);
          r=length(c); a=atan(c.y,c.x);

          // Spiral twist with turbulence
          float spiralT=spiralAmt*(r*6.0+time*0.5+0.3*sin(r*8.0-time*2.0));
          a+=spiralT;
          c=vec2(cos(a),sin(a))*r;

          // Warp: barrel + wave + breathing
          float breath=1.0+warpAmt*(r*r*3.0+0.4*sin(a*3.0+time*2.0)+0.25*sin(a*7.0-time*3.0)+0.15*cos(r*12.0+time*1.5));
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
            vec2 shardOffset=(vec2(cellHash,cellHash2)-0.5)*0.04*dist; // more offset at edges
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

          // Glitch
          if(glitchAmt>0.01){
            float band=floor(res.y*40.0);
            float t2=floor(time*8.0);
            float h1=hash1(band*7.3+t2*3.1);
            float h2=hash1(band*13.7+t2*1.7);
            res.x+=sin(band*5.7+time*10.0)*glitchAmt*0.12;
            res.x+=step(0.9,h1)*glitchAmt*0.22*(h2-0.5);
            res.y+=step(0.96,hash1(t2*17.3))*glitchAmt*0.35*step(0.5,h1)*(h2-0.5);
          }

          return vec3(clamp(res,0.003,0.997),edge);
        }

        vec3 prismCA(sampler2D tex, vec2 uv, float off){
          vec2 dir=normalize(uv-0.5+1e-5); float d=length(uv-0.5);
          float s=off*(0.6+d*3.0);
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

        void main(){
          vec2 uv=vUv;
          vec3 dResult=distortWithEdge(uv);
          vec2 dUv=dResult.xy;
          float edgeFactor=dResult.z;
          vec2 finalUv=mix(uv,dUv,kaleidoMix);

          // Base scene with CA
          vec3 scene=prismCA(tDiffuse,finalUv,chromaticOffset+glitchAmt*0.003);

          // --- Optical edge: Fresnel refraction + dispersion ---
          if(edgeFactor>0.005){
            float eps=0.0015;
            vec2 dL=distortWithEdge(uv+vec2(-eps,0.0)).xy;
            vec2 dR=distortWithEdge(uv+vec2(eps,0.0)).xy;
            vec2 dU=distortWithEdge(uv+vec2(0.0,eps)).xy;
            vec2 dD=distortWithEdge(uv+vec2(0.0,-eps)).xy;
            vec2 grad=vec2(length(dR-dL),length(dU-dD));
            vec2 refDir=normalize(vec2(-grad.y,grad.x)+1e-5);
            float sp=0.008*edgeFactor*kaleidoMix;

            // 5-wavelength spectral dispersion at edges (realistic prism)
            float eR=texture2D(tDiffuse,finalUv+refDir*sp*2.0).r;
            float eY=(texture2D(tDiffuse,finalUv+refDir*sp*1.0).r+texture2D(tDiffuse,finalUv+refDir*sp*0.5).g)*0.5;
            float eG=texture2D(tDiffuse,finalUv).g;
            float eC=(texture2D(tDiffuse,finalUv-refDir*sp*0.5).g+texture2D(tDiffuse,finalUv-refDir*sp*1.0).b)*0.5;
            float eB=texture2D(tDiffuse,finalUv-refDir*sp*2.0).b;
            vec3 edgeSpec=vec3(mix(eR,eY,0.3),mix(eG,(eY+eC)*0.5,0.2),mix(eB,eC,0.3));

            // Fresnel: thin, bright, physically-based
            float fresnel=pow(edgeFactor,2.5)*0.5*kaleidoMix;

            scene=mix(scene,edgeSpec,edgeFactor*0.65*kaleidoMix);
            scene+=fresnel*vec3(1.0,0.98,0.95);
          }

          // Psychedelic hue rotation: edges shift color over time
          float hueOff=edgeFactor*0.8+sin(time*0.3+length(uv-0.5)*4.0)*0.15;
          scene=mix(scene,hueShift(scene,hueOff),edgeFactor*0.35*kaleidoMix);

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

          // Contrast + saturation (per-key, dramatic)
          float l=luma(col);
          col=mix(vec3(l),col,1.3); // saturation
          col=((col-0.5)*contrastBoost)+0.5;
          col=max(col,0.0);

          // Color inversion flash at high contrast (psychedelic)
          float invFlash=smoothstep(1.8,2.2,contrastBoost)*0.15;
          col=mix(col,1.0-col,invFlash*sin(time*4.0+l*6.0)*0.5+invFlash*0.5);

          // --- Subtle texture layers (contour, map, glyph, architecture) — only when textureLayerMix>0 ---
          if(textureLayerMix>0.005){
            vec2 c=uv-0.5; float r=length(c); float a=atan(c.y,c.x);
            float contour=0.0;
            vec2 f80=floor(uv*80.0+time*0.02);
            vec2 f40=floor(uv*40.0-time*0.01);
            float nElev=hash2(f80)+0.5*hash2(f40);
            float elev=sin(r*25.0+nElev*6.28)*0.5+0.5;
            contour+=(1.0-smoothstep(0.0,0.02,abs(fract(elev*12.0)-0.5)))*0.5;
            contour+=(1.0-smoothstep(0.0,0.015,abs(fract(r*18.0+sin(a*3.0)*2.0)-0.5)))*0.35;
            col+=contour*vec3(0.45,0.5,0.55)*textureLayerMix*0.06;

            float grid=0.0;
            vec2 g=uv*resolution.xy*0.12;
            float radialFade=1.0-smoothstep(0.2,0.5,r);
            grid+=(1.0-smoothstep(0.0,0.08,abs(fract(g.x)-0.5)))*radialFade;
            grid+=(1.0-smoothstep(0.0,0.08,abs(fract(g.y)-0.5)))*radialFade;
            col+=grid*vec3(0.35,0.4,0.45)*textureLayerMix*0.05;

            float glyph=0.0;
            vec2 cellOff=hash2v(vec2(floor(time*0.5),0.0))*10.0;
            vec2 cell=floor(uv*vec2(32.0,18.0)+cellOff);
            float gx=hash2(cell); float gy=hash2(cell+vec2(1.0,0.0));
            vec2 local=fract(uv*vec2(32.0,18.0)+cellOff)-0.5;
            if(gx>0.92) glyph+=(1.0-smoothstep(0.02,0.04,abs(local.x)))*(1.0-smoothstep(0.05,0.15,abs(local.y)));
            if(gy>0.94) glyph+=1.0-smoothstep(0.01,0.03,length(local-vec2(0.1,0)));
            col+=glyph*vec3(0.4,0.45,0.5)*textureLayerMix*0.055;

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
            col+=arch*vec3(0.38,0.42,0.48)*textureLayerMix*0.05;
          }

          // Film grain + scanlines
          float grain=(hash2(uv*vec2(time*90.0,time*73.0))-0.5)*0.03;
          float scan=sin(uv.y*resolution.y*3.14159)*0.008;
          col+=grain+scan;

          // Vignette (cinematic)
          float vig=1.0-smoothstep(0.15,1.0,length((uv-0.5)*1.8));
          col*=mix(0.3,1.0,vig);

          // Letterbox bars (cinematic 2.39:1 aspect)
          float aspect=resolution.x/resolution.y;
          float letterbox=smoothstep(0.0,0.008,uv.y-0.04)*smoothstep(0.0,0.008,0.96-uv.y);
          col*=letterbox;

          // ACES tone mapping
          col=(col*(2.51*col+0.03))/(col*(2.43*col+0.59)+0.14);

          // Cinematic grading: deep teal shadows, warm amber highlights
          float ll=luma(col);
          col*=mix(vec3(0.8,0.92,1.2),vec3(1.15,1.05,0.88),smoothstep(0.1,0.65,ll));

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
  let curContrast = 1.0, tgtContrast = 1.0;
  // Each key: unique distortion combo — spiral/flow/pulse/shear/wave for motion variety (not all spiral)
  const KEY_PROFILES = [
    { folds:8,  hue:0.0,   bloom:2.8, ca:0.012, spiral:0,   flow:0.9,  pulse:0,   shear:0,   wave:0,   glitch:0,   mx:0, my:0, warp:0,   contrast:1.85 }, // 0: RED — drift flow
    { folds:0,  hue:0.52,  bloom:0.9, ca:0.002, spiral:0,   flow:0,   pulse:0,   shear:0.8, wave:0,   glitch:2.2, mx:0, my:0, warp:0.2, contrast:2.1  }, // 1: CYAN — shear + glitch
    { folds:4,  hue:0.32,  bloom:2.2, ca:0.007, spiral:1.6, flow:0,   pulse:0,   shear:0,   wave:0,   glitch:0,   mx:0, my:0, warp:0,   contrast:1.15 }, // 2: GREEN — spiral
    { folds:24, hue:0.04,  bloom:3.2, ca:0.016, spiral:0,   flow:0,   pulse:0.7, shear:0,   wave:0,   glitch:0,   mx:0, my:0, warp:0,   contrast:1.9  }, // 3: WHITE — pulse breathe
    { folds:0,  hue:0.86,  bloom:0.7, ca:0.003, spiral:0,   flow:0,   pulse:0,   shear:0,   wave:0.6, glitch:0,   mx:1, my:1, warp:1.6, contrast:2.25 }, // 4: MAGENTA — wave + mirror + warp
    { folds:12, hue:0.48,  bloom:2.4, ca:0.01,  spiral:0.5, flow:0.4, pulse:0,   shear:0,   wave:0.3, glitch:0,   mx:0, my:0, warp:0,   contrast:1.35 }, // 5: TEAL — spiral + flow + wave
    { folds:0,  hue:0.1,   bloom:1.2, ca:0.004, spiral:0,   flow:0.6, pulse:0.4, shear:0.2, wave:0,   glitch:2.0, mx:0, my:0, warp:0.8, contrast:2.0  }, // 6: ORANGE — flow+pulse+shear+glitch
    { folds:6,  hue:0.7,   bloom:2.6, ca:0.009, spiral:0,   flow:0,   pulse:0.5, shear:0.6, wave:0,   glitch:0,   mx:1, my:0, warp:0,   contrast:1.25 }, // 7: PURPLE — pulse + shear + mirror
    { folds:28, hue:0.92,  bloom:3.4, ca:0.018, spiral:0.3, flow:0.3, pulse:0.2, shear:0,   wave:0.5, glitch:0,   mx:0, my:0, warp:0,   contrast:1.65 }, // 8: PINK — mixed motion
    { folds:0,  hue:0.4,   bloom:0.6, ca:0.002, spiral:0,   flow:0.8, pulse:0,   shear:0.4, wave:0,   glitch:1.0, mx:1, my:1, warp:0,   contrast:2.4  }, // 9: LIME — flow + shear
    { folds:10, hue:0.58, bloom:2.5, ca:0.011, spiral:0,   flow:0,   pulse:0.9, shear:0,   wave:0.4, glitch:0,   mx:0, my:0, warp:1.8, contrast:1.5  }, // 10: BLUE — pulse + wave + warp
    { folds:0,  hue:0.18,  bloom:1.8, ca:0.006, spiral:1.5, flow:0.2, pulse:0,   shear:0.3, wave:0.6, glitch:0.7, mx:1, my:0, warp:0,   contrast:1.95 }, // 11: GOLD — spiral+wave+shear
  ];
  let activeProfile = KEY_PROFILES[0];
  // Head tracking state
  let headRotationBias = 0;
  let headX = 0.5; // normalized 0..1, 0.5 = center
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
    gestureBarEl.style.cssText = 'position:fixed;top:38px;left:50%;transform:translateX(-50%);width:160px;height:6px;z-index:1000;pointer-events:none;background:rgba(0,0,0,0.35);border-radius:3px;overflow:hidden;border:1px solid rgba(255,255,255,0.08);opacity:0;transition:opacity 0.5s';
    gestureFillEl = document.createElement('div');
    gestureFillEl.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:50%;background:linear-gradient(90deg,rgba(120,80,255,0.5),rgba(200,120,255,0.6));border-radius:2px;transition:width 0.08s ease-out';
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
    const isFastSwipe = fastSwipeTime >= 0 && (performance.now() * 0.001 - fastSwipeTime) < FAST_SWIPE_DURATION;
    if (isFastSwipe) {
      gestureLabelEl.textContent = fastSwipeDir > 0 ? 'SWIPE →' : '← SWIPE';
      gestureLabelEl.style.color = 'rgba(255,200,100,0.95)';
    } else if (handMotion > 0.25) {
      gestureLabelEl.textContent = 'ACTIVE';
      gestureLabelEl.style.color = 'rgba(180,220,255,0.85)';
    } else {
      gestureLabelEl.textContent = 'NORMAL';
      gestureLabelEl.style.color = 'rgba(255,255,255,0.6)';
    }
    gestureKnobLabelEl.textContent = 'L← knob →R  ·  motion ' + (handKnob2 * 100 | 0) + '%';
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
    headBarEl.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);width:140px;height:4px;z-index:1000;pointer-events:none;background:rgba(255,255,255,0.08);border-radius:2px;overflow:visible;opacity:0;transition:opacity 0.5s';
    // Thin track line with subtle gradient
    const track = document.createElement('div');
    track.style.cssText = 'position:absolute;inset:0;border-radius:2px;background:linear-gradient(90deg,rgba(255,100,100,0.15),rgba(255,255,255,0.1) 50%,rgba(100,220,255,0.15))';
    headBarEl.appendChild(track);
    // Center tick
    const tick = document.createElement('div');
    tick.style.cssText = 'position:absolute;left:50%;top:-3px;width:1px;height:10px;background:rgba(255,255,255,0.2);transform:translateX(-50%)';
    headBarEl.appendChild(tick);
    // Moving dot — small, glowing
    headDotEl = document.createElement('div');
    headDotEl.style.cssText = 'position:absolute;width:8px;height:8px;border-radius:50%;background:#fff;box-shadow:0 0 8px 2px rgba(255,255,255,0.6);top:50%;left:50%;transform:translate(-50%,-50%);transition:left 0.04s linear,background 0.15s,box-shadow 0.15s';
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
      headVideo.style.cssText = 'position:fixed;bottom:8px;right:8px;width:120px;height:90px;opacity:0.3;z-index:999;border-radius:8px;pointer-events:none;transform:scaleX(-1)';
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
          rawX = 1 - cx;
          conf = 0.95;
          headX += (rawX - headX) * 0.45;
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

    // Very responsive lerp — track every small movement
    const lerpSpeed = 0.35 + conf * 0.4;
    headX += (rawX - headX) * lerpSpeed;
    headConfidence = conf;
    updateHeadBar();
  }

  // Synth: low octave Z–M (C3–B3), mid Q–P (C4–E5), high [ ] (F5, G5)
  const KEY_TO_NOTE = {
    KeyZ: 48, KeyX: 50, KeyC: 52, KeyV: 53, KeyB: 55, KeyN: 57, KeyM: 59,
    KeyQ: 60, KeyW: 62, KeyE: 64, KeyR: 65, KeyT: 67, KeyY: 69, KeyU: 71, KeyI: 72, KeyO: 74, KeyP: 76,
    BracketLeft: 77, BracketRight: 79
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
  let chordCount = 0; // how many notes active simultaneously

  function initAudio() {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Master chain: voices → compressor → master → (reverb + stereo delay + dry)
    compressor = audioCtx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    masterGain = audioCtx.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(compressor);

    // Stereo widener: two delays panned L/R
    const merger = audioCtx.createChannelMerger(2);
    chorusDelay1 = audioCtx.createDelay(0.05);
    chorusDelay1.delayTime.value = 0.012;
    chorusDelay2 = audioCtx.createDelay(0.05);
    chorusDelay2.delayTime.value = 0.018;
    const chorusGainL = audioCtx.createGain(); chorusGainL.gain.value = 0.3;
    const chorusGainR = audioCtx.createGain(); chorusGainR.gain.value = 0.3;
    compressor.connect(chorusDelay1);
    compressor.connect(chorusDelay2);
    chorusDelay1.connect(chorusGainL);
    chorusDelay2.connect(chorusGainR);
    chorusGainL.connect(merger, 0, 0);
    chorusGainR.connect(merger, 0, 1);

    // LFO modulates chorus delay for shimmer
    const chorusLfo = audioCtx.createOscillator();
    chorusLfo.frequency.value = 0.8;
    const chorusLfoGain = audioCtx.createGain();
    chorusLfoGain.gain.value = 0.003;
    chorusLfo.connect(chorusLfoGain);
    chorusLfoGain.connect(chorusDelay1.delayTime);
    chorusLfoGain.connect(chorusDelay2.delayTime);
    chorusLfo.start();

    // Convolution-like reverb (feedback delay network)
    const rev1 = audioCtx.createDelay(1); rev1.delayTime.value = 0.13;
    const rev2 = audioCtx.createDelay(1); rev2.delayTime.value = 0.19;
    const rev3 = audioCtx.createDelay(1); rev3.delayTime.value = 0.27;
    const revFb1 = audioCtx.createGain(); revFb1.gain.value = 0.45;
    const revFb2 = audioCtx.createGain(); revFb2.gain.value = 0.42;
    const revFb3 = audioCtx.createGain(); revFb3.gain.value = 0.38;
    rev1.connect(revFb1); revFb1.connect(rev1); // feedback loops
    rev2.connect(revFb2); revFb2.connect(rev2);
    rev3.connect(revFb3); revFb3.connect(rev3);
    const revFilter = audioCtx.createBiquadFilter();
    revFilter.type = 'lowpass'; revFilter.frequency.value = 4000;
    const revGain = audioCtx.createGain(); revGain.gain.value = 0.25;
    compressor.connect(rev1); compressor.connect(rev2); compressor.connect(rev3);
    rev1.connect(revFilter); rev2.connect(revFilter); rev3.connect(revFilter);
    revFilter.connect(revGain);

    // Ping-pong delay
    const pingDelay = audioCtx.createDelay(2); pingDelay.delayTime.value = 0.375;
    const pongDelay = audioCtx.createDelay(2); pongDelay.delayTime.value = 0.25;
    const pingFb = audioCtx.createGain(); pingFb.gain.value = 0.35;
    const pongFb = audioCtx.createGain(); pongFb.gain.value = 0.3;
    const pingGain = audioCtx.createGain(); pingGain.gain.value = 0.2;
    pingDelay.connect(pingFb); pingFb.connect(pongDelay);
    pongDelay.connect(pongFb); pongFb.connect(pingDelay);
    compressor.connect(pingDelay);

    // Mix to destination
    const dryGain = audioCtx.createGain(); dryGain.gain.value = 0.65;
    compressor.connect(dryGain);
    dryGain.connect(audioCtx.destination);
    merger.connect(audioCtx.destination);
    revGain.connect(audioCtx.destination);
    pingDelay.connect(pingGain);
    pongDelay.connect(pingGain);
    pingGain.connect(audioCtx.destination);
  }

  // --- Modern 2020s-style procedural drums (not overwhelming; sit in mix) ---
  const DRUM_GAIN = 0.5; // keep drums subtle so synth and ambient stay forward
  function playDrum(type) {
    if (!audioCtx || !masterGain) return;
    const now = audioCtx.currentTime;
    const gain = audioCtx.createGain();
    gain.gain.value = 0;
    gain.connect(masterGain);

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
    tgtContrast = activeProfile.contrast;
    burstRingTime = performance.now() * 0.001;
  }

  function createSynthVoice(midiNote, opts) {
    const midi = snapToNatural(midiNote);
    const sustained = !!opts.sustained;
    const velocity = opts.velocity != null ? opts.velocity : 0.8;
    const freq = midiToFreq(midi);
    const now = audioCtx.currentTime;

    // Rich multi-oscillator voice: saw + pulse + triangle sub + noise transient
    const osc1 = audioCtx.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = freq;
    osc1.detune.value = -6;

    const osc2 = audioCtx.createOscillator();
    osc2.type = 'sawtooth';
    osc2.frequency.value = freq;
    osc2.detune.value = 7; // slight detune for width

    const osc3 = audioCtx.createOscillator();
    osc3.type = 'square';
    osc3.frequency.value = freq;
    osc3.detune.value = 1;
    const osc3Gain = audioCtx.createGain();
    osc3Gain.gain.value = 0.15;
    osc3.connect(osc3Gain);

    const sub = audioCtx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.value = freq * 0.5;
    const subGain = audioCtx.createGain();
    subGain.gain.value = 0.2;
    sub.connect(subGain);

    // Filter: resonant lowpass with envelope
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    const filterBase = sustained ? 1200 : 2000;
    const filterPeak = sustained ? 4500 : 6000;
    filter.frequency.setValueAtTime(filterPeak, now);
    filter.frequency.exponentialRampToValueAtTime(filterBase, now + (sustained ? 0.3 : 0.15));
    filter.Q.value = sustained ? 3 : 5;

    // Amp envelope: softer attack for chords
    const nActive = keysPressed.size;
    const chordVel = velocity * (nActive > 1 ? 0.7 / Math.sqrt(nActive) : 1); // auto-balance chords
    const envGain = audioCtx.createGain();
    envGain.gain.value = 0;
    const a = sustained ? 0.02 : 0.005;
    const d = sustained ? 0.2 : 0.1;
    const s = sustained ? 0.5 : 0.15;
    const r = sustained ? 0.6 : 0.35;
    envGain.gain.setValueAtTime(0, now);
    envGain.gain.linearRampToValueAtTime(chordVel, now + a);
    envGain.gain.linearRampToValueAtTime(chordVel * s, now + a + d);
    if (!sustained) envGain.gain.linearRampToValueAtTime(0, now + a + d + r);

    // LFO for sustained notes (vibrato + filter wobble)
    if (sustained) {
      const vib = audioCtx.createOscillator(); vib.frequency.value = 4.5;
      const vibGain = audioCtx.createGain(); vibGain.gain.value = 3;
      vib.connect(vibGain); vibGain.connect(osc1.frequency); vibGain.connect(osc2.frequency);
      vib.start(now + 0.3); // delayed vibrato onset

      const filterLfo = audioCtx.createOscillator(); filterLfo.frequency.value = 1.8;
      const filterLfoGain = audioCtx.createGain(); filterLfoGain.gain.value = 800;
      filterLfo.connect(filterLfoGain); filterLfoGain.connect(filter.frequency);
      filterLfo.start(now);
    }

    osc1.connect(filter);
    osc2.connect(filter);
    osc3Gain.connect(filter);
    subGain.connect(filter);
    filter.connect(envGain);
    envGain.connect(masterGain);

    osc1.start(now); osc2.start(now); osc3.start(now); sub.start(now);

    function stop() {
      const t = audioCtx.currentTime;
      envGain.gain.cancelScheduledValues(t);
      envGain.gain.setValueAtTime(envGain.gain.value, t);
      envGain.gain.linearRampToValueAtTime(0, t + r);
      setTimeout(() => { try { osc1.stop(); osc2.stop(); osc3.stop(); sub.stop(); } catch (_) {} }, (r + 0.1) * 1000);
    }
    if (!sustained) setTimeout(() => { try { osc1.stop(); osc2.stop(); osc3.stop(); sub.stop(); } catch (_) {} }, (a + d + r + 0.1) * 1000);
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
    tgtContrast = activeProfile.contrast;
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
    tgtContrast = activeProfile.contrast;
    burstRingTime = performance.now() * 0.001;
  }

  // Mode HUD: intentional, legible, minimal
  let hudEl = null;
  function createHud() {
    hudEl = document.createElement('div');
    hudEl.setAttribute('aria-live', 'polite');
    hudEl.style.cssText = 'position:fixed;bottom:12px;left:12px;z-index:1000;pointer-events:none;font:10px/1.5 "SF Pro Text", "Segoe UI", system-ui, sans-serif;color:rgba(255,255,255,0.52);letter-spacing:0.04em;background:rgba(0,0,0,0.2);padding:6px 10px;border-radius:6px;backdrop-filter:blur(6px)';
    document.body.appendChild(hudEl);
  }
  function updateHud() {
    if (!hudEl) createHud();
    const modes = [];
    modes.push('[1] mic ' + (micEnabled ? 'ON' : 'off'));
    modes.push('[2] arp ' + (arpEnabled ? 'ON' : 'off'));
    modes.push('[3] cam ' + (gyroEnabled ? 'ON' : 'off'));
    modes.push('[4] ambient ' + (ambientMode ? 'ON' : 'off'));
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

    // Master volume − =
    if (key === 'Minus') {
      e.preventDefault();
      masterVolume = Math.max(0.05, masterVolume - 0.08);
      if (masterGain) masterGain.gain.value = masterVolume;
      showModeToast('Vol ' + (masterVolume * 100 | 0) + '%');
      return;
    }
    if (key === 'Equal' || key === 'NumpadAdd') {
      e.preventDefault();
      masterVolume = Math.min(1, masterVolume + 0.08);
      if (masterGain) masterGain.gain.value = masterVolume;
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
      playDrum(drumType);
      const drumIndex = DRUM_KEY_ORDER.indexOf(key);
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
      // Collect all active profiles and blend
      const activeProfiles = [];
      keysPressed.forEach(k => {
        const m = KEY_TO_NOTE[k];
        if (m != null) {
          const cell = midiToCell(m);
          activeProfiles.push(KEY_PROFILES[cell.col % KEY_PROFILES.length]);
        }
      });
      if (activeProfiles.length >= 2) {
        // Weighted average of all active profiles
        let bFolds=0, bBloom=0, bCa=0, bSpiral=0, bFlow=0, bPulse=0, bShear=0, bWave=0, bGlitch=0, bWarp=0, bContrast=0, bHue=0;
        let bMx=0, bMy=0;
        const w = 1 / activeProfiles.length;
        activeProfiles.forEach(p => {
          bFolds += p.folds * w;
          bBloom += p.bloom * w;
          bCa += p.ca * w;
          bSpiral += (p.spiral || 0) * w;
          bFlow += (p.flow || 0) * w;
          bPulse += (p.pulse || 0) * w;
          bShear += (p.shear || 0) * w;
          bWave += (p.wave || 0) * w;
          bGlitch += p.glitch * w;
          bWarp += p.warp * w;
          bContrast += p.contrast * w;
          bHue += p.hue * w;
          bMx = Math.max(bMx, p.mx);
          bMy = Math.max(bMy, p.my);
        });
        // Chord boost: more keys = more intensity (harmonious buildup)
        const chordBoost = 1 + (n - 1) * 0.15;
        targetKaleidoFolds = bFolds;
        targetKaleidoMix = Math.min(1, 0.88 + (n - 1) * 0.04);
        tgtSpiral = bSpiral * chordBoost;
        tgtFlow = bFlow * chordBoost;
        tgtPulse = bPulse * chordBoost;
        tgtShear = bShear * chordBoost;
        tgtWave = bWave * chordBoost;
        tgtGlitch = bGlitch * chordBoost;
        tgtMirrorX = bMx;
        tgtMirrorY = bMy;
        tgtWarp = bWarp * chordBoost;
        tgtContrast = Math.min(2.5, bContrast * chordBoost);
        currentKeyHue = bHue;
        activeProfile = { ...activeProfile, bloom: bBloom * chordBoost, ca: bCa * chordBoost };
      }
    }

    // Sparkle layer for 3+ keys
    if (n >= 3) {
      sparkleTime = performance.now() * 0.001;
      const highMidis = [84, 86, 88, 89, 91, 93, 95];
      for (let i = 0; i < 2; i++) createSynthVoice(highMidis[Math.floor(Math.random() * highMidis.length)], { sustained: false, velocity: 0.18 });
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
    if (isSustainNote(KEY_TO_NOTE[key])) {
      const stop = sustainedVoices.get(key);
      if (stop) { stop(); sustainedVoices.delete(key); }
    }
  }

  function updateKeyDisplay() {
    if (!keyDisplayCanvas || !keyDisplayTexture || !keyDisplayMesh) return;
    const targetReveal = keysPressed.size > 0 ? 1 : 0;
    keyDisplayReveal += (targetReveal - keyDisplayReveal) * 0.14;
    const visible = keyDisplayReveal > 0.02;
    keyDisplayMesh.visible = visible;
    if (visible) {
      const s = 0.88 + 0.12 * keyDisplayReveal;
      keyDisplayMesh.scale.set(s, s, 1);
      if (keyDisplayMesh.material) keyDisplayMesh.material.opacity = 0.92 * keyDisplayReveal;
    }
    const ctx = keyDisplayCanvas.getContext('2d');
    if (!ctx) return;
    const w = keyDisplayCanvas.width;
    const h = keyDisplayCanvas.height;
    ctx.clearRect(0, 0, w, h);
    if (keysPressed.size === 0) {
      keyDisplayTexture.needsUpdate = true;
      return;
    }
    const notes = [];
    keysPressed.forEach(k => {
      const midi = KEY_TO_NOTE[k];
      if (midi != null) notes.push(midi);
    });
    notes.sort((a, b) => a - b);
    const labels = notes.map(midiToNoteName);
    const text = labels.join('   ');
    const fontSize = Math.min(32, 18 + Math.floor(160 / (labels.length || 1)));
    ctx.font = `300 ${fontSize}px "SF Pro Display", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const hueDeg = Math.round(currentKeyHue * 360) % 360;
    ctx.fillStyle = `hsla(${hueDeg}, 65%, 92%, 0.95)`;
    ctx.strokeStyle = `rgba(255,255,255,0.4)`;
    ctx.lineWidth = 1.2;
    ctx.strokeText(text, w / 2, h / 2);
    ctx.fillText(text, w / 2, h / 2);
    keyDisplayTexture.needsUpdate = true;
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

  function initAnalyser() {
    if (analyser || !audioCtx) return;
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    analyserData = new Uint8Array(analyser.frequencyBinCount);
    if (compressor) compressor.connect(analyser);
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

    padLevel *= 0.96;
    if (keysPressed.size >= 5) padLevel = Math.max(padLevel, 0.55);
    const sparkleFlash = Math.max(0, 1 - (now - sparkleTime) / 0.55);
    mouseVelocity *= 0.9;
    touchIntensity = Math.min(1, mouseVelocity / 50);

    // Idle auto-play: build → hold → decay (capped so no infinite stacking / lag)
    const isIdle = keysPressed.size === 0 && attractor.strength < 0.06;
    const dt = 1 / 60;
    if (!isIdle) {
      idlePhase = 'rest';
      idleIntensity *= 0.92;
      idleTimer = 0;
    } else {
      if (idlePhase === 'rest') {
        idleTimer += dt;
        if (idleTimer >= IDLE_REST_SEC) { idlePhase = 'build'; idleTimer = 0; }
      } else if (idlePhase === 'build') {
        idleIntensity = Math.min(IDLE_CAP, idleIntensity + IDLE_BUILD_RATE);
        if (idleIntensity >= IDLE_CAP) { idlePhase = 'hold'; idleTimer = 0; }
      } else if (idlePhase === 'hold') {
        idleTimer += dt;
        if (idleTimer >= IDLE_HOLD_SEC) idlePhase = 'decay';
      } else if (idlePhase === 'decay') {
        idleIntensity = Math.max(0, idleIntensity - IDLE_DECAY_RATE);
        if (idleIntensity <= 0) { idlePhase = 'rest'; idleTimer = 0; }
      }
    }

    // Audio analyzer → bass/mid/treble levels
    updateAudioLevels();
    updateMicLevel();

    // Auto-ambient after idle
    if (!ambientMode && performance.now() - lastUserAction > AMBIENT_DELAY && audioCtx) {
      startAmbient();
    }

    // Gyro → head offset (if no camera tracking but gyro available)
    if (gyroEnabled && !headTrackingActive) {
      headX += (0.5 + gyroX * 0.4 - headX) * 0.15;
    }

    if (camera) {
      const targetFov = 52 / zoomLevel;
      camera.fov += (targetFov - camera.fov) * 0.05;
      camera.updateProjectionMatrix();
    }

    const dblFlash = Math.max(0, 1 - (now - lastDoubleTap) / 0.4);
    // Mic: smoothed + gated, scaled for intuitive visual range (not overwhelming)
    const micVisual = micLevelSmoothed * MIC_VISUAL_SCALE;
    const audioBoost = audioEnergy * 0.6 + micVisual * 0.9;
    const bassHit = bassLevel > 0.4 ? (bassLevel - 0.4) * 2.5 : 0;

    // Distortion interpolation — distinct per-key: slightly snappier so contrast is felt
    const lerpRate = 0.095;
    currentKaleidoFolds += (targetKaleidoFolds - currentKaleidoFolds) * lerpRate;
    kaleidoMix += (targetKaleidoMix - kaleidoMix) * 0.08;
    curSpiral += (tgtSpiral - curSpiral) * 0.11;
    curFlow += (tgtFlow - curFlow) * 0.11;
    curPulse += (tgtPulse - curPulse) * 0.11;
    curShear += (tgtShear - curShear) * 0.11;
    curWave += (tgtWave - curWave) * 0.11;
    curGlitch += (tgtGlitch - curGlitch) * 0.12;
    curMirrorX += (tgtMirrorX - curMirrorX) * 0.13;
    curMirrorY += (tgtMirrorY - curMirrorY) * 0.13;
    curWarp += (tgtWarp - curWarp) * 0.11;
    curContrast += (tgtContrast - curContrast) * 0.11;
    if (now >= visualFreezeUntil && attractor.strength < 0.05) {
      targetKaleidoMix = Math.max(0.1, targetKaleidoMix * 0.998);
      tgtGlitch *= 0.995; tgtSpiral *= 0.995; tgtFlow *= 0.995; tgtPulse *= 0.995; tgtShear *= 0.995; tgtWave *= 0.995; tgtWarp *= 0.995;
    }
    detectHeadPosition();
    const headOffset = headX - 0.5;
    headOffset_g = headOffset;

    // Gesture: hand = virtual knobs; fast swipe = one-shot burst
    const fastSwipeActive = fastSwipeTime >= 0 && (now - fastSwipeTime) < FAST_SWIPE_DURATION;
    if (fastSwipeActive) sparkleTime = now;
    const gestureWarp = handKnob1 * 0.4;       // hand L→R = warp amount
    const gestureBloom = handKnob2 * 0.5;      // hand motion = bloom lift
    const gestureSpiral = handKnob2 * 0.25;   // motion = spiral
    const gestureGlitch = fastSwipeActive ? 0.7 : 0;
    const gestureKaleidoBias = (handKnob1 - 0.5) * 0.06; // hand position tilts kaleido

    // Kaleidoscope UV angle: Endel-style gentle breathe
    const breathe = 0.015 * Math.sin(now * 0.15);
    const keyPush = attractor.strength > 0.05 ? 0.04 * Math.sin(now * 1.8) * attractor.strength : 0;
    const idleKaleido = idleIntensity * 0.025 * Math.sin(now * 0.2);
    const targetRotation = breathe + keyPush + gestureKaleidoBias + idleKaleido;
    kaleidoRotation += (targetRotation - kaleidoRotation) * 0.08;

    // Head → Y-axis yaw: Endel-style smooth, subtle pan
    if (camera) {
      const targetYaw = headOffset * 0.85;
      camera.rotation.y += (targetYaw - camera.rotation.y) * 0.1;
      camera.rotation.z *= 0.92;
      if (headTrackingActive) {
        const targetCamX = headOffset * 0.6;
        camera.position.x += (targetCamX - camera.position.x) * 0.09;
      }
    }

    if (bgPlane && bgPlane.material && bgPlane.material.uniforms) {
      bgPlane.material.uniforms.time.value = now;
      bgPlane.material.uniforms.activeHue.value = currentKeyHue;
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
    const keyHue = (activeCol / SPECTRUM_BAR_COUNT) * 0.75 + 0.4;
    // Per-key distinct scenes: each column drives different layer combo for clear contrast
    const colPhase = activeCol * 0.6 + now * 0.5;
    const on = (cols) => isKeyActive && cols.includes(activeCol);
    const tunnelOn = on([0, 5, 8]);
    const verticalOn = on([1, 5, 9]);
    const centralOn = on([2, 9]);
    const radiateOn = on([3, 8]);
    const speedOn = on([4, 10]);
    const plasmaOn = on([6, 10, 11]);
    const floatOn = on([7, 11]);

    if (tunnelParticles && tunnelParticles.geometry) {
      const posAttr = tunnelParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = tunnelParticles.userData.basePos;
      const m = tunnelOn ? 2.2 : 0.5;
      for (let i = 0; i < arr.length; i += 3) {
        const j = i / 3;
        const bx = base[i], by = base[i+1], bz = base[i+2];
        const shear = tunnelOn ? 0.2 * Math.sin(bz * 1.5 + colPhase * 2) : 0;
        const squash = 1 + (tunnelOn ? 0.35 * Math.sin(colPhase * 1.2 + j * 0.02) : 0);
        arr[i]   = bx * squash + 0.28 * m * Math.sin(colPhase + j * 0.03) + shear;
        arr[i+1] = by / squash + 0.25 * m * Math.cos(colPhase * 1.1 + j * 0.04 + bz * 0.5) + shear * 0.5;
        arr[i+2] = bz + 0.35 * m * Math.sin(colPhase * 0.9 + bz * 0.6) + (tunnelOn ? 0.25 * Math.cos(colPhase * 2 + j * 0.01) : 0);
      }
      posAttr.needsUpdate = true;
      tunnelParticles.material.opacity = tunnelOn ? (0.95 + 0.35 * Math.sin(colPhase) + str * 0.35) : 0.03;
      tunnelParticles.material.color.setHSL(currentKeyHue, 0.95, tunnelOn ? 0.9 : 0.35);
      tunnelParticles.material.size = 0.003 + (tunnelOn ? 0.0025 * Math.abs(Math.sin(colPhase * 2)) : 0);
    }

    if (centralColumnParticles && centralColumnParticles.geometry) {
      const posAttr = centralColumnParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const sustainGlow = Math.min(0.4, sustainedVoices.size * 0.1);
      // Lightning bolt / jagged column when active, DNA helix otherwise
      for (let v = 0; v < CENTRAL_COL_POINTS; v++) {
        const t = v / (CENTRAL_COL_POINTS - 1);
        const baseY = t * 1.8 - 0.9;
        if (centralOn) {
          // Jagged lightning: sharp random offsets
          const jag = 0.12 * Math.sin(v * 2.7 + now * 4) * Math.sin(v * 0.8 + now * 6);
          const branch = (v % 7 < 2) ? 0.08 * Math.sin(now * 5 + v) : 0;
          arr[v*3]   = jag + branch;
          arr[v*3+1] = baseY * (1.3 + 0.4 * Math.sin(now * 3));
          arr[v*3+2] = 0.08 * Math.cos(v * 1.9 + now * 3.5) + branch * 0.5;
        } else {
          // Gentle DNA helix
          const helixR = 0.04 + 0.01 * Math.sin(now * 0.8);
          arr[v*3]   = helixR * Math.sin(v * 0.15 + now * 0.8);
          arr[v*3+1] = baseY;
          arr[v*3+2] = helixR * Math.cos(v * 0.15 + now * 0.8);
        }
      }
      posAttr.needsUpdate = true;
      centralColumnParticles.material.opacity = centralOn ? (0.96 + sustainGlow + padLevel * 0.45) : 0.03;
      centralColumnParticles.material.color.setHSL(currentKeyHue + 0.1, 0.95, centralOn ? 0.92 : 0.4);
      centralColumnParticles.material.size = centralOn ? 0.004 + 0.002 * Math.abs(Math.sin(now * 4)) : 0.002;
    }

    if (radiatingParticles && radiatingParticles.geometry && radiatingParticles.userData.basePos) {
      const posAttr = radiatingParticles.geometry.attributes.position;
      const arr = posAttr.array;
      const base = radiatingParticles.userData.basePos;
      const motionStyle = (attractor.col || 0) % 4; // 0=spiral, 1=linear, 2=zigzag, 3=fan
      for (let i = 0; i < RADIATE_COUNT; i++) {
        const isActiveRay = isKeyActive;
        let curl = radiateOn ? 0.4 * Math.sin(colPhase * 2 + i * 0.5) : 0.05;
        let stretch = isActiveRay ? 1.85 + 0.75 * Math.sin(colPhase * 1.5 + i * 0.7) : 0.9;
        let bend = radiateOn ? 0.25 * Math.sin(i * 1.3 + colPhase) : 0;
        if (motionStyle === 1) { curl = 0.02; bend = 0; stretch *= 1.1; } // linear rays
        for (let k = 0; k < RADIATE_POINTS_PER_RAY; k++) {
          const idx = (i * RADIATE_POINTS_PER_RAY + k) * 3;
          const t = k / RADIATE_POINTS_PER_RAY;
          const zigzagBend = (motionStyle === 2 && radiateOn) ? 0.35 * (i % 2 === 0 ? 1 : -1) * Math.sin(t * 12 + now * 3) * t : 0;
          const curlAngle = curl * t * 3;
          const bx = base[idx], bz = base[idx+2];
          const cosC = Math.cos(curlAngle), sinC = Math.sin(curlAngle);
          const fanSpread = motionStyle === 3 && radiateOn ? 0.15 * Math.sin(now * 2 + i * 0.8) * t : 0;
          arr[idx]   = (bx * cosC - bz * sinC) * stretch + bend * t + zigzagBend + fanSpread + 0.05 * Math.sin(colPhase + k);
          arr[idx+1] = base[idx+1] + 0.07 * t * Math.sin(colPhase * 1.2 + i + k * 0.2) + bend * t * 0.5;
          arr[idx+2] = (bx * sinC + bz * cosC) * stretch + 0.05 * Math.cos(colPhase * 1.1 + k);
        }
      }
      posAttr.needsUpdate = true;
      radiatingParticles.material.opacity = radiateOn ? (0.92 + str * 0.4) : 0.03;
      radiatingParticles.material.size = 0.0026 + (radiateOn ? 0.0018 * Math.abs(Math.sin(colPhase * 2)) : 0);
    }

    if (boxWireframe && boxWireframe.material) {
      boxWireframe.material.opacity = 0.15 + 0.06 * Math.sin(now * 0.7) + str * 0.06;
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
        const m = speedOn ? 2.0 : 0.5;
        const phase = now * (3 + lineIdx * 0.15) + lineIdx * 0.4;
        arr[i]   = base[i] + 0.5 * m * Math.sin(phase) + diag * t * 0.15 * m;
        arr[i+1] = base[i+1] + diag * t * 0.2 * m + 0.12 * m * Math.cos(now * 3 + i * 0.01);
        arr[i+2] = base[i+2] + 0.25 * m * Math.sin(now * 1.5 + base[i+2] * 2);
        // Perpendicular wave (ribbon) for style 1/2; pulse bands for style 3
        if (speedOn) {
          const scatter = 0.08 * Math.sin(now * 5 + i * 0.3) * (1 - t);
          arr[i] += scatter;
          arr[i+1] += scatter * 0.7;
          if (speedMotion === 1) {
            arr[i+1] += 0.06 * m * Math.sin(t * 25 + now * 4);
            arr[i+2] += 0.04 * m * Math.cos(t * 20 + now * 3);
          } else if (speedMotion === 2) {
            arr[i] += 0.05 * m * Math.sin(t * 30 + now * 5) * (1 - t);
            arr[i+2] += 0.05 * m * Math.cos(t * 22 + now * 4) * (1 - t);
          } else if (speedMotion === 3) {
            const band = Math.floor(t * 8) * 0.5 + now * 2;
            arr[i+1] += 0.04 * m * Math.sin(band) * (1 - t);
          }
        }
      }
      posAttr.needsUpdate = true;
      speedLineParticles.material.opacity = speedOn ? (0.94 + 0.35 * Math.sin(colPhase) + str * 0.35) : 0.03;
      speedLineParticles.material.color.setHSL(currentKeyHue + 0.15, 0.95, speedOn ? 0.88 : 0.4);
      speedLineParticles.material.size = 0.002 + (speedOn ? 0.0015 * Math.abs(Math.sin(now * 3)) : 0);
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
      colPts.material.opacity = verticalOn ? (0.92 + str * 0.45) : 0.03;
      colPts.material.size = 0.0028 + (verticalOn ? 0.0016 * Math.abs(Math.sin(colPhase * 2)) : 0) + (isKeyActive ? 0.001 : 0);
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
      // Motion style by key: 0=spiral tendril, 1=linear burst, 2=figure-8, 3=noise drift
      const plasmaMotion = (attractor.col || 0) % 4;
      const sc = 0.7 + str * 1.4 + (plasmaOn ? 0.5 * Math.sin(now * 2.2) : 0);
      for (let i = 0; i < PLASMA_POINTS; i++) {
        const branch = Math.floor(i / 40);
        const branchT = (i % 40) / 40;
        const branchAngle = branch * 2.39996 + now * 0.3;
        if (plasmaOn) {
          const radius = branchT * 0.6 * sc;
          const jitter = 0.04 * Math.sin(i * 7.3 + now * 4);
          if (plasmaMotion === 0) {
            const twist = branchT * 3 + now * 2 + branch * 0.7;
            arr[i*3]   = attractor.x + Math.cos(branchAngle + twist) * radius + jitter;
            arr[i*3+1] = attractor.y + branchT * 0.3 * Math.sin(now * 1.5 + branch) + off[i*3+1] * 0.3;
            arr[i*3+2] = attractor.z + Math.sin(branchAngle + twist) * radius + jitter * 0.7;
          } else if (plasmaMotion === 1) {
            // Linear outward: no twist, straight rays
            arr[i*3]   = attractor.x + Math.cos(branchAngle) * radius + jitter * 0.5;
            arr[i*3+1] = attractor.y + branchT * 0.25 + off[i*3+1] * 0.2;
            arr[i*3+2] = attractor.z + Math.sin(branchAngle) * radius + jitter * 0.5;
          } else if (plasmaMotion === 2) {
            // Figure-8 (Lissajous) in XZ
            const liss = now * 1.2 + branch * 0.5;
            const lx = Math.sin(liss) * radius * 0.8;
            const lz = Math.sin(liss * 2 + 0.7) * radius * 0.6;
            arr[i*3]   = attractor.x + lx + Math.cos(branchAngle) * branchT * 0.2;
            arr[i*3+1] = attractor.y + branchT * 0.2 * Math.sin(now + branch);
            arr[i*3+2] = attractor.z + lz + Math.sin(branchAngle) * branchT * 0.2;
          } else {
            // Noise drift: slow drift per branch
            const drift = 0.08 * Math.sin(now * 0.8 + branch * 1.7) * branchT;
            const twist = branchT * 2 + now * 0.8;
            arr[i*3]   = attractor.x + Math.cos(branchAngle + twist) * radius * 0.7 + drift + off[i*3] * 0.2;
            arr[i*3+1] = attractor.y + branchT * 0.2 + 0.05 * Math.sin(now * 1.1 + branch * 2);
            arr[i*3+2] = attractor.z + Math.sin(branchAngle + twist) * radius * 0.7 + drift * 0.7 + off[i*3+2] * 0.2;
          }
        } else {
          arr[i*3]   = attractor.x + off[i*3] * sc * 0.5 + 0.015 * Math.sin(now * 1.5 + i);
          arr[i*3+1] = attractor.y + off[i*3+1] * sc * 0.5 + 0.015 * Math.cos(now * 1.3 + i);
          arr[i*3+2] = attractor.z + off[i*3+2] * sc * 0.5;
        }
      }
      posAttr.needsUpdate = true;
      plasmaParticles.material.opacity = plasmaOn ? (0.94 + padLevel * 0.35) : 0.02;
      plasmaParticles.material.color.setHSL(currentKeyHue + 0.2, 0.95, plasmaOn ? 0.9 : 0.35);
      plasmaParticles.material.size = 0.003 + (plasmaOn ? 0.003 * Math.min(1, str) : 0);
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
          const trailLen = floatOn ? 0.2 + 0.1 * str : 0.05;
          const trailOff = t * trailLen;
          const pastTime = now - trailOff * 2;
          const tcx = floatOn ? Math.sin(pastTime * sp * lissaA + ph) * r : cx;
          const tcz = floatOn ? Math.cos(pastTime * sp * lissaB + ph * 1.3) * r * 0.8 : cz;
          const tcy = floatOn ? 0.25 * Math.sin(pastTime * sp * 1.5 + o * 1.1) : cy;
          arr[idx]   = tcx + base[idx] * (1 - t * 0.5) + 0.02 * Math.sin(now * 1.8 + p * 0.2);
          arr[idx+1] = tcy + base[idx+1] * (1 - t * 0.5) + 0.02 * Math.sin(now * 1.2 + p * 0.15);
          arr[idx+2] = tcz + base[idx+2] * (1 - t * 0.5) + 0.02 * Math.cos(now * 1.5 + p * 0.18);
        }
      }
      posAttr.needsUpdate = true;
      floatPts.material.opacity = floatOn ? (0.9 + 0.45 * Math.sin(colPhase * 1.1) + str * 0.35) : 0.03;
      floatPts.material.size = 0.003 + (floatOn ? 0.0015 * Math.abs(Math.sin(now * 1.5)) : 0);
    }

    if (Math.floor(now * 6) % 1 === 0) updateHud();
    updateKeyDisplay();
    if (headTrackingActive) updateGestureBar();

    try {
      if (postQuad && rtScene) {
        const pu = postQuad.material.uniforms;
        pu.tDiffuse.value = rtScene.texture;
        pu.time.value = now;
        pu.kaleidoFolds.value = currentKaleidoFolds;
        pu.kaleidoRotation.value = kaleidoRotation;
        pu.kaleidoMix.value = kaleidoMix;
        pu.chromaticOffset.value = activeProfile.ca + touchIntensity * 0.005 + dblFlash * 0.008 + bassHit * 0.006 + micVisual * 0.006;
        const focusBreath = keysPressed.size === 0 ? 0.04 * Math.sin(now * 0.1) : 0;
        const idleBreath = idleIntensity * (0.06 * Math.sin(now * 0.15) + 0.04);
        pu.textureLayerMix.value = idleIntensity;
        pu.bloomStrength.value = activeProfile.bloom + dblFlash * 1.5 + touchIntensity * 0.5 + audioBoost * 1.0 + micVisual * 0.85 + focusBreath + idleBreath + gestureBloom;
        pu.spiralAmt.value = curSpiral + touchIntensity * 0.2 + trebleLevel * 0.3 + gestureSpiral;
        pu.flowAmt.value = curFlow + touchIntensity * 0.12;
        pu.pulseAmt.value = curPulse + midLevel * 0.15;
        pu.shearAmt.value = curShear + touchIntensity * 0.1;
        pu.waveAmt.value = curWave + trebleLevel * 0.2;
        pu.glitchAmt.value = curGlitch + dblFlash * 0.5 + bassHit * 0.4 + gestureGlitch;
        pu.mirrorXY.value.set(curMirrorX, curMirrorY);
        pu.warpAmt.value = curWarp + touchIntensity * 0.15 + midLevel * 0.2 + micVisual * 0.28 + gestureWarp;
        pu.contrastBoost.value = curContrast + dblFlash * 0.4 + bassHit * 0.3;
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
