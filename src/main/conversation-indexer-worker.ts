import { parentPort, workerData } from 'node:worker_threads'
import { ConversationIndexer } from './conversation-indexer'
import type { ConversationWorkerOptions, ConversationWorkerRequest, ConversationWorkerReply } from './conversation-indexer-client'
import type { ConversationProvider } from '../shared/types'

const options = workerData as ConversationWorkerOptions | undefined
const indexer = new ConversationIndexer(options?.roots, options?.cache)
parentPort!.on('message', ({ id, method, args }: ConversationWorkerRequest) => {
  try {
    let value: unknown
    switch (method) {
      case 'list': value = indexer.list(args[0] as string, args[1] as string, args[2] as number); break
      case 'get': value = indexer.get(args[0] as string, args[1] as string, args[2] as string); break
      case 'findProviderSessionId': value = indexer.findProviderSessionId(args[0] as ConversationProvider,
        args[1] as string, args[2] as string, new Set(args[3] as string[]), args[4] as string | null); break
      case 'diagnostics': value = indexer.diagnostics(); break
      default: throw new Error('Unknown conversation archive operation.')
    }
    parentPort!.postMessage({ id, value } satisfies ConversationWorkerReply)
  } catch (error) {
    parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) } satisfies ConversationWorkerReply)
  }
})
