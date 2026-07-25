import { describe, expect, it } from 'vitest'
import type { Connection } from '../src/shared/types'
import {
  tmuxAttachCommand,
  tmuxOptionsCommand
} from '../src/renderer/src/lib/tmuxCommands'

const local: Connection = {
  id: 'local',
  kind: 'local',
  name: 'This Mac',
  sshAlias: null
}

const remote: Connection = {
  id: 'remote',
  kind: 'ssh',
  name: 'Remote',
  sshAlias: 'build-host'
}

describe('tmux copy commands', () => {
  it('targets the exact local session for attach and option inspection', () => {
    expect(tmuxAttachCommand(local, 'Agent One')).toBe(
      "tmux attach-session -t '=Agent One'"
    )
    expect(tmuxOptionsCommand(local, 'Agent One')).toBe(
      "tmux show-options -t '=Agent One'"
    )
  })

  it('quotes the complete tmux command for an SSH host', () => {
    expect(tmuxOptionsCommand(remote, 'Agent One')).toBe(
      "ssh 'build-host' 'tmux show-options -t '\\''=Agent One'\\'''"
    )
  })
})
