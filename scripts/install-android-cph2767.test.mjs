import assert from 'node:assert/strict'
import { test } from 'node:test'
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
    assert.equal(args[0], '-t', 'All device commands must be targeted')
    const d = f.devices.find((d) => d.transport === args[1])
    assert.ok(d, 'Must use a current transport')
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
  assert.equal(f.builds, 1)
  assert.deepEqual(f.installs, [['-t', '2', 'install', '-r', '/build/app.apk']])
})

test('refuses no match, unauthorized, offline, approximate model and multiple physical phones', () => {
  for (const devices of [[], [phone('1', 'x', 'CPH2767IN')],
    [phone('1', 'x', 'CPH2767', 'unauthorized')], [phone('1', 'x', 'CPH2767', 'offline')],
    [phone('1'), phone('2', 'another')], [phone('1', '')], [phone('1', 'unknown')]]) {
    const f = fixture(devices)
    assert.throws(() => f.run())
    assert.equal(f.builds, 0)
    assert.deepEqual(f.installs, [])
  }
})

test('dry run only reads devices', () => {
  const f = fixture([phone('1')])
  f.run({ dryRun: true })
  assert.equal(f.builds, 0)
  assert.deepEqual(f.installs, [])
})

test('same phone can reconnect during build; install uses new transport', () => {
  const f = fixture([phone('1')])
  f.run({ build: () => { f.devices = [phone('4')] } })
  assert.equal(f.installs[0][1], '4')
})

test('never installs after build failure, disconnect, replacement or new ambiguity', () => {
  for (const after of [[], [phone('1', 'replacement')], [phone('1'), phone('2', 'another')]]) {
    const f = fixture([phone('1')])
    assert.throws(() => f.run({ build: () => { f.devices = after } }))
    assert.deepEqual(f.installs, [])
  }
  const f = fixture([phone('1')])
  assert.throws(() => f.run({ build: () => { throw new Error('Gradle failed') } }))
  assert.deepEqual(f.installs, [])
})

test('rechecks exact model immediately before install', () => {
  const f = fixture([phone('1')])
  const adb = (args) => {
    if (f.reads === 4) f.devices[0].model = 'Pixel_8'
    return f.adb(args)
  }
  assert.throws(() => f.run({ adb }), /identity changed/)
  assert.deepEqual(f.installs, [])
})
