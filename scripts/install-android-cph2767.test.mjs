import { expect, test } from 'vitest'
import { installPhone } from './install-android-cph2767.mjs'

const phone = (transport, serial = 'oneplus', model = 'CPH2767', state = 'device') => ({ transport, serial, model, state })
function fixture(devices) {
  const f = { devices, installs: [], builds: 0, reads: 0 }
  f.adb = (args) => {
    if (args[0] === 'devices') {
      return 'List of devices attached\n' + f.devices.map((d) =>
        `adb-name (${d.transport})._adb-tls-connect._tcp ${d.state} product:x model:${d.model} transport_id:${d.transport}`
      ).join('\n')
    }
    expect(args[0], 'All device commands must be targeted').toBe('-t')
    const d = f.devices.find((d) => d.transport === args[1])
    expect(d, 'Must use a current transport').toBeTruthy()
    if (args[2] === 'install') { f.installs.push(args); return 'Success' }
    f.reads++
    return args[4] === 'ro.product.model' ? d.model : d.serial
  }
  f.run = (options = {}) => installPhone({ adb: f.adb, apk: '/build/app.apk',
    build: () => { f.builds++ }, log: () => {}, ...options })
  return f
}

test('targets only CPH2767 despite other devices and duplicate wireless transports', () => {
  const f = fixture([phone('1', 'pixel', 'Pixel_8'), phone('2'), phone('3')])
  f.run()
  expect(f.builds).toBe(1)
  expect(f.installs).toEqual([['-t', '2', 'install', '-r', '/build/app.apk']])
})

test('refuses no match, unauthorized, offline, approximate model and multiple physical phones', () => {
  for (const devices of [[], [phone('1', 'x', 'CPH2767IN')],
    [phone('1', 'x', 'CPH2767', 'unauthorized')], [phone('1', 'x', 'CPH2767', 'offline')],
    [phone('1'), phone('2', 'another')], [phone('1', '')], [phone('1', 'unknown')]]) {
    const f = fixture(devices)
    expect(() => f.run()).toThrow()
    expect(f.builds).toBe(0)
    expect(f.installs).toEqual([])
  }
})

test('dry run only reads devices', () => {
  const f = fixture([phone('1')])
  f.run({ dryRun: true })
  expect(f.builds).toBe(0)
  expect(f.installs).toEqual([])
})

test('same phone can reconnect during build; install uses new transport', () => {
  const f = fixture([phone('1')])
  f.run({ build: () => { f.devices = [phone('4')] } })
  expect(f.installs[0][1]).toBe('4')
})

test('never installs after build failure, disconnect, replacement or new ambiguity', () => {
  for (const after of [[], [phone('1', 'replacement')], [phone('1'), phone('2', 'another')]]) {
    const f = fixture([phone('1')])
    expect(() => f.run({ build: () => { f.devices = after } })).toThrow()
    expect(f.installs).toEqual([])
  }
  const f = fixture([phone('1')])
  expect(() => f.run({ build: () => { throw new Error('Gradle failed') } })).toThrow()
  expect(f.installs).toEqual([])
})

test('rechecks exact model immediately before install', () => {
  const f = fixture([phone('1')])
  const adb = (args) => {
    if (f.reads === 4) f.devices[0].model = 'Pixel_8'
    return f.adb(args)
  }
  expect(() => f.run({ adb })).toThrow(/identity changed/)
  expect(f.installs).toEqual([])
})
