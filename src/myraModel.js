import { useRef, useEffect } from 'react'
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'
import {
  Group,
  AnimationMixer,
  AnimationClip,
  LoopRepeat,
  LoadingManager,
} from 'three'
import { Euler, Quaternion } from 'three'
import { getMyraMouthLevel } from './myraLipSync.js'

export const MYRA_MODEL_PATH = '/models/sejal.fbx'

const MODEL_PATH = MYRA_MODEL_PATH
const IDLE_PATH = '/models/idle.fbx'
const TALK_PATHS = ['/models/talking-4.fbx', '/models/talking-5.fbx', '/models/talking-6.fbx']

let myraPreloadPromise = null
let myraAssetCache = null

const DEG = Math.PI / 180

/** Idle + talk standing spot — tune after placing sejal in AR */
export const IDLE_PLACEMENT = {
  position: { x: 0, y: -0.35, z: -0.15 },
  rotation: { x: 0, y: 0, z: 0 },
  scale: 0.008,
}

export const MYRA_PLACEMENT = IDLE_PLACEMENT

const CROSSFADE_SEC = 0.35
const HIPS_RE = /mixamorig:?Hips$/i
const MOUTH_KEY_PATTERNS = [/mouth/i, /open/i, /jaw/i, /lip/i, /morph/i, /shape/i, /^key$/i, /^key\s*1$/i]
const HEAD_LIP_BONES = [/mixamorig:?Head$/i]

function findSkinnedMesh(root) {
  let mesh = null
  root.traverse((child) => {
    if (child.isSkinnedMesh && !mesh) mesh = child
  })
  return mesh
}

function collectMorphMeshes(root) {
  const meshes = []
  root.traverse((child) => {
    if (!child.isMesh && !child.isSkinnedMesh) return

    const morphCount =
      child.morphTargetInfluences?.length ||
      child.geometry?.morphAttributes?.position?.length ||
      0
    if (morphCount > 0) {
      if (!child.morphTargetInfluences?.length && child.geometry?.morphAttributes?.position?.length) {
        child.morphTargetInfluences = new Array(child.geometry.morphAttributes.position.length).fill(0)
      }
      meshes.push(child)
    }
  })
  return meshes
}

function resolveMouthMorphIndex(dictionary, influenceCount = 0) {
  if (dictionary && Object.keys(dictionary).length) {
    const entries = Object.entries(dictionary)
    for (const pattern of MOUTH_KEY_PATTERNS) {
      const hit = entries.find(([name]) => pattern.test(name))
      if (hit) return hit[1]
    }
    if (entries.length === 1) return entries[0][1]
    return entries[0][1]
  }
  return influenceCount > 0 ? 0 : -1
}

function collectHeadLipBones(root) {
  const bones = []
  root.traverse((obj) => {
    if (!obj.isBone) return
    if (!HEAD_LIP_BONES.some((pattern) => pattern.test(obj.name))) return
    bones.push({
      bone: obj,
      restQuat: obj.quaternion.clone(),
    })
  })
  return bones
}

function collectBoneNames(root) {
  const names = new Set()
  root.traverse((obj) => {
    if (obj.isBone) names.add(obj.name)
  })
  findSkinnedMesh(root)?.skeleton?.bones?.forEach((bone) => names.add(bone.name))
  return names
}

function isHipsPositionTrackName(trackName) {
  const bone = trackName.split('.')[0]
  return trackName.endsWith('.position') && HIPS_RE.test(bone)
}

export function clipForRig(clip, boneNames) {
  if (!clip) return null
  const tracks = clip.tracks.filter((track) => {
    const bone = track.name.split('.')[0]
    if (!boneNames.has(bone)) return false
    if (isHipsPositionTrackName(track.name)) return false
    return true
  })
  return new AnimationClip(clip.name, clip.duration, tracks)
}

function applyPlacement(wrapper, placement = IDLE_PLACEMENT) {
  const { position, rotation, scale } = placement
  wrapper.position.set(position.x, position.y, position.z)
  wrapper.rotation.set(rotation.x * DEG, rotation.y * DEG, rotation.z * DEG)
  wrapper.scale.setScalar(scale)
}

/** Soft fade only — never hard-stop mid-blend (hard stop = T-pose flash). */
function fadeOutTalkActions(actions, duration = CROSSFADE_SEC) {
  actions.talks?.forEach((talkAction) => {
    if (!talkAction?.isRunning?.()) return
    talkAction.fadeOut(duration)
  })
  actions.activeTalk = null
}

function playIdle(actions, mixer) {
  const { idle } = actions
  if (!idle) return

  // Crossfade talk → idle. Do NOT call talkAction.stop() here — that snaps to bind pose (T-pose).
  fadeOutTalkActions(actions, CROSSFADE_SEC)

  idle.enabled = true
  idle.setLoop(LoopRepeat, Infinity)
  if (!idle.isRunning()) {
    idle.reset().play()
  } else {
    // Idle was faded out during talk — bring weight back without pose snap.
    idle.setEffectiveTimeScale(1)
  }
  idle.setEffectiveWeight(1)
  idle.fadeIn(CROSSFADE_SEC)
  mixer?.update(0)
}

function pickRandomTalkIndex(count, lastIndex) {
  if (count <= 0) return -1
  if (count === 1) return 0

  let index = Math.floor(Math.random() * count)
  let guard = 0
  while (index === lastIndex && guard < 8) {
    index = Math.floor(Math.random() * count)
    guard += 1
  }
  return index
}

function playRandomTalking(actions, lastTalkIndexRef) {
  const { idle, talks } = actions
  if (!talks?.length) return

  idle?.fadeOut(CROSSFADE_SEC)

  const index = pickRandomTalkIndex(talks.length, lastTalkIndexRef.current)
  if (index < 0) return

  lastTalkIndexRef.current = index
  const talkAction = talks[index]

  // Fade other talk clips out softly (no hard stop).
  talks.forEach((other) => {
    if (other !== talkAction && other?.isRunning?.()) {
      other.fadeOut(CROSSFADE_SEC)
    }
  })

  talkAction.reset().setLoop(LoopRepeat, Infinity).setEffectiveWeight(1).fadeIn(CROSSFADE_SEC).play()
  actions.activeTalk = talkAction

  console.info('[Myra] talking clip', TALK_PATHS[index] ?? index)
}

function applyMouthMorph(anchorGroup) {
  const ud = anchorGroup?.userData
  const morphMeshes = ud?.morphMeshes
  const target = Math.min(1, Math.max(0, getMyraMouthLevel()))
  const current = ud.mouthInfluence ?? 0
  ud.mouthInfluence = current + (target - current) * 0.32

  let morphApplied = false
  for (const entry of morphMeshes ?? []) {
    const { mesh, index } = entry
    if (index < 0 || !mesh.morphTargetInfluences) continue
    mesh.morphTargetInfluences[index] = ud.mouthInfluence
    morphApplied = true
  }

  if (!morphApplied && ud.lipBones?.length && ud.mouthInfluence > 0.02) {
    const tilt = ud.mouthInfluence * 0.14
    const delta = new Quaternion().setFromEuler(new Euler(tilt, 0, 0))
    for (const { bone, restQuat } of ud.lipBones) {
      bone.quaternion.copy(restQuat).multiply(delta)
    }
  } else if (ud.lipBones?.length) {
    for (const { bone, restQuat } of ud.lipBones) {
      bone.quaternion.copy(restQuat)
    }
  }
}

export function tickMyraMixer(anchorGroup, delta) {
  const ud = anchorGroup?.userData
  if (!ud?.mixer) return
  ud.mixer.update(delta)
  applyMouthMorph(anchorGroup)
  ud.skinnedMeshes?.forEach((mesh) => mesh.skeleton?.update())
}

function registerMorphTargets(anchorGroup, character) {
  const morphMeshes = collectMorphMeshes(character).map((mesh) => ({
    mesh,
    index: resolveMouthMorphIndex(mesh.morphTargetDictionary, mesh.morphTargetInfluences?.length ?? 0),
  }))
  const lipBones = collectHeadLipBones(character)

  anchorGroup.userData.morphMeshes = morphMeshes
  anchorGroup.userData.lipBones = lipBones
  anchorGroup.userData.mouthInfluence = 0

  if (!morphMeshes.length) {
    console.warn('[Myra] No morph targets in FBX — using head fallback for lip sync')
  } else {
    console.info('[Myra] Lip sync morph targets:', morphMeshes.map(({ mesh, index }) => ({
      mesh: mesh.name,
      index,
      dictionary: mesh.morphTargetDictionary,
    })))
  }

  if (lipBones.length) {
    console.info('[Myra] Lip sync head fallback bones:', lipBones.map(({ bone }) => bone.name))
  }
}

function loadFbxFiles(loader, paths) {
  return Promise.all(
    paths.map(
      (path) =>
        new Promise((resolve, reject) => {
          loader.load(path, resolve, undefined, () => reject(new Error(`Failed to load ${path}`)))
        }),
    ),
  )
}

function loadMyraAssetBundle(loader = new FBXLoader()) {
  return new Promise((resolve, reject) => {
    loader.load(
      MODEL_PATH,
      (character) => {
        character.animations = []
        loader.load(
          IDLE_PATH,
          (idleFbx) => {
            loadFbxFiles(loader, TALK_PATHS)
              .then((talkFbxList) => resolve({ character, idleFbx, talkFbxList }))
              .catch(reject)
          },
          undefined,
          reject,
        )
      },
      undefined,
      reject,
    )
  })
}

export function preloadMyraModels() {
  if (myraPreloadPromise) return myraPreloadPromise
  if (myraAssetCache) return Promise.resolve()

  myraPreloadPromise = loadMyraAssetBundle()
    .then((bundle) => {
      myraAssetCache = bundle
      console.info('[Myra] persona assets preloaded', 2 + TALK_PATHS.length)
      return bundle
    })
    .catch((error) => {
      myraPreloadPromise = null
      throw error
    })

  return myraPreloadPromise
}

export function MyraModel({ anchorGroup, isTalking, placement = IDLE_PLACEMENT, revealed = true }) {
  const actionsRef = useRef({ idle: null, talks: [], activeTalk: null })
  const mixerRef = useRef(null)
  const characterRef = useRef(null)
  const skinnedMeshesRef = useRef([])
  const mountedRef = useRef(false)
  const talkingRef = useRef(isTalking)
  const revealedRef = useRef(revealed)
  const lastTalkIndexRef = useRef(-1)

  useEffect(() => {
    talkingRef.current = isTalking
  }, [isTalking])

  useEffect(() => {
    revealedRef.current = revealed
    const wrapper = anchorGroup?.userData?.wrapper
    if (wrapper) wrapper.visible = revealed
  }, [revealed, anchorGroup])

  useEffect(() => {
    if (!anchorGroup) return

    let disposed = false

    function mountCharacter(idleFbx, character, talkFbxList) {
      if (disposed) return

      const bones = collectBoneNames(character)
      const idleClip = clipForRig(idleFbx.animations[0], bones)
      const talkClips = talkFbxList
        .map((talkFbx, index) => {
          const clip = clipForRig(talkFbx.animations[0], bones)
          if (!clip?.tracks.length) {
            console.warn('[Myra] talk clip skipped — no bound tracks', TALK_PATHS[index])
            return null
          }
          return clip
        })
        .filter(Boolean)

      if (!idleClip?.tracks.length || !talkClips.length) {
        console.error('[Myra] idle/talk clips did not bind')
        return
      }

      const skinned = findSkinnedMesh(character) || character
      const skinnedMeshes = skinned.isSkinnedMesh ? [skinned] : []
      characterRef.current = character
      skinnedMeshesRef.current = skinnedMeshes

      const wrapper = new Group()
      wrapper.userData.isMyraWrapper = true
      wrapper.visible = revealedRef.current
      wrapper.renderOrder = 3
      wrapper.add(character)
      applyPlacement(wrapper, placement)
      anchorGroup.add(wrapper)

      registerMorphTargets(anchorGroup, character)

      const mixer = new AnimationMixer(skinned)
      mixerRef.current = mixer

      const idleAction = mixer.clipAction(idleClip, skinned)
      const talkActions = talkClips.map((clip) => mixer.clipAction(clip, skinned))

      const actions = {
        idle: idleAction,
        talks: talkActions,
        activeTalk: null,
      }

      actionsRef.current = actions
      mountedRef.current = true
      anchorGroup.userData.mixer = mixer
      anchorGroup.userData.skinnedMeshes = skinnedMeshes
      anchorGroup.userData.wrapper = wrapper

      if (talkingRef.current) playRandomTalking(actions, lastTalkIndexRef)
      else playIdle(actions, mixer)

      console.info('[Myra] mounted on anchor', { revealed: revealedRef.current, cached: Boolean(myraAssetCache) })
    }

    function mountFromBundle(bundle) {
      const character = SkeletonUtils.clone(bundle.character)
      mountCharacter(bundle.idleFbx, character, bundle.talkFbxList)
    }

    if (myraAssetCache) {
      mountFromBundle(myraAssetCache)
    } else {
      const loader = new FBXLoader(
        new LoadingManager(undefined, undefined, (url) => {
          console.error('[Myra] load failed:', url)
        }),
      )

      console.warn('[Myra] loading model (no cache):', MODEL_PATH)
      loader.load(MODEL_PATH, (character) => {
        if (disposed) return
        character.animations = []
        loader.load(IDLE_PATH, (idleFbx) => {
          if (disposed) return
          loadFbxFiles(loader, TALK_PATHS)
            .then((talkFbxList) => {
              if (disposed) return
              mountCharacter(idleFbx, character, talkFbxList)
            })
            .catch((error) => {
              console.error('[Myra] talk clips failed to load', error)
            })
        })
      })
    }

    return () => {
      disposed = true
      mountedRef.current = false
      lastTalkIndexRef.current = -1
      mixerRef.current = null
      characterRef.current = null
      skinnedMeshesRef.current = []
      actionsRef.current = { idle: null, talks: [], activeTalk: null }
      delete anchorGroup.userData.mixer
      delete anchorGroup.userData.skinnedMeshes
      delete anchorGroup.userData.morphMeshes
      delete anchorGroup.userData.lipBones
      delete anchorGroup.userData.mouthInfluence
      delete anchorGroup.userData.wrapper
      anchorGroup.children
        .filter((c) => c.userData?.isMyraWrapper)
        .forEach((c) => anchorGroup.remove(c))
    }
  }, [anchorGroup, placement])

  useEffect(() => {
    const actions = actionsRef.current
    if (!actions.idle || !actions.talks?.length || !mountedRef.current) return
    if (isTalking) playRandomTalking(actions, lastTalkIndexRef)
    else playIdle(actions, mixerRef.current)
  }, [isTalking])

  return null
}
