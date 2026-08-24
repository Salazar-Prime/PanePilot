export const NODE_PTY_DARWIN_PATCH_VERSION: string

export function patchNodePtyDarwinSource(source: string): {
  source: string
  changed: boolean
}
