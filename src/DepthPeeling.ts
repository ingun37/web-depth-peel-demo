import {
  Camera,
  Color,
  DataTexture,
  DepthTexture,
  IUniform,
  Material,
  Mesh,
  NoBlending,
  Object3D,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass";

export class DepthPeeling {
  globalUniforms: {
    uPrevDepthTexture: IUniform;
    uPrevColorTexture: IUniform;
    uReciprocalScreenSize: IUniform;
  };
  underCompositeMaterial = new ShaderMaterial({
    vertexShader: `
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
		}`,
    fragmentShader: `
        uniform sampler2D tDst;
        uniform sampler2D tSrc;
        varying vec2 vUv;
        void main() {
          vec4 d = texture2D(tDst, vUv);
          vec4 s = texture2D(tSrc, vUv);
          vec3 c = d.a * d.xyz + (1.-d.a)*s.a*s.xyz;
          float a = s.a - s.a*d.a + d.a;
          gl_FragColor = vec4(c, a);
          // gl_FragColor = s;
        }`,
    uniforms: {
      tDst: { value: null },
      tSrc: { value: null },
    },
  });
  ping: [WebGLRenderTarget, WebGLRenderTarget];
  pong: [WebGLRenderTarget, WebGLRenderTarget];
  depth: number;
  one = new DataTexture(new Uint8Array([1, 1, 1, 1]), 1, 1);
  quad = new FullScreenQuad(this.underCompositeMaterial);
  blendingCache = new Map<Mesh, number>();
  screenSize = new Vector2();
  originalClearColor = new Color();

  constructor(p: { width: number; height: number; depth: number }) {
    this.globalUniforms = {
      uPrevDepthTexture: { value: null },
      uPrevColorTexture: { value: null },
      uReciprocalScreenSize: { value: new Vector2(1, 1) },
    };

    const makeRenderTargetTuple = (): [
      WebGLRenderTarget,
      WebGLRenderTarget
    ] => [
      new WebGLRenderTarget(p.width, p.height, {
        depthTexture: new DepthTexture(p.width, p.height),
      }),
      new WebGLRenderTarget(p.width, p.height),
    ];
    this.ping = makeRenderTargetTuple();
    this.pong = makeRenderTargetTuple();
    this.depth = p.depth;
  }

  prepare(scene: Scene) {
    scene.traverse((obj) => {
      if (obj instanceof Mesh && obj.material instanceof Material) {
        obj.material.onBeforeCompile = (shader) => {
          shader.uniforms.uReciprocalScreenSize =
            this.globalUniforms.uReciprocalScreenSize;
          shader.uniforms.uPrevDepthTexture =
            this.globalUniforms.uPrevDepthTexture;
          shader.fragmentShader = `
// --- DEPTH PEELING SHADER CHUNK (START)
uniform vec2 uReciprocalScreenSize;
uniform sampler2D uPrevDepthTexture;
// --- DEPTH PEELING SHADER CHUNK (END)
					${shader.fragmentShader}
				`;
          //peel depth
          shader.fragmentShader = shader.fragmentShader.replace(
            /}$/gm,
            `
// --- DEPTH PEELING SHADER CHUNK (START)
  vec2 screenPos = gl_FragCoord.xy * uReciprocalScreenSize;
  float prevDepth = texture2D(uPrevDepthTexture,screenPos).x;
  if( prevDepth + 0.00001 >= gl_FragCoord.z )
      discard;
// --- DEPTH PEELING SHADER CHUNK (END)
}
					`
          );
        };
        obj.material.needsUpdate = true;
      }
    });
  }

  render(
    renderer: WebGLRenderer,
    scene: Object3D,
    camera: Camera,
    renderTarget: WebGLRenderTarget | null | undefined
  ) {
    const originalRenderTarget = renderer.getRenderTarget();
    this.blendingCache.clear();

    forEachMesh(scene, (obj) => {
      this.blendingCache.set(obj, obj.material.blending);
      obj.material.blending = NoBlending;
    });

    renderer.getSize(this.screenSize);
    const width = this.screenSize.width;
    const height = this.screenSize.height;
    this.globalUniforms.uReciprocalScreenSize.value = new Vector2(
      1 / width,
      1 / height
    );

    const [layerA, compositeA] = this.ping;
    const [layerB, compositeB] = this.pong;
    renderer.getClearColor(this.originalClearColor);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(layerA);
    renderer.clear();
    renderer.setRenderTarget(compositeA);
    renderer.clear();

    const [, finalComposite] = new Array(this.depth).fill(0).reduce(
      (
        [prevDepth, prevComposite]: [WebGLRenderTarget, WebGLRenderTarget],
        _,
        idx
      ): [WebGLRenderTarget, WebGLRenderTarget] => {
        const otherLayer = prevDepth === layerA ? layerB : layerA;
        const otherComposite =
          prevComposite === compositeA ? compositeB : compositeA;
        this.globalUniforms.uPrevDepthTexture.value =
          idx === 0 ? this.one : prevDepth.depthTexture;
        renderer.setRenderTarget(otherLayer);
        renderer.clear();
        renderer.render(scene, camera);

        renderer.setRenderTarget(
          idx < this.depth - 1
            ? otherComposite // If it's not the final step then proceed ping-ponging
            : renderTarget // If it's the final step, and if renderTarget is given,
            ? renderTarget // ... then render to the given render Target
            : renderTarget === undefined // if render targen is undefined,
            ? otherComposite // ... then keep ping-ponging
            : null // or render to the main frame buffer
        );
        renderer.clear();
        this.underCompositeMaterial.uniforms.tDst.value = prevComposite.texture;
        this.underCompositeMaterial.uniforms.tSrc.value = otherLayer.texture;
        this.underCompositeMaterial.uniformsNeedUpdate = true;
        this.quad.render(renderer);
        return [otherLayer, otherComposite];
      },
      [layerA, compositeA]
    );

    renderer.setRenderTarget(originalRenderTarget);

    forEachMesh(scene, (mesh) => {
      mesh.material.blending = this.blendingCache.get(mesh)!;
    });
    return finalComposite;
  }
}

function forEachMesh(scene: Object3D, f: (mesh: Mesh<any, Material>) => void) {
  scene.traverse((obj) => {
    if (obj instanceof Mesh && obj.material instanceof Material) f(obj);
  });
}
