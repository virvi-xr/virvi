import type { AssistantMessageView } from '@virvixr/shared'
import Markdown from '@/components/Markdown'

/** A message's words: the assistant's reply formatted as markdown (only Virvi links clickable), the user's own as typed. */
export function MessageText({ role, text, onOpen }: { role: AssistantMessageView['role']; text: string; onOpen: (href: string) => void }) {
  if (role === 'user') return <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
  return <div className="min-w-0 break-words text-sm text-gray-200"><Markdown text={text} links="assistant" onNavigate={onOpen} /></div>
}
