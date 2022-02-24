'use strict'
/* eslint-env mocha */

const { expect } = require('aegir/utils/chai')
const sinon = require('sinon')
const Transport = require('libp2p-tcp')
const Muxer = require('libp2p-mplex')
const { NOISE: Crypto } = require('@chainsafe/libp2p-noise')
const { Multiaddr } = require('multiaddr')
const PeerId = require('peer-id')
const delay = require('delay')
const pDefer = require('p-defer')
const pSettle = require('p-settle')
const pWaitFor = require('p-wait-for')
const pipe = require('it-pipe')
const pushable = require('it-pushable')
const AggregateError = require('aggregate-error')
const { Connection } = require('libp2p-interfaces/src/connection')
const { AbortError } = require('libp2p-interfaces/src/transport/errors')
const { fromString: uint8ArrayFromString } = require('uint8arrays/from-string')
const { MemoryDatastore } = require('datastore-core/memory')
const Libp2p = require('../../src')
const Dialer = require('../../src/dialer')
const AddressManager = require('../../src/address-manager')
const PeerStore = require('../../src/peer-store')
const TransportManager = require('../../src/transport-manager')
const { codes: ErrorCodes } = require('../../src/errors')
const Protector = require('../../src/pnet')
const swarmKeyBuffer = uint8ArrayFromString(require('../fixtures/swarm.key'))
const { mockConnectionGater } = require('../utils/mock-connection-gater')
const mockUpgrader = require('../utils/mockUpgrader')
const createMockConnection = require('../utils/mockConnection')
const Peers = require('../fixtures/peers')
const { createPeerId } = require('../utils/creators/peer')

const listenAddr = new Multiaddr('/ip4/127.0.0.1/tcp/0')
const unsupportedAddr = new Multiaddr('/ip4/127.0.0.1/tcp/9999/ws/p2p/QmckxVrJw1Yo8LqvmDJNUmdAsKtSbiKWmrXJFyKmUraBoN')

describe('Dialing (direct, TCP)', () => {
  const connectionGater = mockConnectionGater()
  let remoteTM
  let localTM
  let peerStore
  let remoteAddr

  beforeEach(async () => {
    const [localPeerId, remotePeerId] = await Promise.all([
      PeerId.createFromJSON(Peers[0]),
      PeerId.createFromJSON(Peers[1])
    ])

    peerStore = new PeerStore({
      peerId: remotePeerId,
      datastore: new MemoryDatastore(),
      addressFilter: connectionGater.filterMultiaddrForPeer
    })
    remoteTM = new TransportManager({
      libp2p: {
        addressManager: new AddressManager(remotePeerId, { listen: [listenAddr] }),
        peerId: remotePeerId,
        peerStore
      },
      upgrader: mockUpgrader
    })
    remoteTM.add(Transport.prototype[Symbol.toStringTag], Transport)

    localTM = new TransportManager({
      libp2p: {
        peerId: localPeerId,
        peerStore: new PeerStore({
          peerId: localPeerId,
          datastore: new MemoryDatastore(),
          addressFilter: connectionGater.filterMultiaddrForPeer
        })
      },
      upgrader: mockUpgrader
    })
    localTM.add(Transport.prototype[Symbol.toStringTag], Transport)

    await remoteTM.listen([listenAddr])

    remoteAddr = remoteTM.getAddrs()[0].encapsulate(`/p2p/${remotePeerId.toB58String()}`)
  })

  afterEach(() => remoteTM.close())

  afterEach(() => {
    sinon.restore()
  })

  it('should be able to connect to a remote node via its multiaddr', async () => {
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore,
      connectionGater
    })

    const connection = await dialer.connectToPeer(remoteAddr)
    expect(connection).to.exist()
    await connection.close()
  })

  it('should be able to connect to a remote node via its stringified multiaddr', async () => {
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore,
      connectionGater
    })
    const connection = await dialer.connectToPeer(remoteAddr.toString())
    expect(connection).to.exist()
    await connection.close()
  })

  it('should fail to connect to an unsupported multiaddr', async () => {
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore,
      connectionGater
    })

    await expect(dialer.connectToPeer(unsupportedAddr))
      .to.eventually.be.rejectedWith(Error)
      .and.to.have.nested.property('.code', ErrorCodes.ERR_NO_VALID_ADDRESSES)
  })

  it('should fail to connect if peer has no known addresses', async () => {
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore,
      connectionGater
    })
    const peerId = await PeerId.createFromJSON(Peers[1])

    await expect(dialer.connectToPeer(peerId))
      .to.eventually.be.rejectedWith(Error)
      .and.to.have.nested.property('.code', ErrorCodes.ERR_NO_VALID_ADDRESSES)
  })

  it('should be able to connect to a given peer id', async () => {
    const peerId = await PeerId.createFromJSON(Peers[0])
    const peerStore = new PeerStore({
      peerId,
      datastore: new MemoryDatastore(),
      addressFilter: connectionGater.filterMultiaddrForPeer
    })
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore,
      connectionGater
    })

    await peerStore.addressBook.set(peerId, remoteTM.getAddrs())

    const connection = await dialer.connectToPeer(peerId)
    expect(connection).to.exist()
    await connection.close()
  })

  it('should fail to connect to a given peer with unsupported addresses', async () => {
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore: {
        addressBook: {
          add: () => {},
          getMultiaddrsForPeer: () => [unsupportedAddr]
        }
      },
      connectionGater
    })
    const peerId = await PeerId.createFromJSON(Peers[0])

    await expect(dialer.connectToPeer(peerId))
      .to.eventually.be.rejectedWith(Error)
      .and.to.have.nested.property('.code', ErrorCodes.ERR_NO_VALID_ADDRESSES)
  })

  it('should only try to connect to addresses supported by the transports configured', async () => {
    const remoteAddrs = remoteTM.getAddrs()
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore: {
        addressBook: {
          add: () => { },
          getMultiaddrsForPeer: () => [...remoteAddrs, unsupportedAddr]
        }
      },
      connectionGater
    })
    const peerId = await PeerId.createFromJSON(Peers[0])

    sinon.spy(localTM, 'dial')
    const connection = await dialer.connectToPeer(peerId)
    expect(localTM.dial.callCount).to.equal(remoteAddrs.length)
    expect(connection).to.exist()
    await connection.close()
  })

  it('should abort dials on queue task timeout', async () => {
    const dialer = new Dialer({
      transportManager: localTM,
      peerStore,
      dialTimeout: 50,
      connectionGater
    })
    sinon.stub(localTM, 'dial').callsFake(async (addr, options) => {
      expect(options.signal).to.exist()
      expect(options.signal.aborted).to.equal(false)
      expect(addr.toString()).to.eql(remoteAddr.toString())
      await delay(60)
      expect(options.signal.aborted).to.equal(true)
      throw new AbortError()
    })

    await expect(dialer.connectToPeer(remoteAddr))
      .to.eventually.be.rejectedWith(Error)
      .and.to.have.property('code', ErrorCodes.ERR_TIMEOUT)
  })

  it('should dial to the max concurrency', async () => {
    const addrs = [
      new Multiaddr('/ip4/0.0.0.0/tcp/8000'),
      new Multiaddr('/ip4/0.0.0.0/tcp/8001'),
      new Multiaddr('/ip4/0.0.0.0/tcp/8002')
    ]
    const dialer = new Dialer({
      transportManager: localTM,
      maxParallelDials: 2,
      peerStore: {
        addressBook: {
          add: () => {},
          getMultiaddrsForPeer: () => addrs
        }
      },
      connectionGater
    })

    expect(dialer.tokens).to.have.length(2)

    const deferredDial = pDefer()
    sinon.stub(localTM, 'dial').callsFake(() => deferredDial.promise)

    const [peerId] = await createPeerId()

    // Perform 3 multiaddr dials
    dialer.connectToPeer(peerId)

    // Let the call stack run
    await delay(0)

    // We should have 2 in progress, and 1 waiting
    expect(dialer.tokens).to.have.length(0)

    deferredDial.resolve(await createMockConnection())

    // Let the call stack run
    await delay(0)

    // Only two dials should be executed, as the first dial will succeed
    expect(localTM.dial.callCount).to.equal(2)
    expect(dialer.tokens).to.have.length(2)
  })

  describe('libp2p.dialer', () => {
    let peerId, remotePeerId
    let libp2p
    let remoteLibp2p
    let remoteAddr

    before(async () => {
      [peerId, remotePeerId] = await Promise.all([
        PeerId.createFromJSON(Peers[0]),
        PeerId.createFromJSON(Peers[1])
      ])

      remoteLibp2p = new Libp2p({
        peerId: remotePeerId,
        addresses: {
          listen: [listenAddr]
        },
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })
      await remoteLibp2p.handle('/echo/1.0.0', ({ stream }) => pipe(stream, stream))

      await remoteLibp2p.start()
      remoteAddr = remoteLibp2p.transportManager.getAddrs()[0].encapsulate(`/p2p/${remotePeerId.toB58String()}`)
    })

    afterEach(async () => {
      sinon.restore()
      libp2p && await libp2p.stop()
      libp2p = null
    })

    after(() => remoteLibp2p.stop())

    it('should fail if no peer id is provided', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      sinon.spy(libp2p.dialer, 'connectToPeer')

      try {
        await libp2p.dial(remoteLibp2p.transportManager.getAddrs()[0])
      } catch (/** @type {any} */ err) {
        expect(err).to.have.property('code', ErrorCodes.ERR_INVALID_MULTIADDR)
        return
      }

      expect.fail('dial should have failed')
    })

    it('should use the dialer for connecting to a multiaddr', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      sinon.spy(libp2p.dialer, 'connectToPeer')

      const connection = await libp2p.dial(remoteAddr)
      expect(connection).to.exist()
      const { stream, protocol } = await connection.newStream('/echo/1.0.0')
      expect(stream).to.exist()
      expect(protocol).to.equal('/echo/1.0.0')
      await connection.close()
      expect(libp2p.dialer.connectToPeer.callCount).to.be.greaterThan(0)
    })

    it('should use the dialer for connecting to a peer', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      sinon.spy(libp2p.dialer, 'connectToPeer')
      await libp2p.peerStore.addressBook.set(remotePeerId, remoteLibp2p.multiaddrs)

      const connection = await libp2p.dial(remotePeerId)
      expect(connection).to.exist()
      const { stream, protocol } = await connection.newStream('/echo/1.0.0')
      expect(stream).to.exist()
      expect(protocol).to.equal('/echo/1.0.0')
      await connection.close()
      expect(libp2p.dialer.connectToPeer.callCount).to.be.greaterThan(0)
    })

    it('should close all streams when the connection closes', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      // register some stream handlers to simulate several protocols
      await libp2p.handle('/stream-count/1', ({ stream }) => pipe(stream, stream))
      await libp2p.handle('/stream-count/2', ({ stream }) => pipe(stream, stream))
      await remoteLibp2p.handle('/stream-count/3', ({ stream }) => pipe(stream, stream))
      await remoteLibp2p.handle('/stream-count/4', ({ stream }) => pipe(stream, stream))

      await libp2p.peerStore.addressBook.set(remotePeerId, remoteLibp2p.multiaddrs)
      const connection = await libp2p.dial(remotePeerId)

      // Create local to remote streams
      const { stream } = await connection.newStream('/echo/1.0.0')
      await connection.newStream('/stream-count/3')
      await libp2p.dialProtocol(remoteLibp2p.peerId, '/stream-count/4')

      // Partially write to the echo stream
      const source = pushable()
      stream.sink(source)
      source.push('hello')

      // Create remote to local streams
      await remoteLibp2p.dialProtocol(libp2p.peerId, '/stream-count/1')
      await remoteLibp2p.dialProtocol(libp2p.peerId, '/stream-count/2')

      // Verify stream count
      const remoteConn = remoteLibp2p.connectionManager.get(libp2p.peerId)
      expect(connection.streams).to.have.length(5)
      expect(remoteConn.streams).to.have.length(5)

      // Close the connection and verify all streams have been closed
      await connection.close()
      await pWaitFor(() => connection.streams.length === 0)
      await pWaitFor(() => remoteConn.streams.length === 0)
    })

    it('should throw when using dialProtocol with no protocols', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      await expect(libp2p.dialProtocol(remotePeerId))
        .to.eventually.be.rejectedWith(Error)
        .and.to.have.property('code', ErrorCodes.ERR_INVALID_PROTOCOLS_FOR_STREAM)

      await expect(libp2p.dialProtocol(remotePeerId, []))
        .to.eventually.be.rejectedWith(Error)
        .and.to.have.property('code', ErrorCodes.ERR_INVALID_PROTOCOLS_FOR_STREAM)
    })

    it('should be able to use hangup to close connections', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      const connection = await libp2p.dial(remoteAddr)
      expect(connection).to.exist()
      expect(connection.stat.timeline.close).to.not.exist()
      await libp2p.hangUp(connection.remotePeer)
      expect(connection.stat.timeline.close).to.exist()
    })

    it('should be able to use hangup by address string to close connections', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      const connection = await libp2p.dial(`${remoteAddr.toString()}`)
      expect(connection).to.exist()
      expect(connection.stat.timeline.close).to.not.exist()
      await libp2p.hangUp(connection.remotePeer)
      expect(connection.stat.timeline.close).to.exist()
    })

    it('should use the protectors when provided for connecting', async () => {
      const protector = new Protector(swarmKeyBuffer)
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto],
          connProtector: protector
        }
      })

      sinon.spy(libp2p.upgrader.protector, 'protect')
      sinon.stub(remoteLibp2p.upgrader, 'protector').value(new Protector(swarmKeyBuffer))

      await libp2p.start()

      const connection = await libp2p.dialer.connectToPeer(remoteAddr)
      expect(connection).to.exist()
      const { stream, protocol } = await connection.newStream('/echo/1.0.0')
      expect(stream).to.exist()
      expect(protocol).to.equal('/echo/1.0.0')
      await connection.close()
      expect(libp2p.upgrader.protector.protect.callCount).to.equal(1)
    })

    it('should coalesce parallel dials to the same peer (id in multiaddr)', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      const dials = 10
      const fullAddress = remoteAddr.encapsulate(`/p2p/${remoteLibp2p.peerId.toB58String()}`)

      await libp2p.peerStore.addressBook.set(remotePeerId, remoteLibp2p.multiaddrs)
      const dialResults = await Promise.all([...new Array(dials)].map((_, index) => {
        if (index % 2 === 0) return libp2p.dial(remoteLibp2p.peerId)
        return libp2p.dial(fullAddress)
      }))

      // All should succeed and we should have ten results
      expect(dialResults).to.have.length(10)
      for (const connection of dialResults) {
        expect(Connection.isConnection(connection)).to.equal(true)
      }

      // 1 connection, because we know the peer in the multiaddr
      expect(libp2p.connectionManager.size).to.equal(1)
      expect(remoteLibp2p.connectionManager.size).to.equal(1)
    })

    it('should coalesce parallel dials to the same error on failure', async () => {
      libp2p = new Libp2p({
        peerId,
        modules: {
          transport: [Transport],
          streamMuxer: [Muxer],
          connEncryption: [Crypto]
        }
      })

      await libp2p.start()

      const dials = 10
      const error = new Error('Boom')
      sinon.stub(libp2p.transportManager, 'dial').callsFake(() => Promise.reject(error))

      await libp2p.peerStore.addressBook.set(remotePeerId, remoteLibp2p.multiaddrs)
      const dialResults = await pSettle([...new Array(dials)].map((_, index) => {
        if (index % 2 === 0) return libp2p.dial(remoteLibp2p.peerId)
        return libp2p.dial(remoteAddr)
      }))

      // All should succeed and we should have ten results
      expect(dialResults).to.have.length(10)
      for (const result of dialResults) {
        expect(result).to.have.property('isRejected', true)
        expect(result.reason).to.be.an.instanceof(AggregateError)
        // All errors should be the exact same as `error`
        for (const err of result.reason) {
          expect(err).to.equal(error)
        }
      }

      // 1 connection, because we know the peer in the multiaddr
      expect(libp2p.connectionManager.size).to.equal(0)
      expect(remoteLibp2p.connectionManager.size).to.equal(0)
    })
  })
})
