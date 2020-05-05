const contractConfig = require('../contract-config.js')

const encodeCall = require('../utils/encodeCall')

const Registry = artifacts.require('Registry')
const AudiusToken = artifacts.require('AudiusToken')
const Staking = artifacts.require('Staking')
const AdminUpgradeabilityProxy = artifacts.require('AdminUpgradeabilityProxy')

const claimsManagerProxyKey = web3.utils.utf8ToHex('ClaimsManagerProxy')
const serviceProviderFactoryKey = web3.utils.utf8ToHex('ServiceProviderFactory')
const delegateManagerKey = web3.utils.utf8ToHex('DelegateManager')
const stakingProxyKey = web3.utils.utf8ToHex('StakingProxy')

module.exports = (deployer, network, accounts) => {
  deployer.then(async () => {
    const config = contractConfig[network]
    const registry = await Registry.deployed()
    const token = await AudiusToken.deployed()

    const treasuryAddress = config.treasuryAddress || accounts[0]

    // TODO move to contractConfig
    const [proxyAdminAddress, proxyDeployerAddress] = [accounts[10], accounts[11]]

    const staking0 = await deployer.deploy(Staking, { from: proxyDeployerAddress })

    // Encode data for the call to initialize
    const initializeCallData = encodeCall(
      'initialize',
      [
        'address',
        'address',
        'address',
        'bytes32',
        'bytes32',
        'bytes32'
      ],
      [
        token.address,
        treasuryAddress,
        registry.address,
        claimsManagerProxyKey,
        delegateManagerKey,
        serviceProviderFactoryKey
      ])

    const stakingProxy = await deployer.deploy(
      AdminUpgradeabilityProxy,
      staking0.address,
      proxyAdminAddress,
      initializeCallData,
      { from: proxyDeployerAddress }
    )

    await registry.addContract(
      stakingProxyKey,
      stakingProxy.address,
      { from: treasuryAddress }
    )
  })
}