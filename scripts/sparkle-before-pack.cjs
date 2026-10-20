module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return
  const { prepareSparkle } = await import('./prepare-sparkle.mjs')
  await prepareSparkle(context.arch === 1 ? 'x64' : 'arm64')
}
