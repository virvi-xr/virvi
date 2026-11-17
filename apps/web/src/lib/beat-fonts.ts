// The BEAT pages' display face (the public hero and wallet pages only): Unbounded, wide and geometric.
import { Unbounded } from 'next/font/google'

export const beatDisplay = Unbounded({ subsets: ['latin'], weight: ['400', '700', '900'], variable: '--font-beat-display', display: 'swap' })
