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
| Orbit | Right drag, or Alt + left drag, turning like Blender's turntable: sideways turns about the up axis, up and down tilts, and it carries on over the top and underneath without stopping. It turns around the part of the model under the mouse, or the selection when the mouse is over empty space. A pen's barrel button works as the right button |
| Bank (perspective) | Alt + right drag; Shift + G levels the view |
| Pan | Middle drag, or Alt + drag in an orthographic view |
| Pan along the ground (perspective) | Shift + Alt + left drag |
| Pan up or down (perspective) | Shift + Alt + right drag |
| Zoom | Wheel, or Ctrl + Alt + drag: up or right zooms in |
| Pan, rotate, zoom buttons | Drag the buttons in a pane's upper-right corner |
| Move selection by keyboard | With something selected, arrows move it a tenth of a grid square (or one snap step) along the axis that points that way in the view under the mouse; Shift moves a tenth as far. Quick presses undo as one move |
| Pan by keyboard | With nothing selected, arrows move 1 grid square; Shift 4. Alt pans a tenth, or the snap step when snapping is on, whatever is selected; Alt + Shift 10 times Alt |
| Zoom by keyboard | `.` in, `,` out; hold Shift for double |
| Center view at mouse | V |
| Fit all / selected | A / Shift + A |
| Change view (numpad, as in Blender) | 1 Front, 3 Right, 7 Top; with Ctrl, or pressed again, the opposite side. 5 switches between perspective and orthographic, keeping the direction. 4 and 6 orbit 15° sideways, 8 and 2 tilt 15°, 9 swings round to the other side. `.` frames the selection |
| Select | Click or drag a box; Shift adds, Ctrl removes |
| Tools | Q select, W move, T extrude, J joint, B weight paint, C sculpt. The Rotate and Scale tools are in the toolbar |
| Extrude like Blender | E over a view: selected faces push out along their normal and follow the mouse; selected edges (or points along them) pull out into new faces and move with the mouse. X, Y or Z locks an axis, typing gives an exact distance, a click keeps it. From the Mesh menu or the side panel it extrudes by a set distance instead, which you can change afterwards (Distance, and Along vertex normals or a direction for edges) |
| Move, rotate, scale like Blender | G, R or S over a view: the selection follows the mouse. G moves it in the view's plane, R turns it as you circle the mouse around it, S scales it by your distance from it |
| While moving, rotating or scaling | X, Y or Z locks an axis (Shift for the other two; the same key again unlocks). Type a number for an exact distance, angle in degrees or factor. Ctrl snaps, Shift is fine. Click or Enter keeps it, Esc or right click cancels |
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

## Extruding

It works the way SketchUp's Push/Pull and Blender's extrude do.

- **Push/Pull:** with the Extrude tool, the face under the mouse lights up. Drag it to pull it out or push it in. A face that's part of the selection takes the whole selection with it.
- **Click and move:** click a face without dragging, move the mouse, then click again to set the distance.
- **Extrude the selection (T):** press T over a view with faces selected, and they extrude and follow the mouse straight away. Click or press Enter to keep it.
- **While extruding:** type a distance for an exact one, then press Enter. Ctrl toggles snapping, Shift gives fine control, and Alt pushes along vertex normals. Esc or a right click puts everything back.
- **Repeat:** double-click a face to extrude it by the last distance again.

## Cutting

Both tools work the way Blender's do. Pressed on the keyboard they do one job and hand back the tool you were using. Picked from the toolbar or Mesh menu they stay on.

**Loop Cut (Ctrl+R):** Hover an edge to preview the loop across it. Wheel, Page Up/Down, + and - or typed digits change the number of cuts. Click to place it, then move to slide and click to confirm, or drag to do both at once. Right click or Esc during the slide leaves it centred. While sliding: E even, F flip, C clamp, Alt holds the clamp off, Shift for precision, Ctrl to snap, or type a value from -1 to 1. Number of Cuts, Factor, Smoothness, Even and Flipped stay adjustable in the panel afterward.

**Knife (K, or Shift+K for selected faces only):** Click to place points, or drag to draw. Points snap to corners and edges; Ctrl snaps to edge midpoints and Shift turns snapping off. Enter or Space confirms, Esc cancels, E or a right click starts a new line, a double-click closes the loop, and Ctrl+Z takes back a point. A toggles angle snapping, C cuts through to the far side, X, Y and Z lock to an axis, and S shows lengths and angles. The middle mouse button and wheel still move the view. A cut that stops partway across a face runs on to the nearest corner, so every face stays a clean outline. In Animate, K still keys a pose.

## Building faces

The Face tool builds a mesh point by point, in any view, as Blender's Poly Build does.

- **Where points go:** on the model under the mouse, so you can draw a new mesh over an old one, or else on a plane through your last point: facing the view in perspective (so a mesh can climb and turn), or the view's own plane in front, side and top views. Alt places one point freely, past surfaces and points.
- **Carrying on:** click a vertex of any visible mesh to use it, or an open edge to build from it; faces that use an existing mesh's points join that mesh, and a drawing started in empty space is a new mesh.
- **Editing as you go:** each new face is selected, so G moves it, R rotates, S scales, T extrudes and Ctrl+B, I, M and the rest work without leaving the tool. Shift+click selects what's under the mouse instead of adding a point. G over a vertex grabs just that vertex to move with the mouse; click to place it.
- **Finishing:** Enter or a double-click makes the face and finishes the drawing. Clicking the first point makes it too. Backspace or a right click takes the last point back; a right drag still orbits. Esc stops.
- **Options, in the Scene panel while the tool is on:**
  - *Shape:* Free (any number of corners), Tri or Quad (the face is made as soon as it has 3 or 4).
  - *After a face:* Finish, or Continue from its last edge as a strip (Tab flips which end); with Quad, two clicks then add each next quad.
  - *Perspective plane:* View or Ground (N switches).
  - *Land on surfaces*, *Snap to vertices*, *Double sided* (sets the mesh's material to show both sides), *Smooth* and *Mirror X* (builds the mirrored face too, sharing points on the centre line).
  - *Flip faces* turns the selected faces (or the last one made) round; *Face outward* turns the whole mesh (or the selection) to face outward.

## Bending along a curve

The **Bend** tool (Shift+W, Mesh > Bend, or Bend in the side panel's mode tools) shapes things organically: tails, horns, necks, fingers, leaves, tentacles.

- Select vertices, edges or faces. A curve appears along them, with square ends and round handles.
- Drag an end or a handle, and the selection follows the curve smoothly. An end takes its handle with it; Alt drags it alone. Esc or a right click while dragging puts it back. Each drag is one undo step.
- Several pieces at once: **Together** bends the whole selection along one curve. **Each piece** gives every separate part its own copy of the curve, scaled to it, so bending one selected finger bends them all alike.
- In the side panel:
  - **Along** picks the curve's direction: Auto (the selection's longest way), X, Y or Z.
  - **Twist** turns the far end around the curve.
  - **Start size** and **End size** taper or swell it; an End size of 0 comes to a point.
  - **Arc**, **S-curve**, **Hook** and **Bow** are ready-made curves. They bend toward the right of the view you last used.
  - **Straighten** puts it back. **New bend** keeps the shape and starts a fresh, straight curve, to bend it further.
- Clicking away from the curve selects as usual, and the curve moves to the new selection.

## Mirroring

Two kinds, as in Blender:

- **Symmetry (Mirror X, Shift+X):** edit one side and the other follows: moves, sculpting, weight painting, blockout pieces and new faces.
- **Live mirror (the Mirror card in the Scene panel):** with Mirror on, or on a part that has one, press Add Mirror. The part shows mirrored without the copy being real, so you model one half. As Blender's Mirror modifier:
  - *Axis* X, Y and Z, in any mix.
  - *Bisect* cuts the mesh at the mirror plane first, dropping what's past it; *Flip* keeps the other side.
  - *Mirror object* sets what the planes pass through: the world origin, a joint, or another part's centre.
  - *Clipping* stops points crossing the plane while you edit, and keeps points on it there.
  - *Merge* joins the halves along the seam, within its distance; *Bisect distance* says how close counts as on the plane.
  - The eye turns it off and on, the tick applies it (making the mirrored half real), and the cross removes it. Exports apply it for you.

## Tools for each selection mode

The Scene panel opens with the tools for the selection mode in use (Vertex, Edge, Face, Group or Joint), as buttons grouped by what they do. Hovering any button in the app shows its name, its shortcut as keys and what it does:

- **Vertex editing:** move, rotate and scale; merge, weld, collapse, connect, make face and dissolve; relax, flatten, circle, space, curve and extrude; fill, grid fill and bridge; selecting linked, grown, shrunk, by path or open edges; duplicate and delete.
- **Edge editing:** extrude, bevel, loop cut, knife, bridge and spin; circle, space, curve, flatten, merge and dissolve; fills; seams; loop, ring and other selections.
- **Face editing:** extrude, inset, bevel, poke, subdivide and solidify; dissolve, triangulate, to quads, mirror, bridge and merge; flip and outside; shading; detach, separate, loose parts, duplicate and delete; and selecting by coplanar, n-gons, triangles, checker or path.
- **Group editing:** duplicate, merge, loose parts, mirror and delete; centre, to ground and real-world height; shading; LODs and colliders.
- **Joint editing:** add, insert, mirror, humanoid and delete; move, rotate, IK drag and test pose; weighting, assigning, painting and finding unweighted vertices.

## Seeing and picking faces

- The backs of faces show in a see-through red, as Blender's face orientation does, so a face turned the wrong way stands out; select it from behind and Mesh > Flip Normals turns it round. View > Show Back Faces turns the tint off.
- Clicks select the nearest face from either side.
- What a click would select lights up under the mouse: the face (or the whole group in Group mode), edge or vertex.
- The side panel's sections fold away with a click on their heading, and stay folded.

## Shaping, filling and joining

All in the Mesh menu, after Blender and its LoopTools add-on. Each leaves its settings in the panel at the foot of the view, to change after.

- **Inset (I):** as Blender's: the selected faces inset as one region with an even border. Over a view, move the mouse toward the selection's middle to widen it; Ctrl+mouse sets Depth (in or out), I switches Individual (each face on its own), E switches Even, Shift is finer, and typing gives an exact width. Click or Enter keeps it, right click or Esc cancels; Thickness, Depth, Individual and Even stay adjustable in the panel.
- **Merge (M):** the selected vertices become one, at their centre, the first or last picked, or only those within a distance of each other. In Group mode (4), M merges the selected groups instead.
- **Bevel (Ctrl+B):** cuts the selected edges back into flat strips by Width, with a small face where bevelled edges meet. In Face mode it bevels the faces' edges.
- **Loop tools:** Circle makes a loop round in its own plane; Flatten moves points onto the plane that fits them; Space Evenly spreads a loop's points evenly along it; Curve smooths a line of edges into an even curve; Relax smooths points. They work on selected edges, points, or the rim of selected faces.
- **Bridge Edge Loops:** joins two or more loops with faces, lining them up and handling different point counts; Segments adds rows between and Twist turns one. In Face mode, select two faces and it opens a tube between them.
- **Grid Fill:** fills a hole with a grid of quads that follows its rim; the hole needs an even number of edges. Span sets how many across, Offset where the grid starts. **Fill** closes any hole with triangles. Select the hole's edge first.
- **Dissolve:** removes the selected points, edges or faces but keeps the surface: the faces around join into one.
- **Connect Vertices:** splits faces with an edge between selected vertices on them. **Poke Faces** fans triangles from each face's middle.
- **Solidify** gives a surface thickness. **Spin** sweeps a profile of edges round an axis, like a lathe.
- **Separate Loose Parts** gives each separate piece its own group.
- **Selecting (Edit menu):** Shortest Path between two selected vertices, edges or faces; N-gons; Triangles; Checker Deselect.

## Blocking out

Open the Blockout workspace (Ctrl+5) to rough out a character fast, or any other model, from simple pieces. Each piece is its own colour, and stays an ordinary mesh you can refine, unwrap or rig later.

Start from a Character, Chibi or Creature body made of named pieces, or from nothing. Symmetry is on, so a limb on one side appears on the other.

To work over a drawing or photo, press Front, Side, Top or Back under Reference images, or drop a picture onto a view. Drag it into place and scale it by a corner, then pick a shape. It shows behind that view and stands in the perspective view too. See-through pieces lets you trace it. Pictures are saved with the project and never exported.

1. Pick a body part (Head, Torso, Arm, Leg, Hand, Foot, Ear, Horn, Tail or Wing) and drag from one end of it to the other, such as chin to crown or shoulder to wrist. The Limb tool does the same for plain limbs.
2. For anything else organic, Tube turns a freehand line into a rounded tube for tentacles or hair, Draw Shape inflates a freehand outline into a solid you shape with the same three rings as Pen Shape below (Enter finishes, Esc cancels, and drawing again starts the next one), and Lathe spins half an outline around the centre line. Other shapes drag out as an outline in one view and then depth in another. The Create menu has every shape, including wedges, stairs and doorways.
3. **Pen Shape** draws an outline the way a vector pen does, then inflates it. Click for a corner, or drag for a curve. Click the first point, or press Enter, to close the outline.
   - **Reshaping:** drag points and handles. Click the outline to add a point, double-click a point to switch it between smooth and sharp, and Alt-drag a handle to break it. Backspace removes a point and Ctrl+Z steps back.
   - **Shaping:** closing the outline builds the piece straight away, and it follows the outline live as you reshape it.
     - Three coloured rings sit around it: blue at the top, green in the middle, pink at the bottom. Pull a round handle to set the width at that ring, or a square one to set the depth. Depth handles face you in the view you drew in, so use a side or perspective view for them.
     - The shape blends smoothly between the rings. Ctrl steps by 0.05, and double-clicking a handle sets it back to round.
   - **Finishing:** Enter, Space, a double-click or a right click. On an open outline these close it first, ready for shaping. Esc throws the piece away.
   - **The piece:** all quads, with rings along its length and a grid at each end instead of a pole, so it's ready to edit. Each ring's depth and width, Rings, Sides and Smooth stay adjustable in the panel afterward.
   - **Limbs:** parts that stick out and are clearly thinner than the body, like fingers, a thumb or ears, become their own round tubes along their own direction, reaching a little into the body so there's no crease. Each limb gets its own three rings, pink at the root, green in the middle and blue at the tip, with smaller handles: taper a fingertip or fatten a thumb. A limb's depth follows the body's, so thickening the body thickens its limbs too. It all stays one piece; Fuse melts it into a single mesh if you want one. Draw Shape does the same.
4. Shape pieces with the Sculpt brush (C): Grab, Inflate, Smooth, Flatten and Pinch. Taper, Bend and Twist reshape a whole piece. Round Off smooths a blocky piece, and Lower Poly simplifies one. Fuse melts overlapping pieces into one seamless mesh, and a low Detail gives a low-poly result.
5. Set Detail to Low Poly for chunky, flat-shaded pieces, or Medium or High for smooth ones.
6. Start a drag on an existing piece to attach to it.
7. With Symmetry across X on, finishing a piece on one side adds its other side, and moving a piece moves its mirror image too. Mirror adds the other side to a piece you already have.
8. Move, rotate and scale whole pieces with W, E and R. Shift+D duplicates and picks up a copy, and Array repeats a piece in a line for fingers or ribs, Radial repeats one around a centre for petals or spikes, and Isolate (Alt+I) hides everything else while you work.
9. Snapping, measurements and a size reference are in the panel's Precision section, off or out of the way until you want them.
10. Join combines pieces, and Colours to Materials keeps the colours when you export.

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

2. Press U or Auto Unwrap. There are no seams to mark: it finds where to cut by itself, along the sharpest creases, and flattens with as little distortion as it can. Raise Max stretch in its panel for fewer islands, or lower it for less distortion.
3. Check the layout with View > Show Stretch and the overlap warnings below the editor. Press M for Minimize Stretch to even out distortion.
4. To place things by hand, pin points with N, turn on Pins > Live Unwrap, and drag a pin. The island re-solves around it, and pinned points hold through later unwraps.
5. Press P over the editor to pack the islands, or set a density with Arrange > Set Texel Density.

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

## Painting textures

Pick Paint from the workspace menu (Ctrl+6). The texture panel on the left shows the texture of the selection, or the active part, with the model's UV layout over it.

- **No texture yet?** Choose a size and press New texture. It's filled with the part's colour, and textures of 256 or smaller start as pixel art.
- **Tools:** Pencil (P) paints hard pixels, Brush (B) is soft with Opacity and Hardness, Eraser (E), Fill (G) with Tolerance and Every match, Line (L), Rectangle (U), Pick colour (I) and Select (S). Alt picks a colour with any tool.
- **Colours:** left click paints the main colour and right click the second; X swaps them. Click a swatch for the colour picker. The palette strip below has the built-in and your own palettes, plus recent colours.
- **Paint on the model:** drag on it in the view with the same tools. Shift paints the second colour. The brush paints as a ball on the surface, so a stroke carries on across UV seams onto the faces beside it, wherever their part of the texture is.
- **Layers:** + adds a layer above the active one, − deletes it, ↑ and ↓ move it, and Merge paints it onto the one below. Click a layer to paint on it, untick it to hide it, double-click to rename it; each has its own opacity. Layers are saved with the project; exports get the combined image.
- **Select (S):** drag a rectangle, then drag inside it to move what it holds. Painting and fills stay inside it. Delete clears it, Ctrl+C, Ctrl+X and Ctrl+V copy, cut and paste, H and V flip it, Ctrl+A selects everything, and Ctrl+D or Esc lets go.
- **Indexed colours:** the In layer strip lists every colour the active layer uses, for pixel art. Click one to paint with it, or double-click to recolour every pixel of it at once. Reduce… cuts the layer down to a number of colours.
- **More:** `[` and `]` change the size, M mirrors across the texture's centre, F fits the texture, and Space-drag or the middle button pans. The wheel zooms in whole steps, so pixels stay square, and a pixel grid shows when zoomed in.
- **Pixel art** keeps a texture sharp in the view and exports it with nearest-neighbour sampling in glTF.

Every stroke is one undo step.

## Tiles

Pick Tile Editor from the workspace menu (Ctrl+7). The panel on the left shows the tile atlas.

- **The atlas:** press Load atlas… for an image of tiles, or it uses the selection's own texture. Set Tile W and H, and Margin and Spacing if the tiles have gaps. Click a tile to choose it, or drag over several to choose a block. A preview shows it as it will go down.
- **Paint (P):** drag across faces. Each face gets the tile fitted to its own shape and upright as it stands in the scene, so walls, floors and slopes all read the right way. A block of tiles repeats as a pattern across neighbouring faces; with Random on, each face takes a random tile from the block that stays put if painted again.
- **Fill (G):** tiles every face joined to the one clicked on the same flat surface.
- **Build (T):** click or drag to add tile squares, the way tile-based modelers do. They go on the flat face under the mouse, or on the view's own grid plane, which Page Up and Page Down move a tile at a time. Size sets a tile's width in metres. Built tiles share corners with their neighbours, so they make one clean surface.
- **Erase (E)** removes built tiles; it never touches the rest of a model. **Pick (I)**, or Alt-click in any mode, takes the tile a face shows.
- **Turn and flip:** R turns the tile clockwise and Shift+R back; F flips it left to right and Shift+F upside down. `[` and `]` step through the atlas.
- **Inset** pulls each tile in by half a pixel, so neighbours never bleed in on smoothed textures.
- **Repeat** (Paint and Fill): a quad bigger than a tile is cut into tile-sized pieces (Size, in metres), so the tile repeats across it instead of stretching.
- **Stamp** (Build): a chosen block goes down whole, the way it looks in the atlas; dragging lays more beside it, edge to edge.
- **Cube** (Build): build tile cubes instead of flat tiles, Height cubes tall. Click a cube's side or top to build onto it. Where cubes meet, the sides between them are left out, so a block of cubes is one closed shape. With Cube on, Erase takes away a whole cube and shows the sides of the cubes beside it.
- **Autotile** (Build): each built tile is chosen by which of its neighbours are filled, and its neighbours change to suit as you build or erase. Choose the set's first tile in the atlas: Autotile 16 reads a 4×4 block by its sides (tile number N + 2E + 4S + 8W), and Autotile 47 reads an 8×6 block of the 47 blob shapes, corners included. Template makes an atlas in that layout to build with straight away, or to paint over in the Paint workspace.
- **Recent and Kept:** the strip under the grid settings shows the tiles used lately; Keep saves the chosen tile or block, turned as it is, for this atlas. Click one to choose it again; right click a kept one to remove it.

Every stroke is one undo step.

## Rigging

Open the Rigging workspace (Ctrl+3).

2. Build the skeleton: Rig > Add Humanoid Skeleton fits a named T-pose to the mesh, or the Joint tool (J) draws chains. Mirror Joints copies one side to the other.
3. Press Auto-weight all. Surface heat, the default, spreads each joint's influence along connected skin, so a leg doesn't pull on the leg beside it. Distance is there as an alternative.
4. Press Test pose and rotate joints to check the bends. It needs no clip and isn't saved.
5. Fix what you see with the weight brush (B): Shift subtracts, Ctrl smooths, `[` and `]` resize, and Mirror X paints both sides. Select vertices for exact numbers in the Rig panel.
6. Finish with Mirror, Smooth and Clean up. The panel warns about vertices with no weight.

Deleting a joint passes its children and weights to its parent.

### Constraints

Select a joint and add rules it follows when posed, in the Rig panel's Constraints section. They apply in every clip, on top of the keys.

- **IK** bends the joints above this one (Joints sets how many) so it reaches a target. Adding IK makes the target for you, a *control* joint where the end joint is now. Add pole makes a second control the chain bends toward, as an elbow or knee points. Match the target's rotation turns the end joint with it, for a planted foot or a gripping hand.
- **Limit** keeps a joint's rotation within angles about its own axes. IK keeps to limits as it bends.
- **Look at** turns a joint to point at another, such as eyes or a head following a control.
- **Copy rotation** takes another joint's rotation.

Controls (shown with a diamond) move no vertices and are left out of exports. Exports write what the constraints do as plain keys, so the motion plays the same in any engine.

## Animating

Open the Animation workspace (Ctrl+4) and press Clip > New Clip. Rotate or move a joint and a key is written at the current frame.

- **Pose:** the Rotate tool (E) turns one joint. IK Drag (Y) pulls a hand or foot and the limb follows; Joints sets how far up the chain bends, and Hold keeps a foot flat.
- **Copy poses:** the Pose menu copies a pose, pastes it, or pastes it mirrored, which gives you the second half of a walk from the first.
- **Keys view:** click or box-select keys. Drag to move, Ctrl-drag to copy, drag the ends of a selection to stretch its timing. Delete removes them; Ctrl+C and Ctrl+V copy them to the current frame.
- **Curves view:** Tab switches to it. Each channel of the active joint is drawn as a curve. Drag a dot up or down to change the value, or sideways to retime it, with Shift for both. Click a dot to get handles that shape the timing to the next key.
- **Curve menu:** Linear, Smooth, Ease In, Ease Out, Overshoot, Anticipate and Hold.
- **Whole clips:** the Clip menu has Make Seamless Loop, Mirror, Reverse, Change Speed, Reduce Keys and Bake.
- **Seeing motion:** Onion Skin (Alt+O) shows frames before in red and after in green. Motion Trail draws the selected joints' paths.
- **IK and FK:** with IK on a limb, move and key its target and the chain follows. Each constraint's weight blends between IK (1) and the joints' own keys (0), and Key turns it into a curve over the clip. Snap IK to FK keys the target where the keyed joints put the end, and Bake IK to FK keys the joints where IK puts them, so switching either way doesn't jump.
- **Events:** the Event button (E over the timeline, or double-click the ruler) adds a named moment, such as a footstep or a hit, shown as a flag. Drag a flag to move it, double-click to rename, right click to remove. glTF keeps them in each animation's extras as name, time and frame, where Godot and most loaders can read them.
- **Play range:** Shift-drag the ruler, or press I and O over the timeline, to play and loop just that stretch while you work on it. Drag its ends to change it; × in the timeline bar plays the whole clip again. It's saved with the clip and doesn't affect exports.

| Over the timeline | Input |
| --- | --- |
| Scrub | Drag the ruler |
| Zoom / pan time | Ctrl+wheel / Shift+wheel or right drag |
| Fit the clip | A or F |
| Play | Space or P |
| Add an event | E, or double-click the ruler |
| Play range | Shift-drag the ruler; I and O set its ends |

GLB and MS3D store linear keys here, so curves export as the motion they produce: eased stretches gain a key per frame.

## Getting it into a game

- **Export presets:** File > Export has presets for Godot 4, Unity (glTFast), Unreal Engine 5, Roblox, the web, Sketchfab, mobile, 3D printing and older engines. Each sets the format and options for that target; change anything and Save… keeps it as a preset of your own. Largest texture shrinks bigger textures as they're written, leaving the project's own as they are.
- **Bake (Game > Bake…):** bakes into the chosen part's material through its UV layout, which shouldn't overlap.
  - *Ambient occlusion* shades creases and corners where light reaches less. Rays per texel trades smoothness for speed, Reach is how far away something can be and still shade, and it goes into the occlusion map or straight into the colour, for unlit looks.
  - *Normals from a detailed part* give a simple part the look of a detailed one lined up with it, such as a sculpted or subdivided copy. Search distance should be a little more than the biggest gap between the two. Hide the detailed part afterwards, or delete it.
- **Make Texture Atlas (Game menu):** packs every visible part's colour textures into one, with plain-coloured materials as small swatches, and draws everything with one new material, for fewer draw calls. Faces that repeat a texture are squeezed into one copy; normal, ORM and glow maps aren't carried over.

## Resizing

Drag the dividers between the four viewports, the UV editor, the 3D view, the side panel and the timeline. Dragging from where the viewport dividers cross moves both at once. Double-click a divider to reset it. Sizes are remembered between runs.

## Files and keeping work safe

- **Autosave** keeps unsaved work a few seconds after you stop editing, every 45 seconds during long sessions, and whenever the window loses focus. If ThickShake closes without saving, the next start offers to recover it, saying which project it was, when it was kept and what's in it, and brings it back under its own name, still unsaved. In a browser it's kept in the browser's own storage, which holds projects with textures too.
- **Open Recent** (File menu, Ctrl+Shift+O) lists the projects you opened or saved lately. The desktop app finds them by their path; a browser keeps the last few in its own storage, since it can't reopen files from disk.
- **Save a Copy** writes the project to another file and carries on with this one, unsaved changes and all.
- **Your own shortcuts:** Help > Customize Shortcuts lists every command with its key. Click a key and press the new one; Backspace clears it. Taking a key another command used leaves that one without a key, and says so. Reset puts one back, Reset all puts every key back. Keys inside the view's tools (G, R and S while moving, and the paint and tile keys) stay as they are.

## Conventions

- +Y is up, the space is right-handed, and 1 unit = 1 metre.
- Texture V runs down from the top of the image, matching glTF.
- Normal maps are the OpenGL kind glTF uses: green points up the image. Flip a DirectX map's green in the Material panel.
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
