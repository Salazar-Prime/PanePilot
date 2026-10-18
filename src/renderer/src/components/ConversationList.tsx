import { useId } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ConversationNode } from '@shared/conversation-hierarchy'
import { formatConversationDate } from '../lib/conversationDate'

interface Props {
  nodes: ConversationNode[]
  selectedId: string | null
  expanded: ReadonlySet<string>
  searching: boolean
  onSelect: (id: string) => void
  onToggle: (id: string) => void
}

export function ConversationList(props: Props) {
  return <>{props.nodes.map((node) => <ConversationRow key={node.conversation.id} {...props} node={node} />)}</>
}

function ConversationRow({ node, ...props }: Props & { node: ConversationNode }) {
  const { conversation, children, descendantCount } = node
  const reducedMotion = useReducedMotion()
  const childrenId = useId()
  const open = props.searching || props.expanded.has(conversation.id)
  const child = Boolean(conversation.parentProviderSessionId)
  return (
    <div className={`chat-tree-node${child ? ' subagent' : ''}`}>
      <button
        className={`chat-conversation-card${conversation.id === props.selectedId ? ' selected' : ''}`}
        onClick={() => props.onSelect(conversation.id)}
        aria-current={conversation.id === props.selectedId ? 'true' : undefined}
      >
        <div className="chat-card-meta">
          <span className={`provider-badge ${conversation.provider}`}>{conversation.provider}</span>
          {child && <span className="chat-subagent-label"><GitBranch size={10} /> Subagent</span>}
          <time>{formatConversationDate(conversation.updatedAt)}</time>
        </div>
        <strong>{conversation.agentName || conversation.title}</strong>
        <p>{conversation.agentName ? conversation.title : conversation.snippet}</p>
        <small>
          {conversation.messageCount} messages
          {props.searching && (conversation.matchCount ? ` · ${conversation.matchCount} matches` : ' · Parent chat')}
        </small>
      </button>
      {children.length > 0 && (
        <>
          <button
            className={`chat-subagent-toggle${open ? ' expanded' : ''}`}
            aria-expanded={open}
            aria-controls={childrenId}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${descendantCount} subagent${descendantCount === 1 ? '' : 's'} for ${conversation.agentName || conversation.title}`}
            onClick={() => props.onToggle(conversation.id)}
            disabled={props.searching}
          >
            <ChevronRight size={12} />
            <GitBranch size={12} />
            <span>{descendantCount} subagent{descendantCount === 1 ? '' : 's'}</span>
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                key="subagents"
                id={childrenId}
                className="chat-subagent-disclosure"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.18, ease: [0.22, 1, 0.36, 1] }}
              >
                <div className="chat-subagent-children">
                  <ConversationList {...props} nodes={children} />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  )
}
