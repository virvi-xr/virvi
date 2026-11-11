import { describe, it, expect } from 'vitest'
import { customerReply, pieceName } from './studio-reply'

describe('an agent reply as the customer reads it', () => {
  it('drops where the proposal and the turn-down were written', () => {
    expect(customerReply('The idea could go several ways, so I wrote a proposal to `out/proposal.json` instead.'))
      .toBe('The idea could go several ways, so I wrote a proposal instead.')
    expect(customerReply('I put the options in out/proposal.json, then stopped.')).toBe('I put the options, then stopped.')
    expect(customerReply('That isn’t design work, so I noted it in `out/declined.json` and stopped.'))
      .toBe('That isn’t design work, so I noted it and stopped.')
  })

  it('names a piece by its folder', () => {
    expect(customerReply('I exported the cap into `out/hat/` with both body shapes.')).toBe('I exported the cap into the hat with both body shapes.')
    expect(customerReply('`out/upper_body/` now holds the jacket.')).toBe('The upper body piece now holds the jacket.')
    expect(customerReply('I rebuilt the `out/hat` folder and the `out/feet/sneaker_male.glb` file.'))
      .toBe('I rebuilt the hat and the feet piece file.')
    expect(customerReply('The table is in out/furniture_round_table/ and the house in `out/building/`.'))
      .toBe('The table is in the round table piece and the house in the building.')
    expect(customerReply('Everything is in `out/`.')).toBe('Everything is in the pieces.')
    expect(customerReply('- `out/emote/` loops cleanly now.')).toBe('- The emote loops cleanly now.')
    expect(customerReply('I made the cap (`out/hat/`) a little smaller.')).toBe('I made the cap a little smaller.')
  })

  it('calls an upload by the name the user gave it', () => {
    expect(customerReply('I used `uploads/beach-sketch.png` as the reference.')).toBe('I used beach-sketch.png as the reference.')
    expect(customerReply('The print comes from uploads/logo.png.')).toBe('The print comes from logo.png.')
  })

  it('names the preview and the checks, not the commands', () => {
    expect(customerReply('I ran `studio-preview out/hat` and the hair no longer pokes through.'))
      .toBe('I ran the preview and the hair no longer pokes through.')
    expect(customerReply('The wearable checker (`check_wearable.py`) passes with no warnings.')).toBe('The wearable checker passes with no warnings.')
    expect(customerReply('`check_emote.py` found no problems.')).toBe('The checks found no problems.')
    expect(customerReply('I ran check_wearable.py again: it passes.')).toBe('I ran the checks again: it passes.')
    expect(customerReply('I checked it with `python3 /opt/skills/check_wearable.py out/hat/cap.glb`.')).toBe('I checked it with the checks.')
  })

  it('keeps only the base name of any other workspace path', () => {
    expect(customerReply('I built it in `/work/build_cap.py` from `cap_base.blend`.')).toBe('I built it in build_cap.py from cap_base.blend.')
    expect(customerReply('The listing is in `out/hat/piece.json`.')).toBe('The listing is in the hat.')
  })

  it('leaves normal prose and other code alone', () => {
    const prose = [
      'I made a sky-blue bucket hat with a woven straw band. Do you want it to hide the hair?',
      'I figured out/decided the brim should be wider, and/or a little floppier.',
      'It works on both body shapes: male/female, 1/2 the triangles of the last one.',
      'Inside out, upside down: the jacket is lined in red.',
      'Set `hides` to `hair` and `loop` to `true` if you want it to repeat.',
      'The colour is `#3a7bd5`, and the rarity is `epic`.',
      'Check out the new sleeves; the checks all pass.',
      'Here is the plan:\n\n1. A cap\n2. Sneakers',
      'It has an `in` and an `out` point, so it loops.',
      'Set it to `out` mode for the loop.',
      'Zoom in and out of the preview.',
      'The bangs stick out/hair pokes through the brim, so I moved it up.',
      'The bangs stick out/hat on one side.',
      'See [the brief](https://example.com/out/hat/brief) for more.',
      '',
    ]
    for (const p of prose) expect(customerReply(p)).toBe(p)
    // a fenced block is shown as written
    const fenced = 'The settings:\n```\nout/hat/piece.json\n```'
    expect(customerReply(fenced)).toBe(fenced)
  })
})

describe('the words around a rewritten token', () => {
  it('replaces an article and drops a following folder', () => {
    expect(customerReply('I tidied your `out/hat/` folder.')).toBe('I tidied your hat.')
    expect(customerReply('There is a `out/feet` folder now.')).toBe('There is the feet piece now.')
    expect(customerReply('The cap is in the `out/hat/` folder.')).toBe('The cap is in the hat.')
    expect(customerReply('The `out/hat/` directory holds both shapes.')).toBe('The hat holds both shapes.')
    expect(customerReply('Your `out/upper_body/` folder is ready.')).toBe('Your upper body piece is ready.')
  })

  it('doesn’t capitalise after an abbreviation', () => {
    expect(customerReply('A small change, e.g. `out/hat` works on both shapes.')).toBe('A small change, e.g. the hat works on both shapes.')
    expect(customerReply('Pieces, i.e. `out/feet/` and more.')).toBe('Pieces, i.e. the feet piece and more.')
  })

  it('reads a checker run with its flags as one, and never doubles the phrase', () => {
    expect(customerReply('I fixed what failed the checks in `check_wearable.py --strict`.')).toBe('I fixed what failed the checks.')
    expect(customerReply('I ran check_wearable.py --strict and it passes.')).toBe('I ran the checks and it passes.')
    expect(customerReply('The checker check_emote.py found nothing.')).toBe('The checker found nothing.')
    expect(customerReply('I looked in the preview (`studio-preview out/hat --tour`).')).toBe('I looked in the preview.')
  })

  it('keeps a file name with Markdown characters in a code span', () => {
    expect(customerReply('I used `uploads/my*star*.png` as the print.')).toBe('I used `my*star*.png` as the print.')
    expect(customerReply('I used uploads/_ref_.png.')).toBe('I used `_ref_.png`.')
    expect(customerReply('I used uploads/my_cool_ref.png.')).toBe('I used my_cool_ref.png.')
  })

  it('turns a link into a workspace path into its words, and leaves web links alone', () => {
    expect(customerReply('Have a look at [out/hat/cap.glb](out/hat/cap.glb).')).toBe('Have a look at the hat.')
    expect(customerReply('Your [reference](uploads/beach.png) is on the front.')).toBe('Your reference is on the front.')
  })
})

describe('where a piece’s file was written', () => {
  it('drops "to" or "into" a file in a piece’s folder, since the sentence already names the piece', () => {
    expect(customerReply('I exported the hat to `out/hat/hat_male.glb` and checked it.')).toBe('I exported the hat and checked it.')
    expect(customerReply('Saved the shirt into out/upper_body/shirt.glb.')).toBe('Saved the shirt.')
    expect(customerReply('I fixed the weights in `out/upper_body/`.')).toBe('I fixed the weights in the upper body piece.')
  })
})

describe('a piece’s folder for people', () => {
  it('uses the category labels, with "piece" where the label is a body part', () => {
    expect(pieceName('hat')).toBe('the hat')
    expect(pieceName('facial_hair')).toBe('the facial hair')
    expect(pieceName('upper_body')).toBe('the upper body piece')
    expect(pieceName('hands_wear')).toBe('the hands wear piece')
    expect(pieceName('furniture_round_table')).toBe('the round table piece')
    expect(pieceName('building')).toBe('the building')
    expect(pieceName('emote')).toBe('the emote')
    expect(pieceName('cape')).toBeNull()
  })
})
