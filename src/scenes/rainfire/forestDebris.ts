import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Group,
  IcosahedronGeometry, Mesh, MeshStandardMaterial, Vector3,
} from 'three';
import type { Vector4 } from 'three';
import { createRandom, hashSeed } from '../../core/random';
import { createForestEcology, FOREST_FINE_ROOT_RUNS, FOREST_ORGANIC_POCKETS } from './forestEcology';
import { createEarthContactSurface } from './earthMaterials';

type GroundHeight = (x: number, z: number) => number;
type Point = [number, number, number];
type Uv = [number, number];

/** Small, static world-space meshes are accumulated directly into three draws. */
class DebrisBatch {
  readonly positions: number[] = [];
  readonly colors: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  vertex(p: Point, color: Color, uv: Uv = [0, 0], shade = 1): number {
    const index = this.positions.length / 3;
    this.positions.push(...p);
    this.colors.push(color.r * shade, color.g * shade, color.b * shade);
    this.uvs.push(...uv);
    return index;
  }

  triangle(a: number, b: number, c: number): void { this.indices.push(a, b, c); }

  mesh(material: MeshStandardMaterial, name: string): Mesh {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(this.uvs, 2));
    geometry.setIndex(this.indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    // Centimetre litter gets contact from GTAO, not hundreds of shadow-map slivers.
    mesh.castShadow = false;
    return mesh;
  }
}

function fieldHash(x: number, z: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const detailShader = /* glsl */ `
  varying vec3 vDebrisWorld;
  varying vec2 vDebrisUv;
  float debrisHash(vec3 p) {
    p=fract(p*.1031); p+=dot(p,p.yzx+33.33);
    return fract((p.x+p.y)*p.z);
  }
  float debrisNoise(vec3 p) {
    vec3 i=floor(p),f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(mix(debrisHash(i),debrisHash(i+vec3(1,0,0)),f.x),
      mix(debrisHash(i+vec3(0,1,0)),debrisHash(i+vec3(1,1,0)),f.x),f.y),
      mix(mix(debrisHash(i+vec3(0,0,1)),debrisHash(i+vec3(1,0,1)),f.x),
      mix(debrisHash(i+vec3(0,1,1)),debrisHash(i+vec3(1,1,1)),f.x),f.y),f.z);
  }
`;

function createDebrisMaterial(kind: 'leaf' | 'wood' | 'gravel'): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: kind === 'gravel' ? .52 : .66,
    metalness: 0, dithering: true,
  });
  if (kind === 'leaf') material.side = DoubleSide;
  material.name = `forest-debris-${kind}`;
  const surface = kind === 'leaf' ? /* glsl */ `
    float isLeaf = step(0.0,vDebrisUv.y);
    float edge = abs(vDebrisUv.x-.5)*2.0;
    float veinAA=max(.006,fwidth(vDebrisUv.x)*.8);
    float spine = 1.0-smoothstep(.006,.012+veinAA,abs(vDebrisUv.x-.5));
    float veinPhase = fract(vDebrisUv.y*8.0-pow(edge,.83)*(.67+.09*sin(vDebrisUv.y*7.0)));
    float vein = (1.0-smoothstep(.024,.042+veinAA,min(veinPhase,1.0-veinPhase)))*(1.0-edge)*.62;
    float rot = smoothstep(.48,.76,debrisNoise(vDebrisWorld*74.0));
    float laminaWet = smoothstep(.32,.73,debrisNoise(vDebrisWorld*18.0));
    float livingLeaf=step(diffuseColor.r*1.04,diffuseColor.g);
    float cellular = debrisNoise(vDebrisWorld*390.0);
    diffuseColor.rgb *= .94+cellular*.12-rot*.17-laminaWet*.08*(1.0-livingLeaf);
    diffuseColor.rgb *= 1.0+(spine+vein)*.12*isLeaf;
    debrisRelief = mix((cellular-.5)*.0018,
      spine*.00024+vein*.00015+(cellular-.5)*.00010,isLeaf)*debrisDetail;
    debrisRoughness = mix(.18,.035-laminaWet*.19+rot*.065,isLeaf);
  ` : kind === 'wood' ? /* glsl */ `
    float grain=debrisNoise(vec3(vDebrisUv.x*31.0,vDebrisUv.y*7.0,2.4));
    float fibrous=debrisNoise(vec3(vDebrisUv.x*119.0,vDebrisUv.y*13.0,7.1));
    float split=(1.0-smoothstep(.025,.095,abs(grain-.42)))*debrisDetail;
    diffuseColor.rgb*=.86+grain*.30-split*.26;
    debrisRelief=((grain-.5)*.0018+(fibrous-.5)*.00055-split*.0014)*debrisDetail;
    debrisRoughness=(grain-.5)*.15;
  ` : /* glsl */ `
    float mineral=debrisNoise(vDebrisWorld*28.0);
    float fine=debrisNoise(vDebrisWorld*340.0);
    float quartz=smoothstep(.70,.83,debrisNoise(vDebrisWorld*127.0));
    diffuseColor.rgb*=.82+mineral*.31+(fine-.5)*.14+quartz*.16;
    debrisRelief=((fine-.5)*.00038+(mineral-.5)*.0008)*debrisDetail;
    debrisRoughness=(mineral-.5)*.20;
  `;
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDebrisWorld;\nvarying vec2 vDebrisUv;')
      .replace('#include <worldpos_vertex>', /* glsl */ `
        #include <worldpos_vertex>
        vDebrisWorld=(modelMatrix*vec4(transformed,1.0)).xyz;
        vDebrisUv=uv;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${detailShader}`)
      .replace('#include <color_fragment>', /* glsl */ `
        #include <color_fragment>
        float debrisDetail=1.0-smoothstep(.012,.055,max(length(dFdx(vDebrisWorld)),length(dFdy(vDebrisWorld))));
        float debrisRelief=0.0,debrisRoughness=0.0;
        ${surface}
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */ `
        #include <roughnessmap_fragment>
        roughnessFactor=clamp(roughnessFactor+debrisRoughness,.35,.90);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */ `
        #include <normal_fragment_maps>
        vec3 debrisDx=dFdx(-vViewPosition),debrisDy=dFdy(-vViewPosition);
        vec3 debrisCx=cross(debrisDy,normal),debrisCy=cross(normal,debrisDx);
        float debrisDet=dot(debrisDx,debrisCx);
        if(abs(debrisDet)>1e-8) {
          normal=normalize(abs(debrisDet)*normal-sign(debrisDet)*(dFdx(debrisRelief)*debrisCx+dFdy(debrisRelief)*debrisCy));
        }
      `)
      .replace('#include <lights_physical_fragment>', /* glsl */ `
        #include <lights_physical_fragment>
        vec3 debrisNormalChange=max(abs(dFdx(normal)),abs(dFdy(normal)));
        float debrisNormalVariance=min(.11,max(max(debrisNormalChange.x,debrisNormalChange.y),debrisNormalChange.z)*.28);
        material.roughness=min(1.0,sqrt(material.roughness*material.roughness+debrisNormalVariance));
      `);
  };
  material.customProgramCacheKey = () => `forest-litter-v3/${kind}`;
  return material;
}

function curledLeaf(
  batch: DebrisBatch, random: () => number, height: GroundHeight,
  x: number, z: number, length: number, color: Color, decay = 0,
): void {
  const detailed = length > .058 && Math.hypot(x - 1, z - 4.5) < 8.3;
  const segments = detailed ? 12 : 8, columns = detailed ? 5 : 3;
  const angle = random() * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
  const width = length * (.20 + random() * .13) * (1 - decay * .15);
  const curl = (.003 + random() * .021) * (1 - decay * .54), twist = (random() - .5) * .021;
  const phase = random() * Math.PI * 2, asymmetric = .82 + random() * .36;
  const lobed = random() < .29, foldAt = .32 + random() * .37;
  const hole = detailed && decay > .64 && random() < .43;
  const holeT = .30 + random() * .37, holeSide = (random() - .5) * .76;
  const rows: number[][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments, along = (t - .5) * length;
    const outline = Math.pow(Math.sin(Math.PI * t), .78) * (lobed ? .89 + .11 * Math.cos(t * Math.PI * 9 + phase) : 1);
    const edges = [0, 1].map(() => {
      const ragged = .86 - decay * .26 + random() * (.14 + decay * .26);
      return ragged * (random() < decay * .20 ? .35 + random() * .3 : 1);
    });
    const row: number[] = [];
    for (let j = 0; j < columns; j += 1) {
      const side = j / (columns - 1) * 2 - 1, edge = edges[side < 0 ? 0 : 1]!;
      const across = side * width * outline * (1 + (edge - 1) * Math.abs(side)) * (side < 0 ? asymmetric : 1);
      const px = x + c * along - s * across, pz = z + s * along + c * across;
      const crossCurl = Math.pow(Math.abs(side), 1.7) * Math.sin(Math.PI * t) * (curl * .65 + length * .018);
      const fold = Math.max(0, t - foldAt) * (1 - t) * curl * 1.8;
      const uplift = .0016 + curl * Math.pow(t, 3) + crossCurl + fold
        + twist * side * Math.sin(Math.PI * t) * .22 + Math.sin(t * 15 + phase + side) * .00065
        + (1 - Math.abs(side)) * Math.sin(Math.PI * t) * .00055;
      row.push(batch.vertex([px, height(px, pz) + Math.max(.0008, uplift), pz], color, [j / (columns - 1), t],
        .93 + .07 * Math.sin(Math.PI * t) + (Math.abs(side) < .1 ? .045 : -.025)));
    }
    rows.push(row);
  }
  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < columns - 1; j += 1) {
      const t = (i + .5) / segments, side = (j + .5) / (columns - 1) * 2 - 1;
      if (hole && ((t - holeT) / .105) ** 2 + ((side - holeSide) / .24) ** 2 < 1) continue;
      if (!detailed && random() < decay * .065 && i > 1 && i < segments - 1) continue;
      const a = rows[i]![j]!, b = rows[i + 1]![j]!, c0 = rows[i]![j + 1]!, d = rows[i + 1]![j + 1]!;
      batch.triangle(a, c0, b); batch.triangle(c0, d, b);
    }
  }
  if (detailed) {
    const tipX = x - c * length * .65, tipZ = z - s * length * .65;
    const rootX = x - c * length * .5, rootZ = z - s * length * .5, radius = .00048;
    const a = batch.vertex([tipX - s * radius, height(tipX, tipZ) + .001, tipZ + c * radius], color, [0, 0], .72);
    const b = batch.vertex([tipX + s * radius, height(tipX, tipZ) + .001, tipZ - c * radius], color, [1, 0], .72);
    const c0 = batch.vertex([rootX - s * radius, height(rootX, rootZ) + .0018, rootZ + c * radius], color, [0, 1]);
    const d = batch.vertex([rootX + s * radius, height(rootX, rootZ) + .0018, rootZ - c * radius], color, [1, 1]);
    batch.triangle(a, b, c0); batch.triangle(b, d, c0);
  }
}

function fallenTwig(
  batch: DebrisBatch, random: () => number, height: GroundHeight,
  x: number, z: number, length: number, radius: number, color: Color, angle = random() * Math.PI * 2,
): void {
  const segments = radius > .022 ? 5 : 3, sides = radius > .022 ? 7 : 5;
  const c = Math.cos(angle), s = Math.sin(angle), bend = (random() - .5) * length * .12;
  const rings: number[][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments, along = (t - .5) * length, lateral = Math.sin(Math.PI * t) * bend;
    const px = x + c * along - s * lateral, pz = z + s * along + c * lateral;
    const py = height(px, pz) + radius * .53 + Math.sin(Math.PI * t) * radius * .35;
    const ring: number[] = [];
    for (let j = 0; j < sides; j += 1) {
      const a = j / sides * Math.PI * 2;
      const r = radius * (.85 + random() * .22) * (1 - t * .31);
      const across = Math.cos(a) * r, up = Math.sin(a) * r;
      ring.push(batch.vertex([px - s * across, py + up, pz + c * across], color,
        [j / sides, t], up < 0 ? .64 : .86 + random() * .18));
    }
    rings.push(ring);
  }
  for (let i = 0; i < segments; i += 1) {
    for (let j = 0; j < sides; j += 1) {
      const j1 = (j + 1) % sides;
      const a = rings[i]![j]!, b = rings[i + 1]![j]!, c0 = rings[i]![j1]!, d = rings[i + 1]![j1]!;
      batch.triangle(a, b, c0); batch.triangle(c0, b, d);
    }
  }
  for (let j = 1; j < sides - 1; j += 1) {
    batch.triangle(rings[0]![0]!, rings[0]![j]!, rings[0]![j + 1]!);
    batch.triangle(rings[segments]![0]!, rings[segments]![j + 1]!, rings[segments]![j]!);
  }
}

function addFern(
  leaves: DebrisBatch, wood: DebrisBatch, random: () => number, height: GroundHeight,
  x: number, z: number, scale: number,
): void {
  const base = new Vector3(x, height(x, z) + .008, z);
  const stalkColor = new Color(0x4c5b31);
  const frondPalette = [0x52653b, 0x405732, 0x354b2e, 0x5b6337].map(c => new Color(c));
  const fronds = 6 + Math.floor(random() * 2);
  for (let f = 0; f < fronds; f += 1) {
    const leafColor = frondPalette[f % frondPalette.length]!;
    // The crown includes upright young growth, broad mature fronds and spent,
    // low-hanging fronds. Their azimuths are not a repeated radial wheel.
    const stage = f === 0 ? .08 : f === 1 ? .36 : .28 + random() * .72;
    const angle = random() * Math.PI * 2;
    const outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const sideways = new Vector3(-outward.z, 0, outward.x);
    const reach = scale * (.36 + stage * .63) * (.88 + random() * .25);
    const rise = scale * (.78 - stage * .36) * (.90 + random() * .22);
    const tipHeight = .85 * (1 - stage) * (1 - stage) + .055;
    const lateralBend = (random() - .5) * scale * .20, phase = random() * Math.PI * 2;
    const origin = base.clone().add(new Vector3((random() - .5) * .045, 0, (random() - .5) * .045));
    const center = (t: number) => {
      const b1 = 3 * (1 - t) * (1 - t) * t, b2 = 3 * (1 - t) * t * t, b3 = t * t * t;
      const p = origin.clone().addScaledVector(outward, reach * (.06 * b1 + .52 * b2 + b3))
        .addScaledVector(sideways, lateralBend * Math.sin(Math.PI * t) * t);
      p.y += rise * (.62 * b1 + 1.5 * b2 + tipHeight * b3);
      p.y = Math.max(p.y, height(p.x, p.z) + .007);
      return p;
    };
    const nodes = 20 + Math.floor(stage * 6);
    let previous = center(0);
    for (let i = 1; i <= nodes; i += 1) {
      const t = i / nodes, p = center(t);
      const half = .00155 * scale * (1 - t * .70);
      const a = wood.vertex([previous.x - sideways.x * half, previous.y, previous.z - sideways.z * half], stalkColor);
      const b = wood.vertex([previous.x + sideways.x * half, previous.y, previous.z + sideways.z * half], stalkColor);
      const c = wood.vertex([p.x - sideways.x * half, p.y, p.z - sideways.z * half], stalkColor);
      const d = wood.vertex([p.x + sideways.x * half, p.y, p.z + sideways.z * half], stalkColor);
      wood.triangle(a, b, c); wood.triangle(b, d, c);
      previous = p;
      if (i < 3 || i === nodes) continue;
      const pinnaLength = reach * .178 * Math.pow(Math.sin(Math.PI * (t * .94 + .03)), .85);
      for (const side of [-1, 1]) {
        const attachment = center(Math.min(.995, t + side * .006));
        const direction = sideways.clone().multiplyScalar(side).addScaledVector(outward, .25 + t * .40);
        direction.y = .20 - stage * .45 + Math.sin(i * .68 + phase) * .12;
        direction.normalize();
        const across = new Vector3(-direction.z, 0, direction.x);
        const length = pinnaLength * (.84 + random() * .25);
        const shade = .85 + random() * .16;
        const rows: number[][] = [];
        for (let j = 0; j <= 5; j += 1) {
          const u = j / 5, cp = attachment.clone().addScaledVector(direction, length * u)
            .addScaledVector(outward, length * u * u * .14);
          cp.y += Math.sin(u * Math.PI) * length * .10 - u * u * length * (.13 + stage * .14);
          const width = length * .073 * Math.pow(Math.sin(Math.PI * u), .82) * (j % 2 ? .87 : 1);
          const row: number[] = [];
          for (let k = 0; k < 2; k += 1) {
            const q = cp.clone().addScaledVector(across, (k * 2 - 1) * width);
            q.y += (k * 2 - 1) * width * Math.sin(phase + t * 5 + j * .7) * .65;
            row.push(leaves.vertex([q.x, q.y, q.z], leafColor, [k, u], shade * (.89 + .11 * Math.sin(Math.PI * u))));
          }
          rows.push(row);
        }
        for (let j = 0; j < 5; j += 1) {
          leaves.triangle(rows[j]![0]!, rows[j]![1]!, rows[j + 1]![0]!);
          leaves.triangle(rows[j]![1]!, rows[j + 1]![1]!, rows[j + 1]![0]!);
        }
      }
    }
  }
}

/** A bent woody shoot with a real round section, shared by the low understorey. */
function growingShoot(
  batch: DebrisBatch, curve: (t: number) => Vector3, radius: number, color: Color,
  segments = 5, sides = 5,
): void {
  const rings: number[][] = [];
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments, center = curve(t);
    const tangent = curve(Math.min(1, t + .002)).sub(curve(Math.max(0, t - .002))).normalize();
    const side = tangent.clone().cross(new Vector3(0, 1, 0));
    if (side.lengthSq() < .0001) side.set(1, 0, 0);
    side.normalize();
    const up = side.clone().cross(tangent).normalize(), r = radius * (1 - t * .79);
    const ring: number[] = [];
    for (let j = 0; j < sides; j += 1) {
      const angle = j / sides * Math.PI * 2;
      const p = center.clone().addScaledVector(side, Math.cos(angle) * r).addScaledVector(up, Math.sin(angle) * r);
      ring.push(batch.vertex([p.x, p.y, p.z], color, [j / sides, t], .83 + .13 * Math.sin(angle)));
    }
    rings.push(ring);
  }
  for (let i = 0; i < segments; i += 1) for (let j = 0; j < sides; j += 1) {
    const next = (j + 1) % sides;
    const a = rings[i]![j]!, b = rings[i + 1]![j]!, c = rings[i]![next]!, d = rings[i + 1]![next]!;
    batch.triangle(a, b, c); batch.triangle(c, b, d);
  }
}

/** Fold, twist and a curved midrib give every shrub leaf volume from every view. */
function shrubLeaf(
  batch: DebrisBatch, root: Vector3, direction: Vector3, length: number,
  color: Color, random: () => number,
): void {
  const axis = direction.clone().normalize(), across = axis.clone().cross(new Vector3(0, 1, 0));
  if (across.lengthSq() < .0001) across.set(1, 0, 0);
  across.normalize();
  const normal = across.clone().cross(axis).normalize();
  const roll = (random() - .5) * 1.5, side = across.clone().multiplyScalar(Math.cos(roll)).addScaledVector(normal, Math.sin(roll));
  const lift = side.clone().cross(axis).normalize();
  const width = length * (.18 + random() * .09), bend = (.07 + random() * .15) * length;
  const rows: number[][] = [], shade = .77 + random() * .29;
  for (let i = 0; i <= 4; i += 1) {
    const t = i / 4, center = root.clone().addScaledVector(axis, length * t)
      .addScaledVector(lift, Math.sin(Math.PI * t) * bend - t * t * bend * .65);
    const span = width * Math.pow(Math.sin(Math.PI * t), .72), row: number[] = [];
    for (let j = 0; j < 3; j += 1) {
      const edge = j - 1, p = center.clone().addScaledVector(side, span * edge);
      p.addScaledVector(lift, (j === 1 ? .0026 : -.0012) * Math.sin(Math.PI * t)
        + edge * span * Math.sin(t * 2.4 + roll) * .19);
      row.push(batch.vertex([p.x, p.y, p.z], color, [j / 2, t], shade * (.89 + t * .12)));
    }
    rows.push(row);
  }
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 2; j += 1) {
    batch.triangle(rows[i]![j]!, rows[i]![j + 1]!, rows[i + 1]![j]!);
    batch.triangle(rows[i]![j + 1]!, rows[i + 1]![j + 1]!, rows[i + 1]![j]!);
  }
}

function attachedMossColony(
  leaves: DebrisBatch, random: () => number, center: Vector3, radius: number, up: Vector3,
): void {
  const side = up.clone().cross(new Vector3(0, 0, 1)).normalize();
  const forward = side.clone().cross(up).normalize();
  const colors = [0x45552e, 0x526238, 0x37482a, 0x62643a].map(c => new Color(c));
  for (let shoot = 0; shoot < 24; shoot += 1) {
    const angle = random() * Math.PI * 2, r = Math.sqrt(random()) * radius;
    const root = center.clone().addScaledVector(side, Math.cos(angle) * r).addScaledVector(forward, Math.sin(angle) * r);
    root.addScaledVector(up, -.0015 + (1 - r / radius) * .0025);
    const rise = .005 + random() * .012, color = colors[shoot % colors.length]!;
    for (let leaflet = 0; leaflet < 3; leaflet += 1) {
      const a = angle + leaflet * 2.1, length = .0035 + random() * .0045;
      const direction = side.clone().multiplyScalar(Math.cos(a)).addScaledVector(forward, Math.sin(a));
      const cross = up.clone().cross(direction).normalize();
      const middle = root.clone().addScaledVector(up, rise * .52).addScaledVector(direction, length * .55);
      const tip = root.clone().addScaledVector(up, rise).addScaledVector(direction, length);
      const left = middle.clone().addScaledVector(cross, length * .21), right = middle.clone().addScaledVector(cross, -length * .21);
      const p = leaves.vertex([root.x, root.y, root.z], color, [.5, -1], .63);
      const q = leaves.vertex([left.x, left.y, left.z], color, [0, -1], .89);
      const r0 = leaves.vertex([right.x, right.y, right.z], color, [1, -1], .96);
      const s = leaves.vertex([tip.x, tip.y, tip.z], color, [.5, -1], 1.04);
      leaves.triangle(p, q, r0); leaves.triangle(q, s, r0);
    }
  }
}

function connectedFineRoots(
  leaves: DebrisBatch, wood: DebrisBatch, random: () => number, height: GroundHeight,
): { branches: number; litter: number } {
  const rootColor = new Color(0x514737), deadLeaf = new Color(0x51412d);
  let branches = 0, litter = 0;
  for (const [ax, az, bx, bz, radius] of FOREST_FINE_ROOT_RUNS) {
    const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
    const sx = -dz / length, sz = dx / length, bend = (random() - .5) * .42, phase = random() * 6.28;
    const curve = (t: number) => {
      const wander = Math.sin(Math.PI * t) * (bend + .075 * Math.sin(t * Math.PI * 2.4 + phase));
      const x = ax + dx * t + sx * wander;
      const z = az + dz * t + sz * wander;
      const r = radius * (1 - t * .79);
      const buried = .012 * Math.sin(t * Math.PI * 2 + phase) ** 2;
      return new Vector3(x, height(x, z) + r * (-.25 + .17 * Math.sin(Math.PI * t)) - buried - .016 * t ** 8, z);
    };
    growingShoot(wood, curve, radius, rootColor, 28, 12);
    branches += 1;
    for (let fork = 0; fork < 2; fork += 1) {
      const t = .30 + fork * .28, start = curve(t), sign = fork % 2 ? 1 : -1;
      const rx = dx / length * .55 + sx * sign * .75, rz = dz / length * .55 + sz * sign * .75;
      const reach = .66 + random() * .66, childRadius = radius * (1 - t * .79) * .34;
      const child = (u: number) => {
        const x = start.x + rx * reach * u + sx * Math.sin(Math.PI * u) * .055;
        const z = start.z + rz * reach * u + sz * Math.sin(Math.PI * u) * .055;
        const soil = height(x, z) - childRadius * (1 - u * .79) * .45 - .006 * u * (1 - u) - .010 * u ** 6;
        const blend = Math.min(1, u * 5);
        return new Vector3(x, start.y * (1 - blend) + soil * blend, z);
      };
      growingShoot(wood, child, childRadius, rootColor, 16, 8); branches += 1;
    }
    for (let colony = 0; colony < 6; colony += 1) {
      const t = .18 + colony * .10 + random() * .035, p = curve(t), r = radius * (1 - t * .79);
      p.y += r * .86;
      if (p.y < height(p.x, p.z) + .002) continue;
      const up = new Vector3(sx * .22, 1, sz * .22).normalize();
      attachedMossColony(leaves, random, p, .024 + random() * .025, up);
    }
    for (let leaf = 0; leaf < 8; leaf += 1) {
      const t = .22 + random() * .58, p = curve(t), side = random() < .5 ? -1 : 1;
      const offset = radius * (1 - t * .79) + .025 + random() * .09;
      const x = p.x + sx * offset * side, z = p.z + sz * offset * side;
      if (Math.hypot(x + .8, z + 1.6) < 1.14) continue;
      curledLeaf(leaves, random, height, x, z, .045 + random() * .055, deadLeaf, .72 + random() * .28);
      litter += 1;
    }
  }
  return { branches, litter };
}

function addWoodlandShrub(
  leaves: DebrisBatch, wood: DebrisBatch, random: () => number, height: GroundHeight,
  x: number, z: number, scale: number,
): void {
  const colony = new Vector3(x, height(x, z) + .005, z), branchColor = new Color(0x4a4833);
  const palette = [0x3d5635, 0x4d613b, 0x465739, 0x536140].map(c => new Color(c));
  const shoots = 5 + Math.floor(random() * 2);
  for (let shoot = 0; shoot < shoots; shoot += 1) {
    const angle = random() * Math.PI * 2, outward = new Vector3(Math.cos(angle), 0, Math.sin(angle));
    const side = new Vector3(-outward.z, 0, outward.x);
    const lateral = Math.sqrt(random()) * scale * .48;
    const origin = colony.clone().addScaledVector(outward, lateral);
    origin.y = height(origin.x, origin.z) + .006;
    if (shoot > 0) {
      const runner = (t: number) => {
        const p = colony.clone().lerp(origin, t).addScaledVector(side, Math.sin(Math.PI * t) * .055);
        p.y = height(p.x, p.z) + .004 + Math.sin(Math.PI * t) * .012;
        return p;
      };
      growingShoot(wood, runner, .0033 * scale, branchColor, 6, 5);
    }
    const rise = scale * (.36 + random() * .69), spread = scale * (.32 + random() * .47);
    const lean = (random() - .5) * .16 * scale;
    const curve = (t: number) => origin.clone().addScaledVector(outward, spread * Math.pow(t, 1.4))
      .addScaledVector(side, Math.sin(t * Math.PI) * lean)
      .add(new Vector3(0, rise * (t * 1.18 - t * t * .24), 0));
    growingShoot(wood, curve, .0042 * scale, branchColor);
    for (let fork = 0; fork < 3; fork += 1) {
      const t = .34 + fork * .235 + random() * .06, start = curve(t), sign = fork % 2 ? 1 : -1;
      const direction = outward.clone().multiplyScalar(.47).addScaledVector(side, sign * (.65 + random() * .25));
      direction.y = .14 + random() * .25;
      direction.normalize();
      const branchLength = scale * (.21 + random() * .19) * (1 - t * .28);
      const twig = (u: number) => start.clone().addScaledVector(direction, branchLength * u)
        .add(new Vector3(0, Math.sin(u * Math.PI) * branchLength * .09 - u * u * branchLength * .12, 0));
      growingShoot(wood, twig, .0016 * scale, branchColor, 3, 4);
      for (let leaf = 0; leaf < 5; leaf += 1) {
        const u = .16 + leaf * .185, attach = twig(u), leafSign = leaf % 2 ? -1 : 1;
        const axis = direction.clone().multiplyScalar(.38).addScaledVector(side, leafSign * (.7 + random() * .24));
        axis.y += (random() - .5) * .65;
        shrubLeaf(leaves, attach, axis, (.055 + random() * .055) * (.87 + scale * .15),
          palette[(shoot + leaf) % palette.length]!, random);
      }
    }
    const tipDirection = outward.clone().add(new Vector3(0, .36, 0));
    shrubLeaf(leaves, curve(.99), tipDirection, .075 + random() * .04, palette[shoot % palette.length]!, random);
  }
}

/**
 * Scale is in metres. The hearth and seated visitor have deliberate bare patches;
 * everything else follows the supplied actual terrain and rejects standing water.
 * shelterBounds follows Vector4(minX, minZ, maxX, maxZ).
 */
export function buildForestDebris(
  seed: string, height: GroundHeight, waterLevel: number, shelterBounds?: Vector4,
): Group {
  const group = new Group();
  group.name = 'wet-forest-litter';
  const contactSoil = createEarthContactSurface(seed, height, waterLevel);
  group.add(contactSoil.mesh);
  // Every small object rests on the exact near mesh, not on the lower coarse field.
  height = contactSoil.height;
  const random = createRandom(`${seed}/forest-floor/geometry`);
  const salt = hashSeed(`${seed}/forest-floor/distribution`);
  const ecology = createForestEcology(seed);
  const leaves = new DebrisBatch(), wood = new DebrisBatch(), gravel = new DebrisBatch();
  const leafPalette = [0x4b3827, 0x3c2e22, 0x58432e, 0x46392b, 0x51412f, 0x3f3528].map(c => new Color(c));
  const freshLeafPalette = [0x8b7249, 0x786342, 0x927544].map(c => new Color(c));
  const twigPalette = [0x423c30, 0x514734, 0x302d25, 0x66563e].map(c => new Color(c));
  const stonePalette = [0x4c5049, 0x414640, 0x534f43, 0x454440].map(c => new Color(c));
  const dry = (x: number, z: number, allowance = 0) => {
    if (height(x, z) < waterLevel + allowance) return false;
    if (Math.hypot(x + .8, z + 1.6) < 1.13) return false;
    if (Math.hypot((x - 1) * 1.1, z - 4.5) < .73) return false;
    return true;
  };
  const pocket = (x: number, z: number) => ecology.sample(x, z).organicCover;
  // Authored accumulations follow the actual seated view and the washed-out mud
  // channel. Concentrating a finite geometry budget here gives visible leaf scale.
  const nearPockets = [0, 1, 7, 8, 10, 11];
  const sample = (clustered = true): [number, number] => {
    if (!clustered || random() < .08) return [random() * 12 - 6, random() * 24 - 19];
    const pocketIndex = random() < .70 ? nearPockets[Math.floor(random() * nearPockets.length)]!
      : Math.floor(random() * FOREST_ORGANIC_POCKETS.length);
    const p = FOREST_ORGANIC_POCKETS[pocketIndex]!;
    const a = random() * Math.PI * 2, r = Math.sqrt(random()) * p[2] * (.38 + random() * .62);
    return [p[0] + Math.cos(a) * r, p[1] + Math.sin(a) * r];
  };

  let leafCount = 0, intactLeafCount = 0;
  for (let attempts = 0; attempts < 16000 && leafCount < 2050; attempts += 1) {
    const [x, z] = sample();
    const cover = ecology.sample(x, z);
    if (!dry(x, z, .001) || random() > .07 + cover.organicCover * .88
      || random() < cover.compactedPath * .96) continue;
    if (shelterBounds && x > shelterBounds.x && z > shelterBounds.y && x < shelterBounds.z && z < shelterBounds.w
      && random() < .10) continue;
    const waterEdge = Math.max(0, 1 - Math.abs(height(x, z) - waterLevel) / .06);
    const intact = random() < .16 * (1 - waterEdge * .9);
    const length = intact ? .075 + random() * .09 : (.028 + Math.pow(random(), .75) * .085) * (1 - waterEdge * .26);
    const palette = intact ? freshLeafPalette : leafPalette;
    const color = palette[Math.floor(random() * palette.length)]!;
    curledLeaf(leaves, random, height, x, z, length, color, intact ? .05 : .65 + random() * .35);
    if (intact) intactLeafCount += 1;
    leafCount += 1;
  }

  const rockTemplate = new IcosahedronGeometry(1, 0);
  const fineRockTemplate = new IcosahedronGeometry(1, 1);
  let pebbleCount = 0;
  for (let attempts = 0; attempts < 14000 && pebbleCount < 340; attempts += 1) {
    const [x, z] = sample(false);
    // Mineral fines collect in open, washed-out soil, complementary to the litter.
    const cover = ecology.sample(x, z);
    const waterEdge = Math.max(0, 1 - Math.abs(height(x, z) - waterLevel) / .075);
    if (!dry(x, z, -.012) || random() > waterEdge * .78 + cover.compactedPath * .47 + (1 - cover.organicCover) * .07) continue;
    const radius = .006 + Math.pow(random(), 2.3) * .031;
    const scaleX = radius * (.8 + random() * .65), scaleZ = radius * (.8 + random() * .5);
    const scaleY = radius * (.19 + random() * .25), angle = random() * Math.PI * 2;
    const c = Math.cos(angle), s = Math.sin(angle), base = height(x, z) + scaleY * .20;
    const color = stonePalette[Math.floor(random() * stonePalette.length)]!;
    const rockPositions = (Math.hypot(x - 1, z - 4.5) < 8.3 && radius > .016
      ? fineRockTemplate : rockTemplate).getAttribute('position');
    const indices: number[] = [];
    const sharedVertices = new Map<string, number>();
    for (let i = 0; i < rockPositions.count; i += 1) {
      const xx = rockPositions.getX(i), yy = rockPositions.getY(i), zz = rockPositions.getZ(i);
      const key = `${Math.round(xx * 1e5)},${Math.round(yy * 1e5)},${Math.round(zz * 1e5)}`;
      const existing = sharedVertices.get(key);
      if (existing !== undefined) { indices.push(existing); continue; }
      const irregular = .89 + fieldHash(Math.round(xx * 19), Math.round(zz * 23 + yy * 7), pebbleCount + salt) * .22;
      const rx = xx * scaleX * irregular, rz = zz * scaleZ * irregular;
      const vertex = gravel.vertex([x + c * rx - s * rz, base + yy * scaleY * irregular, z + s * rx + c * rz],
        color, [xx * .5 + .5, zz * .5 + .5], yy < 0 ? .67 : .92 + yy * .08);
      sharedVertices.set(key, vertex); indices.push(vertex);
    }
    for (let i = 0; i < indices.length; i += 3) gravel.triangle(indices[i]!, indices[i + 1]!, indices[i + 2]!);
    pebbleCount += 1;
  }
  rockTemplate.dispose();
  fineRockTemplate.dispose();

  let twigCount = 0;
  for (let attempts = 0; attempts < 3000 && twigCount < 180; attempts += 1) {
    const [x, z] = sample();
    if (!dry(x, z, .006) || random() > pocket(x, z) * .88) continue;
    const length = .10 + random() * .44, radius = .002 + random() * .006;
    const color = twigPalette[Math.floor(random() * twigPalette.length)]!;
    const angle = random() * Math.PI * 2;
    fallenTwig(wood, random, height, x, z, length, radius, color, angle);
    if (random() > .52) {
      const forkAngle = angle + .35 + random() * .75;
      fallenTwig(wood, random, height, x + Math.cos(forkAngle) * length * .13,
        z + Math.sin(forkAngle) * length * .13, length * .46, radius * .50, color, forkAngle);
    }
    twigCount += 1;
  }

  let needleCount = 0;
  for (let attempts = 0; attempts < 9000 && needleCount < 1600; attempts += 1) {
    const [x, z] = sample();
    if (!dry(x, z, .004) || random() > pocket(x, z) * .83) continue;
    const angle = random() * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
    const length = .021 + random() * .062, width = .00045 + random() * .0004;
    const color = leafPalette[Math.floor(random() * leafPalette.length)]!;
    const ax = x - c * length * .5, az = z - s * length * .5;
    const bx = x + c * length * .5, bz = z + s * length * .5;
    const a = wood.vertex([ax, height(ax, az) + .0015, az], color, [.5, 0]);
    const b = wood.vertex([x - s * width, height(x, z) + .003, z + c * width], color, [0, .5]);
    const c0 = wood.vertex([x + s * width, height(x, z) + .0032, z - c * width], color, [1, .5]);
    const d = wood.vertex([bx, height(bx, bz) + .0013, bz], color, [.5, 1]);
    wood.triangle(a, b, c0); wood.triangle(b, d, c0);
    needleCount += 1;
  }

  // Rotting pieces retain a partly buried, irregular cross-section and split grain.
  for (let n = 0; n < 6; n += 1) {
    const [x, z] = sample();
    if (!dry(x, z, .015) || ecology.sample(x, z).rootInfluence < .4 || pocket(x, z) < .6) continue;
    fallenTwig(wood, random, height, x, z, .32 + random() * .52, .025 + random() * .035,
      twigPalette[n % twigPalette.length]!);
  }

  // Moss grows as disconnected centimetre colonies. Mud, needles and dead leaves
  // remain visible between the colonies; there is no continuous patch substrate.
  const mossPalette = [0x3f4c2c, 0x4e5731, 0x303e26, 0x545438, 0x48552f].map(c => new Color(c));
  for (let patch = 0; patch < 25; patch += 1) {
    const [cx, cz] = sample();
    if (!dry(cx, cz, .012) || ecology.sample(cx, cz).mossCover < .14
      || Math.hypot(cx + .8, cz + 1.6) < 2.1) continue;
    const radius = .18 + random() * .24;
    for (let tuft = 0; tuft < 14; tuft += 1) {
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * radius;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!dry(x, z, .005)) continue;
      const mossColor = mossPalette[Math.floor(random() * mossPalette.length)]!;
      const width = .016 + random() * .038, lift = .003 + random() * .005;
      const center = leaves.vertex([x, height(x, z) + lift, z], mossColor, [.5, -1], .85);
      const rim: number[] = [];
      for (let edge = 0; edge < 6; edge += 1) {
        const theta = a + edge / 6 * Math.PI * 2;
        const spread = width * (.58 + random() * .64);
        const xx = x + Math.cos(theta) * spread, zz = z + Math.sin(theta) * spread;
        rim.push(leaves.vertex([xx, height(xx, zz) + .002, zz], mossColor, [.5, -1], .44 + random() * .34));
      }
      for (let edge = 0; edge < 6; edge += 1) leaves.triangle(center, rim[(edge + 1) % 6]!, rim[edge]!);
      for (let leaf = 0; leaf < 6; leaf += 1) {
        const angle = random() * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle);
        const offset = Math.sqrt(random()) * width * .78;
        const xx = x + c * offset, zz = z + s * offset;
        const y = height(xx, zz) + lift * .45, rise = .006 + random() * .009;
        const span = .005 + random() * .007;
        const p = leaves.vertex([xx, y, zz], mossColor, [.5, -1], .57);
        const q = leaves.vertex([xx - s * span * .22 + c * span * .5, y + rise * .57,
          zz + c * span * .22 + s * span * .5], mossColor, [0, -1], .85);
        const r0 = leaves.vertex([xx + s * span * .22 + c * span * .5, y + rise * .57,
          zz - c * span * .22 + s * span * .5], mossColor, [1, -1]);
        const tip = leaves.vertex([xx + c * span, y + rise, zz + s * span], mossColor, [.5, -1], .94);
        leaves.triangle(p, q, r0); leaves.triangle(q, tip, r0);
      }
    }
  }

  let fernCount = 0;
  const fernPositions: [number, number, number][] = [
    [-1.65, 1.15, .93], [2.50, -.25, .86], [-2.60, -3.20, .82],
    [2.7, -4.3, .94],
  ];
  for (const [x, z, scale] of fernPositions) {
    if (!dry(x, z, .009)) continue;
    addFern(leaves, wood, random, height, x, z, scale);
    fernCount += 1;
  }

  // Mid-ground understorey belongs to the same moist root pockets. Two overlapping
  // growth stages per pocket screen the lower trunks without making a plant row.
  let understoreyGroups = 0;
  for (const [cx, cz] of [[-4.0, -9.4], [4.4, -11.3], [-4.6, -16.4]]) {
    let bx = cx!, bz = cz!, best = -1;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const x = cx! + (random() - .5) * 1.4, z = cz! + (random() - .5) * 1.4;
      const cover = ecology.sample(x, z), score = cover.organicCover * .7 + cover.rootInfluence * .3;
      if (dry(x, z, .009) && score > best) { bx = x; bz = z; best = score; }
    }
    if (best < .45) continue;
    addFern(leaves, wood, random, height, bx, bz, 1.08 + random() * .18);
    fernCount += 1;
    const angle = random() * Math.PI * 2;
    const nx = bx + Math.cos(angle) * .55, nz = bz + Math.sin(angle) * .55;
    if (dry(nx, nz, .009)) {
      addFern(leaves, wood, random, height, nx, nz, .70 + random() * .20);
      fernCount += 1;
    }
    understoreyGroups += 1;
  }

  // Successive banks overlap in the seated view. Their different depth, height
  // and leaf habit leave a narrow irregular view between them into the mist.
  let shrubCount = 0;
  const bankGroups: [number, number, number, number, number, number][] = [
    [-2.60, -5.0, .86, -3.20, -5.8, .57],
    [.85, -7.4, .96, 1.65, -8.6, .67],
    [-3.40, -12.0, 1.06, -4.30, -13.0, .73],
  ];
  const bankFerns: [number, number, number][] = [
    [-3.25, -4.8, 1.25], [1.35, -6.6, 1.38], [-2.95, -12.7, 1.32],
  ];
  for (let bank = 0; bank < bankGroups.length; bank += 1) {
    const [x, z, size, x2, z2, size2] = bankGroups[bank]!;
    if (dry(x, z, .012)) { addWoodlandShrub(leaves, wood, random, height, x, z, size); shrubCount += 1; }
    if (dry(x2, z2, .012)) { addWoodlandShrub(leaves, wood, random, height, x2, z2, size2); shrubCount += 1; }
    const [fx, fz, fs] = bankFerns[bank]!;
    if (dry(fx, fz, .012)) { addFern(leaves, wood, random, height, fx, fz, fs); fernCount += 1; }
    // Deposits form under this canopy and on the down-slope side of its stems.
    for (let piece = 0; piece < 20; piece += 1) {
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * .75;
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!dry(px, pz, .002) || ecology.sample(px, pz).organicCover < .40) continue;
      curledLeaf(leaves, random, height, px, pz, .035 + random() * .055,
        leafPalette[piece % leafPalette.length]!, .86 + random() * .14);
      leafCount += 1;
    }
    for (let branch = 0; branch < 8; branch += 1) {
      const px = x + (random() - .5) * 1.7, pz = z + (random() - .5) * 1.3;
      if (!dry(px, pz, .004)) continue;
      fallenTwig(wood, random, height, px, pz, .15 + random() * .46, .003 + random() * .006,
        twigPalette[branch % twigPalette.length]!, random() * 2.1 + .3);
      twigCount += 1;
    }
  }

  // Two small stranded accumulations interrupt the shallow water edge. Find the
  // actual waterline from height(), rather than assuming a circular pond rim.
  let strandlineLeaves = 0;
  for (const [cx, cz] of [[-.25, 1.25], [1.70, -.15]]) {
    let bx = cx!, bz = cz!, nearest = Infinity;
    for (let attempt = 0; attempt < 70; attempt += 1) {
      const x = cx! + (random() - .5) * .95, z = cz! + (random() - .5) * .95;
      if (Math.hypot(x + .8, z + 1.6) < 1.2) continue;
      const error = Math.abs(height(x, z) - waterLevel - .006);
      if (error < nearest) { bx = x; bz = z; nearest = error; }
    }
    if (nearest > .024) continue;
    for (let piece = 0; piece < 30; piece += 1) {
      const x = bx + (random() - .5) * .36, z = bz + (random() - .5) * .43;
      if (!dry(x, z, -.006) || height(x, z) > waterLevel + .054) continue;
      curledLeaf(leaves, random, height, x, z, .026 + random() * .046,
        leafPalette[piece % leafPalette.length]!, .92);
      leafCount += 1; strandlineLeaves += 1;
    }
    for (let branch = 0; branch < 3; branch += 1) {
      const x = bx + (random() - .5) * .25, z = bz + (random() - .5) * .32;
      fallenTwig(wood, random, height, x, z, .13 + random() * .20, .0024 + random() * .0028,
        twigPalette[branch % twigPalette.length]!, .7 + random() * 1.1);
      twigCount += 1;
    }
  }

  const fineRoots = connectedFineRoots(leaves, wood, random, height);
  leafCount += fineRoots.litter;

  group.add(leaves.mesh(createDebrisMaterial('leaf'), 'curled-leaves-ferns-moss'));
  group.add(wood.mesh(createDebrisMaterial('wood'), 'fallen-twigs-and-needles'));
  group.add(gravel.mesh(createDebrisMaterial('gravel'), 'silt-bound-fine-gravel'));
  group.userData.procedural = {
    leafCount, intactLeafCount, pebbleCount, twigCount, needleCount, fernCount, shrubCount, understoreyGroups,
    strandlineLeaves,
    exposedRootBranches: fineRoots.branches,
    triangles: (leaves.indices.length + wood.indices.length + gravel.indices.length + contactSoil.mesh.geometry.index!.count) / 3,
    contactSoilTriangles: contactSoil.mesh.geometry.index!.count / 3,
    draws: 4,
  };
  return group;
}
