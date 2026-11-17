// The BEAT pages' display face (the public hero and wallet pages only): Unbounded, wide and geometric.
import { Unbounded } from 'next/font/google'

// Loaded as one variable font (no weight list), like Inter: with a weight list, Google sometimes answers the build with
// extension-less /l/font?kit= URLs, which next/font can't load (release 595d7a9a's image build failed on that).
export const beatDisplay = Unbounded({ subsets: ['latin'], variable: '--font-beat-display', display: 'swap' })
