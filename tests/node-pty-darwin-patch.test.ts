import { describe, expect, it } from 'vitest'
import { patchNodePtyDarwinSource } from '../scripts/node-pty-darwin-patch.mjs'

const vulnerableSource = `
    } else {
      wait_for_process();
    }
#else
    while (true) {
      wait_for_process();
    }
#endif

done:
  posix_spawn_file_actions_destroy(&acts);
  posix_spawnattr_destroy(&attrs);

  for (; count > 0; count--) {
    close(low_fds[count]);
  }
`

describe('node-pty macOS descriptor backport', () => {
  it('closes every descriptor left open by node-pty 1.1.0', () => {
    const patched = patchNodePtyDarwinSource(vulnerableSource)

    expect(patched.changed).toBe(true)
    expect(patched.source).toContain('close(kq);')
    expect(patched.source).toContain('close(slave);')
    expect(patched.source).toContain(
      'for (size_t index = 0; index <= count; index++)'
    )
    expect(patched.source).toContain('close(low_fds[index]);')
    expect(patched.source).not.toContain('for (; count > 0; count--)')
  })

  it('is idempotent when preparation runs before every launch', () => {
    const once = patchNodePtyDarwinSource(vulnerableSource)
    const twice = patchNodePtyDarwinSource(once.source)

    expect(twice.changed).toBe(false)
    expect(twice.source).toBe(once.source)
  })

  it('fails loudly if the pinned native source changes incompatibly', () => {
    expect(() => patchNodePtyDarwinSource('unrecognized source')).toThrow(
      'Could not apply the node-pty kqueue descriptor backport.'
    )
  })
})
