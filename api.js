/* global Set */
const fs = require('fs')
const ethers = require('ethers')
const process = require('process')
const fetch = require('node-fetch')
const querystring = require('querystring')

const Provider = ethers.getDefaultProvider('https://rpc-mumbai.maticvigil.com')
// const Provider = ethers.getDefaultProvider('https://rpc-mainnet.maticvigil.com')
// Not really needed it's just to query
const Signer = new ethers.Wallet(process.env.PRIVATE_WALLET_KEY, Provider)

const abis = {
  chainlink:  JSON.parse(fs.readFileSync('abis/ChainLinkOracle.json')),
  exchange:   JSON.parse(fs.readFileSync('abis/exchange.json')),
  piToken:    JSON.parse(fs.readFileSync('abis/PiToken.json')),
  // piVault: JSON.parse(fs.readFileSync('abis/PiVault.json')),
  archimedes: JSON.parse(fs.readFileSync('abis/Archimedes.json')),
  erc20:      JSON.parse(fs.readFileSync('abis/ERC20.json'))
}


const addresses = {
  eth:        '0x3C68CE8504087f89c640D02d133646d98e64ddd9',
  exchange:   '0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506',
  piToken:    '0x43B711D46746C5Be8ACa96A7B00807fbD1b7dfE9',
  piVault:    '0x65140719EBc1F5D70C273811B4d752031c2b469D',
  archimedes: '0x5986FD34a3073bE5F6A74e850518EdC099AdC79c'
}

const oracles = {
  '0x0d787a4a1548f673ed375445535a6c7A1EE56180': '0x007A22900a3B98143368Bd5906f8E17e9867581b', // BTC => USD
  '0x001B3B4d0F3714Ca98ba10F6042DaEbF0B1B7b6F': '0x0FCAa9c899EC5A91eBc3D5Dd869De833b06fB046', // DAI => USD
  '0x9c3C9283D3e44854697Cd22D3Faa240Cfb032889': '0xd0D5e3DB44DE05E9F294BB0a3bEEaF030DE24Ada', // MATIC => USd
  '0x2058A9D7613eEE744279e3856Ef0eAda5FCbaA7e': '0x572dDec9087154dC5dfBB1546Bb62713147e0Ab0', // USDC => USD
  '0xBD21A10F619BE90d6066c941b04e340841F1F989': '0x92C09849638959196E976289418e5973CC96d645', // USDT => USD
  '0x3C68CE8504087f89c640D02d133646d98e64ddd9': '0x0715A7794a1dc8e42615F059dD6e406A6594651A'  // ETH => USD
}

const Swap = new ethers.Contract(addresses.exchange, abis.exchange, Signer)
const PiToken = new ethers.Contract(addresses.piToken, abis.piToken, Signer)
// const piVault = new ethers.Contract(addresses.piVault, abis.piVault , Signer)
const Archimedes = new ethers.Contract(addresses.archimedes, abis.archimedes, Signer)

// HELPER get token.decimals()
const decimalsForAddrToken = async (addr) => {
  const token = new ethers.Contract(addr, abis.erc20, Signer)

  return await token.decimals()
}

// HELPER get USD price from ChainLink Oracle
const priceForAddrToken = async (addr) => {
  const Chainlink = new ethers.Contract(oracles[addr], abis.chainlink, Signer)

  const [usd, decimals] = await Promise.all([
    Chainlink.latestAnswer(),
    Chainlink.decimals()
  ])

  return usd / (10 ** decimals)
}

// HELPER get USD price per 2piToken
const pricePer2Pi = async () => {
  let [ratioPerEth, price] = await Promise.all([
    Swap.getAmountsOut(1e18.toString(), [addresses.eth, addresses.piToken]),
    priceForAddrToken(addresses.eth)
  ])

  return price * (ratioPerEth[1] / 1e18) // 2Pi has 18 decimals
}

// TVL in USD for PiVault
const piVaultTVL = async () => {
  let [price, amount] = await Promise.all([
    pricePer2Pi(),
    PiToken.balanceOf(addresses.piVault)
  ])

  return price * (amount / 1e18) // 2Pi has 18 decimals
}

// TVL in USD for Archimedes Pool
const poolTVL = async (pid) => {
  let [poolInfo, amount] = await Promise.all([
    Archimedes.poolInfo(pid),
    Archimedes.balance(pid) // this balance is in want.decimals
  ])


  const [price, decimals] = await Promise.all([
    priceForAddrToken(poolInfo.want),
    decimalsForAddrToken(poolInfo.want)
  ])

  return price * (amount / (10 ** decimals))
}

// TVL in USD for entire 2Pi.Finance
const totalTVL = async () => {
  const poolLength = await Archimedes.poolLength()
  let promises = [piVaultTVL()]

  for (let pid = 0; pid < poolLength; pid++) {
    promises.push(poolTVL(pid))
  }

  return (await Promise.all(promises)).reduce((a, b) => a + b)
}

// MarketCap in USD for PiToken
const marketCap = async () => {
  let [price, totalSupply] = await Promise.all([
    pricePer2Pi(),
    PiToken.totalSupply()
  ])

  return price * (totalSupply / 1e18) // 2Pi has 18 decimals
}

// HELPER get the holder addresses for a given contract
// addr => [2Pi, stk2Pi]
const holdersFor = async (addr, page) => {
  const perPage = 200
  let currentPage = page || 0 // covalent starts from 0

  const params = querystring.stringify({
    'page-number': currentPage,
    'page-size':   perPage
  })

  const resp = await fetch(
    `https://api.covalenthq.com/v1/80001/tokens/${addr}/token_holders/?${params}`,
    {
      headers: {
        Authorization: `Basic ${process.env.COVALENT_BEARER}`,
        Accept:        'application/json'
      }
    }
  )

  const body = (await resp.json()).data
  let addrs = body.items.map((i) => i.address)

  // Only ask for more pages if it's the first and has more pages
  if (page == 0 && body.pagination?.has_more) {
    let pagesLeft = Math.floor(body.pagination.total_count / perPage)
    let promises = []

    for (currentPage; currentPage <= pagesLeft; currentPage++) {
      promises.push(holdersFor(addr, currentPage))
    }

    (await Promise.all(promises)).forEach((pageAddrs) => (addrs = [...addrs, ...pageAddrs]))
  }

  return addrs
}

// Get the total uniq holders for 2Pi & stk2Pi tokens
const holdersCount = async () => {
  let [tokenH, stakeH] = await Promise.all([
    holdersFor(addresses.piToken, 0),
    holdersFor(addresses.piVault, 0)
  ])

  // uniq array
  return (new Set([...tokenH, ...stakeH])).size || 0
}

// HELPER Get transactions count for a given event method
// method => [Deposit, Withdraw, EmergencyWithdraw]
const transactionsCountFor = async (method, page) => {
  // Esto habria que traerlo de firebase
  const perPage = 200
  let currentPage = page || 0 // covalent starts from 0

  const params = querystring.stringify({
    'page-number':    currentPage,
    'page-size':      perPage,
    'starting-block': 16527242,  // 17472892,
    'ending-block':   16529548,  // 'latest',
    'match':          `{"decoded.name": "${method}"}`
  })
  const resp = await fetch(
    `https://api.covalenthq.com/v1/80001/events/address/${addresses.archimedes}/?${params}`,
    {
      headers: {
        Authorization: `Basic ${process.env.COVALENT_BEARER}`,
        Accept:        'application/json'
      }
    }
  )

  let count = (await resp.json()).data.items.length

  if (count > 0) {
    // aca no podemos hacer la manganeta de las promesas
    // porque NO esta viniendo la cant ni el has_more
    count += await transactionsCountFor(method, ++currentPage)
  }

  return count
}

// Get total transactions count for wanted user interactions
// with Archimedes
const totalTransactionsCount = async () => {
  return (await Promise.all([
    transactionsCountFor('Deposit', 0),
    transactionsCountFor('Withdraw', 0),
    transactionsCountFor('EmergencyWithdraw', 0)
  ])).reduce((a, b) => a + b)
}

module.exports = async () => {
  const [tvl, cap, holders, txs] = await Promise.all([
    totalTVL(),
    marketCap(),
    holdersCount(),
    totalTransactionsCount()
  ])
  // These are the Weight for each measure
  const TVL     = { w: 0.4, e: 10e6 }
  const CAP     = { w: 0.4, e: 15e6 }
  const HOLDERS = { w: 0.1, e: 2e4 }
  const TXS     = { w: 0.1, e: 5e4 }

  let tvlRate     = (tvl     * TVL.w     / TVL.e)
  let capRate     = (cap     * CAP.w     / CAP.e)
  let holdersRate = (holders * HOLDERS.w / HOLDERS.e)
  let txsRate     = (txs     * TXS.w     / TXS.e)

  if (tvlRate > TVL.w)
    tvlRate = TVL.w

  if (capRate > CAP.w)
    capRate = CAP.w

  if (holdersRate > HOLDERS.w)
    holdersRate = HOLDERS.w

  if (txsRate > TXS.w)
    txsRate = TXS.w

  // console.log(`TVL ${tvlRate} `)
  // console.log(`CAP ${capRate} `)
  // console.log(`Holders ${holdersRate} `)
  // console.log(`TXs ${txsRate} `)

  return parseFloat((tvlRate + capRate + holdersRate + txsRate).toFixed(5))
}
