// The Rig panel's Constraints section: rules the active joint follows when posed, and IK/FK switching.
import { bakeIKToFK, chainOf, constraintWeight, keyWeight, snapTargetToFK } from '../core/constraints';
import { ed } from '../core/editor';
import { add, len, norm, sub } from '../core/geom';
import { newId, uniqueName, type Bone, type Constraint, type Model, type V3 } from '../core/types';
import { button, checkbox, h, numField, section, select } from './dom';
import { status, toast } from './feedback';

type Kind = Constraint['kind'];
const KIND_LABEL: Record<Kind, string> = { ik: 'IK', limit: 'Limit rotation', lookAt: 'Look at', copyRot: 'Copy rotation' };
type IK = Extract<Constraint, { kind: 'ik' }>;

const byId = (m: Model, id: number) => m.bones.find((b) => b.id === id);

/** Change one constraint as an undo step. */
function edit(id: number, label: string, fn: (c: Constraint, m: Model) => void) {
  ed.transact(label, (m) => { const c = m.constraints?.find((x) => x.id === id); if (c) fn(c, m); });
  ed.emit('skeleton', 'anim', 'geometry');
}

/** A control joint, free of the skeleton, for a constraint to follow. Returns its id. */
function addControl(m: Model, name: string, at: V3): number {
  const id = newId(m);
  m.bones.push({ id, name: uniqueName(m.bones.map((b) => b.name), name), parent: null, head: [at[0], at[1], at[2]], control: true });
  return id;
}

/**
 * Where a pole goes for a chain: out from its middle joint, on the side it already bends to. A straight chain gets
 * the usual side for its direction: knees (upright chains) point forward, elbows back. Forward is +Z.
 */
function poleSpot(m: Model, end: Bone, chain: number[]): V3 {
  const top = byId(m, chain[chain.length - 1])!, mid = byId(m, chain[0])!;
  const line = sub(end.head, top.head);
  const reach = Math.max(0.1, len(line) * 0.5);
  const axis = norm(line);
  // Only the bend away from the line counts.
  const off = sub(mid.head, top.head);
  const along = off[0] * axis[0] + off[1] * axis[1] + off[2] * axis[2];
  const across: V3 = [off[0] - axis[0] * along, off[1] - axis[1] * along, off[2] - axis[2] * along];
  const dir: V3 = len(across) > reach * 0.02 ? norm(across) : Math.abs(axis[1]) > 0.7 ? [0, 0, 1] : [0, 0, -1];
  return add(mid.head, [dir[0] * reach, dir[1] * reach, dir[2] * reach]);
}

export function addConstraint(kind: Kind) {
  const m0 = ed.model;
  const bone = byId(m0, ed.activeBone ?? -1);
  if (!bone) { toast('Select a joint first.', 'info'); return; }
  if (kind === 'ik' && !chainOf(m0, bone.id, 1).length) { toast('IK bends the joints above this one, and it has none. Pick the end of a chain, such as a hand or foot.', 'info'); return; }
  const others = m0.bones.filter((b) => b.id !== bone.id);
  if ((kind === 'lookAt' || kind === 'copyRot') && !others.length) { toast('This needs another joint to follow.', 'info'); return; }
  ed.transact(`Add ${KIND_LABEL[kind]}`, (m) => {
    const list = m.constraints ?? (m.constraints = []);
    const id = newId(m);
    const b = byId(m, bone.id)!;
    if (kind === 'ik') {
      // A target where the joint is now, so nothing moves until the target does.
      const chain = chainOf(m, b.id, 2);
      const target = addControl(m, `${b.name} IK`, b.head);
      list.push({ id, kind, bone: b.id, chain: chain.length, target, pole: null, align: false, weight: 1 });
    } else if (kind === 'limit') list.push({ id, kind, bone: b.id, min: [-45, -45, -45], max: [45, 45, 45], weight: 1 });
    else {
      // Follow the parent by default, or else the first other joint.
      const target = b.parent ?? m.bones.find((x) => x.id !== b.id)!.id;
      list.push({ id, kind, bone: b.id, target, weight: 1 });
    }
  });
  ed.emit('skeleton', 'anim', 'geometry');
  status(kind === 'ik' ? `Added IK to ${bone.name}, with a target to move. In the Animation workspace, move and key the target; the chain follows.` : `Added ${KIND_LABEL[kind]} to ${bone.name}.`);
}

function removeConstraint(c: Constraint) {
  ed.transact(`Remove ${KIND_LABEL[c.kind]}`, (m) => {
    m.constraints = (m.constraints ?? []).filter((x) => x.id !== c.id);
    // An IK target nothing else uses goes with it.
    if (c.kind === 'ik') for (const id of [c.target, c.pole]) {
      if (id === null) continue;
      const used = m.constraints.some((x) => x.kind !== 'limit' && (x.target === id || (x.kind === 'ik' && x.pole === id)));
      const b = byId(m, id);
      if (b?.control && !used && !m.bones.some((x) => x.parent === id)) {
        m.bones = m.bones.filter((x) => x.id !== id);
        for (const clip of m.clips) delete clip.tracks[id];
      }
    }
    if (!m.constraints.length) delete m.constraints;
  });
  ed.emit('skeleton', 'anim', 'geometry');
}

/** The Constraints section for the active joint, or null with no joints. */
export function constraintsSection(): HTMLElement | null {
  const m = ed.model;
  if (!m.bones.length) return null;
  const bone = byId(m, ed.activeBone ?? -1);
  const mine = bone ? (m.constraints ?? []).filter((c) => c.bone === bone.id) : [];
  const clip = ed.clip();
  const frame = Math.round(ed.frame);
  const jointList = (exclude: number) => m.bones.filter((b) => b.id !== exclude).map((b): [number, string] => [b.id, `${b.name}${b.control ? ' (control)' : ''}`]);
  const weightRow = (c: Constraint) => {
    const keyed = !!clip?.weights?.[c.id]?.length;
    const w = constraintWeight(c, clip, ed.frame);
    return h('div', { class: 'btn-row' },
      numField({
        label: c.kind === 'ik' ? 'IK / FK' : 'Weight', value: w, min: 0, max: 1, step: 0.01, digits: 2,
        title: c.kind === 'ik' ? '1 follows the target (IK), 0 the joints\' own keys (FK)' : 'How strongly it applies',
        onChange: (v) => {
          if (keyed && clip) edit(c.id, 'Key weight', (_, mm) => { const cl = mm.clips.find((x) => x.id === clip.id); if (cl) keyWeight(cl, c.id, frame, v); });
          else edit(c.id, 'Constraint weight', (x) => { x.weight = v; });
        },
      }),
      clip ? button(keyed ? 'Key' : 'Key…', () => edit(c.id, 'Key weight', (_, mm) => { const cl = mm.clips.find((x) => x.id === clip.id); if (cl) keyWeight(cl, c.id, frame, w); }),
        { class: 'btn btn-small', title: 'Key this weight at the current frame, so it can change over the clip' }) : null,
      keyed && clip ? button('Unkey', () => edit(c.id, 'Clear weight keys', (_, mm) => { const cl = mm.clips.find((x) => x.id === clip.id); if (cl?.weights) delete cl.weights[c.id]; }),
        { class: 'btn btn-small', title: 'Drop the weight\'s keys in this clip' }) : null,
    );
  };
  const card = (c: Constraint) => {
    const rows: (HTMLElement | null)[] = [
      h('div', { class: 'constraint-head' }, h('strong', null, KIND_LABEL[c.kind]), button('×', () => removeConstraint(c), { class: 'tl-btn', title: 'Remove this constraint' })),
    ];
    if (c.kind === 'ik') {
      const ik = c as IK;
      rows.push(
        numField({ label: 'Joints', value: ik.chain, min: 1, max: 12, step: 1, digits: 0, title: 'How many joints above this one bend', onChange: (v) => edit(c.id, 'IK chain', (x) => { (x as IK).chain = Math.max(1, Math.round(v)); }) }),
        h('label', { class: 'form-row' }, 'Target', select<number>(ik.target, jointList(c.bone), (v) => edit(c.id, 'IK target', (x) => { (x as IK).target = v; }), 'What the chain reaches for')),
        h('div', { class: 'btn-row' },
          h('label', { class: 'form-row' }, 'Pole', select<number>(ik.pole ?? -1, [[-1, '(none)'], ...jointList(c.bone)], (v) => edit(c.id, 'IK pole', (x) => { (x as IK).pole = v < 0 ? null : v; }), 'Which way the chain bends: toward this joint')),
          ik.pole === null ? button('Add pole', () => {
            const chain = chainOf(m, ik.bone, ik.chain);
            if (chain.length < 2) { toast('A pole needs a chain of two joints or more.', 'info'); return; }
            ed.transact('Add IK pole', (mm) => {
              const at = poleSpot(mm, byId(mm, ik.bone)!, chain);
              const pid = addControl(mm, `${byId(mm, ik.bone)!.name} pole`, at);
              const x = mm.constraints!.find((y) => y.id === c.id) as IK;
              x.pole = pid;
            });
            ed.emit('skeleton', 'anim', 'geometry');
          }, { class: 'btn btn-small', title: 'Add a control the chain bends toward, as an elbow or knee points' }) : null,
        ),
        checkbox('Match the target\'s rotation', ik.align, (v) => edit(c.id, 'IK rotation', (x) => { (x as IK).align = v; }), 'The end joint turns with the target, as a planted foot or a gripping hand would'),
        weightRow(c),
        clip ? h('div', { class: 'btn-row' },
          button('Snap IK to FK', () => edit(c.id, 'Snap IK to FK', (x, mm) => { const cl = mm.clips.find((y) => y.id === clip.id); if (cl) snapTargetToFK(mm, cl, frame, x as IK); }),
            { class: 'btn btn-small', title: 'Key the target where the joints\' own keys put the end, at this frame, so switching to IK doesn\'t jump' }),
          button('Bake IK to FK', () => edit(c.id, 'Bake IK to FK', (x, mm) => { const cl = mm.clips.find((y) => y.id === clip.id); if (cl) bakeIKToFK(mm, cl, frame, x as IK); }),
            { class: 'btn btn-small', title: 'Key the joints where IK puts them, at this frame, so switching to FK doesn\'t jump' }),
        ) : null,
      );
    } else if (c.kind === 'limit') {
      const axis = (which: 'min' | 'max', i: 0 | 1 | 2) => numField({
        label: `${'XYZ'[i]} ${which}`, value: c[which][i], min: -180, max: 180, step: 1, digits: 0,
        onChange: (v) => edit(c.id, 'Rotation limit', (x) => { if (x.kind === 'limit') x[which][i] = v; }),
      });
      rows.push(
        h('div', { class: 'xyz' }, axis('min', 0), axis('min', 1), axis('min', 2)),
        h('div', { class: 'xyz' }, axis('max', 0), axis('max', 1), axis('max', 2)),
        h('p', { class: 'muted small' }, 'Degrees about the joint\'s own axes, from its rest pose. IK keeps to them as it bends.'),
        weightRow(c),
      );
    } else {
      rows.push(
        h('label', { class: 'form-row' }, c.kind === 'lookAt' ? 'Point at' : 'Copy from', select<number>(c.target, jointList(c.bone), (v) => edit(c.id, 'Constraint target', (x) => { if (x.kind !== 'limit') x.target = v; }))),
        weightRow(c),
      );
    }
    return h('div', { class: 'constraint-card' }, rows.filter((x): x is HTMLElement => !!x));
  };
  return section('Constraints',
    bone ? null : h('p', { class: 'muted' }, 'Select a joint to give it constraints.'),
    ...mine.map(card),
    bone ? h('div', { class: 'btn-row' },
      button('IK', () => addConstraint('ik'), { class: 'btn btn-small', title: 'Bend the joints above this one so it reaches a target you move and key' }),
      button('Limit', () => addConstraint('limit'), { class: 'btn btn-small', title: 'Keep this joint\'s rotation within limits' }),
      button('Look at', () => addConstraint('lookAt'), { class: 'btn btn-small', title: 'Turn this joint to point at another' }),
      button('Copy rot.', () => addConstraint('copyRot'), { class: 'btn btn-small', title: 'Take another joint\'s rotation' }),
    ) : null,
    bone?.control ? h('p', { class: 'muted small' }, 'A control: it moves no vertices and stays out of exports. Move and key it to drive what follows it.') : null,
    m.constraints?.length ? h('p', { class: 'muted small' }, 'Exports bake constraints into plain keys and leave controls out.') : null,
  );
}
