/// <reference types="electron-vite/node" />
import createArchiveWorker from './conversation-indexer-worker?nodeWorker'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AsyncConversationIndexer, type ConversationWorkerOptions } from './conversation-indexer-client'

export function createConversationIndexer(options: ConversationWorkerOptions = {}): AsyncConversationIndexer {
  return new AsyncConversationIndexer((workerData) => createArchiveWorker({ workerData }), {
    ...options,
    roots: options.roots ?? [
      { provider: 'codex', path: join(homedir(), '.codex', 'sessions') },
      { provider: 'claude', path: join(homedir(), '.claude', 'projects') }
    ]
  })
}
