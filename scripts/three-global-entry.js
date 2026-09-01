// Entry for esbuild: bundle three@0.160.0 + GLTFLoader + FBXLoader + SkeletonUtils
// into a single global script that exposes window.THREE plus asset loaders.
//
// Also bundles the HDRI loaders used by render-scene.js for imported skyboxes:
//   EXRLoader  — .exr  (OpenEXR, half/float)
//   RGBELoader — .hdr  (Radiance)
// GroundedSkybox is intentionally NOT included; render-scene.js draws its own
// dome so the procedural and imported sky paths share one code path.
import * as THREE_NS from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

const THREE = Object.assign({}, THREE_NS);
THREE.GLTFLoader = GLTFLoader;
THREE.FBXLoader = FBXLoader;
THREE.SkeletonUtils = SkeletonUtils;
THREE.EXRLoader = EXRLoader;
THREE.RGBELoader = RGBELoader;
window.THREE = THREE;
