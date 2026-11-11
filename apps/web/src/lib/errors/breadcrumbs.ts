import { ERROR_LIMITS, redactText, redactUrl, type Breadcrumb } from '@virvixr/shared'

/**
 * The last ~30 things the user did before an error (LIV-66): pages visited, button and link labels clicked, and API
 * calls. Never typed text: a click is recorded by the clicked button or link's own label only.
 */
export class Breadcrumbs {
  private items: Breadcrumb[] = []
  constructor(private now: () => number = Date.now) {}

  private push(c: Breadcrumb) {
    this.items.push(c)
    if (this.items.length > ERROR_LIMITS.maxBreadcrumbs) this.items.splice(0, this.items.length - ERROR_LIMITS.maxBreadcrumbs)
  }

  nav(path: string) {
    this.push({ t: this.now(), type: 'nav', path: redactUrl(path).slice(0, ERROR_LIMITS.maxPath) })
  }

  click(label: string | null) {
    if (!label) return
    this.push({ t: this.now(), type: 'click', label: redactText(label).slice(0, ERROR_LIMITS.maxLabel) })
  }

  api(method: string, path: string, status: number, ms: number, requestId: string | null) {
    this.push({
      t: this.now(), type: 'api', method: method.toUpperCase(), path: redactUrl(path).slice(0, ERROR_LIMITS.maxPath), status, ms: Math.round(ms),
      ...(requestId ? { requestId } : {}),
    })
  }

  list(): Breadcrumb[] {
    return this.items.map((c) => ({ ...c }))
  }
}

/** The parts of a DOM element clickLabel reads. */
export interface LabelledElement {
  tagName: string
  textContent: string | null
  getAttribute(name: string): string | null
}

/**
 * A clicked button's or link's label: its aria-label, its text or its title. Null for anything else, and always for
 * form fields (inputs, text areas, selects), so nothing typed is ever recorded.
 */
export function clickLabel(el: LabelledElement | null): string | null {
  if (!el) return null
  const tag = el.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return null
  if (tag !== 'BUTTON' && tag !== 'A' && el.getAttribute('role') !== 'button' && el.getAttribute('role') !== 'link' && el.getAttribute('role') !== 'tab' && el.getAttribute('role') !== 'menuitem') return null
  const text = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, ERROR_LIMITS.maxLabel) : null
}
