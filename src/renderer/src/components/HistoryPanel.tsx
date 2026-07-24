import { Clock3, History } from 'lucide-react'
import type { Project } from '@shared/types'

export function HistoryPanel({ project }: { project: Project }) {
  if (!project.activities.length) {
    return (
      <div className="capability-empty">
        <History size={34} />
        <h3>No activity yet</h3>
        <p>Terminal launches and state changes will appear here.</p>
      </div>
    )
  }

  return (
    <div className="history-panel">
      <div className="history-heading">
        <span className="eyebrow">PROJECT TIMELINE</span>
        <h2>Recent activity</h2>
      </div>
      <div className="timeline">
        {project.activities.map((activity) => (
          <article className="timeline-item" key={activity.id}>
            <span className="timeline-marker" />
            <div>
              <p>{activity.message}</p>
              <span>
                <Clock3 size={12} />
                {formatDate(activity.createdAt)}
              </span>
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value))
}
