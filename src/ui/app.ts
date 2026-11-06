// Shared handles between the shell, commands and panels.
import type { Viewports } from '../view/viewports';
import type { Timeline } from './timeline';
import type { UVEditor } from './uvEditor';

export const app = {
  vp: null as unknown as Viewports,
  uv: null as unknown as UVEditor,
  timeline: null as unknown as Timeline,
  setWorkspace: (_w: 'block' | 'model' | 'uv' | 'rig' | 'animate') => {},
  showTab: (_t: string) => {},
  toggleTimeline: () => {},
  uvRefresh: () => {},
};
