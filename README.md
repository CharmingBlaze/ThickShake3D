# ThickShake

A fast low-poly modeler, rigger and animator for game makers. It's a Windows desktop app built on Electron, TypeScript and Three.js.

ThickShake is an independent project, inspired by the workflow of classic low-poly tools such as MilkShape 3D. It isn't affiliated with them and uses none of their code or artwork. It reads and writes `.ms3d` so older work can move across.

## Run it

Run the packaged app:

```bash
release/ThickShake-win32-x64/ThickShake.exe
```

Or run it from source:

```bash
npm install
npm start
```

Other commands:

```bash
npm run dist
```

```bash
npm test
```

```bash
npm run e2e
```

`dist` builds the `.exe`, `test` runs the unit tests, and `e2e` drives the real app with real mouse input.

## Getting around

| Action | Input |
| --- | --- |
| Orbit | Right drag, or Alt + left drag |
| Bank (perspective) | Alt + right drag; Shift + G levels the view |
| Pan | Middle drag, or Alt + drag in an orthographic view |
| Pan along the ground (perspective) | Shift + Alt + left drag |
| Pan up or down (perspective) | Shift + Alt + right drag |
| Zoom | Wheel, or Ctrl + Alt + drag: up or right zooms in |
| Pan, rotate, zoom buttons | Drag the buttons in a pane's upper-right corner |
| Pan by keyboard | Arrows move 1 grid square; Shift 4; Alt a tenth, or the snap step when snapping is on; Alt + Shift 10 times Alt |
| Zoom by keyboard | `.` in, `,` out; hold Shift for double |
| Center view at mouse | G |
| Fit all / selected | A / Shift + A |
| Change view | Numpad 1 Back/Front, 2 Top/Bottom, 3 Right/Left, 4 Perspective |
| Select | Click or drag a box; Shift adds, Ctrl removes |
| Tools | Q select, W move, E rotate, R scale, T extrude, J joint, B weight paint |
| Modes | 1 vertex, 2 edge, 3 face, 4 group, 5 joint |
| Frame selection / all | Z / Home |
| Maximize pane | Space or Numpad 0 |
| Find any command | Ctrl+K |
| All shortcuts | F1 |

The navigation follows LightWave's documented controls. Moving one view moves the others too: they share a centre, and orthographic views share a zoom. Turn this off with View > Link Viewports. In the Animation workspace, Left and Right keep stepping through frames instead of panning.

## Drawing primitives

Pick a shape from the Create menu or the toolbar, then:

1. Drag in a view to draw its outline. In an orthographic view the shape's main axis points at you. Ctrl makes the outline symmetrical.
2. Drag in another view to add depth. In the perspective view, a vertical drag sets the height.
3. Drag sides or corners to resize, or the centre to move. Left and Right change horizontal segments; Up and Down change vertical segments.
4. Double-click, right click, Enter or Space to finish, ready to draw the next one. Esc removes it.

Create > Low Poly uses minimal segments with flat shading. Create > Draw on Surface builds the shape on the face under the start of the drag, along that face's normal.

## Cutting

Both tools work the way Blender's do. Pressed on the keyboard they do one job and hand back the tool you were using. Picked from the toolbar or Mesh menu they stay on.

**Loop Cut (Ctrl+R):** Hover an edge to preview the loop across it. Wheel, Page Up/Down, + and - or typed digits change the number of cuts. Click to place it, then move to slide and click to confirm, or drag to do both at once. Right click or Esc during the slide leaves it centred. While sliding: E even, F flip, C clamp, Alt holds the clamp off, Shift for precision, Ctrl to snap, or type a value from -1 to 1. Number of Cuts, Factor, Smoothness, Even and Flipped stay adjustable in the panel afterward.

**Knife (K, or Shift+K for selected faces only):** Click to place points, or drag to draw. Points snap to corners and edges; Ctrl snaps to edge midpoints and Shift turns snapping off. Enter or Space confirms, Esc cancels, E or a right click starts a new line, a double-click closes the loop, and Ctrl+Z takes back a point. A toggles angle snapping, C cuts through to the far side, X, Y and Z lock to an axis, and S shows lengths and angles. The middle mouse button and wheel still move the view. A cut that stops partway across a face runs on to the nearest corner, so every face stays a clean outline. In Animate, K still keys a pose.

## Blocking out

Open the Blockout workspace (Ctrl+5) to rough out a character fast, or any other model, from simple pieces. Each piece is its own colour, and stays an ordinary mesh you can refine, unwrap or rig later.

Start from a Character, Chibi or Creature body made of named pieces, or from nothing. Symmetry is on, so a limb on one side appears on the other.

To work over a drawing or photo, press Front, Side, Top or Back under Reference images, or drop a picture onto a view. Drag it into place and scale it by a corner, then pick a shape. It shows behind that view and stands in the perspective view too. See-through pieces lets you trace it. Pictures are saved with the project and never exported.

1. Pick a body part (Head, Torso, Arm, Leg, Hand, Foot, Ear, Horn, Tail or Wing) and drag from one end of it to the other, such as chin to crown or shoulder to wrist. The Limb tool does the same for plain limbs.
2. For anything else organic, Tube turns a freehand line into a rounded tube for tentacles or hair, Draw Shape inflates a drawn outline into a solid, and Lathe spins half an outline around the centre line. Other shapes drag out as an outline in one view and then depth in another. The Create menu has every shape, including wedges, stairs and doorways.
3. Shape pieces with the Sculpt brush (S): Grab, Inflate, Smooth, Flatten and Pinch. Taper, Bend and Twist reshape a whole piece. Round Off smooths a blocky piece, and Lower Poly simplifies one. Fuse melts overlapping pieces into one seamless mesh, and a low Detail gives a low-poly result.
4. Set Detail to Low Poly for chunky, flat-shaded pieces, or Medium or High for smooth ones.
5. Start a drag on an existing piece to attach to it.
6. With Symmetry across X on, finishing a piece on one side adds its other side, and moving a piece moves its mirror image too. Mirror adds the other side to a piece you already have.
7. Move, rotate and scale whole pieces with W, E and R. Shift+D duplicates and picks up a copy, and Array repeats a piece in a line for fingers or ribs, Radial repeats one around a centre for petals or spikes, and Isolate (Alt+I) hides everything else while you work.
8. Snapping, measurements and a size reference are in the panel's Precision section, off or out of the way until you want them.
9. Join combines pieces, and Colours to Materials keeps the colours when you export.

## Materials

The Material tab has a live preview and a row of Looks, such as Skin, Cloth, Gold, Car Paint, Glass and Flat Colour. A look changes a material's values and keeps its textures.

- **Finish:** Clearcoat, Sheen and Glass add to the usual Metallic and Roughness. Unlit ignores lighting, for stylised models.
- **Maps:** Load base colour, normal, emissive and occlusion/roughness/metallic maps. Separate greyscale maps pack into the combined one glTF needs.
- **Normal tools:** From Base Colour generates bumps from a texture, Strength scales them, and Flip Green fixes DirectX-style maps that look inside out.
- **Placement:** Tiling, Shift and Turn apply to all of a material's maps. Half Size shrinks them for smaller files.

- **Colours:** Any colour button opens a picker with a saturation square, hue bar, hex box, screen eyedropper, recent colours, palettes, and shades and matches of the current colour.
- **Palettes:** Skin tones, Hair, Earth, Foliage, Metals and more are built in. Add your own colours, pull a palette out of an image with From Image, or load a .gpl, .hex or .txt file. Your palettes are kept between projects.
- **Gradients:** Add Gradient, or pick a preset. Click the bar to add a colour, drag markers to move them, and click one to choose its colour. Pick Linear, Mirror or Radial, a direction, and optional flat Bands for toon looks. Across The Model follows the shape whatever the UVs do; Across The Texture follows the UVs and tiles. It bakes to an ordinary texture, so it works in any engine. Re-bake after changing a model's shape.
- **Importing images:** Drop images on a map slot, anywhere on the Material panel, or onto a piece in the view, or paste with Ctrl+V. Dropped elsewhere in a view, or anywhere in Blockout, a picture becomes a reference image. Whole texture sets sort themselves by file name, separate roughness, metallic and AO maps pack together, and DirectX normal maps named `_dx` are corrected.

All of this exports to GLB as standard glTF. Clearcoat, sheen, glass, unlit and tiling use glTF extensions, so check that your engine's importer supports the ones you use. Glass shows as a see-through approximation in the viewport, without real refraction. MS3D, OBJ and the other simple formats keep only the basics.

## Editing UVs

Open the UV workspace (Ctrl+2). Select faces in the 3D view to choose what the editor shows.

1. Press U or Auto Unwrap. There are no seams to mark: it finds where to cut by itself, along the sharpest creases, and flattens with as little distortion as it can. Raise Max stretch in its panel for fewer islands, or lower it for less distortion.
2. Check the layout with View > Show Stretch and the overlap warnings below the editor. Press M for Minimize Stretch to even out distortion.
3. To place things by hand, pin points with N, turn on Pins > Live Unwrap, and drag a pin. The island re-solves around it, and pinned points hold through later unwraps.
4. Press P over the editor to pack the islands, or set a density with Arrange > Set Texel Density.

Seams are optional: to force a cut somewhere, select edges or faces and press Alt+S.

| Action over the editor | Input |
| --- | --- |
| Vertex, edge, face, island selection | 1, 2, 3, 4 |
| Select | Click or drag a box; Shift adds, Ctrl removes |
| Select an island | Double-click, or L under the cursor |
| Move | Drag the selection; Shift locks an axis |
| Scale | Drag the box handles; Shift frees a corner's aspect |
| Rotate | Drag the round handle above the box |
| Snap | Ctrl during a drag, or View > Snap to Grid |
| Frame selection / all | F / A |
| Pan / zoom | Right or middle drag / wheel |
| Pack, weld, stitch | P, W, S |
| Pin, minimize stretch | N, M |
| Rotate 90, flip U, flip V | R, X, Y |

View > Export UV Layout saves the wireframe as a transparent PNG to paint over.

## Rigging

Open the Rigging workspace (Ctrl+3).

1. Build the skeleton: Rig > Add Humanoid Skeleton fits a named T-pose to the mesh, or the Joint tool (J) draws chains. Mirror Joints copies one side to the other.
2. Press Auto-weight all. Surface heat, the default, spreads each joint's influence along connected skin, so a leg doesn't pull on the leg beside it. Distance is there as an alternative.
3. Press Test pose and rotate joints to check the bends. It needs no clip and isn't saved.
4. Fix what you see with the weight brush (B): Shift subtracts, Ctrl smooths, `[` and `]` resize, and Mirror X paints both sides. Select vertices for exact numbers in the Rig panel.
5. Finish with Mirror, Smooth and Clean up. The panel warns about vertices with no weight.

Deleting a joint passes its children and weights to its parent.

## Animating

Open the Animation workspace (Ctrl+4) and press Clip > New Clip. Rotate or move a joint and a key is written at the current frame.

- **Pose:** the Rotate tool (E) turns one joint. IK Drag (Y) pulls a hand or foot and the limb follows; Joints sets how far up the chain bends, and Hold keeps a foot flat.
- **Copy poses:** the Pose menu copies a pose, pastes it, or pastes it mirrored, which gives you the second half of a walk from the first.
- **Keys view:** click or box-select keys. Drag to move, Ctrl-drag to copy, drag the ends of a selection to stretch its timing. Delete removes them; Ctrl+C and Ctrl+V copy them to the current frame.
- **Curves view:** Tab switches to it. Each channel of the active joint is drawn as a curve. Drag a dot up or down to change the value, or sideways to retime it, with Shift for both. Click a dot to get handles that shape the timing to the next key.
- **Curve menu:** Linear, Smooth, Ease In, Ease Out, Overshoot, Anticipate and Hold.
- **Whole clips:** the Clip menu has Make Seamless Loop, Mirror, Reverse, Change Speed, Reduce Keys and Bake.
- **Seeing motion:** Onion Skin (Alt+O) shows frames before in red and after in green. Motion Trail draws the selected joints' paths.

| Over the timeline | Input |
| --- | --- |
| Scrub | Drag the ruler |
| Zoom / pan time | Ctrl+wheel / Shift+wheel or right drag |
| Fit the clip | A or F |
| Play | Space or P |

GLB and MS3D store linear keys here, so curves export as the motion they produce: eased stretches gain a key per frame.

## Resizing

Drag the dividers between the four viewports, the UV editor, the 3D view, the side panel and the timeline. Dragging from where the viewport dividers cross moves both at once. Double-click a divider to reset it. Sizes are remembered between runs.

## Conventions

- +Y is up, the space is right-handed, and 1 unit = 1 metre.
- Texture V runs down from the top of the image, matching glTF.
- Joints rest with identity rotation. Imported rigs are converted to this on load, and their animation is baked per frame or per key.

## File formats

| Format | Import | Export | Notes |
| --- | --- | --- | --- |
| `.tshake` | Yes | Yes | Native project format |
| GLB / glTF | Yes | Yes | PBR, textures, skeleton, every clip |
| MS3D | Yes | Yes | v3 and v4 read, v4 written; 65534 vertex limit |
| OBJ + MTL | Yes | Yes | Keeps n-gons; material colours are written, but MTL files aren't read |
| FBX, DAE | Yes | No | |
| STL, PLY | Yes | Yes | Geometry only |

## Layout

- `src/core`: document model, undo, mesh operations, skeleton, UV, LOD and audit logic. It has no UI code.
- `src/io`: file formats and native file access.
- `src/view`: viewport rendering, picking, gizmos and tool input.
- `src/ui`: commands, menus, panels, timeline, UV editor and dialogs.
- `electron`: the desktop shell.
