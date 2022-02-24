'use strict'
/* eslint-env mocha */

const { expect } = require('aegir/utils/chai')
const sinon = require('sinon')

const baseOptions = require('../utils/base-options')
const peerUtils = require('../utils/creators/peer')
const all = require('it-all')

describe('libp2p.peerStore', () => {
  let libp2p, remoteLibp2p

  beforeEach(async () => {
    [libp2p, remoteLibp2p] = await peerUtils.createPeer({
      number: 2,
      populateAddressBooks: false,
      config: {
        ...baseOptions
      }
    })
  })

  afterEach(() => Promise.all([libp2p, remoteLibp2p].map(l => l.stop())))

  it('adds peer address to AddressBook and keys to the keybook when establishing connection', async () => {
    const remoteIdStr = remoteLibp2p.peerId.toB58String()

    const spyAddressBook = sinon.spy(libp2p.peerStore.addressBook, 'add')
    const spyKeyBook = sinon.spy(libp2p.peerStore.keyBook, 'set')

    const remoteMultiaddr = `${remoteLibp2p.multiaddrs[0]}/p2p/${remoteIdStr}`
    const conn = await libp2p.dial(remoteMultiaddr)

    expect(conn).to.exist()
    expect(spyAddressBook).to.have.property('called', true)
    expect(spyKeyBook).to.have.property('called', true)

    const localPeers = await all(libp2p.peerStore.getPeers())

    expect(localPeers.length).to.equal(1)

    const publicKeyInLocalPeer = localPeers[0].id.pubKey
    expect(publicKeyInLocalPeer.bytes).to.equalBytes(remoteLibp2p.peerId.pubKey.bytes)

    const publicKeyInRemotePeer = await remoteLibp2p.peerStore.keyBook.get(libp2p.peerId)
    expect(publicKeyInRemotePeer).to.exist()
    expect(publicKeyInRemotePeer.bytes).to.equalBytes(libp2p.peerId.pubKey.bytes)
  })
})
