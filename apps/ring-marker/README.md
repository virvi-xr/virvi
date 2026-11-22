# Virvi ARCs

Virvi's own marker, the ARC (Augmented Reality Code): a round, printable plaque that a headset camera can find and read from across a room. It replaces the QR-code markers in `apps/ar-spike/markers/` for the AR spaces spikes. This folder is the reference implementation in Python: the code, the layout, print files, a synthetic camera test set and a reference detector. The Quest app (`apps/quest`) ports the codec and detector to Kotlin and checks them against the same vectors and images. `packages/shared/src/ring-marker` ports the codec’s encoder and the layout to TypeScript, so the server can make a space’s print files (`apps/server/src/ar/printfiles.ts`); `apps/server/test/ring-codec.test.ts` and `ring-layout.test.ts` check them against `vectors/codec.json` and `vectors/layout.json`.

## What an ARC is

At the 140 mm reference size (every length scales by `diameter / 140`):

- An outer **finder ring** from r = 62 to 70 mm, with one 16° gap at the top. Its outer edge is the ARC's diameter, and its gap gives the rotation.
- Three **code rings** (r = 51–59, 40–48 and 29–37 mm), each 24 cells of 15°. The 72 cells are 12 six-bit symbols of a Reed–Solomon RS(12,6) code over GF(64), so up to 2 bad symbols are corrected and cells the camera can't judge count as erasures. The 6 data symbols hold a 4-bit format version and a 32-bit ID.
- A **centre dot** (r = 12 mm), on a square plaque 150 mm across with corner marks. There's no text on the face.

The detector reads an ARC either way round: dark marks on a light plaque, or light marks on a dark plaque (same layout, same ID).

A ring the detector can see but not read is reported as unreadable (the apps show "step closer"); one lying anywhere inside a read ARC's finder ring is now dropped, so there are fewer stray "step closer" hints.

The ID appears in URLs as `virvi.io/s/<code>`, the 32-bit ID in 7 characters of Crockford base32. ARCs are never more than 256 mm across.

Code: `ringmarker/codec.py` (the code), `layout.py` (geometry), `render.py`, `printfiles.py` (PNG, PDF, STL, 3MF), `testset.py` (synthetic camera views) and `detect.py` (the reference detector; its docstring is the spec the Kotlin and Swift ports follow). `render(..., inverted=True)` draws an ARC light-on-dark.

## Test ARCs

| Name | Diameter | ID |
|---|---|---|
| `RING120` | 120 mm | `0x1D2C3B4A` |
| `RING140` | 140 mm | `0x2E3D4C5B` |
| `RING170` | 170 mm | `0x3F4E5D6C` |

The Quest app’s Developer panel shows readings for these IDs. The app itself reads any ring (once a space is open, only that space’s rings), and only once 3 frames in a row agree.

## Regenerate the files

Needs Python 3 with Pillow, NumPy, OpenCV and pytest (`pip install pillow numpy opencv-python pytest`). From this folder:

```sh
python3 make_ring_markers.py                            # print files for every test ARC, into out/
python3 -m ringmarker.testset testset                   # synthetic camera test set and manifest.json
python3 -m ringmarker.codec --vectors vectors/codec.json  # codec test vectors for the ports
```

Each ARC gets five files in `out/`:

- `<name>-reference.png`: the face at 10 px/mm, for checking by eye.
- `<name>-paper.pdf`: a US Letter page.
- `<name>-base.stl` and `<name>-raised.stl`: the two parts of a 3D print, sharing one origin.
- `<name>.3mf`: both parts in one two-colour file.

## Print them

**Paper.** Print `<name>-paper.pdf` at **100% / Actual size**, never "fit to page". Measure the bar under the ARC: it must be 100 mm. If it isn't, the printer scaled the page, the ARC is the wrong size and the distance the headset reports will be off by the same factor. Use matte paper, and mount it flat: a curled sheet reads as a tilted ARC.

**3D print.**

- The light base is 4.0 mm thick, and the dark parts stand 0.6 mm proud of it.
- Use **matte filament** for both colours. Glossy filament throws glare that wipes out cells.
- With one nozzle, load both STLs together (they share an origin, so they line up), print with light filament and **change to dark filament at 4.0 mm**. With a multi-material printer, open the 3MF instead: the base and raised parts are already coloured.
- Check the finished diameter (the finder ring's outer edge) with calipers: it should match the name, ±0.5 mm.

## Tests

```sh
python3 -m pytest -q
```

- `test_codec.py`: the code, including the correction limits, every rejection rule, and that `vectors/codec.json` is current.
- `test_layout.py`: the geometry, the finder gap, the corner marks and the size limit.
- `test_printfiles.py`: the files are written and the STLs are watertight.
- `test_testset.py`: the synthetic set generates, with exact ground truth.
- `test_detect.py`: the reference detector against the synthetic set, including two ARCs in one frame, damage past the correction limit (no ID, never a wrong one), decoys (a plate, a clock, a disc in a ring), rotated ARCs, glare and shadow, and light-on-dark ARCs (alone, beside a dark-on-light one, and a light-on-dark decoy).

The Quest port's tests (`apps/quest`, `./gradlew :app:testDebugUnitTest`) read `vectors/codec.json` and `testset/` from here. Gradle regenerates the test set before the unit tests whenever the `ringmarker` sources change.
