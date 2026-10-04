import { describe, expect, it, vi } from 'vitest'
import { SidebarProjectMotion } from '../src/renderer/src/lib/sidebarProjectMotion'

function row(id: string, top: number, height = 37) {
  const classes = new Set<string>()
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; onfinish: (() => void) | null }> = []
  const element = {
    dataset: { sidebarProjectId: id }, offsetTop: top, offsetHeight: height, offsetWidth: 240,
    classList: {
      add: (...names: string[]) => names.forEach((name) => classes.add(name)),
      remove: (...names: string[]) => names.forEach((name) => classes.delete(name))
    },
    animate: vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
      const animation = { cancel: vi.fn(), onfinish: null as (() => void) | null }
      animations.push(animation)
      return animation
    })
  }
  return { element, classes, animations }
}

type Row = ReturnType<typeof row>
function group(id: string, rows: Row[], top = 100) {
  return {
    rows, top, dataset: { sidebarConnectionId: id },
    getBoundingClientRect() { return { top: this.top } },
    querySelectorAll() { return this.rows.map((item) => item.element) }
  }
}

function fixture() {
  const a = row('a', 24)
  const b = row('b', 61)
  const c = row('c', 98)
  const local = group('local', [a, b, c])
  const container = {
    groups: [local], visible: true,
    getClientRects() { return this.visible ? [{}] : [] },
    getBoundingClientRect: () => ({ top: 100, bottom: 600 }),
    querySelectorAll() { return this.groups }
  }
  const translation = new Map<HTMLElement, number>()
  const motion = new SidebarProjectMotion((element) => element ? translation.get(element) ?? 0 : 0)
  const update = (enabled = true) => motion.update(container as unknown as HTMLElement, enabled)
  const order = (rows: Row[]) => {
    local.rows = rows
    let top = 24
    for (const item of rows) { item.element.offsetTop = top; top += item.element.offsetHeight }
  }
  return { a, b, c, local, container, motion, translation, update, order }
}

describe('sidebar project sorting motion', () => {
  it('does not animate the initial list or ordinary status updates', () => {
    const f = fixture()
    f.update()
    f.update()
    expect(f.a.element.animate).not.toHaveBeenCalled()
    expect(f.b.element.animate).not.toHaveBeenCalled()
  })

  it('slides a promoted project and displaced projects without fading labels', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    expect(f.c.element.animate).toHaveBeenCalledWith([
      { transform: 'translateY(74px)' }, { transform: 'translateY(0)' }
    ], { duration: 380, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    expect(f.a.element.animate.mock.calls[0][0][0]).toEqual({ transform: 'translateY(-37px)' })
    expect(f.c.classes.has('sidebar-project-promoted')).toBe(true)
    expect(f.a.classes.has('sidebar-project-promoted')).toBe(false)
  })

  it('moves expanded project subtrees using their actual heights', () => {
    const f = fixture()
    f.a.element.offsetHeight = 160
    f.order([f.a, f.b, f.c])
    f.update()
    f.order([f.b, f.a, f.c])
    f.update()
    expect(f.b.element.animate.mock.calls[0][0][0]).toEqual({ transform: 'translateY(160px)' })
    expect(f.c.element.animate).not.toHaveBeenCalled()
  })

  it('retargets rapid reorders from the current visual position', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    f.translation.set(f.c.element as unknown as HTMLElement, 30)
    f.order([f.a, f.b, f.c])
    f.update()
    expect(f.c.animations[0].cancel).toHaveBeenCalledOnce()
    expect(f.c.element.animate.mock.calls[1][0][0]).toEqual({ transform: 'translateY(-44px)' })
  })

  it('does not restart in-flight motion on an unrelated rerender or scroll', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    f.local.top -= 50
    f.update()
    expect(f.c.element.animate).toHaveBeenCalledOnce()
    expect(f.c.animations[0].cancel).not.toHaveBeenCalled()
  })

  it('keeps machine groups independent', () => {
    const f = fixture()
    const remote = row('remote', 24)
    f.container.groups.push(group('ssh', [remote], 300))
    f.update()
    f.order([f.b, f.a, f.c])
    f.update()
    expect(remote.element.animate).not.toHaveBeenCalled()
  })

  it('does not treat addition, deletion, or expansion as sorting', () => {
    const f = fixture()
    f.update()
    f.order([f.a, f.c])
    f.update()
    f.a.element.offsetHeight = 180
    f.order([f.a, f.c, f.b])
    f.update()
    expect(f.a.element.animate).not.toHaveBeenCalled()
    expect(f.b.element.animate).not.toHaveBeenCalled()
    expect(f.c.element.animate).not.toHaveBeenCalled()
  })

  it('cancels stale geometry on resize, instead of jumping from the old layout', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    f.c.element.offsetWidth = 300
    f.update()
    expect(f.c.animations[0].cancel).toHaveBeenCalledOnce()
    expect(f.c.element.animate).toHaveBeenCalledOnce()
  })

  it('continues the slide when selection expands terminals during a reorder', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    f.translation.set(f.c.element as unknown as HTMLElement, 45)
    f.c.element.offsetHeight = 160
    f.order([f.c, f.a, f.b])
    f.update()
    expect(f.c.element.animate.mock.calls[1][0][0]).toEqual({ transform: 'translateY(45px)' })
    expect(f.c.classes.has('sidebar-project-moving')).toBe(true)
  })

  it('clears running effects when reduced motion is enabled or the sidebar hides', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    f.update(false)
    expect(f.c.animations[0].cancel).toHaveBeenCalledOnce()
    expect(f.c.classes.size).toBe(0)
    f.update()
    expect(f.c.element.animate).toHaveBeenCalledOnce()
    f.container.visible = false
    f.update()
    f.container.visible = true
    f.order([f.a, f.b, f.c])
    f.update()
    expect(f.c.element.animate).toHaveBeenCalledOnce()
  })

  it('cleans finished, removed, and unmounted animations', () => {
    const f = fixture()
    f.update()
    f.order([f.c, f.a, f.b])
    f.update()
    f.c.animations[0].onfinish!()
    expect(f.c.classes.size).toBe(0)
    f.order([f.c, f.b])
    f.update()
    expect(f.a.animations[0].cancel).toHaveBeenCalledOnce()
    f.motion.reset()
    expect(f.b.classes.size).toBe(0)
  })

  it('skips work on rows whose full motion remains outside the viewport', () => {
    const f = fixture()
    f.local.top = 1500
    f.update()
    f.order([f.b, f.a, f.c])
    f.update()
    expect(f.a.element.animate).not.toHaveBeenCalled()
    expect(f.b.element.animate).not.toHaveBeenCalled()
  })
})
