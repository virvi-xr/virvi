import { describe, it, expect } from 'vitest'
import { parseMarkdown } from './markdown'

const t = (text: string) => ({ type: 'text', text })
const item = (...inlines: unknown[]) => ({ inlines, children: [] })

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'p', inlines: [t('one'), { type: 'br' }, t('two')] },
      { type: 'p', inlines: [t('three')] },
    ])
  })

  it('reads bold, italics and inline code', () => {
    expect(parseMarkdown('a **bold** and *soft* and _also_ `out/hat/`')).toEqual([{ type: 'p', inlines: [
      t('a '), { type: 'strong', children: [t('bold')] }, t(' and '), { type: 'em', children: [t('soft')] },
      t(' and '), { type: 'em', children: [t('also')] }, t(' '), { type: 'code', text: 'out/hat/' },
    ] }])
  })

  it('leaves markers alone inside code and in words like snake_case', () => {
    expect(parseMarkdown('`**not bold**` upper_body_piece')).toEqual([{ type: 'p', inlines: [
      { type: 'code', text: '**not bold**' }, t(' upper_body_piece'),
    ] }])
  })

  it('reads headings and lists', () => {
    expect(parseMarkdown('## What changed\n- the **visor**\n- the brim\n\n1. first\n2. second')).toEqual([
      { type: 'h', level: 2, inlines: [t('What changed')] },
      { type: 'ul', items: [item(t('the '), { type: 'strong', children: [t('visor')] }), item(t('the brim'))] },
      { type: 'ol', start: 1, items: [item(t('first')), item(t('second'))] },
    ])
  })

  it('keeps fenced code as it is', () => {
    expect(parseMarkdown('Run:\n```bash\nblender -b **x**\n```\ndone')).toEqual([
      { type: 'p', inlines: [t('Run:')] },
      { type: 'code', text: 'blender -b **x**' },
      { type: 'p', inlines: [t('done')] },
    ])
  })

  it('links only http and https addresses', () => {
    expect(parseMarkdown('[docs](https://docs.decentraland.org) and [bad](javascript:alert(1))')).toEqual([{ type: 'p', inlines: [
      { type: 'link', href: 'https://docs.decentraland.org', children: [t('docs')] },
      t(' and [bad](javascript:alert(1))'),
    ] }])
  })

  it('treats html as text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([{ type: 'p', inlines: [t('<img src=x onerror=alert(1)>')] }])
  })

  it('closes an unterminated fence at the end and leaves a lone marker as text', () => {
    expect(parseMarkdown('```\ncode')).toEqual([{ type: 'code', text: 'code' }])
    expect(parseMarkdown('2 * 3 is **six')).toEqual([{ type: 'p', inlines: [t('2 * 3 is **six')] }])
  })

  it('keeps a numbered list’s numbers across blank lines and sub-bullets', () => {
    expect(parseMarkdown('1. a\n\n2. b\n\n3. c')).toEqual([{ type: 'ol', start: 1, items: [item(t('a')), item(t('b')), item(t('c'))] }])
    expect(parseMarkdown('1. build\n   - the brim\n   - the visor\n2. check')).toEqual([{ type: 'ol', start: 1, items: [
      { inlines: [t('build')], children: [{ type: 'ul', items: [item(t('the brim')), item(t('the visor'))] }] },
      item(t('check')),
    ] }])
    expect(parseMarkdown('3. third\n4. fourth')).toEqual([{ type: 'ol', start: 3, items: [item(t('third')), item(t('fourth'))] }])
  })

  it('keeps a wrapped list line in its item', () => {
    expect(parseMarkdown('- a long point\n  that wraps\n- next')).toEqual([{ type: 'ul', items: [
      item(t('a long point'), { type: 'br' }, t('that wraps')), item(t('next')),
    ] }])
  })

  it('nests bold inside italics and the other way round', () => {
    expect(parseMarkdown('*italic with **bold** inside*')).toEqual([{ type: 'p', inlines: [
      { type: 'em', children: [t('italic with '), { type: 'strong', children: [t('bold')] }, t(' inside')] },
    ] }])
    expect(parseMarkdown('***both***')).toEqual([{ type: 'p', inlines: [
      { type: 'strong', children: [{ type: 'em', children: [t('both')] }] },
    ] }])
  })

  it('keeps balanced parentheses in a link', () => {
    expect(parseMarkdown('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)).')).toEqual([{ type: 'p', inlines: [
      { type: 'link', href: 'https://en.wikipedia.org/wiki/Foo_(bar)', children: [t('Foo')] }, t('.'),
    ] }])
  })

  it('reads a table with column alignment', () => {
    expect(parseMarkdown('| Name | Count |\n| :--- | ---: |\n| **Hat** | 3 |\n| Cap | 12 |')).toEqual([{
      type: 'table', align: ['left', 'right'],
      head: [[t('Name')], [t('Count')]],
      rows: [[[{ type: 'strong', children: [t('Hat')] }], [t('3')]], [[t('Cap')], [t('12')]]],
    }])
    expect(parseMarkdown('a | b\n:-:|---\n1 | 2')).toEqual([{ type: 'table', align: ['center', null], head: [[t('a')], [t('b')]], rows: [[[t('1')], [t('2')]]] }])
  })

  it('pads a short table row and drops extra cells', () => {
    expect(parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |')).toEqual([{
      type: 'table', align: [null, null], head: [[t('a')], [t('b')]],
      rows: [[[t('1')], []], [[t('1')], [t('2')]]],
    }])
  })

  it('keeps pipe lines with no separator row as a paragraph', () => {
    expect(parseMarkdown('| a | b |\n| 1 | 2 |')).toEqual([{ type: 'p', inlines: [t('| a | b |'), { type: 'br' }, t('| 1 | 2 |')] }])
  })

  it('ends a table at a blank line', () => {
    expect(parseMarkdown('| a |\n|---|\n| 1 |\n\nafter')).toEqual([
      { type: 'table', align: [null], head: [[t('a')]], rows: [[[t('1')]]] },
      { type: 'p', inlines: [t('after')] },
    ])
  })

  it('keeps a root-relative path as a link', () => {
    expect(parseMarkdown('[Open it](/scenes?id=x)')).toEqual([{ type: 'p', inlines: [
      { type: 'link', href: '/scenes?id=x', children: [t('Open it')] },
    ] }])
  })

  it('never links javascript:, data: or protocol-relative addresses', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,hi', '//evil.example/x', '/\\evil.example']) {
      const [p] = parseMarkdown(`[x](${href})`)
      expect(JSON.stringify(p)).not.toContain('"link"')
    }
  })

  it('keeps a script tag as text', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([{ type: 'p', inlines: [t('<script>alert(1)</script>')] }])
  })
})
