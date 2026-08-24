export const NODE_PTY_DARWIN_PATCH_VERSION =
  'panepilot-node-pty-darwin-fd-fix-v1'

const PATCH_COMMENT =
  '// PanePilot backport for microsoft/node-pty#907 and #931.'

function replaceExactlyOnce(source, search, replacement, label) {
  const firstMatch = source.indexOf(search)
  if (firstMatch === -1) {
    throw new Error(`Could not apply the node-pty ${label} backport.`)
  }
  if (source.indexOf(search, firstMatch + search.length) !== -1) {
    throw new Error(`The node-pty ${label} backport target is ambiguous.`)
  }
  return `${source.slice(0, firstMatch)}${replacement}${source.slice(
    firstMatch + search.length
  )}`
}

export function patchNodePtyDarwinSource(source) {
  let patched = source

  const fixedKqueue = '    close(kq);\n#else\n    while (true) {'
  if (!patched.includes(fixedKqueue)) {
    patched = replaceExactlyOnce(
      patched,
      '    }\n#else\n    while (true) {',
      `    }\n    ${PATCH_COMMENT}\n${fixedKqueue}`,
      'kqueue descriptor'
    )
  }

  const fixedSpawnCleanup = [
    '  close(slave);',
    '',
    '  for (size_t index = 0; index <= count; index++) {',
    '    close(low_fds[index]);',
    '  }'
  ].join('\n')
  if (!patched.includes(fixedSpawnCleanup)) {
    patched = replaceExactlyOnce(
      patched,
      [
        '  for (; count > 0; count--) {',
        '    close(low_fds[count]);',
        '  }'
      ].join('\n'),
      [
        `  ${PATCH_COMMENT}`,
        '  close(slave);',
        '',
        fixedSpawnCleanup.split('\n').slice(2).join('\n')
      ].join('\n'),
      'PTY descriptor cleanup'
    )
  }

  return {
    source: patched,
    changed: patched !== source
  }
}
