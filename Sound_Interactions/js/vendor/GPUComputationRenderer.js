import {
  Camera,
  ClampToEdgeWrapping,
  DataTexture,
  FloatType,
  Mesh,
  NearestFilter,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget
} from 'three';

function createShaderMaterial( computeFragmentShader, uniforms, sizeX, sizeY ) {
  uniforms = uniforms || {};
  const material = new ShaderMaterial( {
    uniforms: uniforms,
    vertexShader: 'void main() { gl_Position = vec4( position, 1.0 ); }',
    fragmentShader: computeFragmentShader
  } );
  material.defines = material.defines || {};
  material.defines.resolution = 'vec2( ' + sizeX.toFixed( 1 ) + ', ' + sizeY.toFixed( 1 ) + ' )';
  return material;
}

export class GPUComputationRenderer {
  constructor( sizeX, sizeY, renderer ) {
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.renderer = renderer;
    this.variables = [];
    this.currentTextureIndex = 0;
    this.dataType = FloatType;
    this.scene = new Scene();
    this.camera = new Camera();
    this.camera.position.z = 1;
    this.passThruUniforms = { passThruTexture: { value: null } };
    this.passThruShader = createShaderMaterial(
      'uniform sampler2D passThruTexture; void main() { vec2 uv = gl_FragCoord.xy / resolution.xy; gl_FragColor = texture2D( passThruTexture, uv ); }',
      this.passThruUniforms, sizeX, sizeY
    );
    this.mesh = new Mesh( new PlaneGeometry( 2, 2 ), this.passThruShader );
    this.scene.add( this.mesh );
  }

  setDataType( type ) {
    this.dataType = type;
    return this;
  }

  addVariable( variableName, computeFragmentShader, initialValueTexture ) {
    const material = createShaderMaterial( computeFragmentShader, {}, this.sizeX, this.sizeY );
    const variable = {
      name: variableName,
      initialValueTexture: initialValueTexture,
      material: material,
      dependencies: null,
      renderTargets: [],
      wrapS: null,
      wrapT: null,
      minFilter: NearestFilter,
      magFilter: NearestFilter
    };
    this.variables.push( variable );
    return variable;
  }

  setVariableDependencies( variable, dependencies ) {
    variable.dependencies = dependencies;
  }

  createRenderTarget( sizeXTex, sizeYTex, wrapS, wrapT, minFilter, magFilter ) {
    sizeXTex = sizeXTex || this.sizeX;
    sizeYTex = sizeYTex || this.sizeY;
    wrapS = wrapS || ClampToEdgeWrapping;
    wrapT = wrapT || ClampToEdgeWrapping;
    minFilter = minFilter || NearestFilter;
    magFilter = magFilter || NearestFilter;
    return new WebGLRenderTarget( sizeXTex, sizeYTex, {
      wrapS, wrapT, minFilter, magFilter,
      format: RGBAFormat,
      type: this.dataType,
      depthBuffer: false
    } );
  }

  createTexture() {
    const data = new Float32Array( this.sizeX * this.sizeY * 4 );
    const texture = new DataTexture( data, this.sizeX, this.sizeY, RGBAFormat, this.dataType );
    texture.needsUpdate = true;
    return texture;
  }

  renderTexture( input, output ) {
    this.passThruUniforms.passThruTexture.value = input;
    this.doRenderTarget( this.passThruShader, output );
    this.passThruUniforms.passThruTexture.value = null;
  }

  doRenderTarget( material, output ) {
    const renderer = this.renderer;
    const currentRT = renderer.getRenderTarget();
    const currentXr = renderer.xr.enabled;
    const currentShadow = renderer.shadowMap.autoUpdate;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    this.mesh.material = material;
    renderer.setRenderTarget( output );
    renderer.render( this.scene, this.camera );
    this.mesh.material = this.passThruShader;
    renderer.xr.enabled = currentXr;
    renderer.shadowMap.autoUpdate = currentShadow;
    renderer.setRenderTarget( currentRT );
  }

  init() {
    const renderer = this.renderer;
    if ( ! renderer.capabilities.isWebGL2 && ! renderer.extensions.has( 'OES_texture_float' ) ) {
      return 'No float texture support';
    }
    if ( renderer.capabilities.maxVertexTextures === 0 ) {
      return 'No vertex shader texture support';
    }
    for ( let i = 0; i < this.variables.length; i++ ) {
      const variable = this.variables[ i ];
      variable.renderTargets[ 0 ] = this.createRenderTarget( this.sizeX, this.sizeY, variable.wrapS, variable.wrapT, variable.minFilter, variable.magFilter );
      variable.renderTargets[ 1 ] = this.createRenderTarget( this.sizeX, this.sizeY, variable.wrapS, variable.wrapT, variable.minFilter, variable.magFilter );
      this.renderTexture( variable.initialValueTexture, variable.renderTargets[ 0 ] );
      this.renderTexture( variable.initialValueTexture, variable.renderTargets[ 1 ] );
      const material = variable.material;
      const uniforms = material.uniforms;
      if ( variable.dependencies ) {
        for ( let d = 0; d < variable.dependencies.length; d++ ) {
          const dep = variable.dependencies[ d ];
          uniforms[ dep.name ] = { value: null };
          material.fragmentShader = 'uniform sampler2D ' + dep.name + ';\n' + material.fragmentShader;
        }
      }
    }
    this.currentTextureIndex = 0;
    return null;
  }

  compute() {
    const cur = this.currentTextureIndex;
    const next = cur === 0 ? 1 : 0;
    for ( let i = 0; i < this.variables.length; i++ ) {
      const variable = this.variables[ i ];
      if ( variable.dependencies ) {
        for ( let d = 0; d < variable.dependencies.length; d++ ) {
          variable.material.uniforms[ variable.dependencies[ d ].name ].value = variable.dependencies[ d ].renderTargets[ cur ].texture;
        }
      }
      this.doRenderTarget( variable.material, variable.renderTargets[ next ] );
    }
    this.currentTextureIndex = next;
  }

  getCurrentRenderTarget( variable ) {
    return variable.renderTargets[ this.currentTextureIndex ];
  }
}
