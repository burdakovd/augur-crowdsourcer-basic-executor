// @flow

import type { Config } from "./config";
import type { State, Address } from "./state";
import { addMarket } from "./reducers";
import AugurCoreABI from "augur-core/output/contracts/abi.json";
import CrowdsourcerFactory from "augur-dispute-crowdsourcer/build/contracts/CrowdsourcerFactory.json";
import Crowdsourcer from "augur-dispute-crowdsourcer/build/contracts/Crowdsourcer.json";
import Disputer from "augur-dispute-crowdsourcer/build/contracts/Disputer.json";
import { Set as ImmSet, List as ImmList, Map as ImmMap } from "immutable";
import sleep from "sleep-promise";
import Web3 from "web3";
import HDWalletProvider from "truffle-hdwallet-provider-privkey";
import NonceTrackerSubprovider from "web3-provider-engine/subproviders/nonce-tracker";
import nullthrows from "nullthrows";
import invariant from "invariant";
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
              // only consider pools with at least 0.01 REP in fees
              web3.utils.toHex(web3.utils.toWei("0.01")),
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
              disputer
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

async function runDisputes(
  web3: Web3,
  config: Config,
  state: State,
  persist: State => Promise<void>
): Promise<State> {
  const currentFeeWindowID_DO_NOT_USE = await getCurrentFeeWindowID(web3);
  const targetFeeWindowID = currentFeeWindowID_DO_NOT_USE;

  // TODO: if we are about to start next window, do countdown

  const runners = await Promise.all(
    state.markets
      .map(
        async (marketData, marketAddress): Promise<?() => Promise<void>> => {
          await Promise.all(
            marketData.crowdsourcers
              .map(async (crowdsourcerData, crowdsourcerKey) => {
                if (crowdsourcerData.feeWindowID !== targetFeeWindowID) {
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

                // CHECK:
                // 1. numParticipants
                // 2. Tentative outcome
                // 3. Expected dispute size, and expected fee => gas

                const disputer = new web3.eth.Contract(
                  Disputer.abi,
                  crowdsourcerData.disputer
                );

                const standardGasPrice = await web3.eth.getGasPrice();
                const premiumGasPrice = web3.utils
                  .toBN(standardGasPrice)
                  .mul(web3.utils.toBN(4))
                  .toString();
                console.log(
                  `Running dispute transaction for disputer ${
                    crowdsourcerData.disputer
                  }, market ${marketAddress}, using increased gas price ${premiumGasPrice /
                    1e9} gwei`
                );

                // todo: protect against bad pools, filter input data,
                // and do not dispute more than once

                return async () => {
                  await disputer.methods.dispute(config.feeRecipient).send({
                    gas: 3000000,
                    gasPrice: premiumGasPrice,
                    from: config.executionAccount
                  });

                  console.log(
                    `Done dispute transaction for disputer ${
                      crowdsourcerData.disputer
                    }, market ${marketAddress}`
                  );

                  // sleep 60 seconds to avoid various race conditions
                  await sleep(60000);
                };
              })
              .valueSeq()
              .toArray()
          );
        }
      )
      .valueSeq()
      .toArray()
  );

  await Promise.all(
    runners.map(async r => {
      if (r != null) {
        await r();
      }
    })
  );

  return state;
}

async function runIteration(
  web3: Web3,
  config: Config,
  state: State,
  persist: State => Promise<void>
): Promise<State> {
  // TODO: if we are about to start next window, go straight to runDisputes

  state = await discoverCrowdsourcers(web3, state);
  await persist(state);
  state = await updateMarketFreshness(web3, state);
  await persist(state);
  // TODO: do not start collectFees if we have less than 48 hours before next window
  state = await collectFees(web3, config, state);
  await persist(state);
  state = await cleanupOldCrowdsourcers(web3, state);
  await persist(state);
  state = await cleanupOldMarkets(state);
  await persist(state);
  state = await runDisputes(web3, config, state, persist);
  await persist(state);

  await sleep(10000);
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
