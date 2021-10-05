const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction } = require('../src/index')
const { Keypair } = require('../src/keypair')

const MERKLE_TREE_HEIGHT = 5

describe('TornadoPool', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, 1)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, 1)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPool = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
    )
    await tornadoPool.initialize()

    await token.approve(tornadoPool.address, utils.parseEther('10000'))
    return { tornadoPool, token, omniBridge, amb }
  }

  async function fixtureUpgradeable() {
    const { tornadoPool, omniBridge, amb } = await loadFixture(fixture)
    const [, gov] = await ethers.getSigners()
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPool.address,
      gov.address,
      [],
      amb.address,
      1,
    )

    /** @type {TornadoPool} */
    const TornadoPool = await ethers.getContractFactory('TornadoPool')
    const tornadoPoolProxied = TornadoPool.attach(proxy.address)
    await tornadoPoolProxied.initialize()

    return { tornadoPool: tornadoPoolProxied, proxy, gov, omniBridge, amb }
  }

  describe('Upgradeability tests', () => {
    it('admin should be gov', async () => {
      const { proxy, amb, gov } = await loadFixture(fixtureUpgradeable)
      const { data } = await proxy.populateTransaction.admin()
      const { result } = await amb.callStatic.execute(proxy.address, data)
      expect('0x' + result.slice(26)).to.be.equal(gov.address.toLowerCase())
    })

    it('non admin cannot call', async () => {
      const { proxy } = await loadFixture(fixtureUpgradeable)
      await expect(proxy.admin()).to.be.revertedWith(
        "Transaction reverted: function selector was not recognized and there's no fallback function",
      )
    })
  })

  it('encrypt -> decrypt should work', () => {
    const data = Buffer.from([0xff, 0xaa, 0x00, 0x01])
    const keypair = new Keypair()

    const ciphertext = keypair.encrypt(data)
    const result = keypair.decrypt(ciphertext)
    expect(result).to.be.deep.equal(data)
  })

  it('constants check', async () => {
    const { tornadoPool } = await loadFixture(fixture)
    const maxFee = await tornadoPool.MAX_FEE()
    const maxExtAmount = await tornadoPool.MAX_EXT_AMOUNT()
    const fieldSize = await tornadoPool.FIELD_SIZE()

    expect(maxExtAmount.add(maxFee)).to.be.lt(fieldSize)
  })

  it('should register and deposit', async function () {
    let { tornadoPool } = await loadFixture(fixture)
    const sender = (await ethers.getSigners())[0]

    // Alice deposits into tornado pool
    const aliceDepositAmount = 1e7
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount })

    tornadoPool = tornadoPool.connect(sender)
    await registerAndTransact({
      tornadoPool,
      outputs: [aliceDepositUtxo],
      account: {
        owner: sender.address,
        publicKey: aliceDepositUtxo.keypair.address(),
      },
    })

    const filter = tornadoPool.filters.NewCommitment()
    const fromBlock = await ethers.provider.getBlock()
    const events = await tornadoPool.queryFilter(filter, fromBlock.number)

    let aliceReceiveUtxo
    try {
      aliceReceiveUtxo = Utxo.decrypt(
        aliceDepositUtxo.keypair,
        events[0].args.encryptedOutput,
        events[0].args.index,
      )
    } catch (e) {
      // we try to decrypt another output here because it shuffles outputs before sending to blockchain
      aliceReceiveUtxo = Utxo.decrypt(
        aliceDepositUtxo.keypair,
        events[1].args.encryptedOutput,
        events[1].args.index,
      )
    }
    expect(aliceReceiveUtxo.amount).to.be.equal(aliceDepositAmount)

    const filterRegister = tornadoPool.filters.PublicKey(sender.address)
    const filterFromBlock = await ethers.provider.getBlock()
    const registerEvents = await tornadoPool.queryFilter(filterRegister, filterFromBlock.number)

    const [registerEvent] = registerEvents.sort((a, b) => a.blockNumber - b.blockNumber).slice(-1)

    expect(registerEvent.args.key).to.be.equal(aliceDepositUtxo.keypair.address())
  })

  it('should deposit, transact and withdraw', async function () {
    const { tornadoPool, token } = await loadFixture(fixture)

    // Alice deposits into tornado pool
    const aliceDepositAmount = 1e7
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount })
    await transaction({ tornadoPool, outputs: [aliceDepositUtxo] })

    // Bob gives Alice address to send some eth inside the shielded pool
    const bobKeypair = new Keypair() // contains private and public keys
    const bobAddress = bobKeypair.address() // contains only public key

    // Alice sends some funds to Bob
    const bobSendAmount = 3e6
    const bobSendUtxo = new Utxo({ amount: bobSendAmount, keypair: Keypair.fromString(bobAddress) })
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount - bobSendAmount,
      keypair: aliceDepositUtxo.keypair,
    })
    await transaction({ tornadoPool, inputs: [aliceDepositUtxo], outputs: [bobSendUtxo, aliceChangeUtxo] })

    // Bob parses chain to detect incoming funds
    const filter = tornadoPool.filters.NewCommitment()
    const fromBlock = await ethers.provider.getBlock()
    const events = await tornadoPool.queryFilter(filter, fromBlock.number)
    let bobReceiveUtxo
    try {
      bobReceiveUtxo = Utxo.decrypt(bobKeypair, events[0].args.encryptedOutput, events[0].args.index)
    } catch (e) {
      // we try to decrypt another output here because it shuffles outputs before sending to blockchain
      bobReceiveUtxo = Utxo.decrypt(bobKeypair, events[1].args.encryptedOutput, events[1].args.index)
    }
    expect(bobReceiveUtxo.amount).to.be.equal(bobSendAmount)

    // Bob withdraws a part of his funds from the shielded pool
    const bobWithdrawAmount = 2e6
    const bobEthAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const bobChangeUtxo = new Utxo({ amount: bobSendAmount - bobWithdrawAmount, keypair: bobKeypair })
    await transaction({
      tornadoPool,
      inputs: [bobReceiveUtxo],
      outputs: [bobChangeUtxo],
      recipient: bobEthAddress,
    })

    const bobBalance = await token.balanceOf(bobEthAddress)
    expect(bobBalance).to.be.equal(bobWithdrawAmount)
  })

  it('should deposit from L1 and withdraw to L1', async function () {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)
    // console.log('tornadoPool', tornadoPool.interface)

    // Alice deposits into tornado pool
    const aliceDepositAmount = 1e7
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [aliceDepositUtxo],
    })
    const transactTx = await tornadoPool.populateTransaction.registerAndTransact(
      {
        owner: '0x0000000000000000000000000000000000000000',
        publicKey: [],
      },
      args,
      extData,
    )
    const onTokenBridgedData = '0x' + transactTx.data.slice(10)
    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      aliceDepositUtxo.amount,
      onTokenBridgedData,
    )
    // emulating bridge. first it sends tokens and then calls onTokenBridged method
    await token.transfer(tornadoPool.address, aliceDepositAmount)
    await omniBridge.execute(tornadoPool.address, onTokenBridgedTx.data)

    // withdraws a part of his funds from the shielded pool
    const aliceKeypair = new Keypair() // contains private and public keys
    const aliceWithdrawAmount = 2e6
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount - aliceWithdrawAmount,
      keypair: aliceKeypair,
    })
    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: recipient,
      isL1Withdrawal: true,
    })

    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(0)
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(aliceWithdrawAmount)
  })

  it('should work with 16 inputs', async function () {
    const { tornadoPool } = await loadFixture(fixture)
    await transaction({ tornadoPool, inputs: [new Utxo(), new Utxo(), new Utxo()] })
  })
})
