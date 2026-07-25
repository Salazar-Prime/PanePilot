import type { Connection } from '@shared/types'

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function tmuxAttachCommand(
  connection: Connection | undefined,
  sessionName: string
): string {
  const command = `tmux attach-session -t ${shellQuote(`=${sessionName}`)}`
  return connection?.kind === 'ssh'
    ? `ssh -t ${shellQuote(connection.sshAlias!)} ${shellQuote(command)}`
    : command
}

export function tmuxOptionsCommand(
  connection: Connection | undefined,
  sessionName: string
): string {
  const command = `tmux show-options -t ${shellQuote(`=${sessionName}`)}`
  return connection?.kind === 'ssh'
    ? `ssh ${shellQuote(connection.sshAlias!)} ${shellQuote(command)}`
    : command
}
