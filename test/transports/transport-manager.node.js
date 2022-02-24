'use strict'
/* eslint-env mocha */

const { expect } = require('aegir/utils/chai')
const { MemoryDatastore } = require('datastore-core/memory')
const AddressManager = require('../../src/address-manager')
const TransportManager = require('../../src/transport-manager')
const PeerStore = require('../../src/peer-store')
const PeerRecord = require('../../src/record/peer-record')
const Transport = require('libp2p-tcp')
const PeerId = require('peer-id')
const { Multiaddr } = require('multiaddr')
const mockUpgrader = require('../utils/mockUpgrader')
const sinon = require('sinon')
const Peers = require('../fixtures/peers')
const pWaitFor = require('p-wait-for')
const { mockConnectionGater } = require('../utils/mock-connection-gater')
const addrs = [
  new Multiaddr('/ip4/127.0.0.1/tcp/0'),
  new Multiaddr('/ip4/127.0.0.1/tcp/0')
]

describe('Transport Manager (TCP)', () => {
  const connectionGater = mockConnectionGater()
  let tm
  let localPeer

  before(async () => {
    localPeer = await PeerId.createFromJSON(Peers[0])
  })

  beforeEach(() => {
    tm = new TransportManager({
      libp2p: {
        peerId: localPeer,
        multiaddrs: addrs,
        addressManager: new AddressManager({ listen: addrs }),
        peerStore: new PeerStore({
          peerId: localPeer,
          datastore: new MemoryDatastore(),
          addressFilter: connectionGater.filterMultiaddrForPeer
        })
      },
      upgrader: mockUpgrader,
      onConnection: () => {}
    })
  })

  afterEach(async () => {
    await tm.removeAll()
    expect(tm._transports.size).to.equal(0)
  })

  it('should be able to add and remove a transport', async () => {
    tm.add(Transport.prototype[Symbol.toStringTag], Transport)
    expect(tm._transports.size).to.equal(1)
    await tm.remove(Transport.prototype[Symbol.toStringTag])
  })

  it('should be able to listen', async () => {
    tm.add(Transport.prototype[Symbol.toStringTag], Transport, { listenerOptions: { listen: 'carefully' } })
    const transport = tm._transports.get(Transport.prototype[Symbol.toStringTag])
    const spyListener = sinon.spy(transport, 'createListener')
    await tm.listen(addrs)
    expect(tm._listeners).to.have.key(Transport.prototype[Symbol.toStringTag])
    expect(tm._listeners.get(Transport.prototype[Symbol.toStringTag])).to.have.length(addrs.length)

    // Ephemeral ip addresses may result in multiple listeners
    expect(tm.getAddrs().length).to.equal(addrs.length)
    await tm.close()
    expect(tm._listeners.get(Transport.prototype[Symbol.toStringTag])).to.have.length(0)
    expect(spyListener.firstCall.firstArg).to.deep.equal({ listen: 'carefully' })
  })

  it('should create self signed peer record on listen', async () => {
    let signedPeerRecord = await tm.libp2p.peerStore.addressBook.getRawEnvelope(localPeer)
    expect(signedPeerRecord).to.not.exist()

    tm.add(Transport.prototype[Symbol.toStringTag], Transport)
    await tm.listen(addrs)

    // Should created Self Peer record on new listen address, but it is done async
    // with no event so we have to wait a bit
    await pWaitFor(async () => {
      signedPeerRecord = await tm.libp2p.peerStore.addressBook.getPeerRecord(localPeer)

      return signedPeerRecord != null
    }, { interval: 100, timeout: 2000 })

    const record = PeerRecord.createFromProtobuf(signedPeerRecord.payload)
    expect(record).to.exist()
    expect(record.multiaddrs.length).to.equal(addrs.length)
    addrs.forEach((a, i) => {
      expect(record.multiaddrs[i].equals(a)).to.be.true()
    })
  })

  it('should be able to dial', async () => {
    tm.add(Transport.prototype[Symbol.toStringTag], Transport)
    await tm.listen(addrs)
    const addr = tm.getAddrs().shift()
    const connection = await tm.dial(addr)
    expect(connection).to.exist()
    await connection.close()
  })
})
