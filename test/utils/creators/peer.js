'use strict'

const pTimes = require('p-times')

const { Multiaddr } = require('multiaddr')
const PeerId = require('peer-id')

const Libp2p = require('../../../src')
const Peers = require('../../fixtures/peers')
const defaultOptions = require('../base-options.browser')

const listenAddr = new Multiaddr('/ip4/127.0.0.1/tcp/0')

/**
 * Create libp2p nodes.
 *
 * @param {Object} [properties]
 * @param {Object} [properties.config]
 * @param {number} [properties.number] - number of peers (default: 1).
 * @param {boolean} [properties.fixture] - use fixture for peer-id generation (default: true)
 * @param {boolean} [properties.started] - nodes should start (default: true)
 * @param {boolean} [properties.populateAddressBooks] - nodes addressBooks should be populated with other peers (default: true)
 * @returns {Promise<Array<Libp2p>>}
 */
async function createPeer ({ number = 1, fixture = true, started = true, populateAddressBooks = true, config = {} } = {}) {
  const peerIds = await createPeerId({ number, fixture })

  const addresses = started ? { listen: [listenAddr] } : {}
  const peers = await pTimes(number, (i) => Libp2p.create({
    peerId: peerIds[i],
    addresses,
    ...defaultOptions,
    ...config
  }))

  if (started) {
    await Promise.all(peers.map((p) => p.start()))

    populateAddressBooks && await _populateAddressBooks(peers)
  }

  return peers
}

async function _populateAddressBooks (peers) {
  for (let i = 0; i < peers.length; i++) {
    for (let j = 0; j < peers.length; j++) {
      if (i !== j) {
        await peers[i].peerStore.addressBook.set(peers[j].peerId, peers[j].multiaddrs)
      }
    }
  }
}

/**
 * Create Peer-ids.
 *
 * @param {Object} [properties]
 * @param {number} [properties.number] - number of peers (default: 1).
 * @param {boolean} [properties.fixture] - use fixture for peer-id generation (default: true)
 * @param {PeerId.CreateOptions} [properties.opts]
 * @returns {Promise<Array<PeerId>>}
 */
function createPeerId ({ number = 1, fixture = true, opts = {} } = {}) {
  return pTimes(number, (i) => fixture
    ? PeerId.createFromJSON(Peers[i])
    : PeerId.create(opts)
  )
}

module.exports.createPeer = createPeer
module.exports.createPeerId = createPeerId
