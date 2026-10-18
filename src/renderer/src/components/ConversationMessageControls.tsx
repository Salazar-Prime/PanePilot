import { ArrowLeft, ArrowRight } from 'lucide-react'
import { MAX_HIDDEN_MESSAGES } from '@shared/conversation-messages'

interface Props {
  hiddenCount: number
  total: number
  previous: boolean
  next: boolean
  onChange: (count: number) => void
  onJump: (direction: -1 | 1) => void
}

export function ConversationMessageControls({ hiddenCount, total, previous, next, onChange, onJump }: Props) {
  return (
    <div className="chat-render-controls">
      <button className="chat-message-arrow" aria-label="Previous user message" title="Previous user message" disabled={!previous} onClick={() => onJump(-1)}>
        <ArrowLeft size={15} />
      </button>
      <div className="chat-message-counter">
        <input type="number" min={0} max={MAX_HIDDEN_MESSAGES} step={1} value={hiddenCount}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          aria-label="Messages to hide at the start of every chat"
          title="Hide this many opening messages in every chat and sidebar preview. Remembered for this PanePilot session." />
        <span role="status">{total} {total === 1 ? 'message' : 'messages'}</span>
      </div>
      <button className="chat-message-arrow" aria-label="Next user message" title="Next user message" disabled={!next} onClick={() => onJump(1)}>
        <ArrowRight size={15} />
      </button>
    </div>
  )
}
