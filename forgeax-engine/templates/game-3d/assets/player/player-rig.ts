export const PLAYER_RIG = [
  { name: 'Hips', parent: -1, local: [0, -0.12, 0], world: [0, -0.12, 0] },
  { name: 'Spine', parent: 0, local: [0, 0.3, 0], world: [0, 0.18, 0] },
  { name: 'Chest', parent: 1, local: [0, 0.31, 0], world: [0, 0.49, 0] },
  { name: 'Head', parent: 2, local: [0, 0.36, 0], world: [0, 0.85, 0] },
  { name: 'UpperArm.L', parent: 2, local: [-0.34, 0.02, 0], world: [-0.34, 0.51, 0] },
  { name: 'Forearm.L', parent: 4, local: [-0.3, -0.28, 0], world: [-0.64, 0.23, 0] },
  { name: 'UpperArm.R', parent: 2, local: [0.34, 0.02, 0], world: [0.34, 0.51, 0] },
  { name: 'Forearm.R', parent: 6, local: [0.3, -0.28, 0], world: [0.64, 0.23, 0] },
  { name: 'Thigh.L', parent: 0, local: [-0.17, -0.13, 0], world: [-0.17, -0.25, 0] },
  { name: 'Shin.L', parent: 8, local: [-0.01, -0.34, 0], world: [-0.18, -0.59, 0] },
  { name: 'Foot.L', parent: 9, local: [0, -0.29, -0.06], world: [-0.18, -0.88, -0.06] },
  { name: 'Thigh.R', parent: 0, local: [0.17, -0.13, 0], world: [0.17, -0.25, 0] },
  { name: 'Shin.R', parent: 11, local: [0.01, -0.34, 0], world: [0.18, -0.59, 0] },
  { name: 'Foot.R', parent: 12, local: [0, -0.29, -0.06], world: [0.18, -0.88, -0.06] },
] as const;

export const PLAYER_JOINT_NAMES = PLAYER_RIG.map((joint) => joint.name);
