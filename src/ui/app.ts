// Shared handles between the shell, commands and panels.
import type { Workspace } from '../core/editor';
import type { Viewports } from '../view/viewports';
import type { Timeline } from './timeline';
import type { UVEditor } from './uvEditor';

export const app = {
  vp: null as unknown as Viewports,
  uv: null as unknown as UVEditor,
  timeline: null as unknown as Timeline,
  setWorkspace: (_w: Workspace) => {},
  showTab: (_t: string) => {},
  toggleTimeline: () => {},
  /** Whether the timeline is showing, for its menu tick. */
  timelineShown: () => false as boolean,
  uvRefresh: () => {},
  /** Redraw the Paint and Tile panels after their settings change. */
  paintRefresh: () => {},
  tilesRefresh: () => {},
  /** The Paint workspace's keys in the view: tools, colour swap, brush size. True if used. */
  paintKey: (_e: KeyboardEvent) => false as boolean,
  /** Run a command by its id, for the views, which can't import the command list. */
  run: (_id: string) => {},
};
