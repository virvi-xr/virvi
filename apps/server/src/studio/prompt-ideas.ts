import { db } from '../db/connection.js'
import { studioIdeaUses } from '../db/schema.js'
import type { Exec } from './quota.js'

/**
 * Example prompts for a design's first message: a pool of original ideas, kept here in code, that follow the chips
 * (the ticked slots for a wearable, the kind of move and playback for an emote). An idea is *retired* for everyone
 * once someone sends it as their design's first prompt, edited or not (studio_idea_uses, one row per idea), so two
 * people don't end up building the same thing; tapping one and not sending it uses nothing up. The page asks for a
 * few at a time (GET /designs/:id/prompt-ideas), and the admin page shows how many are left per slot and move.
 *
 * An idea's `id` never changes once shipped: it is what studio_idea_uses remembers. Retire an idea by deleting it from
 * the pool, never by reusing its id for another.
 */

/** The slots the page offers (SLOT_GROUPS in apps/web/src/lib/studio-prompt.ts), in its order. */
export const IDEA_SLOTS = [
  'hat', 'helmet', 'hair', 'mask', 'eyewear', 'earring', 'tiara', 'top_head', 'facial_hair',
  'upper_body', 'lower_body', 'feet', 'hands_wear', 'skin',
] as const
export type IdeaSlot = typeof IDEA_SLOTS[number]
/** The kinds of move and playbacks the page offers (MOVE_KINDS, PLAYBACKS in the same file). */
export const IDEA_MOVES = ['dance', 'gesture', 'reaction', 'prop'] as const
export type IdeaMove = typeof IDEA_MOVES[number]
export const IDEA_PLAYBACKS = ['loop', 'once'] as const
export type IdeaPlayback = typeof IDEA_PLAYBACKS[number]

export type Idea =
  | { id: string; kind: 'wearable'; slots: IdeaSlot[]; text: string }
  | { id: string; kind: 'emote'; move: IdeaMove; playback: IdeaPlayback; text: string }
export type IdeaKind = Idea['kind']

export const IDEA_TEXT_MAX = 300
export const IDEA_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const IDEA_ID_MAX = 40

const w = (id: string, slots: IdeaSlot[], text: string): Idea => ({ id, kind: 'wearable', slots, text })
const e = (id: string, move: IdeaMove, playback: IdeaPlayback, text: string): Idea => ({ id, kind: 'emote', move, playback, text })

// ── Wearables: one slot each ────────────────────────────────────────────────

const HATS = [
  w('bucket-hat-palm', ['hat'], 'A low-poly bucket hat in sky-blue canvas with a woven straw band and a small embroidered palm tree on the front. It hides the hair and fits both body shapes.'),
  w('fox-ear-beanie', ['hat'], 'A cartoon knitted beanie in rust orange wool with two soft fox ears and a cream pompom. It covers the hair and fits both body shapes.'),
  w('spotted-mushroom-hat', ['hat'], 'A painterly wide mushroom-cap hat, red with white spots and pale ridged gills under the brim. It sits over the hair, which shows below.'),
  w('sea-chart-paper-hat', ['hat'], 'A cel-shaded folded paper boat hat made from an old sea chart, with crisp creases and a tiny paper flag on top. It hides the hair.'),
  w('teacup-top-hat', ['hat'], 'A realistic small top hat in plum velvet, tilted to one side, with a china teacup and saucer perched on the crown. It leaves the hair showing.'),
  w('moon-star-pointed-hat', ['hat'], 'A pixel art pointed hat in deep blue with blocky yellow moons and stars and a floppy tip. It hides the hair and fits both body shapes.'),
  w('raincloud-felt-hat', ['hat'], 'A stylized fluffy cloud hat in soft white felt with tiny glass raindrops hanging from the edge on threads. It hides the hair.'),
  w('honeybee-sun-hat', ['hat'], 'A realistic wide-brim sun hat in natural straw with a honeycomb-pattern ribbon and two little felt bees on the band. Long hair shows at the back.'),
  w('snail-shell-beret', ['hat'], 'A cartoon beret in moss green wool with a spiral snail shell sitting on top and two small antennae. It sits on the hair and fits both body shapes.'),
  w('lighthouse-hat', ['hat'], 'A low-poly tall hat shaped like a red and white striped lighthouse, with a glowing yellow lamp room at the top. It hides the hair.'),
  w('paper-crane-cap', ['hat'], 'A cel-shaded baseball cap in matte black with a white folded paper crane across the front panel and a pale gold brim edge. It hides the hair on top.'),
  w('potted-cactus-hat', ['hat'], 'A cartoon bucket hat in sandy beige twill with a little potted cactus growing from the crown and a pink flower on top. It covers the hair.'),
  w('jellyfish-bell-hat', ['hat'], 'A realistic jellyfish bell hat in glowing violet glass with soft trailing ribbons down the back. It hides the hair and fits both body shapes.'),
  w('corduroy-trapper-hat', ['hat'], 'A realistic trapper hat in mustard corduroy with cream fleece lining and ear flaps tied up with leather cords. It covers the hair.'),
  w('strawberry-cake-hat', ['hat'], 'A painterly hat shaped like a three-layer strawberry cake with cream frosting, sprinkles and one lit candle on top. It sits over the hair.'),
  w('tweed-newsboy-cap', ['hat'], 'A realistic newsboy cap in grey herringbone tweed with a tiny brass button and a long speckled feather in the band. The hair shows at the sides.'),
  w('moon-phase-cloche', ['hat'], 'A minimal cloche hat in midnight blue felt with the phases of the moon stitched around the band in silver thread. It hides most of the hair.'),
]

const HELMETS = [
  w('coral-diving-helmet', ['helmet'], 'A realistic old diving helmet in brass and copper with round glass portholes, rivets and a little pink coral growing on one side. It hides the hair and head.'),
  w('goldfish-space-helmet', ['helmet'], 'A cartoon round fishbowl space helmet in clear glass with a white rim, a small antenna and two tiny goldfish swimming inside. It hides the hair.'),
  w('beetle-shell-helmet', ['helmet'], 'A low-poly helmet shaped like a glossy green beetle shell with folded wing cases and two short rounded horns. It covers the hair on both body shapes.'),
  w('striped-racer-helmet', ['helmet'], 'A cel-shaded retro open-face racing helmet in cream with two red stripes, a leather chin strap and round goggles resting on top. It hides the hair.'),
  w('lantern-pumpkin-helmet', ['helmet'], 'A painterly hollow pumpkin helmet with a friendly carved smile and a warm candle glow inside. It covers the whole head and the hair.'),
  w('amethyst-geode-helmet', ['helmet'], 'A stylized helmet like a split geode, rough grey stone outside and glowing amethyst crystals around the face opening. It hides the hair.'),
  w('anglerfish-helmet', ['helmet'], 'A cartoon anglerfish helmet in dark teal with a wide toothless grin around the face opening and a glowing lure dangling in front. It covers the hair.'),
  w('snow-globe-helmet', ['helmet'], 'A realistic snow globe helmet: a clear glass dome with drifting snow inside, on a carved wooden base around the neck. It hides the hair.'),
]

const HAIR = [
  w('pastel-cloud-hair', ['hair'], 'Cartoon hair in big soft cloud puffs, pastel lilac fading to white at the tips, with a few tiny gold stars caught in it. Fits both body shapes.'),
  w('flower-crown-braids', ['hair'], 'Realistic copper-red hair in two thick braids wrapped around the head like a crown, with small white flowers tucked in. Fits both body shapes.'),
  w('ocean-wave-hair', ['hair'], 'Painterly hair shaped like a curling ocean wave in deep teal and foam white, with a tiny paper sailboat riding the crest. Fits both body shapes.'),
  w('neon-stripe-mohawk', ['hair'], 'A pixel art mohawk in blocky neon green and black stripes, standing tall, with the sides shaved short. Fits both body shapes.'),
  w('ink-wash-long-hair', ['hair'], 'Long straight hair in ink black that fades to indigo at the ends, in a painterly brushstroke look with loose strands. It reaches mid-back on both body shapes.'),
  w('bubblegum-space-buns', ['hair'], 'Cel-shaded bubblegum-pink hair in two high round buns, with short loose strands at the front and little star clips. Fits both body shapes.'),
  w('sunset-gradient-afro', ['hair'], 'A realistic rounded afro in a sunset gradient, warm orange at the roots to deep magenta at the tips, with one gold hair cuff. Fits both body shapes.'),
  w('ivy-vine-hair', ['hair'], 'Stylized hair made of trailing ivy leaves and thin vines in fresh green, with a few small red berries. It falls to the shoulders on both body shapes.'),
  w('chrome-blunt-bob', ['hair'], 'A sleek low-poly silver bob with a blunt fringe and a faint chrome sheen, cut at the jaw. Fits both body shapes.'),
  w('candle-flame-hair', ['hair'], 'Cartoon hair like a soft candle flame, yellow at the roots to orange tips, with a gentle glow. Short and standing up, for both body shapes.'),
  w('chestnut-curl-mop', ['hair'], 'Realistic loose chestnut curls in a shaggy mop that covers the ears, with a few sun-lightened strands. Fits both body shapes.'),
  w('mint-ribbon-ponytail', ['hair'], 'A cel-shaded high ponytail in mint green hair, tied with a long striped ribbon that hangs down the back. Fits both body shapes.'),
]

const MASKS = [
  w('amber-paper-fox-mask', ['mask'], 'A low-poly fox half mask folded from amber paper, with sharp creases and white tips on the ears, covering the eyes and nose. Fits both body shapes.'),
  w('moth-wing-masquerade', ['mask'], 'A realistic masquerade mask shaped like moth wings in dusty lilac velvet, with amber eye spots and fine gold edging. It covers the eyes.'),
  w('cyan-robot-faceplate', ['mask'], 'A low-poly robot faceplate in brushed steel with two round cyan eye lights and a speaker grille for a mouth. It covers the whole face.'),
  w('owl-feather-mask', ['mask'], 'A cartoon owl mask over the eyes in soft brown and cream feathers, with big round amber glass eyes and a small hooked beak.'),
  w('coral-reef-mask', ['mask'], 'A stylized mask grown from pink and orange coral with tiny spiral shells, covering the face from the forehead to the nose.'),
  w('pixel-smile-screen-mask', ['mask'], 'A pixel art face mask: a black screen showing a blocky yellow smile that blinks now and then, in a thin white frame. It covers the whole face.'),
  w('porcelain-cat-mask', ['mask'], 'A realistic porcelain half mask of a cat, glazed white with painted blue whiskers and gold-leaf ears. It covers the eyes and nose.'),
  w('autumn-leaf-mask', ['mask'], 'A painterly mask woven from autumn leaves in red, gold and brown, with small acorn caps at the temples. It covers the upper face.'),
  w('star-print-bandana', ['mask'], 'A cel-shaded bandana over the nose and mouth in navy cotton, with a small white star print and frayed edges. Fits both body shapes.'),
  w('jade-dragon-half-mask', ['mask'], 'A cartoon half mask of a friendly dragon in jade green scales, with small rounded horns and gold-rimmed eyeholes.'),
  w('brass-gear-mask', ['mask'], 'A steampunk mask over the upper face made of polished brass gears, with a tiny ticking clock face over one eye and a leather strap.'),
]

const EYEWEAR = [
  w('copper-diving-goggles', ['eyewear'], 'Realistic copper-plated diving goggles with brass rivets and green-tinted lenses, worn on the eyes over the hair.'),
  w('cherry-heart-sunglasses', ['eyewear'], 'Cartoon heart-shaped sunglasses in cherry red acetate, with pink gradient lenses and tiny rhinestones at the corners.'),
  w('blocky-pixel-shades', ['eyewear'], 'Pixel art shades in black blocky frames with a white highlight stripe across each lens, worn low on the nose.'),
  w('gear-rim-monocle', ['eyewear'], 'A realistic brass monocle on a fine chain, with a tiny gear set into the rim and a slightly blue lens.'),
  w('amber-aviator-goggles', ['eyewear'], 'Low-poly aviator goggles in worn brown leather with round amber lenses and a thick strap around the head, over the hair.'),
  w('telescope-lens-glasses', ['eyewear'], 'Painterly round glasses with short telescope lenses that stick out a little, in navy enamel with gold star rivets.'),
  w('daisy-petal-sunglasses', ['eyewear'], 'Cartoon sunglasses with white daisy petals around each round yellow lens, on a thin green frame.'),
  w('neon-line-visor', ['eyewear'], 'A sleek futuristic visor, one curved band of smoky glass with a neon pink light line along the top edge, wrapping round to the ears.'),
  w('tortoiseshell-cat-eye', ['eyewear'], 'Realistic cat-eye glasses in tortoiseshell acetate with clear lenses and small gold dots at the upswept corners.'),
  w('kaleidoscope-glasses', ['eyewear'], 'Stylized round glasses with kaleidoscope lenses in shifting stained-glass colours and thin silver wire frames.'),
  w('mirrored-ski-goggles', ['eyewear'], 'Cel-shaded ski goggles with a mirrored orange-to-purple lens, a white frame and a striped elastic strap over the hair.'),
]

const EARRINGS = [
  w('ringed-planet-earrings', ['earring'], 'Low-poly earrings: a small ringed planet hanging from each ear, in pearly blue with a gold ring. Fits both body shapes.'),
  w('enamel-koi-earrings', ['earring'], 'Realistic drop earrings shaped like little orange and white enamel koi fish on fine gold chains.'),
  w('lemon-slice-earrings', ['earring'], 'Cartoon earrings shaped like lemon slices in glossy yellow resin, with tiny green leaves at the hooks.'),
  w('teal-feather-earrings', ['earring'], 'Painterly long earrings, a single teal and bronze feather on each ear with a small silver cap. They hang to the shoulder.'),
  w('raindrop-hoops', ['earring'], 'Minimal silver hoop earrings with a single blue glass raindrop hanging from each, in a realistic style.'),
  w('pixel-cherry-earrings', ['earring'], 'Pixel art earrings of two blocky red cherries on a green stem, hanging from each ear. Fits both body shapes.'),
  w('paper-lantern-earrings', ['earring'], 'Cel-shaded earrings shaped like tiny paper lanterns in coral red, with a soft glow and short gold tassels.'),
]

const TIARAS = [
  w('ice-crystal-tiara', ['tiara'], 'A realistic tiara of clear ice crystals with a faint blue glow on a frosted silver band. It sits on top of the hair.'),
  w('wildflower-crown', ['tiara'], 'A painterly crown of wildflowers, poppies, cornflowers and daisies woven on a thin twig band, resting on the hair.'),
  w('seashell-pearl-tiara', ['tiara'], 'A cartoon tiara of pink and cream seashells and small pearls on a gold wire band, sitting on top of the hair.'),
  w('circuit-line-tiara', ['tiara'], 'A futuristic low-poly tiara of thin circuit lines in matte black, with tiny green lights running along them.'),
  w('copper-leaf-tiara', ['tiara'], 'A stylized tiara of copper leaves and small amber beads that curls up at the centre, sitting on the hair.'),
  w('boiled-sweet-tiara', ['tiara'], 'A cartoon tiara made of boiled sweets and swirled lollipops in bright pastels, on a sugar-white band.'),
  w('dewdrop-web-tiara', ['tiara'], 'A minimal tiara of fine silver wire spun like a web, with tiny glass dewdrops that catch the light.'),
]

const TOP_HEAD = [
  w('tiny-raincloud', ['top_head'], 'A cartoon tiny raincloud floating above the head in soft grey, with a gentle loop of falling blue drops.'),
  w('two-leaf-sprout', ['top_head'], 'A low-poly little green sprout with two round leaves growing straight up from the top of the head.'),
  w('three-orbiting-moons', ['top_head'], 'Three small glowing moons in pearl, peach and blue orbiting slowly above the head, in a stylized look.'),
  w('star-bobble-antennae', ['top_head'], 'Two cartoon springy antennae in metallic pink with glowing star bobbles on the tips, on top of the head.'),
  w('pixel-heart-thought', ['top_head'], 'A cel-shaded thought bubble floating over the head with a little pixel heart inside, white with a black outline.'),
  w('spiral-curled-horns', ['top_head'], 'Stylized curled horns in polished cream with carved spiral grooves, one on each side of the head.'),
  w('little-hovering-sun', ['top_head'], 'A painterly small sun hovering over the head, warm gold with soft rays that slowly turn.'),
  w('velvet-cat-ears', ['top_head'], 'Realistic cat ears in charcoal velvet with pale pink insides and a small gold ring in one ear, on top of the head.'),
]

const FACIAL_HAIR = [
  w('waxed-ginger-moustache', ['facial_hair'], 'A realistic curled moustache in ginger with waxed upturned tips. Fits both body shapes.'),
  w('blooming-beard', ['facial_hair'], 'A painterly full beard in soft brown with small blue and yellow flowers growing in it.'),
  w('pixel-streak-goatee', ['facial_hair'], 'A pixel art pointed goatee in blocky black squares with a single grey streak down the middle.'),
  w('frost-icicle-beard', ['facial_hair'], 'A stylized short beard of white frost and tiny icicles that sparkle at the chin.'),
  w('copper-bead-braid-beard', ['facial_hair'], 'A realistic long braided beard in dark blond with two copper beads near the end.'),
  w('cumulus-cloud-beard', ['facial_hair'], 'A cartoon fluffy beard like a summer cloud, bright white and puffed out wide.'),
  w('electric-blue-stubble', ['facial_hair'], 'A cel-shaded short stubble in electric blue with a faint glow along the jaw.'),
]

const UPPER_BODY = [
  w('moth-wing-cape', ['upper_body'], 'A cartoon moth-wing cape in dusty lilac velvet with glowing amber eye spots, on the upper body over a simple cream top. Fits both body shapes.'),
  w('cloud-quilt-puffer', ['upper_body'], 'A low-poly puffer jacket in soft sky blue with cloud-shaped quilting and a silver zip, cropped at the waist. Fits both body shapes.'),
  w('fern-print-camp-shirt', ['upper_body'], 'A realistic short-sleeved camp shirt in loose sage green linen with a print of ferns and broad tropical leaves.'),
  w('pine-mountain-sweater', ['upper_body'], 'A painterly cosy sweater in oatmeal wool with a band of blue mountains and pine trees knitted across the chest.'),
  w('comet-patch-denim-jacket', ['upper_body'], 'A realistic washed denim jacket with embroidered patches of a cactus, a comet and a coffee cup on the back. Fits both body shapes.'),
  w('pixel-heart-chest-plate', ['upper_body'], 'A pixel art chest plate in blocky silver and teal with a small pixel heart in the centre, over a dark long-sleeved top.'),
  w('duck-print-raincoat', ['upper_body'], 'A cartoon hooded raincoat in glossy yellow with a print of tiny white ducks and big wooden toggle buttons. The hood stays down.'),
  w('citrus-tie-dye-hoodie', ['upper_body'], 'A loose cel-shaded tie-dye hoodie in swirls of tangerine, pink and lemon, with a front pocket and white drawstrings.'),
  w('constellation-blazer', ['upper_body'], 'A realistic tailored blazer in midnight navy wool with a map of stars embroidered in silver thread across the back.'),
  w('fuzzy-bee-sweater', ['upper_body'], 'A cartoon chunky sweater in yellow and black stripes with small sheer wings on the back and a fuzzy collar.'),
  w('liquid-chrome-bomber', ['upper_body'], 'A futuristic bomber jacket in liquid chrome with ribbed black cuffs and a glowing blue strip down each sleeve.'),
  w('faded-quilt-vest', ['upper_body'], 'A painterly patchwork vest of faded quilt squares in rose, mustard and teal, with wooden buttons, over a white shirt.'),
  w('potion-stained-lab-coat', ['upper_body'], 'A cel-shaded white lab coat with colourful potion stains on the sleeves and a row of tiny test tubes in the chest pocket.'),
  w('mushroom-button-cardigan', ['upper_body'], 'A low-poly long cardigan in forest green knit with little red mushroom buttons and deep patch pockets.'),
  w('anchor-stripe-top', ['upper_body'], 'A realistic striped top in navy and white cotton with a wide boat neck and a small red anchor stitched on one sleeve.'),
  w('rustling-leaf-cloak', ['upper_body'], 'A stylized hooded cloak of overlapping green and gold leaves that flutter at the hem, worn over the upper body with the hood down.'),
  w('neon-horizon-tee', ['upper_body'], 'A pixel art t-shirt in black with a neon pink and cyan grid horizon and a setting sun across the chest.'),
  w('emerald-dinner-jacket', ['upper_body'], 'A realistic dinner jacket in emerald velvet with black satin lapels and a small embroidered peacock feather on the pocket.'),
  w('rainbow-cloud-hoodie', ['upper_body'], 'A cartoon oversized hoodie in white fleece with soft rounded cloud edges and a small rainbow on the pocket. Fits both body shapes.'),
]

const LOWER_BODY = [
  w('succulent-cargo-pants', ['lower_body'], 'Realistic cargo trousers in olive ripstop with many pockets, one holding a tiny potted succulent, and rolled hems.'),
  w('starry-tulle-tutu', ['lower_body'], 'A cartoon layered tutu skirt in tulle that fades from deep purple to blue, with tiny embroidered stars.'),
  w('chain-plaid-skirt', ['lower_body'], 'A cel-shaded pleated skirt in red and black plaid with a silver chain at the hip, ending above the knee.'),
  w('painted-wave-trousers', ['lower_body'], 'Painterly wide-leg trousers in cream linen with a hand-painted blue wave along each hem.'),
  w('patchwork-baggy-jeans', ['lower_body'], 'Realistic baggy jeans with patchwork squares of denim in different washes and frayed edges at the knees.'),
  w('pixel-palm-board-shorts', ['lower_body'], 'Pixel art board shorts in blocky orange and teal with a white pixel palm tree on one leg.'),
  w('birch-bark-trousers', ['lower_body'], 'Stylized trousers that look like birch bark, white with black marks, with a soft moss trim at the waist.'),
  w('fish-scale-sequin-skirt', ['lower_body'], 'A realistic long sequin skirt like fish scales, shifting from teal to violet, reaching the ankles.'),
  w('glow-seam-joggers', ['lower_body'], 'Futuristic joggers in matte black with glowing cyan seams and zip pockets on the thighs.'),
  w('flower-patch-flares', ['lower_body'], 'Cel-shaded flared trousers in mustard corduroy with brown stitched flower patches at the knees.'),
  w('candy-spiral-leggings', ['lower_body'], 'Cartoon leggings in red and white spiral stripes with small mint sweets printed at the ankles.'),
  w('puffy-cloud-trousers', ['lower_body'], 'Low-poly puffy trousers in pale blue with white cloud shapes, gathered at the ankles.'),
  w('seed-packet-shorts', ['lower_body'], 'Realistic linen shorts in terracotta with seed packets in the pockets and a small trowel hooked on a belt loop.'),
  w('lemon-leaf-wrap-skirt', ['lower_body'], 'A painterly wrap skirt in coral and gold with a hand-drawn pattern of lemons and leaves, tied at the side.'),
]

const FEET = [
  w('cloud-sole-sneakers', ['feet'], 'Cartoon chunky sneakers in white with soles shaped like puffy clouds and sky-blue laces. Fits both body shapes.'),
  w('frog-face-rain-boots', ['feet'], 'Low-poly green rain boots with a friendly frog face on each toe and yellow soles.'),
  w('mossy-ankle-boots', ['feet'], 'Painterly ankle boots in brown leather with soft green moss growing over the toes and tiny white mushrooms at the heel.'),
  w('rocket-fin-high-tops', ['feet'], 'Futuristic high-top sneakers in silver and orange with small rocket fins on the heels and glowing soles.'),
  w('lightning-pixel-sneakers', ['feet'], 'Pixel art sneakers in blocky red and white with a yellow zigzag stripe along the sides.'),
  w('koi-fish-slippers', ['feet'], 'Cartoon slippers shaped like orange and white koi fish, with the tails curving up at the heel.'),
  w('compass-hiking-boots', ['feet'], 'Realistic lace-up hiking boots in tan suede with red laces, worn soles and a brass compass charm on one lace.'),
  w('floating-flower-heels', ['feet'], 'Realistic block heels in clear crystal with tiny gold flowers floating inside each heel.'),
  w('candy-layer-platforms', ['feet'], 'Cel-shaded platform sandals with soles of stacked pastel candy layers and thin pink straps.'),
  w('duck-feet-boots', ['feet'], 'Cartoon boots shaped like big orange duck feet, with webbed toes that flap a little. Fits both body shapes.'),
  w('rope-bead-sandals', ['feet'], 'Realistic woven sandals in natural rope and cream canvas with a small blue bead on each strap.'),
  w('snowflake-snow-boots', ['feet'], 'Low-poly snow boots in burgundy with chunky cream fleece cuffs and white snowflake stitching.'),
  w('mint-roller-skates', ['feet'], 'Retro roller skates in mint green leather with pink wheels and white laces, in a cel-shaded style.'),
  w('red-scale-claw-boots', ['feet'], 'Stylized boots in red scales with three rounded toes and a ridge of small soft spines up the back.'),
  w('ribbon-ballet-flats', ['feet'], 'Painterly ballet flats in dusty rose satin with long ribbons crossing up the ankle.'),
]

const HANDS_WEAR = [
  w('strawberry-oven-mitts', ['hands_wear'], 'Cartoon oven mitts shaped like strawberries, in red quilted cotton with white seeds and green leaf cuffs.'),
  w('crystal-shard-gauntlets', ['hands_wear'], 'Stylized gauntlets in dark leather set with glowing blue crystal shards across the knuckles.'),
  w('rose-lace-gloves', ['hands_wear'], 'Realistic short lace gloves in black with a small embroidered rose at each wrist.'),
  w('pixel-button-gloves', ['hands_wear'], 'Pixel art fingerless gloves in blocky purple with green pixel buttons on the back of each hand.'),
  w('beaded-bracelet-stack', ['hands_wear'], 'Low-poly stacks of beaded bracelets on both wrists in turquoise, coral and gold, with one small shell charm.'),
  w('fluffy-paw-gloves', ['hands_wear'], 'Cartoon fluffy paw gloves in cream with pink pads on the palms and little rounded claws.'),
  w('canvas-garden-gloves', ['hands_wear'], 'Realistic canvas gardening gloves in olive with leather palms, a few soil smudges and a seed packet tucked in one cuff.'),
  w('starfield-satin-gloves', ['hands_wear'], 'Cel-shaded long satin gloves that fade from black at the fingers to deep blue at the elbow, scattered with tiny stars.'),
]

const SKINS = [
  w('moss-stone-creature-skin', ['skin'], 'A stylized full-body skin of a moss-covered stone creature with glowing green cracks and small ferns on the shoulders. Fits both body shapes.'),
  w('blue-glass-skin', ['skin'], 'A realistic full-body skin of clear blue glass with gentle refraction and tiny bubbles caught inside.'),
  w('pixel-screen-robot-skin', ['skin'], 'A pixel art robot skin in blocky white and orange panels, with a small screen face showing two dot eyes.'),
  w('glowing-jellyfish-skin', ['skin'], 'A cartoon skin of a glowing jellyfish person, translucent violet with soft light pulsing along the arms.'),
  w('painted-porcelain-skin', ['skin'], 'A painterly skin of glazed white porcelain with blue hand-painted flowers and vines across the arms and chest.'),
  w('folded-paper-skin', ['skin'], 'A cel-shaded skin of folded paper with visible creases, pale cream with doodled pencil lines and a little torn edge at one shoulder.'),
  w('lava-seam-skin', ['skin'], 'A low-poly skin of dark lava rock with glowing orange seams that pulse slowly. Fits both body shapes.'),
  w('drifting-sky-skin', ['skin'], 'A stylized skin made of sky: soft blue with white clouds drifting slowly across the body.'),
]

// ── Wearables: outfits of two to four pieces ────────────────────────────────

const OUTFITS = [
  w('palm-hat-and-sneakers', ['hat', 'feet'], 'A low-poly bucket hat and matching sneakers in sky-blue canvas, each with a small embroidered palm tree. The hat hides the hair; both fit both body shapes.'),
  w('honeycomb-beekeeper-set', ['hat', 'upper_body', 'hands_wear'], 'A cartoon beekeeper set: a round hat with a mesh veil, a white jacket with honeycomb patches and yellow gloves. The hat hides the hair.'),
  w('retro-space-suit', ['helmet', 'upper_body', 'lower_body', 'feet'], 'A realistic retro space suit: a round helmet, a white padded jacket and trousers with orange patches, and chunky moon boots.'),
  w('pinecone-forest-walker', ['hat', 'upper_body', 'lower_body'], 'A painterly forest walker outfit: a wide felt hat with a pinecone pin, a moss-green wool jacket and brown corduroy trousers.'),
  w('polka-dot-rain-set', ['upper_body', 'feet'], 'A cartoon raincoat in glossy red with big white buttons, and matching red rain boots with white polka dots.'),
  w('pixel-plume-knight', ['helmet', 'upper_body', 'lower_body', 'feet'], 'A pixel art knight outfit in blocky silver and blue: a helmet with a plume, a chest plate, leg guards and boots.'),
  w('lemon-tea-party', ['hat', 'upper_body', 'lower_body'], 'A painterly garden tea party look: a straw boater with a ribbon, a lemon-print blouse and a pale green pleated skirt.'),
  w('neon-night-runner', ['eyewear', 'upper_body', 'lower_body', 'feet'], 'A futuristic runner outfit: a wraparound visor, a black crop jacket with neon pink seams, matching joggers and glowing sneakers.'),
  w('snowy-cabin-set', ['hat', 'upper_body', 'feet'], 'A realistic cosy cabin set: a red knit beanie, a chunky cream cable sweater and sheepskin boots. The beanie covers the hair.'),
  w('brass-deep-sea-diver', ['helmet', 'upper_body', 'feet'], 'A realistic brass deep-sea diver set: a round helmet with portholes, a canvas suit top with leather straps and weighted boots.'),
  w('mushroom-forager', ['hat', 'upper_body', 'lower_body'], 'A cartoon mushroom forager outfit: a red spotted mushroom hat, a brown vest with a woven basket strap and green shorts.'),
  w('sheepskin-sky-pilot', ['eyewear', 'upper_body', 'hands_wear'], 'A cel-shaded sky pilot set: brown leather goggles, a sheepskin-collared flight jacket and long leather gloves.'),
  w('frost-crystal-gown', ['tiara', 'upper_body', 'lower_body'], 'A stylized frost outfit: an ice crystal tiara, a pale blue fitted top with frosted shoulders and a long skirt that fades to white.'),
  w('dune-explorer', ['hat', 'eyewear', 'upper_body', 'lower_body'], 'A realistic desert explorer set: a khaki sun hat with a neck flap, round dark glasses, a linen shirt with many pockets and sand trousers.'),
  w('bubble-tea-set', ['hat', 'upper_body'], 'A cartoon bubble tea set: a cap shaped like a cup lid with a striped straw, and a milky brown hoodie with black pearl dots.'),
  w('koi-pond-suit', ['upper_body', 'lower_body'], 'A painterly koi pond outfit: a flowing teal jacket with orange koi swimming across it and matching wide trousers.'),
  w('pixel-snowflake-winter', ['hat', 'upper_body'], 'A pixel art winter set: a blocky white beanie with a red pompom and a matching sweater with pixel snowflakes.'),
  w('flour-dusted-baker', ['hat', 'upper_body'], 'A cel-shaded baker set: a tall white hat dusted with flour, and a cream apron over a striped shirt with a wooden spoon in the pocket.'),
  w('midnight-stargazer', ['hat', 'upper_body', 'lower_body', 'feet'], 'A realistic stargazer outfit in midnight blue: a pointed hat, a long coat embroidered with stars, plain trousers and soft boots.'),
  w('sunflower-dungarees', ['upper_body', 'lower_body', 'feet'], 'Realistic garden dungarees in faded denim with a sunflower patch, worn over a white tee, with green wellies.'),
  w('spiky-punk-look', ['hair', 'upper_body', 'lower_body'], 'A cartoon punk look: a spiky blue mohawk, a black leather jacket with silver studs and ripped plaid trousers.'),
  w('surf-day-set', ['eyewear', 'upper_body', 'lower_body', 'feet'], 'A low-poly surf day set: round mirrored sunglasses, a turquoise rash top, board shorts with a wave print and flip-flops.'),
  w('night-moth-set', ['mask', 'upper_body', 'feet'], 'A cartoon night moth set: a moth-wing masquerade mask, a lilac velvet wing cape with amber eye spots and matching soft boots.'),
  w('friendly-robot-suit', ['helmet', 'upper_body', 'hands_wear', 'feet'], 'A low-poly friendly robot suit in white and orange: a square helmet with a screen face, a chest panel with dials, big gloves and boxy boots.'),
  w('rust-autumn-walk', ['hat', 'upper_body', 'lower_body', 'feet'], 'A painterly autumn walk outfit: a rust beret, a mustard knit cardigan, a brown corduroy skirt and lace-up boots.'),
  w('oilskin-lighthouse-keeper', ['hat', 'upper_body', 'lower_body'], 'A realistic lighthouse keeper set: a navy wool cap, a yellow oilskin coat and thick grey wool trousers.'),
  w('lollipop-candy-shop', ['hat', 'upper_body', 'lower_body'], 'A cartoon candy shop outfit: a striped paper hat, a pastel pink jacket with lollipop buttons and a mint skirt with sprinkles.'),
  w('rainy-city-trench', ['hat', 'upper_body', 'feet'], 'A realistic rainy city set: a black wide-brim rain hat, a long olive trench coat and shiny black ankle boots.'),
  w('dragon-onesie', ['helmet', 'upper_body', 'lower_body'], 'A cartoon dragon onesie set: a hood helmet with soft horns, a green scaly top with little wings and matching trousers with a tail.'),
  w('pearl-ballet-outfit', ['tiara', 'upper_body', 'lower_body', 'feet'], 'A painterly ballet outfit: a small pearl tiara, a dusty rose leotard top, a layered tulle skirt and satin ballet flats.'),
  w('orange-parka-arctic', ['hat', 'upper_body', 'hands_wear', 'feet'], 'A low-poly arctic set: a fleece-trimmed hat, a puffy orange parka, chunky mittens and snow boots. The hat hides the hair.'),
  w('gold-button-circus-host', ['hat', 'upper_body', 'lower_body'], 'A cel-shaded circus host outfit: a red top hat, a red tailcoat with gold buttons and white trousers with a gold stripe.'),
  w('fuzzy-bee-set', ['top_head', 'upper_body', 'lower_body'], 'A cartoon bee set: springy antennae with fuzzy bobbles, a striped yellow and black fuzzy top with small wings, and black shorts.'),
  w('pixel-glitch-outfit', ['mask', 'upper_body', 'lower_body'], 'A pixel art glitch outfit: a black screen mask with a blocky smile, a hoodie that breaks into colour blocks at the hem, and matching joggers.'),
  w('cherry-picnic-look', ['hat', 'upper_body', 'lower_body'], 'A realistic picnic outfit: a wide straw hat with cherries on the band, a red gingham blouse and cream shorts.'),
  w('clockwork-inventor', ['eyewear', 'upper_body', 'hands_wear'], 'A steampunk inventor set: brass goggles with extra flip-down lenses, a leather waistcoat with tools on the straps and fingerless gloves.'),
  w('white-beard-sea-captain', ['hat', 'upper_body', 'facial_hair'], 'A painterly sea captain set: a navy cap with a gold rope, a double-breasted wool coat and a full white beard.'),
  w('moonlit-water-outfit', ['hair', 'upper_body', 'lower_body'], 'A stylized moonlight outfit: long silver hair, a fitted top that shimmers like moonlit water and a flowing indigo skirt.'),
  w('sprout-gardener-set', ['hat', 'upper_body', 'hands_wear'], 'A cartoon gardener set: a floppy sun hat with a sprout on top, a green apron with seed packets in the pockets and canvas gloves.'),
  w('glowing-jellyfish-set', ['hat', 'upper_body'], 'A realistic jellyfish set: a glowing violet bell hat with trailing ribbons and a sheer top that glows faintly down the arms.'),
  w('coal-button-snowman', ['hat', 'upper_body', 'lower_body'], 'A low-poly snowman outfit: a black top hat with a red berry sprig, a round white puffy top with coal buttons and an orange scarf, and white trousers.'),
  w('checkered-retro-racer', ['helmet', 'upper_body', 'hands_wear'], 'A cel-shaded retro racer set: an open-face cream helmet with red stripes, a white racing jacket with checked panels and leather gloves.'),
  w('firefly-night-set', ['top_head', 'upper_body'], 'A painterly firefly set: tiny glowing fireflies circling above the head and a dark green jacket with soft lights along the hem.'),
  w('clay-pottery-studio', ['upper_body', 'lower_body', 'hands_wear'], 'A realistic pottery studio set: a clay-smudged linen smock, wide brown trousers and stained work gloves.'),
  w('library-keeper-set', ['eyewear', 'upper_body', 'lower_body'], 'A painterly library keeper set: round brass reading glasses, a burgundy knit vest with a book-shaped pin and tweed trousers.'),
  w('mint-court-set', ['hat', 'upper_body', 'lower_body'], 'A cel-shaded court set: a white visor cap, a mint polo top with a small racket stitched on, and white pleated shorts.'),
  w('pond-frog-set', ['hat', 'upper_body', 'feet'], 'A cartoon frog set: a green hat with two big round eyes on top, a green hoodie with a pale belly and webbed frog slippers.'),
  w('ink-brush-artist', ['hair', 'upper_body', 'hands_wear'], 'A painterly ink artist set: a messy black bun with two brushes stuck in it, a paint-splattered smock and ink-stained fingerless gloves.'),
  w('lantern-night-market', ['hat', 'upper_body', 'earring'], 'A cel-shaded night market look: a black cap with a tiny lantern pin, a bomber jacket printed with glowing lanterns and paper lantern earrings.'),
  w('coral-snorkel-set', ['eyewear', 'upper_body', 'feet'], 'A cartoon snorkel set: a round mask and snorkel over the eyes, a striped swim top in coral and teal, and yellow flippers.'),
]

// ── Emotes ──────────────────────────────────────────────────────────────────

const DANCES = [
  e('two-step-spin-point', 'dance', 'loop', 'A cheerful two-step dance that ends in a little spin and a finger point, bouncy and fairly fast. It loops.'),
  e('ticking-robot-dance', 'dance', 'loop', 'A stiff robot dance with sharp arm angles and little head ticks in time to a beat, playful and steady. It loops.'),
  e('noodle-arms-wobble', 'dance', 'loop', 'A goofy wobbly dance with floppy noodle arms and loose knees, silly and medium speed. It loops.'),
  e('solo-moonlit-waltz', 'dance', 'loop', 'A slow, graceful solo waltz in a small box step, one arm out as if holding a partner. Calm and dreamy. It loops.'),
  e('victory-shuffle', 'dance', 'once', 'A quick happy shuffle of the feet that ends with both fists up in a proud pose, energetic and bright. It plays once.'),
  e('disco-point-sway', 'dance', 'loop', 'A retro disco move pointing up and down across the body with a hip sway, confident and groovy. It loops.'),
  e('tap-and-tip', 'dance', 'once', 'A short tap routine with quick heel and toe taps and a hat-tip at the end, with crisp tapping sounds. It plays once.'),
  e('jelly-bounce', 'dance', 'loop', 'A soft jelly bounce, the whole body wobbling up and down with hands waving at the sides, cute and slow. It loops.'),
  e('hopscotch-hops', 'dance', 'once', 'A playful hopscotch dance: hops on one foot and two feet along an invisible line, then a little turn. It plays once.'),
  e('snapping-shoulder-shimmy', 'dance', 'loop', 'A sassy shoulder shimmy with a slow head roll and snapping fingers, cool and relaxed. It loops.'),
  e('footwork-freeze', 'dance', 'once', 'A short floor dance: a few quick footwork steps low to the ground, a spin, and a freeze on one hand. Energetic and fast. It plays once.'),
  e('sleepy-yawn-sway', 'dance', 'loop', 'A lazy, sleepy sway from side to side with a big yawn every few beats, slow and gentle. It loops.'),
  e('high-kick-line', 'dance', 'loop', 'A bright kick-line dance with high alternating kicks and hands on hips, fast and showy. It loops.'),
  e('lagging-glitch-dance', 'dance', 'loop', 'A glitchy dance that freezes and skips like a lagging video, jerky and funny, with tiny static sounds. It loops.'),
  e('tiptoe-spin-bow', 'dance', 'once', 'An elegant spin on the toes that slows into a deep bow, smooth and graceful. It plays once.'),
]

const GESTURES = [
  e('big-then-small-wave', 'gesture', 'once', 'A big friendly wave with the whole arm, then a small wave with just the fingers, warm and cheerful. It plays once.'),
  e('applause-sweeping-bow', 'gesture', 'once', 'A dramatic bow with a sweeping arm, like taking applause after a show, slow and proud. It plays once.'),
  e('double-thumbs-wink', 'gesture', 'once', 'A quick double thumbs up with a wink and a nod, confident and friendly. It plays once.'),
  e('rocking-heart-hands', 'gesture', 'loop', 'Making a heart shape with both hands in front of the chest and gently rocking it side to side, sweet and slow. It loops.'),
  e('palms-up-shrug', 'gesture', 'once', 'A big exaggerated shrug with palms up and a tilt of the head, funny and quick. It plays once.'),
  e('curling-finger-beckon', 'gesture', 'loop', 'A beckoning come-here gesture with one curling finger and a sly smile, slow and playful. It loops.'),
  e('two-finger-brow-salute', 'gesture', 'once', 'A relaxed two-finger wave from the brow, followed by a cool nod, smooth and easy. It plays once.'),
  e('pick-you-point', 'gesture', 'once', 'Pointing at the camera, then sweeping the finger around as if picking someone from a crowd, energetic. It plays once.'),
  e('air-high-five', 'gesture', 'once', 'Raising a hand for a high five, waiting a beat, then high-fiving the air anyway, goofy and cheerful. It plays once.'),
  e('chin-stroke-thinking', 'gesture', 'loop', 'Stroking the chin while tapping a foot and looking up, thoughtful and slow. It loops.'),
  e('shh-and-wink', 'gesture', 'once', 'A finger to the lips for shh, a quick look left and right, then a wink, sneaky and quiet. It plays once.'),
  e('one-two-three-reveal', 'gesture', 'once', 'Holding out a fist and counting one, two, three with small bounces, then showing an open hand, playful. It plays once.'),
  e('wristwatch-tap', 'gesture', 'loop', 'Tapping an imaginary wristwatch and sighing, impatient and medium speed. It loops.'),
  e('floating-blown-kiss', 'gesture', 'once', 'Blowing a kiss from the palm and watching it float away, soft and charming, with a tiny sparkle sound. It plays once.'),
  e('concert-arm-wave', 'gesture', 'loop', 'Both arms up, waving side to side like cheering at a concert, excited and steady. It loops.'),
]

const REACTIONS = [
  e('knee-slap-laugh', 'reaction', 'once', 'Laughing so hard the body doubles over, slapping a knee, then wiping away a tear, silly and big. It plays once.'),
  e('startled-jump', 'reaction', 'once', 'A startled jump with hands flying up and eyes wide, then a hand on the chest to calm down, fast. It plays once.'),
  e('slow-facepalm', 'reaction', 'once', 'A slow facepalm, then dragging the hand down the face with a long sigh, tired and dramatic. It plays once.'),
  e('happy-tears-hops', 'reaction', 'loop', 'Happy crying with little hops, hands over the mouth and shoulders shaking, emotional and gentle. It loops.'),
  e('sparkle-mind-blown', 'reaction', 'once', 'Hands at the temples, then flung out wide with a small puff of sparkles, as if mind blown, energetic. It plays once.'),
  e('cartoon-huff', 'reaction', 'once', 'A short cartoon huff: stomping the feet with fists balled, then crossing the arms and turning away, quick and funny. It plays once.'),
  e('collar-tug-nerves', 'reaction', 'loop', 'Nervous fidgeting: tugging the collar, glancing around and shifting from foot to foot, awkward and quick. It loops.'),
  e('standing-doze', 'reaction', 'loop', 'Dozing off standing up, the head nodding forward and then snapping awake, slow and sleepy. It loops.'),
  e('hands-on-hips-pride', 'reaction', 'once', 'Puffing out the chest with hands on hips and chin up, then a satisfied nod, proud and slow. It plays once.'),
  e('chattering-shiver', 'reaction', 'loop', 'Shivering with cold, arms hugging the body, teeth chattering and little stamps of the feet, quick. It loops.'),
  e('full-body-cringe', 'reaction', 'once', 'A full-body cringe, shoulders up to the ears and a wince, then a slow shake of the head, funny. It plays once.'),
  e('spinning-victory-jump', 'reaction', 'once', 'A huge celebration jump with both fists up and a spin in the air, landing with a whoop, very energetic. It plays once.'),
  e('dizzy-circling-wobble', 'reaction', 'loop', 'Dizzy wobbling with circling arms and wobbly knees, as if after spinning too long, silly and slow. It loops.'),
  e('cheek-clasp-swoon', 'reaction', 'once', 'A swoon: hands clasped by the cheek, a happy sigh and a slow lean back, sweet and soft. It plays once.'),
  e('pebble-kick-sulk', 'reaction', 'loop', 'A sad sulk with drooping shoulders, kicking at a pebble on the ground and sighing, slow and gloomy. It loops.'),
]

const PROPS = [
  e('glowing-orb-juggle', 'prop', 'loop', 'Juggling three glowing orbs while bobbing to a beat, with a soft chime on each catch. It loops.'),
  e('paper-lantern-sway', 'prop', 'loop', 'Holding a paper lantern up and swaying gently in its warm glow, calm and slow. It loops.'),
  e('polka-umbrella-twirl', 'prop', 'loop', 'Twirling an open polka-dot umbrella over the shoulder and stepping side to side, cheerful. It loops.'),
  e('confetti-popper', 'prop', 'once', 'Pulling a party popper that bursts into confetti with a pop, then a surprised happy jump, quick and fun. It plays once.'),
  e('easy-guitar-strum', 'prop', 'loop', 'Strumming an acoustic guitar with a relaxed head bob and soft chords, easy and medium speed. It loops.'),
  e('drifting-bubble-wand', 'prop', 'loop', 'Waving a bubble wand slowly so soap bubbles drift around the avatar, dreamy and gentle. It loops.'),
  e('polite-tea-sip', 'prop', 'once', 'Lifting a teacup from its saucer for a slow, polite sip with the little finger raised, then a satisfied sigh. It plays once.'),
  e('diamond-kite-tug', 'prop', 'loop', 'Holding a kite string and tugging as a small diamond kite dips and rises overhead, light and breezy. It loops.'),
  e('humming-watering-can', 'prop', 'loop', 'Watering the ground with a small tin watering can while humming, calm and slow. It loops.'),
  e('sizzling-pancake-flip', 'prop', 'once', 'Flipping a pancake high from a frying pan, catching it and grinning, quick, with a sizzle sound. It plays once.'),
  e('balloon-bunch-lift', 'prop', 'once', 'Holding a bunch of balloons that lifts the avatar onto tiptoes, then letting go and waving them off, playful. It plays once.'),
  e('top-hat-rabbit-trick', 'prop', 'once', 'A magic trick: tapping a top hat with a wand and pulling out a fluffy rabbit, then a bow, quick and showy. It plays once.'),
  e('painted-maracas-shake', 'prop', 'loop', 'Shaking two painted maracas in a bouncy rhythm with a little hip shake, upbeat and fast. It loops.'),
  e('film-camera-snap', 'prop', 'once', 'Raising an old film camera, framing a shot and snapping it with a flash and a click, then a thumbs up. It plays once.'),
  e('sparkler-heart-drawing', 'prop', 'loop', 'Drawing glowing circles and hearts in the air with a sparkler, happy and medium speed, with a soft crackle. It loops.'),
]

/** Every idea, in a fixed order (single pieces by slot, then outfits, then emotes by move). */
export const IDEAS: readonly Idea[] = [
  ...HATS, ...HELMETS, ...HAIR, ...MASKS, ...EYEWEAR, ...EARRINGS, ...TIARAS, ...TOP_HEAD, ...FACIAL_HAIR,
  ...UPPER_BODY, ...LOWER_BODY, ...FEET, ...HANDS_WEAR, ...SKINS, ...OUTFITS,
  ...DANCES, ...GESTURES, ...REACTIONS, ...PROPS,
]
const BY_ID = new Map(IDEAS.map((i) => [i.id, i]))
export const findIdea = (id: string): Idea | undefined => BY_ID.get(id)

// ── Choosing a few ──────────────────────────────────────────────────────────

/** What the chips say: ticked slots, a full outfit, not sure (or nothing); for an emote, the move and playback. */
export type IdeaQuery =
  | { kind: 'wearable'; mode: 'slots' | 'outfit' | 'unsure'; slots: string[] }
  | { kind: 'emote'; move: IdeaMove | null; playback: IdeaPlayback | null }

export const IDEAS_COUNT_MAX = 6
/** The ids a viewer already saw this visit, at most this many (the latest). */
export const EXCLUDE_MAX = 200

const shuffled = <T>(xs: readonly T[], rand: () => number): T[] => {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const isOutfit = (i: Idea) => i.kind === 'wearable' && i.slots.length > 1

/**
 * The matching ideas as tiers, best first; an idea in no tier never shows for this query.
 * - Ticked slots: the pieces that are exactly those slots, then ideas covering every ticked slot, then ideas covering any.
 * - A full outfit: the outfits. Not sure, or nothing ticked: every wearable, mixed across slots (one tier).
 * - Emotes: matching both the move and the playback given, then either; neither given: every emote, mixed across moves.
 */
function tiers(live: Idea[], q: IdeaQuery): Idea[][] {
  if (q.kind === 'emote') {
    const emotes = live.filter((i): i is Extract<Idea, { kind: 'emote' }> => i.kind === 'emote')
    const asked = [q.move && ((i: typeof emotes[number]) => i.move === q.move), q.playback && ((i: typeof emotes[number]) => i.playback === q.playback)]
      .filter((f): f is (i: typeof emotes[number]) => boolean => !!f)
    if (!asked.length) return [emotes]
    return [emotes.filter((i) => asked.every((f) => f(i))), emotes.filter((i) => !asked.every((f) => f(i)) && asked.some((f) => f(i)))]
  }
  const wearables = live.filter((i): i is Extract<Idea, { kind: 'wearable' }> => i.kind === 'wearable')
  if (q.mode === 'outfit') return [wearables.filter(isOutfit)]
  if (q.mode === 'unsure' || !q.slots.length) return [wearables]
  const ticked = new Set(q.slots)
  const all = (i: typeof wearables[number]) => q.slots.every((s) => (i.slots as string[]).includes(s))
  const exact = (i: typeof wearables[number]) => all(i) && i.slots.length === ticked.size
  return [
    wearables.filter(exact),
    wearables.filter((i) => all(i) && !exact(i)),
    wearables.filter((i) => !all(i) && i.slots.some((s) => ticked.has(s))),
  ]
}

/** Not sure, nothing ticked, or no move or playback chosen: one tier, mixed across slots or moves. */
const isMix = (q: IdeaQuery) => (q.kind === 'emote' ? !q.move && !q.playback : q.mode !== 'outfit' && (q.mode === 'unsure' || !q.slots.length))

/** The group an idea counts toward when mixing across slots or moves. */
const groupOf = (i: Idea) => (i.kind === 'emote' ? i.move : i.slots.length > 1 ? 'outfit' : i.slots[0])

/** A shuffled tier with no two of the same group side by side while others remain (so "Not sure" gets a mix). */
function mixed(tier: Idea[], rand: () => number): Idea[] {
  const groups = new Map<string, Idea[]>()
  for (const i of shuffled(tier, rand)) groups.set(groupOf(i), [...(groups.get(groupOf(i)) ?? []), i])
  const order = shuffled([...groups.keys()], rand)
  const out: Idea[] = []
  while (out.length < tier.length) {
    for (const g of order) {
      const next = groups.get(g)!.shift()
      if (next) out.push(next)
    }
  }
  return out
}

/**
 * A few ideas for the query, at random from the ones nobody used: unseen ones first (tier by tier), then, when fewer
 * than `count` unseen ones match, the seen ones again (so a viewer who saw everything starts over rather than getting
 * nothing). `more`: unseen matching ideas remain after these.
 */
export function pickIdeas(
  q: IdeaQuery, opts: { retired: ReadonlySet<string>; exclude: ReadonlySet<string>; count: number; pool?: readonly Idea[]; rand?: () => number },
): { ideas: Idea[]; more: boolean } {
  const rand = opts.rand ?? Math.random
  const live = (opts.pool ?? IDEAS).filter((i) => !opts.retired.has(i.id))
  const arrange = (t: Idea[]) => (isMix(q) ? mixed(t, rand) : shuffled(t, rand))
  const ts = tiers(live, q)
  const unseen = ts.flatMap((t) => arrange(t.filter((i) => !opts.exclude.has(i.id))))
  const seen = ts.flatMap((t) => arrange(t.filter((i) => opts.exclude.has(i.id))))
  return { ideas: [...unseen, ...seen].slice(0, opts.count), more: unseen.length > opts.count }
}

// ── Retiring ────────────────────────────────────────────────────────────────

/** Every idea someone has used: one small read of the table (one row per used idea, at most the pool's size). */
export async function retiredIdeas(exec: Exec = db): Promise<Set<string>> {
  const rows = await exec.select({ ideaId: studioIdeaUses.ideaId }).from(studioIdeaUses)
  return new Set(rows.map((r) => r.ideaId))
}

/** Retires an idea for everyone, inside the caller's transaction; an idea already used stays as it was. */
export async function retireIdea(exec: Exec, ideaId: string, userId: string, designId: string, now: Date): Promise<void> {
  await exec.insert(studioIdeaUses).values({ ideaId, userId, designId, usedAt: now }).onConflictDoNothing()
}

// ── The admin page's counts ─────────────────────────────────────────────────

export type IdeaCount = { key: string; left: number; total: number }
/** Fewer than this many left in a slot or move is flagged on the admin page. */
export const IDEAS_LOW = 3

/**
 * How many ideas are left of how many: per slot (every idea that covers it, outfits included, as the slot's chip
 * draws them) and for outfits, then per move.
 */
export async function ideaCounts(exec: Exec = db): Promise<{ wearable: IdeaCount[]; emote: IdeaCount[]; low: number }> {
  const retired = await retiredIdeas(exec)
  const count = (key: string, match: (i: Idea) => boolean): IdeaCount => {
    const all = IDEAS.filter(match)
    return { key, left: all.filter((i) => !retired.has(i.id)).length, total: all.length }
  }
  return {
    wearable: [
      ...IDEA_SLOTS.map((s) => count(s, (i) => i.kind === 'wearable' && (i.slots as string[]).includes(s))),
      count('outfit', isOutfit),
    ],
    emote: IDEA_MOVES.map((m) => count(m, (i) => i.kind === 'emote' && i.move === m)),
    low: IDEAS_LOW,
  }
}
