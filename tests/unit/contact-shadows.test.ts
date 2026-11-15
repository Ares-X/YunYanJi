import {
  BufferGeometry, Color, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Scene, ShaderLib, WebGLRenderTarget,
} from 'three';
import type { Camera, ColorRepresentation, Material, WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { GroundContactShadows } from '../../src/render/GroundContactShadows';

function triangle(positions=[0,0,0,2,.2,0,0,.4,3]):BufferGeometry {
  return new BufferGeometry().setAttribute('position',new Float32BufferAttribute(positions,3));
}

function fixture() {
  const scene=new Scene();
  const ground=new Mesh(triangle([0,-2.10,0,2,-1.90,0,0,-1.35,3]),new MeshStandardMaterial());
  ground.name='marked-ground';ground.castShadow=true;ground.receiveShadow=true;
  ground.userData.yyjContactGround=true;
  ground.position.set(1,.25,3);ground.rotation.y=Math.PI/2;
  // A rebake must correct a former caster's receiver weights, not only create
  // the attribute on a fresh geometry.
  ground.geometry.setAttribute('aYyjContactReceiver',new Float32BufferAttribute([0,0,0],1));
  const parent=new Group();parent.position.set(4,5,-2);parent.add(ground);

  const caster=new Mesh(triangle(),new MeshStandardMaterial());
  caster.name='ordinary-caster';caster.castShadow=true;caster.receiveShadow=true;
  caster.position.set(5,3.8,1);
  caster.geometry.setAttribute('aYyjContactReceiver',new Float32BufferAttribute([1,1,1],1));
  const receiver=new Mesh(triangle(),new MeshStandardMaterial());
  receiver.name='ordinary-receiver';receiver.castShadow=false;receiver.receiveShadow=true;
  receiver.position.y=2;
  const alreadyHidden=new Mesh(triangle(),new MeshStandardMaterial());
  alreadyHidden.name='already-hidden';alreadyHidden.castShadow=true;alreadyHidden.visible=false;
  scene.add(parent,caster,receiver,alreadyHidden);

  const background=new Color(0x17304b),override=new MeshBasicMaterial();
  scene.background=background;scene.overrideMaterial=override;
  const meshes=[ground,caster,receiver,alreadyHidden];
  return{scene,ground,caster,receiver,alreadyHidden,background,override,meshes,
    heightAt:(x:number,z:number)=>2+x*.25-z*.1,
    dispose:()=>{meshes.forEach(mesh=>{mesh.geometry.dispose();mesh.material.dispose();});override.dispose();},
  };
}

interface Capture {
  visible:Record<string,boolean>;
  weights:Record<string,number[]>;
  target:WebGLRenderTarget|null;
  background:Scene['background'];
  override:Material|null;
  autoClear:boolean;
  shadows:boolean;
}

/** Only the stateful renderer boundary is stubbed; the bake and materials are real. */
function rendererStub(subject:ReturnType<typeof fixture>,failCapture=false) {
  const initialTarget=new WebGLRenderTarget(7,9);
  let target:WebGLRenderTarget|null=initialTarget;
  const clearColor=new Color(0x34506c);let clearAlpha=.37;
  const captures:Capture[]=[];
  const state={
    autoClear:false,shadowMap:{enabled:true},
    getRenderTarget:()=>target,
    setRenderTarget:(next:WebGLRenderTarget|null)=>{target=next;},
    getClearColor:(out:Color)=>out.copy(clearColor),
    getClearAlpha:()=>clearAlpha,
    setClearColor:(color:ColorRepresentation,alpha=1)=>{clearColor.set(color);clearAlpha=alpha;},
    render:(source:Scene,_camera:Camera)=>{
      if(source===subject.scene) {
        captures.push({
          visible:Object.fromEntries(subject.meshes.map(mesh=>[mesh.name,mesh.visible])),
          weights:Object.fromEntries(subject.meshes.map(mesh=>[mesh.name,
            Array.from(mesh.geometry.getAttribute('aYyjContactReceiver').array)])),
          target,background:source.background,override:source.overrideMaterial,
          autoClear:state.autoClear,shadows:state.shadowMap.enabled,
        });
        if(failCapture)throw new Error('simulated render failure');
      }
    },
  };
  const renderer=state as unknown as WebGLRenderer;
  const snapshot=()=>({target,color:clearColor.getHex(),alpha:clearAlpha,
    autoClear:state.autoClear,shadows:state.shadowMap.enabled});
  const original=snapshot();
  return{renderer,captures,snapshot,original,dispose:()=>initialTarget.dispose()};
}

function compileUniforms(material:MeshStandardMaterial,renderer:WebGLRenderer) {
  const shader={uniforms:{},vertexShader:ShaderLib.standard.vertexShader,
    fragmentShader:ShaderLib.standard.fragmentShader} as Parameters<Material['onBeforeCompile']>[0];
  material.onBeforeCompile(shader,renderer);
  return shader.uniforms;
}

function expectRestored(subject:ReturnType<typeof fixture>,stub:ReturnType<typeof rendererStub>) {
  expect(subject.meshes.map(mesh=>mesh.visible)).toEqual([true,true,true,false]);
  expect(subject.meshes.map(mesh=>mesh.castShadow)).toEqual([true,true,false,true]);
  expect(subject.meshes.map(mesh=>mesh.receiveShadow)).toEqual([true,true,true,false]);
  expect(subject.scene.background).toBe(subject.background);
  expect(subject.scene.overrideMaterial).toBe(subject.override);
  expect(stub.snapshot()).toEqual(stub.original);
}

describe('ground contact-shadow bake',()=>{
  it('excludes a marked terrain caster from its own field while receiving it over nonzero transformed terrain',()=>{
    const subject=fixture(),stub=rendererStub(subject),contact=new GroundContactShadows();
    try {
      contact.bake(stub.renderer,subject.scene,subject.heightAt);
      expect(stub.captures).toHaveLength(1);
      const capture=stub.captures[0]!;
      expect(capture.visible).toEqual({
        'marked-ground':false,'ordinary-caster':true,'ordinary-receiver':false,'already-hidden':false,
      });
      expect(capture.weights['marked-ground']).toEqual([1,1,1]);
      expect(capture.weights['ordinary-caster']).toEqual([0,0,0]);
      expect(capture.weights['ordinary-receiver']).toEqual([1,1,1]);
      expect(capture.background).toBeNull();
      expect(capture.override).not.toBe(subject.override);
      expect(capture.autoClear).toBe(true);expect(capture.shadows).toBe(false);

      // Ground vertices transform to (5,3.15,1), (5,3.35,-1),
      // (8,3.90,1). The bake must sample these world X/Z coordinates.
      const groundHeights=subject.ground.geometry.getAttribute('aYyjTerrainHeight');
      [3.15,3.35,3.90].forEach((expected,i)=>expect(groundHeights.getX(i)).toBeCloseTo(expected,5));
      const casterHeights=subject.caster.geometry.getAttribute('aYyjTerrainHeight');
      [3.15,3.65,2.85].forEach((expected,i)=>expect(casterHeights.getX(i)).toBeCloseTo(expected,5));
      // The caster's first vertex is .65m above local ground, not 3.8m
      // above a hard-coded zero plane.
      expect(subject.caster.position.y-casterHeights.getX(0)).toBeCloseTo(.65,5);

      const groundUniforms=compileUniforms(subject.ground.material,stub.renderer);
      const receiverUniforms=compileUniforms(subject.receiver.material,stub.renderer);
      expect(groundUniforms.uYyjContactMap!.value).toBe(capture.target!.texture);
      expect(receiverUniforms.uYyjContactMap!.value).toBe(capture.target!.texture);
      expect(groundUniforms.uYyjContactBounds!.value).toEqual(contact.bounds);
      expect(contact.bakes).toBe(1);
      expectRestored(subject,stub);
    } finally {contact.dispose();subject.dispose();stub.dispose();}
  });

  it('restores original visibility and renderer state when capture rendering fails',()=>{
    const subject=fixture(),stub=rendererStub(subject,true),contact=new GroundContactShadows();
    try {
      expect(()=>contact.bake(stub.renderer,subject.scene,subject.heightAt)).toThrow('simulated render failure');
      expect(stub.captures[0]!.visible['marked-ground']).toBe(false);
      expect(stub.captures[0]!.visible['ordinary-caster']).toBe(true);
      expect(contact.bakes).toBe(0);
      expectRestored(subject,stub);
    } finally {contact.dispose();subject.dispose();stub.dispose();}
  });
});
