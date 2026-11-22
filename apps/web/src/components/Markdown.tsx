'use client'
import { Fragment, useMemo, type MouseEvent } from 'react'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'
import { safeHref } from '@/lib/assistant/state'

/**
 * Which links are clickable.
 * - `external` (Studio): http(s) addresses open in a new tab; a path shows as its label.
 * - `assistant`: a dashboard path opens in the same tab through `onNavigate`, and an https address on virvi.io (or a
 *   subdomain) in a new tab. Anything else shows as `label (address)` with no link, since a reply can be steered by
 *   text the assistant read.
 */
export type MarkdownLinks = 'external' | 'assistant'

type Ctx = { links: MarkdownLinks; onNavigate?: (href: string) => void }

/** A reply, formatted. The tree from parseMarkdown becomes elements; no HTML from the reply is ever used. */
export default function Markdown({ text, links = 'external', onNavigate }: { text: string; links?: MarkdownLinks; onNavigate?: (href: string) => void }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <Blocks blocks={blocks} ctx={{ links, onNavigate }} />
}

const HEADING = {
  1: ['h3', 'text-base font-semibold text-white'],
  2: ['h4', 'font-semibold text-white'],
  3: ['h5', 'font-medium text-gray-100'],
} as const

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const

function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.type === 'p') return <p key={i}><Inlines items={b.inlines} ctx={ctx} /></p>
        if (b.type === 'h') {
          const [Tag, cls] = HEADING[b.level]
          return <Tag key={i} className={cls}><Inlines items={b.inlines} ctx={ctx} /></Tag>
        }
        if (b.type === 'code') {
          return <pre key={i} className="overflow-x-auto rounded bg-black/40 px-2 py-1.5 font-mono text-xs text-gray-300">{b.text}</pre>
        }
        if (b.type === 'table') {
          const cell = (j: number) => `border border-gray-700 px-2 py-1 ${ALIGN[b.align[j] ?? 'left']}`
          return (
            <div key={i} className="max-w-full overflow-x-auto">
              <table className="border-collapse text-xs">
                <thead className="bg-black/30 text-white">
                  <tr>{b.head.map((c, j) => <th key={j} className={`${cell(j)} font-semibold`}><Inlines items={c} ctx={ctx} /></th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} className={cell(j)}><Inlines items={c} ctx={ctx} /></td>)}</tr>)}
                </tbody>
              </table>
            </div>
          )
        }
        const items = b.items.map((item, j) => (
          <li key={j}>
            <Inlines items={item.inlines} ctx={ctx} />
            {item.children.length > 0 && <div className="mt-1"><Blocks blocks={item.children} ctx={ctx} /></div>}
          </li>
        ))
        return b.type === 'ul'
          ? <ul key={i} className="list-disc space-y-0.5 pl-5">{items}</ul>
          : <ol key={i} start={b.start} className="list-decimal space-y-0.5 pl-5">{items}</ol>
      })}
    </div>
  )
}

/** https on virvi.io or one of its subdomains. */
function isVirviAddress(href: string): boolean {
  try {
    const u = new URL(href)
    return u.protocol === 'https:' && (u.hostname === 'virvi.io' || u.hostname.endsWith('.virvi.io'))
  } catch {
    return false
  }
}

const LINK = 'text-blue-300 underline'

function Link({ href, children, ctx }: { href: string; children: Inline[]; ctx: Ctx }) {
  const label = <Inlines items={children} ctx={ctx} />
  const isPath = href.startsWith('/')
  const newTab = <a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>{label}</a>
  if (ctx.links === 'external') return isPath ? label : newTab
  if (isPath && safeHref(href)) {
    const open = (e: MouseEvent<HTMLAnchorElement>) => {
      // A modified click (new tab, new window) is the browser's; a plain one stays in the app
      if (!ctx.onNavigate || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
      e.preventDefault()
      ctx.onNavigate(href)
    }
    return <a href={href} onClick={open} className={LINK}>{label}</a>
  }
  if (isVirviAddress(href)) return newTab
  return <>{label} ({href})</>
}

function Inlines({ items, ctx }: { items: Inline[]; ctx: Ctx }) {
  return (
    <>
      {items.map((n, i) => {
        switch (n.type) {
          case 'text': return <Fragment key={i}>{n.text}</Fragment>
          case 'br': return <br key={i} />
          case 'strong': return <strong key={i} className="font-semibold text-white"><Inlines items={n.children} ctx={ctx} /></strong>
          case 'em': return <em key={i}><Inlines items={n.children} ctx={ctx} /></em>
          case 'code': return <code key={i} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em]">{n.text}</code>
          case 'link': return <Link key={i} href={n.href} ctx={ctx}>{n.children}</Link>
        }
      })}
    </>
  )
}
