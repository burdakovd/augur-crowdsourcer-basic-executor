// @flow

import type { Config } from "./config";
import type { State, Address } from "./state";
import { addMarket } from "./reducers";
import AugurCoreABI from "augur-core/output/contracts/abi.json";
import CrowdsourcerFactory from "augur-dispute-crowdsourcer/build/contracts/CrowdsourcerFactory.json";
import Accounting from "augur-dispute-crowdsourcer/build/contracts/Accounting.json";
import Crowdsourcer from "augur-dispute-crowdsourcer/build/contracts/Crowdsourcer.json";
import Disputer from "augur-dispute-crowdsourcer/build/contracts/Disputer.json";
import IERC20 from "augur-dispute-crowdsourcer/build/contracts/IERC20.json";
import { Set as ImmSet, List as ImmList, Map as ImmMap } from "immutable";
import sleep from "sleep-promise";
import Web3 from "web3";
import HDWalletProvider from "truffle-hdwallet-provider-privkey";
import NonceTrackerSubprovider from "web3-provider-engine/subproviders/nonce-tracker";
import nullthrows from "nullthrows";
import invariant from "invariant";
import moment from "moment";
import CryptoWatch from "cryptowatch-api";
import AugurAddresses from "augur.js/src/contracts/addresses.json";
import { stringifyCrowdsourcerSignature } from "./state";

async function getUniverseAddress(web3: Web3): Promise<Address> {
  const network = await web3.eth.net.getId();
  return nullthrows(AugurAddresses[`${network}`].Universe);
}

async function updateMarketFreshness(web3: Web3, state: State): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(web3);
  const universeAddress = await getUniverseAddress(web3);
  const disputeRoundDurationSeconds = await new web3.eth.Contract(
    AugurCoreABI.Universe,
    universeAddress
  ).methods
    .getDisputeRoundDurationInSeconds()
    .call()
    .then(Number.parseInt);

  await Promise.all(
    state.markets
      .map(async (data, address) => {
        if (data.isOver) {
          return;
        }

        if (data.lastObservedFeeWindow >= currentFeeWindowID) {
          return;
        }

        const feeWindowAddress = await new web3.eth.Contract(
          AugurCoreABI.Market,
          address
        ).methods
          .getFeeWindow()
          .call();

        invariant(
          !web3.utils.toBN(feeWindowAddress).eq(web3.utils.toBN(0)),
          "Should not have had this market"
        );

        const feeWindowEndTime = await new web3.eth.Contract(
          AugurCoreABI.FeeWindow,
          feeWindowAddress
        ).methods
          .getEndTime()
          .call()
          .then(Number.parseInt);

        const observedFeeWindow =
          Math.floor(feeWindowEndTime / disputeRoundDurationSeconds) - 1;

        state = {
          ...state,
          markets: state.markets.set(address, {
            ...data,
            // if fee window is over for more than 1 hour, mark market as over
            isOver: Date.now() / 1000 > feeWindowEndTime + 3600,
            lastObservedFeeWindow: observedFeeWindow
          })
        };
      })
      .valueSeq()
      .toArray()
  );

  return state;
}

async function getCurrentFeeWindowID(web3: Web3): Promise<number> {
  const universeAddress = await getUniverseAddress(web3);
  const disputeRoundDurationSeconds = await new web3.eth.Contract(
    AugurCoreABI.Universe,
    universeAddress
  ).methods
    .getDisputeRoundDurationInSeconds()
    .call()
    .then(Number.parseInt);

  const now = Date.now() / 1000;
  return Math.floor(now / disputeRoundDurationSeconds);
}

async function getCurrentWindowEndTimestamp(
  web3: Web3,
  config: Config
): Promise<number> {
  if (config.mockFeeWindowEnd != null) {
    return nullthrows(config.mockFeeWindowEnd);
  }

  const universeAddress = await getUniverseAddress(web3);
  const disputeRoundDurationSeconds = await new web3.eth.Contract(
    AugurCoreABI.Universe,
    universeAddress
  ).methods
    .getDisputeRoundDurationInSeconds()
    .call()
    .then(Number.parseInt);

  const now = Date.now() / 1000;
  return (
    (Math.floor(now / disputeRoundDurationSeconds) + 1) *
    disputeRoundDurationSeconds
  );
}

async function discoverCrowdsourcers(web3: Web3, state: State): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(web3);
  const network = await web3.eth.net.getId().then(n => n.toString());
  console.log(`We are in fee window ${currentFeeWindowID}`);

  const universeAddress = await getUniverseAddress(web3);
  const disputeRoundDurationSeconds = await new web3.eth.Contract(
    AugurCoreABI.Universe,
    universeAddress
  ).methods
    .getDisputeRoundDurationInSeconds()
    .call()
    .then(Number.parseInt);

  const potentialCrowdsourcers = await Promise.all(
    [currentFeeWindowID, currentFeeWindowID + 1].map(
      async targetFeeWindowID => {
        const existingCrowdsourcers = state.markets
          .valueSeq()
          .flatMap(({ crowdsourcers }) => crowdsourcers.valueSeq())
          .filter(({ feeWindowID }) => feeWindowID === targetFeeWindowID)
          .map(({ address }) => address)
          .toArray();

        var nextIndex: number = 0;
        var potentialCrowdsourcers: ImmSet<Address> = ImmSet();
        while (true) {
          const {
            "0": foundIndex,
            "1": candidate
          } = await new web3.eth.Contract(
            CrowdsourcerFactory.abi,
            CrowdsourcerFactory.networks[network].address
          ).methods
            .findCrowdsourcer(
              web3.utils.toHex(targetFeeWindowID),
              nextIndex,
              // TODO: this should come from config
              web3.utils.toHex(web3.utils.toWei("0.00001")),
              existingCrowdsourcers
            )
            .call();

          if (web3.utils.toBN(candidate).eq(web3.utils.toBN(0))) {
            break;
          }

          nextIndex = Number.parseInt(foundIndex) + 1;
          potentialCrowdsourcers = potentialCrowdsourcers.add(candidate);
        }

        return potentialCrowdsourcers;
      }
    )
  ).then(async sets => ImmList(sets).flatMap(x => x));
  if (potentialCrowdsourcers.size) {
    console.log(
      `Discovered ${potentialCrowdsourcers.size} potential new pools.`
    );
  }

  const fetchAndValidateMarketData = (() => {
    var cache: ImmMap<Address, Promise<void>> = ImmMap();

    const impl = async (market: Address) => {
      const isInOurUniverse = await new web3.eth.Contract(
        AugurCoreABI.Universe,
        universeAddress
      ).methods
        .isContainerForMarket(market)
        .call();

      if (!isInOurUniverse) {
        console.log(
          `Discarding market ${market} because it is not in our universe`
        );
        return;
      }

      const contract = new web3.eth.Contract(AugurCoreABI.Market, market);

      const numOutcomes = await contract.methods
        .getNumberOfOutcomes()
        .call()
        .then(Number.parseInt);
      const numTicks = await contract.methods
        .getNumTicks()
        .call()
        .then(Number.parseInt);

      if (numTicks !== 10000) {
        console.log(
          `Discarding market ${market} because it has not 10000 ticks`
        );
        return;
      }

      const feeWindowAddress = await contract.methods.getFeeWindow().call();

      if (web3.utils.toBN(feeWindowAddress).eq(web3.utils.toBN(0))) {
        console.log(`Discarding market ${market} because it has no fee window`);
        return;
      }

      const feeWindowID = await new web3.eth.Contract(
        AugurCoreABI.FeeWindow,
        feeWindowAddress
      ).methods
        .getStartTime()
        .call()
        .then(startTime =>
          Math.floor(Number.parseInt(startTime) / disputeRoundDurationSeconds)
        );

      invariant(
        !state.markets.has(market),
        "We shouldn't have had this kind of race"
      );

      console.log(`Adding market ${market}`);
      state = addMarket(state, market, {
        numOutcomes,
        feeWindow: feeWindowID
      });
    };

    return async (market: Address) => {
      if (state.markets.has(market)) {
        return;
      }

      if (!cache.has(market)) {
        cache = cache.set(market, impl(market));
      }

      await nullthrows(cache.get(market));
    };
  })();

  await Promise.all(
    potentialCrowdsourcers
      .map(async (address: Address) => {
        const crowdsourcer = new web3.eth.Contract(Crowdsourcer.abi, address);
        const {
          market,
          feeWindowId,
          payoutNumerators,
          invalid
        } = await crowdsourcer.methods.getDisputerParams().call();

        await fetchAndValidateMarketData(market);
        if (!state.markets.has(market)) {
          console.log(
            `Rejecting pool ${address} because corresponding market (${market}) got rejected.`
          );
          return;
        }

        const numTicks = 10000;

        const isWellFormedVector = (): boolean => {
          if (invalid) {
            return ImmList(payoutNumerators).every(n =>
              web3.utils
                .toBN(n)
                .eq(
                  web3.utils.toBN(
                    Math.floor(numTicks / payoutNumerators.length)
                  )
                )
            );
          } else {
            return (
              ImmList(payoutNumerators).count(
                n => !web3.utils.toBN(n).eq(web3.utils.toBN(0))
              ) === 1 &&
              ImmList(payoutNumerators).count(n =>
                web3.utils.toBN(n).eq(web3.utils.toBN(numTicks))
              ) === 1
            );
          }
        };

        if (!isWellFormedVector()) {
          console.log(
            `Rejecting pool ${address} because it has malformed payout vector ${JSON.stringify(
              {
                invalid,
                payoutNumerators
              }
            )}.`
          );
          return;
        }

        const key = stringifyCrowdsourcerSignature(
          Number.parseInt(feeWindowId),
          invalid,
          ImmList(payoutNumerators).map(n => Number.parseInt(n))
        );

        invariant(
          !nullthrows(state.markets.get(market)).crowdsourcers.has(key),
          "We shouldn't have had this kind of race"
        );

        const disputer = await crowdsourcer.methods.getDisputer().call();

        console.log(
          `Discovered new pool ${address} for market ${market}, '${
            invalid ? "invalid" : "valid"
          }', payout numerators ${JSON.stringify(
            payoutNumerators.map(n => Number.parseInt(n))
          )}, fee window ${feeWindowId}`
        );

        state = {
          ...state,
          markets: state.markets.update(market, marketData => ({
            ...nullthrows(marketData),
            crowdsourcers: marketData.crowdsourcers.set(key, {
              feeWindowID: Number.parseInt(feeWindowId),
              invalid,
              numerators: ImmList(payoutNumerators).map(n =>
                Number.parseInt(n)
              ),
              address,
              disputer,
              weDisputed: false,
              weCollectedFees: false
            })
          }))
        };
      })
      .toArray()
  );

  return state;
}

async function collectFees(
  web3: Web3,
  config: Config,
  state: State
): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(web3);

  await Promise.all(
    state.markets
      .map(async (marketData, marketAddress) => {
        const crowdsourcers = marketData.crowdsourcers;

        await Promise.all(
          crowdsourcers
            .map(async (crowdsourcerData, crowdsourcerKey) => {
              if (crowdsourcerData.feeWindowID > currentFeeWindowID) {
                return;
              }

              if (crowdsourcerData.weCollectedFees) {
                return;
              }

              const crowdsourcer = new web3.eth.Contract(
                Crowdsourcer.abi,
                crowdsourcerData.address
              );

              const disputer = new web3.eth.Contract(
                Disputer.abi,
                crowdsourcerData.disputer
              );

              const feesCollected = await crowdsourcer.methods
                .m_feesCollected()
                .call();

              if (feesCollected) {
                return;
              }

              const feeRecipient = await disputer.methods
                .m_feeReceiver()
                .call();

              if (
                feeRecipient.toLowerCase() !== config.feeRecipient.toLowerCase()
              ) {
                return;
              }

              console.log(
                `Sending transaction to collect fees from ${
                  crowdsourcerData.address
                } (market ${marketAddress})`
              );

              await crowdsourcer.methods.withdrawFees().send({
                from: config.feeCollectionTriggerAccount,
                gas: 3000000
              });

              state = {
                ...state,
                markets: state.markets.update(marketAddress, marketData => ({
                  ...nullthrows(marketData),
                  crowdsourcers: marketData.crowdsourcers.update(
                    crowdsourcerKey,
                    data => ({
                      ...data,
                      weCollectedFees: true
                    })
                  )
                }))
              };

              console.log(
                `Mined transaction to collect fees from ${
                  crowdsourcerData.address
                } (market ${marketAddress})`
              );

              // sleep some time to avoid race conditions that will cause to
              // send transaction twice on certain pools
              await sleep(60000);
            })
            .valueSeq()
            .toArray()
        );
      })
      .valueSeq()
      .toArray()
  );

  return state;
}

async function cleanupOldCrowdsourcers(
  web3: Web3,
  state: State
): Promise<State> {
  const currentFeeWindowID = await getCurrentFeeWindowID(web3);

  state.markets.forEach(async (marketData, marketAddress) => {
    marketData.crowdsourcers.forEach(
      async (crowdsourcerData, crowdsourcerKey) => {
        if (crowdsourcerData.feeWindowID >= currentFeeWindowID - 3) {
          return;
        }

        // if it is more than three windows old, clean it up
        console.log(
          `Cleaning up old crowdsourcer ${crowdsourcerKey} (${
            crowdsourcerData.address
          }) for market ${marketAddress}`
        );
        state = {
          ...state,
          markets: state.markets.update(marketAddress, marketData => ({
            ...marketData,
            crowdsourcers: marketData.crowdsourcers.delete(crowdsourcerKey)
          }))
        };
      }
    );
  });

  return state;
}

async function cleanupOldMarkets(state: State): Promise<State> {
  state.markets.forEach(async (marketData, marketAddress) => {
    if (!marketData.isOver) {
      return;
    }

    if (marketData.crowdsourcers.size > 0) {
      return;
    }

    console.log(`Cleaning up old market ${marketAddress}`);

    state = {
      ...state,
      markets: state.markets.delete(marketAddress)
    };
  });

  return state;
}

const cryptowatch = new CryptoWatch();

async function possiblyWait(target: number): Promise<void> {
  const nowF = () => Date.now() / 1000;

  while (nowF() < target) {
    const nowM = moment.unix(nowF()).utc();
    const targetM = moment.unix(target).utc();
    console.log(
      `T-${moment
        .duration(targetM.diff(nowM))
        .asSeconds()}: ${nowM.toString()} -> ${targetM.toString()}`
    );
    await sleep(Math.min(Math.max(500, (target - nowF()) * 200), 20000));
  }
}

async function runDisputes(
  web3: Web3,
  config: Config,
  state: State,
  persist: State => Promise<void>
): Promise<State> {
  const currentWindowEndTimestamp = await getCurrentWindowEndTimestamp(
    web3,
    config
  );
  const isNearWindowEnd = currentWindowEndTimestamp < Date.now() / 1000 + 900;

  if (isNearWindowEnd) {
    console.log(
      `Next dispute window is approaching. Monopolizing execution loop for disputes.`
    );
    await possiblyWait(currentWindowEndTimestamp - 300);
  }

  const targetFeeWindowID = await (isNearWindowEnd &&
  config.mockFeeWindowEnd == null
    ? getCurrentFeeWindowID(web3).then(id => id + 1)
    : getCurrentFeeWindowID(web3));

  const repInOneETH = await cryptowatch
    .price("kraken", "repeth")
    .then(({ price }) => 1 / price);

  console.log(
    `1 ETH = ${repInOneETH} REP (cryptowatch remaining allowance ${cryptowatch.allowance() /
      1e9} out of 8 CPU-seconds)`
  );

  const runners = await Promise.all(
    state.markets
      .map(
        (
          marketData,
          marketAddress
        ): Array<
          Promise<?{|
            run: () => Promise<void>,
            description: string,
            gasPrice: number
          |}>
        > =>
          marketData.crowdsourcers
            .map(async (crowdsourcerData, crowdsourcerKey) => {
              if (crowdsourcerData.feeWindowID !== targetFeeWindowID) {
                return null;
              }

              if (crowdsourcerData.weDisputed) {
                return null;
              }

              const crowdsourcer = new web3.eth.Contract(
                Crowdsourcer.abi,
                crowdsourcerData.address
              );

              const hasDisputed = await crowdsourcer.methods
                .hasDisputed()
                .call();

              if (hasDisputed) {
                return null;
              }

              const disputer = new web3.eth.Contract(
                Disputer.abi,
                crowdsourcerData.disputer
              );

              const disputingRound = await disputer.methods
                .m_roundNumber()
                .call()
                .then(Number.parseInt);

              const numParticipants = await new web3.eth.Contract(
                AugurCoreABI.Market,
                marketAddress
              ).methods
                .getNumParticipants()
                .call()
                .then(Number.parseInt);

              if (disputingRound !== numParticipants) {
                console.log(
                  `Not disputing market ${marketAddress} (${crowdsourcerKey}) because it has only ${numParticipants} rounds now, and we want round ${disputingRound}, likely this market already has winning outcome.`
                );
                return null;
              }

              const winningParticipant = await new web3.eth.Contract(
                AugurCoreABI.Market,
                marketAddress
              ).methods
                .getWinningReportingParticipant()
                .call()
                .then(
                  address =>
                    new web3.eth.Contract(
                      AugurCoreABI.DisputeCrowdsourcer,
                      address
                    )
                );

              const winningPayoutDistributionHash = await winningParticipant.methods
                .getPayoutDistributionHash()
                .call();

              const ourPayoutDistributionHash = await new web3.eth.Contract(
                AugurCoreABI.Market,
                marketAddress
              ).methods
                .derivePayoutDistributionHash(
                  crowdsourcerData.numerators
                    .map(n => web3.utils.toHex(n))
                    .toArray(),
                  crowdsourcerData.invalid
                )
                .call();

              if (ourPayoutDistributionHash === winningPayoutDistributionHash) {
                console.log(
                  `Not disputing market ${marketAddress} (${crowdsourcerKey}) because outcome ${ourPayoutDistributionHash} is already winning.`
                );
                return null;
              }

              const totalStake = await new web3.eth.Contract(
                AugurCoreABI.Market,
                marketAddress
              ).methods
                .getParticipantStake()
                .call();

              const stakeInOurOutcome = await new web3.eth.Contract(
                AugurCoreABI.Market,
                marketAddress
              ).methods
                .getStakeInOutcome(ourPayoutDistributionHash)
                .call();

              const possibleContributionSize = web3.utils
                .toBN(totalStake)
                .mul(web3.utils.toBN(2))
                .sub(
                  web3.utils.toBN(stakeInOurOutcome).mul(web3.utils.toBN(3))
                );

              const rep = await disputer.methods
                .getREP()
                .call()
                .then(address => new web3.eth.Contract(IERC20.abi, address));

              const possibleContributionFromOurPool = await rep.methods
                .balanceOf(crowdsourcerData.disputer)
                .call()
                .then(poolBalance => web3.utils.toBN(poolBalance))
                .then(
                  poolBalance =>
                    poolBalance.gt(possibleContributionSize)
                      ? possibleContributionSize
                      : poolBalance
                );

              const possibleFeesCollected = await crowdsourcer.methods
                .getAccounting()
                .call()
                .then(address => new web3.eth.Contract(Accounting.abi, address))
                .then(accounting =>
                  accounting.methods
                    .getProjectedFee(possibleContributionFromOurPool.toString())
                    .call()
                )
                .then(({ feeNumerator }) =>
                  web3.utils
                    .toBN(feeNumerator)
                    .mul(possibleContributionFromOurPool)
                    .divn(web3.utils.toBN(1000))
                );

              const expectedGasUsed = 1500000;

              var targetGasPrice = possibleFeesCollected
                .mul(
                  web3.utils.toBN(
                    Math.floor(config.aggressiveness * 1000000).toString()
                  )
                )
                .div(
                  web3.utils.toBN(Math.floor(repInOneETH * 1000000).toString())
                )
                .divn(web3.utils.toBN(expectedGasUsed));

              if (targetGasPrice.lt(web3.utils.toBN(config.minGasPrice))) {
                console.log(
                  `Not disputing market ${marketAddress} (${crowdsourcerKey}) because calculated gas price ${targetGasPrice.toString()} is less than minimum price ${
                    config.minGasPrice
                  }, likely this dispute is not worth participating (i.e. maximum fees we could get was only ${web3.utils.fromWei(
                    possibleFeesCollected.toString()
                  )} REP)`
                );
                return null;
              }

              if (
                targetGasPrice.gt(
                  web3.utils.toBN(config.maxGasPrice.toString())
                )
              ) {
                console.log(
                  `Market ${marketAddress} (${crowdsourcerKey}): reducing calculated gas price ${targetGasPrice.toString()} to maximum price ${
                    config.maxGasPrice
                  }`
                );
                targetGasPrice = web3.utils.toBN(config.maxGasPrice.toString());
              }

              console.log(
                `Will run dispute transaction for disputer ${
                  crowdsourcerData.disputer
                }, market ${marketAddress} (${crowdsourcerKey}), using gas price ${targetGasPrice} wei (expected dispute size ${web3.utils.fromWei(
                  possibleContributionFromOurPool.toString()
                )} REP, expected fees collected ${web3.utils.fromWei(
                  possibleFeesCollected.toString()
                )} REP, expected to pay in gas ${web3.utils.fromWei(
                  targetGasPrice
                    .mul(web3.utils.toBN(expectedGasUsed.toString()))
                    .toString()
                )} ETH.`
              );

              const runner = async () => {
                console.log(
                  `Sending dispute transaction for disputer ${
                    crowdsourcerData.disputer
                  }, market ${marketAddress} (${crowdsourcerKey})`
                );

                await disputer.methods.dispute(config.feeRecipient).send({
                  gas: expectedGasUsed * 2,
                  gasPrice: targetGasPrice,
                  from: config.executionAccount
                });

                state = {
                  ...state,
                  markets: state.markets.update(marketAddress, marketData => ({
                    ...nullthrows(marketData),
                    crowdsourcers: marketData.crowdsourcers.update(
                      crowdsourcerKey,
                      data => ({
                        ...data,
                        weDisputed: true
                      })
                    )
                  }))
                };

                console.log(
                  `Done dispute transaction for disputer ${
                    crowdsourcerData.disputer
                  }, market ${marketAddress} (${crowdsourcerKey})`
                );

                // sleep 60 seconds to avoid various race conditions
                await sleep(60000);
              };

              return {
                run: runner,
                description: `market ${marketAddress} (${crowdsourcerKey})`,
                gasPrice: targetGasPrice
              };
            })
            .valueSeq()
            .toArray()
      )
      .valueSeq()
      .flatMap(x => x)
      .toArray()
  )
    .then(a => a.filter(x => x != null).map(x => nullthrows(x)))
    .then(a => ImmList(a).sortBy(({ gasPrice }) => gasPrice));

  if (runners.size === 0) {
    return state;
  }

  console.log(
    `Have ${
      runners.size
    } dispute transactions to make (transactions with highest gas price first):`
  );
  runners.forEach(({ gasPrice, description }, i) =>
    console.log(`  ${i + 1}. [gasPrice=${gasPrice}] <${description}>`)
  );

  if (isNearWindowEnd) {
    console.log(`Waiting until next window starts.`);
    await possiblyWait(currentWindowEndTimestamp);
  }

  console.log(`=== Starting dispute execution now: ===`);

  await Promise.all(
    runners
      .map(async ({ gasPrice, description, run }, i) => {
        console.log(
          `  ${i +
            1}. [gasPrice=${gasPrice}] Starting dispute execution for <${description}>`
        );
        await run();
      })
      .toArray()
  );

  return state;
}

async function runIteration(
  web3: Web3,
  config: Config,
  state: State,
  persist: State => Promise<void>
): Promise<State> {
  const currentWindowEndTimestamp = await getCurrentWindowEndTimestamp(
    web3,
    config
  );

  console.log(
    `${moment
      .duration(
        moment
          .unix(currentWindowEndTimestamp)
          .utc()
          .diff(moment.unix(Date.now() / 1000).utc())
      )
      .toISOString()} until next window`
  );

  state = await discoverCrowdsourcers(web3, state);
  await persist(state);
  state = await updateMarketFreshness(web3, state);
  await persist(state);

  if (currentWindowEndTimestamp < Date.now() / 1000 + 86400) {
    console.log(
      `Skipping fee collection, since there is less than 24 hours remaining before window end, and fee collection may take long.`
    );
  } else {
    state = await collectFees(web3, config, state);
    await persist(state);
  }

  state = await cleanupOldCrowdsourcers(web3, state);
  await persist(state);
  state = await cleanupOldMarkets(state);
  await persist(state);
  state = await runDisputes(web3, config, state, persist);
  await persist(state);

  await sleep(300000);
  return state;
}

async function runIterationFactory(
  config: Config,
  persist: State => Promise<void>
): Promise<(state: State) => Promise<State>> {
  const makeWeb3 = accounts => {
    const wallet = new HDWalletProvider(
      ImmMap(accounts)
        .valueSeq()
        .toArray(),
      config.ethereumNode
    );
    const nonceTracker = new NonceTrackerSubprovider();
    wallet.engine._providers.unshift(nonceTracker);
    nonceTracker.setEngine(wallet.engine);

    const web3 = new Web3(wallet);

    ImmMap(accounts).forEach((key, account) =>
      invariant(
        web3.eth.accounts
          .privateKeyToAccount("0x" + key)
          .address.toLowerCase() === account.toLowerCase(),
        `Account ${account} does not match its private key (we get ${web3.eth.accounts.privateKeyToAccount(
          "0x" + config.executionPrivateKey
        )} instead)`
      )
    );

    console.log(`Using account ${config.executionAccount} for execution`);
    console.log(
      `Using account ${
        config.feeCollectionTriggerAccount
      } for fee collection triggering`
    );

    return web3;
  };

  const web3 = makeWeb3({
    [config.executionAccount]: config.executionPrivateKey,
    [config.feeCollectionTriggerAccount]: config.feeCollectionTriggerPrivateKey
  });

  return state => runIteration(web3, config, state, persist);
}

export default runIterationFactory;
