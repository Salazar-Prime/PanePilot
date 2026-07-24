import { Bot, Play, Sparkles, TerminalSquare } from 'lucide-react'
import type { LaunchProfile } from '@shared/types'

const profileIcons = {
  shell: TerminalSquare,
  codex: Sparkles,
  claude: Bot,
  custom: Play
} satisfies Record<LaunchProfile, typeof Bot>

const profileLabels = {
  shell: 'Shell',
  codex: 'Codex',
  claude: 'Claude Code',
  custom: 'Action'
} satisfies Record<LaunchProfile, string>

export function TerminalProfileIcon({
  profile,
  size = 13,
  className
}: {
  profile: LaunchProfile
  size?: number
  className?: string
}) {
  const Icon = profileIcons[profile]
  return (
    <Icon
      className={className}
      size={size}
      aria-label={profileLabels[profile]}
    />
  )
}

export function terminalProfileLabel(profile: LaunchProfile): string {
  return profileLabels[profile]
}
